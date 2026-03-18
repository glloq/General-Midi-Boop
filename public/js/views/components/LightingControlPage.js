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
                <button onclick="lightingControlPageInstance.showPresetsPanel()" style="padding:5px 12px;border:2px solid rgba(255,255,255,0.4);border-radius:8px;background:rgba(255,255,255,0.15);color:white;cursor:pointer;font-size:12px;">📦 ${i18n.t('lighting.presets') || 'Presets'}</button>
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

          <!-- Body: two-panel layout -->
          <div id="lightingBody" style="display:flex;flex:1;overflow:hidden;">

            <!-- Left panel: Device list -->
            <div id="lightingDevicePanel" style="width:300px;min-width:260px;border-right:2px solid ${t.border};display:flex;flex-direction:column;background:${t.bgAlt};">
              <div style="padding:10px 14px;border-bottom:1px solid ${t.border};display:flex;justify-content:space-between;align-items:center;">
                <span style="font-weight:600;font-size:13px;color:${t.text};">📋 ${i18n.t('lighting.devices') || 'Dispositifs'}</span>
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
                  <button onclick="lightingControlPageInstance.testDevice()" style="padding:4px 8px;border:1px solid #3b82f6;border-radius:6px;background:${t.btnBg};color:#2563eb;cursor:pointer;font-size:11px;">🔦 ${i18n.t('lighting.testDevice') || 'Tester'}</button>
                  <button onclick="lightingControlPageInstance.showAddRuleForm()" style="padding:4px 8px;border:1px solid #10b981;border-radius:6px;background:${t.btnBg};color:#059669;cursor:pointer;font-size:11px;">+ ${i18n.t('lighting.addRule') || 'Règle'}</button>
                </div>
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

    this._escHandler = (e) => { if (e.key === 'Escape') this.close(); };
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
        this.apiClient.send('lighting_device_list'),
        this.apiClient.send('instrument_list_registered'),
        this.apiClient.send('lighting_preset_list')
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
      const res = await this.apiClient.send('lighting_rule_list', { device_id: deviceId });
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
            <button onclick="lightingControlPageInstance.testRule(${rule.id})" style="background:none;border:1px solid #3b82f6;border-radius:4px;color:#3b82f6;cursor:pointer;font-size:10px;padding:2px 6px;">Test</button>
            <button onclick="lightingControlPageInstance.toggleRule(${rule.id},${!rule.enabled})" style="background:none;border:none;cursor:pointer;font-size:13px;">${rule.enabled ? '✅' : '⬜'}</button>
            <button onclick="lightingControlPageInstance.editRule(${rule.id})" style="background:none;border:none;cursor:pointer;font-size:13px;">✏️</button>
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
        </div>
      </div>`;
  }

  _buildColorPreview(action) {
    if (action.type === 'velocity_mapped' && action.color_map) {
      const c0 = action.color_map['0'] || '#0000FF';
      const c64 = action.color_map['64'] || '#FFFF00';
      const c127 = action.color_map['127'] || '#FF0000';
      return `<div style="width:28px;height:16px;border-radius:4px;background:linear-gradient(to right,${c0},${c64},${c127});border:1px solid #ddd;flex-shrink:0;"></div>`;
    }
    const color = action.color || '#FFFFFF';
    return `<div style="width:16px;height:16px;border-radius:50%;background:${this._escapeHtml(color)};border:2px solid #ddd;flex-shrink:0;"></div>`;
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

          <div style="text-align:right;margin-top:12px;">
            <button onclick="document.getElementById('lightingPresetsPanel').remove()" style="padding:7px 14px;border:1px solid ${t.btnBorder};border-radius:8px;background:${t.btnBg};color:${t.text};cursor:pointer;font-size:12px;">Fermer</button>
          </div>
        </div>
      </div>`;

    const div = document.createElement('div');
    div.innerHTML = formHTML;
    document.body.appendChild(div.firstElementChild);
  }

  async savePreset() {
    const name = document.getElementById('lpFormName')?.value.trim();
    if (!name) return alert(i18n.t('lighting.presetName') || 'Nom requis');
    try {
      await this.apiClient.send('lighting_preset_save', { name });
      document.getElementById('lightingPresetsPanel')?.remove();
      const res = await this.apiClient.send('lighting_preset_list');
      this.presets = res.presets || [];
      this.showPresetsPanel();
    } catch (error) {
      alert('Erreur: ' + error.message);
    }
  }

  async loadPreset(id) {
    if (!confirm(i18n.t('lighting.confirmLoadPreset') || 'Charger ce preset ? Les règles actuelles seront remplacées.')) return;
    try {
      await this.apiClient.send('lighting_preset_load', { id });
      document.getElementById('lightingPresetsPanel')?.remove();
      await this.loadData();
    } catch (error) {
      alert('Erreur: ' + error.message);
    }
  }

  async deletePreset(id) {
    if (!confirm(i18n.t('lighting.confirmDeletePreset') || 'Supprimer ce preset ?')) return;
    try {
      await this.apiClient.send('lighting_preset_delete', { id });
      document.getElementById('lightingPresetsPanel')?.remove();
      const res = await this.apiClient.send('lighting_preset_list');
      this.presets = res.presets || [];
      this.showPresetsPanel();
    } catch (error) {
      alert('Erreur: ' + error.message);
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
              <option value="gpio">GPIO (Raspberry Pi)</option>
              <option value="gpio_strip">Bandeau LED GPIO (WS2812/NeoPixel)</option>
              <option value="serial">Serial (WS2812/NeoPixel)</option>
            </select>
          </div>

          <div style="margin-bottom:12px;">
            <label style="font-size:12px;font-weight:600;color:${t.text};display:block;margin-bottom:3px;">${i18n.t('lighting.ledCount') || 'Nombre de LEDs'}</label>
            <input id="ldFormLedCount" type="number" min="1" max="1000" value="1" style="width:100%;padding:7px 10px;border:1px solid ${t.inputBorder};border-radius:8px;font-size:13px;box-sizing:border-box;background:${t.inputBg};color:${t.inputText};">
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
    document.getElementById('ldFormGpioFields').style.display = type === 'gpio' ? 'block' : 'none';
    document.getElementById('ldFormSerialFields').style.display = type === 'serial' ? 'block' : 'none';
    const stripFields = document.getElementById('ldFormStripFields');
    if (stripFields) {
      stripFields.style.display = type === 'gpio_strip' ? 'block' : 'none';
      if (type === 'gpio_strip') {
        // Hide manual led_count field - auto-calculated for strips
        const ledCountEl = document.getElementById('ldFormLedCount');
        if (ledCountEl) ledCountEl.closest('div[style]').style.display = 'none';
        // Add a default strip entry if empty
        const container = document.getElementById('ldFormStripsContainer');
        if (container && container.children.length === 0) this._addStripEntry();
      } else {
        const ledCountEl = document.getElementById('ldFormLedCount');
        if (ledCountEl) ledCountEl.closest('div[style]').style.display = 'block';
      }
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
    let ledCount = Math.max(1, Math.min(1000, parseInt(document.getElementById('ldFormLedCount').value) || 1));

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
    }

    try {
      await this.apiClient.send('lighting_device_add', { name, type, led_count: ledCount, connection_config: connectionConfig });
      document.getElementById('lightingDeviceForm')?.remove();
      await this.loadData();
    } catch (error) {
      alert('Erreur: ' + error.message);
    }
  }

  async deleteDevice(id) {
    if (!confirm(i18n.t('lighting.confirmDeleteDevice') || 'Supprimer ce dispositif et toutes ses règles ?')) return;
    try {
      await this.apiClient.send('lighting_device_delete', { id });
      if (this.selectedDeviceId === id) { this.selectedDeviceId = null; this.rules = []; }
      await this.loadData();
    } catch (error) {
      alert('Erreur: ' + error.message);
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
      await this.apiClient.send('lighting_device_update', { id: this.selectedDeviceId, enabled: true });
      await this.loadData();
    } catch (error) {
      alert('Erreur: ' + error.message);
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
              <option value="static" ${action.type === 'static' || !action.type ? 'selected' : ''}>Couleur fixe</option>
              <option value="velocity_mapped" ${action.type === 'velocity_mapped' ? 'selected' : ''}>Gradient vélocité</option>
              <option value="pulse" ${action.type === 'pulse' ? 'selected' : ''}>Pulse</option>
              <option value="fade" ${action.type === 'fade' ? 'selected' : ''}>Fade</option>
            </select>
          </div>

          <div id="lrFormStaticColor" style="margin-bottom:10px;">
            <label ${lb}>${i18n.t('lighting.color') || 'Couleur'}</label>
            <div style="display:flex;align-items:center;gap:10px;">
              <input id="lrFormColor" type="color" value="${action.color || '#FF0000'}" style="width:50px;height:36px;border:1px solid ${t.inputBorder};border-radius:8px;cursor:pointer;padding:2px;">
              <span id="lrFormColorHex" style="font-size:12px;color:${t.textSec};font-family:monospace;">${action.color || '#FF0000'}</span>
            </div>
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
    if (type === 'velocity_mapped') { if (s) s.style.display = 'none'; if (g) g.style.display = 'block'; }
    else { if (s) s.style.display = 'block'; if (g) g.style.display = 'none'; }
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

    // Validation
    if (conditionConfig.velocity_min > conditionConfig.velocity_max) {
      return alert('Vélocité min doit être ≤ vélocité max');
    }
    if (conditionConfig.note_min > conditionConfig.note_max) {
      return alert('Note min doit être ≤ note max');
    }

    try {
      if (existingId) {
        await this.apiClient.send('lighting_rule_update', {
          id: existingId, name, instrument_id: instrumentId,
          condition_config: conditionConfig, action_config: actionConfig
        });
      } else {
        await this.apiClient.send('lighting_rule_add', {
          device_id: this.selectedDeviceId, name, instrument_id: instrumentId,
          condition_config: conditionConfig, action_config: actionConfig
        });
      }
      document.getElementById('lightingRuleForm')?.remove();
      await this.loadRulesForDevice(this.selectedDeviceId);
    } catch (error) {
      alert('Erreur: ' + error.message);
    }
  }

  async editRule(ruleId) {
    const rule = this.rules.find(r => r.id === ruleId);
    if (rule) this.showAddRuleForm(rule);
  }

  async deleteRule(id) {
    if (!confirm(i18n.t('lighting.confirmDeleteRule') || 'Supprimer cette règle ?')) return;
    try {
      await this.apiClient.send('lighting_rule_delete', { id });
      await this.loadRulesForDevice(this.selectedDeviceId);
    } catch (error) { alert('Erreur: ' + error.message); }
  }

  async toggleRule(id, enabled) {
    try {
      await this.apiClient.send('lighting_rule_update', { id, enabled });
      await this.loadRulesForDevice(this.selectedDeviceId);
    } catch (error) { alert('Erreur: ' + error.message); }
  }

  // ==================== ACTIONS ====================

  async testDevice() {
    if (!this.selectedDeviceId) return;
    try { await this.apiClient.send('lighting_device_test', { id: this.selectedDeviceId }); }
    catch (error) { alert('Erreur: ' + error.message); }
  }

  async testRule(ruleId) {
    try { await this.apiClient.send('lighting_rule_test', { id: ruleId }); }
    catch (error) { alert('Erreur: ' + error.message); }
  }

  async allOff() {
    try { await this.apiClient.send('lighting_all_off'); }
    catch (error) { alert('Erreur: ' + error.message); }
  }

  // ==================== HELPERS ====================

  _getTypeIcon(type) {
    return { gpio: '🔌', serial: '💠', artnet: '🌐', mqtt: '📡', midi: '🎵' }[type] || '💡';
  }

  _getTriggerLabel(trigger) {
    return { noteon: 'Note On', noteoff: 'Note Off', cc: 'CC', any: 'Tous' }[trigger] || trigger || 'Note On';
  }

  _getActionLabel(type) {
    return {
      static: i18n.t('lighting.colorStatic') || 'Couleur fixe',
      velocity_mapped: i18n.t('lighting.colorVelocity') || 'Gradient',
      pulse: 'Pulse', fade: 'Fade'
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
}
