using Microsoft.AspNetCore.Identity;

namespace TraMslate.Models
{
    public class ApplicationUser : IdentityUser
    {
        public string FullName { get; set; } = string.Empty;
        public string? LanguageSpecialty { get; set; } // e.g. "Arabic", "French"
        public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
        public ICollection<Project> Projects { get; set; } = new List<Project>();
        public ICollection<UserShortcut> Shortcuts { get; set; } = new List<UserShortcut>();

        /// <summary>Projects owned by somebody else that this account can open.</summary>
        public ICollection<ProjectMember> Memberships { get; set; } = new List<ProjectMember>();
    }
}