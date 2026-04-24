/**
 * @file src/midi/adaptation/HandPositionPlanner.js
 * @description Plan hand-position CC events for an instrument whose
 * `hands_config` has been resolved by the {@link HandAssigner}.
 *
 * Input : an ordered list of note events already tagged with `hand`
 *         ("left" | "right") and optional `track`.
 * Output: a list of CC events ready to be merged back into the playback
 *         timeline, plus a feasibility report the UI can show to the
 *         operator (non-blocking warnings).
 *
 * CC semantics:
 *   - Controller number = `hand.cc_position_number` (e.g. 23/24).
 *   - Value              = MIDI note number of the LOWEST note in the
 *                          current reachable window of that hand. Raw,
 *                          no scaling or offset. The hardware controller
 *                          is expected to interpret this as "move the
 *                          mechanical hand so its leftmost finger sits
 *                          on this note".
 *
 * Simplified per-hand model: each hand only stores `cc_position_number`
 * and `hand_span_semitones`. The reachable note range is derived from
 * the instrument's own `note_range_min`/`note_range_max`; the minimum
 * gap between notes comes from the instrument's `min_note_interval`;
 * the mechanical travel speed is a single value shared by both hands
 * (`hands_config.hand_move_semitones_per_sec`).
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
 *   - `out_of_range`             — note outside the instrument's playable range.
 *   - `chord_span_exceeded`      — chord width > hand_span_semitones (forced shift, one note may still be uncomfortable).
 */

const EPSILON_SECONDS = 0.0001;
/** Group simultaneous notes within this time tolerance (seconds). */
const CHORD_GROUPING_TOLERANCE = 0.002;

class HandPositionPlanner {
  /**
   * @param {Object} handsConfig - Validated `hands_config` payload.
   * @param {number} [handsConfig.hand_move_semitones_per_sec] - Shared travel speed.
   * @param {Array<{id:string, cc_position_number:number,
   *                hand_span_semitones:number}>} handsConfig.hands
   * @param {Object} [instrumentContext] - Fields pulled from the owning
   *   instrument's capabilities. All optional; when absent the matching
   *   check is skipped (preserves pre-feature behavior).
   * @param {number} [instrumentContext.noteRangeMin] - Lowest playable note.
   * @param {number} [instrumentContext.noteRangeMax] - Highest playable note.
   * @param {number} [instrumentContext.minNoteIntervalMs] - Min gap between
   *   consecutive notes on the same hand (milliseconds). 0 or null disables
   *   the `finger_interval_violated` warning.
   */
  constructor(handsConfig, instrumentContext) {
    this.config = handsConfig || {};
    this.ctx = instrumentContext || {};
    this.handById = new Map();
    for (const h of (this.config.hands || [])) {
      this.handById.set(h.id, h);
    }
  }

  /**
   * Produce hand-position CC events for a sequence of note events.
   *
   * @param {Array<{time:number, note:number, channel:number,
   *                velocity?:number, hand:'left'|'right'}>} notes
   *   Note-ons only, sorted by `time`. `velocity === 0` notes are
   *   ignored (they are logical note-offs).
   * @returns {{ ccEvents: Array<Object>, warnings: Array<Object>,
   *             stats: { shifts: { left: number, right: number } } }}
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
    const commonSpeed = this.config.hand_move_semitones_per_sec || 60;
    const minIntervalMs = this.ctx.minNoteIntervalMs ?? 0;

    for (const g of groups) {
      const hand = this.handById.get(g.hand);
      if (!hand) continue; // unknown hand id — skip defensively
      const s = state.get(g.hand);

      // Out-of-range check per note, against the instrument's playable range.
      for (const nIdx of g.notes) {
        const n = notes[nIdx];
        if (instrumentMin != null && n.note < instrumentMin) {
          warnings.push({
            time: n.time, hand: g.hand, note: n.note,
            code: 'out_of_range',
            message: `Note ${n.note} < instrument range min ${instrumentMin}`
          });
        }
        if (instrumentMax != null && n.note > instrumentMax) {
          warnings.push({
            time: n.time, hand: g.hand, note: n.note,
            code: 'out_of_range',
            message: `Note ${n.note} > instrument range max ${instrumentMax}`
          });
        }
      }

      // Chord span check + window decision.
      const groupLow = g.low;
      const groupHigh = g.high;
      const groupSpan = groupHigh - groupLow;
      const span = hand.hand_span_semitones ?? 14;

      if (groupSpan > span) {
        warnings.push({
          time: g.time, hand: g.hand, note: null,
          code: 'chord_span_exceeded',
          message: `Chord span ${groupSpan} > hand span ${span}`
        });
      }

      // Need a shift if: no window yet, or any note falls outside current window.
      const needShift = s.windowLowest == null
        || groupLow < s.windowLowest
        || groupHigh > s.windowLowest + span;

      if (needShift) {
        // Anchor the new window. When shifting up we prefer to anchor at
        // groupHigh - span (keeps the hand's low fingers on the chord's
        // bottom note); for a shift down we anchor at groupLow (the low
        // finger takes the lowest note).
        let newLow;
        if (s.windowLowest == null) {
          newLow = groupLow;
        } else if (groupLow < s.windowLowest) {
          newLow = groupLow;
        } else {
          // groupHigh > windowLowest + span
          newLow = Math.max(groupLow, groupHigh - span);
        }

        // Clamp the anchor to the instrument's playable range so the
        // CC we send is always a note the hand can actually reach. The
        // note itself may still be out-of-range (reported separately as
        // `out_of_range`); clamping keeps the hardware safe by not
        // commanding it to move somewhere it cannot go.
        if (instrumentMin != null && newLow < instrumentMin) {
          newLow = instrumentMin;
        }
        if (instrumentMax != null && newLow + span > instrumentMax) {
          newLow = Math.max(instrumentMin ?? 0, instrumentMax - span);
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
          const travelSemitones = Math.abs(newLow - s.windowLowest);
          const requiredSec = travelSemitones / commonSpeed;
          const availableSec = g.time - ccTime;
          if (requiredSec > availableSec) {
            warnings.push({
              time: g.time, hand: g.hand, note: null,
              code: 'move_too_fast',
              message: `Shift ${travelSemitones} semitones needs ${(requiredSec * 1000).toFixed(0)}ms, only ${(availableSec * 1000).toFixed(0)}ms available`
            });
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
    const byHand = new Map();
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (!n || !n.hand) continue;
      if (n.velocity === 0) continue; // logical note-off
      if (!byHand.has(n.hand)) byHand.set(n.hand, []);
      byHand.get(n.hand).push(i);
    }

    const groups = [];
    for (const [hand, indices] of byHand) {
      indices.sort((a, b) => notes[a].time - notes[b].time);
      let current = null;
      for (const idx of indices) {
        const n = notes[idx];
        if (current && Math.abs(n.time - current.time) <= CHORD_GROUPING_TOLERANCE) {
          current.notes.push(idx);
          if (n.note < current.low) current.low = n.note;
          if (n.note > current.high) current.high = n.note;
        } else {
          if (current) groups.push(current);
          current = { hand, time: n.time, notes: [idx], low: n.note, high: n.note };
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
