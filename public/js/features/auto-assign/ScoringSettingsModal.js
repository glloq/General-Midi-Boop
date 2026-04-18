// public/js/features/auto-assign/ScoringSettingsModal.js
// Standalone modal for auto-assignment scoring settings with sidebar navigation
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
    this.activeSection = 'routing';
    this.activePreset = currentOverrides._preset || null;
    this.presetSnapshot = null;
  }

  // ============================================================================
  // Constants
  // ============================================================================

  static SECTIONS = [
    { id: 'routing', icon: '🔀', labelKey: 'scoringSettings.tabRouting', fallback: 'Routage' },
    { id: 'drums',   icon: '🥁', labelKey: 'scoringSettings.tabDrums',   fallback: 'Percussions' },
    { id: 'scoring', icon: '⚖️', labelKey: 'scoringSettings.tabScoring', fallback: 'Scoring' }
  ];

  // Drum categories with representative substitution chains from DrumNoteMapper.
  // Each chain shows the primary note and its ordered fallbacks (by musical proximity).
  // chain entries: { note, name } — first is the primary, rest are fallbacks by preference.
  // Category metadata: icon, label, notes belonging to this category.
  static DRUM_CAT_INFO = [
    { key: 'kicks',      icon: '🥁', labelKey: 'scoringSettings.catKicks',      fallback: 'Kicks',              notes: [35, 36] },
    { key: 'snares',     icon: '🪘', labelKey: 'scoringSettings.catSnares',     fallback: 'Snares',             notes: [37, 38, 40] },
    { key: 'hiHats',     icon: '🎩', labelKey: 'scoringSettings.catHiHats',     fallback: 'Hi-Hats',            notes: [42, 44, 46] },
    { key: 'toms',       icon: '🥁', labelKey: 'scoringSettings.catToms',       fallback: 'Toms',               notes: [41, 43, 45, 47, 48, 50] },
    { key: 'crashes',    icon: '💥', labelKey: 'scoringSettings.catCrashes',    fallback: 'Crashes',            notes: [49, 52, 55, 57] },
    { key: 'rides',      icon: '🔔', labelKey: 'scoringSettings.catRides',      fallback: 'Rides',              notes: [51, 53, 59] },
    { key: 'latin',      icon: '🪇', labelKey: 'scoringSettings.catLatin',      fallback: 'Latin',              notes: [60, 61, 62, 63, 64, 65, 66, 67, 68] },
    { key: 'shakers',    icon: '🫧', labelKey: 'scoringSettings.catShakers',    fallback: 'Shakers',            notes: [39, 54, 58, 69, 70] },
    { key: 'woodsMetal', icon: '🪵', labelKey: 'scoringSettings.catWoodsMetal', fallback: 'Bois & Métal',       notes: [56, 75, 76, 77] },
    { key: 'pitched',    icon: '🎶', labelKey: 'scoringSettings.catPitched',    fallback: 'Effets mélodiques',  notes: [71, 72, 73, 74] },
    { key: 'cuicas',     icon: '🪘', labelKey: 'scoringSettings.catCuicas',     fallback: 'Cuicas',             notes: [78, 79] },
    { key: 'triangles',  icon: '🔺', labelKey: 'scoringSettings.catTriangles',  fallback: 'Triangles',          notes: [80, 81] }
  ];

  // Short names for all GM drum notes (35-81)
  static NOTE_NAMES = {
    35: 'Ac. Bass Drum', 36: 'Bass Drum 1', 37: 'Side Stick', 38: 'Ac. Snare',
    39: 'Hand Clap', 40: 'Elec. Snare', 41: 'Low Floor Tom', 42: 'Closed Hi-Hat',
    43: 'High Floor Tom', 44: 'Pedal Hi-Hat', 45: 'Low Tom', 46: 'Open Hi-Hat',
    47: 'Low-Mid Tom', 48: 'Hi-Mid Tom', 49: 'Crash 1', 50: 'High Tom',
    51: 'Ride 1', 52: 'Chinese Cym.', 53: 'Ride Bell', 54: 'Tambourine',
    55: 'Splash Cym.', 56: 'Cowbell', 57: 'Crash 2', 58: 'Vibraslap',
    59: 'Ride 2', 60: 'Hi Bongo', 61: 'Low Bongo', 62: 'Mute Hi Conga',
    63: 'Open Hi Conga', 64: 'Low Conga', 65: 'High Timbale', 66: 'Low Timbale',
    67: 'High Agogo', 68: 'Low Agogo', 69: 'Cabasa', 70: 'Maracas',
    71: 'Short Whistle', 72: 'Long Whistle', 73: 'Short Guiro', 74: 'Long Guiro',
    75: 'Claves', 76: 'Hi Wood Block', 77: 'Low Wood Block', 78: 'Mute Cuica',
    79: 'Open Cuica', 80: 'Mute Triangle', 81: 'Open Triangle'
  };

  // Substitution tables (mirrors DrumNoteMapper.js backend)
  static SUBSTITUTION_TABLES = {
    35: [36, 41, 43, 45, 64, 66],
    36: [35, 41, 43, 45, 64, 66],
    37: [38, 40, 39, 54, 75, 76],
    38: [40, 37, 39, 54, 70, 56, 75],
    39: [37, 38, 40, 54, 70, 69],
    40: [38, 37, 39, 54, 70, 56, 75],
    41: [43, 45, 47, 64, 66, 62],
    42: [44, 46, 54, 70, 69, 53, 75],
    43: [41, 45, 47, 64, 66, 61],
    44: [42, 46, 54, 70, 69, 75, 81],
    45: [43, 47, 41, 48, 62, 64],
    46: [42, 44, 54, 70, 49, 55, 69],
    47: [45, 48, 43, 50, 62, 65],
    48: [47, 50, 45, 43, 60, 65],
    49: [57, 55, 52, 46, 51, 59, 81],
    50: [48, 47, 45, 43, 60, 65],
    51: [59, 53, 42, 49, 55, 81],
    52: [49, 57, 55, 46, 51, 56],
    53: [51, 59, 42, 56, 76],
    54: [70, 69, 42, 46, 39, 81],
    55: [49, 57, 52, 46, 51, 81],
    56: [53, 75, 76, 77, 67, 68],
    57: [49, 55, 52, 46, 51, 59, 81],
    58: [69, 70, 54, 39, 56, 75],
    59: [51, 53, 42, 49, 55, 81],
    60: [61, 48, 50, 62, 65, 76],
    61: [60, 47, 48, 62, 66, 77],
    62: [63, 64, 60, 61, 45, 76],
    63: [62, 64, 60, 61, 47, 77],
    64: [62, 63, 41, 43, 66, 77],
    65: [66, 48, 50, 62, 60, 76],
    66: [65, 47, 48, 64, 61, 77],
    67: [68, 76, 77, 56, 75, 80],
    68: [67, 76, 77, 56, 75, 81],
    69: [70, 54, 42, 39, 58, 75],
    70: [54, 69, 42, 46, 39, 75],
    71: [72, 73, 74, 80, 81],
    72: [71, 74, 73, 81, 80],
    73: [74, 71, 72, 75, 76],
    74: [73, 72, 71, 77, 75],
    75: [76, 77, 56, 67, 68, 70],
    76: [77, 75, 56, 67, 80],
    77: [76, 75, 56, 68, 81],
    78: [79, 73, 74, 71, 72],
    79: [78, 74, 73, 72, 71],
    80: [81, 53, 42, 76, 75],
    81: [80, 53, 55, 77, 42]
  };

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
      splitting: { triggerBelowScore: 60, minQuality: 50, maxInstruments: 4 },
      routing: {
        allowInstrumentReuse: true,
        sharedInstrumentPenalty: 10,
        autoSplitAvoidTransposition: false,
        preferSingleInstrument: true,
        preferSimilarGMType: true,
        drumFallback: {} // per-category depth: 0=exact, 1-N=substitution depth, -1=ignore
      }
    };
  }

  // ============================================================================
  // Presets
  // ============================================================================

  static getPresets() {
    return [
      { key: 'minimal', icon: '🎵', label: 'scoringSettings.presetMinimal', desc: 'scoringSettings.presetMinimalDesc',
        weights: { noteRange: 55, programMatch: 10, instrumentType: 15, polyphony: 15, ccSupport: 5 },
        scoreThresholds: { acceptable: 45, minimum: 20 },
        penalties: { transpositionPerOctave: 2, maxTranspositionOctaves: 4 },
        bonuses: { sameCategoryMatch: 8, sameFamilyMatch: 6, exactTypeMatch: 10 },
        percussion: { drumChannelDrumBonus: 15, drumChannelNonDrumPenalty: -100, nonDrumChannelDrumPenalty: -100,
          drumChannelWeights: { noteRange: 55, instrumentType: 25, polyphony: 10, programMatch: 5, ccSupport: 5 } },
        splitting: { triggerBelowScore: 40, minQuality: 35, maxInstruments: 2 } },

      { key: 'balanced', icon: '⚖️', label: 'scoringSettings.presetBalanced', desc: 'scoringSettings.presetBalancedDesc',
        weights: { noteRange: 40, programMatch: 22, instrumentType: 20, polyphony: 13, ccSupport: 5 },
        scoreThresholds: { acceptable: 60, minimum: 30 },
        penalties: { transpositionPerOctave: 3, maxTranspositionOctaves: 3 },
        bonuses: { sameCategoryMatch: 15, sameFamilyMatch: 12, exactTypeMatch: 20 },
        percussion: { drumChannelDrumBonus: 15, drumChannelNonDrumPenalty: -100, nonDrumChannelDrumPenalty: -100,
          drumChannelWeights: { noteRange: 50, instrumentType: 30, polyphony: 10, programMatch: 5, ccSupport: 5 } },
        splitting: { triggerBelowScore: 60, minQuality: 50, maxInstruments: 4 } },

      { key: 'orchestral', icon: '🎻', label: 'scoringSettings.presetOrchestral', desc: 'scoringSettings.presetOrchestralDesc',
        weights: { noteRange: 30, programMatch: 28, instrumentType: 28, polyphony: 8, ccSupport: 6 },
        scoreThresholds: { acceptable: 65, minimum: 35 },
        penalties: { transpositionPerOctave: 2, maxTranspositionOctaves: 2 },
        bonuses: { sameCategoryMatch: 20, sameFamilyMatch: 16, exactTypeMatch: 28 },
        percussion: { drumChannelDrumBonus: 10, drumChannelNonDrumPenalty: -100, nonDrumChannelDrumPenalty: -100,
          drumChannelWeights: { noteRange: 40, instrumentType: 40, polyphony: 10, programMatch: 5, ccSupport: 5 } },
        splitting: { triggerBelowScore: 55, minQuality: 55, maxInstruments: 3 } }
    ];
  }

  // ============================================================================
  // Ensure overrides have all required fields
  // ============================================================================

  _ensureDefaults() {
    const d = ScoringSettingsModal.getDefaults();
    if (!this.overrides.weights) this.overrides.weights = { ...d.weights };
    if (!this.overrides.scoreThresholds) this.overrides.scoreThresholds = { ...d.scoreThresholds };
    if (!this.overrides.penalties) this.overrides.penalties = { ...d.penalties };
    if (!this.overrides.bonuses) this.overrides.bonuses = { ...d.bonuses };
    if (!this.overrides.splitting) this.overrides.splitting = { ...d.splitting };
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
    if (!this.overrides.routing) this.overrides.routing = { ...d.routing };
    if (this.overrides.routing.allowInstrumentReuse === undefined) {
      this.overrides.routing.allowInstrumentReuse = d.routing.allowInstrumentReuse;
    }
    if (this.overrides.routing.sharedInstrumentPenalty === undefined) {
      this.overrides.routing.sharedInstrumentPenalty = d.routing.sharedInstrumentPenalty;
    }

    // Migrate legacy drumFallback.misc to new category keys
    const df = this.overrides.routing.drumFallback;
    if (df && df.misc !== undefined) {
      const newKeys = ['shakers', 'woodsMetal', 'pitched', 'cuicas', 'triangles'];
      for (const key of newKeys) {
        if (df[key] === undefined) df[key] = df.misc;
      }
      delete df.misc;
    }
  }

  // ============================================================================
  // Body / Footer rendering
  // ============================================================================

  renderBody() {
    this._ensureDefaults();
    if (!this.overrides.routing) this.overrides.routing = {};
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
      <div class="ss-layout">
        ${this._renderSidebar()}
        <div class="ss-content">
          <div class="ss-section ${this.activeSection === 'routing' ? 'active' : ''}" data-section="routing">
            ${this._renderRoutingSection()}
          </div>
          <div class="ss-section ${this.activeSection === 'drums' ? 'active' : ''}" data-section="drums">
            ${this._renderDrumsSection()}
          </div>
          <div class="ss-section ${this.activeSection === 'scoring' ? 'active' : ''}" data-section="scoring">
            ${this._renderScoringSection()}
          </div>
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
  // Sidebar
  // ============================================================================

  _renderSidebar() {
    let html = '<nav class="ss-sidebar">';
    for (const sec of ScoringSettingsModal.SECTIONS) {
      const active = this.activeSection === sec.id ? 'active' : '';
      html += `<button type="button" class="ss-nav-item ${active}" data-section="${sec.id}">
        <span class="ss-nav-icon">${sec.icon}</span>
        <span class="ss-nav-label">${this.t(sec.labelKey) || sec.fallback}</span>
      </button>`;
    }
    html += '</nav>';
    return html;
  }

  _switchSection(sectionId) {
    this.activeSection = sectionId;
    const dialog = this.dialog;
    if (!dialog) return;
    dialog.querySelectorAll('.ss-nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.section === sectionId);
    });
    dialog.querySelectorAll('.ss-section').forEach(sec => {
      sec.classList.toggle('active', sec.dataset.section === sectionId);
    });
  }

  // ============================================================================
  // Section: Routing
  // ============================================================================

  _renderRoutingSection() {
    const routing = this.overrides.routing;
    const sharedPenalty = routing.sharedInstrumentPenalty !== undefined ? routing.sharedInstrumentPenalty : 10;
    return `
      <h4 class="ss-section-title">🔀 ${this.t('scoringSettings.globalRouting') || 'Réglages routage'}</h4>
      <p class="ss-section-desc">${this.t('scoringSettings.globalRoutingDesc') || 'Options globales pour le routage automatique des canaux MIDI.'}</p>

      <div class="ss-toggle-group">
        <label class="ss-toggle-card">
          <input type="checkbox" class="ss-routing-toggle" data-key="allowInstrumentReuse" ${routing.allowInstrumentReuse !== false ? 'checked' : ''}>
          <div class="ss-toggle-content">
            <span class="ss-toggle-title">${this.t('scoringSettings.allowInstrumentReuse') || 'Autoriser le partage d\'instruments'}</span>
            <span class="ss-toggle-desc">${this.t('scoringSettings.allowInstrumentReuseDesc') || 'Permet d\'assigner un même instrument à plusieurs canaux MIDI quand il n\'y a pas assez d\'instruments disponibles. Évite le mute automatique des canaux excédentaires.'}</span>
          </div>
        </label>

        <div class="ss-conditional-group" id="ssSharedPenaltyGroup" style="${routing.allowInstrumentReuse !== false ? '' : 'display:none'}">
          ${this._slider('sharedInstrumentPenalty', 'scoringSettings.sharedPenalty', sharedPenalty, 0, 30, 'routing')}
        </div>

        <label class="ss-toggle-card">
          <input type="checkbox" class="ss-routing-toggle" data-key="autoSplitAvoidTransposition" ${routing.autoSplitAvoidTransposition ? 'checked' : ''}>
          <div class="ss-toggle-content">
            <span class="ss-toggle-title">${this.t('scoringSettings.autoSplitAvoidTransposition') || 'Découpe automatique si évite une transposition'}</span>
            <span class="ss-toggle-desc">${this.t('scoringSettings.autoSplitAvoidTranspositionDesc') || 'Divise un canal entre plusieurs instruments pour éviter la transposition'}</span>
          </div>
        </label>

        <label class="ss-toggle-card">
          <input type="checkbox" class="ss-routing-toggle" data-key="preferSingleInstrument" ${routing.preferSingleInstrument !== false ? 'checked' : ''}>
          <div class="ss-toggle-content">
            <span class="ss-toggle-title">${this.t('scoringSettings.preferSingleInstrument') || 'Préférer un seul instrument'}</span>
            <span class="ss-toggle-desc">${this.t('scoringSettings.preferSingleInstrumentDesc') || 'Évite de diviser un canal entre plusieurs instruments quand possible'}</span>
          </div>
        </label>

        <label class="ss-toggle-card">
          <input type="checkbox" class="ss-routing-toggle" data-key="preferSimilarGMType" ${routing.preferSimilarGMType !== false ? 'checked' : ''}>
          <div class="ss-toggle-content">
            <span class="ss-toggle-title">${this.t('scoringSettings.preferSimilarGMType') || 'Privilégier type GM similaire'}</span>
            <span class="ss-toggle-desc">${this.t('scoringSettings.preferSimilarGMTypeDesc') || 'Favorise les instruments dont le type GM correspond au canal'}</span>
          </div>
        </label>
      </div>
    `;
  }

  // ============================================================================
  // Section: Drums
  // ============================================================================

  /**
   * Convert legacy string drumFallback values to numeric depth.
   * Old format: "substitute" / "ignore" / "manual"
   * New format: 0 (exact) / 1-N (depth) / -1 (ignore)
   */
  static _migrateDrumFallbackValue(value, maxDepth) {
    if (typeof value === 'number') return value;
    if (value === 'ignore') return -1;
    if (value === 'substitute' || value === 'manual') return maxDepth;
    return undefined; // not set
  }

  _renderDrumsSection() {
    const routing = this.overrides.routing || {};
    const drumFallback = routing.drumFallback || {};
    const cats = ScoringSettingsModal.DRUM_CAT_INFO;
    const names = ScoringSettingsModal.NOTE_NAMES;
    const subs = ScoringSettingsModal.SUBSTITUTION_TABLES;

    let html = '';
    for (const cat of cats) {
      // Category depth: default to max chain length (all subs allowed)
      const maxCatSubs = Math.max(...cat.notes.map(n => (subs[n] || []).length));
      const rawValue = drumFallback[cat.key];
      const migratedValue = ScoringSettingsModal._migrateDrumFallbackValue(rawValue, maxCatSubs);
      const currentDepth = migratedValue !== undefined ? migratedValue : maxCatSubs;

      // Category header
      html += `<div class="ss-drum-cat-header" data-cat="${cat.key}">
        <span class="ss-drum-cat-icon">${cat.icon}</span>
        <span class="ss-drum-cat-label">${this.t(cat.labelKey) || cat.fallback}</span>
        <span class="ss-chain-node ss-chain-ignore ${currentDepth === -1 ? 'ss-chain-allowed' : 'ss-chain-disabled'}" data-cat="${cat.key}" data-depth="-1" title="${this.t('scoringSettings.depthIgnoreDesc') || 'Ignorer toute la catégorie'}">⛔</span>
      </div>`;

      // One row per note
      for (const noteNum of cat.notes) {
        const noteSubs = subs[noteNum] || [];
        const noteName = names[noteNum] || `Note ${noteNum}`;

        // Build substitution chain nodes
        let chainHtml = '';
        for (let i = 0; i < noteSubs.length; i++) {
          const subNote = noteSubs[i];
          const subName = names[subNote] || `${subNote}`;
          const isAllowed = currentDepth >= 0 && (i + 1) <= currentDepth;
          const levelClass = i === 0 ? 'ss-chain-close' :
                             i === 1 ? 'ss-chain-similar' : 'ss-chain-distant';
          const stateClass = isAllowed ? 'ss-chain-allowed' : 'ss-chain-disabled';

          chainHtml += `<span class="ss-chain-arrow ${stateClass}">→</span>`;
          chainHtml += `<span class="ss-chain-node ${levelClass} ${stateClass}" data-cat="${cat.key}" data-depth="${i + 1}" title="${subName} (MIDI ${subNote})">${subName}</span>`;
        }

        const primaryAllowed = currentDepth >= 0;
        html += `
          <div class="ss-drum-note-row" data-cat="${cat.key}" data-note="${noteNum}">
            <span class="ss-drum-note-id">${noteNum}</span>
            <span class="ss-chain-node ss-chain-primary ${primaryAllowed ? 'ss-chain-allowed' : 'ss-chain-disabled'}" data-cat="${cat.key}" data-depth="0" title="${noteName} (MIDI ${noteNum})">${noteName}</span>
            <div class="ss-chain-container">${chainHtml}</div>
          </div>`;
      }

      html += `<input type="hidden" class="ss-drum-depth-input" data-cat="${cat.key}" value="${currentDepth}">`;
    }

    return `
      <h4 class="ss-section-title">🥁 ${this.t('scoringSettings.drumSettings') || 'Réglages Drums'}</h4>
      <p class="ss-section-desc">${this.t('scoringSettings.drumChainDesc') || 'Cliquez sur la chaîne pour définir la profondeur de substitution autorisée par catégorie. Chaque ligne = 1 note GM.'}</p>

      <div class="ss-drum-legend">
        <span class="ss-legend-item"><span class="ss-legend-dot ss-chain-primary ss-chain-allowed"></span> ${this.t('scoringSettings.legendPrimary') || 'Originale'}</span>
        <span class="ss-legend-item"><span class="ss-legend-dot ss-chain-close ss-chain-allowed"></span> ${this.t('scoringSettings.legendClose') || 'Proche'}</span>
        <span class="ss-legend-item"><span class="ss-legend-dot ss-chain-similar ss-chain-allowed"></span> ${this.t('scoringSettings.legendSimilar') || 'Similaire'}</span>
        <span class="ss-legend-item"><span class="ss-legend-dot ss-chain-distant ss-chain-allowed"></span> ${this.t('scoringSettings.legendDistant') || 'Éloigné'}</span>
        <span class="ss-legend-item"><span class="ss-legend-dot ss-chain-disabled"></span> ${this.t('scoringSettings.legendDisabled') || 'Désactivé'}</span>
      </div>

      <div class="ss-drum-categories">
        ${html}
      </div>
    `;
  }

  // ============================================================================
  // Section: Scoring (advanced)
  // ============================================================================

  _renderScoringSection() {
    return `
      <h4 class="ss-section-title">⚖️ ${this.t('scoringSettings.tabScoring') || 'Scoring'}</h4>
      <p class="ss-section-desc">${this.t('scoringSettings.scoringDesc') || 'Paramètres avancés de scoring pour l\'auto-assignation.'}</p>
      ${this._renderGeneralTab()}
      ${this._renderTranspositionTab()}
      ${this._renderPercussionTab()}
      ${this._renderSplittingTab()}
    `;
  }

  // ============================================================================
  // Scoring sub-sections
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
        ${this._slider('exactTypeMatch', 'scoringSettings.bonusExactType', b.exactTypeMatch !== undefined ? b.exactTypeMatch : 20, 0, 30, 'bonuses')}
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

    // Sidebar navigation
    dialog.querySelectorAll('.ss-nav-item').forEach(btn => {
      btn.addEventListener('click', () => this._switchSection(btn.dataset.section));
    });

    // Preset chip clicks
    dialog.querySelectorAll('.ss-preset-chip').forEach(chip => {
      chip.addEventListener('click', () => this._applyPreset(chip.dataset.preset));
    });

    // Global routing toggles
    dialog.querySelectorAll('.ss-routing-toggle').forEach(toggle => {
      toggle.addEventListener('change', () => {
        if (!this.overrides.routing) this.overrides.routing = {};
        this.overrides.routing[toggle.dataset.key] = toggle.checked;
        // Show/hide shared penalty slider when allowInstrumentReuse changes
        if (toggle.dataset.key === 'allowInstrumentReuse') {
          const penaltyGroup = dialog.querySelector('#ssSharedPenaltyGroup');
          if (penaltyGroup) penaltyGroup.style.display = toggle.checked ? '' : 'none';
        }
      });
    });

    // Drum substitution chain node clicks
    dialog.querySelectorAll('.ss-chain-node').forEach(node => {
      node.addEventListener('click', () => {
        const cat = node.dataset.cat;
        const depth = parseInt(node.dataset.depth);
        this._setDrumDepth(cat, depth);
      });
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
  // Drum depth control
  // ============================================================================

  /**
   * Set substitution depth for a drum category.
   * depth: 0 = exact only, 1+ = substitution chain depth, -1 = ignore (don't play)
   */
  _setDrumDepth(catKey, depth) {
    if (!this.overrides.routing) this.overrides.routing = {};
    if (!this.overrides.routing.drumFallback) this.overrides.routing.drumFallback = {};
    this.overrides.routing.drumFallback[catKey] = depth;

    const dialog = this.dialog;
    if (!dialog) return;

    // Update ALL elements with this category (note rows + cat header)
    dialog.querySelectorAll(`[data-cat="${catKey}"] .ss-chain-node, .ss-drum-cat-header[data-cat="${catKey}"] .ss-chain-node`).forEach(node => {
      const nodeDepth = parseInt(node.dataset.depth);
      const isAllowed = depth >= 0 && nodeDepth >= 0 && nodeDepth <= depth;
      const isIgnore = nodeDepth === -1 && depth === -1;
      node.classList.toggle('ss-chain-allowed', isAllowed || isIgnore);
      node.classList.toggle('ss-chain-disabled', !isAllowed && !isIgnore);
    });

    // Update arrows in all note rows for this category
    dialog.querySelectorAll(`.ss-drum-note-row[data-cat="${catKey}"]`).forEach(row => {
      row.querySelectorAll('.ss-chain-arrow').forEach(arrow => {
        const nextNode = arrow.nextElementSibling;
        if (!nextNode || !nextNode.dataset.depth) return;
        const nextDepth = parseInt(nextNode.dataset.depth);
        const isAllowed = depth >= 0 && nextDepth <= depth;
        arrow.classList.toggle('ss-chain-allowed', isAllowed);
        arrow.classList.toggle('ss-chain-disabled', !isAllowed);
      });
    });

    // Update hidden input
    const input = dialog.querySelector(`.ss-drum-depth-input[data-cat="${catKey}"]`);
    if (input) input.value = depth;
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
    if (!dialog) return;
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
  // Preset management
  // ============================================================================

  _applyPreset(key) {
    const preset = ScoringSettingsModal.getPresets().find(p => p.key === key);
    if (!preset) return;

    // Preserve routing settings across preset changes
    const savedRouting = this.overrides.routing;

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
    if (savedRouting) this.overrides.routing = savedRouting;
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
        if (matches && this.overrides.percussion.drumChannelNonDrumPenalty !== preset.percussion.drumChannelNonDrumPenalty) matches = false;
        if (matches && this.overrides.percussion.nonDrumChannelDrumPenalty !== preset.percussion.nonDrumChannelDrumPenalty) matches = false;
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

    const isModified = this.presetSnapshot && JSON.stringify(this.overrides) !== this.presetSnapshot;

    dialog.querySelectorAll('.ss-preset-chip').forEach(chip => {
      const isActive = chip.dataset.preset === this.activePreset;
      chip.classList.toggle('active', isActive);
      chip.classList.toggle('modified', isActive && isModified);
    });

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
    this.overrides._preset = this.activePreset;
    if (typeof this.onApplyCallback === 'function') {
      this.onApplyCallback(this.overrides);
    }
    this.close();
  }
}

window.ScoringSettingsModal = ScoringSettingsModal;
})();
