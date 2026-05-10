#!/usr/bin/env node
/**
 * @file scripts/verify-drum-banks.js
 * @description Verify that every entry in `SOUND_BANKS[*].drumKits` of
 * `public/js/audio/MidiSynthesizerConstants.js` actually resolves on the
 * WebAudioFont CDN. The WAF URL convention is:
 *
 *   https://surikov.github.io/webaudiofontdata/sound/128{note}_{bankIndex}_{suffix}.js
 *
 * where `note` is one of the kit's drum notes (we use 36 = kick drum,
 * which every kit defines) and `{suffix}` matches the bank entry.
 *
 * Usage:
 *   node scripts/verify-drum-banks.js              # dry-run, prints status table
 *   node scripts/verify-drum-banks.js --write      # update `verified` flags in-place
 *   node scripts/verify-drum-banks.js --note=38    # use a different drum note for the probe
 *   node scripts/verify-drum-banks.js --concurrency=4
 *
 * The script never reorders or rewrites unrelated lines — it only
 * toggles the `verified: true|false` literal in lines that already
 * declare a drum kit.
 *
 * Exit codes:
 *   0  all checks succeeded
 *   1  at least one bank entry is unreachable (any HTTP status != 200)
 *   2  source file could not be loaded / parsed
 *
 * Closes TODO.md "Banques son des drum kits — vérification CDN".
 */
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(__dirname, '..', 'public', 'js', 'audio', 'MidiSynthesizerConstants.js');
const CDN_BASE = 'https://surikov.github.io/webaudiofontdata/sound';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function flag(name) { return args.includes(name); }
function arg(prefix, fallback) {
  const hit = args.find((a) => a.startsWith(prefix + '='));
  return hit ? hit.slice(prefix.length + 1) : fallback;
}
const WRITE = flag('--write');
const PROBE_NOTE = Number.parseInt(arg('--note', '36'), 10);
const CONCURRENCY = Math.max(1, Math.min(8, Number.parseInt(arg('--concurrency', '3'), 10)));
const VERBOSE = flag('--verbose');

// ---------------------------------------------------------------------------
// Source parsing
// ---------------------------------------------------------------------------

/**
 * Parse drum-kit entries by extracting `SOUND_BANKS` from the source file
 * with a regex that captures (id, suffix, drumKits[]). Robust against the
 * file's existing formatting because each kit row matches a single line.
 *
 * @param {string} src
 * @returns {Array<{bankId:string, suffix:string, kit:{midiProgram:number,bankIndex:number,verified:boolean}, line:number, raw:string}>}
 */
function parseDrumKits(src) {
  const lines = src.split('\n');
  const banks = [];

  // Locate every "id: 'XYZ', ..., suffix: 'ABC'," or
  // "id: 'XYZ', label: '…', suffix: 'ABC'," declaration.
  let currentBank = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const bankHeader = /id:\s*'([^']+)'.*?suffix:\s*'([^']+)'/.exec(line);
    if (bankHeader) {
      currentBank = { id: bankHeader[1], suffix: bankHeader[2] };
      continue;
    }

    // End of a bank block: a line that closes the object (`}` alone or
    // `},`). Reset the current bank so kits outside any block aren't
    // attributed wrongly.
    if (/^\s*\}\s*,?\s*$/.test(line)) {
      currentBank = null;
      continue;
    }

    if (!currentBank) continue;

    const kit = /\{\s*midiProgram:\s*(\d+)\s*,\s*bankIndex:\s*(\d+)\s*,\s*verified:\s*(true|false)\s*\}/.exec(line);
    if (kit) {
      banks.push({
        bankId: currentBank.id,
        suffix: currentBank.suffix,
        kit: {
          midiProgram: Number.parseInt(kit[1], 10),
          bankIndex: Number.parseInt(kit[2], 10),
          verified: kit[3] === 'true'
        },
        line: i,
        raw: line
      });
    }
  }

  return banks;
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

/**
 * @param {{bankIndex:number, suffix:string}} entry
 * @returns {string} The full CDN URL to probe.
 */
function urlFor(entry, note = PROBE_NOTE) {
  const noteStr = String(note).padStart(2, '0');
  return `${CDN_BASE}/128${noteStr}_${entry.bankIndex}_${entry.suffix}.js`;
}

/**
 * Run a HEAD request against `url` with a 15-second timeout. Falls back
 * to GET when HEAD returns 405 (some CDNs reject HEAD).
 *
 * @param {string} url
 * @returns {Promise<{ok:boolean, status:number, url:string}>}
 */
async function probe(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    let res = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
    if (res.status === 405) {
      // CDN doesn't support HEAD — retry with GET but request 0 bytes.
      res = await fetch(url, { method: 'GET', signal: ctrl.signal, headers: { Range: 'bytes=0-0' } });
    }
    return { ok: res.ok, status: res.status, url };
  } catch (err) {
    return { ok: false, status: -1, url, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Limit concurrency over an array of async tasks.
 *
 * @template T,R
 * @param {T[]} items
 * @param {number} max
 * @param {(item:T) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function pool(items, max, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(max, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      out[idx] = await worker(items[idx]);
    }
  });
  await Promise.all(runners);
  return out;
}

// ---------------------------------------------------------------------------
// Rewrite (in-place)
// ---------------------------------------------------------------------------

/**
 * Toggle a single `verified: true|false` on the captured line. Returns
 * the rewritten line. Whitespace and comment trailers are preserved.
 *
 * @param {string} rawLine
 * @param {boolean} verified
 * @returns {string}
 */
function rewriteLine(rawLine, verified) {
  return rawLine.replace(
    /(verified:\s*)(true|false)/,
    (_, p1) => `${p1}${verified ? 'true ' : 'false'}`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let src;
  try {
    src = readFileSync(SOURCE_PATH, 'utf8');
  } catch (err) {
    console.error(`Cannot read ${SOURCE_PATH}: ${err.message}`);
    process.exit(2);
  }

  const entries = parseDrumKits(src);
  if (entries.length === 0) {
    console.error('No drumKits entries parsed from the source file. Did the file format change?');
    process.exit(2);
  }

  console.log(`Probing ${entries.length} drum kit entr${entries.length === 1 ? 'y' : 'ies'} on ${CDN_BASE}…`);
  if (VERBOSE) console.log(`Concurrency: ${CONCURRENCY}, probe note: ${PROBE_NOTE}`);

  const results = await pool(entries, CONCURRENCY, async (entry) => {
    const url = urlFor(entry.kit, PROBE_NOTE);
    const probeResult = await probe(url);
    return { entry, probeResult };
  });

  // ─── Report ───────────────────────────────────────────────────────────
  const rows = [];
  let failures = 0;
  let toggles = 0;
  for (const { entry, probeResult } of results) {
    const wasVerified = entry.kit.verified;
    const isVerified = probeResult.ok && probeResult.status === 200;
    const status = isVerified ? 'OK' : `FAIL (${probeResult.status})`;
    const drift = wasVerified === isVerified ? '' : (isVerified ? '↑' : '↓');
    if (drift) toggles++;
    if (!isVerified && wasVerified) failures++;
    rows.push({
      bank: entry.bankId,
      suffix: entry.suffix,
      prog: entry.kit.midiProgram,
      idx: entry.kit.bankIndex,
      file: status,
      flag: `${wasVerified} → ${isVerified}${drift ? ' ' + drift : ''}`
    });
  }

  console.table(rows);
  console.log(`Summary: ${results.length} probed, ${toggles} flag toggles, ${failures} previously-verified now failing.`);

  // ─── Apply (when --write) ─────────────────────────────────────────────
  if (!WRITE) {
    console.log('(dry-run) re-run with --write to update verified flags in-place.');
    process.exit(failures > 0 ? 1 : 0);
  }

  // Sort by line desc so earlier rewrites don't shift later ones.
  const ordered = [...results].sort((a, b) => b.entry.line - a.entry.line);
  const lines = src.split('\n');
  let writes = 0;
  for (const { entry, probeResult } of ordered) {
    const verified = probeResult.ok && probeResult.status === 200;
    if (verified === entry.kit.verified) continue; // no-op
    const updated = rewriteLine(lines[entry.line], verified);
    if (updated === lines[entry.line]) {
      console.warn(`[verify-drum-banks] line ${entry.line + 1} did not match the verified pattern: ${lines[entry.line]}`);
      continue;
    }
    lines[entry.line] = updated;
    writes++;
  }

  if (writes > 0) {
    writeFileSync(SOURCE_PATH, lines.join('\n'));
    console.log(`Wrote ${writes} change${writes === 1 ? '' : 's'} to ${SOURCE_PATH}`);
  } else {
    console.log('Source already up to date — no write needed.');
  }
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`verify-drum-banks crashed: ${err.stack || err.message || err}`);
  process.exit(2);
});
