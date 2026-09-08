/**
 * @file tests/audit/l05-polyphony-load.test.js
 * @description Lot L05 — §F04 « Charge polyphonique » (état `NOT TESTED` dans
 * l'audit du 2026-08-22). 16 canaux saturés, éviction de polyphonie
 * (`selectPolyphonyVictim`), `min_note_interval`, `min_note_duration`.
 *
 * **La mesure qui compte** : le nombre de *notes orphelines* — un Note On sans
 * Note Off correspondant. C'est le bug qui laisse un instrument bloqué en
 * scène. Chaque scénario le compte explicitement.
 */
import { describe, test, expect } from '@jest/globals';
import {
  replay,
  buildMidi,
  installVirtualClock,
  VirtualClock,
  buildPlayer,
  analyseNotePairing
} from './l05-replay-harness.test.js';

const PPQ = 480;

/**
 * Fichier dense multi-canaux : `channels` canaux, `notesPerChannel` notes
 * chacun, avec des accords qui se recouvrent.
 */
function denseFile({ channels = 16, notesPerChannel = 60, spacingTicks = 24, durTicks = 96 }) {
  const abs = [];
  for (let ch = 0; ch < channels; ch++) {
    for (let i = 0; i < notesPerChannel; i++) {
      const tick = i * spacingTicks + ch; // décalage par canal
      const note = 36 + ((i * 5 + ch * 3) % 60);
      abs.push({ tick, ev: { type: 'noteOn', channel: ch, noteNumber: note, velocity: 90 } });
      abs.push({
        tick: tick + durTicks,
        ev: { type: 'noteOff', channel: ch, noteNumber: note, velocity: 0 }
      });
    }
  }
  abs.forEach((a, i) => (a._i = i));
  abs.sort((a, b) => a.tick - b.tick || a._i - b._i);
  let last = 0;
  const track = abs.map((a) => {
    const deltaTime = a.tick - last;
    last = a.tick;
    return { ...a.ev, deltaTime };
  });
  return buildMidi({ ppq: PPQ, tracks: [track] });
}

/** Routage : 16 canaux vers 4 périphériques (4 canaux chacun). */
function routing16(devicesCount = 4) {
  const r = {};
  for (let ch = 0; ch < 16; ch++) {
    r[ch] = { device: `dev${ch % devicesCount}`, targetChannel: ch };
  }
  return r;
}

describe('L05 · F04 — 16 canaux saturés, sans contrainte', () => {
  test('960 notes sur 16 canaux : ZÉRO note orpheline', async () => {
    const buffer = denseFile({ channels: 16, notesPerChannel: 60 });
    const { trace, player } = await replay({ buffer, routing: routing16() });
    const noteMsgs = trace.filter((e) => (e.status & 0xf0) === 0x90 || (e.status & 0xf0) === 0x80);
    expect(noteMsgs.length).toBeGreaterThan(1800);
    const pairing = analyseNotePairing(trace);
    expect(pairing.orphanOff).toHaveLength(0);
    // Seules les notes dont le note-off tombe exactement à `duration` restent
    // ouvertes (F-54) ; hors de ce cas de bord, rien ne fuit.
    const lastTime = player.events[player.events.length - 1].time;
    const tailNotes = player.events.filter(
      (e) => e.time === lastTime && (e.type === 'noteOff' || e.type === 'noteOn')
    ).length;
    expect(pairing.orphanOn.length).toBeLessThanOrEqual(tailNotes);
  });

  test('la charge ne réordonne pas les messages d’un même canal', async () => {
    const buffer = denseFile({ channels: 16, notesPerChannel: 40 });
    const a = await replay({ buffer, routing: routing16() });
    const b = await replay({ buffer, routing: routing16() });
    const seq = (t) => t.map((e) => `${e.device}|${e.status}|${e.data1}|${e.data2}`).join(',');
    expect(seq(b.trace)).toBe(seq(a.trace));
  });
});

describe('L05 · F04 — plafond de polyphonie & éviction', () => {
  test('le nombre de voix simultanées ne dépasse JAMAIS le plafond déclaré', async () => {
    const buffer = denseFile({
      channels: 1,
      notesPerChannel: 80,
      spacingTicks: 24,
      durTicks: 480 // fort recouvrement : jusqu'à 20 voix demandées
    });
    const caps = {};
    caps['dev0:0'] = { polyphony: 4 };
    const { trace } = await replay({
      buffer,
      routing: { 0: { device: 'dev0', targetChannel: 0 } },
      capabilities: caps
    });
    const pairing = analyseNotePairing(trace);
    expect(pairing.maxConcurrent).toBeLessThanOrEqual(4);
    expect(pairing.orphanOff).toHaveLength(0);
  });

  test('l’éviction garde les voix extrêmes et lâche la médiane (politique keep-outer)', async () => {
    // Accord 60/64/67 tenu, puis une 4e note ; plafond 3.
    const track = [
      { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
      { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 64, velocity: 100 },
      { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 67, velocity: 100 },
      { deltaTime: 240, type: 'noteOn', channel: 0, noteNumber: 72, velocity: 100 },
      { deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 },
      { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 64, velocity: 0 },
      { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 67, velocity: 0 },
      { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 72, velocity: 0 },
      { deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 36, velocity: 1 },
      { deltaTime: 240, type: 'noteOff', channel: 0, noteNumber: 36, velocity: 0 }
    ];
    const buffer = buildMidi({ ppq: PPQ, tracks: [track] });
    const { trace } = await replay({
      buffer,
      routing: { 0: { device: 'dev0', targetChannel: 0 } },
      capabilities: { 'dev0:0': { polyphony: 3 } }
    });
    const notes = trace.filter((e) => (e.status & 0xf0) === 0x90 || (e.status & 0xf0) === 0x80);
    // La 4e note (72) est admise ; la médiane de [60,64,67,72] = 67 est évincée.
    const seq = notes.map((e) => `${(e.status & 0xf0) === 0x90 ? 'on' : 'off'}${e.data1}`);
    expect(seq).toContain('on72');
    expect(seq.indexOf('off67')).toBeLessThan(seq.indexOf('on72'));
    // Le note-off « réel » de 67 est avalé (il n'apparaît qu'une fois).
    expect(seq.filter((x) => x === 'off67')).toHaveLength(1);
    expect(analyseNotePairing(trace).orphanOff).toHaveLength(0);
  });

  test('un instrument MONOPHONIQUE ne laisse jamais deux notes ouvertes', async () => {
    const buffer = denseFile({ channels: 1, notesPerChannel: 40, spacingTicks: 48, durTicks: 240 });
    const { trace } = await replay({
      buffer,
      routing: { 0: { device: 'dev0', targetChannel: 0 } },
      capabilities: { 'dev0:0': { polyphony: 1 } }
    });
    expect(analyseNotePairing(trace).maxConcurrent).toBeLessThanOrEqual(1);
  });
});

describe('L05 · F04 — min_note_interval / min_note_duration', () => {
  test('un note-on filtré par min_note_interval ne laisse pas de note-off orphelin', async () => {
    const buffer = denseFile({ channels: 1, notesPerChannel: 60, spacingTicks: 12, durTicks: 24 });
    const { trace } = await replay({
      buffer,
      routing: { 0: { device: 'dev0', targetChannel: 0 } },
      capabilities: { 'dev0:0': { polyphony: 1, minNoteInterval: 60 } }
    });
    const pairing = analyseNotePairing(trace);
    expect(pairing.orphanOff).toHaveLength(0);
    // Beaucoup de notes filtrées : le débit est bien bridé.
    const ons = trace.filter((e) => (e.status & 0xf0) === 0x90 && e.data2 > 0);
    expect(ons.length).toBeLessThan(30);
  });

  test('min_note_duration : chaque note reste tenue au moins la durée déclarée', async () => {
    const MIN_DUR = 120; // ms
    // Notes très courtes (25 ms) : le note-off doit être différé.
    const buffer = denseFile({ channels: 1, notesPerChannel: 6, spacingTicks: 240, durTicks: 12 });
    const { trace } = await replay({
      buffer,
      routing: { 0: { device: 'dev0', targetChannel: 0 } },
      capabilities: { 'dev0:0': { minNoteDuration: MIN_DUR } },
      tailMs: 1000
    });
    const held = new Map();
    const durations = [];
    for (const e of trace) {
      if ((e.status & 0xf0) === 0x90 && e.data2 > 0) held.set(e.data1, e.t);
      else if ((e.status & 0xf0) === 0x80 && held.has(e.data1)) {
        durations.push(e.t - held.get(e.data1));
        held.delete(e.data1);
      }
    }
    expect(durations.length).toBeGreaterThan(0);
    for (const d of durations) expect(d).toBeGreaterThanOrEqual(MIN_DUR - 0.001);
  });
});

describe('L05 · F-58 — mute/unmute pendant la lecture : fuite du compteur de voix', () => {
  test('mute pendant des notes tenues gonfle définitivement le compteur de polyphonie', async () => {
    // 3 notes tenues longtemps sur un instrument à polyphonie 3, puis des
    // notes courtes une fois le canal ré-activé.
    const track = [
      { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
      { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 64, velocity: 100 },
      { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 67, velocity: 100 },
      { deltaTime: 240, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 },
      { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 64, velocity: 0 },
      { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 67, velocity: 0 },
      { deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 72, velocity: 100 },
      { deltaTime: 240, type: 'noteOff', channel: 0, noteNumber: 72, velocity: 0 },
      { deltaTime: 240, type: 'noteOn', channel: 0, noteNumber: 74, velocity: 100 },
      { deltaTime: 240, type: 'noteOff', channel: 0, noteNumber: 74, velocity: 0 }
    ];
    const buffer = buildMidi({ ppq: PPQ, tracks: [track] });
    const clock = new VirtualClock(1000);
    const { player, deviceManager } = await buildPlayer({
      buffer,
      clock,
      capabilities: { 'dev0:0': { polyphony: 3 } }
    });
    player.channelRouting = new Map([[0, { device: 'dev0', targetChannel: 0 }]]);
    player.outputDevice = 'dev0';
    const inst = installVirtualClock(clock);
    try {
      player.start('dev0');
      await clock.advanceByAsync(120); // les 3 notes sont parties
      player.muteChannel(0); // les note-off ne seront jamais dispatchés
      await clock.advanceByAsync(400);
      player.unmuteChannel(0);
      await clock.advanceByAsync(2000);
    } finally {
      inst.restore();
    }
    // 1. Le compteur interne du scheduler croit encore que 60 et 64 sonnent :
    //    leurs note-off n'ont jamais atteint `_dispatchToDevice` (le test de
    //    mute est FAIT AVANT, dans sendEvent), donc rien ne les a décrémentés.
    const counts = player.scheduler._activeNotes.get('dev0:0');
    const stillCounted = counts ? [...counts.keys()].sort((a, b) => a - b) : [];
    expect(stillCounted).toEqual(expect.arrayContaining([60, 64]));

    // 2. Conséquence audible : au retour du unmute, la polyphonie est déjà
    //    saturée, donc la note suivante déclenche une éviction et le moteur
    //    émet un note-off FANTÔME pour une hauteur qui ne sonne plus
    //    (elle avait été coupée par le CC 123 du mute).
    const trace = deviceManager.trace;
    const muteIdx = trace.findIndex((e) => (e.status & 0xf0) === 0xb0 && e.data1 === 123);
    const afterMute = trace.slice(muteIdx + 1);
    const phantomOffs = afterMute.filter(
      (e) => (e.status & 0xf0) === 0x80 && [60, 64, 67].includes(e.data1)
    );
    expect(phantomOffs.length).toBeGreaterThanOrEqual(1);
    // La note 72 est bien jouée, mais précédée de ce note-off fantôme.
    const on72 = afterMute.findIndex((e) => (e.status & 0xf0) === 0x90 && e.data1 === 72);
    expect(on72).toBeGreaterThan(0);
    expect(afterMute[on72 - 1]).toMatchObject({ status: 0x80, data1: 67 });
  });
});
