// src/lighting/LightingEffectsEngine.js
// Effects engine for animated lighting patterns
// Supports: strobe, rainbow, chase, fire, breathe, sparkle, color_cycle, wave

class LightingEffectsEngine {
  constructor(logger) {
    this.logger = logger;
    this.activeEffects = new Map(); // effectKey -> { interval, driver, config }
    this.bpm = 120;
    this._tapTimes = [];
  }

  /**
   * Set BPM for tempo-synced effects
   */
  setBpm(bpm) {
    this.bpm = Math.max(20, Math.min(300, bpm));
  }

  getBpm() {
    return this.bpm;
  }

  /**
   * Tap tempo: record tap times and calculate BPM
   */
  tapTempo() {
    const now = Date.now();
    this._tapTimes.push(now);

    // Keep only last 8 taps
    if (this._tapTimes.length > 8) this._tapTimes.shift();

    if (this._tapTimes.length >= 2) {
      const intervals = [];
      for (let i = 1; i < this._tapTimes.length; i++) {
        intervals.push(this._tapTimes[i] - this._tapTimes[i - 1]);
      }
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      this.bpm = Math.round(60000 / avgInterval);
      this.bpm = Math.max(20, Math.min(300, this.bpm));
    }

    // Reset after 3 seconds of no taps
    setTimeout(() => {
      if (this._tapTimes.length > 0 && Date.now() - this._tapTimes[this._tapTimes.length - 1] > 3000) {
        this._tapTimes = [];
      }
    }, 3500);

    return this.bpm;
  }

  /**
   * Convert BPM to milliseconds per beat
   */
  getBeatMs() {
    return Math.round(60000 / this.bpm);
  }

  /**
   * Start an effect on a driver
   * @param {string} effectKey - Unique key for this effect instance
   * @param {string} effectType - Effect type name
   * @param {object} driver - BaseLightingDriver instance
   * @param {object} config - Effect configuration
   */
  startEffect(effectKey, effectType, driver, config = {}) {
    this.stopEffect(effectKey);

    const startLed = config.led_start || 0;
    const endLed = config.led_end === -1 || config.led_end === undefined
      ? (driver.device?.led_count || 1) - 1
      : config.led_end;
    const speed = config.speed || 500; // ms per cycle
    const brightness = config.brightness !== undefined ? config.brightness : 255;
    const color = config.color ? this._hexToRgb(config.color) : { r: 255, g: 0, b: 0 };
    const color2 = config.color2 ? this._hexToRgb(config.color2) : null;

    let state = { tick: 0, phase: 0 };
    let intervalMs;
    let fn;

    switch (effectType) {
      case 'strobe':
        intervalMs = Math.max(20, speed / 2);
        fn = () => this._strobe(driver, startLed, endLed, color, brightness, state);
        break;

      case 'rainbow':
        intervalMs = Math.max(16, speed / 60);
        fn = () => this._rainbow(driver, startLed, endLed, brightness, state, speed);
        break;

      case 'chase':
        intervalMs = Math.max(16, speed / (endLed - startLed + 1));
        fn = () => this._chase(driver, startLed, endLed, color, color2, brightness, state);
        break;

      case 'fire':
        intervalMs = Math.max(16, speed / 30);
        fn = () => this._fire(driver, startLed, endLed, brightness, state);
        break;

      case 'breathe':
        intervalMs = Math.max(16, speed / 60);
        fn = () => this._breathe(driver, startLed, endLed, color, brightness, state, speed);
        break;

      case 'sparkle':
        intervalMs = Math.max(16, speed / 20);
        fn = () => this._sparkle(driver, startLed, endLed, color, brightness, config.density || 0.1);
        break;

      case 'color_cycle':
        intervalMs = Math.max(16, speed / 60);
        fn = () => this._colorCycle(driver, startLed, endLed, brightness, state, speed);
        break;

      case 'wave':
        intervalMs = Math.max(16, speed / 60);
        fn = () => this._wave(driver, startLed, endLed, color, color2, brightness, state, speed);
        break;

      default:
        this.logger.warn(`Unknown effect type: ${effectType}`);
        return;
    }

    const interval = setInterval(fn, intervalMs);
    this.activeEffects.set(effectKey, { interval, driver, config: { effectType, ...config } });
  }

  stopEffect(effectKey) {
    const effect = this.activeEffects.get(effectKey);
    if (effect) {
      clearInterval(effect.interval);
      this.activeEffects.delete(effectKey);
    }
  }

  stopAllEffects() {
    for (const [key] of this.activeEffects) {
      this.stopEffect(key);
    }
  }

  stopEffectsForDriver(driver) {
    for (const [key, effect] of this.activeEffects) {
      if (effect.driver === driver) {
        this.stopEffect(key);
      }
    }
  }

  isRunning(effectKey) {
    return this.activeEffects.has(effectKey);
  }

  getActiveEffects() {
    const result = [];
    for (const [key, effect] of this.activeEffects) {
      result.push({ key, effectType: effect.config.effectType, config: effect.config });
    }
    return result;
  }

  // ==================== EFFECT IMPLEMENTATIONS ====================

  _strobe(driver, startLed, endLed, color, brightness, state) {
    state.tick++;
    if (state.tick % 2 === 0) {
      driver.setRange(startLed, endLed, color.r, color.g, color.b, brightness);
    } else {
      driver.setRange(startLed, endLed, 0, 0, 0, 0);
    }
  }

  _rainbow(driver, startLed, endLed, brightness, state, speed) {
    state.phase += 360 / (speed / 16);
    if (state.phase >= 360) state.phase -= 360;

    const ledCount = endLed - startLed + 1;
    for (let i = 0; i <= endLed - startLed; i++) {
      const hue = (state.phase + (i * 360 / ledCount)) % 360;
      const { r, g, b } = this._hsvToRgb(hue, 1.0, 1.0);
      driver.setColor(startLed + i, r, g, b, brightness);
    }
  }

  _chase(driver, startLed, endLed, color, color2, brightness, state) {
    const ledCount = endLed - startLed + 1;
    state.tick = (state.tick + 1) % ledCount;

    const bg = color2 || { r: 0, g: 0, b: 0 };
    const bgBri = color2 ? brightness : 0;

    for (let i = 0; i < ledCount; i++) {
      const led = startLed + i;
      if (i === state.tick) {
        driver.setColor(led, color.r, color.g, color.b, brightness);
      } else {
        driver.setColor(led, bg.r, bg.g, bg.b, bgBri);
      }
    }
  }

  _fire(driver, startLed, endLed, brightness, _state) {
    // Simulate fire with random warm colors
    for (let i = startLed; i <= endLed; i++) {
      const flicker = Math.random();
      const r = Math.round(255 * Math.min(1, flicker + 0.4));
      const g = Math.round(96 * flicker * flicker);
      const b = Math.round(12 * flicker * flicker * flicker);
      const bri = Math.round(brightness * (0.4 + flicker * 0.6));
      driver.setColor(i, r, g, b, bri);
    }
  }

  _breathe(driver, startLed, endLed, color, maxBri, state, speed) {
    state.phase += (2 * Math.PI) / (speed / 16);
    if (state.phase > 2 * Math.PI) state.phase -= 2 * Math.PI;

    // Smooth sine wave breathing
    const factor = (Math.sin(state.phase - Math.PI / 2) + 1) / 2; // 0 to 1
    const bri = Math.round(factor * maxBri);
    driver.setRange(startLed, endLed, color.r, color.g, color.b, bri);
  }

  _sparkle(driver, startLed, endLed, color, brightness, density) {
    // Random sparkle: each LED has a chance to light up
    for (let i = startLed; i <= endLed; i++) {
      if (Math.random() < density) {
        driver.setColor(i, color.r, color.g, color.b, brightness);
      } else {
        driver.setColor(i, 0, 0, 0, 0);
      }
    }
  }

  _colorCycle(driver, startLed, endLed, brightness, state, speed) {
    state.phase += 360 / (speed / 16);
    if (state.phase >= 360) state.phase -= 360;

    const { r, g, b } = this._hsvToRgb(state.phase, 1.0, 1.0);
    driver.setRange(startLed, endLed, r, g, b, brightness);
  }

  _wave(driver, startLed, endLed, color, color2, brightness, state, speed) {
    state.phase += (2 * Math.PI) / (speed / 16);
    if (state.phase > 2 * Math.PI) state.phase -= 2 * Math.PI;

    const bg = color2 || { r: 0, g: 0, b: 0 };
    const ledCount = endLed - startLed + 1;

    for (let i = 0; i <= endLed - startLed; i++) {
      const factor = (Math.sin(state.phase + (i * 2 * Math.PI / ledCount)) + 1) / 2;
      const r = Math.round(bg.r + (color.r - bg.r) * factor);
      const g = Math.round(bg.g + (color.g - bg.g) * factor);
      const b = Math.round(bg.b + (color.b - bg.b) * factor);
      driver.setColor(startLed + i, r, g, b, brightness);
    }
  }

  // ==================== COLOR HELPERS ====================

  _hsvToRgb(h, s, v) {
    h = h % 360;
    const c = v * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = v - c;
    let r, g, b;

    if (h < 60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }

    return {
      r: Math.round((r + m) * 255),
      g: Math.round((g + m) * 255),
      b: Math.round((b + m) * 255)
    };
  }

  _hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : { r: 255, g: 255, b: 255 };
  }

  shutdown() {
    this.stopAllEffects();
  }
}

export default LightingEffectsEngine;
