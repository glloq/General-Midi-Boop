/**
 * @file src/api/commands/LatencyCommands.js
 * @description WebSocket commands for per-device latency profiles plus
 * the audio-driven calibration workflow.
 *
 * Two collaborators are involved:
 *   - {@link LatencyCompensator} — manages persisted profiles and
 *     applies offsets to outgoing MIDI.
 *   - {@link DelayCalibrator} — drives an ALSA capture loop to measure
 *     the round-trip MIDI→audio delay.
 *
 * Registered commands (latency_*):
 *   - `latency_measure` / `_set` / `_get` / `_list` / `_delete`
 *   - `latency_auto_calibrate` / `_recommendations` / `_export`
 *
 * Registered commands (calibrate_*):
 *   - `calibrate_delay`             — single-channel ALSA-based calibration
 *   - `calibrate_list_alsa_devices` — enumerate `arecord -l` devices
 *   - `calibrate_preview_note`      — emit a single test note
 *   - `calibrate_monitor_start` / `_stop` — broadcast live audio levels
 *   - `tuner_monitor_start` / `_stop`     — broadcast live pitch detection
 *
 * Validation: see `latency.schemas.js` for the latency_* family;
 * calibrate_* commands rely on imperative checks inside each handler.
 */

import { ValidationError } from '../../core/errors/index.js';
import DelayCalibrator from '../../audio/DelayCalibrator.js';

/**
 * Run a one-off latency measurement on a device.
 *
 * @param {Object} app
 * @param {{deviceId:string, iterations?:number}} data - `iterations`
 *   defaults to 5; clamped to [1, 50].
 * @returns {Promise<Object>} Measurement result from LatencyCompensator.
 * @throws {ValidationError}
 */
async function latencyMeasure(app, data) {
  if (!data.deviceId) {
    throw new ValidationError('deviceId is required', 'deviceId');
  }
  if (data.iterations !== undefined) {
    const iter = parseInt(data.iterations);
    if (isNaN(iter) || iter < 1 || iter > 50) {
      throw new ValidationError('iterations must be between 1 and 50', 'iterations');
    }
    data.iterations = iter;
  }

  const result = await app.latencyCompensator.measureLatency(
    data.deviceId,
    data.iterations || 5
  );
  return result;
}

/**
 * Manually set the latency profile for a device (bypasses measurement).
 *
 * @param {Object} app
 * @param {{deviceId:string, latency:number}} data - `latency` in ms.
 * @returns {Promise<{success:true}>}
 * @throws {ValidationError}
 */
async function latencySet(app, data) {
  if (!data.deviceId) {
    throw new ValidationError('deviceId is required', 'deviceId');
  }
  if (data.latency === undefined || data.latency === null || isNaN(parseFloat(data.latency))) {
    throw new ValidationError('latency must be a number', 'latency');
  }

  app.latencyCompensator.setLatency(data.deviceId, parseFloat(data.latency));
  return { success: true };
}

/**
 * @param {Object} app
 * @param {{deviceId:string}} data
 * @returns {Promise<{profile:Object}>}
 * @throws {ValidationError}
 */
async function latencyGet(app, data) {
  if (!data.deviceId) {
    throw new ValidationError('deviceId is required', 'deviceId');
  }
  const profile = app.latencyCompensator.getProfile(data.deviceId);
  return { profile: profile };
}

/**
 * @param {Object} app
 * @returns {Promise<{profiles:Object[]}>}
 */
async function latencyList(app) {
  const profiles = app.latencyCompensator.getAllProfiles();
  return { profiles: profiles };
}

/**
 * @param {Object} app
 * @param {{deviceId:string}} data
 * @returns {Promise<{success:true}>}
 * @throws {ValidationError}
 */
async function latencyDelete(app, data) {
  if (!data.deviceId) {
    throw new ValidationError('deviceId is required', 'deviceId');
  }
  app.latencyCompensator.deleteProfile(data.deviceId);
  return { success: true };
}

/**
 * Bulk-measure latency for several devices in parallel.
 *
 * @param {Object} app
 * @param {{deviceIds:string[]}} data
 * @returns {Promise<{results:Object[]}>}
 * @throws {ValidationError}
 */
async function latencyAutoCalibrate(app, data) {
  if (!data.deviceIds || !Array.isArray(data.deviceIds) || data.deviceIds.length === 0) {
    throw new ValidationError('deviceIds must be a non-empty array', 'deviceIds');
  }
  const results = await app.latencyCompensator.autoCalibrate(data.deviceIds);
  return { results: results };
}

/**
 * Devices whose calibration is stale (older than
 * `latency.recalibrationDays`).
 *
 * @param {Object} app
 * @returns {Promise<{recommendations:Object[]}>}
 */
async function latencyRecommendations(app) {
  const recommendations = app.latencyCompensator.getRecommendedCalibrations();
  return { recommendations: recommendations };
}

/**
 * @param {Object} app
 * @returns {Promise<{profiles:Object[]}>}
 */
async function latencyExport(app) {
  const profiles = app.latencyCompensator.getAllProfiles();
  return { profiles: profiles };
}

/**
 * Run audio-driven latency calibration for a single channel of a
 * device. Validates every input bound (channel 0-15, threshold
 * 0.01-0.10, measurements 1-20). Concurrent calibrations are blocked
 * by the calibrator's `isRecording` flag.
 *
 * @param {Object} app
 * @param {{deviceId:string, channel:(number|string), threshold?:number,
 *   alsaDevice?:string, measurements?:number}} data
 * @returns {Promise<Object>} Calibration result.
 * @throws {ValidationError}
 */
async function calibrateDelay(app, data) {
  const { deviceId, channel, threshold, alsaDevice, measurements } = data;

  // Validate required fields
  if (!deviceId) {
    throw new ValidationError('deviceId is required', 'deviceId');
  }
  if (channel === undefined || channel === null) {
    throw new ValidationError('channel is required', 'channel');
  }
  const ch = parseInt(channel);
  if (isNaN(ch) || ch < 0 || ch > 15) {
    throw new ValidationError('channel must be between 0 and 15', 'channel');
  }

  // Validate optional fields
  if (threshold !== undefined) {
    const t = parseFloat(threshold);
    if (isNaN(t) || t < 0.01 || t > 0.10) {
      throw new ValidationError('threshold must be between 0.01 and 0.10', 'threshold');
    }
  }
  if (measurements !== undefined) {
    const m = parseInt(measurements);
    if (isNaN(m) || m < 1 || m > 20) {
      throw new ValidationError('measurements must be between 1 and 20', 'measurements');
    }
  }
  if (alsaDevice !== undefined) {
    if (!DelayCalibrator.isValidAlsaDevice(alsaDevice)) {
      throw new ValidationError('Invalid ALSA device format', 'alsaDevice');
    }
  }

  // Guard against concurrent calibration
  if (app.delayCalibrator.isRecording) {
    throw new ValidationError('Calibration already in progress');
  }

  // Configure calibrator if options provided
  if (threshold !== undefined) {
    app.delayCalibrator.setThreshold(parseFloat(threshold));
  }
  if (alsaDevice !== undefined) {
    app.delayCalibrator.setAlsaDevice(alsaDevice);
  }

  // Run calibration
  const result = await app.delayCalibrator.calibrateInstrument(
    deviceId,
    ch,
    { measurements: measurements !== undefined ? parseInt(measurements) : undefined }
  );

  return result;
}

/**
 * @param {Object} app
 * @returns {Promise<{success:true, devices:Object[]}>}
 */
async function calibrateListAlsaDevices(app) {
  const devices = await app.delayCalibrator.listAlsaDevices();
  return { success: true, devices: devices };
}

/**
 * Emit a single test note (used by the calibration UI to confirm the
 * route works before starting a measurement).
 *
 * @param {Object} app
 * @param {{deviceId:string, channel:(number|string)}} data
 * @returns {Promise<{success:true}>}
 * @throws {ValidationError}
 */
async function calibratePreviewNote(app, data) {
  if (!data.deviceId) {
    throw new ValidationError('deviceId is required', 'deviceId');
  }
  if (data.channel === undefined || data.channel === null) {
    throw new ValidationError('channel is required', 'channel');
  }
  const ch = parseInt(data.channel);
  if (isNaN(ch) || ch < 0 || ch > 15) {
    throw new ValidationError('channel must be between 0 and 15', 'channel');
  }

  await app.delayCalibrator.sendTestNote(data.deviceId, ch);
  return { success: true };
}

/**
 * Start broadcasting live ALSA capture levels as
 * `calibration:audio_level` WebSocket events so the UI can render a
 * realtime VU meter while the user adjusts gain.
 *
 * @param {Object} app
 * @param {{alsaDevice?:string}} data
 * @returns {Promise<{success:true}>}
 * @throws {ValidationError}
 */
async function calibrateMonitorStart(app, data) {
  const alsaDevice = data.alsaDevice;

  if (alsaDevice !== undefined && !DelayCalibrator.isValidAlsaDevice(alsaDevice)) {
    throw new ValidationError('Invalid ALSA device format', 'alsaDevice');
  }

  // Idempotent: drop any previous monitor before starting a new one
  // (otherwise calling `start` twice leaks the first capture process).
  app.delayCalibrator.stopMonitoring();

  app.delayCalibrator.startMonitoring((level) => {
    if (app.wsServer && app.wsServer.broadcast) {
      app.wsServer.broadcast('calibration:audio_level', level);
    }
  }, { alsaDevice });

  return { success: true };
}

/**
 * @param {Object} app
 * @returns {Promise<{success:true}>}
 */
async function calibrateMonitorStop(app) {
  app.delayCalibrator.stopMonitoring();
  return { success: true };
}

/**
 * Start broadcasting real-time pitch detection results as
 * `tuner:pitch` WebSocket events. Uses the same arecord pipeline as the
 * calibration monitor but accumulates samples into a 2048-sample window
 * and runs autocorrelation-based pitch detection server-side.
 *
 * @param {Object} app
 * @param {{alsaDevice?:string}} data
 * @returns {Promise<{success:true}>}
 * @throws {ValidationError}
 */
async function tunerMonitorStart(app, data) {
  const alsaDevice = data && data.alsaDevice;

  if (alsaDevice !== undefined && !DelayCalibrator.isValidAlsaDevice(alsaDevice)) {
    throw new ValidationError('Invalid ALSA device format', 'alsaDevice');
  }

  // Idempotent: drop any previous tuner monitor before starting a new one.
  app.delayCalibrator.stopTunerMonitoring();

  app.delayCalibrator.startTunerMonitoring((payload) => {
    if (app.wsServer && app.wsServer.broadcast) {
      app.wsServer.broadcast('tuner:pitch', payload);
    }
  }, { alsaDevice });

  return { success: true };
}

/**
 * @param {Object} app
 * @returns {Promise<{success:true}>}
 */
async function tunerMonitorStop(app) {
  app.delayCalibrator.stopTunerMonitoring();
  return { success: true };
}

/**
 * @param {import('../CommandRegistry.js').default} registry
 * @param {Object} app
 * @returns {void}
 */
export function register(registry, app) {
  registry.register('latency_measure', (data) => latencyMeasure(app, data));
  registry.register('latency_set', (data) => latencySet(app, data));
  registry.register('latency_get', (data) => latencyGet(app, data));
  registry.register('latency_list', () => latencyList(app));
  registry.register('latency_delete', (data) => latencyDelete(app, data));
  registry.register('latency_auto_calibrate', (data) => latencyAutoCalibrate(app, data));
  registry.register('latency_recommendations', () => latencyRecommendations(app));
  registry.register('latency_export', () => latencyExport(app));
  registry.register('calibrate_delay', (data) => calibrateDelay(app, data));
  registry.register('calibrate_list_alsa_devices', () => calibrateListAlsaDevices(app));
  registry.register('calibrate_preview_note', (data) => calibratePreviewNote(app, data));
  registry.register('calibrate_monitor_start', (data) => calibrateMonitorStart(app, data));
  registry.register('calibrate_monitor_stop', () => calibrateMonitorStop(app));
  registry.register('tuner_monitor_start', (data) => tunerMonitorStart(app, data));
  registry.register('tuner_monitor_stop', () => tunerMonitorStop(app));
}
