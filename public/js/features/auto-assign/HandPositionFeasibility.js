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

        // Two-hand keyboards share one physical axis. We label one hand
        // 'low' and the other 'high' (by id when 'left'/'right'
        // present, else by source order) and enforce
        //   low.anchor + low.span < high.anchor
        // throughout the simulation. This means the assignment can no
        // longer be a simple closest-anchor pick: a partition step is
        // needed so that low's notes are strictly below high's notes.
        const lowId  = handIds.includes('left')  ? 'left'  : handIds[0];
        const highId = handIds.includes('right') ? 'right' : (handIds[1] || handIds[0]);
        const sameHand = lowId === highId;

        // Per-hand state: anchor (lowest note in its current window) +
        // span. Anchor stays null until the hand is first assigned.
        const state = new Map();
        for (const id of handIds) {
            state.set(id, { anchor: null, span: handById.get(id).hand_span_semitones ?? 14 });
        }

        function _emitShift(g, id, fromAnchor, toAnchor, source) {
            if (fromAnchor === toAnchor) return;
            out.push({ type: 'shift', tick: g.tick, handId: id, fromAnchor, toAnchor, source });
            state.get(id).anchor = toAnchor;
        }

        for (const g of groups) {
            // 1. Apply pinned overrides first so the partition step
            //    sees the intended anchors.
            for (const id of handIds) {
                const ovKey = `${id}:${g.tick}`;
                if (overrideAnchors.has(ovKey)) {
                    _emitShift(g, id, state.get(id).anchor, overrideAnchors.get(ovKey), 'override');
                }
            }

            // 2. Filter disabled notes upfront.
            const liveNotes = g.notes.filter(n => !disabledNotes.has(`${g.tick}:${n.note}`));
            const unplayable = [];
            const sortedNotes = liveNotes.slice().sort((a, b) => a.note - b.note);

            // 3. Single-hand mode: trivial — same logic as the previous
            //    implementation, no partition needed.
            if (sameHand) {
                if (sortedNotes.length > 0) {
                    const lo = sortedNotes[0].note;
                    const hi = sortedNotes[sortedNotes.length - 1].note;
                    const span = state.get(lowId).span;
                    let newAnchor = state.get(lowId).anchor;
                    if (newAnchor == null || lo < newAnchor || hi > newAnchor + span) {
                        _emitShift(g, lowId, newAnchor, lo, 'auto');
                        newAnchor = lo;
                    }
                    for (const n of sortedNotes) {
                        if (n.note < newAnchor || n.note > newAnchor + span) {
                            unplayable.push({ note: n.note, reason: 'outside_window', handId: lowId });
                        }
                    }
                }
                out.push({ type: 'chord', tick: g.tick, notes: liveNotes.map(n => ({ ...n })), unplayable });
                continue;
            }

            // 4. Two-hand mode: pick the partition split that minimises
            //    movement under the no-overlap constraint.
            const lowSpan  = state.get(lowId).span;
            const highSpan = state.get(highId).span;
            const lowPrev  = state.get(lowId).anchor;
            const highPrev = state.get(highId).anchor;

            const partition = _bestPartition(sortedNotes, lowSpan, highSpan, lowPrev, highPrev, lowId, highId);

            // 5. Apply the chosen partition. Hands without notes don't
            //    move on their own, but if the moving hand's window
            //    would now collide with the idle hand's window, push
            //    the idle hand away — operators can pin it back via an
            //    override if they don't want that.
            const lowAnchor  = partition.lowAnchor;
            const highAnchor = partition.highAnchor;

            if (lowAnchor != null && lowAnchor !== state.get(lowId).anchor) {
                _emitShift(g, lowId, state.get(lowId).anchor, lowAnchor, 'auto');
            }
            if (highAnchor != null && highAnchor !== state.get(highId).anchor) {
                _emitShift(g, highId, state.get(highId).anchor, highAnchor, 'auto');
            }

            // 6. Resolve a pending collision when only one hand moved.
            //    Walk the idle hand away by the smallest amount that
            //    restores the invariant low.high < high.anchor.
            const settled = _resolveOverlap(state, lowId, highId, lowSpan, highSpan);
            if (settled) {
                if (settled.lowAnchor !== state.get(lowId).anchor) {
                    _emitShift(g, lowId, state.get(lowId).anchor, settled.lowAnchor, 'collision');
                }
                if (settled.highAnchor !== state.get(highId).anchor) {
                    _emitShift(g, highId, state.get(highId).anchor, settled.highAnchor, 'collision');
                }
            }

            // 7. Per-note unplayable detection for the chord.
            for (const n of partition.unplayable) {
                unplayable.push(n);
            }
            // Hand-overlap notice when the partition couldn't avoid it.
            if (partition.overlap) {
                unplayable.push({ note: null, reason: 'hand_overlap', handId: null,
                                  message: 'Notes too close to split between hands without overlap' });
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

    /**
     * Find the partition of `sortedNotes` (split into low / high
     * subsets) that fits each side in its respective hand span AND
     * keeps low.high < high.anchor. Falls back to the least-bad
     * option (with `overlap=true` flag) when no partition satisfies
     * the no-overlap invariant.
     *
     * Tie-break: minimise total |new − prev| anchor movement so the
     * planner doesn't bounce hands around between consecutive chords.
     * @private
     */
    function _bestPartition(sortedNotes, lowSpan, highSpan, lowPrev, highPrev, lowId, highId) {
        const N = sortedNotes.length;
        const empty = { lowAnchor: lowPrev, highAnchor: highPrev, unplayable: [], overlap: false };
        if (N === 0) return empty;

        // Reference midpoint used by the initial-state bias below.
        // Notes below SPLIT_REF "want" the low hand; notes at/above
        // it "want" the high hand. The bias only kicks in when no
        // prior anchors exist; once both hands have moved, movement
        // cost dominates the tie-break.
        const SPLIT_REF = 60;
        const isInitial = (lowPrev == null && highPrev == null);

        let best = null;
        // Split index k: low gets notes[0..k-1], high gets notes[k..N-1].
        // k=0 → all on high; k=N → all on low.
        for (let k = 0; k <= N; k++) {
            const lowSet  = sortedNotes.slice(0, k);
            const highSet = sortedNotes.slice(k);
            const lowLo  = lowSet.length  ? lowSet[0].note  : null;
            const lowHi  = lowSet.length  ? lowSet[k - 1].note : null;
            const highLo = highSet.length ? highSet[0].note : null;
            const highHi = highSet.length ? highSet[highSet.length - 1].note : null;

            // Each side must fit its span.
            const lowFits  = lowSet.length  === 0 || (lowHi  - lowLo)  <= lowSpan;
            const highFits = highSet.length === 0 || (highHi - highLo) <= highSpan;
            if (!lowFits || !highFits) continue;

            let lowAnchor  = lowSet.length  ? lowLo  : lowPrev;
            let highAnchor = highSet.length ? highLo : highPrev;

            // When a hand stays idle on the very first chord, give it
            // a parking spot beyond the moving hand's reach so the UI
            // always renders both bands. The parking is conservative
            // (1 semitone beyond the reach) so a small future shift
            // doesn't immediately retrigger a collision.
            if (isInitial) {
                if (lowAnchor == null && highAnchor != null) {
                    lowAnchor = Math.max(0, highAnchor - lowSpan - 1);
                } else if (highAnchor == null && lowAnchor != null) {
                    highAnchor = lowAnchor + lowSpan + 1;
                }
            }

            // No-overlap constraint: low's reachable top must stay
            // strictly below high's anchor.
            const overlaps = (lowAnchor != null && highAnchor != null)
                && (lowAnchor + lowSpan >= highAnchor);
            if (overlaps) continue;

            // Movement cost — driven by music continuity once anchors
            // exist; null on first chord.
            let cost = 0;
            if (!isInitial) {
                cost += Math.abs((lowAnchor  ?? lowLo  ?? 0) - (lowPrev  ?? lowLo  ?? 0));
                cost += Math.abs((highAnchor ?? highLo ?? 0) - (highPrev ?? highLo ?? 0));
            }

            // Permanent pitch bias — the low hand should always
            // prefer low-pitch notes and the high hand should always
            // prefer high-pitch notes. Heavy weight on the very
            // first chord (when no movement cost competes), light
            // weight afterwards so a music-driven shift can still
            // override it but ties always favour the natural
            // assignment.
            const biasWeight = isInitial ? 10 : 1;
            let pitchPenalty = 0;
            for (const n of lowSet)  if (n.note >= SPLIT_REF) pitchPenalty += biasWeight;
            for (const n of highSet) if (n.note <  SPLIT_REF) pitchPenalty += biasWeight;
            cost += pitchPenalty;

            if (!best || cost < best.cost) {
                best = { lowAnchor, highAnchor, unplayable: [], overlap: false, cost };
            }
        }

        if (best) return best;

        // No partition met every constraint. Pick the closest to a
        // fits-the-spans-but-overlaps option; tag the chord as
        // `hand_overlap` so the UI can flag it.
        for (let k = 0; k <= N; k++) {
            const lowSet  = sortedNotes.slice(0, k);
            const highSet = sortedNotes.slice(k);
            const lowLo  = lowSet.length  ? lowSet[0].note  : null;
            const lowHi  = lowSet.length  ? lowSet[k - 1].note : null;
            const highLo = highSet.length ? highSet[0].note : null;
            const highHi = highSet.length ? highSet[highSet.length - 1].note : null;

            const lowFits  = lowSet.length  === 0 || (lowHi  - lowLo)  <= lowSpan;
            const highFits = highSet.length === 0 || (highHi - highLo) <= highSpan;
            if (!lowFits || !highFits) continue;

            const lowAnchor  = lowSet.length  ? lowLo  : lowPrev;
            const highAnchor = highSet.length ? highLo : highPrev;
            return { lowAnchor, highAnchor, unplayable: [], overlap: true };
        }

        // The chord exceeds even the per-hand span on both sides — every
        // note that doesn't fit lands in `unplayable`. Anchor each hand
        // at its previous position (or the first/last note if undefined).
        const unplayable = [];
        for (const n of sortedNotes) {
            unplayable.push({ note: n.note, reason: 'outside_window', handId: null });
        }
        return {
            lowAnchor: lowPrev ?? sortedNotes[0].note,
            highAnchor: highPrev ?? sortedNotes[sortedNotes.length - 1].note,
            unplayable,
            overlap: true
        };
    }

    /**
     * Push the idle hand away when the moving hand's new window would
     * collide with it. Returns null when no adjustment is needed.
     * @private
     */
    function _resolveOverlap(state, lowId, highId, lowSpan, highSpan) {
        const low  = state.get(lowId).anchor;
        const high = state.get(highId).anchor;
        if (low == null || high == null) return null;
        if (low + lowSpan < high) return null; // already disjoint

        // Two strategies; pick the one that moves the smaller
        // distance: push high upward, or push low downward.
        const targetHighFromLow = low + lowSpan + 1;
        const targetLowFromHigh = high - lowSpan - 1;
        const distHigh = Math.abs(targetHighFromLow - high);
        const distLow  = Math.abs(targetLowFromHigh - low);

        if (distHigh <= distLow) {
            return { lowAnchor: low, highAnchor: targetHighFromLow };
        }
        return { lowAnchor: Math.max(0, targetLowFromHigh), highAnchor: high };
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
