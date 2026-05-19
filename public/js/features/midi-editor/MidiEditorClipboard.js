// ============================================================================
// File: public/js/features/midi-editor/MidiEditorClipboard.js
// Description: Selection + clipboard operations (copy/paste/delete/select-all)
//   — extracted from MidiEditorEditActions per audit §1.3 (god-class split).
//
// Owns:
//   - `getSelectedNotes()` / `getSelectionCount()` — read selection from
//     the active renderer (piano roll or specialized editor).
//   - `copy()` / `paste()` — clipboard ops, dispatched to specialized
//     editors when active, else to the piano roll.
//   - `deleteSelectedNotes()` — delete + sync.
//   - `deleteAssociatedCCAndVelocity(notes)` — cascade-delete CC/pitchbend
//     points sharing (tick, channel). Uses bit-packed `tick*16+channel`
//     integer keys to skip the per-note string allocation (audit §3.3).
//   - `selectAllNotes()` / `selectAll()` — unified select-all path.
//   - `updateEditButtons()` — refresh copy/delete/paste/change-channel
//     button disabled state from current selection.
//
// Accessed via `modal.editActions.clipboard`. MidiEditorEditActions keeps
// thin delegate methods preserving the legacy names so external callers
// (MidiEditorToolbar, TablatureEditor, DrumPatternEditor,
// WindInstrumentEditor, MidiEditorChannelOps) are unchanged.
// ============================================================================

(function () {
  'use strict';

  class MidiEditorClipboard {
    /** @param {MidiEditorEditActions} parent */
    constructor(parent) {
      this.parent = parent;
      this.modal = parent.modal;
    }

    getSelectedNotes() {
      return this.modal.pianoRollRenderer?.isMounted()
        ? this.modal.pianoRollRenderer.getSelectedNotes()
        : [];
    }

    getSelectionCount() {
      return this.modal.pianoRollRenderer?.isMounted()
        ? this.modal.pianoRollRenderer.getSelectionCount()
        : 0;
    }

    copy() {
      const specializedRenderer = this.parent._getActiveSpecializedRenderer();
      if (specializedRenderer) {
        if (typeof specializedRenderer.copySelected === 'function') {
          specializedRenderer.copySelected();
          this.modal.log('info', 'Copied selection from specialized editor');
          // Enable paste button
          const pasteBtn = document.getElementById('paste-btn');
          if (pasteBtn) pasteBtn.disabled = false;
        }
        return;
      }

      if (!this.modal.pianoRollRenderer?.isMounted()) {
        this.modal.showNotification(this.modal.t('midiEditor.copyNotAvailable'), 'error');
        return;
      }

      const count = this.getSelectionCount();
      if (count === 0) {
        this.modal.showNotification(this.modal.t('midiEditor.noNoteSelected'), 'info');
        return;
      }

      // Use the piano roll's method
      this.modal.clipboard = this.modal.pianoRollRenderer?.copySelection();

      this.modal.log('info', `Copied ${this.modal.clipboard.length} notes`);
      this.modal.showNotification(
        this.modal.t('midiEditor.notesCopied', { count: this.modal.clipboard.length }),
        'success'
      );

      // Enable the Paste button
      const pasteBtn = document.getElementById('paste-btn');
      if (pasteBtn) {
        pasteBtn.disabled = false;
      }

      this.updateEditButtons();
    }

    paste() {
      const specializedRenderer = this.parent._getActiveSpecializedRenderer();
      if (specializedRenderer) {
        if (
          typeof specializedRenderer.hasClipboard === 'function' &&
          specializedRenderer.hasClipboard()
        ) {
          const tick = specializedRenderer.playheadTick || 0;
          specializedRenderer.paste(tick);
          this.parent._afterSpecializedEdit({ enforceMonophony: true });
        }
        return;
      }

      if (!this.modal.clipboard || this.modal.clipboard.length === 0) {
        this.modal.showNotification(this.modal.t('midiEditor.clipboardEmpty'), 'info');
        return;
      }

      if (!this.modal.pianoRollRenderer?.isMounted()) {
        this.modal.showNotification(this.modal.t('midiEditor.pasteNotAvailable'), 'error');
        return;
      }

      // Get the current cursor (playhead) position
      const currentTime = this.modal.pianoRollRenderer?.getCursor() || 0;

      // Use the piano roll's method
      this.modal.pianoRollRenderer?.pasteNotes(this.modal.clipboard, currentTime);

      this.modal.log('info', `Pasted ${this.modal.clipboard.length} notes`);
      this.modal.showNotification(
        this.modal.t('midiEditor.notesPasted', { count: this.modal.clipboard.length }),
        'success'
      );

      this.modal.isDirty = true;
      this.modal.routingOps.updateSaveButton();
      this.modal.sequenceOps.syncFullSequenceFromPianoRoll();
      this.updateEditButtons();
    }

    deleteSelectedNotes() {
      const specializedRenderer = this.parent._getActiveSpecializedRenderer();
      if (specializedRenderer) {
        if (
          typeof specializedRenderer.deleteSelected === 'function' &&
          specializedRenderer.deleteSelected() > 0
        ) {
          this.parent._afterSpecializedEdit();
        }
        return;
      }

      if (!this.modal.pianoRollRenderer?.isMounted()) {
        this.modal.showNotification(this.modal.t('midiEditor.deleteNotAvailable'), 'error');
        return;
      }

      const count = this.getSelectionCount();
      if (count === 0) {
        this.modal.showNotification(this.modal.t('midiEditor.noNoteSelected'), 'info');
        return;
      }

      // Grab the selected notes before deletion
      const selectedNotes = this.getSelectedNotes();

      // Use the piano roll's method
      this.modal.pianoRollRenderer?.deleteSelection();

      // Delete CC/velocity points associated with deleted notes
      this.deleteAssociatedCCAndVelocity(selectedNotes);

      this.modal.log('info', `Deleted ${count} notes`);
      this.modal.showNotification(this.modal.t('midiEditor.notesDeleted', { count }), 'success');

      this.modal.isDirty = true;
      this.modal.routingOps.updateSaveButton();
      this.modal.sequenceOps.syncFullSequenceFromPianoRoll();
      this.updateEditButtons();
    }

    deleteAssociatedCCAndVelocity(deletedNotes) {
      if (!deletedNotes || deletedNotes.length === 0) return;

      // Pack (tick, channel) into a single integer key. MIDI channels fit
      // in 4 bits (0-15) so `tick * 16 + channel` is collision-free up to
      // 2^49 ticks (well past any musically realistic value). Avoids the
      // string allocation per note that used to dominate large deletes.
      const deletedPositions = new Set();
      deletedNotes.forEach((note) => {
        deletedPositions.add(note.t * 16 + note.c);
      });

      // Delete CC/pitch-bend events at the same positions
      if (this.modal.ccEditor && this.modal.ccEditor.events) {
        const initialCCCount = this.modal.ccEditor.events.length;
        this.modal.ccEditor.events = this.modal.ccEditor.events.filter((event) => {
          return !deletedPositions.has(event.ticks * 16 + event.channel);
        });
        const deletedCCCount = initialCCCount - this.modal.ccEditor.events.length;
        if (deletedCCCount > 0) {
          this.modal.log(
            'info',
            `Deleted ${deletedCCCount} CC/pitchbend events associated with deleted notes`
          );
          this.modal.ccEditor.renderThrottled();
        }
      }

      // Delete velocity points of deleted notes
      // (velocity is already removed with the note, but we still refresh the editor)
      if (this.modal.velocityEditor) {
        this.modal.velocityEditor.setSequence(this.modal.pianoRollRenderer?.getSequence());
        this.modal.velocityEditor.renderThrottled();
      }
    }

    selectAllNotes() {
      // Delegate to the unified selectAll() which handles all editor types
      this.selectAll();
    }

    selectAll() {
      const specializedRenderer = this.parent._getActiveSpecializedRenderer();
      if (specializedRenderer) {
        if (typeof specializedRenderer.selectAll === 'function') {
          specializedRenderer.selectAll();
          this.updateEditButtons();
        }
        return;
      }

      // Piano roll: select all notes
      if (this.modal.pianoRollRenderer?.isMounted()) {
        this.modal.pianoRollRenderer?.selectAll();
        this.updateEditButtons();
      }
    }

    updateEditButtons() {
      const specializedRenderer = this.parent._getActiveSpecializedRenderer();
      if (specializedRenderer) {
        // For specialized editors, enable buttons based on renderer state
        const hasSelection =
          typeof specializedRenderer.getSelectionCount === 'function'
            ? specializedRenderer.getSelectionCount() > 0
            : true; // Default to enabled if we can't check
        const copyBtn = document.getElementById('copy-btn');
        const deleteBtn = document.getElementById('delete-btn');
        const pasteBtn = document.getElementById('paste-btn');
        const changeChannelBtn = document.getElementById('change-channel-btn');
        if (copyBtn) copyBtn.disabled = !hasSelection;
        if (deleteBtn) deleteBtn.disabled = !hasSelection;
        if (pasteBtn)
          pasteBtn.disabled = !(
            typeof specializedRenderer.hasClipboard === 'function' &&
            specializedRenderer.hasClipboard()
          );
        if (changeChannelBtn) changeChannelBtn.disabled = true; // Not applicable for specialized editors
        return;
      }

      const selectionCount = this.getSelectionCount();
      const hasSelection = selectionCount > 0;

      const copyBtn = document.getElementById('copy-btn');
      const deleteBtn = document.getElementById('delete-btn');
      const changeChannelBtn = document.getElementById('change-channel-btn');

      if (copyBtn) copyBtn.disabled = !hasSelection;
      if (deleteBtn) deleteBtn.disabled = !hasSelection;
      if (changeChannelBtn) changeChannelBtn.disabled = !hasSelection;

      this.modal.log('debug', `Selection: ${selectionCount} notes`);
    }
  }

  if (typeof window !== 'undefined') {
    window.MidiEditorClipboard = MidiEditorClipboard;
  }
})();
