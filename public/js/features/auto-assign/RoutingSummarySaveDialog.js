// public/js/features/auto-assign/RoutingSummarySaveDialog.js
// Save-choice dialog for RoutingSummary (P2-F.4b).
//
// Extracted from RoutingSummaryPage._applyRouting — the inline dialog
// factory for "Save as adapted" / "Overwrite original" / "Cancel". Keeps
// the orchestrator (`_applyRouting`) focused on data transformation.
//
// Exposed on `window.RoutingSummarySaveDialog.askSaveChoice({ ... })`.
// Resolves with 'adapted' | 'overwrite' | 'cancel'.

(function() {
  'use strict';

  const _t = (key, params) => (typeof i18n !== 'undefined' ? i18n.t(key, params) : key);

  /**
   * Render the save-choice dialog and return the user's answer.
   *
   * @param {object} opts
   * @param {boolean} [opts.hasSplit]
   * @param {boolean} [opts.hasTransposition]
   * @returns {Promise<'cancel'|'adapted'|'overwrite'>}
   */
  function askSaveChoice(opts = {}) {
    const splitInfo = opts.hasSplit
      ? (_t('routingSummary.splitChannelInfo') || 'Des canaux seront dupliqués pour le multi-instrument.') + ' '
      : '';
    const transposeInfo = opts.hasTransposition
      ? (_t('routingSummary.transposeInfo') || 'Des transpositions seront appliquées.') + ' '
      : '';

    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay rs-save-dialog-overlay';
      overlay.innerHTML = `
        <div class="modal-content rs-save-dialog">
          <div class="modal-header">
            <h2>${_t('routingSummary.saveDialogTitle') || 'Enregistrer le routage'}</h2>
          </div>
          <div class="rs-save-dialog-body">
            <p>${splitInfo}${transposeInfo}${_t('routingSummary.saveDialogMessage') || 'Le fichier MIDI doit être modifié. Comment souhaitez-vous enregistrer ?'}</p>
          </div>
          <div class="rs-save-dialog-buttons">
            <button class="btn" data-action="cancel">${_t('common.cancel') || 'Annuler'}</button>
            <button class="btn btn-primary" data-action="adapted">${_t('routingSummary.saveAsAdapted') || 'Version adaptée'}</button>
            <button class="btn btn-danger" data-action="overwrite">${_t('routingSummary.overwriteOriginal') || 'Écraser l\'original'}</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      overlay.querySelectorAll('[data-action]').forEach((btn) => {
        btn.addEventListener('click', () => {
          overlay.remove();
          resolve(btn.dataset.action);
        });
      });
    });
  }

  window.RoutingSummarySaveDialog = Object.freeze({ askSaveChoice });
})();
