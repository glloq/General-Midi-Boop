// tests/frontend/midi-synth-drum-channel-guard.test.js
//
// Two robustness guards on the drum channel of MidiSynthesizer:
//
// 1. `setChannelInstrument(9, program)` validates the program is a GM drum
//    kit. A melodic program (e.g. 2 = Bright Piano) silently mis-routed to
//    channel 9 would, post-bell-fix, fall back to Standard Kit on the
//    backend — audible drums but not the intended sound. Snap to Standard
//    Kit + warn so upstream routing bugs are caught at the source.
//
// 2. `loadDrumKit()` exposes its in-flight promise via
//    `ensureDrumKitReady()`, letting UI callers await it before the first
//    `playNote(_, _, 9, _)` so the first frappe is never silent on cold
//    start (instead of relying on `playNote`'s fire-and-forget lazy load).

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

beforeAll(() => {
  delete window.MidiSynthesizerConstants;
  delete window.MidiSynthesizer;
  new Function(
    readFileSync(resolve(__dirname, '../../public/js/audio/MidiSynthesizerConstants.js'), 'utf8')
  ).call(window);
  new Function(
    readFileSync(resolve(__dirname, '../../public/js/audio/MidiSynthesizer.js'), 'utf8')
  ).call(window);
});

// Build a bare MidiSynthesizer instance shaped enough to exercise
// setChannelInstrument without booting the audio context. We bypass the
// real constructor (which creates an AudioContext) and stamp the minimum
// fields setChannelInstrument touches.
function makeSynthStub() {
  const synth = Object.create(window.MidiSynthesizer.prototype);
  synth.channelInstruments = new Array(16).fill(0);
  synth.channelVolumes = new Array(16).fill(100);
  synth.channelSf2Ids = new Array(16).fill(null);
  synth.channelResolvedBank = new Array(16).fill(null);
  synth.loadedInstruments = new Map();
  synth.loadingInstruments = new Map();
  synth.isInitialized = false; // skip the preload setTimeout branch
  synth.currentBankId = 'sf2:default';
  synth.log = vi.fn();
  return synth;
}

describe('MidiSynthesizer.setChannelInstrument — channel-9 GM-kit validation', () => {
  it('accepts every canonical GM drum kit program (0/8/16/24/25/32/40/48/56)', () => {
    const synth = makeSynthStub();
    for (const p of [0, 8, 16, 24, 25, 32, 40, 48, 56]) {
      synth.setChannelInstrument(9, p);
      expect(synth.channelInstruments[9]).toBe(p);
    }
    expect(synth.log).not.toHaveBeenCalledWith('warn', expect.anything());
  });

  it('accepts offset-encoded kits (program ≥ 128 → decode to a valid kit)', () => {
    const synth = makeSynthStub();
    for (const p of [128, 136, 144, 152, 153, 160, 168, 176, 184]) {
      synth.setChannelInstrument(9, p);
      expect(synth.channelInstruments[9]).toBe(p);
    }
    expect(synth.log).not.toHaveBeenCalledWith('warn', expect.anything());
  });

  it('snaps a melodic program on channel 9 to Standard Kit (0) and warns', () => {
    const synth = makeSynthStub();
    synth.setChannelInstrument(9, 2); // Bright Piano
    expect(synth.channelInstruments[9]).toBe(0);
    expect(synth.log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('setChannelInstrument(9, 2)')
    );
  });

  it('snaps an unknown kit number on channel 9 to Standard Kit (0)', () => {
    const synth = makeSynthStub();
    synth.setChannelInstrument(9, 99);
    expect(synth.channelInstruments[9]).toBe(0);
    expect(synth.log).toHaveBeenCalledWith('warn', expect.anything());
  });

  it('does NOT validate program on melodic channels (any program allowed)', () => {
    const synth = makeSynthStub();
    for (const ch of [0, 1, 2, 5, 8, 10, 11, 15]) {
      synth.setChannelInstrument(ch, 42);
      expect(synth.channelInstruments[ch]).toBe(42);
    }
    expect(synth.log).not.toHaveBeenCalled();
  });
});

describe('MidiSynthesizer.ensureDrumKitReady / loadDrumKit promise tracking', () => {
  beforeEach(() => {
    window.MidiSynthesizer.availableDrumKits?.clear?.();
  });

  function makeLoadableStub() {
    const synth = makeSynthStub();
    synth.audioContext = null;
    synth.drumPresets = new Map();
    synth.sequence = null;
    synth._bankForChannel = () => 'sf2:default';
    return synth;
  }

  it('ensureDrumKitReady resolves immediately when no load is pending', async () => {
    const synth = makeLoadableStub();
    const t0 = Date.now();
    await synth.ensureDrumKitReady();
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it('loadDrumKit stores the in-flight promise on _drumKitLoading and clears it on resolve', async () => {
    const synth = makeLoadableStub();
    const resolvers = [];
    synth._loadDrumPreset = vi.fn(() => new Promise((res) => resolvers.push(res)));
    const loadPromise = synth.loadDrumKit();
    expect(synth._drumKitLoading).not.toBeNull();
    expect(synth._drumKitLoading).toBe(loadPromise);

    // ensureDrumKitReady returns the same in-flight promise.
    const readyPromise = synth.ensureDrumKitReady();
    expect(readyPromise).toBe(synth._drumKitLoading);

    for (const r of resolvers) r();
    await loadPromise;
    expect(synth._drumKitLoading).toBeNull();
  });

  it('loadDrumKit deduplicates concurrent calls', async () => {
    const synth = makeLoadableStub();
    // Eager preload only runs when a sequence is loaded (otherwise the
    // lazy mode returns early without touching _loadDrumPreset, see the
    // "lazy mode" branch below). Stub a 3-note sequence so the fan-out
    // actually fires and gives us something to dedupe against.
    synth.sequence = [
      { c: 9, n: 36, t: 0 },
      { c: 9, n: 38, t: 100 },
      { c: 9, n: 42, t: 200 }
    ];
    const resolvers = [];
    synth._loadDrumPreset = vi.fn(() => new Promise((res) => resolvers.push(res)));
    const p1 = synth.loadDrumKit();
    const p2 = synth.loadDrumKit();
    expect(p1).toBe(p2); // same promise reused
    // Three sequence notes → three _loadDrumPreset calls from the first
    // invocation; the second loadDrumKit() must NOT re-fan-out.
    const callsAfterFirst = synth._loadDrumPreset.mock.calls.length;
    expect(callsAfterFirst).toBe(3);
    for (const r of resolvers) r();
    await p1;
    expect(synth._loadDrumPreset.mock.calls.length).toBe(callsAfterFirst);
  });

  it('loadDrumKit no-sequence mode: preloads the 25 common GM drum notes (35-59)', async () => {
    const synth = makeLoadableStub();
    synth._loadDrumPreset = vi.fn(() => Promise.resolve());
    await synth.loadDrumKit();
    // Common-drums preload kills the per-key lag without paying the
    // full 47-note cost of the legacy eager mode. Notes 60-81
    // (bongos, agogos, claves…) stay lazy.
    expect(synth._loadDrumPreset).toHaveBeenCalledTimes(25);
    const loadedNotes = synth._loadDrumPreset.mock.calls.map((c) => c[0]).sort((a, b) => a - b);
    expect(loadedNotes[0]).toBe(35);
    expect(loadedNotes[loadedNotes.length - 1]).toBe(59);
  });

  it('ensureDrumKitReady resolves after a fresh loadDrumKit finishes', async () => {
    const synth = makeLoadableStub();
    const resolvers = [];
    synth._loadDrumPreset = vi.fn(() => new Promise((res) => resolvers.push(res)));
    const loadP = synth.loadDrumKit();
    const readyP = synth.ensureDrumKitReady();
    let done = false;
    readyP.then(() => {
      done = true;
    });
    expect(done).toBe(false);
    for (const r of resolvers) r();
    await loadP;
    // microtask flush
    await new Promise((res) => setTimeout(res, 0));
    expect(done).toBe(true);
  });
});
