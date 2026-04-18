/**
 * InstrumentCapabilitiesModal
 *
 * Modal to fill in missing instrument capabilities
 * before auto-assignment.
 */
(function() {
'use strict';

const _t = (key, params) => typeof i18n !== 'undefined' ? i18n.t(key, params) : key;

class InstrumentCapabilitiesModal {
  constructor(apiClient) {
    this.apiClient = apiClient;
    this.modal = null;
    this.incompleteInstruments = [];
    this.currentIndex = 0;
    this.updates = {}; // { instrumentId: { field: value, ... } }
    this.onComplete = null;
    this._escHandler = null;
  }

  /**
   * Show the modal to fill in capabilities
   * @param {Array} incompleteInstruments - List of instruments with missing info
   * @param {Function} onComplete - Callback invoked after completion
   */
  async show(incompleteInstruments, onComplete) {
    this.incompleteInstruments = incompleteInstruments;
    this.currentIndex = 0;
    this.updates = {};
    this.onComplete = onComplete;

    // Create the modal
    this.createModal();

    // Show the first instrument
    this.showInstrument(0);

    // Expose globally for onclick callbacks
    window.instrumentCapabilitiesModalInstance = this;

    // ESC key handler
    this._escHandler = (e) => {
      if (e.key === 'Escape') this.close();
    };
    document.addEventListener('keydown', this._escHandler);
  }

  /**
   * Create the modal's HTML structure
   */
  createModal() {
    const totalCount = this.incompleteInstruments.length;

    const modalHTML = `
      <div class="modal-overlay instrument-capabilities-modal" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 10000; display: flex; align-items: center; justify-content: center;">
        <div class="modal-container" style="background: var(--bg-secondary, white); border-radius: 12px; max-width: 700px; width: 90%; max-height: 90vh; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,0.3);">
          <div class="modal-header" style="padding: 16px 20px; border-bottom: 2px solid var(--border-color, #e5e7eb); background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; position: relative;">
            <h2 style="margin: 0 0 4px 0; font-size: 20px; padding-right: 40px;">${_t('instrumentCapabilities.title')}</h2>
            <p style="margin: 0; opacity: 0.9; font-size: 13px;">
              ${_t('instrumentCapabilities.subtitle')}
            </p>
            <button class="modal-close" onclick="instrumentCapabilitiesModalInstance.close()" style="position: absolute; top: 12px; right: 16px;">
              ×
            </button>
          </div>

          <div id="instrumentCapabilitiesContent" class="modal-body" style="padding: 16px 20px; max-height: 60vh; overflow-y: auto;">
            <!-- Dynamic content -->
          </div>

          <div class="modal-footer" style="display: flex; justify-content: space-between; align-items: center; padding: 12px 20px; border-top: 1px solid var(--border-color, #e5e7eb); background: var(--bg-tertiary, #f9fafb);">
            <div style="color: var(--text-muted, #666); font-size: 13px;">
              <span id="progressText">${_t('instrumentCapabilities.progress', { current: 1, total: totalCount })}</span>
            </div>
            <div style="display: flex; gap: 8px;">
              <button class="btn" onclick="instrumentCapabilitiesModalInstance.skip()" style="min-width: 80px;">
                ${_t('instrumentCapabilities.skip')}
              </button>
              <button class="btn" onclick="instrumentCapabilitiesModalInstance.previous()" id="previousBtn" style="min-width: 80px;">
                ${_t('instrumentCapabilities.previous')}
              </button>
              <button class="btn btn-primary" onclick="instrumentCapabilitiesModalInstance.next()" id="nextBtn" style="min-width: 100px;">
                ${_t('instrumentCapabilities.next')}
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    // Add to the DOM
    const modalElement = document.createElement('div');
    modalElement.innerHTML = modalHTML;
    document.body.appendChild(modalElement);

    this.modal = modalElement;

    // Overlay click to close
    const overlay = modalElement.querySelector('.modal-overlay');
    if (overlay) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) this.close();
      });
    }
  }

  /**
   * Show an instrument to fill in its capabilities
   * @param {number} index
   */
  showInstrument(index) {
    if (index < 0 || index >= this.incompleteInstruments.length) {
      return;
    }

    this.currentIndex = index;
    const validation = this.incompleteInstruments[index];
    const instrument = validation.instrument;

    // Update progress
    const progressText = document.getElementById('progressText');
    if (progressText) {
      progressText.textContent = _t('instrumentCapabilities.progress', { current: index + 1, total: this.incompleteInstruments.length });
    }

    // Enable/disable the buttons
    const previousBtn = document.getElementById('previousBtn');
    const nextBtn = document.getElementById('nextBtn');

    if (previousBtn) {
      previousBtn.disabled = index === 0;
      previousBtn.style.opacity = index === 0 ? '0.5' : '1';
    }

    if (nextBtn) {
      const isLast = index === this.incompleteInstruments.length - 1;
      nextBtn.textContent = isLast ? _t('instrumentCapabilities.complete') : _t('instrumentCapabilities.next');
    }

    // Generate the form
    const content = this.generateInstrumentForm(instrument, validation);

    const contentElement = document.getElementById('instrumentCapabilitiesContent');
    if (contentElement) {
      contentElement.innerHTML = content;

      // Initialize values from updates already made
      this.restoreUpdates(instrument.id);
    }
  }

  /**
   * Generate the HTML form for an instrument
   * @param {Object} instrument
   * @param {Object} validation
   * @returns {string}
   */
  generateInstrumentForm(instrument, validation) {
    return `
      <div style="margin-bottom: 12px; padding: 12px; background: rgba(102, 126, 234, 0.08); border: 2px solid var(--accent-primary, #3b82f6); border-radius: 8px;">
        <h3 style="margin: 0 0 4px 0; color: var(--accent-primary, #1e40af); font-size: 16px;">
          ${escapeHtml(instrument.custom_name || instrument.name)}
        </h3>
        <div style="color: var(--text-muted, #666); font-size: 12px;">
          ${_t('instrumentCapabilities.type')}: ${escapeHtml(instrument.type || _t('common.unknown'))} •
          ${_t('instrumentCapabilities.manufacturer')}: ${escapeHtml(instrument.manufacturer || _t('common.unknown'))}
        </div>
      </div>

      ${validation.missing.length > 0 ? `
        <div style="margin-bottom: 16px;">
          <h4 style="margin: 0 0 10px 0; color: #dc2626; font-size: 14px;">
            ${_t('instrumentCapabilities.requiredFields')}
          </h4>
          ${validation.missing.map(field => this.generateFieldInput(instrument, field, true)).join('')}
        </div>
      ` : ''}

      ${validation.recommended.length > 0 ? `
        <div style="margin-bottom: 16px;">
          <h4 style="margin: 0 0 10px 0; color: #f59e0b; font-size: 14px;">
            ${_t('instrumentCapabilities.recommendedFields')}
          </h4>
          <p style="margin: 0 0 8px 0; color: var(--text-muted, #666); font-size: 12px;">
            ${_t('instrumentCapabilities.recommendedHint')}
          </p>
          ${validation.recommended.map(field => this.generateFieldInput(instrument, field, false)).join('')}
        </div>
      ` : ''}

      ${this.generateDefaultsButton(instrument)}
    `;
  }

  /**
   * Generate a form field based on type
   * @param {Object} instrument
   * @param {Object} field
   * @param {boolean} required
   * @returns {string}
   */
  generateFieldInput(instrument, field, required) {
    const currentValue = instrument[field.field];
    const inputId = `field_${instrument.id}_${field.field}`;

    let inputHTML = '';

    switch (field.type) {
      case 'number':
        inputHTML = `
          <input type="number"
                 id="${inputId}"
                 value="${currentValue !== null && currentValue !== undefined ? currentValue : ''}"
                 onchange="instrumentCapabilitiesModalInstance.updateField('${field.field}', this.value)"
                 style="width: 100%; padding: 8px; border: 1px solid var(--border-color, #d1d5db); border-radius: 6px; font-size: 14px;"
                 ${required ? 'required' : ''}>
        `;
        break;

      case 'note':
        inputHTML = `
          <div style="display: flex; gap: 8px; align-items: center;">
            <input type="number"
                   id="${inputId}"
                   value="${currentValue !== null && currentValue !== undefined ? currentValue : ''}"
                   min="0"
                   max="127"
                   onchange="instrumentCapabilitiesModalInstance.updateField('${field.field}', this.value)"
                   oninput="(function(el){ var n = instrumentCapabilitiesModalInstance.getNoteNameFromMidi(parseInt(el.value)); document.getElementById('${inputId}_name').textContent = n; })(this)"
                   style="flex: 1; padding: 8px; border: 1px solid var(--border-color, #d1d5db); border-radius: 6px; font-size: 14px;"
                   ${required ? 'required' : ''}>
            <span id="${inputId}_name" style="color: var(--text-muted, #666); font-size: 13px; min-width: 50px;">
              ${currentValue !== null && currentValue !== undefined ? this.getNoteNameFromMidi(currentValue) : ''}
            </span>
          </div>
        `;
        break;

      case 'select':
        if (field.field === 'note_selection_mode') {
          inputHTML = `
            <select id="${inputId}"
                    onchange="instrumentCapabilitiesModalInstance.updateField('${field.field}', this.value)"
                    style="width: 100%; padding: 8px; border: 1px solid var(--border-color, #d1d5db); border-radius: 6px; font-size: 14px;"
                    ${required ? 'required' : ''}>
              <option value="">-- ${_t('instrumentCapabilities.select')} --</option>
              <option value="range" ${currentValue === 'range' ? 'selected' : ''}>
                ${_t('instrumentCapabilities.noteSelectionRange')}
              </option>
              <option value="discrete" ${currentValue === 'discrete' ? 'selected' : ''}>
                ${_t('instrumentCapabilities.noteSelectionDiscrete')}
              </option>
            </select>
          `;
        } else if (field.field === 'type') {
          inputHTML = `
            <select id="${inputId}"
                    onchange="instrumentCapabilitiesModalInstance.updateField('${field.field}', this.value)"
                    style="width: 100%; padding: 8px; border: 1px solid var(--border-color, #d1d5db); border-radius: 6px; font-size: 14px;">
              <option value="">-- ${_t('instrumentCapabilities.select')} --</option>
              <option value="keyboard" ${currentValue === 'keyboard' ? 'selected' : ''}>${_t('instrumentCapabilities.typeKeyboard')}</option>
              <option value="synth" ${currentValue === 'synth' ? 'selected' : ''}>${_t('instrumentCapabilities.typeSynth')}</option>
              <option value="drums" ${currentValue === 'drums' ? 'selected' : ''}>${_t('instrumentCapabilities.typeDrums')}</option>
              <option value="bass" ${currentValue === 'bass' ? 'selected' : ''}>${_t('instrumentCapabilities.typeBass')}</option>
              <option value="guitar" ${currentValue === 'guitar' ? 'selected' : ''}>${_t('instrumentCapabilities.typeGuitar')}</option>
              <option value="strings" ${currentValue === 'strings' ? 'selected' : ''}>${_t('instrumentCapabilities.typeStrings')}</option>
              <option value="brass" ${currentValue === 'brass' ? 'selected' : ''}>${_t('instrumentCapabilities.typeBrass')}</option>
              <option value="woodwind" ${currentValue === 'woodwind' ? 'selected' : ''}>${_t('instrumentCapabilities.typeWoodwind')}</option>
              <option value="pad" ${currentValue === 'pad' ? 'selected' : ''}>${_t('instrumentCapabilities.typePad')}</option>
              <option value="sampler" ${currentValue === 'sampler' ? 'selected' : ''}>${_t('instrumentCapabilities.typeSampler')}</option>
              <option value="other" ${currentValue === 'other' ? 'selected' : ''}>${_t('instrumentCapabilities.typeOther')}</option>
            </select>
          `;
        }
        break;

      case 'array': {
        const currentCCs = Array.isArray(currentValue) ? currentValue : [];
        const commonCCs = [
          { value: 1, label: 'CC1 - Modulation' },
          { value: 7, label: 'CC7 - Volume' },
          { value: 10, label: 'CC10 - Pan' },
          { value: 11, label: 'CC11 - Expression' },
          { value: 64, label: 'CC64 - Sustain Pedal' },
          { value: 71, label: 'CC71 - Resonance' },
          { value: 72, label: 'CC72 - Release Time' },
          { value: 73, label: 'CC73 - Attack Time' },
          { value: 74, label: 'CC74 - Brightness' },
          { value: 91, label: 'CC91 - Reverb Depth' },
          { value: 93, label: 'CC93 - Chorus Depth' }
        ];

        inputHTML = `
          <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px;">
            ${commonCCs.map(cc => `
              <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; padding: 6px; border: 1px solid var(--border-color, #e5e7eb); border-radius: 4px; background: var(--bg-tertiary, #f9fafb);">
                <input type="checkbox"
                       value="${cc.value}"
                       ${currentCCs.includes(cc.value) ? 'checked' : ''}
                       onchange="instrumentCapabilitiesModalInstance.updateCCArray('${field.field}', this)"
                       style="cursor: pointer;">
                <span style="font-size: 12px;">${cc.label}</span>
              </label>
            `).join('')}
          </div>
        `;
        break;
      }

      case 'note-array': {
        const currentNotes = Array.isArray(currentValue) ? currentValue.join(', ') : '';
        inputHTML = `
          <textarea id="${inputId}"
                    placeholder="${_t('instrumentCapabilities.noteArrayPlaceholder')}"
                    onchange="instrumentCapabilitiesModalInstance.updateField('${field.field}', this.value)"
                    style="width: 100%; padding: 8px; border: 1px solid var(--border-color, #d1d5db); border-radius: 6px; font-size: 13px; font-family: monospace; min-height: 60px;"
                    ${required ? 'required' : ''}>${currentNotes}</textarea>
          <div style="color: var(--text-muted, #666); font-size: 11px; margin-top: 4px;">
            ${_t('instrumentCapabilities.commonDrums')}
          </div>
        `;
        break;
      }
    }

    return `
      <div style="margin-bottom: 12px;">
        <label style="display: block; margin-bottom: 4px; font-weight: 600; color: #374151; font-size: 13px;">
          ${field.label}
          ${required ? '<span style="color: #dc2626;">*</span>' : `<span style="color: #9ca3af; font-weight: normal;">(${_t('instrumentCapabilities.optional')})</span>`}
        </label>
        ${inputHTML}
      </div>
    `;
  }

  /**
   * Generate the button that applies default values
   * @param {Object} instrument
   * @returns {string}
   */
  generateDefaultsButton(_instrument) {
    return `
      <div style="margin-top: 16px; padding: 12px; background: var(--bg-tertiary, #f9fafb); border: 1px solid var(--border-color, #e5e7eb); border-radius: 8px;">
        <button class="btn"
                onclick="instrumentCapabilitiesModalInstance.applyDefaults()"
                style="width: 100%; margin-bottom: 8px;">
          ${_t('instrumentCapabilities.applyDefaults')}
        </button>
      </div>
    `;
  }

  /**
   * Update a field
   * @param {string} field
   * @param {*} value
   */
  updateField(field, value) {
    const instrument = this.incompleteInstruments[this.currentIndex].instrument;

    if (!this.updates[instrument.id]) {
      this.updates[instrument.id] = {};
    }

    // Process based on type
    if (field === 'selected_notes' && typeof value === 'string') {
      // Convert the string to an array of numbers
      value = value.split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n) && n >= 0 && n <= 127);
    } else if (field === 'gm_program' || field === 'note_range_min' || field === 'note_range_max' || field === 'polyphony') {
      value = parseInt(value);
    }

    this.updates[instrument.id][field] = value;

    // Auto-create string instrument config when type is guitar/bass/strings
    if (field === 'type' && ['guitar', 'bass', 'strings'].includes(value)) {
      this.autoCreateStringInstrument(instrument, value);
    }
  }

  /**
   * Auto-create a string instrument configuration when instrument type is set to guitar/bass/strings
   */
  async autoCreateStringInstrument(instrument, type) {
    const presetMap = {
      guitar: 'guitar_standard',
      bass: 'bass_4_standard',
      strings: 'guitar_standard'
    };

    try {
      // Check if a string instrument already exists for this device
      const existing = await this.apiClient.sendCommand('string_instrument_get', {
        device_id: instrument.id,
        channel: 0
      });

      if (existing && existing.instrument) {
        this._showStringInstrumentBanner(true);
        return;
      }

      // Get preset data
      const presetKey = presetMap[type];
      const presetResponse = await this.apiClient.sendCommand('string_instrument_apply_preset', {
        preset_key: presetKey
      });

      if (presetResponse && presetResponse.preset) {
        const preset = presetResponse.preset;
        await this.apiClient.sendCommand('string_instrument_create', {
          device_id: instrument.id,
          channel: 0,
          instrument_name: preset.name || type,
          num_strings: preset.strings,
          num_frets: preset.frets,
          tuning: preset.tuning,
          is_fretless: preset.fretless || false,
          capo_fret: 0
        });

        this._showStringInstrumentBanner(false);
      }
    } catch (error) {
      console.error('Failed to auto-create string instrument:', error);
    }
  }

  /**
   * Show a notification banner about string instrument configuration
   */
  _showStringInstrumentBanner(alreadyExists) {
    // Remove existing banner if any
    const existing = document.getElementById('string-instrument-banner');
    if (existing) existing.remove();

    const contentElement = document.getElementById('instrumentCapabilitiesContent');
    if (!contentElement) return;

    const message = alreadyExists
      ? _t('stringInstrument.configExists')
      : _t('stringInstrument.configCreated');

    const banner = document.createElement('div');
    banner.id = 'string-instrument-banner';
    banner.style.cssText = 'margin: 8px 0; padding: 10px 14px; background: var(--success-bg, #f0fdf4); border: 1px solid var(--success-border, #86efac); border-radius: 8px; color: var(--success-text, #166534); font-size: 13px;';
    banner.textContent = message;

    contentElement.insertBefore(banner, contentElement.firstChild);
  }

  /**
   * Update the CCs array
   * @param {string} field
   * @param {HTMLInputElement} checkbox
   */
  updateCCArray(field, checkbox) {
    const instrument = this.incompleteInstruments[this.currentIndex].instrument;

    if (!this.updates[instrument.id]) {
      this.updates[instrument.id] = {};
    }

    let currentCCs = this.updates[instrument.id][field] || instrument[field] || [];
    currentCCs = Array.isArray(currentCCs) ? [...currentCCs] : [];

    const ccValue = parseInt(checkbox.value);

    if (checkbox.checked) {
      if (!currentCCs.includes(ccValue)) {
        currentCCs.push(ccValue);
      }
    } else {
      currentCCs = currentCCs.filter(cc => cc !== ccValue);
    }

    this.updates[instrument.id][field] = currentCCs;
  }

  /**
   * Apply the suggested default values
   */
  async applyDefaults() {
    const instrument = this.incompleteInstruments[this.currentIndex].instrument;

    // Ask the server for default values
    try {
      const response = await this.apiClient.sendCommand('get_instrument_defaults', {
        instrumentId: instrument.id,
        type: instrument.type
      });

      if (response && response.defaults) {
        // Apply the defaults
        if (!this.updates[instrument.id]) {
          this.updates[instrument.id] = {};
        }

        Object.assign(this.updates[instrument.id], response.defaults);

        // Refresh the display
        this.showInstrument(this.currentIndex);
      }
    } catch (error) {
      console.error('Failed to get defaults:', error);
      alert(_t('instrumentCapabilities.defaultsFailed'));
    }
  }

  /**
   * Restore previously made updates for an instrument
   * @param {number} instrumentId
   */
  restoreUpdates(instrumentId) {
    if (!this.updates[instrumentId]) {
      return;
    }

    const updates = this.updates[instrumentId];

    for (const [field, value] of Object.entries(updates)) {
      const inputId = `field_${instrumentId}_${field}`;
      const input = document.getElementById(inputId);

      if (input) {
        if (field === 'selected_notes' && Array.isArray(value)) {
          input.value = value.join(', ');
        } else if (input.tagName === 'SELECT') {
          input.value = value;
        } else {
          input.value = value;
        }
      }

      // Handle CC checkboxes (array fields with checkboxes)
      if (Array.isArray(value) && field === 'supported_ccs') {
        const checkboxes = document.querySelectorAll(`input[type="checkbox"][onchange*="'${field}'"]`);
        for (const cb of checkboxes) {
          cb.checked = value.includes(parseInt(cb.value));
        }
      }
    }
  }

  /**
   * Move to the next instrument
   */
  next() {
    if (this.currentIndex < this.incompleteInstruments.length - 1) {
      this.showInstrument(this.currentIndex + 1);
    } else {
      // Last instrument, finish
      this.complete();
    }
  }

  /**
   * Go back to the previous instrument
   */
  previous() {
    if (this.currentIndex > 0) {
      this.showInstrument(this.currentIndex - 1);
    }
  }

  /**
   * Skip the current instrument
   */
  skip() {
    if (this.currentIndex < this.incompleteInstruments.length - 1) {
      this.showInstrument(this.currentIndex + 1);
    } else {
      this.complete();
    }
  }

  /**
   * Finish and save all modifications
   */
  async complete() {
    // Send the updates to the server
    try {
      const response = await this.apiClient.sendCommand('update_instrument_capabilities', {
        updates: this.updates
      });

      if (response && response.success) {
        this.close();

        if (this.onComplete) {
          this.onComplete(this.updates);
        }
      } else {
        alert(_t('instrumentCapabilities.saveFailed') + ': ' + (response?.error || _t('common.unknownError')));
      }
    } catch (error) {
      console.error('Failed to save capabilities:', error);
      alert(_t('instrumentCapabilities.saveFailed'));
    }
  }

  /**
   * Convert a MIDI number to a note name
   * @param {number} midi
   * @returns {string}
   */
  getNoteNameFromMidi(midi) {
    if (isNaN(midi) || midi < 0 || midi > 127) {
      return '';
    }

    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const octave = Math.floor(midi / 12) - 1;
    const noteName = noteNames[midi % 12];

    return `${noteName}${octave}`;
  }

  /**
   * Close the modal
   */
  close() {
    if (this._escHandler) {
      document.removeEventListener('keydown', this._escHandler);
      this._escHandler = null;
    }

    if (this.modal) {
      this.modal.remove();
      this.modal = null;
    }

    if (window.instrumentCapabilitiesModalInstance === this) {
      delete window.instrumentCapabilitiesModalInstance;
    }
  }
}

// Rendre disponible globalement
window.InstrumentCapabilitiesModal = InstrumentCapabilitiesModal;
})();
