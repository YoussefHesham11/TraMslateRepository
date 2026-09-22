// ══════════════════════════════════════════════════
//  REVISION — suggestions, flags and the review round
// ══════════════════════════════════════════════════
// A revisor works in the same editor as the translator, because judging a
// line needs the same video, timeline and reading-speed figures. What differs
// is which column they type into.
//
// The translator's wording is never overwritten. A revisor proposes a
// replacement; the translator accepts it, in which case their own line is kept
// so Revert can put it back, or dismisses it, which is recorded as an answer
// rather than a deletion.

const IS_REVISOR = typeof CAN_REVIEW !== 'undefined' && CAN_REVIEW;

// Which error a flagged line has. These are the categories used in
// language-quality review, so a report says what kind of trouble a
// translation is in rather than just how much.
const REVIEW_FLAGS = [
    { value: 0, label: 'No flag' },
    { value: 1, label: 'Mistranslation' },
    { value: 2, label: 'Omission' },
    { value: 3, label: 'Addition' },
    { value: 4, label: 'Terminology' },
    { value: 5, label: 'Style / register' },
    { value: 6, label: 'Grammar / spelling' },
    { value: 7, label: 'Timing' },
    { value: 8, label: 'Reading speed' },
    { value: 9, label: 'Line breaks' },
];

const REVIEW_SEVERITY = [
    { value: 0, label: 'Severity' },
    { value: 1, label: 'Minor' },
    { value: 2, label: 'Major' },
    { value: 3, label: 'Critical' },
];

// SuggestionState on the server: 0 none, 1 pending, 2 accepted, 3 dismissed.
const SUGGESTION = { NONE: 0, PENDING: 1, ACCEPTED: 2, DISMISSED: 3 };

const hasSuggestion = ev => !!(ev.suggestedText && ev.suggestedText.trim());
const isFlagged     = ev => (ev.reviewFlag || 0) !== 0;

// The translator hides the column until they want it; a revisor is always
// working in it, so for them it is simply on.
const SUGGESTIONS_KEY = `tm-suggestions-${PROJECT_ID}`;
let showSuggestions = IS_REVISOR || (() => {
    try { return localStorage.getItem(SUGGESTIONS_KEY) === '1'; }
    catch { return false; }
})();

function suggestionSummary() {
    let pending = 0, flagged = 0, total = 0;
    for (const ev of events) {
        if (hasSuggestion(ev)) {
            total++;
            if ((ev.suggestionState || 0) === SUGGESTION.PENDING) pending++;
        }
        if (isFlagged(ev)) flagged++;
    }
    return { pending, flagged, total };
}

function paintSuggestionsToggle() {
    const button = document.getElementById('btnToggleSuggestions');
    if (!button) return;
    const { pending, total } = suggestionSummary();

    button.setAttribute('aria-pressed', String(showSuggestions));
    button.classList.toggle('tm-suggestions-on', showSuggestions);
    button.title = showSuggestions
        ? "Hide the revisor's suggestions"
        : total
            ? `Show the revisor's suggestions (${pending} still to decide)`
            : "Show the revisor's suggestions — none yet";

    const badge = document.getElementById('suggestionCount');
    if (badge) {
        badge.hidden = pending === 0;
        badge.textContent = pending;
    }
}

function setSuggestionsVisible(visible) {
    showSuggestions = visible;
    try { localStorage.setItem(SUGGESTIONS_KEY, visible ? '1' : '0'); }
    catch { /* storage unavailable; the choice just will not persist */ }
    document.querySelector('.tm-editor-right')?.classList.toggle('tm-show-suggestions', visible);
    paintSuggestionsToggle();
    // The column changes the card's width and height, so it has to be redrawn
    // and re-fitted rather than merely revealed.
    renderEvents();
}

// ── The suggestion column inside the open card ────

function flagBadgeHtml(ev) {
    if (!isFlagged(ev)) return '';
    const flag = REVIEW_FLAGS.find(f => f.value === ev.reviewFlag);
    const severity = REVIEW_SEVERITY.find(s => s.value === (ev.reviewSeverity || 0));
    const label = flag ? flag.label : 'Flagged';
    const sev = severity && severity.value ? severity.label : '';
    return `<span class="tm-review-flag tm-severity-${(sev || 'none').toLowerCase()}">
        <i class="bi bi-flag-fill"></i> ${escapeHtml(label)}${sev ? ` · ${escapeHtml(sev)}` : ''}
    </span>`;
}

function reviewNoteHtml(ev) {
    if (!ev.reviewNote || !ev.reviewNote.trim()) return '';
    return `<p class="tm-review-note" dir="auto"><i class="bi bi-chat-quote"></i> ${escapeHtml(ev.reviewNote)}</p>`;
}

// What the revisor sees: an editable box that starts from the current
// translation, so they correct a real line instead of writing into a blank.
// Only a box that ends up different from the translation is stored.
function revisorColumnHtml(ev, i) {
    const draft = ev.suggestedText != null && ev.suggestedText !== ''
        ? ev.suggestedText
        : (ev.translatedText || '');
    return `<div class="tm-event-col tm-event-col-suggestion tm-event-col-editing">
        <div class="tm-col-label tm-col-label-suggestion">
            <span><i class="bi bi-lightbulb-fill"></i> Your suggestion</span>
            <span class="tm-char-counter">${charCountDisplay(draft)}</span>
        </div>
        <textarea dir="auto" aria-label="Suggested translation for cue ${i + 1}"
                  class="tm-suggested-input ${charCountClass(draft)}"
                  placeholder="Edit the line to propose a change. Leave it as it is to suggest nothing."
                  data-field="suggestedText" data-id="${ev.id}">${escapeHtml(draft)}</textarea>
        <div class="tm-review-controls">
            <select class="tm-review-flag-select" data-field="reviewFlag" data-id="${ev.id}"
                    aria-label="What is wrong with cue ${i + 1}">
                ${REVIEW_FLAGS.map(f => `<option value="${f.value}"${(ev.reviewFlag || 0) === f.value ? ' selected' : ''}>${f.label}</option>`).join('')}
            </select>
            <select class="tm-review-severity-select" data-field="reviewSeverity" data-id="${ev.id}"
                    aria-label="How serious the problem on cue ${i + 1} is">
                ${REVIEW_SEVERITY.map(s => `<option value="${s.value}"${(ev.reviewSeverity || 0) === s.value ? ' selected' : ''}>${s.label}</option>`).join('')}
            </select>
        </div>
        <textarea dir="auto" aria-label="Note to the translator about cue ${i + 1}"
                  class="tm-review-note-input" placeholder="Why — a note the translator will read…"
                  data-field="reviewNote" data-id="${ev.id}">${escapeHtml(ev.reviewNote || '')}</textarea>
    </div>`;
}

// What the translator sees: empty when nothing was suggested, otherwise the
// revisor's line with a way to take it or keep their own.
function translatorSuggestionColumnHtml(ev, i) {
    const state = ev.suggestionState || 0;
    const suggestion = ev.suggestedText || '';
    const flagged = isFlagged(ev);

    if (!hasSuggestion(ev) && !flagged) {
        return `<div class="tm-event-col tm-event-col-suggestion tm-event-col-empty">
            <div class="tm-col-label tm-col-label-suggestion"><span><i class="bi bi-lightbulb"></i> Revisor</span></div>
            <p class="tm-suggestion-none">No suggestion for this line.</p>
        </div>`;
    }

    let actions = '';
    let stateChip = '';
    if (hasSuggestion(ev)) {
        if (state === SUGGESTION.ACCEPTED) {
            stateChip = '<span class="tm-suggestion-state tm-suggestion-accepted"><i class="bi bi-check-lg"></i> Applied</span>';
            actions = `<button class="tm-btn-sm tm-suggestion-revert" data-id="${ev.id}"
                        title="Put your own line back">Revert to mine</button>`;
        } else if (state === SUGGESTION.DISMISSED) {
            stateChip = '<span class="tm-suggestion-state tm-suggestion-dismissed"><i class="bi bi-x-lg"></i> Kept mine</span>';
            actions = `<button class="tm-btn-sm tm-suggestion-accept" data-id="${ev.id}">Use it after all</button>`;
        } else {
            actions = `<button class="tm-btn-sm tm-btn-sm-primary tm-suggestion-accept" data-id="${ev.id}">
                    <i class="bi bi-check-lg"></i> Accept
                </button>
                <button class="tm-btn-sm tm-suggestion-dismiss" data-id="${ev.id}">
                    <i class="bi bi-x-lg"></i> Keep mine
                </button>`;
        }
    }

    return `<div class="tm-event-col tm-event-col-suggestion${state === SUGGESTION.PENDING ? ' tm-event-col-pending' : ''}">
        <div class="tm-col-label tm-col-label-suggestion">
            <span><i class="bi bi-lightbulb-fill"></i> Revisor</span>
            ${stateChip}
        </div>
        ${hasSuggestion(ev)
            ? `<p class="tm-suggestion-text" dir="auto">${escapeHtml(suggestion)}</p>`
            : '<p class="tm-suggestion-none">Flagged, with no replacement proposed.</p>'}
        ${flagBadgeHtml(ev)}
        ${reviewNoteHtml(ev)}
        ${actions ? `<div class="tm-suggestion-actions">${actions}</div>` : ''}
    </div>`;
}

function suggestionColumnHtml(ev, i) {
    if (!showSuggestions) return '';
    return IS_REVISOR ? revisorColumnHtml(ev, i) : translatorSuggestionColumnHtml(ev, i);
}

// ── Acting on a suggestion ────────────────────────

function applySuggestion(id) {
    const ev = events.find(x => x.id === id);
    if (!ev || !hasSuggestion(ev)) return;
    // Keep what the translator wrote, so Revert is always possible — but only
    // the first time, or accepting twice would overwrite the original with the
    // revisor's own line.
    if ((ev.suggestionState || 0) !== SUGGESTION.ACCEPTED) {
        ev.previousTranslatedText = ev.translatedText || '';
    }
    ev.translatedText = ev.suggestedText;
    ev.suggestionState = SUGGESTION.ACCEPTED;
    afterSuggestionDecision(id);
}

function revertSuggestion(id) {
    const ev = events.find(x => x.id === id);
    if (!ev) return;
    if (ev.previousTranslatedText != null) ev.translatedText = ev.previousTranslatedText;
    ev.previousTranslatedText = null;
    // Back to undecided rather than dismissed: reverting says "not yet",
    // dismissing says "no".
    ev.suggestionState = hasSuggestion(ev) ? SUGGESTION.PENDING : SUGGESTION.NONE;
    afterSuggestionDecision(id);
}

function dismissSuggestion(id) {
    const ev = events.find(x => x.id === id);
    if (!ev) return;
    ev.suggestionState = SUGGESTION.DISMISSED;
    afterSuggestionDecision(id);
}

function afterSuggestionDecision(id) {
    markDirty();
    refreshCue(id, { keepCaret: false });
    updateSelection();
    fitOpenCard();
    renderTimelineBlocks();
    updateWorkspace();
    updateOverlay();
}

// Accepting every outstanding suggestion at once, for a translator who has
// read the report and agrees with it.
function acceptAllSuggestions() {
    const pending = events.filter(ev => hasSuggestion(ev) && (ev.suggestionState || 0) === SUGGESTION.PENDING);
    if (!pending.length) { alert('There are no suggestions waiting for a decision.'); return; }
    if (!confirm(`Apply all ${pending.length} outstanding suggestion${pending.length === 1 ? '' : 's'}? `
               + 'Your own wording is kept for each line, so you can still revert any of them.')) return;
    for (const ev of pending) {
        ev.previousTranslatedText = ev.translatedText || '';
        ev.translatedText = ev.suggestedText;
        ev.suggestionState = SUGGESTION.ACCEPTED;
    }
    markDirty();
    renderEvents();
    renderTimelineBlocks();
    updateOverlay();
}

// ── Wiring ────────────────────────────────────────

document.getElementById('btnToggleSuggestions')?.addEventListener('click', () => {
    setSuggestionsVisible(!showSuggestions);
});

eventsList.addEventListener('click', e => {
    const accept = e.target.closest('.tm-suggestion-accept');
    if (accept) { e.stopPropagation(); applySuggestion(Number(accept.dataset.id)); return; }
    const dismiss = e.target.closest('.tm-suggestion-dismiss');
    if (dismiss) { e.stopPropagation(); dismissSuggestion(Number(dismiss.dataset.id)); return; }
    const revert = e.target.closest('.tm-suggestion-revert');
    if (revert) { e.stopPropagation(); revertSuggestion(Number(revert.dataset.id)); return; }
}, true);

// ── The review round dialog ───────────────────────

const reviewModal = document.getElementById('reviewModal');

document.getElementById('btnFinishReview')?.addEventListener('click', async () => {
    // The round is filed against what is stored, so anything unsaved has to
    // land first or the report would describe the wrong thing.
    if (isDirty) await doSave();
    const { pending, flagged, total } = suggestionSummary();
    const stats = document.getElementById('reviewStats');
    if (stats) {
        stats.textContent = `${events.length} lines · ${total} suggestion${total === 1 ? '' : 's'} · ${flagged} flagged`;
    }
    reviewModal.style.display = 'flex';
    document.getElementById('reviewNotes')?.focus();
});

document.getElementById('cancelReview')?.addEventListener('click', () => {
    reviewModal.style.display = 'none';
});

reviewModal?.addEventListener('click', e => {
    if (e.target === reviewModal) reviewModal.style.display = 'none';
});

document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && reviewModal && reviewModal.style.display === 'flex') {
        reviewModal.style.display = 'none';
    }
});

// The revisor is always in the column; the translator's last choice is
// restored on load.
document.querySelector('.tm-editor-right')?.classList.toggle('tm-show-suggestions', showSuggestions);
if (IS_REVISOR) document.querySelector('.tm-editor-right')?.classList.add('tm-revisor-mode');
