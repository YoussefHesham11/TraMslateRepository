// Adds the review fields to SubtitleEvent, the ChangesRequested project state,
// and the new collections on Project and ApplicationUser.
const fs = require('fs');
let ok = true;

function edit(p, pairs) {
    const raw = fs.readFileSync(p, 'utf8');
    const crlf = raw.includes('\r\n');
    let s = raw.replace(/\r\n/g, '\n');
    let localOk = true;
    for (const [from, to, label] of pairs) {
        const i = s.indexOf(from);
        if (i < 0) { console.error('MISS ' + p + ': ' + label); ok = localOk = false; continue; }
        if (s.indexOf(from, i + 1) >= 0) { console.error('AMBIGUOUS ' + p + ': ' + label); ok = localOk = false; continue; }
        s = s.slice(0, i) + to + s.slice(i + from.length);
        console.log('ok   ' + label);
    }
    if (localOk) fs.writeFileSync(p, crlf ? s.replace(/\n/g, '\r\n') : s);
}

edit('Models/SubtitleEvent.cs', [
    [
        `        // Where this cue stands in the translator's own workflow, kept separate
        // from the automatic quality checks. See CueStatus.
        public CueStatus Status { get; set; } = CueStatus.Draft;`,
        `        // Where this cue stands in the translator's own workflow, kept separate
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
        public string? ReviewNote { get; set; }`,
        'SubtitleEvent review fields',
    ],
]);

edit('Models/Project.cs', [
    [
        `    public enum ProjectStatus { InProgress, Completed, UnderReview }`,
        `    // Stored as integers, so new states are appended rather than inserted.
    public enum ProjectStatus
    {
        InProgress = 0,
        Completed = 1,
        UnderReview = 2,
        /// <summary>A revisor has sent the project back with work to consider.</summary>
        ChangesRequested = 3,
    }`,
        'ChangesRequested state',
    ],
    [
        `        public ICollection<SubtitleEvent> SubtitleEvents { get; set; } = new List<SubtitleEvent>();`,
        `        public ICollection<SubtitleEvent> SubtitleEvents { get; set; } = new List<SubtitleEvent>();

        /// <summary>Everyone besides the owner who can open this project.</summary>
        public ICollection<ProjectMember> Members { get; set; } = new List<ProjectMember>();

        /// <summary>Every pass a revisor has made over this project.</summary>
        public ICollection<ReviewRound> ReviewRounds { get; set; } = new List<ReviewRound>();`,
        'Project collections',
    ],
]);

edit('Models/ApplicationUser.cs', [
    [
        `        public ICollection<UserShortcut> Shortcuts { get; set; } = new List<UserShortcut>();`,
        `        public ICollection<UserShortcut> Shortcuts { get; set; } = new List<UserShortcut>();

        /// <summary>Projects owned by somebody else that this account can open.</summary>
        public ICollection<ProjectMember> Memberships { get; set; } = new List<ProjectMember>();`,
        'ApplicationUser memberships',
    ],
]);

edit('Models/AppDbContext.cs', [
    [
        `        public DbSet<UserShortcut> UserShortcuts { get; set; }`,
        `        public DbSet<UserShortcut> UserShortcuts { get; set; }
        public DbSet<ProjectMember> ProjectMembers { get; set; }
        public DbSet<ReviewRound> ReviewRounds { get; set; }`,
        'DbSets',
    ],
    [
        `            builder.Entity<UserShortcut>()
                .HasIndex(s => new { s.UserId, s.FunctionId })
                .IsUnique();`,
        `            builder.Entity<UserShortcut>()
                .HasIndex(s => new { s.UserId, s.FunctionId })
                .IsUnique();

            builder.Entity<ProjectMember>()
                .HasOne(m => m.Project)
                .WithMany(p => p.Members)
                .HasForeignKey(m => m.ProjectId)
                .OnDelete(DeleteBehavior.Cascade);

            // Deleting the account deletes the project it owns, which would
            // cascade to this row as well; SQL Server refuses two cascade paths
            // to one table, so this side is cut manually in the controller.
            builder.Entity<ProjectMember>()
                .HasOne(m => m.User)
                .WithMany(u => u.Memberships)
                .HasForeignKey(m => m.UserId)
                .OnDelete(DeleteBehavior.Restrict);

            // One person holds one role on a project.
            builder.Entity<ProjectMember>()
                .HasIndex(m => new { m.ProjectId, m.UserId })
                .IsUnique();

            builder.Entity<ReviewRound>()
                .HasOne(r => r.Project)
                .WithMany(p => p.ReviewRounds)
                .HasForeignKey(r => r.ProjectId)
                .OnDelete(DeleteBehavior.Cascade);

            builder.Entity<ReviewRound>()
                .HasOne(r => r.Reviewer)
                .WithMany()
                .HasForeignKey(r => r.ReviewerId)
                .OnDelete(DeleteBehavior.Restrict);

            builder.Entity<ReviewRound>()
                .HasIndex(r => new { r.ProjectId, r.Number })
                .IsUnique();`,
        'relationships',
    ],
]);

process.exit(ok ? 0 : 1);
