// tests/noble-ble-connect-teardown.test.js
// Audit A1 BLE#2: NobleBleAdapter.connect populates `_connections` only on full
// success, so a failure AFTER the BlueZ link opens (GATT discovery,
// characteristic lookup, enabling notifications) must tear the link — and any
// listener already attached — back down. Otherwise a half-open connection
// lingers as a zombie and a `valuechanged` listener leaks. We inject a fake
// adapter/device (no DBus / native binding needed) by marking the adapter ready.

import { describe, test, expect, jest } from '@jest/globals';
import NobleBleAdapter from '../src/midi/adapters/NobleBleAdapter.js';
import { BLE_EVENTS } from '../src/midi/ports/BluetoothPort.js';

function makeAdapter(device) {
  const adapter = new NobleBleAdapter();
  adapter._ready = true; // short-circuit _init() (no D-Bus in tests)
  adapter._adapter = { getDevice: jest.fn().mockResolvedValue(device) };
  jest.spyOn(adapter, 'emit');
  return adapter;
}

describe('NobleBleAdapter.connect — teardown on partial failure (audit BLE#2)', () => {
  test('GATT failure disconnects the link and records no connection', async () => {
    const device = {
      connect: jest.fn().mockResolvedValue(),
      gatt: jest.fn().mockRejectedValue(new Error('gatt boom')),
      disconnect: jest.fn().mockResolvedValue(),
      on: jest.fn(),
      off: jest.fn()
    };
    const adapter = makeAdapter(device);

    await expect(adapter.connect('AA')).rejects.toThrow('gatt boom');
    expect(device.connect).toHaveBeenCalled();
    expect(device.disconnect).toHaveBeenCalled(); // link torn back down
    expect(adapter._connections.has('AA')).toBe(false);
    expect(adapter.emit).not.toHaveBeenCalledWith(BLE_EVENTS.CONNECTED, expect.anything());
  });

  test('startNotifications failure removes the valuechanged listener and disconnects', async () => {
    const characteristic = {
      on: jest.fn(),
      off: jest.fn(),
      startNotifications: jest.fn().mockRejectedValue(new Error('notify boom')),
      stopNotifications: jest.fn().mockResolvedValue()
    };
    const service = { getCharacteristic: jest.fn().mockResolvedValue(characteristic) };
    const gatt = { getPrimaryService: jest.fn().mockResolvedValue(service) };
    const device = {
      connect: jest.fn().mockResolvedValue(),
      gatt: jest.fn().mockResolvedValue(gatt),
      disconnect: jest.fn().mockResolvedValue(),
      on: jest.fn(),
      off: jest.fn()
    };
    const adapter = makeAdapter(device);

    await expect(adapter.connect('BB')).rejects.toThrow('notify boom');
    // The listener was attached, then removed during teardown (same handler ref).
    expect(characteristic.on).toHaveBeenCalledWith('valuechanged', expect.any(Function));
    expect(characteristic.off).toHaveBeenCalledWith('valuechanged', expect.any(Function));
    expect(device.disconnect).toHaveBeenCalled();
    expect(adapter._connections.has('BB')).toBe(false);
    expect(adapter.emit).not.toHaveBeenCalledWith(BLE_EVENTS.CONNECTED, expect.anything());
  });

  test('a fully successful connect still records the connection and emits CONNECTED', async () => {
    const characteristic = {
      on: jest.fn(),
      off: jest.fn(),
      startNotifications: jest.fn().mockResolvedValue(),
      stopNotifications: jest.fn().mockResolvedValue()
    };
    const service = { getCharacteristic: jest.fn().mockResolvedValue(characteristic) };
    const gatt = { getPrimaryService: jest.fn().mockResolvedValue(service) };
    const device = {
      connect: jest.fn().mockResolvedValue(),
      gatt: jest.fn().mockResolvedValue(gatt),
      disconnect: jest.fn().mockResolvedValue(),
      on: jest.fn(),
      off: jest.fn()
    };
    const adapter = makeAdapter(device);

    await adapter.connect('CC');
    expect(adapter._connections.has('CC')).toBe(true);
    expect(device.disconnect).not.toHaveBeenCalled();
    expect(adapter.emit).toHaveBeenCalledWith(BLE_EVENTS.CONNECTED, { address: 'CC' });
  });
});
