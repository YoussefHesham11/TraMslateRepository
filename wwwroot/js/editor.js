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
        && (filter !== 'flagged' || isFlagged(ev))
        // Filters built on validation and workflow marks live in workspace.js.
        && (typeof TmWorkspace === 'undefined' || TmWorkspace.matches(filter, ev));
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
    const reviewed = events.filter(ev => (ev.reviewState | 0) === 1 || (ev.status | 0) === 3).length;
    const clean = typeof TmWorkspace !== 'undefined' ? TmWorkspace.cleanCount?.() : null;
    document.getElementById('cueProgress').textContent = `${done} of ${events.length} translated · ${reviewed} reviewed`
        + (clean != null ? ` · ${clean} without errors` : '');
    document.getElementById('translationProgress').value = events.length ? done / events.length * 100 : 0;
    paintSuggestionsToggle();
    const count = document.getElementById('cueCount');
    if (count) count.textContent = events.length ? `${events.length} cues` : '';
    const flagged = events.reduce((n, _, i) => n + (issuesAt(i).some(issue => issue !== 'Untranslated') ? 1 : 0), 0);
    document.getElementById('cueIssues').textContent = `${flagged} with quality issues`;
    updateHistoryButtons();
    const open = eventsList.querySelector('.tm-cue-item-open');
    if (open && typeof TmWorkspace !== 'undefined') {
        TmWorkspace.paintCardHint(open, events.findIndex(cue => cue.id === Number(open.dataset.id)));
    } else if (open) {
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
const timelineHover = document.getElementById('timelineHover');
const timelineReadout = document.getElementById('timelineReadout');
const tlProgress    = document.getElementById('timelineProgress');
const tlProgressText= document.getElementById('timelineProgressText');
const tlProgressFill= document.getElementById('timelineProgressFill');

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

// ── Waveform & audio state ──────────────────────────
// `peaks` is the analysis from TmWaveform: a pyramid of min/max/RMS buckets
// plus the speech regions detected from it. Everything the timeline draws
// below the ruler, and every "snap to the dialogue" action, reads from here.
let peaks          = null;
let peaksStatus    = 'idle';   // idle | working | ready | failed
let peaksMessage   = '';
let waveGain       = 1;        // vertical scale only — never touches playback
let waveView       = 'both';   // both | peak | rms | bars
let waveScale      = 'db';     // db | linear
let showSpeech     = false;  // faint wash behind detected dialogue
let snapToAudio    = true;
let scrubAudio     = false;
let loopRange      = null;     // {start, end} while the loop button is armed
let prerollSecs    = 1.5;
let hoverSecs      = null;
let scrubbing      = false;
let wasPlayingBeforeScrub = false;

// The strip is a timecode ruler over one lane in which the subtitle boxes sit
// directly on the waveform, so each box frames the audio it belongs to.
const RULER_H = 24;

const TL_PREFS_KEY = 'tm-timeline-prefs';
function loadTimelinePrefs() {
    try { return JSON.parse(localStorage.getItem(TL_PREFS_KEY) || '{}'); }
    catch { return {}; }
}
function saveTimelinePrefs() {
    try {
        localStorage.setItem(TL_PREFS_KEY, JSON.stringify({
            waveGain, waveView, showSpeech, snapToAudio, scrubAudio, prerollSecs,
            showBlockText, snapToCuts, waveScale, followPlayback, jumpSeconds,
            volume: video ? video.volume : 1, muted: video ? video.muted : false,
        }));
    } catch { /* storage unavailable */ }
}

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

// Everything project-wide that the editor needs to resume exactly where it
// was — validation profile, rules, glossary, frame rate — travels with the
// project on save. Other modules keep their parts in workspaceSettings.
let workspaceSettings = {};
// What the server said on load, for modules that start after the load landed.
let loadPayload = null;
function projectSettings() {
    return { version: 1, profile: deliveryProfile, fps, ...workspaceSettings };
}
function applyProjectSettings(settings) {
    let s = settings;
    if (typeof s === 'string') { try { s = JSON.parse(s); } catch { return; } }
    if (!s || typeof s !== 'object') return;
    const { version, profile, fps: savedFps, ...rest } = s;
    if (profile) { deliveryProfile = SubtitleCore.normaliseProfile(profile); storeProfile(); }
    if (Number.isFinite(+savedFps) && +savedFps > 0) {
        fps = +savedFps;
        const select = document.getElementById('fpsSelect');
        if (select && [...(select.options || [])].some(o => +o.value === fps)) select.value = String(fps);
    }
    workspaceSettings = rest;
    if (typeof TmWorkspace !== 'undefined') TmWorkspace.onSettings?.(rest);
}

function storeProfile() {
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(deliveryProfile)); }
    catch { /* storage unavailable; the profile simply will not persist */ }
}

let deliveryProfile = loadProfile();

function charCountDisplay(text) {
    if (!text) return `0 / ${deliveryProfile.maxCharsPerLine}`;
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
        // The waveform tints everything behind the playhead as played, so it
        // has to be repainted as the playhead moves. Redrawing reads only the
        // visible pixel columns out of the peak pyramid, so this is cheap.
        scheduleRulerRedraw();

        // Loop the armed range rather than running past it.
        if (loopRange && video.currentTime >= loopRange.end) {
            video.currentTime = loopRange.start;
        }

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

    const paintPlay = () => {
        const icon = video.paused ? '<i class="bi bi-play-fill"></i>' : '<i class="bi bi-pause-fill"></i>';
        btnPlay.innerHTML = icon;
        const tl = document.getElementById('tlPlayPause');
        if (tl) tl.innerHTML = icon;
    };
    video.addEventListener('play', () => {
        paintPlay();
        autoPauseArmed = true;
        // Hand the view to the playhead: whatever distance separates them
        // glides away over the next few frames instead of jumping.
        viewOffset = viewCentre - video.currentTime;
        viewTarget = null;
        kickView();
    });
    video.addEventListener('pause', () => { paintPlay(); scheduleRulerRedraw(); });
    // A seek from anywhere but the strip (buttons, keys, the cue list) brings
    // the playhead back to the centre; a click on the strip leaves the view
    // where the user was looking.
    video.addEventListener('seeking', () => {
        if (timelineSeek) { timelineSeek = false; scheduleRulerRedraw(); return; }
        if (playing()) { viewOffset = viewCentre - video.currentTime; kickView(); }
        else steerView(video.currentTime);
    });

    btnPlay.addEventListener('click', () => video.paused ? video.play() : video.pause());
    btnSkipBack.addEventListener('click', () => video.currentTime = Math.max(0, video.currentTime - 5));
    btnSkipFwd.addEventListener('click',  () => video.currentTime += 5);
    btnFrameBack.addEventListener('click', () => stepFrame(-1));
    btnFrameFwd.addEventListener('click',  () => stepFrame(1));
    speedSelect.addEventListener('change', () => video.playbackRate = parseFloat(speedSelect.value));

    // Seeking and scrubbing live in wireTimelineSurface(); the old handler
    // here measured from the canvas alone, which is pinned to the left of the
    // viewport, so every click landed at the wrong time once the strip was
    // scrolled.

    // Draw waveform placeholder bars on timeline. Default to a zoom level
    // where a typical cue is comfortably readable rather than fitting the
    // whole track (which turns a long video into unreadable slivers) —
    // setZoom() still clamps up to fit-width for short clips.
    video.addEventListener('loadedmetadata', () => setZoom(defaultZoom(), 0));
}

fpsSelect.addEventListener('change', () => {
    fps = parseFloat(fpsSelect.value);
    renderEvents();
    if (loaded) markDirty();
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
    if (!translatorOnly()) return;
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

/* Plays the selected cue with a run-up and run-out. Timing a cue by ear
   means hearing the line arrive, not starting mid-word on its in-point. */
function playWithPreroll() {
    const ev = events.find(x => x.id === activeId);
    if (!ev || !video) { alert('Select a cue first.'); return; }
    video.currentTime = Math.max(0, tcToSecs(ev.startTime) - prerollSecs);
    playingRangeEnd = tcToSecs(ev.endTime) + prerollSecs;
    video.play();
}

function toggleLoopSelected() {
    const btn = document.getElementById('tlLoop');
    if (loopRange) {
        loopRange = null;
        btn?.classList.remove('tm-toggle-on');
        btn?.setAttribute('aria-pressed', 'false');
        drawTimelineRuler();
        return;
    }
    const ev = events.find(x => x.id === activeId);
    if (!ev || !video) { alert('Select a cue to loop.'); return; }
    // Padded by the run-up setting on both sides, so the line is heard
    // arriving and leaving, not cut mid-breath.
    loopRange = { start: Math.max(0, tcToSecs(ev.startTime) - prerollSecs), end: tcToSecs(ev.endTime) + prerollSecs };
    playingRangeEnd = null;
    btn?.classList.add('tm-toggle-on');
    btn?.setAttribute('aria-pressed', 'true');
    video.currentTime = loopRange.start;
    video.play();
    drawTimelineRuler();
}

/* Pulls the selected cue onto the dialogue the analysis found underneath it.
   This is the edit a timing pass otherwise spends its whole day doing by
   hand, one edge at a time. */
function fitSelectedToSpeech() {
    const targets = selectionTargets();
    if (!targets.length) { alert('Select a cue first.'); return; }
    if (peaksStatus !== 'ready') { alert('The audio has not been analysed yet, so there is no dialogue to snap to.'); return; }
    let fitted = 0;
    targets.forEach(id => {
        const ev = events.find(x => x.id === id);
        const region = TmWaveform.regionForRange(peaks, tcToSecs(ev.startTime), tcToSecs(ev.endTime));
        if (!region || region.end - region.start < MIN_CUE_DUR) return;
        ev.startTime = secsToSrtTc(region.start);
        ev.endTime   = secsToSrtTc(region.end);
        fitted++;
    });
    if (!fitted) { alert('No dialogue was detected near the selected cue.'); return; }
    markDirty(); renderEvents(); renderTimelineBlocks(); drawTimelineRuler();
}

function jumpToSpeechEdge(direction) {
    if (!video) return;
    if (peaksStatus !== 'ready') { alert('The audio has not been analysed yet.'); return; }
    const edge = TmWaveform.stepEdge(peaks, video.currentTime, direction);
    if (edge == null) { alert(direction > 0 ? 'No further dialogue in this track.' : 'No earlier dialogue in this track.'); return; }
    seekTo(edge);
    keepPlayheadVisible();
    drawTimelineRuler();
}

/* Splits at the playhead rather than at the text caret (which splitAtCaret
   does) — the natural gesture when you are working by ear. */
function splitAtPlayhead() {
    if (!translatorOnly()) return;
    if (!loaded || !video) return;
    const idx = events.findIndex(ev => ev.id === activeId);
    if (idx === -1) { alert('Select a cue first.'); return; }
    const cue = events[idx];
    const at = video.currentTime;
    if (at <= tcToSecs(cue.startTime) + MIN_CUE_DUR || at >= tcToSecs(cue.endTime) - MIN_CUE_DUR) {
        alert('Move the playhead inside the selected cue, far enough from either edge to leave two usable cues.');
        return;
    }
    try {
        const [a, b] = SubtitleCore.splitCue(cue, at);
        events.splice(idx, 1, { ...a, id: cue.id }, { ...b, id: nextTempId-- });
        activeId = cue.id;
        selectedIds = new Set([activeId]);
        markDirty(); renderEvents(); renderTimelineBlocks(); drawTimelineRuler();
    } catch (error) { alert(error.message); }
}

function joinWithNext() {
    if (!translatorOnly()) return;
    if (!loaded) return;
    const idx = events.findIndex(ev => ev.id === activeId);
    if (idx === -1 || idx >= events.length - 1) { alert('Select a cue that has a next cue to join with.'); return; }
    const merged = SubtitleCore.mergeCues(events[idx], events[idx + 1]);
    events.splice(idx, 2, {
        ...merged,
        id: events[idx].id,
        originalLocked: events[idx].originalLocked || events[idx + 1].originalLocked,
    });
    activeId = events[idx].id;
    selectedIds = new Set([activeId]);
    markDirty(); renderEvents(); renderTimelineBlocks(); drawTimelineRuler();
}

/* Frames the selected cue with a little air either side, so its edges and
   the audio around them are both visible. */
function zoomToSelection() {
    const ev = events.find(x => x.id === activeId);
    if (!ev) { alert('Select a cue first.'); return; }
    const start = tcToSecs(ev.startTime), end = tcToSecs(ev.endTime);
    const span = Math.max(end - start, MIN_CUE_DUR) * 2.2;
    const width = timelineScroll?.clientWidth || 800;
    setZoom(width / span, (start + end) / 2);
}

function setVolume(fraction) {
    if (!video) return;
    video.volume = Math.max(0, Math.min(1, fraction));
    if (video.volume > 0) video.muted = false;
    paintVolumeButton();
    saveTimelinePrefs();
}

function paintVolumeButton() {
    const btn = document.getElementById('tlMute');
    if (!btn || !video) return;
    const icon = video.muted || video.volume === 0 ? 'bi-volume-mute-fill'
        : video.volume < 0.5 ? 'bi-volume-down-fill'
        : 'bi-volume-up-fill';
    btn.innerHTML = `<i class="bi ${icon}"></i>`;
    btn.classList.toggle('tm-toggle-on', video.muted);
    btn.title = video.muted ? 'Unmute' : 'Mute';
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
    if (!translatorOnly()) return;
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
    if (!translatorOnly()) return;
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
    if (!translatorOnly()) return;
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

// The shape of the track and the wording of each line belong to the
// translator. A revisor adjusts timing and proposes wording in their own
// column; anything else is refused here, and by the server, rather than
// letting the revisor make changes that would silently not be saved.
function translatorOnly() {
    if (typeof CAN_EDIT_TRANSLATION === 'undefined' || CAN_EDIT_TRANSLATION) return true;
    alert('Only the translator can add, split, merge, delete or reword lines. Put your change in the suggestion column instead.');
    return false;
}

if (typeof CAN_EDIT_TRANSLATION !== 'undefined' && !CAN_EDIT_TRANSLATION) {
    ['btnAddEvent', 'btnSplitCue', 'btnMergeCue', 'tlDuplicate', 'copySource', 'replaceAll']
        .forEach(id => { const el = document.getElementById(id); if (el) el.hidden = true; });
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
Shortcuts.on('importScript', () => importScript?.click());
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
Shortcuts.on('jumpBack',    () => rewindSeconds(jumpSeconds));
Shortcuts.on('jumpForward', () => fastForwardSeconds(jumpSeconds));
Shortcuts.on('loopSelected', () => toggleLoopSelected());
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

// ── View model ────────────────────────────────────────
/* The strip is a window onto the track centred on `viewCentre`. While the
   video plays the centre is the playhead, so the playhead stands still in the
   middle and the audio and subtitles flow under it. While paused the view can
   be panned freely (wheel, overview bar, dragging the empty strip) and the
   playhead is drawn wherever it actually is.

   Nothing here scrolls natively. The canvas is the size of the visible strip
   and is redrawn from the model; the cue blocks are real elements, but only
   those near the view are rendered, inside a layer moved with a transform.
   Native scrolling quantised to whole pixels and could not be centred on the
   playhead without hacks, which is what made the old strip judder. */
let viewCentre   = 0;
let viewOffset   = 0;      // remaining glide distance (s) toward the heading
let viewTarget   = null;   // where a paused glide is heading
let viewRaf      = 0;
let timelineSeek = false;  // the next 'seeking' came from the strip itself
let renderedWindow = null; // { from, to, origin, pps } of the rendered blocks
let snapGuide    = null;   // { t, kind } while a drag sits on a snap point
let drawDraft    = null;   // { anchor, start, end } while drawing a new cue
let panState     = null;   // { startX, startCentre } while grab-panning
let rulerScrub   = null;   // { wasPlaying } while scrubbing on the ruler
let overviewDrag = false;
let shotCuts     = [];
let shotsStatus  = 'idle'; // idle | working | ready | failed
let shotsMessage = '';
let shotsProgress = 0;
let showBlockText = true;
let followPlayback = true;   // keep the playhead centred while playing
let jumpSeconds = 2;         // the configurable short jump (J / L)
let snapToCuts   = true;

const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : fn => setTimeout(fn, 16);
const BLOCK_PAD_Y = 3;
const SHOT_WINDOW_FRAMES = 12;   // an edge this close to a cut should be on it
const OUT_BEFORE_CUT_FRAMES = 2; // where an out-time belongs relative to a cut

function viewWidth()  { return timelineScroll?.clientWidth || 0; }
function viewHeight() { return timelineScroll?.clientHeight || 0; }
function viewStartSecs() { return viewCentre - viewWidth() / 2 / pxPerSecond; }
function xOfTime(t) { return (t - viewStartSecs()) * pxPerSecond; }
function playing() { return !!video && !video.paused && !video.ended; }

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

function clampView() {
    const span = timelineSpan();
    if (!Number.isFinite(viewCentre)) viewCentre = 0;
    viewCentre = Math.max(0, Math.min(viewCentre, span || 0));
}

function fitZoom() {
    const span = timelineSpan();
    const width = viewWidth();
    if (!span || !Number.isFinite(width) || width <= 0) return MIN_PX_PER_SEC;
    return Math.max(MIN_PX_PER_SEC, width / span);
}

// Ten seconds across the strip: enough to read every box on a dense scene,
// enough context to see the next line coming.
function defaultZoom() {
    const width = viewWidth();
    return width > 0 ? width / 10 : DEFAULT_PX_PER_SEC;
}

/* Changes the zoom. With `centreOn` the view is centred there; otherwise the
   centre stays put, so zooming never loses the playhead. */
function setZoom(next, centreOn) {
    const clamped = Math.min(MAX_PX_PER_SEC, Math.max(fitZoom(), next));
    if (!Number.isFinite(clamped) || clamped <= 0) return;
    pxPerSecond = clamped;
    if (centreOn != null && !playing()) { viewCentre = centreOn; viewOffset = 0; viewTarget = null; }
    paintZoomSlider();
    drawTimelineRuler();
}

/* Zooms about a point on screen, keeping the time under it where it is. */
function zoomAt(next, t, screenX) {
    const clamped = Math.min(MAX_PX_PER_SEC, Math.max(fitZoom(), next));
    if (!Number.isFinite(clamped) || clamped <= 0) return;
    pxPerSecond = clamped;
    if (!playing()) viewCentre = t - (screenX - viewWidth() / 2) / pxPerSecond;
    paintZoomSlider();
    drawTimelineRuler();
}

// The zoom slider is logarithmic: each step of it is the same proportional
// change, from the whole film down to single frames.
function paintZoomSlider() {
    const slider = document.getElementById('tlZoom');
    if (!slider) return;
    const lo = Math.log(fitZoom()), hi = Math.log(MAX_PX_PER_SEC);
    slider.value = hi > lo ? Math.round((Math.log(pxPerSecond) - lo) / (hi - lo) * 1000) : 0;
}
function zoomFromSlider(value) {
    const lo = Math.log(fitZoom()), hi = Math.log(MAX_PX_PER_SEC);
    setZoom(Math.exp(lo + (hi - lo) * (value / 1000)));
}

// ── Gliding the view ────────────────────────────────
/* One animation loop drives every view movement. While playing it holds the
   playhead in the centre; any remaining offset (from a seek, or from pressing
   play with the playhead off-centre) decays over a few frames, so the strip
   glides into place instead of jumping. */
function kickView() { if (!viewRaf) viewRaf = raf(tickView); }

function tickView() {
    viewRaf = 0;
    if (playing() && !followPlayback) {
        const x = xOfTime(video.currentTime);
        if (x < 0 || x > viewWidth() - 20) { viewOffset = 0; viewCentre = video.currentTime + (viewWidth() / 2 - 40) / pxPerSecond; }
        drawTimelineRuler();
        viewRaf = raf(tickView);
        return;
    }
    const heading = playing() ? video.currentTime : viewTarget;
    if (heading == null) return;
    viewOffset *= 0.72;
    if (Math.abs(viewOffset) * pxPerSecond < 0.5) viewOffset = 0;
    viewCentre = heading + viewOffset;
    drawTimelineRuler();
    if (playing() || viewOffset !== 0) viewRaf = raf(tickView);
    else viewTarget = null;
}

/* Glides a paused view so `t` lands in the centre. */
function steerView(t) {
    if (playing()) return;
    viewTarget = t;
    viewOffset = viewCentre - t;
    kickView();
}

function stopGlide() { viewOffset = 0; viewTarget = null; }

function panBy(seconds) {
    if (playing()) { seekTo(video.currentTime + seconds); return; }
    stopGlide();
    viewCentre += seconds;
    scheduleRulerRedraw();
}

let rulerRedrawScheduled = false;
function scheduleRulerRedraw() {
    if (rulerRedrawScheduled) return;
    rulerRedrawScheduled = true;
    raf(() => { rulerRedrawScheduled = false; drawTimelineRuler(); });
}

function keepPlayheadVisible() {
    if (!video || playing()) return;
    const x = xOfTime(video.currentTime);
    if (x < 40 || x > viewWidth() - 40) steerView(video.currentTime);
    else scheduleRulerRedraw();
}

function scrollBlockIntoView(id, center = false) {
    const ev = events.find(x => x.id === id);
    if (!ev || playing() || !viewWidth()) return;
    const start = tcToSecs(ev.startTime), end = tcToSecs(ev.endTime);
    const x0 = xOfTime(start), x1 = xOfTime(end);
    if (center || x0 < 20 || x1 > viewWidth() - 20) steerView((start + end) / 2);
    else scheduleRulerRedraw();
}

// ── Drawing ─────────────────────────────────────────
// Kept for callers that ask how the strip is divided. The cue boxes now sit
// on the waveform itself, so the audio lane and the block lane are the same.
function laneMetrics(H) {
    const top = RULER_H;
    const waveH = Math.max(16, H - top);
    return { strip: 0, top, blocks: waveH, waveH, mid: top + waveH / 2, bottom: top + waveH };
}

/* Repaints the strip: waveform, shot changes, timing warnings, the ruler,
   and the overview bar, then lines the block layer and the playhead up with
   the new view. Reads only what is visible, so it runs every frame during
   playback. */
function drawTimelineRuler() {
    if (!canvas || !timelineScroll) return;
    const W = viewWidth(), H = viewHeight();
    if (!W || !H) return;
    clampView();

    const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    const bw = Math.round(W * dpr), bh = Math.round(H * dpr);
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0d0e11';
    ctx.fillRect(0, 0, W, H);

    const lanes = laneMetrics(H);
    const t0 = viewStartSecs();
    if (timelineSpan()) {
        drawOutOfTrack(ctx, W, H, t0, lanes);
        drawWaveform(ctx, W, H, t0, lanes);
        drawTimingWarnings(ctx, W, t0, lanes);
        drawTimecodeRuler(ctx, W, H, t0);
        drawLoopBand(ctx, W, t0);
    } else {
        drawTimecodeRuler(ctx, W, H, t0);
    }

    // Shot changes, the cue being drawn and the snap guide go on a second
    // canvas above the subtitle boxes: under them, a cut inside a box was a
    // faint line behind a tinted panel, which is exactly where it matters.
    const over = document.getElementById('timelineOverlay');
    if (over?.getContext) {
        if (over.width !== bw || over.height !== bh) { over.width = bw; over.height = bh; }
        over.style.width = W + 'px';
        over.style.height = H + 'px';
        const octx = over.getContext('2d');
        octx.setTransform(dpr, 0, 0, dpr, 0, 0);
        octx.clearRect(0, 0, W, H);
        if (timelineSpan()) {
            drawShotChanges(octx, W, t0, lanes);
            drawDraftCue(octx, t0, lanes);
            drawSnapGuide(octx, t0, lanes);
        }
    }
    positionTimelineLayers();
    drawOverview();
    paintTimecode();
}

// Before 0 and past the end of the track there is nothing to edit; shading
// it says so instead of leaving an ambiguous blank.
function drawOutOfTrack(ctx, W, H, t0, lanes) {
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    const xStart = xOfTime(0);
    if (xStart > 0) ctx.fillRect(0, lanes.top, Math.min(W, xStart), lanes.waveH);
    const xEnd = xOfTime(timelineSpan());
    if (xEnd < W) ctx.fillRect(Math.max(0, xEnd), lanes.top, W - Math.max(0, xEnd), lanes.waveH);
}

// Picks a "nice" tick spacing (seconds) so labeled ticks land at least
// minPx apart on screen at the current zoom, however far in or out that is.
const TICK_STEPS = [0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
function pickTickInterval(minPx) {
    for (const step of TICK_STEPS) if (step * pxPerSecond >= minPx) return step;
    return TICK_STEPS[TICK_STEPS.length - 1];
}

function drawTimecodeRuler(ctx, W, H, originSecs) {
    ctx.fillStyle = '#16171c';
    ctx.fillRect(0, 0, W, RULER_H);
    const dur = timelineSpan();
    if (dur) {
        const interval = pickTickInterval(96);
        const minor = interval / 5;
        const tEnd = originSecs + W / pxPerSecond;

        if (minor * pxPerSecond >= 6) {
            ctx.strokeStyle = 'rgba(255,255,255,0.22)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            const first = Math.max(0, Math.floor(originSecs / minor));
            const last = Math.min(Math.ceil(tEnd / minor), first + Math.ceil(W / 6) + 4);
            for (let n = first; n <= last; n++) {
                const t = n * minor;
                if (t > dur) break;
                const x = Math.round((t - originSecs) * pxPerSecond) + 0.5;
                ctx.moveTo(x, RULER_H - 5);
                ctx.lineTo(x, RULER_H);
            }
            ctx.stroke();
        }

        // Frame ticks once a frame is wide enough to aim at.
        if (pxPerSecond / fps >= 6) {
            const frameLen = 1 / fps;
            ctx.strokeStyle = 'rgba(255,255,255,0.14)';
            ctx.beginPath();
            const f0 = Math.max(0, Math.floor(originSecs / frameLen));
            const f1 = Math.min(Math.ceil(tEnd / frameLen), f0 + Math.ceil(W / 6) + 4);
            for (let f = f0; f <= f1; f++) {
                const t = f * frameLen;
                if (t > dur) break;
                const x = Math.round((t - originSecs) * pxPerSecond) + 0.5;
                ctx.moveTo(x, RULER_H - 3);
                ctx.lineTo(x, RULER_H);
            }
            ctx.stroke();
        }

        const firstN = Math.max(0, Math.floor(originSecs / interval));
        const maxTicks = Math.ceil(W / 8) + 4;
        ctx.font = '600 10px "Courier New", monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        for (let n = firstN, drawn = 0; drawn < maxTicks; n++, drawn++) {
            const t = n * interval;
            if (t > dur) break;
            const x = Math.round((t - originSecs) * pxPerSecond) + 0.5;
            if (x > W + 2) break;
            ctx.strokeStyle = 'rgba(255,255,255,0.5)';
            ctx.beginPath();
            ctx.moveTo(x, 4);
            ctx.lineTo(x, RULER_H);
            ctx.stroke();
            ctx.fillStyle = 'rgba(255,255,255,0.8)';
            ctx.fillText(tcLabel(t), x + 4, 13);
        }
    }
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(0, RULER_H - 1, W, 1);
}

/* The waveform. Peaks as a soft envelope, loudness (RMS) as a solid core
   inside it: the envelope shows where there is any sound at all, the core
   where it is loud enough to be speech. The whole thing is scaled to the
   track's own loudness, so a quiet dialogue stem fills the lane instead of
   lying flat along the centre line. */
function drawWaveform(ctx, W, H, originSecs, lanes) {
    if (peaksStatus !== 'ready' || !peaks) {
        drawWaveformPlaceholder(ctx, W, H, lanes);
        return;
    }
    const cols = TmWaveform.columnsFor(peaks, originSecs, pxPerSecond, Math.ceil(W));
    const mid = lanes.mid;
    const half = lanes.waveH / 2 - 3;
    const scale = waveScaler();
    const amp = half * waveGain;
    const top = lanes.top + 1, bottom = lanes.bottom - 1;
    const y = v => Math.max(top, Math.min(bottom, mid - scale(v) * amp));

    if (showSpeech && peaks.speech) {
        ctx.fillStyle = 'rgba(80,220,255,0.07)';
        for (const r of peaks.speech) {
            const x0 = (r.start - originSecs) * pxPerSecond, x1 = (r.end - originSecs) * pxPerSecond;
            if (x1 < 0) continue;
            if (x0 > W) break;
            ctx.fillRect(Math.max(0, x0), lanes.top, Math.min(W, x1) - Math.max(0, x0), lanes.waveH);
        }
    }

    // Centre line first, so silence still reads as a line rather than a gap.
    ctx.fillStyle = 'rgba(120,200,255,0.25)';
    ctx.fillRect(0, Math.round(mid), W, 1);

    const n = Math.min(W, cols.max.length);
    if (waveView === 'bars') {
        ctx.fillStyle = 'rgba(130,215,255,0.9)';
        for (let x = 0; x < n; x += 3) {
            const h = Math.min(half, Math.max(scale(cols.rms[x]) * amp, 0.5));
            ctx.fillRect(x, mid - h, 2, h * 2);
        }
        return;
    }
    if (waveView !== 'rms') {
        ctx.fillStyle = waveView === 'peak' ? 'rgba(130,215,255,0.9)' : 'rgba(60,150,230,0.8)';
        ctx.beginPath();
        ctx.moveTo(0, y(cols.max[0]));
        for (let x = 1; x < n; x++) ctx.lineTo(x, y(cols.max[x]));
        for (let x = n - 1; x >= 0; x--) ctx.lineTo(x, y(cols.min[x]));
        ctx.closePath();
        ctx.fill();
    }
    if (waveView !== 'peak') {
        ctx.fillStyle = 'rgba(175,228,255,0.85)';
        ctx.beginPath();
        ctx.moveTo(0, y(cols.rms[0]));
        for (let x = 1; x < n; x++) ctx.lineTo(x, y(cols.rms[x]));
        for (let x = n - 1; x >= 0; x--) ctx.lineTo(x, y(-cols.rms[x]));
        ctx.closePath();
        ctx.fill();
    }
}

/* Maps a sample value (-1..1) to a height (-1..1) for the lane.

   Decibels are the default because a film mix spans a huge range: on a
   linear scale the music sets the size and the dialogue — the part being
   subtitled — is a thin line along the middle. On a 45 dB scale referred to
   the track's own loud level, speech twenty decibels down still fills more
   than half the lane, and nothing loud can blow the lane out. */
const WAVE_DB_RANGE = 45;
function waveScaler() {
    const ref = peaks?.reference || 1;
    if (waveScale === 'linear') {
        const norm = Math.min(40, 0.9 / ref);
        return v => v * norm;
    }
    return v => {
        const a = v < 0 ? -v : v;
        if (a < 1e-5) return 0;
        const d = 1 + 20 * Math.log10(a / ref) / WAVE_DB_RANGE;
        const h = d <= 0 ? 0 : d > 1.05 ? 1.05 : d;
        return v < 0 ? -h : h;
    };
}

/* What the audio lane says before (or instead of) a waveform. */
function drawWaveformPlaceholder(ctx, W, H, lanes) {
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(0, Math.round(lanes.mid), W, 1);
    const msg = peaksStatus === 'working' ? ''
        : peaksStatus === 'failed' ? (peaksMessage || 'Audio could not be analysed')
        : video?.currentSrc || video?.src ? 'Reading the audio…'
        : 'No video in this project — the ruler and subtitle boxes still work';
    if (!msg) return;
    ctx.fillStyle = 'rgba(154,154,165,0.85)';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(msg, W / 2, lanes.top + 16);
    ctx.textAlign = 'left';
}

function drawShotChanges(ctx, W, originSecs, lanes) {
    if (!shotCuts.length) return;
    const tEnd = originSecs + W / pxPerSecond;
    ctx.fillStyle = 'rgba(196,150,255,0.9)';
    for (const c of shotCuts) {
        if (c < originSecs - 0.1) continue;
        if (c > tEnd + 0.1) break;
        const x = Math.round((c - originSecs) * pxPerSecond);
        ctx.fillRect(x, lanes.top, 1, lanes.waveH);
        // A diamond on the ruler, so a cut stays findable when a box covers
        // the line below.
        ctx.beginPath();
        ctx.moveTo(x + 0.5, RULER_H - 9);
        ctx.lineTo(x + 4.5, RULER_H - 5);
        ctx.lineTo(x + 0.5, RULER_H - 1);
        ctx.lineTo(x - 3.5, RULER_H - 5);
        ctx.closePath();
        ctx.fill();
    }
}

/* Problems with the spacing of cues, drawn where they are: a short gap as a
   red bar between the two cues, an overlap as a hatched band, an edge that
   just misses a shot change as an amber tick joined to the cut. */
function drawTimingWarnings(ctx, W, originSecs, lanes) {
    const tEnd = originSecs + W / pxPerSecond;
    const minGap = deliveryProfile?.minGapSeconds ?? 0.08;
    for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        const start = tcToSecs(ev.startTime), end = tcToSecs(ev.endTime);
        if (end < originSecs - 2) continue;
        if (start > tEnd + 2) break;

        const next = events[i + 1];
        if (next) {
            const ns = tcToSecs(next.startTime);
            const gap = ns - end;
            if (gap < 0) {
                const x0 = (ns - originSecs) * pxPerSecond, x1 = (end - originSecs) * pxPerSecond;
                ctx.fillStyle = 'rgba(255,51,85,0.55)';
                ctx.fillRect(x0, lanes.bottom - 7, Math.max(2, x1 - x0), 6);
                warningTick(ctx, (x0 + x1) / 2, 'rgba(255,51,85,1)');
            } else if (gap > 0 && gap < minGap) {
                const x0 = (end - originSecs) * pxPerSecond, x1 = (ns - originSecs) * pxPerSecond;
                ctx.fillStyle = 'rgba(255,51,85,0.75)';
                ctx.fillRect(x0, lanes.top + BLOCK_PAD_Y, Math.max(2, x1 - x0), lanes.waveH - BLOCK_PAD_Y * 2);
                warningTick(ctx, (x0 + x1) / 2, 'rgba(255,51,85,1)');
            }
        }

        for (const note of shotNotes(ev)) {
            const xe = (note.edge - originSecs) * pxPerSecond;
            const xc = (note.cut - originSecs) * pxPerSecond;
            ctx.strokeStyle = 'rgba(255,179,0,0.95)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(xe, RULER_H + 2);
            ctx.lineTo(xc, RULER_H + 2);
            ctx.stroke();
            ctx.lineWidth = 1;
            warningTick(ctx, xe, 'rgba(255,179,0,1)');
        }
    }
}

function warningTick(ctx, x, colour) {
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(x - 4, RULER_H - 8);
    ctx.lineTo(x + 4, RULER_H - 8);
    ctx.lineTo(x, RULER_H - 1);
    ctx.closePath();
    ctx.fill();
}

/* Shot-change advice for one cue: each edge that lands within a few frames
   of a cut without being on the right spot. In-times belong on the cut;
   out-times a couple of frames before it. */
function shotNotes(ev) {
    if (!shotCuts.length || typeof TmShots === 'undefined') return [];
    const frame = 1 / fps;
    const reach = SHOT_WINDOW_FRAMES * frame;
    const notes = [];
    const start = tcToSecs(ev.startTime), end = tcToSecs(ev.endTime);

    const cIn = TmShots.nearest(shotCuts, start);
    if (cIn != null && Math.abs(start - cIn) <= reach && Math.abs(start - cIn) > frame / 2) {
        const frames = Math.round((start - cIn) / frame);
        notes.push({ edge: start, cut: cIn, text: `In-time is ${Math.abs(frames)} frame${Math.abs(frames) === 1 ? '' : 's'} ${frames > 0 ? 'after' : 'before'} a shot change` });
    }
    const cOut = TmShots.nearest(shotCuts, end);
    if (cOut != null && Math.abs(end - cOut) <= reach) {
        const ideal = cOut - OUT_BEFORE_CUT_FRAMES * frame;
        if (Math.abs(end - ideal) > frame / 2) {
            const frames = Math.round((end - cOut) / frame);
            notes.push({ edge: end, cut: cOut, text: `Out-time is ${frames === 0 ? 'on' : Math.abs(frames) + ' frame' + (Math.abs(frames) === 1 ? '' : 's') + (frames > 0 ? ' after' : ' before')} a shot change (aim for ${OUT_BEFORE_CUT_FRAMES} frames before)` });
        }
    }
    return notes;
}

function drawDraftCue(ctx, originSecs, lanes) {
    if (!drawDraft) return;
    const x0 = (drawDraft.start - originSecs) * pxPerSecond;
    const x1 = (drawDraft.end - originSecs) * pxPerSecond;
    ctx.fillStyle = 'rgba(226,0,26,0.22)';
    ctx.fillRect(x0, lanes.top + BLOCK_PAD_Y, x1 - x0, lanes.waveH - BLOCK_PAD_Y * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x0 + 0.5, lanes.top + BLOCK_PAD_Y + 0.5, Math.max(1, x1 - x0 - 1), lanes.waveH - BLOCK_PAD_Y * 2 - 1);
    ctx.setLineDash([]);
}

function drawLoopBand(ctx, W, originSecs) {
    if (!loopRange) return;
    const x0 = (loopRange.start - originSecs) * pxPerSecond;
    const x1 = (loopRange.end - originSecs) * pxPerSecond;
    if (x1 < 0 || x0 > W) return;
    ctx.fillStyle = 'rgba(80,220,255,0.18)';
    ctx.fillRect(x0, 0, x1 - x0, RULER_H);
    ctx.fillStyle = 'rgba(80,220,255,0.95)';
    ctx.fillRect(x0, 0, 2, RULER_H);
    ctx.fillRect(x1 - 2, 0, 2, RULER_H);
}

const SNAP_COLOURS = { cut: '#c496ff', speech: '#50dcff', cue: '#ffffff', gap: '#ff6680', playhead: '#e2001a', frame: '#9a9aa5' };
function drawSnapGuide(ctx, originSecs, lanes) {
    if (!snapGuide) return;
    const x = Math.round((snapGuide.t - originSecs) * pxPerSecond) + 0.5;
    ctx.strokeStyle = SNAP_COLOURS[snapGuide.kind] || '#fff';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, lanes.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
}

/* Keeps the DOM layers — cue blocks, playhead, hover line — in step with
   the canvas after the view moves. */
function positionTimelineLayers() {
    ensureBlocksRendered();
    if (timelineInner && renderedWindow) {
        const dx = (renderedWindow.origin - viewStartSecs()) * pxPerSecond;
        timelineInner.style.transform = `translate3d(${dx}px,0,0)`;
    }
    pinOffscreenLabels();
    updateCursor();
}

/* A box that starts left of the view keeps its number and text at the left
   edge of the strip, so a long subtitle the playhead is inside is never
   reduced to the tail end of a sentence. */
let pinnedBlock = null;
function pinOffscreenLabels() {
    if (!timelineEvents?.querySelectorAll) return;
    const t0 = viewStartSecs();
    let found = null, shift = 0;
    for (let i = 0; i < events.length; i++) {
        const s = tcToSecs(events[i].startTime);
        if (s >= t0) break;
        const e = tcToSecs(events[i].endTime);
        if (e > t0) { found = events[i].id; shift = (t0 - s) * pxPerSecond; }
    }
    const block = found != null ? timelineEvents.querySelector(`.tm-timeline-block[data-id="${found}"]`) : null;
    if (pinnedBlock && pinnedBlock !== block) pinnedBlock.style.removeProperty?.('--tm-pin');
    if (block) {
        // Stop pinning once only a sliver remains, so the label leaves with it.
        block.style.setProperty?.('--tm-pin', Math.max(0, Math.min(shift, block.offsetWidth - 80)) + 'px');
    }
    pinnedBlock = block;
}

function updateCursor() {
    if (!cursor) return;
    if (!video || !Number.isFinite(video.duration)) { cursor.style.display = 'none'; return; }
    const x = xOfTime(video.currentTime);
    const W = viewWidth();
    cursor.style.display = x < -4 || x > W + 4 ? 'none' : '';
    cursor.style.transform = `translate3d(${x}px,0,0)`;
}

function paintTimecode() {
    const el = document.getElementById('tlTimecode');
    if (el && video) el.textContent = tcLabel(video.currentTime || 0);
}

// ── Overview bar ───────────────────────────────────
/* A map of the whole film under the strip: where the cues are and how far
   they have got, where the dialogue is, and which part the strip is showing.
   Dragging it is the fast way across a feature-length track. */
function drawOverview() {
    const ov = document.getElementById('timelineOverview');
    if (!ov || !ov.getContext) return;
    const W = ov.clientWidth, H = ov.clientHeight;
    if (!W || !H) return;
    const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    if (ov.width !== Math.round(W * dpr) || ov.height !== Math.round(H * dpr)) {
        ov.width = Math.round(W * dpr);
        ov.height = Math.round(H * dpr);
    }
    const ctx = ov.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0a0c';
    ctx.fillRect(0, 0, W, H);
    const span = timelineSpan();
    if (!span) return;
    const sx = W / span;

    if (peaksStatus === 'ready' && peaks) {
        const cols = TmWaveform.columnsFor(peaks, 0, sx, Math.ceil(W));
        const scale = waveScaler();
        ctx.fillStyle = 'rgba(64,170,235,0.45)';
        for (let x = 0; x < W; x++) {
            const h = Math.min(H - 2, scale(cols.rms[x]) * (H - 2));
            if (h > 0.3) ctx.fillRect(x, H - h, 1, h);
        }
    }
    for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        const x = tcToSecs(ev.startTime) * sx;
        const w = Math.max(1, (tcToSecs(ev.endTime) - tcToSecs(ev.startTime)) * sx);
        const issues = issuesAt(i);
        ctx.fillStyle = issues.includes('Overlapping cues') || issues.includes('Invalid timing') ? '#ff3355'
            : issues.some(s => s !== 'Untranslated') ? '#ffb300'
            : ev.translatedText?.trim() ? '#29c76f' : '#6b6b75';
        ctx.fillRect(x, 2, w, 5);
    }
    const v0 = Math.max(0, viewStartSecs()) * sx;
    const v1 = Math.min(span, viewStartSecs() + viewWidth() / pxPerSecond) * sx;
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(v0, 0, Math.max(2, v1 - v0), H);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.strokeRect(v0 + 0.5, 0.5, Math.max(2, v1 - v0) - 1, H - 1);
    if (video && Number.isFinite(video.duration)) {
        ctx.fillStyle = '#e2001a';
        ctx.fillRect(Math.round(video.currentTime * sx), 0, 2, H);
    }
}

// ══════════════════════════════════════════════════
//  AUDIO & SHOT ANALYSIS
// ══════════════════════════════════════════════════

function setAnalysisProgress(stage, frac) {
    if (!tlProgress) return;
    tlProgress.hidden = false;
    const label = stage === 'download' ? 'Reading the media'
        : stage === 'decode' ? 'Decoding audio'
        : 'Measuring the waveform';
    tlProgressText.textContent = label + '…';
    const overall = stage === 'download' ? frac * 0.7
        : stage === 'decode' ? 0.7 + frac * 0.15
        : 0.85 + frac * 0.15;
    tlProgressFill.style.width = Math.round(overall * 100) + '%';
}

function describeAnalysis() {
    const info = document.getElementById('tlAudioInfo');
    if (info) {
        if (peaksStatus === 'ready') {
            const speech = peaks.speech.reduce((n, r) => n + (r.end - r.start), 0);
            const pct = peaks.duration ? Math.round(speech / peaks.duration * 100) : 0;
            info.textContent = `Audio: ${peaks.speech.length} dialogue regions, ${pct}% of the track.`;
        } else if (peaksStatus === 'working') info.textContent = 'Audio: analysing…';
        else if (peaksStatus === 'failed') info.textContent = 'Audio: ' + (peaksMessage || 'analysis failed.');
        else info.textContent = 'Audio: not analysed yet.';
    }
    const shots = document.getElementById('tlShotInfo');
    if (shots) {
        shots.textContent = shotsStatus === 'ready' ? `Shot changes: ${shotCuts.length} found.`
            : shotsStatus === 'working' ? `Shot changes: scanning the video… ${Math.round(shotsProgress * 100)}%`
            : shotsStatus === 'failed' ? 'Shot changes: ' + (shotsMessage || 'could not be detected.')
            : 'Shot changes: waiting for the audio first.';
    }
    const status = document.getElementById('tlStatus');
    if (status) {
        status.textContent = peaksStatus === 'working' ? 'Reading audio…'
            : shotsStatus === 'working' ? `Finding shot changes ${Math.round(shotsProgress * 100)}%`
            : '';
        status.hidden = !status.textContent;
    }
}

function waveformCacheKey() {
    const src = video?.currentSrc || video?.src || '';
    return src ? `p${PROJECT_ID}|${src}` : null;
}

let analysisRun = 0;
async function loadWaveform({ force = false } = {}) {
    if (!video || !(video.currentSrc || video.src) || typeof TmWaveform === 'undefined') return;
    if (peaksStatus === 'working') return;
    const run = ++analysisRun;
    const key = waveformCacheKey();
    if (force && key) await TmWaveform.forget(key);

    peaksStatus = 'working';
    peaksMessage = '';
    describeAnalysis();
    setAnalysisProgress('download', 0);
    drawTimelineRuler();
    try {
        const result = await TmWaveform.analyse(video.currentSrc || video.src, {
            cacheKey: key,
            onProgress: (stage, frac) => { if (run === analysisRun) setAnalysisProgress(stage, frac); },
        });
        if (run !== analysisRun) return;
        peaks = result;
        peaksStatus = 'ready';
    } catch (err) {
        if (run !== analysisRun) return;
        peaks = null;
        peaksStatus = 'failed';
        peaksMessage = (err && err.message) || 'Audio could not be analysed';
    } finally {
        if (run === analysisRun && tlProgress) tlProgress.hidden = true;
    }
    describeAnalysis();
    drawTimelineRuler();
    // Shot detection plays a second copy of the video; starting it only now
    // keeps the two from fighting over the same download.
    if (shotsStatus === 'idle') loadShotChanges();
}

let shotsRun = 0;
async function loadShotChanges({ force = false } = {}) {
    if (!video || !(video.currentSrc || video.src) || typeof TmShots === 'undefined') return;
    if (shotsStatus === 'working') return;
    const run = ++shotsRun;
    const key = waveformCacheKey();
    if (force && key) await TmShots.forget(key);
    shotsStatus = 'working';
    shotsProgress = 0;
    describeAnalysis();
    try {
        const result = await TmShots.detect(video.currentSrc || video.src, {
            cacheKey: key,
            fps,
            isCancelled: () => run !== shotsRun,
            onProgress: frac => {
                if (run !== shotsRun) return;
                shotsProgress = frac;
                describeAnalysis();
            },
        });
        if (run !== shotsRun) return;
        shotCuts = result.cuts;
        shotsStatus = 'ready';
    } catch (err) {
        if (run !== shotsRun) return;
        shotCuts = [];
        shotsStatus = 'failed';
        shotsMessage = (err && err.message) || 'could not be detected';
    }
    describeAnalysis();
    renderTimelineBlocks();   // block tooltips mention shot-change advice
    drawTimelineRuler();
}

// ══════════════════════════════════════════════════
//  TIMELINE INTERACTION
// ══════════════════════════════════════════════════

function timeAtClientX(clientX) {
    const rect = timelineScroll.getBoundingClientRect();
    return viewStartSecs() + (clientX - rect.left) / pxPerSecond;
}

function clampToTrack(t) {
    const span = timelineSpan();
    return Math.max(0, span ? Math.min(t, span) : t);
}

function tcLabel(secs) {
    const { hms, f } = secsToHMSF(secs);
    return `${hms}:${f}`;
}

/* The readout floats beside the pointer, or beside the edge being dragged,
   so the number is where the eye already is. */
function showReadout(html, x) {
    if (!timelineReadout) return;
    timelineReadout.innerHTML = html;
    timelineReadout.hidden = false;
    if (x != null) {
        const W = viewWidth();
        const left = Math.max(4, Math.min(W - 4, x));
        timelineReadout.style.left = left + 'px';
        timelineReadout.style.transform = left > W - 160 ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)';
    }
}
function hideReadout() { if (timelineReadout) timelineReadout.hidden = true; }

function seekTo(secs) {
    if (!video || !Number.isFinite(video.duration)) return;
    video.currentTime = Math.max(0, Math.min(secs, video.duration));
}

/* A seek that came from the strip itself: the view stays where it is (the
   user was looking at that spot) instead of re-centring. */
function seekFromTimeline(secs) {
    if (!video) return;
    timelineSeek = !playing();
    seekTo(secs);
    scheduleRulerRedraw();
}

function canDrawCues() {
    return loaded && (typeof CAN_EDIT_TRANSLATION === 'undefined' || CAN_EDIT_TRANSLATION);
}

/* The free stretch of track around `t` — between the cue ending before it
   and the cue starting after it — so a drawn cue never lands on another. */
function overlapsAllowed() {
    return !!workspaceSettings?.rules?.allowOverlaps;
}

function freeGapAround(t) {
    let lo = 0, hi = timelineSpan() || Infinity;
    if (overlapsAllowed()) return { lo, hi };
    for (const ev of events) {
        const s = tcToSecs(ev.startTime), e = tcToSecs(ev.endTime);
        if (e <= t && e > lo) lo = e;
        if (s >= t && s < hi) hi = s;
    }
    return { lo, hi };
}

function createCueAt(start, end) {
    if (!canDrawCues()) return;
    const pos = events.findIndex(ev => tcToSecs(ev.startTime) > start);
    const at = pos === -1 ? events.length : pos;
    const ev = {
        id: nextTempId--,
        index: at + 1,
        startTime: secsToSrtTc(start),
        endTime: secsToSrtTc(end),
        originalText: '',
        translatedText: '',
        originalLocked: false,
    };
    events.splice(at, 0, ev);
    activeId = ev.id;
    selectedIds = new Set([ev.id]);
    markDirty();
    renderEvents();
    renderTimelineBlocks();
    selectEvent(ev.id, { scrollBlock: 'center', focusTranslation: true });
}

function wireTimelineSurface() {
    if (!timelineScroll || typeof timelineScroll.getBoundingClientRect !== 'function') return;

    timelineScroll.addEventListener('mousedown', e => {
        const block = e.target.closest?.('.tm-timeline-block');
        if (block) { onBlockMouseDown(e, block); return; }
        const rect = timelineScroll.getBoundingClientRect();
        const y = e.clientY - rect.top;

        // Middle button, or Alt with the left, grabs the strip to pan it.
        if (e.button === 1 || (e.button === 0 && e.altKey)) {
            e.preventDefault();
            panState = { startX: e.clientX, startCentre: viewCentre };
            stopGlide();
            timelineWrap.classList.add('tm-tl-panning');
            return;
        }
        if (e.button !== 0) return;
        e.preventDefault();

        // The ruler scrubs: press and drag to move the playhead.
        if (y < RULER_H || !canDrawCues()) {
            rulerScrub = { wasPlaying: playing(), moved: false, startX: e.clientX };
            if (!scrubAudio && playing()) video.pause();
            if (y >= RULER_H) rulerScrub.lane = true;
            seekFromTimeline(clampToTrack(timeAtClientX(e.clientX)));
            return;
        }

        // Empty waveform: press and drag to draw a new subtitle; a plain
        // click just moves the playhead there.
        const t = clampToTrack(snapValue(timeAtClientX(e.clientX), [], 'in'));
        const gap = freeGapAround(t);
        drawDraft = { anchor: t, start: t, end: t, gap, startX: e.clientX };
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', e => {
        if (panState) {
            stopGlide();
            viewCentre = panState.startCentre - (e.clientX - panState.startX) / pxPerSecond;
            scheduleRulerRedraw();
            return;
        }
        if (rulerScrub) {
            if (Math.abs(e.clientX - rulerScrub.startX) > 2) rulerScrub.moved = true;
            const t = clampToTrack(timeAtClientX(e.clientX));
            seekFromTimeline(t);
            autoPanNearEdge(e.clientX);
            showReadout(`<b>${tcLabel(t)}</b>`, e.clientX - timelineScroll.getBoundingClientRect().left);
            return;
        }
        if (drawDraft) {
            const raw = clampToTrack(timeAtClientX(e.clientX));
            const edge = raw >= drawDraft.anchor ? 'out' : 'in';
            const t = Math.max(drawDraft.gap.lo, Math.min(drawDraft.gap.hi, snapValue(raw, [], edge)));
            drawDraft.start = Math.min(drawDraft.anchor, t);
            drawDraft.end = Math.max(drawDraft.anchor, t);
            autoPanNearEdge(e.clientX);
            const dur = drawDraft.end - drawDraft.start;
            showReadout(`<b>${tcLabel(drawDraft.start)}</b> → <b>${tcLabel(drawDraft.end)}</b> · ${dur.toFixed(2)}s`,
                e.clientX - timelineScroll.getBoundingClientRect().left);
            scheduleRulerRedraw();
        }
    });

    document.addEventListener('mouseup', e => {
        if (panState) {
            panState = null;
            timelineWrap.classList.remove('tm-tl-panning');
            return;
        }
        if (rulerScrub) {
            const { wasPlaying } = rulerScrub;
            rulerScrub = null;
            hideReadout();
            if (wasPlaying && video?.paused) video.play();
            return;
        }
        if (drawDraft) {
            const { start, end, startX } = drawDraft;
            drawDraft = null;
            snapGuide = null;
            document.body.style.userSelect = '';
            hideReadout();
            if (Math.abs(e.clientX - startX) < 4 || end - start < MIN_CUE_DUR) {
                seekFromTimeline(clampToTrack(timeAtClientX(e.clientX)));
            } else {
                createCueAt(start, end);
            }
            scheduleRulerRedraw();
        }
    });

    // Hover: a guide line and the timecode under the pointer.
    timelineScroll.addEventListener('mousemove', e => {
        if (rulerScrub || dragState || drawDraft || panState) return;
        const x = e.clientX - timelineScroll.getBoundingClientRect().left;
        const t = timeAtClientX(e.clientX);
        timelineWrap.classList.add('tm-tl-hovering');
        if (timelineHover) timelineHover.style.transform = `translate3d(${x}px,0,0)`;
        const region = peaks && TmWaveform.regionAt(peaks, t);
        showReadout(tcLabel(clampToTrack(t)) + (region ? ' · dialogue' : ''), x);
    });
    timelineScroll.addEventListener('mouseleave', () => {
        timelineWrap.classList.remove('tm-tl-hovering');
        if (!rulerScrub && !dragState && !drawDraft) hideReadout();
    });

    // Wheel: Ctrl/⌘ zooms about the pointer; otherwise the strip pans (and
    // while playing, the wheel jogs the video instead).
    timelineScroll.addEventListener('wheel', e => {
        e.preventDefault();
        const x = e.clientX - timelineScroll.getBoundingClientRect().left;
        if (e.ctrlKey || e.metaKey) {
            zoomAt(pxPerSecond * Math.pow(1.0018, -e.deltaY), timeAtClientX(e.clientX), x);
            return;
        }
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        panBy(delta / pxPerSecond);
    }, { passive: false });

    timelineScroll.addEventListener('dblclick', e => {
        const block = e.target.closest?.('.tm-timeline-block');
        if (!block) return;
        const id = Number(block.dataset.id);
        selectEvent(id, { scrollBlock: 'center', focusTranslation: true });
    });

    // Overview bar: press or drag to travel.
    const ov = document.getElementById('timelineOverview');
    const travel = clientX => {
        const r = ov.getBoundingClientRect();
        const t = clampToTrack((clientX - r.left) / r.width * timelineSpan());
        if (playing()) seekTo(t);
        else { stopGlide(); viewCentre = t; scheduleRulerRedraw(); }
    };
    ov?.addEventListener('mousedown', e => { if (e.button === 0) { overviewDrag = true; travel(e.clientX); e.preventDefault(); } });
    document.addEventListener('mousemove', e => { if (overviewDrag) travel(e.clientX); });
    document.addEventListener('mouseup', () => { overviewDrag = false; });
}

/* Dragging past the edge of the strip carries the view along, so a cue can
   be dragged or drawn further than one screen. */
function autoPanNearEdge(clientX) {
    if (playing()) return;
    const rect = timelineScroll.getBoundingClientRect();
    const zone = 36;
    const left = clientX - rect.left, right = rect.right - clientX;
    const speed = 8 / pxPerSecond;
    if (left < zone) { stopGlide(); viewCentre -= speed * (1 + (zone - left) / 8); scheduleRulerRedraw(); }
    else if (right < zone) { stopGlide(); viewCentre += speed * (1 + (zone - right) / 8); scheduleRulerRedraw(); }
}

// ── Blocks: select, drag, resize ─────────────────────
function handleBlockSelect(e, id, { seek = true } = {}) {
    // Work the new selection out first and apply it only after selectEvent:
    // selectEvent collapses whichever cue is open by comparing against
    // activeId, so setting activeId beforehand left the old card open too.
    let nextSel, nextActive;
    if (e.shiftKey && activeId != null) {
        const ids = events.map(ev => ev.id);
        const a = ids.indexOf(activeId), b = ids.indexOf(id);
        const [lo, hi] = a < b ? [a, b] : [b, a];
        nextSel = new Set(ids.slice(lo, hi + 1));
        nextActive = id;
    } else if (e.ctrlKey || e.metaKey) {
        nextSel = new Set(selectedIds);
        if (nextSel.has(id)) { nextSel.delete(id); nextActive = nextSel.size ? [...nextSel].pop() : null; }
        else { nextSel.add(id); nextActive = id; }
    } else if (!selectedIds.has(id) || selectedIds.size <= 1) {
        nextSel = new Set([id]);
        nextActive = id;
    } else {
        nextSel = new Set(selectedIds);   // pressing inside a multi-selection keeps it, to move it as a group
        nextActive = id;
    }
    const ev = events.find(x => x.id === id);
    if (seek && video && ev) seekFromTimeline(tcToSecs(ev.startTime));
    // Open the clicked cue in the panel too, so the timeline and the cue list
    // never disagree about what is being edited. A range or toggle selection
    // keeps its extra members; selectEvent would collapse them to one.
    if (nextActive != null) selectEvent(nextActive, { scrollBlock: 'nearest' });
    selectedIds = nextSel;
    activeId = nextActive;
    updateSelection();
    scheduleRulerRedraw();
}

function onBlockMouseDown(e, block) {
    if (e.button !== 0) return;
    const id = Number(block.dataset.id);
    const handle = e.target.closest('.tm-block-handle');
    const mode = handle ? (handle.classList.contains('tm-block-handle-left') ? 'resize-left' : 'resize-right') : 'move';
    handleBlockSelect(e, id, { seek: false });
    if (e.shiftKey || e.ctrlKey || e.metaKey) return;   // selection gestures, not drags
    startDrag(e, id, mode);
}

/* Snapping, strongest first: shot changes, then where the dialogue starts
   and stops, then other cues (and the minimum gap beside them), then the
   playhead, and finally the frame grid. `edge` says which end of a cue is
   moving, because the right spot near a cut differs: in-times go on the cut,
   out-times a couple of frames before it. */
function snapValue(t, excludeIds, edge = 'in') {
    snapGuide = null;
    if (!snapEnabled) return t;
    const frame = 1 / fps;
    const reach = SNAP_PX / pxPerSecond;
    const candidates = [];
    const add = (value, kind, weight = 1) => {
        if (Number.isFinite(value)) candidates.push({ value, kind, d: Math.abs(value - t) / weight });
    };

    if (snapToCuts && shotCuts.length && typeof TmShots !== 'undefined') {
        const c = TmShots.nearest(shotCuts, t);
        if (c != null) {
            if (edge !== 'out') add(c, 'cut', 1.6);
            if (edge !== 'in') add(c - OUT_BEFORE_CUT_FRAMES * frame, 'cut', 1.6);
        }
    }
    if (snapToAudio && peaks) {
        const s = TmWaveform.nearestEdge(peaks, t, reach * 2);
        if (s != null) add(s, 'speech', 1.2);
    }
    const minGap = deliveryProfile?.minGapSeconds ?? 0;
    for (const ev of events) {
        if (excludeIds.includes(ev.id)) continue;
        const s = tcToSecs(ev.startTime), e = tcToSecs(ev.endTime);
        if (Math.abs(s - t) > reach * 3 && Math.abs(e - t) > reach * 3) continue;
        add(s, 'cue'); add(e, 'cue');
        if (minGap > 0) { add(s - minGap, 'gap'); add(e + minGap, 'gap'); }
    }
    if (video) add(video.currentTime, 'playhead');

    let best = null;
    for (const c of candidates) if (c.d <= reach && (!best || c.d < best.d)) best = c;
    if (best) { snapGuide = { t: best.value, kind: best.kind }; return best.value; }
    return Math.round(t / frame) * frame;
}

function blockLabelHtml(ev, i) {
    const start = tcToSecs(ev.startTime), end = tcToSecs(ev.endTime);
    const dur = Math.max(0, end - start);
    const text = ev.translatedText || '';
    const cps = text.trim() ? readingSpeed(text, ev.startTime, ev.endTime) : null;
    return `<span class="tm-block-num">${i + 1}</span><span class="tm-block-meta">${dur.toFixed(2)}s${cps != null ? ' · ' + cps + ' cps' : ''}</span>`;
}

function blockTitle(ev, i, issues) {
    const notes = shotNotes(ev).map(n => n.text);
    const snippet = (ev.translatedText || ev.originalText || '').replace(/\s+/g, ' ').trim();
    return `#${i + 1}  ${ev.startTime} → ${ev.endTime}`
        + (snippet ? `\n${snippet.slice(0, 120)}` : '')
        + (issues.length ? `\n⚠ ${issues.join(', ')}` : '')
        + (notes.length ? `\n⚠ ${notes.join('; ')}` : '')
        + (lockedIds.has(ev.id) ? '\nLocked' : '');
}

function blockStatusClass(ev, issues) {
    // "Untranslated" is a workflow state, not a timing defect — it shouldn't
    // paint a cue as a warning the moment it's created.
    const hasRealIssue = issues.some(s => s !== 'Untranslated') || shotNotes(ev).length > 0;
    return issues.includes('Invalid timing') ? ' tm-timeline-block-invalid'
        : issues.includes('Overlapping cues') ? ' tm-timeline-block-overlap'
        : hasRealIssue ? ' tm-timeline-block-warn'
        : ev.translatedText?.trim() ? ' tm-timeline-block-done'
        : ' tm-timeline-block-empty';
}

function fillBlock(block, ev, i) {
    const start = tcToSecs(ev.startTime), end = tcToSecs(ev.endTime);
    const origin = renderedWindow ? renderedWindow.origin : 0;
    const width = Math.max((end - start) * pxPerSecond, 2);
    const issues = issuesAt(i);
    const isLocked = lockedIds.has(ev.id);
    block.className = 'tm-timeline-block'
        + (ev.id === activeId ? ' tm-timeline-block-active' : '')
        + (selectedIds.has(ev.id) && ev.id !== activeId ? ' tm-timeline-block-selected' : '')
        + blockStatusClass(ev, issues)
        + (isLocked ? ' tm-timeline-block-locked' : '')
        + (width < 26 ? ' tm-timeline-block-tiny' : width < 70 ? ' tm-timeline-block-narrow' : '');
    block.style.left = ((start - origin) * pxPerSecond) + 'px';
    block.style.width = width + 'px';
    block.dataset.id = ev.id;
    block.title = blockTitle(ev, i, issues);

    const translated = (ev.translatedText || '').trim();
    const body = translated || (ev.originalText || '').trim();
    block.innerHTML =
        `<div class="tm-block-head">${blockLabelHtml(ev, i)}${isLocked ? '<i class="bi bi-lock-fill tm-block-lock-icon"></i>' : ''}</div>`
        + (showBlockText ? `<div class="tm-block-text${translated ? '' : ' tm-block-text-src'}" dir="auto">${escapeHtml(body)}</div>` : '')
        + (isLocked ? '' : '<div class="tm-block-handle tm-block-handle-left"></div><div class="tm-block-handle tm-block-handle-right"></div>');
}

/* Renders the blocks within a window around the view — the view plus a full
   screen either side — rather than every cue in the film. Panning inside that
   window costs nothing but a transform; leaving it re-renders. */
function renderTimelineBlocks() {
    if (!timelineEvents) return;
    const W = viewWidth() || 1200;
    const span = W / pxPerSecond;
    const t0 = viewStartSecs();
    const from = t0 - span, to = t0 + span * 2;
    renderedWindow = { from, to, origin: from, pps: pxPerSecond };
    timelineEvents.innerHTML = '';
    events.forEach((ev, i) => {
        const start = tcToSecs(ev.startTime), end = tcToSecs(ev.endTime);
        if (end < from || start > to) return;
        const block = document.createElement('div');
        fillBlock(block, ev, i);
        timelineEvents.appendChild(block);
    });
    if (timelineInner) timelineInner.style.transform = `translate3d(${(from - t0) * pxPerSecond}px,0,0)`;
}

function ensureBlocksRendered() {
    const W = viewWidth();
    if (!W) return;
    const t0 = viewStartSecs(), t1 = t0 + W / pxPerSecond;
    if (!renderedWindow || renderedWindow.pps !== pxPerSecond
        || t0 < renderedWindow.from || t1 > renderedWindow.to) {
        renderTimelineBlocks();
    }
}

function updateBlockDom(id) {
    const i = events.findIndex(x => x.id === id);
    const ev = events[i];
    if (!ev) return;
    const block = timelineEvents?.querySelector?.(`.tm-timeline-block[data-id="${id}"]`);
    if (block) {
        fillBlock(block, ev, i);
    }
    const startInput = eventsList.querySelector(`.tm-tc-input[data-id="${id}"][data-field="startTime"]`);
    const endInput   = eventsList.querySelector(`.tm-tc-input[data-id="${id}"][data-field="endTime"]`);
    if (startInput) startInput.value = ev.startTime;
    if (endInput)   endInput.value   = ev.endTime;
}

/* Where a dragged cue has to stop: the nearest cue before and after it that
   is not part of the drag. A cue already overlapping its neighbour is left
   unconstrained on that side, or it could never be dragged clear. */
function dragLimits(ids, origStart, origEnd) {
    let lo = 0, hi = Infinity;
    if (overlapsAllowed()) return { lo, hi };
    for (const ev of events) {
        if (ids.includes(ev.id)) continue;
        const s = tcToSecs(ev.startTime), e = tcToSecs(ev.endTime);
        if (e <= origStart + 1e-6 && e > lo) lo = e;
        if (s >= origEnd - 1e-6 && s < hi) hi = s;
    }
    return { lo, hi };
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
        if (ev) orig.set(tid, { start: tcToSecs(ev.startTime), end: tcToSecs(ev.endTime) });
    });
    const groupStart = Math.min(...[...orig.values()].map(o => o.start));
    const groupEnd = Math.max(...[...orig.values()].map(o => o.end));
    dragState = {
        mode, ids: [...orig.keys()], primaryId: id, orig,
        startX: e.clientX, startT: timeAtClientX(e.clientX), moved: false,
        limits: dragLimits([...orig.keys()], groupStart, groupEnd),
        groupStart, groupEnd,
    };
    document.body.style.userSelect = 'none';
    timelineWrap.classList.add('tm-tl-dragging');
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
}

function onDragMove(e) {
    if (!dragState) return;
    const { mode, ids, orig, primaryId, limits } = dragState;
    if (!dragState.moved && Math.abs(e.clientX - dragState.startX) < 3) return;
    dragState.moved = true;
    autoPanNearEdge(e.clientX);
    const delta = timeAtClientX(e.clientX) - dragState.startT;
    const minDur = MIN_CUE_DUR;
    const p = orig.get(primaryId);
    let readoutT;

    if (mode === 'move') {
        // Snap whichever end of the primary cue lands closer to something.
        const sIn = snapValue(p.start + delta, ids, 'in');
        const gIn = snapGuide;
        const sOut = snapValue(p.end + delta, ids, 'out');
        const gOut = snapGuide;
        let d = delta;
        if (gIn && (!gOut || Math.abs(sIn - (p.start + delta)) <= Math.abs(sOut - (p.end + delta)))) { d = sIn - p.start; snapGuide = gIn; }
        else if (gOut) { d = sOut - p.end; snapGuide = gOut; }
        else d = sIn - p.start;
        // Keep the whole group inside its free stretch of track.
        d = Math.max(d, limits.lo - dragState.groupStart, -dragState.groupStart);
        d = Math.min(d, limits.hi - dragState.groupEnd);
        ids.forEach(id => {
            const o = orig.get(id);
            const ev = events.find(x => x.id === id);
            ev.startTime = secsToSrtTc(o.start + d);
            ev.endTime = secsToSrtTc(o.end + d);
            updateBlockDom(id);
        });
        readoutT = p.start + d;
    } else if (mode === 'resize-left') {
        const ev = events.find(x => x.id === primaryId);
        let s = snapValue(p.start + delta, ids, 'in');
        s = Math.max(limits.lo, 0, Math.min(s, p.end - minDur));
        if (snapGuide && Math.abs(snapGuide.t - s) > 1e-6) snapGuide = null;
        ev.startTime = secsToSrtTc(s);
        updateBlockDom(primaryId);
        readoutT = s;
    } else {
        const ev = events.find(x => x.id === primaryId);
        let en = snapValue(p.end + delta, ids, 'out');
        en = Math.min(limits.hi, Math.max(en, p.start + minDur));
        if (snapGuide && Math.abs(snapGuide.t - en) > 1e-6) snapGuide = null;
        ev.endTime = secsToSrtTc(en);
        updateBlockDom(primaryId);
        readoutT = en;
    }

    // The new timing, by number, right beside the edge being moved.
    const primary = events.find(x => x.id === primaryId);
    if (primary) {
        const s = tcToSecs(primary.startTime), en = tcToSecs(primary.endTime);
        const cps = primary.translatedText?.trim() ? ` · ${readingSpeed(primary.translatedText, primary.startTime, primary.endTime)} cps` : '';
        const snapNote = snapGuide ? ` · <i>${snapGuide.kind}</i>` : '';
        showReadout(`<b>${tcLabel(s)}</b> → <b>${tcLabel(en)}</b> · ${(en - s).toFixed(2)}s${cps}${snapNote}`, xOfTime(readoutT));
    }
    scheduleRulerRedraw();
}

function onDragEnd() {
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
    document.body.style.userSelect = '';
    timelineWrap.classList.remove('tm-tl-dragging');
    hideReadout();
    snapGuide = null;
    if (dragState) {
        const { moved, primaryId } = dragState;
        const changed = moved && dragState.ids.some(id => {
            const o = dragState.orig.get(id);
            const ev = events.find(x => x.id === id);
            return Math.abs(tcToSecs(ev.startTime) - o.start) > 0.0005 || Math.abs(tcToSecs(ev.endTime) - o.end) > 0.0005;
        });
        if (changed) { markDirty(); renderEvents(); renderTimelineBlocks(); }
        else if (!moved) {
            // A click, not a drag: put the playhead on the cue.
            const ev = events.find(x => x.id === primaryId);
            if (ev) seekFromTimeline(tcToSecs(ev.startTime));
        }
    }
    dragState = null;
    scheduleRulerRedraw();
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

    let card;
    if (expandedView) {
        card = moveOpenCard(previous, id);
    } else {
        if (previous !== id && previous != null) refreshCue(previous, { keepCaret: false });
        card = refreshCue(id, { keepCaret: false });
    }
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
                   + (isLocked ? '<i class="bi bi-lock-fill" title="Locked"></i>' : '')
                   + (typeof TmWorkspace !== 'undefined' ? TmWorkspace.rowMarks(ev) : '');
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

// Language tags for the text boxes, so the browser's spellchecker (and
// screen readers) use the right language for each side.
const LANG_CODES = (() => {
    const map = { english: 'en', arabic: 'ar', french: 'fr', spanish: 'es', german: 'de', italian: 'it', portuguese: 'pt', turkish: 'tr',
                  russian: 'ru', chinese: 'zh', japanese: 'ja', korean: 'ko', hindi: 'hi', urdu: 'ur', persian: 'fa', farsi: 'fa', hebrew: 'he', dutch: 'nl' };
    const meta = typeof document !== 'undefined' ? document.getElementById('projectMeta')?.dataset : null;
    const code = name => map[String(name || '').trim().toLowerCase()] || '';
    return { source: code(meta?.source), target: code(meta?.target) };
})();

function cueCardHtml(ev, i, open = true) {
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

    return `<div class="tm-cue-item tm-event-card ${open ? 'tm-cue-item-open' : 'tm-cue-item-expanded'}${isLocked ? ' tm-event-locked' : ''}" data-id="${ev.id}">
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
        <button class="tm-icon-btn-sm tm-marks-btn${(ev.flags | 0) || ev.bookmarked ? ' tm-marks-btn-has' : ''}" data-id="${ev.id}" type="button"
                title="Marks: needs translation / timing / review, question, bookmark, review state" aria-haspopup="dialog"><i class="bi bi-flag${(ev.flags | 0) ? '-fill' : ''}"></i></button>
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
            <textarea dir="auto" lang="${LANG_CODES.source}" aria-label="Cue ${i + 1} source text" class="tm-original-input"
                      placeholder="Import a script or type original text…"
                      data-field="originalText" data-id="${ev.id}" disabled>${escapeHtml(ev.originalText || '')}</textarea>
        </div>
        <div class="tm-event-col tm-event-col-translation">
            <div class="tm-col-label tm-col-label-translation">
                <span><i class="bi bi-pencil-fill"></i> Translation</span>
                <span class="tm-char-counter">${charCountDisplay(ev.translatedText || '')}</span>
            </div>
            <textarea dir="auto" lang="${LANG_CODES.target}" spellcheck="true" aria-label="Cue ${i + 1} translation" class="tm-translated-input ${charCountClass(ev.translatedText || '')}"
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

// Expanded view opens every cue as a full card, for translators who would
// rather scroll through editable lines than click each row open. The cue
// being worked on is still marked as the open card.
const EXPANDED_KEY = 'tm-expanded-view';
let expandedView = (() => {
    try { return localStorage.getItem(EXPANDED_KEY) === '1'; }
    catch { return false; }
})();

function cueHtml(ev, i) {
    if (ev.id === activeId) return cueCardHtml(ev, i);
    return expandedView ? cueCardHtml(ev, i, false) : cueRowHtml(ev, i);
}

function paintExpandedToggle() {
    document.querySelector('.tm-editor-right')?.classList.toggle('tm-expanded-view', expandedView);
    const button = document.getElementById('btnExpandedView');
    if (!button) return;
    button.setAttribute('aria-pressed', String(expandedView));
    button.classList.toggle('tm-toggle-on', expandedView);
    button.title = expandedView ? 'Switch to compact rows' : 'Expand every cue into a full editing card';
    button.setAttribute('aria-label', button.title);
    const icon = button.querySelector('i');
    if (icon) icon.className = expandedView ? 'bi bi-list' : 'bi bi-arrows-expand';
}

function setExpandedView(on) {
    expandedView = on;
    try { localStorage.setItem(EXPANDED_KEY, on ? '1' : '0'); }
    catch { /* storage unavailable; the choice just will not persist */ }
    paintExpandedToggle();
    renderEvents();
    const card = eventsList.querySelector('.tm-cue-item-open');
    if (card) scrollCardInList(card, 'center');
}

// In expanded view every cue is already a card, so changing the selection
// only moves the "open" marking. Rebuilding the card would throw away the
// caret of a translator who just clicked into it.
function moveOpenCard(fromId, toId) {
    if (fromId != null && fromId !== toId) {
        const from = eventsList.querySelector(`.tm-cue-item[data-id="${fromId}"]`);
        if (from) {
            from.classList.replace('tm-cue-item-open', 'tm-cue-item-expanded');
            from.style.maxHeight = '';
            from.style.overflowY = '';
            from.querySelectorAll('textarea').forEach(box => { box.style.height = ''; box.style.overflowY = ''; });
            const hint = from.querySelector('.tm-quality-hint');
            if (hint) hint.textContent = '';
        }
    }
    const to = eventsList.querySelector(`.tm-cue-item[data-id="${toId}"]`);
    if (to && !to.classList.contains('tm-cue-row')) {
        to.classList.replace('tm-cue-item-expanded', 'tm-cue-item-open');
        return to;
    }
    return refreshCue(toId, { keepCaret: false });
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
    if (typeof TmWorkspace !== 'undefined' && !fresh.classList.contains('tm-cue-row')) TmWorkspace.paintCardHint(fresh, idx);
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

// In expanded view any card can be typed into; doing so makes it the
// selected cue, so the overlay, timeline and quality hint follow along.
eventsList.addEventListener('focusin', e => {
    if (!expandedView || !e.target.matches('input, textarea, select')) return;
    const id = cueIdFromEvent(e);
    if (id != null && id !== activeId) selectEvent(id);
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
        updateBlockDom(id);
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

// A new line goes straight under the cue being worked on, timed into the gap
// after it, so a translator adding a missed line mid-film does not have to go
// find it at the bottom. With nothing selected it falls back to the playhead
// and the end of the track.
const NEW_CUE_SECS = 2;
const MIN_GAP_SECS = 0.5;

function newCueTiming(after, next) {
    if (!after) {
        const at = video ? video.currentTime : 0;
        return [at, at + NEW_CUE_SECS];
    }
    const start = tcToSecs(after.endTime);
    const nextStart = next ? tcToSecs(next.startTime) : Infinity;
    // Fill the gap up to the next cue when there is room; otherwise take the
    // default length and let the overlap warning point it out.
    const end = nextStart - start >= MIN_GAP_SECS
        ? Math.min(start + NEW_CUE_SECS, nextStart)
        : start + NEW_CUE_SECS;
    return [start, end];
}

let nextTempId = -1;
btnAddEvent.addEventListener('click', () => {
    if (!translatorOnly()) return;
    if (!loaded) return;
    document.getElementById('cueSearch').value = '';
    document.getElementById('cueFilter').value = 'all';
    const at    = events.findIndex(x => x.id === activeId);
    const after = at >= 0 ? events[at] : null;
    const [start, end] = newCueTiming(after, events[at + 1]);
    const ev    = {
        id: nextTempId--,
        index: at >= 0 ? at + 2 : events.length + 1,
        startTime: secsToSrtTc(start),
        endTime: secsToSrtTc(end),
        originalText: '',
        translatedText: '',
        originalLocked: false // typed by hand, not imported — stays editable
    };
    if (after) events.splice(at + 1, 0, ev);
    else events.push(ev);
    activeId = ev.id;
    selectedIds = new Set([ev.id]);
    markDirty();
    renderEvents();
    renderTimelineBlocks();
    selectEvent(ev.id, { scrollBlock: 'center', focusTranslation: true });
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
    // A state that explains why nothing is reaching the server outranks the
    // plain "unsaved" note, which would hide the real problem.
    if (!['offline', 'auth', 'stale', 'forbidden'].includes(saveState)) paintSaveState('unsaved');
    if (typeof TmWorkspace !== 'undefined') TmWorkspace.onEdited?.();
    clearTimeout(autoSaveTimer);
    if (!revisionStale) autoSaveTimer = setTimeout(() => doSave(), 2000);
}

// The server matches cues to stored rows by id. A new cue goes up with a
// negative temporary id and comes back with the row it became, which the
// editor adopts so the next save updates that row instead of adding the line
// again. The map outlives the swap because undo snapshots and a recovered
// draft can still hold the temporary id.
const storedIds = new Map();
const storedIdFor = id => storedIds.get(id) ?? id;

function adoptStoredIds(assigned) {
    for (const { temp, id } of assigned) {
        if (typeof temp !== 'number' || typeof id !== 'number') continue;
        storedIds.set(temp, id);
        const ev = events.find(x => x.id === temp);
        if (!ev) continue;
        ev.id = id;
        if (activeId === temp) activeId = id;
        if (selectedIds.delete(temp)) selectedIds.add(id);
        if (lockedIds.delete(temp)) { lockedIds.add(id); saveLocked(); }
        // Relabel rather than re-render, so a translator typing in the card
        // keeps the caret.
        document.querySelectorAll(`[data-id="${temp}"]`).forEach(node => { node.dataset.id = String(id); });
    }
}

// Temporary ids must not collide with any already in play, such as those in a
// draft recovered from a previous visit.
function reserveTempIds() {
    for (const ev of events) if (typeof ev.id === 'number' && ev.id <= nextTempId) nextTempId = ev.id - 1;
}

// ── Working alongside the other seat ─────────────
// While a project is under review the translator and the revisor both have it
// open, and every save bumps the project revision — so each one's next save
// would be refused as stale, and the only way out used to be a reload that
// threw away whatever they had not saved yet.
//
// Most of those refusals are not real conflicts: each seat owns different
// fields of a cue, and the server only takes a seat's own fields. So a refused
// save is first merged three ways, field by field, against the version this
// editor last agreed with the server on (the baseline):
//   - a field only this editor changed keeps its local value;
//   - a field only the server changed takes the server's value;
//   - a field both changed, differently, is a real conflict, and the old
//     reload banner is shown instead of guessing.
// Lines added or removed on the server are taken as they are; only the
// translator can do that, so it never races the translator's own edits.

const CUE_FIELDS = ['startTime', 'endTime', 'originalText', 'translatedText', 'originalLocked',
    'comment', 'status', 'suggestedText', 'suggestionState', 'previousTranslatedText',
    'reviewFlag', 'reviewSeverity', 'reviewNote'];

let baseline = new Map();   // id → the cue as the server last had it

function rememberBaseline(serverEvents) {
    baseline = new Map((serverEvents || []).map(ev => [ev.id, { ...ev }]));
}

// null and '' are the same thing to the server (an empty note is stored as
// null), and timecodes are compared as time, not as text.
function sameValue(field, a, b) {
    if (field === 'startTime' || field === 'endTime') return Math.abs(tcToSecs(a) - tcToSecs(b)) < 0.0005;
    const norm = v => (v === undefined || v === null || v === '' ? null : v);
    return norm(a) === norm(b);
}

// Returns the merged track, or null when the two sides really disagree.
function mergeWithServer(local, server) {
    const serverById = new Map(server.map(ev => [ev.id, ev]));
    const merged = [];
    const localIds = new Set();

    for (const mine of local) {
        const id = storedIdFor(mine.id);
        localIds.add(id);
        const base = baseline.get(id);
        const theirs = serverById.get(id);
        if (id < 0 || !base) { merged.push(mine); continue; }    // new here
        if (!theirs) {
            // Deleted on the server. Keep it only if this editor changed it —
            // and then it is a conflict, because there is no row to put it in.
            if (CUE_FIELDS.some(f => !sameValue(f, mine[f], base[f]))) return null;
            continue;
        }
        const cue = { ...mine };
        for (const f of CUE_FIELDS) {
            const changedHere = !sameValue(f, mine[f], base[f]);
            const changedThere = !sameValue(f, theirs[f], base[f]);
            if (changedThere && !changedHere) cue[f] = theirs[f];
            else if (changedThere && changedHere && !sameValue(f, mine[f], theirs[f])) {
                // The revisor's box starts as a copy of the translation and the
                // server stores no suggestion when they match; that is not a
                // disagreement worth stopping for.
                if (f === 'suggestedText' && sameValue(f, mine[f], theirs.translatedText)) { cue[f] = theirs[f]; continue; }
                return null;
            }
        }
        merged.push(cue);
    }

    // Lines added on the server since the baseline, placed after the line
    // they follow there.
    server.forEach((ev, i) => {
        if (localIds.has(ev.id) || baseline.has(ev.id)) return;
        const before = server[i - 1];
        const at = before ? merged.findIndex(x => storedIdFor(x.id) === before.id) : -1;
        merged.splice(at + 1, 0, { ...ev });
    });
    return merged;
}

// Fetches the newer version, merges, and reports whether saving can go on.
let mergeAttempts = 0;
async function rebaseOnServer() {
    if (++mergeAttempts > 3) return false;   // keeps losing the race; let a person look
    try {
        const payload = await api(`/studio/${PROJECT_ID}/events`);
        if (!Array.isArray(payload?.events) || typeof payload.revision !== 'number') return false;
        const merged = mergeWithServer(events, payload.events);
        if (!merged) return false;

        const before = new Map(events.map(ev => [ev.id, JSON.stringify(ev)]));
        events = merged;
        loadedRevision = payload.revision;
        rememberBaseline(payload.events);
        reserveTempIds();
        invalidateIssues();
        // Redraw only what the merge changed, and never the card being typed
        // in (refreshCue leaves a focused card alone).
        const shapeChanged = merged.length !== before.size || merged.some(ev => !before.has(ev.id));
        if (shapeChanged) renderEvents();
        else merged.forEach(ev => { if (before.get(ev.id) !== JSON.stringify(ev)) refreshCue(ev.id); });
        renderTimelineBlocks();
        updateWorkspace();
        return true;
    } catch {
        return false;
    }
}

// ── Talking to the server ──────────────────────────
/* Every editor request goes through api(), which turns the many ways a
   request can fail into a few kinds the save logic can act on:
     offline  — the browser knows it has no network; nothing was sent
     network  — the request could not complete; it may or may not have landed
     timeout  — no answer in time; it may or may not have landed
     auth     — the sign-in expired (a 401, or a login page where JSON was due)
     forbidden, conflict, antiforgery, invalid, bad, server — as named
   "May or may not have landed" matters: such a save is re-sent with the same
   save id, which the server recognises (see SaveEvents), so a lost response
   can never turn into a duplicate or a conflict with itself. */
let csrfToken = document.querySelector('[name="__RequestVerificationToken"]')?.value || '';

class ApiError extends Error {
    constructor(kind, status = 0, data = null) {
        super(data?.message || kind);
        this.kind = kind;
        this.status = status;
        this.data = data;
    }
}

const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

async function api(path, { method = 'GET', body, timeout = 30000 } = {}) {
    const headers = { 'Accept': 'application/json', 'X-TraMslate-Api': '1' };
    if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['RequestVerificationToken'] = csrfToken;
    }
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;
    let res;
    try {
        res = await fetch(path, {
            method, headers, credentials: 'same-origin',
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: ctrl?.signal,
        });
    } catch (err) {
        throw new ApiError(isOffline() ? 'offline' : err?.name === 'AbortError' ? 'timeout' : 'network');
    } finally {
        if (timer) clearTimeout(timer);
    }
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (res.ok) {
        // A redirect to the login page arrives as 200 + HTML.
        if (data === null) throw new ApiError('auth', res.status);
        return data;
    }
    const kind = res.status === 401 ? 'auth'
        : res.status === 403 ? 'forbidden'
        : res.status === 409 ? 'conflict'
        : res.status === 422 ? 'invalid'
        : res.status === 400 && data === null ? 'antiforgery'
        : res.status >= 500 ? 'server'
        : 'bad';
    throw new ApiError(kind, res.status, data);
}

// After signing in again elsewhere, the token this page was rendered with
// belongs to the old session.
async function refreshToken() {
    try {
        const data = await api(`/studio/${PROJECT_ID}/token`);
        if (data?.token) { csrfToken = data.token; return true; }
    } catch { /* still signed out */ }
    return false;
}

const newSaveId = () => (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

// ── Save state ─────────────────────────────────────
/* The status shown next to Save. "Saved" is only ever shown when the server
   has confirmed the version on screen; anything else says what is true. */
let saveState     = 'loading';   // loading | saved | unsaved | saving | offline | failed | auth | stale | forbidden
let saveDetail    = '';
let lastSavedAt   = null;
let uncertainSave = null;        // { body, savedRevision } of a save whose outcome is unknown
let retryTimer    = null;
let retryIndex    = 0;
let localCopyOk   = true;        // false once this browser refused a recovery copy
const RETRY_DELAYS = [2, 5, 15, 30, 60];

const SAVE_LABELS = {
    loading:   'Loading…',
    saved:     'All changes saved',
    unsaved:   '● Unsaved changes',
    saving:    'Saving…',
    offline:   'Offline — kept in this browser only',
    failed:    'Save failed — retry Save',
    auth:      'Signed out — kept in this browser only',
    stale:     'Not saved — newer version on the server',
    forbidden: 'Not saved — you no longer have access',
};
const SAVE_CLASSES = {
    loading: 'tm-save-saving', saved: 'tm-save-ok', unsaved: 'tm-save-unsaved', saving: 'tm-save-saving',
    offline: 'tm-save-error', failed: 'tm-save-error', auth: 'tm-save-error', stale: 'tm-save-error', forbidden: 'tm-save-error',
};

function clockTime(when) {
    const d = when instanceof Date ? when : new Date(when);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function paintSaveState(state = saveState, detail = '') {
    saveState = state;
    saveDetail = detail;
    let text = detail || SAVE_LABELS[state] || state;
    if (state === 'saved' && lastSavedAt) text += ` · ${clockTime(lastSavedAt)}`;
    if (!localCopyOk && state !== 'saved') text += ' (no local copy)';
    saveStatus.textContent = text;
    saveStatus.className = 'tm-save-status ' + (SAVE_CLASSES[state] || '');
    saveStatus.title = lastSavedAt
        ? `Last saved to the server at ${new Date(lastSavedAt).toLocaleString()}`
        : 'Not saved to the server yet in this session';
    if (typeof TmWorkspace !== 'undefined') TmWorkspace.onSaveState?.(state);
}

function scheduleRetry() {
    clearTimeout(retryTimer);
    const delay = RETRY_DELAYS[Math.min(retryIndex, RETRY_DELAYS.length - 1)];
    retryIndex++;
    paintSaveState('failed', `Save failed — retrying in ${delay}s`);
    retryTimer = setTimeout(() => doSave(), delay * 1000);
}

// ── Saving ─────────────────────────────────────────
function cueForServer(ev) {
    return {
        ...ev,
        id: storedIdFor(ev.id),
        startTime: secsToSrtTc(tcToSecs(ev.startTime)),
        endTime: secsToSrtTc(tcToSecs(ev.endTime)),
        waiversJson: Array.isArray(ev.waivers) && ev.waivers.length ? JSON.stringify(ev.waivers) : (ev.waiversJson ?? null),
    };
}

function buildSaveBody(checkpoint) {
    const body = {
        revision: loadedRevision,
        saveId: newSaveId(),
        events: events.map(cueForServer),
    };
    if (typeof CAN_EDIT_TRANSLATION === 'undefined' || CAN_EDIT_TRANSLATION) body.settingsJson = JSON.stringify(projectSettings());
    if (checkpoint) body.checkpoint = checkpoint;
    return body;
}

/* Saves the current track. Resolves true once the version on screen (or at
   least the one that was on screen when this save started) is on the server.
   Only one save is ever in flight, so saves cannot finish out of order. */
async function doSave({ manual = false, checkpoint = null } = {}) {
    if (!loaded || saving || revisionStale) return false;
    clearTimeout(retryTimer);
    saving = true;
    let ok = false;
    try {
        // Settle a save whose answer never came before building on it.
        if (uncertainSave) {
            const settled = await sendSave(uncertainSave.body, uncertainSave.savedRevision);
            if (!settled) return false;
        }
        if (!isDirty && !checkpoint) {
            if (manual && lastSavedAt) paintSaveState('saved');
            ok = true;
            return true;
        }
        const savedRevision = revision;
        ok = await sendSave(buildSaveBody(checkpoint), savedRevision);
        return ok;
    } finally {
        saving = false;
        if (ok && isDirty && !revisionStale) { clearTimeout(autoSaveTimer); autoSaveTimer = setTimeout(doSave, 1000); }
        // Anything that depends on "a save is in flight" (Done) looks again
        // now that none is.
        if (typeof TmWorkspace !== 'undefined') TmWorkspace.onSaveState?.(saveState);
    }
}

async function sendSave(body, savedRevision) {
    paintSaveState('saving');
    let data;
    try {
        data = await api(`/studio/${PROJECT_ID}/save`, { method: 'POST', body, timeout: 45000 });
    } catch (err) {
        return saveFailed(err, body, savedRevision);
    }
    if (!data?.success) return saveFailed(new ApiError('server', 200, data), body, savedRevision);

    uncertainSave = null;
    retryIndex = 0;
    if (Array.isArray(data.assigned)) adoptStoredIds(data.assigned);
    if (Array.isArray(data.events)) rememberBaseline(data.events);
    mergeAttempts = 0;
    if (typeof data.revision === 'number') { loadedRevision = data.revision; announceSave(data.revision); }
    lastSavedAt = data.savedAt ? new Date(data.savedAt) : new Date();
    isDirty = revision !== savedRevision;
    if (data.status) paintProjectStatus(data.status);
    if (typeof TmWorkspace !== 'undefined') TmWorkspace.onSaved?.(data);
    // The server copy is now authoritative for everything saved, so the
    // local draft is only worth keeping if edits arrived mid-flight.
    if (isDirty) writeDraft(); else clearDraft();
    hideBannerFor('save');
    paintSaveState(isDirty ? 'unsaved' : 'saved');
    return true;
}

async function saveFailed(err, body, savedRevision) {
    isDirty = true;
    writeDraft();
    switch (err.kind) {
        case 'conflict':
            // Someone else saved after this editor loaded. Most of the time
            // they changed other fields and a merge settles it; otherwise both
            // versions are kept and the translator chooses.
            uncertainSave = null;
            if (await rebaseOnServer()) {
                paintSaveState('saving', IS_REVISOR ? 'Merged the translator\'s changes — saving…' : 'Merged the revisor\'s changes — saving…');
                revision++;
                return true;   // doSave's finally sees the track dirty and saves again
            }
            enterConflict();
            return false;
        case 'antiforgery':
            if (!body.__tokenRetried && await refreshToken()) {
                body.__tokenRetried = true;
                return sendSave(body, savedRevision);
            }
            paintSaveState('auth');
            showBanner('Your session changed, so this save was refused. Your work is kept in this browser. Reload the page after signing in to continue.',
                'danger', [{ label: 'Retry', run: () => doSave() }], 'save');
            return false;
        case 'auth':
            paintSaveState('auth');
            showBanner('Your sign-in has expired. Nothing is lost — your work is kept in this browser. Sign in again in another tab, then press Retry here.',
                'danger', [
                    { label: 'Sign in (new tab)', run: () => window.open('/login', '_blank') },
                    { label: 'Retry', run: async () => { await refreshToken(); doSave(); } },
                ], 'save');
            return false;
        case 'forbidden':
            paintSaveState('forbidden');
            showBanner('The server refused this save: you no longer have access to this project. Your work is kept in this browser — export it so it is not lost.',
                'danger', [{ label: 'Export SRT', run: () => btnExportSrt.click() }], 'save');
            return false;
        case 'offline':
            paintSaveState('offline');
            return false;   // the 'online' event retries
        case 'bad':
        case 'invalid':
            uncertainSave = null;
            paintSaveState('failed', 'Save refused — see the message above');
            showBanner(`The server refused this save: ${err.data?.message || 'the request was not accepted.'} Your work is kept in this browser.`,
                'danger', [{ label: 'Retry', run: () => doSave() }], 'save');
            return false;
        default:
            // network, timeout, server: it may have landed. Re-send the exact
            // same request (same save id) before anything else.
            uncertainSave = { body, savedRevision };
            scheduleRetry();
            return false;
    }
}

/* Two real versions exist. Neither is thrown away: this editor's version is
   stored on the server as a conflict copy (and stays in the local draft), the
   server's stays as it is, and the person chooses. */
function enterConflict() {
    revisionStale = true;
    clearTimeout(autoSaveTimer);
    paintSaveState('stale');
    keepCheckpoint(6, 'Your version when a save conflicted');
    showBanner(
        'Someone saved this project after you opened it, and you both changed the same lines, so your changes were not saved. '
        + 'Both versions are kept — compare them and choose.',
        'danger',
        [
            { label: 'Compare versions', run: () => (typeof TmWorkspace !== 'undefined' ? TmWorkspace.openConflict() : location.reload()) },
            { label: 'Export SRT', run: () => btnExportSrt.click() },
            { label: 'Reload', run: () => { clearDraft(); location.reload(); } },
        ], 'save');
}

/* Stores the current track on the server as a recovery copy without saving
   it over the project. Used before imports, bulk changes and restores, and
   when a save conflicts. Best-effort: a failure leaves the local draft. */
async function keepCheckpoint(kind, label, cues = events) {
    try {
        await api(`/studio/${PROJECT_ID}/checkpoint`, {
            method: 'POST',
            body: { kind, label, revision: loadedRevision, events: cues.map(cueForServer), settingsJson: JSON.stringify(projectSettings()) },
        });
        return true;
    } catch {
        return false;
    }
}

if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('online', () => {
        if (loaded && (isDirty || uncertainSave) && !revisionStale) doSave();
    });
    window.addEventListener('offline', () => {
        if (loaded && (isDirty || saving)) paintSaveState('offline');
    });
}

btnSave.addEventListener('click', () => {
    clearTimeout(autoSaveTimer);
    doSave({ manual: true });
});

// ══════════════════════════════════════════════════
//  IMPORT SCRIPT (SRT / VTT)
// ══════════════════════════════════════════════════

// Only the translator's page renders the import control.
importScript?.addEventListener('change', async () => {
    const file = importScript.files[0];
    if (!file || !loaded) return;
    // The previewing importer (transfer.js) replaces the direct one below,
    // which stays as the fallback where that script is absent.
    if (typeof TmTransfer !== 'undefined') { importScript.value = ''; TmTransfer.importFile(file); return; }
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
    if (typeof TmTransfer !== 'undefined') { TmTransfer.openExport('srt'); return; }
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
    if (typeof TmTransfer !== 'undefined') { TmTransfer.openExport('vtt'); return; }
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
    // The profile is project data now, saved with the cues.
    if (loaded) markDirty();
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
            // The version these edits were made on top of, so a draft found
            // after someone else saved can be merged rather than guessed at.
            base: [...baseline.values()],
            settings: projectSettings(),
        }));
        if (!localCopyOk) { localCopyOk = true; paintSaveState(saveState, saveDetail); }
    } catch {
        // Storage full or blocked (private window). The server is still the
        // real safety net, but the person must know there is no local copy.
        if (localCopyOk) {
            localCopyOk = false;
            paintSaveState(saveState, saveDetail);
            showBanner('This browser refused to keep a recovery copy (storage full or blocked). Work is only safe once it reaches the server — keep an eye on the save status.', 'warn');
        }
    }
}

// Write the recovery copy now, not after the debounce, when the page may be
// about to disappear (tab closed, navigated away, phone locked).
if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('pagehide', () => { if (isDirty) writeDraft(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && isDirty) writeDraft(); });
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

// ── Recovering unsaved work ───────────────────────
// What changed between two versions of the track, for previews: counts plus
// a few concrete examples a person can recognise.
function diffSummary(before, after) {
    const byId = new Map(before.map(ev => [ev.id, ev]));
    const seen = new Set();
    const samples = [];
    let changed = 0, added = 0;
    const fields = [['translatedText', 'Translation'], ['originalText', 'Source'], ['startTime', 'In'], ['endTime', 'Out'], ['comment', 'Note']];
    after.forEach((ev, i) => {
        const old = byId.get(ev.id);
        if (!old) { added++; if (samples.length < 6) samples.push({ n: i + 1, what: 'Added', after: ev.translatedText || ev.originalText || '' }); return; }
        seen.add(ev.id);
        const diff = fields.find(([f]) => !sameValue(f, ev[f], old[f]));
        if (diff) {
            changed++;
            if (samples.length < 6) samples.push({ n: i + 1, what: diff[1], before: old[diff[0]] || '', after: ev[diff[0]] || '' });
        }
    });
    const removed = before.filter(ev => !seen.has(ev.id) && !after.some(x => x.id === ev.id)).length;
    return { changed, added, removed, samples };
}

function diffText(d) {
    const parts = [];
    if (d.changed) parts.push(`${d.changed} changed`);
    if (d.added) parts.push(`${d.added} added`);
    if (d.removed) parts.push(`${d.removed} removed`);
    return parts.length ? parts.join(', ') : 'no differences in text or timing';
}

function diffHtml(d) {
    if (!d.samples.length) return '';
    return '<ul class="tm-diff-list">' + d.samples.map(s =>
        `<li><b>#${s.n} ${escapeHtml(s.what)}</b>`
        + (s.before !== undefined ? ` <span class="tm-diff-old" dir="auto">${escapeHtml(String(s.before).slice(0, 80)) || '—'}</span> →` : '')
        + ` <span class="tm-diff-new" dir="auto">${escapeHtml(String(s.after).slice(0, 80)) || '—'}</span></li>`).join('') + '</ul>';
}

/* Offers a recovery copy left by a tab that closed or crashed with unsaved
   work. Shows what it would change, merges it into a newer saved version
   when the edits do not collide, and never throws a copy away silently:
   declining keeps it on the server as a recoverable version. */
async function offerDraftRecovery(serverEvents, serverRevision) {
    const draft = readDraft();
    if (!draft) return false;
    if (JSON.stringify(draft.events) === JSON.stringify(serverEvents)) { clearDraft(); return false; }

    let candidate = draft.events;
    let note = '';
    if (draft.revision != null && serverRevision != null && draft.revision !== serverRevision) {
        let merged = null;
        if (Array.isArray(draft.base)) {
            const current = baseline;
            baseline = new Map(draft.base.map(ev => [ev.id, { ...ev }]));
            merged = mergeWithServer(draft.events, serverEvents);
            baseline = current;
        }
        if (merged) {
            candidate = merged;
            note = 'The project was saved elsewhere after this copy was made. Your unsaved edits do not collide with that newer version, so they will be merged into it.';
        } else {
            note = 'The project was saved elsewhere after this copy was made, and both changed the same lines. Restoring puts your copy back; the newer saved version is kept in the version history.';
        }
    }

    const d = diffSummary(serverEvents, candidate);
    const age = describeAge(draft.savedAt);
    const when = new Date(draft.savedAt || Date.now()).toLocaleString();
    const restore = await chooseDialog({
        title: 'Unsaved work found',
        text: `This browser kept a copy of unsaved work for this project (${age}, ${draft.events.length} cues): ${diffText(d)} compared with the saved version.`
            + (note ? '\n\n' + note : '')
            + `\n\nOK — restore that work and continue from it.\nCancel — open the saved version; the local copy is kept in the version history.\n\nLocal copy: ${when}`,
        html: `<p>This browser kept a copy of unsaved work for this project, from <b>${escapeHtml(age)}</b> (${escapeHtml(when)}), with ${draft.events.length} subtitles.</p>`
            + `<p>Compared with the saved version: <b>${escapeHtml(diffText(d))}</b>.</p>`
            + diffHtml(d)
            + (note ? `<p class="tm-modal-note">${escapeHtml(note)}</p>` : ''),
        choices: [
            { label: 'Restore unsaved work', value: true, primary: true },
            { label: 'Open the saved version', value: false },
        ],
    });

    if (!restore) {
        keepCheckpoint(6, `Local copy not restored (${when})`, draft.events);
        clearDraft();
        return false;
    }
    // The saved version is about to be replaced on screen and, at the next
    // save, on the server; keep it reachable.
    keepCheckpoint(5, 'Saved version before restoring a local copy');
    events = candidate;
    if (draft.settings) applyProjectSettings(draft.settings);
    markDirty();
    showBanner('Restored unsaved work from this browser. It will save automatically.', 'warn');
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
function showBanner(message, tone = 'warn', actions = [], tag = '') {
    const bar = document.getElementById('editorBanner');
    if (!bar) return;
    bar.className = `tm-banner tm-banner-${tone}`;
    if (bar.dataset) bar.dataset.tag = tag;
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

// Hides the banner only if it is the one a given process put up, so clearing
// a save warning never dismisses an unrelated message.
function hideBannerFor(tag) {
    const bar = document.getElementById('editorBanner');
    if (bar && !bar.hidden && bar.dataset?.tag === tag) bar.hidden = true;
}

/* A modal choice. Resolves with the chosen value, or the last choice's value
   on Escape. Where there is no real page (the Node test stub) it falls back
   to confirm() with the plain-text version. */
function chooseDialog({ title, text, html, choices, pickable }) {
    if (typeof document === 'undefined' || !document.body || typeof document.body.appendChild !== 'function') {
        return Promise.resolve(confirm(`${title}\n\n${text}`) ? choices[0].value : choices[choices.length - 1].value);
    }
    return new Promise(resolve => {
        const back = document.createElement('div');
        back.className = 'tm-modal-backdrop';
        const box = document.createElement('div');
        box.className = 'tm-modal tm-choice-modal';
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');
        box.setAttribute('aria-labelledby', 'tmChoiceTitle');
        box.innerHTML = `<h3 class="tm-modal-title" id="tmChoiceTitle">${escapeHtml(title)}</h3>`
            + `<div class="tm-modal-msg">${html || escapeHtml(text).replace(/\n/g, '<br>')}</div><div class="tm-modal-actions"></div>`;
        const actions = box.querySelector('.tm-modal-actions');
        const done = value => { back.remove(); document.removeEventListener('keydown', onKey, true); resolve(value); };
        const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); done(choices[choices.length - 1].value); } };
        for (const c of choices) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = c.primary ? 'tm-btn tm-btn-primary' : 'tm-btn-sm';
            b.textContent = c.label;
            b.addEventListener('click', () => done(c.value));
            actions.appendChild(b);
        }
        if (pickable) box.addEventListener('click', e => {
            const pick = e.target.closest(pickable);
            if (pick) done(pick.dataset.value);
        });
        back.appendChild(box);
        document.body.appendChild(back);
        document.addEventListener('keydown', onKey, true);
        (actions.querySelector('.tm-btn-primary') || actions.querySelector('button'))?.focus();
    });
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
        const payload = await api(`/studio/${PROJECT_ID}/events`);
        // The endpoint used to return a bare array and now returns
        // { revision, events }; accept either so a cached response from an
        // older build cannot strand the editor.
        const serverEvents = Array.isArray(payload) ? payload : payload?.events;
        if (!Array.isArray(serverEvents)) throw new Error('Invalid response');
        loadedRevision = Array.isArray(payload) ? null : payload.revision ?? null;
        events = serverEvents;
        rememberBaseline(serverEvents);
        if (payload?.settings) applyProjectSettings(payload.settings);
        else if (localStorage.getItem?.(PROFILE_KEY)) { /* keep the browser's profile; the first save stores it with the project */ }
        if (payload?.status) paintProjectStatus(payload.status);
        lastSavedAt = payload?.updatedAt ? new Date(payload.updatedAt) : null;
        loaded = true;
        loadPayload = payload;
        history = [JSON.stringify(events)]; historyIndex = 0;
        paintSaveState('saved');
        if (typeof TmWorkspace !== 'undefined') TmWorkspace.onLoaded?.(payload);
        await offerDraftRecovery(serverEvents, loadedRevision);
        reserveTempIds();
        announceTab();
    } catch (err) {
        eventsList.textContent = err?.kind === 'auth'
            ? 'Your sign-in has expired. Sign in again, then reload this page.'
            : 'Could not load subtitles. Reload the page to try again.';
        saveStatus.textContent = 'Load failed';
        return;
    }
    renderEvents();
    // Cues alone are enough to draw a timeline, so this no longer waits for
    // a video that may never arrive.
    setZoom(defaultZoom(), 0);
    drawTimelineRuler();
    renderTimelineBlocks();
    video?.addEventListener('loadedmetadata', () => {
        drawTimelineRuler();
        renderTimelineBlocks();
    });
    // Reading the audio is the expensive part, so it starts as soon as the
    // media element knows what it is pointed at and reports back through the
    // progress overlay rather than blocking anything else.
    if (video?.currentSrc || video?.src) loadWaveform();
    else video?.addEventListener('loadedmetadata', () => loadWaveform(), { once: true });
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
// The revisor's page has no status control: they report a verdict by
// submitting their round instead.
const projectStatus = document.getElementById('projectStatus');
let previousStatus = projectStatus?.value;
function paintProjectStatus(status) {
    if (!projectStatus || !status) return;
    if ([...(projectStatus.options || [])].some(o => o.value === status)) {
        projectStatus.value = status;
        previousStatus = status;
    }
}
projectStatus?.addEventListener('change', async () => {
    // Completion is not a label to pick: it is what Done records once the
    // project has been checked and saved.
    if (projectStatus.value === 'Completed') {
        projectStatus.value = previousStatus;
        if (typeof TmWorkspace !== 'undefined') TmWorkspace.startDone?.();
        return;
    }
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
    if (!translatorOnly()) return;
    const ev = events.find(cue => cue.id === activeId);
    if (!ev) { alert('Select a cue first.'); return; }
    if (ev.translatedText && !confirm('Replace this translation with its source text?')) return;
    ev.translatedText = ev.originalText || '';
    markDirty(); renderEvents(); updateOverlay();
});
document.getElementById('btnSplitCue').addEventListener('click', () => {
    if (!translatorOnly()) return;
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
    if (!translatorOnly()) return;
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
    if (typeof TmTools !== 'undefined') {
        const what = targets.length === events.length ? 'all subtitles' : `${targets.length} subtitles`;
        TmTools.previewTiming(`Shift ${what} ${offset < 0 ? 'earlier' : 'later'} by ${SubtitleCore.timestamp(Math.abs(offset))}`,
            targets.map(ev => ({ ev, start: SubtitleCore.seconds(ev.startTime) + offset, end: SubtitleCore.seconds(ev.endTime) + offset })),
            Math.abs(offset - requested) > 0.0005 ? `Limited from ${SubtitleCore.timestamp(Math.abs(requested))} so timing stays within 00:00:00–24:00:00.` : '');
        return;
    }
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
    if (typeof TmTools !== 'undefined') {
        TmTools.previewTiming('Zero out timing', events.map(ev => ({ ev, start: SubtitleCore.seconds(ev.startTime) - minStart, end: SubtitleCore.seconds(ev.endTime) - minStart })),
            `Every subtitle moves ${SubtitleCore.timestamp(minStart)} earlier so the first starts at 00:00:00.`);
        return;
    }
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
    // The previewing version (tools.js) covers source text too and respects
    // locked lines; the direct one below remains the fallback.
    if (typeof TmTools !== 'undefined') { TmTools.findReplace(); return; }
    if (!translatorOnly()) return;
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
document.getElementById('tlZoomSel')?.addEventListener('click', zoomToSelection);
document.getElementById('tlZoom')?.addEventListener('input', e => zoomFromSlider(Number(e.target.value)));
document.getElementById('tlFollow')?.addEventListener('change', e => {
    followPlayback = e.target.checked;
    saveTimelinePrefs();
    if (followPlayback && playing()) { viewOffset = viewCentre - video.currentTime; kickView(); }
});
document.getElementById('tlJump')?.addEventListener('change', e => {
    jumpSeconds = Number(e.target.value) || 2;
    saveTimelinePrefs();
});
document.getElementById('tlSnapCuts')?.addEventListener('change', e => {
    snapToCuts = e.target.checked;
    saveTimelinePrefs();
});
document.getElementById('tlShowText')?.addEventListener('change', e => {
    showBlockText = e.target.checked;
    saveTimelinePrefs();
    renderTimelineBlocks();
});
document.getElementById('tlRedetectShots')?.addEventListener('click', () => loadShotChanges({ force: true }));
document.getElementById('tlWaveScale')?.addEventListener('change', e => {
    waveScale = e.target.value;
    saveTimelinePrefs();
    drawTimelineRuler();
});
document.getElementById('tlStatus')?.addEventListener('click', () => document.getElementById('tlAudioMenuBtn')?.click());

// ── Sound ───────────────────────────────────────────
document.getElementById('tlPlayPreroll')?.addEventListener('click', playWithPreroll);
document.getElementById('tlLoop')?.addEventListener('click', toggleLoopSelected);
document.getElementById('tlMute')?.addEventListener('click', () => {
    if (!video) return;
    video.muted = !video.muted;
    paintVolumeButton();
    saveTimelinePrefs();
});
document.getElementById('tlVolume')?.addEventListener('input', e => setVolume(Number(e.target.value) / 100));
document.getElementById('tlSpeed')?.addEventListener('change', e => {
    if (video) video.playbackRate = parseFloat(e.target.value);
    // The video toolbar has its own speed control; the two are the same
    // setting and must not disagree about what it currently is.
    if (speedSelect) speedSelect.value = e.target.value;
});
speedSelect?.addEventListener('change', () => {
    const mirror = document.getElementById('tlSpeed');
    if (mirror) mirror.value = speedSelect.value;
});

document.getElementById('tlGain')?.addEventListener('input', e => {
    waveGain = Number(e.target.value) / 100;
    const out = document.getElementById('tlGainOut');
    if (out) out.textContent = waveGain.toFixed(1) + '\u00d7';
    saveTimelinePrefs();
    drawTimelineRuler();
});
document.getElementById('tlWaveView')?.addEventListener('change', e => {
    waveView = e.target.value;
    saveTimelinePrefs();
    drawTimelineRuler();
});
document.getElementById('tlShowSpeech')?.addEventListener('change', e => {
    showSpeech = e.target.checked;
    saveTimelinePrefs();
    drawTimelineRuler();
});
document.getElementById('tlScrubAudio')?.addEventListener('change', e => {
    scrubAudio = e.target.checked;
    saveTimelinePrefs();
});
document.getElementById('tlSnapAudio')?.addEventListener('change', e => {
    snapToAudio = e.target.checked;
    saveTimelinePrefs();
});
document.getElementById('tlPreroll')?.addEventListener('input', e => {
    prerollSecs = Number(e.target.value) / 1000;
    const out = document.getElementById('tlPrerollOut');
    if (out) out.textContent = prerollSecs.toFixed(1) + 's';
    saveTimelinePrefs();
});
document.getElementById('tlReanalyse')?.addEventListener('click', () => loadWaveform({ force: true }));

// ── Timing ──────────────────────────────────────────
document.getElementById('tlSetIn')?.addEventListener('click', markInPoint);
document.getElementById('tlSetOut')?.addEventListener('click', markOutPoint);
document.getElementById('tlSplitHere')?.addEventListener('click', splitAtPlayhead);
document.getElementById('tlJoinNext')?.addEventListener('click', joinWithNext);
document.getElementById('tlFitSpeech')?.addEventListener('click', fitSelectedToSpeech);
document.getElementById('tlPrevSpeech')?.addEventListener('click', () => jumpToSpeechEdge(-1));
document.getElementById('tlNextSpeech')?.addEventListener('click', () => jumpToSpeechEdge(1));

// ── Options popover ─────────────────────────────────
const tlAudioMenuBtn = document.getElementById('tlAudioMenuBtn');
const tlAudioMenu = document.getElementById('tlAudioMenu');
tlAudioMenuBtn?.addEventListener('click', e => {
    e.stopPropagation();
    const open = tlAudioMenu.hidden;
    tlAudioMenu.hidden = !open;
    // The toolbar scrolls sideways and clips anything inside it, so the menu
    // is fixed-position and placed against the button: above it, right-aligned.
    if (open) {
        const r = tlAudioMenuBtn.getBoundingClientRect();
        const w = tlAudioMenu.offsetWidth;
        tlAudioMenu.style.left = Math.max(12, Math.min(window.innerWidth - w - 12, r.right - w)) + 'px';
        tlAudioMenu.style.bottom = (window.innerHeight - r.top + 8) + 'px';
    }
    tlAudioMenuBtn.setAttribute('aria-expanded', String(open));
    tlAudioMenuBtn.classList.toggle('tm-toggle-on', open);
    if (open) describeAnalysis();
});
document.addEventListener('click', e => {
    if (!tlAudioMenu || tlAudioMenu.hidden) return;
    if (tlAudioMenu.contains(e.target) || tlAudioMenuBtn.contains(e.target)) return;
    tlAudioMenu.hidden = true;
    tlAudioMenuBtn.setAttribute('aria-expanded', 'false');
    tlAudioMenuBtn.classList.remove('tm-toggle-on');
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && tlAudioMenu && !tlAudioMenu.hidden) {
        tlAudioMenu.hidden = true;
        tlAudioMenuBtn.setAttribute('aria-expanded', 'false');
        tlAudioMenuBtn.classList.remove('tm-toggle-on');
    }
});

// Restore whatever the translator set last time. These are per-person
// working preferences, not project data, so they stay in this browser.
(function applyTimelinePrefs() {
    const p = loadTimelinePrefs();
    const set = (id, value) => { const el = document.getElementById(id); if (el != null && value != null) el.value = value; };
    const check = (id, value) => { const el = document.getElementById(id); if (el && value != null) el.checked = !!value; };

    if (Number.isFinite(p.waveGain)) waveGain = p.waveGain;
    if (p.waveView) waveView = p.waveView;
    if (p.showSpeech != null) showSpeech = !!p.showSpeech;
    if (p.snapToAudio != null) snapToAudio = !!p.snapToAudio;
    if (p.scrubAudio != null) scrubAudio = !!p.scrubAudio;
    if (Number.isFinite(p.prerollSecs)) prerollSecs = p.prerollSecs;
    if (p.showBlockText != null) showBlockText = !!p.showBlockText;
    if (p.snapToCuts != null) snapToCuts = !!p.snapToCuts;
    if (p.waveScale === 'db' || p.waveScale === 'linear') waveScale = p.waveScale;
    if (p.followPlayback != null) followPlayback = !!p.followPlayback;
    if (Number.isFinite(p.jumpSeconds)) jumpSeconds = p.jumpSeconds;
    check('tlFollow', followPlayback);
    set('tlJump', String(jumpSeconds));
    set('tlWaveScale', waveScale);
    check('tlShowText', showBlockText);
    check('tlSnapCuts', snapToCuts);

    set('tlGain', Math.round(waveGain * 100));
    set('tlWaveView', waveView);
    set('tlPreroll', Math.round(prerollSecs * 1000));
    check('tlShowSpeech', showSpeech);
    check('tlSnapAudio', snapToAudio);
    check('tlScrubAudio', scrubAudio);
    const gainOut = document.getElementById('tlGainOut');
    if (gainOut) gainOut.textContent = waveGain.toFixed(1) + '\u00d7';
    const prerollOut = document.getElementById('tlPrerollOut');
    if (prerollOut) prerollOut.textContent = prerollSecs.toFixed(1) + 's';

    if (video) {
        if (Number.isFinite(p.volume)) video.volume = p.volume;
        if (p.muted != null) video.muted = !!p.muted;
        set('tlVolume', Math.round((video.volume ?? 1) * 100));
        paintVolumeButton();
    }
})();

wireTimelineSurface();
document.getElementById('btnTogglePanel')?.addEventListener('click', toggleEventsPanel);
document.getElementById('btnSwapColumns')?.addEventListener('click', swapColumns);
document.getElementById('btnCardLayout')?.addEventListener('click', toggleCardLayout);
document.getElementById('btnExpandedView')?.addEventListener('click', () => setExpandedView(!expandedView));
paintExpandedToggle();
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
    // A waveform is worth looking at, so the ceiling is generous; the floor
    // still has to leave the cue list usable.
    const clamped   = Math.min(Math.max(newHeight, 80), Math.max(200, editorWrapRect.height * 0.6));
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


