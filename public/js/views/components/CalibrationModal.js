// ============================================================================
// Fichier: js/views/components/CalibrationModal.js
// Version: v1.0.0
// Description:
//   Modal de calibration des délais audio via microphone.
//   Fonctionnalités:
//   - Mode simple/avancé avec toggle
//   - VU-mètre temps réel du niveau micro
//   - Indicateurs de statut par instrument (waiting/running/success/error)
//   - Bouton preview note (test MIDI)
//   - Graphique Canvas des résultats de calibration
//   - Support i18n et thèmes (dark, colored)
//
// Dépendances: BaseModal.js, BackendAPIClient, EventBus, i18n
// ============================================================================

class CalibrationModal extends BaseModal {
    constructor(api, eventBus) {
        super({
            id: 'calibration-modal',
            size: 'lg',
            title: 'calibration.title',
            customClass: 'calibration-modal'
        });

        this.api = api || null;
        this.eventBus = eventBus || window.eventBus || null;
        this.logger = window.logger || console;

        // State
        this.state = {
            selectedInstruments: [],
            results: {},
            isRunning: false,
            isAdvancedMode: localStorage.getItem('calibration_advanced_mode') === 'true',
            isMonitoring: false,
            instrumentStatuses: {} // key: 'deviceId:channel' => 'idle' | 'waiting' | 'running' | 'success' | 'error'
        };

        // Instruments loaded from API
        this.instruments = [];
        this.alsaDevices = [];

        // VU-meter animation
        this._vuMeterRAF = null;
        this._currentRMS = 0;
        this._peakRMS = 0;

        // WebSocket listener references
        this._onAudioLevel = null;
        this._onDeviceListUpdate = null;

        this.logger.info('CalibrationModal', '✓ Modal initialized v1.0.0');
    }

    /**
     * Get the API client. Falls back to window.api if not set at construction time.
     * This handles the case where CalibrationModal is instantiated before connectWebSocket().
     */
    _getApi() {
        return this.api || window.api || window.apiClient;
    }

    // ========================================================================
    // RENDER
    // ========================================================================

    renderBody() {
        const isAdvanced = this.state.isAdvancedMode;
        return `
            <!-- Mode Toggle -->
            <div class="calibration-mode-toggle">
                <label class="${!isAdvanced ? 'active' : ''}" data-mode="simple">${this.t('calibration.modeSimple')}</label>
                <button class="calibration-mode-switch ${isAdvanced ? 'active' : ''}" id="calibModeSwitch" type="button"
                        aria-label="Toggle advanced mode"></button>
                <label class="${isAdvanced ? 'active' : ''}" data-mode="advanced">${this.t('calibration.modeAdvanced')}</label>
            </div>

            <!-- Advanced Settings Section (collapsible) -->
            <div class="calibration-advanced-section ${isAdvanced ? 'visible' : ''}" id="calibAdvancedSection">
                <div class="calibration-section">
                    <h3>⚙️ ${this.t('calibration.micSettings')}</h3>

                    <div class="calibration-field">
                        <label for="calibAlsaDevice">${this.t('calibration.alsaDevice')}:</label>
                        <div style="display: flex; gap: 8px; align-items: center;">
                            <select id="calibAlsaDevice" class="calibration-select" style="flex:1;">
                                <option value="hw:1,0">hw:1,0 (Default USB Audio)</option>
                            </select>
                            <button class="btn btn-sm" id="calibRefreshAlsa" type="button">🔄 ${this.t('calibration.refresh')}</button>
                        </div>
                    </div>

                    <div class="calibration-field">
                        <label for="calibThreshold">${this.t('calibration.threshold')}:</label>
                        <div class="calibration-slider-container">
                            <input type="range" id="calibThreshold"
                                   min="0.01" max="0.10" step="0.005" value="0.02"
                                   class="calibration-slider">
                            <span id="calibThresholdValue" class="calibration-value">0.020</span>
                        </div>
                        <small class="calibration-hint">${this.t('calibration.thresholdHint')}</small>
                    </div>

                    <div class="calibration-field">
                        <label for="calibMeasurements">${this.t('calibration.measurements')}:</label>
                        <input type="number" id="calibMeasurements"
                               min="1" max="10" value="5"
                               class="calibration-input" style="max-width: 120px;">
                        <small class="calibration-hint">${this.t('calibration.measurementsHint')}</small>
                    </div>
                </div>
            </div>

            <!-- VU-Meter (always visible) -->
            <div class="calibration-section">
                <div class="calibration-vu-meter" id="calibVuMeter">
                    <div class="calibration-vu-meter-label">
                        <span>🎤 ${this.t('calibration.vuMeter')}</span>
                        <span class="calibration-vu-meter-rms" id="calibRmsValue">0.000</span>
                    </div>
                    <div class="calibration-vu-meter-bar">
                        <div class="calibration-vu-meter-fill" id="calibVuFill"></div>
                        <div class="calibration-vu-meter-threshold" id="calibVuThreshold" style="left: 20%;"></div>
                    </div>
                </div>
            </div>

            <!-- Instruments Selection -->
            <div class="calibration-section">
                <h3>🎹 ${this.t('calibration.selectInstruments')}</h3>

                <div class="calibration-select-all">
                    <label>
                        <input type="checkbox" id="calibSelectAll">
                        <span>${this.t('calibration.selectAll')}</span>
                    </label>
                </div>

                <div id="calibInstrumentsList" class="calibration-instruments-list">
                    <div class="calibration-no-instruments">${this.t('calibration.noInstruments')}</div>
                </div>
            </div>

            <!-- Progress Section (hidden by default) -->
            <div class="calibration-section" id="calibProgress" style="display: none;">
                <h3>📊 ${this.t('calibration.progress')}</h3>
                <div class="calibration-progress-bar">
                    <div class="calibration-progress-fill" id="calibProgressFill" role="progressbar"
                         aria-valuenow="0" aria-valuemin="0" aria-valuemax="100" style="width: 0%">
                        0%
                    </div>
                </div>
                <div class="calibration-current-status" id="calibStatus">
                    ${this.t('calibration.statusWaiting')}...
                </div>
            </div>

            <!-- Results Section (hidden by default) -->
            <div class="calibration-section" id="calibResults" style="display: none;">
                <h3>✅ ${this.t('calibration.results')}</h3>
                <div id="calibResultsList" class="calibration-results-list"></div>
                <div class="calibration-chart-container" id="calibChartContainer"></div>
            </div>
        `;
    }

    renderFooter() {
        return `
            <button class="btn btn-secondary" id="calibCancelBtn" type="button">${this.t('common.cancel')}</button>
            <button class="btn btn-primary" id="calibStartBtn" type="button" disabled>
                🎤 ${this.t('calibration.startCalibration')}
            </button>
            <button class="btn btn-success" id="calibApplyBtn" type="button" style="display: none;">
                ✅ ${this.t('calibration.applyDelays')}
            </button>
        `;
    }

    // ========================================================================
    // LIFECYCLE
    // ========================================================================

    onOpen() {
        this._attachEventHandlers();
        this._loadInstruments();
        this._loadAlsaDevices();
        this._startMonitoring();
        this._updateThresholdIndicator();
    }

    onClose() {
        this._stopMonitoring();
        this._detachEventHandlers();

        // Reset state
        this.state.isRunning = false;
        this.state.results = {};
        this.state.selectedInstruments = [];
        this.state.instrumentStatuses = {};
    }

    onUpdate() {
        // BaseModal.update() replaces body HTML on locale change.
        // Re-attach event handlers and reload dynamic data.
        this._detachEventHandlers();
        this._attachEventHandlers();
        this._loadInstruments();
        this._loadAlsaDevices();
        this._updateThresholdIndicator();
    }

    // ========================================================================
    // EVENT HANDLERS
    // ========================================================================

    _attachEventHandlers() {
        // Mode toggle
        const modeSwitch = this.$('#calibModeSwitch');
        if (modeSwitch) {
            modeSwitch.addEventListener('click', () => this._toggleMode());
        }

        // Cancel button
        const cancelBtn = this.$('#calibCancelBtn');
        if (cancelBtn) cancelBtn.addEventListener('click', () => this.close());

        // Start button
        const startBtn = this.$('#calibStartBtn');
        if (startBtn) startBtn.addEventListener('click', () => this._startCalibration());

        // Apply button
        const applyBtn = this.$('#calibApplyBtn');
        if (applyBtn) applyBtn.addEventListener('click', () => this._applyResults());

        // Refresh ALSA
        const refreshBtn = this.$('#calibRefreshAlsa');
        if (refreshBtn) refreshBtn.addEventListener('click', () => this._loadAlsaDevices());

        // Threshold slider
        const slider = this.$('#calibThreshold');
        if (slider) {
            slider.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                const display = this.$('#calibThresholdValue');
                if (display) display.textContent = val.toFixed(3);
                this._updateThresholdIndicator();
            });
        }

        // Select all
        const selectAll = this.$('#calibSelectAll');
        if (selectAll) {
            selectAll.addEventListener('change', (e) => {
                const checkboxes = this.$$('.calibration-instrument-checkbox');
                checkboxes.forEach(cb => { cb.checked = e.target.checked; });
                this._updateSelectedInstruments();
            });
        }

        // Audio level listener (events come from BackendAPIClient, not EventBus)
        this._onAudioLevel = (data) => {
            this._currentRMS = data.rms || 0;
            if (data.peak !== undefined) this._peakRMS = data.peak;
        };

        const api = this._getApi();
        if (api && api.on) {
            api.on('calibration:audio_level', this._onAudioLevel);
        }

        // Device list change listener - refresh instruments when devices connect/disconnect
        this._onDeviceListUpdate = () => {
            if (this.isOpen && !this.state.isRunning) {
                this._loadInstruments();
            }
        };

        if (api && api.on) {
            api.on('device_list', this._onDeviceListUpdate);
        }
    }

    _detachEventHandlers() {
        const api = this._getApi();
        if (api && api.off && this._onAudioLevel) {
            api.off('calibration:audio_level', this._onAudioLevel);
            this._onAudioLevel = null;
        }
        if (api && api.off && this._onDeviceListUpdate) {
            api.off('device_list', this._onDeviceListUpdate);
            this._onDeviceListUpdate = null;
        }
    }

    // ========================================================================
    // MODE TOGGLE
    // ========================================================================

    _toggleMode() {
        this.state.isAdvancedMode = !this.state.isAdvancedMode;
        localStorage.setItem('calibration_advanced_mode', this.state.isAdvancedMode.toString());

        const section = this.$('#calibAdvancedSection');
        const switchEl = this.$('#calibModeSwitch');
        const labels = this.$$('.calibration-mode-toggle label');

        if (section) section.classList.toggle('visible', this.state.isAdvancedMode);
        if (switchEl) switchEl.classList.toggle('active', this.state.isAdvancedMode);

        if (labels.length >= 2) {
            labels[0].classList.toggle('active', !this.state.isAdvancedMode);
            labels[1].classList.toggle('active', this.state.isAdvancedMode);
        }
    }

    // ========================================================================
    // LOAD DATA
    // ========================================================================

    async _loadInstruments() {
        const listEl = this.$('#calibInstrumentsList');
        if (!listEl) {
            console.warn('[CalibrationModal] #calibInstrumentsList not found in DOM');
            return;
        }

        try {
            this.instruments = [];

            // Use sendCommand directly (same pattern as InstrumentManagementPage)
            const response = await this._getApi().sendCommand('device_list', {});
            const allDevices = (response && response.devices) ? response.devices : [];

            console.log('[CalibrationModal] device_list returned', allDevices.length, 'devices:',
                allDevices.map(d => `"${d.displayName || d.name}" (type=${d.type}, output=${d.output}, status=${d.status}, connected=${d.connected})`));

            // Filter: only connected devices that have output capability
            const devices = allDevices.filter(d => d.output !== false && (d.status === 2 || d.connected));

            console.log('[CalibrationModal] After filter:', devices.length, 'devices');

            for (const device of devices) {
                // Device has a sub-array of configured instruments (multi-channel)
                if (device.instruments && device.instruments.length > 0) {
                    for (const inst of device.instruments) {
                        const channel = inst.channel !== undefined ? inst.channel : 0;
                        const name = inst.custom_name || inst.name || device.displayName || device.name || device.id;
                        const displayName = `${name} - Ch ${channel + 1}`;
                        this.instruments.push({
                            deviceId: device.id,
                            deviceName: device.displayName || device.name || device.id,
                            channel: channel,
                            displayName: displayName,
                            key: `${device.id}:${channel}`
                        });
                    }
                } else {
                    // No configured instruments: show the device itself on channel 0
                    const name = device.displayName || device.name || device.id;
                    this.instruments.push({
                        deviceId: device.id,
                        deviceName: name,
                        channel: 0,
                        displayName: name,
                        key: `${device.id}:0`
                    });
                }
            }

            console.log('[CalibrationModal] Instruments built:', this.instruments.length,
                this.instruments.map(i => `"${i.displayName}" (${i.key})`));

            if (this.instruments.length === 0) {
                listEl.innerHTML = `<div class="calibration-no-instruments">${this.t('calibration.noConnected')}</div>`;
                return;
            }

            listEl.innerHTML = this.instruments.map(inst => `
                <div class="calibration-instrument-item" data-key="${this.escape(inst.key)}">
                    <input type="checkbox" class="calibration-instrument-checkbox"
                           id="calib_inst_${this.escape(inst.key)}"
                           value="${this.escape(inst.key)}">
                    <div class="calibration-instrument-info">
                        <div class="calibration-instrument-name">${this.escape(inst.displayName)}</div>
                        <div class="calibration-instrument-details">Device: ${this.escape(inst.deviceName)}</div>
                    </div>
                    <button class="calibration-preview-btn" type="button"
                            data-device-id="${this.escape(String(inst.deviceId))}"
                            data-channel="${inst.channel}"
                            title="${this.t('calibration.previewNote')}">
                        🔊 ${this.t('calibration.previewNote')}
                    </button>
                    <div class="calibration-instrument-status idle" id="calib_status_${this.escape(inst.key)}"></div>
                </div>
            `).join('');

            // Checkbox listeners
            listEl.querySelectorAll('.calibration-instrument-checkbox').forEach(cb => {
                cb.addEventListener('change', () => this._updateSelectedInstruments());
            });

            // Click on item to toggle
            listEl.querySelectorAll('.calibration-instrument-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    if (e.target.type === 'checkbox' || e.target.closest('.calibration-preview-btn')) return;
                    const checkbox = item.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        checkbox.checked = !checkbox.checked;
                        this._updateSelectedInstruments();
                    }
                });
            });

            // Preview buttons
            listEl.querySelectorAll('.calibration-preview-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const deviceId = btn.dataset.deviceId;
                    const channel = parseInt(btn.dataset.channel);
                    this._previewNote(deviceId, channel, btn);
                });
            });

        } catch (error) {
            console.error('[CalibrationModal] Failed to load instruments:', error);
            this.logger.error('CalibrationModal', 'Failed to load instruments:', error?.message || error);
            listEl.innerHTML = `<div class="calibration-no-instruments">${this.t('calibration.noInstruments')}</div>`;
        }
    }

    async _loadAlsaDevices() {
        try {
            const response = await this._getApi().sendCommand('calibrate_list_alsa_devices', {});
            if (response.success && response.devices && response.devices.length > 0) {
                this.alsaDevices = response.devices;
                const select = this.$('#calibAlsaDevice');
                if (select) {
                    select.innerHTML = response.devices.map(device =>
                        `<option value="${this.escape(device.id)}">${this.escape(device.id)} - ${this.escape(device.name)}</option>`
                    ).join('');
                }
            }
        } catch (error) {
            this.logger.error('CalibrationModal', 'Failed to load ALSA devices:', error);
        }
    }

    // ========================================================================
    // INSTRUMENT SELECTION
    // ========================================================================

    _updateSelectedInstruments() {
        const checkboxes = this.$$('.calibration-instrument-checkbox:checked');
        this.state.selectedInstruments = Array.from(checkboxes).map(cb => {
            const [deviceId, channel] = cb.value.split(':');
            return { deviceId, channel: parseInt(channel), key: cb.value };
        });

        const startBtn = this.$('#calibStartBtn');
        if (startBtn) {
            startBtn.disabled = this.state.selectedInstruments.length === 0;
        }
    }

    // ========================================================================
    // PREVIEW NOTE
    // ========================================================================

    async _previewNote(deviceId, channel, btnEl) {
        if (btnEl.classList.contains('sending')) return;

        btnEl.classList.add('sending');
        btnEl.textContent = `🔊 ${this.t('calibration.previewSending')}`;

        try {
            await this._getApi().sendCommand('calibrate_preview_note', { deviceId, channel });
        } catch (error) {
            this.logger.error('CalibrationModal', 'Preview note failed:', error);
        }

        setTimeout(() => {
            btnEl.classList.remove('sending');
            btnEl.textContent = `🔊 ${this.t('calibration.previewNote')}`;
        }, 600);
    }

    // ========================================================================
    // VU-METER MONITORING
    // ========================================================================

    async _startMonitoring() {
        if (this.state.isMonitoring) return;
        this.state.isMonitoring = true;

        try {
            await this._getApi().sendCommand('calibrate_monitor_start', {
                alsaDevice: this._getAlsaDevice()
            });
        } catch (error) {
            this.logger.warn('CalibrationModal', 'Monitor start failed:', error);
        }

        // Start RAF loop for VU-meter animation
        this._animateVuMeter();
    }

    async _stopMonitoring() {
        this.state.isMonitoring = false;

        if (this._vuMeterRAF) {
            cancelAnimationFrame(this._vuMeterRAF);
            this._vuMeterRAF = null;
        }

        try {
            await this._getApi().sendCommand('calibrate_monitor_stop', {});
        } catch (error) {
            this.logger.warn('CalibrationModal', 'Monitor stop failed:', error);
        }
    }

    _animateVuMeter() {
        if (!this.state.isMonitoring || !this.isOpen) return;

        const fill = this.$('#calibVuFill');
        const rmsDisplay = this.$('#calibRmsValue');

        if (fill) {
            // Scale RMS relative to a max of 0.15 for visual range
            const pct = Math.min(100, (this._currentRMS / 0.15) * 100);
            fill.style.width = `${pct}%`;
        }

        if (rmsDisplay) {
            rmsDisplay.textContent = this._currentRMS.toFixed(3);
        }

        this._vuMeterRAF = requestAnimationFrame(() => this._animateVuMeter());
    }

    _updateThresholdIndicator() {
        const threshold = this._getThreshold();
        const indicator = this.$('#calibVuThreshold');
        if (indicator) {
            // Position relative to max visual range of 0.15
            const pct = Math.min(100, (threshold / 0.15) * 100);
            indicator.style.left = `${pct}%`;
        }
    }

    // ========================================================================
    // CALIBRATION
    // ========================================================================

    async _startCalibration() {
        if (this.state.selectedInstruments.length === 0 || this.state.isRunning) return;

        this.state.isRunning = true;
        this.state.results = {};

        // Get settings
        const threshold = this._getThreshold();
        const alsaDevice = this._getAlsaDevice();
        const measurements = this._getMeasurements();

        // Set all selected instruments to 'waiting'
        this.state.selectedInstruments.forEach(inst => {
            this._setInstrumentStatus(inst.key, 'waiting', this.t('calibration.statusWaiting'));
        });

        // Show progress, hide start button
        const progressEl = this.$('#calibProgress');
        const resultsEl = this.$('#calibResults');
        const startBtn = this.$('#calibStartBtn');
        const applyBtn = this.$('#calibApplyBtn');

        if (progressEl) progressEl.style.display = 'block';
        if (resultsEl) resultsEl.style.display = 'none';
        if (startBtn) startBtn.style.display = 'none';
        if (applyBtn) applyBtn.style.display = 'none';

        const total = this.state.selectedInstruments.length;
        let completed = 0;

        // Stop monitoring during calibration (calibrator uses arecord)
        await this._stopMonitoring();

        for (const instrument of this.state.selectedInstruments) {
            // Update status
            this._setInstrumentStatus(instrument.key, 'running', this.t('calibration.statusRunning'));
            this._updateProgress(completed, total, `${this.t('calibration.statusRunning')} ${instrument.key}...`);

            try {
                const result = await this._getApi().sendCommand('calibrate_delay', {
                    deviceId: instrument.deviceId,
                    channel: instrument.channel,
                    threshold,
                    alsaDevice,
                    measurements
                });

                this.state.results[instrument.key] = { ...result, instrument };

                if (result.success) {
                    this._setInstrumentStatus(instrument.key, 'success', `${result.delay}ms`);
                } else {
                    this._setInstrumentStatus(instrument.key, 'error', result.error || this.t('calibration.statusError'));
                }
            } catch (error) {
                this.logger.error('CalibrationModal', 'Calibration error:', error);
                this.state.results[instrument.key] = {
                    success: false,
                    error: error.message,
                    instrument
                };
                this._setInstrumentStatus(instrument.key, 'error', error.message);
            }

            completed++;
            this._updateProgress(completed, total);
        }

        // Calibration complete
        this.state.isRunning = false;
        this._displayResults();

        // Restart monitoring
        this._startMonitoring();
    }

    _updateProgress(completed, total, statusText) {
        const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
        const fill = this.$('#calibProgressFill');
        if (fill) {
            fill.style.width = `${pct}%`;
            fill.textContent = `${pct}%`;
        }
        if (statusText) {
            const statusEl = this.$('#calibStatus');
            if (statusEl) statusEl.textContent = statusText;
        }
    }

    _setInstrumentStatus(key, status, text) {
        this.state.instrumentStatuses[key] = status;
        const el = this.$(`#calib_status_${CSS.escape(key)}`);
        if (!el) return;

        el.className = `calibration-instrument-status ${status}`;

        switch (status) {
            case 'waiting':
                el.textContent = `⏳ ${text || ''}`;
                break;
            case 'running':
                el.textContent = '';  // spinner is CSS ::before
                break;
            case 'success':
                el.textContent = `✓ ${text || ''}`;
                break;
            case 'error':
                el.textContent = `✗`;
                el.title = text || '';
                break;
            default:
                el.textContent = '';
        }
    }

    // ========================================================================
    // RESULTS
    // ========================================================================

    _displayResults() {
        const resultsSection = this.$('#calibResults');
        const resultsList = this.$('#calibResultsList');
        const progressEl = this.$('#calibProgress');
        const applyBtn = this.$('#calibApplyBtn');

        if (!resultsSection || !resultsList) return;

        // Build results HTML
        const resultsHTML = Object.values(this.state.results).map(result => {
            const inst = result.instrument;
            const instrumentName = this.escape(inst.key.replace(':', ' - Canal '));

            // Find display name from instruments list
            const instData = this.instruments.find(i => i.key === inst.key);
            const displayName = instData ? this.escape(instData.displayName) : instrumentName;

            if (!result.success) {
                return `
                    <div class="calibration-result-item">
                        <div class="calibration-result-instrument">
                            <div class="calibration-result-instrument-name">${displayName}</div>
                            <div class="calibration-result-measurements">❌ ${this.t('calibration.statusError')}: ${this.escape(result.error || '')}</div>
                        </div>
                    </div>
                `;
            }

            let confidenceClass = 'low';
            if (result.confidence >= 80) confidenceClass = 'high';
            else if (result.confidence >= 60) confidenceClass = 'medium';

            return `
                <div class="calibration-result-item">
                    <div class="calibration-result-instrument">
                        <div class="calibration-result-instrument-name">${displayName}</div>
                        <div class="calibration-result-measurements">
                            ${result.measurements.length} ${this.t('calibration.measurements').toLowerCase()} |
                            ${this.t('calibration.mean')}: ${result.mean}ms |
                            ${this.t('calibration.stdDev')}: ${result.stdDev}ms
                        </div>
                    </div>
                    <div class="calibration-result-delay">${result.delay}ms</div>
                    <div class="calibration-result-confidence ${confidenceClass}">
                        ${result.confidence}%
                    </div>
                </div>
            `;
        }).join('');

        resultsList.innerHTML = resultsHTML;

        // Show results, hide progress, show apply button
        resultsSection.style.display = 'block';
        if (progressEl) progressEl.style.display = 'none';
        if (applyBtn) applyBtn.style.display = 'inline-block';

        // Render chart
        this._renderChart();
    }

    async _applyResults() {
        let appliedCount = 0;

        for (const [, result] of Object.entries(this.state.results)) {
            if (!result.success) {
                continue;
            }

            try {
                await this._getApi().sendCommand('instrument_update_settings', {
                    deviceId: result.instrument.deviceId,
                    channel: result.instrument.channel,
                    sync_delay: result.delay
                });
                appliedCount++;
            } catch (error) {
                this.logger.error('CalibrationModal', 'Failed to apply delay:', error);
            }
        }

        if (window.log) {
            window.log(`✅ ${this.t('calibration.applied', { count: appliedCount })}`, 'success');
        }

        this.close();
    }

    // ========================================================================
    // CHART (Canvas)
    // ========================================================================

    _renderChart() {
        const container = this.$('#calibChartContainer');
        if (!container) return;

        const successResults = Object.values(this.state.results).filter(r => r.success);
        if (successResults.length === 0) {
            container.innerHTML = '';
            return;
        }

        const rowHeight = 40;
        const padding = { top: 20, right: 80, bottom: 30, left: 160 };
        const width = container.clientWidth || 600;
        const height = padding.top + padding.bottom + successResults.length * rowHeight;

        // Create canvas
        container.innerHTML = '';
        const canvas = document.createElement('canvas');
        const dpr = window.devicePixelRatio || 1;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        container.appendChild(canvas);

        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);

        // Find max delay for scale
        const maxDelay = Math.max(...successResults.map(r => r.delay + (r.stdDev || 0))) * 1.2;
        const barArea = width - padding.left - padding.right;

        // Colors
        const isDark = document.body.classList.contains('dark-mode');
        const textColor = isDark ? '#ccc' : '#4a3f6b';
        const gridColor = isDark ? '#444' : '#ddd6f3';

        // Grid lines
        ctx.strokeStyle = gridColor;
        ctx.lineWidth = 0.5;
        const gridSteps = [0, 25, 50, 75, 100, 150, 200];
        for (const ms of gridSteps) {
            if (ms > maxDelay) break;
            const x = padding.left + (ms / maxDelay) * barArea;
            ctx.beginPath();
            ctx.moveTo(x, padding.top - 5);
            ctx.lineTo(x, height - padding.bottom);
            ctx.stroke();

            ctx.fillStyle = textColor;
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(`${ms}ms`, x, height - padding.bottom + 15);
        }

        // Draw bars
        successResults.forEach((result, i) => {
            const y = padding.top + i * rowHeight;
            const barY = y + 8;
            const barH = rowHeight - 16;

            // Label
            const instData = this.instruments.find(inst => inst.key === result.instrument.key);
            const label = instData ? instData.displayName : result.instrument.key;

            ctx.fillStyle = textColor;
            ctx.font = '12px sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(label, padding.left - 10, barY + barH / 2 + 4, padding.left - 20);

            // Bar color based on confidence
            let barColor;
            if (result.confidence >= 80) barColor = '#22c55e';
            else if (result.confidence >= 60) barColor = '#eab308';
            else barColor = '#ef4444';

            // Main bar (delay)
            const barW = (result.delay / maxDelay) * barArea;
            ctx.fillStyle = barColor;
            ctx.globalAlpha = 0.8;
            ctx.beginPath();
            ctx.roundRect(padding.left, barY, Math.max(barW, 2), barH, 3);
            ctx.fill();
            ctx.globalAlpha = 1;

            // Std dev whiskers
            if (result.stdDev) {
                const stdLeft = padding.left + ((result.delay - result.stdDev) / maxDelay) * barArea;
                const stdRight = padding.left + ((result.delay + result.stdDev) / maxDelay) * barArea;
                const midY = barY + barH / 2;

                ctx.strokeStyle = barColor;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(Math.max(stdLeft, padding.left), midY);
                ctx.lineTo(stdRight, midY);
                ctx.stroke();

                // Whisker caps
                ctx.beginPath();
                ctx.moveTo(Math.max(stdLeft, padding.left), midY - 5);
                ctx.lineTo(Math.max(stdLeft, padding.left), midY + 5);
                ctx.moveTo(stdRight, midY - 5);
                ctx.lineTo(stdRight, midY + 5);
                ctx.stroke();
            }

            // Value label
            ctx.fillStyle = textColor;
            ctx.font = 'bold 12px sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText(`${result.delay}ms`, padding.left + barW + 6, barY + barH / 2 + 4);
        });
    }

    // ========================================================================
    // HELPERS
    // ========================================================================

    _getThreshold() {
        const slider = this.$('#calibThreshold');
        return slider ? parseFloat(slider.value) : 0.02;
    }

    _getAlsaDevice() {
        const select = this.$('#calibAlsaDevice');
        return select ? select.value : 'hw:1,0';
    }

    _getMeasurements() {
        const input = this.$('#calibMeasurements');
        return input ? parseInt(input.value) || 5 : 5;
    }
}

// Expose globally
if (typeof window !== 'undefined') {
    window.CalibrationModal = CalibrationModal;
}
