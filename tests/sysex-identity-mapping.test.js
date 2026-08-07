// tests/sysex-identity-mapping.test.js
// normalizeSysexIdentity() maps the three identity shapes DeviceManager's
// parsers emit onto the sysex_* columns. Regression guard for the bug where
// saveSysExIdentity read v1-only field names (deviceFamily / deviceFamilyMember
// / softwareRevision) that NO parser emits, so sysex_family / sysex_model /
// sysex_version were always persisted null.

import { describe, test, expect } from '@jest/globals';
import InstrumentSettingsDB, {
  normalizeSysexIdentity
} from '../src/persistence/tables/InstrumentSettingsDB.js';

const NULLS = {
  manufacturer: null,
  family: null,
  model: null,
  version: null,
  deviceId: null,
  raw: null
};

describe('normalizeSysexIdentity', () => {
  test('Universal Identity Reply → manufacturer / family / model / version', () => {
    const r = normalizeSysexIdentity({
      protocol: 'Universal Identity Reply',
      manufacturerName: 'Roland',
      manufacturerId: '0x41',
      family: 260,
      model: 5,
      firmwareVersion: '1.0.0.0',
      rawBytes: 'F0 7E 00 06 02 ... F7'
    });
    expect(r).toEqual({
      manufacturer: '0x41',
      family: 260,
      model: 5,
      version: '1.0.0.0',
      deviceId: null,
      raw: 'F0 7E 00 06 02 ... F7'
    });
  });

  test('GMB v1 block 1 → deviceName as model + deviceId + firmwareVersion', () => {
    const r = normalizeSysexIdentity({
      protocol: 'GMB Block 1',
      manufacturerName: 'GeneralMidiBoop',
      deviceName: 'MyRobotPiano',
      deviceId: '0x12345678',
      firmwareVersion: '1.0.0',
      rawBytes: 'F0 7D ... F7'
    });
    expect(r).toEqual({
      manufacturer: 'GeneralMidiBoop',
      family: null,
      model: 'MyRobotPiano',
      version: '1.0.0',
      deviceId: '0x12345678',
      raw: 'F0 7D ... F7'
    });
  });

  test('GMB v2 handshake → instanceId as deviceId + firmwareVersion; family/model null', () => {
    const r = normalizeSysexIdentity({
      protocol: 'GMB Handshake v2',
      manufacturerName: 'GeneralMidiBoop',
      instanceId: '0x0A0B0C0D',
      deviceId: '0x0A0B0C0D',
      firmwareVersion: '2.1.0',
      descriptorSize: 0,
      revision: 0,
      rawBytes: 'F0 7D 00 01 01 02 ... F7'
    });
    expect(r.manufacturer).toBe('GeneralMidiBoop');
    expect(r.version).toBe('2.1.0');
    expect(r.deviceId).toBe('0x0A0B0C0D');
    expect(r.family).toBeNull();
    expect(r.model).toBeNull();
  });

  test('instanceId is used as deviceId when deviceId is absent', () => {
    const r = normalizeSysexIdentity({ instanceId: '0xDEADBEEF', firmwareVersion: '3.0.0' });
    expect(r.deviceId).toBe('0xDEADBEEF');
  });

  test('old v1-only field names no longer leak (regression)', () => {
    // deviceFamily / deviceFamilyMember / softwareRevision are the names the
    // buggy code read; none of them is produced by any parser and none must map.
    expect(normalizeSysexIdentity({ deviceFamily: 'X', deviceFamilyMember: 'Y' })).toEqual(NULLS);
    // softwareRevision is still accepted as a fallback for version (harmless).
    expect(normalizeSysexIdentity({ softwareRevision: '9.9' }).version).toBe('9.9');
  });

  test('empty / missing identity → all null (no throw)', () => {
    expect(normalizeSysexIdentity()).toEqual(NULLS);
    expect(normalizeSysexIdentity({})).toEqual(NULLS);
  });
});

describe('saveSysExIdentityForDevice stamps every channel (T1.9 / P1-3)', () => {
  // Exercise the enumeration/fallback logic without a real SQLite handle by
  // building an instance off the prototype and stubbing its collaborators.
  function makeStub(rows) {
    const calls = [];
    const inst = Object.create(InstrumentSettingsDB.prototype);
    inst.getInstrumentsByDevice = () => rows;
    inst.saveSysExIdentity = (deviceId, channel) => calls.push(channel);
    // db.transaction(fn) returns a function that just runs fn (better-sqlite3 shape).
    inst.db = { transaction: (fn) => (arg) => fn(arg) };
    return { inst, calls };
  }

  test('a multi-channel device is stamped on all of its channels', () => {
    const { inst, calls } = makeStub([{ channel: 1 }, { channel: 2 }, { channel: 5 }]);
    const n = inst.saveSysExIdentityForDevice('dev', { manufacturer: 'x' });
    expect(n).toBe(3);
    expect(calls).toEqual([1, 2, 5]);
  });

  test('a device with no rows yet falls back to channel 0', () => {
    const { inst, calls } = makeStub([]);
    const n = inst.saveSysExIdentityForDevice('dev', { manufacturer: 'x' });
    expect(n).toBe(1);
    expect(calls).toEqual([0]);
  });
});
