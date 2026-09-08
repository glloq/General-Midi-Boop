/**
 * @file tests/audit/r9-update-restore-point.test.js
 * @description Wave 2 — R9 / F-120, F-121. The restore point itself.
 *
 * `scripts/update.sh` is sourced in **library mode**
 * (`GMBOOP_UPDATE_LIB_ONLY=1`): it defines its helpers and returns before the
 * main flow, so each piece of the restore-point machinery can be exercised on
 * its own against a throwaway repository. Two whole-script runs cover what
 * cannot be unit-tested: recovery from a run that was killed mid-flight
 * (the power-cut case) and the orphan `.git/index.lock` it leaves behind.
 *
 * The last block is a set of assertions on the script text: they are the
 * regression guard for the *criticality* rule — the actual defect behind
 * F-120 was that failing a migration and failing to copy an icon were both
 * warnings.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { readFileSync, writeFileSync, mkdirSync, utimesSync } from 'fs';
import { join } from 'path';
import { createSandbox, REAL_SCRIPT } from './r9-update-sandbox.js';

/** Strip ANSI colours so assertions read plainly. */
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const plain = (s) => (s || '').replace(ANSI, '');

describe('R9 — library mode touches nothing', () => {
  let sb;
  beforeAll(() => {
    sb = createSandbox();
  });
  afterAll(() => sb.cleanup());

  test('sourcing the script defines the helpers and returns', () => {
    const r = sb.lib('declare -F | awk "{print \\$3}" | sort | tr "\\n" " "');
    expect(r.status).toBe(0);
    for (const fn of [
      '_create_restore_point',
      '_clear_restore_point',
      '_check_stale_restore_point',
      '_clear_orphan_index_lock',
      '_snapshot_config',
      '_restore_config',
      '_snapshot_database',
      '_restore_database',
      '_rollback',
      '_critical_failure'
    ]) {
      expect(r.stdout).toContain(fn);
    }
  });

  test('no status file, no stash, no pull, no restart', () => {
    expect(sb.exists('logs/update-status')).toBe(false);
    expect(sb.commands()).toEqual([]);
    expect(sb.read('src/marker.txt').trim()).toBe('v1');
  });
});

describe('R9 / F-121 — config.json snapshot and restore', () => {
  let sb;
  beforeEach(() => {
    sb = createSandbox();
    sb.write('config.json', '{"operator":"port 8081 on an external SSD"}\n');
  });
  afterEach(() => sb.cleanup());

  test('a snapshot survives config.json being clobbered', () => {
    const r = sb.lib(`_snapshot_config || exit 3
echo '{"upstream":"defaults"}' > config.json
_restore_config || exit 4`);
    expect(r.status).toBe(0);
    expect(sb.read('config.json')).toBe('{"operator":"port 8081 on an external SSD"}\n');
    expect(plain(r.stdout)).toContain('config.json restored from the restore point');
  });

  test('an untouched config.json is left strictly alone', () => {
    const r = sb.lib('_snapshot_config && _restore_config');
    expect(r.status).toBe(0);
    expect(plain(r.stdout)).not.toContain('restored');
  });

  test('restoring without a snapshot is a no-op, not an error', () => {
    const r = sb.lib('_restore_config; echo "rc=$?"');
    expect(r.stdout).toContain('rc=0');
    expect(sb.read('config.json')).toBe('{"operator":"port 8081 on an external SSD"}\n');
  });

  test('a restore point saves config.json, the revision and the branch', () => {
    const r = sb.lib('_create_restore_point');
    expect(r.status).toBe(0);
    expect(sb.read('logs/update-restore/head').trim()).toBe(sb.head());
    expect(sb.read('logs/update-restore/branch').trim()).toBe('main');
    expect(sb.read('logs/update-restore/config.json')).toContain('operator');
    expect(sb.exists('logs/update-restore/in-progress')).toBe(true);
  });

  test('the in-progress marker is what distinguishes a finished run', () => {
    const r = sb.lib('_create_restore_point && _clear_restore_point');
    expect(r.status).toBe(0);
    expect(sb.exists('logs/update-restore/in-progress')).toBe(false);
  });
});

describe('R9 / F-120 — database snapshot and restore', () => {
  let sb;
  beforeAll(() => {
    sb = createSandbox();
  });
  afterAll(() => sb.cleanup());

  test('the database path comes from config.json', () => {
    const r = sb.lib('_db_path');
    expect(r.stdout.trim()).toBe(join(sb.work, 'data/gmboop.db'));
  });

  test('a failed migration is undone by the snapshot', () => {
    const r = sb.lib(`_snapshot_database || exit 3
echo "PARTIAL-MIGRATION" >> data/gmboop.db
_restore_database || exit 4`);
    expect(r.status).toBe(0);
    expect(sb.read('data/gmboop.db')).toBe('SCHEMA_V1\n');
    // The half-migrated file is moved aside, never deleted.
    expect(plain(r.stdout)).toContain('migrated copy kept as *.failed-update-');
  });

  test('restoring without a snapshot fails loudly rather than silently', () => {
    const r = sb.lib('_restore_database; echo "rc=$?"');
    expect(r.stdout).toContain('rc=1');
    expect(plain(r.stdout)).toContain('No database snapshot to restore');
  });
});

describe('R9 / F-120 — recovering from a run killed mid-flight (power cut)', () => {
  let sb;
  let result;
  beforeAll(() => {
    sb = createSandbox();
    // Simulate what a power cut leaves behind: an armed restore point that
    // was never cleared, plus a config.json the interrupted run had already
    // replaced with the upstream defaults.
    mkdirSync(join(sb.work, 'logs/update-restore'), { recursive: true });
    writeFileSync(join(sb.work, 'logs/update-restore/head'), 'deadbeefdeadbeefdeadbeefdeadbeef\n');
    writeFileSync(join(sb.work, 'logs/update-restore/branch'), 'main\n');
    writeFileSync(join(sb.work, 'logs/update-restore/created-at'), '2026-09-07 03:00:00\n');
    writeFileSync(
      join(sb.work, 'logs/update-restore/config.json'),
      '{"operator":"survived the power cut"}\n'
    );
    writeFileSync(join(sb.work, 'logs/update-restore/in-progress'), '');
    sb.write('config.json', '{"upstream":"defaults"}\n');
    sb.publishUpstream();
    result = sb.run();
  }, 60000);
  afterAll(() => sb.cleanup());

  test('the next run notices and says when the interrupted update started', () => {
    expect(plain(sb.log())).toContain('A previous update never finished');
    expect(plain(sb.log())).toContain('2026-09-07 03:00:00');
  });

  test('it puts config.json back — always safe, and the thing users lose', () => {
    expect(sb.read('config.json')).toBe('{"operator":"survived the power cut"}\n');
  });

  test('it does NOT revert the code on its own, but prints the exact command', () => {
    // The box may have been running happily on the new revision for weeks.
    expect(plain(sb.log())).toContain('reset --hard deadbeefdeadbeefdeadbeefdeadbeef');
    expect(result.status).toBe(0);
  });

  test('and the update itself proceeds normally afterwards', () => {
    expect(sb.status()).toBe('done');
    expect(sb.read('src/marker.txt').trim()).toBe('v2');
  });
});

describe('R9 / F-120 — the orphan .git/index.lock a power cut leaves behind', () => {
  test('an old lock is removed so git works again', () => {
    const sb = createSandbox();
    try {
      const lock = join(sb.work, '.git/index.lock');
      writeFileSync(lock, '');
      const old = Date.now() / 1000 - 3600;
      utimesSync(lock, old, old);
      sb.publishUpstream();
      const r = sb.run();
      // Without this, every later git command fails and the box needs SSH.
      expect(plain(sb.log())).toMatch(/Removed orphan \.git\/index\.lock/);
      expect(r.status).toBe(0);
      expect(sb.status()).toBe('done');
    } finally {
      sb.cleanup();
    }
  }, 60000);

  test('a fresh lock is left alone — another git process may hold it', () => {
    const sb = createSandbox();
    try {
      writeFileSync(join(sb.work, '.git/index.lock'), '');
      const r = sb.lib('_clear_orphan_index_lock; echo "rc=$?"');
      expect(r.stdout).toContain('rc=1');
      expect(plain(r.stdout)).toContain('another git process may be running');
      expect(sb.exists('.git/index.lock')).toBe(true);
    } finally {
      sb.cleanup();
    }
  });
});

describe('R9 — critical steps are critical, cosmetic steps are cosmetic', () => {
  const script = readFileSync(REAL_SCRIPT, 'utf8');

  test('the criticality rule is written down, not just implemented', () => {
    expect(script).toMatch(/CRITICAL\s*:/);
    expect(script).toMatch(/COSMETIC\s*:/);
  });

  test('npm install, migrations, restart and the port check are critical', () => {
    expect(script).toContain('_critical_failure "npm install failed"');
    expect(script).toContain('_critical_failure "database migration failed"');
    expect(script).toContain('_critical_failure "server restart failed"');
    expect(script).toContain(
      '_critical_failure "server is not listening on port $SERVER_PORT after the update"'
    );
  });

  test('the migration error is no longer thrown away by 2>/dev/null', () => {
    expect(script).not.toMatch(/npm run migrate 2>\/dev\/null/);
    expect(script).toContain('if npm run migrate 2>&1; then');
  });

  test('the web bundle stays a warning — the server still serves public/', () => {
    expect(script).toContain('Web build failed (cosmetic step');
    expect(script).not.toMatch(/_critical_failure "web build/i);
  });

  test('"cannot probe the port" is not the same as "the port is closed"', () => {
    // A minimal host without lsof/ss/netstat must not roll back every update.
    expect(script).toContain('PORT_PROBE_AVAILABLE');
    expect(script).toContain('No port probe available');
  });

  test('the restore point is created before anything is stashed or pulled', () => {
    const created = script.indexOf('if ! _create_restore_point; then');
    const stashed = script.indexOf('git stash push -m "Auto-stash before update');
    const pulled = script.indexOf('if git pull origin "$TARGET_BRANCH"; then');
    expect(created).toBeGreaterThan(0);
    expect(created).toBeLessThan(stashed);
    expect(created).toBeLessThan(pulled);
  });
});
