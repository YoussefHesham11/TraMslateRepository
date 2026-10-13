// Reading and writing subtitle files: lenient parsing that explains what it
// skipped, encodings, ASS, and exports that say what a format cannot keep.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../wwwroot/js/formats.js');
const Core = require('../wwwroot/js/subtitle-core.js');

test('an SRT entry is its number, its times and every text line together', () => {
    const r = F.parse('1\n00:00:01,000 --> 00:00:03,500\nFirst line\nSecond line\n\n2\n00:00:04,000 --> 00:00:05,000\nNext\n', 'a.srt');
    assert.equal(r.format, 'srt');
    assert.equal(r.cues.length, 2);
    assert.equal(r.cues[0].originalText, 'First line\nSecond line');
    assert.equal(r.cues[0].sourceNumber, '1');
    assert.equal(r.problems.length, 0);
});

test('malformed entries are reported, not fatal, and good ones survive', () => {
    const text = [
        '1', '00:00:01,000 --> 00:00:02,000', 'Fine', '',
        '2', '00:00:0X,000 --> 00:00:03,000', 'Bad time', '',
        'Orphan text with no timing', '',
        '4', '00:00:06,000 --> 00:00:05,000', 'Backwards', '',
        '5', '00:00:07,000 --> 00:00:08,000', '',
    ].join('\n');
    const r = F.parse(text, 'x.srt');
    assert.deepEqual(r.cues.map(c => c.originalText), ['Fine', 'Backwards', '']);
    assert.equal(r.problems.length, 4);
    assert.match(r.problems[3].message, /no text.*imported empty/);
    assert.match(r.problems[0].message, /could not be read.*skipped/);
    assert.match(r.problems[1].message, /no "-->" timing line/);
    assert.match(r.problems[2].message, /ends before it starts.*imported/);
});

test('VTT: header, notes, cue settings and identifiers', () => {
    const r = F.parse('WEBVTT\n\nNOTE a comment\n\nintro\n00:01.000 --> 00:02.500 align:start\n<i>Hello</i>\n', 'a.vtt');
    assert.equal(r.format, 'vtt');
    assert.equal(r.cues.length, 1);
    assert.equal(r.cues[0].startTime, '00:00:01,000');
    assert.equal(r.cues[0].endTime, '00:00:02,500');
    assert.equal(r.styled, 1);
});

test('ASS: Dialogue lines with commas in the text, \\N breaks, and override blocks kept', () => {
    const ass = '[Script Info]\nTitle: x\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
        + 'Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\i1}Hi,{\\i0} there\\Nfriend\n'
        + 'Comment: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,not a subtitle\n';
    const r = F.parse(ass, 'x.ass');
    assert.equal(r.format, 'ass');
    assert.equal(r.cues.length, 1);
    assert.equal(r.cues[0].originalText, '{\\i1}Hi,{\\i0} there\nfriend');
    assert.equal(r.cues[0].endTime, '00:00:02,500');
});

test('encodings: BOMs, UTF-8, and Arabic in Windows-1256 without a BOM', () => {
    const utf8 = new TextEncoder().encode('1\n00:00:01,000 --> 00:00:02,000\nمرحبا\n');
    assert.equal(F.decode(utf8).encoding, 'utf-8');
    assert.match(F.decode(utf8).text, /مرحبا/);
    const bom16 = new Uint8Array([0xFF, 0xFE, ...Buffer.from('Hi', 'utf16le')]);
    assert.equal(F.decode(bom16).text, 'Hi');
    // "مرحبا بك" in Windows-1256.
    const cp1256 = new Uint8Array([0xE3, 0xD1, 0xCD, 0xC8, 0xC7, 0x20, 0xC8, 0xDF]);
    const d = F.decode(cp1256);
    assert.equal(d.encoding, 'windows-1256');
    assert.equal(d.text, 'مرحبا بك');
    assert.equal(d.guessed, true);
    assert.equal(F.decode(cp1256, 'windows-1252').encoding, 'windows-1252', 'a chosen encoding wins');
});

const cues = [
    { startTime: '00:00:01,000', endTime: '00:00:02,000', originalText: 'Hello', translatedText: '<i>مرحبا</i>' },
    { startTime: '00:00:03,000', endTime: '00:00:04,000', originalText: 'Bye', translatedText: '' },
    { startTime: '00:00:05,000', endTime: '00:00:06,000', originalText: 'Red', translatedText: '<font color="red">أحمر</font>' },
];

test('SRT export: translation with source fallback, CRLF, round-trips', () => {
    const out = F.serialize(cues, 'srt');
    assert.ok(out.text.includes('\r\n'));
    const back = F.parse(out.text.replace(/^﻿/, ''), 'x.srt');
    assert.deepEqual(back.cues.map(c => c.originalText), ['<i>مرحبا</i>', 'Bye', '<font color="red">أحمر</font>']);
    assert.deepEqual(out.notes, []);
});

test('export choices: source only, bilingual, skip or blank untranslated', () => {
    assert.match(F.serialize(cues, 'srt', { content: 'source' }).text, /\r\nHello\r\n/);
    assert.match(F.serialize(cues, 'srt', { content: 'bilingual' }).text, /<i>مرحبا<\/i>\r\nHello/);
    assert.equal(F.serialize(cues, 'srt', { empty: 'skip' }).count, 2);
    assert.doesNotMatch(F.serialize(cues, 'srt', { empty: 'blank' }).text, /Bye/);
});

test('formats explain what they drop before it is dropped', () => {
    const vtt = F.serialize(cues, 'vtt');
    assert.ok(vtt.notes.some(n => /<font>.*not supported by WebVTT/.test(n)));
    assert.doesNotMatch(vtt.text, /<font/);
    assert.match(vtt.text, /<i>مرحبا<\/i>/);
    const txt = F.serialize(cues, 'txt');
    assert.ok(txt.notes.some(n => /no timing/.test(n)));
    assert.doesNotMatch(txt.text, /<i>|-->/);
});

test('ASS export converts basic tags and line breaks', () => {
    const out = F.serialize([{ startTime: '00:00:01,000', endTime: '00:00:02,500', originalText: '', translatedText: '<i>a</i>\nb' }], 'ass');
    assert.match(out.text, /Dialogue: 0,0:00:01\.00,0:00:02\.50,Default,,0,0,0,,\{\\i1\}a\{\\i0\}\\Nb/);
    const back = F.parse(out.text.replace(/^﻿/, ''), 'x.ass');
    assert.equal(back.cues[0].originalText, '{\\i1}a{\\i0}\nb');
});

test('a draft export says so inside the file where the format allows', () => {
    assert.match(F.serialize(cues, 'vtt', { draft: { summary: '2 timing errors' } }).text, /NOTE\nDRAFT — not final\. 2 timing errors/);
    assert.match(F.serialize(cues, 'ass', { draft: { summary: 'x' } }).text, /; DRAFT/);
});

test('exported timings are exact', () => {
    const out = F.serialize([{ startTime: '01:02:03,045', endTime: '01:02:04,500', translatedText: 'x' }], 'vtt');
    assert.match(out.text, /01:02:03\.045 --> 01:02:04\.500/);
    assert.equal(Core.seconds('01:02:03,045'), 3723.045);
});
