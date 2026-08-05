# Instrument Developer Guide — GMBoop Instrument Recognition (v2)

This page is for builders of DIY MIDI instruments (Arduino, Teensy, ESP32, RP2040, STM32, custom firmware, …) who want their device to be **recognised** — and optionally **auto-configured** — by Général Midi Boop.

Full technical specification: [`docs/SYSEX_IDENTITY.md`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/SYSEX_IDENTITY.md). This guide is the firmware-side companion; the spec is authoritative when the two disagree.

> **This replaces the v1 protocol** (52-byte identity, blocks 5/6/7, feature-flag bitmask). There is no compatibility path — v1 firmware was draft. If you implemented v1, see [Migrating from v1](#migrating-from-v1).

---

## The idea

GMBoop can already configure an instrument by hand. So the protocol's job is **not** to transmit capabilities — it is to **recognise the instrument reliably**. Everything else is an optimisation.

| Level | Your firmware… | GMBoop… |
|-------|----------------|---------|
| **0 — Recognition** | answers block 1 (24 bytes) | matches this exact exemplar to its saved config, or asks once |
| **1 — Descriptor** | also serves a JSON capability descriptor | auto-configures, and follows live changes |

**Level 0 fits any MCU** — a few dozen lines, no JSON, no RAM. **Level 1** is only worth it for instruments whose configuration **changes at runtime** (typically those with an embedded web page).

There is no per-model profile library. `model` is a display label; GMBoop derives **no** capability from it.

**Protocol**: custom SysEx, MIDI Educational/Development manufacturer ID `0x7D`. Every message shares the header:

```
F0 7D 00 <block_id> <direction> [data...] F7
```

| Block | ID | Purpose |
|-------|----|---------|
| Handshake | `0x01` | recognition (24 bytes) — **the only required block** |
| Descriptor transfer | `0x10` | serve the JSON descriptor in chunks (level 1) |
| Change notification | `0x11` | tell GMBoop the config changed (level 1, optional) |

---

## Block 1 — Handshake (24 bytes)

### Request (GMBoop → device)

```
F0 7D 00 01 00 F7
```

### Response (device → GMBoop)

```
F0 7D 00 01 01 <proto_ver> <instance_id[5]> <firmware[3]>
   <descriptor_size[3]> <revision[5]> <flags> F7
```

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 0–4 | 5 | Header | `F0 7D 00 01 01` |
| 5 | 1 | `proto_ver` | `0x02` |
| 6–10 | 5 | `instance_id` | **Unique per physical exemplar**, 32-bit, 7-bit encoded |
| 11–13 | 3 | `firmware` | `[major, minor, patch]` |
| 14–16 | 3 | `descriptor_size` | Descriptor size in bytes, 7-bit encoded. `0` = level 0 |
| 17–21 | 5 | `revision` | 32-bit revision counter (ETag), 7-bit encoded |
| 22 | 1 | `flags` | bit 0 = HTTP available · bit 1 = push notifications |
| 23 | 1 | End | `F7` |

Total: **exactly 24 bytes**.

### `instance_id` — the one field you must get right

`instance_id` is the pivot of the whole protocol: it is what lets GMBoop reattach a **saved configuration** (tuning, calibration, measured latency, overrides) to the correct physical unit.

**Do not hardcode a shared constant.** Two units flashed with the same binary would report the same id, and GMBoop would apply one unit's tuning and calibration to the other. Derive it from a unique hardware source:

| Platform | Source |
|----------|--------|
| ESP32 | MAC address |
| RP2040, STM32 | factory-burned unique id |
| Teensy | serial number |
| AVR with no hardware id | 32 random bits drawn on first boot, stored in EEPROM |

`revision` is an ETag: GMBoop only re-fetches the descriptor when it changes. Bump it on **every** configuration change. For level 0, leave it `0`.

### 7-bit encoding

MIDI SysEx requires every data byte to have MSB = 0 (values 0–127). A 32-bit value is spread across 5 bytes; `descriptor_size` uses 3 bytes (21 bits, ample).

```c
// instance_id / revision — full 32 bits (the 5th byte carries bits 28–31).
void enc32(uint32_t v, uint8_t* out) {
    out[0] = (v      ) & 0x7F;
    out[1] = (v >>  7) & 0x7F;
    out[2] = (v >> 14) & 0x7F;
    out[3] = (v >> 21) & 0x7F;
    out[4] = (v >> 28) & 0x0F;   // NB: 0x0F (4 bits), not 0x07 — keep bit 31
}
// descriptor_size — 21 bits over 3 bytes.
void enc21(uint32_t v, uint8_t* out) {
    out[0] = (v      ) & 0x7F;
    out[1] = (v >>  7) & 0x7F;
    out[2] = (v >> 14) & 0x7F;
}
```

### Arduino / ESP32 example (level 0)

```c
#include <WiFi.h>

uint32_t instanceId() {                 // derive from the MAC — unique per board
    uint8_t mac[6];
    WiFi.macAddress(mac);
    return ((uint32_t)mac[2] << 24) | ((uint32_t)mac[3] << 16) |
           ((uint32_t)mac[4] << 8)  |  (uint32_t)mac[5];
}

void handleHandshake() {
    uint8_t r[24];
    int p = 0;
    r[p++] = 0xF0; r[p++] = 0x7D; r[p++] = 0x00; r[p++] = 0x01; r[p++] = 0x01;
    r[p++] = 0x02;                       // proto_ver
    enc32(instanceId(), &r[p]); p += 5;  // instance_id
    r[p++] = 1; r[p++] = 0; r[p++] = 0;  // firmware 1.0.0
    enc21(0, &r[p]); p += 3;             // descriptor_size = 0  → level 0
    enc32(0, &r[p]); p += 5;             // revision = 0
    r[p++] = 0x00;                       // flags: no HTTP, no push
    r[p++] = 0xF7;
    usbMIDI.sendSysEx(24, r);            // exactly 24 bytes
}
```

For **level 1**, set `descriptor_size` to the byte length of your JSON descriptor, `revision` to its current version, and `flags` bit 0 if you also serve it over HTTP.

### Block 1 checklist

- [ ] Detect `F0 7D 00 01 00 F7` (6 bytes)
- [ ] Reply header `F0 7D 00 01 01`, `proto_ver = 0x02`
- [ ] `instance_id`: derived from a **unique hardware source**, 7-bit encoded (5 bytes)
- [ ] `firmware`: 3 bytes `[major, minor, patch]`
- [ ] `descriptor_size`: 3 bytes (`0` for level 0)
- [ ] `revision`: 5 bytes (`0` for level 0)
- [ ] `flags`: 1 byte, end with `F7`
- [ ] **Total = exactly 24 bytes**

A device that answers only block 1 is fully recognised. The user fills in its capabilities once in the UI, and GMBoop remembers them against `instance_id` for next time.

---

## Level 1 — serving the descriptor

The descriptor is an **ASCII-only** JSON document (escape any non-ASCII as `\uXXXX`, so every byte is already 7-bit safe). A typical descriptor is 1–2 KB. Full field reference: [`docs/SYSEX_IDENTITY.md §5`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/SYSEX_IDENTITY.md).

Minimal shape:

```json
{
  "gmb_descriptor": 2,
  "revision": 42,
  "device": { "name": "Atelier — 4-string ukulele", "model": "Servo-Plucked-Strings" },
  "instruments": [
    {
      "channel": 0,
      "configured": true,
      "name": "Ukulele",
      "gm_program": 24,
      "type": "guitar",
      "subtype": "nylon",
      "notes": { "mode": "range", "min": 60, "max": 88 },
      "physical": { "family": "strings", "string_count": 4, "tuning": [67, 60, 64, 69] }
    }
  ]
}
```

Two rules that matter most:

- **Absent field = unknown, never zero.** Declare only what you know; omit the rest and GMBoop leaves that value to the user.
- **`type` / `subtype`** use the textual keys from `InstrumentTypeConfig.js` (`guitar`/`nylon`, `strings`, `pipe`/`flute`, …) — not numeric ids.

### Serving it — two interchangeable ways

**Over HTTP** (set `flags` bit 0): GMBoop does `GET /gmb/descriptor.json`. Simplest if your board already runs a web server.

**Over SysEx block 0x10** (chunked, works on any transport):

```
Request:  F0 7D 00 10 00 <chunk_index[2]> F7
Response: F0 7D 00 10 01 <total_chunks[2]> <chunk_index[2]> <payload...> F7
```

`payload` ≤ **200 bytes** (keeps the message under the BLE-MIDI reassembly MTU; full message ≤ 210 bytes). You must be able to serve any chunk index on demand — either from a static document in flash/PROGMEM, or rendered in RAM from the active profile. Serve all chunks from a **frozen snapshot**; if `revision` changes mid-transfer, GMBoop restarts the transfer so it never mixes two versions.

---

## Block 0x11 — change notification (optional)

When the configuration changes at runtime, tell GMBoop instead of waiting to be re-polled:

```
F0 7D 00 11 02 <revision[5]> <change_flags> F7
```

| Bit | Meaning |
|-----|---------|
| 0 | `IDENTITY_CHANGED` |
| 1 | `INSTRUMENTS_CHANGED` |
| 2 | `TIMING_CHANGED` |
| 3 | `RESTART_REQUIRED` |

This is only an optimisation. On transports with no reliable return path, GMBoop re-reads block 1 every 30 s and compares `revision` anyway.

---

## What the descriptor can declare (summary)

Point of reference: [`docs/SYSEX_IDENTITY.md §5`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/SYSEX_IDENTITY.md). Highlights:

- **`configured`** — per instrument. `false` means "exists but not defined yet"; GMBoop drops to manual entry without overwriting anything.
- **`notes`** — `{ "mode": "range", "min", "max" }` or `{ "mode": "discrete", "list": [...] }`, with optional per-note `attributes`.
- **`voices`** — physical single-note units (a string, a harmonica hole, a pipe).
- **`polyphony`** — `max` plus `constraints` (`one_note_per_voice`, `same_attribute`, `adjacent_voices`, `max_simultaneous_per_group`).
- **`timing`** — two phases: `prepare` (slow, silent positioning — GMBoop hides it with lookahead) and `excite` (the audible trigger — the only value feeding `sync_delay`).
- **`expression`** — CCs, pitch bend, aftertouch, velocity.
- **`resources`** — consumables (bow, piston reservoir, bellows): capacity + refill behaviour.
- **`physical`** — per-family namespace (`strings`, `winds`, `percussion`); ignored if unknown.

---

## Transport requirements

| Transport | Auto-recognition | Note |
|-----------|:----------------:|------|
| USB-MIDI | yes | bidirectional by nature |
| BLE-MIDI | yes | descriptor chunks capped at 200 bytes |
| WiFi RTP-MIDI | yes | prefer the HTTP flag |
| DIN IN + OUT | yes | |
| **DIN IN only** | **no** | no return path → user selects it from a list |

No auto-discovery is possible without a return channel: a wired instrument meant to be recognised **must** provide a MIDI OUT.

---

## Fields GMBoop never asks you for

These are GMBoop-side settings, measured or chosen by the user — never put them in your descriptor:

| Field | Source |
|-------|--------|
| `sync_delay` | measured by GMBoop's microphone calibration |
| `comm_timeout` | GMBoop internal setting |
| `octave_mode` | user display preference |
| `tab_algorithm` | GMBoop tablature preference |
| MAC address, USB serial number | discovered by the system stack |
| SoundFont (SF2) | user choice |

---

## Migrating from v1

1. **`instance_id` first.** Nothing works without a unique per-exemplar id — a self-contained firmware patch, independent of everything else.
2. Drop the old 52-byte identity and blocks 5/6/7. Shrink block 1 to the 24-byte handshake above.
3. If your configuration is dynamic, serialise the descriptor JSON from your active profile (static PROGMEM is fine otherwise).

Full migration plan: [`docs/SYSEX_IDENTITY.md §11`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/SYSEX_IDENTITY.md).

---

## Related Pages

- [[Interface-Instrument-Creation]] — what the UI shows after recognition
- [[Interface-Hand-Management]] — hand-position planning driven by the `physical` block
- [[Hardware-Integration]] — physical connection over USB, Bluetooth, and Serial UART
- [`docs/SYSEX_IDENTITY.md`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/SYSEX_IDENTITY.md) — full technical specification
