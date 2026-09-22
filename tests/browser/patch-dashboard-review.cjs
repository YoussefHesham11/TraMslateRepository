// The dashboard listed only projects the account owns. A revisor's work now
// arrives from somebody else's account, so it needs a second list — and both
// lists need to say which side of the review the viewer is on.
const fs = require('fs');
let ok = true;

function edit(p, pairs) {
    const raw = fs.readFileSync(p, 'utf8');
    const crlf = raw.includes('\r\n');
    let s = raw.replace(/\r\n/g, '\n');
    let localOk = true;
    for (const [from, to, label] of pairs) {
        const i = s.indexOf(from);
        if (i < 0) { console.error('MISS ' + p + ': ' + label); ok = localOk = false; continue; }
        if (s.indexOf(from, i + 1) >= 0) { console.error('AMBIGUOUS ' + p + ': ' + label); ok = localOk = false; continue; }
        s = s.slice(0, i) + to + s.slice(i + from.length);
        console.log('ok   ' + label);
    }
    if (localOk) fs.writeFileSync(p, crlf ? s.replace(/\n/g, '\r\n') : s);
}

edit('ViewModels/DashboardViewModels.cs', [
    [
        `        public int PercentTranslated =>`,
        `        /// <summary>Lines the revisor has proposed a replacement for, still undecided.</summary>
        public int PendingSuggestionCount { get; set; }

        /// <summary>Lines the revisor flagged as having a problem.</summary>
        public int FlaggedCount { get; set; }

        /// <summary>
        /// Whether the viewer owns this project or was invited to revise it.
        /// The same card is shown either way, with different wording.
        /// </summary>
        public ProjectRole ViewerRole { get; set; } = ProjectRole.Translator;

        /// <summary>Who owns the project, shown on a card the viewer does not own.</summary>
        public string? OwnerName { get; set; }

        public int PercentTranslated =>`,
        'card fields for review',
    ],
    [
        `    public class DashboardViewModel
    {
        public List<ProjectCardViewModel> Projects { get; set; } = new();`,
        `    public class DashboardViewModel
    {
        /// <summary>Projects this account owns and translates.</summary>
        public List<ProjectCardViewModel> Projects { get; set; } = new();

        /// <summary>Projects somebody else owns that this account was invited to revise.</summary>
        public List<ProjectCardViewModel> ToReview { get; set; } = new();

        public bool HasAnything => Projects.Count > 0 || ToReview.Count > 0;

        /// <summary>Lines waiting on this account across everything it revises.</summary>
        public int AwaitingReview => ToReview.Count(p => p.Project.Status == ProjectStatus.UnderReview);`,
        'dashboard lists',
    ],
]);

edit('Controllers/DashboardController.cs', [
    [
        `using TraMslate.ViewModels;`,
        `using TraMslate.Services;
using TraMslate.ViewModels;`,
        'using Services',
    ],
    [
        `        private readonly AppDbContext _db;
        private readonly UserManager<ApplicationUser> _userManager;

        public DashboardController(AppDbContext db, UserManager<ApplicationUser> userManager)
        {
            _db = db;
            _userManager = userManager;
        }`,
        `        private readonly AppDbContext _db;
        private readonly UserManager<ApplicationUser> _userManager;
        private readonly ProjectAccess _access;

        public DashboardController(AppDbContext db,
                                   UserManager<ApplicationUser> userManager,
                                   ProjectAccess access)
        {
            _db = db;
            _userManager = userManager;
            _access = access;
        }

        // The same projection for both lists, so an owned project and one being
        // revised report their progress identically.
        private static System.Linq.Expressions.Expression<Func<Project, ProjectCardViewModel>> ToCard(ProjectRole role) =>
            p => new ProjectCardViewModel
            {
                Project                = p,
                ViewerRole             = role,
                OwnerName              = p.User!.FullName,
                CueCount               = p.SubtitleEvents.Count(),
                TranslatedCount        = p.SubtitleEvents.Count(e => e.TranslatedText != ""),
                NeedsReviewCount       = p.SubtitleEvents.Count(e => e.Status == CueStatus.NeedsReview),
                ApprovedCount          = p.SubtitleEvents.Count(e => e.Status == CueStatus.Approved),
                PendingSuggestionCount = p.SubtitleEvents.Count(e => e.SuggestionState == SuggestionState.Pending),
                FlaggedCount           = p.SubtitleEvents.Count(e => e.ReviewFlag != ReviewFlag.None),
            };`,
        'inject access + shared projection',
    ],
    [
        `            // The counts are computed in the query rather than by loading every
            // cue: a translator with a few feature-length projects would
            // otherwise pull tens of thousands of rows to render one page.
            var cards = await _db.Projects
                .Where(p => p.UserId == userId)
                .OrderByDescending(p => p.UpdatedAt)
                .ThenByDescending(p => p.CreatedAt)
                .Select(p => new ProjectCardViewModel
                {
                    Project          = p,
                    CueCount         = p.SubtitleEvents.Count(),
                    TranslatedCount  = p.SubtitleEvents.Count(e => e.TranslatedText != ""),
                    NeedsReviewCount = p.SubtitleEvents.Count(e => e.Status == CueStatus.NeedsReview),
                    ApprovedCount    = p.SubtitleEvents.Count(e => e.Status == CueStatus.Approved),
                })
                .ToListAsync();

            return View(new DashboardViewModel { Projects = cards });`,
        `            // The counts are computed in the query rather than by loading every
            // cue: a translator with a few feature-length projects would
            // otherwise pull tens of thousands of rows to render one page.
            var owned = await _access.Owned(userId!)
                .OrderByDescending(p => p.UpdatedAt)
                .ThenByDescending(p => p.CreatedAt)
                .Select(ToCard(ProjectRole.Translator))
                .ToListAsync();

            var toReview = await _access.ToRevise(userId!)
                .OrderByDescending(p => p.UpdatedAt)
                .ThenByDescending(p => p.CreatedAt)
                .Select(ToCard(ProjectRole.Revisor))
                .ToListAsync();

            return View(new DashboardViewModel { Projects = owned, ToReview = toReview });`,
        'two lists',
    ],
    [
        `    var userId  = _userManager.GetUserId(User);
    var project = await _db.Projects
        .FirstOrDefaultAsync(p => p.Id == id && p.UserId == userId);

    if (project != null)
    {`,
        `    var userId  = _userManager.GetUserId(User);
    // Deletion stays with the owner: a revisor invited onto a project must not
    // be able to destroy the translator's work.
    var project = await _db.Projects
        .FirstOrDefaultAsync(p => p.Id == id && p.UserId == userId);

    if (project != null)
    {`,
        'delete stays owner-only',
    ],
    [
        `        _db.Projects.Remove(project);
        await _db.SaveChangesAsync();`,
        `        // SQL Server will not cascade through two paths into ProjectMembers
        // (project → members and user → members), so that side is cleared here.
        _db.ProjectMembers.RemoveRange(_db.ProjectMembers.Where(m => m.ProjectId == id));
        _db.Projects.Remove(project);
        await _db.SaveChangesAsync();`,
        'clear members before delete',
    ],
]);

process.exit(ok ? 0 : 1);
