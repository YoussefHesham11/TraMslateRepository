using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using TraMslate.Data;
using TraMslate.Models;
using TraMslate.Services;
using TraMslate.ViewModels;

namespace TraMslate.Controllers
{
    [Authorize]
    public class ProjectController : Controller
    {
        private readonly AppDbContext _db;
        private readonly UserManager<ApplicationUser> _userManager;
        private readonly IWebHostEnvironment _env;
        private readonly ProjectAccess _access;

        public ProjectController(AppDbContext db,
                                 UserManager<ApplicationUser> userManager,
                                 IWebHostEnvironment env,
                                 ProjectAccess access)
        {
            _db = db;
            _userManager = userManager;
            _env = env;
            _access = access;
        }

        private Task<ProjectContext?> Resolve(int id, bool tracking = true) =>
            _access.ResolveAsync(id, _userManager.GetUserId(User), tracking);

        // ── Create GET ────────────────────────────────
        [HttpGet("projects/new")]
        public IActionResult Create() => View();

        // ── Create POST ───────────────────────────────
        [HttpPost("projects/new")]
        [RequestSizeLimit(2_147_483_648)]
        [RequestFormLimits(MultipartBodyLengthLimit = 2_147_483_648)]
        public async Task<IActionResult> Create([Bind("Title,Description,SourceLanguage,TargetLanguage")] Project model, IFormFile? VideoFile)
        {
            if (string.IsNullOrWhiteSpace(model.Title) || model.Title.Length > 200)
                ModelState.AddModelError(nameof(model.Title), "Enter a project title of up to 200 characters.");
            if (string.IsNullOrWhiteSpace(model.SourceLanguage) || string.IsNullOrWhiteSpace(model.TargetLanguage))
                ModelState.AddModelError(nameof(model.TargetLanguage), "Choose source and target languages.");
            if (VideoFile is { Length: > 0 } && !IsVideoFile(VideoFile))
                ModelState.AddModelError("VideoFile", "Choose a video file. MP4 or WebM is recommended for browser playback.");
            if (!ModelState.IsValid) return View(model);

            if (VideoFile is { Length: > 0 })
                model.VideoPath = await StoreVideoAsync(VideoFile);

            model.UserId    = _userManager.GetUserId(User)!;
            model.CreatedAt = DateTime.UtcNow;
            model.Status    = ProjectStatus.InProgress;

            _db.Projects.Add(model);
            await _db.SaveChangesAsync();

            return RedirectToAction("Editor", new { id = model.Id });
        }

        // ── Video storage ─────────────────────────────
        private static readonly string[] VideoExtensions = { ".mp4", ".webm", ".ogg", ".mov", ".mkv", ".avi" };

        private static bool IsVideoFile(IFormFile file) =>
            VideoExtensions.Contains(Path.GetExtension(file.FileName).ToLowerInvariant());

        // Uploads get a random name so one project's file can never be reached
        // by guessing another's; they are served only through Media below.
        private async Task<string> StoreVideoAsync(IFormFile file)
        {
            var uploadsDir = Path.Combine(_env.WebRootPath, "uploads");
            Directory.CreateDirectory(uploadsDir);
            var fileName = $"{Guid.NewGuid()}{Path.GetExtension(file.FileName).ToLowerInvariant()}";
            await using var stream = new FileStream(Path.Combine(uploadsDir, fileName), FileMode.CreateNew);
            await file.CopyToAsync(stream);
            return $"/uploads/{fileName}";
        }

        private void DeleteStoredVideo(string? videoPath)
        {
            if (string.IsNullOrEmpty(videoPath)) return;
            var path = Path.Combine(_env.WebRootPath, "uploads", Path.GetFileName(videoPath));
            try { if (System.IO.File.Exists(path)) System.IO.File.Delete(path); }
            catch (IOException) { /* still being streamed; an orphaned file is harmless */ }
        }

        // ── Project settings ──────────────────────────
        // Everything chosen at creation can be changed later — most importantly
        // the video, which translators often receive after the script.
        [HttpGet("studio/{id:int}/settings")]
        public async Task<IActionResult> Settings(int id)
        {
            var context = await Resolve(id, tracking: false);
            if (context == null) return NotFound();
            if (!context.CanManage) return Forbid();
            return View(context.Project);
        }

        [HttpPost("studio/{id:int}/settings")]
        [RequestSizeLimit(2_147_483_648)]
        [RequestFormLimits(MultipartBodyLengthLimit = 2_147_483_648)]
        public async Task<IActionResult> Settings(int id,
            [Bind("Title,Description,SourceLanguage,TargetLanguage")] Project model,
            IFormFile? VideoFile, bool removeVideo = false)
        {
            var context = await Resolve(id);
            if (context == null) return NotFound();
            if (!context.CanManage) return Forbid();
            var project = context.Project;

            if (string.IsNullOrWhiteSpace(model.Title) || model.Title.Length > 200)
                ModelState.AddModelError(nameof(model.Title), "Enter a project title of up to 200 characters.");
            if (string.IsNullOrWhiteSpace(model.SourceLanguage) || string.IsNullOrWhiteSpace(model.TargetLanguage))
                ModelState.AddModelError(nameof(model.TargetLanguage), "Choose source and target languages.");
            if ((model.Description?.Length ?? 0) > 2000)
                ModelState.AddModelError(nameof(model.Description), "Keep the description under 2,000 characters.");
            if (VideoFile is { Length: > 0 } && !IsVideoFile(VideoFile))
                ModelState.AddModelError("VideoFile", "Choose a video file. MP4 or WebM is recommended for browser playback.");
            if (!ModelState.IsValid)
            {
                model.Id = project.Id;
                model.VideoPath = project.VideoPath;
                return View(model);
            }

            project.Title          = model.Title.Trim();
            project.Description    = string.IsNullOrWhiteSpace(model.Description) ? null : model.Description.Trim();
            project.SourceLanguage = model.SourceLanguage;
            project.TargetLanguage = model.TargetLanguage;

            // The old file is only deleted once the new one is safely stored
            // and recorded, so a failed upload never leaves the project with
            // no video at all.
            var oldVideo = project.VideoPath;
            if (VideoFile is { Length: > 0 })
                project.VideoPath = await StoreVideoAsync(VideoFile);
            else if (removeVideo)
                project.VideoPath = null;

            project.UpdatedAt = DateTime.UtcNow;
            await _db.SaveChangesAsync();
            if (oldVideo != project.VideoPath) DeleteStoredVideo(oldVideo);

            TempData["SettingsNotice"] = "Project settings saved.";
            return RedirectToAction(nameof(Settings), new { id });
        }

        // ── Editor ────────────────────────────────────
        [HttpGet("studio/{id:int}")]
        public async Task<IActionResult> Editor(int id)
        {
            var context = await Resolve(id, tracking: false);
            if (context == null) return NotFound();

            // The editor is one screen in two modes; the view and the scripts
            // branch on this rather than there being a separate revisor page.
            ViewBag.Role = context.Role.ToString();
            ViewBag.IsOwner = context.IsOwner;
            ViewBag.CanEditTranslation = context.CanEditTranslation;
            ViewBag.CanReview = context.CanReview;

            ViewBag.OpenRound = await _db.ReviewRounds
                .AsNoTracking()
                .Where(r => r.ProjectId == id && r.SubmittedAt == null)
                .OrderByDescending(r => r.Number)
                .Select(r => new { r.Id, r.Number })
                .FirstOrDefaultAsync();

            ViewBag.LastRound = await _db.ReviewRounds
                .AsNoTracking()
                .Where(r => r.ProjectId == id && r.SubmittedAt != null)
                .OrderByDescending(r => r.Number)
                .Select(r => new ReviewSummary
                {
                    Number          = r.Number,
                    Notes           = r.Notes,
                    Verdict         = r.Verdict,
                    SubmittedAt     = r.SubmittedAt,
                    SuggestionCount = r.SuggestionCount,
                    FlagCount       = r.FlagCount,
                    ReviewerName    = r.Reviewer!.FullName,
                })
                .FirstOrDefaultAsync();

            return View(context.Project);
        }

        // ── Get Events ────────────────────────────────
        [HttpGet("studio/{id:int}/media")]
        public async Task<IActionResult> Media(int id)
        {
            var context = await Resolve(id, tracking: false);
            var project = context?.Project;
            if (project?.VideoPath == null) return NotFound();
            var fileName = Path.GetFileName(project.VideoPath);
            var path = Path.Combine(_env.WebRootPath, "uploads", fileName);
            if (!System.IO.File.Exists(path)) return NotFound();
            var types = new Microsoft.AspNetCore.StaticFiles.FileExtensionContentTypeProvider();
            if (!types.TryGetContentType(path, out var contentType)) contentType = "application/octet-stream";
            return PhysicalFile(path, contentType, enableRangeProcessing: true);
        }

        [HttpPost("studio/{id:int}/status")]
        public async Task<IActionResult> SetStatus(int id, ProjectStatus status)
        {
            if (!Enum.IsDefined(status)) return BadRequest();
            var context = await Resolve(id);
            if (context == null) return NotFound();
            // A revisor reports a verdict by submitting their round; letting
            // them set the status directly would let them mark work complete
            // without leaving any record of having reviewed it.
            if (!context.IsTranslator) return Forbid();
            // Completed is only reachable through Done, which validates and
            // ties completion to a saved revision.
            if (status == ProjectStatus.Completed)
                return BadRequest(new { success = false, useDone = true, message = "Use Done to mark the project complete — it checks and saves the finished version first." });
            context.Project.Status = status;
            context.Project.UpdatedAt = DateTime.UtcNow;
            await _db.SaveChangesAsync();
            return Json(new { success = true });
        }

        [HttpGet("studio/{id:int}/events")]
        public async Task<IActionResult> GetEvents(int id)
        {
            var context = await Resolve(id, tracking: false);
            if (context == null) return NotFound();
            var project = context.Project;

            // The editor echoes this revision back on save; see SaveEvents.
            return Json(new
            {
                revision = project.Revision,
                role = context.Role.ToString(),
                events = await ProjectEvents(id),
                settings = project.SettingsJson,
                status = project.Status.ToString(),
                completedRevision = project.CompletedRevision,
                completedAt = project.CompletedAt,
                updatedAt = project.UpdatedAt,
            });
        }

        // The shape the editor works with, shared by load, save and history.
        private Task<List<CueView>> ProjectEvents(int id) =>
            _db.SubtitleEvents
                .AsNoTracking()
                .Where(e => e.ProjectId == id)
                .OrderBy(e => e.Index)
                .Select(e => new CueView
                {
                    Id                     = e.Id,
                    Index                  = e.Index,
                    StartTime              = e.StartTime,
                    EndTime                = e.EndTime,
                    OriginalText           = e.OriginalText,
                    TranslatedText         = e.TranslatedText,
                    OriginalLocked         = e.OriginalLocked,
                    Comment                = e.Comment,
                    Status                 = (int)e.Status,
                    SuggestedText          = e.SuggestedText,
                    SuggestionState        = (int)e.SuggestionState,
                    PreviousTranslatedText = e.PreviousTranslatedText,
                    ReviewFlag             = (int)e.ReviewFlag,
                    ReviewSeverity         = (int)e.ReviewSeverity,
                    ReviewNote             = e.ReviewNote,
                    Flags                  = (int)e.Flags,
                    Bookmarked             = e.Bookmarked,
                    ReviewState            = (int)e.ReviewState,
                    CommentResolved        = e.CommentResolved,
                    WaiversJson            = e.WaiversJson,
                })
                .ToListAsync();

        private static readonly System.Text.Json.JsonSerializerOptions JsonWeb = new(System.Text.Json.JsonSerializerDefaults.Web);

        private static readonly string TimecodeFormat = @"hh\:mm\:ss\,fff";

        private static bool TryParseTimecode(string? value, out TimeSpan time) =>
            TimeSpan.TryParseExact(value, TimecodeFormat, System.Globalization.CultureInfo.InvariantCulture, out time);

        // ── Save Events ───────────────────────────────
        [HttpPost("studio/{id:int}/save")]
        [RequestSizeLimit(64 * 1024 * 1024)]
        public async Task<IActionResult> SaveEvents(int id, [FromBody] SaveRequest? request)
        {
            var context = await Resolve(id);
            if (context == null) return NotFound();
            var project = context.Project;

            var dtos = request?.Events;
            if (!ModelState.IsValid || dtos == null || dtos.Count > 10000)
                return BadRequest(new { success = false, message = "Supply up to 10,000 valid subtitle cues." });
            if ((request!.SaveId?.Length ?? 0) > 64 || (request.SettingsJson?.Length ?? 0) > 2_000_000)
                return BadRequest(new { success = false, message = "The save request was malformed." });

            // The same save, retried because its response never arrived: it
            // already landed, so answer as it would have been answered. Without
            // this, the retry is refused as a conflict with the editor's own
            // earlier write.
            if (!string.IsNullOrEmpty(request.SaveId) && request.SaveId == project.LastSaveId
                && request.Revision is int retried && retried == project.Revision - 1)
            {
                var replay = project.LastSaveResultJson != null
                    ? System.Text.Json.JsonSerializer.Deserialize<List<AssignedId>>(project.LastSaveResultJson, JsonWeb)
                    : new List<AssignedId>();
                return Json(new
                {
                    success = true, replayed = true, revision = project.Revision,
                    assigned = replay, events = await ProjectEvents(id),
                    savedAt = project.UpdatedAt, status = project.Status.ToString(),
                    completedRevision = project.CompletedRevision,
                });
            }

            // Someone else has saved since this editor loaded. Refusing here is
            // the whole point: the alternative is one tab silently discarding
            // an hour of work done in another.
            if (request.Revision is int seen && seen != project.Revision)
                return Conflict(new
                {
                    success = false,
                    conflict = true,
                    revision = project.Revision,
                    message = "This project was saved somewhere else after you opened it."
                });

            // Timing that is *wrong* (out before in, overlaps) is still saved:
            // the quality checks and Done deal with it, and refusing the save
            // would put every other line's work at risk over one bad cue. Only
            // timing that cannot be stored at all is refused.
            var parsed = new List<(TimeSpan Start, TimeSpan End)>();
            foreach (var dto in dtos)
            {
                if (dto == null || !TryParseTimecode(dto.StartTime, out var start) || !TryParseTimecode(dto.EndTime, out var end)
                    || start < TimeSpan.Zero || end < TimeSpan.Zero
                    || (dto.OriginalText?.Length ?? 0) > 10000 || (dto.TranslatedText?.Length ?? 0) > 10000
                    || (dto.Comment?.Length ?? 0) > 2000 || (dto.WaiversJson?.Length ?? 0) > 8000)
                    return BadRequest(new { success = false, message = "Each cue needs readable timecodes, text under 10,000 characters, and a comment under 2,000 characters." });
                parsed.Add((start, end));
            }

            // Rows are matched to cues by id, not by position. Matching by
            // position meant that inserting, splitting or deleting a line slid
            // everything the server alone keeps for a row — the revisor's
            // suggestion, flag and note — onto whichever line now sat there.
            // Cues the editor created carry a negative temporary id and become
            // new rows; stored rows the editor no longer sends were deleted.
            var existing = await _db.SubtitleEvents
                .Where(e => e.ProjectId == id)
                .ToListAsync();
            var byId = existing.ToDictionary(e => e.Id);
            var kept = new HashSet<int>();
            var rows = new List<SubtitleEvent>(dtos.Count);
            var created = new List<(int TempId, SubtitleEvent Row)>();

            foreach (var dto in dtos)
            {
                // A duplicate id would otherwise let one row be claimed twice.
                if (dto.Id is int known && byId.TryGetValue(known, out var match) && kept.Add(known))
                {
                    rows.Add(match);
                    continue;
                }
                var fresh = new SubtitleEvent { ProjectId = id };
                rows.Add(fresh);
                created.Add((dto.Id ?? 0, fresh));
            }

            // A revisor edits timing and proposes wording, but the shape of the
            // track is the translator's: adding, splitting or removing a line
            // from the revisor's seat would strand translations the server
            // refuses to take from them.
            if (!context.CanEditTranslation && (created.Count > 0 || kept.Count != existing.Count))
                return BadRequest(new { success = false, message = "Only the translator can add, split, merge or delete lines. Reload to get the current version." });

            foreach (var row in created.Select(c => c.Row))
                _db.SubtitleEvents.Add(row);

            for (int i = 0; i < dtos.Count; i++)
            {
                var dto    = dtos[i];
                var row    = rows[i];
                var status = Enum.IsDefined(typeof(CueStatus), dto.Status) ? (CueStatus)dto.Status : CueStatus.Draft;

                // Timing and the source belong to whoever is in the project;
                // everything else depends on which side of the review they are.
                row.Index          = i + 1;
                row.StartTime      = parsed[i].Start;
                row.EndTime        = parsed[i].End;
                row.OriginalText   = dto.OriginalText;
                row.OriginalLocked = dto.OriginalLocked;
                row.UpdatedAt      = DateTime.UtcNow;

                // Workflow marks belong to both seats: either may flag a line
                // for timing, bookmark it, or record that it has been reviewed.
                row.Flags       = (CueFlags)(dto.Flags & 0b1111);
                row.Bookmarked  = dto.Bookmarked;
                row.ReviewState = Enum.IsDefined(typeof(CueReviewState), dto.ReviewState)
                    ? (CueReviewState)dto.ReviewState : CueReviewState.NotReviewed;

                if (context.CanEditTranslation)
                {
                    row.TranslatedText         = dto.TranslatedText ?? string.Empty;
                    row.PreviousTranslatedText = dto.PreviousTranslatedText;
                    row.Comment                = dto.Comment;
                    row.CommentResolved        = dto.CommentResolved;
                    row.WaiversJson            = string.IsNullOrWhiteSpace(dto.WaiversJson) || dto.WaiversJson == "[]" ? null : dto.WaiversJson;
                    row.Status                 = status;
                    // The translator decides what becomes of a suggestion, but
                    // never what it says.
                    row.SuggestionState = Enum.IsDefined(typeof(SuggestionState), dto.SuggestionState)
                        ? (SuggestionState)dto.SuggestionState
                        : row.SuggestionState;
                }

                if (context.CanReview)
                {
                    // Only store a suggestion where it actually differs from the
                    // line it replaces. The revisor's box starts pre-filled with
                    // the translation, so without this every cue they opened
                    // would come back looking like a proposed change.
                    var suggested = (dto.SuggestedText ?? string.Empty).Replace("\r\n", "\n");
                    var current   = (row.TranslatedText ?? string.Empty).Replace("\r\n", "\n");
                    var changed   = suggested.Trim().Length > 0 && suggested != current;

                    row.SuggestedText = changed ? suggested : null;
                    // Leave a decided suggestion alone: re-proposing something
                    // the translator has already dismissed would hide their answer.
                    if (row.SuggestionState is SuggestionState.None or SuggestionState.Pending)
                        row.SuggestionState = changed ? SuggestionState.Pending : SuggestionState.None;

                    row.ReviewFlag = Enum.IsDefined(typeof(ReviewFlag), dto.ReviewFlag)
                        ? (ReviewFlag)dto.ReviewFlag : ReviewFlag.None;
                    row.ReviewSeverity = Enum.IsDefined(typeof(ReviewSeverity), dto.ReviewSeverity)
                        ? (ReviewSeverity)dto.ReviewSeverity : ReviewSeverity.None;
                    row.ReviewNote = dto.ReviewNote;
                }
            }

            _db.SubtitleEvents.RemoveRange(existing.Where(e => !kept.Contains(e.Id)));

            // Project settings (validation profile, glossary, frame rate) are
            // the translator's to set.
            if (context.CanEditTranslation && request.SettingsJson != null)
                project.SettingsJson = request.SettingsJson;

            // Editing a completed project reopens it. The completion record and
            // its snapshot stay, so the last completed version is still there.
            if (project.Status == ProjectStatus.Completed)
                project.Status = ProjectStatus.InProgress;

            project.Revision  += 1;
            project.UpdatedAt  = DateTime.UtcNow;
            project.LastSaveId = request.SaveId;

            // Both writes below land together or not at all: a save that
            // committed its cues but not its replay record would answer a
            // retry with the previous save's ids and duplicate new lines.
            await using var tx = await _db.Database.BeginTransactionAsync();
            try
            {
                await _db.SaveChangesAsync();
            }
            catch (DbUpdateConcurrencyException)
            {
                // Another save committed between our read and our write. The
                // transaction rolled back; answer exactly as the check above
                // would have if the other save had arrived a moment earlier.
                var current = await _db.Projects.AsNoTracking().Where(p => p.Id == id).Select(p => p.Revision).FirstAsync();
                return Conflict(new { success = false, conflict = true, revision = current,
                                      message = "This project was saved somewhere else at the same moment." });
            }

            // The editor keeps using its temporary ids until it reloads, so it
            // is told which stored row each one became; otherwise its next save
            // would create the same lines a second time.
            var assigned = created
                .Where(c => c.TempId < 0)
                .Select(c => new AssignedId { Temp = c.TempId, Id = c.Row.Id })
                .ToList();
            var saved = await ProjectEvents(id);

            // Remember this save's answer for a retry whose response was lost,
            // and keep a checkpoint now and then for the version history.
            project.LastSaveResultJson = System.Text.Json.JsonSerializer.Serialize(assigned, JsonWeb);
            var kind = request.Checkpoint?.Kind is int k && Enum.IsDefined(typeof(SnapshotKind), k) ? (SnapshotKind?)k : null;
            if (kind != null || !await _db.ProjectSnapshots.AnyAsync(s => s.ProjectId == id && s.CreatedAt > DateTime.UtcNow.AddMinutes(-10)))
                AddSnapshot(project, kind ?? SnapshotKind.Checkpoint, request.Checkpoint?.Label, saved, project.SettingsJson);
            await _db.SaveChangesAsync();
            await tx.CommitAsync();
            await PruneSnapshots(id);

            return Json(new
            {
                success = true, revision = project.Revision, assigned, events = saved,
                savedAt = project.UpdatedAt, status = project.Status.ToString(),
                completedRevision = project.CompletedRevision,
            });
        }

        // ── Version history ───────────────────────────
        private void AddSnapshot(Project project, SnapshotKind kind, string? label, IReadOnlyCollection<CueView> cues, string? settings)
        {
            _db.ProjectSnapshots.Add(new ProjectSnapshot
            {
                ProjectId       = project.Id,
                Revision        = project.Revision,
                Kind            = kind,
                Label           = string.IsNullOrWhiteSpace(label) ? null : label.Trim()[..Math.Min(label.Trim().Length, 200)],
                CreatedAt       = DateTime.UtcNow,
                UserId          = _userManager.GetUserId(User)!,
                EventsJson      = System.Text.Json.JsonSerializer.Serialize(cues, JsonWeb),
                SettingsJson    = settings,
                CueCount        = cues.Count,
                TranslatedCount = cues.Count(c => !string.IsNullOrWhiteSpace(c.TranslatedText)),
            });
        }

        // Automatic checkpoints are thinned out; anything a person asked for,
        // or that guards a destructive change or a completion, is kept.
        private async Task PruneSnapshots(int projectId)
        {
            var stale = await _db.ProjectSnapshots
                .Where(s => s.ProjectId == projectId && s.Kind == SnapshotKind.Checkpoint)
                .OrderByDescending(s => s.CreatedAt)
                .Skip(60)
                .ToListAsync();
            if (stale.Count == 0) return;
            _db.ProjectSnapshots.RemoveRange(stale);
            await _db.SaveChangesAsync();
        }

        [HttpGet("studio/{id:int}/history")]
        public async Task<IActionResult> History(int id)
        {
            var context = await Resolve(id, tracking: false);
            if (context == null) return NotFound();
            var list = await _db.ProjectSnapshots
                .AsNoTracking()
                .Where(s => s.ProjectId == id)
                .OrderByDescending(s => s.CreatedAt)
                .Select(s => new
                {
                    s.Id, s.Revision, kind = s.Kind.ToString(), s.Label, s.CreatedAt,
                    s.CueCount, s.TranslatedCount,
                    by = _db.Users.Where(u => u.Id == s.UserId).Select(u => u.FullName).FirstOrDefault(),
                })
                .Take(200)
                .ToListAsync();
            return Json(new { snapshots = list, completedRevision = context.Project.CompletedRevision });
        }

        [HttpGet("studio/{id:int}/history/{snapshotId:int}")]
        public async Task<IActionResult> Snapshot(int id, int snapshotId)
        {
            var context = await Resolve(id, tracking: false);
            if (context == null) return NotFound();
            var snap = await _db.ProjectSnapshots.AsNoTracking()
                .FirstOrDefaultAsync(s => s.Id == snapshotId && s.ProjectId == id);
            if (snap == null) return NotFound();
            return Content(
                $"{{\"id\":{snap.Id},\"revision\":{snap.Revision},\"kind\":\"{snap.Kind}\",\"createdAt\":{System.Text.Json.JsonSerializer.Serialize(snap.CreatedAt)},\"settings\":{System.Text.Json.JsonSerializer.Serialize(snap.SettingsJson)},\"events\":{snap.EventsJson}}}",
                "application/json");
        }

        /// <summary>
        /// Stores the editor's *current* track — saved or not — as a recovery
        /// copy, before an import, a bulk change, a restore, or when a save
        /// conflicted. Does not touch the project itself.
        /// </summary>
        [HttpPost("studio/{id:int}/checkpoint")]
        [RequestSizeLimit(64 * 1024 * 1024)]
        public async Task<IActionResult> Checkpoint(int id, [FromBody] CheckpointRequest? request)
        {
            var context = await Resolve(id, tracking: false);
            if (context == null) return NotFound();
            if (request?.Events == null || !Enum.IsDefined(typeof(SnapshotKind), request.Kind))
                return BadRequest(new { success = false, message = "Nothing to keep." });
            if (request.Events.Value.ValueKind != System.Text.Json.JsonValueKind.Array || request.Events.Value.GetArrayLength() > 10000)
                return BadRequest(new { success = false, message = "Nothing to keep." });

            var cues = request.Events.Value.EnumerateArray().ToList();
            var label = request.Label?.Trim();
            _db.ProjectSnapshots.Add(new ProjectSnapshot
            {
                ProjectId       = id,
                Revision        = request.Revision ?? context.Project.Revision,
                Kind            = (SnapshotKind)request.Kind,
                Label           = string.IsNullOrEmpty(label) ? null : label[..Math.Min(label.Length, 200)],
                CreatedAt       = DateTime.UtcNow,
                UserId          = _userManager.GetUserId(User)!,
                EventsJson      = request.Events.Value.GetRawText(),
                SettingsJson    = request.SettingsJson,
                CueCount        = cues.Count,
                TranslatedCount = cues.Count(c => c.TryGetProperty("translatedText", out var t)
                                                  && t.ValueKind == System.Text.Json.JsonValueKind.String
                                                  && !string.IsNullOrWhiteSpace(t.GetString())),
            });
            await _db.SaveChangesAsync();
            return Json(new { success = true });
        }

        // ── Completion ────────────────────────────────
        /// <summary>
        /// Marks one saved revision complete. The editor validates the whole
        /// project and saves before calling this; the server checks again that
        /// the revision it is asked about is the latest one and that nothing
        /// structurally broken or untranslated slipped through, so a stale or
        /// unchecked version can never be the one recorded as done.
        /// </summary>
        [HttpPost("studio/{id:int}/complete")]
        public async Task<IActionResult> Complete(int id, [FromBody] CompleteRequest? request)
        {
            var context = await Resolve(id);
            if (context == null) return NotFound();
            if (!context.CanEditTranslation) return Forbid();
            var project = context.Project;
            if (request?.Revision is not int revision)
                return BadRequest(new { success = false, message = "Say which version is done." });

            if (revision != project.Revision)
                return Conflict(new { success = false, conflict = true, revision = project.Revision,
                                      message = "The project changed after it was checked. Check it again before marking it done." });
            if (project.CompletedRevision == revision && project.Status == ProjectStatus.Completed)
                return Json(new { success = true, completedRevision = revision, completedAt = project.CompletedAt, already = true });

            var cues = await ProjectEvents(id);
            var problems = new List<string>();
            if (cues.Count == 0) problems.Add("the project has no subtitles");
            var badTiming = cues.Count(c => c.EndTime <= c.StartTime);
            if (badTiming > 0) problems.Add($"{badTiming} subtitle{(badTiming == 1 ? " has" : "s have")} an out-time that is not after the in-time");
            var untranslated = cues.Count(c => string.IsNullOrWhiteSpace(c.TranslatedText) && !Waives(c.WaiversJson, "text.untranslated"));
            if (untranslated > 0) problems.Add($"{untranslated} subtitle{(untranslated == 1 ? " is" : "s are")} untranslated");
            var flagged = cues.Count(c => c.Flags != 0);
            if (flagged > 0) problems.Add($"{flagged} subtitle{(flagged == 1 ? " is" : "s are")} still flagged");
            if (problems.Count > 0)
                return UnprocessableEntity(new { success = false, message = "Not done yet: " + string.Join("; ", problems) + "." });

            project.Status            = ProjectStatus.Completed;
            project.CompletedRevision = revision;
            project.CompletedAt       = DateTime.UtcNow;
            project.CompletedById     = _userManager.GetUserId(User);
            project.CompletionSummary = request.Summary is { Length: > 4000 } s ? s[..4000] : request.Summary;
            AddSnapshot(project, SnapshotKind.Completed, $"Done — version {revision}", cues, project.SettingsJson);
            try
            {
                await _db.SaveChangesAsync();
            }
            catch (DbUpdateConcurrencyException)
            {
                return Conflict(new { success = false, conflict = true,
                                      message = "The project was saved again while it was being marked done. Check it again." });
            }
            return Json(new { success = true, completedRevision = revision, completedAt = project.CompletedAt });
        }

        private static bool Waives(string? waiversJson, string code)
        {
            if (string.IsNullOrEmpty(waiversJson)) return false;
            try
            {
                using var doc = System.Text.Json.JsonDocument.Parse(waiversJson);
                return doc.RootElement.ValueKind == System.Text.Json.JsonValueKind.Array
                    && doc.RootElement.EnumerateArray().Any(w => w.TryGetProperty("code", out var c) && c.GetString() == code
                        && w.TryGetProperty("reason", out var r) && !string.IsNullOrWhiteSpace(r.GetString()));
            }
            catch (System.Text.Json.JsonException) { return false; }
        }

        // ── Session upkeep ────────────────────────────
        /// <summary>
        /// A fresh anti-forgery token. After the sign-in expires and the person
        /// signs in again (in another tab), the token this page was rendered
        /// with belongs to the old session, so retrying a save needs this one.
        /// </summary>
        [HttpGet("studio/{id:int}/token")]
        public async Task<IActionResult> Token(int id, [FromServices] Microsoft.AspNetCore.Antiforgery.IAntiforgery antiforgery)
        {
            var context = await Resolve(id, tracking: false);
            if (context == null) return NotFound();
            Response.Headers.CacheControl = "no-store";
            return Json(new { token = antiforgery.GetAndStoreTokens(HttpContext).RequestToken });
        }
    }

    public class CueView
    {
        public int      Id                     { get; set; }
        public int      Index                  { get; set; }
        [System.Text.Json.Serialization.JsonIgnore] public TimeSpan StartTime { get; set; }
        [System.Text.Json.Serialization.JsonIgnore] public TimeSpan EndTime   { get; set; }
        [System.Text.Json.Serialization.JsonPropertyName("startTime")]
        public string   StartTimecode => StartTime.ToString(@"hh\:mm\:ss\,fff");
        [System.Text.Json.Serialization.JsonPropertyName("endTime")]
        public string   EndTimecode   => EndTime.ToString(@"hh\:mm\:ss\,fff");
        public string?  OriginalText           { get; set; }
        public string?  TranslatedText         { get; set; }
        public bool     OriginalLocked         { get; set; }
        public string?  Comment                { get; set; }
        public int      Status                 { get; set; }
        public string?  SuggestedText          { get; set; }
        public int      SuggestionState        { get; set; }
        public string?  PreviousTranslatedText { get; set; }
        public int      ReviewFlag             { get; set; }
        public int      ReviewSeverity         { get; set; }
        public string?  ReviewNote             { get; set; }
        public int      Flags                  { get; set; }
        public bool     Bookmarked             { get; set; }
        public int      ReviewState            { get; set; }
        public bool     CommentResolved        { get; set; }
        public string?  WaiversJson            { get; set; }
    }

    public class AssignedId
    {
        public int Temp { get; set; }
        public int Id { get; set; }
    }

    public class SaveRequest
    {
        /// <summary>
        /// The project revision the editor had when it loaded, echoed back so a
        /// save built on stale data can be rejected. Null skips the check, which
        /// is what a deliberate "overwrite anyway" does.
        /// </summary>
        public int? Revision { get; set; }
        /// <summary>Unique per save attempt, reused on retry; see LastSaveId.</summary>
        public string? SaveId { get; set; }
        public string? SettingsJson { get; set; }
        public CheckpointHint? Checkpoint { get; set; }
        public List<SubtitleEventDto>? Events { get; set; }
    }

    public class CheckpointHint
    {
        public int Kind { get; set; }
        public string? Label { get; set; }
    }

    public class CheckpointRequest
    {
        public int Kind { get; set; }
        public string? Label { get; set; }
        public int? Revision { get; set; }
        public string? SettingsJson { get; set; }
        public System.Text.Json.JsonElement? Events { get; set; }
    }

    public class CompleteRequest
    {
        public int? Revision { get; set; }
        public string? Summary { get; set; }
    }

    public class SubtitleEventDto
    {
        /// <summary>The stored row's id, or a negative temporary id for a new cue.</summary>
        public int?    Id             { get; set; }
        public string  StartTime      { get; set; } = string.Empty;
        public string  EndTime        { get; set; } = string.Empty;
        public string? OriginalText   { get; set; }
        public string? TranslatedText { get; set; }
        public bool    OriginalLocked { get; set; }
        public string? Comment        { get; set; }
        public int     Status         { get; set; }

        // ── Revision ──
        public string? SuggestedText          { get; set; }
        public int     SuggestionState        { get; set; }
        public string? PreviousTranslatedText { get; set; }
        public int     ReviewFlag             { get; set; }
        public int     ReviewSeverity         { get; set; }
        public string? ReviewNote             { get; set; }

        // ── Workflow marks ──
        public int     Flags           { get; set; }
        public bool    Bookmarked      { get; set; }
        public int     ReviewState     { get; set; }
        public bool    CommentResolved { get; set; }
        public string? WaiversJson     { get; set; }
    }
}
