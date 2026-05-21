/**
 * @file src/api/commands/schemas/bank_effects.schemas.js
 * @description Declarative validation schemas for `bank_effects_*`
 * WebSocket commands (PR 3, ROADMAP_DI_2026-05-21).
 *
 * Per-bank effect overrides (reverb + echo) used by the browser-side
 * synth. See `src/api/commands/BankEffectsCommands.js` for the handler
 * contract; ranges mirror `_validateFloat` / `_validateInt` in that file
 * so the schema-level error and the handler-level error agree.
 */

const BANK_ID_MAX_LEN = 64;

const requireBankId = {
  fields: {
    bankId: { type: 'string', required: true, minLength: 1, maxLength: BANK_ID_MAX_LEN }
  }
};

export const bank_effects_get = requireBankId;
export const bank_effects_reset = requireBankId;

// bank_effects_list takes no payload; declared so the coverage script
// (PR 5) sees every registered command paired with a schema.
export const bank_effects_list = {};

export const bank_effects_update = {
  fields: {
    bankId: { type: 'string', required: true, minLength: 1, maxLength: BANK_ID_MAX_LEN },
    reverb_mix: { type: 'number', min: 0, max: 1 },
    reverb_decay_s: { type: 'number', min: 0.3, max: 3.0 },
    echo_mix: { type: 'number', min: 0, max: 1 },
    echo_time_ms: { type: 'integer', min: 50, max: 1000 },
    echo_feedback: { type: 'number', min: 0, max: 0.9 }
  }
};

const schemas = {
  bank_effects_get,
  bank_effects_list,
  bank_effects_update,
  bank_effects_reset
};

export default schemas;
