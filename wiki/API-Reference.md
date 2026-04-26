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

## Command Modules (146 commands across 15 modules)

| Module | Count | Examples |
|---|---|---|
| **Device Management** | 21 | `device_list`, `device_info`, `device_set_properties`, `device_enable`, `instrument_update_settings`, `virtual_create` |
| **MIDI Messages** | 8 | `midi_send_note`, `midi_send_cc`, `midi_send_pitchbend`, `midi_panic`, `midi_all_notes_off`, `midi_reset` |
| **File Management** | 14 | `file_list`, `file_read`, `file_write`, `file_delete`, `file_search`, `file_filter`, `file_export` |
| **Playback** | 16 | `playback_start`, `playback_pause`, `playback_stop`, `playback_seek`, `playback_set_tempo` |
| **Routing** | 12 | `routing_set`, `routing_delete`, `routing_list`, `routing_get` |
| **Auto-Assignment** | 8 | `auto_assign_suggest`, `auto_assign_apply`, `auto_assign_preview` |
| **Lighting** | 15 | `lighting_list_drivers`, `lighting_set_color`, `lighting_effect_start` |
| **Bluetooth** | 6 | `bluetooth_scan`, `bluetooth_pair`, `bluetooth_connect` |
| **Serial / GPIO MIDI** | 7 | `serial_list`, `serial_open`, `serial_close` |
| **Playlists** | 10 | `playlist_create`, `playlist_add_file`, `playlist_remove_file` |
| **String Instruments** | 8 | `string_get_presets`, `string_set_tuning` |
| **Sessions** | 5 | `session_load`, `session_save` |
| **Bank Effects** | 5 | `bank_list`, `bank_select` |
| **Virtual Instruments** | 6 | `virtual_create`, `virtual_delete`, `virtual_list` |
| **Instrument Voices** | 4 | `instrument_voice_list`, `instrument_voice_select` |

Source modules: [`src/api/commands/`](https://github.com/glloq/General-Midi-Boop/tree/main/src/api/commands).

## EventBus Events

Common events broadcast to subscribed WebSocket clients:

- `midi_message` — MIDI in/out
- `device_connected`, `device_disconnected`
- `playback_started`, `playback_stopped`, `playback_position`
- `file_uploaded`
- `error`

## Adding a Command

1. Create or edit a module in [`src/api/commands/`](https://github.com/glloq/General-Midi-Boop/tree/main/src/api/commands).
2. Export `{ commands: { my_command: handler } }`.
3. The [`CommandRegistry`](https://github.com/glloq/General-Midi-Boop/blob/main/src/api/CommandRegistry.js) auto-discovers it on startup.
4. Add tests under [`tests/unit/`](https://github.com/glloq/General-Midi-Boop/tree/main/tests/unit) and document the parameters in [`docs/API.md`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/API.md).

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
