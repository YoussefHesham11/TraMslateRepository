/* ══════════════════════════════════════════════════════════════════════
   TmTools — editing and timing tools that change many subtitles at once.

   Every one of them shows exactly what will change before it changes it,
   keeps a recovery copy on the server before large changes, and lands as a
   single undo step:
     • shift (all / from selected / range / zero out) — preview added to the
       existing controls
     • two-point synchronisation, for timing that drifts
     • frame-rate conversion, for a video re-timed between 23.976/24/25 fps
     • bulk actions on the selected subtitles
     • find & replace in translations and (unlocked) source text
     • moving a subtitle up or down in the list
   ══════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    const X = {};
    const $ = id => document.getElementById(id);
    const sec = tc => SubtitleCore.seconds(tc);
    const ts = s => SubtitleCore.timestamp(s);
    const canTranslate = () => typeof CAN_EDIT_TRANSLATION === 'undefined' || CAN_EDIT_TRANSLATION;
    const BIG = 20;   // changes beyond this many subtitles get a server recovery copy first

    function rowsHtml(rows, head) {
        const show = rows.length > 12 ? [...rows.slice(0, 6), null, ...rows.slice(-6)] : rows;
        return `<table class="tm-preview-table"><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>`
            + show.map(r => r ? `<tr>${r.map(c => `<td dir="auto">${c}</td>`).join('')}</tr>` : `<tr><td colspan="${head.length}">… ${rows.length - 12} more …</td></tr>`).join('')
            + '</tbody></table>';
    }

    /* Shows timing changes as before → after and applies them on confirm.
       changes: [{ ev, start, end }] in seconds. */
    async function previewTiming(title, changes, note = '') {
        changes = changes.filter(c => Math.abs(c.start - sec(c.ev.startTime)) > 0.0005 || Math.abs(c.end - sec(c.ev.endTime)) > 0.0005);
        if (!changes.length) { await say(title, 'Nothing would change.'); return false; }
        const bad = changes.filter(c => c.start < 0 || c.end >= 86400 || c.end <= c.start);
        if (bad.length) { await say(title, `That would put ${bad.length} subtitle${bad.length === 1 ? '' : 's'} before 00:00:00, past 24 hours, or with no duration. Nothing was changed.`); return false; }
        const rows = changes.map(c => {
            const i = events.indexOf(c.ev);
            return [`#${i + 1}`, `<span class="tm-diff-old">${c.ev.startTime} → ${c.ev.endTime}</span>`, `<span class="tm-diff-new">${ts(c.start)} → ${ts(c.end)}</span>`];
        });
        const ok = await chooseDialog({
            title,
            text: `${changes.length} subtitles change timing.`,
            html: `<p><b>${changes.length} subtitle${changes.length === 1 ? '' : 's'}</b> change timing. Text is not touched.</p>${note ? `<p class="tm-modal-note">${escapeHtml(note)}</p>` : ''}`
                + rowsHtml(rows, ['#', 'Now', 'After']) + '<p>One undo step reverses it.</p>',
            choices: [{ label: 'Apply', value: true, primary: true }, { label: 'Cancel', value: false }],
        });
        if (!ok) return false;
        if (changes.length > BIG) await keepCheckpoint(3, `Before: ${title}`);
        commitHistory();
        for (const c of changes) { c.ev.startTime = ts(c.start); c.ev.endTime = ts(c.end); }
        markDirty();
        commitHistory();
        renderEvents();
        renderTimelineBlocks();
        return true;
    }
    X.previewTiming = previewTiming;

    // ══ Two-point synchronisation ═════════════════════════════════════
    /* Two subtitles whose correct times are known (typically one near the
       start, one near the end) define a straight line: every time t becomes
       a·t + b. That corrects both an offset and a gradual drift, which a
       plain shift cannot. */
    async function twoPointSync() {
        if (events.length < 2) { await say('Sync with two points', 'Two-point sync needs at least two subtitles.'); return; }
        const first = Math.max(0, events.findIndex(ev => selectedIds.has(ev.id)));
        const params = await form('Sync with two points', `
            <p>Pick two subtitles far apart — one early, one late — and enter when each <b>should</b> start. Every subtitle in between and beyond is stretched or squeezed to match, which fixes timing that drifts further out as the film goes on.</p>
            <div class="tm-sync-grid">
                <label>Subtitle # <input type="number" name="a" min="1" max="${events.length}" value="${first + 1}" /></label>
                <label>should start at <input type="text" name="ta" class="tm-mono" placeholder="00:00:00,000" /></label>
                <button type="button" class="tm-btn-sm" data-playhead="ta">Use playhead</button>
                <label>Subtitle # <input type="number" name="b" min="1" max="${events.length}" value="${events.length}" /></label>
                <label>should start at <input type="text" name="tb" class="tm-mono" placeholder="00:00:00,000" /></label>
                <button type="button" class="tm-btn-sm" data-playhead="tb">Use playhead</button>
            </div>
            <label><input type="checkbox" name="onlySelected"${selectedIds.size > 1 ? '' : ' disabled'} /> Only the selected subtitles (${selectedIds.size})</label>`, 'Preview');
        if (!params) return;
        const a = events[Number(params.a) - 1], b = events[Number(params.b) - 1];
        const ta = readTime(params.ta), tb = readTime(params.tb);
        if (!a || !b || a === b) { await say('Sync with two points', 'Choose two different subtitles.'); return; }
        if (!Number.isFinite(ta) || !Number.isFinite(tb)) { await say('Sync with two points', 'Enter both correct start times, like 00:01:02,500 or 00:01:02:12 (frames).'); return; }
        const sa = sec(a.startTime), sb = sec(b.startTime);
        if (Math.abs(sb - sa) < 1) { await say('Sync with two points', 'The two subtitles start less than a second apart; pick two further apart for an accurate correction.'); return; }
        const k = (tb - ta) / (sb - sa);
        const c = ta - k * sa;
        if (!(k > 0.5 && k < 2)) { await say('Sync with two points', `That would stretch the timing by ${(k * 100).toFixed(1)}%, which is almost certainly a typo. Check the two times.`); return; }
        const targets = params.onlySelected ? events.filter(ev => selectedIds.has(ev.id)) : events;
        await previewTiming('Sync with two points', targets.map(ev => ({ ev, start: k * sec(ev.startTime) + c, end: k * sec(ev.endTime) + c })),
            `Speed factor ${k.toFixed(5)} (${((k - 1) * 100).toFixed(3)}%), offset ${c >= 0 ? '+' : '−'}${Math.abs(c).toFixed(3)} s.`);
    }

    // ══ Frame-rate conversion ═════════════════════════════════════════
    /* SRT, VTT and ASS store times, so changing the fps selector never moves
       them; it only affects how frames are shown and how frame-based scripts
       (HH:MM:SS:FF) are read. When the video itself was converted — the
       classic 25 fps PAL speed-up of a 23.976 fps film — the subtitle times
       have to be scaled by the ratio of the two rates. */
    async function convertFrameRate() {
        const rates = ['23.976', '24', '25', '29.97', '30'];
        const opts = sel => rates.map(r => `<option value="${r}"${r === sel ? ' selected' : ''}>${r} fps</option>`).join('');
        const params = await form('Convert frame rate', `
            <p>Use this when the <b>video</b> was converted to another frame rate — for example a 23.976 fps film released at 25 fps — and the subtitles now drift. Every time is multiplied by <i>from ÷ to</i>.</p>
            <p class="tm-modal-note">SRT, VTT and ASS store real times, so the fps selector in the top bar never moves them; it only sets how frames are counted and how frame-based scripts (HH:MM:SS:FF) are read. This tool is the explicit conversion.</p>
            <div class="tm-sync-grid">
                <label>Subtitles were timed for <select name="from" class="tm-speed-select">${opts('23.976')}</select></label>
                <label>The video now runs at <select name="to" class="tm-speed-select">${opts('25')}</select></label>
            </div>`, 'Preview');
        if (!params) return;
        const from = Number(params.from), to = Number(params.to);
        if (from === to) { await say('Convert frame rate', 'Choose two different frame rates.'); return; }
        const k = from / to;
        const changed = await previewTiming(`Convert ${params.from} → ${params.to} fps`, events.map(ev => ({ ev, start: sec(ev.startTime) * k, end: sec(ev.endTime) * k })),
            `Each time is multiplied by ${k.toFixed(6)}; a subtitle at 1:00:00 moves to ${ts(3600 * k)}.`);
        const alsoFps = changed && await chooseDialog({ title: 'Frame rate', text: `Also set the project's frame rate to ${params.to} fps, so frames are counted to match the new video?`,
            choices: [{ label: `Set ${params.to} fps`, value: true, primary: true }, { label: 'Keep as it is', value: false }] });
        if (alsoFps) {
            const select = $('fpsSelect');
            if (select && [...select.options].some(o => o.value === params.to)) { select.value = params.to; select.dispatchEvent(new Event('change')); }
        }
    }

    // ══ Bulk actions on the selection ═════════════════════════════════
    async function bulkActions() {
        const targets = events.filter(ev => selectedIds.has(ev.id));
        if (targets.length < 1) { await say('Bulk actions', 'Select subtitles first: Ctrl-click or Shift-click boxes on the timeline (or use a filter and pick them), then try again.'); return; }
        const params = await form(`Change ${targets.length} selected subtitle${targets.length === 1 ? '' : 's'}`, `
            <label>Action
                <select name="action" class="tm-speed-select">
                    <option value="flag">Mark as needing work…</option>
                    <option value="unflag">Clear "needs …" marks</option>
                    <option value="reviewed">Mark reviewed</option>
                    <option value="notReviewed">Mark not reviewed</option>
                    ${canTranslate() ? '<option value="status">Set status…</option>' : ''}
                    <option value="bookmark">Bookmark</option>
                    <option value="unbookmark">Remove bookmarks</option>
                    <option value="shift">Shift timing by…</option>
                    ${canTranslate() ? '<option value="copySource">Copy source into empty translations</option>' : ''}
                    ${canTranslate() ? '<option value="delete">Delete</option>' : ''}
                </select></label>
            <label data-for="flag">Mark <select name="flag" class="tm-speed-select"><option value="1">Needs translation</option><option value="2">Needs timing</option><option value="4">Needs review</option></select></label>
            <label data-for="status">Status <select name="status" class="tm-speed-select">${CUE_STATUS.map(s => `<option value="${s.value}">${s.label}</option>`).join('')}</select></label>
            <label data-for="shift">Shift by <input name="amount" class="tm-mono" placeholder="+00:00:01,500 or -0.5" /></label>`, 'Preview', box => {
            const sync = () => { const a = box.querySelector('[name="action"]').value; box.querySelectorAll('[data-for]').forEach(l => { l.hidden = l.dataset.for !== a; }); };
            box.querySelector('[name="action"]').addEventListener('change', sync);
            sync();
        });
        if (!params) return;
        const n = targets.length;
        const plural = `${n} subtitle${n === 1 ? '' : 's'}`;
        const apply = async (title, describe, mutate, destructive = false) => {
            const rows = targets.map(ev => [`#${events.indexOf(ev) + 1}`, escapeHtml((ev.translatedText || ev.originalText || '').slice(0, 60)), describe(ev)]);
            const ok = await chooseDialog({ title, text: `${plural} will change.`,
                html: `<p><b>${plural}</b> will change.</p>${rowsHtml(rows, ['#', 'Subtitle', 'Change'])}<p>${destructive ? 'A copy is kept in the version history first. ' : ''}One undo step reverses it.</p>`,
                choices: [{ label: 'Apply', value: true, primary: true }, { label: 'Cancel', value: false }] });
            if (!ok) return;
            if (destructive || n > BIG) await keepCheckpoint(3, `Before: ${title}`);
            commitHistory();
            mutate();
            markDirty();
            commitHistory();
            renderEvents();
            renderTimelineBlocks();
        };
        switch (params.action) {
            case 'flag': {
                const bit = Number(params.flag);
                return apply('Mark as needing work', () => TmQuality.FLAG_NAMES[bit], () => targets.forEach(ev => { ev.flags = (ev.flags | 0) | bit; }));
            }
            case 'unflag': return apply('Clear marks', () => 'all "needs …" marks cleared', () => targets.forEach(ev => { ev.flags = (ev.flags | 0) & 8; }));
            case 'reviewed': return apply('Mark reviewed', () => 'reviewed', () => targets.forEach(ev => { ev.reviewState = 1; }));
            case 'notReviewed': return apply('Mark not reviewed', () => 'not reviewed', () => targets.forEach(ev => { ev.reviewState = 0; }));
            case 'bookmark': return apply('Bookmark', () => 'bookmarked', () => targets.forEach(ev => { ev.bookmarked = true; }));
            case 'unbookmark': return apply('Remove bookmarks', () => 'bookmark removed', () => targets.forEach(ev => { ev.bookmarked = false; }));
            case 'status': {
                const s = Number(params.status);
                const label = CUE_STATUS.find(x => x.value === s)?.label;
                return apply('Set status', () => label, () => targets.forEach(ev => { ev.status = s; }));
            }
            case 'copySource': {
                const empty = targets.filter(ev => !(ev.translatedText || '').trim() && (ev.originalText || '').trim());
                if (!empty.length) return say('Copy source', 'None of the selected subtitles is both untranslated and has source text.');
                return apply('Copy source into empty translations', ev => (!(ev.translatedText || '').trim() && (ev.originalText || '').trim()) ? 'source copied' : 'unchanged (already translated)',
                    () => empty.forEach(ev => { ev.translatedText = ev.originalText; }));
            }
            case 'shift': {
                const amount = SubtitleCore.parseShiftAmount(params.amount, fps);
                if (!Number.isFinite(amount) || amount === 0) return say('Shift', 'Enter an amount such as +1.5, -0.25, or -00:00:01:12.');
                return previewTiming(`Shift ${plural} by ${amount > 0 ? '+' : '−'}${Math.abs(amount)} s`, targets.map(ev => ({ ev, start: sec(ev.startTime) + amount, end: sec(ev.endTime) + amount })));
            }
            case 'delete': {
                const ids = new Set(targets.map(ev => ev.id));
                return apply('Delete', () => 'deleted', () => { events = events.filter(ev => !ids.has(ev.id)); selectedIds = new Set(); activeId = null; }, true);
            }
        }
    }

    // ══ Find & replace ════════════════════════════════════════════════
    /* Replaces in translations, in source text, or both, with a preview of
       every change. Source lines that came from an imported script are
       locked and are reported rather than changed. */
    async function findReplace() {
        const find = $('findText').value;
        const replace = $('replaceText').value;
        if (!find) { $('findText').focus(); return; }
        const scope = $('findScope')?.value || 'translation';
        const matchCase = $('findCase')?.checked;
        const whole = $('findWhole')?.checked;
        const flags = matchCase ? 'gu' : 'giu';
        const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(whole ? `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])` : escaped, flags);
        const fields = scope === 'both' ? ['translatedText', 'originalText'] : scope === 'source' ? ['originalText'] : ['translatedText'];
        const changes = [];
        let lockedHits = 0;
        events.forEach((ev, i) => {
            for (const f of fields) {
                const before = ev[f] || '';
                re.lastIndex = 0;
                if (!re.test(before)) continue;
                if (f === 'originalText' && (ev.originalLocked || !canTranslate())) { lockedHits++; continue; }
                if (f === 'translatedText' && (!canTranslate() || lockedIds.has(ev.id))) { lockedHits++; continue; }
                const after = before.replace(re, () => replace);
                changes.push({ ev, f, before, after, i });
            }
        });
        if (!changes.length) {
            await say('Find & replace', lockedHits ? `"${find}" only appears in ${lockedHits} locked line${lockedHits === 1 ? '' : 's'} (imported source text or locked subtitles), which are not changed.` : `"${find}" was not found${scope === 'translation' ? ' in the translations' : ''}.`);
            return;
        }
        const mark = s => escapeHtml(s).replace(new RegExp(escapeHtml(find).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags), m => `<mark>${m}</mark>`);
        const rows = changes.map(c => [`#${c.i + 1}`, c.f === 'originalText' ? 'Source' : 'Translation', mark(c.before), escapeHtml(c.after)]);
        const ok = await chooseDialog({
            title: `Replace "${find}" with "${replace}"`,
            text: `${changes.length} lines change.`,
            html: `<p><b>${changes.length} line${changes.length === 1 ? '' : 's'}</b> change${lockedHits ? `; ${lockedHits} match${lockedHits === 1 ? '' : 'es'} in locked lines stay as they are` : ''}.</p>${rowsHtml(rows, ['#', 'Field', 'Now', 'After'])}<p>One undo step reverses it.</p>`,
            choices: [{ label: `Replace in ${changes.length}`, value: true, primary: true }, { label: 'Cancel', value: false }],
        });
        if (!ok) return;
        if (changes.length > BIG) await keepCheckpoint(3, `Before replacing "${find}"`);
        commitHistory();
        for (const c of changes) c.ev[c.f] = c.after;
        markDirty();
        commitHistory();
        renderEvents();
        renderTimelineBlocks();
        updateOverlay();
    }

    // ══ Moving a subtitle in the list ═════════════════════════════════
    function moveInList(direction) {
        if (!canTranslate()) { translatorOnly(); return; }
        const i = events.findIndex(ev => ev.id === activeId);
        const j = i + direction;
        if (i < 0 || j < 0 || j >= events.length) return;
        commitHistory();
        [events[i], events[j]] = [events[j], events[i]];
        markDirty();
        commitHistory();
        renderEvents();
        renderTimelineBlocks();
        selectEvent(events[j].id, { scrollBlock: 'center' });
        TmWorkspace?.announce?.(`Moved to position ${j + 1}. Times are unchanged; if the list is now out of time order the issues panel offers to sort it.`);
    }

    // ══ Small helpers ═════════════════════════════════════════════════
    function readTime(raw) {
        const s = String(raw || '').trim();
        if (/^\d{1,2}:\d{2}:\d{2}[:;]\d{1,2}$/.test(s)) return SubtitleCore.framesToSeconds(s, fps);
        const v = SubtitleCore.seconds(s.replace('.', ','));
        if (Number.isFinite(v)) return v;
        return /^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
    }

    function say(title, text) { return chooseDialog({ title, text, choices: [{ label: 'OK', value: true, primary: true }] }); }

    /* A small form in a dialog; resolves to its named values, or null. */
    function form(title, inner, submit, setup) {
        return new Promise(resolve => {
            const back = document.createElement('div');
            back.className = 'tm-modal-backdrop';
            back.innerHTML = `<form class="tm-modal tm-transfer-modal tm-tool-form" role="dialog" aria-modal="true" aria-labelledby="tmToolTitle">
                <h3 class="tm-modal-title" id="tmToolTitle">${escapeHtml(title)}</h3>${inner}
                <div class="tm-modal-actions"><button type="button" class="tm-btn-sm" data-cancel>Cancel</button>
                <button type="submit" class="tm-btn tm-btn-primary" style="width:auto;">${escapeHtml(submit)}</button></div></form>`;
            const f = back.querySelector('form');
            const done = v => { back.remove(); resolve(v); };
            f.addEventListener('submit', e => {
                e.preventDefault();
                const out = {};
                f.querySelectorAll('[name]').forEach(el => { out[el.name] = el.type === 'checkbox' ? el.checked : el.value; });
                done(out);
            });
            f.addEventListener('click', e => {
                const p = e.target.closest('[data-playhead]');
                if (p && video) f.querySelector(`[name="${p.dataset.playhead}"]`).value = ts(video.currentTime);
            });
            back.querySelector('[data-cancel]').addEventListener('click', () => done(null));
            back.addEventListener('keydown', e => { if (e.key === 'Escape') done(null); });
            document.body.appendChild(back);
            setup?.(f);
            f.querySelector('input:not([disabled]),select')?.focus();
        });
    }

    // ══ Wiring ════════════════════════════════════════════════════════
    $('btnBulk')?.addEventListener('click', bulkActions);
    $('btnSyncTwo')?.addEventListener('click', twoPointSync);
    $('btnConvertFps')?.addEventListener('click', convertFrameRate);
    X.findReplace = findReplace;
    if (typeof Shortcuts !== 'undefined') {
        Shortcuts.on('bulkActions', bulkActions);
        Shortcuts.on('twoPointSync', twoPointSync);
        Shortcuts.on('convertFrameRate', convertFrameRate);
        Shortcuts.on('moveCueUp', () => moveInList(-1));
        Shortcuts.on('moveCueDown', () => moveInList(1));
    }
    window.TmTools = X;
})();
