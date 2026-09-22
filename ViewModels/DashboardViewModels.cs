using TraMslate.Models;

namespace TraMslate.ViewModels
{
    /// <summary>
    /// A project as the dashboard shows it: the project itself plus the counts
    /// a translator actually wants at a glance — how much is left to do, and
    /// how much of it still needs attention.
    /// </summary>
    public class ProjectCardViewModel
    {
        public Project Project { get; set; } = null!;

        /// <summary>Total cues in the project.</summary>
        public int CueCount { get; set; }

        /// <summary>Cues with a non-empty translation.</summary>
        public int TranslatedCount { get; set; }

        /// <summary>Cues the translator explicitly flagged for review.</summary>
        public int NeedsReviewCount { get; set; }

        /// <summary>Cues a reviewer has signed off.</summary>
        public int ApprovedCount { get; set; }

        /// <summary>Lines the revisor has proposed a replacement for, still undecided.</summary>
        public int PendingSuggestionCount { get; set; }

        /// <summary>Lines the revisor flagged as having a problem.</summary>
        public int FlaggedCount { get; set; }

        /// <summary>
        /// Whether the viewer owns this project or was invited to revise it.
        /// The same card is shown either way, with different wording.
        /// </summary>
        public ProjectRole ViewerRole { get; set; } = ProjectRole.Translator;

        /// <summary>Who owns the project, shown on a card the viewer does not own.</summary>
        public string? OwnerName { get; set; }

        public int PercentTranslated =>
            CueCount == 0 ? 0 : (int)Math.Round(TranslatedCount * 100.0 / CueCount);

        /// <summary>
        /// A project with cues, all of them translated. Used to distinguish
        /// "finished" from "empty" — both would otherwise read as 0 remaining.
        /// </summary>
        public bool IsFullyTranslated => CueCount > 0 && TranslatedCount == CueCount;
    }

    public class DashboardViewModel
    {
        /// <summary>Projects this account owns and translates.</summary>
        public List<ProjectCardViewModel> Projects { get; set; } = new();

        /// <summary>Projects somebody else owns that this account was invited to revise.</summary>
        public List<ProjectCardViewModel> ToReview { get; set; } = new();

        public bool HasAnything => Projects.Count > 0 || ToReview.Count > 0;

        /// <summary>Lines waiting on this account across everything it revises.</summary>
        public int AwaitingReview => ToReview.Count(p => p.Project.Status == ProjectStatus.UnderReview);

        public int TotalProjects => Projects.Count;
        public int InProgress    => Projects.Count(p => p.Project.Status == ProjectStatus.InProgress);
        public int UnderReview   => Projects.Count(p => p.Project.Status == ProjectStatus.UnderReview);
        public int Completed     => Projects.Count(p => p.Project.Status == ProjectStatus.Completed);

        public int TotalCues        => Projects.Sum(p => p.CueCount);
        public int TotalTranslated  => Projects.Sum(p => p.TranslatedCount);
        public int CuesRemaining    => Math.Max(0, TotalCues - TotalTranslated);
    }
}
