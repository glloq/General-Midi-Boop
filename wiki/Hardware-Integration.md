# Hardware Integration

Wiring, pairing, and configuring physical MIDI hardware. Source: [`src/transports/`](https://github.com/glloq/General-Midi-Boop/tree/main/src/transports).

## USB MIDI

Plug-and-play. The system polls ALSA for USB MIDI devices and emits `device_connected` events on hot-plug. No configuration required.

If a USB device is not detected:

- Verify with `aconnect -l` on the Pi.
- Check user is in the `audio` group (`sudo usermod -aG audio $USER`).
- See [[Troubleshooting]] for ALSA conflicts.

## Bluetooth LE MIDI

Driven by [`BluetoothManager`](https://github.com/glloq/General-Midi-Boop/blob/main/src/transports/BluetoothManager.js) on top of `node-ble` (BlueZ via D-Bus).

Enable with:

```bash
GMBOOP_BLE_ENABLED=true
```

Pairing flow:

1. `bluetooth_scan` — start a 10 s scan.
2. UI lists discovered MIDI peripherals.
3. `bluetooth_pair` (one-time) → `bluetooth_connect`.
4. SysEx identity is requested automatically; the device appears like any other.

The SysEx identity protocol used to fingerprint and route by manufacturer/model is documented in [`docs/SYSEX_IDENTITY.md`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/SYSEX_IDENTITY.md).

## Network MIDI (RTP-MIDI / RFC 6295)

Driven by [`NetworkManager`](https://github.com/glloq/General-Midi-Boop/blob/main/src/transports/NetworkManager.js) and [`RtpMidiSession`](https://github.com/glloq/General-Midi-Boop/blob/main/src/transports/RtpMidiSession.js). Compatible with macOS Audio MIDI Setup, rtpMIDI on Windows, and other RTP-MIDI peers.

Setup:

1. Open the Network MIDI panel in the UI.
2. Create a session, name it, and choose a UDP port (default 5004).
3. Connect from the peer using the Pi's IP and port.

## Serial MIDI (GPIO UART)

Wiring diagrams, opto-isolation circuits, and overlay configuration are in [`docs/GPIO_MIDI_WIRING.md`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/GPIO_MIDI_WIRING.md).

Highlights:

- **Baud**: 31250 (standard MIDI)
- **Up to 6 hardware UARTs** on Pi 4 with appropriate device-tree overlays in `/boot/firmware/config.txt`
- Full MIDI protocol support: Running Status, SysEx, real-time messages
- Hot-plug detection via udev events

Enable with:

```bash
GMBOOP_SERIAL_ENABLED=true
GMBOOP_SERIAL_BAUD_RATE=31250
```

## Latency Compensation

Each device has a configurable output latency (ms) that the playback engine applies as a negative offset. You can:

- Set it manually in the device settings panel.
- Auto-calibrate using a microphone — see [[Advanced-Topics]] for the full procedure.

## Hand-Position Control (per-device)

Some hardware (motorised keyboards, automated pianos) needs explicit hand placement before notes are sent. The system models this as `hands_config` per instrument, with split-by-pitch or split-by-track modes. See [[Advanced-Topics]] and [`docs/STRING_HAND_POSITION.md`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/STRING_HAND_POSITION.md).

## SysEx Identity

`device_identity_request` triggers an `F0 7E 7F 06 01 F7` Universal SysEx Identity Request. The response is parsed into manufacturer / family / member / version fields and stored on the device row, enabling per-model defaults. The full protocol catalogue is in [`docs/SYSEX_IDENTITY.md`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/SYSEX_IDENTITY.md) (1 200+ lines).
