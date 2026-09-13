/**
 * @file tests/transcription/transcription-result.test.js
 * @description The pivot format (§11/§12) is the contract every backend and
 * every consumer agrees on, so its normalisation is pinned here: what is
 * clamped, what is dropped with a warning, what is fatal, and above all that
 * unknown information stays unknown instead of being invented.
 */
import { describe, test, expect } from '@jest/globals';
import {
  TRANSCRIPTION_RESULT_VERSION,
  RESULT_LIMITS,
  normalizeTranscriptionResult,
  createTranscriptionResult,
  summarizeTranscriptionResult,
  emptyTranscriptionResult
} from '../../src/transcription/TranscriptionResult.js';
import { TranscriptionError } from '../../src/transcription/TranscriptionError.js';

/** Minimal well-formed backend output. */
function rawResult(overrides = {}) {
  return {
    source: { filename: 'song.mp3', duration: 12.5 },
    backend: { id: 'fake', version: '1.0.0' },
    tracks: [
      {
        id: 'track-1',
        instrument: { family: 'piano', label: 'Piano', confidence: 0.96, gmProgram: 0 },
        notes: [{ start: 1, end: 1.5, pitch: 64, velocity: 92, confidence: 0.94 }]
      }
    ],
    ...overrides
  };
}

describe('TranscriptionResult — normalisation', () => {
  test('keeps a well-formed result intact and stamps the schema version', () => {
    const result = createTranscriptionResult(rawResult());
    expect(result.version).toBe(TRANSCRIPTION_RESULT_VERSION);
    expect(result.source).toEqual({
      filename: 'song.mp3',
      duration: 12.5,
      sampleRate: null,
      channels: null
    });
    expect(result.backend).toEqual({ id: 'fake', version: '1.0.0', protocolVersion: null });
    expect(result.tracks[0].notes).toEqual([
      { start: 1, end: 1.5, pitch: 64, velocity: 92, confidence: 0.94, expression: null }
    ]);
    expect(result.warnings).toEqual([]);
    expect(typeof result.createdAt).toBe('string');
  });

  test('absent information stays null / empty — nothing is invented', () => {
    const result = createTranscriptionResult({
      tracks: [{ notes: [{ start: 0, end: 1, pitch: 60 }] }]
    });
    expect(result.source.filename).toBeNull();
    expect(result.source.duration).toBeNull();
    // No tempo detected => no tempo map. A default 120 BPM here would be a lie.
    expect(result.tempoMap).toEqual([]);
    expect(result.timeSignatures).toEqual([]);
    const { instrument } = result.tracks[0];
    expect(instrument).toEqual({
      family: null,
      label: null,
      confidence: null,
      gmProgram: null,
      isDrums: false
    });
    // Velocity is the one exception: MIDI has no "unknown", and 0 means note-off.
    expect(result.tracks[0].notes[0].velocity).toBe(64);
    expect(result.tracks[0].id).toBe('track-1');
  });

  test('clamps out-of-range values instead of rejecting the note', () => {
    const result = createTranscriptionResult({
      tracks: [
        {
          notes: [
            { start: 0, end: 1, pitch: 200, velocity: 300, confidence: 5 },
            { start: 2, end: 3, pitch: -4, velocity: 0, confidence: -1 }
          ],
          instrument: { gmProgram: 999 }
        }
      ]
    });
    const [high, low] = result.tracks[0].notes;
    expect(high.pitch).toBe(127);
    expect(high.velocity).toBe(127);
    expect(high.confidence).toBe(1);
    expect(low.pitch).toBe(0);
    expect(low.velocity).toBe(1);
    expect(low.confidence).toBe(0);
    expect(result.tracks[0].instrument.gmProgram).toBe(127);
    expect(result.warnings).toEqual([]);
  });

  test('drops structurally impossible notes and reports them as warnings', () => {
    const result = createTranscriptionResult({
      tracks: [
        {
          notes: [
            { start: 1, end: 2, pitch: 60 },
            { start: 2, end: 2, pitch: 61 },
            { start: -1, end: 3, pitch: 62 },
            { start: Number.NaN, end: 3, pitch: 63 },
            { start: 4, end: 5 },
            'not a note'
          ]
        }
      ]
    });
    expect(result.tracks[0].notes).toHaveLength(1);
    expect(result.warnings).toHaveLength(5);
    expect(result.warnings[0]).toMatch(/discarded malformed data/);
  });

  test('sorts notes by start then pitch so downstream order is deterministic', () => {
    const result = createTranscriptionResult({
      tracks: [
        {
          notes: [
            { start: 2, end: 3, pitch: 60 },
            { start: 1, end: 2, pitch: 72 },
            { start: 1, end: 2, pitch: 48 }
          ]
        }
      ]
    });
    expect(result.tracks[0].notes.map((n) => [n.start, n.pitch])).toEqual([
      [1, 48],
      [1, 72],
      [2, 60]
    ]);
  });

  test('preserves expression curves and sorts them by time', () => {
    const result = createTranscriptionResult({
      tracks: [
        {
          notes: [
            {
              start: 0,
              end: 1,
              pitch: 60,
              expression: {
                pitchCurve: [
                  { t: 0.5, value: 0.3 },
                  { t: 0.1, value: 0 },
                  { t: 0.2, value: 'nope' }
                ],
                amplitudeCurve: []
              }
            }
          ]
        }
      ]
    });
    expect(result.tracks[0].notes[0].expression).toEqual({
      pitchCurve: [
        { t: 0.1, value: 0 },
        { t: 0.5, value: 0.3 }
      ],
      amplitudeCurve: []
    });
  });

  test('an expression object with no usable point collapses to null', () => {
    const result = createTranscriptionResult({
      tracks: [
        {
          notes: [
            { start: 0, end: 1, pitch: 60, expression: { pitchCurve: [], amplitudeCurve: [] } }
          ]
        }
      ]
    });
    expect(result.tracks[0].notes[0].expression).toBeNull();
  });

  test('tempo map and time signatures are filtered and sorted', () => {
    const result = createTranscriptionResult(
      rawResult({
        tempoMap: [
          { time: 10, bpm: 140 },
          { time: 0, bpm: 120 },
          { time: 5, bpm: 0 },
          { time: 6, bpm: 5000 }
        ],
        timeSignatures: [
          { time: 0, numerator: 4, denominator: 4 },
          { time: 8, numerator: 7, denominator: 3 }
        ]
      })
    );
    expect(result.tempoMap).toEqual([
      { time: 0, bpm: 120 },
      { time: 10, bpm: 140 }
    ]);
    expect(result.timeSignatures).toEqual([{ time: 0, numerator: 4, denominator: 4 }]);
  });

  test('isDrums is only ever true when the backend explicitly said so', () => {
    const guessy = createTranscriptionResult({
      tracks: [{ instrument: { family: 'drums', isDrums: 'yes' }, notes: [] }]
    });
    expect(guessy.tracks[0].instrument.isDrums).toBe(false);

    const explicit = createTranscriptionResult({
      tracks: [{ instrument: { family: 'drums', isDrums: true }, notes: [] }]
    });
    expect(explicit.tracks[0].instrument.isDrums).toBe(true);
  });
});

describe('TranscriptionResult — fatal structures', () => {
  test('a non-object result is rejected', () => {
    expect(normalizeTranscriptionResult(null).result).toBeNull();
    expect(normalizeTranscriptionResult([]).result).toBeNull();
    expect(() => createTranscriptionResult('nope')).toThrow(TranscriptionError);
  });

  test('createTranscriptionResult throws a typed BACKEND_FAILED error', () => {
    expect.assertions(3);
    try {
      createTranscriptionResult({ tracks: 'not-an-array' }, { backendId: 'fake' });
    } catch (error) {
      expect(error).toBeInstanceOf(TranscriptionError);
      expect(error.reason).toBe('BACKEND_FAILED');
      expect(error.backendId).toBe('fake');
    }
  });

  test('refuses an absurd number of tracks or notes rather than allocating them', () => {
    const tracks = Array.from({ length: RESULT_LIMITS.MAX_TRACKS + 1 }, () => ({ notes: [] }));
    expect(normalizeTranscriptionResult({ tracks }).result).toBeNull();

    const fatNotes = { length: RESULT_LIMITS.MAX_NOTES_PER_TRACK + 1 };
    const huge = normalizeTranscriptionResult({
      tracks: [{ notes: Array.from(fatNotes, () => ({ start: 0, end: 1, pitch: 60 })) }]
    });
    expect(huge.result).toBeNull();
    expect(huge.errors[0]).toMatch(/max/);
  });
});

describe('summarizeTranscriptionResult', () => {
  test('reports detected instruments, confidence and low-confidence notes', () => {
    const result = createTranscriptionResult({
      source: { filename: 'song.mp3', duration: 30 },
      tracks: [
        {
          id: 'track-1',
          instrument: { family: 'piano', label: 'Piano', confidence: 0.96 },
          notes: [
            { start: 0, end: 1, pitch: 60, confidence: 0.9 },
            { start: 1, end: 2, pitch: 62, confidence: 0.2 }
          ]
        },
        {
          id: 'track-2',
          instrument: { family: 'drums', isDrums: true },
          notes: [{ start: 0, end: 0.2, pitch: 36, confidence: 0.4 }]
        }
      ]
    });

    const summary = summarizeTranscriptionResult(result);
    expect(summary.trackCount).toBe(2);
    expect(summary.noteCount).toBe(3);
    expect(summary.lowConfidenceNotes).toBe(2);
    expect(summary.duration).toBe(30);
    expect(summary.hasDrums).toBe(true);
    expect(summary.instruments[0]).toMatchObject({
      trackId: 'track-1',
      label: 'Piano',
      confidence: 0.96,
      noteCount: 2
    });
    // No instrument confidence reported => fall back to the mean note confidence.
    expect(summary.instruments[1].confidence).toBeCloseTo(0.4, 5);
  });

  test('honours a custom low-confidence threshold', () => {
    const result = createTranscriptionResult({
      tracks: [{ notes: [{ start: 0, end: 1, pitch: 60, confidence: 0.7 }] }]
    });
    expect(summarizeTranscriptionResult(result).lowConfidenceNotes).toBe(0);
    expect(
      summarizeTranscriptionResult(result, { lowConfidenceThreshold: 0.8 }).lowConfidenceNotes
    ).toBe(1);
  });

  test('a backend that reports no confidence is not counted as low-confidence', () => {
    const result = createTranscriptionResult({
      tracks: [{ notes: [{ start: 0, end: 1, pitch: 60 }] }]
    });
    const summary = summarizeTranscriptionResult(result);
    expect(summary.lowConfidenceNotes).toBe(0);
    expect(summary.instruments[0].confidence).toBeNull();
  });

  test('falls back to the last note offset when the source duration is unknown', () => {
    const result = createTranscriptionResult({
      tracks: [{ notes: [{ start: 0, end: 4.25, pitch: 60 }] }]
    });
    expect(summarizeTranscriptionResult(result).duration).toBe(4.25);
  });
});

describe('emptyTranscriptionResult', () => {
  test('is a valid, empty, summarisable result', () => {
    const result = emptyTranscriptionResult({ filename: 'silence.wav', backendId: 'fake' });
    expect(result.tracks).toEqual([]);
    expect(result.source.filename).toBe('silence.wav');
    expect(result.backend.id).toBe('fake');
    expect(summarizeTranscriptionResult(result)).toMatchObject({
      trackCount: 0,
      noteCount: 0,
      duration: 0,
      hasDrums: false
    });
  });
});
