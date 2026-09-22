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
            if (VideoFile is { Length: > 0 } && !new[] { ".mp4", ".webm", ".ogg", ".mov", ".mkv", ".avi" }.Contains(Path.GetExtension(VideoFile.FileName).ToLowerInvariant()))
                ModelState.AddModelError("VideoFile", "Choose a video file. MP4 or WebM is recommended for browser playback.");
            if (!ModelState.IsValid) return View(model);

            // Handle video upload
            if (VideoFile != null && VideoFile.Length > 0)
            {
                var uploadsDir = Path.Combine(_env.WebRootPath, "uploads");
                Directory.CreateDirectory(uploadsDir);

                var fileName = $"{Guid.NewGuid()}{Path.GetExtension(VideoFile.FileName)}";
                var filePath = Path.Combine(uploadsDir, fileName);

                using var stream = new FileStream(filePath, FileMode.Create);
                await VideoFile.CopyToAsync(stream);

                model.VideoPath = $"/uploads/{fileName}";
            }

            model.UserId    = _userManager.GetUserId(User)!;
            model.CreatedAt = DateTime.UtcNow;
            model.Status    = ProjectStatus.InProgress;

            _db.Projects.Add(model);
            await _db.SaveChangesAsync();

            return RedirectToAction("Editor", new { id = model.Id });
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

            var events = await _db.SubtitleEvents
                .Where(e => e.ProjectId == id)
                .OrderBy(e => e.Index)
                .Select(e => new {
                    e.Id,
                    e.Index,
                    startTime      = e.StartTime.ToString(@"hh\:mm\:ss\,fff"),
                    endTime        = e.EndTime.ToString(@"hh\:mm\:ss\,fff"),
                    e.OriginalText,
                    e.TranslatedText,
                    e.OriginalLocked,
                    e.Comment,
                    status          = (int)e.Status,
                    e.SuggestedText,
                    suggestionState = (int)e.SuggestionState,
                    e.PreviousTranslatedText,
                    reviewFlag      = (int)e.ReviewFlag,
                    reviewSeverity  = (int)e.ReviewSeverity,
                    e.ReviewNote
                })
                .ToListAsync();

            // The editor echoes this revision back on save; see SaveEvents.
            return Json(new { revision = project.Revision, role = context.Role.ToString(), events });
        }

        // ── Save Events ───────────────────────────────
        [HttpPost("studio/{id:int}/save")]
        public async Task<IActionResult> SaveEvents(int id, [FromBody] SaveRequest? request)
        {
            var context = await Resolve(id);
            if (context == null) return NotFound();
            var project = context.Project;

            var dtos = request?.Events;
            if (!ModelState.IsValid || dtos == null || dtos.Count > 10000)
                return BadRequest(new { success = false, message = "Supply up to 10,000 valid subtitle cues." });

            // Someone else has saved since this editor loaded. Refusing here is
            // the whole point: the alternative is one tab silently discarding
            // an hour of work done in another.
            if (request!.Revision is int seen && seen != project.Revision)
                return Conflict(new
                {
                    success = false,
                    conflict = true,
                    revision = project.Revision,
                    message = "This project was saved somewhere else after you opened it. Reload to see the newer version, or export your work first so nothing is lost."
                });
            var parsed = new List<(TimeSpan Start, TimeSpan End)>();
            foreach (var dto in dtos)
            {
                if (dto == null || !TimeSpan.TryParseExact(dto.StartTime, @"hh\:mm\:ss\,fff", System.Globalization.CultureInfo.InvariantCulture, out var start)
                    || !TimeSpan.TryParseExact(dto.EndTime, @"hh\:mm\:ss\,fff", System.Globalization.CultureInfo.InvariantCulture, out var end)
                    || start < TimeSpan.Zero || end <= start || end.TotalHours >= 24
                    || (dto.OriginalText?.Length ?? 0) > 10000 || (dto.TranslatedText?.Length ?? 0) > 10000
                    || (dto.Comment?.Length ?? 0) > 2000)
                    return BadRequest(new { success = false, message = "Each cue needs valid timing, text under 10,000 characters, and a comment under 2,000 characters." });
                parsed.Add((start, end));
            }

            // Update in place by position rather than delete-all/insert-all:
            // cue ids stay stable (the editor keys per-cue locks on them) and a
            // one-word change no longer rewrites every row in the project.
            var existing = await _db.SubtitleEvents
                .Where(e => e.ProjectId == id)
                .OrderBy(e => e.Index)
                .ToListAsync();

            for (int i = 0; i < dtos.Count; i++)
            {
                var dto    = dtos[i];
                var row    = i < existing.Count ? existing[i] : null;
                var status = Enum.IsDefined(typeof(CueStatus), dto.Status) ? (CueStatus)dto.Status : CueStatus.Draft;

                if (row == null)
                {
                    row = new SubtitleEvent { ProjectId = id };
                    _db.SubtitleEvents.Add(row);
                }

                // Timing and the source belong to whoever is in the project;
                // everything else depends on which side of the review they are.
                row.Index          = i + 1;
                row.StartTime      = parsed[i].Start;
                row.EndTime        = parsed[i].End;
                row.OriginalText   = dto.OriginalText;
                row.OriginalLocked = dto.OriginalLocked;
                row.UpdatedAt      = DateTime.UtcNow;

                if (context.CanEditTranslation)
                {
                    row.TranslatedText         = dto.TranslatedText ?? string.Empty;
                    row.PreviousTranslatedText = dto.PreviousTranslatedText;
                    row.Comment                = dto.Comment;
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

            if (existing.Count > dtos.Count)
                _db.SubtitleEvents.RemoveRange(existing.Skip(dtos.Count));

            project.Revision  += 1;
            project.UpdatedAt  = DateTime.UtcNow;

            await _db.SaveChangesAsync();

            var saved = await _db.SubtitleEvents
                .Where(e => e.ProjectId == id)
                .OrderBy(e => e.Index)
                .Select(e => new {
                    e.Id,
                    e.Index,
                    startTime      = e.StartTime.ToString(@"hh\:mm\:ss\,fff"),
                    endTime        = e.EndTime.ToString(@"hh\:mm\:ss\,fff"),
                    e.OriginalText,
                    e.TranslatedText,
                    e.OriginalLocked,
                    e.Comment,
                    status          = (int)e.Status,
                    e.SuggestedText,
                    suggestionState = (int)e.SuggestionState,
                    e.PreviousTranslatedText,
                    reviewFlag      = (int)e.ReviewFlag,
                    reviewSeverity  = (int)e.ReviewSeverity,
                    e.ReviewNote
                })
                .ToListAsync();

            return Json(new { success = true, revision = project.Revision, events = saved });
        }
    }

    public class SaveRequest
    {
        /// <summary>
        /// The project revision the editor had when it loaded, echoed back so a
        /// save built on stale data can be rejected. Null skips the check, which
        /// is what a deliberate "overwrite anyway" does.
        /// </summary>
        public int? Revision { get; set; }
        public List<SubtitleEventDto>? Events { get; set; }
    }

    public class SubtitleEventDto
    {
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
    }
}
