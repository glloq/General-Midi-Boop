// tests/transports/l04-ble-connection-state.test.js
//
// Lot L04 — §L (BLE MIDI) : la MACHINE À ÉTATS DE CONNEXION.
// Le codec BLE-MIDI est déjà couvert (`ble-midi-encode` / `ble-midi-decode`) ;
// ce qui ne l'était pas, c'est le cycle de vie : refus de connexion, expiration,
// coupure en plein flux, back-off de reconnexion, épuisement, fuite de timers
// et d'écouteurs après N cycles.
//
// Aucun D-Bus, aucune radio : `InMemoryBleAdapter` est le port de test fourni
// par le projet lui-même.

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import BluetoothManager from '../../src/transports/BluetoothManager.js';
import InMemoryBleAdapter from '../../src/midi/adapters/InMemoryBleAdapter.js';
import { BLE_EVENTS } from '../../src/midi/ports/BluetoothPort.js';

const ADDR = 'AA:BB:CC:00:00:01';
const FIXTURES = [
  {
    address: ADDR,
    name: 'Test Synth',
    rssi: -40,
    uuids: ['03b80e5a-ede8-4b33-a751-6ce34ec4c700'],
    isMidiDevice: true
  }
];

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeManager(port, logger = silentLogger) {
  return new BluetoothManager({ logger }, { port });
}

/** Trame BLE-MIDI : en-tête + horodatage + octets MIDI. */
function blePacket(ts13, bytes) {
  return Uint8Array.from([0x80 | ((ts13 >> 7) & 0x3f), 0x80 | (ts13 & 0x7f), ...bytes]);
}

describe('L04/§L — refus et expiration de connexion', () => {
  test('connexion refusée par le périphérique : rejet propre, aucun état résiduel', async () => {
    const port = new InMemoryBleAdapter({ fixtures: FIXTURES });
    const mgr = makeManager(port);
    await mgr._initPromise;
    const connected = [];
    mgr.on('bluetooth:connected', (e) => connected.push(e));

    // Non découvert → l'adaptateur refuse (équivalent d'un GATT refusé).
    await expect(mgr.connect('FF:FF:FF:FF:FF:FF')).rejects.toThrow(/not discovered/);

    expect(connected).toHaveLength(0);
    expect(mgr.connectedDevices.size).toBe(0);
    expect(mgr.getPairedDevices()).toHaveLength(0);
    expect(mgr.isConnected('FF:FF:FF:FF:FF:FF')).toBe(false);
    await mgr.cleanup();
  });

  test('périphérique qui ne répond jamais : expiration à 15 s + libération du lien', async () => {
    jest.useFakeTimers();
    try {
      const port = new InMemoryBleAdapter({ fixtures: FIXTURES });
      const disconnects = [];
      port.connect = () => new Promise(() => {}); // GATT qui ne rend jamais la main
      port.disconnect = async (a) => disconnects.push(a);
      const mgr = makeManager(port);
      await mgr._initPromise;

      const attempt = mgr.connect(ADDR);
      const assertion = expect(attempt).rejects.toThrow(/BLE connect timeout after 15000ms/);
      await jest.advanceTimersByTimeAsync(15001);
      await assertion;

      // Le lien semi-ouvert est refermé au lieu d'être abandonné.
      expect(disconnects).toEqual([ADDR]);
      expect(mgr.connectedDevices.size).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('L04/§L — coupure en plein flux', () => {
  let port, mgr, midi;

  beforeEach(async () => {
    port = new InMemoryBleAdapter({ fixtures: FIXTURES });
    mgr = makeManager(port);
    await mgr._initPromise;
    midi = [];
    mgr.on('midi:data', (e) => midi.push(e.data));
    await mgr.startScan(0);
    await mgr.connect(ADDR);
  });

  afterEach(async () => {
    await mgr.cleanup();
  });

  test('la déconnexion coupe l’arrivée des messages et met à jour l’état', async () => {
    port._injectIncoming(ADDR, blePacket(1, [0x90, 0x3c, 0x40]));
    expect(midi).toHaveLength(1);

    await mgr.disconnect(ADDR);

    expect(mgr.connectedDevices.has(ADDR)).toBe(false);
    expect(mgr.isConnected(ADDR)).toBe(false);
    port._injectIncoming(ADDR, blePacket(2, [0x90, 0x3e, 0x40])); // ignoré : non connecté
    expect(midi).toHaveLength(1);
    // Un envoi vers un device déconnecté échoue explicitement.
    await expect(mgr.sendMidiData(ADDR, [0x90, 0x3c, 0x40])).rejects.toThrow(/not connected/);
  });

  test('F-53 — un SysEx interrompu par la déconnexion ne doit pas contaminer la session suivante', async () => {
    // SysEx entamé, jamais terminé : le câble/la radio tombe au milieu.
    port._injectIncoming(ADDR, Uint8Array.from([0x80, 0x81, 0xf0, 0x41, 0x10]));
    expect(midi).toHaveLength(0); // pas encore de F7

    port.emit(BLE_EVENTS.DISCONNECTED, { address: ADDR, unexpected: true });
    await mgr.connect(ADDR);
    midi.length = 0;

    // Nouvelle session : le périphérique envoie la FIN d'un autre SysEx.
    port._injectIncoming(ADDR, Uint8Array.from([0x80, 0x42, 0x43, 0x81, 0xf7]));

    // Sans purge de l'état de réassemblage, les octets d'avant la coupure sont
    // recollés à ceux d'après et un message qui n'a jamais existé est émis.
    expect(midi.flat()).not.toEqual(expect.arrayContaining([0x41, 0x10]));
  });

  test('une déconnexion inattendue déclenche une reconnexion, une volontaire non', async () => {
    jest.useFakeTimers();
    try {
      port.emit(BLE_EVENTS.DISCONNECTED, { address: ADDR, unexpected: false });
      expect(mgr._reconnect.size).toBe(0);

      port.emit(BLE_EVENTS.DISCONNECTED, { address: ADDR, unexpected: true });
      expect(mgr._reconnect.get(ADDR).attempts).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('L04/§L — back-off, épuisement et fuites', () => {
  test('back-off 2/4/8/16/30 s puis abandon — sans aucun événement pour l’opérateur', async () => {
    jest.useFakeTimers();
    try {
      const port = new InMemoryBleAdapter({ fixtures: FIXTURES });
      const mgr = makeManager(port);
      await mgr._initPromise;
      await mgr.startScan(0);
      await mgr.connect(ADDR);

      const attempts = [];
      port.connect = async () => {
        attempts.push(Date.now());
        throw new Error('out of range');
      };
      const events = [];
      for (const e of [
        'bluetooth:disconnected',
        'bluetooth:reconnect_exhausted',
        'bluetooth:error'
      ])
        mgr.on(e, (p) => events.push({ e, p }));

      const t0 = Date.now();
      port.emit(BLE_EVENTS.DISCONNECTED, { address: ADDR, unexpected: true });
      for (const delay of [2000, 4000, 8000, 16000, 30000]) {
        await jest.advanceTimersByTimeAsync(delay + 1);
      }

      expect(attempts.map((t) => t - t0)).toEqual([2000, 6000, 14000, 30000, 60000]);
      // Épuisement : plus aucun timer armé, l'état est purgé…
      expect(mgr._reconnect.size).toBe(0);
      await jest.advanceTimersByTimeAsync(120000);
      expect(attempts).toHaveLength(5);
      // …mais rien n'est publié : l'UI ne peut pas afficher « appareil perdu ».
      expect(events.filter((x) => x.e !== 'bluetooth:disconnected')).toHaveLength(0);

      await mgr.cleanup();
    } finally {
      jest.useRealTimers();
    }
  });

  test('une reconnexion réussie annule le back-off et remet le compteur à zéro', async () => {
    jest.useFakeTimers();
    try {
      const port = new InMemoryBleAdapter({ fixtures: FIXTURES });
      const mgr = makeManager(port);
      await mgr._initPromise;
      await mgr.startScan(0);
      await mgr.connect(ADDR);

      port.emit(BLE_EVENTS.DISCONNECTED, { address: ADDR, unexpected: true });
      expect(mgr._reconnect.get(ADDR).attempts).toBe(1);
      await jest.advanceTimersByTimeAsync(2001);

      expect(mgr._reconnect.size).toBe(0); // annulé par l'événement CONNECTED
      expect(mgr.isConnected(ADDR)).toBe(true);
      await mgr.cleanup();
    } finally {
      jest.useRealTimers();
    }
  });

  test('50 cycles déconnexion/reconnexion : aucun timer, écouteur ou doublon résiduel', async () => {
    jest.useFakeTimers();
    try {
      const port = new InMemoryBleAdapter({ fixtures: FIXTURES });
      const mgr = makeManager(port);
      await mgr._initPromise;
      await mgr.startScan(0);
      await mgr.connect(ADDR);
      const listenersBefore = port.eventNames().map((n) => port.listenerCount(n));
      const timersBefore = jest.getTimerCount();

      for (let i = 0; i < 50; i++) {
        port.emit(BLE_EVENTS.DISCONNECTED, { address: ADDR, unexpected: true });
        await jest.advanceTimersByTimeAsync(2001); // reconnexion au 1er essai
      }

      expect(mgr.isConnected(ADDR)).toBe(true);
      expect(mgr._reconnect.size).toBe(0);
      expect(jest.getTimerCount()).toBe(timersBefore);
      expect(port.eventNames().map((n) => port.listenerCount(n))).toEqual(listenersBefore);
      expect(mgr.pairedDevices).toHaveLength(1); // aucun doublon accumulé
      expect(mgr.connectedDevices.size).toBe(1);
      await mgr.cleanup();
    } finally {
      jest.useRealTimers();
    }
  });

  test('cleanup annule les reconnexions en attente', async () => {
    jest.useFakeTimers();
    try {
      const port = new InMemoryBleAdapter({ fixtures: FIXTURES });
      const mgr = makeManager(port);
      await mgr._initPromise;
      await mgr.startScan(0);
      await mgr.connect(ADDR);
      const attempts = [];
      port.connect = async () => attempts.push(1);

      port.emit(BLE_EVENTS.DISCONNECTED, { address: ADDR, unexpected: true });
      expect(mgr._reconnect.size).toBe(1);
      await mgr.cleanup();
      await jest.advanceTimersByTimeAsync(60000);

      expect(attempts).toHaveLength(0);
      expect(mgr._reconnect.size).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('L04/§L — trames entrantes : horodatage, messages multiples, running status', () => {
  let port, mgr, midi;

  beforeEach(async () => {
    port = new InMemoryBleAdapter({ fixtures: FIXTURES });
    mgr = makeManager(port);
    await mgr._initPromise;
    midi = [];
    mgr.on('midi:data', (e) => midi.push(e.data));
    await mgr.startScan(0);
    await mgr.connect(ADDR);
  });

  afterEach(async () => {
    await mgr.cleanup();
  });

  test('un paquet portant plusieurs messages horodatés les émet tous, dans l’ordre', () => {
    port._injectIncoming(
      ADDR,
      Uint8Array.from([
        0x80, 0x81, 0x90, 0x3c, 0x40, 0x82, 0x80, 0x3c, 0x00, 0x83, 0xb0, 0x07, 0x64
      ])
    );
    expect(midi).toEqual([
      [0x90, 0x3c, 0x40],
      [0x80, 0x3c, 0x00],
      [0xb0, 0x07, 0x64]
    ]);
  });

  test('running status BLE : avec ou sans horodatage intercalé', () => {
    port._injectIncoming(ADDR, Uint8Array.from([0x80, 0x81, 0x90, 0x3c, 0x40, 0x3e, 0x40]));
    expect(midi).toEqual([
      [0x90, 0x3c, 0x40],
      [0x90, 0x3e, 0x40]
    ]);

    midi.length = 0;
    port._injectIncoming(ADDR, Uint8Array.from([0x80, 0x81, 0x90, 0x3c, 0x40, 0x82, 0x40, 0x40]));
    expect(midi).toEqual([
      [0x90, 0x3c, 0x40],
      [0x90, 0x40, 0x40]
    ]);
  });

  test('le running status NE traverse PAS la frontière de paquet (spec Apple BLE-MIDI)', () => {
    port._injectIncoming(ADDR, Uint8Array.from([0x80, 0x81, 0x90, 0x3c, 0x40]));
    midi.length = 0;
    port._injectIncoming(ADDR, Uint8Array.from([0x80, 0x81, 0x3e, 0x40])); // données seules
    expect(midi).toEqual([]); // correctement ignoré, pas de note fantôme
  });

  test('F-48 — un horodatage dont les bits bas valent 0x78-0x7F ne doit pas être lu comme du temps réel', () => {
    // ts & 0x7F === 0x7F ⇒ octet d'horodatage 0xFF, identique au System Reset.
    port._injectIncoming(ADDR, blePacket(127, [0x90, 0x3c, 0x40]));
    // ts & 0x7F === 0x78 ⇒ 0xF8, identique au MIDI Clock.
    port._injectIncoming(ADDR, blePacket(120, [0xb0, 0x07, 0x64]));
    expect(midi).toEqual([
      [0x90, 0x3c, 0x40],
      [0xb0, 0x07, 0x64]
    ]);
    // Aucun message temps réel fantôme n'a été injecté.
    expect(midi.some((m) => m.length === 1 && m[0] >= 0xf8)).toBe(false);
  });

  test('un vrai message temps réel (précédé de son horodatage) reste émis', () => {
    port._injectIncoming(ADDR, Uint8Array.from([0x80, 0x81, 0xf8, 0x82, 0x90, 0x3c, 0x40]));
    expect(midi).toEqual([[0xf8], [0x90, 0x3c, 0x40]]);
  });

  test('horodatage BLE qui RECULE (bouclage 13 bits) : aucun message perdu ni réordonné', () => {
    port._injectIncoming(ADDR, blePacket(8190, [0x90, 0x3c, 0x40]));
    port._injectIncoming(ADDR, blePacket(3, [0x90, 0x3e, 0x40])); // wrap : 8190 → 3
    port._injectIncoming(ADDR, blePacket(0, [0x80, 0x3c, 0x00])); // recul franc
    expect(midi).toEqual([
      [0x90, 0x3c, 0x40],
      [0x90, 0x3e, 0x40],
      [0x80, 0x3c, 0x00]
    ]);
  });

  test('en-tête invalide (bit 7 à 0) : paquet rejeté sans exception', () => {
    port._injectIncoming(ADDR, Uint8Array.from([0x00, 0x81, 0x90, 0x3c, 0x40]));
    port._injectIncoming(ADDR, Uint8Array.from([0x80])); // trop court
    expect(midi).toEqual([]);
  });

  test('émission : l’horodatage encodé tient sur 13 bits et boucle sans casser la trame', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date(8191)); // now % 8192 === 8191
      const [last] = BluetoothManager.encodeBleMidiPackets([0x90, 0x3c, 0x40]);
      expect(((last[0] & 0x3f) << 7) | (last[1] & 0x7f)).toBe(8191);

      jest.setSystemTime(new Date(8192)); // bouclage → 0
      const [wrapped] = BluetoothManager.encodeBleMidiPackets([0x90, 0x3c, 0x40]);
      expect(((wrapped[0] & 0x3f) << 7) | (wrapped[1] & 0x7f)).toBe(0);
      // Les deux octets de tête gardent leur bit 7 : la trame reste valide.
      expect(wrapped[0] & 0x80).toBe(0x80);
      expect(wrapped[1] & 0x80).toBe(0x80);
      expect(Array.from(wrapped.slice(2))).toEqual([0x90, 0x3c, 0x40]);
    } finally {
      jest.useRealTimers();
    }
  });
});
