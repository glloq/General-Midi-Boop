// ============================================================================
// File: public/js/features/midi-editor/MidiEditorLifecycle.js
// Description: Modal lifecycle hooks (close, unsaved-changes guard, logging,
//   notifications, error modal, beforeunload wiring).
//   Sub-component class ; in practice reachable through the modal instance
//   methods below (`modal.log`, `modal.close`, `modal.showNotification`, ...)
//   that forward to this facade (see MidiEditorModal.js).
//   (P2-F.10l body rewrite — no longer a prototype mixin.)
// ============================================================================

(function () {
  'use strict';

  class MidiEditorLifecycle {
    constructor(modal) {
      this.modal = modal;
    }

    close() {
      this.log('debug', `close() called, isDirty: ${this.modal.isDirty}`);

      // Prevent a second unsaved-changes dialog while one is already visible,
      // or while a "save and close" async save is in progress.
      if (document.querySelector('.unsaved-changes-modal') || this.modal._isSavingAndClosing) {
        return;
      }

      // Check for unsaved changes
      if (this.modal.isDirty) {
        this.log('debug', 'Has unsaved changes, showing modal');
        this.showUnsavedChangesModal();
        return;
      }

      this.log('debug', 'No unsaved changes, closing directly');
      this.doClose();
    }

    showUnsavedChangesModal() {
      this.log('debug', 'Showing unsaved changes modal');

      // Create the confirmation modal
      const confirmModal = document.createElement('div');
      confirmModal.className = 'modal-overlay unsaved-changes-modal';
      confirmModal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 10003 !important;
        `;

      const isDark = document.body.classList.contains('dark-mode');
      const dlgBg = isDark ? '#2a2a2a' : '#ffffff';
      const dlgBorder = isDark ? '#ff6b6b' : '#ef476f';
      const dlgShadow = isDark ? '0 4px 20px rgba(0,0,0,0.5)' : '0 4px 20px rgba(102,126,234,0.2)';
      const dlgTextColor = isDark ? '#ddd' : '#2d3561';
      const dlgWarnColor = isDark ? '#ff6b6b' : '#ef476f';
      const cancelBg = isDark ? '#444' : '#e8eeff';
      const cancelBorder = isDark ? '#666' : '#d4daff';
      const cancelColor = isDark ? '#fff' : '#2d3561';
      const saveBg = isDark ? '#4CAF50' : '#06d6a0';
      const discardBg = isDark ? '#f44336' : '#ef476f';

      confirmModal.innerHTML = `
            <div class="modal-dialog" style="
                background: ${dlgBg};
                border: 2px solid ${dlgBorder};
                border-radius: 8px;
                padding: 24px;
                max-width: 500px;
                box-shadow: ${dlgShadow};
            ">
                <div style="display: flex; align-items: center; margin-bottom: 16px;">
                    <span style="font-size: 32px; margin-right: 12px;">⚠️</span>
                    <h2 style="margin: 0; color: ${dlgWarnColor}; font-size: 20px; font-family: sans-serif;">
                        ${this.modal.t('midiEditor.unsavedChanges.title')}
                    </h2>
                </div>

                <div style="margin-bottom: 24px; color: ${dlgTextColor}; line-height: 1.6; font-family: sans-serif;">
                    <p style="margin: 0 0 12px 0;">
                        ${this.modal.t('midiEditor.unsavedChanges.message')}
                    </p>
                    <p style="margin: 0; font-weight: bold; color: ${dlgWarnColor};">
                        ${this.modal.t('midiEditor.unsavedChanges.warning')}
                    </p>
                </div>

                <div style="display: flex; gap: 12px; justify-content: flex-end; flex-wrap: wrap;">
                    <button id="unsaved-cancel-btn" style="
                        padding: 10px 20px;
                        border: 1px solid ${cancelBorder};
                        border-radius: 4px;
                        background: ${cancelBg};
                        color: ${cancelColor};
                        cursor: pointer;
                        font-size: 14px;
                        font-family: sans-serif;
                    ">
                        ↩️ ${this.modal.t('midiEditor.unsavedChanges.cancel')}
                    </button>
                    <button id="unsaved-save-btn" style="
                        padding: 10px 20px;
                        border: 1px solid ${saveBg};
                        border-radius: 4px;
                        background: ${saveBg};
                        color: #fff;
                        cursor: pointer;
                        font-size: 14px;
                        font-weight: bold;
                        font-family: sans-serif;
                    ">
                        💾 ${this.modal.t('midiEditor.unsavedChanges.saveAndClose')}
                    </button>
                    <button id="unsaved-discard-btn" style="
                        padding: 10px 20px;
                        border: 1px solid ${discardBg};
                        border-radius: 4px;
                        background: ${discardBg};
                        color: #fff;
                        cursor: pointer;
                        font-size: 14px;
                        font-family: sans-serif;
                    ">
                        🗑️ ${this.modal.t('midiEditor.unsavedChanges.closeWithoutSave')}
                    </button>
                </div>
            </div>
        `;

      document.body.appendChild(confirmModal);
      this.log('debug', 'Modal appended to body');

      // Fermer avec Escape
      const escHandler = (e) => {
        if (e.key === 'Escape') {
          this.log('debug', 'Escape pressed in modal');
          confirmModal.remove();
          document.removeEventListener('keydown', escHandler);
        }
      };
      document.addEventListener('keydown', escHandler);

      // Bouton Annuler
      const cancelBtn = confirmModal.querySelector('#unsaved-cancel-btn');
      cancelBtn.addEventListener('click', () => {
        this.log('debug', 'Cancel clicked');
        document.removeEventListener('keydown', escHandler);
        confirmModal.remove();
      });

      // Bouton Sauvegarder et fermer
      const saveBtn = confirmModal.querySelector('#unsaved-save-btn');
      saveBtn.addEventListener('click', async () => {
        this.log('debug', 'Save and close clicked');
        document.removeEventListener('keydown', escHandler);
        confirmModal.remove();
        this.modal._isSavingAndClosing = true;
        try {
          await this.modal.fileOps.saveMidiFile();
        } finally {
          this.modal._isSavingAndClosing = false;
        }
        // Close after saving
        this.doClose();
      });

      // Bouton Fermer sans sauvegarder
      const discardBtn = confirmModal.querySelector('#unsaved-discard-btn');
      discardBtn.addEventListener('click', () => {
        this.log('debug', 'Discard and close clicked');
        document.removeEventListener('keydown', escHandler);
        confirmModal.remove();
        this.doClose();
      });
    }

    doClose() {
      // Re-entrancy guard: doClose() may be called a second time if cleanup
      // threw on a previous attempt and the container was left visible.
      if (this.modal._isClosing) {
        this.log('warn', 'doClose() re-entered — skipping duplicate call');
        return;
      }
      this.modal._isClosing = true;

      // Isolate every teardown step: a throw in one (an editor destroy, the
      // popover close, …) must NOT skip the steps after it — above all the synth
      // teardown, which is what actually breaks the app if skipped (notes ring,
      // the transport tick loop leaks, the AudioContext is orphaned, and the
      // singleton keeps isPlaying=true so the next open is broken). Previously
      // all steps shared one try-block, so the first throw jumped past
      // disposeSynthesizer() and the beforeunload removal (audit D M1).
      const m = this.modal;
      const step = (label, fn) => {
        try {
          fn();
        } catch (err) {
          this.log('warn', `Editor cleanup step "${label}" failed (continuing):`, err);
        }
      };

      try {
        step('closeChannelSettingsPopover', () => m.tablatureOps._closeChannelSettingsPopover());

        step('localeUnsubscribe', () => {
          if (m.localeUnsubscribe) {
            m.localeUnsubscribe();
            m.localeUnsubscribe = null;
          }
        });

        step('viewportSync', () => {
          if (m.pianoRollRenderer && m._viewportChangeHandler) {
            m.pianoRollRenderer.off('viewportchange', m._viewportChangeHandler);
            m._viewportChangeHandler = null;
          }
          // Fallback: clear legacy polling interval if still present
          if (m.syncInterval) {
            clearInterval(m.syncInterval);
            m.syncInterval = null;
          }
        });

        step('pianoRollRenderer', () => {
          if (m.pianoRollRenderer) {
            m.pianoRollRenderer.destroy();
            m.pianoRollRenderer = null;
            m.pianoRoll = null;
          }
        });

        step('navigationBar', () => {
          if (m.navigationBar) {
            m.navigationBar.destroy();
            m.navigationBar = null;
          }
        });

        step('pianoRollContainerObs', () => {
          if (m._pianoRollContainerObs) {
            m._pianoRollContainerObs.disconnect();
            m._pianoRollContainerObs = null;
          }
        });

        // Cancel a still-pending background synth warm-up (audit P1.1) so it
        // can't run after teardown and re-create an orphan AudioContext.
        step('warmupCancel', () => {
          if (m._warmupIdleHandle != null && m._warmupIdleCancel) {
            m._warmupIdleCancel(m._warmupIdleHandle);
            m._warmupIdleHandle = null;
          }
        });

        step('timelineBar', () => {
          if (m.timelineBar) {
            m.timelineBar.destroy();
            m.timelineBar = null;
          }
        });

        step('ccEditor', () => {
          if (m.ccEditor) {
            m.ccEditor.destroy();
            m.ccEditor = null;
          }
        });
        m.ccEvents = [];
        m.ccSectionExpanded = false;
        m.currentCCType = 'cc1';
        m._ccChannelDelegationAttached = false;

        step('velocityEditor', () => {
          if (m.velocityEditor) {
            m.velocityEditor.destroy();
            m.velocityEditor = null;
          }
        });

        step('tempoEditor', () => {
          if (m.tempoEditor) {
            m.tempoEditor.destroy();
            m.tempoEditor = null;
          }
        });
        m.tempoEvents = [];

        step('tablatureEditor', () => {
          if (m.tablatureEditor) {
            m.tablatureEditor.destroy();
            m.tablatureEditor = null;
          }
        });

        step('drumPatternEditor', () => {
          if (m.drumPatternEditor) {
            m.drumPatternEditor.destroy();
            m.drumPatternEditor = null;
          }
        });

        step('windInstrumentEditor', () => {
          if (m.windInstrumentEditor) {
            m.windInstrumentEditor.destroy();
            m.windInstrumentEditor = null;
          }
        });

        // Audio teardown — the steps that actually break the app if skipped.
        // Now self-isolated so they run regardless of any editor-destroy throw.
        step('playbackStop', () => m.playbackStop?.());
        step('disposeSynthesizer', () => m.disposeSynthesizer());

        // Resize-drag listeners (mousemove/mouseup on document) are normally
        // detached via the AbortController in detachEvents(); this fallback
        // covers the rare init-order case where attachEvents() hadn't run.
        step('resizeListeners', () => {
          if (m._resizeDoResize) {
            document.removeEventListener('mousemove', m._resizeDoResize);
            document.removeEventListener('mouseup', m._resizeStopResize);
            m._resizeDoResize = null;
            m._resizeStopResize = null;
          }
        });

        step('beforeUnloadHandler', () => this.removeBeforeUnloadHandler());

        step('externalRoutingUnsub', () => {
          if (m.eventBus && m._onExternalRoutingChanged) {
            m.eventBus.off('routing:changed', m._onExternalRoutingChanged);
            m._onExternalRoutingChanged = null;
          }
        });

        // Abort the session-scoped AbortController so any document/window
        // listener registered through getAbortSignal() is detached.
        step('detachEvents', () => m.events?.detachEvents?.());
      } finally {
        // ALWAYS remove the keyboard handler + container and reset ALL session
        // state — including the playback flags, whose omission left the reused
        // singleton showing the wrong transport button next open (audit D M1).
        if (m.keyboardHandler) {
          document.removeEventListener('keydown', m.keyboardHandler);
          m.keyboardHandler = null;
        }

        if (m.container) {
          m.container.remove();
          m.container = null;
        }

        m.isOpen = false;
        m._isClosing = false;
        m.isPlaying = false;
        m.isPaused = false;
        m.playbackStartTick = 0;
        m.playbackEndTick = 0;
        m.currentFile = null;
        m.currentFilename = null;
        m.midiData = null;
        m.isDirty = false;
        m.sequence = [];
        m.fullSequence = [];
        m.activeChannels.clear();
        m.channels = [];
        m.clipboard = [];

        // Emit event
        if (m.eventBus) {
          m.eventBus.emit('midi_editor:closed', {});
        }
      }
    }

    setupBeforeUnloadHandler() {
      // Idempotent: drop any prior handler first. A throwing doClose() can skip
      // its removeBeforeUnloadHandler(), so without this the next show() would
      // stack a second window 'beforeunload' listener on the reused singleton
      // (audit D M3).
      this.removeBeforeUnloadHandler();
      this.modal.beforeUnloadHandler = (e) => {
        if (this.modal.isDirty) {
          // Message standard du navigateur
          e.preventDefault();
          e.returnValue = ''; // Requis pour Chrome
          return ''; // Pour les navigateurs plus anciens
        }
      };
      window.addEventListener('beforeunload', this.modal.beforeUnloadHandler);
    }

    removeBeforeUnloadHandler() {
      if (this.modal.beforeUnloadHandler) {
        window.removeEventListener('beforeunload', this.modal.beforeUnloadHandler);
        this.modal.beforeUnloadHandler = null;
      }
    }

    showNotification(message, type = 'info') {
      if (window.app?.notifications) {
        window.app.notifications.show(this.modal.t('midiEditor.title'), message, type, 3000);
      } else {
        this.log('info', message);
      }
    }

    showError(message) {
      this.showErrorModal(message);
    }

    showErrorModal(message, title = null) {
      title = title || this.modal.t('common.error');
      this.log('error', message);
      this.modal.dialogs
        .showConfirmModal({
          title: title,
          message: message,
          icon: '❌',
          confirmText: 'OK',
          confirmClass: 'primary',
          cancelText: ''
        })
        .catch(() => {});
    }

    log(level, ...args) {
      const prefix = '[MidiEditorModal]';
      if (typeof this.modal.logger[level] === 'function') {
        this.modal.logger[level](prefix, ...args);
      } else {
        console[level](prefix, ...args);
      }
    }
  }

  if (typeof window !== 'undefined') {
    window.MidiEditorLifecycle = MidiEditorLifecycle;
  }
})();
