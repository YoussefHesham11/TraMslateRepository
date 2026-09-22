// Replaces the anonymous types passed through ViewBag with the named view
// models, so a renamed property is a build error rather than a blank line on
// the page.
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

edit('Controllers/ProjectController.cs', [
    [
        `using TraMslate.Services;`,
        `using TraMslate.Services;
using TraMslate.ViewModels;`,
        'using ViewModels',
    ],
    [
        `            ViewBag.LastRound = await _db.ReviewRounds
                .AsNoTracking()
                .Include(r => r.Reviewer)
                .Where(r => r.ProjectId == id && r.SubmittedAt != null)
                .OrderByDescending(r => r.Number)
                .Select(r => new
                {
                    r.Number,
                    r.Notes,
                    r.Verdict,
                    r.SubmittedAt,
                    r.SuggestionCount,
                    r.FlagCount,
                    Reviewer = r.Reviewer!.FullName,
                })
                .FirstOrDefaultAsync();`,
        `            ViewBag.LastRound = await _db.ReviewRounds
                .AsNoTracking()
                .Where(r => r.ProjectId == id && r.SubmittedAt != null)
                .OrderByDescending(r => r.Number)
                .Select(r => new ReviewSummary
                {
                    Number          = r.Number,
                    Notes           = r.Notes,
                    Verdict         = r.Verdict,
                    SubmittedAt     = r.SubmittedAt,
                    SuggestionCount = r.SuggestionCount,
                    FlagCount       = r.FlagCount,
                    ReviewerName    = r.Reviewer!.FullName,
                })
                .FirstOrDefaultAsync();`,
        'LastRound uses ReviewSummary',
    ],
]);

edit('Controllers/ReviewController.cs', [
    [
        `using TraMslate.Services;`,
        `using TraMslate.Services;
using TraMslate.ViewModels;`,
        'using ViewModels',
    ],
    [
        `            ViewBag.Flagged = await _db.SubtitleEvents.AsNoTracking()
                .Where(e => e.ProjectId == id && e.ReviewFlag != ReviewFlag.None)
                .OrderBy(e => e.Index)
                .Select(e => new
                {
                    e.Index,
                    e.ReviewFlag,
                    e.ReviewSeverity,
                    e.ReviewNote,
                    e.OriginalText,
                    e.TranslatedText,
                    e.SuggestedText,
                })
                .ToListAsync();`,
        `            ViewBag.Flagged = await _db.SubtitleEvents.AsNoTracking()
                .Where(e => e.ProjectId == id && e.ReviewFlag != ReviewFlag.None)
                .OrderBy(e => e.Index)
                .Select(e => new FlaggedLine
                {
                    Index          = e.Index,
                    Flag           = e.ReviewFlag,
                    Severity       = e.ReviewSeverity,
                    Note           = e.ReviewNote,
                    OriginalText   = e.OriginalText,
                    TranslatedText = e.TranslatedText,
                    SuggestedText  = e.SuggestedText,
                })
                .ToListAsync();`,
        'Flagged uses FlaggedLine',
    ],
]);

edit('Views/Project/Editor.cshtml', [
    [
        `    var lastRound = ViewBag.LastRound;`,
        `    var lastRound = ViewBag.LastRound as TraMslate.ViewModels.ReviewSummary;`,
        'typed lastRound',
    ],
    [
        `                Round @lastRound.Number from @lastRound.Reviewer`,
        `                Round @lastRound.Number from @lastRound.ReviewerName`,
        'reviewer name property',
    ],
    [
        `                @if (!string.IsNullOrWhiteSpace((string?)lastRound.Notes))`,
        `                @if (!string.IsNullOrWhiteSpace(lastRound.Notes))`,
        'notes without a cast',
    ],
]);

process.exit(ok ? 0 : 1);
