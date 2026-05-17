// Auto-extracted from KeyboardModal.js
(function() {
    'use strict';
    const KeyboardControlsMixin = {};


    /**
     * Send a CC modulation (CC#1) message to the selected instrument
     * @param {number} value - Modulation value (0-127)
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
     * Parse supported_ccs from instrument capabilities.
     * Handles both JSON-string and plain array forms from the backend.
     * @param {Object} caps - Instrument capabilities object
     * @returns {number[]}
     */
    KeyboardControlsMixin._parseSupportedCCs = function(caps) {
        if (!caps || !caps.supported_ccs) return [];
        try {
            const raw = caps.supported_ccs;
            return Array.isArray(raw) ? raw : JSON.parse(raw);
        } catch (e) {
            return [];
        }
    };

    /**
     * Update the visibility of the velocity and modulation sliders
     * based on the selected instrument's capabilities
     */
    KeyboardControlsMixin.updateSlidersVisibility = function() {
        const velocityPanel = document.getElementById('velocity-control-panel');
        const modulationPanel = document.getElementById('modulation-control-panel');
        const pitchBendPanel = document.getElementById('pitch-bend-control-panel');

        if (!velocityPanel || !modulationPanel) return;

        const caps = this.selectedDeviceCapabilities;

        const enableTransitionsNextFrame = () => {
            requestAnimationFrame(() => {
                velocityPanel.classList.remove('no-transition');
                modulationPanel.classList.remove('no-transition');
                if (pitchBendPanel) pitchBendPanel.classList.remove('no-transition');
            });
        };

        if (!caps) {
            velocityPanel.classList.remove('slider-hidden');
            modulationPanel.classList.add('slider-hidden');
            if (pitchBendPanel) pitchBendPanel.classList.add('slider-hidden');
            if (typeof this._updatePianoSliderGroupVisibility === 'function') {
                this._updatePianoSliderGroupVisibility();
            }
            enableTransitionsNextFrame();
            return;
        }

        // Velocity: always visible when a device is selected. Hide only when
        // the instrument is in discrete mode with an empty note list (truly no
        // playable notes). A null range means "all notes" and must show velocity.
        const noNotes = caps.note_selection_mode === 'discrete'
            && (!Array.isArray(caps.selected_notes) || caps.selected_notes.length === 0);
        velocityPanel.classList.toggle('slider-hidden', !!noNotes);

        // Modulation: visible if CC#1 is in supported_ccs
        const supportedCcs = this._parseSupportedCCs(caps);
        modulationPanel.classList.toggle('slider-hidden', !(Array.isArray(supportedCcs) && supportedCcs.includes(1)));

        // Pitch bend wheel: visible if pitch_bend_enabled is set on the instrument
        if (pitchBendPanel) {
            pitchBendPanel.classList.toggle('slider-hidden', !caps.pitch_bend_enabled);
        }

        // Piano slider toggle visibility
        if (typeof this._updatePianoSliderGroupVisibility === 'function') {
            this._updatePianoSliderGroupVisibility();
        }

        // List view controls (CC selector for Y, pitch bend toggle for X)
        this._updateListViewControls();

        enableTransitionsNextFrame();
    }

    /**
     * Initialise la roue de pitch bend (verticalslider, retour au centre à la release).
     */
    KeyboardControlsMixin.initPitchBendWheel = function() {
        const track = document.getElementById('pitch-bend-track');
        const thumb = document.getElementById('pitch-bend-thumb');
        const fill = document.getElementById('pitch-bend-fill');
        const display = document.getElementById('keyboard-pitchbend-display');
        if (!track || !thumb) return;

        this._updatePitchBendWheelPosition(64); // center = 64 maps to bend 0

        const getValueFromY = (clientY) => {
            const rect = track.getBoundingClientRect();
            const relativeY = clientY - rect.top;
            const ratio = 1 - (relativeY / rect.height);
            return Math.max(0, Math.min(1, ratio));
        };

        const ratiaToBend = (ratio) => Math.round((ratio - 0.5) * 2 * 8191);
        const ratioToDisplay = (ratio) => {
            const bend = ratiaToBend(ratio);
            return bend > 0 ? `+${bend}` : String(bend);
        };

        const onMove = (clientY) => {
            if (!this._pitchBendDragging) return;
            const ratio = getValueFromY(clientY);
            const uiVal = Math.round(ratio * 127); // for position
            this._updatePitchBendWheelPosition(uiVal);
            if (display) display.textContent = ratioToDisplay(ratio);
            this._sendPitchBend(ratiaToBend(ratio));
        };

        const onEnd = () => {
            if (!this._pitchBendDragging) return;
            this._pitchBendDragging = false;
            document.removeEventListener('mousemove', this._pitchBendOnMove);
            document.removeEventListener('mouseup', this._pitchBendOnEnd);
            document.removeEventListener('touchmove', this._pitchBendOnTouchMove);
            document.removeEventListener('touchend', this._pitchBendOnEnd);
            document.removeEventListener('touchcancel', this._pitchBendOnEnd);
            thumb.classList.remove('dragging');
            thumb.classList.add('returning');
            if (fill) fill.classList.add('returning');
            this._updatePitchBendWheelPosition(64);
            if (display) display.textContent = '0';
            this._sendPitchBend(0);
            setTimeout(() => {
                thumb.classList.remove('returning');
                if (fill) fill.classList.remove('returning');
            }, 300);
        };

        this._pitchBendOnTrackDown = (e) => {
            e.preventDefault();
            this._pitchBendDragging = true;
            thumb.classList.add('dragging');
            thumb.classList.remove('returning');
            if (fill) fill.classList.remove('returning');
            onMove(e.clientY);
            document.addEventListener('mousemove', this._pitchBendOnMove);
            document.addEventListener('mouseup', this._pitchBendOnEnd);
        };
        this._pitchBendOnMove = (e) => onMove(e.clientY);
        this._pitchBendOnEnd = onEnd;
        this._pitchBendOnTouchStart = (e) => {
            e.preventDefault();
            this._pitchBendDragging = true;
            thumb.classList.add('dragging');
            thumb.classList.remove('returning');
            if (fill) fill.classList.remove('returning');
            onMove(e.touches[0].clientY);
            document.addEventListener('touchmove', this._pitchBendOnTouchMove, { passive: false });
            document.addEventListener('touchend', this._pitchBendOnEnd);
            document.addEventListener('touchcancel', this._pitchBendOnEnd);
        };
        this._pitchBendOnTouchMove = (e) => {
            if (this._pitchBendDragging) onMove(e.touches[0].clientY);
        };

        track.addEventListener('mousedown', this._pitchBendOnTrackDown);
        track.addEventListener('touchstart', this._pitchBendOnTouchStart, { passive: false });
    }

    KeyboardControlsMixin._updatePitchBendWheelPosition = function(value) {
        const track = document.getElementById('pitch-bend-track');
        const thumb = document.getElementById('pitch-bend-thumb');
        const fill = document.getElementById('pitch-bend-fill');
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

    // ========================================================================
    // DEVICES
    // ========================================================================

    /**
     * Load settings from localStorage
     */
    KeyboardControlsMixin.loadSettings = function() {
        try {
            const saved = localStorage.getItem('gmboop_settings');
            if (saved) {
                const settings = JSON.parse(saved);

                // Apply the number of octaves (new format)
                if (settings.keyboardOctaves !== undefined) {
                    this.setOctaves(settings.keyboardOctaves);
                    this.logger.info(`[KeyboardModal] Settings loaded: ${settings.keyboardOctaves} octaves`);
                }
                // Fallback: old format (number of keys)
                else if (settings.keyboardKeys !== undefined) {
                    this.setNumberOfKeys(settings.keyboardKeys);
                    this.logger.info(`[KeyboardModal] Settings loaded (legacy): ${settings.keyboardKeys} keys`);
                }

                if (settings.keyboardNotation && ['english', 'solfege', 'midi'].includes(settings.keyboardNotation)) {
                    this.noteLabelFormat = settings.keyboardNotation;
                }

                // Physical keyboard layout (AZERTY / QWERTY) is owned by the
                // global settings modal — re-read it every time the modal opens.
                if (settings.keyboardLayout && ['azerty', 'qwerty'].includes(settings.keyboardLayout)) {
                    this.keyboardLayout = settings.keyboardLayout;
                }
            }
        } catch (error) {
            this.logger.error('[KeyboardModal] Failed to load settings:', error);
        }
    }

    KeyboardControlsMixin.loadDevices = async function() {
        try {
            // Fire device list and capabilities list in parallel.
            // instrument_list_capabilities already contains custom_name for every
            // registered (deviceId, channel) — we use it to build a lookup map so
            // we avoid making one instrument_get_settings call per device below.
            const [devices, capsResp] = await Promise.all([
                this.backend.listDevices(),
                this.backend.sendCommand('instrument_list_capabilities').catch((e) => {
                    this.logger?.warn('[KeyboardModal] instrument_list_capabilities failed; '
                        + 'custom names / virtual instruments degraded:', e);
                    return null;
                })
            ]);

            // Build a lookup: deviceId → custom_name (from the first channel row)
            const customNameMap = {};
            if (capsResp && Array.isArray(capsResp.instruments)) {
                for (const inst of capsResp.instruments) {
                    const id = inst.device_id || inst.id;
                    if (id && inst.custom_name && !customNameMap[id]) {
                        customNameMap[id] = inst.custom_name;
                    }
                }
            }

            let activeDevices = devices.filter(d => d.status === 2); // Active only

            // Deduplicate by device ID (primary key), falling back to name only
            // when no ID is available. Deduplicating by name alone would merge
            // two distinct physical devices that happen to share the same label.
            const uniqueDevices = [];
            const seenIds = new Set();

            for (const device of activeDevices) {
                const key = device.id || device.device_id || device.name;
                if (!seenIds.has(key)) {
                    seenIds.add(key);
                    uniqueDevices.push(device);
                    this.logger.debug('[KeyboardModal] ✓ Device kept:', device.name, '(id:', key, ')');
                } else {
                    this.logger.debug('[KeyboardModal] ✗ Device skipped (duplicate):', device.name, '(id:', key, ')');
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

            // Load virtual instruments from the DB (created via Instrument management)
            // Respect the "virtualInstrument" setting from SettingsModal
            let virtualEnabled = false;
            try {
                const savedSettings = localStorage.getItem('gmboop_settings');
                if (savedSettings) {
                    const parsed = JSON.parse(savedSettings);
                    virtualEnabled = !!parsed.virtualInstrument;
                }
            } catch (e) { /* ignore */ }

            if (virtualEnabled) {
                try {
                    // Reuse the capabilities already fetched above — no extra API call needed.
                    const capsResponse = capsResp;
                    if (capsResponse && capsResponse.instruments) {
                        // Surface every (device_id, channel) virtual instrument
                        // as its own selectable entry, mirroring the USB
                        // _multiInstrument expansion above. Deduping by
                        // device_id alone collapsed all channels of a
                        // multi-timbral virtual port to a single entry, hiding
                        // every instrument past the first.
                        const existingKeys = new Set(
                            this.devices.map(d => `${d.device_id || d.id}::${d.channel ?? 0}`)
                        );
                        for (const dbInst of capsResponse.instruments) {
                            const devId = dbInst.device_id || dbInst.id;
                            if (!devId || !devId.startsWith('virtual_')) continue;
                            const channel = dbInst.channel || 0;
                            const key = `${devId}::${channel}`;
                            if (existingKeys.has(key)) continue;
                            existingKeys.add(key);
                            const vName = dbInst.custom_name || dbInst.name || 'Virtual Instrument';
                            this.devices.push({
                                id: devId,
                                device_id: devId,
                                name: `🖥️ ${vName}`,
                                displayName: `🖥️ ${vName}`,
                                type: 'Virtual',
                                status: 2,
                                connected: true,
                                isVirtual: true,
                                channel: channel,
                                gm_program: dbInst.gm_program,
                                _instrumentId: dbInst.id,
                                _multiInstrument: true,
                                customName: null
                            });
                        }
                        this.logger.info('[KeyboardModal] Virtual DB instruments loaded');
                    }
                } catch (error) {
                    this.logger.warn('[KeyboardModal] Could not load virtual DB instruments:', error);
                }
            } else {
                this.logger.info('[KeyboardModal] Virtual instruments disabled in settings, skipping');
            }

            // Enrich with custom names using the pre-fetched capabilities map —
            // avoids N individual instrument_get_settings calls (one per device).
            this.devices = this.devices.map((device) => {
                const deviceId = device.id || device.device_id;
                const normalizedDevice = {
                    ...device,
                    id: deviceId,
                    device_id: deviceId
                };

                // Virtual and multi-instrument devices already carry their displayName.
                if (device.isVirtual || device._multiInstrument) {
                    return normalizedDevice;
                }

                const customName = customNameMap[deviceId] || null;
                return {
                    ...normalizedDevice,
                    displayName: customName || device.name,
                    customName: customName
                };
            });
        } catch (error) {
            this.logger.error('[KeyboardModal] Failed to load devices:', error);
            this.devices = [];
        }
    }

    // Noms humains pour les CC courants
    const CC_NAMES = {
        1: 'Modulation', 2: 'Breath', 4: 'Foot', 5: 'Portamento Time',
        7: 'Volume', 10: 'Pan', 11: 'Expression', 64: 'Sustain',
        65: 'Portamento', 71: 'Resonance', 72: 'Release', 73: 'Attack',
        74: 'Brightness', 75: 'Decay', 76: 'Vibrato Rate', 77: 'Vibrato Depth'
    };

    // Liste de CC proposée quand l'instrument n'en déclare aucun
    const DEFAULT_CC_LIST = [1, 2, 7, 10, 11, 64, 71, 72, 73, 74, 75, 76, 77];

    /**
     * Met à jour les contrôles spécifiques à la vue liste :
     * - Sélecteur de CC pour l'axe Y (variation en hauteur)
     * - Bouton d'activation du pitch bend pour l'axe X (déplacement horizontal)
     *
     * Toujours visibles en vue liste, indépendamment des capacités déclarées.
     * Appelé par updateSlidersVisibility() et setViewMode().
     */
    KeyboardControlsMixin._updateListViewControls = function () {
        const ccGroup  = document.getElementById('keyboard-list-cc-group');
        const pbGroup  = document.getElementById('keyboard-list-pb-group');
        const ccSelect = document.getElementById('keyboard-list-cc-select');
        const pbToggle = document.getElementById('keyboard-list-pb-toggle');

        const isListView = this.viewMode === 'keyboard-list';
        const caps = this.selectedDeviceCapabilities;

        // CC déclarés par l'instrument ; si aucun, on utilise la liste standard
        const supportedCcs = this._parseSupportedCCs(caps);
        const ccList = (Array.isArray(supportedCcs) && supportedCcs.length > 0)
            ? supportedCcs
            : DEFAULT_CC_LIST;

        // --- Groupe CC (axe Y) : toujours visible en vue liste ---
        if (ccGroup) ccGroup.classList.toggle('hidden', !isListView);

        if (ccSelect && isListView) {
            const previousVal = ccSelect.value;
            const velocityLabel = (typeof this.t === 'function') ? (this.t('keyboard.velocity') || 'Vélocité') : 'Vélocité';
            ccSelect.innerHTML = `<option value="">${velocityLabel}</option>`;
            for (const cc of ccList) {
                const opt = document.createElement('option');
                opt.value = String(cc);
                opt.textContent = CC_NAMES[cc] ? `CC#${cc} — ${CC_NAMES[cc]}` : `CC#${cc}`;
                ccSelect.appendChild(opt);
            }
            // Restaure la sélection précédente si elle est encore disponible
            const stillAvailable = [...ccSelect.options].some(o => o.value === previousVal);
            if (stillAvailable) {
                ccSelect.value = previousVal;
            } else {
                ccSelect.value = '';
                this.listViewYCC = null;
            }
        }

        // --- Groupe Pitch Bend (axe X) : toujours visible en vue liste ---
        if (pbGroup) pbGroup.classList.toggle('hidden', !isListView);

        if (pbToggle) {
            pbToggle.classList.toggle('active', this.listViewPitchBendEnabled);
            pbToggle.setAttribute('aria-pressed', String(this.listViewPitchBendEnabled));
        }
    };

    if (typeof window !== 'undefined') window.KeyboardControlsMixin = KeyboardControlsMixin;
})();
