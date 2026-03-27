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
    };

    ISMNavigation._switchTab = async function(channel) {
        this.activeChannel = channel;
        this.activeSection = 'identity';
        this._syncGlobalState();
        this._refreshContent();
        this._initPianoForActiveTab();
    };

    ISMNavigation._refreshContent = function() {
        const body = this.$('.modal-body');
        if (body) body.innerHTML = this.renderBody();
        const footer = this.$('.modal-footer');
        if (footer) footer.innerHTML = this.renderFooter();
        this._attachListeners();
    };

    ISMNavigation._addTab = async function() {
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
        let gridHtml = '<div class="add-inst-channel-grid">';
        for (let ch = 0; ch < 16; ch++) {
            const isUsed = usedChannels.includes(ch);
            const isDrum = (ch === 9);
            gridHtml += `<button type="button" class="add-inst-channel-btn ${isUsed ? 'used' : ''}" data-channel="${ch}" ${isUsed ? 'disabled' : ''} style="${!isUsed ? `border-color: ${colors[ch]};` : ''}">
                ${ch + 1}${isDrum ? ' DR' : ''}
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

        overlay.querySelector('[data-close-add]').addEventListener('click', () => overlay.remove());
        overlay.querySelectorAll('.add-inst-channel-btn:not([disabled])').forEach(btn => {
            btn.addEventListener('click', async () => {
                const ch = parseInt(btn.dataset.channel);
                overlay.remove();
                try {
                    await this.api.sendCommand('instrument_add_to_device', {
                        deviceId: this.device.id,
                        channel: ch,
                        name: `Instrument Ch${ch + 1}`
                    });
                    const newTabData = await this._loadChannelData(this.device.id, ch, this.device.type);
                    this.instrumentTabs.push(newTabData);
                    this.instrumentTabs.sort((a, b) => a.channel - b.channel);
                    await this._switchTab(ch);
                } catch (e) {
                    console.error('Failed to add instrument:', e);
                    if (typeof showAlert === 'function') {
                        await showAlert((this.t('instrumentManagement.addFailed') || 'Erreur') + ': ' + e.message, { title: this.t('common.error') || 'Erreur', icon: '❌' });
                    }
                }
            });
        });
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
            await this._switchTab(this.instrumentTabs[0].channel);
        } catch (e) {
            console.error('Failed to delete instrument:', e);
        }
    };

    if (typeof window !== 'undefined') window.ISMNavigation = ISMNavigation;
})();
