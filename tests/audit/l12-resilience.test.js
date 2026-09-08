// tests/audit/l12-resilience.test.js
//
// Lot L12 — §C02 (arrêt) et §AZ (injection de fautes), part hermétique.
//
// Les preuves « serveur vivant » (SIGINT/SIGTERM réels, base verrouillée,
// disque plein, port occupé) sont dans `docs/audit/2026-09-07/12_PERF_RESILIENCE.md`.
// Ce fichier fige les invariants que ces expériences ont mis en évidence, pour
// qu'une régression les casse ici avant de les casser sur scène.

import { describe, test, expect, jest } from '@jest/globals';
import Application from '../../src/core/Application.js';
import EventBus from '../../src/core/EventBus.js';
import { WsOutputQueue } from '../../src/api/WsOutputQueue.js';

const silentLogger = {
  info() {},
  warn() {},
  debug() {},
  error() {},
  isWarnEnabled: () => false,
  isInfoEnabled: () => false,
  isDebugEnabled: () => false
};

/**
 * `this` minimal pour Application.prototype.stop, chaque service remplacé par
 * une doublure qui journalise son passage dans `order`.
 */
function makeStopSelf(order, overrides = {}) {
  const mark = (label, extra) => () => {
    order.push(label);
    if (extra) extra();
  };
  return {
    logger: { ...silentLogger, error: (m) => order.push(`ERROR:${m}`) },
    version: '0.0.0-test',
    running: true,
    eventLoopMonitor: { stop: mark('eventLoopMonitor') },
    backupScheduler: { stop: mark('backupScheduler') },
    midiPlayer: { destroy: mark('midiPlayer.destroy(all-notes-off)') },
    midiClockGenerator: { destroy: mark('midiClockGenerator') },
    midiRouter: { destroy: mark('midiRouter') },
    wsServer: { close: mark('wsServer') },
    httpServer: { close: mark('httpServer') },
    deviceManager: { close: mark('deviceManager.close(ports)') },
    bluetoothManager: { cleanup: mark('bluetoothManager') },
    networkManager: { shutdown: mark('networkManager') },
    serialMidiManager: { shutdown: mark('serialMidiManager') },
    lightingManager: { shutdown: mark('lightingManager') },
    instrumentLightManager: { shutdown: mark('instrumentLightManager') },
    autoAssigner: { destroy: mark('autoAssigner') },
    compensationService: { destroy: mark('compensationService') },
    capabilityResolver: { destroy: mark('capabilityResolver') },
    removeEventHandlers: mark('eventHandlers'),
    database: { close: mark('database') },
    ...overrides
  };
}

describe('L12 §C02 — séquence d’arrêt', () => {
  test('les notes sont coupées AVANT la fermeture des ports MIDI', async () => {
    // MidiPlayer.destroy() → stop() → sendAllNotesOff(). Fermer les ports
    // d’abord laisserait les notes tenues sur l’instrument physique : un
    // port MIDI fermé ne silencie pas le synthé qui a reçu les note-on.
    const order = [];
    await Application.prototype.stop.call(makeStopSelf(order));
    const notesOff = order.indexOf('midiPlayer.destroy(all-notes-off)');
    const ports = order.indexOf('deviceManager.close(ports)');
    expect(notesOff).toBeGreaterThanOrEqual(0);
    expect(ports).toBeGreaterThanOrEqual(0);
    expect(notesOff).toBeLessThan(ports);
  });

  test('la base est fermée en dernier (checkpoint WAL après tous les écrivains)', async () => {
    const order = [];
    await Application.prototype.stop.call(makeStopSelf(order));
    expect(order[order.length - 1]).toBe('database');
  });

  test('une étape qui lève n’annule aucune des suivantes', async () => {
    // Reproduit le défaut observé en production sur `lightingManager`
    // (F-129) : la panne d’une étape ne doit pas escamoter la fermeture
    // des ports ni le checkpoint de la base.
    const order = [];
    const self = makeStopSelf(order, {
      lightingManager: {
        shutdown() {
          throw new Error('this.eventBus.removeListener is not a function');
        }
      }
    });
    await expect(Application.prototype.stop.call(self)).resolves.toBeUndefined();
    expect(order).toContain('deviceManager.close(ports)');
    expect(order).toContain('database');
    expect(order.some((l) => l.startsWith('ERROR:'))).toBe(true);
  });

  test('stop() ne relance jamais — un arrêt reste un arrêt', async () => {
    const order = [];
    const self = makeStopSelf(order, {
      database: {
        close() {
          throw new Error('disk I/O error');
        }
      }
    });
    await expect(Application.prototype.stop.call(self)).resolves.toBeUndefined();
    expect(self.running).toBe(false);
  });

  test('setupShutdownHandlers() n’accumule pas de handlers process', () => {
    const before = {
      SIGTERM: process.listenerCount('SIGTERM'),
      SIGINT: process.listenerCount('SIGINT'),
      uncaughtException: process.listenerCount('uncaughtException')
    };
    const self = { logger: silentLogger, stop: async () => {}, _shutdownHandlers: null };
    Application.prototype.setupShutdownHandlers.call(self);
    const after1 = process.listenerCount('SIGTERM');
    Application.prototype.setupShutdownHandlers.call(self);
    Application.prototype.setupShutdownHandlers.call(self);
    const after3 = process.listenerCount('SIGTERM');
    expect(after1).toBe(before.SIGTERM + 1);
    expect(after3).toBe(after1); // idempotent : 3 appels, 1 seul handler

    // Nettoyage : ne pas laisser de handler derrière soi pour les autres suites.
    for (const { event, handler } of self._shutdownHandlers) {
      process.removeListener(event, handler);
    }
    expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM);
    expect(process.listenerCount('SIGINT')).toBe(before.SIGINT);
    expect(process.listenerCount('uncaughtException')).toBe(before.uncaughtException);
  });
});

describe('L12 §C02 — F-129 : l’arrêt du lighting doit atteindre allOff()', () => {
  // Historique. Le 2026-09-07 à 11:07, sur serveur vivant, CHAQUE arrêt
  // journalisait :
  //   ERROR Stop step "lightingManager" failed (continuing):
  //         this.eventBus.removeListener is not a function
  // `_removeEventListeners()` est la PREMIÈRE instruction de `shutdown()` :
  // la TypeError sautait tout le reste, dont `allOff()` — les lumières
  // restaient allumées après la fin du spectacle. Le lot L02 a corrigé le
  // point (leur F-30, `off()` au lieu de `removeListener()`) pendant que ce
  // lot tournait. Les deux tests ci-dessous verrouillent la correction.

  test('EventBus expose off(), pas removeListener() — l’origine du défaut', () => {
    const bus = new EventBus();
    expect(typeof bus.off).toBe('function');
    expect(typeof bus.removeListener).toBe('undefined');
  });

  test('shutdown() détache les écouteurs ET coupe les lumières', async () => {
    const { default: LightingManager } = await import('../../src/lighting/LightingManager.js');
    const bus = new EventBus();
    const self = Object.create(LightingManager.prototype);
    self.eventBus = bus;
    self._onMidiRouted = () => {};
    self._onMidiMessage = () => {};
    bus.on('midi_routed', self._onMidiRouted);
    bus.on('midi_message', self._onMidiMessage);
    self._healthCheckInterval = null;
    self._ledBatchTimers = new Map();
    self._ledBatchBuffer = new Map();
    self.activeFades = new Map();
    self.activeNotes = new Map();
    self.drivers = new Map();
    let allOffCalled = false;
    self.effectsEngine = { shutdown() {} };
    self.allOff = () => {
      allOffCalled = true;
    };

    await expect(self.shutdown()).resolves.toBeUndefined();

    expect(allOffCalled).toBe(true); // état sûr atteint
    expect(bus.listenerCount?.('midi_message') ?? 0).toBe(0);
  });
});

describe('L12 §AZ — backpressure : un client qui ne lit plus', () => {
  /** Client WS dont le tampon de sortie ne se vide jamais. */
  function stalledClient(bufferedAmount) {
    return {
      readyState: 1,
      bufferedAmount,
      sent: 0,
      send() {
        this.sent++;
      }
    };
  }

  test('la file reste bornée et compte les rejets face à un client bloqué', () => {
    const stalled = stalledClient(64 * 1024 * 1024); // 64 MB en attente
    const clients = new Set([stalled]);
    let pending = null;
    const q = new WsOutputQueue({
      clients,
      logger: silentLogger,
      scheduleFlush: (cb) => {
        pending = cb;
      }
    });

    let maxDepth = 0;
    for (let r = 0; r < 500; r++) {
      for (let i = 0; i < 20; i++) q.broadcast('playback_position', { position: r * 20 + i });
      for (let i = 0; i < 20; i++) q.broadcast('l12_discrete', { seq: r * 20 + i });
      maxDepth = Math.max(maxDepth, q._queue.length);
      if (pending) {
        const f = pending;
        pending = null;
        f();
      }
    }

    expect(maxDepth).toBeLessThanOrEqual(q._maxDepth);
    expect(stalled.sent).toBe(0); // rien n’a été poussé dans un client saturé
    expect(q._stats.droppedByClient).toBeGreaterThan(0);
    expect(q._stats.criticalEvents).toBeGreaterThan(0);
    q.close();
  });

  test('un client sain continue d’être servi malgré un voisin bloqué', () => {
    const stalled = stalledClient(64 * 1024 * 1024);
    const healthy = stalledClient(0);
    const clients = new Set([stalled, healthy]);
    let pending = null;
    const q = new WsOutputQueue({
      clients,
      logger: silentLogger,
      scheduleFlush: (cb) => {
        pending = cb;
      }
    });
    for (let i = 0; i < 100; i++) q.broadcast('l12_discrete', { seq: i });
    if (pending) pending();
    expect(healthy.sent).toBeGreaterThan(0);
    expect(stalled.sent).toBe(0);
    q.close();
  });

  test('un client qui lève à l’envoi est retiré de l’ensemble, pas retenté', () => {
    const bad = {
      readyState: 1,
      bufferedAmount: 0,
      send() {
        throw new Error('socket corrupted');
      }
    };
    const clients = new Set([bad]);
    let pending = null;
    const q = new WsOutputQueue({
      clients,
      logger: silentLogger,
      scheduleFlush: (cb) => {
        pending = cb;
      }
    });
    q.broadcast('l12_discrete', { seq: 1 });
    if (pending) pending();
    expect(clients.has(bad)).toBe(false);
    q.close();
  });

  test('après close(), plus rien n’est mis en file (pas de croissance post-arrêt)', () => {
    const clients = new Set();
    const q = new WsOutputQueue({ clients, logger: silentLogger, scheduleFlush: () => {} });
    q.close();
    for (let i = 0; i < 1000; i++) q.broadcast('l12_discrete', { seq: i });
    expect(q._queue.length).toBe(0);
  });
});

describe('L12 §AZ — EventLoopMonitor : la sonde qui a vu le gel de 10 s', () => {
  test('mesure la latence et n’émet le rapport qu’une fois par fenêtre', async () => {
    const { EventLoopMonitor } =
      await import('../../src/infrastructure/monitoring/EventLoopMonitor.js');
    const warns = [];
    const broadcasts = [];
    const mon = new EventLoopMonitor({
      logger: { ...silentLogger, warn: (m) => warns.push(m) },
      wsServer: { broadcast: (e, d) => broadcasts.push([e, d]) },
      threshold: 5
    });
    mon.start();
    // Bloque le loop deux fois de suite : la mesure doit voir les deux,
    // le rapport ne doit sortir qu’une fois (throttle 5 s).
    for (let round = 0; round < 2; round++) {
      const until = Date.now() + 60;
      while (Date.now() < until) {
        /* busy-wait volontaire */
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    mon.stop();
    expect(warns.length).toBeLessThanOrEqual(1);
    expect(broadcasts.length).toBeLessThanOrEqual(1);
    if (warns.length) expect(warns[0]).toMatch(/Event loop lag/);
    expect(mon.currentLag).toBe(0); // stop() remet le compteur à zéro
  });

  test('stop() est idempotent et libère le timer', async () => {
    const { EventLoopMonitor } =
      await import('../../src/infrastructure/monitoring/EventLoopMonitor.js');
    const mon = new EventLoopMonitor({ logger: silentLogger });
    mon.start();
    mon.start(); // no-op
    expect(mon._interval).not.toBeNull();
    mon.stop();
    mon.stop();
    expect(mon._interval).toBeNull();
  });
});

// Garde-fou : ce fichier ne doit rien laisser tourner.
afterAll(() => {
  jest.useRealTimers?.();
});
