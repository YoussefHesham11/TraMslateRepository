// Deletes every project the automated tour has left behind. The tour cleans up
// after itself, but a run that fails part-way can still strand one.
//
//     node tests/browser/clean-tour-data.cjs [baseUrl]
const { launch, sleep } = require('./cdp.cjs');

const BASE = process.argv[2] || 'http://127.0.0.1:5199';
const ACCOUNT = { email: 'tour@tramslate.local', password: 'TourPass!2026' };

(async () => {
    const page = await launch({ width: 1280, height: 800 });
    try {
        await page.goto(`${BASE}/login`);
        await sleep(500);
        await page.eval(`
            document.querySelector('#Email').value = ${JSON.stringify(ACCOUNT.email)};
            document.querySelector('#Password').value = ${JSON.stringify(ACCOUNT.password)};
            document.querySelector('#Password').form.submit();
            return 1;
        `);
        await sleep(2000);

        let removed = 0;
        for (let pass = 0; pass < 50; pass++) {
            await page.goto(`${BASE}/dashboard`);
            await sleep(600);
            const left = await page.eval(`
                const forms = [...document.querySelectorAll('form[id^="deleteForm-"]')].filter(f => {
                    const card = f.closest('.tm-project-card');
                    return card && /Tour Feature/.test(card.textContent);
                });
                if (!forms.length) return 0;
                forms[0].submit();
                return forms.length;
            `);
            if (!left) break;
            removed++;
            await sleep(1200);
        }
        console.log(`removed ${removed} tour project(s)`);
    } finally {
        await page.close();
    }
})().catch(err => { console.error(err.message); process.exit(1); });
