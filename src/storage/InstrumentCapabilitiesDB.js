/**
 * InstrumentCapabilitiesDB - Manages instrument capabilities data
 * Extracted from InstrumentDatabase.js
 */
import { buildDynamicUpdate } from './dbHelpers.js';

class InstrumentCapabilitiesDB {
  constructor(db, logger) {
    this.db = db;
    this.logger = logger;
  }

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
        // Build update with timestamp always included
        const capWithTimestamp = { ...capabilities, capabilities_updated_at: now };
        const result = buildDynamicUpdate('instruments_latency', capWithTimestamp, [
          'note_range_min', 'note_range_max', 'supported_ccs',
          'note_selection_mode', 'selected_notes', 'polyphony',
          'capabilities_source', 'capabilities_updated_at'
        ], {
          whereClause: 'device_id = ? AND channel = ?',
          transforms: {
            supported_ccs: () => supportedCcsJson,
            selected_notes: () => selectedNotesJson,
            polyphony: v => v !== null ? parseInt(v) : null
          }
        });

        if (!result) return existing.id;
        this.db.prepare(result.sql).run(...result.values, deviceId, channel);
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
          capabilities_source, capabilities_updated_at,
          usb_serial_number, mac_address
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
          sysex_manufacturer_id, sysex_family, sysex_model, sysex_version,
          instrument_type, instrument_subtype,
          min_note_interval, min_note_duration
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
          selected_notes: selectedNotes,
          supported_ccs: supportedCcs,
          capabilities_source: result.capabilities_source,
          capabilities_updated_at: result.capabilities_updated_at,
          // Type hierarchy
          instrument_type: result.instrument_type || 'unknown',
          instrument_subtype: result.instrument_subtype || null,
          // Timing constraints
          min_note_interval: result.min_note_interval || null,
          min_note_duration: result.min_note_duration || null,
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
}

export default InstrumentCapabilitiesDB;
