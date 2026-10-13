// The project validation rules: severities, waivers, acknowledgements, and the
// checks that must never be treated as more certain than they are.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../wwwroot/js/quality.js');

const cue = (i, over = {}) => ({
    id: i, startTime: `00:00:${String(i * 4).padStart(2, '0')},000`, endTime: `00:00:${String(i * 4 + 2).padStart(2, '0')},000`,
    originalText: 'Hello there.', translatedText: 'مرحبا.', ...over,
});
const codes = r => r.findings.filter(f => !f.waived).map(f => f.code);

test('a clean, translated track has nothing blocking', () => {
    const r = Q.validate([cue(1), cue(2), cue(3)]);
    assert.equal(r.counts.error, 0);
    assert.equal(r.blocking, 0);
});

test('structural timing errors are errors and cannot be waived', () => {
    const bad = cue(1, { endTime: '00:00:03,000', startTime: '00:00:05,000', waivers: [{ code: 'timing.invalid', reason: 'fine' }] });
    const r = Q.validate([bad]);
    const f = r.findings.find(x => x.code === 'timing.invalid');
    assert.equal(f.severity, 'error');
    assert.equal(f.waived, null);
    assert.equal(f.field, 'endTime');
    assert.ok(r.blocking > 0);
    // And an override cannot demote it either.
    const r2 = Q.validate([bad], { rules: { severity: { 'timing.invalid': 'off' } } });
    assert.ok(codes(r2).includes('timing.invalid'));
});

test('unreadable timecodes are reported against the right field', () => {
    const r = Q.validate([cue(1, { endTime: '99:99' })]);
    const f = r.findings.find(x => x.code === 'timing.malformed');
    assert.equal(f.field, 'endTime');
});

test('overlaps are errors unless the project allows them', () => {
    const track = [cue(1, { endTime: '00:00:09,000' }), cue(2)];
    assert.ok(codes(Q.validate(track)).includes('timing.overlap'));
    assert.ok(!codes(Q.validate(track, { rules: { allowOverlaps: true } })).includes('timing.overlap'));
});

test('an empty line is an error that can be waived with a reason, and only with a reason', () => {
    const empty = cue(1, { translatedText: '' });
    assert.ok(Q.validate([empty]).blocking > 0);
    const noReason = cue(1, { translatedText: '', waivers: [{ code: 'text.untranslated', reason: '  ' }] });
    assert.ok(Q.validate([noReason]).blocking > 0);
    const waived = cue(1, { translatedText: '', waivers: [{ code: 'text.untranslated', reason: 'Music cue' }] });
    const r = Q.validate([waived]);
    assert.equal(r.blocking, 0);
    assert.equal(r.findings[0].waived.reason, 'Music cue');
    // Projects that do not require every line translated do not flag it at all.
    assert.ok(!codes(Q.validate([empty], { rules: { requireTranslation: false } })).includes('text.untranslated'));
});

test('a translation identical to its source is only a suggestion — it may be a name', () => {
    const r = Q.validate([cue(1, { originalText: 'Ahmed', translatedText: 'Ahmed' })]);
    const f = r.findings.find(x => x.code === 'text.sameAsSource');
    assert.equal(f.severity, 'suggestion');
    assert.equal(r.blocking, 0);
});

test('warnings block Done according to the project rule', () => {
    const long = cue(1, { translatedText: 'This is a much longer line than forty-two characters allows here' });
    const ack = Q.validate([long]);
    assert.ok(ack.counts.warning > 0 && ack.blocking > 0, 'by default a warning must be acknowledged');
    const key = ack.findings.find(f => f.severity === 'warning').key;
    const acknowledged = Object.fromEntries(ack.findings.filter(f => f.severity === 'warning').map(f => [f.key, true]));
    assert.equal(Q.validate([long], { acknowledged }).blocking, 0);
    assert.equal(Q.validate([long], { rules: { warningsForDone: 'never' } }).blocking, 0);
    assert.ok(Q.validate([long], { acknowledged, rules: { warningsForDone: 'block' } }).blocking > 0);
    // Editing the line invalidates the acknowledgement.
    const edited = { ...long, translatedText: long.translatedText + ' more' };
    assert.ok(Q.validate([edited], { acknowledged }).blocking > 0);
    assert.ok(key.startsWith('text.'));
});

test('flags and open questions block Done and cannot be waived away', () => {
    const r = Q.validate([cue(1, { flags: 2, waivers: [{ code: 'flag.set', reason: 'x' }] }), cue(2, { flags: 8, comment: 'Is this a pun?' })]);
    assert.deepEqual(codes(r).filter(c => c === 'flag.set' || c === 'note.question'), ['flag.set', 'note.question']);
    assert.equal(r.counts.error, 2);
    const resolved = Q.validate([cue(2, { flags: 8, comment: 'Is this a pun?', commentResolved: true })]);
    assert.ok(!codes(resolved).includes('note.question'));
});

test('required review counts approved or reviewed lines as done', () => {
    const rules = { requireReview: true };
    assert.ok(codes(Q.validate([cue(1)], { rules })).includes('review.notReviewed'));
    assert.ok(!codes(Q.validate([cue(1, { reviewState: 1 })], { rules })).includes('review.notReviewed'));
    assert.ok(!codes(Q.validate([cue(1, { status: 3 })], { rules })).includes('review.notReviewed'));
    assert.ok(!codes(Q.validate([cue(1)])).includes('review.notReviewed'), 'off unless the project requires it');
});

test('limits come from the project profile', () => {
    const t = cue(1, { translatedText: 'Twenty-five characters ok' });
    assert.ok(!codes(Q.validate([t])).includes('text.lineLength'));
    assert.ok(codes(Q.validate([t], { profile: { maxCharsPerLine: 20 } })).includes('text.lineLength'));
});

test('subtitles past the end of the video are reported only when the duration is known', () => {
    const late = cue(1, { startTime: '00:01:00,000', endTime: '00:01:02,000' });
    assert.ok(codes(Q.validate([late], {}, { mediaDuration: 30 })).includes('timing.beyondMedia'));
    assert.ok(!codes(Q.validate([late], {}, {})).includes('timing.beyondMedia'));
});

test('tags: broken ones are caught, and formats that cannot keep them are named', () => {
    assert.deepEqual(Q.tagProblems('<i>hello'), ['<i> is never closed']);
    assert.deepEqual(Q.tagProblems('hello</b>'), ['</b> closes a tag that was never opened']);
    assert.deepEqual(Q.tagProblems('<i>fine</i> <b>ok</b>'), []);
    const font = cue(1, { translatedText: '<font color="red">مرحبا</font>' });
    assert.ok(!codes(Q.validate([font])).includes('text.unsupportedFormat'), 'SRT keeps <font>');
    assert.ok(codes(Q.validate([font], { rules: { exportFormat: 'vtt' } })).includes('text.unsupportedFormat'));
});

test('Arabic and mixed text: lengths count characters, repeated words work in any script', () => {
    assert.equal(Q.repeatedWord('قال قال لي'), 'قال');
    assert.equal(Q.repeatedWord('No. No. No.'), null, 'deliberate repetition with punctuation is left alone');
    assert.equal(Q.repeatedWord('the the cat'), 'the');
    const ar = cue(1, { translatedText: 'هذا سطر عربي مع English mixed in' });
    assert.ok(!codes(Q.validate([ar])).includes('text.lineLength'));
});

test('glossary mismatches are warnings, matched as whole words', () => {
    const glossary = [{ source: 'Bureau', target: 'المكتب' }];
    const miss = cue(1, { originalText: 'The Bureau knows.', translatedText: 'الإدارة تعرف.' });
    const hit = cue(2, { originalText: 'The Bureau knows.', translatedText: 'المكتب يعرف.' });
    const part = cue(3, { originalText: 'Bureaucracy.', translatedText: 'بيروقراطية.' });
    const r = Q.validate([miss, hit, part], { glossary });
    const g = r.findings.filter(f => f.code === 'text.glossary');
    assert.equal(g.length, 1);
    assert.equal(g[0].cueId, 1);
    assert.equal(g[0].severity, 'warning');
});

test('line-break suggestions only ever move whitespace', () => {
    const text = 'I told you we would be late if we did not leave before the rain started';
    const s = Q.suggestLineBreaks(text, 42, 2);
    assert.ok(s);
    assert.equal(s.split('\n').length, 2);
    assert.ok(s.split('\n').every(l => [...l].length <= 42));
    assert.equal(s.replace(/\s+/g, ''), text.replace(/\s+/g, ''));
    assert.equal(Q.suggestLineBreaks('x'.repeat(100), 42, 2), null, 'no layout fits a single 100-char word');
});

test('the "what remains" sentence names the blockers in plain words', () => {
    const r = Q.validate([cue(1, { translatedText: '' }), cue(2, { translatedText: '' }), cue(3, { translatedText: '' }),
                          cue(4, { endTime: '00:00:15,000' }), cue(5, { endTime: '00:00:19,000', startTime: '00:00:20,000' })]);
    const s = Q.remainingSummary(r, { unsaved: true });
    assert.match(s, /^3 untranslated subtitles, \d timing errors? and unsaved changes$/);
});

test('import problems are project-level warnings', () => {
    const r = Q.validate([cue(1)], { importIssues: [{ id: 'a', message: 'Entry 4 had no timecode and was skipped.' }] });
    const f = r.findings.find(x => x.code === 'project.import');
    assert.equal(f.cueId, null);
    assert.equal(f.severity, 'warning');
});

test('validating a feature-length track stays fast', () => {
    const track = [];
    for (let i = 0; i < 2000; i++) {
        const s = i * 3;
        const tc = x => `${String(Math.floor(x / 3600)).padStart(2, '0')}:${String(Math.floor(x / 60) % 60).padStart(2, '0')}:${String(x % 60).padStart(2, '0')},000`;
        track.push({ id: i + 1, startTime: tc(s), endTime: tc(s + 2), originalText: 'The Bureau said so.', translatedText: i % 7 ? 'قال المكتب ذلك.' : '' });
    }
    const t0 = process.hrtime.bigint();
    Q.validate(track, { glossary: [{ source: 'Bureau', target: 'المكتب' }] }, { mediaDuration: 7000 });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 250, `took ${ms.toFixed(0)} ms`);
});
