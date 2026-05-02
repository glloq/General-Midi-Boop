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

    // ─────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────

    SettingsUpdate._getUpdateBtn = function() {
        const btnId = (this._updateType === 'beta') ? '#betaUpdateBtn' : '#stableUpdateBtn';
        return this.modal?.querySelector(btnId);
    };

    SettingsUpdate._getUpdateBtnLabel = function() {
        if (this._updateType === 'beta') {
            return '🧪 ' + (i18n.t('settings.update.betaButton') || 'Installer bêta');
        }
        return '📦 ' + (i18n.t('settings.update.stableButton') || 'Installer stable');
    };

    // ─────────────────────────────────────────────────────────────────
    // Trigger update
    // ─────────────────────────────────────────────────────────────────

    /**
     * Trigger system update via backend.
     * @param {'stable'|'beta'} type
     */
    SettingsUpdate.triggerSystemUpdate = async function(type) {
        if (this._updateInProgress) return;

        this._updateType = type || 'stable';

        const btn = this._getUpdateBtn();
        const statusEl = this.modal.querySelector('#updateStatus');
        if (!btn || !statusEl) return;

        const confirmTitle = this._updateType === 'beta'
            ? (i18n.t('settings.update.confirmTitleBeta') || 'Installer la version bêta')
            : (i18n.t('settings.update.confirmTitle') || 'Installer la mise à jour stable');

        const confirmed = await window.showConfirm(
            i18n.t('settings.update.confirmMessage') || 'Le système va télécharger la dernière version, mettre à jour les dépendances et redémarrer le serveur.\n\nL\'application sera temporairement indisponible pendant la mise à jour.',
            {
                title: confirmTitle,
                icon: this._updateType === 'beta' ? '🧪' : '🔄',
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

        // Also update the button (for when the modal is reopened)
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
            console.log(`[SystemUpdate] Sending system_update command (type: ${this._updateType})...`);
            const result = await api.sendCommand('system_update', { type: this._updateType }, 300000);
            console.log('[SystemUpdate] Response received:', JSON.stringify(result));
            if (result && result.success === false) {
                throw new Error(result.error || 'Update failed to start');
            }
            console.log('[SystemUpdate] Update command accepted, polling active');
        } catch (error) {
            console.error('[SystemUpdate] Error:', error.message);
            const msg = (error.message || '').toLowerCase();
            if (msg.includes('websocket') || msg.includes('connection') || msg.includes('closed') || msg.includes('disconnected') || msg.includes('timeout')) {
                console.log('[SystemUpdate] Connection lost during update — polling continues');
            } else {
                console.error('[SystemUpdate] Real error, showing failure UI');
                this._cleanupUpdatePolling();
                this._showUpdateErrorInModal(error.message);
                const b = this._getUpdateBtn();
                if (b) {
                    b.disabled = false;
                    b.innerHTML = this._getUpdateBtnLabel();
                    b.style.opacity = '1';
                }
                this._updateInProgress = false;
            }
        }
    };

    // ─────────────────────────────────────────────────────────────────
    // Progress modal
    // ─────────────────────────────────────────────────────────────────

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

        modal.classList.add('visible');

        this._updateModalEscHandler = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); }
        };
        document.addEventListener('keydown', this._updateModalEscHandler, true);

        this._updateModalClickHandler = (e) => {
            if (e.target === modal) { e.preventDefault(); e.stopPropagation(); }
        };
        modal.addEventListener('click', this._updateModalClickHandler, true);

        icon.textContent = this._updateType === 'beta' ? '🧪' : '🔄';
        title.textContent = i18n.t('settings.update.inProgress') || 'Mise à jour en cours...';

        const modalInner = modal.querySelector('.confirm-modal');
        let tipBanner = modal.querySelector('#updateCacheTip');
        if (!tipBanner && modalInner) {
            tipBanner = document.createElement('div');
            tipBanner.id = 'updateCacheTip';
            tipBanner.style.cssText = 'margin: -20px -20px 16px -20px; padding: 14px 20px; background: #fef3c7; color: #92400e; border-radius: 12px 12px 0 0; font-size: 13px; text-align: center; line-height: 1.5;';
            tipBanner.innerHTML = '<span style="font-size: 22px; display: block; margin-bottom: 4px;">⚠️</span>Pensez à vider le cache du navigateur après la mise à jour<br><span style="font-size: 12px; opacity: 0.8;">(Ctrl+Shift+R ou paramètres du navigateur)</span>';
            modalInner.insertBefore(tipBanner, modalInner.firstChild);
        }

        messageEl.innerHTML = `
            <div style="margin-bottom: 16px; font-size: 14px; text-align: center;">
                🔄 ${i18n.t('settings.update.running') || 'Démarrage de la mise à jour...'}
            </div>
            <div class="update-progress-bar-container">
                <div class="update-progress-bar" style="width: 5%"></div>
            </div>
            <div style="text-align: center; margin-top: 8px; font-size: 12px; opacity: 0.6;">5%</div>
        `;
        buttons.innerHTML = '';

        this._updateModalRefs = { modal, icon, title, messageEl, buttons };

        this._startUpdatePolling();
    };

    // ─────────────────────────────────────────────────────────────────
    // Polling loop
    // ─────────────────────────────────────────────────────────────────

    /**
     * Single polling loop handling the entire update lifecycle.
     */
    SettingsUpdate._startUpdatePolling = function() {
        this._cleanupUpdatePolling();

        const startTime = Date.now();
        let serverDownSince = null;
        let restartingSince = null;
        let serverWasDown = false;

        const poll = async () => {
            if (!this._updateModalRefs || this._reloadTriggered) return;

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

                    const wasDown = serverDownSince !== null;
                    if (wasDown) serverWasDown = true;
                    serverDownSince = null;

                    if (data.status) {
                        const rawStatus = data.status;
                        let step = rawStatus.split(' ')[0].replace(':', '');

                        if (rawStatus.includes('script_started')) {
                            step = 'script_started';
                        }

                        if (step === 'failed') {
                            const reason = rawStatus.replace(/^failed:\s*/, '');
                            this._showUpdateErrorInModal(reason);
                            this._updateInProgress = false;
                            const b = this._getUpdateBtn();
                            if (b) {
                                b.disabled = false;
                                b.innerHTML = this._getUpdateBtnLabel();
                                b.style.opacity = '1';
                            }
                            return;
                        }

                        if (step === 'done') {
                            console.log('[SystemUpdate] Status polling detected "done" — reloading');
                            this._updateInProgress = false;
                            this._doCacheClearAndReload();
                            return;
                        }

                        if (step === 'restarting') {
                            if (!restartingSince) restartingSince = Date.now();
                            const stuckDuration = Date.now() - restartingSince;
                            if (serverWasDown || stuckDuration > 20000) {
                                console.log('[SystemUpdate] Status stuck on "restarting" — server is back, triggering reload',
                                    '(serverWasDown:', serverWasDown, 'stuckMs:', stuckDuration, ')');
                                this._updateInProgress = false;
                                this._doCacheClearAndReload();
                                return;
                            }
                        } else {
                            restartingSince = null;
                        }

                        const stepInfo = UPDATE_STEPS[step];
                        if (stepInfo && this._updateModalRefs) {
                            const { messageEl } = this._updateModalRefs;
                            const i18nLabel = i18n.t('settings.update.step.' + step);
                            const label = (i18nLabel && !i18nLabel.includes('.')) ? i18nLabel : stepInfo.label;
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
                if (!serverDownSince) {
                    serverDownSince = Date.now();
                    console.log('[SystemUpdate] Server unreachable — waiting for restart');
                }

                if (this._updateModalRefs) {
                    const elapsedSec = Math.round((Date.now() - serverDownSince) / 1000);
                    const mins = Math.floor(elapsedSec / 60);
                    const secs = elapsedSec % 60;
                    const timeStr = mins > 0 ? `${mins}m${secs.toString().padStart(2, '0')}s` : `${elapsedSec}s`;

                    const { messageEl } = this._updateModalRefs;
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

            this._updatePollTimer = setTimeout(poll, 2000);
        };

        this._updatePollTimer = setTimeout(poll, 1000);
    };

    // ─────────────────────────────────────────────────────────────────
    // Modal states
    // ─────────────────────────────────────────────────────────────────

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

        try { localStorage.setItem('gmboop_update_completed', Date.now()); } catch(e) {}

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

    SettingsUpdate._showUpdateErrorInModal = function(errorMessage) {
        if (!this._updateModalRefs) return;
        const { icon, title, messageEl, buttons } = this._updateModalRefs;
        icon.textContent = '❌';
        title.textContent = i18n.t('settings.update.failed') || 'Échec de la mise à jour';
        messageEl.innerHTML = `
            <div style="font-size: 14px; text-align: center; color: #dc2626;">
                ${(i18n.t('settings.update.failed') || 'Échec de la mise à jour')}: ${escapeHtml(errorMessage)}
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

    SettingsUpdate._cleanupUpdateModal = function() {
        this._removeUpdateModalBlockers();
        const tip = document.getElementById('updateCacheTip');
        if (tip) tip.remove();
        if (this._updateModalRefs) {
            this._updateModalRefs.modal.classList.remove('visible');
            this._updateModalRefs = null;
        }
    };

    // ─────────────────────────────────────────────────────────────────
    // Check for updates
    // ─────────────────────────────────────────────────────────────────

    /**
     * Query the backend for stable + beta update status and populate both
     * channel panels in the settings modal.
     */
    SettingsUpdate.checkForUpdates = async function() {
        if (this._updateInProgress) return;

        const stableStatusEl = this.modal.querySelector('#stableVersionStatus');
        if (!stableStatusEl) return;
        const betaStatusEl = this.modal.querySelector('#betaVersionStatus');

        const loadingHtml = `<span style="animation: pulse 1.5s infinite;">⏳</span><span>${i18n.t('settings.update.checking') || 'Vérification...'}</span>`;
        stableStatusEl.style.cssText = 'padding: 8px 12px; border-radius: 6px; background: var(--bg-tertiary, #f3f4f6); color: var(--text-secondary, #666); font-size: 12px; display: flex; align-items: center; gap: 8px;';
        stableStatusEl.innerHTML = loadingHtml;
        if (betaStatusEl) {
            betaStatusEl.style.cssText = 'padding: 8px 12px; border-radius: 6px; background: var(--bg-tertiary, #f3f4f6); color: var(--text-secondary, #666); font-size: 12px; display: flex; align-items: center; gap: 8px;';
            betaStatusEl.innerHTML = loadingHtml;
        }

        try {
            const api = window.api || window.apiClient;
            if (!api || !api.sendCommand) {
                const errHtml = `<span>⚠️</span><span>${i18n.t('settings.update.checkFailed') || 'Impossible de vérifier'} (API non disponible)</span>`;
                stableStatusEl.style.background = '#fefce8';
                stableStatusEl.style.color = '#a16207';
                stableStatusEl.innerHTML = errHtml;
                if (betaStatusEl) { betaStatusEl.style.background = '#fefce8'; betaStatusEl.style.color = '#a16207'; betaStatusEl.innerHTML = errHtml; }
                return;
            }

            const result = await api.sendCommand('system_check_update', {}, 20000);

            if (result.error) {
                const errHtml = `<span>⚠️</span><span>${i18n.t('settings.update.checkFailed') || 'Impossible de vérifier'} (${escapeHtml(result.error)})</span>`;
                stableStatusEl.style.background = '#fefce8'; stableStatusEl.style.color = '#a16207';
                stableStatusEl.innerHTML = errHtml;
                if (betaStatusEl) { betaStatusEl.style.background = '#fefce8'; betaStatusEl.style.color = '#a16207'; betaStatusEl.innerHTML = errHtml; }
                return;
            }

            // ── Stable channel ──
            const stable = result.stable || {
                upToDate: result.upToDate,
                behindCount: result.behindCount || 0,
                remoteHash: result.remoteHash,
                versionChanged: false,
                remoteVersion: null
            };
            const stableChannel = this.modal.querySelector('#stableUpdateChannel');
            const stableBtn = this.modal.querySelector('#stableUpdateBtn');

            if (stable.upToDate) {
                stableStatusEl.style.background = '#f0fdf4'; stableStatusEl.style.color = '#16a34a';
                stableStatusEl.innerHTML = `<span>✅</span><span><strong>${i18n.t('settings.update.upToDate') || 'À jour'}</strong> — v${escapeHtml(result.version)} (${escapeHtml(stable.remoteHash || result.localHash)})</span>`;
                if (stableBtn) stableBtn.disabled = true;
            } else if (stable.versionChanged) {
                // New version number — highlight prominently
                stableStatusEl.style.background = '#dcfce7'; stableStatusEl.style.color = '#15803d';
                stableStatusEl.innerHTML = `<span>🆕</span><span><strong>${i18n.t('settings.update.newVersion') || 'Nouvelle version'} : v${escapeHtml(stable.remoteVersion)}</strong> — ${i18n.t('settings.update.currentVersion') || 'actuellement'} v${escapeHtml(result.version)}</span>`;
                if (stableChannel) {
                    stableChannel.style.borderColor = '#16a34a';
                    stableChannel.style.boxShadow = '0 0 0 3px rgba(22, 163, 74, 0.15)';
                }
                if (stableBtn) {
                    stableBtn.style.background = 'linear-gradient(135deg, #16a34a 0%, #15803d 100%)';
                    stableBtn.style.boxShadow = '0 2px 12px rgba(22, 163, 74, 0.4)';
                    stableBtn.innerHTML = `🆕 v${escapeHtml(stable.remoteVersion)}`;
                }
            } else {
                const count = stable.behindCount || 0;
                const plural = count > 1 ? 's' : '';
                stableStatusEl.style.background = '#fef3c7'; stableStatusEl.style.color = '#92400e';
                stableStatusEl.innerHTML = `<span>🔶</span><span><strong>${i18n.t('settings.update.updateAvailable') || 'Mise à jour disponible'}</strong> — ${count} commit${plural} (${escapeHtml(result.localHash)} → ${escapeHtml(stable.remoteHash)})</span>`;
            }

            // ── Beta channel ──
            const betaChannel = this.modal.querySelector('#betaUpdateChannel');
            if (!result.beta) {
                // Not on a beta branch — hide the canal entirely
                if (betaChannel) betaChannel.style.display = 'none';
            } else {
                const beta = result.beta;
                if (betaStatusEl) {
                    if (beta.upToDate) {
                        betaStatusEl.style.background = '#f0fdf4'; betaStatusEl.style.color = '#16a34a';
                        betaStatusEl.innerHTML = `<span>✅</span><span>${i18n.t('settings.update.upToDate') || 'À jour'} (${escapeHtml(beta.remoteHash)})</span>`;
                        const betaBtn = this.modal.querySelector('#betaUpdateBtn');
                        if (betaBtn) betaBtn.disabled = true;
                    } else {
                        const count = beta.behindCount || 0;
                        const plural = count > 1 ? 's' : '';
                        betaStatusEl.style.background = '#fef3c7'; betaStatusEl.style.color = '#92400e';
                        betaStatusEl.innerHTML = `<span>🔶</span><span><strong>${count} commit${plural}</strong> bêta disponibles (→ ${escapeHtml(beta.remoteHash)})</span>`;
                    }
                }
            }

        } catch (error) {
            this.logger?.error('checkForUpdates: exception', error.message);
            const errHtml = `<span>⚠️</span><span>${i18n.t('settings.update.checkFailed') || 'Impossible de vérifier'} (${escapeHtml(error.message)})</span>`;
            stableStatusEl.style.background = '#fefce8'; stableStatusEl.style.color = '#a16207';
            stableStatusEl.innerHTML = errHtml;
            if (betaStatusEl) { betaStatusEl.style.background = '#fefce8'; betaStatusEl.style.color = '#a16207'; betaStatusEl.innerHTML = errHtml; }
        }
    };

    // ─────────────────────────────────────────────────────────────────
    // Cleanup
    // ─────────────────────────────────────────────────────────────────

    SettingsUpdate._cleanupUpdatePolling = function() {
        if (this._updatePollTimer) {
            clearTimeout(this._updatePollTimer);
            this._updatePollTimer = null;
        }
    };

    if (typeof window !== 'undefined') window.SettingsUpdate = SettingsUpdate;
})();
