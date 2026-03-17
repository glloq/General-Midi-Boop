// ============================================================================
// Fichier: frontend/js/views/components/NetworkScanModal.js
// Version: v1.1.0 (i18n support)
// Date: 2025-11-16
// ============================================================================
// Description:
//   Modal personnalisée pour scanner et connecter des instruments via réseau/WiFi
//   - Affichage des périphériques disponibles sur le réseau
//   - Connexion aux instruments
//   - Interface utilisateur intuitive
//   - Support multilingue (i18n)
//
// Dépendance: i18n doit être chargé avant ce script (js/i18n/I18n.js)
// ============================================================================

class NetworkScanModal {
    constructor(eventBus) {
        this.eventBus = eventBus || window.eventBus || null;
        this.logger = window.logger || console;

        this.container = null;
        this.isOpen = false;
        this.scanning = false;
        this.availableDevices = [];
        this.connectedDevices = [];

        this.setupEventListeners();

        this.logger.info('NetworkScanModal', '✓ Modal initialized v1.1.0 (i18n)');
    }

    // Helper pour les traductions
    t(key, params) {
        return typeof i18n !== 'undefined' ? i18n.t(key, params) : key;
    }

    // ========================================================================
    // ÉVÉNEMENTS
    // ========================================================================

    setupEventListeners() {
        if (!this.eventBus) return;

        // Réponse du scan réseau
        this.eventBus.on('network:scanned', (data) => {
            this.handleScanComplete(data);
        });

        // Réponse de la liste des appareils connectés
        this.eventBus.on('network:connected_list', (data) => {
            this.handleConnectedList(data);
        });

        // Connexion réussie
        this.eventBus.on('network:connected', (data) => {
            this.handleDeviceConnected(data);
        });

        // Déconnexion réussie
        this.eventBus.on('network:disconnected', (data) => {
            this.handleDeviceDisconnected(data);
        });

        // Erreur de scan
        this.eventBus.on('network:scan_error', (data) => {
            this.handleScanError(data);
        });

        // Écouter les changements de langue
        if (typeof i18n !== 'undefined') {
            this._localeUnsubscribe = i18n.onLocaleChange(() => this.updateModalContent());
        }

        this.logger.debug('NetworkScanModal', 'Event listeners configured');
    }

    // ========================================================================
    // AFFICHAGE DE LA MODAL
    // ========================================================================

    /**
     * Ouvre la modal et lance le scan
     */
    open() {
        if (this.isOpen) {
            this.logger.warn('NetworkScanModal', 'Modal already open');
            return;
        }

        this.isOpen = true;
        this.availableDevices = [];
        this.connectedDevices = [];

        this.createModal();
        this.loadConnectedDevices();
        this.startScan();

        this.logger.info('NetworkScanModal', 'Modal opened');
    }

    /**
     * Ferme la modal
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

        this.logger.info('NetworkScanModal', 'Modal closed');
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
        this.container.className = 'modal-overlay network-scan-modal';
        this.container.innerHTML = this.renderModalContent();

        document.body.appendChild(this.container);

        // Attacher les événements
        this.attachModalEvents();
    }

    /**
     * Rendu du contenu de la modal
     */
    renderModalContent() {
        return `
            <div class="modal-dialog modal-lg">
                <div class="modal-header">
                    <h2>🌐 ${this.t('network.title')}</h2>
                    <button class="modal-close" data-action="close">&times;</button>
                </div>

                <div class="modal-body">
                    <!-- Section ajout manuel d'IP -->
                    <div class="manual-ip-section">
                        <div class="manual-ip-header">
                            <h3>🎯 ${this.t('network.manualConnection.title')}</h3>
                            <p class="text-muted" style="margin: 0; font-size: 12px;">${this.t('network.manualConnection.description')}</p>
                        </div>
                        <div class="manual-ip-form">
                            <div class="form-row">
                                <div class="form-group">
                                    <label for="manualIp">${this.t('network.manualConnection.ipAddress')}</label>
                                    <input type="text"
                                           id="manualIp"
                                           placeholder="${this.t('network.manualConnection.ipPlaceholder')}"
                                           pattern="^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$">
                                </div>
                                <div class="form-group">
                                    <label for="manualPort">${this.t('network.manualConnection.port')}</label>
                                    <input type="text"
                                           id="manualPort"
                                           placeholder="5004"
                                           value="5004">
                                </div>
                                <button class="btn-connect-manual" data-action="connect-manual">
                                    🔌 ${this.t('common.connect')}
                                </button>
                            </div>
                        </div>
                    </div>

                    <!-- Section scan -->
                    <div class="scan-section">
                        <div class="scan-header">
                            <div class="scan-header-left">
                                <h3>${this.t('network.availableDevices')}</h3>
                                <div class="scan-options">
                                    <label class="checkbox-label">
                                        <input type="checkbox" id="fullScanCheckbox" checked ${this.scanning ? 'disabled' : ''}>
                                        <span>${this.t('network.showAllIPs')}</span>
                                    </label>
                                    <p class="text-muted" style="margin: 4px 0 0 24px; font-size: 11px;">
                                        ${this.t('network.fullScanDescription')}
                                    </p>
                                </div>
                            </div>
                            <button class="btn-scan ${this.scanning ? 'scanning' : ''}"
                                    data-action="scan" ${this.scanning ? 'disabled' : ''}>
                                ${this.scanning ? `🔄 ${this.t('bluetooth.scanning')}` : `🔍 ${this.t('common.search')}`}
                            </button>
                        </div>

                        <div class="devices-list" id="networkAvailableDevices">
                            ${this.renderAvailableDevices()}
                        </div>
                    </div>

                    <!-- Section appareils connectés -->
                    ${this.connectedDevices.length > 0 ? `
                        <div class="connected-section">
                            <h3>${this.t('network.connectedDevices')}</h3>
                            <div class="devices-list" id="networkConnectedDevices">
                                ${this.renderConnectedDevices()}
                            </div>
                        </div>
                    ` : ''}

                    <!-- Informations -->
                    <div class="info-section">
                        <p>
                            💡 <strong>${this.t('network.tipLabel')}</strong> ${this.t('network.tip')}
                        </p>
                    </div>
                </div>

                <div class="modal-footer">
                    <button class="btn-secondary" data-action="close">${this.t('common.close')}</button>
                </div>
            </div>
        `;
    }

    /**
     * Rendu de la liste des périphériques disponibles
     */
    renderAvailableDevices() {
        if (this.scanning) {
            return `
                <div class="devices-scanning">
                    <div class="spinner"></div>
                    <p>${this.t('network.searchingDevices')}</p>
                    <p class="text-muted">${this.t('network.operationMayTakeTime')}</p>
                </div>
            `;
        }

        if (this.availableDevices.length === 0) {
            return `
                <div class="devices-empty">
                    <div class="empty-icon">🔍</div>
                    <p>${this.t('network.noDeviceDetected')}</p>
                    <p class="text-muted">${this.t('network.clickToScan')}</p>
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
        const deviceName = escapeHtml(device.name || this.t('network.networkInstrument'));
        const deviceIp = device.ip || device.address || this.t('network.unknownIP');
        const devicePort = device.port || '';

        return `
            <div class="device-card network-device" data-device-ip="${deviceIp}">
                <div class="device-icon">🌐</div>
                <div class="device-info">
                    <div class="device-name">${deviceName}</div>
                    <div class="device-ip">${deviceIp}${devicePort ? ':' + devicePort : ''}</div>
                    ${device.type ? `<div class="device-signal">🎹 ${this.t('network.type')}: ${device.type}</div>` : ''}
                    ${device.manufacturer ? `<div class="device-signal">🏭 ${this.t('network.manufacturer')}: ${device.manufacturer}</div>` : ''}
                </div>
                <div class="device-actions">
                    <button class="btn-connect-network" data-action="connect"
                            data-device-ip="${deviceIp}"
                            data-device-port="${devicePort || ''}"
                            data-device-name="${deviceName}">
                        🔌 ${this.t('common.connect')}
                    </button>
                </div>
            </div>
        `;
    }

    /**
     * Rendu de la liste des périphériques connectés
     */
    renderConnectedDevices() {
        if (this.connectedDevices.length === 0) {
            return `<p class="text-muted">${this.t('network.noDeviceConnected')}</p>`;
        }

        return `
            <div class="devices-grid">
                ${this.connectedDevices.map(device => this.renderConnectedDevice(device)).join('')}
            </div>
        `;
    }

    /**
     * Rendu d'un périphérique connecté
     */
    renderConnectedDevice(device) {
        const deviceName = escapeHtml(device.name || device.ip);
        const deviceIp = device.ip || device.address;
        const devicePort = device.port || '';

        return `
            <div class="device-card network-device connected" data-device-ip="${deviceIp}">
                <div class="device-icon">✓</div>
                <div class="device-info">
                    <div class="device-name">${deviceName}</div>
                    <div class="device-ip">${deviceIp}${devicePort ? ':' + devicePort : ''}</div>
                    <div class="device-status">
                        <span class="status-badge connected">✓ ${this.t('network.connected')}</span>
                    </div>
                </div>
                <div class="device-actions">
                    <button class="btn-disconnect" data-action="disconnect"
                            data-device-ip="${deviceIp}"
                            data-device-name="${deviceName}">
                        ${this.t('common.disconnect')}
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

        // Utiliser la délégation d'événements sur le conteneur
        // pour gérer TOUS les clics (fermeture, scan, connexion, déconnexion)
        this.container.addEventListener('click', (e) => {
            const action = e.target.dataset.action;

            // Fermeture
            if (action === 'close' || e.target === this.container) {
                this.close();
                return;
            }

            // Scan
            if (action === 'scan') {
                this.startScan();
                return;
            }

            // Connexion manuelle
            if (action === 'connect-manual') {
                this.connectManual();
                return;
            }

            // Connexion device
            if (action === 'connect') {
                const deviceIp = e.target.dataset.deviceIp;
                const devicePort = e.target.dataset.devicePort;
                const deviceName = e.target.dataset.deviceName;
                if (deviceIp) this.connectDevice(deviceIp, devicePort, deviceName);
                return;
            }

            // Déconnexion device
            if (action === 'disconnect') {
                const deviceIp = e.target.dataset.deviceIp;
                const deviceName = e.target.dataset.deviceName || `Appareil ${deviceIp}`;
                if (deviceIp) this.showDisconnectModal(deviceIp, deviceName);
                return;
            }
        });

        // Enter sur le champ IP
        const manualIpInput = this.container.querySelector('#manualIp');
        if (manualIpInput) {
            manualIpInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    this.connectManual();
                }
            });
        }
    }

    // ========================================================================
    // ACTIONS
    // ========================================================================

    /**
     * Lance le scan réseau
     */
    startScan() {
        if (this.scanning) {
            this.logger.warn('NetworkScanModal', 'Scan already in progress');
            return;
        }

        this.scanning = true;
        this.availableDevices = [];

        // Vérifier si le scan complet est activé
        const fullScanCheckbox = this.container ? this.container.querySelector('#fullScanCheckbox') : null;
        const fullScan = fullScanCheckbox ? fullScanCheckbox.checked : false;

        // Debug: Confirmer l'état de la checkbox
        console.log('='.repeat(80));
        console.log('🔍 DÉMARRAGE DU SCAN');
        console.log(`   Checkbox trouvée: ${fullScanCheckbox ? 'OUI' : 'NON'}`);
        console.log(`   fullScan activé: ${fullScan ? 'OUI ✅' : 'NON ❌'}`);
        console.log('='.repeat(80));

        this.updateModalContent();

        this.logger.info('NetworkScanModal', `Starting network scan (fullScan: ${fullScan})`);

        if (this.eventBus) {
            this.eventBus.emit('network:scan_requested', { fullScan });
        } else {
            this.logger.error('NetworkScanModal', 'EventBus not available');
            this.scanning = false;
            this.updateModalContent();
        }
    }

    /**
     * Connecte manuellement via IP
     */
    connectManual() {
        const ipInput = this.container.querySelector('#manualIp');
        const portInput = this.container.querySelector('#manualPort');

        if (!ipInput) {
            this.logger.error('NetworkScanModal', 'IP input not found');
            return;
        }

        const ip = ipInput.value.trim();
        const port = portInput ? portInput.value.trim() : '5004';

        // Validation de l'adresse IP
        if (!ip) {
            alert(`⚠️ ${this.t('network.invalidIP.empty')}`);
            ipInput.focus();
            return;
        }

        // Regex pour valider l'IP
        const ipPattern = /^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
        if (!ipPattern.test(ip)) {
            alert(`⚠️ ${this.t('network.invalidIP.format')}`);
            ipInput.focus();
            return;
        }

        this.logger.info('NetworkScanModal', `Manual connection to: ${ip}:${port}`);

        // Connecter le périphérique
        const deviceName = `${this.t('network.networkInstrument')} (${ip})`;
        this.connectDevice(ip, port, deviceName);

        // Vider les champs après connexion
        ipInput.value = '';
        if (portInput) portInput.value = '5004';
    }

    /**
     * Charge la liste des périphériques connectés
     */
    loadConnectedDevices() {
        this.logger.debug('NetworkScanModal', 'Loading connected devices');

        if (this.eventBus) {
            this.eventBus.emit('network:connected_requested');
        }
    }

    /**
     * Connecte un périphérique
     */
    connectDevice(deviceIp, devicePort, deviceName) {
        this.logger.info('NetworkScanModal', `Connecting device: ${deviceIp}${devicePort ? ':' + devicePort : ''}`);

        if (this.eventBus) {
            this.eventBus.emit('network:connect_requested', {
                ip: deviceIp,
                port: devicePort || '',
                address: deviceIp,
                name: deviceName
            });
        }
    }

    /**
     * Affiche le modal de confirmation de déconnexion
     */
    showDisconnectModal(deviceIp, deviceName) {
        // Créer le modal
        const modalOverlay = document.createElement('div');
        modalOverlay.className = 'disconnect-modal-overlay';
        modalOverlay.innerHTML = `
            <div class="disconnect-modal">
                <div class="disconnect-modal-header">
                    <h3>⚠️ ${this.t('network.disconnect.title')}</h3>
                </div>
                <div class="disconnect-modal-body">
                    <p>${this.t('network.disconnect.message')}</p>
                    <div class="disconnect-device-info">
                        <strong>${escapeHtml(deviceName)}</strong>
                        <span class="device-ip-small">${deviceIp}</span>
                    </div>
                    <p class="warning-text">
                        ⚠️ ${this.t('network.disconnect.warning')}
                    </p>
                </div>
                <div class="disconnect-modal-footer">
                    <button class="btn-cancel" data-action="cancel">${this.t('common.cancel')}</button>
                    <button class="btn-confirm-disconnect" data-action="confirm">${this.t('common.disconnect')}</button>
                </div>
            </div>
        `;

        // Ajouter au DOM
        document.body.appendChild(modalOverlay);

        // Gérer les clics
        modalOverlay.addEventListener('click', (e) => {
            if (e.target === modalOverlay || e.target.dataset.action === 'cancel') {
                modalOverlay.remove();
            } else if (e.target.dataset.action === 'confirm') {
                modalOverlay.remove();
                this.disconnectDevice(deviceIp);
            }
        });

        // Focus sur le bouton annuler par défaut
        setTimeout(() => {
            const cancelBtn = modalOverlay.querySelector('.btn-cancel');
            if (cancelBtn) cancelBtn.focus();
        }, 100);
    }

    /**
     * Déconnecte un périphérique (sans confirmation)
     */
    disconnectDevice(deviceIp) {
        this.logger.info('NetworkScanModal', `Disconnecting device: ${deviceIp}`);

        if (this.eventBus) {
            this.eventBus.emit('network:disconnect_requested', {
                ip: deviceIp,
                address: deviceIp
            });
        }
    }

    // ========================================================================
    // HANDLERS
    // ========================================================================

    /**
     * Gère la fin du scan
     */
    handleScanComplete(data) {
        this.scanning = false;
        this.availableDevices = data.devices || [];

        this.logger.info('NetworkScanModal', `Scan complete: ${this.availableDevices.length} devices found`);

        // Debug: Afficher les devices reçus
        console.log('='.repeat(80));
        console.log('📡 SCAN TERMINÉ - Devices reçus du backend:');
        console.log(`   Total: ${this.availableDevices.length} devices`);
        this.availableDevices.forEach((device, index) => {
            console.log(`   ${index + 1}. ${device.name} (${device.ip}) - Type: ${device.type}`);
        });
        console.log('='.repeat(80));

        this.updateModalContent();
    }

    /**
     * Gère la liste des périphériques connectés
     */
    handleConnectedList(data) {
        this.connectedDevices = data.devices || [];

        this.logger.debug('NetworkScanModal', `Connected devices loaded: ${this.connectedDevices.length}`);

        this.updateModalContent();
    }

    /**
     * Gère la connexion réussie d'un périphérique
     */
    handleDeviceConnected(data) {
        this.logger.info('NetworkScanModal', `Device connected: ${data.ip || data.address}`);

        // Recharger la liste des appareils connectés
        this.loadConnectedDevices();

        // Supprimer de la liste des disponibles
        const deviceIp = data.ip || data.address;
        this.availableDevices = this.availableDevices.filter(
            d => d.ip !== deviceIp && d.address !== deviceIp
        );

        this.updateModalContent();

        // Afficher un message de succès
        if (this.logger.success) {
            this.logger.success('NetworkScanModal', this.t('network.connectionSuccess', { name: data.name || deviceIp }));
        }
    }

    /**
     * Gère la déconnexion d'un périphérique
     */
    handleDeviceDisconnected(data) {
        this.logger.info('NetworkScanModal', `Device disconnected: ${data.ip || data.address}`);

        // Recharger la liste des appareils connectés
        this.loadConnectedDevices();

        this.updateModalContent();
    }

    /**
     * Gère les erreurs de scan
     */
    handleScanError(data) {
        this.scanning = false;

        this.logger.error('NetworkScanModal', 'Scan error:', data.error);

        this.updateModalContent();
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
            const fullHTML = this.renderModalContent();
            // Extraire le contenu entre la première balise ouvrante et la dernière fermante
            const innerHTML = fullHTML
                .replace(/^\s*<div class="modal-dialog modal-lg">\s*/, '')
                .replace(/\s*<\/div>\s*$/, '');
            modalDialog.innerHTML = innerHTML;

            // Réattacher uniquement l'événement Enter sur le champ IP
            // (les autres sont délégués au conteneur)
            const manualIpInput = this.container.querySelector('#manualIp');
            if (manualIpInput) {
                manualIpInput.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') {
                        this.connectManual();
                    }
                });
            }
        }
    }

    // ========================================================================
    // UTILITAIRES
    // ========================================================================

}

// ============================================================================
// EXPORT
// ============================================================================

if (typeof module !== 'undefined' && module.exports) {
    module.exports = NetworkScanModal;
}

if (typeof window !== 'undefined') {
    window.NetworkScanModal = NetworkScanModal;
}
