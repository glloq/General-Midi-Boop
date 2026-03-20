# Tablature System for String Instruments - Implementation Documentation

## Overview

System to control real acoustic string instruments (guitar, bass, violin, etc.) via solenoids/servomotors/steppers through MIDI CC messages. Uses CC20 (string select) and CC21 (fret select) to indicate which string and fret to activate on the physical instrument.

One MIDI channel per instrument. The tablature editor provides a visual interface to define fingerings, with automatic conversion from MIDI notes.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  MidiEditorModal │────>│ TablatureEditor  │────>│TablatureRenderer│
│  (orchestrator)  │     │  (controller)    │     │  (canvas view)  │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                              │                         │
                              │    ┌──────────────────┐ │
                              └───>│FretboardDiagram  │ │
                                   │  (live preview)  │ │
                                   └──────────────────┘ │
                                                        │
┌─────────────────┐     ┌──────────────────┐           │
│   MidiPlayer    │────>│ CC20/CC21 inject │           │
│  (playback)     │     │ before noteOn    │           │
└─────────────────┘     └──────────────────┘           │
                                                        │
┌─────────────────┐     ┌──────────────────┐           │
│ StringInstrument│────>│TablatureConverter│<──────────┘
│   Database      │     │ (MIDI <-> Tab)   │
└─────────────────┘     └──────────────────┘
```

## Implementation Status

### COMPLETED (Phases 1-7)

#### Phase 1: Database & Backend Services
- **Migration**: `migrations/024_string_instruments.sql`
  - `string_instruments` table (device_id, channel, tuning, num_strings, num_frets, capo, fretless)
  - `string_instrument_tablatures` table (midi_file_id, channel, tablature_data JSON)
  - UNIQUE constraint on (device_id, channel), CASCADE deletes
- **Database module**: `src/storage/StringInstrumentDatabase.js`
  - Full CRUD for string instruments and tablature data
  - 19 built-in tuning presets (guitar variants, bass 4/5/6, ukulele, banjo, violin, viola, cello, contrabass)
  - Validation: 1-6 strings, 0-36 frets, MIDI notes 0-127
  - UPSERT pattern with ON CONFLICT
- **Database integration**: `src/storage/Database.js`
  - StringInstrumentDatabase imported and initialized
  - 13 delegate methods added
- **WebSocket commands**: `src/api/commands/StringInstrumentCommands.js`
  - 13 commands: string_instrument_create/update/delete/get/list, get_presets/apply_preset, tablature_save/get/get_by_file/delete, convert_from_midi/to_midi
  - Auto-discovered by CommandRegistry
- **Constants**: `src/constants.js`
  - Added `STRING_SELECT: 20` and `FRET_SELECT: 21` to MIDI_CC

#### Phase 2: Conversion Algorithm
- **TablatureConverter**: `src/midi/TablatureConverter.js`
  - `convertMidiToTablature(notes)`: Groups by tick, single notes pick closest to hand position, chords use backtracking
  - `convertTablatureToMidi(tabEvents)`: Returns `{notes, ccEvents}` with CC20/CC21 before each note
  - Backtracking algorithm with most-constrained-first ordering for chord assignment
  - Greedy fallback when backtracking fails
  - Position cost: open strings cheaper near nut, fretted notes use distance from hand
  - Constraint: max one note per string simultaneously
  - Static helpers: `midiNoteToName()`, `describeTuning()`, `isChordPlayable()`

#### Phase 3: Frontend Components
- **TablatureRenderer**: `public/js/views/components/TablatureRenderer.js` (~460 lines)
  - Canvas-based classic tablature: horizontal lines = strings, numbers = frets
  - Highest pitch string at top (standard tablature convention)
  - Measure/beat grid, playhead cursor, selection rectangles
  - Mouse: click select, drag rectangle select, double-click add/edit
  - Custom events: `tab:addevent`, `tab:editevent`, `tab:selectionchange`
  - Theme-aware (`body.dark-mode` detection)
  - Duration lines after fret numbers
- **FretboardDiagram**: `public/js/views/components/FretboardDiagram.js` (~310 lines)
  - Vertical fretboard: strings vertical, frets horizontal
  - Fret markers (dots at 3,5,7,9,12, double dots at 12,24)
  - Active positions with velocity-based opacity
  - Auto-scroll fret window to show active positions
  - String thickness proportional to pitch
- **TablatureEditor**: `public/js/views/components/TablatureEditor.js` (~430 lines)
  - Orchestrator: creates DOM, renderer, fretboard
  - `show(stringInstrument, midiNotes, channel)`: Init + convert MIDI
  - `convertFromMidi()`: Backend call with `_simpleMidiToTab()` fallback
  - `syncToMidi()`: Convert tab -> MIDI, update modal's fullSequence
  - `onMidiNotesChanged()`: Bidirectional sync with `isSyncing` guard
  - `updatePlayhead(tick)`: Updates renderer + fretboard during playback
  - Inline fret number input for editing
- **Styles**: `public/styles/tablature.css`
  - Panel layout, toolbar, TAB button, dark mode, responsive (hides fretboard < 768px)
- **HTML**: `public/index.html`
  - Added tablature.css link and 3 script tags (TablatureRenderer, FretboardDiagram, TablatureEditor)

#### Phase 4: Bidirectional Sync
- **MidiEditorModal.js**:
  - `syncFullSequenceFromPianoRoll()` notifies `tablatureEditor.onMidiNotesChanged()`
  - `toggleTablature()` method: checks single channel, queries string_instrument_get, creates TablatureEditor
  - `hasStringInstrument()` async check
  - Cleanup in `doClose()`
- **MidiEditorPlayback.js**:
  - `updatePlaybackCursor(tick)` calls `tablatureEditor.updatePlayhead(tick)` during playback

#### Phase 5: InstrumentCapabilitiesModal Integration
- **InstrumentCapabilitiesModal.js**:
  - `updateField()` detects when type is set to `guitar`/`bass`/`strings`
  - `autoCreateStringInstrument()`: Auto-creates string instrument config with matching preset
  - `_showStringInstrumentBanner()`: Notification banner (config created / already exists)
  - Preset mapping: guitar -> guitar_standard, bass -> bass_standard, strings -> guitar_standard

#### Phase 6: CC20/CC21 Injection in MidiPlayer
- **MidiPlayer.js**:
  - `_injectTablatureCCEvents()` called after `buildEventList()` during `loadFile()`
  - Loads tablature data from DB via `getTablaturesByFile(loadedFileId)`
  - Converts tab event ticks to seconds using tempo map
  - For each noteOn, finds matching tab event (same note, < 50ms tolerance)
  - Injects CC20 (string) and CC21 (fret) events 0.1ms before noteOn
  - Events re-sorted after injection

#### Phase 7: Internationalization
- All 28 locale files updated with `tablature` and `stringInstrument` sections
- Translated: toggleEditor, zoomIn/Out, deleteSelected, selectAll, enterFret, noStringInstrument, selectDeviceFirst, singleChannelRequired, converting, conversionFailed
- String instrument: title, name, numStrings, numFrets, tuning, tuningPreset, customTuning, isFretless, capoFret, noCapo, configCreated, configExists
- 14 tuning preset names translated per language

### NOT YET IMPLEMENTED / TO VERIFY

#### MidiEditorChannelPanel TAB Button
- `updateTablatureButton()` exists and shows/hides TAB button
- **Verify**: Button visibility logic (single channel + device selected + string instrument configured)
- **Verify**: Click handler for `toggle-tablature` action works end-to-end

#### End-to-End Testing Needed
- [ ] Create a string instrument via InstrumentCapabilitiesModal (select type guitar)
- [ ] Open MIDI editor with notes on a channel with string instrument
- [ ] Click TAB button -> tablature editor opens with auto-converted tab
- [ ] Edit a fret number in tablature -> verify piano roll note changes
- [ ] Edit a note in piano roll -> verify tablature updates
- [ ] Play MIDI -> verify playhead moves in tablature + fretboard shows positions
- [ ] Play MIDI via MidiPlayer backend -> verify CC20/CC21 sent before noteOn
- [ ] Save tablature -> reload -> verify persistence
- [ ] Test with bass (4 strings), violin, ukulele presets
- [ ] Test chords (multiple notes same tick)
- [ ] Test fretless instrument
- [ ] Test with capo

#### Potential Issues to Watch
1. **TablatureConverter inline CC constants**: Uses `const CC_STRING_SELECT = 20` instead of importing from constants.js (ES module compatibility reason). Keep in sync manually.
2. **Bidirectional sync loop prevention**: `isSyncing` flag in TablatureEditor. Verify it works under rapid edits.
3. **CC injection timing**: 0.1ms EPSILON before noteOn. May need adjustment for very fast passages.
4. **Tab event matching**: 50ms tolerance window. May miss notes if tempo map conversion has drift.
5. **DOM insertion point**: Tablature panel inserted before `.cc-resize-bar`. If CC editor layout changes, this may break.

## File Reference

### New Files (8)
| File | Lines | Purpose |
|------|-------|---------|
| `migrations/024_string_instruments.sql` | ~45 | Database schema |
| `src/storage/StringInstrumentDatabase.js` | ~400 | DB operations + presets |
| `src/api/commands/StringInstrumentCommands.js` | ~170 | WebSocket API |
| `src/midi/TablatureConverter.js` | ~350 | MIDI <-> Tab conversion |
| `public/js/views/components/TablatureRenderer.js` | ~460 | Canvas tablature view |
| `public/js/views/components/FretboardDiagram.js` | ~310 | Fretboard diagram |
| `public/js/views/components/TablatureEditor.js` | ~430 | Editor orchestrator |
| `public/styles/tablature.css` | ~200 | Styles + dark mode |

### Modified Files (8)
| File | Changes |
|------|---------|
| `src/storage/Database.js` | StringInstrumentDatabase init + 13 delegates |
| `src/constants.js` | STRING_SELECT: 20, FRET_SELECT: 21 |
| `src/midi/MidiPlayer.js` | `_injectTablatureCCEvents()` method |
| `public/index.html` | CSS + 3 JS script tags |
| `public/js/views/components/MidiEditorModal.js` | TAB button, toggleTablature(), hasStringInstrument() |
| `public/js/views/components/InstrumentCapabilitiesModal.js` | autoCreateStringInstrument() |
| `public/js/views/components/midi-editor/MidiEditorChannelPanel.js` | updateTablatureButton() |
| `public/js/views/components/midi-editor/MidiEditorPlayback.js` | Playhead sync to tablature |

### Locale Files (28)
All files in `public/locales/*.json` updated with `tablature` and `stringInstrument` sections.

## Key Data Structures

### Tab Event (TablatureConverter output / tablature_data storage)
```javascript
{
  tick: 480,        // MIDI tick position
  string: 3,        // String number (1-based, 1 = highest pitch)
  fret: 5,          // Fret number (0 = open string)
  velocity: 100,    // MIDI velocity
  duration: 240,    // Duration in ticks (gate)
  midiNote: 64,     // Original MIDI note number
  channel: 0        // MIDI channel
}
```

### CC Events (generated by convertTablatureToMidi)
```javascript
// Sent BEFORE each noteOn:
{ tick: 479, channel: 0, cc: 20, value: 3 }  // CC20 = string 3
{ tick: 479, channel: 0, cc: 21, value: 5 }  // CC21 = fret 5
// Then the noteOn:
{ tick: 480, channel: 0, note: 64, velocity: 100, duration: 240 }
```

### String Instrument Config (DB record)
```javascript
{
  id: 1,
  device_id: "device_abc",
  channel: 0,
  instrument_name: "Guitar Standard",
  num_strings: 6,
  num_frets: 24,
  tuning: [40, 45, 50, 55, 59, 64],  // EADGBE as MIDI notes
  is_fretless: 0,
  capo_fret: 0
}
```

### Tuning Presets Available
| Key | Name | Strings | Tuning (MIDI) |
|-----|------|---------|---------------|
| guitar_standard | Standard | 6 | E2 A2 D3 G3 B3 E4 |
| guitar_drop_d | Drop D | 6 | D2 A2 D3 G3 B3 E4 |
| guitar_open_g | Open G | 6 | D2 G2 D3 G3 B3 D4 |
| guitar_open_d | Open D | 6 | D2 A2 D3 F#3 A3 D4 |
| guitar_dadgad | DADGAD | 6 | D2 A2 D3 G3 A3 D4 |
| guitar_half_step_down | Half Step Down | 6 | Eb2 Ab2 Db3 Gb3 Bb3 Eb4 |
| guitar_full_step_down | Full Step Down | 6 | D2 G2 C3 F3 A3 D4 |
| guitar_open_e | Open E | 6 | E2 B2 E3 G#3 B3 E4 |
| bass_standard | Bass 4-String | 4 | E1 A1 D2 G2 |
| bass_5_standard | Bass 5-String | 5 | B0 E1 A1 D2 G2 |
| bass_6_standard | Bass 6-String | 6 | B0 E1 A1 D2 G2 C3 |
| bass_drop_d | Bass Drop D | 4 | D1 A1 D2 G2 |
| ukulele_standard | Ukulele | 4 | G4 C4 E4 A4 |
| banjo_standard | Banjo Open G | 5 | G4 D3 G3 B3 D4 |
| violin | Violin | 4 | G3 D4 A4 E5 |
| viola | Viola | 4 | C3 G3 D4 A4 |
| cello | Cello | 4 | C2 G2 D3 A3 |
| contrabass | Contrabass | 4 | E1 A1 D2 G2 |

## WebSocket Commands Reference

### String Instrument CRUD
```javascript
// Create
api.sendCommand('string_instrument_create', {
  device_id, channel, instrument_name, num_strings, num_frets, tuning, is_fretless, capo_fret
}) // -> { success, id }

// Update
api.sendCommand('string_instrument_update', {
  id, instrument_name, num_strings, num_frets, tuning, is_fretless, capo_fret
}) // -> { success }

// Delete
api.sendCommand('string_instrument_delete', { id })
// or: { device_id, channel }  // -> { success }

// Get
api.sendCommand('string_instrument_get', { id })
// or: { device_id, channel }  // -> { instrument }

// List
api.sendCommand('string_instrument_list', { device_id })
// or: {}  // -> { instruments }
```

### Tuning Presets
```javascript
api.sendCommand('string_instrument_get_presets')
// -> { presets: [{ key, name, num_strings, num_frets, tuning, is_fretless }] }

api.sendCommand('string_instrument_apply_preset', { preset_key: 'guitar_standard' })
// -> { preset: { name, num_strings, num_frets, tuning, is_fretless } }
```

### Tablature Data
```javascript
// Save
api.sendCommand('tablature_save', {
  midi_file_id, channel, string_instrument_id, tablature_data: [tabEvents...]
}) // -> { success, id }

// Get for a specific channel
api.sendCommand('tablature_get', { midi_file_id, channel })
// -> { tablature: { id, tablature_data, ... } }

// Get all for a file
api.sendCommand('tablature_get_by_file', { midi_file_id })
// -> { tablatures: [...] }

// Delete
api.sendCommand('tablature_delete', { midi_file_id, channel })
// -> { success }
```

### Conversion
```javascript
// MIDI notes -> tablature events
api.sendCommand('tablature_convert_from_midi', {
  device_id, channel, notes: [{t, n, v, g, c}, ...]
}) // -> { tabEvents: [...], instrument: {...} }

// Tablature events -> MIDI notes + CC events
api.sendCommand('tablature_convert_to_midi', {
  device_id, channel, tabEvents: [{tick, string, fret, velocity, duration, midiNote, channel}, ...]
}) // -> { notes: [...], ccEvents: [...] }
```

## Git Commits

```
77f761a feat: add string instrument data model and backend services (Phase 1)
747e0e5 feat: add TablatureConverter with bidirectional MIDI↔tab conversion (Phase 2)
8419fd8 feat: add tablature editor frontend with fretboard diagram (Phase 3)
e34f18a feat: complete tablature system phases 4-7
```

Branch: `claude/acoustic-instrument-control-iLPrj`
