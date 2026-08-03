// tests/install-default-sf2.test.js
//
// Unit tests for the ZIP extractor + header sniffer inside
// scripts/install-default-sf2.js. Without these, the install script
// silently produced corrupt SF2 files when the mirror served a .zip.

import zlib from 'zlib';
import { isSF2Buffer, isZipBuffer, extractSf2FromZip } from '../scripts/install-default-sf2.js';

function makeSF2Body(extraBytes = 1024 * 1024) {
  // 12-byte RIFF/sfbk header is what the SF2 sniffer + the upload route check.
  return Buffer.concat([Buffer.from('RIFF\0\0\0\0sfbk'), Buffer.alloc(extraBytes)]);
}

/** Synthesize a minimal ZIP with a single entry. */
function makeZip(filename, data, { deflate = false } = {}) {
  const fname = Buffer.from(filename);
  const method = deflate ? 8 : 0;
  const payload = deflate ? zlib.deflateRawSync(data) : data;

  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0); // LFH sig
  lfh.writeUInt16LE(20, 4); // version needed
  lfh.writeUInt16LE(0, 6); // flags
  lfh.writeUInt16LE(method, 8);
  lfh.writeUInt32LE(payload.length, 18);
  lfh.writeUInt32LE(data.length, 22);
  lfh.writeUInt16LE(fname.length, 26);
  lfh.writeUInt16LE(0, 28); // extra len
  const lfhBlock = Buffer.concat([lfh, fname, payload]);

  const cdfh = Buffer.alloc(46);
  cdfh.writeUInt32LE(0x02014b50, 0); // CDFH sig
  cdfh.writeUInt16LE(20, 4);
  cdfh.writeUInt16LE(20, 6);
  cdfh.writeUInt16LE(0, 8);
  cdfh.writeUInt16LE(method, 10);
  cdfh.writeUInt32LE(payload.length, 20);
  cdfh.writeUInt32LE(data.length, 24);
  cdfh.writeUInt16LE(fname.length, 28);
  cdfh.writeUInt16LE(0, 30);
  const cdBlock = Buffer.concat([cdfh, fname]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdBlock.length, 12);
  eocd.writeUInt32LE(lfhBlock.length, 16);

  return Buffer.concat([lfhBlock, cdBlock, eocd]);
}

describe('install-default-sf2 — header sniffers', () => {
  test('isSF2Buffer detects RIFF/sfbk magic', () => {
    expect(isSF2Buffer(makeSF2Body(16))).toBe(true);
    expect(isSF2Buffer(Buffer.from('RIFF1234WAVE'))).toBe(false);
    expect(isSF2Buffer(Buffer.from('hello'))).toBe(false);
  });

  test('isZipBuffer detects PK\\x03\\x04 magic', () => {
    expect(isZipBuffer(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]))).toBe(true);
    expect(isZipBuffer(Buffer.from('RIFFxxxx'))).toBe(false);
  });
});

describe('install-default-sf2 — extractSf2FromZip', () => {
  test('extracts a stored (uncompressed) .sf2 entry', () => {
    const sf2 = makeSF2Body();
    const zip = makeZip('GeneralUser.sf2', sf2);
    const out = extractSf2FromZip(zip);
    expect(isSF2Buffer(out)).toBe(true);
    expect(out.length).toBe(sf2.length);
  });

  test('extracts a deflate-compressed .sf2 entry', () => {
    const sf2 = makeSF2Body();
    const zip = makeZip('GeneralUser.sf2', sf2, { deflate: true });
    const out = extractSf2FromZip(zip);
    expect(isSF2Buffer(out)).toBe(true);
    expect(out.length).toBe(sf2.length);
  });

  test('throws when no .sf2 entry is present', () => {
    const zip = makeZip('readme.txt', Buffer.from('hello world'));
    expect(() => extractSf2FromZip(zip)).toThrow(/no \.sf2 entry/i);
  });

  test('throws on missing end-of-central-directory record', () => {
    expect(() => extractSf2FromZip(Buffer.from('PK\x03\x04 not really a zip'))).toThrow(
      /end-of-central-directory/i
    );
  });
});
