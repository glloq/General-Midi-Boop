// ============================================================================
// File: public/js/features/LoopManagerArrangerOps.js
// Description: Arranger CRUD + tempo/bars + playback + drag handlers +
//   auto-save. Extracted from LoopManagerArrangerFeature per audit §1.3
//   (god-class split).
//
// Owns:
//   - Track / block CRUD: _addTrack, _deleteTrack, _addBlock,
//     _moveBlock, _changeReps, _deleteBlock.
//   - Arrangement CRUD: _saveArrangement, _deleteArrangement,
//     _duplicateArrangement.
//   - Tempo / bars adjustments: _adjustArrTempo, _adjustArrBars.
//   - Playback engine: _playArrangement, _scheduleCountIn,
//     _stopArrangerPlay, _startPlaybarRAF, _stopPlaybarRAF,
//     _renderArrangerPlayhead.
//   - Drag handlers / auto-save: _onDocMouseMove, _onDocMouseUp,
//     _scheduleAutoSave.
//
// Accessed via `arrangerFeature.ops`. LoopManagerArrangerFeature keeps
// thin delegates so external callers (LoopCreatorModal one-liners) are
// unchanged.
// ============================================================================

(function () {
    'use strict';

    class LoopManagerArrangerOps {
        /** @param {LoopManagerArrangerFeature} parent */
        constructor(parent) {
            this.parent = parent;
            this.modal = parent.modal;
        }

    async _addTrack() {
        if (!this.parent.modal.currentArrangementId) return;
        const label = `Track ${this.parent.modal.tracks.length + 1}`;
        try {
            const r = await this.parent.modal.api.sendCommand('arrangement_add_track', {
                arrangementId: this.parent.modal.currentArrangementId,
                label
            });
            this.parent.modal.tracks.push({
                id: r.trackId,
                arrangement_id: this.parent.modal.currentArrangementId,
                track_index: this.parent.modal.tracks.length,
                label,
                midi_channel: 1
            });
            this.parent._renderTimeline();
            this.parent._pushArrHistory();
        } catch (err) {
            LoopUtils.handleError(err, 'arr.track.add', {
                toast: this.parent.modal.t('loopManager.errSave')
            });
        }
    }

    async _deleteTrack(trackId) {
        try {
            await this.parent.modal.api.sendCommand('arrangement_delete_track', { trackId });
            this.parent.modal.tracks = this.parent.modal.tracks.filter(t => t.id !== trackId);
            this.parent.modal.blocks = this.parent.modal.blocks.filter(b => b.track_id !== trackId);
            this.parent._renderTimeline();
            this.parent._pushArrHistory();
        } catch (err) {
            LoopUtils.handleError(err, 'arr.track.delete', {
                toast: this.parent.modal.t('loopManager.errSave')
            });
        }
    }

    async _addBlock(trackId, loopId, positionBar, loopBars) {
        try {
            const r = await this.parent.modal.api.sendCommand('arrangement_add_block', {
                trackId, loopId, position_bar: positionBar, repetitions: 1
            });
            const loop = this.parent.modal.library.find(l => l.id === loopId);
            this.parent.modal.blocks.push({
                id: r.blockId, track_id: trackId, loop_id: loopId,
                position_bar: positionBar, repetitions: 1,
                loop_name: loop?.name || '?', loop_bars: loop?.bars || loopBars
            });
            this.parent._renderTimeline();
            this.parent._pushArrHistory();
        } catch (err) {
            LoopUtils.handleError(err, 'arr.block.add', {
                toast: this.parent.modal.t('loopManager.errSave')
            });
        }
    }

    async _moveBlock(blockId, newTrackId, newPositionBar) {
        const block = this.parent.modal.blocks.find(b => b.id === blockId);
        if (!block) return;
        if (block.track_id === newTrackId && block.position_bar === newPositionBar) return;
        try {
            await this.parent.modal.api.sendCommand('arrangement_update_block', {
                blockId,
                track_id: newTrackId,
                position_bar: newPositionBar
            });
            block.track_id     = newTrackId;
            block.position_bar = newPositionBar;
            this.parent._renderTimeline();
            this.parent._pushArrHistory();
        } catch (err) {
            LoopUtils.handleError(err, 'arr.block.move', {
                toast: this.parent.modal.t('loopManager.errSave')
            });
        }
    }

    async _changeReps(blockId, delta) {
        const block = this.parent.modal.blocks.find(b => b.id === blockId);
        if (!block) return;
        const newReps = Math.max(1, block.repetitions + delta);
        try {
            await this.parent.modal.api.sendCommand('arrangement_update_block', { blockId, repetitions: newReps });
            block.repetitions = newReps;
            this.parent._renderTimeline();
            this.parent._pushArrHistory();
        } catch (err) {
            LoopUtils.handleError(err, 'arr.block.update', {
                toast: this.parent.modal.t('loopManager.errSave')
            });
        }
    }

    async _deleteBlock(blockId) {
        try {
            await this.parent.modal.api.sendCommand('arrangement_delete_block', { blockId });
            this.parent.modal.blocks = this.parent.modal.blocks.filter(b => b.id !== blockId);
            this.parent.modal._selectedBlocks.delete(blockId);
            this.parent._renderTimeline();
            this.parent._pushArrHistory();
        } catch (err) {
            LoopUtils.handleError(err, 'arr.block.delete', {
                toast: this.parent.modal.t('loopManager.errSave')
            });
        }
    }

    async _saveArrangement({ silent = false } = {}) {
        this.parent.modal.arrangementName = this.parent.modal.$('#la-name-input')?.value?.trim() || this.parent.modal.t('loopCreator.untitledArrangement');
        const tempo = LoopUtils.validate.tempo(this.parent.modal.$('#la-tempo')?.value, this.parent.modal.arrangementTempo);
        const bars  = LoopUtils.validate.arrBars(this.parent.modal.$('#la-bars')?.value, this.parent.modal.arrangementBars);
        try {
            if (this.parent.modal.currentArrangementId) {
                await this.parent.modal.api.sendCommand('arrangement_update', {
                    arrangementId: this.parent.modal.currentArrangementId,
                    name: this.parent.modal.arrangementName, global_tempo: tempo, total_bars: bars
                });
                await this.parent._loadArrangements();
                this.parent._markArrDirty(false);
                if (!silent) LoopUtils.toast(this.parent.modal.t('loopCreator.statusSaved'), 'success');
            }
        } catch (err) {
            LoopUtils.handleError(err, 'arr.save', {
                toast: `${this.parent.modal.t('loopCreator.statusError')}: ${err.message}`
            });
        }
    }

    async _deleteArrangement(id) {
        try {
            await this.parent.modal.api.sendCommand('arrangement_delete', { arrangementId: id });
            if (this.parent.modal.currentArrangementId === id) await this.parent._newArrangement();
            await this.parent._loadArrangements();
        } catch (err) {
            LoopUtils.handleError(err, 'arr.delete', {
                toast: this.parent.modal.t('loopManager.errSave')
            });
        }
    }

    async _duplicateArrangement(sourceId) {
        if (this.parent.modal._arrDirty && !confirm(this.parent.modal.t('loopManager.confirmSwitchArrangement'))) return;
        try {
            const r = await this.parent.modal.api.sendCommand('arrangement_get', { arrangementId: sourceId });
            const { arrangement, tracks, blocks } = r;
            const create = await this.parent.modal.api.sendCommand('arrangement_create', {
                name: this.parent.modal.t('loopManager.copySuffix', { name: arrangement.name }),
                global_tempo: arrangement.global_tempo,
                total_bars:   arrangement.total_bars
            });
            const newId = create.arrangementId;
            // _create auto-adds 3 default tracks — remove them first
            const created = await this.parent.modal.api.sendCommand('arrangement_get', { arrangementId: newId });
            for (const t of created.tracks) {
                await this.parent.modal.api.sendCommand('arrangement_delete_track', { trackId: t.id });
            }
            // Recreate source tracks (keeping order) and remember the id mapping
            const trackIdMap = new Map();
            for (let i = 0; i < tracks.length; i++) {
                const src = tracks[i];
                const tr = await this.parent.modal.api.sendCommand('arrangement_add_track', {
                    arrangementId: newId,
                    label: src.label,
                    midi_channel: src.midi_channel,
                    track_index: i
                });
                trackIdMap.set(src.id, tr.trackId);
            }
            // Recreate blocks
            for (const b of blocks) {
                const newTrackId = trackIdMap.get(b.track_id);
                if (!newTrackId) continue;
                await this.parent.modal.api.sendCommand('arrangement_add_block', {
                    trackId: newTrackId,
                    loopId:  b.loop_id,
                    position_bar: b.position_bar,
                    repetitions: b.repetitions
                });
            }
            await this.parent._loadArrangementById(newId);
            LoopUtils.toast?.(this.parent.modal.t('loopManager.arrangementDuplicated'), 'success');
        } catch (err) {
            LoopUtils.handleError(err, 'arr.duplicate', {
                toast: this.parent.modal.t('loopManager.errDuplicateArrangement')
            });
        }
    }

    _adjustArrTempo(d) {
        const prev = this.parent.modal.arrangementTempo;
        this.parent.modal.arrangementTempo = LoopUtils.validate.tempo(prev + d, prev);
        const el = this.parent.modal.$('#la-tempo'); if (el) el.value = this.parent.modal.arrangementTempo;
        if (this.parent.modal.arrangementTempo !== prev) {
            this.parent._markArrDirty(true);
            this._scheduleAutoSave();
        }
    }

    _adjustArrBars(d) {
        const prev = this.parent.modal.arrangementBars;
        this.parent.modal.arrangementBars = LoopUtils.validate.arrBars(prev + d, prev);
        const el = this.parent.modal.$('#la-bars'); if (el) el.value = this.parent.modal.arrangementBars;
        if (this.parent.modal.arrangementBars !== prev) {
            this.parent._renderTimeline();
            this.parent._pushArrHistory();
            this._scheduleAutoSave();
        }
    }

    // =========================================================
    // ARRANGER — PLAYBACK
    // =========================================================

    async _playArrangement(startBar = 0) {
        if (!this.parent.modal.currentArrangementId || this.parent.modal.isArrangerPlaying) return;
        this._stopArrangerPlay();
        this.parent.modal.isArrangerPlaying = true;
        this.parent.modal.$('#la-play-btn')?.classList.add('lc-btn-record--active');

        const secPerBar  = 60 / this.parent.modal.arrangementTempo * 4;
        this.parent.modal._arrangerStartBar = Math.max(0, Math.min(this.parent.modal.arrangementBars - 1, startBar | 0));
        const startSec   = this.parent.modal._arrangerStartBar * secPerBar;
        const totalSec   = this.parent.modal.arrangementBars * secPerBar;
        const events = [];
        const programsToLoad = new Set([0]);

        for (const block of this.parent.modal.blocks) {
            if (!this.parent._isTrackAudible(block.track_id)) continue;
            const loopData = await this.parent.modal._fetchLoopData(block.loop_id);
            if (!loopData) continue;
            const prog      = loopData.instrument_program ?? 0;
            programsToLoad.add(prog);
            const seq       = LoopUtils.parseSequence(loopData.midi_data);
            const loopTempo = loopData.tempo || 120;
            const loopPPQ   = loopData.ppq   || 480;
            const spt       = 60 / (loopTempo * loopPPQ);
            const loopDurSec = loopData.bars * (60 / loopTempo) * 4;
            for (let rep = 0; rep < block.repetitions; rep++) {
                const offsetSec = block.position_bar * secPerBar + rep * loopDurSec;
                for (const note of seq) {
                    const evSec = offsetSec + note.t * spt;
                    if (evSec < startSec || evSec >= totalSec) continue;
                    events.push({
                        sec: evSec - startSec,
                        note: note.n, vel: note.v || 80,
                        durSec: (note.g || note.l || 120) * spt,
                        prog,
                        trackId: block.track_id
                    });
                }
            }
        }

        // Garde-fou : on ne peut router que 16 programmes distincts (canaux
        // MIDI 0-15). Au-delà, l'ancien code faisait `chIdx++ % 16` et
        // écrasait silencieusement les premiers canaux → instruments
        // sortaient avec le mauvais son (AUDIT §L4). Mieux vaut refuser
        // explicitement la lecture que la fausser.
        const MAX_DISTINCT_PROGRAMS = 16;
        if (programsToLoad.size > MAX_DISTINCT_PROGRAMS) {
            LoopUtils.toast(
                this.parent.modal.t('loopManager.errTooManyPrograms', { max: MAX_DISTINCT_PROGRAMS, count: programsToLoad.size })
                    || `Arrangement uses ${programsToLoad.size} distinct programs (max ${MAX_DISTINCT_PROGRAMS}). Playback cancelled.`,
                'error'
            );
            this.parent.modal.isArrangerPlaying = false;
            this.parent.modal.$('#la-play-btn')?.classList.remove('lc-btn-record--active');
            return;
        }

        const target = this.parent.modal._getOutputTarget(this.parent.modal._arrangerSynth);

        // Preload all instruments used. Drum kits (prog ≥ 128) passent
        // par loadDrumKit() — loadInstrument() les traiterait comme un
        // programme mélodique et ne chargerait pas les samples de batterie.
        if (target) {
            for (const prog of programsToLoad) {
                if (prog >= 128) {
                    target.setChannelInstrument?.(9, prog);
                    await target.loadDrumKit?.().catch(err =>
                        LoopUtils.handleError(err, 'arr.synth.loadDrumKit'));
                } else if (!target.loadedInstruments?.has(prog)) {
                    await target.loadInstrument(prog).catch(err =>
                        LoopUtils.handleError(err, 'arr.synth.loadInstrument'));
                }
            }
        }

        // Allocate channels: tracks with a custom midi_channel keep theirs;
        // remaining programs auto-assign onto the rest.
        const trackChMap = new Map();   // trackId → channel
        const usedCh     = new Set();
        for (const t of this.parent.modal.tracks) {
            const ch = (t.midi_channel ?? 0);
            if (ch > 0 && ch <= 16 && !usedCh.has(ch - 1)) {
                trackChMap.set(t.id, ch - 1);
                usedCh.add(ch - 1);
            }
        }
        // Second garde-fou (AUDIT §L4) : programmes + canaux pré-réservés
        // par les tracks ne doivent pas dépasser 16 au total. Le check
        // initial sur programsToLoad.size > 16 ne couvrait pas le cas où
        // des tracks revendiquent un midi_channel personnalisé (usedCh).
        if (programsToLoad.size + usedCh.size > 16) {
            LoopUtils.toast(
                this.parent.modal.t('loopManager.errTooManyPrograms', {
                    max: 16 - usedCh.size,
                    count: programsToLoad.size
                }) || `Arrangement needs ${programsToLoad.size + usedCh.size} MIDI channels (max 16). Playback cancelled.`,
                'error'
            );
            this.parent.modal.isArrangerPlaying = false;
            this.parent.modal.$('#la-play-btn')?.classList.remove('lc-btn-record--active');
            return;
        }
        // Drum programs (prog ≥ 128) sont épinglés sur le canal 9 (canal GM
        // drums) ; le synth ne reconnaît un kit que là. On réserve donc
        // le canal 9 avant d'auto-allouer les autres programmes pour éviter
        // qu'un instrument mélodique ne le récupère.
        const programChannelMap = new Map();
        const hasDrumProgram = [...programsToLoad].some(p => p >= 128);
        if (hasDrumProgram) usedCh.add(9);
        let chIdx = 0;
        const nextFreeCh = () => {
            while (chIdx < 16 && usedCh.has(chIdx)) chIdx++;
            const c = chIdx % 16;
            chIdx++;
            return c;
        };
        for (const prog of programsToLoad) {
            const ch = prog >= 128 ? 9 : nextFreeCh();
            programChannelMap.set(prog, ch);
            try { target?.setChannelInstrument?.(ch, prog); }
            catch (err) { LoopUtils.handleError(err, 'arr.synth.setChannelInstrument'); }
        }
        // Set per-track channel programs (channel hosts that track's loop progs)
        for (const [trackId, ch] of trackChMap) {
            // Use the first block on that track to determine which program to load
            const block = this.parent.modal.blocks.find(b => b.track_id === trackId);
            if (!block) continue;
            const loop = this.parent.modal.library.find(l => l.id === block.loop_id);
            const prog = loop?.instrument_program ?? 0;
            try { target?.setChannelInstrument?.(ch, prog); }
            catch (err) { LoopUtils.handleError(err, 'arr.synth.setChannelInstrument.track'); }
        }

        const scheduleEvents = (offsetMs) => {
            for (const ev of events) {
                // Drum events ignorent l'override midi_channel du track :
                // ils DOIVENT sortir sur le canal 9 pour que le synth les
                // route via drumPresets au lieu du chemin mélodique.
                const ch = ev.prog >= 128
                    ? 9
                    : (trackChMap.has(ev.trackId)
                        ? trackChMap.get(ev.trackId)
                        : (programChannelMap.get(ev.prog) ?? 0));
                this.parent.modal._arrangerTimers.push(setTimeout(() => {
                    if (!this.parent.modal.isArrangerPlaying) return;
                    try { target?.playNote?.(ev.note, ev.vel, ch, ev.durSec); }
                    catch (err) { LoopUtils.handleError(err, 'arr.synth.playNote'); }
                }, offsetMs + ev.sec * 1000));
            }
        };

        events.sort((a, b) => a.sec - b.sec);

        const countInMs = this.parent.modal._arrangerCountIn ? secPerBar * 1000 : 0;
        const playableMs = (totalSec - startSec) * 1000;

        if (this.parent.modal._arrangerCountIn) {
            this._scheduleCountIn(target, secPerBar);
            // Le count-in réécrit channel 9 avec le Woodblock (programme 115).
            // S'il y a un drum kit dans l'arrangement, on restaure son programme
            // juste avant que les notes drum ne démarrent, sinon le synth
            // utilisera kit 115 au lieu du kit choisi par l'utilisateur.
            if (hasDrumProgram) {
                const drumProg = [...programsToLoad].find(p => p >= 128);
                this.parent.modal._arrangerTimers.push(setTimeout(() => {
                    if (!this.parent.modal.isArrangerPlaying) return;
                    try { target?.setChannelInstrument?.(9, drumProg); }
                    catch (err) { LoopUtils.handleError(err, 'arr.restoreDrumProg'); }
                }, Math.max(0, countInMs - 5)));
            }
        }
        scheduleEvents(countInMs);

        if (this.parent.modal._arrangerLoop) {
            // Re-arm playback when the iteration completes (cooperative loop)
            this.parent.modal._arrangerTimers.push(setTimeout(() => {
                if (!this.parent.modal.isArrangerPlaying) return;
                this.parent.modal.isArrangerPlaying = false;
                this.parent.modal._arrangerTimers.forEach(t => clearTimeout(t));
                this.parent.modal._arrangerTimers = [];
                this._playArrangement(0);
            }, countInMs + playableMs));
        } else {
            this.parent.modal._arrangerTimers.push(setTimeout(() => this._stopArrangerPlay(), countInMs + playableMs));
        }

        this.parent.modal._arrangerStartTime = performance.now() + countInMs;
        this._startPlaybarRAF();
    }

    _scheduleCountIn(target, secPerBar) {
        // 4 clicks (a beat) using GM Woodblock (program 115) on channel 9
        const ch = 9;
        try { target?.setChannelInstrument?.(ch, 115); }
        catch (err) { LoopUtils.handleError(err, 'arr.countIn.setProgram'); }
        const beatMs = (secPerBar / 4) * 1000;
        for (let i = 0; i < 4; i++) {
            this.parent.modal._arrangerTimers.push(setTimeout(() => {
                if (!this.parent.modal.isArrangerPlaying) return;
                try { target?.playNote?.(76, 100, ch, 0.08); }
                catch (err) { LoopUtils.handleError(err, 'arr.countIn.playNote'); }
            }, i * beatMs));
        }
    }

    _stopArrangerPlay() {
        this.parent.modal._arrangerTimers.forEach(t => clearTimeout(t));
        this.parent.modal._arrangerTimers = [];
        this.parent.modal.isArrangerPlaying = false;
        this.parent.modal.$('#la-play-btn')?.classList.remove('lc-btn-record--active');
        try { this.parent.modal._arrangerSynth?.cancelAllNotes?.(); }
        catch (err) { LoopUtils.handleError(err, 'arr.synth.cancelAllNotes'); }
        try { this.parent.modal._deviceShim?.cancelAllNotes?.(); }
        catch (err) { LoopUtils.handleError(err, 'arr.device.cancelAllNotes'); }
        this._stopPlaybarRAF();
        this.parent.modal._renderPlaybar();
        this.parent._renderArrangerStartMarker();
    }

    // =========================================================
    // PLAYBACK TIMELINE BAR
    // =========================================================

    _startPlaybarRAF() {
        if (this.parent.modal._playbarRAF) return;
        const tick = () => {
            this.parent.modal._renderPlaybar();
            if (this.parent.modal.isArrangerPlaying) {
                this.parent.modal._playbarRAF = requestAnimationFrame(tick);
            } else {
                this.parent.modal._playbarRAF = null;
            }
        };
        this.parent.modal._playbarRAF = requestAnimationFrame(tick);
    }

    _stopPlaybarRAF() {
        if (this.parent.modal._playbarRAF) { cancelAnimationFrame(this.parent.modal._playbarRAF); this.parent.modal._playbarRAF = null; }
    }

    _renderArrangerPlayhead(elapsedSec) {
        const ph = this.parent.modal.$('#la-playhead');
        if (!ph) return;
        if (elapsedSec == null || !this.parent.modal.isArrangerPlaying) {
            ph.style.display = 'none';
            return;
        }
        const BAR_W = this.parent._barWidth();
        const secPerBar = 60 / this.parent.modal.arrangementTempo * 4;
        const bar = Math.min(this.parent.modal.arrangementBars, this.parent.modal._arrangerStartBar + elapsedSec / secPerBar);
        const labelW = this.parent.modal.$('.la-track-label')?.offsetWidth || 120;
        ph.style.display = 'block';
        ph.style.transform = `translateX(${labelW + bar * BAR_W}px)`;
    }


    _onDocMouseMove(e) {
        const r = this.parent.modal._resizeState;
        if (!r) return;
        // Recalcul à chaque move : barW peut avoir changé (resize fenêtre,
        // zoom changé via raccourci), et leftPx peut s'être décalé (scroll
        // horizontal du container). Le coût d'un getBoundingClientRect par
        // mousemove est négligeable comparé à un décalage de plusieurs
        // mesures pendant un drag (AUDIT §L3).
        const curRect = r.blockEl.getBoundingClientRect();
        const curBarW = this.parent._barWidth();
        if (curBarW > 0) r.barW = curBarW;
        r.leftPx = curRect.left;
        const widthPx     = Math.max(r.barW, e.clientX - r.leftPx);
        const newReps     = Math.max(1, Math.round(widthPx / (r.loopBars * r.barW)));
        if (newReps === r.newReps) return;
        r.newReps = newReps;
        const w = r.loopBars * newReps * r.barW;
        r.blockEl.style.width = w + 'px';
        const repsLabel = r.blockEl.querySelector('.la-block-reps');
        if (repsLabel) repsLabel.textContent = newReps;
        const nameLabel = r.blockEl.querySelector('.la-block-label');
        if (nameLabel) {
            const block = this.parent.modal.blocks.find(b => b.id === r.blockId);
            const overflow = block && (block.position_bar + r.loopBars * newReps > this.parent.modal.arrangementBars);
            r.blockEl.classList.toggle('la-block--overflow', !!overflow);
        }
        r.blockEl.dataset.wide = w >= 70 ? 'true' : 'false';
    }

    async _onDocMouseUp() {
        const r = this.parent.modal._resizeState;
        if (!r) return;
        this.parent.modal._resizeState = null;
        r.blockEl.classList.remove('la-block--resizing');
        if (r.newReps === r.origReps) return;
        try {
            await this.parent.modal.api.sendCommand('arrangement_update_block', {
                blockId: r.blockId, repetitions: r.newReps
            });
            const block = this.parent.modal.blocks.find(b => b.id === r.blockId);
            if (block) block.repetitions = r.newReps;
            this.parent._renderTimeline();
            this.parent._pushArrHistory();
        } catch (err) {
            LoopUtils.handleError(err, 'arr.block.resize', {
                toast: this.parent.modal.t('loopManager.errSave')
            });
            this.parent._renderTimeline();
        }
    }

    /**
     * Debounced background save (Arranger). Reads `_arrDirty` and
     * `currentArrangementId` from the modal — both live on the modal.
     */
    _scheduleAutoSave(delayMs = 800) {
        if (this.parent.modal._autoSaveTimer) clearTimeout(this.parent.modal._autoSaveTimer);
        this.parent.modal._autoSaveTimer = setTimeout(() => {
            this.parent.modal._autoSaveTimer = null;
            if (this.parent.modal._arrDirty && this.parent.modal.currentArrangementId) {
                this._saveArrangement({ silent: true });
            }
        }, delayMs);
    }
    }

    if (typeof window !== 'undefined') {
        window.LoopManagerArrangerOps = LoopManagerArrangerOps;
    }
})();
