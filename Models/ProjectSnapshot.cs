namespace TraMslate.Models
{
    public enum SnapshotKind
    {
        /// <summary>Taken automatically while working, at most every few minutes.</summary>
        Checkpoint = 0,
        /// <summary>The person pressed Save, or Save as version.</summary>
        Manual = 1,
        /// <summary>The track just before an import replaced or extended it.</summary>
        BeforeImport = 2,
        /// <summary>The track just before a bulk change.</summary>
        BeforeBulk = 3,
        /// <summary>The exact version confirmed with Done.</summary>
        Completed = 4,
        /// <summary>The track just before an older version was restored over it.</summary>
        BeforeRestore = 5,
        /// <summary>A copy kept when a save conflicted, so neither side is lost.</summary>
        Conflict = 6,
    }

    /// <summary>
    /// A full copy of a project's cues and settings at one moment, for the
    /// version history and for recovering from a destructive change. Stored as
    /// JSON because it is only ever read back whole.
    /// </summary>
    public class ProjectSnapshot
    {
        public int Id { get; set; }
        public int ProjectId { get; set; }
        public Project? Project { get; set; }

        /// <summary>The project revision this copy was taken at (or built on, for unsaved copies).</summary>
        public int Revision { get; set; }
        public SnapshotKind Kind { get; set; }
        public string? Label { get; set; }
        public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
        public string UserId { get; set; } = string.Empty;

        public string EventsJson { get; set; } = "[]";
        public string? SettingsJson { get; set; }
        public int CueCount { get; set; }
        public int TranslatedCount { get; set; }
    }
}
