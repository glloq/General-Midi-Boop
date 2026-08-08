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
 * Samples are returned as Float32Array (typed) — they reach the browser
 * via the GMBP binary wire format (see SF2PresetCodec.js), which avoids
 * the JSON.stringify + gzip + JSON.parse round-trip that dominated cold-
 * load latency before.
 */

import pkg from 'soundfont2';
const { SoundFont2, GeneratorType } = pkg;

const GT = GeneratorType;

// H-3: output limits to prevent DoS from malicious/oversized SF2 files
const MAX_ZONES = 512; // max zones per preset
// 30 s lets piano/harp/plucked decay samples survive intact (typical SF2
// piano sample is ~3–8 s, some legacy banks go higher). Below this the
// natural decay tail was being trimmed, sounding "cut off".
const MAX_SAMPLE_SECS = 30; // max sample duration per zone (seconds)
const MAX_TOTAL_SAMPLES = (20 * 1024 * 1024) / 4; // ~20 MB of Float32 data total

/**
 * Structurally validate the RIFF/sfbk container BEFORE handing bytes to the
 * soundfont2 library. The library iterates records using each chunk's DECLARED
 * 4-byte length without clamping it to the real buffer, so a crafted file whose
 * `phdr`/`pgen`/`igen` length claims ~4 GB (in a 1 KB file) drives the library
 * to allocate objects until it hits a FATAL, uncatchable V8 heap-limit abort —
 * and because blobs are content-addressed, the poison file re-crashes the box on
 * every access (audit B2 C1). We walk the tree once and reject any chunk whose
 * declared length exceeds its container, so no declared length can ever exceed
 * the buffer (bounding allocation to file-size-proportional).
 *
 * @param {Uint8Array} u8
 * @throws {Error} on a malformed/hostile container
 */
export function validateSf2Structure(u8) {
  const len = u8.length;
  if (len < 12) throw new Error('SF2 too short');
  const readU32 = (o) => (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0;
  const tag = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);

  if (tag(0) !== 'RIFF') throw new Error('Not a RIFF file');
  const riffLen = readU32(4);
  if (8 + riffLen > len) throw new Error('RIFF length exceeds file size');
  if (tag(8) !== 'sfbk') throw new Error('Not an sfbk soundfont');

  const end = 8 + riffLen; // guaranteed <= len
  let pos = 12; // after RIFF/size/sfbk
  let chunkGuard = 0;
  while (pos + 8 <= end) {
    if (++chunkGuard > 100000) throw new Error('SF2 has too many top-level chunks');
    const id = tag(pos);
    const size = readU32(pos + 4);
    const body = pos + 8;
    if (body + size > end) throw new Error(`SF2 chunk '${id}' length exceeds container`);
    if (id === 'LIST') {
      const listEnd = body + size;
      let sub = body + 4; // skip the 4-byte list type
      let subGuard = 0;
      while (sub + 8 <= listEnd) {
        if (++subGuard > 2000000) throw new Error('SF2 LIST has too many sub-chunks');
        const subId = tag(sub);
        const subSize = readU32(sub + 4);
        if (sub + 8 + subSize > listEnd) {
          throw new Error(`SF2 sub-chunk '${subId}' length exceeds its LIST`);
        }
        sub += 8 + subSize + (subSize & 1); // RIFF word-alignment padding
      }
    }
    pos = body + size + (size & 1);
  }
}

/**
 * Parse raw SF2 bytes into a SoundFont2 instance. Expensive (~450 ms for a
 * 30 MB SF2), so callers loading multiple presets from the same file should
 * cache the result and feed it into {@link convertPresetFromSF2}.
 *
 * @param {Buffer|Uint8Array} sf2Buffer
 * @returns {SoundFont2}
 */
export function parseSoundFont(sf2Buffer) {
  const bytes = sf2Buffer instanceof Uint8Array ? sf2Buffer : new Uint8Array(sf2Buffer);
  // Reject a malformed/hostile container before the library can over-allocate
  // (audit B2 C1). Throws are caught by the callers' try/catch → graceful.
  validateSf2Structure(bytes);
  return new SoundFont2(bytes);
}

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
  return convertPresetFromSF2(parseSoundFont(sf2Buffer), bankNumber, presetNumber);
}

/**
 * Same as {@link convertPreset} but takes a pre-parsed SoundFont2 instance.
 * Lets the caller amortise the ~450 ms RIFF parse across multiple program
 * lookups from the same file.
 *
 * @param {SoundFont2} sf2
 * @param {number} bankNumber
 * @param {number} presetNumber
 * @returns {{ zones: Array }|null}
 */
export function convertPresetFromSF2(sf2, bankNumber, presetNumber) {
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
      const rootKey =
        overrideRoot?.value != null && overrideRoot.value !== -1
          ? overrideRoot.value
          : hdr.originalPitch;

      // ── Tuning ─────────────────────────────────────────────────────
      const coarseTune = merged[GT.CoarseTune]?.value ?? 0;
      const fineTune = merged[GT.FineTune]?.value ?? 0;

      // ── Scale tuning ───────────────────────────────────────────────
      // SF2 ScaleTuning = cents of pitch change per key away from the
      // root. GM drum/percussion zones set it to 0 → the sample plays at
      // its recorded pitch for ANY key (no transposition). When it is 0
      // the per-zone coarse/fine tune must NOT be applied or percussive
      // samples get pitch-shifted into a sustained tonal "bell" ring.
      const scaleTuning = merged[GT.ScaleTuning]?.value ?? 100;
      const fixedPitch = scaleTuning === 0;

      // ── Loop ───────────────────────────────────────────────────────
      const loopFineStart = merged[GT.StartLoopAddrsOffset]?.value ?? 0;
      const loopFineEnd = merged[GT.EndLoopAddrsOffset]?.value ?? 0;
      const loopCoarseStart = merged[GT.StartLoopAddrsCoarseOffset]?.value ?? 0;
      const loopCoarseEnd = merged[GT.EndLoopAddrsCoarseOffset]?.value ?? 0;

      const loopStart = hdr.startLoop + loopFineStart + loopCoarseStart * 32768;
      const loopEnd = hdr.endLoop + loopFineEnd + loopCoarseEnd * 32768;

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

      // ── Convert Int16 PCM → Float32Array ───────────────────────────
      const f32 = new Float32Array(sampleLength);
      for (let i = 0; i < sampleLength; i++) {
        f32[i] = int16[i] / 32768;
      }

      // If the sample was truncated and the loop region fell past the cut,
      // the loop indices now reference samples that no longer exist. Drop
      // looping for this zone rather than leaving stale indices that WAF
      // would silently mis-interpret (audible as a tiny click loop or a
      // dead note past the truncation point).
      let outLoopStart = loopsEnabled ? loopStart : 0;
      let outLoopEnd = loopsEnabled ? loopEnd : 0;
      if (outLoopEnd > sampleLength || outLoopStart >= sampleLength) {
        outLoopStart = 0;
        outLoopEnd = 0;
      }

      zones.push({
        sample: f32,
        sampleRate: sampleRate,
        loopStart: outLoopStart,
        loopEnd: outLoopEnd,
        keyRangeLow: keyLo,
        keyRangeHigh: keyHi,
        velRangeLow: velLo,
        velRangeHigh: velHi,
        midi: rootKey,
        coarseTune: fixedPitch ? 0 : coarseTune,
        fineTune: fixedPitch ? 0 : fineTune
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
  return Object.keys(bank.presets)
    .map(Number)
    .sort((a, b) => a - b);
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
    return {
      bankNum: 128,
      presets: Object.keys(bank128.presets)
        .map(Number)
        .sort((a, b) => a - b)
    };
  }
  const bank0 = sf2.banks[0];
  if (bank0) {
    return {
      bankNum: 0,
      presets: Object.keys(bank0.presets)
        .map(Number)
        .sort((a, b) => a - b)
    };
  }
  return { bankNum: 0, presets: [] };
}
