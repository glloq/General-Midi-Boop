// src/lighting/HttpLightDriver.js
// HTTP REST API driver for controlling lights via HTTP (WLED, Philips Hue, generic REST endpoints)

import BaseLightingDriver from './BaseLightingDriver.js';

class HttpLightDriver extends BaseLightingDriver {
  constructor(device, logger) {
    super(device, logger);
    this._batchTimer = null;
    this._pendingUpdates = new Map();
    this._batchDelay = 16; // ~60fps max
  }

  async connect() {
    try {
      const config = this.device.connection_config;
      this.baseUrl = (config.base_url || 'http://localhost').replace(/\/$/, '');
      this.firmware = config.firmware || 'generic'; // 'wled', 'hue', 'generic'
      this.apiKey = config.api_key || null;
      this.headers = config.headers || {};
      this._batchDelay = config.batch_delay_ms || 16;

      if (this.apiKey) {
        this.headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      // Test connectivity with a GET
      const testUrl = this.firmware === 'wled' ? `${this.baseUrl}/json/info`
        : this.firmware === 'hue' ? `${this.baseUrl}/api/${this.apiKey || 'test'}/lights`
        : `${this.baseUrl}/status`;

      const res = await fetch(testUrl, { headers: this.headers, signal: AbortSignal.timeout(5000) });
      if (!res.ok && this.firmware !== 'generic') {
        throw new Error(`HTTP test failed: ${res.status} ${res.statusText}`);
      }

      this.connected = true;
      this.logger.info(`HTTP Light driver connected: ${this.baseUrl}, firmware=${this.firmware}`);
      this.emit('connected');
    } catch (error) {
      this.logger.error(`HTTP Light driver connect failed: ${error.message}`);
      throw error;
    }
  }

  async _doDisconnect() {
    this.allOff();
    if (this._batchTimer) clearTimeout(this._batchTimer);
    this._pendingUpdates.clear();
  }

  setColor(ledIndex, r, g, b, brightness = 255) {
    const { r: adjR, g: adjG, b: adjB } = this._adjustColor(r, g, b, brightness);

    this._pendingUpdates.set(ledIndex, { r: adjR, g: adjG, b: adjB, brightness });
    this._scheduleBatch();
  }

  setRange(startLed, endLed, r, g, b, brightness = 255) {
    const end = endLed === -1 ? this.device.led_count - 1 : endLed;
    const { r: adjR, g: adjG, b: adjB } = this._adjustColor(r, g, b, brightness);

    for (let i = startLed; i <= end; i++) {
      this._pendingUpdates.set(i, { r: adjR, g: adjG, b: adjB, brightness });
    }
    this._scheduleBatch();
  }

  allOff() {
    this._pendingUpdates.clear();
    if (this._batchTimer) { clearTimeout(this._batchTimer); this._batchTimer = null; }

    switch (this.firmware) {
      case 'wled':
        this._sendRequest('POST', '/json/state', { on: false });
        break;
      case 'hue':
        this._sendHueAllOff();
        break;
      default:
        this._sendRequest('POST', '/off', { state: 'OFF' });
    }
  }

  _scheduleBatch() {
    if (this._batchTimer) return;
    this._batchTimer = setTimeout(() => {
      this._batchTimer = null;
      this._flushBatch();
    }, this._batchDelay);
  }

  _flushBatch() {
    if (this._pendingUpdates.size === 0) return;

    const updates = new Map(this._pendingUpdates);
    this._pendingUpdates.clear();

    switch (this.firmware) {
      case 'wled':
        this._flushWled(updates);
        break;
      case 'hue':
        this._flushHue(updates);
        break;
      default:
        this._flushGeneric(updates);
    }
  }

  _flushWled(updates) {
    // WLED JSON API: batch individual LED colors
    const segData = [];
    for (const [idx, color] of updates) {
      segData.push(idx, [color.r, color.g, color.b]);
    }

    this._sendRequest('POST', '/json/state', {
      on: true,
      seg: [{ id: 0, i: segData }]
    });
  }

  _flushHue(updates) {
    // Philips Hue: each LED = one Hue light ID
    for (const [idx, color] of updates) {
      const lightId = idx + 1; // Hue lights are 1-indexed
      const { h, s, bri } = this._rgbToHsv(color.r, color.g, color.b);
      this._sendRequest(
        'PUT',
        `/api/${this.apiKey}/lights/${lightId}/state`,
        { on: true, hue: Math.round(h * 65535 / 360), sat: Math.round(s * 254), bri: Math.round(bri * 254 / 255) }
      );
    }
  }

  _flushGeneric(updates) {
    const leds = [];
    for (const [idx, color] of updates) {
      leds.push({ index: idx, r: color.r, g: color.g, b: color.b, brightness: color.brightness });
    }
    this._sendRequest('POST', '/set', { leds });
  }

  async _sendHueAllOff() {
    for (let i = 0; i < this.device.led_count; i++) {
      this._sendRequest('PUT', `/api/${this.apiKey}/lights/${i + 1}/state`, { on: false });
    }
  }

  async _sendRequest(method, path, body) {
    try {
      const url = `${this.baseUrl}${path}`;
      const opts = {
        method,
        headers: { 'Content-Type': 'application/json', ...this.headers },
        signal: AbortSignal.timeout(3000)
      };
      if (body) opts.body = JSON.stringify(body);
      await fetch(url, opts);
    } catch (err) {
      this.logger.warn(`HTTP Light request failed: ${err.message}`);
    }
  }

  _rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    const s = max === 0 ? 0 : d / max;
    const v = max;

    if (d !== 0) {
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
      else if (max === g) h = ((b - r) / d + 2) * 60;
      else h = ((r - g) / d + 4) * 60;
    }

    return { h, s, bri: Math.round(v * 255) };
  }
}

export default HttpLightDriver;
