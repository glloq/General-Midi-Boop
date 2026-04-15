// src/lighting/MqttLightDriver.js
// MQTT driver for smart lighting (WLED, Tasmota, ESPHome, Home Assistant, generic)
// Supports multiple MQTT payload formats for different firmware types

import BaseLightingDriver from './BaseLightingDriver.js';

class MqttLightDriver extends BaseLightingDriver {
  constructor(device, logger) {
    super(device, logger);
    this.client = null;
    this._currentColors = []; // Cache per-LED colors for batch operations
  }

  async connect() {
    try {
      const mqtt = await import('mqtt');
      const config = this.device.connection_config;

      this.brokerUrl = config.broker_url || 'mqtt://localhost:1883';
      this.baseTopic = (config.base_topic || 'maestro/light').replace(/\/$/, '');
      this.firmware = config.firmware || 'generic'; // 'wled', 'tasmota', 'esphome', 'generic'
      this.username = config.username || undefined;
      this.password = config.password || undefined;
      this.qos = config.qos || 0;
      this.retain = config.retain !== false;

      // Initialize color cache
      this._currentColors = new Array(this.device.led_count).fill(null).map(() => ({ r: 0, g: 0, b: 0 }));

      this.client = mqtt.default
        ? mqtt.default.connect(this.brokerUrl, { username: this.username, password: this.password, reconnectPeriod: 5000 })
        : mqtt.connect(this.brokerUrl, { username: this.username, password: this.password, reconnectPeriod: 5000 });

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('MQTT connection timeout')), 10000);
        this.client.on('connect', () => { clearTimeout(timeout); resolve(); });
        this.client.on('error', (err) => { clearTimeout(timeout); reject(err); });
      });

      this.connected = true;
      this.logger.info(`MQTT Light driver connected: ${this.brokerUrl}, firmware=${this.firmware}, topic=${this.baseTopic}`);
      this.emit('connected');
    } catch (error) {
      this.logger.error(`MQTT Light driver connect failed: ${error.message}`);
      throw error;
    }
  }

  async _doDisconnect() {
    if (this.client) {
      this.allOff();
      await new Promise(resolve => {
        this.client.end(false, {}, () => resolve());
      });
      this.client = null;
    }
  }

  setColor(ledIndex, r, g, b, brightness = 255) {
    if (!this.client) return;
    const { r: adjR, g: adjG, b: adjB } = this._adjustColor(r, g, b, brightness);

    if (ledIndex >= 0 && ledIndex < this._currentColors.length) {
      this._currentColors[ledIndex] = { r: adjR, g: adjG, b: adjB };
    }

    this._publishColor(ledIndex, adjR, adjG, adjB, brightness);
  }

  setRange(startLed, endLed, r, g, b, brightness = 255) {
    if (!this.client) return;
    const end = endLed === -1 ? this.device.led_count - 1 : endLed;
    const { r: adjR, g: adjG, b: adjB } = this._adjustColor(r, g, b, brightness);

    // For WLED, use the API endpoint for range
    if (this.firmware === 'wled') {
      this._publishWledRange(startLed, end, adjR, adjG, adjB, brightness);
      return;
    }

    for (let i = startLed; i <= end; i++) {
      if (i >= 0 && i < this._currentColors.length) {
        this._currentColors[i] = { r: adjR, g: adjG, b: adjB };
      }
      this._publishColor(i, adjR, adjG, adjB, brightness);
    }
  }

  allOff() {
    if (!this.client) return;

    switch (this.firmware) {
      case 'wled':
        this._publish(`${this.baseTopic}/api`, JSON.stringify({ on: false }));
        break;
      case 'tasmota':
        this._publish(`${this.baseTopic}/cmnd/Power`, 'OFF');
        break;
      case 'esphome':
        this._publish(`${this.baseTopic}/light/command`, JSON.stringify({ state: 'OFF' }));
        break;
      default:
        this._publish(`${this.baseTopic}/set`, JSON.stringify({ state: 'OFF', color: { r: 0, g: 0, b: 0 }, brightness: 0 }));
    }

    this._currentColors.forEach(c => { c.r = 0; c.g = 0; c.b = 0; });
  }

  _publishColor(ledIndex, r, g, b, brightness) {
    switch (this.firmware) {
      case 'wled':
        this._publishWledColor(ledIndex, r, g, b, brightness);
        break;
      case 'tasmota':
        this._publishTasmotaColor(r, g, b, brightness);
        break;
      case 'esphome':
        this._publishEspHomeColor(ledIndex, r, g, b, brightness);
        break;
      default:
        this._publishGenericColor(ledIndex, r, g, b, brightness);
        break;
    }
  }

  _publishWledColor(ledIndex, r, g, b, brightness) {
    // WLED JSON API over MQTT
    const payload = {
      on: true,
      bri: Math.max(0, Math.min(255, brightness)),
      seg: [{
        id: 0,
        i: [ledIndex, [r, g, b]]
      }]
    };
    this._publish(`${this.baseTopic}/api`, JSON.stringify(payload));
  }

  _publishWledRange(startLed, endLed, r, g, b, brightness) {
    const payload = {
      on: true,
      bri: Math.max(0, Math.min(255, brightness)),
      seg: [{
        id: 0,
        i: [startLed, endLed + 1, [r, g, b]]
      }]
    };
    this._publish(`${this.baseTopic}/api`, JSON.stringify(payload));
  }

  _publishTasmotaColor(r, g, b, brightness) {
    // Tasmota format: Color1 for RGB, Dimmer for brightness
    const hex = `${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    this._publish(`${this.baseTopic}/cmnd/Color1`, hex);
    this._publish(`${this.baseTopic}/cmnd/Dimmer`, String(Math.round(brightness * 100 / 255)));
  }

  _publishEspHomeColor(ledIndex, r, g, b, brightness) {
    const payload = {
      state: 'ON',
      color: { r, g, b },
      brightness: Math.round(brightness)
    };
    this._publish(`${this.baseTopic}/light/${ledIndex}/command`, JSON.stringify(payload));
  }

  _publishGenericColor(ledIndex, r, g, b, brightness) {
    const payload = {
      state: 'ON',
      led: ledIndex,
      color: { r, g, b },
      brightness: Math.round(brightness)
    };
    this._publish(`${this.baseTopic}/set`, JSON.stringify(payload));
  }

  _publish(topic, message) {
    if (this.client && this.client.connected) {
      this.client.publish(topic, message, { qos: this.qos, retain: this.retain });
    }
  }
}

export default MqttLightDriver;
