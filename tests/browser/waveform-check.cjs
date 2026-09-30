// Drives the real editor over HTTP and checks the timeline's audio side:
// that the media actually decodes, that the peak pyramid and the speech
// detection produce something usable, that the waveform reaches the canvas,
// and that the sound/timing controls do what their tooltips claim.
//
// It has to be served over HTTP rather than file://, because that is the only
// way fetch() can read the media — which is also why the plain layout check
// never exercised any of this.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { launch, CHROME } = require('./cdp.cjs');

const ROOT = path.join(__dirname, '..', '..');
const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.m4v': 'video/mp4',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

// Range support matters: <video> asks for byte ranges, and a server that
// ignores them makes the element look broken for reasons unrelated to the
// code under test.
function serve() {
    const server = http.createServer((req, res) => {
        const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
        const file = path.join(ROOT, rel);
        if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.writeHead(404).end('not found');
            return;
        }
        const size = fs.statSync(file).size;
        const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
        const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
        if (range) {
            const start = range[1] ? Number(range[1]) : 0;
            const end = range[2] ? Number(range[2]) : size - 1;
            res.writeHead(206, {
                'Content-Type': type,
                'Content-Length': end - start + 1,
                'Content-Range': `bytes ${start}-${end}/${size}`,
                'Accept-Ranges': 'bytes',
            });
            fs.createReadStream(file, { start, end }).pipe(res);
        } else {
            res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
            fs.createReadStream(file).pipe(res);
        }
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let failures = 0;
const ok = (label, detail = '') => console.log(`  ok    ${label}${detail ? '  ' + detail : ''}`);
const bad = (label, detail = '') => { failures++; console.error(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); };
const check = (cond, label, detail = '') => cond ? ok(label, detail) : bad(label, detail);

async function main() {
    if (!CHROME) { console.log('SKIP: no Chrome/Edge found'); return 0; }
    const harness = path.join(__dirname, 'editor-harness.html');
    if (!fs.existsSync(harness)) { console.error('harness missing — run build-harness.cjs'); return 1; }
    if (!/<video/.test(fs.readFileSync(harness, 'utf8')) || !/uploads\//.test(fs.readFileSync(harness, 'utf8'))) {
        console.log('SKIP: the harness has no sample media in wwwroot/uploads to analyse');
        return 0;
    }

    const server = await serve();
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await launch({ width: 1600, height: 900 });
    try {
        await page.goto(`${base}/tests/browser/editor-harness.html`);
        await page.waitFor('document.querySelector(".tm-cue-item") !== null', { timeout: 30000 });

        check(await page.eval('return typeof TmWaveform === "object";'), 'the waveform module is loaded');

        // Decoding a real file is slow; this is the one long wait here.
        let ready = false;
        try {
            await page.waitFor('peaksStatus === "ready" || peaksStatus === "failed"', { timeout: 180000 });
            ready = await page.eval('return peaksStatus === "ready";');
        } catch { /* reported below */ }
        if (!ready) {
            bad('the media decodes into a waveform', await page.eval('return peaksMessage || peaksStatus;'));
            console.error('\n  Nothing below can be checked without an analysed track.');
            return 1;
        }
        ok('the media decodes into a waveform');

        // ── The analysis itself ────────────────────────────────────────
        const info = await page.eval(`
            const l0 = peaks.levels[0];
            let loudest = 0;
            for (let i = 0; i < l0.max.length; i++) loudest = Math.max(loudest, l0.max[i] / 127);
            return {
                duration: peaks.duration,
                levels: peaks.levels.length,
                baseBps: l0.bps,
                buckets: l0.count,
                loudest,
                regions: peaks.speech.length,
                speechSecs: peaks.speech.reduce((n, r) => n + (r.end - r.start), 0),
                ordered: peaks.speech.every((r, i, a) => r.end > r.start && (i === 0 || r.start >= a[i - 1].end)),
                videoDuration: document.getElementById('videoPlayer').duration,
            };`);

        check(info.duration > 0.5, 'the analysis has a real duration', `${info.duration.toFixed(1)}s`);
        check(Math.abs(info.duration - info.videoDuration) < 0.5,
            'the analysed duration matches the video', `${info.duration.toFixed(2)} vs ${info.videoDuration.toFixed(2)}`);
        check(Math.abs(info.baseBps - TmWaveformBase()) < 1,
            'level 0 is at the intended resolution', `${info.baseBps.toFixed(1)} buckets/s`);
        check(info.levels >= 4, 'the pyramid has levels to zoom across', `${info.levels} levels`);
        check(info.loudest > 0.01, 'the decoded audio is not silent', `peak ${info.loudest.toFixed(3)}`);
        if (info.loudest > 0.02) {
            check(info.regions > 0, 'dialogue regions were detected', `${info.regions} regions, ${info.speechSecs.toFixed(1)}s`);
            check(info.ordered, 'detected regions are ordered and non-overlapping');
            check(info.speechSecs < info.duration, 'detection distinguishes speech from the whole track',
                `${Math.round(info.speechSecs / info.duration * 100)}% of the track`);
        }

        // Every zoom level has to resolve to a usable level of the pyramid —
        // this is what replaced rescanning raw PCM per pixel.
        // Sampled from the middle of a detected region: the head of a film is
        // usually silence, and measuring there would pass or fail on where
        // the titles end rather than on anything this code does.
        const zooms = await page.eval(`
            const r = peaks.speech[Math.floor(peaks.speech.length / 2)];
            const from = r ? (r.start + r.end) / 2 : 0;
            const out = [];
            for (const pps of [4, 25, 100, 400, 1000]) {
                const t0 = performance.now();
                const c = TmWaveform.columnsFor(peaks, Math.max(0, from - 700 / pps), pps, 1400);
                let peak = 0;
                for (let i = 0; i < c.max.length; i++) peak = Math.max(peak, c.max[i] - c.min[i]);
                out.push({ pps, ms: performance.now() - t0, peak, bps: c.bps });
            }
            return out;`);
        for (const z of zooms) {
            check(z.peak > 0.005 && z.ms < 40,
                `columns at ${z.pps}px/s are drawn from the pyramid`,
                `${z.ms.toFixed(1)}ms, level ${z.bps.toFixed(1)}b/s, peak ${z.peak.toFixed(3)}`);
        }

        // ── The canvas ─────────────────────────────────────────────────
        const paint = await page.eval(`
            // Park the view over real dialogue first, for the same reason.
            const r = peaks.speech[Math.floor(peaks.speech.length / 2)] || { start: 0 };
            setZoom(100, r.start + 3);
            drawTimelineRuler();
            const c = document.getElementById('waveformCanvas');
            const dpr = c.width / parseFloat(c.style.width);
            const H = parseFloat(c.style.height);
            const lanes = laneMetrics(H);
            const ctx = c.getContext('2d');
            const y0 = Math.round((lanes.top + 2) * dpr), y1 = Math.round((lanes.bottom - 2) * dpr);
            const img = ctx.getImageData(0, y0, c.width, y1 - y0).data;
            let lit = 0, total = 0;
            for (let i = 0; i < img.length; i += 4) {
                total++;
                // The lane background is near-black; anything brighter is drawn audio.
                if (img[i] + img[i + 1] + img[i + 2] > 150) lit++;
            }
            const blocks = [...document.querySelectorAll('.tm-timeline-block')].map(b => b.getBoundingClientRect());
            const wrap = document.getElementById('timelineScroll').getBoundingClientRect();
            return {
                lit: lit / total,
                laneTop: lanes.top, laneBottom: lanes.bottom, blocksH: lanes.blocks, H,
                blocksAboveLane: blocks.filter(b => b.top < wrap.top + lanes.bottom - 0.5).length,
                blockCount: blocks.length,
            };`);
        check(paint.lit > 0.02, 'the waveform is actually painted into the audio lane',
            `${(paint.lit * 100).toFixed(1)}% of lane pixels lit`);
        check(paint.blockCount > 0 && paint.blocksAboveLane === 0,
            'cue blocks stay in their own lane instead of covering the wave',
            `${paint.blockCount} blocks below ${paint.laneBottom.toFixed(0)}px`);
        check(paint.laneBottom - paint.laneTop > 30,
            'the audio lane has room to read', `${(paint.laneBottom - paint.laneTop).toFixed(0)}px of ${paint.H.toFixed(0)}px`);

        // ── Seeking: the bug where a scrolled strip seeked to the wrong time ──
        const seek = await page.eval(`
            setZoom(120, 0);
            const scroll = document.getElementById('timelineScroll');
            scroll.scrollLeft = 300;
            drawTimelineRuler();
            const rect = scroll.getBoundingClientRect();
            const clientX = rect.left + 200;
            const expected = (scroll.scrollLeft + 200) / pxPerSecond;
            scroll.dispatchEvent(new MouseEvent('mousedown', { clientX, clientY: rect.top + rect.height / 2, bubbles: true, button: 0 }));
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            return { expected, got: document.getElementById('videoPlayer').currentTime };`);
        check(Math.abs(seek.expected - seek.got) < 0.05,
            'clicking a scrolled timeline seeks to the time under the pointer',
            `wanted ${seek.expected.toFixed(2)}s, got ${seek.got.toFixed(2)}s`);

        // ── Controls ───────────────────────────────────────────────────
        const controls = await page.eval(`
            const byId = id => document.getElementById(id);
            const missing = ['tlPlayPreroll','tlLoop','tlMute','tlVolume','tlSpeed','tlGain','tlWaveView',
                             'tlShowSpeech','tlScrubAudio','tlSnapAudio','tlPreroll','tlReanalyse','tlSetIn',
                             'tlSetOut','tlSplitHere','tlJoinNext','tlFitSpeech','tlPrevSpeech','tlNextSpeech',
                             'tlZoomSel','tlAudioMenuBtn'].filter(id => !byId(id));

            const v = document.getElementById('videoPlayer');
            byId('tlVolume').value = 40;
            byId('tlVolume').dispatchEvent(new Event('input', { bubbles: true }));
            const volumeSet = Math.abs(v.volume - 0.4) < 0.01;
            byId('tlMute').click();
            const muted = v.muted;
            byId('tlMute').click();

            byId('tlSpeed').value = '0.5';
            byId('tlSpeed').dispatchEvent(new Event('change', { bubbles: true }));
            const speedSet = v.playbackRate === 0.5 && document.getElementById('playbackSpeed').value === '0.5';
            byId('tlSpeed').value = '1';
            byId('tlSpeed').dispatchEvent(new Event('change', { bubbles: true }));

            byId('tlAudioMenuBtn').click();
            const menuOpen = !byId('tlAudioMenu').hidden;
            document.body.click();
            const menuClosed = byId('tlAudioMenu').hidden;

            const beforeGain = waveGain;
            byId('tlGain').value = 300;
            byId('tlGain').dispatchEvent(new Event('input', { bubbles: true }));
            const gainSet = waveGain === 3 && beforeGain !== 3;
            byId('tlGain').value = 100;
            byId('tlGain').dispatchEvent(new Event('input', { bubbles: true }));

            // Every shape has to survive a draw; a throw here would leave the
            // lane blank with no other symptom.
            let drewAll = true;
            for (const view of ['both','peak','rms','bars']) {
                byId('tlWaveView').value = view;
                try { byId('tlWaveView').dispatchEvent(new Event('change', { bubbles: true })); }
                catch { drewAll = false; }
            }
            byId('tlWaveView').value = 'both';
            byId('tlWaveView').dispatchEvent(new Event('change', { bubbles: true }));

            return { missing, volumeSet, muted, speedSet, menuOpen, menuClosed, gainSet, drewAll };`);
        check(controls.missing.length === 0, 'every sound and timing control is present',
            controls.missing.length ? 'missing: ' + controls.missing.join(', ') : '');
        check(controls.volumeSet, 'the volume slider drives playback volume');
        check(controls.muted, 'mute toggles');
        check(controls.speedSet, 'the speed control agrees with the video toolbar');
        check(controls.menuOpen && controls.menuClosed, 'the options popover opens and closes');
        check(controls.gainSet, 'waveform amplitude is adjustable');
        check(controls.drewAll, 'every waveform shape redraws without throwing');

        // ── Timing actions that depend on the audio ────────────────────
        if (info.regions > 0) {
            const timing = await page.eval(`
                const v = document.getElementById('videoPlayer');
                const first = peaks.speech[0];

                // Fit-to-speech: park a cue roughly over a region and see it snap.
                selectEvent(events[0].id);
                events[0].startTime = secsToSrtTc(Math.max(0, first.start + 0.3));
                events[0].endTime = secsToSrtTc(first.end + 0.4);
                renderTimelineBlocks();
                document.getElementById('tlFitSpeech').click();
                const fitted = Math.abs(tcToSecs(events[0].startTime) - first.start) < 0.02
                            && Math.abs(tcToSecs(events[0].endTime) - first.end) < 0.02;

                v.currentTime = 0;
                document.getElementById('tlNextSpeech').click();
                const jumpedForward = v.currentTime > 0;
                const atEdge = v.currentTime;
                document.getElementById('tlPrevSpeech').click();
                const jumpedBack = v.currentTime < atEdge;

                // Snapping while dragging should prefer a dialogue edge.
                const snapped = snapValue(first.start + 0.02, []);
                const snapHitsAudio = Math.abs(snapped - first.start) < 0.005;

                // Set in/out from the playhead.
                selectEvent(events[1].id);
                v.currentTime = 12.5;
                document.getElementById('tlSetIn').click();
                const inSet = Math.abs(tcToSecs(events[1].startTime) - 12.5) < 0.05;

                // Split at the playhead, then put it back together.
                const before = events.length;
                selectEvent(events[2].id);
                v.currentTime = (tcToSecs(events[2].startTime) + tcToSecs(events[2].endTime)) / 2;
                document.getElementById('tlSplitHere').click();
                const split = events.length === before + 1;
                document.getElementById('tlJoinNext').click();
                const joined = events.length === before;

                // Zoom to the selection should frame the cue, not the film.
                const wide = pxPerSecond;
                setZoom(fitZoom());
                selectEvent(events[3].id);
                document.getElementById('tlZoomSel').click();
                const zoomed = pxPerSecond > fitZoom() * 1.5;
                setZoom(wide);

                return { fitted, jumpedForward, jumpedBack, snapHitsAudio, inSet, split, joined, zoomed };`);
            check(timing.fitted, 'fit-to-dialogue snaps a cue onto the detected speech');
            check(timing.jumpedForward && timing.jumpedBack, 'the playhead steps between dialogue edges');
            check(timing.snapHitsAudio, 'dragging snaps to where the dialogue starts');
            check(timing.inSet, 'set-in-point takes the playhead');
            check(timing.split && timing.joined, 'split at the playhead and join with the next cue');
            check(timing.zoomed, 'zoom-to-selection frames the cue');
        }

        // ── The cache: the whole point of the pyramid being small ───────
        await page.goto(`${base}/tests/browser/editor-harness.html`);
        await page.waitFor('typeof peaksStatus !== "undefined" && (peaksStatus === "ready" || peaksStatus === "failed")', { timeout: 180000 });
        const cached = await page.eval('return peaksStatus === "ready" && peaks.fromCache === true;');
        check(cached, 'a second visit reuses the cached peaks instead of decoding again');

        const errors = await page.eval('return window.__errors || [];');
        check(errors.length === 0, 'no runtime errors', errors.join(' | '));
    } finally {
        await page.close();
        server.close();
    }
    return failures;
}

// Kept in Node rather than read out of the page, so a change to the constant
// on either side shows up as a mismatch instead of passing silently.
function TmWaveformBase() { return 400; }

main().then(n => {
    console.log('');
    if (n) { console.error(`${n} waveform check(s) failed.`); process.exit(1); }
    console.log('The timeline waveform, its controls and its timing actions all behave.');
}).catch(err => { console.error(err); process.exit(1); });
