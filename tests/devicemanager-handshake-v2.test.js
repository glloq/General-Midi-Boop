// tests/devicemanager-handshake-v2.test.js
// GMB v2 Handshake (block 1, 24 bytes) parsing — docs/SYSEX_IDENTITY.md §2.
// parseGmbHandshake() decodes instance_id (5×7-bit → 32-bit), firmware (3
// bytes), descriptor_size (3×7-bit → 21-bit), revision (5×7-bit → 32-bit) and
// the flags byte, and routes ahead of the deprecated 52-byte v1 frame in
// parseIdentityReply(). Invoked via prototype.call to avoid constructing the
// full manager (which needs native easymidi).

import { describe, test, expect } from '@jest/globals';
import DeviceManager from '../src/midi/devices/DeviceManager.js';

// --- 7-bit little-endian encoders. instance_id/revision use the full 32-bit
// width: the 5th byte carries bits 28-31 (0x0f), matching parseGmbHandshake.
function enc32(v) {
  return [v & 0x7f, (v >>> 7) & 0x7f, (v >>> 14) & 0x7f, (v >>> 21) & 0x7f, (v >>> 28) & 0x0f];
}
function enc21(v) {
  return [v & 0x7f, (v >>> 7) & 0x7f, (v >>> 14) & 0x7f];
}
function buildV2({
  instanceId = 0x0a0b0c0d,
  fw = [1, 2, 3],
  descriptorSize = 0,
  revision = 0,
  flags = 0,
  protoVer = 0x02
} = {}) {
  return [
    0xf0,
    0x7d,
    0x00,
    0x01,
    0x01,
    protoVer,
    ...enc32(instanceId),
    ...fw,
    ...enc21(descriptorSize),
    ...enc32(revision),
    flags,
    0xf7
  ];
}

// Minimal `this` stub: the parser only touches logger + decode7BitTo32Bit.
function ctx() {
  return {
    logger: { debug() {}, info() {}, warn() {} },
    decode7BitTo32Bit: DeviceManager.prototype.decode7BitTo32Bit,
    parseGmbHandshake: DeviceManager.prototype.parseGmbHandshake,
    _parseUniversalIdentityReply: DeviceManager.prototype._parseUniversalIdentityReply,
    getManufacturerName: DeviceManager.prototype.getManufacturerName
  };
}
const parseHandshake = (bytes) => DeviceManager.prototype.parseGmbHandshake.call(ctx(), bytes);
const parseIdentity = (bytes) => DeviceManager.prototype.parseIdentityReply.call(ctx(), { bytes });

describe('parseGmbHandshake — GMB v2 handshake (24 bytes)', () => {
  test('frame is exactly 24 bytes', () => {
    expect(buildV2()).toHaveLength(24);
  });

  test('level 0: descriptor_size 0 → recognition only', () => {
    const r = parseHandshake(buildV2({ instanceId: 0x12345678, fw: [2, 4, 8], descriptorSize: 0 }));
    expect(r).not.toBeNull();
    expect(r.protocol).toBe('GMB Handshake v2');
    expect(r.protocolVersion).toBe(2);
    expect(r.level).toBe(0);
    expect(r.instanceIdDecimal).toBe(0x12345678);
    expect(r.instanceId).toBe('0x12345678');
    expect(r.deviceId).toBe('0x12345678'); // alias for saveSysExIdentity → sysex_device_id
    expect(r.firmwareVersion).toBe('2.4.8');
    expect(r.descriptorSize).toBe(0);
  });

  test('level 1: non-zero descriptor_size (21-bit) and revision decode', () => {
    const r = parseHandshake(buildV2({ descriptorSize: 1500, revision: 42 }));
    expect(r.level).toBe(1);
    expect(r.descriptorSize).toBe(1500);
    expect(r.revision).toBe(42);
  });

  test('descriptor_size uses the full 21-bit width', () => {
    const r = parseHandshake(buildV2({ descriptorSize: 0x1fffff }));
    expect(r.descriptorSize).toBe(0x1fffff);
  });

  test('instance_id and revision survive the full unsigned 32-bit range', () => {
    const r = parseHandshake(buildV2({ instanceId: 0xffffffff, revision: 0xdeadbeef }));
    expect(r.instanceIdDecimal).toBe(0xffffffff);
    expect(r.instanceId).toBe('0xFFFFFFFF');
    expect(r.revision).toBe(0xdeadbeef);
    expect(r.revisionHex).toBe('0xDEADBEEF');
  });

  test('flags: HTTP (bit 0) and push (bit 1) decode independently', () => {
    expect(parseHandshake(buildV2({ flags: 0 })).flags).toEqual({
      httpAvailable: false,
      pushNotifications: false
    });
    expect(parseHandshake(buildV2({ flags: 0x01 })).flags).toEqual({
      httpAvailable: true,
      pushNotifications: false
    });
    expect(parseHandshake(buildV2({ flags: 0x02 })).flags).toEqual({
      httpAvailable: false,
      pushNotifications: true
    });
    expect(parseHandshake(buildV2({ flags: 0x03 })).flags).toEqual({
      httpAvailable: true,
      pushNotifications: true
    });
  });

  test('rejects a wrong proto_ver (not 0x02)', () => {
    expect(parseHandshake(buildV2({ protoVer: 0x01 }))).toBeNull();
    expect(parseHandshake(buildV2({ protoVer: 0x03 }))).toBeNull();
  });

  test('rejects a 52-byte v1 frame (wrong length)', () => {
    const v1 = [0xf0, 0x7d, 0x00, 0x01, 0x01, 0x01, ...new Array(45).fill(0x00), 0xf7];
    expect(v1).toHaveLength(52);
    expect(parseHandshake(v1)).toBeNull();
  });

  test('rejects wrong header / missing terminator / short frames', () => {
    const good = buildV2();
    const badHeader = [...good];
    badHeader[1] = 0x7e; // not GMB manufacturer
    expect(parseHandshake(badHeader)).toBeNull();

    const noTerminator = [...good];
    noTerminator[23] = 0x00;
    expect(parseHandshake(noTerminator)).toBeNull();

    expect(parseHandshake(good.slice(0, 20))).toBeNull();
    expect(parseHandshake([])).toBeNull();
    expect(parseHandshake('not-an-array')).toBeNull();
  });
});

describe('parseIdentityReply — routes v2 ahead of deprecated v1', () => {
  test('a v2 handshake is decoded as GMB Handshake v2', () => {
    const r = parseIdentity(buildV2({ instanceId: 0x00c0ffee, descriptorSize: 800 }));
    expect(r).not.toBeNull();
    expect(r.protocol).toBe('GMB Handshake v2');
    expect(r.instanceIdDecimal).toBe(0x00c0ffee);
    expect(r.level).toBe(1);
  });

  test('a legacy 52-byte v1 frame still parses as GMB Block 1 (deprecated path)', () => {
    // F0 7D 00 01 01 <ver=01> <id[5]> <name[32]> <fw[3]> <features[5]> F7
    const name = [0x54, 0x65, 0x73, 0x74, ...new Array(28).fill(0x00)]; // "Test" + pad
    const v1 = [
      0xf0,
      0x7d,
      0x00,
      0x01,
      0x01,
      0x01, // block version 1
      0x01,
      0x00,
      0x00,
      0x00,
      0x00, // device id = 1
      ...name,
      0x01,
      0x00,
      0x00, // firmware 1.0.0
      0x01,
      0x00,
      0x00,
      0x00,
      0x00, // features = 0x01
      0xf7
    ];
    expect(v1).toHaveLength(52);
    const r = parseIdentity(v1);
    expect(r).not.toBeNull();
    expect(r.protocol).toBe('GMB Block 1');
    expect(r.deviceName).toBe('Test');
  });

  test('a MIDI Universal Identity Reply is unaffected', () => {
    // F0 7E <ch> 06 02 <mfr=0x41 Roland> <f_lsb f_msb> <m_lsb m_msb> <v1..v4> F7
    const universal = [
      0xf0, 0x7e, 0x00, 0x06, 0x02, 0x41, 0x00, 0x01, 0x02, 0x03, 0x01, 0x00, 0x00, 0x00, 0xf7
    ];
    const r = parseIdentity(universal);
    expect(r).not.toBeNull();
    expect(r.protocol).toBe('Universal Identity Reply');
  });
});
