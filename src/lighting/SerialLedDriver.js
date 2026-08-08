/**
 * @file src/lighting/SerialLedDriver.js
 * @description {@link BaseLightingDriver} implementation that talks to
 * an external Arduino / ESP32 sketch over a serial line. The
 * micro-controller is responsible for actually driving the WS281x
 * strip — this driver only sends the per-LED color commands.
 */

import BaseLightingDriver from './BaseLightingDriver.js';

class SerialLedDriver extends BaseLightingDriver {
  constructor(device, logger) {
    super(device, logger);
    this.port = null;
  }

  async connect() {
    try {
      const { SerialPort } = await import('serialport');
      const config = this.device.connection_config;

      this.port = new SerialPort({
        path: config.port || '/dev/ttyUSB0',
        baudRate: config.baud || 115200,
        autoOpen: false
      });

      await new Promise((resolve, reject) => {
        this.port.open((err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // A serial fault (USB unplugged, adapter reset) emits 'error' on the
      // stream; with NO listener Node re-throws it as an uncaughtException,
      // which shuts the whole MIDI process down (audit B1). Absorb it and, on
      // close, mark the driver offline so the manager can react.
      this.port.on('error', (err) => {
        this.logger.warn(
          `Serial LED driver error on ${config.port || '/dev/ttyUSB0'}: ${err.message}`
        );
      });
      this.port.on('close', () => {
        this.connected = false;
        this.emit('disconnected');
      });

      this.connected = true;
      this.logger.info(`Serial LED driver connected on ${config.port || '/dev/ttyUSB0'}`);
      this.emit('connected');
    } catch (error) {
      this.logger.error(`Serial LED driver connect failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Guarded serial write: a synchronous failure (e.g. ERR_STREAM_DESTROYED in
   * the isOpen→write race after a mid-write disconnect) must not propagate out
   * of a timer-driven effect and crash the app (audit B1).
   * @param {Buffer} buf
   * @private
   */
  _write(buf) {
    if (!this.port || !this.port.isOpen) return;
    try {
      this.port.write(buf);
    } catch (err) {
      this.logger.warn(`Serial LED write failed: ${err.message}`);
    }
  }

  async _doDisconnect() {
    if (this.port && this.port.isOpen) {
      await new Promise((resolve) => {
        this.port.close(() => resolve());
      });
    }
    this.port = null;
  }

  setColor(ledIndex, r, g, b, brightness = 255) {
    if (!this.port || !this.port.isOpen) return;

    const { r: adjR, g: adjG, b: adjB } = this._adjustColor(r, g, b, brightness);

    // Protocol: [0xAA, ledIndex (2 bytes LE), R, G, B, 0x55]
    const buf = Buffer.from([
      0xaa,
      ledIndex & 0xff,
      (ledIndex >> 8) & 0xff,
      adjR,
      adjG,
      adjB,
      0x55
    ]);

    this._write(buf);
  }

  allOff() {
    // Special command: [0xAA, 0xFF, 0xFF, 0, 0, 0, 0x55] = all off
    const buf = Buffer.from([0xaa, 0xff, 0xff, 0, 0, 0, 0x55]);
    this._write(buf);
  }
}

export default SerialLedDriver;
