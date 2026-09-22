using TraMslate.Models;

namespace TraMslate.ViewModels
{
    /// <summary>
    /// The last submitted review round, as the editor shows it to the
    /// translator. A named type rather than an anonymous one passed through
    /// ViewBag: anonymous types are internal, so reaching into them from a
    /// view only works by luck of compilation, and a renamed property fails
    /// silently at run time instead of loudly at build time.
    /// </summary>
    public class ReviewSummary
    {
        public int Number { get; set; }
        public string ReviewerName { get; set; } = "Revisor";
        public string? Notes { get; set; }
        public ReviewVerdict Verdict { get; set; }
        public DateTime? SubmittedAt { get; set; }
        public int SuggestionCount { get; set; }
        public int FlagCount { get; set; }
    }

    /// <summary>One flagged line, as the printable report lists it.</summary>
    public class FlaggedLine
    {
        public int Index { get; set; }
        public ReviewFlag Flag { get; set; }
        public ReviewSeverity Severity { get; set; }
        public string? Note { get; set; }
        public string? OriginalText { get; set; }
        public string? TranslatedText { get; set; }
        public string? SuggestedText { get; set; }

        public string FlagLabel => Flag switch
        {
            ReviewFlag.Mistranslation => "Mistranslation",
            ReviewFlag.Omission => "Omission",
            ReviewFlag.Addition => "Addition",
            ReviewFlag.Terminology => "Terminology",
            ReviewFlag.Style => "Style / register",
            ReviewFlag.Grammar => "Grammar / spelling",
            ReviewFlag.Timing => "Timing",
            ReviewFlag.ReadingSpeed => "Reading speed",
            ReviewFlag.LineBreaks => "Line breaks",
            _ => "Flagged",
        };
    }
}
