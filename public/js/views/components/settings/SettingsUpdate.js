(function() {
    'use strict';
    const SettingsUpdate = {};

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

        // Capture current server uptime before update (used to detect restart)
        try {
            const healthResp = await fetch(window.location.origin + '/api/health', { cache: 'no-store' });
            if (healthResp.ok) {
                const healthData = await healthResp.json();
                this._serverUptime = healthData.uptime || Infinity;
            }
        } catch (e) { this._serverUptime = Infinity; }

        // Show progress
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
            const result = await api.sendCommand('system_update', {}, 300000);
            if (result && result.success === false) {
                throw new Error(result.error || 'Update failed to start');
            }
            this._showUpdateSuccess(statusEl);
        } catch (error) {
            // WebSocket disconnect or timeout during update means the server is restarting = success
            const msg = (error.message || '').toLowerCase();
            if (msg.includes('websocket') || msg.includes('connection') || msg.includes('closed') || msg.includes('disconnected') || msg.includes('timeout')) {
                this._showUpdateSuccess(statusEl);
            } else {
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
     * Show update success and wait for server restart
     */
    SettingsUpdate._showUpdateSuccess = function(statusEl) {
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

                        // Detect restart: either server was seen down, or uptime reset
                        const uptimeReset = typeof newUptime === 'number' && newUptime < preUpdateUptime;
                        if (!serverWasDown && !uptimeReset) {
                            // Server hasn't gone down yet and uptime hasn't reset, keep waiting
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
