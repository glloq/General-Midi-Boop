// tests/transports/l04-device-discovery.test.js
//
// Lot L04 — §K (USB) / §G04 (hot-plug) : DeviceDiscovery piloté par un
// ÉNUMÉRATEUR BOUCHON. Aucun matériel, aucune bibliothèque native : la classe
// ne touche `easymidi` que par `getInputs()` / `getOutputs()`, et l'ouverture
// des ports passe par les callbacks `addInput` / `addOutput` — donc tout est
// injectable.
//
// Ce que ce fichier prouve :
//   - apparition / disparition / doublons / noms Unicode, espaces, très longs
//   - port fantôme : présent à l'énumération, refuse l'ouverture
//   - fuite d'état interne après 50 cycles connexion/déconnexion
//   - compteur d'échecs consécutifs et arrêt de la surveillance
//   - aucune fuite de timer entre start/stop de la surveillance
//
// NB : `_detectCurrentPorts()` privilégie `/proc/asound/cards` (Linux ALSA) et
// retombe sur `easymidi`. L'environnement d'audit n'a pas `/proc/asound`
// (vérifié : `fs.existsSync('/proc/asound/cards') === false`), donc la branche
// exercée ici est la branche `easymidi` — la seule qui gère add/remove sans
// rescan complet. La branche `proc` est notée HW REQUIRED dans le rapport.

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'fs';
import DeviceDiscovery from '../../src/midi/devices/DeviceDiscovery.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** Énumérateur bouchon : la façade matérielle réduite à deux tableaux. */
function makeEnumerator(inputs = [], outputs = []) {
  return {
    inputs: [...inputs],
    outputs: [...outputs],
    getInputs() {
      return [...this.inputs];
    },
    getOutputs() {
      return [...this.outputs];
    }
  };
}

/** Faux port ouvert : compte les close() et les removeAllListeners(). */
function fakePort(name, opts = {}) {
  return {
    name,
    closed: 0,
    listenersRemoved: 0,
    removeAllListeners() {
      this.listenersRemoved++;
    },
    close() {
      this.closed++;
      if (opts.throwOnClose) throw new Error(`close failed: ${name}`);
    }
  };
}

function makeDiscovery(enumerator, { logger = silentLogger } = {}) {
  return new DeviceDiscovery({ logger }, enumerator, true);
}

describe('L04/§K — préconditions d’environnement', () => {
  test('/proc/asound/cards absent → la détection utilise la branche easymidi', () => {
    expect(fs.existsSync('/proc/asound/cards')).toBe(false);
    const d = makeDiscovery(makeEnumerator(['A'], ['A']));
    const ports = d._detectCurrentPorts();
    expect(ports.method).toBe('easymidi');
  });
});

describe('L04/§K — scanAndReopen : énumération, filtres, erreurs', () => {
  test('ouvre chaque port non-système et ignore les ports de bouclage système', async () => {
    const enumerator = makeEnumerator(
      ['Roland UM-ONE', 'Midi Through Port-0', 'IAC Driver Bus 1', 'FLUID Synth (qsynth)'],
      ['Roland UM-ONE', 'Microsoft GS Wavetable Synth']
    );
    const d = makeDiscovery(enumerator);
    const inputs = new Map();
    const outputs = new Map();
    const added = { in: [], out: [] };

    await d.scanAndReopen(
      inputs,
      outputs,
      (n) => {
        added.in.push(n);
        inputs.set(n, fakePort(n));
      },
      (n) => {
        added.out.push(n);
        outputs.set(n, fakePort(n));
      }
    );

    expect(added.in).toEqual(['Roland UM-ONE']);
    expect(added.out).toEqual(['Roland UM-ONE']);
  });

  test('ferme et vide les ports déjà ouverts avant de ré-énumérer', async () => {
    const d = makeDiscovery(makeEnumerator(['B'], []));
    const old = fakePort('A');
    const oldOut = fakePort('A');
    const inputs = new Map([['A', old]]);
    const outputs = new Map([['A', oldOut]]);

    await d.scanAndReopen(
      inputs,
      outputs,
      (n) => inputs.set(n, fakePort(n)),
      (n) => outputs.set(n, fakePort(n))
    );

    expect(old.closed).toBe(1);
    expect(old.listenersRemoved).toBe(1); // listeners retirés AVANT close
    expect(oldOut.closed).toBe(1);
    expect([...inputs.keys()]).toEqual(['B']);
    expect(outputs.size).toBe(0);
  });

  test('un close() qui lève n’interrompt pas le scan (pas de port orphelin)', async () => {
    const d = makeDiscovery(makeEnumerator(['NEW'], []));
    const bad = fakePort('BAD', { throwOnClose: true });
    const inputs = new Map([['BAD', bad]]);

    await expect(
      d.scanAndReopen(
        inputs,
        new Map(),
        (n) => inputs.set(n, fakePort(n)),
        () => {}
      )
    ).resolves.toBeUndefined();
    expect([...inputs.keys()]).toEqual(['NEW']);
  });

  test('port fantôme : présent à l’énumération, refuse l’ouverture → ignoré, les suivants sont ouverts', async () => {
    const inputs = new Map();
    const errors = [];
    const logger = { ...silentLogger, error: (m) => errors.push(m) };
    const d = makeDiscovery(makeEnumerator(['GHOST', 'REAL'], []), { logger });

    await d.scanAndReopen(
      inputs,
      new Map(),
      (n) => {
        if (n === 'GHOST') throw new Error('ENODEV: no such device');
        inputs.set(n, fakePort(n));
      },
      () => {}
    );

    expect([...inputs.keys()]).toEqual(['REAL']);
    expect(errors.join('\n')).toMatch(/Failed to add input GHOST/);
  });

  test('noms Unicode, espaces et très longs : transmis tels quels, sans normalisation', async () => {
    const long = 'X'.repeat(512);
    const names = [
      'Piano à queue — Steinway',
      '  espaces  autour  ',
      '日本語シンセ',
      long,
      '🎹 BLE'
    ];
    const d = makeDiscovery(makeEnumerator(names, []));
    const inputs = new Map();

    await d.scanAndReopen(
      inputs,
      new Map(),
      (n) => inputs.set(n, fakePort(n)),
      () => {}
    );

    expect([...inputs.keys()]).toEqual(names);
  });

  test('F-46 — deux ports de MÊME NOM : addInput est appelé deux fois, la Map n’en garde qu’un', async () => {
    // Deux claviers identiques branchés en même temps : l'énumérateur renvoie
    // le même libellé deux fois. L'identité d'un device est son NOM partout
    // (Map inputs/outputs, routes, réglages d'instrument), donc le second
    // exemplaire est écrasé — il est injoignable.
    const d = makeDiscovery(makeEnumerator(['Arturia KeyStep', 'Arturia KeyStep'], []));
    const inputs = new Map();
    const calls = [];

    await d.scanAndReopen(
      inputs,
      new Map(),
      (n) => {
        calls.push(n);
        inputs.set(n, fakePort(n)); // DeviceManager.addInput no-op sur doublon
      },
      () => {}
    );

    expect(calls).toEqual(['Arturia KeyStep', 'Arturia KeyStep']);
    expect(inputs.size).toBe(1); // le second port physique est perdu
  });
});

describe('L04/§G04 — hot-plug : apparition, disparition, état interne', () => {
  let enumerator, discovery, inputs, outputs, changes;

  beforeEach(() => {
    enumerator = makeEnumerator([], []);
    discovery = makeDiscovery(enumerator);
    inputs = new Map();
    outputs = new Map();
    changes = [];
    discovery.setChangeCallbacks(
      async (c) => {
        changes.push(c);
        if (c.type === 'addInput') inputs.set(c.name, fakePort(c.name));
        if (c.type === 'addOutput') outputs.set(c.name, fakePort(c.name));
      },
      async () => {}
    );
    discovery.startHotPlugMonitoring(inputs, outputs);
  });

  afterEach(() => {
    discovery.stopHotPlugMonitoring();
  });

  test('apparition d’un port : callback addInput/addOutput puis update', async () => {
    enumerator.inputs = ['Nord Stage'];
    enumerator.outputs = ['Nord Stage'];

    await discovery._onCheckDeviceChanges();

    expect(changes.map((c) => c.type)).toEqual(['addInput', 'addOutput', 'update']);
    expect(discovery.knownInputs.has('Nord Stage')).toBe(true);
    expect(discovery.knownOutputs.has('Nord Stage')).toBe(true);
  });

  test('disparition : le port est fermé, retiré des Map et de l’état connu', async () => {
    enumerator.inputs = ['Nord Stage'];
    enumerator.outputs = ['Nord Stage'];
    await discovery._onCheckDeviceChanges();
    const port = inputs.get('Nord Stage');

    enumerator.inputs = [];
    enumerator.outputs = [];
    await discovery._onCheckDeviceChanges();

    expect(port.listenersRemoved).toBe(1);
    expect(port.closed).toBe(1);
    expect(inputs.size).toBe(0);
    expect(outputs.size).toBe(0);
    expect(discovery.knownInputs.size).toBe(0);
    expect(discovery.knownOutputs.size).toBe(0);
    expect(changes.at(-1)).toEqual({ type: 'update' });
  });

  test('les ports système n’apparaissent jamais dans les changements de hot-plug', async () => {
    enumerator.inputs = ['Midi Through Port-0', 'loopMIDI Port', 'Real Device'];
    await discovery._onCheckDeviceChanges();
    expect(changes.filter((c) => c.type === 'addInput').map((c) => c.name)).toEqual([
      'Real Device'
    ]);
  });

  test('port fantôme au hot-plug : l’ouverture échoue → NON mémorisé, donc retenté à chaque tick', async () => {
    const attempts = [];
    discovery.setChangeCallbacks(
      async (c) => {
        if (c.type === 'addInput') {
          attempts.push(c.name);
          throw new Error('ENODEV');
        }
      },
      async () => {}
    );
    enumerator.inputs = ['GHOST'];

    await discovery._onCheckDeviceChanges();
    await discovery._onCheckDeviceChanges();
    await discovery._onCheckDeviceChanges();

    // Comportement voulu : pas de mémorisation d'un port jamais ouvert.
    expect(discovery.knownInputs.has('GHOST')).toBe(false);
    // Conséquence : nouvelle tentative + un log d'erreur toutes les 5 s, sans
    // borne (F-48, sévérité P3 — bruit d'observabilité, pas de fuite mémoire).
    expect(attempts).toEqual(['GHOST', 'GHOST', 'GHOST']);
    expect(inputs.size).toBe(0);
  });

  test('50 cycles connexion/déconnexion : aucune fuite d’état interne ni de handle', async () => {
    for (let i = 0; i < 50; i++) {
      enumerator.inputs = ['Cycler'];
      enumerator.outputs = ['Cycler'];
      await discovery._onCheckDeviceChanges();
      enumerator.inputs = [];
      enumerator.outputs = [];
      await discovery._onCheckDeviceChanges();
    }

    expect(discovery.knownInputs.size).toBe(0);
    expect(discovery.knownOutputs.size).toBe(0);
    expect(inputs.size).toBe(0);
    expect(outputs.size).toBe(0);
    // 50 ouvertures, 50 fermetures, 50 updates d'ajout + 50 de retrait.
    expect(changes.filter((c) => c.type === 'addInput')).toHaveLength(50);
    expect(changes.filter((c) => c.type === 'update')).toHaveLength(100);
  });

  test('un port renommé est traité comme retrait + ajout (pas de doublon résiduel)', async () => {
    enumerator.inputs = ['UM-ONE'];
    await discovery._onCheckDeviceChanges();
    enumerator.inputs = ['UM-ONE MIDI 1'];
    await discovery._onCheckDeviceChanges();

    expect([...discovery.knownInputs]).toEqual(['UM-ONE MIDI 1']);
    expect([...inputs.keys()]).toEqual(['UM-ONE MIDI 1']);
  });
});

describe('L04/§G04 — robustesse de la boucle de surveillance', () => {
  test('énumération qui lève : 5 échecs consécutifs arrêtent la surveillance', async () => {
    const enumerator = makeEnumerator([], []);
    enumerator.getInputs = () => {
      throw new Error('ALSA seq client exhausted');
    };
    const d = makeDiscovery(enumerator);
    d.setChangeCallbacks(
      async () => {},
      async () => {}
    );
    d.startHotPlugMonitoring(new Map(), new Map());

    for (let i = 0; i < 4; i++) await d._onCheckDeviceChanges();
    expect(d.hotPlugFailures).toBe(4);
    expect(d.hotPlugInterval).not.toBeNull();

    await d._onCheckDeviceChanges();
    expect(d.hotPlugFailures).toBe(5);
    expect(d.hotPlugInterval).toBeNull(); // auto-arrêt
    d.stopHotPlugMonitoring();
  });

  test('le compteur d’échecs est remis à zéro par un tick réussi', async () => {
    const enumerator = makeEnumerator([], []);
    let broken = true;
    const realInputs = enumerator.getInputs.bind(enumerator);
    enumerator.getInputs = () => {
      if (broken) throw new Error('transient');
      return realInputs();
    };
    const d = makeDiscovery(enumerator);
    d.setChangeCallbacks(
      async () => {},
      async () => {}
    );
    d.startHotPlugMonitoring(new Map(), new Map());

    await d._onCheckDeviceChanges();
    await d._onCheckDeviceChanges();
    expect(d.hotPlugFailures).toBe(2);
    broken = false;
    await d._onCheckDeviceChanges();
    expect(d.hotPlugFailures).toBe(0);
    d.stopHotPlugMonitoring();
  });

  test('start/stop répétés : un seul timer armé, aucun timer résiduel', () => {
    jest.useFakeTimers();
    try {
      const d = makeDiscovery(makeEnumerator([], []));
      const before = jest.getTimerCount();
      d.startHotPlugMonitoring(new Map(), new Map());
      d.startHotPlugMonitoring(new Map(), new Map()); // ré-entrant : no-op
      expect(jest.getTimerCount()).toBe(before + 1);
      for (let i = 0; i < 20; i++) {
        d.stopHotPlugMonitoring();
        d.startHotPlugMonitoring(new Map(), new Map());
      }
      expect(jest.getTimerCount()).toBe(before + 1);
      d.stopHotPlugMonitoring();
      expect(jest.getTimerCount()).toBe(before);
    } finally {
      jest.useRealTimers();
    }
  });
});
