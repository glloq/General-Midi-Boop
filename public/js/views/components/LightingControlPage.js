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
    const colors = {
      success: { bg: '#10b981', text: 'white' },
      error: { bg: '#ef4444', text: 'white' },
      info: { bg: '#3b82f6', text: 'white' },
      warning: { bg: '#f59e0b', text: 'white' }
    };
    const style = colors[type] || colors.info;
    const toast = document.createElement('div');
    toast.style.cssText = `position:fixed;top:24px;right:24px;z-index:10020;padding:12px 20px;border-radius:10px;background:${style.bg};color:${style.text};font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,0.25);display:flex;align-items:center;gap:8px;max-width:400px;opacity:0;transform:translateY(-10px);transition:all 0.25s ease;`;
    toast.innerHTML = `<span style="font-weight:bold;font-size:16px;">${icons[type] || 'ℹ'}</span> ${this._escapeHtml(message)}`;
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateY(0)'; });
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-10px)';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  _confirm(message) {
    const t = this._t();
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:10020;display:flex;align-items:center;justify-content:center;`;
      overlay.innerHTML = `
        <div style="background:${t.bg};border-radius:12px;padding:24px;width:380px;max-width:90vw;box-shadow:0 20px 60px rgba(0,0,0,0.3);text-align:center;">
          <div style="font-size:32px;margin-bottom:12px;">⚠️</div>
          <p style="margin:0 0 20px;font-size:14px;color:${t.text};line-height:1.5;">${this._escapeHtml(message)}</p>
          <div style="display:flex;gap:10px;justify-content:center;">
            <button id="_lcpConfirmNo" style="padding:8px 20px;border:1px solid ${t.btnBorder};border-radius:8px;background:${t.btnBg};color:${t.text};cursor:pointer;font-size:13px;min-width:80px;">Annuler</button>
            <button id="_lcpConfirmYes" style="padding:8px 20px;border:none;border-radius:8px;background:#ef4444;color:white;cursor:pointer;font-size:13px;font-weight:600;min-width:80px;">Confirmer</button>
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
    window.lightingControlPageInstance = this;
  }

  close() {
    if (this.modal) {
      this.modal.remove();
      this.modal = null;
    }
    if (this._escHandler) {
      document.removeEventListener('keydown', this._escHandler);
    }
  }

  // ==================== MODAL CREATION ====================

  createModal() {
    if (this.modal) this.modal.remove();
    const t = this._t();

    const div = document.createElement('div');
    div.innerHTML = `
      <div class="lighting-modal-overlay" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;">
        <div class="lighting-modal-container" style="background:${t.bg};border-radius:12px;width:95%;max-width:1400px;height:90vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.3);overflow:hidden;">

          <!-- Header -->
          <div style="padding:14px 20px;background:linear-gradient(135deg,#eab308 0%,#f59e0b 50%,#d97706 100%);color:white;flex-shrink:0;">
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
              <h2 style="margin:0;font-size:20px;white-space:nowrap;">💡 ${i18n.t('lighting.title') || 'Contrôle Lumière'}</h2>
              <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                <button onclick="lightingControlPageInstance.showEffectsPanel()" style="padding:5px 12px;border:2px solid rgba(255,255,255,0.4);border-radius:8px;background:rgba(255,255,255,0.15);color:white;cursor:pointer;font-size:12px;">⚡ ${i18n.t('lighting.effects') || 'Effets'}</button>
                <button onclick="lightingControlPageInstance.showGroupsPanel()" style="padding:5px 12px;border:2px solid rgba(255,255,255,0.4);border-radius:8px;background:rgba(255,255,255,0.15);color:white;cursor:pointer;font-size:12px;">🔗 ${i18n.t('lighting.groups') || 'Groupes'}</button>
                <button onclick="lightingControlPageInstance.showPresetsPanel()" style="padding:5px 12px;border:2px solid rgba(255,255,255,0.4);border-radius:8px;background:rgba(255,255,255,0.15);color:white;cursor:pointer;font-size:12px;">📦 ${i18n.t('lighting.presets') || 'Presets'}</button>
                <button onclick="lightingControlPageInstance.blackout()" style="padding:5px 12px;border:2px solid rgba(255,100,100,0.6);border-radius:8px;background:rgba(255,50,50,0.3);color:white;cursor:pointer;font-size:12px;font-weight:700;">🚫 Blackout</button>
                <button onclick="lightingControlPageInstance.allOff()" style="padding:5px 12px;border:2px solid rgba(255,255,255,0.4);border-radius:8px;background:rgba(255,255,255,0.15);color:white;cursor:pointer;font-size:12px;">⏹ ${i18n.t('lighting.allOff') || 'Tout éteindre'}</button>
                <button onclick="lightingControlPageInstance.close()" style="background:rgba(255,255,255,0.2);border:none;color:white;font-size:22px;cursor:pointer;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;">×</button>
              </div>
            </div>
            <!-- Mobile tab bar -->
            <div id="lightingMobileTabs" style="display:none;margin-top:8px;gap:4px;">
              <button id="lightingTabDevices" onclick="lightingControlPageInstance.showMobilePanel('devices')" style="flex:1;padding:6px;border:none;border-radius:6px;background:rgba(255,255,255,0.3);color:white;cursor:pointer;font-size:12px;font-weight:600;">📋 Dispositifs</button>
              <button id="lightingTabRules" onclick="lightingControlPageInstance.showMobilePanel('rules')" style="flex:1;padding:6px;border:none;border-radius:6px;background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.7);cursor:pointer;font-size:12px;">📐 Règles</button>
            </div>
          </div>

          <!-- Keyboard Shortcuts Bar -->
          <div style="padding:3px 20px;background:${t.bgAlt};border-bottom:1px solid ${t.border};display:flex;align-items:center;gap:16px;flex-shrink:0;font-size:10px;color:${t.textMuted};">
            <span>⌨️ Raccourcis:</span>
            <span><kbd style="padding:1px 4px;border:1px solid ${t.borderLight};border-radius:3px;background:${t.cardBg};font-size:10px;">Espace</kbd> Blackout</span>
            <span><kbd style="padding:1px 4px;border:1px solid ${t.borderLight};border-radius:3px;background:${t.cardBg};font-size:10px;">O</kbd> All Off</span>
            <span><kbd style="padding:1px 4px;border:1px solid ${t.borderLight};border-radius:3px;background:${t.cardBg};font-size:10px;">T</kbd> Test</span>
            <span><kbd style="padding:1px 4px;border:1px solid ${t.borderLight};border-radius:3px;background:${t.cardBg};font-size:10px;">Esc</kbd> Fermer</span>
          </div>

          <!-- Master Dimmer Bar -->
          <div style="padding:6px 20px;background:${t.bgAlt};border-bottom:1px solid ${t.border};display:flex;align-items:center;gap:10px;flex-shrink:0;">
            <span style="font-size:11px;font-weight:600;color:${t.textSec};white-space:nowrap;">🔆 Master</span>
            <input id="lightingMasterDimmer" type="range" min="0" max="255" value="255" style="flex:1;height:6px;" oninput="lightingControlPageInstance._onMasterDimmerChange(this.value)">
            <span id="lightingMasterDimmerVal" style="font-size:11px;color:${t.textSec};min-width:35px;text-align:right;">100%</span>
          </div>

          <!-- Body: two-panel layout -->
          <div id="lightingBody" style="display:flex;flex:1;overflow:hidden;">

            <!-- Left panel: Device list -->
            <div id="lightingDevicePanel" style="width:300px;min-width:260px;border-right:2px solid ${t.border};display:flex;flex-direction:column;background:${t.bgAlt};">
              <div style="padding:10px 14px;border-bottom:1px solid ${t.border};display:flex;justify-content:space-between;align-items:center;">
                <span style="font-weight:600;font-size:13px;color:${t.text};">📋 ${i18n.t('lighting.devices') || 'Dispositifs'}</span>
                <button onclick="lightingControlPageInstance.scanDevices()" style="padding:4px 8px;border:1px solid #3b82f6;border-radius:6px;background:${t.btnBg};color:#2563eb;cursor:pointer;font-size:11px;" title="Scanner le réseau">🔍</button>
                <button onclick="lightingControlPageInstance.showAddDeviceForm()" style="padding:4px 10px;border:1px solid #eab308;border-radius:6px;background:${t.btnBg};color:#b45309;cursor:pointer;font-size:12px;">+ ${i18n.t('lighting.addDevice') || 'Ajouter'}</button>
              </div>
              <div id="lightingDeviceList" style="flex:1;overflow-y:auto;padding:6px;">
                <div style="padding:20px;text-align:center;color:${t.textMuted};">Chargement...</div>
              </div>
            </div>

            <!-- Right panel: Rules for selected device -->
            <div id="lightingRulesPanel" style="flex:1;display:flex;flex-direction:column;overflow:hidden;">
              <div id="lightingRulesHeader" style="padding:10px 14px;border-bottom:1px solid ${t.border};display:flex;justify-content:space-between;align-items:center;background:${t.headerRulesBg};flex-wrap:wrap;gap:6px;">
                <span style="font-weight:600;font-size:13px;color:${t.text};" id="lightingRulesTitle">📐 ${i18n.t('lighting.selectDevice') || 'Sélectionnez un dispositif'}</span>
                <div id="lightingRulesActions" style="display:none;gap:6px;flex-wrap:wrap;">
                  <button onclick="lightingControlPageInstance.reconnectDevice()" id="lightingReconnectBtn" style="display:none;padding:4px 8px;border:1px solid #f59e0b;border-radius:6px;background:${t.btnBg};color:#d97706;cursor:pointer;font-size:11px;">🔄 ${i18n.t('lighting.reconnect') || 'Reconnecter'}</button>
                  <button onclick="lightingControlPageInstance.showEditDeviceForm()" style="padding:4px 8px;border:1px solid #8b5cf6;border-radius:6px;background:${t.btnBg};color:#7c3aed;cursor:pointer;font-size:11px;">✏️ Modifier</button>
                  <button onclick="lightingControlPageInstance.testDevice()" style="padding:4px 8px;border:1px solid #3b82f6;border-radius:6px;background:${t.btnBg};color:#2563eb;cursor:pointer;font-size:11px;">🔦 ${i18n.t('lighting.testDevice') || 'Tester'}</button>
                  <button onclick="lightingControlPageInstance.batchToggleRules(true)" style="padding:4px 6px;border:1px solid ${t.borderLight};border-radius:4px;background:none;color:${t.textMuted};cursor:pointer;font-size:9px;" title="${i18n.t('lighting.enableAll') || 'Tout activer'}">✅All</button>
                  <button onclick="lightingControlPageInstance.batchToggleRules(false)" style="padding:4px 6px;border:1px solid ${t.borderLight};border-radius:4px;background:none;color:${t.textMuted};cursor:pointer;font-size:9px;" title="${i18n.t('lighting.disableAll') || 'Tout désactiver'}">⬜All</button>
                  <button onclick="lightingControlPageInstance.showAddRuleForm()" style="padding:4px 8px;border:1px solid #10b981;border-radius:6px;background:${t.btnBg};color:#059669;cursor:pointer;font-size:11px;">+ ${i18n.t('lighting.addRule') || 'Règle'}</button>
                </div>
              </div>
              <!-- LED Preview Strip -->
              <div id="lightingLedPreview" style="display:none;padding:6px 14px;border-bottom:1px solid ${t.borderLight};background:${t.bgAlt};">
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
                  <span style="font-size:10px;font-weight:600;color:${t.textMuted};">LED Preview</span>
                  <button onclick="lightingControlPageInstance._testPreviewRainbow()" style="padding:1px 6px;border:1px solid ${t.borderLight};border-radius:4px;background:none;color:${t.textMuted};cursor:pointer;font-size:9px;">🌈 Test</button>
                  <button onclick="lightingControlPageInstance._clearPreview()" style="padding:1px 6px;border:1px solid ${t.borderLight};border-radius:4px;background:none;color:${t.textMuted};cursor:pointer;font-size:9px;">⬛ Clear</button>
                </div>
                <div id="lightingLedStripViz" style="display:flex;gap:1px;flex-wrap:wrap;min-height:10px;"></div>
              </div>
              <div id="lightingRulesList" style="flex:1;overflow-y:auto;padding:10px;">
                <div style="padding:40px;text-align:center;color:${t.textMuted};font-size:13px;">
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

    this._escHandler = (e) => {
      // Don't trigger shortcuts if typing in input
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === 'Escape') this.close();
      else if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); this.blackout(); }
      else if (e.key === 'b' || e.key === 'B') this.blackout();
      else if (e.key === 'o' || e.key === 'O') this.allOff();
      else if (e.key === 't' || e.key === 'T') this.testDevice();
    };
    document.addEventListener('keydown', this._escHandler);
    this.modal.addEventListener('click', (e) => { if (e.target === this.modal) this.close(); });

    // Responsive: check width
    this._checkResponsive();
    this._resizeObserver = new ResizeObserver(() => this._checkResponsive());
    this._resizeObserver.observe(this.modal.querySelector('.lighting-modal-container'));
  }

  _checkResponsive() {
    const container = this.modal?.querySelector('.lighting-modal-container');
    if (!container) return;
    const w = container.offsetWidth;
    const tabs = document.getElementById('lightingMobileTabs');
    const devicePanel = document.getElementById('lightingDevicePanel');
    const rulesPanel = document.getElementById('lightingRulesPanel');

    if (w < 640) {
      // Mobile: show tabs, toggle panels
      if (tabs) tabs.style.display = 'flex';
      if (this.mobilePanelView === 'devices') {
        if (devicePanel) { devicePanel.style.display = 'flex'; devicePanel.style.width = '100%'; devicePanel.style.minWidth = '0'; devicePanel.style.borderRight = 'none'; }
        if (rulesPanel) rulesPanel.style.display = 'none';
      } else {
        if (devicePanel) devicePanel.style.display = 'none';
        if (rulesPanel) rulesPanel.style.display = 'flex';
      }
    } else {
      // Desktop: hide tabs, show both panels
      if (tabs) tabs.style.display = 'none';
      if (devicePanel) { devicePanel.style.display = 'flex'; devicePanel.style.width = '300px'; devicePanel.style.minWidth = '260px'; devicePanel.style.borderRight = `2px solid ${this._t().border}`; }
      if (rulesPanel) rulesPanel.style.display = 'flex';
    }
  }

  showMobilePanel(panel) {
    this.mobilePanelView = panel;
    const tabD = document.getElementById('lightingTabDevices');
    const tabR = document.getElementById('lightingTabRules');
    if (tabD && tabR) {
      tabD.style.background = panel === 'devices' ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.1)';
      tabD.style.color = panel === 'devices' ? 'white' : 'rgba(255,255,255,0.7)';
      tabR.style.background = panel === 'rules' ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.1)';
      tabR.style.color = panel === 'rules' ? 'white' : 'rgba(255,255,255,0.7)';
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

  _safeColor(c) {
    // Sanitize a color value for safe CSS injection (only allow hex colors)
    return /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '#888';
  }

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

  _isEffectType(type) {
    return ['strobe', 'rainbow', 'chase', 'fire', 'breathe', 'sparkle', 'color_cycle', 'wave'].includes(type);
  }

  _updateGradientPreview() {
    const low = document.getElementById('lrFormColorLow')?.value || '#0000FF';
    const mid = document.getElementById('lrFormColorMid')?.value || '#FFFF00';
    const high = document.getElementById('lrFormColorHigh')?.value || '#FF0000';
    const preview = document.getElementById('lrFormGradientPreview');
    if (preview) preview.style.background = `linear-gradient(to right,${low},${mid},${high})`;
  }

  _clamp(val, min, max) { return Math.max(min, Math.min(max, parseInt(val) || min)); }

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

  // ==================== ACTIONS ====================

  async testDevice() {
    if (!this.selectedDeviceId) return;
    try { await this.apiClient.sendCommand('lighting_device_test', { id: this.selectedDeviceId }); }
    catch (error) { this.showToast(error.message, 'error'); }
  }

  async testRule(ruleId) {
    try { await this.apiClient.sendCommand('lighting_rule_test', { id: ruleId }); }
    catch (error) { this.showToast(error.message, 'error'); }
  }

  async allOff() {
    try { await this.apiClient.sendCommand('lighting_all_off'); }
    catch (error) { this.showToast(error.message, 'error'); }
  }

  async blackout() {
    try { await this.apiClient.sendCommand('lighting_blackout'); }
    catch (error) { this.showToast(error.message, 'error'); }
  }

  async _onMasterDimmerChange(value) {
    const val = parseInt(value);
    const label = document.getElementById('lightingMasterDimmerVal');
    if (label) label.textContent = Math.round(val / 2.55) + '%';
    try { await this.apiClient.sendCommand('lighting_master_dimmer', { value: val }); }
    catch (error) { /* ignore - too many events */ }
  }

  // ==================== HELPERS ====================

  _getTypeIcon(type) {
    return { gpio: '🔌', gpio_strip: '💠', serial: '🔗', artnet: '🌐', sacn: '📡', mqtt: '📶', http: '🌍', osc: '🎛️', midi: '🎵' }[type] || '💡';
  }

  _getTriggerLabel(trigger) {
    return { noteon: 'Note On', noteoff: 'Note Off', cc: 'CC', any: 'Tous' }[trigger] || trigger || 'Note On';
  }

  _getActionLabel(type) {
    return {
      static: i18n.t('lighting.colorStatic') || 'Couleur fixe',
      velocity_mapped: i18n.t('lighting.colorVelocity') || 'Gradient',
      note_color: '🎹 Note→Couleur', color_temp: '🌡️ Temp. couleur', random_color: '🎲 Aléatoire',
      note_led: '🎹 Note→LED', vu_meter: '📊 VU-mètre',
      pulse: 'Pulse', fade: 'Fade',
      strobe: '⚡ Stroboscope', rainbow: '🌈 Arc-en-ciel', chase: '🏃 Chenillard',
      fire: '🔥 Feu', breathe: '💨 Respiration', sparkle: '✨ Étincelles',
      color_cycle: '🎨 Cycle', wave: '🌊 Vague'
    }[type] || type || 'Couleur fixe';
  }

  _getInstrumentName(instrumentId) {
    if (!instrumentId) return i18n.t('lighting.anyInstrument') || 'Tout instrument';
    const inst = this.instruments.find(i => i.id === instrumentId);
    return inst ? (inst.custom_name || inst.name || instrumentId) : instrumentId;
  }

  _getColorMapValue(colorMap, key) {
    if (!colorMap) return null;
    return colorMap[String(key)] || null;
  }

  _noteName(midi) {
    const n = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    return n[midi % 12] + (Math.floor(midi / 12) - 1);
  }

  _setPreviewLed(index, color) {
    const led = document.querySelector(`.led-preview-pixel[data-index="${index}"]`);
    if (led) led.style.background = color;
  }

  _testPreviewRainbow() {
    const pixels = document.querySelectorAll('.led-preview-pixel');
    pixels.forEach((pixel, i) => {
      const hue = (i * 360 / pixels.length) % 360;
      pixel.style.background = `hsl(${hue}, 100%, 50%)`;
    });
    // Auto-clear after 2 seconds
    setTimeout(() => this._clearPreview(), 2000);
  }

  _clearPreview() {
    const pixels = document.querySelectorAll('.led-preview-pixel');
    pixels.forEach(pixel => { pixel.style.background = '#333'; });
  }
}
