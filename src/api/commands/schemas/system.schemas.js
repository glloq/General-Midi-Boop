/**
 * @file src/api/commands/schemas/system.schemas.js
 * @description Declarative validation schemas for `system_*` WebSocket
 * commands. Consumed by `JsonValidator.validateByCommand`.
 */

/**
 * `system_backup`: optional `path` must be a string when present.
 * Preserves the historical error message exactly.
 */
export const system_backup = {
  custom: (data) => {
    if (data.path && typeof data.path !== 'string') {
      return 'path must be a string';
    }
    return null;
  }
};

// ── F-19 backfill: the 3 payload-taking system commands ──────────────
// `SystemCommands` accepted 100 % of the hostile frames it was fuzzed with.
// Most of the module is parameter-free (see `validation-policy.js`), but these
// three are not — and two of them touch the host: `system_update` runs
// `git pull` + `npm install` + restart, `system_restore` swaps the live
// database file (docs/audit/2026-09-07/01_API_CONTRACT.md §3.3).

/** `system_update` only ever distinguishes "beta" from everything else. */
export const system_update = {
  custom: (data) => {
    if (data.type === undefined || data.type === null) return null;
    return data.type === 'beta' || data.type === 'stable'
      ? null
      : 'type must be one of: stable, beta';
  }
};

/**
 * `system_restore`: a backup filename. The handler already applies
 * `basename()` plus a "no `..`, no leading dot, must stay inside ./backups"
 * guard; the schema stops a non-string (or a 200 000-character string) before
 * it reaches `resolve()`.
 */
export const system_restore = {
  custom: (data) => {
    if (data.path === undefined || data.path === null) return null;
    if (typeof data.path !== 'string' || data.path.length === 0) return 'path must be a string';
    if (data.path.length > 255) return 'path must be at most 255 characters';
    // eslint-disable-next-line no-control-regex -- control bytes are exactly what we reject
    if (/[\x00-\x1f]/.test(data.path)) return 'path must not contain control bytes';
    return null;
  }
};

/** `system_logs`: tail length. Clamped by the handler, typed here. */
export const system_logs = {
  custom: (data) => {
    if (data.lines === undefined || data.lines === null) return null;
    return Number.isInteger(data.lines) && data.lines > 0
      ? null
      : 'lines must be a positive integer';
  }
};

const schemas = {
  system_backup,
  system_update,
  system_restore,
  system_logs
};

export default schemas;
