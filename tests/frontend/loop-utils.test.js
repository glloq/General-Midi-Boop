// tests/frontend/loop-utils.test.js
//
// Tests unitaires pour LoopUtils — couvre les fixes L8 (loopDurationMs
// support time_sig_den), parseSequence (résilience JSON), validate.tempo,
// et les helpers utilisés par tous les onglets de la modale boucles.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const utilsSource = readFileSync(
    resolve(__dirname, '../../public/js/features/loop/LoopUtils.js'),
    'utf8'
);

// Charge l'IIFE qui expose window.LoopUtils
new Function(utilsSource)();

const LoopUtils = /** @type {any} */ (globalThis.window.LoopUtils);

describe('LoopUtils.loopDurationMs', () => {
    it('retourne la durée correcte en 4/4', () => {
        // 4 temps × 2 mesures × 60000 / 120 = 4000 ms
        expect(LoopUtils.loopDurationMs({
            tempo: 120, bars: 2, time_sig_num: 4, time_sig_den: 4
        })).toBeCloseTo(4000);
    });

    it('retourne la durée correcte en 3/4', () => {
        // 3 temps × 4 mesures × 60000 / 120 × (4/4) = 6000 ms
        expect(LoopUtils.loopDurationMs({
            tempo: 120, bars: 4, time_sig_num: 3, time_sig_den: 4
        })).toBeCloseTo(6000);
    });

    it('applique le facteur 4/den en 6/8 (AUDIT §L8)', () => {
        // En 6/8 : 6 huitièmes × 2 mesures × 60000 / 120 × (4/8) = 3000 ms
        // (et NON 6000 ms comme l'ancienne formule sans le facteur)
        expect(LoopUtils.loopDurationMs({
            tempo: 120, bars: 2, time_sig_num: 6, time_sig_den: 8
        })).toBeCloseTo(3000);
    });

    it('applique le facteur 4/den en 7/8', () => {
        // 7 huitièmes × 1 mesure × 60000 / 120 × (4/8) = 1750 ms
        expect(LoopUtils.loopDurationMs({
            tempo: 120, bars: 1, time_sig_num: 7, time_sig_den: 8
        })).toBeCloseTo(1750);
    });

    it('défaut 4/4 quand time_sig_den absent (rétro-compat)', () => {
        // Ancien call-site sans time_sig_den : 4/4 supposé.
        expect(LoopUtils.loopDurationMs({
            tempo: 120, bars: 2, time_sig_num: 4
        })).toBeCloseTo(4000);
    });

    it('gère time_sig_den === 0 sans NaN/Infinity (defensive)', () => {
        const v = LoopUtils.loopDurationMs({
            tempo: 120, bars: 2, time_sig_num: 4, time_sig_den: 0
        });
        expect(Number.isFinite(v)).toBe(true);
        // Fallback à 4 → résultat = 4000 ms
        expect(v).toBeCloseTo(4000);
    });
});

describe('LoopUtils.parseSequence', () => {
    it('retourne array vide pour null/undefined', () => {
        expect(LoopUtils.parseSequence(null)).toEqual([]);
        expect(LoopUtils.parseSequence(undefined)).toEqual([]);
        expect(LoopUtils.parseSequence('')).toEqual([]);
    });

    it('retourne le array tel quel si déjà un array', () => {
        const seq = [{ t: 0, n: 60, v: 100, l: 240 }];
        expect(LoopUtils.parseSequence(seq)).toBe(seq);
    });

    it('parse une string JSON valide', () => {
        const json = '[{"t":0,"n":60,"v":100,"l":240}]';
        expect(LoopUtils.parseSequence(json)).toEqual([{ t: 0, n: 60, v: 100, l: 240 }]);
    });

    it('retourne array vide pour JSON corrompu', () => {
        expect(LoopUtils.parseSequence('[{not json')).toEqual([]);
    });

    it('retourne array vide si JSON est un objet (pas un array)', () => {
        expect(LoopUtils.parseSequence('{"foo":"bar"}')).toEqual([]);
    });
});

describe('LoopUtils.validate.tempo', () => {
    it('clamp dans [20, 300]', () => {
        expect(LoopUtils.validate.tempo(5)).toBe(20);
        expect(LoopUtils.validate.tempo(999)).toBe(300);
        expect(LoopUtils.validate.tempo(120)).toBe(120);
    });

    it('retourne le fallback pour les non-nombres', () => {
        expect(LoopUtils.validate.tempo('fast', 140)).toBe(140);
        expect(LoopUtils.validate.tempo(NaN, 140)).toBe(140);
    });
});
