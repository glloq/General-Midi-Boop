// src/lighting/GpioStripDriver.js
// WS2812/NeoPixel addressable LED strip driver for Raspberry Pi
// Uses rpi-ws281x-native for hardware PWM/SPI control

import BaseLightingDriver from './BaseLightingDriver.js';

// Valid GPIO pins per hardware channel
const CHANNEL_GPIO_MAP = {
  0: [18, 12],  // PWM0
  1: [13, 19],  // PWM1
  2: [10]       // SPI0
};

class GpioStripDriver extends BaseLightingDriver {
  constructor(device, logger) {
    super(device, logger);
    this.ws281x = null;
    this.strips = [];          // Strip configs from connection_config
    this.segments = [];        // Named logical zones
    this.pixelBuffers = [];    // Uint32Array per strip
    this.indexLookup = [];     // Virtual index -> { stripIndex, offset }
    this._totalLeds = 0;
  }

  async connect() {
    try {
      const ws281xModule = await import('rpi-ws281x-native');
      this.ws281x = ws281xModule.default || ws281xModule;

      const config = this.device.connection_config;
      this.strips = config.strips || [];
      this.segments = config.segments || [];

      if (this.strips.length === 0) {
        throw new Error('No strips configured in connection_config');
      }
      if (this.strips.length > 3) {
        throw new Error('Maximum 3 strips supported (hardware channel limit)');
      }

      // Validate channels
      const usedChannels = new Set();
      for (const strip of this.strips) {
        if (usedChannels.has(strip.channel)) {
          throw new Error(`Duplicate hardware channel: ${strip.channel}`);
        }
        usedChannels.add(strip.channel);

        const validPins = CHANNEL_GPIO_MAP[strip.channel];
        if (!validPins) {
          throw new Error(`Invalid channel ${strip.channel}. Must be 0, 1, or 2`);
        }
        if (!validPins.includes(strip.gpio)) {
          throw new Error(`GPIO ${strip.gpio} is not valid for channel ${strip.channel}. Valid pins: ${validPins.join(', ')}`);
        }
      }

      // Build virtual index lookup table
      this.indexLookup = [];
      this._totalLeds = 0;
      for (let si = 0; si < this.strips.length; si++) {
        const count = this.strips[si].led_count || 0;
        for (let offset = 0; offset < count; offset++) {
          this.indexLookup.push({ stripIndex: si, offset });
        }
        this._totalLeds += count;
      }

      // Initialize ws281x with channel config
      const channels = this.strips.map(strip => ({
        count: strip.led_count,
        gpio: strip.gpio,
        brightness: strip.brightness !== undefined ? strip.brightness : 255,
        strip_type: this.ws281x.WS2812_STRIP || 0x00081000
      }));

      this.ws281x.init({
        freq: config.frequency || 800000,
        dma: config.dma || 10,
        channels
      });

      // Create pixel buffers
      this.pixelBuffers = this.strips.map(strip =>
        new Uint32Array(strip.led_count)
      );

      this.connected = true;
      this.logger.info(`GPIO Strip driver connected: ${this.strips.length} strip(s), ${this._totalLeds} total LEDs on device "${this.device.name}"`);
      this.emit('connected');
    } catch (error) {
      this.logger.error(`GPIO Strip driver connect failed: ${error.message}`);
      throw error;
    }
  }

  async _doDisconnect() {
    try {
      this.allOff();
      if (this.ws281x) {
        this.ws281x.finalize();
        this.ws281x = null;
      }
    } catch (err) {
      this.logger.warn(`GPIO Strip driver disconnect error: ${err.message}`);
    }
    this.pixelBuffers = [];
    this.indexLookup = [];
  }

  setColor(ledIndex, r, g, b, brightness = 255) {
    const lookup = this.indexLookup[ledIndex];
    if (!lookup) return;

    const { r: adjR, g: adjG, b: adjB } = this._adjustColor(r, g, b, brightness);

    // Pack as 0x00RRGGBB (rpi-ws281x-native handles color order via strip_type)
    this.pixelBuffers[lookup.stripIndex][lookup.offset] =
      (adjR << 16) | (adjG << 8) | adjB;

    this._scheduleRender();
  }

  setRange(startLed, endLed, r, g, b, brightness = 255) {
    const end = endLed === -1 ? this._totalLeds - 1 : endLed;

    const { r: adjR, g: adjG, b: adjB } = this._adjustColor(r, g, b, brightness);
    const packed = (adjR << 16) | (adjG << 8) | adjB;

    for (let i = startLed; i <= end; i++) {
      const lookup = this.indexLookup[i];
      if (lookup) {
        this.pixelBuffers[lookup.stripIndex][lookup.offset] = packed;
      }
    }

    this._scheduleRender();
  }

  allOff() {
    for (const buffer of this.pixelBuffers) {
      buffer.fill(0);
    }
    this._renderNow();
  }

  // ==================== SEGMENT HELPERS ====================

  getSegment(name) {
    return this.segments.find(s => s.name === name) || null;
  }

  setSegmentColor(segmentName, r, g, b, brightness = 255) {
    const seg = this.getSegment(segmentName);
    if (seg) {
      this.setRange(seg.start, seg.end, r, g, b, brightness);
    }
  }

  // ==================== RENDER BATCHING ====================

  _doRender() {
    this._renderNow();
  }

  _renderNow() {
    if (this.connected && this.ws281x) {
      try {
        this.ws281x.render();
      } catch (err) {
        this.logger.warn(`GPIO Strip render failed: ${err.message}`);
      }
    }
  }
}

export default GpioStripDriver;
