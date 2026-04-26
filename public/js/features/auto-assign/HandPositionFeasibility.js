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
        const noteAssignments = _indexNoteAssignments(overrides);

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
            return _simulateFrets(groups, hands, instrument, overrideAnchors, disabledNotes, ticksPerSec, noteAssignments);
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

    /**
     * PR6 — index operator-pinned (string, fret) assignments by
     * `(tick, midi)`. Lookups happen for every note inside
     * `_simulateFrets` BEFORE the auto-resolver runs so the operator's
     * choice always wins (and can be undone via the editor's history).
     * @private
     */
    function _indexNoteAssignments(overrides) {
        const map = new Map(); // key: `${tick}:${note}` → {string, fret}
        if (!overrides || !Array.isArray(overrides.note_assignments)) return map;
        for (const a of overrides.note_assignments) {
            if (a && Number.isFinite(a.tick) && Number.isFinite(a.note)
                && Number.isFinite(a.string) && Number.isFinite(a.fret)) {
                map.set(`${a.tick}:${a.note}`, { string: a.string, fret: a.fret });
            }
        }
        return map;
    }

    /**
     * PR6 — list every plausible (string, fret) pair that produces a
     * given MIDI pitch on a given instrument. Used by the editor's
     * note-edit menu to populate the chips of cordes alternatives.
     *
     * Returns an array of `{string, fret}` ordered by ascending fret
     * so the menu lists the lowest-fret options first.
     *
     * @param {number} midi
     * @param {{tuning:number[], num_frets?:number}} instrument
     * @param {{maxFret?:number}} [opts]
     * @returns {Array<{string:number, fret:number}>}
     */
    function findStringCandidates(midi, instrument, opts = {}) {
        if (!Number.isFinite(midi) || !instrument) return [];
        const tuning = Array.isArray(instrument.tuning) ? instrument.tuning : null;
        if (!tuning || tuning.length === 0) return [];
        const numFrets = Number.isFinite(opts.maxFret) ? opts.maxFret
            : (Number.isFinite(instrument.num_frets) ? instrument.num_frets : 24);
        const out = [];
        for (let s = 0; s < tuning.length; s++) {
            const open = tuning[s];
            const fret = midi - open;
            if (fret < 0 || fret > numFrets) continue;
            // tuning array is conventionally low → high pitch; the rest
            // of the renderer treats string indices as 1-based with 1 =
            // lowest pitch (FretboardHandPreview.js:_stringY). Match
            // that convention so caller can plug the result straight in.
            out.push({ string: s + 1, fret });
        }
        out.sort((a, b) => a.fret - b.fret);
        return out;
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

    function _simulateFrets(groups, hands, instrument, overrideAnchors, disabledNotes, ticksPerSec, noteAssignments) {
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
        const maxFingers = Number.isFinite(fretting.max_fingers) && fretting.max_fingers > 0
            ? fretting.max_fingers : null;
        // Speed limits — physical mm/s preferred, fret/s fallback.
        const speedMmPerSec = Number.isFinite(hands.hand_move_mm_per_sec) && hands.hand_move_mm_per_sec > 0
            ? hands.hand_move_mm_per_sec : null;
        const speedFretsPerSec = Number.isFinite(hands.hand_move_frets_per_sec) && hands.hand_move_frets_per_sec > 0
            ? hands.hand_move_frets_per_sec : null;

        // Notes coming straight from MIDI rarely have `fret` / `string`
        // pre-resolved (full tablature conversion only happens at apply
        // time on the server). The simulator resolves them on the fly
        // INSIDE the per-group loop below using the current hand
        // anchor as a hint — picking a fret near where the hand
        // already sits avoids spurious "outside_window" flags. The
        // resolver is also re-applied per chord so a shift earlier
        // in the song carries through to later chords.
        const tuning = Array.isArray(instrument.tuning) ? instrument.tuning : null;
        const numFrets = Number.isFinite(instrument.num_frets) && instrument.num_frets > 0
            ? instrument.num_frets : 24;

        // Fret reach as a function of anchor — physical or fixed.
        function maxReach(anchor) {
            if (!usePhysical) return anchor + spanFrets;
            // L * (1 - 2^(-anchor/12)) + handSpanMm = L * (1 - 2^(-q/12))
            // → q = -12 * log2(2^(-anchor/12) - handSpanMm/L)
            const t = Math.pow(2, -anchor / 12) - handSpanMm / scaleLengthMm;
            if (t <= 0) return Infinity;
            return -12 * Math.log2(t);
        }

        // Inverse of maxReach: the smallest anchor whose reach
        // covers `top`. Used to compute the lower bound of the
        // valid anchor range for a chord whose highest fret is
        // `top`. In fret-count mode that's just `top - spanFrets`;
        // in physical mode we invert the reach formula.
        function minAnchorForTop(top) {
            if (!usePhysical) return Math.max(0, top - spanFrets);
            // maxReach(a) = top  ⇒  2^(-top/12) = 2^(-a/12) − k  ⇒
            //   a = -12 · log2(2^(-top/12) + k)  with k = handSpanMm / L.
            const v = Math.pow(2, -top / 12) + handSpanMm / scaleLengthMm;
            if (v <= 0) return 0;
            return Math.max(0, -12 * Math.log2(v));
        }

        // Index-finger backoff: the index sits 10 mm behind the
        // chord's lowest fret (`bestLow`) so it can press that fret
        // with its tip. Mirrors `HandPositionPlanner._anchorBehindFret`
        // — the two simulators must agree on the anchor, otherwise
        // the live preview band drifts away from the playback CC.
        const INDEX_BACKOFF_MM = 10;
        function anchorBehindFret(targetFret) {
            if (!usePhysical) return targetFret;
            const targetMm = scaleLengthMm * (1 - Math.pow(2, -targetFret / 12));
            const anchorMm = Math.max(0, targetMm - INDEX_BACKOFF_MM);
            if (anchorMm <= 0) return 0;
            return -12 * Math.log2(1 - anchorMm / scaleLengthMm);
        }

        // Travel time between two fret anchors. Physical mm if scale
        // length is configured, fret-count otherwise. Returns null
        // when no speed limit is available (= no constraint).
        function computeMotion(fromAnchor, toAnchor, prevReleaseTick, currentTick) {
            if (!Number.isFinite(fromAnchor) || !Number.isFinite(toAnchor)
                    || !Number.isFinite(ticksPerSec) || ticksPerSec <= 0) {
                return { requiredSec: 0, availableSec: Infinity, feasible: true };
            }
            let requiredSec;
            if (scaleLengthMm != null && speedMmPerSec != null) {
                const fromMm = scaleLengthMm * (1 - Math.pow(2, -fromAnchor / 12));
                const toMm   = scaleLengthMm * (1 - Math.pow(2, -toAnchor   / 12));
                requiredSec = Math.abs(toMm - fromMm) / speedMmPerSec;
            } else if (speedFretsPerSec != null) {
                requiredSec = Math.abs(toAnchor - fromAnchor) / speedFretsPerSec;
            } else {
                return { requiredSec: 0, availableSec: Infinity, feasible: true };
            }
            const prevTick = Number.isFinite(prevReleaseTick) ? prevReleaseTick : null;
            const availableTicks = prevTick != null
                ? Math.max(0, currentTick - prevTick) : Infinity;
            const availableSec = availableTicks === Infinity
                ? Infinity : availableTicks / ticksPerSec;
            const feasible = availableSec + 1e-6 >= requiredSec;
            return { requiredSec, availableSec, feasible };
        }

        let anchor = null;
        // Per-hand last release tick (always the same hand here, but
        // we keep the structure consistent with semitones).
        const prevReleaseByHand = Object.create(null);

        // Precompute an estimated [minA, maxA] anchor range for each
        // upcoming chord. The estimate uses the LOWEST-fret-per-
        // string heuristic on the raw MIDI notes (= same idea as
        // `_resolveStringFret` without context). It's intentionally
        // anchor-independent so we can use it as a lookahead hint
        // when picking the current chord's anchor — without
        // creating circular "anchor depends on resolution depends on
        // anchor" dependencies.
        const LOOKAHEAD_K = 4;
        const chordAnchorRanges = groups.map(g => {
            let lo = Infinity, hi = -Infinity;
            for (const n of g.notes) {
                let bestFret = null;
                if (Number.isFinite(n.fret) && n.fret > 0) {
                    bestFret = n.fret;
                } else if (Number.isFinite(n.note) && tuning) {
                    for (let s = 0; s < tuning.length; s++) {
                        const fret = n.note - tuning[s];
                        if (fret > 0 && fret <= numFrets) {
                            if (bestFret == null || fret < bestFret) bestFret = fret;
                        }
                    }
                }
                if (bestFret != null) {
                    if (bestFret < lo) lo = bestFret;
                    if (bestFret > hi) hi = bestFret;
                }
            }
            if (lo === Infinity) return null; // chord has no fretted note (open strings only)
            // The valid anchor range for this chord is
            // [minAnchorForTop(hi), idealLow] where `idealLow` is 10 mm
            // behind the chord's lowest fret. The picker favours the
            // upper bound (idealLow) when nothing else pulls the anchor
            // away — same convention as before, but applied to the
            // backed-off anchor instead of `lo` directly.
            const idealLow = anchorBehindFret(lo);
            return [minAnchorForTop(hi), Math.max(minAnchorForTop(hi), idealLow)];
        });

        /**
         * Lookahead-aware anchor picker. Given the prev anchor, the
         * CURRENT chord's valid anchor range, and a list of future
         * anchor ranges, pick the in-range anchor that minimises the
         * cumulative shift cost over the next K chords (with
         * exponential decay). Tie-break: lower fret wins.
         * @private
         */
        function pickAnchorWithLookahead(prev, range, futureRanges) {
            if (!range) return prev;
            const [minA, maxA] = range;
            if (minA > maxA) return maxA; // empty range (chord wider than hand)

            const candidates = new Set();
            candidates.add(minA);
            candidates.add(maxA);
            if (prev != null) candidates.add(Math.max(minA, Math.min(maxA, prev)));
            for (const r of futureRanges) {
                if (!r) continue;
                candidates.add(Math.max(minA, Math.min(maxA, r[0])));
                candidates.add(Math.max(minA, Math.min(maxA, r[1])));
            }

            let best = null;
            for (const c of candidates) {
                let cost = (prev != null) ? Math.abs(c - prev) : 0;
                let cur = c;
                // Weight starts at 1.0 — the IMMEDIATE next chord's
                // shift cost matters as much as the move we're about
                // to make. Without that, the picker is too lazy and
                // never trades a small proactive shift for a much
                // bigger forced shift one chord later.
                let weight = 1.0;
                for (const r of futureRanges) {
                    if (!r) { weight *= 0.7; continue; }
                    const next = Math.max(r[0], Math.min(cur, r[1]));
                    cost += weight * Math.abs(next - cur);
                    cur = next;
                    weight *= 0.7;
                }
                // Tie-break: prefer the natural-floor anchor (maxA =
                // lo of the chord's fretted notes). Matches the
                // legacy behaviour and feels natural when the music
                // sits at a stable position.
                cost += Math.abs(c - maxA) * 1e-6;
                if (!best || cost < best.cost) {
                    best = { anchor: c, cost };
                }
            }
            return best ? best.anchor : maxA;
        }

        for (let i = 0; i < groups.length; i++) {
            const g = groups[i];
            // Override pin first.
            const ovKey = `${handId}:${g.tick}`;
            if (overrideAnchors.has(ovKey)) {
                const newAnchor = overrideAnchors.get(ovKey);
                if (anchor !== newAnchor) {
                    const motion = computeMotion(anchor, newAnchor,
                                                  prevReleaseByHand[handId], g.tick);
                    out.push({ type: 'shift', tick: g.tick, handId,
                                fromAnchor: anchor, toAnchor: newAnchor,
                                source: 'override', motion });
                    anchor = newAnchor;
                }
            }

            // PR6 — apply operator-pinned (string, fret) overrides
            // BEFORE the auto-resolver so the resolver treats them as
            // already-tagged (and won't reassign their string).
            if (noteAssignments && noteAssignments.size > 0) {
                g.notes = g.notes.map(n => {
                    const pinned = noteAssignments.get(`${g.tick}:${n.note}`);
                    if (!pinned) return n;
                    return { ...n, string: pinned.string, fret: pinned.fret };
                });
            }
            // Resolve unannotated notes WITH the current hand
            // anchor in mind. Done at the CHORD level so that no two
            // notes get assigned to the same string — physically a
            // single string can only sound one pitch at a time.
            // Already-tagged notes (with explicit string + fret)
            // reserve their string before the unresolved ones are
            // assigned greedily.
            if (tuning && tuning.length > 0) {
                const resolutions = _resolveChordStringFret(
                    g.notes, tuning, numFrets, anchor, spanFrets);
                g.notes = g.notes.map((n, i) => {
                    const r = resolutions[i];
                    return r ? { ...n, fret: r.fret, string: r.string } : n;
                });
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
                    // The hand MUST move. Pick the new anchor inside
                    // the chord's valid range
                    // [minAnchorForTop(hi), idealLow] where idealLow
                    // = anchorBehindFret(lo) is 10 mm behind the
                    // chord's lowest fret. The picker uses LOOKAHEAD
                    // to minimise cumulative shift cost. For chords
                    // wider than the hand's reach the range collapses;
                    // we fall back to `idealLow` so the low note still
                    // sits inside the band.
                    const minA = minAnchorForTop(hi);
                    const maxA = Math.max(minA, anchorBehindFret(lo));
                    let newAnchor;
                    if (minA > maxA) {
                        newAnchor = anchorBehindFret(lo);
                    } else {
                        const futureRanges = [];
                        for (let j = i + 1;
                                j < Math.min(i + 1 + LOOKAHEAD_K, groups.length);
                                j++) {
                            futureRanges.push(chordAnchorRanges[j]);
                        }
                        newAnchor = pickAnchorWithLookahead(anchor, [minA, maxA], futureRanges);
                    }
                    const motion = computeMotion(anchor, newAnchor,
                                                  prevReleaseByHand[handId], g.tick);
                    out.push({ type: 'shift', tick: g.tick, handId,
                                fromAnchor: anchor, toAnchor: newAnchor,
                                source: 'auto', motion });
                    anchor = newAnchor;
                }
                const top = maxReach(anchor);
                for (const n of fretted) {
                    if (n.fret < anchor || n.fret > top) {
                        // Direction tells the renderer where to park the
                        // marker (left of the band when the note sits
                        // below the anchor, right when it sits past the
                        // top of the reach). Used by FretboardHandPreview
                        // to draw an offset chevron instead of stacking
                        // the dot on top of the unreachable fret.
                        const direction = n.fret < anchor ? 'left' : 'right';
                        unplayable.push({ note: n.note, fret: n.fret, string: n.string,
                                          reason: 'outside_window', handId, direction });
                    }
                }
            }

            // max_fingers enforcement: when the chord has more
            // fretted notes than the hand can press, flag every
            // fretted note + emit a chord-level marker so the band
            // can turn red.
            if (maxFingers != null && fretted.length > maxFingers) {
                for (const n of fretted) {
                    unplayable.push({ note: n.note, fret: n.fret, string: n.string,
                                       reason: 'too_many_fingers', handId });
                }
                unplayable.push({ note: null, reason: 'too_many_fingers',
                                  handId,
                                  message: `${fretted.length}/${maxFingers} fingers required` });
            }

            // Tag every playable note with its hand id (single hand
            // here, but parity with semitones: the panel + lookahead
            // strip can rely on the field being present).
            const taggedNotes = liveNotes.map(n => ({ ...n, handId }));
            const releaseByHand = _releaseByHand(taggedNotes, [handId], g.tick);

            out.push({
                type: 'chord',
                tick: g.tick,
                releaseTick: g.releaseTick,
                releaseByHand,
                notes: taggedNotes,
                unplayable
            });
            _updatePrevRelease(prevReleaseByHand, releaseByHand);
        }
        return out;
    }

    /**
     * Resolve a MIDI note to (string, fret) on the given tuning by
     * picking the string that yields the LOWEST fret ≥ 0 — a simple
     * "open position" approximation. Returns `null` when the note
     * doesn't fit on any string within the available fret range.
     *
     * Used as a best-effort fallback for the preview when notes
     * arrive without tablature data (full tab conversion only runs
     * on apply-routing in the backend).
     *
     * @param {number} midi - MIDI note number
     * @param {number[]} tuning - open-string MIDI numbers, indexed
     *                            from low (1) to high (N)
     * @param {number} numFrets - max fret on the neck
     * @returns {{string:number, fret:number}|null}
     * @private
     */
    function _resolveStringFret(midi, tuning, numFrets) {
        if (!Array.isArray(tuning) || tuning.length === 0) return null;
        if (!Number.isFinite(midi)) return null;
        let best = null;
        for (let i = 0; i < tuning.length; i++) {
            const fret = midi - tuning[i];
            if (fret < 0 || fret > numFrets) continue;
            if (!best || fret < best.fret) {
                best = { string: i + 1, fret };
            }
        }
        return best;
    }

    /**
     * Hand-aware variant of `_resolveStringFret`. When the simulator
     * already knows where the hand sits, the resolver prefers a
     * fret INSIDE the hand's reach `[anchor, anchor + spanFrets]`
     * over open strings or out-of-window options — keeping the
     * hand actually following the music instead of drifting on a
     * long string of open notes and then making a huge jump.
     *
     * Score order (highest wins):
     *   1. In-window fretted (1000 − distance-from-anchor)
     *   2. Open string                                    (500)
     *   3. Out-of-window fretted (100 − distance-to-window)
     *
     * Tie-break: lower fret wins. Falls back to the lowest-fret
     * heuristic when `anchor` is null (= first chord).
     * @private
     */
    function _resolveStringFretWithContext(midi, tuning, numFrets,
                                              anchor, spanFrets) {
        if (!Array.isArray(tuning) || tuning.length === 0) return null;
        if (!Number.isFinite(midi)) return null;
        const useContext = Number.isFinite(anchor) && Number.isFinite(spanFrets) && spanFrets > 0;
        let best = null;
        let bestScore = -Infinity;
        for (let i = 0; i < tuning.length; i++) {
            const fret = midi - tuning[i];
            if (fret < 0 || fret > numFrets) continue;
            let score;
            if (useContext && fret > 0 && fret >= anchor && fret <= anchor + spanFrets) {
                // In-window fretted — top priority. Closer to anchor
                // = lower-numbered finger = preferred.
                score = 1000 - (fret - anchor);
            } else if (fret === 0) {
                // Open string — cheap (no finger) but only when no
                // in-window option beat it.
                score = 500;
            } else if (useContext) {
                // Outside the current window — penalty proportional
                // to how far we'd have to shift the hand.
                const dist = Math.min(
                    Math.abs(fret - anchor),
                    Math.abs(fret - (anchor + spanFrets))
                );
                score = 100 - dist;
            } else {
                // No anchor yet — prefer lowest fret (open position).
                score = 100 - fret;
            }
            if (score > bestScore || (score === bestScore && (!best || fret < best.fret))) {
                bestScore = score;
                best = { string: i + 1, fret };
            }
        }
        return best;
    }

    /**
     * Chord-level MIDI → (string, fret) resolver. Guarantees that
     * every assignment uses a UNIQUE string — physically a single
     * string can only sound one pitch at a time. Pre-tagged notes
     * (with explicit `string` + `fret`) reserve their string before
     * the unresolved ones are processed.
     *
     * The unresolved notes are walked from LOW pitch to HIGH so the
     * bass naturally lands on the lower strings (= the open chord
     * convention). For each note, we score the remaining viable
     * (string, fret) options with the same priority order as
     * `_resolveStringFretWithContext` (in-window > open > out-of-
     * window) and pick the best.
     *
     * Returns an array of `{string, fret} | null` aligned with
     * `notes`; `null` means no string was available (= the chord
     * has more notes than strings or every alternative is out of
     * range).
     * @private
     */
    function _resolveChordStringFret(notes, tuning, numFrets, anchor, spanFrets) {
        const N = notes.length;
        const result = new Array(N).fill(null);
        if (!Array.isArray(tuning) || tuning.length === 0) return result;
        const usedStrings = new Set();

        // Pre-tagged notes claim their string first.
        for (let i = 0; i < N; i++) {
            const n = notes[i];
            if (Number.isFinite(n.fret) && Number.isFinite(n.string)) {
                result[i] = { string: n.string, fret: n.fret };
                usedStrings.add(n.string);
            }
        }

        // Sort the unresolved indices by pitch ascending — assign
        // low pitches first so they land on the (typically) lower
        // strings.
        const unresolved = [];
        for (let i = 0; i < N; i++) {
            if (!result[i] && Number.isFinite(notes[i]?.note)) unresolved.push(i);
        }
        unresolved.sort((a, b) => notes[a].note - notes[b].note);

        const useContext = Number.isFinite(anchor) && Number.isFinite(spanFrets) && spanFrets > 0;
        for (const i of unresolved) {
            const midi = notes[i].note;
            let best = null;
            let bestScore = -Infinity;
            for (let s = 1; s <= tuning.length; s++) {
                if (usedStrings.has(s)) continue;
                const fret = midi - tuning[s - 1];
                if (fret < 0 || fret > numFrets) continue;
                let score;
                if (useContext && fret > 0 && fret >= anchor && fret <= anchor + spanFrets) {
                    score = 1000 - (fret - anchor);
                } else if (fret === 0) {
                    score = 500;
                } else if (useContext) {
                    const dist = Math.min(
                        Math.abs(fret - anchor),
                        Math.abs(fret - (anchor + spanFrets))
                    );
                    score = 100 - dist;
                } else {
                    score = 100 - fret;
                }
                if (score > bestScore || (score === bestScore && (!best || fret < best.fret))) {
                    bestScore = score;
                    best = { string: s, fret };
                }
            }
            if (best) {
                result[i] = best;
                usedStrings.add(best.string);
            }
        }
        return result;
    }

    if (typeof window !== 'undefined') {
        window.HandPositionFeasibility = {
            classify, renderBadge, aggregateByChannel,
            simulateHandWindows, findStringCandidates
        };
    }
})();
