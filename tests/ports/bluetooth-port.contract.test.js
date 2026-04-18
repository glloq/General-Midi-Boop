// tests/ports/bluetooth-port.contract.test.js
// Contract test for BluetoothPort (P1-4.5).
// Any adapter implementing the port must satisfy these expectations.
// Today only InMemoryBleAdapter is exercised — when NobleBleAdapter
// arrives in a follow-up lot it will be added to the `adapters` array
// and the same suite will run against it (without modification).

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import InMemoryBleAdapter from '../../src/midi/adapters/InMemoryBleAdapter.js';
import NobleBleAdapter from '../../src/midi/adapters/NobleBleAdapter.js';
import { BLE_EVENTS, BLE_PORT_METHODS } from '../../src/midi/ports/BluetoothPort.js';

const FIXTURES = [
  { address: 'AA:BB:CC:00:00:01', name: 'Test Synth' },
  { address: 'AA:BB:CC:00:00:02', name: 'Test Pad', rssi: -52 }
];

const adapters = [
  ['InMemoryBleAdapter', () => new InMemoryBleAdapter({ fixtures: FIXTURES })]
];

describe.each(adapters)('BluetoothPort contract — %s', (_name, factory) => {
  let adapter;

  beforeEach(() => {
    adapter = factory();
  });

  afterEach(async () => {
    await adapter.dispose();
  });

  test('exposes the full port surface', () => {
    for (const method of BLE_PORT_METHODS) {
      expect(typeof adapter[method]).toBe('function');
    }
  });

  test('startDiscovery surfaces fixtures via device-discovered events', async () => {
    const seen = [];
    adapter.on(BLE_EVENTS.DEVICE_DISCOVERED, (dev) => seen.push(dev));
    await adapter.startDiscovery();
    expect(seen).toHaveLength(FIXTURES.length);
    expect(adapter.listDiscovered()).toHaveLength(FIXTURES.length);
  });

  test('connect emits "connected" and updates isConnected()', async () => {
    await adapter.startDiscovery();
    const connected = [];
    adapter.on(BLE_EVENTS.CONNECTED, (e) => connected.push(e.address));

    await adapter.connect(FIXTURES[0].address);

    expect(connected).toEqual([FIXTURES[0].address]);
    expect(adapter.isConnected(FIXTURES[0].address)).toBe(true);
  });

  test('connect on undiscovered device rejects', async () => {
    await expect(adapter.connect('FF:FF:FF:FF:FF:FF')).rejects.toThrow(/not discovered/);
  });

  test('disconnect emits "disconnected" and clears state', async () => {
    await adapter.startDiscovery();
    await adapter.connect(FIXTURES[0].address);
    const disconnected = [];
    adapter.on(BLE_EVENTS.DISCONNECTED, (e) => disconnected.push(e.address));

    await adapter.disconnect(FIXTURES[0].address);

    expect(disconnected).toEqual([FIXTURES[0].address]);
    expect(adapter.isConnected(FIXTURES[0].address)).toBe(false);
  });

  test('sendMidi requires connected device and Uint8Array payload', async () => {
    await adapter.startDiscovery();
    await adapter.connect(FIXTURES[0].address);

    await expect(
      adapter.sendMidi(FIXTURES[0].address, new Uint8Array([0x90, 60, 100]))
    ).resolves.toBeUndefined();

    await expect(
      adapter.sendMidi(FIXTURES[1].address, new Uint8Array([0x80, 60, 0]))
    ).rejects.toThrow(/not connected/);

    await expect(
      adapter.sendMidi(FIXTURES[0].address, [0x90, 60, 100])
    ).rejects.toThrow(/Uint8Array/);
  });

  test('dispose makes the adapter inert', async () => {
    await adapter.dispose();
    await expect(adapter.startDiscovery()).rejects.toThrow(/disposed/);
  });
});

describe('NobleBleAdapter — surface (no hardware)', () => {
  test('exposes the full port surface without initialising D-Bus', () => {
    const adapter = new NobleBleAdapter({ logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } });
    for (const method of BLE_PORT_METHODS) {
      expect(typeof adapter[method]).toBe('function');
    }
    // dispose is safe before any init.
    return adapter.dispose();
  });

  test('sendMidi rejects non-Uint8Array input before connection check', async () => {
    const adapter = new NobleBleAdapter();
    await expect(adapter.sendMidi('AA:BB:CC:00:00:01', [0x90, 60, 100]))
      .rejects.toThrow(/Uint8Array/);
    await adapter.dispose();
  });
});

describe('InMemoryBleAdapter — test helpers', () => {
  test('_injectIncoming surfaces midi-message only when connected', async () => {
    const adapter = new InMemoryBleAdapter({ fixtures: FIXTURES });
    const messages = [];
    adapter.on(BLE_EVENTS.MIDI_MESSAGE, (e) => messages.push(e));

    // Not connected yet → no message emitted
    adapter._injectIncoming(FIXTURES[0].address, [0x90, 60, 100]);
    expect(messages).toHaveLength(0);

    await adapter.startDiscovery();
    await adapter.connect(FIXTURES[0].address);

    adapter._injectIncoming(FIXTURES[0].address, [0x90, 60, 100]);
    expect(messages).toHaveLength(1);
    expect(messages[0].address).toBe(FIXTURES[0].address);
    expect(Array.from(messages[0].data)).toEqual([0x90, 60, 100]);

    await adapter.dispose();
  });

  test('_getSentMidi exposes sent packets in order', async () => {
    const adapter = new InMemoryBleAdapter({ fixtures: FIXTURES });
    await adapter.startDiscovery();
    await adapter.connect(FIXTURES[0].address);
    await adapter.sendMidi(FIXTURES[0].address, new Uint8Array([0x90, 60, 100]));
    await adapter.sendMidi(FIXTURES[0].address, new Uint8Array([0x80, 60, 0]));
    const sent = adapter._getSentMidi();
    expect(sent).toHaveLength(2);
    expect(Array.from(sent[0].data)).toEqual([0x90, 60, 100]);
    expect(Array.from(sent[1].data)).toEqual([0x80, 60, 0]);
    await adapter.dispose();
  });
});
