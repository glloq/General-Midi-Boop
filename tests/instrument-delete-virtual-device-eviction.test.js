// tests/instrument-delete-virtual-device-eviction.test.js
// Regression: deleting a virtual instrument from the modal calls the generic
// `instrument_delete` command. It must also evict the device from the
// in-memory DeviceManager registry once its last channel is gone — otherwise
// device_list keeps returning it and the instrument reappears in the modal
// despite the success toast.

import { describe, test, expect, jest } from '@jest/globals';
import { instrumentDelete } from '../src/api/commands/InstrumentSettingsCommands.js';

function makeApp({ remainingByDevice = {} } = {}) {
  const removeVirtualDevice = jest.fn();
  const app = {
    database: {},
    logger: { warn: jest.fn() },
    instrumentRepository: {
      // R4/F-81: the four auxiliary deletes now run as ONE transactional
      // cascade inside InstrumentRepository instead of four loose calls here.
      deleteInstrumentCascade: jest.fn(() => ({ deleted: {}, skippedTables: [] })),
      findByDevice: jest.fn((id) => remainingByDevice[id] || [])
    },
    deviceManager: { removeVirtualDevice },
    eventBus: { emit: jest.fn() }
  };
  return { app, removeVirtualDevice };
}

describe('instrumentDelete — virtual device eviction', () => {
  test('evicts the virtual device from DeviceManager when no channels remain', async () => {
    const { app, removeVirtualDevice } = makeApp({ remainingByDevice: {} });

    const res = await instrumentDelete(app, { deviceId: 'virtual_123_abc', channel: 0 });

    expect(res).toEqual({ success: true });
    expect(app.instrumentRepository.deleteInstrumentCascade).toHaveBeenCalledWith(
      'virtual_123_abc',
      0
    );
    expect(removeVirtualDevice).toHaveBeenCalledWith('virtual_123_abc');
  });

  test('does NOT evict the virtual device while other channels remain', async () => {
    const { app, removeVirtualDevice } = makeApp({
      remainingByDevice: { virtual_123_abc: [{ channel: 1 }] }
    });

    await instrumentDelete(app, { deviceId: 'virtual_123_abc', channel: 0 });

    expect(removeVirtualDevice).not.toHaveBeenCalled();
  });

  test('never touches DeviceManager for a non-virtual (physical) device', async () => {
    const { app, removeVirtualDevice } = makeApp({ remainingByDevice: {} });

    await instrumentDelete(app, { deviceId: 'usb-Arduino-1234', channel: 0 });

    expect(removeVirtualDevice).not.toHaveBeenCalled();
  });

  test('tolerates a missing removeVirtualDevice on the DeviceManager', async () => {
    const { app } = makeApp({ remainingByDevice: {} });
    app.deviceManager = {}; // no removeVirtualDevice

    await expect(
      instrumentDelete(app, { deviceId: 'virtual_123_abc', channel: 0 })
    ).resolves.toEqual({ success: true });
  });
});
