(function() {
    'use strict';
    const ISMNavigation = {};

    ISMNavigation._switchSection = function(sectionId) {
        this.activeSection = sectionId;
        // Update sidebar active state
        this.$$('.ism-nav-item').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.section === sectionId);
        });
        // Update content sections
        this.$$('.ism-section').forEach(sec => {
            sec.classList.toggle('active', sec.dataset.section === sectionId);
        });
        // Init piano when switching to notes section (needs visible viewport for size calc)
        if (sectionId === 'notes') {
            this._initPianoForActiveTab();
        }
    };

    ISMNavigation._switchTab = async function(channel) {
        this.activeChannel = channel;
        this.activeSection = 'identity';
        // Reset preview routing + Notes-tab voice pointer: each tab starts
        // on its primary voice (sharing ON is the default baseline).
        this._previewActiveVoice = null;
        this._activeNotesVoiceIdx = null;
        this._syncGlobalState();
        this._refreshContent();
        this._updateHeader();
        // Piano will init when user navigates to Notes section
    };

    ISMNavigation._refreshContent = function() {
        const body = this.$('.modal-body');
        if (body) body.innerHTML = this.renderBody();
        const footer = this.$('.modal-footer');
        if (footer) footer.innerHTML = this.renderFooter();
        this._attachListeners();
    };

    ISMNavigation._addTab = async function() {
        // Debounce rapid `+` clicks: a double-click used to spawn two
        // overlays and race two `instrument_add_to_device` calls.
        if (this._addingTab) return;
        this._addingTab = true;
        try {
            const usedChannels = this.instrumentTabs.map(t => t.channel);
            const freeChannels = [];
            for (let ch = 0; ch < 16; ch++) {
                if (!usedChannels.includes(ch)) freeChannels.push(ch);
            }
            if (freeChannels.length === 0) {
                if (typeof showAlert === 'function') {
                    await showAlert(this.t('instrumentManagement.allChannelsUsed') || 'Tous les canaux MIDI sont déjà utilisés.', {
                        title: this.t('instrumentManagement.addInstrumentTitle') || 'Ajouter',
                        icon: '⚠️'
                    });
                }
                return;
            }

            // Channel selection popup
            const colors = InstrumentSettingsModal.CHANNEL_COLORS;
            const channelNames = {};
            for (const tab of this.instrumentTabs) {
                channelNames[tab.channel] = (tab.settings && (tab.settings.custom_name || tab.settings.name)) || `Instrument Ch${tab.channel + 1}`;
            }
            let gridHtml = '<div class="add-inst-channel-grid">';
            for (let ch = 0; ch < 16; ch++) {
                const isUsed = usedChannels.includes(ch);
                const isDrum = (ch === 9);
                const instName = channelNames[ch] || '';
                gridHtml += `<button type="button" class="add-inst-channel-btn ${isUsed ? 'used' : ''} ${isDrum ? 'drum' : ''}" data-channel="${ch}" ${isUsed ? 'disabled' : ''} style="border-color: ${colors[ch]};" title="${isUsed ? instName : (isDrum ? 'Percussion' : 'Canal ' + (ch + 1))}">
                    <span class="add-inst-ch-number">${ch + 1}${isDrum ? ' 🥁' : ''}</span>
                    ${isUsed ? '<span class="add-inst-ch-name">' + (typeof escapeHtml === 'function' ? escapeHtml(instName) : instName) + '</span>' : '<span class="add-inst-ch-free">' + (this.t('instrumentManagement.free') || 'libre') + '</span>'}
                </button>`;
            }
            gridHtml += '</div>';

            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            overlay.style.zIndex = '10002';
            overlay.innerHTML = `
                <div class="modal-content" style="max-width: 420px;">
                    <div class="modal-header">
                        <h2>${this.t('instrumentManagement.selectChannel') || 'Choisir un canal MIDI'}</h2>
                        <button class="modal-close" data-close-add>×</button>
                    </div>
                    <p class="ism-form-hint" style="margin: 0 0 16px 0;">
                        ${this.t('instrumentManagement.selectChannelHelp') || 'Sélectionnez un canal libre'}
                    </p>
                    ${gridHtml}
                </div>
            `;
            document.body.appendChild(overlay);

            const self = this;
            // If the user dismisses the overlay without picking a channel
            // we still need to clear the debounce flag so `+` keeps working.
            const dismissClosedWithoutPick = function() {
                overlay.remove();
                self._addingTab = false;
            };
            overlay.querySelector('[data-close-add]').addEventListener('click', dismissClosedWithoutPick);
            overlay.querySelectorAll('.add-inst-channel-btn:not([disabled])').forEach(function(btn) {
                btn.addEventListener('click', async function() {
                    const ch = parseInt(btn.dataset.channel);
                    overlay.remove();
                    try {
                        await self.api.sendCommand('instrument_add_to_device', {
                            deviceId: self.device.id,
                            channel: ch,
                            name: 'Instrument Ch' + (ch + 1),
                            gm_program: null
                        });
                        const newTabData = await self._loadChannelData(self.device.id, ch, self.device.type);
                        self.instrumentTabs.push(newTabData);
                        self.instrumentTabs.sort(function(a, b) { return a.channel - b.channel; });
                        // Use the canonical tab-switch path so per-voice
                        // preview / Notes state from the previous tab is
                        // reset (otherwise `_previewActiveVoice` and
                        // `_activeNotesVoiceIdx` carry over, pointing at
                        // voices that don't exist on the new tab).
                        await self._switchTab(ch);
                        // Mirror the save-path refresh: the parent device
                        // list should surface the new channel immediately.
                        if (typeof loadDevices === 'function') await loadDevices();
                        if (window.instrumentManagementPageInstance) {
                            await window.instrumentManagementPageInstance.refresh();
                        }
                    } catch (e) {
                        console.error('Failed to add instrument:', e);
                        if (typeof showAlert === 'function') {
                            await showAlert((self.t('instrumentManagement.addFailed') || 'Erreur') + ': ' + e.message, { title: self.t('common.error') || 'Erreur', icon: '❌' });
                        }
                    } finally {
                        self._addingTab = false;
                    }
                });
            });
        } catch (err) {
            console.error('_addTab error:', err);
            this._addingTab = false;
        }
    };

    ISMNavigation._deleteTab = async function() {
        if (this.instrumentTabs.length <= 1) return;

        const confirmed = typeof showConfirm === 'function' && await showConfirm(
            this.t('instrumentManagement.deleteChannelConfirm') || `Supprimer l'instrument du canal ${this.activeChannel + 1} ?`,
            {
                title: this.t('instrumentManagement.deleteTitle') || 'Supprimer',
                icon: '🗑️',
                okText: this.t('common.delete') || 'Supprimer',
                danger: true
            }
        );
        if (!confirmed) return;

        try {
            await this.api.sendCommand('instrument_delete', {
                deviceId: this.device.id,
                channel: this.activeChannel
            });
            this.instrumentTabs = this.instrumentTabs.filter(t => t.channel !== this.activeChannel);
            // Defensive: the delete button is hidden when only one tab
            // remains, but if we ever get here with an empty list just
            // close the modal cleanly instead of crashing on `[0].channel`.
            if (this.instrumentTabs.length === 0) {
                this.close();
            } else {
                await this._switchTab(this.instrumentTabs[0].channel);
            }
            // Mirror the save-path refresh so the parent device list
            // doesn't show a stale row after the delete.
            if (typeof loadDevices === 'function') await loadDevices();
            if (window.instrumentManagementPageInstance) {
                await window.instrumentManagementPageInstance.refresh();
            }
        } catch (e) {
            console.error('Failed to delete instrument:', e);
            if (typeof showAlert === 'function') {
                await showAlert(
                    (this.t('instrumentManagement.deleteFailed') || 'Échec de la suppression') + ' : ' + (e.message || e),
                    { title: this.t('common.error') || 'Erreur', icon: '❌' }
                );
            }
        }
    };

    if (typeof window !== 'undefined') window.ISMNavigation = ISMNavigation;
})();
