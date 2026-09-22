/* Pure subtitle utilities shared by the editor and regression tests. */
(function (root) {
    'use strict';
    function seconds(value) {
        const match = String(value).trim().match(/^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)[,.](\d{3})$/);
        return match ? Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000 : NaN;
    }
    function timestamp(value) {
        const ms = Math.round(Math.max(0, Number(value) || 0) * 1000);
        const pad = n => String(n).padStart(2, '0');
        return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${String(ms % 1000).padStart(3, '0')}`;
    }
    function parse(text) {
        return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/).flatMap(block => {
            if (/^(WEBVTT|NOTE|STYLE|REGION)(\s|$)/.test(block)) return [];
            const lines = block.split('\n');
            const idx = lines.findIndex(line => line.includes('-->'));
            if (idx < 0) return [];
            const [start, end] = lines[idx].split('-->').map(t => t.trim().split(/\s+/)[0]);
            const a = seconds(start), b = seconds(end);
            if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a || b >= 86400) throw new Error('Every cue needs valid timestamps and an OUT time after its IN time (under 24 hours).');
            return [{ startTime: timestamp(a), endTime: timestamp(b), originalText: lines.slice(idx + 1).join('\n'), translatedText: '' }];
        });
    }
    function splitTextAt(text, ratio) {
        if (!text) return ['', ''];
        const target = Math.round(text.length * ratio);
        let cut = -1;
        for (let d = 0; d <= text.length; d++) {
            if (/\s/.test(text[target - d] || '')) { cut = target - d; break; }
            if (/\s/.test(text[target + d] || '')) { cut = target + d; break; }
        }
        if (cut < 0) cut = target;
        cut = Math.min(Math.max(cut, 0), text.length);
        return [text.slice(0, cut).trim(), text.slice(cut).trim()];
    }
    function splitCue(cue, atSeconds) {
        const start = seconds(cue.startTime), end = seconds(cue.endTime);
        if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error('Fix this cue\'s timing before splitting it.');
        if (!Number.isFinite(atSeconds) || atSeconds <= start || atSeconds >= end) throw new Error('Move the playhead inside the selected cue before splitting.');
        const ratio = (atSeconds - start) / (end - start);
        const [origA, origB] = splitTextAt(cue.originalText || '', ratio);
        const [transA, transB] = splitTextAt(cue.translatedText || '', ratio);
        const at = timestamp(atSeconds);
        return [
            { ...cue, endTime: at, originalText: origA, translatedText: transA },
            { ...cue, startTime: at, originalText: origB, translatedText: transB }
        ];
    }
    function mergeCues(a, b) {
        const join = (x, y) => [x, y].map(t => (t || '').trim()).filter(Boolean).join('\n');
        const start = seconds(a.startTime) <= seconds(b.startTime) ? a.startTime : b.startTime;
        const end = seconds(a.endTime) >= seconds(b.endTime) ? a.endTime : b.endTime;
        return { ...a, startTime: start, endTime: end, originalText: join(a.originalText, b.originalText), translatedText: join(a.translatedText, b.translatedText) };
    }
    // Parses a shift amount typed as HH:MM:SS:FF / HH:MM:SS / MM:SS (using fps
    // for the frames group), or a plain number of seconds — with an optional
    // leading +/- sign. Returns NaN for anything it can't make sense of.
    function parseShiftAmount(input, fps) {
        const raw = String(input).trim();
        if (!raw) return NaN;
        const negative = raw.startsWith('-') || raw.startsWith('−');
        const body = negative || raw.startsWith('+') ? raw.slice(1).trim() : raw;
        if (!body) return NaN;
        let value;
        if (/^\d+(\.\d+)?$/.test(body)) {
            value = Number(body);
        } else {
            const parts = body.split(/[:;]/).map(Number);
            if (parts.some(Number.isNaN)) return NaN;
            if (parts.length === 4) {
                const [h, m, s, f] = parts;
                if (f >= Math.round(fps)) return NaN;
                value = h * 3600 + m * 60 + s + f / fps;
            } else if (parts.length === 3) {
                value = parts[0] * 3600 + parts[1] * 60 + parts[2];
            } else if (parts.length === 2) {
                value = parts[0] * 60 + parts[1];
            } else return NaN;
        }
        return negative ? -value : value;
    }
    // Given the cues a shift is about to apply to, trims the requested offset so
    // the earliest start never goes below 00:00:00 and the latest end never
    // reaches 24 hours, instead of the caller having to guess a safe amount.
    function clampShiftOffset(cues, offset) {
        if (!cues.length || offset === 0) return offset;
        if (offset < 0) {
            const minStart = Math.min(...cues.map(c => seconds(c.startTime)));
            return Number.isFinite(minStart) ? Math.max(offset, -minStart) : offset;
        }
        const maxEnd = Math.max(...cues.map(c => seconds(c.endTime)));
        return Number.isFinite(maxEnd) ? Math.min(offset, 86400 - 0.001 - maxEnd) : offset;
    }
    function shift(cue, offsetSeconds) {
        const start = seconds(cue.startTime) + offsetSeconds, end = seconds(cue.endTime) + offsetSeconds;
        if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error('Fix this cue\'s timing before shifting it.');
        if (start < 0) throw new Error('That shift would move a cue before 00:00:00,000.');
        if (end >= 86400) throw new Error('That shift would move a cue past 24 hours.');
        return { ...cue, startTime: timestamp(start), endTime: timestamp(end) };
    }
    const FRAME_TC_RE = /^(\d{1,2}):([0-5]\d):([0-5]\d)[:;](\d{1,2})$/;
    const ENTRY_HEADER_RE = /^(\d{2,6})\s+(\d{1,2}:[0-5]\d:[0-5]\d[:;]\d{1,2})\s+(\d{1,2}:[0-5]\d:[0-5]\d[:;]\d{1,2})\s+\d+$/;
    function framesToSeconds(tc, fps) {
        const m = FRAME_TC_RE.exec(String(tc).trim());
        if (!m) return NaN;
        const f = Number(m[4]);
        if (f >= Math.round(fps)) return NaN;
        return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + f / fps;
    }
    // Recognizes a "spotting list" style script: repeated blocks of
    // "<number> <in HH:MM:SS:FF> <out HH:MM:SS:FF> <count>" followed by that
    // cue's (possibly multi-line) text, in any amount of surrounding blank lines.
    // Returns [] (not a throw) when the text doesn't look like this format, so
    // callers can fall back to treating it as a plain, untimed script.
    function parseTimedScript(text, fps) {
        const lines = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
        const headers = [];
        lines.forEach((line, i) => {
            const m = ENTRY_HEADER_RE.exec(line.trim());
            if (m) headers.push({ i, inTc: m[2], outTc: m[3] });
        });
        if (!headers.length) return [];
        return headers.map((h, idx) => {
            const end = idx + 1 < headers.length ? headers[idx + 1].i : lines.length;
            const cueText = lines.slice(h.i + 1, end).map(l => l.trim()).filter(Boolean).join('\n');
            const a = framesToSeconds(h.inTc, fps), b = framesToSeconds(h.outTc, fps);
            if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a || b >= 86400)
                throw new Error(`Entry starting at line ${h.i + 1} needs a valid in-time before its out-time (under 24 hours).`);
            return { startTime: timestamp(a), endTime: timestamp(b), originalText: cueText, translatedText: '' };
        });
    }
    function cuesFromLines(lines) {
        const GAP = 0.25, MIN_DUR = 1.2, MAX_DUR = 7, CPS_ESTIMATE = 15;
        let t = 0;
        return lines.map(raw => String(raw).trim()).filter(Boolean).map(text => {
            const dur = Math.min(MAX_DUR, Math.max(MIN_DUR, [...text.replace(/\s/g, '')].length / CPS_ESTIMATE));
            const start = t, end = start + dur;
            t = end + GAP;
            return { startTime: timestamp(start), endTime: timestamp(end), originalText: text, translatedText: '' };
        });
    }
    // The numbers the quality checks apply. DEFAULT_PROFILE reproduces the
    // thresholds this editor used before profiles existed.
    //
    // minGapSeconds defaults to ~2 frames at 25fps: a shorter gap between cues
    // reads as a flicker rather than a cut.
    const DEFAULT_PROFILE = Object.freeze({
        id: 'general',
        name: 'General (default)',
        maxCharsPerLine: 42,
        maxLines: 2,
        maxCps: 21,
        minDurationSeconds: 1,
        maxDurationSeconds: 7,
        minGapSeconds: 0.08,
    });

    // Starting points, not certified specs — broadcasters revise their
    // guidelines, so every field stays editable in the editor and the profile
    // is stored with the translator's own adjustments.
    const PROFILES = [
        DEFAULT_PROFILE,
        Object.freeze({ id: 'streaming-42', name: 'Streaming, 42 characters', maxCharsPerLine: 42, maxLines: 2, maxCps: 20, minDurationSeconds: 0.833, maxDurationSeconds: 7, minGapSeconds: 0.083 }),
        Object.freeze({ id: 'broadcast-37', name: 'Broadcast, 37 characters', maxCharsPerLine: 37, maxLines: 2, maxCps: 17, minDurationSeconds: 1, maxDurationSeconds: 8, minGapSeconds: 0.12 }),
        Object.freeze({ id: 'cinema-40',    name: 'Cinema, 40 characters',    maxCharsPerLine: 40, maxLines: 2, maxCps: 16, minDurationSeconds: 1.2, maxDurationSeconds: 8, minGapSeconds: 0.16 }),
        Object.freeze({ id: 'relaxed-45',   name: 'Relaxed, 45 characters',   maxCharsPerLine: 45, maxLines: 3, maxCps: 25, minDurationSeconds: 0.7, maxDurationSeconds: 10, minGapSeconds: 0.04 }),
    ];

    // Any missing or nonsensical field falls back to the default, so a stored
    // profile from an older build (or a hand-edited one) cannot break checking.
    function normaliseProfile(profile) {
        const out = { ...DEFAULT_PROFILE, ...(profile || {}) };
        const positive = (value, fallback) => (Number.isFinite(+value) && +value > 0 ? +value : fallback);
        out.maxCharsPerLine    = Math.round(positive(out.maxCharsPerLine, DEFAULT_PROFILE.maxCharsPerLine));
        out.maxLines           = Math.round(positive(out.maxLines, DEFAULT_PROFILE.maxLines));
        out.maxCps             = positive(out.maxCps, DEFAULT_PROFILE.maxCps);
        out.minDurationSeconds = positive(out.minDurationSeconds, DEFAULT_PROFILE.minDurationSeconds);
        out.maxDurationSeconds = positive(out.maxDurationSeconds, DEFAULT_PROFILE.maxDurationSeconds);
        // Zero is a legitimate setting here (do not check gaps at all), so a
        // missing value has to be told apart from a deliberate zero.
        const supplied = out.minGapSeconds !== null && out.minGapSeconds !== undefined && out.minGapSeconds !== '';
        out.minGapSeconds      = supplied && Number.isFinite(+out.minGapSeconds) && +out.minGapSeconds >= 0
            ? +out.minGapSeconds : DEFAULT_PROFILE.minGapSeconds;
        return out;
    }
    function issues(cue, cues, profile) {
        const rules = normaliseProfile(profile);
        const a = seconds(cue.startTime), b = seconds(cue.endTime);
        const isValid = Number.isFinite(a) && Number.isFinite(b) && b > a && b < 86400;
        let overlaps = false, hasShortGap = false;
        if (isValid) {
            overlaps = cues.some(other => other !== cue && seconds(other.startTime) < b && seconds(other.endTime) > a);
            if (!overlaps) {
                const nextStart = Math.min(...cues.filter(other => other !== cue && seconds(other.startTime) >= b).map(other => seconds(other.startTime)));
                hasShortGap = Number.isFinite(nextStart) && nextStart - b > 0 && nextStart - b < rules.minGapSeconds;
            }
        }
        return analyzeCue(cue, { a, b }, isValid, overlaps, hasShortGap, rules);
    }

    // issues() answers for one cue and re-scans every other cue to do it, so
    // asking it about a whole track costs O(n^2) — on a 1500-cue film that is
    // millions of timestamp parses per keystroke. analyze() answers for the
    // whole track at once in O(n log n): timestamps are parsed once, and a
    // single sweep in start-time order settles every overlap and gap.
    //
    // Results match issues() cue for cue; analyzeCue() below shares the
    // per-cue rules so the two can never drift apart.
    function analyze(cues, profile) {
        const rules = normaliseProfile(profile);
        const spans = cues.map(cue => ({ a: seconds(cue.startTime), b: seconds(cue.endTime) }));
        // Measurable: both timestamps parsed. Valid: also a positive duration
        // inside the 24-hour range. The distinction matters because issues()
        // lets a zero-length or reversed cue still *count* as an overlap
        // partner for its neighbours, while only reporting overlap against a
        // cue that is itself valid.
        const measurable = i => Number.isFinite(spans[i].a) && Number.isFinite(spans[i].b);
        const valid = i => measurable(i) && spans[i].b > spans[i].a && spans[i].b < 86400;

        const order = spans.map((_, i) => i).filter(measurable)
            .sort((x, y) => spans[x].a - spans[y].a || spans[x].b - spans[y].b);

        const overlap = new Array(cues.length).fill(false);
        const shortGap = new Array(cues.length).fill(false);

        // Two cues overlap when their open intervals intersect. In start order
        // that is true for cue k when it starts before the latest end among
        // everything before it, or when the very next start falls before its
        // own end. Those two tests together are exact.
        let maxEnd = -Infinity;
        for (let k = 0; k < order.length; k++) {
            const i = order[k];
            if (spans[i].a < maxEnd) overlap[i] = true;
            if (k + 1 < order.length && spans[order[k + 1]].a < spans[i].b) overlap[i] = true;
            maxEnd = Math.max(maxEnd, spans[i].b);
        }

        // Nearest cue starting at or after this one ends. Starts are sorted, so
        // one forward pointer serves every cue.
        let ahead = 0;
        for (let k = 0; k < order.length; k++) {
            const i = order[k];
            if (overlap[i] || !valid(i)) continue;
            if (ahead < k + 1) ahead = k + 1;
            while (ahead < order.length && spans[order[ahead]].a < spans[i].b) ahead++;
            if (ahead < order.length) {
                const gap = spans[order[ahead]].a - spans[i].b;
                if (gap > 0 && gap < rules.minGapSeconds) shortGap[i] = true;
            }
        }

        return cues.map((cue, i) => analyzeCue(cue, spans[i], valid(i), overlap[i], shortGap[i], rules));
    }

    // The per-cue rules, shared by issues() and analyze().
    function analyzeCue(cue, span, isValid, overlaps, hasShortGap, rules) {
        const result = [];
        const text = cue.translatedText || '';
        const lines = text.split('\n');
        if (!isValid) result.push('Invalid timing');
        else {
            const dur = span.b - span.a;
            if (dur < rules.minDurationSeconds) result.push('Short duration');
            if (dur > rules.maxDurationSeconds) result.push('Long duration');
            if ([...text.replace(/\s/g, '')].length / dur > rules.maxCps) result.push('Fast reading speed');
            if (overlaps) result.push('Overlapping cues');
            else if (hasShortGap) result.push('Short gap');
        }
        if (!text.trim()) result.push('Untranslated');
        if (lines.some(line => [...line].length > rules.maxCharsPerLine)) result.push('Long line');
        if (lines.length > rules.maxLines) result.push(`More than ${rules.maxLines} line${rules.maxLines === 1 ? '' : 's'}`);
        return result;
    }
    const api = { seconds, timestamp, parse, issues, analyze, PROFILES, DEFAULT_PROFILE, normaliseProfile, splitCue, mergeCues, shift, parseShiftAmount, clampShiftOffset, cuesFromLines, parseTimedScript, framesToSeconds };
    if (typeof module !== 'undefined') module.exports = api;
    else root.SubtitleCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
