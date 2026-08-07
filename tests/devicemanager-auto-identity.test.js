// tests/devicemanager-auto-identity.test.js
// Automatic identity recognition on connect. _onDevicePortAdded announces
// device_connected once per device (coalescing input+output ports) and arms a
// debounced identity probe with a reply timeout + bounded retries. Skips
// output-less devices (DIN-IN-only) and stops once a reply is seen. Invoked via
// prototype.call with fake timers to avoid constructing the full manager.

import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import DeviceManager from '../src/midi/devices/DeviceManager.js';

// Slightly above the module-internal AUTO_IDENTITY_* constants (750 / 5000).
const PAST_DEBOUNCE = 800;
const PAST_TIMEOUT = 5200;

function makeCtx(overrides = {}) {
  return {
    _autoIdentity: true,
    _identityProbes: new Map(),
    _announcedDevices: new Set(),
    outputs: new Map(),
    eventBus: { emit: jest.fn() },
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn() },
    sendIdentityRequest: jest.fn(),
    _onDevicePortAdded: DeviceManager.prototype._onDevicePortAdded,
    _scheduleAutoIdentityProbe: DeviceManager.prototype._scheduleAutoIdentityProbe,
    _sendAutoIdentity: DeviceManager.prototype._sendAutoIdentity,
    _getCommTimeoutMs: DeviceManager.prototype._getCommTimeoutMs,
    _markIdentified: DeviceManager.prototype._markIdentified,
    ...overrides
  };
}

describe('DeviceManager auto identity probe', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('output device: announces once and probes after the debounce', () => {
    const ctx = makeCtx();
    ctx.outputs.set('Robot', {});
    ctx._onDevicePortAdded('Robot', 'output');

    expect(ctx.eventBus.emit).toHaveBeenCalledWith('device_connected', {
      device: 'Robot',
      kind: 'output'
    });
    expect(ctx.sendIdentityRequest).not.toHaveBeenCalled(); // still debounced

    jest.advanceTimersByTime(PAST_DEBOUNCE);
    expect(ctx.sendIdentityRequest).toHaveBeenCalledTimes(1);
    expect(ctx.sendIdentityRequest).toHaveBeenCalledWith('Robot');
  });

  test('input + output of the same device announce device_connected only once', () => {
    const ctx = makeCtx();
    ctx.outputs.set('Robot', {});
    ctx._onDevicePortAdded('Robot', 'input');
    ctx._onDevicePortAdded('Robot', 'output');
    expect(ctx.eventBus.emit).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(PAST_DEBOUNCE);
    expect(ctx.sendIdentityRequest).toHaveBeenCalledTimes(1); // one probe, not two
  });

  test('input-only device (no output) is never probed and never throws', () => {
    const ctx = makeCtx(); // no outputs
    ctx._onDevicePortAdded('DinKeyboard', 'input');
    jest.advanceTimersByTime(PAST_DEBOUNCE + PAST_TIMEOUT * 4);
    expect(ctx.sendIdentityRequest).not.toHaveBeenCalled();
  });

  test('no reply → retries up to the cap (3), then stops', () => {
    const ctx = makeCtx();
    ctx.outputs.set('Robot', {});
    ctx._onDevicePortAdded('Robot', 'output');

    jest.advanceTimersByTime(PAST_DEBOUNCE); // attempt 1
    expect(ctx.sendIdentityRequest).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(PAST_TIMEOUT); // attempt 2
    expect(ctx.sendIdentityRequest).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(PAST_TIMEOUT); // attempt 3
    expect(ctx.sendIdentityRequest).toHaveBeenCalledTimes(3);
    jest.advanceTimersByTime(PAST_TIMEOUT * 3); // cap reached → no more
    expect(ctx.sendIdentityRequest).toHaveBeenCalledTimes(3);
  });

  test('a reply (markIdentified) stops further retries', () => {
    const ctx = makeCtx();
    ctx.outputs.set('Robot', {});
    ctx._onDevicePortAdded('Robot', 'output');

    jest.advanceTimersByTime(PAST_DEBOUNCE); // attempt 1
    expect(ctx.sendIdentityRequest).toHaveBeenCalledTimes(1);
    ctx._markIdentified('Robot'); // reply arrived
    jest.advanceTimersByTime(PAST_TIMEOUT * 4);
    expect(ctx.sendIdentityRequest).toHaveBeenCalledTimes(1);
  });

  test('an already-identified device is not re-probed on a later connect', () => {
    const ctx = makeCtx();
    ctx._markIdentified('Robot');
    ctx.outputs.set('Robot', {});
    ctx._onDevicePortAdded('Robot', 'output');
    jest.advanceTimersByTime(PAST_DEBOUNCE + PAST_TIMEOUT);
    expect(ctx.sendIdentityRequest).not.toHaveBeenCalled();
  });

  test('disabled auto-identity: connect announces but never probes', () => {
    const ctx = makeCtx({ _autoIdentity: false });
    ctx.outputs.set('Robot', {});
    ctx._onDevicePortAdded('Robot', 'output');
    expect(ctx.eventBus.emit).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(PAST_DEBOUNCE + PAST_TIMEOUT);
    expect(ctx.sendIdentityRequest).not.toHaveBeenCalled();
  });
});
