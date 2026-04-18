// public/js/audio/MidiSynthesizerTempoMap.js
// Pure tempo-map conversion + sequence binary search helpers extracted
// from MidiSynthesizer.js (P2-F.8b).
// Exposed on `window.MidiSynthesizerTempoMap` (IIFE+globals convention).

(function() {
  'use strict';

  /**
   * Convert ticks to seconds using a tempo map. When `tempoMap` is empty,
   * falls back to the cached `secondsPerTick` factor.
   *
   * @param {number} ticks
   * @param {Array<{ticks:number, tempo:number}>} tempoMap
   * @param {number} ticksPerBeat
   * @param {number} secondsPerTick  Fallback when tempoMap is empty
   */
  function ticksToSeconds({ ticks, tempoMap, ticksPerBeat, secondsPerTick }) {
    if (!tempoMap || tempoMap.length === 0) {
      return ticks * secondsPerTick;
    }

    let seconds = 0;
    let prevTick = 0;
    let currentTempo = tempoMap[0].tempo;

    for (let i = 0; i < tempoMap.length; i++) {
      const entry = tempoMap[i];
      if (entry.ticks >= ticks) break;
      const segmentTicks = entry.ticks - prevTick;
      const ticksPerSecond = (currentTempo / 60) * ticksPerBeat;
      seconds += segmentTicks / ticksPerSecond;
      prevTick = entry.ticks;
      currentTempo = entry.tempo;
    }

    const remainingTicks = ticks - prevTick;
    const ticksPerSecond = (currentTempo / 60) * ticksPerBeat;
    seconds += remainingTicks / ticksPerSecond;
    return seconds;
  }

  /**
   * Convert seconds to ticks using a tempo map. When `tempoMap` is empty,
   * falls back to the cached `ticksPerSecond` factor.
   */
  function secondsToTicks({ seconds, tempoMap, ticksPerBeat, ticksPerSecond }) {
    if (!tempoMap || tempoMap.length === 0) {
      return Math.round(seconds * ticksPerSecond);
    }

    let accumulatedSeconds = 0;
    let prevTick = 0;
    let currentTempo = tempoMap[0].tempo;

    for (let i = 0; i < tempoMap.length; i++) {
      const entry = tempoMap[i];
      const segmentTicks = entry.ticks - prevTick;
      const tps = (currentTempo / 60) * ticksPerBeat;
      const segmentDuration = segmentTicks / tps;

      if (accumulatedSeconds + segmentDuration >= seconds) {
        const remainingSeconds = seconds - accumulatedSeconds;
        return Math.round(prevTick + remainingSeconds * tps);
      }

      accumulatedSeconds += segmentDuration;
      prevTick = entry.ticks;
      currentTempo = entry.tempo;
    }

    const remainingSeconds = seconds - accumulatedSeconds;
    const tps = (currentTempo / 60) * ticksPerBeat;
    return Math.round(prevTick + remainingSeconds * tps);
  }

  /**
   * Binary search the first index `i` in `sequence` such that sequence[i].t > tick.
   * The sequence is assumed sorted by `t` ascending.
   */
  function findNoteIndex(sequence, tick) {
    let lo = 0, hi = sequence.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sequence[mid].t <= tick) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  window.MidiSynthesizerTempoMap = Object.freeze({
    ticksToSeconds,
    secondsToTicks,
    findNoteIndex
  });
})();
