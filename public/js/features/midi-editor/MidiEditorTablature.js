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
            // Sub-features extracted from this god-class (audit §6.5).
            this.stringInstruments = typeof MidiEditorStringInstruments !== 'undefined'
                ? new MidiEditorStringInstruments(this)
                : null;
            this.specializedEditors = typeof MidiEditorSpecializedEditors !== 'undefined'
                ? new MidiEditorSpecializedEditors(this)
                : null;
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
            // Per-channel transposition surfaced as a chip badge so the
            // operator sees at a glance that a channel is shifted —
            // edited in the routing modal, read-only here.
            if (!this.modal._channelTranspositions) this.modal._channelTranspositions = new Map();
            this.modal._channelTranspositions.clear();

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
                    const semis = parseInt(routing.transposition_applied || 0) || 0;
                    if (semis !== 0) {
                        this.modal._channelTranspositions.set(routing.channel, semis);
                    }
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

    // Event: show all channels — same cleanup as the global Show-All button
        const showAllBtn = popover.querySelector('.channel-show-all-btn');
        showAllBtn.addEventListener('click', () => {
            const previousActiveChannels = new Set(this.modal.activeChannels);
            this._exitSpecializedEditor();
            this.modal._savedActiveChannels = null;
            this.modal.channels.forEach(ch => {
                this.modal.activeChannels.add(ch.channel);
                this.modal.channelDisabled.delete(ch.channel);
            });
            this.modal.sequenceOps.updateSequenceFromActiveChannels(previousActiveChannels);
            this.modal.routingOps.updateChannelButtons();
            this.modal.renderer.updateInstrumentSelector();
            this.modal.syncMutedChannels();
            this._closeChannelSettingsPopover();
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

        // Transposition badge: read-only here (modify via routing
        // modal). Hidden when 0 to keep chips compact.
        const semis = this.modal._channelTranspositions?.get(channel) || 0;
        let trEl = chip.querySelector('.chip-transpose-badge');
        if (semis !== 0) {
            if (!trEl) {
                trEl = document.createElement('span');
                trEl.className = 'chip-transpose-badge';
                trEl.style.cssText = 'display:inline-block;margin-left:4px;padding:1px 5px;border-radius:8px;background:#fef3c7;color:#92400e;font-size:10px;font-weight:600;line-height:1.4;border:1px solid #fcd34d;';
                chip.appendChild(trEl);
            }
            trEl.textContent = `${semis > 0 ? '+' : ''}${semis}st`;
            trEl.title = `${this.modal.t('autoAssign.transposition')}: ${semis > 0 ? '+' : ''}${semis}st`;
        } else if (trEl) {
            trEl.remove();
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
        let devChannel = NaN;
        if (routedValue.includes('::')) {
            const parts = routedValue.split('::');
            deviceId = parts[0];
            devChannel = parseInt(parts[1], 10);
        }

        try {
            const params = { deviceId };
            if (!isNaN(devChannel)) params.channel = devChannel;
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
        if (!this.modal.pianoRollRenderer?.isMounted()) return;

    // Build a structure the piano roll can use: Map<channel, {notes: Set|null, color: string}>
    // Only include highlights for visible (active) channels
        const highlights = new Map();
        this.modal.channelPlayableHighlights.forEach((notes, ch) => {
            if (!this.modal.activeChannels.has(ch)) return;
            const color = this.modal.channelColors[ch % this.modal.channelColors.length];
            highlights.set(ch, { notes, color });
        });

        this.modal.pianoRollRenderer?.setChannelPlayableHighlights(highlights);
        this.modal.pianoRollRenderer?.invalidateGridBuffer();
        this.modal.pianoRollRenderer?.redraw();

    // Sync drum editor: auto-mute non-playable notes
        if (this.modal.drumPatternEditor && this.modal.drumPatternEditor.isVisible) {
            this.modal.drumPatternEditor.syncPlayableNoteMutes();
        }
    }

    async toggleTablature()                  { return this.specializedEditors?.toggleTablature(); }
    _updateTabButtonState(active)            { this.specializedEditors?._updateTabButtonState(active); }
    async _openTablatureForChannel(channel)  { return this.specializedEditors?._openTablatureForChannel(channel); }
    async _refreshStringInstrumentChannels() { return this.specializedEditors?._refreshStringInstrumentChannels(); }
    _updateChannelTabButtons()               { this.specializedEditors?._updateChannelTabButtons(); }
    _openDrumPatternForChannel(channel)      { this.specializedEditors?._openDrumPatternForChannel(channel); }
    _updateDrumButtonState(active)           { this.specializedEditors?._updateDrumButtonState(active); }
    _openWindEditorForChannel(channel)       { this.specializedEditors?._openWindEditorForChannel(channel); }
    _updateWindButtonState(active)           { this.specializedEditors?._updateWindButtonState(active); }
    _saveActiveChannels()                    { this.specializedEditors?._saveActiveChannels(); }
    _restoreActiveChannels()                 { this.specializedEditors?._restoreActiveChannels(); }
    _exitSpecializedEditor()                 { this.specializedEditors?._exitSpecializedEditor(); }
    _openPianoRollForChannel(channel)        { this.specializedEditors?._openPianoRollForChannel(channel); }
    _updateEditButtonState(active)           { this.specializedEditors?._updateEditButtonState(active); }

    async showStringInstrumentConfig() { return this.stringInstruments?.showConfig(); }
    async hasStringInstrument()        { return this.stringInstruments?.has(); }
    async findStringInstrument(channel){ return this.stringInstruments?.find(channel); }

    }

    if (typeof window !== 'undefined') {
        window.MidiEditorTablature = MidiEditorTablature;
    }
})();
