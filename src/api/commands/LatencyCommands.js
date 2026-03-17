// src/api/commands/LatencyCommands.js

async function latencyMeasure(app, data) {
  const result = await app.latencyCompensator.measureLatency(
    data.deviceId,
    data.iterations || 5
  );
  return result;
}

async function latencySet(app, data) {
  app.latencyCompensator.setLatency(data.deviceId, data.latency);
  return { success: true };
}

async function latencyGet(app, data) {
  const profile = app.latencyCompensator.getProfile(data.deviceId);
  return { profile: profile };
}

async function latencyList(app) {
  const profiles = app.latencyCompensator.getAllProfiles();
  return { profiles: profiles };
}

async function latencyDelete(app, data) {
  app.latencyCompensator.deleteProfile(data.deviceId);
  return { success: true };
}

async function latencyAutoCalibrate(app, data) {
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

  // Configure calibrator if options provided
  if (threshold !== undefined) {
    app.delayCalibrator.setThreshold(threshold);
  }
  if (alsaDevice !== undefined) {
    app.delayCalibrator.setAlsaDevice(alsaDevice);
  }

  // Run calibration
  const result = await app.delayCalibrator.calibrateInstrument(
    deviceId,
    channel,
    { measurements }
  );

  return result;
}

async function calibrateListAlsaDevices(app) {
  const devices = await app.delayCalibrator.listAlsaDevices();
  return { devices: devices };
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
}
