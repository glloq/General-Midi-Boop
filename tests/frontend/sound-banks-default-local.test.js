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

  it('getAvailableBanks() returns only sf2: ids when useExternalWaf is off (default)', () => {
    const C = loadConstants();
    const banks = C.getAvailableBanks();
    expect(banks.length).toBeGreaterThan(0);
    for (const b of banks) {
      expect(b.id).toMatch(/^sf2:/);
    }
  });

  it('getAvailableBanks() does not expose any surikov.github.io URL in suffix form', () => {
    const C = loadConstants();
    const banks = C.getAvailableBanks();
    for (const b of banks) {
      expect(b.suffix).toBeFalsy();
    }
  });

  it('opting into useExternalWaf re-exposes the legacy WAF banks', () => {
    localStorage.setItem('gmboop_settings', JSON.stringify({ useExternalWaf: true }));
    const C = loadConstants();
    const banks = C.getAvailableBanks();
    const ids = banks.map((b) => b.id);
    expect(ids).toContain('sf2:default');
    expect(ids).toContain('FluidR3_GM');
  });

  it('setCustomBanks() keeps the default bank in the list', () => {
    const C = loadConstants();
    C.setCustomBanks([{ id: 42, label: 'My SF2', size: 1234567, reverbMix: 0.2 }]);
    const banks = C.getAvailableBanks();
    expect(banks.find((b) => b.id === 'sf2:default')).toBeTruthy();
    expect(banks.find((b) => b.id === 'sf2:42')).toBeTruthy();
    for (const b of banks) expect(b.id).toMatch(/^sf2:/);
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
