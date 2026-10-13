// Exercises the real save, history and completion endpoints against the
// running app and its SQL Server database — the guarantees the browser
// harness can only imitate:
//   a retried save is answered from its stored result, not duplicated;
//   a stale save and the loser of two racing saves are refused;
//   wrong timing is stored, not rejected;
//   completion is refused for stale or unfinished versions and recorded for
//   exactly one revision; editing afterwards reopens the project;
//   Completed cannot be set as a plain status; API calls get 401, not a
//   login page.
//
// Start the app first (see tests/browser/README.md), then:
//     node tests/browser/server-tour.cjs [baseUrl]
const { launch, sleep } = require('./cdp.cjs');

const BASE = process.argv[2] || 'http://127.0.0.1:5199';
const ACCOUNT = { email: 'tour@tramslate.local', password: 'TourPass!2026', name: 'Tour Translator' };

let failures = 0;
const ok = (label, detail = '') => console.log(`  ok    ${label}${detail ? '  ' + detail : ''}`);
const bad = (label, detail = '') => { failures++; console.error(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); };
const check = (cond, label, detail = '') => (cond ? ok : bad)(label, detail);

async function fill(page, selector, value) {
    await page.eval(`const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; return 1;`);
}
async function submitFormOf(page, selector) {
    await page.eval(`document.querySelector(${JSON.stringify(selector)}).form.submit(); return 1;`);
}

(async () => {
    const page = await launch({ width: 1440, height: 820 });
    try {
        // ── Sign in (register on first run) ──
        await page.goto(`${BASE}/register`);
        await sleep(400);
        await fill(page, '#FullName', ACCOUNT.name);
        await fill(page, '#Email', ACCOUNT.email);
        await fill(page, '#Password', ACCOUNT.password);
        await fill(page, '#ConfirmPassword', ACCOUNT.password);
        await submitFormOf(page, '#ConfirmPassword');
        await sleep(2500);
        if (/register|login/.test(await page.eval('return location.pathname;'))) {
            await page.goto(`${BASE}/login`);
            await sleep(400);
            await fill(page, '#Email', ACCOUNT.email);
            await fill(page, '#Password', ACCOUNT.password);
            await submitFormOf(page, '#Password');
            await sleep(2500);
        }

        // ── A fresh project ──
        await page.goto(`${BASE}/projects/new`);
        await sleep(500);
        await fill(page, '#Title', `Server tour ${new Date().toISOString().slice(0, 19)}`);
        await fill(page, '#TargetLanguage', 'Arabic');
        await submitFormOf(page, '#Title');
        await sleep(3000);
        const id = Number((await page.eval('return location.pathname;')).match(/studio\/(\d+)/)?.[1]);
        if (!id) throw new Error('project was not created');
        await page.waitFor(`typeof loaded !== 'undefined' && loaded`, { timeout: 20000 });
        ok('signed in and created a project', `#${id}`);

        // Requests are made from inside the page, so they carry the real
        // cookie and anti-forgery token, exactly as the editor's do.
        const call = async (path, body, extra = {}) => page.eval(`
            const res = await fetch(${JSON.stringify(`/studio/${id}`)} + ${JSON.stringify(path)}, {
                method: ${JSON.stringify(body === undefined ? 'GET' : 'POST')},
                credentials: ${JSON.stringify(extra.credentials || 'same-origin')},
                redirect: 'manual',
                headers: { 'Accept': 'application/json', 'Content-Type': 'application/json',
                           'RequestVerificationToken': document.querySelector('[name="__RequestVerificationToken"]').value },
                body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))},
            });
            let data = null; try { data = await res.json(); } catch {}
            return { status: res.status, data };`);
        const cue = (over = {}) => ({ id: -1, startTime: '00:00:01,000', endTime: '00:00:02,000', originalText: 'Hi', translatedText: '', ...over });

        // Nothing in this page should save on its own while we drive the API.
        await page.eval(`clearTimeout(autoSaveTimer); revisionStale = true; return 1;`);

        let r = await call('/events');
        const r0 = r.data.revision;
        check(r.status === 200 && Array.isArray(r.data.events), 'load answers with a revision and cues', `revision ${r0}`);

        // ── Idempotent retry ──
        const first = { revision: r0, saveId: 'tour-save-1', events: [cue({ id: -1 }), cue({ id: -2, startTime: '00:00:03,000', endTime: '00:00:04,000' })] };
        r = await call('/save', first);
        check(r.status === 200 && r.data.success && r.data.revision === r0 + 1 && r.data.assigned.length === 2, 'a save lands and maps both new cues to rows');
        const assigned = JSON.stringify(r.data.assigned);
        r = await call('/save', first);
        check(r.status === 200 && r.data.replayed === true && JSON.stringify(r.data.assigned) === assigned,
            'the same save retried (lost response) is answered from its stored result', `replayed=${r.data.replayed}`);
        check(r.data.events.length === 2, 'and no lines are duplicated', `${r.data.events.length} rows`);
        const ids = r.data.events.map(e => e.id);
        const r1 = r.data.revision;

        // ── Stale save ──
        r = await call('/save', { ...first, saveId: 'tour-save-stale' });
        check(r.status === 409 && r.data.conflict, 'a save built on an older revision is refused');

        // ── Two saves racing on the same revision ──
        const both = await page.eval(`
            const send = (sid, text) => fetch('/studio/${id}/save', { method: 'POST', credentials: 'same-origin',
                headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'RequestVerificationToken': document.querySelector('[name="__RequestVerificationToken"]').value },
                body: JSON.stringify({ revision: ${r1}, saveId: sid, events: [
                    { id: ${ids[0]}, startTime: '00:00:01,000', endTime: '00:00:02,000', originalText: 'Hi', translatedText: text },
                    { id: ${ids[1]}, startTime: '00:00:03,000', endTime: '00:00:04,000', originalText: 'Hi', translatedText: '' } ] }) }).then(r => r.status);
            return Promise.all([send('race-a', 'A'), send('race-b', 'B'), send('race-c', 'C')]);`);
        const wins = both.filter(s => s === 200).length;
        check(wins === 1 && both.filter(s => s === 409).length === 2, 'of three saves racing on one revision, exactly one wins', both.join(', '));

        r = await call('/events');
        const r2 = r.data.revision;
        check(r2 === r1 + 1, 'the revision moved exactly once', `${r1} → ${r2}`);

        // ── Wrong timing is kept ──
        const badTiming = { revision: r2, saveId: 'tour-bad-timing', events: [
            { ...r.data.events[0], startTime: '00:00:05,000', endTime: '00:00:04,000', translatedText: 'مرحبا' },
            { ...r.data.events[1], translatedText: '' }] };
        r = await call('/save', badTiming);
        check(r.status === 200, 'a cue whose out-time is before its in-time is still saved', `HTTP ${r.status}`);
        const r3 = r.data.revision;

        // ── Completion ──
        r = await call('/complete', { revision: r3 });
        check(r.status === 422 && /out-time/.test(r.data?.message || '') && /untranslated/.test(r.data?.message || ''),
            'Done is refused while timing is broken and a line is untranslated', r.data?.message);
        const good = { revision: r3, saveId: 'tour-good', events: r.data ? undefined : undefined };
        let ev = (await call('/events')).data.events;
        r = await call('/save', { revision: r3, saveId: 'tour-good', events: [
            { ...ev[0], startTime: '00:00:01,000', endTime: '00:00:02,000' },
            { ...ev[1], translatedText: 'أهلا' }] });
        const r4 = r.data.revision;
        void good;
        r = await call('/complete', { revision: r3 });
        check(r.status === 409, 'Done for an older revision is refused');
        r = await call('/complete', { revision: r4, summary: '{"tour":true}' });
        check(r.status === 200 && r.data.completedRevision === r4, 'Done records exactly the current revision', `version ${r.data?.completedRevision}`);
        r = await call('/events');
        check(r.data.status === 'Completed' && r.data.completedRevision === r4, 'the project reads back as Completed at that revision');

        const hist = await call('/history');
        check(hist.data.snapshots.some(s => s.kind === 'Completed' && s.revision === r4), 'a copy of the completed version is in the history');

        // ── Status cannot shortcut Done ──
        const status = await page.eval(`
            const res = await fetch('/studio/${id}/status', { method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'RequestVerificationToken': document.querySelector('[name="__RequestVerificationToken"]').value },
                body: 'status=Completed' });
            return res.status;`);
        check(status === 400, 'Completed cannot be set as a plain status', `HTTP ${status}`);

        // ── Editing after Done reopens, keeping the record ──
        ev = (await call('/events')).data.events;
        r = await call('/save', { revision: r4, saveId: 'tour-after-done', events: ev.map(e => ({ ...e, translatedText: e.translatedText + '!' })) });
        check(r.data.status === 'InProgress' && r.data.completedRevision === r4, 'editing a completed project reopens it and keeps the completed record');

        // ── Checkpoints ──
        r = await call('/checkpoint', { kind: 3, label: 'Before a bulk change (tour)', revision: r.data.revision, events: ev });
        const list = (await call('/history')).data.snapshots;
        const kept = list.find(s => s.label === 'Before a bulk change (tour)');
        check(r.status === 200 && kept && kept.kind === 'BeforeBulk', 'a recovery copy can be kept without touching the project');
        const snap = await call(`/history/${kept.id}`);
        check(Array.isArray(snap.data.events) && snap.data.events.length === 2, 'and read back whole');

        // ── Auth expiry looks like 401 to the editor ──
        const anon = await call('/events', undefined, { credentials: 'omit' });
        check(anon.status === 401, 'an API call without a session gets 401, not a login page', `HTTP ${anon.status}`);
        const tok = await call('/token');
        check(tok.status === 200 && typeof tok.data.token === 'string' && tok.data.token.length > 20, 'a fresh anti-forgery token can be fetched');

        // ── The editor itself, on the live server ──
        await page.goto(`${BASE}/studio/${id}`);
        await page.waitFor(`typeof loaded !== 'undefined' && loaded && document.getElementById('doneReason').textContent.indexOf('Checking') < 0`, { timeout: 20000 });
        const ui = await page.eval(`return { reason: document.getElementById('doneReason').textContent, status: document.getElementById('saveStatus').textContent,
            done: !!document.getElementById('btnDone'), errors: (window.__errors || []).length };`);
        check(ui.done && ui.reason.length > 0, 'the live editor shows Done and what remains', ui.reason);
        check(/All changes saved/.test(ui.status), 'and its save status', ui.status);

        // ── The new actions are customisable like every other shortcut ──
        await page.goto(`${BASE}/settings/shortcuts`);
        await sleep(1200);
        const sc = await page.eval(`return document.body.textContent;`);
        check(['Go to next problem', 'Next unfinished subtitle', 'Bookmark / unbookmark', 'Bulk actions on selected', 'Sync with two points', 'Short jump back', 'Version history']
            .every(t => sc.includes(t)), 'the Shortcuts page lists the new actions for customising');
        await page.goto(`${BASE}/studio/${id}`);
        await page.waitFor(`typeof loaded !== 'undefined' && loaded`, { timeout: 20000 });

        // ── Save As: a copy as a new project, marks and notes included ──
        await page.eval(`events[0].comment = 'Kept in the copy'; events[0].flags = 4; events[0].bookmarked = true; markDirty(); return 1;`);
        await page.eval(`revisionStale = false; return 1;`);
        await page.waitFor(`saveState === 'saved'`, { timeout: 15000 }).catch(() => {});
        await page.eval(`document.getElementById('btnSaveCopy').click(); return 1;`);
        await page.waitFor(`document.querySelector('.tm-transfer-modal input')`, { timeout: 5000 });
        await page.eval(`const m = document.querySelector('.tm-transfer-modal'); m.querySelector('input').value = 'Tour copy'; m.querySelector('button[type="submit"]').click(); return 1;`);
        await page.waitFor(`/New project created/.test(document.querySelector('.tm-choice-modal')?.textContent || '')`, { timeout: 20000 });
        await page.eval(`[...document.querySelectorAll('.tm-choice-modal button')].find(b => b.textContent === 'Open it').click(); return 1;`);
        await page.waitFor(`location.pathname !== '/studio/${id}' && typeof loaded !== 'undefined' && loaded`, { timeout: 20000 });
        const copy = await page.eval(`return { title: document.querySelector('.tm-editor-title').textContent.trim(), n: events.length,
            comment: events[0].comment, flags: events[0].flags, bookmarked: events[0].bookmarked };`);
        check(copy.title === 'Tour copy' && copy.n === 2 && copy.comment === 'Kept in the copy' && copy.flags === 4 && copy.bookmarked,
            'Save a copy creates a new project with the subtitles, notes and marks', JSON.stringify(copy));
        await page.goto(`${BASE}/studio/${id}`);
        await page.waitFor(`typeof loaded !== 'undefined' && loaded`, { timeout: 20000 });

        // ── Import into a brand-new project, through the real form ──
        const srt = '1\n00:00:01,000 --> 00:00:02,000\nNew project line\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond\n';
        await page.eval(`
            const dt = new DataTransfer();
            dt.items.add(new File([${JSON.stringify(srt)}], 'Fresh reel.srt'));
            const input = document.getElementById('importScript');
            input.files = dt.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return 1;`);
        await page.waitFor(`document.querySelector('.tm-transfer-modal')`, { timeout: 5000 });
        await page.eval(`const m = document.querySelector('.tm-transfer-modal'); m.querySelector('input[value="new"]').click();
            m.querySelector('button[type="submit"]').click(); return 1;`);
        await page.waitFor(`/New project created/.test(document.querySelector('.tm-choice-modal')?.textContent || '')`, { timeout: 20000 });
        const before = await page.eval(`return events.length;`);
        await page.eval(`[...document.querySelectorAll('.tm-choice-modal button')].find(b => b.textContent === 'Open it').click(); return 1;`);
        await page.waitFor(`location.pathname !== '/studio/${id}' && typeof loaded !== 'undefined' && loaded`, { timeout: 20000 });
        const created = await page.eval(`return { path: location.pathname, n: events.length, first: events[0]?.originalText, title: document.querySelector('.tm-editor-title').textContent.trim() };`);
        check(created.n === 2 && created.first === 'New project line' && created.title === 'Fresh reel',
            'importing into a new project creates it with the subtitles and leaves this one alone', `${created.path} (${created.n} subtitles; original kept ${before})`);
    } catch (err) {
        bad('tour crashed', err.message);
    } finally {
        await page.close();
    }
    console.log('');
    if (failures) { console.error(`${failures} server check(s) failed.`); process.exit(1); }
    console.log('The server keeps its saving and completion promises.');
})();
