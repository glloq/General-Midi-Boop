// tests/sf2-preset-service-drum-fallback.test.js
//
// Regression guard for the "drums sound like a bell" bug. When an SF2
// lacks the requested drum kit in bank 128, the service used to fall
// straight back to bank 0 with the same program number — returning a
// MELODIC instrument (e.g. program 8 = Celesta) which the synthesizer
// then played at the drum note's pitch, producing a sustained bell ring.
//
// The fix changes the cascade to (128, kit) → (128, 0) → (0, kit) → (0, 0),
// so a missing Room Kit (8) is replaced by the Standard Kit (128, 0)
// rather than by Celesta (0, 8). The bank-0 step survives only as a
// last-resort tolerance for non-conformant SF2 files that stash kits
// outside the GM drum bank.

import { jest } from '@jest/globals';

// The fake "preset" returned by convertPresetFromSF2 carries the (bank,
// program) it was asked for, encoded inside the zone (which survives the
// service's per-note filter, unlike a top-level _origin field). This lets
// the test assert which branch of the cascade actually fired.
function presetFor(bank, program) {
  return {
    zones: [
      {
        _origin: { bank, program },
        sample: new Float32Array(8),
        sampleRate: 44100,
        loopStart: 0,
        loopEnd: 0,
        keyRangeLow: 0,
        keyRangeHigh: 127,
        velRangeLow: 0,
        velRangeHigh: 127,
        midi: 60,
        coarseTune: 0,
        fineTune: 0
      }
    ]
  };
}

function originOf(preset) {
  return preset && preset.zones && preset.zones[0] ? preset.zones[0]._origin : undefined;
}

// Per-test list of (bank, program) pairs the mocked SF2 "contains". The
// mocked convertPresetFromSF2 returns a preset only for pairs in this set.
let availablePresets;

await jest.unstable_mockModule('../src/files/SF2Converter.js', () => ({
  parseSoundFont: jest.fn(() => ({ banks: {} })),
  convertPresetFromSF2: jest.fn((_sf2, bank, program) => {
    const key = `${bank}:${program}`;
    return availablePresets.has(key) ? presetFor(bank, program) : null;
  })
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

function makeService() {
  const database = makeFakeDB();
  const cache = new AnalysisCache({ maxBytes: 1024 * 1024, maxSize: 256 });
  return new SF2PresetService({
    dataDir: '/tmp/gmboop-drum-fallback-test',
    database,
    logger: { info() {}, warn() {}, error() {} },
    cache
  });
}

describe('SF2PresetService — drum cascade fallback (bell-bug fix)', () => {
  beforeEach(() => {
    convertPresetFromSF2.mockClear();
    availablePresets = new Set();
  });

  test('SF2 with only Standard Kit (128, 0): kit=8 request falls back to (128, 0), NOT (0, 8)', async () => {
    // Simulate the GeneralUser GS default: only the Standard Kit is in bank 128.
    availablePresets.add('128:0');
    // Plus a full melodic bank 0 — including program 8 (Celesta) which is
    // exactly what the old code would return for kit 8 (the bell sound).
    for (let p = 0; p < 128; p++) availablePresets.add(`0:${p}`);

    const svc = makeService();
    const preset = await svc.getPreset('default', 'drum', 0, /* kit */ 8, /* note */ 38);

    expect(preset).not.toBeNull();
    // Critical: the returned preset MUST come from bank 128 (Standard Kit),
    // not from bank 0 program 8 (Celesta, the bell).
    expect(originOf(preset)).toEqual({ bank: 128, program: 0 });
    expect(originOf(preset).bank).not.toBe(0);
  });

  test('SF2 with Power Kit (128, 16): kit=16 request returns it directly', async () => {
    availablePresets.add('128:0');
    availablePresets.add('128:16');
    for (let p = 0; p < 128; p++) availablePresets.add(`0:${p}`);

    const svc = makeService();
    const preset = await svc.getPreset('default', 'drum', 0, 16, 38);

    expect(preset).not.toBeNull();
    expect(originOf(preset)).toEqual({ bank: 128, program: 16 });
  });

  test('SF2 with no bank-128 presets at all: returns null (no melodic fallback)', async () => {
    // Pure-melodic SF2 with no drum bank — must return null so the
    // synthesizer stays silent on that note. The earlier behaviour
    // (cascade to bank 0) let melodic samples slip through with a
    // forced root, producing the bell timbre this test exists to
    // prevent. Silence is unambiguously diagnosable, bells are not.
    for (let p = 0; p < 128; p++) availablePresets.add(`0:${p}`);

    const svc = makeService();
    const preset = await svc.getPreset('default', 'drum', 0, 0, 38);

    expect(preset).toBeNull();
  });

  test('SF2 with Standard Kit only: kit=25 (TR-808) request returns Standard, NOT Steel Guitar', async () => {
    availablePresets.add('128:0');
    // Steel Guitar (0, 25) — the bell-bug equivalent for the TR-808 kit.
    for (let p = 0; p < 128; p++) availablePresets.add(`0:${p}`);

    const svc = makeService();
    const preset = await svc.getPreset('default', 'drum', 0, 25, 36);

    expect(preset).not.toBeNull();
    expect(originOf(preset)).toEqual({ bank: 128, program: 0 });
  });

  test('Completely empty SF2 (no presets in either bank): returns null', async () => {
    const svc = makeService();
    const preset = await svc.getPreset('default', 'drum', 0, 0, 38);
    expect(preset).toBeNull();
  });

  test('Cascade short-circuits on first hit — no extra convertPresetFromSF2 calls', async () => {
    availablePresets.add('128:8');
    for (let p = 0; p < 128; p++) availablePresets.add(`0:${p}`);

    const svc = makeService();
    await svc.getPreset('default', 'drum', 0, 8, 38);

    // First branch (128, 8) hits → no fallback probes.
    expect(convertPresetFromSF2).toHaveBeenCalledTimes(1);
    expect(convertPresetFromSF2).toHaveBeenCalledWith(expect.anything(), 128, 8);
  });
});

// The GeneralUser GS Standard Kit ships a "catch-all" zone (range
// [0-64]) alongside the per-note zones. Both cover the requested drum
// note, but only the narrow per-note zone is actually meant to fire —
// the wide one is a fallback. Pre-fix, both got materialised on every
// drum hit, and the catch-all sample bled through as a tonal ring
// layered over each percussion (the user-reported "cloche").
describe('SF2PresetService — narrowest-zone filter (catch-all bleed-through)', () => {
  beforeEach(() => {
    availablePresets = new Set();
  });

  function presetWithZones(zones) {
    return { zones };
  }

  test('drops the wide catch-all zone when a per-note zone exists for the same note', async () => {
    // Hand-craft a Standard Kit with two zones covering note 36 (kick):
    //   - dedicated kick zone (range exactly [36,36])
    //   - catch-all zone (range [0,64]) — the bell.
    // The filter must keep only the dedicated zone.
    convertPresetFromSF2.mockImplementationOnce(() =>
      presetWithZones([
        {
          keyRangeLow: 36,
          keyRangeHigh: 36,
          _tag: 'kick',
          sample: new Float32Array(8),
          sampleRate: 29762
        },
        {
          keyRangeLow: 0,
          keyRangeHigh: 64,
          _tag: 'catch-all',
          sample: new Float32Array(8),
          sampleRate: 44100
        }
      ])
    );
    availablePresets.add('128:0');

    const svc = makeService();
    const preset = await svc.getPreset('default', 'drum', 0, 0, 36);

    expect(preset).not.toBeNull();
    expect(preset.zones.length).toBe(1);
    expect(preset.zones[0]._tag).toBe('kick');
  });

  test('keeps the catch-all zone when no dedicated per-note zone exists (better than silence)', async () => {
    // Note 35: only the wide catch-all covers it (some SF2 banks
    // don't ship a dedicated sample for the unused-low drum notes).
    convertPresetFromSF2.mockImplementationOnce(() =>
      presetWithZones([
        {
          keyRangeLow: 36,
          keyRangeHigh: 36,
          _tag: 'kick',
          sample: new Float32Array(8),
          sampleRate: 29762
        },
        {
          keyRangeLow: 0,
          keyRangeHigh: 64,
          _tag: 'catch-all',
          sample: new Float32Array(8),
          sampleRate: 44100
        }
      ])
    );
    availablePresets.add('128:0');

    const svc = makeService();
    const preset = await svc.getPreset('default', 'drum', 0, 0, 35);

    expect(preset).not.toBeNull();
    expect(preset.zones.length).toBe(1);
    expect(preset.zones[0]._tag).toBe('catch-all');
  });

  test('preserves velocity round-robin: multiple same-width zones all kept', async () => {
    // Snare with 3 velocity layers all sharing the same key range.
    convertPresetFromSF2.mockImplementationOnce(() =>
      presetWithZones([
        {
          keyRangeLow: 38,
          keyRangeHigh: 38,
          velRangeLow: 0,
          velRangeHigh: 63,
          _tag: 'soft',
          sample: new Float32Array(8),
          sampleRate: 44100
        },
        {
          keyRangeLow: 38,
          keyRangeHigh: 38,
          velRangeLow: 64,
          velRangeHigh: 95,
          _tag: 'med',
          sample: new Float32Array(8),
          sampleRate: 44100
        },
        {
          keyRangeLow: 38,
          keyRangeHigh: 38,
          velRangeLow: 96,
          velRangeHigh: 127,
          _tag: 'hard',
          sample: new Float32Array(8),
          sampleRate: 44100
        },
        {
          keyRangeLow: 0,
          keyRangeHigh: 64,
          _tag: 'catch-all',
          sample: new Float32Array(8),
          sampleRate: 44100
        }
      ])
    );
    availablePresets.add('128:0');

    const svc = makeService();
    const preset = await svc.getPreset('default', 'drum', 0, 0, 38);

    expect(preset).not.toBeNull();
    expect(preset.zones.length).toBe(3);
    expect(preset.zones.map((z) => z._tag).sort()).toEqual(['hard', 'med', 'soft']);
  });
});

describe('SF2PresetService — drum kit inventory introspection', () => {
  beforeEach(() => {
    availablePresets = new Set();
  });

  test('inspectDrumKits enumerates bank-128 programs', () => {
    // Use a real SF2 stub instead of going through convertPresetFromSF2:
    // inspectDrumKits walks sf2.banks directly.
    const svc = makeService();
    // Patch the instance cache to return a hand-crafted SF2 graph.
    svc._sf2Instances = {
      getForPath: () => ({
        banks: {
          128: { presets: { 0: {}, 16: {}, 25: {} } },
          0: { presets: { 0: {}, 8: {}, 16: {} } }
        }
      })
    };
    const { bankNum, kits } = svc.inspectDrumKits('default');
    expect(bankNum).toBe(128);
    expect(kits).toEqual([0, 16, 25]);
  });

  test('inspectDrumKits falls back to bank 0 when bank 128 is empty', () => {
    const svc = makeService();
    svc._sf2Instances = {
      getForPath: () => ({
        banks: { 0: { presets: { 0: {}, 25: {}, 40: {} } } }
      })
    };
    const { bankNum, kits } = svc.inspectDrumKits('default');
    expect(bankNum).toBe(0);
    expect(kits).toEqual([0, 25, 40]);
  });

  test('inspectMelodicPrograms returns bank-0 programs sorted', () => {
    const svc = makeService();
    svc._sf2Instances = {
      getForPath: () => ({
        banks: { 0: { presets: { 8: {}, 0: {}, 40: {}, 1: {} } } }
      })
    };
    expect(svc.inspectMelodicPrograms('default')).toEqual([0, 1, 8, 40]);
  });
});
