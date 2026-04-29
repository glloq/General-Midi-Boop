// Auto-extracted from KeyboardModal.js
(function() {
    'use strict';
    const KeyboardPianoMixin = {};


    KeyboardPianoMixin.createModal = function() {
        const endNote = this.startNote + this.visibleNoteCount - 1;
        const display = `${this.getNoteLabel(this.startNote)} - ${this.getNoteLabel(endNote)}`;

        // Build octaves count options dynamically from min/max.
        let octaveOptions = '';
        for (let i = this.minOctaves; i <= this.maxOctaves; i++) {
            octaveOptions += `<option value="${i}" ${this.octaves === i ? 'selected' : ''}>${i}</option>`;
        }

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

                            <div class="control-group">
                                <label>${this.t('keyboard.layout')}</label>
                                <select class="layout-select" id="keyboard-layout-select">
                                    <option value="azerty">${this.t('keyboard.layoutAzerty')}</option>
                                    <option value="qwerty">${this.t('keyboard.layoutQwerty')}</option>
                                </select>
                            </div>

                            <div class="control-group">
                                <label>${this.t('keyboard.notation') || 'Notation'}</label>
                                <div class="notation-toggle" id="keyboard-notation-toggle" role="radiogroup">
                                    <button type="button" class="notation-btn ${this.noteLabelFormat === 'english' ? 'active' : ''}" data-notation="english" role="radio" aria-checked="${this.noteLabelFormat === 'english'}">US</button>
                                    <span class="notation-sep">/</span>
                                    <button type="button" class="notation-btn ${this.noteLabelFormat === 'solfege' ? 'active' : ''}" data-notation="solfege" role="radio" aria-checked="${this.noteLabelFormat === 'solfege'}">FR</button>
                                    <span class="notation-sep">/</span>
                                    <button type="button" class="notation-btn ${this.noteLabelFormat === 'midi' ? 'active' : ''}" data-notation="midi" role="radio" aria-checked="${this.noteLabelFormat === 'midi'}">MIDI</button>
                                </div>
                            </div>

                            <div class="control-group octaves-count-group">
                                <label>${this.t('settings.keyboard.octaveCount')}</label>
                                <select class="octaves-count-select" id="keyboard-octaves-count-select">
                                    ${octaveOptions}
                                </select>
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
                            <div class="keyboard-help-bar">
                                <span class="info-label">${this.t('keyboard.pcKeys')}</span>
                                <span class="info-value" id="keyboard-help-text">${this.t('keyboard.azertyHelp')}</span>
                            </div>
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
                bk.style.width = `${wPct * 0.6}%`;
                bk.style.left = `${wPct * (whiteBelow + 0.7)}%`;
                bg.appendChild(bk);
            }

            // Insert bg before the viewport so the viewport overlays it.
            track.insertBefore(bg, viewport);
        }

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

        // Update toggle button label
        const btn = document.getElementById('keyboard-view-toggle');
        if (btn) {
            if (mode === 'fretboard') btn.textContent = '🎸';
            else if (mode === 'drumpad') btn.textContent = '🥁';
            else btn.textContent = '🎹';
        }

        if (mode === 'fretboard') this.renderFretboard();
        if (mode === 'drumpad') this.renderDrumPad();
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

        // Header row: fret numbers
        const fretCount = Math.max(1, numFrets);
        const header = document.createElement('div');
        header.className = 'fret-header';
        // Open (nut) cell
        const openLbl = document.createElement('div');
        openLbl.className = 'fret-number nut';
        openLbl.textContent = '0';
        header.appendChild(openLbl);
        for (let f = 1; f <= fretCount; f++) {
            const cell = document.createElement('div');
            cell.className = 'fret-number';
            cell.textContent = String(f);
            // Inlay markers at standard guitar positions
            if ([3, 5, 7, 9, 15, 17, 19, 21].includes(f)) cell.classList.add('inlay');
            if (f === 12 || f === 24) cell.classList.add('inlay-double');
            header.appendChild(cell);
        }
        container.appendChild(header);

        // Strings
        for (let s = 0; s < stringsTopDown.length; s++) {
            const openMidi = stringsTopDown[s];
            const row = document.createElement('div');
            row.className = 'fret-string';
            // Open string cell (the nut)
            const openCell = this._buildFretCell(openMidi, true);
            row.appendChild(openCell);
            for (let f = 1; f <= fretCount; f++) {
                const midi = openMidi + f;
                const cell = this._buildFretCell(midi, false);
                row.appendChild(cell);
            }
            container.appendChild(row);
        }
    }

    KeyboardPianoMixin._buildFretCell = function(midi, isOpen) {
        const cell = document.createElement('div');
        cell.className = 'fret-cell' + (isOpen ? ' fret-open' : '');
        cell.dataset.note = midi;
        if (midi >= 0 && midi <= 127) {
            const dot = document.createElement('div');
            dot.className = 'fret-dot piano-key';
            dot.dataset.note = midi;
            if (!this.isNotePlayable(midi)) dot.classList.add('disabled');
            const label = document.createElement('span');
            label.className = 'fret-label';
            label.textContent = this.getNoteLabel(midi);
            dot.appendChild(label);
            cell.appendChild(dot);
        }
        return cell;
    }

    /**
     * Render a drum pad grid using the instrument's selected_notes (discrete).
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

        // Standard GM drum names (channel 10) for quick labels.
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

        const sorted = [...new Set(notes)].sort((a, b) => a - b);
        for (const midi of sorted) {
            const pad = document.createElement('div');
            pad.className = 'drum-pad piano-key';
            pad.dataset.note = midi;
            if (!this.isNotePlayable(midi)) pad.classList.add('disabled');

            const number = document.createElement('span');
            number.className = 'drum-pad-number';
            number.textContent = this.getNoteLabel(midi);
            pad.appendChild(number);

            const name = document.createElement('span');
            name.className = 'drum-pad-name';
            name.textContent = gmDrumNames[midi] || '';
            pad.appendChild(name);

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
