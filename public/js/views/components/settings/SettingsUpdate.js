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

        // Show progress
        btn.disabled = true;
        btn.innerHTML = '⏳ ' + (i18n.t('settings.update.inProgress') || 'Mise à jour en cours...');
        btn.style.opacity = '0.7';
        statusEl.style.display = 'block';
        statusEl.style.background = '#eef2ff';
        statusEl.style.color = '#667eea';
        statusEl.textContent = i18n.t('settings.update.running') || 'Mise à jour en cours, veuillez patienter...';

        // Start polling update status for real-time progress
        this._pollUpdateStatus(statusEl);

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
            this._showUpdateSuccess(statusEl);
        } catch (error) {
            console.error('[SystemUpdate] Error:', error.message);
            // WebSocket disconnect or timeout during update means the server is restarting = success
            const msg = (error.message || '').toLowerCase();
            if (msg.includes('websocket') || msg.includes('connection') || msg.includes('closed') || msg.includes('disconnected') || msg.includes('timeout')) {
                console.log('[SystemUpdate] Connection lost during update — treating as server restart');
                this._showUpdateSuccess(statusEl);
            } else {
                console.error('[SystemUpdate] Real error, showing failure UI');
                this._cleanupUpdatePolling();
                statusEl.style.background = '#fef2f2';
                statusEl.style.color = '#dc2626';
                statusEl.textContent = (i18n.t('settings.update.failed') || 'Échec de la mise à jour') + ': ' + error.message;
                btn.disabled = false;
                btn.innerHTML = '🔄 ' + (i18n.t('settings.update.button') || 'Installer la mise à jour');
                btn.style.opacity = '1';
                this._updateInProgress = false;
            }
        }
    };

    /**
     * Check for available updates
     */
    SettingsUpdate.checkForUpdates = async function() {
        // If an update is in progress, resume showing status instead of checking
        if (this._updateInProgress) {
            const statusEl = this.modal.querySelector('#updateStatus');
            if (statusEl) {
                statusEl.style.display = 'block';
                this._updateCancelled = false;
                this._pollUpdateStatus(statusEl);
            }
            return;
        }

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
     * Poll /api/update-status for real-time progress feedback
     */
    SettingsUpdate._pollUpdateStatus = function(statusEl) {
        // Clean any previous polling
        this._cleanupUpdatePolling();

        this._updateAbortController = new AbortController();
        const signal = this._updateAbortController.signal;

        this._updateStatusInterval = setInterval(async () => {
            if (signal.aborted) return;
            try {
                const resp = await fetch(window.location.origin + '/api/update-status', {
                    cache: 'no-store',
                    signal
                });
                if (!resp.ok) return;
                const data = await resp.json();
                if (!data.status) return;

                // Parse status: may be "pulling", "failed: some message", or "2024-... script_started pid=123"
                const rawStatus = data.status;
                let step = rawStatus.split(' ')[0].replace(':', '');

                // Handle timestamp prefix in script_started line
                if (rawStatus.includes('script_started')) {
                    step = 'script_started';
                }

                if (step === 'failed') {
                    const reason = rawStatus.replace(/^failed:\s*/, '');
                    statusEl.style.background = '#fef2f2';
                    statusEl.style.color = '#dc2626';
                    statusEl.innerHTML = '❌ ' + (i18n.t('settings.update.failed') || 'Échec') + ': ' + reason;
                    this._cleanupUpdatePolling();
                    this._updateInProgress = false;
                    const btn = this.modal.querySelector('#systemUpdateBtn');
                    if (btn) {
                        btn.disabled = false;
                        btn.innerHTML = '🔄 ' + (i18n.t('settings.update.button') || 'Installer la mise à jour');
                        btn.style.opacity = '1';
                    }
                    return;
                }

                const stepInfo = UPDATE_STEPS[step];
                if (stepInfo) {
                    const label = i18n.t('settings.update.step.' + step) || stepInfo.label;
                    statusEl.style.background = '#eef2ff';
                    statusEl.style.color = '#667eea';
                    statusEl.innerHTML = `${stepInfo.icon} ${label} <span style="opacity:0.5">(${stepInfo.progress}%)</span>`;
                }
            } catch (e) {
                // Server down during update is expected — don't clear interval
                if (e.name === 'AbortError') return;
            }
        }, 2000);
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

    /**
     * Show update success and wait for server restart
     */
    SettingsUpdate._showUpdateSuccess = function(statusEl) {
        console.log('[SystemUpdate] Waiting for server restart (preUpdateUptime:', this._serverUptime, ')');

        // Stop status polling — we switch to health polling now
        this._cleanupUpdatePolling();

        statusEl.style.background = '#eef2ff';
        statusEl.style.color = '#667eea';
        statusEl.textContent = i18n.t('settings.update.waitingRestart') || 'En attente du redémarrage du serveur...';

        // Mark update in progress for post-reload notification
        try { localStorage.setItem('midimind_update_completed', Date.now()); } catch(e) {}

        // Capture current server uptime to detect a real restart (uptime resets to ~0)
        const preUpdateUptime = this._serverUptime || Infinity;

        // Wait for server to come back online, then reload
        const waitForServer = async () => {
            const maxAttempts = 120;
            let serverWasDown = false;
            let downSinceIteration = -1;

            for (let i = 0; i < maxAttempts; i++) {
                // Check if polling was cancelled (modal closed)
                if (this._updateCancelled) {
                    console.log('[SystemUpdate] Health polling cancelled');
                    return;
                }

                const elapsedSec = (i + 1) * 3;
                const mins = Math.floor(elapsedSec / 60);
                const secs = elapsedSec % 60;
                const timeStr = mins > 0 ? `${mins}m${secs.toString().padStart(2, '0')}s` : `${elapsedSec}s`;
                statusEl.innerHTML = `⏳ ${i18n.t('settings.update.waitingRestart') || 'En attente du redémarrage du serveur'}... <span style="opacity:0.7">(${timeStr})</span>`;

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
                        const newUptime = data && data.uptime;

                        // Detect restart: server was seen down, uptime reset, or git hash changed
                        const uptimeReset = typeof newUptime === 'number' && newUptime < preUpdateUptime;
                        const hashChanged = this._preUpdateGitHash && data.gitHash && data.gitHash !== this._preUpdateGitHash;
                        if (!serverWasDown && !uptimeReset && !hashChanged) {
                            // Server hasn't gone down yet and no code change detected, keep waiting
                            continue;
                        }
                        this._updateInProgress = false;
                        statusEl.style.background = '#f0fdf4';
                        statusEl.style.color = '#16a34a';
                        statusEl.innerHTML = '✅ ' + (i18n.t('settings.update.reloading') || 'Serveur redémarré ! Rechargement...');
                        // Force cache-busting reload
                        setTimeout(() => {
                            window.location.href = window.location.pathname + '?_updated=' + Date.now();
                        }, 1000);
                        return;
                    }
                } catch (e) {
                    // Server is down - this is expected during update
                    if (!serverWasDown) downSinceIteration = i;
                    serverWasDown = true;
                }
            }

            statusEl.style.background = '#fefce8';
            statusEl.style.color = '#a16207';
            statusEl.innerHTML = (i18n.t('settings.update.restartTimeout') || 'Le serveur ne répond pas.') +
                ' <a href="#" onclick="window.location.reload();return false;" style="color:#667eea;text-decoration:underline;font-weight:600;">Recharger manuellement</a>';
            this._updateInProgress = false;
        };

        // Start polling quickly — the update script waits 3s before killing,
        // but we want to catch the server going down as early as possible
        setTimeout(waitForServer, 2000);
    };

    if (typeof window !== 'undefined') window.SettingsUpdate = SettingsUpdate;
})();
