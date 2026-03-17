// src/storage/InstrumentDatabase.js

class InstrumentDatabase {
  constructor(db, logger) {
    this.db = db;
    this.logger = logger;
  }

  // ==================== INSTRUMENT PROFILES ====================

  insertInstrument(instrument) {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO instruments (
          name, manufacturer, model, type, midi_channel, program_number, 
          bank_msb, bank_lsb, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        instrument.name,
        instrument.manufacturer || null,
        instrument.model || null,
        instrument.type || 'synth',
        instrument.midi_channel || 0,
        instrument.program_number || 0,
        instrument.bank_msb || null,
        instrument.bank_lsb || null,
        instrument.notes || null
      );

      return result.lastInsertRowid;
    } catch (error) {
      this.logger.error(`Failed to insert instrument: ${error.message}`);
      throw error;
    }
  }

  getInstrument(instrumentId) {
    try {
      const stmt = this.db.prepare('SELECT * FROM instruments WHERE id = ?');
      return stmt.get(instrumentId);
    } catch (error) {
      this.logger.error(`Failed to get instrument: ${error.message}`);
      throw error;
    }
  }

  getInstruments() {
    try {
      const stmt = this.db.prepare('SELECT * FROM instruments ORDER BY name');
      return stmt.all();
    } catch (error) {
      this.logger.error(`Failed to get instruments: ${error.message}`);
      throw error;
    }
  }

  updateInstrument(instrumentId, updates) {
    try {
      const fields = [];
      const values = [];

      if (updates.name !== undefined) {
        fields.push('name = ?');
        values.push(updates.name);
      }
      if (updates.manufacturer !== undefined) {
        fields.push('manufacturer = ?');
        values.push(updates.manufacturer);
      }
      if (updates.model !== undefined) {
        fields.push('model = ?');
        values.push(updates.model);
      }
      if (updates.type !== undefined) {
        fields.push('type = ?');
        values.push(updates.type);
      }
      if (updates.midi_channel !== undefined) {
        fields.push('midi_channel = ?');
        values.push(updates.midi_channel);
      }
      if (updates.program_number !== undefined) {
        fields.push('program_number = ?');
        values.push(updates.program_number);
      }
      if (updates.bank_msb !== undefined) {
        fields.push('bank_msb = ?');
        values.push(updates.bank_msb);
      }
      if (updates.bank_lsb !== undefined) {
        fields.push('bank_lsb = ?');
        values.push(updates.bank_lsb);
      }
      if (updates.notes !== undefined) {
        fields.push('notes = ?');
        values.push(updates.notes);
      }

      if (fields.length === 0) {
        return;
      }

      values.push(instrumentId);

      const stmt = this.db.prepare(`
        UPDATE instruments SET ${fields.join(', ')} WHERE id = ?
      `);

      stmt.run(...values);
    } catch (error) {
      this.logger.error(`Failed to update instrument: ${error.message}`);
      throw error;
    }
  }

  deleteInstrument(instrumentId) {
    try {
      const stmt = this.db.prepare('DELETE FROM instruments WHERE id = ?');
      stmt.run(instrumentId);
    } catch (error) {
      this.logger.error(`Failed to delete instrument: ${error.message}`);
      throw error;
    }
  }

  searchInstruments(query) {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM instruments 
        WHERE name LIKE ? OR manufacturer LIKE ? OR model LIKE ?
        ORDER BY name
      `);
      const searchPattern = `%${query}%`;
      return stmt.all(searchPattern, searchPattern, searchPattern);
    } catch (error) {
      this.logger.error(`Failed to search instruments: ${error.message}`);
      throw error;
    }
  }

  // ==================== LATENCY PROFILES ====================

  saveLatencyProfile(profile) {
    try {
      // Check if profile exists
      const existing = this.db.prepare(
        'SELECT id FROM instrument_latency WHERE device_id = ?'
      ).get(profile.device_id);

      if (existing) {
        // Update existing
        const stmt = this.db.prepare(`
          UPDATE instrument_latency 
          SET latency_ms = ?, last_calibrated = ?, measurement_count = ?,
              average_latency_ms = ?, min_latency_ms = ?, max_latency_ms = ?
          WHERE device_id = ?
        `);

        stmt.run(
          profile.latency_ms,
          profile.last_calibrated,
          profile.measurement_count || 1,
          profile.average_latency_ms || profile.latency_ms,
          profile.min_latency_ms || profile.latency_ms,
          profile.max_latency_ms || profile.latency_ms,
          profile.device_id
        );

        return existing.id;
      } else {
        // Insert new
        const stmt = this.db.prepare(`
          INSERT INTO instrument_latency (
            device_id, latency_ms, last_calibrated, measurement_count,
            average_latency_ms, min_latency_ms, max_latency_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        const result = stmt.run(
          profile.device_id,
          profile.latency_ms,
          profile.last_calibrated,
          profile.measurement_count || 1,
          profile.average_latency_ms || profile.latency_ms,
          profile.min_latency_ms || profile.latency_ms,
          profile.max_latency_ms || profile.latency_ms
        );

        return result.lastInsertRowid;
      }
    } catch (error) {
      this.logger.error(`Failed to save latency profile: ${error.message}`);
      throw error;
    }
  }

  getLatencyProfile(deviceId) {
    try {
      const stmt = this.db.prepare('SELECT * FROM instrument_latency WHERE device_id = ?');
      return stmt.get(deviceId);
    } catch (error) {
      this.logger.error(`Failed to get latency profile: ${error.message}`);
      throw error;
    }
  }

  getLatencyProfiles() {
    try {
      const stmt = this.db.prepare('SELECT * FROM instrument_latency ORDER BY device_id');
      return stmt.all();
    } catch (error) {
      this.logger.error(`Failed to get latency profiles: ${error.message}`);
      throw error;
    }
  }

  deleteLatencyProfile(deviceId) {
    try {
      const stmt = this.db.prepare('DELETE FROM instrument_latency WHERE device_id = ?');
      stmt.run(deviceId);
    } catch (error) {
      this.logger.error(`Failed to delete latency profile: ${error.message}`);
      throw error;
    }
  }

  // ==================== PRESETS ====================

  insertPreset(preset) {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO presets (
          name, description, type, data, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        preset.name,
        preset.description || null,
        preset.type || 'routing',
        preset.data,
        new Date().toISOString()
      );

      return result.lastInsertRowid;
    } catch (error) {
      this.logger.error(`Failed to insert preset: ${error.message}`);
      throw error;
    }
  }

  getPreset(presetId) {
    try {
      const stmt = this.db.prepare('SELECT * FROM presets WHERE id = ?');
      return stmt.get(presetId);
    } catch (error) {
      this.logger.error(`Failed to get preset: ${error.message}`);
      throw error;
    }
  }

  getPresets(type = null) {
    try {
      let stmt;
      if (type) {
        stmt = this.db.prepare('SELECT * FROM presets WHERE type = ? ORDER BY name');
        return stmt.all(type);
      } else {
        stmt = this.db.prepare('SELECT * FROM presets ORDER BY name');
        return stmt.all();
      }
    } catch (error) {
      this.logger.error(`Failed to get presets: ${error.message}`);
      throw error;
    }
  }

  updatePreset(presetId, updates) {
    try {
      const fields = [];
      const values = [];

      if (updates.name !== undefined) {
        fields.push('name = ?');
        values.push(updates.name);
      }
      if (updates.description !== undefined) {
        fields.push('description = ?');
        values.push(updates.description);
      }
      if (updates.data !== undefined) {
        fields.push('data = ?');
        values.push(updates.data);
      }

      if (fields.length === 0) {
        return;
      }

      values.push(presetId);

      const stmt = this.db.prepare(`
        UPDATE presets SET ${fields.join(', ')} WHERE id = ?
      `);

      stmt.run(...values);
    } catch (error) {
      this.logger.error(`Failed to update preset: ${error.message}`);
      throw error;
    }
  }

  deletePreset(presetId) {
    try {
      const stmt = this.db.prepare('DELETE FROM presets WHERE id = ?');
      stmt.run(presetId);
    } catch (error) {
      this.logger.error(`Failed to delete preset: ${error.message}`);
      throw error;
    }
  }

  // ==================== INSTRUMENT SETTINGS ====================

  /**
   * Update instrument settings (custom name, sync delay, MAC address)
   * Uses instruments_latency table
   * @param {string} deviceId - Device identifier
   * @param {number} channel - MIDI channel (0-15), allows multiple instruments per device
   * @param {Object} settings - Settings to update
   * @param {number} [settings.sync_delay] - Timing compensation in milliseconds.
   *   Positive = send MIDI events earlier (compensates for slower instruments).
   *   Combined with hardware latency from LatencyCompensator during playback.
   */
  updateInstrumentSettings(deviceId, channel, settings) {
    // Backward compatibility: if channel is an object, it's the old signature (deviceId, settings)
    if (typeof channel === 'object' && channel !== null) {
      settings = channel;
      channel = 0;
    }
    channel = channel || 0;

    try {
      // Check if entry exists for this device + channel
      const existing = this.db.prepare(
        'SELECT id FROM instruments_latency WHERE device_id = ? AND channel = ?'
      ).get(deviceId, channel);

      if (existing) {
        // Update existing entry
        const fields = [];
        const values = [];

        if (settings.custom_name !== undefined) {
          fields.push('custom_name = ?');
          values.push(settings.custom_name);
        }
        if (settings.sync_delay !== undefined) {
          fields.push('sync_delay = ?');
          values.push(settings.sync_delay);
        }
        if (settings.mac_address !== undefined) {
          fields.push('mac_address = ?');
          values.push(settings.mac_address);
        }
        if (settings.usb_serial_number !== undefined) {
          fields.push('usb_serial_number = ?');
          values.push(settings.usb_serial_number);
        }
        if (settings.name !== undefined) {
          fields.push('name = ?');
          values.push(settings.name);
        }
        if (settings.gm_program !== undefined) {
          fields.push('gm_program = ?');
          values.push(settings.gm_program);
        }

        if (fields.length === 0) {
          return existing.id;
        }

        values.push(deviceId, channel);

        const stmt = this.db.prepare(`
          UPDATE instruments_latency SET ${fields.join(', ')} WHERE device_id = ? AND channel = ?
        `);

        stmt.run(...values);
        return existing.id;
      } else {
        // Insert new entry with correct channel
        const stmt = this.db.prepare(`
          INSERT INTO instruments_latency (
            id, device_id, channel, name, custom_name, sync_delay, mac_address, usb_serial_number, gm_program
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const id = `${deviceId}_${channel}`;
        const result = stmt.run(
          id,
          deviceId,
          channel,
          settings.name || 'Unnamed Instrument',
          settings.custom_name || null,
          settings.sync_delay || 0,
          settings.mac_address || null,
          settings.usb_serial_number || null,
          settings.gm_program !== undefined ? settings.gm_program : null
        );

        return id;
      }
    } catch (error) {
      this.logger.error(`Failed to update instrument settings: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get instrument settings for a specific device and channel
   * @param {string} deviceId - Device identifier
   * @param {number} [channel] - MIDI channel (0-15). If omitted, returns first match (backward compat).
   */
  getInstrumentSettings(deviceId, channel) {
    try {
      if (channel !== undefined && channel !== null) {
        const stmt = this.db.prepare('SELECT * FROM instruments_latency WHERE device_id = ? AND channel = ?');
        return stmt.get(deviceId, channel);
      }
      // Backward compatibility: return first match
      const stmt = this.db.prepare('SELECT * FROM instruments_latency WHERE device_id = ?');
      return stmt.get(deviceId);
    } catch (error) {
      this.logger.error(`Failed to get instrument settings: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get all instruments on a device (all channels)
   * @param {string} deviceId - Device identifier
   * @returns {Array} All instruments for this device
   */
  getInstrumentsByDevice(deviceId) {
    try {
      const stmt = this.db.prepare('SELECT * FROM instruments_latency WHERE device_id = ? ORDER BY channel');
      return stmt.all(deviceId);
    } catch (error) {
      this.logger.error(`Failed to get instruments by device: ${error.message}`);
      throw error;
    }
  }

  /**
   * Save SysEx Identity information for an instrument
   * @param {string} deviceId - Device identifier
   * @param {number} channel - MIDI channel (0-15)
   * @param {Object} identity - SysEx identity data
   */
  saveSysExIdentity(deviceId, channel, identity) {
    // Backward compatibility: if channel is an object, it's the old signature (deviceId, identity)
    if (typeof channel === 'object' && channel !== null) {
      identity = channel;
      channel = 0;
    }
    channel = channel || 0;

    try {
      // Check if entry exists for this device + channel
      const existing = this.db.prepare(
        'SELECT id FROM instruments_latency WHERE device_id = ? AND channel = ?'
      ).get(deviceId, channel);

      const now = new Date().toISOString();

      if (existing) {
        // Update existing entry
        const stmt = this.db.prepare(`
          UPDATE instruments_latency
          SET sysex_manufacturer_id = ?,
              sysex_family = ?,
              sysex_model = ?,
              sysex_version = ?,
              sysex_device_id = ?,
              sysex_raw_response = ?,
              sysex_last_request = ?
          WHERE device_id = ? AND channel = ?
        `);

        stmt.run(
          identity.manufacturerId || null,
          identity.deviceFamily || null,
          identity.deviceFamilyMember || null,
          identity.softwareRevision || null,
          identity.deviceId || null,
          identity.rawBytes || null,
          now,
          deviceId,
          channel
        );

        return existing.id;
      } else {
        // Insert new entry with correct channel
        const stmt = this.db.prepare(`
          INSERT INTO instruments_latency (
            id, device_id, channel, name,
            sysex_manufacturer_id, sysex_family, sysex_model,
            sysex_version, sysex_device_id, sysex_raw_response,
            sysex_last_request
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const id = `${deviceId}_${channel}`;
        stmt.run(
          id,
          deviceId,
          channel,
          'Unnamed Instrument',
          identity.manufacturerId || null,
          identity.deviceFamily || null,
          identity.deviceFamilyMember || null,
          identity.softwareRevision || null,
          identity.deviceId || null,
          identity.rawBytes || null,
          now
        );

        return id;
      }
    } catch (error) {
      this.logger.error(`Failed to save SysEx identity: ${error.message}`);
      throw error;
    }
  }

  /**
   * Find instrument by MAC address
   */
  findInstrumentByMac(macAddress) {
    try {
      const stmt = this.db.prepare('SELECT * FROM instruments_latency WHERE mac_address = ?');
      return stmt.get(macAddress);
    } catch (error) {
      this.logger.error(`Failed to find instrument by MAC: ${error.message}`);
      throw error;
    }
  }

  /**
   * Find instrument by USB serial number
   */
  findInstrumentByUsbSerial(usbSerialNumber) {
    try {
      const stmt = this.db.prepare('SELECT * FROM instruments_latency WHERE usb_serial_number = ?');
      return stmt.get(usbSerialNumber);
    } catch (error) {
      this.logger.error(`Failed to find instrument by USB serial: ${error.message}`);
      throw error;
    }
  }

  // ==================== INSTRUMENT CAPABILITIES ====================

  /**
   * Update instrument capabilities (note range, supported CCs, selected notes)
   * @param {string} deviceId - Device identifier
   * @param {number} channel - MIDI channel (0-15), allows multiple instruments per device
   * @param {Object} capabilities - Capability settings
   * @param {number|null} capabilities.note_range_min - Minimum playable note (0-127)
   * @param {number|null} capabilities.note_range_max - Maximum playable note (0-127)
   * @param {number[]|null} capabilities.supported_ccs - Array of supported CC numbers
   * @param {string} capabilities.note_selection_mode - 'range' or 'discrete'
   * @param {number[]|null} capabilities.selected_notes - Array of individual notes (for discrete mode)
   * @param {string} capabilities.capabilities_source - Source: 'manual', 'sysex', 'auto'
   */
  updateInstrumentCapabilities(deviceId, channel, capabilities) {
    // Backward compatibility: if channel is an object, it's the old signature (deviceId, capabilities)
    if (typeof channel === 'object' && channel !== null) {
      capabilities = channel;
      channel = 0;
    }
    channel = channel || 0;

    try {
      // Check if entry exists for this device + channel
      const existing = this.db.prepare(
        'SELECT id FROM instruments_latency WHERE device_id = ? AND channel = ?'
      ).get(deviceId, channel);

      const now = new Date().toISOString();

      // Validate note range
      if (capabilities.note_range_min !== undefined && capabilities.note_range_min !== null) {
        if (capabilities.note_range_min < 0 || capabilities.note_range_min > 127) {
          throw new Error('note_range_min must be between 0 and 127');
        }
      }
      if (capabilities.note_range_max !== undefined && capabilities.note_range_max !== null) {
        if (capabilities.note_range_max < 0 || capabilities.note_range_max > 127) {
          throw new Error('note_range_max must be between 0 and 127');
        }
      }

      // Validate cross-field: min <= max
      const effectiveMin = capabilities.note_range_min !== undefined ? capabilities.note_range_min : null;
      const effectiveMax = capabilities.note_range_max !== undefined ? capabilities.note_range_max : null;
      if (effectiveMin !== null && effectiveMin !== undefined &&
          effectiveMax !== null && effectiveMax !== undefined &&
          effectiveMin > effectiveMax) {
        throw new Error(`note_range_min (${effectiveMin}) must be <= note_range_max (${effectiveMax})`);
      }

      // Validate polyphony
      if (capabilities.polyphony !== undefined && capabilities.polyphony !== null) {
        const poly = parseInt(capabilities.polyphony);
        if (isNaN(poly) || poly < 1) {
          throw new Error('polyphony must be a positive number (minimum 1)');
        }
      }

      // Convert supported_ccs array to JSON string
      let supportedCcsJson = null;
      if (capabilities.supported_ccs !== undefined && capabilities.supported_ccs !== null) {
        if (Array.isArray(capabilities.supported_ccs)) {
          // Validate each CC is in range 0-127
          for (const cc of capabilities.supported_ccs) {
            if (cc < 0 || cc > 127) {
              throw new Error('CC values must be between 0 and 127');
            }
          }
          supportedCcsJson = JSON.stringify(capabilities.supported_ccs);
        } else if (typeof capabilities.supported_ccs === 'string') {
          supportedCcsJson = capabilities.supported_ccs;
        }
      }

      // Convert selected_notes array to JSON string
      let selectedNotesJson = null;
      if (capabilities.selected_notes !== undefined && capabilities.selected_notes !== null) {
        if (Array.isArray(capabilities.selected_notes)) {
          // Validate each note is in range 0-127
          for (const note of capabilities.selected_notes) {
            if (note < 0 || note > 127) {
              throw new Error('Note values must be between 0 and 127');
            }
          }
          // Sort and deduplicate
          const uniqueNotes = [...new Set(capabilities.selected_notes)].sort((a, b) => a - b);
          selectedNotesJson = JSON.stringify(uniqueNotes);
        } else if (typeof capabilities.selected_notes === 'string') {
          selectedNotesJson = capabilities.selected_notes;
        }
      }

      if (existing) {
        // Update existing entry
        const fields = [];
        const values = [];

        if (capabilities.note_range_min !== undefined) {
          fields.push('note_range_min = ?');
          values.push(capabilities.note_range_min);
        }
        if (capabilities.note_range_max !== undefined) {
          fields.push('note_range_max = ?');
          values.push(capabilities.note_range_max);
        }
        if (capabilities.supported_ccs !== undefined) {
          fields.push('supported_ccs = ?');
          values.push(supportedCcsJson);
        }
        if (capabilities.note_selection_mode !== undefined) {
          fields.push('note_selection_mode = ?');
          values.push(capabilities.note_selection_mode);
        }
        if (capabilities.selected_notes !== undefined) {
          fields.push('selected_notes = ?');
          values.push(selectedNotesJson);
        }
        if (capabilities.polyphony !== undefined) {
          fields.push('polyphony = ?');
          values.push(capabilities.polyphony !== null ? parseInt(capabilities.polyphony) : null);
        }
        if (capabilities.capabilities_source !== undefined) {
          fields.push('capabilities_source = ?');
          values.push(capabilities.capabilities_source);
        }

        // Always update timestamp
        fields.push('capabilities_updated_at = ?');
        values.push(now);

        if (fields.length === 0) {
          return existing.id;
        }

        values.push(deviceId, channel);

        const stmt = this.db.prepare(`
          UPDATE instruments_latency SET ${fields.join(', ')} WHERE device_id = ? AND channel = ?
        `);

        stmt.run(...values);
        return existing.id;
      } else {
        // Insert new entry with correct channel
        const stmt = this.db.prepare(`
          INSERT INTO instruments_latency (
            id, device_id, channel, name,
            note_range_min, note_range_max, supported_ccs,
            note_selection_mode, selected_notes, polyphony,
            capabilities_source, capabilities_updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const id = `${deviceId}_${channel}`;
        stmt.run(
          id,
          deviceId,
          channel,
          'Unnamed Instrument',
          capabilities.note_range_min !== undefined && capabilities.note_range_min !== null ? capabilities.note_range_min : null,
          capabilities.note_range_max !== undefined && capabilities.note_range_max !== null ? capabilities.note_range_max : null,
          supportedCcsJson,
          capabilities.note_selection_mode || 'range',
          selectedNotesJson,
          capabilities.polyphony !== undefined && capabilities.polyphony !== null ? parseInt(capabilities.polyphony) : 16,
          capabilities.capabilities_source || 'manual',
          now
        );

        return id;
      }
    } catch (error) {
      this.logger.error(`Failed to update instrument capabilities: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get instrument capabilities
   * @param {string} deviceId - Device identifier
   * @param {number} [channel] - MIDI channel (0-15). If omitted, returns first match (backward compat).
   * @returns {Object|null} Capabilities object with parsed arrays
   */
  getInstrumentCapabilities(deviceId, channel) {
    try {
      let result;
      if (channel !== undefined && channel !== null) {
        const stmt = this.db.prepare(`
          SELECT
            note_range_min, note_range_max, supported_ccs,
            note_selection_mode, selected_notes, polyphony,
            capabilities_source, capabilities_updated_at
          FROM instruments_latency
          WHERE device_id = ? AND channel = ?
        `);
        result = stmt.get(deviceId, channel);
      } else {
        const stmt = this.db.prepare(`
          SELECT
            note_range_min, note_range_max, supported_ccs,
            note_selection_mode, selected_notes, polyphony,
            capabilities_source, capabilities_updated_at
          FROM instruments_latency
          WHERE device_id = ?
        `);
        result = stmt.get(deviceId);
      }

      if (!result) {
        return null;
      }

      // Parse supported_ccs JSON string to array
      let supportedCcs = null;
      if (result.supported_ccs) {
        try {
          supportedCcs = JSON.parse(result.supported_ccs);
        } catch (e) {
          this.logger.warn(`Failed to parse supported_ccs for ${deviceId}: ${e.message}`);
        }
      }

      // Parse selected_notes JSON string to array
      let selectedNotes = null;
      if (result.selected_notes) {
        try {
          selectedNotes = JSON.parse(result.selected_notes);
        } catch (e) {
          this.logger.warn(`Failed to parse selected_notes for ${deviceId}: ${e.message}`);
        }
      }

      return {
        note_range_min: result.note_range_min,
        note_range_max: result.note_range_max,
        supported_ccs: supportedCcs,
        note_selection_mode: result.note_selection_mode || 'range',
        selected_notes: selectedNotes,
        polyphony: result.polyphony || null,
        capabilities_source: result.capabilities_source,
        capabilities_updated_at: result.capabilities_updated_at
      };
    } catch (error) {
      this.logger.error(`Failed to get instrument capabilities: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get all instruments with their capabilities
   * @returns {Array} List of instruments with capabilities
   */
  getAllInstrumentCapabilities() {
    try {
      const stmt = this.db.prepare(`
        SELECT
          id, device_id, channel, name, custom_name,
          gm_program,
          note_range_min, note_range_max, supported_ccs,
          note_selection_mode, selected_notes, polyphony,
          capabilities_source, capabilities_updated_at
        FROM instruments_latency
        ORDER BY device_id
      `);
      const results = stmt.all();

      // Parse JSON arrays for each result
      return results.map(result => {
        let supportedCcs = null;
        if (result.supported_ccs) {
          try {
            supportedCcs = JSON.parse(result.supported_ccs);
          } catch (e) {
            this.logger.warn(`Failed to parse supported_ccs for ${result.device_id}`);
          }
        }

        let selectedNotes = null;
        if (result.selected_notes) {
          try {
            selectedNotes = JSON.parse(result.selected_notes);
          } catch (e) {
            this.logger.warn(`Failed to parse selected_notes for ${result.device_id}`);
          }
        }

        return {
          ...result,
          supported_ccs: supportedCcs,
          note_selection_mode: result.note_selection_mode || 'range',
          selected_notes: selectedNotes
        };
      });
    } catch (error) {
      this.logger.error(`Failed to get all instrument capabilities: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get lightweight list of registered instrument IDs (for UI dropdowns)
   * @returns {Array} List of instruments with basic identification data
   */
  getRegisteredInstrumentIds() {
    try {
      const stmt = this.db.prepare(`
        SELECT id, device_id, channel, name, custom_name, gm_program
        FROM instruments_latency
        ORDER BY name, custom_name
      `);
      return stmt.all();
    } catch (error) {
      this.logger.error(`Failed to get registered instrument IDs: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get all instruments with full capabilities for auto-assignment
   * @returns {Array} List of instruments with complete data
   */
  getInstrumentsWithCapabilities() {
    try {
      const stmt = this.db.prepare(`
        SELECT
          id, device_id, channel, name, custom_name,
          gm_program, sync_delay, polyphony,
          note_range_min, note_range_max,
          note_selection_mode, selected_notes, supported_ccs,
          capabilities_source, capabilities_updated_at,
          mac_address, usb_serial_number,
          sysex_manufacturer_id, sysex_family, sysex_model, sysex_version
        FROM instruments_latency
        ORDER BY name, custom_name
      `);
      const results = stmt.all();

      // Parse JSON fields and return
      return results.map(result => {
        let supportedCcs = null;
        if (result.supported_ccs) {
          try {
            supportedCcs = JSON.parse(result.supported_ccs);
          } catch (e) {
            this.logger.warn(`Failed to parse supported_ccs for ${result.device_id}`);
          }
        }

        let selectedNotes = null;
        if (result.selected_notes) {
          try {
            selectedNotes = JSON.parse(result.selected_notes);
          } catch (e) {
            this.logger.warn(`Failed to parse selected_notes for ${result.device_id}`);
          }
        }

        return {
          id: result.id,
          device_id: result.device_id,
          channel: result.channel,
          name: result.name,
          custom_name: result.custom_name,
          gm_program: result.gm_program,
          polyphony: result.polyphony || 16,
          sync_delay: result.sync_delay || 0,
          note_range_min: result.note_range_min,
          note_range_max: result.note_range_max,
          note_selection_mode: result.note_selection_mode || 'range',
          selected_notes: result.selected_notes, // Keep as JSON string for matcher
          supported_ccs: result.supported_ccs,   // Keep as JSON string for matcher
          capabilities_source: result.capabilities_source,
          capabilities_updated_at: result.capabilities_updated_at,
          // Additional fields for reference
          mac_address: result.mac_address,
          usb_serial_number: result.usb_serial_number,
          sysex_manufacturer_id: result.sysex_manufacturer_id,
          sysex_family: result.sysex_family,
          sysex_model: result.sysex_model,
          sysex_version: result.sysex_version
        };
      });
    } catch (error) {
      this.logger.error(`Failed to get instruments with capabilities: ${error.message}`);
      throw error;
    }
  }
  // ==========================================================================
  // Routing persistence methods
  // ==========================================================================

  /**
   * Insert or update a channel routing for a MIDI file
   * @param {Object} routing - { midi_file_id, channel, device_id, instrument_name, compatibility_score, transposition_applied, auto_assigned, assignment_reason, note_remapping, enabled }
   * @returns {number} routing id
   */
  insertRouting(routing) {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO midi_instrument_routings
          (midi_file_id, track_id, channel, device_id, instrument_name,
           compatibility_score, transposition_applied, auto_assigned,
           assignment_reason, note_remapping, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(midi_file_id, channel) WHERE channel IS NOT NULL
        DO UPDATE SET
          track_id = excluded.track_id,
          device_id = excluded.device_id,
          instrument_name = excluded.instrument_name,
          compatibility_score = excluded.compatibility_score,
          transposition_applied = excluded.transposition_applied,
          auto_assigned = excluded.auto_assigned,
          assignment_reason = excluded.assignment_reason,
          note_remapping = excluded.note_remapping,
          enabled = excluded.enabled,
          created_at = excluded.created_at
      `);

      const result = stmt.run(
        routing.midi_file_id,
        routing.target_channel !== undefined ? routing.target_channel : routing.channel, // Store instrument's target channel
        routing.channel,
        routing.device_id,
        routing.instrument_name,
        routing.compatibility_score || null,
        routing.transposition_applied || 0,
        routing.auto_assigned ? 1 : 0,
        routing.assignment_reason || null,
        routing.note_remapping || null,
        routing.enabled !== false ? 1 : 0,
        routing.created_at || Date.now()
      );

      return result.lastInsertRowid;
    } catch (error) {
      this.logger.error(`Failed to insert routing: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get all routings for a MIDI file
   * @param {number} fileId
   * @param {boolean} [includeDisabled=false] - If true, return disabled routings too
   * @returns {Array<Object>}
   * @throws {Error} If database query fails
   */
  getRoutingsByFile(fileId, includeDisabled = false) {
    const enabledFilter = includeDisabled ? '' : 'AND enabled = 1';
    const rows = this.db.prepare(`
      SELECT * FROM midi_instrument_routings
      WHERE midi_file_id = ? ${enabledFilter}
      ORDER BY channel ASC
    `).all(fileId);

    return rows.map(row => ({
      ...row,
      target_channel: row.track_id !== undefined ? row.track_id : row.channel, // Expose instrument's target channel
      note_remapping: row.note_remapping ? JSON.parse(row.note_remapping) : null,
      auto_assigned: !!row.auto_assigned,
      enabled: !!row.enabled
    }));
  }

  /**
   * Delete all routings for a MIDI file
   * @param {number} fileId
   */
  deleteRoutingsByFile(fileId) {
    try {
      this.db.prepare('DELETE FROM midi_instrument_routings WHERE midi_file_id = ?').run(fileId);
    } catch (error) {
      this.logger.error(`Failed to delete routings for file ${fileId}: ${error.message}`);
    }
  }
}

export default InstrumentDatabase;