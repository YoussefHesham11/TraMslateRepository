// Renders tests/browser/editor-harness.html in headless Chrome at a range of
// window sizes and fails if the timeline ever overlaps the cue list.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CHROME = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(fs.existsSync);

// Chrome counts window furniture in --window-size, so these are padded to
// land on the content heights that matter: a 1080p desktop, a 1366x768
// laptop, and a half-height window. CHROME_H is measured by the runner and
// reported back, so a wrong guess shows up as a surprising viewport line
// rather than a silent pass.
const CHROME_H = 152;
const CONTENT = [[1920, 940], [1600, 800], [1440, 700], [1366, 620], [1280, 540], [1100, 460]];
const SIZES = CONTENT.map(([w, h]) => [w, h + CHROME_H]);

function run() {
    if (!CHROME) { console.log('SKIP: no Chrome/Edge found'); return 0; }
    const harness = path.join(__dirname, 'editor-harness.html');
    if (!fs.existsSync(harness)) { console.error('harness missing — run build-harness.cjs'); return 1; }
    const url = require('node:url').pathToFileURL(harness).href;

    let failed = 0;
    for (const [w, h] of SIZES) {
        const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-layout-'));
        let dom;
        try {
            dom = execFileSync(CHROME, [
                '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars=false',
                `--user-data-dir=${profile}`, `--window-size=${w},${h}`,
                '--virtual-time-budget=4000', '--dump-dom', url,
            ], { encoding: 'utf8', timeout: 90000, maxBuffer: 64 * 1024 * 1024 });
        } catch (err) {
            console.error(`  ${w}x${h}  ERROR  ${err.message.split('\n')[0]}`);
            failed++; continue;
        } finally {
            fs.rmSync(profile, { recursive: true, force: true });
        }

        const m = dom.match(/<pre id="layout-report">([\s\S]*?)<\/pre>/);
        if (!m) { console.error(`  ${w}x${h}  ERROR  no report in DOM`); failed++; continue; }
        const r = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
        if (r.failures.length) {
            failed++;
            console.error(`  ${r.viewport}  FAIL`);
            r.failures.forEach(f => console.error(`      ${f}`));
        } else {
            console.log(`  ${r.viewport}  ok   list ${r.listTop}\u2013${r.listBottom}  timeline starts ${r.timelineTop}`);
        }
    }
    return failed;
}

const failed = run();
if (failed) { console.error(`\n${failed} viewport(s) failed`); process.exit(1); }
console.log('\nAll viewports clear: the timeline never covers the cue list.');
