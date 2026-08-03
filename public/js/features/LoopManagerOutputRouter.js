/**
 * LoopManagerOutputRouter — Global output device router for LoopManagerModal.
 *
 * Audit §6.6 — final slice (SharedUtils part) after Keyboard, Library,
 * Live, Pad, Arranger. The router owns the header-level synth/device
 * toggle, the cached device list, the device-shim (a fake synth-like
 * object that forwards play/cancel to a backend MIDI device), and
 * the panic-on-switch logic.
 *
 * State owned by the router (was on the modal pre-extraction):
 *   - `globalOutput`   — { mode: 'synth'|'device', deviceId, channel }
 *   - `deviceShim`     — lazy-built synth-shim for live device output
 *   - `cachedDevices`  — last-known device list snapshot
 *
 * The modal exposes the state read-only via getters
 * (`modal._globalOutput`, `modal._deviceShim`, `modal._cachedDevices`)
 * for back-compat with existing readers in Pad/Live/Arranger/Keyboard.
 *
 * Public methods (used by the modal and Keyboard feature):
 *   - loadDevices()      — async; refresh cachedDevices + UI
 *   - refreshUI()
 *   - toggleMode()       — flip synth ⇄ device
 *   - setOutput(next)    — merge-patch globalOutput, panic on switch
 *   - getTarget(fallbackSynth)
 *   - panicTarget(target)
 */
(function () {
  'use strict';

  class LoopManagerOutputRouter {
    /** @param {LoopManagerModal} modal */
    constructor(modal) {
      this.modal = modal;
      this.globalOutput = { mode: 'synth', deviceId: null, channel: 0 };
      this.deviceShim = null;
      this.cachedDevices = [];
    }

    async loadDevices() {
      // Devices are no longer picked from the header — the keyboard panel's
      // instrument selector sets the global deviceId. We still cache the
      // device list here so other tabs can resolve names if needed.
      try {
        const allDevices = await this.modal.api.listDevices();
        this.cachedDevices = (allDevices || []).filter(
          (d) => d.status === 2 || d.connected === true
        );
      } catch (err) {
        LoopUtils.handleError(err, 'manager.header.listDevices');
        this.cachedDevices = [];
      }
      this.refreshUI();
    }

    refreshUI() {
      const m = this.modal;
      const btn = m.$('#lc-header-output-btn');
      const icon = m.$('#lc-header-output-icon');
      const label = m.$('#lc-header-output-label');
      const isDev = this.globalOutput.mode === 'device';
      if (icon) icon.textContent = isDev ? '🔌' : '🔊';
      if (label)
        label.textContent = isDev ? m.t('loopManager.outputLive') : m.t('loopManager.outputSynth');
      if (btn) {
        btn.classList.toggle('lc-header-output-btn--device', isDev);
        btn.setAttribute('aria-pressed', isDev ? 'true' : 'false');
      }
    }

    toggleMode() {
      // Pure mode switch: preview-synth ⇄ live-device. If no device has
      // been picked yet in the virtual piano, the per-tab routing
      // gracefully falls back to the synth (see keyboard._routingDevice
      // and getTarget) — no upfront check needed.
      const next = this.globalOutput.mode === 'device' ? 'synth' : 'device';
      this.setOutput({ mode: next });
    }

    /**
     * Merge-patch the global output. When the routing target actually
     * changes, stops every playback source on the modal and panics the
     * previous device to avoid stuck notes.
     * @param {Object} next - Partial { mode, deviceId, channel }.
     */
    setOutput(next) {
      const prev = this.globalOutput;
      this.globalOutput = { ...prev, ...next };
      if (prev.mode !== this.globalOutput.mode || prev.deviceId !== this.globalOutput.deviceId) {
        const m = this.modal;
        m._stopAllPads();
        m._liveStopAll();
        m._stopArrangerPlay();
        m.keyboard?.stopAllNotes();
        this.panicTarget(prev);
        this.deviceShim = null; // rebuilt lazily
      }
      this.refreshUI();
    }

    panicTarget(target) {
      if (!target || target.mode !== 'device' || !target.deviceId) return;
      this.modal.api
        .sendCommand('midi_panic', { deviceId: target.deviceId })
        .catch((err) => LoopUtils.handleError(err, 'manager.output.panic'));
    }

    /**
     * Resolve the active output: a backend device shim when in
     * device mode + a deviceId is set, otherwise the supplied
     * fallback synth.
     * @param {Object} fallbackSynth
     */
    getTarget(fallbackSynth) {
      if (this.globalOutput.mode === 'device' && this.globalOutput.deviceId) {
        if (!this.deviceShim) this.deviceShim = this._makeDeviceShim();
        return this.deviceShim;
      }
      return fallbackSynth;
    }

    _makeDeviceShim() {
      const api = this.modal.api;
      const getOutput = () => this.globalOutput;
      return {
        loadedInstruments: { has: () => true },
        loadInstrument: async () => {},
        setChannelInstrument: () => {},
        cancelAllNotes: () => {
          const out = getOutput();
          if (!out.deviceId) return;
          api
            .sendCommand('midi_panic', { deviceId: out.deviceId })
            .catch((err) => LoopUtils.handleError(err, 'manager.shim.panic'));
        },
        playNote: (note, velocity, _ch, durSec) => {
          const out = getOutput();
          if (!out.deviceId) return null;
          api
            .sendCommand('midi_send_note', {
              deviceId: out.deviceId,
              channel: out.channel ?? 0,
              note,
              velocity: velocity || 80,
              duration: Math.max(20, Math.round((durSec || 0.5) * 1000))
            })
            .catch((err) => LoopUtils.handleError(err, 'manager.shim.playNote'));
          return null;
        }
      };
    }
  }

  if (typeof window !== 'undefined') {
    window.LoopManagerOutputRouter = LoopManagerOutputRouter;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = LoopManagerOutputRouter;
  }
})();
