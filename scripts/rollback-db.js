#!/usr/bin/env node
// scripts/rollback-db.js
// Usage: node scripts/rollback-db.js [steps]
// Rolls back the last N database migrations (default: 1)

import Config from '../src/core/Config.js';
import Logger from '../src/core/Logger.js';
import Database from '../src/persistence/Database.js';

const steps = parseInt(process.argv[2]) || 1;

const config = new Config();
const logger = new Logger(config.logging);

// Minimal app mock for Database constructor
const app = { config, logger };

try {
  const db = new Database(app);
  console.log(`Rolling back ${steps} migration(s)...`);
  db.rollbackMigrations(steps);
  console.log('Rollback completed successfully.');
  db.close();
} catch (error) {
  console.error(`Rollback failed: ${error.message}`);
  process.exit(1);
}
