// Project settings and the account page, against the running application:
// renaming a project, adding a video after creation, replacing and removing
// it, and changing the account's name and password.
//
// Start the app first, then:
//     node tests/browser/settings-tour.cjs [baseUrl]
const { launch, sleep } = require('./cdp.cjs');

const BASE = process.argv[2] || 'http://127.0.0.1:5199';
const ACCOUNT = { email: 'tour@tramslate.local', password: 'TourPass!2026', name: 'Tour Translator' };

const failures = [];
function check(ok, message) {
    console.log((ok ? '  ok    ' : '  FAIL  ') + message);
    if (!ok) failures.push(message);
}

// Posts one of the page's own forms through fetch, optionally attaching a
// small stand-in video, and reports where it landed and what it said.
const postForm = (page, formSelector, fields, video) => page.eval(`
    const form = document.querySelector(${JSON.stringify(formSelector)});
    const data = new FormData(form);
    for (const [k, v] of Object.entries(${JSON.stringify(fields)})) data.set(k, v);
    ${video ? `data.set('VideoFile', new Blob([new Uint8Array(4096)], { type: 'video/mp4' }), ${JSON.stringify(video)});` : ''}
    const res = await fetch(form.action, { method: 'POST', body: data });
    return { status: res.status, url: new URL(res.url).pathname, text: await res.text() };`);

(async () => {
    const page = await launch({ width: 1280, height: 820 });
    let projectId = null;
    try {
        await page.goto(`${BASE}/login`);
        await sleep(400);
        await page.eval(`
            document.querySelector('#Email').value = ${JSON.stringify(ACCOUNT.email)};
            document.querySelector('#Password').value = ${JSON.stringify(ACCOUNT.password)};
            document.querySelector('#Password').form.submit(); return 1;`);
        await sleep(2000);
        if (!(await page.eval('return location.pathname;')).includes('dashboard'))
            throw new Error('sign in failed — run app-tour.cjs once first to create the tour account');

        // ── A project created without a video ──
        await page.goto(`${BASE}/projects/new`);
        await sleep(400);
        await page.eval(`
            document.querySelector('#Title').value = 'Tour Settings — Reel 1';
            document.querySelector('#TargetLanguage').value = 'Arabic';
            document.querySelector('#Title').form.submit(); return 1;`);
        await sleep(2500);
        projectId = Number((await page.eval('return location.pathname;')).match(/studio\/(\d+)/)?.[1]);
        if (!projectId) throw new Error('project was not created');
        check(await page.eval("return !!document.querySelector('a[href$=\"/settings\"]');"), 'the editor links to project settings');

        // ── Rename and add a video ──
        await page.goto(`${BASE}/studio/${projectId}/settings`);
        await sleep(500);
        let res = await postForm(page, 'form[enctype]', { Title: 'Tour Settings — Renamed', TargetLanguage: 'French' }, 'clip.mp4');
        check(res.url.endsWith('/settings') && /Project settings saved/.test(res.text), 'settings save and confirm');
        await page.goto(`${BASE}/studio/${projectId}`);
        await sleep(800);
        const editor = await page.eval(`return {
            title: document.querySelector('.tm-editor-title').textContent.trim(),
            langs: document.querySelector('.tm-editor-langs').textContent.replace(/\\s+/g, ' ').trim(),
            video: !!document.getElementById('videoPlayer') };`);
        check(editor.title === 'Tour Settings — Renamed', 'the new title shows in the editor');
        check(/French/.test(editor.langs), 'the new target language shows in the editor');
        check(editor.video, 'a video added after creation appears in the editor');
        const media = await page.eval(`return (await fetch('/studio/${projectId}/media', { headers: { Range: 'bytes=0-9' } })).status;`);
        check(media === 206, `the video streams (got ${media})`);

        // ── Bad input is refused without losing the project ──
        await page.goto(`${BASE}/studio/${projectId}/settings`);
        await sleep(400);
        res = await postForm(page, 'form[enctype]', { Title: '' });
        check(/Enter a project title/.test(res.text), 'an empty title is refused with a message');
        res = await postForm(page, 'form[enctype]', {}, 'notes.txt');
        check(/Choose a video file/.test(res.text), 'a non-video upload is refused');

        // ── Remove the video ──
        await page.goto(`${BASE}/studio/${projectId}/settings`);
        await sleep(400);
        res = await postForm(page, 'form[enctype]', { removeVideo: 'true' });
        const gone = await page.eval(`return (await fetch('/studio/${projectId}/media')).status;`);
        check(gone === 404, 'removing the video removes it from the project');

        // ── Account: name and password ──
        await page.goto(`${BASE}/account`);
        await sleep(500);
        res = await postForm(page, 'form[action$="/account/profile"]', { 'Profile.FullName': 'Tour Translator Renamed' });
        check(/Profile saved/.test(res.text) && /Tour Translator Renamed/.test(res.text), 'the profile name can be changed');
        res = await postForm(page, 'form[action$="/account/password"]', {
            'Password.CurrentPassword': 'wrong-password-1', 'Password.NewPassword': 'TourPass!2027', 'Password.ConfirmPassword': 'TourPass!2027' });
        check(/current password is not correct/.test(res.text), 'a wrong current password is refused');
        res = await postForm(page, 'form[action$="/account/password"]', {
            'Password.CurrentPassword': ACCOUNT.password, 'Password.NewPassword': 'TourPass!2027', 'Password.ConfirmPassword': 'TourPass!2027' });
        check(/Password changed/.test(res.text), 'the password can be changed');
        // Put everything back so the other tours keep working.
        await page.goto(`${BASE}/account`);
        await sleep(400);
        res = await postForm(page, 'form[action$="/account/password"]', {
            'Password.CurrentPassword': 'TourPass!2027', 'Password.NewPassword': ACCOUNT.password, 'Password.ConfirmPassword': ACCOUNT.password });
        check(/Password changed/.test(res.text), 'and changed back, still signed in');
        await postForm(page, 'form[action$="/account/profile"]', { 'Profile.FullName': ACCOUNT.name });
    } catch (err) {
        failures.push(err.message);
        console.error('  ERROR ' + err.message);
    } finally {
        if (projectId) {
            await page.goto(`${BASE}/dashboard`);
            await sleep(700);
            await page.eval(`const f = document.getElementById('deleteForm-${projectId}'); if (f) f.submit(); return 1;`);
            await sleep(1200);
        }
        await page.close();
    }
    console.log(failures.length ? `\n${failures.length} settings check(s) failed.` : '\nSettings and account pages behave as expected.');
    process.exit(failures.length ? 1 : 0);
})();
