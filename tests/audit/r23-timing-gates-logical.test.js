/**
 * @file tests/audit/r23-timing-gates-logical.test.js
 * @description **R23 — les gardes de timing sont évalués en temps musical**
 * (audit `05_PLAYBACK.md` §4.2 **F-55** et §4.4 **F-61**, vague 4).
 *
 * ## Ce que l'audit a mesuré
 * `PlaybackScheduler._shouldGateNote` comparait `performance.now() -
 * lastNoteOnTime` à `min_note_interval` : une décision sur le **contenu
 * musical** prise sur l'**horloge murale**. Deux artefacts de l'ordonnanceur
 * faussaient la comparaison :
 *
 * - **(a) le retard du downbeat (F-55).** `start()` ancrait `startTime` puis
 *   laissait la première passe au `setInterval` : tout `[0, 10 ms[` partait
 *   d'un bloc à +10 ms. Huit notes espacées de 100 ms exactement, garde à
 *   95 ms ⇒ premier intervalle mesuré 90 ms ⇒ **une note sur huit supprimée
 *   sans aucune raison musicale**.
 * - **(b) l'agrégation `EMIT_AHEAD_MS`.** Deux notes distantes de 3 ms dans le
 *   fichier partent dans le même tick, donc au **même** `performance.now()` :
 *   l'écart mesuré vaut 0 et un garde de 2 ms — pourtant *inférieur* à l'écart
 *   réel — supprimait la seconde.
 *
 * Conséquence : **le nombre de notes jouées dépendait de la gigue**, dans un
 * moteur que L05 avait par ailleurs prouvé déterministe (cinq rejeux
 * identiques à l'octet).
 *
 * ## Ce que R23 change
 * - `min_note_interval` : évalué sur `event.time` (temps logique), divisé par
 *   `playbackRate` — la contrainte reste **physique** (course d'un actionneur),
 *   mais la décision devient **reproductible**.
 * - `min_note_duration` : la **décision** (« faut-il étirer cette note ? »)
 *   est musicale ; la **quantité** reste mesurée sur l'instant réel de la
 *   frappe, pour que le solénoïde reste bien engagé `min_note_duration`.
 * - F-55 : `start()` / `resume()` exécutent une première passe synchrone.
 *
 * Preuves via le **harnais de rejeu déterministe L05**
 * (`l05-replay-harness.test.js`, horloge injectée sur les 4 sources de temps,
 * trace d'octets) — réutilisé, pas réécrit.
 */
import { describe, test, expect, jest } from '@jest/globals';
import { performance } from 'perf_hooks';
import PlaybackScheduler from '../../src/midi/playback/PlaybackScheduler.js';
import { SEND_STATUS } from '../../src/core/constants.js';
import {
  replay,
  buildNoteTrack,
  serializeTrace,
  serializeBytes,
  silentLogger,
  VirtualClock,
  installVirtualClock
} from './l05-replay-harness.test.js';

const PPQ = 480;
const ROUTING = { 0: { device: 'devA', targetChannel: 0 } };

/** Note-ons réels d'une trace (vélocité > 0). */
const onsOf = (trace) => trace.filter((e) => (e.status & 0xf0) === 0x90 && e.data2 > 0);
const offsOf = (trace) =>
  trace.filter((e) => (e.status & 0xf0) === 0x80 || ((e.status & 0xf0) === 0x90 && e.data2 === 0));

/** Gigue pseudo-aléatoire reproductible (même modèle que L05 §BN). */
const jitter = (maxMs) => (timer) => {
  let a = (timer.seq * 0x9e3779b9 + timer.fires * 0x85ebca6b) >>> 0;
  a = (a ^ (a >>> 15)) >>> 0;
  a = Math.imul(a, 0x2c1b3c6d) >>> 0;
  a = (a ^ (a >>> 12)) >>> 0;
  a = Math.imul(a, 0x297a2d39) >>> 0;
  a = (a ^ (a >>> 15)) >>> 0;
  return (a / 4294967296) * maxMs;
};

/** N notes régulièrement espacées (120 BPM, 480 ppq ⇒ 96 ticks = 100 ms). */
function evenlySpaced(count, gapTicks = 96, { note = 60, dur = 48, ascending = false } = {}) {
  return buildNoteTrack(
    Array.from({ length: count }, (_, i) => ({
      tick: i * gapTicks,
      note: ascending ? note + i : note,
      dur
    })),
    { ppq: PPQ }
  );
}

function makeScheduler() {
  return new PlaybackScheduler({
    logger: silentLogger(),
    database: {},
    eventBus: { on() {}, off() {}, emit() {} },
    deviceManager: {
      sendMessageEx: jest.fn(() => ({ status: SEND_STATUS.SENT })),
      sendMessage: jest.fn(() => true)
    }
  });
}

// ---------------------------------------------------------------------------
// 1. F-61 (a) — le retard du downbeat ne supprime plus rien
// ---------------------------------------------------------------------------

describe('R23/F-61a — huit notes à 100 ms, garde à 95 ms : plus rien n’est coupé', () => {
  test('8 notes sur 8 sortent (l’audit en mesurait 7)', async () => {
    const buffer = evenlySpaced(8); // 96 ticks @120 BPM/480 ppq = 100 ms pile
    const free = await replay({ buffer, routing: ROUTING });
    const gated = await replay({
      buffer,
      routing: ROUTING,
      capabilities: { 'devA:0': { polyphony: 1, minNoteInterval: 95 } }
    });
    expect(onsOf(free.trace)).toHaveLength(8);
    expect(onsOf(gated.trace)).toHaveLength(8);
    // Le garde ne retire donc RIEN : mêmes octets que sans contrainte.
    expect(serializeBytes(gated.trace)).toBe(serializeBytes(free.trace));
  });

  test('taux de notes supprimées : 0 % sous cinq modèles de gigue différents', async () => {
    const buffer = evenlySpaced(8);
    const capabilities = { 'devA:0': { polyphony: 1, minNoteInterval: 95 } };
    const models = [null, jitter(1), jitter(3), jitter(7), jitter(12)];

    const counts = [];
    for (const lateness of models) {
      const { trace } = await replay({ buffer, routing: ROUTING, capabilities, lateness });
      counts.push(onsOf(trace).length);
    }
    // Le nombre de notes jouées ne dépend plus de la charge machine.
    expect(counts).toEqual([8, 8, 8, 8, 8]);
    const dropped = counts.reduce((acc, n) => acc + (8 - n), 0);
    expect(dropped / (8 * models.length)).toBe(0);
  });

  test('le garde reste actif quand le FICHIER est réellement trop rapide', async () => {
    // 24 ticks = 25 ms entre chaque frappe sur un instrument monophonique,
    // garde 95 ms : sur 12 frappes seules celles de 0, 100 et 200 ms passent.
    // C'est une suppression musicalement justifiée — le fichier demande
    // vraiment plus vite que l'actionneur ne sait faire.
    const buffer = evenlySpaced(12, 24, { dur: 12, ascending: true });
    const { trace } = await replay({
      buffer,
      routing: ROUTING,
      capabilities: { 'devA:0': { polyphony: 1, minNoteInterval: 95 } }
    });
    expect(onsOf(trace).map((e) => e.t)).toEqual([1000, 1100, 1200]);
  });

  test('le garde reste PHYSIQUE : à 2×, les mêmes 100 ms notés n’en font plus que 50', async () => {
    const buffer = evenlySpaced(8);
    const capabilities = { 'devA:0': { polyphony: 1, minNoteInterval: 95 } };
    const { trace } = await replay({
      buffer,
      routing: ROUTING,
      capabilities,
      mutate: (p) => {
        p.playbackRate = 2;
      }
    });
    // 100 ms notés / 2 = 50 ms réels < 95 ⇒ une frappe sur deux est refusée.
    // Un garde purement musical (qui ignorerait le taux) en aurait laissé 8 et
    // aurait cassé l'actionneur qu'il est censé protéger.
    expect(onsOf(trace)).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// 2. F-61 (b) — l'agrégation EMIT_AHEAD_MS ne supprime plus rien
// ---------------------------------------------------------------------------

describe('R23/F-61b — deux notes à 3 ms, garde à 2 ms : la seconde survit', () => {
  const closePair = buildNoteTrack(
    [
      { tick: 0, note: 60, dur: 48 },
      { tick: 3, note: 62, dur: 48 } // 3 ticks ≈ 3,125 ms
    ],
    { ppq: PPQ }
  );

  test('les deux notes partent au même instant mur mais restent 3 ms distinctes', async () => {
    const { trace } = await replay({
      buffer: closePair,
      routing: ROUTING,
      capabilities: { 'devA:0': { polyphony: 8, minNoteInterval: 2 } }
    });
    const ons = onsOf(trace);
    expect(ons).toHaveLength(2); // l'audit en mesurait 1
    expect(ons[0].t).toBe(ons[1].t); // l'agrégation existe toujours…
    expect(ons.map((e) => e.data1)).toEqual([60, 62]); // …mais ne décide plus
  });

  test('un garde SUPÉRIEUR à l’écart du fichier coupe toujours', async () => {
    // Même hauteur : le garde est par hauteur dès que l'instrument est
    // polyphonique. 3,125 ms d'écart, garde à 10 ms ⇒ la seconde tombe.
    const samePitch = buildNoteTrack(
      [
        { tick: 0, note: 60, dur: 1 },
        { tick: 3, note: 60, dur: 48 }
      ],
      { ppq: PPQ }
    );
    const { trace } = await replay({
      buffer: samePitch,
      routing: ROUTING,
      capabilities: { 'devA:0': { polyphony: 8, minNoteInterval: 10 } }
    });
    expect(onsOf(trace)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Déterminisme — le protocole des cinq rejeux de L05, gardes actives
// ---------------------------------------------------------------------------

describe('R23 — déterminisme du moteur avec les gardes de timing activées', () => {
  const capabilities = {
    'devA:0': { polyphony: 3, minNoteInterval: 40, minNoteDuration: 30 }
  };
  const buffer = buildNoteTrack(
    [
      { tick: 0, note: 60, dur: 12 },
      { tick: 3, note: 64, dur: 12 },
      { tick: 24, note: 67, dur: 240 },
      { tick: 48, note: 60, dur: 12 },
      { tick: 96, note: 72, dur: 480 },
      { tick: 120, note: 55, dur: 12 },
      { tick: 240, note: 60, dur: 480 }
    ],
    { ppq: PPQ }
  );

  test('cinq rejeux identiques : mêmes octets AUX MÊMES INSTANTS', async () => {
    const runs = [];
    for (let i = 0; i < 5; i++) {
      const { trace } = await replay({ buffer, routing: ROUTING, capabilities });
      runs.push(serializeTrace(trace));
    }
    for (const r of runs) expect(r).toBe(runs[0]);
    expect(runs[0].length).toBeGreaterThan(0);
  });

  test('sous cinq gigues différentes, le CONTENU musical ne bouge plus', async () => {
    const models = [null, jitter(1), jitter(3), jitter(7), jitter(12)];
    const prints = [];
    for (const lateness of models) {
      const { trace } = await replay({ buffer, routing: ROUTING, capabilities, lateness });
      prints.push({
        ons: onsOf(trace).length,
        offs: offsOf(trace).length,
        // Multi-ensemble d'octets : la gigue peut réordonner deux événements
        // du même tick (L05 §BN), elle ne doit plus en ajouter ni en retirer.
        bytes: serializeBytes(trace).split('\n').sort().join('\n')
      });
    }
    for (const p of prints) {
      expect(p.ons).toBe(prints[0].ons);
      expect(p.offs).toBe(prints[0].offs);
      expect(p.bytes).toBe(prints[0].bytes);
    }
  });

  test('aucune note orpheline : chaque note-on admise reçoit son note-off', async () => {
    const { trace } = await replay({ buffer, routing: ROUTING, capabilities });
    const active = new Map();
    for (const e of trace) {
      const kind = e.status & 0xf0;
      const key = `${e.device}:${e.status & 0x0f}:${e.data1}`;
      if (kind === 0x90 && e.data2 > 0) active.set(key, (active.get(key) || 0) + 1);
      else if (kind === 0x80 || (kind === 0x90 && e.data2 === 0)) {
        const c = active.get(key) || 0;
        if (c <= 1) active.delete(key);
        else active.set(key, c - 1);
      }
    }
    expect([...active.keys()]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. min_note_duration — décision musicale, quantité physique
// ---------------------------------------------------------------------------

describe('R23 — min_note_duration : la décision est musicale, l’étirement est physique', () => {
  function armed(minDur) {
    const sched = makeScheduler();
    sched._getTimingConstraints = () => ({
      minNoteInterval: null,
      minNoteDuration: minDur,
      polyphony: null
    });
    return sched;
  }

  test('une note dont la DURÉE NOTÉE atteint le minimum n’est jamais étirée', () => {
    const sched = armed(30);
    sched._shouldGateNote('d', 0, 60, 'noteOn', 0, 1);
    // 40 ms notés ≥ 30 ms : aucun report, quoi qu'ait fait l'horloge murale.
    expect(sched._noteOffDeferMs('d', 0, 60, 40, 1)).toBe(0);
  });

  test('une note plus courte que le minimum est étirée depuis la FRAPPE RÉELLE', () => {
    const vc = new VirtualClock(500);
    const inst = installVirtualClock(vc);
    try {
      const sched = armed(30);
      sched._shouldGateNote('d', 0, 60, 'noteOn', 0, 1);
      // 12 ms de temps réel se sont écoulés depuis la frappe ; la note ne dure
      // que 3 ms sur la partition, donc il faut l'étirer — mais de 18 ms, pas
      // de 27 : le solénoïde est déjà engagé depuis 12 ms.
      vc.now += 12;
      expect(sched._noteOffDeferMs('d', 0, 60, 3, 1)).toBeCloseTo(18, 6);
    } finally {
      inst.restore();
    }
  });

  test('le taux de lecture entre dans la décision (durée notée ÷ rate)', () => {
    const sched = armed(30);
    sched._shouldGateNote('d', 0, 60, 'noteOn', 0, 2);
    // 40 ms notés joués à 2× ne durent que 20 ms réelles < 30 ⇒ étirement.
    expect(sched._noteOffDeferMs('d', 0, 60, 40, 2)).toBeGreaterThan(0);
    // …alors qu'à vitesse nominale la même note n'aurait rien déclenché.
    expect(sched._noteOffDeferMs('d', 0, 60, 40, 1)).toBe(0);
  });

  test('un instrument sans min_note_duration n’a jamais de report', () => {
    const sched = armed(null);
    sched._shouldGateNote('d', 0, 60, 'noteOn', 0, 1);
    expect(sched._noteOffDeferMs('d', 0, 60, 1, 1)).toBe(0);
  });

  test('sur la trace : la note tenue physiquement l’est bien min_note_duration', async () => {
    // Une seconde note bien plus loin garde la lecture ouverte : un fichier qui
    // se termine sur la note étirée verrait son note-off différé annulé par le
    // All Notes Off de fin (comportement de `stop()`, hors périmètre R23).
    const shortNote = buildNoteTrack(
      [
        { tick: 0, note: 60, dur: 3 },
        { tick: 960, note: 72, dur: 240 }
      ],
      { ppq: PPQ }
    );
    const { trace } = await replay({
      buffer: shortNote,
      routing: ROUTING,
      capabilities: { 'devA:0': { polyphony: 8, minNoteDuration: 30 } }
    });
    const on = onsOf(trace)[0];
    const off = offsOf(trace)[0];
    expect(off.t - on.t).toBeCloseTo(30, 6); // 3 ms notés, 30 ms réels tenus
  });
});

// ---------------------------------------------------------------------------
// 5. Régressions ponctuelles du garde d'intervalle
// ---------------------------------------------------------------------------

describe('R23 — le garde d’intervalle au niveau unité', () => {
  function armedInterval(minInterval, polyphony) {
    const sched = makeScheduler();
    sched._getTimingConstraints = () => ({
      minNoteInterval: minInterval,
      minNoteDuration: null,
      polyphony
    });
    return sched;
  }

  test('l’instant logique 0 est un instant comme un autre (pas « pas de note avant »)', () => {
    // L'ancien code testait `lastTime > 0` : avec des instants logiques, 0 est
    // le tout premier événement du fichier, pas une absence de valeur.
    const sched = armedInterval(10, 1);
    expect(sched._shouldGateNote('d', 0, 60, 'noteOn', 0, 1).gate).toBe(false);
    expect(sched._shouldGateNote('d', 0, 64, 'noteOn', 0, 1).gate).toBe(true);
  });

  test('un saut arrière de la timeline n’étouffe pas la suite du morceau', () => {
    // Un delta négatif signifie que la timeline a été ré-ancrée (seek, boucle)
    // sans réinitialisation du suivi : la note est admise, pas coupée — sinon
    // un seek arrière ferait taire l'instrument jusqu'au prochain reset.
    const sched = armedInterval(100, 8);
    sched._shouldGateNote('d', 0, 60, 'noteOn', 5000, 1);
    expect(sched._shouldGateNote('d', 0, 60, 'noteOn', 0, 1).gate).toBe(false);
  });

  test('les maps de suivi contiennent des instants LOGIQUES, jamais performance.now()', () => {
    const sched = armedInterval(100, 8);
    const before = performance.now();
    sched._shouldGateNote('devX', 3, 60, 'noteOn', 1234, 1);
    expect(sched._lastNoteOnTime.get('devX:3:60')).toBe(1234);
    expect(sched._noteOnTimes.get('devX:3:60')).toBe(1234);
    // …et l'ancre murale, elle, est bien murale (pour l'étirement seulement).
    expect(sched._noteOnWallTimes.get('devX:3:60')).toBeGreaterThanOrEqual(before);
  });

  test('resetForPlayback / resetNoteTracking vident aussi l’ancre murale', () => {
    const sched = armedInterval(100, 8);
    sched._shouldGateNote('d', 0, 60, 'noteOn', 0, 1);
    expect(sched._noteOnWallTimes.size).toBe(1);
    sched.resetNoteTracking();
    expect(sched._noteOnWallTimes.size).toBe(0);
    sched._shouldGateNote('d', 0, 60, 'noteOn', 0, 1);
    sched.resetForPlayback();
    expect(sched._noteOnWallTimes.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. F-55 — le downbeat
// ---------------------------------------------------------------------------

describe('R23/F-55 — le premier événement part à l’heure', () => {
  test('start() : le downbeat n’est plus décalé d’un tick', async () => {
    const buffer = buildNoteTrack(
      [
        { tick: 0, note: 60, dur: 48 },
        { tick: 480, note: 62, dur: 48 }
      ],
      { ppq: PPQ }
    );
    const { trace } = await replay({ buffer, routing: ROUTING, startNow: 1000 });
    const ons = onsOf(trace);
    expect(ons[0].t).toBe(1000); // était 1010
    expect(ons[1].t - ons[0].t).toBe(500); // était 490
  });

  test('resume() : rien ne part en retard après une reprise non plus', async () => {
    const buffer = buildNoteTrack(
      Array.from({ length: 6 }, (_, i) => ({ tick: i * 480, note: 60 + i, dur: 48 })),
      { ppq: PPQ }
    );
    const clock = new VirtualClock(1000);
    const { player, deviceManager } = await import('./l05-replay-harness.test.js').then((m) =>
      m.buildPlayer({ buffer, clock })
    );
    player.channelRouting = new Map([[0, ROUTING[0]]]);
    const inst = installVirtualClock(clock);
    try {
      player.start('devA');
      clock.advanceBy(1200); // deux notes émises (0 ms, 500 ms, 1000 ms)
      player.pause();
      clock.advanceBy(5000); // longue pause
      player.resume();
      // La note à 1500 ms de fichier doit tomber 300 ms après la reprise, pas
      // 310 : la première passe post-resume est synchrone elle aussi.
      const resumeAt = clock.now;
      clock.advanceBy(2000);
      const next = onsOf(deviceManager.trace).find((e) => e.t > resumeAt);
      expect(next.t - resumeAt).toBeCloseTo(300, 6);
      player.stop();
    } finally {
      inst.restore();
    }
  });
});
