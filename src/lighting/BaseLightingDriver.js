// src/lighting/BaseLightingDriver.js
import EventEmitter from 'events';

class BaseLightingDriver extends EventEmitter {
  constructor(device, logger) {
    super();
    this.device = device;
    this.logger = logger;
    this.connected = false;
  }

  async connect() {
    throw new Error('connect() must be implemented by subclass');
  }

  async disconnect() {
    this.connected = false;
  }

  isConnected() {
    return this.connected;
  }

  /**
   * Set color for a single LED
   * @param {number} ledIndex - LED index (0-based)
   * @param {number} r - Red 0-255
   * @param {number} g - Green 0-255
   * @param {number} b - Blue 0-255
   * @param {number} brightness - Brightness 0-255
   */
  setColor(ledIndex, r, g, b, brightness = 255) {
    throw new Error('setColor() must be implemented by subclass');
  }

  /**
   * Set color for a range of LEDs
   * @param {number} startLed - Start index (inclusive)
   * @param {number} endLed - End index (inclusive), -1 = all
   * @param {number} r - Red 0-255
   * @param {number} g - Green 0-255
   * @param {number} b - Blue 0-255
   * @param {number} brightness - Brightness 0-255
   */
  setRange(startLed, endLed, r, g, b, brightness = 255) {
    const end = endLed === -1 ? this.device.led_count - 1 : endLed;
    for (let i = startLed; i <= end; i++) {
      this.setColor(i, r, g, b, brightness);
    }
  }

  allOff() {
    this.setRange(0, -1, 0, 0, 0, 0);
  }

  /**
   * Apply brightness to a color component
   */
  _applyBrightness(colorValue, brightness) {
    return Math.round((colorValue * brightness) / 255);
  }
}

export default BaseLightingDriver;
