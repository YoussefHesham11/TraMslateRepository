// Brings the review workflow into the editor view: the role flag the scripts
// branch on, the revisor's toolbar, the suggestions toggle, the banner that
// carries the last report, and the panel a revisor submits a round from.
const fs = require('fs');
const p = 'Views/Project/Editor.cshtml';
const raw = fs.readFileSync(p, 'utf8');
const crlf = raw.includes('\r\n');
let s = raw.replace(/\r\n/g, '\n');
let ok = true;

function swap(from, to, label) {
    const i = s.indexOf(from);
    if (i < 0) { console.error('MISS: ' + label); ok = false; return; }
    if (s.indexOf(from, i + 1) >= 0) { console.error('AMBIGUOUS: ' + label); ok = false; return; }
    s = s.slice(0, i) + to + s.slice(i + from.length);
    console.log('ok   ' + label);
}

swap(
`@model TraMslate.Models.Project
@{ ViewData["Title"] = Model.Title; Layout = "~/Views/Shared/_Layout.cshtml"; }`,
`@model TraMslate.Models.Project
@using TraMslate.Models
@{
    ViewData["Title"] = Model.Title;
    Layout = "~/Views/Shared/_Layout.cshtml";

    // The editor is one screen in two modes rather than two pages, because a
    // revisor needs the same video, timeline and quality checks the translator
    // had. Everything role-dependent branches off these.
    var isRevisor = (string)ViewBag.Role == nameof(ProjectRole.Revisor);
    var lastRound = ViewBag.LastRound;
}`,
    'role flags in the view');

// ── Status control: only the translator drives it ──
swap(
`            <select id="projectStatus" class="tm-speed-select" aria-label="Project status" asp-for="Status">
                <option value="InProgress">In progress</option><option value="UnderReview">Under review</option><option value="Completed">Completed</option>
            </select>`,
`            @if (isRevisor)
            {
                <span class="tm-role-badge" title="You were invited to revise this project">
                    <i class="bi bi-search"></i> Revising
                </span>
            }
            else
            {
                <select id="projectStatus" class="tm-speed-select" aria-label="Project status" asp-for="Status">
                    <option value="InProgress">In progress</option>
                    <option value="UnderReview">With revisor</option>
                    <option value="ChangesRequested">Revised</option>
                    <option value="Completed">Completed</option>
                </select>
            }`,
    'status is the translator’s, revisor gets a badge');

// ── Import and export belong to the translator ──
swap(
`            <label class="tm-btn-sm" style="cursor:pointer;" title="Import an SRT/VTT subtitle file, or a Word document with one dialogue line per paragraph">
                <i class="bi bi-file-earmark-arrow-up"></i> Import Script
                <input type="file" id="importScript" accept=".srt,.vtt,.docx" style="display:none;" />
            </label>`,
`            @if (!isRevisor)
            {
                <label class="tm-btn-sm" style="cursor:pointer;" title="Import an SRT/VTT subtitle file, or a Word document with one dialogue line per paragraph">
                    <i class="bi bi-file-earmark-arrow-up"></i> Import Script
                    <input type="file" id="importScript" accept=".srt,.vtt,.docx" style="display:none;" />
                </label>
            }`,
    'import is the translator’s');

// ── Review actions in the top bar ──
swap(
`            <button class="tm-btn-sm tm-btn-sm-primary" id="btnSave">
                <i class="bi bi-floppy"></i> Save
            </button>`,
`            <button class="tm-btn-sm tm-btn-sm-primary" id="btnSave">
                <i class="bi bi-floppy"></i> Save
            </button>
            @if (isRevisor)
            {
                <button class="tm-btn-sm tm-btn-sm-primary" id="btnFinishReview" type="button"
                        title="Write your report and send this project back">
                    <i class="bi bi-send-check"></i> Finish review
                </button>
            }
            else
            {
                <form asp-controller="Review" asp-action="SendForReview" asp-route-id="@Model.Id"
                      method="post" style="margin:0;">
                    @Html.AntiForgeryToken()
                    <button type="submit" class="tm-btn-sm" id="btnSendForReview"
                            title="Hand this project to the revisor">
                        <i class="bi bi-send"></i> Send for review
                    </button>
                </form>
                <a asp-controller="Review" asp-action="People" asp-route-id="@Model.Id"
                   class="tm-icon-btn" title="People on this project and its revision history">
                    <i class="bi bi-people"></i>
                </a>
            }`,
    'review actions');

// ── Banner: the report that came back ──
swap(
`    <!-- ── Banner: crash recovery, save conflicts ── -->
    <div class="tm-banner" id="editorBanner" role="status" hidden></div>`,
`    <!-- ── Banner: crash recovery, save conflicts ── -->
    <div class="tm-banner" id="editorBanner" role="status" hidden></div>

    @if (!isRevisor && lastRound != null)
    {
        <!-- The last report the revisor filed, so the translator never has to
             go looking for why the project came back. -->
        <details class="tm-review-summary" @(Model.Status == ProjectStatus.ChangesRequested ? "open" : "")>
            <summary>
                <i class="bi bi-journal-text"></i>
                Round @lastRound.Number from @lastRound.Reviewer
                &nbsp;·&nbsp; @lastRound.SuggestionCount suggestion@(lastRound.SuggestionCount == 1 ? "" : "s")
                &nbsp;·&nbsp; @lastRound.FlagCount flagged
            </summary>
            <div class="tm-review-summary-body">
                @if (!string.IsNullOrWhiteSpace((string?)lastRound.Notes))
                {
                    <p class="tm-review-summary-notes">@lastRound.Notes</p>
                }
                else
                {
                    <p class="tm-tool-hint">No written report for that round.</p>
                }
                <a asp-controller="Review" asp-action="Report" asp-route-id="@Model.Id" asp-route-number="@lastRound.Number"
                   class="tm-btn-sm"><i class="bi bi-box-arrow-up-right"></i> Full report</a>
            </div>
        </details>
    }`,
    'last report banner');

// ── Suggestions toggle in the cue panel header ──
swap(
`                <button class="tm-icon-btn-sm" id="btnSwapColumns" title="Swap original/translation columns"><i class="bi bi-arrow-left-right"></i></button>`,
`                <button class="tm-icon-btn-sm tm-suggestions-toggle" id="btnToggleSuggestions"
                        title="Show or hide the revisor's suggestions column" aria-pressed="false">
                    <i class="bi bi-lightbulb"></i>
                    <span class="tm-suggestion-count" id="suggestionCount" hidden></span>
                </button>
                <button class="tm-icon-btn-sm" id="btnSwapColumns" title="Swap original/translation columns"><i class="bi bi-arrow-left-right"></i></button>`,
    'suggestions toggle');

// ── Filters for review state ──
swap(
`                        <option value="status-3">Approved</option>
                    </select>`,
`                        <option value="status-3">Approved</option>
                        <option value="suggested">Has a suggestion</option>
                        <option value="flagged">Flagged by revisor</option>
                    </select>`,
    'review filters');

// ── Finish-review dialog ──
swap(
`    <div class="tm-timeline-wrap" id="timelineWrap">`,
`    @if (isRevisor)
    {
        <!-- Submitting a round is a real form post rather than a fetch, so the
             revisor lands on their own report afterwards. -->
        <div class="tm-modal-backdrop" id="reviewModal" style="display:none;">
            <form class="tm-modal tm-review-modal" asp-controller="Review" asp-action="SubmitReview"
                  asp-route-id="@Model.Id" method="post">
                @Html.AntiForgeryToken()
                <h3 class="tm-modal-title"><i class="bi bi-journal-text"></i> Finish this review</h3>
                <p class="tm-modal-msg">
                    Your suggestions and flags are already saved with the project. This is the
                    note the translator reads first.
                </p>

                <label for="reviewNotes" class="tm-col-label">Report for the translator</label>
                <textarea id="reviewNotes" name="notes" rows="8" class="tm-review-notes" dir="auto"
                          placeholder="What you changed and why, patterns worth watching for, anything they should check…"></textarea>
                <p class="tm-review-stats" id="reviewStats"></p>

                <div class="tm-review-verdict">
                    <label>
                        <input type="radio" name="verdict" value="@((int)ReviewVerdict.ChangesRequested)" checked />
                        <span><strong>Send back</strong> — the translator works through your suggestions.</span>
                    </label>
                    <label>
                        <input type="radio" name="verdict" value="@((int)ReviewVerdict.Approved)" />
                        <span><strong>Approve</strong> — this is ready to deliver.</span>
                    </label>
                </div>

                <div class="tm-modal-actions">
                    <button type="button" class="tm-btn-sm" id="cancelReview" style="padding:8px 20px;">Cancel</button>
                    <button type="submit" class="tm-btn tm-btn-primary" style="width:auto;">
                        <i class="bi bi-send-check"></i> Submit review
                    </button>
                </div>
            </form>
        </div>
    }

    <div class="tm-timeline-wrap" id="timelineWrap">`,
    'finish-review dialog');

// ── Hand the role to the scripts ──
swap(
`    const PROJECT_ID   = @Model.Id;`,
`    const PROJECT_ID   = @Model.Id;
    // The editor branches on this rather than asking the server again.
    const USER_ROLE    = "@ViewBag.Role";
    const CAN_EDIT_TRANSLATION = @((bool)ViewBag.CanEditTranslation ? "true" : "false");
    const CAN_REVIEW   = @((bool)ViewBag.CanReview ? "true" : "false");`,
    'role constants');

if (!ok) { console.error('ABORT'); process.exit(1); }
fs.writeFileSync(p, crlf ? s.replace(/\n/g, '\r\n') : s);
console.log('patched');
