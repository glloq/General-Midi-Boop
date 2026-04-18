// Auto-extracted from KeyboardModal.js
(function() {
    'use strict';
    const KeyboardControlsMixin = {};


    /**
     * Envoyer un message CC modulation (CC#1) à l'instrument sélectionné
     * @param {number} value - Valeur de modulation (0-127)
     */
    KeyboardControlsMixin.initModWheel = function() {
        const track = document.getElementById('mod-wheel-track');
        const thumb = document.getElementById('mod-wheel-thumb');
        const fill = document.getElementById('mod-wheel-fill');
        const display = document.getElementById('keyboard-modulation-display');
        if (!track || !thumb) return;

        this._updateModWheelPosition(64);

        const getValueFromY = (clientY) => {
            const rect = track.getBoundingClientRect();
            const relativeY = clientY - rect.top;
            const ratio = 1 - (relativeY / rect.height);
            const clamped = Math.max(0, Math.min(1, ratio));
            return Math.round(clamped * 127);
        };

        const onMove = (clientY) => {
            if (!this._modWheelDragging) return;
            const value = getValueFromY(clientY);
            this.modulation = value;
            this._updateModWheelPosition(value);
            if (display) display.textContent = value;
            this.sendModulation(value);
        };

        const onEnd = () => {
            if (!this._modWheelDragging) return;
            this._modWheelDragging = false;
            // Remove global listeners when drag ends
            document.removeEventListener('mousemove', this._modWheelOnMove);
            document.removeEventListener('mouseup', this._modWheelOnEnd);
            document.removeEventListener('touchmove', this._modWheelOnTouchMove);
            document.removeEventListener('touchend', this._modWheelOnEnd);
            document.removeEventListener('touchcancel', this._modWheelOnEnd);
            thumb.classList.remove('dragging');
            thumb.classList.add('returning');
            fill.classList.add('returning');
            this.modulation = 64;
            this._updateModWheelPosition(64);
            if (display) display.textContent = '64';
            this.sendModulation(64);
            setTimeout(() => {
                thumb.classList.remove('returning');
                fill.classList.remove('returning');
            }, 300);
        };

        // Mouse events - attach global listeners only during drag
        this._modWheelOnTrackDown = (e) => {
            e.preventDefault();
            this._modWheelDragging = true;
            thumb.classList.add('dragging');
            thumb.classList.remove('returning');
            fill.classList.remove('returning');
            onMove(e.clientY);
            document.addEventListener('mousemove', this._modWheelOnMove);
            document.addEventListener('mouseup', this._modWheelOnEnd);
        };
        this._modWheelOnMove = (e) => onMove(e.clientY);
        this._modWheelOnEnd = onEnd;
        this._modWheelOnTouchStart = (e) => {
            e.preventDefault();
            this._modWheelDragging = true;
            thumb.classList.add('dragging');
            thumb.classList.remove('returning');
            fill.classList.remove('returning');
            onMove(e.touches[0].clientY);
            document.addEventListener('touchmove', this._modWheelOnTouchMove, { passive: false });
            document.addEventListener('touchend', this._modWheelOnEnd);
            document.addEventListener('touchcancel', this._modWheelOnEnd);
        };
        this._modWheelOnTouchMove = (e) => {
            if (this._modWheelDragging) onMove(e.touches[0].clientY);
        };

        track.addEventListener('mousedown', this._modWheelOnTrackDown);
        track.addEventListener('touchstart', this._modWheelOnTouchStart, { passive: false });
    }

    KeyboardControlsMixin._updateModWheelPosition = function(value) {
        const track = document.getElementById('mod-wheel-track');
        const thumb = document.getElementById('mod-wheel-thumb');
        const fill = document.getElementById('mod-wheel-fill');
        if (!track || !thumb) return;

        const trackHeight = track.clientHeight;
        const ratio = value / 127;
        const topPx = trackHeight * (1 - ratio);

        thumb.style.top = topPx + 'px';

        if (fill) {
            const centerPx = trackHeight * 0.5;
            if (topPx < centerPx) {
                fill.style.top = topPx + 'px';
                fill.style.height = (centerPx - topPx) + 'px';
            } else {
                fill.style.top = centerPx + 'px';
                fill.style.height = (topPx - centerPx) + 'px';
            }
        }
    }

    /**
     * Met à jour la visibilité des sliders vélocité et modulation
     * en fonction des capacités de l'instrument sélectionné
     */
    KeyboardControlsMixin.updateSlidersVisibility = function() {
        const velocityPanel = document.getElementById('velocity-control-panel');
        const modulationPanel = document.getElementById('modulation-control-panel');

        if (!velocityPanel || !modulationPanel) return;

        const caps = this.selectedDeviceCapabilities;

        if (!caps) {
            // Pas de capacités : afficher vélocité, masquer modulation
            velocityPanel.classList.remove('slider-hidden');
            modulationPanel.classList.add('slider-hidden');
            return;
        }

        // Vélocité : toujours visible si l'instrument supporte des notes
        const hasNotes = (caps.note_range_min !== null && caps.note_range_min !== undefined) ||
                         (caps.note_range_max !== null && caps.note_range_max !== undefined) ||
                         caps.note_selection_mode === 'discrete';
        if (hasNotes) {
            velocityPanel.classList.remove('slider-hidden');
        } else {
            velocityPanel.classList.add('slider-hidden');
        }

        // Modulation : visible si CC#1 est dans supported_ccs
        let supportsCCs = [];
        if (caps.supported_ccs) {
            try {
                supportsCCs = typeof caps.supported_ccs === 'string'
                    ? JSON.parse(caps.supported_ccs)
                    : caps.supported_ccs;
            } catch (e) {
                supportsCCs = [];
            }
        }

        if (Array.isArray(supportsCCs) && supportsCCs.includes(1)) {
            modulationPanel.classList.remove('slider-hidden');
        } else {
            modulationPanel.classList.add('slider-hidden');
        }
    }

    // ========================================================================
    // DEVICES
    // ========================================================================

    /**
     * Charger les paramètres depuis localStorage
     */
    KeyboardControlsMixin.loadSettings = function() {
        try {
            const saved = localStorage.getItem('maestro_settings');
            if (saved) {
                const settings = JSON.parse(saved);

                // Appliquer le nombre d'octaves (nouveau format)
                if (settings.keyboardOctaves !== undefined) {
                    this.setOctaves(settings.keyboardOctaves);
                    this.logger.info(`[KeyboardModal] Settings loaded: ${settings.keyboardOctaves} octaves`);
                }
                // Fallback: ancien format (nombre de touches)
                else if (settings.keyboardKeys !== undefined) {
                    this.setNumberOfKeys(settings.keyboardKeys);
                    this.logger.info(`[KeyboardModal] Settings loaded (legacy): ${settings.keyboardKeys} keys`);
                }
            }
        } catch (error) {
            this.logger.error('[KeyboardModal] Failed to load settings:', error);
        }
    }

    KeyboardControlsMixin.loadDevices = async function() {
        try {
            const devices = await this.backend.listDevices();
            let activeDevices = devices.filter(d => d.status === 2); // Actifs seulement

            // Dédupliquer par nom (au cas où le backend n'aurait pas tout dédupliqué)
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

            // Éclater les devices multi-instruments en entrées individuelles
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

            // Charger les instruments virtuels de la DB (créés via Gestion des instruments)
            // Respecter le réglage "virtualInstrument" de SettingsModal
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

            // Enrichir avec noms personnalisés
            this.devices = await Promise.all(this.devices.map(async (device) => {
                const deviceId = device.id || device.device_id;
                const normalizedDevice = {
                    ...device,
                    id: deviceId,
                    device_id: deviceId
                };

                // Ne pas appeler l'API pour le périphérique virtuel
                if (device.isVirtual) {
                    return normalizedDevice;
                }

                // Les devices multi-instruments ont déjà leur displayName depuis l'éclatement
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
    }

    if (typeof window !== 'undefined') window.KeyboardControlsMixin = KeyboardControlsMixin;
})();
