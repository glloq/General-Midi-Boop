// =============================================================================
// HarmonicaLayout.js — Shared harmonica note-layout (single source of truth).
// =============================================================================
// Used by HarmonicaView (the blow/draw visualization) AND by KeyboardModal
// (to restrict the virtual piano to the notes a real harmonica can sound).
//
// Two tunings, both keyed to the harmonica's musical key:
//
//  • Diatonic (Richter), 10-hole reference in C:
//      Hole   1   2   3   4   5   6   7   8   9  10
//      Blow  C4  E4  G4  C5  E5  G5  C6  E6  G6  C7
//      Draw  D4  G4  B4  D5  F5  A5  B5  D6  F6  A6
//  • Chromatic (solo tuning) per repeating 4-hole group:
//      Blow  C  E  G  C      Draw  D  F  A  B
//    (the slide raises every note one semitone — handled by the view).
//
// Key correctness: the layout is anchored to the KEY ROOT at the C4=60
// reference octave and only ever octave-shifted (±12) to sit inside the
// configured range. It is NEVER transposed by a non-octave amount derived
// from the range minimum — that earlier behaviour broke diatonicity (a C
// harmonica showed sharps whenever the range/window minimum was not a C).
// A C diatonic harmonica therefore stays strictly natural; a non-C key
// faithfully reproduces the real instrument's accidentals.
// =============================================================================
(function () {
    'use strict';

    // C diatonic Richter tuning (MIDI, C4 = 60) — reference 10-hole layout.
    const BLOW0 = [60, 64, 67, 72, 76, 79, 84, 88, 91, 96];
    const DRAW0 = [62, 67, 71, 74, 77, 81, 83, 86, 89, 93];

    // Chromatic solo tuning, semitone offsets from each 4-hole group root:
    // blow C E G C, draw D F A B.
    const SOLO_BLOW = [0, 4, 7, 12];
    const SOLO_DRAW = [2, 5, 9, 11];

    const KEY_PC = {
        'C': 0, 'C#': 1, 'D': 2, 'D#': 3, 'E': 4, 'F': 5,
        'F#': 6, 'G': 7, 'G#': 8, 'A': 9, 'A#': 10, 'B': 11
    };

    // Relative reference pattern, tiled past the 10-hole reference by octave
    // (period-3, +12) so an arbitrary hole count stays musically coherent.
    const BLOW_REL = BLOW0.map(n => n - BLOW0[0]);
    const DRAW_REL = DRAW0.map(n => n - BLOW0[0]);

    function relOff(rel, i) {
        return i < rel.length ? rel[i] : relOff(rel, i - 3) + 12;
    }

    function holesFromCount(noteCount) {
        return Math.max(1, Math.round(noteCount / 2));
    }

    // Whole-octave shift that brings the key root nearest to (and not below)
    // `target`. Returning a multiple of 12 guarantees the diatonic pattern
    // is preserved — the only correct way to "fit" a keyed harmonica.
    function octaveShift(anchor, target) {
        if (!Number.isFinite(target)) return 0;
        let s = Math.round((target - anchor) / 12) * 12;
        if (anchor + s < target) s += 12;
        return s;
    }

    // Diatonic Richter transposed to the chosen key, octave-fitted to the
    // range, then clamped (a hole is dropped — not split — as soon as its
    // blow or draw exceeds the range max). With no configured range it keeps
    // the fixed 10-hole reference for the key.
    function richterKeyed(lo, hi, keyOff) {
        const anchor = BLOW0[0] + keyOff;
        const off = keyOff + octaveShift(anchor, lo);
        const blow = [], draw = [];
        for (let i = 0; i < BLOW0.length; i++) {
            const b = BLOW0[i] + off, d = DRAW0[i] + off;
            if (Number.isFinite(hi) && (b > hi || d > hi)) break;
            blow.push(b); draw.push(d);
        }
        return blow.length
            ? { blow, draw }
            : { blow: [anchor], draw: [anchor] };
    }

    // Chromatic solo tuning: emit 4-hole groups while they fit the range
    // (default 12 holes / 3 groups when no range is configured).
    function chromaticSolo(lo, hi, keyOff) {
        const anchor = BLOW0[0] + keyOff;
        const root = anchor + octaveShift(anchor, lo);
        const blow = [], draw = [];
        for (let g = 0; ; g++) {
            for (let k = 0; k < 4; k++) {
                const b = root + 12 * g + SOLO_BLOW[k];
                const d = root + 12 * g + SOLO_DRAW[k];
                if (Number.isFinite(hi) && (b > hi || d > hi)) {
                    return blow.length
                        ? { blow, draw } : { blow: [root], draw: [root] };
                }
                blow.push(b); draw.push(d);
            }
            if (!Number.isFinite(hi) && g >= 2) break;
        }
        return blow.length
            ? { blow, draw } : { blow: [root], draw: [root] };
    }

    // Count-driven layouts. With a discrete note selection the hole count
    // follows it: 1 hole = 1 blow + 1 draw, so N notes → round(N/2) holes.
    function richterCount(base, keyOff, holes) {
        const anchor = BLOW0[0] + keyOff;
        const off = keyOff + octaveShift(anchor, base);
        const blow = [], draw = [];
        for (let i = 0; i < holes; i++) {
            blow.push(BLOW0[0] + off + relOff(BLOW_REL, i));
            draw.push(BLOW0[0] + off + relOff(DRAW_REL, i));
        }
        return { blow, draw };
    }

    function chromaticCount(base, keyOff, holes) {
        const anchor = BLOW0[0] + keyOff;
        const root = anchor + octaveShift(anchor, base);
        const blow = [], draw = [];
        for (let i = 0; i < holes; i++) {
            const g = Math.floor(i / 4), k = i % 4;
            blow.push(root + 12 * g + SOLO_BLOW[k]);
            draw.push(root + 12 * g + SOLO_DRAW[k]);
        }
        return { blow, draw };
    }

    // Resolve { type, key } + { min, max, notes? } into blow/draw arrays.
    function computeLayout(cfg, range) {
        cfg = cfg || { type: 'diatonic', key: 'C' };
        const chromatic = cfg.type === 'chromatic';
        const keyOff = KEY_PC[cfg.key] || 0;
        const rng = range || null;
        const lo = rng ? rng.min : NaN;
        const hi = rng ? rng.max : NaN;
        const count = (rng && Array.isArray(rng.notes) && rng.notes.length)
            ? rng.notes.length : null;
        if (count != null) {
            const holes = holesFromCount(count);
            return chromatic
                ? chromaticCount(lo, keyOff, holes)
                : richterCount(lo, keyOff, holes);
        }
        return chromatic
            ? chromaticSolo(lo, hi, keyOff)
            : richterKeyed(lo, hi, keyOff);
    }

    // The set of MIDI notes the harmonica can actually sound, used to
    // restrict the virtual piano. Chromatic also includes every note + 1
    // (the slide reaches it), so in practice nothing is filtered there.
    function playableSet(cfg, range) {
        const { blow, draw } = computeLayout(cfg, range);
        const chromatic = !!(cfg && cfg.type === 'chromatic');
        const set = new Set();
        const add = (n) => { set.add(n); if (chromatic) set.add(n + 1); };
        blow.forEach(add);
        draw.forEach(add);
        return set;
    }

    const HarmonicaLayout = { computeLayout, playableSet, KEY_PC };

    if (typeof window !== 'undefined') window.HarmonicaLayout = HarmonicaLayout;
    if (typeof module !== 'undefined') module.exports = HarmonicaLayout;
})();
