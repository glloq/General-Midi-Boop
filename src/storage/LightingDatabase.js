// src/storage/LightingDatabase.js

class LightingDatabase {
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
      const fields = [];
      const values = [];

      if (updates.name !== undefined) {
        fields.push('name = ?');
        values.push(updates.name);
      }
      if (updates.type !== undefined) {
        fields.push('type = ?');
        values.push(updates.type);
      }
      if (updates.connection_config !== undefined) {
        fields.push('connection_config = ?');
        values.push(typeof updates.connection_config === 'string'
          ? updates.connection_config
          : JSON.stringify(updates.connection_config));
      }
      if (updates.led_count !== undefined) {
        fields.push('led_count = ?');
        values.push(updates.led_count);
      }
      if (updates.enabled !== undefined) {
        fields.push('enabled = ?');
        values.push(updates.enabled ? 1 : 0);
      }

      if (fields.length === 0) return;

      values.push(id);
      this.db.prepare(`UPDATE lighting_devices SET ${fields.join(', ')} WHERE id = ?`).run(...values);
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
      const fields = [];
      const values = [];

      if (updates.name !== undefined) {
        fields.push('name = ?');
        values.push(updates.name);
      }
      if (updates.device_id !== undefined) {
        fields.push('device_id = ?');
        values.push(updates.device_id);
      }
      if (updates.instrument_id !== undefined) {
        fields.push('instrument_id = ?');
        values.push(updates.instrument_id);
      }
      if (updates.priority !== undefined) {
        fields.push('priority = ?');
        values.push(updates.priority);
      }
      if (updates.enabled !== undefined) {
        fields.push('enabled = ?');
        values.push(updates.enabled ? 1 : 0);
      }
      if (updates.condition_config !== undefined) {
        fields.push('condition_config = ?');
        values.push(typeof updates.condition_config === 'string'
          ? updates.condition_config
          : JSON.stringify(updates.condition_config));
      }
      if (updates.action_config !== undefined) {
        fields.push('action_config = ?');
        values.push(typeof updates.action_config === 'string'
          ? updates.action_config
          : JSON.stringify(updates.action_config));
      }

      if (fields.length === 0) return;

      values.push(id);
      this.db.prepare(`UPDATE lighting_rules SET ${fields.join(', ')} WHERE id = ?`).run(...values);
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
