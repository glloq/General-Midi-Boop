/**
 * @file tests/audit/l05-determinism.test.js
 * @description Lot L05 — §BN « Déterminisme » (état `NOT TESTED` dans l'audit
 * du 2026-08-22). Question posée : *le même fichier, la même configuration
 * d'instruments, la même adaptation produisent-ils EXACTEMENT la même sortie
 * MIDI, deux fois de suite ?*
 *
 * Méthode : `l05-replay-harness.test.js` (horloge injectée, aucune
 * temporisation réelle) capture la séquence complète des messages émis et on
 * compare **octet à octet**, horodatage virtuel compris.
 */
import { describe, test, expect } from '@jest/globals';
import {
  replay,
  buildMidi,
  buildNoteTrack,
  serializeTrace,
  serializeBytes,
  installVirtualClock,
  VirtualClock,
  createTraceRecorder,
  analyseNotePairing
} from './l05-replay-harness.test.js';

const PPQ = 480;

/**
 * Fixture « riche » : 2 pistes, collisions au même tick, changement de tempo,
 * bank select + program change, CC, pitch-bend, SysEx, note-offs entrelacés.
 */
function richFixture() {
  const t0 = [
    { deltaTime: 0, meta: true, type: 'setTempo', microsecondsPerBeat: 500000 },
    { deltaTime: 0, type: 'controller', channel: 0, controllerType: 0, value: 1 }, // bank MSB
    { deltaTime: 0, type: 'controller', channel: 0, controllerType: 32, value: 2 }, // bank LSB
    { deltaTime: 0, type: 'programChange', channel: 0, programNumber: 40 },
    { deltaTime: 0, type: 'controller', channel: 0, controllerType: 7, value: 100 },
    { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
    { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 64, velocity: 100 },
    { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 67, velocity: 100 },
    { deltaTime: 240, type: 'pitchBend', channel: 0, value: 4096 },
    { deltaTime: 240, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 },
    { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 64, velocity: 0 },
    { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 67, velocity: 0 },
    { deltaTime: 0, meta: true, type: 'setTempo', microsecondsPerBeat: 250000 },
    { deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 72, velocity: 110 },
    { deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 72, velocity: 0 },
    { deltaTime: 240, type: 'controller', channel: 0, controllerType: 11, value: 64 }
  ];
  const t1 = [
    { deltaTime: 0, type: 'sysEx', data: [0x7e, 0x7f, 0x09, 0x01, 0xf7] },
    { deltaTime: 0, type: 'noteOn', channel: 1, noteNumber: 48, velocity: 80 },
    { deltaTime: 480, type: 'noteOff', channel: 1, noteNumber: 48, velocity: 0 },
    { deltaTime: 0, type: 'channelAftertouch', channel: 1, value: 55 },
    { deltaTime: 0, type: 'noteAftertouch', channel: 1, noteNumber: 48, value: 20 },
    { deltaTime: 240, type: 'noteOn', channel: 1, noteNumber: 55, velocity: 90 },
    { deltaTime: 480, type: 'noteOff', channel: 1, noteNumber: 55, velocity: 0 },
    { deltaTime: 240, type: 'controller', channel: 1, controllerType: 64, value: 127 }
  ];
  return buildMidi({ ppq: PPQ, tracks: [t0, t1] });
}

const RICH_ROUTING = {
  0: { device: 'devA', targetChannel: 0 },
  1: { device: 'devB', targetChannel: 3 }
};

describe('L05 · §BN — déterminisme du rejeu (deux exécutions identiques)', () => {
  test('deux rejeux du même fichier + même config sont identiques OCTET À OCTET', async () => {
    const buffer = richFixture();
    const a = await replay({ buffer, routing: RICH_ROUTING });
    const b = await replay({ buffer, routing: RICH_ROUTING });
    expect(a.trace.length).toBeGreaterThan(10);
    expect(serializeTrace(b.trace)).toBe(serializeTrace(a.trace));
  });

  test('cinq rejeux consécutifs produisent la même empreinte', async () => {
    const buffer = richFixture();
    const prints = [];
    for (let i = 0; i < 5; i++) {
      const r = await replay({ buffer, routing: RICH_ROUTING });
      prints.push(serializeTrace(r.trace));
    }
    expect(new Set(prints).size).toBe(1);
  });

  test('la timeline construite (events) est identique entre deux chargements', async () => {
    const buffer = richFixture();
    const a = await replay({ buffer, routing: RICH_ROUTING });
    const b = await replay({ buffer, routing: RICH_ROUTING });
    expect(JSON.stringify(b.player.events)).toBe(JSON.stringify(a.player.events));
    // _seq est bien attribué à TOUS les événements (tiebreak stable).
    expect(a.player.events.every((e) => Number.isInteger(e._seq))).toBe(true);
    const seqs = a.player.events.map((e) => e._seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  test('l’ordre au même tick suit la priorité déclarée (bank < PC < CC < notes)', async () => {
    const buffer = richFixture();
    const { trace } = await replay({ buffer, routing: RICH_ROUTING });
    const devA = trace.filter((e) => e.device === 'devA' && e.t === trace[0].t);
    const kinds = devA.map((e) => `${(e.status & 0xf0).toString(16)}:${e.data1}`);
    // bank MSB (b0:0), bank LSB (b0:32), program (c0), CC7 (b0:7), puis notes
    expect(kinds.slice(0, 4)).toEqual(['b0:0', 'b0:32', 'c0:40', 'b0:7']);
    expect(kinds.slice(4)).toEqual(['90:60', '90:64', '90:67']);
  });

  test('deux rejeux sur LA MÊME instance de player sont identiques (pas de fuite d’état)', async () => {
    const buffer = richFixture();
    const clock1 = new VirtualClock(1000);
    const first = await replay({ buffer, routing: RICH_ROUTING });
    const player = first.player;
    const printA = serializeBytes(first.trace);
    const eventCountA = player.events.length;

    // Deuxième passe sur la même instance : nouvelle horloge + nouveau
    // recorder, mais le même MidiPlayer / PlaybackScheduler (caches inclus).
    const clock2 = new VirtualClock(1000);
    const dm2 = createTraceRecorder(clock2);
    player.scheduler.deviceManager = dm2;
    const inst = installVirtualClock(clock2);
    try {
      player.start('devA');
      const end = clock2.now + (player.duration + 0.5) * 1000;
      while (clock2.now < end && player.playing) await clock2.advanceByAsync(1);
    } finally {
      inst.restore();
    }
    expect(player.events.length).toBe(eventCountA); // injections idempotentes
    expect(serializeBytes(dm2.trace)).toBe(printA);
    expect(clock1.now).toBe(1000); // horloge inutilisée — sanity du harnais
  });

  test('déterminisme avec contraintes actives (polyphonie + plage + gamme)', async () => {
    const buffer = buildNoteTrack(
      [
        { tick: 0, note: 60, dur: 1920 },
        { tick: 0, note: 64, dur: 1920 },
        { tick: 0, note: 67, dur: 1920 },
        { tick: 240, note: 72, dur: 480 },
        { tick: 480, note: 30, dur: 480 },
        { tick: 720, note: 100, dur: 480 }
      ],
      { ppq: PPQ }
    );
    const capabilities = {
      'devA:0': { polyphony: 3, noteRangeMin: 48, noteRangeMax: 84, minNoteDuration: 30 }
    };
    const routing = { 0: { device: 'devA', targetChannel: 0 } };
    const a = await replay({ buffer, routing, capabilities });
    const b = await replay({ buffer, routing, capabilities });
    expect(serializeTrace(b.trace)).toBe(serializeTrace(a.trace));
  });

  test('déterminisme avec routage split round-robin (stratégie à état)', async () => {
    const buffer = buildNoteTrack(
      Array.from({ length: 12 }, (_, i) => ({ tick: i * 120, note: 60 + (i % 3), dur: 100 })),
      { ppq: PPQ }
    );
    const routing = {
      0: {
        split: true,
        overlapStrategy: 'round_robin',
        segments: [
          { device: 'devA', targetChannel: 0, noteMin: 0, noteMax: 127 },
          { device: 'devB', targetChannel: 1, noteMin: 0, noteMax: 127 }
        ]
      }
    };
    const a = await replay({ buffer, routing });
    const b = await replay({ buffer, routing });
    expect(a.trace.length).toBeGreaterThan(10);
    expect(serializeTrace(b.trace)).toBe(serializeTrace(a.trace));
  });
});

describe('L05 · §BN — déterminisme « physique » : sensibilité à la gigue', () => {
  /** Gigue pseudo-aléatoire reproductible (mulberry32 semé par l’id du timer). */
  const jitter = (maxMs) => (timer) => {
    let a = (timer.seq * 0x9e3779b9 + timer.fires * 0x85ebca6b) >>> 0;
    a = (a ^ (a >>> 15)) >>> 0;
    a = Math.imul(a, 0x2c1b3c6d) >>> 0;
    a = (a ^ (a >>> 12)) >>> 0;
    a = Math.imul(a, 0x297a2d39) >>> 0;
    a = (a ^ (a >>> 15)) >>> 0;
    return (a / 4294967296) * maxMs;
  };

  // INVERSÉ par la vague 4 / R23 (F-55 corrigé). L'audit mesurait le premier
  // onset à 1010 pour un fichier qui demande 1000 : `start()` ancrait
  // `startTime` puis laissait la PREMIÈRE passe d'ordonnancement au
  // `setInterval`, donc tout ce qui tombe dans [0, 10 ms[ partait d'un bloc à
  // +10 ms et le premier intervalle inter-onset valait 490 au lieu de 500.
  // `start()` exécute désormais une passe synchrone (après le Start d'horloge).
  test('F-55 corrigé — le downbeat part à l’heure, pas un tick plus tard', async () => {
    const buffer = buildNoteTrack(
      [
        { tick: 0, note: 60, dur: 48 },
        { tick: 480, note: 62, dur: 48 }
      ],
      { ppq: PPQ }
    );
    const { trace, clock } = await replay({
      buffer,
      routing: { 0: { device: 'devA', targetChannel: 0 } },
      startNow: 1000
    });
    const ons = trace.filter((e) => (e.status & 0xf0) === 0x90 && e.data2 > 0);
    expect(ons[0].t).toBe(1000); // était 1010
    expect(ons[1].t).toBe(1500);
    // L'intervalle inter-onset est enfin celui du fichier.
    expect(ons[1].t - ons[0].t).toBe(500); // était 490
    expect(clock.pending).toBe(0);
  });

  test('un retard PAR TIMER réordonne les événements d’un même tick', async () => {
    // Chaque événement au-delà de la fenêtre EMIT_AHEAD part par son PROPRE
    // `setTimeout`. L'ordre « état avant notes » établi dans la timeline
    // (EVENT_ORDER_PRIORITY) n'est donc plus garanti au moment de l'émission
    // dès que les timers ne sont pas servis en un seul lot.
    // NB (honnêteté du modèle) : Node sert les timers de même échéance en un
    // seul lot, dans l'ordre d'insertion ; ce scénario modélise une
    // préemption INDIVIDUELLE, pas le comportement libuv nominal.
    const buffer = richFixture();
    const ideal = await replay({ buffer, routing: RICH_ROUTING });
    const jittered = await replay({ buffer, routing: RICH_ROUTING, lateness: jitter(3) });
    expect(serializeBytes(jittered.trace)).not.toBe(serializeBytes(ideal.trace));
    // Même multi-ensemble d'octets, ordre différent → pur réordonnancement.
    const sortLines = (t) => serializeBytes(t).split('\n').sort().join('\n');
    expect(sortLines(jittered.trace)).toBe(sortLines(ideal.trace));
  });

  // INVERSÉ par la vague 4 / R23 (F-61 corrigé). Le garde était comparé à
  // `performance.now()` : le retard d'un tick du downbeat ramenait le premier
  // intervalle de 100 à 90 ms et supprimait la 2e note — 1 note sur 8 perdue
  // sans aucune raison musicale. Il est désormais évalué sur `event.time`.
  test('F-61 corrigé — min_note_interval est évalué en TEMPS MUSICAL : rien n’est coupé', async () => {
    // 8 notes espacées de 100 ms EXACTEMENT dans le fichier ; garde à 95 ms.
    // Rien ne doit être coupé, quelle que soit la gigue.
    const buffer = buildNoteTrack(
      Array.from({ length: 8 }, (_, i) => ({ tick: i * 96, note: 60, dur: 48 })),
      { ppq: PPQ } // 96 ticks @120 bpm/480 ppq = 100 ms
    );
    const routing = { 0: { device: 'devA', targetChannel: 0 } };
    const capabilities = { 'devA:0': { polyphony: 1, minNoteInterval: 95 } };
    const free = await replay({ buffer, routing });
    const gated = await replay({ buffer, routing, capabilities });
    const ons = (t) => t.filter((e) => (e.status & 0xf0) === 0x90 && e.data2 > 0);
    expect(ons(free.trace)).toHaveLength(8);
    expect(ons(gated.trace)).toHaveLength(8); // était 7
    expect(ons(gated.trace).map((e) => e.t)).toContain(1100);
  });

  test('EMIT_AHEAD_MS agrège des événements distincts sur le MÊME instant mur', async () => {
    // Deux notes espacées de 3 ms dans le fichier : elles partent dans le même
    // tick (fenêtre EMIT_AHEAD = 5 ms) donc à `performance.now()` identique.
    const buffer = buildNoteTrack(
      [
        { tick: 0, note: 60, dur: 48 },
        { tick: 3, note: 62, dur: 48 } // 3 ticks ≈ 3,1 ms
      ],
      { ppq: PPQ }
    );
    const routing = { 0: { device: 'devA', targetChannel: 0 } };
    const noGate = await replay({ buffer, routing });
    const ons = noGate.trace.filter((e) => (e.status & 0xf0) === 0x90 && e.data2 > 0);
    expect(ons).toHaveLength(2);
    expect(ons[0].t).toBe(ons[1].t); // écart mur = 0 alors que le fichier dit 3 ms

    // INVERSÉ par la vague 4 / R23 : le garde ne lit plus l'instant mur agrégé
    // mais `event.time`, donc un garde de 2 ms — INFÉRIEUR à l'écart réel du
    // fichier (3,1 ms) — ne supprime plus rien. `polyphony: 8` pour isoler le
    // garde d'intervalle de l'éviction polyphonique.
    const gated = await replay({
      buffer,
      routing,
      capabilities: { 'devA:0': { polyphony: 8, minNoteInterval: 2 } }
    });
    const gatedOns = gated.trace.filter((e) => (e.status & 0xf0) === 0x90 && e.data2 > 0);
    expect(gatedOns).toHaveLength(2); // était 1

    // …et un garde SUPÉRIEUR à l'écart du fichier coupe toujours, lui : deux
    // frappes de la MÊME hauteur (le garde est par hauteur en polyphonique)
    // à 3,1 ms d'écart, garde à 10 ms.
    const samePitch = buildNoteTrack(
      [
        { tick: 0, note: 60, dur: 1 },
        { tick: 3, note: 60, dur: 48 }
      ],
      { ppq: PPQ }
    );
    const reallyGated = await replay({
      buffer: samePitch,
      routing,
      capabilities: { 'devA:0': { polyphony: 8, minNoteInterval: 10 } }
    });
    expect(reallyGated.trace.filter((e) => (e.status & 0xf0) === 0x90 && e.data2 > 0)).toHaveLength(
      1
    );
  });
});

describe('L05 · §BN — sources de non-déterminisme absentes du chemin de lecture', () => {
  test('aucun Math.random / Date.now n’influence les octets émis', async () => {
    const buffer = richFixture();
    const savedRandom = Math.random;
    const savedDate = Date.now;
    try {
      Math.random = () => 0.999999;
      Date.now = () => 42;
      const a = await replay({ buffer, routing: RICH_ROUTING });
      Math.random = () => 0.000001;
      Date.now = () => 9_999_999;
      const b = await replay({ buffer, routing: RICH_ROUTING });
      expect(serializeTrace(b.trace)).toBe(serializeTrace(a.trace));
    } finally {
      Math.random = savedRandom;
      Date.now = savedDate;
    }
  });

  test('aucun timer ne fuit après la fin de lecture', async () => {
    const buffer = richFixture();
    const { clock, player } = await replay({ buffer, routing: RICH_ROUTING });
    expect(player.playing).toBe(false);
    expect(clock.pending).toBe(0);
  });

  test('hors dernier tick, aucune note orpheline (contrôle positif)', async () => {
    // Fin de fichier volontairement HORS grille 10 ms (2001 ticks ≈ 2 084,4 ms)
    // pour isoler F-54 : ici tout doit être apparié.
    const buffer = buildNoteTrack(
      [
        { tick: 0, note: 60, dur: 240 },
        { tick: 480, note: 64, dur: 240 },
        { tick: 960, note: 67, dur: 240 },
        { tick: 2000, note: 36, dur: 1 }
      ],
      { ppq: PPQ }
    );
    const { trace } = await replay({
      buffer,
      routing: { 0: { device: 'devA', targetChannel: 0 } }
    });
    const pairing = analyseNotePairing(trace);
    expect(pairing.orphanOn).toEqual([]);
    expect(pairing.orphanOff).toEqual([]);
  });
});
