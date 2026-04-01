// Auto-extracted from LightingControlPage.js
(function() {
    'use strict';
    const LightingPresetsUIMixin = {};


  // ==================== PRESETS UI ====================

    LightingPresetsUIMixin.showPresetsPanel = function() {
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

    LightingPresetsUIMixin.importRules = async function() {
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
      } catch (error) { this.showToast((i18n.t('lighting.importError') || 'Erreur import: ') + error.message, 'error'); }
    };
    input.click();
  }

  // LED Preview, MIDI Learn, Quick Colors, and Color Wheel
  // are provided by LightingHelpersMixin (removed duplicates from here)

    if (typeof window !== 'undefined') window.LightingPresetsUIMixin = LightingPresetsUIMixin;
})();
