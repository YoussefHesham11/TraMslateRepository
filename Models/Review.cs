namespace TraMslate.Models
{
    /// <summary>
    /// What somebody does on one particular project. The same account is a
    /// translator on their own work and a revisor on somebody else's, so this
    /// is deliberately per project rather than a property of the account.
    /// </summary>
    public enum ProjectRole
    {
        Translator = 0,
        Revisor = 1,
    }

    /// <summary>
    /// Somebody other than the owner who has been given access to a project.
    /// The owner (Project.UserId) is always its translator and is not stored
    /// here.
    /// </summary>
    public class ProjectMember
    {
        public int Id { get; set; }

        public int ProjectId { get; set; }
        public Project? Project { get; set; }

        public string UserId { get; set; } = string.Empty;
        public ApplicationUser? User { get; set; }

        public ProjectRole Role { get; set; } = ProjectRole.Revisor;
        public DateTime AddedAt { get; set; } = DateTime.UtcNow;
    }

    /// <summary>
    /// The kind of problem a revisor found in a line. These are the categories
    /// used in language-quality review, so a translator can tell at a glance
    /// whether a note is about meaning, wording or presentation.
    /// </summary>
    public enum ReviewFlag
    {
        None = 0,
        /// <summary>The translation says something the source does not.</summary>
        Mistranslation = 1,
        /// <summary>Something in the source is missing from the translation.</summary>
        Omission = 2,
        /// <summary>The translation adds something the source does not say.</summary>
        Addition = 3,
        /// <summary>The wrong term for this project's glossary or subject.</summary>
        Terminology = 4,
        /// <summary>Correct, but the wrong register or tone for the speaker.</summary>
        Style = 5,
        /// <summary>Grammar, spelling or punctuation.</summary>
        Grammar = 6,
        /// <summary>In or out time sits wrong against the picture or the audio.</summary>
        Timing = 7,
        /// <summary>Too many characters for the time the line is on screen.</summary>
        ReadingSpeed = 8,
        /// <summary>The line breaks in a place that hurts reading.</summary>
        LineBreaks = 9,
    }

    /// <summary>How much a flagged problem matters.</summary>
    public enum ReviewSeverity
    {
        None = 0,
        /// <summary>Worth fixing, but nobody watching would be misled.</summary>
        Minor = 1,
        /// <summary>A viewer would notice, or the meaning is bent.</summary>
        Major = 2,
        /// <summary>Wrong enough to block delivery.</summary>
        Critical = 3,
    }

    /// <summary>What has become of a revisor's proposed replacement for a line.</summary>
    public enum SuggestionState
    {
        /// <summary>No suggestion on this line.</summary>
        None = 0,
        /// <summary>Proposed, and the translator has not decided yet.</summary>
        Pending = 1,
        /// <summary>The translator took it; it is now the translation.</summary>
        Accepted = 2,
        /// <summary>The translator read it and kept their own wording.</summary>
        Dismissed = 3,
    }

    /// <summary>How a review round ended.</summary>
    public enum ReviewVerdict
    {
        /// <summary>Still open — the revisor is working through the project.</summary>
        Pending = 0,
        /// <summary>Sent back to the translator with suggestions to consider.</summary>
        ChangesRequested = 1,
        /// <summary>Signed off.</summary>
        Approved = 2,
    }

    /// <summary>
    /// One pass of a revisor over a project. A project can go back and forth
    /// several times, so each pass keeps its own note and its own counts —
    /// the counts are snapshotted when the round is submitted so the record
    /// stays true even after the translator accepts or dismisses suggestions.
    /// </summary>
    public class ReviewRound
    {
        public int Id { get; set; }

        public int ProjectId { get; set; }
        public Project? Project { get; set; }

        public string ReviewerId { get; set; } = string.Empty;
        public ApplicationUser? Reviewer { get; set; }

        /// <summary>1 for the first pass over this project, 2 for the next, and so on.</summary>
        public int Number { get; set; }

        public DateTime StartedAt { get; set; } = DateTime.UtcNow;
        public DateTime? SubmittedAt { get; set; }

        /// <summary>The revisor's written report for the translator.</summary>
        public string? Notes { get; set; }

        public ReviewVerdict Verdict { get; set; } = ReviewVerdict.Pending;

        // ── Snapshot taken when the round is submitted ──
        public int CueCount { get; set; }
        public int SuggestionCount { get; set; }
        public int FlagCount { get; set; }

        public bool IsOpen => SubmittedAt == null;
    }
}
