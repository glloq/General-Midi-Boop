// tests/sf2-instance-cache.test.js
//
// Guard rails for the in-process SoundFont2 instance LRU. We mock the
// soundfont2 module so we never touch a real SF2 file: the parser is
// replaced with an identity counter that lets us assert when a re-parse
// happens (cache miss) vs. when the cached instance is reused.
//
// The cache must:
//   1. Re-use a parsed instance across calls for the same (path, mtime).
//   2. Re-parse when the file's mtime changes (invalidates by key).
//   3. Re-parse when an entry has been evicted by the LRU capacity bound.
//   4. Drop entries when invalidate(path) is called (used on deleteSF2).

import { jest } from '@jest/globals';

let parseCalls = 0;
jest.unstable_mockModule('soundfont2', () => ({
  default: {
    SoundFont2: class FakeSoundFont2 {
      constructor(bytes) {
        parseCalls++;
        this.bytes = bytes;
        this.banks = {};
      }
    },
    GeneratorType: {}
  }
}));

// Minimal structurally-valid RIFF/sfbk container ('RIFF', len=4, 'sfbk').
// parseSoundFont now validates the RIFF structure before parsing (audit B2 C1),
// so fixtures must be well-formed; the cache keys on path+mtime (not content),
// so identical bytes across files are fine.
const VALID_SF2 = Buffer.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x73, 0x66, 0x62, 0x6b]);

const fakeFiles = new Map(); // absPath → { content: Buffer, mtimeMs }
jest.unstable_mockModule('fs', () => {
  const real = jest.requireActual('fs');
  return {
    ...real,
    default: {
      ...real,
      readFileSync: jest.fn((p) => {
        if (!fakeFiles.has(p)) throw new Error(`ENOENT: ${p}`);
        return fakeFiles.get(p).content;
      }),
      statSync: jest.fn((p) => {
        if (!fakeFiles.has(p)) throw new Error(`ENOENT: ${p}`);
        return { mtimeMs: fakeFiles.get(p).mtimeMs };
      })
    },
    readFileSync: jest.fn((p) => {
      if (!fakeFiles.has(p)) throw new Error(`ENOENT: ${p}`);
      return fakeFiles.get(p).content;
    }),
    statSync: jest.fn((p) => {
      if (!fakeFiles.has(p)) throw new Error(`ENOENT: ${p}`);
      return { mtimeMs: fakeFiles.get(p).mtimeMs };
    })
  };
});

const { SF2InstanceCache } = await import('../src/files/SF2InstanceCache.js');

describe('SF2InstanceCache', () => {
  beforeEach(() => {
    parseCalls = 0;
    fakeFiles.clear();
  });

  test('parses once and reuses the instance on subsequent reads', () => {
    fakeFiles.set('/sf2/a.sf2', { content: VALID_SF2, mtimeMs: 1000 });
    const cache = new SF2InstanceCache({ capacity: 3 });

    const i1 = cache.getForPath('/sf2/a.sf2');
    const i2 = cache.getForPath('/sf2/a.sf2');
    const i3 = cache.getForPath('/sf2/a.sf2');

    expect(parseCalls).toBe(1);
    expect(i1).toBe(i2);
    expect(i2).toBe(i3);
  });

  test('re-parses when the file mtime changes', () => {
    fakeFiles.set('/sf2/a.sf2', { content: VALID_SF2, mtimeMs: 1000 });
    const cache = new SF2InstanceCache({ capacity: 3 });

    const i1 = cache.getForPath('/sf2/a.sf2');
    fakeFiles.set('/sf2/a.sf2', { content: VALID_SF2, mtimeMs: 2000 });
    const i2 = cache.getForPath('/sf2/a.sf2');

    expect(parseCalls).toBe(2);
    expect(i1).not.toBe(i2);
    // Old entry must have been dropped — no stale double-parse footprint.
    expect(cache.getStats().size).toBe(1);
  });

  test('evicts the LRU entry when capacity is exceeded', () => {
    fakeFiles.set('/sf2/a.sf2', { content: VALID_SF2, mtimeMs: 1 });
    fakeFiles.set('/sf2/b.sf2', { content: VALID_SF2, mtimeMs: 1 });
    fakeFiles.set('/sf2/c.sf2', { content: VALID_SF2, mtimeMs: 1 });
    const cache = new SF2InstanceCache({ capacity: 2 });

    cache.getForPath('/sf2/a.sf2'); // parse 1 → [a]
    cache.getForPath('/sf2/b.sf2'); // parse 2 → [a, b]
    cache.getForPath('/sf2/c.sf2'); // parse 3 → [b, c] (evicted a)
    expect(cache.getStats().size).toBe(2);

    // a was evicted — fetching it re-parses → [c, a]
    cache.getForPath('/sf2/a.sf2');
    expect(parseCalls).toBe(4);

    // c is still cached — no extra parse, and the hit promotes c to MRU → [a, c]
    cache.getForPath('/sf2/c.sf2');
    expect(parseCalls).toBe(4);
  });

  test('LRU touch on hit prevents premature eviction', () => {
    fakeFiles.set('/sf2/a.sf2', { content: VALID_SF2, mtimeMs: 1 });
    fakeFiles.set('/sf2/b.sf2', { content: VALID_SF2, mtimeMs: 1 });
    fakeFiles.set('/sf2/c.sf2', { content: VALID_SF2, mtimeMs: 1 });
    const cache = new SF2InstanceCache({ capacity: 2 });

    cache.getForPath('/sf2/a.sf2'); // parse 1 → [a]
    cache.getForPath('/sf2/b.sf2'); // parse 2 → [a, b]
    cache.getForPath('/sf2/a.sf2'); // hit; promotes a → [b, a]
    cache.getForPath('/sf2/c.sf2'); // parse 3 → [a, c] (evicts b, not a)

    expect(parseCalls).toBe(3);
    cache.getForPath('/sf2/a.sf2'); // hit
    expect(parseCalls).toBe(3);
  });

  test('invalidate(path) drops every entry for that path', () => {
    fakeFiles.set('/sf2/a.sf2', { content: VALID_SF2, mtimeMs: 1 });
    fakeFiles.set('/sf2/b.sf2', { content: VALID_SF2, mtimeMs: 1 });
    const cache = new SF2InstanceCache({ capacity: 3 });

    cache.getForPath('/sf2/a.sf2');
    cache.getForPath('/sf2/b.sf2');
    cache.invalidate('/sf2/a.sf2');

    expect(cache.getStats().size).toBe(1);

    cache.getForPath('/sf2/a.sf2');
    expect(parseCalls).toBe(3); // a re-parsed; b still cached
  });
});
