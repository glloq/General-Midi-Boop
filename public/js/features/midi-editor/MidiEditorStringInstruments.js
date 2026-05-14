// ============================================================================
// File: public/js/features/midi-editor/MidiEditorStringInstruments.js
// Description: String-instrument helpers extracted from MidiEditorTablature
//   per audit §6.5. Owns the "show/has/find" string instrument lookups
//   that fan out across routing + device caches.
//
// Parent is the `MidiEditorTablature` sub-component (`modal.tablatureOps`).
// State lives on the modal (channelRouting, activeChannels, api, …).
// ============================================================================

(function() {
    'use strict';

    class MidiEditorStringInstruments {
        /** @param {MidiEditorTablature} parent */
        constructor(parent) {
            this.parent = parent;
            this.modal  = parent.modal;
        }

        async showConfig() {
            const modal = this.modal;
            if (modal.activeChannels.size !== 1) return;

            const activeChannel = Array.from(modal.activeChannels)[0];
            const deviceId = this.parent.getEffectiveDeviceId();
            const configModal = new StringInstrumentConfigModal(modal.api, {
                deviceId: deviceId,
                channel: activeChannel,
                onSave: () => {
                    // Refresh tablature button visibility
                    if (modal.channelPanel) {
                        modal.channelPanel.updateTablatureButton();
                    }
                    // Refresh tablature editor if visible — re-render with new config
                    if (modal.tablatureEditor && modal.tablatureEditor.isVisible) {
                        this.parent.toggleTablature(); // hide
                        this.parent.toggleTablature(); // re-show
                    }
                }
            });
            await configModal.showForDevice(deviceId, activeChannel);
        }

        async has() {
            if (this.modal.activeChannels.size !== 1) {
                return false;
            }
            try {
                const activeChannel = Array.from(this.modal.activeChannels)[0];
                const result = await this.find(activeChannel);
                return !!result;
            } catch {
                return false;
            }
        }

        async find(channel) {
            const modal = this.modal;
            // 1. If channel is routed, try the routed device's string instrument first
            if (modal.channelRouting.has(channel)) {
                const routedValue = modal.channelRouting.get(channel);
                let routedDeviceId = routedValue;
                let routedChannel = channel;
                if (routedValue.includes('::')) {
                    const parts = routedValue.split('::');
                    routedDeviceId = parts[0];
                    routedChannel = parseInt(parts[1]);
                }
                try {
                    const resp = await modal.api.sendCommand('string_instrument_get', {
                        device_id: routedDeviceId,
                        channel: routedChannel
                    });
                    if (resp?.instrument) return resp.instrument;
                } catch { /* continue */ }
            }

            // 2. Try with the effective device ID (selected device or '_editor')
            const primaryDeviceId = this.parent.getEffectiveDeviceId();
            try {
                const resp = await modal.api.sendCommand('string_instrument_get', {
                    device_id: primaryDeviceId,
                    channel: channel
                });
                if (resp?.instrument) return resp.instrument;
            } catch { /* continue */ }

            // 3. If effective was a real device, also try '_editor'
            if (primaryDeviceId !== '_editor') {
                try {
                    const resp = await modal.api.sendCommand('string_instrument_get', {
                        device_id: '_editor',
                        channel: channel
                    });
                    if (resp?.instrument) return resp.instrument;
                } catch { /* continue */ }
            }

            // 4. Search across all configured string instruments for this channel
            try {
                const resp = await modal.api.sendCommand('string_instrument_list', {});
                if (resp?.instruments) {
                    const match = resp.instruments.find(si => si.channel === channel);
                    if (match) return match;
                }
            } catch { /* continue */ }

            return null;
        }
    }

    if (typeof window !== 'undefined') {
        window.MidiEditorStringInstruments = MidiEditorStringInstruments;
    }
})();
