namespace TraMslate.Models
{
    /// <summary>
    /// Where a single cue stands in the translation workflow. This is the
    /// translator's own judgement and is deliberately separate from the
    /// automatic quality checks: a line can be flagged as reading too fast and
    /// still be marked Approved, and a clean line can still be Draft.
    /// </summary>
    public enum CueStatus
    {
        /// <summary>No translation yet, or a first pass the translator has not stood behind.</summary>
        Draft = 0,
        /// <summary>Translated and considered finished by the translator.</summary>
        Done = 1,
        /// <summary>Translated but flagged for a second opinion before delivery.</summary>
        NeedsReview = 2,
        /// <summary>Checked by a reviewer and signed off.</summary>
        Approved = 3,
    }
}
