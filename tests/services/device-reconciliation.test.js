// tests/services/device-reconciliation.test.js
// Unit tests for DeviceReconciliationService.resolveSettings (P1-4.2).
// Covers the settings → USB serial → MAC → normalized-name fallback cascade.

import { jest, describe, test, expect } from '@jest/globals';
import DeviceReconciliationService from '../../src/midi/domain/devices/DeviceReconciliationService.js';

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function makeRepo(overrides = {}) {
  return {
    getAllSettings: jest.fn().mockReturnValue(null),
    findByUsbSerial: jest.fn().mockReturnValue(null),
    findByMac: jest.fn().mockReturnValue(null),
    findByNormalizedName: jest.fn().mockReturnValue(null),
    reconcileDeviceId: jest.fn(),
    ...overrides
  };
}

describe('resolveSettings — primary lookup', () => {
  test('returns settings when getAllSettings finds a match on device.id', () => {
    const repo = makeRepo({
      getAllSettings: jest.fn().mockReturnValue({ custom_name: 'Piano' })
    });
    const svc = new DeviceReconciliationService({ instrumentRepository: repo, logger: silentLogger() });
    const out = svc.resolveSettings({ id: 'usb-port-0' });
    expect(out).toEqual({ custom_name: 'Piano' });
    expect(repo.getAllSettings).toHaveBeenCalledWith('usb-port-0');
    expect(repo.findByUsbSerial).not.toHaveBeenCalled();
  });

  test('returns null when no fallback matches', () => {
    const repo = makeRepo();
    const svc = new DeviceReconciliationService({ instrumentRepository: repo, logger: silentLogger() });
    expect(svc.resolveSettings({ id: 'unknown' })).toBeNull();
  });
});

describe('resolveSettings — USB serial fallback', () => {
  test('reconciles and re-fetches when serial matches a different device_id', () => {
    const repo = makeRepo({
      getAllSettings: jest.fn()
        .mockReturnValueOnce(null)
        .mockReturnValueOnce({ custom_name: 'Found' }),
      findByUsbSerial: jest.fn().mockReturnValue({ device_id: 'old-usb-id' })
    });
    const svc = new DeviceReconciliationService({ instrumentRepository: repo, logger: silentLogger() });
    const out = svc.resolveSettings({ id: 'new-usb-id', usbSerialNumber: '123' });
    expect(out).toEqual({ custom_name: 'Found' });
    expect(repo.findByUsbSerial).toHaveBeenCalledWith('123');
    expect(repo.reconcileDeviceId).toHaveBeenCalledWith('old-usb-id', 'new-usb-id');
    expect(repo.getAllSettings).toHaveBeenCalledTimes(2);
  });

  test('does nothing when serial match points to the same device_id', () => {
    const repo = makeRepo({
      findByUsbSerial: jest.fn().mockReturnValue({ device_id: 'same-id' })
    });
    const svc = new DeviceReconciliationService({ instrumentRepository: repo, logger: silentLogger() });
    svc.resolveSettings({ id: 'same-id', usbSerialNumber: '123' });
    expect(repo.reconcileDeviceId).not.toHaveBeenCalled();
  });

  test('skips USB serial lookup when device has no usbSerialNumber', () => {
    const repo = makeRepo();
    const svc = new DeviceReconciliationService({ instrumentRepository: repo, logger: silentLogger() });
    svc.resolveSettings({ id: 'dev-1' });
    expect(repo.findByUsbSerial).not.toHaveBeenCalled();
  });
});

describe('resolveSettings — MAC fallback (Bluetooth)', () => {
  test('uses MAC when device.type is bluetooth', () => {
    const repo = makeRepo({
      getAllSettings: jest.fn()
        .mockReturnValueOnce(null)
        .mockReturnValueOnce({ custom_name: 'BLE Synth' }),
      findByMac: jest.fn().mockReturnValue({ device_id: 'old-ble-id' })
    });
    const svc = new DeviceReconciliationService({ instrumentRepository: repo, logger: silentLogger() });
    const out = svc.resolveSettings({ id: 'ble-new', address: 'AA:BB:CC:DD:EE:FF', type: 'bluetooth' });
    expect(out).toEqual({ custom_name: 'BLE Synth' });
    expect(repo.findByMac).toHaveBeenCalledWith('AA:BB:CC:DD:EE:FF');
    expect(repo.reconcileDeviceId).toHaveBeenCalledWith('old-ble-id', 'ble-new');
  });

  test('skips MAC lookup when device is not bluetooth', () => {
    const repo = makeRepo();
    const svc = new DeviceReconciliationService({ instrumentRepository: repo, logger: silentLogger() });
    svc.resolveSettings({ id: 'dev-1', address: 'AA:BB:CC:DD:EE:FF', type: 'usb' });
    expect(repo.findByMac).not.toHaveBeenCalled();
  });
});

describe('resolveSettings — normalized name fallback (USB)', () => {
  test('uses normalized name when USB device has no serial and no MAC match', () => {
    const repo = makeRepo({
      getAllSettings: jest.fn()
        .mockReturnValueOnce(null)
        .mockReturnValueOnce({ custom_name: 'USB-Piano' }),
      findByNormalizedName: jest.fn().mockReturnValue({ device_id: 'old-usb-port' })
    });
    const svc = new DeviceReconciliationService({ instrumentRepository: repo, logger: silentLogger() });
    const out = svc.resolveSettings({ id: 'usb-port-2', type: 'usb' });
    expect(out).toEqual({ custom_name: 'USB-Piano' });
    expect(repo.findByNormalizedName).toHaveBeenCalledWith('usb-port-2');
    expect(repo.reconcileDeviceId).toHaveBeenCalledWith('old-usb-port', 'usb-port-2');
  });

  test('skips normalized name lookup when device is not usb', () => {
    const repo = makeRepo();
    const svc = new DeviceReconciliationService({ instrumentRepository: repo, logger: silentLogger() });
    svc.resolveSettings({ id: 'ble-1', type: 'bluetooth' });
    expect(repo.findByNormalizedName).not.toHaveBeenCalled();
  });
});

describe('resolveSettings — resilience', () => {
  test('swallows exceptions from the repository and returns null gracefully', () => {
    const repo = makeRepo({
      getAllSettings: jest.fn().mockImplementation(() => { throw new Error('db down'); })
    });
    const svc = new DeviceReconciliationService({ instrumentRepository: repo, logger: silentLogger() });
    expect(svc.resolveSettings({ id: 'dev-1' })).toBeNull();
  });
});
