// ============================================================================
// File: public/js/features/midi-editor/MidiEditorDialogs.js
// Description: Modern confirmation dialogs — sub-component instantiated by
//   MidiEditorModal, accessed via `modal.dialogs`.
// ============================================================================

(function () {
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
        // Escape caller-supplied text fields before innerHTML. All current
        // callers pass trusted i18n/GM strings, but a future caller passing a
        // filename / meta string would otherwise inject (audit D L3). `details`
        // stays raw — it is intentionally an HTML fragment; `icon` is an emoji.
        const esc = (s) => window.escapeHtml(s);
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
                            <h3 class="confirm-modal-title">${esc(title)}</h3>
                        </div>
                        <div class="confirm-modal-body">
                            <p class="confirm-modal-message">${esc(message)}</p>
                            ${details ? `<div class="confirm-modal-details">${details}</div>` : ''}
                        </div>
                        <div class="confirm-modal-footer">
                            ${cancelText ? `<button class="confirm-modal-btn cancel" data-action="cancel">${esc(cancelText)}</button>` : ''}
                            ${extraButtons
                              .map(
                                (btn) => `
                                <button class="confirm-modal-btn ${btn.class || 'secondary'}" data-action="extra" data-value="${esc(btn.value)}">${esc(btn.text)}</button>
                            `
                              )
                              .join('')}
                            <button class="confirm-modal-btn ${confirmClass}" data-action="confirm">${esc(confirmText)}</button>
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
          if (e.target === modal) {
            closeModal(false);
            return;
          }
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
          const confirmBtn = modal.querySelector(
            '.confirm-modal-btn.primary, .confirm-modal-btn.success, .confirm-modal-btn.danger'
          );
          if (confirmBtn) confirmBtn.focus();
        }, 50);
      });
    }

    /**
     * @returns {Promise<boolean>}
     */
    async showChangeChannelModal(noteCount, currentChannel, newChannel) {
      const m = this.modal;
      const currentChannelText =
        currentChannel >= 0
          ? m.t('midiEditor.channelTip', { channel: currentChannel + 1 })
          : m.t('midiEditor.mixedChannels');

      const channelInfo = m.channels.find((ch) => ch.channel === newChannel);
      const newChannelInstrument = channelInfo
        ? channelInfo.instrument
        : m.getInstrumentName(m.selectedInstrument);

      return this.showConfirmModal({
        title: m.t('midiEditor.changeChannelTitle'),
        icon: '🎹',
        message: m.t('midiEditor.moveNotesToChannel', {
          count: noteCount,
          channel: newChannel + 1
        }),
        details: `${this._detailRow(m.t('midiEditor.fromChannel'), currentChannelText)}${this._detailRow(m.t('midiEditor.toChannel'), m.tHtml('midiEditor.channelWithInstrument', { channel: newChannel + 1, instrument: newChannelInstrument }))}
                `,
        confirmText: m.t('midiEditor.apply'),
        confirmClass: 'primary'
      });
    }

    // One label/value row of the confirm-modal details block.
    _detailRow(label, value) {
      return `
                    <div class="confirm-detail-row">
                        <span class="confirm-detail-label">${label}</span>
                        <span class="confirm-detail-value">${value}</span>
                    </div>`;
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

      // `details` is injected raw into innerHTML by showConfirmModal (it is
      // deliberately an HTML fragment), so every value that is NOT already an
      // escaped tHtml() result must be escaped here. GM instrument names come
      // from the trusted locale table today, but a custom-bank / user-entered
      // label reaching this path would otherwise inject (audit L10 F-111).
      const esc = (s) => window.escapeHtml(s);
      const instrumentRows =
        this._detailRow(m.t('midiEditor.currentInstrument'), esc(currentInstrument)) +
        this._detailRow(m.t('midiEditor.newInstrumentLabel'), esc(newInstrument));

      if (hasSelection && noteCount > 0) {
        return this.showConfirmModal({
          title: m.t('midiEditor.changeInstrumentTitle'),
          icon: '🎵',
          message: m.t('midiEditor.changeInstrumentTo', { instrument: newInstrument }),
          details: `${instrumentRows}
                        <div class="confirm-choice-info">
                            <p>📌 ${m.t('midiEditor.applyToSelection', { count: noteCount })}</p>
                            <p>📋 ${m.t('midiEditor.channelNoteCount', { channel: channel + 1, count: channelNoteCount })}</p>
                        </div>
                    `,
          confirmText: m.t('midiEditor.applyToSelection', { count: noteCount }),
          confirmClass: 'success',
          extraButtons: [
            {
              text: m.t('midiEditor.applyToChannel', { count: channelNoteCount }),
              class: 'primary',
              value: 'channel'
            }
          ]
        });
      }

      return this.showConfirmModal({
        title: m.t('midiEditor.changeInstrumentTitle'),
        icon: '🎵',
        message: m.t('midiEditor.changeInstrumentOfChannel', { channel: channel + 1 }),
        details: `${instrumentRows}${this._detailRow(m.t('midiEditor.affectedNotes'), `${channelNoteCount} note(s)`)}
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
