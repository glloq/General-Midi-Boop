/**
 * @file src/persistence/tables/BankEffectsDB.js
 * @description CRUD for the `bank_effects` table — per-sound-bank
 * overrides for the browser-side synth (reverb mix/decay, echo
 * mix/time/feedback). Sub-module of {@link Database}.
 *
 * Absence of a row means the bank uses its built-in defaults from
 * `public/js/audio/MidiSynthesizerConstants.js` (SOUND_BANKS[].reverbMix).
 */

class BankEffectsDB {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {Object} logger
   */
  constructor(db, logger) {
    this.db = db;
    this.logger = logger;
  }

  /**
   * Fetch stored overrides for a bank.
   * @param {string} bankId
   * @returns {Object|null} row or null if no override stored
   */
  getForBank(bankId) {
    try {
      const stmt = this.db.prepare(
        `SELECT bank_id, reverb_mix, reverb_decay_s, echo_mix, echo_time_ms,
                echo_feedback, updated_at
         FROM bank_effects WHERE bank_id = ?`
      );
      return stmt.get(bankId) || null;
    } catch (error) {
      this.logger.error(`BankEffectsDB.getForBank failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * List every stored override (all banks).
   * @returns {Object[]}
   */
  listAll() {
    try {
      const stmt = this.db.prepare(
        `SELECT bank_id, reverb_mix, reverb_decay_s, echo_mix, echo_time_ms,
                echo_feedback, updated_at
         FROM bank_effects`
      );
      return stmt.all();
    } catch (error) {
      this.logger.error(`BankEffectsDB.listAll failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Upsert the full set of effect values for a bank. Callers are
   * expected to merge their partial updates with the existing row
   * before calling; this method always writes all five fields.
   * @param {string} bankId
   * @param {{reverb_mix:number, reverb_decay_s:number, echo_mix:number,
   *          echo_time_ms:number, echo_feedback:number}} values
   */
  upsert(bankId, values) {
    try {
      const stmt = this.db.prepare(
        `INSERT INTO bank_effects
           (bank_id, reverb_mix, reverb_decay_s, echo_mix, echo_time_ms, echo_feedback)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(bank_id) DO UPDATE SET
           reverb_mix     = excluded.reverb_mix,
           reverb_decay_s = excluded.reverb_decay_s,
           echo_mix       = excluded.echo_mix,
           echo_time_ms   = excluded.echo_time_ms,
           echo_feedback  = excluded.echo_feedback,
           updated_at     = datetime('now')`
      );
      stmt.run(
        bankId,
        values.reverb_mix,
        values.reverb_decay_s,
        values.echo_mix,
        values.echo_time_ms,
        values.echo_feedback
      );
    } catch (error) {
      this.logger.error(`BankEffectsDB.upsert failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Remove the override row for a bank (reverts to built-in defaults).
   * @param {string} bankId
   */
  resetBank(bankId) {
    try {
      this.db.prepare('DELETE FROM bank_effects WHERE bank_id = ?').run(bankId);
    } catch (error) {
      this.logger.error(`BankEffectsDB.resetBank failed: ${error.message}`);
      throw error;
    }
  }
}

export default BankEffectsDB;
