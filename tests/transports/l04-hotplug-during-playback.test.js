// tests/transports/l04-hotplug-during-playback.test.js
//
// Lot L04 — §G04 : DÉBRANCHEMENT PENDANT LA LECTURE, simulé au niveau du
// gestionnaire. Scénario de scène jamais testé jusqu'ici.
//
// Montage : le vrai `DeviceManager` + la vraie `DeviceDiscovery`, avec un
// énumérateur bouchon injecté à la place d'`easymidi`. Le seul élément
// réellement indisponible ici est le CONSTRUCTEUR de port natif
// (`new easymidi.Output(...)`, qui exige ALSA) : il est remplacé par un port
// espion, tout le reste est le code de production.
//
// Questions posées par le plan d'audit, et auxquelles ce fichier répond par
// une preuve exécutable :
//   1. Les notes en cours restent-elles bloquées (notes orphelines) ?
//   2. Le player continue-t-il d'écrire dans le vide ?
//   3. Y a-t-il un panic à la déconnexion — ou à la reconnexion ?

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import EventEmitter from 'events';
import DeviceManager from '../../src/midi/devices/DeviceManager.js';
import EventBus from '../../src/core/EventBus.js';
import { SEND_STATUS } from '../../src/core/constants.js';

const DEVICE = 'Yamaha P-125';

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

/** Port de sortie espion : enregistre tout ce qui part vers le matériel. */
function spyOutput() {
  return {
    sent: [],
    closed: 0,
    send(type, data) {
      this.sent.push({ type, data });
    },
    close() {
      this.closed++;
    }
  };
}

describe('L04/§G04 — débranchement d’un device PENDANT la lecture', () => {
  let dm, eventBus, enumerator, out, warns, events;

  beforeEach(async () => {
    warns = [];
    events = [];
    eventBus = new EventBus();
    const logger = {
      info: () => {},
      debug: () => {},
      error: () => {},
      warn: (m) => warns.push(String(m))
    };
    dm = new DeviceManager({ logger, eventBus, database: null });

    enumerator = makeEnumerator([], [DEVICE]);
    dm.discovery.easymidi = enumerator;
    dm.discovery.midiAvailable = true;

    // `new easymidi.Output()` est le seul point non disponible sans ALSA :
    // on le remplace par le port espion, en conservant l'annonce produite par
    // le code de production (`_onDevicePortAdded`).
    out = spyOutput();
    dm.addOutput = (name) => {
      if (dm.outputs.has(name)) return;
      dm.outputs.set(name, out);
      dm._onDevicePortAdded(name, 'output');
    };

    for (const evt of ['device_connected', 'device_disconnected']) {
      eventBus.on(evt, (payload) => events.push({ evt, ...payload }));
    }

    dm.addOutput(DEVICE);
    await dm.updateDeviceMap();
    dm.discovery.startHotPlugMonitoring(dm.inputs, dm.outputs);
  });

  afterEach(() => {
    dm.discovery.stopHotPlugMonitoring();
    dm._pruneDisconnectedDeviceState();
  });

  test('avant débranchement : la lecture atteint le port', () => {
    for (const note of [60, 64, 67]) {
      expect(dm.sendMessageEx(DEVICE, 'noteon', { channel: 0, note, velocity: 100 })).toEqual({
        status: SEND_STATUS.SENT
      });
    }
    expect(out.sent).toHaveLength(3);
  });

  test('F-47 — le débranchement n’envoie AUCUN note-off/all-notes-off : les notes tenues restent orphelines', async () => {
    for (const note of [60, 64, 67]) {
      dm.sendMessageEx(DEVICE, 'noteon', { channel: 0, note, velocity: 100 });
    }
    const beforeUnplug = out.sent.length;

    enumerator.outputs = []; // câble arraché
    await dm.discovery._onCheckDeviceChanges();

    expect(out.closed).toBe(1);
    expect(dm.outputs.size).toBe(0);
    // Rien n'a été envoyé entre le dernier note-on et la fermeture du port :
    // aucun note-off, aucun CC 120/123, aucun reset.
    expect(out.sent).toHaveLength(beforeUnplug);
    expect(out.sent.every((m) => m.type === 'noteon')).toBe(true);
  });

  test('le débranchement émet device_disconnected exactement une fois (contrat du note-gate du routeur)', async () => {
    enumerator.outputs = [];
    await dm.discovery._onCheckDeviceChanges();

    const disconnects = events.filter((e) => e.evt === 'device_disconnected');
    expect(disconnects).toHaveLength(1);
    expect(disconnects[0].device).toBe(DEVICE);
  });

  test('après débranchement, le player écrit dans le vide : statut disconnected + un warn par message', async () => {
    enumerator.outputs = [];
    await dm.discovery._onCheckDeviceChanges();
    warns.length = 0;

    const statuses = new Set();
    for (let i = 0; i < 200; i++) {
      statuses.add(
        dm.sendMessageEx(DEVICE, 'noteon', { channel: 0, note: 60 + (i % 12), velocity: 90 }).status
      );
    }

    // Le statut est correct : le PlaybackScheduler peut appliquer sa politique.
    expect([...statuses]).toEqual([SEND_STATUS.DISCONNECTED]);
    // F-48 — mais chaque message produit un log de niveau warn, non dédupliqué :
    // 200 messages ⇒ 200 lignes. Sur une lecture réelle, c'est un déluge.
    const flood = warns.filter((w) => /Output device not found/.test(w));
    expect(flood).toHaveLength(200);
  });

  test('F-47 (suite) — au rebranchement, aucun panic / all-notes-off n’est envoyé au device', async () => {
    dm.sendMessageEx(DEVICE, 'noteon', { channel: 0, note: 60, velocity: 100 });
    enumerator.outputs = [];
    await dm.discovery._onCheckDeviceChanges();

    out = spyOutput(); // le device revient : port neuf
    enumerator.outputs = [DEVICE];
    await dm.discovery._onCheckDeviceChanges();

    expect(dm.outputs.get(DEVICE)).toBe(out);
    expect(events.filter((e) => e.evt === 'device_connected' && e.device === DEVICE)).toHaveLength(
      2
    );
    // Rien n'est envoyé à la reconnexion : un synthé auto-alimenté qui tenait
    // des notes au moment du débranchement continue de sonner.
    expect(out.sent).toEqual([]);
  });

  test('50 cycles débranchement/rebranchement pendant la lecture : aucune fuite d’état ni de handle', async () => {
    const ports = [];
    for (let i = 0; i < 50; i++) {
      dm.sendMessageEx(DEVICE, 'noteon', { channel: 0, note: 60, velocity: 100 });
      enumerator.outputs = [];
      await dm.discovery._onCheckDeviceChanges();
      out = spyOutput();
      ports.push(out);
      enumerator.outputs = [DEVICE];
      await dm.discovery._onCheckDeviceChanges();
    }

    expect(dm.outputs.size).toBe(1);
    expect(dm.discovery.knownOutputs.size).toBe(1);
    // Chaque port débranché a bien été fermé (49 fermés + le courant ouvert).
    expect(ports.slice(0, -1).every((p) => p.closed === 1)).toBe(true);
    // L'état de reconnaissance par device ne s'accumule pas.
    expect(dm._announcedDevices.size).toBeLessThanOrEqual(1);
    expect(dm._identityProbes.size).toBeLessThanOrEqual(1);
    expect(dm._descriptorFetches.size).toBe(0);
  });
});

describe('L04/§G04 — débranchement d’une ENTRÉE en plein flux', () => {
  test('les listeners sont retirés AVANT close : plus aucun message après le débranchement', async () => {
    const logger = { info: () => {}, debug: () => {}, error: () => {}, warn: () => {} };
    const eventBus = new EventBus();
    const dm = new DeviceManager({ logger, eventBus, database: null });
    const enumerator = makeEnumerator(['Keystep'], []);
    dm.discovery.easymidi = enumerator;
    dm.discovery.midiAvailable = true;

    // Port d'entrée simulé : un EventEmitter, comme l'objet easymidi.Input.
    const input = new EventEmitter();
    const order = [];
    input.close = () => order.push('close');
    const realRemove = input.removeAllListeners.bind(input);
    input.removeAllListeners = () => {
      order.push('removeAllListeners');
      return realRemove();
    };

    const received = [];
    input.on('noteon', (msg) => received.push(msg));
    dm.inputs.set('Keystep', input);
    dm.discovery.startHotPlugMonitoring(dm.inputs, dm.outputs);
    dm.discovery.setChangeCallbacks(
      async () => {},
      async () => {}
    );

    input.emit('noteon', { note: 60 });
    expect(received).toHaveLength(1);

    enumerator.inputs = [];
    await dm.discovery._onCheckDeviceChanges();

    expect(order).toEqual(['removeAllListeners', 'close']);
    input.emit('noteon', { note: 62 }); // le pilote natif peut encore pousser
    expect(received).toHaveLength(1); // …mais plus personne n'écoute
    dm.discovery.stopHotPlugMonitoring();
  });
});
