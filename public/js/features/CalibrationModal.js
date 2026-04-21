// ============================================================================
// File: js/features/CalibrationModal.js
// Version: v2.0.0
// Description:
//   Modal for audio delay calibration via microphone.
//   Features:
//   - Flat layout (no simple/advanced toggle)
//   - Large "open tuner" banner at the top
//   - ALSA dropdown with auto-selected USB device
//   - VU-meter with threshold slider integrated on the bar itself
//   - Per-instrument "Measure" button (test category: delay)
//   - Global "Apply delays" button (footer) once at least one success
//   - Canvas chart of calibration results
//   - i18n and theme support (dark)
//
// Dependencies: BaseModal.js, BackendAPIClient, EventBus, i18n
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
            results: {},
            isMonitoring: false,
            instrumentStatuses: {} // key: 'deviceId:channel' => 'idle' | 'running' | 'success' | 'error'
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

        this.logger.info('CalibrationModal', '✓ Modal initialized v2.0.0');
    }

    /**
     * Get the API client. Falls back to window.api if not set at construction time.
     */
    _getApi() {
        return this.api || window.api || window.apiClient;
    }

    // ========================================================================
    // RENDER
    // ========================================================================

    renderBody() {
        return `
            <!-- Tuner banner (big button at the top) -->
            <div class="calibration-tuner-banner">
                <button type="button" id="calibOpenTunerBtn" class="calibration-tuner-btn-large">
                    🎵 ${this.t('tuner.openTuner')}
                </button>
            </div>

            <!-- Microphone settings (always visible) -->
            <div class="calibration-section">
                <h3>⚙️ ${this.t('calibration.micSettings')}</h3>

                <div class="calibration-field">
                    <label for="calibAlsaDevice">${this.t('calibration.alsaDevice')}:</label>
                    <div style="display: flex; gap: 8px; align-items: center;">
                        <select id="calibAlsaDevice" class="calibration-select" style="flex:1;">
                            <option value="">…</option>
                        </select>
                        <button class="btn btn-sm" id="calibRefreshAlsa" type="button">🔄 ${this.t('calibration.refresh')}</button>
                    </div>
                </div>

                <!-- VU-Meter with integrated threshold slider -->
                <div class="calibration-vu-meter" id="calibVuMeter">
                    <div class="calibration-vu-meter-label">
                        <span>🎤 ${this.t('calibration.vuMeter')}</span>
                        <button type="button" id="calibListenToggle" class="calibration-listen-btn">
                            ▶ ${this.t('calibration.startListening')}
                        </button>
                        <span class="calibration-vu-meter-rms" id="calibRmsValue">0.000</span>
                    </div>
                    <div class="calibration-vu-meter-bar" id="calibVuMeterBar">
                        <div class="calibration-vu-meter-fill" id="calibVuFill"></div>
                        <input type="range" id="calibThreshold"
                               min="0.01" max="0.10" step="0.005" value="0.02"
                               class="calibration-threshold-slider"
                               aria-label="${this.t('calibration.threshold')}">
                        <span class="calibration-threshold-value" id="calibThresholdValue">0.020</span>
                    </div>
                    <small class="calibration-hint">${this.t('calibration.thresholdHint')}</small>
                </div>
            </div>

            <!-- Tests section (extensible: one category per test type) -->
            <div class="calibration-section calibration-tests-section">
                <h3>🧪 ${this.t('calibration.tests')}</h3>

                <div class="calibration-test-category" data-category="delay">
                    <div class="calibration-test-category-header">
                        <div class="calibration-test-category-title">
                            <h4>⏱️ ${this.t('calibration.testDelayCategory')}</h4>
                            <small>${this.t('calibration.testDelayCategoryHint')}</small>
                        </div>
                        <div class="calibration-test-category-options">
                            <label class="calibration-test-category-option" for="calibMeasurementOffset">
                                <span>${this.t('calibration.measurementOffset')}:</span>
                                <input type="number" id="calibMeasurementOffset" class="calibration-input-inline"
                                       min="0" max="100" step="1" value="${this._getSavedOffset()}"
                                       title="${this.t('calibration.measurementOffsetHint')}">
                            </label>
                            <label class="calibration-test-category-option" for="calibMeasurements">
                                <span>${this.t('calibration.measurements')}:</span>
                                <input type="number" id="calibMeasurements" class="calibration-input-inline"
                                       min="1" max="20" value="5">
                            </label>
                        </div>
                    </div>
                    <div id="calibInstrumentsList" class="calibration-instruments-list">
                        <div class="calibration-no-instruments">${this.t('calibration.noInstruments')}</div>
                    </div>
                </div>

                <div class="calibration-chart-container" id="calibChartContainer"></div>
            </div>
        `;
    }

    renderFooter() {
        return `
            <button class="btn btn-secondary" id="calibCancelBtn" type="button">${this.t('common.cancel')}</button>
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
        // _loadAlsaDevices() triggers _startMonitoring() once the real device
        // list populated the <select>, so arecord spawns with the actual
        // selected device (USB auto-detected).
        this._loadAlsaDevices();
    }

    onClose() {
        this._stopMonitoring();
        this._detachEventHandlers();

        // Reset state
        this.state.results = {};
        this.state.instrumentStatuses = {};
    }

    onUpdate() {
        // BaseModal.update() replaces body HTML on locale change.
        this._detachEventHandlers();
        this._attachEventHandlers();
        this._loadInstruments();
        this._loadAlsaDevices();
        this._updateListenButton();
    }

    // ========================================================================
    // EVENT HANDLERS
    // ========================================================================

    _attachEventHandlers() {
        // Cancel button
        const cancelBtn = this.$('#calibCancelBtn');
        if (cancelBtn) cancelBtn.addEventListener('click', () => this.close());

        // Apply button
        const applyBtn = this.$('#calibApplyBtn');
        if (applyBtn) applyBtn.addEventListener('click', () => this._applyResults());

        // Refresh ALSA
        const refreshBtn = this.$('#calibRefreshAlsa');
        if (refreshBtn) refreshBtn.addEventListener('click', () => this._loadAlsaDevices());

        // ALSA device change: restart monitoring on the new device
        const alsaSelect = this.$('#calibAlsaDevice');
        if (alsaSelect) {
            alsaSelect.addEventListener('change', async () => {
                if (this.state.isMonitoring) {
                    await this._stopMonitoring();
                    await this._startMonitoring();
                }
            });
        }

        // Listen toggle button
        const listenBtn = this.$('#calibListenToggle');
        if (listenBtn) {
            listenBtn.addEventListener('click', () => this._toggleListening());
        }

        // Open Tuner modal (releases arecord, restores VU-meter on close)
        const tunerBtn = this.$('#calibOpenTunerBtn');
        if (tunerBtn) {
            tunerBtn.addEventListener('click', async () => {
                if (typeof TunerModal === 'undefined') {
                    this.logger.warn('CalibrationModal', 'TunerModal not loaded');
                    return;
                }
                const wasMonitoring = this.state.isMonitoring;
                await this._stopMonitoring();
                const tuner = new TunerModal({
                    api: this._getApi(),
                    alsaDevice: this._getAlsaDevice(),
                    onClose: () => {
                        if (wasMonitoring && this.isOpen) {
                            this._startMonitoring();
                        }
                    }
                });
                tuner.open();
            });
        }

        // Threshold slider (overlaid on the VU bar)
        const slider = this.$('#calibThreshold');
        if (slider) {
            slider.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                const display = this.$('#calibThresholdValue');
                if (display) display.textContent = val.toFixed(3);
            });
        }

        // Measurement offset: persist changes so the correction survives reloads.
        const offsetInput = this.$('#calibMeasurementOffset');
        if (offsetInput) {
            offsetInput.addEventListener('change', () => {
                const n = parseInt(offsetInput.value, 10);
                if (Number.isFinite(n)) {
                    localStorage.setItem('calibration_measurement_offset', String(Math.max(0, Math.min(100, n))));
                }
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
            if (this.isOpen) {
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

            const response = await this._getApi().sendCommand('device_list', {});
            const allDevices = (response && response.devices) ? response.devices : [];

            // Filter: only connected devices that have output capability
            const devices = allDevices.filter(d => d.output !== false && (d.status === 2 || d.connected));

            for (const device of devices) {
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

            if (this.instruments.length === 0) {
                listEl.innerHTML = `<div class="calibration-no-instruments">${this.t('calibration.noConnected')}</div>`;
                return;
            }

            listEl.innerHTML = this.instruments.map(inst => this._renderInstrumentRow(inst)).join('');

            // Preview buttons
            listEl.querySelectorAll('.calibration-preview-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const deviceId = btn.dataset.deviceId;
                    const channel = parseInt(btn.dataset.channel);
                    this._previewNote(deviceId, channel, btn);
                });
            });

            // Measure buttons (per-instrument calibration)
            listEl.querySelectorAll('.calibration-measure-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const key = btn.dataset.key;
                    const instrument = this.instruments.find(i => i.key === key);
                    if (instrument) this._measureInstrument(instrument);
                });
            });

            // Rehydrate statuses/results for rows that already had data (e.g. after locale change)
            for (const inst of this.instruments) {
                const status = this.state.instrumentStatuses[inst.key];
                if (status) this._setInstrumentStatus(inst.key, status);
                const result = this.state.results[inst.key];
                if (result) this._updateRowResult(inst.key, result);
            }
            this._updateApplyButtonVisibility();

        } catch (error) {
            console.error('[CalibrationModal] Failed to load instruments:', error);
            this.logger.error('CalibrationModal', 'Failed to load instruments:', error?.message || error);
            listEl.innerHTML = `<div class="calibration-no-instruments">${this.t('calibration.noInstruments')}</div>`;
        }
    }

    _renderInstrumentRow(inst) {
        const keyEsc = this.escape(inst.key);
        return `
            <div class="calibration-instrument-item" data-key="${keyEsc}">
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
                <button class="calibration-measure-btn" type="button"
                        data-key="${keyEsc}"
                        title="${this.t('calibration.measure')}">
                    🎤 ${this.t('calibration.measure')}
                </button>
                <div class="calibration-instrument-result" id="calib_result_${keyEsc}">—</div>
                <div class="calibration-instrument-status idle" id="calib_status_${keyEsc}"></div>
            </div>
        `;
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

                    // Auto-select the first USB device if one exists
                    const usbDevice = response.devices.find(d => /usb/i.test(d.name));
                    if (usbDevice) select.value = usbDevice.id;
                }
            }
        } catch (error) {
            this.logger.error('CalibrationModal', 'Failed to load ALSA devices:', error);
        }

        if (this.isOpen && !this.state.isMonitoring) {
            this._startMonitoring();
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

    async _toggleListening() {
        if (this.state.isMonitoring) {
            await this._stopMonitoring();
        } else {
            await this._startMonitoring();
        }
    }

    _updateListenButton() {
        const btn = this.$('#calibListenToggle');
        if (!btn) return;
        if (this.state.isMonitoring) {
            btn.textContent = `⏸ ${this.t('calibration.stopListening')}`;
            btn.classList.add('listening');
        } else {
            btn.textContent = `▶ ${this.t('calibration.startListening')}`;
            btn.classList.remove('listening');
        }
    }

    async _startMonitoring() {
        if (this.state.isMonitoring) return;
        this.state.isMonitoring = true;
        this._updateListenButton();

        try {
            await this._getApi().sendCommand('calibrate_monitor_start', {
                alsaDevice: this._getAlsaDevice()
            });
        } catch (error) {
            this.logger.warn('CalibrationModal', 'Monitor start failed:', error);
        }

        this._animateVuMeter();
    }

    async _stopMonitoring() {
        this.state.isMonitoring = false;
        this._updateListenButton();

        if (this._vuMeterRAF) {
            cancelAnimationFrame(this._vuMeterRAF);
            this._vuMeterRAF = null;
        }

        // Reset VU-meter bar to idle
        const fill = this.$('#calibVuFill');
        if (fill) fill.style.width = '0%';
        const bar = this.$('#calibVuMeterBar');
        if (bar) bar.classList.remove('threshold-crossed');
        this._currentRMS = 0;

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
        const bar = this.$('#calibVuMeterBar');

        if (fill) {
            // Scale RMS relative to a max of 0.15 for visual range
            const pct = Math.min(100, (this._currentRMS / 0.15) * 100);
            fill.style.width = `${pct}%`;
        }

        if (rmsDisplay) {
            rmsDisplay.textContent = this._currentRMS.toFixed(3);
        }

        if (bar) {
            bar.classList.toggle('threshold-crossed', this._currentRMS > this._getThreshold());
        }

        this._vuMeterRAF = requestAnimationFrame(() => this._animateVuMeter());
    }

    // ========================================================================
    // PER-INSTRUMENT CALIBRATION
    // ========================================================================

    async _measureInstrument(instrument) {
        const currentStatus = this.state.instrumentStatuses[instrument.key];
        if (currentStatus === 'running') return;

        const threshold = this._getThreshold();
        const alsaDevice = this._getAlsaDevice();
        const measurements = this._getMeasurements();

        const wasMonitoring = this.state.isMonitoring;
        await this._stopMonitoring();

        this._setInstrumentStatus(instrument.key, 'running');

        const offset = this._getMeasurementOffset();

        try {
            const result = await this._getApi().sendCommand('calibrate_delay', {
                deviceId: instrument.deviceId,
                channel: instrument.channel,
                threshold,
                alsaDevice,
                measurements
            });

            // Subtract the measurement-chain offset (ALSA buffer + USB mic +
            // processing overhead) so the stored delay reflects the real
            // MIDI→sound latency of the instrument alone.
            const corrected = this._applyOffsetToResult(result, offset);
            this.state.results[instrument.key] = { ...corrected, instrument, measurementOffset: offset };

            if (corrected.success) {
                this._setInstrumentStatus(instrument.key, 'success', `${corrected.delay}ms`);
            } else {
                this._setInstrumentStatus(instrument.key, 'error', corrected.error || this.t('calibration.statusError'));
            }
            this._updateRowResult(instrument.key, this.state.results[instrument.key]);
        } catch (error) {
            this.logger.error('CalibrationModal', 'Calibration error:', error);
            this.state.results[instrument.key] = {
                success: false,
                error: error.message,
                instrument
            };
            this._setInstrumentStatus(instrument.key, 'error', error.message);
            this._updateRowResult(instrument.key, this.state.results[instrument.key]);
        }

        this._updateApplyButtonVisibility();
        this._renderChart();

        // Restart monitoring if it was active before
        if (wasMonitoring) this._startMonitoring();
    }

    _setInstrumentStatus(key, status, text) {
        this.state.instrumentStatuses[key] = status;
        const el = this.$(`#calib_status_${CSS.escape(key)}`);
        if (!el) return;

        el.className = `calibration-instrument-status ${status}`;

        switch (status) {
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

    _updateRowResult(key, result) {
        const el = this.$(`#calib_result_${CSS.escape(key)}`);
        if (!el) return;

        if (!result) {
            el.textContent = '—';
            el.className = 'calibration-instrument-result';
            return;
        }

        if (!result.success) {
            el.textContent = '—';
            el.className = 'calibration-instrument-result';
            return;
        }

        let confidenceClass = 'low';
        if (result.confidence >= 80) confidenceClass = 'high';
        else if (result.confidence >= 60) confidenceClass = 'medium';

        el.className = `calibration-instrument-result has-value ${confidenceClass}`;
        el.textContent = `${result.delay}ms (${result.confidence}%)`;
    }

    _updateApplyButtonVisibility() {
        const applyBtn = this.$('#calibApplyBtn');
        if (!applyBtn) return;
        const hasSuccess = Object.values(this.state.results).some(r => r && r.success);
        applyBtn.style.display = hasSuccess ? 'inline-block' : 'none';
    }

    // ========================================================================
    // APPLY RESULTS
    // ========================================================================

    async _applyResults() {
        let appliedCount = 0;

        for (const [, result] of Object.entries(this.state.results)) {
            if (!result.success) continue;

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

        const maxDelay = Math.max(...successResults.map(r => r.delay + (r.stdDev || 0))) * 1.2;
        const barArea = width - padding.left - padding.right;

        const isDark = document.body.classList.contains('theme-dark') || document.body.classList.contains('dark-mode');
        const textColor = isDark ? '#ccc' : '#4a3f6b';
        const gridColor = isDark ? '#444' : '#ddd6f3';

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

        successResults.forEach((result, i) => {
            const y = padding.top + i * rowHeight;
            const barY = y + 8;
            const barH = rowHeight - 16;

            const instData = this.instruments.find(inst => inst.key === result.instrument.key);
            const label = instData ? instData.displayName : result.instrument.key;

            ctx.fillStyle = textColor;
            ctx.font = '12px sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(label, padding.left - 10, barY + barH / 2 + 4, padding.left - 20);

            let barColor;
            if (result.confidence >= 80) barColor = '#22c55e';
            else if (result.confidence >= 60) barColor = '#eab308';
            else barColor = '#ef4444';

            const barW = (result.delay / maxDelay) * barArea;
            ctx.fillStyle = barColor;
            ctx.globalAlpha = 0.8;
            ctx.beginPath();
            ctx.roundRect(padding.left, barY, Math.max(barW, 2), barH, 3);
            ctx.fill();
            ctx.globalAlpha = 1;

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

                ctx.beginPath();
                ctx.moveTo(Math.max(stdLeft, padding.left), midY - 5);
                ctx.lineTo(Math.max(stdLeft, padding.left), midY + 5);
                ctx.moveTo(stdRight, midY - 5);
                ctx.lineTo(stdRight, midY + 5);
                ctx.stroke();
            }

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
        return select && select.value ? select.value : 'hw:1,0';
    }

    _getMeasurements() {
        const input = this.$('#calibMeasurements');
        if (!input) return 5;
        const n = parseInt(input.value, 10);
        if (!Number.isFinite(n)) return 5;
        return Math.max(1, Math.min(20, n));
    }

    _getSavedOffset() {
        const saved = parseInt(localStorage.getItem('calibration_measurement_offset'), 10);
        return Number.isFinite(saved) ? Math.max(0, Math.min(100, saved)) : 0;
    }

    _getMeasurementOffset() {
        const input = this.$('#calibMeasurementOffset');
        if (!input) return this._getSavedOffset();
        const n = parseInt(input.value, 10);
        if (!Number.isFinite(n)) return 0;
        return Math.max(0, Math.min(100, n));
    }

    /**
     * Subtract the measurement-chain offset from a calibration result.
     * Applied non-destructively so the raw backend response isn't mutated.
     * Clamps individual measurements and the reported delay at 0 — negative
     * latency is physically impossible and would just be noise.
     */
    _applyOffsetToResult(result, offset) {
        if (!result || !result.success || !offset) return result;
        const next = { ...result };
        if (Array.isArray(result.measurements)) {
            next.measurements = result.measurements.map(m => Math.max(0, m - offset));
        }
        if (typeof result.delay === 'number') {
            next.delay = Math.max(0, Math.round(result.delay - offset));
        }
        if (typeof result.mean === 'number') {
            next.mean = Math.max(0, Math.round(result.mean - offset));
        }
        // stdDev is unchanged by a constant subtraction.
        return next;
    }
}

// Expose globally
if (typeof window !== 'undefined') {
    window.CalibrationModal = CalibrationModal;
}
