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
        if (settings.octave_mode !== undefined) {
          fields.push('octave_mode = ?');
          values.push(settings.octave_mode);
        }
        if (settings.comm_timeout !== undefined) {
          fields.push('comm_timeout = ?');
          values.push(settings.comm_timeout);
        }
        if (settings.instrument_type !== undefined) {
          fields.push('instrument_type = ?');
          values.push(settings.instrument_type);
        }
        if (settings.instrument_subtype !== undefined) {
          fields.push('instrument_subtype = ?');
          values.push(settings.instrument_subtype);
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
            id, device_id, channel, name, custom_name, sync_delay, mac_address, usb_serial_number, gm_program, octave_mode, comm_timeout, instrument_type, instrument_subtype
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          settings.gm_program !== undefined ? settings.gm_program : null,
          settings.octave_mode || 'chromatic',
          settings.comm_timeout !== undefined ? settings.comm_timeout : 5000,
          settings.instrument_type || 'unknown',
          settings.instrument_subtype || null
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

  /**
   * Normalize an ALSA MIDI device name by removing port numbers.
   * e.g., "Arduino MIDI:Arduino MIDI MIDI 1 20:0" -> "arduino midi"
   * This allows matching across reboots when ALSA reassigns port numbers.
   * @param {string} deviceId - ALSA device name or device_id
   * @returns {string} Normalized lowercase name
   */
  static normalizeDeviceName(deviceId) {
    if (!deviceId) return '';
    // Take part before first colon (removes ALSA port info)
    let normalized = deviceId.split(':')[0].trim().toLowerCase();
    // Remove trailing numbers that might be card numbers (e.g., "Arduino MIDI 1" -> "Arduino MIDI")
    normalized = normalized.replace(/\s+\d+$/, '').trim();
    return normalized;
  }

  /**
   * Find instrument by normalized device name.
   * Matches even when ALSA port numbers change between reboots.
   * @param {string} deviceId - Current device name to match
   * @returns {Object|null} First matching instrument entry
   */
  findInstrumentByNormalizedName(deviceId) {
    try {
      const normalizedTarget = InstrumentDatabase.normalizeDeviceName(deviceId);
      if (!normalizedTarget || normalizedTarget === 'virtual') return null;

      // Get all non-virtual entries
      const entries = this.db.prepare(
        "SELECT * FROM instruments_latency WHERE device_id NOT LIKE 'virtual_%' ORDER BY capabilities_updated_at DESC"
      ).all();

      for (const entry of entries) {
        const normalizedEntry = InstrumentDatabase.normalizeDeviceName(entry.device_id);
        if (normalizedEntry === normalizedTarget) {
          return entry;
        }
      }
      return null;
    } catch (error) {
      this.logger.error(`Failed to find instrument by normalized name: ${error.message}`);
      throw error;
    }
  }

  /**
   * Reconcile device_id: update all DB entries for an old device_id to a new one.
   * Used when ALSA renames a USB device (e.g., port number changes between reboots).
   * Also merges duplicate entries if the new device_id already exists.
   * @param {string} oldDeviceId - Previous device identifier
   * @param {string} newDeviceId - Current device identifier
   */
  reconcileDeviceId(oldDeviceId, newDeviceId) {
    // Wrap all updates in a transaction to prevent partial state on failure
    const runReconciliation = this.db.transaction(() => {
      // Get all entries for old device_id
      const oldEntries = this.db.prepare(
        'SELECT * FROM instruments_latency WHERE device_id = ?'
      ).all(oldDeviceId);

      if (oldEntries.length === 0) {
        return; // Nothing to reconcile
      }

      for (const oldEntry of oldEntries) {
        // Check if new device_id + channel already exists
        const existingNew = this.db.prepare(
          'SELECT id FROM instruments_latency WHERE device_id = ? AND channel = ?'
        ).get(newDeviceId, oldEntry.channel);

        if (existingNew) {
          // New entry already exists - delete the old duplicate
          this.db.prepare('DELETE FROM instruments_latency WHERE id = ?').run(oldEntry.id);
          this.logger.info(`[reconcileDeviceId] Removed duplicate entry "${oldEntry.id}" (kept "${existingNew.id}")`);
        } else {
          // Update old entry to use new device_id
          const newId = `${newDeviceId}_${oldEntry.channel}`;
          this.db.prepare(
            'UPDATE instruments_latency SET id = ?, device_id = ? WHERE id = ?'
          ).run(newId, newDeviceId, oldEntry.id);
          this.logger.info(`[reconcileDeviceId] Updated "${oldEntry.id}" -> "${newId}"`);
        }
      }

      // Also update instrument_latency table if it exists
      try {
        this.db.prepare(
          'UPDATE instrument_latency SET device_id = ? WHERE device_id = ?'
        ).run(newDeviceId, oldDeviceId);
      } catch (e) {
        // Table may not exist
      }

      // Also update routing table if it exists
      try {
        this.db.prepare(
          'UPDATE midi_instrument_routings SET device_id = ? WHERE device_id = ?'
        ).run(newDeviceId, oldDeviceId);
      } catch (e) {
        // Table may not exist
      }

      // Also update string_instruments table if it exists
      try {
        this.db.prepare(
          'UPDATE string_instruments SET device_id = ? WHERE device_id = ?'
        ).run(newDeviceId, oldDeviceId);
      } catch (e) {
        // Table may not exist
      }
    });

    try {
      runReconciliation();
    } catch (error) {
      this.logger.error(`Failed to reconcile device_id "${oldDeviceId}" -> "${newDeviceId}": ${error.message}`);
      throw error;
    }
  }

  /**
   * Deduplicate instrument entries by USB serial number.
   * Keeps the entry with the most complete data.
   * @returns {number} Number of duplicates removed
   */
  deduplicateByUsbSerial() {
    try {
      // Find all entries with USB serial numbers
      const entries = this.db.prepare(`
        SELECT * FROM instruments_latency
        WHERE usb_serial_number IS NOT NULL AND usb_serial_number != ''
        ORDER BY usb_serial_number, capabilities_updated_at DESC
      `).all();

      const bySerial = new Map();
      for (const entry of entries) {
        if (!bySerial.has(entry.usb_serial_number)) {
          bySerial.set(entry.usb_serial_number, []);
        }
        bySerial.get(entry.usb_serial_number).push(entry);
      }

      let removedCount = 0;
      for (const [serial, group] of bySerial) {
        if (group.length <= 1) continue;

        // Group by channel
        const byChannel = new Map();
        for (const entry of group) {
          const ch = entry.channel || 0;
          if (!byChannel.has(ch)) {
            byChannel.set(ch, []);
          }
          byChannel.get(ch).push(entry);
        }

        for (const [channel, channelGroup] of byChannel) {
          if (channelGroup.length <= 1) continue;

          // Keep the one with the most complete data (most non-null fields)
          channelGroup.sort((a, b) => {
            const scoreA = (a.gm_program != null ? 1 : 0) + (a.note_range_min != null ? 1 : 0) +
                          (a.polyphony != null ? 1 : 0) + (a.custom_name ? 1 : 0);
            const scoreB = (b.gm_program != null ? 1 : 0) + (b.note_range_min != null ? 1 : 0) +
                          (b.polyphony != null ? 1 : 0) + (b.custom_name ? 1 : 0);
            return scoreB - scoreA; // Higher score first
          });

          // Remove all but the first (most complete)
          for (let i = 1; i < channelGroup.length; i++) {
            this.db.prepare('DELETE FROM instruments_latency WHERE id = ?').run(channelGroup[i].id);
            this.logger.info(`[deduplicateByUsbSerial] Removed duplicate "${channelGroup[i].id}" for serial "${serial}" ch${channel}`);
            removedCount++;
          }
        }
      }

      return removedCount;
    } catch (error) {
      this.logger.error(`Failed to deduplicate by USB serial: ${error.message}`);
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
          instrument_type, instrument_subtype
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
   * @param {Object} routing - { midi_file_id, channel, device_id, instrument_name, compatibility_score, transposition_applied, auto_assigned, assignment_reason, note_remapping, enabled, split_mode, split_note_min, split_note_max, split_polyphony_share }
   * @returns {number} routing id
   */
  insertRouting(routing) {
    try {
      // For split routings, use a different INSERT (no ON CONFLICT since multiple rows per channel)
      if (routing.split_mode) {
        const stmt = this.db.prepare(`
          INSERT INTO midi_instrument_routings
            (midi_file_id, track_id, channel, device_id, instrument_name,
             compatibility_score, transposition_applied, auto_assigned,
             assignment_reason, note_remapping, enabled, created_at,
             split_mode, split_note_min, split_note_max, split_polyphony_share)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          routing.created_at || Date.now(),
          routing.split_mode,
          routing.split_note_min ?? null,
          routing.split_note_max ?? null,
          routing.split_polyphony_share ?? null
        );

        return result.lastInsertRowid;
      }

      // Standard routing (no split) — upsert with unique constraint
      const stmt = this.db.prepare(`
        INSERT INTO midi_instrument_routings
          (midi_file_id, track_id, channel, device_id, instrument_name,
           compatibility_score, transposition_applied, auto_assigned,
           assignment_reason, note_remapping, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(midi_file_id, channel) WHERE split_mode IS NULL
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
   * Delete all split routings for a channel, then insert new segments
   * @param {number} fileId
   * @param {number} channel
   * @param {Array<Object>} segments - Array of routing objects with split fields
   */
  insertSplitRoutings(fileId, channel, segments) {
    try {
      // Remove all existing routings for this channel (both split and non-split)
      this.db.prepare(
        'DELETE FROM midi_instrument_routings WHERE midi_file_id = ? AND channel = ?'
      ).run(fileId, channel);

      // Insert each segment
      for (const segment of segments) {
        this.insertRouting({
          ...segment,
          midi_file_id: fileId,
          channel: channel
        });
      }
    } catch (error) {
      this.logger.error(`Failed to insert split routings: ${error.message}`);
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
      target_channel: row.track_id !== undefined ? row.track_id : row.channel,
      note_remapping: row.note_remapping ? JSON.parse(row.note_remapping) : null,
      auto_assigned: !!row.auto_assigned,
      enabled: !!row.enabled,
      split_mode: row.split_mode || null,
      split_note_min: row.split_note_min ?? null,
      split_note_max: row.split_note_max ?? null,
      split_polyphony_share: row.split_polyphony_share ?? null
    }));
  }

  /**
   * Get routing counts and min compatibility score for multiple files in one query.
   * @param {number[]} fileIds
   * @returns {Array<{midi_file_id: number, count: number, min_score: number}>}
   */
  /**
   * @param {number[]} fileIds
   * @param {Set<string>} [connectedDeviceIds] - If provided, only count routings to these devices
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
   * Disable all routings that point to virtual instruments (device_id LIKE 'virtual_%')
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

export default InstrumentDatabase;