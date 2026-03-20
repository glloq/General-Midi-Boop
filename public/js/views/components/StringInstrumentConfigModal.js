// ============================================================================
// Fichier: public/js/views/components/StringInstrumentConfigModal.js
// Description: Modal for configuring string instruments (guitar, bass, etc.)
//   Allows selecting tuning presets or custom tuning, number of strings/frets,
//   fretless mode, and capo position. Saves via WebSocket API.
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
            size: 'md',
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
            capo_fret: 0
        };

        this.presets = {};
        this.existingId = null; // If editing an existing instrument
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
                    capo_fret: resp.instrument.capo_fret || 0
                };
            }
        } catch (e) {
            // No existing config, use defaults
        }

        this.open();
    }

    // ========================================================================
    // RENDER
    // ========================================================================

    renderBody() {
        const c = this.config;
        const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

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

        // Build tuning display
        const tuningDisplay = c.tuning.map((note, i) => {
            const name = noteNames[note % 12];
            const octave = Math.floor(note / 12) - 1;
            return `<div class="si-tuning-note">
                <label>${this.t('stringInstrument.tuning')} ${i + 1}</label>
                <input type="number" class="si-input si-tuning-input" data-string="${i}"
                       value="${note}" min="0" max="127" title="${name}${octave} (MIDI ${note})">
                <span class="si-note-name">${name}${octave}</span>
            </div>`;
        }).join('');

        return `
            <div class="si-config-form">
                <div class="si-field">
                    <label for="si-name">${this.t('stringInstrument.name')}</label>
                    <input type="text" id="si-name" class="si-input" value="${this.escape(c.instrument_name)}">
                </div>

                <div class="si-field">
                    <label for="si-preset">${this.t('stringInstrument.tuningPreset')}</label>
                    <select id="si-preset" class="si-input">${presetOptions}</select>
                </div>

                <div class="si-row">
                    <div class="si-field">
                        <label for="si-strings">${this.t('stringInstrument.numStrings')}</label>
                        <input type="number" id="si-strings" class="si-input" value="${c.num_strings}" min="1" max="6">
                    </div>
                    <div class="si-field">
                        <label for="si-frets">${this.t('stringInstrument.numFrets')}</label>
                        <input type="number" id="si-frets" class="si-input" value="${c.num_frets}" min="0" max="36"
                               ${c.is_fretless ? 'disabled' : ''}>
                    </div>
                </div>

                <div class="si-row">
                    <div class="si-field si-checkbox-field">
                        <input type="checkbox" id="si-fretless" ${c.is_fretless ? 'checked' : ''}>
                        <label for="si-fretless">${this.t('stringInstrument.isFretless')}</label>
                    </div>
                    <div class="si-field">
                        <label for="si-capo">${this.t('stringInstrument.capoFret')}</label>
                        <input type="number" id="si-capo" class="si-input" value="${c.capo_fret}" min="0" max="36">
                    </div>
                </div>

                <div class="si-field">
                    <label>${this.t('stringInstrument.tuning')}</label>
                    <div class="si-tuning-grid" id="si-tuning-grid">
                        ${tuningDisplay}
                    </div>
                </div>
            </div>
        `;
    }

    renderFooter() {
        const deleteBtn = this.existingId
            ? `<button class="si-btn si-btn-danger" data-action="si-delete">${this.t('common.delete') || 'Delete'}</button>`
            : '';

        return `
            ${deleteBtn}
            <div style="flex:1"></div>
            <button class="si-btn si-btn-secondary" data-action="close">${this.t('common.cancel') || 'Cancel'}</button>
            <button class="si-btn si-btn-primary" data-action="si-save">${this.t('common.save') || 'Save'}</button>
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
            if (num >= 1 && num <= 6) {
                this.config.num_strings = num;
                this._adjustTuning();
                this._refreshBody();
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

        // Delegate for tuning inputs, frets, capo, name, save, delete
        this.dialog.addEventListener('change', (e) => {
            if (e.target.matches('.si-tuning-input')) {
                const idx = parseInt(e.target.dataset.string);
                const val = parseInt(e.target.value);
                if (!isNaN(idx) && !isNaN(val) && val >= 0 && val <= 127) {
                    this.config.tuning[idx] = val;
                    this._updateNoteNames();
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
            }
        });

        // Footer buttons
        this.dialog.addEventListener('click', (e) => {
            const action = e.target.closest('[data-action]')?.dataset.action;
            if (action === 'si-save') this._save();
            if (action === 'si-delete') this._delete();
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

    _updateNoteNames() {
        const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        this.$$('.si-tuning-input').forEach((input) => {
            const val = parseInt(input.value);
            const nameEl = input.parentElement.querySelector('.si-note-name');
            if (nameEl && !isNaN(val) && val >= 0 && val <= 127) {
                const name = noteNames[val % 12];
                const octave = Math.floor(val / 12) - 1;
                nameEl.textContent = `${name}${octave}`;
            }
        });
    }

    _refreshBody() {
        const body = this.$('.modal-body');
        if (body) {
            body.innerHTML = this.renderBody();
            // Re-attach preset handler
            this.$('#si-preset')?.addEventListener('change', (e) => {
                this._applyPreset(e.target.value);
            });
            this.$('#si-strings')?.addEventListener('change', (e) => {
                const num = parseInt(e.target.value);
                if (num >= 1 && num <= 6) {
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
                capo_fret: this.config.capo_fret
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
                    `<div class="si-error">${this.escape(error.message || 'Save failed')}</div>`
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
