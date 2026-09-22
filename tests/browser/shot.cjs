const { execFileSync } = require('node:child_process');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const url = require('node:url');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find(fs.existsSync);
const [w, h] = (process.argv[2] || '1600x800').split('x').map(Number);
const out = path.join(__dirname, process.argv[3] || 'shot.png');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-shot-'));
execFileSync(CHROME, ['--headless=new','--disable-gpu','--no-sandbox','--force-device-scale-factor=1',
  `--user-data-dir=${profile}`, `--window-size=${w},${h+152}`, '--virtual-time-budget=6000',
  `--screenshot=${out}`, url.pathToFileURL(path.join(__dirname,'editor-harness.html')).href],
  { stdio: 'pipe', maxBuffer: 64*1024*1024 });
fs.rmSync(profile, { recursive: true, force: true });
console.log('wrote', out);
