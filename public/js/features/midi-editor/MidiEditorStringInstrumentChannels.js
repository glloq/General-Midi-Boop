// ============================================================================
// File: public/js/features/midi-editor/MidiEditorStringInstrumentChannels.js
// Description: Refresh of per-channel "string instrument" state — extracted
//   from MidiEditorSpecializedEditors per audit §1.3 (god-class split).
//
// One async entry point: `refresh()` —
//   - hits `string_instrument_list` for the effective device,
//   - rebuilds `modal._stringInstrumentChannels` (the set of channels
//     with a TAB config) and `modal._stringInstrumentCCEnabled` (per-
//     channel CC enable flag),
//   - re-syncs the chip TAB buttons and tablature visibility,
//   - re-queues if another refresh fires while this one is in flight
//     (concurrency guard).
//
// Accessed via `modal.tablatureOps.specializedEditors.stringChannels`.
// MidiEditorSpecializedEditors keeps a thin
// `_refreshStringInstrumentChannels()` delegate so external callers
// (MidiEditorModal, MidiEditorChannelOps, MidiEditorChannelPanel,
// MidiEditorTablature setChannelRouting) are unchanged.
// ============================================================================

(function () {
  'use strict';

  class MidiEditorStringInstrumentChannels {
    /** @param {MidiEditorSpecializedEditors} parent */
    constructor(parent) {
      this.parent = parent;
      this.modal = parent.modal;
    }

    async refresh() {
      if (!this.modal._stringInstrumentChannels) {
        this.modal._stringInstrumentChannels = new Set();
      }
      if (!this.modal._stringInstrumentCCEnabled) {
        this.modal._stringInstrumentCCEnabled = new Map();
      }

      // Guard against concurrent calls — if a refresh is already in flight,
      // mark that another one was requested and return. The running call will
      // re-run once it finishes.
      if (this.modal._refreshStringInstrumentPending) {
        this.modal._refreshStringInstrumentQueued = true;
        return;
      }
      this.modal._refreshStringInstrumentPending = true;

      try {
        // outer try for concurrency guard
        try {
          // Filter by effective device to avoid showing TAB for instruments
          // configured on other devices
          const deviceId = this.parent.parent.getEffectiveDeviceId();
          const resp = await this.modal.api.sendCommand('string_instrument_list', {
            device_id: deviceId
          });
          if (resp?.instruments) {
            this.modal._stringInstrumentChannels.clear();
            this.modal._stringInstrumentCCEnabled.clear();
            for (const si of resp.instruments) {
              this.modal._stringInstrumentChannels.add(si.channel);
              this.modal._stringInstrumentCCEnabled.set(si.channel, si.cc_enabled !== false);
            }
          }
        } catch {
          /* ignore */
        }

        // Add/remove TAB buttons per channel based on string instrument detection
        const chipGroups = this.modal.container?.querySelectorAll('.channel-chip-group');
        if (!chipGroups) return;

        chipGroups.forEach((group) => {
          const channelChip = group.querySelector('.channel-chip');
          if (!channelChip) return;
          const ch = parseInt(channelChip.dataset.channel);
          if (isNaN(ch)) return;

          // Channel 9 (drums): add DRUM button instead of TAB
          if (ch === 9) {
            const existingDrumBtn = group.querySelector('.channel-drum-btn');
            if (!existingDrumBtn) {
              const btn = document.createElement('button');
              btn.className = 'channel-drum-btn';
              btn.dataset.channel = ch;
              btn.title = this.modal.t('drumPattern.toggleEditor');
              btn.textContent = this.modal.t('midiEditor.drumButton');
              group.appendChild(btn);
            }
            return;
          }

          const channelInfo = this.modal.channels?.find((c) => c.channel === ch);
          // Determine effective GM program: use routed instrument's gm_program if available
          const hasRouting = this.modal.channelRouting.has(ch);
          const routedGm = this.modal._routedGmPrograms.get(ch);
          const effectiveProgram =
            hasRouting && routedGm != null ? routedGm : (channelInfo?.program ?? null);

          // String instrument detection: check effective program (routed or GM)
          const isGmString =
            effectiveProgram != null &&
            typeof MidiEditorChannelPanel !== 'undefined' &&
            MidiEditorChannelPanel.getStringInstrumentCategory(effectiveProgram) !== null;
          const ccEnabled = this.modal._stringInstrumentCCEnabled.get(ch);
          const isStringInstrument = isGmString && ccEnabled !== false;

          const existingTabBtn = group.querySelector('.channel-tab-btn');

          if (isStringInstrument && !existingTabBtn) {
            // Add TAB button for newly detected string instrument
            const color = channelChip.dataset.color || '#667eea';
            const btn = document.createElement('button');
            btn.className = 'channel-tab-btn';
            btn.dataset.channel = ch;
            btn.dataset.color = color;
            btn.title = this.modal.t('tablature.tabButton', {
              instrument: channelInfo?.instrument || this.modal.t('stringInstrument.string')
            });
            btn.textContent = this.modal.t('midiEditor.tabButton');
            group.appendChild(btn);
          } else if (!isStringInstrument && existingTabBtn) {
            // Remove TAB button: not a string instrument or routing overrides GM type
            existingTabBtn.remove();
          }

          // Wind instrument detection (GM 56-79: Brass, Reed, Pipe)
          // Uses effective program (routed gm_program or MIDI file GM)
          if (ch !== 9 && typeof WindInstrumentDatabase !== 'undefined') {
            const isWind =
              effectiveProgram != null && WindInstrumentDatabase.isWindInstrument(effectiveProgram);
            const existingWindBtn = group.querySelector('.channel-wind-btn');

            if (isWind && !existingWindBtn) {
              const windBtn = document.createElement('button');
              windBtn.className = 'channel-wind-btn';
              windBtn.dataset.channel = ch;
              windBtn.title = this.modal.t('windEditor.windEditorTitle', {
                name:
                  WindInstrumentDatabase.getPresetByProgram(effectiveProgram)?.name ||
                  this.modal.t('windEditor.icon')
              });
              windBtn.textContent = this.modal.t('midiEditor.windButton');
              group.appendChild(windBtn);
            } else if (!isWind && existingWindBtn) {
              existingWindBtn.remove();
            }
          }

          // EDIT button for channels without any specialized editor
          const hasTab = group.querySelector('.channel-tab-btn');
          const hasWind = group.querySelector('.channel-wind-btn');
          const hasDrum = group.querySelector('.channel-drum-btn');
          const existingEditBtn = group.querySelector('.channel-edit-btn');

          if (!hasTab && !hasWind && !hasDrum && !existingEditBtn) {
            const editBtn = document.createElement('button');
            editBtn.className = 'channel-edit-btn';
            editBtn.dataset.channel = ch;
            editBtn.title = this.modal.t('midiEditor.editChannel');
            editBtn.textContent = this.modal.t('midiEditor.editButton');
            group.appendChild(editBtn);
          } else if ((hasTab || hasWind || hasDrum) && existingEditBtn) {
            existingEditBtn.remove();
          }
        });
      } finally {
        this.modal._refreshStringInstrumentPending = false;
        // If another refresh was requested while we were running, re-run now
        // with fresh DOM state.
        if (this.modal._refreshStringInstrumentQueued) {
          this.modal._refreshStringInstrumentQueued = false;
          this.refresh();
        }
      }
    }
  }

  if (typeof window !== 'undefined') {
    window.MidiEditorStringInstrumentChannels = MidiEditorStringInstrumentChannels;
  }
})();
