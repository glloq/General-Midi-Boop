/**
 * LightingControlPage
 *
 * Page complete de gestion du systeme de controle lumiere :
 * - Liste des dispositifs lumineux (LED GPIO, bandeaux serial, etc.)
 * - Regles d'activation basees sur les evenements MIDI
 * - Criteres : velocite, CC, note, canal MIDI
 * - Couleurs RGB libres avec color picker + gradient velocite
 * - Presets de configuration (save/load/delete)
 * - Support dark mode + responsive mobile
 */

class LightingControlPage {
  constructor(apiClient) {
    this.apiClient = apiClient;
    this._escapeHtml = window.escapeHtml || ((text) => {
      if (text == null) return '';
      const div = document.createElement('div');
      div.textContent = String(text);
      return div.innerHTML;
    });
    this.modal = null;
    this.devices = [];
    this.rules = [];
    this.instruments = [];
    this.presets = [];
    this.selectedDeviceId = null;
    this.mobilePanelView = 'devices'; // 'devices' or 'rules'
  }

  // ==================== THEME DETECTION ====================

  _isDark() {
    return document.body.classList.contains('theme-dark');
  }

  // ==================== TOAST & CONFIRM ====================

  showToast(message, type = 'info') {
    const icons = { success: '✓', error: '✗', info: 'ℹ', warning: '⚠' };
    const toast = document.createElement('div');
    toast.className = `lighting-toast lighting-toast--${type}`;
    toast.innerHTML = `<span class="lighting-toast-icon">${icons[type] || 'ℹ'}</span> ${this._escapeHtml(message)}`;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('lighting-toast--visible'));
    setTimeout(() => {
      toast.classList.remove('lighting-toast--visible');
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  _confirm(message) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'lighting-form-overlay';
      overlay.style.zIndex = '10020';
      overlay.innerHTML = `
        <div class="lighting-confirm-dialog">
          <div class="lighting-confirm-icon">⚠️</div>
          <p class="lighting-confirm-message">${this._escapeHtml(message)}</p>
          <div class="lighting-confirm-actions">
            <button class="lighting-btn lighting-btn--secondary" style="min-width:80px;font-size:13px;" id="_lcpConfirmNo">Annuler</button>
            <button class="lighting-btn lighting-btn--danger" style="min-width:80px;font-size:13px;" id="_lcpConfirmYes">Confirmer</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      overlay.querySelector('#_lcpConfirmYes').onclick = () => { overlay.remove(); resolve(true); };
      overlay.querySelector('#_lcpConfirmNo').onclick = () => { overlay.remove(); resolve(false); };
      overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
    });
  }

  _t(vars) {
    const d = this._isDark();
    return {
      bg: d ? '#1e1e1e' : 'white',
      bgAlt: d ? '#2d2d2d' : '#f9fafb',
      bgHover: d ? '#353535' : '#fefce8',
      bgSelected: d ? '#3d3520' : '#fefce8',
      borderSelected: d ? '#eab308' : '#eab308',
      border: d ? '#404040' : '#e5e7eb',
      borderLight: d ? '#333' : '#e5e7eb',
      text: d ? '#e0e0e0' : '#333',
      textSec: d ? '#aaa' : '#666',
      textMuted: d ? '#777' : '#999',
      cardBg: d ? '#2d2d2d' : 'white',
      cardHeader: d ? '#353535' : '#f9fafb',
      inputBg: d ? '#3d3d3d' : 'white',
      inputBorder: d ? '#555' : '#d1d5db',
      inputText: d ? '#e0e0e0' : '#333',
      btnBg: d ? '#3d3d3d' : 'white',
      btnBorder: d ? '#555' : '#d1d5db',
      headerRulesBg: d ? '#3d3520' : '#fefce8',
      ...vars
    };
  }

  // ==================== SHOW / CLOSE ====================

  async show() {
    this.createModal();
    await this.loadData();
    // Global ref needed for onclick handlers in mixin-generated HTML
    // TODO: migrate remaining mixin onclick handlers to event delegation
    window.lightingControlPageInstance = this;
  }

  close() {
    // Cleanup ResizeObserver
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }

    // Cleanup keyboard handler
    if (this._escHandler) {
      document.removeEventListener('keydown', this._escHandler);
      this._escHandler = null;
    }

    // Remove any open sub-panels
    ['lightingDeviceForm', 'lightingRuleForm', 'lightingPresetsPanel',
     'lightingEffectsPanel', 'lightingGroupsPanel', 'lightingScanPanel',
     'lightingColorWheel'].forEach(id => {
      document.getElementById(id)?.remove();
    });

    // Remove modal
    if (this.modal) {
      this.modal.remove();
      this.modal = null;
    }

    // Restore body scroll
    document.body.style.overflow = '';

    // Clean global ref
    if (window.lightingControlPageInstance === this) {
      delete window.lightingControlPageInstance;
    }
  }

  // ==================== MODAL CREATION ====================

  createModal() {
    if (this.modal) this.close();

    const div = document.createElement('div');
    div.innerHTML = `
      <div class="lighting-modal-overlay">
        <div class="lighting-modal-container">

          <!-- Header -->
          <div class="lighting-modal-header">
            <div class="lighting-header-row">
              <h2>💡 ${i18n.t('lighting.title') || 'Contrôle Lumière'}</h2>
              <div class="lighting-header-actions">
                <button class="lighting-header-btn" data-action="showEffectsPanel">⚡ ${i18n.t('lighting.effects') || 'Effets'}</button>
                <button class="lighting-header-btn" data-action="showGroupsPanel">🔗 ${i18n.t('lighting.groups') || 'Groupes'}</button>
                <button class="lighting-header-btn" data-action="showPresetsPanel">📦 ${i18n.t('lighting.presets') || 'Presets'}</button>
                <button class="lighting-header-btn lighting-header-btn--danger" data-action="blackout">🚫 Blackout</button>
                <button class="lighting-header-btn" data-action="allOff">⏹ ${i18n.t('lighting.allOff') || 'Tout éteindre'}</button>
                <button class="lighting-header-close" data-action="close">×</button>
              </div>
            </div>
            <!-- Mobile tab bar -->
            <div id="lightingMobileTabs" class="lighting-mobile-tabs">
              <button id="lightingTabDevices" class="lighting-mobile-tab lighting-mobile-tab--active" data-action="showMobilePanel" data-panel="devices">📋 Dispositifs</button>
              <button id="lightingTabRules" class="lighting-mobile-tab" data-action="showMobilePanel" data-panel="rules">📐 Règles</button>
            </div>
          </div>

          <!-- Keyboard Shortcuts Bar -->
          <div class="lighting-shortcuts-bar">
            <span>⌨️ Raccourcis:</span>
            <span><kbd>Espace</kbd> Blackout</span>
            <span><kbd>O</kbd> All Off</span>
            <span><kbd>T</kbd> Test</span>
            <span><kbd>Esc</kbd> Fermer</span>
          </div>

          <!-- Master Dimmer Bar -->
          <div class="lighting-dimmer-bar">
            <span class="lighting-dimmer-label">🔆 Master</span>
            <input id="lightingMasterDimmer" type="range" min="0" max="255" value="255" data-action="masterDimmer">
            <span id="lightingMasterDimmerVal" class="lighting-dimmer-val">100%</span>
          </div>

          <!-- Body: two-panel layout -->
          <div id="lightingBody" class="lighting-body">

            <!-- Left panel: Device list -->
            <div id="lightingDevicePanel" class="lighting-device-panel">
              <div class="lighting-device-panel-header">
                <span class="lighting-device-panel-title">📋 ${i18n.t('lighting.devices') || 'Dispositifs'}</span>
                <button class="lighting-btn--scan" data-action="scanDevices" title="Scanner le réseau">🔍</button>
                <button class="lighting-btn--outline lighting-btn--outline-yellow" data-action="showAddDeviceForm" style="padding:4px 10px;font-size:12px;">+ ${i18n.t('lighting.addDevice') || 'Ajouter'}</button>
              </div>
              <div id="lightingDeviceList" class="lighting-device-list">
                <div class="lighting-empty-state">Chargement...</div>
              </div>
            </div>

            <!-- Right panel: Rules for selected device -->
            <div id="lightingRulesPanel" class="lighting-rules-panel">
              <div id="lightingRulesHeader" class="lighting-rules-header">
                <span class="lighting-rules-title" id="lightingRulesTitle">📐 ${i18n.t('lighting.selectDevice') || 'Sélectionnez un dispositif'}</span>
                <div id="lightingRulesActions" class="lighting-rules-actions">
                  <button data-action="reconnectDevice" id="lightingReconnectBtn" class="lighting-btn--outline lighting-btn--outline-yellow" style="display:none;">🔄 ${i18n.t('lighting.reconnect') || 'Reconnecter'}</button>
                  <button data-action="showEditDeviceForm" class="lighting-btn--outline lighting-btn--outline-purple">✏️ Modifier</button>
                  <button data-action="testDevice" class="lighting-btn--outline lighting-btn--outline-blue">🔦 ${i18n.t('lighting.testDevice') || 'Tester'}</button>
                  <button data-action="batchToggleRules" data-enabled="true" class="lighting-btn--mini" title="${i18n.t('lighting.enableAll') || 'Tout activer'}">✅All</button>
                  <button data-action="batchToggleRules" data-enabled="false" class="lighting-btn--mini" title="${i18n.t('lighting.disableAll') || 'Tout désactiver'}">⬜All</button>
                  <button data-action="showAddRuleForm" class="lighting-btn--outline lighting-btn--outline-green">+ ${i18n.t('lighting.addRule') || 'Règle'}</button>
                </div>
              </div>
              <!-- LED Preview Strip -->
              <div id="lightingLedPreview" class="lighting-led-preview">
                <div class="lighting-led-preview-header">
                  <span class="lighting-led-preview-label">LED Preview</span>
                  <button data-action="_testPreviewRainbow" class="lighting-btn--mini">🌈 Test</button>
                  <button data-action="_clearPreview" class="lighting-btn--mini">⬛ Clear</button>
                </div>
                <div id="lightingLedStripViz" class="lighting-led-strip-viz"></div>
              </div>
              <div id="lightingRulesList" class="lighting-rules-list">
                <div class="lighting-empty-state" style="padding:40px;font-size:13px;">
                  ← ${i18n.t('lighting.selectDeviceHint') || 'Sélectionnez un dispositif pour voir ses règles'}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    this.modal = div.firstElementChild;
    document.body.appendChild(this.modal);

    // Event delegation for data-action buttons
    this._setupEventDelegation();

    // Keyboard shortcuts
    this._escHandler = (e) => {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === 'Escape') this.close();
      else if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); this.blackout(); }
      else if (e.key === 'b' || e.key === 'B') this.blackout();
      else if (e.key === 'o' || e.key === 'O') this.allOff();
      else if (e.key === 't' || e.key === 'T') this.testDevice();
    };
    document.addEventListener('keydown', this._escHandler);

    // Close on overlay click
    this.modal.addEventListener('click', (e) => { if (e.target === this.modal) this.close(); });

    // Responsive
    this._checkResponsive();
    this._resizeObserver = new ResizeObserver(() => this._checkResponsive());
    this._resizeObserver.observe(this.modal.querySelector('.lighting-modal-container'));
  }

  // ==================== EVENT DELEGATION ====================

  _setupEventDelegation() {
    if (!this.modal) return;

    // Click delegation
    this.modal.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;

      // Simple actions (no params)
      const simpleMethods = [
        'showEffectsPanel', 'showGroupsPanel', 'showPresetsPanel',
        'blackout', 'allOff', 'close', 'testDevice',
        'showAddDeviceForm', 'showEditDeviceForm', 'showAddRuleForm',
        'scanDevices', 'reconnectDevice',
        '_testPreviewRainbow', '_clearPreview'
      ];
      if (simpleMethods.includes(action) && typeof this[action] === 'function') {
        this[action]();
        return;
      }

      // Parameterized actions
      if (action === 'showMobilePanel') {
        this.showMobilePanel(btn.dataset.panel);
      } else if (action === 'batchToggleRules') {
        this.batchToggleRules(btn.dataset.enabled === 'true');
      } else if (action === 'selectDevice') {
        this.selectDevice(parseInt(btn.dataset.id));
      } else if (action === 'deleteDevice') {
        e.stopPropagation();
        this.deleteDevice(parseInt(btn.dataset.id));
      } else if (action === 'cloneDevice') {
        e.stopPropagation();
        this.cloneDevice(parseInt(btn.dataset.id));
      } else if (action === 'testRule') {
        this.testRule(parseInt(btn.dataset.id));
      } else if (action === 'editRule') {
        this.editRule(parseInt(btn.dataset.id));
      } else if (action === 'cloneRule') {
        this.cloneRule(parseInt(btn.dataset.id));
      } else if (action === 'deleteRule') {
        this.deleteRule(parseInt(btn.dataset.id));
      } else if (action === 'toggleRule') {
        this.toggleRule(parseInt(btn.dataset.id), btn.dataset.enabled === 'true');
      } else if (action === 'moveRulePriority') {
        this.moveRulePriority(parseInt(btn.dataset.id), parseInt(btn.dataset.delta));
      }
    });

    // Master dimmer input
    const dimmer = this.modal.querySelector('#lightingMasterDimmer');
    if (dimmer) {
      dimmer.addEventListener('input', () => this._onMasterDimmerChange(dimmer.value));
    }
  }

  _checkResponsive() {
    const container = this.modal?.querySelector('.lighting-modal-container');
    if (!container) return;
    const w = container.offsetWidth;
    const tabs = document.getElementById('lightingMobileTabs');
    const devicePanel = document.getElementById('lightingDevicePanel');
    const rulesPanel = document.getElementById('lightingRulesPanel');

    if (w < 640) {
      if (tabs) tabs.style.display = 'flex';
      if (this.mobilePanelView === 'devices') {
        if (devicePanel) { devicePanel.style.display = 'flex'; devicePanel.style.width = '100%'; devicePanel.style.minWidth = '0'; devicePanel.style.borderRight = 'none'; }
        if (rulesPanel) rulesPanel.style.display = 'none';
      } else {
        if (devicePanel) devicePanel.style.display = 'none';
        if (rulesPanel) rulesPanel.style.display = 'flex';
      }
    } else {
      if (tabs) tabs.style.display = 'none';
      if (devicePanel) { devicePanel.style.display = 'flex'; devicePanel.style.width = ''; devicePanel.style.minWidth = ''; devicePanel.style.borderRight = ''; }
      if (rulesPanel) rulesPanel.style.display = 'flex';
    }
  }

  showMobilePanel(panel) {
    this.mobilePanelView = panel;
    const tabD = document.getElementById('lightingTabDevices');
    const tabR = document.getElementById('lightingTabRules');
    if (tabD) {
      tabD.classList.toggle('lighting-mobile-tab--active', panel === 'devices');
    }
    if (tabR) {
      tabR.classList.toggle('lighting-mobile-tab--active', panel === 'rules');
    }
    this._checkResponsive();
  }

  // ==================== DATA LOADING ====================

  async loadData() {
    try {
      const [devicesRes, instrumentsRes, presetsRes] = await Promise.all([
        this.apiClient.sendCommand('lighting_device_list'),
        this.apiClient.sendCommand('instrument_list_registered'),
        this.apiClient.sendCommand('lighting_preset_list')
      ]);

      this.devices = devicesRes.devices || [];
      this.instruments = instrumentsRes.instruments || [];
      this.presets = presetsRes.presets || [];
      this.renderDeviceList();

      if (this.selectedDeviceId) {
        await this.loadRulesForDevice(this.selectedDeviceId);
      }
    } catch (error) {
      console.error('Failed to load lighting data:', error);
    }
  }

  async loadRulesForDevice(deviceId) {
    try {
      const res = await this.apiClient.sendCommand('lighting_rule_list', { device_id: deviceId });
      this.rules = res.rules || [];
      this.renderRulesList();
    } catch (error) {
      console.error('Failed to load rules:', error);
    }
  }

  // _safeColor is provided by LightingHelpersMixin

  async _createGroup() {
    const name = document.getElementById('lgFormName')?.value.trim();
    if (!name) { this.showToast('Nom requis', 'warning'); return; }
    const checkboxes = document.querySelectorAll('#lightingGroupsPanel .lgDeviceCb:checked');
    const deviceIds = [...checkboxes].map(cb => parseInt(cb.value));
    if (deviceIds.length === 0) { this.showToast('Sélectionnez au moins un dispositif', 'warning'); return; }

    try {
      await this.apiClient.sendCommand('lighting_group_create', { name, device_ids: deviceIds });
      this.showGroupsPanel();
    } catch (error) { this.showToast(error.message, 'error'); }
  }

  async _deleteGroupByIdx(idx) {
    const name = this._groupNames?.[idx];
    if (!name) return;
    if (!await this._confirm(`Supprimer le groupe "${name}" ?`)) return;
    try {
      await this.apiClient.sendCommand('lighting_group_delete', { name });
      this.showGroupsPanel();
    } catch (error) { this.showToast(error.message, 'error'); }
  }

  async _setGroupColorByIdx(idx) {
    const name = this._groupNames?.[idx];
    if (!name) return;
    const colorInput = document.querySelector(`.lg-color-input[data-group-idx="${idx}"]`);
    const color = colorInput?.value || '#FF0000';
    try {
      await this.apiClient.sendCommand('lighting_group_color', { name, color, brightness: 255 });
    } catch (error) { this.showToast(error.message, 'error'); }
  }

  async _groupOffByIdx(idx) {
    const name = this._groupNames?.[idx];
    if (!name) return;
    try {
      await this.apiClient.sendCommand('lighting_group_off', { name });
    } catch (error) { this.showToast(error.message, 'error'); }
  }

  // ==================== DEVICE CLONE ====================

  async cloneDevice(deviceId) {
    const device = this.devices.find(d => d.id === deviceId);
    if (!device) return;

    try {
      await this.apiClient.sendCommand('lighting_device_add', {
        name: device.name + ' (copie)',
        type: device.type,
        led_count: device.led_count,
        connection_config: device.connection_config,
        enabled: false // Start disabled to avoid conflicts
      });
      await this.loadData();
    } catch (error) { this.showToast(error.message, 'error'); }
  }

  async _startLiveEffect() {
    if (!this.selectedDeviceId) return;
    const effectType = document.getElementById('leFormEffect')?.value;
    const color = document.getElementById('leFormColor')?.value || '#FF0000';
    const speed = parseInt(document.getElementById('leFormSpeed')?.value) || 500;
    const brightness = parseInt(document.getElementById('leFormBri')?.value) || 255;

    try {
      await this.apiClient.sendCommand('lighting_effect_start', {
        device_id: this.selectedDeviceId,
        effect_type: effectType,
        color, speed, brightness
      });
      // Refresh the panel
      this.showEffectsPanel();
    } catch (error) {
      this.showToast(error.message, 'error');
    }
  }

  async _tapTempo() {
    try {
      const res = await this.apiClient.sendCommand('lighting_bpm_tap');
      const bpmEl = document.getElementById('leEffectBpm');
      const inputEl = document.getElementById('leEffectBpmInput');
      if (bpmEl) bpmEl.textContent = res.bpm;
      if (inputEl) inputEl.value = res.bpm;
    } catch (e) { /* ignore */ }
  }

  async _setBpm(value) {
    try {
      const res = await this.apiClient.sendCommand('lighting_bpm_set', { bpm: parseInt(value) });
      const bpmEl = document.getElementById('leEffectBpm');
      if (bpmEl) bpmEl.textContent = res.bpm;
    } catch (e) { /* ignore */ }
  }

  async _stopLiveEffect(effectKey) {
    try {
      await this.apiClient.sendCommand('lighting_effect_stop', { effect_key: effectKey });
      this.showEffectsPanel();
    } catch (error) {
      this.showToast(error.message, 'error');
    }
  }

  async exportRules() {
    try {
      const res = await this.apiClient.sendCommand('lighting_rules_export', {
        device_id: this.selectedDeviceId || undefined
      });
      const json = JSON.stringify(res.export_data, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `lighting-rules-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) { this.showToast(error.message, 'error'); }
  }

  async savePreset() {
    const name = document.getElementById('lpFormName')?.value.trim();
    if (!name) { this.showToast(i18n.t('lighting.presetName') || 'Nom requis', 'warning'); return; }
    try {
      await this.apiClient.sendCommand('lighting_preset_save', { name });
      document.getElementById('lightingPresetsPanel')?.remove();
      const res = await this.apiClient.sendCommand('lighting_preset_list');
      this.presets = res.presets || [];
      this.showPresetsPanel();
    } catch (error) {
      this.showToast(error.message, 'error');
    }
  }

  async loadPreset(id) {
    if (!await this._confirm(i18n.t('lighting.confirmLoadPreset') || 'Charger ce preset ? Les règles actuelles seront remplacées.')) return;
    try {
      await this.apiClient.sendCommand('lighting_preset_load', { id });
      document.getElementById('lightingPresetsPanel')?.remove();
      await this.loadData();
    } catch (error) {
      this.showToast(error.message, 'error');
    }
  }

  async deletePreset(id) {
    if (!await this._confirm(i18n.t('lighting.confirmDeletePreset') || 'Supprimer ce preset ?')) return;
    try {
      await this.apiClient.sendCommand('lighting_preset_delete', { id });
      document.getElementById('lightingPresetsPanel')?.remove();
      const res = await this.apiClient.sendCommand('lighting_preset_list');
      this.presets = res.presets || [];
      this.showPresetsPanel();
    } catch (error) {
      this.showToast(error.message, 'error');
    }
  }

  async saveScene() {
    const name = document.getElementById('lpSceneName')?.value.trim();
    if (!name) { this.showToast(i18n.t('lighting.sceneName') || 'Nom requis', 'warning'); return; }
    try {
      await this.apiClient.sendCommand('lighting_scene_save', { name });
      this.showToast(`Scène "${name}" sauvegardée`, 'success');
      document.getElementById('lightingPresetsPanel')?.remove();
      const res = await this.apiClient.sendCommand('lighting_preset_list');
      this.presets = res.presets || [];
    } catch (error) {
      this.showToast(error.message, 'error');
    }
  }

  async _loadDmxProfiles(deviceType) {
    const selectId = deviceType === 'artnet' ? 'ldFormArtnetProfile' : 'ldFormSacnProfile';
    const select = document.getElementById(selectId);
    if (!select) return;

    try {
      if (!this._dmxProfiles) {
        const res = await this.apiClient.sendCommand('lighting_dmx_profiles');
        this._dmxProfiles = res.profiles || [];
      }

      select.innerHTML = '<option value="">-- Manuel --</option>' +
        this._dmxProfiles.map(p =>
          `<option value="${this._escapeHtml(p.key)}">${this._escapeHtml(p.name)} (${p.channels}ch)</option>`
        ).join('');
    } catch (e) { /* ignore - profiles not available */ }
  }

  _onDmxProfileChange(deviceType) {
    const selectId = deviceType === 'artnet' ? 'ldFormArtnetProfile' : 'ldFormSacnProfile';
    const channelsId = deviceType === 'artnet' ? 'ldFormArtnetChannels' : 'ldFormSacnChannels';
    const select = document.getElementById(selectId);
    const channelsInput = document.getElementById(channelsId);
    if (!select || !channelsInput || !this._dmxProfiles) return;

    const profile = this._dmxProfiles.find(p => p.key === select.value);
    if (profile) {
      channelsInput.value = profile.channels;
    }
  }

  _onStripChannelChange(selectEl) {
    const ch = parseInt(selectEl.value);
    const gpioSelect = selectEl.closest('.strip-entry').querySelector('.strip-gpio');
    const gpioMap = { 0: [18, 12], 1: [13, 19], 2: [10] };
    const pins = gpioMap[ch] || [];
    gpioSelect.innerHTML = pins.map((p, i) => `<option value="${p}" ${i === 0 ? 'selected' : ''}>GPIO ${p}</option>`).join('');
  }

  _addSegmentEntry() {
    const t = this._t();
    const container = document.getElementById('ldFormSegmentsContainer');
    if (!container) return;

    const entry = document.createElement('div');
    entry.className = 'segment-entry';
    entry.style.cssText = `display:flex;gap:6px;align-items:center;margin-bottom:6px;`;
    entry.innerHTML = `
      <input class="seg-name" type="text" placeholder="Nom" style="flex:1;padding:5px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:11px;background:${t.inputBg};color:${t.inputText};">
      <input class="seg-start" type="number" min="0" value="0" placeholder="Début" style="width:55px;padding:5px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:11px;background:${t.inputBg};color:${t.inputText};">
      <input class="seg-end" type="number" min="0" value="0" placeholder="Fin" style="width:55px;padding:5px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:11px;background:${t.inputBg};color:${t.inputText};">
      <button type="button" onclick="this.closest('.segment-entry').remove()" style="padding:2px 6px;border:none;background:none;color:#ef4444;cursor:pointer;font-size:14px;">×</button>`;
    container.appendChild(entry);
  }

  async deleteDevice(id) {
    if (!await this._confirm(i18n.t('lighting.confirmDeleteDevice') || 'Supprimer ce dispositif et toutes ses règles ?')) return;
    try {
      await this.apiClient.sendCommand('lighting_device_delete', { id });
      if (this.selectedDeviceId === id) { this.selectedDeviceId = null; this.rules = []; }
      await this.loadData();
    } catch (error) {
      this.showToast(error.message, 'error');
    }
  }

  selectDevice(id) {
    this.selectedDeviceId = id;
    this.renderDeviceList();
    this.loadRulesForDevice(id);
    // On mobile, switch to rules panel
    if (this.modal?.querySelector('.lighting-modal-container')?.offsetWidth < 640) {
      this.showMobilePanel('rules');
    }
  }

  async reconnectDevice() {
    if (!this.selectedDeviceId) return;
    const btn = document.getElementById('lightingReconnectBtn');
    if (btn) { btn.textContent = `⏳ ${i18n.t('lighting.reconnecting') || 'Reconnexion...'}`; btn.disabled = true; }
    try {
      await this.apiClient.sendCommand('lighting_device_update', { id: this.selectedDeviceId, enabled: true });
      await this.loadData();
    } catch (error) {
      this.showToast(error.message, 'error');
    } finally {
      if (btn) { btn.textContent = `🔄 ${i18n.t('lighting.reconnect') || 'Reconnecter'}`; btn.disabled = false; }
    }
  }

  _populateSegmentDropdown(selectedSegment) {
    const device = this.devices.find(d => d.id === this.selectedDeviceId);
    const segRow = document.getElementById('lrFormSegmentRow');
    const segSelect = document.getElementById('lrFormSegment');
    if (!segRow || !segSelect || !device) return;

    if (device.type === 'gpio_strip' && device.connection_config?.segments?.length) {
      segRow.style.display = 'block';
      const segments = device.connection_config.segments;
      segSelect.innerHTML = '<option value="">-- Aucun (manuel) --</option>' +
        segments.map(s => `<option value="${this._escapeHtml(s.name)}" ${selectedSegment === s.name ? 'selected' : ''}>${this._escapeHtml(s.name)} (${s.start}-${s.end})</option>`).join('');
      if (selectedSegment) this._onSegmentSelect();
    } else {
      segRow.style.display = 'none';
    }
  }

  _onSegmentSelect() {
    const device = this.devices.find(d => d.id === this.selectedDeviceId);
    const segName = document.getElementById('lrFormSegment')?.value;
    if (!segName || !device?.connection_config?.segments) return;

    const seg = device.connection_config.segments.find(s => s.name === segName);
    if (seg) {
      const startEl = document.getElementById('lrFormLedStart');
      const endEl = document.getElementById('lrFormLedEnd');
      if (startEl) startEl.value = seg.start;
      if (endEl) endEl.value = seg.end;
    }
  }

  _updateActionFields() {
    const type = document.getElementById('lrFormActionType').value;
    const s = document.getElementById('lrFormStaticColor');
    const g = document.getElementById('lrFormGradientSection');
    const e = document.getElementById('lrFormEffectSection');
    const ct = document.getElementById('lrFormColorTempSection');
    const nc = document.getElementById('lrFormNoteColorSection');
    const isEffect = this._isEffectType(type);

    const nl = document.getElementById('lrFormNoteLedSection');

    // Color picker: show for most types, hide for special modes
    const hideColor = ['velocity_mapped', 'note_color', 'color_temp', 'random_color', 'note_led'].includes(type);
    if (s) s.style.display = hideColor ? 'none' : 'block';
    if (g) g.style.display = type === 'velocity_mapped' ? 'block' : 'none';
    if (e) e.style.display = isEffect ? 'block' : 'none';
    if (ct) ct.style.display = type === 'color_temp' ? 'block' : 'none';
    if (nc) nc.style.display = type === 'note_color' ? 'block' : 'none';
    if (nl) nl.style.display = type === 'note_led' ? 'block' : 'none';
  }

  // _isEffectType is provided by LightingHelpersMixin

  _updateGradientPreview() {
    const low = document.getElementById('lrFormColorLow')?.value || '#0000FF';
    const mid = document.getElementById('lrFormColorMid')?.value || '#FFFF00';
    const high = document.getElementById('lrFormColorHigh')?.value || '#FF0000';
    const preview = document.getElementById('lrFormGradientPreview');
    if (preview) preview.style.background = `linear-gradient(to right,${low},${mid},${high})`;
  }

  // _clamp is provided by LightingHelpersMixin

  async editRule(ruleId) {
    const rule = this.rules.find(r => r.id === ruleId);
    if (rule) this.showAddRuleForm(rule);
  }

  async cloneRule(ruleId) {
    const rule = this.rules.find(r => r.id === ruleId);
    if (!rule) return;
    try {
      await this.apiClient.sendCommand('lighting_rule_add', {
        device_id: this.selectedDeviceId,
        name: (rule.name || 'Rule') + ' (copie)',
        instrument_id: rule.instrument_id,
        priority: rule.priority,
        enabled: false,
        condition_config: rule.condition_config,
        action_config: rule.action_config
      });
      await this.loadRulesForDevice(this.selectedDeviceId);
    } catch (error) { this.showToast(error.message, 'error'); }
  }

  async deleteRule(id) {
    if (!await this._confirm(i18n.t('lighting.confirmDeleteRule') || 'Supprimer cette règle ?')) return;
    try {
      await this.apiClient.sendCommand('lighting_rule_delete', { id });
      await this.loadRulesForDevice(this.selectedDeviceId);
    } catch (error) { this.showToast(error.message, 'error'); }
  }

  async toggleRule(id, enabled) {
    try {
      await this.apiClient.sendCommand('lighting_rule_update', { id, enabled });
      await this.loadRulesForDevice(this.selectedDeviceId);
    } catch (error) { this.showToast(error.message, 'error'); }
  }

  async batchToggleRules(enabled) {
    try {
      const updates = this.rules
        .filter(rule => rule.enabled !== enabled)
        .map(rule => this.apiClient.sendCommand('lighting_rule_update', { id: rule.id, enabled }));
      await Promise.all(updates);
      await this.loadRulesForDevice(this.selectedDeviceId);
    } catch (error) { this.showToast(error.message, 'error'); }
  }

  async moveRulePriority(id, delta) {
    const rule = this.rules.find(r => r.id === id);
    if (!rule) return;
    const newPriority = (rule.priority || 0) + delta;
    try {
      await this.apiClient.sendCommand('lighting_rule_update', { id, priority: newPriority });
      await this.loadRulesForDevice(this.selectedDeviceId);
    } catch (error) { this.showToast(error.message, 'error'); }
  }

  // Actions (testDevice, testRule, allOff, blackout, _onMasterDimmerChange)
  // are provided by LightingHelpersMixin

  // Helpers, LED preview, and color utilities are provided by LightingHelpersMixin
}

// ============================================================================
// MIXIN CONNECTION
// Apply mixins to the prototype. Mixins are loaded via <script> tags before
// this file. Methods defined directly on the class take precedence over mixin
// methods (they are applied first, class methods shadow them).
// ============================================================================
(function() {
  const mixins = [
    window.LightingHelpersMixin,
    window.LightingFormsMixin,
    window.LightingDeviceUIMixin,
    window.LightingPresetsUIMixin
  ];
  mixins.forEach(mixin => {
    if (!mixin) return;
    Object.keys(mixin).forEach(key => {
      // Only add mixin method if NOT already defined on the class prototype
      // This avoids overwriting class methods with mixin duplicates
      if (!LightingControlPage.prototype.hasOwnProperty(key)) {
        LightingControlPage.prototype[key] = mixin[key];
      }
    });
  });
})();
