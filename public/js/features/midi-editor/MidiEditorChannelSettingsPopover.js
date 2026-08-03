// ============================================================================
// File: public/js/features/midi-editor/MidiEditorChannelSettingsPopover.js
// Description: Per-channel settings popover (routing dropdown, mute toggle,
//   playable-notes highlight toggle, delete-channel button) — extracted
//   from MidiEditorTablature per audit §1.3 (god-class split).
//
// Owns:
//   - `closePopover()` — tear down popover element + outside-click and
//     toolbar-scroll listeners.
//   - `togglePopover(channel, buttonEl)` — open/close the popover for
//     the given channel chip ; builds device options + wires inputs.
//   - `deleteChannel(channel)` — drop a channel and all its notes from
//     the sequence (called from the popover's "delete" button).
//
// Accessed via `modal.tablatureOps.channelPopover`. MidiEditorTablature
// keeps thin delegates so external callers (MidiEditorChannelOps,
// MidiEditorLifecycle, MidiEditorEvents.channelChips) are unchanged.
// ============================================================================

(function () {
  'use strict';

  class MidiEditorChannelSettingsPopover {
    /** @param {MidiEditorTablature} parent */
    constructor(parent) {
      this.parent = parent;
      this.modal = parent.modal;
    }

    closePopover() {
      if (this.modal._channelSettingsPopoverEl) {
        this.modal._channelSettingsPopoverEl.remove();
        this.modal._channelSettingsPopoverEl = null;
      }
      // Also remove any stale popover from document.body (defensive)
      const stale = document.body.querySelector('.channel-settings-popover');
      if (stale) stale.remove();

      // Clean up global mousedown listener
      if (this.modal._popoverOutsideClickHandler) {
        document.removeEventListener('mousedown', this.modal._popoverOutsideClickHandler, true);
        this.modal._popoverOutsideClickHandler = null;
      }
      // Clean up toolbar scroll listener
      if (this.modal._popoverScrollHandler) {
        const toolbar = this.modal.container?.querySelector('.channels-toolbar');
        if (toolbar) toolbar.removeEventListener('scroll', this.modal._popoverScrollHandler);
        this.modal._popoverScrollHandler = null;
      }
      this.modal._channelSettingsOpen = -1;
    }

    togglePopover(channel, buttonEl) {
      const wasOpen = this.modal._channelSettingsOpen === channel;
      this.closePopover();

      // If same channel, just close (already done above)
      if (wasOpen) {
        return;
      }

      this.modal._channelSettingsOpen = channel;

      const isDisabled = this.modal.channelDisabled.has(channel);
      const currentRouting = this.modal.channelRouting.get(channel) || '';
      const isHighlighted = this.modal.channelPlayableHighlights.has(channel);

      // Build device options
      let deviceOptions = `<option value="">${this.modal.t('midiEditor.noRouting')}</option>`;
      this.modal.connectedDevices.forEach((device) => {
        let value, name;
        if (device._multiInstrument) {
          value = `${device.id}::${device._channel}`;
          const chLabel = `Ch${(device._channel || 0) + 1}`;
          name = `${device.displayName || device.name} [${chLabel}]`;
        } else {
          value = device.id;
          name = device.displayName || device.name || device.id;
        }
        const selected = currentRouting === value ? 'selected' : '';
        deviceOptions += `<option value="${escapeHtml(value)}" ${selected}>${escapeHtml(name)}</option>`;
      });

      const hasRouting = !!currentRouting;
      const color = this.modal.channelColors[channel % this.modal.channelColors.length];

      const popover = document.createElement('div');
      popover.className = 'channel-settings-popover';
      popover.innerHTML = `
            <div class="channel-settings-header">
                <span>⚙ ${this.modal.t('midiEditor.channelSettingsTitle', { channel: channel + 1 })}</span>
                <button class="channel-settings-delete-btn" title="${this.modal.t('midiEditor.deleteChannel')}" aria-label="${this.modal.t('midiEditor.deleteChannel')}">🗑</button>
            </div>
            <div class="channel-settings-section">
                <label class="channel-settings-toggle">
                    <input type="checkbox" class="channel-enabled-checkbox" ${!isDisabled ? 'checked' : ''}>
                    <span>🔊</span>
                    <span>${this.modal.t('midiEditor.channelEnabled')}</span>
                </label>
            </div>
            <div class="channel-settings-section">
                <label class="channel-settings-toggle">
                    <input type="checkbox" class="channel-playable-checkbox" ${isHighlighted ? 'checked' : ''} ${!hasRouting ? 'disabled' : ''}>
                    <span class="playable-color-dot" style="background: ${color}"></span>
                    <span>${this.modal.t('midiEditor.showPlayableNotes')}</span>
                </label>
                ${!hasRouting ? `<span class="channel-settings-hint">${this.modal.t('midiEditor.playableRequiresRouting')}</span>` : ''}
            </div>
            <div class="channel-settings-section">
                <label class="channel-settings-label">🔌 ${this.modal.t('midiEditor.channelRoutingLabel')}</label>
                <span class="channel-settings-hint">${this.modal.t('midiEditor.channelRoutingHint')}</span>
                <select class="channel-routing-select">${deviceOptions}</select>
            </div>
            <div class="channel-settings-section channel-visibility-actions">
                <label class="channel-settings-label">👁 ${this.modal.t('midiEditor.visibilityTitle')}</label>
                <div class="channel-visibility-btns">
                    <button class="channel-hide-others-btn">👁 ${this.modal.t('midiEditor.hideOtherChannels')}</button>
                    <button class="channel-show-all-btn">👁 ${this.modal.t('midiEditor.showAllChannels')}</button>
                </div>
            </div>
        `;

      // Position en fixed par rapport au bouton
      // Append to document.body to avoid clipping by overflow:hidden on modal-body/toolbar
      const rect = buttonEl.getBoundingClientRect();
      popover.style.position = 'fixed';
      popover.style.top = `${rect.bottom + 4}px`;
      popover.style.left = `${rect.left + rect.width / 2}px`;
      popover.style.transform = 'translateX(-50%)';
      document.body.appendChild(popover);
      this.modal._channelSettingsPopoverEl = popover;

      // Close popover on any outside click (global listener on document)
      this.modal._popoverOutsideClickHandler = (e) => {
        if (popover.contains(e.target)) return;
        if (e.target.closest('.chip-settings-btn')) return;
        this.closePopover();
      };
      document.addEventListener('mousedown', this.modal._popoverOutsideClickHandler, true);

      // Close popover when toolbar scrolls (button moves but popover stays fixed)
      const toolbar = this.modal.container?.querySelector('.channels-toolbar');
      if (toolbar) {
        this.modal._popoverScrollHandler = () => this.closePopover();
        toolbar.addEventListener('scroll', this.modal._popoverScrollHandler);
      }

      // Event: delete channel button
      const deleteBtn = popover.querySelector('.channel-settings-delete-btn');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.deleteChannel(channel);
        });
      }

      // Event: enabled checkbox
      const checkbox = popover.querySelector('.channel-enabled-checkbox');
      checkbox.addEventListener('change', () => {
        this.parent.toggleChannelDisabled(channel);
        checkbox.checked = !this.modal.channelDisabled.has(channel);
      });

      // Event: playable notes toggle checkbox
      const playableCheckbox = popover.querySelector('.channel-playable-checkbox');
      playableCheckbox.addEventListener('change', async () => {
        if (playableCheckbox.disabled) return;
        await this.parent._toggleChannelPlayableHighlight(channel);
        playableCheckbox.checked = this.modal.channelPlayableHighlights.has(channel);
        // Update chip visual
        this.modal.routingOps.updateChannelButtons();
      });

      // Event: routing select
      const routingSelect = popover.querySelector('.channel-routing-select');
      routingSelect.addEventListener('change', () => {
        const newValue = routingSelect.value || null;
        this.parent.setChannelRouting(channel, newValue);
        // Update playable toggle state
        if (playableCheckbox) {
          playableCheckbox.disabled = !newValue;
          if (!newValue) {
            this.parent._clearChannelPlayableHighlight(channel);
            playableCheckbox.checked = false;
            this.modal.routingOps.updateChannelButtons();
          }
        }
      });

      // Event: hide other channels (solo this one)
      const hideOthersBtn = popover.querySelector('.channel-hide-others-btn');
      hideOthersBtn.addEventListener('click', () => {
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
      });

      // Event: show all channels — same cleanup as the global Show-All button
      const showAllBtn = popover.querySelector('.channel-show-all-btn');
      showAllBtn.addEventListener('click', () => {
        const previousActiveChannels = new Set(this.modal.activeChannels);
        this.parent._exitSpecializedEditor();
        this.modal._savedActiveChannels = null;
        this.modal.channels.forEach((ch) => {
          this.modal.activeChannels.add(ch.channel);
          this.modal.channelDisabled.delete(ch.channel);
        });
        this.modal.sequenceOps.updateSequenceFromActiveChannels(previousActiveChannels);
        this.modal.routingOps.updateChannelButtons();
        this.modal.renderer.updateInstrumentSelector();
        this.modal.syncMutedChannels();
        this.closePopover();
      });
    }

    deleteChannel(channel) {
      if (Array.isArray(this.modal.fullSequence)) {
        this.modal.fullSequence = this.modal.fullSequence.filter((n) => n.c !== channel);
      }
      if (Array.isArray(this.modal.sequence)) {
        this.modal.sequence = this.modal.sequence.filter((n) => n.c !== channel);
      }

      this.modal.channels = (this.modal.channels || []).filter((ch) => ch.channel !== channel);
      this.modal.activeChannels?.delete(channel);
      this.modal.channelDisabled?.delete(channel);
      this.modal.channelRouting?.delete(channel);
      this.modal.channelPlayableHighlights?.delete(channel);
      this.modal._routedGmPrograms?.delete(channel);
      this.modal._splitChannelNames?.delete(channel);
      this.modal._stringInstrumentChannels?.delete(channel);
      this.modal._stringInstrumentCCEnabled?.delete(channel);

      this.closePopover();

      if (typeof this.modal.sequenceOps.updateSequenceFromActiveChannels === 'function') {
        this.modal.sequenceOps.updateSequenceFromActiveChannels(null, true);
      }
      if (typeof this.modal.editActions.refreshChannelButtons === 'function')
        this.modal.editActions.refreshChannelButtons();
      if (typeof this.modal.renderer.updateInstrumentSelector === 'function')
        this.modal.renderer.updateInstrumentSelector();
      if (typeof this.modal.syncMutedChannels === 'function') this.modal.syncMutedChannels();

      this.modal.isDirty = true;
      if (typeof this.modal.routingOps.updateSaveButton === 'function')
        this.modal.routingOps.updateSaveButton();
    }
  }

  if (typeof window !== 'undefined') {
    window.MidiEditorChannelSettingsPopover = MidiEditorChannelSettingsPopover;
  }
})();
