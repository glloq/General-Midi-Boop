// =============================================================================
// VoicingEngine.js — Moteur pur : mapping accord → cordes + scheduling strum
// =============================================================================
// Extrait et généralise la logique de KeyboardChords._mapChordToStrings().
// Sans dépendance DOM. Instanciable et testable unitairement.
//
// VoicingNote : { string: number (1-based), note: number (MIDI), fret: number, time: number (ms) }
// =============================================================================
(function () {
    'use strict';

    // Polytonie maximale par famille GM (identique à KeyboardChords._chordMaxPolyphony)
    const GM_MAX_POLY = [
        // [minProgram, maxProgram, maxPoly]
        [40, 45, 2],   // cordes frottées (violon→contrebasse, tremolo, pizzicato)
        [110, 110, 2], // fiddle
        [32, 39, 3],   // basses
    ];

    const DEFAULT_TUNINGS = {
        3: [50, 57, 62],
        4: [28, 33, 38, 43],
        5: [28, 33, 38, 43, 47],
        6: [40, 45, 50, 55, 59, 64],
        7: [35, 40, 45, 50, 55, 59, 64],
        8: [55, 62, 55, 62, 50, 57, 50, 57],
    };

    class VoicingEngine {
        /**
         * @param {number[]} tuning     MIDI open-string pitches, index 0 = grave
         * @param {number}   numStrings Nombre de cordes
         */
        constructor(tuning, numStrings) {
            this._numStrings = Math.max(1, numStrings || 6);
            this._tuning     = this._resolveTuning(tuning, this._numStrings);
            this._voicingCache = new Map();
        }

        // ── Configuration ──────────────────────────────────────────────────────

        /** Mise à jour du tuning (invalide le cache). */
        setTuning(tuning, numStrings) {
            const n = numStrings != null ? Math.max(1, numStrings) : this._numStrings;
            this._tuning     = this._resolveTuning(tuning, n);
            this._numStrings = n;
            this._voicingCache.clear();
        }

        _resolveTuning(tuning, numStrings) {
            if (Array.isArray(tuning) && tuning.length === numStrings) return tuning;
            return DEFAULT_TUNINGS[numStrings]
                || Array.from({ length: numStrings }, (_, i) => 40 + i * 5);
        }

        // ── Polytonie ─────────────────────────────────────────────────────────

        /**
         * Nombre maximum de cordes simultanées selon le programme GM.
         * @param {number|null} gmProgram
         * @returns {number}
         */
        maxPoly(gmProgram) {
            if (gmProgram != null) {
                for (const [lo, hi, poly] of GM_MAX_POLY) {
                    if (gmProgram >= lo && gmProgram <= hi) return Math.min(this._numStrings, poly);
                }
            }
            return this._numStrings;
        }

        // ── Voicing ───────────────────────────────────────────────────────────

        /**
         * Mappe un accord (intervalles depuis rootClass) sur les cordes disponibles.
         *
         * Règles :
         *  - Cordes triées grave → aigu (tuning[0] = plus grave)
         *  - La fondamentale va sur la corde la plus grave ; les autres degrés cyclent
         *  - Chaque note = première occurrence ≥ corde à vide avec la même classe de hauteur
         *  - Évite les unissons / clashes de demi-ton avec la corde précédente
         *
         * @param {number}   rootClass   Classe de hauteur 0–11
         * @param {number[]} intervals   Intervalles depuis la fondamentale (ex. [0,4,7])
         * @param {number}   [maxPoly]   Surcharge du plafond de polytonie
         * @returns {VoicingNote[]}
         */
        mapChordToStrings(rootClass, intervals, maxPoly) {
            const key = `${rootClass}:${intervals.join(',')}:${maxPoly ?? ''}`;
            if (this._voicingCache.has(key)) return this._voicingCache.get(key);

            const limit = Math.min(
                maxPoly != null ? maxPoly : this._numStrings,
                this._tuning.length
            );
            const chordClasses = intervals.map(i => (rootClass + i) % 12);
            const result = [];

            for (let s = 0; s < this._tuning.length && result.length < limit; s++) {
                const openPitch   = this._tuning[s];
                const targetClass = chordClasses[s % chordClasses.length];

                const openClass = openPitch % 12;
                const semiDiff  = (targetClass - openClass + 12) % 12;
                let note = openPitch + semiDiff;

                if (note < 21)  note += 12;
                if (note > 108) note -= 12;

                // Éviter unisson/clash avec la corde précédente
                if (result.length > 0) {
                    const prev = result[result.length - 1].note;
                    if (Math.abs(note - prev) < 2) {
                        note += 12;
                        if (note > 108) note -= 24;
                    }
                }

                result.push({ string: s + 1, note, fret: semiDiff, time: 0 });
            }

            this._voicingCache.set(key, result);
            return result;
        }

        // ── Scheduling strum ──────────────────────────────────────────────────

        /**
         * Génère un planning de strum avec délais par corde.
         *
         * @param {VoicingNote[]} voicing   Résultat de mapChordToStrings()
         * @param {'down'|'up'}   direction 'down' = grave→aigu, 'up' = aigu→grave
         * @param {number}        delayMs   Délai entre cordes (5–25 ms)
         * @returns {Array<{note: number, delay: number}>}
         */
        strumSchedule(voicing, direction, delayMs) {
            const ordered = direction === 'down'
                ? [...voicing].sort((a, b) => a.note - b.note)
                : [...voicing].sort((a, b) => b.note - a.note);

            return ordered.map((item, idx) => ({
                note:  item.note,
                delay: idx * delayMs,
            }));
        }

        // ── Snap vers corde jouable ────────────────────────────────────────────

        /**
         * Trouve la corde et le fret le plus proches d'une note cible,
         * contraint à la fenêtre de main (handAnchor … handAnchor+handSpan).
         *
         * @param {number} targetNote   Note MIDI cible
         * @param {number} handAnchor   Fret de départ de la main
         * @param {number} handSpan     Étendue en frets de la main
         * @returns {VoicingNote}
         */
        snapToPlayable(targetNote, handAnchor, handSpan) {
            const anchor = handAnchor || 0;
            const span   = handSpan   || 4;
            let best  = null;
            let bestD = Infinity;

            for (let s = 0; s < this._tuning.length; s++) {
                const openPitch = this._tuning[s];
                for (let fret = anchor; fret <= anchor + span; fret++) {
                    const note = openPitch + fret;
                    if (note < 21 || note > 108) continue;
                    const d = Math.abs(note - targetNote);
                    if (d < bestD) {
                        bestD = d;
                        best  = { string: s + 1, note, fret, time: 0 };
                    }
                }
                // Corde à vide (toujours jouable si dans la plage)
                if (openPitch >= 21 && openPitch <= 108) {
                    const d = Math.abs(openPitch - targetNote);
                    if (d < bestD) {
                        bestD = d;
                        best  = { string: s + 1, note: openPitch, fret: 0, time: 0 };
                    }
                }
            }

            return best || { string: 1, note: targetNote, fret: 0, time: 0 };
        }

        // ── Cache ─────────────────────────────────────────────────────────────

        /** Invalider le cache (appeler après changement de tuning). */
        invalidateCache() {
            this._voicingCache.clear();
        }

        get tuning()     { return this._tuning;     }
        get numStrings() { return this._numStrings; }
    }

    if (typeof window !== 'undefined') window.VoicingEngine = VoicingEngine;
    if (typeof module !== 'undefined') module.exports = VoicingEngine;
})();
