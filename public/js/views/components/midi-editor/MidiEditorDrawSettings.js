// ============================================================================
// Fichier: public/js/views/components/midi-editor/MidiEditorDrawSettings.js
// Description: Draw settings popover
//   Mixin: methodes ajoutees au prototype de MidiEditorModal
// ============================================================================

(function() {
    'use strict';

    const MidiEditorDrawSettingsMixin = {};

    // ========================================================================
    // DRAW SETTINGS POPOVER
    // ========================================================================

    /**
    * Basculer l'affichage du popover de réglages de dessin
    */
    MidiEditorDrawSettingsMixin.toggleDrawSettingsPopover = function() {
        let popover = this.container?.querySelector('#cc-draw-settings-popover');

        if (popover) {
            const isVisible = popover.style.display !== 'none';
            popover.style.display = isVisible ? 'none' : '';
            return;
        }

        this.createDrawSettingsPopover();
    }

    /**
    * Créer le popover de réglages de dessin
    */
    MidiEditorDrawSettingsMixin.createDrawSettingsPopover = function() {
        const btn = this.container?.querySelector('#cc-draw-settings-btn');
        if (!btn) return;

        const currentDensity = this.ccEditor?.drawDensityMultiplier || 1;

        const popover = document.createElement('div');
        popover.id = 'cc-draw-settings-popover';
        popover.className = 'cc-draw-settings-popover';
        popover.innerHTML = `
            <div class="cc-draw-settings-section">
                <label class="cc-draw-settings-label">${this.t('midiEditor.drawDensity')}</label>
                <span class="cc-draw-settings-tip">${this.t('midiEditor.drawDensityTip')}</span>
                <div class="cc-draw-density-options">
                    <button class="cc-density-btn ${currentDensity === 0.25 ? 'active' : ''}" data-density="0.25">x4</button>
                    <button class="cc-density-btn ${currentDensity === 0.5 ? 'active' : ''}" data-density="0.5">x2</button>
                    <button class="cc-density-btn ${currentDensity === 1 ? 'active' : ''}" data-density="1">x1</button>
                    <button class="cc-density-btn ${currentDensity === 2 ? 'active' : ''}" data-density="2">½</button>
                    <button class="cc-density-btn ${currentDensity === 4 ? 'active' : ''}" data-density="4">¼</button>
                </div>
            </div>
        `;

        btn.parentElement.style.position = 'relative';
        btn.parentElement.appendChild(popover);

    // Attacher les listeners de densité
        popover.querySelectorAll('.cc-density-btn').forEach(densityBtn => {
            densityBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const density = parseFloat(densityBtn.dataset.density);
                this.applyDrawDensity(density);
                popover.querySelectorAll('.cc-density-btn').forEach(b => b.classList.remove('active'));
                densityBtn.classList.add('active');
            });
        });

    // Fermer le popover en cliquant en dehors
        const closeHandler = (e) => {
            if (!popover.contains(e.target) && e.target !== btn) {
                popover.style.display = 'none';
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 0);
    }

    /**
    * Appliquer la densité de dessin à l'éditeur CC actif
    */
    MidiEditorDrawSettingsMixin.applyDrawDensity = function(multiplier) {
        if (this.ccEditor && typeof this.ccEditor.setDrawDensity === 'function') {
            this.ccEditor.setDrawDensity(multiplier);
        }
        if (this.tempoEditor && typeof this.tempoEditor.setDrawDensity === 'function') {
            this.tempoEditor.setDrawDensity(multiplier);
        }
        this.log('info', `Draw density set to ${multiplier}`);
    }


    if (typeof window !== 'undefined') {
        window.MidiEditorDrawSettingsMixin = MidiEditorDrawSettingsMixin;
    }
})();
