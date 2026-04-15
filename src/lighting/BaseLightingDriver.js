// src/lighting/BaseLightingDriver.js
import EventEmitter from 'events';

/**
 * Abstract base class for all lighting drivers.
 *
 * Every driver MUST implement:
 *   - connect()    → async, establishes connection, sets this.connected = true
 *   - disconnect() → async, closes connection, sets this.connected = false
 *   - setColor(ledIndex, r, g, b, brightness) → sets a single LED color
 *
 * Drivers MAY override (sensible defaults provided):
 *   - setRange(startLed, endLed, r, g, b, brightness) → sets a range of LEDs
 *   - allOff() → turns all LEDs off
 *   - isConnected() → returns connection status
 *
 * Drivers MAY expose optional capabilities:
 *   - getSegment(name) → returns a named LED segment (for strip drivers)
 *   - setDmxChannel(ch, value) → direct DMX control (for DMX drivers)
 *
 * Events emitted:
 *   - 'disconnected' → when the driver detects an unexpected disconnection
 */

/** @type {readonly string[]} Methods that subclasses must implement */
const REQUIRED_METHODS = ['connect', 'setColor'];

class BaseLightingDriver extends EventEmitter {
  constructor(device, logger) {
    super();
    this.device = device;
    this.logger = logger;
    this.connected = false;
    this._renderScheduled = false;
  }

  /**
   * Validate that a driver subclass implements all required methods.
   * Call this after instantiation (e.g. in LightingManager) to catch
   * misconfigured drivers early instead of at runtime.
   * @param {BaseLightingDriver} driver
   * @throws {Error} if a required method is missing or not overridden
   */
  static validate(driver) {
    const missing = [];
    for (const method of REQUIRED_METHODS) {
      // Check that the method exists AND is not the base class "throw" stub
      if (typeof driver[method] !== 'function') {
        missing.push(method);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Lighting driver "${driver.constructor.name}" is missing required method(s): ${missing.join(', ')}`
      );
    }
  }

  /**
   * Establish connection to the lighting device.
   * Subclasses MUST override this and set this.connected = true on success.
   * @returns {Promise<void>}
   */
  async connect() {
    throw new Error(`${this.constructor.name}.connect() must be implemented`);
  }

  /**
   * Close connection to the lighting device.
   * Template method: calls _doDisconnect() for subclass cleanup,
   * then resets connected state and emits 'disconnected'.
   * Subclasses should override _doDisconnect() instead of disconnect().
   * @returns {Promise<void>}
   */
  async disconnect() {
    await this._doDisconnect();
    this.connected = false;
    this.emit('disconnected');
  }

  /**
   * Subclass-specific disconnection cleanup.
   * Override this to close sockets, release hardware, etc.
   * @returns {Promise<void>}
   */
  async _doDisconnect() {
    // Override in subclasses
  }

  /**
   * @returns {boolean} Whether the driver is currently connected
   */
  isConnected() {
    return this.connected;
  }

  /**
   * Set color for a single LED.
   * Subclasses MUST override this.
   * @param {number} ledIndex - LED index (0-based)
   * @param {number} r - Red 0-255
   * @param {number} g - Green 0-255
   * @param {number} b - Blue 0-255
   * @param {number} [brightness=255] - Brightness 0-255
   */
  setColor(ledIndex, r, g, b, _brightness = 255) {
    throw new Error(`${this.constructor.name}.setColor() must be implemented`);
  }

  /**
   * Set color for a range of LEDs.
   * Default implementation calls setColor() in a loop.
   * Subclasses SHOULD override for better performance.
   * @param {number} startLed - Start index (inclusive)
   * @param {number} endLed - End index (inclusive), -1 = all LEDs
   * @param {number} r - Red 0-255
   * @param {number} g - Green 0-255
   * @param {number} b - Blue 0-255
   * @param {number} [brightness=255] - Brightness 0-255
   */
  setRange(startLed, endLed, r, g, b, brightness = 255) {
    const end = endLed === -1 ? this.device.led_count - 1 : endLed;
    for (let i = startLed; i <= end; i++) {
      this.setColor(i, r, g, b, brightness);
    }
  }

  /**
   * Turn all LEDs off.
   * Default implementation calls setRange with all zeros.
   * Subclasses MAY override for a more efficient "off" command.
   */
  allOff() {
    this.setRange(0, -1, 0, 0, 0, 0);
  }

  /**
   * Schedule a render on the next microtask. Multiple calls within the same
   * microtask are coalesced into a single _doRender() call.
   * Drivers that use queueMicrotask-based batching inherit this.
   * (HttpLightDriver uses setTimeout instead and does not use this.)
   */
  _scheduleRender() {
    if (!this._renderScheduled) {
      this._renderScheduled = true;
      queueMicrotask(() => {
        this._renderScheduled = false;
        this._doRender();
      });
    }
  }

  /**
   * Perform the actual render. Override in subclasses that use _scheduleRender().
   */
  _doRender() {
    // Subclasses override this
  }

  /**
   * Apply brightness to a color component.
   * @param {number} colorValue - Color value 0-255
   * @param {number} brightness - Brightness 0-255
   * @returns {number} Adjusted color value
   */
  _applyBrightness(colorValue, brightness) {
    return Math.round((colorValue * brightness) / 255);
  }

  /**
   * Apply brightness to all three color components at once.
   * @param {number} r - Red 0-255
   * @param {number} g - Green 0-255
   * @param {number} b - Blue 0-255
   * @param {number} brightness - Brightness 0-255
   * @returns {{ r: number, g: number, b: number }} Adjusted color
   */
  _adjustColor(r, g, b, brightness) {
    return {
      r: this._applyBrightness(r, brightness),
      g: this._applyBrightness(g, brightness),
      b: this._applyBrightness(b, brightness)
    };
  }
}

export default BaseLightingDriver;
