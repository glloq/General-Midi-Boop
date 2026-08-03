// tests/midi-player-seek-pause.test.js
// Seeking while PAUSED must stay paused at the new position, not restart
// playback. A paused player has `playing === true`, so the old seek() keyed
// its resume decision off `this.playing` and wrongly called start() (audit P2).

import { describe, test, expect, jest } from '@jest/globals';
import MidiPlayer from '../src/midi/playback/MidiPlayer.js';

function makeDeps() {
  const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
  return {
    logger,
    database: { getInstrumentCapabilities: () => null },
    blobStore: { read: () => Buffer.alloc(0) },
    wsServer: { broadcast: jest.fn() },
    eventBus: { on: () => {}, emit: jest.fn() }
  };
}

function makePlayer() {
  const player = new MidiPlayer(makeDeps());
  // Isolate seek()'s control flow from device I/O.
  player.duration = 100;
  player.scheduler.stopScheduler = jest.fn();
  player.scheduler.startScheduler = jest.fn();
  player.sendAllNotesOff = jest.fn();
  player._emitReconstructedState = jest.fn();
  player.broadcastStatus = jest.fn();
  player.broadcastPosition = jest.fn();
  player.findEventIndexAtTime = () => 0;
  player.start = jest.fn();
  return player;
}

describe('MidiPlayer.seek — pause preservation', () => {
  test('seeking while paused stays paused and does NOT restart playback', () => {
    const player = makePlayer();
    player.playing = true;
    player.paused = true;

    player.seek(30);

    expect(player.start).not.toHaveBeenCalled(); // did not resume/restart
    expect(player.playing).toBe(true);
    expect(player.paused).toBe(true); // still paused
    expect(player.position).toBe(30);
  });

  test('seeking while actively playing restarts at the new position', () => {
    const player = makePlayer();
    player.playing = true;
    player.paused = false;
    player.outputDevice = 'devX';

    player.seek(42);

    expect(player.start).toHaveBeenCalledWith('devX', 42);
  });

  test('seeking while stopped just repositions', () => {
    const player = makePlayer();
    player.playing = false;
    player.paused = false;

    player.seek(10);

    expect(player.start).not.toHaveBeenCalled();
    expect(player.position).toBe(10);
    expect(player.broadcastPosition).toHaveBeenCalled();
  });

  test('seeking while paused does NOT stop the MIDI clock (resume must still work)', () => {
    const player = makePlayer();
    // A paused clock is still `_running`; stopPlayback() would clear that and
    // make a later resume()'s resumePlayback() a permanent no-op (audit P2).
    player.midiClockGenerator = {
      stopPlayback: jest.fn(),
      startPlayback: jest.fn(),
      pausePlayback: jest.fn(),
      resumePlayback: jest.fn()
    };
    player.playing = true;
    player.paused = true;

    player.seek(30);

    expect(player.midiClockGenerator.stopPlayback).not.toHaveBeenCalled();
    expect(player.paused).toBe(true);
  });

  test('seeking while actively playing stops the clock (it is restarted by start())', () => {
    const player = makePlayer();
    player.midiClockGenerator = {
      stopPlayback: jest.fn(),
      startPlayback: jest.fn(),
      pausePlayback: jest.fn(),
      resumePlayback: jest.fn()
    };
    player.playing = true;
    player.paused = false;
    player.outputDevice = 'devX';

    player.seek(42);

    expect(player.midiClockGenerator.stopPlayback).toHaveBeenCalled();
  });
});
