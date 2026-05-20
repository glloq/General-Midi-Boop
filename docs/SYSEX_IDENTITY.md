# GeneralMidiBoop SysEx Protocol - Instrument Developer Guide

## Overview

The GeneralMidiBoop SysEx protocol enables custom identification and automatic configuration of DIY instruments via the SysEx 0x7D protocol. It supports both single-instrument devices and multi-instrument controllers.

**Protocol**: Custom SysEx (Educational/Development use)
**Manufacturer ID**: 0x00 (GeneralMidiBoop)

### Block Summary

| Block | ID | Name | Purpose | Status |
|-------|----|------|---------|--------|
| 1 | `0x01` | Device Identity | Device identification (ID, name, firmware, features) | Implemented |
| 2 | `0x02` | Note Mapping | Note map configuration | Reserved |
| 3 | `0x03` | Velocity Curves | Velocity curve configuration | Reserved |
| 4 | `0x04` | CC Mapping | CC mapping configuration | Reserved |
| 5 | `0x05` | Instrument Descriptor | Multi-instrument discovery (channels, types) | New |
| 6 | `0x06` | Instrument Capabilities | Per-instrument detailed capabilities | New |
| 7 | `0x07` | String Instrument Config | String instrument physical config | New |
| 8 | `0x08` | Lighting Capabilities | Embedded-LED capabilities (auto-config) | New |
| 9 | `0x09` | Lighting Control | Realtime LED control (command, no reply) | New |

### Common Header Format

All GeneralMidiBoop SysEx messages share this header structure:
```
F0 7D 00 <block_id> <direction> [<data>...] F7
```
- `F0` : SysEx start
- `7D` : Custom SysEx (Educational/Development)
- `00` : GMB Manufacturer ID
- `<block_id>` : Block number (01-07)
- `<direction>` : 00=request, 01=response

---

## 1. Identity Request

### Format expected by the instrument
```
F0 7D 00 01 00 F7
```

### Byte breakdown
| Byte | Value | Description |
|------|-------|-------------|
| 0 | `F0` | Start SysEx |
| 1 | `7D` | Custom SysEx (Educational/Development) |
| 2 | `00` | GMB Manufacturer ID |
| 3 | `01` | Block 1 (Identification) |
| 4 | `00` | Request flag (00=request, 01=response) |
| 5 | `F7` | End SysEx |

**Size**: 6 bytes

---

## 2. Instrument Response

### Full format (52 bytes)
```
F0 7D 00 01 01 <version> <deviceId[5]> <name[32]> <firmware[3]> <features[5]> F7
```

### Field table

| Offset | Size | Field | Type | Description |
|--------|------|-------|------|-------------|
| 0 | 1 | Start | `F0` | SysEx start |
| 1 | 1 | Protocol | `7D` | Custom SysEx |
| 2 | 1 | Manufacturer | `00` | GeneralMidiBoop |
| 3 | 1 | Block ID | `01` | Identification |
| 4 | 1 | Reply Flag | `01` | Response (always 01) |
| 5 | 1 | Block Version | `uint8` | Format version (currently 01) |
| 6-10 | 5 | Device ID | `7bit[5]` | 32-bit unique ID (7-bit encoded) |
| 11-42 | 32 | Device Name | `string` | Instrument name (null-terminated, ASCII) |
| 43-45 | 3 | Firmware | `uint8[3]` | Firmware version [major, minor, patch] |
| 46-50 | 5 | Feature Flags | `7bit[5]` | 32-bit feature bitmask (7-bit encoded) |
| 51 | 1 | End | `F7` | SysEx end |

**Total size**: 52 bytes (fixed)

---

## 3. 7-bit Encoding (32-bit → 5 bytes)

### Principle
- MIDI SysEx requires MSB=0 (values 0-127)
- A uint32 requires 5 bytes in 7-bit encoding
- Only the lower 32 bits are used (bits 28-31 on the 5th byte)

### Encoding (instrument side)
```c
void encode32BitTo7Bit(uint32_t value, uint8_t* output) {
    output[0] = (value      ) & 0x7F;  // Bits 0-6
    output[1] = (value >>  7) & 0x7F;  // Bits 7-13
    output[2] = (value >> 14) & 0x7F;  // Bits 14-20
    output[3] = (value >> 21) & 0x7F;  // Bits 21-27
    output[4] = (value >> 28) & 0x07;  // Bits 28-31 (only 4 bits)
}
```

### Decoding (GeneralMidiBoop side - reference)
```cpp
uint32_t value = 0;
value |= (data[0] & 0x7F);
value |= (data[1] & 0x7F) << 7;
value |= (data[2] & 0x7F) << 14;
value |= (data[3] & 0x7F) << 21;
value |= (data[4] & 0x07) << 28;  // Only 3 useful bits
```

---

## 4. Feature Flags (32-bit Bitmask)

### Defined bits
| Bit | Name | Hex | Description |
|-----|------|-----|-------------|
| 0 | `NOTE_MAP` | `0x01` | Supports Block 2 (Note Mapping) |
| 1 | `VELOCITY_CURVES` | `0x02` | Supports Block 3 (Velocity Curves) |
| 2 | `CC_MAPPING` | `0x04` | Supports Block 4 (CC Mapping) |
| 3 | `INSTRUMENT_DESCRIPTOR` | `0x08` | Supports Block 5 (Instrument Descriptor) |
| 4 | `INSTRUMENT_CAPABILITIES` | `0x10` | Supports Block 6 (Instrument Capabilities) |
| 5 | `STRING_CONFIG` | `0x20` | Supports Block 7 (String Instrument Config) |
| 6 | `LIGHTING` | `0x40` | Supports Block 8 (Lighting Capabilities) + Block 9 (Lighting Control) |
| 7-31 | *Reserved* | — | Future use |

### Examples
```c
// No advanced features (Block 1 identity only)
uint32_t features = 0x00000000;

// Single instrument with auto-capabilities (Block 6 only)
uint32_t features = 0x00000010;

// Multi-instrument with auto-capabilities (Block 5 + Block 6)
uint32_t features = 0x00000018;

// Multi-instrument, full auto-config including strings (Block 5 + 6 + 7)
uint32_t features = 0x00000038;

// Everything supported (Block 2-7)
uint32_t features = 0x0000003F;
```

### Feature flag dependencies
- Block 5 (`INSTRUMENT_DESCRIPTOR`) : standalone, declares instrument list
- Block 6 (`INSTRUMENT_CAPABILITIES`) : standalone, works with or without Block 5
- Block 7 (`STRING_CONFIG`) : requires Block 6 (needs type info to know which instruments are strings)

---

## 5. Device Name (32 bytes)

### Rules
- **Maximum**: 32 characters
- **Encoding**: ASCII printable (32-126)
- **Termination**: NULL (`0x00`)
- **Padding**: Fill with `0x00` up to 32 bytes

### Arduino example
```c
void encodeDeviceName(const char* name, uint8_t* output) {
    int len = strlen(name);
    if (len > 32) len = 32;

    // Copy the name
    memcpy(output, name, len);

    // Padding with 0x00
    for (int i = len; i < 32; i++) {
        output[i] = 0x00;
    }
}
```

---

## 6. Complete Example - Arduino/Teensy

```c
// Instrument configuration
#define DEVICE_ID       0x12345678
#define DEVICE_NAME     "MyDrumKit"
#define FW_MAJOR        1
#define FW_MINOR        0
#define FW_PATCH        2
#define FEATURES        0x00000001  // Supports Note Map

void handleIdentityRequest() {
    uint8_t response[52];
    int pos = 0;

    // Header
    response[pos++] = 0xF0;  // Start
    response[pos++] = 0x7D;  // Custom SysEx
    response[pos++] = 0x00;  // GMB Manufacturer
    response[pos++] = 0x01;  // Block 1
    response[pos++] = 0x01;  // Reply flag

    // Block Version
    response[pos++] = 0x01;

    // Device ID (32-bit → 5 bytes 7-bit)
    encode32BitTo7Bit(DEVICE_ID, &response[pos]);
    pos += 5;

    // Device Name (32 bytes)
    encodeDeviceName(DEVICE_NAME, &response[pos]);
    pos += 32;

    // Firmware version
    response[pos++] = FW_MAJOR;
    response[pos++] = FW_MINOR;
    response[pos++] = FW_PATCH;

    // Feature flags (32-bit → 5 bytes 7-bit)
    encode32BitTo7Bit(FEATURES, &response[pos]);
    pos += 5;

    // End
    response[pos++] = 0xF7;

    // Send via MIDI
    usbMIDI.sendSysEx(52, response);
}

void checkSysExRequest() {
    if (usbMIDI.read() && usbMIDI.getType() == usbMIDI.SystemExclusive) {
        uint8_t* data = usbMIDI.getSysExArray();
        int length = usbMIDI.getSysExArrayLength();

        // Check if it's a Block 1 request
        if (length == 6 &&
            data[0] == 0xF0 &&
            data[1] == 0x7D &&
            data[2] == 0x00 &&
            data[3] == 0x01 &&
            data[4] == 0x00 &&
            data[5] == 0xF7) {

            handleIdentityRequest();
        }
    }
}
```

---

## 7. Minimal Test

### Valid minimal response
```
F0 7D 00 01 01  // Header + Reply
01              // Block version
01 00 00 00 00  // Device ID = 1
54 65 73 74 00  // "Test" + padding (28 x 0x00)
00 00 00 00 00 00 00 00 00 00 00 00 00 00
00 00 00 00 00 00 00 00 00 00 00 00 00
01 00 00        // Firmware 1.0.0
01 00 00 00 00  // Features = 0x01
F7              // End
```

### Decoded values
```
Block Version: 1
Device ID: 0x00000001
Device Name: "Test"
Firmware: 1.0.0
Features: 0x00000001 (Note Map supported)
```

---

## 8. Block 1 Implementation Checklist

- [ ] Detect request `F0 7D 00 01 00 F7`
- [ ] Correct response header `F0 7D 00 01 01`
- [ ] Block version = `0x01`
- [ ] Device ID 7-bit encoded (5 bytes)
- [ ] Device Name padded to 32 bytes with NULL
- [ ] Firmware version (3 bytes)
- [ ] Feature flags 7-bit encoded (5 bytes)
- [ ] End with `F7`
- [ ] Total size = exactly 52 bytes

---

# Block 5 — Instrument Descriptor

## 9. Purpose

Block 5 allows a device to declare how many instruments it manages and on which MIDI channels. This is the **discovery mechanism** for multi-instrument devices.

- A device with **one instrument** does NOT need Block 5 (Général Midi Boop assumes channel 0)
- A device with **multiple instruments** SHOULD implement Block 5 so Général Midi Boop can discover them all

## 10. Instrument Descriptor Request

### Format
```
F0 7D 00 05 00 F7
```

### Byte breakdown
| Byte | Value | Description |
|------|-------|-------------|
| 0 | `F0` | Start SysEx |
| 1 | `7D` | Custom SysEx |
| 2 | `00` | GMB Manufacturer ID |
| 3 | `05` | Block 5 (Instrument Descriptor) |
| 4 | `00` | Request flag |
| 5 | `F7` | End SysEx |

**Size**: 6 bytes

## 11. Instrument Descriptor Response

### Format (variable length)
```
F0 7D 00 05 01 <version> <num_instruments> [<entry>...] F7
```

Each `<entry>` = 3 bytes: `<channel> <gm_program> <type_id>`

### Field table

| Offset | Size | Field | Type | Description |
|--------|------|-------|------|-------------|
| 0 | 1 | Start | `F0` | SysEx start |
| 1 | 1 | Protocol | `7D` | Custom SysEx |
| 2 | 1 | Manufacturer | `00` | GeneralMidiBoop |
| 3 | 1 | Block ID | `05` | Instrument Descriptor |
| 4 | 1 | Reply Flag | `01` | Response |
| 5 | 1 | Block Version | `uint8` | Format version (currently 01) |
| 6 | 1 | Num Instruments | `uint8` | Number of instruments (1-16) |
| 7+ | 3×N | Entries | see below | One entry per instrument |
| last | 1 | End | `F7` | SysEx end |

### Entry format (3 bytes per instrument)

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| +0 | 1 | Channel | MIDI channel (0-15) |
| +1 | 1 | GM Program | General MIDI program (0-127, 0x7F = undefined) |
| +2 | 1 | Type ID | Instrument type (see table below) |

### Message size

| Instruments | Total size |
|-------------|------------|
| 1 | 11 bytes |
| 4 | 20 bytes |
| 8 | 32 bytes |
| 16 | 56 bytes |

## 12. Type ID Encoding

Aligned with `InstrumentTypeConfig.js` (`INSTRUMENT_TYPE_HIERARCHY`).

| ID | Type Key | Label | GM Programs |
|----|----------|-------|-------------|
| `0x00` | `unknown` | Unknown | — |
| `0x01` | `piano` | Piano | 0-7 |
| `0x02` | `chromatic_percussion` | Chromatic Percussion | 8-15 |
| `0x03` | `organ` | Organ | 16-23 |
| `0x04` | `guitar` | Guitar | 24-31 |
| `0x05` | `bass` | Bass | 32-39 |
| `0x06` | `strings` | Strings | 40-47 |
| `0x07` | `ensemble` | Ensemble | 48-55 |
| `0x08` | `brass` | Brass | 56-63 |
| `0x09` | `reed` | Reed | 64-71 |
| `0x0A` | `pipe` | Pipe / Flutes | 72-79 |
| `0x0B` | `synth_lead` | Synth Lead | 80-87 |
| `0x0C` | `synth_pad` | Synth Pad | 88-95 |
| `0x0D` | `synth_effects` | Synth Effects | 96-103 |
| `0x0E` | `ethnic` | Ethnic | 104-111 |
| `0x0F` | `drums` | Drums / Percussion | 112-119 |
| `0x10` | `sound_effects` | Sound Effects | 120-127 |

## 13. Block 5 Example — Arduino/Teensy

### Multi-instrument device (Piano ch0 + Guitar ch1 + Drums ch9)

```c
#define NUM_INSTRUMENTS 3

typedef struct {
    uint8_t channel;
    uint8_t gmProgram;
    uint8_t typeId;
} InstrumentEntry;

const InstrumentEntry instruments[NUM_INSTRUMENTS] = {
    { 0,  0,    0x01 },  // Piano, channel 0, GM program 0 (Acoustic Grand)
    { 1,  24,   0x04 },  // Guitar, channel 1, GM program 24 (Nylon)
    { 9,  0x7F, 0x0F }   // Drums, channel 9, no GM program (kit)
};

void handleDescriptorRequest() {
    uint8_t response[8 + (NUM_INSTRUMENTS * 3)];
    int pos = 0;

    // Header
    response[pos++] = 0xF0;
    response[pos++] = 0x7D;
    response[pos++] = 0x00;
    response[pos++] = 0x05;  // Block 5
    response[pos++] = 0x01;  // Reply

    // Block version
    response[pos++] = 0x01;

    // Number of instruments
    response[pos++] = NUM_INSTRUMENTS;

    // Instrument entries
    for (int i = 0; i < NUM_INSTRUMENTS; i++) {
        response[pos++] = instruments[i].channel;
        response[pos++] = instruments[i].gmProgram;
        response[pos++] = instruments[i].typeId;
    }

    // End
    response[pos++] = 0xF7;

    usbMIDI.sendSysEx(pos, response);
}
```

### Minimal test response (single instrument)

```
F0 7D 00 05 01  // Header + Reply
01              // Block version
01              // 1 instrument
00 00 01        // Channel 0, GM program 0 (Acoustic Grand), type=piano
F7              // End
```

Decoded: 1 instrument — Piano on channel 0, GM program 0.

## 14. Block 5 Implementation Checklist

- [ ] Detect request `F0 7D 00 05 00 F7`
- [ ] Correct response header `F0 7D 00 05 01`
- [ ] Block version = `0x01`
- [ ] Num instruments = 1-16
- [ ] Each entry: channel (0-15), GM program (0-127 or 0x7F), type_id (0x00-0x10)
- [ ] Total size = 8 + (3 × num_instruments) bytes
- [ ] Feature flag bit 3 (`INSTRUMENT_DESCRIPTOR`) set in Block 1 response

---

# Block 6 — Instrument Capabilities

## 15. Purpose

Block 6 provides detailed capabilities for a specific instrument identified by its MIDI channel. Général Midi Boop uses this to auto-configure instruments without user intervention.

- If the device supports Block 5, Général Midi Boop queries Block 6 for each declared channel
- If the device does NOT support Block 5, Général Midi Boop queries Block 6 for **channel 0** (default)

> **Note**: `octave_mode` (chromatic/diatonic/pentatonic) and `sync_delay` are Général Midi Boop-side settings, NOT transmitted via SysEx.

## 16. Instrument Capabilities Request

### Format
```
F0 7D 00 06 00 <channel> F7
```

### Byte breakdown
| Byte | Value | Description |
|------|-------|-------------|
| 0 | `F0` | Start SysEx |
| 1 | `7D` | Custom SysEx |
| 2 | `00` | GMB Manufacturer ID |
| 3 | `06` | Block 6 (Instrument Capabilities) |
| 4 | `00` | Request flag |
| 5 | `0x00-0x0F` | Target MIDI channel (0-15) |
| 6 | `F7` | End SysEx |

**Size**: 7 bytes

## 17. Instrument Capabilities Response

### Format (variable length)
```
F0 7D 00 06 01 <version> <channel>
  <gm_program> <type_id> <subtype_id>
  <note_selection_mode> <note_range_min> <note_range_max> <polyphony>
  <num_selected_notes> [<note>...]
  <num_supported_ccs> [<cc>...]
  <name_length> [<name_chars>...]
F7
```

### Field table

| Offset | Size | Field | Type | Description |
|--------|------|-------|------|-------------|
| 0 | 1 | Start | `F0` | SysEx start |
| 1 | 1 | Protocol | `7D` | Custom SysEx |
| 2 | 1 | Manufacturer | `00` | GeneralMidiBoop |
| 3 | 1 | Block ID | `06` | Instrument Capabilities |
| 4 | 1 | Reply Flag | `01` | Response |
| 5 | 1 | Block Version | `uint8` | Format version (currently 01) |
| 6 | 1 | Channel | `uint8` | MIDI channel (0-15) |
| 7 | 1 | GM Program | `uint8` | General MIDI program (0-127, 0x7F = undefined) |
| 8 | 1 | Type ID | `uint8` | Instrument type (see Block 5 table) |
| 9 | 1 | Subtype ID | `uint8` | Subtype within type (0x00 = unspecified) |
| 10 | 1 | Note Selection Mode | `uint8` | 0 = range, 1 = discrete |
| 11 | 1 | Note Range Min | `uint8` | Lowest playable note (0-127) |
| 12 | 1 | Note Range Max | `uint8` | Highest playable note (0-127) |
| 13 | 1 | Polyphony | `uint8` | Max simultaneous notes (1-127) |
| 14 | 1 | Num Selected Notes | `uint8` | Count of discrete notes (0 if range mode) |
| 15..14+N | N | Selected Notes | `uint8[]` | Each note 0-127 (only if discrete mode) |
| 15+N | 1 | Num Supported CCs | `uint8` | Count of supported CC controllers |
| 16+N..15+N+M | M | Supported CCs | `uint8[]` | Each CC number 0-127 |
| 16+N+M | 1 | Name Length | `uint8` | Instrument name length (0-32) |
| 17+N+M..16+N+M+L | L | Name | `string` | ASCII printable characters |
| last | 1 | End | `F7` | SysEx end |

### Message size examples

| Use case | Selected Notes | CCs | Name | Total |
|----------|---------------|-----|------|-------|
| Piano (range mode, 10 CCs, 16-char name) | 0 | 10 | 16 | ~43 bytes |
| Drum kit (47 discrete notes, 5 CCs, 10-char name) | 47 | 5 | 10 | ~79 bytes |
| Minimal synth (range mode, no CCs, 8-char name) | 0 | 0 | 8 | ~26 bytes |

All well under the recommended ~256 byte SysEx limit.

## 18. Subtype ID Encoding

Subtype IDs are **relative to their parent type_id**. Index 0x00 always means "unspecified".

### piano (type_id = 0x01)

| ID | Subtype Key | Label | GM |
|----|-------------|-------|----|
| `0x00` | — | Unspecified | — |
| `0x01` | `acoustic_grand` | Acoustic Grand | 0 |
| `0x02` | `bright_acoustic` | Bright Acoustic | 1 |
| `0x03` | `electric_grand` | Electric Grand | 2 |
| `0x04` | `honky_tonk` | Honky-tonk | 3 |
| `0x05` | `electric_piano_1` | Electric Piano 1 | 4 |
| `0x06` | `electric_piano_2` | Electric Piano 2 | 5 |
| `0x07` | `harpsichord` | Harpsichord | 6 |
| `0x08` | `clavinet` | Clavinet | 7 |

### chromatic_percussion (type_id = 0x02)

| ID | Subtype Key | Label | GM |
|----|-------------|-------|----|
| `0x00` | — | Unspecified | — |
| `0x01` | `celesta` | Celesta | 8 |
| `0x02` | `glockenspiel` | Glockenspiel | 9 |
| `0x03` | `music_box` | Music Box | 10 |
| `0x04` | `vibraphone` | Vibraphone | 11 |
| `0x05` | `marimba` | Marimba | 12 |
| `0x06` | `xylophone` | Xylophone | 13 |
| `0x07` | `tubular_bells` | Tubular Bells | 14 |
| `0x08` | `dulcimer` | Dulcimer | 15 |

### organ (type_id = 0x03)

| ID | Subtype Key | Label | GM |
|----|-------------|-------|----|
| `0x00` | — | Unspecified | — |
| `0x01` | `drawbar` | Drawbar Organ | 16 |
| `0x02` | `percussive_organ` | Percussive Organ | 17 |
| `0x03` | `rock_organ` | Rock Organ | 18 |
| `0x04` | `church_organ` | Church Organ | 19 |
| `0x05` | `reed_organ` | Reed Organ | 20 |
| `0x06` | `accordion` | Accordion | 21 |
| `0x07` | `harmonica` | Harmonica | 22 |
| `0x08` | `tango_accordion` | Tango Accordion | 23 |

### guitar (type_id = 0x04)

| ID | Subtype Key | Label | GM |
|----|-------------|-------|----|
| `0x00` | — | Unspecified | — |
| `0x01` | `nylon` | Nylon Guitar | 24 |
| `0x02` | `steel` | Steel Guitar | 25 |
| `0x03` | `jazz` | Jazz Guitar | 26 |
| `0x04` | `clean` | Clean Guitar | 27 |
| `0x05` | `muted` | Muted Guitar | 28 |
| `0x06` | `overdrive` | Overdrive Guitar | 29 |
| `0x07` | `distortion` | Distortion Guitar | 30 |
| `0x08` | `harmonics` | Guitar Harmonics | 31 |

### bass (type_id = 0x05)

| ID | Subtype Key | Label | GM |
|----|-------------|-------|----|
| `0x00` | — | Unspecified | — |
| `0x01` | `acoustic` | Acoustic Bass | 32 |
| `0x02` | `finger` | Finger Bass | 33 |
| `0x03` | `pick` | Pick Bass | 34 |
| `0x04` | `fretless` | Fretless Bass | 35 |
| `0x05` | `slap_1` | Slap Bass 1 | 36 |
| `0x06` | `slap_2` | Slap Bass 2 | 37 |
| `0x07` | `synth_bass_1` | Synth Bass 1 | 38 |
| `0x08` | `synth_bass_2` | Synth Bass 2 | 39 |

### strings (type_id = 0x06)

| ID | Subtype Key | Label | GM |
|----|-------------|-------|----|
| `0x00` | — | Unspecified | — |
| `0x01` | `violin` | Violin | 40 |
| `0x02` | `viola` | Viola | 41 |
| `0x03` | `cello` | Cello | 42 |
| `0x04` | `contrabass` | Contrabass | 43 |
| `0x05` | `tremolo` | Tremolo Strings | 44 |
| `0x06` | `pizzicato` | Pizzicato Strings | 45 |
| `0x07` | `harp` | Harp | 46 |
| `0x08` | `timpani` | Timpani | 47 |

### ensemble (type_id = 0x07)

| ID | Subtype Key | Label | GM |
|----|-------------|-------|----|
| `0x00` | — | Unspecified | — |
| `0x01` | `string_ensemble_1` | String Ensemble 1 | 48 |
| `0x02` | `string_ensemble_2` | String Ensemble 2 | 49 |
| `0x03` | `synth_strings_1` | Synth Strings 1 | 50 |
| `0x04` | `synth_strings_2` | Synth Strings 2 | 51 |
| `0x05` | `choir_aahs` | Choir Aahs | 52 |
| `0x06` | `voice_oohs` | Voice Oohs | 53 |
| `0x07` | `synth_voice` | Synth Voice | 54 |
| `0x08` | `orchestra_hit` | Orchestra Hit | 55 |

### brass (type_id = 0x08)

| ID | Subtype Key | Label | GM |
|----|-------------|-------|----|
| `0x00` | — | Unspecified | — |
| `0x01` | `trumpet` | Trumpet | 56 |
| `0x02` | `trombone` | Trombone | 57 |
| `0x03` | `tuba` | Tuba | 58 |
| `0x04` | `muted_trumpet` | Muted Trumpet | 59 |
| `0x05` | `french_horn` | French Horn | 60 |
| `0x06` | `brass_section` | Brass Section | 61 |
| `0x07` | `synth_brass_1` | Synth Brass 1 | 62 |
| `0x08` | `synth_brass_2` | Synth Brass 2 | 63 |

### reed (type_id = 0x09)

| ID | Subtype Key | Label | GM |
|----|-------------|-------|----|
| `0x00` | — | Unspecified | — |
| `0x01` | `soprano_sax` | Soprano Sax | 64 |
| `0x02` | `alto_sax` | Alto Sax | 65 |
| `0x03` | `tenor_sax` | Tenor Sax | 66 |
| `0x04` | `baritone_sax` | Baritone Sax | 67 |
| `0x05` | `oboe` | Oboe | 68 |
| `0x06` | `english_horn` | English Horn | 69 |
| `0x07` | `bassoon` | Bassoon | 70 |
| `0x08` | `clarinet` | Clarinet | 71 |

### pipe (type_id = 0x0A)

| ID | Subtype Key | Label | GM |
|----|-------------|-------|----|
| `0x00` | — | Unspecified | — |
| `0x01` | `piccolo` | Piccolo | 72 |
| `0x02` | `flute` | Flute | 73 |
| `0x03` | `recorder` | Recorder | 74 |
| `0x04` | `pan_flute` | Pan Flute | 75 |
| `0x05` | `bottle` | Blown Bottle | 76 |
| `0x06` | `shakuhachi` | Shakuhachi | 77 |
| `0x07` | `whistle` | Whistle | 78 |
| `0x08` | `ocarina` | Ocarina | 79 |

### synth_lead (type_id = 0x0B)

| ID | Subtype Key | Label | GM |
|----|-------------|-------|----|
| `0x00` | — | Unspecified | — |
| `0x01` | `square` | Square Lead | 80 |
| `0x02` | `sawtooth` | Sawtooth Lead | 81 |
| `0x03` | `calliope` | Calliope Lead | 82 |
| `0x04` | `chiff` | Chiff Lead | 83 |
| `0x05` | `charang` | Charang Lead | 84 |
| `0x06` | `voice_lead` | Voice Lead | 85 |
| `0x07` | `fifths` | Fifths Lead | 86 |
| `0x08` | `bass_lead` | Bass + Lead | 87 |

### synth_pad (type_id = 0x0C)

| ID | Subtype Key | Label | GM |
|----|-------------|-------|----|
| `0x00` | — | Unspecified | — |
| `0x01` | `new_age` | New Age Pad | 88 |
| `0x02` | `warm` | Warm Pad | 89 |
| `0x03` | `polysynth` | Polysynth Pad | 90 |
| `0x04` | `choir` | Choir Pad | 91 |
| `0x05` | `bowed` | Bowed Pad | 92 |
| `0x06` | `metallic` | Metallic Pad | 93 |
| `0x07` | `halo` | Halo Pad | 94 |
| `0x08` | `sweep` | Sweep Pad | 95 |

### synth_effects (type_id = 0x0D)

| ID | Subtype Key | Label | GM |
|----|-------------|-------|----|
| `0x00` | — | Unspecified | — |
| `0x01` | `rain` | FX Rain | 96 |
| `0x02` | `soundtrack` | FX Soundtrack | 97 |
| `0x03` | `crystal` | FX Crystal | 98 |
| `0x04` | `atmosphere` | FX Atmosphere | 99 |
| `0x05` | `brightness` | FX Brightness | 100 |
| `0x06` | `goblins` | FX Goblins | 101 |
| `0x07` | `echoes` | FX Echoes | 102 |
| `0x08` | `sci_fi` | FX Sci-Fi | 103 |

### ethnic (type_id = 0x0E)

| ID | Subtype Key | Label | GM |
|----|-------------|-------|----|
| `0x00` | — | Unspecified | — |
| `0x01` | `sitar` | Sitar | 104 |
| `0x02` | `banjo` | Banjo | 105 |
| `0x03` | `shamisen` | Shamisen | 106 |
| `0x04` | `koto` | Koto | 107 |
| `0x05` | `kalimba` | Kalimba | 108 |
| `0x06` | `bagpipe` | Bagpipe | 109 |
| `0x07` | `fiddle` | Fiddle | 110 |
| `0x08` | `shanai` | Shanai | 111 |

### drums (type_id = 0x0F)

| ID | Subtype Key | Label | GM |
|----|-------------|-------|----|
| `0x00` | — | Unspecified | — |
| `0x01` | `tinkle_bell` | Tinkle Bell | 112 |
| `0x02` | `agogo` | Agogo | 113 |
| `0x03` | `steel_drums` | Steel Drums | 114 |
| `0x04` | `woodblock` | Woodblock | 115 |
| `0x05` | `taiko` | Taiko | 116 |
| `0x06` | `melodic_tom` | Melodic Tom | 117 |
| `0x07` | `synth_drum` | Synth Drum | 118 |
| `0x08` | `reverse_cymbal` | Reverse Cymbal | 119 |
| `0x09` | `standard_kit` | Standard Kit | — |
| `0x0A` | `jazz_kit` | Jazz Kit | — |
| `0x0B` | `electronic_kit` | Electronic Kit | — |
| `0x0C` | `brush_kit` | Brush Kit | — |
| `0x0D` | `orchestra_kit` | Orchestra Kit | — |

### sound_effects (type_id = 0x10)

| ID | Subtype Key | Label | GM |
|----|-------------|-------|----|
| `0x00` | — | Unspecified | — |
| `0x01` | `guitar_fret` | Fret Noise | 120 |
| `0x02` | `breath` | Breath Noise | 121 |
| `0x03` | `seashore` | Seashore | 122 |
| `0x04` | `bird` | Bird Tweet | 123 |
| `0x05` | `telephone` | Telephone Ring | 124 |
| `0x06` | `helicopter` | Helicopter | 125 |
| `0x07` | `applause` | Applause | 126 |
| `0x08` | `gunshot` | Gunshot | 127 |

## 19. Block 6 Example — Arduino/Teensy

### Piano instrument (range mode)

```c
void handleCapabilitiesRequest(uint8_t requestedChannel) {
    // Piano on channel 0
    if (requestedChannel != 0) return;  // No instrument on this channel

    const char* name = "Grand Piano";
    uint8_t nameLen = strlen(name);
    uint8_t supportedCCs[] = { 1, 7, 10, 11, 64, 67 };  // Mod, Vol, Pan, Expr, Sustain, Soft
    uint8_t numCCs = sizeof(supportedCCs);

    // Calculate total size
    int totalSize = 16 + 0 + numCCs + nameLen + 1;  // 0 selected notes (range mode)
    uint8_t response[totalSize];
    int pos = 0;

    // Header
    response[pos++] = 0xF0;
    response[pos++] = 0x7D;
    response[pos++] = 0x00;
    response[pos++] = 0x06;  // Block 6
    response[pos++] = 0x01;  // Reply

    // Block version + channel
    response[pos++] = 0x01;
    response[pos++] = 0;     // Channel 0

    // Identity
    response[pos++] = 0;     // GM program 0 (Acoustic Grand)
    response[pos++] = 0x01;  // Type: piano
    response[pos++] = 0x01;  // Subtype: acoustic_grand

    // Note capabilities
    response[pos++] = 0;     // Note selection mode: range
    response[pos++] = 21;    // Note range min: A0
    response[pos++] = 108;   // Note range max: C8
    response[pos++] = 88;    // Polyphony: 88

    // Selected notes (empty for range mode)
    response[pos++] = 0;     // Num selected notes: 0

    // Supported CCs
    response[pos++] = numCCs;
    for (int i = 0; i < numCCs; i++) {
        response[pos++] = supportedCCs[i];
    }

    // Name
    response[pos++] = nameLen;
    for (int i = 0; i < nameLen; i++) {
        response[pos++] = name[i];
    }

    // End
    response[pos++] = 0xF7;

    usbMIDI.sendSysEx(pos, response);
}
```

### Drum kit (discrete mode)

```c
void handleDrumCapabilities(uint8_t requestedChannel) {
    if (requestedChannel != 9) return;

    const char* name = "Rock Kit";
    uint8_t nameLen = strlen(name);

    // GM standard drum notes (subset)
    uint8_t drumNotes[] = {
        36, 38, 40, 41, 42, 43, 44, 45, 46,  // Kick, Snare, Toms, HH
        47, 48, 49, 50, 51, 55, 57            // Toms, Crash, Ride
    };
    uint8_t numNotes = sizeof(drumNotes);
    uint8_t supportedCCs[] = { 7, 10 };  // Volume, Pan
    uint8_t numCCs = sizeof(supportedCCs);

    int totalSize = 16 + numNotes + numCCs + nameLen + 1;
    uint8_t response[totalSize];
    int pos = 0;

    // Header
    response[pos++] = 0xF0;
    response[pos++] = 0x7D;
    response[pos++] = 0x00;
    response[pos++] = 0x06;
    response[pos++] = 0x01;

    response[pos++] = 0x01;  // Version
    response[pos++] = 9;     // Channel 9

    response[pos++] = 0x7F;  // GM program: undefined (drum kit)
    response[pos++] = 0x0F;  // Type: drums
    response[pos++] = 0x09;  // Subtype: standard_kit

    response[pos++] = 1;     // Note selection mode: discrete
    response[pos++] = 36;    // Note range min (informational)
    response[pos++] = 57;    // Note range max (informational)
    response[pos++] = 16;    // Polyphony

    // Selected notes (discrete list)
    response[pos++] = numNotes;
    for (int i = 0; i < numNotes; i++) {
        response[pos++] = drumNotes[i];
    }

    // Supported CCs
    response[pos++] = numCCs;
    for (int i = 0; i < numCCs; i++) {
        response[pos++] = supportedCCs[i];
    }

    // Name
    response[pos++] = nameLen;
    for (int i = 0; i < nameLen; i++) {
        response[pos++] = name[i];
    }

    response[pos++] = 0xF7;
    usbMIDI.sendSysEx(pos, response);
}
```

### Minimal test response

```
F0 7D 00 06 01  // Header + Reply
01              // Block version
00              // Channel 0
00 01 01        // GM=0, type=piano, subtype=acoustic_grand
00 15 6C 58     // range mode, min=21(A0), max=108(C8), polyphony=88
00              // 0 selected notes
02 01 40        // 2 CCs: Modulation(1), Sustain(64)
05 50 69 61 6E 6F  // Name: "Piano" (5 chars)
F7              // End
```

## 20. Block 6 Implementation Checklist

- [ ] Detect request `F0 7D 00 06 00 <channel> F7`
- [ ] Correct response header `F0 7D 00 06 01`
- [ ] Block version = `0x01`
- [ ] Channel matches requested channel (0-15)
- [ ] GM program (0-127 or 0x7F for undefined)
- [ ] Type ID and subtype ID consistent with Block 5 tables
- [ ] Note selection mode: 0=range, 1=discrete
- [ ] Note range min ≤ max (0-127)
- [ ] Polyphony (1-127)
- [ ] Selected notes array correct length (0 if range mode)
- [ ] Supported CCs array correct length
- [ ] Name: ASCII printable, length 0-32
- [ ] End with `F7`
- [ ] Feature flag bit 4 (`INSTRUMENT_CAPABILITIES`) set in Block 1 response

---

# Block 7 — String Instrument Config

## 21. Purpose

Block 7 provides physical configuration data specific to string instruments (guitar, bass, violin, etc.). It declares string count, fret count, tuning, and optional CC control for string/fret selection.

This block is **optional** and only relevant for instruments whose type is a string instrument (`guitar`, `bass`, `strings`, `ethnic` with string subtypes like `sitar`, `banjo`, `koto`, `shamisen`).

## 22. String Config Request

### Format
```
F0 7D 00 07 00 <channel> F7
```

### Byte breakdown
| Byte | Value | Description |
|------|-------|-------------|
| 0 | `F0` | Start SysEx |
| 1 | `7D` | Custom SysEx |
| 2 | `00` | GMB Manufacturer ID |
| 3 | `07` | Block 7 (String Instrument Config) |
| 4 | `00` | Request flag |
| 5 | `0x00-0x0F` | Target MIDI channel (0-15) |
| 6 | `F7` | End SysEx |

**Size**: 7 bytes

## 23. String Config Response

### Format (variable length)
```
F0 7D 00 07 01 <version> <channel>
  <num_strings> <num_frets> <is_fretless> <capo_fret>
  <cc_enabled> <cc_string_number> <cc_fret_number>
  <tuning[num_strings]>
F7
```

### Field table

| Offset | Size | Field | Type | Description |
|--------|------|-------|------|-------------|
| 0 | 1 | Start | `F0` | SysEx start |
| 1 | 1 | Protocol | `7D` | Custom SysEx |
| 2 | 1 | Manufacturer | `00` | GeneralMidiBoop |
| 3 | 1 | Block ID | `07` | String Instrument Config |
| 4 | 1 | Reply Flag | `01` | Response |
| 5 | 1 | Block Version | `uint8` | Format version (currently 01) |
| 6 | 1 | Channel | `uint8` | MIDI channel (0-15) |
| 7 | 1 | Num Strings | `uint8` | Number of strings (1-6) |
| 8 | 1 | Num Frets | `uint8` | Number of frets (0-36, 0 = fretless) |
| 9 | 1 | Is Fretless | `uint8` | 0 = fretted, 1 = fretless |
| 10 | 1 | Capo Fret | `uint8` | Capo position (0 = no capo, 1-36) |
| 11 | 1 | CC Enabled | `uint8` | 0 = no CC control, 1 = CC control enabled |
| 12 | 1 | CC String Number | `uint8` | CC for string selection (default: 20) |
| 13 | 1 | CC Fret Number | `uint8` | CC for fret selection (default: 21) |
| 14..13+N | N | Tuning | `uint8[]` | MIDI note per string, lowest to highest |
| last | 1 | End | `F7` | SysEx end |

### Message size

| Instrument | Strings | Total size |
|------------|---------|------------|
| Guitar (6 strings) | 6 | 21 bytes |
| Bass (4 strings) | 4 | 19 bytes |
| Violin (4 strings) | 4 | 19 bytes |
| Ukulele (4 strings) | 4 | 19 bytes |
| Banjo (5 strings) | 5 | 20 bytes |

### Standard tuning reference

| Instrument | Tuning (MIDI notes) |
|------------|---------------------|
| Guitar standard | `40, 45, 50, 55, 59, 64` (E2, A2, D3, G3, B3, E4) |
| Guitar Drop D | `38, 45, 50, 55, 59, 64` (D2, A2, D3, G3, B3, E4) |
| Bass 4-string | `28, 33, 38, 43` (E1, A1, D2, G2) |
| Bass 5-string | `23, 28, 33, 38, 43` (B0, E1, A1, D2, G2) |
| Violin | `55, 62, 69, 76` (G3, D4, A4, E5) |
| Viola | `48, 55, 62, 69` (C3, G3, D4, A4) |
| Cello | `36, 43, 50, 57` (C2, G2, D3, A3) |
| Ukulele standard | `67, 60, 64, 69` (G4, C4, E4, A4) |

## 24. Block 7 Example — Arduino/Teensy

### Guitar 6 strings, standard tuning, with CC control

```c
void handleStringConfigRequest(uint8_t requestedChannel) {
    if (requestedChannel != 1) return;  // Guitar on channel 1

    uint8_t tuning[] = { 40, 45, 50, 55, 59, 64 };  // E2 A2 D3 G3 B3 E4
    uint8_t numStrings = sizeof(tuning);

    uint8_t response[15 + numStrings];
    int pos = 0;

    // Header
    response[pos++] = 0xF0;
    response[pos++] = 0x7D;
    response[pos++] = 0x00;
    response[pos++] = 0x07;  // Block 7
    response[pos++] = 0x01;  // Reply

    // Block version + channel
    response[pos++] = 0x01;
    response[pos++] = 1;     // Channel 1

    // String config
    response[pos++] = numStrings;  // 6 strings
    response[pos++] = 22;         // 22 frets
    response[pos++] = 0;          // Not fretless
    response[pos++] = 0;          // No capo

    // CC control
    response[pos++] = 1;          // CC enabled
    response[pos++] = 20;         // CC20 for string selection
    response[pos++] = 21;         // CC21 for fret selection

    // Tuning (lowest to highest string)
    for (int i = 0; i < numStrings; i++) {
        response[pos++] = tuning[i];
    }

    // End
    response[pos++] = 0xF7;

    usbMIDI.sendSysEx(pos, response);
}
```

### Minimal test response (4-string bass)

```
F0 7D 00 07 01  // Header + Reply
01              // Block version
02              // Channel 2
04              // 4 strings
18              // 24 frets
00              // Not fretless
00              // No capo
01 14 15        // CC enabled, CC20 string, CC21 fret
1C 21 26 2B     // Tuning: E1(28) A1(33) D2(38) G2(43)
F7              // End
```

Decoded: 4-string bass, 24 frets, standard tuning, CC control on CC20/CC21.

## 25. Block 7 Implementation Checklist

- [ ] Detect request `F0 7D 00 07 00 <channel> F7`
- [ ] Correct response header `F0 7D 00 07 01`
- [ ] Block version = `0x01`
- [ ] Channel matches requested channel (0-15)
- [ ] Num strings (1-6)
- [ ] Num frets (0-36)
- [ ] Is fretless (0 or 1)
- [ ] Capo fret (0-36)
- [ ] CC enabled (0 or 1)
- [ ] CC string/fret numbers (0-127)
- [ ] Tuning array length = num_strings
- [ ] Each tuning note (0-127)
- [ ] Total size = 15 + num_strings bytes
- [ ] End with `F7`
- [ ] Feature flag bit 5 (`STRING_CONFIG`) set in Block 1 response

---

# Auto-Configuration Flow

## 26. Overview

Général Midi Boop supports three levels of auto-configuration depending on which blocks the device implements. The protocol is designed so that simpler devices need less code.

### Level 1 — Identity only (Block 1)

Simplest implementation. The device identifies itself but Général Midi Boop cannot auto-configure instruments.

```
Général Midi Boop ──► Block 1 Request (F0 7D 00 01 00 F7)
           ◄── Block 1 Response (52 bytes, features = 0x00)
           → Registers device
           → Assumes 1 instrument on channel 0
           → User configures capabilities manually via InstrumentSettings modal
```

### Level 2 — Single instrument auto-config (Block 1 + Block 6)

The device declares its capabilities. Général Midi Boop auto-configures without user intervention.

```
Général Midi Boop ──► Block 1 Request
           ◄── Block 1 Response (features bit 4 = INSTRUMENT_CAPABILITIES)
           ──► Block 6 Request (channel = 0, default)
           ◄── Block 6 Response (capabilities for channel 0)
           → Auto-configures the instrument on channel 0
           → capabilities_source = 'sysex'
```

### Level 3 — Multi-instrument full auto-config (Block 1 + 5 + 6 + 7)

Full discovery and configuration of all instruments on the device.

```
Général Midi Boop ──► Block 1 Request
           ◄── Block 1 Response (features bits 3,4,5)
           ──► Block 5 Request
           ◄── Block 5 Response (N instruments with channels, types)
           ──► Block 6 Request (channel 0) ──► Block 6 Request (channel 1) ──► ...
           ◄── Block 6 Responses (capabilities per instrument)
           ──► Block 7 Request (channel 1)   // Only for string instruments
           ◄── Block 7 Response (string config)
           → Auto-configures all instruments
           → capabilities_source = 'sysex'
```

## 27. Général Midi Boop Decision Logic

```
1. Send Block 1 Identity Request
2. Wait for response (timeout = comm_timeout, default 5000ms)
3. If no response → device is not GeneralMidiBoop-compatible, STOP

4. Parse Block 1 response, read feature flags

5. DISCOVER INSTRUMENTS:
   If feature flag bit 3 (INSTRUMENT_DESCRIPTOR) is set:
     → Send Block 5 Request
     → Parse response → get list of (channel, gm_program, type_id)
   Else:
     → Assume single instrument: [(channel=0, gm_program=unknown, type=unknown)]

6. For each instrument in the list:

   a. AUTO-CONFIGURE CAPABILITIES:
      If feature flag bit 4 (INSTRUMENT_CAPABILITIES) is set:
        → Send Block 6 Request for this channel
        → Parse response → save to instruments_latency table:
            gm_program, instrument_type, instrument_subtype,
            note_range_min, note_range_max, note_selection_mode,
            selected_notes, supported_ccs, polyphony, custom_name
        → Set capabilities_source = 'sysex'
      Else:
        → Use gm_program from Block 5 to detect type via InstrumentTypeConfig
        → Leave detailed capabilities for manual configuration

   b. AUTO-CONFIGURE STRING INSTRUMENT:
      If feature flag bit 5 (STRING_CONFIG) is set
      AND instrument type ∈ {guitar, bass, strings, ethnic}:
        → Send Block 7 Request for this channel
        → Parse response → save to string_instruments table:
            num_strings, num_frets, tuning, is_fretless,
            capo_fret, cc_enabled, cc_string_number, cc_fret_number

7. Broadcast 'instruments_configured' event via WebSocket
```

## 28. Backward Compatibility

| Device supports | Général Midi Boop behavior |
|-----------------|---------------------|
| Block 1 only | Identity only, manual config. No change from current behavior. |
| Block 1 + Block 6 | Single instrument auto-configured on channel 0 |
| Block 1 + Block 5 | Multi-instrument discovery, but manual capability config |
| Block 1 + Block 5 + Block 6 | Full multi-instrument auto-config |
| Block 1 + Block 5 + Block 6 + Block 7 | Full auto-config including string instruments |

Feature flags in Block 1 guarantee that Général Midi Boop **never requests a block the device doesn't support**.

## 29. Fields NOT transmitted via SysEx

These fields are Général Midi Boop-side settings, configured by the user or measured by the system:

| Field | Reason |
|-------|--------|
| `sync_delay` | Measured/set by Général Midi Boop latency compensation system |
| `comm_timeout` | Général Midi Boop internal communication setting |
| `octave_mode` | User preference (chromatic/diatonic/pentatonic display) |
| `mac_address` | Discovered by system Bluetooth stack |
| `usb_serial_number` | Discovered by system USB enumeration |
| `tab_algorithm` | Général Midi Boop tablature processing preference |
| `capabilities_source` | Set automatically to 'sysex' when received via SysEx |

## 30. Complete Example — Multi-Instrument SysEx Dispatch

### Arduino/Teensy: handling all block requests

```c
#define FEATURES 0x00000038  // INSTRUMENT_DESCRIPTOR + CAPABILITIES + STRING_CONFIG

void checkSysExRequest() {
    if (!usbMIDI.read() || usbMIDI.getType() != usbMIDI.SystemExclusive) return;

    uint8_t* data = usbMIDI.getSysExArray();
    int length = usbMIDI.getSysExArrayLength();

    // Validate GeneralMidiBoop header: F0 7D 00 <block> <request=00>
    if (length < 6 || data[0] != 0xF0 || data[1] != 0x7D || data[2] != 0x00) return;

    uint8_t blockId = data[3];
    uint8_t direction = data[4];

    if (direction != 0x00) return;  // Not a request

    switch (blockId) {
        case 0x01:  // Block 1 - Identity
            handleIdentityRequest();
            break;

        case 0x05:  // Block 5 - Instrument Descriptor
            handleDescriptorRequest();
            break;

        case 0x06:  // Block 6 - Instrument Capabilities
            if (length >= 7) {
                handleCapabilitiesRequest(data[5]);  // data[5] = channel
            }
            break;

        case 0x07:  // Block 7 - String Config
            if (length >= 7) {
                handleStringConfigRequest(data[5]);  // data[5] = channel
            }
            break;
    }
}
```

---

# Block 8 — Lighting Capabilities

## L1. Purpose

Block 8 declares the capabilities of LEDs that are **physically on the
instrument and driven by the instrument's own microcontroller** (lit
keyboard, per-string LED harp, RGB pads, …). General Midi Boop uses it to
auto-configure the embedded-lighting subsystem without user intervention.
It is queried per channel exactly like Block 6/7. When the device does
not support Block 8, the user fills the same fields manually in the
instrument settings modal.

> Feature flag bit 6 (`LIGHTING`, `0x40`) must be set in the Block 1 reply.

## L2. Lighting Capabilities Request

```
F0 7D 00 08 00 <channel> F7
```

| Byte | Value | Description |
|------|-------|-------------|
| 0 | `F0` | Start SysEx |
| 1 | `7D` | Custom SysEx |
| 2 | `00` | GMB Manufacturer ID |
| 3 | `08` | Block 8 (Lighting Capabilities) |
| 4 | `00` | Request flag |
| 5 | `0x00-0x0F` | Target MIDI channel |
| 6 | `F7` | End SysEx |

**Size**: 7 bytes

## L3. Lighting Capabilities Response (25 bytes, fixed)

```
F0 7D 00 08 01 <version> <channel>
  <led_count_lsb> <led_count_msb>
  <addressing_model> <note_base> <note_count>
  <color_mode> <palette_size>
  <transports> <light_channel>
  <cc_brightness> <cc_mode> <cc_effect> <cc_effect_speed> <cc_guide>
  <local_effects> <flags> <min_update_interval_ms>
F7
```

| Offset | Field | Description |
|--------|-------|-------------|
| 5 | Block Version | `0x01` |
| 6 | Channel | 0-15 |
| 7-8 | LED Count | 14-bit, lsb then msb |
| 9 | Addressing | 0 global, 1 per-note, 2 string/fret, 3 zones, 4 strip |
| 10 | Note Base | per-note base MIDI note (`0x7F` = follows tessitura) |
| 11 | Note Count | LED count for per-note addressing |
| 12 | Color Mode | 0 on/off, 1 dimmable, 2 fixed, 3 palette, 4 RGB |
| 13 | Palette Size | entries when color_mode = 3, else 0 |
| 14 | Transports | bitmask: 1 autonomous, 2 note, 4 CC, 8 SysEx RGB |
| 15 | Light Channel | `0x7F` = same as instrument channel, else 0-15 |
| 16 | CC Brightness | CC# or `0x7F` (unused) |
| 17 | CC Mode | CC# or `0x7F` |
| 18 | CC Effect | CC# or `0x7F` |
| 19 | CC Effect Speed | CC# or `0x7F` |
| 20 | CC Guide | CC# or `0x7F` |
| 21 | Local Effects | bitmask of firmware-side effects |
| 22 | Flags | bit0 guide-capable, bit1 per-track color, bit2 idle anim |
| 23 | Min Update Interval | throttle hint in ms (serial 31250 baud) |

### Arduino/Teensy example — 88-LED RGB lit keyboard

```c
void handleLightingCapsRequest(uint8_t ch) {
    if (ch != 0) return;
    uint8_t r[] = {
        0xF0,0x7D,0x00,0x08,0x01, 0x01, 0,
        88 & 0x7F, (88 >> 7) & 0x7F,   // 88 LEDs
        1,                              // per-note
        21, 88,                         // base A0, 88 notes
        4, 0,                           // RGB, no palette
        0x02 | 0x08,                    // note + SysEx
        0x7F,                           // same channel
        0x7F,0x7F,0x7F,0x7F,0x7F,       // no CC
        0x00, 0x01, 5,                  // no local fx, guide-capable, 5ms
        0xF7
    };
    usbMIDI.sendSysEx(sizeof(r), r);
}
```

## L4. Block 8 Checklist

- [ ] Detect request `F0 7D 00 08 00 <channel> F7`
- [ ] Response header `F0 7D 00 08 0X`, version `0x01` (v1) or `0x02` (v2), ends `F7`
- [ ] Exactly 25 bytes (v1) or 28 bytes (v2)
- [ ] All data bytes 0-127 (LED count split lsb/msb)
- [ ] Feature flag bit 6 (`LIGHTING`) set in Block 1

## L5. Block 8 v2 — Lighting Message Catalog bitmask

Block 8 v2 appends a **21-bit** support bitmask (3 SysEx-safe bytes,
`b0 b1 b2` = bits 0-6, 7-13, 14-20) just before the closing `F7`. Each
bit *i* set means catalog message id *i* is implemented by the firmware.
Only bits 0-15 are currently defined; bits 16-20 are reserved.

```
… <min_update_interval_ms> <bitmask_b0> <bitmask_b1> <bitmask_b2> F7
```

GM Boop accepts both v1 and v2 transparently. For v1 replies it derives
the bitmask from `light_transports`, `light_color_mode`, `light_local_effects`
and `light_flags` so the UI can always render a uniform supported-messages
checklist (see `deriveMessagesBitmask` in
`src/lighting/instrument/InstrumentLightProtocol.js`).

### Catalog (ID → MIDI mapping)

| ID | Name             | Transport                              | Category |
|----|------------------|----------------------------------------|----------|
| 0  | All Off          | `CC <cc_brightness or 111> = 0`        | Control  |
| 1  | Master Brightness| `CC <cc_brightness> = 0-127`           | Control  |
| 2  | LED On/Off       | `Note On` vel>0 / vel=0                | Color    |
| 3  | LED Dimmable     | `Note On` vel = brightness 1-127       | Color    |
| 4  | LED Palette      | `Note On` vel = palette index 1-127    | Color    |
| 5  | LED RGB          | SysEx `0x09 / 0x01` `<ch> <led_l> <led_m> <r> <g> <b>` | Color |
| 6  | Range RGB        | SysEx `0x09 / 0x02`                    | Color    |
| 7  | Set All RGB      | SysEx `0x09 / 0x03`                    | Color    |
| 8  | Palette Upload   | SysEx `0x09 / 0x06`                    | Color    |
| 9  | Effect: Fade     | `CC <cc_effect> = 1` (+ `cc_effect_speed`) | Effect |
| 10 | Effect: Strobe   | `CC <cc_effect> = 2`                   | Effect   |
| 11 | Effect: Chase    | `CC <cc_effect> = 3`                   | Effect   |
| 12 | Effect: Rainbow  | `CC <cc_effect> = 4`                   | Effect   |
| 13 | Effect: Breathe  | `CC <cc_effect> = 5`                   | Effect   |
| 14 | Guide Mode       | `CC <cc_guide> = 0 / 127`              | Mode     |
| 15 | Idle Animation   | `CC <cc_effect> = 7`                   | Mode     |

### Arduino/Teensy v2 example (88-LED RGB lit keyboard)

```c
uint32_t MSG_MASK =
    (1u<<0) | (1u<<1) |          // All Off, Brightness
    (1u<<2) | (1u<<3) |          // LED on/off, dimmable
    (1u<<5) | (1u<<6) | (1u<<7); // LED RGB + Range + All

void appendBitmask(uint8_t* out, int* pos, uint32_t mask) {
    out[(*pos)++] = (mask      ) & 0x7F;
    out[(*pos)++] = (mask >>  7) & 0x7F;
    out[(*pos)++] = (mask >> 14) & 0x7F;
}
// … usual Block 8 fields with version byte = 0x02 …
appendBitmask(response, &pos, MSG_MASK);
response[pos++] = 0xF7;
```

---

# Block 9 — Lighting Control (command, no reply)

Realtime LED control. General Midi Boop sends these; the instrument never
replies. Modeled on the Novation Launchpad Pro/X RGB SysEx, re-homed
under the GMB `F0 7D 00` prefix. RGB bytes are 7-bit (0-127); the
firmware scales ×2 back to 0-254.

```
F0 7D 00 09 00 <sub> <payload…> F7
```

| Sub | Name | Payload |
|-----|------|---------|
| `0x01` | Set LED | `<ch> <led_lsb> <led_msb> <r> <g> <b>` |
| `0x02` | Set Range | `<ch> <s_lsb> <s_msb> <e_lsb> <e_msb> <r> <g> <b>` |
| `0x03` | Set All | `<ch> <r> <g> <b>` |
| `0x04` | Clear | `<ch>` |
| `0x05` | Brightness | `<ch> <0-127>` |
| `0x06` | Palette Entry | `<index> <r> <g> <b>` |
| `0x07` | Bulk Frame | `<ch> <count> [<led_lsb> <led_msb> <r> <g> <b>]…` |
| `0x08` | Effect | `<ch> <effectId> <speed> <r> <g> <b>` |

Bulk frames are chunked so each SysEx stays well under the recommended
~256-byte limit.

---

# Instrument Lighting Protocol — the 4 control tiers

General Midi Boop drives embedded LEDs using the highest tier the
`transports` bitmask allows. Conventions are copied from established
open-source projects so existing firmware ports are trivial:

| Tier | Method | Lineage |
|------|--------|---------|
| 0 | **Autonomous** — firmware lights its own LEDs from the notes it already receives; GM Boop only enables it + sets global brightness | — |
| 1 | **Note / velocity** — `Note On`, note = LED address, velocity = on/off \| brightness \| palette index; `Note Off`/vel 0 = off | Launchpad / Ableton Push / Synthesia / Piano LED Visualizer |
| 2 | **CC globals** — master brightness / mode / effect / speed / guide on the declared CC numbers (defaults in the 102-111 "undefined" range) | General MIDI CC convention |
| 3 | **SysEx RGB** — Block 9, full 24-bit per-LED colour, ranges, palette, effects | Launchpad Pro/X Programmer's Reference |

Notes / fields configured **GM-Boop-side** (never via SysEx): master
on/off (`instruments_latency.lighting_enabled`), per-track colours,
guide-mode toggle, active effect, brightness preference. These live in
`instrument_light_config` (migration 025) and are edited in the Lighting
modal "Par instrument" tab.

---

## 31. Global Implementation Checklist

### Device firmware

- [ ] **Block 1**: Identity request/response (52 bytes, required)
- [ ] **Feature flags**: Set bits 3-5 according to supported blocks
- [ ] **Block 5**: Instrument descriptor (if multi-instrument)
- [ ] **Block 6**: Instrument capabilities per channel (if auto-config)
- [ ] **Block 7**: String config per channel (if string instrument)
- [ ] **SysEx dispatch**: Route requests to correct handler based on block ID
- [ ] **All data bytes**: 0-127 (7-bit safe for SysEx)

### Général Midi Boop side

- [ ] Parse Block 1 and read feature flags
- [ ] If bit 3: send Block 5 request, parse instrument list
- [ ] If bit 4: send Block 6 request per channel, save capabilities
- [ ] If bit 5 + string type: send Block 7 request, save string config
- [ ] Default to channel 0 if Block 5 not supported
- [ ] Set `capabilities_source = 'sysex'` for auto-configured instruments
- [ ] Broadcast `instruments_configured` event after completion
- [ ] Respect `comm_timeout` for each SysEx round-trip
