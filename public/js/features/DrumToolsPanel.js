// ============================================================================
// Fichier: public/js/features/DrumToolsPanel.js
// Description: Percussion tools panel — velocity transforms
//   Operates on DrumGridRenderer.gridEvents via the orchestrator callback
// ============================================================================

class DrumToolsPanel {
    constructor(containerEl, options = {}) {
        this.containerEl = containerEl;
        this.gridRenderer = null; // Set by DrumPatternEditor after grid init
        this.onChanged = options.onChanged || null; // Callback after any transform

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
            <div class="drum-tools-panel">
                <div class="drum-tools-section">
                    <div class="drum-tools-section-title">${this.t('drumPattern.velocitySection')}</div>
                    <div class="drum-tools-row">
                        <button class="drum-tools-btn" data-action="humanize" title="${this.t('drumPattern.humanize')}">
                            ${this.t('drumPattern.humanizeShort')}
                        </button>
                        <input type="range" class="drum-tools-slider" id="drum-humanize-amount"
                            min="1" max="30" value="10" title="${this.t('drumPattern.humanizeAmount')}">
                        <span class="drum-tools-value" id="drum-humanize-val">±10</span>
                    </div>
                    <div class="drum-tools-row">
                        <button class="drum-tools-btn" data-action="accent" title="${this.t('drumPattern.accent')}">
                            ${this.t('drumPattern.accentShort')}
                        </button>
                    </div>
                    <div class="drum-tools-row">
                        <label class="drum-tools-label">${this.t('drumPattern.scale')}</label>
                        <input type="range" class="drum-tools-slider" id="drum-vel-scale"
                            min="50" max="150" value="100">
                        <span class="drum-tools-value" id="drum-vel-scale-val">100%</span>
                        <button class="drum-tools-btn drum-tools-btn-sm" data-action="apply-scale" title="${this.t('drumPattern.applyScale')}">&#10003;</button>
                    </div>
                    <div class="drum-tools-row drum-tools-row-btns">
                        <button class="drum-tools-btn drum-tools-btn-half" data-action="crescendo" title="${this.t('drumPattern.crescendo')}">
                            ${this.t('drumPattern.crescendoShort')} &#x2197;
                        </button>
                        <button class="drum-tools-btn drum-tools-btn-half" data-action="decrescendo" title="${this.t('drumPattern.decrescendo')}">
                            ${this.t('drumPattern.decrescendoShort')} &#x2198;
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    // ========================================================================
    // EVENTS
    // ========================================================================

    _attachEvents() {
        this.containerEl.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            this._handleAction(btn.dataset.action);
        });

        // Slider live updates
        const humanizeSlider = this.containerEl.querySelector('#drum-humanize-amount');
        if (humanizeSlider) {
            humanizeSlider.addEventListener('input', () => {
                const val = humanizeSlider.value;
                this.containerEl.querySelector('#drum-humanize-val').textContent = `±${val}`;
            });
        }

        const scaleSlider = this.containerEl.querySelector('#drum-vel-scale');
        if (scaleSlider) {
            scaleSlider.addEventListener('input', () => {
                const val = scaleSlider.value;
                this.containerEl.querySelector('#drum-vel-scale-val').textContent = `${val}%`;
            });
        }
    }

    _handleAction(action) {
        if (!this.gridRenderer) return;

        switch (action) {
            case 'humanize': {
                const amount = parseInt(this.containerEl.querySelector('#drum-humanize-amount')?.value || '10', 10);
                this.applyHumanize(amount);
                break;
            }
            case 'accent':
                this.applyAccent();
                break;
            case 'apply-scale': {
                const percent = parseInt(this.containerEl.querySelector('#drum-vel-scale')?.value || '100', 10);
                this.applyVelocityScale(percent);
                // Reset slider after applying
                const slider = this.containerEl.querySelector('#drum-vel-scale');
                if (slider) slider.value = 100;
                this.containerEl.querySelector('#drum-vel-scale-val').textContent = '100%';
                break;
            }
            case 'crescendo':
                this.applyCrescendo(40, 120);
                break;
            case 'decrescendo':
                this.applyCrescendo(120, 40);
                break;
        }
    }

    // ========================================================================
    // VELOCITY TRANSFORMS
    // ========================================================================

    /**
     * Get target events: selected if any, otherwise all
     */
    _getTargetEvents() {
        const gr = this.gridRenderer;
        if (gr.selectedEvents.size > 0) {
            return gr.getSelectedEvents();
        }
        return gr.gridEvents;
    }

    _clampVelocity(v) {
        return Math.max(1, Math.min(127, Math.round(v)));
    }

    _emitChanged() {
        if (this.gridRenderer) {
            this.gridRenderer.redraw();
        }
        if (this.onChanged) {
            this.onChanged();
        }
    }

    /**
     * Humanize: add random velocity variation and optional timing jitter
     */
    applyHumanize(amount) {
        const events = this._getTargetEvents();
        if (events.length === 0) return;

        this.gridRenderer.saveSnapshot();

        const tickJitter = Math.round(amount * 2); // Small timing jitter

        for (const evt of events) {
            // Velocity randomization
            const velDelta = Math.round((Math.random() * 2 - 1) * amount);
            evt.velocity = this._clampVelocity(evt.velocity + velDelta);

            // Timing jitter (small)
            if (tickJitter > 0) {
                const tickDelta = Math.round((Math.random() * 2 - 1) * tickJitter);
                evt.tick = Math.max(0, evt.tick + tickDelta);
            }
        }

        this._emitChanged();
    }

    /**
     * Accent downbeats: beats 1&3 get +20, beats 2&4 get -10
     */
    applyAccent() {
        const events = this._getTargetEvents();
        if (events.length === 0) return;

        this.gridRenderer.saveSnapshot();

        const tpb = this.gridRenderer.ticksPerBeat || 480;

        for (const evt of events) {
            const beatInMeasure = Math.floor(evt.tick / tpb) % (this.gridRenderer.beatsPerMeasure || 4);

            if (beatInMeasure === 0 || beatInMeasure === 2) {
                // Beats 1 & 3: accent
                evt.velocity = this._clampVelocity(evt.velocity + 20);
            } else {
                // Beats 2 & 4: soften
                evt.velocity = this._clampVelocity(evt.velocity - 10);
            }
        }

        this._emitChanged();
    }

    /**
     * Scale all velocities by a percentage
     */
    applyVelocityScale(percent) {
        if (percent === 100) return;

        const events = this._getTargetEvents();
        if (events.length === 0) return;

        this.gridRenderer.saveSnapshot();

        for (const evt of events) {
            evt.velocity = this._clampVelocity(evt.velocity * percent / 100);
        }

        this._emitChanged();
    }

    /**
     * Crescendo/Decrescendo: linear velocity interpolation across time range
     */
    applyCrescendo(startVel, endVel) {
        const events = this._getTargetEvents();
        if (events.length < 2) return;

        this.gridRenderer.saveSnapshot();

        // Sort by tick to find range
        const sorted = [...events].sort((a, b) => a.tick - b.tick);
        const minTick = sorted[0].tick;
        const maxTick = sorted[sorted.length - 1].tick;
        const range = maxTick - minTick;

        if (range === 0) return;

        for (const evt of events) {
            const t = (evt.tick - minTick) / range; // 0..1
            const vel = startVel + (endVel - startVel) * t;
            evt.velocity = this._clampVelocity(vel);
        }

        this._emitChanged();
    }

    // ========================================================================
    // LIFECYCLE
    // ========================================================================

    setGridRenderer(gridRenderer) {
        this.gridRenderer = gridRenderer;
    }

    updateTheme() {
        // DOM-based panel uses CSS variables, no manual update needed
    }

    destroy() {
        this.gridRenderer = null;
        this.containerEl.innerHTML = '';
    }
}

// ============================================================================
// EXPORT
// ============================================================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = DrumToolsPanel;
}
if (typeof window !== 'undefined') {
    window.DrumToolsPanel = DrumToolsPanel;
}
