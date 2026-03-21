// ============================================================================
// Fichier: public/js/views/components/StringInstrumentConfigModal.js
// Description: Modal for configuring string instruments (guitar, bass, etc.)
//   Allows selecting tuning presets or custom tuning, number of strings/frets,
//   fretless mode, and capo position. Saves via WebSocket API.
//   Features a visual mini-piano for tuning each string.
// ============================================================================

class StringInstrumentConfigModal extends BaseModal {
    /**
     * @param {Object} api - WebSocket API client
     * @param {Object} [options]
     * @param {string} [options.deviceId] - Device ID to configure
     * @param {number} [options.channel] - MIDI channel (0-15)
     * @param {Function} [options.onSave] - Callback after successful save
     */
    constructor(api, options = {}) {
        super({
            id: 'string-instrument-config-modal',
            size: 'lg',
            title: 'stringInstrument.title'
        });

        this.api = api;
        this.deviceId = options.deviceId || null;
        this.channel = options.channel || 0;
        this.onSave = options.onSave || null;

        // Current form state
        this.config = {
            instrument_name: 'Guitar',
            num_strings: 6,
            num_frets: 24,
            tuning: [40, 45, 50, 55, 59, 64],
            is_fretless: false,
            capo_fret: 0,
            cc_enabled: true,
            tab_algorithm: 'min_movement'
        };

        this.presets = {};
        this.existingId = null;

        // Piano constants
        this.NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        this.PIANO_RANGE_LOW = 24;   // C1
        this.PIANO_RANGE_HIGH = 96;  // C7
    }

    /**
     * Open the modal for a device/channel, loading existing config if any
     * @param {string} deviceId
     * @param {number} channel
     */
    async showForDevice(deviceId, channel) {
        this.deviceId = deviceId;
        this.channel = channel;

        // Load presets
        try {
            const resp = await this.api.sendCommand('string_instrument_get_presets', {});
            if (resp && resp.presets) {
                this.presets = resp.presets;
            }
        } catch (e) {
            console.warn('Failed to load tuning presets:', e);
        }

        // Load existing config
        try {
            const resp = await this.api.sendCommand('string_instrument_get', {
                device_id: deviceId,
                channel: channel
            });
            if (resp && resp.instrument) {
                this.existingId = resp.instrument.id;
                this.config = {
                    instrument_name: resp.instrument.instrument_name || 'Guitar',
                    num_strings: resp.instrument.num_strings || 6,
                    num_frets: resp.instrument.num_frets || 24,
                    tuning: resp.instrument.tuning || [40, 45, 50, 55, 59, 64],
                    is_fretless: !!resp.instrument.is_fretless,
                    capo_fret: resp.instrument.capo_fret || 0,
                    cc_enabled: resp.instrument.cc_enabled !== undefined ? !!resp.instrument.cc_enabled : true,
                    tab_algorithm: resp.instrument.tab_algorithm || 'min_movement'
                };
            }
        } catch (e) {
            // No existing config, use defaults
        }

        this.open();
    }

    // ========================================================================
    // HELPERS
    // ========================================================================

    _noteName(midi) {
        const name = this.NOTE_NAMES[midi % 12];
        const octave = Math.floor(midi / 12) - 1;
        return `${name}${octave}`;
    }

    _isBlackKey(midi) {
        const n = midi % 12;
        return [1, 3, 6, 8, 10].includes(n);
    }

    // ========================================================================
    // RENDER
    // ========================================================================

    renderBody() {
        const c = this.config;

        // Build preset options
        let presetOptions = `<option value="">${this.t('stringInstrument.customTuning')}</option>`;
        const currentPresetKey = this._findMatchingPreset();
        for (const [key, preset] of Object.entries(this.presets)) {
            const selected = key === currentPresetKey ? 'selected' : '';
            const label = this.t(`stringInstrument.presets.${key}`) !== `stringInstrument.presets.${key}`
                ? this.t(`stringInstrument.presets.${key}`)
                : preset.name;
            presetOptions += `<option value="${this.escape(key)}" ${selected}>${this.escape(label)}</option>`;
        }

        // Build visual tuning rows with mini-piano for each string
        const tuningRows = c.tuning.map((note, i) => {
            const noteName = this._noteName(note);
            const stringNum = i + 1;
            const stringLabel = `${this.t('stringInstrument.string')} ${stringNum}`;
            return `
                <div class="si-string-row" data-string="${i}">
                    <div class="si-string-label">
                        <span class="si-string-num">${stringNum}</span>
                        <span class="si-string-note-badge" id="si-badge-${i}">${noteName}</span>
                    </div>
                    <div class="si-piano-wrapper">
                        <button class="si-piano-nav si-piano-nav-left" data-string="${i}" data-dir="-1" title="${this.t('stringInstrument.lowerOctave')}">&#9664;</button>
                        <div class="si-mini-piano" id="si-piano-${i}" data-string="${i}">
                            ${this._renderMiniPiano(note, i)}
                        </div>
                        <button class="si-piano-nav si-piano-nav-right" data-string="${i}" data-dir="1" title="${this.t('stringInstrument.higherOctave')}">&#9654;</button>
                    </div>
                    <div class="si-string-midi">
                        <input type="number" class="si-input si-tuning-input" data-string="${i}"
                               value="${note}" min="0" max="127" title="${this.t('stringInstrument.note')} MIDI ${note}">
                    </div>
                </div>`;
        }).join('');

        const ccLabel = this.t('stringInstrument.ccEnabled');
        const ccCollapsedClass = c.cc_enabled ? '' : 'si-collapsed';

        return `
            <div class="si-config-form">
                <div class="si-top-row">
                    <div class="si-field si-field-grow">
                        <label for="si-name">${this.t('stringInstrument.name')}</label>
                        <input type="text" id="si-name" class="si-input" value="${this.escape(c.instrument_name)}">
                    </div>
                    <div class="si-field">
                        <label for="si-preset">${this.t('stringInstrument.tuningPreset')}</label>
                        <select id="si-preset" class="si-input">${presetOptions}</select>
                    </div>
                </div>

                <div class="si-cc-toggle-row">
                    <div class="si-field si-checkbox-field">
                        <input type="checkbox" id="si-cc-enabled" ${c.cc_enabled ? 'checked' : ''}>
                        <label for="si-cc-enabled">${ccLabel}</label>
                    </div>
                    <div class="si-field si-algo-field">
                        <label for="si-algorithm">${this.t('stringInstrument.algorithm')}</label>
                        <select id="si-algorithm" class="si-input">
                            <option value="min_movement" ${c.tab_algorithm === 'min_movement' ? 'selected' : ''}>${this.t('tablature.algoMinMovement')}</option>
                            <option value="lowest_fret" ${c.tab_algorithm === 'lowest_fret' ? 'selected' : ''}>${this.t('tablature.algoLowestFret')}</option>
                            <option value="highest_fret" ${c.tab_algorithm === 'highest_fret' ? 'selected' : ''}>${this.t('tablature.algoHighestFret')}</option>
                            <option value="zone" ${c.tab_algorithm === 'zone' ? 'selected' : ''}>${this.t('tablature.algoZone')}</option>
                        </select>
                    </div>
                </div>

                <div class="si-details-section ${ccCollapsedClass}" id="si-details-section">
                    <div class="si-params-row">
                        <div class="si-field">
                            <label for="si-strings">${this.t('stringInstrument.numStrings')}</label>
                            <input type="number" id="si-strings" class="si-input si-input-sm" value="${c.num_strings}" min="1" max="12">
                        </div>
                        <div class="si-field">
                            <label for="si-frets">${this.t('stringInstrument.numFrets')}</label>
                            <input type="number" id="si-frets" class="si-input si-input-sm" value="${c.num_frets}" min="0" max="36"
                                   ${c.is_fretless ? 'disabled' : ''}>
                        </div>
                        <div class="si-field si-checkbox-field">
                            <input type="checkbox" id="si-fretless" ${c.is_fretless ? 'checked' : ''}>
                            <label for="si-fretless">${this.t('stringInstrument.isFretless')}</label>
                        </div>
                        <div class="si-field">
                            <label for="si-capo">${this.t('stringInstrument.capoFret')}</label>
                            <input type="number" id="si-capo" class="si-input si-input-sm" value="${c.capo_fret}" min="0" max="36">
                        </div>
                    </div>

                    <div class="si-tuning-section">
                        <label class="si-section-title">${this.t('stringInstrument.tuning')}</label>
                        <div class="si-tuning-visual" id="si-tuning-visual">
                            ${tuningRows}
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Render a mini-piano keyboard centered on the selected note
     * Shows 2 octaves (24 keys) centered on the current note
     */
    _renderMiniPiano(selectedNote, stringIndex) {
        // Show 2 octaves centered around the note
        const centerOctaveStart = Math.floor(selectedNote / 12) * 12;
        const rangeStart = Math.max(0, centerOctaveStart - 12);
        const rangeEnd = Math.min(127, centerOctaveStart + 24);

        let html = '';
        for (let midi = rangeStart; midi < rangeEnd; midi++) {
            const isBlack = this._isBlackKey(midi);
            const isSelected = midi === selectedNote;
            const noteName = this._noteName(midi);
            const isC = midi % 12 === 0;

            const classes = [
                'si-pk',
                isBlack ? 'si-pk-black' : 'si-pk-white',
                isSelected ? 'si-pk-selected' : ''
            ].filter(Boolean).join(' ');

            html += `<div class="${classes}" data-midi="${midi}" data-string="${stringIndex}" title="${noteName} (${midi})">`;
            if (isSelected) {
                html += `<span class="si-pk-label">${noteName}</span>`;
            } else if (isC && !isBlack) {
                html += `<span class="si-pk-c-label">${noteName}</span>`;
            }
            html += `</div>`;
        }
        return html;
    }

    renderFooter() {
        const deleteBtn = this.existingId
            ? `<button class="si-btn si-btn-danger" data-action="si-delete">${this.t('common.delete')}</button>`
            : '';

        return `
            ${deleteBtn}
            <div style="flex:1"></div>
            <button class="si-btn si-btn-secondary" data-action="close">${this.t('common.cancel')}</button>
            <button class="si-btn si-btn-primary" data-action="si-save">${this.t('common.save')}</button>
        `;
    }

    // ========================================================================
    // EVENTS
    // ========================================================================

    onOpen() {
        if (!this.dialog) return;

        // Preset change
        this.$('#si-preset')?.addEventListener('change', (e) => {
            this._applyPreset(e.target.value);
        });

        // Num strings change
        this.$('#si-strings')?.addEventListener('change', (e) => {
            const num = parseInt(e.target.value);
            if (num >= 1 && num <= 12) {
                this.config.num_strings = num;
                this._adjustTuning();
                this._refreshBody();
            }
        });

        // CC enabled toggle
        this.$('#si-cc-enabled')?.addEventListener('change', (e) => {
            this.config.cc_enabled = e.target.checked;
            const section = this.dialog?.querySelector('#si-details-section');
            if (section) {
                section.classList.toggle('si-collapsed', !e.target.checked);
            }
        });

        // Fretless toggle
        this.$('#si-fretless')?.addEventListener('change', (e) => {
            this.config.is_fretless = e.target.checked;
            if (e.target.checked) {
                this.config.num_frets = 0;
            } else if (this.config.num_frets === 0) {
                this.config.num_frets = 24;
            }
            this._refreshBody();
        });

        // Delegate tuning MIDI input changes
        this.dialog.addEventListener('change', (e) => {
            if (e.target.matches('.si-tuning-input')) {
                const idx = parseInt(e.target.dataset.string);
                const val = parseInt(e.target.value);
                if (!isNaN(idx) && !isNaN(val) && val >= 0 && val <= 127) {
                    this.config.tuning[idx] = val;
                    this._refreshStringRow(idx);
                }
            }
        });

        this.dialog.addEventListener('input', (e) => {
            if (e.target.id === 'si-name') {
                this.config.instrument_name = e.target.value;
            } else if (e.target.id === 'si-frets') {
                const v = parseInt(e.target.value);
                if (!isNaN(v) && v >= 0 && v <= 36) this.config.num_frets = v;
            } else if (e.target.id === 'si-capo') {
                const v = parseInt(e.target.value);
                if (!isNaN(v) && v >= 0 && v <= 36) this.config.capo_fret = v;
            } else if (e.target.id === 'si-algorithm') {
                this.config.tab_algorithm = e.target.value;
            }
        });

        // Click on piano keys + octave nav buttons
        this.dialog.addEventListener('click', (e) => {
            const action = e.target.closest('[data-action]')?.dataset.action;
            if (action === 'si-save') { this._save(); return; }
            if (action === 'si-delete') { this._delete(); return; }

            // Piano key click
            const key = e.target.closest('.si-pk');
            if (key) {
                const midi = parseInt(key.dataset.midi);
                const strIdx = parseInt(key.dataset.string);
                if (!isNaN(midi) && !isNaN(strIdx)) {
                    this.config.tuning[strIdx] = midi;
                    this._refreshStringRow(strIdx);
                    // Update MIDI input
                    const input = this.dialog.querySelector(`.si-tuning-input[data-string="${strIdx}"]`);
                    if (input) input.value = midi;
                }
                return;
            }

            // Octave navigation
            const navBtn = e.target.closest('.si-piano-nav');
            if (navBtn) {
                const strIdx = parseInt(navBtn.dataset.string);
                const dir = parseInt(navBtn.dataset.dir);
                if (!isNaN(strIdx) && !isNaN(dir)) {
                    const newNote = Math.max(0, Math.min(127, this.config.tuning[strIdx] + dir * 12));
                    this.config.tuning[strIdx] = newNote;
                    this._refreshStringRow(strIdx);
                    const input = this.dialog.querySelector(`.si-tuning-input[data-string="${strIdx}"]`);
                    if (input) input.value = newNote;
                }
                return;
            }
        });
    }

    // ========================================================================
    // PRESET
    // ========================================================================

    _applyPreset(presetKey) {
        if (!presetKey || !this.presets[presetKey]) return;

        const preset = this.presets[presetKey];
        this.config.num_strings = preset.strings;
        this.config.num_frets = preset.frets;
        this.config.tuning = [...preset.tuning];
        this.config.is_fretless = !!preset.fretless;
        this.config.instrument_name = preset.name.split('(')[0].trim();

        this._refreshBody();
    }

    _findMatchingPreset() {
        for (const [key, preset] of Object.entries(this.presets)) {
            if (preset.strings === this.config.num_strings &&
                preset.tuning.length === this.config.tuning.length &&
                preset.tuning.every((n, i) => n === this.config.tuning[i])) {
                return key;
            }
        }
        return '';
    }

    // ========================================================================
    // TUNING HELPERS
    // ========================================================================

    _adjustTuning() {
        const target = this.config.num_strings;
        while (this.config.tuning.length < target) {
            const last = this.config.tuning[this.config.tuning.length - 1] || 40;
            this.config.tuning.push(Math.min(127, last + 5));
        }
        while (this.config.tuning.length > target) {
            this.config.tuning.pop();
        }
    }

    /**
     * Refresh just one string's piano + badge without full re-render
     */
    _refreshStringRow(strIdx) {
        const note = this.config.tuning[strIdx];

        // Update badge
        const badge = this.dialog?.querySelector(`#si-badge-${strIdx}`);
        if (badge) badge.textContent = this._noteName(note);

        // Update mini piano
        const pianoContainer = this.dialog?.querySelector(`#si-piano-${strIdx}`);
        if (pianoContainer) {
            pianoContainer.innerHTML = this._renderMiniPiano(note, strIdx);
        }
    }

    _refreshBody() {
        const body = this.$('.modal-body');
        if (body) {
            body.innerHTML = this.renderBody();
            // Re-attach specific handlers
            this.$('#si-cc-enabled')?.addEventListener('change', (e) => {
                this.config.cc_enabled = e.target.checked;
                const section = this.dialog?.querySelector('#si-details-section');
                if (section) {
                    section.classList.toggle('si-collapsed', !e.target.checked);
                }
            });
            this.$('#si-preset')?.addEventListener('change', (e) => {
                this._applyPreset(e.target.value);
            });
            this.$('#si-strings')?.addEventListener('change', (e) => {
                const num = parseInt(e.target.value);
                if (num >= 1 && num <= 12) {
                    this.config.num_strings = num;
                    this._adjustTuning();
                    this._refreshBody();
                }
            });
            this.$('#si-fretless')?.addEventListener('change', (e) => {
                this.config.is_fretless = e.target.checked;
                if (e.target.checked) {
                    this.config.num_frets = 0;
                } else if (this.config.num_frets === 0) {
                    this.config.num_frets = 24;
                }
                this._refreshBody();
            });
        }
    }

    // ========================================================================
    // SAVE / DELETE
    // ========================================================================

    async _save() {
        try {
            const data = {
                device_id: this.deviceId,
                channel: this.channel,
                instrument_name: this.config.instrument_name,
                num_strings: this.config.num_strings,
                num_frets: this.config.num_frets,
                tuning: this.config.tuning,
                is_fretless: this.config.is_fretless,
                capo_fret: this.config.capo_fret,
                cc_enabled: this.config.cc_enabled,
                tab_algorithm: this.config.tab_algorithm
            };

            if (this.existingId) {
                data.id = this.existingId;
                await this.api.sendCommand('string_instrument_update', data);
            } else {
                await this.api.sendCommand('string_instrument_create', data);
            }

            if (this.onSave) this.onSave();
            this.close();

        } catch (error) {
            console.error('Failed to save string instrument:', error);
            const body = this.$('.modal-body');
            if (body) {
                const errEl = body.querySelector('.si-error');
                if (errEl) errEl.remove();
                body.insertAdjacentHTML('afterbegin',
                    `<div class="si-error">${this.escape(error.message || this.t('tablature.saveFailed'))}</div>`
                );
            }
        }
    }

    async _delete() {
        if (!this.existingId) return;

        try {
            await this.api.sendCommand('string_instrument_delete', { id: this.existingId });
            this.existingId = null;
            if (this.onSave) this.onSave();
            this.close();
        } catch (error) {
            console.error('Failed to delete string instrument:', error);
        }
    }
}

// ============================================================================
// EXPORT
// ============================================================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = StringInstrumentConfigModal;
}
if (typeof window !== 'undefined') {
    window.StringInstrumentConfigModal = StringInstrumentConfigModal;
}
