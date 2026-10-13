/* ══════════════════════════════════════════════════════════════════════
   TmFormats — reading and writing subtitle files.

   Reading is lenient and honest: every entry that can be understood is kept,
   and every entry that cannot is reported with its number, line and what was
   wrong, instead of one bad block aborting the whole import (which is what
   SubtitleCore.parse does, and still does for its own callers).

   Writing goes through one function per format, and reports what the format
   could not keep (styling it drops, characters it cannot hold) so that can be
   explained before the file is produced.

   Pure: no DOM. Used by transfer.js and tests/formats.test.cjs.
   ══════════════════════════════════════════════════════════════════════ */
(function (root) {
    'use strict';
    const Core = typeof module !== 'undefined' ? require('./subtitle-core.js') : root.SubtitleCore;

    // ── Encodings ─────────────────────────────────────────────────────
    /* Decodes file bytes. A BOM settles it; otherwise strict UTF-8 is tried
       first, and if the bytes are not valid UTF-8 the legacy code pages that
       subtitle files for Arabic and Western languages most often use. */
    function decode(bytes, forced) {
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        const tryDecode = (label, fatal) => {
            try { return new TextDecoder(label, { fatal }).decode(u8); } catch { return null; }
        };
        if (forced) {
            const text = tryDecode(forced, false);
            if (text != null) return { text: text.replace(/^﻿/, ''), encoding: forced, guessed: false };
        }
        if (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) return { text: tryDecode('utf-8', false).replace(/^﻿/, ''), encoding: 'utf-8', guessed: false };
        if (u8[0] === 0xFF && u8[1] === 0xFE) return { text: tryDecode('utf-16le', false).replace(/^﻿/, ''), encoding: 'utf-16le', guessed: false };
        if (u8[0] === 0xFE && u8[1] === 0xFF) return { text: tryDecode('utf-16be', false).replace(/^﻿/, ''), encoding: 'utf-16be', guessed: false };
        const utf8 = tryDecode('utf-8', true);
        if (utf8 != null) return { text: utf8, encoding: 'utf-8', guessed: false };
        // Not UTF-8. Prefer the code page that yields Arabic letters when the
        // high bytes look like Arabic, otherwise Western European.
        const arabic = tryDecode('windows-1256', false);
        const western = tryDecode('windows-1252', false);
        const arabicLetters = s => (s?.match(/[؀-ۿ]/g) || []).length;
        if (arabic && arabicLetters(arabic) > 3) return { text: arabic, encoding: 'windows-1256', guessed: true };
        return { text: western ?? tryDecode('utf-8', false), encoding: western ? 'windows-1252' : 'utf-8', guessed: true };
    }

    const ENCODINGS = [
        ['utf-8', 'UTF-8'], ['utf-16le', 'UTF-16 (LE)'], ['windows-1256', 'Arabic (Windows-1256)'],
        ['iso-8859-6', 'Arabic (ISO-8859-6)'], ['windows-1252', 'Western (Windows-1252)'], ['iso-8859-1', 'Western (ISO-8859-1)'],
    ];

    // ── Format detection ──────────────────────────────────────────────
    function detect(text, fileName = '') {
        const ext = (fileName.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
        if (ext === 'ass' || ext === 'ssa' || /^\s*\[Script Info\]/i.test(text)) return 'ass';
        if (ext === 'vtt' || /^\s*WEBVTT/.test(text)) return 'vtt';
        return 'srt';
    }

    // ── Timecodes ─────────────────────────────────────────────────────
    // SRT "00:00:01,000", VTT "00:01.000" or "00:00:01.000"; tolerant of a
    // single-digit hour and of the wrong separator, which real files have.
    function readTime(raw) {
        const m = String(raw).trim().match(/^(?:(\d{1,3}):)?([0-5]?\d):([0-5]\d)[,.](\d{1,3})$/);
        if (!m) return NaN;
        return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
    }

    function readAssTime(raw) {
        const m = String(raw).trim().match(/^(\d+):([0-5]\d):([0-5]\d)[.:](\d{1,3})$/);
        if (!m) return NaN;
        const frac = m[4].length === 2 ? Number(m[4]) / 100 : Number(m[4].padEnd(3, '0')) / 1000;
        return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
    }

    // ── SRT / VTT ─────────────────────────────────────────────────────
    function parseBlocks(text, format) {
        const cues = [], problems = [];
        const lines = text.replace(/\r\n?/g, '\n').split('\n');
        // Group into blocks, remembering where each starts (for messages).
        const blocks = [];
        let cur = null;
        lines.forEach((line, i) => {
            if (line.trim() === '') { if (cur) { blocks.push(cur); cur = null; } return; }
            if (!cur) cur = { start: i + 1, lines: [] };
            cur.lines.push(line);
        });
        if (cur) blocks.push(cur);

        let entry = 0;
        for (const block of blocks) {
            const first = block.lines[0].trim();
            if (format === 'vtt' && /^(WEBVTT|NOTE|STYLE|REGION)(\s|$)/.test(first)) continue;
            entry++;
            const idx = block.lines.findIndex(l => l.includes('-->'));
            if (idx < 0) {
                // A block of text with no timing line. Often the previous
                // cue's text after a stray blank line; say so rather than guess.
                problems.push({ entry, line: block.start, message: `Entry ${entry} (line ${block.start}) has no "-->" timing line, so it was skipped: "${block.lines.join(' ').slice(0, 60)}"` });
                continue;
            }
            const timing = block.lines[idx];
            const [left, right = ''] = timing.split('-->');
            const a = readTime(left.trim().split(/\s+/)[0]);
            const b = readTime(right.trim().split(/\s+/)[0]);
            const label = idx > 0 ? block.lines.slice(0, idx).join(' ').trim() : String(entry);
            const textLines = block.lines.slice(idx + 1);
            if (!Number.isFinite(a) || !Number.isFinite(b)) {
                problems.push({ entry, line: block.start + idx, message: `Entry ${label} (line ${block.start + idx}) has a timecode that could not be read: "${timing.trim()}". It was skipped.` });
                continue;
            }
            if (b <= a) problems.push({ entry, line: block.start + idx, message: `Entry ${label} (line ${block.start + idx}) ends before it starts (${timing.trim()}). It was imported so you can fix it; it will show as a timing error.` });
            if (!textLines.length) problems.push({ entry, line: block.start + idx, message: `Entry ${label} (line ${block.start + idx}) has no text. It was imported empty.` });
            cues.push({ startTime: Core.timestamp(a), endTime: Core.timestamp(Math.max(b, 0)), originalText: textLines.join('\n'), translatedText: '', sourceNumber: label });
        }
        return { cues, problems };
    }

    // ── ASS / SSA ─────────────────────────────────────────────────────
    function parseAss(text) {
        const cues = [], problems = [];
        const lines = text.replace(/\r\n?/g, '\n').split('\n');
        let section = '', format = null;
        lines.forEach((line, i) => {
            const t = line.trim();
            const sec = t.match(/^\[(.+)\]$/);
            if (sec) { section = sec[1].toLowerCase(); return; }
            if (section !== 'events') return;
            if (/^Format\s*:/i.test(t)) { format = t.replace(/^Format\s*:/i, '').split(',').map(s => s.trim().toLowerCase()); return; }
            if (!/^Dialogue\s*:/i.test(t)) return;
            const f = format || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
            const body = t.replace(/^Dialogue\s*:\s*/i, '');
            // Text is the last field and may itself contain commas.
            const parts = body.split(',');
            const fields = parts.slice(0, f.length - 1).concat(parts.slice(f.length - 1).join(','));
            const get = name => fields[f.indexOf(name)];
            const a = readAssTime(get('start')), b = readAssTime(get('end'));
            if (!Number.isFinite(a) || !Number.isFinite(b)) {
                problems.push({ entry: cues.length + 1, line: i + 1, message: `Line ${i + 1}: a Dialogue line has a timecode that could not be read. It was skipped.` });
                return;
            }
            if (b <= a) problems.push({ entry: cues.length + 1, line: i + 1, message: `Line ${i + 1}: a Dialogue line ends before it starts. It was imported so you can fix it.` });
            const raw = get('text') || '';
            cues.push({
                startTime: Core.timestamp(a), endTime: Core.timestamp(b),
                originalText: raw.replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' '),
                translatedText: '',
            });
        });
        if (!format && cues.length === 0) problems.push({ entry: 0, line: 0, message: 'No [Events] section with Dialogue lines was found.' });
        return { cues, problems };
    }

    /* Reads a subtitle file. Returns { format, cues, problems, styled } where
       styled counts entries carrying formatting tags or ASS style blocks. */
    function parse(text, fileName = '') {
        const format = detect(text, fileName);
        const out = format === 'ass' ? parseAss(text) : parseBlocks(text, format);
        out.format = format;
        out.styled = out.cues.filter(c => /<\/?[a-z][^>]*>|\{\\[^}]*\}/i.test(c.originalText)).length;
        // Entries whose start goes backwards are kept in file order and
        // reported; the validation offers to sort them.
        let outOfOrder = 0;
        for (let i = 1; i < out.cues.length; i++) if (Core.seconds(out.cues[i].startTime) < Core.seconds(out.cues[i - 1].startTime)) outOfOrder++;
        if (outOfOrder) out.problems.push({ entry: 0, line: 0, message: `${outOfOrder} entr${outOfOrder === 1 ? 'y starts' : 'ies start'} before the entry above it. They were kept in file order; the issues panel can sort them.` });
        return out;
    }

    // ── Writing ───────────────────────────────────────────────────────
    const FORMAT_INFO = {
        srt: { label: 'SRT', ext: 'srt', tags: ['i', 'b', 'u', 'font'], ass: false, mime: 'application/x-subrip' },
        vtt: { label: 'WebVTT', ext: 'vtt', tags: ['i', 'b', 'u', 'c', 'v', 'lang', 'ruby', 'rt'], ass: false, mime: 'text/vtt' },
        ass: { label: 'ASS', ext: 'ass', tags: ['i', 'b', 'u'], ass: true, mime: 'text/x-ssa' },
        txt: { label: 'Plain text', ext: 'txt', tags: [], ass: false, mime: 'text/plain' },
    };

    const stripAll = s => String(s).replace(/<\/?[a-z][^>]*>/gi, '').replace(/\{\\[^}]*\}/g, '');

    /* What a format will lose from these cues: tags it cannot carry, ASS
       style blocks, and (for the plain-text format) all timing. */
    function losses(cues, format, textOf) {
        const info = FORMAT_INFO[format];
        const dropped = new Map();
        let assBlocks = 0;
        for (const c of cues) {
            const t = textOf(c);
            // Opening tags only: <font>…</font> is one place, not two.
            const re = /<([a-z][a-z0-9]*)\b[^>]*>/gi;
            let m;
            while ((m = re.exec(t))) {
                const tag = m[1].toLowerCase();
                // ASS converts <i>/<b>/<u> into its own blocks; others are lost.
                if (!info.tags.includes(tag)) dropped.set(tag, (dropped.get(tag) || 0) + 1);
            }
            if (/\{\\[^}]*\}/.test(t) && !info.ass) assBlocks++;
        }
        const notes = [];
        for (const [tag, n] of dropped) notes.push(`<${tag}> formatting (${n} place${n === 1 ? '' : 's'}) is not supported by ${info.label} and will be removed.`);
        if (assBlocks) notes.push(`ASS style blocks {\\…} in ${assBlocks} subtitle${assBlocks === 1 ? '' : 's'} are not supported by ${info.label} and will be removed.`);
        if (format === 'txt') notes.push('Plain text has no timing: only the words are exported.');
        return notes;
    }

    function cleanFor(format, text) {
        const info = FORMAT_INFO[format];
        let t = String(text);
        if (!info.ass) t = t.replace(/\{\\[^}]*\}/g, '');
        t = t.replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (m, tag) => (info.tags.includes(tag.toLowerCase()) ? m : ''));
        return t;
    }

    function toAssText(text) {
        return String(text)
            .replace(/<i>/gi, '{\\i1}').replace(/<\/i>/gi, '{\\i0}')
            .replace(/<b>/gi, '{\\b1}').replace(/<\/b>/gi, '{\\b0}')
            .replace(/<u>/gi, '{\\u1}').replace(/<\/u>/gi, '{\\u0}')
            .replace(/<\/?[a-z][^>]*>/gi, '')
            .replace(/\n/g, '\\N');
    }

    const assTime = s => {
        const cs = Math.round(Math.max(0, s) * 100);
        return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
    };

    /* Builds the file. options:
         content: 'translation' | 'source' | 'bilingual'
         empty:   'source' (fall back) | 'blank' | 'skip'
         draft:   null or { summary } — marks the file as a draft where the
                  format has room (VTT NOTE, ASS comment); the file name is
                  marked by the caller in every format. */
    function serialize(cues, format, options = {}) {
        const { content = 'translation', empty = 'source', draft = null, title = 'Subtitles' } = options;
        const textOf = c => {
            const tr = (c.translatedText || '').trim() ? c.translatedText : null;
            const src = c.originalText || '';
            if (content === 'source') return src;
            if (content === 'bilingual') return [tr ?? '', src].filter(s => String(s).trim()).join('\n');
            if (tr != null) return tr;
            return empty === 'source' ? src : '';
        };
        const list = cues.filter(c => !(content === 'translation' && empty === 'skip' && !(c.translatedText || '').trim()));
        const notes = losses(list, format, textOf);
        let out = '';
        if (format === 'srt') {
            list.forEach((c, i) => {
                out += `${i + 1}\n${Core.timestamp(Core.seconds(c.startTime))} --> ${Core.timestamp(Core.seconds(c.endTime))}\n${cleanFor('srt', textOf(c))}\n\n`;
            });
        } else if (format === 'vtt') {
            out = 'WEBVTT\n\n';
            if (draft) out += `NOTE\nDRAFT — not final. ${String(draft.summary || '').replace(/-->/g, '→')}\n\n`;
            list.forEach((c, i) => {
                const ts = s => Core.timestamp(Core.seconds(s)).replace(',', '.');
                out += `${i + 1}\n${ts(c.startTime)} --> ${ts(c.endTime)}\n${cleanFor('vtt', textOf(c)).replace(/-->/g, '→')}\n\n`;
            });
        } else if (format === 'ass') {
            out = `[Script Info]\nTitle: ${title.replace(/\n/g, ' ')}\nScriptType: v4.00+\nWrapStyle: 0\nScaledBorderAndShadow: yes\nPlayResX: 1920\nPlayResY: 1080\n`
                + (draft ? `; DRAFT — not final. ${String(draft.summary || '')}\n` : '')
                + `\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n`
                + `Style: Default,Arial,64,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,3,1,2,60,60,50,1\n\n`
                + `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
            list.forEach(c => {
                out += `Dialogue: 0,${assTime(Core.seconds(c.startTime))},${assTime(Core.seconds(c.endTime))},Default,,0,0,0,,${toAssText(textOf(c))}\n`;
            });
        } else {
            out = list.map(c => stripAll(textOf(c))).filter(s => s.trim()).join('\n\n') + '\n';
        }
        // Windows line endings for SRT, which some broadcast tools insist on;
        // the others use LF.
        if (format === 'srt') out = out.replace(/\n/g, '\r\n');
        return { text: '﻿' + out, notes, count: list.length, mime: FORMAT_INFO[format].mime, ext: FORMAT_INFO[format].ext };
    }

    const api = { decode, detect, parse, serialize, losses, readTime, readAssTime, ENCODINGS, FORMAT_INFO };
    if (typeof module !== 'undefined') module.exports = api;
    else root.TmFormats = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
