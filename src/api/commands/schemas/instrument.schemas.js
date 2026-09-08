/**
 * @file src/api/commands/schemas/instrument.schemas.js
 * @description Declarative validation schemas for the instrument surface:
 * `instrument_*` settings/capabilities (InstrumentSettingsCommands),
 * secondary voices (InstrumentVoiceCommands), CC lighting
 * (InstrumentLightCommands) and virtual instruments
 * (VirtualInstrumentCommands). Consumed by
 * `JsonValidator.validateByCommand`.
 *
 * Measured before this backfill (01_API_CONTRACT.md §3.3-3.4):
 * `instrument_update_settings` reached `INSERT` with no `deviceId` at all
 * (`NOT NULL constraint failed: instruments_latency.device_id`), and
 * `instrument_delete` produced a raw `TypeError`
 * (`data.deviceId.startsWith is not a function`) masked as "Internal server
 * error".
 *
 * These schemas deliberately do NOT restate the deep, field-by-field checks
 * the handlers already perform (`_validateSettingsFields`,
 * `_validatePolyphony`, `validateVoicePayload`, `validateHandsConfigPayload`,
 * …). Duplicating them would change well-tested error messages for no gain.
 * What is added is the layer that was missing: the identity fields must be
 * present and scalar, and every value must be of a type the handler's
 * `parseInt`/`parseFloat` normalisation can actually consume.
 */
import {
  fieldRules,
  isIdLike,
  isIntLike,
  isBoolLike,
  isChannel,
  isStr,
  isNonEmptyStr,
  isPlainObject,
  isArrayMax,
  MAX_ID_LEN,
  MAX_NAME_LEN
} from './helpers.js';

/** Upper bound on a single `instrument_save_all` / `voice_replace` batch. */
const MAX_VOICES = 64;

const deviceIdRule = [
  'deviceId',
  (v) => isNonEmptyStr(v, MAX_ID_LEN),
  'deviceId must be a non-empty string',
  { required: true }
];
const channelRule = ['channel', isChannel, 'channel must be between 0 and 15'];

/**
 * Settings columns shared by `instrument_update_settings` and
 * `instrument_save_all`. Range checks that the handler already performs are
 * intentionally left to it; only the type gate is enforced here.
 */
const settingsRules = [
  ['custom_name', (v) => isStr(v, 255), 'custom_name must not exceed 255 characters'],
  ['name', (v) => isStr(v, 255), 'name must be a string of at most 255 characters'],
  ['mac_address', (v) => isStr(v, 64), 'mac_address must be a string'],
  ['usb_serial_number', (v) => isStr(v, MAX_ID_LEN), 'usb_serial_number must be a string'],
  ['sync_delay', (v) => isIntLike(v, -5000, 5000), 'sync_delay must be an integer'],
  ['gm_program', (v) => isIntLike(v, 0, 255), 'gm_program must be an integer'],
  ['octave_mode', (v) => isNonEmptyStr(v, MAX_NAME_LEN), 'octave_mode must be a string'],
  ['scale_root', (v) => isIntLike(v, 0, 11), 'scale_root must be a pitch class 0..11'],
  ['comm_timeout', (v) => isIntLike(v, 100, 30000), 'comm_timeout must be an integer'],
  ['omni_mode', isBoolLike, 'omni_mode must be a boolean'],
  ['lighting_enabled', isBoolLike, 'lighting_enabled must be a boolean'],
  ['voices_share_notes', isBoolLike, 'voices_share_notes must be a boolean'],
  ['pitch_bend_enabled', isBoolLike, 'pitch_bend_enabled must be a boolean'],
  ['custom_sf2_id', isIdLike, 'custom_sf2_id must be a number or non-empty string']
];

/**
 * Capability columns shared by `instrument_update_capabilities` and
 * `instrument_save_all`. `supported_ccs` / `selected_notes` go through
 * `parseValidMidiList`, which accepts an array or a comma-separated string.
 * The four `*_config` blobs have dedicated validators in the handler and are
 * deliberately absent here.
 */
const capabilityRules = [
  ['note_range_min', (v) => isIntLike(v, 0, 127), 'note_range_min must be a MIDI note 0-127'],
  ['note_range_max', (v) => isIntLike(v, 0, 127), 'note_range_max must be a MIDI note 0-127'],
  [
    'supported_ccs',
    (v) => isArrayMax(128)(v) || isStr(v, 1024),
    'supported_ccs must be an array or a comma-separated string'
  ],
  [
    'selected_notes',
    (v) => isArrayMax(128)(v) || isStr(v, 1024),
    'selected_notes must be an array or a comma-separated string'
  ],
  ['note_selection_mode', (v) => isNonEmptyStr(v, 32), 'note_selection_mode must be a string'],
  ['polyphony', (v) => isIntLike(v, 1, 128), 'polyphony must be an integer between 1 and 128'],
  ['capabilities_source', (v) => isNonEmptyStr(v, 32), 'capabilities_source must be a string'],
  ['min_note_interval', (v) => isIntLike(v, 0, 5000), 'min_note_interval must be an integer'],
  ['min_note_duration', (v) => isIntLike(v, 0, 5000), 'min_note_duration must be an integer']
];

export const instrument_update_settings = {
  custom: fieldRules([deviceIdRule, channelRule, ...settingsRules])
};

export const instrument_get_settings = {
  custom: fieldRules([deviceIdRule, channelRule])
};

export const instrument_get_capabilities = {
  custom: fieldRules([deviceIdRule, channelRule])
};

export const instrument_update_capabilities = {
  custom: fieldRules([deviceIdRule, channelRule, ...capabilityRules])
};

export const instrument_delete = {
  custom: fieldRules([deviceIdRule, channelRule])
};

export const instrument_save_all = {
  custom: fieldRules([
    deviceIdRule,
    channelRule,
    ...settingsRules,
    ...capabilityRules,
    ['voices', isArrayMax(MAX_VOICES), `voices must be an array of at most ${MAX_VOICES} entries`],
    ['string_instrument', isPlainObject, 'string_instrument must be an object']
  ])
};

export const instrument_type_detect = {
  custom: fieldRules([
    ['gm_program', (v) => isIntLike(v, 0, 255), 'gm_program must be an integer', { required: true }]
  ])
};

// ── Secondary voices ────────────────────────────────────────────────
// `_validateIdentity` already rejects a missing deviceId/channel with its own
// message; the value rules live in `validateVoicePayload`. What is added here
// is the type gate on the identity pair and the batch cap.

const voiceIdentityRules = [
  ['deviceId', (v) => isNonEmptyStr(v, MAX_ID_LEN), 'deviceId must be a non-empty string'],
  channelRule
];

export const instrument_voice_list = { custom: fieldRules(voiceIdentityRules) };
export const instrument_voice_create = {
  custom: fieldRules([...voiceIdentityRules, ...capabilityRules])
};
export const instrument_voice_update = {
  custom: fieldRules([
    ['id', isIdLike, 'id must be a number or non-empty string', { required: true }],
    ...capabilityRules
  ])
};
export const instrument_voice_delete = {
  custom: fieldRules([
    ['id', isIdLike, 'id must be a number or non-empty string', { required: true }]
  ])
};
export const instrument_voice_replace = {
  custom: fieldRules([
    ...voiceIdentityRules,
    ['voices', isArrayMax(MAX_VOICES), `voices must be an array of at most ${MAX_VOICES} entries`]
  ])
};

// ── CC-based instrument lighting ────────────────────────────────────

const lightTargetRules = [deviceIdRule, ['channel', isChannel, 'channel must be 0-15']];

export const instrument_light_get = { custom: fieldRules(lightTargetRules) };
export const instrument_light_test = { custom: fieldRules(lightTargetRules) };
export const instrument_light_all_off = { custom: fieldRules(lightTargetRules) };
export const instrument_light_set = {
  custom: fieldRules([...lightTargetRules, ['state', isPlainObject, 'state object is required']])
};
export const instrument_light_set_supported = {
  custom: fieldRules([
    ...lightTargetRules,
    ['supported_mask', (v) => isIntLike(v, 0, 31), 'supported_mask must be an integer 0-31'],
    ['brightness_mode', (v) => isIntLike(v, 0, 1), 'brightness_mode must be 0 or 1'],
    [
      'supported_effects',
      (v) => isIntLike(v, 0, 1023),
      'supported_effects must be an integer 0-1023'
    ]
  ])
};

// ── Virtual instruments ─────────────────────────────────────────────

export const instrument_create_virtual = {
  custom: fieldRules([
    [
      'preset',
      (v) => isNonEmptyStr(v, MAX_NAME_LEN) || isPlainObject(v),
      'preset must be a string or an object'
    ],
    ['name', (v) => isStr(v, 255), 'name must be a string'],
    channelRule,
    ...capabilityRules
  ])
};

export const instrument_add_to_device = {
  custom: fieldRules([
    deviceIdRule,
    channelRule,
    ['name', (v) => isStr(v, 255), 'name must be a string'],
    ...capabilityRules
  ])
};

export const instrument_list_by_device = { custom: fieldRules([deviceIdRule]) };

export const virtual_instrument_toggle = {
  custom: fieldRules([deviceIdRule, ['enabled', isBoolLike, 'enabled must be a boolean']])
};

const schemas = {
  instrument_update_settings,
  instrument_get_settings,
  instrument_get_capabilities,
  instrument_update_capabilities,
  instrument_delete,
  instrument_save_all,
  instrument_type_detect,
  instrument_voice_list,
  instrument_voice_create,
  instrument_voice_update,
  instrument_voice_delete,
  instrument_voice_replace,
  instrument_light_get,
  instrument_light_test,
  instrument_light_all_off,
  instrument_light_set,
  instrument_light_set_supported,
  instrument_create_virtual,
  instrument_add_to_device,
  instrument_list_by_device,
  virtual_instrument_toggle
};

export default schemas;
