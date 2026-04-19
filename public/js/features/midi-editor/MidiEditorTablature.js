// ============================================================================
// File: public/js/features/midi-editor/MidiEditorTablature.js
// Description: Tablature / drum pattern / wind editor bridges for the MIDI
//   editor. Sub-component class ; called via `modal.tablatureOps.<method>(...)`.
//   (P2-F.10k body rewrite — no longer a prototype mixin.)
// ============================================================================

(function() {
    'use strict';

    class MidiEditorTablature {
        constructor(modal) {
            this.modal = modal;
        }

    getEffectiveDeviceId() {
        return '_editor';
    }

    getRoutedInstrumentName(channel) {
        const routedValue = this.modal.channelRouting.get(channel);
        if (!routedValue) return null;

    // Find the matching device in connectedDevices
        for (const device of this.modal.connectedDevices) {
            let value;
            if (device._multiInstrument) {
                value = `${device.id}::${device._channel}`;
            } else {
                value = device.id;
            }
            if (value === routedValue) {
                return device.displayName || device.custom_name || device.name || device.id;
            }
        }
        return null;
    }

    async setChannelRouting(channel, deviceValue) {
    // Close the settings popover to prevent its capture-phase mousedown
    // handler from interfering with subsequent button clicks.
        this._closeChannelSettingsPopover();

        if (deviceValue) {
            this.modal.channelRouting.set(channel, deviceValue);
        } else {
            this.modal.channelRouting.delete(channel);
            this.modal._routedGmPrograms.delete(channel);
        }
    // Clear stale playable note highlights — the old device capabilities
    // no longer apply to the new routing target.
        if (this.modal.channelPlayableHighlights.has(channel)) {
            this._clearChannelPlayableHighlight(channel);
        }
    // Close TAB/WIND editors if open for this channel (routed instrument type may differ)
        if (this.modal.tablatureEditor && this.modal.tablatureEditor.isVisible && this.modal.tablatureEditor.channel === channel) {
            this.modal.tablatureEditor.hide();
            this._updateTabButtonState(false);
        }
        if (this.modal.windInstrumentEditor && this.modal.windInstrumentEditor.isVisible && this.modal.windInstrumentEditor.channel === channel) {
            this.modal.windInstrumentEditor.hide();
            this._updateWindButtonState(false);
        }
    // Fetch routed instrument gm_program for TAB/WIND button logic
        if (deviceValue) {
            await this.modal.routingOps._fetchAndCacheRoutedGmProgram(channel, deviceValue);
        }
    // Update only the affected chip routing label, then refresh TAB/WIND buttons
        this._updateChipRouting(channel);
        this._refreshStringInstrumentChannels();

    // Auto-enable playable notes highlight if global toggle is ON
        if (this.modal.showPlayableNotes && deviceValue && !this.modal.channelPlayableHighlights.has(channel)) {
            this._toggleChannelPlayableHighlight(channel);
        }

    // Persist routing to database, then notify external components
    // (file list, routing modal) so they read fresh data from DB
        this._syncRoutingToDB().then(() => {
            this._emitRoutingChanged();
        });
    }

    async _loadSavedRoutings() {
        if (!this.modal.currentFile) return;
        try {
            const result = await this.modal.api.sendCommand('get_file_routings', { fileId: this.modal.currentFile });

    // Clear previous routing state before repopulating
            this.modal.channelRouting.clear();
            if (!this.modal._splitChannelNames) this.modal._splitChannelNames = new Map();
            this.modal._splitChannelNames.clear();

            if (result && result.routings && result.routings.length > 0) {
    // Build a lookup of multi-instrument devices
                const multiInstrumentDevices = new Set();
                for (const device of this.modal.connectedDevices) {
                    if (device._multiInstrument) {
                        multiInstrumentDevices.add(device.id);
                    }
                }

    // Detect split channels (multiple routings for same channel)
                const channelRoutingCount = {};
                const channelInstrumentNames = {};
                for (const routing of result.routings) {
                    if (routing.channel == null) continue;
                    channelRoutingCount[routing.channel] = (channelRoutingCount[routing.channel] || 0) + 1;
                    if (!channelInstrumentNames[routing.channel]) channelInstrumentNames[routing.channel] = [];
                    if (routing.instrument_name) channelInstrumentNames[routing.channel].push(routing.instrument_name);
                }
                for (const [ch, count] of Object.entries(channelRoutingCount)) {
                    if (count > 1) {
                        this.modal._splitChannelNames.set(parseInt(ch), channelInstrumentNames[ch] || []);
                    }
                }

                for (const routing of result.routings) {
                    if (routing.channel == null || !routing.device_id) continue;
    // Reconstruct the routing key: deviceId::targetChannel for multi-instrument, otherwise deviceId
                    const isMulti = multiInstrumentDevices.has(routing.device_id);
                    const routingKey = isMulti
                        ? `${routing.device_id}::${routing.target_channel != null ? routing.target_channel : routing.channel}`
                        : routing.device_id;
                    this.modal.channelRouting.set(routing.channel, routingKey);
                }

                this.modal.log('info', `Restored ${this.modal.channelRouting.size} saved channel routing(s) from database`);
            }

    // Fetch gm_programs for all routed instruments (needed for TAB/WIND buttons & preview)
            await this.modal.routingOps._loadRoutedGmPrograms();

    // Use non-destructive DOM updates instead of refreshChannelButtons()
    // which uses innerHTML and destroys elements under the cursor,
    // breaking hover/click state on all channel buttons.
            this._updateAllChipRoutings();
            this.modal.routingOps.updateChannelButtons();
            this._refreshStringInstrumentChannels();

            if (this.modal.channelRouting.size > 0) {
                this._emitRoutingChanged();
            }
        } catch (error) {
            this.modal.log('warn', 'Failed to load saved routings:', error);
        }
    }

    _syncRoutingToDB() {
        if (!this.modal.currentFile) return Promise.resolve();
        const channels = {};
        this.modal.channelRouting.forEach((deviceValue, ch) => {
    // Routing key may be "deviceId::targetChannel" for multi-instrument devices
            channels[String(ch)] = deviceValue;
        });
        return this.modal.api.sendCommand('file_routing_sync', {
            fileId: this.modal.currentFile,
            channels
        }).catch(err => {
            this.modal.log('warn', 'Failed to sync routing to DB:', err);
        });
    }

    _emitRoutingChanged() {
        if (!this.modal.currentFile) return;
        const channels = {};
        this.modal.channelRouting.forEach((deviceValue, ch) => {
            channels[String(ch)] = deviceValue;
        });
        if (this.modal.eventBus) {
            this.modal._isEmittingRouting = true;
            this.modal.eventBus.emit('routing:changed', {
                fileId: this.modal.currentFile,
                channels
            });
            this.modal._isEmittingRouting = false;
        }
    }

    toggleChannelDisabled(channel) {
        const previousActiveChannels = new Set(this.modal.activeChannels);
        if (this.modal.channelDisabled.has(channel)) {
            this.modal.channelDisabled.delete(channel);
            this.modal.activeChannels.add(channel);
        } else {
            this.modal.channelDisabled.add(channel);
            this.modal.activeChannels.delete(channel);
        }
    // Sync with playback muting
        if (this.modal.playbackManager) {
            this.modal.playbackManager.syncMutedChannels();
        }
        this.modal.sequenceOps.updateSequenceFromActiveChannels(previousActiveChannels);
        this.modal.editActions.refreshChannelButtons();
    }

    _closeChannelSettingsPopover() {
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

    _toggleChannelSettingsPopover(channel, buttonEl) {
        const wasOpen = this.modal._channelSettingsOpen === channel;
        this._closeChannelSettingsPopover();

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
        this.modal.connectedDevices.forEach(device => {
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
            this._closeChannelSettingsPopover();
        };
        document.addEventListener('mousedown', this.modal._popoverOutsideClickHandler, true);

    // Close popover when toolbar scrolls (button moves but popover stays fixed)
        const toolbar = this.modal.container?.querySelector('.channels-toolbar');
        if (toolbar) {
            this.modal._popoverScrollHandler = () => this._closeChannelSettingsPopover();
            toolbar.addEventListener('scroll', this.modal._popoverScrollHandler);
        }

    // Event: delete channel button
        const deleteBtn = popover.querySelector('.channel-settings-delete-btn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._deleteChannel(channel);
            });
        }

    // Event: enabled checkbox
        const checkbox = popover.querySelector('.channel-enabled-checkbox');
        checkbox.addEventListener('change', () => {
            this.toggleChannelDisabled(channel);
            checkbox.checked = !this.modal.channelDisabled.has(channel);
        });

    // Event: playable notes toggle checkbox
        const playableCheckbox = popover.querySelector('.channel-playable-checkbox');
        playableCheckbox.addEventListener('change', async () => {
            if (playableCheckbox.disabled) return;
            await this._toggleChannelPlayableHighlight(channel);
            playableCheckbox.checked = this.modal.channelPlayableHighlights.has(channel);
    // Update chip visual
            this.modal.routingOps.updateChannelButtons();
        });

    // Event: routing select
        const routingSelect = popover.querySelector('.channel-routing-select');
        routingSelect.addEventListener('change', () => {
            const newValue = routingSelect.value || null;
            this.setChannelRouting(channel, newValue);
    // Update playable toggle state
            if (playableCheckbox) {
                playableCheckbox.disabled = !newValue;
                if (!newValue) {
                    this._clearChannelPlayableHighlight(channel);
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
            this.modal.channels.forEach(ch => {
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

    // Event: show all channels
        const showAllBtn = popover.querySelector('.channel-show-all-btn');
        showAllBtn.addEventListener('click', () => {
            const previousActiveChannels = new Set(this.modal.activeChannels);
            this.modal.channels.forEach(ch => {
                this.modal.activeChannels.add(ch.channel);
                this.modal.channelDisabled.delete(ch.channel);
            });
            this.modal.sequenceOps.updateSequenceFromActiveChannels(previousActiveChannels);
            this.modal.routingOps.updateChannelButtons();
            this.modal.renderer.updateInstrumentSelector();
            this.modal.syncMutedChannels();
        });

    }

    _deleteChannel(channel) {
        if (Array.isArray(this.modal.fullSequence)) {
            this.modal.fullSequence = this.modal.fullSequence.filter(n => n.c !== channel);
        }
        if (Array.isArray(this.modal.sequence)) {
            this.modal.sequence = this.modal.sequence.filter(n => n.c !== channel);
        }

        this.modal.channels = (this.modal.channels || []).filter(ch => ch.channel !== channel);
        this.modal.activeChannels?.delete(channel);
        this.modal.channelDisabled?.delete(channel);
        this.modal.channelRouting?.delete(channel);
        this.modal.channelPlayableHighlights?.delete(channel);
        this.modal._routedGmPrograms?.delete(channel);
        this.modal._splitChannelNames?.delete(channel);
        this.modal._stringInstrumentChannels?.delete(channel);
        this.modal._stringInstrumentCCEnabled?.delete(channel);

        this._closeChannelSettingsPopover();

        if (typeof this.modal.sequenceOps.updateSequenceFromActiveChannels === 'function') {
            this.modal.sequenceOps.updateSequenceFromActiveChannels(null, true);
        }
        if (typeof this.modal.editActions.refreshChannelButtons === 'function') this.modal.editActions.refreshChannelButtons();
        if (typeof this.modal.renderer.updateInstrumentSelector === 'function') this.modal.renderer.updateInstrumentSelector();
        if (typeof this.modal.syncMutedChannels === 'function') this.modal.syncMutedChannels();

        this.modal.isDirty = true;
        if (typeof this.modal.routingOps.updateSaveButton === 'function') this.modal.routingOps.updateSaveButton();
    }

    _updateChannelDisabledVisual(channel) {
        const chip = this.modal.container?.querySelector(`.channel-chip[data-channel="${channel}"]`);
        if (!chip) return;
        if (this.modal.channelDisabled.has(channel)) {
            chip.classList.add('channel-disabled');
        } else {
            chip.classList.remove('channel-disabled');
        }
    }

    _updateChipRouting(channel) {
        const chip = this.modal.container?.querySelector(`.channel-chip[data-channel="${channel}"]`);
        if (!chip) return;

        const content = chip.querySelector('.chip-content');
        if (!content) return;

    // Update or remove the routing sub-line
        let routeEl = content.querySelector('.chip-routing-line');
        const routedName = this.getRoutedInstrumentName(channel);

        if (routedName) {
            if (!routeEl) {
                routeEl = document.createElement('span');
                routeEl.className = 'chip-routing-line';
                content.appendChild(routeEl);
            }
            routeEl.textContent = `→ ${routedName}`;
            routeEl.title = routedName;
        } else if (routeEl) {
            routeEl.remove();
        }
    }

    _updateAllChipRoutings() {
        const chipGroups = this.modal.container?.querySelectorAll('.channel-chip-group');
        if (!chipGroups) return;

        chipGroups.forEach(group => {
            const chip = group.querySelector('.channel-chip');
            if (!chip) return;
            const ch = parseInt(chip.dataset.channel);
            if (!isNaN(ch)) {
                this._updateChipRouting(ch);
            }
        });
    }

    async _toggleChannelPlayableHighlight(channel) {
        if (this.modal.channelPlayableHighlights.has(channel)) {
    // Turn off
            this._clearChannelPlayableHighlight(channel);
            return;
        }

        const routedValue = this.modal.channelRouting.get(channel);
        if (!routedValue) return;

    // Parse deviceId and optional sub-channel
        let deviceId = routedValue;
        let devChannel = undefined;
        if (routedValue.includes('::')) {
            const parts = routedValue.split('::');
            deviceId = parts[0];
            devChannel = parseInt(parts[1]);
        }

        try {
            const params = { deviceId };
            if (devChannel !== undefined) params.channel = devChannel;
            const response = await this.modal.api.sendCommand('instrument_get_capabilities', params);

            if (response && response.capabilities) {
                const caps = response.capabilities;
                const mode = caps.note_selection_mode || 'range';
                let notes = null;

                if (mode === 'discrete' && caps.selected_notes && Array.isArray(caps.selected_notes)) {
                    notes = new Set(caps.selected_notes.map(n => parseInt(n)));
                } else if (mode === 'range') {
                    const minNote = caps.note_range_min != null ? parseInt(caps.note_range_min) : 0;
                    const maxNote = caps.note_range_max != null ? parseInt(caps.note_range_max) : 127;
                    if (minNote !== 0 || maxNote !== 127) {
                        notes = new Set();
                        for (let n = minNote; n <= maxNote; n++) notes.add(n);
                    }
                }

                if (notes && notes.size > 0) {
                    this.modal.channelPlayableHighlights.set(channel, notes);
                } else {
    // Full range = highlight all (store null to mean "all notes")
                    this.modal.channelPlayableHighlights.set(channel, null);
                }
            } else {
    // No capabilities = highlight all notes
                this.modal.channelPlayableHighlights.set(channel, null);
            }
        } catch (error) {
            this.modal.log('error', `Failed to load capabilities for channel ${channel}:`, error);
    // Fallback: highlight all notes
            this.modal.channelPlayableHighlights.set(channel, null);
        }

        this._syncPianoRollHighlights();
    }

    _clearChannelPlayableHighlight(channel) {
        this.modal.channelPlayableHighlights.delete(channel);
        this._syncPianoRollHighlights();
    }

    _syncPianoRollHighlights() {
        if (!this.modal.pianoRoll) return;

    // Build a structure the piano roll can use: Map<channel, {notes: Set|null, color: string}>
    // Only include highlights for visible (active) channels
        const highlights = new Map();
        this.modal.channelPlayableHighlights.forEach((notes, ch) => {
            if (!this.modal.activeChannels.has(ch)) return;
            const color = this.modal.channelColors[ch % this.modal.channelColors.length];
            highlights.set(ch, { notes, color });
        });

        this.modal.pianoRoll.channelPlayableHighlights = highlights;
        this.modal.pianoRoll._highlightsDirty = true;

        if (typeof this.modal.pianoRoll.invalidateGridBuffer === 'function') {
            this.modal.pianoRoll.invalidateGridBuffer();
        }
        if (typeof this.modal.pianoRoll.redraw === 'function') {
            this.modal.pianoRoll.redraw();
        }

    // Sync drum editor: auto-mute non-playable notes
        if (this.modal.drumPatternEditor && this.modal.drumPatternEditor.isVisible) {
            this.modal.drumPatternEditor.syncPlayableNoteMutes();
        }
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
            const deviceId = this.getEffectiveDeviceId();

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
                    stringInstrument = await this.findStringInstrument(activeChannel);
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
            const deviceId = this.getEffectiveDeviceId();
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
                    btn.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        this._openDrumPatternForChannel(ch);
                    });
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
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this._openTablatureForChannel(ch);
                });
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
                    windBtn.addEventListener('click', (ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        this._openWindEditorForChannel(ch);
                    });
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
                editBtn.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    this._openPianoRollForChannel(ch);
                });
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

    // Determine wind preset from channel's GM program
        const channelInfo = this.modal.channels?.find(c => c.channel === channel);
        const gmProgram = channelInfo?.program;
        const windPreset = typeof WindInstrumentDatabase !== 'undefined'
            ? WindInstrumentDatabase.getPresetByProgram(gmProgram)
            : null;

        if (!windPreset) {
            this.modal.log('warn', `No wind preset for program ${gmProgram} on channel ${channel}`);
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

    async showStringInstrumentConfig() {
        if (this.modal.activeChannels.size !== 1) return;

        const activeChannel = Array.from(this.modal.activeChannels)[0];
        const deviceId = this.getEffectiveDeviceId();
        const modal = new StringInstrumentConfigModal(this.modal.api, {
            deviceId: deviceId,
            channel: activeChannel,
            onSave: () => {
    // Refresh tablature button visibility
                if (this.modal.channelPanel) {
                    this.modal.channelPanel.updateTablatureButton();
                }
    // Refresh tablature editor if visible
                if (this.modal.tablatureEditor && this.modal.tablatureEditor.isVisible) {
                    this.toggleTablature(); // hide
                    this.toggleTablature(); // re-show with new config
                }
            }
        });
        await modal.showForDevice(deviceId, activeChannel);
    }

    async hasStringInstrument() {
        if (this.modal.activeChannels.size !== 1) {
            return false;
        }

        try {
            const activeChannel = Array.from(this.modal.activeChannels)[0];
            const result = await this.findStringInstrument(activeChannel);
            return !!result;
        } catch {
            return false;
        }
    }

    async findStringInstrument(channel) {
    // 1. If channel is routed, try the routed device's string instrument first
        if (this.modal.channelRouting.has(channel)) {
            const routedValue = this.modal.channelRouting.get(channel);
            let routedDeviceId = routedValue;
            let routedChannel = channel;
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
                if (resp?.instrument) return resp.instrument;
            } catch { /* continue */ }
        }

    // 2. Try with the effective device ID (selected device or '_editor')
        const primaryDeviceId = this.getEffectiveDeviceId();
        try {
            const resp = await this.modal.api.sendCommand('string_instrument_get', {
                device_id: primaryDeviceId,
                channel: channel
            });
            if (resp?.instrument) return resp.instrument;
        } catch { /* continue */ }

    // 3. If effective was a real device, also try '_editor'
        if (primaryDeviceId !== '_editor') {
            try {
                const resp = await this.modal.api.sendCommand('string_instrument_get', {
                    device_id: '_editor',
                    channel: channel
                });
                if (resp?.instrument) return resp.instrument;
            } catch { /* continue */ }
        }

    // 3. Search across all configured string instruments for this channel
        try {
            const resp = await this.modal.api.sendCommand('string_instrument_list', {});
            if (resp?.instruments) {
                const match = resp.instruments.find(si => si.channel === channel);
                if (match) return match;
            }
        } catch { /* continue */ }

        return null;
    }
    }

    if (typeof window !== 'undefined') {
        window.MidiEditorTablature = MidiEditorTablature;
    }
})();
