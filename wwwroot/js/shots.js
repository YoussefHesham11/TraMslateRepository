/* ══════════════════════════════════════════════════════════════════════
   TmShots — shot-change (cut) detection for the editor timeline.

   Subtitle timing rules are written around cuts: an in-time belongs on the
   cut, an out-time a couple of frames before it, and an edge that misses a
   cut by a few frames reads as a flicker on screen. So the timeline needs to
   know where the cuts are.

   Detection runs in two passes over a hidden copy of the video:

   1. A coarse pass plays the video muted at high speed and samples whatever
      frames the browser presents, scoring how different each sample is from
      the last. A cut is a spike well above the local level of change.
   2. Each spike is then refined by seeking: a binary search narrows it to the
      exact frame, and two tests reject what only looks like a cut — fast
      motion (change spread over many frames instead of one) and flashes
      (the picture snaps back a few frames later).

   The result is a sorted list of cut times, cached per project in IndexedDB
   so the scan runs once rather than on every visit.
   ══════════════════════════════════════════════════════════════════════ */
(function (global) {
    'use strict';

    const SIG_W = 48, SIG_H = 27;
    const BINS = 16;
    const DB_NAME = 'tm-shots';
    const STORE = 'cuts';
    const CACHE_VERSION = 1;

    // A frame-to-frame difference below this is never a cut, however quiet
    // the surrounding footage is.
    const ABS_MIN = 0.14;
    // A spike must stand this far above the median change around it.
    const LOCAL_RATIO = 3;

    // ── Frame signatures ───────────────────────────────────────────────
    /* A frame reduced to a 48×27 luma thumbnail plus a 16-bin histogram per
       colour channel. The thumbnail catches a change of composition, the
       histogram a change of palette; a cut usually moves both, a camera
       move mostly the first. */
    function signatureOf(pixels) {
        const n = pixels.length / 4;
        const luma = new Uint8Array(n);
        const hist = new Float32Array(BINS * 3);
        for (let i = 0, p = 0; p < n; i += 4, p++) {
            const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
            luma[p] = (r * 77 + g * 150 + b * 29) >> 8;
            hist[r >> 4]++;
            hist[BINS + (g >> 4)]++;
            hist[2 * BINS + (b >> 4)]++;
        }
        return { luma, hist, n };
    }

    /* 0 for identical frames, 1 for frames with nothing in common. */
    function difference(a, b) {
        let h = 0;
        for (let i = 0; i < a.hist.length; i++) h += Math.abs(a.hist[i] - b.hist[i]);
        h /= 3 * 2 * a.n;
        let l = 0;
        for (let i = 0; i < a.luma.length; i++) l += Math.abs(a.luma[i] - b.luma[i]);
        l /= a.luma.length * 255;
        // Luma difference saturates well below 1 even for a hard cut, so it
        // is scaled up to sit on the same footing as the histogram term.
        return Math.min(1, 0.5 * h + 0.5 * Math.min(1, l * 2.5));
    }

    /* Picks the sample intervals whose change spikes above the change
       around them. `diffs` is [{ t0, t1, d }] in time order. */
    function pickCandidates(diffs, window = 6) {
        const out = [];
        for (let i = 0; i < diffs.length; i++) {
            const d = diffs[i].d;
            if (d < ABS_MIN) continue;
            const around = [];
            for (let j = Math.max(0, i - window); j <= Math.min(diffs.length - 1, i + window); j++) {
                if (j !== i) around.push(diffs[j].d);
            }
            around.sort((x, y) => x - y);
            const median = around.length ? around[Math.floor(around.length / 2)] : 0;
            if (d >= median * LOCAL_RATIO) out.push(diffs[i]);
        }
        return out;
    }

    // ── IndexedDB cache (best-effort, as in waveform.js) ───────────────
    function openDb() {
        return new Promise(resolve => {
            let req;
            try { req = indexedDB.open(DB_NAME, 1); } catch { return resolve(null); }
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = req.onblocked = () => resolve(null);
        });
    }
    async function cacheGet(key) {
        if (!key || !global.indexedDB) return null;
        const db = await openDb();
        if (!db) return null;
        return new Promise(resolve => {
            try {
                const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
                req.onsuccess = () => { db.close(); const r = req.result; resolve(r && r.version === CACHE_VERSION ? r : null); };
                req.onerror = () => { db.close(); resolve(null); };
            } catch { db.close(); resolve(null); }
        });
    }
    async function cachePut(key, rec) {
        if (!key || !global.indexedDB) return;
        const db = await openDb();
        if (!db) return;
        await new Promise(resolve => {
            try {
                const tx = db.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).put(rec, key);
                tx.oncomplete = tx.onerror = tx.onabort = () => { db.close(); resolve(); };
            } catch { db.close(); resolve(); }
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

    // ── Media helpers ──────────────────────────────────────────────────
    function once(target, okEvent, timeoutMs) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { cleanup(); reject(new Error('The video stopped responding')); }, timeoutMs);
            const ok = () => { cleanup(); resolve(); };
            const fail = () => { cleanup(); reject(new Error('The video could not be read')); };
            function cleanup() {
                clearTimeout(timer);
                target.removeEventListener(okEvent, ok);
                target.removeEventListener('error', fail);
            }
            target.addEventListener(okEvent, ok);
            target.addEventListener('error', fail);
        });
    }

    function makeReader(video) {
        const canvas = document.createElement('canvas');
        canvas.width = SIG_W;
        canvas.height = SIG_H;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        return () => {
            ctx.drawImage(video, 0, 0, SIG_W, SIG_H);
            return signatureOf(ctx.getImageData(0, 0, SIG_W, SIG_H).data);
        };
    }

    async function seek(video, t) {
        const target = Math.max(0, Math.min(t, video.duration - 0.001));
        if (Math.abs(video.currentTime - target) < 1e-4) return;
        const done = once(video, 'seeked', 15000);
        video.currentTime = target;
        await done;
    }

    // ── Pass 1: sample while playing fast ──────────────────────────────
    function playbackPass(video, read, onProgress, isCancelled) {
        return new Promise((resolve, reject) => {
            const diffs = [];
            let prev = null, prevT = 0, settled = false;
            const finish = err => {
                if (settled) return;
                settled = true;
                video.pause();
                err ? reject(err) : resolve(diffs);
            };
            const onFrame = (now, meta) => {
                if (settled) return;
                if (isCancelled()) return finish(new Error('cancelled'));
                const t = meta && Number.isFinite(meta.mediaTime) ? meta.mediaTime : video.currentTime;
                try {
                    const sig = read();
                    if (prev) diffs.push({ t0: prevT, t1: t, d: difference(prev, sig) });
                    prev = sig;
                    prevT = t;
                } catch (e) { return finish(e); }
                onProgress(Math.min(1, t / video.duration));
                if (!video.ended) video.requestVideoFrameCallback(onFrame);
            };
            video.addEventListener('ended', () => finish(), { once: true });
            video.addEventListener('error', () => finish(new Error('The video could not be read')), { once: true });
            // 16× is the ceiling most browsers allow; slower decoders just
            // present fewer frames, which pass 2 makes up for.
            for (const rate of [16, 8, 4]) {
                try { video.playbackRate = rate; break; } catch { /* try the next */ }
            }
            video.requestVideoFrameCallback(onFrame);
            video.play().catch(finish);
        });
    }

    // Fallback where requestVideoFrameCallback is missing: seek in steps.
    async function seekPass(video, read, onProgress, isCancelled) {
        const step = 0.25;
        const diffs = [];
        let prev = null, prevT = 0;
        for (let t = 0; t < video.duration; t += step) {
            if (isCancelled()) throw new Error('cancelled');
            await seek(video, t);
            const sig = read();
            if (prev) diffs.push({ t0: prevT, t1: t, d: difference(prev, sig) });
            prev = sig;
            prevT = t;
            onProgress(t / video.duration);
        }
        return diffs;
    }

    // ── Pass 2: pin each spike to one frame, or reject it ─────────────
    async function refine(video, read, cand, fps) {
        const frameAt = f => seek(video, (f + 0.5) / fps).then(read);
        let lo = Math.floor(cand.t0 * fps);
        let hi = Math.max(lo + 1, Math.ceil(cand.t1 * fps));
        let sLo = await frameAt(lo);
        let sHi = await frameAt(hi);
        const span = difference(sLo, sHi);
        if (span < ABS_MIN) return null;

        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            const sMid = await frameAt(mid);
            if (difference(sLo, sMid) >= difference(sMid, sHi)) { hi = mid; sHi = sMid; }
            else { lo = mid; sLo = sMid; }
        }
        const jump = difference(sLo, sHi);
        // Motion spreads its change over many frames; a cut puts nearly all
        // of it into one.
        if (jump < ABS_MIN || jump < span * 0.55) return null;
        // A flash (or a single corrupt frame) snaps back almost at once.
        const later = await frameAt(hi + 3);
        if (difference(sLo, later) < jump * 0.5) return null;
        return hi / fps;
    }

    // ── Entry point ───────────────────────────────────────────────────
    /* Resolves to { cuts: [seconds…], fromCache }. `onProgress(frac)` runs
       0→1 over both passes. `isCancelled()` lets the caller abandon a scan,
       for instance when the project's video is replaced. */
    async function detect(url, options = {}) {
        const { cacheKey, fps = 25, onProgress = () => {}, isCancelled = () => false } = options;

        const cached = await cacheGet(cacheKey);
        if (cached) { onProgress(1); return { cuts: cached.cuts, fromCache: true }; }

        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.crossOrigin = 'anonymous';
        video.src = url;
        try {
            await once(video, 'loadeddata', 60000);
            if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('The video has no duration');
            const read = makeReader(video);

            const coarse = typeof video.requestVideoFrameCallback === 'function'
                ? await playbackPass(video, read, f => onProgress(f * 0.75), isCancelled)
                : await seekPass(video, read, f => onProgress(f * 0.75), isCancelled);

            const candidates = pickCandidates(coarse);
            const cuts = [];
            for (let i = 0; i < candidates.length; i++) {
                if (isCancelled()) throw new Error('cancelled');
                const t = await refine(video, read, candidates[i], fps);
                if (t != null && (!cuts.length || t - cuts[cuts.length - 1] > 2 / fps)) cuts.push(t);
                onProgress(0.75 + 0.25 * (i + 1) / candidates.length);
            }
            cuts.sort((a, b) => a - b);
            onProgress(1);
            cachePut(cacheKey, { version: CACHE_VERSION, cuts }).catch(() => {});
            return { cuts, fromCache: false };
        } finally {
            video.removeAttribute('src');
            try { video.load(); } catch { /* already released */ }
        }
    }

    /* Nearest cut to `t` and the distance to it, by binary search. */
    function nearest(cuts, t) {
        if (!cuts || !cuts.length) return null;
        let lo = 0, hi = cuts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (cuts[mid] < t) lo = mid + 1; else hi = mid;
        }
        let best = cuts[lo];
        if (lo > 0 && Math.abs(cuts[lo - 1] - t) < Math.abs(best - t)) best = cuts[lo - 1];
        return best;
    }

    global.TmShots = { detect, forget, nearest, difference, pickCandidates, signatureOf };
})(typeof window !== 'undefined' ? window : globalThis);
