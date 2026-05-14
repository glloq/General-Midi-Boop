// ============================================================================
// File: public/js/features/midi-editor/MidiEditorSpecializedEditors.js
// Description: Specialized-editor launchers extracted from MidiEditorTablature
//   per audit §6.5. Owns the entry points that open the tablature / drum-pattern /
//   wind / piano-roll editors for a given channel + the save/restore of
//   activeChannels around an editor switch.
//
// Parent is `MidiEditorTablature` (modal.tablatureOps). State stays on the
// modal (activeChannels, tablatureEditor, drumPatternEditor, windInstrumentEditor,
// _savedActiveChannels…).
// ============================================================================

(function() {
    'use strict';

    class MidiEditorSpecializedEditors {
        /** @param {MidiEditorTablature} parent */
        constructor(parent) {
            this.parent = parent;
            this.modal  = parent.modal;
        }

    async toggleTablature() {
    // If tablature is visible, hide it and restore piano roll
        if (this.modal.tablatureEditor && this.modal.tablatureEditor.isVisible) {
            this.modal.tablatureEditor.hide();
            this._updateTabButtonState(false);
            return;
        }

    // Require exactly one active channel
        if (this.modal.activeChannels.size !== 1) {
            this.modal.log('warn', `Tablature requires exactly one active channel (got ${this.modal.activeChannels.size})`);
            this.modal.showNotification(
                this.modal.t('tablature.requiresOneChannel') || 'Select exactly one channel to open the tablature editor.',
                'info'
            );
            return;
        }

        const activeChannel = Array.from(this.modal.activeChannels)[0];

        try {
    // If channel is routed to a device, try its string instrument config first
            let stringInstrument = null;
            if (this.modal.channelRouting.has(activeChannel)) {
                const routedValue = this.modal.channelRouting.get(activeChannel);
                let routedDeviceId = routedValue;
                let routedChannel = activeChannel;
                if (routedValue.includes('::')) {
                    const parts = routedValue.split('::');
                    routedDeviceId = parts[0];
                    routedChannel = parseInt(parts[1]);
                }
                try {
                    const resp = await this.modal.api.sendCommand('string_instrument_get', {
                        device_id: routedDeviceId,
                        channel: routedChannel
                    });
                    if (resp?.instrument) stringInstrument = resp.instrument;
                } catch { /* continue to GM fallback */ }
            }

    // Fallback: sync with GM preset when no routed config found
            const channelInfo = this.modal.channels.find(ch => ch.channel === activeChannel);
            const hasRouting = this.modal.channelRouting.has(activeChannel);
            const routedGm = this.modal._routedGmPrograms.get(activeChannel);
            const effectiveProgram = (hasRouting && routedGm != null) ? routedGm : (channelInfo?.program ?? null);
            const gmMatch = effectiveProgram != null ? MidiEditorChannelPanel.getStringInstrumentCategory(effectiveProgram) : null;
            const deviceId = this.parent.getEffectiveDeviceId();

            if (!stringInstrument) {
                if (gmMatch) {
                    const createResp = await this.modal.api.sendCommand('string_instrument_create_from_preset', {
                        device_id: deviceId,
                        channel: activeChannel,
                        preset: gmMatch.preset
                    });
                    this.modal.log('info', `Synced ${gmMatch.category} preset for channel ${activeChannel + 1}`);
    // Prefer the row returned by the create call to avoid a second lookup
    // that can miss the freshly inserted record (device_id/channel mismatch).
                    if (createResp?.instrument) {
                        stringInstrument = createResp.instrument;
                    }
                }

                if (!stringInstrument) {
                    stringInstrument = await this.parent.findStringInstrument(activeChannel);
                }
            }

            if (!stringInstrument) {
                this.modal.log('warn',
                    `No string instrument for channel ${activeChannel + 1} ` +
                    `(program=${effectiveProgram}, gmMatch=${gmMatch?.category ?? 'none'}, device=${deviceId})`
                );
                this.modal.showNotification(
                    this.modal.t('tablature.noStringInstrument') || 'Configure this channel as a string instrument in the instrument settings first.',
                    'info'
                );
                return;
            }

    // Get notes for this channel
            const channelNotes = (this.modal.fullSequence || []).filter(n => n.c === activeChannel);

    // Hide wind editor if visible
            if (this.modal.windInstrumentEditor && this.modal.windInstrumentEditor.isVisible) {
                this.modal.windInstrumentEditor.hide();
                this._updateWindButtonState(false);
            }

    // Hide drum editor if visible
            if (this.modal.drumPatternEditor && this.modal.drumPatternEditor.isVisible) {
                this.modal.drumPatternEditor.hide();
                this._updateDrumButtonState(false);
            }

    // Create or show tablature editor (replaces piano roll in the same space)
            if (!this.modal.tablatureEditor) {
                this.modal.tablatureEditor = new TablatureEditor(this.modal);
            }

            await this.modal.tablatureEditor.show(stringInstrument, channelNotes, activeChannel);
            this._updateTabButtonState(true);

        } catch (error) {
            this.modal.log('error', 'Failed to toggle tablature:', error);
            // Surface the actual error to the user — otherwise the "no string
            // instrument" fallback notification masks real backend failures
            // (FK errors, missing preset, converter crash, …) and the tab
            // editor just silently never appears.
            this.modal.showNotification(
                `${this.modal.t('tablature.openFailed') || 'Failed to open tablature editor'}: ${error?.message || error}`,
                'error'
            );
        }
    }

    _updateTabButtonState(_active) {
        this._updateChannelTabButtons();
    }

    async _openTablatureForChannel(channel) {
    // If tablature is already visible for this channel, toggle it off and restore channels
        if (this.modal.tablatureEditor && this.modal.tablatureEditor.isVisible
            && this.modal.tablatureEditor.channel === channel) {
            this.modal.tablatureEditor.hide();
            this._updateTabButtonState(false);
            this._restoreActiveChannels();
            return;
        }

    // Save active channels before switching (only saves once for direct editor switches)
        this._saveActiveChannels();

    // Ensure only this channel is active
        const previousActiveChannels = new Set(this.modal.activeChannels);
        this.modal.activeChannels.clear();
        this.modal.activeChannels.add(channel);
        this.modal._pianoRollSoloChannel = null;

        this.modal.sequenceOps.updateSequenceFromActiveChannels(previousActiveChannels);
        if (this.modal.channelPanel) {
            this.modal.channelPanel.updateChannelButtons();
            this.modal.channelPanel.updateInstrumentSelector();
        }

    // If tablature is visible for a different channel, hide it first
        if (this.modal.tablatureEditor && this.modal.tablatureEditor.isVisible) {
            this.modal.tablatureEditor.hide();
        }

    // Hide drum pattern editor if visible (mutually exclusive)
        if (this.modal.drumPatternEditor && this.modal.drumPatternEditor.isVisible) {
            this.modal.drumPatternEditor.hide();
            this._updateDrumButtonState(false);
        }

    // Hide wind editor if visible (mutually exclusive)
        if (this.modal.windInstrumentEditor && this.modal.windInstrumentEditor.isVisible) {
            this.modal.windInstrumentEditor.hide();
            this._updateWindButtonState(false);
        }

    // Now open tablature for the channel
        await this.toggleTablature();
    }

    async _refreshStringInstrumentChannels() {
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

        try { // outer try for concurrency guard
        try {
    // Filter by effective device to avoid showing TAB for instruments
    // configured on other devices
            const deviceId = this.parent.getEffectiveDeviceId();
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
        } catch { /* ignore */ }

    // Add/remove TAB buttons per channel based on string instrument detection
        const chipGroups = this.modal.container?.querySelectorAll('.channel-chip-group');
        if (!chipGroups) return;

        chipGroups.forEach(group => {
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

            const channelInfo = this.modal.channels?.find(c => c.channel === ch);
    // Determine effective GM program: use routed instrument's gm_program if available
            const hasRouting = this.modal.channelRouting.has(ch);
            const routedGm = this.modal._routedGmPrograms.get(ch);
            const effectiveProgram = (hasRouting && routedGm != null) ? routedGm : (channelInfo?.program ?? null);

    // String instrument detection: check effective program (routed or GM)
            const isGmString = effectiveProgram != null &&
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
                btn.title = this.modal.t('tablature.tabButton', { instrument: channelInfo?.instrument || this.modal.t('stringInstrument.string') });
                btn.textContent = this.modal.t('midiEditor.tabButton');
                group.appendChild(btn);
            } else if (!isStringInstrument && existingTabBtn) {
    // Remove TAB button: not a string instrument or routing overrides GM type
                existingTabBtn.remove();
            }

    // Wind instrument detection (GM 56-79: Brass, Reed, Pipe)
    // Uses effective program (routed gm_program or MIDI file GM)
            if (ch !== 9 && typeof WindInstrumentDatabase !== 'undefined') {
                const isWind = effectiveProgram != null && WindInstrumentDatabase.isWindInstrument(effectiveProgram);
                const existingWindBtn = group.querySelector('.channel-wind-btn');

                if (isWind && !existingWindBtn) {
                    const windBtn = document.createElement('button');
                    windBtn.className = 'channel-wind-btn';
                    windBtn.dataset.channel = ch;
                    windBtn.title = this.modal.t('windEditor.windEditorTitle', { name: WindInstrumentDatabase.getPresetByProgram(effectiveProgram)?.name || this.modal.t('windEditor.icon') });
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
                this._refreshStringInstrumentChannels();
            }
        }
    }

    _updateChannelTabButtons() {
        const tabBtns = this.modal.container?.querySelectorAll('.channel-tab-btn');
        if (!tabBtns) return;

        const isTabVisible = this.modal.tablatureEditor && this.modal.tablatureEditor.isVisible;
        const tabChannel = isTabVisible ? this.modal.tablatureEditor.channel : -1;

        tabBtns.forEach(btn => {
            const ch = parseInt(btn.dataset.channel);
            btn.classList.toggle('active', isTabVisible && ch === tabChannel);
        });
    }

    _openDrumPatternForChannel(channel) {
    // Toggle off if already visible for this channel — restore saved channels
        if (this.modal.drumPatternEditor && this.modal.drumPatternEditor.isVisible && this.modal.drumPatternEditor.channel === channel) {
            this.modal.drumPatternEditor.hide();
            this._updateDrumButtonState(false);
            this._restoreActiveChannels();
            return;
        }

    // Save active channels before switching (only saves once for direct editor switches)
        this._saveActiveChannels();

    // Check if a specialty editor is currently managing notes (piano roll is stale)
        const specialtyEditorWasActive =
            (this.modal.tablatureEditor && this.modal.tablatureEditor.isVisible) ||
            (this.modal.windInstrumentEditor && this.modal.windInstrumentEditor.isVisible) ||
            (this.modal.drumPatternEditor && this.modal.drumPatternEditor.isVisible);

    // Hide other specialty editors FIRST (they already synced to fullSequence)
        if (this.modal.tablatureEditor && this.modal.tablatureEditor.isVisible) {
            this.modal.tablatureEditor.hide();
            this._updateChannelTabButtons();
        }
        if (this.modal.windInstrumentEditor && this.modal.windInstrumentEditor.isVisible) {
            this.modal.windInstrumentEditor.hide();
            this._updateWindButtonState(false);
        }

    // Ensure only this channel is active
    // Skip piano roll sync if a specialty editor was active (fullSequence is already current)
        this.modal.activeChannels.clear();
        this.modal.activeChannels.add(channel);
        this.modal._pianoRollSoloChannel = null;
        this.modal.sequenceOps.updateSequenceFromActiveChannels(new Set([channel]), specialtyEditorWasActive);
        this.modal.editActions.refreshChannelButtons();

    // Get MIDI notes for this channel
        const channelNotes = (this.modal.fullSequence || []).filter(n => n.c === channel);

    // Create editor on first use
        if (!this.modal.drumPatternEditor) {
            this.modal.drumPatternEditor = new DrumPatternEditor(this.modal);
        }

        this.modal.drumPatternEditor.show(channelNotes, channel);
        this._updateDrumButtonState(true);
    }

    _updateDrumButtonState(active) {
        const drumBtns = this.modal.container?.querySelectorAll('.channel-drum-btn');
        if (!drumBtns) return;

        const drumChannel = this.modal.drumPatternEditor?.channel;
        drumBtns.forEach(btn => {
            const ch = parseInt(btn.dataset.channel);
            btn.classList.toggle('active', active && ch === drumChannel);
        });
    }

    _openWindEditorForChannel(channel) {
    // Toggle off if already visible for this channel — restore saved channels
        if (this.modal.windInstrumentEditor && this.modal.windInstrumentEditor.isVisible && this.modal.windInstrumentEditor.channel === channel) {
            this.modal.windInstrumentEditor.hide();
            this._updateWindButtonState(false);
            this._restoreActiveChannels();
            return;
        }

    // Save active channels before switching (only saves once for direct editor switches)
        this._saveActiveChannels();

    // Check if a specialty editor is currently managing notes (piano roll is stale)
        const specialtyEditorWasActive =
            (this.modal.tablatureEditor && this.modal.tablatureEditor.isVisible) ||
            (this.modal.windInstrumentEditor && this.modal.windInstrumentEditor.isVisible) ||
            (this.modal.drumPatternEditor && this.modal.drumPatternEditor.isVisible);

    // Hide other specialty editors FIRST (they already synced to fullSequence)
        if (this.modal.tablatureEditor && this.modal.tablatureEditor.isVisible) {
            this.modal.tablatureEditor.hide();
            this._updateChannelTabButtons();
        }
        if (this.modal.drumPatternEditor && this.modal.drumPatternEditor.isVisible) {
            this.modal.drumPatternEditor.hide();
            this._updateDrumButtonState(false);
        }

    // Ensure only this channel is active
    // Skip piano roll sync if a specialty editor was active (fullSequence is already current)
        this.modal.activeChannels.clear();
        this.modal.activeChannels.add(channel);
        this.modal._pianoRollSoloChannel = null;
        this.modal.sequenceOps.updateSequenceFromActiveChannels(new Set([channel]), specialtyEditorWasActive);
        this.modal.editActions.refreshChannelButtons();

    // Determine wind preset — use the same effective-program logic as the
    // button display: prefer the routed GM program over the raw MIDI channel
    // program so that routing-assigned wind instruments open correctly even
    // when the MIDI file itself carries a different (or absent) program change.
        const channelInfo = this.modal.channels?.find(c => c.channel === channel);
        const hasRouting = this.modal.channelRouting?.has(channel);
        const routedGm = this.modal._routedGmPrograms?.get(channel);
        const effectiveGmProgram = (hasRouting && routedGm != null) ? routedGm : (channelInfo?.program ?? null);
        const windPreset = typeof WindInstrumentDatabase !== 'undefined'
            ? WindInstrumentDatabase.getPresetByProgram(effectiveGmProgram)
            : null;

        if (!windPreset) {
            this.modal.log('warn', `No wind preset for effective program ${effectiveGmProgram} on channel ${channel}`);
            return;
        }

    // Get MIDI notes for this channel
        const channelNotes = (this.modal.fullSequence || []).filter(n => n.c === channel);

    // Create editor on first use
        if (!this.modal.windInstrumentEditor) {
            this.modal.windInstrumentEditor = new WindInstrumentEditor(this.modal);
        }

        this.modal.windInstrumentEditor.show(windPreset, channelNotes, channel);
        this._updateWindButtonState(true);
    }

    _updateWindButtonState(active) {
        const windBtns = this.modal.container?.querySelectorAll('.channel-wind-btn');
        if (!windBtns) return;

        const windChannel = this.modal.windInstrumentEditor?.channel;
        windBtns.forEach(btn => {
            const ch = parseInt(btn.dataset.channel);
            btn.classList.toggle('active', active && ch === windChannel);
        });
    }

    _saveActiveChannels() {
        if (!this.modal._savedActiveChannels) {
            this.modal._savedActiveChannels = new Set(this.modal.activeChannels);
        }
    }

    _restoreActiveChannels() {
        if (!this.modal._savedActiveChannels) return;

        const previousActiveChannels = new Set(this.modal.activeChannels);
        this.modal.activeChannels = new Set(this.modal._savedActiveChannels);
        this.modal._savedActiveChannels = null;
        this.modal._pianoRollSoloChannel = null;

        this.modal.sequenceOps.updateSequenceFromActiveChannels(previousActiveChannels);
        if (this.modal.channelPanel) {
            this.modal.channelPanel.updateChannelButtons();
            this.modal.channelPanel.updateInstrumentSelector();
        }
        if (this.modal.playbackManager) {
            this.modal.playbackManager.syncMutedChannels();
        }
    }

    // Unified exit from any specialized editor (TAB / DRUM / WIND / piano-roll solo).
    // Hides the editor, clears _pianoRollSoloChannel, and removes .active from every
    // editor button. Does NOT touch _savedActiveChannels or activeChannels — the
    // caller decides how to restore the channel state.
    _exitSpecializedEditor() {
        if (this.modal.tablatureEditor?.isVisible) {
            this.modal.tablatureEditor.hide();
        }
        if (this.modal.drumPatternEditor?.isVisible) {
            this.modal.drumPatternEditor.hide();
        }
        if (this.modal.windInstrumentEditor?.isVisible) {
            this.modal.windInstrumentEditor.hide();
        }
        this.modal._pianoRollSoloChannel = null;

        this._updateChannelTabButtons();
        this._updateDrumButtonState(false);
        this._updateWindButtonState(false);
        this._updateEditButtonState(false);
    }

    _openPianoRollForChannel(channel) {
        // Toggle off if already in solo mode for this channel
        if (this.modal._pianoRollSoloChannel === channel) {
            this.modal._pianoRollSoloChannel = null;
            this._restoreActiveChannels();
            this._updateEditButtonState(false);
            return;
        }

        // Hide any open specialized editor
        if (this.modal.tablatureEditor && this.modal.tablatureEditor.isVisible) {
            this.modal.tablatureEditor.hide();
            this._updateChannelTabButtons();
        }
        if (this.modal.drumPatternEditor && this.modal.drumPatternEditor.isVisible) {
            this.modal.drumPatternEditor.hide();
            this._updateDrumButtonState(false);
        }
        if (this.modal.windInstrumentEditor && this.modal.windInstrumentEditor.isVisible) {
            this.modal.windInstrumentEditor.hide();
            this._updateWindButtonState(false);
        }

        this._saveActiveChannels();

        const previousActiveChannels = new Set(this.modal.activeChannels);
        this.modal.activeChannels.clear();
        this.modal.activeChannels.add(channel);
        this.modal._pianoRollSoloChannel = channel;

        this.modal.sequenceOps.updateSequenceFromActiveChannels(previousActiveChannels);
        this.modal.editActions.refreshChannelButtons();
        this._updateEditButtonState(true);
    }

    _updateEditButtonState(active) {
        const editBtns = this.modal.container?.querySelectorAll('.channel-edit-btn');
        if (!editBtns) return;

        const soloChannel = this.modal._pianoRollSoloChannel;
        editBtns.forEach(btn => {
            const ch = parseInt(btn.dataset.channel);
            btn.classList.toggle('active', active && ch === soloChannel);
        });
    }

    async showStringInstrumentConfig() { return this.parent.stringInstruments?.showConfig(); }
    async hasStringInstrument()        { return this.parent.stringInstruments?.has(); }
    async findStringInstrument(channel){ return this.parent.stringInstruments?.find(channel); }

    }

    if (typeof window !== 'undefined') {
        window.MidiEditorSpecializedEditors = MidiEditorSpecializedEditors;
    }
})();
