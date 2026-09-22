// Runs every browser-based check in order, rebuilding the harness first.
//
//     node tests/browser/check-all.cjs            # harness checks only
//     node tests/browser/check-all.cjs --app      # also tour the running app
//
// The app tour needs the application listening on http://127.0.0.1:5199 and a
// reachable database; the other checks need neither.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const withApp = process.argv.includes('--app');
const here = __dirname;

const steps = [
    ['Build the harness from the real view and scripts', 'build-harness.cjs', []],
    ['Layout across window sizes', 'layout-check.cjs', []],
    ['Editor workflow', 'workflow-check.cjs', []],
    ['Performance with a feature-length track', 'perf.cjs', ['1500']],
];
if (withApp) steps.push(['Live application tour', 'app-tour.cjs', []]);

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
