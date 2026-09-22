// Drives the running application through its real pages and screenshots each
// one. Unlike the static harness this exercises the server: routing, Identity,
// the database and the save endpoint.
//
// Start the app first, then:
//     node tests/browser/app-tour.cjs [baseUrl]
const path = require('node:path');
const { launch, sleep } = require('./cdp.cjs');

const BASE = process.argv[2] || 'http://127.0.0.1:5199';
const SHOTS = path.join(__dirname, 'shots');
const ACCOUNT = { email: 'tour@tramslate.local', password: 'TourPass!2026', name: 'Tour Translator' };

const fs = require('node:fs');
fs.mkdirSync(SHOTS, { recursive: true });

const log = [];
function note(line) { log.push(line); console.log(line); }

// An authenticated page carries a logout form in the nav, so the first form in
// the document is not the one being filled in. Submit the form that owns the
// given field instead.
async function submitFormOf(page, selector) {
    await page.eval(`
        const field = document.querySelector(${JSON.stringify(selector)});
        if (!field || !field.form) throw new Error('no form for ' + ${JSON.stringify(selector)});
        field.form.submit();
        return 1;
    `);
}

async function fill(page, selector, value) {
    await page.eval(`
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('no field ' + ${JSON.stringify(selector)});
        el.focus();
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return 1;
    `);
}

(async () => {
    const page = await launch({ width: 1440, height: 820 });
    try {
        // ── Login page ──
        await page.goto(`${BASE}/login`);
        await sleep(600);
        await page.screenshot(path.join(SHOTS, '01-login.png'));
        note('login page captured');

        // ── Register (falls through to login if the account exists) ──
        await page.goto(`${BASE}/register`);
        await sleep(400);
        await page.screenshot(path.join(SHOTS, '02-register.png'));
        await fill(page, '#FullName', ACCOUNT.name);
        await fill(page, '#Email', ACCOUNT.email);
        await fill(page, '#Password', ACCOUNT.password);
        await fill(page, '#ConfirmPassword', ACCOUNT.password);
        await submitFormOf(page, "#ConfirmPassword");
        await sleep(2500);

        let where = await page.eval('return location.pathname;');
        if (where.includes('register') || where.includes('login')) {
            await page.goto(`${BASE}/login`);
            await sleep(400);
            await fill(page, '#Email', ACCOUNT.email);
            await fill(page, '#Password', ACCOUNT.password);
            await submitFormOf(page, "#Password");
            await sleep(2500);
            where = await page.eval('return location.pathname;');
        }
        note('signed in, landed on ' + where);

        // ── Dashboard ──
        await page.goto(`${BASE}/dashboard`);
        await sleep(800);
        await page.screenshot(path.join(SHOTS, '03-dashboard.png'));
        note('dashboard captured');

        // ── New project ──
        await page.goto(`${BASE}/projects/new`);
        await sleep(600);
        await page.screenshot(path.join(SHOTS, '04-new-project.png'));
        note('new-project page captured');

        // Create one (no video) so the editor has something to open.
        await fill(page, '#Title', 'Tour Feature — Reel 1');
        await fill(page, '#TargetLanguage', 'Arabic');
        const descOk = await page.eval("const d = document.querySelector('#Description'); if (d) { d.value = 'Created by the automated tour.'; } return !!d;");
        await submitFormOf(page, "#Title");
        await sleep(3000);
        note('project created (description field present: ' + descOk + ')');

        await page.goto(`${BASE}/dashboard`);
        await sleep(900);
        await page.screenshot(path.join(SHOTS, '05-dashboard-with-project.png'));

        // ── Editor, against the live save/load endpoints ──
        const studio = await page.eval(`
            const link = [...document.querySelectorAll('a')].find(a => /\\/studio\\//.test(a.getAttribute('href') || ''));
            return link ? link.getAttribute('href') : null;
        `);
        if (!studio) throw new Error('no project link found on the dashboard');
        await page.goto(BASE + studio);
        await page.waitFor("typeof loaded !== 'undefined' && loaded === true", { timeout: 20000 });
        await sleep(600);
        await page.screenshot(path.join(SHOTS, '06-editor-empty.png'));
        note('editor opened at ' + studio);

        // Add cues through the real UI and let them save to the database.
        await page.eval(`
            events = [
                { id: -1, index: 1, startTime: '00:00:01,000', endTime: '00:00:03,200', originalText: 'We should go now.', translatedText: 'يجب أن نذهب الآن.', originalLocked: true, status: 1 },
                { id: -2, index: 2, startTime: '00:00:03,600', endTime: '00:00:06,000', originalText: 'Not without her.',  translatedText: 'ليس من دونها.',   originalLocked: true, status: 2 },
                { id: -3, index: 3, startTime: '00:00:06,400', endTime: '00:00:09,100', originalText: 'Then we wait.',     translatedText: '',                 originalLocked: true, status: 0 },
            ];
            markDirty(); renderEvents(); renderTimelineBlocks();
            return 1;
        `);
        await page.eval('doSave(); return 1;');
        await page.waitFor("document.getElementById('saveStatus').textContent.indexOf('All changes saved') >= 0", { timeout: 20000 });
        note('cues saved to the database');

        await page.eval("selectEvent(events[0].id, { scrollBlock: 'center', focusTranslation: true }); return 1;");
        await sleep(400);
        await page.screenshot(path.join(SHOTS, '07-editor-with-cues.png'));

        // Reload and confirm the round trip, including per-cue status.
        await page.goto(BASE + studio);
        await page.waitFor("typeof loaded !== 'undefined' && loaded === true", { timeout: 20000 });
        const round = await page.eval(`
            return {
                count: events.length,
                statuses: events.map(e => e.status),
                revision: loadedRevision,
                first: events[0] && events[0].translatedText,
            };
        `);
        note('after reload: ' + JSON.stringify(round));
        if (round.count !== 3) throw new Error('expected 3 cues after reload, saw ' + round.count);
        if (JSON.stringify(round.statuses) !== '[1,2,0]') throw new Error('cue status did not round-trip: ' + JSON.stringify(round.statuses));
        if (typeof round.revision !== 'number') throw new Error('the editor did not receive a project revision');

        // ── A stale save must be refused, not applied ──
        const conflict = await page.eval(`
            const stale = loadedRevision - 1;
            const res = await fetch('/studio/' + PROJECT_ID + '/save', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'RequestVerificationToken': document.querySelector('[name="__RequestVerificationToken"]').value,
                },
                body: JSON.stringify({ revision: stale, events: [] }),
            });
            return { status: res.status, body: await res.json() };
        `);
        note('stale save responded ' + conflict.status);
        if (conflict.status !== 409) throw new Error('a stale save was not refused (got ' + conflict.status + ')');

        const survived = await page.eval(`
            const res = await fetch('/studio/' + PROJECT_ID + '/events');
            const data = await res.json();
            return data.events.length;
        `);
        if (survived !== 3) throw new Error('the refused save still changed the data (' + survived + ' cues left)');
        note('refused save left all 3 cues intact');

        // ── Clean up after itself ──
        // The tour creates a real project in a real database; leaving one
        // behind on every run would slowly fill the account with clutter.
        await page.goto(`${BASE}/dashboard`);
        await sleep(700);
        const removed = await page.eval(`
            const forms = [...document.querySelectorAll('form[id^="deleteForm-"]')];
            const mine = forms.filter(f => {
                const card = f.closest('.tm-project-card');
                return card && /Tour Feature/.test(card.textContent);
            });
            if (!mine.length) return 0;
            mine[0].submit();
            return mine.length;
        `);
        await sleep(1500);
        note(removed ? `cleaned up 1 of ${removed} tour project(s)` : 'nothing to clean up');

        await page.goto(`${BASE}/settings/shortcuts`);
        await sleep(800);
        await page.screenshot(path.join(SHOTS, '08-shortcuts.png'));
        note('shortcuts page captured');

        console.log('\nTour complete — screenshots in tests/browser/shots/');
    } finally {
        await page.close();
    }
})().catch(err => { console.error('\nTOUR FAILED: ' + err.message); process.exit(1); });
