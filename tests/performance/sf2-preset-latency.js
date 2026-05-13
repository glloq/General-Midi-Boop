#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * @file tests/performance/sf2-preset-latency.js
 * @description End-to-end latency breakdown for a cold SF2 preset load.
 *
 * Mimics the production pipeline (without spinning up the HTTP server)
 * so we can attribute the 5-15s cold-load time to specific stages:
 *
 *   1. fs.readFileSync (SF2 from disk)
 *   2. SoundFont2 RIFF parse (soundfont2 lib)
 *   3. convertPreset → WAF zone array (Int16 → Float Array)
 *   4. JSON.stringify (server serialisation)
 *   5. gzip (compression middleware approximation)
 *   6. JSON.parse  (browser deserialisation)
 *   7. Float32Array reconstruction + size of payload
 *
 * Step 8 (AudioContext.createBuffer + getChannelData().set) cannot run in
 * Node — we report payload size so the browser-side cost can be inferred.
 *
 * Run:   node tests/performance/sf2-preset-latency.js [program]
 * Program defaults to 0 (Acoustic Grand Piano), the worst case in GM.
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { performance } from 'perf_hooks';
import { fileURLToPath } from 'url';
import pkg from 'soundfont2';

import { convertPreset, parseSoundFont, convertPresetFromSF2 } from '../../src/files/SF2Converter.js';
import { encodePreset, decodePreset } from '../../src/files/SF2PresetCodec.js';

const { SoundFont2 } = pkg;
const __filename = fileURLToPath(import.meta.url);
const SF2_PATH = path.resolve(path.dirname(__filename), '../../assets/sf2/default.sf2');

const program = Number(process.argv[2] ?? 0);

function fmt(ms) {
  return `${ms.toFixed(1).padStart(8)} ms`;
}
function mb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
function section(title) {
  console.log(`\n── ${title} ─────────────────────────────────────────`);
}

function timed(label, fn) {
  if (global.gc) global.gc();
  const t0 = performance.now();
  const out = fn();
  const elapsed = performance.now() - t0;
  console.log(`  ${label.padEnd(38)} ${fmt(elapsed)}`);
  return { out, elapsed };
}

async function main() {
  console.log(`SF2 cold-load latency breakdown — program ${program}`);
  console.log(`SF2 file: ${SF2_PATH}`);
  if (!fs.existsSync(SF2_PATH)) {
    console.error('  ERROR: default.sf2 not present. Run `npm run install-default-sf2`.');
    process.exit(1);
  }
  console.log(`  size: ${mb(fs.statSync(SF2_PATH).size)}`);

  section('1. fs.readFileSync (SF2 from disk)');
  const { out: sf2Buf, elapsed: tDisk } = timed('readFileSync', () => fs.readFileSync(SF2_PATH));

  section('2. SoundFont2 RIFF parse + index');
  // Done inside convertPreset, but isolate it once for attribution.
  const { elapsed: tParse } = timed('new SoundFont2()', () => new SoundFont2(new Uint8Array(sf2Buf)));

  section('3. convertPreset (Int16 PCM → WAF zone array, Float32Array)');
  const { out: preset, elapsed: tConvert } = timed('convertPreset', () => convertPreset(sf2Buf, 0, program));
  if (!preset) {
    console.error(`  ERROR: preset ${program} not found.`);
    process.exit(1);
  }
  let totalSamples = 0;
  for (const z of preset.zones) totalSamples += z.sample.length;
  console.log(`  zones=${preset.zones.length}  total samples=${totalSamples.toLocaleString()}  (~${mb(totalSamples * 4)} as Float32)`);

  // ── Legacy JSON path (for comparison) ────────────────────────────────────
  console.log('\n[Legacy JSON path — for comparison]');
  // Simulate the old shape: convertPreset used to return Array<number>.
  const legacyPreset = {
    zones: preset.zones.map(z => ({ ...z, sample: Array.from(z.sample) })),
  };
  section('4a. JSON.stringify (legacy)');
  const { out: json, elapsed: tStringify } = timed('JSON.stringify(preset)', () => JSON.stringify(legacyPreset));
  console.log(`  json size: ${mb(json.length)}`);

  section('5a. gzip level 6 (legacy compression path)');
  const { out: gz, elapsed: tGzip } = timed('zlib.gzipSync (level 6)', () => zlib.gzipSync(Buffer.from(json)));
  console.log(`  gzipped: ${mb(gz.length)} (${(gz.length / json.length * 100).toFixed(1)}% of raw)`);

  section('6a. JSON.parse (legacy browser)');
  const { out: parsed, elapsed: tParse2 } = timed('JSON.parse(json)', () => JSON.parse(json));

  section('7a. Float32Array reconstruction (legacy materialise)');
  const { elapsed: tMaterialise } = timed('new Float32Array(zone.sample) ×N', () => {
    for (const z of parsed.zones) {
      const f32 = new Float32Array(z.sample);
      void f32;
    }
  });

  // ── New binary GMBP path ────────────────────────────────────────────────
  console.log('\n[GMBP binary path — new]');
  section('4b. encodePreset (server, binary)');
  const { out: wire, elapsed: tEncode } = timed('encodePreset(preset)', () => encodePreset(preset));
  console.log(`  binary size: ${mb(wire.length)}`);

  section('5b. (no compression — octet-stream skipped by middleware)');
  console.log(`  payload on wire: ${mb(wire.length)} raw bytes`);

  section('6b. decodePreset (client, binary)');
  const { elapsed: tDecode } = timed('decodePreset(arrayBuffer)', () => {
    const ab = wire.buffer.slice(wire.byteOffset, wire.byteOffset + wire.byteLength);
    decodePreset(ab);
  });

  section('Summary — legacy JSON path');
  const legacyStages = [
    ['1. fs.readFileSync',          tDisk],
    ['2. SoundFont2 parse',         tParse],
    ['3. convertPreset',            tConvert],
    ['4. JSON.stringify',           tStringify],
    ['5. gzip (level 6)',           tGzip],
    ['6. JSON.parse',               tParse2],
    ['7. Float32Array reconstruct', tMaterialise],
  ];
  const legacyTotal = tDisk + tParse + tConvert + tStringify + tGzip + tParse2 + tMaterialise;
  for (const [label, ms] of legacyStages) {
    const pct = (ms / legacyTotal * 100).toFixed(1).padStart(5);
    console.log(`  ${label.padEnd(36)} ${fmt(ms)}  ${pct}%`);
  }
  console.log(`  ${'─'.repeat(60)}`);
  console.log(`  ${'TOTAL legacy'.padEnd(36)} ${fmt(legacyTotal)}`);
  console.log(`  payload over the wire (gzipped): ${mb(gz.length)}`);

  section('Summary — new GMBP binary path');
  const newStages = [
    ['1. fs.readFileSync',          tDisk],
    ['2. SoundFont2 parse',         tParse],
    ['3. convertPreset',            tConvert],
    ['4. encodePreset (binary)',    tEncode],
    ['5. (no gzip)',                0],
    ['6. decodePreset (binary)',    tDecode],
  ];
  const newTotal = tDisk + tParse + tConvert + tEncode + tDecode;
  for (const [label, ms] of newStages) {
    const pct = (ms / newTotal * 100).toFixed(1).padStart(5);
    console.log(`  ${label.padEnd(36)} ${fmt(ms)}  ${pct}%`);
  }
  console.log(`  ${'─'.repeat(60)}`);
  console.log(`  ${'TOTAL GMBP binary'.padEnd(36)} ${fmt(newTotal)}`);
  console.log(`  payload over the wire (raw):     ${mb(wire.length)}`);

  console.log(`\n  ⇒ Speedup: ${(legacyTotal / newTotal).toFixed(2)}× faster, ${fmt(legacyTotal - newTotal)} saved`);
  console.log(`  ⇒ Wire bytes: ${mb(gz.length)} → ${mb(wire.length)} (${wire.length > gz.length ? '+' : ''}${((wire.length - gz.length) / gz.length * 100).toFixed(0)}%)`);

  // ── Warm-process scenarios (SoundFont2 instance cache + L2 hit) ────────
  console.log('\n[Warm-process scenarios with caches in place]');

  section('A. 2nd program from same SF2 (SoundFont2 instance cached)');
  const sf2 = parseSoundFont(sf2Buf); // pretend cache hit — reuse the instance
  const { elapsed: tCachedConvert } = timed('convertPresetFromSF2 (no parse)', () => convertPresetFromSF2(sf2, 0, program));
  const warmInstanceTotal = tCachedConvert + tEncode + tDecode;
  console.log(`  scenario total (skip readFile+parse):   ${fmt(warmInstanceTotal)}`);
  console.log(`  vs. cold GMBP total ${fmt(newTotal)} → ${(newTotal / warmInstanceTotal).toFixed(2)}× faster`);

  section('B. L2 cache hit (decode GMBP from SQLite blob)');
  // The L2 path returns the binary buffer directly — only decode runs.
  const wireFromL2 = encodePreset(preset); // simulate what SQLite returns
  const { elapsed: tL2Decode } = timed('decodePreset (L2 hit only)', () => decodePreset(wireFromL2));
  console.log(`  scenario total (skip readFile+parse+convert): ${fmt(tL2Decode)}`);
  console.log(`  vs. cold GMBP total ${fmt(newTotal)} → ${(newTotal / tL2Decode).toFixed(2)}× faster`);
}

main().catch(e => { console.error(e); process.exit(1); });
