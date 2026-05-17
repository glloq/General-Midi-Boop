/**
 * LoopManagerLiveFeature — Live tab of LoopManagerModal.
 *
 * Audit §6.6 — third slice of the LoopCreatorModal god-class.
 * Extracts the Live tab: GM-family-grouped loops, click to start/stop
 * a cycling loop, per-channel allocation, panic.
 *
 * Owns the per-tab state (`playingLoops` Map, `synth`, `search`),
 * the tab template, and the playback scheduling.
 *
 * Interface with the parent modal:
 *   reads  : modal.library, modal.api, modal.t(), modal.$(), modal.$$(),
 *            modal.escape(), modal._instrIconHtml(),
 *            modal._getOutputTarget(), modal._fetchLoopData(),
 *            modal._deviceShim, modal._renderPlaybar()
 *
 * Public methods (used by the modal):
 *   - renderTabHtml()                  — string; template
 *   - initSynth()                      — async; lazy-create the synth
 *   - renderArea()                     — re-render the grid
 *   - setSearch(value)                 — update search filter
 *   - trigger(loopId)                  — async; toggle play
 *   - stop(loopId)                     — stop one loop
 *   - stopAll()                        — stop all + panic
 *   - playingLoops (Map, readonly)     — used by Library cards
 *   - synth (readonly)                 — exposed for back-compat
 */
(function () {
    'use strict';

    class LoopManagerLiveFeature {
        /** @param {LoopManagerModal} modal */
        constructor(modal) {
            this.modal = modal;
            this.synth = null;
            this.playingLoops = new Map(); // loopId → { timers, ch, startMs, durMs }
            this.search = '';
        }

        setSearch(value) {
            this.search = value || '';
            this.renderArea();
        }

        async initSynth() {
            if (!this.synth) this.synth = await LoopUtils.createSynth();
        }

        renderTabHtml() {
            const t = this.modal.t.bind(this.modal);
            return `
            <div class="lc-pane${this.modal.activeTab==='live' ? '' : ' lc-pane--hidden'}" id="lc-pane-live" role="tabpanel" aria-labelledby="lc-tab-live">
                <div class="lc-ctrl-bar">
                    <input type="text" id="lm-live-search" class="lc-name-input lm-lib-search"
                        placeholder="${t('loopManager.search')}" value="${this.modal.escape(this.search)}" autocomplete="off" />
                    <span class="lc-ctrl-spacer"></span>
                    <button class="lc-btn lc-btn-sm" data-action="live-stop-all">⏹ ${t('loopManager.stopAll')}</button>
                </div>
                <div class="lm-live-area" id="lm-live-area">
                    <div class="lc-empty">${t('loopCreator.libraryEmpty')}</div>
                </div>
            </div>`;
        }

        renderArea() {
            const m = this.modal;
            const area = m.$('#lm-live-area');
            if (!area) return;
            if (!m.library.length) {
                area.innerHTML = `<div class="lc-empty">${m.t('loopCreator.libraryEmpty')}</div>`;
                return;
            }

            const q = this.search.trim().toLowerCase();
            const filtered = q
                ? m.library.filter(l => l.name.toLowerCase().includes(q))
                : m.library;

            if (!filtered.length) {
                area.innerHTML = `<div class="lc-empty">${m.t('loopCreator.libraryEmpty')}</div>`;
                return;
            }

            // Group loops by GM family
            const groups = new Map(); // familyName → { family, loops[] }
            for (const loop of filtered) {
                const family = LoopUtils.familyForProgram(loop.instrument_program ?? 0);
                if (!groups.has(family.name)) groups.set(family.name, { family, loops: [] });
                groups.get(family.name).loops.push(loop);
            }

            area.innerHTML = [...groups.values()].map(({ family, loops }) => `
            <div class="lm-live-group" style="--family-color:${family.color}">
                <div class="lm-live-group-header">
                    ${m._instrIconHtml(family.start, 'family', 'lm-live-group-icon')}
                    <span class="lm-live-group-name">${family.name}</span>
                </div>
                <div class="lm-live-loops">
                    ${loops.map(l => {
                        const playing    = this.playingLoops.has(l.id);
                        const tempoRange = l.tempo < 90 ? 'slow' : l.tempo < 140 ? 'medium' : 'fast';
                        // AUDIT §A9 : redonde l'info tempo en texte (le bord
                        // coloré seul violait WCAG 1.4.1 — color-only).
                        // aria-pressed expose l'état playing aux SR.
                        const tempoLabel = m.t('loopManager.tempoRange_' + tempoRange) || tempoRange;
                        return `<button class="lm-live-loop-btn${playing ? ' lm-live-loop-btn--playing' : ''}"
                            data-action="live-trigger" data-loop-id="${l.id}"
                            data-tempo-range="${tempoRange}"
                            aria-pressed="${playing}"
                            aria-label="${m.escape(l.name)} — ${l.tempo} BPM ${tempoLabel}, ${l.bars} ${m.t('loopCreator.barsUnit') || 'bars'}">
                            <span class="lm-live-loop-name">${m.escape(l.name)}</span>
                            <span class="lm-live-loop-meta">${l.tempo}♩·${l.bars}M</span>
                        </button>`;
                    }).join('')}
                </div>
            </div>`).join('');
        }

        async trigger(loopId) {
            const m = this.modal;
            if (this.playingLoops.has(loopId)) {
                this.stop(loopId);
                return;
            }
            const loopData = await m._fetchLoopData(loopId);
            if (!loopData) {
                LoopUtils.toast(m.t('loopManager.errLoopUnavailable'), 'error');
                return;
            }

            // Drum kits (program ≥ 128) DOIVENT sortir sur le canal 9, sinon
            // MidiSynthesizer.playNote() prend le path mélodique et la loop
            // reste silencieuse. Les autres loops se partagent les canaux
            // libres via _allocChannel().
            const prog = loopData.instrument_program ?? 0;
            const isDrum = prog >= 128;
            const ch = isDrum ? 9 : this._allocChannel();
            const target = m._getOutputTarget(this.synth);
            if (target) {
                try { target.setChannelInstrument(ch, prog); }
                catch (err) { LoopUtils.handleError(err, 'live.synth.setChannelInstrument'); }
                if (isDrum) {
                    await target.loadDrumKit?.().catch(err =>
                        LoopUtils.handleError(err, 'live.synth.loadDrumKit'));
                } else if (!target.loadedInstruments?.has(prog)) {
                    await target.loadInstrument(prog).catch(err =>
                        LoopUtils.handleError(err, 'live.synth.loadInstrument'));
                }
            }

            const loopDurMs = LoopUtils.loopDurationMs(loopData);
            this.playingLoops.set(loopId, { timers: [], ch, startMs: performance.now(), durMs: loopDurMs });
            this._updateButton(loopId, true);
            this._scheduleLoop(loopId, loopData);
            m._renderPlaybar();
        }

        _scheduleLoop(loopId, loopData) {
            const m = this.modal;
            if (!this.playingLoops.has(loopId)) return;
            const state = this.playingLoops.get(loopId);
            const ch    = state.ch ?? 0;

            // Cache the parsed sequence on loopData, keyed on the raw
            // midi_data source. _scheduleLoop recurses every cycle via
            // onCycleEnd, so without this a 4-bar loop re-runs JSON.parse
            // every ~8s for its whole lifetime. The source key auto-
            // invalidates the cache if the loop is edited mid-playback.
            let seq;
            if (loopData._seqCache && loopData._seqCacheSrc === loopData.midi_data) {
                seq = loopData._seqCache;
            } else {
                seq = LoopUtils.parseSequence(loopData.midi_data);
                loopData._seqCache = seq;
                loopData._seqCacheSrc = loopData.midi_data;
            }
            const loopDurMs = LoopUtils.loopDurationMs(loopData);

            // Reset cycle start time and clear old timers
            state.timers.forEach(t => clearTimeout(t));
            state.startMs = performance.now();
            state.durMs   = loopDurMs;

            const isAlive = () => this.playingLoops.has(loopId);
            state.timers = LoopUtils.scheduleSequence({
                synth: m._getOutputTarget(this.synth),
                sequence: seq,
                tempo: loopData.tempo || 120,
                ppq:   loopData.ppq   || 480,
                channel: ch,
                isAlive,
                cycleMs: loopDurMs,
                onCycleEnd: () => { if (isAlive()) this._scheduleLoop(loopId, loopData); }
            });
        }

        stop(loopId) {
            const m = this.modal;
            const state = this.playingLoops.get(loopId);
            if (!state) return;
            state.timers.forEach(t => clearTimeout(t));
            this.playingLoops.delete(loopId);
            // Coupe les notes encore tenues sur le canal du loop. Sans ça,
            // les note-on déjà émis continuent à sonner jusqu'à leur fin
            // naturelle ; l'utilisateur perçoit un release au lieu d'un
            // silence net (AUDIT §L7).
            const target = m._getOutputTarget(this.synth);
            if (target && state.ch != null) {
                try { target.allNotesOff?.(state.ch); }
                catch (err) { LoopUtils.handleError(err, 'live.allNotesOff'); }
                // Fallback synthé : si allNotesOff par canal n'existe pas,
                // cancelAllNotes coupe tout sur ce target.
                if (typeof target.allNotesOff !== 'function') {
                    try { target.cancelAllNotes?.(); }
                    catch (err) { LoopUtils.handleError(err, 'live.cancelAllNotes'); }
                }
            }
            this._updateButton(loopId, false);
            m._renderPlaybar();
        }

        stopAll() {
            const m = this.modal;
            for (const loopId of [...this.playingLoops.keys()]) this.stop(loopId);
            try { this.synth?.cancelAllNotes?.(); }
            catch (err) { LoopUtils.handleError(err, 'live.synth.cancelAllNotes'); }
            try { m._deviceShim?.cancelAllNotes?.(); }
            catch (err) { LoopUtils.handleError(err, 'live.device.cancelAllNotes'); }
        }

        _updateButton(loopId, playing) {
            const buttons = this.modal.$$(`[data-action="live-trigger"][data-loop-id="${loopId}"]`);
            buttons.forEach(btn => {
                btn.classList.toggle('lm-live-loop-btn--playing', playing);
                if (btn.classList.contains('lc-card-btn--play')) {
                    btn.classList.toggle('lc-card-btn--playing', playing);
                    btn.textContent = playing ? '⏹' : '▶';
                }
            });
        }

        _allocChannel() {
            const used = new Set([...this.playingLoops.values()].map(s => s.ch).filter(c => c != null));
            for (let c = 0; c < 16; c++) {
                if (!used.has(c)) return c;
            }
            return 0; // all 16 channels in use: wrap around
        }
    }

    if (typeof window !== 'undefined') {
        window.LoopManagerLiveFeature = LoopManagerLiveFeature;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = LoopManagerLiveFeature;
    }
})();
