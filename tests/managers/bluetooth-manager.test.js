// tests/managers/bluetooth-manager.test.js
// Unit tests for BluetoothManager (P1-4.5c.6) running against the
// InMemoryBleAdapter — no D-Bus, no hardware.

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import BluetoothManager from '../../src/managers/BluetoothManager.js';
import InMemoryBleAdapter from '../../src/midi/adapters/InMemoryBleAdapter.js';

const FIXTURES = [
  { address: 'AA:BB:CC:00:00:01', name: 'Test Synth', rssi: -40, uuids: ['03b80e5a-ede8-4b33-a751-6ce34ec4c700'], isMidiDevice: true },
  { address: 'AA:BB:CC:00:00:02', name: 'Test Pad',   rssi: -70, uuids: [], isMidiDevice: false }
];

function makeApp() {
  return {
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    }
  };
}

describe('BluetoothManager — construction + power events', () => {
  test('emits bluetooth:powered_on when port initialises', async () => {
    const port = new InMemoryBleAdapter({ fixtures: FIXTURES });
    const events = [];
    const app = makeApp();
    const mgr = new BluetoothManager(app, { port });
    mgr.on('bluetooth:powered_on', () => events.push('on'));
    await mgr._initPromise;
    expect(events).toEqual(['on']);
    await mgr.cleanup();
  });

  test('getStatus reports initial values', async () => {
    const port = new InMemoryBleAdapter({ fixtures: FIXTURES });
    const mgr = new BluetoothManager(makeApp(), { port });
    await mgr._initPromise;
    const status = mgr.getStatus();
    expect(status.scanning).toBe(false);
    expect(status.devicesFound).toBe(0);
    expect(status.connectedDevices).toBe(0);
    expect(status.pairedDevices).toBe(0);
    await mgr.cleanup();
  });
});

describe('BluetoothManager — scan', () => {
  let port, mgr;

  beforeEach(() => {
    port = new InMemoryBleAdapter({ fixtures: FIXTURES });
    mgr = new BluetoothManager(makeApp(), { port });
  });

  afterEach(async () => {
    await mgr.cleanup();
  });

  test('startScan populates devices from fixtures', async () => {
    const devices = await mgr.startScan(0 /* instant */, '');
    expect(devices).toHaveLength(2);
    expect(devices.map((d) => d.address).sort()).toEqual(FIXTURES.map((f) => f.address).sort());
    expect(mgr.getStatus().devicesFound).toBe(2);
  });

  test('startScan enriches devices with signal percent', async () => {
    const devices = await mgr.startScan(0, '');
    const synth = devices.find((d) => d.address === FIXTURES[0].address);
    expect(synth.rssi).toBe(-40);
    expect(synth.signal).toBeGreaterThan(80); // -40 is strong
    expect(synth.isMidiDevice).toBe(true);
    expect(synth.serviceUuids).toEqual(FIXTURES[0].uuids);
  });

  test('startScan name filter applies case-insensitively', async () => {
    const devices = await mgr.startScan(0, 'pad');
    expect(devices.map((d) => d.name)).toEqual(['Test Pad']);
  });

  test('startScan throws if already scanning', async () => {
    // Use a 50ms scan so the second call sees `scanning=true`.
    const first = mgr.startScan(0.05);
    // Yield one microtask so the first scan sets this.scanning=true.
    await Promise.resolve();
    await expect(mgr.startScan(0)).rejects.toThrow(/already in progress/);
    await first;
  });
});

describe('BluetoothManager — connect / disconnect', () => {
  let port, mgr;

  beforeEach(async () => {
    port = new InMemoryBleAdapter({ fixtures: FIXTURES });
    mgr = new BluetoothManager(makeApp(), { port });
    await mgr.startScan(0);
  });

  afterEach(async () => {
    await mgr.cleanup();
  });

  test('connect delegates to port and returns device info', async () => {
    const result = await mgr.connect(FIXTURES[0].address);
    expect(result).toEqual({
      address: FIXTURES[0].address,
      name: FIXTURES[0].name,
      connected: true
    });
    expect(mgr.isConnected(FIXTURES[0].address)).toBe(true);
    expect(port.isConnected(FIXTURES[0].address)).toBe(true);
  });

  test('connect emits bluetooth:connected with the expected payload', async () => {
    const events = [];
    mgr.on('bluetooth:connected', (e) => events.push(e));
    await mgr.connect(FIXTURES[0].address);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      address: FIXTURES[0].address,
      device_id: FIXTURES[0].address,
      name: FIXTURES[0].name
    });
  });

  test('connect populates pairedDevices with connected=true', async () => {
    await mgr.connect(FIXTURES[0].address);
    const paired = mgr.getPairedDevices();
    expect(paired).toHaveLength(1);
    expect(paired[0].address).toBe(FIXTURES[0].address);
    expect(paired[0].connected).toBe(true);
  });

  test('disconnect releases the device and emits the event', async () => {
    await mgr.connect(FIXTURES[0].address);
    const events = [];
    mgr.on('bluetooth:disconnected', (e) => events.push(e));

    await mgr.disconnect(FIXTURES[0].address);

    expect(mgr.isConnected(FIXTURES[0].address)).toBe(false);
    expect(events).toEqual([{
      address: FIXTURES[0].address,
      device_id: FIXTURES[0].address
    }]);
    const paired = mgr.getPairedDevices().find((d) => d.address === FIXTURES[0].address);
    expect(paired.connected).toBe(false);
  });

  test('disconnect throws when the device is not connected', async () => {
    await expect(mgr.disconnect(FIXTURES[1].address)).rejects.toThrow(/not connected/);
  });
});

describe('BluetoothManager — send MIDI', () => {
  let port, mgr;

  beforeEach(async () => {
    port = new InMemoryBleAdapter({ fixtures: FIXTURES });
    mgr = new BluetoothManager(makeApp(), { port });
    await mgr.startScan(0);
    await mgr.connect(FIXTURES[0].address);
  });

  afterEach(async () => {
    await mgr.cleanup();
  });

  test('sendMidiData wraps the payload in a BLE MIDI frame and forwards it', async () => {
    await mgr.sendMidiData(FIXTURES[0].address, [0x90, 60, 100]);
    const sent = port._getSentMidi();
    expect(sent).toHaveLength(1);
    const bytes = Array.from(sent[0].data);
    // [headerByte, timestampByte, status, note, velocity]
    expect(bytes).toHaveLength(5);
    expect(bytes[0] & 0x80).toBe(0x80);   // header bit 7 set
    expect(bytes[1] & 0x80).toBe(0x80);   // timestamp bit 7 set
    expect(bytes.slice(2)).toEqual([0x90, 60, 100]);
  });

  test('sendMidiMessage converts an easymidi descriptor to bytes', async () => {
    await mgr.sendMidiMessage(FIXTURES[0].address, 'noteon', {
      channel: 0, note: 60, velocity: 100
    });
    const sent = port._getSentMidi();
    expect(sent).toHaveLength(1);
    const bytes = Array.from(sent[0].data);
    expect(bytes.slice(2)).toEqual([0x90, 60, 100]);
  });

  test('sendMidiData rejects when the device is not connected', async () => {
    await expect(
      mgr.sendMidiData(FIXTURES[1].address, [0x90, 60, 100])
    ).rejects.toThrow(/not connected/);
  });
});

describe('BluetoothManager — incoming MIDI forwarding', () => {
  test('parses an Apple BLE-MIDI packet and emits midi:data per message', async () => {
    const port = new InMemoryBleAdapter({ fixtures: FIXTURES });
    const mgr = new BluetoothManager(makeApp(), { port });
    await mgr.startScan(0);
    await mgr.connect(FIXTURES[0].address);

    const events = [];
    mgr.on('midi:data', (e) => events.push(e));

    // header | timestamp | 0x90 60 100 (noteOn)
    const packet = [0x80, 0x80, 0x90, 60, 100];
    port._injectIncoming(FIXTURES[0].address, packet);

    expect(events).toHaveLength(1);
    expect(events[0].address).toBe(FIXTURES[0].address);
    expect(events[0].data).toEqual([0x90, 60, 100]);

    await mgr.cleanup();
  });
});

describe('BluetoothManager — unpair / forget', () => {
  test('forget() disconnects + removes from pairedDevices', async () => {
    const port = new InMemoryBleAdapter({ fixtures: FIXTURES });
    const mgr = new BluetoothManager(makeApp(), { port });
    await mgr.startScan(0);
    await mgr.connect(FIXTURES[0].address);

    const events = [];
    mgr.on('bluetooth:unpaired', (e) => events.push(e));

    await mgr.forget(FIXTURES[0].address);

    expect(events).toEqual([{ address: FIXTURES[0].address }]);
    expect(mgr.getPairedDevices()).toHaveLength(0);
    expect(mgr.isConnected(FIXTURES[0].address)).toBe(false);

    await mgr.cleanup();
  });
});

describe('BluetoothManager — cleanup', () => {
  test('cleanup disconnects all devices and disposes the port', async () => {
    const port = new InMemoryBleAdapter({ fixtures: FIXTURES });
    const mgr = new BluetoothManager(makeApp(), { port });
    await mgr.startScan(0);
    await mgr.connect(FIXTURES[0].address);

    await mgr.cleanup();

    // Port disposed → any further op throws
    await expect(port.startDiscovery()).rejects.toThrow(/disposed/);
  });
});

describe('BluetoothManager — power-off propagation', () => {
  test('port powered-off translates to bluetooth:powered_off', async () => {
    const port = new InMemoryBleAdapter({ fixtures: FIXTURES });
    const mgr = new BluetoothManager(makeApp(), { port });
    await mgr._initPromise;

    const events = [];
    mgr.on('bluetooth:powered_off', (e) => events.push(e));

    port.emit('powered-off', { reason: 'test-off' });
    expect(events).toEqual([{ error: 'test-off' }]);

    await mgr.cleanup();
  });
});
