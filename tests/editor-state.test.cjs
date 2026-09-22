const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const core = require('../wwwroot/js/subtitle-core.js');

// A small DOM stub exercises the actual editor's network/state logic without a
// browser. Layout and rendering are covered separately, in a real browser, by
// tests/browser/layout-check.cjs.
function setup({ store = {}, role = 'Translator' } = {}) {
    const nodes = new Map();
    function element() {
        return {
            value: '', dataset: {}, style: {}, children: [], hidden: false,
            classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
            addEventListener() {}, removeEventListener() {}, setAttribute() {},
            appendChild(child) { this.children.push(child); return child; },
            replaceWith() {}, contains: () => false, focus() {}, click() {},
            closest: () => null, matches: () => false,
            querySelectorAll() { return []; }, querySelector() { return element(); },
            scrollIntoView() {}, scrollTo() {}, getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
            // The timeline canvas draws whenever there are cues to show, with
            // or without a video, so the stub has to answer getContext.
            width: 0, height: 0, clientWidth: 900, clientHeight: 120, offsetHeight: 120,
            scrollTop: 0, scrollLeft: 0, scrollHeight: 0, scrollWidth: 0,
            getContext: () => new Proxy({}, {
                get: (_, key) => (key === "canvas" ? undefined
                    : key === "createLinearGradient" ? () => ({ addColorStop() {} })
                    : key === "measureText" ? () => ({ width: 0 })
                    : () => {}),
                set: () => true,
            }),
        };
    }
    const get = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
    const requests = [];
    const messages = [];
    const confirmAnswers = [];

    const context = vm.createContext({
        SubtitleCore: core, PROJECT_ID: 1, console, URL, URLSearchParams, Blob,
        // The editor branches on these. The default seats the stub as the
        // translator; the review tests pass role: 'Revisor'.
        USER_ROLE: role,
        CAN_EDIT_TRANSLATION: role === 'Translator',
        CAN_REVIEW: role === 'Revisor',
        document: {
            getElementById: id => (id === 'videoPlayer' ? null : get(id)),
            querySelector: () => element(), querySelectorAll: () => [],
            addEventListener() {}, createElement: element, activeElement: null,
        },
        window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
        ResizeObserver: class { observe() {} },
        BroadcastChannel: class {
            constructor(name) { this.name = name; }
            postMessage(msg) { messages.push(msg); }
            addEventListener() {}
            close() {}
        },
        Shortcuts: { on() {}, describe() {}, byId() {}, effective: () => '', setOverrides() {}, whenReady: () => Promise.resolve() },
        localStorage: {
            getItem: key => (key in store ? store[key] : null),
            setItem: (key, value) => { store[key] = String(value); },
            removeItem: key => { delete store[key]; },
        },
        setTimeout: () => 1, clearTimeout() {}, alert() {},
        confirm: () => (confirmAnswers.length ? confirmAnswers.shift() : true),
        fetch: (url, options) => new Promise(resolve => requests.push({ url, options, resolve })),
    });

    vm.runInContext(fs.readFileSync(require.resolve('../wwwroot/js/editor.js'), 'utf8'), context);
    return {
        context, requests, nodes, store, messages, confirmAnswers,
        run: code => vm.runInContext(code, context),
        body: index => JSON.parse(requests[index].options.body),
    };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const ok = body => ({ ok: true, status: 200, json: async () => body });

test('failed initial load never permits an empty overwrite', async () => {
    const app = setup();
    app.requests[0].resolve({ ok: false, status: 500 });
    await settle();
    await app.run('doSave()');
    assert.equal(app.requests.length, 1);
    assert.equal(app.run('loaded'), false);
    assert.match(app.nodes.get('eventsList').textContent, /Could not load/);
});

test('edits during an in-flight save remain dirty and concurrent saves are suppressed', async () => {
    const app = setup();
    app.requests[0].resolve(ok({ revision: 3, events: [] }));
    await settle();
    app.run("events = [{id:-1,startTime:'00:00:01,000',endTime:'00:00:03,000',originalText:'Hello',translatedText:'First'}]; markDirty(); doSave();");
    assert.equal(app.requests.length, 2);
    app.run("events[0].translatedText = 'Second'; markDirty(); doSave();");
    assert.equal(app.requests.length, 2);
    app.requests[1].resolve(ok({ success: true, revision: 4 }));
    await settle();
    assert.equal(app.run('isDirty'), true);
    assert.equal(app.run('events[0].translatedText'), 'Second');
    app.run('doSave()');
    assert.equal(app.body(2).events[0].translatedText, 'Second');
    app.requests[2].resolve(ok({ success: true, revision: 5 }));
    await settle();
    assert.equal(app.run('isDirty'), false);
});

test('failed save retains dirty state and exposes retry', async () => {
    const app = setup();
    app.requests[0].resolve(ok({ revision: 1, events: [] }));
    await settle();
    app.run('markDirty(); doSave();');
    app.requests[1].resolve({ ok: false, status: 500 });
    await settle();
    assert.equal(app.run('isDirty'), true);
    assert.match(app.nodes.get('saveStatus').textContent, /retry/);
});

test('imported text is escaped before insertion into HTML', () => {
    const app = setup();
    assert.equal(
        app.run(`escapeHtml('</textarea><img src=x onerror="bad()">')`),
        '&lt;/textarea&gt;&lt;img src=x onerror=&quot;bad()&quot;&gt;');
});

// ── Safety: revisions, conflicts, local drafts ────

test('a save carries the revision the editor loaded, and adopts the one it is given back', async () => {
    const app = setup();
    app.requests[0].resolve(ok({ revision: 7, events: [] }));
    await settle();
    assert.equal(app.run('loadedRevision'), 7);

    app.run("events = [{id:-1,startTime:'00:00:01,000',endTime:'00:00:02,000',translatedText:'x'}]; markDirty(); doSave();");
    assert.equal(app.body(1).revision, 7);
    app.requests[1].resolve(ok({ success: true, revision: 8 }));
    await settle();
    assert.equal(app.run('loadedRevision'), 8);
});

test('a rejected save stops auto-saving instead of overwriting newer work', async () => {
    const app = setup();
    app.requests[0].resolve(ok({ revision: 2, events: [] }));
    await settle();
    app.run("events = [{id:-1,startTime:'00:00:01,000',endTime:'00:00:02,000',translatedText:'mine'}]; markDirty(); doSave();");
    app.requests[1].resolve({ ok: false, status: 409, json: async () => ({ conflict: true, revision: 9 }) });
    await settle();

    assert.equal(app.run('revisionStale'), true);
    assert.match(app.nodes.get('saveStatus').textContent, /newer version/i);
    // Further saves must not fire; the translator's copy stays intact on screen.
    const before = app.requests.length;
    app.run('markDirty(); doSave();');
    assert.equal(app.requests.length, before);
    assert.equal(app.run('events[0].translatedText'), 'mine');
});

test('a local draft is kept while dirty and cleared once the server confirms', async () => {
    const app = setup();
    app.requests[0].resolve(ok({ revision: 1, events: [] }));
    await settle();

    app.run("events = [{id:-1,startTime:'00:00:01,000',endTime:'00:00:02,000',translatedText:'draft'}]; markDirty(); writeDraft();");
    assert.ok(app.store['tm-draft-1'], 'expected a draft in local storage');
    assert.equal(JSON.parse(app.store['tm-draft-1']).events[0].translatedText, 'draft');

    app.run('doSave()');
    app.requests[1].resolve(ok({ success: true, revision: 2 }));
    await settle();
    assert.equal(app.store['tm-draft-1'], undefined, 'a confirmed save should clear the draft');
});

test('unsaved work from a dead tab is offered back on reload', async () => {
    const draft = {
        revision: 4,
        savedAt: Date.now() - 120000,
        events: [{ id: 1, startTime: '00:00:01,000', endTime: '00:00:02,000', originalText: 'Hi', translatedText: 'recovered' }],
    };
    const app = setup({ store: { 'tm-draft-1': JSON.stringify(draft) } });
    app.requests[0].resolve(ok({
        revision: 4,
        events: [{ id: 1, startTime: '00:00:01,000', endTime: '00:00:02,000', originalText: 'Hi', translatedText: '' }],
    }));
    await settle();

    assert.equal(app.run('events[0].translatedText'), 'recovered');
    assert.equal(app.run('isDirty'), true);
});

test('declining recovery keeps the server copy and drops the draft', async () => {
    const draft = {
        revision: 4,
        savedAt: Date.now(),
        events: [{ id: 1, startTime: '00:00:01,000', endTime: '00:00:02,000', translatedText: 'stale' }],
    };
    const app = setup({ store: { 'tm-draft-1': JSON.stringify(draft) } });
    app.confirmAnswers.push(false);
    app.requests[0].resolve(ok({
        revision: 4,
        events: [{ id: 1, startTime: '00:00:01,000', endTime: '00:00:02,000', translatedText: 'server' }],
    }));
    await settle();

    assert.equal(app.run('events[0].translatedText'), 'server');
    assert.equal(app.store['tm-draft-1'], undefined);
});

test('a draft identical to the server copy is discarded without asking', async () => {
    const cues = [{ id: 1, startTime: '00:00:01,000', endTime: '00:00:02,000', translatedText: 'same' }];
    const app = setup({ store: { 'tm-draft-1': JSON.stringify({ revision: 4, savedAt: Date.now(), events: cues }) } });
    // No answer queued: if the editor asked, confirm() would default to true
    // and this would still pass — so assert on the storage side instead.
    app.requests[0].resolve(ok({ revision: 4, events: cues }));
    await settle();
    assert.equal(app.store['tm-draft-1'], undefined);
    assert.equal(app.run('isDirty'), false);
});

test('the editor still loads when the events endpoint returns a bare array', async () => {
    const app = setup();
    app.requests[0].resolve(ok([{ id: 1, startTime: '00:00:01,000', endTime: '00:00:02,000', translatedText: 'legacy' }]));
    await settle();
    assert.equal(app.run('loaded'), true);
    assert.equal(app.run('loadedRevision'), null);
    assert.equal(app.run('events[0].translatedText'), 'legacy');
});
