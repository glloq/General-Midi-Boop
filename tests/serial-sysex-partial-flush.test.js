// tests/serial-sysex-partial-flush.test.js
// Audit A1 Serial#3: when a SysEx starts, any partially-assembled channel-voice
// message must be dropped. On a malformed stream (`90 3C` then a full SysEx) the
// stale `[90, 3C]` would otherwise be completed by the first data byte after the
// SysEx and emit a phantom note across the boundary.
//
// The parser calls sibling methods via `this`, so we back the context with the
// real prototype (no serialport native binding is touched by the parse path).

import { describe, test, expect, jest } from '@jest/globals';
import SerialMidiManager from '../src/transports/SerialMidiManager.js';

function makeManager() {
  const mgr = Object.create(SerialMidiManager.prototype);
  mgr.logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
  mgr.deviceManager = { handleMidiMessage: jest.fn() };
  mgr.openPorts = new Map([['p', { parserState: mgr._createParserState() }]]);
  return mgr;
}

const feed = (mgr, bytes) => mgr._handleData('p', Buffer.from(bytes));
const callsOfType = (mgr, type) =>
  mgr.deviceManager.handleMidiMessage.mock.calls.filter((c) => c[1] === type);

describe('SerialMidiManager — partial channel-voice flush on SysEx start', () => {
  test('a partial note-on before a SysEx does NOT resurface as a phantom note', () => {
    const mgr = makeManager();
    feed(mgr, [0x90, 0x3c]); // partial Note On (velocity byte missing)
    feed(mgr, [0xf0, 0x7e, 0x00, 0xf7]); // complete SysEx
    feed(mgr, [0x40]); // stray data byte after the SysEx

    // SysEx was delivered…
    expect(callsOfType(mgr, 'sysex')).toHaveLength(1);
    // …and no phantom Note On was assembled across the boundary.
    expect(callsOfType(mgr, 'noteon')).toHaveLength(0);
  });

  test('a well-formed note-on after a SysEx still parses normally', () => {
    const mgr = makeManager();
    feed(mgr, [0xf0, 0x7e, 0xf7]); // SysEx
    feed(mgr, [0x90, 0x3c, 0x64]); // full Note On
    const noteOns = callsOfType(mgr, 'noteon');
    expect(noteOns).toHaveLength(1);
    expect(noteOns[0][2]).toEqual({ channel: 0, note: 0x3c, velocity: 0x64 });
  });
});
