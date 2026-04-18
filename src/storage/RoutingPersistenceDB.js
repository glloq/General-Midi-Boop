/**
 * RoutingPersistenceDB — extracted routing persistence methods
 * for MIDI instrument routing storage operations.
 */
class RoutingPersistenceDB {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {object} logger
   */
  constructor(db, logger) {
    this.db = db;
    this.logger = logger;
  }

  /**
   * Insert or update a channel routing for a MIDI file
   * @param {Object} routing - { midi_file_id, channel, device_id, instrument_name, compatibility_score, transposition_applied, auto_assigned, assignment_reason, note_remapping, enabled, split_mode, split_note_min, split_note_max, split_polyphony_share, overlap_strategy }
   * @returns {number} routing id
   */
  insertRouting(routing) {
    try {
      // Validate split segment ranges
      if (routing.split_mode) {
        const noteMin = routing.split_note_min;
        const noteMax = routing.split_note_max;
        if (noteMin != null && noteMax != null) {
          if (noteMin > noteMax) {
            throw new Error(`Invalid split range: min (${noteMin}) > max (${noteMax})`);
          }
          if (noteMin < 0 || noteMax > 127) {
            throw new Error(`Split range out of MIDI bounds: [${noteMin}, ${noteMax}]`);
          }
        }
      }
      // Validate channel
      if (routing.channel != null && (routing.channel < 0 || routing.channel > 15)) {
        throw new Error(`Invalid MIDI channel: ${routing.channel} (must be 0-15)`);
      }

      // For split routings, use a different INSERT (no ON CONFLICT since multiple rows per channel)
      if (routing.split_mode) {
        const stmt = this.db.prepare(`
          INSERT INTO midi_instrument_routings
            (midi_file_id, track_id, channel, device_id, instrument_name,
             compatibility_score, transposition_applied, auto_assigned,
             assignment_reason, note_remapping, enabled, created_at,
             split_mode, split_note_min, split_note_max, split_polyphony_share,
             overlap_strategy, behavior_mode)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const result = stmt.run(
          routing.midi_file_id,
          routing.target_channel !== undefined ? routing.target_channel : routing.channel,
          routing.channel,
          routing.device_id,
          routing.instrument_name,
          routing.compatibility_score ?? null,
          routing.transposition_applied ?? 0,
          routing.auto_assigned ? 1 : 0,
          routing.assignment_reason || null,
          routing.note_remapping || null,
          routing.enabled !== false ? 1 : 0,
          routing.created_at || Date.now(),
          routing.split_mode,
          routing.split_note_min ?? null,
          routing.split_note_max ?? null,
          routing.split_polyphony_share ?? null,
          routing.overlap_strategy || null,
          routing.behavior_mode || null
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
        routing.compatibility_score ?? null,
        routing.transposition_applied ?? 0,
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
    const run = this.db.transaction(() => {
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
    });

    try {
      run();
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
      split_polyphony_share: row.split_polyphony_share ?? null,
      overlap_strategy: row.overlap_strategy || null,
      behavior_mode: row.behavior_mode || null
    }));
  }

  /**
   * Get routing counts and min compatibility score for multiple files in one query.
   * @param {number[]} fileIds
   * @param {Set<string>} [connectedDeviceIds] - If provided, only count routings to these devices
   * @returns {Array<{midi_file_id: number, count: number, min_score: number}>}
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
   * Delete all routings for a device (optionally scoped to one channel).
   * Encapsulates raw `DELETE FROM midi_instrument_routings` SQL previously
   * duplicated in handlers (P0-2.5n).
   */
  deleteRoutingsByDevice(deviceId, channel) {
    try {
      if (channel !== undefined && channel !== null) {
        this.db.prepare(
          'DELETE FROM midi_instrument_routings WHERE device_id = ? AND channel = ?'
        ).run(deviceId, channel);
      } else {
        this.db.prepare(
          'DELETE FROM midi_instrument_routings WHERE device_id = ?'
        ).run(deviceId);
      }
    } catch (error) {
      this.logger.error(`Failed to delete routings for device ${deviceId}: ${error.message}`);
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

export default RoutingPersistenceDB;
