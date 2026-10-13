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
    // The view prints these from the caller's role; build-harness.cjs names
    // the seat its markup was rendered for.
    window.USER_ROLE = window.__HARNESS_ROLE || 'Translator';
    window.CAN_EDIT_TRANSLATION = window.USER_ROLE === 'Translator';
    window.CAN_REVIEW = window.USER_ROLE === 'Revisor';
    // Only the studio API is answered locally. Everything else — notably the
    // video file, which the waveform decoder streams — goes to the real
    // network layer, so the timeline is exercised as it is in the app.
    const realFetch = window.fetch.bind(window);
    const reply = (body, status = 200) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });

    // A small stand-in for the studio API with the same revision rules as
    // the real one (see ProjectController): saves bump the revision, a save
    // on a stale revision is refused, new cues get stored ids, completion is
    // only accepted for the current revision. Checks steer it through
    // window.__server (failNext: 'network' | 500 | 409 | 401, etc.).
    const server = window.__server = {
        revision: 1, nextId: 100000, events: cues, snapshots: [], completed: null, saves: 0, failNext: null,
        status: 'InProgress', settings: null,
    };
    const clone = x => JSON.parse(JSON.stringify(x));
    window.fetch = (url, init = {}) => {
        const u = String(url);
        const body = init.body && typeof init.body === 'string' && init.body[0] === '{' ? JSON.parse(init.body) : null;
        if (u.indexOf('/shortcuts/data') >= 0) return reply({ overrides: {} });
        if (/\/studio\/\d+\/(save|complete|checkpoint|events|history|token)/.test(u) && server.failNext) {
            const f = server.failNext; server.failNext = null;
            if (f === 'network') return Promise.reject(new TypeError('Failed to fetch'));
            return reply(f === 409 ? { conflict: true, revision: server.revision } : null, f);
        }
        if (u.endsWith('/events')) return reply({ revision: server.revision, events: clone(server.events), settings: server.settings,
            status: server.status, completedRevision: server.completed, updatedAt: new Date().toISOString() });
        if (u.endsWith('/save') && server.hold) {
            // Keep this save in flight until the check releases it.
            const held = server.hold; server.hold = null;
            return new Promise(resolve => { server.release = () => { server.release = null; resolve(window.fetch(url, init)); }; held(); });
        }
        if (u.endsWith('/save')) {
            if (body.revision != null && body.revision !== server.revision) return reply({ conflict: true, revision: server.revision }, 409);
            const assigned = [];
            server.events = body.events.map((ev, i) => {
                const out = { ...ev, index: i + 1 };
                if (!(ev.id > 0)) { out.id = server.nextId++; assigned.push({ temp: ev.id, id: out.id }); }
                return out;
            });
            if (body.settingsJson) server.settings = body.settingsJson;
            server.revision++; server.saves++;
            if (server.status === 'Completed') server.status = 'InProgress';
            return reply({ success: true, revision: server.revision, assigned, events: clone(server.events), savedAt: new Date().toISOString(), status: server.status, completedRevision: server.completed });
        }
        if (u.endsWith('/checkpoint')) { server.snapshots.push({ id: server.snapshots.length + 1, ...body, createdAt: new Date().toISOString() }); return reply({ success: true }); }
        if (u.endsWith('/history')) return reply({ snapshots: server.snapshots.map(s => ({ id: s.id, revision: s.revision, kind: ['Checkpoint','Manual','BeforeImport','BeforeBulk','Completed','BeforeRestore','Conflict'][s.kind], label: s.label, createdAt: s.createdAt, cueCount: s.events.length, translatedCount: s.events.filter(e => (e.translatedText || '').trim()).length })) });
        const snap = /\/history\/(\d+)$/.exec(u);
        if (snap) { const s = server.snapshots.find(x => x.id === Number(snap[1])); return reply({ id: s.id, revision: s.revision, kind: 'Checkpoint', createdAt: s.createdAt, events: s.events }); }
        if (u.endsWith('/complete')) {
            if (body.revision !== server.revision) return reply({ conflict: true, revision: server.revision }, 409);
            const untranslated = server.events.filter(e => !(e.translatedText || '').trim()).length;
            if (untranslated) return reply({ success: false, message: `Not done yet: ${untranslated} untranslated.` }, 422);
            server.completed = server.revision; server.status = 'Completed';
            server.snapshots.push({ id: server.snapshots.length + 1, kind: 4, label: 'Done', revision: server.revision, events: clone(server.events), createdAt: new Date().toISOString() });
            return reply({ success: true, completedRevision: server.revision, completedAt: new Date().toISOString() });
        }
        if (u.endsWith('/token')) return reply({ token: 'fresh' });
        if (u.endsWith('/status')) return reply({ success: true });
        return realFetch(url, init);
    };
})();
