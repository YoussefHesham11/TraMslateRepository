const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../wwwroot/js/subtitle-core.js');

test('timestamps carry rounded milliseconds into the next minute', () => {
    assert.equal(core.timestamp(59.9999), '00:01:00,000');
    assert.equal(core.timestamp(3599.9999), '01:00:00,000');
    assert.equal(core.seconds('01:02:03,456'), 3723.456);
    assert.ok(Number.isNaN(core.seconds('00:75:03,000')));
    assert.ok(Number.isNaN(core.seconds('garbage')));
});
test('SRT handles BOM, Windows line endings, multilingual text and numeric dialogue', () => {
    const cues = core.parse('\uFEFF1\r\n00:00:01,000 --> 00:00:03,000\r\nمرحبا\r\n123\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,000\r\nBonjour');
    assert.equal(cues.length, 2);
    assert.equal(cues[0].originalText, 'مرحبا\n123');
});
test('VTT handles cue identifiers, short timestamps, settings and metadata', () => {
    const cues = core.parse('WEBVTT\n\nNOTE example\nignored\n\nchapter-one\n00:01.000 --> 00:03.000 align:start\n123\n\n00:04.000 --> 00:06.000\nHello');
    assert.equal(cues.length, 2);
    assert.equal(cues[0].startTime, '00:00:01,000');
    assert.equal(cues[0].endTime, '00:00:03,000');
    assert.equal(cues[0].originalText, '123');
});
test('invalid and reversed imported timings are rejected', () => {
    assert.throws(() => core.parse('1\ninvalid --> 00:00:03,000\nTest'));
    assert.throws(() => core.parse('1\n00:00:05,000 --> 00:00:03,000\nTest'));
    assert.throws(() => core.parse('1\n23:59:59,000 --> 24:00:01,000\nTest'));
});
test('quality review detects overlap but allows adjacent boundaries', () => {
    const a = { startTime:'00:00:01,000', endTime:'00:00:03,000', translatedText:'Hello' };
    const b = { startTime:'00:00:03,000', endTime:'00:00:05,000', translatedText:'World' };
    assert.deepEqual(core.issues(a, [a,b]), []);
    b.startTime = '00:00:02,000';
    assert.ok(core.issues(a, [a,b]).includes('Overlapping cues'));
});
test('quality review warns on a too-short gap but not when cues touch exactly or have room to breathe', () => {
    const a = { startTime:'00:00:01,000', endTime:'00:00:03,000', translatedText:'Hello' };
    const touching = { startTime:'00:00:03,000', endTime:'00:00:05,000', translatedText:'World' };
    assert.ok(!core.issues(a, [a, touching]).includes('Short gap'));
    const tooClose = { startTime:'00:00:03,030', endTime:'00:00:05,000', translatedText:'World' };
    assert.ok(core.issues(a, [a, tooClose]).includes('Short gap'));
    const roomy = { startTime:'00:00:03,500', endTime:'00:00:05,000', translatedText:'World' };
    assert.ok(!core.issues(a, [a, roomy]).includes('Short gap'));
});
test('quality review catches missing translation, excess lines and reading speed', () => {
    const cue = { startTime:'00:00:01,000', endTime:'00:00:02,000', translatedText:'' };
    assert.ok(core.issues(cue, []).includes('Untranslated'));
    cue.translatedText = 'x'.repeat(43) + '\nsecond\nthird';
    assert.deepEqual(core.issues(cue, []), ['Fast reading speed', 'Long line', 'More than 2 lines']);
});
test('splitCue divides timing and text at the split point, preferring a word boundary', () => {
    const cue = { startTime:'00:00:00,000', endTime:'00:00:10,000', originalText:'Hello there world', translatedText:'Bonjour le monde' };
    const [a, b] = core.splitCue(cue, 5);
    assert.equal(a.startTime, '00:00:00,000');
    assert.equal(a.endTime, '00:00:05,000');
    assert.equal(b.startTime, '00:00:05,000');
    assert.equal(b.endTime, '00:00:10,000');
    assert.equal(a.originalText + ' ' + b.originalText, 'Hello there world');
    assert.equal(a.translatedText + ' ' + b.translatedText, 'Bonjour le monde');
});
test('splitCue rejects a split point outside the cue or invalid timing', () => {
    const cue = { startTime:'00:00:00,000', endTime:'00:00:10,000', originalText:'x' };
    assert.throws(() => core.splitCue(cue, 0));
    assert.throws(() => core.splitCue(cue, 10));
    assert.throws(() => core.splitCue(cue, 15));
    assert.throws(() => core.splitCue({ startTime:'bad', endTime:'00:00:10,000' }, 5));
});
test('mergeCues spans both cues and joins non-empty text with a newline', () => {
    const a = { startTime:'00:00:01,000', endTime:'00:00:03,000', originalText:'Hello', translatedText:'' };
    const b = { startTime:'00:00:03,000', endTime:'00:00:05,000', originalText:'world', translatedText:'Monde' };
    const merged = core.mergeCues(a, b);
    assert.equal(merged.startTime, '00:00:01,000');
    assert.equal(merged.endTime, '00:00:05,000');
    assert.equal(merged.originalText, 'Hello\nworld');
    assert.equal(merged.translatedText, 'Monde');
});
test('parseTimedScript groups a spotting-list block (number, in/out frame timecode, count, text) into one cue per entry', () => {
    const doc = [
        '0001 01:00:18:18 01:00:20:04 29', '', "So let's do it.", '',
        '0002 01:00:20:14 01:00:21:19 24', '', "I'll uplift it a bit.", '',
        '0011 01:00:41:22 01:00:45:21 79', '', 'Yeah, I think we will leave it', "like this, it's better. Stay still.", '',
        '0012 01:01:04:05 01:01:05:21 33', '', 'Will you tell him?'
    ].join('\n');
    const cues = core.parseTimedScript(doc, 25);
    assert.equal(cues.length, 4);
    assert.equal(cues[0].originalText, "So let's do it.");
    assert.equal(cues[0].translatedText, '');
    assert.equal(cues[0].startTime, '01:00:18,720');
    assert.equal(cues[0].endTime, '01:00:20,160');
    assert.equal(cues[2].originalText, "Yeah, I think we will leave it\nlike this, it's better. Stay still.");
    assert.equal(cues[3].originalText, 'Will you tell him?');
});
test('parseTimedScript returns no cues for plain, unstructured text so callers fall back', () => {
    assert.deepEqual(core.parseTimedScript('Just a paragraph.\nAnother line.', 25), []);
});
test('framesToSeconds converts HH:MM:SS:FF at the given fps and rejects an out-of-range frame', () => {
    assert.equal(core.framesToSeconds('01:00:18:18', 25), 3618.72);
    assert.ok(Number.isNaN(core.framesToSeconds('01:00:18:25', 25)));
    assert.ok(Number.isNaN(core.framesToSeconds('garbage', 25)));
});
test('cuesFromLines turns untimed script lines into sequential, non-overlapping cues', () => {
    const cues = core.cuesFromLines(['Hello there.', '', '  ', 'A much longer line of dialogue that should take noticeably longer to read aloud.']);
    assert.equal(cues.length, 2);
    assert.equal(cues[0].startTime, '00:00:00,000');
    assert.equal(cues[0].originalText, 'Hello there.');
    assert.equal(cues[0].translatedText, '');
    assert.ok(core.seconds(cues[1].startTime) > core.seconds(cues[0].endTime));
    assert.ok(core.seconds(cues[1].endTime) - core.seconds(cues[1].startTime) > core.seconds(cues[0].endTime) - core.seconds(cues[0].startTime));
});
test('parseShiftAmount reads timecodes, short forms, plain seconds, and signs', () => {
    assert.equal(core.parseShiftAmount('00:00:01:12', 25), 1.48);
    assert.equal(core.parseShiftAmount('-00:00:01:12', 25), -1.48);
    assert.equal(core.parseShiftAmount('01:30', 25), 90);
    assert.equal(core.parseShiftAmount('00:01:30', 25), 90);
    assert.equal(core.parseShiftAmount('5', 25), 5);
    assert.equal(core.parseShiftAmount('-1.5', 25), -1.5);
    assert.equal(core.parseShiftAmount('+2', 25), 2);
    assert.ok(Number.isNaN(core.parseShiftAmount('', 25)));
    assert.ok(Number.isNaN(core.parseShiftAmount('garbage', 25)));
    assert.ok(Number.isNaN(core.parseShiftAmount('00:00:01:30', 25)));
});
test('clampShiftOffset trims a shift to the farthest safe point instead of overshooting past zero or 24 hours', () => {
    const cues = [
        { startTime: '01:00:33,840', endTime: '01:00:35,600' },
        { startTime: '01:00:40,000', endTime: '01:00:42,000' }
    ];
    assert.equal(core.clampShiftOffset(cues, -99999), -core.seconds('01:00:33,840'));
    assert.equal(core.clampShiftOffset(cues, -5), -5);
    assert.equal(core.clampShiftOffset(cues, 99999), 86400 - 0.001 - core.seconds('01:00:42,000'));
    assert.equal(core.clampShiftOffset(cues, 0), 0);
    assert.equal(core.clampShiftOffset([], -5), -5);
});
test('shift moves both timestamps and rejects a shift before zero or past 24 hours', () => {
    const cue = { startTime:'00:00:10,000', endTime:'00:00:12,000' };
    assert.deepEqual(core.shift(cue, 5), { ...cue, startTime:'00:00:15,000', endTime:'00:00:17,000' });
    assert.deepEqual(core.shift(cue, -5), { ...cue, startTime:'00:00:05,000', endTime:'00:00:07,000' });
    assert.throws(() => core.shift(cue, -11));
    assert.throws(() => core.shift({ startTime:'23:59:59,000', endTime:'23:59:59,500' }, 1));
});
