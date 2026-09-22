namespace TraMslate.Models
{
    public class SubtitleEvent
    {
        public int Id { get; set; }
        public int Index { get; set; }           // Display order (1, 2, 3...)
        public TimeSpan StartTime { get; set; }
        public TimeSpan EndTime { get; set; }
        public string? OriginalText { get; set; } // Source (English)
        public string TranslatedText { get; set; } = string.Empty; // What translator types
        // Once a cue's source text comes from an imported script, the translator
        // should never be able to edit it — only the translation stays editable.
        public bool OriginalLocked { get; set; }
        // A free-text note attached to this cue (context, a question for review, etc).
        public string? Comment { get; set; }
        // Where this cue stands in the translator's own workflow, kept separate
        // from the automatic quality checks. See CueStatus.
        public CueStatus Status { get; set; } = CueStatus.Draft;

        // ── Revision ──────────────────────────────────────
        // A revisor proposes a replacement rather than overwriting the
        // translator's line. SuggestedText is only stored when it actually
        // differs from TranslatedText, so "has a suggestion" and "was looked
        // at" stay different things.
        public string? SuggestedText { get; set; }
        public SuggestionState SuggestionState { get; set; } = SuggestionState.None;

        // What the translation said before a suggestion was accepted, so the
        // translator can put their own wording back.
        public string? PreviousTranslatedText { get; set; }

        // The revisor's classification of what is wrong with this line.
        public ReviewFlag ReviewFlag { get; set; } = ReviewFlag.None;
        public ReviewSeverity ReviewSeverity { get; set; } = ReviewSeverity.None;

        // The revisor's note to the translator about this line. Deliberately
        // separate from Comment, which belongs to the translator, so the two
        // read as a conversation rather than overwriting each other.
        public string? ReviewNote { get; set; }
        public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

        // FK to project
        public int ProjectId { get; set; }
        public Project? Project { get; set; }
    }
}