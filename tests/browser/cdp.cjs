// A very small DevTools Protocol client, enough to open a page in headless
// Chrome, run expressions in it and read the results back.
//
// The simpler --dump-dom mode needs --virtual-time-budget to wait for async
// work, and that freezes performance.now(), so timings all come back as 0.
// Driving the browser directly keeps the real clock and lets the checks send
// genuine key events instead of synthesising DOM events.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(fs.existsSync);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function launch({ width = 1600, height = 900, chromeHeight = 152 } = {}) {
    if (!CHROME) throw new Error('no Chrome or Edge found');
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cdp-'));
    const port = 9000 + Math.floor(Math.random() * 900);
    const child = spawn(CHROME, [
        '--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
        '--no-first-run', '--no-default-browser-check', '--disable-extensions',
        '--force-device-scale-factor=1',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        `--window-size=${width},${height + chromeHeight}`,
        'about:blank',
    ], { stdio: 'ignore' });

    let target = null;
    for (let i = 0; i < 100 && !target; i++) {
        await sleep(100);
        try {
            const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
            target = list.find(t => t.type === 'page');
        } catch { /* not up yet */ }
    }
    if (!target) { child.kill(); throw new Error('Chrome did not expose a debugging target'); }

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP socket failed')); });

    let nextId = 1;
    const pending = new Map();
    ws.onmessage = e => {
        const msg = JSON.parse(e.data);
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        }
    };

    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
    });

    const page = {
        send,
        async goto(url) {
            await send('Page.enable');
            await send('Page.navigate', { url });
            await sleep(400);
        },
        async eval(expression) {
            const r = await send('Runtime.evaluate', {
                // Async so evaluated snippets may await (fetch, for instance);
                // awaitPromise below unwraps the result.
                expression: `(async function(){${expression}})()`,
                returnByValue: true,
                awaitPromise: true,
            });
            if (r.exceptionDetails) {
                throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
            }
            return r.result.value;
        },
        // Waits for an expression to become truthy, returning its value.
        async waitFor(expression, { timeout = 20000, every = 100 } = {}) {
            const deadline = Date.now() + timeout;
            for (;;) {
                const value = await page.eval(`return (${expression});`);
                if (value) return value;
                if (Date.now() > deadline) throw new Error('timed out waiting for: ' + expression);
                await sleep(every);
            }
        },
        async key(key, { code, keyCode, modifiers = 0, text } = {}) {
            const base = { key, code: code || key, windowsVirtualKeyCode: keyCode, modifiers };
            await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', text, ...base });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
        },
        async type(text) {
            for (const ch of text) {
                await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch });
                await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
            }
        },
        async screenshot(file) {
            const { data } = await send('Page.captureScreenshot', { format: 'png' });
            fs.writeFileSync(file, Buffer.from(data, 'base64'));
        },
        async close() {
            try { ws.close(); } catch { /* already gone */ }
            child.kill();
            await sleep(200);
            try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* locked; harmless */ }
        },
    };

    await send('Runtime.enable');
    return page;
}

module.exports = { launch, CHROME, sleep };
