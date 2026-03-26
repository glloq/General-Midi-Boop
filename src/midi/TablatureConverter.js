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

// Default CC numbers for string instrument control (matches constants.js MIDI_CC)
const CC_STRING_SELECT_DEFAULT = 20;
const CC_FRET_SELECT_DEFAULT = 21;

class TablatureConverter {

  /**
   * @param {Object} instrumentConfig - String instrument configuration
   * @param {number[]} instrumentConfig.tuning - MIDI note per string (low to high), e.g. [40,45,50,55,59,64]
   * @param {number} instrumentConfig.num_strings - Number of strings (1-6)
   * @param {number} instrumentConfig.num_frets - Number of frets (0 = fretless)
   * @param {boolean} instrumentConfig.is_fretless - Whether the instrument has no frets
   * @param {number} instrumentConfig.capo_fret - Capo position (shifts all open strings up)
   * @param {number} [instrumentConfig.cc_string_number] - CC number for string select (default 20)
   * @param {number} [instrumentConfig.cc_string_min] - Min value for string CC (default 1)
   * @param {number} [instrumentConfig.cc_string_max] - Max value for string CC (default 12)
   * @param {number} [instrumentConfig.cc_string_offset] - Offset for string CC value (default 0)
   * @param {number} [instrumentConfig.cc_fret_number] - CC number for fret select (default 21)
   * @param {number} [instrumentConfig.cc_fret_min] - Min value for fret CC (default 0)
   * @param {number} [instrumentConfig.cc_fret_max] - Max value for fret CC (default 36)
   * @param {number} [instrumentConfig.cc_fret_offset] - Offset for fret CC value (default 0)
   * @param {number[]} [instrumentConfig.frets_per_string] - Per-string fret counts (null = uniform)
   */
  // Available algorithms
  static ALGORITHMS = {
    min_movement: 'min_movement',
    lowest_fret: 'lowest_fret',
    highest_fret: 'highest_fret',
    zone: 'zone'
  };

  constructor(instrumentConfig) {
    this.tuning = instrumentConfig.tuning;
    // Use tuning array length as authoritative string count if they disagree
    this.numStrings = instrumentConfig.tuning?.length || instrumentConfig.num_strings;
    this.numFrets = instrumentConfig.num_frets;
    this.isFretless = instrumentConfig.is_fretless;
    this.capoFret = instrumentConfig.capo_fret || 0;
    this.ccEnabled = instrumentConfig.cc_enabled !== undefined ? !!instrumentConfig.cc_enabled : true;
    this.algorithm = instrumentConfig.tab_algorithm || 'min_movement';

    // Configurable CC numbers and parameters
    this.ccStringNumber = instrumentConfig.cc_string_number !== undefined ? instrumentConfig.cc_string_number : CC_STRING_SELECT_DEFAULT;
    this.ccStringMin = instrumentConfig.cc_string_min !== undefined ? instrumentConfig.cc_string_min : 1;
    this.ccStringMax = instrumentConfig.cc_string_max !== undefined ? instrumentConfig.cc_string_max : 12;
    this.ccStringOffset = instrumentConfig.cc_string_offset || 0;
    this.ccFretNumber = instrumentConfig.cc_fret_number !== undefined ? instrumentConfig.cc_fret_number : CC_FRET_SELECT_DEFAULT;
    this.ccFretMin = instrumentConfig.cc_fret_min !== undefined ? instrumentConfig.cc_fret_min : 0;
    this.ccFretMax = instrumentConfig.cc_fret_max !== undefined ? instrumentConfig.cc_fret_max : 36;
    this.ccFretOffset = instrumentConfig.cc_fret_offset || 0;

    // Per-string fret counts (null = use numFrets for all)
    this.fretsPerString = instrumentConfig.frets_per_string || null;

    // Effective open-string notes with capo applied
    this.effectiveTuning = this.tuning.map(note => note + this.capoFret);

    // Precompute the playable range per string (using per-string frets if available)
    this.stringRanges = this.effectiveTuning.map((openNote, i) => {
      const maxFrets = this.fretsPerString?.[i] ?? this.numFrets;
      return {
        min: openNote,
        max: this.isFretless ? openNote + 48 : openNote + maxFrets
      };
    });
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
  convertMidiToTablature(notes, algorithmOverride) {
    if (!notes || notes.length === 0) return [];

    const algo = algorithmOverride || this.algorithm;

    switch (algo) {
      case 'lowest_fret':
        return this._convertLowestFret(notes);
      case 'highest_fret':
        return this._convertHighestFret(notes);
      case 'zone':
        return this._convertZone(notes);
      case 'min_movement':
      default:
        return this._convertMinMovement(notes);
    }
  }

  // ==========================================================================
  // Algorithm: min_movement (default — original algorithm)
  // Minimizes hand movement between consecutive notes/chords
  // ==========================================================================

  /** @private */
  _convertMinMovement(notes) {
    const chordGroups = this._groupByTick(notes);
    const tabEvents = [];
    let lastHandPosition = this._getDefaultHandPosition();

    for (const group of chordGroups) {
      const tick = group.tick;
      const chordNotes = group.notes;
      const occupiedStrings = this._getOccupiedStrings(tabEvents, tick);

      if (chordNotes.length === 1) {
        const note = chordNotes[0];
        const positions = this._getPossiblePositions(note.n)
          .filter(pos => !occupiedStrings.has(pos.string));
        if (positions.length === 0) continue;

        const best = this._pickClosest(positions, lastHandPosition);
        tabEvents.push({
          tick, string: best.string, fret: best.fret,
          velocity: note.v, duration: note.g, midiNote: note.n, channel: note.c
        });

        if (best.fret > 0) {
          lastHandPosition = Math.round(lastHandPosition * 0.3 + best.fret * 0.7);
        }
      } else {
        const assignment = this._assignChord(chordNotes, lastHandPosition, occupiedStrings);
        for (const entry of assignment) {
          tabEvents.push({
            tick, string: entry.string, fret: entry.fret,
            velocity: entry.velocity, duration: entry.duration,
            midiNote: entry.midiNote, channel: entry.channel
          });
        }
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

  // ==========================================================================
  // Algorithm: lowest_fret
  // Always picks the lowest fret available (open strings preferred)
  // ==========================================================================

  /** @private */
  _convertLowestFret(notes) {
    const chordGroups = this._groupByTick(notes);
    const tabEvents = [];

    for (const group of chordGroups) {
      const tick = group.tick;
      const chordNotes = group.notes;
      const occupiedStrings = this._getOccupiedStrings(tabEvents, tick);

      if (chordNotes.length === 1) {
        const note = chordNotes[0];
        const positions = this._getPossiblePositions(note.n)
          .filter(pos => !occupiedStrings.has(pos.string));
        if (positions.length === 0) continue;

        // Pick the position with the lowest fret
        const best = positions.reduce((a, b) => a.fret <= b.fret ? a : b);
        tabEvents.push({
          tick, string: best.string, fret: best.fret,
          velocity: note.v, duration: note.g, midiNote: note.n, channel: note.c
        });
      } else {
        // Chord: assign with lowest-fret preference
        const assignment = this._assignChordWithPicker(chordNotes,
          (positions) => positions.reduce((a, b) => a.fret <= b.fret ? a : b),
          occupiedStrings);
        for (const entry of assignment) {
          tabEvents.push({
            tick, string: entry.string, fret: entry.fret,
            velocity: entry.velocity, duration: entry.duration,
            midiNote: entry.midiNote, channel: entry.channel
          });
        }
      }
    }

    return tabEvents;
  }

  // ==========================================================================
  // Algorithm: highest_fret
  // Prefers the highest fret / highest string position
  // ==========================================================================

  /** @private */
  _convertHighestFret(notes) {
    const chordGroups = this._groupByTick(notes);
    const tabEvents = [];

    for (const group of chordGroups) {
      const tick = group.tick;
      const chordNotes = group.notes;
      const occupiedStrings = this._getOccupiedStrings(tabEvents, tick);

      if (chordNotes.length === 1) {
        const note = chordNotes[0];
        const positions = this._getPossiblePositions(note.n)
          .filter(pos => !occupiedStrings.has(pos.string));
        if (positions.length === 0) continue;

        // Pick the position with the highest fret
        const best = positions.reduce((a, b) => a.fret >= b.fret ? a : b);
        tabEvents.push({
          tick, string: best.string, fret: best.fret,
          velocity: note.v, duration: note.g, midiNote: note.n, channel: note.c
        });
      } else {
        const assignment = this._assignChordWithPicker(chordNotes,
          (positions) => positions.reduce((a, b) => a.fret >= b.fret ? a : b),
          occupiedStrings);
        for (const entry of assignment) {
          tabEvents.push({
            tick, string: entry.string, fret: entry.fret,
            velocity: entry.velocity, duration: entry.duration,
            midiNote: entry.midiNote, channel: entry.channel
          });
        }
      }
    }

    return tabEvents;
  }

  // ==========================================================================
  // Algorithm: zone
  // Groups notes in a fixed fret zone per string, minimizing per-string
  // movement. Analyzes the whole piece first to find optimal zones.
  // ==========================================================================

  /** @private */
  _convertZone(notes) {
    const ZONE_SIZE = 5; // fret span per zone
    const chordGroups = this._groupByTick(notes);

    // Phase 1: Determine optimal zone center per string by analyzing all notes
    const stringZones = this._computeStringZones(notes, ZONE_SIZE);

    const tabEvents = [];

    for (const group of chordGroups) {
      const tick = group.tick;
      const chordNotes = group.notes;

      const occupiedStrings = this._getOccupiedStrings(tabEvents, tick);

      if (chordNotes.length === 1) {
        const note = chordNotes[0];
        const positions = this._getPossiblePositions(note.n)
          .filter(pos => !occupiedStrings.has(pos.string));
        if (positions.length === 0) continue;

        // Pick position closest to that string's zone center
        const best = this._pickBestInZone(positions, stringZones, ZONE_SIZE);
        tabEvents.push({
          tick, string: best.string, fret: best.fret,
          velocity: note.v, duration: note.g, midiNote: note.n, channel: note.c
        });
      } else {
        // Chord: assign within zones
        const assignment = this._assignChordInZone(chordNotes, stringZones, ZONE_SIZE, occupiedStrings);
        for (const entry of assignment) {
          tabEvents.push({
            tick, string: entry.string, fret: entry.fret,
            velocity: entry.velocity, duration: entry.duration,
            midiNote: entry.midiNote, channel: entry.channel
          });
        }
      }
    }

    return tabEvents;
  }

  /**
   * Analyze all notes to find the optimal zone center for each string.
   * For each string, finds the fret zone that covers the most playable notes.
   * @private
   */
  _computeStringZones(notes, zoneSize) {
    const zones = new Array(this.numStrings).fill(0);

    // Count how many notes each string could play at each fret zone
    for (let s = 0; s < this.numStrings; s++) {
      const openNote = this.effectiveTuning[s];
      const maxFret = this.isFretless ? 48 : this.numFrets;
      const fretHits = new Array(maxFret + 1).fill(0);

      for (const note of notes) {
        const fret = note.n - openNote;
        if (fret >= 0 && fret <= maxFret) {
          fretHits[fret]++;
        }
      }

      // Find zone center with maximum coverage
      let bestCenter = 0;
      let bestScore = 0;
      for (let center = 0; center <= maxFret; center++) {
        let score = 0;
        const lo = Math.max(0, center - Math.floor(zoneSize / 2));
        const hi = Math.min(maxFret, center + Math.floor(zoneSize / 2));
        for (let f = lo; f <= hi; f++) {
          score += fretHits[f];
        }
        if (score > bestScore) {
          bestScore = score;
          bestCenter = center;
        }
      }

      zones[s] = bestCenter;
    }

    return zones;
  }

  /**
   * Pick the position closest to the string's assigned zone
   * @private
   */
  _pickBestInZone(positions, stringZones, zoneSize) {
    let best = positions[0];
    let bestCost = Infinity;

    for (const pos of positions) {
      const zoneCenter = stringZones[pos.string - 1];
      const halfZone = Math.floor(zoneSize / 2);
      // Cost: distance from zone center, with strong penalty for being outside the zone
      let cost;
      if (pos.fret === 0) {
        cost = 0.5; // Open strings are always OK
      } else {
        const dist = Math.abs(pos.fret - zoneCenter);
        cost = dist <= halfZone ? dist * 0.5 : dist * 3;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = pos;
      }
    }

    return best;
  }

  /**
   * Assign chord notes using zone preference (greedy with zone cost)
   * @private
   */
  _assignChordInZone(chordNotes, stringZones, zoneSize, occupiedStrings) {
    const usedStrings = {};
    if (occupiedStrings) {
      for (const s of occupiedStrings) usedStrings[s] = true;
    }
    const result = [];
    const halfZone = Math.floor(zoneSize / 2);

    // Sort notes by pitch (lowest first) for consistent string assignment
    const sorted = [...chordNotes].sort((a, b) => a.n - b.n);

    for (const note of sorted) {
      const positions = this._getPossiblePositions(note.n)
        .filter(pos => !usedStrings[pos.string]);

      if (positions.length === 0) continue;

      // Score by zone proximity
      const scored = positions.map(pos => {
        const zoneCenter = stringZones[pos.string - 1];
        let cost;
        if (pos.fret === 0) {
          cost = 0.5;
        } else {
          const dist = Math.abs(pos.fret - zoneCenter);
          cost = dist <= halfZone ? dist * 0.5 : dist * 3;
        }
        return { ...pos, cost };
      }).sort((a, b) => a.cost - b.cost);

      const best = scored[0];
      usedStrings[best.string] = true;
      result.push({
        string: best.string, fret: best.fret,
        velocity: note.v, duration: note.g, midiNote: note.n, channel: note.c
      });
    }

    return result;
  }

  // ==========================================================================
  // Shared chord helper for lowest_fret / highest_fret
  // ==========================================================================

  /**
   * Assign chord notes using a simple picker function (greedy, no backtracking).
   * @private
   * @param {Array} chordNotes
   * @param {Function} picker - (positions) => best position
   */
  _assignChordWithPicker(chordNotes, picker, occupiedStrings) {
    const usedStrings = {};
    if (occupiedStrings) {
      for (const s of occupiedStrings) usedStrings[s] = true;
    }
    const result = [];

    // Sort by pitch (lowest first) for natural string order
    const sorted = [...chordNotes].sort((a, b) => a.n - b.n);

    for (const note of sorted) {
      const positions = this._getPossiblePositions(note.n)
        .filter(pos => !usedStrings[pos.string]);

      if (positions.length === 0) continue;

      const best = picker(positions);
      usedStrings[best.string] = true;
      result.push({
        string: best.string, fret: best.fret,
        velocity: note.v, duration: note.g, midiNote: note.n, channel: note.c
      });
    }

    return result;
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

      // Generate CC events (string select + fret select) only if cc_enabled
      if (this.ccEnabled) {
        // String select: apply offset, clamp to configured range, then clamp to MIDI 0-127
        const stringRaw = event.string + this.ccStringOffset;
        const stringVal = Math.max(0, Math.min(127, Math.max(this.ccStringMin, Math.min(this.ccStringMax, stringRaw))));
        ccEvents.push({
          tick: event.tick,
          cc: this.ccStringNumber,
          value: stringVal,
          channel: event.channel ?? 0
        });

        // Fret select: apply offset, clamp to configured range, then clamp to MIDI 0-127
        const fretRaw = Math.round(event.fret) + this.ccFretOffset;
        const fretVal = Math.max(0, Math.min(127, Math.max(this.ccFretMin, Math.min(this.ccFretMax, fretRaw))));
        ccEvents.push({
          tick: event.tick,
          cc: this.ccFretNumber,
          value: fretVal,
          channel: event.channel ?? 0
        });
      }

      // Generate MIDI note
      notes.push({
        t: event.tick,
        n: midiNote,
        v: event.velocity !== undefined ? event.velocity : 100,
        g: event.duration || 480,
        c: event.channel !== undefined ? event.channel : 0
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
        // Use per-string fret count if available, otherwise global numFrets
        const maxFret = this.fretsPerString?.[i] ?? this.numFrets;
        if (fret <= maxFret) {
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
   * Models realistic guitar playing ergonomics:
   *  - Hand movement penalty (distance from current position)
   *  - Preference for lower fret positions (easier to play)
   *  - Open strings are cheap but penalized when hand is high up the neck
   *  - High fret positions get progressively harder
   *  - Max comfortable hand span is ~4 frets (penalize beyond that)
   * Lower is better.
   * @private
   */
  _positionCost(pos, handPosition) {
    // Open strings: free if hand is near nut, costly if hand is far up the neck
    if (pos.fret === 0) {
      // Slight penalty when hand is above fret 5 (stretching back to open)
      return handPosition <= 5 ? 0.2 : handPosition * 0.4;
    }

    // Distance from current hand position (primary cost)
    const distance = Math.abs(pos.fret - handPosition);

    // Base movement cost with exponential penalty for large jumps
    // Comfortable: 0-4 frets. Acceptable: 5-7. Difficult: 8+
    let movementCost;
    if (distance <= 4) {
      movementCost = distance;
    } else if (distance <= 7) {
      movementCost = distance * 1.5;
    } else {
      movementCost = distance * 2.5;
    }

    // Preference for lower positions (first position is more natural)
    // Frets 1-5: no penalty, 6-9: small penalty, 10+: increasing penalty
    const highFretPenalty = pos.fret > 9 ? (pos.fret - 9) * 0.3
                         : pos.fret > 5 ? (pos.fret - 5) * 0.1
                         : 0;

    return movementCost + highFretPenalty;
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
  _assignChord(chordNotes, handPosition, occupiedStrings) {
    // Get possible positions for each note, excluding already-occupied strings
    const notePositions = chordNotes.map(note => ({
      note,
      positions: this._getPossiblePositions(note.n)
        .filter(pos => !occupiedStrings || !occupiedStrings.has(pos.string))
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
   * Backtracking assignment solver with fret span constraint.
   * Ensures all fretted notes in a chord fit within a comfortable hand span.
   * @private
   * @param {Array} playable - Notes with their possible positions
   * @param {number} index - Current note index
   * @param {Object} usedStrings - Map of string number → { fret }
   * @param {number} handPosition - Current hand position
   * @returns {Array|null} Best assignment, or null if no valid assignment
   */
  _backtrackAssign(playable, index, usedStrings, handPosition) {
    if (index >= playable.length) {
      return []; // All notes assigned
    }

    const { note, positions } = playable[index];

    // Max comfortable fret span for a chord (4 frets = typical hand stretch)
    const MAX_FRET_SPAN = 5;

    // Collect currently assigned fretted positions
    const assignedFrets = Object.values(usedStrings)
      .filter(v => v && v.fret > 0)
      .map(v => v.fret);

    // Score and sort positions by cost
    const scoredPositions = positions
      .filter(pos => !usedStrings[pos.string])
      .filter(pos => {
        // Enforce max fret span: check if this position is compatible
        if (pos.fret === 0 || assignedFrets.length === 0) return true;
        const allFrets = [...assignedFrets, pos.fret];
        const span = Math.max(...allFrets) - Math.min(...allFrets);
        return span <= MAX_FRET_SPAN;
      })
      .map(pos => ({ ...pos, cost: this._positionCost(pos, handPosition) }))
      .sort((a, b) => a.cost - b.cost);

    let bestResult = null;
    let bestCost = Infinity;

    for (const pos of scoredPositions) {
      // Try this position
      usedStrings[pos.string] = { fret: pos.fret };

      const rest = this._backtrackAssign(playable, index + 1, usedStrings, handPosition);

      if (rest !== null) {
        const totalCost = pos.cost + rest.reduce((sum, e) => sum + (e.cost || 0), 0);
        if (totalCost < bestCost) {
          bestCost = totalCost;
          bestResult = [{ string: pos.string, fret: pos.fret, note, cost: pos.cost }, ...rest];
        }
      }

      delete usedStrings[pos.string];
    }

    return bestResult;
  }

  /**
   * Greedy fallback: assign notes one by one, skipping string conflicts
   * and respecting max fret span.
   * @private
   */
  _greedyAssign(playable, handPosition) {
    const usedStrings = {};
    const result = [];
    const MAX_FRET_SPAN = 5;

    for (const { note, positions } of playable) {
      const assignedFrets = Object.values(usedStrings)
        .filter(v => v && v.fret > 0)
        .map(v => v.fret);

      const available = positions
        .filter(pos => !usedStrings[pos.string])
        .filter(pos => {
          if (pos.fret === 0 || assignedFrets.length === 0) return true;
          const allFrets = [...assignedFrets, pos.fret];
          return Math.max(...allFrets) - Math.min(...allFrets) <= MAX_FRET_SPAN;
        })
        .sort((a, b) => this._positionCost(a, handPosition) - this._positionCost(b, handPosition));

      if (available.length > 0) {
        const best = available[0];
        usedStrings[best.string] = { fret: best.fret };
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
   * Get the set of strings currently occupied at a given tick by previously
   * assigned tab events whose duration has not yet ended.
   * @private
   * @param {Array} tabEvents - Already-assigned tablature events
   * @param {number} tick - Current tick
   * @returns {Set<number>} Set of 1-based string numbers that are busy
   */
  _getOccupiedStrings(tabEvents, tick) {
    const occupied = new Set();
    for (let i = tabEvents.length - 1; i >= 0; i--) {
      const ev = tabEvents[i];
      // Events are sorted by tick; once we go far enough back, stop
      if (ev.tick + ev.duration <= tick) {
        // This event ended before current tick. Earlier events also ended
        // (unless they have very long durations), so keep scanning.
        // We can't break early because a much earlier note could have a very long duration.
        // But for performance, stop scanning once we're more than a reasonable
        // duration away (e.g., 4 whole notes at 480 ticks/beat = 7680 ticks).
        if (tick - ev.tick > 7680) break;
        continue;
      }
      if (ev.tick < tick) {
        // This event started before current tick and hasn't ended yet
        occupied.add(ev.string);
      }
      // Events at the same tick are handled by the chord assignment (usedStrings)
    }
    return occupied;
  }

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
