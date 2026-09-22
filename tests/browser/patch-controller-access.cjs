// Moves ProjectController onto ProjectAccess, so "can this account open the
// project" and "what may they change" are answered in one place rather than
// re-derived in every action. Also carries the review fields through the
// events and save endpoints, and enforces the role rules on save.
const fs = require('fs');
const p = 'Controllers/ProjectController.cs';
const raw = fs.readFileSync(p, 'utf8');
const crlf = raw.includes('\r\n');
let s = raw.replace(/\r\n/g, '\n');
let ok = true;

function swap(from, to, label) {
    const i = s.indexOf(from);
    if (i < 0) { console.error('MISS: ' + label); ok = false; return; }
    if (s.indexOf(from, i + 1) >= 0) { console.error('AMBIGUOUS: ' + label); ok = false; return; }
    s = s.slice(0, i) + to + s.slice(i + from.length);
    console.log('ok   ' + label);
}

swap(`using TraMslate.Models;`, `using TraMslate.Models;
using TraMslate.Services;`, 'using Services');

swap(
`        private readonly AppDbContext _db;
        private readonly UserManager<ApplicationUser> _userManager;
        private readonly IWebHostEnvironment _env;

        public ProjectController(AppDbContext db,
                                 UserManager<ApplicationUser> userManager,
                                 IWebHostEnvironment env)
        {
            _db = db;
            _userManager = userManager;
            _env = env;
        }`,
`        private readonly AppDbContext _db;
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
            _access.ResolveAsync(id, _userManager.GetUserId(User), tracking);`,
    'inject ProjectAccess');

// ── Editor ──
swap(
`            var userId  = _userManager.GetUserId(User);
            var project = await _db.Projects
                .FirstOrDefaultAsync(p => p.Id == id && p.UserId == userId);

            if (project == null) return NotFound();
            return View(project);`,
`            var context = await Resolve(id, tracking: false);
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
                .Include(r => r.Reviewer)
                .Where(r => r.ProjectId == id && r.SubmittedAt != null)
                .OrderByDescending(r => r.Number)
                .Select(r => new
                {
                    r.Number,
                    r.Notes,
                    r.Verdict,
                    r.SubmittedAt,
                    r.SuggestionCount,
                    r.FlagCount,
                    Reviewer = r.Reviewer!.FullName,
                })
                .FirstOrDefaultAsync();

            return View(context.Project);`,
    'Editor resolves role');

// ── Media ──
swap(
`            var userId = _userManager.GetUserId(User);
            var project = await _db.Projects.AsNoTracking().FirstOrDefaultAsync(p => p.Id == id && p.UserId == userId);
            if (project?.VideoPath == null) return NotFound();`,
`            var context = await Resolve(id, tracking: false);
            var project = context?.Project;
            if (project?.VideoPath == null) return NotFound();`,
    'Media uses access');

// ── Status ──
swap(
`            if (!Enum.IsDefined(status)) return BadRequest();
            var userId = _userManager.GetUserId(User);
            var project = await _db.Projects.FirstOrDefaultAsync(p => p.Id == id && p.UserId == userId);
            if (project == null) return NotFound();
            project.Status = status;
            await _db.SaveChangesAsync();
            return Json(new { success = true });`,
`            if (!Enum.IsDefined(status)) return BadRequest();
            var context = await Resolve(id);
            if (context == null) return NotFound();
            // A revisor reports a verdict by submitting their round; letting
            // them set the status directly would let them mark work complete
            // without leaving any record of having reviewed it.
            if (!context.IsTranslator) return Forbid();
            context.Project.Status = status;
            context.Project.UpdatedAt = DateTime.UtcNow;
            await _db.SaveChangesAsync();
            return Json(new { success = true });`,
    'Status is the translator’s');

// ── GET events ──
swap(
`            var userId  = _userManager.GetUserId(User);
            var project = await _db.Projects
                .FirstOrDefaultAsync(p => p.Id == id && p.UserId == userId);
            if (project == null) return NotFound();

            var events = await _db.SubtitleEvents`,
`            var context = await Resolve(id, tracking: false);
            if (context == null) return NotFound();
            var project = context.Project;

            var events = await _db.SubtitleEvents`,
    'GetEvents uses access');

swap(
`                    e.OriginalLocked,
                    e.Comment,
                    status         = (int)e.Status
                })
                .ToListAsync();

            // The editor echoes this revision back on save; see SaveEvents.
            return Json(new { revision = project.Revision, events });`,
`                    e.OriginalLocked,
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
            return Json(new { revision = project.Revision, role = context.Role.ToString(), events });`,
    'GetEvents returns review fields');

// ── POST save ──
swap(
`            var userId  = _userManager.GetUserId(User);
            var project = await _db.Projects
                .FirstOrDefaultAsync(p => p.Id == id && p.UserId == userId);
            if (project == null) return NotFound();

            var dtos = request?.Events;`,
`            var context = await Resolve(id);
            if (context == null) return NotFound();
            var project = context.Project;

            var dtos = request?.Events;`,
    'SaveEvents uses access');

swap(
`                row.Index          = i + 1;
                row.StartTime      = parsed[i].Start;
                row.EndTime        = parsed[i].End;
                row.OriginalText   = dto.OriginalText;
                row.TranslatedText = dto.TranslatedText ?? string.Empty;
                row.OriginalLocked = dto.OriginalLocked;
                row.Comment        = dto.Comment;
                row.Status         = status;
                row.UpdatedAt      = DateTime.UtcNow;`,
`                // Timing and the source belong to whoever is in the project;
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
                    var suggested = (dto.SuggestedText ?? string.Empty).Replace("\\r\\n", "\\n");
                    var current   = (row.TranslatedText ?? string.Empty).Replace("\\r\\n", "\\n");
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
                }`,
    'save respects the role');

swap(
`                    e.OriginalLocked,
                    e.Comment,
                    status         = (int)e.Status
                })
                .ToListAsync();

            return Json(new { success = true, revision = project.Revision, events = saved });`,
`                    e.OriginalLocked,
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

            return Json(new { success = true, revision = project.Revision, events = saved });`,
    'save returns review fields');

swap(
`        public string? Comment        { get; set; }
        public int     Status         { get; set; }
    }`,
`        public string? Comment        { get; set; }
        public int     Status         { get; set; }

        // ── Revision ──
        public string? SuggestedText          { get; set; }
        public int     SuggestionState        { get; set; }
        public string? PreviousTranslatedText { get; set; }
        public int     ReviewFlag             { get; set; }
        public int     ReviewSeverity         { get; set; }
        public string? ReviewNote             { get; set; }
    }`,
    'DTO review fields');

if (!ok) { console.error('ABORT'); process.exit(1); }
fs.writeFileSync(p, crlf ? s.replace(/\n/g, '\r\n') : s);
console.log('patched');
