// tests/bluetooth-persistence-reconnect.test.js
// Paired BLE devices must persist to the DB (survive a reboot) and be
// auto-reconnected on an UNEXPECTED drop, but not after a deliberate
// disconnect/unpair (audit — paired list was in-memory only, no reconnect).

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import DatabaseManager from '../src/persistence/Database.js';
import BluetoothManager from '../src/transports/BluetoothManager.js';
import InMemoryBleAdapter from '../src/midi/adapters/InMemoryBleAdapter.js';
import { BLE_EVENTS } from '../src/midi/ports/BluetoothPort.js';

const silent = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
const ADDR = 'AA:BB:CC:DD:EE:FF';

let tempDir;
let database;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'gmboop-ble-'));
  database = new DatabaseManager({
    logger: silent,
    config: { database: { path: join(tempDir, 'db.sqlite') } }
  });
});
afterEach(async () => {
  try {
    database.close?.();
  } catch {
    /* ignore */
  }
  rmSync(tempDir, { recursive: true, force: true });
});

function makeManager(port) {
  return new BluetoothManager({ logger: silent, database }, { port });
}

describe('BluetoothManager — persistence + auto-reconnect', () => {
  test('a connected device is persisted and restored by a fresh manager', async () => {
    const port = new InMemoryBleAdapter({ fixtures: [{ address: ADDR, name: 'Boop BLE' }] });
    const m = makeManager(port);
    await port.startDiscovery();
    await m.connect(ADDR);

    const rows = database.bluetoothDB.listPaired();
    expect(rows.map((r) => r.address)).toContain(ADDR);
    await m.cleanup();

    // A brand-new manager (simulating a reboot) restores the paired list.
    const port2 = new InMemoryBleAdapter();
    const m2 = makeManager(port2);
    await m2._restoreAndReconnect();
    expect(m2.getPairedDevices().map((d) => d.address)).toContain(ADDR);
    await m2.cleanup();
  });

  test('unpair removes the device from persistence', async () => {
    const port = new InMemoryBleAdapter({ fixtures: [{ address: ADDR, name: 'Boop' }] });
    const m = makeManager(port);
    await port.startDiscovery();
    await m.connect(ADDR);
    await m.unpair(ADDR);
    expect(database.bluetoothDB.listPaired().map((r) => r.address)).not.toContain(ADDR);
    await m.cleanup();
  });

  test('unexpected drop schedules a reconnect that succeeds', async () => {
    jest.useFakeTimers();
    try {
      const port = new InMemoryBleAdapter({ fixtures: [{ address: ADDR, name: 'Boop' }] });
      const m = makeManager(port);
      await port.startDiscovery();
      await m.connect(ADDR);
      expect(port.isConnected(ADDR)).toBe(true);

      // Simulate an unexpected disconnect (out of range).
      port._connected.delete(ADDR);
      port.emit(BLE_EVENTS.DISCONNECTED, { address: ADDR, unexpected: true });
      expect(m._reconnect.has(ADDR)).toBe(true); // reconnect scheduled

      // Advance past the first backoff (2s) and let the async connect settle.
      await jest.advanceTimersByTimeAsync(2500);
      expect(port.isConnected(ADDR)).toBe(true); // reconnected
      expect(m._reconnect.has(ADDR)).toBe(false); // cleared on success
      await m.cleanup();
    } finally {
      jest.useRealTimers();
    }
  });

  test('a deliberate disconnect does NOT auto-reconnect', async () => {
    const port = new InMemoryBleAdapter({ fixtures: [{ address: ADDR, name: 'Boop' }] });
    const m = makeManager(port);
    await port.startDiscovery();
    await m.connect(ADDR);
    await m.disconnect(ADDR); // deliberate → DISCONNECTED without `unexpected`
    expect(m._reconnect.has(ADDR)).toBe(false);
    await m.cleanup();
  });
});
