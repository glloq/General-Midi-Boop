// tests/audio/delay-calibrator-pitch.test.js
// Synthetic-signal tests for the MPM-based pitch detector and biquad
// pre-filter used by the tuner.

import { describe, test, expect, beforeAll } from '@jest/globals';
import DelayCalibrator from '../../src/audio/DelayCalibrator.js';

const SR = 16000;
const N = 4096;
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function buildSine(freq, amp = 0.5) {
  const buf = new Float32Array(N);
  for (let i = 0; i < N; i++) buf[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return buf;
}

function buildHarmonics(fundamental, amps) {
  const buf = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let k = 0; k < amps.length; k++) {
      s += amps[k] * Math.sin((2 * Math.PI * fundamental * (k + 1) * i) / SR);
    }
    buf[i] = s;
  }
  return buf;
}

function applyFilterFresh(calibrator, raw) {
  // Warm the biquad state then run a second pass on a fresh copy so the
  // transient is out of the returned buffer.
  calibrator._buildFilterCoeffs(SR);
  calibrator._resetFilterState();
  const warm = new Float32Array(N);
  warm.set(raw);
  calibrator._applyFilter(warm, SR);
  const out = new Float32Array(N);
  out.set(raw);
  calibrator._applyFilter(out, SR);
  return out;
}

describe('DelayCalibrator.detectPitch (MPM)', () => {
  let c;
  beforeAll(() => {
    c = new DelayCalibrator({}, silentLogger);
  });

  test('rejects silence', () => {
    const r = c.detectPitch(new Float32Array(N), SR);
    expect(r.freq).toBe(0);
    expect(r.confidence).toBe(0);
  });

  test.each([
    ['E2 (82.41 Hz)', 82.41],
    ['A2 (110 Hz)', 110],
    ['D3 (146.83 Hz)', 146.83],
    ['G3 (196 Hz)', 196],
    ['A4 (440 Hz)', 440],
    ['E5 (659.25 Hz)', 659.25],
    ['C6 (1046.50 Hz)', 1046.5]
  ])('locks onto a pure sine at %s', (_label, f) => {
    const r = c.detectPitch(buildSine(f), SR);
    expect(Math.abs(r.freq - f)).toBeLessThan(0.5);
    expect(r.confidence).toBeGreaterThan(0.95);
  });

  test('picks the fundamental, not an octave, on a harmonic stack', () => {
    // Sum of f, 2f, 3f, 4f — naive ACF would pick 2f (largest peak).
    const buf = buildHarmonics(110, [1, 0.8, 0.6, 0.4]);
    const r = c.detectPitch(buf, SR);
    expect(Math.abs(r.freq - 110)).toBeLessThan(1);
    expect(r.confidence).toBeGreaterThan(0.85);
  });

  test('is amplitude-invariant (decaying sine)', () => {
    const buf = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      buf[i] = Math.exp((-3 * i) / SR) * Math.sin((2 * Math.PI * 196 * i) / SR);
    }
    const r = c.detectPitch(buf, SR);
    expect(Math.abs(r.freq - 196)).toBeLessThan(1);
    expect(r.confidence).toBeGreaterThan(0.85);
  });

  test('tracks an inharmonic steel-string model near E2', () => {
    // Partials slightly sharp of integer multiples — typical of stiff
    // steel strings, which trips poorly-designed ACF detectors.
    const buf = new Float32Array(N);
    const f0 = 82.41;
    const B = 5e-5;
    for (let k = 1; k <= 6; k++) {
      const fk = f0 * k * Math.sqrt(1 + B * k * k);
      const amp = 0.5 / k;
      for (let i = 0; i < N; i++) buf[i] += amp * Math.sin((2 * Math.PI * fk * i) / SR);
    }
    const r = c.detectPitch(buf, SR);
    expect(Math.abs(r.freq - f0)).toBeLessThan(2);
    expect(r.confidence).toBeGreaterThan(0.8);
  });

  test('rejects white noise with low confidence', () => {
    const buf = new Float32Array(N);
    // Fixed seed for reproducibility
    let s = 1234567;
    const rand = () => {
      s = (s * 16807) % 2147483647;
      return (s / 2147483647) * 2 - 1;
    };
    for (let i = 0; i < N; i++) buf[i] = rand() * 0.3;
    const r = c.detectPitch(buf, SR);
    expect(r.confidence).toBeLessThan(0.7);
  });
});

describe('DelayCalibrator biquad pre-filter (HPF 60 Hz + LPF 3 kHz)', () => {
  let c;
  beforeAll(() => {
    c = new DelayCalibrator({}, silentLogger);
  });

  test('removes realistic 60 Hz hum (-30 dB) from a 220 Hz tone', () => {
    const raw = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      raw[i] =
        0.03 * Math.sin((2 * Math.PI * 60 * i) / SR) + 1.0 * Math.sin((2 * Math.PI * 220 * i) / SR);
    }
    const filt = applyFilterFresh(c, raw);
    const r = c.detectPitch(filt, SR);
    expect(Math.abs(r.freq - 220)).toBeLessThan(1);
    expect(r.confidence).toBeGreaterThan(0.85);
  });

  test('does not break E2 (82 Hz) when hum is present at -30 dB', () => {
    const raw = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      raw[i] =
        0.03 * Math.sin((2 * Math.PI * 60 * i) / SR) +
        1.0 * Math.sin((2 * Math.PI * 82.41 * i) / SR);
    }
    const filt = applyFilterFresh(c, raw);
    const r = c.detectPitch(filt, SR);
    expect(Math.abs(r.freq - 82.41)).toBeLessThan(2);
    expect(r.confidence).toBeGreaterThan(0.85);
  });

  test('attenuates sub-rumble (30 Hz) significantly', () => {
    const raw = new Float32Array(N);
    for (let i = 0; i < N; i++) raw[i] = Math.sin((2 * Math.PI * 30 * i) / SR);
    const filt = applyFilterFresh(c, raw);
    let rmsIn = 0,
      rmsOut = 0;
    for (let i = 0; i < N; i++) {
      rmsIn += raw[i] * raw[i];
      rmsOut += filt[i] * filt[i];
    }
    rmsIn = Math.sqrt(rmsIn / N);
    rmsOut = Math.sqrt(rmsOut / N);
    // Expect at least ~-10 dB attenuation at 30 Hz (one octave below 60 Hz HPF).
    // The warmup restarts the signal from phase 0 creating a phase discontinuity,
    // so measured attenuation is slightly weaker than the ideal -12 dB (0.25).
    expect(rmsOut / rmsIn).toBeLessThan(0.3);
  });
});
