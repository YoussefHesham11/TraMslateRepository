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
    /// <summary>
    /// Everything about getting a second pair of eyes onto a project: who is
    /// invited to revise it, and the record of each pass they make over it.
    /// </summary>
    [Authorize]
    public class ReviewController : Controller
    {
        private readonly AppDbContext _db;
        private readonly UserManager<ApplicationUser> _userManager;
        private readonly ProjectAccess _access;

        public ReviewController(AppDbContext db,
                                UserManager<ApplicationUser> userManager,
                                ProjectAccess access)
        {
            _db = db;
            _userManager = userManager;
            _access = access;
        }

        private Task<ProjectContext?> Resolve(int id, bool tracking = true) =>
            _access.ResolveAsync(id, _userManager.GetUserId(User), tracking);

        // ── People on a project ───────────────────────

        [HttpGet("studio/{id:int}/people")]
        public async Task<IActionResult> People(int id)
        {
            var context = await Resolve(id, tracking: false);
            if (context == null) return NotFound();

            var owner = await _db.Users.AsNoTracking()
                .Where(u => u.Id == context.Project.UserId)
                .Select(u => new { u.FullName, u.Email })
                .FirstOrDefaultAsync();

            var members = await _db.ProjectMembers.AsNoTracking()
                .Where(m => m.ProjectId == id)
                .Include(m => m.User)
                .OrderBy(m => m.AddedAt)
                .ToListAsync();

            ViewBag.Project = context.Project;
            ViewBag.CanManage = context.CanManage;
            ViewBag.OwnerName = owner?.FullName ?? "Unknown";
            ViewBag.OwnerEmail = owner?.Email ?? "";
            ViewBag.Rounds = await _db.ReviewRounds.AsNoTracking()
                .Where(r => r.ProjectId == id)
                .Include(r => r.Reviewer)
                .OrderByDescending(r => r.Number)
                .ToListAsync();

            return View(members);
        }

        [HttpPost("studio/{id:int}/people/invite")]
        public async Task<IActionResult> Invite(int id, string email)
        {
            var context = await Resolve(id, tracking: false);
            if (context == null) return NotFound();
            if (!context.CanManage) return Forbid();

            var trimmed = (email ?? string.Empty).Trim();
            if (trimmed.Length == 0)
                return Back(id, "Enter the email address of the person you want to invite.");

            var user = await _userManager.FindByEmailAsync(trimmed);
            if (user == null)
                return Back(id, $"No account found for {trimmed}. They need to register first, then you can invite them.");

            if (user.Id == context.Project.UserId)
                return Back(id, "You already own this project, so you are already its translator.");

            var already = await _db.ProjectMembers
                .AnyAsync(m => m.ProjectId == id && m.UserId == user.Id);
            if (already)
                return Back(id, $"{user.FullName} is already on this project.");

            _db.ProjectMembers.Add(new ProjectMember
            {
                ProjectId = id,
                UserId = user.Id,
                Role = ProjectRole.Revisor,
                AddedAt = DateTime.UtcNow,
            });
            await _db.SaveChangesAsync();

            return Back(id, $"{user.FullName} can now revise this project.", isError: false);
        }

        [HttpPost("studio/{id:int}/people/{memberId:int}/remove")]
        public async Task<IActionResult> RemoveMember(int id, int memberId)
        {
            var context = await Resolve(id, tracking: false);
            if (context == null) return NotFound();
            if (!context.CanManage) return Forbid();

            var member = await _db.ProjectMembers
                .FirstOrDefaultAsync(m => m.Id == memberId && m.ProjectId == id);
            if (member == null) return Back(id, "That person is no longer on this project.");

            _db.ProjectMembers.Remove(member);
            await _db.SaveChangesAsync();
            return Back(id, "Removed from the project.", isError: false);
        }

        // ── Review rounds ─────────────────────────────

        /// <summary>
        /// The translator hands the project over. A round is opened so the
        /// revisor's work has something to belong to.
        /// </summary>
        [HttpPost("studio/{id:int}/review/start")]
        public async Task<IActionResult> SendForReview(int id)
        {
            var context = await Resolve(id);
            if (context == null) return NotFound();
            if (!context.IsTranslator) return Forbid();

            var hasRevisor = await _db.ProjectMembers
                .AnyAsync(m => m.ProjectId == id && m.Role == ProjectRole.Revisor);
            if (!hasRevisor)
                return Back(id, "Invite a revisor first — there is nobody to send this to yet.");

            var open = await _db.ReviewRounds
                .AnyAsync(r => r.ProjectId == id && r.SubmittedAt == null);
            if (!open)
            {
                var last = await _db.ReviewRounds
                    .Where(r => r.ProjectId == id)
                    .MaxAsync(r => (int?)r.Number) ?? 0;

                // The round belongs to whoever picks it up; the first revisor
                // on the project is recorded until one of them submits it.
                var revisorId = await _db.ProjectMembers
                    .Where(m => m.ProjectId == id && m.Role == ProjectRole.Revisor)
                    .OrderBy(m => m.AddedAt)
                    .Select(m => m.UserId)
                    .FirstAsync();

                _db.ReviewRounds.Add(new ReviewRound
                {
                    ProjectId = id,
                    ReviewerId = revisorId,
                    Number = last + 1,
                    StartedAt = DateTime.UtcNow,
                    Verdict = ReviewVerdict.Pending,
                });
            }

            context.Project.Status = ProjectStatus.UnderReview;
            context.Project.UpdatedAt = DateTime.UtcNow;
            await _db.SaveChangesAsync();

            return Back(id, "Sent for review.", isError: false);
        }

        /// <summary>
        /// The revisor finishes a pass: writes their report and either sends
        /// the project back or signs it off.
        /// </summary>
        [HttpPost("studio/{id:int}/review/submit")]
        public async Task<IActionResult> SubmitReview(int id, string? notes, ReviewVerdict verdict)
        {
            var context = await Resolve(id);
            if (context == null) return NotFound();
            if (!context.CanReview) return Forbid();
            if (verdict == ReviewVerdict.Pending)
                return Back(id, "Choose whether you are sending this back or signing it off.");
            if ((notes?.Length ?? 0) > 20000)
                return Back(id, "Keep the report under 20,000 characters.");

            var round = await _db.ReviewRounds
                .Where(r => r.ProjectId == id && r.SubmittedAt == null)
                .OrderByDescending(r => r.Number)
                .FirstOrDefaultAsync();

            if (round == null)
            {
                var last = await _db.ReviewRounds
                    .Where(r => r.ProjectId == id)
                    .MaxAsync(r => (int?)r.Number) ?? 0;
                round = new ReviewRound
                {
                    ProjectId = id,
                    Number = last + 1,
                    StartedAt = DateTime.UtcNow,
                };
                _db.ReviewRounds.Add(round);
            }

            // Counts are snapshotted now, so the report still describes what the
            // revisor actually found even after the translator has worked
            // through the suggestions and cleared them.
            round.ReviewerId = _userManager.GetUserId(User)!;
            round.Notes = notes;
            round.Verdict = verdict;
            round.SubmittedAt = DateTime.UtcNow;
            round.CueCount = await _db.SubtitleEvents.CountAsync(e => e.ProjectId == id);
            round.SuggestionCount = await _db.SubtitleEvents
                .CountAsync(e => e.ProjectId == id && e.SuggestedText != null);
            round.FlagCount = await _db.SubtitleEvents
                .CountAsync(e => e.ProjectId == id && e.ReviewFlag != ReviewFlag.None);

            // Approval finishes the review, not the project: the translator
            // still confirms the final version with Done, which validates it
            // and records which saved revision was delivered.
            context.Project.Status = verdict == ReviewVerdict.Approved
                ? ProjectStatus.Approved
                : ProjectStatus.ChangesRequested;
            context.Project.UpdatedAt = DateTime.UtcNow;

            await _db.SaveChangesAsync();

            return RedirectToAction(nameof(Report), new { id, number = round.Number });
        }

        [HttpGet("studio/{id:int}/review/{number:int}")]
        public async Task<IActionResult> Report(int id, int number)
        {
            var context = await Resolve(id, tracking: false);
            if (context == null) return NotFound();

            var round = await _db.ReviewRounds.AsNoTracking()
                .Include(r => r.Reviewer)
                .FirstOrDefaultAsync(r => r.ProjectId == id && r.Number == number);
            if (round == null) return NotFound();

            ViewBag.Project = context.Project;
            ViewBag.Rounds = await _db.ReviewRounds.AsNoTracking()
                .Where(r => r.ProjectId == id && r.SubmittedAt != null)
                .OrderByDescending(r => r.Number)
                .Select(r => new { r.Number, r.SubmittedAt, r.Verdict })
                .ToListAsync();

            // Flagged lines are listed alongside the note so the report can be
            // read on its own, away from the editor.
            ViewBag.Flagged = await _db.SubtitleEvents.AsNoTracking()
                .Where(e => e.ProjectId == id && e.ReviewFlag != ReviewFlag.None)
                .OrderBy(e => e.Index)
                .Select(e => new FlaggedLine
                {
                    Index          = e.Index,
                    Flag           = e.ReviewFlag,
                    Severity       = e.ReviewSeverity,
                    Note           = e.ReviewNote,
                    OriginalText   = e.OriginalText,
                    TranslatedText = e.TranslatedText,
                    SuggestedText  = e.SuggestedText,
                })
                .ToListAsync();

            return View(round);
        }

        // Carries a one-line outcome back to whichever page raised the request.
        private IActionResult Back(int id, string message, bool isError = true)
        {
            TempData[isError ? "PeopleError" : "PeopleNotice"] = message;
            return RedirectToAction(nameof(People), new { id });
        }
    }
}
