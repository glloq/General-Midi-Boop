// tests/frontend/midi-synth-available-drum-kits.test.js
//
// MidiSynthesizer exposes a per-bank inventory of the GM drum kits the
// active SF2 *actually* contains, fetched from the new /api/sf2/:id/kits
// endpoint. The instrument-settings UI reads this static state to grey out
// kits that aren't in the SF2 (avoiding silent Standard-Kit fallbacks).

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

beforeAll(() => {
  delete window.MidiSynthesizerConstants;
  delete window.MidiSynthesizer;
  // The constants IIFE attaches window.MidiSynthesizerConstants used by
  // MidiSynthesizer.js's top-level destructuring.
  new Function(
    readFileSync(resolve(__dirname, '../../public/js/audio/MidiSynthesizerConstants.js'), 'utf8')
  ).call(window);
  new Function(
    readFileSync(resolve(__dirname, '../../public/js/audio/MidiSynthesizer.js'), 'utf8')
  ).call(window);
});

beforeEach(() => {
  // Each test owns a fresh inventory cache.
  window.MidiSynthesizer.availableDrumKits.clear();
  window.MidiSynthesizer._fetchingDrumKits.clear();
});

describe('MidiSynthesizer.refreshAvailableDrumKits', () => {
  it('fetches /api/sf2/default/kits and caches the Set of kit programs', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ drumKits: [0, 16, 25], drumBank: 128, melodicPrograms: [] })
    });

    const kits = await window.MidiSynthesizer.refreshAvailableDrumKits('sf2:default');

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/sf2/default/kits');
    expect(kits).toBeInstanceOf(Set);
    expect([...kits].sort((a, b) => a - b)).toEqual([0, 16, 25]);
    // The cached value is what getAvailableDrumKits returns synchronously.
    expect(window.MidiSynthesizer.getAvailableDrumKits('sf2:default')).toBe(kits);
  });

  it('translates numeric sf2 banks (`sf2:42`) to /api/sf2/42/kits', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ drumKits: [0], drumBank: 128, melodicPrograms: [] })
    });

    await window.MidiSynthesizer.refreshAvailableDrumKits('sf2:42');
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/sf2/42/kits');
  });

  it('returns null for non-SF2 banks without hitting the network', async () => {
    globalThis.fetch = vi.fn();
    const kits = await window.MidiSynthesizer.refreshAvailableDrumKits('FluidR3_GM');
    expect(kits).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns null on fetch error (and does NOT poison the cache)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'));
    const kits = await window.MidiSynthesizer.refreshAvailableDrumKits('sf2:default');
    expect(kits).toBeNull();
    expect(window.MidiSynthesizer.availableDrumKits.has('sf2:default')).toBe(false);
  });

  it('returns null on non-OK HTTP response (and does NOT cache)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    const kits = await window.MidiSynthesizer.refreshAvailableDrumKits('sf2:default');
    expect(kits).toBeNull();
    expect(window.MidiSynthesizer.availableDrumKits.has('sf2:default')).toBe(false);
  });

  it('deduplicates concurrent in-flight fetches per bank', async () => {
    let resolveFetch;
    globalThis.fetch = vi.fn().mockImplementation(
      () =>
        new Promise((res) => {
          resolveFetch = () =>
            res({
              ok: true,
              json: async () => ({ drumKits: [0, 8], drumBank: 128, melodicPrograms: [] })
            });
        })
    );

    const p1 = window.MidiSynthesizer.refreshAvailableDrumKits('sf2:default');
    // While p1 is pending, a second call must NOT fire a second fetch.
    const p2 = window.MidiSynthesizer.refreshAvailableDrumKits('sf2:default');
    expect(p2).resolves.toBeNull(); // pending → null, not a duplicate fetch

    resolveFetch();
    await p1;
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // After it lands, the cache serves subsequent calls synchronously.
    const kits = window.MidiSynthesizer.getAvailableDrumKits('sf2:default');
    expect([...kits].sort((a, b) => a - b)).toEqual([0, 8]);
  });

  it('dispatches a window event on success so the UI can re-render', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ drumKits: [0, 16], drumBank: 128, melodicPrograms: [] })
    });
    const handler = vi.fn();
    window.addEventListener('midi-synth-drumkits-updated', handler);
    try {
      await window.MidiSynthesizer.refreshAvailableDrumKits('sf2:default');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].detail).toEqual({
        bankId: 'sf2:default',
        kits: [0, 16]
      });
    } finally {
      window.removeEventListener('midi-synth-drumkits-updated', handler);
    }
  });
});

describe('MidiSynthesizer.getAvailableDrumKits', () => {
  it('returns null until a fetch has resolved', () => {
    expect(window.MidiSynthesizer.getAvailableDrumKits('sf2:default')).toBeNull();
  });

  it('returns null for an SF2 bank with no kit inventory yet', () => {
    expect(window.MidiSynthesizer.getAvailableDrumKits('sf2:42')).toBeNull();
  });
});
