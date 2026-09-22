const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../wwwroot/js/subtitle-core.js');

// analyze() replaces a per-cue O(n^2) scan with one O(n log n) sweep, so the
// thing worth proving is that it never disagrees with the original rules.
// A deterministic pseudo-random generator keeps failures reproducible.
function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s ^= s << 13; s >>>= 0;
        s ^= s >> 17;
        s ^= s << 5;  s >>>= 0;
        return s / 4294967296;
    };
}

function track(seed, count) {
    const rand = rng(seed);
    const cues = [];
    let t = 0;
    for (let i = 0; i < count; i++) {
        const roll = rand();
        // Deliberately messy: back-to-back cues, overlaps, sub-frame gaps,
        // zero-length and reversed cues all have to be classified the same way.
        if (roll < 0.12) t -= rand() * 3;                  // force overlaps
        else if (roll < 0.24) t += 0.01 + rand() * 0.06;   // force short gaps
        else t += rand() * 2.5;
        const start = Math.max(0, t);
        const dur = roll < 0.1 ? rand() * 0.9 : 0.6 + rand() * 4;
        const end = start + dur;
        t = end;

        const lines = rand() < 0.15 ? 3 : rand() < 0.5 ? 2 : 1;
        const text = rand() < 0.2 ? '' :
            Array.from({ length: lines }, () => 'x'.repeat(2 + Math.floor(rand() * 55))).join('\n');

        cues.push({
            startTime: core.timestamp(start),
            endTime: rand() < 0.05 ? core.timestamp(start) : core.timestamp(end),
            originalText: 'source',
            translatedText: text,
        });
    }
    // A few outright broken timestamps, which must not disturb their neighbours.
    if (count > 6) {
        cues[2].endTime = 'not-a-timecode';
        cues[5].startTime = '99:99:99,999';
    }
    return cues;
}

test('analyze matches issues cue for cue across messy tracks', () => {
    for (const seed of [1, 7, 42, 1337, 90210]) {
        for (const count of [1, 2, 3, 12, 80]) {
            const cues = track(seed, count);
            const batch = core.analyze(cues);
            assert.equal(batch.length, cues.length);
            cues.forEach((cue, i) => {
                assert.deepEqual(
                    batch[i], core.issues(cue, cues),
                    `seed ${seed} count ${count} cue ${i} (${cue.startTime} -> ${cue.endTime})`);
            });
        }
    }
});

test('analyze handles an empty track and identical timings', () => {
    assert.deepEqual(core.analyze([]), []);
    const same = [
        { startTime: '00:00:01,000', endTime: '00:00:03,000', translatedText: 'a' },
        { startTime: '00:00:01,000', endTime: '00:00:03,000', translatedText: 'b' },
    ];
    assert.deepEqual(core.analyze(same), same.map(c => core.issues(c, same)));
    assert.ok(core.analyze(same)[0].includes('Overlapping cues'));
});

test('analyze is fast enough for a feature-length track', () => {
    const cues = track(5150, 1500);
    const started = process.hrtime.bigint();
    core.analyze(cues);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    // The per-cue path needs roughly a second for this; the sweep should be
    // far under it. A generous ceiling keeps the test stable on slow machines
    // while still catching a return to quadratic behaviour.
    assert.ok(ms < 250, `analyze took ${ms.toFixed(1)}ms for ${cues.length} cues`);
});

// ── Delivery profiles ─────────────────────────────

test('the default profile reproduces the thresholds used before profiles existed', () => {
    const d = core.DEFAULT_PROFILE;
    assert.equal(d.maxCharsPerLine, 42);
    assert.equal(d.maxLines, 2);
    assert.equal(d.maxCps, 21);
    assert.equal(d.minDurationSeconds, 1);
    assert.equal(d.minGapSeconds, 0.08);
});

test('a stricter profile flags cues the default accepts', () => {
    // 38 characters on one line, over two seconds: fine at 42 chars, too long
    // at 37, and the reading speed is fine either way.
    const cue = { startTime: '00:00:01,000', endTime: '00:00:03,000', translatedText: 'x'.repeat(38) };
    assert.ok(!core.issues(cue, []).includes('Long line'));
    const strict = core.PROFILES.find(p => p.id === 'broadcast-37');
    assert.ok(core.issues(cue, [], strict).includes('Long line'));
});

test('a relaxed profile accepts three lines and faster reading', () => {
    const cue = { startTime: '00:00:01,000', endTime: '00:00:03,000', translatedText: 'one\ntwo\nthree' };
    assert.ok(core.issues(cue, []).includes('More than 2 lines'));
    const relaxed = core.PROFILES.find(p => p.id === 'relaxed-45');
    assert.ok(!core.issues(cue, [], relaxed).some(i => i.startsWith('More than')));
});

test('duration limits come from the profile at both ends', () => {
    const short = { startTime: '00:00:01,000', endTime: '00:00:01,500', translatedText: 'hi' };
    assert.ok(core.issues(short, []).includes('Short duration'));
    const long = { startTime: '00:00:01,000', endTime: '00:00:12,000', translatedText: 'hi' };
    assert.ok(core.issues(long, []).includes('Long duration'));
    const roomy = { ...long };
    assert.ok(!core.issues(roomy, [], { maxDurationSeconds: 20 }).includes('Long duration'));
});

test('the minimum gap comes from the profile', () => {
    const a = { startTime: '00:00:01,000', endTime: '00:00:03,000', translatedText: 'a' };
    const b = { startTime: '00:00:03,100', endTime: '00:00:05,000', translatedText: 'b' };
    assert.ok(!core.issues(a, [a, b]).includes('Short gap'));
    assert.ok(core.issues(a, [a, b], { minGapSeconds: 0.2 }).includes('Short gap'));
});

test('a damaged profile falls back field by field instead of breaking checking', () => {
    const broken = { maxCharsPerLine: 'nonsense', maxLines: 0, maxCps: -5, minGapSeconds: null };
    const fixed = core.normaliseProfile(broken);
    assert.equal(fixed.maxCharsPerLine, core.DEFAULT_PROFILE.maxCharsPerLine);
    assert.equal(fixed.maxLines, core.DEFAULT_PROFILE.maxLines);
    assert.equal(fixed.maxCps, core.DEFAULT_PROFILE.maxCps);
    assert.equal(fixed.minGapSeconds, core.DEFAULT_PROFILE.minGapSeconds);
    assert.deepEqual(core.normaliseProfile(undefined), core.normaliseProfile({}));
});

test('analyze and issues stay in step under a custom profile', () => {
    const profile = { maxCharsPerLine: 30, maxLines: 1, maxCps: 12, minDurationSeconds: 1.5, maxDurationSeconds: 5, minGapSeconds: 0.25 };
    const cues = track(4242, 60);
    const batch = core.analyze(cues, profile);
    cues.forEach((cue, i) => assert.deepEqual(batch[i], core.issues(cue, cues, profile), `cue ${i}`));
});
