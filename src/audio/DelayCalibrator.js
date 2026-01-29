// src/audio/DelayCalibrator.js

import { spawn } from 'child_process';
import { performance } from 'perf_hooks';

/**
 * DelayCalibrator - Mesure les délais de latence des instruments via microphone
 *
 * Utilise ALSA (arecord) sur Raspberry Pi pour capturer l'audio et mesurer
 * le délai entre l'envoi d'une note MIDI et la détection du son.
 */
class DelayCalibrator {
  constructor(midiController, logger) {
    this.midiController = midiController;
    this.logger = logger;

    // État de l'enregistrement
    this.recording = null;
    this.audioBuffer = [];
    this.isRecording = false;

    // Configuration par défaut
    this.config = {
      alsaDevice: 'hw:1,0', // Device ALSA (configurable)
      sampleRate: 16000,     // 16 kHz
      format: 'S16_LE',      // 16-bit signed little-endian
      channels: 1,           // Mono
      threshold: 0.02,       // Seuil RMS de détection
      noteVelocity: 100,     // Vélocité de la note test
      noteDuration: 500,     // Durée de la note (ms)
      testNote: 60,          // C4 (Do central)
      preRecordTime: 100,    // Temps d'enregistrement avant note (ms)
      maxWaitTime: 2000,     // Timeout de détection (ms)
      measurements: 5        // Nombre de mesures par instrument
    };
  }

  /**
   * Configure le device ALSA
   * @param {string} device - Ex: 'hw:1,0' ou 'plughw:1,0'
   */
  setAlsaDevice(device) {
    this.config.alsaDevice = device;
    this.logger.info(`ALSA device set to: ${device}`);
  }

  /**
   * Configure le seuil de détection
   * @param {number} threshold - Seuil RMS (0.01 - 0.10)
   */
  setThreshold(threshold) {
    this.config.threshold = Math.max(0.01, Math.min(0.10, threshold));
    this.logger.info(`Detection threshold set to: ${this.config.threshold}`);
  }

  /**
   * Calibre le délai d'un instrument
   * @param {number} deviceId - ID du device MIDI
   * @param {number} channel - Canal MIDI de l'instrument
   * @param {Object} options - Options de calibration
   * @returns {Promise<Object>} - { delay, measurements, confidence }
   */
  async calibrateInstrument(deviceId, channel, options = {}) {
    const measurements = options.measurements || this.config.measurements;

    try {
      this.logger.info(`Starting calibration for device ${deviceId}, channel ${channel}`);

      const delays = [];

      // Effectuer plusieurs mesures
      for (let i = 0; i < measurements; i++) {
        this.logger.debug(`Measurement ${i + 1}/${measurements}`);

        const delay = await this.singleMeasurement(deviceId, channel);

        if (delay !== null) {
          delays.push(delay);
        }

        // Pause entre les mesures
        if (i < measurements - 1) {
          await this.sleep(1000);
        }
      }

      // Calculer le délai médian (plus robuste que la moyenne)
      if (delays.length === 0) {
        throw new Error('No valid measurements detected');
      }

      delays.sort((a, b) => a - b);
      const median = delays[Math.floor(delays.length / 2)];

      // Calculer la confiance (basée sur l'écart-type)
      const mean = delays.reduce((sum, d) => sum + d, 0) / delays.length;
      const variance = delays.reduce((sum, d) => sum + Math.pow(d - mean, 2), 0) / delays.length;
      const stdDev = Math.sqrt(variance);

      // Confiance: 100% si stdDev < 5ms, décroissant jusqu'à 0% à 50ms
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
   * Effectue une seule mesure de délai
   * @param {number} deviceId
   * @param {number} channel
   * @returns {Promise<number|null>} - Délai en ms ou null si échec
   */
  async singleMeasurement(deviceId, channel) {
    try {
      // Réinitialiser le buffer
      this.audioBuffer = [];

      // Démarrer l'enregistrement
      this.startRecording();

      // Attendre que l'enregistrement démarre
      await this.sleep(this.config.preRecordTime);

      // Envoyer la note MIDI et capturer le timestamp
      const sendTime = performance.now();
      await this.sendTestNote(deviceId, channel);

      // Attendre la détection du son
      const detectionTime = await this.waitForSound(this.config.maxWaitTime);

      // Arrêter l'enregistrement
      this.stopRecording();

      if (detectionTime === null) {
        this.logger.warn('No sound detected within timeout');
        return null;
      }

      // Calculer le délai
      const delay = detectionTime - sendTime;
      this.logger.debug(`Delay measured: ${delay.toFixed(2)} ms`);

      return delay;
    } catch (error) {
      this.stopRecording();
      throw error;
    }
  }

  /**
   * Démarre l'enregistrement audio via arecord
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

    // Capturer les données audio
    this.recording.stdout.on('data', (chunk) => {
      if (this.isRecording) {
        this.audioBuffer.push(chunk);
      }
    });

    // Gérer les erreurs
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
   * Arrête l'enregistrement audio
   */
  stopRecording() {
    if (this.recording) {
      this.recording.kill('SIGTERM');
      this.recording = null;
    }
    this.isRecording = false;
    this.logger.debug('Recording stopped');
  }

  /**
   * Envoie une note MIDI de test
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

    // Attendre la durée de la note
    await this.sleep(this.config.noteDuration);

    // Note OFF
    this.midiController.sendMessage(deviceId, 'noteoff', {
      channel: channel,
      note: note,
      velocity: 0
    });
  }

  /**
   * Attend la détection d'un son dans le buffer audio
   * @param {number} timeoutMs - Timeout en millisecondes
   * @returns {Promise<number|null>} - Timestamp de détection ou null
   */
  waitForSound(timeoutMs) {
    return new Promise((resolve) => {
      const startTime = performance.now();
      const checkInterval = 10; // Vérifier toutes les 10ms

      const interval = setInterval(() => {
        // Vérifier timeout
        if (performance.now() - startTime > timeoutMs) {
          clearInterval(interval);
          resolve(null);
          return;
        }

        // Vérifier les derniers chunks du buffer
        if (this.audioBuffer.length > 0) {
          // Analyser les 5 derniers chunks (ou moins)
          const chunksToCheck = Math.min(5, this.audioBuffer.length);
          const recentChunks = this.audioBuffer.slice(-chunksToCheck);

          for (const chunk of recentChunks) {
            const rms = this.calculateRMS(chunk);

            if (rms > this.config.threshold) {
              clearInterval(interval);
              resolve(performance.now());
              return;
            }
          }
        }
      }, checkInterval);
    });
  }

  /**
   * Calcule le RMS (Root Mean Square) d'un buffer audio
   * @param {Buffer} buffer - Buffer audio en format S16_LE
   * @returns {number} - Valeur RMS (0.0 - 1.0)
   */
  calculateRMS(buffer) {
    if (!buffer || buffer.length === 0) {
      return 0;
    }

    let sum = 0;
    const sampleCount = buffer.length / 2; // 2 bytes par sample (16-bit)

    for (let i = 0; i < buffer.length; i += 2) {
      // Lire sample 16-bit signed little-endian
      const sample = buffer.readInt16LE(i);

      // Normaliser à -1.0 - 1.0
      const normalized = sample / 32768.0;

      // Accumuler le carré
      sum += normalized * normalized;
    }

    // Calculer la racine carrée de la moyenne
    return Math.sqrt(sum / sampleCount);
  }

  /**
   * Liste les devices ALSA disponibles
   * @returns {Promise<Array>} - Liste des devices
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

        // Parser la sortie
        const devices = [];
        const lines = output.split('\n');

        for (const line of lines) {
          // Format: "carte 1: Device [USB Audio Device], périphérique 0: USB Audio [USB Audio]"
          const match = line.match(/carte (\d+):.*périphérique (\d+):/);
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

  /**
   * Utilitaire: sleep
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Nettoie les ressources
   */
  destroy() {
    this.stopRecording();
  }
}

export default DelayCalibrator;
