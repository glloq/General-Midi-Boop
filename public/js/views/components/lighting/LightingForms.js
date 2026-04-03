// Auto-extracted from LightingControlPage.js
(function() {
    'use strict';
    const LightingFormsMixin = {};


  // ==================== ADD/EDIT DEVICE ====================

    LightingFormsMixin.showAddDeviceForm = function() {
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

    LightingFormsMixin._updateDeviceFormFields = function() {
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

    LightingFormsMixin._addStripEntry = function() {
    const t = this._t();
    const container = document.getElementById('ldFormStripsContainer');
    if (!container) return;
    const idx = container.children.length;
    if (idx >= 3) return; // Max 3 hardware channels

    const defaultChannel = idx;

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

    LightingFormsMixin.submitAddDevice = async function() {
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

    LightingFormsMixin.showEditDeviceForm = async function() {
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
          btn.textContent = i18n.t('lighting.save') || 'Enregistrer';
          btn.style.background = '#8b5cf6';
          btn.onclick = () => lightingControlPageInstance.submitEditDevice();
        }
      });

      // Disable type selector (cannot change type during edit)
      if (typeEl) { typeEl.disabled = true; typeEl.style.opacity = '0.6'; }
    });
  }

    LightingFormsMixin.submitEditDevice = async function() {
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

  // ==================== ADD/EDIT RULE ====================

    LightingFormsMixin.showAddRuleForm = function(existingRule = null) {
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

    LightingFormsMixin.submitRule = async function(existingId) {
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
      this.showToast(i18n.t('lighting.velocityMinMaxError') || 'Vélocité min doit être ≤ vélocité max', 'warning'); return;
    }
    if (conditionConfig.note_min > conditionConfig.note_max) {
      this.showToast(i18n.t('lighting.noteMinMaxError') || 'Note min doit être ≤ note max', 'warning'); return;
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

    if (typeof window !== 'undefined') window.LightingFormsMixin = LightingFormsMixin;
})();
