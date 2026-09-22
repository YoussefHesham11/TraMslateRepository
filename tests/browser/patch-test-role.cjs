// The editor now branches on role constants the page supplies, so the stub
// has to supply them too — otherwise the tests only ever exercise the rows,
// never the open card.
const fs = require('fs');
const p = 'tests/editor-state.test.cjs';
let s = fs.readFileSync(p, 'utf8');
let ok = true;

function swap(from, to, label) {
    const i = s.indexOf(from);
    if (i < 0) { console.error('MISS: ' + label); ok = false; return; }
    if (s.indexOf(from, i + 1) >= 0) { console.error('AMBIGUOUS: ' + label); ok = false; return; }
    s = s.slice(0, i) + to + s.slice(i + from.length);
    console.log('ok   ' + label);
}

swap(
    'function setup({ store = {} } = {}) {',
    "function setup({ store = {}, role = 'Translator' } = {}) {",
    'setup takes a role');

swap(
    '        SubtitleCore: core, PROJECT_ID: 1, console, URL, URLSearchParams, Blob,',
    `        SubtitleCore: core, PROJECT_ID: 1, console, URL, URLSearchParams, Blob,
        // The editor branches on these. The default seats the stub as the
        // translator; the review tests pass role: 'Revisor'.
        USER_ROLE: role,
        CAN_EDIT_TRANSLATION: role === 'Translator',
        CAN_REVIEW: role === 'Revisor',`,
    'role constants in the context');

if (!ok) { console.error('ABORT'); process.exit(1); }
fs.writeFileSync(p, s);
console.log('patched');
