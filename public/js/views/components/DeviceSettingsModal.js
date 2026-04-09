/**
 * DeviceSettingsModal — Modal for device-level settings.
 * Contains: custom name, MIDI clock toggle, message rate limit.
 */
(function() {
    'use strict';

    class DeviceSettingsModal {
        constructor(apiClient) {
            this.api = apiClient;
            this.deviceId = null;
            this.deviceName = null;
            this.settings = null;
            this.overlay = null;
            this.modal = null;
            this._onSaveCallback = null;
        }

        /**
         * Show the modal for a given device.
         * @param {string} deviceId
         * @param {string} deviceName - Original device name (fallback)
         * @param {Function} [onSave] - Callback after successful save
         */
        async show(deviceId, deviceName, onSave) {
            this.deviceId = deviceId;
            this.deviceName = deviceName;
            this._onSaveCallback = onSave || null;

            // Load current settings from backend
            try {
                const resp = await this.api.sendCommand('device_get_settings', { deviceId });
                this.settings = resp.settings || {};
            } catch (e) {
                this.settings = { custom_name: null, midi_clock_enabled: 0, message_rate_limit: 0 };
            }

            this._render();
            this._attachListeners();
            this.overlay.style.display = 'flex';
        }

        _render() {
            // Remove previous modal if any
            if (this.overlay) this.overlay.remove();

            this.overlay = document.createElement('div');
            this.overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:none;align-items:center;justify-content:center;z-index:10000;';

            this.modal = document.createElement('div');
            this.modal.style.cssText = 'background:var(--bg-primary,white);border-radius:16px;width:90%;max-width:480px;box-shadow:0 20px 60px rgba(0,0,0,0.3);overflow:hidden;';

            const t = (key, fallback) => (typeof i18n !== 'undefined' ? i18n.t(key) : null) || fallback;
            const customName = this.settings.custom_name || '';
            const midiClockEnabled = !!this.settings.midi_clock_enabled;
            const rateLimit = this.settings.message_rate_limit || 0;

            this.modal.innerHTML = `
                <!-- Header -->
                <div style="padding:16px 20px;border-bottom:1px solid var(--border-color,#e5e7eb);display:flex;justify-content:space-between;align-items:center;background:linear-gradient(135deg,rgba(0,0,0,0.02),rgba(0,0,0,0.04));">
                    <h2 style="margin:0;font-size:18px;color:var(--text-primary,#1f2937);">⚙️ ${t('deviceSettings.title', 'Réglages du périphérique')}</h2>
                    <button id="dsm-close">&times;</button>
                </div>

                <!-- Content -->
                <div style="padding:20px;">
                    <!-- Device info -->
                    <div style="margin-bottom:20px;padding:10px 14px;background:var(--bg-tertiary,#f3f4f6);border-radius:8px;font-size:13px;color:var(--text-secondary,#6b7280);">
                        ID: <code style="font-size:12px;">${this._escapeHtml(this.deviceId)}</code>
                    </div>

                    <!-- Custom name -->
                    <div style="margin-bottom:20px;">
                        <label style="display:block;margin-bottom:6px;font-size:14px;font-weight:600;color:var(--text-primary,#333);">
                            ${t('deviceSettings.customName', 'Nom personnalisé')}
                        </label>
                        <input type="text" id="dsm-customName" value="${this._escapeHtml(customName)}"
                            placeholder="${t('deviceSettings.customNamePlaceholder', 'Laisser vide pour le nom par défaut')}"
                            style="width:100%;padding:10px 14px;border:2px solid var(--border-color,#e5e7eb);border-radius:8px;font-size:14px;color:var(--text-primary,#333);background:var(--bg-secondary,white);box-sizing:border-box;">
                        <p style="margin:4px 0 0;font-size:12px;color:var(--text-secondary,#999);">
                            ${t('deviceSettings.customNameHelp', 'Nom par défaut')} : ${this._escapeHtml(this.deviceName)}
                        </p>
                    </div>

                    <!-- MIDI Clock toggle -->
                    <div style="margin-bottom:20px;">
                        <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;">
                            <div style="flex:1;">
                                <p style="margin:0 0 4px;font-size:14px;font-weight:600;color:var(--text-primary,#333);">
                                    🕐 ${t('deviceSettings.midiClock', 'Horloge MIDI')}
                                </p>
                                <p style="margin:0;font-size:12px;color:var(--text-secondary,#666);">
                                    ${t('deviceSettings.midiClockDescription', "Envoyer le signal d'horloge MIDI à ce périphérique")}
                                </p>
                            </div>
                            <label style="position:relative;display:inline-block;width:52px;height:28px;flex-shrink:0;">
                                <input type="checkbox" id="dsm-midiClock" ${midiClockEnabled ? 'checked' : ''}
                                    style="opacity:0;width:0;height:0;">
                                <span class="dsm-toggle-slider" style="
                                    position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;
                                    background-color:${midiClockEnabled ? '#667eea' : '#ccc'};
                                    transition:0.3s;border-radius:28px;
                                "></span>
                                <span class="dsm-toggle-thumb" style="
                                    position:absolute;content:'';height:22px;width:22px;left:${midiClockEnabled ? '27px' : '3px'};bottom:3px;
                                    background-color:white;transition:0.3s;border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,0.2);
                                "></span>
                            </label>
                        </div>
                    </div>

                    <!-- Message rate limit -->
                    <div style="margin-bottom:20px;">
                        <label style="display:block;margin-bottom:6px;font-size:14px;font-weight:600;color:var(--text-primary,#333);">
                            ${t('deviceSettings.messageRateLimit', 'Limite de messages')}
                        </label>
                        <div style="display:flex;align-items:center;gap:8px;">
                            <input type="number" id="dsm-rateLimit" value="${rateLimit}" min="0" max="10000" step="50"
                                style="width:120px;padding:10px 14px;border:2px solid var(--border-color,#e5e7eb);border-radius:8px;font-size:14px;color:var(--text-primary,#333);background:var(--bg-secondary,white);">
                            <span style="font-size:13px;color:var(--text-secondary,#666);">${t('deviceSettings.messageRateLimitUnit', 'msgs/sec')}</span>
                        </div>
                        <p style="margin:4px 0 0;font-size:12px;color:var(--text-secondary,#999);">
                            ${t('deviceSettings.messageRateLimitDescription', 'Nombre maximum de messages MIDI par seconde (0 = illimité)')}
                        </p>
                    </div>

                    <!-- SysEx Identity Request -->
                    <div style="margin-bottom:8px;">
                        <label style="display:block;margin-bottom:6px;font-size:14px;font-weight:600;color:var(--text-primary,#333);">
                            SysEx Identity
                        </label>
                        <div id="dsm-sysexResult" style="display:none;margin-bottom:8px;padding:10px 14px;background:var(--bg-tertiary,#f3f4f6);border-radius:8px;font-size:13px;color:var(--text-secondary,#6b7280);"></div>
                        <button type="button" id="dsm-sysexRequestBtn" style="padding:8px 16px;border:1px solid var(--border-color,#d1d5db);border-radius:8px;background:var(--bg-secondary,white);color:var(--text-primary,#374151);cursor:pointer;font-size:13px;">
                            ${t('instrumentSettings.requestIdentity', "Demander l'identit\u00e9 via SysEx")}
                        </button>
                        <p style="margin:4px 0 0;font-size:12px;color:var(--text-secondary,#999);">
                            ${t('deviceSettings.sysexHelp', 'Interroge le p\u00e9riph\u00e9rique pour obtenir son identit\u00e9 SysEx')}
                        </p>
                    </div>
                </div>

                <!-- Footer -->
                <div style="padding:12px 20px;border-top:1px solid var(--border-color,#e5e7eb);display:flex;justify-content:flex-end;gap:10px;background:var(--bg-tertiary,#f9fafb);">
                    <button id="dsm-cancel" style="padding:8px 20px;border:1px solid var(--border-color,#d1d5db);border-radius:8px;background:var(--bg-secondary,white);color:var(--text-primary,#374151);cursor:pointer;font-size:14px;">
                        ${t('common.cancel', 'Annuler')}
                    </button>
                    <button id="dsm-save" style="padding:8px 20px;border:none;border-radius:8px;background:linear-gradient(135deg,#667eea,#764ba2);color:white;cursor:pointer;font-size:14px;font-weight:600;box-shadow:0 2px 8px rgba(102,126,234,0.3);">
                        ${t('common.save', 'Sauvegarder')}
                    </button>
                </div>
            `;

            this.overlay.appendChild(this.modal);
            document.body.appendChild(this.overlay);
        }

        _attachListeners() {
            // Close
            this.modal.querySelector('#dsm-close').addEventListener('click', () => this.close());
            this.modal.querySelector('#dsm-cancel').addEventListener('click', () => this.close());
            this.overlay.addEventListener('click', (e) => { if (e.target === this.overlay) this.close(); });

            // Toggle slider visual feedback
            const checkbox = this.modal.querySelector('#dsm-midiClock');
            const slider = this.modal.querySelector('.dsm-toggle-slider');
            const thumb = this.modal.querySelector('.dsm-toggle-thumb');
            if (checkbox && slider && thumb) {
                checkbox.addEventListener('change', () => {
                    slider.style.backgroundColor = checkbox.checked ? '#667eea' : '#ccc';
                    thumb.style.left = checkbox.checked ? '27px' : '3px';
                });
            }

            // Save
            this.modal.querySelector('#dsm-save').addEventListener('click', () => this._save());

            // SysEx Identity Request
            const sysexBtn = this.modal.querySelector('#dsm-sysexRequestBtn');
            if (sysexBtn) {
                sysexBtn.addEventListener('click', () => this._requestSysExIdentity());
            }

            // Listen for SysEx identity response
            this._sysexHandler = (data) => this._handleSysExIdentity(data);
            if (this.api && typeof this.api.on === 'function') {
                this.api.on('device_identity', this._sysexHandler);
            }

            // Escape key
            this._escHandler = (e) => { if (e.key === 'Escape') this.close(); };
            document.addEventListener('keydown', this._escHandler);
        }

        async _save() {
            const customName = (this.modal.querySelector('#dsm-customName')?.value || '').trim();
            const midiClockEnabled = this.modal.querySelector('#dsm-midiClock')?.checked ?? false;
            const rateLimit = parseInt(this.modal.querySelector('#dsm-rateLimit')?.value) || 0;

            try {
                await this.api.sendCommand('device_update_settings', {
                    deviceId: this.deviceId,
                    deviceName: this.deviceName,
                    custom_name: customName || null,
                    midi_clock_enabled: midiClockEnabled,
                    message_rate_limit: rateLimit
                });

                if (this._onSaveCallback) this._onSaveCallback();
                this.close();
            } catch (err) {
                console.error('Failed to save device settings:', err);
            }
        }

        _requestSysExIdentity() {
            if (!this.api || !this.deviceId) return;
            const btn = this.modal.querySelector('#dsm-sysexRequestBtn');
            if (btn) {
                btn.disabled = true;
                btn.textContent = '⏳ En attente...';
            }
            try {
                this.api.sendCommand('sysex_identity_request', { deviceId: this.deviceId });
            } catch (e) {
                console.error('SysEx identity request failed:', e);
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = "Demander l'identité via SysEx";
                }
            }
            setTimeout(() => {
                if (btn && btn.disabled) {
                    btn.disabled = false;
                    btn.textContent = "Demander l'identité via SysEx";
                }
            }, 5000);
        }

        _handleSysExIdentity(data) {
            if (!data) return;
            const btn = this.modal?.querySelector('#dsm-sysexRequestBtn');
            const resultDiv = this.modal?.querySelector('#dsm-sysexResult');
            if (resultDiv) {
                const name = this._escapeHtml(data.name || 'Inconnu');
                const firmware = this._escapeHtml(data.firmware || data.version || '-');
                const protocol = this._escapeHtml(data.protocol || '-');
                resultDiv.innerHTML = `<strong>${name}</strong> — Firmware: ${firmware} — Protocole: ${protocol}`;
                resultDiv.style.display = 'block';
            }
            if (btn) {
                btn.disabled = false;
                btn.textContent = '✅ Identité reçue';
                setTimeout(() => {
                    if (btn) btn.textContent = "Demander l'identité via SysEx";
                }, 3000);
            }
        }

        close() {
            if (this._sysexHandler && this.api && typeof this.api.off === 'function') {
                this.api.off('device_identity', this._sysexHandler);
                this._sysexHandler = null;
            }
            if (this.overlay) {
                this.overlay.style.display = 'none';
                this.overlay.remove();
                this.overlay = null;
            }
            if (this._escHandler) {
                document.removeEventListener('keydown', this._escHandler);
                this._escHandler = null;
            }
        }

        _escapeHtml(str) {
            if (!str) return '';
            return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }
    }

    if (typeof window !== 'undefined') window.DeviceSettingsModal = DeviceSettingsModal;
})();
