// What the editor promises about saving, checked against the real editor.js in
// the Node DOM stub: lost responses, expired sign-ins, timing that is wrong
// but still worth keeping, conflicts that keep both versions, and recovery
// copies found after someone else saved.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup, settle, ok } = require('./harness.cjs');

const cue = (over = {}) => ({ id: 5, startTime: '00:00:01,000', endTime: '00:00:02,000', originalText: 'Hi', translatedText: '', ...over });
const saves = app => app.requests.filter(r => /\/save$/.test(r.url));
const lastSave = app => JSON.parse(saves(app).at(-1).options.body);

test('a save whose response was lost is re-sent with the same id before anything newer', async () => {
    const app = setup();
    app.requests[0].resolve(ok({ revision: 3, events: [cue()] }));
    await settle();
    app.run("events[0].translatedText = 'one'; markDirty(); doSave();");
    const first = lastSave(app);
    saves(app)[0].reject(new TypeError('network down'));
    await settle();
    assert.match(app.nodes.get('saveStatus').textContent, /retry/i);
    assert.equal(app.run('isDirty'), true);

    // More typing, then the retry: the uncertain request goes first, unchanged.
    app.run("events[0].translatedText = 'two'; markDirty(); doSave();");
    const retried = lastSave(app);
    assert.equal(retried.saveId, first.saveId);
    assert.equal(retried.events[0].translatedText, 'one');
    assert.equal(retried.revision, 3);

    // The server recognises it (it had landed) and answers as before.
    saves(app)[1].resolve(ok({ success: true, replayed: true, revision: 4 }));
    await settle();
    const next = lastSave(app);
    assert.notEqual(next.saveId, first.saveId);
    assert.equal(next.revision, 4, 'the newer save builds on the version the lost one created');
    assert.equal(next.events[0].translatedText, 'two');
    saves(app)[2].resolve(ok({ success: true, revision: 5 }));
    await settle();
    assert.equal(app.run('isDirty'), false);
    assert.match(app.nodes.get('saveStatus').textContent, /All changes saved/);
});

test('an expired sign-in is reported as such and nothing is thrown away', async () => {
    const app = setup();
    app.requests[0].resolve(ok({ revision: 1, events: [cue()] }));
    await settle();
    app.run("events[0].translatedText = 'kept'; markDirty(); doSave();");
    saves(app)[0].resolve({ ok: false, status: 401, json: async () => { throw new Error('no body'); } });
    await settle();
    assert.match(app.nodes.get('saveStatus').textContent, /Signed out/);
    assert.equal(app.run('isDirty'), true);
    assert.equal(JSON.parse(app.store['tm-draft-1']).events[0].translatedText, 'kept');
});

test('a login page where JSON was expected counts as signed out, not as saved', async () => {
    const app = setup();
    app.requests[0].resolve(ok({ revision: 1, events: [cue()] }));
    await settle();
    app.run("events[0].translatedText = 'x'; markDirty(); doSave();");
    saves(app)[0].resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError('<!DOCTYPE html>'); } });
    await settle();
    assert.doesNotMatch(app.nodes.get('saveStatus').textContent, /saved/i);
    assert.match(app.nodes.get('saveStatus').textContent, /Signed out/);
});

test('a cue with its out-time before its in-time is still saved, not held back', async () => {
    const app = setup();
    app.requests[0].resolve(ok({ revision: 1, events: [cue()] }));
    await settle();
    app.run("events[0].endTime = '00:00:00,500'; events[0].translatedText = 'work'; markDirty(); doSave();");
    assert.equal(saves(app).length, 1);
    assert.equal(lastSave(app).events[0].endTime, '00:00:00,500');
});

test('pressing Save with nothing changed sends nothing and says it is saved', async () => {
    const app = setup();
    app.requests[0].resolve(ok({ revision: 1, events: [cue()], updatedAt: '2026-10-05T10:00:00Z' }));
    await settle();
    app.run('doSave({ manual: true })');
    assert.equal(saves(app).length, 0);
    assert.match(app.nodes.get('saveStatus').textContent, /All changes saved/);
});

test('a real conflict keeps this editor’s version as a server copy as well as locally', async () => {
    const app = setup();
    app.requests[0].resolve(ok({ revision: 2, events: [cue()] }));
    await settle();
    app.run("events[0].translatedText = 'mine'; markDirty(); doSave();");
    saves(app)[0].resolve({ ok: false, status: 409, json: async () => ({ conflict: true, revision: 9 }) });
    await settle();
    const refetch = app.requests.find((r, i) => i > 0 && /\/events$/.test(r.url));
    refetch.resolve(ok({ revision: 9, events: [cue({ translatedText: 'theirs' })] }));
    await settle();
    const copy = app.requests.find(r => /\/checkpoint$/.test(r.url));
    assert.ok(copy, 'expected a conflict copy to be sent');
    const body = JSON.parse(copy.options.body);
    assert.equal(body.kind, 6);
    assert.equal(body.events[0].translatedText, 'mine');
    assert.equal(app.run('events[0].translatedText'), 'mine', 'the screen keeps this editor’s version');
    assert.equal(JSON.parse(app.store['tm-draft-1']).events[0].translatedText, 'mine');
});

test('a recovery copy made before someone else saved is merged when the edits do not collide', async () => {
    const base = [cue(), cue({ id: 6, startTime: '00:00:03,000', endTime: '00:00:04,000' })];
    const draft = {
        revision: 4,
        savedAt: Date.now() - 60000,
        events: [cue({ translatedText: 'my line' }), base[1]],
        base,
    };
    const app = setup({ store: { 'tm-draft-1': JSON.stringify(draft) } });
    // Meanwhile the revisor saved a suggestion on the other line.
    app.requests[0].resolve(ok({ revision: 6, events: [base[0], { ...base[1], suggestedText: 'their idea' }] }));
    await settle();
    await settle();
    assert.equal(app.run('events[0].translatedText'), 'my line');
    assert.equal(app.run('events[1].suggestedText'), 'their idea');
    assert.equal(app.run('isDirty'), true);
    // The saved version it replaces on screen is kept on the server.
    const kept = app.requests.find(r => /\/checkpoint$/.test(r.url));
    assert.equal(JSON.parse(kept.options.body).kind, 5);
});

test('declining a recovery copy keeps it on the server instead of deleting it', async () => {
    const draft = { revision: 4, savedAt: Date.now(), events: [cue({ translatedText: 'unsaved' })] };
    const app = setup({ store: { 'tm-draft-1': JSON.stringify(draft) } });
    app.confirmAnswers.push(false);
    app.requests[0].resolve(ok({ revision: 4, events: [cue()] }));
    await settle();
    const kept = app.requests.find(r => /\/checkpoint$/.test(r.url));
    assert.ok(kept);
    assert.equal(JSON.parse(kept.options.body).events[0].translatedText, 'unsaved');
    assert.equal(app.store['tm-draft-1'], undefined);
});

test('project settings travel with the save and come back on load', async () => {
    const settings = JSON.stringify({ version: 1, fps: 24, profile: { maxCharsPerLine: 37, maxLines: 2, maxCps: 17 }, glossary: [{ source: 'Bureau', target: 'المكتب' }] });
    const app = setup();
    app.requests[0].resolve(ok({ revision: 1, events: [cue()], settings }));
    await settle();
    assert.equal(app.run('deliveryProfile.maxCharsPerLine'), 37);
    assert.equal(app.run('fps'), 24);
    app.run("events[0].translatedText = 'x'; markDirty(); doSave();");
    const sent = JSON.parse(lastSave(app).settingsJson);
    assert.equal(sent.profile.maxCharsPerLine, 37);
    assert.equal(sent.glossary[0].target, 'المكتب');
});

test('edits made while a save is in flight are never reported as saved', async () => {
    const app = setup();
    app.requests[0].resolve(ok({ revision: 1, events: [cue()] }));
    await settle();
    app.run("events[0].translatedText = 'a'; markDirty(); doSave();");
    app.run("events[0].translatedText = 'b'; markDirty();");
    saves(app)[0].resolve(ok({ success: true, revision: 2 }));
    await settle();
    assert.doesNotMatch(app.nodes.get('saveStatus').textContent, /All changes saved/);
    assert.equal(app.run('isDirty'), true);
});
