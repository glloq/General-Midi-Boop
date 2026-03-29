// ============================================================================
// File: public/js/views/components/auto-assign/AutoAssignUtils.js
// Description: Utility methods for AutoAssignModal
//   Mixin: methods added to the prototype of AutoAssignModal
// ============================================================================

(function() {
    'use strict';

    const AutoAssignUtilsMixin = {};

    /**
     * Safely format info field (can be string or array)
     */
    AutoAssignUtilsMixin.formatInfo = function(info) {
        if (!info) return '';
        if (Array.isArray(info)) return info.map(i => escapeHtml(i)).join(' &bull; ');
        return escapeHtml(String(info));
    };

    /**
     * Get GM program name from program number
     */
    AutoAssignUtilsMixin.getGmProgramName = function(program) {
        if (program == null || program < 0 || program > 127) return null;
        if (this.editorRef && typeof this.editorRef.getInstrumentName === 'function') {
            return this.editorRef.getInstrumentName(program);
        }
        if (typeof getGMInstrumentName === 'function') {
            return getGMInstrumentName(program);
        }
        if (typeof GM_INSTRUMENTS !== 'undefined' && GM_INSTRUMENTS[program]) {
            return GM_INSTRUMENTS[program];
        }
        return `Program ${program}`;
    };

    /**
     * Convert MIDI note number to name (e.g. 60 -> "C4", 61 -> "C#4")
     */
    AutoAssignUtilsMixin.midiNoteToName = function(note) {
        return this.NOTE_NAMES[note % 12] + (Math.floor(note / 12) - 1);
    };

    /**
     * Check if a MIDI note is a black key (sharp/flat)
     */
    AutoAssignUtilsMixin.isBlackKey = function(note) {
        const n = note % 12;
        return n === 1 || n === 3 || n === 6 || n === 8 || n === 10;
    };

    /**
     * Check if a note is within an instrument's playable range
     */
    AutoAssignUtilsMixin.isNoteInInstrumentRange = function(note, instrument) {
        if (!instrument) return false;
        if (instrument.note_selection_mode === 'discrete' && instrument.selected_notes) {
            const notes = Array.isArray(instrument.selected_notes)
                ? instrument.selected_notes
                : (typeof instrument.selected_notes === 'string' ? JSON.parse(instrument.selected_notes) : []);
            return notes.includes(note);
        }
        return note >= (instrument.note_range_min || 0) && note <= (instrument.note_range_max || 127);
    };

    /**
     * Calculate adaptation result for a given strategy
     * Returns { totalNotes, inRange, outOfRange, recovered }
     */
    AutoAssignUtilsMixin.calculateAdaptationResult = function(channel, strategy) {
        const ch = String(channel);
        const analysis = this.channelAnalyses[channel] || this.selectedAssignments[ch]?.channelAnalysis;
        const adaptation = this.adaptationSettings[ch] || {};
        const assignment = this.selectedAssignments[ch];

        if (!analysis || !analysis.noteDistribution || !assignment) {
            return { totalNotes: 0, inRange: 0, outOfRange: 0, recovered: 0 };
        }

        const allOptions = [...(this.suggestions[ch] || []), ...(this.lowScoreSuggestions[ch] || [])];
        const selectedOption = allOptions.find(opt => opt.instrument.id === assignment.instrumentId);
        if (!selectedOption) return { totalNotes: 0, inRange: 0, outOfRange: 0, recovered: 0 };

        const inst = selectedOption.instrument;
        const semitones = adaptation.transpositionSemitones || 0;
        const usedNotes = Object.keys(analysis.noteDistribution).map(Number);
        const totalNotes = usedNotes.length;

        let inRange = 0;
        let recovered = 0;

        for (const note of usedNotes) {
            let adjustedNote = note;

            if (strategy === 'transpose') {
                adjustedNote = note + semitones;
            }

            if (this.isNoteInInstrumentRange(adjustedNote, inst)) {
                inRange++;
            } else if (strategy === 'octaveWrap' && inst.note_selection_mode !== 'discrete') {
                // Try wrapping +/-1 octave (not meaningful for discrete instruments like drums/pads)
                const up = adjustedNote + 12;
                const down = adjustedNote - 12;
                if (this.isNoteInInstrumentRange(up, inst) || this.isNoteInInstrumentRange(down, inst)) {
                    recovered++;
                }
            } else if (strategy === 'suppress') {
                // Out of range notes will be suppressed - counted as "recovered" (handled)
                recovered++;
            }
        }

        return {
            totalNotes,
            inRange,
            outOfRange: totalNotes - inRange - recovered,
            recovered
        };
    };

    /**
     * Format instrument info for display
     */
    AutoAssignUtilsMixin.formatInstrumentInfo = function(instrument, compat) {
        const _t = (key, params) => typeof i18n !== 'undefined' ? i18n.t(key, params) : key;
        const parts = [];
        if (instrument.gm_program !== null && instrument.gm_program !== undefined) {
            const gmName = this.getGmProgramName(instrument.gm_program);
            parts.push(gmName || `GM ${instrument.gm_program}`);
        }
        if (compat.transposition && compat.transposition.octaves !== 0) {
            const direction = compat.transposition.octaves > 0 ? 'up' : 'down';
            parts.push(`${Math.abs(compat.transposition.octaves)} ${_t('common.octave')}(s) ${direction}`);
        } else {
            parts.push(_t('autoAssign.noTransposition'));
        }
        if (instrument.note_range_min !== null && instrument.note_range_max !== null) {
            parts.push(`${_t('autoAssign.range')}: ${this.midiNoteToName(instrument.note_range_min)}\u2013${this.midiNoteToName(instrument.note_range_max)}`);
        }
        return parts.join(' &bull; ');
    };

    AutoAssignUtilsMixin.getScoreColor = function(score) {
        if (score >= 80) return 'var(--aa-score-excellent, #00c896)';
        if (score >= 60) return 'var(--aa-score-good, #7bc67e)';
        if (score >= 40) return 'var(--aa-score-fair, #f0b429)';
        return 'var(--aa-score-poor, #e8365d)';
    };

    AutoAssignUtilsMixin.getScoreClass = function(score) {
        if (score >= 80) return 'aa-color-excellent';
        if (score >= 60) return 'aa-color-good';
        if (score >= 40) return 'aa-color-fair';
        return 'aa-color-poor';
    };

    AutoAssignUtilsMixin.getScoreBgClass = function(score) {
        if (score >= 80) return 'aa-bg-excellent';
        if (score >= 60) return 'aa-bg-good';
        if (score >= 40) return 'aa-bg-fair';
        return 'aa-bg-poor';
    };

    AutoAssignUtilsMixin.getScoreStars = function(score) {
        const filled = score >= 90 ? 5 : score >= 75 ? 4 : score >= 60 ? 3 : score >= 40 ? 2 : 1;
        return '<span class="aa-stars">' + '&#9733;'.repeat(filled) + '&#9734;'.repeat(5 - filled) + '</span>';
    };

    /**
     * Get a human-readable qualitative label for a score
     */
    AutoAssignUtilsMixin.getScoreLabel = function(score) {
        const _t = (key, params) => typeof i18n !== 'undefined' ? i18n.t(key, params) : key;
        if (score >= 90) return _t('autoAssign.scoreExcellent');
        if (score >= 75) return _t('autoAssign.scoreGood');
        if (score >= 60) return _t('autoAssign.scoreAverage');
        if (score >= 40) return _t('autoAssign.scoreFair');
        return _t('autoAssign.scorePoor');
    };

    /**
     * Get a human-readable description of polyphony
     */
    AutoAssignUtilsMixin.getPolyphonyLabel = function(polyphony) {
        const _t = (key, params) => typeof i18n !== 'undefined' ? i18n.t(key, params) : key;
        if (!polyphony || polyphony.max == null) return 'N/A';
        const max = polyphony.max;
        if (max <= 1) return _t('autoAssign.polyphonyMono');
        if (max <= 3) return _t('autoAssign.polyphonyLight', { max });
        if (max <= 6) return _t('autoAssign.polyphonyChords', { max });
        return _t('autoAssign.polyphonyDense', { max });
    };

    /**
     * Get an icon/emoji for an estimated instrument type
     */
    AutoAssignUtilsMixin.getTypeIcon = function(type) {
        const icons = {
            drums: '\uD83E\uDD41',
            bass: '\uD83C\uDFB8',
            melody: '\uD83C\uDFB9',
            harmony: '\uD83C\uDFB5',
            pad: '\uD83C\uDFB6',
            strings: '\uD83C\uDFBB',
            brass: '\uD83C\uDFBA',
            woodwind: '\uD83E\uDE88',
            guitar: '\uD83C\uDFB8',
            keyboard: '\uD83C\uDFB9'
        };
        return icons[type] || '\uD83C\uDFB5';
    };

    /**
     * Get list of other channels currently assigned to the same instrument
     */
    AutoAssignUtilsMixin.getOtherChannelsUsingInstrument = function(instrumentId, excludeChannel) {
        const others = [];
        for (const [ch, assignment] of Object.entries(this.selectedAssignments)) {
            const chNum = parseInt(ch);
            if (chNum !== excludeChannel && !this.skippedChannels.has(chNum) && assignment?.instrumentId === instrumentId) {
                others.push(chNum + 1); // display as 1-based
            }
        }
        return others;
    };

    if (typeof window !== 'undefined') window.AutoAssignUtilsMixin = AutoAssignUtilsMixin;
})();
