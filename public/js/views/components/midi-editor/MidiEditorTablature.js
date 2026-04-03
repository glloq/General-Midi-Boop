// ============================================================================
// Fichier: public/js/views/components/midi-editor/MidiEditorTablature.js
// Description: Tablature/Drum/Wind editor bridges
//   Mixin: methodes ajoutees au prototype de MidiEditorModal
// ============================================================================

(function() {
    'use strict';

    const MidiEditorTablatureMixin = {};

    // ========================================================================
    // TABLATURE EDITOR
    // ========================================================================

    /**
    * Get the effective device ID for string instrument operations.
    * Returns '_editor' to allow tablature editing without a physical device.
    * @returns {string}
    */
    MidiEditorTablatureMixin.getEffectiveDeviceId = function() {
        return '_editor';
    }

    /**
    * Get the routed instrument display name for a channel.
    * Returns null if no routing is set for this channel.
    */
    MidiEditorTablatureMixin.getRoutedInstrumentName = function(channel) {
        const routedValue = this.channelRouting.get(channel);
        if (!routedValue) return null;

    // Find the matching device in connectedDevices
        for (const device of this.connectedDevices) {
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

    /**
    * Set channel routing to a specific connected device
    */
    MidiEditorTablatureMixin.setChannelRouting = async function(channel, deviceValue) {
    // Close the settings popover to prevent its capture-phase mousedown
    // handler from interfering with subsequent button clicks.
        this._closeChannelSettingsPopover();

        if (deviceValue) {
            this.channelRouting.set(channel, deviceValue);
        } else {
            this.channelRouting.delete(channel);
            this._routedGmPrograms.delete(channel);
        }
    // Clear stale playable note highlights — the old device capabilities
    // no longer apply to the new routing target.
        if (this.channelPlayableHighlights.has(channel)) {
            this._clearChannelPlayableHighlight(channel);
        }
    // Close TAB/WIND editors if open for this channel (routed instrument type may differ)
        if (this.tablatureEditor && this.tablatureEditor.isVisible && this.tablatureEditor.channel === channel) {
            this.tablatureEditor.hide();
            this._updateTabButtonState(false);
        }
        if (this.windInstrumentEditor && this.windInstrumentEditor.isVisible && this.windInstrumentEditor.channel === channel) {
            this.windInstrumentEditor.hide();
            this._updateWindButtonState(false);
        }
    // Fetch routed instrument gm_program for TAB/WIND button logic
        if (deviceValue) {
            await this._fetchAndCacheRoutedGmProgram(channel, deviceValue);
        }
    // Update only the affected chip routing label, then refresh TAB/WIND buttons
        this._updateChipRouting(channel);
        this._refreshStringInstrumentChannels();

    // Auto-enable playable notes highlight if global toggle is ON
        if (this.showPlayableNotes && deviceValue && !this.channelPlayableHighlights.has(channel)) {
            this._toggleChannelPlayableHighlight(channel);
        }

    // Persist routing to database, then notify external components
    // (file list, routing modal) so they read fresh data from DB
        this._syncRoutingToDB().then(() => {
            this._emitRoutingChanged();
        });
    }

    /**
    * Load saved routings from the database and populate channelRouting Map.
    * Must be called after loadConnectedDevices() so we can build correct routing keys.
    */
    MidiEditorTablatureMixin._loadSavedRoutings = async function() {
        if (!this.currentFile) return;
        try {
            const result = await this.api.sendCommand('get_file_routings', { fileId: this.currentFile });

    // Clear previous routing state before repopulating
            this.channelRouting.clear();

            if (result && result.routings && result.routings.length > 0) {
    // Build a lookup of multi-instrument devices
                const multiInstrumentDevices = new Set();
                for (const device of this.connectedDevices) {
                    if (device._multiInstrument) {
                        multiInstrumentDevices.add(device.id);
                    }
                }

                for (const routing of result.routings) {
                    if (routing.channel == null || !routing.device_id) continue;
    // Reconstruct the routing key: deviceId::targetChannel for multi-instrument, otherwise deviceId
                    const isMulti = multiInstrumentDevices.has(routing.device_id);
                    const routingKey = isMulti
                        ? `${routing.device_id}::${routing.target_channel != null ? routing.target_channel : routing.channel}`
                        : routing.device_id;
                    this.channelRouting.set(routing.channel, routingKey);
                }

                this.log('info', `Restored ${this.channelRouting.size} saved channel routing(s) from database`);
            }

    // Fetch gm_programs for all routed instruments (needed for TAB/WIND buttons & preview)
            await this._loadRoutedGmPrograms();

    // Use non-destructive DOM updates instead of refreshChannelButtons()
    // which uses innerHTML and destroys elements under the cursor,
    // breaking hover/click state on all channel buttons.
            this._updateAllChipRoutings();
            this.updateChannelButtons();
            this._refreshStringInstrumentChannels();

            if (this.channelRouting.size > 0) {
                this._emitRoutingChanged();
            }
        } catch (error) {
            this.log('warn', 'Failed to load saved routings:', error);
        }
    }

    /**
    * Persist current channelRouting Map to the database via file_routing_sync.
    */
    MidiEditorTablatureMixin._syncRoutingToDB = function() {
        if (!this.currentFile) return Promise.resolve();
        const channels = {};
        this.channelRouting.forEach((deviceValue, ch) => {
    // Routing key may be "deviceId::targetChannel" for multi-instrument devices
            channels[String(ch)] = deviceValue;
        });
        return this.api.sendCommand('file_routing_sync', {
            fileId: this.currentFile,
            channels
        }).catch(err => {
            this.log('warn', 'Failed to sync routing to DB:', err);
        });
    }

    /**
    * Emit routing:changed event so external components (file list, routing modal)
    * can update their state. Builds a channels object from channelRouting Map.
    */
    MidiEditorTablatureMixin._emitRoutingChanged = function() {
        if (!this.currentFile) return;
        const channels = {};
        this.channelRouting.forEach((deviceValue, ch) => {
            channels[String(ch)] = deviceValue;
        });
        if (this.eventBus) {
            this._isEmittingRouting = true;
            this.eventBus.emit('routing:changed', {
                fileId: this.currentFile,
                channels
            });
            this._isEmittingRouting = false;
        }
    }

    /**
    * Toggle channel disabled state
    */
    MidiEditorTablatureMixin.toggleChannelDisabled = function(channel) {
        if (this.channelDisabled.has(channel)) {
            this.channelDisabled.delete(channel);
        } else {
            this.channelDisabled.add(channel);
        }
    // Sync with playback muting
        if (this.playbackManager) {
            this.playbackManager.syncMutedChannels();
        }
        this.refreshChannelButtons();
    }

    /**
    * Open/close channel settings popover
    */
    /**
    * Close channel settings popover and clean up its outside-click handler.
    */
    MidiEditorTablatureMixin._closeChannelSettingsPopover = function() {
        if (this._channelSettingsPopoverEl) {
            this._channelSettingsPopoverEl.remove();
            this._channelSettingsPopoverEl = null;
        }
    // Also remove any stale popover from document.body (defensive)
        const stale = document.body.querySelector('.channel-settings-popover');
        if (stale) stale.remove();

    // Clean up global mousedown listener
        if (this._popoverOutsideClickHandler) {
            document.removeEventListener('mousedown', this._popoverOutsideClickHandler, true);
            this._popoverOutsideClickHandler = null;
        }
    // Clean up toolbar scroll listener
        if (this._popoverScrollHandler) {
            const toolbar = this.container?.querySelector('.channels-toolbar');
            if (toolbar) toolbar.removeEventListener('scroll', this._popoverScrollHandler);
            this._popoverScrollHandler = null;
        }
        this._channelSettingsOpen = -1;
    }

    MidiEditorTablatureMixin._toggleChannelSettingsPopover = function(channel, buttonEl) {
        const wasOpen = this._channelSettingsOpen === channel;
        this._closeChannelSettingsPopover();

    // If same channel, just close (already done above)
        if (wasOpen) {
            return;
        }

        this._channelSettingsOpen = channel;

        const isDisabled = this.channelDisabled.has(channel);
        const currentRouting = this.channelRouting.get(channel) || '';
        const isHighlighted = this.channelPlayableHighlights.has(channel);

    // Build device options
        let deviceOptions = `<option value="">${this.t('midiEditor.noRouting')}</option>`;
        this.connectedDevices.forEach(device => {
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
            deviceOptions += `<option value="${value}" ${selected}>${name}</option>`;
        });

        const hasRouting = !!currentRouting;
        const color = this.channelColors[channel % this.channelColors.length];

        const popover = document.createElement('div');
        popover.className = 'channel-settings-popover';
        popover.innerHTML = `
            <div class="channel-settings-header">
                <span>⚙ ${this.t('midiEditor.channelSettingsTitle', { channel: channel + 1 })}</span>
            </div>
            <div class="channel-settings-section">
                <label class="channel-settings-toggle">
                    <input type="checkbox" class="channel-enabled-checkbox" ${!isDisabled ? 'checked' : ''}>
                    <span>🔊</span>
                    <span>${this.t('midiEditor.channelEnabled')}</span>
                </label>
            </div>
            <div class="channel-settings-section">
                <label class="channel-settings-toggle">
                    <input type="checkbox" class="channel-playable-checkbox" ${isHighlighted ? 'checked' : ''} ${!hasRouting ? 'disabled' : ''}>
                    <span class="playable-color-dot" style="background: ${color}"></span>
                    <span>${this.t('midiEditor.showPlayableNotes')}</span>
                </label>
                ${!hasRouting ? `<span class="channel-settings-hint">${this.t('midiEditor.playableRequiresRouting')}</span>` : ''}
            </div>
            <div class="channel-settings-section">
                <label class="channel-settings-label">🔌 ${this.t('midiEditor.channelRoutingLabel')}</label>
                <span class="channel-settings-hint">${this.t('midiEditor.channelRoutingHint')}</span>
                <select class="channel-routing-select">${deviceOptions}</select>
            </div>
            <div class="channel-settings-section channel-visibility-actions">
                <label class="channel-settings-label">👁 ${this.t('midiEditor.visibilityTitle')}</label>
                <div class="channel-visibility-btns">
                    <button class="channel-hide-others-btn">👁 ${this.t('midiEditor.hideOtherChannels')}</button>
                    <button class="channel-show-all-btn">👁 ${this.t('midiEditor.showAllChannels')}</button>
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
        this._channelSettingsPopoverEl = popover;

    // Close popover on any outside click (global listener on document)
        this._popoverOutsideClickHandler = (e) => {
            if (popover.contains(e.target)) return;
            if (e.target.closest('.chip-settings-btn')) return;
            this._closeChannelSettingsPopover();
        };
        document.addEventListener('mousedown', this._popoverOutsideClickHandler, true);

    // Close popover when toolbar scrolls (button moves but popover stays fixed)
        const toolbar = this.container?.querySelector('.channels-toolbar');
        if (toolbar) {
            this._popoverScrollHandler = () => this._closeChannelSettingsPopover();
            toolbar.addEventListener('scroll', this._popoverScrollHandler);
        }

    // Event: enabled checkbox
        const checkbox = popover.querySelector('.channel-enabled-checkbox');
        checkbox.addEventListener('change', () => {
            if (checkbox.checked && this.channelDisabled.has(channel)) {
                this.channelDisabled.delete(channel);
            } else if (!checkbox.checked && !this.channelDisabled.has(channel)) {
                this.channelDisabled.add(channel);
            }
            if (this.playbackManager) {
                this.playbackManager.syncMutedChannels();
            }
            this._updateChannelDisabledVisual(channel);
        });

    // Event: playable notes toggle checkbox
        const playableCheckbox = popover.querySelector('.channel-playable-checkbox');
        playableCheckbox.addEventListener('change', async () => {
            if (playableCheckbox.disabled) return;
            await this._toggleChannelPlayableHighlight(channel);
            playableCheckbox.checked = this.channelPlayableHighlights.has(channel);
    // Update chip visual
            this.updateChannelButtons();
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
                    this.updateChannelButtons();
                }
            }
        });

    // Event: hide other channels (solo this one)
        const hideOthersBtn = popover.querySelector('.channel-hide-others-btn');
        hideOthersBtn.addEventListener('click', () => {
            const previousActiveChannels = new Set(this.activeChannels);
            this.activeChannels.clear();
            this.activeChannels.add(channel);
            this.updateSequenceFromActiveChannels(previousActiveChannels);
            this.updateChannelButtons();
            this.updateInstrumentSelector();
            this.syncMutedChannels();
        });

    // Event: show all channels
        const showAllBtn = popover.querySelector('.channel-show-all-btn');
        showAllBtn.addEventListener('click', () => {
            const previousActiveChannels = new Set(this.activeChannels);
            this.channels.forEach(ch => this.activeChannels.add(ch.channel));
            this.updateSequenceFromActiveChannels(previousActiveChannels);
            this.updateChannelButtons();
            this.updateInstrumentSelector();
            this.syncMutedChannels();
        });

    }

    /**
    * Update visual state of a disabled channel button
    */
    MidiEditorTablatureMixin._updateChannelDisabledVisual = function(channel) {
        const chip = this.container?.querySelector(`.channel-chip[data-channel="${channel}"]`);
        if (!chip) return;
        if (this.channelDisabled.has(channel)) {
            chip.classList.add('channel-disabled');
        } else {
            chip.classList.remove('channel-disabled');
        }
    }

    /**
    * Update routing indicator on a single channel chip (non-destructive).
    * Avoids refreshChannelButtons() which would rebuild all DOM and break hover/click.
    * Only updates the routing label — TAB/WIND buttons are managed centrally
    * by _refreshStringInstrumentChannels() using _routedGmPrograms cache.
    */
    MidiEditorTablatureMixin._updateChipRouting = function(channel) {
        const chip = this.container?.querySelector(`.channel-chip[data-channel="${channel}"]`);
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

    /**
    * Non-destructive update of routing indicators on ALL channel chips.
    * Iterates through every chip group and calls _updateChipRouting for each,
    * preserving existing DOM elements (no innerHTML rebuild).
    */
    MidiEditorTablatureMixin._updateAllChipRoutings = function() {
        const chipGroups = this.container?.querySelectorAll('.channel-chip-group');
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

    /**
    * Toggle playable notes highlight for a specific channel.
    * Loads capabilities from the routed device and highlights playable rows on the piano roll.
    */
    MidiEditorTablatureMixin._toggleChannelPlayableHighlight = async function(channel) {
        if (this.channelPlayableHighlights.has(channel)) {
    // Turn off
            this._clearChannelPlayableHighlight(channel);
            return;
        }

        const routedValue = this.channelRouting.get(channel);
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
            const response = await this.api.sendCommand('instrument_get_capabilities', params);

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
                    this.channelPlayableHighlights.set(channel, notes);
                } else {
    // Full range = highlight all (store null to mean "all notes")
                    this.channelPlayableHighlights.set(channel, null);
                }
            } else {
    // No capabilities = highlight all notes
                this.channelPlayableHighlights.set(channel, null);
            }
        } catch (error) {
            this.log('error', `Failed to load capabilities for channel ${channel}:`, error);
    // Fallback: highlight all notes
            this.channelPlayableHighlights.set(channel, null);
        }

        this._syncPianoRollHighlights();
    }

    /**
    * Remove playable notes highlight for a channel
    */
    MidiEditorTablatureMixin._clearChannelPlayableHighlight = function(channel) {
        this.channelPlayableHighlights.delete(channel);
        this._syncPianoRollHighlights();
    }

    /**
    * Push channel playable highlights to the piano roll and redraw
    */
    MidiEditorTablatureMixin._syncPianoRollHighlights = function() {
        if (!this.pianoRoll) return;

    // Build a structure the piano roll can use: Map<channel, {notes: Set|null, color: string}>
    // Only include highlights for visible (active) channels
        const highlights = new Map();
        this.channelPlayableHighlights.forEach((notes, ch) => {
            if (!this.activeChannels.has(ch)) return;
            const color = this.channelColors[ch % this.channelColors.length];
            highlights.set(ch, { notes, color });
        });

        this.pianoRoll.channelPlayableHighlights = highlights;
        this.pianoRoll._highlightsDirty = true;

        if (typeof this.pianoRoll.invalidateGridBuffer === 'function') {
            this.pianoRoll.invalidateGridBuffer();
        }
        if (typeof this.pianoRoll.redraw === 'function') {
            this.pianoRoll.redraw();
        }

    // Sync drum editor: auto-mute non-playable notes
        if (this.drumPatternEditor && this.drumPatternEditor.isVisible) {
            this.drumPatternEditor.syncPlayableNoteMutes();
        }
    }

    /**
    * Toggle tablature editor for the active channel's string instrument
    */
    MidiEditorTablatureMixin.toggleTablature = async function() {
    // If tablature is visible, hide it and restore piano roll
        if (this.tablatureEditor && this.tablatureEditor.isVisible) {
            this.tablatureEditor.hide();
            this._updateTabButtonState(false);
            return;
        }

    // Require exactly one active channel
        if (this.activeChannels.size !== 1) {
            this.log('warn', 'Tablature requires exactly one active channel');
            return;
        }

        const activeChannel = Array.from(this.activeChannels)[0];

        try {
    // Always sync with GM preset to ensure correct tuning/strings
            const channelInfo = this.channels.find(ch => ch.channel === activeChannel);
            const gmMatch = channelInfo ? MidiEditorChannelPanel.getStringInstrumentCategory(channelInfo.program) : null;

            if (gmMatch) {
                await this.api.sendCommand('string_instrument_create_from_preset', {
                    device_id: this.getEffectiveDeviceId(),
                    channel: activeChannel,
                    preset: gmMatch.preset
                });
                this.log('info', `Synced ${gmMatch.category} preset for channel ${activeChannel + 1}`);
            }

            let stringInstrument = await this.findStringInstrument(activeChannel);

            if (!stringInstrument) {
                this.log('info', 'No string instrument configured for this channel');
                this.showNotification(
                    this.t('tablature.noStringInstrument') || 'Configure this channel as a string instrument in the instrument settings first.',
                    'info'
                );
                return;
            }

    // Get notes for this channel
            const channelNotes = (this.fullSequence || []).filter(n => n.c === activeChannel);

    // Hide wind editor if visible
            if (this.windInstrumentEditor && this.windInstrumentEditor.isVisible) {
                this.windInstrumentEditor.hide();
                this._updateWindButtonState(false);
            }

    // Hide drum editor if visible
            if (this.drumPatternEditor && this.drumPatternEditor.isVisible) {
                this.drumPatternEditor.hide();
                this._updateDrumButtonState(false);
            }

    // Create or show tablature editor (replaces piano roll in the same space)
            if (!this.tablatureEditor) {
                this.tablatureEditor = new TablatureEditor(this);
            }

            await this.tablatureEditor.show(stringInstrument, channelNotes, activeChannel);
            this._updateTabButtonState(true);

        } catch (error) {
            this.log('error', 'Failed to toggle tablature:', error);
        }
    }

    /**
    * Update the TAB button active state on channel buttons
    * @param {boolean} active
    */
    MidiEditorTablatureMixin._updateTabButtonState = function(_active) {
        this._updateChannelTabButtons();
    }

    /**
    * Open tablature for a specific channel (called from channel TAB sub-buttons)
    * @param {number} channel
    */
    MidiEditorTablatureMixin._openTablatureForChannel = async function(channel) {
    // If tablature is already visible for this channel, toggle it off and restore channels
        if (this.tablatureEditor && this.tablatureEditor.isVisible
            && this.tablatureEditor.channel === channel) {
            this.tablatureEditor.hide();
            this._updateTabButtonState(false);
            this._restoreActiveChannels();
            return;
        }

    // Save active channels before switching (only saves once for direct editor switches)
        this._saveActiveChannels();

    // Ensure only this channel is active
        const previousActiveChannels = new Set(this.activeChannels);
        this.activeChannels.clear();
        this.activeChannels.add(channel);
        this._pianoRollSoloChannel = null;

        this.updateSequenceFromActiveChannels(previousActiveChannels);
        if (this.channelPanel) {
            this.channelPanel.updateChannelButtons();
            this.channelPanel.updateInstrumentSelector();
        }

    // If tablature is visible for a different channel, hide it first
        if (this.tablatureEditor && this.tablatureEditor.isVisible) {
            this.tablatureEditor.hide();
        }

    // Hide drum pattern editor if visible (mutually exclusive)
        if (this.drumPatternEditor && this.drumPatternEditor.isVisible) {
            this.drumPatternEditor.hide();
            this._updateDrumButtonState(false);
        }

    // Hide wind editor if visible (mutually exclusive)
        if (this.windInstrumentEditor && this.windInstrumentEditor.isVisible) {
            this.windInstrumentEditor.hide();
            this._updateWindButtonState(false);
        }

    // Now open tablature for the channel
        await this.toggleTablature();
    }

    /**
    * Scan database for channels with string instrument configs and reveal their TAB buttons.
    * Called after channel list changes or device selection changes.
    */
    MidiEditorTablatureMixin._refreshStringInstrumentChannels = async function() {
        if (!this._stringInstrumentChannels) {
            this._stringInstrumentChannels = new Set();
        }
        if (!this._stringInstrumentCCEnabled) {
            this._stringInstrumentCCEnabled = new Map();
        }

    // Guard against concurrent calls — if a refresh is already in flight,
    // mark that another one was requested and return. The running call will
    // re-run once it finishes.
        if (this._refreshStringInstrumentPending) {
            this._refreshStringInstrumentQueued = true;
            return;
        }
        this._refreshStringInstrumentPending = true;

        try { // outer try for concurrency guard
        try {
    // Filter by effective device to avoid showing TAB for instruments
    // configured on other devices
            const deviceId = this.getEffectiveDeviceId();
            const resp = await this.api.sendCommand('string_instrument_list', {
                device_id: deviceId
            });
            if (resp?.instruments) {
                this._stringInstrumentChannels.clear();
                this._stringInstrumentCCEnabled.clear();
                for (const si of resp.instruments) {
                    this._stringInstrumentChannels.add(si.channel);
                    this._stringInstrumentCCEnabled.set(si.channel, si.cc_enabled !== false);
                }
            }
        } catch { /* ignore */ }

    // Add/remove TAB buttons per channel based on string instrument detection
        const chipGroups = this.container?.querySelectorAll('.channel-chip-group');
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
                    btn.title = this.t('drumPattern.toggleEditor');
                    btn.textContent = this.t('midiEditor.drumButton');
                    btn.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        this._openDrumPatternForChannel(ch);
                    });
                    group.appendChild(btn);
                }
                return;
            }

            const channelInfo = this.channels?.find(c => c.channel === ch);
    // Determine effective GM program: use routed instrument's gm_program if available
            const hasRouting = this.channelRouting.has(ch);
            const routedGm = this._routedGmPrograms.get(ch);
            const effectiveProgram = (hasRouting && routedGm != null) ? routedGm : (channelInfo?.program ?? null);

    // String instrument detection: check effective program (routed or GM)
            const isGmString = effectiveProgram != null &&
                typeof MidiEditorChannelPanel !== 'undefined' &&
                MidiEditorChannelPanel.getStringInstrumentCategory(effectiveProgram) !== null;
            const ccEnabled = this._stringInstrumentCCEnabled.get(ch);
            const isStringInstrument = isGmString && ccEnabled !== false;

            const existingTabBtn = group.querySelector('.channel-tab-btn');

            if (isStringInstrument && !existingTabBtn) {
    // Add TAB button for newly detected string instrument
                const color = channelChip.dataset.color || '#667eea';
                const btn = document.createElement('button');
                btn.className = 'channel-tab-btn';
                btn.dataset.channel = ch;
                btn.dataset.color = color;
                btn.title = this.t('tablature.tabButton', { instrument: channelInfo?.instrument || this.t('stringInstrument.string') });
                btn.textContent = this.t('midiEditor.tabButton');
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
                    windBtn.title = this.t('windEditor.windEditorTitle', { name: WindInstrumentDatabase.getPresetByProgram(effectiveProgram)?.name || this.t('windEditor.icon') });
                    windBtn.textContent = this.t('midiEditor.windButton');
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
                editBtn.title = this.t('midiEditor.editChannel');
                editBtn.textContent = this.t('midiEditor.editButton');
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
            this._refreshStringInstrumentPending = false;
    // If another refresh was requested while we were running, re-run now
    // with fresh DOM state.
            if (this._refreshStringInstrumentQueued) {
                this._refreshStringInstrumentQueued = false;
                this._refreshStringInstrumentChannels();
            }
        }
    }

    /**
    * Update active state of all channel TAB sub-buttons
    */
    MidiEditorTablatureMixin._updateChannelTabButtons = function() {
        const tabBtns = this.container?.querySelectorAll('.channel-tab-btn');
        if (!tabBtns) return;

        const isTabVisible = this.tablatureEditor && this.tablatureEditor.isVisible;
        const tabChannel = isTabVisible ? this.tablatureEditor.channel : -1;

        tabBtns.forEach(btn => {
            const ch = parseInt(btn.dataset.channel);
            btn.classList.toggle('active', isTabVisible && ch === tabChannel);
        });
    }

    // ========================================================================
    // DRUM PATTERN EDITOR
    // ========================================================================

    /**
    * Open drum pattern editor for a specific channel
    * @param {number} channel - MIDI channel (typically 9)
    */
    MidiEditorTablatureMixin._openDrumPatternForChannel = function(channel) {
    // Toggle off if already visible for this channel — restore saved channels
        if (this.drumPatternEditor && this.drumPatternEditor.isVisible && this.drumPatternEditor.channel === channel) {
            this.drumPatternEditor.hide();
            this._updateDrumButtonState(false);
            this._restoreActiveChannels();
            return;
        }

    // Save active channels before switching (only saves once for direct editor switches)
        this._saveActiveChannels();

    // Check if a specialty editor is currently managing notes (piano roll is stale)
        const specialtyEditorWasActive =
            (this.tablatureEditor && this.tablatureEditor.isVisible) ||
            (this.windInstrumentEditor && this.windInstrumentEditor.isVisible) ||
            (this.drumPatternEditor && this.drumPatternEditor.isVisible);

    // Hide other specialty editors FIRST (they already synced to fullSequence)
        if (this.tablatureEditor && this.tablatureEditor.isVisible) {
            this.tablatureEditor.hide();
            this._updateChannelTabButtons();
        }
        if (this.windInstrumentEditor && this.windInstrumentEditor.isVisible) {
            this.windInstrumentEditor.hide();
            this._updateWindButtonState(false);
        }

    // Ensure only this channel is active
    // Skip piano roll sync if a specialty editor was active (fullSequence is already current)
        this.activeChannels.clear();
        this.activeChannels.add(channel);
        this._pianoRollSoloChannel = null;
        this.updateSequenceFromActiveChannels(new Set([channel]), specialtyEditorWasActive);
        this.refreshChannelButtons();

    // Get MIDI notes for this channel
        const channelNotes = (this.fullSequence || []).filter(n => n.c === channel);

    // Create editor on first use
        if (!this.drumPatternEditor) {
            this.drumPatternEditor = new DrumPatternEditor(this);
        }

        this.drumPatternEditor.show(channelNotes, channel);
        this._updateDrumButtonState(true);
    }

    /**
    * Update active state of DRUM buttons
    * @param {boolean} active
    */
    MidiEditorTablatureMixin._updateDrumButtonState = function(active) {
        const drumBtns = this.container?.querySelectorAll('.channel-drum-btn');
        if (!drumBtns) return;

        const drumChannel = this.drumPatternEditor?.channel;
        drumBtns.forEach(btn => {
            const ch = parseInt(btn.dataset.channel);
            btn.classList.toggle('active', active && ch === drumChannel);
        });
    }

    // ========================================================================
    // WIND INSTRUMENT EDITOR
    // ========================================================================

    /**
    * Open wind instrument editor for a specific channel
    * @param {number} channel - MIDI channel with brass/reed/pipe program
    */
    MidiEditorTablatureMixin._openWindEditorForChannel = function(channel) {
    // Toggle off if already visible for this channel — restore saved channels
        if (this.windInstrumentEditor && this.windInstrumentEditor.isVisible && this.windInstrumentEditor.channel === channel) {
            this.windInstrumentEditor.hide();
            this._updateWindButtonState(false);
            this._restoreActiveChannels();
            return;
        }

    // Save active channels before switching (only saves once for direct editor switches)
        this._saveActiveChannels();

    // Check if a specialty editor is currently managing notes (piano roll is stale)
        const specialtyEditorWasActive =
            (this.tablatureEditor && this.tablatureEditor.isVisible) ||
            (this.windInstrumentEditor && this.windInstrumentEditor.isVisible) ||
            (this.drumPatternEditor && this.drumPatternEditor.isVisible);

    // Hide other specialty editors FIRST (they already synced to fullSequence)
        if (this.tablatureEditor && this.tablatureEditor.isVisible) {
            this.tablatureEditor.hide();
            this._updateChannelTabButtons();
        }
        if (this.drumPatternEditor && this.drumPatternEditor.isVisible) {
            this.drumPatternEditor.hide();
            this._updateDrumButtonState(false);
        }

    // Ensure only this channel is active
    // Skip piano roll sync if a specialty editor was active (fullSequence is already current)
        this.activeChannels.clear();
        this.activeChannels.add(channel);
        this._pianoRollSoloChannel = null;
        this.updateSequenceFromActiveChannels(new Set([channel]), specialtyEditorWasActive);
        this.refreshChannelButtons();

    // Determine wind preset from channel's GM program
        const channelInfo = this.channels?.find(c => c.channel === channel);
        const gmProgram = channelInfo?.program;
        const windPreset = typeof WindInstrumentDatabase !== 'undefined'
            ? WindInstrumentDatabase.getPresetByProgram(gmProgram)
            : null;

        if (!windPreset) {
            this.log('warn', `No wind preset for program ${gmProgram} on channel ${channel}`);
            return;
        }

    // Get MIDI notes for this channel
        const channelNotes = (this.fullSequence || []).filter(n => n.c === channel);

    // Create editor on first use
        if (!this.windInstrumentEditor) {
            this.windInstrumentEditor = new WindInstrumentEditor(this);
        }

        this.windInstrumentEditor.show(windPreset, channelNotes, channel);
        this._updateWindButtonState(true);
    }

    /**
    * Update active state of WIND buttons
    * @param {boolean} active
    */
    MidiEditorTablatureMixin._updateWindButtonState = function(active) {
        const windBtns = this.container?.querySelectorAll('.channel-wind-btn');
        if (!windBtns) return;

        const windChannel = this.windInstrumentEditor?.channel;
        windBtns.forEach(btn => {
            const ch = parseInt(btn.dataset.channel);
            btn.classList.toggle('active', active && ch === windChannel);
        });
    }

    // ========================================================================
    // SAVE / RESTORE ACTIVE CHANNELS
    // ========================================================================

    /**
    * Save current active channels before opening a specialized editor.
    * Does NOT overwrite if already saved (supports direct editor-to-editor switches).
    */
    MidiEditorTablatureMixin._saveActiveChannels = function() {
        if (!this._savedActiveChannels) {
            this._savedActiveChannels = new Set(this.activeChannels);
        }
    }

    /**
    * Restore previously saved active channels after closing a specialized editor.
    */
    MidiEditorTablatureMixin._restoreActiveChannels = function() {
        if (!this._savedActiveChannels) return;

        const previousActiveChannels = new Set(this.activeChannels);
        this.activeChannels = new Set(this._savedActiveChannels);
        this._savedActiveChannels = null;
        this._pianoRollSoloChannel = null;

        this.updateSequenceFromActiveChannels(previousActiveChannels);
        if (this.channelPanel) {
            this.channelPanel.updateChannelButtons();
            this.channelPanel.updateInstrumentSelector();
        }
        if (this.playbackManager) {
            this.playbackManager.syncMutedChannels();
        }
    }

    // ========================================================================
    // PIANO ROLL SOLO EDIT (for channels without specialized editors)
    // ========================================================================

    /**
    * Open piano roll focused on a single channel (solo edit mode).
    * Used for channels that don't have TAB/WIND/DRUM specialized editors.
    * @param {number} channel - MIDI channel to solo-edit
    */
    MidiEditorTablatureMixin._openPianoRollForChannel = function(channel) {
        // Toggle off if already in solo mode for this channel
        if (this._pianoRollSoloChannel === channel) {
            this._pianoRollSoloChannel = null;
            this._restoreActiveChannels();
            this._updateEditButtonState(false);
            return;
        }

        // Hide any open specialized editor
        if (this.tablatureEditor && this.tablatureEditor.isVisible) {
            this.tablatureEditor.hide();
            this._updateChannelTabButtons();
        }
        if (this.drumPatternEditor && this.drumPatternEditor.isVisible) {
            this.drumPatternEditor.hide();
            this._updateDrumButtonState(false);
        }
        if (this.windInstrumentEditor && this.windInstrumentEditor.isVisible) {
            this.windInstrumentEditor.hide();
            this._updateWindButtonState(false);
        }

        this._saveActiveChannels();

        const previousActiveChannels = new Set(this.activeChannels);
        this.activeChannels.clear();
        this.activeChannels.add(channel);
        this._pianoRollSoloChannel = channel;

        this.updateSequenceFromActiveChannels(previousActiveChannels);
        this.refreshChannelButtons();
        this._updateEditButtonState(true);
    }

    /**
    * Update active state of EDIT buttons
    * @param {boolean} active
    */
    MidiEditorTablatureMixin._updateEditButtonState = function(active) {
        const editBtns = this.container?.querySelectorAll('.channel-edit-btn');
        if (!editBtns) return;

        const soloChannel = this._pianoRollSoloChannel;
        editBtns.forEach(btn => {
            const ch = parseInt(btn.dataset.channel);
            btn.classList.toggle('active', active && ch === soloChannel);
        });
    }

    /**
    * Open the string instrument configuration modal
    */
    MidiEditorTablatureMixin.showStringInstrumentConfig = async function() {
        if (this.activeChannels.size !== 1) return;

        const activeChannel = Array.from(this.activeChannels)[0];
        const deviceId = this.getEffectiveDeviceId();
        const modal = new StringInstrumentConfigModal(this.api, {
            deviceId: deviceId,
            channel: activeChannel,
            onSave: () => {
    // Refresh tablature button visibility
                if (this.channelPanel) {
                    this.channelPanel.updateTablatureButton();
                }
    // Refresh tablature editor if visible
                if (this.tablatureEditor && this.tablatureEditor.isVisible) {
                    this.toggleTablature(); // hide
                    this.toggleTablature(); // re-show with new config
                }
            }
        });
        await modal.showForDevice(deviceId, activeChannel);
    }

    /**
    * Check if the active channel has a string instrument configured
    * @returns {Promise<boolean>}
    */
    MidiEditorTablatureMixin.hasStringInstrument = async function() {
        if (this.activeChannels.size !== 1) {
            return false;
        }

        try {
            const activeChannel = Array.from(this.activeChannels)[0];
            const result = await this.findStringInstrument(activeChannel);
            return !!result;
        } catch {
            return false;
        }
    }

    /**
    * Find a string instrument config for a channel, searching multiple device IDs.
    * Priority: selected device > '_editor' > any device with matching channel.
    * @param {number} channel - MIDI channel
    * @returns {Promise<Object|null>} The instrument config, or null
    */
    MidiEditorTablatureMixin.findStringInstrument = async function(channel) {
    // 1. Try with the effective device ID (selected device or '_editor')
        const primaryDeviceId = this.getEffectiveDeviceId();
        try {
            const resp = await this.api.sendCommand('string_instrument_get', {
                device_id: primaryDeviceId,
                channel: channel
            });
            if (resp?.instrument) return resp.instrument;
        } catch { /* continue */ }

    // 2. If effective was a real device, also try '_editor'
        if (primaryDeviceId !== '_editor') {
            try {
                const resp = await this.api.sendCommand('string_instrument_get', {
                    device_id: '_editor',
                    channel: channel
                });
                if (resp?.instrument) return resp.instrument;
            } catch { /* continue */ }
        }

    // 3. Search across all configured string instruments for this channel
        try {
            const resp = await this.api.sendCommand('string_instrument_list', {});
            if (resp?.instruments) {
                const match = resp.instruments.find(si => si.channel === channel);
                if (match) return match;
            }
        } catch { /* continue */ }

        return null;
    }


    if (typeof window !== 'undefined') {
        window.MidiEditorTablatureMixin = MidiEditorTablatureMixin;
    }
})();
