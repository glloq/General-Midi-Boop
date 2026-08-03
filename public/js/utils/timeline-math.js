/**
 * @file shared/timeline-math.js
 * @description Tick ↔ pixel ↔ seconds conversions used by the piano roll,
 * sub-editors, timeline bar, and minimaps.
 *
 * Audit §2.3: every consumer reimplements the same math (>15 occurrences
 * across MidiEditorPlayback, MidiEditorEvents, MidiEditorRouting,
 * PlaybackTimelineBar, VelocityEditor, CCPitchbendEditor…). This module
 * centralises the math AND caches a precomputed projection so a scroll/zoom
 * frame doesn't redo the division for every note rendered.
 *
 * Browser usage:
 *   <script src="../shared/timeline-math.js"></script>
 *   const proj = TimelineMath.createTimelineProjection({ xoffset, xrange, viewportWidth });
 *   proj.tickToX(tick);   // O(1), uses cached scale
 *   proj.xToTick(x);
 *   // Re-use proj as long as none of (xoffset, xrange, viewportWidth) change.
 *
 * Node usage (CommonJS):
 *   const TM = require('../../shared/timeline-math.js');
 *
 * The projection is value-typed: callers compare scalars to decide if a
 * refresh is needed. No subscribers, no allocations in hot paths.
 *
 * Isomorphic: pure JS, no DOM dependency.
 */
(function (root) {
  'use strict';

  /**
   * Build a projection for a given viewport. Cheap to call (one division +
   * one object alloc) but the resulting `tickToX` / `xToTick` are tight
   * closures so a render pass can call them millions of times without
   * recomputing the scale factor.
   *
   * @param {Object} params
   * @param {number} params.xoffset       - First visible tick.
   * @param {number} params.xrange        - Width of the visible window, in ticks.
   * @param {number} params.viewportWidth - Width of the canvas/element, in pixels.
   */
  function createTimelineProjection({ xoffset, xrange, viewportWidth }) {
    const safeRange = xrange > 0 ? xrange : 1;
    const scale = viewportWidth / safeRange; // px per tick
    const invScale = scale > 0 ? 1 / scale : 0;
    const x0 = xoffset;
    return {
      xoffset,
      xrange,
      viewportWidth,
      scale,
      tickToX(tick) {
        return (tick - x0) * scale;
      },
      xToTick(x) {
        return x0 + x * invScale;
      },
      pxToTickDelta(dpx) {
        return dpx * invScale;
      }
    };
  }

  /**
   * True when `b` describes the same viewport as the cached projection `a`.
   * Callers use it to decide whether to reuse a cached projection.
   */
  function isSameViewport(a, b) {
    if (!a) return false;
    return a.xoffset === b.xoffset && a.xrange === b.xrange && a.viewportWidth === b.viewportWidth;
  }

  /**
   * Convert MIDI ticks to seconds using a flat tempo (microseconds per
   * quarter-note). For a real tempo map use a TempoMap consumer; this helper
   * covers the common single-tempo case used for previews/minimaps.
   */
  function ticksToSeconds(ticks, ppq, microsPerQuarter) {
    if (ppq <= 0) return 0;
    return (ticks / ppq) * (microsPerQuarter / 1e6);
  }

  function secondsToTicks(seconds, ppq, microsPerQuarter) {
    if (microsPerQuarter <= 0) return 0;
    return (seconds * ppq * 1e6) / microsPerQuarter;
  }

  function bpmToMicrosPerQuarter(bpm) {
    return bpm > 0 ? 60_000_000 / bpm : 500_000;
  }

  function microsPerQuarterToBpm(mpq) {
    return mpq > 0 ? 60_000_000 / mpq : 120;
  }

  const api = Object.freeze({
    createTimelineProjection,
    isSameViewport,
    ticksToSeconds,
    secondsToTicks,
    bpmToMicrosPerQuarter,
    microsPerQuarterToBpm
  });

  // Browser global.
  if (typeof window !== 'undefined') {
    window.TimelineMath = api;
  }
  // Node / CommonJS.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  // Worker / other (defensive).
  if (typeof root !== 'undefined' && root !== null) {
    root.TimelineMath = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
