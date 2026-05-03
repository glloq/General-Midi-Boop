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
    KeyboardChordsMixin.chordRoot = 0;          // semitone class 0–11 (0 = C)
    KeyboardChordsMixin._activeChordType = 'Maj'; // last chord type used (for voicing refresh)
    KeyboardChordsMixin._strumTimeouts = [];    // pending timeout handles
    KeyboardChordsMixin._strumActiveFretPositions = null; // positions added to activeFretPositions by last strum
    KeyboardChordsMixin.handAnchorFret = 1;     // leftmost fret of the hand window (min 1, fret 0 = open string)
    KeyboardChordsMixin._handSpanFrets = 4;     // frets covered by the hand (fallback)
    KeyboardChordsMixin._cachedMaxFrets = 22;
    KeyboardChordsMixin._handSpanMm = 0;        // physical hand span in mm (0 = not set)
    KeyboardChordsMixin._scaleLengthMm = 0;     // instrument scale length in mm (0 = not set)
    KeyboardChordsMixin._currentActiveFrets = {}; // string → fret map for active chord (dots)
    KeyboardChordsMixin._mechanism = 'string_sliding_fingers'; // active mechanism
    KeyboardChordsMixin._maxFingers = 4;        // max simultaneous fingers (string_sliding)
    KeyboardChordsMixin._numFingers = 4;        // number of fingers/fret-offsets (fret_sliding)

    // Physical offset: finger rests this many mm before the target fret wire.
    const HAND_FINGER_BEFORE_FRET_MM = 8;

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
        rootLabel.textContent = (typeof this.t === 'function') ? this.t('keyboard.chordRoot') : 'Root';
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
                <span class="strum-sweep-bar" aria-hidden="true"></span>
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
            this._activeChordType = btn.dataset.chordType;
            this._triggerStrum(btn, e.clientX, e.shiftKey);
        });

        // Chord type buttons — touch
        bar.querySelector('.chord-type-row').addEventListener('touchstart', (e) => {
            const btn = e.target.closest('.chord-type-btn');
            if (!btn) return;
            e.preventDefault();
            e.stopPropagation();
            this._activeChordType = btn.dataset.chordType;
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

        // Sweep animation
        const numStrings = (this.stringInstrumentConfig && this.stringInstrumentConfig.num_strings) || 6;
        const totalDur = (numStrings - 1) * delayMs + 350;
        btn.style.setProperty('--strum-dur', totalDur + 'ms');
        btn.classList.remove('strum-sweep-down', 'strum-sweep-up');
        void btn.offsetWidth; // force reflow to restart animation
        btn.classList.add(strumDown ? 'strum-sweep-down' : 'strum-sweep-up');

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

            result.push({ string: s + 1, note, fret: semiDiff, time: 0 });
        }

        return result;
    };

    // ── Chord voicing display ────────────────────────────────────────────────

    KeyboardChordsMixin._showChordVoicing = function (stringNotes) {
        const container = document.getElementById('fretboard-container');
        if (!container) return;
        container.querySelectorAll('.fret-dot.chord-voicing, .fret-dot.chord-open')
            .forEach(d => d.classList.remove('chord-voicing', 'chord-open'));
        stringNotes.forEach(item => {
            const dot = container.querySelector(
                `.fret-dot[data-string="${item.string}"][data-fret="${item.fret}"]`
            );
            if (dot) {
                dot.classList.add(item.fret === 0 ? 'chord-open' : 'chord-voicing');
            }
        });
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

        // Clear previous strum positions BEFORE stopping notes so that the
        // updatePianoDisplay() calls inside stopNote() see a clean state.
        const container = document.getElementById('fretboard-container');
        if (this._strumActiveFretPositions && this.activeFretPositions) {
            this._strumActiveFretPositions.forEach(pos => this.activeFretPositions.delete(pos));
            if (this._strumActiveFretPositions.size > 0 && typeof this.updatePianoDisplay === 'function') {
                this.updatePianoDisplay();
            }
        }
        this._strumActiveFretPositions = new Set();

        // Stop notes still ringing from a previous strum
        [...(this.activeNotes || [])].forEach(n => this.stopNote(n));

        // Clear animation classes from any dot that still carries them
        if (container) {
            container.querySelectorAll('.fret-dot.chord-strum-active')
                .forEach(d => d.classList.remove('chord-strum-active'));
        }

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

        let stringNotes = this._mapChordToStrings(rootClass, intervals, tuning, maxPoly);

        // ── Hand position: auto-move if chord is outside the window, then filter ──
        const handsConfig = cfg.hands_config;
        if (handsConfig && handsConfig.enabled === true) {
            // Move hand to cover the chord (only when completely outside the window).
            this._autoPositionHandForChord(stringNotes);

            // Remove notes that can't be reached (includes extended right-side reach).
            stringNotes = stringNotes.filter(item =>
                item.fret === 0 || this._isReachableWithoutHandMove(item.fret)
            );

            // Show active fret dots on the coverage overlay.
            const activeFretsMap = {};
            stringNotes.forEach(item => { if (item.fret > 0) activeFretsMap[item.string] = item.fret; });
            this._currentActiveFrets = activeFretsMap;
            this._updateFingerDotPositions(activeFretsMap);
        }

        // ── Highlight voicing on fretboard ──
        this._showChordVoicing(stringNotes);

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

        // ── Schedule note-ons + per-string strum animations ──
        const notesPlayed = new Set();
        const holdMs = 650; // sustain duration before auto-release

        ordered.forEach((item, idx) => {
            const humanize = Math.round(Math.random() * 4 - 2); // ±2 ms jitter
            const delay    = idx * delayMs + Math.max(0, humanize);
            const posKey   = `${item.string}:${item.fret}`;

            // Visual FIRST (registered before audio so it fires first on equal delays).
            // This guarantees .active + string vibe are set before playNote() calls
            // updatePianoDisplay() for the same string.
            const tv = setTimeout(() => {
                if (!container) return;
                const dot = container.querySelector(
                    `.fret-dot[data-string="${item.string}"][data-fret="${item.fret}"]`
                );
                // Guard: if no dot exists for this string:fret there is nothing to show.
                if (!dot) return;

                // Restart the strum-hit CSS animation (handles rapid re-strum).
                dot.classList.remove('chord-strum-active');
                void dot.offsetWidth;
                dot.classList.add('chord-strum-active');

                // Register in activeFretPositions (keeps .active alive across
                // subsequent updatePianoDisplay() calls from playNote/stopNote).
                this._strumActiveFretPositions.add(posKey);
                this.activeFretPositions.add(posKey);

                // Set .active directly — do not wait for the next updatePianoDisplay()
                // cycle, which would otherwise run AFTER playNote() below and could
                // find the position missing at the moment it reads activeFretPositions.
                dot.classList.add('active');

                // Trigger the string-vibe overlay for this row immediately.
                if (typeof this._updateFretboardStringColors === 'function') {
                    this._updateFretboardStringColors();
                }
            }, delay);
            this._strumTimeouts.push(tv);

            // Audio: note-on (registered after visual; fires after visual on same delay).
            const t = setTimeout(() => {
                if (item.note >= 21 && item.note <= 108) {
                    this.playNote(item.note);
                    notesPlayed.add(item.note);
                }
            }, delay);
            this._strumTimeouts.push(t);
        });

        // ── Auto-release audio ──
        const stopDelay = (ordered.length > 0 ? ordered.length - 1 : 0) * delayMs + holdMs;
        const stopT = setTimeout(() => {
            notesPlayed.forEach(n => this.stopNote(n));
        }, stopDelay);
        this._strumTimeouts.push(stopT);

        // ── Clear strum animations + string vibes (1–2 s max after last string hit) ──
        const lastNoteDelay = (ordered.length > 0 ? ordered.length - 1 : 0) * delayMs;
        const visualClearMs = Math.min(lastNoteDelay + 1500, 2000);
        const clearT = setTimeout(() => {
            if (container) {
                // Remove both animation class and the .active we set directly.
                container.querySelectorAll('.fret-dot.chord-strum-active')
                    .forEach(d => d.classList.remove('chord-strum-active', 'active'));
            }
            if (this._strumActiveFretPositions && this.activeFretPositions) {
                this._strumActiveFretPositions.forEach(pos => this.activeFretPositions.delete(pos));
                this._strumActiveFretPositions.clear();
            }
            // Full display refresh hides string vibes for now-inactive rows.
            if (typeof this.updatePianoDisplay === 'function') this.updatePianoDisplay();
            // Reset finger dots to center (inactive) after chord release.
            this._currentActiveFrets = {};
            this._updateFingerDotPositions({});
        }, visualClearMs);
        this._strumTimeouts.push(clearT);
    };

    // ── Hand position widget ─────────────────────────────────────────────────

    /**
     * Equal-tempered fret-to-percentage conversion (matches fretboard grid).
     */
    function fretPct(fret, maxFrets) {
        if (!maxFrets) return fret / 24 * 100;
        const total = 1 - Math.pow(2, -maxFrets / 12);
        return (1 - Math.pow(2, -fret / 12)) / total * 100;
    }

    /**
     * Render the hand position widget above the string rows, plus a coverage
     * overlay on the string rows showing the hand's reachable zone.
     * Called from KeyboardPiano.renderFretboard() before the string loop.
     */
    KeyboardChordsMixin.renderHandWidget = function (stringsArea, opts) {
        const { maxFretCount = 22, isFretless = false } = opts || {};

        const cfg = this.stringInstrumentConfig || {};
        const handsConfig = cfg.hands_config;

        // Show the hand widget only when explicitly enabled in instrument settings.
        if (!handsConfig || handsConfig.enabled !== true) return;

        this._cachedMaxFrets = maxFretCount;

        // Read physical dimensions for mm-based width calculation.
        const hand = (handsConfig.hands && handsConfig.hands[0]) || {};
        const handSpanMm = Number.isFinite(hand.hand_span_mm) ? hand.hand_span_mm : 0;
        const scaleLengthMm = Number.isFinite(cfg.scale_length_mm) ? cfg.scale_length_mm : 0;
        this._handSpanMm = handSpanMm;
        this._scaleLengthMm = scaleLengthMm;

        // Fallback: fret-based span (legacy field).
        if (hand.hand_span_frets > 0) this._handSpanFrets = hand.hand_span_frets;

        // Mechanism awareness: read active mechanism + per-mechanism finger counts.
        const mechanism = (handsConfig.mechanism) || 'string_sliding_fingers';
        this._mechanism = mechanism;
        const numStrings = Math.max(1, cfg.num_strings || 6);
        this._cachedNumStrings = numStrings;
        this._maxFingers = Number.isFinite(hand.max_fingers) && hand.max_fingers > 0
            ? Math.min(hand.max_fingers, numStrings) : numStrings;
        this._numFingers = Number.isFinite(hand.num_fingers) && hand.num_fingers > 0
            ? hand.num_fingers : 4;
        // fret_sliding_fingers: band spans from 8mm before fret A to 8mm before
        // fret A+N-1 (first finger at left edge, last finger at right edge, both
        // at their contact points = 8mm before their fret wire).
        // Width = N-1 fret intervals between the two contact points.
        if (mechanism === 'fret_sliding_fingers') {
            this._handSpanFrets = Math.max(1, this._numFingers - 1);
            this._handSpanMm = 0;
        }

        // ── Drag handle widget (above strings) ───────────────────────────────
        const widget = document.createElement('div');
        widget.className = 'fretboard-hand-widget';
        widget.id = 'fretboard-hand-widget';

        const nutGap = document.createElement('div');
        nutGap.className = 'hand-nut-gap';
        widget.appendChild(nutGap);

        const fretsArea = document.createElement('div');
        fretsArea.className = 'hand-frets-area';
        fretsArea.id = 'hand-frets-area';

        // Fret dividers (light guide lines)
        if (!isFretless) {
            for (let f = 1; f <= maxFretCount; f++) {
                const line = document.createElement('div');
                line.className = 'hand-fret-line';
                line.style.left = fretPct(f, maxFretCount) + '%';
                fretsArea.appendChild(line);
            }
        }

        const band = document.createElement('div');
        band.className = 'hand-band';
        band.id = 'fretboard-hand-band';
        band.title = (typeof this.t === 'function') ? this.t('keyboard.chordHandDrag') : 'Drag to move hand';

        // Palm body — empty block with left/right arrows indicating possible movement.
        const palm = document.createElement('div');
        palm.className = 'hand-palm-indicator';

        const arrowL = document.createElement('button');
        arrowL.type = 'button';
        arrowL.className = 'hand-palm-arrow hand-palm-arrow-left';
        arrowL.id = 'hand-palm-arrow-left';
        arrowL.title = (typeof this.t === 'function') ? this.t('keyboard.handMoveLeft') : 'Déplacer la main vers la gauche';
        arrowL.textContent = '◄';
        palm.appendChild(arrowL);

        const palmBody = document.createElement('div');
        palmBody.className = 'hand-palm-body';
        palm.appendChild(palmBody);

        const arrowR = document.createElement('button');
        arrowR.type = 'button';
        arrowR.className = 'hand-palm-arrow hand-palm-arrow-right';
        arrowR.id = 'hand-palm-arrow-right';
        arrowR.title = (typeof this.t === 'function') ? this.t('keyboard.handMoveRight') : 'Déplacer la main vers la droite';
        arrowR.textContent = '►';
        palm.appendChild(arrowR);

        band.appendChild(palm);

        fretsArea.appendChild(band);
        widget.appendChild(fretsArea);
        stringsArea.appendChild(widget);

        // ── Coverage overlay (on the string rows) ────────────────────────────
        // Single rectangle spanning the full hand width across all strings.
        // Positioned in JavaScript (_updateCoverageOverlayPosition).
        const overlay = document.createElement('div');
        overlay.className = 'hand-coverage-overlay';
        overlay.id = 'hand-coverage-overlay';

        // Range container: holds both the per-mechanism displacement stripes and
        // the per-string finger-position dots (dots painted on top of stripes).
        const rangeRect = document.createElement('div');
        rangeRect.className = 'hand-finger-range-rect';
        rangeRect.id = 'hand-finger-range-rect';

        // Per-mechanism finger displacement range shapes (drawn first, behind dots).
        this._renderFingerRangeRects(rangeRect, numStrings);

        if (mechanism === 'fret_sliding_fingers') {
            // One dot per finger, centred vertically at its stripe's horizontal position.
            // Uses the same anchor-dependent formula as _renderFingerRangeRects.
            const numF   = Math.max(1, this._numFingers);
            const mf0    = this._cachedMaxFrets || 22;
            const anchor0 = this.handAnchorFret || 1;
            const da0    = Math.max(0, anchor0 - 0.25);
            const refW0  = numF > 1 ? fretPct(numF - 1, mf0) : 1;
            for (let i = 0; i < numF; i++) {
                const dot = document.createElement('div');
                dot.className = 'hand-finger-dot-pos';
                dot.dataset.finger = String(i);
                dot.style.top  = '50%';
                const pct = numF === 1 ? 50
                    : refW0 > 0 ? (fretPct(da0 + i, mf0) - fretPct(da0, mf0)) / refW0 * 100
                    : i / (numF - 1) * 100;
                dot.style.left = pct + '%';
                // Extreme fingers: flush to edge so the dot stays fully visible.
                if (i === 0) dot.style.transform = 'translate(0%, -50%)';
                else if (i === numF - 1) dot.style.transform = 'translate(-100%, -50%)';
                rangeRect.appendChild(dot);
            }
        } else {
            // One finger-position dot per string — distributed vertically across the
            // overlay. String 1 (lowest pitch) at the bottom, string N at the top.
            for (let s = 1; s <= numStrings; s++) {
                const dot = document.createElement('div');
                dot.className = 'hand-finger-dot-pos';
                dot.dataset.string = String(s);
                dot.style.top = ((numStrings - s + 0.5) / numStrings * 100) + '%';
                rangeRect.appendChild(dot);
            }
        }

        overlay.appendChild(rangeRect);
        stringsArea.appendChild(overlay);

        // ── Arrow button events ───────────────────────────────────────────────
        arrowL.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const newAnchor = Math.max(1, this.handAnchorFret - 1);
            if (newAnchor !== this.handAnchorFret) {
                this.handAnchorFret = newAnchor;
                this._updateHandWidgetPosition();
                this._sendHandPositionCC(newAnchor);
            }
        });

        arrowR.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const newAnchor = Math.min(this._maxHandAnchorFret(), this.handAnchorFret + 1);
            if (newAnchor !== this.handAnchorFret) {
                this.handAnchorFret = newAnchor;
                this._updateHandWidgetPosition();
                this._sendHandPositionCC(newAnchor);
            }
        });

        this._updateHandWidgetPosition();
        this._attachHandWidgetEvents(band, fretsArea);
    };

    /**
     * Populate `rangeRect` with per-mechanism displacement shapes, drawn below
     * the finger-position dots so they read as "background guides".
     *
     *   string_sliding_fingers — one thin HORIZONTAL stripe per max_fingers
     *     string. Each stripe spans the full overlay width and sits at the same
     *     Y position as its string's finger dot. Shows how far the finger can
     *     slide along the string within the hand span.
     *
     *   fret_sliding_fingers — one thin VERTICAL stripe per num_fingers fret
     *     offset. Each stripe spans the full overlay height and is evenly spaced
     *     across the overlay width. Shows how far the finger can slide across
     *     strings at its fixed fret offset.
     */
    KeyboardChordsMixin._renderFingerRangeRects = function (rangeRect, numStrings) {
        if (!rangeRect) return;
        // Remove any previously created range shapes (not dots — they're separate).
        rangeRect.querySelectorAll('.hand-finger-range-string, .hand-finger-range-fret')
            .forEach(el => el.remove());

        if (this._mechanism === 'string_sliding_fingers') {
            const count = Math.min(Math.max(1, this._maxFingers), numStrings);
            for (let s = 1; s <= count; s++) {
                const stripe = document.createElement('div');
                stripe.className = 'hand-finger-range-string';
                stripe.style.top = ((numStrings - s + 0.5) / numStrings * 100) + '%';
                rangeRect.appendChild(stripe);
            }
        } else if (this._mechanism === 'fret_sliding_fingers') {
            const count    = Math.max(1, this._numFingers);
            const maxFrets = this._cachedMaxFrets || 22;
            const anchor   = this.handAnchorFret || 1;
            const da       = Math.max(0, anchor - 0.25);
            // Band width uses fret-0 reference (constant visual width).
            // Positions are anchor-dependent: fretPct(da+i)-fretPct(da) scales
            // by 2^(-da/12), so fingers cluster toward the left near the bridge
            // where frets are physically closer together.
            const refW = count > 1 ? fretPct(count - 1, maxFrets) : 1;
            const stripeWPct = Math.max(4, Math.min(15, Math.round(100 / count * 0.4)));
            for (let i = 0; i < count; i++) {
                const stripe = document.createElement('div');
                stripe.className = 'hand-finger-range-fret';
                const pct = count === 1 ? 50
                    : refW > 0 ? (fretPct(da + i, maxFrets) - fretPct(da, maxFrets)) / refW * 100
                    : i / (count - 1) * 100;
                stripe.style.left  = pct + '%';
                stripe.style.width = stripeWPct + '%';
                // Extreme fingers: flush to the overlay edge so the full stripe
                // stays visible instead of being half-clipped by overflow:hidden.
                if (i === 0) stripe.style.transform = 'translateX(0%)';
                else if (i === count - 1) stripe.style.transform = 'translateX(-100%)';
                rangeRect.appendChild(stripe);
            }
        }
    };

    /**
     * Reposition the .hand-band and update the coverage overlay.
     *
     * The DISPLAY position is shifted ~8mm before the anchor fret so the band
     * reads as a finger resting just behind the fret wire — matching the
     * physical convention and the FretboardHandPreview editor.
     * The logical `handAnchorFret` is unchanged (used for CC and chord logic).
     *
     * When hand_span_mm / scale_length_mm are set the width is a fixed physical
     * fraction of the fretboard; otherwise falls back to the fret-count approach.
     */
    KeyboardChordsMixin._updateHandWidgetPosition = function () {
        const band = document.getElementById('fretboard-hand-band');
        if (!band) return;
        const maxFrets = this._cachedMaxFrets || 22;
        const anchor   = this.handAnchorFret;

        let leftPct, widthPct;

        if (this._handSpanMm > 0 && this._scaleLengthMm > 0) {
            const L               = this._scaleLengthMm;
            const totalDistMm     = L * (1 - Math.pow(2, -maxFrets / 12));
            const anchorMm        = L * (1 - Math.pow(2, -anchor / 12));
            // Shift left edge by HAND_FINGER_BEFORE_FRET_MM toward the nut
            const displayLeftMm   = Math.max(0, anchorMm - HAND_FINGER_BEFORE_FRET_MM);
            leftPct   = (displayLeftMm / totalDistMm) * 100;
            widthPct  = (this._handSpanMm / totalDistMm) * 100;
            band.style.left  = leftPct + '%';
            band.style.width = Math.min(widthPct, 100 - leftPct) + '%';
        } else {
            // Fret-based fallback.
            // Left edge shifted ~¼ fret (≈8mm) toward the nut so the first
            // finger lands just before the anchor fret wire.
            // Width uses the fret-0 reference (fretPct(span) from fret 0) so it
            // stays constant as the hand moves — fretPct differences shrink toward
            // the bridge due to equal-tempered logarithmic spacing.
            const displayAnchor = Math.max(0, anchor - 0.25);
            leftPct  = fretPct(displayAnchor, maxFrets);
            widthPct = fretPct(this._handSpanFrets, maxFrets);
            band.style.left  = leftPct + '%';
            band.style.width = Math.min(widthPct, 100 - leftPct) + '%';
        }

        // Update arrow enabled/disabled state.
        const arrowL = document.getElementById('hand-palm-arrow-left');
        const arrowR = document.getElementById('hand-palm-arrow-right');
        if (arrowL) arrowL.disabled = anchor <= 1;
        if (arrowR) arrowR.disabled = anchor >= this._maxHandAnchorFret();

        // Update the coverage overlay — requires rendered widths, so use rAF
        // for the initial call (DOM not yet laid out) and direct call for drags.
        this._updateCoverageOverlayPosition();
        if (typeof requestAnimationFrame !== 'undefined') {
            requestAnimationFrame(() => this._updateCoverageOverlayPosition());
        }

        // Re-render fret_sliding_fingers stripes/dots with the new anchor so
        // finger spacing adapts to the logarithmic fret spacing at this position.
        this._refreshFretSlidingLayout();
    };

    /**
     * Sync the coverage overlay's position with the hand band.
     *
     * left / width are derived from the band's % position within hand-frets-area.
     * top  / bottom are measured from the DOM so they adapt to justify-content:center
     * offsets in fretboard-strings-area (the actual start of string rows varies with
     * the number of strings and the modal height).
     *
     * Safe to call before the DOM is laid out (returns early when width is 0).
     */
    KeyboardChordsMixin._updateCoverageOverlayPosition = function () {
        const overlay   = document.getElementById('hand-coverage-overlay');
        const band      = document.getElementById('fretboard-hand-band');
        const fretsArea = document.getElementById('hand-frets-area');
        const widget    = document.getElementById('fretboard-hand-widget');
        if (!overlay || !band || !fretsArea || !widget) return;

        const faWidth = fretsArea.clientWidth;
        if (faWidth <= 0) return; // not laid out yet

        // ── Horizontal: left / width ──────────────────────────────────────────
        const leftPct  = parseFloat(band.style.left)  || 0;
        const widthPct = parseFloat(band.style.width) || 0;

        // The frets-area starts at 48 px (nut gap) within the strings-area.
        const NUT_GAP_PX = 48;
        overlay.style.left  = (NUT_GAP_PX + (leftPct  / 100) * faWidth) + 'px';
        overlay.style.width = ((widthPct / 100) * faWidth) + 'px';

        // ── Vertical: top / bottom ────────────────────────────────────────────
        // fretboard-strings-area uses justify-content:center, so the hand widget
        // may not start at y=0.  Measure actual positions via getBoundingClientRect.
        const stringsArea = fretsArea.closest('.fretboard-strings-area');
        if (stringsArea) {
            const saRect = stringsArea.getBoundingClientRect();
            const wRect  = widget.getBoundingClientRect();
            if (saRect.height > 0 && wRect.height > 0) {
                // top of overlay = bottom of the hand widget, relative to stringsArea
                overlay.style.top = (wRect.bottom - saRect.top) + 'px';

                // bottom of overlay = top of the fret-header row, or fallback
                const header = stringsArea.querySelector('.fret-header');
                if (header) {
                    const hRect = header.getBoundingClientRect();
                    overlay.style.bottom = Math.max(0, saRect.bottom - hRect.top) + 'px';
                } else {
                    overlay.style.bottom = '22px';
                }
            }
        }
        this._updateFingerDotPositions(this._currentActiveFrets || {});
    };

    /**
     * Returns the center position of the hand span as a % of the overlay width.
     * Fingers default here when no chord is active.
     */
    KeyboardChordsMixin._fingerCenterPct = function () {
        return this._fretToOverlayPct(this.handAnchorFret || 0);
    };

    /**
     * Converts a fret number to a % position within the coverage overlay width.
     * Used to place finger dots at the correct horizontal position.
     */
    KeyboardChordsMixin._fretToOverlayPct = function (fret) {
        const anchor = this.handAnchorFret || 0;
        if (this._handSpanMm > 0 && this._scaleLengthMm > 0) {
            const L = this._scaleLengthMm;
            const anchorMm = L * (1 - Math.pow(2, -anchor / 12));
            const displayLeftMm = Math.max(0, anchorMm - HAND_FINGER_BEFORE_FRET_MM);
            const fretMm = L * (1 - Math.pow(2, -fret / 12));
            return Math.max(0, Math.min(100, (fretMm - displayLeftMm) / this._handSpanMm * 100));
        }
        const maxFrets = this._cachedMaxFrets || 22;
        const displayAnchor = Math.max(0, anchor - 0.25);
        // Constant overlay width: fret-0 reference matches the fixed band width.
        const overlayWidthPct = fretPct(this._handSpanFrets, maxFrets);
        if (overlayWidthPct <= 0) return 50;
        return Math.max(0, Math.min(100, (fretPct(fret, maxFrets) - fretPct(displayAnchor, maxFrets)) / overlayWidthPct * 100));
    };

    /**
     * Returns true if `fret` can be played without moving the hand.
     * Includes direct reach (fret within anchor..anchor+span) and an extended
     * right-side rule: if the right edge of the hand band reaches past the
     * midpoint of the fret cell, the finger can stretch to press it.
     */
    KeyboardChordsMixin._isReachableWithoutHandMove = function (fret) {
        if (fret === 0) return true;
        const anchor = this.handAnchorFret || 0;
        const span = this._handEffectiveSpanFrets();

        if (fret >= anchor && fret <= anchor + span) return true;

        // Extended right-side reach: hand right edge reaches midpoint of the fret cell.
        if (this._handSpanMm > 0 && this._scaleLengthMm > 0) {
            const L = this._scaleLengthMm;
            const anchorMm = L * (1 - Math.pow(2, -anchor / 12));
            const handRightMm = anchorMm + this._handSpanMm;
            const prevFretMm = fret > 1 ? L * (1 - Math.pow(2, -(fret - 1) / 12)) : 0;
            const thisFretMm = L * (1 - Math.pow(2, -fret / 12));
            if (handRightMm >= (prevFretMm + thisFretMm) / 2) return true;
        }

        return false;
    };

    /**
     * Update per-string finger dots in the coverage overlay.
     * activeFrets: { [stringNum]: fret } — strings with an active pressed fret.
     *
     * Each dot sits at:
     *   - Horizontal: 8mm before the activated fret wire (_fretToOverlayPct),
     *     or at the center of the span when the string is idle.
     *   - Vertical: fixed at construction time (one row per string).
     */
    KeyboardChordsMixin._updateFingerDotPositions = function (activeFrets) {
        const rangeRect = document.getElementById('hand-finger-range-rect');
        if (!rangeRect) return;

        // fret_sliding_fingers: dots are fixed at their stripe positions; just
        // toggle the active class when any string is being pressed.
        const fingerDots = rangeRect.querySelectorAll('.hand-finger-dot-pos[data-finger]');
        if (fingerDots.length > 0) {
            const hasActive = activeFrets && Object.values(activeFrets).some(f => f != null && f > 0);
            fingerDots.forEach(dot => {
                if (hasActive) dot.classList.add('active');
                else dot.classList.remove('active');
            });
            return;
        }

        const dots = rangeRect.querySelectorAll('.hand-finger-dot-pos[data-string]');
        const centerPct = this._fingerCenterPct();

        dots.forEach(dot => {
            const stringNum = parseInt(dot.dataset.string, 10);
            const fret = activeFrets && activeFrets[stringNum] != null
                ? activeFrets[stringNum] : null;
            if (fret != null && fret > 0) {
                dot.style.left = this._fretToOverlayPct(fret) + '%';
                dot.classList.add('active');
            } else {
                dot.style.left = centerPct + '%';
                dot.classList.remove('active');
            }
        });
    };

    /**
     * Maximum fret the hand anchor can reach so the band stays inside the
     * fretboard. In mm mode this is derived from physical dimensions; otherwise
     * it falls back to the legacy fret-count formula.
     */
    KeyboardChordsMixin._maxHandAnchorFret = function () {
        const maxFrets = this._cachedMaxFrets || 22;
        if (this._handSpanMm > 0 && this._scaleLengthMm > 0) {
            // Physical end of fretboard in mm, then subtract hand span.
            const fretboardMm = this._scaleLengthMm * (1 - Math.pow(2, -maxFrets / 12));
            const maxStartMm  = fretboardMm - this._handSpanMm;
            if (maxStartMm <= 0) return 0;
            return -12 * Math.log2(1 - maxStartMm / this._scaleLengthMm);
        }
        return maxFrets - this._handSpanFrets;
    };

    /**
     * Effective span of the hand in frets at the current anchor position.
     * Used for chord filtering and playability checks.
     */
    KeyboardChordsMixin._handEffectiveSpanFrets = function () {
        const anchor = this.handAnchorFret || 0;
        if (this._handSpanMm > 0 && this._scaleLengthMm > 0) {
            const L       = this._scaleLengthMm;
            const anchorMm = L * (1 - Math.pow(2, -anchor / 12));
            const endMm    = anchorMm + this._handSpanMm;
            if (endMm < L) return -12 * Math.log2(1 - endMm / L) - anchor;
            return (this._cachedMaxFrets || 22) - anchor;
        }
        return this._handSpanFrets || 4;
    };

    /**
     * Move the hand so it covers the given chord string-notes if they are fully
     * outside the current window.  Only fires when hands_config is enabled.
     * Does NOT move if the chord is already partially covered (let the player
     * decide in ambiguous cases).
     */
    KeyboardChordsMixin._autoPositionHandForChord = function (stringNotes) {
        const handsConfig = (this.stringInstrumentConfig || {}).hands_config;
        if (!handsConfig || handsConfig.enabled !== true) return;

        const fretted = stringNotes.filter(n => n.fret > 0);
        if (fretted.length === 0) return; // all open strings

        const minFret = Math.min(...fretted.map(n => n.fret));
        const anchor  = this.handAnchorFret || 0;

        // Already covered (with extended reach) — don't disturb the player's position.
        if (fretted.every(n => this._isReachableWithoutHandMove(n.fret))) return;

        // Place the index finger one fret before the lowest needed fret (min fret 1).
        const newAnchor = Math.max(1, Math.min(this._maxHandAnchorFret(), minFret - 1));
        this.handAnchorFret = newAnchor;
        this._updateHandWidgetPosition();
        this._sendHandPositionCC(newAnchor);
    };

    /**
     * Wire up drag events on the hand band.
     */
    KeyboardChordsMixin._attachHandWidgetEvents = function (band, fretsArea) {
        if (!band || !fretsArea) return;

        band.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const startX      = e.clientX;
            const startAnchor = this.handAnchorFret;
            const maxFrets    = this._cachedMaxFrets || 22;

            const onMove = (mv) => {
                const dx        = mv.clientX - startX;
                const areaW     = fretsArea.clientWidth || 1;
                const fretDelta = Math.round(dx / (areaW / maxFrets));
                const newAnchor = Math.max(1, Math.min(
                    this._maxHandAnchorFret(),
                    startAnchor + fretDelta
                ));
                if (newAnchor !== this.handAnchorFret) {
                    this.handAnchorFret = newAnchor;
                    this._updateHandWidgetPosition();
                    this._sendHandPositionCC(newAnchor);
                }
            };

            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        // Touch support
        band.addEventListener('touchstart', (e) => {
            e.preventDefault();
            const startX      = e.touches[0].clientX;
            const startAnchor = this.handAnchorFret;
            const maxFrets    = this._cachedMaxFrets || 22;

            const onMove = (mv) => {
                const dx        = mv.touches[0].clientX - startX;
                const areaW     = fretsArea.clientWidth || 1;
                const fretDelta = Math.round(dx / (areaW / maxFrets));
                const newAnchor = Math.max(1, Math.min(
                    this._maxHandAnchorFret(),
                    startAnchor + fretDelta
                ));
                if (newAnchor !== this.handAnchorFret) {
                    this.handAnchorFret = newAnchor;
                    this._updateHandWidgetPosition();
                    this._sendHandPositionCC(newAnchor);
                }
            };

            const onEnd = () => {
                band.removeEventListener('touchmove', onMove);
                band.removeEventListener('touchend', onEnd);
            };

            band.addEventListener('touchmove', onMove, { passive: false });
            band.addEventListener('touchend', onEnd);
        }, { passive: false });
    };

    /**
     * Re-render fret_sliding_fingers stripes and dots with the current anchor.
     * Called after every hand move so positions adapt to the logarithmic fret
     * spacing at the new hand location (fingers cluster toward the bridge).
     */
    KeyboardChordsMixin._refreshFretSlidingLayout = function () {
        if (this._mechanism !== 'fret_sliding_fingers') return;
        const rangeRect = document.getElementById('hand-finger-range-rect');
        if (!rangeRect) return;

        // Re-render stripes (removes old ones internally).
        this._renderFingerRangeRects(rangeRect, this._cachedNumStrings || 6);

        // Update existing dot positions to match.
        const numF    = Math.max(1, this._numFingers);
        const maxFrets = this._cachedMaxFrets || 22;
        const anchor  = this.handAnchorFret || 1;
        const da      = Math.max(0, anchor - 0.25);
        const refW    = numF > 1 ? fretPct(numF - 1, maxFrets) : 1;
        rangeRect.querySelectorAll('.hand-finger-dot-pos[data-finger]').forEach(dot => {
            const i = parseInt(dot.dataset.finger, 10);
            if (!Number.isFinite(i)) return;
            const pct = numF === 1 ? 50
                : refW > 0 ? (fretPct(da + i, maxFrets) - fretPct(da, maxFrets)) / refW * 100
                : i / (numF - 1) * 100;
            dot.style.left = pct + '%';
            if (i === 0) dot.style.transform = 'translate(0%, -50%)';
            else if (i === numF - 1) dot.style.transform = 'translate(-100%, -50%)';
            else dot.style.removeProperty('transform');
        });
    };

    /**
     * Send CC for the hand anchor fret position.
     */
    KeyboardChordsMixin._sendHandPositionCC = function (anchorFret) {
        if (!this.selectedDevice || !this.backend) return;
        const cfg = this.stringInstrumentConfig || {};
        if (cfg.cc_enabled === false) return;

        const ccFretNumber = cfg.cc_fret_number !== undefined ? cfg.cc_fret_number : 21;
        const ccFretOffset = cfg.cc_fret_offset || 0;
        const ccFretMin    = cfg.cc_fret_min    !== undefined ? cfg.cc_fret_min    : 0;
        const ccFretMax    = cfg.cc_fret_max    !== undefined ? cfg.cc_fret_max    : 36;

        const val = Math.max(0, Math.min(127, Math.max(ccFretMin, Math.min(ccFretMax, anchorFret + ccFretOffset))));
        const deviceId = this.selectedDevice.device_id || this.selectedDevice.id;

        if (this.selectedDevice.isVirtual) {
            this.logger && this.logger.info && this.logger.info(`[Hand] CC${ccFretNumber}=${val} (anchor fret ${anchorFret})`);
            return;
        }

        const channel = this.getSelectedChannel();
        this.backend.sendCommand('midi_send_cc', {
            deviceId, channel, controller: ccFretNumber, value: val
        }).catch(err => this.logger && this.logger.error('[HandWidget] CC send failed:', err));
    };

    // ── Auto-move hand on out-of-range fret click ─────────────────────────────

    /**
     * If `fret` is outside the current hand window, move the hand by the
     * minimum number of frets needed to make it reachable — never more.
     *
     * - Fret to the LEFT  → anchor slides left so fret lands at the leftmost
     *   reachable position (anchor = fret).
     * - Fret to the RIGHT → anchor slides right so fret lands at the rightmost
     *   reachable position (anchor = fret − floor(span)).
     *
     * Moving by just 1 fret is naturally the result when that 1-fret shift is
     * sufficient (no special-casing needed).
     */
    KeyboardChordsMixin._maybeAutoMoveHand = function (fret) {
        if (fret <= 0) return;
        if (this._isReachableWithoutHandMove(fret)) return;

        const anchor = this.handAnchorFret || 0;
        const span   = this._handEffectiveSpanFrets();
        let newAnchor;

        if (fret < anchor) {
            // Move left: place fret at the left edge of the window.
            newAnchor = fret;
        } else {
            // Move right: place fret at the right edge of the window.
            newAnchor = Math.max(1, fret - Math.floor(span));
        }

        newAnchor = Math.max(1, Math.min(this._maxHandAnchorFret(), newAnchor));
        this.handAnchorFret = newAnchor;
        this._updateHandWidgetPosition();
        this._sendHandPositionCC(newAnchor);
    };

    if (typeof window !== 'undefined') window.KeyboardChordsMixin = KeyboardChordsMixin;
})();
