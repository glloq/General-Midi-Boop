// ============================================================================
// Fichier: public/js/views/components/midi-editor/MidiEditorDialogs.js
// Description: Modern confirmation dialogs
//   Mixin: methodes ajoutees au prototype de MidiEditorModal
// ============================================================================

(function() {
    'use strict';

    const MidiEditorDialogsMixin = {};

    // ========================================================================
    // MODAL DE CONFIRMATION MODERNE
    // ========================================================================

    /**
    * Afficher un modal de confirmation moderne
    * @param {Object} options - Options du modal
    * @param {string} options.title - Titre du modal
    * @param {string} options.message - Message principal
    * @param {string} options.details - Détails supplémentaires (optionnel)
    * @param {string} options.icon - Icône emoji (optionnel, défaut: ⚠️)
    * @param {string} options.confirmText - Texte du bouton de confirmation
    * @param {string} options.cancelText - Texte du bouton d'annulation
    * @param {string} options.confirmClass - Classe CSS pour le bouton de confirmation (primary, danger, success)
    * @param {Array} options.extraButtons - Boutons supplémentaires [{text, class, value}]
    * @returns {Promise<string|boolean>} - Résultat de la confirmation
    */
    MidiEditorDialogsMixin.showConfirmModal = function(options) {
        return new Promise((resolve) => {
            const {
                title = this.t('common.confirm'),
                message = '',
                details = '',
                icon = '⚠️',
                confirmText = this.t('common.confirm'),
                cancelText = this.t('common.cancel'),
                confirmClass = 'primary',
                extraButtons = []
            } = options;

    // Créer le modal
            const modal = document.createElement('div');
            modal.className = 'confirm-modal-overlay';
            modal.innerHTML = `
                <div class="confirm-modal">
                    <div class="confirm-modal-header">
                        <span class="confirm-modal-icon">${icon}</span>
                        <h3 class="confirm-modal-title">${title}</h3>
                    </div>
                    <div class="confirm-modal-body">
                        <p class="confirm-modal-message">${message}</p>
                        ${details ? `<div class="confirm-modal-details">${details}</div>` : ''}
                    </div>
                    <div class="confirm-modal-footer">
                        ${cancelText ? `<button class="confirm-modal-btn cancel" data-action="cancel">${cancelText}</button>` : ''}
                        ${extraButtons.map(btn => `
                            <button class="confirm-modal-btn ${btn.class || 'secondary'}" data-action="extra" data-value="${btn.value}">${btn.text}</button>
                        `).join('')}
                        <button class="confirm-modal-btn ${confirmClass}" data-action="confirm">${confirmText}</button>
                    </div>
                </div>
            `;

    // Ajouter au DOM
            document.body.appendChild(modal);

    // Fonction de fermeture centralisée
            const closeModal = (result) => {
    // Supprimer les listeners AVANT de fermer
                modal.removeEventListener('click', handleClick);
                document.removeEventListener('keydown', handleKeydown);

    // Animation de sortie
                modal.classList.remove('visible');
                setTimeout(() => {
                    if (modal.parentNode) {
                        modal.remove();
                    }
                    resolve(result);
                }, 200);
            };

    // Animation d'entrée
            requestAnimationFrame(() => {
                modal.classList.add('visible');
            });

    // Gestionnaire de clic
            const handleClick = (e) => {
    // Clic sur l'overlay (fond) = annuler
                if (e.target === modal) {
                    closeModal(false);
                    return;
                }

                const btn = e.target.closest('.confirm-modal-btn');
                if (!btn) return;

                const action = btn.dataset.action;
                let result;

                if (action === 'confirm') {
                    result = true;
                } else if (action === 'cancel') {
                    result = false;
                } else if (action === 'extra') {
                    result = btn.dataset.value;
                }

                closeModal(result);
            };

            modal.addEventListener('click', handleClick);

    // Fermer avec Escape
            const handleKeydown = (e) => {
                if (e.key === 'Escape') {
                    closeModal(false);
                }
            };
            document.addEventListener('keydown', handleKeydown);

    // Focus sur le bouton de confirmation
            setTimeout(() => {
                const confirmBtn = modal.querySelector('.confirm-modal-btn.primary, .confirm-modal-btn.success, .confirm-modal-btn.danger');
                if (confirmBtn) confirmBtn.focus();
            }, 50);
        });
    }

    /**
    * Modal de changement de canal avec options
    * @param {number} noteCount - Nombre de notes sélectionnées
    * @param {number} currentChannel - Canal actuel (ou -1 si mixte)
    * @param {number} newChannel - Nouveau canal
    * @returns {Promise<boolean>}
    */
    MidiEditorDialogsMixin.showChangeChannelModal = async function(noteCount, currentChannel, newChannel) {
        const currentChannelText = currentChannel >= 0
            ? `Canal ${currentChannel + 1}`
            : 'Canaux mixtes';

        const channelInfo = this.channels.find(ch => ch.channel === newChannel);
        const newChannelInstrument = channelInfo
            ? channelInfo.instrument
            : this.getInstrumentName(this.selectedInstrument);

        return this.showConfirmModal({
            title: this.t('midiEditor.changeChannelTitle'),
            icon: '🎹',
            message: `Déplacer <strong>${noteCount}</strong> note(s) vers le <strong>Canal ${newChannel + 1}</strong> ?`,
            details: `
                <div class="confirm-detail-row">
                    <span class="confirm-detail-label">Depuis :</span>
                    <span class="confirm-detail-value">${currentChannelText}</span>
                </div>
                <div class="confirm-detail-row">
                    <span class="confirm-detail-label">Vers :</span>
                    <span class="confirm-detail-value">Canal ${newChannel + 1} (${newChannelInstrument})</span>
                </div>
            `,
            confirmText: this.t('midiEditor.apply'),
            confirmClass: 'primary'
        });
    }

    /**
    * Modal de changement d'instrument avec choix
    * @param {Object} options
    * @returns {Promise<string|boolean>} - 'selection', 'channel', ou false
    */
    MidiEditorDialogsMixin.showChangeInstrumentModal = async function(options) {
        const {
            noteCount = 0,
            channelNoteCount = 0,
            channel,
            currentInstrument,
            newInstrument,
            hasSelection
        } = options;

        if (hasSelection && noteCount > 0) {
    // Proposer le choix : sélection ou tout le canal
            return this.showConfirmModal({
                title: this.t('midiEditor.changeInstrumentTitle'),
                icon: '🎵',
                message: `Changer l'instrument vers <strong>${newInstrument}</strong> ?`,
                details: `
                    <div class="confirm-detail-row">
                        <span class="confirm-detail-label">Instrument actuel :</span>
                        <span class="confirm-detail-value">${currentInstrument}</span>
                    </div>
                    <div class="confirm-detail-row">
                        <span class="confirm-detail-label">Nouvel instrument :</span>
                        <span class="confirm-detail-value">${newInstrument}</span>
                    </div>
                    <div class="confirm-choice-info">
                        <p>📌 <strong>${noteCount}</strong> note(s) sélectionnée(s)</p>
                        <p>📋 Canal ${channel + 1} contient <strong>${channelNoteCount}</strong> note(s) au total</p>
                    </div>
                `,
                confirmText: `Sélection (${noteCount})`,
                confirmClass: 'success',
                extraButtons: [
                    { text: `Tout le canal (${channelNoteCount})`, class: 'primary', value: 'channel' }
                ]
            });
        } else {
    // Pas de sélection, changer tout le canal
            return this.showConfirmModal({
                title: this.t('midiEditor.changeInstrumentTitle'),
                icon: '🎵',
                message: `Changer l'instrument du <strong>Canal ${channel + 1}</strong> ?`,
                details: `
                    <div class="confirm-detail-row">
                        <span class="confirm-detail-label">Instrument actuel :</span>
                        <span class="confirm-detail-value">${currentInstrument}</span>
                    </div>
                    <div class="confirm-detail-row">
                        <span class="confirm-detail-label">Nouvel instrument :</span>
                        <span class="confirm-detail-value">${newInstrument}</span>
                    </div>
                    <div class="confirm-detail-row">
                        <span class="confirm-detail-label">Notes affectées :</span>
                        <span class="confirm-detail-value">${channelNoteCount} note(s)</span>
                    </div>
                `,
                confirmText: this.t('midiEditor.apply'),
                confirmClass: 'primary'
            });
        }
    }


    if (typeof window !== 'undefined') {
        window.MidiEditorDialogsMixin = MidiEditorDialogsMixin;
    }
})();
