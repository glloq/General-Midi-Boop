// src/storage/InstrumentQueries.js
// Extracted from InstrumentDatabase.js - handles instrument capabilities CRUD,
// routing persistence, and specialized query methods.

class InstrumentQueries {
  /**
   * @param {Object} db - better-sqlite3 database instance
   * @param {Object} logger - Logger instance
   */
  constructor(db, logger) {
    this.db = db;
    this.logger = logger;
  }

  // ==================== INSTRUMENT CAPABILITIES ====================

  /**
   * Update instrument capabilities (note range, supported CCs, selected notes)
   * @param {string} deviceId - Device identifier
   * @param {number} channel - MIDI channel (0-15)
   * @param {Object} capabilities - Capability settings
   */
  updateInstrumentCapabilities(deviceId, channel, capabilities) {
    if (typeof channel === 'object' && channel !== null) {
      capabilities = channel;
      channel = 0;
    }
    channel = channel || 0;

    try {
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
          for (const note of capabilities.selected_notes) {
            if (note < 0 || note > 127) {
              throw new Error('Note values must be between 0 and 127');
            }
          }
          const uniqueNotes = [...new Set(capabilities.selected_notes)].sort((a, b) => a - b);
          selectedNotesJson = JSON.stringify(uniqueNotes);
        } else if (typeof capabilities.selected_notes === 'string') {
          selectedNotesJson = capabilities.selected_notes;
        }
      }

      if (existing) {
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
   * @param {number} [channel] - MIDI channel (0-15)
   * @returns {Object|null} Capabilities object with parsed arrays
   */
  getInstrumentCapabilities(deviceId, channel) {
    try {
      let result;
      if (channel !== undefined && channel !== null) {
        const stmt = this.db.prepare(`
          SELECT
            channel, gm_program,
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
            channel, gm_program,
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

      let supportedCcs = null;
      if (result.supported_ccs) {
        try {
          supportedCcs = JSON.parse(result.supported_ccs);
        } catch (e) {
          this.logger.warn(`Failed to parse supported_ccs for ${deviceId}: ${e.message}`);
        }
      }

      let selectedNotes = null;
      if (result.selected_notes) {
        try {
          selectedNotes = JSON.parse(result.selected_notes);
        } catch (e) {
          this.logger.warn(`Failed to parse selected_notes for ${deviceId}: ${e.message}`);
        }
      }

      return {
        channel: result.channel !== undefined && result.channel !== null ? result.channel : 0,
        gm_program: result.gm_program !== undefined ? result.gm_program : null,
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
   * @returns {Array}
   */
  getAllInstrumentCapabilities() {
    try {
      const stmt = this.db.prepare(`
        SELECT
          id, device_id, channel, name, custom_name,
          gm_program,
          note_range_min, note_range_max, supported_ccs,
          note_selection_mode, selected_notes, polyphony,
          capabilities_source, capabilities_updated_at,
          usb_serial_number, mac_address
        FROM instruments_latency
        ORDER BY device_id
      `);
      const results = stmt.all();

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
   * @returns {Array}
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
   * @returns {Array}
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
          selected_notes: selectedNotes,
          supported_ccs: supportedCcs,
          capabilities_source: result.capabilities_source,
          capabilities_updated_at: result.capabilities_updated_at,
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

  // ==================== ROUTING PERSISTENCE ====================

  /**
   * Insert or update a channel routing for a MIDI file
   * @param {Object} routing - Routing configuration
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
        routing.target_channel !== undefined ? routing.target_channel : routing.channel,
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
   * @param {boolean} [includeDisabled=false]
   * @returns {Array<Object>}
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
      target_channel: row.track_id !== undefined ? row.track_id : row.channel,
      note_remapping: row.note_remapping ? JSON.parse(row.note_remapping) : null,
      auto_assigned: !!row.auto_assigned,
      enabled: !!row.enabled
    }));
  }

  /**
   * Get routing counts and min compatibility score for multiple files in one query.
   * @param {number[]} fileIds
   * @param {Set<string>} [connectedDeviceIds]
   * @returns {Array}
   */
  getRoutingCountsByFiles(fileIds, connectedDeviceIds) {
    if (fileIds.length === 0) return [];
    try {
      const filePlaceholders = fileIds.map(() => '?').join(',');
      const params = [...fileIds];

      let deviceFilter = '';
      if (connectedDeviceIds && connectedDeviceIds.size > 0) {
        const devicePlaceholders = [...connectedDeviceIds].map(() => '?').join(',');
        deviceFilter = ` AND device_id IN (${devicePlaceholders})`;
        params.push(...connectedDeviceIds);
      }

      const stmt = this.db.prepare(`
        SELECT midi_file_id, COUNT(*) as count, MIN(compatibility_score) as min_score
        FROM midi_instrument_routings
        WHERE midi_file_id IN (${filePlaceholders}) AND enabled = 1${deviceFilter}
        GROUP BY midi_file_id
      `);
      return stmt.all(...params);
    } catch (error) {
      this.logger.error(`Failed to get routing counts by files: ${error.message}`);
      return [];
    }
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

  /**
   * Disable all routings that point to virtual instruments
   * @returns {{ disabledCount: number, affectedFileIds: number[] }}
   */
  disableVirtualRoutings() {
    try {
      const affectedRows = this.db.prepare(`
        SELECT DISTINCT midi_file_id FROM midi_instrument_routings
        WHERE device_id LIKE 'virtual_%' AND enabled = 1
      `).all();

      const result = this.db.prepare(`
        UPDATE midi_instrument_routings SET enabled = 0
        WHERE device_id LIKE 'virtual_%' AND enabled = 1
      `).run();

      const affectedFileIds = affectedRows.map(r => r.midi_file_id);
      this.logger.info(`Disabled ${result.changes} virtual instrument routings across ${affectedFileIds.length} files`);
      return { disabledCount: result.changes, affectedFileIds };
    } catch (error) {
      this.logger.error(`Failed to disable virtual routings: ${error.message}`);
      throw error;
    }
  }

  /**
   * Re-enable all routings that point to virtual instruments
   * @returns {{ enabledCount: number, affectedFileIds: number[] }}
   */
  enableVirtualRoutings() {
    try {
      const affectedRows = this.db.prepare(`
        SELECT DISTINCT midi_file_id FROM midi_instrument_routings
        WHERE device_id LIKE 'virtual_%' AND enabled = 0
      `).all();

      const result = this.db.prepare(`
        UPDATE midi_instrument_routings SET enabled = 1
        WHERE device_id LIKE 'virtual_%' AND enabled = 0
      `).run();

      const affectedFileIds = affectedRows.map(r => r.midi_file_id);
      this.logger.info(`Re-enabled ${result.changes} virtual instrument routings across ${affectedFileIds.length} files`);
      return { enabledCount: result.changes, affectedFileIds };
    } catch (error) {
      this.logger.error(`Failed to enable virtual routings: ${error.message}`);
      throw error;
    }
  }
}

export default InstrumentQueries;
