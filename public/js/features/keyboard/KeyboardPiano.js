// Auto-extracted from KeyboardModal.js
(function() {
    'use strict';
    const KeyboardPianoMixin = {};

    // 12 chromatic note colors (C to B) — roue chromatique complète.
    const FRET_NOTE_COLORS = [
        { bg: '#EF4444', text: '#fff' }, // C  - Rouge
        { bg: '#F4622A', text: '#fff' }, // C# - Rouge-orangé
        { bg: '#F97316', text: '#fff' }, // D  - Orange
        { bg: '#FBBF24', text: '#1a1a1a' }, // D# - Jaune-orangé
        { bg: '#EAB308', text: '#1a1a1a' }, // E  - Jaune
        { bg: '#84CC16', text: '#1a1a1a' }, // F  - Jaune-vert
        { bg: '#22C55E', text: '#fff' }, // F# - Vert
        { bg: '#14B8A6', text: '#fff' }, // G  - Vert-cyan
        { bg: '#06B6D4', text: '#fff' }, // G# - Cyan
        { bg: '#3B82F6', text: '#fff' }, // A  - Bleu
        { bg: '#7C3AED', text: '#fff' }, // A# - Bleu-violet
        { bg: '#A855F7', text: '#fff' }, // B  - Violet
    ];


    KeyboardPianoMixin.createModal = function() {
        const endNote = this.startNote + this.visibleNoteCount - 1;
        const display = `${this.getNoteLabel(this.startNote)} - ${this.getNoteLabel(endNote)}`;

        this.container = document.createElement('div');
        this.container.className = 'keyboard-modal';
        this.container.innerHTML = `
            <div class="modal-dialog">
                <div class="modal-header">
                    <div class="keyboard-header-row">
                        <div class="keyboard-header-controls">
                            <div class="control-group">
                                <label>${this.t('keyboard.instrument')}</label>
                                <select class="device-select" id="keyboard-device-select">
                                    <option value="">${this.t('common.select')}</option>
                                </select>
                            </div>

                            <div class="control-group latency-group" id="keyboard-latency-group">
                                <label>${this.t('keyboard.latency') || 'Latency'}</label>
                                <span class="latency-display latency-empty" id="keyboard-latency-display">—</span>
                            </div>

                            <div class="control-group view-mode-group hidden" id="keyboard-view-mode-group">
                                <label>${this.t('keyboard.view') || 'View'}</label>
                                <button class="btn-view-toggle" id="keyboard-view-toggle" title="${this.t('keyboard.toggleView') || 'Toggle view'}">🎹</button>
                            </div>

                            <div class="control-group note-color-group hidden" id="keyboard-note-color-group">
                                <label>${this.t('keyboard.noteColors') || 'Colors'}</label>
                                <button class="btn-note-colors" id="keyboard-note-colors-toggle" title="${this.t('keyboard.toggleNoteColors') || 'Toggle note colors'}">🎨</button>
                            </div>

                            <div class="control-group notation-group">
                                <label>${this.t('keyboard.notation') || 'Notation'}</label>
                                <div class="notation-toggle" id="keyboard-notation-toggle" role="radiogroup">
                                    <button type="button" class="notation-btn ${this.noteLabelFormat === 'english' ? 'active' : ''}" data-notation="english" role="radio" aria-checked="${this.noteLabelFormat === 'english'}">US</button>
                                    <span class="notation-sep">/</span>
                                    <button type="button" class="notation-btn ${this.noteLabelFormat === 'solfege' ? 'active' : ''}" data-notation="solfege" role="radio" aria-checked="${this.noteLabelFormat === 'solfege'}">FR</button>
                                    <span class="notation-sep">/</span>
                                    <button type="button" class="notation-btn ${this.noteLabelFormat === 'midi' ? 'active' : ''}" data-notation="midi" role="radio" aria-checked="${this.noteLabelFormat === 'midi'}">MIDI</button>
                                </div>
                            </div>
                        </div>
                    </div>
                    <button class="modal-close" id="keyboard-close-btn">&times;</button>
                </div>

                <!-- Minimap navigation row -->
                <div class="keyboard-minimap-row" id="keyboard-minimap-row">
                    <div class="minimap-controls">
                        <button class="btn-octave-down" id="keyboard-octave-down" title="${this.t('keyboard.scrollLeft') || 'Scroll left'}">◄</button>
                        <span class="octave-display" id="keyboard-octave-display">${display}</span>
                        <button class="btn-octave-up" id="keyboard-octave-up" title="${this.t('keyboard.scrollRight') || 'Scroll right'}">►</button>
                        <button class="btn-zoom" id="keyboard-zoom-out" title="${this.t('keyboard.zoomOut') || 'Zoom out'}">−</button>
                        <button class="btn-zoom" id="keyboard-zoom-in" title="${this.t('keyboard.zoomIn') || 'Zoom in'}">+</button>
                    </div>
                    <div class="minimap-wrapper" id="keyboard-minimap-wrapper" title="${this.t('keyboard.minimapHint') || 'Click or drag to navigate'}">
                        <div class="minimap-track" id="keyboard-minimap-track">
                            <div class="minimap-viewport" id="keyboard-minimap-viewport"></div>
                        </div>
                    </div>
                </div>

                <div class="modal-body">
                    <div class="keyboard-layout">
                        <!-- Vertical velocity slider on the left -->
                        <div class="velocity-control-vertical no-transition" id="velocity-control-panel">
                            <div class="velocity-label-vertical">${this.t('keyboard.velocity')}</div>
                            <div class="velocity-slider-wrapper">
                                <input type="range"
                                       id="keyboard-velocity"
                                       class="velocity-slider-vertical"
                                       min="1"
                                       max="127"
                                       value="80"
                                       orient="vertical">
                            </div>
                            <div class="velocity-value-vertical" id="keyboard-velocity-display">80</div>
                        </div>

                        <!-- Mod wheel custom (hidden by default, shown if instrument supports CC#1) -->
                        <div class="velocity-control-vertical modulation-control-vertical slider-hidden no-transition" id="modulation-control-panel">
                            <div class="velocity-label-vertical">${this.t('keyboard.modulation')}</div>
                            <div class="mod-wheel-wrapper">
                                <div class="mod-wheel-track" id="mod-wheel-track">
                                    <div class="mod-wheel-center-line"></div>
                                    <div class="mod-wheel-fill" id="mod-wheel-fill"></div>
                                    <div class="mod-wheel-thumb" id="mod-wheel-thumb"></div>
                                </div>
                            </div>
                            <div class="velocity-value-vertical modulation-value-vertical" id="keyboard-modulation-display">64</div>
                        </div>

                        <!-- Main keyboard area -->
                        <div class="keyboard-main">
                            <div class="keyboard-canvas-container" id="keyboard-canvas-container">
                                <div id="piano-container" class="piano-container"></div>
                                <div id="fretboard-container" class="fretboard-container hidden"></div>
                                <div id="drumpad-container" class="drumpad-container hidden"></div>
                            </div>
                            <div class="octave-bar" id="keyboard-octave-bar"></div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(this.container);

        // Generate the piano keys + minimap + octave bar
        this.generatePianoKeys();
        this.renderMinimap();
        this.renderOctaveBar();
        this.updateLatencyDisplay();
    }

    // ========================================================================
    // PIANO KEYS GENERATION (DIVs)
    // ========================================================================

    KeyboardPianoMixin.generatePianoKeys = function() {
        const pianoContainer = document.getElementById('piano-container');
        if (!pianoContainer) return;

        pianoContainer.innerHTML = ''; // Clear

        const totalNotes = this.visibleNoteCount;
        const endNote = this.startNote + totalNotes;

        // Collect the white and black keys
        this.visibleWhiteNotes = [];
        this.visibleBlackNotes = [];

        for (let midi = this.startNote; midi < endNote; midi++) {
            const semitone = midi % 12;
            if (!this.blackNoteSemitones.has(semitone)) {
                this.visibleWhiteNotes.push(midi);
            } else {
                this.visibleBlackNotes.push(midi);
            }
        }

        const totalWhiteKeys = this.visibleWhiteNotes.length;

        // Generate the white keys
        for (let i = 0; i < totalWhiteKeys; i++) {
            const noteNumber = this.visibleWhiteNotes[i];
            const labelText = this.getNoteLabel(noteNumber);

            const whiteKey = document.createElement('div');
            whiteKey.className = 'piano-key white-key';
            whiteKey.dataset.note = noteNumber;
            whiteKey.dataset.noteName = labelText;

            if (!this.isNotePlayable(noteNumber)) {
                whiteKey.classList.add('disabled');
            }

            // Colored dot (pastille) — always in the DOM, visible only when showNoteColors.
            const colorDot = document.createElement('div');
            colorDot.className = 'note-color-dot';
            if (this.showNoteColors) {
                colorDot.style.background = FRET_NOTE_COLORS[noteNumber % 12].bg;
                colorDot.style.display = 'block';
            }
            whiteKey.appendChild(colorDot);

            const label = document.createElement('span');
            label.className = 'key-label';
            label.textContent = labelText;
            whiteKey.appendChild(label);

            pianoContainer.appendChild(whiteKey);
        }

        // Generate the black keys positioned over the white keys
        for (const blackNote of this.visibleBlackNotes) {
            // Find the white key just before this black one
            const whiteBelow = blackNote - 1; // the white key below
            const whiteIndex = this.visibleWhiteNotes.indexOf(whiteBelow);
            if (whiteIndex < 0) continue; // edge of the keyboard

            const blackKey = document.createElement('div');
            blackKey.className = 'piano-key black-key';
            blackKey.dataset.note = blackNote;
            blackKey.dataset.noteName = this.getNoteLabel(blackNote);

            if (!this.isNotePlayable(blackNote)) {
                blackKey.classList.add('disabled');
            }

            // Colored dot (pastille) for black keys.
            const colorDotB = document.createElement('div');
            colorDotB.className = 'note-color-dot';
            if (this.showNoteColors) {
                colorDotB.style.background = FRET_NOTE_COLORS[blackNote % 12].bg;
                colorDotB.style.display = 'block';
            }
            blackKey.appendChild(colorDotB);

            // Width and position scaled relative to the number of white keys
            // so black keys stay narrower than white keys regardless of octave count.
            const whiteKeyPercent = 100 / totalWhiteKeys;
            blackKey.style.width = `${whiteKeyPercent * 0.6}%`;
            blackKey.style.left = `${whiteKeyPercent * (whiteIndex + 0.7)}%`;

            pianoContainer.appendChild(blackKey);
        }
    }

    /**
     * Render the minimap (full MIDI range with viewport indicator).
     */
    KeyboardPianoMixin.renderMinimap = function() {
        const track = document.getElementById('keyboard-minimap-track');
        const viewport = document.getElementById('keyboard-minimap-viewport');
        if (!track || !viewport) return;

        // Show all 128 MIDI notes (0-127) so the minimap covers the full range.
        const minMidi = 0;
        const maxMidi = 127;
        const blackSemis = this.blackNoteSemitones;

        // Build the piano background once (white + black keys).
        if (!track.querySelector('.minimap-bg')) {
            const bg = document.createElement('div');
            bg.className = 'minimap-bg';

            // White keys laid out as a flex row.
            const whiteRow = document.createElement('div');
            whiteRow.className = 'minimap-whites';
            const whiteNotes = [];
            for (let n = minMidi; n <= maxMidi; n++) {
                if (!blackSemis.has(n % 12)) whiteNotes.push(n);
            }
            for (const n of whiteNotes) {
                const wk = document.createElement('div');
                wk.className = 'minimap-wkey';
                wk.dataset.note = n;
                if (n % 12 === 0) wk.classList.add('octave-c'); // bolder line at every C
                whiteRow.appendChild(wk);
            }
            bg.appendChild(whiteRow);

            // Black keys absolutely positioned over the white-key row.
            const totalWhites = whiteNotes.length;
            const wPct = 100 / totalWhites;
            for (let n = minMidi; n <= maxMidi; n++) {
                if (!blackSemis.has(n % 12)) continue;
                const whiteBelow = whiteNotes.indexOf(n - 1);
                if (whiteBelow < 0) continue;
                const bk = document.createElement('div');
                bk.className = 'minimap-bkey';
                bk.dataset.note = n;
                bk.style.width = `${wPct * 0.6}%`;
                bk.style.left = `${wPct * (whiteBelow + 0.7)}%`;
                bg.appendChild(bk);
            }

            // Insert bg before the viewport so the viewport overlays it.
            track.insertBefore(bg, viewport);
        }

        // Refresh the playable/disabled state of every minimap key based on
        // the current instrument's capabilities.
        const keys = track.querySelectorAll('.minimap-wkey, .minimap-bkey');
        keys.forEach(k => {
            const midi = parseInt(k.dataset.note, 10);
            const playable = this.isNotePlayable(midi);
            k.classList.toggle('disabled', !playable);
        });

        // Update viewport position/width using semitone-based units so it lines
        // up tightly with the visible keyboard range.
        const totalRange = maxMidi - minMidi + 1;
        const start = Math.max(minMidi, this.startNote);
        const end = Math.min(maxMidi + 1, this.startNote + this.visibleNoteCount);
        const leftPct = ((start - minMidi) / totalRange) * 100;
        const widthPct = ((end - start) / totalRange) * 100;
        viewport.style.left = `${Math.max(0, leftPct)}%`;
        viewport.style.width = `${Math.max(1.5, widthPct)}%`;
    }

    /**
     * Render the octave indicator bar below the keyboard.
     */
    KeyboardPianoMixin.renderOctaveBar = function() {
        const bar = document.getElementById('keyboard-octave-bar');
        if (!bar) return;
        bar.innerHTML = '';

        const totalNotes = this.visibleNoteCount;
        const totalWhiteKeys = this.visibleWhiteNotes.length || (this.octaves * 7);
        if (totalWhiteKeys === 0) return;

        // Find the white-key index of every "C" in the visible range to align separators.
        for (let midi = this.startNote; midi < this.startNote + totalNotes; midi++) {
            if (midi % 12 === 0) {
                const whiteIdx = this.visibleWhiteNotes.indexOf(midi);
                if (whiteIdx < 0) continue;
                const leftPct = (whiteIdx / totalWhiteKeys) * 100;
                const sep = document.createElement('div');
                sep.className = 'octave-separator';
                sep.style.left = `${leftPct}%`;
                bar.appendChild(sep);
            }
        }

        // One label per octave, anchored on the C of that octave.
        let currentOctave = null;
        for (let i = 0; i < this.visibleWhiteNotes.length; i++) {
            const midi = this.visibleWhiteNotes[i];
            const octave = Math.floor(midi / 12) - 1;
            if (octave !== currentOctave && (midi % 12 === 0 || i === 0)) {
                currentOctave = octave;
                // Find next "C" white-index (or end)
                let nextC = this.visibleWhiteNotes.length;
                for (let j = i + 1; j < this.visibleWhiteNotes.length; j++) {
                    if (this.visibleWhiteNotes[j] % 12 === 0) { nextC = j; break; }
                }
                const leftPct = (i / totalWhiteKeys) * 100;
                const widthPct = ((nextC - i) / totalWhiteKeys) * 100;
                const lbl = document.createElement('div');
                lbl.className = 'octave-label';
                lbl.style.left = `${leftPct}%`;
                lbl.style.width = `${widthPct}%`;
                lbl.textContent = `C${octave}` === 'NaN' ? '' : (
                    this.noteLabelFormat === 'solfege' ? `Do${octave}` :
                    this.noteLabelFormat === 'midi' ? String(midi) :
                    `C${octave}`
                );
                bar.appendChild(lbl);
            }
        }
    }

    /**
     * Switch the visible view mode (piano | fretboard | drumpad).
     * @param {string} mode
     */
    KeyboardPianoMixin.setViewMode = function(mode) {
        const validModes = ['piano', 'fretboard', 'drumpad'];
        if (!validModes.includes(mode)) mode = 'piano';
        this.viewMode = mode;

        const piano = document.getElementById('piano-container');
        const fretboard = document.getElementById('fretboard-container');
        const drumpad = document.getElementById('drumpad-container');
        const octaveBar = document.getElementById('keyboard-octave-bar');
        const minimap = document.getElementById('keyboard-minimap-row');
        if (!piano || !fretboard || !drumpad) return;

        piano.classList.toggle('hidden', mode !== 'piano');
        fretboard.classList.toggle('hidden', mode !== 'fretboard');
        drumpad.classList.toggle('hidden', mode !== 'drumpad');

        // Octave bar + minimap only make sense for the linear piano view.
        if (octaveBar) octaveBar.classList.toggle('hidden', mode !== 'piano');
        if (minimap) minimap.classList.toggle('hidden', mode !== 'piano');

        // Note-color toggle is relevant in piano and fretboard (tablature) modes.
        const noteColorGroup = document.getElementById('keyboard-note-color-group');
        if (noteColorGroup) noteColorGroup.classList.toggle('hidden', mode === 'drumpad');

        // Update toggle button label
        const btn = document.getElementById('keyboard-view-toggle');
        if (btn) {
            if (mode === 'fretboard') btn.textContent = '🎸';
            else if (mode === 'drumpad') btn.textContent = '🥁';
            else btn.textContent = '🎹';
        }

        if (mode === 'fretboard') this.renderFretboard();
        if (mode === 'drumpad') this.renderDrumPad();
        // Regenerate piano keys so colors/state are always in sync when returning to piano view.
        if (mode === 'piano') this.regeneratePianoKeys();
    }

    /**
     * Render a string-instrument fretboard.
     */
    KeyboardPianoMixin.renderFretboard = function() {
        const container = document.getElementById('fretboard-container');
        if (!container) return;
        container.innerHTML = '';

        const cfg = this.stringInstrumentConfig || {};
        const numStrings = Math.max(1, cfg.num_strings || 6);
        const numFrets = Math.max(0, cfg.num_frets ?? 22);
        // Standard guitar tuning fallback (low → high E-A-D-G-B-E)
        const defaultTunings = {
            6: [40, 45, 50, 55, 59, 64],
            4: [28, 33, 38, 43],
            5: [28, 33, 38, 43, 47],
            7: [35, 40, 45, 50, 55, 59, 64],
            12: [40, 45, 50, 55, 59, 64, 40, 45, 50, 55, 59, 64]
        };
        let tuning;
        if (Array.isArray(cfg.tuning) && cfg.tuning.length === numStrings) {
            tuning = cfg.tuning;
        } else if (Array.isArray(cfg.tuning_midi) && cfg.tuning_midi.length === numStrings) {
            tuning = cfg.tuning_midi;
        } else {
            tuning = defaultTunings[numStrings] || Array.from({ length: numStrings }, (_, i) => 40 + i * 5);
        }
        // Tuning convention: index 0 = lowest pitch. Display lowest at the bottom.
        const stringsTopDown = [...tuning].reverse();

        // Per-string fret counts: frets_per_string is stored in tuning order
        // (index 0 = lowest string). Reverse it to match stringsTopDown (highest first).
        const fretsPerStringRaw = Array.isArray(cfg.frets_per_string) && cfg.frets_per_string.length === numStrings
            ? cfg.frets_per_string
            : null;
        const stringFretCounts = fretsPerStringRaw ? [...fretsPerStringRaw].reverse() : null;

        const isFretless = !!cfg.is_fretless || numFrets === 0;

        // The grid must accommodate the widest string. When frets differ per string,
        // use the max; otherwise use the global numFrets.
        const maxFretCount = stringFretCounts
            ? Math.max(12, ...stringFretCounts)
            : Math.max(12, numFrets || 0);

        if (isFretless) container.classList.add('fretless');
        else container.classList.remove('fretless');

        // Compute realistic fret-cell widths using the standard equal-tempered
        // scale: position(f) / scale_length = 1 - 1/2^(f/12). Each cell f
        // occupies the space between fret f-1 (nut for f=1) and fret f. We
        // express widths as `fr` units so CSS distributes them automatically
        // across whatever width the row has.
        const cellSpans = [];
        for (let f = 1; f <= maxFretCount; f++) {
            const prev = 1 - Math.pow(2, -(f - 1) / 12);
            const curr = 1 - Math.pow(2, -f / 12);
            cellSpans.push(curr - prev);
        }
        // Round to 4 decimals so the inline style stays compact.
        const fretCols = cellSpans.map(s => `${(s * 1000).toFixed(0)}fr`).join(' ');
        // Open-string column: fixed width sized roughly like one fret but a
        // bit wider so the nut + open-string label remain comfortable.
        const gridCols = `48px ${fretCols}`;

        // Header row: fret numbers
        const header = document.createElement('div');
        header.className = 'fret-header';
        header.style.gridTemplateColumns = gridCols;
        // Open (nut) cell
        const openLbl = document.createElement('div');
        openLbl.className = 'fret-number nut';
        openLbl.textContent = '0';
        header.appendChild(openLbl);
        for (let f = 1; f <= maxFretCount; f++) {
            const cell = document.createElement('div');
            cell.className = 'fret-number';
            cell.textContent = String(f);
            // Inlay markers at standard guitar positions
            if ([3, 5, 7, 9, 15, 17, 19, 21].includes(f)) cell.classList.add('inlay');
            if (f === 12 || f === 24) cell.classList.add('inlay-double');
            header.appendChild(cell);
        }
        container.appendChild(header);

        // Strings — `stringsTopDown` is reversed so the highest pitch is at the
        // top. The 1-indexed string number used by the project's CC convention
        // (string 1 = lowest pitch) is therefore `numStrings - s`.
        const totalStrings = stringsTopDown.length;
        for (let s = 0; s < totalStrings; s++) {
            const openMidi = stringsTopDown[s];
            const stringNumber = totalStrings - s; // 1-based, lowest = 1
            // How many frets this string actually has (may differ from maxFretCount).
            const thisStringFrets = stringFretCounts ? stringFretCounts[s] : maxFretCount;
            const row = document.createElement('div');
            row.className = 'fret-string';
            row.style.gridTemplateColumns = gridCols;
            row.dataset.stringNumber = stringNumber;
            // Vibration overlay — absolutely positioned, updated by _updateFretboardStringColors().
            const vibe = document.createElement('div');
            vibe.className = 'string-vibe';
            row.appendChild(vibe);
            // Open string cell (fret 0 = the nut)
            const openCell = this._buildFretCell(openMidi, true, stringNumber, 0);
            row.appendChild(openCell);
            for (let f = 1; f <= maxFretCount; f++) {
                if (f > thisStringFrets) {
                    // This fret doesn't exist on this string — render a dead zone.
                    const dead = document.createElement('div');
                    dead.className = 'fret-cell fret-dead';
                    row.appendChild(dead);
                } else {
                    const midi = openMidi + f;
                    const cell = this._buildFretCell(midi, false, stringNumber, f);
                    row.appendChild(cell);
                }
            }
            container.appendChild(row);
        }
    }

    KeyboardPianoMixin._buildFretCell = function(midi, isOpen, stringNumber, fret) {
        const cell = document.createElement('div');
        cell.className = 'fret-cell' + (isOpen ? ' fret-open' : '');
        cell.dataset.note = midi;
        if (midi >= 0 && midi <= 127) {
            const dot = document.createElement('div');
            dot.className = 'fret-dot piano-key';
            dot.dataset.note = midi;
            // Tag the dot with its string + fret so the click handler can
            // emit the configured "select string" / "select fret" CCs before
            // the note-on message.
            if (stringNumber !== undefined) dot.dataset.string = String(stringNumber);
            if (fret !== undefined) dot.dataset.fret = String(fret);
            if (!this.isNotePlayable(midi)) dot.classList.add('disabled');

            // Apply chromatic note color when enabled (one color per semitone,
            // identical across octaves — makes same-pitch notes obvious on all strings).
            if (this.showNoteColors) {
                const color = FRET_NOTE_COLORS[midi % 12];
                dot.style.setProperty('--dot-color', color.bg);
                dot.style.background = color.bg;
                dot.style.borderColor = 'rgba(0,0,0,0.3)';
                dot.classList.add('note-colored');
                const label = document.createElement('span');
                label.className = 'fret-label';
                label.style.color = color.text;
                label.textContent = this.getNoteLabel(midi);
                dot.appendChild(label);
            } else {
                const label = document.createElement('span');
                label.className = 'fret-label';
                label.textContent = this.getNoteLabel(midi);
                dot.appendChild(label);
            }

            cell.appendChild(dot);
        }
        return cell;
    }

    /**
     * Update the string-vibration overlay for each fretboard row.
     * Called by updatePianoDisplay() when viewMode === 'fretboard'.
     *
     * Only the RIGHT portion of the string (from pressed fret to bridge) is
     * colored — the left (nut → fret) is left untouched.
     * The vibrating segment is highly exaggerated: bright, wide glow + shimmer.
     */
    KeyboardPianoMixin._updateFretboardStringColors = function() {
        const rows = document.querySelectorAll('.fretboard-container .fret-string');
        rows.forEach(row => {
            const vibe = row.querySelector('.string-vibe');
            if (!vibe) return;

            const activeDot = row.querySelector('.fret-dot.active');
            if (!activeDot) {
                vibe.style.display = 'none';
                row.classList.remove('string-active');
                return;
            }

            const cell = activeDot.closest('.fret-cell');
            if (!cell) { vibe.style.display = 'none'; return; }

            // Start at the center of the active fret dot, span to the right edge.
            const startPx = cell.offsetLeft + cell.offsetWidth / 2;
            vibe.style.left  = startPx + 'px';
            vibe.style.right = '0';

            const note = parseInt(activeDot.dataset.note, 10);
            const color = this.showNoteColors ? FRET_NOTE_COLORS[note % 12].bg : '#f59e0b';

            // Bright at the fret, fading toward the bridge — exaggerated glow.
            vibe.style.background = `linear-gradient(to right,
                ${color}       0%,
                ${color}ee    15%,
                ${color}99    40%,
                ${color}44    70%,
                ${color}11   100%)`;
            vibe.style.boxShadow = `0 0 8px 2px ${color}cc, 0 0 18px 4px ${color}66`;

            vibe.style.display = 'block';
            row.classList.add('string-active');
        });
    }

    /**
     * Resolve the SVG asset path for a given GM drum MIDI note.
     * Returns null when no specific SVG is available (caller falls back to
     * the kit_standard placeholder).
     */
    KeyboardPianoMixin._getDrumSvgPath = function(midi) {
        // Direct match (drum_<midi>.svg)
        const direct = new Set([35, 37, 38, 40, 41, 42, 45, 49, 52, 58, 65, 73, 75, 78]);
        if (direct.has(midi)) return `assets/drums/drum_${midi}.svg`;

        // Aliases for notes that share an SVG with a sibling drum.
        const alias = {
            36: 'drum_35',  // Bass Drum 1 ↔ Acoustic Bass Drum
            39: 'Hand-Clap',
            44: 'drum_42', // Pedal Hi-Hat ↔ Closed Hi-Hat
            46: 'Open-Hi-Hat',
            43: 'drum_41', // High Floor Tom ↔ Low Floor Tom
            47: 'drum_45', // Low-Mid Tom ↔ Low Tom
            48: 'drum_45', // Hi-Mid Tom ↔ Low Tom
            50: 'drum_45', // High Tom ↔ Low Tom
            51: 'drum_49', // Ride Cymbal 1 ↔ Crash Cymbal 1
            53: 'drum_49', // Ride Bell
            55: 'drum_49', // Splash Cymbal
            57: 'drum_49', // Crash Cymbal 2
            59: 'drum_49', // Ride Cymbal 2
            54: 'Tambourine',
            56: 'Cowbell',
            60: 'Bongos', 61: 'Bongos',
            62: 'Conga', 63: 'Conga', 64: 'Conga',
            66: 'drum_65', // Low Timbale ↔ High Timbale
            69: 'Cabasa',
            70: 'Maracas',
            71: 'whistle', 72: 'whistle',
            74: 'drum_73', // Long Guiro
            76: 'drum_75', 77: 'drum_75', // Wood Blocks
            79: 'drum_78', // Open Cuica
            80: 'Triangle', 81: 'Triangle'
        };
        if (alias[midi]) return `assets/drums/${alias[midi]}.svg`;
        return 'assets/drums/kit_standard.svg';
    }

    /**
     * Standard GM drum names (channel 10) for the pad title.
     */
    KeyboardPianoMixin._getDrumName = function(midi) {
        const gmDrumNames = {
            27: 'High Q', 28: 'Slap', 29: 'Scratch Push', 30: 'Scratch Pull',
            31: 'Sticks', 32: 'Square Click', 33: 'Metronome', 34: 'Metronome Bell',
            35: 'Acoustic Bass', 36: 'Bass Drum 1', 37: 'Side Stick', 38: 'Acoustic Snare',
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
        return gmDrumNames[midi] || '';
    }

    /**
     * GM drum categories — used to group the drum pad layout. Each note maps
     * to a category id; the categories themselves are rendered in the order
     * defined by `_getDrumCategoryOrder()` and notes are kept in MIDI order
     * inside their group.
     */
    KeyboardPianoMixin._getDrumCategory = function(midi) {
        if (midi === 35 || midi === 36) return 'kick';
        if (midi === 37 || midi === 38 || midi === 40) return 'snare';
        if (midi === 39) return 'clap';
        if ([41, 43, 45, 47, 48, 50].includes(midi)) return 'tom';
        if ([42, 44, 46].includes(midi)) return 'hihat';
        if ([49, 51, 52, 53, 55, 57, 59].includes(midi)) return 'cymbal';
        if (midi === 54) return 'tambourine';
        if (midi === 56) return 'cowbell';
        if (midi === 58) return 'vibraslap';
        if ([60, 61].includes(midi)) return 'bongos';
        if ([62, 63, 64].includes(midi)) return 'congas';
        if ([65, 66].includes(midi)) return 'timbales';
        if ([67, 68].includes(midi)) return 'agogo';
        if (midi === 69) return 'cabasa';
        if (midi === 70) return 'maracas';
        if ([71, 72].includes(midi)) return 'whistle';
        if ([73, 74].includes(midi)) return 'guiro';
        if (midi === 75) return 'claves';
        if ([76, 77].includes(midi)) return 'woodblock';
        if ([78, 79].includes(midi)) return 'cuica';
        if ([80, 81].includes(midi)) return 'triangle';
        return 'other';
    }

    KeyboardPianoMixin._getDrumCategoryOrder = function() {
        return [
            { id: 'kick', label: 'Kick' },
            { id: 'snare', label: 'Snare' },
            { id: 'clap', label: 'Clap' },
            { id: 'tom', label: 'Toms' },
            { id: 'hihat', label: 'Hi-Hat' },
            { id: 'cymbal', label: 'Cymbals' },
            { id: 'tambourine', label: 'Tambourine' },
            { id: 'cowbell', label: 'Cowbell' },
            { id: 'vibraslap', label: 'Vibraslap' },
            { id: 'bongos', label: 'Bongos' },
            { id: 'congas', label: 'Congas' },
            { id: 'timbales', label: 'Timbales' },
            { id: 'agogo', label: 'Agogo' },
            { id: 'cabasa', label: 'Cabasa' },
            { id: 'maracas', label: 'Maracas' },
            { id: 'whistle', label: 'Whistle' },
            { id: 'guiro', label: 'Guiro' },
            { id: 'claves', label: 'Claves' },
            { id: 'woodblock', label: 'Wood Block' },
            { id: 'cuica', label: 'Cuica' },
            { id: 'triangle', label: 'Triangle' },
            { id: 'other', label: 'Other' }
        ];
    }

    /**
     * Render a drum pad grid using the instrument's selected_notes (discrete).
     * Pads are sorted by drum-kit category (kick → snare → toms → cymbals…)
     * then by MIDI inside each category, but rendered as a single flat grid
     * (no per-group label) so the layout stays compact.
     */
    KeyboardPianoMixin.renderDrumPad = function() {
        const container = document.getElementById('drumpad-container');
        if (!container) return;
        container.innerHTML = '';

        const caps = this.selectedDeviceCapabilities;
        let notes = [];
        if (caps && caps.selected_notes) {
            try {
                notes = typeof caps.selected_notes === 'string'
                    ? JSON.parse(caps.selected_notes)
                    : caps.selected_notes;
            } catch (e) { notes = []; }
        }

        // GM drum kit fallback (when no discrete notes are configured)
        if (!Array.isArray(notes) || notes.length === 0) {
            notes = [35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59];
        }

        // Build a category-ordered list of MIDI notes. We bucket by category,
        // then concatenate in the canonical category order, keeping MIDI order
        // inside each bucket.
        const order = this._getDrumCategoryOrder();
        const categoryIndex = new Map(order.map((c, i) => [c.id, i]));
        const sortedByCategory = [...new Set(notes)].sort((a, b) => {
            const ai = categoryIndex.get(this._getDrumCategory(a)) ?? 999;
            const bi = categoryIndex.get(this._getDrumCategory(b)) ?? 999;
            if (ai !== bi) return ai - bi;
            return a - b;
        });

        for (const midi of sortedByCategory) {
            const pad = document.createElement('div');
            pad.className = 'drum-pad piano-key';
            pad.dataset.note = midi;
            const name = this._getDrumName(midi);
            pad.title = name ? `${name} (${this.getNoteLabel(midi)})` : this.getNoteLabel(midi);
            if (!this.isNotePlayable(midi)) pad.classList.add('disabled');

            const icon = document.createElement('img');
            icon.className = 'drum-pad-icon';
            icon.src = this._getDrumSvgPath(midi);
            icon.alt = name || `MIDI ${midi}`;
            icon.draggable = false;
            icon.onerror = () => { icon.style.visibility = 'hidden'; };
            pad.appendChild(icon);

            if (name) {
                const caption = document.createElement('span');
                caption.className = 'drum-pad-name';
                caption.textContent = name;
                pad.appendChild(caption);
            }

            const badge = document.createElement('span');
            badge.className = 'drum-pad-badge';
            badge.textContent = this.getNoteLabel(midi);
            pad.appendChild(badge);

            container.appendChild(pad);
        }
    }

    /**
     * Check whether a note is playable by the selected instrument
     * @param {number} noteNumber - MIDI note number
     * @returns {boolean} - true if the note is playable
     */
    KeyboardPianoMixin.isNotePlayable = function(noteNumber) {
        if (!this.selectedDeviceCapabilities) {
            return true; // No restrictions if no capabilities defined
        }

        const caps = this.selectedDeviceCapabilities;

        // Discrete mode: check whether the note is in the list
        if (caps.note_selection_mode === 'discrete') {
            // If no notes selected, allow all notes
            if (!caps.selected_notes) {
                return true;
            }
            try {
                const selectedNotes = typeof caps.selected_notes === 'string'
                    ? JSON.parse(caps.selected_notes)
                    : caps.selected_notes;
                // If the list is empty, allow all notes
                if (!Array.isArray(selectedNotes) || selectedNotes.length === 0) {
                    return true;
                }
                return selectedNotes.includes(noteNumber);
            } catch (e) {
                return true;
            }
        }

        // Range mode: check whether the note is within the range
        const minNote = caps.note_range_min;
        const maxNote = caps.note_range_max;

        // If no range defined, allow all notes
        if ((minNote === null || minNote === undefined) &&
            (maxNote === null || maxNote === undefined)) {
            return true;
        }

        if (minNote !== null && minNote !== undefined && noteNumber < minNote) {
            return false;
        }
        if (maxNote !== null && maxNote !== undefined && noteNumber > maxNote) {
            return false;
        }

        return true;
    }

    /**
     * Event delegation on the piano container
     * Replaces per-key individual listeners (avoids memory leaks)
     */
    KeyboardPianoMixin._setupPianoDelegation = function() {
        // Listen on the parent canvas container so delegation also covers
        // fretboard cells and drum pads, not just the linear piano keys.
        const container = document.getElementById('keyboard-canvas-container')
                       || document.getElementById('piano-container');
        if (!container) return;

        // Remove the old delegated listeners if they exist
        if (this._pianoMouseDown) {
            container.removeEventListener('mousedown', this._pianoMouseDown);
            container.removeEventListener('mouseup', this._pianoMouseUp);
            container.removeEventListener('mouseleave', this._pianoMouseLeave, true);
            container.removeEventListener('mouseenter', this._pianoMouseEnter, true);
            container.removeEventListener('touchstart', this._pianoTouchStart);
            container.removeEventListener('touchend', this._pianoTouchEnd);
        }

        const getKey = (e) => e.target.closest('.piano-key');

        this._pianoMouseDown = (e) => {
            const key = getKey(e);
            if (key) {
                e.preventDefault(); // Prevent the browser's drag/selection
                this.handlePianoKeyDown({ currentTarget: key, preventDefault: () => {} });
            }
        };
        this._pianoMouseUp = (e) => {
            const key = getKey(e);
            if (key) { this.handlePianoKeyUp({ currentTarget: key }); }
        };
        this._pianoMouseLeave = (e) => {
            if (e.target.classList?.contains('piano-key')) {
                const note = parseInt(e.target.dataset.note);
                this.mouseActiveNotes.delete(note);
                this.handlePianoKeyUp({ currentTarget: e.target });
            }
        };
        this._pianoMouseEnter = (e) => {
            if (e.target.classList?.contains('piano-key')) {
                this.handlePianoKeyEnter({ currentTarget: e.target });
            }
        };
        this._pianoTouchStart = (e) => {
            const key = getKey(e);
            if (key) { e.preventDefault(); this.handlePianoKeyDown({ currentTarget: key, preventDefault: () => {} }); }
        };
        this._pianoTouchEnd = (e) => {
            const key = getKey(e);
            if (key) { e.preventDefault(); this.handlePianoKeyUp({ currentTarget: key }); }
        };

        container.addEventListener('mousedown', this._pianoMouseDown);
        container.addEventListener('mouseup', this._pianoMouseUp);
        container.addEventListener('mouseleave', this._pianoMouseLeave, true);
        container.addEventListener('mouseenter', this._pianoMouseEnter, true);
        container.addEventListener('touchstart', this._pianoTouchStart, { passive: false });
        container.addEventListener('touchend', this._pianoTouchEnd, { passive: false });
    }

    /**
     * Auto-center the keyboard on the instrument's note range
     * Computes startNote with per-note precision (not per-octave)
     */
    KeyboardPianoMixin.autoCenterKeyboard = function() {
        const caps = this.selectedDeviceCapabilities;
        if (!caps) {
            this.startNote = this.defaultStartNote;
            this._updateOctaveDisplay();
            this.logger.info('[KeyboardModal] Auto-center: no capabilities, reset to default');
            return;
        }

        // Determine the effective range based on mode
        let effectiveMin, effectiveMax;

        if (caps.note_selection_mode === 'discrete' && caps.selected_notes) {
            // Percussion mode: compute min/max from the discrete notes
            try {
                const notes = typeof caps.selected_notes === 'string'
                    ? JSON.parse(caps.selected_notes)
                    : caps.selected_notes;
                if (Array.isArray(notes) && notes.length > 0) {
                    effectiveMin = Math.min(...notes);
                    effectiveMax = Math.max(...notes);
                }
            } catch (e) { /* ignore */ }
        }

        // Fall back to note_range_min/max
        if (effectiveMin === undefined || effectiveMax === undefined) {
            const minNote = Number(caps.note_range_min);
            const maxNote = Number(caps.note_range_max);
            if (!isFinite(minNote) && !isFinite(maxNote)) {
                this.startNote = this.defaultStartNote;
                this._updateOctaveDisplay();
                this.logger.info('[KeyboardModal] Auto-center: no note range, reset to default');
                return;
            }
            effectiveMin = isFinite(minNote) ? minNote : 21;
            effectiveMax = isFinite(maxNote) ? maxNote : 108;
        }

        // Center of the playable range
        const rangeCenter = (effectiveMin + effectiveMax) / 2;
        const totalNotes = this.visibleNoteCount;

        // Ideal startNote to center the view on the playable range
        const idealStart = Math.round(rangeCenter - totalNotes / 2);

        // Clamp within MIDI bounds (0-127)
        this.startNote = Math.max(0, Math.min(127 - totalNotes, idealStart));

        this._updateOctaveDisplay();
        this.logger.info(`[KeyboardModal] Auto-center: range ${effectiveMin}-${effectiveMax}, center ${rangeCenter}, startNote ${this.startNote} (${this.getNoteNameFromNumber(this.startNote)})`);
    }

    if (typeof window !== 'undefined') window.KeyboardPianoMixin = KeyboardPianoMixin;
})();
