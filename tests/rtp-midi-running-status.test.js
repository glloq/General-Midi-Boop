// tests/rtp-midi-running-status.test.js
// Regression guard (system audit): the RTP-MIDI command-section parser used to
// skip every high-bit-clear byte as "delta-time", which also swallowed the
// DATA bytes of a running-status command (no status byte), silently dropping
// notes from peers (iOS/macOS Network Session, rtpMIDI) that bundle running-
// status commands. The parser must decode delta-time as a proper VLQ and honor
// the header Z bit.

import { describe, test, expect, afterEach } from '@jest/globals';
import RtpMidiSession from '../src/transports/RtpMidiSession.js';

const sessions = [];
afterEach(() => {
  sessions.forEach((s) => s.close());
  sessions.length = 0;
});

function makeSession() {
  const s = new RtpMidiSession({
    localName: 'T',
    ssrc: 0x1,
    sendControl: () => {},
    sendData: () => {}
  });
  sessions.push(s);
  return s;
}

describe('RtpMidiSession.parseMidiPayload — running status', () => {
  test('recovers a running-status second note (Z=1, delta-times present)', () => {
    const s = makeSession();
    // Header: Z(0x20) | length. MIDI section:
    //   dt=0x00, 90 3C 64 (Note On, full status)
    //   dt=0x00, 3E 64    (running status — no status byte)
    const midi = [0x00, 0x90, 0x3c, 0x64, 0x00, 0x3e, 0x64];
    const payload = Buffer.from([0x20 | midi.length, ...midi]);
    const cmds = s.parseMidiPayload(payload);
    expect(cmds).toEqual([
      [0x90, 0x3c, 0x64],
      [0x90, 0x3e, 0x64]
    ]);
  });

  test('parses a GMBoop-style packet (Z=0, single full-status command)', () => {
    const s = makeSession();
    const midi = [0x90, 0x3c, 0x64];
    const payload = Buffer.from([midi.length, ...midi]); // Z=0
    const cmds = s.parseMidiPayload(payload);
    expect(cmds).toEqual([[0x90, 0x3c, 0x64]]);
  });

  test('handles a multi-byte delta-time without misreading the command', () => {
    const s = makeSession();
    // dt = 0x81 0x00 (VLQ two-byte, value 128), then 90 40 7F
    const midi = [0x81, 0x00, 0x90, 0x40, 0x7f];
    const payload = Buffer.from([0x20 | midi.length, ...midi]);
    const cmds = s.parseMidiPayload(payload);
    expect(cmds).toEqual([[0x90, 0x40, 0x7f]]);
  });
});
