// src/lighting/ArtNetDriver.js
// Art-Net (DMX over Ethernet) driver for professional lighting fixtures
// Implements Art-Net protocol v4 (OemCode 0xFFFF for open source)

import BaseLightingDriver from './BaseLightingDriver.js';
import dgram from 'dgram';

const ARTNET_PORT = 6454;
const ARTNET_HEADER = Buffer.from([0x41, 0x72, 0x74, 0x2D, 0x4E, 0x65, 0x74, 0x00]); // "Art-Net\0"
const OPCODE_DMX = 0x5000;

class ArtNetDriver extends BaseLightingDriver {
  constructor(device, logger) {
    super(device, logger);
    this.socket = null;
    this.dmxData = null;
    this.sequence = 0;
  }

  async connect() {
    try {
      const config = this.device.connection_config;
      this.host = config.host || '255.255.255.255';
      this.port = config.port || ARTNET_PORT;
      this.universe = config.universe || 0;
      this.subnet = config.subnet || 0;
      this.net = config.net || 0;
      this.channelsPerLed = config.channels_per_led || 3; // 3=RGB, 4=RGBW

      // DMX universe = 512 channels max
      const totalChannels = Math.min(512, this.device.led_count * this.channelsPerLed);
      this.dmxData = Buffer.alloc(totalChannels, 0);

      this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      await new Promise((resolve, reject) => {
        this.socket.bind(0, () => {
          if (this.host === '255.255.255.255') {
            this.socket.setBroadcast(true);
          }
          resolve();
        });
        this.socket.on('error', reject);
      });

      this.connected = true;
      this.logger.info(`ArtNet driver connected: ${this.host}:${this.port}, universe ${this.universe}, ${this.device.led_count} LED(s)`);
      this.emit('connected');
    } catch (error) {
      this.logger.error(`ArtNet driver connect failed: ${error.message}`);
      throw error;
    }
  }

  async _doDisconnect() {
    if (this.dmxData) {
      this.dmxData.fill(0);
      this._sendDmxPacket();
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  setColor(ledIndex, r, g, b, brightness = 255) {
    if (!this.dmxData) return;
    const baseChannel = ledIndex * this.channelsPerLed;
    if (baseChannel + this.channelsPerLed > this.dmxData.length) return;

    this.dmxData[baseChannel] = this._applyBrightness(r, brightness);
    this.dmxData[baseChannel + 1] = this._applyBrightness(g, brightness);
    this.dmxData[baseChannel + 2] = this._applyBrightness(b, brightness);

    // RGBW: set white channel to 0 (pure RGB mode)
    if (this.channelsPerLed >= 4) {
      this.dmxData[baseChannel + 3] = 0;
    }

    this._scheduleRender();
  }

  setRange(startLed, endLed, r, g, b, brightness = 255) {
    if (!this.dmxData) return;
    const end = endLed === -1 ? this.device.led_count - 1 : endLed;
    const { r: adjR, g: adjG, b: adjB } = this._adjustColor(r, g, b, brightness);

    for (let i = startLed; i <= end; i++) {
      const base = i * this.channelsPerLed;
      if (base + this.channelsPerLed > this.dmxData.length) break;
      this.dmxData[base] = adjR;
      this.dmxData[base + 1] = adjG;
      this.dmxData[base + 2] = adjB;
      if (this.channelsPerLed >= 4) this.dmxData[base + 3] = 0;
    }

    this._scheduleRender();
  }

  /**
   * Set raw DMX channel value (for non-RGB fixtures: dimmers, moving heads, etc.)
   */
  setDmxChannel(channel, value) {
    if (!this.dmxData || channel < 0 || channel >= this.dmxData.length) return;
    this.dmxData[channel] = Math.max(0, Math.min(255, value));
    this._scheduleRender();
  }

  /**
   * Set raw DMX channel values for a fixture profile
   * @param {number} startChannel - DMX start channel (0-based)
   * @param {Array<number>} values - Channel values array
   */
  setFixture(startChannel, values) {
    if (!this.dmxData) return;
    for (let i = 0; i < values.length; i++) {
      const ch = startChannel + i;
      if (ch < this.dmxData.length) {
        this.dmxData[ch] = Math.max(0, Math.min(255, values[i]));
      }
    }
    this._scheduleRender();
  }

  /**
   * Get current DMX channel values for monitoring
   */
  getDmxValues() {
    return this.dmxData ? [...this.dmxData] : [];
  }

  allOff() {
    if (this.dmxData) {
      this.dmxData.fill(0);
      this._sendDmxPacket();
    }
  }

  _doRender() {
    this._sendDmxPacket();
  }

  _sendDmxPacket() {
    if (!this.socket || !this.dmxData) return;

    this.sequence = (this.sequence + 1) % 256;
    if (this.sequence === 0) this.sequence = 1;

    // Art-Net DMX packet structure
    const dataLength = this.dmxData.length;
    const packet = Buffer.alloc(18 + dataLength);

    // Header "Art-Net\0"
    ARTNET_HEADER.copy(packet, 0);
    // OpCode (little-endian)
    packet[8] = OPCODE_DMX & 0xFF;
    packet[9] = (OPCODE_DMX >> 8) & 0xFF;
    // Protocol version (14)
    packet[10] = 0x00;
    packet[11] = 14;
    // Sequence
    packet[12] = this.sequence;
    // Physical port
    packet[13] = 0;
    // SubUni (universe in lower nibble, subnet in upper)
    packet[14] = (this.subnet << 4) | (this.universe & 0x0F);
    // Net
    packet[15] = this.net & 0x7F;
    // Length (big-endian)
    packet[16] = (dataLength >> 8) & 0xFF;
    packet[17] = dataLength & 0xFF;
    // DMX data
    this.dmxData.copy(packet, 18);

    this.socket.send(packet, 0, packet.length, this.port, this.host);
  }
}

export default ArtNetDriver;
