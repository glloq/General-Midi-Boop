/**
 * @file src/persistence/tables/BluetoothDB.js
 * @description CRUD for the `bluetooth_paired_devices` table — the persistent
 * list of paired BLE-MIDI instruments so they survive a reboot and can be
 * auto-reconnected. Sub-module of {@link Database}.
 */
class BluetoothDB {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {Object} logger
   */
  constructor(db, logger) {
    this.db = db;
    this.logger = logger;
  }

  /** @returns {Array<{address:string,name:string,auto_reconnect:number,last_connected_at:?string}>} */
  listPaired() {
    try {
      return this.db
        .prepare(
          'SELECT address, name, auto_reconnect, last_connected_at FROM bluetooth_paired_devices ORDER BY last_connected_at DESC'
        )
        .all();
    } catch (error) {
      this.logger.error(`BluetoothDB.listPaired failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Insert or update a paired device (keeps `auto_reconnect` when already set).
   * @param {string} address
   * @param {string} name
   */
  upsertPaired(address, name) {
    try {
      this.db
        .prepare(
          `INSERT INTO bluetooth_paired_devices (address, name)
           VALUES (?, ?)
           ON CONFLICT(address) DO UPDATE SET name = excluded.name`
        )
        .run(address, name ?? null);
    } catch (error) {
      this.logger.error(`BluetoothDB.upsertPaired failed: ${error.message}`);
    }
  }

  /** Stamp the most recent successful connection time. @param {string} address */
  markConnected(address) {
    try {
      this.db
        .prepare(
          "UPDATE bluetooth_paired_devices SET last_connected_at = datetime('now') WHERE address = ?"
        )
        .run(address);
    } catch (error) {
      this.logger.error(`BluetoothDB.markConnected failed: ${error.message}`);
    }
  }

  /** @param {string} address @param {boolean} enabled */
  setAutoReconnect(address, enabled) {
    try {
      this.db
        .prepare('UPDATE bluetooth_paired_devices SET auto_reconnect = ? WHERE address = ?')
        .run(enabled ? 1 : 0, address);
    } catch (error) {
      this.logger.error(`BluetoothDB.setAutoReconnect failed: ${error.message}`);
    }
  }

  /** @param {string} address */
  removePaired(address) {
    try {
      this.db.prepare('DELETE FROM bluetooth_paired_devices WHERE address = ?').run(address);
    } catch (error) {
      this.logger.error(`BluetoothDB.removePaired failed: ${error.message}`);
    }
  }
}

export default BluetoothDB;
