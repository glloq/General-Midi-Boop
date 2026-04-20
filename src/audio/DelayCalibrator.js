/**
 * @file src/audio/DelayCalibrator.js
 * @description Audio-driven instrument latency calibrator. Uses ALSA's
 * `arecord` (Raspberry Pi-friendly) to capture audio from a microphone
 * placed near the instrument, then measures the delay between emitting
 * a test MIDI note and detecting the resulting sound peak.
 *
 * The captured per-channel offset is fed back into
 * {@link LatencyCompensator} via the `instrument_settings.sync_delay`
 * column so future playback events can be pre-shifted.
 *
 * Supports two workflows:
 *   - One-shot calibration (`calibrateInstrument`).
 *   - Live monitoring (`startMonitoring`/`stopMonitoring`) used by the
 *     UI to render a real-time VU meter while the operator adjusts gain.
 */

import { spawn } from 'child_process';
import { performance } from 'perf_hooks';

class DelayCalibrator {
  /**
   * Validate ALSA device identifier format.
   * Accepts: hw:X,Y  plughw:X,Y  default  sysdefault  sysdefault:X
   * @param {string} device - ALSA device string
   * @returns {boolean}
   */
  static isValidAlsaDevice(device) {
    if (typeof device !== 'string' || device.length === 0) return false;
    return /^(plug)?(hw|sysdefault|default)(:\d+,?\d*)?\s*$/.test(device.trim());
  }

  constructor(midiController, logger) {
    this.midiController = midiController;
    this.logger = logger;

    // Recording state
    this.recording = null;
    this.audioBuffer = [];
    this.isRecording = false;

    // Default configuration
    this.config = {
      alsaDevice: 'hw:1,0', // ALSA device (configurable)
      sampleRate: 16000,     // 16 kHz
      format: 'S16_LE',      // 16-bit signed little-endian
      channels: 1,           // Mono
      threshold: 0.02,       // RMS detection threshold
      noteVelocity: 100,     // Test note velocity
      noteDuration: 500,     // Note duration (ms)
      testNote: 60,          // C4 (Middle C)
      preRecordTime: 100,    // Pre-note recording time (ms)
      maxWaitTime: 2000,     // Detection timeout (ms)
      measurements: 5        // Number of measurements per instrument
    };
  }

  /**
   * Configure the ALSA device
   * @param {string} device - E.g.: 'hw:1,0' or 'plughw:1,0'
   */
  setAlsaDevice(device) {
    if (!DelayCalibrator.isValidAlsaDevice(device)) {
      throw new Error(`Invalid ALSA device format: ${device}`);
    }
    this.config.alsaDevice = device;
    this.logger.info(`ALSA device set to: ${device}`);
  }

  /**
   * Configure the detection threshold
   * @param {number} threshold - RMS threshold (0.01 - 0.10)
   */
  setThreshold(threshold) {
    this.config.threshold = Math.max(0.01, Math.min(0.10, threshold));
    this.logger.info(`Detection threshold set to: ${this.config.threshold}`);
  }

  /**
   * Calibrate the delay of an instrument
   * @param {number} deviceId - MIDI device ID
   * @param {number} channel - MIDI channel of the instrument
   * @param {Object} options - Calibration options
   * @returns {Promise<Object>} - { delay, measurements, confidence }
   */
  async calibrateInstrument(deviceId, channel, options = {}) {
    const measurements = options.measurements || this.config.measurements;

    try {
      this.logger.info(`Starting calibration for device ${deviceId}, channel ${channel}`);

      const delays = [];

      // Perform multiple measurements
      for (let i = 0; i < measurements; i++) {
        this.logger.debug(`Measurement ${i + 1}/${measurements}`);

        const delay = await this.singleMeasurement(deviceId, channel);

        if (delay !== null) {
          delays.push(delay);
        }

        // Pause between measurements
        if (i < measurements - 1) {
          await this.sleep(1000);
        }
      }

      // Calculate the median delay (more robust than the mean)
      if (delays.length === 0) {
        throw new Error('No valid measurements detected');
      }

      delays.sort((a, b) => a - b);
      const mid = Math.floor(delays.length / 2);
      const median = delays.length % 2 !== 0
        ? delays[mid]
        : (delays[mid - 1] + delays[mid]) / 2;

      // Calculate confidence (based on standard deviation)
      const mean = delays.reduce((sum, d) => sum + d, 0) / delays.length;
      const variance = delays.reduce((sum, d) => sum + Math.pow(d - mean, 2), 0) / delays.length;
      const stdDev = Math.sqrt(variance);

      // Confidence: 100% if stdDev < 5ms, decreasing to 0% at 50ms
      const confidence = Math.max(0, Math.min(100, 100 - (stdDev / 50) * 100));

      return {
        success: true,
        delay: Math.round(median),
        measurements: delays,
        mean: Math.round(mean),
        stdDev: Math.round(stdDev),
        confidence: Math.round(confidence)
      };
    } catch (error) {
      this.logger.error(`Calibration failed: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Perform a single delay measurement
   * @param {number} deviceId
   * @param {number} channel
   * @returns {Promise<number|null>} - Delay in ms or null if failed
   */
  async singleMeasurement(deviceId, channel) {
    try {
      // Reset the buffer
      this.audioBuffer = [];

      // Start recording
      this.startRecording();

      // Wait for recording to start
      await this.sleep(this.config.preRecordTime);

      // Send the MIDI note and capture the timestamp
      const sendTime = performance.now();
      await this.sendTestNote(deviceId, channel);

      // Wait for sound detection
      const detectionTime = await this.waitForSound(this.config.maxWaitTime);

      // Stop recording
      await this.stopRecording();

      if (detectionTime === null) {
        this.logger.warn('No sound detected within timeout');
        return null;
      }

      // Calculate the delay
      const delay = detectionTime - sendTime;
      this.logger.debug(`Delay measured: ${delay.toFixed(2)} ms`);

      return delay;
    } catch (error) {
      await this.stopRecording();
      throw error;
    }
  }

  /**
   * Start audio recording via arecord
   */
  startRecording() {
    if (this.isRecording) {
      throw new Error('Recording already in progress');
    }

    this.audioBuffer = [];
    this.isRecording = true;

    // Spawn arecord process
    this.recording = spawn('arecord', [
      '-D', this.config.alsaDevice,
      '-f', this.config.format,
      '-r', this.config.sampleRate.toString(),
      '-c', this.config.channels.toString(),
      '-t', 'raw'
    ]);

    // Capture audio data
    this.recording.stdout.on('data', (chunk) => {
      if (this.isRecording) {
        this.audioBuffer.push(chunk);
      }
    });

    // Handle errors
    this.recording.stderr.on('data', (data) => {
      this.logger.warn(`arecord stderr: ${data}`);
    });

    this.recording.on('error', (error) => {
      this.logger.error(`arecord error: ${error.message}`);
      this.isRecording = false;
    });

    this.logger.debug('Recording started');
  }

  /**
   * Stop audio recording
   */
  stopRecording() {
    return new Promise((resolve) => {
      if (this.recording) {
        const proc = this.recording;
        this.recording = null;
        this.isRecording = false;

        proc.once('close', () => resolve());
        proc.kill('SIGTERM');

        // Fallback: force kill if process doesn't exit within 1s
        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch (_) { /* already exited */ }
          resolve();
        }, 1000);
      } else {
        this.isRecording = false;
        resolve();
      }
    });
  }

  /**
   * Send a test MIDI note
   * @param {number} deviceId
   * @param {number} channel
   */
  async sendTestNote(deviceId, channel) {
    const note = this.config.testNote;
    const velocity = this.config.noteVelocity;

    // Note ON
    this.midiController.sendMessage(deviceId, 'noteon', {
      channel: channel,
      note: note,
      velocity: velocity
    });

    // Wait for the note duration
    await this.sleep(this.config.noteDuration);

    // Note OFF
    this.midiController.sendMessage(deviceId, 'noteoff', {
      channel: channel,
      note: note,
      velocity: 0
    });
  }

  /**
   * Wait for sound detection in the audio buffer
   * @param {number} timeoutMs - Timeout in milliseconds
   * @returns {Promise<number|null>} - Detection timestamp or null
   */
  waitForSound(timeoutMs) {
    return new Promise((resolve) => {
      const startTime = performance.now();
      const checkInterval = 10; // Check every 10ms
      let lastCheckedIndex = 0;

      const interval = setInterval(() => {
        // Check timeout
        if (performance.now() - startTime > timeoutMs) {
          clearInterval(interval);
          resolve(null);
          return;
        }

        // Only check new chunks since the last check
        while (lastCheckedIndex < this.audioBuffer.length) {
          const chunk = this.audioBuffer[lastCheckedIndex];
          const rms = this.calculateRMS(chunk);

          if (rms > this.config.threshold) {
            clearInterval(interval);
            resolve(performance.now());
            return;
          }
          lastCheckedIndex++;
        }
      }, checkInterval);
    });
  }

  /**
   * Calculate the RMS (Root Mean Square) of an audio buffer
   * @param {Buffer} buffer - Audio buffer in S16_LE format
   * @returns {number} - RMS value (0.0 - 1.0)
   */
  calculateRMS(buffer) {
    if (!buffer || buffer.length < 2) {
      return 0;
    }

    // Ensure even byte count for 16-bit samples
    const byteLength = buffer.length - (buffer.length % 2);
    let sum = 0;
    const sampleCount = byteLength / 2; // 2 bytes per sample (16-bit)

    for (let i = 0; i < byteLength; i += 2) {
      // Read 16-bit signed little-endian sample
      const sample = buffer.readInt16LE(i);

      // Normalize to -1.0 - 1.0
      const normalized = sample / 32768.0;

      // Accumulate the square
      sum += normalized * normalized;
    }

    // Calculate the square root of the mean
    return Math.sqrt(sum / sampleCount);
  }

  /**
   * List available ALSA devices
   * @returns {Promise<Array>} - List of devices
   */
  async listAlsaDevices() {
    return new Promise((resolve, reject) => {
      const arecord = spawn('arecord', ['-l']);
      let output = '';

      arecord.stdout.on('data', (data) => {
        output += data.toString();
      });

      arecord.on('close', (code) => {
        if (code !== 0) {
          reject(new Error('Failed to list ALSA devices'));
          return;
        }

        // Parse the output
        const devices = [];
        const lines = output.split('\n');

        for (const line of lines) {
          // French format: "carte 1: ... périphérique 0: ..."
          // English format: "card 1: ... device 0: ..."
          const match = line.match(/(?:card|carte) (\d+):.*(?:device|périphérique) (\d+):/i);
          if (match) {
            const card = match[1];
            const device = match[2];
            devices.push({
              id: `hw:${card},${device}`,
              name: line.split(':')[1]?.trim() || `Device ${card},${device}`
            });
          }
        }

        resolve(devices);
      });

      arecord.on('error', (error) => {
        reject(error);
      });
    });
  }

  // =========================================================================
  // MONITORING (real-time VU-meter)
  // =========================================================================

  /**
   * Start continuous audio monitoring for VU-meter
   * Sends the RMS level via the callback approximately every ~100ms
   * @param {Function} callback - Called with { rms, peak }
   * @param {Object} [options] - Options (alsaDevice)
   */
  startMonitoring(callback, options = {}) {
    if (this.monitorProcess) {
      this.stopMonitoring();
    }

    const device = options.alsaDevice || this.config.alsaDevice;
    if (!DelayCalibrator.isValidAlsaDevice(device)) {
      throw new Error(`Invalid ALSA device format: ${device}`);
    }
    this.monitorCallback = callback;
    this.monitorPeakRMS = 0;

    this.monitorProcess = spawn('arecord', [
      '-D', device,
      '-f', this.config.format,
      '-r', this.config.sampleRate.toString(),
      '-c', this.config.channels.toString(),
      '-t', 'raw'
    ]);

    this.monitorProcess.stdout.on('data', (chunk) => {
      const rms = this.calculateRMS(chunk);
      if (rms > this.monitorPeakRMS) this.monitorPeakRMS = rms;

      if (this.monitorCallback) {
        this.monitorCallback({ rms, peak: this.monitorPeakRMS });
      }
    });

    this.monitorProcess.stderr.on('data', (data) => {
      // arecord writes info to stderr, ignore non-errors
      const msg = data.toString();
      if (msg.includes('Error') || msg.includes('error')) {
        this.logger.warn(`Monitor arecord stderr: ${msg}`);
      }
    });

    this.monitorProcess.on('error', (error) => {
      this.logger.error(`Monitor arecord error: ${error.message}`);
      this.monitorProcess = null;
    });

    this.monitorProcess.on('close', () => {
      this.monitorProcess = null;
    });

    // Decay peak over time
    this.monitorPeakInterval = setInterval(() => {
      this.monitorPeakRMS *= 0.9;
    }, 500);

    this.logger.info('Audio monitoring started');
  }

  /**
   * Stop audio monitoring
   */
  stopMonitoring() {
    if (this.monitorProcess) {
      this.monitorProcess.kill('SIGTERM');
      this.monitorProcess = null;
    }

    if (this.monitorPeakInterval) {
      clearInterval(this.monitorPeakInterval);
      this.monitorPeakInterval = null;
    }

    this.monitorCallback = null;
    this.monitorPeakRMS = 0;
    this.logger.info('Audio monitoring stopped');
  }

  /**
   * Decode an S16_LE audio buffer into a Float32Array normalized to [-1, 1].
   * @param {Buffer} buffer
   * @returns {Float32Array}
   */
  decodeS16LE(buffer) {
    const byteLength = buffer.length - (buffer.length % 2);
    const out = new Float32Array(byteLength / 2);
    for (let i = 0, j = 0; i < byteLength; i += 2, j++) {
      out[j] = buffer.readInt16LE(i) / 32768.0;
    }
    return out;
  }

  /**
   * Estimate the fundamental frequency of a mono audio window using
   * normalized autocorrelation with parabolic interpolation. Adequate
   * for monophonic instruments (guitar, violin, voice).
   *
   * The algorithm first walks past the autocorrelation's initial
   * positive lobe and the following negative region, then locates the
   * strongest peak in the subsequent positive region — this avoids
   * reporting sub-period lags that still have a positive correlation
   * value but lie on the decay of the lag-0 peak.
   *
   * @param {Float32Array} buf - Audio samples normalized to [-1, 1]
   * @param {number} sampleRate
   * @returns {{ freq: number, confidence: number, rms: number }}
   */
  detectPitch(buf, sampleRate) {
    const SIZE = buf.length;
    if (SIZE < 64) return { freq: 0, confidence: 0, rms: 0 };

    // RMS gate: ignore silence / low-level noise
    let rms = 0;
    for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / SIZE);
    if (rms < 0.01) return { freq: 0, confidence: 0, rms };

    // Trim to the stable part of the window
    const thr = 0.2;
    let r1 = 0, r2 = SIZE - 1;
    for (let i = 0; i < SIZE / 2; i++) {
      if (Math.abs(buf[i]) >= thr) { r1 = i; break; }
    }
    for (let i = 1; i < SIZE / 2; i++) {
      if (Math.abs(buf[SIZE - i]) >= thr) { r2 = SIZE - i; break; }
    }
    if (r2 - r1 < 32) return { freq: 0, confidence: 0, rms };
    const N = r2 - r1;

    // Restrict lag range to musical frequencies: 30 Hz .. 2000 Hz
    const minLag = Math.max(2, Math.floor(sampleRate / 2000));
    const maxLag = Math.min(Math.floor(N / 2), Math.floor(sampleRate / 30));
    if (minLag >= maxLag) return { freq: 0, confidence: 0, rms };

    // Compute normalized autocorrelation over the full lag range.
    const c = new Float32Array(maxLag + 2);
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i < N - lag; i++) {
        sum += buf[r1 + i] * buf[r1 + i + lag];
      }
      c[lag] = sum / (N - lag);
    }

    // Walk past the initial positive lobe (decaying from lag 0) ...
    let lag = minLag;
    while (lag <= maxLag && c[lag] > 0) lag++;
    // ... then past the subsequent negative region.
    while (lag <= maxLag && c[lag] <= 0) lag++;
    if (lag > maxLag) return { freq: 0, confidence: 0, rms };

    // From here, find the strongest local peak. Stop once we've clearly
    // passed the peak (drop below 60% of the running best).
    let bestLag = -1;
    let bestCorr = 0;
    for (; lag <= maxLag; lag++) {
      const corr = c[lag];
      if (corr > bestCorr) {
        bestCorr = corr;
        bestLag = lag;
      } else if (bestLag > 0 && corr < bestCorr * 0.6) {
        break;
      }
    }

    if (bestLag <= 0 || bestCorr <= 0) return { freq: 0, confidence: 0, rms };

    // Parabolic interpolation for sub-sample precision.
    const y1 = c[bestLag - 1] || 0;
    const y2 = c[bestLag];
    const y3 = c[bestLag + 1] || 0;
    const denom = 2 * (2 * y2 - y1 - y3);
    const shift = denom !== 0 ? (y3 - y1) / denom : 0;
    const refinedLag = bestLag + Math.max(-1, Math.min(1, shift));

    const freq = sampleRate / refinedLag;
    // Confidence proxy: peak strength relative to signal energy (c[minLag]
    // is a decent proxy for near-zero-lag energy given our minLag is small).
    const energy = c[minLag] > 0 ? c[minLag] : bestCorr;
    const confidence = Math.min(1, bestCorr / (energy || 1));

    return { freq, confidence, rms };
  }

  /**
   * Start a continuous pitch-monitoring loop, invoking `callback` with
   * `{ rms, freq, confidence }` each time a full analysis window has
   * been accumulated (~128 ms at 16 kHz). Shares the same `arecord`
   * pipeline layout as {@link startMonitoring}, but is kept separate to
   * avoid disturbing the VU-meter contract when the tuner modal is in use.
   *
   * @param {Function} callback
   * @param {Object} [options] - { alsaDevice?: string, windowSize?: number }
   */
  startTunerMonitoring(callback, options = {}) {
    if (this.tunerProcess) {
      this.stopTunerMonitoring();
    }

    const device = options.alsaDevice || this.config.alsaDevice;
    if (!DelayCalibrator.isValidAlsaDevice(device)) {
      throw new Error(`Invalid ALSA device format: ${device}`);
    }

    const windowSize = options.windowSize || 2048;
    this.tunerCallback = callback;
    this.tunerWindow = new Float32Array(windowSize);
    this.tunerWindowFilled = 0;

    this.tunerProcess = spawn('arecord', [
      '-D', device,
      '-f', this.config.format,
      '-r', this.config.sampleRate.toString(),
      '-c', this.config.channels.toString(),
      '-t', 'raw'
    ]);

    this.tunerProcess.stdout.on('data', (chunk) => {
      const samples = this.decodeS16LE(chunk);
      let offset = 0;
      while (offset < samples.length) {
        const remaining = windowSize - this.tunerWindowFilled;
        const toCopy = Math.min(remaining, samples.length - offset);
        this.tunerWindow.set(samples.subarray(offset, offset + toCopy), this.tunerWindowFilled);
        this.tunerWindowFilled += toCopy;
        offset += toCopy;

        if (this.tunerWindowFilled === windowSize) {
          const result = this.detectPitch(this.tunerWindow, this.config.sampleRate);
          if (this.tunerCallback) {
            try { this.tunerCallback(result); } catch (e) {
              this.logger.warn(`Tuner callback threw: ${e.message}`);
            }
          }
          this.tunerWindowFilled = 0;
        }
      }
    });

    this.tunerProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Error') || msg.includes('error')) {
        this.logger.warn(`Tuner arecord stderr: ${msg}`);
      }
    });

    this.tunerProcess.on('error', (error) => {
      this.logger.error(`Tuner arecord error: ${error.message}`);
      this.tunerProcess = null;
    });

    this.tunerProcess.on('close', () => {
      this.tunerProcess = null;
    });

    this.logger.info(`Tuner monitoring started on ${device}`);
  }

  /**
   * Stop the pitch-monitoring loop.
   */
  stopTunerMonitoring() {
    if (this.tunerProcess) {
      this.tunerProcess.kill('SIGTERM');
      this.tunerProcess = null;
    }
    this.tunerCallback = null;
    this.tunerWindow = null;
    this.tunerWindowFilled = 0;
    this.logger.info('Tuner monitoring stopped');
  }

  /**
   * Utility: sleep
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Clean up resources
   */
  destroy() {
    this.stopRecording();
    this.stopMonitoring();
    this.stopTunerMonitoring();
  }
}

export default DelayCalibrator;
