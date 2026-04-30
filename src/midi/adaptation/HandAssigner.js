/**
 * @file src/midi/adaptation/HandAssigner.js
 * @description Tag each MIDI note-on of a given instrument with a hand id.
 * Pure function — no DB, no I/O.
 *
 * Generalised to 1–4 hands (semitones mode). Canonical hand ids are
 * `h1..h4`; legacy `left`/`right` are still accepted on read so existing
 * configs keep working. For frets-mode (strings) the config carries a
 * single `fretting` hand and every note is tagged with that id.
 *
 * Assignment modes:
 *   - "track":       explicit `track_map` keyed by hand id
 *                    (e.g. `{ h1: [0], h2: [1] }`).
 *   - "pitch_split": notes split across N classes by N-1 ascending
 *                    `pitch_split_notes` (or the legacy scalar
 *                    `pitch_split_note` when N === 2). Hysteresis avoids
 *                    flipping for notes near a boundary.
 *   - "auto":        prefer "track" when the source MIDI carries enough
 *                    distinct tracks to fill all hands (k‑means by median
 *                    pitch). Fallback to "pitch_split" otherwise.
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
   * @param {Object<string, number[]>} [config.assignment.track_map]
   *   Map of hand id → list of source MIDI tracks.
   * @param {number[]} [config.assignment.pitch_split_notes]
   *   Strictly ascending list of N-1 split notes for N hands.
   * @param {number} [config.assignment.pitch_split_note=60]
   *   Legacy single split (used when `pitch_split_notes` is missing and
   *   there are exactly 2 hands).
   * @param {number} [config.assignment.pitch_split_hysteresis=2]
   * @param {Array<{id:string}>} config.hands
   */
  constructor(config) {
    this.config = config || {};
    const a = this.config.assignment || {};
    this.mode = a.mode || 'auto';
    this.trackMap = a.track_map || null;
    this.hysteresis = Number.isFinite(a.pitch_split_hysteresis) ? a.pitch_split_hysteresis : DEFAULT_HYSTERESIS;

    // Ordered list of hand ids — the order in `hands_config.hands[]`
    // determines pitch ascending order (h1 = lowest, hN = highest).
    this.handIds = (this.config.hands || [])
      .map(h => (h && typeof h.id === 'string') ? h.id : null)
      .filter(Boolean);
    this.singleHandId = this.handIds.length === 1 ? this.handIds[0] : null;

    // Resolve split notes. For N hands we need N-1 ascending boundaries.
    // `pitch_split_notes` wins when present; otherwise we fall back to the
    // legacy scalar `pitch_split_note` (only meaningful for N == 2) and
    // pad with evenly spaced semitones so unspecified higher splits have
    // *some* deterministic boundary.
    this.splitNotes = this._resolveSplitNotes(a);
  }

  /**
   * Assign each note of the sequence to a hand.
   *
   * @param {Array<{time:number, note:number, channel?:number, track?:number}>} notes
   *   Sorted by time. `track` is optional — required only for track/auto modes.
   * @returns {{ assignments: Array<{idx:number, hand:string}>,
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

    if (this.handIds.length === 0) {
      // No hands declared — caller misuse, but degrade gracefully.
      return { assignments: [], warnings, resolvedMode: this.mode };
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

  /** @private */
  _resolveSplitNotes(a) {
    const N = this.handIds.length;
    if (N <= 1) return [];
    if (Array.isArray(a.pitch_split_notes) && a.pitch_split_notes.length === N - 1) {
      return a.pitch_split_notes.slice();
    }
    // Legacy scalar (also covers fresh configs that haven't filled
    // `pitch_split_notes` yet).
    const legacy = Number.isFinite(a.pitch_split_note) ? a.pitch_split_note : DEFAULT_SPLIT_NOTE;
    if (N === 2) return [legacy];
    // N >= 3 with no explicit array: spread N-1 boundaries evenly around
    // C4 with 1 octave per hand. Deterministic and good enough as a
    // fallback — the operator can refine via the UI.
    const out = [];
    const center = legacy;
    const step = 12;
    const start = center - Math.floor((N - 2) / 2) * step - (N % 2 === 0 ? 0 : Math.floor(step / 2));
    for (let i = 0; i < N - 1; i++) out.push(start + i * step);
    return out;
  }

  _resolveAutoMode(notes, warnings) {
    if (this.trackMap && Object.values(this.trackMap).some(arr => Array.isArray(arr) && arr.length > 0)) {
      return 'track';
    }

    // Auto-detect: bucket notes by source track, compute median pitch per
    // track, then group tracks into N hands using a 1‑D k‑means on the
    // medians (k = number of hands). When we have fewer tracks than hands,
    // fall back to pitch split since some hands would end up empty.
    const byTrack = new Map();
    for (const ev of notes) {
      if (ev.track === undefined || ev.track === null) continue;
      if (!byTrack.has(ev.track)) byTrack.set(ev.track, []);
      byTrack.get(ev.track).push(ev.note);
    }

    const N = this.handIds.length;
    if (byTrack.size >= N) {
      const medians = [...byTrack.entries()]
        .map(([track, pitches]) => ({ track, median: median(pitches) }))
        .sort((a, b) => a.median - b.median);

      const buckets = kmeans1D(medians.map(m => m.median), N);
      // buckets[i] is the hand index (0..N-1) for medians[i].
      const trackMap = {};
      for (let i = 0; i < N; i++) trackMap[this.handIds[i]] = [];
      for (let i = 0; i < medians.length; i++) {
        const handIdx = buckets[i];
        trackMap[this.handIds[handIdx]].push(medians[i].track);
      }
      // Flag tracks pulled into a hand by k‑means proximity rather than
      // by being its lowest/highest extremum (helps the UI surface ambiguous
      // assignments to the operator).
      const handLowestTrack = new Map();
      for (let i = 0; i < N; i++) handLowestTrack.set(i, null);
      for (let i = 0; i < medians.length; i++) {
        const h = buckets[i];
        if (handLowestTrack.get(h) == null) handLowestTrack.set(h, medians[i].track);
      }
      for (let i = 0; i < medians.length; i++) {
        const h = buckets[i];
        if (handLowestTrack.get(h) !== medians[i].track) {
          warnings.push({
            time: 0,
            note: null,
            code: 'auto_track_conflict',
            message: `Track ${medians[i].track} auto-assigned to hand ${this.handIds[h]} by median-pitch proximity (median ${medians[i].median}).`
          });
        }
      }
      this.trackMap = trackMap;
      return 'track';
    }

    return 'pitch_split';
  }

  _assignByTrack(notes, warnings) {
    // Build hand id → Set(track) for O(1) lookup.
    const sets = new Map();
    for (const id of this.handIds) sets.set(id, new Set());
    if (this.trackMap) {
      for (const [handId, tracks] of Object.entries(this.trackMap)) {
        if (!sets.has(handId)) continue; // stale entry — silently drop
        for (const t of (tracks || [])) sets.get(handId).add(t);
      }
    }

    const out = [];
    let flaggedMissing = false;
    for (let i = 0; i < notes.length; i++) {
      const ev = notes[i];
      let hand = null;
      if (ev.track !== undefined) {
        for (const [id, set] of sets) {
          if (set.has(ev.track)) { hand = id; break; }
        }
      }
      if (hand == null) {
        // Track not mapped — fallback to pitch split for this note, flag once.
        hand = this._handForPitch(ev.note, null);
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
    let lastHand = null;
    for (let i = 0; i < notes.length; i++) {
      const ev = notes[i];
      const { hand, ambiguous, boundary } = this._handForPitchVerbose(ev.note, lastHand);
      if (ambiguous) {
        warnings.push({
          time: ev.time,
          note: ev.note,
          code: 'auto_split_ambiguous',
          message: `Note ${ev.note} inside hysteresis band around split ${boundary} — assigned to ${hand}.`
        });
      }
      lastHand = hand;
      out.push({ idx: i, hand });
    }
    return out;
  }

  /**
   * Resolve a pitch to a hand id, honouring hysteresis around boundaries.
   * @private
   */
  _handForPitch(note, lastHand) {
    return this._handForPitchVerbose(note, lastHand).hand;
  }

  /** @private */
  _handForPitchVerbose(note, lastHand) {
    const splits = this.splitNotes;
    const ids = this.handIds;
    if (splits.length === 0) return { hand: ids[0] || null, ambiguous: false, boundary: null };
    const band = this.hysteresis;

    // Find which boundary (if any) the note sits inside the hysteresis band of.
    for (let i = 0; i < splits.length; i++) {
      const b = splits[i];
      if (note >= b - band && note < b + band) {
        // Resolve toward the prior hand when we have one and it's adjacent
        // to this boundary; otherwise use the lower side.
        let hand;
        if (lastHand === ids[i] || lastHand === ids[i + 1]) {
          hand = lastHand;
        } else {
          hand = note < b ? ids[i] : ids[i + 1];
        }
        return { hand, ambiguous: true, boundary: b };
      }
    }

    // Outside any hysteresis band — find the slot.
    for (let i = 0; i < splits.length; i++) {
      if (note < splits[i]) return { hand: ids[i], ambiguous: false, boundary: null };
    }
    return { hand: ids[ids.length - 1], ambiguous: false, boundary: null };
  }
}

function median(arr) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * 1‑D k-means clustering on a sorted list of values. Returns an array
 * `bucket[i] ∈ [0, k-1]` indicating the cluster of `values[i]`. Centroids
 * are initialised at evenly spaced quantiles of the input; the loop
 * converges in O(I·N·k) with I ≤ 20 (more than enough for the small
 * inputs we feed it — typically ≤ 16 tracks).
 */
function kmeans1D(values, k) {
  const n = values.length;
  if (n === 0) return [];
  if (k <= 1) return values.map(() => 0);
  if (k >= n) {
    // One cluster per value, in ascending order.
    return values.map((_, i) => i);
  }
  // Initial centroids at evenly-spaced quantiles.
  const sorted = [...values].sort((a, b) => a - b);
  const centroids = [];
  for (let i = 0; i < k; i++) {
    const q = Math.floor(((i + 0.5) / k) * n);
    centroids.push(sorted[Math.min(n - 1, q)]);
  }
  const assign = new Array(n).fill(0);
  for (let iter = 0; iter < 20; iter++) {
    let changed = false;
    // Assign each point to nearest centroid.
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestDist = Math.abs(values[i] - centroids[0]);
      for (let c = 1; c < k; c++) {
        const d = Math.abs(values[i] - centroids[c]);
        if (d < bestDist) { best = c; bestDist = d; }
      }
      if (assign[i] !== best) { assign[i] = best; changed = true; }
    }
    if (!changed) break;
    // Recompute centroids.
    const sums = new Array(k).fill(0);
    const counts = new Array(k).fill(0);
    for (let i = 0; i < n; i++) { sums[assign[i]] += values[i]; counts[assign[i]]++; }
    for (let c = 0; c < k; c++) if (counts[c] > 0) centroids[c] = sums[c] / counts[c];
  }
  // Re-label clusters in ascending centroid order so cluster 0 is the
  // lowest-pitch group (matches `handIds` order: h1 = lowest).
  const order = centroids
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c - b.c)
    .map(o => o.i);
  const label = new Array(k);
  for (let rank = 0; rank < k; rank++) label[order[rank]] = rank;
  return assign.map(c => label[c]);
}

export default HandAssigner;
