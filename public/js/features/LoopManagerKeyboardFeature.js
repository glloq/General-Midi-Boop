/**
 * LoopManagerKeyboardFeature — Keyboard tab feature of LoopManagerModal.
 *
 * Audit §6.6 — first slice of the LoopCreatorModal god-class (3 394 l.).
 * Extracts the self-contained Keyboard tab: piano-panel mount/unmount,
 * note on/off routing (live device or local synth), GM program switch,
 * and panic. Owns its own state; the modal references it as
 * `this.keyboard`.
 *
 * Interface with the parent modal:
 *   - reads `modal.api`, `modal.$()`, `modal._globalOutput`
 *   - calls `modal.t()`, `modal._setGlobalOutput(out)`
 *   - depends on `window.keyboardModal` for the piano UI
 *
 * Public methods (used by the modal):
 *   - enterTab()        — async; called when the keyboard tab is shown
 *   - unmount()         — detach the panel
 *   - stopAllNotes()    — panic
 *   - mounted (boolean) — current state
 */
(function () {
    'use strict';

    class LoopManagerKeyboardFeature {
        /** @param {LoopManagerModal} modal */
        constructor(modal) {
            this.modal = modal;
            this.synth = null;
            this.mounted = false;
            this.envelopes = new Map();   // note → [envelope, ...]
            this.activeKeys = new Set();
            this.instrument = 0;          // GM program (0-127)
            this.isDrum = false;
        }

        /**
         * Activate the keyboard tab: lazy-init the local synth and mount
         * the shared `keyboardModal` piano panel.
         */
        async enterTab() {
            if (!this.synth) {
                this.synth = await LoopUtils.createSynth({ initialProgram: this.instrument });
            }
            if (!this.mounted) this._mountPanel();
        }

        _mountPanel() {
            const container = this.modal.$('#lm-kbd-panel');
            if (!container || !window.keyboardModal) return;
            if (window.keyboardModal._panelMode) {
                // Editor (or another host) currently owns the keyboard panel —
                // give them precedence; we'll mount on next tab activation.
                return;
            }
            try {
                window.keyboardModal.mountAsPanel(container, {
                    onNoteOn:  (note, vel) => this.noteOn(note, vel),
                    onNoteOff: (note)      => this.noteOff(note),
                    onInstrumentSelected: ({ deviceId, channel, gmProgram, instrumentType, isDrum: isDrumFromKbd }) => {
                        // Cancel any sustained voice before switching instrument /
                        // device so it doesn't keep ringing on the previous program.
                        this.stopAllNotes();
                        this.instrument = gmProgram ?? 0;
                        // Drum kit : on route sur le canal 9 (convention GM) sinon
                        // le synth utilise le path mélodique → joue un piano.
                        this.isDrum = isDrumFromKbd === true
                            || instrumentType === 'drum'
                            || channel === 9
                            || (gmProgram != null && gmProgram >= 128);
                        if (this.synth) {
                            try {
                                if (this.isDrum) {
                                    this.synth.setChannelInstrument(9, this.instrument);
                                    this.synth.loadDrumKit?.().catch(err =>
                                        LoopUtils.handleError(err, 'kbd.synth.loadDrumKit'));
                                } else {
                                    this.synth.setChannelInstrument(0, this.instrument);
                                    if (!this.synth.loadedInstruments?.has(this.instrument)) {
                                        this.synth.loadInstrument(this.instrument).catch(err =>
                                            LoopUtils.handleError(err, 'kbd.synth.loadInstrument'));
                                    }
                                }
                            } catch (err) { LoopUtils.handleError(err, 'kbd.synth.setChannelInstrument'); }
                        }
                        // The keyboard panel's instrument selector is the source of
                        // truth for the global output device. The header toggle
                        // then chooses preview-synth vs that device.
                        if (deviceId) {
                            this.modal._setGlobalOutput({
                                deviceId,
                                channel: channel ?? 0,
                                // Switching to a real instrument flips to device mode
                                mode: 'device'
                            });
                        } else {
                            // "Preview" or no device picked → keep deviceId so the
                            // toggle can flip back later, but force synth mode.
                            this.modal._setGlobalOutput({ mode: 'synth' });
                        }
                    }
                });
                this.mounted = true;
            } catch (err) {
                LoopUtils.handleError(err, 'kbd.mount', {
                    toast: this.modal.t('loopManager.errKbdMount')
                });
            }
        }

        unmount() {
            try { window.keyboardModal?.unmountPanel?.(); }
            catch (err) { LoopUtils.handleError(err, 'kbd.unmount'); }
            this.mounted = false;
            this.stopAllNotes();
        }

        /**
         * The header toggle is the single source of truth for routing:
         * when `_globalOutput.mode === 'device'` notes go to the picked
         * device, otherwise they go to the local preview synth.
         * @returns {{deviceId:string, channel:number}|null}
         */
        _routingDevice() {
            const out = this.modal._globalOutput;
            return out.mode === 'device' && out.deviceId
                ? { deviceId: out.deviceId, channel: out.channel ?? 0 }
                : null;
        }

        noteOn(note, velocity = 80) {
            if (this.activeKeys.has(note)) return;
            this.activeKeys.add(note);
            const route = this._routingDevice();
            if (route) {
                this.modal.api.sendCommand('midi_send_note', {
                    deviceId: route.deviceId, channel: route.channel,
                    note, velocity
                }).catch(err => LoopUtils.handleError(err, 'kbd.live.noteOn'));
                return;
            }
            if (!this.synth) return;
            try {
                // Canal 9 si le kit drum est sélectionné, sinon 0 (mélodique).
                const ch = this.isDrum ? 9 : 0;
                const env = this.synth.playNote(note, velocity, ch, 9999);
                if (env) this.envelopes.set(note, env);
            } catch (err) {
                LoopUtils.handleError(err, 'kbd.synth.playNote');
            }
        }

        noteOff(note) {
            this.activeKeys.delete(note);
            const route = this._routingDevice();
            if (route) {
                this.modal.api.sendCommand('midi_send_note', {
                    deviceId: route.deviceId, channel: route.channel,
                    note, velocity: 0
                }).catch(err => LoopUtils.handleError(err, 'kbd.live.noteOff'));
                return;
            }
            const env = this.envelopes.get(note);
            if (!env) return;
            for (const e of env) {
                try { e?.cancel?.(); }
                catch (err) { LoopUtils.handleError(err, 'kbd.synth.cancel'); }
            }
            this.envelopes.delete(note);
        }

        stopAllNotes() {
            // Live device: send a note-off for every held note before clearing.
            const route = this._routingDevice();
            if (route && this.activeKeys.size) {
                for (const n of this.activeKeys) {
                    this.modal.api.sendCommand('midi_send_note', {
                        deviceId: route.deviceId, channel: route.channel,
                        note: n, velocity: 0
                    }).catch(err => LoopUtils.handleError(err, 'kbd.live.flushNoteOff'));
                }
            }
            // Synth: cancel any envelopes still ringing.
            for (const env of this.envelopes.values()) {
                for (const e of env) { try { e?.cancel?.(); } catch (_) { /* best-effort */ } }
            }
            this.envelopes.clear();
            this.activeKeys.clear();
        }
    }

    if (typeof window !== 'undefined') {
        window.LoopManagerKeyboardFeature = LoopManagerKeyboardFeature;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = LoopManagerKeyboardFeature;
    }
})();
