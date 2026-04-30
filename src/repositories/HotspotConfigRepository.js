/**
 * @file src/repositories/HotspotConfigRepository.js
 * @description Persists the WiFi-hotspot configuration in the existing
 * `settings` key-value table under a single JSON value (`hotspot_config`).
 *
 * Storing the config as one JSON blob keeps writes atomic and avoids a
 * dedicated table/migration for what is a small, app-private record.
 *
 * The password is stored in clear because nmcli requires the cleartext
 * PSK to (re)create the AP profile. The DB file is local-only on the Pi
 * (file permissions are the access boundary).
 */

const KEY = 'hotspot_config';

const DEFAULTS = Object.freeze({
  ssid: 'GMBoop',
  password: '',
  band: 'bg',     // 'bg' = 2.4 GHz, 'a' = 5 GHz
  channel: 0      // 0 = auto
});

export default class HotspotConfigRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.db = db;
  }

  /**
   * @returns {{ssid:string, password:string, band:string, channel:number}}
   *   Defaults are returned when no row exists yet.
   */
  get() {
    try {
      const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
      if (!row || !row.value) return { ...DEFAULTS };
      const parsed = JSON.parse(row.value);
      return { ...DEFAULTS, ...parsed };
    } catch {
      return { ...DEFAULTS };
    }
  }

  /**
   * Replace the persisted config (merging on top of the previous value
   * so callers can update one field at a time).
   *
   * @param {Partial<{ssid:string, password:string, band:string, channel:number}>} patch
   * @returns {{ssid:string, password:string, band:string, channel:number}}
   */
  update(patch) {
    const merged = { ...this.get(), ...(patch || {}) };
    const value = JSON.stringify(merged);
    // Two-statement upsert: the table has a CHECK on `type`, so we set
    // it explicitly when creating the row.
    this.db.prepare(
      `INSERT INTO settings (key, value, type, description)
       VALUES (?, ?, 'json', 'WiFi hotspot configuration (SSID, password, band, channel)')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, type = 'json'`
    ).run(KEY, value);
    return merged;
  }
}
