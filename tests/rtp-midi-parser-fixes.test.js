// tests/rtp-midi-parser-fixes.test.js
// Audit A1 (RTP-MIDI) parser fixes:
//   L1 — System Common (0xF1-0xF7) must cancel running status.
//   L7 — parseRtpPacket must return null (not throw) on a malformed extension.
//   M4 — the header P bit carries running status across packets (RFC 6295).

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

describe('RTP-L1 — System Common cancels running status', () => {
  test('a data byte after System Common is NOT parsed as another F-command', () => {
    const s = makeSession();
    // Z=1; dt=00, F3 05 (Song Select), dt=00, 3C 64 (orphan data).
    const midi = [0x00, 0xf3, 0x05, 0x00, 0x3c, 0x64];
    const payload = Buffer.from([0x20 | midi.length, ...midi]);
    expect(s.parseMidiPayload(payload)).toEqual([[0xf3, 0x05]]);
  });
});

describe('RTP-M4 — P bit carries running status across packets', () => {
  test('the first command of a P=1 packet inherits the previous status', () => {
    const s = makeSession();
    // Packet 1 establishes running status 0x90.
    const midi1 = [0x00, 0x90, 0x3c, 0x64];
    expect(s.parseMidiPayload(Buffer.from([0x20 | midi1.length, ...midi1]))).toEqual([
      [0x90, 0x3c, 0x64]
    ]);
    // Packet 2: P=1 (0x10), Z=0 — first command is bare data using running 0x90.
    const midi2 = [0x3e, 0x64];
    expect(s.parseMidiPayload(Buffer.from([0x10 | midi2.length, ...midi2]))).toEqual([
      [0x90, 0x3e, 0x64]
    ]);
  });

  test('without the P bit, running status does NOT carry (packet-local)', () => {
    const s = makeSession();
    s.parseMidiPayload(Buffer.from([0x20 | 4, 0x00, 0x90, 0x3c, 0x64])); // sets 0x90
    const midi2 = [0x3e, 0x64]; // Z=0, P=0 → no status, no running carry
    expect(s.parseMidiPayload(Buffer.from([midi2.length, ...midi2]))).toEqual([]);
  });
});

describe('RTP-L7 — malformed extension header', () => {
  test('parseRtpPacket returns null instead of throwing', () => {
    const s = makeSession();
    // 12-byte packet, extension bit set (byte0=0x10) but no extension header.
    const buf = Buffer.from([0x10, 0x61, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(() => s.parseRtpPacket(buf)).not.toThrow();
    expect(s.parseRtpPacket(buf)).toBeNull();
  });
});
