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
                    <!-- Instrument selector panel: full height, flush left -->
                    <div class="header-instrument-selector" id="header-instrument-selector">
                        <button class="instrument-trigger" id="instrument-trigger" type="button" aria-haspopup="listbox" aria-expanded="false">
                            <div class="instrument-trigger-icon" id="instrument-trigger-icon">
                                <img class="instrument-trigger-svg" id="instrument-trigger-svg" src="" alt="" style="display:none" />
                                <span class="instrument-trigger-emoji" id="instrument-trigger-emoji">🎵</span>
                            </div>
                            <span class="instrument-trigger-name" id="instrument-trigger-name">— ${this.t('common.select')} —</span>
                            <svg class="trigger-chevron" viewBox="0 0 10 6" width="10" height="6"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        </button>
                        <div class="instrument-dropdown" id="instrument-dropdown" role="listbox">
                        </div>
                    </div>

                    <div class="keyboard-header-row">
                        <div class="keyboard-header-controls">
                            <div class="control-group latency-group" id="keyboard-latency-group">
                                <label>${this.t('keyboard.latency') || 'Latency'}</label>
                                <span class="latency-display latency-empty" id="keyboard-latency-display">—</span>
                            </div>

                            <div class="control-group view-mode-group hidden" id="keyboard-view-mode-group">
                                <label>${this.t('keyboard.view') || 'View'}</label>
                                <button class="btn-view-toggle" id="keyboard-view-toggle" title="${this.t('keyboard.toggleView') || 'Toggle view'}">🎹</button>
                            </div>

                            <div class="control-group slide-mode-group hidden" id="keyboard-slide-mode-group">
                                <label>${this.t('keyboard.slideMode') || 'Glissement'}</label>
                                <button class="btn-slide-toggle" id="keyboard-slide-toggle" title="${this.t('keyboard.slideToggle') || 'Mode glissement par corde'}">〜</button>
                            </div>

                            <div class="control-group piano-slider-group hidden" id="keyboard-piano-slider-group">
                                <label>${this.t('keyboard.pianoSlider') || 'Slider'}</label>
                                <button class="btn-piano-slider-toggle" id="keyboard-piano-slider-toggle" title="${this.t('keyboard.pianoSliderToggle') || 'Mode slider — touches égales + pitch bend'}">⟺</button>
                            </div>

                            <div class="control-group list-view-group" id="keyboard-list-view-group">
                                <label>${this.t('keyboard.listView') || 'Liste'}</label>
                                <button class="btn-list-view-toggle" id="keyboard-list-view-toggle" aria-pressed="false" title="${this.t('keyboard.listViewToggle') || 'Vue liste — vélocité (hauteur du clic) et pitch bend (gauche/droite)'}">☰</button>
                            </div>

                            <!-- List view: CC selector for Y-axis (shown only in list view) -->
                            <div class="control-group list-cc-group hidden" id="keyboard-list-cc-group">
                                <label>Y → CC</label>
                                <select id="keyboard-list-cc-select" class="list-cc-select" title="CC envoyé lors du drag vertical (Y)">
                                    <option value="">Vélocité</option>
                                </select>
                            </div>

                            <!-- List view: pitch bend toggle for X-axis -->
                            <div class="control-group list-pb-group hidden" id="keyboard-list-pb-group">
                                <label>Pitch X</label>
                                <button class="btn-list-pb-toggle active" id="keyboard-list-pb-toggle" aria-pressed="true" title="Activer/désactiver le pitch bend sur le drag horizontal (X)">↔</button>
                            </div>

                            <div class="control-group note-color-group" id="keyboard-note-color-group">
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

                        <!-- Pitch bend wheel (hidden by default, shown if instrument has pitch_bend_enabled) -->
                        <div class="velocity-control-vertical pitch-bend-control-vertical slider-hidden no-transition" id="pitch-bend-control-panel">
                            <div class="velocity-label-vertical">${this.t('keyboard.pitchBend') || 'Pitch'}</div>
                            <div class="mod-wheel-wrapper">
                                <div class="mod-wheel-track" id="pitch-bend-track">
                                    <div class="mod-wheel-center-line"></div>
                                    <div class="mod-wheel-fill" id="pitch-bend-fill"></div>
                                    <div class="mod-wheel-thumb" id="pitch-bend-thumb"></div>
                                </div>
                            </div>
                            <div class="velocity-value-vertical pitch-bend-value-vertical" id="keyboard-pitchbend-display">0</div>
                        </div>

                        <!-- Main keyboard area -->
                        <div class="keyboard-main">
                            <div class="keyboard-canvas-container" id="keyboard-canvas-container">
                                <div id="piano-container" class="piano-container"></div>
                                <div id="piano-slider-container" class="piano-slider-container hidden"></div>
                                <div id="fretboard-container" class="fretboard-container hidden"></div>
                                <div id="drumpad-container" class="drumpad-container hidden"></div>
                                <div id="keyboard-list-container" class="keyboard-list-container hidden"></div>
                                <div id="km-hand-band" class="km-hand-band hidden"></div>
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
                const c = FRET_NOTE_COLORS[noteNumber % 12];
                colorDot.style.background = c.bg;
                colorDot.style.display = 'flex';
                const dotLabel = document.createElement('span');
                dotLabel.className = 'note-dot-label';
                dotLabel.style.color = c.text;
                dotLabel.textContent = labelText.replace(/\d+$/, '');
                colorDot.appendChild(dotLabel);
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

        // Fingers overlay — mount after keys are in the DOM so the container
        // has its layout geometry when requestAnimationFrame fires.
        if (typeof this._mountFingersOverlay === 'function') {
            this._mountFingersOverlay('piano');
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
                lbl.textContent = isNaN(octave) ? '' : (
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
        const validModes = ['piano', 'piano-slider', 'fretboard', 'drumpad', 'keyboard-list'];
        if (!validModes.includes(mode)) mode = 'piano';

        // Cleanup string slide mode when leaving fretboard
        if (this.viewMode === 'fretboard' && mode !== 'fretboard') {
            if (typeof this.destroyStringSliders === 'function') this.destroyStringSliders();
        }

        // Cleanup list view interaction when leaving list mode
        if (this.viewMode === 'keyboard-list' && mode !== 'keyboard-list') {
            if (typeof this._destroyKeyboardListInteraction === 'function') this._destroyKeyboardListInteraction();
        }

        // Destroy the fingers overlay when leaving a mode that supports it.
        // The canvas lives in km-hand-band (not inside piano-container), so
        // it must be explicitly cleaned and the band hidden whenever we enter
        // a mode without hands. _mountFingersOverlay() is responsible for
        // un-hiding the band when a hands-enabled instrument is loaded.
        const modesWithHands = ['piano', 'keyboard-list'];
        const enteringHandsMode = modesWithHands.includes(mode);
        if (modesWithHands.includes(this.viewMode) && !enteringHandsMode) {
            if (typeof this._cleanFingersCanvas === 'function') this._cleanFingersCanvas();
            const handBand = document.getElementById('km-hand-band');
            if (handBand) handBand.classList.add('hidden');
        }

        this.viewMode = mode;

        const piano = document.getElementById('piano-container');
        const pianoSlider = document.getElementById('piano-slider-container');
        const fretboard = document.getElementById('fretboard-container');
        const drumpad = document.getElementById('drumpad-container');
        const keyboardList = document.getElementById('keyboard-list-container');
        const octaveBar = document.getElementById('keyboard-octave-bar');
        const minimap = document.getElementById('keyboard-minimap-row');
        if (!piano || !fretboard || !drumpad) return;

        piano.classList.toggle('hidden', mode !== 'piano');
        if (pianoSlider) pianoSlider.classList.toggle('hidden', mode !== 'piano-slider');
        fretboard.classList.toggle('hidden', mode !== 'fretboard');
        drumpad.classList.toggle('hidden', mode !== 'drumpad');
        if (keyboardList) keyboardList.classList.toggle('hidden', mode !== 'keyboard-list');

        // Minimap visible for all piano-family modes (list view uses same note range)
        const isPianoFamily = mode === 'piano' || mode === 'piano-slider' || mode === 'keyboard-list';
        // Octave bar only for standard piano modes (list view labels notes directly)
        if (octaveBar) octaveBar.classList.toggle('hidden', mode !== 'piano' && mode !== 'piano-slider');
        if (minimap) minimap.classList.toggle('hidden', !isPianoFamily);

        // Note-color toggle: not useful for piano-slider, drumpad, or list view
        const noteColorGroup = document.getElementById('keyboard-note-color-group');
        if (noteColorGroup) noteColorGroup.classList.toggle('hidden', mode === 'drumpad' || mode === 'piano-slider');

        // Update view-mode toggle button label (piano-slider/list show 🎹 since they're piano family)
        const btn = document.getElementById('keyboard-view-toggle');
        if (btn) {
            if (mode === 'fretboard') btn.textContent = '🎸';
            else if (mode === 'drumpad') btn.textContent = '🥁';
            else btn.textContent = '🎹';
        }

        // Update piano-slider toggle button active state
        const sliderToggle = document.getElementById('keyboard-piano-slider-toggle');
        if (sliderToggle) {
            sliderToggle.classList.toggle('active', mode === 'piano-slider');
            sliderToggle.setAttribute('aria-pressed', mode === 'piano-slider' ? 'true' : 'false');
        }

        // Update list-view toggle button active state
        const listToggle = document.getElementById('keyboard-list-view-toggle');
        if (listToggle) {
            listToggle.classList.toggle('active', mode === 'keyboard-list');
            listToggle.setAttribute('aria-pressed', mode === 'keyboard-list' ? 'true' : 'false');
        }

        // Hide list-view toggle when in fretboard/drumpad context
        const listViewGroup = document.getElementById('keyboard-list-view-group');
        if (listViewGroup) {
            listViewGroup.classList.toggle('hidden', mode === 'fretboard' || mode === 'drumpad');
        }

        // List view extra controls: shown/hidden via _updateListViewControls (called after caps load)
        if (typeof this._updateListViewControls === 'function') {
            this._updateListViewControls();
        }

        if (typeof this._updateSlideModeGroupVisibility === 'function') {
            this._updateSlideModeGroupVisibility();
        }
        if (typeof this._updatePianoSliderGroupVisibility === 'function') {
            this._updatePianoSliderGroupVisibility();
        }

        if (mode === 'fretboard') this.renderFretboard();
        if (mode === 'drumpad') this.renderDrumPad();
        if (mode === 'piano-slider') this.generatePianoSlider();
        if (mode === 'keyboard-list') {
            if (typeof this.renderKeyboardList === 'function') this.renderKeyboardList();
        }
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

        // Strings live in a flex-grow wrapper; the chord bar sits below it.
        const stringsArea = document.createElement('div');
        stringsArea.className = 'fretboard-strings-area';

        const cfg = this.stringInstrumentConfig || {};
        const slideEnabled = !!cfg.string_sliding_system_enabled;
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
        // Hand-position widget (rendered by KeyboardChordsMixin if loaded)
        if (typeof this.renderHandWidget === 'function') {
            this.renderHandWidget(stringsArea, { maxFretCount, isFretless, gridCols });
        }

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
            // Slide-system overlays (blue travel zone + finger dot)
            if (slideEnabled) {
                const zoneEl = document.createElement('div');
                zoneEl.className = 'fret-slide-zone';
                row.appendChild(zoneEl);
                const fingerEl = document.createElement('div');
                fingerEl.className = 'fret-slide-finger';
                row.appendChild(fingerEl);
            }

            stringsArea.appendChild(row);
        }

        // Fret-number header below the strings (moved from top for readability)
        stringsArea.appendChild(header);

        container.appendChild(stringsArea);

        // The hand overlay relies on getBoundingClientRect() measurements that
        // are only valid after the element is in the DOM and laid out. Register
        // a rAF here (AFTER appendChild) so the overlay position is set even
        // if the initial rAF inside renderHandWidget fired before layout.
        if (typeof this._updateHandWidgetPosition === 'function') {
            requestAnimationFrame(() => this._updateHandWidgetPosition());
        }

        if (slideEnabled) {
            requestAnimationFrame(() => this._positionSlideZones());
        }

        // Chord buttons bar (rendered by KeyboardChordsMixin if loaded)
        if (typeof this.renderChordButtons === 'function') {
            this.renderChordButtons();
        }

        if (typeof this.initStringSliderMode === 'function') {
            this.initStringSliderMode();
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
     * Position the blue travel-zone band and the white finger dot for each
     * string row in the fretboard when string_sliding_system_enabled is set.
     * Uses offsetLeft measurements (same pattern as _updateFretboardStringColors)
     * so it must be called after the DOM is laid out.
     */
    KeyboardPianoMixin._positionSlideZones = function() {
        const cfg = this.stringInstrumentConfig || {};
        if (!cfg.string_sliding_system_enabled) return;

        const numFrets   = Math.max(0, cfg.num_frets ?? 22);
        const numStrings = Math.max(1, cfg.num_strings || 6);
        const fpRaw = Array.isArray(cfg.frets_per_string) && cfg.frets_per_string.length === numStrings
            ? [...cfg.frets_per_string].reverse()   // match stringsTopDown (highest first)
            : null;

        const rows = document.querySelectorAll('.fretboard-container .fret-string');
        rows.forEach((row, s) => {
            const zone   = row.querySelector('.fret-slide-zone');
            const finger = row.querySelector('.fret-slide-finger');
            if (!zone && !finger) return;

            const thisStringFrets = fpRaw ? (fpRaw[s] ?? numFrets) : numFrets;

            const fret1Dot    = row.querySelector('.fret-dot[data-fret="1"]');
            const lastFretDot = row.querySelector(`.fret-dot[data-fret="${thisStringFrets}"]`);
            if (!fret1Dot) return;

            const fret1Cell    = fret1Dot.closest('.fret-cell');
            const lastFretCell = lastFretDot ? lastFretDot.closest('.fret-cell') : null;
            if (!fret1Cell) return;

            const startX = fret1Cell.offsetLeft;
            const endX   = lastFretCell
                ? lastFretCell.offsetLeft + lastFretCell.offsetWidth
                : row.scrollWidth;

            if (zone) {
                zone.style.left  = startX + 'px';
                zone.style.width = (endX - startX) + 'px';
                zone.style.display = 'block';
            }
            if (finger) {
                // 85% into fret-1 width ≈ 8 mm before the fret boundary
                finger.style.left = (startX + fret1Cell.offsetWidth * 0.85) + 'px';
                finger.style.display = 'block';
            }
        });
    };

    /**
     * Move each string's finger dot to 85 % of the active fret cell width
     * (≈ 8 mm before the fret boundary).  Returns to fret-1 rest position
     * when no fret is pressed on that string (open string counts as "not
     * pressing").  Called from updatePianoDisplay() on every note event.
     */
    KeyboardPianoMixin._updateSlideFingerPositions = function() {
        const cfg = this.stringInstrumentConfig || {};
        if (!cfg.string_sliding_system_enabled) return;

        const rows = document.querySelectorAll('.fretboard-container .fret-string');
        rows.forEach(row => {
            const finger = row.querySelector('.fret-slide-finger');
            if (!finger || finger.style.display === 'none') return;

            // Only move on an active fret press (fret > 0). Open string and
            // note-off leave the dot at its current position.
            const activeDot = row.querySelector('.fret-dot.active');
            const activeFret = activeDot ? parseInt(activeDot.dataset.fret ?? '0', 10) : 0;
            if (activeFret <= 0) return;

            const targetCell = activeDot.closest('.fret-cell');
            if (!targetCell) return;
            finger.style.left = (targetCell.offsetLeft + targetCell.offsetWidth * 0.85) + 'px';
        });
    };

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
            e.preventDefault();
            for (const touch of e.changedTouches) {
                const key = getKey(touch);
                if (key) this.handlePianoKeyDown({ currentTarget: key, preventDefault: () => {} });
            }
        };
        this._pianoTouchEnd = (e) => {
            e.preventDefault();
            for (const touch of e.changedTouches) {
                const key = document.elementFromPoint(touch.clientX, touch.clientY)?.closest('.piano-key');
                if (key) this.handlePianoKeyUp({ currentTarget: key });
            }
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

    /**
     * Generate the equal-width piano slider (chromatic, all keys same size).
     * Each key = one semitone. Dragging horizontally sends pitch bend.
     * Called when entering 'piano-slider' view mode.
     */
    KeyboardPianoMixin.generatePianoSlider = function() {
        const container = document.getElementById('piano-slider-container');
        if (!container) return;
        container.innerHTML = '';

        const strip = document.createElement('div');
        strip.className = 'piano-slider-strip';
        strip.id = 'piano-slider-strip';

        const totalNotes = this.visibleNoteCount;
        const endNote = this.startNote + totalNotes;

        for (let midi = this.startNote; midi < endNote; midi++) {
            const semitone = midi % 12;
            const isBlack = this.blackNoteSemitones.has(semitone);
            const isC = semitone === 0;
            const label = this.getNoteLabel(midi);

            const key = document.createElement('div');
            key.className = 'piano-slider-key' +
                (isBlack ? ' is-black' : ' is-white') +
                (isC ? ' is-c' : '');
            key.dataset.note = midi;

            if (!this.isNotePlayable(midi)) key.classList.add('disabled');

            const lbl = document.createElement('span');
            lbl.className = 'piano-slider-label';
            // Show label only on C notes or when few notes are visible
            if (isC || totalNotes <= 24) lbl.textContent = label;
            key.appendChild(lbl);

            strip.appendChild(key);
        }

        // Cursor line (position indicator while dragging)
        const cursor = document.createElement('div');
        cursor.className = 'piano-slider-cursor';
        cursor.id = 'piano-slider-cursor';
        strip.appendChild(cursor);

        container.appendChild(strip);

        // Wire up drag events
        if (typeof this.initPianoSliderDrag === 'function') {
            this.initPianoSliderDrag(strip);
        }
    }

    if (typeof window !== 'undefined') window.KeyboardPianoMixin = KeyboardPianoMixin;

    // ────────────────────────────────────────────────────────────────────────
    //  Fingers overlay — shows hand / finger positions on the piano keys
    //  when the selected instrument has hands_config.enabled === true.
    //  The overlay is a canvas absolutely positioned over the piano-container
    //  content area (inset: 10 px on left/right to match the container padding).
    //  KeyboardFingersRenderer handles both `piano` and `chromatic` layouts.
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Mount (or remount) the canvas + KeyboardFingersRenderer in the km-hand-band
     * below the keyboard for the currently selected instrument's hands_config.
     *
     * @param {'piano'|'chromatic'} layout  'piano' when called from generatePianoKeys();
     *                                      'chromatic' when called from renderKeyboardList().
     *
     * The band element (#km-hand-band) must already exist in the DOM (created in
     * createModal()). This method shows it, appends a canvas with the correct
     * left/right inset to align fingers with the active key view, then initialises
     * the renderer and the drag interaction.
     */
    /** True when the currently loaded instrument declares hands with fingers. */
    KeyboardPianoMixin._instrumentHasFingers = function() {
        const hc = this.selectedDeviceCapabilities && this.selectedDeviceCapabilities.hands_config;
        return !!(hc && hc.enabled !== false && Array.isArray(hc.hands) && hc.hands.length > 0);
    };

    /**
     * Disable the keyboard-list view toggle when the instrument has fingers.
     * Switching between piano and chromatic-list layouts mid-session is blocked
     * because finger positions cannot be adapted across the two key geometries.
     */
    KeyboardPianoMixin._updateFingersViewToggle = function() {
        const btn = document.getElementById('keyboard-list-view-toggle');
        if (!btn) return;
        const locked = this._instrumentHasFingers();
        btn.disabled = locked;
        if (locked) {
            btn.setAttribute('title',
                this.t('keyboard.listViewLockedFingers')
                || 'Vue liste désactivée : l\'instrument a des doigts configurés');
        } else {
            btn.setAttribute('title',
                this.t('keyboard.listViewToggle')
                || 'Vue liste — vélocité (hauteur du clic) et pitch bend (gauche/droite)');
        }
    };

    KeyboardPianoMixin._mountFingersOverlay = function(layout) {
        layout = (layout === 'chromatic') ? 'chromatic' : 'piano';

        if (typeof window === 'undefined' || typeof window.KeyboardFingersRenderer !== 'function') return;

        // String instruments (fretboard) have their own finger display — never
        // show the piano-style hand overlay for them.
        if (typeof this.getInstrumentViewInfo === 'function'
                && this.getInstrumentViewInfo().canFretboard) {
            this._cleanFingersCanvas();
            const handBand = document.getElementById('km-hand-band');
            if (handBand) handBand.classList.add('hidden');
            return;
        }

        const caps = this.selectedDeviceCapabilities;
        const handsConfig = caps && caps.hands_config;
        const band = document.getElementById('km-hand-band');
        if (!handsConfig || handsConfig.enabled === false
                || !Array.isArray(handsConfig.hands) || handsConfig.hands.length === 0) {
            this._cleanFingersCanvas();
            if (band) band.classList.add('hidden');
            return;
        }

        if (!band) return;

        band.classList.remove('hidden');

        const rangeMin = this.startNote;
        const rangeMax = this.startNote + this.visibleNoteCount - 1;

        // FAST PATH — range scroll within the same layout (e.g. octave change).
        // Update the renderer's visible range and redraw without destroying or
        // recreating the canvas. True anchors in _handCurrentAnchors are NOT
        // mutated — we build a temporary displayAnchors map clamped to the new
        // visible range so hands "dock" at the view edges when out of range
        // without permanently drifting their stored MIDI positions.
        if (this._fingersRenderer && this._fingersCanvas
                && this._fingersLayout === layout && this._fingersHands) {
            this._fingersRenderer.setKeyboardWidget(
                { rangeMin, rangeMax, keyXAt: () => 0, keyWidth: () => 0 });
            this._fingersRenderer.setVisibleExtent({ lo: rangeMin, hi: rangeMax });
            if (this._handCurrentAnchors) {
                const displayAnchors = new Map();
                for (const hand of this._fingersHands) {
                    const a = this._handCurrentAnchors.get(hand.id);
                    if (Number.isFinite(a)) {
                        displayAnchors.set(hand.id,
                            Math.max(rangeMin, Math.min(rangeMax - hand.span, a)));
                    }
                }
                this._fingersRenderer.setAnchors(displayAnchors);
            }
            const _canvas = this._fingersCanvas;
            const _renderer = this._fingersRenderer;
            requestAnimationFrame(() => {
                const _keyContainerId = layout === 'piano'
                    ? 'piano-container' : 'keyboard-list-container';
                const _keyEl = document.getElementById(_keyContainerId);
                if (_keyEl && _keyEl.clientHeight > 0) {
                    const keyH = _keyEl.clientHeight;
                    _canvas.style.top    = `-${keyH}px`;
                    _canvas.style.height = `calc(100% + ${keyH}px)`;
                }
                _renderer.draw();
                this._positionHandArrows();
            });
            return;
        }

        // FULL MOUNT — first time, or layout changed (piano↔chromatic switch).
        this._fingersLayout = layout;

        // Destroy any previous renderer / listeners before recreating.
        this._cleanFingersCanvas();

        const canvas = document.createElement('canvas');
        canvas.className = 'km-fingers-canvas';
        // Piano keys are inside piano-container which has 10 px left/right padding;
        // the band sits in the same flex column, so indent the canvas 10 px each
        // side so fingers align exactly with white keys.
        // Chromatic (list) keys span the full keyboard-list-container with no padding,
        // so the canvas fills the band edge-to-edge.
        const inset = (layout === 'piano') ? '10px' : '0px';
        canvas.style.left = inset;
        canvas.style.right = inset;
        // Canvas is a replaced element with an HTML-default intrinsic size of
        // 300×150 — left/right alone don't force it to fill the host on every
        // browser (Firefox keeps the intrinsic 300 px width). Set explicit
        // width now; height is finalised in the requestAnimationFrame below
        // after the piano-container height can be measured.
        const insetPx = layout === 'piano' ? 10 : 0;
        canvas.style.width = insetPx > 0 ? `calc(100% - ${2 * insetPx}px)` : '100%';
        // Chromatic layout: use a fixed 60 px upward overlap (uniform bars
        // don't need to match the real key height). Piano layout: measured
        // dynamically in the rAF so T-shapes span the full key height.
        canvas.style.height = 'calc(100% + 60px)';
        band.appendChild(canvas);
        this._fingersCanvas = canvas;

        // bandHeight=80 means the renderer places the knuckle bar at
        // H - 80 from the canvas top, which = the band's top edge regardless
        // of how tall the canvas is (piano key height is variable).
        const renderer = new window.KeyboardFingersRenderer(canvas, {
            bandHeight: 50,
            whiteTipFraction: 0.85,
            blackTipFraction: 0.9,
            blackHeightRatio: 0.65,
            chromaticTipFraction: 0.65,
            knuckleHeight: 8,
        });
        this._fingersRenderer = renderer;

        // Provide rangeMin/rangeMax via a stub widget so _drawPiano can compute
        // white-key geometry. keyXAt/keyWidth dummies satisfy the validator but are
        // never actually called (the renderer measures positions from canvas.clientWidth).
        renderer.setLayout(layout);
        renderer.setKeyboardWidget({ rangeMin, rangeMax, keyXAt: () => 0, keyWidth: () => 0 });
        renderer.setVisibleExtent({ lo: rangeMin, hi: rangeMax });
        renderer.setActiveNotes(this.activeNotes instanceof Set ? this.activeNotes : new Set());

        const HAND_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6'];
        const rawHands = handsConfig.hands;
        const count = rawHands.length;
        const range = Math.max(1, rangeMax - rangeMin);

        const rendererHands = rawHands.map(function(h, i) {
            const numFingers = Number.isFinite(h.num_fingers) ? h.num_fingers : 5;
            // Piano: derive span from finger count (nf-1 semitones for W-G pattern).
            // Ignore hand_span_semitones for piano — legacy data may store f*2 which
            // is twice what the W-G pattern actually covers.
            const span = layout === 'piano'
                ? Math.max(0, numFingers - 1)
                : (Number.isFinite(h.hand_span_semitones) ? h.hand_span_semitones : Math.max(0, numFingers - 1));
            const center = rangeMin + Math.round(range * (i + 1) / (count + 1));
            const anchor = Math.max(rangeMin, Math.min(rangeMax - span, center - Math.round(span / 2)));
            return { id: h.id || ('h' + (i + 1)), span, numFingers, color: HAND_COLORS[i] || '#6b7280', anchor };
        });

        this._fingersHands = rendererHands;
        this._handCurrentAnchors = new Map(rendererHands.map(h => [h.id, h.anchor]));

        // Resolve initial overlaps: sort by anchor, push right neighbours away.
        const sortedInit = [...rendererHands].sort((a, b) => a.anchor - b.anchor);
        for (let i = 0; i < sortedInit.length - 1; i++) {
            const left  = sortedInit[i];
            const right = sortedInit[i + 1];
            const minRight = (this._handCurrentAnchors.get(left.id) || left.anchor) + left.span + 1;
            const curRight = this._handCurrentAnchors.get(right.id) ?? right.anchor;
            if (curRight < minRight) {
                this._handCurrentAnchors.set(right.id, Math.min(rangeMax - right.span, minRight));
            }
        }

        renderer.setHands(rendererHands);
        renderer.setAnchors(this._handCurrentAnchors);

        this._initFingersOverlayDrag();
        this._updateFingersViewToggle();
        this._renderHandArrows();

        const keyContainerId = layout === 'piano'
            ? 'piano-container' : 'keyboard-list-container';

        const fitCanvas = () => {
            const keyEl = document.getElementById(keyContainerId);
            if (!keyEl || !this._fingersCanvas) return;
            const keyH = keyEl.clientHeight;
            if (keyH <= 0) return;
            this._fingersCanvas.style.top    = `-${keyH}px`;
            this._fingersCanvas.style.height = `calc(100% + ${keyH}px)`;
        };

        requestAnimationFrame(() => {
            fitCanvas();
            renderer.draw();
            this._positionHandArrows();
        });

        // Keep canvas dimensions in sync when the modal or window is resized.
        if (typeof ResizeObserver === 'function') {
            const keyEl = document.getElementById(keyContainerId);
            if (keyEl) {
                if (this._fingersResizeObserver) this._fingersResizeObserver.disconnect();
                this._fingersResizeObserver = new ResizeObserver(() => {
                    if (!this._fingersCanvas || !this._fingersRenderer) return;
                    fitCanvas();
                    this._fingersRenderer.draw();
                    this._positionHandArrows();
                });
                this._fingersResizeObserver.observe(keyEl);
            }
        }
    };

    /**
     * Destroy the fingers renderer, remove its canvas, and tear down drag listeners.
     * Safe to call multiple times.
     */
    KeyboardPianoMixin._cleanFingersCanvas = function() {
        this._destroyFingersOverlayDrag();
        if (this._fingersResizeObserver) {
            this._fingersResizeObserver.disconnect();
            this._fingersResizeObserver = null;
        }
        if (this._fingersRenderer) {
            this._fingersRenderer.destroy();
            this._fingersRenderer = null;
        }
        if (this._fingersCanvas) {
            this._fingersCanvas.remove();
            this._fingersCanvas = null;
        }
        // Remove decorative arrow indicators created for the previous mount.
        const band = document.getElementById('km-hand-band');
        if (band) band.querySelectorAll('.km-hand-arrows').forEach(el => el.remove());
        this._fingersHands = null;
        this._handCurrentAnchors = null;
        this._updateFingersViewToggle();
    };

    /**
     * Returns true when `note` falls exactly on one of the visual finger
     * positions for a piano-mode hand anchored at `anchor` with `numFingers`.
     * White fingers land on white keys; gap fingers land on the black key
     * between two adjacent white fingers (if one exists).
     */
    KeyboardPianoMixin._pianoHandCoversNote = function(anchor, numFingers, note) {
        if (note < anchor) return false;
        const wn = this.visibleWhiteNotes;
        if (!wn || wn.length === 0) return note <= anchor + numFingers - 1;
        let si = wn.indexOf(anchor);
        if (si < 0) si = wn.findIndex(m => m >= anchor);
        if (si < 0) return false;
        const nf = numFingers || 5;
        const numWhites = Math.ceil(nf / 2);
        const numGaps   = Math.floor(nf / 2);
        const isBlack = (m) => { const v = ((m % 12) + 12) % 12; return v===1||v===3||v===6||v===8||v===10; };
        for (let wi = 0; wi < numWhites; wi++) {
            const idx = si + wi;
            if (idx >= wn.length) break;
            const w = wn[idx];
            if (note === w) return true;
            if (wi < numGaps) {
                const nextW = (idx + 1 < wn.length) ? wn[idx + 1] : Infinity;
                const bk = w + 1;
                if (isBlack(bk) && bk < nextW && note === bk) return true;
            }
        }
        return false;
    };

    /**
     * Refresh the active-notes state on the overlay and move the nearest hand
     * so each sounding note falls under one of its fingers.
     * Called from updatePianoDisplay() on every note-on / note-off.
     */
    KeyboardPianoMixin._updateFingersActiveNotes = function() {
        if (!this._fingersRenderer) return;

        const activeNotes = this.activeNotes instanceof Set ? this.activeNotes : new Set();
        this._fingersRenderer.setActiveNotes(activeNotes);

        // Move hands so every active note falls under at least one finger.
        // Skip notes already covered to avoid displacing a hand that is already
        // correctly positioned (e.g. chord with notes on the same hand).
        if (activeNotes.size > 0 && this._handCurrentAnchors && this._fingersHands) {
            for (const note of activeNotes) {
                const covered = this._fingersHands.some(h => {
                    const a = this._handCurrentAnchors.get(h.id);
                    if (!Number.isFinite(a)) return false;
                    if (this._fingersLayout === 'piano') {
                        return this._pianoHandCoversNote(a, h.numFingers, note);
                    }
                    return note >= a && note <= a + h.span;
                });
                if (!covered) this._moveNearestHandToNote(note);
            }
            this._fingersRenderer.setAnchors(this._handCurrentAnchors);
        }

        this._fingersRenderer.draw();
    };

    KeyboardPianoMixin._moveNearestHandToNote = function(note) {
        if (!this._fingersHands || !this._handCurrentAnchors) return;

        const rangeMin = this.startNote;
        const rangeMax = this.startNote + this.visibleNoteCount - 1;
        const isPiano = this._fingersLayout === 'piano';
        const wn = isPiano ? this.visibleWhiteNotes : null;

        // Find the hand whose current midpoint is nearest to the note.
        let nearestHand = null;
        let minDist = Infinity;
        for (const hand of this._fingersHands) {
            const anchor = this._handCurrentAnchors.get(hand.id);
            if (!Number.isFinite(anchor)) continue;
            const midpoint = anchor + hand.span / 2;
            const dist = Math.abs(note - midpoint);
            if (dist < minDist) {
                minDist = dist;
                nearestHand = hand;
            }
        }
        if (!nearestHand) return;

        const span = nearestHand.span;
        const nf   = nearestHand.numFingers || 5;
        const anchor = this._handCurrentAnchors.get(nearestHand.id);
        let newAnchor = anchor;

        if (isPiano && wn && wn.length > 0) {
            // Piano: use exact finger coverage; anchor must land on a white key.
            if (!this._pianoHandCoversNote(anchor, nf, note)) {
                const isBlackKey = (m) => { const v=((m%12)+12)%12; return v===1||v===3||v===6||v===8||v===10; };
                if (note < anchor) {
                    // Shift left: anchor on note's white key (black key → preceding white).
                    newAnchor = isBlackKey(note) ? note - 1 : note;
                } else {
                    // Shift right: walk forward from current anchor and find the
                    // first (leftmost = minimum shift) white key that covers note.
                    let si = wn.indexOf(anchor);
                    if (si < 0) si = wn.findIndex(m => m >= anchor);
                    if (si < 0) si = 0;
                    const limit = si + Math.ceil(nf / 2) + 1;
                    for (let i = si; i < Math.min(wn.length, limit); i++) {
                        if (this._pianoHandCoversNote(wn[i], nf, note)) {
                            newAnchor = wn[i];
                            break;
                        }
                    }
                }
            }
        } else {
            // Chromatic / fallback: semitone range.
            if (note < anchor) {
                newAnchor = note;
            } else if (note > anchor + span) {
                newAnchor = note - span;
            }
        }

        newAnchor = Math.max(rangeMin, Math.min(rangeMax - span, newAnchor));
        this._handCurrentAnchors.set(nearestHand.id, newAnchor);
        this._resolveHandCollisions(nearestHand.id);
    };

    /**
     * After a hand anchor changes, push neighbouring hands outward so no two
     * hands overlap. Enforces a 1-semitone minimum gap and cascades in both
     * directions from the moved hand.
     * @param {string} movedHandId
     */
    KeyboardPianoMixin._resolveHandCollisions = function(movedHandId) {
        if (!this._fingersHands || !this._handCurrentAnchors) return;
        const rangeMin = this.startNote;
        const rangeMax = this.startNote + this.visibleNoteCount - 1;
        const isPiano = this._fingersLayout === 'piano';
        const wn = (isPiano && Array.isArray(this.visibleWhiteNotes) && this.visibleWhiteNotes.length)
                   ? this.visibleWhiteNotes : null;

        const sorted = this._fingersHands
            .map(h => ({ id: h.id, span: h.span, nf: h.numFingers || 5,
                         anchor: this._handCurrentAnchors.get(h.id) }))
            .filter(h => Number.isFinite(h.anchor))
            .sort((a, b) => a.anchor - b.anchor);

        const movedIdx = sorted.findIndex(h => h.id === movedHandId);
        if (movedIdx < 0) return;

        if (wn) {
            // Piano: boundaries measured in white-key slots so pushed hands
            // always land on a white key and never visually overlap.
            const lowerBound = (midi) => {
                // First index in wn where wn[i] >= midi (binary search).
                let lo = 0, hi = wn.length;
                while (lo < hi) { const m = (lo + hi) >> 1; if (wn[m] < midi) lo = m + 1; else hi = m; }
                return lo;
            };
            // How many white-key slots does the W–G–W–G pattern occupy for
            // a hand with nf fingers? Only the white fingers (ceil(nf/2)) need
            // reserved space; trailing gap slots for even nf sit in the neutral
            // zone between hands and do not require an extra slot.
            const slotsOf = (h) => Math.ceil(h.nf / 2);
            // MIDI note of the first white key that doesn't overlap with hand h.
            const minNextAnchor = (h) => {
                const ni = lowerBound(h.anchor) + slotsOf(h);
                return ni < wn.length ? wn[ni] : rangeMax + 1;
            };
            // Max anchor for hand h so its visual extent fits before rightBoundaryMidi.
            const maxAnchorBefore = (h, rightBoundaryMidi) => {
                const startIdx = lowerBound(rightBoundaryMidi) - slotsOf(h);
                return startIdx >= 0 ? wn[startIdx] : rangeMin;
            };

            // Push right neighbours rightward.
            for (let i = movedIdx; i < sorted.length - 1; i++) {
                const minRight = minNextAnchor(sorted[i]);
                if (sorted[i + 1].anchor < minRight) {
                    sorted[i + 1].anchor = Math.min(rangeMax, minRight);
                    this._handCurrentAnchors.set(sorted[i + 1].id, sorted[i + 1].anchor);
                } else break;
            }
            // Push left neighbours leftward.
            for (let i = movedIdx; i > 0; i--) {
                const maxLeft = maxAnchorBefore(sorted[i - 1], sorted[i].anchor);
                if (sorted[i - 1].anchor > maxLeft) {
                    sorted[i - 1].anchor = Math.max(rangeMin, maxLeft);
                    this._handCurrentAnchors.set(sorted[i - 1].id, sorted[i - 1].anchor);
                } else break;
            }
        } else {
            // Chromatic: semitone-granularity boundaries.
            for (let i = movedIdx; i < sorted.length - 1; i++) {
                const minRight = sorted[i].anchor + sorted[i].span + 1;
                if (sorted[i + 1].anchor < minRight) {
                    sorted[i + 1].anchor = Math.min(rangeMax - sorted[i + 1].span, minRight);
                    this._handCurrentAnchors.set(sorted[i + 1].id, sorted[i + 1].anchor);
                } else break;
            }
            for (let i = movedIdx; i > 0; i--) {
                const maxLeft = sorted[i].anchor - sorted[i - 1].span - 1;
                if (sorted[i - 1].anchor > maxLeft) {
                    sorted[i - 1].anchor = Math.max(rangeMin, maxLeft);
                    this._handCurrentAnchors.set(sorted[i - 1].id, sorted[i - 1].anchor);
                } else break;
            }
        }
    };

    /**
     * Attach pointer-event drag handlers to the km-hand-band element so the user
     * can reposition hands by clicking and dragging in the visible band area.
     * The canvas itself has pointer-events:none so piano-key clicks are unaffected.
     * Range is read live from this.startNote / this.visibleNoteCount so the drag
     * stays correct after octave scrolls without requiring a handler rebuild.
     */
    KeyboardPianoMixin._initFingersOverlayDrag = function() {
        this._destroyFingersOverlayDrag();

        const canvas = this._fingersCanvas;
        const band   = document.getElementById('km-hand-band');
        if (!canvas || !band) return;

        // For piano layout the canvas has a 10 px left inset; mouse X coordinates
        // relative to the band must be adjusted to match the canvas coordinate space.
        const canvasInset = parseFloat(canvas.style.left) || 0;

        // Capture range at a specific instant (drag-start or hit-test).
        const liveRangeMin = () => this.startNote;
        const liveRangeMax = () => this.startNote + this.visibleNoteCount - 1;

        let drag = null;   // { handId, startX, startAnchor, span, rangeMin, rangeMax }

        const hitTestHand = (xInCanvas) => {
            if (!this._fingersHands || !this._handCurrentAnchors) return null;
            const W = canvas.clientWidth;
            if (W <= 0) return null;

            let best = null;
            let bestDist = Infinity;

            if (this._fingersLayout === 'piano'
                    && this.visibleWhiteNotes && this.visibleWhiteNotes.length > 0) {
                // Piano: hit-test in white-key pixel space so the touch target
                // matches the actual visual extent of each hand.
                const wn = this.visibleWhiteNotes;
                const ww = W / wn.length;
                for (const hand of this._fingersHands) {
                    const anchor = this._handCurrentAnchors.get(hand.id);
                    if (!Number.isFinite(anchor)) continue;
                    const numWhites = Math.ceil((hand.numFingers || 5) / 2);
                    let si = wn.indexOf(anchor);
                    if (si < 0) si = wn.findIndex(m => m >= anchor);
                    if (si < 0) continue;
                    const ei  = Math.min(wn.length - 1, si + numWhites - 1);
                    const lPx = si * ww;
                    const rPx = (ei + 1) * ww;
                    if (xInCanvas >= lPx - 8 && xInCanvas <= rPx + 8) {
                        const dist = Math.abs(xInCanvas - (lPx + rPx) * 0.5);
                        if (dist < bestDist) { bestDist = dist; best = hand; }
                    }
                }
            } else {
                // Chromatic: semitone-based pixel extent.
                const rMin = liveRangeMin();
                const rMax = liveRangeMax();
                const pxPerSt = W / Math.max(1, rMax - rMin + 1);
                for (const hand of this._fingersHands) {
                    const anchor = this._handCurrentAnchors.get(hand.id);
                    if (!Number.isFinite(anchor)) continue;
                    const lPx = (anchor - rMin) * pxPerSt;
                    const rPx = (anchor + hand.span - rMin + 1) * pxPerSt;
                    if (xInCanvas >= lPx - 12 && xInCanvas <= rPx + 12) {
                        const dist = Math.abs(xInCanvas - (lPx + rPx) * 0.5);
                        if (dist < bestDist) { bestDist = dist; best = hand; }
                    }
                }
            }
            return best ? best.id : null;
        };

        const onDown = (e) => {
            if (!this._fingersHands) return;
            const rect = band.getBoundingClientRect();
            const xInCanvas = (e.clientX - rect.left) - canvasInset;
            const handId = hitTestHand(xInCanvas);
            if (!handId) return;
            const hand = this._fingersHands.find(h => h.id === handId);
            if (!hand) return;
            const startAnchor = this._handCurrentAnchors.get(handId);
            // Pre-compute the anchor's white-key index for delta dragging in piano mode.
            let startWhiteIdx = -1;
            if (this._fingersLayout === 'piano' && this.visibleWhiteNotes) {
                const wn = this.visibleWhiteNotes;
                startWhiteIdx = wn.indexOf(startAnchor);
                if (startWhiteIdx < 0) startWhiteIdx = wn.findIndex(m => m >= startAnchor);
            }
            drag = {
                handId, startX: xInCanvas,
                startAnchor, startWhiteIdx,
                span: hand.span,
                rangeMin: liveRangeMin(), rangeMax: liveRangeMax(),
            };
            band.setPointerCapture(e.pointerId);
            e.stopPropagation();
            e.preventDefault();
        };

        const onMove = (e) => {
            if (!drag || !this._fingersRenderer) return;
            const W = canvas.clientWidth;
            if (W <= 0) return;
            const rect = band.getBoundingClientRect();
            const xInCanvas = (e.clientX - rect.left) - canvasInset;
            let newAnchor;
            if (this._fingersLayout === 'piano'
                    && this.visibleWhiteNotes && this.visibleWhiteNotes.length > 0
                    && drag.startWhiteIdx >= 0) {
                // Piano: delta from grab point in white-key units → snap to white key.
                const wn = this.visibleWhiteNotes;
                const ww = W / wn.length;
                const deltaWhite = Math.round((xInCanvas - drag.startX) / ww);
                const newIdx = Math.max(0, Math.min(wn.length - 1, drag.startWhiteIdx + deltaWhite));
                const rawAnchor = wn[newIdx];
                newAnchor = Math.max(drag.rangeMin,
                    Math.min(drag.rangeMax - drag.span, rawAnchor));
            } else {
                // Chromatic: semitone-granularity delta drag.
                const semitones = Math.max(1, drag.rangeMax - drag.rangeMin + 1);
                const pxPerSt = W / semitones;
                const deltaSt = Math.round((xInCanvas - drag.startX) / pxPerSt);
                newAnchor = Math.max(drag.rangeMin,
                    Math.min(drag.rangeMax - drag.span, drag.startAnchor + deltaSt));
            }
            this._handCurrentAnchors.set(drag.handId, newAnchor);
            this._resolveHandCollisions(drag.handId);
            this._fingersRenderer.setAnchors(this._handCurrentAnchors);
            this._fingersRenderer.draw();
            this._positionHandArrows();
            e.stopPropagation();
        };

        const onUp = (e) => {
            if (!drag) return;
            drag = null;
            e.stopPropagation();
        };

        band.addEventListener('pointerdown', onDown);
        band.addEventListener('pointermove', onMove);
        band.addEventListener('pointerup', onUp);
        band.addEventListener('pointercancel', onUp);

        this._fingersOverlayDragCleanup = () => {
            band.removeEventListener('pointerdown', onDown);
            band.removeEventListener('pointermove', onMove);
            band.removeEventListener('pointerup', onUp);
            band.removeEventListener('pointercancel', onUp);
        };
    };

    /**
     * Create (or recreate) the decorative arrow indicators for each hand inside
     * km-hand-band. The ◄ and ► glyphs are purely visual hints that the hand
     * can be dragged; they carry no interactive behaviour.
     */
    KeyboardPianoMixin._renderHandArrows = function() {
        const band = document.getElementById('km-hand-band');
        if (!band || !this._fingersHands) return;

        band.querySelectorAll('.km-hand-arrows').forEach(el => el.remove());

        for (const hand of this._fingersHands) {
            const el = document.createElement('div');
            el.className = 'km-hand-arrows';
            el.dataset.handId = hand.id;
            el.innerHTML =
                `<span class="km-hand-arrow">◄</span>` +
                `<span class="km-hand-label" style="color:${hand.color}">${hand.id}</span>` +
                `<span class="km-hand-arrow">►</span>`;
            band.appendChild(el);
        }

        this._positionHandArrows();
    };

    /**
     * Reposition each arrow group so it stays centred on its hand's current
     * pixel location inside km-hand-band. Call after any anchor change or resize.
     */
    KeyboardPianoMixin._positionHandArrows = function() {
        const band = document.getElementById('km-hand-band');
        if (!band || !this._fingersHands || !this._handCurrentAnchors) return;
        const canvas = this._fingersCanvas;
        if (!canvas) return;

        const W = canvas.clientWidth;
        if (W <= 0) return;
        const canvasLeft = parseFloat(canvas.style.left) || 0;

        for (const hand of this._fingersHands) {
            const el = band.querySelector(`.km-hand-arrows[data-hand-id="${hand.id}"]`);
            if (!el) continue;
            const anchor = this._handCurrentAnchors.get(hand.id);
            if (!Number.isFinite(anchor)) continue;

            let centerX;
            if (this._fingersLayout === 'piano'
                    && this.visibleWhiteNotes && this.visibleWhiteNotes.length > 0) {
                const wn = this.visibleWhiteNotes;
                const ww = W / wn.length;
                let si = wn.indexOf(anchor);
                if (si < 0) si = wn.findIndex(m => m >= anchor);
                if (si < 0) si = 0;
                const numWhites = Math.ceil((hand.numFingers || 5) / 2);
                const ei = Math.min(wn.length - 1, si + numWhites - 1);
                centerX = (si + (ei - si + 1) * 0.5) * ww;
            } else {
                const rMin = this.startNote;
                const rMax = this.startNote + this.visibleNoteCount - 1;
                const pxPerSt = W / Math.max(1, rMax - rMin + 1);
                centerX = (anchor - rMin + (Number.isFinite(hand.span) ? hand.span : 0) * 0.5) * pxPerSt;
            }

            el.style.left = `${canvasLeft + centerX}px`;
            el.style.transform = 'translateX(-50%)';
        }
    };

    /**
     * Remove pointer-event drag handlers from the fingers canvas.
     */
    KeyboardPianoMixin._destroyFingersOverlayDrag = function() {
        if (this._fingersOverlayDragCleanup) {
            this._fingersOverlayDragCleanup();
            this._fingersOverlayDragCleanup = null;
        }
    };
})();
