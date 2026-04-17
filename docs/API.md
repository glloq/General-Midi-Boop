# API Reference - Ma-est-tro v5.0.0

## Transport

All commands are sent via **WebSocket** as JSON messages:

```json
{ "command": "device_list", "id": "unique-request-id" }
```

Responses include the matching `id` for correlation:

```json
{ "type": "response", "id": "unique-request-id", "data": { ... } }
```

### Authentication

When `MAESTRO_API_TOKEN` is set, connect with:
- **WebSocket**: `ws://host:port?token=YOUR_TOKEN`
- **HTTP**: `Authorization: Bearer YOUR_TOKEN` header

### REST Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | No | Health check (status, version, uptime) |
| GET | `/api/status` | Yes | Device/route/file counts, memory |
| GET | `/api/metrics` | Yes | Prometheus-compatible metrics |

---

## Commands (146 total)

### Device Management (21 commands)

| Command | Description | Parameters |
|---------|-------------|------------|
| `device_list` | List all connected devices with settings | — |
| `device_refresh` | Refresh device list from hardware | — |
| `device_info` | Get device details | `deviceId` |
| `device_set_properties` | Set device properties | `deviceId`, properties |
| `device_enable` | Enable/disable device | `deviceId`, `enabled` |
| `device_identity_request` | Request SysEx identity | `deviceName`, `deviceId?` |
| `device_save_sysex_identity` | Save SysEx identity | `deviceId`, `channel?`, `identity` |
| `instrument_update_settings` | Update instrument settings | `deviceId`, `channel`, settings |
| `instrument_get_settings` | Get instrument settings | `deviceId`, `channel?` |
| `instrument_update_capabilities` | Update instrument capabilities | `deviceId`, `channel`, capabilities |
| `instrument_get_capabilities` | Get instrument capabilities | `deviceId`, `channel?` |
| `instrument_list_capabilities` | List all instrument capabilities | — |
| `instrument_list_registered` | List registered instruments | — |
| `instrument_list_connected` | List connected instruments | — |
| `instrument_delete` | Delete instrument | `deviceId`, `channel?` |
| `instrument_add_to_device` | Add instrument to device channel | `deviceId`, `channel`, config |
| `instrument_list_by_device` | List instruments on device | `deviceId` |
| `instrument_create_virtual` | Create virtual instrument | `name`, `type`, `channel`, config |
| `virtual_create` | Create virtual device | `name` |
| `virtual_delete` | Delete virtual device | `deviceId` |
| `virtual_list` | List virtual devices | — |

### MIDI Messages (8 commands)

| Command | Description | Parameters |
|---------|-------------|------------|
| `midi_send` | Send raw MIDI message | `deviceId`, `type`, message data |
| `midi_send_note` | Send note on/off | `deviceId`, `channel`, `note`, `velocity`, `duration?` |
| `midi_send_cc` | Send Control Change | `deviceId`, `channel`, `controller`, `value` |
| `midi_send_pitchbend` | Send Pitch Bend | `deviceId`, `channel`, `value` |
| `midi_panic` | All sound off on all channels | `deviceId` |
| `midi_all_notes_off` | All notes off on all channels | `deviceId` |
| `midi_reset` | MIDI System Reset | `deviceId` |

### File Management (20 commands)

| Command | Description | Parameters |
|---------|-------------|------------|
| `file_upload` | Upload MIDI file | `filename`, `data` |
| `file_list` | List files in folder | `folder?` (default '/') |
| `file_metadata` | Get file metadata | `fileId` |
| `file_read` | Read MIDI file for editing | `fileId` |
| `file_write` | Write MIDI file from editor | `fileId`, `midiData` |
| `file_delete` | Delete file | `fileId` |
| `file_save_as` | Save with new name | `fileId`, `newFilename`, `midiData` |
| `file_rename` | Rename file | `fileId`, `newFilename` |
| `file_move` | Move file to folder | `fileId`, `folder` |
| `file_duplicate` | Duplicate file | `fileId` |
| `file_export` | Export file | `fileId` |
| `file_search` | Search files | `query` |
| `file_filter` | Advanced filtering | Multiple filter criteria |
| `file_channels` | Get MIDI channels | `fileId` |
| `file_reanalyze_all` | Reanalyze all files | — |
| `file_routing_status` | Get routing status | `fileId` |
| `midi_instruments_list` | List distinct instruments | — |
| `midi_categories_list` | List instrument categories | — |

### Playback (21 commands)

| Command | Description | Parameters |
|---------|-------------|------------|
| `playback_start` | Start MIDI playback | `fileId`, `outputDevice?` |
| `playback_stop` | Stop playback | — |
| `playback_pause` | Pause playback | — |
| `playback_resume` | Resume playback | — |
| `playback_seek` | Seek to position | `position` |
| `playback_status` | Get playback status | — |
| `playback_set_loop` | Enable/disable loop | `enabled` |
| `playback_get_channels` | Get channel routing | — |
| `playback_set_channel_routing` | Route channel to device | `channel`, `deviceId`, `targetChannel?` |
| `playback_clear_channel_routing` | Clear all routings | — |
| `playback_mute_channel` | Mute/unmute channel | `channel`, `muted` |
| `analyze_channel` | Analyze MIDI channel | `fileId`, `channel` |
| `generate_assignment_suggestions` | Auto-assignment suggestions | `fileId`, `topN?`, `minScore?` |
| `apply_assignments` | Apply auto-assignments | `originalFileId`, `assignments`, `createAdaptedFile?` |
| `validate_instrument_capabilities` | Validate capabilities | — |
| `get_instrument_defaults` | Get default capabilities | `instrumentId`, `type?` |
| `update_instrument_capabilities` | Update capabilities | `updates` |
| `get_file_routings` | Get saved routings | `fileId` |
| `playback_set_tempo` | Set tempo | *(planned)* |
| `playback_transpose` | Transpose | *(planned)* |
| `playback_set_volume` | Set volume | *(planned)* |

### Routing (17 commands)

| Command | Description | Parameters |
|---------|-------------|------------|
| `route_create` | Create MIDI route | Route config |
| `route_delete` | Delete route | `routeId` |
| `route_list` | List all routes | — |
| `route_enable` | Enable/disable route | `routeId`, `enabled` |
| `route_info` | Get route info | `routeId` |
| `filter_set` | Set route filter | `routeId`, `filter` |
| `filter_clear` | Clear route filter | `routeId` |
| `channel_map` | Set channel mapping | `routeId`, `mapping` |
| `monitor_start` | Start MIDI monitoring | `deviceId` |
| `monitor_stop` | Stop MIDI monitoring | `deviceId` |
| `route_test` | Test route | `routeId` |
| `route_duplicate` | Duplicate route | `routeId` |
| `route_export` | Export route | `routeId` |
| `route_import` | Import route | `route` |
| `route_clear_all` | Delete all routes | — |
| `file_routing_sync` | Sync file routing to DB | `fileId`, `channels` |
| `file_routing_bulk_sync` | Bulk sync routings | `routings` |

### Bluetooth (9 commands)

| Command | Description | Parameters |
|---------|-------------|------------|
| `ble_scan_start` | Start BLE scan | `duration?` (default 5s), `filter?` |
| `ble_scan_stop` | Stop BLE scan | — |
| `ble_connect` | Connect to device | `address` |
| `ble_disconnect` | Disconnect device | `address` |
| `ble_forget` | Forget/unpair device | `address` |
| `ble_paired` | List paired devices | — |
| `ble_status` | Get adapter status | — |
| `ble_power_on` | Enable Bluetooth | — |
| `ble_power_off` | Disable Bluetooth | — |

### Serial (6 commands)

| Command | Description | Parameters |
|---------|-------------|------------|
| `serial_scan` | Scan serial ports | — |
| `serial_list` | List open ports | — |
| `serial_open` | Open serial port | `path`, `name?`, `direction?` |
| `serial_close` | Close serial port | `path` |
| `serial_status` | Get serial status | — |
| `serial_set_enabled` | Enable/disable serial | `enabled` |

### Network (4 commands)

| Command | Description | Parameters |
|---------|-------------|------------|
| `network_scan` | Scan network devices | `timeout?`, `fullScan?` |
| `network_connected_list` | List connected devices | — |
| `network_connect` | Connect to device | `ip`/`address`, `port?` |
| `network_disconnect` | Disconnect device | `ip`/`address` |

### Latency (10 commands)

| Command | Description | Parameters |
|---------|-------------|------------|
| `latency_measure` | Measure device latency | `deviceId`, `iterations?` |
| `latency_set` | Set latency value | `deviceId`, `latency` |
| `latency_get` | Get latency profile | `deviceId` |
| `latency_list` | List all profiles | — |
| `latency_delete` | Delete profile | `deviceId` |
| `latency_auto_calibrate` | Auto-calibrate | `deviceIds` |
| `latency_recommendations` | Get recommendations | — |
| `latency_export` | Export all profiles | — |
| `calibrate_delay` | Calibrate delay | `deviceId`, `channel`, options |
| `calibrate_list_alsa_devices` | List ALSA devices | — |

### Lighting (35 commands)

| Command | Description | Parameters |
|---------|-------------|------------|
| `lighting_device_list` | List lighting devices | — |
| `lighting_device_add` | Add device | `name`, `type?`, `connection_config`, `led_count`, `enabled` |
| `lighting_device_update` | Update device | `id`, fields |
| `lighting_device_delete` | Delete device | `id` |
| `lighting_device_test` | Test device | `id` |
| `lighting_device_scan` | Scan for devices | `type?`, `subnet?` |
| `lighting_rule_list` | List rules | `device_id?` |
| `lighting_rule_add` | Add rule | `device_id`, `name`, config |
| `lighting_rule_update` | Update rule | `id`, fields |
| `lighting_rule_delete` | Delete rule | `id` |
| `lighting_rule_test` | Test rule | `id` |
| `lighting_rules_export` | Export rules | `device_id?` |
| `lighting_rules_import` | Import rules | `import_data` |
| `lighting_preset_list` | List presets | — |
| `lighting_preset_save` | Save preset | `name` |
| `lighting_preset_load` | Load preset | `id` |
| `lighting_preset_delete` | Delete preset | `id` |
| `lighting_all_off` | All lights off | — |
| `lighting_blackout` | Blackout | — |
| `lighting_effect_start` | Start effect | `device_id`, `effect_type`, options |
| `lighting_effect_stop` | Stop effect | `effect_key` |
| `lighting_effect_list` | List active effects | — |
| `lighting_master_dimmer` | Get/set brightness | `value?` |
| `lighting_group_create` | Create group | `name`, `device_ids` |
| `lighting_group_delete` | Delete group | `name` |
| `lighting_group_list` | List groups | — |
| `lighting_group_color` | Set group color | `name`, color params |
| `lighting_group_off` | Turn group off | `name` |
| `lighting_scene_save` | Save scene | `name`, `device_colors` |
| `lighting_scene_apply` | Apply scene | `scene` |
| `lighting_midi_learn` | MIDI learn mode | — |
| `lighting_bpm_set` | Set effect BPM | `bpm` |
| `lighting_bpm_get` | Get current BPM | — |
| `lighting_bpm_tap` | Tap tempo | — |
| `lighting_led_broadcast` | Toggle LED broadcast | `enabled?` |
| `lighting_dmx_profiles` | List DMX profiles | — |

### String Instruments & Tablature (14 commands)

| Command | Description | Parameters |
|---------|-------------|------------|
| `string_instrument_create` | Create config | `device_id`, `channel`, `instrument_name`, tuning config |
| `string_instrument_update` | Update config | `id`, fields |
| `string_instrument_delete` | Delete config | `id` or `device_id`+`channel` |
| `string_instrument_get` | Get config | `id` or `device_id`+`channel` |
| `string_instrument_list` | List configs | `device_id?` |
| `string_instrument_get_presets` | List tuning presets | — |
| `string_instrument_apply_preset` | Get preset data | `preset_key` |
| `string_instrument_create_from_preset` | Create from preset | `device_id`, `channel`, `preset` |
| `tablature_save` | Save tablature | `midi_file_id`, `string_instrument_id`, `tablature_data` |
| `tablature_get` | Get tablature | `midi_file_id`, `channel?` |
| `tablature_get_by_file` | Get all for file | `midi_file_id` |
| `tablature_delete` | Delete tablature | `midi_file_id`, `channel?` |
| `tablature_convert_from_midi` | MIDI → tablature | `notes`, instrument config |
| `tablature_convert_to_midi` | Tablature → MIDI | `tab_events`, instrument config |

### Sessions & Presets (10 commands)

| Command | Description | Parameters |
|---------|-------------|------------|
| `session_save` | Save session | `name`, `description` |
| `session_load` | Load session | `sessionId` |
| `session_list` | List sessions | — |
| `session_delete` | Delete session | `sessionId` |
| `session_export` | Export session | `sessionId` |
| `session_import` | Import session | `name`, `description`, `data` |
| `preset_save` | Save preset | `name`, `description`, `type`, `data` |
| `preset_load` | Load preset | `presetId` |
| `preset_list` | List presets | `type?` |
| `preset_delete` | Delete preset | `presetId` |

### Playlists (4 commands)

| Command | Description | Parameters |
|---------|-------------|------------|
| `playlist_create` | Create playlist | `name`, `description` |
| `playlist_delete` | Delete playlist | `playlistId` |
| `playlist_list` | List playlists | — |
| `playlist_add_file` | Add file to playlist | `playlistId`, file data |

### System (10 commands)

| Command | Description | Parameters |
|---------|-------------|------------|
| `system_status` | System status | — |
| `system_info` | System info (OS, CPU, memory) | — |
| `system_restart` | Restart application | — |
| `system_shutdown` | Shutdown application | — |
| `system_check_update` | Check for updates | — |
| `system_update` | Perform update | — |
| `system_backup` | Create DB backup | `path?` |
| `system_restore` | Restore from backup | *(planned)* |
| `system_logs` | Get recent logs | `data?` |
| `system_clear_logs` | Clear logs | — |

---

## Events (WebSocket Broadcasts)

Events are pushed to all connected clients:

```json
{ "type": "event", "event": "device_connected", "data": { ... }, "timestamp": 1234567890 }
```

| Event | Description |
|-------|-------------|
| `connected` | Welcome message on connection |
| `device_connected` | MIDI device connected |
| `device_disconnected` | MIDI device disconnected |
| `midi_message` | MIDI message received |
| `midi_routed` | MIDI message routed |
| `playback_started` | Playback started |
| `playback_stopped` | Playback stopped |
| `playback_position` | Playback position update |
| `file_uploaded` | File uploaded |
| `error` | Application error |
