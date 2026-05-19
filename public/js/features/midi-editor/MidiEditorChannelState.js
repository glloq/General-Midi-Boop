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
// This exposes a unified **read** facade accessed via `modal.channelState`.
// Writes still flow through their existing paths (mutating `modal.X`
// directly). Only the getters actually consumed by MidiEditorPlayback
// (effective program / sf2, audibility, routing) are kept here — speculative
// getters with no callers were removed. All getters are pure reads.
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

    // ----------------------------------------------------------------
    // Channel metadata
    // ----------------------------------------------------------------

    /** @returns {Object|null} the channel info record ({channel, program, instrument, …}) or null. */
    getInfo(channel) {
      return this.modal.channels?.find((ch) => ch.channel === channel) || null;
    }

    /** @returns {number} GM program (0-127) defined on the channel, or 0. */
    getProgram(channel) {
      return this.getInfo(channel)?.program ?? 0;
    }

    // ----------------------------------------------------------------
    // Routing
    // ----------------------------------------------------------------

    /** @returns {boolean} true if a routing target is set for the channel. */
    hasRouting(channel) {
      return this.modal.channelRouting?.has(channel) === true;
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

    /** @returns {number|null} per-instrument custom SF2 id of the routed
     *   instrument, if known. */
    getRoutedSf2Id(channel) {
      const sf2 = this.modal._routedSf2Ids?.get(channel);
      return sf2 != null ? sf2 : null;
    }

    /**
     * @returns {number|null} effective per-instrument custom SF2 id —
     *   only applied in 'routed' preview mode (mirrors
     *   getEffectiveProgram). In 'gm' mode the global bank is used.
     */
    getEffectiveSf2Id(channel) {
      if (this.modal.previewSource === 'routed') {
        return this.getRoutedSf2Id(channel);
      }
      return null;
    }

    // ----------------------------------------------------------------
    // Composite helpers
    // ----------------------------------------------------------------

    /**
     * @returns {boolean} true when audio for this channel will actually
     *   be heard — visible AND not disabled. Used by `syncMutedChannels`.
     */
    isAudible(channel) {
      return this.isActive(channel) && !this.isDisabled(channel);
    }
  }

  if (typeof window !== 'undefined') {
    window.MidiEditorChannelState = MidiEditorChannelState;
  }
})();
