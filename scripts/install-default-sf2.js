#!/usr/bin/env node
/**
 * @file scripts/install-default-sf2.js
 * @description Postinstall helper: ensure assets/sf2/default.sf2 is present.
 *
 * Without this file the offline synth has no samples to render and every
 * call to /api/sf2/default/preset/* returns 404. The file is downloaded once
 * from a known mirror, then re-used across upgrades. The script is
 * idempotent (skips when the target file is non-empty) and non-fatal:
 * a network error during `npm install` does NOT fail the install, it just
 * prints a warning so the user can re-run it later.
 *
 * Usage:
 *   node scripts/install-default-sf2.js          # one-shot, used by postinstall
 *   node scripts/install-default-sf2.js --force  # re-download even if present
 *
 * See assets/sf2/README.md for the soundfont's license & provenance.
 */

import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET_DIR  = resolve(__dirname, '..', 'assets', 'sf2');
const TARGET_PATH = join(TARGET_DIR, 'default.sf2');

// Mirrors tried in order. We only need one to succeed.
// All URLs must point to an SF2 file (not SF3 — the converter does not
// decompress Ogg-Vorbis-packed samples).
const MIRRORS = [
  'https://schristiancollins.com/soundfonts/GeneralUser_GS_v1.471.zip',
  // Fallback mirrors (Sonatina / FluidR3 etc.) can be added here in the future.
];

// WebAudioFontPlayer library — vendored locally so the browser never hits a
// public CDN at runtime. The file is small (~120 KB) but its license is
// not redistributable freely without attribution, so we fetch it instead of
// committing it. The install is idempotent and non-fatal on failure.
const PLAYER_TARGET_DIR  = resolve(__dirname, '..', 'public', 'lib');
const PLAYER_TARGET_PATH = join(PLAYER_TARGET_DIR, 'WebAudioFontPlayer.js');
const PLAYER_URL = 'https://surikov.github.io/webaudiofont/npm/dist/WebAudioFontPlayer.js';
const MIN_PLAYER_SIZE = 50 * 1024; // 50 KB — anything smaller is an error page

const MIN_SF2_SIZE = 1024 * 1024; // 1 MB — anything smaller is almost certainly an error page

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');

function log(msg) {
  process.stdout.write(`[install-default-sf2] ${msg}\n`);
}

function warn(msg) {
  process.stderr.write(`[install-default-sf2] WARN: ${msg}\n`);
}

function alreadyPresent() {
  try {
    return statSync(TARGET_PATH).size >= MIN_SF2_SIZE;
  } catch {
    return false;
  }
}

function fetchToFile(url, dest, redirects = 5) {
  return new Promise((resolveP, rejectP) => {
    const lib = url.startsWith('https:') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'gmboop-install/1' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (!res.headers.location || redirects <= 0) {
          return rejectP(new Error(`redirect loop or missing Location header (status ${res.statusCode})`));
        }
        return resolveP(fetchToFile(res.headers.location, dest, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return rejectP(new Error(`HTTP ${res.statusCode}`));
      }
      const out = createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolveP()));
      out.on('error', (err) => {
        try { unlinkSync(dest); } catch {}
        rejectP(err);
      });
    }).on('error', rejectP);
  });
}

async function fetchVerified(url, dest, minSize) {
  const tmp = `${dest}.partial`;
  await fetchToFile(url, tmp);
  const size = statSync(tmp).size;
  if (size < minSize) {
    try { unlinkSync(tmp); } catch {}
    throw new Error(`file too small (${size} bytes), looks like an error page`);
  }
  try { unlinkSync(dest); } catch {}
  const { renameSync } = await import('fs');
  renameSync(tmp, dest);
  return size;
}

async function installPlayerLib() {
  mkdirSync(PLAYER_TARGET_DIR, { recursive: true });
  try {
    const size = statSync(PLAYER_TARGET_PATH).size;
    if (!FORCE && size >= MIN_PLAYER_SIZE) {
      log(`WebAudioFontPlayer already present at ${PLAYER_TARGET_PATH}.`);
      return;
    }
  } catch { /* not present yet */ }
  try {
    log(`Downloading WebAudioFontPlayer.js to ${PLAYER_TARGET_PATH}…`);
    const size = await fetchVerified(PLAYER_URL, PLAYER_TARGET_PATH, MIN_PLAYER_SIZE);
    log(`✓ Installed WebAudioFontPlayer.js (${(size / 1024).toFixed(0)} KB).`);
  } catch (err) {
    warn(`Could not download WebAudioFontPlayer.js (${err.message}). The synth UI will load but \`new WebAudioFontPlayer()\` will throw until you re-run \`npm run install-default-sf2\`.`);
  }
}

async function installDefaultSF2() {
  mkdirSync(TARGET_DIR, { recursive: true });

  if (!FORCE && alreadyPresent()) {
    log(`default.sf2 already present at ${TARGET_PATH} — nothing to do.`);
    return;
  }

  log(`Downloading default soundfont to ${TARGET_PATH} (~30 MB, one-shot)…`);

  let lastError = null;
  for (const url of MIRRORS) {
    try {
      log(`  trying ${url}`);
      const size = await fetchVerified(url, TARGET_PATH, MIN_SF2_SIZE);
      log(`✓ Installed default soundfont (${(size / (1024 * 1024)).toFixed(1)} MB).`);
      return;
    } catch (err) {
      lastError = err;
      warn(`mirror failed (${err.message}). Trying next…`);
    }
  }

  warn(`Could not download default soundfont. The synth will load but produce no sound until you re-run \`npm run install-default-sf2\`. Last error: ${lastError?.message || 'unknown'}`);
}

async function main() {
  await installPlayerLib();
  await installDefaultSF2();
  // Exit 0 so an offline `npm install` does not abort the whole install.
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    warn(`unexpected failure: ${err.message}`);
    process.exit(0);
  });
