// tests/apply-assignments-no-double-transpose.test.js
// When apply_assignments BAKES a transposition into an adapted file, the
// persisted routing row must NOT also carry transposition_applied /
// note_remapping — otherwise the runtime player re-applies the shift on top of
// the already-transposed notes (audit P0 — double application). When no
// adapted file is baked, the routing DOES carry the runtime value.

import { describe, test, expect, beforeEach } from '@jest/globals';
import { writeMidi } from 'midi-file';
import { register } from '../src/midi/playback/commands/PlaybackAssignmentCommands.js';
import MidiAdaptationService from '../src/midi/adaptation/MidiAdaptationService.js';

const silent = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

function midiBuffer() {
  return Buffer.from(
    writeMidi({
      header: { format: 1, numTracks: 1, ticksPerBeat: 480 },
      tracks: [
        [
          { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
          { deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 },
          { deltaTime: 0, meta: true, type: 'endOfTrack' }
        ]
      ]
    })
  );
}

function makeApp() {
  const saved = [];
  const app = {
    logger: silent,
    blobStore: { read: () => midiBuffer() },
    adaptationService: new MidiAdaptationService(silent),
    fileManager: {
      createDerivedFile: async () => ({ fileId: 999, status: 'created' }),
      replaceFileBytes: async () => ({ success: true }),
      bakeAndSave: async () => ({ success: true, stats: {} })
    },
    fileRepository: {
      findById: () => ({
        id: 1,
        filename: 'song.mid',
        folder: '/',
        blob_path: 'x',
        tracks: 1,
        duration: 1,
        tempo: 120,
        ppq: 480
      }),
      findByFolder: () => []
    },
    routingRepository: {
      save: (r) => saved.push(r),
      saveSplit: (fid, ch, segs) => segs.forEach((s) => saved.push({ ...s, channel: ch })),
      findByFileId: () => []
    },
    instrumentRepository: { getCapabilities: () => null },
    midiPlayer: null
  };
  return { app, saved };
}

function getHandler(app) {
  let handler;
  register(
    {
      register: (name, fn) => {
        if (name === 'apply_assignments') handler = fn;
      }
    },
    app
  );
  return handler;
}

describe('apply_assignments — no double transposition', () => {
  let app, saved, handler;
  beforeEach(() => {
    ({ app, saved } = makeApp());
    handler = getHandler(app);
  });

  test('baked adapted file → routing carries transposition_applied 0', async () => {
    await handler({
      originalFileId: 1,
      createAdaptedFile: true,
      assignments: {
        0: { deviceId: 'd1', instrumentName: 'x', score: 1, transposition: { semitones: 12 } }
      }
    });
    const row = saved.find((r) => r.channel === 0);
    expect(row).toBeTruthy();
    expect(row.transposition_applied).toBe(0); // baked → not re-applied at runtime
    expect(row.note_remapping).toBeNull();
  });

  test('no adapted file → routing carries the runtime transposition', async () => {
    await handler({
      originalFileId: 1,
      createAdaptedFile: false,
      assignments: {
        0: { deviceId: 'd1', instrumentName: 'x', score: 1, transposition: { semitones: 12 } }
      }
    });
    const row = saved.find((r) => r.channel === 0);
    expect(row).toBeTruthy();
    expect(row.transposition_applied).toBe(12); // runtime-applied on the original
  });
});
