# Interface — Lighting Control

The lighting control page configures and drives stage and ambient lighting in synchrony with MIDI playback. It manages drivers, fixtures, effects, and MIDI-triggered cue rules.

![Lighting page](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/lumiere.png?raw=true)

Source: [`public/js/features/LightingControlPage.js`](https://github.com/glloq/General-Midi-Boop/blob/main/public/js/features/LightingControlPage.js) and [`src/lighting/`](https://github.com/glloq/General-Midi-Boop/tree/main/src/lighting). Deep driver reference: [[Lighting]].

## Page Structure

The page is organised into four panels:

| Panel | Purpose |
|-------|---------|
| **Drivers** | Add and configure output backends |
| **Fixtures** | Map physical lights onto driver channels |
| **Groups** | Bundle fixtures for collective control |
| **Effects / Cues** | Build animated effects and MIDI-triggered rules |

A **master dimmer** slider and a **blackout** button are always visible at the top.

## Drivers

A driver is a connection to one lighting system. Add as many as needed.

| Driver | Typical use |
|--------|------------|
| **GPIO LED Strip** | WS2812 strip directly on Raspberry Pi GPIO |
| **GPIO LED** | Simple on/off LEDs on Pi GPIO pins |
| **ArtNet DMX** | Industry-standard DMX over Ethernet (artnet protocol) |
| **sACN / E1.31** | Streaming ACN for DMX universes |
| **OSC** | Open Sound Control (QLab, lighting consoles) |
| **HTTP** | REST webhooks — smart bulbs, hub gateways, custom firmware |
| **MQTT** | IoT brokers (Home Assistant, Zigbee2MQTT, Shelly, …) |

Each driver has its own configuration panel (IP/host, port, universe number, GPIO pin, topic, etc.). A status indicator shows whether the driver is connected and active.

## Fixtures

A fixture is a named logical light mapped to a range of driver channels.

| Field | Description |
|-------|-------------|
| **Name** | Label shown in the cue editor |
| **Driver** | Which backend handles this fixture |
| **Start channel** | First DMX / CC channel this fixture occupies |
| **Fixture profile** | Channel layout (dimmer, R/G/B, strobe, pan/tilt, …) — from the built-in profile library |
| **Group** | Optional group membership |

The profile library contains personalities for common moving heads, par cans, and LED bars. Custom profiles can be added to [`src/lighting/DmxFixtureProfiles.js`](https://github.com/glloq/General-Midi-Boop/blob/main/src/lighting/DmxFixtureProfiles.js).

## Groups

Group several fixtures together so that effects and cues can target them as one unit. Groups support:

- Collective colour set
- Collective dimmer override
- Staggered chases (offset per fixture within the group)

## Effects Engine

Effects run as time-based animations on one or more fixtures/groups.

| Effect | Description |
|--------|-------------|
| **Chase** | Pixel sweep across the group with configurable speed and direction |
| **Pulse** | Brightness envelope repeating on a beat |
| **Sparkle** | Random flicker at configurable density |
| **Rainbow** | Full-spectrum hue rotation |
| **Strobe** | On/off flash at a given frequency |
| **Fade** | Crossfade between two colours over time |
| **Colour animation** | Keyframe-based colour sequence |

Effects are beat-syncable: enable **BPM sync** to lock the effect tempo to the MIDI file's tempo track.

## MIDI-Learn & Cue Rules

Any effect or colour change can be bound to a MIDI event:

1. Click **"Add rule"** on a fixture or effect.
2. Press **"Learn"** — the next incoming CC, Note, or Program Change is captured.
3. Set the trigger condition (note on, CC threshold, velocity range, …).
4. The rule fires during playback whenever the condition is met.

Per-instrument rules are also available: a rule can target only notes on a specific MIDI channel, matching the instrument assignments set in [[Interface-Instrument-Creation]].

## Scene Management

A **scene** is a snapshot of the complete lighting state (all fixtures, effects, and cue rules). Operations:

- **Save scene** — name and store the current state.
- **Apply scene** — restore a previously saved state instantly.
- **Delete scene** — remove a stored scene.

Scenes are stored in the SQLite database and survive restarts.

## Master Controls

| Control | Effect |
|---------|--------|
| **Master dimmer (0–100 %)** | Scales the brightness of every fixture uniformly |
| **Blackout** | Instantly sets all outputs to zero, overriding all effects |

## MIDI Synchronisation

The lighting manager subscribes to playback events on the internal EventBus (`playback_started`, `playback_stopped`, position ticks). A per-driver **latency offset** can be configured to compensate for DMX-buffer or network delays so cues land on the beat.

## WebSocket API

A subset (full list in [[API-Reference]]):

```
lighting_list_drivers
lighting_add_driver / lighting_update_driver / lighting_remove_driver
lighting_list_fixtures / lighting_add_fixture / lighting_update_fixture
lighting_set_color
lighting_effect_start / lighting_effect_stop
lighting_scene_save / lighting_scene_apply
lighting_blackout
```

## Related Pages

- [[Lighting]] — driver architecture and backend reference
- [[Hardware-Integration]] — GPIO wiring for LED strips
- [[API-Reference]] — full WebSocket command reference
