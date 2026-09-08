/**
 * @file tests/audit/l05-replay-harness.test.js
 * @description **Harnais de rejeu déterministe** — lot d'audit L05
 * (« Playback, timing & déterminisme », `docs/audit/2026-09-07/05_PLAYBACK.md`).
 *
 * Ce module est à la fois :
 *   1. une **bibliothèque réutilisable** (tout est exporté) ;
 *   2. une suite Jest qui **teste le harnais lui-même** (les auto-tests ne sont
 *      enregistrés que lorsque Jest exécute CE fichier — voir `IS_SELF_RUN` —
 *      pour qu'un import depuis `l05-*.test.js` ne les duplique pas).
 *
 * ## Pourquoi
 * `MidiPlayer` + `PlaybackScheduler` sont pilotés par `performance.now()`,
 * `setInterval` (tick 10 ms) et une cascade de `setTimeout` par événement. Un
 * test qui utilise le vrai temps mesure la gigue de la machine, pas le moteur.
 * Le harnais remplace les **quatre** sources de temps par une horloge virtuelle
 * déterministe et enregistre chaque octet MIDI réellement émis.
 *
 * ## Ce qui est virtualisé
 * | Source | Remplacement |
 * |---|---|
 * | `performance.now()` (perf_hooks == globalThis.performance) | `clock.now` |
 * | `Date.now()` | `epoch0 + clock.now` |
 * | `setTimeout` / `clearTimeout` | file de timers virtuels |
 * | `setInterval` / `clearInterval` | idem, ré-armés |
 *
 * Les timers dus au même instant virtuel sont déclenchés dans l'ordre
 * d'**insertion** (numéro de séquence monotone) : deux exécutions identiques
 * produisent donc exactement le même entrelacement.
 *
 * ## Utilisation
 * ```js
 * import { replay, serializeTrace } from './l05-replay-harness.test.js';
 * const a = replay({ midi: spec, routing, capabilities });
 * const b = replay({ midi: spec, routing, capabilities });
 * expect(serializeTrace(a.trace)).toBe(serializeTrace(b.trace));
 * ```
 *
 * ## Format de trace
 * Chaque envoi est normalisé en octets MIDI bruts :
 * `{ t, device, status, data1, data2, bytes? }` où `t` est l'instant
 * **virtuel** (ms) et `status` inclut déjà le canal de sortie. C'est ce qui
 * permet la comparaison « octet à octet » demandée par le plan d'audit.
 *
 * ## Limite connue (documentée, pas masquée)
 * Le harnais n'installe l'horloge virtuelle qu'autour d'une section
 * **synchrone**. `loadFile()` est `async` : on l'attend AVANT d'installer
 * l'horloge. Aucun `await` ne doit avoir lieu horloge installée, sinon la
 * micro-tâche ne serait jamais reprise (les timers réels sont neutralisés).
 */

import { describe, test, expect } from '@jest/globals';
import { fileURLToPath } from 'url';
import { performance } from 'perf_hooks';
import { writeMidi } from 'midi-file';
import MidiPlayer from '../../src/midi/playback/MidiPlayer.js';

const SELF_PATH = fileURLToPath(import.meta.url);
const IS_SELF_RUN = (() => {
  try {
    return expect.getState().testPath === SELF_PATH;
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------------------
// 1. Horloge + ordonnanceur virtuels
// ---------------------------------------------------------------------------

/**
 * Ordonnanceur de timers purement logique. Aucun temps réel n'est consommé.
 */
export class VirtualClock {
  /**
   * @param {number} [start] instant virtuel initial (ms)
   * @param {?Function} [lateness] `(timer) => ms` — retard appliqué au
   *   déclenchement de chaque timer. Permet de modéliser la gigue réelle
   *   (libuv/ordonnanceur) tout en restant reproductible. `null` = temps idéal.
   */
  constructor(start = 1000, lateness = null) {
    /** Instant virtuel courant, en millisecondes. */
    this.now = start;
    this._lateness = lateness;
    this._seq = 0;
    /** @type {Map<number, {id:number, at:number, seq:number, fn:Function, args:any[], every:?number}>} */
    this._timers = new Map();
    /** Nombre total de callbacks exécutés (garde-fou anti-boucle). */
    this.fired = 0;
  }

  _handle(id) {
    // Imite l'objet Timeout de Node : le scheduler appelle `.unref()`.
    return {
      id,
      unref() {
        return this;
      },
      ref() {
        return this;
      },
      hasRef() {
        return false;
      },
      refresh() {
        return this;
      },
      [Symbol.toPrimitive]() {
        return id;
      }
    };
  }

  /** Retard (ms) appliqué au déclenchement — 0 en temps idéal. */
  _late(timer) {
    return this._lateness ? Math.max(0, this._lateness(timer)) : 0;
  }

  setTimeout(fn, ms = 0, ...args) {
    const id = ++this._seq;
    const nominal = this.now + Math.max(0, Number(ms) || 0);
    const t = { id, seq: id, fires: 0, nominal, at: nominal, fn, args, every: null };
    t.at = nominal + this._late(t);
    this._timers.set(id, t);
    return this._handle(id);
  }

  setInterval(fn, ms = 0, ...args) {
    const id = ++this._seq;
    const period = Math.max(1, Number(ms) || 1);
    const nominal = this.now + period;
    const t = { id, seq: id, fires: 0, nominal, at: nominal, fn, args, every: period };
    t.at = nominal + this._late(t);
    this._timers.set(id, t);
    return this._handle(id);
  }

  clear(handle) {
    if (handle == null) return;
    const id = typeof handle === 'object' ? handle.id : Number(handle);
    this._timers.delete(id);
  }

  /** Timers encore armés (diagnostic de fuite). */
  get pending() {
    return this._timers.size;
  }

  /**
   * Avance jusqu'à `target` (ms absolus) en déclenchant chaque timer dû, dans
   * l'ordre (instant, séquence d'insertion). Ordre total ⇒ reproductible.
   * @param {number} target
   * @param {number} [maxFire] garde-fou anti-boucle infinie
   */
  advanceTo(target, maxFire = 200000) {
    let guard = 0;
    for (;;) {
      let next = null;
      for (const t of this._timers.values()) {
        if (t.at > target) continue;
        if (next === null || t.at < next.at || (t.at === next.at && t.seq < next.seq)) next = t;
      }
      if (!next) break;
      if (++guard > maxFire) throw new Error(`VirtualClock: >${maxFire} timers fired — runaway`);
      this.now = Math.max(this.now, next.at);
      next.fires++;
      if (next.every === null) {
        this._timers.delete(next.id);
      } else {
        // Ré-armement sur la grille NOMINALE (pas de dérive cumulative), le
        // retard étant ré-appliqué à chaque déclenchement.
        next.nominal += next.every;
        next.at = next.nominal + this._late(next);
      }
      this.fired++;
      next.fn(...next.args);
    }
    if (target > this.now) this.now = target;
  }

  /** Avance de `ms` à partir de l'instant courant. */
  advanceBy(ms, maxFire) {
    this.advanceTo(this.now + ms, maxFire);
  }

  /**
   * Variante **asynchrone** : identique à {@link VirtualClock#advanceTo} mais
   * vide la file de micro-tâches entre deux déclenchements de timer, comme le
   * fait la boucle d'événements réelle. Indispensable dès qu'un callback
   * `async` participe au flot (`MidiPlayer._handleFileEnd`, avance de file
   * d'attente…) : sans cela, un `finally` de fonction `async` ne s'exécute
   * jamais pendant l'avance et l'état reste figé (garde `_fileEndPending`).
   * @param {number} target
   * @param {number} [maxFire]
   */
  async advanceToAsync(target, maxFire = 200000) {
    let guard = 0;
    for (;;) {
      let next = null;
      for (const t of this._timers.values()) {
        if (t.at > target) continue;
        if (next === null || t.at < next.at || (t.at === next.at && t.seq < next.seq)) next = t;
      }
      if (!next) break;
      if (++guard > maxFire) throw new Error(`VirtualClock: >${maxFire} timers fired — runaway`);
      this.now = Math.max(this.now, next.at);
      next.fires++;
      if (next.every === null) {
        this._timers.delete(next.id);
      } else {
        next.nominal += next.every;
        next.at = next.nominal + this._late(next);
      }
      this.fired++;
      next.fn(...next.args);
      // Laisse tourner la file de micro-tâches (Promises) entre deux timers.
      await Promise.resolve();
      await Promise.resolve();
    }
    if (target > this.now) this.now = target;
  }

  /** Variante asynchrone de {@link VirtualClock#advanceBy}. */
  async advanceByAsync(ms, maxFire) {
    await this.advanceToAsync(this.now + ms, maxFire);
  }
}

/**
 * Installe l'horloge virtuelle sur les globales + `performance.now`.
 * @param {VirtualClock} [clock]
 * @returns {{clock:VirtualClock, restore:Function}}
 */
export function installVirtualClock(clock = new VirtualClock()) {
  const saved = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    now: performance.now,
    dateNow: Date.now
  };
  const epoch = 1_700_000_000_000;
  globalThis.setTimeout = (fn, ms, ...a) => clock.setTimeout(fn, ms, ...a);
  globalThis.clearTimeout = (h) => clock.clear(h);
  globalThis.setInterval = (fn, ms, ...a) => clock.setInterval(fn, ms, ...a);
  globalThis.clearInterval = (h) => clock.clear(h);
  performance.now = () => clock.now;
  Date.now = () => epoch + Math.floor(clock.now);
  return {
    clock,
    restore() {
      globalThis.setTimeout = saved.setTimeout;
      globalThis.clearTimeout = saved.clearTimeout;
      globalThis.setInterval = saved.setInterval;
      globalThis.clearInterval = saved.clearInterval;
      performance.now = saved.now;
      Date.now = saved.dateNow;
    }
  };
}

// ---------------------------------------------------------------------------
// 2. Enregistreur de trace (octets MIDI réels)
// ---------------------------------------------------------------------------

/** Convertit un envoi DeviceManager en octets MIDI bruts. */
export function toRawBytes(type, data = {}) {
  const ch = (data.channel ?? 0) & 0x0f;
  switch (type) {
    case 'noteon':
      return { status: 0x90 | ch, data1: data.note ?? 0, data2: data.velocity ?? 0 };
    case 'noteoff':
      return { status: 0x80 | ch, data1: data.note ?? 0, data2: data.velocity ?? 0 };
    case 'cc':
      return { status: 0xb0 | ch, data1: data.controller ?? 0, data2: data.value ?? 0 };
    case 'program':
      return { status: 0xc0 | ch, data1: data.program ?? 0, data2: 0 };
    case 'pitchbend': {
      const centered = data.centeredValue ?? (data.value ?? 0) - 8192;
      const raw = Math.max(0, Math.min(16383, centered + 8192));
      return { status: 0xe0 | ch, data1: raw & 0x7f, data2: (raw >> 7) & 0x7f };
    }
    case 'channel aftertouch':
      return { status: 0xd0 | ch, data1: data.pressure ?? 0, data2: 0 };
    case 'poly aftertouch':
      return { status: 0xa0 | ch, data1: data.note ?? 0, data2: data.pressure ?? 0 };
    case 'sysex':
      return { status: 0xf0, data1: 0, data2: 0, bytes: [...(data.bytes || [])] };
    default:
      return { status: -1, data1: 0, data2: 0, raw: type };
  }
}

/**
 * DeviceManager double qui enregistre chaque envoi horodaté sur l'horloge
 * virtuelle. `failDevices` permet de simuler un périphérique injoignable.
 */
export function createTraceRecorder(clock, { failDevices = new Set(), status = 'sent' } = {}) {
  const trace = [];
  const dm = {
    trace,
    sendMessageEx(deviceId, type, data) {
      if (failDevices.has(deviceId)) return { status: 'disconnected' };
      trace.push({
        t: Number(clock.now.toFixed(6)),
        device: deviceId,
        type,
        ...toRawBytes(type, data)
      });
      return { status };
    },
    sendMessage(deviceId, type, data) {
      return dm.sendMessageEx(deviceId, type, data).status === 'sent';
    },
    getDeviceList: () => []
  };
  return dm;
}

/** Sérialisation canonique d'une trace — la chaîne comparée « octet à octet ». */
export function serializeTrace(trace, { withTime = true } = {}) {
  return trace
    .map((e) => {
      const head = withTime ? `${e.t.toFixed(3)} ` : '';
      const body =
        e.bytes !== undefined
          ? `SYSEX ${e.bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`
          : `${e.status.toString(16).padStart(2, '0')} ${e.data1} ${e.data2}`;
      return `${head}${e.device} ${body}`;
    })
    .join('\n');
}

/** Trace réduite aux octets MIDI (sans horodatage) — comparaison « audible ». */
export function serializeBytes(trace) {
  return serializeTrace(trace, { withTime: false });
}

// ---------------------------------------------------------------------------
// 3. Doubles minimalistes des dépendances
// ---------------------------------------------------------------------------

export function silentLogger() {
  return {
    info() {},
    warn() {},
    debug() {},
    error() {},
    isDebugEnabled: () => false,
    isWarnEnabled: () => false,
    isInfoEnabled: () => false
  };
}

export const NULL_CONSTRAINTS = Object.freeze({
  minNoteInterval: null,
  minNoteDuration: null,
  polyphony: null,
  noteRangeMin: null,
  noteRangeMax: null,
  selectedNotes: null,
  octaveMode: null,
  scaleRoot: 0,
  supportedCcs: null,
  handCcs: null
});

/**
 * CapabilityResolver double. `capabilities` est une map `"device:channel"` ou
 * `"device"` → contraintes partielles.
 */
export function createCapabilityResolver(capabilities = {}, { stringCC = false } = {}) {
  return {
    getTimingConstraints(deviceId, channel) {
      const c = capabilities[`${deviceId}:${channel}`] ?? capabilities[deviceId] ?? {};
      return { ...NULL_CONSTRAINTS, ...c };
    },
    isStringCCAllowed: () => stringCC
  };
}

/** CompensationService double : map `"device:channel"` ou `"device"` → ms. */
export function createCompensationService(delays = {}) {
  return {
    getDelay(deviceId, channel) {
      return delays[`${deviceId}:${channel}`] ?? delays[deviceId] ?? 0;
    },
    invalidate() {}
  };
}

// ---------------------------------------------------------------------------
// 4. Construction de fichiers MIDI compacts
// ---------------------------------------------------------------------------

/**
 * Construit un buffer SMF depuis une spécification compacte.
 * @param {{ppq?:number, format?:number, tracks:Array<Array<Object>>}} spec
 *   Chaque événement de piste est au format `midi-file` (`deltaTime` requis).
 * @returns {Buffer}
 */
export function buildMidi(spec) {
  const header = {
    format: spec.format ?? 1,
    numTracks: spec.tracks.length,
    ticksPerBeat: spec.ppq ?? 480
  };
  const tracks = spec.tracks.map((evs) => [
    ...evs,
    { deltaTime: 0, meta: true, type: 'endOfTrack' }
  ]);
  return Buffer.from(writeMidi({ header, tracks }));
}

/**
 * Raccourci : une piste, notes `{tick, note, dur, ch?, vel?}`, plus des
 * événements bruts optionnels.
 */
export function buildNoteTrack(notes, { ppq = 480, extra = [] } = {}) {
  const abs = [];
  for (const n of notes) {
    abs.push({
      tick: n.tick,
      ev: {
        type: 'noteOn',
        channel: n.ch ?? 0,
        noteNumber: n.note,
        velocity: n.vel ?? 100
      }
    });
    abs.push({
      tick: n.tick + (n.dur ?? ppq),
      ev: { type: 'noteOff', channel: n.ch ?? 0, noteNumber: n.note, velocity: 0 }
    });
  }
  for (const e of extra) abs.push({ tick: e.tick, ev: e.ev });
  // Tri stable : (tick, index d'insertion) — pas d'ambiguïté d'ordre.
  abs.forEach((a, i) => (a._i = i));
  abs.sort((a, b) => a.tick - b.tick || a._i - b._i);
  let last = 0;
  const track = abs.map((a) => {
    const deltaTime = a.tick - last;
    last = a.tick;
    return { ...a.ev, deltaTime };
  });
  return buildMidi({ ppq, tracks: [track] });
}

// ---------------------------------------------------------------------------
// 5. Le rejeu lui-même
// ---------------------------------------------------------------------------

/**
 * Construit un `MidiPlayer` câblé sur des doubles et charge `buffer`.
 * `loadFile` est asynchrone : appelée AVANT l'installation de l'horloge.
 * @returns {Promise<{player:MidiPlayer, deviceManager:Object, clock:VirtualClock}>}
 */
export async function buildPlayer({
  buffer,
  clock,
  capabilities = {},
  delays = {},
  stringCC = false,
  failDevices = new Set(),
  database = null,
  config = null
} = {}) {
  const logger = silentLogger();
  const deviceManager = createTraceRecorder(clock, { failDevices });
  const deps = {
    logger,
    database: database ?? {
      getFile: (id) => ({ id, filename: `f${id}.mid`, blob_path: 'x' }),
      getRoutingsByFile: () => [],
      getTablaturesByFile: () => [],
      getInstrumentCapabilities: () => null,
      getInstrumentSettings: () => null
    },
    blobStore: { read: () => buffer },
    deviceManager,
    eventBus: { on() {}, off() {}, emit() {} },
    capabilityResolver: createCapabilityResolver(capabilities, { stringCC }),
    compensationService: createCompensationService(delays),
    config: config ?? { get: (_k, d) => d }
  };
  const player = new MidiPlayer(deps);
  // Le scheduler capture deviceManager dans son constructeur.
  player.scheduler.deviceManager = deviceManager;
  await player.loadFile(1);
  return { player, deviceManager, deps };
}

/**
 * Rejoue intégralement un fichier avec une horloge virtuelle et renvoie la
 * trace des octets émis.
 *
 * @param {Object} opts
 * @param {Buffer} opts.buffer                 fichier SMF
 * @param {Object<number, Object>} opts.routing canal source → routing
 * @param {Object} [opts.capabilities]          "device[:ch]" → contraintes
 * @param {Object} [opts.delays]                "device[:ch]" → compensation ms
 * @param {number} [opts.stepMs]                pas d'avance (défaut 1 ms)
 * @param {number} [opts.tailMs]                marge après la fin (défaut 500)
 * @param {Function} [opts.mutate]              (player)=>void avant start()
 * @param {Function} [opts.onStep]              (t, player)=>void à chaque pas
 * @returns {Promise<{trace:Array, player:MidiPlayer, clock:VirtualClock}>}
 */
export async function replay(opts) {
  const clock = new VirtualClock(opts.startNow ?? 1000, opts.lateness ?? null);
  const { player, deviceManager } = await buildPlayer({ ...opts, clock });
  if (opts.routing) {
    player.channelRouting = new Map(Object.entries(opts.routing).map(([ch, r]) => [Number(ch), r]));
  }
  if (opts.mutate) opts.mutate(player);

  const installed = installVirtualClock(clock);
  try {
    player.start(opts.outputDevice ?? 'dev1');
    const step = opts.stepMs ?? 1;
    const end = clock.now + (player.duration + (opts.tailMs ?? 500) / 1000) * 1000;
    while (clock.now < end && (player.playing || player._advancing)) {
      await clock.advanceByAsync(step);
      if (opts.onStep) opts.onStep(clock.now, player, clock);
    }
    // Drain des note-off différés encore armés.
    if (player.playing) await clock.advanceByAsync(opts.tailMs ?? 500);
  } finally {
    installed.restore();
  }
  return { trace: deviceManager.trace, player, clock, deviceManager };
}

/**
 * Compte les notes orphelines d'une trace : note-on (vélocité > 0) jamais
 * suivis du note-off correspondant (device, canal, hauteur), et note-off
 * excédentaires. C'est LA mesure « instrument bloqué en scène ».
 * @param {Array} trace
 * @returns {{orphanOn:Array, orphanOff:Array, maxConcurrent:number}}
 */
export function analyseNotePairing(trace) {
  const active = new Map(); // "dev:ch:note" -> count
  const orphanOff = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  for (const e of trace) {
    if (e.status < 0 || e.bytes) continue;
    const kind = e.status & 0xf0;
    const ch = e.status & 0x0f;
    const key = `${e.device}:${ch}:${e.data1}`;
    const isOn = kind === 0x90 && e.data2 > 0;
    const isOff = kind === 0x80 || (kind === 0x90 && e.data2 === 0);
    if (isOn) {
      active.set(key, (active.get(key) || 0) + 1);
      concurrent++;
      if (concurrent > maxConcurrent) maxConcurrent = concurrent;
    } else if (isOff) {
      const c = active.get(key) || 0;
      if (c === 0) orphanOff.push(e);
      else {
        if (c === 1) active.delete(key);
        else active.set(key, c - 1);
        concurrent--;
      }
    }
  }
  const orphanOn = [];
  for (const [key, count] of active) orphanOn.push({ key, count });
  return { orphanOn, orphanOff, maxConcurrent };
}

// ---------------------------------------------------------------------------
// 6. Auto-tests du harnais (uniquement quand Jest exécute CE fichier)
// ---------------------------------------------------------------------------

if (IS_SELF_RUN) {
  describe('L05 · harnais de rejeu — horloge virtuelle', () => {
    test('les timers dus au même instant tirent dans l’ordre d’insertion', () => {
      const c = new VirtualClock(0);
      const out = [];
      c.setTimeout(() => out.push('a'), 10);
      c.setTimeout(() => out.push('b'), 10);
      c.setTimeout(() => out.push('c'), 5);
      c.advanceTo(20);
      expect(out).toEqual(['c', 'a', 'b']);
      expect(c.now).toBe(20);
    });

    test('setInterval se ré-arme et clearInterval l’arrête', () => {
      const c = new VirtualClock(0);
      let n = 0;
      const h = c.setInterval(() => n++, 10);
      c.advanceTo(55);
      expect(n).toBe(5);
      c.clear(h);
      c.advanceTo(200);
      expect(n).toBe(5);
      expect(c.pending).toBe(0);
    });

    test('installVirtualClock détourne performance.now et les timers globaux', () => {
      const c = new VirtualClock(500);
      const inst = installVirtualClock(c);
      try {
        expect(performance.now()).toBe(500);
        let fired = false;
        setTimeout(() => (fired = true), 25);
        c.advanceBy(30);
        expect(fired).toBe(true);
        expect(performance.now()).toBe(530);
      } finally {
        inst.restore();
      }
      expect(performance.now()).not.toBe(530);
    });

    test('restore() est complet (aucune globale laissée détournée)', () => {
      const before = [globalThis.setTimeout, globalThis.setInterval, performance.now, Date.now];
      installVirtualClock(new VirtualClock()).restore();
      expect([globalThis.setTimeout, globalThis.setInterval, performance.now, Date.now]).toEqual(
        before
      );
    });
  });

  describe('L05 · harnais de rejeu — trace', () => {
    test('toRawBytes encode les 7 messages de canal', () => {
      expect(toRawBytes('noteon', { channel: 2, note: 60, velocity: 90 })).toEqual({
        status: 0x92,
        data1: 60,
        data2: 90
      });
      expect(toRawBytes('noteoff', { channel: 0, note: 60, velocity: 0 })).toEqual({
        status: 0x80,
        data1: 60,
        data2: 0
      });
      expect(toRawBytes('cc', { channel: 1, controller: 7, value: 100 })).toEqual({
        status: 0xb1,
        data1: 7,
        data2: 100
      });
      expect(toRawBytes('program', { channel: 15, program: 42 })).toEqual({
        status: 0xcf,
        data1: 42,
        data2: 0
      });
      // pitchbend centré 0 => 8192 => LSB 0, MSB 64
      expect(toRawBytes('pitchbend', { channel: 0, centeredValue: 0 })).toEqual({
        status: 0xe0,
        data1: 0,
        data2: 64
      });
      expect(toRawBytes('channel aftertouch', { channel: 3, pressure: 55 })).toEqual({
        status: 0xd3,
        data1: 55,
        data2: 0
      });
      expect(toRawBytes('poly aftertouch', { channel: 4, note: 61, pressure: 12 })).toEqual({
        status: 0xa4,
        data1: 61,
        data2: 12
      });
    });

    test('analyseNotePairing détecte une note orpheline', () => {
      const trace = [
        { device: 'd', status: 0x90, data1: 60, data2: 100 },
        { device: 'd', status: 0x90, data1: 64, data2: 100 },
        { device: 'd', status: 0x80, data1: 60, data2: 0 }
      ];
      const r = analyseNotePairing(trace);
      expect(r.orphanOn).toEqual([{ key: 'd:0:64', count: 1 }]);
      expect(r.orphanOff).toEqual([]);
      expect(r.maxConcurrent).toBe(2);
    });
  });

  describe('L05 · harnais de rejeu — bout en bout', () => {
    test('rejoue un fichier et produit une trace non vide et appariée', async () => {
      const buffer = buildNoteTrack([
        { tick: 0, note: 60, dur: 240 },
        { tick: 480, note: 64, dur: 240 },
        { tick: 960, note: 67, dur: 240 }
      ]);
      const { trace, player } = await replay({
        buffer,
        routing: { 0: { device: 'dev1', targetChannel: 0 } }
      });
      expect(player.events.length).toBe(6);
      // 6 messages de note + le CC 123 émis par stop() en fin de fichier.
      expect(trace).toHaveLength(7);
      expect(trace[0]).toMatchObject({ device: 'dev1', status: 0x90, data1: 60 });
      expect(trace[5]).toMatchObject({ status: 0x80, data1: 67 }); // dernier note-off (F-54 corrigé)
      expect(trace[6]).toMatchObject({ status: 0xb0, data1: 123 });
      expect(analyseNotePairing(trace).orphanOn).toEqual([]);
    });
  });
}
