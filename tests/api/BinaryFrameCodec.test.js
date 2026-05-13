import { describe, test, expect } from '@jest/globals';
import codec, {
  encodePlaybackPosition,
  encodeTunerPitch,
  encodeCalibrationAudio,
  encodeSystemLag,
  encodeByEvent,
  decode,
  isBinaryFrame,
  isBinaryEvent,
  FRAME_MAGIC,
  HEADER_BYTES,
  SUPPORTED_EVENTS
} from '../../shared/BinaryFrameCodec.js';

describe('BinaryFrameCodec', () => {
  describe('header layout', () => {
    test('every encoder writes magic + type + length header', () => {
      const samples = [
        encodePlaybackPosition(1.5, 25),
        encodeTunerPitch(440, 0, 69),
        encodeCalibrationAudio(-6.5, -1.2),
        encodeSystemLag(12, 50)
      ];
      for (const buf of samples) {
        const view = new DataView(buf);
        expect(view.getUint8(0)).toBe(FRAME_MAGIC);
        expect(view.getUint16(2, true)).toBe(buf.byteLength - HEADER_BYTES);
      }
    });

    test('isBinaryFrame detects ArrayBuffer and Uint8Array', () => {
      const buf = encodePlaybackPosition(0, 0);
      expect(isBinaryFrame(buf)).toBe(true);
      expect(isBinaryFrame(new Uint8Array(buf))).toBe(true);
      expect(isBinaryFrame(new ArrayBuffer(0))).toBe(false);
      expect(isBinaryFrame(null)).toBe(false);
      // JSON text fragment (first byte '{') is not a binary frame.
      const json = new TextEncoder().encode('{"type":"foo"}').buffer;
      expect(isBinaryFrame(json)).toBe(false);
    });

    test('isBinaryEvent reports supported event names', () => {
      expect(isBinaryEvent('playback_position')).toBe(true);
      expect(isBinaryEvent('tuner:pitch')).toBe(true);
      expect(isBinaryEvent('calibration:audio_level')).toBe(true);
      expect(isBinaryEvent('system_lag')).toBe(true);
      expect(isBinaryEvent('monitor_event')).toBe(false);
      expect(isBinaryEvent('arbitrary')).toBe(false);
    });
  });

  describe('round-trip', () => {
    test('playback_position', () => {
      const buf = encodePlaybackPosition(123.4567, 42.5);
      const { type, payload } = decode(buf);
      expect(type).toBe('playback_position');
      expect(payload.position).toBeCloseTo(123.4567, 10);
      expect(payload.percentage).toBeCloseTo(42.5, 3);
      expect(buf.byteLength).toBe(16);
    });

    test('tuner:pitch with positive note', () => {
      const buf = encodeTunerPitch(442.13, 8.2, 69);
      const { type, payload } = decode(buf);
      expect(type).toBe('tuner:pitch');
      expect(payload.freqHz).toBeCloseTo(442.13, 2);
      expect(payload.cents).toBeCloseTo(8.2, 2);
      expect(payload.noteMidi).toBe(69);
      expect(buf.byteLength).toBe(13);
    });

    test('tuner:pitch encodes "no note" as -1', () => {
      const buf = encodeTunerPitch(0, 0, -1);
      const { payload } = decode(buf);
      expect(payload.noteMidi).toBe(-1);
    });

    test('calibration:audio_level', () => {
      const buf = encodeCalibrationAudio(-12.5, -1.0);
      const { type, payload } = decode(buf);
      expect(type).toBe('calibration:audio_level');
      expect(payload.levelDb).toBeCloseTo(-12.5, 3);
      expect(payload.peakDb).toBeCloseTo(-1.0, 3);
      expect(buf.byteLength).toBe(12);
    });

    test('system_lag clamps to u16', () => {
      const buf = encodeSystemLag(99999, 50);
      const { type, payload } = decode(buf);
      expect(type).toBe('system_lag');
      expect(payload.lagMs).toBe(65535);
      expect(payload.thresholdMs).toBe(50);
      expect(buf.byteLength).toBe(8);
    });

    test('system_lag rounds negatives to 0', () => {
      const buf = encodeSystemLag(-5, -10);
      const { payload } = decode(buf);
      expect(payload.lagMs).toBe(0);
      expect(payload.thresholdMs).toBe(0);
    });
  });

  describe('encodeByEvent dispatcher', () => {
    test('dispatches every supported event name', () => {
      const cases = [
        ['playback_position', { position: 1, percentage: 1 }],
        ['tuner:pitch', { freqHz: 440, cents: 0, noteMidi: 69 }],
        ['calibration:audio_level', { levelDb: -10, peakDb: -1 }],
        ['system_lag', { lagMs: 5, thresholdMs: 50 }]
      ];
      for (const [name, payload] of cases) {
        const buf = encodeByEvent(name, payload);
        expect(buf).not.toBeNull();
        const { type } = decode(buf);
        expect(type).toBe(name);
      }
    });

    test('returns null for unsupported events (caller falls back to JSON)', () => {
      expect(encodeByEvent('monitor_event', {})).toBeNull();
      expect(encodeByEvent('arbitrary', {})).toBeNull();
    });

    test('tolerates missing fields with safe defaults', () => {
      // freqHz absent -> 0; noteMidi absent -> -1
      const buf = encodeByEvent('tuner:pitch', { cents: 0 });
      const { payload } = decode(buf);
      expect(payload.freqHz).toBe(0);
      expect(payload.noteMidi).toBe(-1);
    });
  });

  describe('validation', () => {
    test('rejects NaN', () => {
      expect(() => encodePlaybackPosition(NaN, 0)).toThrow(TypeError);
      expect(() => encodeCalibrationAudio(NaN, 0)).toThrow(TypeError);
    });

    test('rejects Infinity', () => {
      expect(() => encodePlaybackPosition(Infinity, 0)).toThrow(TypeError);
    });

    test('rejects non-integer noteMidi', () => {
      expect(() => encodeTunerPitch(440, 0, 69.5)).toThrow(TypeError);
    });

    test('rejects noteMidi out of i8 range', () => {
      expect(() => encodeTunerPitch(440, 0, 200)).toThrow(RangeError);
      expect(() => encodeTunerPitch(440, 0, -129)).toThrow(RangeError);
    });

    test('decode rejects bad magic', () => {
      const buf = new ArrayBuffer(8);
      new DataView(buf).setUint8(0, 0x99);
      expect(() => decode(buf)).toThrow(/invalid magic/);
    });

    test('decode rejects truncated frame', () => {
      const full = encodePlaybackPosition(1, 1);
      const truncated = full.slice(0, 6);
      expect(() => decode(truncated)).toThrow(/truncated/);
    });

    test('decode rejects unknown event code', () => {
      const buf = new ArrayBuffer(HEADER_BYTES);
      const view = new DataView(buf);
      view.setUint8(0, FRAME_MAGIC);
      view.setUint8(1, 0xff);
      view.setUint16(2, 0, true);
      expect(() => decode(buf)).toThrow(/unknown event type/);
    });
  });

  describe('exports', () => {
    test('default export aggregates the API', () => {
      expect(codec.encodePlaybackPosition).toBe(encodePlaybackPosition);
      expect(codec.decode).toBe(decode);
      expect(codec.FRAME_MAGIC).toBe(FRAME_MAGIC);
    });

    test('SUPPORTED_EVENTS lists every binary type', () => {
      expect(SUPPORTED_EVENTS).toEqual({
        playback_position: 0x01,
        'tuner:pitch': 0x03,
        'calibration:audio_level': 0x04,
        system_lag: 0x05
      });
    });
  });
});
