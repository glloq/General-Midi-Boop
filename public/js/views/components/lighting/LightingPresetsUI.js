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
      } catch (error) { this.showToast('Erreur import: ' + error.message, 'error'); }
    };
    input.click();
  }

  // ==================== LED PREVIEW ====================

    LightingPresetsUIMixin._renderLedPreview = function(device) {
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

  // ==================== MIDI LEARN ====================

    LightingPresetsUIMixin._startMidiLearn = async function() {
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

    LightingPresetsUIMixin._renderQuickColors = function(targetInputId) {
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

    LightingPresetsUIMixin.showColorWheel = function(targetInputId) {
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

    if (typeof window !== 'undefined') window.LightingPresetsUIMixin = LightingPresetsUIMixin;
})();
