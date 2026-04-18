// scripts/migrate-db.js
// One-shot CLI that applies pending SQL migrations from migrations/.
// Uses the same code path as the server so behaviour stays in sync.

import { openDatabase } from '../src/persistence/DatabaseLifecycle.js';

const DB_PATH = process.env.DB_PATH || './data/midimind.db';

const logger = {
  info: (m) => console.log(`[info] ${m}`),
  warn: (m) => console.warn(`[warn] ${m}`),
  error: (m) => console.error(`[error] ${m}`),
  debug: () => {}
};

function main() {
  console.log('=== Ma-est-tro Database Migration ===\n');
  try {
    const db = openDatabase(DB_PATH, logger);
    db.close();
    console.log('\nDatabase up to date.');
    process.exit(0);
  } catch (error) {
    console.error(`\nMigration failed: ${error.message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export default main;
