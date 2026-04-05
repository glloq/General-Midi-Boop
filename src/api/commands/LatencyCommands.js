// src/api/commands/LatencyCommands.js

import { ValidationError } from '../../core/errors/index.js';
import DelayCalibrator from '../../audio/DelayCalibrator.js';

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

async function latencyGet(app, data) {
  if (!data.deviceId) {
    throw new ValidationError('deviceId is required', 'deviceId');
  }
  const profile = app.latencyCompensator.getProfile(data.deviceId);
  return { profile: profile };
}

async function latencyList(app) {
  const profiles = app.latencyCompensator.getAllProfiles();
  return { profiles: profiles };
}

async function latencyDelete(app, data) {
  if (!data.deviceId) {
    throw new ValidationError('deviceId is required', 'deviceId');
  }
  app.latencyCompensator.deleteProfile(data.deviceId);
  return { success: true };
}

async function latencyAutoCalibrate(app, data) {
  if (!data.deviceIds || !Array.isArray(data.deviceIds) || data.deviceIds.length === 0) {
    throw new ValidationError('deviceIds must be a non-empty array', 'deviceIds');
  }
  const results = await app.latencyCompensator.autoCalibrate(data.deviceIds);
  return { results: results };
}

async function latencyRecommendations(app) {
  const recommendations = app.latencyCompensator.getRecommendedCalibrations();
  return { recommendations: recommendations };
}

async function latencyExport(app) {
  const profiles = app.latencyCompensator.getAllProfiles();
  return { profiles: profiles };
}

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

async function calibrateListAlsaDevices(app) {
  const devices = await app.delayCalibrator.listAlsaDevices();
  return { success: true, devices: devices };
}

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

async function calibrateMonitorStart(app, data) {
  const alsaDevice = data.alsaDevice;

  if (alsaDevice !== undefined && !DelayCalibrator.isValidAlsaDevice(alsaDevice)) {
    throw new ValidationError('Invalid ALSA device format', 'alsaDevice');
  }

  // Stop existing monitor if running
  app.delayCalibrator.stopMonitoring();

  // Start monitoring and broadcast levels via WebSocket
  app.delayCalibrator.startMonitoring((level) => {
    if (app.wsServer && app.wsServer.broadcast) {
      app.wsServer.broadcast('calibration:audio_level', level);
    }
  }, { alsaDevice });

  return { success: true };
}

async function calibrateMonitorStop(app) {
  app.delayCalibrator.stopMonitoring();
  return { success: true };
}

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
}
