/**
 * @file src/files/SF2PresetCodec.js
 * @description Binary wire/cache format for converted SF2 presets.
 *
 * The legacy JSON encoding spent ~3× the time of the actual sample data
 * doing JSON.stringify / JSON.parse / gzip on a multi-MB text payload of
 * decimal floats. This codec keeps the sample data as raw little-endian
 * Float32 bytes and only JSON-encodes the per-zone metadata.
 *
 * Layout:
 *   0   4   magic           "GMBP" (ASCII)
 *   4   4   version         uint32 LE = 1
 *   8   4   metaLen         uint32 LE, byte length of the metadata JSON
 *   12  M   metadata        UTF-8 JSON: { zones: [{ sampleOffset, sampleLength,
 *                             sampleRate, loopStart, loopEnd, keyRangeLow,
 *                             keyRangeHigh, velRangeLow, velRangeHigh, midi,
 *                             coarseTune, fineTune }] }
 *   12+M S  samples         Concatenated Float32 LE, one slice per zone at
 *                             the zone's sampleOffset/sampleLength.
 *
 * Endianness: both the Pi (ARM) and every browser-supported architecture
 * we care about run little-endian, and Float32Array uses host byte order,
 * so we read/write LE on the wire without an explicit swap. If a big-
 * endian client ever shows up the decode helper would need a DataView pass.
 */

// 'GMBP' ASCII as a uint32 read little-endian: byte[0]='G'=0x47 is LSB,
// so the numeric value is 0x50_42_4d_47.
const MAGIC = 0x50_42_4d_47;
const VERSION = 1;
const HEADER_BYTES = 12; // magic + version + metaLen

/**
 * Quick check for the binary format — used to distinguish new wire-format
 * payloads from legacy gzipped-JSON cache entries.
 * @param {Buffer|Uint8Array} buf
 * @returns {boolean}
 */
export function looksLikeBinaryPreset(buf) {
  if (!buf || buf.length < HEADER_BYTES) return false;
  return buf[0] === 0x47 && buf[1] === 0x4d && buf[2] === 0x42 && buf[3] === 0x50;
}

/**
 * Encode a converted preset (zones with Float32Array `sample`) into a single
 * Buffer in the GMBP wire format.
 * @param {{ zones: Array }} preset
 * @returns {Buffer}
 */
export function encodePreset(preset) {
  const zones = preset.zones || [];
  let totalSamples = 0;
  const metaZones = new Array(zones.length);
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i];
    const f32 = z.sample;
    const len = f32 ? f32.length : 0;
    metaZones[i] = {
      sampleOffset: totalSamples,   // in Float32 units
      sampleLength: len,
      sampleRate:   z.sampleRate,
      loopStart:    z.loopStart,
      loopEnd:      z.loopEnd,
      keyRangeLow:  z.keyRangeLow,
      keyRangeHigh: z.keyRangeHigh,
      velRangeLow:  z.velRangeLow,
      velRangeHigh: z.velRangeHigh,
      midi:         z.midi,
      coarseTune:   z.coarseTune,
      fineTune:     z.fineTune,
    };
    totalSamples += len;
  }

  const meta = JSON.stringify({ zones: metaZones });
  const metaBuf = Buffer.from(meta, 'utf8');
  const sampleBytes = totalSamples * 4;
  const out = Buffer.allocUnsafe(HEADER_BYTES + metaBuf.length + sampleBytes);

  out.writeUInt32LE(MAGIC,       0);
  out.writeUInt32LE(VERSION,     4);
  out.writeUInt32LE(metaBuf.length, 8);
  metaBuf.copy(out, HEADER_BYTES);

  let off = HEADER_BYTES + metaBuf.length;
  for (let i = 0; i < zones.length; i++) {
    const f32 = zones[i].sample;
    if (!f32 || f32.length === 0) continue;
    // Float32Array → bytes view at its current alignment. Works for the
    // common case where `sample` is a fresh Float32Array (offset 0).
    const src = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
    src.copy(out, off);
    off += f32.byteLength;
  }

  return out;
}

/**
 * Decode a GMBP buffer back into a preset whose zones carry Float32Array
 * `sample` views over the original byte buffer. Used by the L2 cache reader
 * and by tests.
 * @param {Buffer|ArrayBuffer|Uint8Array} input
 * @returns {{ zones: Array }}
 */
export function decodePreset(input) {
  const buf = input instanceof ArrayBuffer
    ? Buffer.from(input)
    : (Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength));
  if (!looksLikeBinaryPreset(buf)) {
    throw new Error('SF2PresetCodec: not a GMBP buffer');
  }
  const version = buf.readUInt32LE(4);
  if (version !== VERSION) {
    throw new Error(`SF2PresetCodec: unsupported version ${version}`);
  }
  const metaLen = buf.readUInt32LE(8);
  const meta = JSON.parse(buf.slice(HEADER_BYTES, HEADER_BYTES + metaLen).toString('utf8'));
  const sampleBase = HEADER_BYTES + metaLen;
  const zones = meta.zones.map(z => {
    // Float32Array view over the underlying ArrayBuffer at the right offset.
    // The byteOffset must be 4-aligned, which it always is because metaLen
    // and HEADER_BYTES are not — we re-copy into a fresh ArrayBuffer to
    // guarantee alignment. Cheap: copy is contiguous and ≪ JSON.parse cost.
    const byteOffset = sampleBase + z.sampleOffset * 4;
    const slice = buf.buffer.slice(buf.byteOffset + byteOffset,
                                   buf.byteOffset + byteOffset + z.sampleLength * 4);
    return {
      sample:       new Float32Array(slice),
      sampleRate:   z.sampleRate,
      loopStart:    z.loopStart,
      loopEnd:      z.loopEnd,
      keyRangeLow:  z.keyRangeLow,
      keyRangeHigh: z.keyRangeHigh,
      velRangeLow:  z.velRangeLow,
      velRangeHigh: z.velRangeHigh,
      midi:         z.midi,
      coarseTune:   z.coarseTune,
      fineTune:     z.fineTune,
    };
  });
  return { zones };
}
