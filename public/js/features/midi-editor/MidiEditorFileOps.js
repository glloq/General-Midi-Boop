// ============================================================================
// File: public/js/features/midi-editor/MidiEditorFileOps.js
// Description: File operations (save/load/rename/export) for the MIDI editor
//   Sub-component class ; called via `modal.fileOps.<method>(...)`.
//   (P2-F.10d body rewrite — no longer a prototype mixin.)
// ============================================================================

(function () {
  'use strict';

  class MidiEditorFileOps {
    constructor(modal) {
      this.modal = modal;
      // Sub-feature: MIDI binary writer (audit §1.3).
      this.midiWriter =
        typeof MidiEditorMidiWriter !== 'undefined' ? new MidiEditorMidiWriter(this) : null;
    }

    convertSequenceToMidi() {
      return this.midiWriter?.convertSequenceToMidi();
    }

    // Shared no-file/no-piano-roll guard for the save paths.
    _canSave(logContext) {
      if (!this.modal.currentFile || !this.modal.pianoRollRenderer?.isMounted()) {
        this.modal.log('error', `Cannot ${logContext}: no file or piano roll`);
        this.modal.showError(this.modal.t('midiEditor.cannotSave'));
        return false;
      }
      return true;
    }

    // Pull every editor surface back into the in-memory model and serialise
    // to a midi-file payload. Throws if conversion fails.
    _buildMidiPayload() {
      this.modal.sequenceOps.syncFullSequenceFromPianoRoll();
      this.modal.ccPicker.syncCCEventsFromEditor();
      this.modal.ccPicker.syncTempoEventsFromEditor();
      this.modal.ccPicker.updateChannelsFromSequence();

      this.modal.log(
        'info',
        `Saving ${this.modal.fullSequence.length} notes across ${this.modal.channels.length} channels`
      );

      const midiData = this.convertSequenceToMidi();
      if (!midiData) {
        throw new Error('MIDI conversion failed');
      }
      this.modal.log('debug', `MIDI data to save: ${midiData.tracks.length} tracks`);
      return midiData;
    }

    async saveMidiFile() {
      if (!this._canSave('save')) return;

      try {
        this.modal.log('info', `Saving MIDI file: ${this.modal.currentFile}`);
        const midiData = this._buildMidiPayload();

        const response = await this.modal.api.writeMidiFile(this.modal.currentFile, midiData);

        if (response && response.success) {
          this.modal.isDirty = false;
          this.modal.routingOps?.updateSaveButton();
          this.modal.showNotification(this.modal.t('midiEditor.saveSuccess'), 'success');

          if (this.modal.eventBus) {
            this.modal.eventBus.emit('midi_editor:saved', {
              filePath: this.modal.currentFile
            });
          }
        } else {
          throw new Error('Server response indicates failure');
        }
      } catch (error) {
        this.modal.log('error', 'Failed to save MIDI file:', error);
        this.modal.showError(`${this.modal.t('errors.saveFailed')}: ${error.message}`);
      }
    }

    showSaveAsDialog() {
      if (!this.modal.currentFile || !this.modal.pianoRollRenderer?.isMounted()) {
        this.modal.log('error', 'Cannot save as: no file or piano roll');
        this.modal.showError(this.modal.t('midiEditor.cannotSave'));
        return;
      }

      // Extract current name without extension
      const currentName = this.modal.currentFilename || this.modal.currentFile || '';
      const baseName = currentName.replace(/\.(mid|midi)$/i, '');
      const extension = currentName.match(/\.(mid|midi)$/i)?.[0] || '.mid';

      // Create the Save As dialog
      const dialog = document.createElement('div');
      dialog.className = 'rename-dialog-overlay';
      dialog.innerHTML = `
            <div class="rename-dialog">
                <div class="rename-dialog-header">
                    <h4>📄 ${this.modal.t('midiEditor.saveAs')}</h4>
                </div>
                <div class="rename-dialog-body">
                    <p>${this.modal.t('midiEditor.saveAsDescription')}</p>
                    <div class="rename-input-container">
                        <input type="text" class="rename-input" value="${escapeHtml(baseName)}" />
                        <span class="rename-extension">${extension}</span>
                    </div>
                </div>
                <div class="rename-dialog-footer rename-buttons">
                    <button class="btn btn-secondary rename-cancel">${this.modal.t('common.cancel')}</button>
                    <button class="btn btn-primary rename-confirm">${this.modal.t('common.save')}</button>
                </div>
            </div>
        `;

      document.body.appendChild(dialog);

      const input = dialog.querySelector('.rename-input');
      const cancelBtn = dialog.querySelector('.rename-cancel');
      const confirmBtn = dialog.querySelector('.rename-confirm');

      // Select name without extension for easy editing
      setTimeout(() => {
        input.focus();
        input.select();
      }, 100);

      // Cancel
      cancelBtn.addEventListener('click', () => {
        dialog.remove();
      });

      // Confirm - Save As
      confirmBtn.addEventListener('click', async () => {
        const newBaseName = input.value.trim();
        if (!newBaseName) {
          this.modal.showError(this.modal.t('midiEditor.emptyFilename'));
          return;
        }

        const newFilename = newBaseName + extension;
        dialog.remove();

        // Call saveAsFile with the new filename
        await this.saveAsFile(newFilename);
      });

      // Enter to confirm
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          confirmBtn.click();
        } else if (e.key === 'Escape') {
          cancelBtn.click();
        }
      });

      // Click outside to cancel
      dialog.addEventListener('click', (e) => {
        if (e.target === dialog) {
          dialog.remove();
        }
      });
    }

    async saveAsFile(newFilename) {
      if (!this._canSave('save as')) return;

      try {
        this.modal.log('info', `Saving MIDI file as: ${newFilename}`);
        const midiData = this._buildMidiPayload();

        // Send to backend with new filename
        const response = await this.modal.api.sendCommand('file_save_as', {
          fileId: this.modal.currentFile,
          newFilename: newFilename,
          midiData: midiData
        });

        if (response && response.success) {
          this.modal.showNotification(
            this.modal.t('midiEditor.saveAsSuccess', { filename: newFilename }),
            'success'
          );

          // Emit event
          if (this.modal.eventBus) {
            this.modal.eventBus.emit('midi_editor:saved_as', {
              originalFile: this.modal.currentFile,
              newFile: response.newFileId,
              newFilename: newFilename
            });
          }

          // Optionally reload file list in parent
          if (window.loadFiles) {
            window.loadFiles();
          }
        } else {
          throw new Error('Server response indicates failure');
        }
      } catch (error) {
        this.modal.log('error', 'Failed to save file as:', error);
        this.modal.showError(`${this.modal.t('errors.saveFailed')}: ${error.message}`);
      }
    }

    async showAutoAssignModal() {
      if (!this.modal.currentFile) {
        this.modal.showErrorModal(this.modal.t('midiEditor.noFileLoaded'));
        return;
      }

      if (!window.RoutingSummaryPage) {
        this.modal.showErrorModal(this.modal.t('autoAssign.componentNotLoaded'));
        return;
      }

      const routingPage = new window.RoutingSummaryPage(this.modal.api);
      routingPage.show(
        this.modal.currentFile,
        this.modal.currentFilename || '',
        this.modal.channels || [],
        (result) => {
          if (result && window.eventBus) {
            window.eventBus.emit('routing:changed', result);
          }
        }
      );
    }

    showRenameDialog() {
      // Extraire le nom sans extension
      const currentName = this.modal.currentFilename || this.modal.currentFile || '';
      const baseName = currentName.replace(/\.(mid|midi)$/i, '');
      const extension = currentName.match(/\.(mid|midi)$/i)?.[0] || '.mid';

      // Create the rename dialog (centered modal)
      const dialog = document.createElement('div');
      dialog.className = 'rename-dialog-overlay';
      dialog.innerHTML = `
            <div class="rename-dialog">
                <div class="rename-dialog-header">
                    <h4>✏️ ${this.modal.t('midiEditor.renameFile')}</h4>
                </div>
                <div class="rename-dialog-body">
                    <div class="rename-input-container">
                        <input type="text" class="rename-input" value="${escapeHtml(baseName)}" />
                        <span class="rename-extension">${extension}</span>
                    </div>
                </div>
                <div class="rename-dialog-footer rename-buttons">
                    <button class="btn btn-secondary rename-cancel">${this.modal.t('common.cancel')}</button>
                    <button class="btn btn-primary rename-confirm">${this.modal.t('common.save')}</button>
                </div>
            </div>
        `;

      // Append to <body> so it sits on top of everything
      document.body.appendChild(dialog);

      const input = dialog.querySelector('.rename-input');
      const cancelBtn = dialog.querySelector('.rename-cancel');
      const confirmBtn = dialog.querySelector('.rename-confirm');

      // Focus and select the text
      input.focus();
      input.select();

      // Fonction de fermeture
      const closeDialog = () => {
        dialog.remove();
      };

      // Fonction de validation
      const confirmRename = async () => {
        const newName = input.value.trim();
        if (!newName) {
          this.modal.showError(this.modal.t('midiEditor.renameEmpty'));
          return;
        }

        const newFilename = newName + extension;

        try {
          // Appeler l'API pour renommer le fichier
          const response = await this.modal.api.sendCommand('file_rename', {
            fileId: this.modal.currentFile,
            newFilename: newFilename
          });

          if (response && response.success) {
            // Update the displayed name
            this.modal.currentFilename = newFilename;
            const fileNameSpan = this.modal.container.querySelector('#editor-file-name');
            if (fileNameSpan) {
              fileNameSpan.textContent = newFilename;
            }

            this.modal.showNotification(this.modal.t('midiEditor.renameSuccess'), 'success');

            // Emit event to refresh the file list
            if (this.modal.eventBus) {
              this.modal.eventBus.emit('midi_editor:file_renamed', {
                fileId: this.modal.currentFile,
                oldFilename: currentName,
                newFilename: newFilename
              });
            }
          } else {
            throw new Error(response?.error || 'Rename failed');
          }
        } catch (error) {
          this.modal.log('error', 'Failed to rename file:', error);
          this.modal.showError(`${this.modal.t('midiEditor.renameFailed')}: ${error.message}`);
        }

        closeDialog();
      };

      // Events
      cancelBtn.addEventListener('click', closeDialog);
      confirmBtn.addEventListener('click', confirmRename);
      dialog.addEventListener('click', (e) => {
        if (e.target === dialog) closeDialog();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') confirmRename();
        if (e.key === 'Escape') closeDialog();
      });
    }
  }

  if (typeof window !== 'undefined') {
    window.MidiEditorFileOps = MidiEditorFileOps;
  }
})();
