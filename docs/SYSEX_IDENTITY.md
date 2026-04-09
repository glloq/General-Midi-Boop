# MidiMind SysEx Protocol - Instrument Developer Guide

## Overview

The MidiMind SysEx protocol enables custom identification and automatic configuration of DIY instruments via the SysEx 0x7D protocol. It supports both single-instrument devices and multi-instrument controllers.

**Protocol**: Custom SysEx (Educational/Development use)
**Manufacturer ID**: 0x00 (MidiMind)

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

### Common Header Format

All MidiMind SysEx messages share this header structure:
```
F0 7D 00 <block_id> <direction> [<data>...] F7
```
- `F0` : SysEx start
- `7D` : Custom SysEx (Educational/Development)
- `00` : MidiMind Manufacturer ID
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
| 2 | `00` | MidiMind Manufacturer ID |
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
| 2 | 1 | Manufacturer | `00` | MidiMind |
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

### Decoding (MidiMind side - reference)
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
| 6-31 | *Reserved* | — | Future use |

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
    response[pos++] = 0x00;  // MidiMind Manufacturer
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

## 8. Implementation Checklist

- [ ] Detect request `F0 7D 00 01 00 F7`
- [ ] Correct response header `F0 7D 00 01 01`
- [ ] Block version = `0x01`
- [ ] Device ID 7-bit encoded (5 bytes)
- [ ] Device Name padded to 32 bytes with NULL
- [ ] Firmware version (3 bytes)
- [ ] Feature flags 7-bit encoded (5 bytes)
- [ ] End with `F7`
- [ ] Total size = exactly 52 bytes
