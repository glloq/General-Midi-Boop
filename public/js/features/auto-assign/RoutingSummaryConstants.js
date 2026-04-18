// public/js/features/auto-assign/RoutingSummaryConstants.js
// Module-level constants extracted from RoutingSummaryPage.js (P2-F.1, plan §11 step 1).
// Exposed on `window.RoutingSummaryConstants` because the codebase uses
// IIFE+globals (no ES modules in /public/js).

(function() {
  'use strict';

  const _t = (key, params) => typeof i18n !== 'undefined' ? i18n.t(key, params) : key;

  // Maximum length displayed for an instrument name in the routing summary.
  const MAX_INST_NAME = 18;

  // Color palette used to distinguish split segments within a single channel row.
  const SPLIT_COLORS = ['#4A90D9', '#E67E22', '#27AE60', '#9B59B6'];

  // Black-key positions within an octave (semitones 0..11).
  // C#=1, D#=3, F#=6, G#=8, A#=10
  const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);

  // Note name lookup. Source-of-truth lives in MidiConstants.
  const NOTE_NAMES = (typeof MidiConstants !== 'undefined' && MidiConstants.NOTE_NAMES) || [
    'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'
  ];

  /**
   * GM default polyphony by program (0-127). Reflects the typical polyphony
   * of the real acoustic instrument so auto-assign can warn when the routed
   * device offers less.
   */
  const GM_DEFAULT_POLYPHONY = {
    0:16,1:16,2:16,3:16,4:16,5:16,6:8,7:8,
    8:8,9:4,10:4,11:6,12:4,13:4,14:8,15:4,
    16:16,17:16,18:16,19:16,20:16,21:8,22:1,23:8,
    24:6,25:6,26:6,27:6,28:6,29:6,30:6,31:6,
    32:1,33:1,34:1,35:1,36:1,37:1,38:1,39:1,
    40:4,41:4,42:4,43:4,44:8,45:8,46:8,47:2,
    48:16,49:16,50:16,51:16,52:16,53:16,54:16,55:1,
    56:1,57:1,58:1,59:1,60:1,61:8,62:8,63:8,
    64:1,65:1,66:1,67:1,68:1,69:1,70:1,71:1,
    72:1,73:1,74:1,75:1,76:1,77:1,78:1,79:1,
    80:1,81:1,82:1,83:1,84:1,85:1,86:2,87:2,
    88:8,89:8,90:8,91:8,92:8,93:8,94:8,95:8,
    96:4,97:4,98:4,99:4,100:4,101:4,102:4,103:4,
    104:4,105:6,106:4,107:4,108:4,109:1,110:4,111:1,
    112:4,113:4,114:2,115:2,116:4,117:4,118:4,119:4,
    120:1,121:1,122:1,123:1,124:1,125:1,126:1,127:1
  };

  function getGmDefaultPolyphony(gmProgram) {
    if (gmProgram == null || gmProgram < 0 || gmProgram > 127) return 16;
    return GM_DEFAULT_POLYPHONY[gmProgram] ?? 16;
  }

  function midiNoteToName(note) {
    return NOTE_NAMES[note % 12] + Math.floor(note / 12);
  }

  /**
   * Clamp a note range to valid MIDI bounds and ensure min <= max.
   */
  function safeNoteRange(min, max) {
    let lo = Math.max(0, Math.min(127, Math.round(min ?? 0)));
    let hi = Math.max(0, Math.min(127, Math.round(max ?? 127)));
    if (lo > hi) { const t = lo; lo = hi; hi = t; }
    return { min: lo, max: hi };
  }

  function getScoreClass(score) {
    if (score >= 80) return 'rs-color-excellent';
    if (score >= 60) return 'rs-color-good';
    if (score >= 40) return 'rs-color-fair';
    return 'rs-color-poor';
  }

  function getScoreBgClass(score) {
    if (score >= 80) return 'rs-bg-excellent';
    if (score >= 60) return 'rs-bg-good';
    if (score >= 40) return 'rs-bg-fair';
    return 'rs-bg-poor';
  }

  function getScoreLabel(score) {
    if (score >= 90) return _t('autoAssign.scoreExcellent');
    if (score >= 75) return _t('autoAssign.scoreGood');
    if (score >= 60) return _t('autoAssign.scoreAverage');
    if (score >= 40) return _t('autoAssign.scoreFair');
    return _t('autoAssign.scorePoor');
  }

  function getTypeIcon(type) {
    const icons = {
      drums: '\uD83E\uDD41', bass: '\uD83C\uDFB8', melody: '\uD83C\uDFB9',
      harmony: '\uD83C\uDFB5', pad: '\uD83C\uDFB6', strings: '\uD83C\uDFBB',
      brass: '\uD83C\uDFBA', piano: '\uD83C\uDFB9', organ: '\uD83C\uDFB9',
      guitar: '\uD83C\uDFB8', reed: '\uD83C\uDFB7', pipe: '\uD83E\uDE88',
      ensemble: '\uD83C\uDFB5', synth_lead: '\uD83C\uDFB9', synth_pad: '\uD83C\uDFB6'
    };
    return icons[type] || '\uD83C\uDFB5';
  }

  function getTypeColor(type) {
    const colors = {
      drums: '#E91E63', bass: '#9C27B0', melody: '#2196F3',
      harmony: '#4CAF50', pad: '#00BCD4', strings: '#FF9800',
      brass: '#F44336', piano: '#3F51B5', organ: '#795548',
      guitar: '#FF5722', reed: '#009688', pipe: '#607D8B',
      ensemble: '#8BC34A', synth_lead: '#673AB7', synth_pad: '#00BCD4'
    };
    return colors[type] || '#607D8B';
  }

  function getGmProgramName(program) {
    if (program == null || program < 0 || program > 127) return null;
    if (typeof getGMInstrumentName === 'function') return getGMInstrumentName(program);
    if (typeof GM_INSTRUMENTS !== 'undefined' && GM_INSTRUMENTS[program]) return GM_INSTRUMENTS[program];
    return `Program ${program}`;
  }

  // Full MIDI note range (0-127, inclusive = 128 values).
  const FULL_RANGE = 128;

  // CC editor pagination size.
  const CC_PAGE_SIZE = 10;

  // GM drum note names (notes 35-81, GM drum range).
  const DRUM_NAMES = Object.freeze({
    35: 'Acoustic Bass Drum', 36: 'Bass Drum 1',       37: 'Side Stick',     38: 'Acoustic Snare',
    39: 'Hand Clap',          40: 'Electric Snare',    41: 'Low Floor Tom',  42: 'Closed Hi-Hat',
    43: 'High Floor Tom',     44: 'Pedal Hi-Hat',      45: 'Low Tom',        46: 'Open Hi-Hat',
    47: 'Low-Mid Tom',        48: 'Hi-Mid Tom',        49: 'Crash Cymbal 1', 50: 'High Tom',
    51: 'Ride Cymbal 1',      52: 'Chinese Cymbal',    53: 'Ride Bell',      54: 'Tambourine',
    55: 'Splash Cymbal',      56: 'Cowbell',           57: 'Crash Cymbal 2', 58: 'Vibraslap',
    59: 'Ride Cymbal 2',      60: 'Hi Bongo',          61: 'Low Bongo',      62: 'Mute Hi Conga',
    63: 'Open Hi Conga',      64: 'Low Conga',         65: 'High Timbale',   66: 'Low Timbale',
    67: 'High Agogo',         68: 'Low Agogo',         69: 'Cabasa',         70: 'Maracas',
    71: 'Short Whistle',      72: 'Long Whistle',      73: 'Short Guiro',    74: 'Long Guiro',
    75: 'Claves',             76: 'Hi Wood Block',     77: 'Low Wood Block', 78: 'Mute Cuica',
    79: 'Open Cuica',         80: 'Mute Triangle',     81: 'Open Triangle'
  });

  window.RoutingSummaryConstants = Object.freeze({
    MAX_INST_NAME,
    SPLIT_COLORS,
    BLACK_KEYS,
    NOTE_NAMES,
    GM_DEFAULT_POLYPHONY,
    FULL_RANGE,
    CC_PAGE_SIZE,
    DRUM_NAMES,
    getGmDefaultPolyphony,
    midiNoteToName,
    safeNoteRange,
    getScoreClass,
    getScoreBgClass,
    getScoreLabel,
    getTypeIcon,
    getTypeColor,
    getGmProgramName
  });
})();
