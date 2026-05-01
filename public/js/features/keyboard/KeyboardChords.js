// ============================================================================
// KeyboardChords.js — Chord button system for string-instrument fretboard view
// ============================================================================
// Mixin for KeyboardModalNew. Provides:
//   - 6 chord-type buttons (Maj / Min / 5 / 7 / Maj7 / m7)
//   - Left-half click → strum grave→aigu  |  right-half click → strum aigu→grave
//   - Click distance from centre → strum speed (5–25 ms per string)
//   - Shift+click → secondary voicing (sus4 / sus2 / m7b5 …)
//   - Automatic string mapping with root on lowest string + cycling
//   - Per-instrument polyphony cap (guitar=all, bass=3, bowed=2)
// ============================================================================
(function () {
    'use strict';
    const KeyboardChordsMixin = {};

    // ── Chord interval templates (semitones from root) ──────────────────────
    const CHORD_INTERVALS = {
        'Maj':  [0, 4, 7],
        'Min':  [0, 3, 7],
        '5':    [0, 7],
        '7':    [0, 4, 7, 10],
        'Maj7': [0, 4, 7, 11],
        'm7':   [0, 3, 7, 10],
    };

    // Secondary voicings (Shift+click): sus/dim variants
    const CHORD_INTERVALS_ALT = {
        'Maj':  [0, 5, 7],     // sus4
        'Min':  [0, 2, 7],     // sus2
        '5':    [0, 5, 7],     // sus4
        '7':    [0, 5, 7, 10], // 7sus4
        'Maj7': [0, 5, 7, 11], // Maj7sus4
        'm7':   [0, 3, 6, 10], // m7b5 (half-diminished)
    };

    const CHORD_ALT_LABEL = {
        'Maj':  'sus4',
        'Min':  'sus2',
        '5':    'sus4',
        '7':    '7sus4',
        'Maj7': 'M7s4',
        'm7':   'ø7',
    };

    const NOTE_NAMES_EN = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const NOTE_NAMES_FR = ['Do', 'Do#', 'Ré', 'Ré#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];

    // ── Per-instance state (patched onto KeyboardModalNew.prototype) ─────────
    KeyboardChordsMixin.chordRoot = 0;       // semitone class 0–11 (0 = C)
    KeyboardChordsMixin._strumTimeouts = []; // pending timeout handles

    // ── Helpers ──────────────────────────────────────────────────────────────

    KeyboardChordsMixin._chordRootName = function (noteClass) {
        if (this.noteLabelFormat === 'solfege') return NOTE_NAMES_FR[noteClass];
        return NOTE_NAMES_EN[noteClass];
    };

    // ── Render: chord buttons bar ────────────────────────────────────────────

    /**
     * Render the chord buttons bar inside the fretboard container.
     * Called at the end of renderFretboard().
     */
    KeyboardChordsMixin.renderChordButtons = function () {
        const container = document.getElementById('fretboard-container');
        if (!container) return;

        // Remove any pre-existing bar (e.g. after a re-render)
        const old = container.querySelector('.chord-buttons-bar');
        if (old) old.remove();

        const bar = document.createElement('div');
        bar.className = 'chord-buttons-bar';

        // ── Root note selector ──
        const rootRow = document.createElement('div');
        rootRow.className = 'chord-root-row';

        const rootLabel = document.createElement('span');
        rootLabel.className = 'chord-root-label';
        rootLabel.textContent = 'Root';
        rootRow.appendChild(rootLabel);

        const rootBtns = document.createElement('div');
        rootBtns.className = 'chord-root-btns';
        NOTE_NAMES_EN.forEach((_, idx) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'chord-root-btn' + (idx === this.chordRoot ? ' active' : '');
            btn.dataset.noteClass = String(idx);
            btn.textContent = this._chordRootName(idx);
            rootBtns.appendChild(btn);
        });
        rootRow.appendChild(rootBtns);
        bar.appendChild(rootRow);

        // ── Chord type buttons ──
        const typeRow = document.createElement('div');
        typeRow.className = 'chord-type-row';

        ['Maj', 'Min', '5', '7', 'Maj7', 'm7'].forEach(type => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'chord-type-btn';
            btn.dataset.chordType = type;
            btn.title = `${this._chordRootName(this.chordRoot)} ${type} · ← grave→aigu  →  aigu→grave · Shift: ${CHORD_ALT_LABEL[type]}`;

            btn.innerHTML = `
                <span class="chord-strum-l" aria-hidden="true">↓</span>
                <span class="chord-type-label">
                    <span class="chord-name">${type}</span>
                    <span class="chord-alt-name">${CHORD_ALT_LABEL[type]}</span>
                </span>
                <span class="chord-strum-r" aria-hidden="true">↑</span>
            `;
            typeRow.appendChild(btn);
        });

        bar.appendChild(typeRow);
        container.appendChild(bar);

        this._attachChordButtonEvents(bar);
    };

    // ── Event wiring ─────────────────────────────────────────────────────────

    KeyboardChordsMixin._attachChordButtonEvents = function (bar) {
        if (!bar) return;

        // Root note selection (event delegation on the button group)
        bar.querySelector('.chord-root-btns').addEventListener('click', (e) => {
            const btn = e.target.closest('.chord-root-btn');
            if (!btn) return;
            this.chordRoot = parseInt(btn.dataset.noteClass, 10);
            bar.querySelectorAll('.chord-root-btn').forEach(b =>
                b.classList.toggle('active', parseInt(b.dataset.noteClass, 10) === this.chordRoot)
            );
            // Refresh tooltips with new root name
            bar.querySelectorAll('.chord-type-btn').forEach(b => {
                const t = b.dataset.chordType;
                b.title = `${this._chordRootName(this.chordRoot)} ${t} · ← grave→aigu  →  aigu→grave · Shift: ${CHORD_ALT_LABEL[t]}`;
            });
        });

        // Chord type buttons — mouse
        bar.querySelector('.chord-type-row').addEventListener('mousedown', (e) => {
            const btn = e.target.closest('.chord-type-btn');
            if (!btn) return;
            e.preventDefault();
            e.stopPropagation();
            this._triggerStrum(btn, e.clientX, e.shiftKey);
        });

        // Chord type buttons — touch
        bar.querySelector('.chord-type-row').addEventListener('touchstart', (e) => {
            const btn = e.target.closest('.chord-type-btn');
            if (!btn) return;
            e.preventDefault();
            e.stopPropagation();
            this._triggerStrum(btn, e.touches[0].clientX, false);
        }, { passive: false });
    };

    /**
     * Determine strum direction + speed from click X position, then play.
     */
    KeyboardChordsMixin._triggerStrum = function (btn, clientX, useAlt) {
        const rect = btn.getBoundingClientRect();
        const relX  = clientX - rect.left;
        const half  = rect.width / 2;
        const strumDown = relX < half;                          // left = low→high
        const dist  = Math.abs(relX - half) / half;            // 0 (edge) – 1 (centre)
        // Far from centre → slower strum; close to centre → faster
        const delayMs = Math.round(25 - dist * 20);            // 5–25 ms

        const chordType = btn.dataset.chordType;
        btn.classList.add('strum-active');
        setTimeout(() => btn.classList.remove('strum-active'), 380);

        this._playChordStrum(this.chordRoot, chordType, strumDown, delayMs, useAlt);
    };

    // ── Chord generation ─────────────────────────────────────────────────────

    /**
     * Maximum simultaneous strings per instrument family.
     */
    KeyboardChordsMixin._chordMaxPolyphony = function (gmProgram, numStrings) {
        if (gmProgram != null) {
            // Bowed strings (violin/viola/cello/contrabass/tremolo/pizzicato/fiddle)
            if ([40, 41, 42, 43, 44, 45, 110].includes(gmProgram)) return 2;
            // Bass family
            if (gmProgram >= 32 && gmProgram <= 39) return Math.min(numStrings, 3);
        }
        return numStrings;
    };

    /**
     * Map chord note classes to playable pitches, one per string.
     *
     * Rules (per spec):
     *  - Strings sorted grave→aigu (tuning[0] = lowest)
     *  - Root assigned to the lowest string; remaining chord tones cycle upward
     *  - Each note is the closest pitch ≥ open-string pitch with the target semitone class (frets 0–11)
     *  - If adjacent strings would produce a unison / semitone clash, the higher string shifts up an octave
     *  - Returns an array limited to maxPoly strings
     *
     * @param {number}   rootClass  - Root semitone class (0–11)
     * @param {number[]} intervals  - Semitone intervals from root
     * @param {number[]} tuning     - Open-string MIDI pitches, index 0 = lowest
     * @param {number}   maxPoly    - Max simultaneous strings
     * @returns {Array<{string: number, note: number, time: number}>}
     */
    KeyboardChordsMixin._mapChordToStrings = function (rootClass, intervals, tuning, maxPoly) {
        const chordClasses = intervals.map(i => (rootClass + i) % 12);
        const limit = Math.min(maxPoly, tuning.length);
        const result = [];

        for (let s = 0; s < tuning.length && result.length < limit; s++) {
            const openPitch   = tuning[s];
            const targetClass = chordClasses[s % chordClasses.length]; // cycle

            // Fret 0–11: first occurrence of targetClass ≥ openPitch
            const openClass = openPitch % 12;
            const semiDiff  = (targetClass - openClass + 12) % 12;
            let note = openPitch + semiDiff;

            // Clamp to MIDI playable range
            if (note < 21)  note += 12;
            if (note > 108) note -= 12;

            // Avoid unison / semitone clash with the previous string's note
            if (result.length > 0) {
                const prev = result[result.length - 1].note;
                if (Math.abs(note - prev) < 2) {
                    note += 12;
                    if (note > 108) note -= 24;
                }
            }

            result.push({ string: s + 1, note, time: 0 });
        }

        return result;
    };

    // ── Strum playback ───────────────────────────────────────────────────────

    /**
     * Play a strummed chord.
     *
     * @param {number}  rootClass  - Root semitone class (0–11)
     * @param {string}  chordType  - Key of CHORD_INTERVALS ('Maj', 'Min', …)
     * @param {boolean} strumDown  - true = grave→aigu, false = aigu→grave
     * @param {number}  delayMs    - ms between consecutive strings (5–25)
     * @param {boolean} useAlt     - Use secondary voicing (Shift mode)
     */
    KeyboardChordsMixin._playChordStrum = function (rootClass, chordType, strumDown, delayMs, useAlt) {
        // Cancel any in-flight strum
        this._strumTimeouts.forEach(t => clearTimeout(t));
        this._strumTimeouts = [];

        // Stop notes still ringing from a previous strum
        [...(this.activeNotes || [])].forEach(n => this.stopNote(n));

        // ── Resolve instrument config ──
        const cfg = this.stringInstrumentConfig || {};
        const numStrings = Math.max(1, cfg.num_strings || 6);

        const DEFAULT_TUNINGS = {
            3: [50, 57, 62],
            4: [28, 33, 38, 43],
            5: [28, 33, 38, 43, 47],
            6: [40, 45, 50, 55, 59, 64],
            7: [35, 40, 45, 50, 55, 59, 64],
            8: [55, 62, 55, 62, 50, 57, 50, 57], // mandolin (double-course approx.)
        };
        let tuning;
        if (Array.isArray(cfg.tuning) && cfg.tuning.length === numStrings) {
            tuning = cfg.tuning;
        } else if (Array.isArray(cfg.tuning_midi) && cfg.tuning_midi.length === numStrings) {
            tuning = cfg.tuning_midi;
        } else {
            tuning = DEFAULT_TUNINGS[numStrings]
                  || Array.from({ length: numStrings }, (_, i) => 40 + i * 5);
        }

        const caps = this.selectedDeviceCapabilities;
        const gmProgram = (caps && caps.gm_program != null ? caps.gm_program : null)
                       ?? (this.selectedDevice && this.selectedDevice.gm_program != null ? this.selectedDevice.gm_program : null);
        const maxPoly = this._chordMaxPolyphony(gmProgram, numStrings);

        // ── Build chord ──
        const intervalsMap = useAlt ? CHORD_INTERVALS_ALT : CHORD_INTERVALS;
        const intervals = intervalsMap[chordType];
        if (!intervals) return;

        const stringNotes = this._mapChordToStrings(rootClass, intervals, tuning, maxPoly);

        // ── Sort by strum direction ──
        const ordered = strumDown
            ? [...stringNotes].sort((a, b) => a.note - b.note)  // low → high
            : [...stringNotes].sort((a, b) => b.note - a.note); // high → low

        // ── Log strum structure (spec output format) ──
        if (this.logger && this.logger.info) {
            this.logger.info('[Chord] Strum:', {
                root: `${NOTE_NAMES_EN[rootClass]} ${useAlt ? CHORD_ALT_LABEL[chordType] : chordType}`,
                direction: strumDown ? 'down (grave→aigu)' : 'up (aigu→grave)',
                delayMs,
                strings: ordered.map((item, i) => ({
                    string: item.string,
                    note: `${NOTE_NAMES_EN[item.note % 12]}${Math.floor(item.note / 12) - 1}`,
                    midi: item.note,
                    time: i * delayMs,
                })),
            });
        }

        // ── Schedule note-ons ──
        const notesPlayed = new Set();
        const holdMs = 650; // sustain duration before auto-release

        ordered.forEach((item, idx) => {
            const humanize = Math.round(Math.random() * 4 - 2); // ±2 ms jitter
            const delay    = idx * delayMs + Math.max(0, humanize);

            const t = setTimeout(() => {
                if (item.note >= 21 && item.note <= 108) {
                    this.playNote(item.note);
                    notesPlayed.add(item.note);
                }
            }, delay);
            this._strumTimeouts.push(t);
        });

        // ── Auto-release ──
        const stopDelay = (ordered.length > 0 ? ordered.length - 1 : 0) * delayMs + holdMs;
        const stopT = setTimeout(() => {
            notesPlayed.forEach(n => this.stopNote(n));
        }, stopDelay);
        this._strumTimeouts.push(stopT);
    };

    if (typeof window !== 'undefined') window.KeyboardChordsMixin = KeyboardChordsMixin;
})();
