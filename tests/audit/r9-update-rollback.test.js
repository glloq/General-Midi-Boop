/**
 * @file tests/audit/r9-update-rollback.test.js
 * @description Wave 2 — R9 / F-120, F-121. Rollback of an in-place update.
 *
 * Before this suite, `scripts/update.sh` had no rollback at all: once
 * `git pull` succeeded, a failing `npm install`, a failing Vite build and a
 * failing migration were all *warnings*, and the script still exited 0 on a
 * half-updated installation. The audit's power-cut analysis
 * (`docs/audit/2026-09-07/11_SYSTEM_INSTALL.md` §4.2) made the stakes plain:
 * a headless Pi left non-bootable, in a restart loop, in a corner.
 *
 * Every test here runs the REAL script, unmodified, inside a disposable git
 * repository with stubbed `npm`/`node`/`lsof`/`systemctl`/`curl`
 * (`r9-update-sandbox.js`). The host is never updated, no service is
 * restarted, nothing is pulled from the network.
 *
 * What is proven:
 *   - a critical failure (npm install, migrations, restart, port check) puts
 *     the code, the configuration and the database back and reports `failed:`;
 *   - a cosmetic failure (production web bundle) is a warning and the update
 *     completes;
 *   - `config.json` — the file the operator edits by hand — survives the
 *     auto-stash, an upstream change to the same file, and `git reset --hard`
 *     (F-121);
 *   - the restore point is armed before anything is touched and cleared only
 *     on success, so a run killed by a power cut is detectable afterwards.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createSandbox } from './r9-update-sandbox.js';

/** Operator-edited config: a non-default port and a database on an SSD. */
const OPERATOR_CONFIG =
  JSON.stringify(
    { server: { port: 8081, host: '0.0.0.0' }, database: { path: './data/gmboop.db' } },
    null,
    2
  ) + '\n';

/** Upstream ships a different config.json in the very same update. */
const UPSTREAM_CONFIG =
  JSON.stringify(
    { server: { port: 9999, host: '0.0.0.0' }, database: { path: './data/gmboop.db' } },
    null,
    2
  ) + '\n';

/**
 * One update run: operator config in place (uncommitted), a new upstream
 * revision that also touches config.json, then the script.
 *
 * @param {Object} [env] Failure injection for the stubs.
 */
function runUpdate(env = {}) {
  const sb = createSandbox();
  sb.write('config.json', OPERATOR_CONFIG);
  const headBefore = sb.head();
  const headUpstream = sb.publishUpstream((up) => {
    writeFileSync(join(up, 'config.json'), UPSTREAM_CONFIG);
  });
  const result = sb.run(env);
  return { sb, headBefore, headUpstream, result };
}

describe('R9 / F-120 — a successful update goes all the way through', () => {
  let ctx;
  beforeAll(() => {
    ctx = runUpdate();
  }, 60000);
  afterAll(() => ctx.sb.cleanup());

  test('exits 0, lands on the new revision and reports "done"', () => {
    expect(ctx.result.status).toBe(0);
    expect(ctx.sb.head()).toBe(ctx.headUpstream);
    expect(ctx.sb.read('src/marker.txt').trim()).toBe('v2');
    expect(ctx.sb.status()).toBe('done');
  });

  test('runs the steps in the only rollback-able order: pull, deps, build, migrate', () => {
    // Migrations must come AFTER the code (the new migration files do not
    // exist before the pull) and BEFORE the restart (the new code needs the
    // new schema). That order is what forces a pre-migration snapshot.
    expect(ctx.sb.commands()).toEqual(['npm install', 'npm run build', 'npm run migrate']);
    const log = ctx.sb.log();
    expect(log.indexOf('Pulling latest changes')).toBeLessThan(
      log.indexOf('Running database migrations')
    );
    expect(log.indexOf('Running database migrations')).toBeLessThan(
      log.indexOf('Restarting Server')
    );
  });

  test('takes a database snapshot before migrating and keeps it', () => {
    const backups = readdirSync(join(ctx.sb.work, 'backups'));
    expect(backups.filter((f) => /^pre-update-.*\.db$/.test(f))).toHaveLength(1);
    expect(ctx.sb.read('data/gmboop.db')).toContain('MIGRATED');
  });

  test('clears the in-progress marker so the next run knows this one finished', () => {
    expect(ctx.sb.exists('logs/update-restore/in-progress')).toBe(false);
    expect(ctx.sb.exists('logs/update-restore/head')).toBe(true);
  });

  test('F-121 — config.json keeps the operator values, not the upstream ones', () => {
    // The auto-stash swallowed it and the pull shipped a new one; the restore
    // point put the operator's copy back.
    expect(JSON.parse(ctx.sb.read('config.json')).server.port).toBe(8081);
    expect(ctx.sb.log()).toContain('config.json restored from the restore point');
  });
});

describe('R9 / F-120 — a failing npm install rolls the update back', () => {
  let ctx;
  beforeAll(() => {
    ctx = runUpdate({ FAIL_INSTALL: '1' });
  }, 60000);
  afterAll(() => ctx.sb.cleanup());

  test('exits non-zero instead of pretending to have succeeded', () => {
    // Previous behaviour: print_warning "continuing with existing
    // dependencies" and exit 0 with new code on old dependencies.
    expect(ctx.result.status).not.toBe(0);
    expect(ctx.sb.log()).toContain('Critical step failed: npm install failed');
  });

  test('restores the previous revision', () => {
    expect(ctx.sb.head()).toBe(ctx.headBefore);
    expect(ctx.sb.read('src/marker.txt').trim()).toBe('v1');
  });

  test('reports the failure and the revision it went back to', () => {
    expect(ctx.sb.status()).toMatch(/^failed: npm install failed \(rolled back to [0-9a-f]{7}\)$/);
  });

  test('never reaches the migrations', () => {
    expect(ctx.sb.commands()).not.toContain('npm run migrate');
    expect(ctx.sb.read('data/gmboop.db')).not.toContain('MIGRATED');
  });

  test('config.json still holds the operator values', () => {
    expect(JSON.parse(ctx.sb.read('config.json')).server.port).toBe(8081);
  });
});

describe('R9 / F-120 — a failing migration rolls back code AND database', () => {
  let ctx;
  beforeAll(() => {
    ctx = runUpdate({ FAIL_MIGRATE: '1' });
  }, 60000);
  afterAll(() => ctx.sb.cleanup());

  test('exits non-zero and restores the previous revision', () => {
    expect(ctx.result.status).not.toBe(0);
    expect(ctx.sb.head()).toBe(ctx.headBefore);
    expect(ctx.sb.status()).toMatch(/^failed: database migration failed \(rolled back to /);
  });

  test('puts the pre-migration database back, keeping the broken one aside', () => {
    // SQL migrations have no down-step: the snapshot is the only way back.
    expect(ctx.sb.read('data/gmboop.db')).toBe('SCHEMA_V1\n');
    const data = readdirSync(join(ctx.sb.work, 'data'));
    expect(data.some((f) => f.startsWith('gmboop.db.failed-update-'))).toBe(true);
  });

  test('no longer throws the migration error away (the old `2>/dev/null`)', () => {
    expect(ctx.sb.log()).toContain('SQLITE_ERROR');
  });

  test('config.json still holds the operator values', () => {
    expect(JSON.parse(ctx.sb.read('config.json')).server.port).toBe(8081);
  });
});

describe('R9 — a failing web build is COSMETIC: warn, keep going', () => {
  let ctx;
  beforeAll(() => {
    ctx = runUpdate({ FAIL_BUILD: '1' });
  }, 60000);
  afterAll(() => ctx.sb.cleanup());

  test('completes the update: the server still boots and serves public/', () => {
    expect(ctx.result.status).toBe(0);
    expect(ctx.sb.status()).toBe('done');
    expect(ctx.sb.head()).toBe(ctx.headUpstream);
  });

  test('says so explicitly rather than failing silently', () => {
    expect(ctx.sb.log()).toContain('Web build failed (cosmetic step');
  });

  test('does not leave a half-written dist/ behind', () => {
    // The server only tests for dist/index.html; a truncated bundle would be
    // served as if it were good.
    expect(ctx.sb.exists('dist/index.html')).toBe(false);
    expect(ctx.sb.exists('dist.prev')).toBe(false);
  });

  test('the migrations still ran — a cosmetic failure stops nothing', () => {
    expect(ctx.sb.read('data/gmboop.db')).toContain('MIGRATED');
  });
});

describe('R9 / F-120 — the server not coming back is a failure, not a warning', () => {
  let ctx;
  beforeAll(() => {
    // The direct-start path "succeeds" (the fake node survives) but the port
    // never opens: exactly the case the old script called
    // "Could not verify server is listening" and exited 0 on.
    ctx = runUpdate({ FAKE_PORT_LISTENING: '0', FAKE_NODE_MODE: 'live' });
  }, 60000);
  afterAll(() => ctx.sb.cleanup());

  test('rolls back and reports the port that stayed dead', () => {
    expect(ctx.result.status).not.toBe(0);
    expect(ctx.sb.status()).toMatch(
      /^failed: server is not listening on port 8080 after the update/
    );
    expect(ctx.sb.head()).toBe(ctx.headBefore);
  });

  test('the rollback restarts the server on the previous version', () => {
    expect(ctx.sb.log()).toContain('Server restarted on the previous version');
  });

  test('database and configuration are back to their pre-update state', () => {
    expect(ctx.sb.read('data/gmboop.db')).toBe('SCHEMA_V1\n');
    expect(JSON.parse(ctx.sb.read('config.json')).server.port).toBe(8081);
  });
});

describe('R9 — UPDATE_ROLLBACK=0 keeps the legacy behaviour, explicitly', () => {
  let ctx;
  beforeAll(() => {
    ctx = runUpdate({ FAIL_INSTALL: '1', UPDATE_ROLLBACK: '0' });
  }, 60000);
  afterAll(() => ctx.sb.cleanup());

  test('leaves the new code in place but still fails loudly', () => {
    expect(ctx.result.status).not.toBe(0);
    expect(ctx.sb.head()).toBe(ctx.headUpstream);
    expect(ctx.sb.status()).toBe('failed: npm install failed (rollback disabled)');
  });

  test('even then, config.json is not sacrificed', () => {
    expect(JSON.parse(ctx.sb.read('config.json')).server.port).toBe(8081);
  });
});
