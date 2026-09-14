# Troubleshooting

Common problems and how to fix them. Always start by raising the log level:

```bash
GMBOOP_LOG_LEVEL=debug npm start
```

Logs go to stdout and (if configured) to `GMBOOP_LOG_FILE` with rotation.

## Server Won't Start

| Symptom | Likely cause | Fix |
|---|---|---|
| `EADDRINUSE :::8080` | Another process bound to the port | `sudo ss -ltnp \| grep 8080` then kill it, or change `GMBOOP_SERVER_PORT` |
| `SQLITE_BUSY` / `database is locked` | Stale lock file or another instance | Stop all services (`systemctl stop gmboop`, `pm2 stop all`, `docker compose down`) and retry |
| `Cannot find module 'better-sqlite3'` | Native build for current Node missing | `npm rebuild better-sqlite3` |
| `Migration failed` | Manual schema edits or skipped migration | Restore the latest backup from [`BackupScheduler`](https://github.com/glloq/General-Midi-Boop/blob/main/src/persistence/BackupScheduler.js) and rerun `npm run migrate` |

## USB MIDI Device Not Detected

1. Confirm Linux sees it: `aconnect -l`.
2. Add the user to the audio group: `sudo usermod -aG audio $USER`, then log out/in.
3. Hot-plug in the UI: click **Refresh** or send `device_refresh`.
4. Some USB hubs are flaky on the Pi — try the Pi's built-in ports.

## Bluetooth LE MIDI Pairing Fails

- BlueZ must be running: `systemctl status bluetooth`.
- The runtime user must be allowed on the BlueZ D-Bus interface; the installer adds the necessary polkit rule.
- `GMBOOP_BLE_ENABLED=true` must be set.
- After pairing once, reconnect with `bluetooth_connect` (not `bluetooth_pair`).
- See SysEx identity issues in [`docs/SYSEX_IDENTITY.md`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/SYSEX_IDENTITY.md).

## GPIO UART MIDI Silent

1. UART overlay enabled in `/boot/firmware/config.txt`? See [`docs/GPIO_MIDI_WIRING.md`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/GPIO_MIDI_WIRING.md).
2. Bluetooth disabled or moved off the primary UART? On Pi 3 it shares pins with `mini-uart`.
3. Wiring follows the opto-isolator schema (no direct 5 V into the Pi)?
4. `GMBOOP_SERIAL_ENABLED=true` and the right baud (`31250`)?
5. Verify with `cat /dev/serial0` while a connected keyboard plays — bytes should appear.

## GPIO LED Strip Doesn't Light Up

- The runtime user must be in the `gpio` group.
- `pigpio` typically requires root or the `cap_sys_rawio` capability — the installer handles this.
- Don't run two LED drivers on the same pin (e.g. don't combine `GpioStripDriver` and `GpioLedDriver` on a shared pin).

## Microphone Calibration Fails or Returns High Variance

- Ensure the input device is recognised: `arecord -l`.
- Use a near-field microphone; ambient noise tanks the confidence score.
- Increase the measurement count for noisy environments.
- Lower the detection threshold if onsets are missed; raise it if false positives are detected.
- Source: [`src/audio/DelayCalibrator.js`](https://github.com/glloq/General-Midi-Boop/blob/main/src/audio/DelayCalibrator.js).

## Audio → MIDI Conversion Fails or Disappoints

- **The drop zone only mentions MIDI** — this server has no engine ready. Settings → *Audio → MIDI engines* → Install.
- **`FFMPEG_MISSING`** — `sudo apt install ffmpeg`. GMB reads no audio itself.
- **"This engine needs Python 3.9 – 3.11"** — the pinned TensorFlow publishes no wheel for newer interpreters. Install a supported Python and make it `python3` on `PATH`.
- **The install fails on a TLS or DNS error** — `pip` cannot reach PyPI. The proxy and CA variables must be exported to the GMB *process*, not only to your shell.
- **`OUT_OF_MEMORY`** — the engine peaks around 725 MB; a 1 GB board is killed by the kernel. Use a shorter file, the Fast quality, or a bigger Pi.
- **Far more notes than the music has** — the engine split a sustained or repeated note into fragments. Switch the preset to `clean`, which reconstructs them.
- **Every note sounds slightly sharp** — you are on the `raw` preset, which keeps the engine's own ±1/3-semitone quantisation. `balanced` removes it.
- **The Refresh button seems to do nothing** — it re-checks for real, but the check starts Python and can take tens of seconds on a Pi.
- Detail and measurements in [`docs/AUDIO_TRANSCRIPTION.md`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/AUDIO_TRANSCRIPTION.md), page [[Interface-Audio-To-Midi]].

## Auto-Assignment Picks the Wrong Instrument

- Check that each connected instrument has accurate **note range** and **polyphony** in the Instruments panel — bad capabilities lead to bad scores.
- Use the **preview** button before applying so you hear it first.
- Force a manual override on a channel; the routing is editable.
- Detailed scoring rules in [`docs/AUTO_ASSIGNMENT.md`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/AUTO_ASSIGNMENT.md).

## WebSocket Disconnects

- The server sends heartbeats every ~30 s; clients that miss two heartbeats are dropped. Reverse proxies must allow long-lived WebSocket connections (e.g. nginx `proxy_read_timeout 3600`).
- If `GMBOOP_API_TOKEN` is set, the connection URL must include `?token=…`.

## Frontend Looks Stale After Update

- Hard reload (`Ctrl+Shift+R`) to bypass the browser cache.
- Run `npm run build` and restart if you serve the production bundle.

## Where to Look Next

- `CHANGELOG.md` — known fixed issues per release.
- GitHub Issues — search for the error message before opening a new one.
- `docs/` files referenced from each wiki page above for deep-dive material.
