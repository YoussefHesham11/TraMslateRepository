/* ══════════════════════════════════════════════════════════════════════
   TmQuality — the project's validation rules.

   Takes the track, the project's rules and what is known about the media,
   and returns findings, each with a severity:

     error       blocks Done. Structural problems (timing that cannot play,
                 untranslated lines the project requires, open flags) are
                 always errors.
     warning     needs a person's judgement. Whether warnings block Done is a
                 project rule: never, until acknowledged, or always.
     suggestion  optional improvement; never blocks anything.

   Automated judgements that can be wrong (a line identical to its source may
   be a name; a glossary term may be inflected) are warnings or suggestions,
   never errors, and any finding marked waivable can be waived for one line
   with a recorded reason. Structural errors cannot be waived.

   Pure: no DOM. Used by the editor and by tests/quality.test.cjs.
   ══════════════════════════════════════════════════════════════════════ */
(function (root) {
    'use strict';

    const Core = typeof module !== 'undefined' ? require('./subtitle-core.js') : root.SubtitleCore;

    // ── Rules ─────────────────────────────────────────────────────────
    const DEFAULT_RULES = Object.freeze({
        requireTranslation: true,     // an untranslated line is an error
        requireReview: false,         // every line must be marked reviewed
        allowOverlaps: false,         // overlapping cues are permitted (e.g. two speakers)
        warningsForDone: 'acknowledge', // 'never' | 'acknowledge' | 'block'
        exportFormat: 'srt',          // the format checks for tags/characters assume
        severity: {},                 // per-code override: 'error' | 'warning' | 'suggestion' | 'off'
    });

    function normaliseRules(rules) {
        const out = { ...DEFAULT_RULES, ...(rules || {}) };
        out.requireTranslation = out.requireTranslation !== false;
        out.requireReview = out.requireReview === true;
        out.allowOverlaps = out.allowOverlaps === true;
        if (!['never', 'acknowledge', 'block'].includes(out.warningsForDone)) out.warningsForDone = DEFAULT_RULES.warningsForDone;
        if (!FORMATS[out.exportFormat]) out.exportFormat = DEFAULT_RULES.exportFormat;
        out.severity = out.severity && typeof out.severity === 'object' ? { ...out.severity } : {};
        return out;
    }

    // What each export format can carry. Anything else in the text is either
    // dropped or shown raw by players, so it is flagged before export.
    const FORMATS = {
        srt: { label: 'SRT', tags: ['i', 'b', 'u', 'font'], assOverrides: false },
        vtt: { label: 'WebVTT', tags: ['i', 'b', 'u', 'c', 'v', 'lang', 'ruby', 'rt'], assOverrides: false },
        ass: { label: 'ASS', tags: [], assOverrides: true },
        txt: { label: 'Plain text', tags: [], assOverrides: false },
    };

    // ── The catalogue ─────────────────────────────────────────────────
    // Every check, its default severity, whether a person may waive it for a
    // line, the field it points at, and the words used to explain it.
    const CHECKS = {
        'timing.malformed':   { severity: 'error',      waivable: false, field: 'startTime', title: 'Unreadable timecode' },
        'timing.invalid':     { severity: 'error',      waivable: false, field: 'endTime',   title: 'Out-time not after in-time' },
        'timing.order':       { severity: 'warning',    waivable: true,  field: 'startTime', title: 'Out of order' },
        'timing.overlap':     { severity: 'error',      waivable: true,  field: 'endTime',   title: 'Overlaps the next subtitle' },
        'timing.gap':         { severity: 'warning',    waivable: true,  field: 'endTime',   title: 'Gap too short' },
        'timing.short':       { severity: 'warning',    waivable: true,  field: 'endTime',   title: 'Too short on screen' },
        'timing.long':        { severity: 'warning',    waivable: true,  field: 'endTime',   title: 'Too long on screen' },
        'timing.beyondMedia': { severity: 'warning',    waivable: true,  field: 'endTime',   title: 'Runs past the end of the video' },
        'text.untranslated':  { severity: 'error',      waivable: true,  field: 'translatedText', title: 'Untranslated' },
        'text.lineLength':    { severity: 'warning',    waivable: true,  field: 'translatedText', title: 'Line too long' },
        'text.lineCount':     { severity: 'warning',    waivable: true,  field: 'translatedText', title: 'Too many lines' },
        'text.cps':           { severity: 'warning',    waivable: true,  field: 'translatedText', title: 'Reads too fast' },
        'text.sameAsSource':  { severity: 'suggestion', waivable: true,  field: 'translatedText', title: 'Same as the source' },
        'text.whitespace':    { severity: 'suggestion', waivable: true,  field: 'translatedText', title: 'Stray spaces' },
        'text.repeatedWord':  { severity: 'suggestion', waivable: true,  field: 'translatedText', title: 'Repeated word' },
        'text.punctuation':   { severity: 'suggestion', waivable: true,  field: 'translatedText', title: 'Punctuation' },
        'text.brokenTags':    { severity: 'warning',    waivable: true,  field: 'translatedText', title: 'Broken formatting tag' },
        'text.unsupportedFormat': { severity: 'warning', waivable: true, field: 'translatedText', title: 'Formatting the export format cannot keep' },
        'text.badCharacters': { severity: 'warning',    waivable: true,  field: 'translatedText', title: 'Unusual characters' },
        'text.glossary':      { severity: 'warning',    waivable: true,  field: 'translatedText', title: 'Glossary term' },
        'review.notReviewed': { severity: 'error',      waivable: false, field: null,        title: 'Not reviewed' },
        'review.changesNeeded': { severity: 'error',    waivable: false, field: null,        title: 'Reviewer asked for changes' },
        'review.suggestion':  { severity: 'error',      waivable: false, field: 'translatedText', title: 'Suggestion awaiting a decision' },
        'review.flagged':     { severity: 'warning',    waivable: true,  field: 'translatedText', title: 'Flagged by the revisor' },
        'flag.set':           { severity: 'error',      waivable: false, field: null,        title: 'Marked for more work' },
        'note.question':      { severity: 'error',      waivable: false, field: 'comment',   title: 'Open question' },
        'project.empty':      { severity: 'error',      waivable: false, field: null,        title: 'No subtitles' },
        'project.import':     { severity: 'warning',    waivable: false, field: null,        title: 'Import problem' },
    };

    const FLAG_NAMES = { 1: 'Needs translation', 2: 'Needs timing', 4: 'Needs review', 8: 'Question' };
    const REVIEW_FLAG_NAMES = ['', 'Mistranslation', 'Omission', 'Addition', 'Terminology', 'Style', 'Grammar', 'Timing', 'Reading speed', 'Line breaks'];

    // ── Text helpers ──────────────────────────────────────────────────
    const visibleLength = s => [...String(s)].length;
    // Characters a reader actually reads: no whitespace, no markup.
    const readable = s => stripTags(String(s)).replace(/\s/g, '');
    function stripTags(s) {
        return String(s).replace(/<\/?[a-z][^>]*>/gi, '').replace(/\{\\[^}]*\}/g, '');
    }

    /* Finds tags that are opened and never closed, closed and never opened,
       or written so badly a player would print them. */
    function tagProblems(text) {
        const problems = [];
        const stack = [];
        const re = /<(\/?)([a-z][a-z0-9.]*)\b[^<>]*>/gi;
        let m;
        while ((m = re.exec(text))) {
            const name = m[2].toLowerCase().split('.')[0];
            if (m[1]) {
                const at = stack.lastIndexOf(name);
                if (at < 0) problems.push(`</${name}> closes a tag that was never opened`);
                else stack.splice(at, 1);
            } else if (!/\/>$/.test(m[0])) {
                stack.push(name);
            }
        }
        for (const name of stack) problems.push(`<${name}> is never closed`);
        // A '<' that starts something tag-like but never finishes it.
        if (/<\/?[a-z][^<>]*$/im.test(text.replace(re, ''))) problems.push('a tag is missing its closing ">"');
        // ASS override blocks.
        const braces = text.replace(/\{\\[^{}]*\}/g, '');
        if (/\{\\/.test(braces)) problems.push('a "{\\" style block is never closed');
        return problems;
    }

    function tagsUsed(text) {
        const names = new Set();
        const re = /<\/?([a-z][a-z0-9]*)\b[^<>]*>/gi;
        let m;
        while ((m = re.exec(text))) names.add(m[1].toLowerCase());
        return names;
    }

    /* Repeated words ("the the"). Words are compared case-insensitively with
       their punctuation stripped, in any script. */
    function repeatedWord(text) {
        const words = stripTags(text).split(/\s+/).filter(Boolean);
        for (let i = 1; i < words.length; i++) {
            const a = words[i - 1].replace(/[^\p{L}\p{N}]/gu, '').toLocaleLowerCase();
            const b = words[i].replace(/[^\p{L}\p{N}]/gu, '').toLocaleLowerCase();
            // Only when the first carries no punctuation of its own: "No. No."
            // is deliberate, "the the" is not.
            if (a && a === b && !/[.,!?؟،;:…-]$/.test(words[i - 1])) return words[i];
        }
        return null;
    }

    function whitespaceProblem(text) {
        const lines = text.split('\n');
        if (lines.some(l => l !== l.trim())) return 'a line starts or ends with a space';
        if (/[^\S\n]{2,}/.test(text)) return 'two spaces in a row';
        if (lines.length > 1 && lines.some(l => !l.trim())) return 'an empty line inside the subtitle';
        if (/\s[,.!?;:](?!\.)/.test(text.replace(/\.\.\./g, '…'))) return 'a space before punctuation';
        return null;
    }

    function punctuationProblem(text) {
        const t = stripTags(text).replace(/\.\.\./g, '…');
        if (/([,;:!?؟،])\1/.test(t) && !/[!?؟]{2,3}$/.test(t)) return 'doubled punctuation';
        if (/\.\.(?!\.)/.test(t)) return 'two full stops (an ellipsis has three)';
        const pairs = [['(', ')'], ['[', ']'], ['«', '»'], ['“', '”']];
        for (const [o, c] of pairs) {
            if (t.split(o).length !== t.split(c).length) return `unbalanced ${o}${c}`;
        }
        if ((t.match(/"/g) || []).length % 2) return 'an unpaired quotation mark';
        return null;
    }

    function badCharacters(text) {
        if (/�/.test(text)) return 'replacement characters (�) — usually a sign the file was read with the wrong encoding';
        if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) return 'invisible control characters';
        if (/\t/.test(text)) return 'a tab character';
        return null;
    }

    /* Glossary consistency. A term counts as present when it appears as a
       whole word, ignoring case; because languages inflect, a missing target
       is only ever a warning. */
    function glossaryProblems(cue, glossary) {
        if (!glossary?.length) return [];
        const src = ` ${stripTags(cue.originalText || '').toLocaleLowerCase()} `;
        const dst = stripTags(cue.translatedText || '').toLocaleLowerCase();
        if (!dst.trim()) return [];
        const out = [];
        for (const g of glossary) {
            const s = String(g.source || '').trim().toLocaleLowerCase();
            const t = String(g.target || '').trim().toLocaleLowerCase();
            if (!s || !t) continue;
            const re = new RegExp(`(^|[^\\p{L}\\p{N}])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u');
            if (re.test(src) && !dst.includes(t)) out.push(g);
        }
        return out;
    }

    // ── Line breaks ───────────────────────────────────────────────────
    /* Proposes where to break a line so each fits the limit, balancing the
       lines and preferring breaks after punctuation and before a new clause.
       Only whitespace moves: the words are exactly the same, which the result
       is checked for. Returns null when no layout fits. */
    const BREAK_BEFORE = /^(and|but|or|so|because|when|if|that|which|who|و|ثم|لكن|أو|لأن|عندما|إذا|الذي|التي)$/iu;
    function suggestLineBreaks(text, maxChars, maxLines) {
        const words = String(text).split(/\s+/).filter(Boolean);
        if (!words.length) return null;
        const flat = words.join(' ');
        if (visibleLength(stripTags(flat)) <= maxChars) return flat === text ? null : flat;
        let best = null;
        const tryLayout = breaks => {
            const lines = [];
            let start = 0;
            for (const b of [...breaks, words.length]) { lines.push(words.slice(start, b).join(' ')); start = b; }
            const lens = lines.map(l => visibleLength(stripTags(l)));
            if (lens.some(n => n > maxChars)) return;
            let score = Math.max(...lens) - Math.min(...lens);
            for (const b of breaks) {
                if (/[.,!?؟،;:…]$/.test(words[b - 1])) score -= 6;
                if (BREAK_BEFORE.test(words[b].replace(/[^\p{L}]/gu, ''))) score -= 3;
                // Never leave a one-word orphan line if it can be helped.
                if (b === 1 || b === words.length - 1) score += 8;
            }
            // Pyramid shape: a slightly shorter top line reads better.
            if (lens.length === 2 && lens[0] > lens[1]) score += 1;
            if (!best || score < best.score) best = { score, text: lines.join('\n') };
        };
        for (let i = 1; i < words.length; i++) {
            tryLayout([i]);
            if (maxLines >= 3) for (let j = i + 1; j < words.length; j++) tryLayout([i, j]);
        }
        if (!best) return null;
        // Paranoia, by design: the suggestion may only move whitespace.
        if (best.text.replace(/\s+/g, '') !== String(text).replace(/\s+/g, '')) return null;
        return best.text === text ? null : best.text;
    }

    // ── Validation ────────────────────────────────────────────────────
    function parseWaivers(cue) {
        if (Array.isArray(cue.waivers)) return cue.waivers;
        if (!cue.waiversJson) return [];
        try { const w = JSON.parse(cue.waiversJson); return Array.isArray(w) ? w : []; } catch { return []; }
    }

    /* A short fingerprint of what a finding is about, so an acknowledgement
       stops applying once the line it was given for is edited. */
    function fingerprint(cue) {
        const s = `${cue.startTime}|${cue.endTime}|${cue.translatedText || ''}|${cue.originalText || ''}`;
        let h = 2166136261;
        for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
        return (h >>> 0).toString(36);
    }

    /* Validates the whole project.
         cues      — the track, in display order
         settings  — { profile, rules, glossary, acknowledged, importIssues }
         context   — { mediaDuration, fps }
       Returns { findings, byCue, counts, blocking, rules }. */
    function validate(cues, settings = {}, context = {}) {
        const profile = Core.normaliseProfile(settings.profile);
        const rules = normaliseRules(settings.rules);
        const glossary = Array.isArray(settings.glossary) ? settings.glossary : [];
        const acknowledged = settings.acknowledged || {};
        const format = FORMATS[rules.exportFormat];
        const findings = [];

        const severityOf = code => {
            const override = rules.severity[code];
            // Structural errors keep their severity whatever the overrides say.
            if (CHECKS[code].severity === 'error' && !CHECKS[code].waivable) return 'error';
            return ['error', 'warning', 'suggestion', 'off'].includes(override) ? override : CHECKS[code].severity;
        };

        const add = (cue, index, code, message, action, extra = {}) => {
            const severity = extra.severity || severityOf(code);
            if (severity === 'off') return;
            const def = CHECKS[code];
            const waiver = cue && def.waivable ? parseWaivers(cue).find(w => w.code === code && String(w.reason || '').trim()) : null;
            const key = cue ? `${code}:${cue.id}:${extra.line ?? ''}:${fingerprint(cue)}` : `${code}::${extra.key || ''}`;
            findings.push({
                code, severity, title: def.title, message, action,
                cueId: cue ? cue.id : null,
                index: cue ? index : null,
                startTime: cue ? cue.startTime : null,
                field: extra.field !== undefined ? extra.field : def.field,
                line: extra.line ?? null,
                fix: extra.fix || null,
                waivable: def.waivable,
                waived: waiver ? { reason: waiver.reason, by: waiver.by || null, at: waiver.at || null } : null,
                acknowledged: severity === 'warning' && !!acknowledged[key],
                key,
            });
        };

        if (!cues.length) add(null, null, 'project.empty', 'The project has no subtitles yet.', 'Import a script or add lines.');
        for (const issue of settings.importIssues || []) {
            add(null, null, 'project.import', issue.message, 'Check the entry against the original file, then dismiss this note in the issues panel.', { key: issue.id || issue.message });
        }

        const spans = cues.map(c => ({ a: Core.seconds(c.startTime), b: Core.seconds(c.endTime) }));
        const structural = Core.analyze(cues, profile);   // overlap/gap sweep, shared with the rest of the editor
        const mediaDuration = Number.isFinite(context.mediaDuration) && context.mediaDuration > 0 ? context.mediaDuration : null;
        const frame = 1 / (context.fps || 25);

        cues.forEach((cue, i) => {
            const n = i + 1;
            const { a, b } = spans[i];
            const text = cue.translatedText || '';
            const plain = stripTags(text);
            const lines = text.split('\n');

            // ── Timing ──
            if (!Number.isFinite(a) || !Number.isFinite(b)) {
                add(cue, i, 'timing.malformed', `Subtitle ${n} has a timecode the editor cannot read.`, 'Retype the in- and out-times as HH:MM:SS,mmm.',
                    { field: Number.isFinite(a) ? 'endTime' : 'startTime' });
            } else if (b <= a) {
                add(cue, i, 'timing.invalid', `Subtitle ${n} ends ${b === a ? 'at the same moment it starts' : 'before it starts'} (in ${cue.startTime}, out ${cue.endTime}), so it can never be shown.`,
                    'Set an out-time after the in-time.', { fix: { kind: 'setOutByCps', label: 'Set the out-time from the reading speed' } });
            } else {
                const dur = b - a;
                const prev = i > 0 ? spans[i - 1] : null;
                if (prev && Number.isFinite(prev.a) && a < prev.a - 1e-6) {
                    add(cue, i, 'timing.order', `Subtitle ${n} starts before subtitle ${n - 1}, so the list is out of time order.`,
                        'Sort the subtitles by time, or correct the in-time.', { fix: { kind: 'sortByTime', label: 'Sort all subtitles by time' } });
                }
                const issues = structural[i];
                if (issues.includes('Overlapping cues') && !rules.allowOverlaps) {
                    const other = cues.findIndex((c, j) => j !== i && spans[j].a < b && spans[j].b > a);
                    add(cue, i, 'timing.overlap', `Subtitle ${n} is on screen at the same time as subtitle ${other + 1}.`,
                        'Shorten one of them, or allow overlaps in the project rules if two speakers really do overlap.',
                        { fix: other > i ? { kind: 'resolveOverlap', label: `End it ${Math.round(profile.minGapSeconds * 1000)} ms before #${other + 1}`, other: cues[other].id } : null });
                } else if (issues.includes('Short gap')) {
                    const nextStart = Math.min(...spans.filter(s => s.a >= b).map(s => s.a));
                    add(cue, i, 'timing.gap', `Only ${Math.round((nextStart - b) * 1000)} ms between subtitle ${n} and the next one; the minimum is ${Math.round(profile.minGapSeconds * 1000)} ms. Viewers see a flicker.`,
                        'Close the gap completely, or open it to the minimum.', { fix: { kind: 'closeGap', label: 'Open the gap to the minimum' } });
                }
                if (dur < profile.minDurationSeconds) {
                    add(cue, i, 'timing.short', `Subtitle ${n} is on screen for ${dur.toFixed(2)} s; the minimum is ${profile.minDurationSeconds} s.`,
                        'Extend the out-time, or merge it with a neighbour.', { fix: { kind: 'extendToMin', label: `Extend to ${profile.minDurationSeconds} s` } });
                }
                if (dur > profile.maxDurationSeconds) {
                    add(cue, i, 'timing.long', `Subtitle ${n} stays up for ${dur.toFixed(2)} s; the maximum is ${profile.maxDurationSeconds} s.`,
                        'Shorten it, or split it into two.', { fix: { kind: 'trimToMax', label: `Shorten to ${profile.maxDurationSeconds} s` } });
                }
                if (mediaDuration && b > mediaDuration + frame) {
                    add(cue, i, 'timing.beyondMedia', `Subtitle ${n} ends at ${cue.endTime}, after the video ends (${Core.timestamp(mediaDuration)}).`,
                        'Check the timing against the video; if the video was replaced, the whole track may need shifting.');
                }
                const chars = visibleLength(readable(text));
                if (text.trim() && chars / dur > profile.maxCps) {
                    add(cue, i, 'text.cps', `Subtitle ${n} needs ${(chars / dur).toFixed(1)} characters per second; the limit is ${profile.maxCps}.`,
                        'Shorten the wording or give it more time.', { fix: { kind: 'setOutByCps', label: 'Lengthen to the reading-speed limit' } });
                }
            }

            // ── Text ──
            const flags = cue.flags | 0;
            if (!text.trim()) {
                if (rules.requireTranslation) {
                    add(cue, i, 'text.untranslated', `Subtitle ${n} has no translation yet.`,
                        'Translate it — or, if it is meant to stay empty (a music cue, a sign that needs no subtitle), waive this with a reason.');
                }
            } else {
                const longLines = lines.map((l, k) => ({ k, len: visibleLength(stripTags(l)) })).filter(x => x.len > profile.maxCharsPerLine);
                for (const { k, len } of longLines) {
                    const suggestion = suggestLineBreaks(text, profile.maxCharsPerLine, profile.maxLines);
                    add(cue, i, 'text.lineLength', `Line ${k + 1} of subtitle ${n} has ${len} characters; the limit is ${profile.maxCharsPerLine}.`,
                        suggestion ? 'Break the line differently — a suggestion is ready to preview.' : 'Shorten the wording; no line break makes it fit.',
                        { line: k, fix: suggestion ? { kind: 'lineBreaks', label: 'Preview a better line break', text: suggestion } : null });
                }
                if (lines.length > profile.maxLines) {
                    const suggestion = suggestLineBreaks(text, profile.maxCharsPerLine, profile.maxLines);
                    add(cue, i, 'text.lineCount', `Subtitle ${n} has ${lines.length} lines; the limit is ${profile.maxLines}.`,
                        suggestion ? 'Re-break it — a suggestion is ready to preview.' : 'Shorten the wording or split the subtitle.',
                        { fix: suggestion ? { kind: 'lineBreaks', label: 'Preview a better line break', text: suggestion } : null });
                }
                if ((cue.originalText || '').trim() && plain.trim() === stripTags(cue.originalText).trim()) {
                    add(cue, i, 'text.sameAsSource', `Subtitle ${n} reads exactly like its source.`,
                        'Fine for names, numbers or songs left untranslated — waive it with that reason; otherwise translate it.');
                }
                const ws = whitespaceProblem(text);
                if (ws) add(cue, i, 'text.whitespace', `Subtitle ${n} has ${ws}.`, 'Tidy the spacing.', { fix: { kind: 'tidySpaces', label: 'Preview tidied spacing' } });
                const rep = repeatedWord(text);
                if (rep) add(cue, i, 'text.repeatedWord', `Subtitle ${n} repeats "${rep}".`, 'Remove the repetition if it is a typo; waive it if the character really says it twice.');
                const punct = punctuationProblem(text);
                if (punct) add(cue, i, 'text.punctuation', `Subtitle ${n} has ${punct}.`, 'Check the punctuation.');
                const tags = tagProblems(text);
                if (tags.length) add(cue, i, 'text.brokenTags', `Subtitle ${n}: ${tags.join('; ')}. A player would show the tag as text.`, 'Close or remove the tag.');
                const unsupported = [...tagsUsed(text)].filter(t => !format.tags.includes(t));
                const assBlocks = /\{\\[^}]*\}/.test(text) && !format.assOverrides;
                if (unsupported.length || assBlocks) {
                    const what = [...unsupported.map(t => `<${t}>`), ...(assBlocks ? ['ASS style blocks {\\…}'] : [])].join(', ');
                    add(cue, i, 'text.unsupportedFormat', `Subtitle ${n} uses ${what}, which ${format.label} export cannot keep.`,
                        'Remove the formatting, or choose an export format that supports it.');
                }
                const bad = badCharacters(text);
                if (bad) add(cue, i, 'text.badCharacters', `Subtitle ${n} contains ${bad}.`, 'Retype the affected characters.');
                for (const g of glossaryProblems(cue, glossary)) {
                    add(cue, i, 'text.glossary', `Subtitle ${n} has "${g.source}" in the source, but the translation does not use the glossary term "${g.target}".`,
                        'Use the glossary term, or waive this if the term is inflected or the context differs.', { line: null, key: g.source });
                }
            }

            // ── Review, flags, notes ──
            if (rules.requireReview && (cue.reviewState | 0) !== 1 && (cue.status | 0) !== 3) {
                add(cue, i, 'review.notReviewed', `Subtitle ${n} has not been reviewed.`, 'Review it and mark it reviewed.');
            }
            if ((cue.reviewState | 0) === 2) {
                add(cue, i, 'review.changesNeeded', `The reviewer asked for changes to subtitle ${n}.`, 'Make the change, then mark it reviewed again.');
            }
            if ((cue.suggestionState | 0) === 1 && (cue.suggestedText || '').trim()) {
                add(cue, i, 'review.suggestion', `The revisor suggested different wording for subtitle ${n}.`, 'Accept or dismiss the suggestion.');
            }
            if ((cue.reviewFlag | 0) !== 0) {
                add(cue, i, 'review.flagged', `The revisor flagged subtitle ${n}: ${REVIEW_FLAG_NAMES[cue.reviewFlag | 0] || 'see note'}${cue.reviewNote ? ` — "${cue.reviewNote}"` : ''}.`,
                    'Address the note, then waive this with what you did.');
            }
            for (const bit of [1, 2, 4]) {
                if (flags & bit) add(cue, i, 'flag.set', `Subtitle ${n} is marked "${FLAG_NAMES[bit]}".`, 'Do the work, then clear the mark.', { key: bit });
            }
            if ((flags & 8) && !cue.commentResolved) {
                add(cue, i, 'note.question', `Subtitle ${n} has an open question${cue.comment ? `: "${String(cue.comment).slice(0, 80)}"` : ''}.`, 'Answer it, then mark it resolved.');
            }
        });

        const active = findings.filter(f => !f.waived);
        const counts = {
            error: active.filter(f => f.severity === 'error').length,
            warning: active.filter(f => f.severity === 'warning').length,
            unacknowledged: active.filter(f => f.severity === 'warning' && !f.acknowledged).length,
            suggestion: active.filter(f => f.severity === 'suggestion').length,
            waived: findings.length - active.length,
        };
        const blocking = counts.error
            + (rules.warningsForDone === 'block' ? counts.warning : rules.warningsForDone === 'acknowledge' ? counts.unacknowledged : 0);

        const byCue = new Map();
        for (const f of findings) {
            if (f.cueId == null) continue;
            if (!byCue.has(f.cueId)) byCue.set(f.cueId, []);
            byCue.get(f.cueId).push(f);
        }
        return { findings, byCue, counts, blocking, rules, profile };
    }

    const SEVERITY_ORDER = { error: 0, warning: 1, suggestion: 2 };

    /* Ordered for the issues panel and for next/previous problem: by
       severity first only when asked, otherwise by position in the track. */
    function ordered(findings, { bySeverity = false } = {}) {
        return [...findings].sort((x, y) =>
            (bySeverity ? SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity] : 0)
            || (x.index ?? -1) - (y.index ?? -1)
            || SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity]);
    }

    /* Plain-language list of what still stands between the project and Done,
       e.g. "3 untranslated subtitles, 2 timing errors and unsaved changes". */
    function remainingSummary(result, { unsaved = false, pendingCheck = false } = {}) {
        const active = result.findings.filter(f => !f.waived);
        const errors = active.filter(f => f.severity === 'error');
        const count = (pred) => errors.filter(pred).length;
        const parts = [];
        const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
        const untranslated = count(f => f.code === 'text.untranslated');
        const timing = count(f => f.code.startsWith('timing.'));
        const review = count(f => f.code.startsWith('review.'));
        const flags = count(f => f.code === 'flag.set' || f.code === 'note.question');
        const other = errors.length - untranslated - timing - review - flags;
        if (untranslated) parts.push(plural(untranslated, 'untranslated subtitle', 'untranslated subtitles'));
        if (timing) parts.push(plural(timing, 'timing error', 'timing errors'));
        if (review) parts.push(plural(review, 'review item', 'review items'));
        if (flags) parts.push(plural(flags, 'open flag or question', 'open flags or questions'));
        if (other) parts.push(plural(other, 'other error', 'other errors'));
        const rules = result.rules;
        if (rules.warningsForDone === 'block' && result.counts.warning) parts.push(plural(result.counts.warning, 'warning', 'warnings'));
        if (rules.warningsForDone === 'acknowledge' && result.counts.unacknowledged) parts.push(plural(result.counts.unacknowledged, 'warning to review', 'warnings to review'));
        if (unsaved) parts.push('unsaved changes');
        if (pendingCheck) parts.push('a final check still running');
        if (!parts.length) return '';
        return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
    }

    const api = { validate, ordered, remainingSummary, suggestLineBreaks, normaliseRules, tagProblems, stripTags,
                  repeatedWord, whitespaceProblem, punctuationProblem, glossaryProblems, fingerprint,
                  CHECKS, FORMATS, DEFAULT_RULES, FLAG_NAMES };
    if (typeof module !== 'undefined') module.exports = api;
    else root.TmQuality = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
