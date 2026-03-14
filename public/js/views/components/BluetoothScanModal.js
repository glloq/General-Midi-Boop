// ============================================================================
// Fichier: frontend/js/views/components/BluetoothScanModal.js
// Version: v1.1.0 (i18n support)
// Date: 2025-11-16
// ============================================================================
// Description:
//   Modal personnalisée pour scanner et connecter des instruments Bluetooth
//   - Affichage des périphériques disponibles
//   - Appairage et connexion
//   - Interface utilisateur intuitive
//   - Support multilingue (i18n)
//
// Dépendance: i18n doit être chargé avant ce script (js/i18n/I18n.js)
// ============================================================================

class BluetoothScanModal {
    constructor(eventBus) {
        this.eventBus = eventBus || window.eventBus || null;
        this.logger = window.logger || console;

        this.container = null;
        this.isOpen = false;
        this.scanning = false;
        this.bluetoothEnabled = true; // État du Bluetooth
        this.bluetoothState = 'unknown'; // État détaillé
        this.availableDevices = [];
        this.pairedDevices = [];

        this.setupEventListeners();

        this.logger.info('BluetoothScanModal', '✓ Modal initialized v1.1.0 (i18n)');
    }

    // ========================================================================
    // ÉVÉNEMENTS
    // ========================================================================

    setupEventListeners() {
        if (!this.eventBus) return;

        // Réponse du scan Bluetooth
        this.eventBus.on('bluetooth:scanned', (data) => {
            this.handleScanComplete(data);
        });

        // Réponse de la liste des appareils appairés
        this.eventBus.on('bluetooth:paired_list', (data) => {
            this.handlePairedList(data);
        });

        // Appairage réussi
        this.eventBus.on('bluetooth:paired', (data) => {
            this.handleDevicePaired(data);
        });

        // Erreur de scan
        this.eventBus.on('bluetooth:scan_error', (data) => {
            this.handleScanError(data);
        });

        // État du Bluetooth
        this.eventBus.on('bluetooth:status', (data) => {
            this.handleBluetoothStatus(data);
        });

        // Bluetooth activé
        this.eventBus.on('bluetooth:powered_on', (data) => {
            this.handleBluetoothPoweredOn(data);
        });

        // Bluetooth désactivé
        this.eventBus.on('bluetooth:powered_off', (data) => {
            this.handleBluetoothPoweredOff(data);
        });

        // Périphérique oublié
        this.eventBus.on('bluetooth:unpaired', (data) => {
            this.handleDeviceUnpaired(data);
        });

        // Périphérique connecté
        this.eventBus.on('bluetooth:connected', (data) => {
            this.handleDeviceConnected(data);
        });

        // Périphérique déconnecté
        this.eventBus.on('bluetooth:disconnected', (data) => {
            this.handleDeviceDisconnected(data);
        });

        // Écouter les changements de langue
        if (typeof i18n !== 'undefined') {
            i18n.onLocaleChange(() => this.updateModalContent());
        }

        this.logger.debug('BluetoothScanModal', 'Event listeners configured');
    }

    // ========================================================================
    // AFFICHAGE DE LA MODAL
    // ========================================================================

    /**
     * Ouvre la modal et lance le scan
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
        this.checkBluetoothStatus(); // Vérifier l'état du Bluetooth

        this.logger.info('BluetoothScanModal', 'Modal opened');
    }

    /**
     * Ferme la modal
     */
    close() {
        if (!this.isOpen) return;

        this.isOpen = false;
        this.scanning = false;

        if (this.container) {
            this.container.remove();
            this.container = null;
        }

        this.logger.info('BluetoothScanModal', 'Modal closed');
    }

    /**
     * Crée le DOM de la modal
     */
    createModal() {
        // Supprimer l'ancienne modal si elle existe
        if (this.container) {
            this.container.remove();
        }

        // Créer la nouvelle modal
        this.container = document.createElement('div');
        this.container.className = 'modal-overlay bluetooth-scan-modal';
        this.container.innerHTML = this.renderModalContent();

        document.body.appendChild(this.container);

        // Attacher les événements
        this.attachModalEvents();

        // Attacher la délégation d'événements pour les actions sur les périphériques UNE SEULE FOIS
        // Ces listeners restent actifs même après updateModalContent()
        this.container.addEventListener('click', (e) => {
            // Clic sur le fond pour fermer
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
     * Rendu du contenu de la modal
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
                    <!-- État du Bluetooth -->
                    ${!this.bluetoothEnabled ? this.renderBluetoothDisabled() : ''}

                    <!-- Section scan -->
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

                    <!-- Section appareils appairés -->
                    ${this.pairedDevices.length > 0 ? `
                        <div class="paired-section">
                            <h3>${t('bluetooth.pairedDevices')}</h3>
                            <div class="devices-list" id="bluetoothPairedDevices">
                                ${this.renderPairedDevices()}
                            </div>
                        </div>
                    ` : ''}

                    <!-- Informations -->
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
     * Rendu de la liste des périphériques disponibles
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
     * Rendu d'un périphérique disponible
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
     * Rendu de la liste des périphériques appairés
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
     * Rendu d'un périphérique appairé
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
    // ÉVÉNEMENTS DOM
    // ========================================================================

    /**
     * Attache les événements de la modal
     */
    attachModalEvents() {
        if (!this.container) return;

        // IMPORTANT: Ne réattacher les event listeners que pour les nouveaux éléments
        // Les event listeners sur le container principal sont attachés une seule fois à la création

        // Fermeture de la modal - réattacher car les boutons sont re-rendus
        const closeButtons = this.container.querySelectorAll('[data-action="close"]');
        closeButtons.forEach(btn => {
            // Retirer l'ancien listener s'il existe
            btn.removeEventListener('click', this._closeHandler);
            btn.addEventListener('click', () => this.close());
        });

        // Bouton de scan - réattacher car re-rendu
        const scanButton = this.container.querySelector('[data-action="scan"]');
        if (scanButton) {
            scanButton.removeEventListener('click', this._scanHandler);
            this._scanHandler = () => this.startScan();
            scanButton.addEventListener('click', this._scanHandler);
        }

        // Bouton d'activation Bluetooth - réattacher car re-rendu
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
     * Lance le scan Bluetooth
     */
    startScan() {
        if (this.scanning) {
            this.logger.warn('BluetoothScanModal', 'Scan already in progress');
            return;
        }

        this.scanning = true;
        this.availableDevices = [];
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
     * Charge la liste des périphériques appairés
     */
    loadPairedDevices() {
        this.logger.debug('BluetoothScanModal', 'Loading paired devices');

        if (this.eventBus) {
            this.eventBus.emit('bluetooth:paired_requested');
        }
    }

    /**
     * Appaire un périphérique
     */
    pairDevice(deviceId, deviceName) {
        this.logger.info('BluetoothScanModal', `Pairing device: ${deviceId}`);

        // Désactiver le bouton pendant l'appairage SANS changer le texte
        // (évite le problème de fond violet)
        const deviceCard = this.container.querySelector(`[data-device-id="${deviceId}"]`);
        if (deviceCard) {
            const button = deviceCard.querySelector('.btn-pair');
            if (button) {
                // Empêcher les clics multiples
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
     * Connecte un périphérique appairé
     */
    connectDevice(deviceAddress) {
        this.logger.info('BluetoothScanModal', `Connecting device: ${deviceAddress}`);

        // Désactiver le bouton pendant la connexion pour éviter les clics multiples
        // MAIS ne pas changer le texte pour éviter le problème de fond violet
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

        // NE PAS fermer la modal - laisser l'utilisateur voir le statut
        // this.close(); // SUPPRIMÉ
    }

    /**
     * Déconnecte un périphérique
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
     * Oublie un périphérique appairé
     */
    unpairDevice(deviceAddress) {
        const t = (key, params) => typeof i18n !== 'undefined' ? i18n.t(key, params) : key;

        // Trouver le nom du périphérique
        const device = this.pairedDevices.find(d => d.address === deviceAddress);
        const deviceName = device ? device.name : deviceAddress;

        // Afficher la modal de confirmation
        this.showConfirmModal(
            t('bluetooth.forgetDevice.title'),
            `${t('bluetooth.forgetDevice.message', { deviceName: escapeHtml(deviceName) })}<br><br>${t('bluetooth.forgetDevice.warning')}`,
            async () => {
                this.logger.info('BluetoothScanModal', `Forgetting device: ${deviceAddress}`);

                try {
                    // Appeler la commande ble_forget via l'API
                    await window.api.sendCommand('ble_forget', { address: deviceAddress });

                    // Recharger la liste des appareils appairés
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
     * Gère la fin du scan
     */
    handleScanComplete(data) {
        this.scanning = false;
        const allDevices = data.devices || [];

        // Filtrer les périphériques déjà appairés pour éviter les doublons
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
     * Gère la liste des périphériques appairés
     */
    handlePairedList(data) {
        this.pairedDevices = data.devices || [];

        this.logger.debug('BluetoothScanModal', `Paired devices loaded: ${this.pairedDevices.length}`);

        this.updateModalContent();
    }

    /**
     * Gère l'appairage réussi d'un périphérique
     */
    handleDevicePaired(data) {
        this.logger.info('BluetoothScanModal', `Device paired: ${data.device_id}`);

        // Petit délai pour laisser le backend mettre à jour
        setTimeout(() => {
            // Recharger la liste des appareils appairés
            this.loadPairedDevices();
        }, 500);

        // Supprimer de la liste des disponibles immédiatement
        this.availableDevices = this.availableDevices.filter(
            d => (d.id || d.address) !== data.device_id
        );

        this.updateModalContent();
    }

    /**
     * Gère les erreurs de scan
     */
    handleScanError(data) {
        this.scanning = false;

        this.logger.error('BluetoothScanModal', 'Scan error:', data.error);

        // Vérifier si c'est une erreur de Bluetooth désactivé
        if (data.error && data.error.includes('poweredOff')) {
            this.bluetoothEnabled = false;
            this.bluetoothState = 'poweredOff';
        }

        this.updateModalContent();
    }

    /**
     * Gère l'état du Bluetooth
     */
    handleBluetoothStatus(data) {
        this.bluetoothEnabled = data.enabled || false;
        this.bluetoothState = data.state || 'unknown';

        this.logger.info('BluetoothScanModal', `Bluetooth status: ${this.bluetoothState}`);

        this.updateModalContent();

        // Si Bluetooth est activé, lancer le scan et charger les périphériques appairés
        if (this.bluetoothEnabled) {
            this.startScan();
            this.loadPairedDevices();
        }
    }

    /**
     * Gère l'activation du Bluetooth
     */
    handleBluetoothPoweredOn(data) {
        this.bluetoothEnabled = true;
        this.bluetoothState = 'poweredOn';

        this.logger.info('BluetoothScanModal', 'Bluetooth powered on');

        this.updateModalContent();

        // Lancer automatiquement le scan
        this.startScan();
        this.loadPairedDevices();
    }

    /**
     * Gère la désactivation du Bluetooth
     */
    handleBluetoothPoweredOff(data) {
        this.bluetoothEnabled = false;
        this.bluetoothState = 'poweredOff';
        this.scanning = false;

        this.logger.info('BluetoothScanModal', 'Bluetooth powered off');

        this.updateModalContent();
    }

    /**
     * Gère l'oubli d'un périphérique
     */
    handleDeviceUnpaired(data) {
        const deviceId = data.device_id || data.address;

        this.logger.info('BluetoothScanModal', `Device unpaired: ${deviceId}`);

        // Supprimer de la liste des appareils appairés
        this.pairedDevices = this.pairedDevices.filter(
            d => d.address !== deviceId
        );

        this.updateModalContent();
    }

    /**
     * Gère la connexion d'un périphérique
     */
    handleDeviceConnected(data) {
        const deviceId = data.device_id || data.address;

        this.logger.info('BluetoothScanModal', `Device connected: ${deviceId}`);

        // Rafraîchir IMMÉDIATEMENT pour afficher le statut connecté
        this.loadPairedDevices();
    }

    /**
     * Gère la déconnexion d'un périphérique
     */
    handleDeviceDisconnected(data) {
        const deviceId = data.device_id || data.address;

        this.logger.info('BluetoothScanModal', `Device disconnected: ${deviceId}`);

        // Recharger la liste depuis le backend pour être sûr d'avoir le bon statut
        this.loadPairedDevices();
    }

    // ========================================================================
    // BLUETOOTH POWER CONTROL
    // ========================================================================

    /**
     * Vérifie l'état du Bluetooth
     */
    checkBluetoothStatus() {
        this.logger.debug('BluetoothScanModal', 'Checking Bluetooth status');

        if (this.eventBus) {
            this.eventBus.emit('bluetooth:status_requested');
        }
    }

    /**
     * Active le Bluetooth
     */
    powerOnBluetooth() {
        this.logger.info('BluetoothScanModal', 'Requesting Bluetooth power on');

        if (this.eventBus) {
            this.eventBus.emit('bluetooth:power_on_requested');
        }
    }

    /**
     * Désactive le Bluetooth
     */
    powerOffBluetooth() {
        this.logger.info('BluetoothScanModal', 'Requesting Bluetooth power off');

        if (this.eventBus) {
            this.eventBus.emit('bluetooth:power_off_requested');
        }
    }

    /**
     * Rendu du message Bluetooth désactivé
     */
    renderBluetoothDisabled() {
        const t = (key, params) => typeof i18n !== 'undefined' ? i18n.t(key, params) : key;

        return `
            <div class="bluetooth-disabled-section" style="
                background: linear-gradient(135deg, #fff3cd 0%, #ffe5b4 100%);
                border: 2px solid #ffc107;
                border-radius: 12px;
                padding: 20px;
                margin-bottom: 20px;
                text-align: center;
            ">
                <div style="font-size: 48px; margin-bottom: 12px;">⚠️</div>
                <h3 style="margin: 0 0 12px; color: #856404; font-size: 18px;">
                    ${t('bluetooth.disabled.title')}
                </h3>
                <p style="margin: 0 0 16px; color: #856404; font-size: 14px;">
                    ${t('bluetooth.disabled.message')}<br>
                    ${t('bluetooth.disabled.enableMessage')}
                </p>
                <button class="btn-power-on" data-action="power_on" style="
                    padding: 12px 24px;
                    background: linear-gradient(135deg, #ffc107 0%, #ff9800 100%);
                    color: #fff;
                    border: none;
                    border-radius: 8px;
                    font-size: 15px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.2s;
                    box-shadow: 0 2px 8px rgba(255, 193, 7, 0.4);
                ">
                    🔌 ${t('bluetooth.disabled.enableButton')}
                </button>
            </div>
        `;
    }

    // ========================================================================
    // MISE À JOUR
    // ========================================================================

    /**
     * Met à jour le contenu de la modal
     */
    updateModalContent() {
        if (!this.container || !this.isOpen) return;

        const modalDialog = this.container.querySelector('.modal-dialog');
        if (modalDialog) {
            // Re-render le contenu complet de la modal
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = this.renderModalContent();

            // Extraire le contenu interne du modal-dialog (sans la balise modal-dialog elle-même)
            const newContent = tempDiv.querySelector('.modal-dialog');
            if (newContent) {
                modalDialog.innerHTML = newContent.innerHTML;
            }

            // Réattacher les événements
            this.attachModalEvents();
        }
    }

    // ========================================================================
    // MODAL DE CONFIRMATION
    // ========================================================================

    /**
     * Affiche une modal de confirmation
     * @param {string} title - Titre de la modal
     * @param {string} message - Message de confirmation (peut contenir du HTML)
     * @param {Function} onConfirm - Callback si confirmé
     */
    showConfirmModal(title, message, onConfirm) {
        const t = (key, params) => typeof i18n !== 'undefined' ? i18n.t(key, params) : key;

        // Empêcher l'empilement de modals - fermer la précédente si elle existe
        const existingConfirmModal = document.querySelector('.confirm-modal');
        if (existingConfirmModal) {
            existingConfirmModal.remove();
        }

        // Créer la modal de confirmation
        const confirmModal = document.createElement('div');
        confirmModal.className = 'modal-overlay confirm-modal';
        confirmModal.style.zIndex = '10001'; // Au-dessus de la modal Bluetooth

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

        // Fonction pour fermer la modal
        const closeModal = () => {
            if (confirmModal && confirmModal.parentNode) {
                confirmModal.remove();
            }
        };

        // Bouton Annuler
        const cancelBtn = confirmModal.querySelector('[data-action="cancel"]');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                closeModal();
            });
        }

        // Bouton Confirmer
        const confirmBtn = confirmModal.querySelector('[data-action="confirm"]');
        if (confirmBtn) {
            confirmBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();

                // Empêcher les clics multiples
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

        // Clic sur le fond pour fermer
        confirmModal.addEventListener('click', (e) => {
            if (e.target === confirmModal) {
                closeModal();
            }
        });
    }

    // ========================================================================
    // UTILITAIRES
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
