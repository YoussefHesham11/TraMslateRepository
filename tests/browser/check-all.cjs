// Runs every browser-based check in order, rebuilding the harness first.
//
//     node tests/browser/check-all.cjs            # harness checks only
//     node tests/browser/check-all.cjs --app      # also tour the running app
//
// The app tour needs the application listening on http://127.0.0.1:5199 and a
// reachable database; the other checks need neither. The waveform check
// serves the repo over a throwaway HTTP port of its own, because fetch()
// cannot read the sample media over file:// and so the audio side of the
// timeline is invisible to every other check here.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const withApp = process.argv.includes('--app');
const here = __dirname;

const steps = [
    ['Build the harness from the real view and scripts', 'build-harness.cjs', []],
    ['Layout across window sizes', 'layout-check.cjs', []],
    ['Editor workflow', 'workflow-check.cjs', []],
    ["The revisor's seat", 'revisor-check.cjs', []],
    ['Performance with a feature-length track', 'perf.cjs', ['1500']],
    ['The waveform, its controls and its timing actions', 'waveform-check.cjs', []],
];
if (withApp) {
    steps.push(['Live application tour', 'app-tour.cjs', []]);
    steps.push(['Live review round trip', 'review-tour.cjs', []]);
    steps.push(['Live project settings and account', 'settings-tour.cjs', []]);
}

let failed = 0;
for (const [title, script, args] of steps) {
    process.stdout.write(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}\n`);
    try {
        execFileSync(process.execPath, [path.join(here, script), ...args], { stdio: 'inherit' });
    } catch {
        failed++;
        console.error(`   ^ ${script} failed`);
    }
}

console.log('');
if (failed) { console.error(`${failed} check(s) failed.`); process.exit(1); }
console.log('All browser checks passed.');
