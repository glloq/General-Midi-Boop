/**
 * InstrumentCapabilitiesModal
 *
 * Modal pour compléter les capacités manquantes des instruments
 * avant l'auto-assignation.
 */

class InstrumentCapabilitiesModal {
  constructor(apiClient) {
    this.apiClient = apiClient;
    this.modal = null;
    this.incompleteInstruments = [];
    this.currentIndex = 0;
    this.updates = {}; // { instrumentId: { field: value, ... } }
    this.onComplete = null;
  }

  /**
   * Affiche le modal pour compléter les capacités
   * @param {Array} incompleteInstruments - Liste des instruments avec infos manquantes
   * @param {Function} onComplete - Callback appelé après completion
   */
  async show(incompleteInstruments, onComplete) {
    this.incompleteInstruments = incompleteInstruments;
    this.currentIndex = 0;
    this.updates = {};
    this.onComplete = onComplete;

    // Créer le modal
    this.createModal();

    // Afficher le premier instrument
    this.showInstrument(0);

    // Rendre global pour les callbacks onclick
    window.instrumentCapabilitiesModalInstance = this;
  }

  /**
   * Crée la structure HTML du modal
   */
  createModal() {
    const modalHTML = `
      <div class="modal-overlay" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 10000; display: flex; align-items: center; justify-content: center;">
        <div class="modal-container" style="background: white; border-radius: 12px; max-width: 700px; width: 90%; max-height: 90vh; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,0.3);">
          <div class="modal-header" style="padding: 24px; border-bottom: 2px solid #e5e7eb; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white;">
            <h2 style="margin: 0 0 8px 0; font-size: 24px;">⚙️ Complete Instrument Capabilities</h2>
            <p style="margin: 0; opacity: 0.9; font-size: 14px;">
              Some instruments are missing information needed for optimal auto-assignment.
              Please complete the required fields.
            </p>
          </div>

          <div id="instrumentCapabilitiesContent" class="modal-body" style="padding: 24px; max-height: 60vh; overflow-y: auto;">
            <!-- Contenu dynamique -->
          </div>

          <div class="modal-footer" style="display: flex; justify-content: space-between; align-items: center; padding: 20px 24px; border-top: 1px solid #e5e7eb; background: #f9fafb;">
            <div style="color: #666; font-size: 14px;">
              <span id="progressText">Instrument 1 of X</span>
            </div>
            <div style="display: flex; gap: 10px;">
              <button class="button button-secondary" onclick="instrumentCapabilitiesModalInstance.skip()" style="min-width: 100px;">
                Skip
              </button>
              <button class="button button-secondary" onclick="instrumentCapabilitiesModalInstance.previous()" id="previousBtn" style="min-width: 100px;">
                ← Previous
              </button>
              <button class="button button-primary" onclick="instrumentCapabilitiesModalInstance.next()" id="nextBtn" style="min-width: 120px;">
                Next →
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    // Ajouter au DOM
    const modalElement = document.createElement('div');
    modalElement.innerHTML = modalHTML;
    document.body.appendChild(modalElement);

    this.modal = modalElement;
  }

  /**
   * Affiche un instrument pour compléter ses capacités
   * @param {number} index
   */
  showInstrument(index) {
    if (index < 0 || index >= this.incompleteInstruments.length) {
      return;
    }

    this.currentIndex = index;
    const validation = this.incompleteInstruments[index];
    const instrument = validation.instrument;

    // Mettre à jour la progression
    const progressText = document.getElementById('progressText');
    if (progressText) {
      progressText.textContent = `Instrument ${index + 1} of ${this.incompleteInstruments.length}`;
    }

    // Activer/désactiver les boutons
    const previousBtn = document.getElementById('previousBtn');
    const nextBtn = document.getElementById('nextBtn');

    if (previousBtn) {
      previousBtn.disabled = index === 0;
      previousBtn.style.opacity = index === 0 ? '0.5' : '1';
    }

    if (nextBtn) {
      const isLast = index === this.incompleteInstruments.length - 1;
      nextBtn.textContent = isLast ? '✓ Complete' : 'Next →';
    }

    // Générer le formulaire
    const content = this.generateInstrumentForm(instrument, validation);

    const contentElement = document.getElementById('instrumentCapabilitiesContent');
    if (contentElement) {
      contentElement.innerHTML = content;

      // Initialiser les valeurs depuis les updates déjà faits
      this.restoreUpdates(instrument.id);
    }
  }

  /**
   * Génère le formulaire HTML pour un instrument
   * @param {Object} instrument
   * @param {Object} validation
   * @returns {string}
   */
  generateInstrumentForm(instrument, validation) {
    const allFields = [...validation.missing, ...validation.recommended];

    return `
      <div style="margin-bottom: 20px; padding: 16px; background: #f0f7ff; border: 2px solid #3b82f6; border-radius: 8px;">
        <h3 style="margin: 0 0 8px 0; color: #1e40af; font-size: 18px;">
          ${instrument.custom_name || instrument.name}
        </h3>
        <div style="color: #666; font-size: 13px;">
          Type: ${instrument.type || 'Unknown'} •
          Manufacturer: ${instrument.manufacturer || 'Unknown'}
        </div>
      </div>

      ${validation.missing.length > 0 ? `
        <div style="margin-bottom: 24px;">
          <h4 style="margin: 0 0 16px 0; color: #dc2626; font-size: 16px;">
            ⚠️ Required Fields
          </h4>
          ${validation.missing.map(field => this.generateFieldInput(instrument, field, true)).join('')}
        </div>
      ` : ''}

      ${validation.recommended.length > 0 ? `
        <div style="margin-bottom: 24px;">
          <h4 style="margin: 0 0 16px 0; color: #f59e0b; font-size: 16px;">
            💡 Recommended Fields
          </h4>
          <p style="margin: 0 0 12px 0; color: #666; font-size: 13px;">
            These fields improve auto-assignment quality but are not required.
          </p>
          ${validation.recommended.map(field => this.generateFieldInput(instrument, field, false)).join('')}
        </div>
      ` : ''}

      ${this.generateDefaultsButton(instrument)}
    `;
  }

  /**
   * Génère un champ de formulaire selon le type
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
                 style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px;"
                 ${required ? 'required' : ''}>
        `;
        break;

      case 'note':
        inputHTML = `
          <div style="display: flex; gap: 10px; align-items: center;">
            <input type="number"
                   id="${inputId}"
                   value="${currentValue !== null && currentValue !== undefined ? currentValue : ''}"
                   min="0"
                   max="127"
                   onchange="instrumentCapabilitiesModalInstance.updateField('${field.field}', this.value)"
                   style="flex: 1; padding: 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px;"
                   ${required ? 'required' : ''}>
            <span id="${inputId}_name" style="color: #666; font-size: 13px; min-width: 60px;">
              ${currentValue !== null && currentValue !== undefined ? this.getNoteNameFromMidi(currentValue) : ''}
            </span>
          </div>
          <script>
            document.getElementById('${inputId}').addEventListener('input', function(e) {
              const noteName = instrumentCapabilitiesModalInstance.getNoteNameFromMidi(parseInt(e.target.value));
              document.getElementById('${inputId}_name').textContent = noteName;
            });
          </script>
        `;
        break;

      case 'select':
        if (field.field === 'note_selection_mode') {
          inputHTML = `
            <select id="${inputId}"
                    onchange="instrumentCapabilitiesModalInstance.updateField('${field.field}', this.value)"
                    style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px;"
                    ${required ? 'required' : ''}>
              <option value="">-- Select --</option>
              <option value="continuous" ${currentValue === 'continuous' ? 'selected' : ''}>
                Continuous (melodic instruments)
              </option>
              <option value="discrete" ${currentValue === 'discrete' ? 'selected' : ''}>
                Discrete (drums, pads)
              </option>
            </select>
          `;
        } else if (field.field === 'type') {
          inputHTML = `
            <select id="${inputId}"
                    onchange="instrumentCapabilitiesModalInstance.updateField('${field.field}', this.value)"
                    style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px;">
              <option value="">-- Select --</option>
              <option value="keyboard" ${currentValue === 'keyboard' ? 'selected' : ''}>Keyboard / Piano</option>
              <option value="synth" ${currentValue === 'synth' ? 'selected' : ''}>Synthesizer</option>
              <option value="drums" ${currentValue === 'drums' ? 'selected' : ''}>Drums / Percussion</option>
              <option value="bass" ${currentValue === 'bass' ? 'selected' : ''}>Bass</option>
              <option value="guitar" ${currentValue === 'guitar' ? 'selected' : ''}>Guitar</option>
              <option value="strings" ${currentValue === 'strings' ? 'selected' : ''}>Strings</option>
              <option value="brass" ${currentValue === 'brass' ? 'selected' : ''}>Brass</option>
              <option value="woodwind" ${currentValue === 'woodwind' ? 'selected' : ''}>Woodwind</option>
              <option value="pad" ${currentValue === 'pad' ? 'selected' : ''}>Pad / Atmosphere</option>
              <option value="sampler" ${currentValue === 'sampler' ? 'selected' : ''}>Sampler</option>
              <option value="other" ${currentValue === 'other' ? 'selected' : ''}>Other</option>
            </select>
          `;
        }
        break;

      case 'array':
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
          <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;">
            ${commonCCs.map(cc => `
              <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; padding: 8px; border: 1px solid #e5e7eb; border-radius: 4px; background: #f9fafb;">
                <input type="checkbox"
                       value="${cc.value}"
                       ${currentCCs.includes(cc.value) ? 'checked' : ''}
                       onchange="instrumentCapabilitiesModalInstance.updateCCArray('${field.field}', this)"
                       style="cursor: pointer;">
                <span style="font-size: 13px;">${cc.label}</span>
              </label>
            `).join('')}
          </div>
        `;
        break;

      case 'note-array':
        const currentNotes = Array.isArray(currentValue) ? currentValue.join(', ') : '';
        inputHTML = `
          <textarea id="${inputId}"
                    placeholder="Enter MIDI note numbers separated by commas (e.g., 36, 38, 42, 46, 48)"
                    onchange="instrumentCapabilitiesModalInstance.updateField('${field.field}', this.value)"
                    style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; font-family: monospace; min-height: 80px;"
                    ${required ? 'required' : ''}>${currentNotes}</textarea>
          <div style="color: #666; font-size: 12px; margin-top: 4px;">
            Common drums: 36 (Kick), 38 (Snare), 42 (Closed HH), 46 (Open HH), 48 (Tom1), 50 (Tom2)
          </div>
        `;
        break;
    }

    return `
      <div style="margin-bottom: 16px;">
        <label style="display: block; margin-bottom: 6px; font-weight: 600; color: #374151; font-size: 14px;">
          ${field.label}
          ${required ? '<span style="color: #dc2626;">*</span>' : '<span style="color: #9ca3af; font-weight: normal;">(optional)</span>'}
        </label>
        ${inputHTML}
      </div>
    `;
  }

  /**
   * Génère le bouton pour appliquer les valeurs par défaut
   * @param {Object} instrument
   * @returns {string}
   */
  generateDefaultsButton(instrument) {
    return `
      <div style="margin-top: 24px; padding: 16px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px;">
        <button class="button button-secondary"
                onclick="instrumentCapabilitiesModalInstance.applyDefaults()"
                style="width: 100%; margin-bottom: 10px;">
          ✨ Apply Suggested Defaults
        </button>
        <button class="button button-info"
                onclick="instrumentCapabilitiesModalInstance.openFullSettings(${instrument.id})"
                style="width: 100%;">
          ⚙️ Open Full Instrument Settings
        </button>
        <div style="color: #666; font-size: 12px; margin-top: 8px; text-align: center;">
          Access advanced configuration, latency settings, and more
        </div>
      </div>
    `;
  }

  /**
   * Met à jour un champ
   * @param {string} field
   * @param {*} value
   */
  updateField(field, value) {
    const instrument = this.incompleteInstruments[this.currentIndex].instrument;

    if (!this.updates[instrument.id]) {
      this.updates[instrument.id] = {};
    }

    // Traiter selon le type
    if (field === 'selected_notes' && typeof value === 'string') {
      // Convertir la string en array de nombres
      value = value.split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n) && n >= 0 && n <= 127);
    } else if (field === 'gm_program' || field === 'note_range_min' || field === 'note_range_max' || field === 'polyphony') {
      value = parseInt(value);
    }

    this.updates[instrument.id][field] = value;
  }

  /**
   * Met à jour l'array de CCs
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
   * Applique les valeurs par défaut suggérées
   */
  async applyDefaults() {
    const instrument = this.incompleteInstruments[this.currentIndex].instrument;

    // Demander au serveur les valeurs par défaut
    try {
      const response = await this.apiClient.sendCommand('get_instrument_defaults', {
        instrumentId: instrument.id,
        type: instrument.type
      });

      if (response && response.defaults) {
        // Appliquer les défaults
        if (!this.updates[instrument.id]) {
          this.updates[instrument.id] = {};
        }

        Object.assign(this.updates[instrument.id], response.defaults);

        // Rafraîchir l'affichage
        this.showInstrument(this.currentIndex);
      }
    } catch (error) {
      console.error('Failed to get defaults:', error);
      alert('Failed to load suggested defaults');
    }
  }

  /**
   * Restaure les mises à jour déjà faites pour un instrument
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
        } else {
          input.value = value;
        }
      }
    }
  }

  /**
   * Passe à l'instrument suivant
   */
  next() {
    if (this.currentIndex < this.incompleteInstruments.length - 1) {
      this.showInstrument(this.currentIndex + 1);
    } else {
      // Dernier instrument, terminer
      this.complete();
    }
  }

  /**
   * Retourne à l'instrument précédent
   */
  previous() {
    if (this.currentIndex > 0) {
      this.showInstrument(this.currentIndex - 1);
    }
  }

  /**
   * Saute l'instrument actuel
   */
  skip() {
    if (this.currentIndex < this.incompleteInstruments.length - 1) {
      this.showInstrument(this.currentIndex + 1);
    } else {
      this.complete();
    }
  }

  /**
   * Termine et sauvegarde toutes les modifications
   */
  async complete() {
    // Envoyer les updates au serveur
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
        alert('Failed to save instrument capabilities: ' + (response?.error || 'Unknown error'));
      }
    } catch (error) {
      console.error('Failed to save capabilities:', error);
      alert('Failed to save instrument capabilities');
    }
  }

  /**
   * Ouvre la page complète de réglages de l'instrument
   * @param {number} instrumentId
   */
  openFullSettings(instrumentId) {
    // TODO: Implémenter la page de gestion complète des instruments
    // Pour l'instant, afficher un message
    alert(`Full instrument settings page coming soon!\n\nInstrument ID: ${instrumentId}\n\nThis feature will allow you to configure:\n- Advanced MIDI settings\n- Latency calibration\n- Bank MSB/LSB\n- Custom note mappings\n- And more...`);

    // Future implementation:
    // window.location.hash = `#instrument-settings/${instrumentId}`;
    // ou
    // const settingsModal = new InstrumentSettingsModal(this.apiClient);
    // settingsModal.show(instrumentId);
  }

  /**
   * Convertit un numéro MIDI en nom de note
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
   * Ferme le modal
   */
  close() {
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
