/**
 * @file src/files/SF2Converter.js
 * @description Convert SF2 soundfont presets into WAF-compatible zone arrays
 * that MidiSynthesizer can feed directly into player.adjustPreset().
 *
 * WAF preset shape expected by the browser engine:
 *   { zones: [{ sample: Float32Array, sampleRate, loopStart, loopEnd,
 *               keyRangeLow, keyRangeHigh, velRangeLow, velRangeHigh,
 *               midi, coarseTune, fineTune }] }
 *
 * We transmit `sample` as a regular Array so it survives JSON serialisation;
 * the client reconstructs it with `new Float32Array(zone.sample)`.
 */

import { SoundFont2, GeneratorType } from 'soundfont2';

const GT = GeneratorType;

// H-3: output limits to prevent DoS from malicious/oversized SF2 files
const MAX_ZONES       = 512;                       // max zones per preset
const MAX_SAMPLE_SECS = 10;                        // max sample duration per zone (seconds)
const MAX_TOTAL_SAMPLES = 20 * 1024 * 1024 / 4;  // ~20 MB of Float32 data total

/**
 * Convert one SF2 preset (identified by bankNumber + presetNumber) into a
 * WAF-compatible preset object, or return null if the preset is absent.
 *
 * @param {Buffer|Uint8Array} sf2Buffer  - Raw SF2 file bytes
 * @param {number} bankNumber            - 0 = melodic, 128 = GM drums
 * @param {number} presetNumber          - GM program (melodic) or kit (drums)
 * @returns {{ zones: Array }|null}
 */
export function convertPreset(sf2Buffer, bankNumber, presetNumber) {
  const sf2 = new SoundFont2(new Uint8Array(sf2Buffer));

  const bank = sf2.banks[bankNumber];
  if (!bank) return null;
  const preset = bank.presets[presetNumber];
  if (!preset) return null;

  const zones = [];
  let totalSamples = 0;

  for (const presetZone of preset.zones) {
    const instrument = presetZone.instrument;
    if (!instrument) continue;

    const presetGens = presetZone.generators || {};

    for (const instrZone of instrument.zones) {
      const sample = instrZone.sample;
      if (!sample) continue;

      const hdr = sample.header;
      const gens = instrZone.generators || {};

      // Merge preset-level generators into instrument-level (instrument wins per SF2 spec)
      const merged = Object.assign({}, presetGens, gens);

      // ── Key range ──────────────────────────────────────────────────
      const keyRange = merged[GT.KeyRange];
      const keyLo = keyRange?.range?.lo ?? 0;
      const keyHi = keyRange?.range?.hi ?? 127;

      // ── Velocity range ─────────────────────────────────────────────
      const velRange = merged[GT.VelRange];
      const velLo = velRange?.range?.lo ?? 0;
      const velHi = velRange?.range?.hi ?? 127;

      // ── Root key ───────────────────────────────────────────────────
      const overrideRoot = merged[GT.OverridingRootKey];
      const rootKey = (overrideRoot?.value != null && overrideRoot.value !== -1)
        ? overrideRoot.value
        : hdr.originalPitch;

      // ── Tuning ─────────────────────────────────────────────────────
      const coarseTune = merged[GT.CoarseTune]?.value ?? 0;
      const fineTune   = merged[GT.FineTune]?.value   ?? 0;

      // ── Loop ───────────────────────────────────────────────────────
      const loopFineStart   = merged[GT.StartLoopAddrsOffset]?.value       ?? 0;
      const loopFineEnd     = merged[GT.EndLoopAddrsOffset]?.value         ?? 0;
      const loopCoarseStart = merged[GT.StartLoopAddrsCoarseOffset]?.value ?? 0;
      const loopCoarseEnd   = merged[GT.EndLoopAddrsCoarseOffset]?.value   ?? 0;

      const loopStart = hdr.startLoop + loopFineStart + loopCoarseStart * 32768;
      const loopEnd   = hdr.endLoop   + loopFineEnd   + loopCoarseEnd   * 32768;

      // ── Sample modes (SampleModes bit 0 = loop) ────────────────────
      const sampleModes = merged[GT.SampleModes]?.value ?? 0;
      const loopsEnabled = (sampleModes & 1) !== 0;

      // ── H-3: enforce per-zone sample length cap ────────────────────
      const int16 = sample.data; // Int16Array already sliced to [start, end)
      const sampleRate = hdr.sampleRate > 0 ? hdr.sampleRate : 44100;
      const maxSamples = Math.ceil(MAX_SAMPLE_SECS * sampleRate);
      const sampleLength = Math.min(int16.length, maxSamples);

      // H-3: enforce total output size cap (abandon conversion if exceeded)
      totalSamples += sampleLength;
      if (zones.length >= MAX_ZONES || totalSamples > MAX_TOTAL_SAMPLES) break;

      // ── Convert Int16 PCM → JSON-serialisable plain Array (Float32) ─
      const float32arr = new Array(sampleLength);
      for (let i = 0; i < sampleLength; i++) {
        float32arr[i] = int16[i] / 32768;
      }

      zones.push({
        sample:       float32arr,
        sampleRate:   sampleRate,
        loopStart:    loopsEnabled ? loopStart : 0,
        loopEnd:      loopsEnabled ? loopEnd   : 0,
        keyRangeLow:  keyLo,
        keyRangeHigh: keyHi,
        velRangeLow:  velLo,
        velRangeHigh: velHi,
        midi:         rootKey,
        coarseTune:   coarseTune,
        fineTune:     fineTune,
      });
    }
    // Also break outer loop if limits are reached
    if (zones.length >= MAX_ZONES || totalSamples > MAX_TOTAL_SAMPLES) break;
  }

  return zones.length ? { zones } : null;
}

/**
 * Return the set of available melodic preset numbers (bank 0) in an SF2.
 * @param {Buffer|Uint8Array} sf2Buffer
 * @returns {number[]}
 */
export function listMelodicPrograms(sf2Buffer) {
  const sf2 = new SoundFont2(new Uint8Array(sf2Buffer));
  const bank = sf2.banks[0];
  if (!bank) return [];
  return Object.keys(bank.presets).map(Number).sort((a, b) => a - b);
}

/**
 * Return the set of available drum preset numbers (bank 128 first, bank 0 fallback).
 * @param {Buffer|Uint8Array} sf2Buffer
 * @returns {{ bankNum: number, presets: number[] }}
 */
export function listDrumKits(sf2Buffer) {
  const sf2 = new SoundFont2(new Uint8Array(sf2Buffer));
  const bank128 = sf2.banks[128];
  if (bank128) {
    return { bankNum: 128, presets: Object.keys(bank128.presets).map(Number).sort((a, b) => a - b) };
  }
  const bank0 = sf2.banks[0];
  if (bank0) {
    return { bankNum: 0, presets: Object.keys(bank0.presets).map(Number).sort((a, b) => a - b) };
  }
  return { bankNum: 0, presets: [] };
}
