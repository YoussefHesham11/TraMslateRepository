// End-to-end checks of the translator workspace in the real editor, against
// the harness's revision-aware stand-in server (harness-boot.js):
//   issues panel → open the exact field → explain → fix with preview → undo;
//   waivers and marks; Done gating, completion of an exact version, editing
//   after completion and editing *during* completion; save failure and retry;
//   a lost response; a concurrent-tab conflict; refresh recovery; history.
const path = require('node:path');
const fs = require('node:fs');
const { launch, CHROME, sleep } = require('./cdp.cjs');
const { serve } = require('./serve.cjs');

let failures = 0;
const ok = (label, detail = '') => console.log(`  ok    ${label}${detail ? '  ' + detail : ''}`);
const bad = (label, detail = '') => { failures++; console.error(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); };
const check = (cond, label, detail = '') => (cond ? ok : bad)(label, detail);

// Small project: four cues fully inside the 13 s sample video, so only the
// problems each step creates are on the table.
const SETUP = `
    __server.events = [
        { id: 1, index: 1, startTime: '00:00:01,000', endTime: '00:00:03,000', originalText: 'Hello there.', translatedText: 'مرحبا.' },
        { id: 2, index: 2, startTime: '00:00:03,500', endTime: '00:00:05,500', originalText: 'The Bureau knows.', translatedText: '' },
        { id: 3, index: 3, startTime: '00:00:06,000', endTime: '00:00:08,000', originalText: 'Ahmed.', translatedText: 'Ahmed.' },
        { id: 4, index: 4, startTime: '00:00:09,000', endTime: '00:00:11,000', originalText: 'Go now.', translatedText: 'اذهب الآن.' },
    ];
    __server.revision = 1;
    try { localStorage.clear(); } catch {}
`;

async function main() {
    if (!CHROME) { console.log('SKIP: no Chrome/Edge found'); return 0; }
    if (!fs.existsSync(path.join(__dirname, 'editor-harness.html'))) { console.error('harness missing — run build-harness.cjs'); return 1; }
    const server = await serve();
    const page = await launch({ width: 1600, height: 900 });
    const url = `${server.base}/tests/browser/editor-harness.html`;

    try {
        // Boot a tiny track, then swap in the small project exactly as a load
        // would deliver it.
        await page.goto(url + '?cues=4');
        await page.waitFor('typeof __server !== "undefined" && document.querySelector(".tm-cue-item")', { timeout: 30000 });
        await page.eval(`
            ${SETUP}
            // Replace what the editor loaded with the small project, the same
            // way a fresh load would see it.
            const payload = { revision: 1, events: JSON.parse(JSON.stringify(__server.events)), status: 'InProgress', updatedAt: new Date().toISOString() };
            events = payload.events; loadedRevision = 1; rememberBaseline(payload.events);
            isDirty = false; revision = 0; history = [JSON.stringify(events)]; historyIndex = 0;
            renderEvents(); renderTimelineBlocks(); paintSaveState('saved');
            TmWorkspace.onLoaded(payload);
            return 1;`);

        // ── Done is disabled and says why ────────────────────────────────
        let s = await page.eval(`return { disabled: document.getElementById('btnDone').disabled,
            reason: document.getElementById('doneReason').textContent,
            described: document.getElementById('btnDone').getAttribute('aria-describedby') };`);
        check(s.disabled, 'Done starts disabled');
        check(/1 untranslated subtitle/.test(s.reason), 'the reason names what remains', s.reason);
        check(s.described === 'doneReason', 'the disabled button is described by the reason text');

        // ── View issues: the panel lists problems by severity ────────────
        await page.eval(`document.getElementById('btnViewIssues').click(); return 1;`);
        s = await page.eval(`const p = document.getElementById('issuesPanel');
            return { open: !p.hidden, rows: p.querySelectorAll('.tm-issue-row').length,
                     tabs: [...p.querySelectorAll('.tm-issues-tab')].map(t => t.textContent.replace(/\\s+/g, ' ').trim()) };`);
        check(s.open && s.rows >= 1, 'View issues opens the panel', s.tabs.join(' | '));

        // ── Clicking a problem opens the exact field ─────────────────────
        s = await page.eval(`
            document.querySelector('#issuesPanel .tm-issue-row').click();
            await new Promise(r => setTimeout(r, 300));
            const card = document.querySelector('.tm-cue-item-open');
            const list = document.getElementById('eventsList').getBoundingClientRect();
            const r = card.getBoundingClientRect();
            const box = card.querySelector('.tm-translated-input');
            return { id: Number(card.dataset.id), focused: document.activeElement === box,
                     inView: r.top >= list.top - 0.5 && r.bottom <= list.bottom + 0.5,
                     callout: card.querySelector('.tm-issue-callout')?.textContent.replace(/\\s+/g, ' ').trim(),
                     flashed: box.classList.contains('tm-field-flash') };`);
        check(s.id === 2, 'the untranslated subtitle opens', `#${s.id}`);
        check(s.focused, 'its translation field takes the caret');
        check(s.inView, 'the whole card is in view');
        check(s.flashed, 'the field is highlighted');
        check(/Untranslated/.test(s.callout || '') && /What to do/.test(s.callout || ''), 'a plain explanation and action appear beside it');

        // ── Typing resolves it; the issue disappears without moving the caret ──
        await page.type('مكتب');
        await sleep(600);
        s = await page.eval(`const box = document.querySelector('.tm-cue-item-open .tm-translated-input');
            return { focused: document.activeElement === box, caret: box.selectionStart, value: box.value,
                     resolved: !!document.querySelector('.tm-issue-callout-resolved'),
                     untranslated: TmQuality.validate(events, workspaceSettings).findings.filter(f => f.code === 'text.untranslated').length };`);
        check(s.untranslated === 0 && s.resolved, 'the issue clears as soon as the line is translated');
        check(s.focused && s.caret === s.value.length, 'background checking leaves the caret where it was');

        // ── A fix: preview, apply, undo ──────────────────────────────────
        await page.eval(`events[3].endTime = '00:00:09,300'; markDirty(); renderEvents(); TmWorkspace.goTo(TmQuality.validate(events, { profile: deliveryProfile, ...workspaceSettings }).findings.find(f => f.code === 'timing.short')); return 1;`);
        await sleep(300);
        s = await page.eval(`const card = document.querySelector('.tm-cue-item-open');
            return { id: Number(card.dataset.id), focusedField: document.activeElement?.dataset?.field,
                     fix: !!card.querySelector('.tm-issue-callout [data-act="fix"]'), play: !!card.querySelector('.tm-issue-callout [data-act="play"]') };`);
        check(s.id === 4 && s.focusedField === 'endTime', 'a timing problem focuses the out-time box', `#${s.id} ${s.focusedField}`);
        check(s.fix && s.play, 'it offers a previewed fix and playback at that moment');
        await page.eval(`document.querySelector('.tm-issue-callout [data-act="fix"]').click(); return 1;`);
        await sleep(200);
        s = await page.eval(`const m = document.querySelector('.tm-choice-modal');
            return { preview: m?.querySelector('.tm-preview-table')?.textContent.replace(/\\s+/g, ' '), end: events[3].endTime };`);
        check(/00:00:09,300/.test(s.preview || '') && /00:00:10,000/.test(s.preview || ''), 'the preview shows before and after', s.preview);
        check(s.end === '00:00:09,300', 'nothing changes before Apply');
        await page.eval(`[...document.querySelectorAll('.tm-choice-modal button')].find(b => b.textContent === 'Apply').click(); return 1;`);
        await sleep(200);
        s = await page.eval(`const after = events[3].endTime; restoreHistory(-1); return { after, undone: events[3].endTime };`);
        check(s.after === '00:00:10,000' && s.undone === '00:00:09,300', 'Apply changes it and undo restores it', `${s.after} → undo → ${s.undone}`);
        await page.eval(`events[3].endTime = '00:00:11,000'; markDirty(); renderEvents(); return 1;`);

        // ── Waive with a reason ─────────────────────────────────────────
        await page.eval(`TmWorkspace.goTo(TmQuality.validate(events, workspaceSettings).findings.find(f => f.code === 'text.sameAsSource')); return 1;`);
        await sleep(200);
        await page.eval(`document.querySelector('.tm-issue-callout [data-act="waive"]').click(); return 1;`);
        await sleep(150);
        await page.eval(`document.getElementById('tmAskInput').value = 'A name, same in both languages';
            document.querySelector('.tm-modal-backdrop form').requestSubmit(); return 1;`);
        await sleep(200);
        s = await page.eval(`const f = TmQuality.validate(events, workspaceSettings).findings.find(x => x.code === 'text.sameAsSource');
            return { waived: f?.waived?.reason, json: events[2].waiversJson };`);
        check(s.waived === 'A name, same in both languages', 'a waiver records its reason', s.json);

        // ── Marks block Done ────────────────────────────────────────────
        await page.eval(`selectEvent(1); document.querySelector('.tm-cue-item-open .tm-marks-btn').click(); return 1;`);
        await sleep(100);
        await page.eval(`const box = document.querySelector('.tm-marks-popover input[data-flag="2"]'); box.click(); return 1;`);
        await sleep(500);
        s = await page.eval(`return { flags: events[0].flags, reason: document.getElementById('doneReason').textContent };`);
        check(s.flags === 2, 'marking "Needs timing" sets the flag');
        check(/open flag/.test(s.reason), 'and Done now waits for it', s.reason);
        await page.eval(`document.querySelector('.tm-marks-popover input[data-flag="2"]').click(); document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return 1;`);

        // ── Done: enabled only when checked, saved and nothing blocks ───
        await page.eval(`workspaceSettings = { ...workspaceSettings, rules: { warningsForDone: 'never' } }; markDirty(); return 1;`);
        await page.waitFor(`saveState === 'saved' && !isDirty`, { timeout: 10000 });
        await sleep(500);
        s = await page.eval(`return { disabled: document.getElementById('btnDone').disabled, reason: document.getElementById('doneReason').textContent };`);
        check(!s.disabled, 'Done enables once everything is checked and saved', s.reason);

        // Edits during Done's save must not let an older version be completed.
        await page.eval(`markDirty(); return 1;`);
        await page.eval(`__server.hold = () => {}; document.getElementById('btnDone').disabled = false; TmWorkspace.startDone(); return 1;`);
        await page.waitFor('typeof __server.release === "function"', { timeout: 5000 });
        await page.eval(`events[0].translatedText = 'مرحبا!'; markDirty(); __server.release(); return 1;`);
        await sleep(800);
        s = await page.eval(`const m = document.querySelector('.tm-choice-modal'); const t = m?.textContent || ''; m?.querySelector('button')?.click();
            return { modal: t, completed: __server.completed };`);
        check(s.completed == null, 'edits made while Done is saving stop that version being marked done');
        check(/Edited while checking/.test(s.modal), 'and the person is told why', s.modal.slice(0, 80));

        await page.waitFor(`saveState === 'saved' && !isDirty`, { timeout: 10000 });
        await sleep(500);
        const savesBefore = await page.eval('return __server.saves;');
        await page.eval(`document.getElementById('btnDone').click(); return 1;`);
        await page.waitFor(`document.querySelector('.tm-choice-modal') !== null`, { timeout: 10000 });
        s = await page.eval(`const m = document.querySelector('.tm-choice-modal');
            return { title: m.querySelector('.tm-modal-title').textContent, completed: __server.completed, revision: __server.revision,
                     status: document.getElementById('projectStatus').value, text: m.textContent };`);
        check(s.completed === s.revision, 'Done marks exactly the saved revision complete', `version ${s.completed}`);
        check(/is done/.test(s.title) && /Nothing has been sent or published/.test(s.text), 'a completion summary appears and says nothing was sent');
        check(s.status === 'Completed', 'the project shows as Completed');
        await page.eval(`[...document.querySelectorAll('.tm-choice-modal button')].find(b => b.textContent === 'Close').click(); return 1;`);
        check(await page.eval('return __server.saves;') === savesBefore, 'nothing needed saving, so Done did not save again');

        // Pressing it twice cannot complete twice: it is disabled once complete.
        s = await page.eval(`return { disabled: document.getElementById('btnDone').disabled, text: document.getElementById('btnDone').textContent.trim() };`);
        check(s.disabled && /Completed/.test(s.text), 'once done, the button shows Completed and cannot be pressed again');

        // Editing a completed project reopens it, keeping the record.
        await page.eval(`events[3].translatedText = 'اذهب!'; markDirty(); return 1;`);
        await page.waitFor(`saveState === 'saved' && !isDirty`, { timeout: 10000 });
        await sleep(400);
        s = await page.eval(`return { status: __server.status, completed: __server.completed, select: document.getElementById('projectStatus').value,
            reason: document.getElementById('doneReason').textContent, disabled: document.getElementById('btnDone').disabled };`);
        check(s.status === 'InProgress' && s.select === 'InProgress', 'editing a completed project reopens it');
        check(s.completed != null && /was done/.test(s.reason), 'the earlier completed version is still recorded', s.reason);

        // ── Save failure, retry, lost response ──────────────────────────
        await page.eval(`__server.failNext = 500; events[0].comment = 'x'; markDirty(); clearTimeout(autoSaveTimer); doSave(); return 1;`);
        await sleep(300);
        s = await page.eval(`return document.getElementById('saveStatus').textContent;`);
        check(/Save failed — retrying in 2s/.test(s), 'a failed save says so and retries by itself', s);
        await page.waitFor(`saveState === 'saved'`, { timeout: 8000 });
        ok('the retry lands');

        const before = await page.eval('return { saves: __server.saves, rev: __server.revision };');
        await page.eval(`__server.failNext = 'network'; events[0].comment = 'y'; markDirty(); clearTimeout(autoSaveTimer); doSave(); return 1;`);
        await page.waitFor(`saveState === 'saved'`, { timeout: 8000 });
        const after = await page.eval('return { saves: __server.saves, rev: __server.revision, comment: __server.events[0].comment };');
        check(after.saves === before.saves + 1 && after.comment === 'y', 'a network failure is retried without saving twice', `${after.saves - before.saves} save`);

        // ── Another tab saved the same line: both versions are kept ──────
        await page.eval(`__server.events[0].translatedText = 'from the other tab'; __server.revision++;
            events[0].translatedText = 'mine'; markDirty(); clearTimeout(autoSaveTimer); doSave(); return 1;`);
        await sleep(800);
        s = await page.eval(`return { state: saveState, banner: document.getElementById('editorBanner').textContent,
            kept: __server.snapshots.some(x => x.kind === 6 && x.events[0].translatedText === 'mine'), mine: events[0].translatedText };`);
        check(s.state === 'stale' && /Both versions are kept/.test(s.banner), 'a real conflict stops saving and says both are kept');
        check(s.kept && s.mine === 'mine', 'this tab’s version is stored on the server and still on screen');
        await page.eval(`TmWorkspace.openConflict(); return 1;`);
        await page.waitFor(`document.querySelector('.tm-choice-modal .tm-preview-table')`, { timeout: 5000 });
        s = await page.eval(`return document.querySelector('.tm-choice-modal').textContent;`);
        check(/from the other tab/.test(s) && /mine/.test(s), 'the comparison shows both wordings side by side');
        await page.eval(`[...document.querySelectorAll('.tm-choice-modal button')].find(b => b.textContent === 'Keep my version').click(); return 1;`);
        await page.waitFor(`saveState === 'saved'`, { timeout: 8000 });
        s = await page.eval(`return { server: __server.events[0].translatedText,
            theirsKept: __server.snapshots.some(x => x.kind === 6 && x.events[0].translatedText === 'from the other tab') };`);
        check(s.server === 'mine' && s.theirsKept, 'keeping mine saves it, and their version stays in the history');

        // ── Refresh with unsaved edits: offered back with a preview ─────
        await page.eval(`__server.failNext = 'network'; events[1].translatedText = 'unsaved before refresh'; markDirty(); writeDraft(); isDirty = false; return 1;`);
        await page.goto(url);
        await page.waitFor(`document.querySelector('.tm-choice-modal') !== null`, { timeout: 15000 });
        s = await page.eval(`return document.querySelector('.tm-choice-modal').textContent;`);
        check(/Unsaved work found/.test(s) && /unsaved before refresh/.test(s), 'after a refresh, unsaved work is offered with a preview of what it changes');
        await page.eval(`[...document.querySelectorAll('.tm-choice-modal button')].find(b => /Restore/.test(b.textContent)).click(); return 1;`);
        await sleep(300);
        s = await page.eval(`return { text: events.find(e => e.translatedText === 'unsaved before refresh') ? 'restored' : 'missing', dirty: isDirty };`);
        check(s.text === 'restored' && s.dirty, 'restoring brings the work back, ready to save');

        // ── Version history ─────────────────────────────────────────────
        await page.waitFor(`saveState === 'saved'`, { timeout: 8000 });
        await page.eval(`document.getElementById('saveStatus').click(); return 1;`);
        await page.waitFor(`document.querySelector('.tm-history-row')`, { timeout: 5000 });
        s = await page.eval(`return document.querySelectorAll('.tm-history-row').length;`);
        check(s > 0, 'the save status opens the version history', `${s} versions`);
        await page.eval(`document.querySelector('.tm-history-row').click(); return 1;`);
        await page.waitFor(`/Restore this version/.test(document.querySelector('.tm-choice-modal')?.textContent || '')`, { timeout: 5000 });
        ok('a version previews what restoring it would change before anything happens');
        await page.eval(`[...document.querySelectorAll('.tm-choice-modal button')].find(b => b.textContent === 'Cancel').click(); return 1;`);

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
    if (n) { console.error(`${n} workspace check(s) failed.`); process.exit(1); }
    console.log('The workspace behaves as expected.');
}).catch(err => { console.error(err); process.exit(1); });
