// ============================================================================
// File: public/js/features/midi-editor/MidiEditorChannelState.js
// Description: Centralized **read** API for per-channel state — audit §4.2.
//
// Background. Channel state is spread across the MidiEditorModal as a dozen
// loose properties: `activeChannels`, `channelDisabled`, `channelColors`,
// `channelRouting`, `channelPlayableHighlights`, `_routedGmPrograms`,
// `_routedPlayableNotes`, `_channelTranspositions`, `_splitChannelNames`,
// `channels`. Sub-modules each reach in to read what they need, and the
// audit traced ≥10 latent desync bugs to ad-hoc reads + manual MAJ via
// `routingOps.updateChannelButtons()`, `tablatureOps._updateChipRouting()`,
// etc.
//
// This first pass exposes a unified **read** facade accessed via
// `modal.channelState`. Writes still flow through their existing paths
// (mutating `modal.X` directly) — this stays additive and zero-risk. A
// future pass will route writes through the facade and emit
// `channel:changed` events so subscribers stop polling.
//
// Migration pattern for consumers (do it lazily, not all at once):
//   - `this.modal.activeChannels.has(ch)` → `this.modal.channelState.isActive(ch)`
//   - `this.modal.channelDisabled.has(ch)` → `this.modal.channelState.isDisabled(ch)`
//   - `this.modal.channelRouting.get(ch)` → `this.modal.channelState.getRouting(ch)`
//   - `this.modal.channelColors[ch]` → `this.modal.channelState.getColor(ch)`
//   - …etc. See the API below.
//
// All getters are pure reads — they don't allocate beyond what the
// underlying Map/Set/Array already does, so call them as much as you like
// in hot paths.
// ============================================================================

(function () {
    'use strict';

    class MidiEditorChannelState {
        /** @param {MidiEditorModal} modal */
        constructor(modal) {
            this.modal = modal;
        }

        // ----------------------------------------------------------------
        // Visibility / mute / disabled flags
        // ----------------------------------------------------------------

        /** @returns {boolean} true if `channel` is shown in the piano roll. */
        isActive(channel) {
            return this.modal.activeChannels?.has(channel) === true;
        }

        /** @returns {boolean} true if `channel` is muted at the synth level. */
        isDisabled(channel) {
            return this.modal.channelDisabled?.has(channel) === true;
        }

        /** @returns {boolean} true if `channel` has a playable-notes highlight set. */
        isHighlighted(channel) {
            return this.modal.channelPlayableHighlights?.has(channel) === true;
        }

        /** @returns {number} count of currently visible channels. */
        getActiveCount() {
            return this.modal.activeChannels?.size ?? 0;
        }

        /** @returns {number[]} sorted list of visible channel indices. */
        getActiveList() {
            const set = this.modal.activeChannels;
            if (!set || set.size === 0) return [];
            return Array.from(set).sort((a, b) => a - b);
        }

        /** @returns {number[]} sorted list of muted channel indices. */
        getDisabledList() {
            const set = this.modal.channelDisabled;
            if (!set || set.size === 0) return [];
            return Array.from(set).sort((a, b) => a - b);
        }

        // ----------------------------------------------------------------
        // Channel metadata (color, info)
        // ----------------------------------------------------------------

        /** @returns {string} hex / rgb color for the channel, or '#888' fallback. */
        getColor(channel) {
            return this.modal.channelColors?.[channel] || '#888888';
        }

        /** @returns {Object|null} the channel info record ({channel, program, instrument, …}) or null. */
        getInfo(channel) {
            return this.modal.channels?.find(ch => ch.channel === channel) || null;
        }

        /** @returns {number} GM program (0-127) defined on the channel, or 0. */
        getProgram(channel) {
            return this.getInfo(channel)?.program ?? 0;
        }

        /** @returns {Object[]} every channel info record (file metadata). */
        getAllChannels() {
            return Array.isArray(this.modal.channels) ? this.modal.channels : [];
        }

        // ----------------------------------------------------------------
        // Routing
        // ----------------------------------------------------------------

        /** @returns {string|null} routing key (`deviceId` or `deviceId::channel`) or null. */
        getRouting(channel) {
            return this.modal.channelRouting?.get(channel) ?? null;
        }

        /** @returns {boolean} true if a routing target is set for the channel. */
        hasRouting(channel) {
            return this.modal.channelRouting?.has(channel) === true;
        }

        /**
         * Parse a routing key into `{deviceId, devChannel}`. Multi-instrument
         * devices route via `deviceId::devChannel`; mono devices via raw
         * `deviceId`. Returns `{deviceId: null, devChannel: undefined}` when
         * the channel has no routing.
         */
        parseRouting(channel) {
            const value = this.getRouting(channel);
            if (!value) return { deviceId: null, devChannel: undefined };
            if (value.includes('::')) {
                const [deviceId, devCh] = value.split('::');
                return { deviceId, devChannel: parseInt(devCh) };
            }
            return { deviceId: value, devChannel: undefined };
        }

        /** @returns {number|null} GM program of the routed instrument, if known. */
        getRoutedGmProgram(channel) {
            const gm = this.modal._routedGmPrograms?.get(channel);
            return gm != null ? gm : null;
        }

        /**
         * @returns {number} effective GM program — routed instrument program
         *   when a routing target exposes one, otherwise the channel's own
         *   program. This is what feedback / preview should use, matching
         *   the legacy logic in `MidiEditorPlayback.loadSequenceForPlayback`.
         */
        getEffectiveProgram(channel) {
            if (this.modal.previewSource === 'routed') {
                const routedGm = this.getRoutedGmProgram(channel);
                if (routedGm != null) return routedGm;
            }
            return this.getProgram(channel);
        }

        // ----------------------------------------------------------------
        // Playable-notes highlights (from `instrument_get_capabilities`)
        // ----------------------------------------------------------------

        /**
         * @returns {Set<number>|null} set of MIDI note numbers the routed
         *   device can play, or `null` when unrestricted (full 0-127 range
         *   or no capability data).
         */
        getPlayableNotes(channel) {
            const v = this.modal._routedPlayableNotes?.get(channel);
            return v === undefined ? null : v;
        }

        /**
         * @returns {Set<number>|null} the per-channel highlight set drawn on
         *   the piano-roll keyboard (a separate concept from
         *   `_routedPlayableNotes` — these are user-toggled highlights).
         */
        getHighlight(channel) {
            return this.modal.channelPlayableHighlights?.get(channel) ?? null;
        }

        // ----------------------------------------------------------------
        // Transposition / split-channel names
        // ----------------------------------------------------------------

        /** @returns {number} semitones transposition applied to the routed channel, 0 default. */
        getTransposition(channel) {
            return this.modal._channelTranspositions?.get(channel) ?? 0;
        }

        /**
         * @returns {string[]|null} instrument names when the channel was
         *   split across multiple routings, or `null` for single routings.
         */
        getSplitNames(channel) {
            return this.modal._splitChannelNames?.get(channel) ?? null;
        }

        // ----------------------------------------------------------------
        // Composite helpers (most-asked combinations)
        // ----------------------------------------------------------------

        /**
         * @returns {boolean} true when audio for this channel will actually
         *   be heard — visible AND not disabled. Used by `syncMutedChannels`.
         */
        isAudible(channel) {
            return this.isActive(channel) && !this.isDisabled(channel);
        }

        /**
         * @returns {boolean} true when the channel is currently the only one
         *   active (used by per-channel CC editor logic, tablature single-
         *   channel constraint, etc.).
         */
        isSoloActive(channel) {
            const active = this.modal.activeChannels;
            return !!active && active.size === 1 && active.has(channel);
        }

        /**
         * @returns {number|null} the lone active channel index when exactly
         *   one channel is visible, else null.
         */
        getSoloChannel() {
            const active = this.modal.activeChannels;
            if (!active || active.size !== 1) return null;
            return Array.from(active)[0];
        }
    }

    if (typeof window !== 'undefined') {
        window.MidiEditorChannelState = MidiEditorChannelState;
    }
})();
