// ============================================================================
// File: public/js/features/midi-editor/MidiEditorPlayableNotes.js
// Description: "Playable notes" + "routed GM programs" caches and toggles —
//   extracted from MidiEditorRouting per audit §1.3 (god-class split).
//
// Owns:
//   - previewSource toggle (gm ↔ routed)
//   - per-channel playable note ranges fetched from
//     `instrument_get_capabilities` (cached on modal._routedPlayableNotes)
//   - global "show playable highlights" toggle
//   - per-channel routed GM program cache (modal._routedGmPrograms)
//
// State lives on the modal — this sub-feature is a method namespace
// accessed via `modal.routingOps.playableNotes`. Delegate methods on
// MidiEditorRouting preserve the existing public surface.
// ============================================================================

(function () {
    'use strict';

    class MidiEditorPlayableNotes {
        /** @param {MidiEditorRouting} parent */
        constructor(parent) {
            this.parent = parent;
            this.modal = parent.modal;
        }

        // ----------------------------------------------------------------
        // Preview source toggle (gm ↔ routed)
        // ----------------------------------------------------------------

        async togglePreviewSource() {
            const m = this.modal;
            const btn = m.container?.querySelector('#preview-source-toggle');
            if (m.previewSource === 'gm') {
                m.previewSource = 'routed';
                if (btn) { btn.dataset.source = 'routed'; btn.textContent = m.t('midiEditor.routedSource'); }
                // Fetch playable note ranges for all routed channels
                await this.loadRoutedPlayableNotes();
            } else {
                m.previewSource = 'gm';
                if (btn) { btn.dataset.source = 'gm'; btn.textContent = m.t('midiEditor.gmSource'); }
                m._routedPlayableNotes.clear();
            }
            if (m._playback) m._playback._feedbackInstrumentsLoaded = false;
            if (m.synthesizer) m.loadSequenceForPlayback();
            m.log('info', `Preview source switched to: ${m.previewSource}`);
        }

        // ----------------------------------------------------------------
        // Playable-notes range cache per routed channel
        // ----------------------------------------------------------------

        async loadRoutedPlayableNotes() {
            const m = this.modal;
            m._routedPlayableNotes.clear();
            const promises = [];
            for (const [channel, routedValue] of m.channelRouting) {
                promises.push((async () => {
                    let deviceId = routedValue;
                    let devChannel = undefined;
                    if (routedValue.includes('::')) {
                        const parts = routedValue.split('::');
                        deviceId = parts[0];
                        devChannel = parseInt(parts[1]);
                    }
                    try {
                        const params = { deviceId };
                        if (devChannel !== undefined) params.channel = devChannel;
                        const response = await m.api.sendCommand('instrument_get_capabilities', params);
                        if (response && response.capabilities) {
                            const caps = response.capabilities;
                            const mode = caps.note_selection_mode || 'range';
                            let notes = null;
                            if (mode === 'discrete' && caps.selected_notes && Array.isArray(caps.selected_notes)) {
                                notes = new Set(caps.selected_notes.map(n => parseInt(n)));
                            } else if (mode === 'range') {
                                const minNote = caps.note_range_min != null ? parseInt(caps.note_range_min) : 0;
                                const maxNote = caps.note_range_max != null ? parseInt(caps.note_range_max) : 127;
                                if (minNote !== 0 || maxNote !== 127) {
                                    notes = new Set();
                                    for (let n = minNote; n <= maxNote; n++) notes.add(n);
                                }
                            }
                            m._routedPlayableNotes.set(channel, notes);
                        }
                    } catch (err) {
                        m.log('warn', `Failed to fetch capabilities for routed channel ${channel}:`, err);
                    }
                })());
            }
            await Promise.all(promises);
        }

        // ----------------------------------------------------------------
        // Global "show playable highlights" toggle
        // ----------------------------------------------------------------

        async togglePlayableNotesGlobal() {
            const m = this.modal;
            m.showPlayableNotes = !m.showPlayableNotes;

            const btn = m.container?.querySelector('#playable-notes-toggle');
            if (btn) {
                btn.dataset.active = String(m.showPlayableNotes);
                const onLabel = m.t('midiEditor.playableOn');
                const offLabel = m.t('midiEditor.playableOff');
                const srLabel = btn.querySelector('.sr-only');
                if (srLabel) {
                    srLabel.textContent = m.showPlayableNotes ? onLabel : offLabel;
                } else {
                    btn.textContent = m.showPlayableNotes ? onLabel : offLabel;
                }
            }

            if (m.showPlayableNotes) {
                const promises = [];
                for (const [channel] of m.channelRouting) {
                    if (!m.channelPlayableHighlights.has(channel)) {
                        promises.push(m.tablatureOps._toggleChannelPlayableHighlight(channel));
                    }
                }
                await Promise.all(promises);
            } else {
                m.channelPlayableHighlights.clear();
                m.tablatureOps._syncPianoRollHighlights();
            }

            this.parent.updateChannelButtons();
            m.log('info', `Playable notes global: ${m.showPlayableNotes ? 'ON' : 'OFF'}`);
        }

        // ----------------------------------------------------------------
        // Routed GM program cache (used by tablature mode logic)
        // ----------------------------------------------------------------

        getRoutedGmProgram(channel) {
            const gm = this.modal._routedGmPrograms.get(channel);
            return gm != null ? gm : null;
        }

        async loadRoutedGmPrograms() {
            const m = this.modal;
            m._routedGmPrograms.clear();
            const promises = [];
            for (const [channel, routedValue] of m.channelRouting.entries()) {
                promises.push(this.fetchAndCacheRoutedGmProgram(channel, routedValue));
            }
            await Promise.all(promises);
        }

        async fetchAndCacheRoutedGmProgram(channel, routedValue) {
            const m = this.modal;
            if (!routedValue) {
                m._routedGmPrograms.delete(channel);
                return;
            }
            let deviceId = routedValue;
            let devChannel = undefined;
            if (routedValue.includes('::')) {
                const parts = routedValue.split('::');
                deviceId = parts[0];
                devChannel = parseInt(parts[1]);
            }
            try {
                const params = { deviceId };
                if (devChannel !== undefined) params.channel = devChannel;
                const response = await m.api.sendCommand('instrument_get_capabilities', params);
                if (response && response.capabilities && response.capabilities.gm_program != null) {
                    m._routedGmPrograms.set(channel, response.capabilities.gm_program);
                }
            } catch (err) {
                m.log('warn', `Failed to fetch gm_program for routed device ${deviceId}:`, err);
            }
        }
    }

    if (typeof window !== 'undefined') {
        window.MidiEditorPlayableNotes = MidiEditorPlayableNotes;
    }
})();
