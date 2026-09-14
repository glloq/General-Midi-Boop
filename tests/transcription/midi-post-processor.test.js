/**
 * @file tests/transcription/midi-post-processor.test.js
 * @description The musical clean-up of §13: what each preset removes, what
 * it never does on its own (quantise), and the repair that runs even in
 * `raw` because MIDI has no meaning without it (self-overlap).
 */
import { describe, test, expect } from '@jest/globals';
import {
  MidiPostProcessor,
  PRESETS,
  PRESET_NAMES,
  dedupe,
  mergeRepeats,
  fixOverlaps,
  normalizeVelocities,
  quantize,
  simplifyCurve,
  tempoAt
} from '../../src/transcription/MidiPostProcessor.js';
import { createTranscriptionResult } from '../../src/transcription/TranscriptionResult.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const processor = new MidiPostProcessor({ logger: silentLogger });

/** Build a one-track result from bare note tuples. */
function resultWith(notes, extra = {}) {
  return createTranscriptionResult({
    source: { filename: 'song.wav', duration: 30 },
    tracks: [{ id: 'track-1', instrument: { family: 'piano' }, notes }],
    ...extra
  });
}

describe('presets', () => {
  test('the three documented presets exist and quantisation is off in all of them', () => {
    expect(PRESET_NAMES).toEqual(['raw', 'balanced', 'clean']);
    for (const name of PRESET_NAMES) {
      expect(PRESETS[name].quantizeGrid).toBeNull();
      expect(PRESETS[name].fixOverlaps).toBe(true);
    }
  });

  test('an unknown preset falls back to balanced rather than to nothing', () => {
    const outcome = processor.process(resultWith([{ start: 0, end: 0.005, pitch: 60 }]), {
      preset: 'aggressive'
    });
    expect(outcome.preset).toBe('balanced');
  });

  test('raw keeps material that balanced and clean remove', () => {
    const notes = [
      { start: 0, end: 0.01, pitch: 60, confidence: 0.1 },
      { start: 1, end: 2, pitch: 62, confidence: 0.95 }
    ];
    expect(
      processor.process(resultWith(notes), { preset: 'raw' }).result.tracks[0].notes
    ).toHaveLength(2);
    expect(
      processor.process(resultWith(notes), { preset: 'balanced' }).result.tracks[0].notes
    ).toHaveLength(1);
    expect(
      processor.process(resultWith(notes), { preset: 'clean' }).result.tracks[0].notes
    ).toHaveLength(1);
  });

  test('clean drops low-confidence notes; balanced does not', () => {
    const notes = [
      { start: 0, end: 1, pitch: 60, confidence: 0.2 },
      { start: 2, end: 3, pitch: 62, confidence: 0.9 }
    ];
    expect(
      processor.process(resultWith(notes), { preset: 'balanced' }).stats.droppedLowConfidence
    ).toBe(0);
    expect(
      processor.process(resultWith(notes), { preset: 'clean' }).stats.droppedLowConfidence
    ).toBe(1);
  });

  test('a note with no reported confidence is never dropped by the confidence filter', () => {
    const outcome = processor.process(resultWith([{ start: 0, end: 1, pitch: 60 }]), {
      preset: 'clean'
    });
    expect(outcome.stats.droppedLowConfidence).toBe(0);
    expect(outcome.result.tracks[0].notes).toHaveLength(1);
  });

  test('explicit options override the preset', () => {
    const outcome = processor.process(
      resultWith([{ start: 0, end: 1, pitch: 60, confidence: 0.5 }]),
      {
        preset: 'balanced',
        options: { minConfidence: 0.9 }
      }
    );
    expect(outcome.result.tracks).toHaveLength(0);
    expect(outcome.stats.droppedLowConfidence).toBe(1);
  });

  test('never mutates the input result', () => {
    const input = resultWith([{ start: 0, end: 0.005, pitch: 60 }]);
    const before = JSON.stringify(input);
    processor.process(input, { preset: 'clean' });
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('filters', () => {
  test('de-duplication keeps the strongest of a cluster and extends its tail', () => {
    const notes = [
      { start: 1.0, end: 1.2, pitch: 60, velocity: 60, confidence: 0.4, expression: null },
      { start: 1.005, end: 1.5, pitch: 60, velocity: 90, confidence: 0.9, expression: null }
    ];
    const kept = dedupe(notes, 0.01);
    expect(kept).toHaveLength(1);
    expect(kept[0].start).toBe(1.0);
    expect(kept[0].end).toBe(1.5);
    expect(kept[0].velocity).toBe(90);
  });

  test('de-duplication leaves a genuine repeat alone', () => {
    const notes = [
      { start: 1.0, end: 1.2, pitch: 60, velocity: 90, confidence: null },
      { start: 1.5, end: 1.7, pitch: 60, velocity: 90, confidence: null }
    ];
    expect(dedupe(notes, 0.01)).toHaveLength(2);
  });

  test('repeated frames of a held note merge into one sustained note', () => {
    const notes = [
      { start: 0, end: 0.2, pitch: 64, velocity: 70, confidence: 0.8 },
      { start: 0.21, end: 0.4, pitch: 64, velocity: 80, confidence: 0.9 },
      { start: 0.42, end: 0.6, pitch: 64, velocity: 60, confidence: 0.7 }
    ];
    const merged = mergeRepeats(notes, 0.03);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ start: 0, end: 0.6, velocity: 80, confidence: 0.9 });
  });

  test('self-overlap is repaired in every preset, raw included', () => {
    const notes = [
      { start: 0, end: 2, pitch: 60 },
      { start: 1, end: 3, pitch: 60 }
    ];
    const outcome = processor.process(resultWith(notes), { preset: 'raw' });
    const [first, second] = outcome.result.tracks[0].notes;
    expect(first.end).toBeLessThan(second.start);
    expect(outcome.stats.overlapsFixed).toBe(1);
  });

  test('overlap repair never inverts a note', () => {
    const notes = [
      { start: 1, end: 5, pitch: 60 },
      { start: 1.0005, end: 6, pitch: 60 }
    ];
    fixOverlaps(notes);
    expect(notes[0].end).toBeGreaterThan(notes[0].start);
  });

  test('different pitches never collide', () => {
    const notes = [
      { start: 0, end: 2, pitch: 60 },
      { start: 1, end: 3, pitch: 64 }
    ];
    expect(fixOverlaps(notes)).toBe(0);
  });
});

describe('velocity normalisation', () => {
  test('stretches the dynamic range into the target window', () => {
    const notes = [{ velocity: 20 }, { velocity: 60 }, { velocity: 100 }];
    normalizeVelocities(notes, 40, 120);
    expect(notes.map((n) => n.velocity)).toEqual([40, 80, 120]);
  });

  test('a flat track is left alone — no dynamic is not a dynamic to invent', () => {
    const notes = [{ velocity: 64 }, { velocity: 64 }];
    normalizeVelocities(notes, 40, 120);
    expect(notes.map((n) => n.velocity)).toEqual([64, 64]);
  });

  test('stays inside the MIDI range', () => {
    const notes = [{ velocity: 1 }, { velocity: 127 }];
    normalizeVelocities(notes, -50, 500);
    expect(notes.every((n) => n.velocity >= 1 && n.velocity <= 127)).toBe(true);
  });
});

describe('quantisation (opt-in only)', () => {
  test('snaps to the grid when explicitly enabled', () => {
    // 120 BPM → a beat is 0.5 s, a sixteenth is 0.125 s.
    const notes = [{ start: 0.13, end: 0.38, pitch: 60 }];
    const moved = quantize(notes, 0.25, 2);
    expect(moved).toBe(1);
    expect(notes[0].start).toBeCloseTo(0.125, 5);
    expect(notes[0].end).toBeCloseTo(0.375, 5);
  });

  test('never quantises a note out of existence', () => {
    const notes = [{ start: 0.01, end: 0.02, pitch: 60 }];
    quantize(notes, 0.25, 2);
    expect(notes[0].end).toBeGreaterThan(notes[0].start);
  });

  test('does nothing without a usable grid or tempo', () => {
    const notes = [{ start: 0.13, end: 0.38, pitch: 60 }];
    expect(quantize(notes, 0, 2)).toBe(0);
    expect(quantize(notes, 0.25, 0)).toBe(0);
    expect(notes[0].start).toBe(0.13);
  });

  test('is off by default even in clean', () => {
    const outcome = processor.process(resultWith([{ start: 0.13, end: 0.9, pitch: 60 }]), {
      preset: 'clean'
    });
    expect(outcome.stats.quantized).toBe(0);
    expect(outcome.result.tracks[0].notes[0].start).toBe(0.13);
  });
});

describe('curve simplification', () => {
  test('keeps the shape and drops the redundant points of a straight line', () => {
    const line = Array.from({ length: 20 }, (_, i) => ({ t: i * 0.01, value: i * 0.1 }));
    const simplified = simplifyCurve(line, 0.01);
    expect(simplified.length).toBeLessThan(line.length);
    expect(simplified[0]).toEqual(line[0]);
    expect(simplified[simplified.length - 1]).toEqual(line[line.length - 1]);
  });

  test('keeps a genuine inflection point', () => {
    const points = [
      { t: 0, value: 0 },
      { t: 1, value: 5 },
      { t: 2, value: 0 }
    ];
    expect(simplifyCurve(points, 0.1)).toHaveLength(3);
  });

  test('a flat curve is dropped entirely — two pointless events are worse than none', () => {
    const flat = [
      { t: 0, value: 0.5 },
      { t: 1, value: 0.5 },
      { t: 2, value: 0.5 }
    ];
    expect(simplifyCurve(flat, 0.05)).toEqual([]);
  });

  test('handles degenerate inputs', () => {
    expect(simplifyCurve([], 0.1)).toEqual([]);
    expect(simplifyCurve(null, 0.1)).toEqual([]);
    expect(simplifyCurve([{ t: 0, value: 1 }], 0.1)).toHaveLength(1);
  });

  test('survives a very long curve without blowing the stack', () => {
    const points = Array.from({ length: 20000 }, (_, i) => ({
      t: i * 0.001,
      value: Math.sin(i / 50)
    }));
    expect(() => simplifyCurve(points, 0.01)).not.toThrow();
  });

  test('the processor simplifies note expression and drops empty curves', () => {
    const notes = [
      {
        start: 0,
        end: 1,
        pitch: 60,
        expression: {
          pitchCurve: Array.from({ length: 50 }, (_, i) => ({ t: i * 0.02, value: 0 })),
          amplitudeCurve: []
        }
      }
    ];
    const outcome = processor.process(resultWith(notes), { preset: 'balanced' });
    expect(outcome.result.tracks[0].notes[0].expression).toBeNull();
    expect(outcome.stats.curvePointsIn).toBe(50);
    expect(outcome.stats.curvePointsOut).toBe(0);
  });
});

describe('reporting', () => {
  test('turns what it did into user-readable warnings', () => {
    // Filters run in a fixed order, and the warnings name the filter that
    // actually removed each note: the 5 ms note below is dropped by the
    // confidence filter (which runs first), not by the duration filter.
    const notes = [
      { start: 0, end: 0.005, pitch: 60, confidence: 0.1 },
      { start: 1, end: 3, pitch: 62, confidence: 0.9 },
      { start: 2, end: 4, pitch: 62, confidence: 0.9 }
    ];
    const outcome = processor.process(resultWith(notes), { preset: 'clean' });
    expect(outcome.result.warnings.join(' ')).toMatch(/low-confidence notes removed/);
    // The two pitch-62 notes are a held note re-triggered: merged, not
    // shortened — `clean` merges before it repairs overlaps.
    expect(outcome.result.warnings.join(' ')).toMatch(/repeated notes merged/);
    expect(outcome.result.tracks[0].notes).toEqual([
      expect.objectContaining({ pitch: 62, start: 1, end: 4 })
    ]);
  });

  test('reports a short-note removal when no confidence filter claimed it first', () => {
    const outcome = processor.process(
      resultWith([
        { start: 0, end: 0.005, pitch: 60 },
        { start: 1, end: 2, pitch: 62 }
      ]),
      { preset: 'balanced' }
    );
    expect(outcome.stats.droppedShort).toBe(1);
    expect(outcome.result.warnings.join(' ')).toMatch(/very short notes removed/);
  });

  test('reports an overlap repair when the gap is too wide to merge', () => {
    const outcome = processor.process(
      resultWith([
        { start: 0, end: 5, pitch: 60 },
        { start: 2, end: 6, pitch: 60 }
      ]),
      { preset: 'balanced' }
    );
    expect(outcome.stats.overlapsFixed).toBe(1);
    expect(outcome.result.warnings.join(' ')).toMatch(/overlapping notes shortened/);
  });

  test('drops tracks the filters emptied, and says so', () => {
    const outcome = processor.process(resultWith([{ start: 0, end: 0.002, pitch: 60 }]), {
      preset: 'balanced'
    });
    expect(outcome.result.tracks).toHaveLength(0);
    expect(outcome.stats.tracksDropped).toBe(1);
    expect(outcome.result.warnings.join(' ')).toMatch(/empty tracks removed/);
  });

  test('keeps the warnings the engine itself reported', () => {
    const input = resultWith([{ start: 0, end: 1, pitch: 60 }], {
      warnings: ['engine said hello']
    });
    const outcome = processor.process(input, { preset: 'raw' });
    expect(outcome.result.warnings).toContain('engine said hello');
  });
});

describe('tempoAt', () => {
  test('defaults to 120 with no tempo map and follows changes otherwise', () => {
    expect(tempoAt([], 5)).toBe(120);
    expect(tempoAt(null, 5)).toBe(120);
    const map = [
      { time: 0, bpm: 90 },
      { time: 10, bpm: 140 }
    ];
    expect(tempoAt(map, 0)).toBe(90);
    expect(tempoAt(map, 9.9)).toBe(90);
    expect(tempoAt(map, 10)).toBe(140);
  });
});
