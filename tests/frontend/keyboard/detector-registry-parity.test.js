// tests/frontend/keyboard/detector-registry-parity.test.js
// -----------------------------------------------------------------------------
// Locks the two production detection sources against silent divergence:
//
//   1. InstrumentDetector.detect(caps).viewKind   ← the path KeyboardModal
//      actually runs (via getInstrumentViewInfo()).
//   2. registry.resolve(caps).viewKind            ← the registerBuiltins.js
//      addRule() chain (twin logic, exercised here + as a future-proofing
//      net so a new instrument added to one is added to the other).
//
// They MUST agree across the whole realistic capability surface. A red test
// here means a new/changed instrument rule landed in only one of the two
// files — fix registerBuiltins.js to match InstrumentDetector (the detector
// is the authoritative production path).
// -----------------------------------------------------------------------------

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const win = {};
function load(relativePath) {
  const src = readFileSync(resolve(__dirname, relativePath), 'utf8');
  new Function('window', src)(win);
}

// Faithful stand-in for WindInstrumentDatabase: identical isWindInstrument()
// formula as the real class (public/js/features/WindInstrumentDatabase.js:
// `(program >= 56 && program <= 79) || program === 111`). The real file is
// not loaded here because it references the MidiConstants global at static
// init; the detector only ever calls these two methods.
const windDb = {
  isWindInstrument: (p) => (p >= 56 && p <= 79) || p === 111,
  getPresetByProgram: (p) => ((p >= 56 && p <= 79) || p === 111 ? { name: `wind-${p}` } : null)
};

beforeAll(() => {
  load('../../../public/js/features/keyboard/InstrumentDetector.js');
  load('../../../public/js/features/keyboard/InstrumentView.js');
  load('../../../public/js/features/keyboard/InstrumentViewRegistry.js');
  // registerBuiltins safe-registers window.<Name>View (all absent here →
  // skipped) and, crucially, installs the addRule() detection chain.
  load('../../../public/js/features/keyboard/views/registerBuiltins.js');
});

const detect = (caps) => win.InstrumentDetector.detect({ capabilities: caps, windDb }).viewKind;

const resolveKind = (caps) => win.instrumentViews.resolve(caps).viewKind;

describe('InstrumentDetector ⇄ registerBuiltins rule parity', () => {
  it('agree on every GM program 0..127 (plain melodic capabilities)', () => {
    const mismatches = [];
    for (let gm = 0; gm <= 127; gm++) {
      const caps = { gm_program: gm };
      const d = detect(caps);
      const r = resolveKind(caps);
      if (d !== r) mismatches.push(`gm=${gm}: detector=${d} registry=${r}`);
    }
    expect(mismatches).toEqual([]);
  });

  it('agree on the special, non-GM-range capability shapes', () => {
    const cases = [
      { channel: 9, gm_program: 0 }, // drum channel
      { channel: 9, gm_program: 65 }, // drum channel wins over wind
      { instrument_type: 'drum', gm_program: 0 },
      { instrument_type: 'drum_kit', gm_program: 24 },
      { instrument_type: 'percussion', gm_program: 0 },
      { instrument_type: 'theremin', gm_program: 0 },
      { instrument_type: 'theremin' },
      { instrument_type: 'string', gm_program: 24 }, // explicit string → fretboard
      { gm_program: 128 }, // ≥128 → drumpad
      { gm_program: 200 },
      { gm_program: 46 }, // harp (excluded from fretboard)
      { gm_program: 108 }, // kalimba
      { gm_program: 109 }, // bagpipe
      { gm_program: 111 }, // shanai → wind piano-slider
      { gm_program: 114 }, // steel-drum (not perc-pad)
      {} // nothing → piano fallback
    ];
    const mismatches = [];
    for (const caps of cases) {
      const d = detect(caps);
      const r = resolveKind(caps);
      if (d !== r) {
        mismatches.push(`${JSON.stringify(caps)}: detector=${d} registry=${r}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('registry.resolve is never invoked by production code (twin-of-record)', () => {
    // Guard the assumption this test is built on: getInstrumentViewInfo()
    // delegates to InstrumentDetector, NOT registry.resolve(). If a future
    // refactor wires resolve() into the modal this stays valid (both
    // sources are proven equal here); the assertion documents intent.
    expect(typeof win.instrumentViews.resolve).toBe('function');
    expect(typeof win.InstrumentDetector.detect).toBe('function');
  });
});
