// Ad-hoc probe against the running app. Signs in, opens the newest project's
// editor and prints whatever expression is passed on the command line.
//     node tests/browser/probe-live.cjs "return timelineSpan();"
const { launch, sleep } = require('./cdp.cjs');

const BASE = 'http://127.0.0.1:5199';
const ACCOUNT = { email: 'tour@tramslate.local', password: 'TourPass!2026' };
const EXPR = process.argv[2] || 'return 1;';

(async () => {
    const page = await launch({ width: 1440, height: 820 });
    try {
        await page.goto(`${BASE}/login`);
        await sleep(500);
        await page.eval(`
            document.querySelector('#Email').value = ${JSON.stringify(ACCOUNT.email)};
            document.querySelector('#Password').value = ${JSON.stringify(ACCOUNT.password)};
            document.querySelector('#Password').form.submit();
            return 1;
        `);
        await sleep(2500);
        await page.goto(`${BASE}/dashboard`);
        await sleep(800);
        const studio = await page.eval(`
            const link = [...document.querySelectorAll('a')].find(a => /\\/studio\\//.test(a.getAttribute('href') || ''));
            return link ? link.getAttribute('href') : null;
        `);
        if (!studio) throw new Error('no project on the dashboard');
        await page.goto(BASE + studio);
        await page.waitFor("typeof loaded !== 'undefined' && loaded === true", { timeout: 20000 });
        await sleep(900);
        console.log(JSON.stringify(await page.eval(EXPR), null, 2));
    } finally {
        await page.close();
    }
})().catch(err => { console.error(err.message); process.exit(1); });
