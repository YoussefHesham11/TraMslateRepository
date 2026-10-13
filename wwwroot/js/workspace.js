/* ══════════════════════════════════════════════════════════════════════
   TmWorkspace — the parts of the editor built on top of validation:
   the issues panel and problem navigation, workflow marks (flags, bookmarks,
   review state, questions), waivers and acknowledgements, safe fixes with
   previews, the Done button and completion, version history, and the
   conflict comparison.

   Loaded after editor.js and shares its globals (events, revision, markDirty,
   selectEvent, …). editor.js calls in through optional hooks
   (TmWorkspace.onEdited, onLoaded, onSaved, onSaveState, onSettings,
   paintCardHint, rowMarks, matches, startDone, openConflict), so the editor
   still runs where this file is absent (the Node test stub).
   ══════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    if (typeof TmQuality === 'undefined') return;

    const W = {};
    let result = null;            // the last validation
    let validatedAt = -1;         // the edit counter (`revision`) it was run against
    let validateTimer = null;
    let currentKey = null;        // the finding being worked on
    let panelTab = 'error';
    let doneBusy = false;
    let completed = { revision: null, at: null };
    const PANEL_LIMIT = 300;

    const $ = id => document.getElementById(id);
    const canTranslate = () => typeof CAN_EDIT_TRANSLATION === 'undefined' || CAN_EDIT_TRANSLATION;
    const cueById = id => events.find(ev => ev.id === id);
    const indexOf = id => events.findIndex(ev => ev.id === id);
    const userName = () => (document.querySelector('.tm-nav-user')?.textContent || '').trim() || null;

    // ── Settings owned here, saved with the project ───────────────────
    function setSetting(key, value) {
        workspaceSettings = { ...workspaceSettings, [key]: value };
        markDirty();
    }
    const rules = () => TmQuality.normaliseRules(workspaceSettings.rules);

    // ══ Validation lifecycle ══════════════════════════════════════════
    function context() {
        return { mediaDuration: video && Number.isFinite(video.duration) ? video.duration : null, fps };
    }
    function validateNow() {
        clearTimeout(validateTimer);
        result = TmQuality.validate(events, { profile: deliveryProfile, ...workspaceSettings }, context());
        validatedAt = revision;
        paintAll();
        return result;
    }
    // Background checks run after a pause in typing and never touch the
    // field being edited: only the panel, the Done area and the hint line
    // under the open card are repainted.
    function scheduleValidate() {
        clearTimeout(validateTimer);
        validateTimer = setTimeout(validateNow, 350);
        paintDone();
    }

    W.onEdited = scheduleValidate;
    W.onSettings = () => { scheduleValidate(); paintRulesControls(); paintGlossary(); };
    W.onLoaded = payload => {
        completed = { revision: payload?.completedRevision ?? null, at: payload?.completedAt ?? null };
        paintRulesControls();
        paintGlossary();
        validateNow();
    };
    W.onSaved = data => {
        if (data && 'completedRevision' in data) completed.revision = data.completedRevision ?? completed.revision;
        paintDone();
    };
    W.onSaveState = () => paintDone();
    video?.addEventListener('loadedmetadata', () => scheduleValidate());
    video?.addEventListener('error', () => {
        showBanner('The video could not be loaded (moved, replaced or unavailable). Your subtitles are safe and still editable; timing just cannot be checked against the picture until the video is back. The project owner can upload it again in Project settings.', 'warn');
    });

    // ══ Hooks used by editor.js rendering ═════════════════════════════
    const SEV_LABEL = { error: 'Error', warning: 'Warning', suggestion: 'Suggestion' };
    const SEV_ICON = { error: 'bi-x-octagon-fill', warning: 'bi-exclamation-triangle-fill', suggestion: 'bi-lightbulb' };

    function sevBadge(sev) {
        return `<span class="tm-sev tm-sev-${sev}"><i class="bi ${SEV_ICON[sev]}" aria-hidden="true"></i>${SEV_LABEL[sev]}</span>`;
    }

    /* The line under the open card: its marks, then each of its problems as
       a link to the full explanation. Text plus icon, never colour alone. */
    W.paintCardHint = (card, index) => {
        if (!card || index < 0) return;
        let hint = card.querySelector('.tm-quality-hint');
        if (!hint) { hint = document.createElement('p'); hint.className = 'tm-quality-hint'; card.appendChild(hint); }
        const ev = events[index];
        const fresh = result && validatedAt === revision ? result : null;
        const list = (fresh?.byCue.get(ev.id) || []).filter(f => !f.waived);
        const marks = markChips(ev);
        hint.innerHTML = marks + list.map(f =>
            `<button type="button" class="tm-hint-issue tm-hint-${f.severity}" data-key="${escapeHtml(f.key)}">${sevBadge(f.severity)} ${escapeHtml(f.title)}${f.line != null ? ` (line ${f.line + 1})` : ''}</button>`).join('');
        if (!fresh && !marks) hint.textContent = '';
    };

    function markChips(ev) {
        const chips = [];
        const flags = ev.flags | 0;
        for (const bit of [1, 2, 4, 8]) {
            if (flags & bit) chips.push(`<span class="tm-mark-chip tm-mark-flag"><i class="bi ${bit === 8 ? 'bi-question-circle' : 'bi-flag-fill'}" aria-hidden="true"></i>${TmQuality.FLAG_NAMES[bit]}${bit === 8 && ev.commentResolved ? ' (resolved)' : ''}</span>`);
        }
        if (ev.bookmarked) chips.push('<span class="tm-mark-chip"><i class="bi bi-bookmark-fill" aria-hidden="true"></i>Bookmarked</span>');
        if ((ev.reviewState | 0) === 1) chips.push('<span class="tm-mark-chip tm-mark-ok"><i class="bi bi-check2-all" aria-hidden="true"></i>Reviewed</span>');
        if ((ev.reviewState | 0) === 2) chips.push('<span class="tm-mark-chip tm-mark-flag"><i class="bi bi-arrow-repeat" aria-hidden="true"></i>Changes needed</span>');
        const waived = parseWaivers(ev);
        if (waived.length) chips.push(`<span class="tm-mark-chip" title="${escapeHtml(waived.map(w => `${(TmQuality.CHECKS[w.code] || {}).title || w.code}: ${w.reason}`).join('\n'))}"><i class="bi bi-shield-check" aria-hidden="true"></i>${waived.length} waived</span>`);
        return chips.join('');
    }

    /* Icons for the collapsed row, each with a text alternative. */
    // Subtitles with no open error, for the progress line.
    W.cleanCount = () => {
        if (!result || validatedAt !== revision) return null;
        let n = 0;
        for (const ev of events) if (!(result.byCue.get(ev.id) || []).some(f => !f.waived && f.severity === 'error')) n++;
        return n;
    };

    W.rowMarks = ev => {
        let html = '';
        const flags = ev.flags | 0;
        if (flags & 7) html += '<i class="bi bi-flag-fill tm-row-flag" title="Marked for more work" aria-label="Marked for more work"></i>';
        if ((flags & 8) && !ev.commentResolved) html += '<i class="bi bi-question-circle-fill tm-row-flag" title="Open question" aria-label="Open question"></i>';
        if (ev.bookmarked) html += '<i class="bi bi-bookmark-fill" title="Bookmarked" aria-label="Bookmarked"></i>';
        if ((ev.reviewState | 0) === 1) html += '<i class="bi bi-check2-all" title="Reviewed" aria-label="Reviewed"></i>';
        return html;
    };

    /* Extra list filters, for values editor.js does not know. */
    W.matches = (filter, ev) => {
        const fresh = result && validatedAt === revision ? result : null;
        const mine = () => (fresh?.byCue.get(ev.id) || []).filter(f => !f.waived);
        switch (filter) {
            case 'marked': return (ev.flags | 0) !== 0;
            case 'bookmarked': return !!ev.bookmarked;
            case 'unfinished': return isUnfinished(ev);
            case 'errors': return mine().some(f => f.severity === 'error');
            case 'warnings': return mine().some(f => f.severity === 'warning');
            case 'reviewed': return (ev.reviewState | 0) === 1 || (ev.status | 0) === 3;
            case 'notReviewed': return !((ev.reviewState | 0) === 1 || (ev.status | 0) === 3);
            default: return true;
        }
    };

    function isUnfinished(ev) {
        return !ev.translatedText?.trim() || (ev.flags | 0) !== 0 || (ev.reviewState | 0) === 2
            || ((ev.flags | 0) & 8 && !ev.commentResolved);
    }

    function parseWaivers(ev) {
        if (Array.isArray(ev.waivers)) return ev.waivers;
        if (!ev.waiversJson) return [];
        try { const w = JSON.parse(ev.waiversJson); return Array.isArray(w) ? w : []; } catch { return []; }
    }

    // ══ The Done area ═════════════════════════════════════════════════
    const UNSAVED_STATES = ['unsaved', 'saving', 'failed', 'offline', 'auth', 'stale', 'forbidden', 'loading'];

    function doneState() {
        if (!loaded) return { enabled: false, text: 'Loading…' };
        const fresh = result && validatedAt === revision;
        const unsaved = isDirty || saving || UNSAVED_STATES.includes(saveState);
        const isCompleted = completed.revision != null && completed.revision === loadedRevision && !unsaved;
        if (isCompleted) {
            return { enabled: false, completed: true,
                     text: `Version ${completed.revision} is done${completed.at ? ` (${new Date(completed.at).toLocaleString()})` : ''}. Editing it will need Done again.` };
        }
        if (!fresh) return { enabled: false, text: 'Checking the project…' };
        const remaining = TmQuality.remainingSummary(result, { unsaved });
        let text = remaining ? `Remaining: ${remaining}.` : 'Ready: everything is checked and saved.';
        if (saveState === 'offline') text += ' You are offline.';
        if (saveState === 'stale') text += ' Resolve the save conflict first.';
        if (completed.revision != null && !remaining) text += ` (Version ${completed.revision} was done earlier.)`;
        else if (completed.revision != null) text += ` Version ${completed.revision} was done before these edits.`;
        return { enabled: !remaining && !unsaved && result.blocking === 0, text };
    }

    function paintDone() {
        const btn = $('btnDone');
        const reason = $('doneReason');
        const s = doneState();
        if (reason) reason.textContent = s.text;
        if (btn && !doneBusy) {
            btn.disabled = !s.enabled;
            btn.classList.toggle('tm-done-complete', !!s.completed);
            btn.innerHTML = s.completed ? '<i class="bi bi-check2-circle"></i> Completed' : '<i class="bi bi-check2-circle"></i> Done';
            btn.title = s.enabled ? 'Check, save and mark this version complete' : s.text;
        }
        const count = $('issuesCount');
        if (count && result) {
            const n = result.counts.error + result.counts.warning;
            count.textContent = String(n);
            count.hidden = n === 0;
        }
    }

    function paintAll() {
        paintDone();
        updateWorkspace();
        paintPanel();
        const open = eventsList.querySelector('.tm-cue-item-open');
        if (open) W.paintCardHint(open, indexOf(Number(open.dataset.id)));
        refreshCallout();
    }

    // ══ Issues panel ══════════════════════════════════════════════════
    const panel = $('issuesPanel');

    function togglePanel(force) {
        if (!panel) return;
        const open = force ?? panel.hidden;
        panel.hidden = !open;
        $('btnViewIssues')?.setAttribute('aria-expanded', String(open));
        if (open) {
            if (!result || validatedAt !== revision) validateNow(); else paintPanel();
            // Show the tab that has something in it.
            if (result && !tabFindings(panelTab).length) {
                panelTab = ['error', 'warning', 'suggestion', 'waived'].find(t => tabFindings(t).length) || 'error';
                paintPanel();
            }
        }
    }
    W.openPanel = () => togglePanel(true);

    function tabFindings(tab) {
        if (!result) return [];
        const all = TmQuality.ordered(result.findings);
        if (tab === 'waived') return all.filter(f => f.waived);
        return all.filter(f => !f.waived && f.severity === tab);
    }

    function paintPanel() {
        if (!panel || panel.hidden || !result) return;
        const focusedKey = panel.contains(document.activeElement) ? document.activeElement.dataset?.key : null;
        const scroll = panel.querySelector('.tm-issues-list')?.scrollTop || 0;
        const tabs = [['error', 'Errors'], ['warning', 'Warnings'], ['suggestion', 'Suggestions'], ['waived', 'Waived']];
        const list = tabFindings(panelTab);
        const unacked = panelTab === 'warning' ? list.filter(f => !f.acknowledged).length : 0;
        panel.innerHTML = `
            <div class="tm-issues-head">
                <strong>Issues</strong>
                <div class="tm-issues-tabs" role="tablist">
                    ${tabs.map(([t, label]) => `<button type="button" role="tab" class="tm-issues-tab${panelTab === t ? ' tm-issues-tab-on' : ''}" data-tab="${t}" aria-selected="${panelTab === t}">${label} <span>${tabFindings(t).length}</span></button>`).join('')}
                </div>
                <span class="tm-issues-spacer"></span>
                <button type="button" class="tm-icon-btn-sm" data-act="prev" title="Previous problem (Shift+F8)"><i class="bi bi-chevron-up"></i></button>
                <button type="button" class="tm-icon-btn-sm" data-act="next" title="Next problem (F8)"><i class="bi bi-chevron-down"></i></button>
                <button type="button" class="tm-icon-btn-sm" data-act="close" title="Close the issues panel"><i class="bi bi-x-lg"></i></button>
            </div>
            ${result.findings.some(f => f.code === 'project.import') ? '<div class="tm-issues-bar">Notes from the last import. <button type="button" class="tm-btn-sm" data-act="clearImport">Checked — clear import notes</button></div>' : ''}
            ${panelTab === 'warning' && unacked ? `<div class="tm-issues-bar">Project rule: warnings must be ${rules().warningsForDone === 'block' ? 'fixed or waived' : 'reviewed'} before Done. ${rules().warningsForDone === 'acknowledge' ? `<button type="button" class="tm-btn-sm" data-act="ackAll">I have reviewed these ${unacked} warnings</button>` : ''}</div>` : ''}
            ${!list.length ? `<p class="tm-issues-empty">${panelTab === 'waived' ? 'Nothing has been waived.' : `No ${tabs.find(t => t[0] === panelTab)[1].toLowerCase()}. `}${result.counts.error + result.counts.warning === 0 ? 'The project passes every check.' : ''}</p>` : ''}
            <ol class="tm-issues-list">
                ${list.slice(0, PANEL_LIMIT).map(f => `
                <li><button type="button" class="tm-issue-row${f.key === currentKey ? ' tm-issue-row-on' : ''}" data-key="${escapeHtml(f.key)}">
                    ${sevBadge(f.severity)}${f.acknowledged ? '<span class="tm-issue-ack">reviewed</span>' : ''}
                    <span class="tm-issue-where">${f.index != null ? `#${f.index + 1} · ${escapeHtml(f.startTime || '')}` : 'Project'}</span>
                    <span class="tm-issue-title">${escapeHtml(f.title)}</span>
                    <span class="tm-issue-msg">${escapeHtml(f.waived ? `Waived: ${f.waived.reason}` : f.message)}</span>
                </button></li>`).join('')}
            </ol>
            ${list.length > PANEL_LIMIT ? `<p class="tm-issues-empty">Showing the first ${PANEL_LIMIT} of ${list.length}. Fix or filter to see the rest; F8 steps through all of them.</p>` : ''}`;
        const ol = panel.querySelector('.tm-issues-list');
        if (ol) ol.scrollTop = scroll;
        if (focusedKey) panel.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`)?.focus({ preventScroll: true });
    }

    panel?.addEventListener('click', e => {
        const tab = e.target.closest('[data-tab]');
        if (tab) { panelTab = tab.dataset.tab; paintPanel(); return; }
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'close') { togglePanel(false); $('btnViewIssues')?.focus(); return; }
        if (act === 'next') { step(1); return; }
        if (act === 'prev') { step(-1); return; }
        if (act === 'ackAll') { acknowledgeAll(); return; }
        if (act === 'clearImport') { setSetting('importIssues', []); validateNow(); return; }
        const row = e.target.closest('.tm-issue-row');
        if (row) {
            const f = result?.findings.find(x => x.key === row.dataset.key);
            if (f) goTo(f);
        }
    });

    $('btnViewIssues')?.addEventListener('click', () => togglePanel());

    // ══ Going to a problem ════════════════════════════════════════════
    /* Opens the subtitle, brings its whole card into view, focuses and
       highlights the exact field (and line), explains the problem beside it,
       and — for timing — shows the place on the timeline with its
       neighbours, ready to play. */
    function goTo(f) {
        currentKey = f.key;
        paintPanel();
        if (f.cueId == null || indexOf(f.cueId) < 0) { announce(f.message); return; }

        // A search or filter can hide the cue; clear them rather than fail.
        if (!visibleCues().some(ev => ev.id === f.cueId)) {
            $('cueSearch').value = '';
            $('cueFilter').value = 'all';
            renderEvents();
            announce('Search and filter were cleared to show this subtitle.');
        }
        selectEvent(f.cueId, { scrollBlock: 'center' });
        const card = eventsList.querySelector('.tm-cue-item-open');
        if (!card) return;

        const field = focusField(card, f);
        showCallout(card, f);
        fitOpenCard();
        scrollCardInList(card, 'nearest');
        field?.focus({ preventScroll: true });
        if (f.field === 'translatedText' && f.line != null && field?.setSelectionRange) selectLine(field, f.line);
        flash(field);

        if (f.code.startsWith('timing.') || f.code === 'text.cps') {
            const ev = cueById(f.cueId);
            const i = indexOf(f.cueId);
            const prev = events[i - 1], next = events[i + 1];
            const from = Math.min(tcToSecs(ev.startTime), prev ? tcToSecs(prev.startTime) : Infinity);
            const to = Math.max(tcToSecs(ev.endTime), next ? tcToSecs(next.endTime) : -Infinity);
            const width = timelineScroll?.clientWidth || 800;
            if (Number.isFinite(from) && Number.isFinite(to) && to > from) setZoom(width / ((to - from) * 1.4), (from + to) / 2);
            if (video && Number.isFinite(video.duration)) seekTo(Math.max(0, tcToSecs(ev.startTime) - 0.5));
        }
        announce(`${SEV_LABEL[f.severity]}: ${f.message}`);
    }
    W.goTo = goTo;

    function focusField(card, f) {
        if (f.field === 'startTime' || f.field === 'endTime') return card.querySelector(`.tm-tc-input[data-field="${f.field}"]`);
        if (f.field === 'comment') {
            const box = card.querySelector('.tm-event-comment');
            if (box) box.hidden = false;
            return card.querySelector('.tm-comment-input');
        }
        if (f.field === 'translatedText') return card.querySelector('.tm-translated-input');
        return card.querySelector('.tm-marks-btn') || card.querySelector('.tm-translated-input');
    }

    function selectLine(box, line) {
        const lines = box.value.split('\n');
        let start = 0;
        for (let k = 0; k < line && k < lines.length; k++) start += lines[k].length + 1;
        box.setSelectionRange(start, start + (lines[line] || '').length);
    }

    function flash(el) {
        if (!el) return;
        el.classList.remove('tm-field-flash');
        void el.offsetWidth;
        el.classList.add('tm-field-flash');
        setTimeout(() => el.classList.remove('tm-field-flash'), 2400);
    }

    function step(direction) {
        if (!result || validatedAt !== revision) validateNow();
        // Every open problem in track order, whatever the panel is showing.
        const list = TmQuality.ordered(result.findings).filter(f => !f.waived && f.cueId != null);
        if (!list.length) { announce('No problems left.'); return; }
        // Step from the current problem, or from the open subtitle.
        let at = list.findIndex(f => f.key === currentKey);
        if (at < 0) {
            const here = indexOf(activeId);
            at = direction > 0 ? list.findIndex(f => f.index > here) - 1 : list.findIndex(f => f.index >= here);
            if (at < -1) at = direction > 0 ? -1 : list.length;
        }
        const next = list[(at + direction + list.length) % list.length];
        goTo(next);
    }
    W.step = step;

    // ── The explanation beside the field ──────────────────────────────
    function showCallout(card, f) {
        card.querySelector('.tm-issue-callout')?.remove();
        const box = document.createElement('div');
        box.className = `tm-issue-callout tm-issue-callout-${f.severity}`;
        box.setAttribute('role', 'group');
        box.setAttribute('aria-label', `${SEV_LABEL[f.severity]}: ${f.title}`);
        box.dataset.key = f.key;
        const timing = f.code.startsWith('timing.') || f.code === 'text.cps';
        box.innerHTML = `
            <div class="tm-callout-head">${sevBadge(f.severity)} <strong>${escapeHtml(f.title)}</strong>
                ${f.waived ? `<span class="tm-issue-ack">waived: ${escapeHtml(f.waived.reason)}</span>` : ''}
                ${f.acknowledged ? '<span class="tm-issue-ack">reviewed</span>' : ''}
                <span class="tm-issues-spacer"></span>
                <button type="button" class="tm-icon-btn-sm" data-act="prev" title="Previous problem (Shift+F8)"><i class="bi bi-chevron-up"></i></button>
                <button type="button" class="tm-icon-btn-sm" data-act="next" title="Next problem (F8)"><i class="bi bi-chevron-down"></i></button>
                <button type="button" class="tm-icon-btn-sm" data-act="dismiss" title="Hide this explanation"><i class="bi bi-x-lg"></i></button>
            </div>
            <p class="tm-callout-msg">${escapeHtml(f.message)}</p>
            <p class="tm-callout-action"><b>What to do:</b> ${escapeHtml(f.action)}</p>
            <div class="tm-callout-actions">
                ${timing && video ? '<button type="button" class="tm-btn-sm" data-act="play"><i class="bi bi-play-fill"></i> Play this moment</button>' : ''}
                ${f.fix && canFix(f) ? `<button type="button" class="tm-btn-sm" data-act="fix"><i class="bi bi-magic"></i> ${escapeHtml(f.fix.label)}…</button>` : ''}
                ${f.waivable && !f.waived && canTranslate() ? '<button type="button" class="tm-btn-sm" data-act="waive"><i class="bi bi-shield-check"></i> Waive for this line…</button>' : ''}
                ${f.waived && canTranslate() ? '<button type="button" class="tm-btn-sm" data-act="unwaive">Remove waiver</button>' : ''}
                ${f.severity === 'warning' && !f.waived && !f.acknowledged ? '<button type="button" class="tm-btn-sm" data-act="ack"><i class="bi bi-check2"></i> Mark reviewed</button>' : ''}
                ${f.code === 'flag.set' || f.code === 'note.question' || f.code === 'review.changesNeeded' ? '<button type="button" class="tm-btn-sm" data-act="marks"><i class="bi bi-flag"></i> Change marks…</button>' : ''}
            </div>`;
        card.insertBefore(box, card.firstChild);
    }

    // Revalidation: keep the explanation true, or say it has been resolved.
    function refreshCallout() {
        const box = eventsList.querySelector('.tm-issue-callout');
        if (!box || !result) return;
        const f = result.findings.find(x => x.key === box.dataset.key);
        if (f) return;
        // The same problem with a new fingerprint (the line was edited but it
        // is still too long, say) stays open under its new key.
        const [code, cueId, line] = box.dataset.key.split(':');
        const same = result.findings.find(x => x.code === code && String(x.cueId) === cueId && String(x.line ?? '') === line && !x.waived);
        if (same) {
            const focused = document.activeElement;
            const card = box.closest('.tm-cue-item');
            currentKey = same.key;
            showCallout(card, same);
            focused?.focus?.({ preventScroll: true });
            return;
        }
        box.classList.add('tm-issue-callout-resolved');
        box.querySelector('.tm-callout-msg').textContent = 'Resolved. Press F8 or the arrow to go to the next problem.';
        box.querySelector('.tm-callout-action')?.remove();
        box.querySelector('.tm-callout-actions')?.remove();
    }

    // Clicks act on the current state of the project, not on a check that
    // is still waiting for its debounce.
    const current = () => { if (!result || validatedAt !== revision) validateNow(); return result; };

    eventsList.addEventListener('click', e => {
        const hint = e.target.closest('.tm-hint-issue');
        if (hint) {
            const f = current().findings.find(x => x.key === hint.dataset.key);
            if (f) goTo(f);
            return;
        }
        const box = e.target.closest('.tm-issue-callout');
        if (!box) return;
        const act = e.target.closest('[data-act]')?.dataset.act;
        const f = act && !['dismiss', 'next', 'prev'].includes(act) ? current().findings.find(x => x.key === box.dataset.key) : null;
        if (act === 'dismiss') { box.remove(); fitOpenCard(); return; }
        if (act === 'next') { step(1); return; }
        if (act === 'prev') { step(-1); return; }
        if (!f) return;
        if (act === 'play') playWithPreroll();
        if (act === 'fix') previewFix(f);
        if (act === 'waive') waive(f);
        if (act === 'unwaive') unwaive(f);
        if (act === 'ack') acknowledge([f]);
        if (act === 'marks') openMarks(f.cueId, e.target.closest('button'));
    });

    // ══ Waivers and acknowledgements ══════════════════════════════════
    async function waive(f) {
        const reason = await askText({
            title: `Waive "${f.title}" for subtitle ${f.index + 1}`,
            html: `<p>${escapeHtml(f.message)}</p><p>Waiving records that this is intentional for this line only. It stays visible under <b>Waived</b>, with your reason.</p>`,
            label: 'Reason (required)',
            placeholder: f.code === 'text.sameAsSource' ? 'e.g. A name — the same in both languages'
                : f.code === 'text.untranslated' ? 'e.g. Music cue — no subtitle needed' : 'Why this is fine here',
            confirm: 'Waive',
        });
        if (!reason) return;
        const ev = cueById(f.cueId);
        if (!ev) return;
        const waivers = parseWaivers(ev).filter(w => w.code !== f.code);
        waivers.push({ code: f.code, reason, by: userName(), at: new Date().toISOString() });
        setWaivers(ev, waivers);
    }

    function unwaive(f) {
        const ev = cueById(f.cueId);
        if (!ev) return;
        setWaivers(ev, parseWaivers(ev).filter(w => w.code !== f.code));
    }

    function setWaivers(ev, waivers) {
        commitHistory();
        ev.waivers = waivers;
        ev.waiversJson = waivers.length ? JSON.stringify(waivers) : null;
        markDirty();
        commitHistory();
        validateNow();
    }

    function acknowledge(list) {
        const acknowledged = { ...(workspaceSettings.acknowledged || {}) };
        // Keep the map to findings that still exist, so it cannot grow forever.
        const live = new Set(result.findings.map(f => f.key));
        for (const key of Object.keys(acknowledged)) if (!live.has(key)) delete acknowledged[key];
        for (const f of list) acknowledged[f.key] = true;
        setSetting('acknowledged', acknowledged);
        validateNow();
    }

    async function acknowledgeAll() {
        const list = tabFindings('warning').filter(f => !f.acknowledged);
        const ok = await chooseDialog({
            title: `Mark ${list.length} warnings as reviewed?`,
            text: 'Each warning stays listed, marked reviewed. Editing a line brings its warning back.',
            html: `<p>You are confirming you have looked at these ${list.length} warnings and accept them as they are. They stay listed as <b>reviewed</b>; editing a line brings its warning back for another look.</p>`,
            choices: [{ label: `Mark ${list.length} reviewed`, value: true, primary: true }, { label: 'Cancel', value: false }],
        });
        if (ok) acknowledge(list);
    }

    // ══ Fixes, always previewed ═══════════════════════════════════════
    function canFix(f) {
        if (!canTranslate() && ['lineBreaks', 'tidySpaces', 'sortByTime'].includes(f.fix.kind)) return false;
        return true;
    }

    /* Computes what a fix would change, without changing anything. */
    function planFix(f) {
        const ev = cueById(f.cueId);
        const i = indexOf(f.cueId);
        const p = deliveryProfile;
        const start = tcToSecs(ev.startTime), end = tcToSecs(ev.endTime);
        const next = events[i + 1] ? tcToSecs(events[i + 1].startTime) : Infinity;
        const room = Number.isFinite(next) ? next - p.minGapSeconds : Infinity;
        const timing = (newEnd, note) => {
            newEnd = Math.round(newEnd * 1000) / 1000;
            return { changes: [{ ev, field: 'endTime', before: ev.endTime, after: secsToSrtTc(newEnd) }], note };
        };
        switch (f.fix.kind) {
            case 'setOutByCps': {
                const chars = [...TmQuality.stripTags(ev.translatedText || '').replace(/\s/g, '')].length;
                const want = Math.max(p.minDurationSeconds, chars / p.maxCps);
                const target = Math.min(start + Math.min(want, p.maxDurationSeconds), room);
                if (target <= start) return { error: 'There is no room before the next subtitle. Move or shorten that one first.' };
                return timing(target, target < start + want ? 'The next subtitle limits how long this can stay up; the reading speed will still be high.' : '');
            }
            case 'extendToMin': {
                const target = Math.min(start + p.minDurationSeconds, room);
                if (target <= end) return { error: 'The next subtitle starts too soon to extend this one. Move that one, or merge the two.' };
                return timing(target, target < start + p.minDurationSeconds ? 'Extended as far as the next subtitle allows; still under the minimum.' : '');
            }
            case 'trimToMax': return timing(start + p.maxDurationSeconds, '');
            case 'closeGap': {
                const target = next - p.minGapSeconds;
                if (target <= start + 0.1) return { error: 'Opening the gap would make this subtitle too short.' };
                return timing(target, '');
            }
            case 'resolveOverlap': {
                const other = cueById(f.fix.other);
                const target = tcToSecs(other.startTime) - p.minGapSeconds;
                if (target <= start + 0.1) return { error: 'Ending it before the next subtitle would leave almost nothing. Adjust the other subtitle instead.' };
                return timing(target, '');
            }
            case 'lineBreaks':
                return { changes: [{ ev, field: 'translatedText', before: ev.translatedText, after: f.fix.text }], note: 'Only the line breaks move; the words are unchanged.' };
            case 'tidySpaces': {
                const after = (ev.translatedText || '').split('\n').map(l => l.replace(/[^\S\n]+/g, ' ').trim()).filter(Boolean).join('\n')
                    .replace(/ ([,.!?;:])(?!\.)/g, '$1');
                if (after === ev.translatedText) return { error: 'Nothing to tidy.' };
                return { changes: [{ ev, field: 'translatedText', before: ev.translatedText, after }], note: 'Only spacing changes; the words are unchanged.' };
            }
            case 'sortByTime': {
                const sorted = [...events].sort((a, b) => tcToSecs(a.startTime) - tcToSecs(b.startTime));
                const moved = sorted.filter((ev2, k) => events[k] !== ev2).length;
                return { reorder: sorted, note: `${moved} subtitles change position; numbering follows the new order. Timing and text are unchanged.` };
            }
            default: return { error: 'No automatic fix for this.' };
        }
    }

    async function previewFix(f) {
        const plan = planFix(f);
        if (plan.error) { await chooseDialog({ title: f.fix.label, text: plan.error, choices: [{ label: 'OK', value: true, primary: true }] }); return; }
        const rows = (plan.changes || []).map(c =>
            `<tr><td>#${indexOf(c.ev.id) + 1}</td><td>${c.field === 'translatedText' ? 'Translation' : c.field === 'endTime' ? 'Out-time' : c.field}</td>`
            + `<td class="tm-diff-old" dir="auto">${escapeHtml(c.before || '—').replace(/\n/g, '<br>')}</td><td class="tm-diff-new" dir="auto">${escapeHtml(c.after || '—').replace(/\n/g, '<br>')}</td></tr>`).join('');
        const ok = await chooseDialog({
            title: `${f.fix.label} — preview`,
            text: plan.note,
            html: (rows ? `<table class="tm-preview-table"><thead><tr><th>#</th><th>Field</th><th>Now</th><th>After</th></tr></thead><tbody>${rows}</tbody></table>` : '')
                + (plan.note ? `<p class="tm-modal-note">${escapeHtml(plan.note)}</p>` : '')
                + '<p>You can undo this afterwards.</p>',
            choices: [{ label: 'Apply', value: true, primary: true }, { label: 'Cancel', value: false }],
        });
        if (!ok) return;
        commitHistory();
        if (plan.reorder) {
            await keepCheckpoint(3, 'Before sorting subtitles by time');
            events = plan.reorder;
        }
        for (const c of plan.changes || []) c.ev[c.field] = c.after;
        markDirty();
        commitHistory();
        renderEvents();
        renderTimelineBlocks();
        validateNow();
        if (f.cueId != null && cueById(f.cueId)) selectEvent(f.cueId, { scrollBlock: 'center' });
    }

    // ══ Marks: flags, bookmark, review, question ══════════════════════
    let marksPopover = null;
    function closeMarks() { marksPopover?.remove(); marksPopover = null; }

    function openMarks(id, anchor) {
        closeMarks();
        const ev = cueById(id);
        if (!ev) return;
        const flags = ev.flags | 0;
        const pop = document.createElement('div');
        pop.className = 'tm-marks-popover';
        pop.setAttribute('role', 'dialog');
        pop.setAttribute('aria-label', `Marks for subtitle ${indexOf(id) + 1}`);
        const box = (bit, label) => `<label><input type="checkbox" data-flag="${bit}"${flags & bit ? ' checked' : ''}> ${label}</label>`;
        pop.innerHTML = `
            <p class="tm-tl-menu-title">Needs more work</p>
            ${box(1, 'Needs translation')}${box(2, 'Needs timing')}${box(4, 'Needs review')}
            ${box(8, 'Question in the comment')}
            <label class="tm-marks-sub"${flags & 8 ? '' : ' hidden'}><input type="checkbox" data-resolved${ev.commentResolved ? ' checked' : ''}> Question answered</label>
            <p class="tm-tl-menu-title">Review</p>
            <select data-review class="tm-speed-select" aria-label="Review state">
                <option value="0"${(ev.reviewState | 0) === 0 ? ' selected' : ''}>Not reviewed</option>
                <option value="1"${(ev.reviewState | 0) === 1 ? ' selected' : ''}>Reviewed</option>
                <option value="2"${(ev.reviewState | 0) === 2 ? ' selected' : ''}>Changes needed</option>
            </select>
            <label><input type="checkbox" data-bookmark${ev.bookmarked ? ' checked' : ''}> Bookmark</label>
            <p class="tm-tool-hint">Marks block Done until cleared. They are saved with the project.</p>`;
        document.body.appendChild(pop);
        const r = (anchor || eventsList).getBoundingClientRect();
        pop.style.left = Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.right - pop.offsetWidth)) + 'px';
        pop.style.top = Math.min(innerHeight - pop.offsetHeight - 8, r.bottom + 6) + 'px';
        marksPopover = pop;
        pop.querySelector('input,select')?.focus();
        pop.addEventListener('change', e => {
            const t = e.target;
            commitHistory();
            if (t.dataset.flag) ev.flags = t.checked ? (ev.flags | 0) | Number(t.dataset.flag) : (ev.flags | 0) & ~Number(t.dataset.flag);
            if ('resolved' in t.dataset) ev.commentResolved = t.checked;
            if ('bookmark' in t.dataset) ev.bookmarked = t.checked;
            if ('review' in t.dataset) ev.reviewState = Number(t.value);
            pop.querySelector('.tm-marks-sub').hidden = !((ev.flags | 0) & 8);
            if (Number(t.dataset.flag) === 8 && t.checked) {
                // A question lives in the comment; open it so it can be written.
                const c = eventsList.querySelector(`.tm-cue-item[data-id="${id}"] .tm-event-comment`);
                if (c) c.hidden = false;
            }
            markDirty();
            commitHistory();
            refreshMarks(id);
        });
        pop.addEventListener('keydown', e => { if (e.key === 'Escape') { closeMarks(); anchor?.focus(); } });
    }
    W.openMarks = openMarks;

    document.addEventListener('mousedown', e => {
        if (marksPopover && !marksPopover.contains(e.target) && !e.target.closest('.tm-marks-btn')) closeMarks();
    });

    function refreshMarks(id) {
        const row = eventsList.querySelector(`.tm-cue-row[data-id="${id}"] .tm-cue-marks`);
        if (row) { const ev = cueById(id); row.innerHTML = reviewChips(ev) + statusChip(ev) + W.rowMarks(ev); }
        validateNow();
    }

    eventsList.addEventListener('click', e => {
        const btn = e.target.closest('.tm-marks-btn');
        if (btn) { e.stopPropagation(); openMarks(Number(btn.dataset.id), btn); }
    });

    function toggleBookmark() {
        const ev = cueById(activeId);
        if (!ev) return;
        commitHistory();
        ev.bookmarked = !ev.bookmarked;
        markDirty();
        commitHistory();
        refreshMarks(ev.id);
        announce(ev.bookmarked ? 'Bookmarked.' : 'Bookmark removed.');
    }

    function markReviewed() {
        const ev = cueById(activeId);
        if (!ev) return;
        commitHistory();
        ev.reviewState = (ev.reviewState | 0) === 1 ? 0 : 1;
        markDirty();
        commitHistory();
        refreshMarks(ev.id);
        announce((ev.reviewState | 0) === 1 ? 'Marked reviewed.' : 'Review mark removed.');
    }

    /* Next/previous subtitle matching a test, wrapping around, opening it
       with its whole card visible and the caret in the translation. */
    function jumpTo(test, direction, what) {
        const n = events.length;
        if (!n) return;
        const from = Math.max(-1, indexOf(activeId));
        for (let k = 1; k <= n; k++) {
            const i = ((from + direction * k) % n + n) % n;
            if (test(events[i])) {
                if (!visibleCues().some(ev => ev.id === events[i].id)) { $('cueSearch').value = ''; $('cueFilter').value = 'all'; renderEvents(); }
                selectEvent(events[i].id, { scrollBlock: 'center', focusTranslation: true });
                if (video) video.currentTime = tcToSecs(events[i].startTime);
                return;
            }
        }
        announce(`No ${what}.`);
    }

    // ══ Done ══════════════════════════════════════════════════════════
    /* 1. finish the edit in progress; 2. validate everything again;
       3. stop at the first problem if any; 4. save that exact version;
       5. mark that saved revision complete — only if nothing changed in
       between; 6. show a summary and export options. One run at a time. */
    async function startDone() {
        if (doneBusy || !canTranslate()) return;
        const btn = $('btnDone');
        doneBusy = true;
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Checking…'; }
        try {
            // 1. Commit whatever is being typed (timecode boxes apply on change).
            const active = document.activeElement;
            if (active && eventsList.contains(active)) { active.blur(); await new Promise(r => setTimeout(r, 0)); }

            // 2–3.
            const checked = validateNow();
            if (checked.blocking > 0) {
                togglePanel(true);
                const first = TmQuality.ordered(checked.findings, { bySeverity: true })
                    .find(f => !f.waived && (f.severity === 'error' || (f.severity === 'warning' && !f.acknowledged)));
                if (first) goTo(first);
                announce(`Not done yet. ${TmQuality.remainingSummary(checked)}.`);
                return;
            }
            const stamp = revision;

            // 4.
            if (isDirty || uncertainSave || saveState !== 'saved') {
                if (btn) btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Saving…';
                clearTimeout(autoSaveTimer);
                let ok = await doSave({ manual: true });
                // An autosave may have been in flight; wait it out once.
                for (let i = 0; i < 50 && saving; i++) await new Promise(r => setTimeout(r, 100));
                if (isDirty && !saving) ok = await doSave({ manual: true });
                if (!ok || isDirty || saveState !== 'saved') {
                    await chooseDialog({ title: 'Not marked done', text: 'The project could not be saved, so it was not marked done. Your work is kept; see the save status for what went wrong, then try Done again.', choices: [{ label: 'OK', value: true, primary: true }] });
                    return;
                }
            }

            // 5. Edits since the check mean the saved version is not the one checked.
            if (revision !== stamp) {
                await chooseDialog({ title: 'Edited while checking', text: 'You changed something while the project was being checked and saved, so that version was not marked done. Press Done again to check the latest version.', choices: [{ label: 'OK', value: true, primary: true }] });
                return;
            }
            if (btn) btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Marking done…';
            const summary = completionSummary(checked);
            let data;
            try {
                data = await api(`/studio/${PROJECT_ID}/complete`, { method: 'POST', body: { revision: loadedRevision, summary: JSON.stringify(summary) } });
            } catch (err) {
                const msg = err.kind === 'conflict' ? 'The project was saved somewhere else in the meantime. Reload or wait for the merge, then press Done again.'
                    : err.kind === 'invalid' ? (err.data?.message || 'The server found something still open.')
                    : err.kind === 'auth' ? 'Your sign-in has expired. Sign in again, then press Done.'
                    : 'The server could not be reached. Nothing was marked done; try again in a moment.';
                await chooseDialog({ title: 'Not marked done', text: msg, choices: [{ label: 'OK', value: true, primary: true }] });
                return;
            }
            completed = { revision: data.completedRevision, at: data.completedAt };
            paintProjectStatus('Completed');

            // 6.
            showCompletion(summary);
        } finally {
            doneBusy = false;
            paintDone();
        }
    }
    W.startDone = startDone;
    $('btnDone')?.addEventListener('click', startDone);

    function completionSummary(r) {
        const translated = events.filter(ev => ev.translatedText?.trim()).length;
        const reviewed = events.filter(ev => (ev.reviewState | 0) === 1 || (ev.status | 0) === 3).length;
        return {
            revision: loadedRevision,
            subtitles: events.length, translated, reviewed,
            warningsReviewed: r.findings.filter(f => f.acknowledged && !f.waived).length,
            waived: r.counts.waived,
            suggestions: r.counts.suggestion,
            rules: r.rules, profile: r.profile.name || 'Custom',
            at: new Date().toISOString(),
        };
    }

    async function showCompletion(s) {
        const choice = await chooseDialog({
            title: `Version ${s.revision} is done`,
            text: `Saved and marked complete. ${s.subtitles} subtitles.`,
            html: `<p><b>Saved and marked complete.</b> Nothing has been sent or published — export the file and deliver it as you normally would.</p>
                <ul class="tm-done-summary">
                    <li>${s.subtitles} subtitles, ${s.translated} translated, ${s.reviewed} marked reviewed</li>
                    <li>${s.warningsReviewed} warnings reviewed, ${s.waived} checks waived with a reason, ${s.suggestions} optional suggestions left</li>
                    <li>Checked against: ${escapeHtml(s.profile)}</li>
                </ul>
                <p class="tm-modal-note">If you edit the project now, this version stays in the history as done, and the new version needs Done again.</p>`,
            choices: [{ label: 'Export…', value: 'export', primary: true }, { label: 'Close', value: 'close' }],
        });
        if (choice === 'export') (typeof TmTransfer !== 'undefined' ? TmTransfer.openExport() : btnExportSrt.click());
    }

    // ══ Version history ═══════════════════════════════════════════════
    const KIND_LABEL = { Checkpoint: 'Automatic checkpoint', Manual: 'Saved version', BeforeImport: 'Before an import', BeforeBulk: 'Before a bulk change',
                         Completed: 'Done', BeforeRestore: 'Before a restore', Conflict: 'Kept from a conflict' };

    async function openHistory() {
        let data;
        try { data = await api(`/studio/${PROJECT_ID}/history`); }
        catch { await chooseDialog({ title: 'Version history', text: 'The history could not be loaded. Check your connection and try again.', choices: [{ label: 'OK', value: true }] }); return; }
        const items = data.snapshots || [];
        const choice = await chooseDialog({
            title: 'Version history',
            text: items.length ? 'Pick a version to preview.' : 'No versions yet.',
            html: items.length
                ? `<p>Copies the server keeps while you work, before imports and bulk changes, and at Done. Preview one to see how it differs from what is on screen now; nothing changes until you confirm.</p>
                   <ol class="tm-history-list">${items.map(s => `<li><button type="button" class="tm-history-row" data-value="${s.id}">
                       <b>${escapeHtml(KIND_LABEL[s.kind] || s.kind)}</b>${s.label ? ` — ${escapeHtml(s.label)}` : ''}
                       <span>${new Date(s.createdAt).toLocaleString()} · version ${s.revision} · ${s.translatedCount}/${s.cueCount} translated${s.by ? ` · ${escapeHtml(s.by)}` : ''}</span>
                   </button></li>`).join('')}</ol>`
                : '<p>No saved versions yet. They appear after the first save.</p>',
            choices: [{ label: 'Save a named version…', value: 'name' }, { label: 'Close', value: null }],
            pickable: '.tm-history-row',
        });
        if (choice === 'name') return saveNamedVersion();
        if (choice) previewSnapshot(Number(choice));
    }
    W.openHistory = openHistory;

    async function saveNamedVersion() {
        const label = await askText({ title: 'Save as a named version', html: '<p>Saves the project now and keeps this version in the history under a name, so you can come back to it.</p>', label: 'Name', placeholder: 'e.g. Sent to client for approval', confirm: 'Save version' });
        if (!label) return;
        const ok = await doSave({ manual: true, checkpoint: { kind: 1, label } });
        announce(ok ? `Saved as "${label}".` : 'Could not save the version — see the save status.');
    }

    async function previewSnapshot(id) {
        let snap;
        try { snap = await api(`/studio/${PROJECT_ID}/history/${id}`); }
        catch { return; }
        const theirs = (snap.events || []);
        const d = diffSummary(events, theirs.map(ev => ({ ...ev, id: ev.id })));
        const ok = await chooseDialog({
            title: `Restore this version? (${new Date(snap.createdAt).toLocaleString()})`,
            text: `${theirs.length} subtitles; ${diffText(d)} compared with what is on screen.`,
            html: `<p>${theirs.length} subtitles. Compared with what is on screen now: <b>${escapeHtml(diffText(d))}</b>.</p>${diffHtml(d)}
                   <p class="tm-modal-note">Restoring replaces the subtitles on screen with this version and saves it as a new version. What is on screen now is kept in the history first, so this can be undone.</p>`,
            choices: [{ label: 'Restore this version', value: true, primary: true }, { label: 'Cancel', value: false }],
        });
        if (!ok) return;
        await keepCheckpoint(5, `Before restoring the version from ${new Date(snap.createdAt).toLocaleString()}`);
        commitHistory();
        // Rows deleted since this copy was taken come back as new lines; the
        // server only knows the ids it still has.
        const known = new Set(baseline.keys());
        events = theirs.map(ev => known.has(ev.id) ? { ...ev } : { ...ev, id: nextTempId-- });
        reserveTempIds();
        activeId = null;
        selectedIds = new Set();
        markDirty();
        commitHistory();
        renderEvents();
        renderTimelineBlocks();
        validateNow();
        showBanner('Restored an earlier version. What was on screen before is in the version history.', 'warn');
    }

    saveStatus?.addEventListener('click', openHistory);
    saveStatus?.setAttribute('role', 'button');
    saveStatus?.setAttribute('tabindex', '0');
    saveStatus?.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openHistory(); } });
    $('btnHistory')?.addEventListener('click', openHistory);
    $('btnSaveVersion')?.addEventListener('click', saveNamedVersion);

    // ══ Conflict comparison ═══════════════════════════════════════════
    /* Two real versions: this editor's and the one on the server. Shows the
       lines that differ side by side and lets the person keep either whole
       version; the other is stored in the history either way. */
    async function openConflict() {
        let server;
        try { server = await api(`/studio/${PROJECT_ID}/events`); }
        catch { await chooseDialog({ title: 'Compare versions', text: 'The saved version could not be loaded. Export your work to be safe, then try again.', choices: [{ label: 'OK', value: true }] }); return; }
        const theirs = server.events || [];
        const byId = new Map(theirs.map(ev => [ev.id, ev]));
        const rows = [];
        events.forEach((mine, i) => {
            const t = byId.get(storedIdFor(mine.id));
            const fields = ['translatedText', 'startTime', 'endTime', 'originalText', 'comment'];
            const diff = t ? fields.filter(f => !sameValue(f, mine[f], t[f])) : ['(only in yours)'];
            if (diff.length && rows.length < 40) {
                rows.push(`<tr><td>#${i + 1}</td><td dir="auto">${escapeHtml(t ? fields.filter(f => diff.includes(f)).map(f => `${f === 'translatedText' ? '' : f + ': '}${t[f] ?? ''}`).join(' · ') : '—')}</td>`
                    + `<td dir="auto">${escapeHtml(fields.filter(f => diff.includes(f) || !t).map(f => `${f === 'translatedText' ? '' : f + ': '}${mine[f] ?? ''}`).join(' · ').slice(0, 300))}</td></tr>`);
            }
        });
        const onlyTheirs = theirs.filter(t => !events.some(m => storedIdFor(m.id) === t.id)).length;
        const choice = await chooseDialog({
            title: 'Two versions of this project',
            text: 'Someone saved after you opened the project.',
            html: `<p>Someone saved this project after you opened it, and you both changed the same lines. Neither version is lost: whichever you keep, the other is stored in the version history.</p>
                   <table class="tm-preview-table"><thead><tr><th>#</th><th>Saved version</th><th>Your version</th></tr></thead><tbody>${rows.join('') || '<tr><td colspan="3">Only structural differences.</td></tr>'}</tbody></table>
                   ${onlyTheirs ? `<p>${onlyTheirs} subtitle(s) exist only in the saved version.</p>` : ''}`,
            choices: [
                { label: 'Keep my version', value: 'mine', primary: true },
                { label: 'Use the saved version', value: 'theirs' },
                { label: 'Decide later', value: null },
            ],
        });
        if (choice === 'mine') {
            await keepCheckpoint(6, 'The saved version you chose not to keep', theirs);
            loadedRevision = server.revision;
            rememberBaseline(theirs);
            revisionStale = false;
            hideBannerFor('save');
            markDirty();
            doSave({ manual: true });
        } else if (choice === 'theirs') {
            await keepCheckpoint(6, 'Your version, replaced by the saved one');
            events = theirs;
            loadedRevision = server.revision;
            rememberBaseline(theirs);
            revisionStale = false;
            isDirty = false;
            clearDraft();
            hideBannerFor('save');
            renderEvents();
            renderTimelineBlocks();
            paintSaveState('saved');
            validateNow();
        }
    }
    W.openConflict = openConflict;

    // ══ Project rules & glossary (in the Delivery spec section) ═══════
    function paintRulesControls() {
        const r = rules();
        const set = (id, prop, value) => { const el = $(id); if (el) el[prop] = value; };
        set('ruleRequireTranslation', 'checked', r.requireTranslation);
        set('ruleRequireReview', 'checked', r.requireReview);
        set('ruleAllowOverlaps', 'checked', r.allowOverlaps);
        set('ruleWarnings', 'value', r.warningsForDone);
        set('ruleFormat', 'value', r.exportFormat);
    }
    function readRules() {
        setSetting('rules', {
            ...rules(),
            requireTranslation: $('ruleRequireTranslation')?.checked ?? true,
            requireReview: $('ruleRequireReview')?.checked ?? false,
            allowOverlaps: $('ruleAllowOverlaps')?.checked ?? false,
            warningsForDone: $('ruleWarnings')?.value || 'acknowledge',
            exportFormat: $('ruleFormat')?.value || 'srt',
        });
        validateNow();
    }
    ['ruleRequireTranslation', 'ruleRequireReview', 'ruleAllowOverlaps', 'ruleWarnings', 'ruleFormat']
        .forEach(id => $(id)?.addEventListener('change', readRules));

    function glossary() { return Array.isArray(workspaceSettings.glossary) ? workspaceSettings.glossary : []; }
    function paintGlossary() {
        const list = $('glossaryList');
        if (!list) return;
        const g = glossary();
        list.innerHTML = g.length
            ? g.map((t, k) => `<li><span dir="auto">${escapeHtml(t.source)}</span> → <span dir="auto">${escapeHtml(t.target)}</span>${t.note ? ` <em dir="auto">${escapeHtml(t.note)}</em>` : ''}
                 <button type="button" class="tm-icon-btn-sm" data-remove="${k}" title="Remove this term" aria-label="Remove ${escapeHtml(t.source)}"><i class="bi bi-x"></i></button></li>`).join('')
            : '<li class="tm-tool-hint">No terms yet. Terms added here are checked in every subtitle.</li>';
    }
    $('glossaryAdd')?.addEventListener('click', () => {
        const source = $('glossarySource').value.trim(), target = $('glossaryTarget').value.trim();
        if (!source || !target) { announce('Enter both the source term and its translation.'); return; }
        const note = $('glossaryNote')?.value.trim() || '';
        setSetting('glossary', [...glossary().filter(t => t.source.toLocaleLowerCase() !== source.toLocaleLowerCase()), { source, target, note }]);
        $('glossarySource').value = ''; $('glossaryTarget').value = ''; if ($('glossaryNote')) $('glossaryNote').value = '';
        paintGlossary();
        validateNow();
        $('glossarySource').focus();
    });
    $('glossaryList')?.addEventListener('click', e => {
        const k = e.target.closest('[data-remove]')?.dataset.remove;
        if (k == null) return;
        setSetting('glossary', glossary().filter((_, i) => i !== Number(k)));
        paintGlossary();
        validateNow();
    });

    // ══ Small dialogs ═════════════════════════════════════════════════
    function askText({ title, html, label, placeholder, confirm = 'OK' }) {
        return new Promise(resolve => {
            const back = document.createElement('div');
            back.className = 'tm-modal-backdrop';
            back.innerHTML = `<form class="tm-modal" role="dialog" aria-modal="true" aria-labelledby="tmAskTitle">
                <h3 class="tm-modal-title" id="tmAskTitle">${escapeHtml(title)}</h3>
                <div class="tm-modal-msg">${html || ''}</div>
                <label class="tm-col-label" for="tmAskInput">${escapeHtml(label)}</label>
                <textarea id="tmAskInput" rows="2" dir="auto" class="tm-review-notes" placeholder="${escapeHtml(placeholder || '')}" required></textarea>
                <div class="tm-modal-actions"><button type="button" class="tm-btn-sm" data-cancel>Cancel</button>
                <button type="submit" class="tm-btn tm-btn-primary" style="width:auto;">${escapeHtml(confirm)}</button></div></form>`;
            const done = v => { back.remove(); resolve(v); };
            back.querySelector('form').addEventListener('submit', e => { e.preventDefault(); const v = back.querySelector('textarea').value.trim(); if (v) done(v); });
            back.querySelector('[data-cancel]').addEventListener('click', () => done(null));
            back.addEventListener('keydown', e => { if (e.key === 'Escape') done(null); });
            document.body.appendChild(back);
            back.querySelector('textarea').focus();
        });
    }

    // One polite live region for everything this module says aloud.
    const live = document.createElement('div');
    live.className = 'tm-sr-only';
    live.setAttribute('aria-live', 'polite');
    document.body.appendChild(live);
    function announce(text) { live.textContent = ''; setTimeout(() => { live.textContent = text; }, 30); }
    W.announce = announce;

    // ══ Shortcuts ═════════════════════════════════════════════════════
    if (typeof Shortcuts !== 'undefined') {
        Shortcuts.on('nextIssue', () => step(1));
        Shortcuts.on('prevIssue', () => step(-1));
        Shortcuts.on('toggleIssuesPanel', () => togglePanel());
        Shortcuts.on('nextUnfinished', () => jumpTo(isUnfinished, 1, 'unfinished subtitles'));
        Shortcuts.on('prevUnfinished', () => jumpTo(isUnfinished, -1, 'unfinished subtitles'));
        Shortcuts.on('nextFlagged', () => jumpTo(ev => (ev.flags | 0) !== 0 || (ev.reviewFlag | 0) !== 0, 1, 'flagged subtitles'));
        Shortcuts.on('prevFlagged', () => jumpTo(ev => (ev.flags | 0) !== 0 || (ev.reviewFlag | 0) !== 0, -1, 'flagged subtitles'));
        Shortcuts.on('nextBookmark', () => jumpTo(ev => ev.bookmarked, 1, 'bookmarks'));
        Shortcuts.on('prevBookmark', () => jumpTo(ev => ev.bookmarked, -1, 'bookmarks'));
        Shortcuts.on('toggleBookmark', toggleBookmark);
        Shortcuts.on('markReviewed', markReviewed);
        Shortcuts.on('openMarks', () => { const b = eventsList.querySelector('.tm-cue-item-open .tm-marks-btn'); if (activeId != null) openMarks(activeId, b); });
        Shortcuts.on('versionHistory', openHistory);
        Shortcuts.on('markDone', startDone);
    }

    window.TmWorkspace = W;
    // The editor may have finished loading before this script ran (a fast or
    // cached response resolves between the two scripts); catch up if so.
    if (loaded) W.onLoaded(loadPayload);
})();
