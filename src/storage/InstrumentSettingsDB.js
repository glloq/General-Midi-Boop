class InstrumentSettingsDB {
  constructor(db, logger) {
    this.db = db;
    this.logger = logger;
  }

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
      const normalizedTarget = InstrumentSettingsDB.normalizeDeviceName(deviceId);
      if (!normalizedTarget || normalizedTarget === 'virtual') return null;

      // Get all non-virtual entries
      const entries = this.db.prepare(
        "SELECT * FROM instruments_latency WHERE device_id NOT LIKE 'virtual_%' ORDER BY capabilities_updated_at DESC"
      ).all();

      for (const entry of entries) {
        const normalizedEntry = InstrumentSettingsDB.normalizeDeviceName(entry.device_id);
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
}

export default InstrumentSettingsDB;
