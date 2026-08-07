/**
 * @file src/persistence/tables/InstrumentCapabilitiesDB.js
 * @description SQLite access layer for the per-channel capabilities
 * matrix (polyphony, note range, supported CCs, instrument type).
 * Sub-module of {@link InstrumentDatabase}; consumed via the
 * `InstrumentRepository` and the {@link InstrumentMatcher} scoring
 * code path.
 *
 * **Naming convention for the supported-CC list** — this property
 * crosses the SQLite ↔ API ↔ frontend boundary, so the spelling must
 * stay stable everywhere:
 *   - SQL column / JSON-payload field : `supported_ccs` (snake_case)
 *   - Backend JS local variables       : `supportedCcs` / `supportedCcsJson`
 *   - Frontend hidden input id         : `#supportedCCs` (legacy double-cap)
 *   - Frontend JS local variables      : `supportedCcs`
 * The double-cap `CCs` is reserved for the DOM id (which must match
 * the existing HTML) and the matcher's `_parseSupportedCCs` method
 * name. Everywhere else, prefer `Ccs`/`supportedCcs`.
 */
import { buildDynamicUpdate } from '../dbHelpers.js';
import { parseValidMidiList, serializeValidMidiList } from '../../utils/MidiListParser.js';

/** Parse an optional JSON column → object, or null on absence/parse error. */
function parseJsonCol(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

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
      const existing = this.db
        .prepare('SELECT id FROM instruments_latency WHERE device_id = ? AND channel = ?')
        .get(deviceId, channel);

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
      const effectiveMin =
        capabilities.note_range_min !== undefined ? capabilities.note_range_min : null;
      const effectiveMax =
        capabilities.note_range_max !== undefined ? capabilities.note_range_max : null;
      if (
        effectiveMin !== null &&
        effectiveMin !== undefined &&
        effectiveMax !== null &&
        effectiveMax !== undefined &&
        effectiveMin > effectiveMax
      ) {
        throw new Error(
          `note_range_min (${effectiveMin}) must be <= note_range_max (${effectiveMax})`
        );
      }

      // Validate polyphony
      if (capabilities.polyphony !== undefined && capabilities.polyphony !== null) {
        const poly = parseInt(capabilities.polyphony);
        if (isNaN(poly) || poly < 1) {
          throw new Error('polyphony must be a positive number (minimum 1)');
        }
      }

      // Validate enum columns up-front so an invalid value fails with a clear
      // message instead of tripping the table CHECK constraint deeper down.
      if (
        capabilities.note_selection_mode != null &&
        capabilities.note_selection_mode !== 'range' &&
        capabilities.note_selection_mode !== 'discrete'
      ) {
        throw new Error("note_selection_mode must be 'range' or 'discrete'");
      }
      const ALLOWED_CAP_SOURCES = ['manual', 'sysex', 'auto'];
      if (
        capabilities.capabilities_source != null &&
        !ALLOWED_CAP_SOURCES.includes(capabilities.capabilities_source)
      ) {
        throw new Error(`capabilities_source must be one of: ${ALLOWED_CAP_SOURCES.join(', ')}`);
      }

      // Normalise supported_ccs / selected_notes → JSON string of valid MIDI
      // bytes (0-127) through the shared strict parser, so non-integer or
      // malformed input can never reach the `json_valid` CHECK. Previously the
      // primary path let non-integers pass its range loop and stored raw
      // strings verbatim; this matches the per-voice path (MidiListParser).
      let supportedCcsJson = null;
      if (capabilities.supported_ccs !== undefined && capabilities.supported_ccs !== null) {
        supportedCcsJson = serializeValidMidiList(capabilities.supported_ccs);
      }

      let selectedNotesJson = null;
      if (capabilities.selected_notes !== undefined && capabilities.selected_notes !== null) {
        const cleanNotes = parseValidMidiList(capabilities.selected_notes);
        selectedNotesJson = cleanNotes
          ? JSON.stringify([...new Set(cleanNotes)].sort((a, b) => a - b))
          : null;
      }

      // Hands_config: accept either an object (stringified here) or an
      // already-serialized JSON string. `null` means "clear the feature".
      let handsConfigJson = undefined;
      if (capabilities.hands_config !== undefined) {
        if (capabilities.hands_config === null) {
          handsConfigJson = null;
        } else if (typeof capabilities.hands_config === 'string') {
          handsConfigJson = capabilities.hands_config;
        } else if (typeof capabilities.hands_config === 'object') {
          handsConfigJson = JSON.stringify(capabilities.hands_config);
        }
      }

      // Same normalisation for the instrument-specific play configs
      // (bagpipe drones / accordion hands) — migration 022.
      const normJson = (v) => {
        if (v === undefined) return undefined;
        if (v === null) return null;
        if (typeof v === 'string') return v;
        if (typeof v === 'object') return JSON.stringify(v);
        return undefined;
      };
      const bagpipeConfigJson = normJson(capabilities.bagpipe_config);
      const accordionConfigJson = normJson(capabilities.accordion_config);
      const harmonicaConfigJson = normJson(capabilities.harmonica_config);

      if (existing) {
        // Build update with timestamp always included
        const capWithTimestamp = { ...capabilities, capabilities_updated_at: now };
        const result = buildDynamicUpdate(
          'instruments_latency',
          capWithTimestamp,
          [
            'note_range_min',
            'note_range_max',
            'supported_ccs',
            'note_selection_mode',
            'selected_notes',
            'polyphony',
            'capabilities_source',
            'capabilities_updated_at',
            'hands_config',
            'bagpipe_config',
            'accordion_config',
            'harmonica_config'
          ],
          {
            whereClause: 'device_id = ? AND channel = ?',
            transforms: {
              supported_ccs: () => supportedCcsJson,
              selected_notes: () => selectedNotesJson,
              polyphony: (v) => (v !== null ? parseInt(v) : null),
              hands_config: () => handsConfigJson,
              bagpipe_config: () => bagpipeConfigJson,
              accordion_config: () => accordionConfigJson,
              harmonica_config: () => harmonicaConfigJson
            }
          }
        );

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
            capabilities_source, capabilities_updated_at,
            hands_config, bagpipe_config, accordion_config, harmonica_config
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const id = `${deviceId}_${channel}`;
        stmt.run(
          id,
          deviceId,
          channel,
          'Unnamed Instrument',
          capabilities.note_range_min !== undefined && capabilities.note_range_min !== null
            ? capabilities.note_range_min
            : null,
          capabilities.note_range_max !== undefined && capabilities.note_range_max !== null
            ? capabilities.note_range_max
            : null,
          supportedCcsJson,
          capabilities.note_selection_mode || 'range',
          selectedNotesJson,
          capabilities.polyphony !== undefined && capabilities.polyphony !== null
            ? parseInt(capabilities.polyphony)
            : 16,
          capabilities.capabilities_source || 'manual',
          now,
          // P1-4: the UPDATE branch persists these via buildDynamicUpdate; the
          // INSERT branch dropped them, losing configs on the first write for a
          // device+channel. undefined → null for a fresh row.
          handsConfigJson ?? null,
          bagpipeConfigJson ?? null,
          accordionConfigJson ?? null,
          harmonicaConfigJson ?? null
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
            channel, gm_program, sync_delay,
            instrument_type, instrument_subtype,
            note_range_min, note_range_max, supported_ccs,
            note_selection_mode, selected_notes, polyphony,
            min_note_interval, min_note_duration,
            octave_mode, scale_root,
            capabilities_source, capabilities_updated_at, hands_config,
            bagpipe_config, accordion_config, harmonica_config,
            custom_sf2_id, pitch_bend_enabled, voices_share_notes
          FROM instruments_latency
          WHERE device_id = ? AND channel = ?
        `);
        result = stmt.get(deviceId, channel);
      } else {
        const stmt = this.db.prepare(`
          SELECT
            channel, gm_program, sync_delay,
            instrument_type, instrument_subtype,
            note_range_min, note_range_max, supported_ccs,
            note_selection_mode, selected_notes, polyphony,
            min_note_interval, min_note_duration,
            octave_mode, scale_root,
            capabilities_source, capabilities_updated_at, hands_config,
            bagpipe_config, accordion_config, harmonica_config,
            custom_sf2_id, pitch_bend_enabled, voices_share_notes
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

      let handsConfig = null;
      if (result.hands_config) {
        try {
          handsConfig = JSON.parse(result.hands_config);
        } catch (e) {
          this.logger.warn(`Failed to parse hands_config for ${deviceId}: ${e.message}`);
        }
      }

      return {
        channel: result.channel !== undefined && result.channel !== null ? result.channel : 0,
        gm_program: result.gm_program !== undefined ? result.gm_program : null,
        sync_delay: result.sync_delay || 0,
        instrument_type: result.instrument_type || 'unknown',
        instrument_subtype: result.instrument_subtype || null,
        note_range_min: result.note_range_min,
        note_range_max: result.note_range_max,
        supported_ccs: supportedCcs,
        note_selection_mode: result.note_selection_mode || 'range',
        selected_notes: selectedNotes,
        polyphony:
          Number.isInteger(result.polyphony) && result.polyphony > 0 ? result.polyphony : null,
        min_note_interval: result.min_note_interval ?? null,
        min_note_duration: result.min_note_duration ?? null,
        octave_mode: result.octave_mode ?? 'chromatic',
        scale_root: Number.isInteger(result.scale_root) ? result.scale_root : 0,
        capabilities_source: result.capabilities_source,
        capabilities_updated_at: result.capabilities_updated_at,
        hands_config: handsConfig,
        bagpipe_config: parseJsonCol(result.bagpipe_config),
        accordion_config: parseJsonCol(result.accordion_config),
        harmonica_config: parseJsonCol(result.harmonica_config),
        custom_sf2_id: result.custom_sf2_id != null ? result.custom_sf2_id : null,
        // Surfaced so the virtual keyboard's pitch-bend wheel (which gates on
        // caps.pitch_bend_enabled) reflects the instrument-settings toggle.
        pitch_bend_enabled: result.pitch_bend_enabled ? 1 : 0,
        // Phase 8: when cleared (0), each secondary GM voice declares its own
        // playable notes, so MidiPlayer's voice injector picks a voice per note.
        // Default 1 (share) => single primary program, injector is a no-op.
        voices_share_notes: result.voices_share_notes == null ? 1 : result.voices_share_notes
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
          usb_serial_number, mac_address, hands_config,
          bagpipe_config, accordion_config, harmonica_config
        FROM instruments_latency
        ORDER BY device_id
      `);
      const results = stmt.all();

      // Parse JSON arrays for each result
      return results.map((result) => {
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

        let handsConfig = null;
        if (result.hands_config) {
          try {
            handsConfig = JSON.parse(result.hands_config);
          } catch (e) {
            this.logger.warn(`Failed to parse hands_config for ${result.device_id}`);
          }
        }

        return {
          ...result,
          supported_ccs: supportedCcs,
          note_selection_mode: result.note_selection_mode || 'range',
          selected_notes: selectedNotes,
          hands_config: handsConfig,
          bagpipe_config: parseJsonCol(result.bagpipe_config),
          accordion_config: parseJsonCol(result.accordion_config),
          harmonica_config: parseJsonCol(result.harmonica_config)
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
          min_note_interval, min_note_duration, hands_config,
          bagpipe_config, accordion_config, harmonica_config,
          lighting_enabled
        FROM instruments_latency
        ORDER BY name, custom_name
      `);
      const results = stmt.all();

      // The physical hand model's scale length lives on `string_instruments`,
      // not on `instruments_latency`. Attach it per (device, channel) so the
      // matcher can convert `hand_span_mm` → frets for feasibility scoring
      // (audit P2-7 #2). One extra read, merged in JS — leaves the main
      // projection untouched.
      let scaleByKey = new Map();
      try {
        const srows = this.db
          .prepare('SELECT device_id, channel, scale_length_mm FROM string_instruments')
          .all();
        scaleByKey = new Map(srows.map((r) => [`${r.device_id}:${r.channel}`, r.scale_length_mm]));
      } catch (_) {
        // string_instruments may be absent in a minimal/partial schema
      }

      // Parse JSON fields and return
      return results.map((result) => {
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

        let handsConfig = null;
        if (result.hands_config) {
          try {
            handsConfig = JSON.parse(result.hands_config);
          } catch (e) {
            this.logger.warn(`Failed to parse hands_config for ${result.device_id}`);
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
          // Per-instrument lighting control toggle
          lighting_enabled: result.lighting_enabled === 1,
          // Hand-position control (optional, piano/strings)
          hands_config: handsConfig,
          bagpipe_config: parseJsonCol(result.bagpipe_config),
          accordion_config: parseJsonCol(result.accordion_config),
          harmonica_config: parseJsonCol(result.harmonica_config),
          // Physical hand model (from string_instruments) — used by the
          // feasibility heuristic to convert hand_span_mm → frets.
          scale_length_mm: scaleByKey.get(`${result.device_id}:${result.channel}`) ?? null,
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

  /**
   * Cheap fingerprint of the instrument catalog, used to key the
   * auto-assign suggestion cache. Changes whenever an instrument is
   * added/removed (count, max id) or its capabilities are edited
   * (capabilities_updated_at). A single indexed aggregate — far cheaper
   * than re-running the channel × instrument scoring loop.
   * @returns {string}
   */
  getCatalogFingerprint() {
    try {
      const row = this.db
        .prepare(
          `
        SELECT COUNT(*) AS n,
               COALESCE(MAX(id), 0) AS maxid,
               COALESCE(MAX(capabilities_updated_at), '') AS capu
        FROM instruments_latency
      `
        )
        .get();
      return `${row.n}:${row.maxid}:${row.capu}`;
    } catch (error) {
      this.logger.warn(`Failed to compute instrument catalog fingerprint: ${error.message}`);
      // Unique-ish fallback ⇒ cache miss (correct, just not cached).
      return `nofp:${Date.now()}`;
    }
  }
}

export default InstrumentCapabilitiesDB;
