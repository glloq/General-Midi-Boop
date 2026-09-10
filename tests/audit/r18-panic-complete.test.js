/**
 * @file tests/audit/r18-panic-complete.test.js
 * @description Vague 4 · R18 — **F-45** : le panic n'envoyait jamais CC 121, et
 * il n'existait aucun panic global.
 *
 * Deux défauts, deux preuves :
 *
 * 1. **Contenu.** MIDI 1.0 définit All Notes Off (123) comme ignoré — ou
 *    différé — tant que la pédale de sustain est enfoncée. Un instrument qui
 *    implémente 123 mais pas 120 (le cas courant des firmwares DIY que ce
 *    projet vise) continuait donc de sonner après un panic. Le correctif ajoute
 *    **Reset All Controllers (121)** et le place **avant** 123, faute de quoi
 *    le 123 est jeté avant que le 121 ne déverrouille quoi que ce soit.
 * 2. **Portée.** `midi_panic` exigeait un `deviceId` et, s'il manquait,
 *    adressait littéralement `undefined`. Faire taire un orchestre coûtait N
 *    commandes à travers un limiteur WS plafonné à 60 trames/s.
 *
 * La quatrième section est la **preuve de parité** : les mêmes octets doivent
 * sortir sur les quatre transports. C'est le pendant en émission de la matrice
 * de parité en réception de `l03-transport-parity.test.js` — le lot L03 avait
 * trouvé cinq divergences où les mêmes octets se comportaient différemment
 * selon le câble ; un panic ne doit pas en ajouter une sixième.
 */
import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

import { register as registerMidiCommands } from '../../src/api/commands/MidiCommands.js';
import JsonValidator from '../../src/utils/JsonValidator.js';
import {
  PANIC_CONTROLLERS,
  ALL_NOTES_OFF_CONTROLLERS,
  MIDI_CHANNEL_COUNT,
  buildSilenceSequence,
  silenceSequenceBytes
} from '../../src/midi/messages/SilenceSequence.js';
import DeviceManager from '../../src/midi/devices/DeviceManager.js';
import SerialMidiManager from '../../src/transports/SerialMidiManager.js';
import BluetoothManager from '../../src/transports/BluetoothManager.js';
import InMemoryBleAdapter from '../../src/midi/adapters/InMemoryBleAdapter.js';
import NetworkManager from '../../src/transports/NetworkManager.js';
import RtpMidiSession from '../../src/transports/RtpMidiSession.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** Build the command registry exactly as CommandRegistry would. */
function makeRegistry(app) {
  const handlers = new Map();
  const registry = { register: (name, fn) => handlers.set(name, fn) };
  registerMidiCommands(registry, app);
  return (name, data) => handlers.get(name)(data);
}

// ===========================================================================
// 1. La séquence retenue
// ===========================================================================
describe('R18/F-45 — la séquence de panic', () => {
  test('120 → 121 → 123, dans cet ordre, sur les 16 canaux', () => {
    expect([...PANIC_CONTROLLERS]).toEqual([120, 121, 123]);
    const seq = buildSilenceSequence();
    expect(seq).toHaveLength(48);
    for (let ch = 0; ch < MIDI_CHANNEL_COUNT; ch++) {
      const forCh = seq.filter((m) => m.data.channel === ch);
      expect([ch, forCh.map((m) => m.data.controller)]).toEqual([ch, [120, 121, 123]]);
      expect(forCh.every((m) => m.type === 'cc' && m.data.value === 0)).toBe(true);
    }
  });

  test('121 avant 123 : sans quoi le panic reste un no-op quand la pédale est enfoncée', () => {
    const order = PANIC_CONTROLLERS.indexOf(121) < PANIC_CONTROLLERS.indexOf(123);
    expect(order).toBe(true);
    // Le diff proposé par l'audit suggérait 120 / 123 / 121. Il ajoute bien le
    // 121 manquant, mais trop tard : sur un instrument qui JETTE les note-off
    // reçus pendant que le sustain est verrouillé (la lecture littérale de
    // « All Notes Off est ignoré tant que la pédale est enfoncée »), le 123
    // part dans le vide et le 121 qui suit ne déverrouille qu'une pédale dont
    // les note-off ont déjà été perdus. 121 en premier fonctionne dans les
    // DEUX lectures de la spec, sans contrepartie.
    expect(PANIC_CONTROLLERS.indexOf(121)).toBe(1);
  });

  test('tous les contrôleurs du panic sont >= 120 : exemptés du limiteur ET prioritaires en série', () => {
    // C'est ce qui garantit qu'une rafale de panic n'est jamais tronquée sous
    // charge. C'est aussi la raison pour laquelle un CC 64 = 0 explicite n'est
    // PAS dans la séquence : CC 64 est du trafic ordinaire pour les deux
    // exemptions, donc le seul message que le limiteur laisserait tomber.
    expect(PANIC_CONTROLLERS.every((cc) => cc >= 120)).toBe(true);
    expect(PANIC_CONTROLLERS.includes(64)).toBe(false);
    const serial = Object.create(SerialMidiManager.prototype);
    for (const controller of PANIC_CONTROLLERS) {
      expect([controller, serial._isPrioritySerial('cc', { controller })]).toEqual([
        controller,
        true
      ]);
    }
  });

  test('la variante douce ne touche à aucun contrôleur', () => {
    expect([...ALL_NOTES_OFF_CONTROLLERS]).toEqual([123]);
    expect(buildSilenceSequence(ALL_NOTES_OFF_CONTROLLERS)).toHaveLength(16);
  });

  test('les octets de la rafale sont `Bn cc 00`, 144 octets en tout', () => {
    const bytes = silenceSequenceBytes();
    expect(bytes).toHaveLength(48 * 3);
    for (let i = 0; i < bytes.length; i += 3) {
      expect(bytes[i] & 0xf0).toBe(0xb0);
      expect(bytes[i + 1]).toBeGreaterThanOrEqual(120);
      expect(bytes[i + 2]).toBe(0);
    }
    expect(bytes.slice(0, 9)).toEqual([0xb0, 120, 0, 0xb0, 121, 0, 0xb0, 123, 0]);
    expect(bytes.slice(-9)).toEqual([0xbf, 120, 0, 0xbf, 121, 0, 0xbf, 123, 0]);
  });
});

// ===========================================================================
// 2. Le panic global
// ===========================================================================
describe('R18/F-45 — le panic global', () => {
  let sent, app, call;

  beforeEach(() => {
    sent = [];
    app = {
      deviceManager: {
        sendMessage: jest.fn((device, type, data) => {
          sent.push({ device, type, ...data });
          return true;
        }),
        // Un device de chacun des quatre transports, tel que `getDeviceList()`
        // les agrège réellement, plus deux cas à exclure.
        getDeviceList: () => [
          { id: 'Yamaha P-125', type: 'usb', output: true, input: true, enabled: true },
          { id: 'AA:BB:CC:00:00:01', type: 'bluetooth', output: true, enabled: true },
          { id: '10.0.0.7', type: 'network', output: true, enabled: true },
          { id: '/dev/ttyAMA0', type: 'serial', output: true, enabled: true },
          { id: 'Keystep (IN only)', type: 'usb', output: false, input: true, enabled: true },
          { id: 'Muté par l’opérateur', type: 'usb', output: true, enabled: false }
        ]
      },
      midiRouter: { resetNoteGate: jest.fn() }
    };
    call = makeRegistry(app);
  });

  test('sans deviceId, le panic atteint les quatre transports d’un coup', async () => {
    const res = await call('midi_panic', {});
    expect(res).toEqual({ success: true, targets: 4 });
    expect(new Set(sent.map((m) => m.device))).toEqual(
      new Set(['Yamaha P-125', 'AA:BB:CC:00:00:01', '10.0.0.7', '/dev/ttyAMA0'])
    );
    expect(sent).toHaveLength(4 * 48);
    // Chaque device reçoit la séquence complète, dans l'ordre.
    for (const device of new Set(sent.map((m) => m.device))) {
      const forDev = sent.filter((m) => m.device === device);
      expect([device, forDev.slice(0, 3).map((m) => m.controller)]).toEqual([
        device,
        [120, 121, 123]
      ]);
    }
  });

  test('une entrée seule et un device désactivé ne reçoivent rien', async () => {
    await call('midi_panic', {});
    expect(sent.some((m) => m.device === 'Keystep (IN only)')).toBe(false);
    expect(sent.some((m) => m.device === 'Muté par l’opérateur')).toBe(false);
    expect(sent.some((m) => m.device === undefined)).toBe(false);
  });

  test('avec un deviceId, seul ce device est visé (aucune régression)', async () => {
    const res = await call('midi_panic', { deviceId: '10.0.0.7' });
    expect(res).toEqual({ success: true, targets: 1 });
    expect(new Set(sent.map((m) => m.device))).toEqual(new Set(['10.0.0.7']));
  });

  test('le note-gate du routeur est vidé une seule fois, global ou non', async () => {
    await call('midi_panic', {});
    await call('midi_panic', { deviceId: '10.0.0.7' });
    expect(app.midiRouter.resetNoteGate).toHaveBeenCalledTimes(2);
  });

  test('midi_all_notes_off est global de la même façon, et reste 123 seul', async () => {
    const res = await call('midi_all_notes_off', {});
    expect(res).toEqual({ success: true, targets: 4 });
    expect(sent).toHaveLength(4 * 16);
    expect(new Set(sent.map((m) => m.controller))).toEqual(new Set([123]));
  });

  test('un déploiement sans aucune sortie ne jette pas : targets 0', async () => {
    app.deviceManager.getDeviceList = () => [];
    expect(await call('midi_panic', {})).toEqual({ success: true, targets: 0 });
    expect(sent).toHaveLength(0);
  });

  test('un deviceManager sans getDeviceList ne fait pas tomber le panic global', async () => {
    delete app.deviceManager.getDeviceList;
    expect(await call('midi_panic', {})).toEqual({ success: true, targets: 0 });
  });
});

// ===========================================================================
// 3. Le schéma laisse passer la trame sans deviceId
// ===========================================================================
describe('R18/F-45 — la trame « panic tout » est acceptée par le validateur', () => {
  test.each([
    ['midi_panic', {}],
    ['midi_panic', { deviceId: 'Yamaha P-125' }],
    ['midi_all_notes_off', {}],
    ['midi_all_notes_off', { deviceId: 'Yamaha P-125' }],
    ['midi_reset', {}]
  ])('%s accepte %o', (command, data) => {
    expect(JsonValidator.validateByCommand(command, data)).toEqual({ valid: true, errors: [] });
  });

  test('un deviceId vide reste refusé (ce n’est pas « toutes les sorties »)', () => {
    expect(JsonValidator.validateByCommand('midi_panic', { deviceId: '' }).valid).toBe(false);
  });
});

// ===========================================================================
// 4. Parité : les mêmes octets sur les quatre transports
// ===========================================================================

/** Réplique de l'encodeur de sortie d'easymidi (cf. test de garde plus bas). */
const EASYMIDI_OUTPUT_TYPES = {
  noteoff: 0x08,
  noteon: 0x09,
  'poly aftertouch': 0x0a,
  cc: 0x0b,
  program: 0x0c,
  'channel aftertouch': 0x0d,
  pitch: 0x0e
};
function easymidiEncode(type, args) {
  const bytes = [];
  bytes.push((EASYMIDI_OUTPUT_TYPES[type] << 4) + (args.channel || 0));
  if (type === 'cc') bytes.push(args.controller, args.value);
  return bytes;
}

/** Un DeviceManager sans matériel : seules les cartes de transport comptent. */
function bareManager(deps = {}) {
  return new DeviceManager({
    logger: silentLogger,
    eventBus: { on: () => {}, off: () => {}, emit: () => {} },
    config: { get: () => undefined },
    database: null,
    ...deps
  });
}

describe('R18 — parité de la rafale de panic sur les 4 transports', () => {
  const EXPECTED = silenceSequenceBytes();

  test('USB : easymidi reçoit la séquence et l’encode en Bn cc 00', async () => {
    const calls = [];
    const dm = bareManager();
    dm.outputs.set('USB-DEV', { send: (type, data) => calls.push({ type, data }) });

    const app = { deviceManager: dm, midiRouter: null };
    await makeRegistry(app)('midi_panic', { deviceId: 'USB-DEV' });

    expect(calls).toHaveLength(48);
    const bytes = calls.flatMap(({ type, data }) => easymidiEncode(type, data));
    expect(bytes).toEqual(EXPECTED);
  });

  test('Série : la file d’écriture produit exactement les mêmes octets, en priorité', async () => {
    const written = [];
    const serial = Object.create(SerialMidiManager.prototype);
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

    const dm = bareManager({ serialMidiManager: serial });
    const app = { deviceManager: dm, midiRouter: null };
    await makeRegistry(app)('midi_panic', { deviceId: '/dev/ttyAMA0' });

    expect(written).toEqual(EXPECTED);
    const info = serial.openPorts.get('/dev/ttyAMA0');
    // Rien n'est resté en file : tout est passé par le chemin prioritaire.
    expect(info.writeQueue || []).toHaveLength(0);
    expect(info.droppedWrites || 0).toBe(0);
  });

  test('BLE : les paquets Apple BLE-MIDI contiennent la même séquence MIDI', async () => {
    const port = new InMemoryBleAdapter({
      fixtures: [{ address: 'AA:BB:CC:00:00:01', name: 'Test Synth', isMidiDevice: true }]
    });
    const ble = new BluetoothManager({ logger: silentLogger }, { port });
    await ble._initPromise;
    await port.startDiscovery();
    await ble.connect('AA:BB:CC:00:00:01');

    const dm = bareManager({ bluetoothManager: ble });
    const app = { deviceManager: dm, midiRouter: null };
    await makeRegistry(app)('midi_panic', { deviceId: 'AA:BB:CC:00:00:01' });
    // Les envois BLE sont asynchrones (promesse par trame).
    await new Promise((r) => setTimeout(r, 0));

    // Déballer l'en-tête + l'horodatage de chaque trame BLE-MIDI.
    const midi = [];
    for (const { data } of port._sentMidi) {
      const bytes = Array.from(data);
      expect(bytes[0] & 0x80).toBe(0x80); // en-tête
      expect(bytes[1] & 0x80).toBe(0x80); // horodatage
      midi.push(...bytes.slice(2));
    }
    expect(midi).toEqual(EXPECTED);
    await ble.cleanup();
  });

  test('RTP : les paquets RFC 6295 se re-décodent en la même séquence', async () => {
    const packets = [];
    const session = Object.create(RtpMidiSession.prototype);
    session.state = 'established';
    session.sequenceNumber = 0;
    session.ssrc = 0x11223344;
    session.timestamp = 0;
    session._now10k = () => 0;
    session._sendData = (buf) => packets.push(buf);
    session.isConnected = () => true;

    const nm = Object.create(NetworkManager.prototype);
    nm.logger = silentLogger;
    nm.rtpSessions = new Map([['10.0.0.7', session]]);
    nm.getConnectedDevices = () => [{ ip: '10.0.0.7', name: 'RTP', port: 5004 }];

    const dm = bareManager({ networkManager: nm });
    const app = { deviceManager: dm, midiRouter: null };
    await makeRegistry(app)('midi_panic', { deviceId: '10.0.0.7' });
    await new Promise((r) => setTimeout(r, 0));

    expect(packets).toHaveLength(48);
    // Re-décodage par le parseur réel du produit, pas par une réimplémentation.
    const decoder = Object.create(RtpMidiSession.prototype);
    decoder._rtpRunningStatus = 0;
    const midi = [];
    for (const pkt of packets) {
      const parsed = decoder.parseRtpPacket(pkt);
      expect(parsed.payloadType).toBe(97);
      for (const cmd of parsed.midiCommands) midi.push(...cmd);
    }
    expect(midi).toEqual(EXPECTED);
  });

  test('garde : la réplique de l’encodeur easymidi suit le paquet installé', () => {
    const src = readFileSync(path.join(REPO, 'node_modules/easymidi/index.js'), 'utf8');
    // OUTPUT_TYPES est l'inverse d'INPUT_TYPES, où 0x0B est bien `cc`…
    expect(src).toMatch(/0x0B:\s*'cc'/i);
    expect(src).toMatch(/const OUTPUT_TYPES = swap\(INPUT_TYPES\)/);
    // …le statut est `(nibble << 4) + channel`…
    expect(src).toMatch(/bytes\.push\(\(OUTPUT_TYPES\[type\] << 4\) \+ args\.channel\)/);
    // …et un `cc` pousse controller puis value, dans cet ordre.
    expect(src).toMatch(
      /if \(type === 'cc'\) \{\s*\n\s*bytes\.push\(args\.controller\);\s*\n\s*bytes\.push\(args\.value\);/
    );
  });
});
