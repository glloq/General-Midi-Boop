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
import { existsSync, readFileSync, appendFileSync, writeFileSync, chmodSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Resolve .env relative to the project root (three levels up from src/infrastructure/auth/)
const ENV_PATH = resolve(join(__dirname, '../../../.env'));

export class ApiTokenManager {
  /**
   * @param {Object} logger
   * @param {string} [envPath] Optional override (tests only).
   */
  constructor(logger, envPath = ENV_PATH) {
    this.logger = logger;
    this.envPath = envPath;
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
    const envPath = this.envPath;

    try {
      if (existsSync(envPath)) {
        const content = readFileSync(envPath, 'utf8');
        // Anchor the decision to the same pattern as the replace: a substring
        // match (`includes`) is true for a *different* var like
        // `GMBOOP_API_TOKEN_BACKUP=`, in which case the replace hits nothing,
        // the file is written unchanged, and the token silently rotates every
        // restart (invalidating clients) — audit A2 N5.
        if (/^GMBOOP_API_TOKEN=/m.test(content)) {
          const updated = content.replace(/^GMBOOP_API_TOKEN=.*$/m, `GMBOOP_API_TOKEN=${token}`);
          writeFileSync(envPath, updated, 'utf8');
        } else {
          appendFileSync(envPath, `\nGMBOOP_API_TOKEN=${token}\n`, 'utf8');
        }
      } else {
        // mode 0o600 only takes effect when the file is created; when overwriting
        // an existing file Node ignores it — the chmodSync below covers both cases.
        writeFileSync(envPath, `GMBOOP_API_TOKEN=${token}\n`, { encoding: 'utf8', mode: 0o600 });
      }
      // Restrict to owner read/write — the token grants full API access.
      try {
        chmodSync(envPath, 0o600);
      } catch (chmodErr) {
        // chmod can fail on filesystems that don't support POSIX perms (e.g. FAT-mounted USB).
        // The token is still persisted; log so the operator can harden manually.
        this.logger.warn(`Could not chmod 0600 on ${envPath}: ${chmodErr.message}`);
      }
    } catch (err) {
      this.logger.warn(`Could not persist API token to .env: ${err.message}`);
    }

    process.env.GMBOOP_API_TOKEN = token;
    this.logger.info(`API token auto-generated and saved to ${envPath}`);
  }
}
