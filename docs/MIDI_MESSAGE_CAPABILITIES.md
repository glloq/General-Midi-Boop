# GMB v2 — semantic MIDI message capabilities

This document defines the optional per-instrument `messages` block consumed by General MIDI Boop.

The goal is to describe **what the active firmware configuration actually does**, not merely which MIDI status bytes its parser can decode.

## Tri-state semantics

Every known key has three possible states:

- `true`: the active instrument has a real musical or safety effect for this message.
- `false`: the firmware explicitly does not support it, or the handler is a no-op.
- absent: unknown / legacy descriptor. GMB stays permissive and does **not** filter the message.

This distinction is required for backward compatibility. Old firmware that predates this block must continue to work exactly as before.

## Descriptor shape

```json
{
  "channel": 0,
  "notes": { "mode": "range", "min": 48, "max": 84 },
  "messages": {
    "note_on": true,
    "note_off": true,
    "control_change": true,
    "program_change": false,
    "pitch_bend": true,
    "channel_aftertouch": true,
    "poly_aftertouch": false,
    "clock": false,
    "start": false,
    "continue": false,
    "stop": true,
    "system_reset": true
  },
  "expression": {
    "cc": [1, 7, 11, 64],
    "velocity": true,
    "pitch_bend": {
      "supported": true,
      "range_semitones": 2
    },
    "channel_aftertouch": true,
    "poly_aftertouch": false
  }
}
```

Known `messages` keys are:

- `note_on`
- `note_off`
- `control_change`
- `program_change`
- `pitch_bend`
- `channel_aftertouch`
- `poly_aftertouch`
- `clock`
- `start`
- `continue`
- `stop`
- `system_reset`

Unknown future keys are ignored by current hosts so the protocol remains extensible.

## Relationship with `expression`

`messages` answers **whether a MIDI message family has a real effect**.

`expression` answers **how the instrument uses musical expression**:

- `expression.cc`: exact musical CC numbers supported by the active configuration.
- `expression.velocity`: whether note velocity changes the physical/audio result.
- `expression.pitch_bend.supported`: legacy-compatible pitch-bend declaration.
- `expression.pitch_bend.range_semitones`: active bend range.
- `expression.channel_aftertouch`: legacy-compatible channel-pressure declaration.
- `expression.poly_aftertouch`: legacy-compatible poly-pressure declaration.

For older v2 descriptors without `messages`, GMB derives conservative support from `notes` and `expression`:

- a declared `notes` block implies Note On and Note Off;
- a declared `expression.cc` array implies Control Change support (`[]` means explicitly no musical CC);
- pitch bend and aftertouch are inherited from their existing expression fields;
- Program Change and realtime messages remain unknown unless explicitly declared.

Explicit `messages.*` values always take precedence over derived values.

## Parser support is not capability support

A firmware must not report a message as supported simply because its MIDI parser knows its byte length.

Examples:

- a parser may decode Program Change so running status remains correct while the instrument controller ignores it: advertise `program_change: false`;
- Clock/Start/Continue may be accepted but have no musical or synchronization effect: advertise them as `false`;
- Stop may perform an emergency/all-notes-off action: `stop: true` is valid even if the instrument does not implement transport playback;
- a configurable Program Change feature must be `true` only when that option is enabled in the active runtime configuration.

## Dynamic capabilities

The descriptor represents the **current validated runtime configuration**.

If enabling or disabling hardware/options changes message support, the firmware must:

1. rebuild the descriptor;
2. increment the descriptor revision;
3. emit the normal GMB v2 change notification when a return path is available.

Examples include:

- Slide Whistle pitch bend / channel aftertouch;
- flute breath/vibrato/jet-angle CCs;
- drum hi-hat CC and optional pitch processing;
- trumpet Program Change when saved-voicing selection is enabled.

## Host persistence

Migration `035_midi_message_capabilities.sql` adds `instruments_latency.midi_message_support` as JSON.

GMB stores the normalized tri-state declaration and mirrors explicit pitch-bend support into the existing `pitch_bend_enabled` flag used by the virtual keyboard. Missing pitch-bend information never overwrites a pre-existing/manual flag.

The runtime policy is deliberately backward-compatible: **only an explicit `false` may suppress a MIDI message.**
