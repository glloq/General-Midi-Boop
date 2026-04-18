(function() {
    'use strict';
    const SettingsSerial = {};

    /**
     * Scan serial ports and display results
     */
    SettingsSerial.scanSerialPorts = async function() {
        const listEl = this.modal.querySelector('#serialPortsList');
        const scanBtn = this.modal.querySelector('#serialScanBtn');
        if (!listEl) return;

        // Show loading
        listEl.innerHTML = `<div style="padding: 16px; text-align: center; color: #667eea; font-size: 13px;">
            ${i18n.t('settings.serialMidi.scanning')}
        </div>`;
        if (scanBtn) scanBtn.disabled = true;

        try {
            this.eventBus?.emit('serial:scan_requested');

            // Wait for response via event
            const result = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Scan timeout')), 10000);
                const handler = (data) => {
                    clearTimeout(timeout);
                    this.eventBus?.off('serial:scan_result', handler);
                    resolve(data);
                };
                this.eventBus?.on('serial:scan_result', handler);
            });

            if (!result.available) {
                listEl.innerHTML = `<div style="padding: 16px; text-align: center; color: #e53e3e; font-size: 13px;">
                    ${i18n.t('settings.serialMidi.notAvailable')}
                </div>`;
                return;
            }

            if (!result.ports || result.ports.length === 0) {
                listEl.innerHTML = `<div style="padding: 16px; text-align: center; color: #999; font-size: 13px;">
                    ${i18n.t('settings.serialMidi.noPorts')}
                </div>`;
                return;
            }

            // Render ports list
            listEl.innerHTML = result.ports.map(port => `
                <div style="
                    padding: 12px 16px;
                    border-bottom: 1px solid #f0f0f0;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                ">
                    <div>
                        <div style="font-size: 14px; font-weight: 500; color: #333;">
                            <span style="
                                display: inline-block;
                                width: 8px;
                                height: 8px;
                                border-radius: 50%;
                                background: ${port.isOpen ? '#38a169' : '#a0aec0'};
                                margin-right: 8px;
                            "></span>
                            ${escapeHtml(port.name)}
                        </div>
                        <div style="font-size: 12px; color: #999; margin-top: 2px;">${escapeHtml(port.path)}</div>
                    </div>
                    <button class="serial-port-toggle-btn" data-path="${escapeHtml(port.path)}" data-name="${escapeHtml(port.name)}" data-open="${port.isOpen}" style="
                        padding: 6px 14px;
                        border: 1px solid ${port.isOpen ? '#e53e3e' : '#38a169'};
                        border-radius: 6px;
                        background: white;
                        color: ${port.isOpen ? '#e53e3e' : '#38a169'};
                        cursor: pointer;
                        font-size: 12px;
                        transition: all 0.2s;
                    ">${port.isOpen ? i18n.t('common.disconnect') : i18n.t('common.connect')}</button>
                </div>
            `).join('');

            // Attach toggle buttons
            listEl.querySelectorAll('.serial-port-toggle-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const portPath = btn.dataset.path;
                    const portName = btn.dataset.name;
                    const isOpen = btn.dataset.open === 'true';

                    // Disable button during action
                    btn.disabled = true;
                    btn.textContent = '...';

                    try {
                        if (isOpen) {
                            this.eventBus?.emit('serial:close_requested', { path: portPath });
                        } else {
                            this.eventBus?.emit('serial:open_requested', { path: portPath, name: portName, direction: 'both' });
                        }

                        // Wait then rescan to show updated state
                        await new Promise(r => setTimeout(r, 500));
                        await this.scanSerialPorts();
                    } catch (error) {
                        btn.textContent = i18n.t('common.error');
                        btn.style.color = '#e53e3e';
                        btn.style.borderColor = '#e53e3e';
                        this.logger?.error(`Serial port ${isOpen ? 'close' : 'open'} error: ${error.message}`);
                        // Rescan after error to show current state
                        setTimeout(() => this.scanSerialPorts(), 1000);
                    }
                });
            });

        } catch (error) {
            listEl.innerHTML = `<div style="padding: 16px; text-align: center; color: #e53e3e; font-size: 13px;">
                ${escapeHtml(error.message)}
            </div>`;
        } finally {
            if (scanBtn) scanBtn.disabled = false;
        }
    };

    if (typeof window !== 'undefined') window.SettingsSerial = SettingsSerial;
})();
