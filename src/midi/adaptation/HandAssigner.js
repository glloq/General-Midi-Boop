/**
 * @file src/midi/adaptation/HandAssigner.js
 * @description Tag each MIDI note-on of a given instrument with a hand
 * ("left" | "right"). Pure function — no DB, no I/O.
 *
 * Phase 1 targets two-hand keyboards. Strings (Phase 2) will pass a
 * config with a single hand, in which case every note is assigned to it.
 *
 * Assignment modes:
 *   - "track":       explicit track→hand map in config.assignment.track_map.
 *   - "pitch_split": notes below `pitch_split_note` → left, above → right,
 *                    with hysteresis to avoid flipping for notes right at
 *                    the boundary (once a note lands on a hand, near-by
 *                    subsequent notes stay on the same hand).
 *   - "auto":        prefer "track" when the source MIDI has >=2 tracks
 *                    routed to the same channel/instrument. The track
 *                    with the lower median pitch becomes the left hand.
 *                    Fallback to "pitch_split" otherwise.
 *
 * Warnings are collected for ambiguous cases so the UI can flag them
 * (non-blocking, the feature falls back to a deterministic decision).
 */

/** Default split note (C4). */
const DEFAULT_SPLIT_NOTE = 60;
/** Default hysteresis band, in semitones. */
const DEFAULT_HYSTERESIS = 2;

class HandAssigner {
  /**
   * @param {Object} config - `hands_config` JSON of the target instrument.
   * @param {boolean} [config.enabled]
   * @param {Object} [config.assignment]
   * @param {'auto'|'track'|'pitch_split'} [config.assignment.mode='auto']
   * @param {{left:number[], right:number[]}} [config.assignment.track_map]
   * @param {number} [config.assignment.pitch_split_note=60]
   * @param {number} [config.assignment.pitch_split_hysteresis=2]
   * @param {Array<{id:'left'|'right'}>} config.hands
   */
  constructor(config) {
    this.config = config || {};
    const a = this.config.assignment || {};
    this.mode = a.mode || 'auto';
    this.trackMap = a.track_map || null;
    this.splitNote = Number.isFinite(a.pitch_split_note) ? a.pitch_split_note : DEFAULT_SPLIT_NOTE;
    this.hysteresis = Number.isFinite(a.pitch_split_hysteresis) ? a.pitch_split_hysteresis : DEFAULT_HYSTERESIS;
    this.hands = new Set((this.config.hands || []).map(h => h.id));
    this.singleHandId = this.hands.size === 1 ? [...this.hands][0] : null;
  }

  /**
   * Assign each note of the sequence to a hand.
   *
   * @param {Array<{time:number, note:number, channel?:number, track?:number}>} notes
   *   Sorted by time. `track` is optional — required only for track/auto modes.
   * @returns {{ assignments: Array<{idx:number, hand:'left'|'right'}>,
   *             warnings: Array<{time:number, note:number, code:string, message:string}>,
   *             resolvedMode: string }}
   */
  assign(notes) {
    const warnings = [];
    if (!Array.isArray(notes) || notes.length === 0) {
      return { assignments: [], warnings, resolvedMode: this.mode };
    }

    // Single-hand instruments (Phase 2 strings, or a keyboard with one hand
    // configured): every note goes to that hand.
    if (this.singleHandId) {
      return {
        assignments: notes.map((_, idx) => ({ idx, hand: this.singleHandId })),
        warnings,
        resolvedMode: 'single_hand'
      };
    }

    let resolvedMode = this.mode;
    if (resolvedMode === 'auto') {
      resolvedMode = this._resolveAutoMode(notes, warnings);
    }

    if (resolvedMode === 'track') {
      return {
        assignments: this._assignByTrack(notes, warnings),
        warnings,
        resolvedMode
      };
    }

    return {
      assignments: this._assignByPitchSplit(notes, warnings),
      warnings,
      resolvedMode: 'pitch_split'
    };
  }

  _resolveAutoMode(notes, warnings) {
    if (this.trackMap && (this.trackMap.left?.length || this.trackMap.right?.length)) {
      return 'track';
    }

    // Auto-detect: if notes carry distinct track indices, try to infer by
    // median pitch. Lower median = left, higher = right.
    const byTrack = new Map();
    for (const ev of notes) {
      if (ev.track === undefined || ev.track === null) continue;
      if (!byTrack.has(ev.track)) byTrack.set(ev.track, []);
      byTrack.get(ev.track).push(ev.note);
    }

    if (byTrack.size >= 2) {
      const medians = [...byTrack.entries()]
        .map(([track, pitches]) => ({ track, median: median(pitches) }))
        .sort((a, b) => a.median - b.median);

      // Pick the two most "piano-like" (widest median spread) and assign
      // the rest to the closer hand by median.
      const left = new Set();
      const right = new Set();
      left.add(medians[0].track);
      right.add(medians[medians.length - 1].track);
      const leftMedian = medians[0].median;
      const rightMedian = medians[medians.length - 1].median;
      for (let i = 1; i < medians.length - 1; i++) {
        const m = medians[i];
        if (Math.abs(m.median - leftMedian) <= Math.abs(m.median - rightMedian)) {
          left.add(m.track);
        } else {
          right.add(m.track);
        }
        warnings.push({
          time: 0,
          note: null,
          code: 'auto_track_conflict',
          message: `Track ${m.track} auto-assigned by median-pitch proximity (median ${m.median}).`
        });
      }
      this.trackMap = { left: [...left], right: [...right] };
      return 'track';
    }

    return 'pitch_split';
  }

  _assignByTrack(notes, warnings) {
    const leftSet = new Set(this.trackMap?.left || []);
    const rightSet = new Set(this.trackMap?.right || []);
    const out = [];
    let flaggedMissing = false;

    for (let i = 0; i < notes.length; i++) {
      const ev = notes[i];
      let hand = null;
      if (ev.track !== undefined && leftSet.has(ev.track)) hand = 'left';
      else if (ev.track !== undefined && rightSet.has(ev.track)) hand = 'right';
      else {
        // Track not mapped — fallback to pitch split for this note, flag once.
        hand = ev.note < this.splitNote ? 'left' : 'right';
        if (!flaggedMissing) {
          flaggedMissing = true;
          warnings.push({
            time: ev.time,
            note: ev.note,
            code: 'auto_track_conflict',
            message: `Track ${ev.track ?? '?'} not present in track_map; falling back to pitch split.`
          });
        }
      }
      out.push({ idx: i, hand });
    }
    return out;
  }

  _assignByPitchSplit(notes, warnings) {
    const out = [];
    const band = this.hysteresis;
    // Track last chosen hand so we can resolve ties inside the hysteresis
    // band toward the prior hand (standard anti-chattering trick).
    let lastHand = null;
    for (let i = 0; i < notes.length; i++) {
      const ev = notes[i];
      let hand;
      if (ev.note < this.splitNote - band) hand = 'left';
      else if (ev.note >= this.splitNote + band) hand = 'right';
      else {
        hand = lastHand || (ev.note < this.splitNote ? 'left' : 'right');
        warnings.push({
          time: ev.time,
          note: ev.note,
          code: 'auto_split_ambiguous',
          message: `Note ${ev.note} inside hysteresis band around split ${this.splitNote} — assigned to ${hand}.`
        });
      }
      lastHand = hand;
      out.push({ idx: i, hand });
    }
    return out;
  }
}

function median(arr) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export default HandAssigner;
