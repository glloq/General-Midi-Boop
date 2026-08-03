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

// SF2PresetService now calls convertPresetFromSF2 after going through the
// SF2InstanceCache. We mock both so the test doesn't need a real SF2 file.
const makeFakePreset = (presetNumber) => ({
  zones: [
    {
      // Float32Array matches the converter's real output shape; the byte
      // estimator multiplies sample length by 4.
      sample: new Float32Array(64),
      sampleRate: 44100,
      loopStart: 0,
      loopEnd: 0,
      keyRangeLow: 0,
      keyRangeHigh: 127,
      velRangeLow: 0,
      velRangeHigh: 127,
      midi: 60 + (presetNumber % 12),
      coarseTune: 0,
      fineTune: 0
    }
  ]
});

await jest.unstable_mockModule('../src/files/SF2Converter.js', () => ({
  parseSoundFont: jest.fn(() => ({ banks: {} })),
  convertPresetFromSF2: jest.fn((_sf2, _bank, presetNumber) => makeFakePreset(presetNumber)),
  convertPreset: jest.fn((_buf, _bank, presetNumber) => makeFakePreset(presetNumber))
}));

jest.unstable_mockModule('fs', () => {
  const actual = jest.requireActual('fs');
  const fakeStat = { mtimeMs: 1000 };
  const fakeBuf = Buffer.from('RIFF\0\0\0\0sfbk');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: jest.fn(() => true),
      readFileSync: jest.fn(() => fakeBuf),
      statSync: jest.fn(() => fakeStat),
      mkdirSync: jest.fn()
    },
    existsSync: jest.fn(() => true),
    readFileSync: jest.fn(() => fakeBuf),
    statSync: jest.fn(() => fakeStat),
    mkdirSync: jest.fn()
  };
});

const { SF2PresetService } = await import('../src/files/SF2PresetService.js');
const { convertPresetFromSF2 } = await import('../src/files/SF2Converter.js');
const AnalysisCache = (await import('../src/midi/playback/AnalysisCache.js')).default;

function makeFakeDB() {
  return {
    customSF2DB: {
      getCachedPreset: jest.fn(() => null),
      setCachedPreset: jest.fn(),
      getById: jest.fn((id) => ({ id, blob_path: `${id}.sf2` }))
    }
  };
}

function makeService({ maxBytes = 1500, maxEntries = 100 } = {}) {
  const database = makeFakeDB();
  const cache = new AnalysisCache({ maxBytes, maxSize: maxEntries });
  const service = new SF2PresetService({
    dataDir: '/tmp/gmboop-test',
    database,
    logger: { info() {}, warn() {}, error() {} },
    cache
  });
  return { service, cache, database };
}

describe('SF2PresetService — bounded L1 cache', () => {
  beforeEach(() => {
    convertPresetFromSF2.mockClear();
  });

  test('repeated calls for the same preset only parse the SF2 once', async () => {
    const { service } = makeService();
    await service.getPreset('default', 'melodic', 0, 0, 0);
    await service.getPreset('default', 'melodic', 0, 0, 0);
    await service.getPreset('default', 'melodic', 0, 0, 0);
    // Conversion happens once, two L1 hits.
    expect(convertPresetFromSF2).toHaveBeenCalledTimes(1);
  });

  test('byte-budget eviction forces a re-parse for the LRU entry', async () => {
    // Each preset is 1 zone × 64 samples × 4 B + 200 B overhead = 456 B.
    // Budget 1000 B fits 2 entries; the 3rd must evict the oldest.
    const { service, cache } = makeService({ maxBytes: 1000 });

    await service.getPreset('default', 'melodic', 0, 0, 0); // 456 B
    await service.getPreset('default', 'melodic', 1, 0, 0); // 912 B
    await service.getPreset('default', 'melodic', 2, 0, 0); // 1368 B → evicts program 0
    expect(convertPresetFromSF2).toHaveBeenCalledTimes(3);
    expect(cache.getStats().size).toBeLessThanOrEqual(2);

    // Program 0 is gone — fetching it re-runs the converter.
    await service.getPreset('default', 'melodic', 0, 0, 0);
    expect(convertPresetFromSF2).toHaveBeenCalledTimes(4);

    // Program 2 is the MRU among the surviving ones — no extra parse.
    await service.getPreset('default', 'melodic', 2, 0, 0);
    expect(convertPresetFromSF2).toHaveBeenCalledTimes(4);
  });

  test('invalidate(sf2Id) only wipes that bank prefix', async () => {
    const { service, cache } = makeService({ maxBytes: 10_000 });
    await service.getPreset('default', 'melodic', 0, 0, 0);
    await service.getPreset('1', 'melodic', 0, 0, 0);
    await service.getPreset('2', 'melodic', 0, 0, 0);
    expect(cache.getStats().size).toBe(3);

    service.invalidate('1');
    expect(cache.getStats().size).toBe(2);

    convertPresetFromSF2.mockClear();
    // 'default' and '2' survive — no re-parse.
    await service.getPreset('default', 'melodic', 0, 0, 0);
    await service.getPreset('2', 'melodic', 0, 0, 0);
    expect(convertPresetFromSF2).not.toHaveBeenCalled();

    // '1' was wiped — re-parse expected.
    await service.getPreset('1', 'melodic', 0, 0, 0);
    expect(convertPresetFromSF2).toHaveBeenCalledTimes(1);
  });

  test('default SF2 hits the L2 cache like custom uploads', async () => {
    // Fresh service. First call: L1 + L2 miss → convertPresetFromSF2 runs.
    // We capture what setCachedPreset receives, then replay it through
    // getCachedPreset on a brand-new service to confirm the same preset
    // comes back without re-running the converter.
    const database = makeFakeDB();
    let storedBlob = null;
    database.customSF2DB.setCachedPreset = jest.fn((_id, _t, _p, _k, _n, buf) => {
      storedBlob = buf;
    });

    const s1 = new SF2PresetService({
      dataDir: '/tmp/gmboop-test',
      database,
      logger: { info() {}, warn() {}, error() {} },
      cache: new AnalysisCache({ maxBytes: 100_000, maxSize: 10 })
    });
    await s1.getPreset('default', 'melodic', 0, 0, 0);
    expect(convertPresetFromSF2).toHaveBeenCalledTimes(1);
    expect(storedBlob).toBeTruthy();
    // Sentinel id (0) is used for the default in the DB.
    expect(database.customSF2DB.setCachedPreset).toHaveBeenCalledWith(
      0,
      'melodic',
      0,
      0,
      0,
      expect.any(Buffer)
    );

    // Second service shares the DB but starts with cold L1. Inject the
    // previously-stored blob through getCachedPreset.
    convertPresetFromSF2.mockClear();
    database.customSF2DB.getCachedPreset = jest.fn((id) => (id === 0 ? storedBlob : null));
    const s2 = new SF2PresetService({
      dataDir: '/tmp/gmboop-test',
      database,
      logger: { info() {}, warn() {}, error() {} },
      cache: new AnalysisCache({ maxBytes: 100_000, maxSize: 10 })
    });
    const preset = await s2.getPreset('default', 'melodic', 0, 0, 0);
    expect(preset).toBeTruthy();
    expect(convertPresetFromSF2).not.toHaveBeenCalled(); // L2 hit → skip parse
  });

  test('_estimatePresetBytes accounts for sample size + zone overhead', () => {
    const { service } = makeService();
    const preset = {
      zones: [{ sample: new Float32Array(100) }, { sample: new Float32Array(50) }]
    };
    // (100 + 50) * 4 + 2 * 200 = 600 + 400 = 1000
    expect(service._estimatePresetBytes(preset)).toBe(1000);
    expect(service._estimatePresetBytes(null)).toBe(1024);
    expect(service._estimatePresetBytes({})).toBe(1024);
  });
});
