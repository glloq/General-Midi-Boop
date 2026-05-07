// ============================================================================
// File: frontend/js/features/BluetoothScanModal.js
// Version: v1.1.0 (i18n support)
// Date: 2025-11-16
// ============================================================================
// Description:
//   Custom modal for scanning and connecting Bluetooth instruments
//   - Display available devices
//   - Pairing and connection
//   - Intuitive UI
//   - Multi-language support (i18n)
//
// Dependency: i18n must be loaded before this script (js/i18n/I18n.js)
// ============================================================================

class BluetoothScanModal {
    constructor(eventBus) {
        this.eventBus = eventBus || window.eventBus || null;
        this.logger = window.logger || console;

        this.container = null;
        this.isOpen = false;
        this.scanning = false;
        this.bluetoothEnabled = true; // Bluetooth state
        this.bluetoothState = 'unknown'; // Detailed state
        this.availableDevices = [];
        this.pairedDevices = [];
        this.scanError = null;

        this.setupEventListeners();

        this.logger.info('BluetoothScanModal', '✓ Modal initialized v1.1.0 (i18n)');
    }

    // ========================================================================
    // EVENTS
    // ========================================================================

    setupEventListeners() {
        if (!this.eventBus) return;

        this._eventUnsubs = [
            this.eventBus.on('bluetooth:scanned',      (data) => this.handleScanComplete(data)),
            this.eventBus.on('bluetooth:paired_list',  (data) => this.handlePairedList(data)),
            this.eventBus.on('bluetooth:paired',       (data) => this.handleDevicePaired(data)),
            this.eventBus.on('bluetooth:scan_error',   (data) => this.handleScanError(data)),
            this.eventBus.on('bluetooth:status',       (data) => this.handleBluetoothStatus(data)),
            this.eventBus.on('bluetooth:powered_on',   (data) => this.handleBluetoothPoweredOn(data)),
            this.eventBus.on('bluetooth:powered_off',  (data) => this.handleBluetoothPoweredOff(data)),
            this.eventBus.on('bluetooth:unpaired',     (data) => this.handleDeviceUnpaired(data)),
            this.eventBus.on('bluetooth:connected',    (data) => this.handleDeviceConnected(data)),
            this.eventBus.on('bluetooth:disconnected', (data) => this.handleDeviceDisconnected(data)),
        ];

        if (typeof i18n !== 'undefined') {
            this._localeUnsubscribe = i18n.onLocaleChange(() => this.updateModalContent());
        }

        this.logger.debug('BluetoothScanModal', 'Event listeners configured');
    }

    destroy() {
        this.close();
        if (this._eventUnsubs) {
            this._eventUnsubs.forEach(unsub => { if (typeof unsub === 'function') unsub(); });
            this._eventUnsubs = [];
        }
    }

    // ========================================================================
    // MODAL DISPLAY
    // ========================================================================

    /**
     * Open the modal and start the scan
     */
    open() {
        if (this.isOpen) {
            this.logger.warn('BluetoothScanModal', 'Modal already open');
            return;
        }

        this.isOpen = true;
        this.availableDevices = [];
        this.pairedDevices = [];

        this.createModal();
        this.checkBluetoothStatus(); // Check the Bluetooth state

        this.logger.info('BluetoothScanModal', 'Modal opened');
    }

    /**
     * Close the modal
     */
    close() {
        if (!this.isOpen) return;

        this.isOpen = false;
        this.scanning = false;

        if (this._localeUnsubscribe) {
            this._localeUnsubscribe();
            this._localeUnsubscribe = null;
        }

        if (this.container) {
            this.container.remove();
            this.container = null;
        }

        this.logger.info('BluetoothScanModal', 'Modal closed');
    }

    /**
     * Build the modal DOM
     */
    createModal() {
        // Remove the old modal if it exists
        if (this.container) {
            this.container.remove();
        }

        // Create the new modal
        this.container = document.createElement('div');
        this.container.className = 'modal-overlay bluetooth-scan-modal';
        this.container.innerHTML = this.renderModalContent();

        document.body.appendChild(this.container);

        // Attach events
        this.attachModalEvents();

        // Attach event delegation for device actions ONCE
        // These listeners stay active even after updateModalContent()
        this.container.addEventListener('click', (e) => {
            // Click backdrop to close
            if (e.target === this.container) {
                this.close();
                return;
            }

            const action = e.target.dataset.action;
            if (!action) return;

            if (action === 'pair') {
                const deviceId = e.target.dataset.deviceId;
                const deviceName = e.target.dataset.deviceName;
                if (deviceId) this.pairDevice(deviceId, deviceName);
            }

            if (action === 'connect') {
                const deviceAddress = e.target.dataset.deviceAddress;
                if (deviceAddress) this.connectDevice(deviceAddress);
            }

            if (action === 'disconnect') {
                const deviceAddress = e.target.dataset.deviceAddress;
                if (deviceAddress) this.disconnectDevice(deviceAddress);
            }

            if (action === 'unpair') {
                const deviceAddress = e.target.dataset.deviceAddress;
                if (deviceAddress) this.unpairDevice(deviceAddress);
            }
        });
    }

    /**
     * Render the modal content
     */
    renderModalContent() {
        const t = (key, params) => typeof i18n !== 'undefined' ? i18n.t(key, params) : key;

        return `
            <div class="modal-dialog modal-lg">
                <div class="modal-header">
                    <h2>📡 ${t('bluetooth.title')}</h2>
                    <button class="modal-close" data-action="close">&times;</button>
                </div>

                <div class="modal-body">
                    <!-- Bluetooth state -->
                    ${!this.bluetoothEnabled ? this.renderBluetoothDisabled() : ''}

                    <!-- Scan section -->
                    <div class="scan-section">
                        <div class="scan-header">
                            <h3>${t('bluetooth.availableDevices')}</h3>
                            <button class="btn-scan ${this.scanning ? 'scanning' : ''}"
                                    data-action="scan" ${this.scanning ? 'disabled' : ''}>
                                ${this.scanning ? `🔄 ${t('bluetooth.scanning')}` : `🔍 ${t('common.search')}`}
                            </button>
                        </div>

                        <div class="devices-list" id="bluetoothAvailableDevices">
                            ${this.renderAvailableDevices()}
                        </div>
                    </div>

                    <!-- Paired devices section -->
                    ${this.pairedDevices.length > 0 ? `
                        <div class="paired-section">
                            <h3>${t('bluetooth.pairedDevices')}</h3>
                            <div class="devices-list" id="bluetoothPairedDevices">
                                ${this.renderPairedDevices()}
                            </div>
                        </div>
                    ` : ''}

                    <!-- Information -->
                    <div class="info-section">
                        <p>
                            💡 <strong>${t('bluetooth.tipLabel')}</strong> ${t('bluetooth.tip')}
                        </p>
                    </div>
                </div>

                <div class="modal-footer">
                    <button class="btn-secondary" data-action="close">${t('common.close')}</button>
                </div>
            </div>
        `;
    }

    /**
     * Render the available devices list
     */
    renderAvailableDevices() {
        const t = (key, params) => typeof i18n !== 'undefined' ? i18n.t(key, params) : key;

        if (this.scanning) {
            return `
                <div class="devices-scanning">
                    <div class="spinner"></div>
                    <p>${t('bluetooth.searchingDevices')}</p>
                    <p class="text-muted">${t('bluetooth.operationMayTakeTime')}</p>
                </div>
            `;
        }

        if (this.scanError) {
            return `
                <div class="devices-empty">
                    <div class="empty-icon">⚠️</div>
                    <p>${t('bluetooth.scanFailed') || 'Scan failed'}</p>
                    <p class="text-muted">${escapeHtml(this.scanError)}</p>
                </div>
            `;
        }

        if (this.availableDevices.length === 0) {
            return `
                <div class="devices-empty">
                    <div class="empty-icon">🔍</div>
                    <p>${t('bluetooth.noDeviceDetected')}</p>
                    <p class="text-muted">${t('bluetooth.clickToScan')}</p>
                </div>
            `;
        }

        return `
            <div class="devices-grid">
                ${this.availableDevices.map(device => this.renderAvailableDevice(device)).join('')}
            </div>
        `;
    }

    /**
     * Render an available device
     */
    renderAvailableDevice(device) {
        const t = (key, params) => typeof i18n !== 'undefined' ? i18n.t(key, params) : key;

        const deviceName = device.name || t('bluetooth.device');
        const deviceNameEscaped = escapeHtml(deviceName);
        const deviceAddress = device.address || device.id || t('bluetooth.unknownAddress');

        return `
            <div class="device-card bluetooth-device" data-device-id="${device.id || device.address}">
                <div class="device-icon">📡</div>
                <div class="device-info">
                    <div class="device-name">${deviceNameEscaped}</div>
                    <div class="device-address">${deviceAddress}</div>
                    ${device.signal ? `<div class="device-signal">📶 ${t('bluetooth.signal')}: ${device.signal}%</div>` : ''}
                    ${device.rssi ? `<div class="device-signal">📡 ${t('bluetooth.rssi')}: ${device.rssi} dBm</div>` : ''}
                </div>
                <div class="device-actions">
                    <button class="btn-pair" data-action="pair"
                            data-device-id="${device.id || device.address}"
                            data-device-name="${deviceName}">
                        🔗 ${t('common.pair')}
                    </button>
                </div>
            </div>
        `;
    }

    /**
     * Render the paired devices list
     */
    renderPairedDevices() {
        const t = (key, params) => typeof i18n !== 'undefined' ? i18n.t(key, params) : key;

        if (this.pairedDevices.length === 0) {
            return `<p class="text-muted">${t('bluetooth.noDevicePaired')}</p>`;
        }

        return `
            <div class="devices-grid">
                ${this.pairedDevices.map(device => this.renderPairedDevice(device)).join('')}
            </div>
        `;
    }

    /**
     * Render a paired device
     */
    renderPairedDevice(device) {
        const t = (key, params) => typeof i18n !== 'undefined' ? i18n.t(key, params) : key;

        const deviceName = escapeHtml(device.name || device.address);
        const isConnected = device.connected === true;

        return `
            <div class="device-card bluetooth-device paired ${isConnected ? 'connected' : ''}" data-device-address="${device.address}">
                <div class="device-icon">${isConnected ? '🟢' : '✓'}</div>
                <div class="device-info">
                    <div class="device-name">${deviceName}</div>
                    <div class="device-address">${device.address}</div>
                    <div class="device-status">
                        <span class="status-badge ${isConnected ? 'connected' : 'paired'}">
                            ${isConnected ? `🟢 ${t('bluetooth.connected')}` : `✓ ${t('bluetooth.paired')}`}
                        </span>
                    </div>
                </div>
                <div class="device-actions">
                    ${isConnected ? `
                        <button class="btn-disconnect" data-action="disconnect"
                                data-device-address="${device.address}">
                            🔌 ${t('common.disconnect')}
                        </button>
                    ` : `
                        <button class="btn-connect" data-action="connect"
                                data-device-address="${device.address}">
                            🔌 ${t('common.connect')}
                        </button>
                    `}
                    <button class="btn-unpair" data-action="unpair"
                            data-device-address="${device.address}">
                        ${t('common.forget')}
                    </button>
                </div>
            </div>
        `;
    }

    // ========================================================================
    // DOM EVENTS
    // ========================================================================

    /**
     * Attach the modal events
     */
    attachModalEvents() {
        if (!this.container) return;

        // IMPORTANT: Only re-attach event listeners for new elements
        // Listeners on the main container are attached once at creation

        // Modal close - re-attach because the buttons are re-rendered
        const closeButtons = this.container.querySelectorAll('[data-action="close"]');
        closeButtons.forEach(btn => {
            // Remove the old listener if it exists
            btn.removeEventListener('click', this._closeHandler);
            btn.addEventListener('click', () => this.close());
        });

        // Scan button - re-attach because re-rendered
        const scanButton = this.container.querySelector('[data-action="scan"]');
        if (scanButton) {
            scanButton.removeEventListener('click', this._scanHandler);
            this._scanHandler = () => this.startScan();
            scanButton.addEventListener('click', this._scanHandler);
        }

        // Bluetooth power-on button - re-attach because re-rendered
        const powerOnButton = this.container.querySelector('[data-action="power_on"]');
        if (powerOnButton) {
            powerOnButton.removeEventListener('click', this._powerOnHandler);
            this._powerOnHandler = () => this.powerOnBluetooth();
            powerOnButton.addEventListener('click', this._powerOnHandler);
        }
    }

    // ========================================================================
    // ACTIONS
    // ========================================================================

    /**
     * Start the Bluetooth scan
     */
    startScan() {
        if (this.scanning) {
            this.logger.warn('BluetoothScanModal', 'Scan already in progress');
            return;
        }

        this.scanning = true;
        this.availableDevices = [];
        this.scanError = null;
        this.updateModalContent();

        this.logger.info('BluetoothScanModal', 'Starting Bluetooth scan');

        if (this.eventBus) {
            this.eventBus.emit('bluetooth:scan_requested');
        } else {
            this.logger.error('BluetoothScanModal', 'EventBus not available');
            this.scanning = false;
            this.updateModalContent();
        }
    }

    /**
     * Load the paired devices list
     */
    loadPairedDevices() {
        this.logger.debug('BluetoothScanModal', 'Loading paired devices');

        if (this.eventBus) {
            this.eventBus.emit('bluetooth:paired_requested');
        }
    }

    /**
     * Pair a device
     */
    pairDevice(deviceId, deviceName) {
        this.logger.info('BluetoothScanModal', `Pairing device: ${deviceId}`);

        // Disable the button during pairing WITHOUT changing the text
        // (avoids the purple background issue)
        const deviceCard = this.container.querySelector(`[data-device-id="${deviceId}"]`);
        if (deviceCard) {
            const button = deviceCard.querySelector('.btn-pair');
            if (button) {
                // Prevent multiple clicks
                if (button.disabled) {
                    this.logger.warn('BluetoothScanModal', 'Pairing already in progress, ignoring click');
                    return;
                }
                button.disabled = true;
                button.style.opacity = '0.6';
                button.style.cursor = 'wait';
            }
        }

        if (this.eventBus) {
            this.eventBus.emit('bluetooth:pair_requested', {
                device_id: deviceId,
                address: deviceId,
                name: deviceName
            });
        }
    }

    /**
     * Connect a paired device
     */
    connectDevice(deviceAddress) {
        this.logger.info('BluetoothScanModal', `Connecting device: ${deviceAddress}`);

        // Disable the button during connection to prevent multiple clicks
        // BUT do not change the text to avoid the purple background issue
        const deviceCard = this.container.querySelector(`[data-device-address="${deviceAddress}"]`);
        if (deviceCard) {
            const button = deviceCard.querySelector('.btn-connect');
            if (button) {
                button.disabled = true;
                button.style.opacity = '0.6';
                button.style.cursor = 'wait';
            }
        }

        if (this.eventBus) {
            this.eventBus.emit('bluetooth:connect_requested', {
                address: deviceAddress
            });
        }

        // DO NOT close the modal - let the user see the status
        // this.close(); // REMOVED
    }

    /**
     * Disconnect a device
     */
    disconnectDevice(deviceAddress) {
        this.logger.info('BluetoothScanModal', `Disconnecting device: ${deviceAddress}`);

        if (this.eventBus) {
            this.eventBus.emit('bluetooth:disconnect_requested', {
                address: deviceAddress
            });
        }
    }

    /**
     * Forget a paired device
     */
    unpairDevice(deviceAddress) {
        const t = (key, params) => typeof i18n !== 'undefined' ? i18n.t(key, params) : key;

        // Find the device name
        const device = this.pairedDevices.find(d => d.address === deviceAddress);
        const deviceName = device ? device.name : deviceAddress;

        // Show the confirmation modal
        this.showConfirmModal(
            t('bluetooth.forgetDevice.title'),
            `${t('bluetooth.forgetDevice.message', { deviceName: escapeHtml(deviceName) })}<br><br>${t('bluetooth.forgetDevice.warning')}`,
            async () => {
                this.logger.info('BluetoothScanModal', `Forgetting device: ${deviceAddress}`);

                try {
                    // Call the ble_forget command via the API
                    await window.api.sendCommand('ble_forget', { address: deviceAddress });

                    // Reload the paired devices list
                    this.loadPairedDevices();

                    this.logger.info('BluetoothScanModal', `Device ${deviceAddress} forgotten successfully`);
                } catch (error) {
                    this.logger.error('BluetoothScanModal', `Failed to forget device: ${error.message}`);
                }
            }
        );
    }

    // ========================================================================
    // HANDLERS
    // ========================================================================

    /**
     * Handle scan completion
     */
    handleScanComplete(data) {
        this.scanning = false;
        this.scanError = null;
        const allDevices = data.devices || [];

        // Filter out already-paired devices to avoid duplicates
        this.availableDevices = allDevices.filter(device => {
            const deviceId = device.id || device.address;
            const isAlreadyPaired = this.pairedDevices.some(
                paired => paired.address === deviceId
            );
            return !isAlreadyPaired;
        });

        this.logger.info('BluetoothScanModal', `Scan complete: ${allDevices.length} devices found, ${this.availableDevices.length} available (${allDevices.length - this.availableDevices.length} already paired)`);

        this.updateModalContent();
    }

    /**
     * Handle the paired devices list
     */
    handlePairedList(data) {
        this.pairedDevices = data.devices || [];

        this.logger.debug('BluetoothScanModal', `Paired devices loaded: ${this.pairedDevices.length}`);

        this.updateModalContent();
    }

    /**
     * Handle successful device pairing
     */
    handleDevicePaired(data) {
        this.logger.info('BluetoothScanModal', `Device paired: ${data.device_id}`);

        // Small delay to let the backend update
        setTimeout(() => {
            // Reload the paired devices list
            this.loadPairedDevices();
        }, 500);

        // Remove from the available list immediately
        this.availableDevices = this.availableDevices.filter(
            d => (d.id || d.address) !== data.device_id
        );

        this.updateModalContent();
    }

    /**
     * Handle scan errors
     */
    handleScanError(data) {
        this.scanning = false;
        this.scanError = data.error || 'Scan failed';

        this.logger.error('BluetoothScanModal', 'Scan error:', data.error);

        // Mark Bluetooth as unavailable only for errors that indicate the adapter
        // itself is off or unreachable (not for transient errors like timeouts).
        if (data.error) {
            const msg = data.error.toLowerCase();
            const isAdapterDown = msg.includes('poweredoff') ||
                msg.includes('powered off') ||
                msg.includes('d-bus') ||
                msg.includes('dbus') ||
                msg.includes('no adapter') ||
                msg.includes('adapter disposed') ||
                msg.includes('ble scan error');
            if (isAdapterDown) {
                this.bluetoothEnabled = false;
                this.bluetoothState = 'poweredOff';
            }
        }

        this.updateModalContent();
    }

    /**
     * Handle the Bluetooth state
     */
    handleBluetoothStatus(data) {
        this.bluetoothEnabled = data.enabled || false;
        this.bluetoothState = data.state || 'unknown';

        this.logger.info('BluetoothScanModal', `Bluetooth status: ${this.bluetoothState}`);

        this.updateModalContent();

        // If Bluetooth is enabled, start the scan and load the paired devices
        if (this.bluetoothEnabled) {
            this.startScan();
            this.loadPairedDevices();
        }
    }

    /**
     * Handle Bluetooth being powered on
     */
    handleBluetoothPoweredOn(_data) {
        this.bluetoothEnabled = true;
        this.bluetoothState = 'poweredOn';

        this.logger.info('BluetoothScanModal', 'Bluetooth powered on');

        this.updateModalContent();

        // Automatically start the scan
        this.startScan();
        this.loadPairedDevices();
    }

    /**
     * Handle Bluetooth being powered off
     */
    handleBluetoothPoweredOff(_data) {
        this.bluetoothEnabled = false;
        this.bluetoothState = 'poweredOff';
        this.scanning = false;

        this.logger.info('BluetoothScanModal', 'Bluetooth powered off');

        this.updateModalContent();
    }

    /**
     * Handle a device being forgotten
     */
    handleDeviceUnpaired(data) {
        const deviceId = data.device_id || data.address;

        this.logger.info('BluetoothScanModal', `Device unpaired: ${deviceId}`);

        // Remove from the paired devices list
        this.pairedDevices = this.pairedDevices.filter(
            d => d.address !== deviceId
        );

        this.updateModalContent();
    }

    /**
     * Handle a device connection
     */
    handleDeviceConnected(data) {
        const deviceId = data.device_id || data.address;

        this.logger.info('BluetoothScanModal', `Device connected: ${deviceId}`);

        // Refresh IMMEDIATELY to show the connected status
        this.loadPairedDevices();
    }

    /**
     * Handle a device disconnection
     */
    handleDeviceDisconnected(data) {
        const deviceId = data.device_id || data.address;

        this.logger.info('BluetoothScanModal', `Device disconnected: ${deviceId}`);

        // Reload the list from the backend to ensure we have the correct status
        this.loadPairedDevices();
    }

    // ========================================================================
    // BLUETOOTH POWER CONTROL
    // ========================================================================

    /**
     * Check the Bluetooth state
     */
    checkBluetoothStatus() {
        this.logger.debug('BluetoothScanModal', 'Checking Bluetooth status');

        if (this.eventBus) {
            this.eventBus.emit('bluetooth:status_requested');
        }
    }

    /**
     * Power on Bluetooth
     */
    powerOnBluetooth() {
        this.logger.info('BluetoothScanModal', 'Requesting Bluetooth power on');

        if (this.eventBus) {
            this.eventBus.emit('bluetooth:power_on_requested');
        }
    }

    /**
     * Power off Bluetooth
     */
    powerOffBluetooth() {
        this.logger.info('BluetoothScanModal', 'Requesting Bluetooth power off');

        if (this.eventBus) {
            this.eventBus.emit('bluetooth:power_off_requested');
        }
    }

    /**
     * Render the "Bluetooth disabled" message
     */
    renderBluetoothDisabled() {
        const t = (key, params) => typeof i18n !== 'undefined' ? i18n.t(key, params) : key;

        const isDark = document.body.classList.contains('dark-mode');
        const warnBg = isDark ? 'linear-gradient(135deg, #fff3cd 0%, #ffe5b4 100%)' : 'linear-gradient(135deg, rgba(240, 180, 41, 0.12) 0%, rgba(240, 180, 41, 0.08) 100%)';
        const warnBorder = isDark ? '#ffc107' : 'rgba(240, 180, 41, 0.4)';
        const warnText = isDark ? '#856404' : 'var(--text-primary, #856404)';
        const btnBg = isDark ? 'linear-gradient(135deg, #ffc107 0%, #ff9800 100%)' : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
        const btnShadow = isDark ? '0 2px 8px rgba(255, 193, 7, 0.4)' : '0 2px 8px rgba(118, 75, 162, 0.4)';

        return `
            <div class="bluetooth-disabled-section" style="
                background: ${warnBg};
                border: 2px solid ${warnBorder};
                border-radius: 12px;
                padding: 20px;
                margin-bottom: 20px;
                text-align: center;
            ">
                <div style="font-size: 48px; margin-bottom: 12px;">⚠️</div>
                <h3 style="margin: 0 0 12px; color: ${warnText}; font-size: 18px;">
                    ${t('bluetooth.disabled.title')}
                </h3>
                <p style="margin: 0 0 16px; color: ${warnText}; font-size: 14px;">
                    ${t('bluetooth.disabled.message')}<br>
                    ${t('bluetooth.disabled.enableMessage')}
                </p>
                <button class="btn-power-on" data-action="power_on" style="
                    padding: 12px 24px;
                    background: ${btnBg};
                    color: #fff;
                    border: none;
                    border-radius: 8px;
                    font-size: 15px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.2s;
                    box-shadow: ${btnShadow};
                ">
                    🔌 ${t('bluetooth.disabled.enableButton')}
                </button>
            </div>
        `;
    }

    // ========================================================================
    // UPDATE
    // ========================================================================

    /**
     * Update the modal content
     */
    updateModalContent() {
        if (!this.container || !this.isOpen) return;

        const modalDialog = this.container.querySelector('.modal-dialog');
        if (modalDialog) {
            // Re-render the entire modal content
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = this.renderModalContent();

            // Extract the inner content of modal-dialog (without the modal-dialog tag itself)
            const newContent = tempDiv.querySelector('.modal-dialog');
            if (newContent) {
                modalDialog.innerHTML = newContent.innerHTML;
            }

            // Re-attach the events
            this.attachModalEvents();
        }
    }

    // ========================================================================
    // CONFIRMATION MODAL
    // ========================================================================

    /**
     * Show a confirmation modal
     * @param {string} title - Modal title
     * @param {string} message - Confirmation message (can contain HTML)
     * @param {Function} onConfirm - Callback on confirmation
     */
    showConfirmModal(title, message, onConfirm) {
        const t = (key, params) => typeof i18n !== 'undefined' ? i18n.t(key, params) : key;

        // Prevent stacking of modals - close the previous one if it exists
        const existingConfirmModal = document.querySelector('.confirm-modal');
        if (existingConfirmModal) {
            existingConfirmModal.remove();
        }

        // Create the confirmation modal
        const confirmModal = document.createElement('div');
        confirmModal.className = 'modal-overlay confirm-modal';
        confirmModal.style.zIndex = '10001'; // Above the Bluetooth modal

        confirmModal.innerHTML = `
            <div class="modal-dialog modal-sm">
                <div class="modal-header">
                    <h2>${escapeHtml(title)}</h2>
                </div>
                <div class="modal-body">
                    <p>${message}</p>
                </div>
                <div class="modal-footer">
                    <button class="btn-secondary" data-action="cancel">${t('common.cancel')}</button>
                    <button class="btn-danger" data-action="confirm">${t('common.forget')}</button>
                </div>
            </div>
        `;

        document.body.appendChild(confirmModal);

        // Function to close the modal
        const closeModal = () => {
            if (confirmModal && confirmModal.parentNode) {
                confirmModal.remove();
            }
        };

        // Cancel button
        const cancelBtn = confirmModal.querySelector('[data-action="cancel"]');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                closeModal();
            });
        }

        // Confirm button
        const confirmBtn = confirmModal.querySelector('[data-action="confirm"]');
        if (confirmBtn) {
            confirmBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();

                // Prevent multiple clicks
                if (confirmBtn.disabled) {
                    return;
                }
                confirmBtn.disabled = true;
                confirmBtn.style.opacity = '0.5';
                confirmBtn.style.cursor = 'wait';

                closeModal();
                if (onConfirm) {
                    onConfirm();
                }
            }, { once: true });
        }

        // Click backdrop to close
        confirmModal.addEventListener('click', (e) => {
            if (e.target === confirmModal) {
                closeModal();
            }
        });
    }

    // ========================================================================
    // UTILITIES
    // ========================================================================

}

// ============================================================================
// EXPORT
// ============================================================================

if (typeof module !== 'undefined' && module.exports) {
    module.exports = BluetoothScanModal;
}

if (typeof window !== 'undefined') {
    window.BluetoothScanModal = BluetoothScanModal;
}
