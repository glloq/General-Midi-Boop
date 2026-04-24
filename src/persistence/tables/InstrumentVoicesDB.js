/**
 * @file src/persistence/tables/InstrumentVoicesDB.js
 * @description Secondary GM voices attached to an instrument
 * (device_id + channel). The primary voice remains on
 * `instruments_latency.gm_program`; this table stores the additional
 * alternatives (e.g. fretless, slap, tapping variations of a bass).
 *
 * Semantics: voices are ALTERNATIVES, not layers. The playback engine
 * picks one voice per note based on context — see migration 003 and
 * INSTRUMENT_FAMILY_REFACTOR_ROADMAP.md Phase 8.
 */
import { buildDynamicUpdate } from '../dbHelpers.js';

class InstrumentVoicesDB {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {Object} logger
   */
  constructor(db, logger) {
    this.db = db;
    this.logger = logger;
  }

  /**
   * Return all secondary voices for a given (device_id, channel),
   * ordered by display_order then id.
   *
   * @param {string} deviceId
   * @param {number} channel
   * @returns {Array<{id:number, device_id:string, channel:number,
   *   gm_program:number|null, min_note_interval:number|null,
   *   min_note_duration:number|null, supported_ccs:number[]|null,
   *   display_order:number}>}
   */
  listByInstrument(deviceId, channel) {
    try {
      const rows = this.db.prepare(`
        SELECT id, device_id, channel, gm_program,
               min_note_interval, min_note_duration,
               supported_ccs, display_order,
               note_selection_mode, note_range_min, note_range_max,
               selected_notes, octave_mode,
               created_at, updated_at
        FROM instrument_voices
        WHERE device_id = ? AND channel = ?
        ORDER BY display_order ASC, id ASC
      `).all(deviceId, channel);
      return rows.map((r) => ({
        ...r,
        supported_ccs: _parseCcList(r.supported_ccs),
        selected_notes: _parseNoteList(r.selected_notes)
      }));
    } catch (error) {
      this.logger.error(`Failed to list instrument voices: ${error.message}`);
      throw error;
    }
  }

  /**
   * Create a new secondary voice. Returns the inserted row's id.
   *
   * @param {string} deviceId
   * @param {number} channel
   * @param {{gm_program?:number|null, min_note_interval?:number|null,
   *   min_note_duration?:number|null, supported_ccs?:number[]|null,
   *   display_order?:number}} payload
   * @returns {number} New voice id.
   */
  create(deviceId, channel, payload = {}) {
    try {
      const order = Number.isFinite(payload.display_order)
        ? payload.display_order
        : _nextDisplayOrder(this.db, deviceId, channel);
      const result = this.db.prepare(`
        INSERT INTO instrument_voices
          (device_id, channel, gm_program,
           min_note_interval, min_note_duration,
           supported_ccs, display_order,
           note_selection_mode, note_range_min, note_range_max,
           selected_notes, octave_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        deviceId,
        channel,
        payload.gm_program ?? null,
        payload.min_note_interval ?? null,
        payload.min_note_duration ?? null,
        _serializeCcList(payload.supported_ccs),
        order,
        payload.note_selection_mode ?? null,
        payload.note_range_min ?? null,
        payload.note_range_max ?? null,
        _serializeNoteList(payload.selected_notes),
        payload.octave_mode ?? null
      );
      return Number(result.lastInsertRowid);
    } catch (error) {
      this.logger.error(`Failed to create instrument voice: ${error.message}`);
      throw error;
    }
  }

  /**
   * Patch an existing voice by id. Only whitelisted fields are applied.
   *
   * @param {number} id
   * @param {Object} patch
   * @returns {void}
   */
  update(id, patch = {}) {
    try {
      const next = { ...patch };
      if (Object.prototype.hasOwnProperty.call(next, 'supported_ccs')) {
        next.supported_ccs = _serializeCcList(next.supported_ccs);
      }
      if (Object.prototype.hasOwnProperty.call(next, 'selected_notes')) {
        next.selected_notes = _serializeNoteList(next.selected_notes);
      }
      const result = buildDynamicUpdate('instrument_voices', next, [
        'gm_program', 'min_note_interval', 'min_note_duration',
        'supported_ccs', 'display_order',
        'note_selection_mode', 'note_range_min', 'note_range_max',
        'selected_notes', 'octave_mode'
      ]);
      if (!result) return;
      this.db.prepare(result.sql).run(...result.values, id);
    } catch (error) {
      this.logger.error(`Failed to update instrument voice: ${error.message}`);
      throw error;
    }
  }

  /**
   * Delete a voice by id. Returns number of rows affected (0 or 1).
   *
   * @param {number} id
   * @returns {number}
   */
  deleteById(id) {
    try {
      return this.db.prepare('DELETE FROM instrument_voices WHERE id = ?').run(id).changes;
    } catch (error) {
      this.logger.error(`Failed to delete instrument voice: ${error.message}`);
      throw error;
    }
  }

  /**
   * Bulk-delete all voices for an instrument (device + channel) or
   * every channel on a device when `channel` is omitted. Used by
   * instrument teardown to keep the table consistent.
   *
   * @param {string} deviceId
   * @param {number} [channel]
   * @returns {number} Rows affected.
   */
  deleteByInstrument(deviceId, channel) {
    try {
      if (channel !== undefined && channel !== null) {
        return this.db.prepare(
          'DELETE FROM instrument_voices WHERE device_id = ? AND channel = ?'
        ).run(deviceId, channel).changes;
      }
      return this.db.prepare(
        'DELETE FROM instrument_voices WHERE device_id = ?'
      ).run(deviceId).changes;
    } catch (error) {
      this.logger.error(`Failed to bulk-delete instrument voices: ${error.message}`);
      throw error;
    }
  }

  /**
   * Atomically replace the voice list for an instrument. Existing voices
   * are deleted and the provided list is inserted in order. Used by the
   * UI save path when the user's voice list changes.
   *
   * @param {string} deviceId
   * @param {number} channel
   * @param {Array<{gm_program?, min_note_interval?, min_note_duration?,
   *   supported_ccs?}>} voices
   * @returns {number[]} The new voice ids in the same order.
   */
  replaceAll(deviceId, channel, voices) {
    const insert = this.db.prepare(`
      INSERT INTO instrument_voices
        (device_id, channel, gm_program,
         min_note_interval, min_note_duration,
         supported_ccs, display_order,
         note_selection_mode, note_range_min, note_range_max,
         selected_notes, octave_mode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const del = this.db.prepare(
      'DELETE FROM instrument_voices WHERE device_id = ? AND channel = ?'
    );
    const ids = [];
    const tx = this.db.transaction(() => {
      del.run(deviceId, channel);
      let order = 0;
      for (const v of voices) {
        const res = insert.run(
          deviceId,
          channel,
          v.gm_program ?? null,
          v.min_note_interval ?? null,
          v.min_note_duration ?? null,
          _serializeCcList(v.supported_ccs),
          order++,
          v.note_selection_mode ?? null,
          v.note_range_min ?? null,
          v.note_range_max ?? null,
          _serializeNoteList(v.selected_notes),
          v.octave_mode ?? null
        );
        ids.push(Number(res.lastInsertRowid));
      }
    });
    try {
      tx();
    } catch (error) {
      this.logger.error(`Failed to replace instrument voices: ${error.message}`);
      throw error;
    }
    return ids;
  }
}

// -------- internal helpers --------

function _parseCcList(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function _serializeCcList(value) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    const clean = value
      .map((n) => (typeof n === 'string' ? parseInt(n, 10) : n))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 127);
    return clean.length === 0 ? null : JSON.stringify(clean);
  }
  if (typeof value === 'string') {
    const parts = value
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 127);
    return parts.length === 0 ? null : JSON.stringify(parts);
  }
  return null;
}

function _parseNoteList(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function _serializeNoteList(value) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    const clean = value
      .map((n) => (typeof n === 'string' ? parseInt(n, 10) : n))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 127);
    return clean.length === 0 ? null : JSON.stringify(clean);
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return _serializeNoteList(parsed);
    } catch { /* fall through to CSV path */ }
    const parts = value
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 127);
    return parts.length === 0 ? null : JSON.stringify(parts);
  }
  return null;
}

function _nextDisplayOrder(db, deviceId, channel) {
  const row = db.prepare(
    'SELECT MAX(display_order) AS m FROM instrument_voices WHERE device_id = ? AND channel = ?'
  ).get(deviceId, channel);
  return (row && Number.isFinite(row.m)) ? row.m + 1 : 0;
}

export default InstrumentVoicesDB;
