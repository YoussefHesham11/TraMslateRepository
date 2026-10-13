/* ══════════════════════════════════════════════════════════════════════
   TmTransfer — import and export, with previews.

   Import: read the bytes, detect the encoding (and let the person override
   it), parse leniently, show what was understood and what was not, then
   replace, append, or start a new project — keeping a recovery copy before
   anything is replaced. Problems found while reading stay in the issues
   panel until dismissed.

   Export: choose format, content (translation / source / bilingual) and
   scope (all / selected), see what the format will drop and a preview of the
   subtitles as they will read, and export a draft when problems remain —
   clearly marked as such. Producing a download is reported as exactly that:
   the browser received a file; whether it was saved is up to the browser.
   ══════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    if (typeof TmFormats === 'undefined') return;

    const T = {};
    const $ = id => document.getElementById(id);
    const meta = () => $('projectMeta')?.dataset || {};

    // ══ Import ════════════════════════════════════════════════════════
    async function importFile(file) {
        if (!file || !loaded) return;
        if (/\.docx$/i.test(file.name)) return importDocx(file);
        if (file.size > 10 * 1024 * 1024) { await notice('Import', 'Choose a subtitle file smaller than 10 MB.'); return; }
        let bytes;
        try { bytes = new Uint8Array(await file.arrayBuffer()); }
        catch { await notice('Import', 'The file could not be read. Check that it is not open elsewhere, then try again.'); return; }
        let encoding = null;
        for (;;) {
            const decoded = TmFormats.decode(bytes, encoding);
            const parsed = TmFormats.parse(decoded.text, file.name);
            const choice = await previewImport(file.name, decoded, parsed);
            if (!choice) return;
            if (choice.reencode) { encoding = choice.reencode; continue; }
            return applyImport(file.name, parsed.cues, parsed.problems, choice);
        }
    }
    T.importFile = importFile;

    async function importDocx(file) {
        try {
            if (file.size > 20 * 1024 * 1024) throw new Error('Choose a Word document smaller than 20 MB.');
            if (typeof mammoth === 'undefined') throw new Error('Word import could not load. Check your connection and reload the page, or use an SRT/VTT file instead.');
            const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
            let cues = SubtitleCore.parseTimedScript(result.value, fps);
            let note;
            if (cues.length) {
                note = `Read ${cues.length} timed entries, interpreting their HH:MM:SS:FF timecodes at ${fps} fps. If the source used another frame rate, set the fps selector first and import again.`;
            } else {
                cues = SubtitleCore.cuesFromLines(result.value.split(/\r?\n/));
                if (!cues.length) throw new Error('No text found in that document.');
                note = `The document has no timecodes, so each of its ${cues.length} lines gets estimated timing. Check every subtitle against the video.`;
            }
            const choice = await previewImport(file.name, { encoding: 'docx', guessed: false }, { format: 'docx', cues, problems: [], styled: 0, note });
            if (choice) applyImport(file.name, cues, [], choice);
        } catch (error) {
            await notice('Import', error.message);
        }
    }

    function previewImport(name, decoded, parsed) {
        const n = parsed.cues.length;
        const encodingSelect = decoded.encoding === 'docx' ? '' : `
            <label class="tm-transfer-row">Text encoding
                <select data-field="encoding" class="tm-speed-select">
                    ${TmFormats.ENCODINGS.map(([v, l]) => `<option value="${v}"${v === decoded.encoding ? ' selected' : ''}>${l}</option>`).join('')}
                </select>
                ${decoded.guessed ? '<span class="tm-transfer-warn">guessed — check the preview reads correctly</span>' : ''}
            </label>`;
        const problems = parsed.problems || [];
        const sample = parsed.cues.slice(0, 6).map((c, i) =>
            `<tr><td>${i + 1}</td><td class="tm-mono">${escapeHtml(c.startTime)}<br>${escapeHtml(c.endTime)}</td><td dir="auto">${escapeHtml(c.originalText).replace(/\n/g, '<br>') || '<em>empty</em>'}</td></tr>`).join('');
        return new Promise(resolve => {
            const back = document.createElement('div');
            back.className = 'tm-modal-backdrop';
            back.innerHTML = `<form class="tm-modal tm-transfer-modal" role="dialog" aria-modal="true" aria-labelledby="tmImportTitle">
                <h3 class="tm-modal-title" id="tmImportTitle">Import ${escapeHtml(name)}</h3>
                <p>${n} subtitle${n === 1 ? '' : 's'} read as <b>${escapeHtml((parsed.format || '').toUpperCase())}</b>${parsed.styled ? `; ${parsed.styled} carry formatting tags, which are kept` : ''}.</p>
                ${parsed.note ? `<p class="tm-modal-note">${escapeHtml(parsed.note)}</p>` : ''}
                ${encodingSelect}
                ${problems.length ? `<details class="tm-transfer-problems" open><summary>${problems.length} entr${problems.length === 1 ? 'y needs' : 'ies need'} attention</summary>
                    <ul>${problems.slice(0, 30).map(p => `<li>${escapeHtml(p.message)}</li>`).join('')}${problems.length > 30 ? `<li>…and ${problems.length - 30} more.</li>` : ''}</ul>
                    <p class="tm-modal-note">These stay listed in the issues panel after importing, so they can be checked against the original file.</p></details>` : ''}
                ${n ? `<table class="tm-preview-table"><thead><tr><th>#</th><th>Time</th><th>Text</th></tr></thead><tbody>${sample}</tbody></table>` : '<p><b>Nothing could be imported from this file.</b></p>'}
                <fieldset class="tm-transfer-modes"${n ? '' : ' disabled'}>
                    <legend>What to do with ${n === 1 ? 'it' : 'them'}</legend>
                    <label><input type="radio" name="mode" value="replace"${events.length ? '' : ' checked'}> Replace the current subtitles${events.length ? ` (${events.length} now — a copy is kept in the version history first)` : ''}</label>
                    ${events.length ? '<label><input type="radio" name="mode" value="append" checked> Add after the current subtitles</label>' : ''}
                    <label><input type="radio" name="mode" value="new"> Start a new project from this file
                        <input type="text" data-field="title" class="tm-transfer-title" value="${escapeHtml(name.replace(/\.[^.]+$/, ''))}" aria-label="New project title" /></label>
                </fieldset>
                <div class="tm-modal-actions">
                    <button type="button" class="tm-btn-sm" data-cancel>Cancel</button>
                    <button type="submit" class="tm-btn tm-btn-primary" style="width:auto;"${n ? '' : ' disabled'}>Import</button>
                </div></form>`;
            const done = v => { back.remove(); resolve(v); };
            const form = back.querySelector('form');
            form.addEventListener('submit', e => {
                e.preventDefault();
                const mode = form.querySelector('input[name="mode"]:checked')?.value;
                if (!mode) return;
                done({ mode, title: form.querySelector('[data-field="title"]').value.trim() || name });
            });
            form.querySelector('[data-field="encoding"]')?.addEventListener('change', e => done({ reencode: e.target.value }));
            back.querySelector('[data-cancel]').addEventListener('click', () => done(null));
            back.addEventListener('keydown', e => { if (e.key === 'Escape') done(null); });
            document.body.appendChild(back);
            (form.querySelector('button[type="submit"]:not([disabled])') || form.querySelector('[data-cancel]')).focus();
        });
    }

    async function applyImport(name, parsedCues, problems, choice) {
        const fresh = parsedCues.map(c => ({
            startTime: c.startTime, endTime: c.endTime,
            originalText: c.originalText, translatedText: c.translatedText || '',
            originalLocked: true,
        }));
        if (choice.mode === 'new') return createProject(choice.title, fresh, problems);

        const notes = problems.map((p, i) => ({ id: `${Date.now().toString(36)}-${i}`, message: `${name}: ${p.message}` }));
        if (choice.mode === 'replace' && events.length) {
            const kept = await keepCheckpoint(2, `Before importing ${name}`);
            if (!kept) {
                const go = await chooseDialog({
                    title: 'No server copy could be kept',
                    text: 'The current subtitles could not be copied to the version history (the server did not answer). Undo will still bring them back in this session.',
                    choices: [{ label: 'Replace anyway', value: true }, { label: 'Cancel', value: false, primary: true }],
                });
                if (!go) return;
            }
        }
        commitHistory();
        $('cueSearch').value = '';
        $('cueFilter').value = 'all';
        const added = fresh.map((c, i) => ({ ...c, id: nextTempId--, index: (choice.mode === 'append' ? events.length : 0) + i + 1 }));
        events = choice.mode === 'append' ? events.concat(added) : added;
        workspaceSettings = { ...workspaceSettings, importIssues: choice.mode === 'append' ? [...(workspaceSettings.importIssues || []), ...notes] : notes };
        activeId = null;
        selectedIds = new Set();
        markDirty();
        commitHistory();
        renderEvents();
        renderTimelineBlocks();
        if (added.length) selectEvent(added[0].id, { scrollBlock: 'center' });
        showBanner(`Imported ${added.length} subtitle${added.length === 1 ? '' : 's'} from ${name}${choice.mode === 'append' ? ' after the existing ones' : ''}.`
            + (problems.length ? ` ${problems.length} entr${problems.length === 1 ? 'y' : 'ies'} need attention — see the issues panel.` : '') + ' Undo is available.', 'warn',
            problems.length ? [{ label: 'View issues', run: () => TmWorkspace?.openPanel() }] : []);
    }

    /* Creates a project through the normal New Project form, then saves the
       imported subtitles into it and opens it. Nothing in the current
       project changes. */
    async function createProject(title, cues, problems, { what = 'subtitles' } = {}) {
        const m = meta();
        const form = new FormData();
        form.append('Title', title.slice(0, 200));
        form.append('SourceLanguage', m.source || 'English');
        form.append('TargetLanguage', m.target || 'Arabic');
        form.append('Description', `Imported from a subtitle file on ${new Date().toLocaleDateString()}.`);
        form.append('__RequestVerificationToken', csrfToken);
        try {
            const res = await fetch('/projects/new', { method: 'POST', body: form, credentials: 'same-origin' });
            const id = Number(new URL(res.url).pathname.match(/studio\/(\d+)/)?.[1]);
            if (!res.ok || !id) throw new Error('The new project could not be created.');
            const settings = JSON.stringify({ ...projectSettings(), importIssues: problems.map((p, i) => ({ id: `i${i}`, message: p.message })) });
            await api(`/studio/${id}/save`, { method: 'POST', body: { revision: 0, saveId: newSaveId(), settingsJson: settings, events: cues.map((c, i) => ({ ...c, id: -(i + 1) })) } });
            const go = await chooseDialog({
                title: 'New project created',
                text: `"${title}" was created with ${cues.length} ${what}. This project is unchanged.`,
                choices: [{ label: 'Open it', value: true, primary: true }, { label: 'Stay here', value: false }],
            });
            if (go) location.href = `/studio/${id}`;
        } catch (err) {
            await notice('Import', `${err.message || 'The new project could not be created.'} Nothing was changed.`);
        }
    }

    // ══ Export ════════════════════════════════════════════════════════
    const EXPORT_PREFS = 'tm-export-prefs';
    const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(EXPORT_PREFS) || '{}'); } catch { return {}; } };
    const savePrefs = p => { try { localStorage.setItem(EXPORT_PREFS, JSON.stringify(p)); } catch { /* optional */ } };

    function fileBase() {
        const title = (meta().title || document.querySelector('.tm-editor-title')?.textContent || 'subtitles').trim();
        return title.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').slice(0, 80) || 'subtitles';
    }

    async function openExport(format) {
        if (!loaded || !events.length) { await notice('Export', 'Add or import subtitles before exporting.'); return; }
        const prefs = { format: 'srt', content: 'translation', empty: 'source', ...loadPrefs() };
        if (format) prefs.format = format;
        const selected = events.filter(ev => selectedIds.has(ev.id));

        return new Promise(resolve => {
            const back = document.createElement('div');
            back.className = 'tm-modal-backdrop';
            back.innerHTML = `<form class="tm-modal tm-transfer-modal" role="dialog" aria-modal="true" aria-labelledby="tmExportTitle">
                <h3 class="tm-modal-title" id="tmExportTitle">Export subtitles</h3>
                <div class="tm-transfer-grid">
                    <label>Format
                        <select data-field="format" class="tm-speed-select">
                            ${Object.entries(TmFormats.FORMAT_INFO).map(([k, v]) => `<option value="${k}"${k === prefs.format ? ' selected' : ''}>${v.label} (.${v.ext})</option>`).join('')}
                        </select></label>
                    <label>Text
                        <select data-field="content" class="tm-speed-select">
                            <option value="translation"${prefs.content === 'translation' ? ' selected' : ''}>Translation</option>
                            <option value="source"${prefs.content === 'source' ? ' selected' : ''}>Source only</option>
                            <option value="bilingual"${prefs.content === 'bilingual' ? ' selected' : ''}>Bilingual (translation above source)</option>
                        </select></label>
                    <label data-show="translation">Untranslated lines
                        <select data-field="empty" class="tm-speed-select">
                            <option value="source"${prefs.empty === 'source' ? ' selected' : ''}>Use the source text</option>
                            <option value="blank"${prefs.empty === 'blank' ? ' selected' : ''}>Leave empty</option>
                            <option value="skip"${prefs.empty === 'skip' ? ' selected' : ''}>Leave them out</option>
                        </select></label>
                    <label>Subtitles
                        <select data-field="scope" class="tm-speed-select">
                            <option value="all">All ${events.length}</option>
                            <option value="selected"${selected.length > 1 ? ' selected' : ''}${selected.length ? '' : ' disabled'}>Selected (${selected.length})</option>
                        </select></label>
                </div>
                <div class="tm-transfer-status" data-status></div>
                <p class="tm-tool-hint">Preview</p>
                <div class="tm-export-preview" data-preview></div>
                <div class="tm-modal-actions">
                    <button type="button" class="tm-btn-sm" data-cancel>Cancel</button>
                    <button type="button" class="tm-btn-sm" data-save-first hidden>Save, then download</button>
                    <button type="submit" class="tm-btn tm-btn-primary" style="width:auto;" data-download>Download</button>
                </div></form>`;
            const form = back.querySelector('form');
            const field = n => form.querySelector(`[data-field="${n}"]`);
            const done = v => { back.remove(); resolve(v); };

            let plan = null;
            const repaint = () => {
                const opts = { format: field('format').value, content: field('content').value, empty: field('empty').value, scope: field('scope').value };
                form.querySelector('[data-show="translation"]').hidden = opts.content !== 'translation';
                plan = buildExport(opts);
                form.querySelector('[data-status]').innerHTML = plan.statusHtml;
                form.querySelector('[data-preview]').innerHTML = plan.previewHtml;
                form.querySelector('[data-download]').disabled = !!plan.blocked;
                form.querySelector('[data-download]').textContent = plan.draft ? 'Download draft' : 'Download';
                form.querySelector('[data-save-first]').hidden = !isDirty || !!plan.blocked;
            };
            form.addEventListener('change', repaint);
            form.addEventListener('submit', e => { e.preventDefault(); if (!plan.blocked) { done(true); deliver(plan); } });
            form.querySelector('[data-save-first]').addEventListener('click', async () => {
                const ok = await doSave({ manual: true });
                if (!ok || isDirty) { form.querySelector('[data-status]').insertAdjacentHTML('afterbegin', '<p class="tm-transfer-warn">The save did not complete; see the save status. You can still download what is on screen.</p>'); return; }
                repaint();
                done(true);
                deliver(plan);
            });
            form.addEventListener('click', e => {
                const go = e.target.closest('[data-goto]');
                if (go) { done(false); const f = TmQuality.validate(events, { profile: deliveryProfile, ...workspaceSettings }).findings.find(x => String(x.cueId) === go.dataset.goto && x.code.startsWith('timing.')); if (f) TmWorkspace?.goTo(f); }
            });
            back.querySelector('[data-cancel]').addEventListener('click', () => done(false));
            back.addEventListener('keydown', e => { if (e.key === 'Escape') done(false); });
            document.body.appendChild(back);
            repaint();
            (form.querySelector('[data-download]:not([disabled])') || form.querySelector('[data-cancel]')).focus();
        });
    }
    T.openExport = openExport;

    function buildExport(opts) {
        savePrefs({ format: opts.format, content: opts.content, empty: opts.empty });
        const list = opts.scope === 'selected' ? events.filter(ev => selectedIds.has(ev.id)) : events;
        const check = TmQuality.validate(list, { profile: deliveryProfile, ...workspaceSettings, rules: { ...(workspaceSettings.rules || {}), exportFormat: opts.format } },
            { mediaDuration: video && Number.isFinite(video.duration) ? video.duration : null, fps });

        // Timing a player cannot show blocks timed formats outright.
        const broken = opts.format === 'txt' ? [] : check.findings.filter(f => f.code === 'timing.invalid' || f.code === 'timing.malformed');
        const result = TmFormats.serialize(list, opts.format, {
            content: opts.content, empty: opts.empty, title: fileBase(),
            draft: check.blocking ? { summary: TmQuality.remainingSummary(check) } : null,
        });
        const draft = check.blocking > 0;
        const version = isDirty ? `what is on screen now, including changes not yet saved (built on saved version ${loadedRevision ?? '—'})` : `saved version ${loadedRevision ?? '—'}`;
        const name = `${fileBase()}${opts.content === 'bilingual' ? ' (bilingual)' : opts.content === 'source' ? ' (source)' : ''}${opts.scope === 'selected' ? ' (selection)' : ''}${draft ? ' - DRAFT' : ''}.${result.ext}`;

        let statusHtml = `<p>Exports ${result.count} subtitle${result.count === 1 ? '' : 's'} — ${escapeHtml(version)} — as <b>${escapeHtml(name)}</b>.</p>`;
        if (broken.length) {
            statusHtml += `<p class="tm-transfer-error"><b>Cannot export yet:</b> ${broken.length} subtitle${broken.length === 1 ? ' has' : 's have'} timing a player cannot show (out-time not after in-time, or an unreadable timecode): `
                + broken.slice(0, 8).map(f => `<button type="button" class="tm-link-btn" data-goto="${f.cueId}">#${f.index + 1}</button>`).join(' ')
                + '. Fix them, or export as plain text.</p>';
        } else if (draft) {
            statusHtml += `<p class="tm-transfer-warn"><b>Draft:</b> ${escapeHtml(TmQuality.remainingSummary(check))} remain. The file name says DRAFT${opts.format === 'vtt' || opts.format === 'ass' ? ', and so does a note inside the file' : ''}.</p>`;
        }
        if (result.notes.length) statusHtml += `<ul class="tm-transfer-losses">${result.notes.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`;

        // Preview as it will read on screen: supported tags rendered, others gone.
        const info = TmFormats.FORMAT_INFO[opts.format];
        const show = s => escapeHtml(String(s))
            .replace(/&lt;(\/?)(i|b|u)&gt;/gi, (m, slash, t) => (opts.format === 'txt' ? '' : `<${slash}${t.toLowerCase()}>`))
            .replace(/&lt;\/?[a-z][^&]*?&gt;/gi, '')
            .replace(/\{\\[^}]*\}/g, info.ass ? '' : '')
            .replace(/\n/g, '<br>');
        const reparsed = opts.format === 'txt' ? null : TmFormats.parse(result.text.replace(/^﻿/, ''), `x.${result.ext}`);
        const previewHtml = reparsed
            ? reparsed.cues.slice(0, 6).map((c, i) => `<div class="tm-export-cue"><span class="tm-mono">${i + 1} · ${escapeHtml(c.startTime)} → ${escapeHtml(c.endTime)}</span><div class="tm-export-screen" dir="auto">${show(c.originalText) || '<em>(empty)</em>'}</div></div>`).join('')
              + (reparsed.cues.length > 6 ? `<p class="tm-modal-note">…and ${reparsed.cues.length - 6} more.</p>` : '')
            : `<pre class="tm-export-plain" dir="auto">${escapeHtml(result.text.replace(/^﻿/, '').slice(0, 600))}</pre>`;
        return { ...result, name, draft, blocked: broken.length > 0, statusHtml, previewHtml, count: result.count };
    }

    function deliver(plan) {
        try {
            const blob = new Blob([plan.text], { type: `${plan.mime};charset=utf-8` });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = plan.name;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60000);
            // A download link firing is all the page can know about.
            showBanner(`Your browser was given "${plan.name}" (${plan.count} subtitles${plan.draft ? ', marked as a draft' : ''}). Check your downloads folder — TraMslate cannot confirm the file was saved there.`, 'info');
        } catch (err) {
            showBanner(`The export failed (${err?.message || 'the file could not be generated'}). Your project is unchanged${isDirty ? '' : ' and saved'}; try again or choose another format.`, 'danger');
        }
    }

    function notice(title, text) {
        return chooseDialog({ title, text, choices: [{ label: 'OK', value: true, primary: true }] });
    }

    /* Save As: the whole project — subtitles, marks, notes, settings — as a
       new project. The video is not copied (it can be added in the copy's
       settings), and revisor-only fields stay with the original. */
    async function saveCopy() {
        const title = await new Promise(resolve => {
            const back = document.createElement('div');
            back.className = 'tm-modal-backdrop';
            back.innerHTML = `<form class="tm-modal tm-transfer-modal" role="dialog" aria-modal="true" aria-labelledby="tmCopyTitle">
                <h3 class="tm-modal-title" id="tmCopyTitle">Save a copy as a new project</h3>
                <p>Copies all ${events.length} subtitles with their translations, notes, marks and project settings into a new project you own. This project stays exactly as it is. The video is not copied; add it in the new project's settings if needed.</p>
                <label class="tm-transfer-row">Title <input type="text" class="tm-transfer-title" value="${escapeHtml((meta().title || 'Project') + ' (copy)')}" /></label>
                <div class="tm-modal-actions"><button type="button" class="tm-btn-sm" data-cancel>Cancel</button>
                <button type="submit" class="tm-btn tm-btn-primary" style="width:auto;">Save copy</button></div></form>`;
            const done = v => { back.remove(); resolve(v); };
            back.querySelector('form').addEventListener('submit', e => { e.preventDefault(); done(back.querySelector('input').value.trim() || null); });
            back.querySelector('[data-cancel]').addEventListener('click', () => done(null));
            back.addEventListener('keydown', e => { if (e.key === 'Escape') done(null); });
            document.body.appendChild(back);
            back.querySelector('input').select();
        });
        if (!title) return;
        const copy = events.map(ev => ({
            startTime: ev.startTime, endTime: ev.endTime, originalText: ev.originalText, translatedText: ev.translatedText,
            originalLocked: !!ev.originalLocked, comment: ev.comment, status: ev.status | 0, flags: ev.flags | 0,
            bookmarked: !!ev.bookmarked, reviewState: ev.reviewState | 0, commentResolved: !!ev.commentResolved,
            waiversJson: Array.isArray(ev.waivers) && ev.waivers.length ? JSON.stringify(ev.waivers) : (ev.waiversJson ?? null),
        }));
        return createProject(title, copy, [], { what: 'subtitles, with their notes, marks and settings' });
    }
    T.saveCopy = saveCopy;
    document.getElementById('btnSaveCopy')?.addEventListener('click', saveCopy);

    window.TmTransfer = T;
})();
