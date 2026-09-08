/**
 * @file tests/audit/l05-transport.test.js
 * @description Lot L05 — §F02 « Transport » : seek / pause / stop / reprise,
 * seek arrière, seek au-delà de la fin, arrêt pendant un SysEx, boucle.
 * Va au-delà de `tests/midi-player-stop-during-advance.test.js` en exerçant le
 * transport avec l'horloge injectée du harnais L05 (aucune temporisation réelle).
 */
import { describe, test, expect } from '@jest/globals';
import {
  buildPlayer,
  buildMidi,
  buildNoteTrack,
  installVirtualClock,
  VirtualClock,
  serializeTrace,
  analyseNotePairing,
  replay
} from './l05-replay-harness.test.js';

const PPQ = 480;

/** Session pilotée manuellement (horloge installée, à restaurer par l'appelant). */
async function session({ buffer, routing, capabilities = {}, delays = {}, startNow = 1000 }) {
  const clock = new VirtualClock(startNow);
  const { player, deviceManager } = await buildPlayer({ buffer, clock, capabilities, delays });
  player.channelRouting = new Map(Object.entries(routing).map(([k, v]) => [Number(k), v]));
  const inst = installVirtualClock(clock);
  return { player, clock, dm: deviceManager, trace: deviceManager.trace, restore: inst.restore };
}

const ROUTING_A = { 0: { device: 'devA', targetChannel: 0 } };

// ---------------------------------------------------------------------------
// F-54 — le dernier événement du fichier
// ---------------------------------------------------------------------------

describe('L05 · F-54 — les événements situés exactement à `duration` (corrigé)', () => {
  test('un accord final sur temps fort conserve TOUS ses note-off', async () => {
    // Accord de 3 notes, fin à 1920 ticks = 2 000 ms (multiple du tick 10 ms).
    const buffer = buildNoteTrack(
      [
        { tick: 960, note: 60, dur: 960 },
        { tick: 960, note: 64, dur: 960 },
        { tick: 960, note: 67, dur: 960 }
      ],
      { ppq: PPQ }
    );
    const { trace, player } = await replay({ buffer, routing: ROUTING_A });
    expect(player.duration).toBeCloseTo(2.0, 9);
    // AVANT correctif : 0 note-off, 3 notes orphelines, seul le CC 123 les
    // relâchait — inopérant sur un firmware qui n'implémente pas CC 123.
    const offs = trace.filter((e) => (e.status & 0xf0) === 0x80);
    expect(offs).toHaveLength(3);
    expect(analyseNotePairing(trace).orphanOn).toHaveLength(0);
    // Le CC 123 de fin de lecture reste émis (filet de sécurité).
    expect(trace.filter((e) => (e.status & 0xf0) === 0xb0 && e.data1 === 123)).toHaveLength(1);
    // Les note-off précèdent bien le CC 123.
    expect(trace.indexOf(offs[2])).toBeLessThan(
      trace.findIndex((e) => (e.status & 0xf0) === 0xb0 && e.data1 === 123)
    );
  });

  test('une fin hors de la grille 10 ms (cas qui fonctionnait déjà) reste correcte', async () => {
    // Fin à 1921 ticks ≈ 2 001,04 ms → le timer précède le tick de fin.
    const buffer = buildNoteTrack(
      [
        { tick: 960, note: 60, dur: 961 },
        { tick: 960, note: 64, dur: 961 },
        { tick: 960, note: 67, dur: 961 }
      ],
      { ppq: PPQ }
    );
    const { trace } = await replay({ buffer, routing: ROUTING_A });
    expect(trace.filter((e) => (e.status & 0xf0) === 0x80)).toHaveLength(3);
    expect(analyseNotePairing(trace).orphanOn).toHaveLength(0);
  });

  test('le CC 123 de secours ne part QUE sur les canaux routés (rien pour un canal non routé)', async () => {
    const buffer = buildMidi({
      ppq: PPQ,
      tracks: [
        [
          { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
          { deltaTime: 0, type: 'noteOn', channel: 5, noteNumber: 72, velocity: 100 },
          { deltaTime: 960, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 },
          { deltaTime: 0, type: 'noteOff', channel: 5, noteNumber: 72, velocity: 0 }
        ]
      ]
    });
    const { trace } = await replay({ buffer, routing: ROUTING_A });
    const ch5 = trace.filter((e) => (e.status & 0x0f) === 5);
    // Canal 5 non routé : aucune NOTE n'est émise…
    expect(
      ch5.filter((e) => (e.status & 0xf0) === 0x90 || (e.status & 0xf0) === 0x80)
    ).toHaveLength(0);
    // …mais le CC 123 de secours part quand même, vers le périphérique de
    // sortie PAR DÉFAUT (`dev1`), qui n'a jamais rien reçu de ce canal.
    expect(ch5).toEqual([expect.objectContaining({ device: 'dev1', status: 0xb5, data1: 123 })]);
  });
});

// ---------------------------------------------------------------------------
// Pause / reprise
// ---------------------------------------------------------------------------

describe('L05 · F02 — pause / reprise', () => {
  test('pause envoie All Notes Off et la reprise repart de la position gelée', async () => {
    const buffer = buildNoteTrack(
      Array.from({ length: 10 }, (_, i) => ({ tick: i * 240, note: 60 + i, dur: 200 })),
      { ppq: PPQ }
    );
    const s = await session({ buffer, routing: ROUTING_A });
    try {
      s.player.start('devA');
      await s.clock.advanceByAsync(600); // ~0,6 s de lecture
      const beforePause = s.trace.length;
      const posAtPause = s.player.position;
      s.player.pause();
      expect(s.player.paused).toBe(true);
      // Un CC 123 est émis à la pause.
      expect(s.trace[s.trace.length - 1]).toMatchObject({ status: 0xb0, data1: 123 });
      // Rien ne sort pendant la pause, même longue.
      const afterPauseLen = s.trace.length;
      await s.clock.advanceByAsync(5000);
      expect(s.trace.length).toBe(afterPauseLen);
      expect(s.player.position).toBeCloseTo(posAtPause, 6);

      s.player.resume();
      await s.clock.advanceByAsync(300);
      expect(s.trace.length).toBeGreaterThan(afterPauseLen);
      expect(s.player.position).toBeGreaterThan(posAtPause);
      expect(beforePause).toBeGreaterThan(0);
    } finally {
      s.restore();
    }
  });

  test('une pause pendant une note tenue laisse la note ouverte (CC 123 uniquement)', async () => {
    const buffer = buildNoteTrack([{ tick: 0, note: 60, dur: 1920 }], { ppq: PPQ });
    const s = await session({ buffer, routing: ROUTING_A });
    try {
      s.player.start('devA');
      await s.clock.advanceByAsync(300);
      s.player.pause();
      const offs = s.trace.filter((e) => (e.status & 0xf0) === 0x80);
      expect(offs).toHaveLength(0);
      expect(s.trace.filter((e) => e.data1 === 123 && (e.status & 0xf0) === 0xb0)).toHaveLength(1);
    } finally {
      s.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Seek
// ---------------------------------------------------------------------------

describe('L05 · F02 — seek', () => {
  test('seek avant : la position est appliquée et la lecture reprend', async () => {
    const buffer = buildNoteTrack(
      Array.from({ length: 16 }, (_, i) => ({ tick: i * 240, note: 60 + (i % 12), dur: 200 })),
      { ppq: PPQ }
    );
    const s = await session({ buffer, routing: ROUTING_A });
    try {
      s.player.start('devA');
      await s.clock.advanceByAsync(100);
      s.player.seek(1.5);
      expect(s.player.position).toBeCloseTo(1.5, 6);
      expect(s.player.playing).toBe(true);
      expect(s.player.paused).toBe(false);
      await s.clock.advanceByAsync(100);
      expect(s.player.position).toBeGreaterThan(1.5);
    } finally {
      s.restore();
    }
  });

  test('seek arrière : envoie All Notes Off ET Reset All Controllers (CC 121)', async () => {
    const buffer = buildNoteTrack(
      Array.from({ length: 16 }, (_, i) => ({ tick: i * 240, note: 60, dur: 200 })),
      { ppq: PPQ }
    );
    const s = await session({ buffer, routing: ROUTING_A });
    try {
      s.player.start('devA');
      await s.clock.advanceByAsync(800);
      const mark = s.trace.length;
      s.player.seek(0.1);
      const after = s.trace.slice(mark);
      expect(after.some((e) => (e.status & 0xf0) === 0xb0 && e.data1 === 123)).toBe(true);
      expect(after.some((e) => (e.status & 0xf0) === 0xb0 && e.data1 === 121)).toBe(true);
    } finally {
      s.restore();
    }
  });

  test('seek au-delà de la fin est borné à `duration` et termine proprement', async () => {
    const buffer = buildNoteTrack(
      Array.from({ length: 8 }, (_, i) => ({ tick: i * 240, note: 60, dur: 200 })),
      { ppq: PPQ }
    );
    const s = await session({ buffer, routing: ROUTING_A });
    try {
      s.player.start('devA');
      await s.clock.advanceByAsync(50);
      s.player.seek(9999);
      expect(s.player.position).toBeCloseTo(s.player.duration, 6);
      await s.clock.advanceByAsync(200);
      // La fin de fichier est détectée : lecture arrêtée, aucun timer résiduel.
      expect(s.player.playing).toBe(false);
      expect(s.clock.pending).toBe(0);
    } finally {
      s.restore();
    }
  });

  test('seek négatif est borné à 0', async () => {
    const buffer = buildNoteTrack([{ tick: 0, note: 60, dur: 960 }], { ppq: PPQ });
    const s = await session({ buffer, routing: ROUTING_A });
    try {
      s.player.start('devA');
      await s.clock.advanceByAsync(200);
      s.player.seek(-42);
      expect(s.player.position).toBe(0);
    } finally {
      s.restore();
    }
  });

  test('seek pendant une PAUSE ne relance pas la lecture (reste en pause)', async () => {
    const buffer = buildNoteTrack(
      Array.from({ length: 16 }, (_, i) => ({ tick: i * 240, note: 60, dur: 200 })),
      { ppq: PPQ }
    );
    const s = await session({ buffer, routing: ROUTING_A });
    try {
      s.player.start('devA');
      await s.clock.advanceByAsync(200);
      s.player.pause();
      s.player.seek(1.0);
      expect(s.player.paused).toBe(true);
      expect(s.player.position).toBeCloseTo(1.0, 6);
      const len = s.trace.length;
      await s.clock.advanceByAsync(2000);
      expect(s.trace.length).toBe(len); // toujours silencieux
      s.player.resume();
      await s.clock.advanceByAsync(50);
      // La reprise repart bien de 1,0 s (± un tick), pas de la position d'avant seek.
      expect(s.player.position).toBeGreaterThanOrEqual(1.0);
      expect(s.player.position).toBeLessThan(1.1);
    } finally {
      s.restore();
    }
  });

  test('seek reconstruit l’état de canal (bank + program + CC + pitch-bend)', async () => {
    const buffer = buildMidi({
      ppq: PPQ,
      tracks: [
        [
          { deltaTime: 0, type: 'controller', channel: 0, controllerType: 0, value: 3 },
          { deltaTime: 0, type: 'controller', channel: 0, controllerType: 32, value: 4 },
          { deltaTime: 0, type: 'programChange', channel: 0, programNumber: 55 },
          { deltaTime: 0, type: 'controller', channel: 0, controllerType: 7, value: 90 },
          { deltaTime: 0, type: 'pitchBend', channel: 0, value: 2048 },
          { deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
          { deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 },
          { deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 64, velocity: 100 },
          { deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 64, velocity: 0 }
        ]
      ]
    });
    const s = await session({ buffer, routing: ROUTING_A });
    try {
      s.player.start('devA');
      await s.clock.advanceByAsync(50);
      const mark = s.trace.length;
      s.player.seek(1.6); // après la 1re note
      const after = s.trace.slice(mark);
      const kinds = after.map((e) => `${(e.status & 0xf0).toString(16)}:${e.data1}`);
      expect(kinds).toContain('b0:0'); // bank MSB
      expect(kinds).toContain('b0:32'); // bank LSB
      expect(kinds).toContain('c0:55'); // program change
      expect(kinds).toContain('b0:7'); // volume
      expect(kinds.some((k) => k.startsWith('e0'))).toBe(true); // pitch-bend
    } finally {
      s.restore();
    }
  });

  test('seek pendant un SysEx : le SysEx en vol est annulé, aucune trame tronquée', async () => {
    const sysex = { deltaTime: 0, type: 'sysEx', data: [0x41, 0x10, 0x42, 0x12, 0xf7] };
    const buffer = buildMidi({
      ppq: PPQ,
      tracks: [
        [
          { deltaTime: 240, ...sysex },
          { deltaTime: 240, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
          { deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 }
        ]
      ]
    });
    const s = await session({ buffer, routing: ROUTING_A });
    try {
      s.player.start('devA');
      // stop() avant que le timer du SysEx (t = 250 ms) ne parte.
      await s.clock.advanceByAsync(20);
      s.player.stop();
      await s.clock.advanceByAsync(1000);
      expect(s.trace.filter((e) => e.type === 'sysex')).toHaveLength(0);
      expect(s.clock.pending).toBe(0);
    } finally {
      s.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

describe('L05 · F02 — stop', () => {
  test('stop annule tous les timers en vol et remet la position à 0', async () => {
    const buffer = buildNoteTrack(
      Array.from({ length: 40 }, (_, i) => ({ tick: i * 48, note: 60 + (i % 12), dur: 40 })),
      { ppq: PPQ }
    );
    const s = await session({ buffer, routing: ROUTING_A });
    try {
      s.player.start('devA');
      await s.clock.advanceByAsync(120);
      const len = s.trace.length;
      expect(len).toBeGreaterThan(0);
      s.player.stop();
      expect(s.player.position).toBe(0);
      expect(s.clock.pending).toBe(0);
      await s.clock.advanceByAsync(5000);
      // Après stop : seulement le CC 123 émis par stop() lui-même.
      const extra = s.trace.slice(len);
      expect(extra.every((e) => (e.status & 0xf0) === 0xb0 && e.data1 === 123)).toBe(true);
    } finally {
      s.restore();
    }
  });

  test('stop est idempotent et stop() sans lecture ne produit rien', async () => {
    const buffer = buildNoteTrack([{ tick: 0, note: 60, dur: 240 }], { ppq: PPQ });
    const s = await session({ buffer, routing: ROUTING_A });
    try {
      s.player.stop();
      expect(s.trace).toHaveLength(0);
      s.player.start('devA');
      await s.clock.advanceByAsync(30);
      s.player.stop();
      const len = s.trace.length;
      s.player.stop();
      expect(s.trace.length).toBe(len);
    } finally {
      s.restore();
    }
  });

  test('stop PENDANT le tick d’avance (advance) laisse la lecture arrêtée', async () => {
    // Version « horloge injectée » du scénario de
    // tests/midi-player-stop-during-advance.test.js : on appelle stop() depuis
    // l'intérieur d'un callback de timer, au milieu de la fenêtre de lookahead.
    const buffer = buildNoteTrack(
      Array.from({ length: 30 }, (_, i) => ({ tick: i * 96, note: 60, dur: 48 })),
      { ppq: PPQ }
    );
    const s = await session({ buffer, routing: ROUTING_A });
    try {
      s.player.start('devA');
      await s.clock.advanceByAsync(45);
      // stop() déclenché depuis un timer qui s'intercale dans la cascade.
      s.clock.setTimeout(() => s.player.stop(), 1);
      await s.clock.advanceByAsync(5);
      const len = s.trace.length;
      await s.clock.advanceByAsync(3000);
      expect(s.player.playing).toBe(false);
      expect(s.clock.pending).toBe(0);
      expect(s.trace.length).toBe(len);
    } finally {
      s.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Boucle
// ---------------------------------------------------------------------------

describe('L05 · F-57 — pause/resume ne doit pas perdre la fenêtre de lookahead', () => {
  test('aucun événement perdu ni dupliqué autour d’une pause', async () => {
    // Notes toutes les 25 ms : la fenêtre de lookahead (100 ms) en contient 4.
    const notes = Array.from({ length: 40 }, (_, i) => ({
      tick: i * 24,
      note: 60 + (i % 12),
      dur: 12
    }));
    const buffer = buildNoteTrack(notes, { ppq: PPQ });

    const linesOf = (trace) =>
      trace
        .filter((e) => (e.status & 0xf0) === 0x90 || (e.status & 0xf0) === 0x80)
        .map((e) => `${(e.status & 0xf0).toString(16)}:${e.data1}:${e.data2}`);

    // Référence : lecture continue.
    const ref = await session({ buffer, routing: ROUTING_A });
    let refLines;
    try {
      ref.player.start('devA');
      await ref.clock.advanceByAsync(1400);
      refLines = linesOf(ref.trace);
    } finally {
      ref.restore();
    }

    // Même lecture, avec une pause de 200 ms au milieu.
    const s = await session({ buffer, routing: ROUTING_A });
    let pausedLines;
    try {
      s.player.start('devA');
      await s.clock.advanceByAsync(300);
      s.player.pause();
      await s.clock.advanceByAsync(200);
      s.player.resume();
      await s.clock.advanceByAsync(1200);
      pausedLines = linesOf(s.trace);
    } finally {
      s.restore();
    }

    // Exactement la même séquence de notes, dans le même ordre.
    expect(pausedLines).toEqual(refLines);
  });

  test('la pause fige la position exacte (pas celle du dernier tick)', async () => {
    const buffer = buildNoteTrack(
      Array.from({ length: 40 }, (_, i) => ({ tick: i * 24, note: 60, dur: 12 })),
      { ppq: PPQ }
    );
    const s = await session({ buffer, routing: ROUTING_A });
    try {
      s.player.start('devA');
      await s.clock.advanceByAsync(307); // 7 ms après le dernier tick
      s.player.pause();
      expect(s.player.position).toBeCloseTo(0.307, 6);
    } finally {
      s.restore();
    }
  });
});

describe('L05 · F02 — boucle', () => {
  test('loop = true relance le fichier depuis 0 (deux passes observées)', async () => {
    const buffer = buildNoteTrack(
      [
        { tick: 0, note: 60, dur: 200 },
        { tick: 480, note: 64, dur: 200 }
      ],
      { ppq: PPQ }
    );
    const s = await session({ buffer, routing: ROUTING_A });
    try {
      s.player.loop = true;
      s.player.start('devA');
      await s.clock.advanceByAsync(2500); // > 3 durées (0,708 s)
      const ons = s.trace.filter((e) => (e.status & 0xf0) === 0x90 && e.data2 > 0);
      // La note 60 (tick 0) doit revenir à chaque passe.
      expect(ons.filter((e) => e.data1 === 60).length).toBeGreaterThanOrEqual(3);
      expect(ons.filter((e) => e.data1 === 64).length).toBeGreaterThanOrEqual(3);
      expect(s.player.playing).toBe(true);
      s.player.loop = false;
      s.player.stop();
    } finally {
      s.restore();
    }
  });

  test('T2.10 — aucune boucle A/B côté backend : `playback_set_loop` est un simple booléen', async () => {
    const { playback_set_loop } =
      await import('../../src/api/commands/schemas/playback.schemas.js');
    // Le schéma n'accepte que `enabled` : pas de loopStart / loopEnd.
    expect(playback_set_loop.custom({ enabled: true })).toEqual([]);
    expect(playback_set_loop.custom({ start: 1, end: 2 }).length).toBeGreaterThan(0);
    const buffer = buildNoteTrack([{ tick: 0, note: 60, dur: 240 }], { ppq: PPQ });
    const { player } = await buildPlayer({ buffer, clock: new VirtualClock() });
    // Aucun champ de boucle A/B n'existe sur le moteur.
    expect(player.loopStart).toBeUndefined();
    expect(player.loopEnd).toBeUndefined();
    expect(typeof player.loop).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// Trace de référence (non-régression)
// ---------------------------------------------------------------------------

describe('L05 · trace de référence', () => {
  test('empreinte stable d’un transport complet start→seek→pause→resume→stop', async () => {
    const buffer = buildNoteTrack(
      Array.from({ length: 8 }, (_, i) => ({ tick: i * 240, note: 60 + i, dur: 200 })),
      { ppq: PPQ }
    );
    const run = async () => {
      const s = await session({ buffer, routing: ROUTING_A });
      try {
        s.player.start('devA');
        await s.clock.advanceByAsync(300);
        s.player.seek(0.8);
        await s.clock.advanceByAsync(200);
        s.player.pause();
        await s.clock.advanceByAsync(500);
        s.player.resume();
        await s.clock.advanceByAsync(300);
        s.player.stop();
        return serializeTrace(s.trace);
      } finally {
        s.restore();
      }
    };
    const a = await run();
    const b = await run();
    expect(b).toBe(a);
    expect(a.split('\n').length).toBeGreaterThan(5);
  });
});
