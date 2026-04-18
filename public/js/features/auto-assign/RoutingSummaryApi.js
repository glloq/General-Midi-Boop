// public/js/features/auto-assign/RoutingSummaryApi.js
// API calls used by RoutingSummaryPage, grouped behind a thin facade
// (P2-F.2, plan §11 step 2 — "extraire les accès API").
//
// The original page hit 4 WS commands directly : we hide the command names
// and argument shapes here so future schema migrations (ADR-004) need to
// touch only this file. Exposed on `window.RoutingSummaryApi`.

(function() {
  'use strict';

  /**
   * @param {object} backend - BackendAPIClient instance (must expose sendCommand)
   */
  function RoutingSummaryApi(backend) {
    this.backend = backend;
  }

  /**
   * Ask the server to generate channel → instrument suggestions.
   * @param {object} params
   * @param {string|number} params.fileId
   * @param {object} [params.scoringOverrides]
   * @param {boolean} [params.excludeVirtual=true]
   * @param {number} [params.topN=5]
   * @param {number} [params.minScore=30]
   */
  RoutingSummaryApi.prototype.generateSuggestions = function(params) {
    const overrides = params.scoringOverrides || {};
    return this.backend.sendCommand('generate_assignment_suggestions', {
      fileId: params.fileId,
      topN: params.topN != null ? params.topN : 5,
      minScore: params.minScore != null ? params.minScore : 30,
      excludeVirtual: params.excludeVirtual !== false,
      includeMatrix: params.includeMatrix === true,
      scoringOverrides: {
        ...overrides,
        splitting: { ...(overrides.splitting || {}), triggerBelowScore: 0 }
      }
    });
  };

  /**
   * Read the persisted routings for a file.
   * @param {string|number} fileId
   */
  RoutingSummaryApi.prototype.getSavedRoutings = function(fileId) {
    return this.backend.sendCommand('get_file_routings', { fileId });
  };

  /**
   * Fetch the MIDI payload for preview purposes.
   * @param {string|number} fileId
   */
  RoutingSummaryApi.prototype.readFile = function(fileId) {
    return this.backend.sendCommand('file_read', { fileId });
  };

  /**
   * Apply a set of assignments (normal or split) to a file, optionally
   * creating an adapted copy.
   */
  RoutingSummaryApi.prototype.applyAssignments = function(params) {
    return this.backend.sendCommand('apply_assignments', {
      originalFileId: params.originalFileId,
      assignments: params.assignments,
      createAdaptedFile: params.createAdaptedFile === true,
      overwriteOriginal: params.overwriteOriginal === true
    });
  };

  window.RoutingSummaryApi = RoutingSummaryApi;
})();
