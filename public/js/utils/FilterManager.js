/**
 * FilterManager - Manages MIDI file filtering state and operations
 *
 * Handles:
 * - Filter state management
 * - Client-side and server-side filtering
 * - Filter presets (save/load from localStorage)
 * - Debouncing for text inputs
 * - Filter cache
 */
class FilterManager {
  constructor(apiClient) {
    this.api = apiClient;

    // Current filter state
    this.filters = this.getDefaultFilters();

    // Filter cache: key -> results
    this.cache = new Map();
    this.cacheMaxSize = 20;

    // Debounce timers
    this.debounceTimers = {};

    // Callbacks
    this.onFilterChange = null;
    this.onFilterApplied = null;

    // Load presets from localStorage
    this.presets = this.loadPresets();
  }

  /**
   * Get default empty filters
   */
  getDefaultFilters() {
    return {
      // Simple filters
      filename: '',
      folder: null,
      includeSubfolders: false,
      durationMin: null,
      durationMax: null,
      tempoMin: null,
      tempoMax: null,
      tracksMin: null,
      tracksMax: null,
      uploadedAfter: null,
      uploadedBefore: null,

      // Advanced filters
      instrumentTypes: [],
      instrumentMode: 'ANY', // 'ANY' | 'ALL' | 'EXACT'
      channelCountMin: null,
      channelCountMax: null,
      hasRouting: null, // null | true | false
      routingStatus: null, // null | 'unrouted' | 'partial' | 'playable' | 'routed_incomplete' | 'auto_assigned' (legacy single)
      routingStatuses: [], // Array of routing statuses for multi-select checkboxes
      playableOnInstruments: [], // Array of instrument IDs
      playableMode: 'routed', // 'routed' | 'compatible'
      isOriginal: null, // null | true | false
      minCompatibilityScore: null,

      // GM instrument filters
      gmInstruments: [], // Specific GM instrument names (e.g., "Acoustic Grand Piano")
      gmCategories: [], // GM categories (e.g., "Piano", "Strings", "Brass")
      gmPrograms: [], // GM program numbers (0-127)
      gmMode: 'ANY', // 'ANY' | 'ALL'

      // Quick filters (boolean)
      hasDrums: null,
      hasMelody: null,
      hasBass: null,
      hasLyrics: null,

      // Sorting
      sortBy: 'uploaded_at',
      sortOrder: 'DESC',

      // Pagination
      limit: null,
      offset: null
    };
  }

  /**
   * Update a filter value
   * @param {string} key - Filter key
   * @param {*} value - Filter value
   * @param {boolean} debounce - Whether to debounce (for text inputs)
   */
  setFilter(key, value, debounce = false) {
    const apply = () => {
      this.filters[key] = value;
      this.invalidateCache();
      this._notifyChange();
    };

    if (debounce) {
      if (this.debounceTimers[key]) {
        clearTimeout(this.debounceTimers[key]);
      }
      this.debounceTimers[key] = setTimeout(apply, 300); // 300ms debounce
    } else {
      apply();
    }
  }

  /**
   * Get current filter value
   */
  getFilter(key) {
    return this.filters[key];
  }

  /**
   * Get all filters
   */
  getFilters() {
    return { ...this.filters };
  }

  /**
   * Fire the onFilterChange callback (if registered) with current filters.
   * @private
   */
  _notifyChange() {
    if (this.onFilterChange) {
      this.onFilterChange(this.filters);
    }
  }

  /**
   * Reset all filters to default
   */
  resetFilters() {
    this.filters = this.getDefaultFilters();
    this.invalidateCache();
    this._notifyChange();
  }

  /**
   * Reset a specific filter
   */
  resetFilter(key) {
    this.filters[key] = this.getDefaultFilters()[key];
    this.invalidateCache();
    this._notifyChange();
  }

  /**
   * Iterate filters that differ from their default, skipping the
   * sorting/pagination meta-fields that control display rather than
   * filtering. Calls `cb(key, value)` for each active filter; if `cb`
   * returns true, iteration stops early and the call returns true.
   * @private
   */
  _forEachActiveFilter(cb) {
    const defaults = this.getDefaultFilters();
    const excludeKeys = new Set([
      'sortBy',
      'sortOrder',
      'limit',
      'offset',
      'instrumentMode',
      'gmMode',
      'playableMode'
    ]);

    for (const key in this.filters) {
      if (excludeKeys.has(key)) continue;

      const value = this.filters[key];
      const isActive = Array.isArray(value)
        ? value.length > 0
        : value !== defaults[key] && value !== null && value !== '';

      if (isActive && cb(key, value) === true) return true;
    }
    return false;
  }

  /**
   * Check if any filters are active (excludes sorting/pagination meta-fields)
   */
  hasActiveFilters() {
    return this._forEachActiveFilter(() => true);
  }

  /**
   * Get list of active filters (for display, excludes sorting/pagination)
   */
  getActiveFilters() {
    const active = [];
    this._forEachActiveFilter((key, value) => {
      active.push({ key, value, label: this.getFilterLabel(key, value) });
    });
    return active;
  }

  /**
   * Get human-readable label for a filter
   */
  getFilterLabel(key, value) {
    const t = (k, params) => (window.i18n ? window.i18n.t(k, params) : k);
    // Range filters share one builder: default min→0, default max→'∞'.
    const range = (labelKey, minKey, maxKey, fmt = (v) => v) => {
      const min = this.filters[minKey] || 0;
      const max = this.filters[maxKey] || '∞';
      return t(labelKey, {
        min: fmt(min),
        max: max === '∞' ? '∞' : fmt(max)
      });
    };
    switch (key) {
      case 'filename':
        return t('filters.labelName', { value });
      case 'folder':
        return t('filters.labelFolder', { value });
      case 'durationMin':
      case 'durationMax':
        return range('filters.labelDuration', 'durationMin', 'durationMax', (v) =>
          this.formatDuration(v)
        );
      case 'tempoMin':
      case 'tempoMax':
        return range('filters.labelTempo', 'tempoMin', 'tempoMax');
      case 'tracksMin':
      case 'tracksMax':
        return range('filters.labelTracks', 'tracksMin', 'tracksMax');
      case 'instrumentTypes':
        return t('filters.labelInstruments', {
          value: value.join(', '),
          mode: this.filters.instrumentMode
        });
      case 'channelCountMin':
      case 'channelCountMax':
        return range('filters.labelChannels', 'channelCountMin', 'channelCountMax');
      case 'hasRouting':
        return value ? t('filters.labelRouted') : t('filters.labelUnrouted');
      case 'routingStatus':
      case 'routingStatuses': {
        const statusLabels = {
          unrouted: t('filters.routingUnrouted'),
          partial: t('filters.routingPartial'),
          routed_incomplete: t('filters.routingRoutedIncomplete'),
          playable: t('filters.routingPlayable'),
          auto_assigned: t('filters.routingAutoAssigned')
        };
        const status = Array.isArray(value)
          ? value.map((s) => statusLabels[s] || s).join(', ')
          : statusLabels[value] || value;
        return t('filters.labelRoutingStatus', { status });
      }
      case 'playableOnInstruments':
        return t('filters.labelPlayableOn', {
          count: value.length,
          mode: this.filters.playableMode
        });
      case 'isOriginal':
        return value ? t('filters.labelOriginals') : t('filters.labelAdapted');
      case 'hasDrums':
        return value ? t('filters.labelWithDrums') : t('filters.labelWithoutDrums');
      case 'hasMelody':
        return value ? t('filters.labelWithMelody') : t('filters.labelWithoutMelody');
      case 'hasBass':
        return value ? t('filters.labelWithBass') : t('filters.labelWithoutBass');
      case 'hasLyrics':
        return value ? t('filters.labelWithLyrics') : t('filters.labelWithoutLyrics');
      case 'gmInstruments':
        return t('filters.labelGmInstruments', {
          value: value.join(', '),
          mode: this.filters.gmMode
        });
      case 'gmCategories':
        return t('filters.labelGmCategories', {
          value: value.join(', '),
          mode: this.filters.gmMode
        });
      case 'gmPrograms':
        return t('filters.labelGmPrograms', { value: value.join(', ') });
      case 'uploadedAfter':
      case 'uploadedBefore':
        return t('filters.labelDate', {
          from: this.filters.uploadedAfter || '',
          to: this.filters.uploadedBefore || ''
        });
      default:
        return `${key}: ${value}`;
    }
  }

  /**
   * Format duration in MM:SS
   */
  formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Apply filters - determines if client or server filtering
   * @param {Array} files - All files (for client-side filtering)
   * @returns {Promise<Array>} - Filtered files
   */
  async applyFilters(files = null) {
    // Use server-side filtering when no local file list is provided,
    // or when advanced filters require server queries
    if (!files || this.needsServerFiltering()) {
      return await this.applyServerFilters();
    } else {
      return this.applyClientFilters(files);
    }
  }

  /**
   * Check if we need server-side filtering
   */
  needsServerFiltering() {
    // Server-side needed for:
    // - Instrument type filters
    // - Routing status
    // - Compatibility score
    // - Advanced metadata not loaded client-side

    return (
      (this.filters.instrumentTypes && this.filters.instrumentTypes.length > 0) ||
      (this.filters.gmInstruments && this.filters.gmInstruments.length > 0) ||
      (this.filters.gmCategories && this.filters.gmCategories.length > 0) ||
      (this.filters.gmPrograms && this.filters.gmPrograms.length > 0) ||
      this.filters.hasRouting !== null ||
      this.filters.routingStatus !== null ||
      (this.filters.routingStatuses && this.filters.routingStatuses.length > 0) ||
      (this.filters.playableOnInstruments && this.filters.playableOnInstruments.length > 0) ||
      this.filters.minCompatibilityScore !== null ||
      this.filters.channelCountMin !== null ||
      this.filters.channelCountMax !== null ||
      this.filters.hasDrums !== null ||
      this.filters.hasMelody !== null ||
      this.filters.hasBass !== null ||
      this.filters.hasLyrics !== null
    );
  }

  /**
   * Apply filters server-side via API
   */
  async applyServerFilters() {
    // Check cache
    const cacheKey = this.getCacheKey();
    if (this.cache.has(cacheKey)) {
      console.log('[FilterManager] Using cached results');
      const cached = this.cache.get(cacheKey);
      if (this.onFilterApplied) {
        this.onFilterApplied(cached, true);
      }
      return cached;
    }

    console.log('[FilterManager] Applying server-side filters', this.filters);

    try {
      const response = await this.api.sendCommand('file_filter', this.filters);

      if (response.success) {
        const results = response.files || [];

        // Cache results
        this.addToCache(cacheKey, results);

        if (this.onFilterApplied) {
          this.onFilterApplied(results, false);
        }

        return results;
      } else {
        throw new Error('Filter request failed');
      }
    } catch (error) {
      console.error('[FilterManager] Server filter failed:', error);
      throw error;
    }
  }

  /**
   * Apply filters client-side (for simple filters)
   */
  applyClientFilters(files) {
    if (!files || files.length === 0) {
      return [];
    }

    console.log('[FilterManager] Applying client-side filters to', files.length, 'files');

    let filtered = files.filter((file) => {
      // Filename filter
      if (this.filters.filename) {
        if (!file.filename.toLowerCase().includes(this.filters.filename.toLowerCase())) {
          return false;
        }
      }

      // Folder filter
      if (this.filters.folder) {
        const fileFolder = file.folder || '/';
        if (this.filters.includeSubfolders) {
          // Require a path-separator boundary so folder "/Rock" matches
          // "/Rock" and "/Rock/sub" but NOT sibling "/Rockabilly".
          const base = this.filters.folder;
          const baseWithSep = base.endsWith('/') ? base : base + '/';
          if (fileFolder !== base && !fileFolder.startsWith(baseWithSep)) {
            return false;
          }
        } else {
          if (fileFolder !== this.filters.folder) {
            return false;
          }
        }
      }

      // Duration filter
      if (this.filters.durationMin !== null && file.duration < this.filters.durationMin) {
        return false;
      }
      if (this.filters.durationMax !== null && file.duration > this.filters.durationMax) {
        return false;
      }

      // Tempo filter
      if (this.filters.tempoMin !== null && file.tempo < this.filters.tempoMin) {
        return false;
      }
      if (this.filters.tempoMax !== null && file.tempo > this.filters.tempoMax) {
        return false;
      }

      // Track count filter
      if (this.filters.tracksMin !== null && file.tracks < this.filters.tracksMin) {
        return false;
      }
      if (this.filters.tracksMax !== null && file.tracks > this.filters.tracksMax) {
        return false;
      }

      // Upload date filter (DB column is uploaded_at)
      if (this.filters.uploadedAfter && file.uploaded_at < this.filters.uploadedAfter) {
        return false;
      }
      if (this.filters.uploadedBefore && file.uploaded_at > this.filters.uploadedBefore) {
        return false;
      }

      // Is original filter
      if (this.filters.isOriginal !== null) {
        if (this.filters.isOriginal && !file.is_original) {
          return false;
        }
        if (!this.filters.isOriginal && file.is_original) {
          return false;
        }
      }

      return true;
    });

    // Apply sorting
    filtered = this.sortFiles(filtered);

    if (this.onFilterApplied) {
      this.onFilterApplied(filtered, true);
    }

    return filtered;
  }

  /**
   * Sort files based on current sort settings
   */
  sortFiles(files) {
    const sortBy = this.filters.sortBy || 'uploaded_at';
    const sortOrder = this.filters.sortOrder || 'DESC';

    const sorted = [...files].sort((a, b) => {
      let aVal = a[sortBy];
      let bVal = b[sortBy];

      // Handle undefined values
      if (aVal === undefined) aVal = 0;
      if (bVal === undefined) bVal = 0;

      // String comparison
      if (typeof aVal === 'string') {
        return sortOrder === 'ASC' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }

      // Numeric comparison
      return sortOrder === 'ASC' ? aVal - bVal : bVal - aVal;
    });

    return sorted;
  }

  /**
   * Generate cache key from current filters
   */
  getCacheKey() {
    return JSON.stringify(this.filters);
  }

  /**
   * Add results to cache (LRU)
   */
  addToCache(key, results) {
    // Remove oldest if cache is full
    if (this.cache.size >= this.cacheMaxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(key, results);
  }

  /**
   * Invalidate cache
   */
  invalidateCache() {
    this.cache.clear();
  }

  // ==================== PRESETS ====================

  /**
   * Save current filters as a preset
   */
  savePreset(name) {
    const preset = {
      name: name,
      filters: JSON.parse(JSON.stringify(this.filters))
    };

    this.presets.push(preset);
    this.savePresetsToStorage();

    return preset;
  }

  /**
   * Load a preset
   */
  loadPreset(name) {
    const preset = this.presets.find((p) => p.name === name);
    if (preset) {
      // Merge over defaults so presets saved before a filter key existed
      // come back with that key defaulted instead of missing.
      this.filters = {
        ...this.getDefaultFilters(),
        ...JSON.parse(JSON.stringify(preset.filters))
      };
      this.invalidateCache();
      this._notifyChange();
      return true;
    }
    return false;
  }

  /**
   * Delete a preset
   */
  deletePreset(name) {
    const index = this.presets.findIndex((p) => p.name === name);
    if (index >= 0) {
      this.presets.splice(index, 1);
      this.savePresetsToStorage();
      return true;
    }
    return false;
  }

  /**
   * Get all presets
   */
  getPresets() {
    return [...this.presets];
  }

  /**
   * Load presets from localStorage
   */
  loadPresets() {
    try {
      const stored = localStorage.getItem('midiFilterPresets');
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (error) {
      console.error('[FilterManager] Failed to load presets:', error);
    }
    return [];
  }

  /**
   * Save presets to localStorage
   */
  savePresetsToStorage() {
    try {
      localStorage.setItem('midiFilterPresets', JSON.stringify(this.presets));
    } catch (error) {
      console.error('[FilterManager] Failed to save presets:', error);
    }
  }

  // ==================== QUICK FILTERS ====================

  /**
   * Apply a quick filter (preset filters for common use cases)
   */
  applyQuickFilter(name) {
    // Reset to defaults without triggering notifications
    this.filters = this.getDefaultFilters();
    this.invalidateCache();

    // GM-category quick filters all share { gmCategories, gmMode: 'ANY' }.
    const GM_CATEGORY_FILTERS = {
      piano: ['Piano'],
      guitar: ['Guitar'],
      strings: ['Strings', 'Ensemble'],
      brass: ['Brass'],
      woodwinds: ['Reed', 'Pipe'],
      synth: ['Synth Lead', 'Synth Pad', 'Synth Effects']
    };

    if (GM_CATEGORY_FILTERS[name]) {
      this.filters.gmCategories = GM_CATEGORY_FILTERS[name];
      this.filters.gmMode = 'ANY';
    } else {
      switch (name) {
        case 'recent': {
          const oneWeekAgo = new Date();
          oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
          this.filters.uploadedAfter = oneWeekAgo.toISOString();
          break;
        }

        case 'short':
          this.filters.durationMax = 60;
          break;

        case 'routed':
          this.filters.hasRouting = true;
          break;

        case 'current-folder':
          // Set by caller with actual folder
          break;

        default:
          console.warn('[FilterManager] Unknown quick filter:', name);
      }
    }

    // Single notification after all changes
    this._notifyChange();
  }

  /**
   * Cleanup timers and references
   */
  destroy() {
    // Clear all debounce timers
    for (const key in this.debounceTimers) {
      clearTimeout(this.debounceTimers[key]);
    }
    this.debounceTimers = {};
    this.cache.clear();
    this.onFilterChange = null;
    this.onFilterApplied = null;
  }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FilterManager;
}
