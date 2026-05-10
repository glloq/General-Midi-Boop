// ============================================================================
// Fichier: public/js/utils/MidiConstants.js
// Description: Constantes MIDI partagees (notes, instruments, utilitaires)
//   Source unique de verite pour NOTE_NAMES, noteNumberToName, isBlackKey
// ============================================================================

const MidiConstants = {

    NOTE_NAMES: ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'],

    /**
     * Convertir un numero de note MIDI en nom de note (ex: 60 -> "C4")
     * @param {number} note - Numero de note MIDI (0-127)
     * @returns {string} Nom de la note
     */
    noteNumberToName(note) {
        if (note < 0 || note > 127) return `?${note}`;
        return this.NOTE_NAMES[note % 12] + (Math.floor(note / 12) - 1);
    },

    /**
     * Verifier si une note MIDI est une touche noire.
     * Accepte les valeurs negatives ou hors plage : on normalise le
     * pitch-class avant de tester, ce qui evite de dupliquer le pattern
     * `((m % 12) + 12) % 12` chez chaque appelant.
     * @param {number} note - Numero de note MIDI
     * @returns {boolean}
     */
    isBlackKey(note) {
        const n = ((note % 12) + 12) % 12;
        return n === 1 || n === 3 || n === 6 || n === 8 || n === 10;
    },

    /**
     * Clamp `value` to `[lo, hi]`. Handles unordered bounds defensively
     * (swaps when lo > hi). Non-finite values resolve to `lo`.
     *
     * Shared so the ~14 inline `Math.max(lo, Math.min(hi, v))` patterns
     * across the frontend can converge (see AUDIT 2026-05-10 §21).
     *
     * @param {number} value
     * @param {number} lo
     * @param {number} hi
     * @returns {number}
     */
    clamp(value, lo, hi) {
        if (lo > hi) { const t = lo; lo = hi; hi = t; }
        const v = Number(value);
        if (!Number.isFinite(v)) return lo;
        return v < lo ? lo : v > hi ? hi : v;
    },

    /** Clamp a value into the MIDI 0-127 range. */
    clamp7bit(value) {
        return MidiConstants.clamp(value, 0, 127);
    }
};

if (typeof window !== 'undefined') {
    window.MidiConstants = MidiConstants;
}
