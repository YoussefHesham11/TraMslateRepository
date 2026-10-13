// Shared by the Node test suites: runs the real editor.js inside a vm context
// with a minimal DOM stub, so state and network logic can be tested without a
// browser.
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
        fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
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

module.exports = { setup, settle, ok };
