/**
 * @file src/api/commands/schemas/string_instrument.schemas.js
 * @description Declarative validation schemas for `string_instrument_*` and
 * `tablature_*` WebSocket commands. Consumed by
 * `JsonValidator.validateByCommand`.
 *
 * `StringInstrumentCommands` shipped with 15/15 commands unvalidated. The
 * fuzzing campaign reached a database constraint from the network —
 * `CHECK constraint failed: channel BETWEEN 0 AND 15` on
 * `string_instrument_create` — which is the F-19 statement in one line: the
 * last line of defence was the SQL schema
 * (docs/audit/2026-09-07/01_API_CONTRACT.md §3.4).
 *
 * The numeric bounds below mirror the CHECK constraints of
 * `migrations/001_baseline.sql` (§string_instruments) and of migration 007
 * (`scale_length_mm BETWEEN 100 AND 2000`), so an invalid value is now
 * refused with a readable message instead of surfacing as a masked
 * "Internal server error".
 */
import {
  fieldRules,
  isIdLike,
  isIntLike,
  isBoolLike,
  isChannel,
  isNonEmptyStr,
  isStr,
  isArrayMax,
  isPlainObject,
  MAX_ID_LEN,
  MAX_NAME_LEN
} from './helpers.js';

/** Largest tablature/notes payload accepted in one frame. */
const MAX_EVENTS = 200000;
/** Largest `tuning` array (one entry per string). */
const MAX_STRINGS = 12;

/** Shared column rules for create/update (all optional — partial updates). */
const instrumentColumnRules = [
  // Kept liberal on purpose: the modal can submit an empty name and the column
  // carries `NOT NULL DEFAULT 'Guitar'`, so '' is a value the product accepts
  // today. Only the type and the length are gated.
  [
    'instrument_name',
    (v) => isStr(v, MAX_NAME_LEN),
    `instrument_name must be a string of at most ${MAX_NAME_LEN} characters`
  ],
  ['num_strings', (v) => isIntLike(v, 1, MAX_STRINGS), 'num_strings must be an integer 1-12'],
  ['num_frets', (v) => isIntLike(v, 0, 36), 'num_frets must be an integer 0-36'],
  [
    'tuning',
    (v) => isArrayMax(MAX_STRINGS)(v) && v.every((n) => isIntLike(n, 0, 127)),
    'tuning must be an array of at most 12 MIDI note numbers'
  ],
  ['is_fretless', isBoolLike, 'is_fretless must be a boolean'],
  ['capo_fret', (v) => isIntLike(v, 0, 36), 'capo_fret must be an integer 0-36'],
  ['cc_enabled', isBoolLike, 'cc_enabled must be a boolean'],
  ['tab_algorithm', (v) => isStr(v, MAX_NAME_LEN), 'tab_algorithm must be a string'],
  ['cc_string_number', (v) => isIntLike(v, 0, 127), 'cc_string_number must be an integer 0-127'],
  ['cc_string_min', (v) => isIntLike(v, 0, 127), 'cc_string_min must be an integer 0-127'],
  ['cc_string_max', (v) => isIntLike(v, 0, 127), 'cc_string_max must be an integer 0-127'],
  ['cc_string_offset', (v) => isIntLike(v, -127, 127), 'cc_string_offset must be an integer'],
  ['cc_fret_number', (v) => isIntLike(v, 0, 127), 'cc_fret_number must be an integer 0-127'],
  ['cc_fret_min', (v) => isIntLike(v, 0, 127), 'cc_fret_min must be an integer 0-127'],
  ['cc_fret_max', (v) => isIntLike(v, 0, 127), 'cc_fret_max must be an integer 0-127'],
  ['cc_fret_offset', (v) => isIntLike(v, -127, 127), 'cc_fret_offset must be an integer'],
  [
    'frets_per_string',
    (v) => isArrayMax(MAX_STRINGS)(v) || isPlainObject(v),
    'frets_per_string must be an array or an object'
  ],
  [
    'scale_length_mm',
    (v) => isIntLike(v, 100, 2000),
    'scale_length_mm must be an integer between 100 and 2000'
  ],
  ['string_slider_enabled', isBoolLike, 'string_slider_enabled must be a boolean'],
  ['string_sliding_system_enabled', isBoolLike, 'string_sliding_system_enabled must be a boolean'],
  [
    'cc_bow_direction_number',
    (v) => isIntLike(v, 0, 127),
    'cc_bow_direction_number must be an integer 0-127'
  ],
  ['cc_bow_down_value', (v) => isIntLike(v, 0, 127), 'cc_bow_down_value must be an integer 0-127'],
  ['cc_bow_up_value', (v) => isIntLike(v, 0, 127), 'cc_bow_up_value must be an integer 0-127']
];

export const string_instrument_create = {
  custom: fieldRules([
    [
      'device_id',
      (v) => isNonEmptyStr(v, MAX_ID_LEN),
      'device_id must be a non-empty string',
      { required: true }
    ],
    ['channel', isChannel, 'channel must be an integer between 0 and 15'],
    ...instrumentColumnRules
  ])
};

export const string_instrument_update = {
  custom: fieldRules([
    ['id', isIdLike, 'id must be a number or non-empty string', { required: true }],
    ...instrumentColumnRules
  ])
};

/** `id` OR (`device_id` [+ `channel`]) — the handler accepts either. */
const byIdOrDevice = {
  custom: fieldRules(
    [
      ['id', isIdLike, 'id must be a number or non-empty string'],
      ['device_id', (v) => isNonEmptyStr(v, MAX_ID_LEN), 'device_id must be a non-empty string'],
      ['channel', isChannel, 'channel must be an integer between 0 and 15']
    ],
    (data, errors) => {
      if (data.id === undefined && data.device_id === undefined) {
        errors.push('id or device_id is required');
      }
    }
  )
};

export const string_instrument_get = byIdOrDevice;
export const string_instrument_delete = byIdOrDevice;

export const string_instrument_list = {
  custom: fieldRules([
    ['device_id', (v) => isNonEmptyStr(v, MAX_ID_LEN), 'device_id must be a non-empty string']
  ])
};

export const string_instrument_apply_preset = {
  custom: fieldRules([
    [
      'preset_key',
      (v) => isNonEmptyStr(v, MAX_NAME_LEN),
      'preset_key must be a non-empty string',
      { required: true }
    ]
  ])
};

export const string_instrument_create_from_preset = {
  custom: fieldRules([
    [
      'device_id',
      (v) => isNonEmptyStr(v, MAX_ID_LEN),
      'device_id must be a non-empty string',
      { required: true }
    ],
    ['channel', isChannel, 'channel must be an integer between 0 and 15', { required: true }],
    [
      'preset',
      (v) => isNonEmptyStr(v, MAX_NAME_LEN),
      'preset must be a non-empty string',
      { required: true }
    ]
  ])
};

export const tablature_save = {
  custom: fieldRules([
    [
      'midi_file_id',
      isIdLike,
      'midi_file_id must be a number or non-empty string',
      { required: true }
    ],
    [
      'string_instrument_id',
      isIdLike,
      'string_instrument_id must be a number or non-empty string',
      { required: true }
    ],
    ['channel', isChannel, 'channel must be an integer between 0 and 15'],
    [
      'tablature_data',
      isArrayMax(MAX_EVENTS),
      `tablature_data must be an array of at most ${MAX_EVENTS} entries`
    ]
  ])
};

export const tablature_get = {
  custom: fieldRules([
    [
      'midi_file_id',
      isIdLike,
      'midi_file_id must be a number or non-empty string',
      { required: true }
    ],
    ['channel', isChannel, 'channel must be an integer between 0 and 15']
  ])
};

export const tablature_delete = tablature_get;

export const tablature_get_by_file = {
  custom: fieldRules([
    [
      'midi_file_id',
      isIdLike,
      'midi_file_id must be a number or non-empty string',
      { required: true }
    ]
  ])
};

/** Both converters take a bounded event list plus a config OR an instrument id. */
function converterSchema(listField) {
  return {
    custom: fieldRules(
      [
        [
          listField,
          isArrayMax(MAX_EVENTS),
          `${listField} must be an array of at most ${MAX_EVENTS} entries`,
          { required: true }
        ],
        ['instrument_config', isPlainObject, 'instrument_config must be an object'],
        [
          'string_instrument_id',
          isIdLike,
          'string_instrument_id must be a number or non-empty string'
        ]
      ],
      (data, errors) => {
        if (data.instrument_config === undefined && data.string_instrument_id === undefined) {
          errors.push('instrument_config or string_instrument_id is required');
        }
      }
    )
  };
}

export const tablature_convert_from_midi = converterSchema('notes');
export const tablature_convert_to_midi = converterSchema('tab_events');

const schemas = {
  string_instrument_create,
  string_instrument_update,
  string_instrument_get,
  string_instrument_delete,
  string_instrument_list,
  string_instrument_apply_preset,
  string_instrument_create_from_preset,
  tablature_save,
  tablature_get,
  tablature_delete,
  tablature_get_by_file,
  tablature_convert_from_midi,
  tablature_convert_to_midi
};

export default schemas;
