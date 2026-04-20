/**
 * @file src/api/commands/BankEffectsCommands.js
 * @description WebSocket commands managing per-sound-bank effect
 * overrides (reverb + echo levels) used by the browser-side synth.
 *
 * Registered commands:
 *   - `bank_effects_get`    — read stored overrides for a bank (or null)
 *   - `bank_effects_list`   — list every stored override
 *   - `bank_effects_update` — upsert; emits `bank_effects_changed`
 *   - `bank_effects_reset`  — DELETE row; emits `bank_effects_changed`
 *
 * The server does not know the full list of valid bank IDs (that list
 * lives in the browser's `MidiSynthesizerConstants.js`). We only
 * require a non-empty string and cap its length so the DB stays sane.
 */
import { ValidationError, ConfigurationError } from '../../core/errors/index.js';

const BANK_ID_MAX_LEN = 64;

/**
 * Validate and coerce a float in [min, max]. Throws ValidationError
 * when the input is not a finite number or out of range.
 */
function _validateFloat(value, field, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < min || num > max) {
    throw new ValidationError(
      `${field} must be a number between ${min} and ${max}`,
      field
    );
  }
  return num;
}

function _validateInt(value, field, min, max) {
  const num = parseInt(value, 10);
  if (!Number.isFinite(num) || num < min || num > max) {
    throw new ValidationError(
      `${field} must be an integer between ${min} and ${max}`,
      field
    );
  }
  return num;
}

function _validateBankId(bankId) {
  if (typeof bankId !== 'string' || bankId.length === 0) {
    throw new ValidationError('bankId is required', 'bankId');
  }
  if (bankId.length > BANK_ID_MAX_LEN) {
    throw new ValidationError(
      `bankId must not exceed ${BANK_ID_MAX_LEN} characters`,
      'bankId'
    );
  }
  return bankId;
}

/**
 * @param {Object} app
 * @param {{bankId:string}} data
 * @returns {{success:true, effects:Object|null}}
 */
function bankEffectsGet(app, data) {
  if (!app.database) throw new ConfigurationError('Database not available');
  const bankId = _validateBankId(data.bankId);
  const row = app.database.getBankEffects(bankId);
  return { success: true, effects: row || null };
}

/**
 * @param {Object} app
 * @returns {{success:true, effects:Object[]}}
 */
function bankEffectsList(app) {
  if (!app.database) throw new ConfigurationError('Database not available');
  const rows = app.database.listBankEffects();
  return { success: true, effects: rows };
}

/**
 * Upsert the full set of effect values for a bank. Missing fields fall
 * back to either the current stored value or the schema default, so
 * the UI can send partial updates when a single slider moves.
 *
 * @param {Object} app
 * @param {{bankId:string, reverb_mix?:number, reverb_decay_s?:number,
 *          echo_mix?:number, echo_time_ms?:number, echo_feedback?:number}} data
 * @returns {{success:true, effects:Object}}
 */
function bankEffectsUpdate(app, data) {
  if (!app.database) throw new ConfigurationError('Database not available');
  const bankId = _validateBankId(data.bankId);

  const existing = app.database.getBankEffects(bankId) || {
    reverb_mix: 0.12,
    reverb_decay_s: 1.2,
    echo_mix: 0.0,
    echo_time_ms: 250,
    echo_feedback: 0.3
  };

  const merged = {
    reverb_mix: data.reverb_mix !== undefined
      ? _validateFloat(data.reverb_mix, 'reverb_mix', 0, 1)
      : existing.reverb_mix,
    reverb_decay_s: data.reverb_decay_s !== undefined
      ? _validateFloat(data.reverb_decay_s, 'reverb_decay_s', 0.3, 3.0)
      : existing.reverb_decay_s,
    echo_mix: data.echo_mix !== undefined
      ? _validateFloat(data.echo_mix, 'echo_mix', 0, 1)
      : existing.echo_mix,
    echo_time_ms: data.echo_time_ms !== undefined
      ? _validateInt(data.echo_time_ms, 'echo_time_ms', 50, 1000)
      : existing.echo_time_ms,
    echo_feedback: data.echo_feedback !== undefined
      ? _validateFloat(data.echo_feedback, 'echo_feedback', 0, 0.9)
      : existing.echo_feedback
  };

  app.database.upsertBankEffects(bankId, merged);

  app.eventBus?.emit('bank_effects_changed', { bankId, effects: merged });

  return { success: true, effects: { bank_id: bankId, ...merged } };
}

/**
 * @param {Object} app
 * @param {{bankId:string}} data
 * @returns {{success:true}}
 */
function bankEffectsReset(app, data) {
  if (!app.database) throw new ConfigurationError('Database not available');
  const bankId = _validateBankId(data.bankId);
  app.database.resetBankEffects(bankId);
  app.eventBus?.emit('bank_effects_changed', { bankId, effects: null });
  return { success: true };
}

/**
 * @param {import('../CommandRegistry.js').default} registry
 * @param {Object} app
 */
export function register(registry, app) {
  registry.register('bank_effects_get', (data) => bankEffectsGet(app, data));
  registry.register('bank_effects_list', () => bankEffectsList(app));
  registry.register('bank_effects_update', (data) => bankEffectsUpdate(app, data));
  registry.register('bank_effects_reset', (data) => bankEffectsReset(app, data));
}
