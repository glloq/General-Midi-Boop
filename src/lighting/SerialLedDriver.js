// src/lighting/SerialLedDriver.js
// Serial driver for WS2812/NeoPixel LED strips via Arduino/ESP32

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

      this.connected = true;
      this.logger.info(`Serial LED driver connected on ${config.port || '/dev/ttyUSB0'}`);
      this.emit('connected');
    } catch (error) {
      this.logger.error(`Serial LED driver connect failed: ${error.message}`);
      throw error;
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
      0xAA,
      ledIndex & 0xFF, (ledIndex >> 8) & 0xFF,
      adjR, adjG, adjB,
      0x55
    ]);

    this.port.write(buf);
  }

  allOff() {
    if (!this.port || !this.port.isOpen) return;
    // Special command: [0xAA, 0xFF, 0xFF, 0, 0, 0, 0x55] = all off
    const buf = Buffer.from([0xAA, 0xFF, 0xFF, 0, 0, 0, 0x55]);
    this.port.write(buf);
  }
}

export default SerialLedDriver;
