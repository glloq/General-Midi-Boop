(function() {
    'use strict';

    /**
     * SettingsHotspot — mixin for the main SettingsModal that drives the
     * Raspberry Pi WiFi hotspot panel.
     *
     * Wiring (called from SettingsModal.attachContentEventListeners):
     *   - hydrate the form with the current saved config
     *   - load live status (hotspot active or not)
     *   - persist edits (SSID/band/channel/password) on blur/change
     *   - toggle the hotspot on the "Activer/Désactiver" button
     *
     * The password field is left blank when a password is already stored;
     * an empty submit means "keep existing" (the backend uses a sentinel).
     */
    const SettingsHotspot = {};

    const PWD_PLACEHOLDER = '__unchanged__';

    SettingsHotspot._getHotspotApi = function() {
        return window.api || window.apiClient || null;
    };

    /**
     * Initial population of the hotspot form + status read.
     * Safe to call multiple times (idempotent).
     */
    SettingsHotspot.hydrateHotspot = async function() {
        const api = this._getHotspotApi();
        if (!api || !api.sendCommand) return;

        const ssidEl = this.modal.querySelector('#hotspotSsidInput');
        const pwdEl = this.modal.querySelector('#hotspotPasswordInput');
        const bandEl = this.modal.querySelector('#hotspotBandSelect');
        const channelEl = this.modal.querySelector('#hotspotChannelInput');
        if (!ssidEl || !pwdEl || !bandEl || !channelEl) return;

        try {
            const resp = await api.sendCommand('hotspot_get_config', {}, 5000);
            const cfg = (resp && resp.config) || {};
            ssidEl.value = cfg.ssid || '';
            bandEl.value = cfg.band || 'bg';
            channelEl.value = Number.isFinite(cfg.channel) ? cfg.channel : 0;
            // Never echo the password back. If one is stored, mark the
            // field so a blank submit keeps it.
            pwdEl.value = '';
            pwdEl.dataset.hasStored = cfg.hasPassword ? '1' : '0';
            pwdEl.placeholder = cfg.hasPassword
                ? (i18n.t('settings.hotspot.passwordPlaceholder') || 'Laisser vide pour conserver le mot de passe actuel')
                : (i18n.t('settings.hotspot.passwordEmpty') || 'Aucun mot de passe enregistré — saisir un mot de passe (8+ caractères)');
        } catch (err) {
            this.logger?.warn?.('hotspot_get_config failed: ' + (err.message || err));
        }

        await this.refreshHotspotStatus();
    };

    /**
     * Read live nmcli state and update the label + button text.
     */
    SettingsHotspot.refreshHotspotStatus = async function() {
        const api = this._getHotspotApi();
        if (!api || !api.sendCommand) return;

        const labelEl = this.modal.querySelector('#hotspotStatusLabel');
        const btnEl = this.modal.querySelector('#hotspotToggleBtn');
        if (!labelEl || !btnEl) return;

        try {
            const resp = await api.sendCommand('hotspot_status', {}, 8000);
            const active = !!(resp && resp.hotspotActive);
            const wifi = (resp && resp.wifiActive) || '';
            if (active) {
                labelEl.textContent = i18n.t('settings.hotspot.statusActive') || 'État : hotspot actif';
                btnEl.textContent = '🛑 ' + (i18n.t('settings.hotspot.disable') || 'Désactiver le hotspot');
                btnEl.dataset.action = 'disable';
            } else {
                const wifiSuffix = wifi
                    ? ` (${i18n.t('settings.hotspot.wifiConnected') || 'WiFi'} : ${wifi})`
                    : '';
                labelEl.textContent = (i18n.t('settings.hotspot.statusInactive') || 'État : hotspot inactif') + wifiSuffix;
                btnEl.textContent = '📡 ' + (i18n.t('settings.hotspot.enable') || 'Activer le hotspot');
                btnEl.dataset.action = 'enable';
            }
        } catch (err) {
            labelEl.textContent = (i18n.t('settings.hotspot.statusUnavailable') || 'État indisponible') + ': ' + (err.message || err);
            btnEl.dataset.action = 'enable';
        }
    };

    /**
     * Push the current form values to the server. Returns true on success.
     */
    SettingsHotspot._persistHotspotForm = async function() {
        const api = this._getHotspotApi();
        if (!api || !api.sendCommand) return false;

        const ssidEl = this.modal.querySelector('#hotspotSsidInput');
        const pwdEl = this.modal.querySelector('#hotspotPasswordInput');
        const bandEl = this.modal.querySelector('#hotspotBandSelect');
        const channelEl = this.modal.querySelector('#hotspotChannelInput');
        if (!ssidEl || !pwdEl || !bandEl || !channelEl) return false;

        const payload = {
            ssid: (ssidEl.value || '').trim(),
            band: bandEl.value || 'bg',
            channel: parseInt(channelEl.value, 10) || 0
        };

        const newPwd = pwdEl.value || '';
        if (newPwd) {
            payload.password = newPwd;
        } else if (pwdEl.dataset.hasStored !== '1') {
            // No stored password and field empty — nothing to persist for
            // the password (backend will reject enable() with a clear msg).
        } else {
            payload.password = PWD_PLACEHOLDER;
        }

        try {
            await api.sendCommand('hotspot_update_config', payload, 5000);
            // Clear the password field so it isn't accidentally re-sent.
            pwdEl.value = '';
            pwdEl.dataset.hasStored = (newPwd || pwdEl.dataset.hasStored === '1') ? '1' : '0';
            return true;
        } catch (err) {
            this._showHotspotMessage('error', err.message || String(err));
            return false;
        }
    };

    SettingsHotspot._showHotspotMessage = function(kind, text) {
        const el = this.modal.querySelector('#hotspotMessage');
        if (!el) return;
        el.style.display = 'block';
        if (kind === 'error') {
            el.style.background = '#fee2e2';
            el.style.color = '#991b1b';
        } else if (kind === 'warn') {
            el.style.background = '#fef3c7';
            el.style.color = '#92400e';
        } else {
            el.style.background = '#dcfce7';
            el.style.color = '#14532d';
        }
        el.textContent = text;
    };

    SettingsHotspot._hideHotspotMessage = function() {
        const el = this.modal.querySelector('#hotspotMessage');
        if (el) el.style.display = 'none';
    };

    /**
     * Toggle handler — persists the current form first, then asks the
     * backend to flip state. Note: enabling the hotspot will drop the
     * caller's WiFi connection if they were on the same network.
     */
    SettingsHotspot.onHotspotToggle = async function() {
        const api = this._getHotspotApi();
        if (!api || !api.sendCommand) return;

        const btnEl = this.modal.querySelector('#hotspotToggleBtn');
        if (!btnEl) return;

        const action = btnEl.dataset.action || 'enable';
        this._hideHotspotMessage();

        if (action === 'enable') {
            // Persist any pending edits before activating.
            const ok = await this._persistHotspotForm();
            if (!ok) return;
            const confirmed = await window.showConfirm(
                i18n.t('settings.hotspot.confirmEnable') ||
                'Le Raspberry Pi va se déconnecter du WiFi et activer le hotspot. Si vous êtes connecté via WiFi, vous perdrez la connexion à cette interface.',
                {
                    title: i18n.t('settings.hotspot.confirmEnableTitle') || 'Activer le hotspot',
                    icon: '📡',
                    okText: i18n.t('settings.hotspot.confirmEnableOk') || 'Activer',
                    cancelText: i18n.t('common.cancel') || 'Annuler',
                    danger: true
                }
            );
            if (!confirmed) return;
        }

        const previousLabel = btnEl.textContent;
        btnEl.disabled = true;
        btnEl.textContent = '⏳ ' + (i18n.t('common.pleaseWait') || 'Veuillez patienter...');

        try {
            if (action === 'enable') {
                await api.sendCommand('hotspot_enable', {}, 30000);
                this._showHotspotMessage('ok',
                    i18n.t('settings.hotspot.enabledOk') ||
                    'Hotspot activé. Reconnectez-vous au nouveau réseau WiFi pour continuer.');
            } else {
                await api.sendCommand('hotspot_disable', {}, 30000);
                this._showHotspotMessage('ok',
                    i18n.t('settings.hotspot.disabledOk') || 'Hotspot désactivé, WiFi en cours de reconnexion.');
            }
        } catch (err) {
            const msg = err && (err.message || String(err)) || 'unknown error';
            // Connection lost during enable is expected when controlling via WiFi.
            const isExpectedDrop = action === 'enable' &&
                /websocket|connection|closed|disconnected|timeout/i.test(msg);
            if (isExpectedDrop) {
                this._showHotspotMessage('warn',
                    i18n.t('settings.hotspot.enabledLikely') ||
                    'Connexion perdue (attendu) — le hotspot a probablement été activé. Reconnectez-vous au nouveau SSID.');
            } else {
                this._showHotspotMessage('error', msg);
                btnEl.disabled = false;
                btnEl.textContent = previousLabel;
                return;
            }
        }

        // Refresh status (best effort — may fail if we just lost the connection).
        setTimeout(() => {
            this.refreshHotspotStatus().finally(() => {
                btnEl.disabled = false;
            });
        }, 1500);
    };

    /**
     * Bind events on the hotspot panel. Called from
     * SettingsModal.attachContentEventListeners after the content HTML
     * is (re)rendered.
     */
    SettingsHotspot.attachHotspotListeners = function() {
        const ssidEl = this.modal.querySelector('#hotspotSsidInput');
        const pwdEl = this.modal.querySelector('#hotspotPasswordInput');
        const bandEl = this.modal.querySelector('#hotspotBandSelect');
        const channelEl = this.modal.querySelector('#hotspotChannelInput');
        const btnEl = this.modal.querySelector('#hotspotToggleBtn');

        if (ssidEl) ssidEl.addEventListener('blur', () => this._persistHotspotForm());
        if (pwdEl) pwdEl.addEventListener('blur', () => this._persistHotspotForm());
        if (bandEl) bandEl.addEventListener('change', () => this._persistHotspotForm());
        if (channelEl) channelEl.addEventListener('change', () => this._persistHotspotForm());
        if (btnEl) btnEl.addEventListener('click', () => this.onHotspotToggle());

        const scanBtn = this.modal.querySelector('#wifiScanBtn');
        const disconnectBtn = this.modal.querySelector('#wifiDisconnectBtn');
        if (scanBtn) scanBtn.addEventListener('click', () => this.scanWifi());
        if (disconnectBtn) disconnectBtn.addEventListener('click', () => this.disconnectWifi());
    };

    // ────────────────────────────────────────────────────────────────
    // WiFi-client controls (shares the Gestion WiFi group with the
    // hotspot panel, but talks to a separate set of WS commands).
    // ────────────────────────────────────────────────────────────────

    SettingsHotspot._escapeHtml = function(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    };

    SettingsHotspot._signalIcon = function(signal) {
        const s = Number(signal) || 0;
        if (s >= 70) return '📶';
        if (s >= 40) return '📶';
        return '📶';
    };

    SettingsHotspot._signalLabel = function(signal) {
        const s = Number(signal) || 0;
        const bars = s >= 75 ? 4 : s >= 50 ? 3 : s >= 25 ? 2 : 1;
        return '▮'.repeat(bars) + '▯'.repeat(4 - bars);
    };

    SettingsHotspot._showWifiMessage = function(kind, text) {
        const el = this.modal.querySelector('#wifiMessage');
        if (!el) return;
        el.style.display = 'block';
        if (kind === 'error')      { el.style.background = '#fee2e2'; el.style.color = '#991b1b'; }
        else if (kind === 'warn')  { el.style.background = '#fef3c7'; el.style.color = '#92400e'; }
        else                       { el.style.background = '#dcfce7'; el.style.color = '#14532d'; }
        el.textContent = text;
    };

    SettingsHotspot._hideWifiMessage = function() {
        const el = this.modal.querySelector('#wifiMessage');
        if (el) el.style.display = 'none';
    };

    /**
     * Refresh the "currently connected" line and the disconnect button.
     * Reuses hotspot_status which already returns wifiActive.
     */
    SettingsHotspot.refreshWifiCurrent = async function() {
        const api = this._getHotspotApi();
        if (!api || !api.sendCommand) return;
        const labelEl = this.modal.querySelector('#wifiCurrentLabel');
        const disconnectBtn = this.modal.querySelector('#wifiDisconnectBtn');
        if (!labelEl) return;

        try {
            const resp = await api.sendCommand('hotspot_status', {}, 8000);
            const wifi = (resp && resp.wifiActive) || '';
            if (wifi) {
                labelEl.innerHTML = '✅ ' + (i18n.t('settings.wifi.currentConnected') || 'Connecté à') + ' <strong>' + this._escapeHtml(wifi) + '</strong>';
                if (disconnectBtn) disconnectBtn.style.display = '';
            } else {
                labelEl.textContent = i18n.t('settings.wifi.currentNone') || 'Non connecté';
                if (disconnectBtn) disconnectBtn.style.display = 'none';
            }
        } catch { /* status failure already surfaced by the hotspot panel */ }
    };

    /**
     * Trigger a WiFi rescan and render the resulting list.
     */
    SettingsHotspot.scanWifi = async function() {
        const api = this._getHotspotApi();
        if (!api || !api.sendCommand) return;
        const listEl = this.modal.querySelector('#wifiNetworksList');
        const scanBtn = this.modal.querySelector('#wifiScanBtn');
        if (!listEl) return;

        listEl.innerHTML = `<div style="padding: 14px; text-align: center; color: #667eea; font-size: 13px;">${i18n.t('settings.wifi.scanning') || 'Scan en cours...'}</div>`;
        if (scanBtn) scanBtn.disabled = true;
        this._hideWifiMessage();

        try {
            const resp = await api.sendCommand('wifi_scan', {}, 15000);
            const nets = (resp && resp.networks) || [];
            // Dedupe by SSID, prefer strongest signal.
            const seen = new Map();
            for (const n of nets) {
                const key = n.ssid || '';
                if (!key) continue;
                const prev = seen.get(key);
                if (!prev || (n.signal || 0) > (prev.signal || 0)) seen.set(key, n);
            }
            const list = Array.from(seen.values()).sort((a, b) => (b.signal || 0) - (a.signal || 0));

            if (list.length === 0) {
                listEl.innerHTML = `<div style="padding: 14px; text-align: center; color: #999; font-size: 13px;">${i18n.t('settings.wifi.noNetworks') || 'Aucun réseau trouvé'}</div>`;
                return;
            }

            listEl.innerHTML = list.map((n) => {
                const isOpen = !n.security || n.security === '' || n.security === '--';
                const lock = isOpen ? '🔓' : '🔒';
                const bars = this._signalLabel(n.signal);
                const active = n.active ? ' <span style="color:#10b981;font-weight:600;">●</span>' : '';
                return `
                    <div class="wifi-net-row" data-ssid="${this._escapeHtml(n.ssid)}" data-secured="${isOpen ? '0' : '1'}"
                         style="padding: 10px 14px; border-bottom: 1px solid var(--border-color,#f0f0f0); display: flex; align-items: center; justify-content: space-between; gap: 10px;">
                        <div style="flex: 1; min-width: 0;">
                            <div style="font-size: 13px; color: var(--text-primary,#333); font-weight: 500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                                ${lock} ${this._escapeHtml(n.ssid)}${active}
                            </div>
                            <div style="font-size: 11px; color: var(--text-secondary,#999); margin-top: 2px;">
                                ${bars} &nbsp; ${this._escapeHtml(n.security || (i18n.t('settings.wifi.open') || 'Ouvert'))} &nbsp; ${n.signal || 0}%
                            </div>
                        </div>
                        <button class="wifi-connect-btn" data-ssid="${this._escapeHtml(n.ssid)}" data-secured="${isOpen ? '0' : '1'}"
                            style="padding: 6px 12px; border: 1px solid #667eea; border-radius: 6px; background: var(--bg-secondary,white); color: #667eea; cursor: pointer; font-size: 12px; white-space: nowrap;">
                            ${i18n.t('settings.wifi.connect') || 'Connecter'}
                        </button>
                    </div>
                `;
            }).join('');

            listEl.querySelectorAll('.wifi-connect-btn').forEach((btn) => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.connectWifi(btn.dataset.ssid, btn.dataset.secured === '1');
                });
            });
        } catch (err) {
            listEl.innerHTML = `<div style="padding: 14px; text-align: center; color: #e53e3e; font-size: 13px;">${this._escapeHtml(err.message || String(err))}</div>`;
        } finally {
            if (scanBtn) scanBtn.disabled = false;
        }
    };

    /**
     * Connect to a network. Asks for password (via showPrompt or window.prompt
     * fallback) when the network is secured.
     */
    SettingsHotspot.connectWifi = async function(ssid, secured) {
        const api = this._getHotspotApi();
        if (!api || !api.sendCommand || !ssid) return;

        let password;
        if (secured) {
            const ask = (typeof window.showPrompt === 'function')
                ? window.showPrompt(
                    (i18n.t('settings.wifi.passwordPromptMessage') || 'Mot de passe pour') + ' "' + ssid + '"',
                    {
                        title: i18n.t('settings.wifi.passwordPromptTitle') || 'Mot de passe WiFi',
                        icon: '🔒',
                        type: 'password',
                        okText: i18n.t('settings.wifi.connect') || 'Connecter',
                        cancelText: i18n.t('common.cancel') || 'Annuler'
                    })
                : Promise.resolve(window.prompt((i18n.t('settings.wifi.passwordPromptMessage') || 'Mot de passe pour') + ' "' + ssid + '"'));
            password = await ask;
            if (password === null || password === undefined) return;
            password = String(password);
            if (password.length === 0) return;
        }

        this._hideWifiMessage();
        this._showWifiMessage('warn', '⏳ ' + (i18n.t('settings.wifi.connecting') || 'Connexion en cours à') + ' "' + ssid + '"...');

        try {
            await api.sendCommand('wifi_connect', { ssid, password }, 45000);
            this._showWifiMessage('ok', '✅ ' + (i18n.t('settings.wifi.connectedOk') || 'Connecté à') + ' "' + ssid + '"');
            await this.refreshWifiCurrent();
            await this.refreshHotspotStatus();
            await this.refreshWifiSaved();
        } catch (err) {
            this._showWifiMessage('error', err.message || String(err));
        }
    };

    /**
     * Disconnect from the current WiFi-client profile (no hotspot toggle).
     */
    SettingsHotspot.disconnectWifi = async function() {
        const api = this._getHotspotApi();
        if (!api || !api.sendCommand) return;
        const confirmed = await window.showConfirm(
            i18n.t('settings.wifi.confirmDisconnect') || 'Déconnecter le WiFi ? Si vous accédez à cette page via WiFi, vous perdrez la connexion.',
            {
                title: i18n.t('settings.wifi.disconnect') || 'Déconnecter',
                icon: '📵',
                okText: i18n.t('settings.wifi.disconnect') || 'Déconnecter',
                cancelText: i18n.t('common.cancel') || 'Annuler',
                danger: true
            }
        );
        if (!confirmed) return;

        try {
            await api.sendCommand('wifi_disconnect', {}, 15000);
            this._showWifiMessage('ok', i18n.t('settings.wifi.disconnectedOk') || 'WiFi déconnecté.');
            await this.refreshWifiCurrent();
        } catch (err) {
            this._showWifiMessage('error', err.message || String(err));
        }
    };

    /**
     * Render the saved-networks list (delete button per row).
     */
    SettingsHotspot.refreshWifiSaved = async function() {
        const api = this._getHotspotApi();
        if (!api || !api.sendCommand) return;
        const listEl = this.modal.querySelector('#wifiSavedList');
        if (!listEl) return;

        try {
            const resp = await api.sendCommand('wifi_list_saved', {}, 8000);
            const profiles = (resp && resp.profiles) || [];
            if (profiles.length === 0) {
                listEl.innerHTML = `<div style="padding: 12px; text-align: center; color: #999; font-size: 12px;">${i18n.t('settings.wifi.noSaved') || 'Aucun réseau enregistré'}</div>`;
                return;
            }
            listEl.innerHTML = profiles.map((p) => `
                <div style="padding: 8px 12px; border-bottom: 1px solid var(--border-color,#f0f0f0); display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                    <span style="font-size: 13px; color: var(--text-primary,#333); flex: 1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                        ${this._escapeHtml(p.name)}${p.autoconnect ? ' <span style="color:#9ca3af;font-size:10px;">(auto)</span>' : ''}
                    </span>
                    <button class="wifi-forget-btn" data-name="${this._escapeHtml(p.name)}"
                        style="padding: 4px 10px; border: 1px solid #e53e3e; border-radius: 6px; background: var(--bg-secondary,white); color: #e53e3e; cursor: pointer; font-size: 11px;">
                        ${i18n.t('settings.wifi.forget') || 'Oublier'}
                    </button>
                </div>
            `).join('');

            listEl.querySelectorAll('.wifi-forget-btn').forEach((btn) => {
                btn.addEventListener('click', () => this.forgetWifi(btn.dataset.name));
            });
        } catch (err) {
            listEl.innerHTML = `<div style="padding: 12px; text-align: center; color: #e53e3e; font-size: 12px;">${this._escapeHtml(err.message || String(err))}</div>`;
        }
    };

    SettingsHotspot.forgetWifi = async function(name) {
        const api = this._getHotspotApi();
        if (!api || !api.sendCommand || !name) return;
        const confirmed = await window.showConfirm(
            (i18n.t('settings.wifi.confirmForget') || 'Oublier le réseau') + ' "' + name + '" ?',
            {
                title: i18n.t('settings.wifi.forget') || 'Oublier',
                icon: '🗑️',
                okText: i18n.t('settings.wifi.forget') || 'Oublier',
                cancelText: i18n.t('common.cancel') || 'Annuler',
                danger: true
            }
        );
        if (!confirmed) return;
        try {
            await api.sendCommand('wifi_forget', { ssid: name }, 8000);
            await this.refreshWifiSaved();
        } catch (err) {
            this._showWifiMessage('error', err.message || String(err));
        }
    };

    // Hook the WiFi-client refresh into the existing hydration so opening
    // the modal populates everything in one shot.
    const _origHydrateHotspot = SettingsHotspot.hydrateHotspot;
    SettingsHotspot.hydrateHotspot = async function() {
        await _origHydrateHotspot.call(this);
        this.refreshWifiCurrent();
        this.refreshWifiSaved();
    };

    if (typeof window !== 'undefined') window.SettingsHotspot = SettingsHotspot;
})();
