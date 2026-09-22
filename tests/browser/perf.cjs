// Measures what a feature-length track costs the editor: first render, moving
// the selection, typing, and redrawing the timeline. Run directly:
//     node tests/browser/perf.cjs [cueCount]
const path = require('node:path');
const url = require('node:url');
const { launch } = require('./cdp.cjs');

const CUES = Number(process.argv[2] || 1500);

(async () => {
    const page = await launch({ width: 1600, height: 900 });
    try {
        const harness = url.pathToFileURL(path.join(__dirname, 'editor-harness.html')).href;
        await page.goto(`${harness}?cues=${CUES}`);
        await page.waitFor("document.querySelectorAll('.tm-cue-item').length > 0");

        const report = await page.eval(`
            const time = (fn, runs = 1) => {
                const t = performance.now();
                for (let i = 0; i < runs; i++) fn(i);
                return +((performance.now() - t) / runs).toFixed(2);
            };
            const list = document.getElementById('eventsList');
            const ids = [...list.querySelectorAll('.tm-cue-item')].map(n => Number(n.dataset.id));

            const renderMs = time(() => renderEvents(), 5);
            const selectMs = time(i => selectEvent(ids[10 + i], { scrollBlock: 'center', focusTranslation: true }), 25);
            const box = list.querySelector('.tm-translated-input');
            const typeMs = time(() => {
                box.value += 'x';
                box.dispatchEvent(new Event('input', { bubbles: true }));
            }, 50);
            const blocksMs = time(() => renderTimelineBlocks(), 3);
            const analyzeMs = time(() => SubtitleCore.analyze(events), 5);

            return {
                cues: events.length,
                renderMs, selectMs, typeMs, blocksMs, analyzeMs,
                domNodes: document.getElementsByTagName('*').length,
                listNodes: list.getElementsByTagName('*').length,
            };
        `);

        const pad = (k, v) => `  ${(k + ' ').padEnd(26, '.')} ${v}`;
        console.log(`\n${report.cues} cues`);
        console.log(pad('first render', report.renderMs + ' ms'));
        console.log(pad('select next cue', report.selectMs + ' ms'));
        console.log(pad('one keystroke', report.typeMs + ' ms'));
        console.log(pad('redraw timeline blocks', report.blocksMs + ' ms'));
        console.log(pad('quality sweep', report.analyzeMs + ' ms'));
        console.log(pad('DOM nodes (page)', report.domNodes));
        console.log(pad('DOM nodes (cue list)', report.listNodes));

        // A keystroke has to stay well inside a frame or typing feels sticky.
        const slow = [];
        if (report.typeMs > 16) slow.push(`keystroke ${report.typeMs}ms`);
        if (report.selectMs > 60) slow.push(`select ${report.selectMs}ms`);
        if (report.renderMs > 400) slow.push(`render ${report.renderMs}ms`);
        if (slow.length) { console.error('\nTOO SLOW: ' + slow.join(', ')); process.exitCode = 1; }
        else console.log('\nWithin budget.');
    } finally {
        await page.close();
    }
})().catch(err => { console.error(err); process.exit(1); });
