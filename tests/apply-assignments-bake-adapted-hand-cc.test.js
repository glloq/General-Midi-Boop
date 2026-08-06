// tests/apply-assignments-bake-adapted-hand-cc.test.js
// When apply_assignments creates an ADAPTED file AND a routed instrument has
// a hands_config, the hand-position CCs must be baked into the adapted file's
// blob (so the MIDI editor's CC pane renders them). This previously had to be
// skipped for adapted files because the adapted bytes never reached disk
// (audit P1). That persistence gap is fixed — replaceFileBytes /
// createDerivedFile now flush the adapted blob before the bake step — so the
// bake runs on the adapted file (targetFileId), not the original.

import { describe, test, expect, beforeEach } from '@jest/globals';
import { writeMidi } from 'midi-file';
import { register } from '../src/midi/playback/commands/PlaybackAssignmentCommands.js';
import MidiAdaptationService from '../src/midi/adaptation/MidiAdaptationService.js';

const silent = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

const HANDS_CONFIG = {
  enabled: true,
  hand_move_semitones_per_sec: 60,
  hands: [{ id: 'left', cc_position_number: 22, hand_span_semitones: 14 }]
};

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

/**
 * @param {?Object} capabilities - value returned by instrumentRepository.getCapabilities.
 */
function makeApp(capabilities) {
  const bakeCalls = [];
  const app = {
    logger: silent,
    blobStore: { read: () => midiBuffer() },
    adaptationService: new MidiAdaptationService(silent),
    fileManager: {
      createDerivedFile: async () => ({ fileId: 999, status: 'created' }),
      replaceFileBytes: async () => ({ success: true }),
      bakeAndSave: async (fileId) => {
        bakeCalls.push(fileId);
        return { success: true, stats: { cc_events_added: 3 } };
      }
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
      save: () => {},
      saveSplit: () => {},
      findByFileId: () => []
    },
    instrumentRepository: { getCapabilities: () => capabilities },
    midiPlayer: null
  };
  return { app, bakeCalls };
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

const assignmentWithTranspose = {
  0: { deviceId: 'd1', instrumentName: 'x', score: 1, transposition: { semitones: 12 } }
};

describe('apply_assignments — bake hand CCs into adapted file', () => {
  let app, bakeCalls, handler;

  describe('adapted file + hands_config routing', () => {
    beforeEach(() => {
      ({ app, bakeCalls } = makeApp({ hands_config: HANDS_CONFIG }));
      handler = getHandler(app);
    });

    test('bakes CCs into the adapted file (targetFileId), not the original', async () => {
      const res = await handler({
        originalFileId: 1,
        createAdaptedFile: true,
        assignments: assignmentWithTranspose
      });
      // createDerivedFile returned id 999 → targetFileId is the adapted file.
      expect(bakeCalls).toEqual([999]);
      expect(res.bakeStats).toEqual({ cc_events_added: 3 });
      // No "not baked" warning should be produced anymore.
      expect(res.warnings).toBeUndefined();
    });
  });

  describe('adapted file WITHOUT a hands_config routing', () => {
    beforeEach(() => {
      ({ app, bakeCalls } = makeApp(null));
      handler = getHandler(app);
    });

    test('does not bake when no routed instrument has hands', async () => {
      const res = await handler({
        originalFileId: 1,
        createAdaptedFile: true,
        assignments: assignmentWithTranspose
      });
      expect(bakeCalls).toEqual([]);
      expect(res.bakeStats).toBeNull();
    });
  });

  describe('non-adapted file + hands_config routing', () => {
    beforeEach(() => {
      ({ app, bakeCalls } = makeApp({ hands_config: HANDS_CONFIG }));
      handler = getHandler(app);
    });

    test('bakes CCs onto the original file when no adaptation is requested', async () => {
      const res = await handler({
        originalFileId: 1,
        createAdaptedFile: false,
        assignments: assignmentWithTranspose
      });
      // No adapted file created → targetFileId is the original (id 1).
      expect(bakeCalls).toEqual([1]);
      expect(res.bakeStats).toEqual({ cc_events_added: 3 });
    });
  });
});
