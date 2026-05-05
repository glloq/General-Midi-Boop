/**
 * @file src/infrastructure/auth/ApiTokenManager.js
 * @description Ensures a bearer token exists for the HTTP/WebSocket API.
 *
 * If `GMBOOP_API_TOKEN` is not set in the environment, a 32-byte random
 * hex token is generated, written to `.env` (or appended when the file
 * already exists), exported via `process.env`, and logged once as a
 * warning so the operator can copy it.
 *
 * Extracted from Application._ensureApiToken() to keep the composition
 * root free of filesystem/bootstrap concerns.
 */
import { randomBytes } from 'crypto';
import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

export class ApiTokenManager {
  /** @param {Object} logger */
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * Ensure `GMBOOP_API_TOKEN` is set. No-op if already configured.
   * @returns {void}
   */
  ensure() {
    if (process.env.GMBOOP_API_TOKEN) {
      this.logger.info('API token already configured');
      return;
    }

    const token = randomBytes(32).toString('hex');
    const envPath = resolve('.env');

    try {
      if (existsSync(envPath)) {
        const content = readFileSync(envPath, 'utf8');
        if (content.includes('GMBOOP_API_TOKEN')) {
          const updated = content.replace(/^GMBOOP_API_TOKEN=.*$/m, `GMBOOP_API_TOKEN=${token}`);
          writeFileSync(envPath, updated, 'utf8');
        } else {
          appendFileSync(envPath, `\nGMBOOP_API_TOKEN=${token}\n`, 'utf8');
        }
      } else {
        writeFileSync(envPath, `GMBOOP_API_TOKEN=${token}\n`, 'utf8');
      }
    } catch (err) {
      this.logger.warn(`Could not persist API token to .env: ${err.message}`);
    }

    process.env.GMBOOP_API_TOKEN = token;
    this.logger.warn(`=== AUTO-GENERATED API TOKEN ===`);
    this.logger.warn(`Token: ${token}`);
    this.logger.warn(`Save this token — it is required to access the API.`);
    this.logger.warn(`================================`);
  }
}
