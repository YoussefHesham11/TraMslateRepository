// ═══════════════════════════════════════════════════
//  TraMslate — Keyboard Shortcuts catalog + engine
//
//  Single source of truth for every rebindable function in the app.
//  Used by:
//   - editor.js       → registers handlers via Shortcuts.on(id, fn)
//   - Settings/Shortcuts page → lists FUNCTIONS/CATEGORIES, lets the
//     user record new combos with Shortcuts.describe(keydownEvent)
// ═══════════════════════════════════════════════════
(function (root) {
    'use strict';

    const CATEGORIES = [
        { id: 'playback',    label: 'Video Playback',    icon: 'bi-play-circle' },
        { id: 'timing',      label: 'Subtitle Timing',   icon: 'bi-clock-history' },
        { id: 'editing',     label: 'Text Editing',      icon: 'bi-pencil-square' },
        { id: 'navigation',  label: 'Navigation',        icon: 'bi-compass' },
        { id: 'translation', label: 'Translation',       icon: 'bi-translate' },
        { id: 'sync',        label: 'Synchronization',   icon: 'bi-arrows-expand' },
        { id: 'file',        label: 'File Management',   icon: 'bi-folder2-open' },
    ];

    // allowInInput: whether this shortcut may fire while typing in an
    // input/textarea/select (e.g. Ctrl+S should still save from a text box).
    // locked: shown for reference but cannot be reassigned (browser-owned key).
    const FUNCTIONS = [
        // ── Video Playback ──
        { id: 'playPause',    category: 'playback', label: 'Play / Pause',              description: 'Toggle video playback.',                 default: 'Space',        allowInInput: false },
        { id: 'seekBack1s',   category: 'playback', label: 'Seek back 1 second',        description: 'Move the playhead back one second.',      default: 'ArrowLeft',    allowInInput: false },
        { id: 'seekFwd1s',    category: 'playback', label: 'Seek forward 1 second',     description: 'Move the playhead forward one second.',   default: 'ArrowRight',   allowInInput: false },
        { id: 'skipBack5s',   category: 'playback', label: 'Skip back 5 seconds',       description: 'Jump the playhead back five seconds.',    default: 'Shift+ArrowLeft',  allowInInput: false },
        { id: 'skipFwd5s',    category: 'playback', label: 'Skip forward 5 seconds',    description: 'Jump the playhead forward five seconds.', default: 'Shift+ArrowRight', allowInInput: false },
        { id: 'prevFrame',    category: 'playback', label: 'Step to previous frame',    description: 'Pause and move back exactly one frame.',  default: ',',             allowInInput: false },
        { id: 'nextFrame',    category: 'playback', label: 'Step to next frame',        description: 'Pause and move forward exactly one frame.', default: '.',           allowInInput: false },
        { id: 'speedUp',      category: 'playback', label: 'Increase playback speed',   description: 'Bump the playback speed up one step.',    default: ']',             allowInInput: false },
        { id: 'speedDown',    category: 'playback', label: 'Decrease playback speed',   description: 'Bump the playback speed down one step.',  default: '[',             allowInInput: false },
        { id: 'stopPlayback',     category: 'playback', label: 'Stop',                       description: 'Pause and return to the selected cue\'s start.', default: 'Alt+X', allowInInput: false },
        { id: 'rewind',           category: 'playback', label: 'Rewind 10 seconds',          description: 'Jump the playhead back ten seconds.',            default: 'Alt+ArrowLeft', allowInInput: false },
        { id: 'fastForward',      category: 'playback', label: 'Fast-forward 10 seconds',    description: 'Jump the playhead forward ten seconds.',         default: 'Alt+ArrowRight', allowInInput: false },
        { id: 'playSelectedRange',category: 'playback', label: 'Play selected cue only',     description: 'Play just the selected cue\'s time range, then stop.', default: 'Alt+P', allowInInput: false },
        { id: 'toggleAutoPauseOut',category: 'playback', label: 'Toggle auto-pause at out-time', description: 'Automatically pause when playback reaches the selected cue\'s out-time.', default: 'Alt+O', allowInInput: false },
        { id: 'seekBackHalfSec', category: 'playback', label: 'Seek back half a second',    description: 'Jump the playhead back half a second.',    default: 'Ctrl+Alt+ArrowLeft',  allowInInput: false },
        { id: 'seekFwdHalfSec',  category: 'playback', label: 'Seek forward half a second', description: 'Jump the playhead forward half a second.', default: 'Ctrl+Alt+ArrowRight', allowInInput: false },

        // ── Subtitle Timing ──
        { id: 'markIn',       category: 'timing', label: 'Mark IN point',               description: 'Set the selected cue\'s start time to the playhead.', default: 'I', allowInInput: false },
        { id: 'markOut',      category: 'timing', label: 'Mark OUT point',              description: 'Set the selected cue\'s end time to the playhead.',   default: 'O', allowInInput: false },
        { id: 'splitCue',     category: 'timing', label: 'Split cue at playhead',        description: 'Split the selected cue into two at the current time.', default: 'Ctrl+K', allowInInput: false },
        { id: 'mergeCue',     category: 'timing', label: 'Merge with next cue',          description: 'Merge the selected cue with the one after it.',       default: 'Ctrl+M', allowInInput: false },
        { id: 'deleteLine',   category: 'timing', label: 'Delete selected cue',          description: 'Remove the selected subtitle line entirely.',         default: 'Delete', allowInInput: false },
        { id: 'nudgeEarlier',    category: 'timing', label: 'Nudge selection earlier',   description: 'Move the selected cue(s) slightly earlier by the timeline step size.', default: 'Alt+,', allowInInput: false },
        { id: 'nudgeLater',      category: 'timing', label: 'Nudge selection later',     description: 'Move the selected cue(s) slightly later by the timeline step size.',  default: 'Alt+.', allowInInput: false },
        { id: 'shrinkDuration',  category: 'timing', label: 'Shrink duration',           description: 'Shorten the selected cue(s) by the timeline step size.', default: 'Alt+-', allowInInput: false },
        { id: 'growDuration',    category: 'timing', label: 'Grow duration',             description: 'Extend the selected cue(s) by the timeline step size.',  default: 'Alt+=', allowInInput: false },
        { id: 'duplicateCue',    category: 'timing', label: 'Duplicate selected cue',    description: 'Insert a copy of the selected cue right after it.',      default: 'Ctrl+Shift+D', allowInInput: false },
        { id: 'toggleLockSelected', category: 'timing', label: 'Lock / unlock selected cue(s)', description: 'Protect the selected cue(s) from accidental timing changes.', default: 'Alt+L', allowInInput: false },
        { id: 'moveStartEarlier', category: 'timing', label: 'Move start earlier',  description: 'Move only the selected cue\'s start time earlier (changes duration).', default: 'Shift+ArrowDown', allowInInput: false },
        { id: 'moveStartLater',   category: 'timing', label: 'Move start later',    description: 'Move only the selected cue\'s start time later (changes duration).',  default: 'Shift+ArrowUp',   allowInInput: false },
        { id: 'setOutByReadingSpeed', category: 'timing', label: 'Set out-time by reading speed', description: 'Set the selected cue\'s duration from its text length at the ideal reading speed.', default: 'Alt+R', allowInInput: false },
        { id: 'mergeCuePrevious', category: 'timing', label: 'Merge with previous cue', description: 'Merge the selected cue with the one before it.', default: 'Ctrl+Shift+M', allowInInput: false },
        { id: 'splitAtCaret',      category: 'timing', label: 'Split at text cursor',       description: 'Split the selected cue where your cursor sits in its translation.', default: 'Alt+Enter',       allowInInput: true },
        { id: 'splitAtCaretFrame', category: 'timing', label: 'Split at text cursor (snap to frame)', description: 'Same as Split at text cursor, but rounds the split point to the nearest frame.', default: 'Alt+Shift+Enter', allowInInput: true },

        // ── Text Editing ──
        { id: 'undo',            category: 'editing', label: 'Undo',                      description: 'Undo the last structural edit. Text fields keep their native undo while focused.', default: 'Ctrl+Z',       allowInInput: false },
        { id: 'redo',            category: 'editing', label: 'Redo',                      description: 'Redo the last undone edit.',              default: 'Ctrl+Shift+Z', allowInInput: false },
        { id: 'nextField',       category: 'editing', label: 'Move to next translation field', description: 'Tab to the next cue\'s translation box.', default: 'Tab', allowInInput: true, locked: true },
        { id: 'focusFindReplace',category: 'editing', label: 'Open Find & Replace',       description: 'Open "More tools" and focus the Find box.', default: 'Ctrl+F',       allowInInput: true },
        { id: 'replaceAll',      category: 'editing', label: 'Replace all matches',       description: 'Apply the current Find & Replace to every cue.', default: 'Ctrl+Alt+R', allowInInput: true },

        // ── Navigation ──
        { id: 'nextUntranslated', category: 'navigation', label: 'Jump to next untranslated cue', description: 'Select the next cue with no translation yet.', default: 'Ctrl+ArrowRight', allowInInput: false },
        { id: 'selectNextCue',    category: 'navigation', label: 'Select next cue',            description: 'Move selection to the next cue in the list.',    default: 'Ctrl+ArrowDown', allowInInput: true },
        { id: 'selectPrevCue',    category: 'navigation', label: 'Select previous cue',        description: 'Move selection to the previous cue in the list.', default: 'Ctrl+ArrowUp',   allowInInput: true },
        { id: 'focusSearch',      category: 'navigation', label: 'Focus cue search box',       description: 'Jump the cursor into the subtitle search field.', default: 'Ctrl+Shift+F',   allowInInput: true },
        { id: 'zoomIn',           category: 'navigation', label: 'Zoom timeline in',            description: 'Zoom the timeline in for more precise editing.',  default: 'Ctrl+=', allowInInput: false },
        { id: 'zoomOut',          category: 'navigation', label: 'Zoom timeline out',           description: 'Zoom the timeline out.',                          default: 'Ctrl+-', allowInInput: false },
        { id: 'zoomFit',          category: 'navigation', label: 'Fit timeline to window',      description: 'Zoom the timeline so the whole track is visible.', default: 'Ctrl+0', allowInInput: false },
        { id: 'seekToEventStart',    category: 'navigation', label: 'Seek to selected cue\'s start', description: 'Move the playhead back to the selected cue\'s start time.', default: 'Alt+Home', allowInInput: false },
        { id: 'seekToPreviousStart', category: 'navigation', label: 'Seek to previous cue start',    description: 'Jump the playhead to the nearest earlier cue start.',       default: 'Ctrl+Q',   allowInInput: false },
        { id: 'seekToNextEnd',       category: 'navigation', label: 'Seek to next cue end',          description: 'Jump the playhead to the nearest later cue end.',           default: 'Ctrl+]',   allowInInput: false },
        { id: 'findNext',     category: 'navigation', label: 'Find next match',     description: 'Select the next cue matching the search box and filter.',     default: 'Ctrl+G',       allowInInput: true },
        { id: 'findPrevious', category: 'navigation', label: 'Find previous match', description: 'Select the previous cue matching the search box and filter.', default: 'Ctrl+Shift+G', allowInInput: true },
        { id: 'toggleEventsPanel', category: 'navigation', label: 'Toggle events panel',        description: 'Collapse or expand the subtitle list panel for a larger video view.', default: 'Ctrl+\\',        allowInInput: false },
        { id: 'toggleWorkspaceTools', category: 'navigation', label: 'Toggle search & quick tools', description: 'Show or hide the search box, filters, and quick-action icons above the subtitle list.', default: 'Alt+T', allowInInput: false },
        { id: 'swapColumns',       category: 'navigation', label: 'Swap original/translation columns', description: 'Switch which side the original text and translation appear on.', default: 'Alt+Shift+ArrowLeft', allowInInput: false },
        { id: 'toggleCardLayout',  category: 'navigation', label: 'Toggle cue card layout',     description: 'Switch each cue card between side-by-side and stacked text.',        default: 'Alt+Shift+L',    allowInInput: false },
        { id: 'openSettings',      category: 'navigation', label: 'Open keyboard shortcuts settings', description: 'Go to the Keyboard Shortcuts settings page.', default: 'Ctrl+/', allowInInput: false },

        // ── Translation ──
        // ── Checking & workflow ──
        { id: 'nextIssue',        category: 'navigation', label: 'Go to next problem',        description: 'Open the next validation problem: its subtitle, field and explanation.', default: 'F8',       allowInInput: true },
        { id: 'prevIssue',        category: 'navigation', label: 'Go to previous problem',    description: 'Open the previous validation problem.',            default: 'Shift+F8', allowInInput: true },
        { id: 'toggleIssuesPanel',category: 'navigation', label: 'Show / hide issues',        description: 'Open or close the issues panel.',                   default: 'Alt+I',    allowInInput: false },
        { id: 'nextUnfinished',   category: 'navigation', label: 'Next unfinished subtitle',  description: 'Untranslated, marked for more work, or with an open question.', default: 'F9', allowInInput: true },
        { id: 'prevUnfinished',   category: 'navigation', label: 'Previous unfinished subtitle', description: 'The previous untranslated, marked or questioned subtitle.', default: 'Shift+F9', allowInInput: true },
        { id: 'nextFlagged',      category: 'navigation', label: 'Next flagged subtitle',     description: 'Marked for more work, or flagged by the revisor.', default: 'Alt+PageDown', allowInInput: true },
        { id: 'prevFlagged',      category: 'navigation', label: 'Previous flagged subtitle', description: 'The previous marked or revisor-flagged subtitle.',  default: 'Alt+PageUp',   allowInInput: true },
        { id: 'nextBookmark',     category: 'navigation', label: 'Next bookmark',             description: 'Jump to the next bookmarked subtitle.',            default: 'F2',       allowInInput: true },
        { id: 'prevBookmark',     category: 'navigation', label: 'Previous bookmark',         description: 'Jump to the previous bookmarked subtitle.',        default: 'Shift+F2', allowInInput: true },
        { id: 'toggleBookmark',   category: 'translation', label: 'Bookmark / unbookmark',    description: 'Bookmark the selected subtitle to come back to.',  default: 'Alt+B',    allowInInput: false },
        { id: 'markReviewed',     category: 'translation', label: 'Mark reviewed / not reviewed', description: 'Toggle the selected subtitle\'s review mark.', default: 'Alt+V',    allowInInput: false },
        { id: 'openMarks',        category: 'translation', label: 'Edit marks',               description: 'Open the flags, question, bookmark and review marks for the selected subtitle.', default: 'Alt+M', allowInInput: false },
        { id: 'versionHistory',   category: 'file',        label: 'Version history',          description: 'Browse, preview and restore earlier versions.',   default: 'Alt+H',    allowInInput: false },
        { id: 'bulkActions',      category: 'editing',  label: 'Bulk actions on selected',  description: 'Change all selected subtitles at once (marks, status, timing, delete), with a preview.', default: 'Alt+Shift+B', allowInInput: false },
        { id: 'moveCueUp',        category: 'editing',  label: 'Move subtitle up the list',  description: 'Swap the selected subtitle with the one above (times unchanged).', default: 'Alt+Shift+PageUp', allowInInput: false },
        { id: 'moveCueDown',      category: 'editing',  label: 'Move subtitle down the list', description: 'Swap the selected subtitle with the one below (times unchanged).', default: 'Alt+Shift+PageDown', allowInInput: false },
        { id: 'jumpBack',         category: 'playback', label: 'Short jump back',            description: 'Jump back by the short-jump amount set in the timeline options.', default: 'J', allowInInput: false },
        { id: 'jumpForward',      category: 'playback', label: 'Short jump forward',         description: 'Jump forward by the short-jump amount set in the timeline options.', default: 'L', allowInInput: false },
        { id: 'loopSelected',     category: 'playback', label: 'Loop the selected subtitle', description: 'Loop it, padded by the run-up setting; again to stop.', default: 'Ctrl+Alt+L', allowInInput: false },
        { id: 'twoPointSync',     category: 'sync',     label: 'Sync with two points',       description: 'Correct drifting timing from two subtitles whose times you know.', default: '', allowInInput: false },
        { id: 'convertFrameRate', category: 'sync',     label: 'Convert frame rate',         description: 'Re-time every subtitle for a video converted to another frame rate.', default: '', allowInInput: false },
        { id: 'markDone',         category: 'file',        label: 'Done',                     description: 'Check, save and mark the current version complete.', default: '',  allowInInput: false },
        { id: 'copySource', category: 'translation', label: 'Copy source into translation', description: 'Copy the selected cue\'s source text into its translation.', default: 'Ctrl+D', allowInInput: true },

        // ── Synchronization ──
        { id: 'shiftAllLater',      category: 'sync', label: 'Shift all cues later',      description: 'Shift every cue later by the configured shift amount.',   default: '', allowInInput: false },
        { id: 'shiftAllEarlier',    category: 'sync', label: 'Shift all cues earlier',     description: 'Shift every cue earlier by the configured shift amount.', default: '', allowInInput: false },
        { id: 'shiftFromSelected',  category: 'sync', label: 'Shift from selected cue',    description: 'Shift the selected cue and every cue after it.',         default: '', allowInInput: false },
        { id: 'zeroOutTiming',      category: 'sync', label: 'Zero out timing',            description: 'Rebase every cue so the earliest one starts at 00:00:00.', default: '', allowInInput: false },
        { id: 'toggleSnap',         category: 'sync', label: 'Toggle timeline snapping',   description: 'Snap dragged cue edges to the playhead, nearby cues, and frames.', default: 'Alt+S', allowInInput: false },
        { id: 'linkPrevious', category: 'sync', label: 'Link to previous cue', description: 'Snap the selected cue\'s start to the previous cue\'s end, closing any gap or overlap.', default: 'Alt+ArrowUp',   allowInInput: false },
        { id: 'linkNext',     category: 'sync', label: 'Link to next cue',     description: 'Snap the selected cue\'s end to the next cue\'s start, closing any gap or overlap.',    default: 'Alt+ArrowDown', allowInInput: false },

        // ── File Management ──
        { id: 'save',          category: 'file', label: 'Save project',        description: 'Save all subtitle changes now.',        default: 'Ctrl+S',       allowInInput: true },
        { id: 'importScript',  category: 'file', label: 'Import subtitle script', description: 'Open the file picker to import an SRT/VTT/Word script.', default: 'Ctrl+I', allowInInput: false },
        { id: 'exportSrt',     category: 'file', label: 'Export as SRT',       description: 'Download the current subtitles as an SRT file.', default: 'Ctrl+Shift+S', allowInInput: false },
        { id: 'exportVtt',     category: 'file', label: 'Export as VTT',       description: 'Download the current subtitles as a VTT file.',  default: 'Ctrl+Alt+S',   allowInInput: false },
        { id: 'addLine',       category: 'file', label: 'Add new subtitle line', description: 'Insert a new cue at the current playhead.',    default: 'Ctrl+Enter',   allowInInput: true },
    ];

    const byId = id => FUNCTIONS.find(f => f.id === id);

    // Turns a keydown event into a stable combo string like "Ctrl+Shift+K",
    // based on the physical key (e.code) so Shift/CapsLock/layout don't change
    // which combo is recorded or matched.
    function describe(e) {
        const code = e.code || '';
        let key;
        if (code === 'Space') key = 'Space';
        else if (code.startsWith('Key')) key = code.slice(3);
        else if (code.startsWith('Digit')) key = code.slice(5);
        else if (code.startsWith('Numpad')) key = 'Num' + code.slice(6);
        else if (code === 'Comma') key = ',';
        else if (code === 'Period') key = '.';
        else if (code === 'Slash') key = '/';
        else if (code === 'Backslash') key = '\\';
        else if (code === 'Semicolon') key = ';';
        else if (code === 'Quote') key = "'";
        else if (code === 'BracketLeft') key = '[';
        else if (code === 'BracketRight') key = ']';
        else if (code === 'Minus') key = '-';
        else if (code === 'Equal') key = '=';
        else if (code === 'Backquote') key = '`';
        else if (['ControlLeft','ControlRight','AltLeft','AltRight','ShiftLeft','ShiftRight','MetaLeft','MetaRight'].includes(code)) key = null;
        else if (code) key = code; // ArrowLeft, Enter, Escape, Delete, Backspace, Tab, F1.., Home, End...
        else key = (e.key && e.key.length === 1) ? e.key.toUpperCase() : e.key;
        if (!key) return null; // a lone modifier key isn't a valid shortcut

        const parts = [];
        if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');
        parts.push(key);
        return parts.join('+');
    }

    // ── Runtime engine: loads this user's overrides and dispatches matches ──
    let overrides = {};
    const handlers = {};
    let ready = false;

    function effective(id) {
        return Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : (byId(id)?.default || '');
    }

    function on(id, fn) {
        (handlers[id] || (handlers[id] = [])).push(fn);
    }

    async function load() {
        try {
            const cached = localStorage.getItem('tm-shortcuts');
            if (cached) overrides = JSON.parse(cached);
        } catch { /* ignore corrupt cache */ }
        try {
            const res = await fetch('/settings/shortcuts/data');
            if (res.ok) {
                const data = await res.json();
                overrides = data.overrides || {};
                try { localStorage.setItem('tm-shortcuts', JSON.stringify(overrides)); } catch { /* storage full/unavailable */ }
            }
        } catch { /* offline — fall back to cached/default */ }
        ready = true;
    }

    function setOverrides(next) {
        overrides = next || {};
        try { localStorage.setItem('tm-shortcuts', JSON.stringify(overrides)); } catch { /* ignore */ }
    }

    const readyPromise = load();

    document.addEventListener('keydown', e => {
        if (!ready) return;
        const tag = e.target.tagName;
        const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable;
        const combo = describe(e);
        if (!combo) return;
        for (const fn of FUNCTIONS) {
            if (fn.locked) continue;
            if (inInput && !fn.allowInInput) continue;
            const list = handlers[fn.id];
            if (!list || !list.length) continue;
            if (effective(fn.id) === combo) {
                e.preventDefault();
                list.forEach(h => h(e));
                return; // first matching function wins
            }
        }
    });

    root.Shortcuts = { CATEGORIES, FUNCTIONS, byId, describe, on, effective, setOverrides, whenReady: () => readyPromise };
})(window);
