// tests/rtp-midi-handshake.test.js
// Two RtpMidiSession instances wired as peers must complete the AppleMIDI
// invitation handshake (control port then data port) and then exchange
// RTP-MIDI. Verifies the initiator + responder paths and MIDI delivery — the
// old "simplified" session skipped the handshake so real peers ignored it.

import { describe, test, expect, jest, afterEach } from '@jest/globals';
import RtpMidiSession from '../src/transports/RtpMidiSession.js';

const sessions = [];
afterEach(() => {
  sessions.forEach((s) => s.close());
  sessions.length = 0;
});

// Wire two sessions so each one's control/data sends are delivered to the
// other's control/data handlers (synchronous in-memory "network").
function makePair() {
  const a = new RtpMidiSession({
    localName: 'A',
    ssrc: 0xa,
    sendControl: (buf) => queueMicrotask(() => b.handleControlPacket(buf)),
    sendData: (buf) => queueMicrotask(() => b.handleDataPacket(buf))
  });
  const b = new RtpMidiSession({
    localName: 'B',
    ssrc: 0xb,
    sendControl: (buf) => queueMicrotask(() => a.handleControlPacket(buf)),
    sendData: (buf) => queueMicrotask(() => a.handleDataPacket(buf))
  });
  b.remoteHost = 'a';
  sessions.push(a, b);
  return { a, b };
}

describe('RtpMidiSession — AppleMIDI handshake', () => {
  test('initiator + responder complete the handshake and go connected', async () => {
    const { a, b } = makePair();
    const bConnected = new Promise((r) => b.once('connected', r));
    await a.connect('b', 5004, 5005);
    await bConnected;
    expect(a.isConnected()).toBe(true);
    expect(b.isConnected()).toBe(true);
  });

  test('MIDI sent after the handshake is delivered to the peer', async () => {
    const { a, b } = makePair();
    const gotMidi = new Promise((resolve) => {
      b.on('message', (_dt, bytes) => resolve(bytes));
    });
    await a.connect('b', 5004, 5005);
    a.sendMessage([0x90, 60, 100]);
    const bytes = await gotMidi;
    expect(bytes).toEqual([0x90, 60, 100]);
  });

  test('sendMessage before established throws', () => {
    const { a } = makePair();
    expect(() => a.sendMessage([0x90, 60, 100])).toThrow(/not established/i);
  });

  test('rejects the connect promise on handshake timeout when peer is silent', async () => {
    const silent = new RtpMidiSession({
      localName: 'X',
      ssrc: 1,
      sendControl: () => {}, // black hole — no peer responds
      sendData: () => {},
      handshakeTimeoutMs: 30
    });
    sessions.push(silent);
    await expect(silent.connect('nowhere', 5004, 5005)).rejects.toThrow(/timeout/i);
  });
});
