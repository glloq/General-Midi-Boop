# Instrument Developer Guide — GMBoop SysEx Auto-Configuration

This page is for builders of DIY MIDI instruments (Arduino, Teensy, ESP32, custom firmware, …) who want their device to be **automatically recognised and configured** by Général Midi Boop without any manual setup in the UI.

Full technical specification: [`docs/SYSEX_IDENTITY.md`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/SYSEX_IDENTITY.md).

---

## Overview

When a new device is connected, Général Midi Boop sends a **SysEx Identity Request**. If the device responds correctly, GMBoop reads the response and configures the instrument automatically. The more blocks your firmware implements, the more GMBoop can configure without user intervention.

**Protocol**: Custom SysEx using the MIDI Educational/Development manufacturer ID `0x7D`.

### Block Summary

| Block | ID | What it declares | Required? |
|-------|----|-----------------|-----------|
| **1 — Identity** | `0x01` | Device name, firmware version, feature flags | **Yes — minimum requirement** |
| **5 — Instrument Descriptor** | `0x05` | How many instruments, on which channels, which GM type | Multi-instrument devices |
| **6 — Instrument Capabilities** | `0x06` | Note range, polyphony, supported CCs, subtype | For auto-config without user input |
| **7 — String Instrument Config** | `0x07` | String count, fret count, tuning, CC wiring | String instruments only |

### Common Message Header

All GMBoop SysEx messages share this header:

```
F0 7D 00 <block_id> <direction> [data...] F7
```

| Byte | Value | Meaning |
|------|-------|---------|
| `F0` | — | SysEx start |
| `7D` | — | MIDI Educational / Custom SysEx |
| `00` | — | GMBoop Manufacturer ID |
| `<block_id>` | 01–07 | Which block |
| `<direction>` | `00` = request / `01` = response | Direction flag |

---

## Levels of Auto-Configuration

### Level 1 — Identity Only (Block 1)

Minimum effort. GMBoop registers the device and assumes one instrument on channel 0. The user configures capabilities manually via the [[Interface-Instrument-Creation|instrument settings UI]].

```
GMBoop ──► F0 7D 00 01 00 F7          (Block 1 request)
       ◄── 52-byte identity response
       → Device registered, 1 instrument on ch 0, manual config needed
```

### Level 2 — Single Instrument Auto-Config (Block 1 + Block 6)

GMBoop fully auto-configures the instrument on channel 0 — no user interaction required.

```
GMBoop ──► Block 1 request
       ◄── Block 1 response (feature flag bit 4 = INSTRUMENT_CAPABILITIES)
       ──► Block 6 request (channel 0)
       ◄── Block 6 response
       → Instrument auto-configured, capabilities_source = 'sysex'
```

### Level 3 — Full Multi-Instrument Auto-Config (Block 1 + 5 + 6 + 7)

Every instrument on the device is discovered and fully configured automatically, including string geometry.

```
GMBoop ──► Block 1 request
       ◄── Block 1 response (feature flags bits 3, 4, 5)
       ──► Block 5 request
       ◄── Block 5 response (N instruments with channels and types)
       ──► Block 6 request × N (one per channel)
       ◄── Block 6 responses
       ──► Block 7 request (for each string instrument)
       ◄── Block 7 responses
       → All instruments auto-configured
```

---

## Block 1 — Device Identity

### Request (sent by GMBoop)

```
F0 7D 00 01 00 F7
```
Fixed size: 6 bytes.

### Response (sent by the instrument)

```
F0 7D 00 01 01 <version> <deviceId[5]> <name[32]> <firmware[3]> <features[5]> F7
```
Fixed size: **52 bytes**.

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 5 | 1 | Block version | `0x01` |
| 6–10 | 5 | Device ID | Unique 32-bit ID, 7-bit encoded |
| 11–42 | 32 | Device name | ASCII, null-terminated, padded to 32 bytes |
| 43–45 | 3 | Firmware | `[major, minor, patch]` |
| 46–50 | 5 | Feature flags | 32-bit bitmask, 7-bit encoded |

### 7-Bit Encoding (for Device ID and Feature Flags)

MIDI SysEx requires all data bytes to have MSB = 0 (values 0–127). A 32-bit integer is therefore spread across 5 bytes:

```c
void encode32BitTo7Bit(uint32_t value, uint8_t* out) {
    out[0] = (value      ) & 0x7F;
    out[1] = (value >>  7) & 0x7F;
    out[2] = (value >> 14) & 0x7F;
    out[3] = (value >> 21) & 0x7F;
    out[4] = (value >> 28) & 0x07;
}
```

### Feature Flags

| Bit | Name | Hex | Meaning |
|-----|------|-----|---------|
| 0 | `NOTE_MAP` | `0x01` | Supports Block 2 (reserved) |
| 1 | `VELOCITY_CURVES` | `0x02` | Supports Block 3 (reserved) |
| 2 | `CC_MAPPING` | `0x04` | Supports Block 4 (reserved) |
| 3 | `INSTRUMENT_DESCRIPTOR` | `0x08` | Supports Block 5 |
| 4 | `INSTRUMENT_CAPABILITIES` | `0x10` | Supports Block 6 |
| 5 | `STRING_CONFIG` | `0x20` | Supports Block 7 |

Common combinations:

```c
0x00000000  // Block 1 only — identity, manual config
0x00000010  // Block 1 + 6 — single instrument auto-config
0x00000018  // Block 1 + 5 + 6 — multi-instrument auto-config
0x00000038  // Block 1 + 5 + 6 + 7 — full auto-config with strings
```

### Arduino / Teensy Example

```c
void handleIdentityRequest() {
    uint8_t response[52];
    int pos = 0;

    response[pos++] = 0xF0;
    response[pos++] = 0x7D;
    response[pos++] = 0x00;
    response[pos++] = 0x01;  // Block 1
    response[pos++] = 0x01;  // Reply
    response[pos++] = 0x01;  // Block version

    encode32BitTo7Bit(0x12345678, &response[pos]);  // Device ID
    pos += 5;

    const char* name = "MyRobotPiano";
    memset(&response[pos], 0, 32);
    memcpy(&response[pos], name, strlen(name));
    pos += 32;

    response[pos++] = 1;  // Firmware major
    response[pos++] = 0;  // Firmware minor
    response[pos++] = 0;  // Firmware patch

    encode32BitTo7Bit(0x00000010, &response[pos]);  // Feature: INSTRUMENT_CAPABILITIES
    pos += 5;

    response[pos++] = 0xF7;

    usbMIDI.sendSysEx(52, response);
}
```

### Block 1 Checklist

- [ ] Detect `F0 7D 00 01 00 F7` (6 bytes)
- [ ] Reply header `F0 7D 00 01 01`
- [ ] Block version = `0x01`
- [ ] Device ID: 32-bit, 7-bit encoded over 5 bytes
- [ ] Device name: ASCII printable, null-terminated, padded to exactly 32 bytes
- [ ] Firmware: 3 bytes `[major, minor, patch]`
- [ ] Feature flags: 32-bit, 7-bit encoded over 5 bytes
- [ ] End with `F7`
- [ ] **Total = exactly 52 bytes**

---

## Block 5 — Instrument Descriptor

Use this block if your device hosts more than one instrument on different MIDI channels (e.g. piano on ch 0, drums on ch 9).

### Request

```
F0 7D 00 05 00 F7
```

### Response

```
F0 7D 00 05 01 <version> <num_instruments> [<channel> <gm_program> <type_id>]... F7
```

Each instrument entry is 3 bytes. Total size = `8 + (3 × N)` bytes.

### Type ID Table

| ID | Type | GM programs |
|----|------|-------------|
| `0x00` | unknown | — |
| `0x01` | piano | 0–7 |
| `0x02` | chromatic_percussion | 8–15 |
| `0x03` | organ | 16–23 |
| `0x04` | guitar | 24–31 |
| `0x05` | bass | 32–39 |
| `0x06` | strings | 40–47 |
| `0x07` | ensemble | 48–55 |
| `0x08` | brass | 56–63 |
| `0x09` | reed | 64–71 |
| `0x0A` | pipe | 72–79 |
| `0x0B` | synth_lead | 80–87 |
| `0x0C` | synth_pad | 88–95 |
| `0x0D` | synth_effects | 96–103 |
| `0x0E` | ethnic | 104–111 |
| `0x0F` | drums | 112–119 |
| `0x10` | sound_effects | 120–127 |

Use `0x7F` for `gm_program` when the program is undefined (typical for drums).

> **Note** — these `type_id` values are the fixed SysEx wire format and are independent of the
> server-side **13 physical instrument families** (`shared/instrument-families.json`, see
> [[Architecture]] § Instrument Families) used for auto-assignment scoring and UI grouping. You
> only need to send the `type_id` above; the server maps the channel's GM program onto the
> physical family automatically.

### Example — Piano + Guitar + Drums

```c
const uint8_t instruments[][3] = {
    { 0,    0,    0x01 },  // ch 0, GM 0 (Acoustic Grand), piano
    { 1,    24,   0x04 },  // ch 1, GM 24 (Nylon Guitar), guitar
    { 9,    0x7F, 0x0F },  // ch 9, no GM, drums
};

void handleDescriptorRequest() {
    int N = 3;
    uint8_t response[8 + N * 3];
    int pos = 0;
    response[pos++] = 0xF0;
    response[pos++] = 0x7D;
    response[pos++] = 0x00;
    response[pos++] = 0x05;
    response[pos++] = 0x01;
    response[pos++] = 0x01;  // version
    response[pos++] = N;
    for (int i = 0; i < N; i++) {
        response[pos++] = instruments[i][0];
        response[pos++] = instruments[i][1];
        response[pos++] = instruments[i][2];
    }
    response[pos++] = 0xF7;
    usbMIDI.sendSysEx(pos, response);
}
```

---

## Block 6 — Instrument Capabilities

Provides detailed capability data for a single instrument (identified by channel). GMBoop queries this for each channel it discovers.

### Request (7 bytes)

```
F0 7D 00 06 00 <channel> F7
```

### Response (variable length)

```
F0 7D 00 06 01 <version> <channel>
  <gm_program> <type_id> <subtype_id>
  <note_selection_mode> <note_min> <note_max> <polyphony>
  <num_selected_notes> [<note>...]
  <num_ccs> [<cc>...]
  <name_length> [<chars>...]
F7
```

| Field | Description |
|-------|-------------|
| `note_selection_mode` | `0` = contiguous range, `1` = discrete list of notes |
| `note_min` / `note_max` | MIDI note numbers 0–127 |
| `polyphony` | Max simultaneous notes (1–127) |
| `selected_notes` | Only if discrete mode (`note_selection_mode = 1`) |
| `supported_ccs` | CC numbers the instrument responds to (affects adaptation and MIDI-learn) |
| `name` | Instrument display name (ASCII, max 32 chars) |

**Subtype IDs** are relative to the parent type. The complete subtype table (piano subtypes, guitar subtypes, drum kit types, …) is in [`docs/SYSEX_IDENTITY.md §18`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/SYSEX_IDENTITY.md).

### Example — Grand Piano

```c
void handleCapabilitiesRequest(uint8_t ch) {
    if (ch != 0) return;

    const char* name = "Grand Piano";
    uint8_t ccs[] = { 1, 7, 10, 11, 64 };  // Mod, Vol, Pan, Expr, Sustain
    int pos = 0;
    uint8_t buf[64];

    buf[pos++] = 0xF0; buf[pos++] = 0x7D; buf[pos++] = 0x00;
    buf[pos++] = 0x06; buf[pos++] = 0x01;
    buf[pos++] = 0x01;          // version
    buf[pos++] = 0;             // channel
    buf[pos++] = 0;             // GM program 0 (Acoustic Grand)
    buf[pos++] = 0x01;          // type: piano
    buf[pos++] = 0x01;          // subtype: acoustic_grand
    buf[pos++] = 0;             // range mode
    buf[pos++] = 21;            // A0
    buf[pos++] = 108;           // C8
    buf[pos++] = 88;            // polyphony
    buf[pos++] = 0;             // no discrete notes
    buf[pos++] = sizeof(ccs);
    for (int i = 0; i < sizeof(ccs); i++) buf[pos++] = ccs[i];
    buf[pos++] = strlen(name);
    for (int i = 0; i < strlen(name); i++) buf[pos++] = name[i];
    buf[pos++] = 0xF7;

    usbMIDI.sendSysEx(pos, buf);
}
```

### Block 6 Checklist

- [ ] Detect `F0 7D 00 06 00 <channel> F7`
- [ ] Reply with the capabilities for the requested channel only
- [ ] `note_selection_mode` = 0 (range) or 1 (discrete)
- [ ] If discrete: include the full note list
- [ ] CCs array: only CCs the hardware actually responds to
- [ ] Name: ASCII, length byte followed by characters (no null terminator)
- [ ] All byte values 0–127 (7-bit safe)
- [ ] Feature flag bit 4 set in Block 1

---

## Block 7 — String Instrument Config

Only required for string instruments (guitar, bass, violin, etc.). Declares the physical geometry so GMBoop can run the hand-position planner.

### Request (7 bytes)

```
F0 7D 00 07 00 <channel> F7
```

### Response

```
F0 7D 00 07 01 <version> <channel>
  <num_strings> <num_frets> <is_fretless> <capo_fret>
  <cc_enabled> <cc_string> <cc_fret>
  <tuning[num_strings]>
F7
```

Total size = `15 + num_strings` bytes.

| Field | Description |
|-------|-------------|
| `num_strings` | Physical string count (1–6) |
| `num_frets` | Fret count (0 = fretless) |
| `is_fretless` | `0` fretted, `1` fretless |
| `capo_fret` | 0 = no capo; 1–36 = capo position |
| `cc_enabled` | `1` if hardware accepts CC commands for string/fret selection |
| `cc_string` | CC number for string selection (default 20) |
| `cc_fret` | CC number for fret position (default 21) |
| `tuning` | MIDI note per open string, **lowest string first** |

### Standard Tuning Reference

| Instrument | Tuning bytes (hex) |
|------------|-------------------|
| Guitar standard | `28 2D 32 37 3B 40` (E2 A2 D3 G3 B3 E4) |
| Guitar Drop D | `26 2D 32 37 3B 40` (D2 A2 D3 G3 B3 E4) |
| Bass 4-string | `1C 21 26 2B` (E1 A1 D2 G2) |
| Violin | `37 3E 45 4C` (G3 D4 A4 E5) |
| Cello | `24 2B 32 39` (C2 G2 D3 A3) |
| Ukulele | `43 3C 40 45` (G4 C4 E4 A4) |

### Example — 6-String Guitar

```c
void handleStringConfigRequest(uint8_t ch) {
    if (ch != 1) return;

    uint8_t tuning[] = { 40, 45, 50, 55, 59, 64 };  // E2 A2 D3 G3 B3 E4
    int N = 6;
    uint8_t buf[15 + N];
    int pos = 0;

    buf[pos++] = 0xF0; buf[pos++] = 0x7D; buf[pos++] = 0x00;
    buf[pos++] = 0x07; buf[pos++] = 0x01;
    buf[pos++] = 0x01;  // version
    buf[pos++] = 1;     // channel
    buf[pos++] = N;     // 6 strings
    buf[pos++] = 22;    // 22 frets
    buf[pos++] = 0;     // not fretless
    buf[pos++] = 0;     // no capo
    buf[pos++] = 1;     // CC enabled
    buf[pos++] = 20;    // CC20 = string
    buf[pos++] = 21;    // CC21 = fret
    for (int i = 0; i < N; i++) buf[pos++] = tuning[i];
    buf[pos++] = 0xF7;

    usbMIDI.sendSysEx(pos, buf);
}
```

---

## Complete SysEx Dispatch (All Blocks)

```c
void checkSysExRequest() {
    if (!usbMIDI.read() || usbMIDI.getType() != usbMIDI.SystemExclusive) return;

    uint8_t* data = usbMIDI.getSysExArray();
    int len = usbMIDI.getSysExArrayLength();

    // Validate GMBoop header: F0 7D 00 <block> 00
    if (len < 6 || data[0] != 0xF0 || data[1] != 0x7D || data[2] != 0x00) return;
    if (data[4] != 0x00) return;  // Not a request

    switch (data[3]) {
        case 0x01: handleIdentityRequest(); break;
        case 0x05: handleDescriptorRequest(); break;
        case 0x06: if (len >= 7) handleCapabilitiesRequest(data[5]); break;
        case 0x07: if (len >= 7) handleStringConfigRequest(data[5]); break;
    }
}
```

---

## Fields NOT Sent via SysEx

These are Général Midi Boop–side settings and are never queried from the instrument:

| Field | Source |
|-------|--------|
| `sync_delay` | Measured by the microphone calibrator — see [[Interface-Microphone]] |
| `octave_mode` | User preference (chromatic / diatonic / pentatonic) |
| `tab_algorithm` | GMBoop tablature processing setting |
| `capabilities_source` | Set automatically to `'sysex'` after auto-config |
| MAC address | Discovered by the Bluetooth stack |
| USB serial number | Discovered by OS USB enumeration |

---

## Backward Compatibility

GMBoop **never requests a block the device does not advertise**. Feature flags in Block 1 are the gate:

| Device implements | GMBoop behaviour |
|-------------------|-----------------|
| Block 1 only | Identity registered, manual UI config required |
| Block 1 + 6 | Single instrument auto-configured on ch 0 |
| Block 1 + 5 | Multi-instrument discovery, manual capability config |
| Block 1 + 5 + 6 | Full multi-instrument auto-config |
| Block 1 + 5 + 6 + 7 | Full auto-config including string geometry |

A device that only implements Block 1 remains 100 % compatible with all future versions of GMBoop.

---

## Related Pages

- [[Interface-Instrument-Creation]] — what the UI shows after auto-config completes
- [[Interface-Hand-Management]] — hand-position planning driven by Block 6 and Block 7 data
- [[Hardware-Integration]] — physical connection over USB, Bluetooth, and Serial UART
- [`docs/SYSEX_IDENTITY.md`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/SYSEX_IDENTITY.md) — full technical specification with complete subtype tables
