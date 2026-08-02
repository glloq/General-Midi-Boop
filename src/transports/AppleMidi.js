/**
 * @file src/transports/AppleMidi.js
 * @description Pure encode/decode for the AppleMIDI (a.k.a. RTP-MIDI session)
 * control protocol — the session-management layer that sits alongside the
 * RFC-6295 RTP-MIDI data stream. Real network-MIDI peers (iOS/macOS "Network
 * Session", rtpMIDI on Windows, many DIY ESP32 stacks) require the invitation
 * handshake before they accept any MIDI, which the previous "simplified"
 * session never performed (audit — network instruments reported connected but
 * received nothing).
 *
 * These are side-effect-free helpers so the wire format and the handshake
 * state machine can be exercised without real sockets or hardware.
 *
 * Control packet layout (all multi-byte fields big-endian):
 *   FF FF <cmd:2 ASCII> ...
 *   IN/OK/NO : <protocolVersion:4=2> <initiatorToken:4> <ssrc:4> <name:cstr>
 *   BY       : <protocolVersion:4=2> <initiatorToken:4> <ssrc:4>
 *   CK       : <ssrc:4> <count:1> <pad:3> <ts1:8> <ts2:8> <ts3:8>
 */

/** 2-byte AppleMIDI control-packet signature (0xFFFF). */
export const APPLEMIDI_SIGNATURE = 0xffff;
/** AppleMIDI protocol version carried in invitations. */
export const APPLEMIDI_PROTOCOL_VERSION = 2;

/** Control command codes (the 2 ASCII bytes after the signature). */
export const CMD = Object.freeze({
  INVITATION: 'IN',
  INVITATION_ACCEPTED: 'OK',
  INVITATION_REJECTED: 'NO',
  END: 'BY',
  CLOCK_SYNC: 'CK'
});

/**
 * True when a datagram is an AppleMIDI control packet (starts with 0xFF 0xFF).
 * RTP-MIDI data packets start with 0x80 (RTP version 2), so the two are
 * unambiguous even when they share a socket.
 * @param {Buffer} buf
 * @returns {boolean}
 */
export function isControlPacket(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xff;
}

/** @param {Buffer} buf @returns {?string} the 2-char command, or null. */
export function commandOf(buf) {
  if (!isControlPacket(buf)) return null;
  return buf.toString('ascii', 2, 4);
}

/**
 * Encode an invitation-family packet (IN / OK / NO).
 * @param {string} cmd - one of CMD.INVITATION | INVITATION_ACCEPTED | INVITATION_REJECTED
 * @param {{initiatorToken:number, ssrc:number, name?:string}} p
 * @returns {Buffer}
 */
export function encodeInvitation(cmd, { initiatorToken, ssrc, name = 'GeneralMidiBoop' }) {
  const nameBuf = Buffer.from(String(name), 'utf8');
  const buf = Buffer.alloc(16 + nameBuf.length + 1);
  buf.writeUInt16BE(APPLEMIDI_SIGNATURE, 0);
  buf.write(cmd, 2, 2, 'ascii');
  buf.writeUInt32BE(APPLEMIDI_PROTOCOL_VERSION, 4);
  buf.writeUInt32BE(initiatorToken >>> 0, 8);
  buf.writeUInt32BE(ssrc >>> 0, 12);
  nameBuf.copy(buf, 16);
  buf[16 + nameBuf.length] = 0; // null terminator
  return buf;
}

/**
 * Decode an invitation-family packet.
 * @param {Buffer} buf
 * @returns {?{command:string, protocolVersion:number, initiatorToken:number, ssrc:number, name:string}}
 */
export function decodeInvitation(buf) {
  if (!isControlPacket(buf) || buf.length < 16) return null;
  const command = buf.toString('ascii', 2, 4);
  let name = '';
  if (buf.length > 16) {
    let end = buf.indexOf(0, 16);
    if (end === -1) end = buf.length;
    name = buf.toString('utf8', 16, end);
  }
  return {
    command,
    protocolVersion: buf.readUInt32BE(4),
    initiatorToken: buf.readUInt32BE(8),
    ssrc: buf.readUInt32BE(12),
    name
  };
}

/**
 * Encode a session-end (BY) packet.
 * @param {{initiatorToken:number, ssrc:number}} p
 * @returns {Buffer}
 */
export function encodeEnd({ initiatorToken, ssrc }) {
  const buf = Buffer.alloc(16);
  buf.writeUInt16BE(APPLEMIDI_SIGNATURE, 0);
  buf.write(CMD.END, 2, 2, 'ascii');
  buf.writeUInt32BE(APPLEMIDI_PROTOCOL_VERSION, 4);
  buf.writeUInt32BE(initiatorToken >>> 0, 8);
  buf.writeUInt32BE(ssrc >>> 0, 12);
  return buf;
}

/**
 * Encode a clock-sync (CK) packet. Timestamps are 64-bit; we keep them within
 * the safe-integer range (JS Number) which is ample for a 10 kHz clock.
 * @param {{ssrc:number, count:number, ts1?:number, ts2?:number, ts3?:number}} p
 * @returns {Buffer}
 */
export function encodeClockSync({ ssrc, count, ts1 = 0, ts2 = 0, ts3 = 0 }) {
  const buf = Buffer.alloc(36);
  buf.writeUInt16BE(APPLEMIDI_SIGNATURE, 0);
  buf.write(CMD.CLOCK_SYNC, 2, 2, 'ascii');
  buf.writeUInt32BE(ssrc >>> 0, 4);
  buf[8] = count & 0xff;
  // bytes 9..11 padding (0)
  writeUInt64BE(buf, ts1, 12);
  writeUInt64BE(buf, ts2, 20);
  writeUInt64BE(buf, ts3, 28);
  return buf;
}

/**
 * Decode a clock-sync (CK) packet.
 * @param {Buffer} buf
 * @returns {?{ssrc:number, count:number, ts1:number, ts2:number, ts3:number}}
 */
export function decodeClockSync(buf) {
  if (!isControlPacket(buf) || buf.length < 36 || commandOf(buf) !== CMD.CLOCK_SYNC) return null;
  return {
    ssrc: buf.readUInt32BE(4),
    count: buf[8],
    ts1: readUInt64BE(buf, 12),
    ts2: readUInt64BE(buf, 20),
    ts3: readUInt64BE(buf, 28)
  };
}

/** Write a 64-bit unsigned big-endian value (safe-integer range) at offset. */
function writeUInt64BE(buf, value, offset) {
  const v = Math.max(0, Math.floor(value));
  const high = Math.floor(v / 0x100000000);
  const low = v >>> 0;
  buf.writeUInt32BE(high >>> 0, offset);
  buf.writeUInt32BE(low, offset + 4);
}

/** Read a 64-bit unsigned big-endian value (safe-integer range) at offset. */
function readUInt64BE(buf, offset) {
  const high = buf.readUInt32BE(offset);
  const low = buf.readUInt32BE(offset + 4);
  return high * 0x100000000 + low;
}
