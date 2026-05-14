// ============================================================================
// File: public/js/features/midi-editor/MidiEditorRouting.js
// Description: Routing, connected devices, preview source, piano-roll boot.
//   Sub-component class ; called via `modal.routingOps.<method>(...)`.
//   (P2-F.10g body rewrite — no longer a prototype mixin.)
// ============================================================================

(function() {
    'use strict';

    class MidiEditorRouting {
        constructor(modal) {
            this.modal = modal;
            this.playableNotes = typeof MidiEditorPlayableNotes !== 'undefined'
                ? new MidiEditorPlayableNotes(this)
                : null;
            this.pianoRollBoot = typeof MidiEditorPianoRollBoot !== 'undefined'
                ? new MidiEditorPianoRollBoot(this)
                : null;
            this.view = typeof MidiEditorView !== 'undefined'
                ? new MidiEditorView(this)
                : null;
        }

    async loadConnectedDevices() {
        try {
            const result = await this.modal.api.sendCommand('device_list');
            if (result && result.devices) {
    // Keep only devices that expose an output (output: true)
                const outputDevices = result.devices.filter(d => d.output === true);

    // Flatten multi-instrument devices into individual entries
                const expandedDevices = [];
                for (const device of outputDevices) {
                    if (device.instruments && device.instruments.length > 1) {
                        for (const inst of device.instruments) {
                            expandedDevices.push({
                                ...device,
                                _channel: inst.channel !== undefined ? inst.channel : 0,
                                _multiInstrument: true,
                                displayName: inst.custom_name || inst.name || device.displayName || device.name
                            });
                        }
                    } else {
                        expandedDevices.push(device);
                    }
                }
                this.modal.connectedDevices = expandedDevices;
                this.modal.log('info', `Loaded ${outputDevices.length} connected output devices (${expandedDevices.length} instruments)`);
            }
        } catch (error) {
            this.modal.log('error', 'Failed to load connected devices:', error);
            this.modal.connectedDevices = [];
        }
    }

    updateChannelButtons() {
        const chips = this.modal.container?.querySelectorAll('.channel-chip');
        if (!chips) return;

        const specializedActive = this.modal.editActions?._isSpecializedEditorActive();

        chips.forEach(chip => {
            const channel = parseInt(chip.dataset.channel);
            const color = chip.dataset.color;
            const isActive = this.modal.activeChannels.has(channel);

            if (isActive) {
                chip.classList.add('active');
                chip.style.cssText = `--chip-color: ${color}; --chip-bg: ${color}20; --chip-border: ${color}cc;`;
            } else {
                chip.classList.remove('active');
                chip.style.cssText = `--chip-color: ${color}; --chip-bg: transparent; --chip-border: ${color}4d;`;
            }

    // When a specialized editor is active, grey out non-active channel chips
            if (specializedActive && !isActive) {
                chip.classList.add('channel-locked');
            } else {
                chip.classList.remove('channel-locked');
            }

    // Update playable notes indicator
            const isPlayableHighlighted = this.modal.channelPlayableHighlights?.has(channel);
            chip.classList.toggle('playable-active', !!isPlayableHighlighted);
        });

    // Also update gear button border colors to match chip
        const gears = this.modal.container?.querySelectorAll('.chip-settings-btn');
        if (gears) {
            gears.forEach(gear => {
                const channel = parseInt(gear.dataset.channel);
                const chip = this.modal.container?.querySelector(`.channel-chip[data-channel="${channel}"]`);
                if (chip) {
                    gear.style.setProperty('--chip-border', chip.style.getPropertyValue('--chip-border'));
                }
            });
        }

    // "Show All" stays enabled even during specialized editing — it closes
    // the specialized editor and restores the full channel view.
        const showAllBtn = this.modal.container?.querySelector('.btn-show-all-channels');
        if (showAllBtn) {
            showAllBtn.disabled = false;
            showAllBtn.classList.remove('channel-locked');
        }

    // Update the note counter
        this.updateStats();
    }

    render() { return this.view?.render(); }

    // Delegates to pianoRollBoot sub-feature (extracted per audit §1.3)
    _refreshPianoRollSize() { return this.pianoRollBoot?.refreshSize() ?? false; }

    /**
     * Render DRUM / TAB / WIND mode buttons in the loop panel's toolbar
     * based on the current channel's GM program. Drum & wind families
     * are detected from the program range ; TAB is only offered when a
     * string-instrument config already exists in DB for the active
     * device (the loop editor itself never creates one).
     *
     * Re-render on every change of program / channel / device.
     */
    async _updateLoopSpecializedModeButtons() {
        if (!this.modal.loopMode) return;
        const host = this.modal.container?.querySelector('#loop-specialized-modes');
        if (!host) return;
        const ch = this.modal.channels?.[0];
        if (!ch) { host.innerHTML = ''; return; }
        const program = ch.program ?? 0;
        const channel = ch.channel ?? 0;
        const isDrum  = channel === 9;
        const windCat = (typeof MidiEditorChannelPanel !== 'undefined')
            ? MidiEditorChannelPanel.getWindInstrumentCategory(program) : null;
        const stringCat = (typeof MidiEditorChannelPanel !== 'undefined')
            ? MidiEditorChannelPanel.getStringInstrumentCategory(program) : null;

        // String instruments only get a TAB button when a config exists
        // for the active device — checked via `string_instrument_list`.
        let hasStringConfig = false;
        if (stringCat) {
            try {
                const deviceId = this.modal.tablatureOps?.getEffectiveDeviceId?.();
                const resp = await this.modal.api.sendCommand('string_instrument_list', { device_id: deviceId });
                if (resp?.instruments?.length) hasStringConfig = true;
            } catch { /* backend offline → no TAB */ }
        }

        const buttons = [];
        if (isDrum) {
            buttons.push(`<button class="tool-btn channel-drum-btn" data-channel="${channel}"
                title="${this.modal.t('drumPattern.toggleEditor')}">
                <span class="icon">🥁</span></button>`);
        }
        if (windCat) {
            buttons.push(`<button class="tool-btn channel-wind-btn" data-channel="${channel}"
                title="${this.modal.t('windEditor.icon')}">
                <span class="icon">🎺</span></button>`);
        }
        if (hasStringConfig) {
            buttons.push(`<button class="tool-btn channel-tab-btn" data-channel="${channel}" data-color="#0aa"
                title="${this.modal.t('midiEditor.tabButton')}">
                <span class="icon">🎸</span></button>`);
        }
        host.innerHTML = buttons.join('');
    }

    async initPianoRoll() { return this.pianoRollBoot?.initPianoRoll(); }

    updateStats() {
    // Previously showed the note count — removed to save space
    // The info is still visible in the channel buttons' tooltip
    }

    updateSaveButton() {
        const saveBtn = document.getElementById('save-btn');
        if (saveBtn) {
            if (this.modal.isDirty) {
                saveBtn.classList.add('btn-warning');
                saveBtn.innerHTML = `💾 ${this.modal.t('midiEditor.saveModified')}`;
            } else {
                saveBtn.classList.remove('btn-warning');
                saveBtn.innerHTML = `💾 ${this.modal.t('midiEditor.save')}`;
            }
        }
    }

    copySequence(sequence) {
        if (!sequence || sequence.length === 0) return [];
        return sequence.map(note => ({ t: note.t, g: note.g, n: note.n, c: note.c, v: note.v }));
    }

    // Delegates to playableNotes sub-feature (extracted per audit §1.3)
    async togglePreviewSource()                                { return this.playableNotes?.togglePreviewSource(); }
    async _loadRoutedPlayableNotes()                           { return this.playableNotes?.loadRoutedPlayableNotes(); }
    async togglePlayableNotesGlobal()                          { return this.playableNotes?.togglePlayableNotesGlobal(); }
    _getRoutedGmProgram(channel)                               { return this.playableNotes?.getRoutedGmProgram(channel) ?? null; }
    async _loadRoutedGmPrograms()                              { return this.playableNotes?.loadRoutedGmPrograms(); }
    async _fetchAndCacheRoutedGmProgram(channel, routedValue)  { return this.playableNotes?.fetchAndCacheRoutedGmProgram(channel, routedValue); }
    }

    if (typeof window !== 'undefined') {
        window.MidiEditorRouting = MidiEditorRouting;
    }
})();
