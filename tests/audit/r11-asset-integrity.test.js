/**
 * @file tests/audit/r11-asset-integrity.test.js
 * @description Wave 2 / R11 — F-109 / F-15 (install half): the two runtime
 * artefacts were downloaded from third-party mirrors with no integrity check
 * whatsoever.
 *
 * The audit's grep is the whole story:
 *
 *   $ grep -n "sha256\|checksum\|createHash\|integrity" scripts/install-default-sf2.js
 *   (no output)
 *
 * What existed instead: a 50 KB floor on the player, a 1 MB floor plus
 * `RIFF`/`sfbk` magic on the soundfont. Those catch an HTML error page and
 * nothing else — a 120 KB player with one extra line sails through, and it is
 * `<script src>`-ed by the SPA on every page load, on the origin holding the
 * authenticated session. One of the five player mirrors even tracked a moving
 * git branch (`…/gh/surikov/webaudiofont@master/…`), so its content changed
 * with nothing in this repository changing. That is nominal behaviour, not an
 * attack.
 *
 * What this suite proves: the mechanism exists, it is enforced on BOTH the
 * download path and the idempotency path, and it fails loudly (non-zero exit,
 * artefact deleted) rather than silently.
 *
 * What it deliberately does NOT claim: that a reference digest has been
 * verified. `PINNED_SHA256` ships null because no trustworthy copy of either
 * artefact was available to hash. The script says so on every run, and so does
 * `assets/sf2/README.md` — that README previously asserted a SHA-256 check
 * that did not exist, which is the failure mode this file is here to prevent.
 */
import { describe, test, expect } from '@jest/globals';
import { spawnSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { sha256File, assertChecksum } from '../../scripts/install-default-sf2.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/install-default-sf2.js');
const scriptSrc = readFileSync(SCRIPT, 'utf8');

/** Capture everything the helpers write to stderr. */
function captureStderr(fn) {
  const lines = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    return { result: fn(), stderr: lines.join('') };
  } finally {
    process.stderr.write = original;
  }
}

describe('R11 / F-109 — the checksum helpers', () => {
  test('sha256File matches the reference digest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gmboop-r11-sf2-'));
    try {
      const f = join(dir, 'artifact.bin');
      const bytes = randomBytes(4096);
      writeFileSync(f, bytes);
      expect(sha256File(f)).toBe(createHash('sha256').update(bytes).digest('hex'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a matching digest keeps the artefact and says so', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gmboop-r11-sf2-'));
    try {
      const f = join(dir, 'artifact.bin');
      writeFileSync(f, 'good bytes');
      const digest = createHash('sha256').update('good bytes').digest('hex');
      const { result } = captureStderr(() => assertChecksum(f, digest, 'artifact.bin'));
      expect(result).toBe(true);
      expect(existsSync(f)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a divergent digest deletes the artefact and complains in full', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gmboop-r11-sf2-'));
    try {
      const f = join(dir, 'artifact.bin');
      writeFileSync(f, 'substituted bytes');
      const expected = createHash('sha256').update('the bytes we vetted').digest('hex');
      const { result, stderr } = captureStderr(() => assertChecksum(f, expected, 'artifact.bin'));
      expect(result).toBe(false);
      // Deleted: a rejected artefact must not stay on disk where a later run
      // (or the app) could pick it up.
      expect(existsSync(f)).toBe(false);
      expect(stderr).toContain('SHA-256 MISMATCH');
      expect(stderr).toContain(expected);
      // And it must not suggest "just update the pin".
      expect(stderr).toMatch(/Do not update the pin/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no pin at all is reported as "NOT verified", never as a pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gmboop-r11-sf2-'));
    try {
      const f = join(dir, 'artifact.bin');
      writeFileSync(f, 'unverified bytes');
      const { result, stderr } = captureStderr(() => assertChecksum(f, null, 'artifact.bin'));
      expect(result).toBe(true); // still installed — but loudly unverified
      expect(stderr).toContain('integrity NOT verified');
      expect(stderr).toContain('GMBOOP_SF2_SHA256');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('R11 / F-109 — the install script end to end', () => {
  /**
   * Run the real script inside a throwaway project scaffold. Every path it
   * touches is derived from its own location, so a copy under a temp root
   * cannot reach the repository.
   */
  function scaffold() {
    const root = mkdtempSync(join(tmpdir(), 'gmboop-r11-install-'));
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'public', 'lib'), { recursive: true });
    mkdirSync(join(root, 'assets', 'sf2'), { recursive: true });
    copyFileSync(SCRIPT, join(root, 'scripts', 'install-default-sf2.js'));

    // Both artefacts already "installed" and above their size floors, so the
    // run takes the idempotent path and never touches the network.
    const player = Buffer.alloc(60 * 1024, 'p');
    const sf2 = Buffer.alloc(1200 * 1024, 's');
    const playerPath = join(root, 'public', 'lib', 'WebAudioFontPlayer.js');
    const sf2Path = join(root, 'assets', 'sf2', 'default.sf2');
    writeFileSync(playerPath, player);
    writeFileSync(sf2Path, sf2);
    return {
      root,
      playerPath,
      sf2Path,
      playerSha: createHash('sha256').update(player).digest('hex'),
      sf2Sha: createHash('sha256').update(sf2).digest('hex'),
      cleanup: () => rmSync(root, { recursive: true, force: true })
    };
  }

  function run(root, env) {
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'install-default-sf2.js')], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 120000
    });
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  }

  test('correct pins: exit 0, both artefacts kept, both reported verified', () => {
    const s = scaffold();
    try {
      const r = run(s.root, {
        GMBOOP_SF2_SHA256: s.sf2Sha,
        GMBOOP_WAF_PLAYER_SHA256: s.playerSha,
        CI: ''
      });
      expect(r.code).toBe(0);
      expect(existsSync(s.playerPath)).toBe(true);
      expect(existsSync(s.sf2Path)).toBe(true);
      expect(r.stdout).toContain('WebAudioFontPlayer.js: SHA-256 verified');
    } finally {
      s.cleanup();
    }
  });

  test('a divergent pin on the player: exit 1, file deleted, loud message', () => {
    const s = scaffold();
    try {
      const r = run(s.root, {
        GMBOOP_SF2_SHA256: s.sf2Sha,
        GMBOOP_WAF_PLAYER_SHA256: 'b'.repeat(64),
        CI: ''
      });
      // Non-zero exit is the point: postinstall aborts `npm install` rather
      // than shipping an artefact nobody vouched for.
      expect(r.code).toBe(1);
      expect(existsSync(s.playerPath)).toBe(false);
      expect(r.stderr).toContain('SHA-256 MISMATCH');
      expect(r.stderr).toContain('INTEGRITY CHECK FAILED');
    } finally {
      s.cleanup();
    }
  });

  test('an already-installed but tampered soundfont is re-checked, not trusted on size', () => {
    // The pre-fix `alreadyPresent()` only compared the file size, so a file
    // altered after installation was never looked at again.
    const s = scaffold();
    try {
      writeFileSync(s.sf2Path, Buffer.alloc(1200 * 1024, 't')); // same size, other bytes
      const r = run(s.root, {
        GMBOOP_SF2_SHA256: s.sf2Sha,
        GMBOOP_WAF_PLAYER_SHA256: s.playerSha,
        GMBOOP_SF2_URL: 'http://127.0.0.1:1/never-reachable.sf2',
        CI: ''
      });
      // It did NOT take the "already present" shortcut: it tried to reinstall.
      expect(r.stdout).not.toContain('default.sf2 already present');
      expect(r.stdout + r.stderr).toMatch(/Downloading default soundfont/);
    } finally {
      s.cleanup();
    }
  });

  test('unreachable mirrors are still non-fatal — only integrity is fatal', () => {
    const s = scaffold();
    try {
      rmSync(s.sf2Path);
      const r = run(s.root, {
        GMBOOP_WAF_PLAYER_SHA256: s.playerSha,
        GMBOOP_SF2_URL: 'http://127.0.0.1:1/never-reachable.sf2',
        CI: ''
      });
      expect(r.code).toBe(0);
      expect(r.stderr).toContain('Could not download default soundfont');
    } finally {
      s.cleanup();
    }
  });

  test('GMBOOP_REQUIRE_PINNED_ASSETS refuses anything unpinned', () => {
    const s = scaffold();
    try {
      const r = run(s.root, { GMBOOP_REQUIRE_PINNED_ASSETS: '1', CI: '' });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('REFUSED');
      expect(existsSync(s.playerPath)).toBe(false);
    } finally {
      s.cleanup();
    }
  });
});

describe('R11 / F-109 — the source no longer matches the audit grep', () => {
  test('the script hashes its artefacts', () => {
    expect(scriptSrc).toMatch(/createHash/);
    expect(scriptSrc).toMatch(/PINNED_SHA256/);
  });

  test('alreadyPresent() consults the digest, not just the size', () => {
    const fn = scriptSrc.slice(
      scriptSrc.indexOf('function alreadyPresent()'),
      scriptSrc.indexOf('function fetchToFile(')
    );
    expect(fn).toMatch(/sha256File\(TARGET_PATH\)/);
    expect(fn).toMatch(/EXPECTED_SHA256\.sf2/);
  });

  test('the moving-branch mirror is gone', () => {
    // cdn.jsdelivr.net/gh/<user>/<repo>@master follows a branch: its content
    // changes with nothing in this repository changing.
    expect(scriptSrc).not.toContain('@master');
    expect(scriptSrc).toMatch(/GMBOOP_WAF_PLAYER_VERSION/);
  });

  test('an integrity failure is the only non-zero exit', () => {
    expect(scriptSrc).toMatch(/integrityFailed/);
    expect(scriptSrc).toMatch(/INTEGRITY CHECK FAILED/);
  });
});

describe('R11 / F-109 — assets/sf2/README.md tells the truth', () => {
  const readme = readFileSync(join(ROOT, 'assets/sf2/README.md'), 'utf8');

  test('it no longer claims an idempotency check "matches the expected SHA-256"', () => {
    // The exact sentence that was false: the script compared file SIZE.
    expect(readme).not.toMatch(/no re-download if the file already exists\s*\n?\s*and matches the expected SHA-256/);
  });

  test('it states plainly that no reference digest is pinned yet', () => {
    expect(readme).toMatch(/PINNED_SHA256\.sf2` in the install script is `null`/);
    expect(readme).toMatch(/Not yet/);
  });

  test('it documents how to pin one', () => {
    expect(readme).toContain('sha256sum assets/sf2/default.sf2');
    expect(readme).toContain('GMBOOP_SF2_SHA256');
  });

  test('it no longer claims the script downloads the licence file', () => {
    expect(readme).toMatch(/The install script does not fetch it/);
  });
});
