# Serial MIDI via GPIO - Wiring Guide

This guide explains how to connect MIDI instruments to the Raspberry Pi GPIO pins using the standard serial MIDI protocol (31250 baud, 8N1).

## Table of Contents

1. [Commercial MIDI HATs (Plug & Play)](#commercial-midi-hats-plug--play)
2. [Raspberry Pi Compatibility](#raspberry-pi-compatibility)
3. [MIDI OUT Circuit (DIY)](#midi-out-circuit-gpio-tx-to-din-5-pin)
4. [MIDI IN Circuit (DIY)](#midi-in-circuit-din-5-pin-to-gpio-rx)
5. [Raspberry Pi Configuration](#raspberry-pi-configuration)
6. [UART Mapping by Model](#uart-mapping-by-model)
7. [Component List (DIY)](#component-list)
8. [Troubleshooting](#troubleshooting)

---

## Commercial MIDI HATs (Plug & Play)

If you do not wish to solder components, several commercial MIDI HATs plug directly into the Raspberry Pi 40-pin GPIO header. They include built-in opto-isolation and MIDI signal conditioning circuits.

### Blokas Pimidi (recommended for multi-port)

```
┌──────────────────────────────────────┐
│            Blokas Pimidi             │
│                                      │
│   MIDI IN 1  ○────┐                 │
│   MIDI OUT 1 ○────┤  Connecteur     │
│   MIDI IN 2  ○────┤  GPIO 40 pins   │
│   MIDI OUT 2 ○────┘  (I2C + 2 GPIO) │
│                                      │
│   Empilable : jusqu'a 4 HATs        │
│   = 8 IN + 8 OUT                    │
└──────────────────────────────────────┘
```

| Feature | Detail |
|---------|--------|
| **Ports** | 2x MIDI IN + 2x MIDI OUT (DIN-5) per HAT |
| **Stackable** | Up to 4 HATs = 8 IN / 8 OUT |
| **Interface** | I2C + 2 GPIO (leaves other GPIO pins free) |
| **Latency** | 1.28ms (loopback) |
| **Compatibility** | Pi 3, Pi 4, Pi 5 |
| **Connectors** | Standard DIN-5 |
| **API** | Python (pimidipy) |
| **Price** | ~99 EUR |
| **Website** | [blokas.io/pimidi](https://blokas.io/pimidi/) |

**Advantages**: Built-in 40-pin GPIO pass-through (stackable with other HATs), very low latency, Python API, up to 8x8 ports.

**Installation**:
```bash
# Install the Pimidi driver
curl https://blokas.io/pimidi/install.sh | sh

# Ports appear as standard ALSA MIDI ports
aconnect -l
```

> **Note**: The Pimidi uses I2C, not UART. It does not use `/dev/ttyAMA*` but appears as an ALSA MIDI device. Ma-est-tro will detect it as a standard system MIDI port (not via the Serial MIDI GPIO module).

---

### Blokas Pisound (MIDI + Audio)

```
┌──────────────────────────────────────┐
│           Blokas Pisound             │
│                                      │
│   Audio IN  (jack 6.35mm stereo)     │
│   Audio OUT (jack 6.35mm stereo)     │
│   MIDI IN   (DIN-5)                 │
│   MIDI OUT  (DIN-5)                 │
│   Bouton programmable                │
│   Gain + Volume pots                 │
│                                      │
│   DAC/ADC Burr-Brown 192kHz 24-bit   │
└──────────────────────────────────────┘
```

| Feature | Detail |
|---------|--------|
| **MIDI Ports** | 1x MIDI IN + 1x MIDI OUT (DIN-5) |
| **Audio** | Stereo IN/OUT, 192kHz 24-bit, Burr-Brown DAC/ADC |
| **Controls** | Gain, Volume, programmable button |
| **Compatibility** | Pi 1B+, Pi 2, Pi 3, Pi 4, Pi Zero |
| **Price** | ~89 USD |
| **Website** | [blokas.io/pisound](https://blokas.io/pisound/) |

**Advantages**: All-in-one MIDI + high-quality audio solution, ideal if you also need audio outputs.

> **Note**: The Pisound is not yet compatible with Pi 5. For Pi 5, see the **Pisound Micro** (~69 EUR) at [blokas.io/pisound-micro](https://blokas.io/pisound-micro/).

---

### Domoshop Slim MIDI Hat

```
┌──────────────────────────────────────┐
│        Domoshop Slim MIDI Hat        │
│                                      │
│   MIDI IN  (mini-jack 3.5mm TRS)     │
│   MIDI OUT (mini-jack 3.5mm TRS)     │
│                                      │
│   Connecte sur UART0 (GPIO14/15)     │
│   Buffer 5V integre                  │
│                                      │
│   v1.2+ : 16 I/O via MCP23017       │
└──────────────────────────────────────┘
```

| Feature | Detail |
|---------|--------|
| **Ports** | 1x MIDI IN + 1x MIDI OUT (3.5mm TRS mini-jack, DIN-5 adapters included) |
| **Interface** | Direct UART0 (GPIO14 TX, GPIO15 RX) |
| **Buffer** | 5V MIDI standard (better compatibility) |
| **I/O (v1.2+)** | 16 additional GPIO via MCP23017 (buttons, encoders, LEDs) |
| **Compatibility** | Pi Zero, Pi 3, Pi 4, Pi 5 |
| **Price** | ~25-36 EUR |
| **Website** | [domoshop.eu](https://domoshop.eu/collections/raspberry-pi-midi) |

**Advantages**: Compact, affordable, mini-jack connectors (space-saving), 5V buffer for maximum compatibility, additional GPIO on v1.2+.

> **Note**: The Slim MIDI Hat uses UART0 (`/dev/ttyAMA0`). It is compatible with the Ma-est-tro Serial MIDI GPIO module. Enable it in the settings and the `/dev/ttyAMA0` port will be detected automatically.

**Installation**:
```bash
# /boot/config.txt (or /boot/firmware/config.txt)
enable_uart=1
dtoverlay=disable-bt      # Free UART0 for MIDI

# Permissions
sudo usermod -aG dialout $USER
sudo reboot
```

---

### OSA Electronics MIDI Board

| Feature | Detail |
|---------|--------|
| **Ports** | 1x MIDI IN + 1x MIDI OUT (DIN-5) |
| **Interface** | Direct UART0 (GPIO14/15) |
| **Compatibility** | Pi A+, B+, Pi 2, Pi 3, Pi 4, Pi 5 |
| **Zynthian** | Compatible |
| **Website** | [osaelectronics.com](https://www.osaelectronics.com/product/midi-board-for-raspberry-pi/) |

**Advantages**: Simple, standard DIN-5 connectors, comprehensive documentation with setup guide.

> **Note**: Uses UART0 like the Domoshop. Compatible with the Ma-est-tro Serial MIDI module.

---

### Comparison Table

| HAT | MIDI Ports | Audio | Stackable | Interface | Pi 5 | Price |
|-----|-----------|-------|-----------|-----------|------|------|
| **Pimidi** | 2 IN + 2 OUT | No | Yes (x4 = 8x8) | I2C | Yes | ~99 EUR |
| **Pisound** | 1 IN + 1 OUT | Yes (192kHz) | No | SPI | No* | ~89 USD |
| **Slim MIDI Hat** | 1 IN + 1 OUT | No | No | UART | Yes | ~25-36 EUR |
| **OSA MIDI Board** | 1 IN + 1 OUT | No | No | UART | Yes | ~20-30 EUR |

\* Pisound Micro available for Pi 5 (~69 EUR)

### Compatibility with Ma-est-tro

| HAT | Detection | Module Used |
|-----|-----------|-------------|
| **Pimidi** | Automatic (ALSA MIDI) | System MIDI ports (like USB) |
| **Pisound** | Automatic (ALSA MIDI) | System MIDI ports (like USB) |
| **Slim MIDI Hat** | Via `/dev/ttyAMA0` | **Serial MIDI GPIO** (enable in settings) |
| **OSA MIDI Board** | Via `/dev/ttyAMA0` | **Serial MIDI GPIO** (enable in settings) |

> I2C/SPI-based HATs (Pimidi, Pisound) appear as standard MIDI ports and are automatically detected by Ma-est-tro without enabling the Serial MIDI GPIO option. UART-based HATs (Domoshop, OSA) require enabling the Serial MIDI GPIO option in the settings.

---

## DIY Build (Do It Yourself)

If you prefer to build your own MIDI circuit, the following sections detail the wiring component by component.

---

## Raspberry Pi Compatibility

| Model | Available UARTs | Notes |
|-------|-----------------|-------|
| **Pi 3B/3B+** | 1 (mini UART shared with BT) | Bluetooth must be disabled to free UART0 |
| **Pi 4B** | Up to 6 (UART0 + UART2-5 via overlays) | Recommended - best multi-UART support |
| **Pi 5** | Up to 5 native UARTs | Better DMA, precise MIDI timing |
| **Pi Zero 2W** | 1 (mini UART shared with BT) | Same as Pi 3, disable BT for UART0 |

---

## MIDI OUT Circuit (GPIO TX to DIN 5-pin)

The MIDI OUT circuit sends data from the Raspberry Pi to a MIDI instrument.

### Schematic

```
                    DIN-5 Female (vue de face, cote soudure)
                    ┌─────────────┐
                    │  5       4  │
                    │    2        │
                    │  1       3  │
                    └─────────────┘

Raspberry Pi                              DIN-5 Female
─────────────                             ────────────

GPIO TX ──── [220 ohm] ─────────────────── Pin 5 (Data)

3.3V ─────── [220 ohm] ─────────────────── Pin 4 (Source +5V via resistances)

GND ────────────────────────────────────── Pin 2 (Shield/GND)
```

### Explanation

- The MIDI specification uses a current loop. The Pi's TX switches the current through the resistors.
- The 220 ohm resistors limit the current to approximately 5mA (MIDI standard).
- **Important**: The Pi operates at 3.3V. Most modern MIDI receivers accept this voltage, but some older instruments (5V) may require a level buffer (74HCT04 or SN7407).

### Schematic with level buffer (optional, for 5V instruments)

```
GPIO TX ──── [220 ohm] ── 74HCT04 ── [220 ohm] ── DIN Pin 5
5V ───────── [220 ohm] ──────────────────────────── DIN Pin 4
GND ─────────────────────────────────────────────── DIN Pin 2
```

---

## MIDI IN Circuit (DIN 5-pin to GPIO RX)

The MIDI IN circuit receives data from a MIDI instrument to the Raspberry Pi. An optocoupler (6N138) is **required** to electrically isolate the two devices.

### Schematic

```
DIN-5 Female                  6N138 Optocoupler              Raspberry Pi
────────────                  ─────────────────              ─────────────

                              ┌────────┐
Pin 5 ── [220 ohm] ─────── 2 │ Anode  │
                              │        │
Pin 4 ───────────────────── 3 │Cathode │
                              │        │
                            5 │ GND    │──────────── GND
                              │        │
3.3V ─────── [470 ohm] ─── 8 │ Vcc    │
                              │        │
3.3V ─── [10k ohm] ──┬──── 6 │ Output │──────────── GPIO RX
                      │       │        │
                      │     7 │ Vb     │
                      │       └────────┘
                      │
                      └──── vers GPIO RX
```

### 6N138 Pinout

```
        ┌────────┐
    1 ──│ NC     │── 8  Vcc (3.3V via 470 ohm)
    2 ──│ Anode  │── 7  Vb (laisser flottant ou connecter a Vcc)
    3 ──│Cathode │── 6  Output (vers GPIO RX + pull-up 10k)
    4 ──│ NC     │── 5  GND
        └────────┘
```

### Explanation

- The optocoupler electrically isolates the MIDI transmitter from the Raspberry Pi (protection against ground loops).
- The 220 ohm resistor on the anode (pin 2) limits the current to the internal LED.
- The 10k ohm pull-up on the output (pin 6) ensures a clean signal for GPIO RX.
- A 1N4148 diode (optional) in anti-parallel across the anode can protect against polarity reversal.

### Full version with protection

```
DIN Pin 4 ──── ┐
               1N4148 (cathode vers pin 4)
DIN Pin 5 ── [220 ohm] ──┤
                          ├── 6N138 Pin 2 (Anode)
DIN Pin 4 ────────────────┘── 6N138 Pin 3 (Cathode)

3.3V ── [470 ohm] ── 6N138 Pin 8 (Vcc)
3.3V ── [10k ohm] ──┬── 6N138 Pin 6 (Output) ── GPIO RX
                     │
6N138 Pin 5 (GND) ── GND
```

---

## Raspberry Pi Configuration

### Raspberry Pi 3B/3B+

```bash
# /boot/config.txt (or /boot/firmware/config.txt on recent OS versions)

# Disable Bluetooth to free UART0 (PL011) on GPIO14/15
dtoverlay=disable-bt

# Disable the Bluetooth systemd service
sudo systemctl disable hciuart
```

After modification, a single UART is available: `/dev/ttyAMA0` (GPIO14 TX, GPIO15 RX).

### Raspberry Pi 4B (recommended)

```bash
# /boot/config.txt

# Option 1: Disable Bluetooth to free UART0
dtoverlay=disable-bt

# Option 2: Keep Bluetooth and use additional UARTs
# (UART0 remains used by BT, but UART2-5 are available)

# Enable additional UARTs (choose according to available GPIO):
dtoverlay=uart2    # UART2 on GPIO0 (TX) / GPIO1 (RX)
dtoverlay=uart3    # UART3 on GPIO4 (TX) / GPIO5 (RX)
dtoverlay=uart4    # UART4 on GPIO8 (TX) / GPIO9 (RX)
dtoverlay=uart5    # UART5 on GPIO12 (TX) / GPIO13 (RX)
```

### Raspberry Pi 5

```bash
# /boot/firmware/config.txt

# The Pi 5 uses a different chipset (RP1)
# UART0 is on GPIO14/15 by default
dtoverlay=uart0-pi5

# Additional UARTs
dtoverlay=uart2-pi5    # GPIO0/1
dtoverlay=uart3-pi5    # GPIO4/5
dtoverlay=uart4-pi5    # GPIO8/9
```

### User permissions (all models)

```bash
# Add user to the dialout group to access serial ports
sudo usermod -aG dialout $USER

# Reboot to apply
sudo reboot
```

### Verify the configuration

```bash
# List available serial ports
ls -la /dev/ttyAMA*

# Test 31250 baud rate
stty -F /dev/ttyAMA0 31250

# Check active overlays
dtoverlay -l
```

---

## UART Mapping by Model

### Raspberry Pi 4B

| UART | Device | GPIO TX | GPIO RX | Overlay |
|------|--------|---------|---------|---------|
| 0 | /dev/ttyAMA0 | GPIO14 (pin 8) | GPIO15 (pin 10) | `disable-bt` or default |
| 2 | /dev/ttyAMA1 | GPIO0 (pin 27) | GPIO1 (pin 28) | `uart2` |
| 3 | /dev/ttyAMA2 | GPIO4 (pin 7) | GPIO5 (pin 29) | `uart3` |
| 4 | /dev/ttyAMA3 | GPIO8 (pin 24) | GPIO9 (pin 21) | `uart4` |
| 5 | /dev/ttyAMA4 | GPIO12 (pin 32) | GPIO13 (pin 33) | `uart5` |

### Raspberry Pi 3B/3B+

| UART | Device | GPIO TX | GPIO RX | Notes |
|------|--------|---------|---------|-------|
| 0 (PL011) | /dev/ttyAMA0 | GPIO14 (pin 8) | GPIO15 (pin 10) | Requires `disable-bt` |
| 1 (mini) | /dev/ttyS0 | GPIO14 (pin 8) | GPIO15 (pin 10) | Default (unstable at 31250 baud) |

> **Warning**: The Pi 3 mini UART is tied to the CPU frequency and can be unstable at 31250 baud. Always use the PL011 (UART0) with `dtoverlay=disable-bt`.

### Raspberry Pi 5

| UART | Device | GPIO TX | GPIO RX | Overlay |
|------|--------|---------|---------|---------|
| 0 | /dev/ttyAMA0 | GPIO14 (pin 8) | GPIO15 (pin 10) | `uart0-pi5` |
| 2 | /dev/ttyAMA1 | GPIO0 (pin 27) | GPIO1 (pin 28) | `uart2-pi5` |
| 3 | /dev/ttyAMA2 | GPIO4 (pin 7) | GPIO5 (pin 29) | `uart3-pi5` |
| 4 | /dev/ttyAMA3 | GPIO8 (pin 24) | GPIO9 (pin 21) | `uart4-pi5` |

---

## Component List

### For one MIDI OUT port:

| Component | Quantity | Ref |
|-----------|----------|-----|
| 220 ohm 1/4W resistor | 2 | - |
| DIN-5 female connector | 1 | Panel-mount or cable |

### For one MIDI IN port:

| Component | Quantity | Ref |
|-----------|----------|-----|
| 6N138 optocoupler | 1 | (or 6N139, H11L1) |
| 220 ohm 1/4W resistor | 1 | LED protection |
| 470 ohm 1/4W resistor | 1 | Vcc power supply |
| 10k ohm 1/4W resistor | 1 | Output pull-up |
| 1N4148 diode | 1 | Protection (optional) |
| DIN-5 female connector | 1 | Panel-mount or cable |

### For a complete MIDI IN + OUT port:

Combine the two lists above. Components are inexpensive (<2 EUR per port).

### Commercial alternatives (plug & play)

See the [Commercial MIDI HATs](#commercial-midi-hats-plug--play) section at the beginning of this document for a full comparison of off-the-shelf solutions (Pimidi, Pisound, Slim MIDI Hat, OSA MIDI Board).

---

## Troubleshooting

### Port does not open

```
Permission denied for /dev/ttyAMA0
```
Solution: `sudo usermod -aG dialout $USER && sudo reboot`

### Port is not detected

```
Serial device not found: /dev/ttyAMA0
```
Solution: Check `/boot/config.txt` and UART overlays. Reboot after making changes.

### 31250 baud is not supported

The mini UART (`ttyS0`) on the Pi 3 may not reliably support 31250 baud.
Solution: Use the PL011 (`ttyAMA0`) with `dtoverlay=disable-bt`.

### Notes are corrupted or offset

- Check wiring (TX/RX inversion)
- Check common ground between the Pi and the instrument
- Verify that the 6N138 is properly powered (pin 8 = Vcc)

### Bluetooth no longer works

This is expected if `dtoverlay=disable-bt` is enabled. On Pi 4, use UART2-5 instead to keep Bluetooth.
