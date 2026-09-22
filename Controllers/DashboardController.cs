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
    public class DashboardController : Controller
    {
        private readonly AppDbContext _db;
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
            };

        [HttpGet("dashboard")]
        public async Task<IActionResult> Index()
        {
            var userId = _userManager.GetUserId(User);

            // The counts are computed in the query rather than by loading every
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

            return View(new DashboardViewModel { Projects = owned, ToReview = toReview });
        }


        [HttpPost("dashboard/{id:int}/delete")]
public async Task<IActionResult> Delete(int id)
{
    var userId  = _userManager.GetUserId(User);
    // Deletion stays with the owner: a revisor invited onto a project must not
    // be able to destroy the translator's work.
    var project = await _db.Projects
        .FirstOrDefaultAsync(p => p.Id == id && p.UserId == userId);

    if (project != null)
    {
        // Delete video file from disk if exists
        if (!string.IsNullOrEmpty(project.VideoPath))
        {
            var filePath = Path.Combine(
                Directory.GetCurrentDirectory(), "wwwroot",
                project.VideoPath.TrimStart('/').Replace('/', Path.DirectorySeparatorChar));
            if (System.IO.File.Exists(filePath))
                System.IO.File.Delete(filePath);
        }

        // SQL Server will not cascade through two paths into ProjectMembers
        // (project → members and user → members), so that side is cleared here.
        _db.ProjectMembers.RemoveRange(_db.ProjectMembers.Where(m => m.ProjectId == id));
        _db.Projects.Remove(project);
        await _db.SaveChangesAsync();
    }

    return RedirectToAction("Index");
}
    }
}