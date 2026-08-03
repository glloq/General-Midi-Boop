/** @type {import('jest').Config} */

const { readdirSync, readFileSync, statSync } = require('fs');
const { join } = require('path');

// Check if better-sqlite3 native bindings are available. The `midi` native
// module (and better-sqlite3) are often absent in containers/CI where the
// project is installed with `npm install --ignore-scripts` (see CLAUDE.md), so
// the SQLite-backed suites must be skipped rather than fail with a bindings
// error.
let hasBetterSqlite = false;
try {
  const Database = require('better-sqlite3');
  // Actually try to create an in-memory database — requiring the module alone
  // does NOT load the native binding; only instantiating a Database does.
  const db = new Database(':memory:');
  db.close();
  hasBetterSqlite = true;
} catch {
  // Native bindings not compiled
}

// A suite genuinely needs the native SQLite bindings when it imports
// `better-sqlite3` directly, constructs the top-level persistence
// Database/DatabaseManager (which connects in its constructor), or runs the
// migration runner. Detecting this from the test source keeps the skip list
// self-maintaining: new SQLite-backed suites are picked up automatically
// instead of silently failing once the hard-coded list drifts.
const NEEDS_SQLITE = /better-sqlite3|\bnew DatabaseManager\s*\(|new Database\s*\(\s*\{|runMigrations\s*\(/;

function collectSqliteSuites(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'frontend') collectSqliteSuites(full, acc);
    } else if (entry.endsWith('.test.js')) {
      if (NEEDS_SQLITE.test(readFileSync(full, 'utf8'))) acc.push(full);
    }
  }
  return acc;
}

// `audit-i18n.test.js` uses the Vitest API (it is run by the frontend Vitest
// project, see vitest.config.js), so it must never be collected by Jest.
const ignorePatterns = ['/node_modules/', '/tests/frontend/', '/tests/audit-i18n.test.js'];

if (!hasBetterSqlite) {
  for (const suite of collectSqliteSuites(join(__dirname, 'tests'))) {
    // Anchor on the repo-relative path so only this exact file is ignored.
    ignorePatterns.push(suite.slice(__dirname.length).replace(/\\/g, '/'));
  }
}

module.exports = {
  testMatch: ['**/tests/**/*.test.js', '!**/tests/frontend/**'],
  testPathIgnorePatterns: ignorePatterns,
  transform: {},
};
