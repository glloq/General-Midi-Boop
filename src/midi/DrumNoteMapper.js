// src/midi/DrumNoteMapper.js

/**
 * DrumNoteMapper - Intelligent drum note mapping system
 *
 * Maps General MIDI drum notes to available instrument notes while:
 * - Preserving musical function (kick, snare, hi-hat priority)
 * - Using intelligent substitution tables
 * - Grouping similar elements
 * - Providing quality metrics
 *
 * Based on study: docs/DRUMS_NOTE_MAPPING_STUDY.md
 */
class DrumNoteMapper {
  constructor(logger) {
    this.logger = logger;

    // GM Drum note categories (notes 35-81)
    this.DRUM_CATEGORIES = {
      kicks: [35, 36],
      snares: [37, 38, 40],
      hiHats: [42, 44, 46],
      toms: [41, 43, 45, 47, 48, 50],
      crashes: [49, 55, 57],
      rides: [51, 53, 59],
      latin: [60, 61, 62, 63, 64, 65, 66, 67, 68], // Bongos, congas, timbales, agogos
      misc: [39, 52, 54, 56, 58, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81]
    };

    // Detailed substitution tables (in order of preference)
    this.SUBSTITUTION_TABLES = {
      // Kick drums
      35: [36, 41, 43, 64], // Acoustic Kick → Bass Drum 1, Low Tom, Low Conga
      36: [35, 41, 43, 64], // Bass Drum 1 → Acoustic Kick, Low Tom, Low Conga

      // Snares
      38: [40, 37, 39, 54, 70], // Acoustic Snare → Electric, Rim, Clap, Tambourine, Maracas
      40: [38, 37, 39, 54, 70], // Electric Snare → Acoustic, Rim, Clap, Tambourine, Maracas
      37: [38, 40, 39, 54],     // Side Stick → Snares, Clap, Tambourine

      // Hi-Hats
      42: [44, 46, 54, 70, 53, 75], // Closed HH → Pedal, Open, Tambourine, Maracas, Ride Bell, Claves
      44: [42, 46, 54, 70, 75],     // Pedal HH → Closed, Open, Tambourine, Maracas, Claves
      46: [42, 44, 54, 70],         // Open HH → Closed, Pedal, Tambourine, Maracas

      // Toms (group with adjacent toms)
      41: [43, 45, 64, 62], // Low Floor Tom → High Floor, Low Tom, Congas
      43: [41, 45, 47, 64], // High Floor Tom → Low Floor, Low Tom, Low-Mid Tom, Congas
      45: [43, 47, 41, 62], // Low Tom → Floor toms, Low-Mid Tom, Congas
      47: [45, 48, 43, 62], // Low-Mid Tom → Low Tom, Hi-Mid Tom, High Floor, Congas
      48: [47, 50, 45, 60], // Hi-Mid Tom → Low-Mid, High Tom, Low Tom, Bongos
      50: [48, 47, 45, 60], // High Tom → Hi-Mid, Low-Mid, Low Tom, Bongos

      // Crashes
      49: [57, 55, 52, 46, 51], // Crash 1 → Crash 2, Splash, China, Open HH, Ride
      57: [49, 55, 52, 46, 51], // Crash 2 → Crash 1, Splash, China, Open HH, Ride
      55: [49, 57, 52, 46],     // Splash → Crashes, China, Open HH

      // Rides
      51: [59, 53, 42, 49], // Ride 1 → Ride 2, Bell, Closed HH, Crash
      59: [51, 53, 42, 49], // Ride 2 → Ride 1, Bell, Closed HH, Crash
      53: [51, 59, 42],     // Ride Bell → Rides, Closed HH

      // Misc percussion
      39: [37, 38, 40, 54], // Hand Clap → Rim, Snares, Tambourine
      54: [70, 42, 46, 39], // Tambourine → Maracas, HH, Clap
      70: [54, 42, 46, 75], // Maracas → Tambourine, HH, Claves
      56: [53, 75, 76],     // Cowbell → Ride Bell, Claves, Wood Blocks
      75: [76, 77, 70, 54], // Claves → Wood Blocks, Maracas, Tambourine

      // Latin percussion (interchangeable within groups)
      60: [61, 48, 50, 62], // Hi Bongo → Low Bongo, Toms, Congas
      61: [60, 47, 48, 62], // Low Bongo → Hi Bongo, Toms, Congas
      62: [63, 64, 60, 61], // Mute Hi Conga → Open Hi Conga, Low Conga, Bongos
      63: [62, 64, 60, 61], // Open Hi Conga → Mute Hi Conga, Low Conga, Bongos
      64: [62, 63, 41, 43], // Low Conga → Hi Congas, Low Toms
      65: [66, 48, 50, 62], // High Timbale → Low Timbale, Toms, Congas
      66: [65, 47, 48, 64], // Low Timbale → High Timbale, Toms, Low Conga
      67: [68, 76, 77],     // High Agogo → Low Agogo, Wood Blocks
      68: [67, 76, 77]      // Low Agogo → High Agogo, Wood Blocks
    };

    // Priority scores for drum notes (0-100)
    this.NOTE_PRIORITIES = {
      // Priority 1: Essential (MUST HAVE)
      36: 100, // Kick
      35: 100, // Kick
      38: 100, // Snare
      40: 100, // Snare (electric)
      42: 90,  // Closed HH
      49: 70,  // Crash

      // Priority 2: Important (SHOULD HAVE)
      46: 60,  // Open HH
      41: 50,  // Tom Low
      45: 50,  // Tom Low
      48: 50,  // Tom High
      50: 50,  // Tom High
      51: 40,  // Ride

      // Priority 3: Optional (NICE TO HAVE)
      43: 30,  // Tom Mid
      47: 30,  // Tom Mid
      37: 25,  // Rim Shot
      44: 25,  // Pedal HH
      39: 20,  // Hand Clap
      57: 20,  // Crash 2
      55: 20,  // Splash
      59: 20,  // Ride 2
      53: 15,  // Ride Bell
      52: 15,  // China

      // Priority 4: Effects/Latin (OPTIONAL)
      54: 15,  // Tambourine
      56: 15,  // Cowbell
      70: 10,  // Maracas
      // Latin percussion: 60-68
      60: 10, 61: 10, 62: 10, 63: 10, 64: 10, 65: 10, 66: 10, 67: 10, 68: 10,
      // Other percussion: 69-81
      69: 5, 71: 5, 72: 5, 73: 5, 74: 5, 75: 5, 76: 5, 77: 5, 78: 5, 79: 5, 80: 5, 81: 5
    };

    // Note names for logging
    this.NOTE_NAMES = {
      35: 'Acoustic Bass Drum', 36: 'Bass Drum 1', 37: 'Side Stick', 38: 'Acoustic Snare',
      39: 'Hand Clap', 40: 'Electric Snare', 41: 'Low Floor Tom', 42: 'Closed Hi-Hat',
      43: 'High Floor Tom', 44: 'Pedal Hi-Hat', 45: 'Low Tom', 46: 'Open Hi-Hat',
      47: 'Low-Mid Tom', 48: 'Hi-Mid Tom', 49: 'Crash Cymbal 1', 50: 'High Tom',
      51: 'Ride Cymbal 1', 52: 'Chinese Cymbal', 53: 'Ride Bell', 54: 'Tambourine',
      55: 'Splash Cymbal', 56: 'Cowbell', 57: 'Crash Cymbal 2', 58: 'Vibraslap',
      59: 'Ride Cymbal 2', 60: 'Hi Bongo', 61: 'Low Bongo', 62: 'Mute Hi Conga',
      63: 'Open Hi Conga', 64: 'Low Conga', 65: 'High Timbale', 66: 'Low Timbale',
      67: 'High Agogo', 68: 'Low Agogo', 69: 'Cabasa', 70: 'Maracas',
      71: 'Short Whistle', 72: 'Long Whistle', 73: 'Short Guiro', 74: 'Long Guiro',
      75: 'Claves', 76: 'Hi Wood Block', 77: 'Low Wood Block', 78: 'Mute Cuica',
      79: 'Open Cuica', 80: 'Mute Triangle', 81: 'Open Triangle'
    };
  }

  /**
   * Analyze instrument capabilities for drums
   * @param {Array<number>} availableNotes - MIDI notes the instrument can play
   * @returns {Object} Capability analysis
   */
  analyzeInstrumentCapabilities(availableNotes) {
    const caps = {
      hasKick: availableNotes.some(n => this.DRUM_CATEGORIES.kicks.includes(n)),
      hasSnare: availableNotes.some(n => this.DRUM_CATEGORIES.snares.includes(n)),
      hasHiHat: availableNotes.some(n => this.DRUM_CATEGORIES.hiHats.includes(n)),
      hasCrash: availableNotes.some(n => this.DRUM_CATEGORIES.crashes.includes(n)),
      hasRide: availableNotes.some(n => this.DRUM_CATEGORIES.rides.includes(n)),

      kicks: availableNotes.filter(n => this.DRUM_CATEGORIES.kicks.includes(n)),
      snares: availableNotes.filter(n => this.DRUM_CATEGORIES.snares.includes(n)),
      hiHats: availableNotes.filter(n => this.DRUM_CATEGORIES.hiHats.includes(n)),
      toms: availableNotes.filter(n => this.DRUM_CATEGORIES.toms.includes(n)).sort((a, b) => a - b),
      crashes: availableNotes.filter(n => this.DRUM_CATEGORIES.crashes.includes(n)),
      rides: availableNotes.filter(n => this.DRUM_CATEGORIES.rides.includes(n)),
      latin: availableNotes.filter(n => this.DRUM_CATEGORIES.latin.includes(n)),
      misc: availableNotes.filter(n => this.DRUM_CATEGORIES.misc.includes(n)),

      tomCount: 0,
      latinPercCount: 0,
      miscPercCount: 0,
      totalNotes: availableNotes.length
    };

    caps.tomCount = caps.toms.length;
    caps.latinPercCount = caps.latin.length;
    caps.miscPercCount = caps.misc.length;

    this.logger.info(`[DrumMapper] Instrument capabilities: Kick=${caps.hasKick}, Snare=${caps.hasSnare}, HH=${caps.hasHiHat}, ${caps.tomCount} toms, ${caps.totalNotes} total notes`);

    return caps;
  }

  /**
   * Classify and count drum notes in MIDI channel
   * @param {Array<Object>} noteEvents - Note events from channel (with note, velocity)
   * @returns {Object} Classification with usage counts
   */
  classifyDrumNotes(noteEvents) {
    const usage = {};

    // Count only noteOn occurrences (exclude noteOff to avoid double-counting)
    for (const event of noteEvents) {
      if (event.type !== 'noteOn') continue;
      if (event.velocity === 0) continue; // noteOn with vel=0 is noteOff
      if (event.note >= 27 && event.note <= 87) { // Valid drum range
        usage[event.note] = (usage[event.note] || 0) + 1;
      }
    }

    // Sort by frequency
    const sortedNotes = Object.entries(usage)
      .sort((a, b) => b[1] - a[1])
      .map(([note, count]) => ({ note: parseInt(note), count }));

    const usedNoteNumbers = sortedNotes.map(n => n.note);

    const categories = {
      kicks: usedNoteNumbers.filter(n => this.DRUM_CATEGORIES.kicks.includes(n)),
      snares: usedNoteNumbers.filter(n => this.DRUM_CATEGORIES.snares.includes(n)),
      hiHats: usedNoteNumbers.filter(n => this.DRUM_CATEGORIES.hiHats.includes(n)),
      toms: usedNoteNumbers.filter(n => this.DRUM_CATEGORIES.toms.includes(n)),
      crashes: usedNoteNumbers.filter(n => this.DRUM_CATEGORIES.crashes.includes(n)),
      rides: usedNoteNumbers.filter(n => this.DRUM_CATEGORIES.rides.includes(n)),
      latin: usedNoteNumbers.filter(n => this.DRUM_CATEGORIES.latin.includes(n)),
      misc: usedNoteNumbers.filter(n => this.DRUM_CATEGORIES.misc.includes(n))
    };

    this.logger.info(`[DrumMapper] MIDI uses: ${categories.kicks.length} kicks, ${categories.snares.length} snares, ${categories.hiHats.length} HH, ${categories.toms.length} toms`);

    return {
      usage,
      usedNotes: sortedNotes,
      mostUsed: sortedNotes.slice(0, 10),
      categories
    };
  }

  /**
   * Generate intelligent drum note mapping
   * @param {Object} midiNotes - Classified MIDI notes
   * @param {Array<number>} instrumentNotes - Available instrument notes
   * @param {Object} options - Mapping options
   * @returns {Object} Mapping result with quality score
   */
  /**
   * Get the category key for a MIDI drum note.
   * @param {number} note - MIDI note number
   * @returns {string|null} Category key (kicks, snares, etc.) or null
   */
  getCategoryForNote(note) {
    for (const [catKey, notes] of Object.entries(this.DRUM_CATEGORIES)) {
      if (notes.includes(note)) return catKey;
    }
    return null;
  }

  /**
   * Get the maximum substitution table depth allowed for a note based on category depth limits.
   * @param {number} note - MIDI note number
   * @param {Object} categoryDepthLimits - { kicks: 2, snares: -1, ... }
   * @returns {number} Max substitution depth (-1 = ignore/omit, 0 = exact only, N = max N substitutes)
   */
  getMaxDepthForNote(note, categoryDepthLimits) {
    if (!categoryDepthLimits) return Infinity;
    const cat = this.getCategoryForNote(note);
    if (!cat || categoryDepthLimits[cat] === undefined) return Infinity;
    return categoryDepthLimits[cat];
  }

  generateMapping(midiNotes, instrumentNotes, options = {}) {
    const opts = {
      allowSubstitution: true,
      allowSharing: true,
      allowOmission: true,
      preserveEssentials: true,
      categoryDepthLimits: null, // { kicks: 2, snares: -1, hiHats: 3, ... }
      ...options
    };

    const mapping = {};
    const used = new Set();
    const substitutions = [];
    const omissions = [];

    const instrCaps = this.analyzeInstrumentCapabilities(instrumentNotes);

    // If categoryDepthLimits set, omit notes from categories with depth -1 (ignore)
    if (opts.categoryDepthLimits) {
      for (const [catKey, depth] of Object.entries(opts.categoryDepthLimits)) {
        if (depth === -1) {
          const catNotes = this.DRUM_CATEGORIES[catKey] || [];
          for (const { note, count } of midiNotes.usedNotes) {
            if (catNotes.includes(note)) {
              omissions.push({ note, count, name: this.NOTE_NAMES[note] || `Note ${note}`, reason: 'category ignored' });
              mapping[note] = null; // mark as handled (ignored)
            }
          }
        }
      }
    }

    // Priority 1: Essential notes
    this.assignEssentialNotes(midiNotes, instrumentNotes, instrCaps, mapping, used, substitutions, opts);

    // Priority 2: Important notes
    this.assignImportantNotes(midiNotes, instrumentNotes, instrCaps, mapping, used, substitutions, opts);

    // Priority 3: Optional notes
    this.assignOptionalNotes(midiNotes, instrumentNotes, instrCaps, mapping, used, substitutions, opts);

    // Priority 4: Remaining notes
    this.assignRemainingNotes(midiNotes, instrumentNotes, mapping, used, substitutions, omissions, opts);

    // Clean up null mappings (ignored notes)
    for (const key of Object.keys(mapping)) {
      if (mapping[key] === null) delete mapping[key];
    }

    // Calculate quality score
    const quality = this.calculateMappingQuality(mapping, midiNotes, instrumentNotes, substitutions, omissions);

    this.logger.info(`[DrumMapper] Mapping complete: ${Object.keys(mapping).length}/${midiNotes.usedNotes.length} notes mapped, quality=${quality.score}/100`);

    return {
      mapping,
      substitutions,
      omissions,
      quality,
      instrumentCapabilities: instrCaps
    };
  }

  /**
   * Assign essential drum notes (Priority 1)
   */
  assignEssentialNotes(midiNotes, instrNotes, instrCaps, mapping, used, substitutions, opts) {
    const { categories } = midiNotes;

    // KICK (absolute priority)
    if (categories.kicks.length > 0) {
      let targetKick = instrNotes.find(n => n === 36) ||
                       instrNotes.find(n => n === 35);

      if (!targetKick && opts.allowSubstitution) {
        // Fallback: low tom
        targetKick = instrNotes.find(n => [41, 43, 45].includes(n));
        if (targetKick) {
          substitutions.push({ from: categories.kicks[0], to: targetKick, reason: 'No kick available, using low tom' });
        }
      }

      if (targetKick) {
        categories.kicks.forEach(kick => {
          mapping[kick] = targetKick;
          if (kick !== targetKick) {
            substitutions.push({ from: kick, to: targetKick, type: 'kick consolidation' });
          }
        });
        used.add(targetKick);
      }
    }

    // SNARE (absolute priority)
    if (categories.snares.length > 0) {
      let targetSnare = instrNotes.find(n => n === 38) ||
                        instrNotes.find(n => n === 40) ||
                        instrNotes.find(n => n === 37);

      if (!targetSnare && opts.allowSubstitution) {
        // Fallback: hand clap
        targetSnare = instrNotes.find(n => n === 39);
        if (targetSnare) {
          substitutions.push({ from: 'snare', to: targetSnare, reason: 'No snare available, using hand clap' });
        }
      }

      if (targetSnare) {
        // Map main snares
        [38, 40].forEach(snareNote => {
          if (categories.snares.includes(snareNote)) {
            mapping[snareNote] = targetSnare;
          }
        });

        // Side stick → rim if available, otherwise main snare
        if (categories.snares.includes(37)) {
          const rimNote = instrNotes.find(n => n === 37 && !used.has(n));
          mapping[37] = rimNote || targetSnare;
          if (rimNote && rimNote !== 37) {
            used.add(rimNote);
          } else if (!rimNote) {
            substitutions.push({ from: 37, to: targetSnare, type: 'rim → snare' });
          }
        }

        used.add(targetSnare);
      }
    }

    // CLOSED HI-HAT (very important)
    if (categories.hiHats.length > 0) {
      let targetHH = instrNotes.find(n => n === 42) ||
                     instrNotes.find(n => n === 44);

      if (!targetHH && opts.allowSubstitution) {
        // Fallback: tambourine, maracas, claves
        targetHH = instrNotes.find(n => [54, 70, 75].includes(n));
        if (targetHH) {
          substitutions.push({ from: 'hi-hat', to: targetHH, reason: 'No hi-hat, using ' + this.NOTE_NAMES[targetHH] });
        }
      }

      if (targetHH) {
        [42, 44].forEach(hhNote => {
          if (categories.hiHats.includes(hhNote)) {
            mapping[hhNote] = targetHH;
          }
        });
        used.add(targetHH);
      }
    }

    // CRASH (important for accents)
    if (categories.crashes.length > 0) {
      let targetCrash = instrNotes.find(n => n === 49) ||
                        instrNotes.find(n => n === 57);

      if (!targetCrash && opts.allowSubstitution) {
        // Fallback: ride, splash, china
        targetCrash = instrNotes.find(n => [51, 55, 52].includes(n));
        if (targetCrash) {
          substitutions.push({ from: 'crash', to: targetCrash, reason: 'No crash, using ' + this.NOTE_NAMES[targetCrash] });
        }
      }

      if (targetCrash) {
        categories.crashes.forEach(crash => {
          mapping[crash] = targetCrash;
        });
        used.add(targetCrash);
      }
    }
  }

  /**
   * Assign important drum notes (Priority 2)
   */
  assignImportantNotes(midiNotes, instrNotes, instrCaps, mapping, used, substitutions, opts) {
    const { categories } = midiNotes;

    // OPEN HI-HAT
    if (categories.hiHats.includes(46) && !mapping[46]) {
      const targetOpenHH = instrNotes.find(n => n === 46 && !used.has(n)) ||
                           (opts.allowSharing && mapping[42]); // Share closed if needed

      if (targetOpenHH) {
        mapping[46] = targetOpenHH;
        if (!used.has(targetOpenHH)) used.add(targetOpenHH);
        if (targetOpenHH !== 46) {
          substitutions.push({ from: 46, to: targetOpenHH, type: 'open HH → closed HH' });
        }
      }
    }

    // TOMS (group intelligently)
    if (categories.toms.length > 0) {
      const availableToms = instrCaps.toms.filter(n => !used.has(n));
      const midiToms = categories.toms.sort((a, b) => a - b);

      if (availableToms.length > 0) {
        if (availableToms.length >= midiToms.length) {
          // Enough toms: 1:1 mapping
          midiToms.forEach((midiTom, idx) => {
            mapping[midiTom] = availableToms[idx];
            used.add(availableToms[idx]);
          });
        } else {
          // Not enough toms: group them
          const groupSize = Math.ceil(midiToms.length / availableToms.length);
          midiToms.forEach((midiTom, idx) => {
            const targetIdx = Math.min(Math.floor(idx / groupSize), availableToms.length - 1);
            const targetTom = availableToms[targetIdx];
            mapping[midiTom] = targetTom;
            if (midiTom !== targetTom) {
              substitutions.push({ from: midiTom, to: targetTom, type: 'tom grouping' });
            }
          });
          availableToms.forEach(t => used.add(t));
        }
      } else if (opts.allowSubstitution) {
        // No toms available: try latin percussion or omit
        const latinFallback = instrCaps.latin.filter(n => !used.has(n));
        if (latinFallback.length > 0) {
          midiToms.forEach((midiTom, idx) => {
            const targetIdx = Math.min(idx, latinFallback.length - 1);
            mapping[midiTom] = latinFallback[targetIdx];
            substitutions.push({ from: midiTom, to: latinFallback[targetIdx], type: 'tom → latin perc' });
          });
        }
      }
    }

    // RIDE
    if (categories.rides.length > 0) {
      let targetRide = instrNotes.find(n => n === 51 && !used.has(n)) ||
                       instrNotes.find(n => n === 59 && !used.has(n)) ||
                       instrNotes.find(n => n === 53 && !used.has(n));

      if (!targetRide && opts.allowSharing) {
        targetRide = mapping[49]; // Share crash if needed
        if (targetRide) {
          substitutions.push({ from: 'ride', to: targetRide, type: 'ride → crash sharing' });
        }
      }

      if (targetRide) {
        categories.rides.forEach(ride => {
          mapping[ride] = targetRide;
        });
        if (!used.has(targetRide)) used.add(targetRide);
      }
    }
  }

  /**
   * Assign optional drum notes (Priority 3)
   */
  assignOptionalNotes(midiNotes, instrNotes, instrCaps, mapping, used, substitutions, opts) {
    const { categories } = midiNotes;

    // LATIN PERCUSSION
    if (categories.latin.length > 0 && opts.allowSubstitution) {
      const availableLatin = instrCaps.latin.filter(n => !used.has(n));

      if (availableLatin.length > 0) {
        categories.latin.forEach(latinNote => {
          const closest = this.findClosestNote(latinNote, availableLatin);
          if (closest) {
            mapping[latinNote] = closest;
            if (latinNote !== closest) {
              substitutions.push({ from: latinNote, to: closest, type: 'latin substitution' });
            }
          }
        });
        availableLatin.forEach(n => used.add(n));
      } else {
        // Fallback: map to toms if available
        const tomsForLatin = instrCaps.toms.filter(n => !used.has(n));
        if (tomsForLatin.length > 0) {
          categories.latin.forEach(latinNote => {
            const targetTom = this.findClosestNote(latinNote, tomsForLatin);
            if (targetTom) {
              mapping[latinNote] = targetTom;
              substitutions.push({ from: latinNote, to: targetTom, type: 'latin → tom' });
            }
          });
        }
      }
    }

    // MISC PERCUSSION (hand clap, tambourine, cowbell, etc.)
    if (categories.misc.length > 0) {
      categories.misc.forEach(miscNote => {
        if (!mapping[miscNote]) {
          // Hand clap → snare rim or snare
          if (miscNote === 39) {
            const clapTarget = mapping[37] || mapping[38] || mapping[40];
            if (clapTarget) {
              mapping[39] = clapTarget;
              substitutions.push({ from: 39, to: clapTarget, type: 'clap → snare' });
            }
          }
          // Tambourine, Maracas → HH or available
          else if ([54, 70].includes(miscNote)) {
            const target = instrNotes.find(n => [54, 70].includes(n) && !used.has(n)) ||
                           mapping[42] || mapping[46];
            if (target) {
              mapping[miscNote] = target;
              if (miscNote !== target) {
                substitutions.push({ from: miscNote, to: target, type: 'perc → HH' });
              }
            }
          }
          // Cowbell → available or omit
          else if (miscNote === 56) {
            const target = instrNotes.find(n => n === 56 && !used.has(n));
            if (target) {
              mapping[56] = target;
              used.add(target);
            }
          }
        }
      });
    }
  }

  /**
   * Assign remaining unmapped notes (Priority 4)
   */
  assignRemainingNotes(midiNotes, instrNotes, mapping, used, substitutions, omissions, opts) {
    midiNotes.usedNotes.forEach(({ note, count }) => {
      if (mapping[note] !== undefined) return; // already mapped or ignored (null)

      // Check category depth limit
      const maxDepth = this.getMaxDepthForNote(note, opts.categoryDepthLimits);
      if (maxDepth === -1) {
        // Category is set to ignore
        omissions.push({ note, count, name: this.NOTE_NAMES[note] || `Note ${note}`, reason: 'category ignored' });
        return;
      }

      if (maxDepth === 0) {
        // Exact only: no substitution allowed for this category
        if (instrNotes.includes(note)) {
          mapping[note] = note;
          used.add(note);
        } else if (opts.allowOmission) {
          omissions.push({ note, count, name: this.NOTE_NAMES[note] || `Note ${note}`, reason: 'exact only, not available' });
        }
        return;
      }

      if (opts.allowSubstitution) {
        // Try substitution table first, respecting depth limit
        const substitutes = this.SUBSTITUTION_TABLES[note] || [];
        // Limit the number of substitutes tried based on category depth
        const maxSubs = maxDepth < Infinity ? maxDepth : substitutes.length;
        let found = false;

        for (let i = 0; i < Math.min(substitutes.length, maxSubs); i++) {
          const substitute = substitutes[i];
          if (instrNotes.includes(substitute) && !used.has(substitute)) {
            mapping[note] = substitute;
            substitutions.push({ from: note, to: substitute, type: 'table substitution' });
            found = true;
            break;
          }
        }

        // If still not found, try closest available note (only if depth allows extended search)
        if (!found && maxDepth >= substitutes.length) {
          const availableNotes = instrNotes.filter(n => !used.has(n));
          if (availableNotes.length > 0) {
            const closest = this.findClosestNote(note, availableNotes);
            mapping[note] = closest;
            substitutions.push({ from: note, to: closest, type: 'closest match' });
          } else if (opts.allowSharing && instrNotes.length > 0) {
            // Last resort: reuse already mapped note
            const reusable = instrNotes[0];
            mapping[note] = reusable;
            substitutions.push({ from: note, to: reusable, type: 'note sharing' });
          } else if (opts.allowOmission) {
            omissions.push({ note, count, name: this.NOTE_NAMES[note] || `Note ${note}` });
          }
        } else if (!found && opts.allowOmission) {
          omissions.push({ note, count, name: this.NOTE_NAMES[note] || `Note ${note}`, reason: 'depth limit reached' });
        }
      } else if (opts.allowOmission) {
        omissions.push({ note, count, name: this.NOTE_NAMES[note] || `Note ${note}` });
      }
    });
  }

  /**
   * Find closest note from available notes
   */
  findClosestNote(targetNote, availableNotes) {
    if (availableNotes.length === 0) return null;

    let closest = availableNotes[0];
    let minDistance = Math.abs(targetNote - closest);

    for (const note of availableNotes) {
      const distance = Math.abs(targetNote - note);
      if (distance < minDistance) {
        minDistance = distance;
        closest = note;
      }
    }

    return closest;
  }

  /**
   * Calculate mapping quality score (0-100)
   */
  calculateMappingQuality(mapping, midiNotes, instrNotes, substitutions, omissions) {
    const weights = {
      essentialPreserved: 40,
      importantPreserved: 30,
      optionalPreserved: 15,
      coverageRatio: 10,
      accuracyRatio: 5
    };

    let score = 0;

    // 1. Essential notes preserved
    const essentialScore = this.scoreEssentialNotes(mapping, midiNotes);
    score += (essentialScore / 100) * weights.essentialPreserved;

    // 2. Important notes preserved
    const importantScore = this.scoreImportantNotes(mapping, midiNotes);
    score += (importantScore / 100) * weights.importantPreserved;

    // 3. Optional notes preserved
    const optionalScore = this.scoreOptionalNotes(mapping, midiNotes);
    score += (optionalScore / 100) * weights.optionalPreserved;

    // 4. Coverage ratio
    const mappedCount = Object.keys(mapping).length;
    const totalCount = midiNotes.usedNotes.length;
    const coverageRatio = totalCount > 0 ? mappedCount / totalCount : 1;
    score += coverageRatio * weights.coverageRatio;

    // 5. Accuracy ratio (exact matches)
    const exactCount = Object.entries(mapping)
      .filter(([src, tgt]) => parseInt(src) === tgt)
      .length;
    const accuracyRatio = mappedCount > 0 ? exactCount / mappedCount : 0;
    score += accuracyRatio * weights.accuracyRatio;

    return {
      score: Math.round(score),
      essentialScore,
      importantScore,
      optionalScore,
      coverageRatio: Math.round(coverageRatio * 100),
      accuracyRatio: Math.round(accuracyRatio * 100),
      mappedCount,
      totalCount,
      substitutionCount: substitutions.length,
      omissionCount: omissions.length
    };
  }

  /**
   * Score essential notes preservation (0-100)
   */
  scoreEssentialNotes(mapping, midiNotes) {
    const { categories } = midiNotes;
    let score = 0;
    let total = 0;

    // Kick
    if (categories.kicks.length > 0) {
      total += 25;
      if (categories.kicks.some(k => mapping[k] && this.DRUM_CATEGORIES.kicks.includes(mapping[k]))) {
        score += 25;
      } else if (categories.kicks.some(k => mapping[k])) {
        score += 15;
      }
    }

    // Snare
    if (categories.snares.length > 0) {
      total += 25;
      if (categories.snares.some(s => mapping[s] && this.DRUM_CATEGORIES.snares.includes(mapping[s]))) {
        score += 25;
      } else if (categories.snares.some(s => mapping[s])) {
        score += 15;
      }
    }

    // Hi-Hat
    if (categories.hiHats.length > 0) {
      total += 25;
      if (categories.hiHats.some(h => mapping[h] && this.DRUM_CATEGORIES.hiHats.includes(mapping[h]))) {
        score += 25;
      } else if (categories.hiHats.some(h => mapping[h])) {
        score += 15;
      }
    }

    // Crash
    if (categories.crashes.length > 0) {
      total += 25;
      if (categories.crashes.some(c => mapping[c] && this.DRUM_CATEGORIES.crashes.includes(mapping[c]))) {
        score += 25;
      } else if (categories.crashes.some(c => mapping[c])) {
        score += 15;
      }
    }

    return total > 0 ? Math.round((score / total) * 100) : 100;
  }

  /**
   * Score important notes preservation (0-100)
   */
  scoreImportantNotes(mapping, midiNotes) {
    const { categories } = midiNotes;
    let score = 0;
    let total = 0;

    // Open Hi-Hat
    if (categories.hiHats.includes(46)) {
      total += 30;
      if (mapping[46] && mapping[46] === 46) {
        score += 30;
      } else if (mapping[46]) {
        score += 20;
      }
    }

    // Toms
    if (categories.toms.length > 0) {
      total += 40;
      const tomsMapped = categories.toms.filter(t => mapping[t]);
      const ratio = tomsMapped.length / categories.toms.length;
      score += Math.round(40 * ratio);
    }

    // Ride
    if (categories.rides.length > 0) {
      total += 30;
      if (categories.rides.some(r => mapping[r] && this.DRUM_CATEGORIES.rides.includes(mapping[r]))) {
        score += 30;
      } else if (categories.rides.some(r => mapping[r])) {
        score += 20;
      }
    }

    return total > 0 ? Math.round((score / total) * 100) : 100;
  }

  /**
   * Score optional notes preservation (0-100)
   */
  scoreOptionalNotes(mapping, midiNotes) {
    const { categories } = midiNotes;
    let score = 0;
    let total = 0;

    // Latin percussion
    if (categories.latin.length > 0) {
      total += 50;
      const latinMapped = categories.latin.filter(l => mapping[l]);
      const ratio = latinMapped.length / categories.latin.length;
      score += Math.round(50 * ratio);
    }

    // Misc percussion
    if (categories.misc.length > 0) {
      total += 50;
      const miscMapped = categories.misc.filter(m => mapping[m]);
      const ratio = miscMapped.length / categories.misc.length;
      score += Math.round(50 * ratio);
    }

    return total > 0 ? Math.round((score / total) * 100) : 100;
  }

  /**
   * Get human-readable mapping report
   */
  getMappingReport(mappingResult) {
    const { mapping, substitutions, omissions, quality } = mappingResult;

    const report = {
      summary: {
        totalMapped: Object.keys(mapping).length,
        substitutions: substitutions.length,
        omissions: omissions.length,
        qualityScore: quality.score
      },
      details: {
        exactMappings: [],
        substitutionMappings: [],
        omittedNotes: []
      }
    };

    // Categorize mappings
    Object.entries(mapping).forEach(([src, tgt]) => {
      const srcNote = parseInt(src);
      const srcName = this.NOTE_NAMES[srcNote] || `Note ${srcNote}`;
      const tgtName = this.NOTE_NAMES[tgt] || `Note ${tgt}`;

      if (srcNote === tgt) {
        report.details.exactMappings.push(`${srcName} (${srcNote})`);
      } else {
        report.details.substitutionMappings.push(`${srcName} (${srcNote}) → ${tgtName} (${tgt})`);
      }
    });

    // Omissions
    omissions.forEach(omission => {
      report.details.omittedNotes.push(`${omission.name} (${omission.note}) - used ${omission.count} times`);
    });

    return report;
  }
}

export default DrumNoteMapper;
