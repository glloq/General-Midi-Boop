// ============================================================================
// File: public/js/features/midi-editor/MidiEditorDrawSettings.js
// Description: Draw settings popover — sub-component instantiated by
//   MidiEditorModal (converted from mixin in P2-F.10b). Keeps the mixin
//   export as backward-compatible forwarders.
// ============================================================================

(function() {
    'use strict';

    class MidiEditorDrawSettings {
        constructor(modal) {
            this.modal = modal;
        }

        /** Toggle the popover visibility; create it on first open. */
        toggleDrawSettingsPopover() {
            const popover = this.modal.container?.querySelector('#cc-draw-settings-popover');
            if (popover) {
                const isVisible = popover.style.display !== 'none';
                popover.style.display = isVisible ? 'none' : '';
                return;
            }
            this.createDrawSettingsPopover();
        }

        createDrawSettingsPopover() {
            const m = this.modal;
            const btn = m.container?.querySelector('#cc-draw-settings-btn');
            if (!btn) return;

            const currentDensity = m.ccEditor?.drawDensityMultiplier || 1;

            const popover = document.createElement('div');
            popover.id = 'cc-draw-settings-popover';
            popover.className = 'cc-draw-settings-popover';
            popover.innerHTML = `
                <div class="cc-draw-settings-section">
                    <label class="cc-draw-settings-label">${m.t('midiEditor.drawDensity')}</label>
                    <span class="cc-draw-settings-tip">${m.t('midiEditor.drawDensityTip')}</span>
                    <div class="cc-draw-density-options">
                        <button class="cc-density-btn ${currentDensity === 4 ? 'active' : ''}" data-density="4" title="${m.t('midiEditor.densityMin')}">
                            <span class="cc-density-label">Min</span>
                            <span class="cc-density-dots">·</span>
                        </button>
                        <button class="cc-density-btn ${currentDensity === 2 ? 'active' : ''}" data-density="2" title="${m.t('midiEditor.densityLow')}">
                            <span class="cc-density-label">Low</span>
                            <span class="cc-density-dots">· ·</span>
                        </button>
                        <button class="cc-density-btn cc-density-default ${currentDensity === 1 ? 'active' : ''}" data-density="1" title="${m.t('midiEditor.densityNormal')}">
                            <span class="cc-density-label">Med</span>
                            <span class="cc-density-dots">· · ·</span>
                        </button>
                        <button class="cc-density-btn ${currentDensity === 0.5 ? 'active' : ''}" data-density="0.5" title="${m.t('midiEditor.densityHigh')}">
                            <span class="cc-density-label">High</span>
                            <span class="cc-density-dots">· · · ·</span>
                        </button>
                        <button class="cc-density-btn ${currentDensity === 0.25 ? 'active' : ''}" data-density="0.25" title="${m.t('midiEditor.densityMax')}">
                            <span class="cc-density-label">Max</span>
                            <span class="cc-density-dots">· · · · ·</span>
                        </button>
                    </div>
                </div>
            `;

            btn.parentElement.style.position = 'relative';
            btn.parentElement.appendChild(popover);

            popover.querySelectorAll('.cc-density-btn').forEach((densityBtn) => {
                densityBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const density = parseFloat(densityBtn.dataset.density);
                    this.applyDrawDensity(density);
                    popover.querySelectorAll('.cc-density-btn').forEach((b) => b.classList.remove('active'));
                    densityBtn.classList.add('active');
                });
            });

            const closeHandler = (e) => {
                if (!popover.contains(e.target) && e.target !== btn) {
                    popover.style.display = 'none';
                    document.removeEventListener('click', closeHandler);
                }
            };
            setTimeout(() => document.addEventListener('click', closeHandler), 0);
        }

        applyDrawDensity(multiplier) {
            const m = this.modal;
            if (m.ccEditor && typeof m.ccEditor.setDrawDensity === 'function') {
                m.ccEditor.setDrawDensity(multiplier);
            }
            if (m.tempoEditor && typeof m.tempoEditor.setDrawDensity === 'function') {
                m.tempoEditor.setDrawDensity(multiplier);
            }
            m.log('info', `Draw density set to ${multiplier}`);
        }
    }

    if (typeof window !== 'undefined') {
        window.MidiEditorDrawSettings = MidiEditorDrawSettings;
    }
})();
