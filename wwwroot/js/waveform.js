/* ══════════════════════════════════════════════════════════════════════
   TmWaveform — audio analysis behind the editor's timeline.

   The editor used to hold the decoded PCM and rescan it per pixel on every
   redraw. At fit-zoom over a feature-length track that is a scan of tens of
   millions of samples per scroll frame, which is why the old waveform felt
   sluggish and had to cap out at 128 MB of media.

   Instead this builds a *peak pyramid* once: level 0 holds min/max/RMS per
   2.5 ms bucket quantised to one byte each, and every further level halves
   the resolution. Drawing then reads only the level whose resolution just
   exceeds the current zoom, so a redraw costs O(visible pixels) no matter
   how long the track is. A two-hour film costs about 10 MB of peaks — small
   enough to keep in IndexedDB, so the expensive decode happens once per
   project rather than once per page load.

   The same RMS track drives speech/silence detection, which the timeline
   uses for shading, for snapping cue edges to where the dialogue actually
   starts, and for jumping between utterances.
   ══════════════════════════════════════════════════════════════════════ */
(function (global) {
    'use strict';

    // 400 buckets/second ≈ 2.5 ms. Finer than any zoom the timeline offers
    // (1000 px/s over a 2.5 ms bucket still lands under three pixels), and
    // three bytes per bucket keeps a two-hour track near 10 MB.
    const BASE_BPS = 400;
    const MIN_BPS = 0.5;         // coarsest pyramid level worth keeping
    const SPEECH_BPS = 50;       // ~20 ms frames for voice activity detection
    const DB_NAME = 'tm-waveform';
    const STORE = 'peaks';
    const CACHE_VERSION = 3;
    const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;

    const clamp8 = v => Math.max(-127, Math.min(127, Math.round(v * 127)));

    // ── IndexedDB peak cache ──────────────────────────────────────────
    // Best-effort throughout: a browser in private mode, with storage
    // disabled, or simply out of quota just means the peaks get rebuilt.
    function openDb() {
        return new Promise(resolve => {
            let req;
            try { req = indexedDB.open(DB_NAME, 1); }
            catch { return resolve(null); }
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
            req.onblocked = () => resolve(null);
        });
    }

    async function cacheGet(key) {
        if (!key || !global.indexedDB) return null;
        const db = await openDb();
        if (!db) return null;
        return new Promise(resolve => {
            let req;
            try { req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key); }
            catch { db.close(); return resolve(null); }
            req.onsuccess = () => {
                const rec = req.result;
                db.close();
                resolve(rec && rec.version === CACHE_VERSION ? rec : null);
            };
            req.onerror = () => { db.close(); resolve(null); };
        });
    }

    async function cachePut(key, rec) {
        if (!key || !global.indexedDB) return;
        const db = await openDb();
        if (!db) return;
        await new Promise(resolve => {
            let tx;
            try {
                tx = db.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).put(rec, key);
            } catch { db.close(); return resolve(); }
            tx.oncomplete = tx.onerror = tx.onabort = () => { db.close(); resolve(); };
        });
    }

    function forget(key) {
        if (!key || !global.indexedDB) return Promise.resolve();
        return openDb().then(db => {
            if (!db) return;
            try { db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key); } catch { /* ignore */ }
            db.close();
        });
    }

    // ── Download ──────────────────────────────────────────────────────
    // Read through the stream rather than calling .arrayBuffer() so the UI
    // can show real progress: decoding a long film is slow enough that a
    // silent wait reads as a broken timeline.
    async function fetchMedia(url, onProgress, maxBytes) {
        const res = await fetch(url);
        if (!res.ok) throw new Error('Could not load the media (HTTP ' + res.status + ')');
        const total = Number(res.headers.get('Content-Length')) || 0;
        if (total && total > maxBytes) {
            try { await res.body?.cancel(); } catch { /* already closed */ }
            throw new Error('Media is larger than ' + Math.round(maxBytes / (1024 * 1024)) + ' MB — too big to analyse in the browser');
        }
        if (!res.body || typeof res.body.getReader !== 'function') return res.arrayBuffer();

        const reader = res.body.getReader();
        const chunks = [];
        let got = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            got += value.length;
            if (got > maxBytes) {
                try { await reader.cancel(); } catch { /* already closed */ }
                throw new Error('Media is larger than ' + Math.round(maxBytes / (1024 * 1024)) + ' MB — too big to analyse in the browser');
            }
            if (total) onProgress(got / total);
        }
        const buf = new Uint8Array(got);
        let off = 0;
        for (const c of chunks) { buf.set(c, off); off += c.length; }
        chunks.length = 0;
        return buf.buffer;
    }

    // ── Level 0: one min/max/RMS triple per bucket ────────────────────
    // All channels are averaged into one trace. The old code read channel 0
    // only, which silently dropped anything panned hard right — including,
    // on a fair number of broadcast masters, the whole dialogue stem.
    function buildLevel0(audioBuffer) {
        const sr = audioBuffer.sampleRate;
        const n = audioBuffer.length;
        const duration = n / sr;
        const nc = Math.max(1, audioBuffer.numberOfChannels);
        const chans = [];
        for (let c = 0; c < audioBuffer.numberOfChannels; c++) chans.push(audioBuffer.getChannelData(c));

        const count = Math.max(1, Math.ceil(duration * BASE_BPS));
        const per = n / count;
        const min = new Int8Array(count);
        const max = new Int8Array(count);
        const rms = new Uint8Array(count);

        let i = 0;
        for (let b = 0; b < count; b++) {
            const end = Math.min(n, Math.round((b + 1) * per));
            let lo = 0, hi = 0, sq = 0, k = 0;
            for (; i < end; i++) {
                let v = 0;
                for (let c = 0; c < nc; c++) v += chans[c][i];
                v /= nc;
                if (v < lo) lo = v;
                if (v > hi) hi = v;
                sq += v * v;
                k++;
            }
            min[b] = clamp8(lo);
            max[b] = clamp8(hi);
            rms[b] = Math.min(255, Math.round(Math.sqrt(sq / Math.max(1, k)) * 255));
        }
        return { bps: count / duration, count, min, max, rms, duration };
    }

    // Each level halves the one below it, so picking a level is picking a
    // zoom. Two levels total roughly twice level 0, which is the price of
    // never rescanning raw samples again.
    function buildPyramid(level0) {
        const levels = [level0];
        let cur = level0;
        while (cur.count > 4 && cur.bps > MIN_BPS) {
            const count = Math.ceil(cur.count / 2);
            const min = new Int8Array(count);
            const max = new Int8Array(count);
            const rms = new Uint8Array(count);
            for (let b = 0; b < count; b++) {
                const a = 2 * b;
                const c = Math.min(cur.count - 1, a + 1);
                min[b] = Math.min(cur.min[a], cur.min[c]);
                max[b] = Math.max(cur.max[a], cur.max[c]);
                rms[b] = Math.round(Math.sqrt((cur.rms[a] * cur.rms[a] + cur.rms[c] * cur.rms[c]) / 2));
            }
            cur = { bps: cur.bps / 2, count, min, max, rms };
            levels.push(cur);
        }
        return levels;
    }

    // The coarsest level that still has at least one bucket per pixel — any
    // finer is wasted work, any coarser visibly stair-steps.
    function pickLevel(levels, pxPerSecond) {
        for (let i = levels.length - 1; i >= 0; i--) {
            if (levels[i].bps >= pxPerSecond) return levels[i];
        }
        return levels[0];
    }

    /* Aggregates the pyramid into one column per pixel for the window
       starting at `t0`. Returns values in -1..1 (min/max) and 0..1 (rms),
       with `filled` marking how many columns fall inside the track. */
    function columnsFor(peaks, t0, pxPerSecond, width) {
        const lvl = pickLevel(peaks.levels, pxPerSecond);
        const min = new Float32Array(width);
        const max = new Float32Array(width);
        const rms = new Float32Array(width);
        const secsPerPx = 1 / pxPerSecond;
        let filled = 0;

        for (let x = 0; x < width; x++) {
            const a = (t0 + x * secsPerPx) * lvl.bps;
            let b0 = Math.floor(a);
            let b1 = Math.max(b0 + 1, Math.ceil(a + secsPerPx * lvl.bps));
            if (b1 <= 0 || b0 >= lvl.count) continue;
            if (b0 < 0) b0 = 0;
            if (b1 > lvl.count) b1 = lvl.count;

            let lo = 0, hi = 0, sq = 0, k = 0;
            for (let b = b0; b < b1; b++) {
                const mn = lvl.min[b], mx = lvl.max[b], r = lvl.rms[b];
                if (mn < lo) lo = mn;
                if (mx > hi) hi = mx;
                sq += r * r;
                k++;
            }
            min[x] = lo / 127;
            max[x] = hi / 127;
            rms[x] = k ? Math.sqrt(sq / k) / 255 : 0;
            filled++;
        }
        return { min, max, rms, filled, bps: lvl.bps };
    }

    // ── Voice activity ────────────────────────────────────────────────
    /* Thresholds are taken from the track's own statistics rather than a
       fixed number: a quiet documentary and a loud action mix have nothing
       in common in absolute terms, but in both the dialogue sits well above
       the 15th percentile of frame energy. Hysteresis (a higher bar to
       start a region than to end one) stops a region flickering on every
       syllable boundary. */
    function detectSpeech(levels, duration) {
        const lvl = levels.reduce(
            (best, l) => Math.abs(l.bps - SPEECH_BPS) < Math.abs(best.bps - SPEECH_BPS) ? l : best,
            levels[0]);
        const n = lvl.count;
        if (!n || !duration) return [];

        const sorted = Float64Array.from(lvl.rms, v => v / 255).sort();
        const floor = sorted[Math.floor(n * 0.15)] || 0;
        const loud = sorted[Math.floor(n * 0.97)] || 0;
        if (loud <= floor + 0.004) return [];   // near-uniform: music bed, tone, or silence

        const on = floor + (loud - floor) * 0.20;
        const off = floor + (loud - floor) * 0.10;

        const raw = [];
        let start = -1;
        for (let b = 0; b < n; b++) {
            const v = lvl.rms[b] / 255;
            if (start < 0) { if (v >= on) start = b; }
            else if (v < off) { raw.push([start / lvl.bps, b / lvl.bps]); start = -1; }
        }
        if (start >= 0) raw.push([start / lvl.bps, n / lvl.bps]);

        // Bridge breaths and stop consonants, then drop the clicks that are
        // left over; a 120 ms region is never a line of dialogue.
        const MIN_GAP = 0.22, MIN_LEN = 0.12, PAD = 0.05;
        const merged = [];
        for (const [s, e] of raw) {
            const last = merged[merged.length - 1];
            if (last && s - last[1] < MIN_GAP) last[1] = e;
            else merged.push([s, e]);
        }
        return merged
            .filter(([s, e]) => e - s >= MIN_LEN)
            .map(([s, e]) => ({
                start: Math.max(0, s - PAD),
                end: Math.min(duration, e + PAD),
            }));
    }

    // ── Queries the timeline uses for snapping and navigation ─────────
    function regionAt(peaks, t) {
        return peaks?.speech?.find(r => t >= r.start && t <= r.end) || null;
    }

    /* Nearest speech edge to `t`, or null when none is within `tolerance`
       seconds. Cue edges want to land on the onset of the words, not a
       round number, so this is what "snap to audio" reaches for first. */
    function nearestEdge(peaks, t, tolerance) {
        let best = null, bestD = tolerance;
        for (const r of peaks?.speech || []) {
            for (const edge of [r.start, r.end]) {
                const d = Math.abs(edge - t);
                if (d < bestD) { bestD = d; best = edge; }
            }
            if (r.start - t > tolerance) break;   // regions are in order
        }
        return best;
    }

    /* The next region boundary strictly after (dir > 0) or before (dir < 0)
       `t`, for stepping through dialogue without watching the video. */
    function stepEdge(peaks, t, dir) {
        const edges = [];
        for (const r of peaks?.speech || []) edges.push(r.start, r.end);
        if (dir > 0) return edges.find(e => e > t + 0.001) ?? null;
        for (let i = edges.length - 1; i >= 0; i--) if (edges[i] < t - 0.001) return edges[i];
        return null;
    }

    /* The speech region a cue is "about": the one it overlaps most. Used by
       "fit cue to dialogue", which is the single most common manual edit in
       a timing pass. */
    function regionForRange(peaks, start, end) {
        let best = null, bestOverlap = 0;
        for (const r of peaks?.speech || []) {
            const overlap = Math.min(end, r.end) - Math.max(start, r.start);
            if (overlap > bestOverlap) { bestOverlap = overlap; best = r; }
        }
        if (best) return best;
        // No overlap at all — fall back to whichever region is closest.
        let bestD = Infinity;
        for (const r of peaks?.speech || []) {
            const d = r.start > end ? r.start - end : start - r.end;
            if (d < bestD) { bestD = d; best = r; }
        }
        return best;
    }

    // ── Entry point ───────────────────────────────────────────────────
    /* Resolves to { duration, levels, speech }. `onProgress(stage, frac)`
       reports 'download', 'decode' and 'analyse' so the caller can show
       something honest while a long film is being read. */
    async function analyse(url, options = {}) {
        const { cacheKey, onProgress = () => {}, maxBytes = DEFAULT_MAX_BYTES } = options;

        const cached = await cacheGet(cacheKey);
        if (cached) {
            onProgress('analyse', 1);
            const level0 = {
                bps: cached.bps, count: cached.count, duration: cached.duration,
                min: new Int8Array(cached.min), max: new Int8Array(cached.max), rms: new Uint8Array(cached.rms),
            };
            const levels = buildPyramid(level0);
            return { duration: cached.duration, levels, speech: cached.speech, fromCache: true };
        }

        onProgress('download', 0);
        const raw = await fetchMedia(url, f => onProgress('download', f), maxBytes);

        onProgress('decode', 0);
        const Ctor = global.AudioContext || global.webkitAudioContext;
        if (!Ctor) throw new Error('This browser cannot decode audio');
        const ctx = new Ctor();
        let audioBuffer;
        try {
            // Promise form isn't universal; the callback form is.
            audioBuffer = await new Promise((resolve, reject) => {
                const ret = ctx.decodeAudioData(raw, resolve, reject);
                if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
            });
        } finally {
            try { await ctx.close(); } catch { /* already closed */ }
        }

        onProgress('analyse', 0);
        const level0 = buildLevel0(audioBuffer);
        audioBuffer = null;                       // release the PCM immediately
        const levels = buildPyramid(level0);
        const speech = detectSpeech(levels, level0.duration);
        onProgress('analyse', 1);

        cachePut(cacheKey, {
            version: CACHE_VERSION,
            duration: level0.duration, bps: level0.bps, count: level0.count,
            min: level0.min.buffer, max: level0.max.buffer, rms: level0.rms.buffer,
            speech,
        }).catch(() => { /* cache is optional */ });

        return { duration: level0.duration, levels, speech, fromCache: false };
    }

    global.TmWaveform = {
        analyse, columnsFor, pickLevel, detectSpeech,
        regionAt, nearestEdge, stepEdge, regionForRange, forget,
        BASE_BPS,
    };
})(typeof window !== 'undefined' ? window : globalThis);
