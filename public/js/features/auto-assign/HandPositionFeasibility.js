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

    // ====================================================================
    // simulateHandWindows — client-side mirror of the planner's window
    // logic, simplified for visualization in HandsPreviewPanel (E.6.3+).
    // ====================================================================
    //
    // Two modes mirroring the backend HandPositionPlanner taxonomy:
    //
    //   semitones (keyboards): each hand has hand_span_semitones; we
    //     assign every chord to the closest hand by pitch distance and
    //     anchor a sliding window per hand.
    //
    //   frets (strings): single fretting hand; window is [anchor,
    //     anchor + spanFrets]. Open-string notes (fret 0) don't move
    //     the window. With scale_length_mm + hand_span_mm we compute
    //     the maximum reach physically (geometric fret spacing); else
    //     we fall back to the constant-frets span.
    //
    // Notes are grouped by `tick` into chords so a wide chord that
    // doesn't fit in a single hand window is reported with the right
    // chord-wide unplayable list.
    //
    // Inputs:
    //   - notes: [{tick, note, fret?, string?, channel?}]   (sorted by tick)
    //   - instrument: { hands_config, scale_length_mm? }
    //   - options: { overrides? }    // see schema below
    //
    // Outputs an array of timeline events, each one of:
    //   { type: 'shift',      tick, handId, fromAnchor, toAnchor }
    //   { type: 'chord',      tick, notes:[{...}], unplayable:[{...}] }
    //
    // Plus a `windowsAtEachChord(timeline)` helper to inspect the
    // window state at a given chord without re-running the simulation.
    function simulateHandWindows(notes, instrument, options = {}) {
        const out = [];
        if (!Array.isArray(notes) || notes.length === 0) return out;
        if (!instrument) return out;
        let hands = instrument.hands_config;
        if (typeof hands === 'string') {
            try { hands = JSON.parse(hands); } catch (_) { return out; }
        }
        if (!hands || hands.enabled === false) return out;
        if (!Array.isArray(hands.hands) || hands.hands.length === 0) return out;

        const mode = hands.mode === 'frets' ? 'frets' : 'semitones';
        const overrides = options.overrides || null;
        const overrideAnchors = _indexOverrideAnchors(overrides);
        const disabledNotes = _indexDisabledNotes(overrides);

        // Group notes per tick (chord). Same tolerance as the backend
        // planner so a doubled chord doesn't desynchronize the windows.
        const groups = _groupByTick(notes);

        if (mode === 'frets') {
            return _simulateFrets(groups, hands, instrument, overrideAnchors, disabledNotes);
        }
        return _simulateSemitones(groups, hands, overrideAnchors, disabledNotes);
    }

    function _groupByTick(notes) {
        // Notes within 8 ticks of each other are considered simultaneous.
        const tolerance = 8;
        const sorted = notes.slice().sort((a, b) => a.tick - b.tick);
        const groups = [];
        let current = null;
        for (const n of sorted) {
            if (current && Math.abs(n.tick - current.tick) <= tolerance) {
                current.notes.push(n);
            } else {
                if (current) groups.push(current);
                current = { tick: n.tick, notes: [n] };
            }
        }
        if (current) groups.push(current);
        return groups;
    }

    function _indexOverrideAnchors(overrides) {
        const map = new Map(); // key: `${handId}:${tick}` → anchor
        if (!overrides || !Array.isArray(overrides.hand_anchors)) return map;
        for (const a of overrides.hand_anchors) {
            if (a && Number.isFinite(a.tick) && a.handId && Number.isFinite(a.anchor)) {
                map.set(`${a.handId}:${a.tick}`, a.anchor);
            }
        }
        return map;
    }

    function _indexDisabledNotes(overrides) {
        const map = new Map(); // key: `${tick}:${note}` → reason
        if (!overrides || !Array.isArray(overrides.disabled_notes)) return map;
        for (const n of overrides.disabled_notes) {
            if (n && Number.isFinite(n.tick) && Number.isFinite(n.note)) {
                map.set(`${n.tick}:${n.note}`, n.reason || 'user');
            }
        }
        return map;
    }

    function _simulateSemitones(groups, hands, overrideAnchors, disabledNotes) {
        const out = [];
        const handIds = hands.hands.map(h => h.id);
        const handById = new Map(hands.hands.map(h => [h.id, h]));

        // Per-hand state: anchor (lowest note in its current window) +
        // last assigned tick (used to break ties).
        const state = new Map();
        for (const id of handIds) {
            state.set(id, { anchor: null, span: handById.get(id).hand_span_semitones ?? 14 });
        }

        for (const g of groups) {
            // Apply pinned overrides at this tick before processing notes.
            for (const id of handIds) {
                const ovKey = `${id}:${g.tick}`;
                if (overrideAnchors.has(ovKey)) {
                    const newAnchor = overrideAnchors.get(ovKey);
                    const old = state.get(id).anchor;
                    if (old !== newAnchor) {
                        out.push({ type: 'shift', tick: g.tick, handId: id, fromAnchor: old, toAnchor: newAnchor, source: 'override' });
                        state.get(id).anchor = newAnchor;
                    }
                }
            }

            // Filter disabled notes upfront.
            const liveNotes = g.notes.filter(n => !disabledNotes.has(`${g.tick}:${n.note}`));
            const unplayable = [];

            // Assign each note to the closer hand by current anchor.
            // For uninitialized hands we use a name-based bias (left
            // prefers low pitches, right prefers high) so the very
            // first chord populates BOTH hands instead of stacking on
            // whichever id iterates first.
            const noteOrder = liveNotes.slice().sort((a, b) => a.note - b.note);
            const assignmentByHand = new Map(handIds.map(id => [id, []]));
            for (const n of noteOrder) {
                let bestId = null;
                let bestCost = Infinity;
                for (const id of handIds) {
                    const s = state.get(id);
                    const cost = s.anchor != null
                        ? Math.abs(n.note - s.anchor)
                        // Initial pass: 'right' wants high pitches, 'left' wants low,
                        // anything else falls back to a neutral cost.
                        : (id === 'right' ? (127 - n.note)
                          : id === 'left' ? n.note
                          : 64);
                    if (cost < bestCost) { bestCost = cost; bestId = id; }
                }
                assignmentByHand.get(bestId).push(n);
            }

            // For each hand, compute the necessary window; emit a shift
            // when the new anchor differs from the old.
            for (const id of handIds) {
                const list = assignmentByHand.get(id);
                if (list.length === 0) continue;
                const lo = Math.min(...list.map(n => n.note));
                const hi = Math.max(...list.map(n => n.note));
                const span = state.get(id).span;
                let newAnchor = state.get(id).anchor;
                if (newAnchor == null
                    || lo < newAnchor
                    || hi > newAnchor + span) {
                    newAnchor = lo;
                    out.push({ type: 'shift', tick: g.tick, handId: id, fromAnchor: state.get(id).anchor, toAnchor: newAnchor, source: 'auto' });
                    state.get(id).anchor = newAnchor;
                }
                // Anything outside [anchor, anchor+span] is unplayable.
                for (const n of list) {
                    if (n.note < newAnchor || n.note > newAnchor + span) {
                        unplayable.push({ note: n.note, reason: 'outside_window', handId: id });
                    }
                }
            }

            out.push({
                type: 'chord',
                tick: g.tick,
                notes: liveNotes.map(n => ({ ...n })),
                unplayable
            });
        }
        return out;
    }

    function _simulateFrets(groups, hands, instrument, overrideAnchors, disabledNotes) {
        const out = [];
        const fretting = hands.hands.find(h => h && h.id === 'fretting') || hands.hands[0];
        const handId = fretting.id || 'fretting';
        const spanFrets = Number.isFinite(fretting.hand_span_frets) && fretting.hand_span_frets > 0
            ? fretting.hand_span_frets : 4;
        const handSpanMm = Number.isFinite(fretting.hand_span_mm) && fretting.hand_span_mm > 0
            ? fretting.hand_span_mm : null;
        const scaleLengthMm = Number.isFinite(instrument.scale_length_mm) && instrument.scale_length_mm > 0
            ? instrument.scale_length_mm : null;
        const usePhysical = handSpanMm != null && scaleLengthMm != null;

        // Fret reach as a function of anchor — physical or fixed.
        function maxReach(anchor) {
            if (!usePhysical) return anchor + spanFrets;
            // L * (1 - 2^(-anchor/12)) + handSpanMm = L * (1 - 2^(-q/12))
            // → q = -12 * log2(2^(-anchor/12) - handSpanMm/L)
            const t = Math.pow(2, -anchor / 12) - handSpanMm / scaleLengthMm;
            if (t <= 0) return Infinity;
            return -12 * Math.log2(t);
        }

        let anchor = null;

        for (const g of groups) {
            // Override pin first.
            const ovKey = `${handId}:${g.tick}`;
            if (overrideAnchors.has(ovKey)) {
                const newAnchor = overrideAnchors.get(ovKey);
                if (anchor !== newAnchor) {
                    out.push({ type: 'shift', tick: g.tick, handId, fromAnchor: anchor, toAnchor: newAnchor, source: 'override' });
                    anchor = newAnchor;
                }
            }

            const liveNotes = g.notes.filter(n => !disabledNotes.has(`${g.tick}:${n.note}`));
            const fretted = liveNotes.filter(n => Number.isFinite(n.fret) && n.fret > 0);
            const unplayable = [];

            if (fretted.length > 0) {
                const lo = Math.min(...fretted.map(n => n.fret));
                const hi = Math.max(...fretted.map(n => n.fret));
                if (anchor == null
                    || lo < anchor
                    || hi > maxReach(anchor)) {
                    const newAnchor = lo;
                    out.push({ type: 'shift', tick: g.tick, handId, fromAnchor: anchor, toAnchor: newAnchor, source: 'auto' });
                    anchor = newAnchor;
                }
                const top = maxReach(anchor);
                for (const n of fretted) {
                    if (n.fret < anchor || n.fret > top) {
                        unplayable.push({ note: n.note, fret: n.fret, reason: 'outside_window', handId });
                    }
                }
            }

            out.push({
                type: 'chord',
                tick: g.tick,
                notes: liveNotes.map(n => ({ ...n })),
                unplayable
            });
        }
        return out;
    }

    if (typeof window !== 'undefined') {
        window.HandPositionFeasibility = { classify, renderBadge, aggregateByChannel, simulateHandWindows };
    }
})();
