// Builds a browser-loadable copy of the editor page from the real Razor view,
// the real stylesheets and the real editor scripts. The layout defect this
// guards against — the timeline covering the cue list — lives in CSS and in
// measured scrolling, so a DOM stub in Node cannot catch it but a real browser
// can. harness-boot.js answers the editor's network calls with synthetic cues;
// nothing else about the page is faked.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

// The view has one @if/else pair, around the video element. Keep the branch
// that renders a real <video>, so the timeline and playhead are exercised.
function resolveConditionals(html) {
    const open = html.indexOf('@if (');
    if (open < 0) return html;
    const braceStart = html.indexOf('{', open);
    const endOfThen = matchBrace(html, braceStart);
    const thenBody = html.slice(braceStart + 1, endOfThen);

    let after = html.slice(endOfThen + 1);
    const elseAt = after.indexOf('else');
    if (elseAt >= 0 && after.slice(0, elseAt).trim() === '') {
        const elseBrace = after.indexOf('{', elseAt);
        after = after.slice(matchBrace(after, elseBrace) + 1);
    }
    return html.slice(0, open) + thenBody + resolveConditionals(after);
}

function matchBrace(text, start) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}' && --depth === 0) return i;
    }
    throw new Error('unbalanced braces in the view');
}

// A real upload, if the project has one, makes the timeline render with an
// actual duration and waveform instead of staying blank.
function sampleVideo() {
    const dir = path.join(ROOT, 'wwwroot', 'uploads');
    if (!fs.existsSync(dir)) return null;
    const file = fs.readdirSync(dir).find(f => /\.(mp4|webm|m4v)$/i.test(f));
    return file ? '../../wwwroot/uploads/' + file : null;
}

function razorToHtml(view) {
    const styles = view.match(/@section Styles \{([\s\S]*?)\n\}/);
    const inlineStyles = (styles ? styles[1] : '')
        .replace(/<link[^>]*href="~\/css\/([^"]+)"[^>]*\/?>/g,
            (_, f) => `<link rel="stylesheet" href="../../wwwroot/css/${f}" />`)
        .replace(/@@/g, '@');

    const bodyStart = view.indexOf('<div class="tm-editor-wrap">');
    const bodyEnd = view.indexOf('@section Scripts');
    if (bodyStart < 0 || bodyEnd < 0) throw new Error('Editor.cshtml shape changed — cannot build harness');

    const video = sampleVideo();
    let body = resolveConditionals(view.slice(bodyStart, bodyEnd))
        .replace(/@Html\.AntiForgeryToken\(\)/g, '<input type="hidden" name="__RequestVerificationToken" value="x" />')
        .replace(/@Model\.Title/g, 'The Bureau — S01E04')
        .replace(/@Model\.SourceLanguage/g, 'English')
        .replace(/@Model\.TargetLanguage/g, 'Arabic')
        .replace(/@Model\.Id/g, '42')
        .replace(/@User\.Identity!?\.Name/g, 'translator')
        .replace(/@DateTime\.UtcNow\.ToString\("[^"]*"\)/g, '20260922')
        .replace(/<source src="@Url\.Action\([^)]*\)"\s*\/?>/g,
            video ? `<source src="${video}" />` : '')
        .replace(/ asp-[a-z-]+="[^"]*"/g, '');

    if (/@[A-Za-z(]/.test(body)) {
        const leftover = body.match(/@[A-Za-z(][^\n]{0,60}/g);
        throw new Error('unhandled Razor in the harness body: ' + leftover.slice(0, 4).join(' | '));
    }
    return { inlineStyles, body };
}

// The editor's own <script> tags, in page order, pointed at the real files.
function editorScripts(view) {
    const tail = view.slice(view.indexOf('@section Scripts'));
    return [...tail.matchAll(/<script src="~\/js\/([^"]+)"[^>]*><\/script>/g)]
        .map(m => `<script src="../../wwwroot/js/${m[1]}"></script>`)
        .join('\n');
}

const view = read('Views/Project/Editor.cshtml');
const { inlineStyles, body } = razorToHtml(view);
const scripts = editorScripts(view);
if (!scripts.includes('editor.js')) throw new Error('editor.js script tag not found in the view');

const harness = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Editor layout harness</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.css" />
<link rel="stylesheet" href="../../wwwroot/css/site.css" />
<link rel="stylesheet" href="../../wwwroot/css/workspace.css" />
${inlineStyles}
</head>
<body>
<div class="tm-topnav">
  <div class="tm-topnav-left">
    <div class="tm-logo">Tra<span>M</span>slate</div>
    <nav class="tm-topnav-links"><a href="#">Dashboard</a><a href="#">New Project</a><a href="#">Shortcuts</a></nav>
  </div>
  <div class="tm-topnav-right"><span class="tm-nav-user">translator</span></div>
</div>
<main class="tm-main">
${body}
</main>
<script src="./harness-boot.js"></script>
${scripts}
<script src="./harness-measure.js"></script>
</body>
</html>
`;

fs.writeFileSync(path.join(__dirname, 'editor-harness.html'), harness);
console.log('built tests/browser/editor-harness.html');
