// Auto-extracted from LightingControlPage.js
(function() {
    'use strict';
    const LightingDeviceUIMixin = {};


  // ==================== DEVICE LIST RENDERING ====================

    LightingDeviceUIMixin.renderDeviceList = function() {
    const container = document.getElementById('lightingDeviceList');
    if (!container) return;

    if (this.devices.length === 0) {
      container.innerHTML = `
        <div class="lighting-empty-state">
          <div class="lighting-empty-state-icon">💡</div>
          <p class="lighting-empty-state-text">${i18n.t('lighting.noDevices') || 'Aucun dispositif configuré'}</p>
          <p class="lighting-empty-state-hint">${i18n.t('lighting.addDeviceHint') || 'Cliquez sur Ajouter'}</p>
        </div>`;
      return;
    }

    container.innerHTML = this.devices.map(device => {
      const sel = device.id === this.selectedDeviceId;
      const icon = this._getTypeIcon(device.type);
      const dot = device.connected ? '🟢' : '⚪';

      return `
        <div class="lighting-device-card ${sel ? 'lighting-device-card--selected' : ''}"
             data-action="selectDevice" data-id="${device.id}">
          <div class="lighting-device-card-row">
            <div class="lighting-device-info">
              <span class="lighting-device-icon">${icon}</span>
              <div style="min-width:0;flex:1;">
                <div class="lighting-device-name">${this._escapeHtml(device.name)}</div>
                <div class="lighting-device-meta">${device.type.toUpperCase()} · ${device.led_count} LED${device.led_count > 1 ? 's' : ''}</div>
              </div>
            </div>
            <div class="lighting-device-actions">
              <span style="font-size:9px;">${dot}</span>
              <button class="lighting-btn--icon" data-action="cloneDevice" data-id="${device.id}" style="font-size:11px;" title="Dupliquer">📋</button>
              <button class="lighting-btn--icon" data-action="deleteDevice" data-id="${device.id}" style="font-size:12px;" title="Supprimer">🗑</button>
            </div>
          </div>
        </div>`;
    }).join('');
  }

  // ==================== RULES LIST RENDERING ====================

    LightingDeviceUIMixin.renderRulesList = function() {
    const container = document.getElementById('lightingRulesList');
    const title = document.getElementById('lightingRulesTitle');
    const actions = document.getElementById('lightingRulesActions');
    const reconnectBtn = document.getElementById('lightingReconnectBtn');
    if (!container) return;

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
        <div class="lighting-empty-state" style="padding:30px;">
          <div class="lighting-empty-state-icon">📐</div>
          <p class="lighting-empty-state-text">${i18n.t('lighting.noRules') || 'Aucune règle configurée'}</p>
          <p class="lighting-empty-state-hint">${i18n.t('lighting.addRuleHint') || 'Ajoutez une règle pour réagir aux événements MIDI'}</p>
        </div>`;
      return;
    }

    container.innerHTML = this.rules.map(rule => this._renderRuleCard(rule)).join('');
  }

    LightingDeviceUIMixin._renderRuleCard = function(rule) {
    const cond = rule.condition_config || {};
    const action = rule.action_config || {};
    const instrument = this._getInstrumentName(rule.instrument_id);
    const triggerLabel = this._getTriggerLabel(cond.trigger);
    const colorPreview = this._buildColorPreview(action);

    return `
      <div class="lighting-rule-card ${!rule.enabled ? 'lighting-rule-card--disabled' : ''}">
        <div class="lighting-rule-card-header">
          <div class="lighting-rule-card-info">
            ${colorPreview}
            <span class="lighting-rule-name">${this._escapeHtml(rule.name || triggerLabel)}</span>
            <span class="lighting-rule-instrument">${this._escapeHtml(instrument)}</span>
          </div>
          <div class="lighting-rule-card-actions">
            <button class="lighting-btn--icon" data-action="moveRulePriority" data-id="${rule.id}" data-delta="1" style="font-size:11px;" title="Priorité +">⬆</button>
            <button class="lighting-btn--icon" data-action="moveRulePriority" data-id="${rule.id}" data-delta="-1" style="font-size:11px;" title="Priorité -">⬇</button>
            <button class="lighting-btn--outline lighting-btn--outline-blue" data-action="testRule" data-id="${rule.id}" style="font-size:10px;padding:2px 6px;">Test</button>
            <button class="lighting-btn--icon" data-action="toggleRule" data-id="${rule.id}" data-enabled="${!rule.enabled}" style="font-size:13px;">${rule.enabled ? '✅' : '⬜'}</button>
            <button class="lighting-btn--icon" data-action="editRule" data-id="${rule.id}" style="font-size:13px;">✏️</button>
            <button class="lighting-btn--icon" data-action="cloneRule" data-id="${rule.id}" style="font-size:11px;" title="Dupliquer">📋</button>
            <button class="lighting-btn--icon" data-action="deleteRule" data-id="${rule.id}" style="font-size:13px;">🗑</button>
          </div>
        </div>
        <div class="lighting-rule-card-body">
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

  // _buildColorPreview is provided by LightingHelpersMixin

  // ==================== DEVICE GROUPS PANEL ====================

    LightingDeviceUIMixin.showGroupsPanel = async function() {
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

  // ==================== DEVICE SCAN ====================

    LightingDeviceUIMixin.scanDevices = async function() {
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

    LightingDeviceUIMixin._addScannedDevice = async function(deviceInfo) {
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

  // ==================== LIVE EFFECTS PANEL ====================

    LightingDeviceUIMixin.showEffectsPanel = async function() {
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

    if (typeof window !== 'undefined') window.LightingDeviceUIMixin = LightingDeviceUIMixin;
})();
