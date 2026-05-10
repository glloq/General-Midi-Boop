/**
 * @file tests/midi-transposer-compression-collisions.test.js
 * @description Guard for the compressChannel telemetry added while
 * sweeping TODO.md. The wrapper does not change pitch semantics — it
 * just reports how many destination notes have more than one source, so
 * the routing UI can flag the case to the operator.
 */
import { describe, test, expect } from '@jest/globals';
import MidiTransposer from '../src/midi/adaptation/MidiTransposer.js';

const mockLogger = { info() {}, warn() {}, error() {}, debug() {} };

function midiData(events) {
  return {
    header: { format: 1, numTracks: 1, ticksPerBeat: 480 },
    tracks: [{ name: 'T', events }],
    duration: 1
  };
}

describe('MidiTransposer.compressChannel — collision telemetry', () => {
  const transposer = new MidiTransposer(mockLogger);

  test('reports 0 collisions when the source already fits the range', () => {
    const data = midiData([
      { type: 'noteOn', channel: 0, noteNumber: 64, velocity: 80, deltaTime: 0 },
      { type: 'noteOff', channel: 0, noteNumber: 64, velocity: 0, deltaTime: 10 }
    ]);
    const { stats } = transposer.compressChannel(data, 0, 60, 72);
    expect(stats.compressionCollisions).toBe(0);
  });

  test('counts every target note that has more than one source', () => {
    // Range [60, 72] = 12-note span. Notes outside that span are wrapped
    // modulo, so multiple source pitches collide on the same target.
    const data = midiData([
      { type: 'noteOn', channel: 0, noteNumber: 48, velocity: 80, deltaTime: 0 },
      { type: 'noteOff', channel: 0, noteNumber: 48, velocity: 0, deltaTime: 10 },
      { type: 'noteOn', channel: 0, noteNumber: 36, velocity: 80, deltaTime: 0 },
      { type: 'noteOff', channel: 0, noteNumber: 36, velocity: 0, deltaTime: 10 }
    ]);
    const { stats } = transposer.compressChannel(data, 0, 60, 72);
    expect(stats.compressionCollisions).toBeGreaterThan(0);
  });

  test('stats still carry the legacy notesRemapped counter', () => {
    const data = midiData([
      { type: 'noteOn', channel: 0, noteNumber: 40, velocity: 80, deltaTime: 0 },
      { type: 'noteOff', channel: 0, noteNumber: 40, velocity: 0, deltaTime: 10 }
    ]);
    const { stats } = transposer.compressChannel(data, 0, 60, 72);
    expect(stats.notesRemapped).toBeGreaterThanOrEqual(1);
  });
});
