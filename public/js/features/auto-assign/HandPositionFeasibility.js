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

        // Tempo info — required to convert tick distances into seconds
        // for the speed-limit feasibility check on shift events. When
        // not provided, motion checks fall back to feasible=true (the
        // visualization simply doesn't flag any speed warning).
        let ticksPerSec = null;
        if (Number.isFinite(options.ticksPerSec) && options.ticksPerSec > 0) {
            ticksPerSec = options.ticksPerSec;
        } else if (Number.isFinite(options.ticksPerBeat) && options.ticksPerBeat > 0
                && Number.isFinite(options.bpm) && options.bpm > 0) {
            ticksPerSec = options.ticksPerBeat * (options.bpm / 60);
        }

        // Group notes per tick (chord). Same tolerance as the backend
        // planner so a doubled chord doesn't desynchronize the windows.
        const groups = _groupByTick(notes);

        if (mode === 'frets') {
            return _simulateFrets(groups, hands, instrument, overrideAnchors, disabledNotes);
        }
        return _simulateSemitones(groups, hands, overrideAnchors, disabledNotes, ticksPerSec);
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
        // Annotate each group with `releaseTick` = max(tick + duration)
        // across its notes. Used downstream by the trajectory ribbon
        // so the visualization holds the previous anchor until the
        // chord actually releases, then transitions to the next.
        // Falls back to `tick` when no duration info is present
        // (instant transition — same as before).
        for (const g of groups) {
            let maxEnd = g.tick;
            for (const n of g.notes) {
                const d = Number.isFinite(n.duration) && n.duration > 0 ? n.duration : 0;
                if (g.tick + d > maxEnd) maxEnd = g.tick + d;
            }
            g.releaseTick = maxEnd;
        }
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

    // K-step look-ahead window used by the two-hand anchor refiner.
    // 4 chords keeps the cost bounded while letting the planner park
    // each hand near upcoming material rather than over-shifting on a
    // single chord that doesn't reflect what's just behind it.
    const LOOKAHEAD_K = 4;

    function _simulateSemitones(groups, hands, overrideAnchors, disabledNotes, ticksPerSec) {
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

        // Per-hand tick at which the hand last "let go" — used to
        // compute the available travel time on each shift. Initially
        // null → first shift is unconstrained (the hand was at rest).
        const prevReleaseByHand = Object.create(null);

        function _emitShift(g, id, fromAnchor, toAnchor, source) {
            if (fromAnchor === toAnchor) return;
            const motion = _computeMotion(fromAnchor, toAnchor, hands,
                                            prevReleaseByHand[id], g.tick, ticksPerSec);
            out.push({
                type: 'shift', tick: g.tick, handId: id,
                fromAnchor, toAnchor, source, motion
            });
            state.get(id).anchor = toAnchor;
        }

        const lowSpan  = state.get(lowId).span;
        const highSpan = state.get(highId).span;

        // -------------------------------------------------------------
        // Phase 1 — partition each chord and record per-hand ranges.
        // The simulated anchors fed back into _bestPartition track the
        // partition's preferred anchor (= prev clamped into the valid
        // range) so cost-based tie-breaks stay realistic.
        // -------------------------------------------------------------
        const plans = [];
        let lowSim  = null;
        let highSim = null;

        for (const g of groups) {
            const lowOvKey  = `${lowId}:${g.tick}`;
            const highOvKey = `${highId}:${g.tick}`;
            const lowOv  = overrideAnchors.has(lowOvKey)  ? overrideAnchors.get(lowOvKey)  : null;
            const highOv = overrideAnchors.has(highOvKey) ? overrideAnchors.get(highOvKey) : null;
            if (lowOv  != null) lowSim  = lowOv;
            if (highOv != null) highSim = highOv;

            const liveNotes   = g.notes.filter(n => !disabledNotes.has(`${g.tick}:${n.note}`));
            const sortedNotes = liveNotes.slice().sort((a, b) => a.note - b.note);

            if (sameHand) {
                plans.push({ tick: g.tick, releaseTick: g.releaseTick,
                              liveNotes, sortedNotes, sameHand: true, lowOv, highOv });
                continue;
            }

            const partition = _bestPartition(sortedNotes, lowSpan, highSpan, lowSim, highSim, lowId, highId);
            plans.push({
                tick: g.tick,
                releaseTick: g.releaseTick,
                liveNotes,
                sortedNotes,
                sameHand: false,
                lowOv, highOv,
                lowRange:  partition.lowRange,
                highRange: partition.highRange,
                splitK: partition.splitK,
                unplayable: partition.unplayable,
                overlap: partition.overlap,
                lowDefault:  partition.lowAnchor,
                highDefault: partition.highAnchor
            });
            if (partition.lowAnchor  != null) lowSim  = partition.lowAnchor;
            if (partition.highAnchor != null) highSim = partition.highAnchor;
        }

        // -------------------------------------------------------------
        // Phase 2 — emit shifts/chords, picking each anchor with a
        // K-chord look-ahead so the planner parks each hand near the
        // upcoming material instead of riding the immediate chord.
        // -------------------------------------------------------------
        for (let i = 0; i < plans.length; i++) {
            const plan = plans[i];
            const g = { tick: plan.tick };

            // Apply pinned override anchors first so the look-ahead
            // refiner sees the user's intent in the prev-anchor slot.
            if (plan.lowOv != null) {
                _emitShift(g, lowId, state.get(lowId).anchor, plan.lowOv, 'override');
            }
            if (!sameHand && plan.highOv != null) {
                _emitShift(g, highId, state.get(highId).anchor, plan.highOv, 'override');
            }

            const unplayable = [];

            if (plan.sameHand) {
                if (plan.sortedNotes.length > 0) {
                    const lo = plan.sortedNotes[0].note;
                    const hi = plan.sortedNotes[plan.sortedNotes.length - 1].note;
                    const span = state.get(lowId).span;
                    let newAnchor = state.get(lowId).anchor;
                    if (newAnchor == null || lo < newAnchor || hi > newAnchor + span) {
                        _emitShift(g, lowId, newAnchor, lo, 'auto');
                        newAnchor = lo;
                    }
                    for (const n of plan.sortedNotes) {
                        if (n.note < newAnchor || n.note > newAnchor + span) {
                            unplayable.push({ note: n.note, reason: 'outside_window', handId: lowId });
                        }
                    }
                }
                // Single-hand keyboard: every note belongs to that hand.
                const taggedNotes = plan.liveNotes.map(n => ({ ...n, handId: lowId }));
                const releaseByHand = _releaseByHand(taggedNotes, [lowId], plan.tick);
                out.push({ type: 'chord', tick: plan.tick,
                           releaseTick: plan.releaseTick,
                           releaseByHand,
                           notes: taggedNotes,
                           unplayable });
                _updatePrevRelease(prevReleaseByHand, releaseByHand);
                continue;
            }

            // Build the K-chord futures for each hand.
            const futureLow  = [];
            const futureHigh = [];
            for (let j = i + 1; j < Math.min(i + 1 + LOOKAHEAD_K, plans.length); j++) {
                if (plans[j].sameHand) break; // mode shouldn't change mid-stream
                futureLow.push(plans[j].lowRange);
                futureHigh.push(plans[j].highRange);
            }

            const lowPrev  = state.get(lowId).anchor;
            const highPrev = state.get(highId).anchor;

            const lowAnchor = plan.lowOv != null
                ? plan.lowOv
                : _pickAnchorWithLookahead(lowPrev, plan.lowRange, futureLow, plan.lowDefault);
            const highAnchor = plan.highOv != null
                ? plan.highOv
                : _pickAnchorWithLookahead(highPrev, plan.highRange, futureHigh, plan.highDefault);

            if (lowAnchor  != null && lowAnchor  !== state.get(lowId).anchor) {
                _emitShift(g, lowId,  state.get(lowId).anchor,  lowAnchor,  'auto');
            }
            if (highAnchor != null && highAnchor !== state.get(highId).anchor) {
                _emitShift(g, highId, state.get(highId).anchor, highAnchor, 'auto');
            }

            const settled = _resolveOverlap(state, lowId, highId, lowSpan, highSpan);
            if (settled) {
                if (settled.lowAnchor  !== state.get(lowId).anchor) {
                    _emitShift(g, lowId,  state.get(lowId).anchor,  settled.lowAnchor,  'collision');
                }
                if (settled.highAnchor !== state.get(highId).anchor) {
                    _emitShift(g, highId, state.get(highId).anchor, settled.highAnchor, 'collision');
                }
            }

            for (const n of plan.unplayable) unplayable.push(n);
            if (plan.overlap) {
                unplayable.push({ note: null, reason: 'hand_overlap', handId: null,
                                  message: 'Notes too close to split between hands without overlap' });
            }

            // Tag each note with the hand that will play it. The
            // partition's `splitK` divides `sortedNotes` so notes
            // before the split go to `lowId`, after to `highId`.
            // Then translate that back to `liveNotes` (which is in
            // input order, not pitch-sorted) via reference identity.
            const taggedNotes = _tagNotesByPartition(plan.liveNotes, plan.sortedNotes,
                                                       plan.splitK, lowId, highId);
            const releaseByHand = _releaseByHand(taggedNotes, [lowId, highId], plan.tick);

            out.push({
                type: 'chord',
                tick: plan.tick,
                releaseTick: plan.releaseTick,
                releaseByHand,
                notes: taggedNotes,
                unplayable
            });
            _updatePrevRelease(prevReleaseByHand, releaseByHand);
        }
        return out;
    }

    /** Replace per-hand previous-release entries with the latest
     *  chord's `releaseByHand`. Hands not in the new map keep their
     *  prior value (so an idle chord doesn't reset the timer).
     *  @private */
    function _updatePrevRelease(prev, releaseByHand) {
        if (!releaseByHand) return;
        for (const id of Object.keys(releaseByHand)) {
            const v = releaseByHand[id];
            if (Number.isFinite(v)) prev[id] = v;
        }
    }

    /**
     * Compute the motion envelope for a shift: the time required to
     * travel `|to − from|` semitones at `hand_move_semitones_per_sec`,
     * the time available since the hand's previous release, and a
     * boolean `feasible` flag (= `availableSec >= requiredSec`).
     *
     * Returns `{ requiredSec: 0, availableSec: Infinity, feasible: true }`
     * when tempo info or speed limit isn't available — the visualization
     * then doesn't flag any speed warning, matching the previous
     * "no constraint" behaviour.
     * @private
     */
    function _computeMotion(fromAnchor, toAnchor, hands, prevReleaseTick,
                              currentTick, ticksPerSec) {
        if (!Number.isFinite(fromAnchor) || !Number.isFinite(toAnchor)
                || !Number.isFinite(ticksPerSec) || ticksPerSec <= 0) {
            return { requiredSec: 0, availableSec: Infinity, feasible: true };
        }
        const speed = Number.isFinite(hands.hand_move_semitones_per_sec)
                && hands.hand_move_semitones_per_sec > 0
            ? hands.hand_move_semitones_per_sec
            : null;
        const distance = Math.abs(toAnchor - fromAnchor);
        if (speed == null) {
            return { requiredSec: 0, availableSec: Infinity, feasible: true };
        }
        const requiredSec = distance / speed;
        const prevTick = Number.isFinite(prevReleaseTick) ? prevReleaseTick : null;
        const availableTicks = prevTick != null ? Math.max(0, currentTick - prevTick) : Infinity;
        const availableSec = availableTicks === Infinity ? Infinity : availableTicks / ticksPerSec;
        const feasible = availableSec + 1e-6 >= requiredSec;
        return { requiredSec, availableSec, feasible };
    }

    /**
     * Tag each note in `liveNotes` with `handId` based on the
     * partition's split index `k` over `sortedNotes`. Returns a new
     * array (originals untouched). @private
     */
    function _tagNotesByPartition(liveNotes, sortedNotes, splitK, lowId, highId) {
        const lowSet = new Set();
        const k = Number.isFinite(splitK) ? splitK : Math.floor(sortedNotes.length / 2);
        for (let i = 0; i < k; i++) lowSet.add(sortedNotes[i]);
        return liveNotes.map(n => ({
            ...n,
            handId: lowSet.has(n) ? lowId : highId
        }));
    }

    /**
     * Build `{ [handId]: maxReleaseTick }` from a list of tagged
     * notes. Hands without any notes in the chord get `releaseTick =
     * chordTick` so the visualization knows it's free immediately.
     * @private
     */
    function _releaseByHand(taggedNotes, handIds, chordTick) {
        const byHand = Object.create(null);
        for (const id of handIds) byHand[id] = chordTick;
        for (const n of taggedNotes) {
            const dur = Number.isFinite(n.duration) && n.duration > 0 ? n.duration : 0;
            const end = n.tick + dur;
            if (n.handId && (byHand[n.handId] == null || end > byHand[n.handId])) {
                byHand[n.handId] = end;
            }
        }
        return byHand;
    }

    /**
     * Pick the anchor inside `range` that minimises cumulative
     * movement across `futureRanges` (with exponential decay).
     *
     *   - `prev` is the hand's current anchor (null → first chord).
     *   - `range` is the [lo, hi] of valid anchors for THIS chord
     *     (= [maxNote-span, minNote]); null means the hand is idle.
     *   - `futureRanges` is an array of upcoming ranges (each may be
     *     null for an idle chord).
     *   - `fallback` is the value to use when no prev / no range
     *     guidance applies — usually the partition's default anchor.
     *
     * If `prev` already lies inside `range`, we keep it (zero shift)
     * and only break ties when prev is also movement-equivalent for
     * the future. Otherwise we evaluate a small candidate set
     * (range bounds + each future bound clamped into `range`) and
     * pick the one with the lowest decayed cost.
     * @private
     */
    function _pickAnchorWithLookahead(prev, range, futureRanges, fallback) {
        if (range == null) {
            // Idle this chord: keep current position.
            return prev != null ? prev : (fallback != null ? fallback : null);
        }
        const [lo, hi] = range;
        const fb = fallback != null ? Math.max(lo, Math.min(hi, fallback)) : lo;

        const candidates = new Set();
        candidates.add(lo);
        candidates.add(hi);
        candidates.add(fb);
        if (prev != null) candidates.add(Math.max(lo, Math.min(hi, prev)));
        for (const r of futureRanges || []) {
            if (!r) continue;
            candidates.add(Math.max(lo, Math.min(hi, r[0])));
            candidates.add(Math.max(lo, Math.min(hi, r[1])));
        }

        let best = null;
        for (const a of candidates) {
            // Immediate shift cost.
            let cost = prev != null ? Math.abs(a - prev) : 0;

            // Decayed cost of propagating `a` through the future
            // chords — at each step the hand moves the smallest
            // amount that lands in the next range.
            let cur = a;
            let weight = 0.7;
            for (const r of futureRanges || []) {
                if (!r) { weight *= 0.7; continue; }
                const next = Math.max(r[0], Math.min(cur, r[1]));
                cost += weight * Math.abs(next - cur);
                cur = next;
                weight *= 0.7;
            }

            // Tie-break: prefer the fallback (= partition's natural
            // anchor — usually the lo of the assigned set) so the
            // band's visual position stays predictable when no
            // movement constraint differentiates candidates.
            const tie = Math.abs(a - fb) * 1e-6;
            cost += tie;

            if (!best || cost < best.cost) {
                best = { a, cost };
            }
        }
        return best ? best.a : fb;
    }

    /**
     * Find the partition of `sortedNotes` (split into low / high
     * subsets) that fits each side in its respective hand span AND
     * keeps low.high < high.anchor. Falls back to the least-bad
     * option (with `overlap=true` flag) when no partition satisfies
     * the no-overlap invariant.
     *
     * Tie-break: minimise total |clamped(prev) − prev| anchor
     * movement so the planner doesn't bounce hands around between
     * consecutive chords. The "preferred anchor" returned per side
     * is the prev clamped into the partition's valid range — i.e.
     * zero movement when the hand was already inside the range.
     * The two-pass refiner in `_simulateSemitones` may swap that
     * anchor for a look-ahead-aware one, so we also return the
     * full valid range (`lowRange`, `highRange`) for each side.
     * @private
     */
    function _bestPartition(sortedNotes, lowSpan, highSpan, lowPrev, highPrev, lowId, highId) {
        const N = sortedNotes.length;
        if (N === 0) {
            return { lowAnchor: lowPrev, highAnchor: highPrev,
                     lowRange: null, highRange: null,
                     splitK: 0, unplayable: [], overlap: false };
        }

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

            // Valid anchor range per hand: [hi - span, lo].
            const lowRange  = lowSet.length  ? [lowHi  - lowSpan,  lowLo]  : null;
            const highRange = highSet.length ? [highHi - highSpan, highLo] : null;

            // Preferred anchor = prev clamped into the valid range.
            // 0 movement when the hand was already in range; otherwise
            // the closest in-range value. Initial chord falls back to
            // the lowest note in the set so the band starts at the
            // music's natural floor / ceiling.
            let lowAnchor  = _clampInto(lowPrev,  lowRange,  lowLo);
            let highAnchor = _clampInto(highPrev, highRange, highLo);

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
                best = { lowAnchor, highAnchor, lowRange, highRange,
                         splitK: k, unplayable: [], overlap: false, cost };
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

            const lowRange  = lowSet.length  ? [lowHi  - lowSpan,  lowLo]  : null;
            const highRange = highSet.length ? [highHi - highSpan, highLo] : null;
            const lowAnchor  = _clampInto(lowPrev,  lowRange,  lowLo);
            const highAnchor = _clampInto(highPrev, highRange, highLo);
            return { lowAnchor, highAnchor, lowRange, highRange,
                     splitK: k, unplayable: [], overlap: true };
        }

        // The chord exceeds even the per-hand span on both sides — every
        // note that doesn't fit lands in `unplayable`. Anchor each hand
        // at its previous position (or the first/last note if undefined).
        const unplayable = [];
        for (const n of sortedNotes) {
            unplayable.push({ note: n.note, reason: 'outside_window', handId: null });
        }
        return {
            lowAnchor:  lowPrev  ?? sortedNotes[0].note,
            highAnchor: highPrev ?? sortedNotes[sortedNotes.length - 1].note,
            lowRange:  null,
            highRange: null,
            // Split notes by pitch midpoint so the per-note handId
            // tagging downstream still gets a sensible assignment
            // even when no partition fits the spans.
            splitK: Math.floor(sortedNotes.length / 2),
            unplayable,
            overlap: true
        };
    }

    /** Clamp `value` into `range` (= [lo, hi]); returns `fallback`
     *  when value is null and a `range` is provided. @private */
    function _clampInto(value, range, fallback) {
        if (range == null) return value;
        const [lo, hi] = range;
        if (value == null) return fallback != null ? fallback : lo;
        return Math.max(lo, Math.min(hi, value));
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
                releaseTick: g.releaseTick,
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
