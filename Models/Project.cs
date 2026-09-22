namespace TraMslate.Models
{
    // Stored as integers, so new states are appended rather than inserted.
    public enum ProjectStatus
    {
        InProgress = 0,
        Completed = 1,
        UnderReview = 2,
        /// <summary>A revisor has sent the project back with work to consider.</summary>
        ChangesRequested = 3,
    }

    public class Project
    {
        public int Id { get; set; }
        public string Title { get; set; } = string.Empty;
        public string? Description { get; set; }
        public string? VideoPath { get; set; }
        public string SourceLanguage { get; set; } = "English";
        public string TargetLanguage { get; set; } = string.Empty;
        public ProjectStatus Status { get; set; } = ProjectStatus.InProgress;
        public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
        public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

        // Bumped on every successful save of this project's cues. The editor
        // sends back the revision it loaded, so a save built on stale data is
        // rejected rather than quietly overwriting whatever arrived in between.
        public int Revision { get; set; }

        // FK to translator
        public string UserId { get; set; } = string.Empty;
        public ApplicationUser? User { get; set; }

        public ICollection<SubtitleEvent> SubtitleEvents { get; set; } = new List<SubtitleEvent>();

        /// <summary>Everyone besides the owner who can open this project.</summary>
        public ICollection<ProjectMember> Members { get; set; } = new List<ProjectMember>();

        /// <summary>Every pass a revisor has made over this project.</summary>
        public ICollection<ReviewRound> ReviewRounds { get; set; } = new List<ReviewRound>();
    }
}