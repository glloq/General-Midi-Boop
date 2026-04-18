/**
 * @file src/persistence/tables/LightingDatabase.js
 * @description SQLite access layer for the lighting subsystem:
 *   - `lighting_devices`  — physical / virtual lighting devices.
 *   - `lighting_rules`    — condition→action rules (MIDI → light).
 *   - `lighting_presets`  — named snapshots of the rule set.
 *   - `lighting_groups`   — named groups for bulk control.
 *
 * Sub-module of {@link Database}; consumed via `LightingRepository`
 * and the LightingManager.
 */
import { buildDynamicUpdate } from '../dbHelpers.js';

class LightingDatabase {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {Object} logger
   */
  constructor(db, logger) {
    this.db = db;
    this.logger = logger;
  }

  // ==================== LIGHTING DEVICES ====================

  insertDevice(device) {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO lighting_devices (name, type, connection_config, led_count, enabled)
        VALUES (?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        device.name,
        device.type || 'gpio',
        typeof device.connection_config === 'string'
          ? device.connection_config
          : JSON.stringify(device.connection_config || {}),
        device.led_count || 1,
        device.enabled !== false ? 1 : 0
      );

      return result.lastInsertRowid;
    } catch (error) {
      this.logger.error(`Failed to insert lighting device: ${error.message}`);
      throw error;
    }
  }

  getDevice(id) {
    try {
      const row = this.db.prepare('SELECT * FROM lighting_devices WHERE id = ?').get(id);
      return row ? this._parseDevice(row) : null;
    } catch (error) {
      this.logger.error(`Failed to get lighting device: ${error.message}`);
      throw error;
    }
  }

  getDevices() {
    try {
      const rows = this.db.prepare('SELECT * FROM lighting_devices ORDER BY name').all();
      return rows.map(r => this._parseDevice(r));
    } catch (error) {
      this.logger.error(`Failed to get lighting devices: ${error.message}`);
      throw error;
    }
  }

  updateDevice(id, updates) {
    try {
      const jsonify = v => typeof v === 'string' ? v : JSON.stringify(v);
      const result = buildDynamicUpdate('lighting_devices', updates,
        ['name', 'type', 'connection_config', 'led_count', 'enabled'],
        {
          transforms: {
            connection_config: jsonify,
            enabled: v => v ? 1 : 0
          }
        }
      );
      if (!result) return;
      this.db.prepare(result.sql).run(...result.values, id);
    } catch (error) {
      this.logger.error(`Failed to update lighting device: ${error.message}`);
      throw error;
    }
  }

  deleteDevice(id) {
    try {
      this.db.prepare('DELETE FROM lighting_devices WHERE id = ?').run(id);
    } catch (error) {
      this.logger.error(`Failed to delete lighting device: ${error.message}`);
      throw error;
    }
  }

  // ==================== LIGHTING RULES ====================

  insertRule(rule) {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO lighting_rules (name, device_id, instrument_id, priority, enabled, condition_config, action_config)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        rule.name || '',
        rule.device_id,
        rule.instrument_id || null,
        rule.priority || 0,
        rule.enabled !== false ? 1 : 0,
        typeof rule.condition_config === 'string'
          ? rule.condition_config
          : JSON.stringify(rule.condition_config || {}),
        typeof rule.action_config === 'string'
          ? rule.action_config
          : JSON.stringify(rule.action_config || {})
      );

      return result.lastInsertRowid;
    } catch (error) {
      this.logger.error(`Failed to insert lighting rule: ${error.message}`);
      throw error;
    }
  }

  getRule(id) {
    try {
      const row = this.db.prepare('SELECT * FROM lighting_rules WHERE id = ?').get(id);
      return row ? this._parseRule(row) : null;
    } catch (error) {
      this.logger.error(`Failed to get lighting rule: ${error.message}`);
      throw error;
    }
  }

  getRulesForDevice(deviceId) {
    try {
      const rows = this.db.prepare(
        'SELECT * FROM lighting_rules WHERE device_id = ? ORDER BY priority DESC, id'
      ).all(deviceId);
      return rows.map(r => this._parseRule(r));
    } catch (error) {
      this.logger.error(`Failed to get rules for device: ${error.message}`);
      throw error;
    }
  }

  getAllEnabledRules() {
    try {
      const rows = this.db.prepare(
        'SELECT r.*, d.enabled as device_enabled FROM lighting_rules r JOIN lighting_devices d ON r.device_id = d.id WHERE r.enabled = 1 AND d.enabled = 1 ORDER BY r.priority DESC, r.id'
      ).all();
      return rows.map(r => this._parseRule(r));
    } catch (error) {
      this.logger.error(`Failed to get all enabled rules: ${error.message}`);
      throw error;
    }
  }

  getAllRules() {
    try {
      const rows = this.db.prepare('SELECT * FROM lighting_rules ORDER BY device_id, priority DESC, id').all();
      return rows.map(r => this._parseRule(r));
    } catch (error) {
      this.logger.error(`Failed to get all rules: ${error.message}`);
      throw error;
    }
  }

  updateRule(id, updates) {
    try {
      const jsonify = v => typeof v === 'string' ? v : JSON.stringify(v);
      const result = buildDynamicUpdate('lighting_rules', updates,
        ['name', 'device_id', 'instrument_id', 'priority', 'enabled', 'condition_config', 'action_config'],
        {
          transforms: {
            enabled: v => v ? 1 : 0,
            condition_config: jsonify,
            action_config: jsonify
          }
        }
      );
      if (!result) return;
      this.db.prepare(result.sql).run(...result.values, id);
    } catch (error) {
      this.logger.error(`Failed to update lighting rule: ${error.message}`);
      throw error;
    }
  }

  deleteRule(id) {
    try {
      this.db.prepare('DELETE FROM lighting_rules WHERE id = ?').run(id);
    } catch (error) {
      this.logger.error(`Failed to delete lighting rule: ${error.message}`);
      throw error;
    }
  }

  // ==================== LIGHTING PRESETS ====================

  insertPreset(preset) {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO lighting_presets (name, rules_snapshot) VALUES (?, ?)
      `);

      const result = stmt.run(
        preset.name,
        typeof preset.rules_snapshot === 'string'
          ? preset.rules_snapshot
          : JSON.stringify(preset.rules_snapshot || [])
      );

      return result.lastInsertRowid;
    } catch (error) {
      this.logger.error(`Failed to insert lighting preset: ${error.message}`);
      throw error;
    }
  }

  getPresets() {
    try {
      const rows = this.db.prepare('SELECT * FROM lighting_presets ORDER BY name').all();
      return rows.map(r => ({
        ...r,
        rules_snapshot: this._safeJsonParse(r.rules_snapshot, [])
      }));
    } catch (error) {
      this.logger.error(`Failed to get lighting presets: ${error.message}`);
      throw error;
    }
  }

  deletePreset(id) {
    try {
      this.db.prepare('DELETE FROM lighting_presets WHERE id = ?').run(id);
    } catch (error) {
      this.logger.error(`Failed to delete lighting preset: ${error.message}`);
      throw error;
    }
  }

  // ==================== LIGHTING GROUPS ====================

  insertGroup(name, deviceIds) {
    try {
      const stmt = this.db.prepare('INSERT INTO lighting_groups (name, device_ids) VALUES (?, ?)');
      const result = stmt.run(name, JSON.stringify(deviceIds));
      return result.lastInsertRowid;
    } catch (error) {
      this.logger.error(`Failed to insert lighting group: ${error.message}`);
      throw error;
    }
  }

  getGroups() {
    try {
      const rows = this.db.prepare('SELECT * FROM lighting_groups ORDER BY name').all();
      return rows.map(r => ({
        ...r,
        device_ids: this._safeJsonParse(r.device_ids, [])
      }));
    } catch (error) {
      this.logger.error(`Failed to get lighting groups: ${error.message}`);
      return [];
    }
  }

  updateGroup(name, deviceIds) {
    try {
      this.db.prepare('UPDATE lighting_groups SET device_ids = ? WHERE name = ?')
        .run(JSON.stringify(deviceIds), name);
    } catch (error) {
      this.logger.error(`Failed to update lighting group: ${error.message}`);
      throw error;
    }
  }

  deleteGroup(name) {
    try {
      this.db.prepare('DELETE FROM lighting_groups WHERE name = ?').run(name);
    } catch (error) {
      this.logger.error(`Failed to delete lighting group: ${error.message}`);
      throw error;
    }
  }

  // ==================== HELPERS ====================

  _parseDevice(row) {
    return {
      ...row,
      connection_config: this._safeJsonParse(row.connection_config, {}),
      enabled: !!row.enabled
    };
  }

  _parseRule(row) {
    return {
      ...row,
      condition_config: this._safeJsonParse(row.condition_config, {}),
      action_config: this._safeJsonParse(row.action_config, {}),
      enabled: !!row.enabled
    };
  }

  _safeJsonParse(str, fallback) {
    try {
      return JSON.parse(str);
    } catch {
      return fallback;
    }
  }
}

export default LightingDatabase;
