// tests/transports/l04-serial-port-management.test.js
//
// Lot L04 — §M (UART / GPIO) : SerialMidiManager (17,3 % de couverture avant
// ce lot). L'ouverture d'un port /dev/ttyAMA0 est matérielle ; la GESTION du
// port ne l'est pas. Ce fichier injecte une classe `SerialPort` bouchon et
// pousse les octets dans le parser par un `stream.Readable`, exactement comme
// le pilote le ferait.
//
// Périmètre : ouverture, ré-ouverture, erreurs (EACCES / EBUSY / absent),
// fermeture, événements, débit 31 250 baud simulé, débordement du tampon
// SysEx, file d'écriture bornée et priorités, hot-plug, activation/
// désactivation, arrêt propre.
// La CONFORMITÉ du parser (running status, temps réel intercalé, SysEx) est du
// ressort du lot L03 : ici on ne teste que ce que la gestion de port garantit
// — segmentation des chunks, port fermé, débordement, débit.

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import EventEmitter from 'events';
import { Readable } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';
import SerialMidiManager from '../../src/transports/SerialMidiManager.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** Fichier réel tenant lieu de /dev/ttyAMA0 (openPort fait un existsSync). */
let tmpDir;
let DEVICE_PATH;

/** Classe SerialPort bouchon : même surface que `serialport@12`. */
function makeFakeSerialPortClass(behaviour = {}) {
  const instances = [];
  class FakeSerialPort extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.isOpen = false;
      this.written = [];
      this.flushed = behaviour.flushed !== false;
      this.closedCount = 0;
      instances.push(this);
    }
    open(cb) {
      if (behaviour.openError) return cb(new Error(behaviour.openError));
      this.isOpen = true;
      cb(null);
    }
    write(buf, cb) {
      if (behaviour.writeThrows) throw new Error('EIO write');
      this.written.push(Buffer.from(buf));
      if (cb) cb(behaviour.writeError ? new Error(behaviour.writeError) : null);
      return this.flushed;
    }
    close(cb) {
      this.closedCount++;
      this.isOpen = false;
      this.emit('close');
      if (cb) cb(null);
    }
  }
  FakeSerialPort.instances = instances;
  return FakeSerialPort;
}

/**
 * Manager prêt à l'emploi : construit désactivé (aucun `import('serialport')`),
 * puis on injecte la classe bouchon — le chemin de code exercé ensuite
 * (openPort / parser / file d'écriture / hot-plug) est celui de production.
 */
async function makeManager({ ports = [], behaviour = {}, logger = silentLogger } = {}) {
  const mgr = new SerialMidiManager({
    logger,
    config: { serial: { enabled: false, ports } },
    deviceManager: null
  });
  await mgr._initPromise;
  mgr.SerialPort = makeFakeSerialPortClass(behaviour);
  mgr.enabled = true;
  mgr.configuredPorts = ports;
  return mgr;
}

/** Collecte les messages remontés à DeviceManager.handleMidiMessage. */
function attachDeviceManager(mgr) {
  const received = [];
  Object.defineProperty(mgr, 'deviceManager', {
    configurable: true,
    get: () => ({
      handleMidiMessage: (src, type, data) => received.push({ src, type, data }),
      broadcastDeviceList: () => {}
    })
  });
  return received;
}

/** Pousse `chunks` dans le port ouvert via un vrai flux Node. */
function feedStream(portInfo, chunks) {
  return new Promise((resolve) => {
    const readable = Readable.from(chunks.map((c) => Buffer.from(c)));
    readable.on('data', (buf) => portInfo.port.emit('data', buf));
    readable.on('end', resolve);
    readable.resume();
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'l04-serial-'));
  DEVICE_PATH = path.join(tmpDir, 'ttyAMA0');
  fs.writeFileSync(DEVICE_PATH, '');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('L04/§M — ouverture et fermeture de port', () => {
  test('ouverture réussie : 31 250 baud, 8N1, port enregistré, événement émis', async () => {
    const mgr = await makeManager();
    const events = [];
    mgr.on('serial:connected', (e) => events.push(e));

    const info = await mgr.openPort(DEVICE_PATH, 'UART0', 'both');

    expect(info.connected).toBe(true);
    expect(mgr.openPorts.has(DEVICE_PATH)).toBe(true);
    const opts = mgr.SerialPort.instances[0].options;
    expect(opts).toMatchObject({
      path: DEVICE_PATH,
      baudRate: 31250,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      autoOpen: false
    });
    expect(events).toEqual([{ path: DEVICE_PATH, name: 'UART0' }]);
    expect(mgr.getStatus()).toMatchObject({ enabled: true, available: true, openPorts: 1 });
    await mgr.shutdown();
  });

  test('nom convivial déduit du chemin quand il n’est pas fourni', async () => {
    const mgr = await makeManager();
    const amaPath = path.join(tmpDir, 'ttyAMA1');
    fs.writeFileSync(amaPath, '');
    const info = await mgr.openPort(amaPath);
    expect(info.name).toBe('UART2 (GPIO0/1)');
    await mgr.shutdown();
  });

  test('ré-ouverture du même port refusée', async () => {
    const mgr = await makeManager();
    await mgr.openPort(DEVICE_PATH);
    await expect(mgr.openPort(DEVICE_PATH)).rejects.toThrow(/already open/);
    await mgr.shutdown();
  });

  test('périphérique absent : message explicite sur l’UART non activé', async () => {
    const mgr = await makeManager();
    await expect(mgr.openPort('/dev/ttyAMA9-inexistant')).rejects.toThrow(
      /Serial device not found.*config\.txt/s
    );
    await mgr.shutdown();
  });

  test('EACCES → consigne dialout ; EBUSY → port occupé ; autre → message brut', async () => {
    const denied = await makeManager({ behaviour: { openError: 'Permission denied' } });
    await expect(denied.openPort(DEVICE_PATH)).rejects.toThrow(/usermod -aG dialout/);

    const busy = await makeManager({ behaviour: { openError: 'EBUSY: resource busy' } });
    await expect(busy.openPort(DEVICE_PATH)).rejects.toThrow(/busy/i);

    const other = await makeManager({ behaviour: { openError: 'ENXIO no such device' } });
    await expect(other.openPort(DEVICE_PATH)).rejects.toThrow(/Failed to open .*ENXIO/);
  });

  test('F-52 — l’ouverture ne doit laisser aucun timer de garde armé', async () => {
    jest.useFakeTimers();
    try {
      const mgr = await makeManager();
      const before = jest.getTimerCount();
      await mgr.openPort(DEVICE_PATH);
      // Le garde-fou de 10 s (PORT_OPEN_TIMEOUT_MS) doit être annulé dès que la
      // course est tranchée ; sinon chaque ouverture retient la boucle
      // d'événements 10 s et le processus refuse de se terminer.
      expect(jest.getTimerCount()).toBe(before);
      await mgr.shutdown();
    } finally {
      jest.useRealTimers();
    }
  });

  test('fermeture explicite : port retiré, événement de déconnexion émis', async () => {
    const mgr = await makeManager();
    const events = [];
    mgr.on('serial:disconnected', (e) => events.push(e));
    await mgr.openPort(DEVICE_PATH, 'UART0');

    await mgr.closePort(DEVICE_PATH);

    expect(mgr.openPorts.has(DEVICE_PATH)).toBe(false);
    expect(mgr.SerialPort.instances[0].closedCount).toBe(1);
    expect(events).toEqual([{ path: DEVICE_PATH, name: 'UART0' }]);
    await expect(mgr.closePort(DEVICE_PATH)).rejects.toThrow(/not open/);
  });

  test('une erreur du pilote est propagée en événement serial:error sans fermer le port', async () => {
    const mgr = await makeManager();
    const errors = [];
    mgr.on('serial:error', (e) => errors.push(e));
    const info = await mgr.openPort(DEVICE_PATH);

    info.port.emit('error', new Error('framing error'));

    expect(errors).toEqual([{ path: DEVICE_PATH, error: 'framing error' }]);
    expect(mgr.openPorts.has(DEVICE_PATH)).toBe(true);
    await mgr.shutdown();
  });

  test('une fermeture venue du pilote (câble arraché) retire le port de la liste', async () => {
    const mgr = await makeManager();
    const info = await mgr.openPort(DEVICE_PATH);
    const events = [];
    mgr.on('serial:disconnected', (e) => events.push(e));

    info.port.emit('close');

    expect(mgr.openPorts.has(DEVICE_PATH)).toBe(false);
    expect(events).toHaveLength(1);
  });
});

describe('L04/§M — lecture du flux (stream.Readable → parser)', () => {
  let mgr, received, info;

  beforeEach(async () => {
    mgr = await makeManager();
    received = attachDeviceManager(mgr);
    info = await mgr.openPort(DEVICE_PATH, 'UART0', 'both');
  });

  afterEach(async () => {
    await mgr.shutdown();
  });

  test('un message découpé en trois chunks est reconstitué', async () => {
    await feedStream(info, [[0x90], [0x3c], [0x40]]);
    expect(received).toEqual([
      { src: DEVICE_PATH, type: 'noteon', data: { channel: 0, note: 0x3c, velocity: 0x40 } }
    ]);
  });

  test('la source remontée est le CHEMIN du port, pas son nom convivial', async () => {
    await feedStream(info, [[0xb0, 0x07, 0x64]]);
    expect(received[0].src).toBe(DEVICE_PATH);
  });

  test('débit 31 250 baud : une seconde de trafic saturé est absorbée', async () => {
    // 31 250 bauds ⇒ 3 125 octets/s ⇒ ~1 041 messages de 3 octets par seconde.
    const MESSAGES = 1041;
    const burst = [];
    for (let i = 0; i < MESSAGES; i++) burst.push(0x90, 60 + (i % 12), 0x40);
    const chunks = [];
    for (let i = 0; i < burst.length; i += 64) chunks.push(burst.slice(i, i + 64));

    const t0 = process.hrtime.bigint();
    await feedStream(info, chunks);
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

    expect(received).toHaveLength(MESSAGES);
    // Le parser doit rester très loin du temps réel qu'il représente (1 s).
    expect(elapsedMs).toBeLessThan(250);
  });

  test('SysEx qui déborde le tampon : abandonné avec un avertissement, puis reprise', async () => {
    const warns = [];
    mgr.logger = { ...silentLogger, warn: (m) => warns.push(String(m)) };
    const huge = [0xf0];
    for (let i = 0; i < 70000; i++) huge.push(0x01); // > MAX_SYSEX_BUFFER_SIZE
    const chunks = [];
    for (let i = 0; i < huge.length; i += 4096) chunks.push(huge.slice(i, i + 4096));

    await feedStream(info, chunks);
    expect(warns.join('\n')).toMatch(/SysEx buffer overflow/);
    expect(received).toHaveLength(0);
    expect(info.parserState.sysExBuffer).toHaveLength(0);
    expect(info.parserState.inSysEx).toBe(false);

    // Le port reste utilisable après le débordement.
    await feedStream(info, [[0x90, 0x40, 0x7f]]);
    expect(received).toHaveLength(1);
  });

  test('des octets arrivant après la fermeture du port sont ignorés sans erreur', async () => {
    const port = info.port;
    await mgr.closePort(DEVICE_PATH);
    expect(() => port.emit('data', Buffer.from([0x90, 0x3c, 0x40]))).not.toThrow();
    expect(received).toHaveLength(0);
  });

  test('un port ouvert en sortie seule n’installe aucun écouteur de données', async () => {
    const outPath = path.join(tmpDir, 'ttyAMA2');
    fs.writeFileSync(outPath, '');
    const outInfo = await mgr.openPort(outPath, 'OUT', 'out');
    expect(outInfo.port.listenerCount('data')).toBe(0);
    outInfo.port.emit('data', Buffer.from([0x90, 0x3c, 0x40]));
    expect(received).toHaveLength(0);
  });
});

describe('L04/§M — file d’écriture bornée et priorités', () => {
  test('émission simple : les octets MIDI atteignent le port', async () => {
    const mgr = await makeManager();
    const info = await mgr.openPort(DEVICE_PATH, 'UART0', 'both');
    mgr.sendMidiMessage(DEVICE_PATH, 'noteon', { channel: 1, note: 60, velocity: 100 });
    expect(Array.from(info.port.written[0])).toEqual([0x91, 60, 100]);
    // Le port est aussi adressable par son nom convivial.
    mgr.sendMidiMessage('UART0', 'noteoff', { channel: 1, note: 60, velocity: 0 });
    expect(info.port.written).toHaveLength(2);
    await mgr.shutdown();
  });

  test('port inconnu ou entrée seule : erreur explicite', async () => {
    const mgr = await makeManager();
    expect(() => mgr.sendMidiMessage('/dev/nope', 'noteon', {})).toThrow(/not found/);
    const inPath = path.join(tmpDir, 'ttyAMA3');
    fs.writeFileSync(inPath, '');
    await mgr.openPort(inPath, 'IN', 'in');
    expect(() => mgr.sendMidiMessage(inPath, 'noteon', { note: 60 })).toThrow(/input-only/);
    await mgr.shutdown();
  });

  test('saturation : la file est plafonnée et les messages de silence ne sont JAMAIS supprimés', async () => {
    const mgr = await makeManager({ behaviour: { flushed: false } }); // aucun drain
    const info = await mgr.openPort(DEVICE_PATH, 'UART0', 'both');

    for (let i = 0; i < 3000; i++) {
      mgr.sendMidiMessage(DEVICE_PATH, 'noteon', { channel: 0, note: 60, velocity: 100 });
    }
    mgr.sendMidiMessage(DEVICE_PATH, 'cc', { channel: 0, controller: 123, value: 0 }); // All Notes Off
    mgr.sendMidiMessage(DEVICE_PATH, 'noteoff', { channel: 0, note: 60, velocity: 0 });

    expect(info.writeQueue.length).toBeLessThanOrEqual(1024);
    expect(info.droppedWrites).toBeGreaterThan(0);
    // Les deux messages prioritaires sont en tête de file, jamais évincés.
    expect(info.writeQueue.filter((q) => q.priority)).toHaveLength(2);
    expect(info.writeQueue[0].priority).toBe(true);
    await mgr.shutdown();
  });

  test('une écriture qui lève est signalée et ne bloque pas la file', async () => {
    const mgr = await makeManager({ behaviour: { writeThrows: true } });
    const info = await mgr.openPort(DEVICE_PATH, 'UART0', 'both');
    const errors = [];
    mgr.on('write:error', (e) => errors.push(e));

    mgr.sendMidiMessage(DEVICE_PATH, 'noteon', { channel: 0, note: 60, velocity: 100 });

    expect(errors).toHaveLength(1);
    expect(info.writing).toBe(false); // la file n'est pas verrouillée
    expect(info.writeErrors).toBe(1);
    await mgr.shutdown();
  });
});

describe('L04/§M — hot-plug, activation et arrêt', () => {
  test('retrait détecté : le port est fermé et retiré des deux ensembles', async () => {
    const mgr = await makeManager();
    await mgr.openPort(DEVICE_PATH, 'UART0');
    const port = mgr.SerialPort.instances[0];
    mgr._scanDevFiles = () => []; // le fichier /dev a disparu

    mgr._checkPortChanges();

    expect(mgr.openPorts.has(DEVICE_PATH)).toBe(false);
    expect(mgr.knownPorts.has(DEVICE_PATH)).toBe(false);
    expect(port.closedCount).toBe(1);
    await mgr.shutdown();
  });

  test('réapparition : seul un port CONFIGURÉ est rouvert automatiquement', async () => {
    const mgr = await makeManager({
      ports: [{ path: DEVICE_PATH, name: 'UART0', direction: 'both', enabled: true }]
    });
    const foreign = path.join(tmpDir, 'ttyUSB0');
    fs.writeFileSync(foreign, '');
    mgr._scanDevFiles = () => [DEVICE_PATH, foreign];

    mgr._checkPortChanges();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(mgr.openPorts.has(DEVICE_PATH)).toBe(true);
    expect(mgr.openPorts.has(foreign)).toBe(false); // jamais pris d'office
    await mgr.shutdown();
  });

  test('F-52 (suite) — désactiver puis réactiver doit remettre le MIDI série en service', async () => {
    const mgr = await makeManager({
      ports: [{ path: DEVICE_PATH, name: 'UART0', direction: 'both', enabled: true }]
    });
    await mgr._openConfiguredPorts();
    mgr.startHotPlugMonitoring();
    expect(mgr.openPorts.size).toBe(1);

    await mgr.setEnabled(false);
    expect(mgr.openPorts.size).toBe(0);
    expect(mgr.hotPlugInterval).toBeNull();

    await mgr.setEnabled(true);

    // Sans correctif : la bibliothèque étant déjà chargée, `setEnabled(true)`
    // ne rouvrait rien et ne relançait pas la surveillance — le MIDI série
    // restait mort jusqu'au redémarrage du serveur.
    expect(mgr.enabled).toBe(true);
    expect(mgr.openPorts.has(DEVICE_PATH)).toBe(true);
    expect(mgr.hotPlugInterval).not.toBeNull();
    await mgr.shutdown();
  });

  test('shutdown ferme tous les ports et stoppe la surveillance', async () => {
    const mgr = await makeManager();
    const second = path.join(tmpDir, 'ttyAMA4');
    fs.writeFileSync(second, '');
    await mgr.openPort(DEVICE_PATH, 'A');
    await mgr.openPort(second, 'B');
    mgr.startHotPlugMonitoring();

    await mgr.shutdown();

    expect(mgr.openPorts.size).toBe(0);
    expect(mgr.hotPlugInterval).toBeNull();
    expect(mgr.SerialPort.instances.every((p) => p.closedCount === 1)).toBe(true);
  });
});
