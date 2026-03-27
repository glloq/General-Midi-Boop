(function() {
    'use strict';
    const KeyboardDevices = {};

    KeyboardDevices.loadSettings = function() {
        try {
            const saved = localStorage.getItem('maestro_settings');
            if (saved) {
                const settings = JSON.parse(saved);
                // Apply octave count (new format)
                if (settings.keyboardOctaves !== undefined) {
                    this.setOctaves(settings.keyboardOctaves);
                    this.logger.info(`[KeyboardModal] Settings loaded: ${settings.keyboardOctaves} octaves`);
                }
                // Fallback: legacy format (key count)
                else if (settings.keyboardKeys !== undefined) {
                    this.setNumberOfKeys(settings.keyboardKeys);
                    this.logger.info(`[KeyboardModal] Settings loaded (legacy): ${settings.keyboardKeys} keys`);
                }
            }
        } catch (error) {
            this.logger.error('[KeyboardModal] Failed to load settings:', error);
        }
    };

    KeyboardDevices.loadDevices = async function() {
        try {
            const devices = await this.backend.listDevices();
            let activeDevices = devices.filter(d => d.status === 2);

            // Deduplicate by name
            const uniqueDevices = [];
            const seenNames = new Set();

            for (const device of activeDevices) {
                if (!seenNames.has(device.name)) {
                    seenNames.add(device.name);
                    uniqueDevices.push(device);
                    this.logger.debug('[KeyboardModal] ✓ Device kept:', device.name);
                } else {
                    this.logger.debug('[KeyboardModal] ✗ Device skipped (duplicate):', device.name);
                }
            }

            // Expand multi-instrument devices into individual entries
            const expandedDevices = [];
            for (const device of uniqueDevices) {
                if (device.instruments && device.instruments.length > 0) {
                    for (const inst of device.instruments) {
                        expandedDevices.push({
                            ...device,
                            channel: inst.channel !== undefined ? inst.channel : 0,
                            displayName: inst.custom_name || inst.name || device.name,
                            gm_program: inst.gm_program,
                            _instrumentId: inst.id,
                            _multiInstrument: true
                        });
                    }
                } else {
                    expandedDevices.push(device);
                }
            }
            this.devices = expandedDevices;
            this.logger.info(`[KeyboardModal] Loaded ${activeDevices.length} → ${uniqueDevices.length} unique devices → ${expandedDevices.length} instruments`);

            // Load virtual DB instruments (created via Instrument Management)
            let virtualEnabled = false;
            try {
                const savedSettings = localStorage.getItem('maestro_settings');
                if (savedSettings) {
                    const parsed = JSON.parse(savedSettings);
                    virtualEnabled = !!parsed.virtualInstrument;
                }
            } catch (e) { /* ignore */ }

            if (virtualEnabled) {
                try {
                    const capsResponse = await this.backend.sendCommand('instrument_list_capabilities');
                    if (capsResponse && capsResponse.instruments) {
                        const existingIds = new Set(this.devices.map(d => d.id || d.device_id));
                        for (const dbInst of capsResponse.instruments) {
                            const devId = dbInst.device_id || dbInst.id;
                            if (devId && devId.startsWith('virtual_') && !existingIds.has(devId)) {
                                const vName = dbInst.custom_name || dbInst.name || 'Virtual Instrument';
                                const virtualDbDevice = {
                                    id: devId,
                                    device_id: devId,
                                    name: `🖥️ ${vName}`,
                                    displayName: `🖥️ ${vName}`,
                                    type: 'Virtual',
                                    status: 2,
                                    connected: true,
                                    isVirtual: true,
                                    channel: dbInst.channel || 0,
                                    gm_program: dbInst.gm_program,
                                    customName: null
                                };
                                this.devices.push(virtualDbDevice);
                            }
                        }
                        this.logger.info('[KeyboardModal] Virtual DB instruments loaded');
                    }
                } catch (error) {
                    this.logger.warn('[KeyboardModal] Could not load virtual DB instruments:', error);
                }
            } else {
                this.logger.info('[KeyboardModal] Virtual instruments disabled in settings, skipping');
            }

            // Enrich with custom names
            this.devices = await Promise.all(this.devices.map(async (device) => {
                const deviceId = device.id || device.device_id;
                const normalizedDevice = {
                    ...device,
                    id: deviceId,
                    device_id: deviceId
                };

                // Don't call API for virtual device
                if (device.isVirtual) {
                    return normalizedDevice;
                }

                // Multi-instrument devices already have their displayName from expansion
                if (device._multiInstrument) {
                    return normalizedDevice;
                }

                try {
                    const response = await this.backend.sendCommand('instrument_get_settings', {
                        deviceId: deviceId
                    });
                    const settings = response.settings || {};
                    return {
                        ...normalizedDevice,
                        displayName: settings.custom_name || device.name,
                        customName: settings.custom_name
                    };
                } catch (error) {
                    return {
                        ...normalizedDevice,
                        displayName: device.name,
                        customName: null
                    };
                }
            }));
        } catch (error) {
            this.logger.error('[KeyboardModal] Failed to load devices:', error);
            this.devices = [];
        }
    };

    KeyboardDevices.populateDeviceSelect = function() {
        const select = document.getElementById('keyboard-device-select');
        if (!select) return;

        select.innerHTML = `<option value="">${this.t('common.select')}</option>`;

        this.devices.forEach(device => {
            const option = document.createElement('option');
            // For multi-instrument devices, include channel in value
            if (device._multiInstrument) {
                option.value = `${device.device_id}::${device.channel}`;
                const chLabel = `Ch${(device.channel || 0) + 1}`;
                option.textContent = `${device.displayName || device.name} [${chLabel}]`;
            } else {
                option.value = device.device_id;
                option.textContent = device.displayName || device.name;
            }
            select.appendChild(option);
        });
    };

    KeyboardDevices.refreshDevices = async function() {
        if (!this.isOpen) return;

        this.logger.info('[KeyboardModal] Refreshing devices...');
        await this.loadDevices();
        this.populateDeviceSelect();
    };

    KeyboardDevices.autoCenterKeyboard = function() {
        const caps = this.selectedDeviceCapabilities;
        if (!caps) {
            this.startNote = this.defaultStartNote;
            this._updateOctaveDisplay();
            this.logger.info('[KeyboardModal] Auto-center: no capabilities, reset to default');
            return;
        }

        // Determine effective range based on mode
        let effectiveMin, effectiveMax;

        if (caps.note_selection_mode === 'discrete' && caps.selected_notes) {
            try {
                const notes = typeof caps.selected_notes === 'string'
                    ? JSON.parse(caps.selected_notes)
                    : caps.selected_notes;
                if (Array.isArray(notes) && notes.length > 0) {
                    effectiveMin = Math.min(...notes);
                    effectiveMax = Math.max(...notes);
                }
            } catch (e) { /* ignore */ }
        }

        // Fallback on note_range_min/max
        if (effectiveMin === undefined || effectiveMax === undefined) {
            const minNote = Number(caps.note_range_min);
            const maxNote = Number(caps.note_range_max);
            if (!isFinite(minNote) && !isFinite(maxNote)) {
                this.startNote = this.defaultStartNote;
                this._updateOctaveDisplay();
                this.logger.info('[KeyboardModal] Auto-center: no note range, reset to default');
                return;
            }
            effectiveMin = isFinite(minNote) ? minNote : 21;
            effectiveMax = isFinite(maxNote) ? maxNote : 108;
        }

        // Center of playable range
        const rangeCenter = (effectiveMin + effectiveMax) / 2;
        const totalNotes = this.octaves * 12;

        // Ideal startNote to center view on playable range
        const idealStart = Math.round(rangeCenter - totalNotes / 2);

        // Clamp within MIDI bounds (0-127)
        this.startNote = Math.max(0, Math.min(127 - totalNotes, idealStart));

        this._updateOctaveDisplay();
        this.logger.info(`[KeyboardModal] Auto-center: range ${effectiveMin}-${effectiveMax}, center ${rangeCenter}, startNote ${this.startNote} (${this.getNoteNameFromNumber(this.startNote)})`);
    };

    if (typeof window !== 'undefined') window.KeyboardDevices = KeyboardDevices;
})();
