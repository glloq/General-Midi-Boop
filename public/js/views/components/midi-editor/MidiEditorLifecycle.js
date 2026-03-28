// ============================================================================
// Fichier: public/js/views/components/midi-editor/MidiEditorLifecycle.js
// Description: Close, cleanup, and lifecycle management
//   Mixin: methodes ajoutees au prototype de MidiEditorModal
// ============================================================================

(function() {
    'use strict';

    const MidiEditorLifecycleMixin = {};

    // ========================================================================
    // FERMETURE
    // ========================================================================

    /**
    * Fermer la modale
    */
    MidiEditorLifecycleMixin.close = function() {
        console.log('[MidiEditor] close() called, isDirty:', this.isDirty);

    // Vérifier les modifications non sauvegardées
        if (this.isDirty) {
            console.log('[MidiEditor] Has unsaved changes, showing modal');
            this.showUnsavedChangesModal();
            return;
        }

        console.log('[MidiEditor] No unsaved changes, closing directly');
        this.doClose();
    }

    /**
    * Afficher la modal de confirmation pour modifications non sauvegardées
    */
    MidiEditorLifecycleMixin.showUnsavedChangesModal = function() {
        console.log('[MidiEditor] Showing unsaved changes modal');

    // Créer la modal de confirmation
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
                        ${this.t('midiEditor.unsavedChanges.title')}
                    </h2>
                </div>

                <div style="margin-bottom: 24px; color: ${dlgTextColor}; line-height: 1.6; font-family: sans-serif;">
                    <p style="margin: 0 0 12px 0;">
                        ${this.t('midiEditor.unsavedChanges.message')}
                    </p>
                    <p style="margin: 0; font-weight: bold; color: ${dlgWarnColor};">
                        ${this.t('midiEditor.unsavedChanges.warning')}
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
                        ↩️ ${this.t('midiEditor.unsavedChanges.cancel')}
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
                        💾 ${this.t('midiEditor.unsavedChanges.saveAndClose')}
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
                        🗑️ ${this.t('midiEditor.unsavedChanges.closeWithoutSave')}
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(confirmModal);
        console.log('[MidiEditor] Modal appended to body');

    // Fermer avec Escape
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                console.log('[MidiEditor] Escape pressed in modal');
                confirmModal.remove();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);

    // Bouton Annuler
        const cancelBtn = confirmModal.querySelector('#unsaved-cancel-btn');
        cancelBtn.addEventListener('click', () => {
            console.log('[MidiEditor] Cancel clicked');
            document.removeEventListener('keydown', escHandler);
            confirmModal.remove();
        });

    // Bouton Sauvegarder et fermer
        const saveBtn = confirmModal.querySelector('#unsaved-save-btn');
        saveBtn.addEventListener('click', async () => {
            console.log('[MidiEditor] Save and close clicked');
            document.removeEventListener('keydown', escHandler);
            confirmModal.remove();
            await this.saveMidiFile();
    // Fermer après la sauvegarde
            this.doClose();
        });

    // Bouton Fermer sans sauvegarder
        const discardBtn = confirmModal.querySelector('#unsaved-discard-btn');
        discardBtn.addEventListener('click', () => {
            console.log('[MidiEditor] Discard and close clicked');
            document.removeEventListener('keydown', escHandler);
            confirmModal.remove();
            this.doClose();
        });
    }

    /**
    * Effectuer la fermeture réelle de l'éditeur
    */
    MidiEditorLifecycleMixin.doClose = function() {
    // Clean up channel settings popover (now in document.body)
        this._closeChannelSettingsPopover();

    // Unsubscribe from locale changes
        if (this.localeUnsubscribe) {
            this.localeUnsubscribe();
            this.localeUnsubscribe = null;
        }

    // Arrêter la synchronisation des sliders
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
        }

    // Nettoyer le piano roll
        if (this.pianoRoll) {
            this.pianoRoll.remove();
            this.pianoRoll = null;
        }

    // Nettoyer la barre de navigation overview
        if (this.navigationBar) {
            this.navigationBar.destroy();
            this.navigationBar = null;
        }

    // Nettoyer la barre de timeline
        if (this.timelineBar) {
            this.timelineBar.destroy();
            this.timelineBar = null;
        }

    // Nettoyer l'éditeur CC/Pitchbend
        if (this.ccEditor) {
            this.ccEditor.destroy();
            this.ccEditor = null;
        }
        this.ccEvents = [];
        this.ccSectionExpanded = false;
        this.currentCCType = 'cc1';
        this._ccChannelDelegationAttached = false;

    // Nettoyer l'éditeur de vélocité
        if (this.velocityEditor) {
            this.velocityEditor.destroy();
            this.velocityEditor = null;
        }

    // Nettoyer l'éditeur de tempo
        if (this.tempoEditor) {
            this.tempoEditor.destroy();
            this.tempoEditor = null;
        }
        this.tempoEvents = [];

    // Nettoyer l'éditeur de tablature
        if (this.tablatureEditor) {
            this.tablatureEditor.destroy();
            this.tablatureEditor = null;
        }

    // Nettoyer l'éditeur de pattern percussion
        if (this.drumPatternEditor) {
            this.drumPatternEditor.destroy();
            this.drumPatternEditor = null;
        }

    // Nettoyer l'éditeur d'instruments à vent
        if (this.windInstrumentEditor) {
            this.windInstrumentEditor.destroy();
            this.windInstrumentEditor = null;
        }

    // Nettoyer le synthétiseur
        this.disposeSynthesizer();

    // Retirer les listeners de resize drag
        if (this._resizeDoResize) {
            document.removeEventListener('mousemove', this._resizeDoResize);
            document.removeEventListener('mouseup', this._resizeStopResize);
            this._resizeDoResize = null;
            this._resizeStopResize = null;
        }

    // Retirer l'événement escape
        if (this.escapeHandler) {
            document.removeEventListener('keydown', this.escapeHandler);
            this.escapeHandler = null;
        }

    // Retirer les raccourcis clavier
        if (this.keyboardHandler) {
            document.removeEventListener('keydown', this.keyboardHandler);
            this.keyboardHandler = null;
        }

    // Retirer le gestionnaire beforeunload
        this.removeBeforeUnloadHandler();

    // Unsubscribe from external routing changes
        if (this.eventBus && this._onExternalRoutingChanged) {
            this.eventBus.off('routing:changed', this._onExternalRoutingChanged);
            this._onExternalRoutingChanged = null;
        }

    // Nettoyer l'historique du piano roll
        if (this.pianoRoll && typeof this.pianoRoll.clearHistory === 'function') {
            this.pianoRoll.clearHistory();
        }

    // Retirer le conteneur
        if (this.container) {
            this.container.remove();
            this.container = null;
        }

        this.isOpen = false;
        this.currentFile = null;
        this.currentFilename = null;
        this.midiData = null;
        this.isDirty = false;
        this.sequence = [];
        this.fullSequence = [];
        this.activeChannels.clear();
        this.channels = [];
        this.clipboard = [];

    // Émettre événement
        if (this.eventBus) {
            this.eventBus.emit('midi_editor:closed', {});
        }
    }

    /**
    * Installer le gestionnaire beforeunload pour avertir l'utilisateur
    * s'il tente de fermer la page/onglet avec des modifications non sauvegardées
    */
    MidiEditorLifecycleMixin.setupBeforeUnloadHandler = function() {
        this.beforeUnloadHandler = (e) => {
            if (this.isDirty) {
    // Message standard du navigateur
                e.preventDefault();
                e.returnValue = ''; // Requis pour Chrome
                return ''; // Pour les navigateurs plus anciens
            }
        };
        window.addEventListener('beforeunload', this.beforeUnloadHandler);
    }

    /**
    * Retirer le gestionnaire beforeunload
    */
    MidiEditorLifecycleMixin.removeBeforeUnloadHandler = function() {
        if (this.beforeUnloadHandler) {
            window.removeEventListener('beforeunload', this.beforeUnloadHandler);
            this.beforeUnloadHandler = null;
        }
    }

    // ========================================================================
    // UTILITAIRES
    // ========================================================================

    MidiEditorLifecycleMixin.showNotification = function(message, type = 'info') {
        if (window.app?.notifications) {
            window.app.notifications.show('Éditeur MIDI', message, type, 3000);
        } else {
            this.log('info', message);
        }
    }

    MidiEditorLifecycleMixin.showError = function(message) {
        this.showErrorModal(message);
    }

    MidiEditorLifecycleMixin.showErrorModal = function(message, title = null) {
        title = title || this.t('common.error');
        this.log('error', message);
        this.showConfirmModal({
            title: title,
            message: message,
            icon: '❌',
            confirmText: 'OK',
            confirmClass: 'primary',
            cancelText: ''
        }).catch(() => {});
    }

    MidiEditorLifecycleMixin.log = function(level, ...args) {
        const prefix = '[MidiEditorModal]';
        if (typeof this.logger[level] === 'function') {
            this.logger[level](prefix, ...args);
        } else {
            console[level](prefix, ...args);
        }
    }

    if (typeof window !== 'undefined') {
        window.MidiEditorLifecycleMixin = MidiEditorLifecycleMixin;
    }
})();
