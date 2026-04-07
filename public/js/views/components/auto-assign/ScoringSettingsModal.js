// public/js/views/components/auto-assign/ScoringSettingsModal.js
// Standalone modal for auto-assignment scoring settings with 4 tabs
(function() {
'use strict';

class ScoringSettingsModal extends BaseModal {
  constructor(currentOverrides, onApply) {
    super({
      id: 'scoring-settings-modal',
      size: 'lg',
      title: 'scoringSettings.title',
      customClass: 'ss-modal'
    });
    this.overrides = JSON.parse(JSON.stringify(currentOverrides));
    this.onApplyCallback = onApply;
    this.activeTab = 'general';
    this.activePreset = currentOverrides._preset || null;
    this.presetSnapshot = null;
  }

  // ============================================================================
  // Defaults
  // ============================================================================

  static getDefaults() {
    return {
      weights: { noteRange: 40, programMatch: 22, instrumentType: 20, polyphony: 13, ccSupport: 5 },
      scoreThresholds: { acceptable: 60, minimum: 30 },
      penalties: { transpositionPerOctave: 3, maxTranspositionOctaves: 3 },
      bonuses: { sameCategoryMatch: 15, sameFamilyMatch: 12, exactTypeMatch: 20 },
      percussion: {
        drumChannelDrumBonus: 15,
        drumChannelNonDrumPenalty: -100,
        nonDrumChannelDrumPenalty: -100,
        drumChannelWeights: { noteRange: 50, instrumentType: 30, polyphony: 10, programMatch: 5, ccSupport: 5 }
      },
      splitting: { triggerBelowScore: 60, minQuality: 50, maxInstruments: 4 }
    };
  }

  // ============================================================================
  // Presets
  // ============================================================================

  static getPresets() {
    return [
      { key: 'balanced', icon: '\u2696\uFE0F', label: 'scoringSettings.presetBalanced', desc: 'scoringSettings.presetBalancedDesc',
        weights: { noteRange: 40, programMatch: 22, instrumentType: 20, polyphony: 13, ccSupport: 5 },
        scoreThresholds: { acceptable: 60, minimum: 30 },
        penalties: { transpositionPerOctave: 3, maxTranspositionOctaves: 3 },
        bonuses: { sameCategoryMatch: 15, sameFamilyMatch: 12, exactTypeMatch: 20 },
        percussion: { drumChannelDrumBonus: 15, drumChannelNonDrumPenalty: -100, nonDrumChannelDrumPenalty: -100,
          drumChannelWeights: { noteRange: 50, instrumentType: 30, polyphony: 10, programMatch: 5, ccSupport: 5 } },
        splitting: { triggerBelowScore: 60, minQuality: 50, maxInstruments: 4 } },

      { key: 'orchestral', icon: '\uD83C\uDFBB', label: 'scoringSettings.presetOrchestral', desc: 'scoringSettings.presetOrchestralDesc',
        weights: { noteRange: 35, programMatch: 25, instrumentType: 25, polyphony: 8, ccSupport: 7 },
        scoreThresholds: { acceptable: 65, minimum: 35 },
        penalties: { transpositionPerOctave: 2, maxTranspositionOctaves: 2 },
        bonuses: { sameCategoryMatch: 18, sameFamilyMatch: 15, exactTypeMatch: 25 },
        percussion: { drumChannelDrumBonus: 10, drumChannelNonDrumPenalty: -100, nonDrumChannelDrumPenalty: -100,
          drumChannelWeights: { noteRange: 45, instrumentType: 35, polyphony: 10, programMatch: 5, ccSupport: 5 } },
        splitting: { triggerBelowScore: 55, minQuality: 55, maxInstruments: 3 } },

      { key: 'pop_rock', icon: '\uD83C\uDFB8', label: 'scoringSettings.presetPopRock', desc: 'scoringSettings.presetPopRockDesc',
        weights: { noteRange: 45, programMatch: 18, instrumentType: 22, polyphony: 12, ccSupport: 3 },
        scoreThresholds: { acceptable: 55, minimum: 25 },
        penalties: { transpositionPerOctave: 4, maxTranspositionOctaves: 2 },
        bonuses: { sameCategoryMatch: 12, sameFamilyMatch: 8, exactTypeMatch: 18 },
        percussion: { drumChannelDrumBonus: 20, drumChannelNonDrumPenalty: -100, nonDrumChannelDrumPenalty: -100,
          drumChannelWeights: { noteRange: 55, instrumentType: 25, polyphony: 10, programMatch: 5, ccSupport: 5 } },
        splitting: { triggerBelowScore: 65, minQuality: 45, maxInstruments: 3 } },

      { key: 'electronic', icon: '\uD83C\uDFB9', label: 'scoringSettings.presetElectronic', desc: 'scoringSettings.presetElectronicDesc',
        weights: { noteRange: 25, programMatch: 30, instrumentType: 22, polyphony: 15, ccSupport: 8 },
        scoreThresholds: { acceptable: 55, minimum: 25 },
        penalties: { transpositionPerOctave: 1, maxTranspositionOctaves: 5 },
        bonuses: { sameCategoryMatch: 18, sameFamilyMatch: 14, exactTypeMatch: 22 },
        percussion: { drumChannelDrumBonus: 15, drumChannelNonDrumPenalty: -100, nonDrumChannelDrumPenalty: -100,
          drumChannelWeights: { noteRange: 40, instrumentType: 30, polyphony: 15, programMatch: 10, ccSupport: 5 } },
        splitting: { triggerBelowScore: 50, minQuality: 40, maxInstruments: 5 } },

      { key: 'jazz', icon: '\uD83C\uDFB7', label: 'scoringSettings.presetJazz', desc: 'scoringSettings.presetJazzDesc',
        weights: { noteRange: 38, programMatch: 20, instrumentType: 28, polyphony: 8, ccSupport: 6 },
        scoreThresholds: { acceptable: 60, minimum: 30 },
        penalties: { transpositionPerOctave: 2, maxTranspositionOctaves: 3 },
        bonuses: { sameCategoryMatch: 20, sameFamilyMatch: 16, exactTypeMatch: 22 },
        percussion: { drumChannelDrumBonus: 18, drumChannelNonDrumPenalty: -100, nonDrumChannelDrumPenalty: -100,
          drumChannelWeights: { noteRange: 45, instrumentType: 35, polyphony: 10, programMatch: 5, ccSupport: 5 } },
        splitting: { triggerBelowScore: 55, minQuality: 50, maxInstruments: 3 } },

      { key: 'drums_focused', icon: '\uD83E\uDD41', label: 'scoringSettings.presetDrumsFocused', desc: 'scoringSettings.presetDrumsFocusedDesc',
        weights: { noteRange: 35, programMatch: 20, instrumentType: 20, polyphony: 15, ccSupport: 10 },
        scoreThresholds: { acceptable: 55, minimum: 25 },
        penalties: { transpositionPerOctave: 3, maxTranspositionOctaves: 3 },
        bonuses: { sameCategoryMatch: 15, sameFamilyMatch: 12, exactTypeMatch: 20 },
        percussion: { drumChannelDrumBonus: 25, drumChannelNonDrumPenalty: -100, nonDrumChannelDrumPenalty: -100,
          drumChannelWeights: { noteRange: 60, instrumentType: 20, polyphony: 10, programMatch: 5, ccSupport: 5 } },
        splitting: { triggerBelowScore: 70, minQuality: 55, maxInstruments: 5 } },

      { key: 'minimal', icon: '\uD83C\uDFB5', label: 'scoringSettings.presetMinimal', desc: 'scoringSettings.presetMinimalDesc',
        weights: { noteRange: 45, programMatch: 15, instrumentType: 18, polyphony: 15, ccSupport: 7 },
        scoreThresholds: { acceptable: 45, minimum: 20 },
        penalties: { transpositionPerOctave: 2, maxTranspositionOctaves: 4 },
        bonuses: { sameCategoryMatch: 12, sameFamilyMatch: 10, exactTypeMatch: 15 },
        percussion: { drumChannelDrumBonus: 15, drumChannelNonDrumPenalty: -100, nonDrumChannelDrumPenalty: -100,
          drumChannelWeights: { noteRange: 50, instrumentType: 30, polyphony: 10, programMatch: 5, ccSupport: 5 } },
        splitting: { triggerBelowScore: 40, minQuality: 35, maxInstruments: 2 } }
    ];
  }

  // ============================================================================
  // Ensure overrides have all required fields
  // ============================================================================

  _ensureDefaults() {
    const d = ScoringSettingsModal.getDefaults();
    if (!this.overrides.bonuses) this.overrides.bonuses = { ...d.bonuses };
    if (!this.overrides.percussion) this.overrides.percussion = { ...d.percussion };
    if (!this.overrides.percussion.drumChannelWeights) {
      this.overrides.percussion.drumChannelWeights = { ...d.percussion.drumChannelWeights };
    }
    if (this.overrides.percussion.drumChannelNonDrumPenalty === undefined) {
      this.overrides.percussion.drumChannelNonDrumPenalty = d.percussion.drumChannelNonDrumPenalty;
    }
    if (this.overrides.percussion.nonDrumChannelDrumPenalty === undefined) {
      this.overrides.percussion.nonDrumChannelDrumPenalty = d.percussion.nonDrumChannelDrumPenalty;
    }
  }

  // ============================================================================
  // Body / Footer rendering
  // ============================================================================

  renderBody() {
    this._ensureDefaults();
    this._detectActivePreset();
    const presets = ScoringSettingsModal.getPresets();
    const activeP = presets.find(p => p.key === this.activePreset);

    return `
      <div class="ss-preset-bar">
        ${presets.map(p => `
          <button class="ss-preset-chip ${this.activePreset === p.key ? 'active' : ''}" data-preset="${p.key}" title="${this.t(p.desc)}">
            <span class="ss-preset-icon">${p.icon}</span>
            <span class="ss-preset-name">${this.t(p.label)}</span>
          </button>
        `).join('')}
      </div>
      <div class="ss-preset-desc" id="ssPresetDesc">${activeP ? this.t(activeP.desc) : ''}</div>

      <div class="ss-tabs" role="tablist">
        <button class="ss-tab ${this.activeTab === 'general' ? 'active' : ''}" data-tab="general" role="tab">
          ${this.t('scoringSettings.tabGeneral')}
        </button>
        <button class="ss-tab ${this.activeTab === 'transposition' ? 'active' : ''}" data-tab="transposition" role="tab">
          ${this.t('scoringSettings.tabTransposition')}
        </button>
        <button class="ss-tab ${this.activeTab === 'percussion' ? 'active' : ''}" data-tab="percussion" role="tab">
          ${this.t('scoringSettings.tabPercussion')}
        </button>
        <button class="ss-tab ${this.activeTab === 'splitting' ? 'active' : ''}" data-tab="splitting" role="tab">
          ${this.t('scoringSettings.tabSplitting')}
        </button>
      </div>
      <div class="ss-content">
        <div class="ss-section ${this.activeTab === 'general' ? 'active' : ''}" data-section="general">
          ${this._renderGeneralTab()}
        </div>
        <div class="ss-section ${this.activeTab === 'transposition' ? 'active' : ''}" data-section="transposition">
          ${this._renderTranspositionTab()}
        </div>
        <div class="ss-section ${this.activeTab === 'percussion' ? 'active' : ''}" data-section="percussion">
          ${this._renderPercussionTab()}
        </div>
        <div class="ss-section ${this.activeTab === 'splitting' ? 'active' : ''}" data-section="splitting">
          ${this._renderSplittingTab()}
        </div>
      </div>
    `;
  }

  renderFooter() {
    return `
      <button class="btn" id="ssReset">${this.t('scoringSettings.reset')}</button>
      <div style="flex:1"></div>
      <button class="btn" id="ssCancel">${this.t('common.cancel')}</button>
      <button class="btn btn-primary" id="ssApply">${this.t('scoringSettings.apply')}</button>
    `;
  }

  // ============================================================================
  // Tab content renderers
  // ============================================================================

  _renderGeneralTab() {
    const w = this.overrides.weights;
    const t = this.overrides.scoreThresholds;
    const sum = w.noteRange + w.programMatch + w.instrumentType + w.polyphony + w.ccSupport;

    return `
      <div class="ss-group">
        <h4>${this.t('scoringSettings.sectionWeights')}</h4>
        <p class="ss-group-desc">${this.t('scoringSettings.weightsDesc')}</p>
        ${this._linkedSlider('noteRange', 'scoringSettings.weightNoteRange', w.noteRange, 0, 80)}
        ${this._linkedSlider('programMatch', 'scoringSettings.weightProgramMatch', w.programMatch, 0, 60)}
        ${this._linkedSlider('instrumentType', 'scoringSettings.weightInstrumentType', w.instrumentType, 0, 60)}
        ${this._linkedSlider('polyphony', 'scoringSettings.weightPolyphony', w.polyphony, 0, 40)}
        ${this._linkedSlider('ccSupport', 'scoringSettings.weightCCSupport', w.ccSupport, 0, 30)}
        <div class="ss-weight-total ${sum !== 100 ? 'error' : ''}" id="ssWeightTotal">
          ${this.t('scoringSettings.total')}: <strong>${sum}</strong>/100
        </div>
      </div>
      <div class="ss-group">
        <h4>${this.t('scoringSettings.sectionThresholds')}</h4>
        ${this._slider('acceptable', 'scoringSettings.thresholdAcceptable', t.acceptable, 20, 95, 'scoreThresholds')}
        ${this._slider('minimum', 'scoringSettings.thresholdMinimum', t.minimum, 0, 60, 'scoreThresholds')}
      </div>
    `;
  }

  _renderTranspositionTab() {
    const p = this.overrides.penalties;
    const b = this.overrides.bonuses;

    return `
      <div class="ss-group">
        <h4>${this.t('scoringSettings.tabTransposition')}</h4>
        ${this._slider('maxTranspositionOctaves', 'scoringSettings.transMaxOctaves', p.maxTranspositionOctaves, 1, 6, 'penalties')}
        ${this._slider('transpositionPerOctave', 'scoringSettings.transPenalty', p.transpositionPerOctave, 0, 15, 'penalties')}
      </div>
      <div class="ss-group">
        <h4>${this.t('scoringSettings.sectionBonuses')}</h4>
        ${this._slider('sameCategoryMatch', 'scoringSettings.bonusSameCategory', b.sameCategoryMatch, 0, 25, 'bonuses')}
        ${this._slider('sameFamilyMatch', 'scoringSettings.bonusSameFamily', b.sameFamilyMatch, 0, 20, 'bonuses')}
        ${this._slider('exactTypeMatch', 'scoringSettings.bonusExactType', b.exactTypeMatch || 20, 0, 30, 'bonuses')}
      </div>
    `;
  }

  _renderPercussionTab() {
    const perc = this.overrides.percussion;
    const dw = perc.drumChannelWeights;
    const dwSum = dw.noteRange + dw.instrumentType + dw.polyphony + dw.programMatch + dw.ccSupport;

    return `
      <div class="ss-group">
        <h4>${this.t('scoringSettings.sectionDrumWeights')}</h4>
        <p class="ss-group-desc">${this.t('scoringSettings.drumWeightsDesc')}</p>
        ${this._drumSlider('noteRange', 'scoringSettings.weightNoteRange', dw.noteRange, 0, 80)}
        ${this._drumSlider('instrumentType', 'scoringSettings.weightInstrumentType', dw.instrumentType, 0, 60)}
        ${this._drumSlider('polyphony', 'scoringSettings.weightPolyphony', dw.polyphony, 0, 30)}
        ${this._drumSlider('programMatch', 'scoringSettings.weightProgramMatch', dw.programMatch, 0, 20)}
        ${this._drumSlider('ccSupport', 'scoringSettings.weightCCSupport', dw.ccSupport, 0, 20)}
        <div class="ss-weight-total ${dwSum !== 100 ? 'error' : ''}" id="ssDrumWeightTotal">
          ${this.t('scoringSettings.total')}: <strong>${dwSum}</strong>/100
        </div>
      </div>
      <div class="ss-group">
        <h4>${this.t('scoringSettings.sectionDrumPenalties')}</h4>
        ${this._slider('drumChannelDrumBonus', 'scoringSettings.drumBonus', perc.drumChannelDrumBonus, 0, 30, 'percussion')}
        ${this._slider('drumChannelNonDrumPenalty', 'scoringSettings.drumNonDrumPenalty', perc.drumChannelNonDrumPenalty, -100, 0, 'percussion')}
        ${this._slider('nonDrumChannelDrumPenalty', 'scoringSettings.drumOnMelodicPenalty', perc.nonDrumChannelDrumPenalty, -100, 0, 'percussion')}
      </div>
    `;
  }

  _renderSplittingTab() {
    const s = this.overrides.splitting;

    return `
      <div class="ss-group">
        <h4>${this.t('scoringSettings.tabSplitting')}</h4>
        ${this._slider('triggerBelowScore', 'scoringSettings.splitTrigger', s.triggerBelowScore, 20, 90, 'splitting')}
        ${this._slider('minQuality', 'scoringSettings.splitMinQuality', s.minQuality, 10, 90, 'splitting')}
        ${this._slider('maxInstruments', 'scoringSettings.splitMaxInstruments', s.maxInstruments, 2, 8, 'splitting')}
      </div>
    `;
  }

  // ============================================================================
  // Slider helpers
  // ============================================================================

  _linkedSlider(key, labelKey, value, min, max) {
    return `
      <div class="ss-slider-row">
        <label class="ss-slider-label">${this.t(labelKey)}</label>
        <input type="range" class="ss-slider ss-linked" data-key="${key}" min="${min}" max="${max}" value="${value}">
        <span class="ss-slider-value" id="ssW_${key}">${value}</span>
      </div>
    `;
  }

  _drumSlider(key, labelKey, value, min, max) {
    return `
      <div class="ss-slider-row">
        <label class="ss-slider-label">${this.t(labelKey)}</label>
        <input type="range" class="ss-slider ss-drum-linked" data-key="${key}" min="${min}" max="${max}" value="${value}">
        <span class="ss-slider-value" id="ssDW_${key}">${value}</span>
      </div>
    `;
  }

  _slider(key, labelKey, value, min, max, group) {
    return `
      <div class="ss-slider-row">
        <label class="ss-slider-label">${this.t(labelKey)}</label>
        <input type="range" class="ss-slider ss-simple" data-key="${key}" data-group="${group}" min="${min}" max="${max}" value="${value}">
        <span class="ss-slider-value">${value}</span>
      </div>
    `;
  }

  // ============================================================================
  // Event binding
  // ============================================================================

  onOpen() {
    const dialog = this.dialog;
    if (!dialog) return;

    // Tab switching
    dialog.querySelectorAll('.ss-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this.activeTab = tab.dataset.tab;
        dialog.querySelectorAll('.ss-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === this.activeTab));
        dialog.querySelectorAll('.ss-section').forEach(s => s.classList.toggle('active', s.dataset.section === this.activeTab));
      });
    });

    // Preset chip clicks
    dialog.querySelectorAll('.ss-preset-chip').forEach(chip => {
      chip.addEventListener('click', () => this._applyPreset(chip.dataset.preset));
    });

    // Linked weight sliders (general)
    dialog.querySelectorAll('.ss-linked').forEach(slider => {
      slider.addEventListener('input', () => {
        this._onLinkedWeightChange(slider.dataset.key, parseInt(slider.value), 'weights', 'ssW_', 'ssWeightTotal');
        this._updatePresetIndicator();
      });
    });

    // Linked drum weight sliders
    dialog.querySelectorAll('.ss-drum-linked').forEach(slider => {
      slider.addEventListener('input', () => {
        this._onLinkedWeightChange(slider.dataset.key, parseInt(slider.value), 'drumWeights', 'ssDW_', 'ssDrumWeightTotal');
        this._updatePresetIndicator();
      });
    });

    // Simple sliders
    dialog.querySelectorAll('.ss-simple').forEach(slider => {
      slider.addEventListener('input', () => {
        const key = slider.dataset.key;
        const group = slider.dataset.group;
        const val = parseInt(slider.value);
        if (this.overrides[group]) {
          this.overrides[group][key] = val;
        }
        slider.nextElementSibling.textContent = val;
        this._updatePresetIndicator();
      });
    });

    // Footer buttons
    dialog.querySelector('#ssReset')?.addEventListener('click', () => this._reset());
    dialog.querySelector('#ssCancel')?.addEventListener('click', () => this.close());
    dialog.querySelector('#ssApply')?.addEventListener('click', () => this._apply());
  }

  // ============================================================================
  // Linked weight logic
  // ============================================================================

  _onLinkedWeightChange(changedKey, newValue, weightGroup, idPrefix, totalId) {
    const keys = ['noteRange', 'programMatch', 'instrumentType', 'polyphony', 'ccSupport'];
    let w;

    if (weightGroup === 'drumWeights') {
      w = this.overrides.percussion.drumChannelWeights;
    } else {
      w = this.overrides.weights;
    }

    const oldValue = w[changedKey];
    const delta = newValue - oldValue;
    if (delta === 0) return;

    const otherKeys = keys.filter(k => k !== changedKey);
    const otherTotal = otherKeys.reduce((s, k) => s + w[k], 0);

    if (otherTotal === 0 && delta > 0) return;

    let remaining = -delta;
    for (let i = 0; i < otherKeys.length; i++) {
      const k = otherKeys[i];
      if (i === otherKeys.length - 1) {
        w[k] = Math.max(0, w[k] + remaining);
      } else {
        const share = otherTotal > 0 ? w[k] / otherTotal : 1 / otherKeys.length;
        const adj = Math.round(remaining * share);
        const nv = Math.max(0, w[k] + adj);
        remaining -= (nv - w[k]);
        w[k] = nv;
      }
    }
    w[changedKey] = newValue;

    // Update all displays
    const dialog = this.dialog;
    for (const k of keys) {
      const sl = dialog.querySelector(`.ss-slider[data-key="${k}"]${weightGroup === 'drumWeights' ? '.ss-drum-linked' : '.ss-linked'}`);
      const ve = dialog.querySelector(`#${idPrefix}${k}`);
      if (sl) sl.value = w[k];
      if (ve) ve.textContent = w[k];
    }

    const sum = keys.reduce((s, k) => s + w[k], 0);
    const totalEl = dialog.querySelector(`#${totalId}`);
    if (totalEl) {
      totalEl.innerHTML = `${this.t('scoringSettings.total')}: <strong>${sum}</strong>/100`;
      totalEl.classList.toggle('error', sum !== 100);
    }
  }

  // ============================================================================
  // Actions
  // ============================================================================

  // ============================================================================
  // Preset management
  // ============================================================================

  _applyPreset(key) {
    const preset = ScoringSettingsModal.getPresets().find(p => p.key === key);
    if (!preset) return;

    // Deep copy preset values into overrides
    this.overrides.weights = { ...preset.weights };
    this.overrides.scoreThresholds = { ...preset.scoreThresholds };
    this.overrides.penalties = { ...preset.penalties };
    this.overrides.bonuses = { ...preset.bonuses };
    this.overrides.percussion = {
      ...preset.percussion,
      drumChannelWeights: { ...preset.percussion.drumChannelWeights }
    };
    this.overrides.splitting = { ...preset.splitting };
    this.activePreset = key;
    this.presetSnapshot = JSON.stringify(this.overrides);

    // Re-render body and re-attach events
    const bodyEl = this.dialog?.querySelector('.modal-body');
    if (bodyEl) {
      bodyEl.innerHTML = this.renderBody();
      this.onOpen();
    }
  }

  _detectActivePreset() {
    const presets = ScoringSettingsModal.getPresets();
    const compareKeys = ['weights', 'scoreThresholds', 'penalties', 'bonuses', 'splitting'];

    for (const preset of presets) {
      let matches = true;
      for (const group of compareKeys) {
        if (!this.overrides[group]) { matches = false; break; }
        for (const [k, v] of Object.entries(preset[group])) {
          if (this.overrides[group][k] !== v) { matches = false; break; }
        }
        if (!matches) break;
      }
      // Also check percussion
      if (matches && this.overrides.percussion) {
        if (this.overrides.percussion.drumChannelDrumBonus !== preset.percussion.drumChannelDrumBonus) matches = false;
        if (matches && this.overrides.percussion.drumChannelWeights) {
          for (const [k, v] of Object.entries(preset.percussion.drumChannelWeights)) {
            if (this.overrides.percussion.drumChannelWeights[k] !== v) { matches = false; break; }
          }
        }
      }
      if (matches) {
        this.activePreset = preset.key;
        this.presetSnapshot = JSON.stringify(this.overrides);
        return;
      }
    }
    this.activePreset = null;
    this.presetSnapshot = null;
  }

  _updatePresetIndicator() {
    const dialog = this.dialog;
    if (!dialog) return;

    // Check if current values still match the active preset
    const isModified = this.presetSnapshot && JSON.stringify(this.overrides) !== this.presetSnapshot;

    dialog.querySelectorAll('.ss-preset-chip').forEach(chip => {
      const isActive = chip.dataset.preset === this.activePreset;
      chip.classList.toggle('active', isActive);
      chip.classList.toggle('modified', isActive && isModified);
    });

    // Update description
    const descEl = dialog.querySelector('#ssPresetDesc');
    if (descEl) {
      if (this.activePreset) {
        const preset = ScoringSettingsModal.getPresets().find(p => p.key === this.activePreset);
        descEl.textContent = preset ? this.t(preset.desc) : '';
      } else {
        descEl.textContent = '';
      }
    }
  }

  // ============================================================================
  // Actions
  // ============================================================================

  _reset() {
    this._applyPreset('balanced');
  }

  _apply() {
    // Persist the active preset key in the overrides (ignored by backend)
    this.overrides._preset = this.activePreset;
    if (typeof this.onApplyCallback === 'function') {
      this.onApplyCallback(this.overrides);
    }
    this.close();
  }
}

window.ScoringSettingsModal = ScoringSettingsModal;
})();
