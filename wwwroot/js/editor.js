// ═══════════════════════════════════════════════════
//  TraMslate — Editor Core
// ═══════════════════════════════════════════════════

// ── State ─────────────────────────────────────────
let events       = [];
let activeId     = null;
let fps          = 25;
let isDirty      = false;
let autoSaveTimer = null;
let revision = 0, saving = false, loaded = false;
let history = [], historyIndex = -1, restoringHistory = false;

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

// ── Quality-flag cache ────────────────────────────
// Every cue's flags depend on its neighbours, so they are computed for the
// whole track in one sweep (SubtitleCore.analyze) and reused by the progress
// counters, the row status dots, the timeline colours and the open card's
// hint line. Without this, each of those asked per cue and re-scanned the
// track to answer — quadratic work on every keystroke.
let trackIssues = [];
let trackIssuesStale = true;

function invalidateIssues() { trackIssuesStale = true; }

function issuesAt(index) {
    if (trackIssuesStale) {
        trackIssues = SubtitleCore.analyze(events, deliveryProfile);
        trackIssuesStale = false;
    }
    return trackIssues[index] || [];
}

function issuesOf(ev) {
    return issuesAt(events.indexOf(ev));
}

function matchesFilter(ev, index) {
    const query = document.getElementById('cueSearch').value.toLocaleLowerCase();
    const filter = document.getElementById('cueFilter').value;
    return ((ev.originalText || '') + '\n' + (ev.translatedText || '')).toLocaleLowerCase().includes(query)
        && (filter !== 'untranslated' || !ev.translatedText?.trim())
        && (filter !== 'issues' || issuesAt(index ?? events.indexOf(ev)).length > 0)
        && (!filter.startsWith('status-') || (ev.status || 0) === Number(filter.slice(7)))
        && (filter !== 'suggested' || hasSuggestion(ev))
        && (filter !== 'flagged' || isFlagged(ev));
}

// Touches only the rows whose state actually changes — the ones currently
// marked, plus the ones about to be. Re-styling the whole list on every
// "next cue" is the difference between instant and sticky on a long film.
function updateSelection() {
    applySelectionClasses(eventsList, '.tm-cue-item', 'tm-event-active', 'tm-event-selected');
    applySelectionClasses(timelineEvents, '.tm-timeline-block', 'tm-timeline-block-active', 'tm-timeline-block-selected');
}

function applySelectionClasses(root, itemSelector, activeClass, selectedClass) {
    if (!root) return;
    root.querySelectorAll('.' + activeClass + ', .' + selectedClass)
        .forEach(el => el.classList.remove(activeClass, selectedClass));
    for (const id of selectedIds) {
        const el = root.querySelector(`${itemSelector}[data-id="${id}"]`);
        if (el) el.classList.add(id === activeId ? activeClass : selectedClass);
    }
    if (activeId != null && !selectedIds.has(activeId)) {
        root.querySelector(`${itemSelector}[data-id="${activeId}"]`)?.classList.add(activeClass);
    }
}

function updateWorkspace() {
    const done = events.filter(ev => ev.translatedText?.trim()).length;
    document.getElementById('cueProgress').textContent = `${done} of ${events.length} translated`;
    document.getElementById('translationProgress').value = events.length ? done / events.length * 100 : 0;
    paintSuggestionsToggle();
    const count = document.getElementById('cueCount');
    if (count) count.textContent = events.length ? `${events.length} cues` : '';
    const flagged = events.reduce((n, _, i) => n + (issuesAt(i).some(issue => issue !== 'Untranslated') ? 1 : 0), 0);
    document.getElementById('cueIssues').textContent = `${flagged} with quality issues`;
    updateHistoryButtons();
    const open = eventsList.querySelector('.tm-cue-item-open');
    if (open) {
        const index = events.findIndex(cue => cue.id === Number(open.dataset.id));
        let hint = open.querySelector('.tm-quality-hint');
        if (!hint) { hint = document.createElement('p'); hint.className = 'tm-quality-hint'; open.appendChild(hint); }
        hint.textContent = index < 0 ? '' : issuesAt(index).join(' · ');
    }
}

// A snapshot serialises the whole track, so taking one per keystroke is both
// slow on a long film and useless as undo — nobody wants to undo one letter
// at a time. Snapshots are coalesced instead: a burst of typing settles into
// a single history entry once the translator pauses.
const HISTORY_SETTLE_MS = 600;
let historyTimer = null;

function recordHistory() {
    if (restoringHistory) return;
    clearTimeout(historyTimer);
    historyTimer = setTimeout(commitHistory, HISTORY_SETTLE_MS);
}

function commitHistory() {
    clearTimeout(historyTimer);
    historyTimer = null;
    if (restoringHistory) return;
    const state = JSON.stringify(events);
    if (history[historyIndex] === state) return;
    history = history.slice(0, historyIndex + 1);
    history.push(state);
    if (history.length > 100) history.shift();
    historyIndex = history.length - 1;
    updateHistoryButtons();
}

function updateHistoryButtons() {
    document.getElementById('undoEdit').disabled = historyIndex <= 0;
    document.getElementById('redoEdit').disabled = historyIndex >= history.length - 1;
}

function restoreHistory(offset) {
    // Land any in-flight snapshot first, so undo steps back from what is on
    // screen rather than from the last settled state.
    commitHistory();
    const next = historyIndex + offset;
    if (!loaded || next < 0 || next >= history.length) return;
    historyIndex = next;
    events = JSON.parse(history[next]);
    restoringHistory = true;
    markDirty();
    restoringHistory = false;
    renderEvents(); renderTimelineBlocks(); updateOverlay();
}

function validateExport() {
    if (!loaded || !events.length) { alert('Add or import subtitles before exporting.'); return false; }
    if (events.some(ev => SubtitleCore.issues(ev, []).includes('Invalid timing'))) { alert('Fix invalid timestamps before exporting.'); return false; }
    return !events.some(ev => !ev.translatedText?.trim()) || confirm('Some cues are untranslated. Export using source text for those cues?');
}

// ── DOM refs ──────────────────────────────────────
const video         = document.getElementById('videoPlayer');
const timecodeHMS   = document.getElementById('timecodeHMS');
const timecodeFrames= document.getElementById('timecodeFrames');
const overlay       = document.getElementById('subtitleOverlay');
const eventsList    = document.getElementById('eventsList');
const btnPlay       = document.getElementById('btnPlay');
const btnSkipBack   = document.getElementById('btnSkipBack');
const btnSkipFwd    = document.getElementById('btnSkipFwd');
const btnFrameBack  = document.getElementById('btnFrameBack');
const btnFrameFwd   = document.getElementById('btnFrameFwd');
const btnAddEvent   = document.getElementById('btnAddEvent');
const btnSave       = document.getElementById('btnSave');
const btnExportSrt  = document.getElementById('btnExportSrt');
const btnExportVtt  = document.getElementById('btnExportVtt');
const speedSelect   = document.getElementById('playbackSpeed');
const fpsSelect     = document.getElementById('fpsSelect');
const cursor        = document.getElementById('timelineCursor');
const canvas        = document.getElementById('waveformCanvas');
const timelineWrap  = document.getElementById('timelineWrap');
const timelineScroll= document.getElementById('timelineScroll');
const timelineInner = document.getElementById('timelineInner');
const timelineEvents= document.getElementById('timelineEvents');
const saveStatus    = document.getElementById('saveStatus');
const importScript  = document.getElementById('importScript');

// ── Timeline state ──────────────────────────────────
let pxPerSecond    = 100;
let snapEnabled    = true;
let autoPauseAtOut = false;
let autoPauseArmed = true;
let playingRangeEnd = null;
let selectedIds    = new Set();
let lockedIds       = loadLocked();
let dragState       = null;
const MIN_PX_PER_SEC = 4, MAX_PX_PER_SEC = 1000, DEFAULT_PX_PER_SEC = 100, SNAP_PX = 8, MIN_CUE_DUR = 0.12;

function loadLocked() {
    try { return new Set(JSON.parse(localStorage.getItem(`tm-locked-${PROJECT_ID}`) || '[]')); }
    catch { return new Set(); }
}
function saveLocked() {
    try { localStorage.setItem(`tm-locked-${PROJECT_ID}`, JSON.stringify([...lockedIds])); } catch { /* storage unavailable */ }
}

// ══════════════════════════════════════════════════
//  TIMECODE HELPERS
// ══════════════════════════════════════════════════

function secsToHMSF(secs) {
    secs = Math.max(0, secs);
    const h  = Math.floor(secs / 3600);
    const m  = Math.floor((secs % 3600) / 60);
    const s  = Math.floor(secs % 60);
    const f  = Math.floor((secs % 1) * fps);
    return {
        hms: `${pad(h)}:${pad(m)}:${pad(s)}`,
        f:   pad(f),
        full: SubtitleCore.timestamp(secs)
    };
}

function tcToSecs(tc) { return SubtitleCore.seconds(tc); }

function secsToSrtTc(secs) { return SubtitleCore.timestamp(secs); }

function pad(n) { return String(Math.floor(n)).padStart(2, '0'); }

function stepFrame(direction) {
    if (!video || !Number.isFinite(video.duration)) return;
    video.pause();
    video.currentTime = Math.min(Math.max(video.currentTime + direction / fps, 0), video.duration);
}

function readingSpeed(text, startTc, endTc) {
    const dur = tcToSecs(endTc) - tcToSecs(startTc);
    if (dur <= 0 || !text) return '—';
    const cps = (text.replace(/\s/g,'').length / dur).toFixed(1);
    return cps;
}

// ── Delivery profile ──────────────────────────────
// The quality limits this project is checked against. Stored per project so a
// translator can work to one client's spec in one tab and another's elsewhere.
const PROFILE_KEY = `tm-profile-${PROJECT_ID}`;

function loadProfile() {
    try {
        const stored = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null');
        if (stored) return SubtitleCore.normaliseProfile(stored);
    } catch { /* corrupt or unavailable: fall through to the default */ }
    return SubtitleCore.normaliseProfile(SubtitleCore.DEFAULT_PROFILE);
}

function storeProfile() {
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(deliveryProfile)); }
    catch { /* storage unavailable; the profile simply will not persist */ }
}

let deliveryProfile = loadProfile();

function charCountDisplay(text) {
    if (!text) return '0 / 42';
    const lines   = text.split('\n');
    const longest = Math.max(...lines.map(l => l.length));
    const lineCount = lines.length;
    return `${longest} / ${deliveryProfile.maxCharsPerLine}${lineCount > 1 ? ` · ${lineCount}L` : ''}`;
}

function charCountClass(text) {
    if (!text) return '';
    const lines   = text.split('\n');
    const longest = Math.max(...lines.map(l => l.length));
    const lineCount = lines.length;
    if (longest > deliveryProfile.maxCharsPerLine || lineCount > deliveryProfile.maxLines) return 'tm-input-error';
    if (longest > deliveryProfile.maxCharsPerLine * 0.85)                                    return 'tm-input-warning';
    return '';
}

// ══════════════════════════════════════════════════
//  VIDEO PLAYER
// ══════════════════════════════════════════════════

if (video) {
    video.addEventListener('timeupdate', () => {
        const { hms, f, full } = secsToHMSF(video.currentTime);
        timecodeHMS.textContent    = hms;
        timecodeFrames.textContent = f;

        // SMPTE top-left
        const smpte = document.getElementById('smpteDisplay');
        if (smpte) smpte.textContent = `SMPTE ${hms}:${f}`;

        // Media Time top-right
        const mt = document.getElementById('mediaTimeDisplay');
        if (mt) mt.textContent = full;

        updateOverlay();
        updateCursor();
        highlightActiveEvent();

        // One-shot "play selected range" stop point.
        if (playingRangeEnd != null && video.currentTime >= playingRangeEnd) {
            video.pause();
            video.currentTime = playingRangeEnd;
            playingRangeEnd = null;
        }
        // Persistent "auto-pause at out-time" toggle.
        if (autoPauseAtOut && autoPauseArmed && !video.paused) {
            const ev = events.find(x => x.id === activeId);
            if (ev && video.currentTime >= tcToSecs(ev.endTime)) {
                video.pause();
                autoPauseArmed = false;
            }
        }
    });

    video.addEventListener('play',  () => { btnPlay.innerHTML = '<i class="bi bi-pause-fill"></i>'; autoPauseArmed = true; });
    video.addEventListener('pause', () => btnPlay.innerHTML = '<i class="bi bi-play-fill"></i>');

    btnPlay.addEventListener('click', () => video.paused ? video.play() : video.pause());
    btnSkipBack.addEventListener('click', () => video.currentTime = Math.max(0, video.currentTime - 5));
    btnSkipFwd.addEventListener('click',  () => video.currentTime += 5);
    btnFrameBack.addEventListener('click', () => stepFrame(-1));
    btnFrameFwd.addEventListener('click',  () => stepFrame(1));
    speedSelect.addEventListener('change', () => video.playbackRate = parseFloat(speedSelect.value));

    // Click on timeline to seek
    canvas.addEventListener('click', e => {
        if (!video.duration || dragState) return;
        const rect = canvas.getBoundingClientRect();
        video.currentTime = Math.min(Math.max((e.clientX - rect.left) / pxPerSecond, 0), video.duration);
    });

    // Draw waveform placeholder bars on timeline. Default to a zoom level
    // where a typical cue is comfortably readable rather than fitting the
    // whole track (which turns a long video into unreadable slivers) —
    // setZoom() still clamps up to fit-width for short clips.
    video.addEventListener('loadedmetadata', () => setZoom(DEFAULT_PX_PER_SEC, 0));
}

fpsSelect.addEventListener('change', () => {
    fps = parseFloat(fpsSelect.value);
    renderEvents();
});

// ══════════════════════════════════════════════════
//  KEYBOARD SHORTCUTS
//  (native "Tab moves to next translation field" stays below since Tab
//  can't be rebound; every other function is wired through Shortcuts.on
//  so it obeys whatever combo the user configured on the Shortcuts page.)
// ══════════════════════════════════════════════════

function markInPoint() {
    if (!video) return;
    const targets = selectionTargets();
    if (!targets.length) return;
    targets.forEach(id => { const ev = events.find(x => x.id === id); if (ev) ev.startTime = secsToSrtTc(video.currentTime); });
    markDirty();
    renderEvents();
}

function markOutPoint() {
    if (!video) return;
    const targets = selectionTargets();
    if (!targets.length) return;
    targets.forEach(id => { const ev = events.find(x => x.id === id); if (ev) ev.endTime = secsToSrtTc(video.currentTime); });
    markDirty();
    renderEvents();
}

function deleteSelectedCue() {
    const targets = selectionTargets();
    if (!targets.length) return;
    events = events.filter(x => !targets.includes(x.id));
    activeId = null;
    selectedIds = new Set();
    markDirty();
    renderEvents();
    renderTimelineBlocks();
}

function selectAdjacentCue(direction) {
    const visible = [...eventsList.querySelectorAll('.tm-cue-item')].map(item => Number(item.dataset.id));
    if (!visible.length) return;
    const idx = visible.indexOf(activeId);
    const nextId = idx === -1 ? visible[0] : visible[Math.min(Math.max(idx + direction, 0), visible.length - 1)];
    selectEvent(nextId, { scrollBlock: 'center', focusTranslation: true });
    const ev = events.find(x => x.id === nextId);
    if (video && ev) video.currentTime = tcToSecs(ev.startTime);
}

function nudgeSpeed(direction) {
    const options = [...speedSelect.options].map(o => parseFloat(o.value));
    const idx = options.indexOf(parseFloat(speedSelect.value));
    const next = options[Math.min(Math.max(idx + direction, 0), options.length - 1)];
    speedSelect.value = String(next);
    if (video) video.playbackRate = next;
}

function showWorkspaceTools() {
    const panel = document.getElementById('workspaceTools');
    if (panel) panel.hidden = false;
}
function toggleWorkspaceTools() {
    const panel = document.getElementById('workspaceTools');
    if (panel) panel.hidden = !panel.hidden;
}

function focusFindReplace() {
    showWorkspaceTools();
    const details = document.querySelector('.tm-more-tools');
    if (details) details.open = true;
    document.getElementById('findText')?.focus();
}

function stopPlayback() {
    if (!video) return;
    video.pause();
    playingRangeEnd = null;
    const ev = events.find(x => x.id === activeId);
    video.currentTime = ev ? tcToSecs(ev.startTime) : 0;
}

function rewindSeconds(s)      { if (video) video.currentTime = Math.max(0, video.currentTime - s); }
function fastForwardSeconds(s) { if (video) video.currentTime = Math.min(video.duration || Infinity, video.currentTime + s); }

function playSelectedRange() {
    const ev = events.find(x => x.id === activeId);
    if (!ev || !video) { alert('Select a cue first.'); return; }
    video.currentTime = tcToSecs(ev.startTime);
    playingRangeEnd = tcToSecs(ev.endTime);
    video.play();
}

function nudgeStepAmount() {
    const raw = document.getElementById('tlNudgeStep')?.value ?? '50';
    return raw === 'frame' ? 1 / fps : Number(raw) / 1000;
}

function selectionTargets() {
    const ids = selectedIds.size ? [...selectedIds] : (activeId != null ? [activeId] : []);
    return ids.filter(id => !lockedIds.has(id));
}

function nudgeSelected(direction) {
    const targets = selectionTargets();
    if (!targets.length) { alert('Select a cue first.'); return; }
    const amount = nudgeStepAmount() * direction;
    targets.forEach(id => {
        const ev = events.find(x => x.id === id);
        const s = tcToSecs(ev.startTime) + amount, e = tcToSecs(ev.endTime) + amount;
        if (s < 0 || e >= 86400) return;
        ev.startTime = secsToSrtTc(s); ev.endTime = secsToSrtTc(e);
    });
    markDirty(); renderEvents(); renderTimelineBlocks();
}

function resizeDurationSelected(direction) {
    const targets = selectionTargets();
    if (!targets.length) { alert('Select a cue first.'); return; }
    const amount = nudgeStepAmount() * direction;
    targets.forEach(id => {
        const ev = events.find(x => x.id === id);
        const s = tcToSecs(ev.startTime), e = tcToSecs(ev.endTime) + amount;
        if (e - s < MIN_CUE_DUR || e >= 86400) return;
        ev.endTime = secsToSrtTc(e);
    });
    markDirty(); renderEvents(); renderTimelineBlocks();
}

function duplicateSelectedCue() {
    const ev = events.find(x => x.id === activeId);
    if (!ev) { alert('Select a cue first.'); return; }
    const dur = tcToSecs(ev.endTime) - tcToSecs(ev.startTime);
    const newStart = tcToSecs(ev.endTime);
    const clone = { ...ev, id: nextTempId--, startTime: secsToSrtTc(newStart), endTime: secsToSrtTc(newStart + dur) };
    const idx = events.findIndex(x => x.id === ev.id);
    events.splice(idx + 1, 0, clone);
    activeId = clone.id;
    selectedIds = new Set([clone.id]);
    markDirty(); renderEvents(); renderTimelineBlocks();
}

function toggleLockSelected() {
    const ids = selectedIds.size ? [...selectedIds] : (activeId != null ? [activeId] : []);
    if (!ids.length) { alert('Select a cue first.'); return; }
    const anyUnlocked = ids.some(id => !lockedIds.has(id));
    ids.forEach(id => anyUnlocked ? lockedIds.add(id) : lockedIds.delete(id));
    saveLocked();
    renderEvents();
    renderTimelineBlocks();
}

function toggleLockId(id) {
    lockedIds.has(id) ? lockedIds.delete(id) : lockedIds.add(id);
    saveLocked();
    renderEvents();
    renderTimelineBlocks();
}

// ── Start-only nudge (duration changes, unlike nudgeSelected which moves both) ──
function moveStart(direction) {
    const targets = selectionTargets();
    if (!targets.length) { alert('Select a cue first.'); return; }
    const amount = nudgeStepAmount() * direction;
    targets.forEach(id => {
        const ev = events.find(x => x.id === id);
        const s = tcToSecs(ev.startTime) + amount, e = tcToSecs(ev.endTime);
        if (s < 0 || e - s < MIN_CUE_DUR) return;
        ev.startTime = secsToSrtTc(s);
    });
    markDirty(); renderEvents(); renderTimelineBlocks();
}

const TARGET_CPS = 17; // matches the "ideal" reading speed shown elsewhere in the UI
function setOutByReadingSpeed() {
    const targets = selectionTargets();
    if (!targets.length) { alert('Select a cue first.'); return; }
    targets.forEach(id => {
        const ev = events.find(x => x.id === id);
        const text = (ev.translatedText || ev.originalText || '').replace(/\s/g, '');
        if (!text.length) return;
        const start = tcToSecs(ev.startTime);
        ev.endTime = secsToSrtTc(start + Math.max(MIN_CUE_DUR, text.length / TARGET_CPS));
    });
    markDirty(); renderEvents(); renderTimelineBlocks();
}

function seekToEventStart() {
    const ev = events.find(x => x.id === activeId);
    if (!ev || !video) { alert('Select a cue first.'); return; }
    video.currentTime = tcToSecs(ev.startTime);
}

// Jumps to the nearest cue boundary before/after the playhead — handy for
// lining the playhead back up with existing cues without picking one first.
function seekToPreviousStart() {
    if (!video) return;
    const starts = events.map(ev => tcToSecs(ev.startTime)).filter(t => t < video.currentTime - 0.0005).sort((a, b) => b - a);
    if (!starts.length) { alert('No earlier cue start to jump to.'); return; }
    video.currentTime = starts[0];
}
function seekToNextEnd() {
    if (!video) return;
    const ends = events.map(ev => tcToSecs(ev.endTime)).filter(t => t > video.currentTime + 0.0005).sort((a, b) => a - b);
    if (!ends.length) { alert('No later cue end to jump to.'); return; }
    video.currentTime = ends[0];
}

function mergeWithPrevious() {
    if (!loaded) return;
    const idx = events.findIndex(ev => ev.id === activeId);
    if (idx <= 0) { alert('Select a cue that has a previous cue to merge with.'); return; }
    const merged = SubtitleCore.mergeCues(events[idx - 1], events[idx]);
    events.splice(idx - 1, 2, { ...merged, id: events[idx - 1].id, originalLocked: events[idx - 1].originalLocked || events[idx].originalLocked });
    activeId = events[idx - 1].id;
    selectedIds = new Set([activeId]);
    markDirty(); renderEvents(); renderTimelineBlocks();
}

// "Link" closes the gap (or overlap) between two adjacent cues by snapping
// the shared boundary together — it doesn't keep them permanently coupled.
function linkToPrevious() {
    const idx = events.findIndex(ev => ev.id === activeId);
    if (idx <= 0) { alert('Select a cue that has a previous cue.'); return; }
    events[idx].startTime = events[idx - 1].endTime;
    markDirty(); renderEvents(); renderTimelineBlocks();
}
function linkToNext() {
    const idx = events.findIndex(ev => ev.id === activeId);
    if (idx === -1 || idx >= events.length - 1) { alert('Select a cue that has a next cue.'); return; }
    events[idx].endTime = events[idx + 1].startTime;
    markDirty(); renderEvents(); renderTimelineBlocks();
}

// Splits the active cue at the text caret position (proportionally, by
// character offset) instead of at the video playhead like the toolbar split.
function splitAtCaret(snapToFrame) {
    if (!loaded) return;
    const idx = events.findIndex(ev => ev.id === activeId);
    if (idx === -1) { alert('Select a cue first.'); return; }
    const textarea = document.querySelector(`.tm-translated-input[data-id="${activeId}"]`);
    if (!textarea || document.activeElement !== textarea) { alert('Place your cursor in the translation text where you want to split.'); return; }
    const text = textarea.value;
    if (!text.length) { alert('This cue has no translation text to split at.'); return; }
    const ratio = textarea.selectionStart / text.length;
    const cue = events[idx];
    const start = tcToSecs(cue.startTime), end = tcToSecs(cue.endTime);
    let atSeconds = start + ratio * (end - start);
    if (snapToFrame) atSeconds = Math.round(atSeconds * fps) / fps;
    try {
        const [a, b] = SubtitleCore.splitCue(cue, atSeconds);
        events.splice(idx, 1, { ...a, id: cue.id }, { ...b, id: nextTempId-- });
        activeId = cue.id;
        selectedIds = new Set([activeId]);
        markDirty(); renderEvents(); renderTimelineBlocks();
    } catch (error) { alert(error.message); }
}

// Cycles the selection through whatever cues currently match the search box
// and quality filter — lets you step through results instead of hunting.
function findAdjacentMatch(direction) {
    const matches = events.filter(matchesFilter);
    if (!matches.length) { alert('No matching cues.'); return; }
    const idx = matches.findIndex(ev => ev.id === activeId);
    const next = matches[(idx + direction + matches.length) % matches.length];
    selectEvent(next.id, { scrollBlock: 'center', focusTranslation: true });
    if (video) video.currentTime = tcToSecs(next.startTime);
}

function toggleEventsPanel() { document.querySelector('.tm-editor-body')?.classList.toggle('tm-panel-collapsed'); }
function swapColumns()       { document.querySelector('.tm-editor-right')?.classList.toggle('tm-columns-swapped'); }
function toggleCardLayout()  { document.querySelector('.tm-editor-right')?.classList.toggle('tm-cards-stacked'); }

Shortcuts.on('playPause', () => btnPlay.click());
Shortcuts.on('seekBack1s', () => video && (video.currentTime -= 1));
Shortcuts.on('seekFwd1s',  () => video && (video.currentTime += 1));
Shortcuts.on('skipBack5s', () => btnSkipBack.click());
Shortcuts.on('skipFwd5s',  () => btnSkipFwd.click());
Shortcuts.on('prevFrame',  () => stepFrame(-1));
Shortcuts.on('nextFrame',  () => stepFrame(1));
Shortcuts.on('speedUp',    () => nudgeSpeed(1));
Shortcuts.on('speedDown',  () => nudgeSpeed(-1));

Shortcuts.on('markIn',  markInPoint);
Shortcuts.on('markOut', markOutPoint);
Shortcuts.on('splitCue',   () => document.getElementById('btnSplitCue').click());
Shortcuts.on('mergeCue',   () => document.getElementById('btnMergeCue').click());
Shortcuts.on('deleteLine', deleteSelectedCue);

Shortcuts.on('undo', () => restoreHistory(-1));
Shortcuts.on('redo', () => restoreHistory(1));
Shortcuts.on('focusFindReplace', focusFindReplace);
Shortcuts.on('replaceAll', () => document.getElementById('replaceAll').click());

Shortcuts.on('nextUntranslated', () => document.getElementById('nextUntranslated').click());
Shortcuts.on('selectNextCue', () => selectAdjacentCue(1));
Shortcuts.on('selectPrevCue', () => selectAdjacentCue(-1));
Shortcuts.on('focusSearch', () => { showWorkspaceTools(); document.getElementById('cueSearch').focus(); });
Shortcuts.on('toggleWorkspaceTools', toggleWorkspaceTools);

Shortcuts.on('copySource', () => document.getElementById('copySource').click());

Shortcuts.on('shiftAllLater',     () => shiftCues(events, 1));
Shortcuts.on('shiftAllEarlier',   () => shiftCues(events, -1));
Shortcuts.on('shiftFromSelected', () => document.getElementById('shiftFromHere').click());
Shortcuts.on('zeroOutTiming',     () => document.getElementById('shiftZero').click());

Shortcuts.on('save', () => { clearTimeout(autoSaveTimer); doSave(); });
Shortcuts.on('importScript', () => importScript.click());
Shortcuts.on('exportSrt', () => btnExportSrt.click());
Shortcuts.on('exportVtt', () => btnExportVtt.click());
Shortcuts.on('addLine', () => btnAddEvent.click());

// ── Timeline: playback, zoom, snapping, nudging, locking ──
Shortcuts.on('stopPlayback',     stopPlayback);
Shortcuts.on('rewind',           () => rewindSeconds(10));
Shortcuts.on('fastForward',      () => fastForwardSeconds(10));
Shortcuts.on('playSelectedRange', playSelectedRange);
Shortcuts.on('toggleAutoPauseOut', () => document.getElementById('tlAutoPauseOut')?.click());
Shortcuts.on('zoomIn',   () => setZoom(pxPerSecond * 1.5));
Shortcuts.on('zoomOut',  () => setZoom(pxPerSecond / 1.5));
Shortcuts.on('zoomFit',  () => setZoom(fitZoom()));
Shortcuts.on('toggleSnap', () => document.getElementById('tlSnap')?.click());
Shortcuts.on('nudgeEarlier',   () => nudgeSelected(-1));
Shortcuts.on('nudgeLater',     () => nudgeSelected(1));
Shortcuts.on('shrinkDuration', () => resizeDurationSelected(-1));
Shortcuts.on('growDuration',   () => resizeDurationSelected(1));
Shortcuts.on('duplicateCue',        duplicateSelectedCue);
Shortcuts.on('toggleLockSelected',  toggleLockSelected);
Shortcuts.on('moveStartEarlier', () => moveStart(-1));
Shortcuts.on('moveStartLater',   () => moveStart(1));
Shortcuts.on('setOutByReadingSpeed', setOutByReadingSpeed);
Shortcuts.on('seekBackHalfSec', () => rewindSeconds(0.5));
Shortcuts.on('seekFwdHalfSec',  () => fastForwardSeconds(0.5));
Shortcuts.on('seekToEventStart',    seekToEventStart);
Shortcuts.on('seekToPreviousStart', seekToPreviousStart);
Shortcuts.on('seekToNextEnd',       seekToNextEnd);
Shortcuts.on('mergeCuePrevious', mergeWithPrevious);
Shortcuts.on('linkPrevious', linkToPrevious);
Shortcuts.on('linkNext',     linkToNext);
Shortcuts.on('splitAtCaret',      () => splitAtCaret(false));
Shortcuts.on('splitAtCaretFrame', () => splitAtCaret(true));
Shortcuts.on('findNext',     () => findAdjacentMatch(1));
Shortcuts.on('findPrevious', () => findAdjacentMatch(-1));
Shortcuts.on('toggleEventsPanel', toggleEventsPanel);
Shortcuts.on('swapColumns',       swapColumns);
Shortcuts.on('toggleCardLayout',  toggleCardLayout);
Shortcuts.on('openSettings', () => { window.location.href = '/settings/shortcuts'; });

// Tab is browser-owned and cannot be rebound, so it keeps its familiar job:
// move to the next cue's translation box. In focus mode only the open cue has
// one, so this opens the next cue rather than hunting for another textarea.
// Shift+Tab steps back the same way.
document.addEventListener('keydown', e => {
    if (e.code !== 'Tab') return;
    if (!e.target.classList?.contains('tm-translated-input')) return;
    e.preventDefault();
    selectAdjacentCue(e.shiftKey ? -1 : 1);
});

// ══════════════════════════════════════════════════
//  SUBTITLE OVERLAY
// ══════════════════════════════════════════════════

function updateOverlay() {
    if (!video) return;
    const cur = video.currentTime;
    const active = events.find(ev =>
        tcToSecs(ev.startTime) <= cur && tcToSecs(ev.endTime) >= cur);
    const text = active?.translatedText || active?.originalText || '';
    overlay.textContent = text;
    overlay.style.display = text ? 'block' : 'none';
}

// ══════════════════════════════════════════════════
//  TIMELINE
// ══════════════════════════════════════════════════

// ── Zoom & scroll ────────────────────────────────────
// How much time the timeline has to cover: the video, plus any cue that runs
// past its end, so no cue can ever sit outside the drawn strip.
function timelineSpan() {
    let span = Number.isFinite(video?.duration) ? video.duration : 0;
    for (const ev of events) {
        const end = tcToSecs(ev.endTime);
        if (Number.isFinite(end) && end > span) span = end;
    }
    return span;
}

function fitZoom() {
    const span = timelineSpan();
    const width = timelineScroll?.clientWidth;
    if (!span || !Number.isFinite(width) || width <= 0) return MIN_PX_PER_SEC;
    return Math.max(MIN_PX_PER_SEC, width / span);
}

function setZoom(next, anchorSecs) {
    if (!timelineSpan()) return;
    const clamped = Math.min(MAX_PX_PER_SEC, Math.max(fitZoom(), next));
    if (!Number.isFinite(clamped) || clamped <= 0) return;
    const anchor = anchorSecs ?? video?.currentTime ?? 0;
    pxPerSecond = clamped;
    // Set scroll position before drawing so the ruler/waveform redraw already
    // reflects the new viewport instead of flashing the old one for a frame.
    timelineScroll.scrollLeft = Math.max(0, anchor * pxPerSecond - timelineScroll.clientWidth / 2);
    drawTimelineRuler();
    renderTimelineBlocks(); // block positions depend on pxPerSecond
}

let rulerRedrawScheduled = false;
function scheduleRulerRedraw() {
    if (rulerRedrawScheduled) return;
    rulerRedrawScheduled = true;
    requestAnimationFrame(() => { rulerRedrawScheduled = false; drawTimelineRuler(); });
}
timelineScroll?.addEventListener('scroll', scheduleRulerRedraw);

function keepPlayheadVisible() {
    if (!timelineScroll) return;
    const x = video.currentTime * pxPerSecond;
    const viewW = timelineScroll.clientWidth;
    const left = timelineScroll.scrollLeft;
    if (x < left + 30 || x > left + viewW - 30) {
        timelineScroll.scrollLeft = Math.max(0, x - viewW / 2);
    }
}

function scrollBlockIntoView(id, center = false) {
    const ev = events.find(x => x.id === id);
    if (!ev || !timelineScroll) return;
    const start = tcToSecs(ev.startTime) * pxPerSecond;
    const end   = tcToSecs(ev.endTime) * pxPerSecond;
    const viewW = timelineScroll.clientWidth;
    const left  = timelineScroll.scrollLeft;
    if (center) {
        timelineScroll.scrollLeft = Math.max(0, (start + end) / 2 - viewW / 2);
    } else if (start < left || end > left + viewW) {
        timelineScroll.scrollLeft = Math.max(0, start - viewW / 3);
    }
}

// The canvas only ever renders the currently-scrolled-into-view time window
// (viewport-sized, "sticky" to the left of the scroll container) instead of
// the whole video duration — a 2-hour movie at a readable zoom would need a
// canvas millions of pixels wide, past what browsers allow. The much wider
// timelineInner div (and the cue blocks inside it) still spans the whole
// duration since plain positioned divs don't have that limit, so scrolling
// still works over the full track.
function drawTimelineRuler() {
    if (!canvas || !timelineSpan()) return;
    const innerW = Math.max(timelineSpan() * pxPerSecond, timelineScroll.clientWidth);
    timelineInner.style.width = innerW + 'px';

    // The drawn strip matches the scroll container's content box exactly, so
    // the canvas covers the visible window and no more.
    const W = timelineScroll.clientWidth || innerW;
    const H = timelineScroll.clientHeight || timelineWrap.offsetHeight;
    canvas.width  = W;
    canvas.height = H;
    const originSecs = timelineScroll.scrollLeft / pxPerSecond;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#141417');
    grad.addColorStop(1, '#0a0a0c');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    drawTimecodeRuler(ctx, W, H, originSecs);

    if (video?.src || video?.currentSrc) {
        drawWaveform(ctx, W, H, originSecs);
    }
}

// Picks a "nice" tick spacing (seconds) so labeled ticks land at least
// minPx apart on screen at the current zoom, however far in or out that is.
const TICK_STEPS = [0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
function pickTickInterval(minPx) {
    for (const step of TICK_STEPS) if (step * pxPerSecond >= minPx) return step;
    return TICK_STEPS[TICK_STEPS.length - 1];
}

function drawTimecodeRuler(ctx, W, H, originSecs) {
    // Ticks cover the whole timeline, not just the loaded video: cues timed
    // past its end (or with no video at all) still need a readable ruler.
    const dur = timelineSpan();
    if (!dur) return;
    const interval = pickTickInterval(80);

    // Ruler background
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, W, 20);

    const firstN = Math.max(0, Math.floor(originSecs / interval) - 1);
    if (!Number.isFinite(firstN) || !Number.isFinite(interval) || interval <= 0) return;
    // Bounded: at one tick per minPx across the canvas there can only be so
    // many, and an unbounded loop here would freeze the page outright.
    const maxTicks = Math.ceil(W / 8) + 4;
    for (let n = firstN, drawn = 0; drawn < maxTicks; n++, drawn++) {
        const t = n * interval;
        if (t > dur) break;
        const x = (t - originSecs) * pxPerSecond;
        if (x > W + 2) break;
        if (x < -2) continue;

        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 1;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 20);
        ctx.stroke();

        const { hms, f } = secsToHMSF(t);
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = 'bold 10px "Courier New"';
        ctx.textAlign = 'left';
        ctx.fillText(`${hms}:${f}`, x + 3, 13);
    }

    // Frame ticks, once zoomed in enough for them to be legible
    if (pxPerSecond / fps >= 6) {
        const frameLen = 1 / fps;
        const startFrame = Math.max(0, Math.floor(originSecs / frameLen) - 1);
        const endFrame = Math.ceil((originSecs + W / pxPerSecond) / frameLen) + 1;
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 1;
        for (let f = startFrame; f <= endFrame; f++) {
            if (f % Math.round(fps) === 0) continue; // whole seconds already drawn above
            const t = f * frameLen;
            if (t > dur) break;
            const x = (t - originSecs) * pxPerSecond;
            ctx.beginPath();
            ctx.moveTo(x, 15);
            ctx.lineTo(x, 20);
            ctx.stroke();
        }
    }

    // Bottom border on ruler
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth   = 1;
    ctx.moveTo(0, 20);
    ctx.lineTo(W, 20);
    ctx.stroke();
}

let audioDataPromise;
async function drawWaveform(ctx, W, H, originSecs) {
    try {
        const data = await (audioDataPromise ||= decodeAudio());
        if (canvas.width !== W) return; // a newer draw already took over
        const dur = video.duration || 1;
        const samplesPerSecond = data.length / dur;
        const midY   = H / 2;
        const rulerH = 25; // ruler (20px) + dialogue/silence strip (4px) below it
        const amp    = (midY - rulerH - 4) * 0.95;
        const playedX = (video.currentTime - originSecs) * pxPerSecond;

        const SILENCE_THRESHOLD = 0.02;
        for (let x = 0; x < W; x++) {
            const t0 = originSecs + x / pxPerSecond;
            const i0 = Math.max(0, Math.floor(t0 * samplesPerSecond));
            const i1 = Math.max(i0 + 1, Math.floor((t0 + 1 / pxPerSecond) * samplesPerSecond));
            let peak = 0;
            for (let j = i0; j < i1 && j < data.length; j++) {
                const v = Math.abs(data[j]);
                if (v > peak) peak = v;
            }
            const h = Math.max(peak * amp, 1);
            ctx.strokeStyle = x < playedX
                ? 'rgba(255,255,255,0.95)'
                : 'rgba(255, 212, 0, 0.85)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, midY - h);
            ctx.lineTo(x, midY + h);
            ctx.stroke();

            // Thin dialogue/silence strip just under the timecode ruler,
            // using this same per-column peak (no extra pass over the samples).
            ctx.fillStyle = peak < SILENCE_THRESHOLD ? 'rgba(0,0,0,0.5)' : 'rgba(255,212,0,0.25)';
            ctx.fillRect(x, 21, 1, 4);
        }

        // Center axis
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth   = 1;
        ctx.setLineDash([3, 6]);
        ctx.moveTo(0, midY);
        ctx.lineTo(W, midY);
        ctx.stroke();
        ctx.setLineDash([]);
        // The playhead itself is the separate #timelineCursor div (always
        // pixel-accurate via normal scrolling); no need to draw it here too.
    } catch (e) {
        drawFallbackWaveform(ctx, W, H);
    }
}

function drawFallbackWaveform(ctx, W, H) {
    // Sits just under the ruler rather than across the middle, where it would
    // print over the cue blocks.
    ctx.fillStyle = 'rgba(154,154,165,0.75)';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Audio waveform unavailable — use the timeline to seek', 14, 38);
}

// ── Blocks: render, select, drag, resize ────────────
function handleBlockSelect(e, id) {
    if (e.shiftKey && activeId != null) {
        const ids = events.map(ev => ev.id);
        const a = ids.indexOf(activeId), b = ids.indexOf(id);
        const [lo, hi] = a < b ? [a, b] : [b, a];
        selectedIds = new Set(ids.slice(lo, hi + 1));
        activeId = id;
    } else if (e.ctrlKey || e.metaKey) {
        if (selectedIds.has(id)) { selectedIds.delete(id); activeId = selectedIds.size ? [...selectedIds].pop() : null; }
        else { selectedIds.add(id); activeId = id; }
    } else {
        selectedIds = new Set([id]);
        activeId = id;
    }
    const ev = events.find(x => x.id === id);
    if (video && ev) video.currentTime = tcToSecs(ev.startTime);
    // Open the clicked cue in the panel too, so the timeline and the cue list
    // never disagree about what is being edited. A range or toggle selection
    // keeps its extra members; selectEvent would collapse them to one.
    const range = new Set(selectedIds);
    selectEvent(id, { scrollBlock: 'nearest' });
    selectedIds = range;
    updateSelection();
    scrollBlockIntoView(id);
}

function snapValue(t, excludeIds) {
    if (!snapEnabled) return t;
    const candidates = [];
    if (video) candidates.push(video.currentTime);
    events.forEach(ev => {
        if (excludeIds.includes(ev.id)) return;
        candidates.push(tcToSecs(ev.startTime), tcToSecs(ev.endTime));
    });
    const frameLen = 1 / fps;
    candidates.push(Math.round(t / frameLen) * frameLen);
    const threshold = SNAP_PX / pxPerSecond;
    let best = t, bestDist = threshold;
    for (const c of candidates) {
        const d = Math.abs(c - t);
        if (d < bestDist) { bestDist = d; best = c; }
    }
    return best;
}

function updateBlockDom(id) {
    const ev = events.find(x => x.id === id);
    if (!ev) return;
    const block = timelineEvents.querySelector(`.tm-timeline-block[data-id="${id}"]`);
    if (block) {
        block.style.left  = (tcToSecs(ev.startTime) * pxPerSecond) + 'px';
        block.style.width = Math.max((tcToSecs(ev.endTime) - tcToSecs(ev.startTime)) * pxPerSecond, 3) + 'px';
    }
    const startInput = eventsList.querySelector(`.tm-tc-input[data-id="${id}"][data-field="startTime"]`);
    const endInput   = eventsList.querySelector(`.tm-tc-input[data-id="${id}"][data-field="endTime"]`);
    if (startInput) startInput.value = ev.startTime;
    if (endInput)   endInput.value   = ev.endTime;
}

function startDrag(e, id, mode) {
    if (lockedIds.has(id)) return;
    e.preventDefault();
    e.stopPropagation();
    const targets = (mode === 'move' && selectedIds.has(id) && selectedIds.size > 1)
        ? [...selectedIds].filter(tid => !lockedIds.has(tid))
        : [id];
    const orig = new Map();
    targets.forEach(tid => {
        const ev = events.find(x => x.id === tid);
        orig.set(tid, { start: tcToSecs(ev.startTime), end: tcToSecs(ev.endTime) });
    });
    dragState = { mode, ids: targets, primaryId: id, startX: e.clientX, orig };
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
}

function onDragMove(e) {
    if (!dragState) return;
    const { mode, ids, orig, primaryId } = dragState;
    const deltaSecs = (e.clientX - dragState.startX) / pxPerSecond;

    if (mode === 'move') {
        let clampedDelta = deltaSecs;
        const minStart = Math.min(...[...orig.values()].map(o => o.start));
        if (minStart + clampedDelta < 0) clampedDelta = -minStart;
        const primary = orig.get(primaryId);
        const snappedStart = snapValue(primary.start + clampedDelta, ids);
        const snapDelta = snappedStart - primary.start;
        ids.forEach(id => {
            const o = orig.get(id);
            const ev = events.find(x => x.id === id);
            const newStart = Math.max(0, o.start + snapDelta);
            ev.startTime = secsToSrtTc(newStart);
            ev.endTime   = secsToSrtTc(newStart + (o.end - o.start));
            updateBlockDom(id);
        });
    } else if (mode === 'resize-left') {
        const o = orig.get(ids[0]);
        const ev = events.find(x => x.id === ids[0]);
        const newStart = Math.min(Math.max(snapValue(o.start + deltaSecs, ids), 0), o.end - MIN_CUE_DUR);
        ev.startTime = secsToSrtTc(newStart);
        updateBlockDom(ids[0]);
    } else if (mode === 'resize-right') {
        const o = orig.get(ids[0]);
        const ev = events.find(x => x.id === ids[0]);
        const newEnd = Math.max(snapValue(o.end + deltaSecs, ids), o.start + MIN_CUE_DUR);
        ev.endTime = secsToSrtTc(newEnd);
        updateBlockDom(ids[0]);
    }
}

function onDragEnd() {
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
    document.body.style.userSelect = '';
    if (dragState) {
        const changed = dragState.ids.some(id => {
            const o = dragState.orig.get(id);
            const ev = events.find(x => x.id === id);
            return Math.abs(tcToSecs(ev.startTime) - o.start) > 0.0005 || Math.abs(tcToSecs(ev.endTime) - o.end) > 0.0005;
        });
        if (changed) { markDirty(); renderEvents(); renderTimelineBlocks(); }
    }
    dragState = null;
}

function renderTimelineBlocks() {
    if (!timelineEvents || !timelineSpan()) return;
    timelineEvents.innerHTML = '';

    events.forEach((ev, i) => {
        const start = tcToSecs(ev.startTime);
        const end   = tcToSecs(ev.endTime);
        const left  = start * pxPerSecond;
        const width = Math.max((end - start) * pxPerSecond, 3);
        const issues = issuesAt(i);
        const isLocked = lockedIds.has(ev.id);
        const isMultiSelected = selectedIds.has(ev.id) && ev.id !== activeId;
        // "Untranslated" is a workflow state, not a timing defect — it shouldn't
        // paint a cue as a warning the moment it's created.
        const hasRealIssue = issues.some(i => i !== 'Untranslated');
        const statusClass = issues.includes('Invalid timing') ? ' tm-timeline-block-invalid'
            : issues.includes('Overlapping cues') ? ' tm-timeline-block-overlap'
            : hasRealIssue ? ' tm-timeline-block-warn'
            : ev.translatedText?.trim() ? ' tm-timeline-block-done'
            : '';

        const block = document.createElement('div');
        block.className = 'tm-timeline-block'
            + (ev.id === activeId ? ' tm-timeline-block-active' : '')
            + (isMultiSelected ? ' tm-timeline-block-selected' : '')
            + statusClass
            + (isLocked ? ' tm-timeline-block-locked' : '');
        block.style.left  = left + 'px';
        block.style.width = width + 'px';
        block.dataset.id  = ev.id;
        const snippet = (ev.translatedText || ev.originalText || '').replace(/\s+/g, ' ').trim();
        block.title = `#${ev.index} ${ev.startTime} → ${ev.endTime}`
            + (snippet ? ` · ${snippet.slice(0, 60)}` : '')
            + (issues.length ? ` · ${issues.join(', ')}` : '')
            + (isLocked ? ' · Locked' : '');

        if (width > 34) {
            const label = document.createElement('span');
            label.className = 'tm-block-label';
            label.textContent = `#${ev.index}${snippet ? ' · ' + snippet.slice(0, 30) : ''}`;
            block.appendChild(label);
        }
        if (isLocked) {
            const lockIcon = document.createElement('i');
            lockIcon.className = 'bi bi-lock-fill tm-block-lock-icon';
            block.appendChild(lockIcon);
        } else {
            const leftHandle  = document.createElement('div');
            const rightHandle = document.createElement('div');
            leftHandle.className  = 'tm-block-handle tm-block-handle-left';
            rightHandle.className = 'tm-block-handle tm-block-handle-right';
            leftHandle.addEventListener('mousedown',  e => { handleBlockSelect(e, ev.id); startDrag(e, ev.id, 'resize-left'); });
            rightHandle.addEventListener('mousedown', e => { handleBlockSelect(e, ev.id); startDrag(e, ev.id, 'resize-right'); });
            block.appendChild(leftHandle);
            block.appendChild(rightHandle);
        }

        block.addEventListener('mousedown', e => {
            handleBlockSelect(e, ev.id);
            if (!isLocked) startDrag(e, ev.id, 'move');
        });
        timelineEvents.appendChild(block);
    });
}

function updateCursor() {
    if (!video?.duration) return;
    cursor.style.left = (video.currentTime * pxPerSecond) + 'px';
    if (!video.paused) keepPlayheadVisible();
}

// ══════════════════════════════════════════════════
//  EVENTS LIST
// ══════════════════════════════════════════════════

// Scrolls the cue list only — never the page — so the whole card lands in
// view. 'center' parks it mid-list for deliberate keyboard navigation;
// 'nearest' only scrolls when the card is actually out of view, which suits
// auto-follow during playback. Both clamp to the list's own scroll range, so
// a card can never come to rest under the header or the timeline. Scrolling
// is instant so held-down keys cannot queue overlapping smooth animations.
function scrollCardInList(card, block) {
    const list = eventsList;
    const listRect = list.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const cardTop = cardRect.top - listRect.top + list.scrollTop;
    let target;
    if (block === 'center') {
        target = cardTop - Math.max(12, (list.clientHeight - cardRect.height) / 2);
    } else {
        const margin = 12;
        if (cardRect.top >= listRect.top + margin && cardRect.bottom <= listRect.bottom - margin) return;
        target = cardRect.top < listRect.top + margin
            ? cardTop - margin
            : cardTop + cardRect.height - list.clientHeight + margin;
    }
    target = Math.max(0, Math.min(target, list.scrollHeight - list.clientHeight));
    if (Math.abs(target - list.scrollTop) > 1) list.scrollTo({ top: target, behavior: 'auto' });
}

// Moves the selection to one cue: collapses whichever cue was open, opens
// this one into its editing card, brings it into view in both the list and
// the timeline, and optionally drops the caret straight into its
// translation box so keyboard navigation needs no click.
function selectEvent(id, options = {}) {
    const { scrollBlock = 'nearest', focusTranslation = false } = options;
    const previous = activeId;
    activeId = id;
    selectedIds = new Set([id]);
    autoPauseArmed = true;

    if (previous !== id && previous != null) refreshCue(previous, { keepCaret: false });
    const card = refreshCue(id, { keepCaret: false });
    updateSelection();
    fitOpenCard();

    // Measure only after the card has taken its final height, or the scroll
    // lands where the collapsed row used to be.
    if (card) scrollCardInList(card, scrollBlock);
    scrollBlockIntoView(id, scrollBlock === 'center');
    // preventScroll: the browser's own focus-scroll would fight the manual
    // positioning above and cause a visible jump.
    if (focusTranslation) card?.querySelector('.tm-translated-input')?.focus({ preventScroll: true });

    const ev = events.find(x => x.id === id);
    if (ev) {
        const text = ev.translatedText || ev.originalText || '';
        overlay.textContent    = text;
        overlay.style.display  = text.trim() ? 'block' : 'none';
    }
}

function highlightActiveEvent() {
    if (!video || document.activeElement?.matches('input, textarea, select')) return;
    const cur = video.currentTime;
    const match = events.find(ev =>
        tcToSecs(ev.startTime) <= cur && tcToSecs(ev.endTime) >= cur);
    if (match && match.id !== activeId) selectEvent(match.id);
}

// ══════════════════════════════════════════════════
//  CUE LIST — focus mode
// ══════════════════════════════════════════════════
// Only the cue being worked on is expanded into a full editing card; every
// other cue stays a compact single-line row. A translator then sees ten or
// more cues of context at once and — crucially — the card they are typing
// in always fits on screen, which a list of full-height cards cannot do on
// a laptop.
//
// Rows are built as one HTML string and driven by a single set of delegated
// listeners on the list rather than per-card listeners, so a 1500-cue film
// stays cheap to render and to re-render.

// A cue's status drives both its row dot and its timeline block colour.
function cueStatus(ev) {
    const problems = issuesOf(ev);
    if (problems.includes('Invalid timing'))      return 'invalid';
    if (problems.includes('Overlapping cues'))    return 'overlap';
    if (!ev.translatedText?.trim())               return 'todo';
    if (problems.some(p => p !== 'Untranslated')) return 'warn';
    return 'done';
}

// The translator's own marking for a cue, quite separate from the
// automatic quality flags above.
const CUE_STATUS = [
    { value: 0, label: 'Draft',        icon: '',                     hint: 'Not finished yet' },
    { value: 1, label: 'Done',         icon: 'bi-check-circle-fill', hint: 'Finished by the translator' },
    { value: 2, label: 'Needs review', icon: 'bi-flag-fill',         hint: 'Flagged for a second opinion' },
    { value: 3, label: 'Approved',     icon: 'bi-patch-check-fill',  hint: 'Signed off by a reviewer' },
];

// A row shows that a revisor touched it without opening: a lamp for a
// suggestion still to be decided, a flag for a problem they raised.
function reviewChips(ev) {
    let out = '';
    if (hasSuggestion(ev)) {
        const state = ev.suggestionState || 0;
        const title = state === 2 ? 'Suggestion applied'
                    : state === 3 ? 'Suggestion dismissed'
                    : 'Suggestion waiting for you';
        out += '<i class="bi bi-lightbulb-fill tm-cue-suggestion tm-cue-suggestion-'
             + state + '" title="' + title + '"></i>';
    }
    if (isFlagged(ev)) {
        const severity = ['none', 'minor', 'major', 'critical'][ev.reviewSeverity || 0];
        out += '<i class="bi bi-flag-fill tm-cue-flagmark tm-severity-'
             + severity + '" title="Flagged by the revisor"></i>';
    }
    return out;
}

// Draft is the default and would be noise on every row, so it shows nothing.
function statusChip(ev) {
    const status = CUE_STATUS[ev.status || 0];
    if (!status || !status.icon) return '';
    return `<i class="bi ${status.icon} tm-cue-flag tm-cue-flag-${status.value}" title="${status.label} — ${status.hint}"></i>`;
}

const STATUS_TITLE = {
    invalid: 'Invalid timing',
    overlap: 'Overlaps a neighbouring cue',
    todo:    'Not translated yet',
    warn:    'Needs attention',
    done:    'Translated, no issues',
};

// Rows are narrow, so the hour is dropped when it is zero and milliseconds
// are cut to tenths. The open card still shows the full timecode.
function shortTc(tc) {
    return String(tc || '').replace(/^00:/, '').replace(/,(\d)\d\d$/, '.$1');
}

function cueRowHtml(ev, i) {
    const status   = cueStatus(ev);
    const isLocked = lockedIds.has(ev.id);
    const dur      = Math.max(0, tcToSecs(ev.endTime) - tcToSecs(ev.startTime));
    const src      = (ev.originalText   || '').replace(/\n/g, ' ');
    const dst      = (ev.translatedText || '').replace(/\n/g, ' ');
    const marks    = reviewChips(ev)
                   + statusChip(ev)
                   + (ev.comment?.trim() ? '<i class="bi bi-chat-left-text-fill" title="Has a comment"></i>' : '')
                   + (isLocked ? '<i class="bi bi-lock-fill" title="Locked"></i>' : '');
    return `<div class="tm-cue-item tm-cue-row${isLocked ? ' tm-event-locked' : ''}" data-id="${ev.id}" role="button" tabindex="0" aria-label="Cue ${i + 1}, ${STATUS_TITLE[status]}">
<span class="tm-cue-status tm-cue-status-${status}" title="${STATUS_TITLE[status]}"></span>
<span class="tm-cue-num">${i + 1}</span>
<span class="tm-cue-time">${escapeHtml(shortTc(ev.startTime))}</span>
<span class="tm-cue-dur">${dur.toFixed(1)}s</span>
<span class="tm-cue-text tm-cue-text-src" dir="auto">${escapeHtml(src) || '<em>—</em>'}</span>
<span class="tm-cue-text tm-cue-text-dst" dir="auto">${escapeHtml(dst) || '<em>—</em>'}</span>
<span class="tm-cue-marks">${marks}</span>
</div>`;
}

function cueCardHtml(ev, i) {
    const cps      = readingSpeed(ev.translatedText, ev.startTime, ev.endTime);
    const cpsNum   = parseFloat(cps);
    // Amber a little before the limit, red past it.
    const cpsColor = isNaN(cpsNum)                          ? 'var(--text-muted)'
                   : cpsNum > deliveryProfile.maxCps        ? 'var(--danger)'
                   : cpsNum > deliveryProfile.maxCps * 0.85 ? 'var(--warning)'
                   : 'var(--success)';
    const isLocked = lockedIds.has(ev.id);
    const dis      = isLocked ? 'disabled' : '';
    const durStr   = Math.max(0, tcToSecs(ev.endTime) - tcToSecs(ev.startTime)).toFixed(2) + 's';
    const hasNote  = !!ev.comment?.trim();

    return `<div class="tm-cue-item tm-event-card tm-cue-item-open${isLocked ? ' tm-event-locked' : ''}" data-id="${ev.id}">
    <div class="tm-event-meta">
        <span class="tm-event-index">#${i + 1}</span>
        <div class="tm-event-times">
            <div class="tm-tc-group">
                <span class="tm-tc-label">IN</span>
                <input class="tm-tc-input" aria-label="Cue ${i + 1} start time" value="${escapeHtml(ev.startTime)}"
                       data-field="startTime" data-id="${ev.id}" ${dis} />
            </div>
            <i class="bi bi-arrow-right tm-tc-arrow"></i>
            <div class="tm-tc-group">
                <span class="tm-tc-label">OUT</span>
                <input class="tm-tc-input" aria-label="Cue ${i + 1} end time" value="${escapeHtml(ev.endTime)}"
                       data-field="endTime" data-id="${ev.id}" ${dis} />
            </div>
            <button class="tm-icon-btn-sm tm-mark-btn" data-mark="in" data-id="${ev.id}" ${dis}
                    title="Mark IN from playhead"><i class="bi bi-record-circle"></i> I</button>
            <button class="tm-icon-btn-sm tm-mark-btn" data-mark="out" data-id="${ev.id}" ${dis}
                    title="Mark OUT from playhead"><i class="bi bi-record-circle"></i> O</button>
        </div>
        <span class="tm-duration-badge" title="Duration"><i class="bi bi-clock"></i> ${durStr}</span>
        <span class="tm-cps-badge" style="color:${cpsColor};" title="Reading speed — this project's limit is ${deliveryProfile.maxCps} characters per second">${cps} c/s</span>
        ${CAN_EDIT_TRANSLATION ? `<select class="tm-cue-status-select tm-cue-status-select-${ev.status || 0}" data-field="status" data-id="${ev.id}"
                aria-label="Cue ${i + 1} status" title="Where this line stands in your workflow">
            ${CUE_STATUS.map(s => `<option value="${s.value}"${(ev.status || 0) === s.value ? ' selected' : ''}>${s.label}</option>`).join('')}
        </select>` : ''}
        <button class="tm-icon-btn-sm tm-comment-btn${hasNote ? ' tm-comment-btn-has' : ''}" data-id="${ev.id}"
                title="Add or view a comment on this line"><i class="bi bi-chat-left-text${hasNote ? '-fill' : ''}"></i></button>
        <button class="tm-icon-btn-sm tm-lock-btn" data-id="${ev.id}"
                title="${isLocked ? 'Unlock line' : 'Lock line to prevent accidental changes'}"><i class="bi ${isLocked ? 'bi-lock-fill' : 'bi-unlock'}"></i></button>
        ${CAN_EDIT_TRANSLATION ? `<button class="tm-icon-btn-sm tm-delete-btn" data-id="${ev.id}" title="Delete line" ${dis}><i class="bi bi-trash3"></i></button>` : ''}
    </div>

    <div class="tm-event-columns">
        <div class="tm-event-col tm-event-col-original tm-event-col-readonly">
            <div class="tm-col-label">
                <i class="bi bi-lock-fill"></i> Original
                <span class="tm-original-locked-badge">${ev.originalLocked ? 'Imported — read-only' : 'Read-only'}</span>
            </div>
            <textarea dir="auto" aria-label="Cue ${i + 1} source text" class="tm-original-input"
                      placeholder="Import a script or type original text…"
                      data-field="originalText" data-id="${ev.id}" disabled>${escapeHtml(ev.originalText || '')}</textarea>
        </div>
        <div class="tm-event-col tm-event-col-translation">
            <div class="tm-col-label tm-col-label-translation">
                <span><i class="bi bi-pencil-fill"></i> Translation</span>
                <span class="tm-char-counter">${charCountDisplay(ev.translatedText || '')}</span>
            </div>
            <textarea dir="auto" aria-label="Cue ${i + 1} translation" class="tm-translated-input ${charCountClass(ev.translatedText || '')}"
                      placeholder="${CAN_EDIT_TRANSLATION ? 'Type your translation here…' : 'The translator\'s line — suggest a change in the next column.'}"
                      data-field="translatedText" data-id="${ev.id}" ${dis}${CAN_EDIT_TRANSLATION ? '' : ' readonly'}>${escapeHtml(ev.translatedText || '')}</textarea>
        </div>
        ${suggestionColumnHtml(ev, i)}
    </div>

    <div class="tm-event-comment"${hasNote ? '' : ' hidden'}>
        <div class="tm-col-label"><i class="bi bi-chat-left-text"></i> Comment</div>
        <textarea dir="auto" aria-label="Cue ${i + 1} comment" class="tm-comment-input"
                  placeholder="Add a note for this line (context, a question for review…)"
                  data-field="comment" data-id="${ev.id}">${escapeHtml(ev.comment || '')}</textarea>
    </div>
    <p class="tm-quality-hint"></p>
</div>`;
}

function cueHtml(ev, i) {
    return ev.id === activeId ? cueCardHtml(ev, i) : cueRowHtml(ev, i);
}

// Visible cues paired with their number as shown to the translator, which
// is their position in the whole track rather than in the filtered view.
function visibleCues() {
    const out = [];
    events.forEach((ev, i) => { if (matchesFilter(ev, i)) out.push([ev, i]); });
    return out;
}

function renderEvents() {
    const keepScroll = eventsList.scrollTop;
    const shown = visibleCues();

    if (!shown.length) {
        eventsList.innerHTML = `<div class="tm-empty-state">${events.length
            ? 'No matching cues. Try another search or filter.'
            : 'Your translation starts here. Import an SRT / VTT script or add your first line.'}</div>`;
        updateWorkspace();
        return;
    }

    eventsList.innerHTML = shown.map(([ev, i]) => cueHtml(ev, i)).join('');
    eventsList.scrollTop = keepScroll;
    fitOpenCard();
    updateWorkspace();
}

// Swaps a single cue between row and card form without disturbing the rest
// of the list, so scroll position and every other row's DOM survive a
// change of selection.
// keepCaret guards against rebuilding a card the translator is typing in,
// which would drop the caret mid-word. Opening or closing a cue is a
// deliberate change of state, so those callers pass keepCaret:false — leaving
// a focused card expanded would otherwise strand two open cards in the list.
function refreshCue(id, { keepCaret = true } = {}) {
    const node = eventsList.querySelector(`.tm-cue-item[data-id="${id}"]`);
    if (!node) return null;
    if (keepCaret && node.contains(document.activeElement)) return node;
    const idx = events.findIndex(ev => ev.id === id);
    if (idx < 0) return null;
    const holder = document.createElement('div');
    holder.innerHTML = cueHtml(events[idx], idx);
    const fresh = holder.firstElementChild;
    node.replaceWith(fresh);
    return fresh;
}

// The open card must always fit inside the list; a card taller than the
// viewport is the defect this whole layout exists to prevent, because its
// lower half ends up clipped behind the timeline.
//
// Text boxes are the only flexible part of the card, so they grow to fit
// their content and then give that space back — evenly, down to a floor —
// until the card fits. A box that had to be clamped gets its own scrollbar
// rather than silently hiding text.
const CUE_BOX_FLOOR = 32;

function fitOpenCard() {
    const card = eventsList.querySelector('.tm-cue-item-open');
    if (!card) return;
    const boxes = [...card.querySelectorAll('textarea')];
    if (!boxes.length) return;

    boxes.forEach(box => {
        box.style.height = 'auto';
        box.style.overflowY = 'hidden';
        box.style.height = box.scrollHeight + 'px';
    });

    // Available height, less the card's own margins.
    const style = getComputedStyle(card);
    const margins = parseFloat(style.marginTop) + parseFloat(style.marginBottom);
    const available = eventsList.clientHeight - margins;
    let excess = card.getBoundingClientRect().height - available;
    if (excess <= 0) return;

    // The source and translation boxes sit side by side, so only the taller
    // of the two drives the card's height — trim from whichever is tallest
    // until the card fits or every box has reached the floor.
    for (let pass = 0; pass < 12 && excess > 0.5; pass++) {
        const tallest = boxes.reduce((a, b) => (b.clientHeight > a.clientHeight ? b : a));
        const height = tallest.clientHeight;
        if (height <= CUE_BOX_FLOOR) break;
        const next = Math.max(CUE_BOX_FLOOR, height - Math.ceil(excess));
        tallest.style.height = next + 'px';
        tallest.style.overflowY = 'auto';
        excess = card.getBoundingClientRect().height - available;
    }

    // Floors reached and still too tall — for instance both text boxes plus an
    // open comment on a very short window. Cap the card and let it scroll
    // within itself, so it still cannot reach past the list into the timeline.
    card.style.maxHeight = Math.max(0, available) + 'px';
    card.style.overflowY = excess > 0.5 ? 'auto' : '';
    if (excess > 0.5) revealTranslationBox(card);
}

// Scrolls a capped card so its translation box is wholly visible. Without
// this, the box the translator is about to type into can sit below the card's
// own fold on a very short window.
function revealTranslationBox(card) {
    const box = card.querySelector('.tm-translated-input');
    if (!box) return;
    const cardRect = card.getBoundingClientRect();
    const boxRect = box.getBoundingClientRect();
    if (boxRect.bottom > cardRect.bottom) {
        card.scrollTop += boxRect.bottom - cardRect.bottom + 8;
    } else if (boxRect.top < cardRect.top) {
        card.scrollTop -= cardRect.top - boxRect.top + 8;
    }
}

// ── Delegated list behaviour ──────────────────────
// One listener per event type for the whole list, so rendering a row costs
// nothing beyond its markup.

function cueIdFromEvent(e) {
    const item = e.target.closest('.tm-cue-item');
    return item ? Number(item.dataset.id) : null;
}

eventsList.addEventListener('click', e => {
    const id = cueIdFromEvent(e);
    if (id == null) return;
    const ev = events.find(x => x.id === id);
    if (!ev) return;

    const markBtn = e.target.closest('.tm-mark-btn');
    if (markBtn) {
        if (!video) return;
        if (markBtn.dataset.mark === 'in')  ev.startTime = secsToSrtTc(video.currentTime);
        if (markBtn.dataset.mark === 'out') ev.endTime   = secsToSrtTc(video.currentTime);
        markDirty();
        const card = markBtn.closest('.tm-cue-item');
        const field = card?.querySelector(`[data-field="${markBtn.dataset.mark === 'in' ? 'startTime' : 'endTime'}"]`);
        if (field) field.value = markBtn.dataset.mark === 'in' ? ev.startTime : ev.endTime;
        const durBadge = card?.querySelector('.tm-duration-badge');
        if (durBadge) durBadge.innerHTML = `<i class="bi bi-clock"></i> ${Math.max(0, tcToSecs(ev.endTime) - tcToSecs(ev.startTime)).toFixed(2)}s`;
        const cpsBadge = card?.querySelector('.tm-cps-badge');
        if (cpsBadge) cpsBadge.textContent = readingSpeed(ev.translatedText, ev.startTime, ev.endTime) + ' c/s';
        renderTimelineBlocks(); updateWorkspace();
        return;
    }
    if (e.target.closest('.tm-delete-btn')) {
        if (lockedIds.has(id)) return;
        events = events.filter(x => x.id !== id);
        if (activeId === id) activeId = null;
        selectedIds.delete(id);
        markDirty(); renderEvents(); renderTimelineBlocks();
        return;
    }
    if (e.target.closest('.tm-lock-btn')) { toggleLockId(id); return; }
    if (e.target.closest('.tm-comment-btn')) {
        const box = e.target.closest('.tm-cue-item').querySelector('.tm-event-comment');
        if (box) {
            box.hidden = !box.hidden;
            if (!box.hidden) box.querySelector('.tm-comment-input')?.focus();
        }
        return;
    }
    // Clicks inside the open card's own fields must not re-seek the video.
    if (e.target.closest('input, textarea, select, button, a')) return;

    selectEvent(id, { focusTranslation: e.target.closest('.tm-cue-row') !== null });
    if (video && Number.isFinite(tcToSecs(ev.startTime))) video.currentTime = tcToSecs(ev.startTime);
});

// Rows are focusable, so the list is usable without a mouse.
eventsList.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('.tm-cue-row');
    if (!row) return;
    e.preventDefault();
    const id = Number(row.dataset.id);
    selectEvent(id, { focusTranslation: true });
    const ev = events.find(x => x.id === id);
    if (video && ev && Number.isFinite(tcToSecs(ev.startTime))) video.currentTime = tcToSecs(ev.startTime);
});

eventsList.addEventListener('focusin', e => {
    const id = cueIdFromEvent(e);
    if (id == null || id === activeId) return;
    if (!e.target.matches('textarea, input')) return;
    activeId = id;
    selectedIds = new Set([id]);
    updateSelection();
    scrollBlockIntoView(id);
});

eventsList.addEventListener('input', e => {
    const field = e.target.dataset?.field;
    if (!field) return;
    const id = Number(e.target.dataset.id);
    const ev = events.find(x => x.id === id);
    if (!ev) return;
    ev[field] = e.target.value;
    markDirty();

    const card = e.target.closest('.tm-cue-item');
    if (field === 'translatedText') {
        const badge = card?.querySelector('.tm-cps-badge');
        if (badge) badge.textContent = readingSpeed(ev.translatedText, ev.startTime, ev.endTime) + ' c/s';
        const counter = card?.querySelector('.tm-char-counter');
        if (counter) counter.textContent = charCountDisplay(e.target.value);
        e.target.className = `tm-translated-input ${charCountClass(e.target.value)}`;
        fitOpenCard();
        if (id === activeId) {
            overlay.textContent   = e.target.value;
            overlay.style.display = e.target.value.trim() ? 'block' : 'none';
        }
    }
    if (field === 'suggestedText') {
        const counter = card?.querySelector('.tm-col-label-suggestion .tm-char-counter');
        if (counter) counter.textContent = charCountDisplay(e.target.value);
        e.target.className = `tm-suggested-input ${charCountClass(e.target.value)}`;
        fitOpenCard();
    }
    if (field === 'reviewFlag' || field === 'reviewSeverity') {
        ev[field] = Number(e.target.value) || 0;
    }
    if (field === 'status') {
        ev.status = Number(e.target.value) || 0;
        e.target.className = `tm-cue-status-select tm-cue-status-select-${ev.status}`;
    }
    if (field === 'comment') {
        card?.querySelector('.tm-comment-btn')?.classList.toggle('tm-comment-btn-has', !!e.target.value.trim());
    }
    if (field === 'startTime' || field === 'endTime') renderTimelineBlocks();
});

// ══════════════════════════════════════════════════
//  ADD EVENT
// ══════════════════════════════════════════════════

let nextTempId = -1;
btnAddEvent.addEventListener('click', () => {
    if (!loaded) return;
    document.getElementById('cueSearch').value = '';
    document.getElementById('cueFilter').value = 'all';
    const start = video ? secsToSrtTc(video.currentTime)     : '00:00:00,000';
    const end   = video ? secsToSrtTc(video.currentTime + 3) : '00:00:03,000';
    const ev    = {
        id: nextTempId--,
        index: events.length + 1,
        startTime: start,
        endTime: end,
        originalText: '',
        translatedText: '',
        originalLocked: false // typed by hand, not imported — stays editable
    };
    events.push(ev);
    activeId = ev.id;
    markDirty();
    renderEvents();
    renderTimelineBlocks();
    eventsList.lastElementChild?.scrollIntoView({ behavior: 'smooth' });
    eventsList.lastElementChild?.querySelector('.tm-translated-input')?.focus();
});

// ══════════════════════════════════════════════════
//  SAVE (manual + auto)
// ══════════════════════════════════════════════════

function markDirty() {
    revision++;
    isDirty = true;
    invalidateIssues();
    saveDraft();
    recordHistory();
    updateWorkspace();
    saveStatus.textContent = '● Unsaved';
    saveStatus.className   = 'tm-save-status tm-save-unsaved';
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => doSave(), 2000);
}

async function doSave() {
    if (!loaded || saving || revisionStale) return;
    if (events.some(ev => SubtitleCore.issues(ev, []).includes('Invalid timing'))) {
        saveStatus.textContent = 'Fix invalid timing before saving';
        saveStatus.className = 'tm-save-status tm-save-error';
        return;
    }
    saving = true;
    const savedRevision = revision;
    saveStatus.textContent = 'Saving…';
    try {
        const res = await fetch('/studio/' + PROJECT_ID + '/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'RequestVerificationToken': document.querySelector('[name="__RequestVerificationToken"]').value },
            body: JSON.stringify({
                revision: loadedRevision,
                events: events.map(ev => ({ ...ev,
                    startTime: secsToSrtTc(tcToSecs(ev.startTime)),
                    endTime: secsToSrtTc(tcToSecs(ev.endTime))
                }))
            })
        });
        // 409 means someone else saved after this editor loaded. Stop
        // auto-saving rather than fight over the project, and give the
        // translator a way out that cannot lose their work.
        if (res.status === 409) {
            revisionStale = true;
            clearTimeout(autoSaveTimer);
            saveStatus.textContent = 'Not saved — newer version on the server';
            saveStatus.className = 'tm-save-status tm-save-error';
            showBanner(
                'This project was saved somewhere else after you opened it, so your changes were not saved. '
                + 'Export your work first if you want to keep it, then reload.',
                'danger',
                [
                    { label: 'Export SRT', run: () => btnExportSrt.click() },
                    { label: 'Reload', run: () => { clearDraft(); location.reload(); } },
                ]);
            return;
        }
        if (!res.ok) throw new Error('Save failed');
        const data = await res.json();
        if (!data.success) throw new Error('Save failed');
        if (typeof data.revision === 'number') { loadedRevision = data.revision; announceSave(data.revision); }
        isDirty = revision !== savedRevision;
        // The server copy is now authoritative for everything saved, so the
        // local draft is only worth keeping if edits arrived mid-flight.
        if (isDirty) writeDraft(); else clearDraft();
        saveStatus.textContent = isDirty ? 'Unsaved changes' : 'All changes saved';
        saveStatus.className = 'tm-save-status ' + (isDirty ? 'tm-save-unsaved' : 'tm-save-ok');
    } catch {
        isDirty = true;
        saveStatus.textContent = 'Save failed — retry Save';
        saveStatus.className = 'tm-save-status tm-save-error';
    } finally {
        saving = false;
        if (revision !== savedRevision) { clearTimeout(autoSaveTimer); autoSaveTimer = setTimeout(doSave, 1000); }
    }
}

btnSave.addEventListener('click', () => {
    clearTimeout(autoSaveTimer);
    doSave();
});

// ══════════════════════════════════════════════════
//  IMPORT SCRIPT (SRT / VTT)
// ══════════════════════════════════════════════════

importScript.addEventListener('change', async () => {
    const file = importScript.files[0];
    if (!file || !loaded) return;
    const isDocx = /\.docx$/i.test(file.name);
    try {
        let parsed, notice = '';
        if (isDocx) {
            if (file.size > 20 * 1024 * 1024) throw new Error('Choose a Word document smaller than 20 MB.');
            if (typeof mammoth === 'undefined') throw new Error('Word import could not load. Check your connection and reload the page, or use an SRT/VTT file instead.');
            const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
            const timed = SubtitleCore.parseTimedScript(result.value, fps);
            if (timed.length) {
                parsed = timed;
                notice = `Imported ${parsed.length} timed cue${parsed.length === 1 ? '' : 's'} from the document, reading its in/out timecodes at ${fps} fps. If the timing looks off, set the fps selector to the source's real frame rate and re-import.`;
            } else {
                parsed = SubtitleCore.cuesFromLines(result.value.split(/\r?\n/));
                if (!parsed.length) throw new Error('No text found in that document.');
                notice = `Imported ${parsed.length} line${parsed.length === 1 ? '' : 's'} from the document with estimated timing — check each cue against the video and adjust with mark in/out, split, or shift.`;
            }
        } else {
            if (file.size > 5 * 1024 * 1024) throw new Error('Choose a subtitle file smaller than 5 MB.');
            parsed = SubtitleCore.parse(await file.text());
            if (!parsed.length) throw new Error('No subtitle cues found. Choose an SRT or VTT file.');
        }
        if (events.length && !confirm('Replace all current cues with this script? You can undo this import.')) return;
        // Imported source text is locked from here on — only the translation stays editable.
        events = parsed.map((ev, i) => ({ ...ev, id: nextTempId--, index: i + 1, originalLocked: true }));
        activeId = null;
        selectedIds = new Set();
        markDirty(); renderEvents(); renderTimelineBlocks();
        if (notice) alert(notice);
    } catch (error) { alert(error.message); }
    finally { importScript.value = ''; }
});

//  EXPORT
// ══════════════════════════════════════════════════

btnExportSrt.addEventListener('click', () => {
    if (!validateExport()) return;
    let srt = '';
    events.forEach((ev, i) => {
        const start = secsToSrtTc(tcToSecs(ev.startTime));
        const end   = secsToSrtTc(tcToSecs(ev.endTime));
        srt += `${i + 1}\n${start} --> ${end}\n${ev.translatedText?.trim() ? ev.translatedText : ev.originalText || ''}\n\n`;
    });
    download('subtitles.srt', srt);
});

btnExportVtt.addEventListener('click', () => {
    if (!validateExport()) return;
    let vtt = 'WEBVTT\n\n';
    events.forEach((ev, i) => {
        const start = secsToSrtTc(tcToSecs(ev.startTime)).replace(',', '.');
        const end   = secsToSrtTc(tcToSecs(ev.endTime)).replace(',', '.');
        vtt += `${i + 1}\n${start} --> ${end}\n${ev.translatedText?.trim() ? ev.translatedText : ev.originalText || ''}\n\n`;
    });
    download('subtitles.vtt', vtt);
});

function download(filename, text) {
    const a   = document.createElement('a');
    a.href     = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ══════════════════════════════════════════════════

// ── Delivery spec controls ────────────────────────
// The picker offers the built-in presets plus whatever the translator has
// tuned. Editing any number switches the selection to "Custom", because the
// values no longer match the preset they started from.
const specFields = {
    maxCharsPerLine:    document.getElementById('specChars'),
    maxLines:           document.getElementById('specLines'),
    maxCps:             document.getElementById('specCps'),
    minDurationSeconds: document.getElementById('specMinDur'),
    maxDurationSeconds: document.getElementById('specMaxDur'),
    minGapSeconds:      document.getElementById('specGap'),
};
const specProfileSelect = document.getElementById('specProfile');

function matchingPresetId(profile) {
    const preset = SubtitleCore.PROFILES.find(p => Object.keys(specFields)
        .every(key => Number(SubtitleCore.normaliseProfile(p)[key]) === Number(profile[key])));
    return preset ? preset.id : 'custom';
}

function paintProfileControls() {
    if (!specProfileSelect) return;
    const selected = matchingPresetId(deliveryProfile);
    specProfileSelect.innerHTML = SubtitleCore.PROFILES
        .map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
        .join('') + '<option value="custom">Custom</option>';
    specProfileSelect.value = selected;
    for (const [key, input] of Object.entries(specFields)) {
        if (input) input.value = deliveryProfile[key];
    }
}

function applyProfileChange() {
    deliveryProfile = SubtitleCore.normaliseProfile(deliveryProfile);
    storeProfile();
    invalidateIssues();
    // Thresholds feed the row dots, the counters and the timeline colours, so
    // everything on screen has to be redrawn against the new numbers.
    renderEvents();
    renderTimelineBlocks();
    paintProfileControls();
}

specProfileSelect?.addEventListener('change', () => {
    const preset = SubtitleCore.PROFILES.find(p => p.id === specProfileSelect.value);
    if (!preset) return; // "Custom" keeps whatever is in the fields
    deliveryProfile = SubtitleCore.normaliseProfile(preset);
    applyProfileChange();
});

for (const [key, input] of Object.entries(specFields)) {
    input?.addEventListener('change', () => {
        deliveryProfile = SubtitleCore.normaliseProfile({ ...deliveryProfile, [key]: input.value });
        applyProfileChange();
    });
}

document.getElementById('specReset')?.addEventListener('click', () => {
    const preset = SubtitleCore.PROFILES.find(p => p.id === specProfileSelect?.value)
        || SubtitleCore.DEFAULT_PROFILE;
    deliveryProfile = SubtitleCore.normaliseProfile(preset);
    applyProfileChange();
});

paintProfileControls();

// ══════════════════════════════════════════════════
//  REVISION — suggestions, flags and the review round
// ══════════════════════════════════════════════════
// A revisor works in the same editor as the translator, because judging a
// line needs the same video, timeline and reading-speed figures. What differs
// is which column they type into.
//
// The translator's wording is never overwritten. A revisor proposes a
// replacement; the translator accepts it, in which case their own line is kept
// so Revert can put it back, or dismisses it, which is recorded as an answer
// rather than a deletion.

const IS_REVISOR = typeof CAN_REVIEW !== 'undefined' && CAN_REVIEW;

// Which error a flagged line has. These are the categories used in
// language-quality review, so a report says what kind of trouble a
// translation is in rather than just how much.
const REVIEW_FLAGS = [
    { value: 0, label: 'No flag' },
    { value: 1, label: 'Mistranslation' },
    { value: 2, label: 'Omission' },
    { value: 3, label: 'Addition' },
    { value: 4, label: 'Terminology' },
    { value: 5, label: 'Style / register' },
    { value: 6, label: 'Grammar / spelling' },
    { value: 7, label: 'Timing' },
    { value: 8, label: 'Reading speed' },
    { value: 9, label: 'Line breaks' },
];

const REVIEW_SEVERITY = [
    { value: 0, label: 'Severity' },
    { value: 1, label: 'Minor' },
    { value: 2, label: 'Major' },
    { value: 3, label: 'Critical' },
];

// SuggestionState on the server: 0 none, 1 pending, 2 accepted, 3 dismissed.
const SUGGESTION = { NONE: 0, PENDING: 1, ACCEPTED: 2, DISMISSED: 3 };

const hasSuggestion = ev => !!(ev.suggestedText && ev.suggestedText.trim());
const isFlagged     = ev => (ev.reviewFlag || 0) !== 0;

// The translator hides the column until they want it; a revisor is always
// working in it, so for them it is simply on.
const SUGGESTIONS_KEY = `tm-suggestions-${PROJECT_ID}`;
let showSuggestions = IS_REVISOR || (() => {
    try { return localStorage.getItem(SUGGESTIONS_KEY) === '1'; }
    catch { return false; }
})();

function suggestionSummary() {
    let pending = 0, flagged = 0, total = 0;
    for (const ev of events) {
        if (hasSuggestion(ev)) {
            total++;
            if ((ev.suggestionState || 0) === SUGGESTION.PENDING) pending++;
        }
        if (isFlagged(ev)) flagged++;
    }
    return { pending, flagged, total };
}

function paintSuggestionsToggle() {
    const button = document.getElementById('btnToggleSuggestions');
    if (!button) return;
    const { pending, total } = suggestionSummary();

    button.setAttribute('aria-pressed', String(showSuggestions));
    button.classList.toggle('tm-suggestions-on', showSuggestions);
    button.title = showSuggestions
        ? "Hide the revisor's suggestions"
        : total
            ? `Show the revisor's suggestions (${pending} still to decide)`
            : "Show the revisor's suggestions — none yet";

    const badge = document.getElementById('suggestionCount');
    if (badge) {
        badge.hidden = pending === 0;
        badge.textContent = pending;
    }
}

function setSuggestionsVisible(visible) {
    showSuggestions = visible;
    try { localStorage.setItem(SUGGESTIONS_KEY, visible ? '1' : '0'); }
    catch { /* storage unavailable; the choice just will not persist */ }
    document.querySelector('.tm-editor-right')?.classList.toggle('tm-show-suggestions', visible);
    paintSuggestionsToggle();
    // The column changes the card's width and height, so it has to be redrawn
    // and re-fitted rather than merely revealed.
    renderEvents();
}

// ── The suggestion column inside the open card ────

function flagBadgeHtml(ev) {
    if (!isFlagged(ev)) return '';
    const flag = REVIEW_FLAGS.find(f => f.value === ev.reviewFlag);
    const severity = REVIEW_SEVERITY.find(s => s.value === (ev.reviewSeverity || 0));
    const label = flag ? flag.label : 'Flagged';
    const sev = severity && severity.value ? severity.label : '';
    return `<span class="tm-review-flag tm-severity-${(sev || 'none').toLowerCase()}">
        <i class="bi bi-flag-fill"></i> ${escapeHtml(label)}${sev ? ` · ${escapeHtml(sev)}` : ''}
    </span>`;
}

function reviewNoteHtml(ev) {
    if (!ev.reviewNote || !ev.reviewNote.trim()) return '';
    return `<p class="tm-review-note" dir="auto"><i class="bi bi-chat-quote"></i> ${escapeHtml(ev.reviewNote)}</p>`;
}

// What the revisor sees: an editable box that starts from the current
// translation, so they correct a real line instead of writing into a blank.
// Only a box that ends up different from the translation is stored.
function revisorColumnHtml(ev, i) {
    const draft = ev.suggestedText != null && ev.suggestedText !== ''
        ? ev.suggestedText
        : (ev.translatedText || '');
    return `<div class="tm-event-col tm-event-col-suggestion tm-event-col-editing">
        <div class="tm-col-label tm-col-label-suggestion">
            <span><i class="bi bi-lightbulb-fill"></i> Your suggestion</span>
            <span class="tm-char-counter">${charCountDisplay(draft)}</span>
        </div>
        <textarea dir="auto" aria-label="Suggested translation for cue ${i + 1}"
                  class="tm-suggested-input ${charCountClass(draft)}"
                  placeholder="Edit the line to propose a change. Leave it as it is to suggest nothing."
                  data-field="suggestedText" data-id="${ev.id}">${escapeHtml(draft)}</textarea>
        <div class="tm-review-controls">
            <select class="tm-review-flag-select" data-field="reviewFlag" data-id="${ev.id}"
                    aria-label="What is wrong with cue ${i + 1}">
                ${REVIEW_FLAGS.map(f => `<option value="${f.value}"${(ev.reviewFlag || 0) === f.value ? ' selected' : ''}>${f.label}</option>`).join('')}
            </select>
            <select class="tm-review-severity-select" data-field="reviewSeverity" data-id="${ev.id}"
                    aria-label="How serious the problem on cue ${i + 1} is">
                ${REVIEW_SEVERITY.map(s => `<option value="${s.value}"${(ev.reviewSeverity || 0) === s.value ? ' selected' : ''}>${s.label}</option>`).join('')}
            </select>
        </div>
        <textarea dir="auto" aria-label="Note to the translator about cue ${i + 1}"
                  class="tm-review-note-input" placeholder="Why — a note the translator will read…"
                  data-field="reviewNote" data-id="${ev.id}">${escapeHtml(ev.reviewNote || '')}</textarea>
    </div>`;
}

// What the translator sees: empty when nothing was suggested, otherwise the
// revisor's line with a way to take it or keep their own.
function translatorSuggestionColumnHtml(ev, i) {
    const state = ev.suggestionState || 0;
    const suggestion = ev.suggestedText || '';
    const flagged = isFlagged(ev);

    if (!hasSuggestion(ev) && !flagged) {
        return `<div class="tm-event-col tm-event-col-suggestion tm-event-col-empty">
            <div class="tm-col-label tm-col-label-suggestion"><span><i class="bi bi-lightbulb"></i> Revisor</span></div>
            <p class="tm-suggestion-none">No suggestion for this line.</p>
        </div>`;
    }

    let actions = '';
    let stateChip = '';
    if (hasSuggestion(ev)) {
        if (state === SUGGESTION.ACCEPTED) {
            stateChip = '<span class="tm-suggestion-state tm-suggestion-accepted"><i class="bi bi-check-lg"></i> Applied</span>';
            actions = `<button class="tm-btn-sm tm-suggestion-revert" data-id="${ev.id}"
                        title="Put your own line back">Revert to mine</button>`;
        } else if (state === SUGGESTION.DISMISSED) {
            stateChip = '<span class="tm-suggestion-state tm-suggestion-dismissed"><i class="bi bi-x-lg"></i> Kept mine</span>';
            actions = `<button class="tm-btn-sm tm-suggestion-accept" data-id="${ev.id}">Use it after all</button>`;
        } else {
            actions = `<button class="tm-btn-sm tm-btn-sm-primary tm-suggestion-accept" data-id="${ev.id}">
                    <i class="bi bi-check-lg"></i> Accept
                </button>
                <button class="tm-btn-sm tm-suggestion-dismiss" data-id="${ev.id}">
                    <i class="bi bi-x-lg"></i> Keep mine
                </button>`;
        }
    }

    return `<div class="tm-event-col tm-event-col-suggestion${state === SUGGESTION.PENDING ? ' tm-event-col-pending' : ''}">
        <div class="tm-col-label tm-col-label-suggestion">
            <span><i class="bi bi-lightbulb-fill"></i> Revisor</span>
            ${stateChip}
        </div>
        ${hasSuggestion(ev)
            ? `<p class="tm-suggestion-text" dir="auto">${escapeHtml(suggestion)}</p>`
            : '<p class="tm-suggestion-none">Flagged, with no replacement proposed.</p>'}
        ${flagBadgeHtml(ev)}
        ${reviewNoteHtml(ev)}
        ${actions ? `<div class="tm-suggestion-actions">${actions}</div>` : ''}
    </div>`;
}

function suggestionColumnHtml(ev, i) {
    if (!showSuggestions) return '';
    return IS_REVISOR ? revisorColumnHtml(ev, i) : translatorSuggestionColumnHtml(ev, i);
}

// ── Acting on a suggestion ────────────────────────

function applySuggestion(id) {
    const ev = events.find(x => x.id === id);
    if (!ev || !hasSuggestion(ev)) return;
    // Keep what the translator wrote, so Revert is always possible — but only
    // the first time, or accepting twice would overwrite the original with the
    // revisor's own line.
    if ((ev.suggestionState || 0) !== SUGGESTION.ACCEPTED) {
        ev.previousTranslatedText = ev.translatedText || '';
    }
    ev.translatedText = ev.suggestedText;
    ev.suggestionState = SUGGESTION.ACCEPTED;
    afterSuggestionDecision(id);
}

function revertSuggestion(id) {
    const ev = events.find(x => x.id === id);
    if (!ev) return;
    if (ev.previousTranslatedText != null) ev.translatedText = ev.previousTranslatedText;
    ev.previousTranslatedText = null;
    // Back to undecided rather than dismissed: reverting says "not yet",
    // dismissing says "no".
    ev.suggestionState = hasSuggestion(ev) ? SUGGESTION.PENDING : SUGGESTION.NONE;
    afterSuggestionDecision(id);
}

function dismissSuggestion(id) {
    const ev = events.find(x => x.id === id);
    if (!ev) return;
    ev.suggestionState = SUGGESTION.DISMISSED;
    afterSuggestionDecision(id);
}

function afterSuggestionDecision(id) {
    markDirty();
    refreshCue(id, { keepCaret: false });
    updateSelection();
    fitOpenCard();
    renderTimelineBlocks();
    updateWorkspace();
    updateOverlay();
}

// Accepting every outstanding suggestion at once, for a translator who has
// read the report and agrees with it.
function acceptAllSuggestions() {
    const pending = events.filter(ev => hasSuggestion(ev) && (ev.suggestionState || 0) === SUGGESTION.PENDING);
    if (!pending.length) { alert('There are no suggestions waiting for a decision.'); return; }
    if (!confirm(`Apply all ${pending.length} outstanding suggestion${pending.length === 1 ? '' : 's'}? `
               + 'Your own wording is kept for each line, so you can still revert any of them.')) return;
    for (const ev of pending) {
        ev.previousTranslatedText = ev.translatedText || '';
        ev.translatedText = ev.suggestedText;
        ev.suggestionState = SUGGESTION.ACCEPTED;
    }
    markDirty();
    renderEvents();
    renderTimelineBlocks();
    updateOverlay();
}

// ── Wiring ────────────────────────────────────────

document.getElementById('btnToggleSuggestions')?.addEventListener('click', () => {
    setSuggestionsVisible(!showSuggestions);
});

eventsList.addEventListener('click', e => {
    const accept = e.target.closest('.tm-suggestion-accept');
    if (accept) { e.stopPropagation(); applySuggestion(Number(accept.dataset.id)); return; }
    const dismiss = e.target.closest('.tm-suggestion-dismiss');
    if (dismiss) { e.stopPropagation(); dismissSuggestion(Number(dismiss.dataset.id)); return; }
    const revert = e.target.closest('.tm-suggestion-revert');
    if (revert) { e.stopPropagation(); revertSuggestion(Number(revert.dataset.id)); return; }
}, true);

// ── The review round dialog ───────────────────────

const reviewModal = document.getElementById('reviewModal');

document.getElementById('btnFinishReview')?.addEventListener('click', async () => {
    // The round is filed against what is stored, so anything unsaved has to
    // land first or the report would describe the wrong thing.
    if (isDirty) await doSave();
    const { pending, flagged, total } = suggestionSummary();
    const stats = document.getElementById('reviewStats');
    if (stats) {
        stats.textContent = `${events.length} lines · ${total} suggestion${total === 1 ? '' : 's'} · ${flagged} flagged`;
    }
    reviewModal.style.display = 'flex';
    document.getElementById('reviewNotes')?.focus();
});

document.getElementById('cancelReview')?.addEventListener('click', () => {
    reviewModal.style.display = 'none';
});

reviewModal?.addEventListener('click', e => {
    if (e.target === reviewModal) reviewModal.style.display = 'none';
});

document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && reviewModal && reviewModal.style.display === 'flex') {
        reviewModal.style.display = 'none';
    }
});

// The revisor is always in the column; the translator's last choice is
// restored on load.
document.querySelector('.tm-editor-right')?.classList.toggle('tm-show-suggestions', showSuggestions);
if (IS_REVISOR) document.querySelector('.tm-editor-right')?.classList.add('tm-revisor-mode');

// ══════════════════════════════════════════════════
//  SAFETY — crash recovery, other tabs, stale saves
// ══════════════════════════════════════════════════
// Undo only lives as long as the page, and the server only hears about work
// when a save lands. Between those two facts sits the case that actually
// costs a translator their afternoon: the tab dies, or a second tab quietly
// overwrites the first. Three things cover it.
//
//  1. A local draft. Every change is mirrored into this browser shortly after
//     it is made, and cleared once the server confirms a save. On reload, a
//     draft that is newer than the server's copy is offered back.
//  2. A revision check. The editor remembers the revision it loaded and sends
//     it with every save; the server rejects a save built on an older one
//     rather than discarding whatever arrived in between.
//  3. A tab check. Tabs editing the same project announce themselves to each
//     other, so the second one is warned before it does any damage.

const DRAFT_KEY = `tm-draft-${PROJECT_ID}`;
const DRAFT_SETTLE_MS = 1200;

let loadedRevision = null;   // revision this editor started from
let revisionStale = false;   // another tab has saved since
let draftTimer = null;

function saveDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(writeDraft, DRAFT_SETTLE_MS);
}

function writeDraft() {
    if (!loaded) return;
    try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({
            revision: loadedRevision,
            savedAt: Date.now(),
            events,
        }));
    } catch {
        // Storage full or blocked (private window). The server save is still
        // the real safety net; nothing here is worth interrupting work over.
    }
}

function clearDraft() {
    clearTimeout(draftTimer);
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* nothing to clear */ }
}

function readDraft() {
    try {
        const raw = localStorage.getItem(DRAFT_KEY);
        if (!raw) return null;
        const draft = JSON.parse(raw);
        return Array.isArray(draft?.events) ? draft : null;
    } catch {
        return null;
    }
}

// Offers a recovered draft when it differs from what the server just sent.
// Comparing the serialised cues avoids nagging about a draft that simply
// mirrors a save that did land.
function offerDraftRecovery(serverEvents) {
    const draft = readDraft();
    if (!draft) return false;
    if (JSON.stringify(draft.events) === JSON.stringify(serverEvents)) { clearDraft(); return false; }

    const when = new Date(draft.savedAt || Date.now());
    const age = describeAge(draft.savedAt);
    const restore = confirm(
        `Unsaved work from this browser was found for this project (${age}, ${draft.events.length} cues).\n\n`
        + `OK — restore that work and continue from it.\n`
        + `Cancel — discard it and open the last version saved on the server.\n\n`
        + `Local copy: ${when.toLocaleString()}`);

    if (!restore) { clearDraft(); return false; }
    events = draft.events;
    markDirty();
    showBanner('Restored unsaved work from this browser. Save when you are happy with it.', 'warn');
    return true;
}

function describeAge(at) {
    const mins = Math.round((Date.now() - (at || Date.now())) / 60000);
    if (mins < 1) return 'less than a minute ago';
    if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
}

// ── Banner ────────────────────────────────────────
function showBanner(message, tone = 'warn', actions = []) {
    const bar = document.getElementById('editorBanner');
    if (!bar) return;
    bar.className = `tm-banner tm-banner-${tone}`;
    bar.innerHTML = '';

    const text = document.createElement('span');
    text.className = 'tm-banner-text';
    text.textContent = message;
    bar.appendChild(text);

    for (const action of actions) {
        const button = document.createElement('button');
        button.className = 'tm-btn-sm';
        button.textContent = action.label;
        button.addEventListener('click', action.run);
        bar.appendChild(button);
    }

    const close = document.createElement('button');
    close.className = 'tm-icon-btn-sm tm-banner-close';
    close.title = 'Dismiss';
    close.innerHTML = '<i class="bi bi-x-lg"></i>';
    close.addEventListener('click', hideBanner);
    bar.appendChild(close);

    bar.hidden = false;
}

function hideBanner() {
    const bar = document.getElementById('editorBanner');
    if (bar) bar.hidden = true;
}

// ── Other tabs ────────────────────────────────────
// BroadcastChannel is same-origin and needs no server round trip. Tabs say
// hello on open; anyone already there answers, so both ends know.
const TAB_ID = Math.random().toString(36).slice(2);
let channel = null;

try {
    channel = new BroadcastChannel(`tm-project-${PROJECT_ID}`);
} catch {
    channel = null; // older browser: the revision check still covers the damage
}

if (channel) {
    channel.addEventListener('message', e => {
        const msg = e.data || {};
        if (msg.tabId === TAB_ID) return;
        if (msg.type === 'hello') {
            channel.postMessage({ type: 'here', tabId: TAB_ID });
            warnAboutOtherTab();
        }
        if (msg.type === 'here') warnAboutOtherTab();
        if (msg.type === 'saved' && msg.revision !== loadedRevision) {
            revisionStale = true;
            showBanner(
                'Another tab saved this project. Your next save would be refused until you reload.',
                'danger',
                [{ label: 'Reload', run: () => location.reload() }]);
        }
    });
    window.addEventListener('pagehide', () => { try { channel.close(); } catch { /* already closed */ } });
}

let warnedAboutTabs = false;
function warnAboutOtherTab() {
    if (warnedAboutTabs) return;
    warnedAboutTabs = true;
    showBanner('This project is open in another tab. Whichever tab saves second will be asked to reload.', 'warn');
}

function announceTab()      { channel?.postMessage({ type: 'hello', tabId: TAB_ID }); }
function announceSave(rev)  { channel?.postMessage({ type: 'saved', tabId: TAB_ID, revision: rev }); }

// ══════════════════════════════════════════════════
//  INIT — load saved events
// ══════════════════════════════════════════════════

(async () => {
    try {
        const res = await fetch(`/studio/${PROJECT_ID}/events`);
        if (!res.ok) throw new Error('Load failed');
        const payload = await res.json();
        // The endpoint used to return a bare array and now returns
        // { revision, events }; accept either so a cached response from an
        // older build cannot strand the editor.
        const serverEvents = Array.isArray(payload) ? payload : payload?.events;
        if (!Array.isArray(serverEvents)) throw new Error('Invalid response');
        loadedRevision = Array.isArray(payload) ? null : payload.revision ?? null;
        events = serverEvents;
        loaded = true;
        history = [JSON.stringify(events)]; historyIndex = 0;
        saveStatus.textContent = 'All changes saved';
        offerDraftRecovery(serverEvents);
        announceTab();
    } catch {
        eventsList.textContent = 'Could not load subtitles. Reload the page to try again.';
        saveStatus.textContent = 'Load failed';
        return;
    }
    renderEvents();
    // Cues alone are enough to draw a timeline, so this no longer waits for
    // a video that may never arrive.
    setZoom(DEFAULT_PX_PER_SEC, 0);
    drawTimelineRuler();
    renderTimelineBlocks();
    video?.addEventListener('loadedmetadata', () => {
        drawTimelineRuler();
        renderTimelineBlocks();
    });
})
();

// ══════════════════════════════════════════════════
//  RESIZABLE PANELS
// ══════════════════════════════════════════════════

const resizeHandle = document.getElementById('resizeHandle');
const editorLeft   = document.querySelector('.tm-editor-left');
const editorRight  = document.querySelector('.tm-editor-right');
const editorBody   = document.querySelector('.tm-editor-body');

document.getElementById('cueSearch').addEventListener('input', renderEvents);
document.getElementById('cueFilter').addEventListener('change', renderEvents);
const projectStatus = document.getElementById('projectStatus');
let previousStatus = projectStatus.value;
projectStatus.addEventListener('change', async () => {
    projectStatus.disabled = true;
    try {
        const res = await fetch(`/studio/${PROJECT_ID}/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'RequestVerificationToken': document.querySelector('[name="__RequestVerificationToken"]').value },
            body: new URLSearchParams({ status: projectStatus.value })
        });
        if (!res.ok) throw new Error('Could not update project status. Please retry.');
        previousStatus = projectStatus.value;
    } catch (error) { projectStatus.value = previousStatus; alert(error.message); }
    finally { projectStatus.disabled = false; }
});
document.getElementById('undoEdit').addEventListener('click', () => restoreHistory(-1));
document.getElementById('redoEdit').addEventListener('click', () => restoreHistory(1));
document.getElementById('nextUntranslated').addEventListener('click', () => {
    const idx = events.findIndex(ev => ev.id === activeId);
    const ordered = [...events.slice(idx + 1), ...events.slice(0, idx + 1)];
    const next = ordered.find(ev => !ev.translatedText?.trim());
    if (!next) { alert('All cues have translations.'); return; }
    document.getElementById('cueSearch').value = '';
    document.getElementById('cueFilter').value = 'all';
    renderEvents();
    selectEvent(next.id, { scrollBlock: 'center', focusTranslation: true });
    if (video) video.currentTime = tcToSecs(next.startTime);
});
document.getElementById('copySource').addEventListener('click', () => {
    const ev = events.find(cue => cue.id === activeId);
    if (!ev) { alert('Select a cue first.'); return; }
    if (ev.translatedText && !confirm('Replace this translation with its source text?')) return;
    ev.translatedText = ev.originalText || '';
    markDirty(); renderEvents(); updateOverlay();
});
document.getElementById('btnSplitCue').addEventListener('click', () => {
    if (!loaded) return;
    const idx = events.findIndex(ev => ev.id === activeId);
    if (idx === -1) { alert('Select a cue first.'); return; }
    if (!video) { alert('A loaded video is needed to choose the split point.'); return; }
    try {
        const [a, b] = SubtitleCore.splitCue(events[idx], video.currentTime);
        events.splice(idx, 1, { ...a, id: events[idx].id }, { ...b, id: nextTempId-- });
        activeId = events[idx].id;
        markDirty(); renderEvents(); renderTimelineBlocks();
    } catch (error) { alert(error.message); }
});
document.getElementById('btnMergeCue').addEventListener('click', () => {
    if (!loaded) return;
    const idx = events.findIndex(ev => ev.id === activeId);
    if (idx === -1) { alert('Select a cue first.'); return; }
    if (idx >= events.length - 1) { alert('Select a cue that has a following cue to merge with.'); return; }
    const merged = SubtitleCore.mergeCues(events[idx], events[idx + 1]);
    events.splice(idx, 2, { ...merged, id: events[idx].id, originalLocked: events[idx].originalLocked || events[idx + 1].originalLocked });
    activeId = events[idx].id;
    markDirty(); renderEvents(); renderTimelineBlocks();
});
function shiftCues(targets, directionOverride) {
    if (!loaded) return;
    const magnitude = SubtitleCore.parseShiftAmount(document.getElementById('shiftTimecode').value, fps);
    if (!Number.isFinite(magnitude)) { alert('Enter a shift amount like 00:00:01:12 (h:m:s:frames), 1:30 (m:s), or a plain number of seconds.'); return; }
    const direction = directionOverride ?? (document.getElementById('shiftDirection').value === '-1' ? -1 : 1);
    const requested = Math.abs(magnitude) * direction;
    if (requested === 0) { alert('Enter a non-zero shift amount.'); return; }
    if (!targets.length) { alert('No cues to shift.'); return; }
    const offset = SubtitleCore.clampShiftOffset(targets, requested);
    if (offset === 0) { alert('That range is already at 00:00:00,000 — nothing to shift earlier.'); return; }
    try {
        const shifted = targets.map(ev => SubtitleCore.shift(ev, offset));
        targets.forEach((ev, i) => { ev.startTime = shifted[i].startTime; ev.endTime = shifted[i].endTime; });
        markDirty(); renderEvents(); renderTimelineBlocks();
        if (Math.abs(offset - requested) > 0.0005) alert(`Shift limited to ${SubtitleCore.timestamp(Math.abs(offset))} (${offset < 0 ? 'earlier' : 'later'}) so timing stays within 00:00:00–24:00:00.`);
    } catch (error) { alert(error.message); }
}
document.getElementById('shiftAll').addEventListener('click', () => shiftCues(events));
document.getElementById('shiftZero').addEventListener('click', () => {
    if (!loaded) return;
    if (!events.length) { alert('No cues to shift.'); return; }
    const minStart = Math.min(...events.map(ev => SubtitleCore.seconds(ev.startTime)));
    if (!Number.isFinite(minStart) || minStart <= 0) { alert('The earliest cue already starts at 00:00:00.'); return; }
    const shifted = events.map(ev => SubtitleCore.shift(ev, -minStart));
    events.forEach((ev, i) => { ev.startTime = shifted[i].startTime; ev.endTime = shifted[i].endTime; });
    markDirty(); renderEvents(); renderTimelineBlocks();
});
document.getElementById('shiftFromHere').addEventListener('click', () => {
    if (!loaded) return;
    const idx = events.findIndex(ev => ev.id === activeId);
    if (idx === -1) { alert('Select a cue to shift from.'); return; }
    shiftCues(events.slice(idx));
});
document.getElementById('shiftRange').addEventListener('click', () => {
    if (!loaded) return;
    const from = parseInt(document.getElementById('shiftFromNum').value, 10);
    const to = parseInt(document.getElementById('shiftToNum').value, 10);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > events.length) {
        alert(`Enter a valid cue number range between 1 and ${events.length}.`);
        return;
    }
    shiftCues(events.slice(from - 1, to));
});
document.getElementById('replaceAll').addEventListener('click', () => {
    const find = document.getElementById('findText').value;
    const replace = document.getElementById('replaceText').value;
    if (!find || !loaded) return;
    const count = events.filter(ev => ev.translatedText?.includes(find)).length;
    if (!count) { alert('No matching translations.'); return; }
    if (!confirm(`Replace text in ${count} cues? This applies to all translations, including hidden cues.`)) return;
    events.forEach(ev => ev.translatedText = (ev.translatedText || '').split(find).join(replace));
    markDirty(); renderEvents(); updateOverlay();
});
// ══════════════════════════════════════════════════
//  TIMELINE TOOLBAR
// ══════════════════════════════════════════════════
document.getElementById('tlPlayPause')?.addEventListener('click', () => btnPlay.click());
document.getElementById('tlStop')?.addEventListener('click', stopPlayback);
document.getElementById('tlRewind')?.addEventListener('click', () => rewindSeconds(10));
document.getElementById('tlFastForward')?.addEventListener('click', () => fastForwardSeconds(10));
document.getElementById('tlPrevSub')?.addEventListener('click', () => selectAdjacentCue(-1));
document.getElementById('tlNextSub')?.addEventListener('click', () => selectAdjacentCue(1));
document.getElementById('tlPlaySelected')?.addEventListener('click', playSelectedRange);
document.getElementById('tlAutoPauseOut')?.addEventListener('change', e => { autoPauseAtOut = e.target.checked; autoPauseArmed = true; });
document.getElementById('tlSnap')?.addEventListener('change', e => { snapEnabled = e.target.checked; });
document.getElementById('tlNudgeBack')?.addEventListener('click', () => nudgeSelected(-1));
document.getElementById('tlNudgeFwd')?.addEventListener('click', () => nudgeSelected(1));
document.getElementById('tlShrink')?.addEventListener('click', () => resizeDurationSelected(-1));
document.getElementById('tlGrow')?.addEventListener('click', () => resizeDurationSelected(1));
document.getElementById('tlDuplicate')?.addEventListener('click', duplicateSelectedCue);
document.getElementById('tlLock')?.addEventListener('click', toggleLockSelected);
document.getElementById('tlZoomIn')?.addEventListener('click', () => setZoom(pxPerSecond * 1.5));
document.getElementById('tlZoomOut')?.addEventListener('click', () => setZoom(pxPerSecond / 1.5));
document.getElementById('tlZoomFit')?.addEventListener('click', () => setZoom(fitZoom()));
document.getElementById('btnTogglePanel')?.addEventListener('click', toggleEventsPanel);
document.getElementById('btnSwapColumns')?.addEventListener('click', swapColumns);
document.getElementById('btnCardLayout')?.addEventListener('click', toggleCardLayout);
document.getElementById('btnToggleTools')?.addEventListener('click', toggleWorkspaceTools);

window.addEventListener('beforeunload', e => { if (isDirty) { e.preventDefault(); e.returnValue = ''; } });
if (!video) [btnPlay, btnSkipBack, btnSkipFwd, btnFrameBack, btnFrameFwd, speedSelect].forEach(el => { el.disabled = true; });
document.querySelectorAll('button[title], a[title]').forEach(el => el.setAttribute('aria-label', el.title));
new ResizeObserver(() => drawTimelineRuler()).observe(timelineWrap);

let isResizing = false;

resizeHandle.addEventListener('mousedown', e => {
    isResizing = true;
    resizeHandle.classList.add('tm-resizing');
    document.body.style.cursor    = 'col-resize';
    document.body.style.userSelect = 'none';
});

document.addEventListener('mousemove', e => {
    if (!isResizing) return;
    const bodyRect  = editorBody.getBoundingClientRect();
    const offset    = e.clientX - bodyRect.left;
    const totalWidth = bodyRect.width - 6; // minus handle width

    const leftPct  = Math.min(Math.max((offset / totalWidth) * 100, 25), 75);
    const rightPct = 100 - leftPct;

    editorLeft.style.flex  = 'none';
    editorLeft.style.width = leftPct + '%';
    editorRight.style.flex = 'none';
    editorRight.style.width = rightPct + '%';
});

document.addEventListener('mouseup', () => {
    if (!isResizing) return;
    isResizing = false;
    resizeHandle.classList.remove('tm-resizing');
    document.body.style.cursor    = '';
    document.body.style.userSelect = '';
});

// ══════════════════════════════════════════════════
//  TIMELINE RESIZE
// ══════════════════════════════════════════════════

const timelineResizeHandle = document.getElementById('timelineResizeHandle');
const timelineWrapEl       = document.getElementById('timelineWrap');
let isTimelineResizing     = false;

timelineResizeHandle.addEventListener('mousedown', e => {
    isTimelineResizing = true;
    timelineResizeHandle.classList.add('tm-resizing');
    document.body.style.cursor     = 'row-resize';
    document.body.style.userSelect = 'none';
});

document.addEventListener('mousemove', e => {
    if (!isTimelineResizing) return;
    const editorWrapRect = document.querySelector('.tm-editor-wrap').getBoundingClientRect();
    const newHeight = editorWrapRect.bottom - e.clientY;
    const clamped   = Math.min(Math.max(newHeight, 60), 300);
    timelineWrapEl.style.height = clamped + 'px';
    drawTimelineRuler();
});

document.addEventListener('mouseup', () => {
    if (!isTimelineResizing) return;
    isTimelineResizing = false;
    timelineResizeHandle.classList.remove('tm-resizing');
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
});

async function decodeAudio() {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    try {
        const response = await fetch(video.currentSrc || video.src);
        if (!response.ok) throw new Error('Audio unavailable');
        if (Number(response.headers.get('Content-Length')) > 128 * 1024 * 1024) {
            await response.body?.cancel();
            throw new Error('Media too large for browser waveform decoding');
        }
        const buffer = await response.arrayBuffer();
        const decoded = await audioCtx.decodeAudioData(buffer);
        return decoded.getChannelData(0);
    } finally { await audioCtx.close(); }
}
