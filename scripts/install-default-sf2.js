#!/usr/bin/env node
/**
 * @file scripts/install-default-sf2.js
 * @description Postinstall helper: ensure assets/sf2/default.sf2 is present.
 *
 * Without this file the offline synth has no samples to render and every
 * call to /api/sf2/default/preset/* returns 404. The file is downloaded once
 * from a known mirror, then re-used across upgrades. The script is
 * idempotent and non-fatal ON NETWORK ERRORS: a mirror being unreachable
 * during `npm install` does NOT fail the install, it just prints a warning so
 * the user can re-run it later.
 *
 * It IS fatal on an integrity mismatch. When an artefact has a pinned SHA-256
 * and the bytes that arrive do not match it, the file is deleted and the
 * script exits non-zero — a divergence is a supply-chain signal, not a hiccup
 * (audit L10 F-109). See PINNED_SHA256 below for how to fill the pins in.
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
import { createHash } from 'crypto';
import https from 'https';
import http from 'http';
import zlib from 'zlib';

// ---------------------------------------------------------------------------
// Supply-chain integrity (audit L10 F-109 / F-15)
// ---------------------------------------------------------------------------
// Both artefacts below are downloaded from third-party mirrors, and one of
// them (WebAudioFontPlayer.js) is then EXECUTED by the SPA on every page load,
// same-origin, on a box that exposes system_update. Size thresholds and
// RIFF/sfbk magic bytes only catch an error page: a mirror serving a valid but
// different file passes them without a fight.
//
// PINNED_SHA256 is the real gate. A pinned artefact whose digest diverges is
// deleted and the install FAILS LOUDLY (non-zero exit) — never a silent warn,
// because a divergence is a supply-chain signal, not a network hiccup.
//
// HOW TO POPULATE (must be done from a trusted, verified download — do NOT
// paste the digest of whatever a mirror happened to serve you today):
//
//   1. Obtain the artefact from upstream over a channel you trust and check
//      its provenance by hand (release page, signature, known-good machine).
//   2. sha256sum assets/sf2/default.sf2
//      sha256sum public/lib/WebAudioFontPlayer.js
//   3. Paste the digests below, in the same commit, with the upstream
//      version they correspond to.
//
// Until then the constants stay null and the script says so, out loud, on
// every run: "integrity NOT verified". That is the honest state — it is not a
// verification, and nothing here pretends otherwise.
//
// Per-run override (CI, air-gapped mirrors, a build that pins its own copy):
//   GMBOOP_SF2_SHA256=…  GMBOOP_WAF_PLAYER_SHA256=…
// Hardened builds can additionally refuse to install anything unpinned:
//   GMBOOP_REQUIRE_PINNED_ASSETS=1
const PINNED_SHA256 = {
  // GeneralUser GS v1.471 — not pinned yet, see above.
  sf2: null,
  // WebAudioFontPlayer.js (surikov/webaudiofont) — not pinned yet, see above.
  player: null
};

const EXPECTED_SHA256 = {
  sf2: process.env.GMBOOP_SF2_SHA256 || PINNED_SHA256.sf2 || null,
  player: process.env.GMBOOP_WAF_PLAYER_SHA256 || PINNED_SHA256.player || null
};

const REQUIRE_PINNED = process.env.GMBOOP_REQUIRE_PINNED_ASSETS === '1'
                    || process.env.GMBOOP_REQUIRE_PINNED_ASSETS === 'true';

/** True once an artefact failed its integrity check: main() then exits non-zero. */
let integrityFailed = false;

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET_DIR  = resolve(__dirname, '..', 'assets', 'sf2');
const TARGET_PATH = join(TARGET_DIR, 'default.sf2');

// Mirrors tried in order. Each entry can be either:
//   - a raw `.sf2` URL (the bytes are written as-is after RIFF/sfbk check)
//   - a `.zip` archive containing a `.sf2` file (we extract the first .sf2
//     entry using the minimal ZIP reader below)
// The kind is auto-detected from the first 4 bytes of the downloaded payload.
//
// Mirrors die over time; set GMBOOP_SF2_URL to point at your own mirror
// (raw .sf2 or .zip) if every public one is blocked from your network.
//
// An explicit override is EXCLUSIVE (audit L10 F-109): an operator who names a
// mirror has pinned their supply chain, and silently falling back to a public
// CDN when theirs is unreachable is exactly the substitution they were trying
// to prevent. Better to fail and say so.
const SF2_MIRRORS = process.env.GMBOOP_SF2_URL ? [process.env.GMBOOP_SF2_URL] : [
  // GitHub raw mirrors of the official 1.471 release. These serve the .sf2
  // directly (Content-Type: application/octet-stream) with no archive to
  // extract and no Cloudflare interstitial, so they are the most reliable
  // automated path.
  'https://raw.githubusercontent.com/ROCKNIX/generaluser-gs/main/GeneralUser%20GS%20v1.471.sf2',
  'https://raw.githubusercontent.com/JustEnoughLinuxOS/generaluser-gs/main/GeneralUser%20GS%20v1.471.sf2',
  // Upstream author's site. As of 2026 the page is a SPA and the old
  // /soundfonts/<file>.zip path returns the HTML index instead of the
  // archive, so this is kept only as a last-ditch attempt.
  'https://schristiancollins.com/soundfonts/GeneralUser_GS_v1.471.zip',
];

// WebAudioFontPlayer library — vendored locally so the browser never hits a
// public CDN at runtime. The file is small (~120 KB) but its license is
// not redistributable freely without attribution, so we fetch it instead of
// committing it. The install is idempotent and non-fatal on failure.
const PLAYER_TARGET_DIR  = resolve(__dirname, '..', 'public', 'lib');
const PLAYER_TARGET_PATH = join(PLAYER_TARGET_DIR, 'WebAudioFontPlayer.js');
// Mirrors tried in order. surikov.github.io is the upstream but is sometimes
// unreachable from corporate / NATed networks. jsDelivr and unpkg are
// well-known CDNs that re-serve GitHub + npm content with high uptime.
// Override with GMBOOP_WAF_PLAYER_URL to point at your own mirror.
//
// URL PINNING (audit L10 F-109). A jsDelivr mirror of the form
// `cdn.jsdelivr.net/gh/<user>/<repo>@<branch>/…` used to sit in this list. It
// follows a MOVING BRANCH, so its content changes without a single line of
// this repository changing. That is not an attack scenario, it is its nominal
// behaviour — it is gone.
// Set GMBOOP_WAF_PLAYER_VERSION to an npm version (e.g. `3.0.4`) to pin the
// npm-backed mirrors to an immutable URL; unset, they resolve to `latest`, and
// the SHA-256 pin above is then the only thing standing between a mirror and
// the browser. Pin both if you can.
// GMBOOP_WAF_PLAYER_URL is likewise EXCLUSIVE — see SF2_MIRRORS.
const PLAYER_VERSION = process.env.GMBOOP_WAF_PLAYER_VERSION || '';
const PLAYER_NPM_SPEC = PLAYER_VERSION ? `webaudiofont@${PLAYER_VERSION}` : 'webaudiofont';
const PLAYER_MIRRORS = process.env.GMBOOP_WAF_PLAYER_URL ? [process.env.GMBOOP_WAF_PLAYER_URL] : [
  'https://surikov.github.io/webaudiofont/npm/dist/WebAudioFontPlayer.js',
  `https://cdn.jsdelivr.net/npm/${PLAYER_NPM_SPEC}/dist/WebAudioFontPlayer.js`,
  `https://unpkg.com/${PLAYER_NPM_SPEC}/dist/WebAudioFontPlayer.js`,
];
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

/**
 * Refuse an artefact whose digest does not match the pin. LOUD failure: the
 * file is deleted, the run is marked failed, and main() exits non-zero so
 * `npm install` stops. Never swallowed the way network errors are.
 *
 * With no pin configured, says so explicitly on every run — the absence of a
 * check is reported, not hidden. `GMBOOP_REQUIRE_PINNED_ASSETS=1` turns that
 * warning into a refusal for hardened builds.
 *
 * @param {string} filePath - artefact on disk
 * @param {string|null} expected - pinned lowercase hex SHA-256, or null
 * @param {string} label - artefact name used in messages
 * @returns {boolean} true when the artefact may be kept
 */
function assertChecksum(filePath, expected, label) {
  if (!expected) {
    const msg = `${label}: no pinned SHA-256 — integrity NOT verified. `
      + 'Fill PINNED_SHA256 in scripts/install-default-sf2.js (or set '
      + 'GMBOOP_SF2_SHA256 / GMBOOP_WAF_PLAYER_SHA256) from a download whose '
      + 'provenance you checked by hand.';
    if (REQUIRE_PINNED) {
      integrityFailed = true;
      try { unlinkSync(filePath); } catch {}
      warn(`REFUSED — ${msg} (GMBOOP_REQUIRE_PINNED_ASSETS=1)`);
      return false;
    }
    warn(msg);
    return true;
  }
  const actual = sha256File(filePath);
  if (actual !== expected) {
    integrityFailed = true;
    try { unlinkSync(filePath); } catch {}
    warn(
      `${label}: SHA-256 MISMATCH — expected ${expected}, got ${actual}. `
      + 'The mirror served content that is NOT the pinned artefact. The file '
      + 'has been deleted and the install is failing on purpose. Do not update '
      + 'the pin to make this go away: verify where those bytes came from.'
    );
    return false;
  }
  log(`${label}: SHA-256 verified (${actual.slice(0, 16)}…).`);
  return true;
}

function alreadyPresent() {
  try {
    if (statSync(TARGET_PATH).size < MIN_SF2_SIZE) return false;
    // Size alone would let an already-tampered file live forever, never
    // re-checked (audit L10 F-109). With a pin, the digest decides.
    if (!EXPECTED_SHA256.sf2) return true;
    return sha256File(TARGET_PATH) === EXPECTED_SHA256.sf2;
  } catch {
    return false;
  }
}

function fetchToFile(url, dest, redirects = 5) {
  return new Promise((resolveP, rejectP) => {
    const lib = url.startsWith('https:') ? https : http;
    // A browser-style UA gets past Cloudflare interstitials on sites like
    // schristiancollins.com that otherwise serve an HTML "checking your
    // browser" page to generic UAs.
    const headers = {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
    };
    lib.get(url, { headers }, (res) => {
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
    // Show the first 200 bytes as text so the user can tell whether they got
    // an HTML error page, a Cloudflare interstitial, a redirect blurb, etc.
    const preview = buf.slice(0, 200).toString('utf8').replace(/[^\x20-\x7e\n]/g, '.');
    throw new Error(`downloaded payload is neither an SF2 nor a ZIP archive (first bytes: ${JSON.stringify(preview)})`);
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
      // This file is EXECUTED by the SPA on every page load, so an already
      // installed copy is re-checked rather than trusted on sight (audit L10
      // F-109). A mismatch deletes it and fails the run; no pin at all prints
      // the "integrity NOT verified" notice on every run instead of hiding it.
      if (!assertChecksum(PLAYER_TARGET_PATH, EXPECTED_SHA256.player, 'WebAudioFontPlayer.js')) {
        return;
      }
      log(`WebAudioFontPlayer already present at ${PLAYER_TARGET_PATH}.`);
      return;
    }
  } catch { /* not present yet */ }

  log(`Downloading WebAudioFontPlayer.js to ${PLAYER_TARGET_PATH}…`);
  let lastError = null;
  for (const url of PLAYER_MIRRORS) {
    try {
      log(`  trying ${url}`);
      const size = await fetchVerified(url, PLAYER_TARGET_PATH, MIN_PLAYER_SIZE);
      if (!assertChecksum(PLAYER_TARGET_PATH, EXPECTED_SHA256.player, 'WebAudioFontPlayer.js')) {
        // Integrity failure: stop here. Trying the next mirror would just
        // shop around for bytes that pass, which is the opposite of the point.
        return;
      }
      log(`✓ Installed WebAudioFontPlayer.js (${(size / 1024).toFixed(0)} KB).`);
      return;
    } catch (err) {
      lastError = err;
      warn(`mirror failed (${err.message}). Trying next…`);
    }
  }
  warn(`Could not download WebAudioFontPlayer.js (last error: ${lastError?.message || 'unknown'}). The synth UI will load but \`new WebAudioFontPlayer()\` will throw until you re-run \`npm run install-default-sf2\`. Set GMBOOP_WAF_PLAYER_URL to a reachable mirror if every default is blocked.`);
}

async function installDefaultSF2() {
  mkdirSync(TARGET_DIR, { recursive: true });

  if (!FORCE && alreadyPresent()) {
    // Re-assert on the skip path too, so `GMBOOP_REQUIRE_PINNED_ASSETS=1`
    // means something for a file that is already on disk, and so the "not
    // verified" notice is printed on every run rather than only after a
    // download.
    if (!assertChecksum(TARGET_PATH, EXPECTED_SHA256.sf2, 'default.sf2')) return;
    log(`default.sf2 already present at ${TARGET_PATH} — nothing to do.`);
    return;
  }

  log(`Downloading default soundfont to ${TARGET_PATH} (~30 MB, one-shot)…`);

  let lastError = null;
  for (const url of SF2_MIRRORS) {
    const downloadPath = `${TARGET_PATH}.download`;
    try {
      log(`  trying ${url}`);
      // Download the raw payload (no size threshold yet — the materialise
      // step decides whether it is a valid SF2 or a zip we can extract).
      await fetchVerified(url, downloadPath, 1024);
      const size = await materialiseSF2(downloadPath, TARGET_PATH);
      if (!assertChecksum(TARGET_PATH, EXPECTED_SHA256.sf2, 'default.sf2')) {
        // See installPlayerLib(): a mismatch stops the run, it does not move
        // on to the next mirror.
        return;
      }
      log(`✓ Installed default soundfont (${(size / (1024 * 1024)).toFixed(1)} MB).`);
      return;
    } catch (err) {
      try { unlinkSync(downloadPath); } catch {}
      lastError = err;
      warn(`mirror failed (${err.message}). Trying next…`);
    }
  }

  warn(`Could not download default soundfont (last error: ${lastError?.message || 'unknown'}). The synth will load but produce no sound until you re-run \`npm run install-default-sf2\`. Set GMBOOP_SF2_URL to a reachable mirror (.sf2 or .zip) if every default is blocked.`);
}

async function main() {
  if (IS_CI && !FORCE) {
    log('CI environment detected — skipping auto-download. Run `npm run install-default-sf2 --force` to fetch manually.');
    return 0;
  }
  await installPlayerLib();
  await installDefaultSF2();
  if (integrityFailed) {
    // The ONLY non-zero exit of this script. An unreachable mirror is not
    // worth failing an install over; bytes that do not match the pin are
    // (audit L10 F-109).
    warn('INTEGRITY CHECK FAILED — see the message(s) above. Aborting install.');
    return 1;
  }
  // Exit 0 so an offline `npm install` does not abort the whole install.
  return 0;
}

// Named exports so a Jest test can exercise the parsers without triggering
// any network I/O. Keep these in sync with the local helpers above.
export { isSF2Buffer, isZipBuffer, extractSf2FromZip, materialiseSF2, sha256File, assertChecksum };

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
