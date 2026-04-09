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

        // Capture current server uptime before update (used to detect restart)
        try {
            const healthResp = await fetch(window.location.origin + '/api/health', { cache: 'no-store' });
            if (healthResp.ok) {
                const healthData = await healthResp.json();
                this._serverUptime = healthData.uptime || Infinity;
                this._preUpdateGitHash = healthData.gitHash || null;
            }
        } catch (e) { this._serverUptime = Infinity; this._preUpdateGitHash = null; }

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
            this._showUpdateSuccessInModal();
        } catch (error) {
            console.error('[SystemUpdate] Error:', error.message);
            // WebSocket disconnect or timeout during update means the server is restarting = success
            const msg = (error.message || '').toLowerCase();
            if (msg.includes('websocket') || msg.includes('connection') || msg.includes('closed') || msg.includes('disconnected') || msg.includes('timeout')) {
                console.log('[SystemUpdate] Connection lost during update — treating as server restart');
                this._showUpdateSuccessInModal();
            } else {
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

        // Start polling update status
        this._pollUpdateStatusInModal();
    };

    /**
     * Poll /api/update-status and update the confirm modal in real-time
     */
    SettingsUpdate._pollUpdateStatusInModal = function() {
        this._cleanupUpdatePolling();

        this._updateAbortController = new AbortController();
        const signal = this._updateAbortController.signal;

        this._updateStatusInterval = setInterval(async () => {
            if (signal.aborted || !this._updateModalRefs) return;
            try {
                const resp = await fetch(window.location.origin + '/api/update-status', {
                    cache: 'no-store',
                    signal
                });
                if (!resp.ok) return;
                const data = await resp.json();
                if (!data.status) return;

                const rawStatus = data.status;
                let step = rawStatus.split(' ')[0].replace(':', '');

                if (rawStatus.includes('script_started')) {
                    step = 'script_started';
                }

                if (step === 'failed') {
                    const reason = rawStatus.replace(/^failed:\s*/, '');
                    this._cleanupUpdatePolling();
                    this._showUpdateErrorInModal(reason);
                    this._updateInProgress = false;
                    const btn = this.modal?.querySelector('#systemUpdateBtn');
                    if (btn) {
                        btn.disabled = false;
                        btn.innerHTML = '🔄 ' + (i18n.t('settings.update.button') || 'Installer la mise à jour');
                        btn.style.opacity = '1';
                    }
                    return;
                }

                const stepInfo = UPDATE_STEPS[step];
                if (stepInfo && this._updateModalRefs) {
                    const { icon, messageEl } = this._updateModalRefs;
                    const label = i18n.t('settings.update.step.' + step) || stepInfo.label;
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

                    // 'done' means the update script finished and verified the server is running
                    // → trigger cache clear + reload immediately
                    if (step === 'done') {
                        console.log('[SystemUpdate] Status polling detected "done" — reloading');
                        this._cleanupUpdatePolling();
                        this._updateInProgress = false;
                        try { localStorage.setItem('midimind_update_completed', Date.now()); } catch(e) {}
                        this._doCacheClearAndReload();
                        return;
                    }
                }
            } catch (e) {
                if (e.name === 'AbortError') return;
            }
        }, 2000);
    };

    /**
     * Show update success in the confirm modal and wait for server restart
     */
    SettingsUpdate._showUpdateSuccessInModal = function() {
        console.log('[SystemUpdate] Waiting for server restart (preUpdateUptime:', this._serverUptime, ')');

        this._cleanupUpdatePolling();

        if (this._updateModalRefs) {
            const { icon, title, messageEl } = this._updateModalRefs;
            icon.textContent = '⏳';
            title.textContent = i18n.t('settings.update.waitingRestart') || 'En attente du redémarrage...';
            messageEl.innerHTML = `
                <div style="margin-bottom: 16px; font-size: 14px; text-align: center;">
                    ⏳ ${i18n.t('settings.update.waitingRestart') || 'En attente du redémarrage du serveur...'}
                </div>
                <div class="update-progress-bar-container">
                    <div class="update-progress-bar" style="width: 85%"></div>
                </div>
                <div style="text-align: center; margin-top: 8px; font-size: 12px; opacity: 0.6;">85%</div>
            `;
        }

        const preUpdateUptime = this._serverUptime || Infinity;

        const waitForServer = async () => {
            const maxAttempts = 120;
            let serverWasDown = false;
            const startTime = Date.now();

            for (let i = 0; i < maxAttempts; i++) {
                if (this._updateCancelled) {
                    console.log('[SystemUpdate] Health polling cancelled');
                    return;
                }

                const elapsedSec = (i + 1) * 3;
                const mins = Math.floor(elapsedSec / 60);
                const secs = elapsedSec % 60;
                const timeStr = mins > 0 ? `${mins}m${secs.toString().padStart(2, '0')}s` : `${elapsedSec}s`;

                if (this._updateModalRefs) {
                    const { messageEl } = this._updateModalRefs;
                    messageEl.innerHTML = `
                        <div style="margin-bottom: 16px; font-size: 14px; text-align: center;">
                            ⏳ ${i18n.t('settings.update.waitingRestart') || 'En attente du redémarrage du serveur'}...
                            <span style="opacity: 0.6;">(${timeStr})</span>
                        </div>
                        <div class="update-progress-bar-container">
                            <div class="update-progress-bar update-progress-bar-pulse" style="width: 85%"></div>
                        </div>
                        <div style="text-align: center; margin-top: 8px; font-size: 12px; opacity: 0.6;">85%</div>
                    `;
                }

                await new Promise(r => setTimeout(r, 3000));
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 5000);
                    const resp = await fetch(window.location.origin + '/api/health', {
                        method: 'GET',
                        cache: 'no-store',
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);

                    if (resp.ok) {
                        const data = await resp.json().catch(() => null);
                        if (!data) continue;

                        const newUptime = data.uptime;
                        const uptimeReset = typeof newUptime === 'number' && newUptime < preUpdateUptime;
                        const hashChanged = this._preUpdateGitHash && data.gitHash && data.gitHash !== this._preUpdateGitHash;

                        // Fallback: if server has been responding for 30s+, just reload
                        // (handles case where restart was too fast to detect going down)
                        const waitedLongEnough = (Date.now() - startTime) > 30000;

                        if (!serverWasDown && !uptimeReset && !hashChanged && !waitedLongEnough) {
                            continue;
                        }

                        console.log('[SystemUpdate] Restart detected — serverWasDown:', serverWasDown,
                            'uptimeReset:', uptimeReset, 'hashChanged:', hashChanged,
                            'waitedLongEnough:', waitedLongEnough);

                        // Server restarted successfully!
                        this._updateInProgress = false;
                        this._doCacheClearAndReload();
                        return;
                    }
                } catch (e) {
                    serverWasDown = true;
                }
            }

            // Timeout — server not responding
            this._updateInProgress = false;
            if (this._updateModalRefs) {
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
                    reloadBtn.addEventListener('click', () => {
                        window.location.reload();
                    });
                }
                // Allow closing modal now
                this._removeUpdateModalBlockers();
            }
        };

        setTimeout(waitForServer, 2000);
    };

    /**
     * Show success in modal, clear caches, and reload the page
     */
    SettingsUpdate._doCacheClearAndReload = function() {
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
            closeBtn.addEventListener('click', () => {
                this._cleanupUpdateModal();
            });
        }
        // Allow closing modal now
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
        // If an update is in progress, don't check — the confirm modal is handling status
        if (this._updateInProgress) return;

        const statusEl = this.modal.querySelector('#versionStatus');
        if (!statusEl) return;

        // Reset to loading state
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
     * Stop all update-related polling (status + health)
     */
    SettingsUpdate._cleanupUpdatePolling = function() {
        if (this._updateAbortController) {
            this._updateAbortController.abort();
            this._updateAbortController = null;
        }
        if (this._updateStatusInterval) {
            clearInterval(this._updateStatusInterval);
            this._updateStatusInterval = null;
        }
    };

    if (typeof window !== 'undefined') window.SettingsUpdate = SettingsUpdate;
})();
