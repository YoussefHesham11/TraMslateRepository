// Drives one full review round through the running application with two real
// accounts: the translator hands a project over, the revisor suggests and
// flags, the translator restructures the track and works through the
// suggestions, and the revisor files a report.
//
// The case it exists for: inserting a line above a suggested line must not
// move that suggestion onto a different line. Saves used to match stored rows
// by position, so they did.
//
// Start the app first, then:
//     node tests/browser/review-tour.cjs [baseUrl]
const { launch, sleep } = require('./cdp.cjs');

const BASE = process.argv[2] || 'http://127.0.0.1:5199';
const TRANSLATOR = { email: 'tour@tramslate.local', password: 'TourPass!2026', name: 'Tour Translator' };
const REVISOR = { email: 'tour-revisor@tramslate.local', password: 'TourPass!2026', name: 'Tour Revisor' };
const TITLE = 'Tour Review — Reel 1';

const failures = [];
function check(ok, message) {
    console.log((ok ? '  ok    ' : '  FAIL  ') + message);
    if (!ok) failures.push(message);
}

async function setField(page, selector, value) {
    await page.eval(`
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('no field ' + ${JSON.stringify(selector)});
        el.value = ${JSON.stringify(value)};
        return 1;`);
}

async function submitFormOf(page, selector) {
    await page.eval(`document.querySelector(${JSON.stringify(selector)}).form.submit(); return 1;`);
}

// Registers the account, or signs in when it already exists.
async function signIn(page, account) {
    await page.goto(`${BASE}/register`);
    await sleep(400);
    await setField(page, '#FullName', account.name);
    await setField(page, '#Email', account.email);
    await setField(page, '#Password', account.password);
    await setField(page, '#ConfirmPassword', account.password);
    await submitFormOf(page, '#ConfirmPassword');
    await sleep(2000);
    if (!(await page.eval('return location.pathname;')).includes('dashboard')) {
        await page.goto(`${BASE}/login`);
        await sleep(400);
        await setField(page, '#Email', account.email);
        await setField(page, '#Password', account.password);
        await submitFormOf(page, '#Password');
        await sleep(2000);
    }
    const where = await page.eval('return location.pathname;');
    if (!where.includes('dashboard')) throw new Error(account.email + ' could not sign in');
}

async function openStudio(page, id) {
    await page.goto(`${BASE}/studio/${id}`);
    try {
        await page.waitFor("typeof loaded !== 'undefined' && loaded === true", { timeout: 20000 });
    } catch (err) {
        const where = await page.eval("return location.pathname + ' — ' + document.title + ' — ' + document.body.innerText.slice(0, 200);").catch(e => 'unreadable: ' + e.message);
        throw new Error(`editor did not load at ${where}`);
    }
}

async function saveAndWait(page) {
    await page.eval('clearTimeout(autoSaveTimer); doSave(); return 1;');
    await page.waitFor("!saving && document.getElementById('saveStatus').textContent.indexOf('All changes saved') >= 0", { timeout: 20000 });
}

const serverEvents = page => page.eval(`
    const res = await fetch('/studio/' + PROJECT_ID + '/events');
    return (await res.json()).events;`);

(async () => {
    const t = await launch({ width: 1440, height: 820 });
    const r = await launch({ width: 1440, height: 820 });
    let projectId = null;
    try {
        await signIn(r, REVISOR);
        await signIn(t, TRANSLATOR);

        // ── The translator creates a project with three lines ──
        await t.goto(`${BASE}/projects/new`);
        await sleep(500);
        await setField(t, '#Title', TITLE);
        await setField(t, '#TargetLanguage', 'Arabic');
        await submitFormOf(t, '#Title');
        await sleep(2500);
        projectId = Number((await t.eval('return location.pathname;')).match(/studio\/(\d+)/)?.[1]);
        if (!projectId) throw new Error('project was not created');
        await openStudio(t, projectId);
        await t.eval(`
            events = [
                { id: -1, startTime: '00:00:01,000', endTime: '00:00:03,000', originalText: 'We should go now.', translatedText: 'A', originalLocked: true },
                { id: -2, startTime: '00:00:05,000', endTime: '00:00:07,000', originalText: 'Not without her.',  translatedText: 'B', originalLocked: true },
                { id: -3, startTime: '00:00:08,000', endTime: '00:00:10,000', originalText: 'Then we wait.',     translatedText: 'C', originalLocked: true },
            ];
            markDirty(); renderEvents(); return 1;`);
        await saveAndWait(t);
        check((await t.eval('return events.every(e => e.id > 0);')), 'new lines adopt their stored ids after saving');

        // ── Invite the revisor and hand the project over ──
        await t.goto(`${BASE}/studio/${projectId}/people`);
        await sleep(500);
        await setField(t, '#inviteEmail', REVISOR.email);
        await submitFormOf(t, '#inviteEmail');
        await sleep(1500);
        await openStudio(t, projectId);
        await t.eval("document.getElementById('btnSendForReview').form.submit(); return 1;");
        await sleep(1500);

        // ── The revisor suggests a change on line 2 ──
        await openStudio(r, projectId);
        check(await r.eval('return IS_REVISOR;'), 'the invited account opens the editor as revisor');
        check(await r.eval("return ['btnAddEvent','btnSplitCue','btnMergeCue'].every(id => document.getElementById(id).hidden);"),
            'the revisor does not see add, split or merge');
        await r.eval(`
            const ev = events.find(e => e.originalText === 'Not without her.');
            ev.suggestedText = 'B-better'; ev.reviewFlag = 4; ev.reviewSeverity = 2; ev.reviewNote = 'use the glossary term';
            markDirty(); return 1;`);
        await saveAndWait(r);

        const structural = await r.eval(`
            const res = await fetch('/studio/' + PROJECT_ID + '/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json',
                           'RequestVerificationToken': document.querySelector('[name="__RequestVerificationToken"]').value },
                body: JSON.stringify({ revision: loadedRevision, events: [...events, { id: -50, startTime: '00:00:20,000', endTime: '00:00:21,000', originalText: '', translatedText: '' }] }),
            });
            return res.status;`);
        check(structural === 400, `the server refuses a revisor adding a line (got ${structural})`);

        // ── The translator inserts a line above the suggested one ──
        await openStudio(t, projectId);
        await t.eval(`
            selectEvent(events[0].id);
            document.getElementById('btnAddEvent').click();
            events[1].translatedText = 'NEW'; markDirty(); return 1;`);
        await saveAndWait(t);
        // A second save must update the new line, not add it again.
        await t.eval("events[1].translatedText = 'NEW2'; markDirty(); return 1;");
        await saveAndWait(t);

        let stored = await serverEvents(t);
        check(stored.length === 4, `four lines stored after insert + second save (saw ${stored.length})`);
        const target = stored.find(e => e.originalText === 'Not without her.');
        const inserted = stored[1];
        check(inserted && inserted.translatedText === 'NEW2' && !inserted.suggestedText && !inserted.reviewFlag,
            'the inserted line carries no review data');
        check(target && target.suggestedText === 'B-better' && target.reviewFlag === 4 && target.reviewNote === 'use the glossary term',
            'the suggestion, flag and note stayed on "Not without her."');
        check(stored[3].originalText === 'Then we wait.' && !stored[3].suggestedText, 'the line after it gained nothing');

        // ── The translator accepts it ──
        await openStudio(t, projectId);
        await t.eval(`applySuggestion(events.find(e => e.originalText === 'Not without her.').id); return 1;`);
        await saveAndWait(t);
        stored = await serverEvents(t);
        const accepted = stored.find(e => e.originalText === 'Not without her.');
        check(accepted.translatedText === 'B-better' && accepted.suggestionState === 2 && accepted.previousTranslatedText === 'B',
            'accepting applies the suggestion and keeps the translator\'s line for revert');

        // ── Deleting a line keeps review data on the survivors ──
        await t.eval("events.splice(1, 1); markDirty(); return 1;");
        await saveAndWait(t);
        stored = await serverEvents(t);
        check(stored.length === 3 && stored[1].originalText === 'Not without her.' && stored[1].reviewFlag === 4,
            'deleting a line above leaves the flag on its own line');

        // ── Both at work at once ──
        // Each save bumps the project revision, so every save after the other
        // seat's one is refused at first; the editor must merge and carry on
        // rather than demand a reload.
        await openStudio(t, projectId);
        await openStudio(r, projectId);
        await r.eval(`
            const ev = events.find(e => e.originalText === 'Then we wait.');
            ev.suggestedText = 'C-better'; ev.reviewNote = 'tighter';
            markDirty(); return 1;`);
        await saveAndWait(r);
        await t.eval(`events.find(e => e.originalText === 'We should go now.').translatedText = 'A-edited'; markDirty(); return 1;`);
        await saveAndWait(t);
        check(!(await t.eval('return revisionStale;')), 'the translator saved over the revisor\'s save without a reload');
        await r.eval(`events.find(e => e.originalText === 'We should go now.').reviewNote = 'fine now'; markDirty(); return 1;`);
        await saveAndWait(r);
        check(!(await r.eval('return revisionStale;')), 'and the revisor saved over the translator\'s without a reload');
        stored = await serverEvents(t);
        const first = stored.find(e => e.originalText === 'We should go now.');
        const last = stored.find(e => e.originalText === 'Then we wait.');
        check(first.translatedText === 'A-edited' && first.reviewNote === 'fine now'
            && last.suggestedText === 'C-better' && last.reviewNote === 'tighter',
            'all three changes are stored');
        check(await r.eval("return events.find(e => e.originalText === 'We should go now.').translatedText === 'A-edited';"),
            'the revisor\'s screen shows the translator\'s new wording');

        // ── The revisor files the round ──
        await openStudio(r, projectId);
        await r.eval(`
            reviewModal.style.display = 'flex';
            document.getElementById('reviewNotes').value = 'Two terminology fixes.';
            document.querySelector('#reviewModal input[name="verdict"][value="1"]').checked = true;
            document.getElementById('reviewNotes').form.submit();
            return 1;`);
        await sleep(2000);
        const report = await r.eval("return { path: location.pathname, text: document.body.innerText };");
        check(/\/review\/1$/.test(report.path) && /Two terminology fixes/.test(report.text), 'submitting lands on the round-1 report');

        await openStudio(t, projectId);
        check(await t.eval("return document.getElementById('projectStatus').value === 'ChangesRequested';"),
            'the translator sees the project came back');
    } catch (err) {
        failures.push(err.message);
        console.error('  ERROR ' + err.message);
    } finally {
        // Always remove the project, so a failed run leaves nothing behind.
        if (projectId) {
            await t.goto(`${BASE}/dashboard`);
            await sleep(700);
            await t.eval(`
                const form = document.getElementById('deleteForm-${projectId}');
                if (form) form.submit();
                return 1;`);
            await sleep(1200);
        }
        await t.close();
        await r.close();
    }
    console.log(failures.length ? `\n${failures.length} review check(s) failed.` : '\nReview round trip behaves as expected.');
    process.exit(failures.length ? 1 : 0);
})();
