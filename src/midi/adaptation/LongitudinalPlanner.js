/**
 * @file src/midi/adaptation/LongitudinalPlanner.js
 * @description Longitudinal anchored-finger planner for string instruments
 * whose mechanism is `string_sliding_fingers`. Each finger is permanently
 * pinned to a single string and slides only along that string. The hand
 * position P (in millimetres from the nut) and the per-finger offsets
 * inside the hand are computed jointly so a finger pressing a held note
 * stays put on the string while the hand moves around it.
 *
 * Companion of {@link HandPositionPlanner}. The window-based V1 planner
 * remains the default; this module is selected by the orchestrator when
 * `hands_config.hands[0].fingers[]` is supplied (see
 * `docs/LONGITUDINAL_MODEL.md`).
 *
 * Inputs:
 *   - `handsConfig`: validated `hands_config` payload, frets mode,
 *     mechanism `string_sliding_fingers`, with the optional `fingers[]`
 *     and `anchor` blocks present.
 *   - `instrumentContext`:
 *       `unit`            : must be 'frets' here (longitudinal-only).
 *       `noteRangeMin/Max`: fret bounds.
 *       `scaleLengthMm`   : required — the planner is geometric.
 *       `minNoteIntervalMs`: optional finger-interval check.
 *
 * Output: same shape as HandPositionPlanner.plan() — `{ccEvents, warnings,
 * stats}` — so callers can swap planners without restructuring the merge
 * logic in MidiPlayer.
 *
 * CC semantics: `cc_position_number` (typically 22), value = fret number
 * (0–127) corresponding to the *leftmost finger position*, i.e. the fret
 * under the finger with the smallest offset. Matches V1 contract so the
 * hardware controller does not need to be reconfigured.
 *
 * Algorithm sketch (full spec: docs/LONGITUDINAL_MODEL.md §5):
 *   1. Sort note-ons by time; for each, look up the finger pinned to
 *      its string.
 *   2. Each currently anchored finger forces P into the interval
 *      `[pos_note − off_max, pos_note − off_min]`. Intersect across
 *      anchors → the feasible band for P.
 *   3. The new note adds another such interval. If the running
 *      intersection is empty, try releasing the anchor with the
 *      shortest remaining duration; if that does not help, warn and
 *      drop the conflict-causing anchor.
 *   4. Hand speed: P_new must lie within `[P_prev ± V·Δt]`. If not,
 *      warn `speed_saturation` and saturate to the closest reachable
 *      point.
 *   5. Hysteresis: if the previous P already lies in the feasible
 *      band within `hysteresis_mm`, keep it.
 *   6. Promote the new note to anchored if `duration ≥ min_duration_ms`.
 *
 * Sparse output by default (one CC per shift). When
 * `cc_sample_rate_hz > 0` the planner additionally emits intermediate
 * CCs interpolated linearly in mm between the trajectory key points.
 */

const EPSILON_SECONDS = 0.0001;
const CHORD_GROUPING_TOLERANCE = 0.002;
const DEFAULT_ANCHOR_MIN_DURATION_MS = 60;
const DEFAULT_ANCHOR_EARLY_RELEASE_MS = 20;
const DEFAULT_HYSTERESIS_MM = 3;
const DEFAULT_LOOKAHEAD = 2;

class LongitudinalPlanner {
  constructor(handsConfig, instrumentContext) {
    this.config = handsConfig || {};
    this.ctx = instrumentContext || {};
    if (this.ctx.unit !== 'frets') {
      throw new Error("LongitudinalPlanner: unit must be 'frets'.");
    }
    if (this.config.mechanism && this.config.mechanism !== 'string_sliding_fingers') {
      throw new Error(
        `LongitudinalPlanner: mechanism '${this.config.mechanism}' not supported (string_sliding_fingers only).`
      );
    }
    const hand = (this.config.hands || [])[0];
    if (!hand) throw new Error('LongitudinalPlanner: missing fretting hand.');
    this.hand = hand;

    // Finger model. Two paths:
    //
    //   - Legacy: `hand.fingers[]` is supplied (V1.5 opt-in panel). The
    //     planner respects the per-finger offset bands as authored.
    //   - Default (always-on simplified model): no `fingers[]` is given.
    //     The planner auto-derives one finger per string up to
    //     `max_fingers`, with each finger free to move anywhere within
    //     the hand width (`offset ∈ [0, hand_span_mm]`). This matches
    //     the simplified spec in docs/LONGITUDINAL_MODEL.md.
    const explicitFingers = Array.isArray(hand.fingers) && hand.fingers.length > 0
      ? hand.fingers
      : null;
    this.fingers = explicitFingers || this._deriveAutoFingers(hand);
    this.fingerByString = new Map();
    for (const f of this.fingers) this.fingerByString.set(f.string, f);

    this.scaleLengthMm = this.ctx.scaleLengthMm;
    if (!Number.isFinite(this.scaleLengthMm) || this.scaleLengthMm <= 0) {
      throw new Error('LongitudinalPlanner: scaleLengthMm is required (geometric model).');
    }

    const speed = this.config.hand_move_mm_per_sec;
    this.handSpeedMmPerSec = Number.isFinite(speed) && speed > 0 ? speed : 250;

    const a = this.config.anchor || {};
    this.minAnchorMs = Number.isFinite(a.min_duration_ms) ? a.min_duration_ms : DEFAULT_ANCHOR_MIN_DURATION_MS;
    // Reserved: budget (ms) for forced anchor releases that happen close
    // to a note's natural t_off — used by a future cost-aware release
    // ranker to distinguish "barely-shortened" from "significantly-cut"
    // notes. Currently parsed and validated but not yet consumed by
    // `_tryReleaseConflict`, which releases unconditionally.
    this.earlyReleaseMs = Number.isFinite(a.early_release_ms) ? a.early_release_ms : DEFAULT_ANCHOR_EARLY_RELEASE_MS;
    this.hysteresisMm = Number.isFinite(a.hysteresis_mm) ? a.hysteresis_mm : DEFAULT_HYSTERESIS_MM;
    this.lookahead = Number.isInteger(a.lookahead_events) ? a.lookahead_events : DEFAULT_LOOKAHEAD;

    this.minNoteIntervalMs = this.ctx.minNoteIntervalMs ?? 0;
    this.noteRangeMin = this.ctx.noteRangeMin ?? 0;
    this.noteRangeMax = this.ctx.noteRangeMax ?? 24;

    // Optional dense CC stream. When > 0, the planner emits intermediate
    // samples between consecutive shift events at the configured rate so
    // the hardware sees a continuous trajectory rather than discrete
    // jumps. Interpolation is linear in millimetres, then mapped back to
    // fret for the CC value (so the rate of change in mm/s is constant
    // between key events). 0 (default) reproduces the V1 sparse stream.
    const rate = this.config.cc_sample_rate_hz;
    this.ccSampleRateHz = Number.isFinite(rate) && rate > 0 ? rate : 0;

    // Pre-compute the global mm-window the hand must stay within so the
    // emitted CC value (a fret number) is always in [noteRangeMin,
    // noteRangeMax]. The CC encodes the leftmost-finger fret = fret(P + minOff).
    this.minOffsetMm = Math.min(...this.fingers.map((f) => f.offset_min_mm));
    this.maxOffsetMm = Math.max(...this.fingers.map((f) => f.offset_max_mm));
  }

  /**
   * Auto-derive a finger list when `hand.fingers[]` is not supplied.
   * One finger per string, indexed 1..N where N = clamp(max_fingers, 1, 12).
   * Each finger shares the same offset band `[0, hand_span_mm]`: a finger
   * can be anywhere within the hand's reach. The simplification trades
   * per-finger ergonomic bounds (which the V1.5 panel exposed) for a
   * config-less default that matches the always-on anchored spec.
   * @private
   */
  _deriveAutoFingers(hand) {
    const span = Number.isFinite(hand.hand_span_mm) && hand.hand_span_mm > 0
      ? hand.hand_span_mm
      : 80;
    const requested = Number.isInteger(hand.max_fingers) && hand.max_fingers > 0
      ? hand.max_fingers
      : 4;
    const N = Math.min(12, Math.max(1, requested));
    const out = [];
    for (let i = 1; i <= N; i++) {
      out.push({
        id: i,
        string: i,
        offset_min_mm: 0,
        offset_max_mm: span,
        rest_offset_mm: span / 2,
        _autoDerived: true
      });
    }
    return out;
  }

  /** Convert fret number to position in mm (equal-temperament geometry). */
  fretToMm(fret) {
    return this.scaleLengthMm * (1 - Math.pow(2, -fret / 12));
  }

  /** Inverse: mm → fret number. Returns 0 for p ≤ 0; bounded above. */
  mmToFret(mm) {
    if (mm <= 0) return 0;
    const ratio = 1 - mm / this.scaleLengthMm;
    if (ratio <= 0) return Number.POSITIVE_INFINITY;
    return -12 * Math.log2(ratio);
  }

  /**
   * Plan CC events for the given note-on stream.
   * @param {Array<{time:number, note:number, channel:number,
   *                velocity?:number, hand?:string,
   *                fretPosition:number, string?:number,
   *                duration?:number}>} notes
   * @returns {{ccEvents:Array, warnings:Array, stats:Object}}
   */
  plan(notes) {
    const ccEvents = [];
    const warnings = [];
    const stats = {
      shifts: 0,
      anchors_kept: 0,
      anchors_released_forced: 0,
      anchors_released_natural: 0
    };

    if (!Array.isArray(notes) || notes.length === 0) {
      return { ccEvents, warnings, stats };
    }

    // Group simultaneous same-time notes (chord). Each group is processed
    // atomically: all of its notes must coexist in the chosen P.
    const groups = this._groupByTime(notes);

    // anchors: Map<fingerId, { fingerId, note, posMm, t_on, t_off, velocity }>
    const anchors = new Map();
    let P = null; // current hand position (mm)
    let lastNoteOnTime = null;
    let lastSingleNoteOnTime = null;
    let firstCCEmitted = false;
    // Trajectory log: P_mm value the hand should be at at each group's
    // note-on time. Used by `_densifyTrajectory` to interpolate at the
    // configured sample rate. Always recorded, even when no CC is emitted
    // (rounded fret unchanged), so the dense stream still moves smoothly
    // through small mm-level adjustments.
    const trajectory = [];

    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];

      // 1. Release anchors whose note-off has elapsed by g.time.
      for (const [fid, a] of anchors) {
        if (a.t_off != null && a.t_off <= g.time) {
          anchors.delete(fid);
          stats.anchors_released_natural++;
        }
      }

      // 2. Build per-note interval requirement and compute their joint
      //    intersection with the current anchor band.
      const reqs = []; // { fingerId, finger, note, posMm, interval:[lo,hi] }
      for (const idx of g.notes) {
        const n = notes[idx];
        if (!Number.isFinite(n.fretPosition) || n.fretPosition <= 0) continue;
        const fret = n.fretPosition;
        if (fret < this.noteRangeMin || fret > this.noteRangeMax) {
          warnings.push({
            time: n.time, note: n.note, code: 'out_of_range',
            message: `Fret ${fret} outside instrument range [${this.noteRangeMin},${this.noteRangeMax}]`
          });
        }
        const f = this._resolveFinger(n);
        if (!f) {
          warnings.push({
            time: n.time, note: n.note, code: 'no_finger_for_string',
            message: `No finger pinned to string ${n.string ?? '?'} (longitudinal mode requires one finger per string).`
          });
          continue;
        }
        const posMm = this.fretToMm(fret);
        const interval = [posMm - f.offset_max_mm, posMm - f.offset_min_mm];
        reqs.push({ fingerId: f.id, finger: f, note: n, idx, posMm, interval });
      }
      if (reqs.length === 0) continue;

      // 3. Anchor band — intersection of all currently-anchored fingers.
      let band = this._anchorBand(anchors);

      // 4. Add this group's requirements.
      for (const r of reqs) {
        const next = intersect(band, r.interval);
        if (next == null) {
          // Try releasing anchors in priority order (shortest remaining
          // duration first, then lowest velocity) until the new requirement
          // fits OR no anchor is removable.
          const released = this._tryReleaseConflict(anchors, r, g.time);
          if (released.success) {
            stats.anchors_released_forced += released.releasedIds.length;
            for (const id of released.releasedIds) {
              warnings.push({
                time: g.time, code: 'release_forced', fingerId: id,
                message: `Released anchor on finger ${id} early to satisfy fret ${r.note.fretPosition}.`
              });
            }
            band = this._anchorBand(anchors);
            const after = intersect(band, r.interval);
            if (after == null) {
              warnings.push({
                time: g.time, code: 'anchor_conflict', note: r.note.note,
                message: `Cannot place P for fret ${r.note.fretPosition}; conflict survives release.`
              });
              continue;
            }
            band = after;
          } else {
            warnings.push({
              time: g.time, code: 'anchor_conflict', note: r.note.note,
              message: `Cannot place P for fret ${r.note.fretPosition}; no anchor releasable.`
            });
            continue;
          }
        } else {
          band = next;
        }
      }
      if (band == null) continue;

      // 5. Hand-speed constraint relative to previous P.
      let feasible = band;
      if (P != null && firstCCEmitted) {
        const dt = Math.max(0, g.time - (lastNoteOnTime ?? g.time));
        const reach = this.handSpeedMmPerSec * dt;
        const speedBand = [P - reach, P + reach];
        const next = intersect(feasible, speedBand);
        if (next == null) {
          // Speed is insufficient. The note's required band is entirely
          // outside `[P − reach, P + reach]`. The hand cannot reach it
          // in time; saturate to the closest *reachable* point (which is
          // P + sign·reach, NOT clampToInterval(P, feasible) — that
          // would silently jump to the unreachable target).
          const requested = clampToInterval(P, feasible);
          const direction = requested >= P ? 1 : -1;
          const reachableP = P + direction * reach;
          warnings.push({
            time: g.time, code: 'speed_saturation',
            message: `Hand speed ${this.handSpeedMmPerSec.toFixed(0)} mm/s insufficient over ${(dt * 1000).toFixed(0)} ms (target ${requested.toFixed(1)} mm from ${P.toFixed(1)} mm; reachable ${reachableP.toFixed(1)} mm).`
          });
          feasible = [reachableP, reachableP];
        } else {
          feasible = next;
        }
      }

      // 6. Pick P in `feasible`. Bias towards (a) previous P (anti-jitter
      //    via hysteresis), (b) median of look-ahead notes' centers
      //    (anticipation).
      let P_new;
      if (P != null) {
        // Hysteresis: if previous P is in band already, keep it unless
        // the bias from look-ahead pulls it more than `hysteresisMm` away.
        const insideOrNear = clampToInterval(P, feasible);
        if (Math.abs(insideOrNear - P) <= this.hysteresisMm) {
          P_new = insideOrNear;
        } else {
          const lookTarget = this._lookaheadTarget(notes, groups, gi, anchors, reqs);
          const target = lookTarget != null ? lookTarget : (feasible[0] + feasible[1]) / 2;
          P_new = clampToInterval(target, feasible);
        }
      } else {
        const lookTarget = this._lookaheadTarget(notes, groups, gi, anchors, reqs);
        const target = lookTarget != null ? lookTarget : (feasible[0] + feasible[1]) / 2;
        P_new = clampToInterval(target, feasible);
      }

      // 7. Promote sufficiently long notes to anchored. The anchor's
      //    natural release time is the actual note-off (t_on + duration);
      //    `early_release_ms` is consumed only by the conflict path
      //    (`_tryReleaseConflict`), which may release the anchor before
      //    its natural end to make room for an incoming note.
      for (const r of reqs) {
        const durMs = (r.note.duration ?? 0) * 1000;
        if (durMs >= this.minAnchorMs) {
          const t_off = r.note.duration != null
            ? r.note.time + r.note.duration
            : null;
          anchors.set(r.fingerId, {
            fingerId: r.fingerId,
            finger: r.finger,
            note: r.note,
            posMm: r.posMm,
            t_on: r.note.time,
            t_off,
            velocity: r.note.velocity ?? 64
          });
          stats.anchors_kept++;
        }
      }

      // 8. Emit CC if P changed (or first emission).
      const fretValue = Math.round(this.mmToFret(P_new + this.minOffsetMm));
      const prevFret = P != null ? Math.round(this.mmToFret(P + this.minOffsetMm)) : null;
      const needEmit = !firstCCEmitted || prevFret !== fretValue;
      if (needEmit) {
        let ccTime;
        if (!firstCCEmitted) {
          ccTime = g.time - EPSILON_SECONDS;
        } else if (this.ccSampleRateHz > 0) {
          // Dense mode: the explicit trajectory ramp drives the hand
          // between note-ons, so the sparse CC must land just before
          // its own note rather than right after the previous one.
          // Otherwise the early jump fights the interpolated samples.
          ccTime = g.time - EPSILON_SECONDS;
        } else {
          ccTime = (lastNoteOnTime ?? g.time) + EPSILON_SECONDS;
        }
        ccEvents.push({
          time: ccTime,
          type: 'controller',
          channel: notes[g.notes[0]].channel,
          controller: this.hand.cc_position_number,
          value: clamp7bit(fretValue),
          hand: this.hand.id,
          _pMm: P_new
        });
        firstCCEmitted = true;
        if (P != null) stats.shifts++;
      }

      P = P_new;
      trajectory.push({
        time: g.time,
        P_mm: P_new,
        channel: notes[g.notes[0]].channel
      });

      // Finger-interval (single-note) check for hardware comfort.
      if (g.notes.length === 1 && this.minNoteIntervalMs > 0 && lastSingleNoteOnTime != null) {
        const deltaMs = (g.time - lastSingleNoteOnTime) * 1000;
        if (deltaMs < this.minNoteIntervalMs) {
          warnings.push({
            time: g.time, code: 'finger_interval_violated',
            message: `Gap ${deltaMs.toFixed(0)} ms < min ${this.minNoteIntervalMs} ms between notes`
          });
        }
      }
      if (g.notes.length === 1) lastSingleNoteOnTime = g.time;
      lastNoteOnTime = g.time;
    }

    const finalEvents = this.ccSampleRateHz > 0
      ? this._densifyFromTrajectory(ccEvents, trajectory)
      : ccEvents;
    // Strip internal trajectory metadata before returning.
    for (const e of finalEvents) delete e._pMm;
    return { ccEvents: finalEvents, warnings, stats };
  }

  /**
   * Insert intermediate CC samples between consecutive trajectory key
   * points (one per note-on group) so the hand position P(t) varies
   * linearly between them at `cc_sample_rate_hz`. The original sparse
   * shift events are kept (their timing follows the V1 "as early as
   * possible" semantics) and the dense interpolated samples are placed
   * strictly inside `[trajectory_k.time, trajectory_{k+1}.time)`.
   *
   * Linear in millimetres, then converted to fret for the CC value.
   * Duplicate consecutive values are dropped so the bus is not flooded
   * with identical CCs.
   * @private
   */
  _densifyFromTrajectory(events, trajectory) {
    if (this.ccSampleRateHz <= 0 || trajectory.length < 2) return events;
    const period = 1 / this.ccSampleRateHz;
    const interpolated = [];
    let lastValue = null;
    for (let i = 0; i < trajectory.length - 1; i++) {
      const a = trajectory[i];
      const b = trajectory[i + 1];
      const dt = b.time - a.time;
      if (dt <= period) continue;
      const steps = Math.floor(dt / period);
      for (let k = 1; k <= steps; k++) {
        const u = k / (steps + 1);
        const t = a.time + u * dt;
        if (t >= b.time) break;
        const pMm = a.P_mm + (b.P_mm - a.P_mm) * u;
        const value = clamp7bit(Math.round(this.mmToFret(pMm + this.minOffsetMm)));
        if (lastValue === value) continue;
        interpolated.push({
          time: t,
          type: 'controller',
          channel: a.channel,
          controller: this.hand.cc_position_number,
          value,
          hand: this.hand.id,
          _interpolated: true
        });
        lastValue = value;
      }
    }
    if (interpolated.length === 0) return events;
    const merged = events.concat(interpolated).sort((x, y) => x.time - y.time);
    return merged;
  }

  /** @private */
  _resolveFinger(note) {
    if (Number.isInteger(note.string) && this.fingerByString.has(note.string)) {
      return this.fingerByString.get(note.string);
    }
    return null;
  }

  /** @private Intersection of all anchor intervals; null = empty band. */
  _anchorBand(anchors) {
    let band = [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
    for (const a of anchors.values()) {
      // Anchors carry their finger reference directly so we avoid an
      // O(n) lookup against `this.fingers` on every band recomputation.
      const f = a.finger;
      if (!f) continue;
      const I = [a.posMm - f.offset_max_mm, a.posMm - f.offset_min_mm];
      band = intersect(band, I);
      if (band == null) return null;
    }
    return band;
  }

  /**
   * Try to release the smallest set of anchors so that requirement `r`
   * fits inside the resulting band. Greedy by ascending remaining
   * duration, then ascending velocity. Mutates `anchors` on success.
   * @private
   */
  _tryReleaseConflict(anchors, r, now) {
    const ranked = [...anchors.values()].sort((a, b) => {
      const remA = (a.t_off ?? Infinity) - now;
      const remB = (b.t_off ?? Infinity) - now;
      if (remA !== remB) return remA - remB;
      return (a.velocity ?? 0) - (b.velocity ?? 0);
    });
    const releasedIds = [];
    for (const a of ranked) {
      anchors.delete(a.fingerId);
      releasedIds.push(a.fingerId);
      const band = this._anchorBand(anchors);
      const next = band == null ? null : intersect(band, r.interval);
      if (next != null) {
        return { success: true, releasedIds };
      }
    }
    // Restoration: caller does not need it because we will warn anyway,
    // but leaving extra anchors removed would penalize the rest. Restore
    // them so subsequent notes still see the original anchors (we only
    // promised to free what was strictly needed).
    for (const id of releasedIds) {
      const a = ranked.find((x) => x.fingerId === id);
      if (a) anchors.set(id, a);
    }
    return { success: false, releasedIds: [] };
  }

  /**
   * Compute a target P (mm) hinted by the next `lookahead` events. We
   * average the centers of their feasible intervals. If no future event
   * is reachable, returns null.
   * @private
   */
  _lookaheadTarget(notes, groups, gi, anchors, currentReqs) {
    const targets = [];
    for (const r of currentReqs) targets.push((r.interval[0] + r.interval[1]) / 2);
    let scanned = 0;
    for (let j = gi + 1; j < groups.length && scanned < this.lookahead; j++) {
      const g = groups[j];
      for (const idx of g.notes) {
        const n = notes[idx];
        if (!Number.isFinite(n.fretPosition) || n.fretPosition <= 0) continue;
        const f = this._resolveFinger(n);
        if (!f) continue;
        const posMm = this.fretToMm(n.fretPosition);
        const lo = posMm - f.offset_max_mm;
        const hi = posMm - f.offset_min_mm;
        targets.push((lo + hi) / 2);
        scanned++;
        if (scanned >= this.lookahead) break;
      }
    }
    if (targets.length === 0) return null;
    return targets.reduce((s, x) => s + x, 0) / targets.length;
  }

  /** @private */
  _groupByTime(notes) {
    // Filter:
    //  - notes whose hand differs from this planner's hand (defensive;
    //    callers currently pass a single hand but multi-hand routing
    //    upstream could change),
    //  - logical note-offs (velocity 0),
    //  - notes without a usable fret position.
    const handId = this.hand.id;
    const indexed = notes
      .map((n, i) => ({ n, i }))
      .filter(({ n }) => n
        && (n.hand == null || n.hand === handId)
        && n.velocity !== 0
        && Number.isFinite(n.fretPosition))
      .sort((a, b) => a.n.time - b.n.time);
    const groups = [];
    let current = null;
    for (const { n, i } of indexed) {
      if (current && Math.abs(n.time - current.time) <= CHORD_GROUPING_TOLERANCE) {
        current.notes.push(i);
      } else {
        if (current) groups.push(current);
        current = { time: n.time, notes: [i] };
      }
    }
    if (current) groups.push(current);
    return groups;
  }
}

function intersect(a, b) {
  if (a == null || b == null) return null;
  const lo = Math.max(a[0], b[0]);
  const hi = Math.min(a[1], b[1]);
  if (lo > hi) return null;
  return [lo, hi];
}

function clampToInterval(x, [lo, hi]) {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

function clamp7bit(v) {
  return Math.max(0, Math.min(127, Math.round(v)));
}

export default LongitudinalPlanner;
