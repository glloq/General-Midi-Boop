// tests/frontend/midi-editor-clamp.test.js
//
// Smoke tests for MidiEditorFileOps.convertSequenceToMidi — the MIDI
// serialisation path that the editor invokes on every save. The priority is
// that out-of-range values (notes, channels, velocity, CC, pitch bend) can
// never leak into the binary MIDI stream regardless of what the UI produced.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const mixinSource = readFileSync(
    resolve(__dirname, '../../public/js/features/midi-editor/MidiEditorFileOps.js'),
    'utf8'
);

// Run the file's IIFE so it registers window.MidiEditorFileOps.
new Function(mixinSource)();

const MidiEditorFileOps = /** @type {any} */ (globalThis.window.MidiEditorFileOps);

/**
 * Build a minimal stub that the mixin's convertSequenceToMidi() can run against.
 * It only implements the fields the function reads.
 */
function makeModal(overrides = {}) {
    const modal = {
        fullSequence: [],
        channels: [],
        ccEvents: [],
        tempoEvents: [],
        tempo: 120,
        midiData: { header: { ticksPerBeat: 480 } },
        selectedInstrument: 0,
        log: vi.fn(),
        getInstrumentName: (p) => `Program${p}`,
        ...overrides
    };
    return modal;
}

describe('convertSequenceToMidi', () => {
    /** @param {object} modal */
    const run = (modal) => new MidiEditorFileOps(modal).convertSequenceToMidi();

    it('returns null when there is no sequence to save', () => {
        const modal = makeModal({ fullSequence: [] });
        expect(run(modal)).toBeNull();
    });

    it('emits a setTempo and a programChange per non-drum channel', () => {
        const modal = makeModal({
            fullSequence: [
                { t: 0, g: 120, n: 60, c: 0, v: 100 },
                { t: 0, g: 120, n: 64, c: 2, v: 90 }
            ],
            channels: [
                { channel: 0, program: 0 },
                { channel: 2, program: 40 }
            ]
        });

        const midi = run(modal);
        expect(midi).not.toBeNull();
        expect(midi.tracks).toBeDefined();

        const events = midi.tracks[0];
        const tempos = events.filter(e => e.type === 'setTempo');
        const programs = events.filter(e => e.type === 'programChange');

        expect(tempos.length).toBe(1);
        expect(tempos[0].microsecondsPerBeat).toBe(Math.round(60_000_000 / 120));
        expect(programs.length).toBe(2);
        expect(programs.map(p => p.channel).sort()).toEqual([0, 2]);
        expect(programs.find(p => p.channel === 2).programNumber).toBe(40);
    });

    it('uses the full tempo map when tempoEvents are present and skips the single-tempo fallback', () => {
        const modal = makeModal({
            fullSequence: [{ t: 0, g: 120, n: 60, c: 0, v: 100 }],
            tempoEvents: [
                { ticks: 0, tempo: 100 },
                { ticks: 480, tempo: 140 }
            ]
        });
        const midi = run(modal);
        const tempos = midi.tracks[0].filter(e => e.type === 'setTempo');
        expect(tempos.length).toBe(2);
        expect(tempos[0].microsecondsPerBeat).toBe(Math.round(60_000_000 / 100));
        expect(tempos[1].microsecondsPerBeat).toBe(Math.round(60_000_000 / 140));
    });

    it('skips the programChange on channel 9 (GM drum channel)', () => {
        const modal = makeModal({
            fullSequence: [{ t: 0, g: 120, n: 36, c: 9, v: 100 }],
            channels: [{ channel: 9, program: 0 }]
        });
        const midi = run(modal);
        const programs = midi.tracks[0].filter(e => e.type === 'programChange');
        expect(programs.length).toBe(0);
    });

    it('clamps out-of-range note numbers to 0–127', () => {
        const modal = makeModal({
            fullSequence: [
                { t: 0, g: 120, n: 200, c: 0, v: 100 },
                { t: 0, g: 120, n: -5, c: 0, v: 100 }
            ]
        });
        const midi = run(modal);
        const notes = midi.tracks[0].filter(e => e.type === 'noteOn');
        expect(notes.every(n => n.noteNumber >= 0 && n.noteNumber <= 127)).toBe(true);
        expect(notes.some(n => n.noteNumber === 127)).toBe(true);
        expect(notes.some(n => n.noteNumber === 0)).toBe(true);
    });

    it('clamps out-of-range channel numbers to 0–15', () => {
        const modal = makeModal({
            fullSequence: [
                { t: 0, g: 120, n: 60, c: 99, v: 100 },
                { t: 0, g: 120, n: 60, c: -1, v: 100 }
            ]
        });
        const midi = run(modal);
        const notes = midi.tracks[0].filter(e => e.type === 'noteOn');
        expect(notes.every(n => n.channel >= 0 && n.channel <= 15)).toBe(true);
    });

    it('clamps noteOn velocity to 1–127 and keeps noteOff velocity at 0', () => {
        const modal = makeModal({
            fullSequence: [
                { t: 0, g: 120, n: 60, c: 0, v: 255 },
                { t: 0, g: 120, n: 62, c: 0, v: 0 },
                { t: 0, g: 120, n: 64, c: 0, v: -20 }
            ]
        });
        const midi = run(modal);
        const onEvts = midi.tracks[0].filter(e => e.type === 'noteOn');
        const offEvts = midi.tracks[0].filter(e => e.type === 'noteOff');
        expect(onEvts.every(e => e.velocity >= 1 && e.velocity <= 127)).toBe(true);
        expect(offEvts.every(e => e.velocity === 0)).toBe(true);
    });

    it('clamps CC values to 0–127 and pitch bend to -8192…8191', () => {
        const modal = makeModal({
            fullSequence: [{ t: 0, g: 120, n: 60, c: 0, v: 100 }],
            ccEvents: [
                { ticks: 0, channel: 0, type: 'cc7', value: 200 },
                { ticks: 0, channel: 0, type: 'cc7', value: -5 },
                { ticks: 0, channel: 0, type: 'pitchbend', value: 50000 },
                { ticks: 0, channel: 0, type: 'pitchbend', value: -50000 }
            ]
        });
        const midi = run(modal);
        const trk = midi.tracks[0];

        const ccs = trk.filter(e => e.type === 'controller');
        expect(ccs.length).toBe(2);
        expect(ccs.every(c => c.value >= 0 && c.value <= 127)).toBe(true);
        expect(ccs.map(c => c.value).sort()).toEqual([0, 127]);

        const pbs = trk.filter(e => e.type === 'pitchBend');
        expect(pbs.length).toBe(2);
        expect(pbs.every(p => p.value >= -8192 && p.value <= 8191)).toBe(true);
        expect(pbs.map(p => p.value).sort((a, b) => a - b)).toEqual([-8192, 8191]);
    });

    it('keeps in-range values untouched (no spurious clamping)', () => {
        const modal = makeModal({
            fullSequence: [{ t: 0, g: 480, n: 60, c: 1, v: 80 }],
            ccEvents: [{ ticks: 0, channel: 1, type: 'cc7', value: 64 }]
        });
        const midi = run(modal);
        const onEvt = midi.tracks[0].find(e => e.type === 'noteOn');
        expect(onEvt.noteNumber).toBe(60);
        expect(onEvt.channel).toBe(1);
        expect(onEvt.velocity).toBe(80);
        const cc = midi.tracks[0].find(e => e.type === 'controller');
        expect(cc.value).toBe(64);
        expect(cc.controllerType).toBe(7);
    });

    it('normalises a missing gate (g) to at least 1 tick', () => {
        const modal = makeModal({
            fullSequence: [{ t: 0, g: 0, n: 60, c: 0, v: 100 }]
        });
        const midi = run(modal);
        const events = midi.tracks[0];
        const on = events.find(e => e.type === 'noteOn');
        const off = events.find(e => e.type === 'noteOff');
        const delta = off.deltaTime; // computed relative to the sorted timeline
        // The noteOff should land at tick >= 1 after the noteOn's tick
        expect(on).toBeDefined();
        expect(off).toBeDefined();
        // We cannot observe absoluteTime after delta-time conversion, but
        // sum-of-deltas from the first event to noteOff must be >= 1.
        const total = events.slice(0, events.indexOf(off) + 1).reduce((s, e) => s + e.deltaTime, 0);
        const onIndex = events.indexOf(on);
        const onTotal = events.slice(0, onIndex + 1).reduce((s, e) => s + e.deltaTime, 0);
        expect(total - onTotal).toBeGreaterThanOrEqual(1);
    });
});
