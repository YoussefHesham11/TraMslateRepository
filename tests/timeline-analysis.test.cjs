// The pure parts of the timeline's audio and picture analysis: the peak
// pyramid, dialogue detection, and the scoring that finds shot changes. The
// parts that need a real decoder run in tests/browser/waveform-check.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../wwwroot/js/waveform.js');
require('../wwwroot/js/shots.js');
const W = globalThis.TmWaveform;
const S = globalThis.TmShots;

// A stand-in AudioBuffer: `segments` are [startSec, endSec, amplitude] bursts
// of a 220 Hz tone over silence, the shape dialogue has at this resolution.
function fakeBuffer(seconds, segments, { rate = 8000, channels = 1, panRight = false } = {}) {
    const n = Math.round(seconds * rate);
    const data = [];
    for (let c = 0; c < channels; c++) data.push(new Float32Array(n));
    for (const [s, e, amp] of segments) {
        for (let i = Math.round(s * rate); i < Math.min(n, Math.round(e * rate)); i++) {
            const v = amp * Math.sin(2 * Math.PI * 220 * i / rate);
            if (panRight && channels > 1) data[1][i] = v;
            else for (const ch of data) ch[i] = v;
        }
    }
    return { sampleRate: rate, length: n, numberOfChannels: channels, getChannelData: c => data[c] };
}

test('the pyramid halves resolution level by level and keeps the extremes', () => {
    const l0 = W.buildLevel0(fakeBuffer(10, [[2, 3, 0.5]]));
    assert.equal(Math.round(l0.bps), W.BASE_BPS);
    const levels = W.buildPyramid(l0);
    assert.ok(levels.length > 6);
    for (let i = 1; i < levels.length; i++) assert.ok(Math.abs(levels[i].bps - levels[i - 1].bps / 2) < 1e-9);
    // The burst's peak survives every level of reduction.
    for (const lvl of levels) {
        let peak = 0;
        for (let b = 0; b < lvl.count; b++) peak = Math.max(peak, lvl.max[b]);
        assert.ok(peak >= 60, `level at ${lvl.bps} b/s lost the peak (${peak})`);
    }
});

test('all channels are mixed, so dialogue panned to one side still shows', () => {
    const l0 = W.buildLevel0(fakeBuffer(4, [[1, 2, 0.8]], { channels: 2, panRight: true }));
    let peak = 0;
    for (let b = 0; b < l0.count; b++) peak = Math.max(peak, l0.max[b]);
    assert.ok(peak > 30, 'a right-only burst vanished from the waveform');
});

test('columns are read from the level matching the zoom, and are empty past the end', () => {
    const levels = W.buildPyramid(W.buildLevel0(fakeBuffer(20, [[5, 6, 0.6]])));
    const peaks = { levels, duration: 20 };
    const near = W.columnsFor(peaks, 0, 4, 100);
    assert.ok(near.bps >= 4 && near.bps < 8, `picked ${near.bps} b/s for 4 px/s`);
    const burst = Math.max(...near.max.slice(18, 26));
    assert.ok(burst > 0.4, 'the burst is missing at 4 px/s');
    const past = W.columnsFor(peaks, 25, 100, 50);
    assert.equal(past.filled, 0);
});

test('dialogue regions come out where the speech is, in order', () => {
    const segs = [[1, 2.5, 0.5], [4, 5, 0.4], [8, 9.5, 0.6]];
    const l0 = W.buildLevel0(fakeBuffer(12, [[0, 12, 0.005]].concat(segs)));   // room noise under the speech
    const levels = W.buildPyramid(l0);
    const speech = W.detectSpeech(levels, l0.duration);
    assert.equal(speech.length, 3);
    speech.forEach((r, i) => {
        assert.ok(Math.abs(r.start - segs[i][0]) < 0.12, `region ${i} starts at ${r.start}`);
        assert.ok(Math.abs(r.end - segs[i][1]) < 0.12, `region ${i} ends at ${r.end}`);
    });
    const peaks = { levels, speech, duration: l0.duration };
    assert.equal(W.nearestEdge(peaks, 3.95, 0.1), speech[1].start);
    assert.equal(W.nearestEdge(peaks, 6.5, 0.1), null);
    assert.equal(W.stepEdge(peaks, 2.6, 1), speech[1].start);
    assert.equal(W.stepEdge(peaks, 2.6, -1), speech[0].end);
    assert.equal(W.regionForRange(peaks, 3.7, 5.3), speech[1]);
});

test('a quiet track is scaled to fill the lane, a loud one is not', () => {
    const quiet = W.buildPyramid(W.buildLevel0(fakeBuffer(10, [[1, 9, 0.08]])));
    const loud = W.buildPyramid(W.buildLevel0(fakeBuffer(10, [[1, 9, 0.9]])));
    assert.ok(W.loudnessReference(quiet) < 0.12);
    assert.ok(W.loudnessReference(loud) > 0.8);
});

// ── Shot changes ──────────────────────────────────────────────────────
function frame(r, g, b, noise = 0, seed = 1) {
    const px = new Uint8ClampedArray(48 * 27 * 4);
    let x = seed;
    for (let i = 0; i < px.length; i += 4) {
        x = (x * 1103515245 + 12345) & 0x7fffffff;
        const j = noise ? (x % (2 * noise + 1)) - noise : 0;
        px[i] = r + j; px[i + 1] = g + j; px[i + 2] = b + j; px[i + 3] = 255;
    }
    return S.signatureOf(px);
}

test('frame difference is near zero within a shot and large across a cut', () => {
    const a1 = frame(40, 60, 90, 6, 1), a2 = frame(40, 60, 90, 6, 2);
    const b = frame(200, 170, 120, 6, 3);
    assert.ok(S.difference(a1, a2) < 0.05, `same shot scored ${S.difference(a1, a2)}`);
    assert.ok(S.difference(a1, b) > 0.4, `a cut scored ${S.difference(a1, b)}`);
});

test('only spikes well above the surrounding change become candidates', () => {
    const diffs = [];
    for (let i = 0; i < 40; i++) diffs.push({ t0: i * 0.25, t1: (i + 1) * 0.25, d: 0.03 + (i % 3) * 0.01 });
    diffs[10].d = 0.6;                       // a cut
    for (let i = 25; i < 35; i++) diffs[i].d = 0.2;   // a long fast pan
    const picked = S.pickCandidates(diffs);
    assert.deepEqual(picked.map(p => p.t0), [2.5]);
});

test('nearest cut is found by binary search', () => {
    const cuts = [1, 4, 9, 16, 25];
    assert.equal(S.nearest(cuts, 0), 1);
    assert.equal(S.nearest(cuts, 6.4), 4);
    assert.equal(S.nearest(cuts, 6.6), 9);
    assert.equal(S.nearest(cuts, 100), 25);
    assert.equal(S.nearest([], 3), null);
});
