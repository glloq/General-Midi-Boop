/**
 * @file scripts/audit/licenses.mjs
 * @description Inventories the licences of every package that ships at
 * runtime, and generates the third-party notice file the MIT/Apache/BSD
 * licences of those packages require us to convey (audit §BS, finding F-158).
 *
 * ## What counts as "runtime"
 *
 * The runtime closure is read from `package-lock.json`, not from
 * `node_modules/`: every entry in `packages` that npm has **not** flagged
 * `"dev": true`. That is exactly the set `npm ci --omit=dev` installs, so it
 * includes transitive dependencies and `optionalDependencies` (which do ship
 * when the platform supports them) and excludes the dev toolchain.
 *
 * The lockfile is the source of truth for *membership*; `node_modules/` is
 * only read for the *licence text* of each member. Running without an install
 * therefore still reports the closure, but every licence resolves to
 * `NOT-INSTALLED` — run `npm install --ignore-scripts` first for a real
 * verdict.
 *
 * ## How a licence is resolved (in order, first hit wins)
 *
 *   1. `license` field of the package's own `package.json` (a string, or the
 *      deprecated `{ type }` object);
 *   2. the deprecated `licenses: [{ type }, …]` array;
 *   3. the text of a `LICENSE` / `LICENCE` / `COPYING` file next to it —
 *      detected by its wording and reported as `<SPDX> (from file)` so the
 *      reader can tell a declared licence from an inferred one;
 *   4. otherwise `UNKNOWN`, which fails `--check`.
 *
 * Nothing here guesses. A package whose licence cannot be established this way
 * is reported as unknown rather than assumed permissive.
 *
 * ## The other half: shipped assets
 *
 * Icons and soundfonts carry licences too, and they are not in the lockfile.
 * `--assets` walks everything redistributed that is not project source code
 * and fails if a file is not registered in `assets/ASSET-LICENSES.md`, so a new
 * icon cannot be shipped without someone writing down where it came from.
 * It checks bookkeeping, not provenance — establishing where an unmarked SVG
 * came from is human work, and §9 of that document records how it was done.
 *
 * Usage:
 *   node scripts/audit/licenses.mjs            # human summary
 *   node scripts/audit/licenses.mjs --json     # full per-package matrix
 *   node scripts/audit/licenses.mjs --emit     # (re)write THIRD-PARTY-NOTICES.md
 *   node scripts/audit/licenses.mjs --assets   # shipped-asset registration report
 *   node scripts/audit/licenses.mjs --check    # CI gate, exit 1 on a problem
 *
 * `--check` fails when a runtime package is copyleft, when one has no
 * establishable licence, when `THIRD-PARTY-NOTICES.md` is missing or stale
 * (i.e. `--emit` would change it), or when a shipped asset is unregistered.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname, relative, extname, basename } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOTICES_PATH = join(ROOT, 'THIRD-PARTY-NOTICES.md');

const ASSET_DOC_PATH = join(ROOT, 'assets', 'ASSET-LICENSES.md');

/**
 * Trees that end up in a distributed build (`dist/` via
 * `vite.config.js:copyStaticTree`, and the Docker image) and hold files that
 * are not project source code.
 */
const SHIPPED_ASSET_DIRS = ['public/assets', 'public/lib', 'assets'];

const argv = process.argv.slice(2);
const WANT_JSON = argv.includes('--json');
const WANT_EMIT = argv.includes('--emit');
const WANT_CHECK = argv.includes('--check');
const WANT_ASSETS = argv.includes('--assets');

/**
 * Permissive licences this project accepts in its runtime tree. Anything
 * outside the list is reported, not silently tolerated: the point of the gate
 * is that adding a new licence to a shipped dependency is a decision someone
 * makes on purpose.
 */
const ALLOWED = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'MIT/X11',
  'Python-2.0',
  'Unlicense',
  'WTFPL'
]);

/** Licences that would contaminate an MIT distribution, or forbid it outright. */
const COPYLEFT = /\b(A?GPL|LGPL|MPL|EPL|CDDL|SSPL|EUPL|OSL|CC-BY-SA|CC-BY-NC|BUSL|Commons-Clause)/i;

/** Licences whose §4 obliges us to pass on any NOTICE file the author shipped. */
const NEEDS_NOTICE = /Apache-?2/i;

const LICENSE_FILE_RE = /^(licen[cs]e|copying|notice)([-.].*)?$/i;

/**
 * Splits an SPDX expression into its atoms so `(MIT OR Apache-2.0)` can be
 * judged on its disjuncts rather than as one opaque string.
 *
 * @param {string} expr
 * @returns {string[]}
 */
function spdxAtoms(expr) {
  return expr
    .replace(/[()]/g, ' ')
    .split(/\s+(?:OR|AND)\s+|\s*\/\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {string} expr
 * @returns {'allowed'|'copyleft'|'review'}
 */
function classify(expr) {
  if (!expr || expr === 'UNKNOWN' || expr === 'NOT-INSTALLED') return 'review';
  const atoms = spdxAtoms(expr);
  // A disjunction is fine as soon as one branch is acceptable — that branch is
  // the one we take.
  if (atoms.some((a) => ALLOWED.has(a) || ALLOWED.has(a.replace(/^SEE LICENSE.*/i, '')))) {
    return 'allowed';
  }
  if (atoms.some((a) => COPYLEFT.test(a))) return 'copyleft';
  return 'review';
}

/**
 * Infers an SPDX id from the wording of a licence file. Used only when the
 * package declares nothing; the result is always labelled "(from file)".
 *
 * @param {string} text
 * @returns {string|null}
 */
function detectFromText(text) {
  if (/Apache License\s*[\r\n ]+\s*Version 2\.0/i.test(text)) return 'Apache-2.0';
  if (/Permission is hereby granted, free of charge/i.test(text)) return 'MIT';
  if (/Permission to use, copy, modify, and(?:\/or)? distribute/i.test(text)) return 'ISC';
  if (/Redistribution and use in source and binary forms/i.test(text)) {
    return /name of the (?:copyright holder|author)s? .{0,80}endorse/is.test(text)
      ? 'BSD-3-Clause'
      : 'BSD-2-Clause';
  }
  if (/This is free and unencumbered software released into the public domain/i.test(text)) {
    return 'Unlicense';
  }
  return null;
}

/**
 * Pulls the first copyright line out of a licence text, so the notice file can
 * name a holder instead of just a licence.
 *
 * @param {string} text
 * @returns {string|null}
 */
function copyrightLine(text) {
  const m = text.match(/^.{0,120}\bCopyright\b.{0,160}$/im);
  if (!m) return null;
  return m[0].replace(/\s+/g, ' ').trim();
}

/**
 * @typedef {object} PackageLicence
 * @property {string} path      lockfile path, e.g. `node_modules/ws`
 * @property {string} name
 * @property {string} version
 * @property {string} license   SPDX expression, `UNKNOWN` or `NOT-INSTALLED`
 * @property {'declared'|'file'|'none'} source
 * @property {'allowed'|'copyleft'|'review'} verdict
 * @property {boolean} optional
 * @property {string|null} copyright
 * @property {string|null} repository
 * @property {{file: string, text: string}[]} texts
 * @property {boolean} hasNoticeFile
 */

/**
 * Reads the runtime closure and resolves each member's licence.
 *
 * @returns {PackageLicence[]}
 */
function collect() {
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  /** @type {PackageLicence[]} */
  const out = [];

  for (const [lockPath, entry] of Object.entries(lock.packages || {})) {
    if (lockPath === '' || entry.dev) continue;

    const dir = join(ROOT, lockPath);
    const name = lockPath.replace(/^(?:.*\/)?node_modules\//, '');
    /** @type {PackageLicence} */
    const rec = {
      path: lockPath,
      name,
      version: entry.version || '',
      license: 'NOT-INSTALLED',
      source: 'none',
      verdict: 'review',
      optional: Boolean(entry.optional),
      copyright: null,
      repository: null,
      texts: [],
      hasNoticeFile: false
    };

    const manifestPath = join(dir, 'package.json');
    if (existsSync(manifestPath)) {
      const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
      // `license` is normally a string, but the wild contains the deprecated
      // `{ type }` object form and even a bare array (`pause-stream`).
      let declared = pkg.license;
      if (Array.isArray(declared)) {
        declared = declared
          .map((l) => (typeof l === 'string' ? l : l?.type))
          .filter(Boolean)
          .join(' OR ');
      } else if (declared && typeof declared === 'object') {
        declared = declared.type;
      }
      if (!declared && Array.isArray(pkg.licenses)) {
        declared = pkg.licenses.map((l) => (typeof l === 'string' ? l : l.type)).join(' OR ');
      }
      if (declared) {
        rec.license = String(declared);
        rec.source = 'declared';
      } else {
        rec.license = 'UNKNOWN';
      }
      const repo = pkg.repository;
      rec.repository = typeof repo === 'string' ? repo : repo?.url || pkg.homepage || null;

      for (const file of readdirSync(dir).filter((f) => LICENSE_FILE_RE.test(f))) {
        const full = join(dir, file);
        let text;
        try {
          text = readFileSync(full, 'utf8');
        } catch {
          continue; // a directory named `license/`, or an unreadable file
        }
        rec.texts.push({ file, text });
        if (/^notice/i.test(file)) rec.hasNoticeFile = true;
        rec.copyright = rec.copyright || copyrightLine(text);
        if (rec.license === 'UNKNOWN') {
          const detected = detectFromText(text);
          if (detected) {
            rec.license = detected;
            rec.source = 'file';
          }
        }
      }
    }

    rec.verdict = classify(rec.license);
    out.push(rec);
  }

  out.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return out;
}

/**
 * @param {PackageLicence[]} pkgs
 * @returns {string}
 */
function renderNotices(pkgs) {
  const byLicense = new Map();
  for (const p of pkgs) byLicense.set(p.license, (byLicense.get(p.license) || 0) + 1);

  // Deduplicate the verbatim texts: many packages ship byte-identical files.
  /** @type {Map<string, {text: string, users: string[]}>} */
  const texts = new Map();
  for (const p of pkgs) {
    for (const t of p.texts) {
      if (/^notice/i.test(t.file) || /^licen[cs]e|^copying/i.test(t.file)) {
        const key = createHash('sha256').update(t.text).digest('hex').slice(0, 16);
        const rec = texts.get(key) || { text: t.text, users: [] };
        rec.users.push(`${p.name}@${p.version} (${t.file})`);
        texts.set(key, rec);
      }
    }
  }

  const lines = [];
  lines.push('# Third-party notices — runtime dependencies');
  lines.push('');
  lines.push('<!-- GENERATED FILE — do not edit by hand.');
  lines.push('     Regenerate with: node scripts/audit/licenses.mjs --emit');
  lines.push('     CI checks it is current: node scripts/audit/licenses.mjs --check -->');
  lines.push('');
  lines.push('Général Midi Boop itself is distributed under the MIT License (see');
  lines.push('[`LICENSE`](./LICENSE)). It ships and links the third-party packages listed');
  lines.push('below, each under its own licence. This file exists to satisfy the');
  lines.push('attribution clause those licences carry (MIT/BSD "the above copyright notice');
  lines.push('… shall be included in all copies", Apache-2.0 §4).');
  lines.push('');
  lines.push('Scope: the **runtime** closure — every package `npm ci --omit=dev` installs,');
  lines.push('read from `package-lock.json` (entries not flagged `"dev": true`), including');
  lines.push('`optionalDependencies`. The dev toolchain is not distributed and is not');
  lines.push('listed. Assets that are not code (icons, soundfont, vendored browser');
  lines.push('libraries) are covered separately by');
  lines.push('[`assets/ASSET-LICENSES.md`](./assets/ASSET-LICENSES.md).');
  lines.push('');
  lines.push(`**${pkgs.length} runtime packages.**`);
  lines.push('');
  lines.push('| Licence | Packages |');
  lines.push('|---|---|');
  for (const [lic, n] of [...byLicense].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    lines.push(`| \`${lic}\` | ${n} |`);
  }
  lines.push('');

  // Only packages we actually consume *under* Apache-2.0: a dual licence such
  // as `(BSD-2-Clause OR MIT OR Apache-2.0)` is taken on its MIT branch, which
  // carries no NOTICE obligation.
  const apache = pkgs.filter((p) => {
    const atoms = spdxAtoms(p.license);
    return (
      atoms.some((a) => NEEDS_NOTICE.test(a)) &&
      !atoms.some((a) => ALLOWED.has(a) && !NEEDS_NOTICE.test(a))
    );
  });
  lines.push('## Apache-2.0 packages');
  lines.push('');
  lines.push('Apache-2.0 §4(d) requires us to pass on any `NOTICE` file the author ships.');
  lines.push('');
  lines.push('| Package | Version | Ships a NOTICE file? |');
  lines.push('|---|---|---|');
  for (const p of apache) {
    lines.push(
      `| \`${p.name}\` | ${p.version} | ${p.hasNoticeFile ? '**yes — reproduced below**' : 'no'} |`
    );
  }
  lines.push('');

  lines.push('## Every runtime package');
  lines.push('');
  lines.push('`source = file` means the package declares no `license` field and the SPDX id');
  lines.push('was read off its licence text instead.');
  lines.push('');
  lines.push('| Package | Version | Licence | Source | Copyright holder |');
  lines.push('|---|---|---|---|---|');
  for (const p of pkgs) {
    const holder = p.copyright ? p.copyright.replace(/\|/g, '\\|') : '—';
    lines.push(
      `| \`${p.name}\` | ${p.version} | ${p.license}${p.optional ? ' *(optional)*' : ''} | ${p.source} | ${holder} |`
    );
  }
  lines.push('');

  lines.push('## Verbatim licence texts');
  lines.push('');
  lines.push(`${texts.size} distinct texts cover the ${pkgs.length} packages above.`);
  lines.push('');
  for (const [key, rec] of [...texts].sort((a, b) => a[1].users[0].localeCompare(b[1].users[0]))) {
    lines.push(`### ${key}`);
    lines.push('');
    lines.push(`Applies to: ${rec.users.map((u) => `\`${u}\``).join(', ')}`);
    lines.push('');
    lines.push('```');
    lines.push(rec.text.replace(/```/g, "''`").trimEnd());
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

/**
 * @typedef {object} AssetAudit
 * @property {string[]} files          every shipped non-code asset, repo-relative
 * @property {string[]} unregistered   the ones ASSET-LICENSES.md never names
 * @property {string[]} thirdPartyMarked files carrying an upstream marker
 * @property {boolean} docPresent
 */

/**
 * Walks the distributed asset trees and checks each file is registered in
 * `assets/ASSET-LICENSES.md`. Registration is by base name — the document
 * groups files by directory, so `instruments/harp.svg` is registered as
 * `harp`.
 *
 * @returns {AssetAudit}
 */
function auditAssets() {
  const files = [];
  for (const rel of SHIPPED_ASSET_DIRS) {
    const base = join(ROOT, rel);
    if (!existsSync(base)) continue;
    const stack = [base];
    while (stack.length) {
      const dir = stack.pop();
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        // The licence documents themselves are not assets to register, and
        // `.sf2` blobs are gitignored downloads registered by directory.
        if (/^(ASSET-LICENSES|README)\.md$/i.test(entry.name)) continue;
        if (statSync(full).size === 0) continue;
        files.push(relative(ROOT, full).split('\\').join('/'));
      }
    }
  }
  files.sort();

  const docPresent = existsSync(ASSET_DOC_PATH);
  const doc = docPresent ? readFileSync(ASSET_DOC_PATH, 'utf8') : '';
  const unregistered = files.filter((f) => !doc.includes(basename(f, extname(f))));

  const thirdPartyMarked = files.filter((f) => {
    if (extname(f) !== '.svg') return false;
    try {
      return /svgrepo|Uploaded to:/i.test(readFileSync(join(ROOT, f), 'utf8'));
    } catch {
      return false;
    }
  });

  return { files, unregistered, thirdPartyMarked, docPresent };
}

const packages = collect();
const copyleft = packages.filter((p) => p.verdict === 'copyleft');
const review = packages.filter((p) => p.verdict === 'review');
const notInstalled = packages.filter((p) => p.license === 'NOT-INSTALLED');

if (WANT_JSON) {
  console.log(
    JSON.stringify(
      {
        total: packages.length,
        copyleft: copyleft.map((p) => `${p.name}@${p.version}: ${p.license}`),
        review: review.map((p) => `${p.name}@${p.version}: ${p.license}`),
        packages: packages.map(({ texts, ...rest }) => rest)
      },
      null,
      2
    )
  );
} else {
  const byLicense = new Map();
  for (const p of packages) byLicense.set(p.license, (byLicense.get(p.license) || 0) + 1);
  console.log(`Runtime packages (package-lock.json, non-dev): ${packages.length}`);
  if (notInstalled.length) {
    console.log(
      `  ⚠  ${notInstalled.length} not present in node_modules — run \`npm install --ignore-scripts\` for a real verdict.`
    );
  }
  console.log('');
  for (const [lic, n] of [...byLicense].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${lic}`);
  }
  console.log('');
  console.log(`Copyleft: ${copyleft.length}`);
  for (const p of copyleft) console.log(`  ✗ ${p.name}@${p.version} — ${p.license}`);
  console.log(`Needs a human look: ${review.length}`);
  for (const p of review) console.log(`  ? ${p.name}@${p.version} — ${p.license}`);
}

const assets = WANT_ASSETS || WANT_CHECK ? auditAssets() : null;

if (WANT_ASSETS && assets) {
  console.log('');
  console.log(`Shipped non-code assets: ${assets.files.length}`);
  console.log(`  carrying a third-party upstream marker: ${assets.thirdPartyMarked.length}`);
  console.log(
    `  registered in assets/ASSET-LICENSES.md: ${assets.files.length - assets.unregistered.length}`
  );
  for (const f of assets.unregistered) console.log(`  ✗ unregistered: ${f}`);
  if (!assets.docPresent) console.log('  ✗ assets/ASSET-LICENSES.md is missing');
}

if (WANT_EMIT) {
  writeFileSync(NOTICES_PATH, renderNotices(packages));
  console.error(`Wrote ${NOTICES_PATH}`);
}

if (WANT_CHECK) {
  let failed = false;
  if (!assets.docPresent) {
    console.error('FAIL: assets/ASSET-LICENSES.md is missing.');
    failed = true;
  } else if (assets.unregistered.length) {
    console.error(
      `FAIL: ${assets.unregistered.length} shipped assets are not registered in assets/ASSET-LICENSES.md:`
    );
    for (const f of assets.unregistered) console.error(`  ${f}`);
    failed = true;
  }
  if (copyleft.length) {
    console.error(`FAIL: ${copyleft.length} copyleft runtime dependencies.`);
    failed = true;
  }
  if (review.length) {
    console.error(`FAIL: ${review.length} runtime dependencies with no establishable licence.`);
    failed = true;
  }
  const expected = renderNotices(packages);
  if (!existsSync(NOTICES_PATH)) {
    console.error('FAIL: THIRD-PARTY-NOTICES.md is missing — run with --emit.');
    failed = true;
  } else if (readFileSync(NOTICES_PATH, 'utf8') !== expected) {
    console.error('FAIL: THIRD-PARTY-NOTICES.md is stale — run with --emit.');
    failed = true;
  }
  if (failed) process.exit(1);
  console.error(
    `OK: ${packages.length} runtime licences permissive, THIRD-PARTY-NOTICES.md current, ` +
      `${assets.files.length} shipped assets registered.`
  );
}
