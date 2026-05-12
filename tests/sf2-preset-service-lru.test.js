// tests/sf2-preset-service-lru.test.js
//
// Guard rails for the bounded L1 cache that replaced `new Map()` inside
// SF2PresetService (audit point #5). Without it, the built-in default SF2
// could fill the Pi 3B+ heap because every preset was kept in memory forever.
//
// We pre-build the AnalysisCache with a tiny byte budget and inject it via
// the constructor, then check three things:
//   1. exceeding the budget evicts the oldest entry (= disk re-parse next time)
//   2. the MRU is never re-parsed while it stays under the budget
//   3. invalidate(sf2Id) only wipes that bank's entries
//
// SF2Converter is mocked: we never touch a real soundfont file.

import { jest } from '@jest/globals';

await jest.unstable_mockModule('../src/files/SF2Converter.js', () => ({
  convertPreset: jest.fn((_buf, _bank, presetNumber) => ({
    zones: [{
      // Plain Array<number> matches the converter's real output shape; the
      // byte estimator multiplies sample length by 8.
      sample: new Array(64).fill(0),
      sampleRate: 44100,
      loopStart: 0,
      loopEnd: 0,
      keyRangeLow: 0,
      keyRangeHigh: 127,
      velRangeLow: 0,
      velRangeHigh: 127,
      midi: 60 + (presetNumber % 12),
      coarseTune: 0,
      fineTune: 0,
    }],
  })),
}));

jest.unstable_mockModule('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: jest.fn(() => true),
      readFileSync: jest.fn(() => Buffer.from('RIFF\0\0\0\0sfbk')),
      mkdirSync: jest.fn(),
    },
    existsSync: jest.fn(() => true),
    readFileSync: jest.fn(() => Buffer.from('RIFF\0\0\0\0sfbk')),
    mkdirSync: jest.fn(),
  };
});

const { SF2PresetService } = await import('../src/files/SF2PresetService.js');
const { convertPreset } = await import('../src/files/SF2Converter.js');
const AnalysisCache = (await import('../src/midi/playback/AnalysisCache.js')).default;

function makeFakeDB() {
  return {
    customSF2DB: {
      getCachedPreset: jest.fn(() => null),
      setCachedPreset: jest.fn(),
      getById: jest.fn((id) => ({ id, blob_path: `${id}.sf2` })),
    },
  };
}

function makeService({ maxBytes = 1500, maxEntries = 100 } = {}) {
  const database = makeFakeDB();
  const cache = new AnalysisCache({ maxBytes, maxSize: maxEntries });
  const service = new SF2PresetService({
    dataDir: '/tmp/gmboop-test',
    database,
    logger: { info() {}, warn() {}, error() {} },
    cache,
  });
  return { service, cache, database };
}

describe('SF2PresetService — bounded L1 cache', () => {
  beforeEach(() => {
    convertPreset.mockClear();
  });

  test('repeated calls for the same preset only parse the SF2 once', async () => {
    const { service } = makeService();
    await service.getPreset('default', 'melodic', 0, 0, 0);
    await service.getPreset('default', 'melodic', 0, 0, 0);
    await service.getPreset('default', 'melodic', 0, 0, 0);
    // Conversion happens once, two L1 hits.
    expect(convertPreset).toHaveBeenCalledTimes(1);
  });

  test('byte-budget eviction forces a re-parse for the LRU entry', async () => {
    // Each preset is 1 zone × 64 samples × 8 B + 200 B overhead = 712 B.
    // Budget 1500 B fits 2 entries; the 3rd must evict the oldest.
    const { service, cache } = makeService({ maxBytes: 1500 });

    await service.getPreset('default', 'melodic', 0, 0, 0); // 712 B
    await service.getPreset('default', 'melodic', 1, 0, 0); // 1424 B
    await service.getPreset('default', 'melodic', 2, 0, 0); // 2136 B → evicts program 0
    expect(convertPreset).toHaveBeenCalledTimes(3);
    expect(cache.getStats().size).toBeLessThanOrEqual(2);

    // Program 0 is gone — fetching it re-runs the converter.
    await service.getPreset('default', 'melodic', 0, 0, 0);
    expect(convertPreset).toHaveBeenCalledTimes(4);

    // Program 2 is the MRU among the surviving ones — no extra parse.
    await service.getPreset('default', 'melodic', 2, 0, 0);
    expect(convertPreset).toHaveBeenCalledTimes(4);
  });

  test('invalidate(sf2Id) only wipes that bank prefix', async () => {
    const { service, cache } = makeService({ maxBytes: 10_000 });
    await service.getPreset('default', 'melodic', 0, 0, 0);
    await service.getPreset('1',       'melodic', 0, 0, 0);
    await service.getPreset('2',       'melodic', 0, 0, 0);
    expect(cache.getStats().size).toBe(3);

    service.invalidate('1');
    expect(cache.getStats().size).toBe(2);

    convertPreset.mockClear();
    // 'default' and '2' survive — no re-parse.
    await service.getPreset('default', 'melodic', 0, 0, 0);
    await service.getPreset('2',       'melodic', 0, 0, 0);
    expect(convertPreset).not.toHaveBeenCalled();

    // '1' was wiped — re-parse expected.
    await service.getPreset('1', 'melodic', 0, 0, 0);
    expect(convertPreset).toHaveBeenCalledTimes(1);
  });

  test('_estimatePresetBytes accounts for sample size + zone overhead', () => {
    const { service } = makeService();
    const preset = {
      zones: [
        { sample: new Array(100).fill(0) },
        { sample: new Array(50).fill(0)  },
      ],
    };
    // (100 + 50) * 8 + 2 * 200 = 1200 + 400 = 1600
    expect(service._estimatePresetBytes(preset)).toBe(1600);
    expect(service._estimatePresetBytes(null)).toBe(1024);
    expect(service._estimatePresetBytes({})).toBe(1024);
  });
});
