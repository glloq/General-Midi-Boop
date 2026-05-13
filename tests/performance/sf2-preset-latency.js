#!/usr/bin/env node
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

import { convertPreset } from '../../src/files/SF2Converter.js';

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

  section('3. convertPreset (Int16 PCM → WAF zone array)');
  const { out: preset, elapsed: tConvert } = timed('convertPreset', () => convertPreset(sf2Buf, 0, program));
  if (!preset) {
    console.error(`  ERROR: preset ${program} not found.`);
    process.exit(1);
  }
  let totalSamples = 0;
  for (const z of preset.zones) totalSamples += z.sample.length;
  console.log(`  zones=${preset.zones.length}  total samples=${totalSamples.toLocaleString()}  (~${mb(totalSamples * 4)} as Float32)`);

  section('4. JSON.stringify (server serialisation)');
  const { out: json, elapsed: tStringify } = timed('JSON.stringify(preset)', () => JSON.stringify(preset));
  console.log(`  json size: ${mb(json.length)}`);

  section('5. gzip (compression middleware)');
  const { out: gz, elapsed: tGzip } = timed('zlib.gzipSync (level 6 default)', () => zlib.gzipSync(Buffer.from(json)));
  console.log(`  gzipped:   ${mb(gz.length)}   (${(gz.length / json.length * 100).toFixed(1)}% of raw)`);
  const { elapsed: tGzip1 } = timed('zlib.gzipSync (level 1, fastest)', () => zlib.gzipSync(Buffer.from(json), { level: 1 }));
  void tGzip1;

  section('6. JSON.parse (browser-side approximation)');
  const { out: parsed, elapsed: tParse2 } = timed('JSON.parse(json)', () => JSON.parse(json));

  section('7. Float32Array reconstruction (browser materialise)');
  const { elapsed: tMaterialise } = timed('new Float32Array(zone.sample) ×N', () => {
    for (const z of parsed.zones) {
      // mirrors MidiSynthesizer._materialiseSF2Preset float reconstruction
      // (without AudioContext.createBuffer, which is browser-only)
      const f32 = new Float32Array(z.sample);
      void f32;
    }
  });

  section('Summary');
  const stages = [
    ['1. fs.readFileSync',          tDisk],
    ['2. SoundFont2 parse',         tParse],
    ['3. convertPreset',            tConvert],
    ['4. JSON.stringify',           tStringify],
    ['5. gzip (level 6)',           tGzip],
    ['6. JSON.parse',               tParse2],
    ['7. Float32Array reconstruct', tMaterialise],
  ];
  const serverPath = tDisk + tParse + tConvert + tStringify + tGzip;
  const clientPath = tParse2 + tMaterialise;
  const total = serverPath + clientPath;
  for (const [label, ms] of stages) {
    const pct = (ms / total * 100).toFixed(1).padStart(5);
    console.log(`  ${label.padEnd(36)} ${fmt(ms)}  ${pct}%`);
  }
  console.log(`  ${'─'.repeat(60)}`);
  console.log(`  ${'server-side subtotal'.padEnd(36)} ${fmt(serverPath)}`);
  console.log(`  ${'client-side subtotal (parse+f32)'.padEnd(36)} ${fmt(clientPath)}`);
  console.log(`  ${'pipeline total (no HTTP/createBuffer)'.padEnd(36)} ${fmt(total)}`);
  console.log(`\n  payload over the wire (gzipped): ${mb(gz.length)}`);
  console.log(`  payload after gunzip (text):     ${mb(json.length)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
