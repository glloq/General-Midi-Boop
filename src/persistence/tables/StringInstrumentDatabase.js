/**
 * @file src/persistence/tables/StringInstrumentDatabase.js
 * @description SQLite access layer for guitar/bass/violin configuration
 * and tablature data. Owns the `string_instruments` (tuning, fret
 * count, capo, CC mapping) and `string_instrument_tablatures` tables,
 * plus an in-memory tuning-preset catalogue. Sub-module of
 * {@link Database}; consumed via `StringInstrumentRepository` and the
 * {@link TablatureConverter} workflow.
 */

/**
 * Database access layer for string instrument configuration and tablature data.
 * Manages the string_instruments and string_instrument_tablatures tables.
 */
class StringInstrumentDatabase {
  constructor(db, logger) {
    this.db = db;
    this.logger = logger;
  }

  // ==================== TUNING PRESETS ====================

  /**
   * Built-in tuning presets for common string instruments.
   * Each tuning is an array of MIDI note numbers from lowest to highest string.
   */
  static TUNING_PRESETS = {
    // Guitar (6 strings)
    'guitar_standard':    { name: 'Guitar Standard (EADGBE)',      strings: 6, frets: 24, tuning: [40, 45, 50, 55, 59, 64] },
    'guitar_drop_d':      { name: 'Guitar Drop D (DADGBE)',        strings: 6, frets: 24, tuning: [38, 45, 50, 55, 59, 64] },
    'guitar_open_g':      { name: 'Guitar Open G (DGDGBD)',        strings: 6, frets: 24, tuning: [38, 43, 50, 55, 59, 62] },
    'guitar_open_d':      { name: 'Guitar Open D (DADF#AD)',       strings: 6, frets: 24, tuning: [38, 45, 50, 54, 57, 62] },
    'guitar_dadgad':      { name: 'Guitar DADGAD',                 strings: 6, frets: 24, tuning: [38, 45, 50, 55, 57, 62] },
    'guitar_open_e':      { name: 'Guitar Open E (EBEG#BE)',       strings: 6, frets: 24, tuning: [40, 47, 52, 56, 59, 64] },
    'guitar_half_down':   { name: 'Guitar Half Step Down',         strings: 6, frets: 24, tuning: [39, 44, 49, 54, 58, 63] },
    'guitar_full_down':   { name: 'Guitar Full Step Down',         strings: 6, frets: 24, tuning: [38, 43, 48, 53, 57, 62] },

    // Guitar 7-string
    'guitar_7_standard':  { name: 'Guitar 7-String Standard (BEADGBE)', strings: 7, frets: 24, tuning: [35, 40, 45, 50, 55, 59, 64] },

    // Guitar 12-string (same tuning as standard, doubled strings)
    'guitar_12_standard': { name: 'Guitar 12-String Standard (EADGBE)', strings: 6, frets: 24, tuning: [40, 45, 50, 55, 59, 64] },

    // Bass (4 strings)
    'bass_4_standard':    { name: 'Bass 4-String Standard (EADG)', strings: 4, frets: 24, tuning: [28, 33, 38, 43] },
    'bass_4_drop_d':      { name: 'Bass 4-String Drop D (DADG)',   strings: 4, frets: 24, tuning: [26, 33, 38, 43] },

    // Bass (5 strings)
    'bass_5_standard':    { name: 'Bass 5-String Standard (BEADG)', strings: 5, frets: 24, tuning: [23, 28, 33, 38, 43] },

    // Bass (6 strings)
    'bass_6_standard':    { name: 'Bass 6-String Standard (BEADGC)', strings: 6, frets: 24, tuning: [23, 28, 33, 38, 43, 48] },

    // Ukulele (4 strings)
    'ukulele_standard':   { name: 'Ukulele Standard (GCEA)',       strings: 4, frets: 18, tuning: [67, 60, 64, 69] },
    'ukulele_low_g':      { name: 'Ukulele Low G (GCEA)',           strings: 4, frets: 18, tuning: [55, 60, 64, 69] },
    'ukulele_baritone':   { name: 'Ukulele Baritone (DGBE)',       strings: 4, frets: 18, tuning: [50, 55, 59, 64] },

    // Banjo (5 strings)
    'banjo_standard':     { name: 'Banjo Open G (gDGBD)',          strings: 5, frets: 22, tuning: [67, 50, 55, 59, 62] },

    // Violin family (fretless)
    'violin':             { name: 'Violin (GDAE)',                 strings: 4, frets: 0, tuning: [55, 62, 69, 76], fretless: true },
    'viola':              { name: 'Viola (CGDA)',                   strings: 4, frets: 0, tuning: [48, 55, 62, 69], fretless: true },
    'cello':              { name: 'Cello (CGDA)',                   strings: 4, frets: 0, tuning: [36, 43, 50, 57], fretless: true },
    'contrabass':         { name: 'Contrabass (EADG)',              strings: 4, frets: 0, tuning: [28, 33, 38, 43], fretless: true },

    // Mandolin (4 doubled strings, same tuning as violin)
    'mandolin':           { name: 'Mandolin (GDAE)',               strings: 4, frets: 20, tuning: [55, 62, 69, 76] },
  };

  // ==================== STRING INSTRUMENTS CRUD ====================

  /**
   * Create a new string instrument configuration
   * @param {Object} config
   * @param {string} config.device_id - Device identifier
   * @param {number} config.channel - MIDI channel (0-15)
   * @param {string} [config.instrument_name] - Display name
   * @param {number} [config.num_strings] - Number of strings (1-6)
   * @param {number} [config.num_frets] - Number of frets (0=fretless, 1-36)
   * @param {number[]} [config.tuning] - MIDI note numbers per string (low to high)
   * @param {boolean} [config.is_fretless] - Whether the instrument is fretless
   * @param {number} [config.capo_fret] - Capo position (0=none)
   * @returns {number} Inserted row ID
   */
  createStringInstrument(config) {
    try {
      // Ensure num_strings matches tuning array length
      const tuning = config.tuning || [40, 45, 50, 55, 59, 64];
      if (Array.isArray(tuning)) {
        config.num_strings = tuning.length;
      }

      this._validateConfig(config);

      const tuningJson = JSON.stringify(tuning);

      const fretsPerStringJson = config.frets_per_string
        ? JSON.stringify(Array.isArray(config.frets_per_string) ? config.frets_per_string : JSON.parse(config.frets_per_string))
        : null;

      const stmt = this.db.prepare(`
        INSERT INTO string_instruments (
          device_id, channel, instrument_name, num_strings, num_frets,
          tuning, is_fretless, capo_fret, cc_enabled, tab_algorithm,
          cc_string_number, cc_string_min, cc_string_max, cc_string_offset,
          cc_fret_number, cc_fret_min, cc_fret_max, cc_fret_offset,
          frets_per_string
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_id, channel) DO UPDATE SET
          instrument_name = excluded.instrument_name,
          num_strings = excluded.num_strings,
          num_frets = excluded.num_frets,
          tuning = excluded.tuning,
          is_fretless = excluded.is_fretless,
          capo_fret = excluded.capo_fret,
          cc_enabled = excluded.cc_enabled,
          tab_algorithm = excluded.tab_algorithm,
          cc_string_number = excluded.cc_string_number,
          cc_string_min = excluded.cc_string_min,
          cc_string_max = excluded.cc_string_max,
          cc_string_offset = excluded.cc_string_offset,
          cc_fret_number = excluded.cc_fret_number,
          cc_fret_min = excluded.cc_fret_min,
          cc_fret_max = excluded.cc_fret_max,
          cc_fret_offset = excluded.cc_fret_offset,
          frets_per_string = excluded.frets_per_string
      `);

      const result = stmt.run(
        config.device_id,
        config.channel || 0,
        config.instrument_name || 'Guitar',
        config.num_strings || 6,
        config.num_frets !== undefined ? config.num_frets : 24,
        tuningJson,
        config.is_fretless ? 1 : 0,
        config.capo_fret || 0,
        config.cc_enabled !== undefined ? (config.cc_enabled ? 1 : 0) : 1,
        config.tab_algorithm || 'min_movement',
        config.cc_string_number !== undefined ? config.cc_string_number : 20,
        config.cc_string_min !== undefined ? config.cc_string_min : 1,
        config.cc_string_max !== undefined ? config.cc_string_max : 12,
        config.cc_string_offset || 0,
        config.cc_fret_number !== undefined ? config.cc_fret_number : 21,
        config.cc_fret_min !== undefined ? config.cc_fret_min : 0,
        config.cc_fret_max !== undefined ? config.cc_fret_max : 36,
        config.cc_fret_offset || 0,
        fretsPerStringJson
      );

      this.logger.info(`String instrument created/updated for ${config.device_id} ch${config.channel}`);
      return result.lastInsertRowid;
    } catch (error) {
      this.logger.error(`Failed to create string instrument: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get string instrument config by device + channel
   * @param {string} deviceId
   * @param {number} channel
   * @returns {Object|null} Parsed config with tuning as array
   */
  getStringInstrument(deviceId, channel) {
    try {
      const row = this.db.prepare(
        'SELECT * FROM string_instruments WHERE device_id = ? AND channel = ?'
      ).get(deviceId, channel || 0);

      return row ? this._parseRow(row) : null;
    } catch (error) {
      this.logger.error(`Failed to get string instrument: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get string instrument config by ID
   * @param {number} id
   * @returns {Object|null}
   */
  getStringInstrumentById(id) {
    try {
      const row = this.db.prepare('SELECT * FROM string_instruments WHERE id = ?').get(id);
      return row ? this._parseRow(row) : null;
    } catch (error) {
      this.logger.error(`Failed to get string instrument by ID: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get all string instruments
   * @returns {Array<Object>}
   */
  getAllStringInstruments() {
    try {
      const rows = this.db.prepare('SELECT * FROM string_instruments ORDER BY device_id, channel').all();
      return rows.map(row => this._parseRow(row));
    } catch (error) {
      this.logger.error(`Failed to get all string instruments: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get all string instruments for a device
   * @param {string} deviceId
   * @returns {Array<Object>}
   */
  getStringInstrumentsByDevice(deviceId) {
    try {
      const rows = this.db.prepare(
        'SELECT * FROM string_instruments WHERE device_id = ? ORDER BY channel'
      ).all(deviceId);
      return rows.map(row => this._parseRow(row));
    } catch (error) {
      this.logger.error(`Failed to get string instruments by device: ${error.message}`);
      throw error;
    }
  }

  /**
   * Update a string instrument configuration
   * @param {number} id - String instrument ID
   * @param {Object} updates - Fields to update
   * @returns {boolean} True if row was updated
   */
  updateStringInstrument(id, updates) {
    try {
      // Sync num_strings from tuning array length (tuning is authoritative)
      if (updates.tuning) {
        const tuning = Array.isArray(updates.tuning) ? updates.tuning : JSON.parse(updates.tuning);
        updates.num_strings = tuning.length;
      }

      const fields = [];
      const values = [];

      if (updates.instrument_name !== undefined) {
        fields.push('instrument_name = ?');
        values.push(updates.instrument_name);
      }
      if (updates.num_strings !== undefined) {
        if (updates.num_strings < 1 || updates.num_strings > 12) {
          throw new Error('num_strings must be between 1 and 12');
        }
        fields.push('num_strings = ?');
        values.push(updates.num_strings);
      }
      if (updates.num_frets !== undefined) {
        if (updates.num_frets < 0 || updates.num_frets > 36) {
          throw new Error('num_frets must be between 0 and 36');
        }
        fields.push('num_frets = ?');
        values.push(updates.num_frets);
      }
      if (updates.tuning !== undefined) {
        const tuning = Array.isArray(updates.tuning) ? updates.tuning : JSON.parse(updates.tuning);
        for (const note of tuning) {
          if (note < 0 || note > 127) {
            throw new Error('Tuning note values must be between 0 and 127');
          }
        }
        fields.push('tuning = ?');
        values.push(JSON.stringify(tuning));
      }
      if (updates.is_fretless !== undefined) {
        fields.push('is_fretless = ?');
        values.push(updates.is_fretless ? 1 : 0);
      }
      if (updates.capo_fret !== undefined) {
        if (updates.capo_fret < 0 || updates.capo_fret > 36) {
          throw new Error('capo_fret must be between 0 and 36');
        }
        fields.push('capo_fret = ?');
        values.push(updates.capo_fret);
      }
      if (updates.cc_enabled !== undefined) {
        fields.push('cc_enabled = ?');
        values.push(updates.cc_enabled ? 1 : 0);
      }
      if (updates.tab_algorithm !== undefined) {
        const valid = ['min_movement', 'lowest_fret', 'highest_fret', 'zone'];
        if (!valid.includes(updates.tab_algorithm)) {
          throw new Error(`tab_algorithm must be one of: ${valid.join(', ')}`);
        }
        fields.push('tab_algorithm = ?');
        values.push(updates.tab_algorithm);
      }

      // CC configuration fields
      for (const ccField of ['cc_string_number', 'cc_fret_number']) {
        if (updates[ccField] !== undefined) {
          if (updates[ccField] < 0 || updates[ccField] > 127) {
            throw new Error(`${ccField} must be between 0 and 127`);
          }
          fields.push(`${ccField} = ?`);
          values.push(updates[ccField]);
        }
      }
      for (const ccField of ['cc_string_min', 'cc_string_max', 'cc_fret_min', 'cc_fret_max']) {
        if (updates[ccField] !== undefined) {
          if (updates[ccField] < 0 || updates[ccField] > 127) {
            throw new Error(`${ccField} must be between 0 and 127`);
          }
          fields.push(`${ccField} = ?`);
          values.push(updates[ccField]);
        }
      }
      for (const ccField of ['cc_string_offset', 'cc_fret_offset']) {
        if (updates[ccField] !== undefined) {
          if (updates[ccField] < -127 || updates[ccField] > 127) {
            throw new Error(`${ccField} must be between -127 and 127`);
          }
          fields.push(`${ccField} = ?`);
          values.push(updates[ccField]);
        }
      }

      // Per-string fret count
      if (updates.frets_per_string !== undefined) {
        if (updates.frets_per_string === null) {
          fields.push('frets_per_string = ?');
          values.push(null);
        } else {
          const fps = Array.isArray(updates.frets_per_string)
            ? updates.frets_per_string
            : JSON.parse(updates.frets_per_string);
          for (const f of fps) {
            if (f < 0 || f > 36) throw new Error('frets_per_string values must be between 0 and 36');
          }
          fields.push('frets_per_string = ?');
          values.push(JSON.stringify(fps));
        }
      }

      if (fields.length === 0) return false;

      values.push(id);
      this.db.prepare(`UPDATE string_instruments SET ${fields.join(', ')} WHERE id = ?`).run(...values);

      this.logger.info(`String instrument ${id} updated`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to update string instrument: ${error.message}`);
      throw error;
    }
  }

  /**
   * Delete a string instrument configuration
   * Also deletes associated tablatures via ON DELETE CASCADE
   * @param {number} id
   */
  deleteStringInstrument(id) {
    try {
      this.db.prepare('DELETE FROM string_instruments WHERE id = ?').run(id);
      this.logger.info(`String instrument ${id} deleted`);
    } catch (error) {
      this.logger.error(`Failed to delete string instrument: ${error.message}`);
      throw error;
    }
  }

  /**
   * Delete string instrument by device + channel
   * @param {string} deviceId
   * @param {number} channel
   */
  deleteStringInstrumentByDeviceChannel(deviceId, channel) {
    try {
      this.db.prepare(
        'DELETE FROM string_instruments WHERE device_id = ? AND channel = ?'
      ).run(deviceId, channel || 0);
      this.logger.info(`String instrument deleted for ${deviceId} ch${channel}`);
    } catch (error) {
      this.logger.error(`Failed to delete string instrument by device/channel: ${error.message}`);
      throw error;
    }
  }

  /**
   * Delete string instruments for a device (optionally scoped to one channel).
   * Encapsulates raw `DELETE FROM string_instruments` SQL previously duplicated
   * in handlers (P0-2.5n).
   */
  deleteByDevice(deviceId, channel) {
    try {
      if (channel !== undefined && channel !== null) {
        this.db.prepare(
          'DELETE FROM string_instruments WHERE device_id = ? AND channel = ?'
        ).run(deviceId, channel);
      } else {
        this.db.prepare(
          'DELETE FROM string_instruments WHERE device_id = ?'
        ).run(deviceId);
      }
    } catch (error) {
      this.logger.error(`Failed to delete string instruments by device: ${error.message}`);
      throw error;
    }
  }

  // ==================== TUNING PRESETS ====================

  /**
   * Get all available tuning presets
   * @returns {Object} Map of preset key to preset config
   */
  getTuningPresets() {
    return StringInstrumentDatabase.TUNING_PRESETS;
  }

  /**
   * Get a specific tuning preset
   * @param {string} presetKey
   * @returns {Object|null}
   */
  getTuningPreset(presetKey) {
    return StringInstrumentDatabase.TUNING_PRESETS[presetKey] || null;
  }

  // ==================== TABLATURE DATA ====================

  /**
   * Save tablature data for a MIDI file channel
   * @param {number} midiFileId
   * @param {number} channel
   * @param {number} stringInstrumentId
   * @param {Array} tablatureData - Array of {tick, string, fret, velocity, duration}
   * @returns {number} Inserted/updated row ID
   */
  saveTablature(midiFileId, channel, stringInstrumentId, tablatureData) {
    try {
      const dataJson = JSON.stringify(tablatureData);

      const stmt = this.db.prepare(`
        INSERT INTO string_instrument_tablatures (
          midi_file_id, channel, string_instrument_id, tablature_data
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(midi_file_id, channel) DO UPDATE SET
          string_instrument_id = excluded.string_instrument_id,
          tablature_data = excluded.tablature_data
      `);

      const result = stmt.run(midiFileId, channel || 0, stringInstrumentId, dataJson);
      this.logger.info(`Tablature saved for file ${midiFileId} ch${channel}`);
      return result.lastInsertRowid;
    } catch (error) {
      this.logger.error(`Failed to save tablature: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get tablature data for a MIDI file channel
   * @param {number} midiFileId
   * @param {number} channel
   * @returns {Object|null} Tablature record with parsed data array
   */
  getTablature(midiFileId, channel) {
    try {
      const row = this.db.prepare(
        'SELECT * FROM string_instrument_tablatures WHERE midi_file_id = ? AND channel = ?'
      ).get(midiFileId, channel || 0);

      if (!row) return null;

      return {
        ...row,
        tablature_data: JSON.parse(row.tablature_data)
      };
    } catch (error) {
      this.logger.error(`Failed to get tablature: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get all tablatures for a MIDI file
   * @param {number} midiFileId
   * @returns {Array<Object>}
   */
  getTablaturesByFile(midiFileId) {
    try {
      const rows = this.db.prepare(
        'SELECT * FROM string_instrument_tablatures WHERE midi_file_id = ? ORDER BY channel'
      ).all(midiFileId);

      return rows.map(row => ({
        ...row,
        tablature_data: JSON.parse(row.tablature_data)
      }));
    } catch (error) {
      this.logger.error(`Failed to get tablatures by file: ${error.message}`);
      throw error;
    }
  }

  /**
   * Delete tablature for a MIDI file channel
   * @param {number} midiFileId
   * @param {number} channel
   */
  deleteTablature(midiFileId, channel) {
    try {
      this.db.prepare(
        'DELETE FROM string_instrument_tablatures WHERE midi_file_id = ? AND channel = ?'
      ).run(midiFileId, channel || 0);
    } catch (error) {
      this.logger.error(`Failed to delete tablature: ${error.message}`);
      throw error;
    }
  }

  /**
   * Delete all tablatures for a MIDI file
   * @param {number} midiFileId
   */
  deleteTablaturesByFile(midiFileId) {
    try {
      this.db.prepare(
        'DELETE FROM string_instrument_tablatures WHERE midi_file_id = ?'
      ).run(midiFileId);
    } catch (error) {
      this.logger.error(`Failed to delete tablatures for file: ${error.message}`);
      throw error;
    }
  }

  // ==================== INTERNAL HELPERS ====================

  /**
   * Parse a database row, converting JSON strings to arrays
   * @private
   */
  _parseRow(row) {
    let tuning = [40, 45, 50, 55, 59, 64];
    if (row.tuning) {
      try {
        tuning = JSON.parse(row.tuning);
      } catch (e) {
        this.logger.warn(`Failed to parse tuning for string instrument ${row.id}: ${e.message}`);
      }
    }

    // Authoritative string count = tuning array length (fixes any DB desync)
    const num_strings = tuning.length;

    // Parse frets_per_string JSON if present
    let frets_per_string = null;
    if (row.frets_per_string) {
      try {
        frets_per_string = JSON.parse(row.frets_per_string);
      } catch (e) {
        this.logger.warn(`Failed to parse frets_per_string for string instrument ${row.id}: ${e.message}`);
      }
    }

    return {
      id: row.id,
      device_id: row.device_id,
      channel: row.channel,
      instrument_name: row.instrument_name,
      num_strings,
      num_frets: row.num_frets,
      tuning,
      is_fretless: !!row.is_fretless,
      capo_fret: row.capo_fret,
      cc_enabled: row.cc_enabled !== undefined ? !!row.cc_enabled : true,
      tab_algorithm: row.tab_algorithm || 'min_movement',
      // CC configuration
      cc_string_number: row.cc_string_number !== undefined ? row.cc_string_number : 20,
      cc_string_min: row.cc_string_min !== undefined ? row.cc_string_min : 1,
      cc_string_max: row.cc_string_max !== undefined ? row.cc_string_max : 12,
      cc_string_offset: row.cc_string_offset || 0,
      cc_fret_number: row.cc_fret_number !== undefined ? row.cc_fret_number : 21,
      cc_fret_min: row.cc_fret_min !== undefined ? row.cc_fret_min : 0,
      cc_fret_max: row.cc_fret_max !== undefined ? row.cc_fret_max : 36,
      cc_fret_offset: row.cc_fret_offset || 0,
      // Per-string fret count
      frets_per_string,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  /**
   * Validate string instrument configuration
   * @private
   */
  _validateConfig(config) {
    if (!config.device_id) {
      throw new Error('device_id is required');
    }

    if (config.num_strings !== undefined) {
      if (config.num_strings < 1 || config.num_strings > 12) {
        throw new Error('num_strings must be between 1 and 12');
      }
    }

    if (config.num_frets !== undefined) {
      if (config.num_frets < 0 || config.num_frets > 36) {
        throw new Error('num_frets must be between 0 and 36');
      }
    }

    if (config.tuning) {
      const tuning = Array.isArray(config.tuning) ? config.tuning : JSON.parse(config.tuning);
      const expectedStrings = config.num_strings || 6;
      if (tuning.length !== expectedStrings) {
        throw new Error(`Tuning array length (${tuning.length}) must match num_strings (${expectedStrings})`);
      }
      for (const note of tuning) {
        if (note < 0 || note > 127) {
          throw new Error('Tuning note values must be between 0 and 127');
        }
      }
    }

    if (config.capo_fret !== undefined) {
      if (config.capo_fret < 0 || config.capo_fret > 36) {
        throw new Error('capo_fret must be between 0 and 36');
      }
    }
  }
}

export default StringInstrumentDatabase;
