// Measures the editor layout once the real renderer has drawn the cue list,
// and publishes the result on #layout-report for the headless runner to read.
(function () {
    const list = document.getElementById('eventsList');

    function timelineTop() {
        return Math.min(...['timelineResizeHandle', 'timelineWrap']
            .map(id => document.getElementById(id))
            .concat([document.querySelector('.tm-timeline-toolbar')])
            .filter(Boolean)
            .map(el => el.getBoundingClientRect().top));
    }

    const px = n => Math.round(n * 10) / 10;

    function measure() {
        const failures = [];
        const listRect = list.getBoundingClientRect();
        const tlTop = timelineTop();
        const shell = document.querySelector('.tm-editor-wrap').getBoundingClientRect();

        if (listRect.bottom > tlTop + 0.5)
            failures.push('cue list bottom ' + px(listRect.bottom) + ' overlaps timeline top ' + px(tlTop));
        if (shell.bottom > window.innerHeight + 0.5)
            failures.push('editor shell bottom ' + px(shell.bottom) + ' exceeds viewport ' + window.innerHeight);
        if (document.documentElement.scrollHeight > window.innerHeight + 1)
            failures.push('page scrolls: scrollHeight ' + document.documentElement.scrollHeight + ' > viewport ' + window.innerHeight);
        if (listRect.height < 90)
            failures.push('cue list collapsed to ' + px(listRect.height) + 'px');

        // Walk the selection through the track exactly as the keyboard
        // shortcut does, and check where the open card comes to rest. This is
        // the translator's actual complaint: press "next cue", get a card with
        // its bottom half hidden.
        const ids = [...list.querySelectorAll('.tm-cue-item')].map(n => Number(n.dataset.id));
        const probes = [ids[0], ids[1], ids[2], ids[Math.floor(ids.length / 2)], ids[ids.length - 2], ids[ids.length - 1]]
            .filter(id => Number.isFinite(id));

        let widest = 0;
        for (const id of probes) {
            selectEvent(id, { scrollBlock: 'center', focusTranslation: true });
            const card = list.querySelector('.tm-cue-item-open');
            if (!card) { failures.push('cue ' + id + ' did not open'); continue; }
            const r = card.getBoundingClientRect();
            const lr = list.getBoundingClientRect();
            widest = Math.max(widest, r.height);

            if (r.height > lr.height + 0.5)
                failures.push('open cue ' + id + ' is ' + px(r.height) + 'px tall but the list viewport is only ' + px(lr.height) + 'px');
            else if (r.top < lr.top - 0.5 || r.bottom > lr.bottom + 0.5)
                failures.push('open cue ' + id + ' rests at ' + px(r.top) + '..' + px(r.bottom) + ', outside list ' + px(lr.top) + '..' + px(lr.bottom));
            if (r.bottom > tlTop + 0.5)
                failures.push('open cue ' + id + ' extends to ' + px(r.bottom) + ', past the timeline at ' + px(tlTop));

            const box = card.querySelector('.tm-translated-input');
            if (!box) failures.push('open cue ' + id + ' has no translation box');
            else if (document.activeElement !== box) failures.push('open cue ' + id + ' did not take the caret');
            else {
                const br = box.getBoundingClientRect();
                if (br.bottom > lr.bottom + 0.5 || br.top < lr.top - 0.5)
                    failures.push('translation box of cue ' + id + ' is not fully visible');
            }
        }

        (window.__errors || []).forEach(msg => failures.push(msg));

        const lr = list.getBoundingClientRect();
        return {
            viewport: window.innerWidth + 'x' + window.innerHeight,
            listTop: px(lr.top), listBottom: px(lr.bottom), listHeight: px(lr.height),
            timelineTop: px(tlTop), shellBottom: px(shell.bottom),
            openCardHeight: px(widest),
            rows: list.querySelectorAll('.tm-cue-row').length,
            failures,
        };
    }

    function publish() {
        let report;
        try { report = measure(); }
        catch (err) { report = { viewport: window.innerWidth + 'x' + window.innerHeight, failures: ['threw: ' + (err && err.message)] }; }
        const out = document.createElement('pre');
        out.id = 'layout-report';
        out.textContent = JSON.stringify(report);
        document.body.appendChild(out);
    }

    // The editor loads its cues asynchronously; wait for the list to fill.
    let tries = 0;
    (function waitForCues() {
        if (list.querySelector('.tm-cue-item') || ++tries > 200) return publish();
        setTimeout(waitForCues, 25);
    })();
})();
