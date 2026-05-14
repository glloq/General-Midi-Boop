// ============================================================================
// File: public/js/features/midi-editor/MidiEditorChannelOps.js
// Description: Channel & instrument operations — extracted from
//   MidiEditorEditActions per audit §1.3 (god-class split).
//
// Owns:
//   - `changeChannel()` — move selected notes to a different MIDI channel.
//   - `refreshChannelButtons(keepPopover)` — rebuild the channels-toolbar
//     HTML, reapply per-chip CSS vars, re-detect tablature/drum/wind state.
//   - `applyInstrument()` — apply the instrument-selector value to the
//     active channel (with confirm-modal flow).
//   - `applyInstrumentToSelection(program, name)` — same but for the
//     selected notes only ; finds/creates a target channel.
//   - `applyInstrumentToChannel(channel, program, name, info)` — direct
//     channel update path (called by applyInstrument and by toolbar).
//   - `findAvailableChannel(program)` — first free MIDI channel for a
//     given program (drums excluded).
//
// Accessed via `modal.editActions.channelOps`. MidiEditorEditActions keeps
// thin delegate methods preserving the legacy names so external callers
// (MidiEditorToolbar, MidiEditorSpecializedEditors, MidiEditorTablature)
// are unchanged.
// ============================================================================

(function () {
    'use strict';

    class MidiEditorChannelOps {
        /** @param {MidiEditorEditActions} parent */
        constructor(parent) {
            this.parent = parent;
            this.modal = parent.modal;
        }

    async changeChannel() {
        if (!this.modal.pianoRollRenderer?.isMounted()) {
            this.modal.showNotification(this.modal.t('midiEditor.changeChannelNotAvailable'), 'error');
            return;
        }

        const count = this.parent.getSelectionCount();
        if (count === 0) {
            this.modal.showNotification(this.modal.t('midiEditor.noNoteSelected'), 'info');
            return;
        }

        const channelSelector = document.getElementById('channel-selector');
        if (!channelSelector) return;

        const newChannel = parseInt(channelSelector.value);
        const instrumentSelector = document.getElementById('instrument-selector');

    // Determine the current channel of the selected notes
        const selectedNotes = this.parent.getSelectedNotes();
        const currentChannels = new Set(selectedNotes.map(n => n.c));
        const currentChannel = currentChannels.size === 1 ? Array.from(currentChannels)[0] : -1;

    // Check whether we are moving to the same channel
        if (currentChannel === newChannel) {
            this.modal.showNotification(this.modal.t('midiEditor.sameChannel'), 'info');
            return;
        }

    // Show the confirmation modal
        const confirmed = await this.modal.dialogs.showChangeChannelModal(count, currentChannel, newChannel);
        if (!confirmed) {
            this.modal.log('info', 'Channel change cancelled by user');
            return;
        }

    // Check whether the target channel already exists
        const targetChannelInfo = this.modal.channels.find(ch => ch.channel === newChannel);

    // If this is a new channel, use the program selected in the dropdown
        if (!targetChannelInfo && instrumentSelector) {
            this.modal.selectedInstrument = parseInt(instrumentSelector.value);
            this.modal.log('info', `New channel ${newChannel} will use instrument: ${this.modal.getInstrumentName(this.modal.selectedInstrument)}`);
        }

    // Use the piano roll's method to move the notes
        this.modal.pianoRollRenderer?.changeChannelSelection(newChannel);

        this.modal.log('info', `Changed channel of ${count} notes to ${newChannel}`);
        this.modal.showNotification(this.modal.t('midiEditor.channelChanged', { count }), 'success');

        this.modal.isDirty = true;
        this.modal.routingOps.updateSaveButton();
        this.modal.sequenceOps.syncFullSequenceFromPianoRoll();

    // Update the channel list (automatically drops empty channels)
        this.modal.ccPicker.updateChannelsFromSequence();

    // Clean up activeChannels: remove channels that no longer exist
        const existingChannelNumbers = new Set(this.modal.channels.map(ch => ch.channel));
        const channelsToRemove = [];
        this.modal.activeChannels.forEach(ch => {
            if (!existingChannelNumbers.has(ch)) {
                channelsToRemove.push(ch);
            }
        });
        channelsToRemove.forEach(ch => {
            this.modal.activeChannels.delete(ch);
            this.modal.log('info', `Removed empty channel ${ch} from active channels`);
        });

    // Auto-activate the new channel if it was not already active
        if (!this.modal.activeChannels.has(newChannel)) {
            this.modal.activeChannels.add(newChannel);
        }

    // Update the displayed sequence (skipSync=true — already synced)
        this.modal.sequenceOps.updateSequenceFromActiveChannels(null, true);

    // Refresh the channel buttons
        this.refreshChannelButtons();

    // Update the instrument selector for the new channel
        this.modal.renderer.updateInstrumentSelector();

        this.parent.updateEditButtons();
    }

    refreshChannelButtons(keepPopover = false) {
        if (!keepPopover) {
            this.modal.tablatureOps._closeChannelSettingsPopover();
        }

        const channelsToolbar = this.modal.container?.querySelector('.channels-toolbar');
        if (channelsToolbar) {
    // Preserve scroll position across DOM rebuild
            const scrollLeft = channelsToolbar.scrollLeft;

            channelsToolbar.innerHTML = this.modal.renderer.renderChannelButtons();

    // Restore scroll position so the user sees the same channels as before
            channelsToolbar.scrollLeft = scrollLeft;

    // Events are handled through delegation on this.modal.container
    // (see attachEventHandlers) — no need to rebind direct listeners

    // Re-apply --chip-bg / --chip-border CSS vars on the freshly rendered
    // chips. renderChannelButtons() only emits --chip-color inline; without
    // this call, active chips remain visually greyed until "show all" is hit.
            this.modal.routingOps?.updateChannelButtons();

    // Update disabled visual states
            this.modal.channelDisabled.forEach(ch => {
                this.modal.tablatureOps._updateChannelDisabledVisual(ch);
            });

    // Update TAB button active states
            this.modal.tablatureOps._updateChannelTabButtons();

    // Update DRUM button active states
            this.modal.tablatureOps._updateDrumButtonState(
                this.modal.drumPatternEditor && this.modal.drumPatternEditor.isVisible
            );

    // Update WIND button active states
            this.modal.tablatureOps._updateWindButtonState(
                this.modal.windInstrumentEditor && this.modal.windInstrumentEditor.isVisible
            );

    // Async: adjust TAB buttons based on DB cc_enabled setting
            this.modal.tablatureOps._refreshStringInstrumentChannels();
        }
    }

    async applyInstrument() {
        if (this.modal.activeChannels.size === 0) {
            this.modal.showNotification(this.modal.t('midiEditor.noActiveChannel'), 'info');
            return;
        }

    // If several channels are active, ask to keep only one
        if (this.modal.activeChannels.size > 1) {
            this.modal.showNotification(
                this.modal.t('midiEditor.multipleChannelsWarning', { count: this.modal.activeChannels.size }),
                'warning'
            );
            return;
        }

        const instrumentSelector = document.getElementById('instrument-selector');
        if (!instrumentSelector) return;

        const selectedProgram = parseInt(instrumentSelector.value);
        const instrumentName = this.modal.getInstrumentName(selectedProgram);

    // Only one active channel: that's the one we modify
        const targetChannel = Array.from(this.modal.activeChannels)[0];
        const channelInfo = this.modal.channels.find(ch => ch.channel === targetChannel);

        if (!channelInfo) {
            this.modal.log('error', `Channel ${targetChannel} not found in this.modal.channels`);
            return;
        }

    // Check whether the program is changing
        if (channelInfo.program === selectedProgram) {
            this.modal.showNotification(this.modal.t('midiEditor.sameInstrument'), 'info');
            return;
        }

    // Check whether any notes are selected
        const selectionCount = this.parent.getSelectionCount();
        const hasSelection = selectionCount > 0;

    // Show the confirmation modal
        const result = await this.modal.dialogs.showChangeInstrumentModal({
            noteCount: selectionCount,
            channelNoteCount: channelInfo.noteCount,
            channel: targetChannel,
            currentInstrument: channelInfo.instrument,
            newInstrument: instrumentName,
            hasSelection
        });

        if (result === false) {
            this.modal.log('info', 'Instrument change cancelled by user');
            return;
        }

        if (result === true && hasSelection) {
    // Change only the selected notes
    // They must be moved to a new channel with the new program
            await this.applyInstrumentToSelection(selectedProgram, instrumentName);
        } else {
    // Change the whole channel (result === 'channel' or no selection)
            this.applyInstrumentToChannel(targetChannel, selectedProgram, instrumentName, channelInfo);
        }
    }

    async applyInstrumentToSelection(program, instrumentName) {
        const selectedNotes = this.parent.getSelectedNotes();
        if (selectedNotes.length === 0) return;

    // Find a free channel for the notes with the new instrument
        let newChannel = this.findAvailableChannel(program);

        if (newChannel === -1) {
            this.modal.showNotification(this.modal.t('midiEditor.noChannelAvailable'), 'error');
            return;
        }

    // Append the new channel to the list if it does not exist
        let channelInfo = this.modal.channels.find(ch => ch.channel === newChannel);
        if (!channelInfo) {
            channelInfo = {
                channel: newChannel,
                program: program,
                instrument: newChannel === 9 ? 'Drums' : instrumentName,
                noteCount: 0
            };
            this.modal.channels.push(channelInfo);
        } else {
    // Update the channel's program
            channelInfo.program = program;
            channelInfo.instrument = newChannel === 9 ? 'Drums' : instrumentName;
        }

    // Move the selected notes to the new channel
        if (this.modal.pianoRollRenderer?.isMounted()) {
            this.modal.pianoRollRenderer?.changeChannelSelection(newChannel);
        }

        this.modal.log('info', `Applied instrument ${instrumentName} to ${selectedNotes.length} selected notes (moved to channel ${newChannel + 1})`);
        this.modal.showNotification(
            this.modal.t('midiEditor.instrumentAppliedToSelection', { count: selectedNotes.length, instrument: instrumentName }),
            'success'
        );

        this.modal.isDirty = true;
        this.modal.routingOps.updateSaveButton();
        this.modal.sequenceOps.syncFullSequenceFromPianoRoll();
        this.modal.ccPicker.updateChannelsFromSequence();

    // Clean up activeChannels: remove channels that no longer exist
        const existingChannelNumbers = new Set(this.modal.channels.map(ch => ch.channel));
        const channelsToRemove = [];
        this.modal.activeChannels.forEach(ch => {
            if (!existingChannelNumbers.has(ch)) {
                channelsToRemove.push(ch);
            }
        });
        channelsToRemove.forEach(ch => {
            this.modal.activeChannels.delete(ch);
            this.modal.log('info', `Removed empty channel ${ch} from active channels`);
        });

    // Activate the new channel
        if (!this.modal.activeChannels.has(newChannel)) {
            this.modal.activeChannels.add(newChannel);
        }

    // Update the displayed sequence (skipSync=true — already synced)
        this.modal.sequenceOps.updateSequenceFromActiveChannels(null, true);

        this.refreshChannelButtons();
        this.modal.tablatureOps._refreshStringInstrumentChannels();
        this.modal.renderer.updateInstrumentSelector();
        this.parent.updateEditButtons();
    }

    applyInstrumentToChannel(channel, program, instrumentName, channelInfo) {
        channelInfo.program = program;
        channelInfo.instrument = channel === 9 ? 'Drums' : instrumentName;
        channelInfo.hasExplicitProgram = true;

        this.modal.log('info', `Applied instrument ${instrumentName} to channel ${channel + 1}`);
        this.modal.showNotification(this.modal.t('midiEditor.instrumentApplied', { channel: channel + 1, instrument: instrumentName }), 'success');

        // Reset feedback instruments so they get reloaded with the new program
        if (this.modal._playback) this.modal._playback._feedbackInstrumentsLoaded = false;

        this.refreshChannelButtons();
        this.modal.isDirty = true;
        this.modal.routingOps.updateSaveButton();

    // Clean up stale string instrument config if program changed to non-string
        const gmMatch = typeof MidiEditorChannelPanel !== 'undefined'
            ? MidiEditorChannelPanel.getStringInstrumentCategory(program)
            : null;
        if (!gmMatch) {
    // Delete stale DB record for this channel so TAB doesn't reappear
            this.modal.api.sendCommand('string_instrument_delete', {
                device_id: this.modal.tablatureOps.getEffectiveDeviceId(),
                channel: channel
            }).catch(() => { /* ignore if no record existed */ });
        }

    // Update tablature buttons (string instrument detection may change)
        this.modal.tablatureOps._refreshStringInstrumentChannels();
        if (this.modal.channelPanel) {
            this.modal.channelPanel.updateTablatureButton();
        }
    }

    findAvailableChannel(program) {
    // Look first for an existing channel with the same program
        const existingChannel = this.modal.channels.find(ch => ch.program === program && ch.channel !== 9);
        if (existingChannel) {
            return existingChannel.channel;
        }

    // Otherwise, find a free channel (0-15, except 9 for drums)
        const usedChannels = new Set(this.modal.channels.map(ch => ch.channel));

        for (let i = 0; i < 16; i++) {
            if (i === 9) continue; // Skip drum channel
            if (!usedChannels.has(i)) {
                return i;
            }
        }

    // If every channel is taken, use the first available one that is not the current channel
        for (let i = 0; i < 16; i++) {
            if (i === 9) continue;
            const channelInfo = this.modal.channels.find(ch => ch.channel === i);
            if (channelInfo && channelInfo.noteCount === 0) {
                return i;
            }
        }

        return -1; // No channel available
    }
    }

    if (typeof window !== 'undefined') {
        window.MidiEditorChannelOps = MidiEditorChannelOps;
    }
})();
