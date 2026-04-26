/**
 * @file src/midi/adaptation/HandPositionPlanner.js
 * @description Plan hand-position CC events for an instrument whose
 * `hands_config` has been resolved by the {@link HandAssigner}.
 *
 * Input : an ordered list of note events already tagged with `hand`
 *         (e.g. "left" | "right" for keyboards, "fretting" for strings)
 *         and optional `track`. For string instruments (unit: 'frets')
 *         each note also carries `fretPosition` (the absolute fret the
 *         tablature converter chose, capo included).
 * Output: a list of CC events ready to be merged back into the playback
 *         timeline, plus a feasibility report the UI can show to the
 *         operator (non-blocking warnings).
 *
 * CC semantics:
 *   - Controller number = `hand.cc_position_number` (e.g. 22/23/24).
 *   - Value in 'semitones' mode = MIDI note number of the LOWEST note
 *                                 in the current reachable window.
 *   - Value in 'frets' mode     = absolute fret number (0 = open) of
 *                                 the LOWEST fret in the current
 *                                 reachable window of the fretting hand.
 *     Raw, no scaling or offset. The hardware controller interprets
 *     this as "move the mechanical hand so its leftmost finger sits
 *     on this position".
 *
 * Two units supported, selected by `instrumentContext.unit`:
 *   - 'semitones' (default): keyboard-family. Per-hand `hand_span_semitones`,
 *     root `hand_move_semitones_per_sec`. Window is a semitone range on the
 *     MIDI note axis.
 *   - 'frets':               string-family (plucked, bowed, fretless).
 *     Per-hand `hand_span_frets`, root `hand_move_frets_per_sec`. Window
 *     is a fret range on the fingerboard axis. The input value is
 *     `note.fretPosition` (not `note.note`), which is supplied by the
 *     caller from persisted tablature data. Open-string events
 *     (`fretPosition === 0`) should be filtered upstream — the planner
 *     treats them like any other position value but callers typically
 *     skip them so open strings don't force a shift.
 *
 * Simplified per-hand model (semitones mode): each hand stores
 * `cc_position_number` and `hand_span_semitones`. The reachable note
 * range is derived from the instrument's `note_range_min`/`note_range_max`;
 * the minimum gap between notes comes from the instrument's
 * `min_note_interval`; the mechanical travel speed is shared across
 * both hands (`hands_config.hand_move_semitones_per_sec`).
 *
 * Simplified per-hand model (frets mode): a single hand entry with
 * `cc_position_number` and `hand_span_frets`. The reachable fret range
 * is `[0, maxFret]` supplied via `instrumentContext.noteRangeMin`/`Max`
 * (which the MidiPlayer computes from the string instrument's
 * `frets_per_string`). Travel speed is
 * `hands_config.hand_move_frets_per_sec`.
 *
 * Emission timing (the "as early as possible" rule):
 *   When a new window is needed (a note falls outside the current one),
 *   the CC is scheduled at `last_note_on_in_prev_window + EPSILON`. This
 *   gives the mechanical hand the maximum available travel time. For the
 *   very first note of each hand, the CC is emitted just before it
 *   (`t_first - EPSILON`) so the hand is pre-positioned on file start.
 *
 * Warning codes (all non-blocking):
 *   - `move_too_fast`            — travel speed too slow for the shift.
 *   - `finger_interval_violated` — gap between two notes on the same hand < instrument's `min_note_interval`.
 *   - `out_of_range`             — note/fret outside the instrument's playable range.
 *   - `chord_span_exceeded`      — chord width > hand span (forced shift; one note may still be uncomfortable).
 *
 * Warning messages carry the unit label ("semitones"/"frets") to match
 * the active mode.
 */

const EPSILON_SECONDS = 0.0001;
/** Group simultaneous notes within this time tolerance (seconds). */
const CHORD_GROUPING_TOLERANCE = 0.002;

class HandPositionPlanner {
  /**
   * @param {Object} handsConfig - Validated `hands_config` payload.
   * @param {number} [handsConfig.hand_move_semitones_per_sec] - Shared travel speed (semitones mode).
   * @param {number} [handsConfig.hand_move_frets_per_sec] - Shared travel speed (frets mode).
   * @param {Array<{id:string, cc_position_number:number,
   *                hand_span_semitones?:number,
   *                hand_span_frets?:number}>} handsConfig.hands
   * @param {Object} [instrumentContext] - Fields pulled from the owning
   *   instrument's capabilities. All optional; when absent the matching
   *   check is skipped (preserves pre-feature behavior).
   * @param {'semitones'|'frets'} [instrumentContext.unit='semitones'] - Axis
   *   unit. 'semitones' reads `note.note`; 'frets' reads `note.fretPosition`.
   * @param {number} [instrumentContext.noteRangeMin] - Lowest playable value
   *   on the axis (MIDI note in semitones mode, fret number in frets mode).
   * @param {number} [instrumentContext.noteRangeMax] - Highest playable value
   *   on the axis.
   * @param {number} [instrumentContext.minNoteIntervalMs] - Min gap between
   *   consecutive notes on the same hand (milliseconds). 0 or null disables
   *   the `finger_interval_violated` warning.
   */
  constructor(handsConfig, instrumentContext) {
    this.config = handsConfig || {};
    this.ctx = instrumentContext || {};
    this.unit = this.ctx.unit === 'frets' ? 'frets' : 'semitones';
    this.handById = new Map();
    for (const h of (this.config.hands || [])) {
      this.handById.set(h.id, h);
    }

    // Mechanism discriminator (frets-mode only). The window-based
    // planning logic is shared between `string_sliding_fingers` and
    // `fret_sliding_fingers` for V1 — both produce the same CC22
    // sequence (lowest fret of the reachable window). The difference
    // is in how the hardware interprets the CC: the same value is sent,
    // the actuators react differently. `independent_fingers` is V2 and
    // explicitly rejected here so a config that slipped past validation
    // never produces a nonsense CC stream.
    this.mechanism = this.unit === 'frets'
      ? (this.config.mechanism || 'string_sliding_fingers')
      : null;
    if (this.mechanism === 'independent_fingers') {
      throw new Error(
        'HandPositionPlanner: mechanism "independent_fingers" is reserved for V2 and not yet implemented'
      );
    }

    // Physical mode is active when frets-unit AND both scale length and
    // hand width (mm) are known. It supersedes the constant-frets-window
    // model with a position-dependent reach derived from equal-temperament
    // geometry. When any required input is missing, we fall back to the
    // constant-frets model — same behavior as before this feature.
    this._physical = this._maybeBuildPhysical();
  }

  /** @private */
  _maybeBuildPhysical() {
    if (this.unit !== 'frets') return null;
    const L = this.ctx.scaleLengthMm;
    if (!Number.isFinite(L) || L <= 0) return null;
    // Per-hand span_mm (could differ between hands in theory; in practice
    // frets-mode has a single 'fretting' hand). We resolve lazily because
    // _spanAt needs the hand object.
    const moveMmPerSec = this.config.hand_move_mm_per_sec;
    if (!Number.isFinite(moveMmPerSec) || moveMmPerSec <= 0) {
      // Speed in mm is required to make the physical travel computation
      // meaningful. Without it the planner would mix mm-window with
      // frets-speed which would give nonsense move_too_fast warnings.
      return null;
    }
    // Index-finger backoff: when the chord's lowest fret is F, the
    // index finger sits `INDEX_BACKOFF_MM` behind F so it can press F
    // comfortably and still reach more frets up the neck. The same
    // rule applies whether F is fret 1 or fret 7 — the hand simply
    // shifts forward as the music moves up. Setting the back-off in
    // millimetres makes the rule scale-length-independent.
    return { L, moveMmPerSec, indexBackoffMm: 10 };
  }

  /**
   * Anchor (in fret-equivalent) that places the index finger
   * `indexBackoffMm` behind `targetFret`. The result is a non-negative
   * fret number (clamped at 0 = nut) so the index never falls past
   * the nut. Outside physical mode it returns `targetFret` unchanged.
   * @private
   */
  _anchorBehindFret(targetFret) {
    if (!this._physical) return targetFret;
    const L = this._physical.L;
    const targetMm = L * (1 - Math.pow(2, -targetFret / 12));
    const anchorMm = Math.max(0, targetMm - this._physical.indexBackoffMm);
    if (anchorMm <= 0) return 0;
    return -12 * Math.log2(1 - anchorMm / L);
  }

  /**
   * Distance in millimetres between two fret positions on a scale of
   * length L (mm). Equal-temperament geometry: fret n sits at
   * `L · (1 − 2^(−n/12))` from the nut, so the gap shrinks geometrically
   * the further you go up the neck.
   * @private
   */
  _fretDistanceMm(a, b) {
    const L = this._physical.L;
    return L * (Math.pow(2, -a / 12) - Math.pow(2, -b / 12));
  }

  /**
   * Highest fret reachable from anchor `p` with a hand of width `s` mm.
   * Solved from `posFromNut(maxReach) − posFromNut(p) = s`. If the hand
   * is wide enough to cover everything above `p` (would require crossing
   * the bridge), we return `+Infinity` and the caller clamps to the
   * instrument range.
   * @private
   */
  _maxReachFromMm(p, s) {
    const L = this._physical.L;
    const term = Math.pow(2, -p / 12) - s / L;
    if (term <= 0) return Number.POSITIVE_INFINITY;
    return -12 * Math.log2(term);
  }

  /**
   * Lowest anchor `p` that still fits a chord whose top note sits on
   * fret `q`, with a hand of width `s` mm. Inverse of `_maxReachFromMm`.
   * Negative results are clamped to 0 (open-string side of the nut).
   * @private
   */
  _minAnchorForTopMm(q, s) {
    const L = this._physical.L;
    const v = Math.pow(2, -q / 12) + s / L;
    const p = -12 * Math.log2(v);
    return p < 0 ? 0 : p;
  }

  /**
   * Span (in axis units) reachable from anchor `p` with the given hand.
   * In physical mode the value depends on `p` (geometric fret spacing);
   * otherwise it's a constant fallback per-hand.
   * @private
   */
  _spanAt(hand, p) {
    if (this._physical) {
      const s = hand.hand_span_mm;
      if (Number.isFinite(s) && s > 0) {
        const top = this._maxReachFromMm(p, s);
        return top - p;
      }
    }
    if (this.unit === 'frets') return hand.hand_span_frets ?? 4;
    return hand.hand_span_semitones ?? 14;
  }

  /** @private */
  _commonSpeed() {
    if (this.unit === 'frets') return this.config.hand_move_frets_per_sec || 12;
    return this.config.hand_move_semitones_per_sec || 60;
  }

  /** @private Extract the axis value (MIDI note or fret position). */
  _axisValue(n) {
    if (this.unit === 'frets') return n.fretPosition;
    return n.note;
  }

  /**
   * Produce hand-position CC events for a sequence of note events.
   *
   * @param {Array<{time:number, note:number, channel:number,
   *                velocity?:number, hand:string, fretPosition?:number}>} notes
   *   Note-ons only, sorted by `time`. `velocity === 0` notes are
   *   ignored (they are logical note-offs). In 'frets' mode each note
   *   must carry `fretPosition`; events without it are skipped.
   * @returns {{ ccEvents: Array<Object>, warnings: Array<Object>,
   *             stats: { shifts: Record<string, number> } }}
   */
  plan(notes) {
    const ccEvents = [];
    const warnings = [];
    const stats = { shifts: {} };

    if (!Array.isArray(notes) || notes.length === 0) {
      return { ccEvents, warnings, stats };
    }

    // Per-hand planning state. Independent across hands — events are
    // interleaved globally but shifts for left vs right are uncorrelated.
    const state = new Map();
    for (const id of this.handById.keys()) {
      state.set(id, {
        windowLowest: null,       // MIDI note of current lowest reachable
        lastNoteOnTime: null,     // last note-on time inside current window
        lastSingleNoteOnTime: null, // for finger-interval check (ignores chord clumping)
        firstCCEmitted: false
      });
      stats.shifts[id] = 0;
    }

    // Group simultaneous notes per hand into chords.
    const groups = this._groupByHandAndTime(notes);

    const instrumentMin = this.ctx.noteRangeMin;
    const instrumentMax = this.ctx.noteRangeMax;
    const commonSpeed = this._commonSpeed();
    const minIntervalMs = this.ctx.minNoteIntervalMs ?? 0;
    const unitLabel = this.unit === 'frets' ? 'frets' : 'semitones';
    const axisLabel = this.unit === 'frets' ? 'Fret' : 'Note';

    for (const g of groups) {
      const hand = this.handById.get(g.hand);
      if (!hand) continue; // unknown hand id — skip defensively
      const s = state.get(g.hand);

      // Out-of-range check per note, against the instrument's playable range.
      for (const nIdx of g.notes) {
        const n = notes[nIdx];
        const axisVal = this._axisValue(n);
        if (axisVal == null) continue;
        if (instrumentMin != null && axisVal < instrumentMin) {
          warnings.push({
            time: n.time, hand: g.hand, note: n.note,
            code: 'out_of_range',
            message: `${axisLabel} ${axisVal} < instrument range min ${instrumentMin}`
          });
        }
        if (instrumentMax != null && axisVal > instrumentMax) {
          warnings.push({
            time: n.time, hand: g.hand, note: n.note,
            code: 'out_of_range',
            message: `${axisLabel} ${axisVal} > instrument range max ${instrumentMax}`
          });
        }
      }

      // Chord span check + window decision.
      const groupLow = g.low;
      const groupHigh = g.high;
      const span = this._spanAt(hand, groupLow);

      if (this._physical && Number.isFinite(hand.hand_span_mm) && hand.hand_span_mm > 0) {
        // Physical mode: compare actual mm distance, not fret count.
        const chordMm = this._fretDistanceMm(groupLow, groupHigh);
        if (chordMm > hand.hand_span_mm) {
          const approxFretsAtAnchor = this._maxReachFromMm(groupLow, hand.hand_span_mm) - groupLow;
          warnings.push({
            time: g.time, hand: g.hand, note: null,
            code: 'chord_span_exceeded',
            spanMm: Math.round(chordMm),
            handMm: hand.hand_span_mm,
            approxFrets: Number(approxFretsAtAnchor.toFixed(1)),
            atFret: groupLow,
            message: `Chord span ${Math.round(chordMm)} mm > hand ${hand.hand_span_mm} mm — ~${approxFretsAtAnchor.toFixed(1)} frets at fret ${groupLow}`
          });
        }
      } else {
        const groupSpan = groupHigh - groupLow;
        if (groupSpan > span) {
          warnings.push({
            time: g.time, hand: g.hand, note: null,
            code: 'chord_span_exceeded',
            message: `Chord span ${groupSpan} ${unitLabel} > hand span ${span} ${unitLabel}`
          });
        }
      }

      // Per-mechanism finger-count check (frets mode only). Open strings
      // (fret 0) don't press a string against the fretboard so they don't
      // consume a finger — exclude them from the count. Non-blocking:
      // the planner still emits a CC even when too many fingers are
      // demanded, but it surfaces a warning.
      //
      //   - string_sliding_fingers: 1 finger per string → cap is `max_fingers`.
      //   - fret_sliding_fingers:   1 finger per fret-offset → cap is `num_fingers`.
      if (this.unit === 'frets') {
        const fingerCap = this.mechanism === 'fret_sliding_fingers'
          ? (Number.isFinite(hand.num_fingers) && hand.num_fingers > 0 ? hand.num_fingers : null)
          : (Number.isFinite(hand.max_fingers) && hand.max_fingers > 0 ? hand.max_fingers : null);
        if (fingerCap != null) {
          let frettedCount = 0;
          for (const nIdx of g.notes) {
            const f = notes[nIdx].fretPosition;
            if (Number.isFinite(f) && f > 0) frettedCount++;
          }
          if (frettedCount > fingerCap) {
            warnings.push({
              time: g.time, hand: g.hand, note: null,
              code: 'too_many_fingers',
              count: frettedCount,
              limit: fingerCap,
              message: `Chord requires ${frettedCount} fingers, hand has ${fingerCap}`
            });
          }
        }
      }

      // Need a shift if: no window yet, or any note falls outside current window.
      const currentSpan = s.windowLowest != null ? this._spanAt(hand, s.windowLowest) : null;
      const needShift = s.windowLowest == null
        || groupLow < s.windowLowest
        || groupHigh > s.windowLowest + currentSpan;

      if (needShift) {
        // Anchor the new window. The PREFERRED anchor sits 10 mm behind
        // the chord's lowest fret so the index finger has room to press
        // it without the fingertip hanging past the slot. When the
        // chord's high note doesn't fit in `[idealLow, idealLow + span]`
        // we slide the anchor forward (`_minAnchorForTopMm`), losing
        // some of the back-off — but still picking the smallest anchor
        // that fits the chord, so the rest of the hand stays as low as
        // possible.
        const idealLow = this._anchorBehindFret(groupLow);
        let newLow;
        if (s.windowLowest == null) {
          newLow = idealLow;
        } else if (groupLow < s.windowLowest) {
          newLow = idealLow;
        } else if (this._physical && Number.isFinite(hand.hand_span_mm) && hand.hand_span_mm > 0) {
          newLow = Math.max(idealLow, this._minAnchorForTopMm(groupHigh, hand.hand_span_mm));
        } else {
          newLow = Math.max(idealLow, groupHigh - span);
        }

        // Clamp the anchor to the instrument's playable range so the CC
        // we send is always a position the hand can actually reach. The
        // note itself may still be out-of-range (reported separately).
        // Top-clamp guarantees the bottom of the hand
        // (= anchor + handSpan) never extends past the last fret.
        const newSpan = this._spanAt(hand, newLow);
        if (instrumentMin != null && newLow < instrumentMin) {
          newLow = instrumentMin;
        }
        if (instrumentMax != null && newLow + newSpan > instrumentMax) {
          // Slide the window down so its high edge fits inside the
          // playable range. After this point the hand's furthest reach
          // sits exactly on the last fret.
          if (this._physical && Number.isFinite(hand.hand_span_mm) && hand.hand_span_mm > 0) {
            newLow = Math.max(instrumentMin ?? 0, this._minAnchorForTopMm(instrumentMax, hand.hand_span_mm));
          } else {
            newLow = Math.max(instrumentMin ?? 0, instrumentMax - newSpan);
          }
        }

        // Emit CC as early as possible.
        let ccTime;
        if (!s.firstCCEmitted) {
          // Initial placement: just before the first note of this hand.
          ccTime = g.time - EPSILON_SECONDS;
        } else {
          // Right after the last note-on of the previous window.
          ccTime = (s.lastNoteOnTime ?? g.time) + EPSILON_SECONDS;
          // Feasibility: enough time to physically move?
          if (this._physical) {
            const travelMm = Math.abs(this._fretDistanceMm(
              Math.min(s.windowLowest, newLow),
              Math.max(s.windowLowest, newLow)
            ));
            const requiredSec = travelMm / this._physical.moveMmPerSec;
            const availableSec = g.time - ccTime;
            if (requiredSec > availableSec) {
              warnings.push({
                time: g.time, hand: g.hand, note: null,
                code: 'move_too_fast',
                travelMm: Math.round(travelMm),
                requiredMs: Math.round(requiredSec * 1000),
                availableMs: Math.round(availableSec * 1000),
                message: `Shift ${Math.round(travelMm)} mm needs ${(requiredSec * 1000).toFixed(0)}ms, only ${(availableSec * 1000).toFixed(0)}ms available`
              });
            }
          } else {
            const travelUnits = Math.abs(newLow - s.windowLowest);
            const requiredSec = travelUnits / commonSpeed;
            const availableSec = g.time - ccTime;
            if (requiredSec > availableSec) {
              warnings.push({
                time: g.time, hand: g.hand, note: null,
                code: 'move_too_fast',
                message: `Shift ${travelUnits} ${unitLabel} needs ${(requiredSec * 1000).toFixed(0)}ms, only ${(availableSec * 1000).toFixed(0)}ms available`
              });
            }
          }
        }

        ccEvents.push({
          time: ccTime,
          type: 'controller',
          channel: notes[g.notes[0]].channel,
          controller: hand.cc_position_number,
          value: clamp7bit(newLow),
          hand: g.hand
        });

        s.windowLowest = newLow;
        s.firstCCEmitted = true;
        stats.shifts[g.hand]++;
      }

      // Finger-interval check between consecutive single-note events on
      // the same hand (chord-internal simultaneity does not count). The
      // minimum gap is the instrument-wide `min_note_interval`.
      if (g.notes.length === 1) {
        if (s.lastSingleNoteOnTime != null && minIntervalMs > 0) {
          const deltaMs = (g.time - s.lastSingleNoteOnTime) * 1000;
          if (deltaMs < minIntervalMs) {
            warnings.push({
              time: g.time, hand: g.hand, note: null,
              code: 'finger_interval_violated',
              message: `Gap ${deltaMs.toFixed(0)}ms < min ${minIntervalMs}ms between notes`
            });
          }
        }
        s.lastSingleNoteOnTime = g.time;
      }

      s.lastNoteOnTime = g.time;
    }

    return { ccEvents, warnings, stats };
  }

  /**
   * Bucket note-ons per (hand, near-simultaneous time). Groups from
   * different hands are independent — they are emitted in the order of
   * their time stamps so the downstream state machine sees a coherent
   * global timeline. Within a hand, simultaneous notes form a chord.
   * @private
   */
  _groupByHandAndTime(notes) {
    // Bucket by hand first so simultaneous same-hand notes always merge
    // even when interleaved with the other hand in the source list.
    // Notes whose axis value is null (e.g. frets mode without fretPosition)
    // are skipped so they don't poison `low`/`high`.
    const byHand = new Map();
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (!n || !n.hand) continue;
      if (n.velocity === 0) continue; // logical note-off
      if (this._axisValue(n) == null) continue;
      if (!byHand.has(n.hand)) byHand.set(n.hand, []);
      byHand.get(n.hand).push(i);
    }

    const groups = [];
    for (const [hand, indices] of byHand) {
      indices.sort((a, b) => notes[a].time - notes[b].time);
      let current = null;
      for (const idx of indices) {
        const n = notes[idx];
        const v = this._axisValue(n);
        if (current && Math.abs(n.time - current.time) <= CHORD_GROUPING_TOLERANCE) {
          current.notes.push(idx);
          if (v < current.low) current.low = v;
          if (v > current.high) current.high = v;
        } else {
          if (current) groups.push(current);
          current = { hand, time: n.time, notes: [idx], low: v, high: v };
        }
      }
      if (current) groups.push(current);
    }

    // Global chronological order so the planner processes shifts for L
    // and R in the order they will actually be played. Same-time groups
    // are stable (left before right is irrelevant — states are independent).
    groups.sort((a, b) => a.time - b.time);
    return groups;
  }
}

function clamp7bit(v) {
  return Math.max(0, Math.min(127, Math.round(v)));
}

export default HandPositionPlanner;
