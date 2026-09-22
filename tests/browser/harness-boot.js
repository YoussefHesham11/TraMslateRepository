// Boots the *real* editor against synthetic data so the layout check
// measures the shipped renderer rather than a copy of its markup.
//
// Everything the editor reaches for over the network is answered locally;
// nothing else about the page is faked.
(function () {
    // Anything the editor throws or logs as an error is collected here and
    // folded into the layout report, so a silent runtime failure shows up as
    // a test failure instead of an oddly empty screenshot.
    window.__errors = [];
    window.addEventListener("error", e => window.__errors.push("error: " + (e.message || e.error)));
    window.addEventListener("unhandledrejection", e => window.__errors.push("rejection: " + (e.reason && e.reason.message || e.reason)));
    const realError = console.error.bind(console);
    console.error = (...args) => { window.__errors.push("console.error: " + args.join(" ")); realError(...args); };

    const CUES = Number(new URLSearchParams(location.search).get('cues') || 150);

    const LINES = [
        ['So let’s do it.', 'فلنفعل ذلك.'],
        ['I’ll uplift it a bit.', 'سأرفعه قليلاً.'],
        ['Let me see.', ''],
        ['I’ll leave the keys in the door.', ''],
        ['Nurse, can you hear me? We need to move him now, quickly, before the shift changes over.',
         'أيتها الممرضة، هل تسمعينني؟'],
    ];

    const pad = (n, w) => String(n).padStart(w, '0');
    const tc = s => pad(Math.floor(s / 3600), 2) + ':' + pad(Math.floor(s / 60) % 60, 2) + ':'
                  + pad(Math.floor(s) % 60, 2) + ',' + pad(Math.round(s % 1 * 1000), 3);

    const cues = [];
    for (let i = 0; i < CUES; i++) {
        const [src, dst] = LINES[i % LINES.length];
        const start = 2 + i * 4.2;
        cues.push({
            id: i + 1,
            index: i + 1,
            startTime: tc(start),
            endTime: tc(start + 2.4),
            originalText: src,
            translatedText: dst,
            comment: i % 17 === 0 ? 'Check this name against the glossary.' : '',
            originalLocked: true,
        });
    }

    window.PROJECT_ID = 42;
    // Only the studio API is answered locally. Everything else — notably the
    // video file, which the waveform decoder streams — goes to the real
    // network layer, so the timeline is exercised as it is in the app.
    const realFetch = window.fetch.bind(window);
    const json = body => Promise.resolve({ ok: true, json: async () => body });
    window.fetch = (url, init) => {
        const u = String(url);
        if (u.indexOf('/events') >= 0) return json(cues);
        if (u.indexOf('/shortcuts/data') >= 0) return json({ overrides: {} });
        if (u.indexOf('/save') >= 0 || u.indexOf('/status') >= 0) return json({ success: true });
        return realFetch(url, init);
    };
})();
