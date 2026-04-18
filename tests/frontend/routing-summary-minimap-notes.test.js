// tests/frontend/routing-summary-minimap-notes.test.js
// Unit tests for the pure `extractNotesForMinimap` function (P2-F.4e).

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const win = {};

function load(relativePath) {
  const src = readFileSync(resolve(__dirname, relativePath), 'utf8');
  new Function('window', src)(win);
}

beforeAll(() => {
  load('../../public/js/features/auto-assign/RoutingSummaryMinimapNotes.js');
});

const extract = (args) => win.RoutingSummaryMinimapNotes.extractNotesForMinimap(args);

function makeMidi(trackEvents) {
  return { tracks: [{ events: trackEvents }] };
}

function noteOn(delta, channel, note, velocity = 80) {
  return { deltaTime: delta, type: 'noteOn', channel, note, velocity };
}

describe('extractNotesForMinimap — guards', () => {
  it('returns empty when midiData is missing', () => {
    expect(extract({})).toEqual([]);
    expect(extract({ midiData: null })).toEqual([]);
    expect(extract({ midiData: {} })).toEqual([]);
  });

  it('ignores tracks without events', () => {
    const out = extract({ midiData: { tracks: [{}, { events: [noteOn(10, 0, 60)] }] } });
    expect(out).toHaveLength(1);
  });

  it('ignores noteOn with zero velocity (treated as noteOff)', () => {
    const midiData = makeMidi([noteOn(0, 0, 60, 0), noteOn(10, 0, 60, 80)]);
    const out = extract({ midiData });
    expect(out).toHaveLength(1);
    expect(out[0].n).toBe(60);
  });
});

describe('extractNotesForMinimap — channel filter', () => {
  it('keeps only the requested channel', () => {
    const midiData = makeMidi([noteOn(0, 0, 60), noteOn(10, 1, 62), noteOn(10, 0, 64)]);
    const out = extract({ midiData, channelFilter: 0 });
    expect(out.map((n) => n.n)).toEqual([60, 64]);
  });

  it('keeps all channels when filter is null', () => {
    const midiData = makeMidi([noteOn(0, 0, 60), noteOn(10, 5, 62)]);
    const out = extract({ midiData });
    expect(out).toHaveLength(2);
  });
});

describe('extractNotesForMinimap — range filter', () => {
  it('drops notes outside the instrument range', () => {
    const midiData = makeMidi([noteOn(0, 0, 30), noteOn(10, 0, 60), noteOn(10, 0, 100)]);
    const out = extract({
      midiData,
      selectedAssignments: { 0: { noteRangeMin: 40, noteRangeMax: 80 } }
    });
    expect(out.map((n) => n.n)).toEqual([60]);
  });

  it('applies transposition before range check', () => {
    const midiData = makeMidi([noteOn(0, 0, 30)]);
    // note=30, +12 → 42, range[40-80] → kept
    const out = extract({
      midiData,
      selectedAssignments: { 0: { noteRangeMin: 40, noteRangeMax: 80 } },
      adaptationSettings: { 0: { transpositionSemitones: 12 } }
    });
    expect(out).toHaveLength(1);
  });

  it('skipRangeFilter=true ignores the range entirely', () => {
    const midiData = makeMidi([noteOn(0, 0, 10)]);
    const out = extract({
      midiData,
      selectedAssignments: { 0: { noteRangeMin: 60, noteRangeMax: 72 } },
      skipRangeFilter: true
    });
    expect(out).toHaveLength(1);
  });
});

describe('extractNotesForMinimap — split segments', () => {
  it('assigns seg=-1 when no split', () => {
    const midiData = makeMidi([noteOn(0, 0, 60)]);
    const out = extract({ midiData });
    expect(out[0].seg).toBe(-1);
  });

  it('assigns the segment index for in-range notes', () => {
    const midiData = makeMidi([noteOn(0, 0, 50), noteOn(10, 0, 80)]);
    const out = extract({
      midiData,
      splitChannels: new Set([0]),
      splitAssignments: {
        0: {
          segments: [
            { noteRange: { min: 0, max: 63 } },
            { noteRange: { min: 64, max: 127 } }
          ]
        }
      }
    });
    expect(out.find((n) => n.n === 50).seg).toBe(0);
    expect(out.find((n) => n.n === 80).seg).toBe(1);
  });

  it('assigns to closest segment when note is out of all ranges', () => {
    const midiData = makeMidi([noteOn(0, 0, 30)]);
    const out = extract({
      midiData,
      splitChannels: new Set([0]),
      splitAssignments: {
        0: {
          segments: [
            { noteRange: { min: 60, max: 80 } },
            { noteRange: { min: 90, max: 127 } }
          ]
        }
      }
    });
    expect(out).toHaveLength(1);
    expect(out[0].seg).toBe(0); // closest to 60
  });

  it('adds a note once per overlapping segment', () => {
    const midiData = makeMidi([noteOn(0, 0, 70)]);
    const out = extract({
      midiData,
      splitChannels: new Set([0]),
      splitAssignments: {
        0: {
          segments: [
            { noteRange: { min: 60, max: 80 } },
            { noteRange: { min: 70, max: 90 } }
          ]
        }
      }
    });
    // 70 is in both segments → 2 entries
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.seg).sort()).toEqual([0, 1]);
  });
});

describe('extractNotesForMinimap — ordering', () => {
  it('sorts the output by tick', () => {
    const midiData = makeMidi([noteOn(0, 0, 60), noteOn(5, 0, 62), noteOn(10, 0, 64)]);
    const out = extract({ midiData });
    expect(out.map((n) => n.t)).toEqual([0, 5, 15]);
  });
});

// --------------------------------------------------------------------------
// buildMinimapBuckets (P2-F.4g)
// --------------------------------------------------------------------------

const build = (args) => win.RoutingSummaryMinimapNotes.buildMinimapBuckets(args);

describe('buildMinimapBuckets — single-channel', () => {
  it('returns a flat boolean array for a single channel', () => {
    const notes = [
      { t: 0, n: 60, ch: 0, seg: -1 },
      { t: 50, n: 62, ch: 0, seg: -1 },
      { t: 99, n: 64, ch: 0, seg: -1 }
    ];
    const out = build({ notes, width: 10, isSplitView: false });
    expect(out.splitMode).toBe(false);
    expect(out.multiChannel).toBe(false);
    expect(Array.isArray(out.buckets)).toBe(true);
    expect(out.buckets).toHaveLength(10);
    // totalTicks = last_tick + 1 = 100
    expect(out.totalTicks).toBe(100);
    // Column assignment : 0→0, 50→5, 99→9
    expect(out.buckets[0]).toBe(true);
    expect(out.buckets[5]).toBe(true);
    expect(out.buckets[9]).toBe(true);
    expect(out.buckets[1]).toBe(false);
  });

  it('uses totalTicks=1 when notes is empty', () => {
    const out = build({ notes: [], width: 4, isSplitView: false });
    expect(out.totalTicks).toBe(1);
    expect(out.buckets).toEqual([false, false, false, false]);
  });
});

describe('buildMinimapBuckets — multi-channel', () => {
  it('builds one row per active channel', () => {
    const notes = [
      { t: 0, n: 60, ch: 0, seg: -1 },
      { t: 50, n: 62, ch: 3, seg: -1 }
    ];
    const out = build({ notes, width: 10, isSplitView: false });
    expect(out.multiChannel).toBe(true);
    expect(out.channels).toEqual([0, 3]);
    expect(out.buckets.get(0)[0]).toBe(true);
    expect(out.buckets.get(3)[9]).toBe(true); // totalTicks = 51, 50/51*10 = 9.8 → 9
  });
});

describe('buildMinimapBuckets — split view', () => {
  it('creates one row per segment, indexed by seg number', () => {
    const notes = [
      { t: 0, n: 30, ch: 0, seg: 0 },
      { t: 99, n: 80, ch: 0, seg: 1 }
    ];
    const out = build({ notes, width: 10, isSplitView: true, splitSegmentCount: 2 });
    expect(out.splitMode).toBe(true);
    expect(out.segments).toEqual([0, 1]);
    expect(out.multiChannel).toBe(false);
    expect(out.buckets.get(0)[0]).toBe(true);
    expect(out.buckets.get(1)[9]).toBe(true);
  });

  it('ignores notes with seg < 0 in split mode', () => {
    const notes = [
      { t: 0, n: 60, ch: 0, seg: -1 },
      { t: 50, n: 62, ch: 0, seg: 0 }
    ];
    const out = build({ notes, width: 10, isSplitView: true, splitSegmentCount: 1 });
    expect(out.buckets.get(0).filter(Boolean)).toHaveLength(1);
  });
});
