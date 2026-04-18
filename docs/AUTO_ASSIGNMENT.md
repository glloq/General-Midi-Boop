# MIDI Auto-Assignment & Adaptation System

> Comprehensive guide to Ma-est-tro's automatic MIDI channel assignment and instrument adaptation system.

## Table of Contents

1. [Overview](#overview)
2. [System Architecture](#system-architecture)
3. [Channel Analysis](#channel-analysis)
4. [Scoring Algorithm](#scoring-algorithm)
5. [Transposition & Adaptation](#transposition--adaptation)
6. [Octave Wrapping](#octave-wrapping)
7. [Drum Note Mapping](#drum-note-mapping)
8. [Cache Management](#cache-management)
9. [API Reference](#api-reference)
10. [Usage Guide](#usage-guide)
11. [Configuration](#configuration)
12. [Best Practices](#best-practices)
13. [Troubleshooting](#troubleshooting)

---

## Overview

Ma-est-tro can automatically analyze a MIDI file and assign each channel to the best-suited connected instrument. The system evaluates instrument capabilities, generates compatibility scores (0-100), and can adapt MIDI data (transposition, octave wrapping, drum remapping) to fit available hardware.

### Components

| Module | File | Purpose |
|--------|------|---------|
| AutoAssigner | `src/midi/adaptation/AutoAssigner.js` | Orchestrates the full assignment pipeline |
| ChannelAnalyzer | `src/midi/routing/ChannelAnalyzer.js` | Analyzes MIDI file channels |
| InstrumentMatcher | `src/midi/adaptation/InstrumentMatcher.js` | Scores instrument compatibility |
| DrumNoteMapper | `src/midi/adaptation/DrumNoteMapper.js` | Intelligent drum note remapping |
| MidiTransposer | `src/midi/adaptation/MidiTransposer.js` | Note transposition |
| ScoringConfig | `src/midi/adaptation/ScoringConfig.js` | Scoring weights and thresholds |
| AnalysisCache | `src/midi/playback/AnalysisCache.js` | LRU cache for analysis results |

### Processing Pipeline

```
File Selection → Channel Analysis → Instrument Scoring → Assignment → Adaptation → Play
                      │                     │                              │
                ChannelAnalyzer      InstrumentMatcher          MidiTransposer
                                           │                   DrumNoteMapper
                                     ScoringConfig
```

---

## System Architecture

```
┌──────────────────────────────────────────────────────┐
│                  AutoAssignModal (UI)                  │
│  Channel list │ Suggestions │ Preview │ Apply button  │
└──────────────────────┬───────────────────────────────┘
                       │ WebSocket
┌──────────────────────┼───────────────────────────────┐
│                 AutoAssigner                           │
│                      │                                │
│    ┌─────────────────┼─────────────────┐              │
│    ▼                 ▼                 ▼              │
│ ChannelAnalyzer  InstrumentMatcher  DrumNoteMapper    │
│    │                 │                 │              │
│    ▼                 ▼                 ▼              │
│ AnalysisCache    ScoringConfig    MidiTransposer      │
└──────────────────────────────────────────────────────┘
```

---

## Channel Analysis

The `ChannelAnalyzer` extracts detailed information from each MIDI channel:

### Extracted Data Per Channel

| Field | Type | Description |
|-------|------|-------------|
| `noteRange` | `{min, max}` | Lowest and highest MIDI notes used |
| `noteDistribution` | `Map<note, count>` | Frequency of each note |
| `polyphony` | `{max, avg}` | Maximum and average simultaneous notes |
| `usedCCs` | `number[]` | List of Control Change numbers used |
| `primaryProgram` | `number` | Most-used GM program number |
| `estimatedType` | `string` | Detected instrument type with confidence |
| `density` | `number` | Notes per second |

### Instrument Type Detection

9 types are detected based on channel characteristics:

| Type | Detection Criteria |
|------|-------------------|
| `drums` | Channel 10 (index 9), or percussion program (112-127) |
| `bass` | Low note range, programs 32-39 |
| `piano` | Programs 0-7, wide range |
| `strings` | Programs 40-55, sustained notes |
| `organ` | Programs 16-23 |
| `lead` | Programs 80-87, monophonic tendency |
| `pad` | Programs 88-95, sustained chords |
| `brass` | Programs 56-63 |
| `percussive` | Programs 112-119 |

### General MIDI Program Categories

| Range | Category | Examples |
|-------|----------|---------|
| 0-7 | Piano | Acoustic Grand, Electric Piano |
| 8-15 | Chromatic Percussion | Celesta, Glockenspiel, Vibraphone |
| 16-23 | Organ | Hammond, Church, Accordion |
| 24-31 | Guitar | Acoustic, Electric, Distortion |
| 32-39 | Bass | Acoustic, Electric, Slap |
| 40-47 | Strings | Violin, Viola, Cello, Ensemble |
| 48-55 | Ensemble | Choir, Orchestra Hit |
| 56-63 | Brass | Trumpet, Trombone, French Horn |
| 64-71 | Reed | Saxophone, Oboe, Clarinet |
| 72-79 | Pipe | Flute, Recorder, Pan Flute |
| 80-87 | Synth Lead | Square, Sawtooth |
| 88-95 | Synth Pad | New Age, Warm, Polysynth |
| 96-103 | Synth Effects | Rain, Soundtrack |
| 104-111 | Ethnic | Sitar, Banjo, Shamisen |
| 112-119 | Percussive | Tinkle Bell, Steel Drums |
| 120-127 | Sound Effects | Guitar Fret Noise, Gunshot |

---

## Scoring Algorithm

Each instrument receives a compatibility score from 0 to 100 based on 6 weighted criteria.

### Score Breakdown

| Criterion | Max Points | Weight |
|-----------|-----------|--------|
| Program Match | 30 | 30% |
| Note Range | 25 | 25% |
| Polyphony | 15 | 15% |
| Control Changes | 15 | 15% |
| Instrument Type | 10 | 10% |
| Channel Special | 5 | 5% |
| **Total** | **100** | **100%** |

### 1. Program Match (30 points)

- **Exact match** (same GM program): 30 points
- **Category match** (same program family, e.g., both piano programs): 20 points
- **No match**: 0 points

### 2. Note Range (25 points)

Evaluates how well the channel's notes fit within the instrument's range.

Three evaluation modes:
- **Direct fit**: All notes within range → full score
- **With transposition**: Notes fit after shifting by N semitones → partial score minus transposition penalty
- **With octave wrapping**: Notes wrapped into available range → partial score

For **discrete mode** instruments (drum pads), scoring checks individual note availability rather than continuous range.

### 3. Polyphony (15 points)

```
score = min(1, instrument.polyphony / channel.maxPolyphony) * 15
```

An instrument with equal or greater polyphony than the channel needs gets full marks.

### 4. Control Changes (15 points)

```
supportRatio = supportedCCs.length / usedCCs.length
score = supportRatio * 15
```

Common CCs evaluated: Modulation (1), Volume (7), Pan (10), Expression (11), Sustain (64), Portamento (65), Soft Pedal (67), Reverb (91), Chorus (93), Pitch Bend.

### 5. Instrument Type (10 points)

Compares the detected channel type with the instrument's declared type:
- **Exact type match**: 10 points
- **Compatible type** (e.g., `piano` ↔ `keyboard`): 7 points
- **Partial match**: 3 points
- **No match**: 0 points

Score is further weighted by the type detection confidence level.

### 6. Channel Special (5 points)

- **Channel 9 (drums)** assigned to a drum instrument: +3 points
- **Exact GM program match** bonus: +2 points

---

## Transposition & Adaptation

When a channel's notes don't fit an instrument's range, the system calculates an optimal transposition.

### Center-Point Algorithm

```
channelCenter = (channel.noteRange.min + channel.noteRange.max) / 2
instrumentCenter = (instrument.noteRange.min + instrument.noteRange.max) / 2
rawShift = instrumentCenter - channelCenter
transposition = round(rawShift / 12) * 12  // Round to nearest octave
```

If the rounded transposition doesn't cover all notes, the algorithm tries ±1 octave and picks the best fit.

### Examples

| Scenario | Channel Range | Instrument Range | Transposition |
|----------|--------------|-----------------|---------------|
| Piano → Piano | C2-C7 | C2-C7 | 0 (no change) |
| High Piano → Low Piano | C5-C8 | C1-C5 | -24 (-2 octaves) |
| Bass → Piano | E1-E3 | C2-C7 | +24 (+2 octaves) |

---

## Octave Wrapping

When transposition alone isn't sufficient, octave wrapping maps out-of-range notes into the instrument's available octaves.

### How It Works

1. Determine the instrument's playable range
2. For each note outside the range:
   - If too low: shift up by octaves until within range
   - If too high: shift down by octaves until within range
3. Create a note mapping table

### Known Limitation

Octave wrapping can create **note duplicates** when multiple source notes from different octaves wrap to the same target note. This is flagged in the quality assessment.

---

## Drum Note Mapping

Drum instruments require special handling because each MIDI note represents a specific percussion sound rather than a pitch.

### Why Drums Are Different

| Aspect | Melodic Instruments | Drums |
|--------|-------------------|-------|
| MIDI Note | Pitch (C4, D5...) | Specific sound (Kick, Snare...) |
| Transposition | Shift by semitones | Not applicable |
| Mapping | Range-based | Function-based |
| MIDI Channel | Any (1-16) | Typically channel 10 |
| Standard | GM Program numbers | GM Drum Map (notes 35-81) |

### General MIDI Drum Map

| Note | Name | Category |
|------|------|----------|
| 35 | Acoustic Bass Drum | Kick |
| 36 | Bass Drum 1 | Kick |
| 37 | Side Stick | Snare Variation |
| 38 | Acoustic Snare | Snare |
| 39 | Hand Clap | Snare Variation |
| 40 | Electric Snare | Snare |
| 41 | Low Floor Tom | Tom |
| 42 | Closed Hi-Hat | Hi-Hat |
| 43 | High Floor Tom | Tom |
| 44 | Pedal Hi-Hat | Hi-Hat |
| 45 | Low Tom | Tom |
| 46 | Open Hi-Hat | Hi-Hat |
| 47 | Low-Mid Tom | Tom |
| 48 | Hi-Mid Tom | Tom |
| 49 | Crash Cymbal 1 | Cymbal |
| 50 | High Tom | Tom |
| 51 | Ride Cymbal 1 | Cymbal |
| 52 | Chinese Cymbal | Cymbal |
| 53 | Ride Bell | Cymbal |
| 54 | Tambourine | Latin |
| 55 | Splash Cymbal | Cymbal |
| 56 | Cowbell | Latin |
| 57 | Crash Cymbal 2 | Cymbal |
| 58 | Vibraslap | Misc |
| 59 | Ride Cymbal 2 | Cymbal |
| 60 | Hi Bongo | Latin |
| 61 | Low Bongo | Latin |
| 62 | Mute Hi Conga | Latin |
| 63 | Open Hi Conga | Latin |
| 64 | Low Conga | Latin |
| 65 | High Timbale | Latin |
| 66 | Low Timbale | Latin |
| 67 | High Agogo | Latin |
| 68 | Low Agogo | Latin |
| 69 | Cabasa | Latin |
| 70 | Maracas | Latin |
| 71 | Short Whistle | Misc |
| 72 | Long Whistle | Misc |
| 73 | Short Guiro | Latin |
| 74 | Long Guiro | Latin |
| 75 | Claves | Latin |
| 76 | Hi Wood Block | Misc |
| 77 | Low Wood Block | Misc |
| 78 | Mute Cuica | Latin |
| 79 | Open Cuica | Latin |
| 80 | Mute Triangle | Misc |
| 81 | Open Triangle | Misc |

### Drum Categories

The `DrumNoteMapper` groups notes by musical function for intelligent substitution:

**1. Kick (35-36)** — Rhythmic foundation
- Substitution order: 36 → 35 → 41 → 43

**2. Snare (37-40)** — Backbeat articulation
- Substitution order: 38 → 40 → 37 → 39

**3. Hi-Hat (42, 44, 46)** — Groove subdivision
- Substitution order: 42 → 44 → 46 → 54 → 70

**4. Toms (41, 43, 45, 47, 48, 50)** — Fills, organized low → high
- Distributed across available tom pads

**5. Cymbals - Crash (49, 55, 57)** — Section accents
- Substitution order: 49 → 57 → 55 → 51

**6. Cymbals - Ride (51, 53, 59)** — Pattern support
- Substitution order: 51 → 59 → 53 → 42

**7. Latin Percussion (54, 56, 60-68)** — Color/ornamentation
- Cross-category fallbacks to toms or misc

### Priority Matrix

| Priority | Notes | Weight | Required |
|----------|-------|--------|----------|
| **1 - Essential** | Kick, Snare, Closed Hi-Hat, Crash | 100, 100, 90, 70 | Yes |
| **2 - Important** | Open Hi-Hat, Tom Low, Tom High, Ride | 60, 50, 50, 40 | Recommended |
| **3 - Optional** | Tom Mid, Rim Shot, Hand Clap, Latin, Misc | 30, 25, 20, 15, 10 | Nice to have |

### 4-Stage Mapping Algorithm

1. **Analyze** target instrument capabilities (available notes, categories present)
2. **Classify** MIDI file drum notes by category and usage frequency
3. **Assign essential** notes first (kick → snare → hi-hat → crash), using substitution chains
4. **Assign remaining** by priority level, with substitution or omission for unavailable sounds

### Mapping Quality Score (0-100)

| Component | Weight | Description |
|-----------|--------|-------------|
| Essential preserved | 40% | Are kick, snare, hi-hat, crash mapped? |
| Important preserved | 30% | Are open hi-hat, toms, ride mapped? |
| Optional preserved | 15% | Are latin, misc percussion mapped? |
| Coverage ratio | 10% | % of MIDI notes that have a mapping |
| Accuracy ratio | 5% | % of exact matches vs substitutions |

### Device Scenarios

| Scenario | Pads | Typical Devices | Expected Score |
|----------|------|----------------|---------------|
| Complete Kit | 20+ | Roland TD-27, Yamaha DTX10K | 90-100 |
| Standard Kit | 12-15 | Roland TD-17, Yamaha DTX6K | 70-90 |
| Minimal Kit | 8-10 | Roland TD-1K, Yamaha DTX402 | 50-70 |
| Pad Controller | 16-25 | Akai MPD226, NI Maschine | 60-80 |
| Keyboard Pads | <8 | Akai MPK Mini, M-Audio Oxygen | 30-50 |

---

## Cache Management

Analysis results are cached to avoid re-computation.

| Setting | Value |
|---------|-------|
| Max entries | 100 |
| TTL | 10 minutes (600,000 ms) |
| Auto-cleanup | Every 5 minutes |
| Cache key | File ID (analysis), File ID + instruments hash (suggestions) |

The cache is automatically invalidated when:
- A MIDI file is modified
- Instrument configuration changes
- Cache TTL expires

---

## API Reference

### WebSocket Commands

#### `analyze_channel`

Analyze a MIDI file's channels.

```json
// Request
{ "command": "analyze_channel", "id": "1", "fileId": 42 }

// Response
{
  "type": "response", "id": "1",
  "data": {
    "channels": {
      "0": {
        "noteRange": { "min": 48, "max": 84 },
        "polyphony": { "max": 4, "avg": 2.1 },
        "primaryProgram": 0,
        "estimatedType": "piano",
        "typeConfidence": 0.92,
        "usedCCs": [1, 7, 10, 64],
        "density": 3.5
      }
    }
  }
}
```

#### `generate_assignment_suggestions`

Generate scored instrument suggestions per channel.

```json
// Request
{ "command": "generate_assignment_suggestions", "id": "2", "fileId": 42 }

// Response
{
  "type": "response", "id": "2",
  "data": {
    "suggestions": {
      "0": [
        {
          "deviceId": "usb-midi-1",
          "channel": 0,
          "score": 87,
          "scoreDetails": {
            "program": 30, "noteRange": 22, "polyphony": 15,
            "controlChanges": 10, "type": 8, "special": 2
          },
          "transposition": 0,
          "adaptations": []
        }
      ]
    },
    "autoSelection": { "0": "usb-midi-1" },
    "confidence": 0.85
  }
}
```

#### `apply_assignments`

Apply assignments, create adapted file copy, and configure routing.

```json
// Request
{
  "command": "apply_assignments", "id": "3",
  "fileId": 42,
  "assignments": {
    "0": { "deviceId": "usb-midi-1", "channel": 0, "transposition": 0, "octaveWrap": false }
  }
}

// Response
{
  "type": "response", "id": "3",
  "data": {
    "adaptedFileId": 43,
    "routingApplied": true,
    "stats": {
      "channelsModified": 1,
      "notesTransposed": 0,
      "notesRemapped": 0
    }
  }
}
```

---

## Usage Guide

1. **Open auto-assign**: Right-click a MIDI file → "Auto-Assign"
2. **Review analysis**: The system displays each channel with detected type, note range, polyphony, and density
3. **Review suggestions**: Each channel shows ranked instrument suggestions with compatibility scores
4. **Adjust options**: Toggle octave wrapping per channel if needed
5. **Preview**: Click "Preview" to hear the assignment before committing
6. **Apply**: Click "Apply" to create an adapted copy and set routing
7. **Play**: The adapted file is ready for playback with the assigned instruments

---

## Configuration

### ScoringConfig Weights

```javascript
{
  weights: { program: 30, noteRange: 25, polyphony: 15, controlChanges: 15, instrumentType: 10, channelSpecial: 5 },
  bonuses: { exactProgramMatch: 2, drumChannelMatch: 3 },
  penalties: { transpositionPerOctave: 3 },
  thresholds: { minimumScore: 20, goodScore: 60, excellentScore: 85 }
}
```

### Drum Mapping Options

```javascript
{
  mode: 'intelligent',        // 'intelligent' | 'closest' | 'strict'
  allowSubstitution: true,
  allowSharing: true,
  allowOmission: true,
  preserveEssentials: true,
  preferExactMatch: true,
  minQualityScore: 50,
  minEssentialCoverage: 0.75,
  warnOnLowQuality: true,
  suggestAlternatives: true
}
```

---

## Best Practices

### For MIDI File Creators

- Use **channel 10** (index 9) for drums — this is the GM standard
- Set correct **GM program numbers** on each channel
- Use standard **GM drum notes** (35-81) for maximum compatibility
- Document non-standard mappings if deviating from GM

### For Instrument Configuration

- Set **accurate note ranges** matching the physical instrument
- Define correct **polyphony limits**
- Choose the appropriate **instrument type**
- For drums: map **essential notes first** (kick, snare, hi-hat, crash)
- Set the **mode** correctly: `continuous` for melodic, `discrete` for pads

### Score Interpretation

| Score Range | Rating | Meaning |
|-------------|--------|---------|
| 85-100 | Excellent | Near-perfect match, minimal adaptation |
| 60-84 | Good | Solid match, some transposition may apply |
| 40-59 | Acceptable | Playable with compromises |
| 20-39 | Poor | Significant limitations, many adaptations |
| 0-19 | Incompatible | Not recommended for this channel |

---

## Troubleshooting

### Low scores (< 50)

- Check instrument configuration: is the note range correct?
- Verify the instrument type matches the channel content
- Ensure GM program numbers are set on instruments

### Drum mapping issues

- Verify channel 10 detection (drums on other channels may not be detected)
- Check that the instrument is configured in `discrete` mode
- Ensure essential drum notes (kick 36, snare 38, hi-hat 42, crash 49) are mapped

### No suggestions generated

- Ensure at least one instrument is connected and enabled
- Check that instruments have their capabilities configured
- Verify the MIDI file is valid and contains note data

### Wrong assignments

- Review instrument capabilities (note range, polyphony, type)
- Check for conflicting channel assignments (same instrument used on multiple channels)
- Try toggling octave wrapping for better range coverage

### Audio preview not working

- Ensure the browser supports Web Audio API
- Check that the built-in synthesizer is loaded
- Verify the MIDI file has valid note data on the selected channel
