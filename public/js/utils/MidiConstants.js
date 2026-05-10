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
    }
};

if (typeof window !== 'undefined') {
    window.MidiConstants = MidiConstants;
}
