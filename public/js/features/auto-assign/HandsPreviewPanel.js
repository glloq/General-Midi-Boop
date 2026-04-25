/**
 * @file HandsPreviewPanel.js
 * @description Orchestrator for the per-channel hand-position
 * preview embedded in the RoutingSummaryPage detail panel
 * (Feature E). Picks the right layout (keyboard / fretboard) based
 * on the routed instrument's hands_config mode, instantiates the
 * right widgets, and wires the HandSimulationEngine events to them.
 *
 * Public API:
 *   const panel = new HandsPreviewPanel(container, {
 *     channel,           // number, source MIDI channel
 *     notes,             // [{tick, note, fret?, string?, channel?}]
 *     instrument,        // {hands_config, scale_length_mm?, …}
 *     ticksPerBeat,      // from midiData.header
 *     bpm,               // float
 *     overrides,         // optional starter overrides (E.6.1 shape)
 *     onSeek,            // optional callback when minimap or play
 *                        //   advances the playhead — the parent
 *                        //   page can mirror the position into its
 *                        //   own minimap.
 *   });
 *   panel.play();  panel.pause();  panel.reset();
 *   panel.setOverrides(o);
 *   panel.destroy();
 */
(function() {
    'use strict';

    function _resolveMode(instrument) {
        let cfg = instrument?.hands_config;
        if (typeof cfg === 'string') {
            try { cfg = JSON.parse(cfg); } catch (_) { cfg = null; }
        }
        if (!cfg || cfg.enabled === false) return 'unknown';
        return cfg.mode === 'frets' ? 'frets' : 'semitones';
    }

    function _hands(instrument) {
        let cfg = instrument?.hands_config;
        if (typeof cfg === 'string') {
            try { cfg = JSON.parse(cfg); } catch (_) { return []; }
        }
        return Array.isArray(cfg?.hands) ? cfg.hands : [];
    }

    /** Pick a colour per hand id — left=blue, right=green, fretting=amber. */
    function _handColor(id) {
        if (id === 'left') return '#3b82f6';
        if (id === 'right') return '#10b981';
        if (id === 'fretting') return '#f59e0b';
        return '#6b7280';
    }

    function _t(key, fallback) {
        if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.t === 'function') {
            const v = window.i18n.t(key);
            if (v && v !== key) return v;
        }
        return fallback;
    }

    class HandsPreviewPanel {
        constructor(container, opts = {}) {
            this.container = container;
            this.opts = opts;
            this.channel = Number.isFinite(opts.channel) ? opts.channel : 0;
            this.instrument = opts.instrument || null;
            this.notes = Array.isArray(opts.notes) ? opts.notes.slice() : [];
            this.ticksPerBeat = Number.isFinite(opts.ticksPerBeat) && opts.ticksPerBeat > 0 ? opts.ticksPerBeat : 480;
            this.bpm = Number.isFinite(opts.bpm) && opts.bpm > 0 ? opts.bpm : 120;
            this.overrides = opts.overrides || null;
            this.onSeek = opts.onSeek || null;

            this.mode = _resolveMode(this.instrument);
            this.engine = null;
            this.keyboard = null;
            this.lookahead = null;
            this.fretboard = null;
            this._currentHandWindows = new Map(); // handId → anchor

            this._render();
            this._wireEngine();
        }

        // -----------------------------------------------------------------
        //  Rendering
        // -----------------------------------------------------------------

        _render() {
            if (!this.container) return;
            this.container.innerHTML = '';
            this.container.classList.add('hands-preview-panel');

            const header = document.createElement('div');
            header.className = 'hpp-header';
            header.style.cssText = 'display:flex;gap:8px;align-items:center;padding:6px 8px;border-bottom:1px solid #e5e7eb;';
            header.innerHTML = `
                <strong style="font-size:13px;">${_t('handsPreview.title', 'Aperçu des mains')}</strong>
                <span style="flex:1;"></span>
                <button class="hpp-play"  type="button">${_t('handsPreview.play',  'Lecture')}</button>
                <button class="hpp-pause" type="button">${_t('handsPreview.pause', 'Pause')}</button>
                <button class="hpp-reset" type="button">${_t('handsPreview.reset', 'Rembobiner')}</button>
            `;
            this.container.appendChild(header);

            this._playBtn  = header.querySelector('.hpp-play');
            this._pauseBtn = header.querySelector('.hpp-pause');
            this._resetBtn = header.querySelector('.hpp-reset');
            this._playBtn.addEventListener('click',  () => this.play());
            this._pauseBtn.addEventListener('click', () => this.pause());
            this._resetBtn.addEventListener('click', () => this.reset());

            const body = document.createElement('div');
            body.className = 'hpp-body';
            body.style.cssText = 'padding:8px;';
            this.container.appendChild(body);

            if (this.mode === 'unknown') {
                body.innerHTML = `
                    <p style="color:#6b7280;font-size:12px;text-align:center;padding:16px;">
                        ${_t('handsPreview.noHandsConfig',
                             'Aucune configuration des mains pour cet instrument — la pré-visualisation est désactivée.')}
                    </p>
                `;
                return;
            }

            if (this.mode === 'semitones') {
                this._renderKeyboardLayout(body);
            } else {
                this._renderFretsLayout(body);
            }
        }

        _renderKeyboardLayout(body) {
            // 1. Look-ahead strip on top.
            const lookCanvas = document.createElement('canvas');
            lookCanvas.className = 'hpp-lookahead';
            lookCanvas.style.cssText = 'width:100%;height:60px;display:block;border:1px solid #e5e7eb;border-radius:4px;margin-bottom:6px;';
            body.appendChild(lookCanvas);

            // 2. Keyboard widget below.
            const kbCanvas = document.createElement('canvas');
            kbCanvas.className = 'hpp-keyboard';
            kbCanvas.style.cssText = 'width:100%;height:120px;display:block;border:1px solid #e5e7eb;border-radius:4px;';
            body.appendChild(kbCanvas);

            const rangeMin = Number.isFinite(this.instrument?.note_range_min) ? this.instrument.note_range_min : 21;
            const rangeMax = Number.isFinite(this.instrument?.note_range_max) ? this.instrument.note_range_max : 108;

            const ticksPerSecond = this.ticksPerBeat * (this.bpm / 60);
            this.lookahead = new window.HandsLookaheadStrip(lookCanvas, {
                notes: this.notes,
                ticksPerSecond,
                rangeMin, rangeMax,
                windowSeconds: 4
            });
            this.keyboard = new window.KeyboardPreview(kbCanvas, {
                rangeMin, rangeMax,
                bandHeight: 8,
                onKeyClick: (midi) => this._onKeyClick(midi)
            });
            // Initial paint with empty bands.
            this.keyboard.draw();
            this.lookahead.draw();
        }

        _renderFretsLayout(body) {
            const fbCanvas = document.createElement('canvas');
            fbCanvas.className = 'hpp-fretboard';
            fbCanvas.style.cssText = 'width:100%;height:200px;display:block;border:1px solid #e5e7eb;border-radius:4px;';
            body.appendChild(fbCanvas);

            const cfg = {
                tuning: this.instrument?.tuning || [40, 45, 50, 55, 59, 64],
                num_frets: this.instrument?.num_frets || 24,
                is_fretless: !!this.instrument?.is_fretless,
                capo_fret: this.instrument?.capo_fret || 0
            };
            this.fretboard = new window.FretboardDiagram(fbCanvas, cfg);
            // FretboardDiagram already supports setHandWindow + setActivePositions.
        }

        // -----------------------------------------------------------------
        //  Engine wiring
        // -----------------------------------------------------------------

        _wireEngine() {
            if (this.mode === 'unknown') return;
            if (!window.HandSimulationEngine) return;
            this.engine = new window.HandSimulationEngine({
                notes: this.notes,
                instrument: this.instrument,
                ticksPerBeat: this.ticksPerBeat,
                bpm: this.bpm,
                overrides: this.overrides
            });

            this.engine.on('shift', (e) => {
                const { handId, toAnchor } = e.detail;
                this._currentHandWindows.set(handId, toAnchor);
                this._refreshHandsView();
            });
            this.engine.on('chord', (e) => {
                const { notes, unplayable } = e.detail;
                if (this.keyboard) {
                    this.keyboard.setActiveNotes(notes.map(n => n.note));
                    this.keyboard.setUnplayableNotes(unplayable.map(u => ({ note: u.note, hand: u.handId })));
                }
                if (this.lookahead) {
                    this.lookahead.setUnplayableNotes(unplayable.map(u => u.note));
                }
                if (this.fretboard) {
                    this.fretboard.setActivePositions(notes
                        .filter(n => Number.isFinite(n.fret) && Number.isFinite(n.string))
                        .map(n => ({ string: n.string, fret: n.fret, velocity: n.velocity || 100 })));
                }
            });
            this.engine.on('tick', (e) => {
                if (this.lookahead) this.lookahead.setCurrentTime(e.detail.currentSec);
                if (typeof this.onSeek === 'function') {
                    this.onSeek(e.detail.currentTick, e.detail.totalTicks);
                }
            });
            this.engine.on('end', () => {
                if (this._playBtn) this._playBtn.disabled = false;
            });
        }

        _refreshHandsView() {
            const hands = _hands(this.instrument);
            if (this.mode === 'semitones' && this.keyboard) {
                const bands = hands.map(h => {
                    const anchor = this._currentHandWindows.get(h.id);
                    if (!Number.isFinite(anchor)) return null;
                    const span = h.hand_span_semitones ?? 14;
                    return { id: h.id, low: anchor, high: anchor + span, color: _handColor(h.id) };
                }).filter(Boolean);
                this.keyboard.setHandBands(bands);
            } else if (this.mode === 'frets' && this.fretboard) {
                const fretting = hands.find(h => h && h.id === 'fretting') || hands[0];
                const anchor = this._currentHandWindows.get(fretting?.id);
                if (Number.isFinite(anchor) && Number.isFinite(fretting?.hand_span_frets)) {
                    this.fretboard.setHandWindow({
                        anchorFret: anchor,
                        spanFrets: fretting.hand_span_frets,
                        level: 'ok'
                    });
                }
            }
        }

        _onKeyClick(midi) {
            // Hook for E.6.8 (edit mode). For now, just expose the
            // event via onSeek so the parent can react if it wants.
            if (typeof this.opts.onKeyClick === 'function') this.opts.onKeyClick(midi);
        }

        // -----------------------------------------------------------------
        //  Public play/pause/reset
        // -----------------------------------------------------------------

        play() {
            this.engine?.play();
        }
        pause() {
            this.engine?.pause();
        }
        reset() {
            this.engine?.reset();
            this._currentHandWindows.clear();
            if (this.keyboard) {
                this.keyboard.setActiveNotes([]);
                this.keyboard.setUnplayableNotes([]);
                this.keyboard.setHandBands([]);
            }
            if (this.lookahead) this.lookahead.setCurrentTime(0);
            if (this.fretboard) {
                this.fretboard.setActivePositions([]);
                this.fretboard.setHandWindow(null);
            }
        }

        seek(tick) {
            this.engine?.seek(tick);
        }

        setOverrides(overrides) {
            this.overrides = overrides || null;
            // Rebuild the engine so the new overrides take effect.
            const wasPlaying = this.engine?.isPlaying;
            this.engine?.dispose();
            this._wireEngine();
            if (wasPlaying) this.play();
        }

        destroy() {
            this.engine?.dispose();
            this.engine = null;
            if (this.keyboard) { this.keyboard.destroy(); this.keyboard = null; }
            if (this.lookahead) { this.lookahead.destroy(); this.lookahead = null; }
            if (this.fretboard) { this.fretboard.destroy?.(); this.fretboard = null; }
            if (this.container) this.container.innerHTML = '';
        }
    }

    if (typeof window !== 'undefined') {
        window.HandsPreviewPanel = HandsPreviewPanel;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = HandsPreviewPanel;
    }
})();
