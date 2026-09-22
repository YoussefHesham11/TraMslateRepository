// Ad-hoc height probe: prints the measured height of each part of the editor
// shell at a few window sizes, to show where the vertical budget goes.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const url = require('node:url');

const CHROME = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(fs.existsSync);

const SEL = [
    '.tm-editor-wrap', '.tm-editor-topbar', '.tm-editor-body', '.tm-editor-left',
    '.tm-video-wrap', '.tm-playback-controls', '.tm-editor-right', '.tm-events-header',
    '.tm-workspace-tools', '.tm-events-list', '.tm-timeline-resize-handle',
    '.tm-timeline-toolbar', '.tm-timeline-wrap', '.tm-cue-item-open', '.tm-cue-row',
];

const probe = path.join(__dirname, 'probe.html');
const base = fs.readFileSync(path.join(__dirname, 'editor-harness.html'), 'utf8');
fs.writeFileSync(probe, base.replace('</body>', `<script>
setTimeout(function () {
  var rows = ${JSON.stringify(SEL)}.map(function (s) {
    var e = document.querySelector(s);
    if (!e) return s + '=-';
    var r = e.getBoundingClientRect();
    return s + '=' + Math.round(r.height);
  });
  rows.push('viewport=' + window.innerWidth + 'x' + window.innerHeight);
  var pre = document.createElement('pre');
  pre.id = 'probe';
  pre.textContent = rows.join('  ');
  document.body.appendChild(pre);
}, 1200);
</script></body>`));

for (const [w, h] of (process.argv[2] ? [process.argv[2].split('x').map(Number)] : [[1600, 900], [1280, 548], [1082, 408]])) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-probe-'));
    const dom = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
        `--user-data-dir=${profile}`, `--window-size=${w},${h}`, '--virtual-time-budget=4000',
        '--dump-dom', url.pathToFileURL(probe).href],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    fs.rmSync(profile, { recursive: true, force: true });
    const m = dom.match(/<pre id="probe">([\s\S]*?)<\/pre>/);
    console.log(m ? m[1].replace(/&quot;/g, '"') : 'no probe');
    console.log('');
}
