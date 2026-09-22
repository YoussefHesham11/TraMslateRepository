# TraMslate project review

TraMslate is an ASP.NET Core MVC subtitle translation application using .NET 10,
SQL Server, Entity Framework Core and Identity. Its workflow is account →
dashboard → project creation → bilingual subtitle editor → SRT/VTT export.

## Earlier improvement passes

- A shared visual refresh for authentication, project creation, dashboard, and editor: clearer contrast, rounded surfaces, keyboard focus, responsive layouts, and reduced-motion support.
- Dashboard search by project/language, status filters, summary counts, and readable status labels. Project status can now be updated in the editor.
- Search and filter subtitle cues; jump to the next untranslated cue; translation progress; per-cue quality guidance for missing translations, timing, overlap, reading speed, and line length.
- Session undo/redo for edits, imports, deletion, and replacement; literal find/replace across translations; copy source into the selected translation.
- Automatic text direction for Arabic and other RTL text. Playback selection no longer rebuilds text fields or interrupts typing. Shift+Tab retains backward navigation.
- Save requests are serialized; changes made during a request remain dirty. Failed initial loading blocks saving, failed saves offer retry, and unsaved work triggers a navigation warning.
- Imported subtitle content is escaped before insertion into HTML. SRT/VTT import handles BOMs, CRLF, cue identifiers, numeric dialogue, short VTT timestamps, and cue settings. Invalid timing blocks export and saving.
- Server validation before replacement of stored cues, restricted project form binding, video extension validation, antiforgery validation on unsafe MVC requests, and owner-authorized media streaming with HTTP range support.
- Split cue at playhead, merge with next, batch timing shift, frame stepping, per-cue comments and per-cue locking.
- Shorter routes: `/login`, `/register`, `/dashboard`, `/projects/new`, `/studio/{id}`.

## This pass

### The reported bug: the timeline covering the cue list

Pressing "next subtitle" could land on a card whose lower half was hidden behind
the timeline. Three separate causes, all now fixed and covered by tests:

1. **The editor shell had no single owner.** `.tm-editor-wrap`, `.tm-editor-body`,
   `.tm-events-header` and `.tm-timeline-wrap` were each declared twice in
   different stylesheets, with different heights. The duplicates are gone; the
   shell is now one authoritative block in `site.css` that pins itself to the
   viewport (`position: fixed`) so no ancestor padding can push it off-screen.
   Only the body row flexes — everything from the timeline handle down is
   `flex: none`, so the timeline cannot overlap the list at any window height.
2. **The cue list had a fixed `height: 500px`.** On a shorter window it ran past
   its panel and behind the timeline. It is now sized from the space left over.
3. **A cue card was taller than the list.** At 141px per card against a 155px
   list on a laptop, no amount of scrolling could show a whole one. Solved by
   the focus-mode list below, a vertical budget that shrinks the chrome on short
   screens, and `fitOpenCard`, which trims the open card's text boxes until the
   card fits and, as a last resort, caps and scrolls it.

### Focus-mode cue list

Only the cue being worked on expands into a full editing card; the rest are
compact one-line rows showing status, number, in-time, duration, source and
translation. A translator sees roughly ten cues of context instead of two, and
the card they are typing in always fits on screen. Rows are rendered as one
HTML string and driven by delegated listeners rather than per-card ones.

### Timeline fixes

- **The ruler and waveform were invisible on any track longer than the viewport.**
  The canvas is meant to be viewport-sized and `position: sticky`, redrawing per
  scroll — but a leftover `width: 100%` stretched it to the full track width
  (63,000px on a ten-minute track), so one viewport-sized bitmap was scaled
  across the whole strip. This affected every real project.
- **Cues past the end of the video fell outside the drawn strip.** The timeline
  sized itself from `video.duration` alone; it now spans the whole track.
- **The timeline works without a video at all**, drawing from the cues. A project
  can be translated before its video is uploaded.
- An unbounded tick loop could hang the page if the zoom level ever became
  non-finite. It is bounded, and the zoom is guarded.

### Performance on long projects

Measured in a real browser at 1500 cues (`tests/browser/perf.cjs`):

| | before | after |
|---|---|---|
| quality sweep | O(n²), ~1s | **0.9 ms** |
| select next cue | 39 ms | **6 ms** |
| one keystroke | — | **5 ms** |
| first render | — | 87 ms |

- `SubtitleCore.analyze` replaces a per-cue O(n²) scan with one O(n log n) sweep.
  A randomised test proves it never disagrees with the original `issues()` rules
  across deliberately messy tracks.
- Quality flags are computed once per change and cached, instead of being
  recomputed by the progress counters, the row dots and the timeline separately.
- Undo snapshots are coalesced: typing settles into one history entry rather
  than serialising the whole track per keystroke.
- Selection styling touches only the rows that change, not all 1500.

### Safety and recovery

- **Optimistic concurrency.** `Project.Revision` is bumped on every save. The
  editor sends back the revision it loaded and the server refuses a save built
  on an older one (409), offering export-then-reload rather than discarding
  whichever tab saved first. Verified end to end: a stale save is refused and
  the stored cues survive intact.
- **Crash recovery.** Every change mirrors into local storage shortly after it is
  made and clears once the server confirms. On reload, a draft that differs from
  the server copy is offered back.
- **Other tabs.** Tabs editing the same project announce themselves over a
  `BroadcastChannel` and warn before either does damage.
- **Saves no longer delete and re-insert every cue.** Rows are matched by
  position and updated in place, so cue ids stay stable (per-cue locks are keyed
  on them) and a one-word change no longer rewrites the whole project.

### Translator features

- **Delivery profiles.** The quality limits — characters per line, lines, reading
  speed, minimum and maximum duration, minimum gap — are now a profile rather
  than hardcoded numbers. Five presets ship as editable starting points, chosen
  and tuned per project. Everything follows them: warnings, the character
  counter, the reading-speed badge and the timeline colours. The default
  reproduces the previous thresholds exactly.
- **Per-cue workflow status** (Draft / Done / Needs review / Approved), stored in
  the database, shown as a chip on each row and filterable. Kept deliberately
  separate from the automatic checks: a line can read too fast and still be
  approved.
- **Dashboard progress.** Each project card shows lines translated, a progress
  bar, cues flagged for review or approved, whether a video is attached, and
  when it was last edited. Projects are ordered by most recent edit, and the
  header totals the lines left across all of them. The counts are computed in
  the query, not by loading every cue.
- Tab and Shift+Tab step between cues; clicking a timeline block opens that cue.

## Validation

```text
dotnet build
node --test tests/*.test.cjs          # 38 unit tests
node tests/browser/check-all.cjs      # layout, workflow and performance in Chrome
node tests/browser/check-all.cjs --app  # …plus a tour of the running application
```

`tests/browser/` drives real headless Chrome over the DevTools protocol. This
matters because the reported bug lived entirely in CSS and in measured
scrolling: a DOM stub in Node cannot see it, and it had already been "fixed"
twice without being observed. The checks are:

- **`layout-check.cjs`** — builds a harness from the real Razor view, stylesheets
  and editor scripts, then asserts at six window sizes (940px down to 460px of
  content height) that the cue list never overlaps the timeline, that the open
  card rests wholly inside the list, and that the translation box is visible.
- **`workflow-check.cjs`** — steps through cues the way a translator does and
  checks what they would see after each press, plus typing, timeline clicks and
  profile switching.
- **`perf.cjs`** — the numbers in the table above, with a budget that fails.
- **`app-tour.cjs`** — signs in, creates a project, saves cues to SQL Server,
  reloads, confirms the round trip including status, and proves a stale save is
  refused without data loss. Cleans up after itself;
  `clean-tour-data.cjs` removes anything a failed run stranded.

Screenshots land in `tests/browser/shots/`.

## Next product work

1. **Translation memory and glossary.** Reuse approved translations and hold
   terminology. Needs persistent models and a matching/review workflow. The
   per-cue comment field is doing some of this job informally today.
2. **Virtualised cue list.** 1500 cues is comfortable now, but the list still
   renders every row (about 12,700 DOM nodes). A 5000-cue box set would want
   windowed rendering.
3. **Server-side audio peaks.** The waveform is decoded in the browser and
   skipped above 128 MB, so long features show the honest "unavailable" message.
4. **Revision history.** Undo lasts for the open page; the revision counter now
   makes stored history straightforward to add.
5. **Optional machine translation** with provider configuration, cost controls
   and human review. No AI output is generated today.
6. **Production hardening.** Streaming uploads and content inspection, upload
   cleanup on failed creation, password recovery and lockout, database-backed
   integration tests, and a documented backup/deployment process.

Legacy empty files remain: `Controllers/SubtitleController.cs`,
`Views/Subtitle/Editor.cshtml` and `Views/Project/Dashboard.cshtml` are unused
and can be deleted once nothing is found to reference them.
