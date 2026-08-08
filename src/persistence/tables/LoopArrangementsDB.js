/**
 * @file src/persistence/tables/LoopArrangementsDB.js
 * @description SQLite access layer for loop arrangements (arranger tab).
 */
import { buildDynamicUpdate } from '../dbHelpers.js';

class LoopArrangementsDB {
  constructor(db, logger) {
    this.db = db;
    this.logger = logger;
  }

  // ── Arrangements ──────────────────────────────────────────

  insertArrangement(arr) {
    try {
      const now = Date.now();
      const r = this.db
        .prepare(
          'INSERT INTO loop_arrangements (name, global_tempo, total_bars, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(arr.name, arr.global_tempo ?? 120, arr.total_bars ?? 16, now, now);
      return r.lastInsertRowid;
    } catch (e) {
      this.logger.error(`LoopArrangementsDB.insertArrangement: ${e.message}`);
      throw e;
    }
  }

  getArrangement(id) {
    try {
      return this.db.prepare('SELECT * FROM loop_arrangements WHERE id = ?').get(id) ?? null;
    } catch (e) {
      this.logger.error(`LoopArrangementsDB.getArrangement: ${e.message}`);
      throw e;
    }
  }

  getArrangements() {
    try {
      return this.db.prepare('SELECT * FROM loop_arrangements ORDER BY updated_at DESC').all();
    } catch (e) {
      this.logger.error(`LoopArrangementsDB.getArrangements: ${e.message}`);
      throw e;
    }
  }

  updateArrangement(id, fields) {
    try {
      const allowed = ['name', 'global_tempo', 'total_bars'];
      if (!allowed.some((k) => k in fields)) return;
      const result = buildDynamicUpdate(
        'loop_arrangements',
        { ...fields, updated_at: Date.now() },
        [...allowed, 'updated_at']
      );
      if (!result) return; // defensive parity with sibling updaters (audit A3 C4-M2)
      this.db.prepare(result.sql).run(...result.values, id);
    } catch (e) {
      this.logger.error(`LoopArrangementsDB.updateArrangement: ${e.message}`);
      throw e;
    }
  }

  deleteArrangement(id) {
    try {
      this.db.prepare('DELETE FROM loop_arrangements WHERE id = ?').run(id);
    } catch (e) {
      this.logger.error(`LoopArrangementsDB.deleteArrangement: ${e.message}`);
      throw e;
    }
  }

  // ── Tracks ────────────────────────────────────────────────

  insertTrack(track) {
    try {
      const r = this.db
        .prepare(
          'INSERT INTO loop_arrangement_tracks (arrangement_id, track_index, label, midi_channel) VALUES (?, ?, ?, ?)'
        )
        .run(track.arrangement_id, track.track_index, track.label ?? '', track.midi_channel ?? 1);
      return r.lastInsertRowid;
    } catch (e) {
      this.logger.error(`LoopArrangementsDB.insertTrack: ${e.message}`);
      throw e;
    }
  }

  getTracks(arrangementId) {
    try {
      return this.db
        .prepare(
          'SELECT * FROM loop_arrangement_tracks WHERE arrangement_id = ? ORDER BY track_index'
        )
        .all(arrangementId);
    } catch (e) {
      this.logger.error(`LoopArrangementsDB.getTracks: ${e.message}`);
      throw e;
    }
  }

  getTrack(id) {
    try {
      return this.db.prepare('SELECT * FROM loop_arrangement_tracks WHERE id = ?').get(id) ?? null;
    } catch (e) {
      this.logger.error(`LoopArrangementsDB.getTrack: ${e.message}`);
      throw e;
    }
  }

  updateTrack(id, fields) {
    try {
      const result = buildDynamicUpdate('loop_arrangement_tracks', fields, [
        'label',
        'midi_channel'
      ]);
      if (!result) return;
      this.db.prepare(result.sql).run(...result.values, id);
    } catch (e) {
      this.logger.error(`LoopArrangementsDB.updateTrack: ${e.message}`);
      throw e;
    }
  }

  deleteTrack(id) {
    try {
      this.db.prepare('DELETE FROM loop_arrangement_tracks WHERE id = ?').run(id);
    } catch (e) {
      this.logger.error(`LoopArrangementsDB.deleteTrack: ${e.message}`);
      throw e;
    }
  }

  // ── Blocks ────────────────────────────────────────────────

  insertBlock(block) {
    try {
      const r = this.db
        .prepare(
          'INSERT INTO loop_arrangement_blocks (track_id, loop_id, position_bar, repetitions) VALUES (?, ?, ?, ?)'
        )
        .run(block.track_id, block.loop_id, block.position_bar ?? 0, block.repetitions ?? 1);
      return r.lastInsertRowid;
    } catch (e) {
      this.logger.error(`LoopArrangementsDB.insertBlock: ${e.message}`);
      throw e;
    }
  }

  getBlocks(trackId) {
    try {
      return this.db
        .prepare(
          'SELECT b.*, l.name as loop_name, l.bars as loop_bars, l.tempo as loop_tempo FROM loop_arrangement_blocks b JOIN loops l ON l.id = b.loop_id WHERE b.track_id = ? ORDER BY b.position_bar'
        )
        .all(trackId);
    } catch (e) {
      this.logger.error(`LoopArrangementsDB.getBlocks: ${e.message}`);
      throw e;
    }
  }

  getAllBlocksForArrangement(arrangementId) {
    try {
      return this.db
        .prepare(
          `
        SELECT b.*, l.name as loop_name, l.bars as loop_bars, l.tempo as loop_tempo, l.midi_data as loop_midi_data,
               t.track_index, t.label as track_label, t.midi_channel
        FROM loop_arrangement_blocks b
        JOIN loop_arrangement_tracks t ON t.id = b.track_id
        JOIN loops l ON l.id = b.loop_id
        WHERE t.arrangement_id = ?
        ORDER BY t.track_index, b.position_bar
      `
        )
        .all(arrangementId);
    } catch (e) {
      this.logger.error(`LoopArrangementsDB.getAllBlocksForArrangement: ${e.message}`);
      throw e;
    }
  }

  /**
   * Full arrangement fetch en une seule passe DB.
   * Retourne `{ tracks, blocks }` ; LEFT JOIN garantit que les tracks
   * sans block sont incluses (sinon arrangement nouveau-né serait vide
   * en lecture).
   * @param {number} arrangementId
   */
  getFullArrangement(arrangementId) {
    try {
      const rows = this.db
        .prepare(
          `
        SELECT
          t.id              AS track_id,
          t.arrangement_id  AS track_arrangement_id,
          t.track_index     AS track_index,
          t.label           AS track_label,
          t.midi_channel    AS track_midi_channel,
          b.id              AS block_id,
          b.position_bar    AS block_position_bar,
          b.repetitions     AS block_repetitions,
          b.loop_id         AS block_loop_id,
          l.name            AS loop_name,
          l.bars            AS loop_bars,
          l.tempo           AS loop_tempo,
          l.midi_data       AS loop_midi_data
        FROM loop_arrangement_tracks t
        LEFT JOIN loop_arrangement_blocks b ON b.track_id = t.id
        LEFT JOIN loops l ON l.id = b.loop_id
        WHERE t.arrangement_id = ?
        ORDER BY t.track_index, b.position_bar
      `
        )
        .all(arrangementId);

      const tracksMap = new Map();
      const blocks = [];
      for (const r of rows) {
        if (!tracksMap.has(r.track_id)) {
          tracksMap.set(r.track_id, {
            id: r.track_id,
            arrangement_id: r.track_arrangement_id,
            track_index: r.track_index,
            label: r.track_label,
            midi_channel: r.track_midi_channel
          });
        }
        if (r.block_id !== null) {
          blocks.push({
            id: r.block_id,
            track_id: r.track_id,
            loop_id: r.block_loop_id,
            position_bar: r.block_position_bar,
            repetitions: r.block_repetitions,
            loop_name: r.loop_name,
            loop_bars: r.loop_bars,
            loop_tempo: r.loop_tempo,
            loop_midi_data: r.loop_midi_data,
            track_index: r.track_index,
            track_label: r.track_label,
            midi_channel: r.track_midi_channel
          });
        }
      }
      return { tracks: [...tracksMap.values()], blocks };
    } catch (e) {
      this.logger.error(`LoopArrangementsDB.getFullArrangement: ${e.message}`);
      throw e;
    }
  }

  /**
   * Compte combien de blocks référencent un loop donné (utilisé pour
   * prévenir l'UI de l'impact d'un CASCADE avant `loop_delete`).
   * @param {number} loopId
   * @returns {number}
   */
  countBlocksByLoopId(loopId) {
    try {
      const row = this.db
        .prepare('SELECT COUNT(*) AS n FROM loop_arrangement_blocks WHERE loop_id = ?')
        .get(loopId);
      return row?.n ?? 0;
    } catch (e) {
      this.logger.error(`LoopArrangementsDB.countBlocksByLoopId: ${e.message}`);
      throw e;
    }
  }

  updateBlock(id, fields) {
    try {
      const result = buildDynamicUpdate('loop_arrangement_blocks', fields, [
        'position_bar',
        'repetitions',
        'loop_id',
        'track_id'
      ]);
      if (!result) return;
      this.db.prepare(result.sql).run(...result.values, id);
    } catch (e) {
      this.logger.error(`LoopArrangementsDB.updateBlock: ${e.message}`);
      throw e;
    }
  }

  deleteBlock(id) {
    try {
      this.db.prepare('DELETE FROM loop_arrangement_blocks WHERE id = ?').run(id);
    } catch (e) {
      this.logger.error(`LoopArrangementsDB.deleteBlock: ${e.message}`);
      throw e;
    }
  }
}

export default LoopArrangementsDB;
