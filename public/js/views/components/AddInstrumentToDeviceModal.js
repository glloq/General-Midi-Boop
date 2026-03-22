/**
 * AddInstrumentToDeviceModal
 *
 * Modal pour ajouter un nouvel instrument sur un device existant
 * en sélectionnant un canal MIDI libre et un type d'instrument.
 */
class AddInstrumentToDeviceModal extends BaseModal {
  constructor(apiClient) {
    super({
      id: 'add-instrument-to-device-modal',
      size: 'md',
      title: 'instrumentManagement.addInstrumentTitle',
      customClass: 'add-inst-modal'
    });
    this.apiClient = apiClient;
    this.deviceId = null;
    this.deviceName = '';
    this.usedChannels = [];
    this.onInstrumentAdded = null;
  }

  /**
   * Ouvre le modal pour un device spécifique
   * @param {string} deviceId - ID du device
   * @param {string} deviceName - Nom affiché du device
   * @param {Function} onAdded - Callback après ajout réussi
   */
  async showForDevice(deviceId, deviceName, onAdded) {
    this.deviceId = deviceId;
    this.deviceName = deviceName || deviceId;
    this.onInstrumentAdded = onAdded;

    // Charger les canaux déjà utilisés sur ce device
    try {
      const response = await this.apiClient.sendCommand('instrument_list_by_device', { deviceId });
      if (response && response.instruments) {
        this.usedChannels = response.instruments.map(inst => inst.channel);
      } else {
        this.usedChannels = [];
      }
    } catch (e) {
      console.warn('Failed to load device instruments:', e);
      this.usedChannels = [];
    }

    this.open();
  }

  renderBody() {
    const t = (key, fallback) => this.t(key) !== key ? this.t(key) : fallback;

    // Construire la grille de sélection des canaux MIDI (1-16)
    let channelGrid = '<div class="add-inst-channel-grid">';
    for (let ch = 0; ch < 16; ch++) {
      const isUsed = this.usedChannels.includes(ch);
      const isDrumChannel = (ch === 9);
      const label = `${ch + 1}${isDrumChannel ? ' (DR)' : ''}`;
      channelGrid += `
        <button type="button"
                class="add-inst-channel-btn ${isUsed ? 'used' : ''}"
                data-channel="${ch}"
                ${isUsed ? 'disabled' : ''}
                title="${isUsed ? t('instrumentManagement.channelUsed', 'Canal déjà utilisé') : `Canal MIDI ${ch + 1}`}">
          ${label}
        </button>`;
    }
    channelGrid += '</div>';

    // Construire le sélecteur de type d'instrument (presets simples)
    const presets = [
      { type: 'piano', gm: 0, icon: '🎹', label: 'Piano' },
      { type: 'electric_piano', gm: 4, icon: '🎹', label: 'Piano Electrique' },
      { type: 'organ', gm: 19, icon: '🎵', label: 'Orgue' },
      { type: 'guitar', gm: 25, icon: '🎸', label: 'Guitare' },
      { type: 'bass', gm: 33, icon: '🎸', label: 'Basse' },
      { type: 'violin', gm: 40, icon: '🎻', label: 'Violon' },
      { type: 'cello', gm: 42, icon: '🎻', label: 'Violoncelle' },
      { type: 'strings', gm: 48, icon: '🎻', label: 'Ensemble Cordes' },
      { type: 'trumpet', gm: 56, icon: '🎺', label: 'Trompette' },
      { type: 'saxophone', gm: 66, icon: '🎷', label: 'Saxophone' },
      { type: 'flute', gm: 73, icon: '🪈', label: 'Flute' },
      { type: 'synth_lead', gm: 80, icon: '🎛️', label: 'Synth Lead' },
      { type: 'synth_pad', gm: 88, icon: '🎛️', label: 'Synth Pad' },
      { type: 'drums', gm: 0, icon: '🥁', label: 'Batterie' },
      { type: 'custom', gm: null, icon: '⚙️', label: t('instrumentManagement.customType', 'Personnalisé') }
    ];

    let presetOptions = presets.map(p =>
      `<option value="${p.type}" data-gm="${p.gm !== null ? p.gm : ''}">${p.icon} ${p.label}</option>`
    ).join('');

    return `
      <div class="add-inst-form">
        <!-- Device info -->
        <div class="add-inst-device-info">
          <span class="add-inst-device-label">${t('instrumentManagement.targetDevice', 'Appareil')} :</span>
          <strong>${this.escape(this.deviceName)}</strong>
        </div>

        <!-- Canal MIDI -->
        <div class="form-group">
          <label>${t('instrumentManagement.selectChannel', 'Canal MIDI')}</label>
          <p class="add-inst-help">${t('instrumentManagement.selectChannelHelp', 'Sélectionnez un canal libre (les canaux utilisés sont grisés)')}</p>
          ${channelGrid}
          <div id="addInstChannelInfo" class="add-inst-channel-info" style="display:none;"></div>
        </div>

        <!-- Type d'instrument -->
        <div class="form-group">
          <label>${t('instrumentManagement.instrumentType', 'Type d\'instrument')}</label>
          <select id="addInstPreset" class="add-inst-select">
            ${presetOptions}
          </select>
        </div>

        <!-- Nom personnalisé -->
        <div class="form-group">
          <label>${t('instrumentManagement.customName', 'Nom personnalisé')}</label>
          <input type="text" id="addInstName" class="add-inst-input" placeholder="${t('instrumentManagement.customNamePlaceholder', 'Ex: Mon Piano, Batterie ESP32...')}">
        </div>

        <!-- GM Program (pour type personnalisé) -->
        <div class="form-group" id="addInstGmGroup" style="display: none;">
          <label>${t('instrumentManagement.gmProgram', 'Programme GM')}</label>
          <select id="addInstGmProgram" class="add-inst-select">
            ${typeof renderGMInstrumentOptions === 'function' ? renderGMInstrumentOptions(null, 0) : '<option value="">--</option>'}
          </select>
        </div>

        <!-- Polyphonie -->
        <div class="form-group">
          <label>${t('instrumentManagement.polyphony', 'Polyphonie')}</label>
          <input type="number" id="addInstPolyphony" class="add-inst-input" value="16" min="1" max="128" placeholder="16">
        </div>
      </div>
    `;
  }

  renderFooter() {
    const t = (key, fallback) => this.t(key) !== key ? this.t(key) : fallback;
    return `
      <button class="btn" id="addInstCancelBtn">${t('common.cancel', 'Annuler')}</button>
      <button class="btn btn-primary" id="addInstCreateBtn" disabled>
        ${t('instrumentManagement.addInstrumentBtn', 'Ajouter l\'instrument')}
      </button>
    `;
  }

  onOpen() {
    this.selectedChannel = null;

    // Channel button clicks
    const channelBtns = this.dialog.querySelectorAll('.add-inst-channel-btn:not([disabled])');
    channelBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        // Deselect all
        this.dialog.querySelectorAll('.add-inst-channel-btn').forEach(b => b.classList.remove('selected'));
        // Select this one
        btn.classList.add('selected');
        this.selectedChannel = parseInt(btn.dataset.channel);
        this._updateCreateButton();
        this._updateChannelInfo();

        // If drum channel selected, auto-select drums preset
        if (this.selectedChannel === 9) {
          const presetSelect = this.dialog.querySelector('#addInstPreset');
          if (presetSelect) presetSelect.value = 'drums';
        }
      });
    });

    // Preset change
    const presetSelect = this.dialog.querySelector('#addInstPreset');
    if (presetSelect) {
      presetSelect.addEventListener('change', () => {
        const gmGroup = this.dialog.querySelector('#addInstGmGroup');
        if (gmGroup) {
          gmGroup.style.display = presetSelect.value === 'custom' ? 'block' : 'none';
        }

        // Auto-select channel 9 for drums
        if (presetSelect.value === 'drums' && !this.usedChannels.includes(9)) {
          const ch9Btn = this.dialog.querySelector('.add-inst-channel-btn[data-channel="9"]');
          if (ch9Btn && !ch9Btn.disabled) {
            this.dialog.querySelectorAll('.add-inst-channel-btn').forEach(b => b.classList.remove('selected'));
            ch9Btn.classList.add('selected');
            this.selectedChannel = 9;
            this._updateCreateButton();
            this._updateChannelInfo();
          }
        }
      });
    }

    // Cancel
    const cancelBtn = this.dialog.querySelector('#addInstCancelBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', () => this.close());

    // Create
    const createBtn = this.dialog.querySelector('#addInstCreateBtn');
    if (createBtn) createBtn.addEventListener('click', () => this._createInstrument());
  }

  _updateCreateButton() {
    const btn = this.dialog.querySelector('#addInstCreateBtn');
    if (btn) {
      btn.disabled = (this.selectedChannel === null || this.selectedChannel === undefined);
    }
  }

  _updateChannelInfo() {
    const info = this.dialog.querySelector('#addInstChannelInfo');
    if (!info) return;

    if (this.selectedChannel !== null && this.selectedChannel !== undefined) {
      const isDrum = this.selectedChannel === 9;
      info.style.display = 'block';
      info.innerHTML = isDrum
        ? `<span style="color: #f59e0b;">Canal 10 = Canal percussion/batterie standard MIDI</span>`
        : `<span style="color: #3b82f6;">Canal ${this.selectedChannel + 1} sélectionné</span>`;
    } else {
      info.style.display = 'none';
    }
  }

  async _createInstrument() {
    if (this.selectedChannel === null) return;

    const presetSelect = this.dialog.querySelector('#addInstPreset');
    const nameInput = this.dialog.querySelector('#addInstName');
    const polyphonyInput = this.dialog.querySelector('#addInstPolyphony');
    const gmProgramSelect = this.dialog.querySelector('#addInstGmProgram');

    const presetValue = presetSelect ? presetSelect.value : 'custom';
    const customName = nameInput ? nameInput.value.trim() : '';
    const polyphony = polyphonyInput ? parseInt(polyphonyInput.value) || 16 : 16;

    // Déterminer le GM program
    let gmProgram = null;
    if (presetValue === 'custom') {
      gmProgram = gmProgramSelect ? parseInt(gmProgramSelect.value) || null : null;
    } else if (presetValue === 'drums') {
      gmProgram = 0; // Standard drum kit
    } else {
      const option = presetSelect.querySelector(`option[value="${presetValue}"]`);
      if (option) gmProgram = parseInt(option.dataset.gm) || null;
    }

    const data = {
      deviceId: this.deviceId,
      channel: this.selectedChannel,
      name: customName || (presetSelect ? presetSelect.options[presetSelect.selectedIndex].text.replace(/^[^\s]+ /, '') : `Instrument Ch${this.selectedChannel + 1}`),
      custom_name: customName || null,
      gm_program: gmProgram,
      polyphony: polyphony
    };

    // Pour les drums, ajouter le mode discrete
    if (presetValue === 'drums') {
      data.note_selection_mode = 'discrete';
      data.selected_notes = [35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 53, 55, 57, 59];
    }

    try {
      const createBtn = this.dialog.querySelector('#addInstCreateBtn');
      if (createBtn) {
        createBtn.disabled = true;
        createBtn.textContent = this.t('common.loading') !== 'common.loading' ? this.t('common.loading') : 'Création...';
      }

      await this.apiClient.sendCommand('instrument_add_to_device', data);

      this.close();

      if (this.onInstrumentAdded) {
        this.onInstrumentAdded();
      }
    } catch (error) {
      console.error('Failed to add instrument:', error);
      const createBtn = this.dialog.querySelector('#addInstCreateBtn');
      if (createBtn) {
        createBtn.disabled = false;
        createBtn.textContent = this.t('instrumentManagement.addInstrumentBtn') !== 'instrumentManagement.addInstrumentBtn'
          ? this.t('instrumentManagement.addInstrumentBtn') : 'Ajouter l\'instrument';
      }
      alert((this.t('instrumentManagement.addFailed') !== 'instrumentManagement.addFailed'
        ? this.t('instrumentManagement.addFailed') : 'Erreur lors de l\'ajout') + ': ' + error.message);
    }
  }
}

// Rendre disponible globalement
window.AddInstrumentToDeviceModal = AddInstrumentToDeviceModal;
