// Screenshots the editor with the timeline fully analysed (waveform and shot
// changes), for looking at the strip rather than asserting on it.
//
//     node tests/browser/timeline-shot.cjs [out.png] [WIDTHxHEIGHT] [seconds]
//
// `seconds` parks the playhead there before the shot.
const path = require('node:path');
const { launch } = require('./cdp.cjs');
const { serve } = require('./serve.cjs');

(async () => {
    const out = path.resolve(process.argv[2] || path.join(__dirname, 'shots', 'timeline.png'));
    const [w, h] = (process.argv[3] || '1600x900').split('x').map(Number);
    const at = Number(process.argv[4] || 20);
    const server = await serve();
    const page = await launch({ width: w, height: h });
    try {
        await page.goto(`${server.base}/tests/browser/editor-harness.html`);
        await page.waitFor('document.querySelector(".tm-cue-item") !== null', { timeout: 30000 });
        await page.waitFor('peaksStatus === "ready" || peaksStatus === "failed"', { timeout: 300000 });
        await page.waitFor('shotsStatus === "ready" || shotsStatus === "failed" || shotsStatus === "idle"', { timeout: 600000 });
        const state = await page.eval(`
            const v = document.getElementById('videoPlayer');
            v.currentTime = ${at};
            await new Promise(r => v.addEventListener('seeked', r, { once: true }));
            await new Promise(r => setTimeout(r, 600));
            return { peaks: peaksStatus, msg: peaksMessage, shots: shotsStatus, cuts: shotCuts.length,
                     shotsMsg: shotsMessage, duration: v.duration, errors: window.__errors };`);
        console.log(JSON.stringify(state));
        await page.screenshot(out);
        console.log('wrote', out);
    } finally {
        await page.close();
        server.close();
    }
})().catch(err => { console.error(err); process.exit(1); });
