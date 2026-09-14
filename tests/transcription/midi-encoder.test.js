/**
 * @file tests/transcription/midi-encoder.test.js
 * @description The bytes GMB will actually store. Every assertion goes
 * through the REAL `midi-file` parser and GMB's own validator/parser, so a
 * file that these tests accept is a file `FileManager.handleUpload()` will
 * accept (§43 — the pipeline is tested without a model).
 */
import { describe, test, expect } from '@jest/globals';
import { parseMidi } from 'midi-file';
import {
  MidiEncoder,
  TempoTimeline,
  resolveProgram,
  semitonesToBend,
  rpnPitchBendRange,
  toDeltaEvents,
  DEFAULT_PPQ,
  MELODIC_CHANNELS
} from '../../src/transcription/MidiEncoder.js';
import { createTranscriptionResult } from '../../src/transcription/TranscriptionResult.js';
import MidiFileValidator from '../../src/files/MidiFileValidator.js';
import MidiFileParser from '../../src/files/MidiFileParser.js';
import { TranscriptionError } from '../../src/transcription/TranscriptionError.js';
import { GM_DRUM_CHANNEL } from '../../src/transcription/gm/DrumMapper.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const encoder = new MidiEncoder({ logger: silentLogger });

/** Collect the absolute-tick events of a parsed track. */
function absoluteEvents(track) {
  let tick = 0;
  return track.map((event) => {
    tick += event.deltaTime;
    return { ...event, tick };
  });
}

function resultWith(tracks, extra = {}) {
  return createTranscriptionResult({
    source: { filename: 'song.mp3', duration: 10 },
    backend: { id: 'fake', version: '1.0.0' },
    tracks,
    ...extra
  });
}

describe('file structure', () => {
  test('produces a Format 1 file the GMB validator accepts', () => {
    const { buffer } = encoder.encode(
      resultWith([
        {
          id: 'track-1',
          instrument: { family: 'piano', label: 'Piano', gmProgram: 0 },
          notes: [
            { start: 0, end: 1, pitch: 60, velocity: 90 },
            { start: 1, end: 2, pitch: 64, velocity: 80 }
          ]
        }
      ])
    );

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.subarray(0, 4).toString('ascii')).toBe('MThd');

    const midi = parseMidi(buffer);
    expect(midi.header.format).toBe(1);
    expect(midi.header.ticksPerBeat).toBe(DEFAULT_PPQ);
    // Conductor track + one instrument track.
    expect(midi.tracks).toHaveLength(2);

    const verdict = new MidiFileValidator(silentLogger).validate(midi);
    expect(verdict.valid).toBe(true);
    expect(verdict.stats.totalNotes).toBe(2);
  });

  test('GMB’s own parser extracts sane metadata from it', () => {
    const { buffer } = encoder.encode(
      resultWith([
        {
          id: 'track-1',
          instrument: { family: 'piano', gmProgram: 0 },
          notes: [{ start: 0, end: 2, pitch: 60, velocity: 90 }]
        }
      ])
    );
    const parser = new MidiFileParser(silentLogger);
    const midi = parseMidi(buffer);
    const metadata = parser.extractMetadata(midi);
    expect(metadata.duration).toBeGreaterThan(1.9);
    expect(metadata.duration).toBeLessThan(2.2);

    const instruments = parser.extractInstrumentMetadata(midi);
    expect(instruments.fileMetadata.channel_count).toBe(1);
  });

  test('refuses to write a file with nothing in it', () => {
    const error = (() => {
      try {
        encoder.encode(resultWith([]));
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(TranscriptionError);
    expect(error.reason).toBe('MIDI_GENERATION_FAILED');
  });

  test('every track ends with endOfTrack', () => {
    const { buffer } = encoder.encode(
      resultWith([{ id: 't', instrument: {}, notes: [{ start: 0, end: 1, pitch: 60 }] }])
    );
    for (const track of parseMidi(buffer).tracks) {
      expect(track[track.length - 1].type).toBe('endOfTrack');
    }
  });
});

describe('tempo', () => {
  test('writes no Set Tempo when the engine detected none — 120 is the SMF default, not a claim', () => {
    const { buffer } = encoder.encode(
      resultWith([{ id: 't', instrument: {}, notes: [{ start: 0, end: 1, pitch: 60 }] }])
    );
    const events = parseMidi(buffer).tracks.flat();
    expect(events.some((e) => e.type === 'setTempo')).toBe(false);
  });

  test('writes the detected tempo map on the conductor track', () => {
    const { buffer } = encoder.encode(
      resultWith([{ id: 't', instrument: {}, notes: [{ start: 0, end: 1, pitch: 60 }] }], {
        tempoMap: [
          { time: 0, bpm: 90 },
          { time: 4, bpm: 140 }
        ]
      })
    );
    const tempos = parseMidi(buffer).tracks[0].filter((e) => e.type === 'setTempo');
    expect(tempos).toHaveLength(2);
    expect(tempos[0].microsecondsPerBeat).toBe(Math.round(60000000 / 90));
    expect(tempos[1].microsecondsPerBeat).toBe(Math.round(60000000 / 140));
  });

  test('a tempo change moves later notes, it does not shift them all', () => {
    const timeline = new TempoTimeline(
      [
        { time: 0, bpm: 60 },
        { time: 2, bpm: 120 }
      ],
      480
    );
    // 2 s at 60 BPM = 2 beats = 960 ticks.
    expect(timeline.toTicks(2)).toBe(960);
    // +1 s at 120 BPM = 2 more beats.
    expect(timeline.toTicks(3)).toBe(960 + 960);
  });

  test('with no tempo map, time maps at the SMF default of 120 BPM', () => {
    const timeline = new TempoTimeline([], 480);
    expect(timeline.toTicks(1)).toBe(960);
    expect(timeline.toTicks(-5)).toBe(0);
  });

  test('writes detected time signatures', () => {
    const { buffer } = encoder.encode(
      resultWith([{ id: 't', instrument: {}, notes: [{ start: 0, end: 1, pitch: 60 }] }], {
        timeSignatures: [{ time: 0, numerator: 3, denominator: 4 }]
      })
    );
    const signature = parseMidi(buffer).tracks[0].find((e) => e.type === 'timeSignature');
    expect(signature).toMatchObject({ numerator: 3, denominator: 4 });
  });
});

describe('channel allocation (§15)', () => {
  test('one instrument means one channel — 16 are never forced', () => {
    const { channelMap, stats } = encoder.encode(
      resultWith([
        { id: 't', instrument: { family: 'piano' }, notes: [{ start: 0, end: 1, pitch: 60 }] }
      ])
    );
    expect(stats.channelsUsed).toBe(1);
    expect(channelMap[0].channel).toBe(0);
  });

  test('melodic tracks skip channel 10', () => {
    const tracks = Array.from({ length: 12 }, (_, i) => ({
      id: `t${i}`,
      instrument: { family: 'piano' },
      notes: [{ start: i, end: i + 1, pitch: 60 + i }]
    }));
    const { channelMap } = encoder.encode(resultWith(tracks));
    expect(channelMap.map((c) => c.channel)).toEqual(MELODIC_CHANNELS.slice(0, 12));
    expect(channelMap.every((c) => c.channel !== GM_DRUM_CHANNEL)).toBe(true);
  });

  test('a drum track always lands on channel 10', () => {
    const { channelMap } = encoder.encode(
      resultWith([
        {
          id: 'melodic',
          instrument: { family: 'piano' },
          notes: [{ start: 0, end: 1, pitch: 60 }]
        },
        {
          id: 'drums',
          instrument: { family: 'drums', isDrums: true },
          notes: [{ start: 0, end: 0.2, pitch: 36 }]
        }
      ])
    );
    expect(channelMap[1].channel).toBe(GM_DRUM_CHANNEL);
    expect(channelMap[1].program).toBeNull();
  });

  test('a track LABELLED as drums is treated as drums even without the flag', () => {
    const { channelMap } = encoder.encode(
      resultWith([
        {
          id: 'd',
          instrument: { family: 'drum kit' },
          notes: [{ start: 0, end: 0.2, pitch: 38 }]
        }
      ])
    );
    expect(channelMap[0].channel).toBe(GM_DRUM_CHANNEL);
  });

  test('past 15 melodic tracks channels are reused, and the reuse is reported', () => {
    const tracks = Array.from({ length: 17 }, (_, i) => ({
      id: `t${i}`,
      instrument: { family: 'piano' },
      notes: [{ start: i, end: i + 0.5, pitch: 60 }]
    }));
    const { stats, channelMap } = encoder.encode(resultWith(tracks));
    expect(stats.reusedChannels).toBe(2);
    expect(channelMap[15].channel).toBe(channelMap[0].channel);
  });
});

describe('programs (§15 — no invented precision)', () => {
  test('uses the program the engine reported', () => {
    expect(resolveProgram({ instrument: { gmProgram: 42, label: 'piano' } })).toBe(42);
  });

  test('falls back to the label table', () => {
    expect(resolveProgram({ instrument: { gmProgram: null, label: 'Electric Bass' } })).toBe(33);
    expect(resolveProgram({ instrument: { gmProgram: null, family: 'cello' } })).toBe(42);
  });

  test('an unrecognised instrument produces NO Program Change at all', () => {
    expect(resolveProgram({ instrument: { gmProgram: null, label: 'zither-o-tron' } })).toBeNull();
    const { buffer, channelMap } = encoder.encode(
      resultWith([
        {
          id: 't',
          instrument: { family: 'zither-o-tron' },
          notes: [{ start: 0, end: 1, pitch: 60 }]
        }
      ])
    );
    expect(channelMap[0].program).toBeNull();
    const events = parseMidi(buffer).tracks.flat();
    expect(events.some((e) => e.type === 'programChange')).toBe(false);
  });

  test('writes one Program Change at tick 0 when it knows', () => {
    const { buffer } = encoder.encode(
      resultWith([
        {
          id: 't',
          instrument: { family: 'violin' },
          notes: [{ start: 0, end: 1, pitch: 60 }]
        }
      ])
    );
    const programs = parseMidi(buffer).tracks[1].filter((e) => e.type === 'programChange');
    expect(programs).toHaveLength(1);
    expect(programs[0].programNumber).toBe(40);
  });
});

describe('notes', () => {
  test('emits a Note On / Note Off pair at the right ticks', () => {
    const { buffer } = encoder.encode(
      resultWith([
        {
          id: 't',
          instrument: { gmProgram: 0 },
          notes: [{ start: 0.5, end: 1.5, pitch: 60, velocity: 77 }]
        }
      ])
    );
    const events = absoluteEvents(parseMidi(buffer).tracks[1]);
    const on = events.find((e) => e.type === 'noteOn');
    const off = events.find((e) => e.type === 'noteOff');
    // 120 BPM default: 0.5 s = 1 beat = 480 ticks.
    expect(on).toMatchObject({ tick: 480, noteNumber: 60, velocity: 77, channel: 0 });
    expect(off).toMatchObject({ tick: 1440, noteNumber: 60 });
  });

  test('a note shorter than a tick still gets a non-zero length', () => {
    const { buffer } = encoder.encode(
      resultWith([{ id: 't', instrument: {}, notes: [{ start: 0, end: 0.0001, pitch: 60 }] }])
    );
    const events = absoluteEvents(parseMidi(buffer).tracks[1]);
    const on = events.find((e) => e.type === 'noteOn');
    const off = events.find((e) => e.type === 'noteOff');
    expect(off.tick).toBeGreaterThan(on.tick);
  });

  test('at equal ticks, Note Off precedes Note On', () => {
    const { buffer } = encoder.encode(
      resultWith([
        {
          id: 't',
          instrument: {},
          notes: [
            { start: 0, end: 1, pitch: 60 },
            { start: 1, end: 2, pitch: 62 }
          ]
        }
      ])
    );
    const events = absoluteEvents(parseMidi(buffer).tracks[1]).filter((e) =>
      ['noteOn', 'noteOff'].includes(e.type)
    );
    const atOneSecond = events.filter((e) => e.tick === 960);
    expect(atOneSecond.map((e) => e.type)).toEqual(['noteOff', 'noteOn']);
  });
});

describe('drums (§16)', () => {
  test('maps labelled hits onto GM percussion notes', () => {
    const { buffer, stats } = encoder.encode(
      resultWith([
        {
          id: 'drums',
          instrument: { family: 'drums', isDrums: true, label: 'Drums' },
          notes: [
            { start: 0, end: 0.1, pitch: 1, label: 'kick' },
            { start: 0.5, end: 0.6, pitch: 2, label: 'snare' },
            { start: 1, end: 1.1, pitch: 3, label: 'closed hi-hat' }
          ]
        }
      ])
    );
    const notes = parseMidi(buffer)
      .tracks[1].filter((e) => e.type === 'noteOn')
      .map((e) => e.noteNumber);
    expect(notes).toEqual([36, 38, 42]);
    expect(stats.unmappedDrumNotes).toBe(0);
  });

  test('passes through a pitch that is already a GM percussion note', () => {
    const { buffer } = encoder.encode(
      resultWith([
        {
          id: 'drums',
          instrument: { isDrums: true },
          notes: [{ start: 0, end: 0.1, pitch: 49 }]
        }
      ])
    );
    expect(parseMidi(buffer).tracks[1].find((e) => e.type === 'noteOn').noteNumber).toBe(49);
  });

  test('drops an unmappable hit rather than playing an arbitrary sound', () => {
    const { buffer, stats } = encoder.encode(
      resultWith([
        {
          id: 'drums',
          instrument: { isDrums: true, label: 'Percussion' },
          notes: [
            { start: 0, end: 0.1, pitch: 5 },
            { start: 1, end: 1.1, pitch: 38 }
          ]
        }
      ])
    );
    expect(stats.unmappedDrumNotes).toBe(1);
    expect(parseMidi(buffer).tracks[1].filter((e) => e.type === 'noteOn')).toHaveLength(1);
  });
});

describe('expression (§14)', () => {
  const bendTrack = {
    id: 't',
    instrument: { family: 'violin' },
    notes: [
      {
        start: 0,
        end: 1,
        pitch: 60,
        velocity: 90,
        expression: {
          pitchCurve: [
            { t: 0, value: 0 },
            { t: 0.5, value: 1 }
          ],
          amplitudeCurve: [
            { t: 0, value: 0.2 },
            { t: 0.5, value: 1 }
          ]
        }
      }
    ]
  };

  test('writes the pitch-bend range as RPN before bending anything', () => {
    const { buffer } = encoder.encode(resultWith([bendTrack]));
    const controllers = parseMidi(buffer)
      .tracks[1].filter((e) => e.type === 'controller')
      .map((e) => e.controllerType);
    expect(controllers.slice(0, 4)).toEqual([101, 100, 6, 38]);
  });

  test('converts semitones to 14-bit bend values symmetrically', () => {
    expect(semitonesToBend(0, 2)).toBe(0);
    expect(semitonesToBend(2, 2)).toBe(8191);
    expect(semitonesToBend(-2, 2)).toBe(-8191);
    expect(semitonesToBend(1, 2)).toBe(4096);
    // Past the declared range it clamps rather than wrapping.
    expect(semitonesToBend(12, 2)).toBe(8191);
  });

  test('recentres the bend at the end of the note', () => {
    const { buffer } = encoder.encode(resultWith([bendTrack]));
    const bends = parseMidi(buffer).tracks[1].filter((e) => e.type === 'pitchBend');
    expect(bends.length).toBeGreaterThanOrEqual(3);
    expect(bends[bends.length - 1].value).toBe(0);
  });

  test('writes CC11 from the amplitude curve', () => {
    const { buffer, stats } = encoder.encode(resultWith([bendTrack]));
    const expression = parseMidi(buffer).tracks[1].filter(
      (e) => e.type === 'controller' && e.controllerType === 11
    );
    expect(expression).toHaveLength(2);
    expect(expression[0].value).toBe(25);
    expect(expression[1].value).toBe(127);
    expect(stats.expressionEvents).toBe(2);
  });

  test('emits nothing when the engine reported no curves', () => {
    const { buffer, stats } = encoder.encode(
      resultWith([
        { id: 't', instrument: { family: 'violin' }, notes: [{ start: 0, end: 1, pitch: 60 }] }
      ])
    );
    const events = parseMidi(buffer).tracks[1];
    expect(events.some((e) => e.type === 'pitchBend')).toBe(false);
    expect(events.filter((e) => e.type === 'controller')).toHaveLength(0);
    expect(stats.pitchBendEvents).toBe(0);
  });

  test('expression can be turned off per job', () => {
    const { stats } = encoder.encode(resultWith([bendTrack]), {
      emitPitchBend: false,
      emitExpression: false
    });
    expect(stats.pitchBendEvents).toBe(0);
    expect(stats.expressionEvents).toBe(0);
  });

  test('never bends a drum channel', () => {
    const { stats } = encoder.encode(
      resultWith([
        {
          id: 'drums',
          instrument: { isDrums: true },
          notes: [
            {
              start: 0,
              end: 0.2,
              pitch: 38,
              expression: { pitchCurve: [{ t: 0, value: 1 }], amplitudeCurve: [] }
            }
          ]
        }
      ])
    );
    expect(stats.pitchBendEvents).toBe(0);
  });

  test('caps the number of events a pathological curve can produce', () => {
    const points = Array.from({ length: 500 }, (_, i) => ({ t: i * 0.001, value: i % 2 }));
    const { stats } = encoder.encode(
      resultWith([
        {
          id: 't',
          instrument: { family: 'violin' },
          notes: [
            {
              start: 0,
              end: 1,
              pitch: 60,
              expression: { pitchCurve: points, amplitudeCurve: points }
            }
          ]
        }
      ])
    );
    // 64 bend points + the recentring event, 32 expression points.
    expect(stats.pitchBendEvents).toBe(65);
    expect(stats.expressionEvents).toBe(32);
  });
});

describe('helpers', () => {
  test('rpnPitchBendRange clamps to a sane semitone range', () => {
    expect(rpnPitchBendRange(0, 2)[2].value).toBe(2);
    expect(rpnPitchBendRange(0, 99)[2].value).toBe(24);
    expect(rpnPitchBendRange(0, 0)[2].value).toBe(1);
  });

  test('toDeltaEvents converts absolute ticks to deltas and terminates the track', () => {
    const events = toDeltaEvents([
      { tick: 10, order: 9, event: { type: 'noteOn' } },
      { tick: 0, order: 2, event: { type: 'trackName', text: 'x' } }
    ]);
    expect(events.map((e) => e.deltaTime)).toEqual([0, 10, 0]);
    expect(events[events.length - 1].type).toBe('endOfTrack');
  });
});
