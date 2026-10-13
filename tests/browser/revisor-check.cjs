// Opens the editor in the revisor's seat. That page renders fewer controls
// than the translator's (no import, no project status, no finish-review
// shortcut to their own verdict), and an unguarded reference to one of the
// missing controls once stopped the editor from loading at all for revisors.
//
//     node tests/browser/revisor-check.cjs
const path = require('node:path');
const url = require('node:url');
const { launch } = require('./cdp.cjs');

const failures = [];
function check(condition, message) {
    console.log((condition ? '  ok    ' : '  FAIL  ') + message);
    if (!condition) failures.push(message);
}

(async () => {
    const page = await launch({ width: 1440, height: 800 });
    try {
        await page.goto(url.pathToFileURL(path.join(__dirname, 'editor-harness-revisor.html')).href);
        let loadedOk = true;
        try { await page.waitFor("typeof loaded !== 'undefined' && loaded === true", { timeout: 15000 }); }
        catch { loadedOk = false; }
        const errors = await page.eval('return window.__errors || [];');
        check(loadedOk, 'the editor loads in the revisor\'s seat');
        check(errors.length === 0, 'no script errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
        if (!loadedOk) return;

        const seat = await page.eval(`
            selectEvent(events[4].id, { scrollBlock: 'center' });
            const card = document.querySelector('.tm-cue-item-open');
            return {
                revisor: IS_REVISOR,
                translationReadOnly: card.querySelector('.tm-translated-input').readOnly,
                suggestionBox: !!card.querySelector('.tm-suggested-input'),
                flagSelect: !!card.querySelector('.tm-review-flag-select'),
                hidden: ['btnAddEvent', 'btnSplitCue', 'btnMergeCue', 'copySource', 'replaceAll']
                    .filter(id => !document.getElementById(id).hidden),
                finish: !!document.getElementById('btnFinishReview'),
            };`);
        check(seat.revisor, 'the editor knows it is the revisor');
        check(seat.translationReadOnly, 'the translator\'s line is read-only');
        check(seat.suggestionBox && seat.flagSelect, 'the open card has the suggestion box and flag controls');
        check(seat.hidden.length === 0, 'structural and rewording controls are hidden' + (seat.hidden.length ? ' (visible: ' + seat.hidden.join(', ') + ')' : ''));
        check(seat.finish, 'the Finish review button is present');

        const typed = await page.eval(`
            const box = document.querySelector('.tm-cue-item-open .tm-suggested-input');
            box.value = 'A better line.';
            box.dispatchEvent(new Event('input', { bubbles: true }));
            return { stored: events[4].suggestedText, dirty: isDirty };`);
        check(typed.stored === 'A better line.' && typed.dirty, 'typing a suggestion updates the cue and marks it unsaved');
        await page.eval('isDirty = false; return 1;');
    } finally {
        await page.close();
    }
    if (failures.length) { console.error(`\n${failures.length} revisor check(s) failed.`); process.exit(1); }
    console.log('\nThe revisor\'s editor behaves as expected.');
})().catch(err => { console.error(err); process.exit(1); });
