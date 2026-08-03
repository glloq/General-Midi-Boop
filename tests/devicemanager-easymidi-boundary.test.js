// tests/devicemanager-easymidi-boundary.test.js
// DeviceManager._sendToOutput must translate GMBoop's canonical (type,data)
// into easymidi's vocabulary: pitch bend uses type 'pitch' with a raw 14-bit
// `value`, program change uses `number` (not `program`), and data bytes are
// 7-bit-clamped. The old pass-through made USB pitch bend THROW and program
// change send `undefined` (audit P0/P1).

import { describe, test, expect, jest } from '@jest/globals';
import DeviceManager from '../src/midi/devices/DeviceManager.js';

function fakeOutput() {
  return { send: jest.fn() };
}
// _sendToOutput uses no `this`; invoke via prototype to avoid constructing the
// full manager (which needs native easymidi).
const sendTo = (output, type, data) =>
  DeviceManager.prototype._sendToOutput.call(null, output, type, data);

describe('DeviceManager._sendToOutput — easymidi boundary', () => {
  test('pitch bend → type "pitch" with raw 14-bit value (center)', () => {
    const out = fakeOutput();
    sendTo(out, 'pitchbend', { channel: 3, centeredValue: 0 });
    expect(out.send).toHaveBeenCalledWith('pitch', { channel: 3, value: 8192 });
  });

  test('pitch bend accepts value14 directly', () => {
    const out = fakeOutput();
    sendTo(out, 'pitchbend', { channel: 0, value14: 12000 });
    expect(out.send).toHaveBeenCalledWith('pitch', { channel: 0, value: 12000 });
  });

  test('program change → "program" with number (not program field)', () => {
    const out = fakeOutput();
    sendTo(out, 'program', { channel: 2, program: 40 });
    expect(out.send).toHaveBeenCalledWith('program', { channel: 2, number: 40 });
  });

  test('note on is 7-bit clamped', () => {
    const out = fakeOutput();
    sendTo(out, 'noteon', { channel: 1, note: 200, velocity: 300 });
    expect(out.send).toHaveBeenCalledWith('noteon', {
      channel: 1,
      note: 200 & 0x7f,
      velocity: 300 & 0x7f
    });
  });

  test('cc is 7-bit clamped', () => {
    const out = fakeOutput();
    sendTo(out, 'cc', { channel: 0, controller: 7, value: 200 });
    expect(out.send).toHaveBeenCalledWith('cc', { channel: 0, controller: 7, value: 200 & 0x7f });
  });

  test('sysex passes raw byte array', () => {
    const out = fakeOutput();
    sendTo(out, 'sysex', { bytes: [0xf0, 0x7e, 0xf7] });
    expect(out.send).toHaveBeenCalledWith('sysex', [0xf0, 0x7e, 0xf7]);
  });
});
