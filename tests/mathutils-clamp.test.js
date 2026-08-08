// tests/mathutils-clamp.test.js
// Audit B1: clamp() must treat a non-finite value as the lower bound. The old
// version returned NaN/undefined verbatim (both `<min` and `>max` are false for
// NaN), poisoning every downstream brightness computation.

import { describe, test, expect } from '@jest/globals';
import { clamp } from '../src/utils/MathUtils.js';

describe('clamp — NaN/non-finite safety (audit B1)', () => {
  test('NaN clamps to min', () => {
    expect(clamp(NaN)).toBe(0);
    expect(clamp(NaN, 10, 20)).toBe(10);
  });
  test('undefined / non-numeric clamp to min', () => {
    expect(clamp(undefined)).toBe(0);
    expect(clamp('abc')).toBe(0);
    expect(clamp({})).toBe(0);
    expect(clamp(null, 5, 9)).toBe(5);
  });
  test('Infinity clamps to max, -Infinity to min', () => {
    expect(clamp(Infinity)).toBe(0); // non-finite → min (safe floor)
    expect(clamp(-Infinity)).toBe(0);
  });
  test('normal values pass through and bound correctly', () => {
    expect(clamp(128)).toBe(128);
    expect(clamp(300)).toBe(255);
    expect(clamp(-5)).toBe(0);
    expect(clamp(50, 0, 100)).toBe(50);
  });
});
