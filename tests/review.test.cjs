// The revision workflow as the editor runs it: a revisor proposes a
// replacement, the translator decides, and the translator's own wording
// survives every path through that.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup, settle, ok } = require('./harness.cjs');

const cue = (over = {}) => ({
    id: 1, index: 1,
    startTime: '00:00:01,000', endTime: '00:00:03,000',
    originalText: "I'll leave the keys in the door.",
    translatedText: 'mine',
    suggestedText: null, suggestionState: 0, previousTranslatedText: null,
    reviewFlag: 0, reviewSeverity: 0, reviewNote: null,
    ...over,
});

async function loaded(cues, role = 'Translator') {
    const app = setup({ role });
    app.requests[0].resolve(ok({ revision: 1, role, events: cues }));
    await settle();
    return app;
}

// ── Accepting ─────────────────────────────────────

test('accepting a suggestion applies it and keeps the translator’s own line', async () => {
    const app = await loaded([cue({ suggestedText: 'theirs', suggestionState: 1 })]);

    app.run('applySuggestion(1)');
    assert.equal(app.run('events[0].translatedText'), 'theirs');
    assert.equal(app.run('events[0].previousTranslatedText'), 'mine', 'the original must be kept for Revert');
    assert.equal(app.run('events[0].suggestionState'), 2);
    assert.equal(app.run('isDirty'), true);
});

test('reverting puts the translator’s line back and leaves the suggestion undecided', async () => {
    const app = await loaded([cue({ suggestedText: 'theirs', suggestionState: 1 })]);

    app.run('applySuggestion(1)');
    app.run('revertSuggestion(1)');
    assert.equal(app.run('events[0].translatedText'), 'mine');
    assert.equal(app.run('events[0].previousTranslatedText'), null);
    // Undecided, not dismissed: reverting says "not yet", dismissing says "no".
    assert.equal(app.run('events[0].suggestionState'), 1);
});

test('accepting twice does not lose the original wording', async () => {
    const app = await loaded([cue({ suggestedText: 'theirs', suggestionState: 1 })]);

    app.run('applySuggestion(1)');
    app.run('applySuggestion(1)');
    assert.equal(app.run('events[0].previousTranslatedText'), 'mine',
        'a second accept must not overwrite the kept original with the revisor’s line');
    app.run('revertSuggestion(1)');
    assert.equal(app.run('events[0].translatedText'), 'mine');
});

test('dismissing records an answer without touching the translation', async () => {
    const app = await loaded([cue({ suggestedText: 'theirs', suggestionState: 1 })]);

    app.run('dismissSuggestion(1)');
    assert.equal(app.run('events[0].translatedText'), 'mine');
    assert.equal(app.run('events[0].suggestedText'), 'theirs', 'a dismissed suggestion stays readable');
    assert.equal(app.run('events[0].suggestionState'), 3);
});

test('a dismissed suggestion can still be taken later', async () => {
    const app = await loaded([cue({ suggestedText: 'theirs', suggestionState: 3 })]);

    app.run('applySuggestion(1)');
    assert.equal(app.run('events[0].translatedText'), 'theirs');
    assert.equal(app.run('events[0].previousTranslatedText'), 'mine');
});

test('accepting everything applies only the undecided suggestions', async () => {
    const app = await loaded([
        cue({ id: 1, suggestedText: 'a2', suggestionState: 1, translatedText: 'a1' }),
        cue({ id: 2, suggestedText: 'b2', suggestionState: 3, translatedText: 'b1' }),
        cue({ id: 3, suggestedText: null, suggestionState: 0, translatedText: 'c1' }),
    ]);

    app.run('acceptAllSuggestions()');
    assert.equal(app.run('events[0].translatedText'), 'a2', 'pending is applied');
    assert.equal(app.run('events[1].translatedText'), 'b1', 'an answered suggestion is left alone');
    assert.equal(app.run('events[2].translatedText'), 'c1', 'a line with no suggestion is untouched');
});

// ── Counting and filtering ────────────────────────

test('the toggle counts only suggestions still waiting for a decision', async () => {
    const app = await loaded([
        cue({ id: 1, suggestedText: 'x', suggestionState: 1 }),
        cue({ id: 2, suggestedText: 'y', suggestionState: 2 }),
        cue({ id: 3, suggestedText: 'z', suggestionState: 3 }),
        cue({ id: 4, reviewFlag: 4, reviewSeverity: 2 }),
    ]);

    const summary = app.run('suggestionSummary()');
    assert.equal(summary.pending, 1);
    assert.equal(summary.total, 3);
    assert.equal(summary.flagged, 1);
});

test('the cue filters can isolate suggested and flagged lines', async () => {
    const app = await loaded([
        cue({ id: 1, suggestedText: 'x', suggestionState: 1 }),
        cue({ id: 2, reviewFlag: 4 }),
        cue({ id: 3 }),
    ]);

    app.nodes.get('cueFilter').value = 'suggested';
    assert.deepEqual(app.run('visibleCues().map(([ev]) => ev.id)'), [1]);

    app.nodes.get('cueFilter').value = 'flagged';
    assert.deepEqual(app.run('visibleCues().map(([ev]) => ev.id)'), [2]);

    app.nodes.get('cueFilter').value = 'all';
    assert.deepEqual(app.run('visibleCues().map(([ev]) => ev.id)'), [1, 2, 3]);
});

// ── What travels to the server ────────────────────

test('a decision is carried to the server with the cue', async () => {
    const app = await loaded([cue({ suggestedText: 'theirs', suggestionState: 1 })]);

    app.run('applySuggestion(1); doSave();');
    const sent = app.body(1).events[0];
    assert.equal(sent.translatedText, 'theirs');
    assert.equal(sent.previousTranslatedText, 'mine');
    assert.equal(sent.suggestionState, 2);
});

test('a revisor’s flags and note travel with the cue', async () => {
    const app = await loaded([cue()], 'Revisor');

    app.run("events[0].suggestedText = 'theirs'; events[0].reviewFlag = 4; events[0].reviewSeverity = 2; events[0].reviewNote = 'wrong term'; markDirty(); doSave();");
    const sent = app.body(1).events[0];
    assert.equal(sent.suggestedText, 'theirs');
    assert.equal(sent.reviewFlag, 4);
    assert.equal(sent.reviewSeverity, 2);
    assert.equal(sent.reviewNote, 'wrong term');
});

// ── Role ──────────────────────────────────────────

test('the editor knows which seat it is in', async () => {
    const asTranslator = await loaded([cue()], 'Translator');
    assert.equal(asTranslator.run('IS_REVISOR'), false);

    const asRevisor = await loaded([cue()], 'Revisor');
    assert.equal(asRevisor.run('IS_REVISOR'), true);
    // A revisor is always working in the column, so it is never hidden.
    assert.equal(asRevisor.run('showSuggestions'), true);
});

test('a line with no suggestion renders an empty revisor column, not a missing one', async () => {
    const app = await loaded([cue()]);
    app.run('setSuggestionsVisible(true)');
    const html = app.run('cueCardHtml(events[0], 0)');
    assert.match(html, /tm-event-col-suggestion/, 'the column is present');
    assert.match(html, /No suggestion for this line/, 'and says so plainly');
});

test('a suggested line offers Accept and Keep mine', async () => {
    const app = await loaded([cue({ suggestedText: 'theirs', suggestionState: 1 })]);
    app.run('setSuggestionsVisible(true)');
    const html = app.run('cueCardHtml(events[0], 0)');
    assert.match(html, /tm-suggestion-accept/);
    assert.match(html, /tm-suggestion-dismiss/);
    assert.match(html, /theirs/);
});

test('the column is absent until the translator asks for it', async () => {
    const app = await loaded([cue({ suggestedText: 'theirs', suggestionState: 1 })]);
    app.run('setSuggestionsVisible(false)');
    assert.doesNotMatch(app.run('cueCardHtml(events[0], 0)'), /tm-event-col-suggestion/);
    app.run('setSuggestionsVisible(true)');
    assert.match(app.run('cueCardHtml(events[0], 0)'), /tm-event-col-suggestion/);
});

test('the revisor column starts from the current translation, not from nothing', async () => {
    const app = await loaded([cue()], 'Revisor');
    const html = app.run('cueCardHtml(events[0], 0)');
    assert.match(html, /tm-suggested-input/);
    assert.match(html, />mine</, 'the box is pre-filled so a revisor corrects a real line');
    assert.match(html, /tm-review-flag-select/);
    assert.match(html, /tm-review-severity-select/);
});
