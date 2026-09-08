/**
 * @file src/api/commands/schemas/validation-policy.js
 * @description The fail-closed policy for WebSocket payload validation, and
 * the visible ledger of everything it still lets through (F-19 / F-03).
 *
 * ## Why this file exists
 *
 * `JsonValidator.validateByCommand` used to answer `{valid:true, errors:[]}`
 * for any command without a schema — 184 of 270 of them. Fuzzing that surface
 * on 2026-09-07 with 1 169 hostile frames measured **49,5 % accepted** and
 * **11,8 % masked internal errors**, the latter raised by the *SQLite driver*:
 * the payload travelled through the API layer and the repository layer and was
 * stopped, when it was stopped at all, by a prepared-statement binding or a
 * `NOT NULL` constraint. The prepared statements held (no SQL injection was
 * possible) but "the last line of defence is the database" is not a contract
 * (docs/audit/2026-09-07/01_API_CONTRACT.md §3.4).
 *
 * The default is now inverted: **a command with no schema is refused**, unless
 * it appears in one of the two lists below. That makes the remaining hole a
 * finite, named, reviewable list instead of an invisible default — and it
 * makes the next command added without a schema fail loudly at its first call
 * instead of inheriting zero validation by construction.
 *
 * ## The two lists
 *
 * - {@link PAYLOAD_BLIND_COMMANDS} — commands registered as `() => fn(app)`.
 *   Their handler never binds the payload parameter, so no payload can reach
 *   anything: there is nothing to validate. This is a deliberate, permanent
 *   category, and it is **verified**, not asserted —
 *   `tests/audit/r3-fail-closed.test.js` loads the real registry and fails if
 *   any listed command has a handler of arity > 0.
 *
 * - {@link PENDING_SCHEMA_COMMANDS} — the debt: commands that DO read their
 *   payload and still have no schema. **This list may only ever shrink.**
 *   `scripts/audit/command-inventory.mjs --check` enforces that in CI
 *   (see `.github/workflows/ci.yml`).
 *
 * At the time of writing the debt list is empty: all 198 payload-taking
 * commands carry a schema.
 */

/**
 * Commands whose registered handler takes no payload argument
 * (`registry.register('x', () => fn(app))`). Grouped by declaring module and
 * sorted, so a diff on this file reads as "which module changed".
 * @type {Set<string>}
 */
export const PAYLOAD_BLIND_COMMANDS = new Set([
  // BluetoothCommands.js
  'ble_paired',
  'ble_power_off',
  'ble_power_on',
  'ble_scan_stop',
  'ble_status',
  // DeviceCommands.js
  'device_list',
  'device_refresh',
  // FileCommands.js
  'file_folders_get',
  'file_reanalyze_all',
  'file_reanalyze_check',
  'midi_categories_list',
  'midi_instruments_list',
  // HotspotCommands.js
  'hotspot_disable',
  'hotspot_enable',
  'hotspot_get_config',
  'hotspot_status',
  'wifi_disconnect',
  'wifi_list_saved',
  'wifi_scan',
  // InstrumentLightCommands.js
  'instrument_light_list',
  // InstrumentSettingsCommands.js
  'instrument_list_capabilities',
  'instrument_list_connected',
  'instrument_list_registered',
  'instrument_types_list',
  // LatencyCommands.js
  'calibrate_list_alsa_devices',
  'calibrate_monitor_stop',
  'latency_export',
  'latency_list',
  'latency_recommendations',
  'tuner_list_instruments',
  'tuner_monitor_stop',
  // LightingCommands.js
  'lighting_all_off',
  'lighting_blackout',
  'lighting_bpm_get',
  'lighting_bpm_tap',
  'lighting_device_list',
  'lighting_dmx_profiles',
  'lighting_effect_list',
  'lighting_get_enabled',
  'lighting_group_list',
  'lighting_preset_list',
  // LoopArrangementCommands.js
  'arrangement_list',
  // LoopCommands.js
  'loop_list',
  // PlaybackControlCommands.js
  'playback_pause',
  'playback_resume',
  'playback_status',
  'playback_stop',
  // PlaybackRoutingCommands.js
  'playback_clear_channel_routing',
  'playback_get_channels',
  // PlaylistCommands.js
  'playlist_list',
  'playlist_next',
  'playlist_previous',
  'playlist_status',
  'playlist_stop',
  // RoutingCommands.js
  'monitor_start_all',
  'monitor_stop_all',
  'route_clear_all',
  'route_list',
  // SerialCommands.js
  'serial_list',
  'serial_scan',
  'serial_status',
  // SessionCommands.js
  'session_list',
  // StringInstrumentCommands.js
  'string_instrument_get_presets',
  'string_instrument_get_scale_length_presets',
  // SystemCommands.js
  'system_check_update',
  'system_clear_logs',
  'system_info',
  'system_reboot',
  'system_restart',
  'system_shutdown',
  'system_status',
  // VirtualInstrumentCommands.js
  'virtual_list'
]);

/**
 * Commands that read a payload but have no schema yet. THE DEBT.
 *
 * Adding a name here weakens the fail-closed guarantee for that command, so it
 * is a deliberate, reviewable act — and the CI ratchet refuses any commit that
 * makes this list longer than the value recorded in
 * `scripts/audit/schema-coverage.baseline.json`.
 * @type {Set<string>}
 */
export const PENDING_SCHEMA_COMMANDS = new Set([]);

/**
 * @param {string} command
 * @returns {boolean} True when the command is allowed to run without a schema.
 */
export function isExemptFromSchema(command) {
  return PAYLOAD_BLIND_COMMANDS.has(command) || PENDING_SCHEMA_COMMANDS.has(command);
}

/**
 * Error returned for a command that is neither covered by a schema nor
 * exempt. Phrased for the developer who will read it in a browser console
 * five minutes after adding a command and forgetting its schema.
 * @type {string}
 */
export const NO_SCHEMA_ERROR =
  'no payload schema is declared for this command (validation is fail-closed): ' +
  'add one in src/api/commands/schemas/';
