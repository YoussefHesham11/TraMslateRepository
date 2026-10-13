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
        /// <summary>
        /// A revisor approved the latest round. The translator still confirms
        /// the finished version with Done; approval alone no longer completes
        /// a project, because completion belongs to a validated, saved version.
        /// </summary>
        Approved = 4,
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

        // Project-wide working settings the editor needs to resume exactly
        // where it was: the validation profile and rules, the glossary, the
        // frame rate. Stored as one JSON document so new settings do not need
        // a migration each; the editor normalises whatever it finds.
        public string? SettingsJson { get; set; }

        // ── Completion ───────────────────────────────────
        // "Done" belongs to one saved revision. Editing afterwards moves the
        // project back to InProgress but keeps this record (and the snapshot
        // taken at completion), so the last completed version is never lost.
        public int? CompletedRevision { get; set; }
        public DateTime? CompletedAt { get; set; }
        public string? CompletedById { get; set; }
        public string? CompletionSummary { get; set; }

        // ── Idempotent saves ─────────────────────────────
        // The id the editor gave its last successful save, and what that save
        // answered. A save whose response was lost is retried with the same
        // id; recognising it lets the server answer again instead of refusing
        // the editor's own write as a conflict.
        public string? LastSaveId { get; set; }
        public string? LastSaveResultJson { get; set; }

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