// public/js/views/components/midi-editor/MidiEditorCCPanelAnalysis.js
// Pure CC-data analysis helpers extracted from MidiEditorCCPanel.js (P2-F.6b).
// Operate on the raw `ccEvents` array and `fullSequence` from the modal —
// no DOM access, no side effects.
// Exposed on `window.MidiEditorCCPanelAnalysis` (IIFE+globals convention).

(function() {
  'use strict';

  /**
   * Set of CC types used on a specific channel. Includes 'velocity' when any
   * note of the `fullSequence` belongs to that channel.
   */
  function getUsedCCTypesForChannel({ channel, ccEvents, fullSequence }) {
    const usedTypes = new Set();
    (ccEvents || []).forEach(event => {
      if (event.channel === channel) usedTypes.add(event.type);
    });
    if (fullSequence && fullSequence.some(note => note.c === channel)) {
      usedTypes.add('velocity');
    }
    return usedTypes;
  }

  /**
   * Set of CC types used anywhere in the file. Includes 'velocity' when any
   * note exists in `fullSequence`.
   */
  function getAllUsedCCTypes({ ccEvents, fullSequence }) {
    const allTypes = new Set();
    (ccEvents || []).forEach(event => allTypes.add(event.type));
    if (fullSequence && fullSequence.length > 0) allTypes.add('velocity');
    return allTypes;
  }

  /**
   * Sorted array of channels having any CC/pitchbend event.
   */
  function getAllCCChannels(ccEvents) {
    const channels = new Set();
    (ccEvents || []).forEach(event => {
      if (event.channel !== undefined) channels.add(event.channel);
    });
    return Array.from(channels).sort((a, b) => a - b);
  }

  /**
   * Sorted array of channels having at least one event of `ccType`.
   */
  function getCCChannelsUsed({ ccEvents, ccType }) {
    const channels = new Set();
    (ccEvents || []).forEach(event => {
      if (event.type === ccType && event.channel !== undefined) {
        channels.add(event.channel);
      }
    });
    return Array.from(channels).sort((a, b) => a - b);
  }

  window.MidiEditorCCPanelAnalysis = Object.freeze({
    getUsedCCTypesForChannel,
    getAllUsedCCTypes,
    getAllCCChannels,
    getCCChannelsUsed
  });
})();
