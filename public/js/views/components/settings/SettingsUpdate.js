(function() {
    'use strict';
    const SettingsUpdate = {};

    // Step labels, icons and progress percentages for update status tracking
    const UPDATE_STEPS = {
        script_started: { label: 'Initialisation...', icon: '🔧', progress: 10 },
        started:        { label: 'Démarrage...', icon: '🔧', progress: 15 },
        pulling:        { label: 'Téléchargement des sources...', icon: '📥', progress: 30 },
        installing:     { label: 'Installation des dépendances...', icon: '📦', progress: 55 },
        restarting:     { label: 'Redémarrage du serveur...', icon: '🔄', progress: 80 },
        verifying:      { label: 'Vérification...', icon: '🔍', progress: 90 },
        done:           { label: 'Mise à jour terminée !', icon: '✅', progress: 100 },
    };

    // Maximum time to wait for the update to complete (5 minutes)
    const UPDATE_TIMEOUT_MS = 5 * 60 * 1000;

    /**
     * Trigger system update via backend
     */
    SettingsUpdate.triggerSystemUpdate = async function() {
        if (this._updateInProgress) return;

        const btn = this.modal.querySelector('#systemUpdateBtn');
        const statusEl = this.modal.querySelector('#updateStatus');
        if (!btn || !statusEl) return;

        // Confirm with project modal
        const confirmed = await window.showConfirm(
            i18n.t('settings.update.confirmMessage') || 'Le système va télécharger la dernière version, mettre à jour les dépendances et redémarrer le serveur.\n\nL\'application sera temporairement indisponible pendant la mise à jour.',
            {
                title: i18n.t('settings.update.confirmTitle') || 'Installer la mise à jour',
                icon: '🔄',
                okText: i18n.t('settings.update.confirmOk') || 'Lancer la mise à jour',
                cancelText: i18n.t('common.cancel') || 'Annuler',
                danger: false
            }
        );

        if (!confirmed) return;

        this._updateInProgress = true;
        this._updateCancelled = false;
        this._reloadTriggered = false;

        // Close the settings modal — update status will show in the confirm modal
        this.close();

        // Take over the confirm modal to show update progress
        this._showUpdateInModal();

        // Also update the settings modal button (for when it's reopened)
        btn.disabled = true;
        btn.innerHTML = '⏳ ' + (i18n.t('settings.update.inProgress') || 'Mise à jour en cours...');
        btn.style.opacity = '0.7';
        statusEl.style.display = 'block';
        statusEl.style.background = '#eef2ff';
        statusEl.style.color = '#667eea';
        statusEl.textContent = i18n.t('settings.update.running') || 'Mise à jour en cours, veuillez patienter...';

        try {
            const api = window.api || window.apiClient;
            if (!api || !api.sendCommand) {
                throw new Error('API not available');
            }
            console.log('[SystemUpdate] Sending system_update command...');
            const result = await api.sendCommand('system_update', {}, 300000);
            console.log('[SystemUpdate] Response received:', JSON.stringify(result));
            if (result && result.success === false) {
                throw new Error(result.error || 'Update failed to start');
            }
            // Backend accepted the update — status polling handles the rest
            console.log('[SystemUpdate] Update command accepted, polling active');
        } catch (error) {
            console.error('[SystemUpdate] Error:', error.message);
            const msg = (error.message || '').toLowerCase();
            // WebSocket disconnect or timeout during update = server is restarting, polling continues
            if (msg.includes('websocket') || msg.includes('connection') || msg.includes('closed') || msg.includes('disconnected') || msg.includes('timeout')) {
                console.log('[SystemUpdate] Connection lost during update — polling continues');
            } else {
                // Real error — stop everything
                console.error('[SystemUpdate] Real error, showing failure UI');
                this._cleanupUpdatePolling();
                this._showUpdateErrorInModal(error.message);
                btn.disabled = false;
                btn.innerHTML = '🔄 ' + (i18n.t('settings.update.button') || 'Installer la mise à jour');
                btn.style.opacity = '1';
                this._updateInProgress = false;
            }
        }
    };

    /**
     * Take over the confirm modal to display update progress
     */
    SettingsUpdate._showUpdateInModal = function() {
        const modal = document.getElementById('confirmModal');
        const icon = document.getElementById('confirmIcon');
        const title = document.getElementById('confirmTitle');
        const messageEl = document.getElementById('confirmMessage');
        const buttons = document.getElementById('confirmButtons');

        if (!modal || !icon || !title || !messageEl || !buttons) return;

        // Show the modal
        modal.classList.add('visible');

        // Block ESC key during update
        this._updateModalEscHandler = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); }
        };
        document.addEventListener('keydown', this._updateModalEscHandler, true);

        // Block overlay click during update
        this._updateModalClickHandler = (e) => {
            if (e.target === modal) { e.preventDefault(); e.stopPropagation(); }
        };
        modal.addEventListener('click', this._updateModalClickHandler, true);

        // Set initial content
        icon.textContent = '🔄';
        title.textContent = i18n.t('settings.update.inProgress') || 'Mise à jour en cours...';
        messageEl.innerHTML = `
            <div style="margin-bottom: 6px; padding: 8px 12px; border-radius: 6px; background: var(--bg-tertiary, #f3f4f6); font-size: 11px; color: var(--text-muted, #999); text-align: center;">
                💡 Ctrl+Shift+R après la mise à jour pour vider le cache navigateur
            </div>
            <div style="margin-bottom: 16px; font-size: 14px; text-align: center;">
                🔄 ${i18n.t('settings.update.running') || 'Démarrage de la mise à jour...'}
            </div>
            <div class="update-progress-bar-container">
                <div class="update-progress-bar" style="width: 5%"></div>
            </div>
            <div style="text-align: center; margin-top: 8px; font-size: 12px; opacity: 0.6;">5%</div>
        `;
        buttons.innerHTML = ''; // No buttons during update

        // Store refs for status updates
        this._updateModalRefs = { modal, icon, title, messageEl, buttons };

        // Start the single polling loop that handles the entire update lifecycle
        this._startUpdatePolling();
    };

    /**
     * Single polling loop that handles the entire update lifecycle:
     * - Shows step progress when server responds
     * - Shows "waiting for restart" when server is down
     * - Triggers reload when "done" is detected
     * - Shows error when "failed" is detected
     * - Times out after 5 minutes
     */
    SettingsUpdate._startUpdatePolling = function() {
        this._cleanupUpdatePolling();

        const startTime = Date.now();
        let serverDownSince = null;
        let restartingSince = null;  // Track when "restarting" was first seen
        let serverWasDown = false;   // Track if we ever lost contact

        const poll = async () => {
            if (!this._updateModalRefs || this._reloadTriggered) return;

            // Global timeout
            if (Date.now() - startTime > UPDATE_TIMEOUT_MS) {
                this._updateInProgress = false;
                this._showUpdateTimeoutInModal();
                return;
            }

            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000);
                const resp = await fetch(window.location.origin + '/api/update-status', {
                    cache: 'no-store',
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                if (resp.ok) {
                    const data = await resp.json();

                    // Server is responding
                    const wasDown = serverDownSince !== null;
                    if (wasDown) serverWasDown = true;
                    serverDownSince = null;

                    if (data.status) {
                        const rawStatus = data.status;
                        let step = rawStatus.split(' ')[0].replace(':', '');

                        if (rawStatus.includes('script_started')) {
                            step = 'script_started';
                        }

                        // Handle failure
                        if (step === 'failed') {
                            const reason = rawStatus.replace(/^failed:\s*/, '');
                            this._showUpdateErrorInModal(reason);
                            this._updateInProgress = false;
                            const btn = this.modal?.querySelector('#systemUpdateBtn');
                            if (btn) {
                                btn.disabled = false;
                                btn.innerHTML = '🔄 ' + (i18n.t('settings.update.button') || 'Installer la mise à jour');
                                btn.style.opacity = '1';
                            }
                            return; // Stop polling
                        }

                        // Handle done — trigger reload
                        if (step === 'done') {
                            console.log('[SystemUpdate] Status polling detected "done" — reloading');
                            this._updateInProgress = false;
                            this._doCacheClearAndReload();
                            return; // Stop polling
                        }

                        // Track "restarting" stuck state:
                        // The update script can be killed by PM2 treekill during server restart,
                        // leaving the status file stuck on "restarting" forever.
                        // If the server is back online and status is still "restarting" for 20s+,
                        // OR if the server was down and came back (restart confirmed), trigger reload.
                        if (step === 'restarting') {
                            if (!restartingSince) restartingSince = Date.now();

                            const stuckDuration = Date.now() - restartingSince;
                            if (serverWasDown || stuckDuration > 20000) {
                                console.log('[SystemUpdate] Status stuck on "restarting" — server is back, triggering reload',
                                    '(serverWasDown:', serverWasDown, 'stuckMs:', stuckDuration, ')');
                                this._updateInProgress = false;
                                this._doCacheClearAndReload();
                                return; // Stop polling
                            }
                        } else {
                            restartingSince = null;
                        }

                        // Show step progress
                        const stepInfo = UPDATE_STEPS[step];
                        if (stepInfo && this._updateModalRefs) {
                            const { icon, messageEl } = this._updateModalRefs;
                            // i18n.t() returns the key itself when translation is missing (truthy string),
                            // so check if the returned value looks like a key path
                            const i18nLabel = i18n.t('settings.update.step.' + step);
                            const label = (i18nLabel && !i18nLabel.includes('.')) ? i18nLabel : stepInfo.label;
                            icon.textContent = stepInfo.icon;
                            messageEl.innerHTML = `
                                <div style="margin-bottom: 16px; font-size: 14px; text-align: center;">
                                    ${stepInfo.icon} ${label}
                                </div>
                                <div class="update-progress-bar-container">
                                    <div class="update-progress-bar" style="width: ${stepInfo.progress}%"></div>
                                </div>
                                <div style="text-align: center; margin-top: 8px; font-size: 12px; opacity: 0.6;">${stepInfo.progress}%</div>
                            `;
                        }
                    }
                }
            } catch (e) {
                // Any fetch error = server is down (network error, timeout, abort)
                if (!serverDownSince) {
                    serverDownSince = Date.now();
                    console.log('[SystemUpdate] Server unreachable — waiting for restart');
                }

                // Show "waiting for restart" with elapsed time
                if (this._updateModalRefs) {
                    const elapsedSec = Math.round((Date.now() - serverDownSince) / 1000);
                    const mins = Math.floor(elapsedSec / 60);
                    const secs = elapsedSec % 60;
                    const timeStr = mins > 0 ? `${mins}m${secs.toString().padStart(2, '0')}s` : `${elapsedSec}s`;

                    const { icon, messageEl } = this._updateModalRefs;
                    icon.textContent = '🔄';
                    messageEl.innerHTML = `
                        <div style="margin-bottom: 16px; font-size: 14px; text-align: center;">
                            🔄 ${i18n.t('settings.update.waitingRestart') || 'En attente du redémarrage du serveur'}...
                            <span style="opacity: 0.6;">(${timeStr})</span>
                        </div>
                        <div class="update-progress-bar-container">
                            <div class="update-progress-bar update-progress-bar-pulse" style="width: 85%"></div>
                        </div>
                        <div style="text-align: center; margin-top: 8px; font-size: 12px; opacity: 0.6;">85%</div>
                    `;
                }
            }

            // Schedule next poll (recursive setTimeout = no overlap)
            this._updatePollTimer = setTimeout(poll, 2000);
        };

        // Start first poll
        this._updatePollTimer = setTimeout(poll, 1000);
    };

    /**
     * Show timeout state in modal
     */
    SettingsUpdate._showUpdateTimeoutInModal = function() {
        if (!this._updateModalRefs) return;

        const { icon, title, messageEl, buttons } = this._updateModalRefs;
        icon.textContent = '⚠️';
        title.textContent = i18n.t('settings.update.restartTimeout') || 'Le serveur ne répond pas';
        messageEl.innerHTML = `
            <div style="font-size: 14px; text-align: center; color: #a16207;">
                ${i18n.t('settings.update.restartTimeout') || 'Le serveur ne répond pas.'}
            </div>
        `;
        buttons.innerHTML = `
            <button class="btn" id="updateManualReloadBtn" style="flex:1;">🔄 ${i18n.t('settings.update.manualReload') || 'Recharger manuellement'}</button>
        `;
        const reloadBtn = document.getElementById('updateManualReloadBtn');
        if (reloadBtn) {
            reloadBtn.addEventListener('click', () => window.location.reload());
        }
        this._removeUpdateModalBlockers();
    };

    /**
     * Show success in modal, clear caches, and reload the page
     */
    SettingsUpdate._doCacheClearAndReload = function() {
        if (this._reloadTriggered) return;
        this._reloadTriggered = true;

        this._cleanupUpdatePolling();

        if (this._updateModalRefs) {
            const { icon, title, messageEl } = this._updateModalRefs;
            icon.textContent = '✅';
            title.textContent = i18n.t('settings.update.complete') || 'Mise à jour terminée !';
            messageEl.innerHTML = `
                <div style="margin-bottom: 16px; font-size: 14px; text-align: center; color: #16a34a;">
                    ✅ ${i18n.t('settings.update.reloading') || 'Serveur redémarré ! Rechargement...'}
                </div>
                <div class="update-progress-bar-container">
                    <div class="update-progress-bar" style="width: 100%"></div>
                </div>
                <div style="text-align: center; margin-top: 8px; font-size: 12px; opacity: 0.6;">100%</div>
            `;
        }

        try { localStorage.setItem('midimind_update_completed', Date.now()); } catch(e) {}

        setTimeout(async () => {
            try {
                if ('caches' in window) {
                    const keys = await caches.keys();
                    await Promise.all(keys.map(k => caches.delete(k)));
                }
            } catch (e) {
                console.warn('[SystemUpdate] Cache clear failed:', e);
            }
            window.location.href = window.location.pathname + '?_updated=' + Date.now();
        }, 1000);
    };

    /**
     * Show error state in the confirm modal
     */
    SettingsUpdate._showUpdateErrorInModal = function(errorMessage) {
        if (!this._updateModalRefs) return;

        const { icon, title, messageEl, buttons } = this._updateModalRefs;
        icon.textContent = '❌';
        title.textContent = i18n.t('settings.update.failed') || 'Échec de la mise à jour';
        messageEl.innerHTML = `
            <div style="font-size: 14px; text-align: center; color: #dc2626;">
                ${(i18n.t('settings.update.failed') || 'Échec de la mise à jour')}: ${errorMessage}
            </div>
        `;
        buttons.innerHTML = `
            <button class="btn" id="updateErrorCloseBtn" style="flex:1;">${i18n.t('common.close') || 'Fermer'}</button>
        `;
        const closeBtn = document.getElementById('updateErrorCloseBtn');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this._cleanupUpdateModal());
        }
        this._removeUpdateModalBlockers();
    };

    /**
     * Remove ESC and overlay click blockers from the confirm modal
     */
    SettingsUpdate._removeUpdateModalBlockers = function() {
        if (this._updateModalEscHandler) {
            document.removeEventListener('keydown', this._updateModalEscHandler, true);
            this._updateModalEscHandler = null;
        }
        if (this._updateModalClickHandler && this._updateModalRefs) {
            this._updateModalRefs.modal.removeEventListener('click', this._updateModalClickHandler, true);
            this._updateModalClickHandler = null;
        }
    };

    /**
     * Clean up the confirm modal and restore it to its default state
     */
    SettingsUpdate._cleanupUpdateModal = function() {
        this._removeUpdateModalBlockers();
        if (this._updateModalRefs) {
            this._updateModalRefs.modal.classList.remove('visible');
            this._updateModalRefs = null;
        }
    };

    /**
     * Check for available updates
     */
    SettingsUpdate.checkForUpdates = async function() {
        if (this._updateInProgress) return;

        const statusEl = this.modal.querySelector('#versionStatus');
        if (!statusEl) return;

        statusEl.style.background = '#f3f4f6';
        statusEl.style.color = '#666';
        statusEl.innerHTML = `<span style="animation: pulse 1.5s infinite;">⏳</span><span>${i18n.t('settings.update.checking') || 'Vérification des mises à jour...'}</span>`;

        try {
            const api = window.api || window.apiClient;
            if (!api || !api.sendCommand) {
                this.logger?.error('checkForUpdates: API not available', { api: !!api, sendCommand: !!(api && api.sendCommand) });
                statusEl.style.background = '#fefce8';
                statusEl.style.color = '#a16207';
                statusEl.innerHTML = `<span>⚠️</span><span>${i18n.t('settings.update.checkFailed') || 'Impossible de vérifier les mises à jour'} (API non disponible)</span>`;
                return;
            }

            const result = await api.sendCommand('system_check_update', {}, 20000);

            if (result.error) {
                this.logger?.error('checkForUpdates: backend error', result.error);
                statusEl.style.background = '#fefce8';
                statusEl.style.color = '#a16207';
                statusEl.innerHTML = `<span>⚠️</span><span>${i18n.t('settings.update.checkFailed') || 'Impossible de vérifier les mises à jour'} (${result.error})</span>`;
                return;
            }

            if (result.upToDate) {
                statusEl.style.background = '#f0fdf4';
                statusEl.style.color = '#16a34a';
                statusEl.innerHTML = `<span>✅</span><span><strong>${i18n.t('settings.update.upToDate') || 'Le système est à jour'}</strong> — v${result.version} (${result.localHash})</span>`;
            } else {
                const count = result.behindCount || 0;
                const plural = count > 1 ? 's' : '';
                statusEl.style.background = '#fef3c7';
                statusEl.style.color = '#92400e';
                statusEl.innerHTML = `<span>🔶</span><span><strong>${i18n.t('settings.update.updateAvailable') || 'Mise à jour disponible'}</strong> — ${count} commit${plural} en retard (${result.localHash} → ${result.remoteHash})</span>`;
            }
        } catch (error) {
            this.logger?.error('checkForUpdates: exception', error.message);
            statusEl.style.background = '#fefce8';
            statusEl.style.color = '#a16207';
            statusEl.innerHTML = `<span>⚠️</span><span>${i18n.t('settings.update.checkFailed') || 'Impossible de vérifier les mises à jour'} (${error.message})</span>`;
        }
    };

    /**
     * Stop update polling
     */
    SettingsUpdate._cleanupUpdatePolling = function() {
        if (this._updatePollTimer) {
            clearTimeout(this._updatePollTimer);
            this._updatePollTimer = null;
        }
    };

    if (typeof window !== 'undefined') window.SettingsUpdate = SettingsUpdate;
})();
