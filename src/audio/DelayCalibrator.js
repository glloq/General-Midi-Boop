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

    // Biquad filter state for the tuner path. Persists across windows so
    // IIR transients do not ring at each analysis boundary. Coefficients
    // are lazily initialized by _buildFilterCoeffs() on first use.
    this._filter = {
      hp: { x1: 0, x2: 0, y1: 0, y2: 0 },
      lp: { x1: 0, x2: 0, y1: 0, y2: 0 },
      coeffs: null
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
   * Build and cache RBJ-cookbook biquad coefficients for the tuner path:
   * a 60 Hz high-pass (kills AC hum and handling rumble) cascaded into
   * a 3 kHz low-pass (kills attack hiss and hash above the useful
   * instrument range). Both biquads use Q = 1/√2 (Butterworth flat).
   *
   * @param {number} sampleRate
   */
  _buildFilterCoeffs(sampleRate) {
    const Q = Math.SQRT1_2;
    const make = (kind, f0) => {
      const w0 = 2 * Math.PI * f0 / sampleRate;
      const cosw = Math.cos(w0);
      const sinw = Math.sin(w0);
      const alpha = sinw / (2 * Q);
      let b0, b1, b2;
      if (kind === 'hp') {
        b0 = (1 + cosw) / 2;
        b1 = -(1 + cosw);
        b2 = (1 + cosw) / 2;
      } else { // lp
        b0 = (1 - cosw) / 2;
        b1 = 1 - cosw;
        b2 = (1 - cosw) / 2;
      }
      const a0 = 1 + alpha;
      const a1 = -2 * cosw;
      const a2 = 1 - alpha;
      return {
        b0: b0 / a0, b1: b1 / a0, b2: b2 / a0,
        a1: a1 / a0, a2: a2 / a0
      };
    };
    this._filter.coeffs = {
      hp: make('hp', 60),
      lp: make('lp', 3000),
      sampleRate
    };
  }

  /**
   * Reset biquad state. Call when the arecord stream starts so pre-existing
   * filter history does not bleed into a fresh capture.
   */
  _resetFilterState() {
    this._filter.hp.x1 = this._filter.hp.x2 = this._filter.hp.y1 = this._filter.hp.y2 = 0;
    this._filter.lp.x1 = this._filter.lp.x2 = this._filter.lp.y1 = this._filter.lp.y2 = 0;
  }

  /**
   * In-place apply the HP→LP biquad cascade to `samples`. Filter state
   * advances continuously so this MUST be called exactly once on every
   * sample in capture order.
   *
   * @param {Float32Array} samples
   * @param {number} sampleRate
   */
  _applyFilter(samples, sampleRate) {
    if (!this._filter.coeffs || this._filter.coeffs.sampleRate !== sampleRate) {
      this._buildFilterCoeffs(sampleRate);
    }
    const { hp: hc, lp: lc } = this._filter.coeffs;
    const hp = this._filter.hp;
    const lp = this._filter.lp;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      // High-pass
      const y = hc.b0 * x + hc.b1 * hp.x1 + hc.b2 * hp.x2 - hc.a1 * hp.y1 - hc.a2 * hp.y2;
      hp.x2 = hp.x1; hp.x1 = x;
      hp.y2 = hp.y1; hp.y1 = y;
      // Low-pass (input = HP output)
      const z = lc.b0 * y + lc.b1 * lp.x1 + lc.b2 * lp.x2 - lc.a1 * lp.y1 - lc.a2 * lp.y2;
      lp.x2 = lp.x1; lp.x1 = y;
      lp.y2 = lp.y1; lp.y1 = z;
      samples[i] = z;
    }
  }

  /**
   * Estimate the fundamental frequency of a mono audio window using the
   * McLeod Pitch Method (MPM): a normalized square difference function
   * (NSDF) whose key-maxima are scanned and picked via the
   * "first peak ≥ 0.9 × global max" rule. Amplitude-invariant and
   * robust to rich-harmonic signals — significantly better than plain
   * ACF on stringed instruments.
   *
   * @param {Float32Array} buf - Audio samples normalized to [-1, 1].
   *   The buffer is expected to have been pre-filtered by _applyFilter().
   * @param {number} sampleRate
   * @returns {{ freq: number, confidence: number, rms: number }}
   */
  detectPitch(buf, sampleRate) {
    const N = buf.length;
    if (N < 128) return { freq: 0, confidence: 0, rms: 0 };

    // RMS gate on the filtered signal.
    let rms = 0;
    for (let i = 0; i < N; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / N);
    if (rms < 0.008) return { freq: 0, confidence: 0, rms };

    // Pitch search range: ~55 Hz (A1) to ~1200 Hz (~D6). Covers every
    // string on guitar/bass/violin/viola/cello/ukulele and most voices.
    const minLag = Math.max(2, Math.floor(sampleRate / 1200));
    const maxLag = Math.min(Math.floor(N / 2), Math.floor(sampleRate / 55));
    if (minLag >= maxLag) return { freq: 0, confidence: 0, rms };

    // NSDF: n(τ) = 2 · r(τ) / m(τ),  where
    //   r(τ) = Σ_{i=0..W-1} x[i]·x[i+τ]
    //   m(τ) = Σ_{i=0..W-1} (x[i]² + x[i+τ]²)
    // W is fixed so that x[i+τ] is in range for every τ in [0, maxLag].
    // Compute from τ=1 (not minLag) so we can detect the NSDF's first
    // zero crossing — MPM's key-maxima scan must start after that crossing.
    const W = N - maxLag;
    const nsdf = new Float32Array(maxLag + 2);

    let sumSq0 = 0;
    for (let i = 0; i < W; i++) sumSq0 += buf[i] * buf[i];

    // sumSqR tracks Σ x[i+τ]² for i in [0, W). Start at τ=0 and roll
    // forward with sumSqR += x[τ+W-1]² - x[τ-1]² as τ increments.
    let sumSqR = sumSq0;

    for (let tau = 1; tau <= maxLag; tau++) {
      let r = 0;
      for (let i = 0; i < W; i++) r += buf[i] * buf[i + tau];
      const m = sumSq0 + sumSqR;
      nsdf[tau] = m > 0 ? (2 * r) / m : 0;
      // Roll sumSqR to the next tau (guard against the final out-of-range read).
      if (tau + W < N) {
        sumSqR += buf[tau + W] * buf[tau + W] - buf[tau] * buf[tau];
      }
    }

    // Key-maxima scan. Per McLeod & Wyvill 2005:
    //   1. The NSDF starts at 1 at lag 0 and descends through a positive
    //      lobe before reaching its first zero crossing at ~T/4 where T
    //      is the fundamental period.
    //   2. Walk past that initial positive lobe, then collect exactly one
    //      (highest) key maximum per subsequent positive region.
    let tau = 1;
    while (tau <= maxLag && nsdf[tau] > 0) tau++;
    // Ensure we only consider lags in the musical range.
    if (tau < minLag) tau = minLag;

    const keyMaxima = [];
    while (tau <= maxLag) {
      while (tau <= maxLag && nsdf[tau] <= 0) tau++;
      let peakTau = -1;
      let peakVal = -1;
      while (tau <= maxLag && nsdf[tau] > 0) {
        if (nsdf[tau] > peakVal) { peakVal = nsdf[tau]; peakTau = tau; }
        tau++;
      }
      if (peakTau > 0) keyMaxima.push({ tau: peakTau, val: peakVal });
    }
    if (keyMaxima.length === 0) return { freq: 0, confidence: 0, rms };

    // Pick the first key maximum whose height is at least 90% of the
    // global max. This is the MPM rule that resolves octave ambiguity:
    // on a harmonic spectrum, ACF picks 2f (biggest peak); MPM picks f.
    let globalMax = 0;
    for (const km of keyMaxima) if (km.val > globalMax) globalMax = km.val;
    const threshold = 0.9 * globalMax;
    const chosen = keyMaxima.find(km => km.val >= threshold) || keyMaxima[0];

    // Parabolic interpolation around the chosen lag for sub-sample precision.
    const y1 = chosen.tau > 0 ? nsdf[chosen.tau - 1] : 0;
    const y2 = nsdf[chosen.tau];
    const y3 = nsdf[chosen.tau + 1] || 0;
    const denom = 2 * (2 * y2 - y1 - y3);
    let shift = denom !== 0 ? (y3 - y1) / denom : 0;
    if (shift > 1) shift = 1; else if (shift < -1) shift = -1;
    const refinedLag = chosen.tau + shift;
    const clarity = y2 - 0.25 * (y1 - y3) * shift;

    const freq = sampleRate / refinedLag;
    if (freq < 55 || freq > 1200) return { freq: 0, confidence: 0, rms };

    const confidence = clarity > 1 ? 1 : (clarity < 0 ? 0 : clarity);
    return { freq, confidence, rms };
  }

  /**
   * Start a continuous pitch-monitoring loop, invoking `callback` with
   * `{ rms, freq, confidence }` every `hop` samples of captured audio.
   *
   * Pipeline: arecord → decode S16_LE → biquad HPF+LPF (state continuous
   * across chunks) → circular ring of size `windowSize` filled with
   * filtered samples → every `hop` samples, copy the ring into a linear
   * analysis window, run MPM pitch detection, emit.
   *
   * Default 4096 samples window (256 ms @ 16 kHz) with 2048-sample hop
   * (128 ms, 50% overlap): enough periods for reliable low-string
   * tracking, and a new result every ~128 ms for a responsive UI.
   *
   * @param {Function} callback
   * @param {Object} [options] - { alsaDevice?, windowSize?, hopSize? }
   */
  startTunerMonitoring(callback, options = {}) {
    if (this.tunerProcess) {
      this.stopTunerMonitoring();
    }

    const device = options.alsaDevice || this.config.alsaDevice;
    if (!DelayCalibrator.isValidAlsaDevice(device)) {
      throw new Error(`Invalid ALSA device format: ${device}`);
    }

    // Pitch detection is exquisitely sensitive to the actual capture rate:
    // if arecord opens the device at (say) 48 kHz but we analyze samples
    // as if they were at 16 kHz, every detected frequency is off by a
    // factor of 3. Using `plughw:` instead of `hw:` forces ALSA to go
    // through its rate/format conversion plugin so the requested 16 kHz
    // is always honored regardless of the mic's native rate.
    const captureDevice = device.startsWith('hw:') ? 'plug' + device : device;

    const windowSize = options.windowSize || 4096;
    const hopSize = options.hopSize || Math.floor(windowSize / 2);
    const sr = this.config.sampleRate;

    this.tunerCallback = callback;
    this.tunerRing = new Float32Array(windowSize);  // circular buffer
    this.tunerRingHead = 0;                          // next write position
    this.tunerRingFilled = 0;                        // total filtered samples ever written
    this.tunerSamplesSinceAnalysis = 0;
    this.tunerWindow = new Float32Array(windowSize); // linearized analysis window
    this.tunerWindowSize = windowSize;
    this.tunerHopSize = hopSize;

    // Fresh filter state for this capture session.
    this._buildFilterCoeffs(sr);
    this._resetFilterState();

    this._emittedCount = 0;
    this._startedAt = Date.now();
    this._usePlugFallback = device.startsWith('hw:');  // remember for fallback
    this._spawnArecord(captureDevice, sr, windowSize, hopSize);
  }

  /**
   * Spawn the arecord capture and wire its stdout to the pitch analyzer.
   * Extracted so we can retry with a different device string if the first
   * attempt fails (e.g. plughw: not available on a particular setup).
   */
  _spawnArecord(captureDevice, sr, windowSize, hopSize) {
    const args = [
      '-D', captureDevice,
      '-f', this.config.format,
      '-r', sr.toString(),
      '-c', this.config.channels.toString(),
      '-t', 'raw'
    ];
    this.logger.info(`Tuner arecord spawn: arecord ${args.join(' ')}`);
    this.tunerProcess = spawn('arecord', args);
    let stderrBuf = '';
    let firstChunkSeen = false;

    this.tunerProcess.stdout.on('data', (chunk) => {
      firstChunkSeen = true;
      const samples = this.decodeS16LE(chunk);
      // Apply HPF→LPF cascade to the full chunk; state advances once per
      // sample in capture order so IIR transients do not ring per-window.
      this._applyFilter(samples, sr);

      for (let i = 0; i < samples.length; i++) {
        this.tunerRing[this.tunerRingHead] = samples[i];
        this.tunerRingHead = (this.tunerRingHead + 1) % windowSize;
        if (this.tunerRingFilled < windowSize) this.tunerRingFilled++;
        this.tunerSamplesSinceAnalysis++;

        if (this.tunerRingFilled >= windowSize && this.tunerSamplesSinceAnalysis >= hopSize) {
          this.tunerSamplesSinceAnalysis = 0;
          // Copy the ring into a linear buffer, oldest sample first.
          const start = this.tunerRingHead; // oldest = next-to-overwrite
          for (let j = 0; j < windowSize; j++) {
            this.tunerWindow[j] = this.tunerRing[(start + j) % windowSize];
          }
          const result = this.detectPitch(this.tunerWindow, sr);
          if (this.tunerCallback) {
            try { this.tunerCallback(result); } catch (e) {
              this.logger.warn(`Tuner callback threw: ${e.message}`);
            }
          }
          this._emittedCount++;
          if (this._emittedCount <= 3 || this._emittedCount % 40 === 0) {
            this.logger.info(`Tuner pitch #${this._emittedCount}: freq=${result.freq.toFixed(2)} Hz, conf=${result.confidence.toFixed(3)}, rms=${result.rms.toFixed(4)}`);
          }
        }
      }
    });

    this.tunerProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      stderrBuf += msg;
      this.logger.info(`Tuner arecord stderr: ${msg.trim()}`);
    });

    this.tunerProcess.on('error', (error) => {
      this.logger.error(`Tuner arecord spawn error: ${error.message}`);
      this.tunerProcess = null;
    });

    this.tunerProcess.on('close', (code) => {
      const elapsed = Date.now() - this._startedAt;
      this.tunerProcess = null;
      // If the process dies within 500 ms without ever producing a chunk,
      // the device probably didn't accept the requested rate/format.
      // Retry once with `hw:` if we originally used `plughw:`.
      if (!firstChunkSeen && elapsed < 500 && this._usePlugFallback && captureDevice.startsWith('plug')) {
        const fallback = captureDevice.slice(4); // strip "plug"
        this.logger.warn(`Tuner ${captureDevice} closed after ${elapsed}ms with code ${code}; retrying with ${fallback}. stderr: ${stderrBuf.trim()}`);
        this._usePlugFallback = false;
        this._spawnArecord(fallback, sr, windowSize, hopSize);
      } else if (!firstChunkSeen) {
        this.logger.error(`Tuner arecord ${captureDevice} exited after ${elapsed}ms with code ${code} without producing audio. stderr: ${stderrBuf.trim()}`);
      }
    });

    this.logger.info(`Tuner monitoring started on ${captureDevice} (window=${windowSize}, hop=${hopSize})`);
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
    this.tunerRing = null;
    this.tunerWindow = null;
    this.tunerRingHead = 0;
    this.tunerRingFilled = 0;
    this.tunerSamplesSinceAnalysis = 0;
    this._resetFilterState();
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
