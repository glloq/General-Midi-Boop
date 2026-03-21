// ============================================================================
// Fichier: public/js/views/components/DrumToolsPanel.js
// Description: Percussion tools panel — velocity transforms, swing, pattern ops
//   Replaces the DrumKitDiagram sidebar with genuinely useful tools
//   Operates on DrumGridRenderer.gridEvents via the orchestrator callback
// ============================================================================

class DrumToolsPanel {
    constructor(containerEl, options = {}) {
        this.containerEl = containerEl;
        this.gridRenderer = null; // Set by DrumPatternEditor after grid init
        this.onChanged = options.onChanged || null; // Callback after any transform

        // State
        this.detectedPattern = null; // { length (ticks), events (relativized) }

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
                            Humanize
                        </button>
                        <input type="range" class="drum-tools-slider" id="drum-humanize-amount"
                            min="1" max="30" value="10" title="${this.t('drumPattern.humanizeAmount')}">
                        <span class="drum-tools-value" id="drum-humanize-val">±10</span>
                    </div>
                    <div class="drum-tools-row">
                        <button class="drum-tools-btn" data-action="accent" title="${this.t('drumPattern.accent')}">
                            Accent 1&3
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
                            Cresc &#x2197;
                        </button>
                        <button class="drum-tools-btn drum-tools-btn-half" data-action="decrescendo" title="${this.t('drumPattern.decrescendo')}">
                            Decresc &#x2198;
                        </button>
                    </div>
                </div>

                <div class="drum-tools-section">
                    <div class="drum-tools-section-title">${this.t('drumPattern.swingSection')}</div>
                    <div class="drum-tools-row">
                        <input type="range" class="drum-tools-slider drum-tools-slider-wide" id="drum-swing"
                            min="0" max="100" value="0">
                        <span class="drum-tools-value" id="drum-swing-val">0%</span>
                        <button class="drum-tools-btn drum-tools-btn-sm" data-action="apply-swing" title="${this.t('drumPattern.applySwing')}">&#10003;</button>
                    </div>
                </div>

                <div class="drum-tools-section">
                    <div class="drum-tools-section-title">${this.t('drumPattern.patternSection')}</div>
                    <div class="drum-tools-row">
                        <button class="drum-tools-btn" data-action="detect-pattern" title="${this.t('drumPattern.detectPattern')}">
                            Detect
                        </button>
                    </div>
                    <div class="drum-pattern-info" id="drum-pattern-info">--</div>
                    <div class="drum-tools-row">
                        <button class="drum-tools-btn" data-action="fill-pattern" id="drum-fill-btn" disabled title="${this.t('drumPattern.fillPattern')}">
                            Fill &rarr;
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

        const swingSlider = this.containerEl.querySelector('#drum-swing');
        if (swingSlider) {
            swingSlider.addEventListener('input', () => {
                const val = swingSlider.value;
                this.containerEl.querySelector('#drum-swing-val').textContent = `${val}%`;
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
            case 'apply-swing': {
                const percent = parseInt(this.containerEl.querySelector('#drum-swing')?.value || '0', 10);
                this.applySwing(percent);
                break;
            }
            case 'detect-pattern':
                this.detectPattern();
                break;
            case 'fill-pattern':
                this.fillWithPattern();
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
    // SWING
    // ========================================================================

    /**
     * Apply swing: shift every other 16th note forward
     */
    applySwing(percent) {
        if (percent === 0) return;

        const events = this._getTargetEvents();
        if (events.length === 0) return;

        this.gridRenderer.saveSnapshot();

        const tpb = this.gridRenderer.ticksPerBeat || 480;
        const ticksPer16th = tpb / 4;
        const maxShift = Math.round(ticksPer16th * 0.67);
        const shift = Math.round(maxShift * (percent / 100));

        for (const evt of events) {
            // Position within an 8th note (two 16th notes)
            const posIn8th = evt.tick % (ticksPer16th * 2);

            // Only shift the "and" 16ths (the second 16th in each 8th note pair)
            // Allow a small tolerance for quantization imprecision
            if (Math.abs(posIn8th - ticksPer16th) < 10) {
                evt.tick = evt.tick - posIn8th + ticksPer16th + shift;
            }
        }

        // Re-sort events after tick changes
        this.gridRenderer.gridEvents.sort((a, b) => a.tick - b.tick);

        this._emitChanged();
    }

    // ========================================================================
    // PATTERN DETECTION & FILL
    // ========================================================================

    /**
     * Detect repeating pattern (1, 2, or 4 bars)
     */
    detectPattern() {
        const gr = this.gridRenderer;
        const events = gr.gridEvents;
        if (events.length === 0) {
            this._updatePatternInfo(null);
            return;
        }

        const tpb = gr.ticksPerBeat || 480;
        const bpm = gr.beatsPerMeasure || 4;
        const ticksPerMeasure = tpb * bpm;

        // Try pattern lengths: 1 bar, 2 bars, 4 bars
        for (const bars of [1, 2, 4]) {
            const patternLength = ticksPerMeasure * bars;
            const pattern = this._extractPattern(events, patternLength);

            if (pattern.length === 0) continue;

            // Check if this pattern repeats
            const repeats = this._countRepeats(events, pattern, patternLength);

            if (repeats >= 2) {
                this.detectedPattern = {
                    length: patternLength,
                    bars: bars,
                    events: pattern,
                    repeats: repeats
                };
                this._updatePatternInfo(this.detectedPattern);
                return;
            }
        }

        // No pattern found
        this.detectedPattern = null;
        this._updatePatternInfo(null);
    }

    /**
     * Extract events within the first N ticks, relativized to tick 0
     */
    _extractPattern(events, length) {
        return events
            .filter(e => e.tick < length)
            .map(e => ({
                note: e.note,
                tick: e.tick,
                velocity: e.velocity,
                duration: e.duration || 120
            }));
    }

    /**
     * Count how many times the pattern repeats in the full event list
     */
    _countRepeats(allEvents, pattern, patternLength) {
        if (pattern.length === 0) return 0;

        const maxTick = Math.max(...allEvents.map(e => e.tick));
        const totalSlots = Math.floor(maxTick / patternLength) + 1;
        let matchCount = 0;

        for (let slot = 0; slot < totalSlots; slot++) {
            const offset = slot * patternLength;
            const slotEvents = allEvents.filter(e =>
                e.tick >= offset && e.tick < offset + patternLength
            );

            if (this._patternsMatch(pattern, slotEvents, offset)) {
                matchCount++;
            }
        }

        return matchCount;
    }

    /**
     * Check if a set of events matches the pattern (with tolerance)
     */
    _patternsMatch(pattern, slotEvents, offset) {
        if (Math.abs(pattern.length - slotEvents.length) > pattern.length * 0.2) {
            return false; // Too different in note count
        }

        let matched = 0;
        for (const p of pattern) {
            const found = slotEvents.some(e =>
                e.note === p.note &&
                Math.abs((e.tick - offset) - p.tick) < 20 // Tick tolerance
            );
            if (found) matched++;
        }

        // At least 80% of pattern notes must match
        return matched >= pattern.length * 0.8;
    }

    /**
     * Fill remaining measures with detected pattern
     */
    fillWithPattern() {
        if (!this.detectedPattern || !this.gridRenderer) return;

        const gr = this.gridRenderer;
        gr.saveSnapshot();

        const { length: patternLength, events: pattern } = this.detectedPattern;
        const maxTick = gr.getMaxTick();

        // Find the end of existing pattern repeats
        const lastEventTick = Math.max(...gr.gridEvents.map(e => e.tick));
        const startSlot = Math.ceil((lastEventTick + 1) / patternLength);

        // Fill up to a reasonable limit (double the current length, or 8 bars minimum)
        const tpb = gr.ticksPerBeat || 480;
        const bpm = gr.beatsPerMeasure || 4;
        const minFill = tpb * bpm * 8;
        const endTick = Math.max(maxTick + patternLength * 2, minFill);
        const endSlot = Math.ceil(endTick / patternLength);

        for (let slot = startSlot; slot < endSlot; slot++) {
            const offset = slot * patternLength;
            for (const p of pattern) {
                gr.gridEvents.push({
                    tick: p.tick + offset,
                    note: p.note,
                    velocity: p.velocity,
                    duration: p.duration || 120,
                    channel: gr.gridEvents[0]?.channel || 9
                });
            }
        }

        gr.gridEvents.sort((a, b) => a.tick - b.tick);
        gr._updateVisibleNotes();
        this._emitChanged();
    }

    _updatePatternInfo(pattern) {
        const infoEl = this.containerEl.querySelector('#drum-pattern-info');
        const fillBtn = this.containerEl.querySelector('#drum-fill-btn');

        if (pattern) {
            const barLabel = pattern.bars === 1 ? '1 bar' : `${pattern.bars} bars`;
            infoEl.textContent = `${this.t('drumPattern.patternDetected')}: ${barLabel} (×${pattern.repeats})`;
            infoEl.classList.add('drum-pattern-found');
            if (fillBtn) fillBtn.disabled = false;
        } else {
            infoEl.textContent = this.t('drumPattern.noPattern');
            infoEl.classList.remove('drum-pattern-found');
            if (fillBtn) fillBtn.disabled = true;
        }
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
        this.detectedPattern = null;
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
