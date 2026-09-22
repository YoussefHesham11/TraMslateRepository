using Microsoft.EntityFrameworkCore;
using TraMslate.Data;
using TraMslate.Models;

namespace TraMslate.Services
{
    /// <summary>
    /// What one account is allowed to do with one project.
    /// </summary>
    /// <remarks>
    /// Before revisors existed, every controller action carried its own
    /// <c>p.UserId == userId</c> test. That worked while a project had exactly
    /// one person, but "who can open this" and "what may they change" are now
    /// two different questions, and answering them in eight places invites the
    /// kind of drift where one endpoint quietly grants more than another.
    /// Both answers live here instead.
    /// </remarks>
    public class ProjectAccess
    {
        private readonly AppDbContext _db;

        public ProjectAccess(AppDbContext db) => _db = db;

        /// <summary>
        /// The project together with the caller's role on it, or null when the
        /// caller has no business seeing it at all. Callers get the same
        /// NotFound for "does not exist" and "not yours", so the endpoint never
        /// confirms that somebody else's project id is real.
        /// </summary>
        public async Task<ProjectContext?> ResolveAsync(int projectId, string? userId, bool tracking = true)
        {
            if (string.IsNullOrEmpty(userId)) return null;

            var query = _db.Projects.Where(p => p.Id == projectId);
            if (!tracking) query = query.AsNoTracking();

            var project = await query.FirstOrDefaultAsync();
            if (project == null) return null;

            if (project.UserId == userId)
                return new ProjectContext(project, ProjectRole.Translator, IsOwner: true);

            var membership = await _db.ProjectMembers
                .AsNoTracking()
                .FirstOrDefaultAsync(m => m.ProjectId == projectId && m.UserId == userId);

            return membership == null
                ? null
                : new ProjectContext(project, membership.Role, IsOwner: false);
        }

        /// <summary>Projects this account owns.</summary>
        public IQueryable<Project> Owned(string userId) =>
            _db.Projects.Where(p => p.UserId == userId);

        /// <summary>Projects this account has been invited to revise.</summary>
        public IQueryable<Project> ToRevise(string userId) =>
            _db.ProjectMembers
                .Where(m => m.UserId == userId && m.Role == ProjectRole.Revisor)
                .Select(m => m.Project!);
    }

    /// <summary>A project plus what the caller may do with it.</summary>
    /// <param name="Project">The project itself.</param>
    /// <param name="Role">Translator or Revisor, from the caller's point of view.</param>
    /// <param name="IsOwner">
    /// True only for the account that created the project. Owners are always
    /// translators; the reverse does not hold, because a project could be
    /// shared with a second translator later.
    /// </param>
    public record ProjectContext(Project Project, ProjectRole Role, bool IsOwner)
    {
        public bool IsTranslator => Role == ProjectRole.Translator;
        public bool IsRevisor => Role == ProjectRole.Revisor;

        /// <summary>
        /// Only the owner may delete a project or change who is on it. A revisor
        /// with those powers could remove the translator from their own work.
        /// </summary>
        public bool CanManage => IsOwner;

        /// <summary>
        /// The translator owns the wording. A revisor proposes replacements
        /// instead, so that the translator can always see what was changed and
        /// put their own line back.
        /// </summary>
        public bool CanEditTranslation => IsTranslator;

        /// <summary>
        /// Timing is craft rather than opinion, so a revisor fixes it directly
        /// instead of spending a whole round on an in-point two frames late.
        /// </summary>
        public bool CanEditTiming => true;

        /// <summary>Only a revisor leaves suggestions, flags and review notes.</summary>
        public bool CanReview => IsRevisor;
    }
}
