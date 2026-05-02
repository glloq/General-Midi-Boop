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
    KeyboardChordsMixin.handAnchorFret = 0;     // leftmost fret of the hand window
    KeyboardChordsMixin._handSpanFrets = 4;     // frets covered by the hand (fallback)
    KeyboardChordsMixin._cachedMaxFrets = 22;
    KeyboardChordsMixin._handSpanMm = 0;        // physical hand span in mm (0 = not set)
    KeyboardChordsMixin._scaleLengthMm = 0;     // instrument scale length in mm (0 = not set)

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

        // Stop notes still ringing from a previous strum
        [...(this.activeNotes || [])].forEach(n => this.stopNote(n));

        // Clear any previous per-string strum animations + fret positions
        const container = document.getElementById('fretboard-container');
        if (container) {
            container.querySelectorAll('.fret-dot.chord-strum-active')
                .forEach(d => d.classList.remove('chord-strum-active'));
        }
        if (this._strumActiveFretPositions && this.activeFretPositions) {
            this._strumActiveFretPositions.forEach(pos => this.activeFretPositions.delete(pos));
            if (this._strumActiveFretPositions.size > 0 && typeof this.updatePianoDisplay === 'function') {
                this.updatePianoDisplay();
            }
        }
        this._strumActiveFretPositions = new Set();

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

            // Remove notes whose frets can't be reached with the current hand window.
            const anchor = this.handAnchorFret || 0;
            const span   = this._handEffectiveSpanFrets();
            stringNotes = stringNotes.filter(item =>
                item.fret === 0 ||                         // open string: always playable
                (item.fret >= anchor && item.fret <= anchor + span)
            );
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

            // Audio: note-on
            const t = setTimeout(() => {
                if (item.note >= 21 && item.note <= 108) {
                    this.playNote(item.note);
                    notesPlayed.add(item.note);
                }
            }, delay);
            this._strumTimeouts.push(t);

            // Visual: light up fret-dot + activate string vibe in strum order
            const posKey = `${item.string}:${item.fret}`;
            const tv = setTimeout(() => {
                if (!container) return;
                const dot = container.querySelector(
                    `.fret-dot[data-string="${item.string}"][data-fret="${item.fret}"]`
                );
                if (dot) {
                    dot.classList.remove('chord-strum-active');
                    void dot.offsetWidth; // restart animation on rapid re-strum
                    dot.classList.add('chord-strum-active');
                }
                // Register in activeFretPositions so updatePianoDisplay activates .active
                // on the dot and _updateFretboardStringColors shows the string vibe.
                if (this.activeFretPositions) {
                    this._strumActiveFretPositions.add(posKey);
                    this.activeFretPositions.add(posKey);
                    if (typeof this.updatePianoDisplay === 'function') this.updatePianoDisplay();
                }
            }, delay);
            this._strumTimeouts.push(tv);
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
                container.querySelectorAll('.fret-dot.chord-strum-active')
                    .forEach(d => d.classList.remove('chord-strum-active'));
            }
            if (this._strumActiveFretPositions && this.activeFretPositions) {
                this._strumActiveFretPositions.forEach(pos => this.activeFretPositions.delete(pos));
                this._strumActiveFretPositions.clear();
                if (typeof this.updatePianoDisplay === 'function') this.updatePianoDisplay();
            }
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

        const numStrings = Math.max(1, cfg.num_strings || 6);

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

        // Palm body (upper part of the band) — contains string-lines so the hand
        // looks like it's gripping the neck across all strings.
        const palm = document.createElement('div');
        palm.className = 'hand-palm-indicator';
        // One string line per string, evenly distributed vertically in the palm.
        for (let i = 0; i < numStrings; i++) {
            const sl = document.createElement('div');
            sl.className = 'hand-palm-string-line';
            sl.style.top = `${(i + 0.5) / numStrings * 100}%`;
            palm.appendChild(sl);
        }
        band.appendChild(palm);

        // Finger stubs at the bottom of the band — one per string, pointing down
        // so they visually connect to the string rows below.
        const fingersRow = document.createElement('div');
        fingersRow.className = 'hand-fingers-row';
        fingersRow.id = 'hand-fingers-row';
        for (let i = 0; i < numStrings; i++) {
            const stub = document.createElement('div');
            stub.className = 'hand-finger-stub';
            fingersRow.appendChild(stub);
        }
        band.appendChild(fingersRow);

        fretsArea.appendChild(band);
        widget.appendChild(fretsArea);
        stringsArea.appendChild(widget);

        // ── Coverage overlay (on the string rows) ────────────────────────────
        // Semi-transparent rectangle that shows the hand's reachable zone on the
        // actual strings.  Positioned in JavaScript (see _updateCoverageOverlayPosition)
        // because pixel coordinates depend on the rendered DOM width.
        const overlay = document.createElement('div');
        overlay.className = 'hand-coverage-overlay';
        overlay.id = 'hand-coverage-overlay';

        // One segment per string — contains a finger track (horizontal range line)
        // and a finger-position dot showing where the finger currently rests.
        for (let i = 0; i < numStrings; i++) {
            const seg = document.createElement('div');
            seg.className = 'hand-coverage-string-seg';

            // Full-width track: shows the complete range of movement for this finger.
            const track = document.createElement('div');
            track.className = 'hand-finger-track';
            seg.appendChild(track);

            // Dot at the leftmost position (= anchor fret / home position).
            const dot = document.createElement('div');
            dot.className = 'hand-finger-dot-pos';
            seg.appendChild(dot);

            overlay.appendChild(seg);
        }
        stringsArea.appendChild(overlay);

        this._updateHandWidgetPosition();
        this._attachHandWidgetEvents(band, fretsArea);
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
            // Fret-based fallback: shift ~¼ fret visually toward the nut.
            const displayAnchor = Math.max(0, anchor - 0.25);
            leftPct  = fretPct(displayAnchor, maxFrets);
            const rightPct = fretPct(anchor + this._handSpanFrets, maxFrets);
            widthPct = rightPct - leftPct;
            band.style.left  = leftPct + '%';
            band.style.width = widthPct + '%';
        }

        // Update the coverage overlay — requires rendered widths, so use rAF
        // for the initial call (DOM not yet laid out) and direct call for drags.
        this._updateCoverageOverlayPosition();
        if (typeof requestAnimationFrame !== 'undefined') {
            requestAnimationFrame(() => this._updateCoverageOverlayPosition());
        }
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
        const maxFret = Math.max(...fretted.map(n => n.fret));
        const anchor  = this.handAnchorFret || 0;
        const span    = this._handEffectiveSpanFrets();

        // Already covered — don't disturb the player's manual position.
        if (minFret >= anchor && maxFret <= anchor + span) return;

        // Place the index finger one fret before the lowest needed fret.
        const newAnchor = Math.max(0, Math.min(this._maxHandAnchorFret(), minFret - 1));
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
                const newAnchor = Math.max(0, Math.min(
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
                const newAnchor = Math.max(0, Math.min(
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
     * If `fret` is outside the current hand window, recentre the hand and send CC.
     */
    KeyboardChordsMixin._maybeAutoMoveHand = function (fret) {
        if (fret <= 0) return;
        const anchor = this.handAnchorFret || 0;

        // Effective span in frets at the current anchor position.
        let span;
        if (this._handSpanMm > 0 && this._scaleLengthMm > 0) {
            const anchorMm = this._scaleLengthMm * (1 - Math.pow(2, -anchor / 12));
            const endMm    = anchorMm + this._handSpanMm;
            if (endMm < this._scaleLengthMm) {
                span = -12 * Math.log2(1 - endMm / this._scaleLengthMm) - anchor;
            } else {
                span = (this._cachedMaxFrets || 22) - anchor;
            }
        } else {
            span = this._handSpanFrets || 4;
        }

        if (fret >= anchor && fret <= anchor + span - 1) return; // already in range
        const newAnchor = Math.max(0, Math.min(
            this._maxHandAnchorFret(),
            fret - Math.floor(span / 2)
        ));
        this.handAnchorFret = newAnchor;
        this._updateHandWidgetPosition();
        this._sendHandPositionCC(newAnchor);
    };

    if (typeof window !== 'undefined') window.KeyboardChordsMixin = KeyboardChordsMixin;
})();
