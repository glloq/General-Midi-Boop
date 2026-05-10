/**
 * @file tests/midi-player-hand-cc-double-inject.test.js
 * @description Guard for the no-double-inject helper added so MidiPlayer
 * can detect when hand-position CCs are already baked into the file (by
 * PlaybackAssignmentCommands → FileManager.bakeAndSave). Without the
 * skip, every CC would fire twice: once from the timeline and once from
 * the live injection. See TODO.md "CC main absents de l'éditeur CC".
 */
import { describe, test, expect } from '@jest/globals';
import MidiPlayer from '../src/midi/playback/MidiPlayer.js';

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

function makePlayer(events) {
  // Bypass the heavy ctor: stub just the surface the helper reads.
  const player = Object.create(MidiPlayer.prototype);
  player.events = events;
  player.logger = noopLogger;
  return player;
}

describe('MidiPlayer._timelineHasHandCCs', () => {
  test('returns false when no controller events match', () => {
    const player = makePlayer([
      { type: 'noteOn', channel: 0, note: 60, velocity: 80, time: 0 },
      { type: 'controller', channel: 0, controller: 7, value: 100, time: 0 }
    ]);
    expect(player._timelineHasHandCCs(0, new Set([22, 23, 24]))).toBe(false);
  });

  test('returns true when a baked hand CC is found on the same channel', () => {
    const player = makePlayer([
      { type: 'controller', channel: 0, controller: 23, value: 60, time: 1.0 }
    ]);
    expect(player._timelineHasHandCCs(0, new Set([22, 23, 24]))).toBe(true);
  });

  test('ignores hand CCs marked with _handInjected (our own previous output)', () => {
    const player = makePlayer([
      { type: 'controller', channel: 0, controller: 23, value: 60, time: 1.0, _handInjected: true }
    ]);
    expect(player._timelineHasHandCCs(0, new Set([22, 23, 24]))).toBe(false);
  });

  test('does not confuse a CC on a different channel', () => {
    const player = makePlayer([
      { type: 'controller', channel: 1, controller: 23, value: 60, time: 1.0 }
    ]);
    expect(player._timelineHasHandCCs(0, new Set([22, 23, 24]))).toBe(false);
  });
});
