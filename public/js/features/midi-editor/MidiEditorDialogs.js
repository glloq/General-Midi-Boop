// ============================================================================
// File: public/js/features/midi-editor/MidiEditorDialogs.js
// Description: Modern confirmation dialogs — sub-component instantiated by
//   MidiEditorModal (converted from mixin in P2-F.10a). Keeps the mixin
//   export for backward compatibility during the transition.
// ============================================================================

(function() {
    'use strict';

    class MidiEditorDialogs {
        constructor(modal) {
            this.modal = modal;
        }

        // ====================================================================
        // MODERN CONFIRMATION MODAL
        // ====================================================================

        /**
         * @param {Object} options
         * @param {string} [options.title]
         * @param {string} [options.message]
         * @param {string} [options.details]
         * @param {string} [options.icon]
         * @param {string} [options.confirmText]
         * @param {string} [options.cancelText]
         * @param {string} [options.confirmClass]
         * @param {Array}  [options.extraButtons]
         * @returns {Promise<string|boolean>}
         */
        showConfirmModal(options) {
            return new Promise((resolve) => {
                const t = (k) => this.modal.t(k);
                const {
                    title = t('common.confirm'),
                    message = '',
                    details = '',
                    icon = '⚠️',
                    confirmText = t('common.confirm'),
                    cancelText = t('common.cancel'),
                    confirmClass = 'primary',
                    extraButtons = []
                } = options;

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

                document.body.appendChild(modal);

                const closeModal = (result) => {
                    modal.removeEventListener('click', handleClick);
                    document.removeEventListener('keydown', handleKeydown);
                    modal.classList.remove('visible');
                    setTimeout(() => {
                        if (modal.parentNode) modal.remove();
                        resolve(result);
                    }, 200);
                };

                requestAnimationFrame(() => modal.classList.add('visible'));

                const handleClick = (e) => {
                    if (e.target === modal) { closeModal(false); return; }
                    const btn = e.target.closest('.confirm-modal-btn');
                    if (!btn) return;
                    const action = btn.dataset.action;
                    let result;
                    if (action === 'confirm') result = true;
                    else if (action === 'cancel') result = false;
                    else if (action === 'extra') result = btn.dataset.value;
                    closeModal(result);
                };
                modal.addEventListener('click', handleClick);

                const handleKeydown = (e) => {
                    if (e.key === 'Escape') closeModal(false);
                };
                document.addEventListener('keydown', handleKeydown);

                setTimeout(() => {
                    const confirmBtn = modal.querySelector('.confirm-modal-btn.primary, .confirm-modal-btn.success, .confirm-modal-btn.danger');
                    if (confirmBtn) confirmBtn.focus();
                }, 50);
            });
        }

        /**
         * @returns {Promise<boolean>}
         */
        async showChangeChannelModal(noteCount, currentChannel, newChannel) {
            const m = this.modal;
            const currentChannelText = currentChannel >= 0
                ? `Canal ${currentChannel + 1}`
                : 'Canaux mixtes';

            const channelInfo = m.channels.find(ch => ch.channel === newChannel);
            const newChannelInstrument = channelInfo
                ? channelInfo.instrument
                : m.getInstrumentName(m.selectedInstrument);

            return this.showConfirmModal({
                title: m.t('midiEditor.changeChannelTitle'),
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
                confirmText: m.t('midiEditor.apply'),
                confirmClass: 'primary'
            });
        }

        /**
         * @returns {Promise<string|boolean>} 'channel' | true | false
         */
        async showChangeInstrumentModal(options) {
            const m = this.modal;
            const {
                noteCount = 0,
                channelNoteCount = 0,
                channel,
                currentInstrument,
                newInstrument,
                hasSelection
            } = options;

            if (hasSelection && noteCount > 0) {
                return this.showConfirmModal({
                    title: m.t('midiEditor.changeInstrumentTitle'),
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
            }

            return this.showConfirmModal({
                title: m.t('midiEditor.changeInstrumentTitle'),
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
                confirmText: m.t('midiEditor.apply'),
                confirmClass: 'primary'
            });
        }
    }

    if (typeof window !== 'undefined') {
        window.MidiEditorDialogs = MidiEditorDialogs;
    }
})();
