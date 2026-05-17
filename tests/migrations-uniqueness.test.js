/**
 * @file tests/migrations-uniqueness.test.js
 * @description Regression guard for the migration runner. The runner keys
 * `schema_version` rows by the numeric prefix of each filename, so two
 * files sharing that prefix would cause the second to be skipped
 * silently (see AUDIT 2026-05-10 §1). Fail fast if any version is reused.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('migrations/', () => {
  const migrationsDir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));

  test('every .sql file has a numeric prefix', () => {
    for (const f of files) {
      const v = parseInt(f.split('_')[0], 10);
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  test('no two migrations share the same version prefix', () => {
    const byVersion = new Map();
    for (const f of files) {
      const v = parseInt(f.split('_')[0], 10);
      if (!byVersion.has(v)) byVersion.set(v, []);
      byVersion.get(v).push(f);
    }
    const collisions = [...byVersion.entries()].filter(([, list]) => list.length > 1);
    expect(collisions).toEqual([]);
  });
});
