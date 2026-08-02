// tests/apple-midi-codec.test.js
// Wire-format roundtrip + framing for the AppleMIDI session control protocol.

import { describe, test, expect } from '@jest/globals';
import {
  CMD,
  isControlPacket,
  commandOf,
  encodeInvitation,
  decodeInvitation,
  encodeEnd,
  encodeClockSync,
  decodeClockSync
} from '../src/transports/AppleMidi.js';

describe('AppleMidi codec', () => {
  test('control packets are recognised; RTP data (0x80) is not', () => {
    const inv = encodeInvitation(CMD.INVITATION, { initiatorToken: 1, ssrc: 2 });
    expect(isControlPacket(inv)).toBe(true);
    expect(commandOf(inv)).toBe('IN');
    // An RTP-MIDI data packet starts with 0x80 (RTP version 2).
    const rtp = Buffer.from([0x80, 0x61, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(isControlPacket(rtp)).toBe(false);
    expect(commandOf(rtp)).toBeNull();
  });

  test('invitation roundtrip preserves token, ssrc, name', () => {
    const enc = encodeInvitation(CMD.INVITATION, {
      initiatorToken: 0xdeadbeef,
      ssrc: 0x12345678,
      name: 'Boop'
    });
    const dec = decodeInvitation(enc);
    expect(dec).toEqual({
      command: 'IN',
      protocolVersion: 2,
      initiatorToken: 0xdeadbeef,
      ssrc: 0x12345678,
      name: 'Boop'
    });
  });

  test('accepted/rejected commands roundtrip', () => {
    for (const cmd of [CMD.INVITATION_ACCEPTED, CMD.INVITATION_REJECTED]) {
      const dec = decodeInvitation(encodeInvitation(cmd, { initiatorToken: 7, ssrc: 8, name: 'x' }));
      expect(dec.command).toBe(cmd);
      expect(dec.initiatorToken).toBe(7);
      expect(dec.ssrc).toBe(8);
    }
  });

  test('end (BY) packet has the right command and fields', () => {
    const by = encodeEnd({ initiatorToken: 5, ssrc: 6 });
    expect(commandOf(by)).toBe('BY');
    expect(by.readUInt32BE(8)).toBe(5);
    expect(by.readUInt32BE(12)).toBe(6);
  });

  test('clock-sync roundtrip preserves count and 64-bit timestamps', () => {
    const ts = 1234567890123; // > 32 bits
    const enc = encodeClockSync({ ssrc: 99, count: 1, ts1: ts, ts2: 0, ts3: 0 });
    expect(commandOf(enc)).toBe('CK');
    const dec = decodeClockSync(enc);
    expect(dec.ssrc).toBe(99);
    expect(dec.count).toBe(1);
    expect(dec.ts1).toBe(ts);
    expect(dec.ts2).toBe(0);
  });

  test('decoders reject malformed / wrong-length buffers', () => {
    expect(decodeInvitation(Buffer.from([0xff, 0xff, 0x49]))).toBeNull();
    expect(decodeClockSync(encodeInvitation(CMD.INVITATION, { initiatorToken: 1, ssrc: 1 }))).toBeNull();
  });
});
