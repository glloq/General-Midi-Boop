// ============================================================================
// Fichier: public/js/features/instrument-settings/ChordLibrary.js
// Description: Bibliothèque d'accords courants (triades + 7e). Le sélecteur
//   d'accords de l'onglet Notes & Capacités l'utilise pour remplir les notes
//   jouables discrètes : pour une fondamentale + un type d'accord, toutes les
//   occurrences des classes de hauteur de l'accord dans la tessiture de
//   l'instrument.
//
//   Exposé via window.ChordLibrary :
//     - CHORDS : liste ordonnée { id, intervals, labelKey, labelFr }
//     - ROOTS  : 12 classes de hauteur [{ pc }]
//     - rootLabel(pc) → nom de la note (US/Latin selon le réglage piano)
//     - buildChordNotes(rootPc, typeId, rangeMin, rangeMax) → notes MIDI triées
// ============================================================================

(function() {
    'use strict';

    // Triades + accords de 7e — le « plus courant » en pop / jazz.
    const CHORDS = [
        { id: 'major', intervals: [0, 4, 7],     labelKey: 'instrumentSettings.chordMajor', labelFr: 'Majeur' },
        { id: 'minor', intervals: [0, 3, 7],     labelKey: 'instrumentSettings.chordMinor', labelFr: 'Mineur' },
        { id: 'dim',   intervals: [0, 3, 6],     labelKey: 'instrumentSettings.chordDim',   labelFr: 'Diminué' },
        { id: 'aug',   intervals: [0, 4, 8],     labelKey: 'instrumentSettings.chordAug',   labelFr: 'Augmenté' },
        { id: 'sus4',  intervals: [0, 5, 7],     labelKey: 'instrumentSettings.chordSus4',  labelFr: 'Sus4' },
        { id: 'dom7',  intervals: [0, 4, 7, 10], labelKey: 'instrumentSettings.chordDom7',  labelFr: '7 (dominante)' },
        { id: 'maj7',  intervals: [0, 4, 7, 11], labelKey: 'instrumentSettings.chordMaj7',  labelFr: 'Majeur 7' },
        { id: 'min7',  intervals: [0, 3, 7, 10], labelKey: 'instrumentSettings.chordMin7',  labelFr: 'Mineur 7' },
    ];

    const ROOTS = [];
    for (let pc = 0; pc < 12; pc++) ROOTS.push({ pc: pc });

    const US_NAMES = (typeof MidiConstants !== 'undefined' && MidiConstants.NOTE_NAMES)
        ? MidiConstants.NOTE_NAMES
        : ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

    // Pitch-class label honouring the piano US/Latin notation toggle
    // (window.getPianoNoteName lives inline in index.html). Falls back to the
    // US set when that global is unavailable (e.g. jsdom unit tests).
    function rootLabel(pc) {
        if (typeof window !== 'undefined' && typeof window.getPianoNoteName === 'function') {
            return window.getPianoNoteName(pc);
        }
        return US_NAMES[((pc % 12) + 12) % 12];
    }

    function getChord(typeId) {
        return CHORDS.find(function(c) { return c.id === typeId; }) || null;
    }

    /**
     * Every MIDI note in [rangeMin, rangeMax] whose pitch class belongs to the
     * chord (rootPc + intervals). Sorted ascending, unique. Returns [] on
     * invalid input.
     */
    function buildChordNotes(rootPc, typeId, rangeMin, rangeMax) {
        if (!Number.isInteger(rootPc) || rootPc < 0 || rootPc > 11) return [];
        const chord = getChord(typeId);
        if (!chord) return [];
        let lo = Math.round(rangeMin);
        let hi = Math.round(rangeMax);
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) return [];
        lo = Math.max(0, lo);
        hi = Math.min(127, hi);
        if (lo > hi) return [];
        const pcs = new Set(chord.intervals.map(function(i) { return (rootPc + i) % 12; }));
        const notes = [];
        for (let m = lo; m <= hi; m++) {
            if (pcs.has(m % 12)) notes.push(m);
        }
        return notes;
    }

    const api = {
        CHORDS: CHORDS,
        ROOTS: ROOTS,
        rootLabel: rootLabel,
        getChord: getChord,
        buildChordNotes: buildChordNotes,
    };

    if (typeof window !== 'undefined') window.ChordLibrary = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
