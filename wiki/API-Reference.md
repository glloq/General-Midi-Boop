# API Reference

Complete command and parameter list lives in [`docs/API.md`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/API.md). This page is the index — use it to navigate.

## Transport

All commands travel over **WebSocket** as JSON.

```json
// Request
{ "command": "device_list", "id": "abc-123" }

// Response
{ "type": "response", "id": "abc-123", "data": { /* ... */ } }
```

The `id` correlates request and response. Asynchronous broadcasts (events) arrive as `{ "type": "event", "name": "...", "data": ... }` without an `id`.

## Authentication

When `GMBOOP_API_TOKEN` is set:

- WebSocket: connect with `ws://host:port?token=YOUR_TOKEN`
- HTTP: send `Authorization: Bearer YOUR_TOKEN`

`GET /api/health` is always public.

## REST Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | No | Liveness probe (status, version, uptime) |
| GET | `/api/status` | Yes | Device, route, file counts; memory |
| GET | `/api/metrics` | Yes | Prometheus-compatible metrics |
| POST | `/api/files` | Yes | Upload MIDI file (raw binary body) |
| GET | `/api/files/:id/blob` | Yes | Download MIDI file by content hash |

(File upload/download moved to HTTP in v6; the legacy `file_upload` WebSocket command is gone.)

## Command Modules (267 commands across 24 modules)

| Module | Count | Examples |
|---|---|---|
| **Lighting** | 38 | `lighting_device_list`, `lighting_device_add`, `lighting_rule_list`, `lighting_effect_start`, `lighting_scene_apply` |
| **Routing** | 21 | `route_create`, `route_delete`, `route_list`, `route_enable`, `route_info`, `filter_set` |
| **File Management** | 21 | `file_list`, `file_read`, `file_write`, `file_delete`, `file_save_as`, `file_filter`, `file_export` |
| **Playback** | 23 | `playback_start`, `playback_stop`, `playback_get_channels`, `playback_set_channel_routing`, `playback_mute_channel` |
| **Latency** | 16 | `latency_measure`, `latency_set`, `latency_get`, `latency_list`, `latency_auto_calibrate` |
| **String Instruments** | 15 | `string_instrument_create`, `string_instrument_list`, `string_instrument_get_presets`, `string_instrument_update` |
| **Playlists** | 15 | `playlist_create`, `playlist_list`, `playlist_add_file`, `playlist_remove_file` |
| **Loop Arrangements** | 11 | `arrangement_create`, `arrangement_list`, `arrangement_add_track`, `arrangement_update` |
| **Instrument Settings** | 11 | `instrument_update_settings`, `instrument_get_settings`, `instrument_update_capabilities`, `instrument_list_registered` |
| **System** | 10 | `system_status`, `system_info`, `system_restart`, `system_update`, `system_check_update` |
| **Wi-Fi Hotspot** | 10 | `hotspot_get_config`, `hotspot_update_config`, `hotspot_status`, `hotspot_enable`, `wifi_scan` |
| **Bluetooth** | 9 | `ble_scan_start`, `ble_scan_stop`, `ble_connect`, `ble_disconnect`, `ble_forget`, `ble_paired` |
| **MIDI Messages** | 8 | `midi_send`, `midi_send_note`, `midi_send_cc`, `midi_send_pitchbend`, `midi_panic`, `midi_all_notes_off` |
| **Device Management** | 8 | `device_list`, `device_refresh`, `device_info`, `device_set_properties`, `device_enable`, `device_identity_request` |
| **Virtual Instruments** | 7 | `virtual_create`, `virtual_delete`, `virtual_list`, `instrument_create_virtual`, `instrument_add_to_device` |
| **Sessions** | 6 | `session_save`, `session_load`, `session_list`, `session_delete`, `session_export`, `session_import` |
| **Serial / GPIO MIDI** | 6 | `serial_scan`, `serial_list`, `serial_open`, `serial_close`, `serial_status`, `serial_set_enabled` |
| **Presets** | 6 | `preset_save`, `preset_load`, `preset_list`, `preset_delete`, `preset_rename`, `preset_export` |
| **Instrument Lighting** | 6 | `instrument_light_get`, `instrument_light_set`, `instrument_light_list`, `instrument_light_test`, `instrument_light_all_off` |
| **Loops** | 5 | `loop_create`, `loop_list`, `loop_get`, `loop_update`, `loop_delete` |
| **Instrument Voices** | 5 | `instrument_voice_list`, `instrument_voice_create`, `instrument_voice_update`, `instrument_voice_replace` |
| **Network MIDI (RTP)** | 4 | `network_scan`, `network_connected_list`, `network_connect`, `network_disconnect` |
| **Bank Effects** | 4 | `bank_effects_get`, `bank_effects_list`, `bank_effects_update`, `bank_effects_reset` |
| **Device Settings** | 2 | `device_get_settings`, `device_update_settings` |

Source modules: [`src/api/commands/`](https://github.com/glloq/General-Midi-Boop/tree/main/src/api/commands).
The `playback_*` commands are wired by the [`PlaybackCommands`](https://github.com/glloq/General-Midi-Boop/blob/main/src/api/commands/PlaybackCommands.js)
aggregator, which delegates to the sub-modules under [`src/midi/playback/commands/`](https://github.com/glloq/General-Midi-Boop/tree/main/src/midi/playback/commands).

## EventBus Events

Common events broadcast to subscribed WebSocket clients:

- `midi_message` — MIDI in/out
- `device_connected`, `device_disconnected`
- `playback_started`, `playback_stopped`, `playback_position`
- `file_uploaded`
- `error`

## Adding a Command

1. Create or edit a module in [`src/api/commands/`](https://github.com/glloq/General-Midi-Boop/tree/main/src/api/commands).
2. Export `register(registry, app)` and bind handlers with `registry.register('my_command', handler)`.
3. The [`CommandRegistry`](https://github.com/glloq/General-Midi-Boop/blob/main/src/api/CommandRegistry.js) auto-discovers every `*.js` in the directory on startup.
4. Add the payload schema in the matching `schemas/*.schemas.js`, add tests under [`tests/`](https://github.com/glloq/General-Midi-Boop/tree/main/tests), and document the parameters in [`docs/API.md`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/API.md).

## Error Shape

```json
{
  "type": "error",
  "id": "abc-123",
  "error": {
    "code": "DEVICE_NOT_FOUND",
    "message": "No device with id 'piano-1'",
    "details": { /* ... */ }
  }
}
```

Error classes are defined in [`src/core/errors/`](https://github.com/glloq/General-Midi-Boop/tree/main/src/core/errors).
