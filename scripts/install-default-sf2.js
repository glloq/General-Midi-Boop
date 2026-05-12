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

import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';
import zlib from 'zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET_DIR  = resolve(__dirname, '..', 'assets', 'sf2');
const TARGET_PATH = join(TARGET_DIR, 'default.sf2');

// Mirrors tried in order. Each entry can be either:
//   - a raw `.sf2` URL (the bytes are written as-is after RIFF/sfbk check)
//   - a `.zip` archive containing a `.sf2` file (we extract the first .sf2
//     entry using the minimal ZIP reader below)
// The kind is auto-detected from the first 4 bytes of the downloaded payload.
const MIRRORS = [
  'https://schristiancollins.com/soundfonts/GeneralUser_GS_v1.471.zip',
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
// Skip auto-download in CI so build pipelines stay deterministic and don't
// hammer external mirrors. Run `npm run install-default-sf2` explicitly when
// you need the file in CI (e.g. for end-to-end audio tests).
const IS_CI = process.env.CI === 'true' || process.env.CI === '1';

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

// Header magic for SF2: `RIFF....sfbk`
function isSF2Buffer(buf) {
  return buf.length >= 12
      && buf.slice(0, 4).toString('ascii') === 'RIFF'
      && buf.slice(8, 12).toString('ascii') === 'sfbk';
}

// Header magic for ZIP local file: `PK\x03\x04`
function isZipBuffer(buf) {
  return buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;
}

/**
 * Minimal ZIP reader: walk the central directory and extract the first entry
 * whose filename ends with `.sf2`. Supports both stored (method 0) and
 * deflate (method 8) entries. ZIP64 archives and encrypted entries are
 * rejected — neither applies to the soundfont mirrors we use.
 *
 * @param {Buffer} buf
 * @returns {Buffer} raw SF2 bytes
 */
function extractSf2FromZip(buf) {
  const EOCD_SIG = 0x06054b50;
  let eocdOff = -1;
  // EOCD record is at most 22 bytes + up to 65535 byte comment. Scan from end.
  const scanFrom = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocdOff = i; break; }
  }
  if (eocdOff < 0) throw new Error('zip: end-of-central-directory record not found');

  const cdCount = buf.readUInt16LE(eocdOff + 10);
  const cdOff   = buf.readUInt32LE(eocdOff + 16);
  if (cdCount === 0xFFFF || cdOff === 0xFFFFFFFF) {
    throw new Error('zip: ZIP64 archives are not supported');
  }

  const CDFH_SIG = 0x02014b50;
  let off = cdOff;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(off) !== CDFH_SIG) throw new Error('zip: bad central directory header');
    const flags             = buf.readUInt16LE(off + 8);
    const compressionMethod = buf.readUInt16LE(off + 10);
    const compressedSize    = buf.readUInt32LE(off + 20);
    const filenameLen       = buf.readUInt16LE(off + 28);
    const extraLen          = buf.readUInt16LE(off + 30);
    const commentLen        = buf.readUInt16LE(off + 32);
    const localHeaderOff    = buf.readUInt32LE(off + 42);
    const filename          = buf.slice(off + 46, off + 46 + filenameLen).toString();
    off += 46 + filenameLen + extraLen + commentLen;

    if (!filename.toLowerCase().endsWith('.sf2')) continue;
    if (flags & 0x0001) throw new Error('zip: encrypted entries are not supported');

    const LFH_SIG = 0x04034b50;
    if (buf.readUInt32LE(localHeaderOff) !== LFH_SIG) throw new Error('zip: bad local file header');
    const lfhFilenameLen = buf.readUInt16LE(localHeaderOff + 26);
    const lfhExtraLen    = buf.readUInt16LE(localHeaderOff + 28);
    const dataStart      = localHeaderOff + 30 + lfhFilenameLen + lfhExtraLen;
    const compressed     = buf.slice(dataStart, dataStart + compressedSize);

    if (compressionMethod === 0) return compressed;
    if (compressionMethod === 8) return zlib.inflateRawSync(compressed);
    throw new Error(`zip: unsupported compression method ${compressionMethod}`);
  }
  throw new Error('zip: archive contains no .sf2 entry');
}

/**
 * Materialise the on-disk default.sf2 from a downloaded payload. Accepts
 * either a raw SF2 file or a zip containing one. Throws if the payload is
 * neither, or if extraction fails.
 *
 * @param {string} downloadPath - path to the freshly-downloaded file
 * @param {string} destPath     - final destination for default.sf2
 * @returns {number} size of the resulting SF2 in bytes
 */
async function materialiseSF2(downloadPath, destPath) {
  const buf = readFileSync(downloadPath);
  let sf2Bytes;
  if (isSF2Buffer(buf)) {
    sf2Bytes = buf;
  } else if (isZipBuffer(buf)) {
    log(`  payload is a zip archive — extracting embedded .sf2`);
    sf2Bytes = extractSf2FromZip(buf);
    if (!isSF2Buffer(sf2Bytes)) {
      throw new Error('extracted entry is not a valid SF2 (missing RIFF/sfbk header)');
    }
  } else {
    throw new Error('downloaded payload is neither an SF2 nor a ZIP archive');
  }
  if (sf2Bytes.length < MIN_SF2_SIZE) {
    throw new Error(`SF2 payload too small (${sf2Bytes.length} bytes)`);
  }
  writeFileSync(destPath, sf2Bytes);
  try { unlinkSync(downloadPath); } catch {}
  return sf2Bytes.length;
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
    const downloadPath = `${TARGET_PATH}.download`;
    try {
      log(`  trying ${url}`);
      // Download the raw payload (no size threshold yet — the materialise
      // step decides whether it is a valid SF2 or a zip we can extract).
      await fetchVerified(url, downloadPath, 1024);
      const size = await materialiseSF2(downloadPath, TARGET_PATH);
      log(`✓ Installed default soundfont (${(size / (1024 * 1024)).toFixed(1)} MB).`);
      return;
    } catch (err) {
      try { unlinkSync(downloadPath); } catch {}
      lastError = err;
      warn(`mirror failed (${err.message}). Trying next…`);
    }
  }

  warn(`Could not download default soundfont. The synth will load but produce no sound until you re-run \`npm run install-default-sf2\`. Last error: ${lastError?.message || 'unknown'}`);
}

async function main() {
  if (IS_CI && !FORCE) {
    log('CI environment detected — skipping auto-download. Run `npm run install-default-sf2 --force` to fetch manually.');
    return 0;
  }
  await installPlayerLib();
  await installDefaultSF2();
  // Exit 0 so an offline `npm install` does not abort the whole install.
  return 0;
}

// Named exports so a Jest test can exercise the parsers without triggering
// any network I/O. Keep these in sync with the local helpers above.
export { isSF2Buffer, isZipBuffer, extractSf2FromZip, materialiseSF2 };

// Only run main() when invoked as a script (node scripts/install-default-sf2.js),
// not when imported by tests.
const invokedDirectly = (() => {
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1] || '');
  } catch { return false; }
})();

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      warn(`unexpected failure: ${err.message}`);
      process.exit(0);
    });
}
