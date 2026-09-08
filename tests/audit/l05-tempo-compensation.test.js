/**
 * @file tests/audit/l05-tempo-compensation.test.js
 * @description Lot L05 — §F01 (tempo, PPQ, delta-times, SMPTE) et §O
 * (compensation de latence, **partie calcul uniquement** — tout ce qui exige
 * une carte son est listé « matériel » pour le lot L15).
 */
import { describe, test, expect, jest } from '@jest/globals';
import { writeMidi } from 'midi-file';
import { CompensationService } from '../../src/midi/compensation/CompensationService.js';
import DelayCalibrator from '../../src/audio/DelayCalibrator.js';
import { TIMING } from '../../src/core/constants.js';
import {
  replay,
  buildPlayer,
  buildMidi,
  buildNoteTrack,
  VirtualClock,
  silentLogger
} from './l05-replay-harness.test.js';

const PPQ = 480;
const ROUTING = { 0: { device: 'devA', targetChannel: 0 } };

// ---------------------------------------------------------------------------
// §F01 — tempo
// ---------------------------------------------------------------------------

describe('L05 · F01 — carte de tempo', () => {
  test('sans setTempo, le fichier joue à 120 BPM (ancre SMF)', async () => {
    const buffer = buildNoteTrack(
      [
        { tick: 0, note: 60, dur: 120 },
        { tick: 480, note: 62, dur: 120 }
      ],
      { ppq: PPQ }
    );
    const { trace, player } = await replay({ buffer, routing: ROUTING });
    expect(player.tempo).toBe(120);
    const ons = trace.filter((e) => (e.status & 0xf0) === 0x90 && e.data2 > 0);
    expect(ons[1].t - ons[0].t).toBeCloseTo(490, 3); // 500 ms – 1 tick (F-55)
  });

  test('changements de tempo multiples : chaque segment est converti au bon tempo', async () => {
    const track = [
      { deltaTime: 0, meta: true, type: 'setTempo', microsecondsPerBeat: 500000 }, // 120
      { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
      { deltaTime: 120, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 },
      { deltaTime: 360, meta: true, type: 'setTempo', microsecondsPerBeat: 250000 }, // 240
      { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 62, velocity: 100 },
      { deltaTime: 120, type: 'noteOff', channel: 0, noteNumber: 62, velocity: 0 },
      { deltaTime: 360, meta: true, type: 'setTempo', microsecondsPerBeat: 1000000 }, // 60
      { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 64, velocity: 100 },
      { deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 64, velocity: 0 }
    ];
    const buffer = buildMidi({ ppq: PPQ, tracks: [track] });
    const { player } = await replay({ buffer, routing: ROUTING });
    const at = (type, note) => player.events.find((e) => e.type === type && e.note === note).time;
    expect(at('noteOn', 60)).toBeCloseTo(0, 9); // t = 0
    expect(at('noteOn', 62)).toBeCloseTo(0.5, 9); // 1 noire à 120 BPM
    expect(at('noteOn', 64)).toBeCloseTo(0.75, 9); // + 1 noire à 240 BPM
    expect(at('noteOff', 64)).toBeCloseTo(1.75, 9); // + 1 noire à 60 BPM
  });

  test('un setTempo à un tick NON NUL ne rétro-applique pas son tempo', async () => {
    const track = [
      { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
      { deltaTime: 480, meta: true, type: 'setTempo', microsecondsPerBeat: 1000000 }, // 60 BPM
      { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 },
      { deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 62, velocity: 100 },
      { deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 62, velocity: 0 }
    ];
    const buffer = buildMidi({ ppq: PPQ, tracks: [track] });
    const { player } = await replay({ buffer, routing: ROUTING });
    const noteOff60 = player.events.find((e) => e.type === 'noteOff' && e.note === 60);
    expect(noteOff60.time).toBeCloseTo(0.5, 9); // 120 BPM avant le 1er setTempo
    const on62 = player.events.find((e) => e.type === 'noteOn' && e.note === 62);
    expect(on62.time).toBeCloseTo(1.5, 9); // puis 60 BPM
  });

  test('timing SMPTE : rejet PROPRE (ValidationError, pas de lecture silencieuse à 480 PPQ)', async () => {
    const midi = {
      header: { format: 0, numTracks: 1, framesPerSecond: 25, ticksPerFrame: 40 },
      tracks: [
        [
          { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
          { deltaTime: 40, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 },
          { deltaTime: 0, meta: true, type: 'endOfTrack' }
        ]
      ]
    };
    const buffer = Buffer.from(writeMidi(midi));
    await expect(buildPlayer({ buffer, clock: new VirtualClock() })).rejects.toThrow(/SMPTE/i);
  });

  test('SMF format 2 : rejet PROPRE', async () => {
    const buffer = buildMidi({
      ppq: PPQ,
      format: 2,
      tracks: [[{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 }]]
    });
    await expect(buildPlayer({ buffer, clock: new VirtualClock() })).rejects.toThrow(/format 2/i);
  });

  test('un `microsecondsPerBeat` nul/négatif ne corrompt pas la timeline', async () => {
    const track = [
      { deltaTime: 0, meta: true, type: 'setTempo', microsecondsPerBeat: 0 },
      { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
      { deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 }
    ];
    const buffer = buildMidi({ ppq: PPQ, tracks: [track] });
    const { player } = await replay({ buffer, routing: ROUTING });
    for (const e of player.events) {
      expect(Number.isFinite(e.time)).toBe(true);
      expect(e.time).toBeGreaterThanOrEqual(0);
    }
  });

  test('delta-times après édition : ré-écriture puis relecture donnent la même timeline', async () => {
    // Simule un aller-retour d'éditeur : parse → ré-encodage → parse.
    const buffer = buildNoteTrack(
      [
        { tick: 0, note: 60, dur: 240 },
        { tick: 480, note: 64, dur: 240 },
        { tick: 913, note: 67, dur: 71 } // deltas non ronds
      ],
      { ppq: PPQ }
    );
    const a = await replay({ buffer, routing: ROUTING });
    const b = await replay({ buffer, routing: ROUTING });
    expect(JSON.stringify(b.player.events)).toBe(JSON.stringify(a.player.events));
    expect(a.player.duration).toBeCloseTo(984 / 480 / 2, 9);
  });

  test('playbackRate : les délais d’émission sont divisés par le taux', async () => {
    const buffer = buildNoteTrack(
      [
        { tick: 0, note: 60, dur: 120 },
        { tick: 480, note: 62, dur: 120 }
      ],
      { ppq: PPQ }
    );
    const base = await replay({ buffer, routing: ROUTING });
    const fast = await replay({
      buffer,
      routing: ROUTING,
      mutate: (p) => {
        p.playbackRate = 2;
      }
    });
    const gap = (t) => {
      const ons = t.filter((e) => (e.status & 0xf0) === 0x90 && e.data2 > 0);
      return ons[1].t - ons[0].t;
    };
    expect(gap(base.trace)).toBeCloseTo(490, 3);
    expect(gap(fast.trace)).toBeCloseTo(240, 3); // ≈ moitié
  });
});

// ---------------------------------------------------------------------------
// §O — compensation de latence : partie CALCUL
// ---------------------------------------------------------------------------

function makeCompensation({ settings = {}, hw = {} } = {}) {
  const eventBus = { on() {}, off() {}, emit() {} };
  const svc = new CompensationService({
    database: {
      getInstrumentSettings: (dev, ch) => settings[`${dev}:${ch}`] ?? settings[dev] ?? null
    },
    latencyCompensator: { getLatency: (dev) => hw[dev] ?? 0 },
    eventBus,
    logger: silentLogger()
  });
  return svc;
}

describe('L05 · O — CompensationService (calcul pur)', () => {
  test('sans calibration ni réglage : compensation nulle', () => {
    const svc = makeCompensation();
    expect(svc.getDelay('devA', 0)).toBe(0);
    svc.destroy();
  });

  test('sync_delay + latence matérielle s’ADDITIONNENT', () => {
    const svc = makeCompensation({ settings: { 'devA:0': { sync_delay: 30 } }, hw: { devA: 12 } });
    expect(svc.getDelay('devA', 0)).toBe(42);
    svc.destroy();
  });

  test('une latence matérielle NÉGATIVE est ignorée (seul `sync_delay` peut être négatif)', () => {
    const svc = makeCompensation({
      settings: { 'devA:0': { sync_delay: -25 } },
      hw: { devA: -50 }
    });
    expect(svc.getDelay('devA', 0)).toBe(-25);
    svc.destroy();
  });

  test('valeurs aberrantes : écrêtage symétrique à ±MAX_COMPENSATION_MS', () => {
    const hi = makeCompensation({ settings: { 'devA:0': { sync_delay: 999999 } } });
    expect(hi.getDelay('devA', 0)).toBe(TIMING.MAX_COMPENSATION_MS);
    hi.destroy();
    const lo = makeCompensation({ settings: { 'devA:0': { sync_delay: -999999 } } });
    expect(lo.getDelay('devA', 0)).toBe(-TIMING.MAX_COMPENSATION_MS);
    lo.destroy();
  });

  test('une erreur de base de données ne casse pas le chemin chaud (0 renvoyé)', () => {
    const svc = new CompensationService({
      database: {
        getInstrumentSettings() {
          throw new Error('db down');
        }
      },
      eventBus: { on() {}, off() {}, emit() {} },
      logger: silentLogger()
    });
    expect(svc.getDelay('devA', 0)).toBe(0);
    svc.destroy();
  });

  test('le cache est invalidé par `instrument_settings_changed`', () => {
    let delay = 10;
    const listeners = {};
    const svc = new CompensationService({
      database: { getInstrumentSettings: () => ({ sync_delay: delay }) },
      eventBus: {
        on: (n, f) => (listeners[n] = f),
        off() {},
        emit: (n) => listeners[n]?.()
      },
      logger: silentLogger()
    });
    expect(svc.getDelay('devA', 0)).toBe(10);
    delay = 55;
    expect(svc.getDelay('devA', 0)).toBe(10); // servi par le cache
    listeners['instrument_settings_changed']();
    expect(svc.getDelay('devA', 0)).toBe(55);
    svc.destroy();
  });
});

describe('L05 · O — la compensation décale réellement l’émission', () => {
  test('un sync_delay de 40 ms avance l’émission de 40 ms', async () => {
    const buffer = buildNoteTrack(
      [
        { tick: 480, note: 60, dur: 120 },
        { tick: 960, note: 62, dur: 120 }
      ],
      { ppq: PPQ }
    );
    const ref = await replay({ buffer, routing: ROUTING });
    const comp = await replay({ buffer, routing: ROUTING, delays: { 'devA:0': 40 } });
    const first = (t) => t.filter((e) => (e.status & 0xf0) === 0x90 && e.data2 > 0)[0].t;
    expect(ref.trace.length).toBe(comp.trace.length);
    expect(first(ref.trace) - first(comp.trace)).toBeCloseTo(40, 3);
  });

  test('un sync_delay NÉGATIF retarde l’émission', async () => {
    const buffer = buildNoteTrack([{ tick: 480, note: 60, dur: 120 }], { ppq: PPQ });
    const ref = await replay({ buffer, routing: ROUTING });
    const late = await replay({ buffer, routing: ROUTING, delays: { 'devA:0': -40 } });
    const first = (t) => t.filter((e) => (e.status & 0xf0) === 0x90 && e.data2 > 0)[0].t;
    expect(first(late.trace) - first(ref.trace)).toBeCloseTo(40, 3);
  });

  test('deux instruments aux compensations différentes restent alignés à l’oreille', async () => {
    // Même note au même tick sur deux canaux, compensations 0 et 60 ms :
    // l'instrument lent doit partir 60 ms plus tôt.
    const track = [
      { deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
      { deltaTime: 0, type: 'noteOn', channel: 1, noteNumber: 60, velocity: 100 },
      { deltaTime: 240, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 },
      { deltaTime: 0, type: 'noteOff', channel: 1, noteNumber: 60, velocity: 0 }
    ];
    const buffer = buildMidi({ ppq: PPQ, tracks: [track] });
    const { trace } = await replay({
      buffer,
      routing: {
        0: { device: 'fast', targetChannel: 0 },
        1: { device: 'slow', targetChannel: 1 }
      },
      delays: { 'slow:1': 60 }
    });
    const on = (dev) =>
      trace.find((e) => e.device === dev && (e.status & 0xf0) === 0x90 && e.data2 > 0).t;
    expect(on('fast') - on('slow')).toBeCloseTo(60, 3);
  });
});

describe('L05 · O — DelayCalibrator : calcul de la mesure (sans carte son)', () => {
  // `calibrateInstrument` dort 1 s entre deux mesures : on neutralise
  // l'attente (elle n'a aucune incidence sur le calcul testé ici).
  const calibrator = () => {
    const c = new DelayCalibrator({ sendMessage() {} }, silentLogger());
    c.sleep = () => Promise.resolve();
    return c;
  };

  test('médiane impaire / paire et confiance', async () => {
    const c = calibrator();
    c.singleMeasurement = jest
      .fn()
      .mockResolvedValueOnce(20)
      .mockResolvedValueOnce(22)
      .mockResolvedValueOnce(21);
    const r = await c.calibrateInstrument('devA', 0, { measurements: 3 });
    expect(r.success).toBe(true);
    expect(r.delay).toBe(21); // médiane
    expect(r.mean).toBe(21);
    expect(r.confidence).toBeGreaterThan(95);
  });

  test('une valeur ABERRANTE ne déplace pas la médiane mais effondre la confiance', async () => {
    const c = calibrator();
    const vals = [20, 21, 22, 23, 900];
    c.singleMeasurement = jest.fn(() => Promise.resolve(vals.shift()));
    const r = await c.calibrateInstrument('devA', 0, { measurements: 5 });
    expect(r.delay).toBe(22); // médiane robuste
    expect(r.mean).toBe(197); // moyenne détruite par l'aberration
    expect(r.confidence).toBe(0); // stdDev ≫ 50 ms
    // ⚠️ Aucun rejet d'aberrant n'est implémenté : la valeur reste dans
    //    `measurements` et dans `mean`/`stdDev` (F-62).
    expect(r.measurements).toContain(900);
  });

  test('aucune détection : échec explicite, pas de valeur inventée', async () => {
    const c = calibrator();
    c.singleMeasurement = jest.fn().mockResolvedValue(null);
    const r = await c.calibrateInstrument('devA', 0, { measurements: 3 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/No valid measurements/i);
    expect(r.delay).toBeUndefined();
  });

  test('une seule mesure valide suffit — et la confiance vaut 100 % (trompeur)', async () => {
    const c = calibrator();
    const vals = [null, 37, null];
    c.singleMeasurement = jest.fn(() => Promise.resolve(vals.shift()));
    const r = await c.calibrateInstrument('devA', 0, { measurements: 3 });
    expect(r.success).toBe(true);
    expect(r.delay).toBe(37);
    // stdDev = 0 sur un échantillon unique ⇒ 100 % de confiance annoncée
    // alors qu'aucune répétabilité n'a été observée (F-62).
    expect(r.confidence).toBe(100);
    expect(r.measurements).toHaveLength(1);
  });

  test('validation du périphérique ALSA (garde d’injection)', () => {
    expect(DelayCalibrator.isValidAlsaDevice('hw:1,0')).toBe(true);
    expect(DelayCalibrator.isValidAlsaDevice('plughw:0,0')).toBe(true);
    expect(DelayCalibrator.isValidAlsaDevice('default')).toBe(true);
    expect(DelayCalibrator.isValidAlsaDevice('hw:1,0; rm -rf /')).toBe(false);
    expect(DelayCalibrator.isValidAlsaDevice('')).toBe(false);
    expect(DelayCalibrator.isValidAlsaDevice(null)).toBe(false);
  });

  test('détection d’attaque : RMS et fenêtre glissante sur un buffer S16_LE', () => {
    const c = calibrator();
    const silence = Buffer.alloc(2 * 2000); // 2000 échantillons à 0
    expect(c.calculateRMS(silence)).toBe(0);
    expect(c.findOnsetInChunk(silence, 0.02)).toBe(-1);
    // Attaque à l'échantillon 1000.
    const buf = Buffer.alloc(2 * 2000);
    for (let i = 1000; i < 2000; i++) buf.writeInt16LE(20000, i * 2);
    const onset = c.findOnsetInChunk(buf, 0.02);
    expect(onset).toBeGreaterThanOrEqual(936); // fenêtre de 64 échantillons
    expect(onset).toBeLessThanOrEqual(1000);
  });
});
