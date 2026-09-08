/**
 * @file tests/audit/r19-hotplug-silence.test.js
 * @description Vague 4 · R19 — **F-47** : au débranchement, rien n'était
 * envoyé ; au rebranchement, rien non plus ; et chaque message adressé au
 * device disparu produisait une ligne de log.
 *
 * Sur scène, un câble arraché laissait un synthé auto-alimenté **bloqué en
 * train de sonner**, sans aucun moyen de l'arrêter — le device n'est plus
 * joignable, donc même le panic ne l'atteint pas. Trois exigences, trois
 * sections :
 *
 * 1. **Couper avant que ce ne soit trop tard.** Le port encore ouvert reçoit la
 *    rafale de silence juste avant `close()`. Quand le lien est déjà mort (le
 *    vrai câble arraché), on ne peut rien envoyer : une seule tentative, pas 48,
 *    et le device est mémorisé.
 * 2. **Repartir propre au retour.** Un device dont la sortie avait disparu est
 *    silencé à sa réapparition — et **uniquement** dans ce cas : la première
 *    ouverture au démarrage n'envoie rien, on ne coupe pas un instrument qui
 *    jouait avant nous.
 * 3. **Borner le journal.** Une ligne, puis un compteur, puis une ligne de
 *    synthèse au retour.
 *
 * La section 2 est répétée **sur les quatre transports** avec les vrais
 * gestionnaires : c'est la preuve de parité de R19, pendant de celle de R18.
 * Le banc de simulation de débranchement est celui livré par L04
 * (`tests/transports/l04-*`) : faux énumérateur pour l'USB, `InMemoryBleAdapter`
 * pour le BLE, classe `SerialPort` bouchon pour l'UART, sessions RTP locales.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import EventEmitter from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

import DeviceManager from '../../src/midi/devices/DeviceManager.js';
import EventBus from '../../src/core/EventBus.js';
import SerialMidiManager from '../../src/transports/SerialMidiManager.js';
import BluetoothManager from '../../src/transports/BluetoothManager.js';
import InMemoryBleAdapter from '../../src/midi/adapters/InMemoryBleAdapter.js';
import NetworkManager from '../../src/transports/NetworkManager.js';
import RtpMidiSession from '../../src/transports/RtpMidiSession.js';
import { silenceSequenceBytes } from '../../src/midi/messages/SilenceSequence.js';
import { SEND_STATUS } from '../../src/core/constants.js';

const EXPECTED_BYTES = silenceSequenceBytes();
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const flush = () => new Promise((r) => setTimeout(r, 0));

function recordingLogger() {
  const warns = [];
  const infos = [];
  return {
    logger: {
      info: (m) => infos.push(String(m)),
      debug: () => {},
      error: () => {},
      warn: (m) => warns.push(String(m))
    },
    warns,
    infos
  };
}

/** Port de sortie espion, façon easymidi.Output. */
function spyOutput() {
  return {
    sent: [],
    closed: 0,
    closedAfter: null,
    send(type, data) {
      this.sent.push({ type, data });
    },
    close() {
      this.closed++;
      this.closedAfter = this.sent.length;
    }
  };
}

/** Les octets qu'un port espion a réellement vu passer. */
function bytesOf(port) {
  return port.sent.flatMap(({ type, data }) => {
    expect(type).toBe('cc');
    return [0xb0 | (data.channel & 0x0f), data.controller, data.value];
  });
}

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

// ===========================================================================
// 1. USB — couper avant la fermeture du port
// ===========================================================================
describe('R19/F-47 — USB : la rafale part avant que le port ne ferme', () => {
  const DEVICE = 'Yamaha P-125';
  let dm, enumerator, out, warns;

  beforeEach(async () => {
    ({ warns } = recordingLogger());
    const rec = recordingLogger();
    warns = rec.warns;
    dm = new DeviceManager({ logger: rec.logger, eventBus: new EventBus(), database: null });
    enumerator = makeEnumerator([], [DEVICE]);
    dm.discovery.easymidi = enumerator;
    dm.discovery.midiAvailable = true;
    out = spyOutput();
    dm.addOutput = (name) => {
      if (dm.outputs.has(name)) return;
      dm.outputs.set(name, out);
      dm._onDevicePortAdded(name, 'output');
    };
    dm.addOutput(DEVICE);
    await dm.updateDeviceMap();
    dm.discovery.startHotPlugMonitoring(dm.inputs, dm.outputs);
  });

  afterEach(() => {
    dm.discovery.stopHotPlugMonitoring();
  });

  test('les octets envoyés au port mourant sont exactement ceux du panic', async () => {
    dm.sendMessageEx(DEVICE, 'noteon', { channel: 0, note: 60, velocity: 100 });
    out.sent.length = 0;
    enumerator.outputs = [];
    await dm.discovery._onCheckDeviceChanges();
    expect(bytesOf(out)).toEqual(EXPECTED_BYTES);
  });

  test('la purge précède strictement close()', async () => {
    enumerator.outputs = [];
    await dm.discovery._onCheckDeviceChanges();
    expect(out.closed).toBe(1);
    expect(out.closedAfter).toBe(48); // les 48 messages étaient déjà partis
  });

  test('un scan/refresh ordinaire ne coupe RIEN : seule une disparition déclenche la purge', async () => {
    // `scanAndReopen` (device_refresh) ferme puis rouvre des ports SAINS. Un
    // rafraîchissement au milieu d'un morceau ne doit pas faire taire
    // l'orchestre : le hook de purge n'est branché que sur la disparition.
    const scanPort = spyOutput();
    dm.outputs.set(DEVICE, scanPort);
    dm.addOutput = () => {};
    await dm.discovery.scanAndReopen(
      dm.inputs,
      dm.outputs,
      () => {},
      () => {}
    );
    expect(scanPort.closed).toBe(1);
    expect(scanPort.sent).toEqual([]);
    expect(dm._disconnectedOutputs.size).toBe(0);
  }, 15000);

  test('câble arraché : une seule tentative d’écriture, la fermeture aboutit quand même', async () => {
    let attempts = 0;
    out.send = () => {
      attempts++;
      throw new Error('device not connected');
    };
    enumerator.outputs = [];
    await dm.discovery._onCheckDeviceChanges();
    expect(attempts).toBe(1);
    expect(out.closed).toBe(1);
    expect(dm._disconnectedOutputs.has(DEVICE)).toBe(true);
    // Un lien mort est le cas normal d'un câble arraché : on le trace en info
    // (avec la mention que des notes peuvent rester bloquées), pas en warn, et
    // surtout pas 48 fois.
    expect(warns.filter((w) => /ilenc|unreachable|Pre-close/.test(w))).toHaveLength(0);
  });

  test('rebranchement : la rafale est rejouée sur le port neuf, une seule fois', async () => {
    enumerator.outputs = [];
    await dm.discovery._onCheckDeviceChanges();
    out = spyOutput();
    enumerator.outputs = [DEVICE];
    await dm.discovery._onCheckDeviceChanges();
    expect(bytesOf(out)).toEqual(EXPECTED_BYTES);
    // Un second passage du hot-plug sans nouvelle disparition n'ajoute rien.
    const before = out.sent.length;
    await dm.discovery._onCheckDeviceChanges();
    expect(out.sent).toHaveLength(before);
    expect(dm._disconnectedOutputs.size).toBe(0);
  });

  test('50 cycles : aucun état résiduel, rien qui grossit', async () => {
    for (let i = 0; i < 50; i++) {
      enumerator.outputs = [];
      await dm.discovery._onCheckDeviceChanges();
      out = spyOutput();
      enumerator.outputs = [DEVICE];
      await dm.discovery._onCheckDeviceChanges();
    }
    expect(dm._disconnectedOutputs.size).toBe(0);
    expect(dm._missingOutputDrops.size).toBe(0);
    expect(bytesOf(out)).toEqual(EXPECTED_BYTES);
  });

  test('la première ouverture au démarrage n’envoie rien', () => {
    const fresh = new DeviceManager({
      logger: silentLogger,
      eventBus: new EventBus(),
      database: null
    });
    const port = spyOutput();
    fresh.outputs.set('Neuf', port);
    fresh._onDevicePortAdded('Neuf', 'output');
    expect(port.sent).toEqual([]);
    // Une entrée qui apparaît ne déclenche rien non plus (rien à faire taire).
    fresh._disconnectedOutputs.add('Clavier');
    fresh._onDevicePortAdded('Clavier', 'input');
    expect(fresh._disconnectedOutputs.has('Clavier')).toBe(true);
    fresh.discovery.stopHotPlugMonitoring();
  });

  test('l’arrêt du serveur fait taire chaque sortie avant de fermer', () => {
    const port = spyOutput();
    const closing = new DeviceManager({
      logger: silentLogger,
      eventBus: new EventBus(),
      database: null
    });
    closing.outputs.set('Sortie', port);
    closing.close();
    // Application.stop() décrit ce pas comme « silences instruments — no stuck
    // notes » depuis toujours ; rien n'était envoyé.
    expect(bytesOf(port)).toEqual(EXPECTED_BYTES);
    expect(port.closedAfter).toBe(48);
  });
});

// ===========================================================================
// 2. Parité — le même traitement sur les quatre transports
// ===========================================================================
describe('R19 — parité : reconnexion silencée sur les 4 transports', () => {
  test('USB : la sortie qui revient reçoit la séquence', async () => {
    const dm = new DeviceManager({
      logger: silentLogger,
      eventBus: new EventBus(),
      database: null
    });
    const port = spyOutput();
    dm._disconnectedOutputs.add('USB-DEV'); // il avait disparu
    dm.outputs.set('USB-DEV', port);
    dm._onDevicePortAdded('USB-DEV', 'output');
    expect(bytesOf(port)).toEqual(EXPECTED_BYTES);
    dm.discovery.stopHotPlugMonitoring();
  });

  test('BLE : la déconnexion puis la reconnexion du lien silencent le périphérique', async () => {
    const ADDR = 'AA:BB:CC:00:00:01';
    const port = new InMemoryBleAdapter({
      fixtures: [{ address: ADDR, name: 'Test Synth', isMidiDevice: true }]
    });
    const ble = new BluetoothManager({ logger: silentLogger }, { port });
    await ble._initPromise;
    await port.startDiscovery();
    await ble.connect(ADDR);

    const dm = new DeviceManager({
      logger: silentLogger,
      eventBus: new EventBus(),
      database: null,
      bluetoothManager: ble
    });

    // Coupure du lien radio (hors de portée), puis retour.
    await port.disconnect(ADDR);
    expect(dm._disconnectedOutputs.has(ADDR)).toBe(true);
    port._sentMidi.length = 0;
    await ble.connect(ADDR);
    await flush();

    const midi = [];
    for (const { data } of port._sentMidi) midi.push(...Array.from(data).slice(2));
    expect(midi).toEqual(EXPECTED_BYTES);
    expect(dm._disconnectedOutputs.has(ADDR)).toBe(false);
    dm.discovery.stopHotPlugMonitoring();
    await ble.cleanup();
  });

  test('Série : le port UART qui réapparaît reçoit exactement les mêmes octets', async () => {
    const written = [];
    const serial = Object.create(SerialMidiManager.prototype);
    EventEmitter.call(serial);
    serial.logger = silentLogger;
    serial.openPorts = new Map([
      [
        '/dev/ttyAMA0',
        {
          path: '/dev/ttyAMA0',
          name: 'UART0',
          direction: 'both',
          port: {
            write: (buf, cb) => {
              written.push(...buf);
              if (cb) cb(null);
              return true;
            }
          }
        }
      ]
    ]);
    serial.getConnectedPorts = () => [{ path: '/dev/ttyAMA0', name: 'UART0', direction: 'both' }];

    const dm = new DeviceManager({
      logger: silentLogger,
      eventBus: new EventBus(),
      database: null,
      serialMidiManager: serial
    });

    serial.emit('serial:disconnected', { path: '/dev/ttyAMA0', name: 'UART0' });
    expect(dm._disconnectedOutputs.has('/dev/ttyAMA0')).toBe(true);
    written.length = 0;
    serial.emit('serial:connected', { path: '/dev/ttyAMA0', name: 'UART0' });

    expect(written).toEqual(EXPECTED_BYTES);
    dm.discovery.stopHotPlugMonitoring();
  });

  test('RTP : la session qui se rétablit reçoit exactement les mêmes octets', async () => {
    const packets = [];
    const session = Object.create(RtpMidiSession.prototype);
    session.state = 'established';
    session.sequenceNumber = 0;
    session.ssrc = 1;
    session.timestamp = 0;
    session._now10k = () => 0;
    session._sendData = (buf) => packets.push(buf);
    session.isConnected = () => true;

    const nm = Object.create(NetworkManager.prototype);
    EventEmitter.call(nm);
    nm.logger = silentLogger;
    nm.rtpSessions = new Map([['10.0.0.7', session]]);
    nm.getConnectedDevices = () => [{ ip: '10.0.0.7', name: 'RTP', port: 5004 }];

    const dm = new DeviceManager({
      logger: silentLogger,
      eventBus: new EventBus(),
      database: null,
      networkManager: nm
    });

    nm.emit('network:disconnected', { ip: '10.0.0.7', device_id: '10.0.0.7' });
    expect(dm._disconnectedOutputs.has('10.0.0.7')).toBe(true);
    packets.length = 0;
    nm.emit('network:connected', { ip: '10.0.0.7', device_id: '10.0.0.7' });
    await flush();

    const decoder = Object.create(RtpMidiSession.prototype);
    decoder._rtpRunningStatus = 0;
    const midi = [];
    for (const pkt of packets) {
      for (const cmd of decoder.parseRtpPacket(pkt).midiCommands) midi.push(...cmd);
    }
    expect(midi).toEqual(EXPECTED_BYTES);
    dm.discovery.stopHotPlugMonitoring();
  });

  test('les abonnements aux transports sont idempotents : un seul jeu de handlers', () => {
    const serial = Object.create(SerialMidiManager.prototype);
    EventEmitter.call(serial);
    const dm = new DeviceManager({
      logger: silentLogger,
      eventBus: new EventBus(),
      database: null,
      serialMidiManager: serial
    });
    dm._attachTransportLifecycleHandlers();
    dm._attachTransportLifecycleHandlers();
    expect(serial.listenerCount('serial:connected')).toBe(1);
    expect(serial.listenerCount('serial:disconnected')).toBe(1);
    dm.discovery.stopHotPlugMonitoring();
  });

  test('un transport enregistré APRÈS DeviceManager est rattrapé au premier scan', async () => {
    // Contrat de composition (CLAUDE.md) : Bluetooth / Network / Serial sont
    // enregistrés APRÈS DeviceManager dans Application.initialize, et sont
    // absents des hôtes sans dépendance native. Les abonnements ne peuvent donc
    // pas être pris au constructeur seul.
    const serial = Object.create(SerialMidiManager.prototype);
    EventEmitter.call(serial);
    serial.openPorts = new Map();
    let late = null;
    const deps = {
      logger: silentLogger,
      eventBus: new EventBus(),
      database: null,
      get serialMidiManager() {
        return late;
      }
    };
    const dm = new DeviceManager(deps);
    expect(serial.listenerCount('serial:connected')).toBe(0);
    late = serial; // le transport apparaît plus tard
    await dm.scanDevices();
    expect(serial.listenerCount('serial:connected')).toBe(1);
    dm.discovery.stopHotPlugMonitoring();
  });

  test('un hôte sans transport optionnel ne casse pas (Pi minimal / conteneur)', () => {
    const dm = new DeviceManager({
      logger: silentLogger,
      eventBus: new EventBus(),
      database: null
    });
    expect(() => dm._attachTransportLifecycleHandlers()).not.toThrow();
    dm.discovery.stopHotPlugMonitoring();
  });
});

// ===========================================================================
// 3. Série — la purge avant fermeture, au niveau du transport
// ===========================================================================
describe('R19/F-47 — série : purge avant close(), avec le vrai gestionnaire', () => {
  let tmpDir, DEVICE_PATH;

  function makeFakeSerialPortClass() {
    const instances = [];
    class FakeSerialPort extends EventEmitter {
      constructor(options) {
        super();
        this.options = options;
        this.isOpen = false;
        this.written = [];
        this.closedAfterBytes = null;
        instances.push(this);
      }
      open(cb) {
        this.isOpen = true;
        cb(null);
      }
      write(buf, cb) {
        this.written.push(...buf);
        if (cb) cb(null);
        return true;
      }
      close(cb) {
        this.closedAfterBytes = this.written.length;
        this.isOpen = false;
        this.emit('close');
        if (cb) cb(null);
      }
    }
    FakeSerialPort.instances = instances;
    return FakeSerialPort;
  }

  async function makeManager() {
    const mgr = new SerialMidiManager({
      logger: silentLogger,
      config: { serial: { enabled: false, ports: [] } },
      deviceManager: null
    });
    await mgr._initPromise;
    mgr.SerialPort = makeFakeSerialPortClass();
    mgr.enabled = true;
    return mgr;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r19-serial-'));
    DEVICE_PATH = path.join(tmpDir, 'ttyAMA0');
    fs.writeFileSync(DEVICE_PATH, '');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('closePort purge la séquence AVANT de fermer', async () => {
    const mgr = await makeManager();
    const info = await mgr.openPort(DEVICE_PATH, 'UART0', 'both');
    info.port.written.length = 0;
    await mgr.closePort(DEVICE_PATH);
    expect(info.port.written).toEqual(EXPECTED_BYTES);
    expect(info.port.closedAfterBytes).toBe(EXPECTED_BYTES.length);
  });

  test('le hot-plug (device file disparu) tente la purge puis ferme', async () => {
    const mgr = await makeManager();
    const info = await mgr.openPort(DEVICE_PATH, 'UART0', 'both');
    mgr.knownPorts.add(DEVICE_PATH);
    info.port.written.length = 0;
    fs.rmSync(DEVICE_PATH);
    mgr._checkPortChanges();
    expect(info.port.written).toEqual(EXPECTED_BYTES);
    expect(mgr.openPorts.has(DEVICE_PATH)).toBe(false);
  });

  test('un port en entrée seule n’est jamais purgé (rien à faire taire)', async () => {
    const mgr = await makeManager();
    const info = await mgr.openPort(DEVICE_PATH, 'UART0', 'in');
    info.port.written.length = 0;
    await mgr.closePort(DEVICE_PATH);
    expect(info.port.written).toEqual([]);
  });

  test('une écriture qui lève pendant la purge ne bloque pas la fermeture', async () => {
    const mgr = await makeManager();
    const info = await mgr.openPort(DEVICE_PATH, 'UART0', 'both');
    info.port.write = () => {
      throw new Error('EIO');
    };
    await expect(mgr.closePort(DEVICE_PATH)).resolves.toBeUndefined();
    expect(mgr.openPorts.has(DEVICE_PATH)).toBe(false);
  });

  test('shutdown() purge chaque port ouvert', async () => {
    const mgr = await makeManager();
    const info = await mgr.openPort(DEVICE_PATH, 'UART0', 'both');
    info.port.written.length = 0;
    await mgr.shutdown();
    expect(info.port.written).toEqual(EXPECTED_BYTES);
  });
});

// ===========================================================================
// 4. Le journal est borné
// ===========================================================================
describe('R19/F-48 — le déluge de logs est borné', () => {
  let dm, warns;

  beforeEach(() => {
    const rec = recordingLogger();
    warns = rec.warns;
    dm = new DeviceManager({ logger: rec.logger, eventBus: new EventBus(), database: null });
  });

  afterEach(() => dm.discovery.stopHotPlugMonitoring());

  test('1 000 messages vers un device absent ⇒ 1 ligne, 999 comptés', () => {
    for (let i = 0; i < 1000; i++) {
      expect(
        dm.sendMessageEx('Parti', 'noteon', { channel: 0, note: 60, velocity: 90 }).status
      ).toBe(SEND_STATUS.DISCONNECTED);
    }
    expect(warns.filter((w) => /Output device not found/.test(w))).toHaveLength(1);
    expect(dm._missingOutputDrops.get('Parti')).toBe(999);
  });

  test('le compteur est par device et n’en confond pas deux', () => {
    for (let i = 0; i < 10; i++) {
      dm.sendMessageEx('A', 'noteon', { channel: 0, note: 60, velocity: 90 });
    }
    for (let i = 0; i < 4; i++) {
      dm.sendMessageEx('B', 'noteon', { channel: 0, note: 60, velocity: 90 });
    }
    expect(warns.filter((w) => /Output device not found/.test(w))).toHaveLength(2);
    expect(dm._missingOutputDrops.get('A')).toBe(9);
    expect(dm._missingOutputDrops.get('B')).toBe(3);
  });

  test('le retour du device produit UNE ligne de synthèse chiffrée, puis réarme', () => {
    for (let i = 0; i < 25; i++) {
      dm.sendMessageEx('Parti', 'noteon', { channel: 0, note: 60, velocity: 90 });
    }
    warns.length = 0;
    dm.outputs.set('Parti', spyOutput());
    dm._onDevicePortAdded('Parti', 'output');
    const summary = warns.filter((w) => /24 further message/.test(w));
    expect(summary).toHaveLength(1);
    expect(dm._missingOutputDrops.has('Parti')).toBe(false);

    // Réarmé : une disparition ultérieure avertit de nouveau, une seule fois.
    dm.outputs.delete('Parti');
    warns.length = 0;
    for (let i = 0; i < 30; i++) {
      dm.sendMessageEx('Parti', 'noteon', { channel: 0, note: 60, velocity: 90 });
    }
    expect(warns.filter((w) => /Output device not found/.test(w))).toHaveLength(1);
  });

  test('un retour sans aucun abandon compté ne produit AUCUNE ligne de synthèse', () => {
    dm.sendMessageEx('Parti', 'noteon', { channel: 0, note: 60, velocity: 90 }); // 1 warn
    warns.length = 0;
    dm.outputs.set('Parti', spyOutput());
    dm._onDevicePortAdded('Parti', 'output');
    expect(warns).toHaveLength(0);
  });

  test('le statut renvoyé est inchangé : le scheduler garde sa politique', () => {
    const first = dm.sendMessageEx('Parti', 'noteon', { channel: 0, note: 60, velocity: 90 });
    const later = dm.sendMessageEx('Parti', 'noteon', { channel: 0, note: 60, velocity: 90 });
    expect(first).toEqual({ status: SEND_STATUS.DISCONNECTED });
    expect(later).toEqual({ status: SEND_STATUS.DISCONNECTED });
  });
});
