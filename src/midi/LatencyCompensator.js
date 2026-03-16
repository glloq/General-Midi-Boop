// src/midi/LatencyCompensator.js

// Latency calibration constants
const CALIBRATION_TEST_NOTE = 60; // Middle C
const CALIBRATION_TEST_VELOCITY = 64;
const CALIBRATION_TEST_CHANNEL = 0;
const CALIBRATION_TIMEOUT_MS = 5000;
const CALIBRATION_NOTE_DURATION_MS = 50;
const CALIBRATION_PAUSE_BETWEEN_MS = 100;
const RECALIBRATION_DAYS = 7;

class LatencyCompensator {
  constructor(app) {
    this.app = app;
    this.profiles = new Map();
    this.pendingMeasurements = new Map();
    this.calibrationInProgress = false;
    
    this.loadProfilesFromDB();
    this.app.logger.info('LatencyCompensator initialized');
  }

  loadProfilesFromDB() {
    try {
      const profiles = this.app.database.getLatencyProfiles();
      profiles.forEach(profile => {
        this.profiles.set(profile.device_id, {
          latency: profile.latency_ms,
          lastCalibrated: new Date(profile.last_calibrated),
          measurementCount: profile.measurement_count || 1,
          averageLatency: profile.average_latency_ms || profile.latency_ms,
          minLatency: profile.min_latency_ms || profile.latency_ms,
          maxLatency: profile.max_latency_ms || profile.latency_ms
        });
      });
      this.app.logger.info(`Loaded ${profiles.length} latency profiles from database`);
    } catch (error) {
      this.app.logger.error(`Failed to load latency profiles: ${error.message}`);
    }
  }

  async measureLatency(deviceId, iterations = 5) {
    if (this.calibrationInProgress) {
      throw new Error('Calibration already in progress');
    }

    const device = this.app.deviceManager.getDeviceInfo(deviceId);
    if (!device) {
      throw new Error(`Device not found: ${deviceId}`);
    }

    if (!device.input || !device.output) {
      throw new Error(`Device must support both input and output: ${deviceId}`);
    }

    this.calibrationInProgress = true;
    this.app.logger.info(`Starting latency measurement for ${deviceId} (${iterations} iterations)`);

    try {
      const measurements = [];

      for (let i = 0; i < iterations; i++) {
        const latency = await this.measureSingleRoundtrip(deviceId);
        measurements.push(latency);
        this.app.logger.debug(`Measurement ${i + 1}/${iterations}: ${latency.toFixed(2)}ms`);
        
        // Wait between measurements
        await this.sleep(CALIBRATION_PAUSE_BETWEEN_MS);
      }

      // Calculate statistics — divide by 2 to get one-way latency from roundtrip measurement
      const avgLatency = measurements.reduce((a, b) => a + b, 0) / measurements.length / 2;
      const minLatency = Math.min(...measurements) / 2;
      const maxLatency = Math.max(...measurements) / 2;

      // Store profile
      this.setLatency(deviceId, avgLatency, {
        measurementCount: iterations,
        averageLatency: avgLatency,
        minLatency: minLatency,
        maxLatency: maxLatency
      });

      this.calibrationInProgress = false;

      const result = {
        deviceId: deviceId,
        latency: avgLatency,
        min: minLatency,
        max: maxLatency,
        measurements: measurements
      };

      this.app.logger.info(`Latency measurement complete: ${avgLatency.toFixed(2)}ms (min: ${minLatency.toFixed(2)}ms, max: ${maxLatency.toFixed(2)}ms)`);

      // Broadcast result
      if (this.app.wsServer) {
        this.app.wsServer.broadcast('latency_calibration_complete', result);
      }

      return result;
    } catch (error) {
      this.calibrationInProgress = false;
      this.app.logger.error(`Latency measurement failed: ${error.message}`);
      throw error;
    }
  }

  async measureSingleRoundtrip(deviceId) {
    return new Promise((resolve, reject) => {
      const testNote = CALIBRATION_TEST_NOTE;
      const testVelocity = CALIBRATION_TEST_VELOCITY;
      const testChannel = CALIBRATION_TEST_CHANNEL;
      const timeout = CALIBRATION_TIMEOUT_MS;

      let timeoutHandle;
      let messageHandler;

      // Setup message handler - filter strictly on device, note, channel and velocity
      // to avoid false positives from other devices or unrelated MIDI events
      messageHandler = (event) => {
        if (event.device === deviceId &&
            event.type === 'noteon' &&
            event.data.note === testNote &&
            event.data.channel === testChannel &&
            event.data.velocity === testVelocity) {
          
          const endTime = process.hrtime.bigint();
          const latency = Number(endTime - startTime) / 1000000; // ns → ms
          
          // Cleanup
          clearTimeout(timeoutHandle);
          this.app.eventBus.off('midi_message', messageHandler);
          
          resolve(latency);
        }
      };

      // Register handler
      this.app.eventBus.on('midi_message', messageHandler);

      // Set timeout
      timeoutHandle = setTimeout(() => {
        this.app.eventBus.off('midi_message', messageHandler);
        reject(new Error('Latency measurement timeout'));
      }, timeout);

      // Send test note
      const startTime = process.hrtime.bigint();
      this.app.deviceManager.sendMessage(deviceId, 'noteon', {
        channel: testChannel,
        note: testNote,
        velocity: testVelocity
      });

      // Send note off after calibration note duration
      setTimeout(() => {
        this.app.deviceManager.sendMessage(deviceId, 'noteoff', {
          channel: testChannel,
          note: testNote,
          velocity: 0
        });
      }, CALIBRATION_NOTE_DURATION_MS);
    });
  }

  setLatency(deviceId, latency, stats = {}) {
    const profile = {
      latency: latency,
      lastCalibrated: new Date(),
      measurementCount: stats.measurementCount || 1,
      averageLatency: stats.averageLatency || latency,
      minLatency: stats.minLatency || latency,
      maxLatency: stats.maxLatency || latency
    };

    this.profiles.set(deviceId, profile);

    // Save to database
    try {
      this.app.database.saveLatencyProfile({
        device_id: deviceId,
        latency_ms: latency,
        last_calibrated: profile.lastCalibrated.toISOString(),
        measurement_count: profile.measurementCount,
        average_latency_ms: profile.averageLatency,
        min_latency_ms: profile.minLatency,
        max_latency_ms: profile.maxLatency
      });
    } catch (error) {
      this.app.logger.error(`Failed to save latency profile: ${error.message}`);
    }

    this.app.logger.info(`Latency set for ${deviceId}: ${latency.toFixed(2)}ms`);
  }

  getLatency(deviceId) {
    const profile = this.profiles.get(deviceId);
    return profile ? profile.latency : 0;
  }

  getProfile(deviceId) {
    return this.profiles.get(deviceId);
  }

  getAllProfiles() {
    const profiles = [];
    this.profiles.forEach((profile, deviceId) => {
      profiles.push({
        deviceId: deviceId,
        ...profile
      });
    });
    return profiles;
  }

  compensateTimestamp(deviceId, timestamp) {
    const latency = this.getLatency(deviceId);
    return timestamp - (latency / 1000); // Convert ms to seconds
  }

  deleteProfile(deviceId) {
    this.profiles.delete(deviceId);
    
    try {
      this.app.database.deleteLatencyProfile(deviceId);
      this.app.logger.info(`Latency profile deleted for ${deviceId}`);
    } catch (error) {
      this.app.logger.error(`Failed to delete latency profile: ${error.message}`);
    }
  }

  async autoCalibrate(deviceIds) {
    const results = [];
    
    for (const deviceId of deviceIds) {
      try {
        const result = await this.measureLatency(deviceId);
        results.push(result);
      } catch (error) {
        this.app.logger.error(`Auto-calibration failed for ${deviceId}: ${error.message}`);
        results.push({
          deviceId: deviceId,
          error: error.message
        });
      }
    }

    return results;
  }

  shouldRecalibrate(deviceId) {
    const profile = this.profiles.get(deviceId);
    if (!profile) {
      return true; // No profile, needs calibration
    }

    // Recalibrate if older than 7 days
    const daysSinceCalibration = (Date.now() - profile.lastCalibrated.getTime()) / (1000 * 60 * 60 * 24);
    return daysSinceCalibration > RECALIBRATION_DAYS;
  }

  getRecommendedCalibrations() {
    const recommendations = [];
    
    this.profiles.forEach((profile, deviceId) => {
      if (this.shouldRecalibrate(deviceId)) {
        recommendations.push({
          deviceId: deviceId,
          lastCalibrated: profile.lastCalibrated,
          reason: 'outdated'
        });
      }
    });

    // Check for devices without profiles
    const devices = this.app.deviceManager.getDeviceList();
    devices.forEach(device => {
      if (device.input && device.output && !this.profiles.has(device.id)) {
        recommendations.push({
          deviceId: device.id,
          reason: 'missing'
        });
      }
    });

    return recommendations;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default LatencyCompensator;