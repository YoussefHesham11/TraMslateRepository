// Editing and timing tools in the real editor: previews before every bulk
// change, single-step undo, two-point sync, frame-rate conversion, bulk
// actions with a recovery copy, find & replace that respects locked source,
// follow-playback off, permitted overlaps, spellcheck languages, and the new
// shortcuts pressed as real keys.
const path = require('node:path');
const fs = require('node:fs');
const { launch, CHROME, sleep } = require('./cdp.cjs');
const { serve } = require('./serve.cjs');

let failures = 0;
const ok = (label, detail = '') => console.log(`  ok    ${label}${detail ? '  ' + detail : ''}`);
const bad = (label, detail = '') => { failures++; console.error(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); };
const check = (cond, label, detail = '') => (cond ? ok : bad)(label, detail);

async function main() {
    if (!CHROME) { console.log('SKIP: no Chrome/Edge found'); return 0; }
    if (!fs.existsSync(path.join(__dirname, 'editor-harness.html'))) { console.error('harness missing — run build-harness.cjs'); return 1; }
    const server = await serve();
    const page = await launch({ width: 1600, height: 900 });
    const click = async label => page.eval(`[...document.querySelectorAll('.tm-modal-backdrop button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click(); return 1;`);
    const modalText = () => page.eval(`return document.querySelector('.tm-modal-backdrop')?.textContent.replace(/\\s+/g, ' ') || '';`);
    const times = () => page.eval(`return events.map(e => [e.startTime, e.endTime]);`);
    try {
        await page.goto(`${server.base}/tests/browser/editor-harness.html?cues=6`);
        await page.waitFor('typeof TmTools !== "undefined" && loaded && document.querySelector(".tm-cue-item")', { timeout: 30000 });
        await page.eval(`document.getElementById('workspaceTools').hidden = false; document.querySelectorAll('.tm-more-tools').forEach(d => d.open = true); return 1;`);
        const original = await times();

        // ── Shift: preview, cancel, apply, one undo ─────────────────────
        await page.eval(`document.getElementById('shiftTimecode').value = '1.5'; document.getElementById('shiftDirection').value = '1';
            document.getElementById('shiftAll').click(); return 1;`);
        await page.waitFor(`document.querySelector('.tm-modal-backdrop .tm-preview-table')`, { timeout: 5000 });
        let s = await modalText();
        check(/6 subtitles change timing/.test(s) && /00:00:02,000 → 00:00:04,400/.test(s) && /00:00:03,500 → 00:00:05,900/.test(s), 'shifting shows every change before and after first');
        await click('Cancel');
        check(JSON.stringify(await times()) === JSON.stringify(original), 'cancelling changes nothing');
        await page.eval(`document.getElementById('shiftAll').click(); return 1;`);
        await page.waitFor(`document.querySelector('.tm-modal-backdrop .tm-preview-table')`, { timeout: 5000 });
        await click('Apply');
        s = await page.eval(`return events[0].startTime;`);
        check(s === '00:00:03,500', 'Apply shifts them', s);
        await page.eval(`restoreHistory(-1); return 1;`);
        check(JSON.stringify(await times()) === JSON.stringify(original), 'and one undo puts every subtitle back');

        // ── Two-point sync ──────────────────────────────────────────────
        await page.eval(`document.getElementById('btnSyncTwo').click(); return 1;`);
        await page.waitFor(`document.querySelector('.tm-tool-form')`, { timeout: 5000 });
        // Subtitle 1 (2.0 s) should be at 3.0; subtitle 6 (23.0 s) at 25.0.
        await page.eval(`const f = document.querySelector('.tm-tool-form');
            f.querySelector('[name="a"]').value = 1; f.querySelector('[name="ta"]').value = '00:00:03,000';
            f.querySelector('[name="b"]').value = 6; f.querySelector('[name="tb"]').value = '00:00:25,000';
            f.requestSubmit(); return 1;`);
        await page.waitFor(`/Speed factor/.test(document.querySelector('.tm-modal-backdrop')?.textContent || '')`, { timeout: 5000 });
        s = await modalText();
        check(/Speed factor 1\.04762/.test(s), 'two-point sync previews the stretch and offset it will apply', s.match(/Speed factor[^.]+\.\d+[^)]*\)/)?.[0]);
        await click('Apply');
        s = await page.eval(`return [events[0].startTime, events[5].startTime, events[2].startTime];`);
        check(s[0] === '00:00:03,000' && s[1] === '00:00:25,000', 'both reference subtitles land exactly where asked', s.join(', '));
        check(s[2] === '00:00:11,800', 'and the ones between are stretched in proportion', s[2]);
        await page.eval(`restoreHistory(-1); return 1;`);

        // ── Frame-rate conversion ───────────────────────────────────────
        await page.eval(`document.getElementById('btnConvertFps').click(); return 1;`);
        await page.waitFor(`document.querySelector('.tm-tool-form')`, { timeout: 5000 });
        await page.eval(`const f = document.querySelector('.tm-tool-form'); f.querySelector('[name="from"]').value = '25'; f.querySelector('[name="to"]').value = '23.976'; f.requestSubmit(); return 1;`);
        await page.waitFor(`document.querySelector('.tm-modal-backdrop .tm-preview-table')`, { timeout: 5000 });
        await click('Apply');
        await page.waitFor(`/Also set the project/.test(document.querySelector('.tm-modal-backdrop')?.textContent || '')`, { timeout: 5000 });
        await click('Keep as it is');
        s = await page.eval(`return { t: events[5].startTime, fps };`);
        check(s.t === '00:00:23,982' && s.fps === 25, '25 → 23.976 fps scales every time by 25/23.976, and the fps setting is only changed if asked', `${s.t} at ${s.fps} fps`);
        await page.eval(`restoreHistory(-1); return 1;`);

        // ── Bulk actions ────────────────────────────────────────────────
        await page.eval(`selectedIds = new Set(events.slice(1, 4).map(e => e.id)); document.getElementById('btnBulk').click(); return 1;`);
        await page.waitFor(`document.querySelector('.tm-tool-form')`, { timeout: 5000 });
        await page.eval(`const f = document.querySelector('.tm-tool-form'); f.querySelector('[name="action"]').value = 'reviewed'; f.requestSubmit(); return 1;`);
        await page.waitFor(`document.querySelector('.tm-modal-backdrop .tm-preview-table')`, { timeout: 5000 });
        s = await modalText();
        check(/3 subtitles will change/.test(s), 'bulk actions preview the selected subtitles');
        await click('Apply');
        s = await page.eval(`return events.map(e => e.reviewState | 0).join('');`);
        check(s === '011100', 'and change exactly those', s);

        const snaps = await page.eval('return __server.snapshots.length;');
        await page.eval(`selectedIds = new Set(events.slice(0, 2).map(e => e.id)); document.getElementById('btnBulk').click(); return 1;`);
        await page.waitFor(`document.querySelector('.tm-tool-form')`, { timeout: 5000 });
        await page.eval(`const f = document.querySelector('.tm-tool-form'); f.querySelector('[name="action"]').value = 'delete'; f.requestSubmit(); return 1;`);
        await page.waitFor(`document.querySelector('.tm-modal-backdrop .tm-preview-table')`, { timeout: 5000 });
        await click('Apply');
        await sleep(300);
        s = await page.eval(`return { n: events.length, snap: __server.snapshots.at(-1), count: __server.snapshots.length };`);
        check(s.n === 4 && s.count === snaps + 1 && s.snap.kind === 3 && s.snap.events.length === 6, 'a bulk delete keeps a recovery copy first');
        await page.eval(`restoreHistory(-1); return 1;`);
        check(await page.eval('return events.length;') === 6, 'and undo brings the lines back');

        // ── Find & replace respects locked source ───────────────────────
        await page.eval(`document.getElementById('findText').value = 'Let'; document.getElementById('replaceText').value = 'Allow';
            document.getElementById('findScope').value = 'both'; document.getElementById('replaceAll').click(); return 1;`);
        await page.waitFor(`document.querySelector('.tm-modal-backdrop')`, { timeout: 5000 });
        s = await modalText();
        check(/only appears in \d+ locked line/.test(s), 'matches in imported (locked) source text are reported, not changed', s.slice(0, 100));
        await click('OK');
        await page.eval(`events[2].originalLocked = false; document.getElementById('replaceAll').click(); return 1;`);
        await page.waitFor(`document.querySelector('.tm-modal-backdrop mark')`, { timeout: 5000 });
        s = await modalText();
        check(/1 line change/.test(s) && /stay as they are/.test(s), 'the preview lists what changes and what stays');
        await page.eval(`[...document.querySelectorAll('.tm-modal-backdrop button')].find(b => b.textContent.startsWith('Replace in')).click(); return 1;`);
        s = await page.eval(`return events[2].originalText;`);
        check(s === 'Allow me see.', 'an unlocked source line is replaced', s);

        // ── Permitted overlaps can be dragged ───────────────────────────
        s = await page.eval(`const a = dragLimits([events[1].id], 6.2, 8.6); workspaceSettings = { ...workspaceSettings, rules: { allowOverlaps: true } };
            const b = dragLimits([events[1].id], 6.2, 8.6); workspaceSettings = { ...workspaceSettings, rules: {} }; return { a, b };`);
        // Infinity arrives as null through JSON.
        check(s.a.hi === 10.4 && s.b.hi === null, 'when the project allows overlaps, a box can be dragged over its neighbour',
            `limit ${s.a.hi} → ${s.b.hi ?? 'none'}`);

        // ── Spellcheck languages ────────────────────────────────────────
        s = await page.eval(`selectEvent(events[0].id); const c = document.querySelector('.tm-cue-item-open');
            return { t: c.querySelector('.tm-translated-input').getAttribute('lang'), sp: c.querySelector('.tm-translated-input').spellcheck, src: c.querySelector('.tm-original-input').getAttribute('lang') };`);
        check(s.t === 'ar' && s.sp && s.src === 'en', 'text boxes carry their language, so the browser spellchecks Arabic as Arabic', JSON.stringify(s));

        // ── Real keys: short jump, move down ────────────────────────────
        await page.eval(`document.activeElement?.blur(); const v = document.getElementById('videoPlayer'); v.currentTime = 8; return 1;`);
        await sleep(300);
        await page.key('j', { code: 'KeyJ', keyCode: 74, text: 'j' });
        await sleep(300);
        s = await page.eval(`return document.getElementById('videoPlayer').currentTime;`);
        check(Math.abs(s - 6) < 0.05, 'J jumps back by the short-jump amount (2 s)', s.toFixed(2));
        const order = await page.eval(`selectEvent(events[1].id); document.activeElement?.blur(); return events.map(e => e.id).join(',');`);
        await page.key('PageDown', { code: 'PageDown', keyCode: 34, modifiers: 1 | 8 });
        await sleep(200);
        s = await page.eval(`return events.map(e => e.id).join(',');`);
        check(s !== order && s.split(',')[2] === order.split(',')[1], 'Alt+Shift+PageDown moves the subtitle down the list', `${order} → ${s}`);
        await page.eval(`restoreHistory(-1); return 1;`);

        // ── Follow playback off ─────────────────────────────────────────
        s = await page.eval(`
            document.getElementById('tlFollow').checked = false; document.getElementById('tlFollow').dispatchEvent(new Event('change'));
            const v = document.getElementById('videoPlayer'); v.muted = true; v.currentTime = 3;
            await new Promise(r => v.addEventListener('seeked', r, { once: true }));
            await new Promise(r => setTimeout(r, 300));
            const c0 = viewCentre; await v.play(); await new Promise(r => setTimeout(r, 1000)); v.pause();
            const moved = Math.abs(viewCentre - c0) * pxPerSecond;
            document.getElementById('tlFollow').checked = true; document.getElementById('tlFollow').dispatchEvent(new Event('change'));
            return moved;`);
        check(s < 2, 'with "keep the playhead centred" off, the strip stays put while playing', `${s.toFixed(1)} px`);

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
    if (n) { console.error(`${n} tool check(s) failed.`); process.exit(1); }
    console.log('The editing and timing tools behave as expected.');
}).catch(err => { console.error(err); process.exit(1); });
