// src/midi/TablatureConverter.js

/**
 * TablatureConverter — Bidirectional conversion between MIDI notes and tablature.
 *
 * MIDI → Tab:
 *   Given a sequence of MIDI notes and a string instrument config (tuning, frets, capo),
 *   assigns each note to a (string, fret) position, optimizing for minimal hand movement
 *   and ensuring no two simultaneous notes share the same string.
 *
 * Tab → MIDI:
 *   Converts (string, fret) positions back to MIDI note numbers and generates
 *   CC20 (string select) + CC21 (fret select) events before each note-on.
 */

// CC numbers for string instrument control (matches constants.js MIDI_CC)
const CC_STRING_SELECT = 20;  // Select string number (1-6)
const CC_FRET_SELECT = 21;    // Select fret position (0-36)

class TablatureConverter {

  /**
   * @param {Object} instrumentConfig - String instrument configuration
   * @param {number[]} instrumentConfig.tuning - MIDI note per string (low to high), e.g. [40,45,50,55,59,64]
   * @param {number} instrumentConfig.num_strings - Number of strings (1-6)
   * @param {number} instrumentConfig.num_frets - Number of frets (0 = fretless)
   * @param {boolean} instrumentConfig.is_fretless - Whether the instrument has no frets
   * @param {number} instrumentConfig.capo_fret - Capo position (shifts all open strings up)
   */
  constructor(instrumentConfig) {
    this.tuning = instrumentConfig.tuning;
    this.numStrings = instrumentConfig.num_strings;
    this.numFrets = instrumentConfig.num_frets;
    this.isFretless = instrumentConfig.is_fretless;
    this.capoFret = instrumentConfig.capo_fret || 0;

    // Effective open-string notes with capo applied
    this.effectiveTuning = this.tuning.map(note => note + this.capoFret);

    // Precompute the playable range per string
    this.stringRanges = this.effectiveTuning.map(openNote => ({
      min: openNote,
      max: this.isFretless ? openNote + 48 : openNote + this.numFrets
    }));
  }

  // ==========================================================================
  // MIDI → Tablature
  // ==========================================================================

  /**
   * Convert a MIDI note sequence to tablature positions.
   *
   * @param {Array<Object>} notes - MIDI notes sorted by tick
   *   Each note: { t: tick, n: midiNote (0-127), v: velocity (0-127), g: gate (duration in ticks), c: channel }
   * @returns {Array<Object>} Tablature events sorted by tick
   *   Each event: { tick, string (1-based), fret (0-based or float for fretless), velocity, duration, midiNote, channel }
   */
  convertMidiToTablature(notes) {
    if (!notes || notes.length === 0) return [];

    // Group simultaneous notes (same tick) into chords
    const chordGroups = this._groupByTick(notes);

    const tabEvents = [];
    let lastHandPosition = this._getDefaultHandPosition();

    for (const group of chordGroups) {
      const tick = group.tick;
      const chordNotes = group.notes;

      if (chordNotes.length === 1) {
        // Single note — pick best position closest to current hand
        const note = chordNotes[0];
        const positions = this._getPossiblePositions(note.n);

        if (positions.length === 0) {
          // Note out of range — skip with warning
          continue;
        }

        const best = this._pickClosest(positions, lastHandPosition);
        tabEvents.push({
          tick,
          string: best.string,
          fret: best.fret,
          velocity: note.v,
          duration: note.g,
          midiNote: note.n,
          channel: note.c
        });

        lastHandPosition = best.fret > 0 ? best.fret : lastHandPosition;
      } else {
        // Chord — optimize assignment across strings
        const assignment = this._assignChord(chordNotes, lastHandPosition);

        for (const entry of assignment) {
          tabEvents.push({
            tick,
            string: entry.string,
            fret: entry.fret,
            velocity: entry.velocity,
            duration: entry.duration,
            midiNote: entry.midiNote,
            channel: entry.channel
          });
        }

        // Update hand position to average fret of the chord (ignoring open strings)
        const frettedPositions = assignment.filter(e => e.fret > 0);
        if (frettedPositions.length > 0) {
          lastHandPosition = Math.round(
            frettedPositions.reduce((sum, e) => sum + e.fret, 0) / frettedPositions.length
          );
        }
      }
    }

    return tabEvents;
  }

  /**
   * Check if a MIDI note is playable on this instrument
   * @param {number} midiNote
   * @returns {boolean}
   */
  isNotePlayable(midiNote) {
    return this._getPossiblePositions(midiNote).length > 0;
  }

  /**
   * Get the full playable MIDI note range for this instrument
   * @returns {{ min: number, max: number }}
   */
  getPlayableRange() {
    const allMins = this.stringRanges.map(r => r.min);
    const allMaxs = this.stringRanges.map(r => r.max);
    return {
      min: Math.min(...allMins),
      max: Math.max(...allMaxs)
    };
  }

  // ==========================================================================
  // Tablature → MIDI
  // ==========================================================================

  /**
   * Convert tablature events back to MIDI notes with CC20/CC21 control messages.
   *
   * @param {Array<Object>} tabEvents - Tablature events
   *   Each: { tick, string (1-based), fret, velocity, duration, channel }
   * @returns {Object} { notes: Array<{t,n,v,g,c}>, ccEvents: Array<{tick,cc,value,channel}> }
   */
  convertTablatureToMidi(tabEvents) {
    if (!tabEvents || tabEvents.length === 0) return { notes: [], ccEvents: [] };

    const notes = [];
    const ccEvents = [];

    for (const event of tabEvents) {
      const stringIndex = event.string - 1; // Convert to 0-based
      if (stringIndex < 0 || stringIndex >= this.numStrings) continue;

      const openNote = this.effectiveTuning[stringIndex];
      const midiNote = this.isFretless
        ? Math.round(openNote + event.fret)
        : openNote + Math.round(event.fret);

      if (midiNote < 0 || midiNote > 127) continue;

      // Generate CC20 (string select) before the note
      ccEvents.push({
        tick: event.tick,
        cc: CC_STRING_SELECT,
        value: event.string,  // 1-based string number
        channel: event.channel || 0
      });

      // Generate CC21 (fret select) before the note
      ccEvents.push({
        tick: event.tick,
        cc: CC_FRET_SELECT,
        value: Math.round(event.fret),
        channel: event.channel || 0
      });

      // Generate MIDI note
      notes.push({
        t: event.tick,
        n: midiNote,
        v: event.velocity || 100,
        g: event.duration || 480,
        c: event.channel || 0
      });
    }

    // Sort by tick
    notes.sort((a, b) => a.t - b.t);
    ccEvents.sort((a, b) => a.tick - b.tick);

    return { notes, ccEvents };
  }

  /**
   * Convert a single tablature position to a MIDI note number
   * @param {number} string - 1-based string number
   * @param {number} fret - Fret number (0 = open)
   * @returns {number|null} MIDI note number, or null if invalid
   */
  tabPositionToMidiNote(string, fret) {
    const stringIndex = string - 1;
    if (stringIndex < 0 || stringIndex >= this.numStrings) return null;

    const midiNote = this.effectiveTuning[stringIndex] + fret;
    if (midiNote < 0 || midiNote > 127) return null;

    return midiNote;
  }

  /**
   * Convert a MIDI note to all possible tablature positions
   * @param {number} midiNote
   * @returns {Array<{string: number, fret: number}>} Possible positions (string is 1-based)
   */
  midiNoteToTabPositions(midiNote) {
    return this._getPossiblePositions(midiNote);
  }

  // ==========================================================================
  // Internal — Position Calculation
  // ==========================================================================

  /**
   * Get all possible (string, fret) positions for a MIDI note
   * @private
   * @param {number} midiNote
   * @returns {Array<{string: number, fret: number}>}
   */
  _getPossiblePositions(midiNote) {
    const positions = [];

    for (let i = 0; i < this.numStrings; i++) {
      const openNote = this.effectiveTuning[i];
      const fret = midiNote - openNote;

      if (fret < 0) continue;

      if (this.isFretless) {
        // Fretless: allow any positive position within a reasonable range (4 octaves)
        if (fret <= 48) {
          positions.push({ string: i + 1, fret });
        }
      } else {
        if (fret <= this.numFrets) {
          positions.push({ string: i + 1, fret });
        }
      }
    }

    return positions;
  }

  /**
   * Pick the position closest to the current hand position
   * Prefers open strings (fret 0) when hand is near nut
   * @private
   */
  _pickClosest(positions, handPosition) {
    if (positions.length === 1) return positions[0];

    let best = positions[0];
    let bestCost = this._positionCost(best, handPosition);

    for (let i = 1; i < positions.length; i++) {
      const cost = this._positionCost(positions[i], handPosition);
      if (cost < bestCost) {
        bestCost = cost;
        best = positions[i];
      }
    }

    return best;
  }

  /**
   * Cost function for a position relative to current hand position.
   * Lower is better.
   * @private
   */
  _positionCost(pos, handPosition) {
    // Open string has zero fretting cost but slight preference penalty
    // to avoid always choosing open when hand is far up the neck
    if (pos.fret === 0) {
      return Math.abs(handPosition) * 0.3;
    }
    return Math.abs(pos.fret - handPosition);
  }

  /**
   * Default hand position (near the nut)
   * @private
   */
  _getDefaultHandPosition() {
    return 3; // Around 3rd fret — comfortable starting position
  }

  // ==========================================================================
  // Internal — Chord Assignment (constraint satisfaction)
  // ==========================================================================

  /**
   * Assign chord notes to strings, ensuring:
   * - One note per string maximum
   * - All notes are playable
   * - Minimal hand spread (fret span)
   * - Closest to current hand position
   *
   * Uses backtracking search with cost optimization.
   * @private
   */
  _assignChord(chordNotes, handPosition) {
    // Get possible positions for each note
    const notePositions = chordNotes.map(note => ({
      note,
      positions: this._getPossiblePositions(note.n)
    }));

    // Filter out unplayable notes
    const playable = notePositions.filter(np => np.positions.length > 0);
    if (playable.length === 0) return [];

    // Sort by number of positions (most constrained first — better pruning)
    playable.sort((a, b) => a.positions.length - b.positions.length);

    // Backtracking search
    const bestAssignment = this._backtrackAssign(playable, 0, {}, handPosition);

    if (!bestAssignment) {
      // Fallback: assign what we can, skipping conflicts
      return this._greedyAssign(playable, handPosition);
    }

    return bestAssignment.map(entry => ({
      string: entry.string,
      fret: entry.fret,
      velocity: entry.note.v,
      duration: entry.note.g,
      midiNote: entry.note.n,
      channel: entry.note.c
    }));
  }

  /**
   * Backtracking assignment solver
   * @private
   * @param {Array} playable - Notes with their possible positions
   * @param {number} index - Current note index
   * @param {Object} usedStrings - Map of string number → true
   * @param {number} handPosition - Current hand position
   * @returns {Array|null} Best assignment, or null if no valid assignment
   */
  _backtrackAssign(playable, index, usedStrings, handPosition) {
    if (index >= playable.length) {
      return []; // All notes assigned
    }

    const { note, positions } = playable[index];

    // Score and sort positions by cost
    const scoredPositions = positions
      .filter(pos => !usedStrings[pos.string])
      .map(pos => ({ ...pos, cost: this._positionCost(pos, handPosition) }))
      .sort((a, b) => a.cost - b.cost);

    let bestResult = null;
    let bestCost = Infinity;

    for (const pos of scoredPositions) {
      // Try this position
      usedStrings[pos.string] = true;

      const rest = this._backtrackAssign(playable, index + 1, usedStrings, handPosition);

      if (rest !== null) {
        const totalCost = pos.cost + rest.reduce((sum, e) => sum + (e.cost || 0), 0);
        if (totalCost < bestCost) {
          bestCost = totalCost;
          bestResult = [{ string: pos.string, fret: pos.fret, note, cost: pos.cost }, ...rest];
        }
      }

      usedStrings[pos.string] = false;
    }

    return bestResult;
  }

  /**
   * Greedy fallback: assign notes one by one, skipping string conflicts
   * @private
   */
  _greedyAssign(playable, handPosition) {
    const usedStrings = {};
    const result = [];

    for (const { note, positions } of playable) {
      const available = positions
        .filter(pos => !usedStrings[pos.string])
        .sort((a, b) => this._positionCost(a, handPosition) - this._positionCost(b, handPosition));

      if (available.length > 0) {
        const best = available[0];
        usedStrings[best.string] = true;
        result.push({
          string: best.string,
          fret: best.fret,
          velocity: note.v,
          duration: note.g,
          midiNote: note.n,
          channel: note.c
        });
      }
      // else: note is unplayable with current assignment, skip
    }

    return result;
  }

  // ==========================================================================
  // Internal — Utilities
  // ==========================================================================

  /**
   * Group notes by tick into chord groups
   * @private
   * @param {Array} notes - Sorted by tick
   * @returns {Array<{tick: number, notes: Array}>}
   */
  _groupByTick(notes) {
    const groups = [];
    let currentTick = null;
    let currentGroup = null;

    for (const note of notes) {
      if (note.t !== currentTick) {
        if (currentGroup) groups.push(currentGroup);
        currentTick = note.t;
        currentGroup = { tick: note.t, notes: [note] };
      } else {
        currentGroup.notes.push(note);
      }
    }

    if (currentGroup) groups.push(currentGroup);

    return groups;
  }

  // ==========================================================================
  // Static helpers
  // ==========================================================================

  /**
   * Get MIDI note name from note number
   * @param {number} midiNote
   * @returns {string} e.g. "C4", "F#3"
   */
  static midiNoteToName(midiNote) {
    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const octave = Math.floor(midiNote / 12) - 1;
    const name = noteNames[midiNote % 12];
    return `${name}${octave}`;
  }

  /**
   * Describe a tuning as note names
   * @param {number[]} tuning - Array of MIDI note numbers
   * @returns {string} e.g. "E2-A2-D3-G3-B3-E4"
   */
  static describeTuning(tuning) {
    return tuning.map(note => TablatureConverter.midiNoteToName(note)).join('-');
  }

  /**
   * Validate that a chord is physically playable (max fret span for a human hand)
   * @param {Array<{fret: number}>} positions - Positions in the chord
   * @param {number} [maxSpan=4] - Maximum fret span (default 4 for guitar)
   * @returns {boolean}
   */
  static isChordPlayable(positions, maxSpan = 4) {
    const fretted = positions.filter(p => p.fret > 0);
    if (fretted.length <= 1) return true;

    const minFret = Math.min(...fretted.map(p => p.fret));
    const maxFret = Math.max(...fretted.map(p => p.fret));

    return (maxFret - minFret) <= maxSpan;
  }
}

export default TablatureConverter;
