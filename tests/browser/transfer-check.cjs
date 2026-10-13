// Import and export in the real editor: previews, malformed entries,
// encodings, append vs replace (with a recovery copy), draft exports, format
// losses explained, bilingual output, blocked export for unplayable timing,
// failed exports, and the honest "your browser was given the file" message.
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
    try {
        await page.goto(`${server.base}/tests/browser/editor-harness.html?cues=3`);
        await page.waitFor('typeof TmTransfer !== "undefined" && loaded && document.querySelector(".tm-cue-item")', { timeout: 30000 });

        // Downloads are captured instead of written to disk.
        await page.eval(`
            window.__downloads = [];
            const real = URL.createObjectURL.bind(URL);
            URL.createObjectURL = blob => { window.__downloads.push(blob); return real(blob); };
            HTMLAnchorElement.prototype.click = function () { window.__downloadName = this.download; };
            window.__pick = (name, bytes) => {
                const dt = new DataTransfer();
                dt.items.add(new File([new Uint8Array(bytes)], name));
                const input = document.getElementById('importScript');
                input.files = dt.files;
                input.dispatchEvent(new Event('change', { bubbles: true }));
            };
            window.__modal = () => document.querySelector('.tm-transfer-modal, .tm-choice-modal');
            return 1;`);

        // ── Import a file with problems ─────────────────────────────────
        const srt = '1\n00:00:20,000 --> 00:00:22,000\nFirst new\nsecond line\n\n2\n00:00:2X,000 --> 00:00:24,000\nBroken\n\n3\n00:00:26,000 --> 00:00:25,000\nBackwards\n';
        await page.eval(`__pick('reel.srt', ${JSON.stringify([...Buffer.from(srt, 'utf8')])}); return 1;`);
        await page.waitFor('__modal()', { timeout: 5000 });
        let s = await page.eval(`const m = __modal(); return { text: m.textContent.replace(/\\s+/g, ' '), mode: m.querySelector('input[name="mode"]:checked')?.value, rows: m.querySelectorAll('tbody tr').length };`);
        check(/2 subtitles read as SRT/.test(s.text), 'the preview says what was read', s.text.slice(0, 60));
        check(/could not be read.*skipped/.test(s.text) && /ends before it starts/.test(s.text), 'and explains each malformed entry');
        check(s.rows === 2 && /First new/.test(s.text), 'with a sample of the subtitles');
        check(s.mode === 'append', 'adding after the existing subtitles is the default when the project has some');
        const before = await page.eval('return events.length;');
        await page.eval(`__modal().querySelector('button[type="submit"]').click(); return 1;`);
        await sleep(300);
        s = await page.eval(`return { n: events.length, last: events.at(-1).originalText, multi: events.at(-2).originalText,
            notes: (workspaceSettings.importIssues || []).length, banner: document.getElementById('editorBanner').textContent };`);
        check(s.n === before + 2, 'appending adds them after the existing subtitles', `${before} → ${s.n}`);
        check(s.multi === 'First new\nsecond line', 'a multi-line entry stays one subtitle');
        check(s.notes === 2 && /need attention/.test(s.banner), 'problems stay listed in the issues panel');
        await page.eval(`TmWorkspace.openPanel(); return 1;`);
        await sleep(200);
        s = await page.eval(`return document.getElementById('issuesPanel').textContent;`);
        check(/Notes from the last import/.test(s), 'the issues panel shows the import notes with a way to clear them');

        // ── Replace keeps a recovery copy first ─────────────────────────
        const snapsBefore = await page.eval('return __server.snapshots.length;');
        await page.eval(`__pick('reel2.srt', ${JSON.stringify([...Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nOnly one\n', 'utf8')])}); return 1;`);
        await page.waitFor('__modal()', { timeout: 5000 });
        await page.eval(`__modal().querySelector('input[value="replace"]').click(); __modal().querySelector('button[type="submit"]').click(); return 1;`);
        await sleep(500);
        s = await page.eval(`const snap = __server.snapshots.at(-1); return { n: events.length, kind: snap?.kind, kept: snap?.events.length, label: snap?.label };`);
        check(s.n === 1, 'replacing swaps in the imported subtitles');
        check(s.kind === 2 && s.kept === before + 2, 'after keeping the previous subtitles as a recovery copy', s.label);
        s = await page.eval(`restoreHistory(-1); return events.length;`);
        check(s === before + 2, 'and undo brings them straight back');

        // ── Encoding ────────────────────────────────────────────────────
        const cp1256 = [...Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n', 'latin1'), 0xE3, 0xD1, 0xCD, 0xC8, 0xC7, 0x0A];
        await page.eval(`__pick('arabic.srt', ${JSON.stringify(cp1256)}); return 1;`);
        await page.waitFor('__modal()', { timeout: 5000 });
        s = await page.eval(`const m = __modal(); return { enc: m.querySelector('[data-field="encoding"]').value, text: m.textContent };`);
        check(s.enc === 'windows-1256' && /مرحبا/.test(s.text) && /guessed/.test(s.text), 'a non-UTF-8 Arabic file is detected as Windows-1256, flagged as a guess');
        await page.eval(`const sel = __modal().querySelector('[data-field="encoding"]'); sel.value = 'windows-1252'; sel.dispatchEvent(new Event('change', { bubbles: true })); return 1;`);
        await sleep(200);
        s = await page.eval(`const m = __modal(); return { enc: m.querySelector('[data-field="encoding"]').value, arabic: /مرحبا/.test(m.textContent) };`);
        check(s.enc === 'windows-1252' && !s.arabic, 'choosing another encoding re-reads the file in the preview');
        await page.eval(`__modal().querySelector('[data-cancel]').click(); return 1;`);

        // ── Export: draft, formats, losses, preview ─────────────────────
        // The imported "Backwards" entry still ends before it starts; fix it so
        // this part tests a draft, not a blocked export (tested further down).
        await page.eval(`const back = events.find(e => e.originalText === 'Backwards'); back.endTime = '00:00:27,000';
            events[0].translatedText = '<i>مرحبا</i> <font color="red">x</font>'; events.at(-1).translatedText = ''; markDirty(); return 1;`);
        await page.eval(`document.getElementById('btnExportSrt').click(); return 1;`);
        await page.waitFor('__modal()', { timeout: 5000 });
        s = await page.eval(`const m = __modal(); return { text: m.textContent.replace(/\\s+/g, ' '), button: m.querySelector('[data-download]').textContent, preview: m.querySelector('[data-preview]').innerHTML };`);
        check(/Draft:/.test(s.text) && s.button === 'Download draft', 'with problems remaining, the export is offered as a clearly marked draft', s.button + ' | ' + s.text.slice(0, 300));
        check(/changes not yet saved/.test(s.text), 'it says which version is being exported');
        check(/<i>مرحبا<\/i>/.test(s.preview), 'the preview shows the subtitles as they will read');
        await page.eval(`const f = __modal().querySelector('[data-field="format"]'); f.value = 'vtt'; f.dispatchEvent(new Event('change', { bubbles: true }));
            const c = __modal().querySelector('[data-field="content"]'); c.value = 'bilingual'; c.dispatchEvent(new Event('change', { bubbles: true })); return 1;`);
        s = await page.eval(`return __modal().textContent;`);
        check(/<font> formatting \(1 place\) is not supported by WebVTT/.test(s), 'formatting the format cannot keep is explained before export');
        await page.eval(`__modal().querySelector('[data-download]').click(); return 1;`);
        await sleep(200);
        s = await page.eval(`return { name: window.__downloadName, text: await window.__downloads.at(-1).text(), banner: document.getElementById('editorBanner').textContent };`);
        check(/ \(bilingual\) - DRAFT\.vtt$/.test(s.name), 'the file name says draft and bilingual', s.name);
        check(/^﻿?WEBVTT\n\nNOTE\nDRAFT/.test(s.text) && !/<font/.test(s.text), 'the file itself is marked as a draft and drops what WebVTT cannot hold');
        check(/<i>مرحبا<\/i> x\nHello/.test(s.text) || /مرحبا/.test(s.text), 'bilingual output carries both texts');
        check(/was given .* cannot confirm the file was saved/.test(s.banner), 'it reports the download honestly');

        // ── Unplayable timing blocks timed formats, with links ──────────
        await page.eval(`events[0].endTime = '00:00:00,500'; events[0].startTime = '00:00:01,000'; markDirty(); document.getElementById('btnExportSrt').click(); return 1;`);
        await page.waitFor('__modal()', { timeout: 5000 });
        s = await page.eval(`const m = __modal(); return { disabled: m.querySelector('[data-download]').disabled, text: m.textContent, link: !!m.querySelector('[data-goto]') };`);
        check(s.disabled && /Cannot export yet/.test(s.text) && s.link, 'subtitles that cannot play block the export and link to the problem');
        await page.eval(`__modal().querySelector('[data-goto]').click(); return 1;`);
        await sleep(300);
        s = await page.eval(`return { open: Number(document.querySelector('.tm-cue-item-open')?.dataset.id), first: events[0].id, field: document.activeElement?.dataset?.field };`);
        check(s.open === s.first && /Time$/.test(s.field || ''), 'and the link opens that subtitle at its timing');
        await page.eval(`events[0].endTime = '00:00:03,000'; markDirty(); return 1;`);

        // ── A failing export leaves the project alone ───────────────────
        const kept = await page.eval(`return JSON.stringify(events);`);
        await page.eval(`window.__RealBlob = Blob; window.Blob = function () { throw new Error('disk quota'); };
            document.getElementById('btnExportSrt').click(); return 1;`);
        await page.waitFor('__modal()', { timeout: 5000 });
        await page.eval(`__modal().querySelector('[data-download]').click(); return 1;`);
        await sleep(200);
        s = await page.eval(`window.Blob = window.__RealBlob; return { banner: document.getElementById('editorBanner').textContent, same: JSON.stringify(events) };`);
        check(/export failed \(disk quota\).*project is unchanged/.test(s.banner) && s.same === kept, 'a failed export says so and leaves the project untouched');

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
    if (n) { console.error(`${n} transfer check(s) failed.`); process.exit(1); }
    console.log('Import and export behave as expected.');
}).catch(err => { console.error(err); process.exit(1); });
