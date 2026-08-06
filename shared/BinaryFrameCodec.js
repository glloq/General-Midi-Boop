/**
 * @file shared/BinaryFrameCodec.js
 * @description Isomorphic encoder/decoder for the high-frequency
 * WebSocket events that benefit from a compact binary wire format
 * instead of JSON.
 *
 * The same module is imported by:
 *   - the backend (Node.js, via Buffer/Uint8Array compat)
 *   - the frontend (browser, via ArrayBuffer + DataView)
 *
 * Wire format (little-endian):
 *
 *   Frame = [u8 magic][u8 eventTypeCode][u16 payloadLen][payload...]
 *
 * The 4-byte header lets the receiver detect a binary frame (magic 0xB0)
 * and dispatch by event-type without parsing JSON. Any non-binary frame
 * (string / non-matching magic) is left to the JSON path.
 *
 * Event types supported:
 *   0x01  playback_position     [f64 positionSec][f32 percentage]
 *   0x05  system_lag            [u16 lagMs][u16 thresholdMs]
 *
 * `monitor_event` is intentionally left in JSON for now — its payload
 * carries a variable-length string `deviceId` and is gated behind
 * `monitorAll`, so the gain from binary encoding would be small.
 *
 * `tuner:pitch` (0x03) and `calibration:audio_level` (0x04) are sent as
 * JSON, NOT binary: the tuner payload carries a `confidence` field the
 * consumer gates on (which the fixed 9-byte frame has no slot for), and
 * the calibration payload's `rms`/`peak` are linear 0..1 levels, not the
 * decibels the frame's `levelDb`/`peakDb` names imply. Forcing them through
 * the binary frame silently dropped `confidence` and mismatched the field
 * names on both ends, leaving the tuner and the VU meter permanently blank.
 * They are therefore excluded from `EVENT_TYPES` (so `isBinaryEvent` is
 * false and `WsOutputQueue` emits JSON). The 0x03/0x04 encode/decode
 * helpers are retained for backward compatibility with any peer that still
 * speaks the binary form.
 */

export const FRAME_MAGIC = 0xb0;
export const HEADER_BYTES = 4;

// NOTE: tuner:pitch (0x03) and calibration:audio_level (0x04) are deliberately
// NOT listed here — see the file header. Keeping them out routes them to the
// JSON wire path with their original `{freq,confidence,rms}` / `{rms,peak}`
// field names intact.
export const EVENT_TYPES = Object.freeze({
  playback_position: 0x01,
  system_lag:        0x05
});

// Reverse map (code -> canonical event name) used by decode().
const EVENT_NAME_BY_CODE = Object.freeze({
  0x01: 'playback_position',
  0x03: 'tuner:pitch',
  0x04: 'calibration:audio_level',
  0x05: 'system_lag'
});

const PAYLOAD_BYTES = Object.freeze({
  0x01: 12, // f64 + f32
  0x03: 9,  // f32 + f32 + i8
  0x04: 8,  // f32 + f32
  0x05: 4   // u16 + u16
});

function _isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function _newFrame(typeCode) {
  const payloadLen = PAYLOAD_BYTES[typeCode];
  const buf = new ArrayBuffer(HEADER_BYTES + payloadLen);
  const view = new DataView(buf);
  view.setUint8(0, FRAME_MAGIC);
  view.setUint8(1, typeCode);
  view.setUint16(2, payloadLen, true);
  return { buf, view };
}

/**
 * Encode `playback_position` (12-byte payload, 16-byte frame).
 * @param {number} positionSec - Playback time in seconds (≥ 0).
 * @param {number} percentage  - 0..100 (clamped).
 * @returns {ArrayBuffer}
 */
export function encodePlaybackPosition(positionSec, percentage) {
  if (!_isFiniteNumber(positionSec) || !_isFiniteNumber(percentage)) {
    throw new TypeError('encodePlaybackPosition: non-finite numbers');
  }
  const { buf, view } = _newFrame(0x01);
  view.setFloat64(HEADER_BYTES, positionSec, true);
  view.setFloat32(HEADER_BYTES + 8, percentage, true);
  return buf;
}

/**
 * Encode `tuner:pitch` (9-byte payload, 13-byte frame).
 * `noteMidi` accepts -1 to encode "no note detected".
 * @param {number} freqHz
 * @param {number} cents
 * @param {number} noteMidi
 * @returns {ArrayBuffer}
 */
export function encodeTunerPitch(freqHz, cents, noteMidi) {
  if (!_isFiniteNumber(freqHz) || !_isFiniteNumber(cents) || !Number.isInteger(noteMidi)) {
    throw new TypeError('encodeTunerPitch: invalid numeric input');
  }
  if (noteMidi < -128 || noteMidi > 127) {
    throw new RangeError('encodeTunerPitch: noteMidi out of i8 range');
  }
  const { buf, view } = _newFrame(0x03);
  view.setFloat32(HEADER_BYTES, freqHz, true);
  view.setFloat32(HEADER_BYTES + 4, cents, true);
  view.setInt8(HEADER_BYTES + 8, noteMidi);
  return buf;
}

/**
 * Encode `calibration:audio_level` (8-byte payload, 12-byte frame).
 * @param {number} levelDb
 * @param {number} peakDb
 * @returns {ArrayBuffer}
 */
export function encodeCalibrationAudio(levelDb, peakDb) {
  if (!_isFiniteNumber(levelDb) || !_isFiniteNumber(peakDb)) {
    throw new TypeError('encodeCalibrationAudio: non-finite numbers');
  }
  const { buf, view } = _newFrame(0x04);
  view.setFloat32(HEADER_BYTES, levelDb, true);
  view.setFloat32(HEADER_BYTES + 4, peakDb, true);
  return buf;
}

/**
 * Encode `system_lag` (4-byte payload, 8-byte frame).
 * @param {number} lagMs
 * @param {number} thresholdMs
 * @returns {ArrayBuffer}
 */
export function encodeSystemLag(lagMs, thresholdMs) {
  if (!Number.isFinite(lagMs) || !Number.isFinite(thresholdMs)) {
    throw new TypeError('encodeSystemLag: non-finite numbers');
  }
  const lag = Math.max(0, Math.min(65535, Math.round(lagMs)));
  const thr = Math.max(0, Math.min(65535, Math.round(thresholdMs)));
  const { buf, view } = _newFrame(0x05);
  view.setUint16(HEADER_BYTES, lag, true);
  view.setUint16(HEADER_BYTES + 2, thr, true);
  return buf;
}

/**
 * Convenience: dispatch by event name. Returns `null` when the event
 * is not supported in binary form so the caller can fall back to JSON.
 *
 * @param {string} eventName
 * @param {*} payload
 * @returns {ArrayBuffer|null}
 */
export function encodeByEvent(eventName, payload) {
  switch (eventName) {
    case 'playback_position':
      return encodePlaybackPosition(payload.position ?? 0, payload.percentage ?? 0);
    case 'tuner:pitch':
    case 'tuner_pitch':
      return encodeTunerPitch(
        payload.freqHz ?? payload.frequency ?? 0,
        payload.cents ?? 0,
        Number.isInteger(payload.noteMidi) ? payload.noteMidi : -1
      );
    case 'calibration:audio_level':
    case 'calibration_audio_level':
      return encodeCalibrationAudio(
        payload.levelDb ?? payload.level ?? 0,
        payload.peakDb ?? payload.peak ?? 0
      );
    case 'system_lag':
      return encodeSystemLag(payload.lagMs ?? 0, payload.thresholdMs ?? 0);
    default:
      return null;
  }
}

/**
 * Quick check that a buffer is a binary frame (vs. text JSON).
 * Accepts Buffer, Uint8Array, ArrayBuffer.
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {boolean}
 */
export function isBinaryFrame(data) {
  if (!data) return false;
  let firstByte;
  if (data instanceof ArrayBuffer) {
    if (data.byteLength < 1) return false;
    firstByte = new Uint8Array(data, 0, 1)[0];
  } else if (data instanceof Uint8Array) {
    if (data.byteLength < 1) return false;
    firstByte = data[0];
  } else {
    return false;
  }
  return firstByte === FRAME_MAGIC;
}

/**
 * Decode a binary frame into `{ type, payload }`. Throws on malformed
 * input. Callers should `isBinaryFrame(buf)` first.
 *
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {{ type: string, payload: Object }}
 */
export function decode(data) {
  let buf, byteOffset, byteLength;
  if (data instanceof ArrayBuffer) {
    buf = data;
    byteOffset = 0;
    byteLength = data.byteLength;
  } else if (data instanceof Uint8Array) {
    buf = data.buffer;
    byteOffset = data.byteOffset;
    byteLength = data.byteLength;
  } else {
    throw new TypeError('decode: expected ArrayBuffer or Uint8Array');
  }
  if (byteLength < HEADER_BYTES) {
    throw new Error('decode: frame too short for header');
  }
  const view = new DataView(buf, byteOffset, byteLength);
  const magic = view.getUint8(0);
  if (magic !== FRAME_MAGIC) {
    throw new Error(`decode: invalid magic 0x${magic.toString(16)}`);
  }
  const code = view.getUint8(1);
  const payloadLen = view.getUint16(2, true);
  if (byteLength < HEADER_BYTES + payloadLen) {
    throw new Error('decode: frame truncated');
  }
  const expected = PAYLOAD_BYTES[code];
  if (expected !== undefined && expected !== payloadLen) {
    throw new Error(`decode: payload length mismatch for code 0x${code.toString(16)}`);
  }

  switch (code) {
    case 0x01:
      return {
        type: 'playback_position',
        payload: {
          position: view.getFloat64(HEADER_BYTES, true),
          percentage: view.getFloat32(HEADER_BYTES + 8, true)
        }
      };
    case 0x03:
      return {
        type: 'tuner:pitch',
        payload: {
          freqHz: view.getFloat32(HEADER_BYTES, true),
          cents: view.getFloat32(HEADER_BYTES + 4, true),
          noteMidi: view.getInt8(HEADER_BYTES + 8)
        }
      };
    case 0x04:
      return {
        type: 'calibration:audio_level',
        payload: {
          levelDb: view.getFloat32(HEADER_BYTES, true),
          peakDb: view.getFloat32(HEADER_BYTES + 4, true)
        }
      };
    case 0x05:
      return {
        type: 'system_lag',
        payload: {
          lagMs: view.getUint16(HEADER_BYTES, true),
          thresholdMs: view.getUint16(HEADER_BYTES + 2, true)
        }
      };
    default:
      throw new Error(`decode: unknown event type 0x${code.toString(16)}`);
  }
}

/**
 * @returns {boolean} True when the given event name has a binary encoder.
 */
export function isBinaryEvent(eventName) {
  return Object.prototype.hasOwnProperty.call(EVENT_TYPES, eventName);
}

/** Map of event-name -> code (for inspection/tests). */
export const SUPPORTED_EVENTS = Object.freeze(
  Object.fromEntries(
    Object.entries(EVENT_NAME_BY_CODE).map(([code, name]) => [name, Number(code)])
  )
);

export default {
  FRAME_MAGIC,
  HEADER_BYTES,
  EVENT_TYPES,
  SUPPORTED_EVENTS,
  encodePlaybackPosition,
  encodeTunerPitch,
  encodeCalibrationAudio,
  encodeSystemLag,
  encodeByEvent,
  isBinaryFrame,
  isBinaryEvent,
  decode
};
