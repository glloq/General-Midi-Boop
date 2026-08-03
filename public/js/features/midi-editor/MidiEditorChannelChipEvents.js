// ============================================================================
// File: public/js/features/midi-editor/MidiEditorChannelChipEvents.js
// Description: Event delegation for the channels toolbar (.channel-chip,
//   .chip-settings-btn, .channel-tab-btn, .channel-drum-btn,
//   .channel-wind-btn, .channel-edit-btn, .btn-show-all-channels) —
//   extracted from MidiEditorEvents.attachEvents() per audit §1.3
//   (god-class split).
//
// One delegated click listener and one delegated dblclick listener handle
// every channel-row interaction (single-click toggle, dblclick solo,
// settings popover, TAB/DRUM/WIND/edit launchers, Show-All). Replaces
// what used to be ~64 individual listeners (16 channels × 4 buttons).
//
// Accessed via `modal.events.channelChips`. The only entry point is
// `attachHandlers()` invoked from MidiEditorEvents.attachEvents().
// ============================================================================

(function () {
  'use strict';

  class MidiEditorChannelChipEvents {
    /** @param {MidiEditorEvents} parent */
    constructor(parent) {
      this.parent = parent;
      this.modal = parent.modal;
    }

    attachHandlers() {
      // Channel settings popover outside-click is now handled by a global
      // document listener attached/removed in _toggleChannelSettingsPopover /
      // _closeChannelSettingsPopover — no capture-phase container listener needed.

      // OPTIMIZATION: Event delegation for all channel buttons
      // Replaces 4 forEach loops × 16 buttons = ~64 listeners with a single listener
      this.modal.container.addEventListener('click', (e) => {
        const channelChip = e.target.closest('.channel-chip');
        if (channelChip) {
          e.preventDefault();
          e.stopPropagation();
          const channel = parseInt(channelChip.dataset.channel);
          if (isNaN(channel)) return;

          // If a specialized editor (TAB/DRUM/WIND) or the piano-roll solo mode is
          // active, exit it and show the previously-active channels PLUS the newly
          // clicked channel in the normal piano roll.
          const wasSpecialized =
            this.modal.editActions?._isSpecializedEditorActive() ||
            this.modal._pianoRollSoloChannel != null;
          if (wasSpecialized) {
            const previousActiveChannels = new Set(this.modal.activeChannels);
            this.modal.tablatureOps._exitSpecializedEditor();
            if (this.modal._savedActiveChannels) {
              this.modal.activeChannels = new Set(this.modal._savedActiveChannels);
              this.modal._savedActiveChannels = null;
            }
            this.modal.activeChannels.add(channel);
            this.modal.channelDisabled.delete(channel);
            this.modal.sequenceOps.updateSequenceFromActiveChannels(previousActiveChannels);
            this.modal.routingOps.updateChannelButtons();
            this.modal.renderer.updateInstrumentSelector();
            this.modal.syncMutedChannels();
            return;
          }
          this.modal.sequenceOps.toggleChannel(channel);
          return;
        }
        const settingsBtn = e.target.closest('.chip-settings-btn');
        if (settingsBtn) {
          e.preventDefault();
          e.stopPropagation();
          const channel = parseInt(settingsBtn.dataset.channel);
          if (!isNaN(channel))
            this.modal.tablatureOps?._toggleChannelSettingsPopover(channel, settingsBtn);
          return;
        }
        // Global "Show All" button
        const showAllBtn = e.target.closest('.btn-show-all-channels');
        if (showAllBtn) {
          e.preventDefault();
          e.stopPropagation();
          const previousActiveChannels = new Set(this.modal.activeChannels);
          // Exit any specialized/solo editor and reset .active on every editor button
          this.modal.tablatureOps?._exitSpecializedEditor();
          this.modal._savedActiveChannels = null;
          this.modal.channels.forEach((ch) => {
            this.modal.activeChannels.add(ch.channel);
            this.modal.channelDisabled.delete(ch.channel);
          });
          this.modal.sequenceOps.updateSequenceFromActiveChannels(previousActiveChannels);
          this.modal.routingOps.updateChannelButtons();
          this.modal.renderer.updateInstrumentSelector();
          this.modal.syncMutedChannels();
          return;
        }
        const tabBtn = e.target.closest('.channel-tab-btn');
        if (tabBtn) {
          e.preventDefault();
          e.stopPropagation();
          const channel = parseInt(tabBtn.dataset.channel);
          if (!isNaN(channel)) this.modal.tablatureOps?._openTablatureForChannel(channel);
          return;
        }
        const drumBtn = e.target.closest('.channel-drum-btn');
        if (drumBtn) {
          e.preventDefault();
          e.stopPropagation();
          const channel = parseInt(drumBtn.dataset.channel);
          if (!isNaN(channel)) this.modal.tablatureOps?._openDrumPatternForChannel(channel);
          return;
        }
        const windBtn = e.target.closest('.channel-wind-btn');
        if (windBtn) {
          e.preventDefault();
          e.stopPropagation();
          const channel = parseInt(windBtn.dataset.channel);
          if (!isNaN(channel)) this.modal.tablatureOps?._openWindEditorForChannel(channel);
          return;
        }
        const editBtn = e.target.closest('.channel-edit-btn');
        if (editBtn) {
          e.preventDefault();
          e.stopPropagation();
          const channel = parseInt(editBtn.dataset.channel);
          if (!isNaN(channel)) this.modal.tablatureOps?._openPianoRollForChannel(channel);
          return;
        }
      });

      // Double-click on channel chip = Solo (hide all others)
      this.modal.container.addEventListener('dblclick', (e) => {
        const channelChip = e.target.closest('.channel-chip');
        if (channelChip) {
          e.preventDefault();
          e.stopPropagation();
          // Block solo when a specialized editor is active
          if (this.modal.editActions?._isSpecializedEditorActive()) return;
          const channel = parseInt(channelChip.dataset.channel);
          if (!isNaN(channel)) {
            const previousActiveChannels = new Set(this.modal.activeChannels);
            this.modal.activeChannels.clear();
            this.modal.activeChannels.add(channel);
            this.modal.channels.forEach((ch) => {
              if (ch.channel === channel) {
                this.modal.channelDisabled.delete(ch.channel);
              } else {
                this.modal.channelDisabled.add(ch.channel);
              }
            });
            this.modal.sequenceOps.updateSequenceFromActiveChannels(previousActiveChannels);
            this.modal.routingOps.updateChannelButtons();
            this.modal.renderer.updateInstrumentSelector();
            this.modal.syncMutedChannels();
          }
          return;
        }
      });
    }
  }

  if (typeof window !== 'undefined') {
    window.MidiEditorChannelChipEvents = MidiEditorChannelChipEvents;
  }
})();
