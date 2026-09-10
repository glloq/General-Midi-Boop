/**
 * @file tests/audit/r21-song-position-pointer.test.js
 * @description **R21 — Song Position Pointer au seek** (audit
 * `03_MIDI_CORE.md` §F-43 et §F-44, vague 4 « robustesse de scène »).
 *
 * ## F-43 (P2) — un seek renvoyait l'esclave à la mesure 1
 * `MidiClockGenerator` ne connaissait que quatre messages : `start` (0xFA),
 * `clock` (0xF8), `stop` (0xFC), `continue` (0xFB). Aucune API de
 * localisation. Or `MidiPlayer.seek()` sur une lecture active fait
 * `stopPlayback()` puis `start()` → `startPlayback()`, donc **FC puis FA** —
 * et MIDI 1.0 définit 0xFA Start comme « jouer **depuis le début** ». Chaque
 * déplacement du curseur ramenait donc tout esclave synchronisé à la mesure 1.
 * La séquence conforme est `FC Stop → F2 Song Position Pointer → FB Continue`.
 *
 * ## F-44 (P3) — la rafale de rattrapage après un gel
 * `_scheduleNextTick()` planifiait chaque tick manqué à délai 0 : un gel de
 * 5 s à 120 BPM produisait **240 messages 0xF8 sur le même instant**, vers
 * tous les ports. La vague 1 a ramené le gel mesuré de 5 031 ms à 257 ms,
 * mais la rafale restait. L'horloge se ré-ancre désormais au-delà de deux
 * intervalles de retard.
 *
 * Le vocabulaire de l'horloge est testé au niveau `deviceManager.sendMessage`,
 * c'est-à-dire exactement là où s'arrête son contrat — comme
 * `l03-midi-clock.test.js`, dont ce fichier prolonge la couverture du côté
 * **MidiPlayer** (la séquence de transport réellement produite par un seek).
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { performance } from 'perf_hooks';
import MidiClockGenerator from '../../src/midi/playback/MidiClockGenerator.js';
import {
  VirtualClock,
  installVirtualClock,
  buildPlayer,
  buildNoteTrack,
  buildMidi,
  silentLogger
} from './l05-replay-harness.test.js';

const PPQ = 480;
const ROUTING = { 0: { device: 'devA', targetChannel: 0 } };

/**
 * Horloge maîtresse réelle, câblée sur un `deviceManager` d'enregistrement
 * séparé : les messages de transport ne se mélangent pas à la trace de notes.
 */
function makeClockGenerator({ devices = ['out-a'] } = {}) {
  const sent = [];
  const noop = () => {};
  const clock = new MidiClockGenerator({
    logger: silentLogger(),
    eventBus: { on: noop, off: noop, emit: noop },
    database: {
      getDeviceSettings: () => ({ midi_clock_enabled: 1 }),
      getInstrumentSettings: () => null
    },
    deviceManager: {
      outputs: new Map(devices.map((d) => [d, {}])),
      sendMessage: (device, type, data) => {
        sent.push({ device, type, data, at: performance.now() });
        return true;
      }
    }
  });
  clock.setEnabled(true);
  return { clock, sent };
}

/** Transport seulement (sans les 0xF8), dans l'ordre du fil. */
const transportOf = (sent) => sent.filter((s) => s.type !== 'clock').map((s) => s.type);

/**
 * Fichier long : une note toutes les 2 secondes pendant `seconds`, pour que
 * `seek()` ait une durée où se déplacer. 120 BPM, 480 ppq ⇒ 480 ticks = 500 ms.
 */
function longFile(seconds = 60) {
  const count = Math.floor(seconds / 2);
  return buildNoteTrack(
    Array.from({ length: count }, (_, i) => ({ tick: i * 1920, note: 60, dur: 240 })),
    { ppq: PPQ }
  );
}

/** MidiPlayer chargé + horloge maîtresse attachée, prêt à jouer. */
async function playerWithClock({ buffer = longFile(60) } = {}) {
  const clock = new VirtualClock(1000);
  const { player } = await buildPlayer({ buffer, clock });
  player.channelRouting = new Map(Object.entries(ROUTING).map(([ch, r]) => [Number(ch), r]));
  const { clock: gen, sent } = makeClockGenerator();
  player.midiClockGenerator = gen;
  player.scheduler.midiClockGenerator = gen;
  return { player, gen, sent, clock };
}

let installed = null;
beforeEach(() => {
  installed = null;
});
afterEach(() => {
  if (installed) installed.restore();
});

// ---------------------------------------------------------------------------
// F-43 — la séquence de seek
// ---------------------------------------------------------------------------

describe('R21/F-43 — un seek localise les esclaves au lieu de les renvoyer mesure 1', () => {
  test('lecture active : Stop → Song Position Pointer → Continue, sans second Start', async () => {
    const { player, sent, clock } = await playerWithClock();
    installed = installVirtualClock(clock);

    player.start('devA');
    expect(transportOf(sent)).toEqual(['start']); // départ normal = 0xFA

    player.seek(30); // l'opérateur déplace le curseur à 00:30

    // FC (stop) → F2 (position) → FB (continue). Aucun second 'start'.
    expect(transportOf(sent)).toEqual(['start', 'stop', 'position', 'continue']);
    expect(transportOf(sent).filter((t) => t === 'start')).toHaveLength(1);

    // 30 s à 120 BPM = 60 noires = 240 doubles croches (« MIDI beats »).
    const spp = sent.filter((s) => s.type === 'position');
    expect(spp).toHaveLength(1);
    expect(spp[0].data.value).toBe(240);
    expect(spp[0].data.bytes).toEqual([240 & 0x7f, 240 >> 7]);

    player.stop();
  });

  test('un départ depuis le début reste un Start (0xFA), pas un SPP+Continue', async () => {
    const { player, sent, clock } = await playerWithClock();
    installed = installVirtualClock(clock);

    player.start('devA');
    expect(transportOf(sent)).toEqual(['start']);
    expect(sent.some((s) => s.type === 'position')).toBe(false);

    player.stop();
  });

  test('un retour à la mesure 1 (boucle / seek 0) reste un Start, pas un Continue', async () => {
    const { player, sent, clock } = await playerWithClock();
    installed = installVirtualClock(clock);

    player.start('devA');
    player.seek(0); // exactement ce que fait la boucle en fin de fichier

    // Stop puis Start : MIDI 1.0 dit que Start signifie « depuis le début »,
    // ce qui est précisément l'intention ici.
    expect(transportOf(sent)).toEqual(['start', 'stop', 'start']);
    expect(sent.some((s) => s.type === 'position')).toBe(false);

    player.stop();
  });

  test('seek EN PAUSE : le SPP part quand même, sinon le Continue de resume() est faux', async () => {
    const { player, sent, clock } = await playerWithClock();
    installed = installVirtualClock(clock);

    player.start('devA');
    clock.advanceBy(500);
    player.pause(); // l'horloge envoie Stop et reste _running
    const beforeSeek = transportOf(sent);
    expect(beforeSeek[beforeSeek.length - 1]).toBe('stop');

    player.seek(20);
    // Le SPP arrive PENDANT que l'esclave est arrêté — c'est ce que la
    // spécification demande — puis resume() envoie Continue.
    expect(transportOf(sent).slice(-1)).toEqual(['position']);
    const spp = sent.filter((s) => s.type === 'position');
    expect(spp).toHaveLength(1);
    expect(spp[0].data.value).toBe(160); // 20 s @120 BPM = 40 noires = 160 seizièmes

    player.resume();
    expect(transportOf(sent).slice(-1)).toEqual(['continue']);

    player.stop();
  });

  test('le SPP est exact malgré un changement de tempo en cours de morceau', async () => {
    // 4 noires à 120 BPM (2 s), puis 240 BPM. La position 3 s tombe donc
    // 1 s après le changement, soit 4 + 4 = 8 noires = 32 doubles croches.
    const track = [
      { deltaTime: 0, meta: true, type: 'setTempo', microsecondsPerBeat: 500000 }, // 120
      { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
      { deltaTime: 120, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 },
      { deltaTime: 1800, meta: true, type: 'setTempo', microsecondsPerBeat: 250000 }, // 240
      { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 62, velocity: 100 },
      { deltaTime: 240, type: 'noteOff', channel: 0, noteNumber: 62, velocity: 0 },
      { deltaTime: 4800, type: 'noteOn', channel: 0, noteNumber: 64, velocity: 100 },
      { deltaTime: 240, type: 'noteOff', channel: 0, noteNumber: 64, velocity: 0 }
    ];
    const { player } = await playerWithClock({ buffer: buildMidi({ ppq: PPQ, tracks: [track] }) });

    // Un calcul naïf `secondes × tempo/60 × 4` avec le tempo COURANT (240)
    // donnerait 48 : la conversion passe par les ticks, donc par la carte de
    // tempo, et rend 32.
    expect(Math.round(player._songPositionBeats(3))).toBe(32);
    expect(player._songPositionBeats(0)).toBe(0);
    expect(player._songPositionBeats(-4)).toBe(0);
  });

  test('la position est bornée au domaine 14 bits du SPP', async () => {
    const { clock: gen, sent } = makeClockGenerator();
    // > 34 minutes de musique : la spec n'a pas de valeur au-delà de 16383.
    expect(gen.sendSongPosition(1e9)).toBe(0x3fff);
    expect(sent.at(-1).data.bytes).toEqual([0x7f, 0x7f]);
  });

  test('le SPP part vers TOUS les esclaves horloge, avec la compensation par appareil', async () => {
    const { clock: gen, sent } = makeClockGenerator({ devices: ['a', 'b'] });
    const vc = new VirtualClock(0);
    installed = installVirtualClock(vc);
    gen.sendSongPosition(96);
    vc.advanceBy(50);
    expect(
      sent
        .filter((s) => s.type === 'position')
        .map((s) => s.device)
        .sort()
    ).toEqual(['a', 'b']);
  });

  test('horloge désactivée : un seek n’émet toujours rien du tout', async () => {
    const { player, gen, sent, clock } = await playerWithClock();
    gen.setEnabled(false);
    installed = installVirtualClock(clock);

    player.start('devA');
    player.seek(30);
    expect(sent).toEqual([]);

    player.stop();
  });
});

// ---------------------------------------------------------------------------
// F-44 — le gel de la boucle d'événements
// ---------------------------------------------------------------------------

describe('R21/F-44 — après un gel, l’horloge se ré-ancre au lieu de rejouer la rafale', () => {
  /**
   * Horloge virtuelle minimale : `stall()` avance le temps SANS exécuter les
   * timers, exactement comme une boucle d'événements bloquée.
   */
  function virtualTimers() {
    const vc = new VirtualClock(0);
    const inst = installVirtualClock(vc);
    return { vc, inst };
  }

  test('un gel de 257 ms (la borne de la vague 1) ne produit pas de rafale', () => {
    const { clock: gen, sent } = makeClockGenerator();
    const { vc, inst } = virtualTimers();
    installed = inst;
    try {
      gen.startPlayback(120);
      vc.advanceBy(1000);
      const before = sent.filter((s) => s.type === 'clock').length;

      // Gel : le temps passe, aucun timer ne tourne.
      vc.now += 257;
      vc.advanceBy(0);

      const burst = sent.filter((s) => s.type === 'clock').length - before;
      expect(burst).toBeLessThanOrEqual(2); // c'étaient ~12 ticks empilés
      expect(gen.getSyncMetrics().resyncCount).toBe(1);
    } finally {
      gen.stopPlayback();
    }
  });

  test('un gel de 5 s : 240 ticks empilés deviennent au plus 1, et la cadence reprend', () => {
    const { clock: gen, sent } = makeClockGenerator();
    const { vc, inst } = virtualTimers();
    installed = inst;
    try {
      gen.startPlayback(120);
      vc.advanceBy(1000);
      const before = sent.filter((s) => s.type === 'clock').length;

      vc.now += 5000;
      vc.advanceBy(0);
      const burst = sent.filter((s) => s.type === 'clock').length - before;
      expect(burst).toBeLessThanOrEqual(2);

      // Aucun instant ne porte plus de 1 tick : c'est ce que « pas de rafale »
      // veut dire, et c'est l'assertion exacte que l'audit prenait à l'envers.
      const instants = sent.filter((s) => s.type === 'clock').map((s) => s.at);
      const perInstant = new Map();
      for (const t of instants) perInstant.set(t, (perInstant.get(t) || 0) + 1);
      expect(Math.max(...perInstant.values())).toBe(1);

      // …et la grille repart au bon intervalle (20,833 ms à 120 BPM).
      const resumed = sent.filter((s) => s.type === 'clock').length;
      vc.advanceBy(1000);
      const after = sent.filter((s) => s.type === 'clock').length - resumed;
      expect(after).toBeGreaterThanOrEqual(47);
      expect(after).toBeLessThanOrEqual(49);
    } finally {
      gen.stopPlayback();
    }
  });

  test('le ré-ancrage est compté et journalisé, pas silencieux', () => {
    const { clock: gen } = makeClockGenerator();
    const { vc, inst } = virtualTimers();
    installed = inst;
    try {
      gen.startPlayback(120);
      vc.advanceBy(100);
      expect(gen.getSyncMetrics()).toMatchObject({ resyncCount: 0, skippedTicks: 0 });

      vc.now += 2000;
      vc.advanceBy(0);
      const m = gen.getSyncMetrics();
      expect(m.resyncCount).toBe(1);
      // 2 s à 120 BPM = 96 ticks abandonnés au lieu d'être rejoués.
      expect(m.skippedTicks).toBeGreaterThanOrEqual(94);
      expect(m.skippedTicks).toBeLessThanOrEqual(98);
    } finally {
      gen.stopPlayback();
    }
  });

  test('la correction de dérive nominale est intacte : 2 880 ticks en 60 s à 120 BPM', () => {
    const { clock: gen, sent } = makeClockGenerator();
    const { vc, inst } = virtualTimers();
    installed = inst;
    try {
      gen.startPlayback(120);
      const interval = 60000 / (120 * 24);
      vc.advanceBy(60_000 + interval / 2);
      expect(sent.filter((s) => s.type === 'clock')).toHaveLength(2880);
      expect(gen.getSyncMetrics().resyncCount).toBe(0);
    } finally {
      gen.stopPlayback();
    }
  });
});
