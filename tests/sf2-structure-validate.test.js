// tests/sf2-structure-validate.test.js
// Audit B2 C1: validateSf2Structure must reject a RIFF container whose declared
// chunk lengths exceed the buffer BEFORE the soundfont library over-allocates
// (a crafted 1 KB file claiming a ~4 GB phdr length would OOM-crash the box).

import { describe, test, expect } from '@jest/globals';
import { validateSf2Structure } from '../src/files/SF2Converter.js';

const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));
const u32le = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

// Build a RIFF/sfbk buffer from top-level chunks: [{ id, body: number[] }].
function buildSf2(chunks, { riffLenOverride } = {}) {
  const bodyBytes = [];
  for (const c of chunks) {
    bodyBytes.push(...ascii(c.id), ...u32le(c.declared ?? c.body.length), ...c.body);
    if ((c.body.length & 1) === 1) bodyBytes.push(0); // word-align
  }
  const afterId = [...ascii('sfbk'), ...bodyBytes];
  const riffLen = riffLenOverride ?? afterId.length;
  return new Uint8Array([...ascii('RIFF'), ...u32le(riffLen), ...afterId]);
}

describe('validateSf2Structure (audit B2 C1)', () => {
  test('a well-formed RIFF/sfbk container passes', () => {
    const buf = buildSf2([{ id: 'INFO', body: [1, 2, 3, 4] }]);
    expect(() => validateSf2Structure(buf)).not.toThrow();
  });

  test('too-short buffer is rejected', () => {
    expect(() => validateSf2Structure(new Uint8Array([1, 2, 3]))).toThrow(/too short/i);
  });

  test('non-RIFF is rejected', () => {
    const buf = buildSf2([{ id: 'INFO', body: [] }]);
    buf[0] = 0x00; // corrupt the 'RIFF' magic
    expect(() => validateSf2Structure(buf)).toThrow(/RIFF/);
  });

  test('non-sfbk form is rejected', () => {
    const buf = buildSf2([{ id: 'INFO', body: [] }]);
    buf[8] = 0x00; // corrupt the 'sfbk' form tag
    expect(() => validateSf2Structure(buf)).toThrow(/sfbk/);
  });

  test('a top-level chunk whose declared length exceeds the container is rejected', () => {
    // INFO claims 4 GB but the buffer is tiny — the exploit at the top level.
    const buf = buildSf2([{ id: 'INFO', body: [1, 2], declared: 0xffffffff }]);
    expect(() => validateSf2Structure(buf)).toThrow(/exceeds/i);
  });

  test('a LIST sub-chunk claiming a huge length is rejected (the phdr OOM vector)', () => {
    // LIST/pdta with a phdr sub-chunk declaring ~3.8 GB but only a few real bytes.
    const listBody = [
      ...ascii('pdta'),
      ...ascii('phdr'),
      ...u32le(38 * 100000000), // ~3.8 GB declared
      1,
      2,
      3,
      4
    ];
    const buf = buildSf2([{ id: 'LIST', body: listBody }]);
    expect(() => validateSf2Structure(buf)).toThrow(/exceeds/i);
  });

  test('a RIFF length larger than the file is rejected', () => {
    const buf = buildSf2([{ id: 'INFO', body: [] }], { riffLenOverride: 0xffffffff });
    expect(() => validateSf2Structure(buf)).toThrow(/exceeds file/i);
  });
});
