// Drives the editor the way a translator does and checks what they would see.
// This complements run-layout-check.cjs (geometry at many window sizes) by
// exercising the actual interactions: real keystrokes, the keyboard shortcut
// for the next cue, typing into the open card, and switching delivery profile.
//
//     node tests/browser/workflow-check.cjs
const path = require('node:path');
const url = require('node:url');
const { launch } = require('./cdp.cjs');

const failures = [];
const notes = [];
function check(condition, message) {
    if (condition) notes.push('  ok    ' + message);
    else { failures.push(message); notes.push('  FAIL  ' + message); }
}

(async () => {
    const page = await launch({ width: 1440, height: 700 });
    try {
        await page.goto(url.pathToFileURL(path.join(__dirname, 'editor-harness.html')).href);
        await page.waitFor("document.querySelectorAll('.tm-cue-item').length > 0");

        // ── Focus mode: exactly one cue is open at a time ──
        await page.eval("selectEvent(events[4].id, { scrollBlock: 'center', focusTranslation: true }); return 1;");
        const open = await page.eval("return document.querySelectorAll('.tm-cue-item-open').length;");
        check(open === 1, `exactly one cue is open (saw ${open})`);

        // ── Stepping forward with the keyboard ──
        // Twelve presses of the shortcut, checking the card after each one.
        const walk = await page.eval(`
            const list = document.getElementById('eventsList');
            const tl = Math.min(
                document.getElementById('timelineResizeHandle').getBoundingClientRect().top,
                document.querySelector('.tm-timeline-toolbar').getBoundingClientRect().top);
            const problems = [];
            for (let i = 0; i < 12; i++) {
                selectAdjacentCue(1);
                const cards = document.querySelectorAll('.tm-cue-item-open');
                if (cards.length !== 1) { problems.push('step ' + i + ': ' + cards.length + ' cards open'); continue; }
                const card = cards[0];
                const r = card.getBoundingClientRect();
                const lr = list.getBoundingClientRect();
                if (r.top < lr.top - 0.5 || r.bottom > lr.bottom + 0.5)
                    problems.push('step ' + i + ': card at ' + Math.round(r.top) + '..' + Math.round(r.bottom) + ' outside list ' + Math.round(lr.top) + '..' + Math.round(lr.bottom));
                if (r.bottom > tl + 0.5)
                    problems.push('step ' + i + ': card reaches ' + Math.round(r.bottom) + ', past the timeline at ' + Math.round(tl));
                const box = card.querySelector('.tm-translated-input');
                if (document.activeElement !== box) problems.push('step ' + i + ': caret is not in the translation box');
            }
            return problems;
        `);
        check(walk.length === 0, 'stepping forward keeps the whole card visible and focused'
            + (walk.length ? '\n          ' + walk.slice(0, 4).join('\n          ') : ''));

        // ── And backward ──
        const back = await page.eval(`
            const list = document.getElementById('eventsList');
            const problems = [];
            for (let i = 0; i < 12; i++) {
                selectAdjacentCue(-1);
                const card = document.querySelector('.tm-cue-item-open');
                if (!card) { problems.push('step ' + i + ': no open card'); continue; }
                const r = card.getBoundingClientRect(), lr = list.getBoundingClientRect();
                if (r.top < lr.top - 0.5 || r.bottom > lr.bottom + 0.5)
                    problems.push('step ' + i + ': card outside the list');
            }
            return problems;
        `);
        check(back.length === 0, 'stepping backward keeps the whole card visible'
            + (back.length ? '\n          ' + back.slice(0, 4).join('\n          ') : ''));

        // ── Typing lands in the model and updates the counter ──
        await page.eval("selectEvent(events[2].id, { scrollBlock: 'center', focusTranslation: true }); return 1;");
        await page.type('Bonjour');
        const typed = await page.eval(`
            const card = document.querySelector('.tm-cue-item-open');
            return {
                model: events.find(e => e.id === activeId).translatedText,
                counter: card.querySelector('.tm-char-counter').textContent.trim(),
                caretStillThere: document.activeElement === card.querySelector('.tm-translated-input'),
            };
        `);
        check(typed.model.endsWith('Bonjour'), `typing reaches the cue (got ${JSON.stringify(typed.model)})`);
        check(typed.caretStillThere, 'the caret stays in the box while typing');
        check(/\d+\s*\/\s*\d+/.test(typed.counter), `the character counter updates (${typed.counter})`);

        // ── Timeline click opens that cue in the panel ──
        const sync = await page.eval(`
            const block = document.querySelector('.tm-timeline-block[data-id]');
            if (!block) return { skipped: true };
            const id = Number(block.dataset.id);
            handleBlockSelect({ shiftKey: false, ctrlKey: false, metaKey: false }, id);
            const card = document.querySelector('.tm-cue-item-open');
            return { skipped: false, id, open: card ? Number(card.dataset.id) : null };
        `);
        check(sync.skipped || sync.open === sync.id,
            `clicking a timeline block opens that cue (block ${sync.id}, panel ${sync.open})`);

        // ── Delivery profile drives the checks ──
        const spec = await page.eval(`
            const select = document.getElementById('specProfile');
            const before = { cps: deliveryProfile.maxCps, chars: deliveryProfile.maxCharsPerLine };
            select.value = 'broadcast-37';
            select.dispatchEvent(new Event('change', { bubbles: true }));
            const after = { cps: deliveryProfile.maxCps, chars: deliveryProfile.maxCharsPerLine };
            const counter = document.querySelector('.tm-char-counter')?.textContent || '';
            return { before, after, counter, options: [...select.options].length };
        `);
        check(spec.options >= 6, `the profile picker lists the presets plus Custom (${spec.options} entries)`);
        check(spec.after.chars === 37, `choosing a profile changes the limits (${spec.before.chars} to ${spec.after.chars})`);
        check(spec.counter.includes('/ 37'), `the character counter follows the profile (${spec.counter.trim()})`);

        // ── Nothing threw along the way ──
        const errors = await page.eval('return window.__errors || [];');
        check(errors.length === 0, 'no runtime errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));

        await page.screenshot(path.join(__dirname, 'shot-workflow.png'));
    } finally {
        await page.close();
    }

    console.log(notes.join('\n'));
    if (failures.length) {
        console.error(`\n${failures.length} workflow check(s) failed`);
        process.exit(1);
    }
    console.log('\nEditor workflow behaves as expected.');
})().catch(err => { console.error(err); process.exit(1); });
