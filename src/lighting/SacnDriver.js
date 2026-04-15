// src/lighting/SacnDriver.js
// sACN / E1.31 (Streaming ACN) driver for modern DMX over Ethernet
// Used by many LED controllers, architectural lighting, and show lighting software

import BaseLightingDriver from './BaseLightingDriver.js';
import dgram from 'dgram';

const SACN_PORT = 5568;
const ACN_PACKET_ID = Buffer.from([
  0x41, 0x53, 0x43, 0x2D, 0x45, 0x31, 0x2E, 0x31,
  0x37, 0x00, 0x00, 0x00
]); // "ASC-E1.17\0\0\0"

class SacnDriver extends BaseLightingDriver {
  constructor(device, logger) {
    super(device, logger);
    this.socket = null;
    this.dmxData = null;
    this.sequence = 0;
    this._cid = null; // Component Identifier (UUID)
  }

  async connect() {
    try {
      const config = this.device.connection_config;
      this.universe = config.universe || 1;
      this.priority = config.priority || 100;
      this.channelsPerLed = config.channels_per_led || 3;
      this.sourceName = config.source_name || 'Ma-est-tro';
      this.multicast = config.multicast !== false;
      this.unicastHost = config.host || null;

      // Generate CID (random UUID bytes)
      this._cid = Buffer.alloc(16);
      for (let i = 0; i < 16; i++) this._cid[i] = Math.floor(Math.random() * 256);

      const totalChannels = Math.min(512, this.device.led_count * this.channelsPerLed);
      this.dmxData = Buffer.alloc(totalChannels + 1, 0); // +1 for DMX start code

      this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      await new Promise((resolve, reject) => {
        this.socket.bind(0, () => {
          if (this.multicast) {
            this.socket.setMulticastTTL(20);
          }
          resolve();
        });
        this.socket.on('error', reject);
      });

      this.connected = true;
      const target = this.multicast ? `multicast ${this._getMulticastAddress()}` : `unicast ${this.unicastHost}`;
      this.logger.info(`sACN driver connected: ${target}:${SACN_PORT}, universe ${this.universe}, ${this.device.led_count} LED(s)`);
      this.emit('connected');
    } catch (error) {
      this.logger.error(`sACN driver connect failed: ${error.message}`);
      throw error;
    }
  }

  async _doDisconnect() {
    if (this.dmxData) {
      this.dmxData.fill(0);
      this._sendPacket();
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  setColor(ledIndex, r, g, b, brightness = 255) {
    if (!this.dmxData) return;
    const base = 1 + ledIndex * this.channelsPerLed; // +1 for start code
    if (base + this.channelsPerLed > this.dmxData.length) return;

    this.dmxData[base] = this._applyBrightness(r, brightness);
    this.dmxData[base + 1] = this._applyBrightness(g, brightness);
    this.dmxData[base + 2] = this._applyBrightness(b, brightness);
    if (this.channelsPerLed >= 4) this.dmxData[base + 3] = 0;

    this._scheduleRender();
  }

  setRange(startLed, endLed, r, g, b, brightness = 255) {
    if (!this.dmxData) return;
    const end = endLed === -1 ? this.device.led_count - 1 : endLed;
    const { r: adjR, g: adjG, b: adjB } = this._adjustColor(r, g, b, brightness);

    for (let i = startLed; i <= end; i++) {
      const base = 1 + i * this.channelsPerLed;
      if (base + this.channelsPerLed > this.dmxData.length) break;
      this.dmxData[base] = adjR;
      this.dmxData[base + 1] = adjG;
      this.dmxData[base + 2] = adjB;
      if (this.channelsPerLed >= 4) this.dmxData[base + 3] = 0;
    }

    this._scheduleRender();
  }

  allOff() {
    if (this.dmxData) {
      this.dmxData.fill(0);
      this._sendPacket();
    }
  }

  _doRender() {
    this._sendPacket();
  }

  _getMulticastAddress() {
    // sACN multicast: 239.255.{universe_hi}.{universe_lo}
    return `239.255.${(this.universe >> 8) & 0xFF}.${this.universe & 0xFF}`;
  }

  _sendPacket() {
    if (!this.socket || !this.dmxData) return;

    this.sequence = (this.sequence + 1) % 256;

    const slotCount = this.dmxData.length;
    const packet = this._buildDataPacket(slotCount);

    const host = this.multicast ? this._getMulticastAddress() : this.unicastHost;
    if (host) {
      this.socket.send(packet, 0, packet.length, SACN_PORT, host);
    }
  }

  _buildDataPacket(slotCount) {
    // E1.31 Data Packet - simplified but protocol-compliant structure
    const packetLength = 126 + slotCount;
    const buf = Buffer.alloc(packetLength, 0);
    let offset = 0;

    // === Root Layer ===
    // Preamble Size (0x0010)
    buf.writeUInt16BE(0x0010, offset); offset += 2;
    // Post-amble Size (0x0000)
    buf.writeUInt16BE(0x0000, offset); offset += 2;
    // ACN Packet Identifier
    ACN_PACKET_ID.copy(buf, offset); offset += 12;
    // Flags & Length (root)
    const rootLength = packetLength - 16;
    buf.writeUInt16BE(0x7000 | (rootLength & 0x0FFF), offset); offset += 2;
    // Vector (VECTOR_ROOT_E131_DATA = 0x00000004)
    buf.writeUInt32BE(0x00000004, offset); offset += 4;
    // CID
    this._cid.copy(buf, offset); offset += 16;

    // === Framing Layer ===
    const framingLength = packetLength - 38;
    buf.writeUInt16BE(0x7000 | (framingLength & 0x0FFF), offset); offset += 2;
    // Vector (VECTOR_E131_DATA_PACKET = 0x00000002)
    buf.writeUInt32BE(0x00000002, offset); offset += 4;
    // Source Name (64 bytes)
    const nameBytes = Buffer.from(this.sourceName, 'utf8');
    nameBytes.copy(buf, offset, 0, Math.min(63, nameBytes.length));
    offset += 64;
    // Priority
    buf[offset++] = this.priority;
    // Synchronization Address
    buf.writeUInt16BE(0, offset); offset += 2;
    // Sequence Number
    buf[offset++] = this.sequence;
    // Options
    buf[offset++] = 0;
    // Universe
    buf.writeUInt16BE(this.universe, offset); offset += 2;

    // === DMP Layer ===
    const dmpLength = packetLength - 115;
    buf.writeUInt16BE(0x7000 | (dmpLength & 0x0FFF), offset); offset += 2;
    // Vector (VECTOR_DMP_SET_PROPERTY = 0x02)
    buf[offset++] = 0x02;
    // Address Type & Data Type
    buf[offset++] = 0xA1;
    // First Property Address
    buf.writeUInt16BE(0x0000, offset); offset += 2;
    // Address Increment
    buf.writeUInt16BE(0x0001, offset); offset += 2;
    // Property value count
    buf.writeUInt16BE(slotCount, offset); offset += 2;
    // DMX data (including start code at byte 0)
    this.dmxData.copy(buf, offset);

    return buf;
  }
}

export default SacnDriver;
