// tests/migration-legacy-reconcile.test.js
// Audit A3 UPGRADE-M1: reconcileLegacySchemaVersion must re-apply the
// post-baseline migrations on a pre-baseline DB (whose legacy integer versions
// 2..N would otherwise gate them out), and be a strict no-op on fresh /
// new-baseline DBs. Driven with a stubbed DB handle (no native binding needed).

import { describe, test, expect, jest } from '@jest/globals';
import { reconcileLegacySchemaVersion } from '../src/persistence/DatabaseLifecycle.js';

function makeDb({ version1Desc, throwOnSelect = false } = {}) {
  const runCalls = [];
  const db = {
    prepare(sql) {
      return {
        get: () => {
          if (throwOnSelect) throw new Error('no such table: schema_version');
          if (/SELECT description FROM schema_version WHERE version = 1/.test(sql)) {
            return version1Desc === undefined ? undefined : { description: version1Desc };
          }
          return undefined;
        },
        run: (...args) => {
          runCalls.push({ sql, args });
        }
      };
    },
    // db.transaction(fn) returns a function that runs fn when called.
    transaction: (fn) => fn
  };
  return { db, runCalls };
}

const logger = () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() });

describe('reconcileLegacySchemaVersion (audit A3 UPGRADE-M1)', () => {
  test('legacy DB: rewrites version 1 and drops stale rows >= 2', () => {
    const { db, runCalls } = makeDb({ version1Desc: 'initial schema' });
    const log = logger();
    reconcileLegacySchemaVersion(db, log);
    const updated = runCalls.find((c) => /UPDATE schema_version SET description/.test(c.sql));
    const deleted = runCalls.find((c) =>
      /DELETE FROM schema_version WHERE version >= 2/.test(c.sql)
    );
    expect(updated).toBeTruthy();
    expect(deleted).toBeTruthy();
    expect(log.warn).toHaveBeenCalled();
  });

  test('new-baseline DB: no changes (version 1 is the baseline marker)', () => {
    const { db, runCalls } = makeDb({
      version1Desc: 'Baseline schema v6.0 (consolidates legacy migrations 001-040)'
    });
    const log = logger();
    reconcileLegacySchemaVersion(db, log);
    expect(runCalls).toHaveLength(0);
    expect(log.warn).not.toHaveBeenCalled();
  });

  test('fresh DB (no schema_version table): no-op, no throw', () => {
    const { db, runCalls } = makeDb({ throwOnSelect: true });
    const log = logger();
    expect(() => reconcileLegacySchemaVersion(db, log)).not.toThrow();
    expect(runCalls).toHaveLength(0);
  });

  test('schema_version exists but no version-1 row: no-op', () => {
    const { db, runCalls } = makeDb({ version1Desc: undefined });
    const log = logger();
    reconcileLegacySchemaVersion(db, log);
    expect(runCalls).toHaveLength(0);
  });
});
