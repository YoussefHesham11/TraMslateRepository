// Threads the revision column through the editor's rendering, filtering and
// role handling, then appends the revision module itself.
const fs = require('fs');
const p = 'wwwroot/js/editor.js';
let s = fs.readFileSync(p, 'utf8');
const module_ = fs.readFileSync('tests/browser/review-ui.js', 'utf8').trimEnd();
let ok = true;

function swap(from, to, label) {
    const i = s.indexOf(from);
    if (i < 0) { console.error('MISS: ' + label); ok = false; return; }
    if (s.indexOf(from, i + 1) >= 0) { console.error('AMBIGUOUS: ' + label); ok = false; return; }
    s = s.slice(0, i) + to + s.slice(i + from.length);
    console.log('ok   ' + label);
}

// ── Filters for review state ──
swap(
`        && (!filter.startsWith('status-') || (ev.status || 0) === Number(filter.slice(7)));`,
`        && (!filter.startsWith('status-') || (ev.status || 0) === Number(filter.slice(7)))
        && (filter !== 'suggested' || hasSuggestion(ev))
        && (filter !== 'flagged' || isFlagged(ev));`,
    'filter by suggestion and flag');

// ── Row markers ──
swap(
`    const marks    = statusChip(ev)
                   + (ev.comment?.trim() ? '<i class="bi bi-chat-left-text-fill" title="Has a comment"></i>' : '')
                   + (isLocked ? '<i class="bi bi-lock-fill" title="Locked"></i>' : '');`,
`    const marks    = reviewChips(ev)
                   + statusChip(ev)
                   + (ev.comment?.trim() ? '<i class="bi bi-chat-left-text-fill" title="Has a comment"></i>' : '')
                   + (isLocked ? '<i class="bi bi-lock-fill" title="Locked"></i>' : '');`,
    'rows carry review markers');

swap(
`// Draft is the default and would be noise on every row, so it shows nothing.
function statusChip(ev) {`,
`// A row shows that a revisor touched it without opening: a lamp for a
// suggestion still to be decided, a flag for a problem they raised.
function reviewChips(ev) {
    let out = '';
    if (hasSuggestion(ev)) {
        const state = ev.suggestionState || 0;
        const title = state === 2 ? 'Suggestion applied'
                    : state === 3 ? 'Suggestion dismissed'
                    : 'Suggestion waiting for you';
        out += '<i class="bi bi-lightbulb-fill tm-cue-suggestion tm-cue-suggestion-'
             + state + '" title="' + title + '"></i>';
    }
    if (isFlagged(ev)) {
        const severity = ['none', 'minor', 'major', 'critical'][ev.reviewSeverity || 0];
        out += '<i class="bi bi-flag-fill tm-cue-flagmark tm-severity-'
             + severity + '" title="Flagged by the revisor"></i>';
    }
    return out;
}

// Draft is the default and would be noise on every row, so it shows nothing.
function statusChip(ev) {`,
    'review chips');

// ── The open card gains a third column ──
swap(
`            <textarea dir="auto" aria-label="Cue \${i + 1} translation" class="tm-translated-input \${charCountClass(ev.translatedText || '')}"
                      placeholder="Type your translation here…"
                      data-field="translatedText" data-id="\${ev.id}" \${dis}>\${escapeHtml(ev.translatedText || '')}</textarea>
        </div>
    </div>`,
`            <textarea dir="auto" aria-label="Cue \${i + 1} translation" class="tm-translated-input \${charCountClass(ev.translatedText || '')}"
                      placeholder="\${CAN_EDIT_TRANSLATION ? 'Type your translation here…' : 'The translator\\'s line — suggest a change in the next column.'}"
                      data-field="translatedText" data-id="\${ev.id}" \${dis}\${CAN_EDIT_TRANSLATION ? '' : ' readonly'}>\${escapeHtml(ev.translatedText || '')}</textarea>
        </div>
        \${suggestionColumnHtml(ev, i)}
    </div>`,
    'suggestion column in the card');

// The translator's own controls do not belong to a revisor.
swap(
`        <select class="tm-cue-status-select tm-cue-status-select-\${ev.status || 0}" data-field="status" data-id="\${ev.id}"
                aria-label="Cue \${i + 1} status" title="Where this line stands in your workflow">
            \${CUE_STATUS.map(s => \`<option value="\${s.value}"\${(ev.status || 0) === s.value ? ' selected' : ''}>\${s.label}</option>\`).join('')}
        </select>`,
`        \${CAN_EDIT_TRANSLATION ? \`<select class="tm-cue-status-select tm-cue-status-select-\${ev.status || 0}" data-field="status" data-id="\${ev.id}"
                aria-label="Cue \${i + 1} status" title="Where this line stands in your workflow">
            \${CUE_STATUS.map(s => \`<option value="\${s.value}"\${(ev.status || 0) === s.value ? ' selected' : ''}>\${s.label}</option>\`).join('')}
        </select>\` : ''}`,
    'status select is the translator’s');

swap(
`        <button class="tm-icon-btn-sm tm-delete-btn" data-id="\${ev.id}" title="Delete line" \${dis}><i class="bi bi-trash3"></i></button>`,
`        \${CAN_EDIT_TRANSLATION ? \`<button class="tm-icon-btn-sm tm-delete-btn" data-id="\${ev.id}" title="Delete line" \${dis}><i class="bi bi-trash3"></i></button>\` : ''}`,
    'delete is the translator’s');

// ── Suggestion and review fields are edits like any other ──
swap(
`    if (field === 'status') {`,
`    if (field === 'suggestedText') {
        const counter = card?.querySelector('.tm-col-label-suggestion .tm-char-counter');
        if (counter) counter.textContent = charCountDisplay(e.target.value);
        e.target.className = \`tm-suggested-input \${charCountClass(e.target.value)}\`;
        fitOpenCard();
    }
    if (field === 'reviewFlag' || field === 'reviewSeverity') {
        ev[field] = Number(e.target.value) || 0;
    }
    if (field === 'status') {`,
    'suggestion and flag edits');

// ── Keep the toggle's badge current ──
swap(
`    const count = document.getElementById('cueCount');`,
`    paintSuggestionsToggle();
    const count = document.getElementById('cueCount');`,
    'toggle badge follows the data');

// ── The module itself, before the safety section that INIT depends on ──
swap(
`// ══════════════════════════════════════════════════
//  SAFETY — crash recovery, other tabs, stale saves`,
module_ + `

// ══════════════════════════════════════════════════
//  SAFETY — crash recovery, other tabs, stale saves`,
    'revision module inserted');

if (!ok) { console.error('ABORT'); process.exit(1); }
fs.writeFileSync(p, s);
console.log('patched');
