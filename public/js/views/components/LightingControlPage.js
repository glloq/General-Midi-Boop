/**
 * LightingControlPage
 *
 * Page de gestion du systeme de controle lumiere :
 * - Liste des dispositifs lumineux (LED GPIO, bandeaux serial, etc.)
 * - Regles d'activation basees sur les evenements MIDI
 * - Criteres : velocite, CC, note, canal MIDI
 * - Couleurs RGB libres avec color picker
 * - Presets de configuration
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
    this.selectedDeviceId = null;
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

    const div = document.createElement('div');
    div.innerHTML = `
      <div class="lighting-modal-overlay" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 10000; display: flex; align-items: center; justify-content: center;">
        <div class="lighting-modal-container" style="background: white; border-radius: 12px; width: 95%; max-width: 1400px; height: 90vh; display: flex; flex-direction: column; box-shadow: 0 20px 60px rgba(0,0,0,0.3); overflow: hidden;">

          <!-- Header -->
          <div style="padding: 16px 24px; background: linear-gradient(135deg, #eab308 0%, #f59e0b 50%, #d97706 100%); color: white; flex-shrink: 0;">
            <div style="display: flex; align-items: center; justify-content: space-between;">
              <h2 style="margin: 0; font-size: 22px;">💡 ${i18n.t('lighting.title') || 'Contrôle Lumière'}</h2>
              <div style="display: flex; gap: 8px; align-items: center;">
                <button onclick="lightingControlPageInstance.allOff()" style="padding: 6px 14px; border: 2px solid rgba(255,255,255,0.4); border-radius: 8px; background: rgba(255,255,255,0.15); color: white; cursor: pointer; font-size: 13px;" title="${i18n.t('lighting.allOff') || 'Tout éteindre'}">
                  ⏹ ${i18n.t('lighting.allOff') || 'Tout éteindre'}
                </button>
                <button onclick="lightingControlPageInstance.close()" style="background: rgba(255,255,255,0.2); border: none; color: white; font-size: 24px; cursor: pointer; width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center;">×</button>
              </div>
            </div>
          </div>

          <!-- Body: two-panel layout -->
          <div style="display: flex; flex: 1; overflow: hidden;">

            <!-- Left panel: Device list -->
            <div id="lightingDevicePanel" style="width: 320px; min-width: 280px; border-right: 2px solid #e5e7eb; display: flex; flex-direction: column; background: #f9fafb;">
              <div style="padding: 12px 16px; border-bottom: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: center;">
                <span style="font-weight: 600; font-size: 14px; color: #333;">📋 ${i18n.t('lighting.devices') || 'Dispositifs'}</span>
                <button onclick="lightingControlPageInstance.showAddDeviceForm()" style="padding: 4px 12px; border: 1px solid #eab308; border-radius: 6px; background: white; color: #b45309; cursor: pointer; font-size: 13px;">+ ${i18n.t('lighting.addDevice') || 'Ajouter'}</button>
              </div>
              <div id="lightingDeviceList" style="flex: 1; overflow-y: auto; padding: 8px;">
                <div style="padding: 24px; text-align: center; color: #999;">Chargement...</div>
              </div>
            </div>

            <!-- Right panel: Rules for selected device -->
            <div id="lightingRulesPanel" style="flex: 1; display: flex; flex-direction: column; overflow: hidden;">
              <div id="lightingRulesHeader" style="padding: 12px 16px; border-bottom: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: center; background: #fefce8;">
                <span style="font-weight: 600; font-size: 14px; color: #333;" id="lightingRulesTitle">📐 ${i18n.t('lighting.selectDevice') || 'Sélectionnez un dispositif'}</span>
                <div id="lightingRulesActions" style="display: none; gap: 8px;">
                  <button onclick="lightingControlPageInstance.testDevice()" style="padding: 4px 10px; border: 1px solid #3b82f6; border-radius: 6px; background: white; color: #2563eb; cursor: pointer; font-size: 12px;">🔦 ${i18n.t('lighting.testDevice') || 'Tester'}</button>
                  <button onclick="lightingControlPageInstance.showAddRuleForm()" style="padding: 4px 10px; border: 1px solid #10b981; border-radius: 6px; background: white; color: #059669; cursor: pointer; font-size: 12px;">+ ${i18n.t('lighting.addRule') || 'Ajouter règle'}</button>
                </div>
              </div>
              <div id="lightingRulesList" style="flex: 1; overflow-y: auto; padding: 12px;">
                <div style="padding: 40px; text-align: center; color: #999; font-size: 14px;">
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

    // ESC to close
    this._escHandler = (e) => { if (e.key === 'Escape') this.close(); };
    document.addEventListener('keydown', this._escHandler);

    // Click overlay to close
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) this.close();
    });
  }

  // ==================== DATA LOADING ====================

  async loadData() {
    try {
      const [devicesRes, instrumentsRes] = await Promise.all([
        this.apiClient.send('lighting_device_list'),
        this.apiClient.send('instrument_list_registered')
      ]);

      this.devices = devicesRes.devices || [];
      this.instruments = instrumentsRes.instruments || [];
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

    if (this.devices.length === 0) {
      container.innerHTML = `
        <div style="padding: 24px; text-align: center; color: #999;">
          <div style="font-size: 32px; margin-bottom: 8px;">💡</div>
          <p style="margin: 0; font-size: 13px;">${i18n.t('lighting.noDevices') || 'Aucun dispositif configuré'}</p>
          <p style="margin: 4px 0 0 0; font-size: 12px; color: #bbb;">${i18n.t('lighting.addDeviceHint') || 'Cliquez sur Ajouter pour créer un dispositif'}</p>
        </div>`;
      return;
    }

    container.innerHTML = this.devices.map(device => {
      const isSelected = device.id === this.selectedDeviceId;
      const typeIcon = this._getTypeIcon(device.type);
      const statusDot = device.connected ? '🟢' : '⚪';

      return `
        <div onclick="lightingControlPageInstance.selectDevice(${device.id})"
             style="padding: 10px 12px; margin-bottom: 4px; border-radius: 8px; cursor: pointer; border: 2px solid ${isSelected ? '#eab308' : 'transparent'}; background: ${isSelected ? '#fefce8' : 'white'}; transition: all 0.15s;">
          <div style="display: flex; align-items: center; justify-content: space-between;">
            <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
              <span style="font-size: 18px;">${typeIcon}</span>
              <div style="min-width: 0;">
                <div style="font-size: 13px; font-weight: 600; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${this._escapeHtml(device.name)}</div>
                <div style="font-size: 11px; color: #999;">${device.type.toUpperCase()} · ${device.led_count} LED${device.led_count > 1 ? 's' : ''}</div>
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: 4px;">
              <span style="font-size: 10px;">${statusDot}</span>
              <button onclick="event.stopPropagation(); lightingControlPageInstance.deleteDevice(${device.id})" style="background: none; border: none; cursor: pointer; font-size: 14px; color: #ccc; padding: 2px;" title="Supprimer">🗑</button>
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
    if (!container) return;

    const device = this.devices.find(d => d.id === this.selectedDeviceId);
    if (!device) return;

    title.textContent = `📐 ${i18n.t('lighting.rulesFor') || 'Règles pour'} "${device.name}"`;
    actions.style.display = 'flex';

    if (this.rules.length === 0) {
      container.innerHTML = `
        <div style="padding: 40px; text-align: center; color: #999;">
          <div style="font-size: 32px; margin-bottom: 8px;">📐</div>
          <p style="margin: 0; font-size: 13px;">${i18n.t('lighting.noRules') || 'Aucune règle configurée'}</p>
          <p style="margin: 4px 0 0; font-size: 12px; color: #bbb;">${i18n.t('lighting.addRuleHint') || 'Ajoutez une règle pour réagir aux événements MIDI'}</p>
        </div>`;
      return;
    }

    container.innerHTML = this.rules.map(rule => this._renderRuleCard(rule)).join('');
  }

  _renderRuleCard(rule) {
    const cond = rule.condition_config || {};
    const action = rule.action_config || {};
    const instrument = this._getInstrumentName(rule.instrument_id);
    const triggerLabel = this._getTriggerLabel(cond.trigger);
    const colorPreview = action.color || '#FFFFFF';

    return `
      <div style="border: 1px solid #e5e7eb; border-radius: 10px; margin-bottom: 10px; overflow: hidden; background: white; ${!rule.enabled ? 'opacity: 0.5;' : ''}">
        <!-- Rule header -->
        <div style="padding: 10px 14px; background: #f9fafb; border-bottom: 1px solid #e5e7eb; display: flex; align-items: center; justify-content: space-between;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <div style="width: 20px; height: 20px; border-radius: 50%; background: ${this._escapeHtml(colorPreview)}; border: 2px solid #ddd;"></div>
            <span style="font-size: 13px; font-weight: 600; color: #333;">${this._escapeHtml(rule.name || triggerLabel)}</span>
            <span style="font-size: 11px; color: #999; background: #f3f4f6; padding: 2px 6px; border-radius: 4px;">${this._escapeHtml(instrument)}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 4px;">
            <button onclick="lightingControlPageInstance.testRule(${rule.id})" style="background: none; border: 1px solid #3b82f6; border-radius: 4px; color: #3b82f6; cursor: pointer; font-size: 11px; padding: 2px 8px;">Test</button>
            <button onclick="lightingControlPageInstance.toggleRule(${rule.id}, ${!rule.enabled})" style="background: none; border: none; cursor: pointer; font-size: 14px;">${rule.enabled ? '✅' : '⬜'}</button>
            <button onclick="lightingControlPageInstance.editRule(${rule.id})" style="background: none; border: none; cursor: pointer; font-size: 14px;">✏️</button>
            <button onclick="lightingControlPageInstance.deleteRule(${rule.id})" style="background: none; border: none; cursor: pointer; font-size: 14px;">🗑</button>
          </div>
        </div>

        <!-- Rule details -->
        <div style="padding: 10px 14px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 12px; color: #666;">
          <div><b>${i18n.t('lighting.triggerType') || 'Déclencheur'}:</b> ${triggerLabel}</div>
          <div><b>${i18n.t('lighting.channel') || 'Canal'}:</b> ${cond.channels?.length ? cond.channels.map(c => c + 1).join(', ') : 'Tous'}</div>
          <div><b>${i18n.t('lighting.velocityRange') || 'Vélocité'}:</b> ${cond.velocity_min || 0}-${cond.velocity_max || 127}</div>
          <div><b>${i18n.t('lighting.noteRange') || 'Notes'}:</b> ${this._noteName(cond.note_min || 0)}-${this._noteName(cond.note_max || 127)}</div>
          ${cond.cc_number?.length ? `<div><b>CC:</b> #${cond.cc_number.join(', #')} (${cond.cc_value_min || 0}-${cond.cc_value_max || 127})</div>` : ''}
          <div><b>${i18n.t('lighting.actionType') || 'Action'}:</b> ${this._getActionLabel(action.type)}</div>
          ${action.brightness_from_velocity ? `<div><b>${i18n.t('lighting.brightnessFromVelocity') || 'Luminosité vélocité'}:</b> ✓</div>` : ''}
        </div>
      </div>`;
  }

  // ==================== ADD/EDIT DEVICE ====================

  showAddDeviceForm() {
    const formHTML = `
      <div id="lightingDeviceForm" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 10001; display: flex; align-items: center; justify-content: center;">
        <div style="background: white; border-radius: 12px; padding: 24px; width: 440px; max-width: 90vw; box-shadow: 0 20px 60px rgba(0,0,0,0.3);">
          <h3 style="margin: 0 0 20px; font-size: 18px;">💡 ${i18n.t('lighting.addDevice') || 'Ajouter un dispositif'}</h3>

          <div style="margin-bottom: 14px;">
            <label style="font-size: 13px; font-weight: 600; color: #333; display: block; margin-bottom: 4px;">${i18n.t('lighting.deviceName') || 'Nom'}</label>
            <input id="ldFormName" type="text" placeholder="LED RGB Salon" style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; box-sizing: border-box;">
          </div>

          <div style="margin-bottom: 14px;">
            <label style="font-size: 13px; font-weight: 600; color: #333; display: block; margin-bottom: 4px;">${i18n.t('lighting.deviceType') || 'Type'}</label>
            <select id="ldFormType" onchange="lightingControlPageInstance._updateDeviceFormFields()" style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px;">
              <option value="gpio">GPIO (Raspberry Pi)</option>
              <option value="serial">Serial (WS2812/NeoPixel)</option>
            </select>
          </div>

          <div style="margin-bottom: 14px;">
            <label style="font-size: 13px; font-weight: 600; color: #333; display: block; margin-bottom: 4px;">${i18n.t('lighting.ledCount') || 'Nombre de LEDs'}</label>
            <input id="ldFormLedCount" type="number" min="1" max="1000" value="1" style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; box-sizing: border-box;">
          </div>

          <!-- GPIO-specific fields -->
          <div id="ldFormGpioFields">
            <label style="font-size: 13px; font-weight: 600; color: #333; display: block; margin-bottom: 4px;">Pins GPIO (R, G, B)</label>
            <div style="display: flex; gap: 8px; margin-bottom: 14px;">
              <input id="ldFormPinR" type="number" min="0" max="27" value="17" placeholder="R" style="flex: 1; padding: 8px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px;">
              <input id="ldFormPinG" type="number" min="0" max="27" value="27" placeholder="G" style="flex: 1; padding: 8px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px;">
              <input id="ldFormPinB" type="number" min="0" max="27" value="22" placeholder="B" style="flex: 1; padding: 8px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px;">
            </div>
          </div>

          <!-- Serial-specific fields -->
          <div id="ldFormSerialFields" style="display: none;">
            <label style="font-size: 13px; font-weight: 600; color: #333; display: block; margin-bottom: 4px;">Port série</label>
            <input id="ldFormSerialPort" type="text" value="/dev/ttyUSB0" style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; margin-bottom: 14px; box-sizing: border-box;">
          </div>

          <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px;">
            <button onclick="document.getElementById('lightingDeviceForm').remove()" style="padding: 8px 16px; border: 1px solid #d1d5db; border-radius: 8px; background: white; color: #333; cursor: pointer;">Annuler</button>
            <button onclick="lightingControlPageInstance.submitAddDevice()" style="padding: 8px 16px; border: none; border-radius: 8px; background: #eab308; color: white; cursor: pointer; font-weight: 600;">Ajouter</button>
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
  }

  async submitAddDevice() {
    const name = document.getElementById('ldFormName').value.trim();
    if (!name) return alert('Le nom est requis');

    const type = document.getElementById('ldFormType').value;
    const ledCount = parseInt(document.getElementById('ldFormLedCount').value) || 1;

    let connectionConfig = {};
    if (type === 'gpio') {
      connectionConfig = {
        pins: {
          r: parseInt(document.getElementById('ldFormPinR').value) || 17,
          g: parseInt(document.getElementById('ldFormPinG').value) || 27,
          b: parseInt(document.getElementById('ldFormPinB').value) || 22
        }
      };
    } else if (type === 'serial') {
      connectionConfig = {
        port: document.getElementById('ldFormSerialPort').value || '/dev/ttyUSB0',
        baud: 115200
      };
    }

    try {
      await this.apiClient.send('lighting_device_add', {
        name, type, led_count: ledCount, connection_config: connectionConfig
      });
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
      if (this.selectedDeviceId === id) {
        this.selectedDeviceId = null;
        this.rules = [];
      }
      await this.loadData();
    } catch (error) {
      alert('Erreur: ' + error.message);
    }
  }

  selectDevice(id) {
    this.selectedDeviceId = id;
    this.renderDeviceList();
    this.loadRulesForDevice(id);
  }

  // ==================== ADD/EDIT RULE ====================

  showAddRuleForm(existingRule = null) {
    const isEdit = !!existingRule;
    const cond = existingRule?.condition_config || {};
    const action = existingRule?.action_config || {};

    const instrumentOptions = this.instruments.map(inst => {
      const name = inst.custom_name || inst.name || inst.device_id;
      const selected = existingRule?.instrument_id === inst.id ? 'selected' : '';
      return `<option value="${this._escapeHtml(inst.id)}" ${selected}>${this._escapeHtml(name)} (ch${(inst.channel || 0) + 1})</option>`;
    }).join('');

    const formHTML = `
      <div id="lightingRuleForm" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 10001; display: flex; align-items: center; justify-content: center;">
        <div style="background: white; border-radius: 12px; padding: 24px; width: 580px; max-width: 95vw; max-height: 85vh; overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.3);">
          <h3 style="margin: 0 0 16px; font-size: 18px;">📐 ${isEdit ? (i18n.t('lighting.editRule') || 'Modifier la règle') : (i18n.t('lighting.addRule') || 'Ajouter une règle')}</h3>

          <!-- Name -->
          <div style="margin-bottom: 12px;">
            <label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 4px;">Nom</label>
            <input id="lrFormName" type="text" value="${this._escapeHtml(existingRule?.name || '')}" placeholder="Note On Rouge" style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; box-sizing: border-box;">
          </div>

          <!-- Instrument -->
          <div style="margin-bottom: 12px;">
            <label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 4px;">${i18n.t('lighting.instrument') || 'Instrument'}</label>
            <select id="lrFormInstrument" style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px;">
              <option value="">${i18n.t('lighting.anyInstrument') || 'Tout instrument'}</option>
              ${instrumentOptions}
            </select>
          </div>

          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 16px 0;">
          <h4 style="margin: 0 0 12px; font-size: 14px; color: #666;">🎯 ${i18n.t('lighting.condition') || 'Condition de déclenchement'}</h4>

          <!-- Trigger type -->
          <div style="margin-bottom: 12px;">
            <label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 4px;">${i18n.t('lighting.triggerType') || 'Type'}</label>
            <select id="lrFormTrigger" style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px;">
              <option value="noteon" ${cond.trigger === 'noteon' ? 'selected' : ''}>Note On</option>
              <option value="noteoff" ${cond.trigger === 'noteoff' ? 'selected' : ''}>Note Off</option>
              <option value="cc" ${cond.trigger === 'cc' ? 'selected' : ''}>Control Change (CC)</option>
              <option value="any" ${cond.trigger === 'any' ? 'selected' : ''}>Tous</option>
            </select>
          </div>

          <!-- Channel -->
          <div style="margin-bottom: 12px;">
            <label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 4px;">${i18n.t('lighting.channel') || 'Canal MIDI'}</label>
            <input id="lrFormChannels" type="text" value="${(cond.channels || []).map(c => c + 1).join(', ')}" placeholder="Tous (ou 1, 2, 10)" style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; box-sizing: border-box;">
            <span style="font-size: 11px; color: #999;">Vide = tous les canaux. Séparez par virgule (1-16)</span>
          </div>

          <!-- Velocity range -->
          <div style="display: flex; gap: 12px; margin-bottom: 12px;">
            <div style="flex: 1;">
              <label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 4px;">${i18n.t('lighting.velocityMin') || 'Vélocité min'}</label>
              <input id="lrFormVelMin" type="number" min="0" max="127" value="${cond.velocity_min || 0}" style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; box-sizing: border-box;">
            </div>
            <div style="flex: 1;">
              <label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 4px;">${i18n.t('lighting.velocityMax') || 'Vélocité max'}</label>
              <input id="lrFormVelMax" type="number" min="0" max="127" value="${cond.velocity_max !== undefined ? cond.velocity_max : 127}" style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; box-sizing: border-box;">
            </div>
          </div>

          <!-- Note range -->
          <div style="display: flex; gap: 12px; margin-bottom: 12px;">
            <div style="flex: 1;">
              <label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 4px;">${i18n.t('lighting.noteMin') || 'Note min'}</label>
              <input id="lrFormNoteMin" type="number" min="0" max="127" value="${cond.note_min || 0}" style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; box-sizing: border-box;">
            </div>
            <div style="flex: 1;">
              <label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 4px;">${i18n.t('lighting.noteMax') || 'Note max'}</label>
              <input id="lrFormNoteMax" type="number" min="0" max="127" value="${cond.note_max !== undefined ? cond.note_max : 127}" style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; box-sizing: border-box;">
            </div>
          </div>

          <!-- CC number & value -->
          <div style="display: flex; gap: 12px; margin-bottom: 12px;">
            <div style="flex: 1;">
              <label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 4px;">${i18n.t('lighting.ccNumber') || 'Numéros CC'}</label>
              <input id="lrFormCcNum" type="text" value="${(cond.cc_number || []).join(', ')}" placeholder="7, 11, 64" style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; box-sizing: border-box;">
            </div>
            <div style="flex: 0.5;">
              <label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 4px;">CC min</label>
              <input id="lrFormCcMin" type="number" min="0" max="127" value="${cond.cc_value_min || 0}" style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; box-sizing: border-box;">
            </div>
            <div style="flex: 0.5;">
              <label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 4px;">CC max</label>
              <input id="lrFormCcMax" type="number" min="0" max="127" value="${cond.cc_value_max !== undefined ? cond.cc_value_max : 127}" style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; box-sizing: border-box;">
            </div>
          </div>

          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 16px 0;">
          <h4 style="margin: 0 0 12px; font-size: 14px; color: #666;">🎨 ${i18n.t('lighting.action') || 'Action lumineuse'}</h4>

          <!-- Action type -->
          <div style="margin-bottom: 12px;">
            <label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 4px;">${i18n.t('lighting.actionType') || 'Type'}</label>
            <select id="lrFormActionType" onchange="lightingControlPageInstance._updateActionFields()" style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px;">
              <option value="static" ${action.type === 'static' || !action.type ? 'selected' : ''}>${i18n.t('lighting.colorStatic') || 'Couleur fixe'}</option>
              <option value="velocity_mapped" ${action.type === 'velocity_mapped' ? 'selected' : ''}>${i18n.t('lighting.colorVelocity') || 'Gradiant vélocité'}</option>
              <option value="pulse" ${action.type === 'pulse' ? 'selected' : ''}>Pulse</option>
              <option value="fade" ${action.type === 'fade' ? 'selected' : ''}>Fade</option>
            </select>
          </div>

          <!-- Color picker -->
          <div id="lrFormStaticColor" style="margin-bottom: 12px;">
            <label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 4px;">${i18n.t('lighting.color') || 'Couleur'}</label>
            <div style="display: flex; align-items: center; gap: 12px;">
              <input id="lrFormColor" type="color" value="${action.color || '#FF0000'}" style="width: 60px; height: 40px; border: 1px solid #d1d5db; border-radius: 8px; cursor: pointer; padding: 2px;">
              <span id="lrFormColorHex" style="font-size: 13px; color: #666; font-family: monospace;">${action.color || '#FF0000'}</span>
            </div>
          </div>

          <!-- Velocity gradient (hidden by default) -->
          <div id="lrFormGradientSection" style="display: ${action.type === 'velocity_mapped' ? 'block' : 'none'}; margin-bottom: 12px;">
            <label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 4px;">${i18n.t('lighting.colorGradient') || 'Gradient de couleur (vélocité)'}</label>
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
              <span style="font-size: 11px; color: #999; width: 50px;">Doux</span>
              <input id="lrFormColorLow" type="color" value="${this._getColorMapValue(action.color_map, 0) || '#0000FF'}" style="width: 40px; height: 30px; border: 1px solid #d1d5db; border-radius: 6px; cursor: pointer;">
              <span style="font-size: 11px; color: #999; width: 50px;">Moyen</span>
              <input id="lrFormColorMid" type="color" value="${this._getColorMapValue(action.color_map, 64) || '#FFFF00'}" style="width: 40px; height: 30px; border: 1px solid #d1d5db; border-radius: 6px; cursor: pointer;">
              <span style="font-size: 11px; color: #999; width: 50px;">Fort</span>
              <input id="lrFormColorHigh" type="color" value="${this._getColorMapValue(action.color_map, 127) || '#FF0000'}" style="width: 40px; height: 30px; border: 1px solid #d1d5db; border-radius: 6px; cursor: pointer;">
            </div>
          </div>

          <!-- Brightness -->
          <div style="margin-bottom: 12px;">
            <div style="display: flex; align-items: center; gap: 12px;">
              <label style="font-size: 13px; font-weight: 600;">${i18n.t('lighting.brightness') || 'Luminosité'}</label>
              <input id="lrFormBrightness" type="range" min="0" max="255" value="${action.brightness !== undefined ? action.brightness : 255}" style="flex: 1;">
              <span id="lrFormBrightnessVal" style="font-size: 12px; color: #666; min-width: 35px; text-align: right;">${action.brightness !== undefined ? action.brightness : 255}</span>
            </div>
          </div>

          <!-- Brightness from velocity -->
          <div style="margin-bottom: 12px;">
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input id="lrFormBrightVel" type="checkbox" ${action.brightness_from_velocity ? 'checked' : ''}>
              <span style="font-size: 13px;">${i18n.t('lighting.brightnessFromVelocity') || 'Luminosité proportionnelle à la vélocité'}</span>
            </label>
          </div>

          <!-- LED range -->
          <div style="display: flex; gap: 12px; margin-bottom: 12px;">
            <div style="flex: 1;">
              <label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 4px;">LED début</label>
              <input id="lrFormLedStart" type="number" min="0" value="${action.led_start || 0}" style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; box-sizing: border-box;">
            </div>
            <div style="flex: 1;">
              <label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 4px;">LED fin (-1 = toutes)</label>
              <input id="lrFormLedEnd" type="number" min="-1" value="${action.led_end !== undefined ? action.led_end : -1}" style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; box-sizing: border-box;">
            </div>
          </div>

          <!-- Fade time -->
          <div style="margin-bottom: 12px;">
            <label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 4px;">${i18n.t('lighting.fadeTime') || 'Durée fondu (ms)'}</label>
            <input id="lrFormFadeTime" type="number" min="0" max="5000" value="${action.fade_time_ms || 200}" style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; box-sizing: border-box;">
          </div>

          <!-- Off action -->
          <div style="margin-bottom: 12px;">
            <label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 4px;">${i18n.t('lighting.offAction') || 'Action au relâchement'}</label>
            <select id="lrFormOffAction" style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px;">
              <option value="instant" ${action.off_action === 'instant' || !action.off_action ? 'selected' : ''}>Éteindre immédiatement</option>
              <option value="fade" ${action.off_action === 'fade' ? 'selected' : ''}>Fondu</option>
              <option value="hold" ${action.off_action === 'hold' ? 'selected' : ''}>Maintenir</option>
            </select>
          </div>

          <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px;">
            <button onclick="document.getElementById('lightingRuleForm').remove()" style="padding: 8px 16px; border: 1px solid #d1d5db; border-radius: 8px; background: white; color: #333; cursor: pointer;">Annuler</button>
            <button onclick="lightingControlPageInstance.submitRule(${existingRule ? existingRule.id : 'null'})" style="padding: 8px 16px; border: none; border-radius: 8px; background: #10b981; color: white; cursor: pointer; font-weight: 600;">${isEdit ? 'Modifier' : 'Ajouter'}</button>
          </div>
        </div>
      </div>`;

    const div = document.createElement('div');
    div.innerHTML = formHTML;
    document.body.appendChild(div.firstElementChild);

    // Bind color hex display
    const colorInput = document.getElementById('lrFormColor');
    const colorHex = document.getElementById('lrFormColorHex');
    if (colorInput && colorHex) {
      colorInput.addEventListener('input', () => { colorHex.textContent = colorInput.value; });
    }

    // Bind brightness display
    const brightnessInput = document.getElementById('lrFormBrightness');
    const brightnessVal = document.getElementById('lrFormBrightnessVal');
    if (brightnessInput && brightnessVal) {
      brightnessInput.addEventListener('input', () => { brightnessVal.textContent = brightnessInput.value; });
    }
  }

  _updateActionFields() {
    const type = document.getElementById('lrFormActionType').value;
    const staticSection = document.getElementById('lrFormStaticColor');
    const gradientSection = document.getElementById('lrFormGradientSection');

    if (type === 'velocity_mapped') {
      staticSection.style.display = 'none';
      gradientSection.style.display = 'block';
    } else {
      staticSection.style.display = 'block';
      gradientSection.style.display = 'none';
    }
  }

  async submitRule(existingId) {
    const name = document.getElementById('lrFormName').value.trim();
    const instrumentId = document.getElementById('lrFormInstrument').value || null;
    const trigger = document.getElementById('lrFormTrigger').value;

    // Parse channels
    const channelsStr = document.getElementById('lrFormChannels').value.trim();
    const channels = channelsStr ? channelsStr.split(',').map(s => parseInt(s.trim()) - 1).filter(n => n >= 0 && n <= 15) : null;

    // Parse CC numbers
    const ccStr = document.getElementById('lrFormCcNum').value.trim();
    const ccNumbers = ccStr ? ccStr.split(',').map(s => parseInt(s.trim())).filter(n => n >= 0 && n <= 127) : null;

    const conditionConfig = {
      trigger,
      channels: channels?.length ? channels : null,
      velocity_min: parseInt(document.getElementById('lrFormVelMin').value) || 0,
      velocity_max: parseInt(document.getElementById('lrFormVelMax').value) || 127,
      note_min: parseInt(document.getElementById('lrFormNoteMin').value) || 0,
      note_max: parseInt(document.getElementById('lrFormNoteMax').value) || 127,
      cc_number: ccNumbers?.length ? ccNumbers : null,
      cc_value_min: parseInt(document.getElementById('lrFormCcMin').value) || 0,
      cc_value_max: parseInt(document.getElementById('lrFormCcMax').value) || 127
    };

    const actionType = document.getElementById('lrFormActionType').value;
    const actionConfig = {
      type: actionType,
      color: document.getElementById('lrFormColor').value,
      brightness: parseInt(document.getElementById('lrFormBrightness').value),
      brightness_from_velocity: document.getElementById('lrFormBrightVel').checked,
      led_start: parseInt(document.getElementById('lrFormLedStart').value) || 0,
      led_end: parseInt(document.getElementById('lrFormLedEnd').value),
      fade_time_ms: parseInt(document.getElementById('lrFormFadeTime').value) || 200,
      off_action: document.getElementById('lrFormOffAction').value
    };

    if (actionType === 'velocity_mapped') {
      actionConfig.color_map = {
        '0': document.getElementById('lrFormColorLow').value,
        '64': document.getElementById('lrFormColorMid').value,
        '127': document.getElementById('lrFormColorHigh').value
      };
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
    } catch (error) {
      alert('Erreur: ' + error.message);
    }
  }

  async toggleRule(id, enabled) {
    try {
      await this.apiClient.send('lighting_rule_update', { id, enabled });
      await this.loadRulesForDevice(this.selectedDeviceId);
    } catch (error) {
      alert('Erreur: ' + error.message);
    }
  }

  // ==================== ACTIONS ====================

  async testDevice() {
    if (!this.selectedDeviceId) return;
    try {
      await this.apiClient.send('lighting_device_test', { id: this.selectedDeviceId });
    } catch (error) {
      alert('Erreur: ' + error.message);
    }
  }

  async testRule(ruleId) {
    try {
      await this.apiClient.send('lighting_rule_test', { id: ruleId });
    } catch (error) {
      alert('Erreur: ' + error.message);
    }
  }

  async allOff() {
    try {
      await this.apiClient.send('lighting_all_off');
    } catch (error) {
      alert('Erreur: ' + error.message);
    }
  }

  // ==================== HELPERS ====================

  _getTypeIcon(type) {
    const icons = { gpio: '🔌', serial: '💠', artnet: '🌐', mqtt: '📡', midi: '🎵' };
    return icons[type] || '💡';
  }

  _getTriggerLabel(trigger) {
    const labels = { noteon: 'Note On', noteoff: 'Note Off', cc: 'CC', any: 'Tous' };
    return labels[trigger] || trigger || 'Note On';
  }

  _getActionLabel(type) {
    const labels = {
      static: i18n.t('lighting.colorStatic') || 'Couleur fixe',
      velocity_mapped: i18n.t('lighting.colorVelocity') || 'Gradient vélocité',
      pulse: 'Pulse',
      fade: 'Fade'
    };
    return labels[type] || type || 'Couleur fixe';
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
    const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const octave = Math.floor(midi / 12) - 1;
    return notes[midi % 12] + octave;
  }
}
