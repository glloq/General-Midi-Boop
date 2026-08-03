// tests/midi-player-stop-during-advance.test.js
// Regression guard (audit P3): pressing Stop during a no-gap queue advance —
// while the next file is still loading — must NOT restart playback. During the
// advance `playing` is briefly false, so the old stop() early-returned and the
// in-flight playQueueItem went on to call start().

import { describe, test, expect, jest } from '@jest/globals';
import MidiPlayer from '../src/midi/playback/MidiPlayer.js';

function makeDeps() {
  const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
  return {
    logger,
    database: { getInstrumentCapabilities: () => null },
    blobStore: { read: () => Buffer.alloc(0) },
    wsServer: { broadcast: jest.fn() },
    eventBus: { on: () => {}, emit: jest.fn() },
    deviceManager: { getDeviceList: () => [{ id: 'devX', output: true, enabled: true }] }
  };
}

function makePlayer() {
  const player = new MidiPlayer(makeDeps());
  player.scheduler.stopScheduler = jest.fn();
  player.scheduler.startScheduler = jest.fn();
  player.sendAllNotesOff = jest.fn();
  player.broadcastStatus = jest.fn();
  player.broadcastPosition = jest.fn();
  player._loadRoutingsFromDB = jest.fn();
  player.start = jest.fn();
  return player;
}

describe('MidiPlayer — stop() during a no-gap queue advance', () => {
  test('stop() while the next item is loading aborts the advance (no restart)', async () => {
    const player = makePlayer();
    player.outputDevice = 'devX';
    player.queue = [
      { fileId: 1, filename: 'a.mid' },
      { fileId: 2, filename: 'b.mid' }
    ];

    // Controllable loadFile: resolves only when we let it.
    let resolveLoad;
    player.loadFile = jest.fn(
      () =>
        new Promise((r) => {
          resolveLoad = r;
        })
    );

    // Simulate an in-flight advance to item 1 (index 1).
    player.playing = true; // previous item still "playing" until playQueueItem tears down
    const advance = player.playQueueItem(1);

    // The user hits Stop while loadFile is pending.
    player.stop();

    // Now the file finishes loading.
    resolveLoad();
    await advance;

    expect(player.start).not.toHaveBeenCalled();
    expect(player.playing).toBe(false);
  });

  test('a normal advance (no stop) still starts playback', async () => {
    const player = makePlayer();
    player.outputDevice = 'devX';
    player.queue = [{ fileId: 1, filename: 'a.mid' }];
    player.loadFile = jest.fn(() => Promise.resolve());

    await player.playQueueItem(0);

    expect(player.start).toHaveBeenCalledWith('devX');
  });
});
