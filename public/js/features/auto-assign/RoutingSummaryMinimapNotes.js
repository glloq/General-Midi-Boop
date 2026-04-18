// public/js/features/auto-assign/RoutingSummaryMinimapNotes.js
// Pure note-extraction helper for the minimap canvas (P2-F.4e).
//
// Takes in the current routing state (midiData, assignments, splits,
// adaptation settings) and returns a flat `[{ t, n, ch, seg }]` array
// filtered by the optional channel filter and note-range of the assigned
// instrument. Used by `_renderMinimap` to prepare canvas buckets.
//
// Extracted as a pure module to keep the draw path testable without a
// DOM. Exposed on `window.RoutingSummaryMinimapNotes`.

(function() {
  'use strict';

  /**
   * @param {Object} params
   * @param {Object} params.midiData - parsed MIDI JSON with `tracks[].events[]`
   * @param {Object} params.selectedAssignments - per-channel assignment (UI state)
   * @param {Set<number>} params.splitChannels
   * @param {Object} params.splitAssignments
   * @param {Object} params.adaptationSettings
   * @param {number|null} params.channelFilter - only keep this channel, or null
   * @param {boolean} [params.skipRangeFilter=false] - ignore instrument range + transposition
   * @returns {Array<{ t: number, n: number, ch: number, seg: number }>}
   */
  function extractNotesForMinimap(params) {
    const {
      midiData,
      selectedAssignments = {},
      splitChannels = new Set(),
      splitAssignments = {},
      adaptationSettings = {},
      channelFilter = null,
      skipRangeFilter = false
    } = params;

    const notes = [];
    if (!midiData || !midiData.tracks) return notes;

    const getRange = (ch) => {
      if (skipRangeFilter) return null;
      const chStr = String(ch);
      const assignment = selectedAssignments[chStr];
      if (!assignment) return null;
      if (splitChannels.has(ch) && splitAssignments[ch]) {
        const segs = splitAssignments[ch].segments || [];
        if (segs.length > 0) {
          return {
            min: Math.min(...segs.map((s) => s.fullRange?.min ?? s.noteRange?.min ?? 0)),
            max: Math.max(...segs.map((s) => s.fullRange?.max ?? s.noteRange?.max ?? 127))
          };
        }
      }
      if (assignment.noteRangeMin != null && assignment.noteRangeMax != null) {
        return { min: assignment.noteRangeMin, max: assignment.noteRangeMax };
      }
      return null;
    };

    const getTransposition = (ch) => {
      if (skipRangeFilter) return 0;
      const chStr = String(ch);
      const adapt = adaptationSettings[chStr] || {};
      return adapt.transpositionSemitones || 0;
    };

    const getSplitSegments = (ch) => {
      if (splitChannels.has(ch) && splitAssignments[ch]) {
        const segs = splitAssignments[ch].segments || [];
        if (segs.length > 1) return segs;
      }
      return null;
    };

    for (const track of midiData.tracks) {
      if (!track.events) continue;
      let tick = 0;
      for (const event of track.events) {
        if (event.deltaTime !== undefined) tick += event.deltaTime;
        if (event.type === 'noteOn' && event.velocity > 0) {
          const ch = event.channel ?? 0;
          if (channelFilter !== null && ch !== channelFilter) continue;
          const note = event.note ?? event.noteNumber ?? 60;

          const range = getRange(ch);
          if (range) {
            const transposed = Math.max(0, Math.min(127, note + getTransposition(ch)));
            if (transposed < range.min || transposed > range.max) continue;
          }

          const splitSegs = getSplitSegments(ch);
          if (splitSegs) {
            let matched = false;
            for (let si = 0; si < splitSegs.length; si++) {
              const rMin = splitSegs[si].noteRange?.min ?? 0;
              const rMax = splitSegs[si].noteRange?.max ?? 127;
              if (note >= rMin && note <= rMax) {
                notes.push({ t: tick, n: note, ch, seg: si });
                matched = true;
              }
            }
            if (!matched && splitSegs.length > 0) {
              let bestSeg = 0;
              let bestDist = Infinity;
              for (let si = 0; si < splitSegs.length; si++) {
                const rMin = splitSegs[si].noteRange?.min ?? 0;
                const rMax = splitSegs[si].noteRange?.max ?? 127;
                const dist = note < rMin ? rMin - note : note - rMax;
                if (dist < bestDist) { bestDist = dist; bestSeg = si; }
              }
              notes.push({ t: tick, n: note, ch, seg: bestSeg });
            }
          } else {
            notes.push({ t: tick, n: note, ch, seg: -1 });
          }
        }
      }
    }
    notes.sort((a, b) => a.t - b.t);
    return notes;
  }

  /**
   * Aggregate a flat note list into display buckets for the minimap
   * rendering (P2-F.4g). Returns the shape expected by
   * `RoutingSummaryMinimapRenderer.drawMinimapFrame` :
   *
   *   {
   *     totalTicks: number,
   *     splitMode: boolean,
   *     segments: number[]|null,
   *     channels: number[]|null,
   *     multiChannel: boolean,
   *     buckets: Array<boolean> | Map<number, Array<boolean>>
   *   }
   *
   * @param {Object} params
   * @param {Array<{t,n,ch,seg}>} params.notes - output of extractNotesForMinimap
   * @param {number} params.width - target column count
   * @param {boolean} params.isSplitView
   * @param {number} [params.splitSegmentCount] - used when isSplitView=true
   */
  function buildMinimapBuckets(params) {
    const { notes, width, isSplitView, splitSegmentCount = 0 } = params;
    const totalTicks = notes.length > 0 ? notes[notes.length - 1].t + 1 : 1;

    if (isSplitView && splitSegmentCount > 0) {
      const segments = Array.from({ length: splitSegmentCount }, (_, i) => i);
      const bucketMap = new Map();
      for (const seg of segments) bucketMap.set(seg, new Array(width).fill(false));
      for (const note of notes) {
        const col = Math.floor((note.t / totalTicks) * width);
        if (col >= 0 && col < width && note.seg >= 0 && bucketMap.has(note.seg)) {
          bucketMap.get(note.seg)[col] = true;
        }
      }
      return {
        totalTicks,
        splitMode: true,
        segments,
        channels: null,
        multiChannel: false,
        buckets: bucketMap
      };
    }

    const channelSet = new Set();
    for (const note of notes) channelSet.add(note.ch);
    const channels = Array.from(channelSet).sort((a, b) => a - b);
    const multiChannel = channels.length > 1;

    if (multiChannel) {
      const bucketMap = new Map();
      for (const ch of channels) bucketMap.set(ch, new Array(width).fill(false));
      for (const note of notes) {
        const col = Math.floor((note.t / totalTicks) * width);
        if (col >= 0 && col < width) bucketMap.get(note.ch)[col] = true;
      }
      return { totalTicks, splitMode: false, segments: null, channels, multiChannel: true, buckets: bucketMap };
    }

    const buckets = new Array(width).fill(false);
    for (const note of notes) {
      const col = Math.floor((note.t / totalTicks) * width);
      if (col >= 0 && col < width) buckets[col] = true;
    }
    return { totalTicks, splitMode: false, segments: null, channels, multiChannel: false, buckets };
  }

  window.RoutingSummaryMinimapNotes = Object.freeze({
    extractNotesForMinimap,
    buildMinimapBuckets
  });
})();
