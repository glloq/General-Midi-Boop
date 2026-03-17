/**
 * InstrumentManagementPage
 *
 * Page complète de gestion des instruments MIDI avec toutes les fonctionnalités :
 * - Liste de tous les instruments
 * - Édition des capacités
 * - Scan et découverte
 * - Test MIDI
 * - Import/Export
 */

class InstrumentManagementPage {
  constructor(apiClient) {
    this.apiClient = apiClient;
    // Bind escapeHtml for XSS prevention
    this._escapeHtml = window.escapeHtml || ((text) => {
      if (text == null) return '';
      const div = document.createElement('div');
      div.textContent = String(text);
      return div.innerHTML;
    });
    this.modal = null;
    this.instruments = [];
    this.selectedInstrument = null;
    this.filterStatus = 'all'; // 'all', 'complete', 'incomplete'
    this.searchQuery = '';
  }

  /**
   * Affiche la page de gestion des instruments
   */
  async show() {
    // Créer la modal
    this.createModal();

    // Charger les instruments
    await this.loadInstruments();

    // Rendre global pour les callbacks onclick
    window.instrumentManagementPageInstance = this;
  }

  /**
   * Crée la structure HTML de la page
   */
  createModal() {
    const modalHTML = `
      <div class="modal-overlay" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 10000; display: flex; align-items: center; justify-content: center;">
        <div class="modal-container" style="background: white; border-radius: 12px; width: 95%; max-width: 1400px; height: 90vh; display: flex; flex-direction: column; box-shadow: 0 20px 60px rgba(0,0,0,0.3); overflow: hidden;">

          <!-- Header -->
          <div class="modal-header" style="padding: 16px 24px; border-bottom: none; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; flex-shrink: 0;">
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px;">
              <h2 style="margin: 0; font-size: 22px; white-space: nowrap;">🎹 ${i18n.t('instrumentManagement.title') || 'Gestion des instruments'}</h2>
              <div style="display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0;">
                <input type="text"
                       id="instrumentSearch"
                       placeholder="🔍 ${i18n.t('instrumentManagement.searchPlaceholder') || 'Rechercher un instrument...'}"
                       onkeyup="instrumentManagementPageInstance.handleSearch(this.value)"
                       style="flex: 1; min-width: 150px; padding: 8px 14px; border: 2px solid rgba(255,255,255,0.3); border-radius: 8px; font-size: 14px; background: rgba(255,255,255,0.15); color: white; outline: none;"
                       onfocus="this.style.borderColor='rgba(255,255,255,0.6)';this.style.background='rgba(255,255,255,0.25)'"
                       onblur="this.style.borderColor='rgba(255,255,255,0.3)';this.style.background='rgba(255,255,255,0.15)'">
                <select id="instrumentFilter"
                        onchange="instrumentManagementPageInstance.handleFilter(this.value)"
                        style="padding: 8px 12px; border: 2px solid rgba(255,255,255,0.3); border-radius: 8px; font-size: 13px; background: rgba(255,255,255,0.15); color: white; cursor: pointer;">
                  <option value="all" style="background: #2d2d2d; color: #e0e0e0;">${i18n.t('instrumentManagement.filterAll') || 'Tous'}</option>
                  <option value="complete" style="background: #2d2d2d; color: #e0e0e0;">✓ ${i18n.t('instrumentManagement.filterComplete') || 'Complets'}</option>
                  <option value="incomplete" style="background: #2d2d2d; color: #e0e0e0;">⚠ ${i18n.t('instrumentManagement.filterIncomplete') || 'Incomplets'}</option>
                  <option value="connected" style="background: #2d2d2d; color: #e0e0e0;">🔌 ${i18n.t('instrumentManagement.filterConnected') || 'Connectés'}</option>
                  <option value="virtual" style="background: #2d2d2d; color: #e0e0e0;">🖥️ ${i18n.t('instrumentManagement.filterVirtual') || 'Virtuels'}</option>
                </select>
              </div>
              <button class="modal-close" onclick="instrumentManagementPageInstance.close()" style="background: rgba(255,255,255,0.2); border: none; color: white; font-size: 24px; cursor: pointer; width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; transition: background 0.2s; flex-shrink: 0;" onmouseover="this.style.background='rgba(255,255,255,0.35)'" onmouseout="this.style.background='rgba(255,255,255,0.2)'">
                ×
              </button>
            </div>
          </div>

          <!-- Toolbar connexions -->
          <div style="padding: 10px 24px; border-bottom: 2px solid #e5e7eb; background: #f9fafb; flex-shrink: 0;">
            <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
              <span style="font-size: 13px; color: #666; font-weight: 600;">${i18n.t('instrumentManagement.scanLabel') || 'Scanner :'}</span>
              <button class="btn" onclick="instrumentManagementPageInstance.scanDevices()" style="padding: 6px 14px; font-size: 13px;">
                🔌 USB
              </button>
              <button class="btn" onclick="instrumentManagementPageInstance.scanBluetooth()" style="padding: 6px 14px; font-size: 13px;">
                📡 Bluetooth
              </button>
              <button class="btn" onclick="instrumentManagementPageInstance.scanNetwork()" style="padding: 6px 14px; font-size: 13px;">
                🌐 WiFi / Réseau
              </button>
              <div style="margin-left: auto; display: flex; gap: 8px; align-items: center;">
                <button class="btn btn-primary" onclick="instrumentManagementPageInstance.addVirtualInstrument()" style="padding: 6px 14px; font-size: 13px;">
                  ➕ ${i18n.t('instrumentManagement.addVirtual') || 'Ajouter un instrument virtuel'}
                </button>
                <button class="btn" onclick="instrumentManagementPageInstance.refresh()" style="padding: 6px 14px; font-size: 13px;">
                  🔄
                </button>
              </div>
            </div>
          </div>

          <!-- Content -->
          <div style="flex: 1; overflow-y: auto; padding: 24px;">
            <div id="instrumentListContent">
              <!-- Instruments will be rendered here -->
            </div>
          </div>

          <!-- Footer Stats -->
          <div style="padding: 16px 24px; border-top: 1px solid #e5e7eb; background: #f9fafb; flex-shrink: 0;">
            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 14px; color: #666;">
              <span id="instrumentStats">${i18n.t('common.loading') || 'Chargement...'}</span>
              <button class="btn" onclick="instrumentManagementPageInstance.close()">
                ${i18n.t('common.close') || 'Fermer'}
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
   * Charge la liste des instruments
   */
  async loadInstruments() {
    try {
      // 1. Charger les devices connectés
      const response = await this.apiClient.sendCommand('device_list', {});
      const connectedDevices = (response && response.devices) ? response.devices : [];
      const connectedIds = new Set(connectedDevices.map(d => d.id));

      // 2. Charger les instruments enregistrés en DB (même déconnectés)
      let registeredInstruments = [];
      try {
        const capsResponse = await this.apiClient.sendCommand('instrument_list_capabilities');
        if (capsResponse && capsResponse.instruments) {
          registeredInstruments = capsResponse.instruments;
        }
      } catch (e) {
        console.warn('Failed to load registered instruments from DB:', e);
      }

      // 3. Fusionner : connectés (enrichis) + enregistrés non connectés
      this.instruments = [];

      // Ajouter les devices connectés enrichis avec leurs capacités DB
      for (const device of connectedDevices) {
        device.connected = true;
        device.status = 2; // connected
        // Enrichir avec les capacités DB
        const dbInstrument = registeredInstruments.find(r => r.device_id === device.id);
        if (dbInstrument) {
          Object.assign(device, dbInstrument);
          device.connected = true;
          device.status = 2;
        }
        this.instruments.push(device);
      }

      // Ajouter les instruments enregistrés qui ne sont PAS connectés
      for (const registered of registeredInstruments) {
        if (!connectedIds.has(registered.device_id)) {
          registered.id = registered.device_id;
          registered.connected = false;
          registered.status = 0; // disconnected
          this.instruments.push(registered);
        }
      }

      // Marquer les instruments virtuels comme toujours disponibles
      for (const inst of this.instruments) {
        if (this.isVirtualInstrument(inst)) {
          inst.connected = true;
          inst.status = 2;
          inst.isVirtual = true;
        }
      }

      this.renderInstruments();
      this.updateStats();
    } catch (error) {
      console.error('Failed to load instruments:', error);
      this.showError('Failed to load instruments: ' + error.message);
    }
  }

  /**
   * Verifie si un instrument est virtuel
   */
  isVirtualInstrument(instrument) {
    const deviceId = instrument.device_id || instrument.id || '';
    return deviceId.startsWith('virtual_') || instrument.instrument_type === 'virtual';
  }

  /**
   * Affiche les instruments dans la liste
   */
  renderInstruments() {
    const content = document.getElementById('instrumentListContent');
    if (!content) return;

    // Filtrer les instruments
    let filtered = this.instruments;

    // Recherche
    if (this.searchQuery) {
      const query = this.searchQuery.toLowerCase();
      filtered = filtered.filter(inst =>
        (inst.name || '').toLowerCase().includes(query) ||
        (inst.custom_name || '').toLowerCase().includes(query) ||
        (inst.manufacturer || '').toLowerCase().includes(query)
      );
    }

    // Filtre par statut
    if (this.filterStatus === 'complete') {
      filtered = filtered.filter(inst => this.isInstrumentComplete(inst));
    } else if (this.filterStatus === 'incomplete') {
      filtered = filtered.filter(inst => !this.isInstrumentComplete(inst));
    } else if (this.filterStatus === 'connected') {
      filtered = filtered.filter(inst => (inst.status === 2 || inst.connected) && !this.isVirtualInstrument(inst));
    } else if (this.filterStatus === 'virtual') {
      filtered = filtered.filter(inst => this.isVirtualInstrument(inst));
    }

    if (filtered.length === 0) {
      content.innerHTML = `
        <div style="text-align: center; padding: 60px 20px; color: #999;">
          <div style="font-size: 64px; margin-bottom: 16px;">🎹</div>
          <h3 style="margin: 0 0 8px 0; color: #666;">${i18n.t('instrumentManagement.noInstruments') || 'Aucun instrument trouvé'}</h3>
          <p style="margin: 0; font-size: 14px;">
            ${this.searchQuery || this.filterStatus !== 'all'
              ? (i18n.t('instrumentManagement.adjustFilter') || 'Essayez de modifier votre recherche ou filtre')
              : (i18n.t('instrumentManagement.scanToStart') || 'Scannez vos périphériques pour commencer')}
          </p>
        </div>
      `;
      return;
    }

    // Grouper par type : connectes physiques, virtuels, deconnectes
    const virtual = filtered.filter(inst => this.isVirtualInstrument(inst));
    const connected = filtered.filter(inst => (inst.status === 2 || inst.connected) && !this.isVirtualInstrument(inst));
    const disconnected = filtered.filter(inst => inst.status !== 2 && !inst.connected && !this.isVirtualInstrument(inst));

    let html = '';

    // Instruments connectés
    if (connected.length > 0) {
      html += `
        <div style="margin-bottom: 32px;">
          <h3 style="margin: 0 0 16px 0; padding-bottom: 8px; border-bottom: 2px solid #10b981; color: #10b981; font-size: 16px;">
            🔌 ${i18n.t('instrumentManagement.connectedInstruments') || 'Instruments connectés'} (${connected.length})
          </h3>
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(400px, 1fr)); gap: 16px;">
            ${connected.map(inst => this.renderInstrumentCard(inst)).join('')}
          </div>
        </div>
      `;
    }

    // Instruments virtuels
    if (virtual.length > 0) {
      html += `
        <div style="margin-bottom: 32px;">
          <h3 style="margin: 0 0 16px 0; padding-bottom: 8px; border-bottom: 2px solid #8b5cf6; color: #7c3aed; font-size: 16px;">
            🖥️ ${i18n.t('instrumentManagement.virtualInstruments') || 'Instruments virtuels'} (${virtual.length})
          </h3>
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(400px, 1fr)); gap: 16px;">
            ${virtual.map(inst => this.renderInstrumentCard(inst)).join('')}
          </div>
        </div>
      `;
    }

    // Instruments déconnectés
    if (disconnected.length > 0) {
      html += `
        <div>
          <h3 style="margin: 0 0 16px 0; padding-bottom: 8px; border-bottom: 2px solid #94a3b8; color: #64748b; font-size: 16px;">
            ⚫ ${i18n.t('instrumentManagement.disconnectedInstruments') || 'Instruments déconnectés'} (${disconnected.length})
          </h3>
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(400px, 1fr)); gap: 16px;">
            ${disconnected.map(inst => this.renderInstrumentCard(inst)).join('')}
          </div>
        </div>
      `;
    }

    content.innerHTML = html;
  }

  /**
   * Rendu d'une carte instrument
   */
  renderInstrumentCard(instrument) {
    const isComplete = this.isInstrumentComplete(instrument);
    const isConnected = instrument.status === 2 || instrument.connected;
    const isVirtual = this.isVirtualInstrument(instrument);
    const displayName = instrument.custom_name || instrument.name || i18n.t('instrumentManagement.unknownDevice');
    const esc = this._escapeHtml;
    const safeId = esc(instrument.id);
    const borderColor = isVirtual ? '#8b5cf6' : (isConnected ? '#10b981' : '#e5e7eb');

    return `
      <div class="instrument-card" style="
        background: white;
        border: 2px solid ${borderColor};
        border-radius: 12px;
        padding: 20px;
        transition: all 0.2s;
        cursor: pointer;
        ${!isConnected ? 'opacity: 0.7;' : ''}
      " onmouseover="this.style.boxShadow='0 4px 12px rgba(0,0,0,0.1)'" onmouseout="this.style.boxShadow='none'">

        <!-- Header -->
        <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 12px;">
          <div style="flex: 1;">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
              <h4 style="margin: 0; font-size: 18px; color: #1f2937;">${esc(displayName)}</h4>
              ${isComplete
                ? `<span style="display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; background: #10b981; color: white; border-radius: 12px; font-size: 11px; font-weight: 600;">✓ ${i18n.t('instrumentManagement.complete') || 'COMPLET'}</span>`
                : `<span style="display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; background: #f59e0b; color: white; border-radius: 12px; font-size: 11px; font-weight: 600;">⚠ ${i18n.t('instrumentManagement.incomplete') || 'INCOMPLET'}</span>`
              }
            </div>
            ${instrument.name !== displayName ? `<div style="font-size: 13px; color: #6b7280;">${esc(instrument.name)}</div>` : ''}
          </div>
          <div style="font-size: 24px;">
            ${isVirtual ? '🖥️' : (isConnected ? '🟢' : '⚫')}
          </div>
        </div>

        <!-- Info -->
        <div style="margin-bottom: 16px; font-size: 13px; color: #6b7280;">
          ${instrument.manufacturer ? `<div>🏭 ${esc(instrument.manufacturer)}</div>` : ''}
          ${instrument.gm_program !== null && instrument.gm_program !== undefined
            ? `<div>🎵 ${i18n.t('instrumentManagement.gmProgram') || 'Programme GM'}: ${instrument.gm_program}</div>`
            : `<div style="color: #f59e0b;">⚠ ${i18n.t('instrumentManagement.gmProgramNotSet') || 'Programme GM non défini'}</div>`}
          ${instrument.note_range_min != null && instrument.note_range_max != null
            ? `<div>🎹 ${i18n.t('instrumentManagement.range') || 'Plage'}: ${this.getNoteName(instrument.note_range_min)} - ${this.getNoteName(instrument.note_range_max)}</div>`
            : `<div style="color: #f59e0b;">⚠ ${i18n.t('instrumentManagement.rangeNotSet') || 'Plage de notes non définie'}</div>`}
          ${instrument.polyphony
            ? `<div>🎼 ${i18n.t('instrumentManagement.polyphony') || 'Polyphonie'}: ${instrument.polyphony}</div>`
            : `<div style="color: #f59e0b;">⚠ ${i18n.t('instrumentManagement.polyphonyNotSet') || 'Polyphonie non définie'}</div>`}
        </div>

        <!-- Actions -->
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <button class="btn btn-primary"
                  onclick="event.stopPropagation(); instrumentManagementPageInstance.editInstrument('${safeId}')"
                  style="flex: 1; min-width: 80px; font-size: 13px; padding: 7px 12px;">
            ✏️ ${i18n.t('instrumentManagement.edit') || 'Modifier'}
          </button>
          ${isConnected ? `
            <button class="btn"
                    onclick="event.stopPropagation(); instrumentManagementPageInstance.testInstrument('${safeId}')"
                    style="font-size: 13px; padding: 7px 12px;">
              🎵 ${i18n.t('instrumentManagement.test') || 'Tester'}
            </button>
          ` : ''}
          <button class="btn btn-danger"
                  onclick="event.stopPropagation(); instrumentManagementPageInstance.deleteInstrument('${safeId}')"
                  style="font-size: 13px; padding: 7px 12px;">
            🗑️
          </button>
        </div>
      </div>
    `;
  }

  /**
   * Vérifie si un instrument est complet
   */
  isInstrumentComplete(instrument) {
    return instrument.gm_program !== null && instrument.gm_program !== undefined &&
           instrument.note_range_min !== null && instrument.note_range_min !== undefined &&
           instrument.note_range_max !== null && instrument.note_range_max !== undefined &&
           instrument.polyphony !== null && instrument.polyphony !== undefined &&
           (instrument.note_selection_mode || instrument.mode);
  }

  /**
   * Convertit un numéro MIDI en nom de note
   */
  getNoteName(midi) {
    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const octave = Math.floor(midi / 12) - 1;
    const noteName = noteNames[midi % 12];
    return `${noteName}${octave}`;
  }

  /**
   * Met à jour les statistiques
   */
  updateStats() {
    const statsElement = document.getElementById('instrumentStats');
    if (!statsElement) return;

    const total = this.instruments.length;
    const connected = this.instruments.filter(inst => inst.status === 2 || inst.connected).length;
    const complete = this.instruments.filter(inst => this.isInstrumentComplete(inst)).length;
    const incomplete = total - complete;

    statsElement.innerHTML = `
      <span><strong>${total}</strong> ${i18n.t('instrumentManagement.instrumentsTotal') || 'instruments au total'}</span>
      <span>•</span>
      <span style="color: #10b981;"><strong>${connected}</strong> ${i18n.t('instrumentManagement.connectedCount') || 'connectés'}</span>
      <span>•</span>
      <span style="color: #10b981;"><strong>${complete}</strong> ${i18n.t('instrumentManagement.completeCount') || 'complets'}</span>
      ${incomplete > 0 ? `
        <span>•</span>
        <span style="color: #f59e0b;"><strong>${incomplete}</strong> ${i18n.t('instrumentManagement.incompleteCount') || 'incomplets'}</span>
      ` : ''}
    `;
  }

  /**
   * Gère la recherche
   */
  handleSearch(query) {
    this.searchQuery = query;
    this.renderInstruments();
  }

  /**
   * Gère le filtre
   */
  handleFilter(status) {
    this.filterStatus = status;
    this.renderInstruments();
  }

  /**
   * Édite un instrument
   */
  editInstrument(deviceId) {
    // Utiliser le modal existant showInstrumentSettings
    const instrument = this.instruments.find(inst => inst.id === deviceId);
    if (instrument && window.showInstrumentSettings) {
      window.showInstrumentSettings(instrument);
    } else {
      this.showToast(i18n.t('instrumentManagement.settingsNotAvailable') || 'Réglages non disponibles. Vérifiez que le module est chargé.', 'error');
    }
  }

  /**
   * Complète un instrument via InstrumentCapabilitiesModal ou settings
   */
  async completeInstrument(deviceId) {
    const instrument = this.instruments.find(inst => inst.id === deviceId);
    if (!instrument) return;

    try {
      // Valider les capacités
      const response = await this.apiClient.sendCommand('validate_instrument_capabilities', {});

      if (response && response.incompleteInstruments) {
        const incomplete = response.incompleteInstruments.find(
          item => item.instrument.device_id === deviceId ||
                  item.instrument.id === deviceId ||
                  item.instrument.id === instrument.instrumentId
        );

        if (incomplete && window.InstrumentCapabilitiesModal) {
          const capabilitiesModal = new window.InstrumentCapabilitiesModal(this.apiClient);

          capabilitiesModal.show([incomplete], async (updates) => {
            console.log('Capabilities updated:', updates);
            await this.refresh();
          });
          return;
        }
      }
    } catch (error) {
      console.warn('Validation failed, falling back to settings:', error);
    }

    // Fallback: ouvrir les réglages complets
    this.editInstrument(deviceId);
  }

  /**
   * Test un instrument
   */
  async testInstrument(deviceId) {
    try {
      const instrument = this.instruments.find(inst => inst.id === deviceId);

      // Use instrument's channel if available, default to 0
      const channel = instrument && instrument.channel !== undefined ? instrument.channel : 0;

      // Pick a test note within the instrument's capabilities
      let testNote = 60; // Default C4
      if (instrument) {
        if (instrument.note_selection_mode === 'discrete' && instrument.selected_notes && instrument.selected_notes.length > 0) {
          // For discrete mode, pick the first available note
          testNote = instrument.selected_notes[0];
        } else if (instrument.note_range_min !== undefined && instrument.note_range_min !== null) {
          // For range mode, ensure C4 is within range, otherwise pick middle of range
          const min = instrument.note_range_min;
          const max = instrument.note_range_max !== undefined && instrument.note_range_max !== null ? instrument.note_range_max : 127;
          if (testNote < min || testNote > max) {
            testNote = Math.round((min + max) / 2);
          }
        }
      }

      await this.apiClient.sendCommand('midi_send_note', {
        deviceId: deviceId,
        channel: channel,
        note: testNote,
        velocity: 100,
        duration: 500
      });

      this.showToast(i18n.t('instrumentManagement.testNoteSent') || 'Note de test envoyée ! (C4 - Do central)', 'success');
    } catch (error) {
      this.showToast((i18n.t('instrumentManagement.testNoteFailed') || 'Échec de l\'envoi de la note de test') + ': ' + error.message, 'error');
    }
  }

  /**
   * Supprime un instrument
   */
  async deleteInstrument(deviceId) {
    const confirmed = await window.showConfirm(
      i18n.t('instrumentManagement.deleteConfirm') || 'Êtes-vous sûr de vouloir supprimer cet instrument de la base de données ?\n\nNote : Le périphérique physique ne sera pas affecté.',
      {
        title: i18n.t('instrumentManagement.deleteTitle') || 'Supprimer l\'instrument',
        icon: '🗑️',
        okText: i18n.t('common.delete') || 'Supprimer',
        danger: true
      }
    );
    if (!confirmed) {
      return;
    }

    try {
      await this.apiClient.sendCommand('instrument_delete', { deviceId });
      this.showToast(i18n.t('instrumentManagement.deleteSuccess') || 'Instrument supprimé avec succès', 'success');
      await this.refresh();
    } catch (error) {
      this.showToast((i18n.t('instrumentManagement.deleteFailed') || 'Échec de la suppression') + ': ' + error.message, 'error');
    }
  }

  /**
   * Presets d'instruments virtuels disponibles cote frontend
   */
  static VIRTUAL_PRESETS = [
    { type: 'piano', icon: '🎹', label: 'Piano', description: 'A0-C8, polyphonie 64' },
    { type: 'electric_piano', icon: '🎹', label: 'Piano Électrique', description: 'E1-G7, polyphonie 32' },
    { type: 'organ', icon: '🎵', label: 'Orgue', description: 'C2-C7, polyphonie 16' },
    { type: 'guitar', icon: '🎸', label: 'Guitare', description: 'E2-E6, polyphonie 6' },
    { type: 'bass', icon: '🎸', label: 'Basse', description: 'E1-G4, polyphonie 4' },
    { type: 'violin', icon: '🎻', label: 'Violon', description: 'G3-G7, polyphonie 4' },
    { type: 'cello', icon: '🎻', label: 'Violoncelle', description: 'C2-C6, polyphonie 4' },
    { type: 'strings', icon: '🎻', label: 'Ensemble Cordes', description: 'C2-C7, polyphonie 16' },
    { type: 'trumpet', icon: '🎺', label: 'Trompette', description: 'E3-C6, mono' },
    { type: 'saxophone', icon: '🎷', label: 'Saxophone', description: 'C#3-D#6, mono' },
    { type: 'flute', icon: '🪈', label: 'Flûte', description: 'C4-C7, mono' },
    { type: 'synth_lead', icon: '🎛️', label: 'Synth Lead', description: 'C2-C7, polyphonie 8' },
    { type: 'synth_pad', icon: '🎛️', label: 'Synth Pad', description: 'C2-C7, polyphonie 16' },
    { type: 'drums', icon: '🥁', label: 'Batterie', description: 'Canal 10, notes GM drums' },
    { type: null, icon: '⚙️', label: 'Personnalisé', description: 'Configurer manuellement' }
  ];

  /**
   * Ajoute un instrument virtuel avec selection du type
   */
  addVirtualInstrument() {
    const presets = InstrumentManagementPage.VIRTUAL_PRESETS;
    const esc = this._escapeHtml;

    // Creer le dialog de selection
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:10100;display:flex;align-items:center;justify-content:center;';

    overlay.innerHTML = `
      <div style="background:white;border-radius:16px;width:90%;max-width:700px;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
        <div style="padding:16px 24px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between;background:linear-gradient(135deg, #667eea 0%, #764ba2 100%);border-radius:16px 16px 0 0;color:white;">
          <h3 style="margin:0;font-size:18px;">➕ ${esc(i18n.t('instrumentManagement.addVirtualTitle') || 'Ajouter un instrument virtuel')}</h3>
          <button onclick="this.closest('div[style*=fixed]').remove()" style="background:rgba(255,255,255,0.2);border:none;font-size:20px;cursor:pointer;color:white;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;transition:background 0.2s;flex-shrink:0;" onmouseover="this.style.background='rgba(255,255,255,0.35)'" onmouseout="this.style.background='rgba(255,255,255,0.2)'">×</button>
        </div>
        <div style="padding:16px 24px;border-bottom:1px solid #e5e7eb;">
          <label style="display:block;margin-bottom:6px;font-size:14px;font-weight:600;color:#374151;">
            ${esc(i18n.t('instrumentManagement.virtualCustomName') || 'Nom personnalisé (optionnel)')}
          </label>
          <input type="text" id="virtualInstrumentName" placeholder="${esc(i18n.t('instrumentManagement.virtualNamePlaceholder') || 'Laisser vide pour utiliser le nom du type')}"
                 style="width:100%;padding:10px 14px;border:2px solid #e5e7eb;border-radius:8px;font-size:14px;box-sizing:border-box;"
                 onfocus="this.style.borderColor='#8b5cf6'" onblur="this.style.borderColor='#e5e7eb'">
        </div>
        <div style="flex:1;overflow-y:auto;padding:16px 24px;">
          <p style="margin:0 0 12px 0;font-size:13px;color:#6b7280;">${esc(i18n.t('instrumentManagement.selectType') || 'Sélectionnez un type d\'instrument :')}</p>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;">
            ${presets.map(p => `
              <button class="virtual-preset-btn" data-type="${p.type || ''}"
                      style="display:flex;align-items:center;gap:12px;padding:14px 16px;border:2px solid #e5e7eb;border-radius:10px;background:white;cursor:pointer;text-align:left;transition:all 0.15s;"
                      onmouseover="this.style.borderColor='#8b5cf6';this.style.background='#faf5ff'"
                      onmouseout="this.style.borderColor='#e5e7eb';this.style.background='white'">
                <span style="font-size:28px;">${p.icon}</span>
                <div>
                  <div style="font-size:14px;font-weight:600;color:#1f2937;">${esc(p.label)}</div>
                  <div style="font-size:11px;color:#6b7280;margin-top:2px;">${esc(p.description)}</div>
                </div>
              </button>
            `).join('')}
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Fermer en cliquant sur le fond
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    // Gerer le clic sur un preset
    overlay.querySelectorAll('.virtual-preset-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const type = btn.dataset.type || null;
        const nameInput = overlay.querySelector('#virtualInstrumentName');
        const customName = nameInput ? nameInput.value.trim() : '';

        overlay.remove();
        await this._createVirtualInstrument(type, customName);
      });
    });
  }

  /**
   * Cree l'instrument virtuel via l'API
   */
  async _createVirtualInstrument(type, customName) {
    try {
      const payload = { channel: 0 };
      if (type) payload.type = type;
      if (customName) payload.name = customName;

      const response = await this.apiClient.sendCommand('instrument_create_virtual', payload);

      this.showToast(
        (i18n.t('instrumentManagement.virtualCreated') || 'Instrument virtuel créé') + ' !',
        'success'
      );
      await this.refresh();

      // Ouvrir les reglages pour les instruments personnalises (sans type)
      if (!type && response.deviceId && window.showInstrumentSettings) {
        const newInstrument = this.instruments.find(i =>
          i.device_id === response.deviceId || i.id === response.deviceId
        );
        if (newInstrument) {
          window.showInstrumentSettings(newInstrument);
        }
      }
    } catch (error) {
      this.showToast(
        (i18n.t('instrumentManagement.virtualCreateFailed') || 'Erreur de création') + ': ' + error.message,
        'error'
      );
    }
  }

  /**
   * Scan USB
   */
  async scanDevices() {
    try {
      await this.apiClient.sendCommand('device_refresh', {});
      this.showToast(i18n.t('instrumentManagement.scanStarted') || 'Scan USB lancé...', 'success');
      setTimeout(() => this.refresh(), 1000);
    } catch (error) {
      this.showToast((i18n.t('instrumentManagement.scanFailed') || 'Échec du scan') + ': ' + error.message, 'error');
    }
  }

  /**
   * Scan Bluetooth
   */
  async scanBluetooth() {
    // Utiliser le modal existant si disponible
    if (window.showBluetoothScan) {
      window.showBluetoothScan();
    } else {
      this.showToast(i18n.t('instrumentManagement.bluetoothNotAvailable') || 'Scan Bluetooth non disponible', 'error');
    }
  }

  /**
   * Scan Network
   */
  async scanNetwork() {
    // Utiliser le modal existant si disponible
    if (window.showNetworkScan) {
      window.showNetworkScan();
    } else {
      this.showToast(i18n.t('instrumentManagement.networkNotAvailable') || 'Scan réseau non disponible', 'error');
    }
  }

  /**
   * Rafraîchit la liste
   */
  async refresh() {
    await this.loadInstruments();
  }

  /**
   * Affiche une notification toast dans le modal
   * @param {string} message
   * @param {'success'|'error'|'info'} type
   */
  showToast(message, type = 'info') {
    const icons = { success: '✓', error: '✗', info: 'ℹ' };
    const colors = {
      success: { bg: '#10b981', text: 'white' },
      error: { bg: '#ef4444', text: 'white' },
      info: { bg: '#3b82f6', text: 'white' }
    };
    const style = colors[type] || colors.info;

    const toast = document.createElement('div');
    toast.style.cssText = `position: fixed; top: 24px; right: 24px; z-index: 10010; padding: 12px 20px; border-radius: 8px; background: ${style.bg}; color: ${style.text}; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); display: flex; align-items: center; gap: 8px; animation: fadeIn 0.2s ease;`;
    toast.innerHTML = `<span style="font-weight: bold; font-size: 16px;">${icons[type]}</span> ${this._escapeHtml(message)}`;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  /**
   * Affiche une erreur dans la zone de contenu
   */
  showError(message) {
    const content = document.getElementById('instrumentListContent');
    if (content) {
      content.innerHTML = `
        <div style="text-align: center; padding: 60px 20px; color: #ef4444;">
          <div style="font-size: 64px; margin-bottom: 16px;">⚠️</div>
          <h3 style="margin: 0 0 8px 0;">${i18n.t('common.error') || 'Erreur'}</h3>
          <p style="margin: 0; font-size: 14px;">${this._escapeHtml(message)}</p>
          <button class="btn btn-primary" onclick="instrumentManagementPageInstance.refresh()" style="margin-top: 16px;">
            ${i18n.t('instrumentManagement.retry') || 'Réessayer'}
          </button>
        </div>
      `;
    }
  }

  /**
   * Ferme la page
   */
  close() {
    if (this.modal) {
      this.modal.remove();
      this.modal = null;
    }

    window.instrumentManagementPageInstance = null;
  }
}

// Rendre disponible globalement
window.InstrumentManagementPage = InstrumentManagementPage;
