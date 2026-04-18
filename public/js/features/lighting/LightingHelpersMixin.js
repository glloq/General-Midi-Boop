// ============================================================================
// Fichier: public/js/features/lighting/LightingHelpersMixin.js
// Description: Helpers, color utilities, LED preview, MIDI learn, color wheel,
//   actions (test, blackout, all off, master dimmer)
//   Mixin: methodes ajoutees au prototype de LightingControlPage
// ============================================================================

(function() {
    'use strict';

    const LightingHelpersMixin = {};

    // ==================== HELPERS ====================

    LightingHelpersMixin._getTypeIcon = function(type) {
        return { gpio: '\uD83D\uDD0C', gpio_strip: '\uD83D\uDCA0', serial: '\uD83D\uDD17', artnet: '\uD83C\uDF10', sacn: '\uD83D\uDCE1', mqtt: '\uD83D\uDCF6', http: '\uD83C\uDF0D', osc: '\uD83C\uDFDB\uFE0F', midi: '\uD83C\uDFB5' }[type] || '\uD83D\uDCA1';
    };

    LightingHelpersMixin._getTriggerLabel = function(trigger) {
        return { noteon: 'Note On', noteoff: 'Note Off', cc: 'CC', any: 'Tous' }[trigger] || trigger || 'Note On';
    };

    LightingHelpersMixin._getActionLabel = function(type) {
        return {
            static: i18n.t('lighting.colorStatic') || 'Couleur fixe',
            velocity_mapped: i18n.t('lighting.colorVelocity') || 'Gradient',
            note_color: '\uD83C\uDFB9 Note\u2192Couleur', color_temp: '\uD83C\uDF21\uFE0F Temp. couleur', random_color: '\uD83C\uDFB2 Al\u00E9atoire',
            note_led: '\uD83C\uDFB9 Note\u2192LED', vu_meter: '\uD83D\uDCCA VU-m\u00E8tre',
            pulse: 'Pulse', fade: 'Fade',
            strobe: '\u26A1 Stroboscope', rainbow: '\uD83C\uDF08 Arc-en-ciel', chase: '\uD83C\uDFC3 Chenillard',
            fire: '\uD83D\uDD25 Feu', breathe: '\uD83D\uDCA8 Respiration', sparkle: '\u2728 \u00C9tincelles',
            color_cycle: '\uD83C\uDFA8 Cycle', wave: '\uD83C\uDF0A Vague'
        }[type] || type || 'Couleur fixe';
    };

    LightingHelpersMixin._getInstrumentName = function(instrumentId) {
        if (!instrumentId) return i18n.t('lighting.anyInstrument') || 'Tout instrument';
        const inst = this.instruments.find(i => i.id === instrumentId);
        return inst ? (inst.custom_name || inst.name || instrumentId) : instrumentId;
    };

    LightingHelpersMixin._getColorMapValue = function(colorMap, key) {
        if (!colorMap) return null;
        return colorMap[String(key)] || null;
    };

    LightingHelpersMixin._noteName = function(midi) {
        const n = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        return n[midi % 12] + (Math.floor(midi / 12) - 1);
    };

    LightingHelpersMixin._clamp = function(val, min, max) { return Math.max(min, Math.min(max, parseInt(val) || min)); };

    LightingHelpersMixin._safeColor = function(c) {
        // Sanitize a color value for safe CSS injection (only allow hex colors)
        return /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '#888';
    };

    LightingHelpersMixin._isEffectType = function(type) {
        return ['strobe', 'rainbow', 'chase', 'fire', 'breathe', 'sparkle', 'color_cycle', 'wave'].includes(type);
    };

    // ==================== COLOR PREVIEW ====================

    LightingHelpersMixin._buildColorPreview = function(action) {
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
    };

    // ==================== LED PREVIEW ====================

    LightingHelpersMixin._renderLedPreview = function(device) {
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
    };

    LightingHelpersMixin._setPreviewLed = function(index, color) {
        const led = document.querySelector(`.led-preview-pixel[data-index="${index}"]`);
        if (led) led.style.background = color;
    };

    LightingHelpersMixin._testPreviewRainbow = function() {
        const pixels = document.querySelectorAll('.led-preview-pixel');
        pixels.forEach((pixel, i) => {
            const hue = (i * 360 / pixels.length) % 360;
            pixel.style.background = `hsl(${hue}, 100%, 50%)`;
        });
        // Auto-clear after 2 seconds
        setTimeout(() => this._clearPreview(), 2000);
    };

    LightingHelpersMixin._clearPreview = function() {
        const pixels = document.querySelectorAll('.led-preview-pixel');
        pixels.forEach(pixel => { pixel.style.background = '#333'; });
    };

    // ==================== MIDI LEARN ====================

    LightingHelpersMixin._startMidiLearn = async function() {
        const btn = document.getElementById('lrMidiLearnBtn');
        if (!btn) return;

        btn.textContent = i18n.t('lighting.midiLearnWaiting') || '🎹 En attente d\'un événement MIDI... (10s)';
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

                btn.textContent = (i18n.t('lighting.midiLearnCaptured') || '✅ Capturé: {type} ch{channel} note={note} vel={velocity} cc={cc}').replace('{type}', l.type).replace('{channel}', (l.channel || 0) + 1).replace('{note}', l.note ?? '-').replace('{velocity}', l.velocity ?? '-').replace('{cc}', l.controller ?? '-');
                btn.style.borderColor = '#10b981';
                btn.style.color = '#10b981';
            } else {
                btn.textContent = i18n.t('lighting.midiLearnNoSignal') || '⏰ Pas de signal MIDI reçu. Réessayez.';
                btn.style.borderColor = '#f59e0b';
                btn.style.color = '#d97706';
            }
        } catch (error) {
            btn.textContent = (i18n.t('lighting.midiLearnError') || '❌ Erreur: {error}').replace('{error}', error.message);
            btn.style.borderColor = '#ef4444';
            btn.style.color = '#ef4444';
        }

        setTimeout(() => {
            if (btn) {
                btn.textContent = i18n.t('lighting.midiLearnDefault') || '🎹 MIDI Learn — Jouez une note pour auto-configurer la condition';
                btn.style.borderColor = '#f59e0b';
                btn.style.color = '#d97706';
                btn.disabled = false;
            }
        }, 5000);
    };

    // ==================== QUICK COLOR PRESETS ====================

    LightingHelpersMixin._renderQuickColors = function(targetInputId) {
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
    };

    // ==================== COLOR WHEEL ====================

    LightingHelpersMixin.showColorWheel = function(targetInputId) {
        const safeTargetId = targetInputId.replace(/[^a-zA-Z0-9_]/g, '');
        const t = this._t();
        const existing = document.getElementById('lightingColorWheel');
        if (existing) existing.remove();

        const div = document.createElement('div');
        div.id = 'lightingColorWheel';
        div.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:10002;display:flex;align-items:center;justify-content:center;`;
        div.innerHTML = `
            <div style="background:${t.bg};border-radius:12px;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,0.3);text-align:center;">
                <h3 style="margin:0 0 12px;font-size:14px;color:${t.text};">\uD83C\uDFA8 S\u00E9lecteur de couleur</h3>
                <div style="display:flex;align-items:center;gap:12px;justify-content:center;">
                    <canvas id="colorWheelCanvas" width="220" height="220" style="cursor:crosshair;border-radius:50%;"></canvas>
                    <div style="display:flex;flex-direction:column;align-items:center;gap:4px;">
                        <span style="font-size:10px;color:${t.textMuted};">Luminosit\u00E9</span>
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
        let pickRAF = null;
        const throttledPick = (e) => {
            if (pickRAF) return;
            pickRAF = requestAnimationFrame(() => {
                pickColor(e);
                pickRAF = null;
            });
        };
        canvas.addEventListener('mousedown', (e) => { dragging = true; pickColor(e); });
        canvas.addEventListener('mousemove', (e) => { if (dragging) throttledPick(e); });
        canvas.addEventListener('mouseup', () => { dragging = false; });
        canvas.addEventListener('click', pickColor);

        // Touch support
        canvas.addEventListener('touchstart', (e) => { e.preventDefault(); pickColor(e.touches[0]); });
        canvas.addEventListener('touchmove', (e) => { e.preventDefault(); throttledPick(e.touches[0]); });

        document.getElementById('colorWheelApply').addEventListener('click', () => {
            const target = document.getElementById(safeTargetId);
            if (target) {
                target.value = selectedColor;
                target.dispatchEvent(new Event('input'));
            }
            div.remove();
        });
    };

    // ==================== ACTIONS ====================

    LightingHelpersMixin.testDevice = async function() {
        if (!this.selectedDeviceId) return;
        try { await this.apiClient.sendCommand('lighting_device_test', { id: this.selectedDeviceId }); }
        catch (error) { this.showToast(error.message, 'error'); }
    };

    LightingHelpersMixin.testRule = async function(ruleId) {
        try { await this.apiClient.sendCommand('lighting_rule_test', { id: ruleId }); }
        catch (error) { this.showToast(error.message, 'error'); }
    };

    LightingHelpersMixin.allOff = async function() {
        try { await this.apiClient.sendCommand('lighting_all_off'); }
        catch (error) { this.showToast(error.message, 'error'); }
    };

    LightingHelpersMixin.blackout = async function() {
        try { await this.apiClient.sendCommand('lighting_blackout'); }
        catch (error) { this.showToast(error.message, 'error'); }
    };

    LightingHelpersMixin._onMasterDimmerChange = async function(value) {
        const val = parseInt(value);
        const label = document.getElementById('lightingMasterDimmerVal');
        if (label) label.textContent = Math.round(val / 2.55) + '%';
        try { await this.apiClient.sendCommand('lighting_master_dimmer', { value: val }); }
        catch (error) { /* ignore - too many events */ }
    };

    // ==================== EXPORT ====================

    if (typeof window !== 'undefined') {
        window.LightingHelpersMixin = LightingHelpersMixin;
    }
})();
