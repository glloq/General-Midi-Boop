// =============================================================================
// NoteEngine.js — Moteur pur : gammes, mapping position → note MIDI
// =============================================================================
// Sans dépendance DOM. Instanciable et testable unitairement.
// Consommé par NoteSlider (UI) et, en option, par KeyboardChords (root control).
// =============================================================================
(function () {
    'use strict';

    // ── Gammes : intervalles en demi-tons depuis la fondamentale ──────────────
    const SCALE_INTERVALS = {
        chromatic:   [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        major:       [0, 2, 4, 5, 7, 9, 11],
        minor:       [0, 2, 3, 5, 7, 8, 10],
        pentatonic:  [0, 2, 4, 7, 9],
        blues:       [0, 3, 5, 6, 7, 10],
    };

    const NOTE_NAMES_EN = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const NOTE_NAMES_FR = ['Do', 'Do#', 'Ré', 'Ré#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];

    // ── Classe ────────────────────────────────────────────────────────────────
    class NoteEngine {
        constructor() {
            this._root    = 0;    // classe de hauteur 0–11 (0 = C)
            this._type    = 'chromatic';
            this._minNote = 36;   // C2
            this._maxNote = 84;   // C6
            this._scaleCache = null;
        }

        // ── Configuration ──────────────────────────────────────────────────────

        /**
         * @param {number} root  Classe de hauteur 0–11
         * @param {string} type  'chromatic'|'major'|'minor'|'pentatonic'|'blues'
         */
        setScale(root, type) {
            const r = ((root % 12) + 12) % 12;
            const t = SCALE_INTERVALS[type] ? type : 'chromatic';
            if (r !== this._root || t !== this._type) {
                this._root = r;
                this._type = t;
                this._scaleCache = null;
            }
        }

        /** @param {number} minNote  MIDI 0–127 */
        setRange(minNote, maxNote) {
            this._minNote = Math.max(0,   Math.min(127, Math.round(minNote)));
            this._maxNote = Math.max(0,   Math.min(127, Math.round(maxNote)));
            this._scaleCache = null;
        }

        // ── Gamme ──────────────────────────────────────────────────────────────

        /**
         * Retourne toutes les notes MIDI de la gamme dans la plage configurée.
         * @returns {number[]}
         */
        getScaleNotes() {
            if (!this._scaleCache) {
                this._scaleCache = this._buildScaleNotes();
            }
            return this._scaleCache;
        }

        _buildScaleNotes() {
            const intervals = SCALE_INTERVALS[this._type];
            const notes = [];
            for (let n = this._minNote; n <= this._maxNote; n++) {
                const cls = ((n - this._root) % 12 + 12) % 12;
                if (intervals.includes(cls)) {
                    notes.push(n);
                }
            }
            return notes;
        }

        // ── Mapping position → note ────────────────────────────────────────────

        /**
         * Convertit une position normalisée (0–1) en note MIDI discrète
         * alignée sur la gamme active.
         *
         * @param {number} ratio  Position normalisée 0 (gauche/grave) → 1 (droite/aigu)
         * @returns {number}  Note MIDI entière
         */
        noteFromRatio(ratio) {
            const scaleNotes = this.getScaleNotes();
            if (scaleNotes.length === 0) return this._minNote;
            const clamped = Math.max(0, Math.min(1, ratio));
            const idx = Math.round(clamped * (scaleNotes.length - 1));
            return scaleNotes[idx];
        }

        /**
         * Version continue : retourne un float MIDI pour le pitch bend.
         * Interpole entre les degrés de gamme.
         *
         * @param {number} ratio  0–1
         * @returns {number}  Note MIDI (float)
         */
        noteFromRatioContinuous(ratio) {
            const scaleNotes = this.getScaleNotes();
            if (scaleNotes.length === 0) return this._minNote;
            const clamped = Math.max(0, Math.min(1, ratio));
            const fIdx = clamped * (scaleNotes.length - 1);
            const lo = Math.floor(fIdx);
            const hi = Math.min(scaleNotes.length - 1, lo + 1);
            return scaleNotes[lo] + (fIdx - lo) * (scaleNotes[hi] - scaleNotes[lo]);
        }

        /**
         * Snapper : retourne la note de gamme la plus proche d'une note MIDI quelconque.
         * @param {number} note  Note MIDI (int)
         * @returns {number}
         */
        snapToScale(note) {
            const scaleNotes = this.getScaleNotes();
            if (scaleNotes.length === 0) return note;
            let best = scaleNotes[0];
            let bestDist = Math.abs(note - best);
            for (let i = 1; i < scaleNotes.length; i++) {
                const d = Math.abs(note - scaleNotes[i]);
                if (d < bestDist) { bestDist = d; best = scaleNotes[i]; }
            }
            return best;
        }

        // ── Nommage ───────────────────────────────────────────────────────────

        /**
         * @param {number} note   MIDI 0–127
         * @param {'english'|'solfege'|'midi'} format
         * @returns {string}
         */
        noteName(note, format) {
            if (format === 'midi') return String(note);
            const cls    = note % 12;
            const octave = Math.floor(note / 12) - 1;
            const name   = format === 'solfege' ? NOTE_NAMES_FR[cls] : NOTE_NAMES_EN[cls];
            return `${name}${octave}`;
        }

        /** Retourne la classe de hauteur (0–11) d'une note MIDI. */
        noteClass(note) {
            return note % 12;
        }

        // ── Introspection ──────────────────────────────────────────────────────

        get root()    { return this._root;    }
        get type()    { return this._type;    }
        get minNote() { return this._minNote; }
        get maxNote() { return this._maxNote; }

        /** Noms des gammes disponibles. */
        static get SCALE_TYPES() {
            return Object.keys(SCALE_INTERVALS);
        }
    }

    if (typeof window !== 'undefined') window.NoteEngine = NoteEngine;
    if (typeof module !== 'undefined') module.exports = NoteEngine;
})();
