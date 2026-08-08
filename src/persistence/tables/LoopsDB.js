/**
 * @file src/persistence/tables/LoopsDB.js
 * @description SQLite access layer for sample loops (Loop Creator modal).
 * Each loop stores a name, tempo, time signature, bar count, and a JSON
 * note sequence compatible with webaudio-pianoroll format.
 */
import { buildDynamicUpdate } from '../dbHelpers.js';

class LoopsDB {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {Object} logger
   */
  constructor(db, logger) {
    this.db = db;
    this.logger = logger;
  }

  insertLoop(loop) {
    try {
      const now = Date.now();
      const stmt = this.db.prepare(`
        INSERT INTO loops (name, tempo, time_sig_num, time_sig_den, bars, ppq,
          instrument_program, midi_data, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const result = stmt.run(
        loop.name,
        loop.tempo ?? 120,
        loop.time_sig_num ?? 4,
        loop.time_sig_den ?? 4,
        loop.bars ?? 2,
        loop.ppq ?? 480,
        loop.instrument_program ?? null,
        typeof loop.midi_data === 'string' ? loop.midi_data : JSON.stringify(loop.midi_data ?? []),
        now,
        now
      );
      return result.lastInsertRowid;
    } catch (error) {
      this.logger.error(`LoopsDB.insertLoop: ${error.message}`);
      throw error;
    }
  }

  getLoop(id) {
    try {
      return this.db.prepare('SELECT * FROM loops WHERE id = ?').get(id) ?? null;
    } catch (error) {
      this.logger.error(`LoopsDB.getLoop: ${error.message}`);
      throw error;
    }
  }

  getLoops() {
    try {
      return this.db
        .prepare(
          'SELECT id, name, tempo, time_sig_num, time_sig_den, bars, ppq, instrument_program, created_at, updated_at FROM loops ORDER BY updated_at DESC'
        )
        .all();
    } catch (error) {
      this.logger.error(`LoopsDB.getLoops: ${error.message}`);
      throw error;
    }
  }

  updateLoop(id, fields) {
    try {
      const allowed = [
        'name',
        'tempo',
        'time_sig_num',
        'time_sig_den',
        'bars',
        'ppq',
        'instrument_program',
        'midi_data'
      ];
      if (!allowed.some((k) => k in fields)) return;

      const result = buildDynamicUpdate(
        'loops',
        { ...fields, updated_at: Date.now() },
        [...allowed, 'updated_at'],
        { transforms: { midi_data: (v) => (typeof v === 'string' ? v : JSON.stringify(v)) } }
      );
      if (!result) return; // defensive parity with sibling updaters (audit A3 C4-M2)
      this.db.prepare(result.sql).run(...result.values, id);
    } catch (error) {
      this.logger.error(`LoopsDB.updateLoop: ${error.message}`);
      throw error;
    }
  }

  deleteLoop(id) {
    try {
      this.db.prepare('DELETE FROM loops WHERE id = ?').run(id);
    } catch (error) {
      this.logger.error(`LoopsDB.deleteLoop: ${error.message}`);
      throw error;
    }
  }
}

export default LoopsDB;
