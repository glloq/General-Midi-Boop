/**
 * @file tests/e2e/fixtures/make-midi.mjs
 * @description Generates the small deterministic MIDI files the E2E specs import.
 *
 * Uses the project's own `midi-file` dependency, so the fixture is written by
 * exactly the library the backend parses with — a fixture that the app cannot
 * read would be a harness bug, not a finding.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { writeMidi } = require('midi-file');

const HERE = path.dirname(fileURLToPath(import.meta.url));

const TPQ = 480;

/**
 * Build a 2-channel MIDI file: a melody on channel 0 and a bass on channel 1.
 *
 * Kept intentionally small (a few dozen events) so a failing assertion points
 * at the application, not at a pathological input.
 *
 * @param {{name?:string, bpm?:number}} [opts]
 * @returns {Buffer}
 */
export function buildTwoChannelMidi(opts = {}) {
  const bpm = opts.bpm ?? 120;
  const usPerBeat = Math.round(60000000 / bpm);
  // Long enough that a spec can start playback, observe it, cut the WebSocket
  // and still be mid-piece. 4 repeats × 8 beats at 120 BPM ≈ 16 s.
  const repeats = opts.repeats ?? 4;

  /** C major scale, one note per beat. */
  const scale = [60, 62, 64, 65, 67, 69, 71, 72];
  const melody = Array.from({ length: repeats }, () => scale).flat();
  /** Root/fifth alternation, one note per two beats. */
  const bass = Array.from({ length: repeats }, () => [36, 43, 36, 43]).flat();

  const track0 = [
    { deltaTime: 0, meta: true, type: 'trackName', text: 'Conductor' },
    { deltaTime: 0, meta: true, type: 'setTempo', microsecondsPerBeat: usPerBeat },
    {
      deltaTime: 0,
      meta: true,
      type: 'timeSignature',
      numerator: 4,
      denominator: 4,
      metronome: 24,
      thirtyseconds: 8
    },
    { deltaTime: TPQ * 8 * repeats, meta: true, type: 'endOfTrack' }
  ];

  const track1 = [
    { deltaTime: 0, meta: true, type: 'trackName', text: 'E2E Melody' },
    { deltaTime: 0, type: 'programChange', channel: 0, programNumber: 0 }
  ];
  for (const note of melody) {
    // 20-tick gap between notes is carried by the *next* noteOn's deltaTime.
    track1.push({
      deltaTime: track1.length > 2 ? 20 : 0,
      type: 'noteOn',
      channel: 0,
      noteNumber: note,
      velocity: 96
    });
    track1.push({
      deltaTime: TPQ - 20,
      type: 'noteOff',
      channel: 0,
      noteNumber: note,
      velocity: 0
    });
  }
  track1.push({ deltaTime: 0, meta: true, type: 'endOfTrack' });

  const track2 = [
    { deltaTime: 0, meta: true, type: 'trackName', text: 'E2E Bass' },
    { deltaTime: 0, type: 'programChange', channel: 1, programNumber: 32 }
  ];
  for (const note of bass) {
    track2.push({ deltaTime: 0, type: 'noteOn', channel: 1, noteNumber: note, velocity: 80 });
    track2.push({
      deltaTime: TPQ * 2 - 20,
      type: 'noteOff',
      channel: 1,
      noteNumber: note,
      velocity: 0
    });
  }
  track2.push({ deltaTime: 0, meta: true, type: 'endOfTrack' });

  const bytes = writeMidi({
    header: { format: 1, numTracks: 3, ticksPerBeat: TPQ },
    tracks: [track0, track1, track2]
  });
  return Buffer.from(bytes);
}

/**
 * Single-channel file, used where a second channel would only add noise.
 * @returns {Buffer}
 */
export function buildSingleChannelMidi() {
  const track0 = [
    { deltaTime: 0, meta: true, type: 'trackName', text: 'E2E Single' },
    { deltaTime: 0, meta: true, type: 'setTempo', microsecondsPerBeat: 500000 },
    { deltaTime: 0, type: 'programChange', channel: 0, programNumber: 0 }
  ];
  for (const note of [60, 64, 67, 72]) {
    track0.push({ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: note, velocity: 100 });
    track0.push({ deltaTime: TPQ, type: 'noteOff', channel: 0, noteNumber: note, velocity: 0 });
  }
  track0.push({ deltaTime: 0, meta: true, type: 'endOfTrack' });
  const bytes = writeMidi({
    header: { format: 0, numTracks: 1, ticksPerBeat: TPQ },
    tracks: [track0]
  });
  return Buffer.from(bytes);
}

/**
 * Materialise both fixtures on disk (Playwright's `setInputFiles` wants paths).
 *
 * @param {string} [dir] target directory
 * @returns {{twoChannel:string, singleChannel:string, dir:string}}
 */
export function writeFixtures(dir) {
  const target = dir || path.join(HERE, '..', 'artifacts', 'midi');
  mkdirSync(target, { recursive: true });
  const twoChannel = path.join(target, 'e2e-two-channel.mid');
  const singleChannel = path.join(target, 'e2e-single-channel.mid');
  writeFileSync(twoChannel, buildTwoChannelMidi());
  writeFileSync(singleChannel, buildSingleChannelMidi());
  return { twoChannel, singleChannel, dir: target };
}

// `node tests/e2e/fixtures/make-midi.mjs` writes them and prints the paths.
if (process.argv[1] && process.argv[1].endsWith('make-midi.mjs')) {
  const out = writeFixtures();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(out, null, 2));
}
