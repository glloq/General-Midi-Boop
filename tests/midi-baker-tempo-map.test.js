// tests/midi-baker-tempo-map.test.js
//
// Audit B2/B3 open item: MidiBaker._ticksToSeconds / _secondsToTicks scanned the
// tempo map linearly on EVERY event during hand-position CC generation
// (O(events × tempo-changes) → bake freeze on a dense tempo map). They now use a
// binary search over the (tick- and time-sorted) map. These tests pin that the
// binary search returns exactly what the old linear scan did, and that the
// tick↔seconds round-trip is stable.

import { describe, test, expect } from '@jest/globals';
import MidiBaker from '../src/files/MidiBaker.js';

// The conversion methods use only their args + this._activeTempoEntry (no
// instance state), so a bare prototype instance avoids the constructor's deps.
const baker = Object.create(MidiBaker.prototype);

// Reference implementation = the pre-refactor linear scan, to assert equivalence.
const linearTicksToSeconds = (ticks, map, ppq) => {
  let active = map[0];
  for (const e of map) {
    if (e.tick <= ticks) active = e;
    else break;
  }
  return active.time + (ticks - active.tick) * (active.microsecondsPerBeat / (ppq * 1e6));
};
const linearSecondsToTicks = (seconds, map, ppq) => {
  let active = map[0];
  for (const e of map) {
    if (e.time <= seconds) active = e;
    else break;
  }
  const spt = active.microsecondsPerBeat / (ppq * 1e6);
  return Math.round(active.tick + (seconds - active.time) / spt);
};

describe('MidiBaker tempo-map conversion (binary search, audit B2/B3)', () => {
  const ppq = 480;
  // Internally-consistent multi-entry map (time = cumulative from the µs values),
  // exactly the shape _buildTempoMap produces: sorted asc in both tick and time.
  const map = [
    { tick: 0, time: 0, microsecondsPerBeat: 500000 }, // 120 BPM
    { tick: 1920, time: 2.0, microsecondsPerBeat: 400000 }, // 150 BPM
    { tick: 3840, time: 3.6, microsecondsPerBeat: 600000 }, // 100 BPM
    { tick: 9600, time: 10.8, microsecondsPerBeat: 300000 } // 200 BPM
  ];

  test('_ticksToSeconds matches the linear scan across and beyond the map', () => {
    for (const t of [-10, 0, 500, 1919, 1920, 2000, 3840, 5000, 9600, 20000]) {
      expect(baker._ticksToSeconds(t, map, ppq)).toBeCloseTo(linearTicksToSeconds(t, map, ppq), 9);
    }
  });

  test('_secondsToTicks matches the linear scan across and beyond the map', () => {
    for (const s of [-1, 0, 1, 2.0, 3.0, 3.6, 8, 10.8, 30]) {
      expect(baker._secondsToTicks(s, map, ppq)).toBe(linearSecondsToTicks(s, map, ppq));
    }
  });

  test('round-trips tick → seconds → tick within every segment', () => {
    for (const t of [0, 1000, 1920, 5000, 9600, 12000]) {
      const s = baker._ticksToSeconds(t, map, ppq);
      expect(baker._secondsToTicks(s, map, ppq)).toBe(t);
    }
  });

  test('single-entry map behaves like a constant tempo', () => {
    const one = [{ tick: 0, time: 0, microsecondsPerBeat: 500000 }];
    expect(baker._ticksToSeconds(960, one, ppq)).toBeCloseTo(1.0, 9); // 960 ticks @120bpm
    expect(baker._secondsToTicks(1.0, one, ppq)).toBe(960);
  });
});
