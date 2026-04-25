/**
 * @file HandPositionFeasibility.js
 * @description Client-side mirror of the heuristic that lives in
 * InstrumentMatcher._scoreHandPositionFeasibility. We duplicate it here
 * (rather than calling the backend) so the RoutingSummaryPage can paint
 * a feasibility badge per channel from data it already has on hand
 * (allInstruments + channelAnalyses) without an extra round-trip.
 *
 * The taxonomy is identical to the backend one so the frontend never
 * has to translate level strings:
 *   'unknown' | 'ok' | 'warning' | 'infeasible'
 */
(function() {
    'use strict';

    function classify(channelAnalysis, instrument) {
        if (!instrument) return { level: 'unknown', summary: {} };
        let hands = instrument.hands_config;
        if (typeof hands === 'string') {
            try { hands = JSON.parse(hands); } catch (_) { return { level: 'unknown', summary: {} }; }
        }
        if (!hands || hands.enabled === false) return { level: 'unknown', summary: {} };
        if (!Array.isArray(hands.hands) || hands.hands.length === 0) {
            return { level: 'unknown', summary: {} };
        }

        const polyphonyMax = channelAnalysis?.polyphony?.max ?? null;
        const noteRange = channelAnalysis?.noteRange ?? null;
        const rangeSpan = (noteRange && noteRange.min != null && noteRange.max != null)
            ? noteRange.max - noteRange.min
            : null;

        const mode = hands.mode === 'frets' ? 'frets' : 'semitones';
        const summary = { mode };

        if (mode === 'frets') {
            const fretting = hands.hands.find(h => h && h.id === 'fretting') || hands.hands[0];
            const maxFingers = Number.isFinite(fretting?.max_fingers) && fretting.max_fingers > 0
                ? fretting.max_fingers : null;
            const handSpanFrets = Number.isFinite(fretting?.hand_span_frets) && fretting.hand_span_frets > 0
                ? fretting.hand_span_frets : null;
            summary.maxFingers = maxFingers;
            summary.handSpanFrets = handSpanFrets;
            summary.polyphonyMax = polyphonyMax;
            summary.pitchSpan = rangeSpan;

            if (maxFingers != null && polyphonyMax != null && polyphonyMax > maxFingers) {
                return { level: 'infeasible', summary };
            }
            if (handSpanFrets != null && rangeSpan != null && rangeSpan > handSpanFrets * 3) {
                return { level: 'warning', summary };
            }
            return { level: 'ok', summary };
        }

        // semitones
        const totalSpan = hands.hands.reduce((s, h) => s + (Number.isFinite(h?.hand_span_semitones) ? h.hand_span_semitones : 14), 0);
        const totalFingers = hands.hands.length * 5;
        summary.totalSpanSemitones = totalSpan;
        summary.totalFingers = totalFingers;
        summary.polyphonyMax = polyphonyMax;
        summary.pitchSpan = rangeSpan;

        if (polyphonyMax != null && polyphonyMax > totalFingers) {
            return { level: 'infeasible', summary };
        }
        if (rangeSpan != null && rangeSpan > totalSpan * 2) {
            return { level: 'warning', summary };
        }
        return { level: 'ok', summary };
    }

    /**
     * Render a small inline badge for the given level. Returns an
     * empty string for `unknown` so the column stays compact when
     * the data isn't available — empty cells are friendlier than a
     * row of dashes.
     */
    function renderBadge(level, opts = {}) {
        const t = (key, fallback) => {
            if (window.i18n && typeof window.i18n.t === 'function') {
                const v = window.i18n.t(key);
                if (v && v !== key) return v;
            }
            return fallback;
        };
        const labels = {
            ok:         { glyph: '✓',  cls: 'rs-hand-ok',         title: t('handPosition.badgeOk',         'Hand-position OK') },
            warning:    { glyph: '⚠',  cls: 'rs-hand-warning',    title: t('handPosition.badgeWarning',    'Hand-position warning') },
            infeasible: { glyph: '✗',  cls: 'rs-hand-infeasible', title: t('handPosition.badgeInfeasible', 'Hand-position infeasible') }
        };
        const entry = labels[level];
        if (!entry) return '';
        const extraTitle = opts.extraTitle ? ` — ${opts.extraTitle}` : '';
        return `<span class="rs-hand-badge ${entry.cls}" title="${entry.title}${extraTitle}">${entry.glyph}</span>`;
    }

    /**
     * Build a `{channel: level}` map from a `handPositionWarnings`
     * array (the one returned by apply_assignments). When several
     * entries cover the same channel (split routings), the worst
     * level wins.
     */
    function aggregateByChannel(warnings) {
        const order = { unknown: 0, ok: 1, warning: 2, infeasible: 3 };
        const byChannel = new Map();
        if (!Array.isArray(warnings)) return byChannel;
        for (const w of warnings) {
            if (!w || typeof w.channel !== 'number') continue;
            const cur = byChannel.get(w.channel);
            if (!cur || (order[w.level] || 0) > (order[cur.level] || 0)) {
                byChannel.set(w.channel, { level: w.level, summary: w.summary, message: w.message });
            }
        }
        return byChannel;
    }

    if (typeof window !== 'undefined') {
        window.HandPositionFeasibility = { classify, renderBadge, aggregateByChannel };
    }
})();
