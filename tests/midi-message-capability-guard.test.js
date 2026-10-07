import { describe, test, expect, jest } from '@jest/globals';
import { SEND_STATUS } from '../src/core/constants.js';
import MidiMessageCapabilityGuard from '../src/midi/instrument/MidiMessageCapabilityGuard.js';

function makeEventBus() {
  const handlers = new Map();
  return {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
    },
    off(name, fn) {
      handlers.get(name)?.delete(fn);
    },
    emit(name, payload) {
      for (const fn of handlers.get(name) || []) fn(payload);
    }
  };
}

function makeDeviceManager() {
  return {
    sendMessageEx: jest.fn(() => ({ status: SEND_STATUS.SENT })),
    sendMessage(device, type, data) {
      const result = this.sendMessageEx(device, type, data);
      return result.status === SEND_STATUS.SENT || result.status === SEND_STATUS.QUEUED;
    }
  };
}

describe('MidiMessageCapabilityGuard', () => {
  test('unknown legacy capability data stays permissive', () => {
    const repo = {
      getMidiMessageSupport: jest.fn(() => null),
      getMidiMessageSupportsForDevice: jest.fn(() => null)
    };
    const dm = makeDeviceManager();
    const original = dm.sendMessageEx;
    const guard = new MidiMessageCapabilityGuard({ instrumentRepository: repo });
    expect(guard.install(dm)).toBe(true);

    expect(dm.sendMessageEx('dev', 'pitchbend', { channel: 2, value: 0 }).status).toBe(
      SEND_STATUS.SENT
    );
    expect(original).toHaveBeenCalledTimes(1);
  });

  test('explicit false suppresses channel message before DeviceManager transport dispatch', () => {
    const repo = {
      getMidiMessageSupport: jest.fn(() => ({
        note_on: true,
        note_off: true,
        pitch_bend: false,
        channel_aftertouch: false,
        program_change: false
      }))
    };
    const dm = makeDeviceManager();
    const original = dm.sendMessageEx;
    new MidiMessageCapabilityGuard({ instrumentRepository: repo }).install(dm);

    expect(dm.sendMessageEx('dev', 'pitchbend', { channel: 0, value: 123 }).status).toBe(
      SEND_STATUS.UNSUPPORTED
    );
    expect(dm.sendMessageEx('dev', 'channel aftertouch', { channel: 0, pressure: 70 }).status).toBe(
      SEND_STATUS.UNSUPPORTED
    );
    expect(dm.sendMessageEx('dev', 'program', { channel: 0, program: 12 }).status).toBe(
      SEND_STATUS.UNSUPPORTED
    );
    expect(original).not.toHaveBeenCalled();
  });

  test('explicit true sends normally', () => {
    const repo = {
      getMidiMessageSupport: jest.fn(() => ({ pitch_bend: true }))
    };
    const dm = makeDeviceManager();
    const original = dm.sendMessageEx;
    new MidiMessageCapabilityGuard({ instrumentRepository: repo }).install(dm);

    expect(dm.sendMessageEx('dev', 'pitchbend', { channel: 1, value: 123 }).status).toBe(
      SEND_STATUS.SENT
    );
    expect(original).toHaveBeenCalledTimes(1);
  });

  test('note-off and velocity-zero note-on always bypass the capability gate', () => {
    const repo = {
      getMidiMessageSupport: jest.fn(() => ({ note_on: false, note_off: false }))
    };
    const dm = makeDeviceManager();
    const original = dm.sendMessageEx;
    new MidiMessageCapabilityGuard({ instrumentRepository: repo }).install(dm);

    expect(dm.sendMessageEx('dev', 'noteoff', { channel: 0, note: 60, velocity: 0 }).status).toBe(
      SEND_STATUS.SENT
    );
    expect(dm.sendMessageEx('dev', 'noteon', { channel: 0, note: 60, velocity: 0 }).status).toBe(
      SEND_STATUS.SENT
    );
    expect(original).toHaveBeenCalledTimes(2);
  });

  test('channel-mode panic CCs always bypass a false control_change declaration', () => {
    const repo = {
      getMidiMessageSupport: jest.fn(() => ({ control_change: false }))
    };
    const dm = makeDeviceManager();
    const original = dm.sendMessageEx;
    new MidiMessageCapabilityGuard({ instrumentRepository: repo }).install(dm);

    expect(dm.sendMessageEx('dev', 'cc', { channel: 0, controller: 123, value: 0 }).status).toBe(
      SEND_STATUS.SENT
    );
    expect(dm.sendMessageEx('dev', 'cc', { channel: 0, controller: 11, value: 100 }).status).toBe(
      SEND_STATUS.UNSUPPORTED
    );
    expect(original).toHaveBeenCalledTimes(1);
  });

  test('bank select remains available when Program Change is explicitly supported', () => {
    const repo = {
      getMidiMessageSupport: jest.fn(() => ({
        control_change: false,
        program_change: true
      }))
    };
    const dm = makeDeviceManager();
    const original = dm.sendMessageEx;
    new MidiMessageCapabilityGuard({ instrumentRepository: repo }).install(dm);

    expect(dm.sendMessageEx('dev', 'cc', { channel: 0, controller: 0, value: 2 }).status).toBe(
      SEND_STATUS.SENT
    );
    expect(dm.sendMessageEx('dev', 'cc', { channel: 0, controller: 32, value: 5 }).status).toBe(
      SEND_STATUS.SENT
    );
    expect(original).toHaveBeenCalledTimes(2);
  });

  test('device-wide realtime is suppressed only when every channel explicitly rejects it', () => {
    const repo = {
      getMidiMessageSupportsForDevice: jest.fn(() => ({
        0: { clock: false, start: false },
        1: { clock: false, start: false }
      }))
    };
    const dm = makeDeviceManager();
    const original = dm.sendMessageEx;
    const guard = new MidiMessageCapabilityGuard({ instrumentRepository: repo });
    guard.install(dm);

    expect(dm.sendMessageEx('dev', 'clock', {}).status).toBe(SEND_STATUS.UNSUPPORTED);
    expect(dm.sendMessageEx('dev', 'start', {}).status).toBe(SEND_STATUS.UNSUPPORTED);
    expect(original).not.toHaveBeenCalled();
  });

  test('one true or unknown channel keeps device-wide realtime permissive', () => {
    const repo = {
      getMidiMessageSupportsForDevice: jest
        .fn()
        .mockReturnValueOnce({ 0: { clock: false }, 1: { clock: true } })
        .mockReturnValueOnce({ 0: { clock: false }, 1: null })
    };
    const dm = makeDeviceManager();
    const original = dm.sendMessageEx;
    const guard = new MidiMessageCapabilityGuard({ instrumentRepository: repo });
    guard.install(dm);

    expect(dm.sendMessageEx('dev-a', 'clock', {}).status).toBe(SEND_STATUS.SENT);
    expect(dm.sendMessageEx('dev-b', 'clock', {}).status).toBe(SEND_STATUS.SENT);
    expect(original).toHaveBeenCalledTimes(2);
  });

  test('descriptor/settings events invalidate cached declarations', () => {
    const eventBus = makeEventBus();
    const repo = {
      getMidiMessageSupport: jest
        .fn()
        .mockReturnValueOnce({ pitch_bend: false })
        .mockReturnValueOnce({ pitch_bend: true })
    };
    const dm = makeDeviceManager();
    const original = dm.sendMessageEx;
    const guard = new MidiMessageCapabilityGuard({ instrumentRepository: repo, eventBus });
    guard.install(dm);

    expect(dm.sendMessageEx('dev', 'pitchbend', { channel: 0, value: 1 }).status).toBe(
      SEND_STATUS.UNSUPPORTED
    );
    eventBus.emit('instruments_configured', { deviceId: 'dev' });
    expect(dm.sendMessageEx('dev', 'pitchbend', { channel: 0, value: 1 }).status).toBe(
      SEND_STATUS.SENT
    );
    expect(repo.getMidiMessageSupport).toHaveBeenCalledTimes(2);
    expect(original).toHaveBeenCalledTimes(1);
  });

  test('install is idempotent', () => {
    const guard = new MidiMessageCapabilityGuard({
      instrumentRepository: { getMidiMessageSupport: () => null }
    });
    const dm = makeDeviceManager();
    expect(guard.install(dm)).toBe(true);
    expect(guard.install(dm)).toBe(false);
  });
});
