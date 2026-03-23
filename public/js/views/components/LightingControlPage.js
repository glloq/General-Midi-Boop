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

  // ==================== DEVICE LIST RENDERING ====================

  renderDeviceList() {
    const container = document.getElementById('lightingDeviceList');
    if (!container) return;
    const t = this._t();

    if (this.devices.length === 0) {
      container.innerHTML = `
        <div style="padding:20px;text-align:center;color:${t.textMuted};">
          <div style="font-size:28px;margin-bottom:6px;">💡</div>
          <p style="margin:0;font-size:12px;">${i18n.t('lighting.noDevices') || 'Aucun dispositif configuré'}</p>
          <p style="margin:4px 0 0;font-size:11px;color:${t.textMuted};">${i18n.t('lighting.addDeviceHint') || 'Cliquez sur Ajouter'}</p>
        </div>`;
      return;
    }

    container.innerHTML = this.devices.map(device => {
      const sel = device.id === this.selectedDeviceId;
      const icon = this._getTypeIcon(device.type);
      const dot = device.connected ? '🟢' : '⚪';

      return `
        <div onclick="lightingControlPageInstance.selectDevice(${device.id})"
             style="padding:8px 10px;margin-bottom:3px;border-radius:8px;cursor:pointer;border:2px solid ${sel ? t.borderSelected : 'transparent'};background:${sel ? t.bgSelected : t.cardBg};transition:all 0.15s;">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <div style="display:flex;align-items:center;gap:7px;min-width:0;flex:1;">
              <span style="font-size:16px;">${icon}</span>
              <div style="min-width:0;flex:1;">
                <div style="font-size:12px;font-weight:600;color:${t.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${this._escapeHtml(device.name)}</div>
                <div style="font-size:10px;color:${t.textMuted};">${device.type.toUpperCase()} · ${device.led_count} LED${device.led_count > 1 ? 's' : ''}</div>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:3px;flex-shrink:0;">
              <span style="font-size:9px;">${dot}</span>
              <button onclick="event.stopPropagation();lightingControlPageInstance.cloneDevice(${device.id})" style="background:none;border:none;cursor:pointer;font-size:11px;color:${t.textMuted};padding:2px;" title="Dupliquer">📋</button>
              <button onclick="event.stopPropagation();lightingControlPageInstance.deleteDevice(${device.id})" style="background:none;border:none;cursor:pointer;font-size:12px;color:${t.textMuted};padding:2px;" title="Supprimer">🗑</button>
            </div>
          </div>
        </div>`;
    }).join('');
  }

  // ==================== RULES LIST RENDERING ====================

  renderRulesList() {
    const container = document.getElementById('lightingRulesList');
    const title = document.getElementById('lightingRulesTitle');
    const actions = document.getElementById('lightingRulesActions');
    const reconnectBtn = document.getElementById('lightingReconnectBtn');
    if (!container) return;
    const t = this._t();

    const device = this.devices.find(d => d.id === this.selectedDeviceId);
    if (!device) return;

    title.textContent = `📐 ${i18n.t('lighting.rulesFor') || 'Règles pour'} "${device.name}"`;
    actions.style.display = 'flex';

    // Show LED preview strip
    this._renderLedPreview(device);

    // Show reconnect button if device is disconnected
    if (reconnectBtn) {
      reconnectBtn.style.display = device.connected ? 'none' : 'inline-block';
    }

    if (this.rules.length === 0) {
      container.innerHTML = `
        <div style="padding:30px;text-align:center;color:${t.textMuted};">
          <div style="font-size:28px;margin-bottom:6px;">📐</div>
          <p style="margin:0;font-size:12px;">${i18n.t('lighting.noRules') || 'Aucune règle configurée'}</p>
          <p style="margin:4px 0 0;font-size:11px;">${i18n.t('lighting.addRuleHint') || 'Ajoutez une règle pour réagir aux événements MIDI'}</p>
        </div>`;
      return;
    }

    container.innerHTML = this.rules.map(rule => this._renderRuleCard(rule, t)).join('');
  }

  _renderRuleCard(rule, t) {
    const cond = rule.condition_config || {};
    const action = rule.action_config || {};
    const instrument = this._getInstrumentName(rule.instrument_id);
    const triggerLabel = this._getTriggerLabel(cond.trigger);
    const colorPreview = this._buildColorPreview(action);

    return `
      <div style="border:1px solid ${t.border};border-radius:10px;margin-bottom:8px;overflow:hidden;background:${t.cardBg};${!rule.enabled ? 'opacity:0.5;' : ''}">
        <div style="padding:8px 12px;background:${t.cardHeader};border-bottom:1px solid ${t.borderLight};display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:4px;">
          <div style="display:flex;align-items:center;gap:6px;min-width:0;flex:1;">
            ${colorPreview}
            <span style="font-size:12px;font-weight:600;color:${t.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${this._escapeHtml(rule.name || triggerLabel)}</span>
            <span style="font-size:10px;color:${t.textMuted};background:${t.bgAlt};padding:1px 5px;border-radius:4px;white-space:nowrap;">${this._escapeHtml(instrument)}</span>
          </div>
          <div style="display:flex;align-items:center;gap:3px;flex-shrink:0;">
            <button onclick="lightingControlPageInstance.moveRulePriority(${rule.id},1)" style="background:none;border:none;cursor:pointer;font-size:11px;color:${t.textMuted};padding:1px;" title="Priorité +">⬆</button>
            <button onclick="lightingControlPageInstance.moveRulePriority(${rule.id},-1)" style="background:none;border:none;cursor:pointer;font-size:11px;color:${t.textMuted};padding:1px;" title="Priorité -">⬇</button>
            <button onclick="lightingControlPageInstance.testRule(${rule.id})" style="background:none;border:1px solid #3b82f6;border-radius:4px;color:#3b82f6;cursor:pointer;font-size:10px;padding:2px 6px;">Test</button>
            <button onclick="lightingControlPageInstance.toggleRule(${rule.id},${!rule.enabled})" style="background:none;border:none;cursor:pointer;font-size:13px;">${rule.enabled ? '✅' : '⬜'}</button>
            <button onclick="lightingControlPageInstance.editRule(${rule.id})" style="background:none;border:none;cursor:pointer;font-size:13px;">✏️</button>
            <button onclick="lightingControlPageInstance.cloneRule(${rule.id})" style="background:none;border:none;cursor:pointer;font-size:11px;color:${t.textMuted};" title="Dupliquer">📋</button>
            <button onclick="lightingControlPageInstance.deleteRule(${rule.id})" style="background:none;border:none;cursor:pointer;font-size:13px;">🗑</button>
          </div>
        </div>
        <div style="padding:8px 12px;display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;font-size:11px;color:${t.textSec};">
          <div><b>${i18n.t('lighting.triggerType') || 'Déclencheur'}:</b> ${triggerLabel}</div>
          <div><b>${i18n.t('lighting.channel') || 'Canal'}:</b> ${cond.channels?.length ? cond.channels.map(c => c + 1).join(', ') : 'Tous'}</div>
          <div><b>${i18n.t('lighting.velocityRange') || 'Vélocité'}:</b> ${cond.velocity_min || 0}–${cond.velocity_max || 127}</div>
          <div><b>${i18n.t('lighting.noteRange') || 'Notes'}:</b> ${this._noteName(cond.note_min || 0)}–${this._noteName(cond.note_max || 127)}</div>
          ${cond.cc_number?.length ? `<div><b>CC:</b> #${cond.cc_number.join(', #')} (${cond.cc_value_min || 0}–${cond.cc_value_max || 127})</div>` : ''}
          <div><b>${i18n.t('lighting.actionType') || 'Action'}:</b> ${this._getActionLabel(action.type)}${action.brightness_from_velocity ? ' + Vel→Lum' : ''}</div>
          ${rule.priority ? `<div><b>Priorité:</b> ${rule.priority}</div>` : ''}
        </div>
      </div>`;
  }

  _safeColor(c) {
    // Sanitize a color value for safe CSS injection (only allow hex colors)
    return /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '#888';
  }

  _buildColorPreview(action) {
    const pill = (bg) => `<div style="width:28px;height:16px;border-radius:4px;background:${bg};border:1px solid #ddd;flex-shrink:0;"></div>`;
    if (action.type === 'velocity_mapped' && action.color_map) {
      const c0 = this._safeColor(action.color_map['0'] || '#0000FF');
      const c64 = this._safeColor(action.color_map['64'] || '#FFFF00');
      const c127 = this._safeColor(action.color_map['127'] || '#FF0000');
      return pill(`linear-gradient(to right,${c0},${c64},${c127})`);
    }
    if (action.type === 'rainbow' || action.type === 'color_cycle') {
      return pill('linear-gradient(to right,#FF0000,#FFFF00,#00FF00,#00FFFF,#0000FF,#FF00FF,#FF0000)');
    }
    if (action.type === 'fire') {
      return pill('linear-gradient(to right,#FF4500,#FF8C00,#FFD700,#FF6347)');
    }
    if (action.type === 'vu_meter') {
      return pill('linear-gradient(to right,#00FF00,#FFFF00,#FF0000)');
    }
    if (action.type === 'note_color') {
      return pill('linear-gradient(to right,#FF0000,#FF8000,#FFFF00,#00FF00,#00FFFF,#0000FF,#FF00FF,#FF0000)');
    }
    if (action.type === 'color_temp') {
      return pill('linear-gradient(to right,#FF9329,#FFD4A3,#FFF4E5,#CAE2FF)');
    }
    if (action.type === 'random_color') {
      return pill('linear-gradient(to right,#FF0000,#00FF00,#0000FF,#FF00FF,#FFFF00)');
    }
    if (action.type === 'note_led') {
      return pill('linear-gradient(to right,#FF0000,#FFFF00,#00FF00,#00FFFF,#0000FF,#FF00FF)');
    }
    if (action.type === 'sparkle') {
      return pill('linear-gradient(135deg,#333 25%,#FFF 30%,#333 35%,#FFF 60%,#333 65%,#FFF 80%,#333 85%)');
    }
    if (action.type === 'strobe') {
      return pill('linear-gradient(to right,#FFF 0%,#FFF 45%,#000 50%,#000 95%,#FFF 100%)');
    }
    if (action.type === 'chase') {
      const c1 = this._safeColor(action.color || '#FF0000');
      const c2 = this._safeColor(action.color2 || '#000000');
      return pill(`repeating-linear-gradient(to right,${c1} 0px,${c1} 7px,${c2} 7px,${c2} 14px)`);
    }
    if (action.type === 'wave') {
      const c1 = this._safeColor(action.color || '#0000FF');
      const c2 = this._safeColor(action.color2 || '#000000');
      return pill(`linear-gradient(to right,${c2},${c1},${c2},${c1},${c2})`);
    }
    if (action.type === 'breathe') {
      const c = this._safeColor(action.color || '#FF0000');
      return pill(`linear-gradient(to right,#000,${c},#000)`);
    }
    const color = this._safeColor(action.color || '#FFFFFF');
    return `<div style="width:16px;height:16px;border-radius:50%;background:${color};border:2px solid #ddd;flex-shrink:0;"></div>`;
  }

  // ==================== DEVICE GROUPS PANEL ====================

  async showGroupsPanel() {
    const t = this._t();
    let groups = {};
    try {
      const res = await this.apiClient.sendCommand('lighting_group_list');
      groups = res.groups || {};
    } catch (e) { /* ignore */ }

    const groupNames = Object.keys(groups);
    // Store for safe access from onclick handlers
    this._groupNames = groupNames;
    const groupsHTML = groupNames.length === 0
      ? `<p style="text-align:center;color:${t.textMuted};font-size:12px;padding:12px;">Aucun groupe créé</p>`
      : groupNames.map((name, idx) => {
          const ids = groups[name];
          const deviceNames = ids.map(id => {
            const d = this.devices.find(dev => dev.id === id);
            return d ? this._escapeHtml(d.name) : `#${id}`;
          }).join(', ');
          return `
            <div style="padding:8px 10px;border:1px solid ${t.border};border-radius:8px;margin-bottom:6px;background:${t.cardBg};">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
                <span style="font-size:13px;font-weight:600;color:${t.text};">${this._escapeHtml(name)}</span>
                <div style="display:flex;gap:4px;">
                  <input type="color" class="lg-color-input" data-group-idx="${idx}" value="#FF0000" style="width:28px;height:22px;border:1px solid ${t.inputBorder};border-radius:4px;cursor:pointer;">
                  <button onclick="lightingControlPageInstance._setGroupColorByIdx(${idx})" style="padding:2px 8px;border:1px solid #10b981;border-radius:4px;background:none;color:#10b981;cursor:pointer;font-size:11px;">Set</button>
                  <button onclick="lightingControlPageInstance._groupOffByIdx(${idx})" style="padding:2px 8px;border:1px solid #f59e0b;border-radius:4px;background:none;color:#f59e0b;cursor:pointer;font-size:11px;">Off</button>
                  <button onclick="lightingControlPageInstance._deleteGroupByIdx(${idx})" style="padding:2px 8px;border:1px solid #ef4444;border-radius:4px;background:none;color:#ef4444;cursor:pointer;font-size:11px;">🗑</button>
                </div>
              </div>
              <div style="font-size:11px;color:${t.textMuted};">${deviceNames}</div>
            </div>`;
        }).join('');

    const deviceCheckboxes = this.devices.map(d =>
      `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;padding:2px 0;">
        <input type="checkbox" class="lgDeviceCb" value="${d.id}">
        <span style="font-size:12px;color:${t.text};">${this._escapeHtml(d.name)}</span>
      </label>`
    ).join('');

    const formHTML = `
      <div id="lightingGroupsPanel" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:10001;display:flex;align-items:center;justify-content:center;">
        <div style="background:${t.bg};border-radius:12px;padding:20px;width:460px;max-width:92vw;max-height:85vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
          <h3 style="margin:0 0 12px;font-size:16px;color:${t.text};">🔗 Groupes de dispositifs</h3>
          ${groupsHTML}

          <hr style="border:none;border-top:1px solid ${t.border};margin:12px 0;">
          <div style="font-size:12px;font-weight:600;color:${t.textSec};margin-bottom:8px;">Créer un groupe</div>

          <div style="margin-bottom:8px;">
            <input id="lgFormName" type="text" placeholder="Nom du groupe" style="width:100%;padding:7px 10px;border:1px solid ${t.inputBorder};border-radius:8px;font-size:13px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};">
          </div>
          <div style="margin-bottom:8px;max-height:120px;overflow-y:auto;padding:4px;border:1px solid ${t.borderLight};border-radius:8px;">
            ${deviceCheckboxes || '<span style="font-size:12px;color:' + t.textMuted + ';">Aucun dispositif</span>'}
          </div>
          <button onclick="lightingControlPageInstance._createGroup()" style="width:100%;padding:8px;border:none;border-radius:8px;background:#eab308;color:white;cursor:pointer;font-weight:600;font-size:13px;margin-bottom:12px;">Créer le groupe</button>

          <div style="text-align:right;">
            <button onclick="document.getElementById('lightingGroupsPanel').remove()" style="padding:7px 14px;border:1px solid ${t.btnBorder};border-radius:8px;background:${t.btnBg};color:${t.text};cursor:pointer;font-size:12px;">Fermer</button>
          </div>
        </div>
      </div>`;

    const existing = document.getElementById('lightingGroupsPanel');
    if (existing) existing.remove();
    const div = document.createElement('div');
    div.innerHTML = formHTML;
    document.body.appendChild(div.firstElementChild);
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

  // ==================== DEVICE SCAN ====================

  async scanDevices() {
    const t = this._t();
    const scanHTML = `
      <div id="lightingScanPanel" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:10001;display:flex;align-items:center;justify-content:center;">
        <div style="background:${t.bg};border-radius:12px;padding:20px;width:420px;max-width:92vw;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
          <h3 style="margin:0 0 12px;font-size:16px;color:${t.text};">🔍 Scan réseau en cours...</h3>
          <div id="scanResults" style="padding:16px;text-align:center;color:${t.textMuted};">
            <div style="font-size:24px;margin-bottom:8px;">⏳</div>
            <p style="font-size:12px;">Recherche de WLED et Philips Hue sur le réseau...</p>
          </div>
          <div style="text-align:right;margin-top:12px;">
            <button onclick="document.getElementById('lightingScanPanel').remove()" style="padding:7px 14px;border:1px solid ${t.btnBorder};border-radius:8px;background:${t.btnBg};color:${t.text};cursor:pointer;font-size:12px;">Fermer</button>
          </div>
        </div>
      </div>`;

    const div = document.createElement('div');
    div.innerHTML = scanHTML;
    document.body.appendChild(div.firstElementChild);

    try {
      const res = await this.apiClient.sendCommand('lighting_device_scan', { type: 'all' });
      const results = document.getElementById('scanResults');
      if (!results) return;

      if (!res.discovered || res.discovered.length === 0) {
        results.innerHTML = `<div style="font-size:24px;margin-bottom:8px;">🤷</div><p style="font-size:12px;color:${t.textMuted};">Aucun dispositif trouvé. Vérifiez que vos appareils sont allumés et sur le même réseau.</p>`;
        return;
      }

      // Store discovered devices for safe access by index
      this._discoveredDevices = res.discovered;
      results.innerHTML = res.discovered.map((d, idx) => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border:1px solid ${t.border};border-radius:8px;margin-bottom:6px;background:${t.cardBg};text-align:left;">
          <div>
            <div style="font-size:13px;font-weight:600;color:${t.text};">${this._escapeHtml(d.name)}</div>
            <div style="font-size:11px;color:${t.textMuted};">${this._escapeHtml(d.type).toUpperCase()} · ${this._escapeHtml(d.host)} · ${d.led_count || '?'} LEDs</div>
          </div>
          <button onclick="lightingControlPageInstance._addScannedDevice(lightingControlPageInstance._discoveredDevices[${idx}])" style="padding:4px 10px;border:1px solid #10b981;border-radius:6px;background:none;color:#10b981;cursor:pointer;font-size:11px;">+ Ajouter</button>
        </div>
      `).join('');
    } catch (error) {
      const results = document.getElementById('scanResults');
      if (results) results.innerHTML = `<p style="color:#ef4444;font-size:12px;">Erreur: ${this._escapeHtml(error.message)}</p>`;
    }
  }

  async _addScannedDevice(deviceInfo) {
    try {
      let connectionConfig = {};
      let type = 'http';

      if (deviceInfo.type === 'wled') {
        type = 'http';
        connectionConfig = { base_url: `http://${deviceInfo.host}`, firmware: 'wled' };
      } else if (deviceInfo.type === 'hue') {
        type = 'http';
        connectionConfig = { base_url: `http://${deviceInfo.host}`, firmware: 'hue' };
      }

      await this.apiClient.sendCommand('lighting_device_add', {
        name: deviceInfo.name,
        type,
        led_count: deviceInfo.led_count || 1,
        connection_config: connectionConfig
      });

      document.getElementById('lightingScanPanel')?.remove();
      await this.loadData();
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

  // ==================== LIVE EFFECTS PANEL ====================

  async showEffectsPanel() {
    const t = this._t();
    if (!this.selectedDeviceId) {
      this.showToast(i18n.t('lighting.selectDeviceFirst') || 'Sélectionnez un dispositif d\'abord', 'warning');
      return;
    }

    const device = this.devices.find(d => d.id === this.selectedDeviceId);
    if (!device) return;

    let activeEffects = [];
    let currentBpm = 120;
    try {
      const bpmRes = await this.apiClient.sendCommand('lighting_bpm_get');
      currentBpm = bpmRes.bpm || 120;
    } catch (e) { /* ignore */ }
    try {
      const res = await this.apiClient.sendCommand('lighting_effect_list');
      activeEffects = res.effects || [];
    } catch (e) { /* ignore */ }

    const effectTypes = [
      { value: 'strobe', label: '⚡ Stroboscope' },
      { value: 'rainbow', label: '🌈 Arc-en-ciel' },
      { value: 'chase', label: '🏃 Chenillard' },
      { value: 'fire', label: '🔥 Feu' },
      { value: 'breathe', label: '💨 Respiration' },
      { value: 'sparkle', label: '✨ Étincelles' },
      { value: 'color_cycle', label: '🎨 Cycle couleurs' },
      { value: 'wave', label: '🌊 Vague' }
    ];

    const activeHTML = activeEffects.length === 0
      ? `<p style="text-align:center;color:${t.textMuted};font-size:12px;padding:8px;">Aucun effet actif</p>`
      : activeEffects.map(e => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border:1px solid ${t.border};border-radius:6px;margin-bottom:4px;background:${t.cardBg};">
            <span style="font-size:12px;color:${t.text};">${this._escapeHtml(e.effectType)} (${this._escapeHtml(e.key)})</span>
            <button onclick="lightingControlPageInstance._stopLiveEffect('${this._escapeHtml(e.key)}')" style="padding:2px 8px;border:1px solid #ef4444;border-radius:4px;background:none;color:#ef4444;cursor:pointer;font-size:11px;">Stop</button>
          </div>`).join('');

    const effectOptions = effectTypes.map(et =>
      `<option value="${et.value}">${et.label}</option>`
    ).join('');

    const formHTML = `
      <div id="lightingEffectsPanel" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:10001;display:flex;align-items:center;justify-content:center;">
        <div style="background:${t.bg};border-radius:12px;padding:20px;width:460px;max-width:92vw;max-height:85vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
          <h3 style="margin:0 0 12px;font-size:16px;color:${t.text};">⚡ Effets en direct — ${this._escapeHtml(device.name)}</h3>

          <div style="margin-bottom:12px;">
            <div style="font-size:12px;font-weight:600;color:${t.textSec};margin-bottom:6px;">Effets actifs</div>
            ${activeHTML}
          </div>

          <hr style="border:none;border-top:1px solid ${t.border};margin:12px 0;">

          <div style="font-size:12px;font-weight:600;color:${t.textSec};margin-bottom:8px;">Lancer un nouvel effet</div>

          <div style="display:flex;gap:8px;margin-bottom:8px;">
            <div style="flex:1;"><select id="leFormEffect" style="width:100%;padding:7px;border:1px solid ${t.inputBorder};border-radius:8px;font-size:13px;background:${t.inputBg};color:${t.inputText};">${effectOptions}</select></div>
          </div>

          <div style="display:flex;gap:8px;margin-bottom:8px;">
            <div style="flex:1;"><label style="font-size:10px;color:${t.textMuted};">Couleur</label><input id="leFormColor" type="color" value="#FF0000" style="width:100%;height:30px;border:1px solid ${t.inputBorder};border-radius:6px;cursor:pointer;"></div>
            <div style="flex:1;"><label style="font-size:10px;color:${t.textMuted};">Vitesse (ms)</label><input id="leFormSpeed" type="number" min="20" max="10000" value="500" style="width:100%;padding:6px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:12px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};"></div>
            <div style="flex:1;"><label style="font-size:10px;color:${t.textMuted};">Luminosité</label><input id="leFormBri" type="number" min="0" max="255" value="255" style="width:100%;padding:6px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:12px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};"></div>
          </div>

          <div style="display:flex;gap:8px;margin-bottom:12px;">
            <button onclick="lightingControlPageInstance._startLiveEffect()" style="flex:1;padding:8px;border:none;border-radius:8px;background:#10b981;color:white;cursor:pointer;font-weight:600;font-size:13px;">▶ Lancer</button>
            <button onclick="lightingControlPageInstance.allOff();lightingControlPageInstance.showEffectsPanel();" style="flex:1;padding:8px;border:none;border-radius:8px;background:#ef4444;color:white;cursor:pointer;font-weight:600;font-size:13px;">⏹ Tout arrêter</button>
          </div>

          <hr style="border:none;border-top:1px solid ${t.border};margin:8px 0;">
          <div style="font-size:12px;font-weight:600;color:${t.textSec};margin-bottom:6px;">🥁 BPM / Tap Tempo</div>
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
            <button onclick="lightingControlPageInstance._tapTempo()" style="flex:1;padding:10px;border:2px solid #8b5cf6;border-radius:8px;background:${t.bgAlt};color:#8b5cf6;cursor:pointer;font-size:14px;font-weight:700;">🥁 TAP</button>
            <div style="text-align:center;">
              <span id="leEffectBpm" style="font-size:20px;font-weight:700;color:${t.text};">${currentBpm}</span>
              <div style="font-size:10px;color:${t.textMuted};">BPM</div>
            </div>
            <input id="leEffectBpmInput" type="number" min="20" max="300" value="${currentBpm}" style="width:70px;padding:6px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:13px;text-align:center;background:${t.inputBg};color:${t.inputText};" onchange="lightingControlPageInstance._setBpm(this.value)">
          </div>

          <div style="text-align:right;">
            <button onclick="document.getElementById('lightingEffectsPanel').remove()" style="padding:7px 14px;border:1px solid ${t.btnBorder};border-radius:8px;background:${t.btnBg};color:${t.text};cursor:pointer;font-size:12px;">Fermer</button>
          </div>
        </div>
      </div>`;

    const existing = document.getElementById('lightingEffectsPanel');
    if (existing) existing.remove();
    const div = document.createElement('div');
    div.innerHTML = formHTML;
    document.body.appendChild(div.firstElementChild);
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

  // ==================== PRESETS UI ====================

  showPresetsPanel() {
    const t = this._t();
    const presetsHTML = this.presets.length === 0
      ? `<p style="text-align:center;color:${t.textMuted};font-size:12px;padding:16px;">${i18n.t('lighting.noPresets') || 'Aucun preset sauvegardé'}</p>`
      : this.presets.map(p => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border:1px solid ${t.border};border-radius:8px;margin-bottom:6px;background:${t.cardBg};">
            <span style="font-size:13px;color:${t.text};font-weight:500;">${this._escapeHtml(p.name)}</span>
            <div style="display:flex;gap:4px;">
              <button onclick="lightingControlPageInstance.loadPreset(${p.id})" style="padding:3px 8px;border:1px solid #3b82f6;border-radius:4px;background:${t.btnBg};color:#3b82f6;cursor:pointer;font-size:11px;">${i18n.t('lighting.loadPreset') || 'Charger'}</button>
              <button onclick="lightingControlPageInstance.deletePreset(${p.id})" style="padding:3px 8px;border:1px solid #ef4444;border-radius:4px;background:${t.btnBg};color:#ef4444;cursor:pointer;font-size:11px;">🗑</button>
            </div>
          </div>`).join('');

    const formHTML = `
      <div id="lightingPresetsPanel" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:10001;display:flex;align-items:center;justify-content:center;">
        <div style="background:${t.bg};border-radius:12px;padding:20px;width:400px;max-width:90vw;max-height:80vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
          <h3 style="margin:0 0 16px;font-size:16px;color:${t.text};">📦 ${i18n.t('lighting.presets') || 'Presets Lumière'}</h3>

          <!-- Save new preset -->
          <div style="display:flex;gap:8px;margin-bottom:16px;">
            <input id="lpFormName" type="text" placeholder="${i18n.t('lighting.presetName') || 'Nom du preset'}" style="flex:1;padding:7px 10px;border:1px solid ${t.inputBorder};border-radius:8px;font-size:13px;background:${t.inputBg};color:${t.inputText};box-sizing:border-box;">
            <button onclick="lightingControlPageInstance.savePreset()" style="padding:7px 14px;border:none;border-radius:8px;background:#eab308;color:white;cursor:pointer;font-size:12px;font-weight:600;white-space:nowrap;">${i18n.t('lighting.savePreset') || 'Sauvegarder'}</button>
          </div>

          <hr style="border:none;border-top:1px solid ${t.border};margin:0 0 12px;">
          ${presetsHTML}

          <hr style="border:none;border-top:1px solid ${t.border};margin:12px 0;">
          <div style="font-size:12px;font-weight:600;color:${t.textSec};margin-bottom:8px;">🎬 Scènes (état lumière)</div>
          <div style="display:flex;gap:8px;margin-bottom:12px;">
            <input id="lpSceneName" type="text" placeholder="${i18n.t('lighting.sceneName') || 'Nom de la scène'}" style="flex:1;padding:7px 10px;border:1px solid ${t.inputBorder};border-radius:8px;font-size:12px;background:${t.inputBg};color:${t.inputText};box-sizing:border-box;">
            <button onclick="lightingControlPageInstance.saveScene()" style="padding:7px 12px;border:1px solid #8b5cf6;border-radius:8px;background:${t.btnBg};color:#8b5cf6;cursor:pointer;font-size:12px;white-space:nowrap;">💾 Sauvegarder</button>
          </div>

          <hr style="border:none;border-top:1px solid ${t.border};margin:12px 0;">
          <div style="font-size:12px;font-weight:600;color:${t.textSec};margin-bottom:8px;">📤 Import / Export</div>
          <div style="display:flex;gap:8px;margin-bottom:12px;">
            <button onclick="lightingControlPageInstance.exportRules()" style="flex:1;padding:7px;border:1px solid #3b82f6;border-radius:8px;background:${t.btnBg};color:#3b82f6;cursor:pointer;font-size:12px;">📤 Exporter les règles</button>
            <button onclick="lightingControlPageInstance.importRules()" style="flex:1;padding:7px;border:1px solid #10b981;border-radius:8px;background:${t.btnBg};color:#10b981;cursor:pointer;font-size:12px;">📥 Importer des règles</button>
          </div>

          <div style="text-align:right;margin-top:12px;">
            <button onclick="document.getElementById('lightingPresetsPanel').remove()" style="padding:7px 14px;border:1px solid ${t.btnBorder};border-radius:8px;background:${t.btnBg};color:${t.text};cursor:pointer;font-size:12px;">Fermer</button>
          </div>
        </div>
      </div>`;

    const div = document.createElement('div');
    div.innerHTML = formHTML;
    document.body.appendChild(div.firstElementChild);
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

  async importRules() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const importData = JSON.parse(text);
        const res = await this.apiClient.sendCommand('lighting_rules_import', {
          import_data: importData,
          default_device_id: this.selectedDeviceId || undefined
        });
        this.showToast(`Import: ${res.imported} règle(s) importée(s), ${res.skipped} ignorée(s)`, 'success');
        document.getElementById('lightingPresetsPanel')?.remove();
        await this.loadData();
      } catch (error) { this.showToast('Erreur import: ' + error.message, 'error'); }
    };
    input.click();
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

  // ==================== ADD/EDIT DEVICE ====================

  showAddDeviceForm() {
    const t = this._t();
    const formHTML = `
      <div id="lightingDeviceForm" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:10001;display:flex;align-items:center;justify-content:center;">
        <div style="background:${t.bg};border-radius:12px;padding:20px;width:420px;max-width:92vw;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
          <h3 style="margin:0 0 16px;font-size:16px;color:${t.text};">💡 ${i18n.t('lighting.addDevice') || 'Ajouter un dispositif'}</h3>

          <div style="margin-bottom:12px;">
            <label style="font-size:12px;font-weight:600;color:${t.text};display:block;margin-bottom:3px;">${i18n.t('lighting.deviceName') || 'Nom'} *</label>
            <input id="ldFormName" type="text" placeholder="LED RGB Salon" style="width:100%;padding:7px 10px;border:1px solid ${t.inputBorder};border-radius:8px;font-size:13px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};">
            <span id="ldFormNameError" style="font-size:11px;color:#ef4444;display:none;">Nom requis</span>
          </div>

          <div style="margin-bottom:12px;">
            <label style="font-size:12px;font-weight:600;color:${t.text};display:block;margin-bottom:3px;">${i18n.t('lighting.deviceType') || 'Type'}</label>
            <select id="ldFormType" onchange="lightingControlPageInstance._updateDeviceFormFields()" style="width:100%;padding:7px 10px;border:1px solid ${t.inputBorder};border-radius:8px;font-size:13px;background:${t.inputBg};color:${t.inputText};">
              <option value="gpio">🔌 GPIO (Raspberry Pi RGB)</option>
              <option value="gpio_strip">💠 Bandeau LED GPIO (WS2812/NeoPixel)</option>
              <option value="serial">🔗 Serial (WS2812/NeoPixel)</option>
              <option value="artnet">🌐 Art-Net (DMX sur Ethernet)</option>
              <option value="sacn">📡 sACN / E1.31 (DMX moderne)</option>
              <option value="mqtt">📶 MQTT (WLED, Tasmota, ESPHome)</option>
              <option value="http">🌍 HTTP REST (WLED, Philips Hue)</option>
              <option value="osc">🎛️ OSC (QLC+, TouchDesigner)</option>
            </select>
          </div>

          <div style="margin-bottom:12px;">
            <label style="font-size:12px;font-weight:600;color:${t.text};display:block;margin-bottom:3px;">${i18n.t('lighting.ledCount') || 'Nombre de LEDs'}</label>
            <input id="ldFormLedCount" type="number" min="1" max="10000" value="1" style="width:100%;padding:7px 10px;border:1px solid ${t.inputBorder};border-radius:8px;font-size:13px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};">
          </div>

          <div id="ldFormGpioFields">
            <label style="font-size:12px;font-weight:600;color:${t.text};display:block;margin-bottom:3px;">Pins GPIO (R, G, B)</label>
            <div style="display:flex;gap:8px;margin-bottom:12px;">
              <input id="ldFormPinR" type="number" min="0" max="27" value="17" placeholder="R" style="flex:1;padding:7px;border:1px solid ${t.inputBorder};border-radius:8px;font-size:13px;background:${t.inputBg};color:${t.inputText};">
              <input id="ldFormPinG" type="number" min="0" max="27" value="27" placeholder="G" style="flex:1;padding:7px;border:1px solid ${t.inputBorder};border-radius:8px;font-size:13px;background:${t.inputBg};color:${t.inputText};">
              <input id="ldFormPinB" type="number" min="0" max="27" value="22" placeholder="B" style="flex:1;padding:7px;border:1px solid ${t.inputBorder};border-radius:8px;font-size:13px;background:${t.inputBg};color:${t.inputText};">
            </div>
          </div>

          <div id="ldFormSerialFields" style="display:none;">
            <label style="font-size:12px;font-weight:600;color:${t.text};display:block;margin-bottom:3px;">Port série</label>
            <input id="ldFormSerialPort" type="text" value="/dev/ttyUSB0" style="width:100%;padding:7px 10px;border:1px solid ${t.inputBorder};border-radius:8px;font-size:13px;margin-bottom:12px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};">
          </div>

          <div id="ldFormStripFields" style="display:none;">
            <label style="font-size:12px;font-weight:600;color:${t.text};display:block;margin-bottom:6px;">Bandeaux LED</label>
            <div id="ldFormStripsContainer"></div>
            <button type="button" onclick="lightingControlPageInstance._addStripEntry()" style="padding:4px 10px;border:1px dashed ${t.inputBorder};border-radius:6px;background:none;color:${t.textSec};cursor:pointer;font-size:11px;margin-bottom:12px;">+ Ajouter un bandeau</button>

            <label style="font-size:12px;font-weight:600;color:${t.text};display:block;margin-bottom:6px;">Segments (zones logiques)</label>
            <div id="ldFormSegmentsContainer"></div>
            <button type="button" onclick="lightingControlPageInstance._addSegmentEntry()" style="padding:4px 10px;border:1px dashed ${t.inputBorder};border-radius:6px;background:none;color:${t.textSec};cursor:pointer;font-size:11px;margin-bottom:12px;">+ Ajouter un segment</button>

            <div style="font-size:11px;color:${t.textMuted};margin-bottom:8px;">Le nombre de LEDs sera calculé automatiquement.</div>
          </div>

          <!-- Art-Net fields -->
          <div id="ldFormArtnetFields" style="display:none;">
            <label style="font-size:12px;font-weight:600;color:${t.text};display:block;margin-bottom:3px;">Adresse IP / Broadcast</label>
            <input id="ldFormArtnetHost" type="text" value="255.255.255.255" placeholder="255.255.255.255" style="width:100%;padding:7px 10px;border:1px solid ${t.inputBorder};border-radius:8px;font-size:13px;margin-bottom:8px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};">
            <div style="display:flex;gap:8px;margin-bottom:8px;">
              <div style="flex:1;"><label style="font-size:11px;color:${t.textSec};display:block;margin-bottom:2px;">Universe</label><input id="ldFormArtnetUniverse" type="number" min="0" max="32767" value="0" style="width:100%;padding:6px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:12px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};"></div>
              <div style="flex:1;"><label style="font-size:11px;color:${t.textSec};display:block;margin-bottom:2px;">Subnet</label><input id="ldFormArtnetSubnet" type="number" min="0" max="15" value="0" style="width:100%;padding:6px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:12px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};"></div>
              <div style="flex:1;"><label style="font-size:11px;color:${t.textSec};display:block;margin-bottom:2px;">Canaux/LED</label><input id="ldFormArtnetChannels" type="number" min="1" max="8" value="3" style="width:100%;padding:6px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:12px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};"></div>
            </div>
            <div style="margin-bottom:8px;">
              <label style="font-size:11px;color:${t.textSec};display:block;margin-bottom:2px;">Profil de fixture DMX</label>
              <select id="ldFormArtnetProfile" onchange="lightingControlPageInstance._onDmxProfileChange('artnet')" style="width:100%;padding:6px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:12px;background:${t.inputBg};color:${t.inputText};">
                <option value="">-- Manuel --</option>
              </select>
            </div>
            <div style="font-size:10px;color:${t.textMuted};margin-bottom:8px;">3 canaux = RGB, 4 = RGBW. Max 170 LEDs RGB par univers (512/3).</div>
          </div>

          <!-- sACN fields -->
          <div id="ldFormSacnFields" style="display:none;">
            <div style="display:flex;gap:8px;margin-bottom:8px;">
              <div style="flex:1;"><label style="font-size:11px;color:${t.textSec};display:block;margin-bottom:2px;">Universe</label><input id="ldFormSacnUniverse" type="number" min="1" max="63999" value="1" style="width:100%;padding:6px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:12px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};"></div>
              <div style="flex:1;"><label style="font-size:11px;color:${t.textSec};display:block;margin-bottom:2px;">Priorité</label><input id="ldFormSacnPriority" type="number" min="0" max="200" value="100" style="width:100%;padding:6px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:12px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};"></div>
              <div style="flex:1;"><label style="font-size:11px;color:${t.textSec};display:block;margin-bottom:2px;">Canaux/LED</label><input id="ldFormSacnChannels" type="number" min="1" max="8" value="3" style="width:100%;padding:6px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:12px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};"></div>
            </div>
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;margin-bottom:6px;">
              <input id="ldFormSacnMulticast" type="checkbox" checked>
              <span style="font-size:12px;color:${t.text};">Multicast (recommandé)</span>
            </label>
            <div id="ldFormSacnUnicastRow" style="display:none;">
              <label style="font-size:11px;color:${t.textSec};display:block;margin-bottom:2px;">Adresse unicast</label>
              <input id="ldFormSacnHost" type="text" value="" placeholder="192.168.1.100" style="width:100%;padding:6px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:12px;margin-bottom:8px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};">
            </div>
            <div style="margin-bottom:8px;">
              <label style="font-size:11px;color:${t.textSec};display:block;margin-bottom:2px;">Profil de fixture DMX</label>
              <select id="ldFormSacnProfile" onchange="lightingControlPageInstance._onDmxProfileChange('sacn')" style="width:100%;padding:6px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:12px;background:${t.inputBg};color:${t.inputText};">
                <option value="">-- Manuel --</option>
              </select>
            </div>
          </div>

          <!-- MQTT fields -->
          <div id="ldFormMqttFields" style="display:none;">
            <label style="font-size:12px;font-weight:600;color:${t.text};display:block;margin-bottom:3px;">URL du Broker MQTT</label>
            <input id="ldFormMqttBroker" type="text" value="mqtt://localhost:1883" placeholder="mqtt://host:1883" style="width:100%;padding:7px 10px;border:1px solid ${t.inputBorder};border-radius:8px;font-size:13px;margin-bottom:8px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};">
            <div style="display:flex;gap:8px;margin-bottom:8px;">
              <div style="flex:1;"><label style="font-size:11px;color:${t.textSec};display:block;margin-bottom:2px;">Topic de base</label><input id="ldFormMqttTopic" type="text" value="wled/maestro" placeholder="wled/all" style="width:100%;padding:6px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:12px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};"></div>
              <div style="flex:1;"><label style="font-size:11px;color:${t.textSec};display:block;margin-bottom:2px;">Firmware</label>
                <select id="ldFormMqttFirmware" style="width:100%;padding:6px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:12px;background:${t.inputBg};color:${t.inputText};">
                  <option value="wled">WLED</option>
                  <option value="tasmota">Tasmota</option>
                  <option value="esphome">ESPHome</option>
                  <option value="generic">Générique</option>
                </select>
              </div>
            </div>
            <div style="display:flex;gap:8px;margin-bottom:8px;">
              <div style="flex:1;"><label style="font-size:11px;color:${t.textSec};display:block;margin-bottom:2px;">Utilisateur (opt.)</label><input id="ldFormMqttUser" type="text" placeholder="" style="width:100%;padding:6px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:12px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};"></div>
              <div style="flex:1;"><label style="font-size:11px;color:${t.textSec};display:block;margin-bottom:2px;">Mot de passe (opt.)</label><input id="ldFormMqttPass" type="password" placeholder="" style="width:100%;padding:6px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:12px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};"></div>
            </div>
          </div>

          <!-- HTTP REST fields -->
          <div id="ldFormHttpFields" style="display:none;">
            <label style="font-size:12px;font-weight:600;color:${t.text};display:block;margin-bottom:3px;">URL de base</label>
            <input id="ldFormHttpUrl" type="text" value="http://192.168.1.100" placeholder="http://wled-ip" style="width:100%;padding:7px 10px;border:1px solid ${t.inputBorder};border-radius:8px;font-size:13px;margin-bottom:8px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};">
            <div style="display:flex;gap:8px;margin-bottom:8px;">
              <div style="flex:1;"><label style="font-size:11px;color:${t.textSec};display:block;margin-bottom:2px;">Firmware</label>
                <select id="ldFormHttpFirmware" style="width:100%;padding:6px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:12px;background:${t.inputBg};color:${t.inputText};">
                  <option value="wled">WLED</option>
                  <option value="hue">Philips Hue</option>
                  <option value="generic">Générique</option>
                </select>
              </div>
              <div style="flex:1;"><label style="font-size:11px;color:${t.textSec};display:block;margin-bottom:2px;">Clé API (opt.)</label><input id="ldFormHttpApiKey" type="text" placeholder="" style="width:100%;padding:6px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:12px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};"></div>
            </div>
          </div>

          <!-- OSC fields -->
          <div id="ldFormOscFields" style="display:none;">
            <div style="display:flex;gap:8px;margin-bottom:8px;">
              <div style="flex:2;"><label style="font-size:11px;color:${t.textSec};display:block;margin-bottom:2px;">Adresse IP</label><input id="ldFormOscHost" type="text" value="127.0.0.1" style="width:100%;padding:6px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:12px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};"></div>
              <div style="flex:1;"><label style="font-size:11px;color:${t.textSec};display:block;margin-bottom:2px;">Port</label><input id="ldFormOscPort" type="number" min="1" max="65535" value="8000" style="width:100%;padding:6px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:12px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};"></div>
            </div>
            <div style="margin-bottom:8px;"><label style="font-size:11px;color:${t.textSec};display:block;margin-bottom:2px;">Motif d'adresse OSC</label><input id="ldFormOscPattern" type="text" value="/light/{led}" placeholder="/light/{led}" style="width:100%;padding:6px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:12px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};"></div>
            <div style="margin-bottom:8px;"><label style="font-size:11px;color:${t.textSec};display:block;margin-bottom:2px;">Format couleur</label>
              <select id="ldFormOscFormat" style="width:100%;padding:6px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:12px;background:${t.inputBg};color:${t.inputText};">
                <option value="rgb_float">RGB float (0.0-1.0)</option>
                <option value="rgb_int">RGB int (0-255)</option>
                <option value="rgbw_float">RGBW float (0.0-1.0)</option>
                <option value="rgbw_int">RGBW int (0-255)</option>
              </select>
            </div>
          </div>

          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
            <button onclick="document.getElementById('lightingDeviceForm').remove()" style="padding:7px 14px;border:1px solid ${t.btnBorder};border-radius:8px;background:${t.btnBg};color:${t.text};cursor:pointer;font-size:12px;">Annuler</button>
            <button onclick="lightingControlPageInstance.submitAddDevice()" style="padding:7px 14px;border:none;border-radius:8px;background:#eab308;color:white;cursor:pointer;font-weight:600;font-size:12px;">Ajouter</button>
          </div>
        </div>
      </div>`;

    const div = document.createElement('div');
    div.innerHTML = formHTML;
    document.body.appendChild(div.firstElementChild);
  }

  _updateDeviceFormFields() {
    const type = document.getElementById('ldFormType').value;
    // Hide all type-specific fields first
    const allTypeFields = ['ldFormGpioFields', 'ldFormSerialFields', 'ldFormStripFields', 'ldFormArtnetFields', 'ldFormSacnFields', 'ldFormMqttFields', 'ldFormHttpFields', 'ldFormOscFields'];
    allTypeFields.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });

    // Show the correct field set
    const fieldMap = {
      gpio: 'ldFormGpioFields', serial: 'ldFormSerialFields', gpio_strip: 'ldFormStripFields',
      artnet: 'ldFormArtnetFields', sacn: 'ldFormSacnFields', mqtt: 'ldFormMqttFields',
      http: 'ldFormHttpFields', osc: 'ldFormOscFields'
    };
    const targetId = fieldMap[type];
    if (targetId) { const el = document.getElementById(targetId); if (el) el.style.display = 'block'; }

    // Handle auto-calculated LED count for strips
    const ledCountEl = document.getElementById('ldFormLedCount');
    if (type === 'gpio_strip') {
      if (ledCountEl) ledCountEl.closest('div[style]').style.display = 'none';
      const container = document.getElementById('ldFormStripsContainer');
      if (container && container.children.length === 0) this._addStripEntry();
    } else {
      if (ledCountEl) ledCountEl.closest('div[style]').style.display = 'block';
    }

    // sACN multicast toggle
    const sacnMc = document.getElementById('ldFormSacnMulticast');
    if (sacnMc) {
      sacnMc.onchange = () => {
        const uRow = document.getElementById('ldFormSacnUnicastRow');
        if (uRow) uRow.style.display = sacnMc.checked ? 'none' : 'block';
      };
    }

    // Load DMX profiles for Art-Net/sACN
    if (type === 'artnet' || type === 'sacn') {
      this._loadDmxProfiles(type);
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

  _addStripEntry() {
    const t = this._t();
    const container = document.getElementById('ldFormStripsContainer');
    if (!container) return;
    const idx = container.children.length;
    if (idx >= 3) return; // Max 3 hardware channels

    const channelGpioDefaults = { 0: 18, 1: 13, 2: 10 };
    const defaultChannel = idx;
    const defaultGpio = channelGpioDefaults[defaultChannel] || 18;

    const entry = document.createElement('div');
    entry.className = 'strip-entry';
    entry.style.cssText = `display:flex;gap:6px;align-items:center;margin-bottom:6px;padding:6px;border:1px solid ${t.inputBorder};border-radius:8px;background:${t.bgAlt};`;
    entry.innerHTML = `
      <select class="strip-channel" style="width:70px;padding:5px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:11px;background:${t.inputBg};color:${t.inputText};" onchange="lightingControlPageInstance._onStripChannelChange(this)">
        <option value="0" ${defaultChannel === 0 ? 'selected' : ''}>Ch0 PWM0</option>
        <option value="1" ${defaultChannel === 1 ? 'selected' : ''}>Ch1 PWM1</option>
        <option value="2" ${defaultChannel === 2 ? 'selected' : ''}>Ch2 SPI</option>
      </select>
      <select class="strip-gpio" style="width:65px;padding:5px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:11px;background:${t.inputBg};color:${t.inputText};"></select>
      <input class="strip-ledcount" type="number" min="1" max="1000" value="30" placeholder="LEDs" style="width:60px;padding:5px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:11px;background:${t.inputBg};color:${t.inputText};">
      <input class="strip-brightness" type="number" min="0" max="255" value="255" placeholder="Lum" style="width:50px;padding:5px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:11px;background:${t.inputBg};color:${t.inputText};">
      <button type="button" onclick="this.closest('.strip-entry').remove()" style="padding:2px 6px;border:none;background:none;color:#ef4444;cursor:pointer;font-size:14px;">×</button>`;
    container.appendChild(entry);
    this._onStripChannelChange(entry.querySelector('.strip-channel'));
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

  async submitAddDevice() {
    const nameEl = document.getElementById('ldFormName');
    const nameErr = document.getElementById('ldFormNameError');
    const name = nameEl.value.trim();

    if (!name) {
      nameEl.style.borderColor = '#ef4444';
      if (nameErr) nameErr.style.display = 'block';
      return;
    }

    const type = document.getElementById('ldFormType').value;
    let ledCount = Math.max(1, Math.min(10000, parseInt(document.getElementById('ldFormLedCount').value) || 1));

    let connectionConfig = {};
    if (type === 'gpio') {
      connectionConfig = {
        pins: {
          r: Math.max(0, Math.min(27, parseInt(document.getElementById('ldFormPinR').value) || 17)),
          g: Math.max(0, Math.min(27, parseInt(document.getElementById('ldFormPinG').value) || 27)),
          b: Math.max(0, Math.min(27, parseInt(document.getElementById('ldFormPinB').value) || 22))
        }
      };
    } else if (type === 'gpio_strip') {
      const stripEntries = document.querySelectorAll('#ldFormStripsContainer .strip-entry');
      const strips = [];
      let totalLeds = 0;
      stripEntries.forEach(entry => {
        const count = Math.max(1, Math.min(1000, parseInt(entry.querySelector('.strip-ledcount').value) || 30));
        strips.push({
          channel: parseInt(entry.querySelector('.strip-channel').value),
          gpio: parseInt(entry.querySelector('.strip-gpio').value),
          led_count: count,
          brightness: Math.max(0, Math.min(255, parseInt(entry.querySelector('.strip-brightness').value) || 255))
        });
        totalLeds += count;
      });
      const segEntries = document.querySelectorAll('#ldFormSegmentsContainer .segment-entry');
      const segments = [];
      segEntries.forEach(entry => {
        const name = entry.querySelector('.seg-name').value.trim();
        if (name) {
          segments.push({
            name,
            start: Math.max(0, parseInt(entry.querySelector('.seg-start').value) || 0),
            end: Math.max(0, parseInt(entry.querySelector('.seg-end').value) || 0)
          });
        }
      });
      connectionConfig = { strips, segments, frequency: 800000, dma: 10 };
      // Override ledCount with auto-calculated total
      ledCount = totalLeds || 1;
    } else if (type === 'serial') {
      connectionConfig = { port: document.getElementById('ldFormSerialPort').value || '/dev/ttyUSB0', baud: 115200 };
    } else if (type === 'artnet') {
      connectionConfig = {
        host: document.getElementById('ldFormArtnetHost')?.value || '255.255.255.255',
        universe: parseInt(document.getElementById('ldFormArtnetUniverse')?.value) || 0,
        subnet: parseInt(document.getElementById('ldFormArtnetSubnet')?.value) || 0,
        channels_per_led: parseInt(document.getElementById('ldFormArtnetChannels')?.value) || 3
      };
    } else if (type === 'sacn') {
      const multicast = document.getElementById('ldFormSacnMulticast')?.checked !== false;
      connectionConfig = {
        universe: parseInt(document.getElementById('ldFormSacnUniverse')?.value) || 1,
        priority: parseInt(document.getElementById('ldFormSacnPriority')?.value) || 100,
        channels_per_led: parseInt(document.getElementById('ldFormSacnChannels')?.value) || 3,
        multicast,
        host: !multicast ? (document.getElementById('ldFormSacnHost')?.value || null) : null
      };
    } else if (type === 'mqtt') {
      connectionConfig = {
        broker_url: document.getElementById('ldFormMqttBroker')?.value || 'mqtt://localhost:1883',
        base_topic: document.getElementById('ldFormMqttTopic')?.value || 'wled/maestro',
        firmware: document.getElementById('ldFormMqttFirmware')?.value || 'wled',
        username: document.getElementById('ldFormMqttUser')?.value || undefined,
        password: document.getElementById('ldFormMqttPass')?.value || undefined
      };
    } else if (type === 'http') {
      connectionConfig = {
        base_url: document.getElementById('ldFormHttpUrl')?.value || 'http://192.168.1.100',
        firmware: document.getElementById('ldFormHttpFirmware')?.value || 'wled',
        api_key: document.getElementById('ldFormHttpApiKey')?.value || null
      };
    } else if (type === 'osc') {
      connectionConfig = {
        host: document.getElementById('ldFormOscHost')?.value || '127.0.0.1',
        port: parseInt(document.getElementById('ldFormOscPort')?.value) || 8000,
        address_pattern: document.getElementById('ldFormOscPattern')?.value || '/light/{led}',
        color_format: document.getElementById('ldFormOscFormat')?.value || 'rgb_float'
      };
    }

    try {
      await this.apiClient.sendCommand('lighting_device_add', { name, type, led_count: ledCount, connection_config: connectionConfig });
      document.getElementById('lightingDeviceForm')?.remove();
      await this.loadData();
    } catch (error) {
      this.showToast(error.message, 'error');
    }
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

  async showEditDeviceForm() {
    if (!this.selectedDeviceId) return;
    const device = this.devices.find(d => d.id === this.selectedDeviceId);
    if (!device) return;

    // Reuse the add device form, then populate with existing values
    this._editingDeviceId = device.id;
    this._editingDeviceEnabled = device.enabled;
    this.showAddDeviceForm();

    // Defer to let the DOM render
    requestAnimationFrame(() => {
      // Update the title
      const formEl = document.getElementById('lightingDeviceForm');
      if (!formEl) return;
      const h3 = formEl.querySelector('h3');
      if (h3) h3.textContent = `✏️ ${i18n.t('lighting.editDevice') || 'Modifier'} "${device.name}"`;

      // Pre-fill common fields
      const nameEl = document.getElementById('ldFormName');
      if (nameEl) nameEl.value = device.name;

      const typeEl = document.getElementById('ldFormType');
      if (typeEl) { typeEl.value = device.type; this._updateDeviceFormFields(); }

      const ledCountEl = document.getElementById('ldFormLedCount');
      if (ledCountEl) ledCountEl.value = device.led_count;

      const cfg = device.connection_config || {};

      // Pre-fill type-specific fields
      if (device.type === 'gpio') {
        if (cfg.pins) {
          const pinR = document.getElementById('ldFormPinR');
          const pinG = document.getElementById('ldFormPinG');
          const pinB = document.getElementById('ldFormPinB');
          if (pinR) pinR.value = cfg.pins.r ?? 17;
          if (pinG) pinG.value = cfg.pins.g ?? 27;
          if (pinB) pinB.value = cfg.pins.b ?? 22;
        }
      } else if (device.type === 'gpio_strip') {
        // Clear default entries and repopulate
        const stripsContainer = document.getElementById('ldFormStripsContainer');
        if (stripsContainer) stripsContainer.innerHTML = '';
        if (cfg.strips && cfg.strips.length) {
          for (const strip of cfg.strips) {
            this._addStripEntry();
            const entries = document.querySelectorAll('#ldFormStripsContainer .strip-entry');
            const entry = entries[entries.length - 1];
            if (entry) {
              const chSel = entry.querySelector('.strip-channel');
              if (chSel) { chSel.value = strip.channel ?? 0; this._onStripChannelChange(chSel); }
              const gpioSel = entry.querySelector('.strip-gpio');
              if (gpioSel) gpioSel.value = strip.gpio ?? 18;
              const ledEl = entry.querySelector('.strip-ledcount');
              if (ledEl) ledEl.value = strip.led_count ?? 30;
              const briEl = entry.querySelector('.strip-brightness');
              if (briEl) briEl.value = strip.brightness ?? 255;
            }
          }
        }
        const segContainer = document.getElementById('ldFormSegmentsContainer');
        if (segContainer) segContainer.innerHTML = '';
        if (cfg.segments && cfg.segments.length) {
          for (const seg of cfg.segments) {
            this._addSegmentEntry();
            const segEntries = document.querySelectorAll('#ldFormSegmentsContainer .segment-entry');
            const sEntry = segEntries[segEntries.length - 1];
            if (sEntry) {
              const nameEl2 = sEntry.querySelector('.seg-name');
              if (nameEl2) nameEl2.value = seg.name || '';
              const startEl = sEntry.querySelector('.seg-start');
              if (startEl) startEl.value = seg.start ?? 0;
              const endEl = sEntry.querySelector('.seg-end');
              if (endEl) endEl.value = seg.end ?? 0;
            }
          }
        }
      } else if (device.type === 'serial') {
        const portEl = document.getElementById('ldFormSerialPort');
        if (portEl) portEl.value = cfg.port || '/dev/ttyUSB0';
      } else if (device.type === 'artnet') {
        const hostEl = document.getElementById('ldFormArtnetHost');
        if (hostEl) hostEl.value = cfg.host || '255.255.255.255';
        const uniEl = document.getElementById('ldFormArtnetUniverse');
        if (uniEl) uniEl.value = cfg.universe ?? 0;
        const subEl = document.getElementById('ldFormArtnetSubnet');
        if (subEl) subEl.value = cfg.subnet ?? 0;
        const chEl = document.getElementById('ldFormArtnetChannels');
        if (chEl) chEl.value = cfg.channels_per_led ?? 3;
      } else if (device.type === 'sacn') {
        const uniEl = document.getElementById('ldFormSacnUniverse');
        if (uniEl) uniEl.value = cfg.universe ?? 1;
        const priEl = document.getElementById('ldFormSacnPriority');
        if (priEl) priEl.value = cfg.priority ?? 100;
        const chEl = document.getElementById('ldFormSacnChannels');
        if (chEl) chEl.value = cfg.channels_per_led ?? 3;
        const mcEl = document.getElementById('ldFormSacnMulticast');
        if (mcEl) { mcEl.checked = cfg.multicast !== false; mcEl.dispatchEvent(new Event('change')); }
        if (!cfg.multicast) {
          const hostEl = document.getElementById('ldFormSacnHost');
          if (hostEl) hostEl.value = cfg.host || '';
        }
      } else if (device.type === 'mqtt') {
        const brokerEl = document.getElementById('ldFormMqttBroker');
        if (brokerEl) brokerEl.value = cfg.broker_url || 'mqtt://localhost:1883';
        const topicEl = document.getElementById('ldFormMqttTopic');
        if (topicEl) topicEl.value = cfg.base_topic || 'wled/maestro';
        const fwEl = document.getElementById('ldFormMqttFirmware');
        if (fwEl) fwEl.value = cfg.firmware || 'wled';
        const userEl = document.getElementById('ldFormMqttUser');
        if (userEl) userEl.value = cfg.username || '';
        const passEl = document.getElementById('ldFormMqttPass');
        if (passEl) passEl.value = cfg.password || '';
      } else if (device.type === 'http') {
        const urlEl = document.getElementById('ldFormHttpUrl');
        if (urlEl) urlEl.value = cfg.base_url || 'http://192.168.1.100';
        const fwEl = document.getElementById('ldFormHttpFirmware');
        if (fwEl) fwEl.value = cfg.firmware || 'wled';
        const apiEl = document.getElementById('ldFormHttpApiKey');
        if (apiEl) apiEl.value = cfg.api_key || '';
      } else if (device.type === 'osc') {
        const hostEl = document.getElementById('ldFormOscHost');
        if (hostEl) hostEl.value = cfg.host || '127.0.0.1';
        const portEl = document.getElementById('ldFormOscPort');
        if (portEl) portEl.value = cfg.port ?? 8000;
        const patEl = document.getElementById('ldFormOscPattern');
        if (patEl) patEl.value = cfg.address_pattern || '/light/{led}';
        const fmtEl = document.getElementById('ldFormOscFormat');
        if (fmtEl) fmtEl.value = cfg.color_format || 'rgb_float';
      }

      // Add enabled checkbox for edit mode
      const buttonsDiv = formEl.querySelector('div[style*="justify-content:flex-end"]');
      if (buttonsDiv) {
        const enabledDiv = document.createElement('div');
        enabledDiv.style.cssText = 'margin-bottom:12px;';
        enabledDiv.innerHTML = `<label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
          <input id="ldFormEnabled" type="checkbox" ${device.enabled ? 'checked' : ''}>
          <span style="font-size:12px;color:${t.text};">Activé</span>
        </label>`;
        buttonsDiv.parentNode.insertBefore(enabledDiv, buttonsDiv);
      }

      // Change submit button text
      const submitBtns = formEl.querySelectorAll('button');
      submitBtns.forEach(btn => {
        if (btn.textContent.trim() === 'Ajouter') {
          btn.textContent = 'Enregistrer';
          btn.style.background = '#8b5cf6';
          btn.onclick = () => lightingControlPageInstance.submitEditDevice();
        }
      });

      // Disable type selector (cannot change type during edit)
      if (typeEl) { typeEl.disabled = true; typeEl.style.opacity = '0.6'; }
    });
  }

  async submitEditDevice() {
    if (!this._editingDeviceId) return;

    const nameEl = document.getElementById('ldFormName');
    const nameErr = document.getElementById('ldFormNameError');
    const name = nameEl?.value.trim();
    if (!name) {
      if (nameEl) nameEl.style.borderColor = '#ef4444';
      if (nameErr) nameErr.style.display = 'block';
      return;
    }

    const type = document.getElementById('ldFormType')?.value;
    let ledCount = Math.max(1, Math.min(10000, parseInt(document.getElementById('ldFormLedCount')?.value) || 1));

    // Reuse the same connection_config building logic from submitAddDevice
    let connectionConfig = {};
    if (type === 'gpio') {
      connectionConfig = {
        pins: {
          r: Math.max(0, Math.min(27, parseInt(document.getElementById('ldFormPinR')?.value) || 17)),
          g: Math.max(0, Math.min(27, parseInt(document.getElementById('ldFormPinG')?.value) || 27)),
          b: Math.max(0, Math.min(27, parseInt(document.getElementById('ldFormPinB')?.value) || 22))
        }
      };
    } else if (type === 'gpio_strip') {
      const stripEntries = document.querySelectorAll('#ldFormStripsContainer .strip-entry');
      const strips = [];
      let totalLeds = 0;
      stripEntries.forEach(entry => {
        const count = Math.max(1, Math.min(1000, parseInt(entry.querySelector('.strip-ledcount')?.value) || 30));
        strips.push({
          channel: parseInt(entry.querySelector('.strip-channel')?.value),
          gpio: parseInt(entry.querySelector('.strip-gpio')?.value),
          led_count: count,
          brightness: Math.max(0, Math.min(255, parseInt(entry.querySelector('.strip-brightness')?.value) || 255))
        });
        totalLeds += count;
      });
      const segEntries = document.querySelectorAll('#ldFormSegmentsContainer .segment-entry');
      const segments = [];
      segEntries.forEach(entry => {
        const segName = entry.querySelector('.seg-name')?.value.trim();
        if (segName) {
          segments.push({
            name: segName,
            start: Math.max(0, parseInt(entry.querySelector('.seg-start')?.value) || 0),
            end: Math.max(0, parseInt(entry.querySelector('.seg-end')?.value) || 0)
          });
        }
      });
      connectionConfig = { strips, segments, frequency: 800000, dma: 10 };
      ledCount = totalLeds || 1;
    } else if (type === 'serial') {
      connectionConfig = { port: document.getElementById('ldFormSerialPort')?.value || '/dev/ttyUSB0', baud: 115200 };
    } else if (type === 'artnet') {
      connectionConfig = {
        host: document.getElementById('ldFormArtnetHost')?.value || '255.255.255.255',
        universe: parseInt(document.getElementById('ldFormArtnetUniverse')?.value) || 0,
        subnet: parseInt(document.getElementById('ldFormArtnetSubnet')?.value) || 0,
        channels_per_led: parseInt(document.getElementById('ldFormArtnetChannels')?.value) || 3
      };
    } else if (type === 'sacn') {
      const multicast = document.getElementById('ldFormSacnMulticast')?.checked !== false;
      connectionConfig = {
        universe: parseInt(document.getElementById('ldFormSacnUniverse')?.value) || 1,
        priority: parseInt(document.getElementById('ldFormSacnPriority')?.value) || 100,
        channels_per_led: parseInt(document.getElementById('ldFormSacnChannels')?.value) || 3,
        multicast,
        host: !multicast ? (document.getElementById('ldFormSacnHost')?.value || null) : null
      };
    } else if (type === 'mqtt') {
      connectionConfig = {
        broker_url: document.getElementById('ldFormMqttBroker')?.value || 'mqtt://localhost:1883',
        base_topic: document.getElementById('ldFormMqttTopic')?.value || 'wled/maestro',
        firmware: document.getElementById('ldFormMqttFirmware')?.value || 'wled',
        username: document.getElementById('ldFormMqttUser')?.value || undefined,
        password: document.getElementById('ldFormMqttPass')?.value || undefined
      };
    } else if (type === 'http') {
      connectionConfig = {
        base_url: document.getElementById('ldFormHttpUrl')?.value || 'http://192.168.1.100',
        firmware: document.getElementById('ldFormHttpFirmware')?.value || 'wled',
        api_key: document.getElementById('ldFormHttpApiKey')?.value || null
      };
    } else if (type === 'osc') {
      connectionConfig = {
        host: document.getElementById('ldFormOscHost')?.value || '127.0.0.1',
        port: parseInt(document.getElementById('ldFormOscPort')?.value) || 8000,
        address_pattern: document.getElementById('ldFormOscPattern')?.value || '/light/{led}',
        color_format: document.getElementById('ldFormOscFormat')?.value || 'rgb_float'
      };
    }

    try {
      await this.apiClient.sendCommand('lighting_device_update', {
        id: this._editingDeviceId,
        name, led_count: ledCount,
        enabled: document.getElementById('ldFormEnabled')?.checked ?? this._editingDeviceEnabled ?? true,
        connection_config: connectionConfig
      });
      document.getElementById('lightingDeviceForm')?.remove();
      this._editingDeviceId = null;
      await this.loadData();
    } catch (error) { this.showToast(error.message, 'error'); }
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

  // ==================== ADD/EDIT RULE ====================

  showAddRuleForm(existingRule = null) {
    const isEdit = !!existingRule;
    const cond = existingRule?.condition_config || {};
    const action = existingRule?.action_config || {};
    const t = this._t();

    const instrumentOptions = this.instruments.map(inst => {
      const name = inst.custom_name || inst.name || inst.device_id;
      const selected = existingRule?.instrument_id === inst.id ? 'selected' : '';
      return `<option value="${this._escapeHtml(inst.id)}" ${selected}>${this._escapeHtml(name)} (ch${(inst.channel || 0) + 1})</option>`;
    }).join('');

    const is = `style="width:100%;padding:7px 10px;border:1px solid ${t.inputBorder};border-radius:8px;font-size:13px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};"`;
    const lb = `style="font-size:12px;font-weight:600;color:${t.text};display:block;margin-bottom:3px;"`;

    const formHTML = `
      <div id="lightingRuleForm" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:10001;display:flex;align-items:center;justify-content:center;">
        <div style="background:${t.bg};border-radius:12px;padding:20px;width:560px;max-width:95vw;max-height:85vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
          <h3 style="margin:0 0 14px;font-size:16px;color:${t.text};">📐 ${isEdit ? (i18n.t('lighting.editRule') || 'Modifier la règle') : (i18n.t('lighting.addRule') || 'Ajouter une règle')}</h3>

          <div style="margin-bottom:10px;"><label ${lb}>Nom</label><input id="lrFormName" type="text" value="${this._escapeHtml(existingRule?.name || '')}" placeholder="Note On Rouge" ${is}></div>

          <div style="margin-bottom:10px;"><label ${lb}>${i18n.t('lighting.instrument') || 'Instrument'}</label>
            <select id="lrFormInstrument" ${is}><option value="">${i18n.t('lighting.anyInstrument') || 'Tout instrument'}</option>${instrumentOptions}</select>
          </div>

          <div style="margin-bottom:10px;">
            <button type="button" onclick="lightingControlPageInstance._startMidiLearn()" id="lrMidiLearnBtn" style="width:100%;padding:8px;border:2px dashed #f59e0b;border-radius:8px;background:${t.bgAlt};color:#d97706;cursor:pointer;font-size:12px;font-weight:600;">🎹 MIDI Learn — Jouez une note pour auto-configurer la condition</button>
          </div>

          <hr style="border:none;border-top:1px solid ${t.border};margin:14px 0;">
          <h4 style="margin:0 0 10px;font-size:13px;color:${t.textSec};">🎯 ${i18n.t('lighting.condition') || 'Condition'}</h4>

          <div style="margin-bottom:10px;"><label ${lb}>${i18n.t('lighting.triggerType') || 'Type'}</label>
            <select id="lrFormTrigger" ${is}>
              <option value="noteon" ${cond.trigger === 'noteon' ? 'selected' : ''}>Note On</option>
              <option value="noteoff" ${cond.trigger === 'noteoff' ? 'selected' : ''}>Note Off</option>
              <option value="cc" ${cond.trigger === 'cc' ? 'selected' : ''}>CC</option>
              <option value="any" ${cond.trigger === 'any' ? 'selected' : ''}>Tous</option>
            </select>
          </div>

          <div style="margin-bottom:10px;"><label ${lb}>${i18n.t('lighting.channel') || 'Canal MIDI'}</label>
            <input id="lrFormChannels" type="text" value="${(cond.channels || []).map(c => c + 1).join(', ')}" placeholder="Tous (ou 1, 2, 10)" ${is}>
            <span style="font-size:10px;color:${t.textMuted};">Vide = tous. Séparez par virgule (1-16)</span>
          </div>

          <div style="display:flex;gap:10px;margin-bottom:10px;">
            <div style="flex:1;"><label ${lb}>${i18n.t('lighting.velocityMin') || 'Vélo min'}</label><input id="lrFormVelMin" type="number" min="0" max="127" value="${cond.velocity_min || 0}" ${is}></div>
            <div style="flex:1;"><label ${lb}>${i18n.t('lighting.velocityMax') || 'Vélo max'}</label><input id="lrFormVelMax" type="number" min="0" max="127" value="${cond.velocity_max !== undefined ? cond.velocity_max : 127}" ${is}></div>
          </div>

          <div style="display:flex;gap:10px;margin-bottom:10px;">
            <div style="flex:1;"><label ${lb}>${i18n.t('lighting.noteMin') || 'Note min'}</label><input id="lrFormNoteMin" type="number" min="0" max="127" value="${cond.note_min || 0}" ${is}></div>
            <div style="flex:1;"><label ${lb}>${i18n.t('lighting.noteMax') || 'Note max'}</label><input id="lrFormNoteMax" type="number" min="0" max="127" value="${cond.note_max !== undefined ? cond.note_max : 127}" ${is}></div>
          </div>

          <div style="display:flex;gap:10px;margin-bottom:10px;">
            <div style="flex:1;"><label ${lb}>${i18n.t('lighting.ccNumber') || 'CC #'}</label><input id="lrFormCcNum" type="text" value="${(cond.cc_number || []).join(', ')}" placeholder="7, 11" ${is}></div>
            <div style="flex:0.5;"><label ${lb}>CC min</label><input id="lrFormCcMin" type="number" min="0" max="127" value="${cond.cc_value_min || 0}" ${is}></div>
            <div style="flex:0.5;"><label ${lb}>CC max</label><input id="lrFormCcMax" type="number" min="0" max="127" value="${cond.cc_value_max !== undefined ? cond.cc_value_max : 127}" ${is}></div>
          </div>

          <hr style="border:none;border-top:1px solid ${t.border};margin:14px 0;">
          <h4 style="margin:0 0 10px;font-size:13px;color:${t.textSec};">🎨 ${i18n.t('lighting.action') || 'Action lumineuse'}</h4>

          <div style="margin-bottom:10px;"><label ${lb}>${i18n.t('lighting.actionType') || 'Type'}</label>
            <select id="lrFormActionType" onchange="lightingControlPageInstance._updateActionFields()" ${is}>
              <optgroup label="Couleurs">
                <option value="static" ${action.type === 'static' || !action.type ? 'selected' : ''}>Couleur fixe</option>
                <option value="velocity_mapped" ${action.type === 'velocity_mapped' ? 'selected' : ''}>Gradient vélocité</option>
                <option value="note_color" ${action.type === 'note_color' ? 'selected' : ''}>🎹 Note → Couleur</option>
                <option value="color_temp" ${action.type === 'color_temp' ? 'selected' : ''}>🌡️ Température couleur</option>
                <option value="random_color" ${action.type === 'random_color' ? 'selected' : ''}>🎲 Couleur aléatoire</option>
                <option value="note_led" ${action.type === 'note_led' ? 'selected' : ''}>🎹 Note → LED (piano)</option>
                <option value="vu_meter" ${action.type === 'vu_meter' ? 'selected' : ''}>📊 VU-mètre (vélocité)</option>
                <option value="pulse" ${action.type === 'pulse' ? 'selected' : ''}>Pulse (flash)</option>
                <option value="fade" ${action.type === 'fade' ? 'selected' : ''}>Fade (fondu)</option>
              </optgroup>
              <optgroup label="Effets animés">
                <option value="strobe" ${action.type === 'strobe' ? 'selected' : ''}>⚡ Stroboscope</option>
                <option value="rainbow" ${action.type === 'rainbow' ? 'selected' : ''}>🌈 Arc-en-ciel</option>
                <option value="chase" ${action.type === 'chase' ? 'selected' : ''}>🏃 Chenillard</option>
                <option value="fire" ${action.type === 'fire' ? 'selected' : ''}>🔥 Feu</option>
                <option value="breathe" ${action.type === 'breathe' ? 'selected' : ''}>💨 Respiration</option>
                <option value="sparkle" ${action.type === 'sparkle' ? 'selected' : ''}>✨ Étincelles</option>
                <option value="color_cycle" ${action.type === 'color_cycle' ? 'selected' : ''}>🎨 Cycle couleurs</option>
                <option value="wave" ${action.type === 'wave' ? 'selected' : ''}>🌊 Vague</option>
              </optgroup>
            </select>
          </div>

          <div id="lrFormStaticColor" style="margin-bottom:10px;">
            <label ${lb}>${i18n.t('lighting.color') || 'Couleur'}</label>
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
              <input id="lrFormColor" type="color" value="${action.color || '#FF0000'}" style="width:50px;height:36px;border:1px solid ${t.inputBorder};border-radius:8px;cursor:pointer;padding:2px;">
              <span id="lrFormColorHex" style="font-size:12px;color:${t.textSec};font-family:monospace;">${action.color || '#FF0000'}</span>
              <button type="button" onclick="lightingControlPageInstance.showColorWheel('lrFormColor')" style="padding:4px 8px;border:1px solid ${t.inputBorder};border-radius:6px;background:${t.btnBg};color:${t.textSec};cursor:pointer;font-size:11px;">🎨 Roue</button>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:3px;">${this._renderQuickColors('lrFormColor')}</div>
          </div>

          <div id="lrFormGradientSection" style="display:${action.type === 'velocity_mapped' ? 'block' : 'none'};margin-bottom:10px;">
            <label ${lb}>${i18n.t('lighting.colorGradient') || 'Gradient (vélocité)'}</label>
            <div style="display:flex;align-items:center;gap:6px;">
              <span style="font-size:10px;color:${t.textMuted};">Doux</span>
              <input id="lrFormColorLow" type="color" value="${this._getColorMapValue(action.color_map, 0) || '#0000FF'}" style="width:36px;height:28px;border:1px solid ${t.inputBorder};border-radius:6px;cursor:pointer;">
              <span style="font-size:10px;color:${t.textMuted};">Moyen</span>
              <input id="lrFormColorMid" type="color" value="${this._getColorMapValue(action.color_map, 64) || '#FFFF00'}" style="width:36px;height:28px;border:1px solid ${t.inputBorder};border-radius:6px;cursor:pointer;">
              <span style="font-size:10px;color:${t.textMuted};">Fort</span>
              <input id="lrFormColorHigh" type="color" value="${this._getColorMapValue(action.color_map, 127) || '#FF0000'}" style="width:36px;height:28px;border:1px solid ${t.inputBorder};border-radius:6px;cursor:pointer;">
            </div>
            <div id="lrFormGradientPreview" style="margin-top:6px;height:12px;border-radius:6px;background:linear-gradient(to right,${this._getColorMapValue(action.color_map, 0) || '#0000FF'},${this._getColorMapValue(action.color_map, 64) || '#FFFF00'},${this._getColorMapValue(action.color_map, 127) || '#FF0000'});"></div>
          </div>

          <!-- Color temperature fields -->
          <div id="lrFormColorTempSection" style="display:${action.type === 'color_temp' ? 'block' : 'none'};">
            <div style="padding:8px 10px;background:${t.bgAlt};border:1px solid ${t.borderLight};border-radius:8px;margin-bottom:10px;">
              <div style="font-size:11px;font-weight:600;color:${t.textSec};margin-bottom:6px;">🌡️ Température de couleur</div>
              <div style="display:flex;gap:8px;">
                <div style="flex:1;"><label style="font-size:10px;color:${t.textMuted};display:block;margin-bottom:2px;">Chaud (K)</label><input id="lrFormTempWarm" type="number" min="1000" max="10000" value="${action.temp_warm || 2700}" style="width:100%;padding:5px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:12px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};"></div>
                <div style="flex:1;"><label style="font-size:10px;color:${t.textMuted};display:block;margin-bottom:2px;">Froid (K)</label><input id="lrFormTempCool" type="number" min="1000" max="10000" value="${action.temp_cool || 6500}" style="width:100%;padding:5px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:12px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};"></div>
              </div>
              <div style="margin-top:4px;height:10px;border-radius:4px;background:linear-gradient(to right,#FF9329,#FFD4A3,#FFF4E5,#F5F3FF,#CAE2FF);"></div>
              <div style="display:flex;justify-content:space-between;font-size:9px;color:${t.textMuted};"><span>Chaud (bougie)</span><span>Froid (ciel)</span></div>
            </div>
          </div>

          <!-- Note-to-LED mapping info -->
          <div id="lrFormNoteLedSection" style="display:${action.type === 'note_led' ? 'block' : 'none'};">
            <div style="padding:8px 10px;background:${t.bgAlt};border:1px solid ${t.borderLight};border-radius:8px;margin-bottom:10px;">
              <div style="font-size:11px;font-weight:600;color:${t.textSec};margin-bottom:4px;">🎹 Note → LED (visualisation piano)</div>
              <div style="font-size:10px;color:${t.textMuted};margin-bottom:6px;">Chaque note MIDI allume une LED spécifique le long du bandeau.</div>
              <div style="display:flex;gap:8px;">
                <div style="flex:1;"><label style="font-size:10px;color:${t.textMuted};display:block;margin-bottom:2px;">Note MIDI min</label><input id="lrFormNoteLedMin" type="number" min="0" max="127" value="${action.note_led_min || 36}" style="width:100%;padding:5px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:12px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};"></div>
                <div style="flex:1;"><label style="font-size:10px;color:${t.textMuted};display:block;margin-bottom:2px;">Note MIDI max</label><input id="lrFormNoteLedMax" type="number" min="0" max="127" value="${action.note_led_max || 96}" style="width:100%;padding:5px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:12px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};"></div>
              </div>
              <div style="margin-top:4px;height:10px;border-radius:4px;background:linear-gradient(to right,#FF0000,#FF8000,#FFFF00,#80FF00,#00FF00,#00FF80,#00FFFF,#0080FF,#0000FF,#8000FF,#FF00FF,#FF0080);"></div>
            </div>
          </div>

          <!-- Note-to-color info -->
          <div id="lrFormNoteColorSection" style="display:${action.type === 'note_color' ? 'block' : 'none'};">
            <div style="padding:8px 10px;background:${t.bgAlt};border:1px solid ${t.borderLight};border-radius:8px;margin-bottom:10px;">
              <div style="font-size:11px;font-weight:600;color:${t.textSec};margin-bottom:4px;">🎹 Note → Couleur chromatique</div>
              <div style="height:14px;border-radius:4px;background:linear-gradient(to right,#FF0000,#FF8000,#FFFF00,#80FF00,#00FF00,#00FF80,#00FFFF,#0080FF,#0000FF,#8000FF,#FF00FF,#FF0080,#FF0000);margin-bottom:2px;"></div>
              <div style="display:flex;justify-content:space-between;font-size:8px;color:${t.textMuted};"><span>C</span><span>D</span><span>E</span><span>F</span><span>G</span><span>A</span><span>B</span><span>C</span></div>
            </div>
          </div>

          <!-- Effect-specific fields -->
          <div id="lrFormEffectSection" style="display:${this._isEffectType(action.type) ? 'block' : 'none'};">
            <div style="padding:8px 10px;background:${t.bgAlt};border:1px solid ${t.borderLight};border-radius:8px;margin-bottom:10px;">
              <div style="font-size:11px;font-weight:600;color:${t.textSec};margin-bottom:6px;">⚡ Paramètres de l'effet</div>
              <div style="display:flex;gap:8px;margin-bottom:6px;">
                <div style="flex:1;"><label style="font-size:10px;color:${t.textMuted};display:block;margin-bottom:2px;">Vitesse (ms)</label><input id="lrFormEffectSpeed" type="number" min="20" max="10000" value="${action.effect_speed || 500}" style="width:100%;padding:5px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:12px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};"></div>
                <div style="flex:1;"><label style="font-size:10px;color:${t.textMuted};display:block;margin-bottom:2px;">Densité (étincelles)</label><input id="lrFormEffectDensity" type="number" min="0.01" max="1" step="0.05" value="${action.effect_density || 0.1}" style="width:100%;padding:5px;border:1px solid ${t.inputBorder};border-radius:6px;font-size:12px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};"></div>
              </div>
              <div style="margin-bottom:4px;"><label style="font-size:10px;color:${t.textMuted};display:block;margin-bottom:2px;">Couleur secondaire (chenillard, vague)</label>
                <div style="display:flex;align-items:center;gap:8px;">
                  <input id="lrFormColor2" type="color" value="${action.color2 || '#000000'}" style="width:36px;height:28px;border:1px solid ${t.inputBorder};border-radius:6px;cursor:pointer;">
                  <span id="lrFormColor2Hex" style="font-size:11px;color:${t.textMuted};font-family:monospace;">${action.color2 || '#000000'}</span>
                </div>
              </div>
            </div>
          </div>

          <div style="margin-bottom:10px;">
            <div style="display:flex;align-items:center;gap:10px;">
              <label style="font-size:12px;font-weight:600;color:${t.text};">${i18n.t('lighting.brightness') || 'Luminosité'}</label>
              <input id="lrFormBrightness" type="range" min="0" max="255" value="${action.brightness !== undefined ? action.brightness : 255}" style="flex:1;">
              <span id="lrFormBrightnessVal" style="font-size:11px;color:${t.textSec};min-width:30px;text-align:right;">${action.brightness !== undefined ? action.brightness : 255}</span>
            </div>
          </div>

          <div style="margin-bottom:10px;">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
              <input id="lrFormBrightVel" type="checkbox" ${action.brightness_from_velocity ? 'checked' : ''}>
              <span style="font-size:12px;color:${t.text};">${i18n.t('lighting.brightnessFromVelocity') || 'Luminosité → vélocité'}</span>
            </label>
          </div>

          <div id="lrFormSegmentRow" style="display:none;margin-bottom:10px;">
            <label ${lb}>Segment</label>
            <select id="lrFormSegment" onchange="lightingControlPageInstance._onSegmentSelect()" ${is}>
              <option value="">-- Aucun (manuel) --</option>
            </select>
          </div>

          <div style="display:flex;gap:10px;margin-bottom:10px;">
            <div style="flex:1;"><label ${lb}>LED début</label><input id="lrFormLedStart" type="number" min="0" value="${action.led_start || 0}" ${is}></div>
            <div style="flex:1;"><label ${lb}>LED fin (-1=toutes)</label><input id="lrFormLedEnd" type="number" min="-1" value="${action.led_end !== undefined ? action.led_end : -1}" ${is}></div>
          </div>

          <div style="display:flex;gap:10px;margin-bottom:10px;">
            <div style="flex:1;"><label ${lb}>${i18n.t('lighting.fadeTime') || 'Fondu (ms)'}</label><input id="lrFormFadeTime" type="number" min="0" max="5000" value="${action.fade_time_ms || 200}" ${is}></div>
            <div style="flex:1;"><label ${lb}>${i18n.t('lighting.offAction') || 'Relâchement'}</label>
              <select id="lrFormOffAction" ${is}>
                <option value="instant" ${action.off_action === 'instant' || !action.off_action ? 'selected' : ''}>Instant</option>
                <option value="fade" ${action.off_action === 'fade' ? 'selected' : ''}>Fondu</option>
                <option value="hold" ${action.off_action === 'hold' ? 'selected' : ''}>Maintenir</option>
              </select>
            </div>
          </div>

          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
            <button onclick="document.getElementById('lightingRuleForm').remove()" style="padding:7px 14px;border:1px solid ${t.btnBorder};border-radius:8px;background:${t.btnBg};color:${t.text};cursor:pointer;font-size:12px;">Annuler</button>
            <button onclick="lightingControlPageInstance.submitRule(${existingRule ? existingRule.id : 'null'})" style="padding:7px 14px;border:none;border-radius:8px;background:#10b981;color:white;cursor:pointer;font-weight:600;font-size:12px;">${isEdit ? 'Modifier' : 'Ajouter'}</button>
          </div>
        </div>
      </div>`;

    const div = document.createElement('div');
    div.innerHTML = formHTML;
    document.body.appendChild(div.firstElementChild);

    // Bind live updates
    const colorInput = document.getElementById('lrFormColor');
    const colorHex = document.getElementById('lrFormColorHex');
    if (colorInput && colorHex) colorInput.addEventListener('input', () => { colorHex.textContent = colorInput.value; });

    const brightnessInput = document.getElementById('lrFormBrightness');
    const brightnessVal = document.getElementById('lrFormBrightnessVal');
    if (brightnessInput && brightnessVal) brightnessInput.addEventListener('input', () => { brightnessVal.textContent = brightnessInput.value; });

    // Bind gradient live preview
    ['lrFormColorLow', 'lrFormColorMid', 'lrFormColorHigh'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', () => this._updateGradientPreview());
    });

    // Bind color2 live update
    const color2Input = document.getElementById('lrFormColor2');
    const color2Hex = document.getElementById('lrFormColor2Hex');
    if (color2Input && color2Hex) color2Input.addEventListener('input', () => { color2Hex.textContent = color2Input.value; });

    // Populate segment dropdown if selected device is gpio_strip
    this._populateSegmentDropdown(existingRule?.action_config?.segment);
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

  async submitRule(existingId) {
    const name = document.getElementById('lrFormName').value.trim();
    const instrumentId = document.getElementById('lrFormInstrument').value || null;
    const trigger = document.getElementById('lrFormTrigger').value;

    const channelsStr = document.getElementById('lrFormChannels').value.trim();
    const channels = channelsStr ? channelsStr.split(',').map(s => parseInt(s.trim()) - 1).filter(n => n >= 0 && n <= 15) : null;

    const ccStr = document.getElementById('lrFormCcNum').value.trim();
    const ccNumbers = ccStr ? ccStr.split(',').map(s => parseInt(s.trim())).filter(n => n >= 0 && n <= 127) : null;

    const conditionConfig = {
      trigger,
      channels: channels?.length ? channels : null,
      velocity_min: this._clamp(document.getElementById('lrFormVelMin').value, 0, 127),
      velocity_max: this._clamp(document.getElementById('lrFormVelMax').value, 0, 127),
      note_min: this._clamp(document.getElementById('lrFormNoteMin').value, 0, 127),
      note_max: this._clamp(document.getElementById('lrFormNoteMax').value, 0, 127),
      cc_number: ccNumbers?.length ? ccNumbers : null,
      cc_value_min: this._clamp(document.getElementById('lrFormCcMin').value, 0, 127),
      cc_value_max: this._clamp(document.getElementById('lrFormCcMax').value, 0, 127)
    };

    const actionType = document.getElementById('lrFormActionType').value;
    const segmentValue = document.getElementById('lrFormSegment')?.value || null;
    const actionConfig = {
      type: actionType,
      color: document.getElementById('lrFormColor').value,
      brightness: this._clamp(document.getElementById('lrFormBrightness').value, 0, 255),
      brightness_from_velocity: document.getElementById('lrFormBrightVel').checked,
      led_start: Math.max(0, parseInt(document.getElementById('lrFormLedStart').value) || 0),
      led_end: parseInt(document.getElementById('lrFormLedEnd').value),
      fade_time_ms: this._clamp(document.getElementById('lrFormFadeTime').value, 0, 5000),
      off_action: document.getElementById('lrFormOffAction').value
    };
    if (segmentValue) actionConfig.segment = segmentValue;

    if (actionType === 'velocity_mapped') {
      actionConfig.color_map = {
        '0': document.getElementById('lrFormColorLow').value,
        '64': document.getElementById('lrFormColorMid').value,
        '127': document.getElementById('lrFormColorHigh').value
      };
    }

    // Note-to-LED config
    if (actionType === 'note_led') {
      actionConfig.note_led_min = parseInt(document.getElementById('lrFormNoteLedMin')?.value) || 36;
      actionConfig.note_led_max = parseInt(document.getElementById('lrFormNoteLedMax')?.value) || 96;
    }

    // Color temperature config
    if (actionType === 'color_temp') {
      actionConfig.temp_warm = parseInt(document.getElementById('lrFormTempWarm')?.value) || 2700;
      actionConfig.temp_cool = parseInt(document.getElementById('lrFormTempCool')?.value) || 6500;
    }

    // Effect-specific config
    if (this._isEffectType(actionType)) {
      actionConfig.effect_speed = Math.max(20, Math.min(10000, parseInt(document.getElementById('lrFormEffectSpeed')?.value) || 500));
      actionConfig.effect_density = Math.max(0.01, Math.min(1, parseFloat(document.getElementById('lrFormEffectDensity')?.value) || 0.1));
      const color2 = document.getElementById('lrFormColor2')?.value;
      if (color2 && color2 !== '#000000') actionConfig.color2 = color2;
    }

    // Validation
    if (conditionConfig.velocity_min > conditionConfig.velocity_max) {
      this.showToast('Vélocité min doit être ≤ vélocité max', 'warning'); return;
    }
    if (conditionConfig.note_min > conditionConfig.note_max) {
      this.showToast('Note min doit être ≤ note max', 'warning'); return;
    }

    try {
      if (existingId) {
        await this.apiClient.sendCommand('lighting_rule_update', {
          id: existingId, name, instrument_id: instrumentId,
          condition_config: conditionConfig, action_config: actionConfig
        });
      } else {
        await this.apiClient.sendCommand('lighting_rule_add', {
          device_id: this.selectedDeviceId, name, instrument_id: instrumentId,
          condition_config: conditionConfig, action_config: actionConfig
        });
      }
      document.getElementById('lightingRuleForm')?.remove();
      await this.loadRulesForDevice(this.selectedDeviceId);
    } catch (error) {
      this.showToast(error.message, 'error');
    }
  }

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

  // ==================== LED PREVIEW ====================

  _renderLedPreview(device) {
    const previewContainer = document.getElementById('lightingLedPreview');
    const stripViz = document.getElementById('lightingLedStripViz');
    if (!previewContainer || !stripViz) return;

    const ledCount = Math.min(device.led_count || 1, 200); // Cap visual at 200

    if (ledCount <= 0) {
      previewContainer.style.display = 'none';
      return;
    }

    previewContainer.style.display = 'block';

    // Calculate LED size based on count
    const ledSize = ledCount <= 30 ? 12 : ledCount <= 60 ? 8 : ledCount <= 120 ? 5 : 3;

    stripViz.innerHTML = '';
    for (let i = 0; i < ledCount; i++) {
      const led = document.createElement('div');
      led.className = 'led-preview-pixel';
      led.dataset.index = i;
      led.style.cssText = `width:${ledSize}px;height:${ledSize}px;border-radius:${ledSize <= 5 ? '1px' : '2px'};background:#333;transition:background 0.1s;`;
      led.title = `LED ${i}`;
      stripViz.appendChild(led);
    }
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

  // ==================== MIDI LEARN ====================

  async _startMidiLearn() {
    const btn = document.getElementById('lrMidiLearnBtn');
    if (!btn) return;

    btn.textContent = '🎹 En attente d\'un événement MIDI... (10s)';
    btn.style.borderColor = '#ef4444';
    btn.style.color = '#ef4444';
    btn.disabled = true;

    try {
      const res = await this.apiClient.sendCommand('lighting_midi_learn');

      if (res.success && res.learned) {
        const l = res.learned;

        // Fill in the condition fields
        if (l.type) {
          const triggerEl = document.getElementById('lrFormTrigger');
          if (triggerEl) triggerEl.value = l.type === 'noteon' ? 'noteon' : l.type === 'noteoff' ? 'noteoff' : l.type === 'cc' ? 'cc' : 'any';
        }
        if (l.channel !== undefined && l.channel !== null) {
          const chEl = document.getElementById('lrFormChannels');
          if (chEl) chEl.value = String(l.channel + 1);
        }
        if (l.note !== undefined && l.note !== null) {
          const noteMinEl = document.getElementById('lrFormNoteMin');
          const noteMaxEl = document.getElementById('lrFormNoteMax');
          if (noteMinEl) noteMinEl.value = l.note;
          if (noteMaxEl) noteMaxEl.value = l.note;
        }
        if (l.controller !== undefined && l.controller !== null) {
          const ccEl = document.getElementById('lrFormCcNum');
          if (ccEl) ccEl.value = String(l.controller);
        }

        btn.textContent = `✅ Capturé: ${l.type} ch${(l.channel || 0) + 1} note=${l.note ?? '-'} vel=${l.velocity ?? '-'} cc=${l.controller ?? '-'}`;
        btn.style.borderColor = '#10b981';
        btn.style.color = '#10b981';
      } else {
        btn.textContent = '⏰ Pas de signal MIDI reçu. Réessayez.';
        btn.style.borderColor = '#f59e0b';
        btn.style.color = '#d97706';
      }
    } catch (error) {
      btn.textContent = '❌ Erreur: ' + error.message;
      btn.style.borderColor = '#ef4444';
      btn.style.color = '#ef4444';
    }

    setTimeout(() => {
      if (btn) {
        btn.textContent = '🎹 MIDI Learn — Jouez une note pour auto-configurer la condition';
        btn.style.borderColor = '#f59e0b';
        btn.style.color = '#d97706';
        btn.disabled = false;
      }
    }, 5000);
  }

  // ==================== QUICK COLOR PRESETS ====================

  _renderQuickColors(targetInputId) {
    // Sanitize the ID to only allow alphanumeric + underscore
    const safeId = targetInputId.replace(/[^a-zA-Z0-9_]/g, '');
    const colors = [
      { hex: '#FF0000', name: 'Rouge' },
      { hex: '#FF4500', name: 'Orange' },
      { hex: '#FFD700', name: 'Or' },
      { hex: '#FFFF00', name: 'Jaune' },
      { hex: '#00FF00', name: 'Vert' },
      { hex: '#00CED1', name: 'Turquoise' },
      { hex: '#00BFFF', name: 'Cyan' },
      { hex: '#0000FF', name: 'Bleu' },
      { hex: '#8B00FF', name: 'Violet' },
      { hex: '#FF00FF', name: 'Magenta' },
      { hex: '#FF69B4', name: 'Rose' },
      { hex: '#FFFFFF', name: 'Blanc' },
      { hex: '#FFF5E1', name: 'Chaud' },
      { hex: '#E0E8FF', name: 'Froid' }
    ];
    return colors.map(c =>
      `<button type="button" onclick="document.getElementById('${safeId}').value='${c.hex}';document.getElementById('${safeId}').dispatchEvent(new Event('input'));" style="width:22px;height:22px;border-radius:50%;border:2px solid #ddd;background:${c.hex};cursor:pointer;padding:0;" title="${c.name}"></button>`
    ).join('');
  }

  // ==================== COLOR WHEEL ====================

  showColorWheel(targetInputId) {
    const safeTargetId = targetInputId.replace(/[^a-zA-Z0-9_]/g, '');
    const t = this._t();
    const existing = document.getElementById('lightingColorWheel');
    if (existing) existing.remove();

    const div = document.createElement('div');
    div.id = 'lightingColorWheel';
    div.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:10002;display:flex;align-items:center;justify-content:center;`;
    div.innerHTML = `
      <div style="background:${t.bg};border-radius:12px;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,0.3);text-align:center;">
        <h3 style="margin:0 0 12px;font-size:14px;color:${t.text};">🎨 Sélecteur de couleur</h3>
        <div style="display:flex;align-items:center;gap:12px;justify-content:center;">
          <canvas id="colorWheelCanvas" width="220" height="220" style="cursor:crosshair;border-radius:50%;"></canvas>
          <div style="display:flex;flex-direction:column;align-items:center;gap:4px;">
            <span style="font-size:10px;color:${t.textMuted};">Luminosité</span>
            <input id="colorWheelBrightness" type="range" min="10" max="100" value="100" orient="vertical" style="writing-mode:vertical-lr;direction:rtl;height:200px;width:20px;cursor:pointer;">
            <span id="colorWheelBriVal" style="font-size:10px;color:${t.textMuted};">100%</span>
          </div>
        </div>
        <div style="margin-top:10px;display:flex;align-items:center;justify-content:center;gap:8px;">
          <div id="colorWheelPreview" style="width:36px;height:36px;border-radius:50%;border:3px solid ${t.border};background:#FF0000;"></div>
          <span id="colorWheelHex" style="font-size:14px;color:${t.text};font-family:monospace;">#FF0000</span>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;justify-content:center;">
          <button id="colorWheelApply" style="padding:7px 18px;border:none;border-radius:8px;background:#10b981;color:white;cursor:pointer;font-weight:600;font-size:13px;">Appliquer</button>
          <button onclick="document.getElementById('lightingColorWheel').remove()" style="padding:7px 18px;border:1px solid ${t.btnBorder};border-radius:8px;background:${t.btnBg};color:${t.text};cursor:pointer;font-size:13px;">Annuler</button>
        </div>
      </div>`;

    document.body.appendChild(div);
    div.addEventListener('click', (e) => { if (e.target === div) div.remove(); });

    const canvas = document.getElementById('colorWheelCanvas');
    const ctx = canvas.getContext('2d');
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const radius = Math.min(cx, cy) - 4;
    let brightnessMultiplier = 1.0;

    const drawWheel = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let angle = 0; angle < 360; angle++) {
        const startAngle = (angle - 1) * Math.PI / 180;
        const endAngle = (angle + 1) * Math.PI / 180;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, radius, startAngle, endAngle);
        ctx.closePath();

        const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        const l = Math.round(50 * brightnessMultiplier);
        gradient.addColorStop(0, `hsl(0, 0%, ${Math.round(100 * brightnessMultiplier)}%)`);
        gradient.addColorStop(1, `hsl(${angle}, 100%, ${l}%)`);
        ctx.fillStyle = gradient;
        ctx.fill();
      }
    };

    drawWheel();

    let selectedColor = '#FF0000';

    const pickColor = (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      lastPickX = Math.round(x * scaleX);
      lastPickY = Math.round(y * scaleY);
      const pixel = ctx.getImageData(lastPickX, lastPickY, 1, 1).data;
      selectedColor = `#${pixel[0].toString(16).padStart(2, '0')}${pixel[1].toString(16).padStart(2, '0')}${pixel[2].toString(16).padStart(2, '0')}`;

      const preview = document.getElementById('colorWheelPreview');
      const hex = document.getElementById('colorWheelHex');
      if (preview) preview.style.background = selectedColor;
      if (hex) hex.textContent = selectedColor.toUpperCase();
    };

    // Brightness slider
    // Brightness slider
    let lastPickX = null, lastPickY = null;
    const briSlider = document.getElementById('colorWheelBrightness');
    const briVal = document.getElementById('colorWheelBriVal');
    if (briSlider) {
      briSlider.addEventListener('input', () => {
        brightnessMultiplier = parseInt(briSlider.value) / 100;
        if (briVal) briVal.textContent = briSlider.value + '%';
        drawWheel();
        // Re-sample color at last picked position after redraw
        if (lastPickX !== null && lastPickY !== null) {
          const pixel = ctx.getImageData(lastPickX, lastPickY, 1, 1).data;
          selectedColor = `#${pixel[0].toString(16).padStart(2, '0')}${pixel[1].toString(16).padStart(2, '0')}${pixel[2].toString(16).padStart(2, '0')}`;
          const preview = document.getElementById('colorWheelPreview');
          const hex = document.getElementById('colorWheelHex');
          if (preview) preview.style.background = selectedColor;
          if (hex) hex.textContent = selectedColor.toUpperCase();
        }
      });
    }

    let dragging = false;
    canvas.addEventListener('mousedown', (e) => { dragging = true; pickColor(e); });
    canvas.addEventListener('mousemove', (e) => { if (dragging) pickColor(e); });
    canvas.addEventListener('mouseup', () => { dragging = false; });
    canvas.addEventListener('click', pickColor);

    // Touch support
    canvas.addEventListener('touchstart', (e) => { e.preventDefault(); pickColor(e.touches[0]); });
    canvas.addEventListener('touchmove', (e) => { e.preventDefault(); pickColor(e.touches[0]); });

    document.getElementById('colorWheelApply').addEventListener('click', () => {
      const target = document.getElementById(safeTargetId);
      if (target) {
        target.value = selectedColor;
        target.dispatchEvent(new Event('input'));
      }
      div.remove();
    });
  }
}
