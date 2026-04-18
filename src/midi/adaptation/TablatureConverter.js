/**
 * @file src/midi/adaptation/TablatureConverter.js
 * @description Bidirectional MIDI ↔ string-instrument tablature
 * converter.
 *
 * MIDI → Tab: given a string-instrument config (tuning, fret count,
 * capo, fretless flag) and a sequence of MIDI notes, assigns each note
 * to a `(string, fret)` position. The optimiser minimises hand
 * movement, refuses to place simultaneous notes on the same string,
 * and supports several algorithms (`greedy`, `look-ahead`, `optimal`).
 *
 * Tab → MIDI: converts `(string, fret)` events back into MIDI note
 * numbers and emits CC20 (string select) + CC21 (fret select) right
 * before each note-on so the receiving instrument can pre-position its
 * mechanical fingers.
 *
 * The file is large (~1250 LOC); only public entry points carry full
 * JSDoc — algorithm-specific helpers retain their inline comments.
 */

/** Default CC for "select string" — matches constants.js MIDI_CC. */
const CC_STRING_SELECT_DEFAULT = 20;
/** Default CC for "select fret" — matches constants.js MIDI_CC. */
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

  // Viterbi algorithm configuration for min_movement
  static VITERBI_CONFIG = {
    BEAM_WIDTH: 32,            // Max states kept per time step
    MAX_CHORD_STATES: 200,     // Max enumerated assignments per chord group
    MAX_FRET_SPAN: 5,          // Max fret span in a chord (hand stretch)
    COMFORTABLE_SPAN: 3,       // Span below which no penalty
    MOVE_THRESHOLD_STRETCH: 2, // Frets reachable by finger stretching
    MOVE_THRESHOLD_SHIFT: 5,   // Frets reachable by hand shift
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
  // Algorithm: min_movement (Viterbi with beam pruning)
  // Finds globally optimal string/fret assignments minimizing total hand movement.
  // Uses a Hidden Markov Model framework: states are valid assignments per chord
  // group, transitions model hand movement cost, emissions model intrinsic
  // position quality. Beam pruning keeps computation bounded.
  // ==========================================================================

  /** @private */
  _convertMinMovement(notes) {
    const chordGroups = this._groupByTick(notes);
    if (chordGroups.length === 0) return [];

    const { BEAM_WIDTH, MAX_CHORD_STATES } = TablatureConverter.VITERBI_CONFIG;
    const defaultHandPos = this._getDefaultHandPosition();

    // We need to track occupied strings per group using the final output,
    // but Viterbi needs all states upfront. For occupied strings from
    // sustaining notes, we build them incrementally using a forward-only
    // approach: occupied strings at group i depend on assignments chosen
    // at groups < i. Since the Viterbi path isn't known until traceback,
    // we compute occupied strings based on the best-so-far state's
    // assignment history stored in each state's backpointer chain.
    //
    // However, to avoid re-traversing the backpointer chain at each step,
    // each state carries a compact list of recently assigned events
    // (within the 7680-tick lookback window) for occupied string checking.

    // --- Phase 1: Build lattice with Viterbi forward pass ---
    let prevStates = null;

    // Store the lattice for traceback (only back-pointers needed)
    const lattice = [];

    for (let gi = 0; gi < chordGroups.length; gi++) {
      const group = chordGroups[gi];
      const tick = group.tick;
      const chordNotes = group.notes;

      // Build current step states
      const currStates = [];

      if (prevStates === null) {
        // First group — no predecessor, use default hand position
        const occupiedStrings = new Set(); // Nothing occupied yet
        const assignments = this._enumerateStatesForGroup(chordNotes, occupiedStrings, MAX_CHORD_STATES);

        for (const assignment of assignments) {
          const handPos = this._handPositionFromAssignment(assignment, defaultHandPos);
          const emission = this._emissionCost(assignment);
          const transition = this._transitionCost(defaultHandPos, handPos);
          const totalCost = emission + transition;

          currStates.push({
            assignment,
            handPosition: handPos,
            totalCost,
            backPointer: null,
            // Track recent events for occupied string calculation
            recentEvents: assignment.map(a => ({
              tick, string: a.string, duration: a.note.g
            }))
          });
        }

        // Handle case where no valid assignment exists for first group
        if (currStates.length === 0) {
          currStates.push({
            assignment: [],
            handPosition: defaultHandPos,
            totalCost: 0,
            backPointer: null,
            recentEvents: []
          });
        }
      } else {
        // Subsequent groups — evaluate transitions from all prev states
        // Collect unique state candidates keyed by assignment signature
        const stateMap = new Map();

        for (const prevState of prevStates) {
          // Compute occupied strings from this predecessor's recent events
          const occupiedStrings = this._getOccupiedStringsFromRecent(prevState.recentEvents, tick);

          // Enumerate valid assignments for this group given occupied strings
          const assignments = this._enumerateStatesForGroup(chordNotes, occupiedStrings, MAX_CHORD_STATES);

          if (assignments.length === 0) {
            // No valid assignment — propagate previous state with skip
            const key = 'skip';
            const totalCost = prevState.totalCost;
            if (!stateMap.has(key) || totalCost < stateMap.get(key).totalCost) {
              stateMap.set(key, {
                assignment: [],
                handPosition: prevState.handPosition,
                totalCost,
                backPointer: prevState,
                recentEvents: this._pruneRecentEvents(prevState.recentEvents, tick)
              });
            }
            continue;
          }

          for (const assignment of assignments) {
            const handPos = this._handPositionFromAssignment(assignment, prevState.handPosition);
            const emission = this._emissionCost(assignment);
            const transition = this._transitionCost(prevState.handPosition, handPos);
            const totalCost = prevState.totalCost + emission + transition;

            // Use a signature to deduplicate states with same assignment
            const key = assignment.map(a => `${a.string}:${a.fret}`).sort().join(',');

            if (!stateMap.has(key) || totalCost < stateMap.get(key).totalCost) {
              const newRecent = this._pruneRecentEvents(prevState.recentEvents, tick);
              for (const a of assignment) {
                newRecent.push({ tick, string: a.string, duration: a.note.g });
              }

              stateMap.set(key, {
                assignment,
                handPosition: handPos,
                totalCost,
                backPointer: prevState,
                recentEvents: newRecent
              });
            }
          }
        }

        // Collect all candidate states
        for (const state of stateMap.values()) {
          currStates.push(state);
        }

        // Handle edge case: no states at all
        if (currStates.length === 0) {
          const bestPrev = prevStates[0]; // Already sorted by cost
          currStates.push({
            assignment: [],
            handPosition: bestPrev.handPosition,
            totalCost: bestPrev.totalCost,
            backPointer: bestPrev,
            recentEvents: this._pruneRecentEvents(bestPrev.recentEvents, tick)
          });
        }
      }

      // --- Beam pruning: keep only top BEAM_WIDTH states ---
      currStates.sort((a, b) => a.totalCost - b.totalCost);
      const prunedStates = currStates.slice(0, BEAM_WIDTH);

      lattice.push(prunedStates);
      prevStates = prunedStates;
    }

    // --- Phase 2: Traceback ---
    // Find the best final state
    const lastStates = lattice[lattice.length - 1];
    let bestState = lastStates[0];
    for (let i = 1; i < lastStates.length; i++) {
      if (lastStates[i].totalCost < bestState.totalCost) {
        bestState = lastStates[i];
      }
    }

    // Trace back through backPointers to reconstruct the path
    const path = [];
    let state = bestState;
    while (state !== null) {
      path.unshift(state.assignment);
      state = state.backPointer;
    }

    // --- Phase 3: Build output ---
    const tabEvents = [];
    for (let i = 0; i < path.length; i++) {
      const tick = chordGroups[i].tick;
      for (const entry of path[i]) {
        tabEvents.push({
          tick,
          string: entry.string,
          fret: entry.fret,
          velocity: entry.note.v,
          duration: entry.note.g,
          midiNote: entry.note.n,
          channel: entry.note.c
        });
      }
    }

    return tabEvents;
  }

  /**
   * Enumerate all valid states (assignments) for a chord group.
   * For single notes, returns one state per possible position.
   * For chords, delegates to _enumerateAssignments.
   * @private
   */
  _enumerateStatesForGroup(chordNotes, occupiedStrings, maxResults) {
    if (chordNotes.length === 1) {
      const note = chordNotes[0];
      const positions = this._getPossiblePositions(note.n)
        .filter(pos => !occupiedStrings.has(pos.string));
      return positions.map(pos => [{ noteIndex: 0, string: pos.string, fret: pos.fret, note }]);
    }
    return this._enumerateAssignments(chordNotes, occupiedStrings, maxResults);
  }

  /**
   * Compute occupied strings from a state's recent events list.
   * @private
   */
  _getOccupiedStringsFromRecent(recentEvents, tick) {
    const occupied = new Set();
    for (const ev of recentEvents) {
      if (ev.tick < tick && ev.tick + ev.duration > tick) {
        occupied.add(ev.string);
      }
    }
    return occupied;
  }

  /**
   * Prune recent events that are too old to matter (> 7680 ticks before current tick).
   * Returns a new array.
   * @private
   */
  _pruneRecentEvents(recentEvents, tick) {
    return recentEvents.filter(ev => tick - ev.tick <= 7680);
  }

  // ==========================================================================
  // Algorithm: lowest_fret / highest_fret (picker-based)
  // ==========================================================================

  /** @private */
  _convertLowestFret(notes) {
    const picker = (positions) => positions.reduce((a, b) => a.fret <= b.fret ? a : b);
    return this._convertWithPicker(notes, picker, picker);
  }

  /** @private */
  _convertHighestFret(notes) {
    const picker = (positions) => positions.reduce((a, b) => a.fret >= b.fret ? a : b);
    return this._convertWithPicker(notes, picker, picker);
  }

  /**
   * Generic conversion loop using a picker function to select the best position.
   * Shared by lowest_fret and highest_fret algorithms.
   * @private
   */
  _convertWithPicker(notes, singlePicker, chordPicker) {
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

        const best = singlePicker(positions);
        tabEvents.push({
          tick, string: best.string, fret: best.fret,
          velocity: note.v, duration: note.g, midiNote: note.n, channel: note.c
        });
      } else {
        const assignment = this._assignChordWithPicker(chordNotes, chordPicker, occupiedStrings);
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
  // Internal — Viterbi algorithm helpers (min_movement optimization)
  // ==========================================================================

  /**
   * Enumerate all valid (string, fret) assignments for a chord group.
   * Respects: one note per string, max fret span, occupied strings.
   * Returns an array of assignment arrays, each assignment being
   * [{noteIndex, string, fret, note}, ...].
   * @private
   * @param {Array} chordNotes - Notes in the chord group
   * @param {Set<number>} occupiedStrings - Strings already in use
   * @param {number} maxResults - Cap on number of results
   * @returns {Array<Array>} Valid assignments
   */
  _enumerateAssignments(chordNotes, occupiedStrings, maxResults) {
    const { MAX_FRET_SPAN } = TablatureConverter.VITERBI_CONFIG;

    const notePositions = chordNotes.map((note, idx) => ({
      noteIndex: idx,
      note,
      positions: this._getPossiblePositions(note.n)
        .filter(pos => !occupiedStrings || !occupiedStrings.has(pos.string))
    }));

    const playable = notePositions.filter(np => np.positions.length > 0);
    if (playable.length === 0) return [];

    // Sort most-constrained-first for better pruning
    playable.sort((a, b) => a.positions.length - b.positions.length);

    const results = [];
    this._enumerateRecursive(playable, 0, {}, [], results, maxResults, MAX_FRET_SPAN);
    return results;
  }

  /**
   * Recursive backtracking to enumerate all valid assignments.
   * @private
   */
  _enumerateRecursive(playable, index, usedStrings, current, results, maxResults, maxFretSpan) {
    if (results.length >= maxResults) return;

    if (index >= playable.length) {
      results.push([...current]);
      return;
    }

    const { noteIndex, note, positions } = playable[index];

    // Collect currently assigned fretted positions for span check
    const assignedFrets = current
      .filter(a => a.fret > 0)
      .map(a => a.fret);

    for (const pos of positions) {
      if (usedStrings[pos.string]) continue;

      // Enforce max fret span
      if (pos.fret > 0 && assignedFrets.length > 0) {
        const allFrets = [...assignedFrets, pos.fret];
        const span = Math.max(...allFrets) - Math.min(...allFrets);
        if (span > maxFretSpan) continue;
      }

      usedStrings[pos.string] = true;
      current.push({ noteIndex, string: pos.string, fret: pos.fret, note });

      this._enumerateRecursive(playable, index + 1, usedStrings, current, results, maxResults, maxFretSpan);

      current.pop();
      delete usedStrings[pos.string];

      if (results.length >= maxResults) return;
    }
  }

  /**
   * Emission cost — intrinsic cost of a particular assignment.
   * Evaluates fret span, position height, and open/fretted mixing.
   * @private
   * @param {Array} assignment - [{string, fret, ...}, ...]
   * @returns {number} Cost (lower is better)
   */
  _emissionCost(assignment) {
    if (assignment.length === 0) return 0;

    const { COMFORTABLE_SPAN } = TablatureConverter.VITERBI_CONFIG;
    const frettedNotes = assignment.filter(a => a.fret > 0);

    // All open strings — very cheap
    if (frettedNotes.length === 0) return 0.5;

    let cost = 0;

    // 1. Fret span penalty (quadratic beyond comfortable span)
    const minFret = Math.min(...frettedNotes.map(a => a.fret));
    const maxFret = Math.max(...frettedNotes.map(a => a.fret));
    const span = maxFret - minFret;
    if (span > COMFORTABLE_SPAN) {
      cost += (span - COMFORTABLE_SPAN) * (span - COMFORTABLE_SPAN) * 0.5;
    }

    // 2. High position penalty (smooth logarithmic)
    const avgFret = frettedNotes.reduce((s, a) => s + a.fret, 0) / frettedNotes.length;
    cost += Math.log1p(Math.max(0, avgFret - 7)) * 0.3;

    // 3. Open string within fretted chord penalty
    const hasOpen = assignment.some(a => a.fret === 0);
    if (hasOpen && frettedNotes.length > 0 && minFret > 4) {
      cost += 1.5;
    }

    return cost;
  }

  /**
   * Transition cost — smooth movement cost between hand positions.
   * No discontinuities, models realistic hand movement ergonomics.
   * @private
   * @param {number} prevHandPos - Previous hand position (fret number)
   * @param {number} currHandPos - Current hand position (fret number)
   * @returns {number} Cost (lower is better)
   */
  _transitionCost(prevHandPos, currHandPos) {
    const { MOVE_THRESHOLD_STRETCH, MOVE_THRESHOLD_SHIFT } = TablatureConverter.VITERBI_CONFIG;
    const distance = Math.abs(currHandPos - prevHandPos);

    // Smooth movement cost: small moves nearly free, medium proportional, large bounded
    let moveCost;
    if (distance <= MOVE_THRESHOLD_STRETCH) {
      moveCost = distance * 0.3;  // Finger stretching — nearly free
    } else if (distance <= MOVE_THRESHOLD_SHIFT) {
      moveCost = MOVE_THRESHOLD_STRETCH * 0.3 + (distance - MOVE_THRESHOLD_STRETCH) * 0.8;
    } else {
      moveCost = MOVE_THRESHOLD_STRETCH * 0.3 + (MOVE_THRESHOLD_SHIFT - MOVE_THRESHOLD_STRETCH) * 0.8
        + (distance - MOVE_THRESHOLD_SHIFT) * 1.2;
    }

    // Transition to open strings near the nut is easier
    if (currHandPos === 0 && prevHandPos <= 5) {
      moveCost *= 0.5;
    }

    return moveCost;
  }

  /**
   * Compute hand position from an assignment.
   * Uses centroid of fretted notes; falls back to provided default if all open.
   * @private
   * @param {Array} assignment - [{string, fret, ...}, ...]
   * @param {number} fallback - Fallback position if all open strings
   * @returns {number} Hand position (fret number)
   */
  _handPositionFromAssignment(assignment, fallback) {
    const fretted = assignment.filter(a => a.fret > 0);
    if (fretted.length === 0) return fallback;
    return Math.round(fretted.reduce((sum, a) => sum + a.fret, 0) / fretted.length);
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
