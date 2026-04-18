// ============================================================================
// Fichier: public/js/features/WindArticulationPanel.js
// Description: Articulation tools panel for wind/brass instrument editor
//   Provides articulation selection, auto-breath toggle, range check toggle
//   Operates on WindMelodyRenderer events via orchestrator callback
// ============================================================================

class WindArticulationPanel {
    constructor(containerEl, options = {}) {
        this.containerEl = containerEl;
        this.renderer = null;          // Set by WindInstrumentEditor after renderer init
        this.onChanged = options.onChanged || null;
        this.onArticulationSelected = options.onArticulationSelected || null;

        // State
        this.currentArticulation = 'normal';

        this._createDOM();
        this._attachEvents();
    }

    // ========================================================================
    // I18N
    // ========================================================================

    t(key, params = {}) {
        return typeof i18n !== 'undefined' ? i18n.t(key, params) : key;
    }

    // ========================================================================
    // DOM
    // ========================================================================

    _createDOM() {
        this.containerEl.innerHTML = `
            <div class="wind-tools-panel">
                <div class="wind-tools-section">
                    <div class="wind-tools-section-title">${this.t('windEditor.articulationSection')}</div>
                    <div class="wind-tools-row wind-tools-row-btns">
                        <button class="wind-tools-btn wind-art-btn active" data-articulation="normal" title="${this.t('windEditor.normal')}">
                            ${this.t('windEditor.normal')}
                        </button>
                        <button class="wind-tools-btn wind-art-btn" data-articulation="legato" title="${this.t('windEditor.legato')}">
                            ${this.t('windEditor.legato')} \u2322
                        </button>
                    </div>
                    <div class="wind-tools-row wind-tools-row-btns">
                        <button class="wind-tools-btn wind-art-btn" data-articulation="staccato" title="${this.t('windEditor.staccato')}">
                            ${this.t('windEditor.staccato')} .
                        </button>
                        <button class="wind-tools-btn wind-art-btn" data-articulation="accent" title="${this.t('windEditor.accent')}">
                            ${this.t('windEditor.accent')} >
                        </button>
                    </div>
                </div>

                <div class="wind-tools-section">
                    <div class="wind-tools-section-title">${this.t('windEditor.infoSection')}</div>
                    <div class="wind-tools-info" id="wind-instrument-info">
                        <div class="wind-info-row">
                            <span class="wind-info-label">${this.t('windEditor.range')}:</span>
                            <span class="wind-info-value" id="wind-range-value">-</span>
                        </div>
                        <div class="wind-info-row">
                            <span class="wind-info-label">${this.t('windEditor.notes')}:</span>
                            <span class="wind-info-value" id="wind-notes-count">0</span>
                        </div>
                        <div class="wind-info-row">
                            <span class="wind-info-label">${this.t('windEditor.selected')}:</span>
                            <span class="wind-info-value" id="wind-selected-count">0</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    // ========================================================================
    // EVENTS
    // ========================================================================

    _attachEvents() {
        // Articulation buttons
        this.containerEl.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-articulation]');
            if (!btn) return;

            const art = btn.dataset.articulation;
            this.currentArticulation = art;

            // Update active state
            this.containerEl.querySelectorAll('.wind-art-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            if (this.onArticulationSelected) {
                this.onArticulationSelected(art);
            }
        });

    }

    // ========================================================================
    // PUBLIC API
    // ========================================================================

    setRenderer(renderer) {
        this.renderer = renderer;
    }

    getCurrentArticulation() {
        return this.currentArticulation;
    }

    setArticulation(art) {
        this.currentArticulation = art;
        this.containerEl.querySelectorAll('.wind-art-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.articulation === art);
        });
    }

    updateInfo(preset, noteCount, selectedCount) {
        const rangeEl = this.containerEl.querySelector('#wind-range-value');
        const notesEl = this.containerEl.querySelector('#wind-notes-count');
        const selEl = this.containerEl.querySelector('#wind-selected-count');

        if (rangeEl && preset) {
            rangeEl.textContent = `${WindInstrumentDatabase.noteName(preset.rangeMin)}-${WindInstrumentDatabase.noteName(preset.rangeMax)}`;
        }
        if (notesEl) notesEl.textContent = String(noteCount);
        if (selEl) selEl.textContent = String(selectedCount);
    }

    // ========================================================================
    // CLEANUP
    // ========================================================================

    destroy() {
        if (this.containerEl) {
            this.containerEl.innerHTML = '';
        }
    }
}

// ============================================================================
// EXPORT
// ============================================================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = WindArticulationPanel;
}
if (typeof window !== 'undefined') {
    window.WindArticulationPanel = WindArticulationPanel;
}
