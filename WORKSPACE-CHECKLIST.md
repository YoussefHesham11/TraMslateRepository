# Translator & timer workspace — requirement checklist

Status key: **Available** (existed before this work) · **Added** · **Partial** · **Pending**.
"Verified" names the check that exercises it; *unverified* means implemented but not yet
exercised by an automated or manual check.

## Stage plan

1. Saving integrity (server + client): atomic revision checks, idempotent retries,
   honest save states, auth expiry, offline, history/checkpoints. ← highest priority
2. Validation engine with severities, project rules, waivers; issues panel; navigation.
3. Done button and versioned completion.
4. Import/export safeguards.
5. Editing and timing tools.

## Inventory before changes (2026-10-05)

| Area | Already available | Where |
|---|---|---|
| Add / delete / duplicate / split / merge cues | Yes (split at playhead and at caret; merge next/previous) | `editor.js` ADD EVENT, timeline actions |
| Undo / redo | Yes — snapshot history of the whole track, 100 steps | `editor.js` `recordHistory`/`restoreHistory` |
| Find & replace | Translations only, no preview, no source | Workspace tools → More tools |
| Search + filters | Search source/translation; filters: untranslated, needs attention, status, suggestion, revisor flag | `#cueSearch`, `#cueFilter` |
| Quality checks | Invalid timing, short/long duration, fast reading speed, overlap, short gap, untranslated, long line, too many lines — single severity | `subtitle-core.js` `analyze` |
| Delivery profile | 5 presets + custom limits, **stored in this browser only** | Workspace tools → Delivery spec |
| Per-cue status | Draft / Done / Needs review / Approved (one field mixes translation and review) | `SubtitleEvent.Status` |
| Notes | Translator comment; revisor note, flag, severity, suggestion | `SubtitleEvent` |
| Char counter, CPS badge, duration | Yes | cue card |
| RTL / mixed text | `dir="auto"` on text fields | cue card |
| Playback | Play/pause, ±1s/±5s/±10s/±0.5s, frame step, speed, play cue, run-up play, loop, auto-pause | video bar + timeline |
| Timing | Mark in/out, nudge, grow/shrink, drag/resize on timeline, snapping (cuts, speech, cues, gap, frames), shift all/range/from selected, zero out | timeline, More tools |
| Waveform / shot changes | Yes (cached in IndexedDB) | `waveform.js`, `shots.js` |
| Save | Manual + 2 s autosave debounce, revision check (409), three-way merge with the other seat, temp-id adoption | `doSave`, `SaveEvents` |
| Local recovery | localStorage draft, offered on load | `writeDraft`/`offerDraftRecovery` |
| Multiple tabs | BroadcastChannel warning + stale flag | `editor.js` Other tabs |
| Import | SRT, VTT, DOCX (timed spotting list or plain lines); replace only; confirm | `importScript` |
| Export | SRT, VTT; translation with source fallback; confirm when untranslated | `btnExportSrt`/`btnExportVtt` |
| Shortcuts | Catalogue, per-user overrides, conflict detection, typing guard | `shortcuts.js`, Settings/Shortcuts |
| Project status | Select: In progress / With revisor / Revised / Completed — no validation, no version | topbar `#projectStatus` |

### Gaps found in the existing save path

- The revision check is read-then-write: two saves arriving together can both pass it.
- A save whose response is lost is retried with the old revision and refused as a conflict with itself.
- A cue with in ≥ out cannot be saved at all (client refuses, server rejects), so one bad cue blocks saving everything else.
- An expired sign-in turns the save into a login-page redirect, reported only as "Save failed".
- No request timeout; no offline state; no last-saved time; no history beyond the browser draft.
- The recovered draft is offered without checking whether the server has moved on since.
- Completion is a free status change with no validation and no record of which version was completed.

## Requirements

(Updated as each stage lands.)

### Stage 1 — Saving integrity

| Requirement | Status | Where | Verified |
|---|---|---|---|
| Never overwrite newer changes with an older save | Added: revision is an EF concurrency token, so two racing saves cannot both commit; the loser gets 409 | `AppDbContext`, `SaveEvents` | *unverified against SQL Server* |
| Save reached the server but the response was lost | Added: each save carries a `saveId`; a retry of the same save is answered from the stored result (incl. temp-id mapping) instead of being refused; the editor re-sends an uncertain save unchanged before any newer one | `SaveEvents` replay branch, `doSave`/`uncertainSave` | `save-integrity.test.cjs` (client); server *unverified* |
| Cues and replay record committed together | Added: one transaction | `SaveEvents` | *unverified against SQL Server* |
| Wrong timing never blocks saving | Added: in ≥ out is saved and left to validation/Done; only unreadable timecodes are refused | `SaveEvents`, `doSave` | `save-integrity.test.cjs` |
| Visible states: unsaved, saving, saved (+time), offline, failed (auto-retry 2/5/15/30/60 s), signed out, newer version on server, no access, no local copy | Added | `paintSaveState` | `save-integrity.test.cjs`, `editor-state.test.cjs` |
| "Saved" only when the version on screen is persisted | Added (edits during a save keep it unsaved) | `sendSave` | `save-integrity.test.cjs` |
| Authentication expires | Added: API calls get 401 (not a login redirect); banner offers sign-in in a new tab + Retry; anti-forgery token refreshed after re-sign-in | `Program.cs`, `api()`, `/studio/{id}/token` | `save-integrity.test.cjs` (client) |
| Network disconnect / timeout | Added: 30–45 s timeout via AbortController; offline state; retry on `online` | `api()`, `doSave` | partly (`save-integrity.test.cjs` network rejection) |
| Storage full / denied | Added: banner + "(no local copy)" in the status | `writeDraft` | *unverified* |
| Recovery copy written during editing, and immediately on pagehide/hidden | Added (was debounce-only) | `writeDraft` | *unverified in browser* |
| Recovery copy newer than / based on an older saved version | Added: preview of what it changes; merged three-way when edits don't collide; the saved version is kept in history before restoring; a declined copy is kept on the server, not deleted | `offerDraftRecovery` | `save-integrity.test.cjs`, `editor-state.test.cjs` |
| Conflict: preserve both, offer comparison | Partial: both kept (server copy + local draft), banner with Compare/Export/Reload; the comparison view itself is stage 2 | `enterConflict` | `save-integrity.test.cjs` |
| Version history / checkpoints | Added server side: snapshots every ≤10 min on save, on request, before destructive actions, on completion; pruned to 60 automatic | `ProjectSnapshot`, `/history`, `/checkpoint` | *unverified*; UI pending |
| Settings (profile, glossary, fps, rules) saved with the project | Added (was browser-only) | `SettingsJson`, `projectSettings()` | `save-integrity.test.cjs` |
| Completion cannot be set as a plain status | Added: server refuses `Completed` via status; the select routes to Done; revisor approval now sets `Approved` | `SetStatus`, `ReviewController` | *unverified* |

**Stage 1 verification update (live SQL Server, `server-tour.cjs`):** replayed save answered from its stored result with no duplicate rows; stale save refused; three racing saves → exactly one wins and the revision moves once; out-before-in timing stored; anonymous API call → 401; fresh anti-forgery token. All rows above marked *unverified against SQL Server* are now **verified**.

### Stage 2 — Validation, issues panel, navigation

| Requirement | Status | Where | Verified |
|---|---|---|---|
| Project validation profile with configurable limits | Added: delivery profile (chars/line, lines, CPS, min/max duration, min gap) + rules (require translation, require review, allow overlaps, warnings before Done: reviewed / fixed-or-waived / never, format to check) — saved with the project | `quality.js`, Delivery spec section | `quality.test.cjs` |
| Checks: missing translations, not reviewed, empty text, line length, line count, reading speed, min/max duration, in ≥ out, malformed timecodes, out of order, overlaps, short gaps, beyond media duration, unsupported formatting for the export format, broken tags, whitespace, repeated words, punctuation, unusual/encoding-damaged characters, glossary consistency, open flags, open questions, pending revisor suggestions, revisor flags, "changes needed", import problems | Added | `quality.js` `validate` | `quality.test.cjs` (18 tests incl. Arabic/mixed text and a 2,000-cue timing budget) |
| Blocking errors / warnings / suggestions | Added; structural errors cannot be waived or demoted; uncertain judgements (same as source, glossary, repeated word) are never errors | `CHECKS` catalogue | `quality.test.cjs` |
| Permitted exceptions with a recorded reason | Added: per-line waivers (reason, who, when), listed under "Waived", saved with the cue | waiver dialog, `WaiversJson` | `workspace-check.cjs`, `quality.test.cjs` |
| Issues panel: severity (word + icon, not colour only), subtitle number, timestamp, explanation, suggested action | Added (tabs Errors / Warnings / Suggestions / Waived) | `workspace.js`, `#issuesPanel` | `workspace-check.cjs` |
| Clicking a problem: open the cue, whole card in view, focus + highlight the exact field (and line), plain explanation, fix/safe action, prev/next | Added | `goTo`, callout | `workspace-check.cjs` |
| Timing problems: timeline zoomed to the cue and neighbours, playhead moved, "Play this moment" | Added | `goTo` | `workspace-check.cjs` (play button present) |
| Issues update as you edit; resolved ones clear; caret preserved | Added (350 ms debounce; only panel/Done/hint repainted) | `scheduleValidate`, `refreshCallout` | `workspace-check.cjs` |
| Fixes previewed and undoable; nothing rewritten silently | Added: extend to minimum, shorten to maximum, set out-time from reading speed, open short gap, end before overlapping cue, line-break suggestion (whitespace only, verified), tidy spacing, sort by time (with recovery copy) | `planFix`/`previewFix` | `workspace-check.cjs` (preview, apply, undo) |
| Warnings requiring acknowledgment | Added: per warning or "I have reviewed these N"; an edit to the line voids the acknowledgment | `acknowledge` | `quality.test.cjs` |
| Flags (needs translation / timing / review), questions with resolution, bookmarks, separate review state | Added (marks popover, chips, row icons, saved) | `openMarks`, `SubtitleEvent` columns | `workspace-check.cjs` |
| Filters: untranslated, unfinished, marked, bookmarked, with errors, with warnings, reviewed, not reviewed (+ existing) | Added | `#cueFilter`, `TmWorkspace.matches` | *unverified in browser* |
| Next/previous problem, unfinished, flagged, bookmark; toggle bookmark, mark reviewed, marks, issues panel, history, Done — all in the shortcut catalogue (so customisable, conflict-checked, typing-safe) | Added (F8, F9, Alt+PageUp/Down, F2, Alt+B/V/M/I/H) | `shortcuts.js` | *unverified via real key events* |
| Glossary | Added: project glossary (term, required translation, note), checked per line | Glossary section | `quality.test.cjs` |
| Conflict comparison | Added: side-by-side differing lines; keep mine / use saved; the other stored in history | `openConflict` | `workspace-check.cjs` |
| Version history UI | Added: click the save status (or More tools / Alt+H); preview diff before restoring; current state kept first; "Save as named version" | `openHistory` | `workspace-check.cjs` |
| Missing / replaced media | Added: a banner explains subtitles are safe and timing can't be checked against the picture; media-duration check simply switches off | `video error` handler | *unverified* |

### Stage 3 — Done

| Requirement | Status | Where | Verified |
|---|---|---|---|
| Large Done button at the top without moving existing controls | Added in the centre of the global bar (the editor bar is full at common widths; putting it there pushed existing controls to a second row — checked by screenshot) | `_Layout` `NavCenter` section | layout-check (6 sizes), screenshot |
| Disabled until: translated, reviews done (if required), no blocking errors, warnings handled per rule, flags/questions resolved, saved, fresh full check | Added | `doneState` | `workspace-check.cjs` |
| Plain-language reason next to it; accessible (aria-describedby); separate View issues action | Added | `#doneReason`, `#btnViewIssues` | `workspace-check.cjs` |
| Click: commit edit → validate all → stop at first problem → save that version → mark that revision → summary + export | Added | `startDone` | `workspace-check.cjs`, `server-tour.cjs` |
| No duplicate submissions; edits during validation/save stop an older version being completed | Added (busy lock; edit counter compared before the completion request; server checks the revision again) | `startDone`, `/complete` | `workspace-check.cjs`, `server-tour.cjs` |
| Completion belongs to a version; editing reopens it, previous completion kept | Added (`CompletedRevision`, Completed snapshot; save after completion → InProgress) | `Project`, `SaveEvents` | `server-tour.cjs`, `workspace-check.cjs` |
| Done never publishes or sends | Yes — states so in the summary | `showCompletion` | `workspace-check.cjs` |

### Stage 4 — Import and export

| Requirement | Status | Where | Verified |
|---|---|---|---|
| Number + in/out + multi-line text read as one entry | Available (SRT/VTT), extended to ASS | `formats.js` | `formats.test.cjs` |
| Malformed entries explained, not fatal | Added: unreadable timecode → skipped and reported; no timing line → reported; out-before-in → imported and flagged; empty → imported and flagged; out of order → kept and flagged (sort offered) | `TmFormats.parse` | `formats.test.cjs`, `transfer-check.cjs` |
| SRT, VTT, ASS (and DOCX, existing) | Added ASS/SSA import and export | `formats.js` | `formats.test.cjs` |
| Encoding detection, Unicode preserved | Added: BOM (UTF-8/16), strict UTF-8, else Windows-1256 (Arabic) / 1252, flagged as a guess, with a manual choice that re-reads the preview | `TmFormats.decode` | `formats.test.cjs`, `transfer-check.cjs` |
| Preview before importing | Added: count, format, encoding, problems, sample | `previewImport` | `transfer-check.cjs` |
| Create project / append / replace | Added (new project goes through the normal New Project form, then a normal save) | `applyImport`, `createProject` | `transfer-check.cjs`; new project: `server-tour.cjs` |
| Recoverable checkpoint before replacing | Added (server copy + undo; warns if the server copy failed) | `applyImport` | `transfer-check.cjs` |
| Import problems tracked until dismissed | Added (project-level warnings in the issues panel) | `importIssues` | `transfer-check.cjs` |
| Export validated against format and rules; unsupported styling explained before it is lost | Added | `buildExport`, `TmFormats.losses` | `transfer-check.cjs`, `formats.test.cjs` |
| Exports the intended version and says which | Added ("saved version N" / "including unsaved changes"), with "Save, then download" | export dialog | `transfer-check.cjs` |
| Preview with the chosen settings | Added (rendered as it will read; plain text shows the file) | export dialog | `transfer-check.cjs` |
| Translation / source / bilingual; whole or selected; untranslated → source / blank / skip | Added | `serialize` | `formats.test.cjs`, `transfer-check.cjs` |
| Draft export clearly marked | Added: "- DRAFT" in the file name always; a note inside VTT and ASS files | `serialize` | `transfer-check.cjs` |
| Unplayable timing blocks timed formats, with links to the subtitles | Added (plain text still allowed) | export dialog | `transfer-check.cjs` |
| Failed export keeps the project | Added | `deliver` | `transfer-check.cjs` |
| Download produced ≠ file saved | Added ("your browser was given …; cannot confirm it was saved") | `deliver` | `transfer-check.cjs` |

### Stage 5 — Editing, timing, usability

| Requirement | Status | Where | Verified |
|---|---|---|---|
| Add / delete / duplicate / split / merge | Available | editor | existing tests |
| Reorder | Added: move up/down in the list (Alt+Shift+PageUp/Down); sort by time as a previewed fix | `tools.js` | `tools-check.cjs` |
| Bulk actions on selection with preview (marks, review, status, bookmarks, shift, copy source into empty translations, delete) | Added; recovery copy before deletes and large changes; one undo step | `bulkActions` | `tools-check.cjs` |
| Find & replace in translations and source, with preview | Added (match case, whole words; imported/locked lines reported, not changed) | `findReplace` | `tools-check.cjs` |
| Undo/redo for text, timing and structure | Available (whole-track snapshots); new marks, waivers, fixes and bulk actions land as single steps. Project settings (rules, glossary, acknowledgements) are not in undo | `recordHistory` | `workspace-check.cjs`, `tools-check.cjs` |
| Spellchecking | Partial: text boxes carry `lang` (e.g. `ar`, `en`) and `spellcheck`, so the browser's own dictionary for that language is used; no custom dictionary | `cueCardHtml` | `tools-check.cjs` |
| Terminology consistency + glossary | Added | stage 2 | `quality.test.cjs` |
| Line-break suggestions, never rewording | Added (whitespace-only, verified, previewed) | `suggestLineBreaks` | `quality.test.cjs` |
| Play/pause, frame stepping, configurable short jumps | Available + added a configurable jump (0.5–5 s, J/L) | timeline options | `tools-check.cjs` (J) |
| Loop selected with adjustable time before/after | Added: loop padded by the run-up setting (0–5 s, both sides) | `toggleLoopSelected` | *unverified in browser* |
| Follow playback option | Added ("Keep the playhead centred while playing"; off → playhead travels, view turns the page) | `tickView` | `tools-check.cjs` |
| Drag handles / shortcuts / snapping / move keeping duration / waveform / scene changes | Available (previous round) | timeline | `timeline-check.cjs` |
| Shift selection or whole project ± with preview | Added preview to the existing shift tools | `shiftCues` → `previewTiming` | `tools-check.cjs` |
| Two-point drift correction with preview | Added | `twoPointSync` | `tools-check.cjs` |
| Explicit frame-rate conversion; timestamp vs frame-based explained | Added | `convertFrameRate`, hint text | `tools-check.cjs` |
| Intentional overlaps when rules allow | Added: dragging and drawing no longer stop at a neighbour when overlaps are allowed | `dragLimits`, `freeGapAround` | `tools-check.cjs` |
| Warnings for overlaps, durations, negative/malformed, beyond media | Added (stage 2) | `quality.js` | `quality.test.cjs` |
| No video / missing / replaced media | Available (editor works without video) + banner on media errors | `workspace.js` | *unverified* |
| New actions in the shortcut page, conflicts detected, typing-safe | Added 22 catalogue entries; 0 default conflicts among 86; only F-keys and Alt+PageUp/Down fire inside text fields | `shortcuts.js` | `server-tour.cjs` (page lists them), script check |
| Visible focus, not colour alone | Added focus-visible styles; severity always written out with an icon | `quality.css` | screenshots |
| Progress: translated, reviewed, without errors | Added | `updateWorkspace` | *unverified in browser* |
| Large projects responsive | Validation of ~2,000 cues < 250 ms; issues panel renders ≤ 300 rows (F8 walks all); timeline renders only nearby boxes | | `quality.test.cjs`, `perf.cjs` |
| Light/dark mode | Not applicable: the app has a single dark theme; new styles use its variables | | — |
| Save As | Added: "Save as named version" (history) and "Save a copy as new project" (subtitles, notes, marks, settings; not the video) | `saveNamedVersion`, `saveCopy` | `workspace-check.cjs`, `server-tour.cjs` |

### Bugs found and fixed along the way

- Clicking a box on the timeline left the previously open card open as well (two open cards). Pre-existing; surfaced by the virtualised timeline.
- The character counter showed "0 / 42" for an empty translation whatever the project's limit. Pre-existing.
- The workspace module could miss the editor's load when the server answered before the script ran.
- The Done area kept saying "unsaved" after a save until the next repaint.

## Workflow verification

| Workflow | Check | Result |
|---|---|---|
| Import → translate → time → review → save → Done → export | `transfer-check` (import, export), `workspace-check` (translate via issues, fix timing, review marks, save, Done), `server-tour` (save, Done on SQL Server) | pass |
| Fixing an issue from the issues panel | `workspace-check` | pass |
| Editing during a save | `save-integrity.test`, `workspace-check` (edit during Done's save → not completed) | pass |
| Refresh after unsaved edits and recovering | `workspace-check`, `save-integrity.test` | pass |
| Save failure and retry; lost response | `workspace-check`, `save-integrity.test`, `server-tour` (replay) | pass |
| Concurrent-tab conflict | `workspace-check` (compare, keep mine, theirs kept), `server-tour` (racing saves) | pass |
| Editing a completed project | `workspace-check`, `server-tour` | pass |
| Malformed import and failed export | `transfer-check`, `formats.test` | pass |

Totals at the end of this round: 107 Node tests and 201 browser checks (10 browser checks, 4 of them live-server tours), all passing.

## Limitations and open points

- **Validation runs in the browser.** At Done the server re-checks only the structural rules (out-time after in-time, translations present unless waived, no open flags) and that the revision is current; profile limits (characters, reading speed, …) are trusted from the client.
- **Conflicts** offer a whole-version choice with a side-by-side diff; there is no per-line merge UI (non-conflicting edits are still merged automatically, as before).
- **History restore** restores subtitles, not project settings. Snapshots other than automatic checkpoints are never pruned, so history grows with named versions, imports and bulk changes.
- **Spellcheck** is the browser's own, per language; there is no project dictionary.
- **Encoding detection** recognises BOMs and UTF-8 and otherwise guesses Windows-1256/1252; any other legacy encoding has to be chosen by hand in the preview.
- **ASS**: style blocks are kept as text on import (and flagged for formats that cannot hold them); styles, positions and fonts from `[V4+ Styles]` are not imported, and export writes one default style.
- **Drafts**: SRT and plain text have no place for a note, so only the file name says DRAFT.
- **Not exercised end-to-end**: signing in again in another tab and retrying (the 401 → banner path and the token refresh are each tested); a full browser storage quota; a video that disappears mid-session; loop padding; the progress line.
- **Narrow screens (< 900 px)**: the new panel and dialogs were not reviewed there.
- **F2/F8/F9** may need Fn on some laptop keyboards; all are rebindable.
