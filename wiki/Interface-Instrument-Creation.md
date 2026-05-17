# Interface — Instrument Creation & Management

The instrument management interface is the central hub for registering, configuring, and fine-tuning every MIDI device connected to Général Midi Boop.

![Instruments page](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/instruments.png?raw=true)

Source files: [`public/js/features/InstrumentManagementPage.js`](https://github.com/glloq/General-Midi-Boop/blob/main/public/js/features/InstrumentManagementPage.js), [`public/js/features/InstrumentSettingsModal.js`](https://github.com/glloq/General-Midi-Boop/blob/main/public/js/features/InstrumentSettingsModal.js), [`public/js/features/InstrumentCapabilitiesModal.js`](https://github.com/glloq/General-Midi-Boop/blob/main/public/js/features/InstrumentCapabilitiesModal.js).

## Device Discovery

Devices appear automatically when connected:

| Transport | How it appears |
|-----------|---------------|
| **USB** | Detected on plug-in via OS MIDI enumeration |
| **Bluetooth LE** | Requires BLE scanning (button in the device panel) |
| **RTP-MIDI / Network** | Requires Network scanning or manual IP entry |
| **Serial UART** | Auto-detected on configured UART ports |

If a device supports the GMBoop SysEx identity protocol it is automatically named and pre-configured on first connection — see [[Instrument-Developer-Guide]].

## Instrument List

Each device card shows:

- Display name (editable)
- Connection type badge
- Enable / disable toggle
- Active MIDI channels
- Compatibility score (from the last [[Auto-Assignment]] run)

Click the card to open the full settings modal.

## Instrument Settings Modal

### Identity

| Field | Description |
|-------|-------------|
| **Display name** | Free-text label shown everywhere in the UI |
| **MIDI channel(s)** | Which channels 1–16 this instrument listens on |
| **Enable / disable** | Excluded instruments are skipped during playback and auto-assignment |

### Instrument Type & Capabilities

Click **"Edit capabilities"** to open the Capabilities sub-modal:

| Field | Description |
|-------|-------------|
| **Instrument type** | GM family (piano, guitar, bass, drums, …) — drives UI and adaptation logic |
| **Sub-type** | Specific voice within the family (e.g. acoustic grand, nylon guitar) |
| **GM program** | General MIDI program number 0–127 (0x7F = not applicable for drums) |
| **Note selection mode** | *Range* — contiguous from min to max; *Discrete* — explicit note list |
| **Note range min / max** | Lowest and highest playable MIDI note (0–127) |
| **Polyphony** | Maximum simultaneous notes the instrument can produce |
| **Supported CCs** | Control Change numbers the device responds to |

These values determine how MIDI files are adapted to the instrument. When the device sends a Block 6 SysEx response they are filled automatically (`capabilities_source = 'sysex'`).

A **unified instrument-preset block** now sits at the top of the *Notes & Capabilities* tab: pick a preset to fill the note range, polyphony and CC set from real GM capabilities (a chord library is included) in one click, then fine-tune. The modal layout has been condensed so the whole instrument fits without excessive scrolling. The **Organs** family has been merged into **Keyboards**, so organ instruments now sit under the keyboard family (and render on the standard piano in the [[Interface-Virtual-Piano]]).

### Latency Compensation

| Field | Description |
|-------|-------------|
| **Sync delay (ms)** | Per-instrument playback offset applied automatically |
| **Auto-calibrate** | Opens the [[Interface-Microphone|microphone calibration modal]] to measure the delay |

The system subtracts `sync_delay` from the note schedule so every device produces sound at the right moment regardless of its internal processing time.

### String Instrument Configuration

For instruments of type `guitar`, `bass`, `strings`, or ethnic string types, an extra panel unlocks:

| Field | Description |
|-------|-------------|
| **Number of strings** | Physical string count (1–6) |
| **Number of frets** | Fret count (0 = fretless) |
| **Tuning** | Open-string MIDI notes, lowest to highest |
| **Capo fret** | Capo position (0 = no capo) |
| **Is fretless** | Enables continuous pitch model |
| **CC string / fret** | CC numbers used to command string and fret selection on the hardware |

19 standard tuning presets are provided (guitar, bass, violin, ukulele, mandolin, …). When the device sends a Block 7 SysEx response this panel is filled automatically.

### Family-Specific Configuration

For a few instrument families, an extra panel inside *Notes & Capabilities* configures details that **drive the realistic layout shown in the [[Interface-Virtual-Piano]]**:

| Family | Panel | Drives |
|--------|-------|--------|
| **Accordion** (GM 21 / 23) | Stradella / free-bass left-hand board, configurable free-bass note range, C-system option | The accordion view's left-hand board and treble manual |
| **Bagpipe** (GM 109) | Drone picker on a mini-piano: enable each drone individually, a master toggle, and preset drone sets | Which drone tubes are drawn and sounded in the bagpipe view |
| **Harmonica** (GM 22) | Diatonic vs. chromatic, hole count, blow/draw mapping | The harmonica view's hole layout and slide button |
| **Harp** (GM 46) | The configured note / string selection | Which strings the harp view displays |

Changing these settings is reflected immediately the next time the virtual piano opens for that instrument.

### Hand Position

For automated pianos and motorised string instruments, the **"Hand position"** section enables the hand-planning subsystem. Full documentation: [[Interface-Hand-Management]].

## Multi-Instrument Devices

A single physical device (e.g. a Teensy with piano keys on channel 0 and a drum pad on channel 9) can host multiple virtual instruments. Use the **"Add instrument"** button inside the device card to register additional instruments on different channels. Block 5 SysEx auto-discovery populates this list automatically.

## Validation & Error Indicators

- A red badge on a device card means a required field (e.g. note range) is missing.
- The auto-assignment compatibility score turns orange below 70 and red below 40.
- Instruments with `enable = false` are grayed out and ignored by the playback engine.

## Related Pages

- [[Hardware-Integration]] — transport-level connection instructions
- [[Auto-Assignment]] — use instrument capabilities to route channels automatically
- [[Interface-Hand-Management]] — configure hand-position planning
- [[Instrument-Developer-Guide]] — build a device that auto-configures via SysEx
