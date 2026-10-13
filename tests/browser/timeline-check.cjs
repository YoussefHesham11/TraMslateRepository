// Drives the real editor over HTTP with real mouse input and checks the
// timeline end to end: the audio and shot-change analysis, the subtitle boxes
// on the waveform, the centre playhead, drawing new subtitles, dragging and
// resizing them, snapping, the timing warnings, and the toolbar.
//
//     node tests/browser/timeline-check.cjs
//
// Served over HTTP (see serve.cjs) because fetch() cannot read the sample
// media over file://, so over file:// none of the analysis would run.
const fs = require('node:fs');
const path = require('node:path');
const { launch, CHROME, sleep } = require('./cdp.cjs');
const { serve } = require('./serve.cjs');

let failures = 0;
const ok = (label, detail = '') => console.log(`  ok    ${label}${detail ? '  ' + detail : ''}`);
const bad = (label, detail = '') => { failures++; console.error(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); };
const check = (cond, label, detail = '') => (cond ? ok : bad)(label, detail);

async function main() {
    if (!CHROME) { console.log('SKIP: no Chrome/Edge found'); return 0; }
    const harness = path.join(__dirname, 'editor-harness.html');
    if (!fs.existsSync(harness)) { console.error('harness missing — run build-harness.cjs'); return 1; }
    if (!/uploads\//.test(fs.readFileSync(harness, 'utf8'))) {
        console.log('SKIP: no sample media in wwwroot/uploads to analyse');
        return 0;
    }

    const server = await serve();
    const page = await launch({ width: 1600, height: 900 });
    const mouse = (type, x, y, extra = {}) => page.send('Input.dispatchMouseEvent', {
        type, x, y, button: 'left', clickCount: 1,
        buttons: type === 'mouseReleased' ? 0 : (type === 'mouseMoved' && !extra.held ? 0 : 1),
        ...extra,
    });
    async function drag(x0, y0, x1, y1, steps = 10) {
        await mouse('mouseMoved', x0, y0);
        await mouse('mousePressed', x0, y0);
        for (let i = 1; i <= steps; i++) {
            await mouse('mouseMoved', x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps, { held: true });
        }
        await mouse('mouseReleased', x1, y1);
        await sleep(60);
    }
    async function click(x, y) {
        await mouse('mouseMoved', x, y);
        await mouse('mousePressed', x, y);
        await mouse('mouseReleased', x, y);
        await sleep(60);
    }

    try {
        await page.goto(`${server.base}/tests/browser/editor-harness.html`);
        await page.waitFor('document.querySelector(".tm-cue-item") !== null', { timeout: 30000 });

        // ── Analysis ───────────────────────────────────────────────────
        await page.waitFor('peaksStatus === "ready" || peaksStatus === "failed"', { timeout: 600000 });
        const audio = await page.eval(`
            const v = document.getElementById('videoPlayer');
            return { status: peaksStatus, msg: peaksMessage, duration: peaks && peaks.duration,
                     video: v.duration, levels: peaks && peaks.levels.length, reference: peaks && peaks.reference,
                     regions: peaks && peaks.speech.length };`);
        if (audio.status !== 'ready') { bad('the media decodes into a waveform', audio.msg); return failures; }
        ok('the media decodes into a waveform', `${audio.duration.toFixed(1)}s, ${audio.levels} levels, ${audio.regions} dialogue regions`);
        check(Math.abs(audio.duration - audio.video) < 0.5, 'the analysed duration matches the video');
        check(audio.reference > 0 && audio.reference <= 1, 'a loudness reference is measured for scaling', audio.reference.toFixed(3));

        await page.waitFor('shotsStatus === "ready" || shotsStatus === "failed"', { timeout: 900000 });
        const shots = await page.eval('return { status: shotsStatus, msg: shotsMessage, cuts: shotCuts.slice() };');
        check(shots.status === 'ready', 'shot-change detection completes', shots.status === 'ready' ? `${shots.cuts.length} cuts` : shots.msg);
        check(shots.cuts.every((c, i, a) => i === 0 || c > a[i - 1]), 'detected cuts are in order');

        // Work at a fixed, known zoom from here on.
        const geo = await page.eval(`
            setZoom(160, 6);
            await new Promise(r => setTimeout(r, 100));
            const r = timelineScroll.getBoundingClientRect();
            return { left: r.left, top: r.top, width: r.width, height: r.height, pps: pxPerSecond };`);
        const laneY = geo.top + 24 + (geo.height - 24) * 0.6;
        const xAt = async t => page.eval(`return timelineScroll.getBoundingClientRect().left + xOfTime(${t});`);

        // ── The strip ──────────────────────────────────────────────────
        const paint = await page.eval(`
            const c = document.getElementById('waveformCanvas');
            const dpr = c.width / c.clientWidth;
            const ctx = c.getContext('2d');
            const img = ctx.getImageData(0, Math.round(30 * dpr), c.width, Math.round((c.clientHeight - 40) * dpr)).data;
            let lit = 0;
            for (let i = 0; i < img.length; i += 4) if (img[i + 2] > 120 && img[i + 2] > img[i]) lit++;
            const blocks = [...document.querySelectorAll('.tm-timeline-block')];
            const lane = timelineScroll.getBoundingClientRect();
            const onWave = blocks.filter(b => { const r = b.getBoundingClientRect(); return r.top < lane.top + 24 + 10 && r.bottom > lane.bottom - 10; });
            const withText = blocks.filter(b => (b.querySelector('.tm-block-text')?.textContent || '').trim());
            return { lit: lit / (img.length / 4), blocks: blocks.length, onWave: onWave.length, withText: withText.length, cues: events.length };`);
        check(paint.lit > 0.01, 'the waveform is painted across the lane', `${(paint.lit * 100).toFixed(1)}% of the lane`);
        check(paint.blocks > 0 && paint.onWave === paint.blocks, 'subtitle boxes sit on the waveform, spanning its height', `${paint.onWave}/${paint.blocks}`);
        check(paint.withText > 0, 'subtitle boxes show their text', `${paint.withText} with text`);
        check(paint.blocks < paint.cues, 'only the boxes near the view are rendered', `${paint.blocks} of ${paint.cues}`);

        // ── Centre playhead while playing ─────────────────────────────
        const play = await page.eval(`
            const v = document.getElementById('videoPlayer');
            v.muted = true;
            v.currentTime = 2;
            await new Promise(r => v.addEventListener('seeked', r, { once: true }));
            await v.play();
            await new Promise(r => setTimeout(r, 1200));
            const cur = document.getElementById('timelineCursor').getBoundingClientRect();
            const lane = timelineScroll.getBoundingClientRect();
            const out = { off: (cur.left + cur.width / 2) - (lane.left + lane.width / 2), drift: Math.abs(viewCentre - v.currentTime) * pxPerSecond, playing: !v.paused };
            v.pause();
            await new Promise(r => setTimeout(r, 200));
            return out;`);
        check(play.playing, 'the video plays in the harness');
        check(Math.abs(play.off) < 3 && play.drift < 3, 'while playing, the playhead stays fixed in the centre',
            `${play.off.toFixed(1)}px from centre`);

        // ── Seeking ────────────────────────────────────────────────────
        const clickT = 7.3;
        await click(await xAt(clickT), geo.top + 10);   // on the ruler
        const seek = await page.eval(`return { t: document.getElementById('videoPlayer').currentTime, centre: viewCentre };`);
        check(Math.abs(seek.t - clickT) < 0.05, 'clicking the ruler moves the playhead to that time', `wanted ${clickT}, got ${seek.t.toFixed(2)}`);

        const glide = await page.eval(`
            const before = viewCentre;
            document.getElementById('tlNextSub').click();
            await new Promise(r => setTimeout(r, 700));
            const v = document.getElementById('videoPlayer');
            return { before, after: viewCentre, t: v.currentTime };`);
        check(Math.abs(glide.after - glide.t) * geo.pps < 2, 'a seek from elsewhere glides the view to centre the playhead',
            `${((glide.after - glide.t) * geo.pps).toFixed(1)}px off`);

        // ── Drawing a new subtitle on empty waveform ──────────────────
        const gap = await page.eval(`
            setZoom(160, 9);
            await new Promise(r => setTimeout(r, 400));
            // Harness cues run 2.4s every 4.2s: find a gap in view.
            const i = events.findIndex(ev => tcToSecs(ev.endTime) > viewStartSecs() + 1);
            return { from: tcToSecs(events[i].endTime), to: tcToSecs(events[i + 1].startTime), count: events.length };`);
        const g0 = gap.from + 0.3, g1 = gap.to - 0.3;
        await drag(await xAt(g0), laneY, await xAt(g1), laneY);
        const drawn = await page.eval(`
            const ev = events.find(e => e.id === activeId);
            return { count: events.length, start: tcToSecs(ev.startTime), end: tcToSecs(ev.endTime),
                     sorted: events.every((e, i, a) => i === 0 || tcToSecs(e.startTime) >= tcToSecs(a[i - 1].startTime)),
                     focused: document.activeElement?.classList.contains('tm-translated-input') };`);
        check(drawn.count === gap.count + 1, 'dragging on empty waveform draws a new subtitle');
        check(Math.abs(drawn.start - g0) < 0.1 && Math.abs(drawn.end - g1) < 0.1, 'the new subtitle spans what was drawn',
            `${drawn.start.toFixed(2)}–${drawn.end.toFixed(2)} for ${g0.toFixed(2)}–${g1.toFixed(2)}`);
        check(drawn.sorted, 'the new subtitle is inserted in time order');
        check(drawn.focused, 'the new subtitle opens with the caret in its translation box');

        // Drawing past a neighbour stops at it.
        await page.eval(`deleteSelectedCue && deleteSelectedCue(); await new Promise(r => setTimeout(r, 100));`).catch(() => {});

        // ── Dragging and resizing a box ───────────────────────────────
        const target = await page.eval(`
            const i = events.findIndex(ev => tcToSecs(ev.startTime) > viewStartSecs() + 0.5);
            return { i, id: events[i].id, start: tcToSecs(events[i].startTime), end: tcToSecs(events[i].endTime),
                     next: tcToSecs(events[i + 1].startTime) };`);
        const yMid = laneY;
        // Click (no movement): selects and moves the playhead to its start.
        await click((await xAt(target.start)) + 40, yMid);
        const clicked = await page.eval(`return { active: activeId, t: document.getElementById('videoPlayer').currentTime,
            open: Number(document.querySelector('.tm-cue-item-open')?.dataset.id),
            openCount: document.querySelectorAll('.tm-cue-item-open').length };`);
        check(clicked.active === target.id && clicked.open === target.id, 'clicking a box selects it and opens it in the list');
        check(clicked.openCount === 1, 'and the previously open card closes', `${clicked.openCount} cards open`);
        check(Math.abs(clicked.t - target.start) < 0.05, 'clicking a box puts the playhead on its start');

        // Pull the out-edge right by half a second.
        const xr = (await xAt(target.end)) - 3;
        await drag(xr, yMid, xr + 0.5 * geo.pps, yMid);
        const resized = await page.eval(`const ev = events[${target.i}]; return { end: tcToSecs(ev.endTime), dirty: isDirty };`);
        check(resized.end > target.end + 0.3 && resized.end < target.end + 0.7, 'dragging the out-edge retimes the subtitle',
            `${target.end.toFixed(2)} → ${resized.end.toFixed(2)}`);

        // Pull it far past the next cue: it must stop there, not overlap.
        const xr2 = (await xAt(resized.end)) - 3;
        await drag(xr2, yMid, xr2 + 4 * geo.pps, yMid, 20);
        const clamped = await page.eval(`return tcToSecs(events[${target.i}].endTime);`);
        check(clamped <= target.next + 1e-3, 'an edge cannot be dragged over the next subtitle', `stopped at ${clamped.toFixed(2)}, next starts ${target.next.toFixed(2)}`);

        // Move the whole box left by a quarter second.
        const before = await page.eval(`const ev = events[${target.i}]; return { s: tcToSecs(ev.startTime), e: tcToSecs(ev.endTime) };`);
        const xm = ((await xAt(before.s)) + (await xAt(before.e))) / 2;
        await drag(xm, yMid, xm - 0.25 * geo.pps, yMid);
        const moved = await page.eval(`const ev = events[${target.i}]; return { s: tcToSecs(ev.startTime), e: tcToSecs(ev.endTime) };`);
        check(Math.abs((moved.e - moved.s) - (before.e - before.s)) < 0.002 && moved.s < before.s - 0.15,
            'dragging a box moves it and keeps its length', `${before.s.toFixed(2)} → ${moved.s.toFixed(2)}`);

        // ── Snapping ───────────────────────────────────────────────────
        const snap = await page.eval(`
            const saved = shotCuts;
            shotCuts = [100];
            const frame = 1 / fps;
            const inT = snapValue(100 + 3 / pxPerSecond, [], 'in');
            const inKind = snapGuide && snapGuide.kind;
            const outT = snapValue(100 - 2 * frame + 3 / pxPerSecond, [], 'out');
            const outKind = snapGuide && snapGuide.kind;
            const free = snapValue(103.33333, [], 'in');
            shotCuts = saved;
            return { inT, inKind, outT, outKind, free, frame };`);
        check(Math.abs(snap.inT - 100) < 1e-6 && snap.inKind === 'cut', 'in-edges snap onto a shot change');
        check(Math.abs(snap.outT - (100 - 2 * snap.frame)) < 1e-6 && snap.outKind === 'cut', 'out-edges snap two frames before a shot change');
        check(Math.abs(snap.free / snap.frame - Math.round(snap.free / snap.frame)) < 1e-6, 'with nothing nearby, edges land on a frame boundary');

        // ── Timing warnings ───────────────────────────────────────────
        const warn = await page.eval(`
            const saved = shotCuts;
            const i = events.findIndex(ev => tcToSecs(ev.startTime) > viewStartSecs() + 1);
            const a = events[i], b = events[i + 1];
            const oldEnd = a.endTime, oldStart = a.startTime;
            // A 40 ms gap, under every delivery profile's minimum.
            a.endTime = secsToSrtTc(tcToSecs(b.startTime) - 0.04);
            // An in-time three frames before a cut.
            shotCuts = [tcToSecs(a.startTime) + 3 / fps];
            invalidateIssues();
            renderTimelineBlocks();
            drawTimelineRuler();
            const c = document.getElementById('waveformCanvas');
            const dpr = c.width / c.clientWidth;
            const x = Math.round(xOfTime(tcToSecs(a.endTime) + 0.02) * dpr);
            const px = c.getContext('2d').getImageData(x, Math.round(c.clientHeight * 0.5 * dpr), 1, 1).data;
            const notes = shotNotes(a).map(n => n.text);
            const block = document.querySelector('.tm-timeline-block[data-id="' + a.id + '"]');
            const out = { red: px[0] > 180 && px[1] < 120, notes, warnClass: block?.classList.contains('tm-timeline-block-warn'),
                          title: block?.title || '' };
            a.endTime = oldEnd; a.startTime = oldStart; shotCuts = saved;
            invalidateIssues(); renderTimelineBlocks(); drawTimelineRuler();
            return out;`);
        check(warn.red, 'a gap shorter than the minimum is marked in red on the strip');
        check(warn.notes.some(n => /3 frames before a shot change/.test(n)), 'an in-time just off a shot change is called out', warn.notes.join('; '));
        check(warn.warnClass && /shot change/.test(warn.title), 'that subtitle box is flagged and its tooltip says why');

        // ── Wheel and overview ────────────────────────────────────────
        const wheel = await page.eval(`
            const p0 = pxPerSecond, c0 = viewCentre;
            const r = timelineScroll.getBoundingClientRect();
            const opts = { clientX: r.left + 300, clientY: r.top + 80, bubbles: true, cancelable: true };
            timelineScroll.dispatchEvent(new WheelEvent('wheel', { ...opts, deltaY: 200 }));
            const c1 = viewCentre;
            timelineScroll.dispatchEvent(new WheelEvent('wheel', { ...opts, deltaY: -300, ctrlKey: true }));
            return { p0, p1: pxPerSecond, c0, c1 };`);
        check(wheel.c1 > wheel.c0, 'the wheel scrolls the strip');
        check(wheel.p1 > wheel.p0, 'Ctrl + wheel zooms in');

        const ov = await page.eval(`
            const o = document.getElementById('timelineOverview').getBoundingClientRect();
            return { x: o.left + o.width * 0.8, y: o.top + o.height / 2 };`);
        await click(ov.x, ov.y);
        const travelled = await page.eval(`return viewCentre / timelineSpan();`);
        check(Math.abs(travelled - 0.8) < 0.02, 'clicking the overview bar travels there', `${(travelled * 100).toFixed(0)}% of the film`);

        // ── Toolbar ────────────────────────────────────────────────────
        const bar = await page.eval(`
            const byId = id => document.getElementById(id);
            const ids = ['tlTimecode','tlPrevSub','tlPlayPause','tlNextSub','tlPlaySelected','tlSetIn','tlSetOut','tlSplitHere',
                         'tlJoinNext','tlFitSpeech','tlSnap','tlZoom','tlZoomIn','tlZoomOut','tlAudioMenuBtn',
                         'tlRewind','tlFastForward','tlStop','tlPlayPreroll','tlLoop','tlSpeed','tlMute','tlVolume','tlPreroll',
                         'tlAutoPauseOut','tlScrubAudio','tlNudgeBack','tlNudgeFwd','tlShrink','tlGrow','tlPrevSpeech',
                         'tlNextSpeech','tlDuplicate','tlLock','tlZoomSel','tlZoomFit','tlNudgeStep','tlSnapCuts','tlSnapAudio',
                         'tlGain','tlWaveView','tlShowText','tlShowSpeech','tlReanalyse','tlRedetectShots'];
            const missing = ids.filter(id => !byId(id));
            const toolbar = document.querySelector('.tm-timeline-toolbar');
            const visible = [...toolbar.querySelectorAll('button, input, select')]
                .filter(el => !el.closest('.tm-tl-menu') && el.offsetParent !== null).length;

            byId('tlAudioMenuBtn').click();
            const m = byId('tlAudioMenu').getBoundingClientRect();
            const menuInView = !byId('tlAudioMenu').hidden && m.top >= 0 && m.left >= 0 && m.right <= innerWidth && m.bottom <= innerHeight;
            document.body.click();
            const menuClosed = byId('tlAudioMenu').hidden;

            const z0 = pxPerSecond;
            byId('tlZoom').value = 900;
            byId('tlZoom').dispatchEvent(new Event('input', { bubbles: true }));
            const zoomed = pxPerSecond > z0;

            byId('tlShowText').checked = false;
            byId('tlShowText').dispatchEvent(new Event('change', { bubbles: true }));
            const hidden = !document.querySelector('.tm-block-text');
            byId('tlShowText').checked = true;
            byId('tlShowText').dispatchEvent(new Event('change', { bubbles: true }));

            let drewAll = true;
            for (const view of ['peak', 'rms', 'bars', 'both']) {
                byId('tlWaveView').value = view;
                try { byId('tlWaveView').dispatchEvent(new Event('change', { bubbles: true })); } catch { drewAll = false; }
            }
            return { missing, visible, menuInView, menuClosed, zoomed, hidden, drewAll,
                     tc: byId('tlTimecode').textContent };`);
        check(bar.missing.length === 0, 'every timeline control is present', bar.missing.join(', '));
        check(bar.visible <= 16, 'the toolbar itself stays short; the rest lives in the menu', `${bar.visible} controls on the bar`);
        check(bar.menuInView && bar.menuClosed, 'the options menu opens on screen and closes again');
        check(bar.zoomed, 'the zoom slider zooms');
        check(bar.hidden, 'subtitle text in the boxes can be turned off');
        check(bar.drewAll, 'every waveform shape draws');
        check(/^\d\d:\d\d:\d\d:\d\d$/.test(bar.tc), 'the toolbar shows the playhead timecode', bar.tc);

        // ── Cache ──────────────────────────────────────────────────────
        // The edits above left the page dirty, and the editor rightly asks
        // before leaving unsaved work; that prompt would block the reload.
        await page.eval('isDirty = false;');
        await page.goto(`${server.base}/tests/browser/editor-harness.html`);
        await page.waitFor('typeof peaksStatus !== "undefined" && peaksStatus === "ready" && (shotsStatus === "ready" || shotsStatus === "failed")', { timeout: 120000 });
        const cached = await page.eval('return peaks.fromCache === true;');
        check(cached, 'a second visit reuses the cached analysis');

        const errors = await page.eval('return window.__errors || [];');
        check(errors.length === 0, 'no runtime errors', errors.join(' | '));
    } finally {
        await page.close();
        server.close();
    }
    return failures;
}

main().then(n => {
    console.log('');
    if (n) { console.error(`${n} timeline check(s) failed.`); process.exit(1); }
    console.log('The timeline behaves as expected.');
}).catch(err => { console.error(err); process.exit(1); });
