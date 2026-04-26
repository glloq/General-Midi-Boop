# Lighting

Drive stage and ambient lighting in sync with MIDI playback. Source: [`src/lighting/`](https://github.com/glloq/General-Midi-Boop/tree/main/src/lighting).

![Lighting](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/lumiere.png?raw=true)

## Drivers

Every driver extends [`BaseLightingDriver`](https://github.com/glloq/General-Midi-Boop/blob/main/src/lighting/BaseLightingDriver.js) and exposes a uniform set of operations to the [`LightingManager`](https://github.com/glloq/General-Midi-Boop/blob/main/src/lighting/LightingManager.js).

| Driver | File | Use case |
|---|---|---|
| **GPIO LED Strips** | [`GpioStripDriver.js`](https://github.com/glloq/General-Midi-Boop/blob/main/src/lighting/GpioStripDriver.js) | WS2812 strips on Raspberry Pi GPIO via `pigpio` / `rpi-ws281x-native` |
| **GPIO LEDs** | [`GpioLedDriver.js`](https://github.com/glloq/General-Midi-Boop/blob/main/src/lighting/GpioLedDriver.js) | Simple on/off LEDs |
| **ArtNet DMX** | [`ArtNetDriver.js`](https://github.com/glloq/General-Midi-Boop/blob/main/src/lighting/ArtNetDriver.js) | Industry-standard DMX over Ethernet |
| **sACN / E1.31** | [`SacnDriver.js`](https://github.com/glloq/General-Midi-Boop/blob/main/src/lighting/SacnDriver.js) | Streaming ACN for DMX |
| **OSC** | [`OscLightDriver.js`](https://github.com/glloq/General-Midi-Boop/blob/main/src/lighting/OscLightDriver.js) | Open Sound Control consoles (QLab, etc.) |
| **HTTP** | [`HttpLightDriver.js`](https://github.com/glloq/General-Midi-Boop/blob/main/src/lighting/HttpLightDriver.js) | REST endpoints / webhooks (smart bulbs, hub gateways) |
| **MQTT** | [`MqttLightDriver.js`](https://github.com/glloq/General-Midi-Boop/blob/main/src/lighting/MqttLightDriver.js) | IoT brokers (Home Assistant, Zigbee2MQTT) |

## Effects Engine

[`LightingEffectsEngine`](https://github.com/glloq/General-Midi-Boop/blob/main/src/lighting/LightingEffectsEngine.js) composes effects (fade, strobe, chase, colour cycle, palette swap) and drives them in lockstep with playback. Effects are addressable per fixture, group, or universe.

## DMX Fixture Profiles

Fixture personalities (channel layouts for moving heads, par cans, etc.) live in [`DmxFixtureProfiles.js`](https://github.com/glloq/General-Midi-Boop/blob/main/src/lighting/DmxFixtureProfiles.js). Add a profile by exporting a new entry and reloading.

## MIDI Synchronisation

The lighting manager subscribes to playback events on the `EventBus` (`playback_started`, `playback_stopped`, MIDI position ticks) and triggers cues at the right moment. Latency offset can be applied per driver to compensate for network or DMX-buffer delays.

## Operator Workflow

1. Add a driver in the **Lighting** UI (host, port, universe, channel layout…).
2. Define one or more fixtures and assign them to a group.
3. Build an effect or drag a preset onto the timeline.
4. Hit play — lights and audio stay in sync.

## WebSocket Commands

A subset (full list in [[API-Reference]] / [`docs/API.md`](https://github.com/glloq/General-Midi-Boop/blob/main/docs/API.md)):

- `lighting_list_drivers`
- `lighting_set_color`
- `lighting_effect_start` / `lighting_effect_stop`
- `lighting_fixture_create` / `lighting_fixture_update`

## Permissions Note

GPIO drivers need the runtime user to be in the `gpio` group, and `pigpio` typically requires root or a `setcap` capability. The `Install.sh` script handles this; if you install manually see [[Troubleshooting]].
