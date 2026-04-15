// src/lighting/OscLightDriver.js
// OSC (Open Sound Control) driver for lighting software integration
// Compatible with: QLC+, QLab, TouchDesigner, Max/MSP, ETC Eos, etc.

import BaseLightingDriver from './BaseLightingDriver.js';
import dgram from 'dgram';

class OscLightDriver extends BaseLightingDriver {
  constructor(device, logger) {
    super(device, logger);
    this.socket = null;
    this._pendingMessages = [];
  }

  async connect() {
    try {
      const config = this.device.connection_config;
      this.host = config.host || '127.0.0.1';
      this.port = config.port || 8000;
      this.addressPattern = config.address_pattern || '/light/{led}';
      this.colorFormat = config.color_format || 'rgb_float'; // 'rgb_float' (0-1), 'rgb_int' (0-255), 'rgbw_float', 'rgbw_int'

      this.socket = dgram.createSocket('udp4');

      await new Promise((resolve, reject) => {
        this.socket.bind(0, () => resolve());
        this.socket.on('error', reject);
      });

      this.connected = true;
      this.logger.info(`OSC Light driver connected: ${this.host}:${this.port}, pattern=${this.addressPattern}`);
      this.emit('connected');
    } catch (error) {
      this.logger.error(`OSC Light driver connect failed: ${error.message}`);
      throw error;
    }
  }

  async _doDisconnect() {
    this.allOff();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  setColor(ledIndex, r, g, b, brightness = 255) {
    const { r: adjR, g: adjG, b: adjB } = this._adjustColor(r, g, b, brightness);

    const address = this.addressPattern.replace('{led}', ledIndex);
    this._sendOscColor(address, adjR, adjG, adjB);
  }

  setRange(startLed, endLed, r, g, b, brightness = 255) {
    const end = endLed === -1 ? this.device.led_count - 1 : endLed;
    const { r: adjR, g: adjG, b: adjB } = this._adjustColor(r, g, b, brightness);

    for (let i = startLed; i <= end; i++) {
      const address = this.addressPattern.replace('{led}', i);
      this._pendingMessages.push({ address, r: adjR, g: adjG, b: adjB });
    }

    this._scheduleRender();
  }

  allOff() {
    // Send a master off message
    this._sendOscMessage('/light/master', [{ type: 'f', value: 0.0 }]);

    // Also set each LED to black
    for (let i = 0; i < this.device.led_count; i++) {
      const address = this.addressPattern.replace('{led}', i);
      this._sendOscColor(address, 0, 0, 0);
    }
  }

  _doRender() {
    this._flushPending();
  }

  _flushPending() {
    for (const msg of this._pendingMessages) {
      this._sendOscColor(msg.address, msg.r, msg.g, msg.b);
    }
    this._pendingMessages = [];
  }

  _sendOscColor(address, r, g, b) {
    const isFloat = this.colorFormat.includes('float');
    const args = isFloat
      ? [
        { type: 'f', value: r / 255 },
        { type: 'f', value: g / 255 },
        { type: 'f', value: b / 255 }
      ]
      : [
        { type: 'i', value: r },
        { type: 'i', value: g },
        { type: 'i', value: b }
      ];

    if (this.colorFormat.includes('rgbw')) {
      args.push(isFloat ? { type: 'f', value: 0.0 } : { type: 'i', value: 0 });
    }

    this._sendOscMessage(address, args);
  }

  _sendOscMessage(address, args) {
    if (!this.socket) return;

    const packet = this._encodeOscMessage(address, args);
    this.socket.send(packet, 0, packet.length, this.port, this.host);
  }

  _encodeOscMessage(address, args) {
    // OSC message format: address string, type tag string, arguments
    const addrBuf = this._encodeOscString(address);
    const typeTag = ',' + args.map(a => a.type).join('');
    const typeBuf = this._encodeOscString(typeTag);

    const argBuffers = args.map(arg => {
      const buf = Buffer.alloc(4);
      if (arg.type === 'f') buf.writeFloatBE(arg.value, 0);
      else if (arg.type === 'i') buf.writeInt32BE(arg.value, 0);
      return buf;
    });

    return Buffer.concat([addrBuf, typeBuf, ...argBuffers]);
  }

  _encodeOscString(str) {
    // OSC strings are null-terminated and padded to 4-byte boundary
    const strBytes = Buffer.from(str, 'utf8');
    const padded = strBytes.length + 1; // +1 for null terminator
    const aligned = Math.ceil(padded / 4) * 4;
    const buf = Buffer.alloc(aligned, 0);
    strBytes.copy(buf);
    return buf;
  }
}

export default OscLightDriver;
