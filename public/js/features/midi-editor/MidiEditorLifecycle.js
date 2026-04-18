// ============================================================================
// File: public/js/features/midi-editor/MidiEditorLifecycle.js
// Description: Modal lifecycle hooks (close, unsaved-changes guard, logging,
//   notifications, error modal, beforeunload wiring).
//   Sub-component class ; in practice reachable through the modal instance
//   methods below (`modal.log`, `modal.close`, `modal.showNotification`, ...)
//   that forward to this facade (see MidiEditorModal.js).
//   (P2-F.10l body rewrite — no longer a prototype mixin.)
// ============================================================================

(function() {
    'use strict';

    class MidiEditorLifecycle {
        constructor(modal) {
            this.modal = modal;
        }

    close() {
        this.log('debug', `close() called, isDirty: ${this.modal.isDirty}`);

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
            await this.modal.fileOps.saveMidiFile();
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
    // Clean up channel settings popover (now in document.body)
        this.modal.tablatureOps._closeChannelSettingsPopover();

    // Unsubscribe from locale changes
        if (this.modal.localeUnsubscribe) {
            this.modal.localeUnsubscribe();
            this.modal.localeUnsubscribe = null;
        }

    // Stop viewport synchronization
        if (this.modal.pianoRoll && this.modal._viewportChangeHandler) {
            this.modal.pianoRoll.removeEventListener('viewportchange', this.modal._viewportChangeHandler);
            this.modal._viewportChangeHandler = null;
        }
        // Fallback: clear legacy polling interval if still present
        if (this.modal.syncInterval) {
            clearInterval(this.modal.syncInterval);
            this.modal.syncInterval = null;
        }

    // Nettoyer le piano roll
        if (this.modal.pianoRoll) {
            this.modal.pianoRoll.remove();
            this.modal.pianoRoll = null;
        }

    // Nettoyer la barre de navigation overview
        if (this.modal.navigationBar) {
            this.modal.navigationBar.destroy();
            this.modal.navigationBar = null;
        }

    // Nettoyer la barre de timeline
        if (this.modal.timelineBar) {
            this.modal.timelineBar.destroy();
            this.modal.timelineBar = null;
        }

    // Clean up the CC/pitch-bend editor
        if (this.modal.ccEditor) {
            this.modal.ccEditor.destroy();
            this.modal.ccEditor = null;
        }
        this.modal.ccEvents = [];
        this.modal.ccSectionExpanded = false;
        this.modal.currentCCType = 'cc1';
        this.modal._ccChannelDelegationAttached = false;

    // Clean up the velocity editor
        if (this.modal.velocityEditor) {
            this.modal.velocityEditor.destroy();
            this.modal.velocityEditor = null;
        }

    // Clean up the tempo editor
        if (this.modal.tempoEditor) {
            this.modal.tempoEditor.destroy();
            this.modal.tempoEditor = null;
        }
        this.modal.tempoEvents = [];

    // Clean up the tablature editor
        if (this.modal.tablatureEditor) {
            this.modal.tablatureEditor.destroy();
            this.modal.tablatureEditor = null;
        }

    // Clean up the drum-pattern editor
        if (this.modal.drumPatternEditor) {
            this.modal.drumPatternEditor.destroy();
            this.modal.drumPatternEditor = null;
        }

    // Clean up the wind-instrument editor
        if (this.modal.windInstrumentEditor) {
            this.modal.windInstrumentEditor.destroy();
            this.modal.windInstrumentEditor = null;
        }

    // Clean up the synthesizer
        this.modal.disposeSynthesizer();

    // Retirer les listeners de resize drag
        if (this.modal._resizeDoResize) {
            document.removeEventListener('mousemove', this.modal._resizeDoResize);
            document.removeEventListener('mouseup', this.modal._resizeStopResize);
            this.modal._resizeDoResize = null;
            this.modal._resizeStopResize = null;
        }

    // Remove the escape listener
        if (this.modal.escapeHandler) {
            document.removeEventListener('keydown', this.modal.escapeHandler);
            this.modal.escapeHandler = null;
        }

    // Retirer les raccourcis clavier
        if (this.modal.keyboardHandler) {
            document.removeEventListener('keydown', this.modal.keyboardHandler);
            this.modal.keyboardHandler = null;
        }

    // Retirer le gestionnaire beforeunload
        this.removeBeforeUnloadHandler();

    // Unsubscribe from external routing changes
        if (this.modal.eventBus && this.modal._onExternalRoutingChanged) {
            this.modal.eventBus.off('routing:changed', this.modal._onExternalRoutingChanged);
            this.modal._onExternalRoutingChanged = null;
        }

    // Nettoyer l'historique du piano roll
        if (this.modal.pianoRoll && typeof this.modal.pianoRoll.clearHistory === 'function') {
            this.modal.pianoRoll.clearHistory();
        }

    // Retirer le conteneur
        if (this.modal.container) {
            this.modal.container.remove();
            this.modal.container = null;
        }

        this.modal.isOpen = false;
        this.modal.currentFile = null;
        this.modal.currentFilename = null;
        this.modal.midiData = null;
        this.modal.isDirty = false;
        this.modal.sequence = [];
        this.modal.fullSequence = [];
        this.modal.activeChannels.clear();
        this.modal.channels = [];
        this.modal.clipboard = [];

    // Emit event
        if (this.modal.eventBus) {
            this.modal.eventBus.emit('midi_editor:closed', {});
        }
    }

    setupBeforeUnloadHandler() {
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
            window.app.notifications.show('Éditeur MIDI', message, type, 3000);
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
        this.modal.dialogs.showConfirmModal({
            title: title,
            message: message,
            icon: '❌',
            confirmText: 'OK',
            confirmClass: 'primary',
            cancelText: ''
        }).catch(() => {});
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
