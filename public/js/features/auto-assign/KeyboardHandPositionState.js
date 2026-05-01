/**
 * @file KeyboardHandPositionState.js
 * @description Central state container for the keyboard hand-position
 * editor. Owns the four sources of truth that used to be scattered
 * across the modal:
 *
 *   1. The list of hands (id, span, numFingers, color, current anchor)
 *      built from `instrument.hands_config` once at construction.
 *   2. The override schema (`hand_anchors`, `note_assignments`,
 *      `disabled_notes`) and its `HistoryManager` from
 *      `HandEditorShared`.
 *   3. The animated `displayedAnchors` map, lerped toward the
 *      simulation target by `step()`.
 *   4. The simulator timeline (per-hand trajectory) and its derived
 *      problem list / unplayable-note set, set externally via
 *      `setSimulationResult()`.
 *
 * The class is a *data store*: it does not draw, does not bind DOM
 * events, does not call the simulator. The modal stays in charge of
 * the orchestration — it calls the simulator, hands the raw events
 * to `setSimulationResult()`, drives the RAF loop via `step()`, and
 * pushes the resulting bands / anchors to the renderers.
 *
 * Centralising the writes through this class is the whole point: the
 * clamps (instrument range + neighbour ordering), the history pushes,
 * and the displayedAnchor reseed-after-undo all live in one place
 * instead of being duplicated across `_onHandBandDragLive`,
 * `_commitHandBandDrag`, `_reseedAnchorsFromOverrides`,
 * `_pinNoteAssignment`, etc.
 *
 * Public API:
 *
 *     const state = new KeyboardHandPositionState({
 *         instrument, notes, ticksPerSec,
 *         initialOverrides, lerpHalfLifeMs: 85
 *     });
 *
 *     // Read
 *     state.hands                       // immutable list
 *     state.range                       // {lo, hi}
 *     state.overrides                   // persisted snapshot
 *     state.problems                    // [{sec, kind}]
 *     state.unplayableSet               // Set<"tick:note">
 *     state.simulationTimeline          // Map<handId, [{sec, anchor, …}]>
 *     state.isDirty / canUndo / canRedo
 *     state.getAnchor(handId)
 *     state.getDisplayedAnchor(handId)
 *     state.targetAnchorAt(handId, atSec)
 *     state.currentBands()              // for KeyboardPreview.setHandBands
 *     state.activeNotesAt(currentSec)   // Set<midi>
 *     state.currentAssignments()        // Map<"tick:note", handId>
 *
 *     // Anchors (drag-driven writes)
 *     state.previewAnchor(handId, anchor)        // clamped, no history
 *     state.commitAnchor(handId, tick)           // persist + push history
 *     state.reseedAnchors()                      // re-pull from overrides
 *
 *     // Notes (popover-driven writes)
 *     state.setNoteAssignment(tick, note, handId)
 *     state.clearNoteAssignment(tick, note)
 *
 *     // Simulation
 *     state.setSimulationResult(rawTimeline)
 *
 *     // Animation
 *     state.step(dtSec, lookaheadSec, currentSec)  // returns stillMoving
 *
 *     // History
 *     state.pushHistory()
 *     state.undo()
 *     state.redo()
 *     state.reset()
 *     state.markSaved()
 *
 * History notifications go through the `onHistoryChange` callback
 * (set via the constructor) — it fires whenever `isDirty` /
 * `canUndo` / `canRedo` change. Other state mutations are
 * synchronous; the modal redraws right after the call.
 */
(function() {
    'use strict';

    /** Per-hand colour palette — must match HandsPreviewPanel's so
     *  the editor's bands have the same hue as the preview. Legacy
     *  left/right keep their historical mapping. */
    const HAND_COLORS = {
        left: '#3b82f6', right: '#10b981', fretting: '#f59e0b',
        h1: '#3b82f6', h2: '#10b981', h3: '#f59e0b', h4: '#8b5cf6'
    };
    function _handColor(id) { return HAND_COLORS[id] || '#6b7280'; }

    /** Parse `instrument.hands_config` from either a JSON string or a
     *  plain object; return null when it doesn't expose a hands array
     *  (legacy / fretted instruments). */
    function _parseHandsCfg(instrument) {
        let cfg = instrument && instrument.hands_config;
        if (typeof cfg === 'string') {
            try { cfg = JSON.parse(cfg); } catch (_) { return null; }
        }
        return cfg && Array.isArray(cfg.hands) ? cfg : null;
    }

    /** Pitch range covered by the editor — uses the instrument's
     *  declared `note_range_min/max` when set, otherwise pads the
     *  channel's note extrema by 2 semitones. Falls back to A0–C8. */
    function _pitchExtent(instrument, notes) {
        const lo = Number.isFinite(instrument && instrument.note_range_min)
            ? instrument.note_range_min : null;
        const hi = Number.isFinite(instrument && instrument.note_range_max)
            ? instrument.note_range_max : null;
        if (lo != null && hi != null && hi > lo) {
            return { lo: Math.max(0, lo), hi: Math.min(127, hi) };
        }
        if (!Array.isArray(notes) || notes.length === 0) {
            return { lo: 21, hi: 108 };
        }
        let mn = 127, mx = 0;
        for (const n of notes) {
            if (n.note < mn) mn = n.note;
            if (n.note > mx) mx = n.note;
        }
        return { lo: Math.max(0, mn - 2), hi: Math.min(127, mx + 2) };
    }

    class KeyboardHandPositionState {
        /**
         * @param {Object} opts
         * @param {Object} opts.instrument        - hands_config + note_range_*
         * @param {Array}  opts.notes             - raw notes for activeNotesAt
         * @param {number} opts.ticksPerSec       - tempo conversion
         * @param {Object} [opts.initialOverrides]- override schema preload
         * @param {number} [opts.lerpHalfLifeMs=85]
         * @param {Function} [opts.onHistoryChange] - called when dirty/undo/redo flips
         */
        constructor(opts = {}) {
            const Shared = (typeof window !== 'undefined' && window.HandEditorShared) || null;
            if (!Shared) {
                // Tests can stub HandEditorShared on globalThis; we
                // throw here so the editor's mount fails loudly
                // rather than producing a half-functional state.
                throw new Error('KeyboardHandPositionState requires window.HandEditorShared');
            }
            this._Shared = Shared;

            this.instrument = opts.instrument || null;
            this.notes = Array.isArray(opts.notes) ? opts.notes.slice() : [];
            this.ticksPerSec = Number.isFinite(opts.ticksPerSec) && opts.ticksPerSec > 0
                ? opts.ticksPerSec : 480;
            this.lerpHalfLifeMs = Number.isFinite(opts.lerpHalfLifeMs)
                && opts.lerpHalfLifeMs > 0 ? opts.lerpHalfLifeMs : 85;
            // Layout type ('piano' | 'chromatic') drives the visual
            // band width: piano hands cover only the white-key range
            // their fingers actually reach (= a tighter band that
            // lets two hands play consecutive notes without visual
            // collision), while chromatic hands stay at one slot per
            // semitone. Fall back to the instrument's hands_config
            // entry; chromatic by default for safety.
            const cfg = _parseHandsCfg(this.instrument);
            this.layout = (cfg && cfg.keyboard_type === 'piano') ? 'piano' : 'chromatic';

            this.range = _pitchExtent(this.instrument, this.notes);
            this.overrides = Shared.cloneOverrides(opts.initialOverrides) || Shared.emptyOverrides();
            this._history = new Shared.HistoryManager(this.overrides, {
                maxHistory: 50,
                onChange: () => {
                    if (typeof opts.onHistoryChange === 'function') {
                        opts.onHistoryChange();
                    }
                }
            });

            // Build the immutable hand list (anchor field is mutable
            // internally; everything else stays put for the editor's
            // lifetime).
            this.hands = this._buildHands();

            // Animated anchors. Seeded from the persisted anchors so
            // the very first frame draws bands at the right place.
            this._displayedAnchors = new Map();
            for (const h of this.hands) this._displayedAnchors.set(h.id, h.anchor);

            // Simulation outputs. Empty until `setSimulationResult`
            // runs the first time — `targetAnchorAt` falls back to
            // the static anchor in the meantime.
            this.simulationTimeline = new Map();
            this.problems = [];
            this.unplayableSet = new Set();
        }

        // -----------------------------------------------------------------
        //  Read accessors
        // -----------------------------------------------------------------

        get isDirty() { return this._history.isDirty; }
        get canUndo() { return this._history.canUndo; }
        get canRedo() { return this._history.canRedo; }

        getAnchor(handId) {
            const h = this._handById(handId);
            return h ? h.anchor : NaN;
        }

        getDisplayedAnchor(handId) {
            const v = this._displayedAnchors.get(handId);
            if (Number.isFinite(v)) return v;
            const h = this._handById(handId);
            return h ? h.anchor : NaN;
        }

        /** Bands ready to feed `KeyboardPreview.setHandBands`. Anchors
         *  are quantized to the nearest semitone — KeyboardPreview's
         *  `_xOf` indexes a sparse integer array, so a fractional
         *  anchor (mid-lerp) used to land on `undefined` and the
         *  band would silently jump or disappear. */
        currentBands() {
            return this.hands.map(h => {
                const a = this._displayedAnchors.get(h.id);
                const aInt = Math.round(Number.isFinite(a) ? a : h.anchor);
                const visualSpan = this._displaySpanFor(h, aInt);
                return { id: h.id, low: aInt, high: aInt + visualSpan, color: h.color };
            });
        }

        /** Visual span in semitones for hand `h` at `anchor`. The
         *  configured `hand.span` (= physical reach) drives the
         *  simulator's reachability checks but the BAND drawn on
         *  the keyboard widget should match what the fingers
         *  actually cover, so two hands can play consecutive notes
         *  without their bands visually colliding.
         *
         *    - piano: walk the white-key sequence the fingers
         *      overlay draws and return `lastWhite − firstWhite`.
         *    - chromatic: numFingers slots, one per semitone, so
         *      span = `numFingers − 1`.
         *
         *  Falls back to the configured span when the white
         *  walk runs short (anchor near the top of the MIDI range
         *  with too few whites available — exotic instrument).
         *  @private */
        _displaySpanFor(hand, anchor) {
            const numFingers = Number.isFinite(hand.numFingers) && hand.numFingers > 0
                ? Math.round(hand.numFingers)
                : Math.max(1, Math.round(hand.span) + 1);
            if (this.layout === 'piano') {
                const numWhites = Math.floor(numFingers / 2) + 1;
                const whites = this._whiteKeysFromAnchor(anchor, numWhites);
                if (whites.length >= 2) {
                    return whites[whites.length - 1] - whites[0];
                }
                return Math.max(1, numFingers - 1);
            }
            return Math.max(1, numFingers - 1);
        }

        /** Walk MIDI from `startMidi` upward, picking `count` whites
         *  in a row. Used by `_displaySpanFor` (and the fingers
         *  renderer mirror). @private */
        _whiteKeysFromAnchor(startMidi, count) {
            const out = [];
            const isBlack = (m) => {
                const v = ((m % 12) + 12) % 12;
                return v === 1 || v === 3 || v === 6 || v === 8 || v === 10;
            };
            let m = Math.max(0, Math.round(startMidi));
            if (isBlack(m)) m++;
            while (out.length < count && m <= 127) {
                if (!isBlack(m)) out.push(m);
                m++;
            }
            return out;
        }

        /** Set of MIDI notes sounding at `currentSec` — short-circuits
         *  the duration check on negative results so it stays cheap on
         *  long files. */
        activeNotesAt(currentSec) {
            const out = new Set();
            const t = (currentSec || 0) * this.ticksPerSec;
            for (const n of this.notes) {
                if (n.tick > t) continue;
                const dur = Number.isFinite(n.duration) ? n.duration : 0;
                if (n.tick + dur > t) out.add(n.note);
            }
            return out;
        }

        /** Map<"tick:note", handId> from the persisted note assignments. */
        currentAssignments() {
            const out = new Map();
            const list = (this.overrides && this.overrides.note_assignments) || [];
            for (const a of list) {
                if (a && a.handId) out.set(`${a.tick}:${a.note}`, a.handId);
            }
            return out;
        }

        /** Step lookup: latest `{sec, anchor}` whose sec ≤ `atSec` in
         *  the simulator timeline. Falls back to the live anchor when
         *  the timeline is empty (early frames or hands the simulator
         *  never visited). */
        targetAnchorAt(handId, atSec) {
            const series = this.simulationTimeline.get(handId);
            if (!series || series.length === 0) {
                return this.getAnchor(handId);
            }
            let best = series[0].anchor;
            for (const s of series) {
                if (s.sec > atSec) break;
                best = s.anchor;
            }
            return best;
        }

        // -----------------------------------------------------------------
        //  Anchor writes (drag path)
        // -----------------------------------------------------------------

        /** Live update during a band drag. Clamps against the
         *  instrument's range AND against the immediate neighbours so
         *  hands cannot cross or stick out of the keyboard. Updates
         *  the displayed anchor immediately for visual feedback but
         *  does NOT push history (the commit handles that — keeps
         *  one history entry per drag, not one per pixel). */
        previewAnchor(handId, newAnchor) {
            const idx = this._handIdxById(handId);
            if (idx < 0) return NaN;
            const hand = this.hands[idx];
            const clamped = this._clampAnchor(idx, newAnchor);
            hand.anchor = clamped;
            this._displayedAnchors.set(handId, clamped);
            return clamped;
        }

        /** End-of-drag: persist the current anchor as a `hand_anchors`
         *  override entry at `tick`, push one history snapshot, return
         *  the stored value. */
        commitAnchor(handId, tick) {
            const hand = this._handById(handId);
            if (!hand) return NaN;
            if (!Array.isArray(this.overrides.hand_anchors)) {
                this.overrides.hand_anchors = [];
            }
            const list = this.overrides.hand_anchors;
            const i = list.findIndex(a => a && a.handId === handId && a.tick === tick);
            const entry = { tick, handId, anchor: hand.anchor };
            if (i >= 0) list[i] = entry; else list.push(entry);
            this.pushHistory();
            return hand.anchor;
        }

        /** Re-pull each hand's anchor from the latest `hand_anchors`
         *  override at the current playhead, falling back to the
         *  deterministic seed when no override exists. Snaps the
         *  matching `_displayedAnchors` so the visual jumps with the
         *  data instead of lerping for ~85 ms. Used after undo / redo
         *  / reset and at mount when overrides exist. */
        reseedAnchors() {
            const cfg = _parseHandsCfg(this.instrument);
            const total = (cfg && cfg.hands && cfg.hands.length) || this.hands.length;
            for (let i = 0; i < this.hands.length; i++) {
                const h = this.hands[i];
                const anchor = this._initialAnchorFor(h, i, total);
                h.anchor = anchor;
                this._displayedAnchors.set(h.id, anchor);
            }
        }

        // -----------------------------------------------------------------
        //  Note-assignment writes (popover path)
        // -----------------------------------------------------------------

        setNoteAssignment(tick, note, handId) {
            if (!Array.isArray(this.overrides.note_assignments)) {
                this.overrides.note_assignments = [];
            }
            const list = this.overrides.note_assignments;
            const i = list.findIndex(a => a.tick === tick && a.note === note);
            const entry = { tick, note, handId };
            if (i >= 0) list[i] = entry; else list.push(entry);
            this.pushHistory();
        }

        clearNoteAssignment(tick, note) {
            const list = this.overrides && this.overrides.note_assignments;
            if (!Array.isArray(list)) return;
            const i = list.findIndex(a => a.tick === tick && a.note === note);
            if (i < 0) return;
            list.splice(i, 1);
            this.pushHistory();
        }

        // -----------------------------------------------------------------
        //  Simulation hookup
        // -----------------------------------------------------------------

        /** Take the raw event timeline produced by
         *  `HandPositionFeasibility.simulateHandWindows` and break it
         *  into per-hand trajectories (`simulationTimeline`), the
         *  unplayable-note set, and the problem list — three
         *  derived views the editor consumes separately. */
        setSimulationResult(timeline) {
            const tps = this.ticksPerSec;
            const seriesBy = new Map();
            const problems = [];
            const unplayable = new Set();
            const ensure = (id) => {
                if (!seriesBy.has(id)) seriesBy.set(id, []);
                return seriesBy.get(id);
            };

            for (const ev of timeline || []) {
                if (ev.type === 'shift' && ev.handId && Number.isFinite(ev.toAnchor)) {
                    const sec = ev.tick / tps;
                    let dur = NaN;
                    if (ev.motion && Number.isFinite(ev.motion.requiredSec) && ev.motion.requiredSec > 0) {
                        dur = ev.motion.requiredSec;
                    } else if (ev.motion && Number.isFinite(ev.motion.availableSec)
                            && ev.motion.availableSec > 0 && ev.motion.availableSec !== Infinity) {
                        dur = ev.motion.availableSec;
                    }
                    if (!Number.isFinite(dur) || dur <= 0) dur = 0.15;
                    ensure(ev.handId).push({
                        sec,
                        anchor: ev.toAnchor,
                        fromSec: Math.max(0, sec - dur),
                        fromAnchor: Number.isFinite(ev.fromAnchor) ? ev.fromAnchor : ev.toAnchor,
                        feasible: ev.motion ? ev.motion.feasible !== false : true
                    });
                    if (ev.motion && ev.motion.feasible === false) {
                        problems.push({ sec, kind: 'speed' });
                    }
                } else if (ev.type === 'chord') {
                    const anchorByHand = ev.anchorByHand;
                    if (anchorByHand && typeof anchorByHand === 'object') {
                        for (const id of Object.keys(anchorByHand)) {
                            const a = anchorByHand[id];
                            if (Number.isFinite(a)) {
                                ensure(id).push({ sec: ev.tick / tps, anchor: a });
                            }
                        }
                    } else if (Array.isArray(ev.notes)) {
                        const lowestByHand = new Map();
                        for (const n of ev.notes) {
                            if (!n.handId || !Number.isFinite(n.note)) continue;
                            const cur = lowestByHand.get(n.handId);
                            if (cur == null || n.note < cur) lowestByHand.set(n.handId, n.note);
                        }
                        for (const [id, lo] of lowestByHand) {
                            ensure(id).push({ sec: ev.tick / tps, anchor: lo });
                        }
                    }
                    if (Array.isArray(ev.unplayable) && ev.unplayable.length > 0) {
                        problems.push({ sec: ev.tick / tps, kind: 'chord' });
                        for (const u of ev.unplayable) {
                            if (Number.isFinite(u.note)) unplayable.add(`${ev.tick}:${u.note}`);
                        }
                    }
                }
            }

            for (const arr of seriesBy.values()) arr.sort((a, b) => a.sec - b.sec);
            problems.sort((a, b) => a.sec - b.sec);

            this.simulationTimeline = seriesBy;
            this.problems = problems;
            this.unplayableSet = unplayable;
        }

        // -----------------------------------------------------------------
        //  Animation step
        // -----------------------------------------------------------------

        /** Pull each `_displayedAnchors[id]` toward the simulation
         *  target at `currentSec + lookaheadSec * 0.5` (lookahead so
         *  the hands anticipate upcoming notes, like a real player
         *  reading the score). Decay is computed from the wall-clock
         *  delta so the motion stays cross-monitor consistent —
         *  ~`lerpHalfLifeMs` half-life regardless of frame rate.
         *  Returns `true` while at least one band is still moving so
         *  the caller can keep its RAF loop spinning. */
        step(dtSec, lookaheadSec, currentSec) {
            if (this.hands.length === 0) return false;
            const lookSec = (currentSec || 0) + (lookaheadSec || 4) * 0.5;
            const k = Math.LN2 / (this.lerpHalfLifeMs / 1000);
            const blend = 1 - Math.exp(-k * Math.max(0, dtSec || 0));
            let stillMoving = false;
            for (const hand of this.hands) {
                const target = this.targetAnchorAt(hand.id, lookSec);
                if (!Number.isFinite(target)) continue;
                const cur = this._displayedAnchors.get(hand.id);
                const start = Number.isFinite(cur) ? cur : hand.anchor;
                const gap = target - start;
                if (Math.abs(gap) < 0.05) {
                    this._displayedAnchors.set(hand.id, target);
                    continue;
                }
                this._displayedAnchors.set(hand.id, start + gap * blend);
                stillMoving = true;
            }
            return stillMoving;
        }

        // -----------------------------------------------------------------
        //  History
        // -----------------------------------------------------------------

        pushHistory() {
            this._history.push(this.overrides);
        }

        undo() {
            const snap = this._history.undo();
            if (!snap) return false;
            this.overrides = snap;
            this.reseedAnchors();
            return true;
        }

        redo() {
            const snap = this._history.redo();
            if (!snap) return false;
            this.overrides = snap;
            this.reseedAnchors();
            return true;
        }

        /** Drop every override and resnap the bands to their seed
         *  positions. Pushes a history entry so the user can undo
         *  the reset itself. */
        reset() {
            this.overrides = this._Shared.emptyOverrides();
            this.reseedAnchors();
            this.pushHistory();
        }

        markSaved() {
            this._history.markSaved();
        }

        // -----------------------------------------------------------------
        //  Internals
        // -----------------------------------------------------------------

        _handById(id) { return this.hands.find(h => h.id === id) || null; }
        _handIdxById(id) { return this.hands.findIndex(h => h.id === id); }

        /** Build the hand list once at construction. Each entry's
         *  `anchor` field stays mutable for the editor's lifetime;
         *  span / numFingers / colour are immutable. */
        _buildHands() {
            const cfg = _parseHandsCfg(this.instrument);
            const hands = (cfg && cfg.hands ? cfg.hands : []).map((h, i, all) => {
                let span;
                if (Number.isFinite(h.hand_span_semitones)) {
                    span = h.hand_span_semitones;
                } else if (Number.isFinite(h.num_fingers)) {
                    span = Math.max(1, h.num_fingers - 1);
                } else {
                    span = 4;
                }
                const numFingers = Number.isFinite(h.num_fingers) && h.num_fingers > 0
                    ? h.num_fingers : (span + 1);
                const id = h.id || `h${i + 1}`;
                return {
                    id,
                    span,
                    numFingers,
                    color: _handColor(id),
                    anchor: NaN  // assigned below via _initialAnchorFor
                };
            });
            const total = hands.length;
            for (let i = 0; i < hands.length; i++) {
                hands[i].anchor = this._initialAnchorFor(hands[i], i, total);
            }
            return hands;
        }

        /** Initial anchor for hand `i` of `total`: latest override at
         *  tick 0 if any, else the deterministic seed (hands spread
         *  across the instrument range), then clamped into the
         *  playable window so a legacy override saved before the
         *  drag-clamp fix can't initialise a hand off-screen. */
        _initialAnchorFor(hand, i, total) {
            const ext = this.range;
            const seed = ext.lo + Math.round(((i + 0.5) / Math.max(1, total))
                * (ext.hi - ext.lo - hand.span));
            const overrideAnchor = this._latestAnchorOverride(hand.id);
            const raw = Number.isFinite(overrideAnchor) ? overrideAnchor : seed;
            return Math.max(ext.lo, Math.min(ext.hi - hand.span, raw));
        }

        /** Most recent `hand_anchors` entry for `handId` whose tick
         *  ≤ 0 (= the seed at the start of the song). Returns null
         *  when no override is recorded for this hand. */
        _latestAnchorOverride(handId) {
            const list = this.overrides && this.overrides.hand_anchors;
            if (!Array.isArray(list)) return null;
            let best = null;
            for (const a of list) {
                if (!a || a.handId !== handId || !Number.isFinite(a.tick)) continue;
                if (a.tick > 0) continue;
                if (!best || a.tick > best.tick) best = a;
            }
            return best ? best.anchor : null;
        }

        /** Clamp an anchor against the instrument range AND the
         *  neighbouring hands. Single-axis constraint: hands share
         *  one physical axis on the keyboard so they cannot cross
         *  each other and must not overlap. */
        _clampAnchor(idx, newAnchor) {
            const hand = this.hands[idx];
            const prev = idx > 0 ? this.hands[idx - 1] : null;
            const next = idx < this.hands.length - 1 ? this.hands[idx + 1] : null;
            const ext = this.range;
            // Use the VISUAL span (= what the fingers cover on the
            // keyboard widget) for the neighbour clamp so two hands
            // can sit side-by-side at consecutive white keys without
            // their bands visually colliding. Falls back to the
            // configured span at the keyboard's edges.
            const prevSpan = prev ? this._displaySpanFor(prev, prev.anchor) : 0;
            const handSpan = this._displaySpanFor(hand, newAnchor);
            const minAnchor = prev ? prev.anchor + prevSpan : ext.lo;
            const maxAnchor = next ? next.anchor - handSpan : ext.hi - handSpan;
            return Math.max(minAnchor, Math.min(maxAnchor, newAnchor));
        }
    }

    if (typeof window !== 'undefined') {
        window.KeyboardHandPositionState = KeyboardHandPositionState;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { KeyboardHandPositionState };
    }
})();
