// Per-sound-bank effect sliders (reverb + echo). Mixed into
// SettingsModal.prototype alongside SettingsTemplates/SettingsSerial/...
//
// Responsibilities:
//  - Fetch stored overrides from the server via `bank_effects_get`
//    whenever the modal opens or the user switches bank.
//  - Send `bank_effects_update` (debounced) on every slider move and
//    push the new values to every live synth via
//    MidiSynthesizer.broadcastBankEffects().
//  - Send `bank_effects_reset` when the user clicks "Réinitialiser".
//
// Values use the schema from the `bank_effects` SQLite table
// (see migrations/002_bank_effects.sql). Sliders show 0–100 %
// for the normalized floats; the DB stores them as 0.0–1.0.

(function() {
    'use strict';
    const SettingsBankEffects = {};

    const DEBOUNCE_MS = 150;

    // UI config: maps slider DOM ids to DB columns + unit conversions.
    // `toUi(dbVal)` converts the stored value to the slider's visible
    // number; `fromUi(sliderVal)` converts it back for persistence.
    const SLIDERS = [
        {
            id: 'bankEffectReverbMix',
            field: 'reverb_mix',
            toUi: v => Math.round((v ?? 0) * 100),
            fromUi: v => Number(v) / 100,
            format: v => `${v}%`
        },
        {
            id: 'bankEffectReverbDecay',
            field: 'reverb_decay_s',
            toUi: v => (v ?? 1.2).toFixed(1),
            fromUi: v => Number(v),
            format: v => `${v}s`
        },
        {
            id: 'bankEffectEchoMix',
            field: 'echo_mix',
            toUi: v => Math.round((v ?? 0) * 100),
            fromUi: v => Number(v) / 100,
            format: v => `${v}%`
        },
        {
            id: 'bankEffectEchoTime',
            field: 'echo_time_ms',
            toUi: v => Math.round(v ?? 250),
            fromUi: v => parseInt(v, 10),
            format: v => `${v}ms`
        },
        {
            id: 'bankEffectEchoFeedback',
            field: 'echo_feedback',
            toUi: v => Math.round((v ?? 0) * 100),
            fromUi: v => Number(v) / 100,
            format: v => `${v}%`
        }
    ];

    function _api() {
        return window.api || window.apiClient || null;
    }

    function _currentBankId(self) {
        const select = self.modal && self.modal.querySelector('#soundBankSelect');
        return (select && select.value)
            || self.settings.soundBank
            || 'FluidR3_GM';
    }

    /**
     * Fetch the stored row for the current bank and push its values
     * into every slider. Falls back to bank defaults when the row
     * does not exist (absent row = using bank defaults).
     */
    SettingsBankEffects.hydrateBankEffects = async function() {
        if (!this.modal) return;
        const api = _api();
        const bankId = _currentBankId(this);

        let effects = null;
        if (api && typeof api.sendCommand === 'function') {
            try {
                const resp = await api.sendCommand('bank_effects_get', { bankId });
                effects = (resp && resp.effects) || null;
            } catch (e) {
                this.logger?.warn(`bank_effects_get failed: ${e.message}`);
            }
        }

        // Fallback for fields the server did not provide: read the bank's
        // built-in `reverbMix` (other fields use hardcoded defaults from
        // the schema).
        const banks = (typeof MidiSynthesizer !== 'undefined' && MidiSynthesizer.getAvailableBanks)
            ? MidiSynthesizer.getAvailableBanks() : [];
        const bank = banks.find(b => b.id === bankId);
        const defaults = {
            reverb_mix: bank?.reverbMix ?? 0.12,
            reverb_decay_s: 1.2,
            echo_mix: 0.0,
            echo_time_ms: 250,
            echo_feedback: 0.3
        };
        const current = { ...defaults, ...(effects || {}) };

        for (const cfg of SLIDERS) {
            const input = this.modal.querySelector('#' + cfg.id);
            const valueSpan = this.modal.querySelector('#' + cfg.id + 'Value');
            if (!input) continue;
            const ui = cfg.toUi(current[cfg.field]);
            input.value = ui;
            if (valueSpan) valueSpan.textContent = cfg.format(ui);
        }

        // Push the resolved set to every live synth — this is the
        // single point where the slider UI becomes authoritative for
        // the audio graph.
        if (typeof MidiSynthesizer !== 'undefined'
            && typeof MidiSynthesizer.broadcastBankEffects === 'function') {
            MidiSynthesizer.broadcastBankEffects(effects || null);
        }
    };

    /**
     * Wire up slider `input` events. Each change:
     *  1. updates the label with the new value,
     *  2. debounces a `bank_effects_update` WS call (150 ms),
     *  3. immediately applies the new values to every live synth so
     *     the audio feedback is instantaneous.
     */
    SettingsBankEffects.attachBankEffectsListeners = function() {
        if (!this.modal) return;

        // Local debounce timer shared across sliders.
        let debounceTimer = null;

        const pushUpdate = async () => {
            const api = _api();
            if (!api || typeof api.sendCommand !== 'function') return;
            const bankId = _currentBankId(this);

            const payload = { bankId };
            const dbView = {};
            for (const cfg of SLIDERS) {
                const input = this.modal.querySelector('#' + cfg.id);
                if (!input) continue;
                const dbVal = cfg.fromUi(input.value);
                payload[cfg.field] = dbVal;
                dbView[cfg.field] = dbVal;
            }

            try {
                await api.sendCommand('bank_effects_update', payload);
            } catch (e) {
                this.logger?.warn(`bank_effects_update failed: ${e.message}`);
            }
        };

        const onInput = (cfg, input) => {
            const raw = input.value;
            const valueSpan = this.modal.querySelector('#' + cfg.id + 'Value');
            if (valueSpan) valueSpan.textContent = cfg.format(raw);

            // Immediate audio update — don't wait for the server round-trip.
            const snapshot = {};
            for (const c of SLIDERS) {
                const el = this.modal.querySelector('#' + c.id);
                if (el) snapshot[c.field] = c.fromUi(el.value);
            }
            if (typeof MidiSynthesizer !== 'undefined'
                && typeof MidiSynthesizer.broadcastBankEffects === 'function') {
                MidiSynthesizer.broadcastBankEffects(snapshot);
            }

            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(pushUpdate, DEBOUNCE_MS);
        };

        for (const cfg of SLIDERS) {
            const input = this.modal.querySelector('#' + cfg.id);
            if (!input) continue;
            input.addEventListener('input', () => onInput(cfg, input));
        }

        const resetBtn = this.modal.querySelector('#bankEffectsReset');
        if (resetBtn) {
            resetBtn.addEventListener('click', async () => {
                const api = _api();
                const bankId = _currentBankId(this);
                if (api && typeof api.sendCommand === 'function') {
                    try {
                        await api.sendCommand('bank_effects_reset', { bankId });
                    } catch (e) {
                        this.logger?.warn(`bank_effects_reset failed: ${e.message}`);
                    }
                }
                await this.hydrateBankEffects();
            });
        }
    };

    if (typeof window !== 'undefined') {
        window.SettingsBankEffects = SettingsBankEffects;
    }
})();
