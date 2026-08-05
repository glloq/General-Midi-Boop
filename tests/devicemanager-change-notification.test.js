// tests/devicemanager-change-notification.test.js
// Block 0x11 change notification (docs/SYSEX_IDENTITY.md §4): parse the frame,
// and re-fetch the descriptor when the identity/instruments/timing changed at
// runtime (a restart-only flag does not re-fetch on its own). Invoked via
// prototype.call with stubs.

import { describe, test, expect, jest } from '@jest/globals';
import DeviceManager from '../src/midi/devices/DeviceManager.js';

const P = DeviceManager.prototype;

function enc32(v) {
  return [v & 0x7f, (v >>> 7) & 0x7f, (v >>> 14) & 0x7f, (v >>> 21) & 0x7f, (v >>> 28) & 0x0f];
}
function frame(revision, flags) {
  return [0xf0, 0x7d, 0x00, 0x11, 0x02, ...enc32(revision), flags, 0xf7];
}

describe('parseChangeNotification', () => {
  test('decodes revision (32-bit) and change flags', () => {
    const r = P.parseChangeNotification.call({}, frame(0xdeadbeef, 0x06)); // instruments + timing
    expect(r.revision).toBe(0xdeadbeef);
    expect(r.changeFlags).toEqual({
      identityChanged: false,
      instrumentsChanged: true,
      timingChanged: true,
      restartRequired: false
    });
  });

  test('individual flag bits', () => {
    expect(P.parseChangeNotification.call({}, frame(1, 0x01)).changeFlags.identityChanged).toBe(
      true
    );
    expect(P.parseChangeNotification.call({}, frame(1, 0x08)).changeFlags.restartRequired).toBe(
      true
    );
  });

  test('rejects non-0x11 frames and wrong lengths', () => {
    expect(P.parseChangeNotification.call({}, frame(1, 0).slice(0, 11))).toBeNull(); // short
    expect(P.parseChangeNotification.call({}, [0xf0, 0x7d, 0x00, 0x10, 0x01, 0xf7])).toBeNull(); // 0x10
    expect(P.parseChangeNotification.call({}, 'nope')).toBeNull();
  });
});

describe('_onChangeNotification', () => {
  function ctx() {
    return {
      logger: { info: jest.fn() },
      _startDescriptorFetch: jest.fn(),
      _onChangeNotification: P._onChangeNotification
    };
  }

  test('re-fetches on an instruments/timing/identity change', () => {
    const c = ctx();
    c._onChangeNotification('dev', { revision: 2, changeFlags: { instrumentsChanged: true } });
    expect(c._startDescriptorFetch).toHaveBeenCalledWith('dev');
  });

  test('does not re-fetch on a restart-only notification', () => {
    const c = ctx();
    c._onChangeNotification('dev', {
      revision: 2,
      changeFlags: { restartRequired: true, instrumentsChanged: false, timingChanged: false }
    });
    expect(c._startDescriptorFetch).not.toHaveBeenCalled();
  });
});
