// tests/frontend/sound-banks-default-local.test.js
//
// Regression guard for the “no public CDN by default” rule. The synth must
// boot with a local SF2 bank and never advertise the legacy WAF banks
// (surikov.github.io) unless the user has explicitly opted in via
// `useExternalWaf = true` in localStorage.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SRC_PATH = resolve(__dirname, '../../public/js/audio/MidiSynthesizerConstants.js');
const SRC = readFileSync(SRC_PATH, 'utf8');

function loadConstants() {
  // The constants file is an IIFE that writes to window. Run it in the
  // current jsdom window to materialise window.MidiSynthesizerConstants.
  delete window.MidiSynthesizerConstants;
  // eslint-disable-next-line no-new-func
  new Function(SRC).call(window);
  return window.MidiSynthesizerConstants;
}

describe('MidiSynthesizerConstants — offline-first defaults', () => {
  beforeEach(() => {
    try { localStorage.clear(); } catch (e) { /* jsdom */ }
  });

  it('DEFAULT_BANK_ID is sf2: prefixed', () => {
    const C = loadConstants();
    expect(C.DEFAULT_BANK_ID).toMatch(/^sf2:/);
  });

  it('DEFAULT_BANK_ID points to the built-in default soundfont', () => {
    const C = loadConstants();
    expect(C.DEFAULT_BANK_ID).toBe('sf2:default');
  });

  it('getAvailableBanks() lists the built-in default first', () => {
    const C = loadConstants();
    const banks = C.getAvailableBanks();
    expect(banks.length).toBeGreaterThan(0);
    expect(banks[0].id).toBe('sf2:default');
  });

  it('getAvailableBanks() includes the legacy WAF banks (opt-in via selection, not by default request)', () => {
    const C = loadConstants();
    const ids = C.getAvailableBanks().map((b) => b.id);
    // Built-in default + at least one legacy WAF bank stay reachable.
    expect(ids).toContain('sf2:default');
    expect(ids).toContain('FluidR3_GM');
  });

  it('WAF entries carry requiresExternal so the UI can warn before selection', () => {
    const C = loadConstants();
    const waf = C.getAvailableBanks().find((b) => b.id === 'FluidR3_GM');
    expect(waf).toBeTruthy();
    expect(waf.requiresExternal).toBe(true);
    // The built-in default never triggers an external request.
    const def = C.getAvailableBanks().find((b) => b.id === 'sf2:default');
    expect(def.requiresExternal).toBeFalsy();
  });

  it('setCustomBanks() keeps the default bank first and inserts custom banks before WAF ones', () => {
    const C = loadConstants();
    C.setCustomBanks([{ id: 42, label: 'My SF2', size: 1234567, reverbMix: 0.2 }]);
    const banks = C.getAvailableBanks();
    expect(banks[0].id).toBe('sf2:default');
    expect(banks.find((b) => b.id === 'sf2:42')).toBeTruthy();
    expect(banks.find((b) => b.id === 'FluidR3_GM')).toBeTruthy();
  });
});

describe('MidiSynthesizer.js — no hard-coded surikov CDN fallback for the default bank', () => {
  it('the script-injection fallback in loadInstrument no longer points to surikov.github.io', () => {
    const synthSrc = readFileSync(
      resolve(__dirname, '../../public/js/audio/MidiSynthesizer.js'),
      'utf8'
    );
    // The two helper functions (_buildDrumPresetEntry, _legacyJCLiveEntry,
    // createGMInstrumentMap) still know the CDN URL — they're only reached
    // for legacy WAF banks when the user has opted in. Count occurrences
    // and assert no NEW fallback path was reintroduced in loadInstrument().
    const loadInstrumentBlock = synthSrc.match(/async\s+loadInstrument\s*\([\s\S]*?\n {4}}/);
    expect(loadInstrumentBlock).toBeTruthy();
    expect(loadInstrumentBlock[0]).not.toMatch(/surikov\.github\.io/);
  });
});
