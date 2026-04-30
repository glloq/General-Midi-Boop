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
    };

    if (typeof window !== 'undefined') window.SettingsHotspot = SettingsHotspot;
})();
