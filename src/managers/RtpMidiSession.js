// ============================================================================
// src/managers/RtpMidiSession.js
// ============================================================================
// Description:
//   Simplified implementation of the RTP-MIDI protocol (RFC 6295)
//   Manages an RTP-MIDI session for sending/receiving MIDI messages over UDP
// ============================================================================

import dgram from 'dgram';
import EventEmitter from 'events';

class RtpMidiSession extends EventEmitter {
  constructor(options = {}) {
    super();

    this.localName = options.localName || 'MidiMind';
    this.localPort = options.localPort || 0; // 0 = OS assigns random available port
    this.remoteHost = null;
    this.remotePort = null;
    this.socket = null;
    this.connected = false;

    // RTP state
    this.sequenceNumber = Math.floor(Math.random() * 0xFFFF);
    this.timestamp = 0;
    this.ssrc = Math.floor(Math.random() * 0xFFFFFFFF); // Synchronization source identifier
    this.timestampEpoch = Date.now(); // Reference time for RTP timestamp calculation
    this.RTP_MIDI_CLOCK_RATE = 10000; // 10 kHz clock rate per RFC 6295

    // Session state
    this.sessionInitialized = false;
  }

  /**
   * Connect to a remote peer
   * @param {string} host - Peer IP address
   * @param {number} port - Peer port
   */
  async connect(host, port = 5004) {
    return new Promise((resolve, reject) => {
      try {
        this.remoteHost = host;
        this.remotePort = port;

        // Create UDP socket
        this.socket = dgram.createSocket('udp4');

        // Listen for incoming messages
        this.socket.on('message', (msg, rinfo) => {
          this.handleIncomingMessage(msg, rinfo);
        });

        // Listen for errors
        this.socket.on('error', (err) => {
          this.emit('error', err);
          reject(err);
        });

        // Listen for socket close
        this.socket.on('close', () => {
          this.connected = false;
          this.emit('disconnected');
        });

        // Bind to the local port
        this.socket.bind(this.localPort, () => {
          this.emit('log', `Listening on port ${this.localPort}`);

          // Send invitation (simplified handshake)
          this.sendInvitation();

          this.connected = true;
          this.emit('connected', { host, port });
          resolve();
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Send an invitation to the peer (simplified RTP-MIDI handshake)
   */
  sendInvitation() {
    // Simplified: In a full RTP-MIDI implementation, we would send
    // a control packet with the INVITATION command
    // For this simplified version, we just mark the session as initialized
    this.sessionInitialized = true;
    this.emit('session:initialized');
  }

  /**
   * Handle incoming messages
   * @param {Buffer} msg - Received message
   * @param {Object} rinfo - Sender information
   */
  handleIncomingMessage(msg, _rinfo) {
    try {
      // Parse the RTP packet
      const rtpPacket = this.parseRtpPacket(msg);

      if (rtpPacket && rtpPacket.midiCommands.length > 0) {
        // Emit each MIDI command
        for (const midiCommand of rtpPacket.midiCommands) {
          this.emit('message', 0, midiCommand);
        }
      }
    } catch (error) {
      this.emit('error', new Error(`Failed to parse RTP packet: ${error.message}`));
    }
  }

  /**
   * Parse an RTP-MIDI packet
   * Simplified format (for full implementation, see RFC 6295)
   * @param {Buffer} buffer - Raw RTP packet
   * @returns {Object} Parsed packet
   */
  parseRtpPacket(buffer) {
    if (buffer.length < 12) {
      return null; // Packet too short
    }

    // Header RTP (12 bytes minimum)
    const version = (buffer[0] >> 6) & 0x03;
    const padding = (buffer[0] >> 5) & 0x01;
    const extension = (buffer[0] >> 4) & 0x01;
    const csrcCount = buffer[0] & 0x0F;
    const payloadType = buffer[1] & 0x7F;
    const sequenceNumber = buffer.readUInt16BE(2);
    const timestamp = buffer.readUInt32BE(4);
    const ssrc = buffer.readUInt32BE(8);

    let offset = 12 + (csrcCount * 4); // Skip CSRC identifiers

    if (extension) {
      // Skip extension header
      const extLength = buffer.readUInt16BE(offset + 2) * 4;
      offset += 4 + extLength;
    }

    if (padding) {
      const paddingLength = buffer[buffer.length - 1];
      buffer = buffer.slice(0, buffer.length - paddingLength);
    }

    // Payload = MIDI commands
    const payload = buffer.slice(offset);

    // Parse MIDI commands from the payload (simplified)
    const midiCommands = this.parseMidiPayload(payload);

    return {
      version,
      payloadType,
      sequenceNumber,
      timestamp,
      ssrc,
      midiCommands
    };
  }

  /**
   * Parse the MIDI payload (RFC 6295 MIDI command section)
   * The first byte is a header byte indicating the length and structure
   * of the MIDI command section, followed by raw MIDI data.
   * @param {Buffer} payload - MIDI payload
   * @returns {Array<Array<number>>} List of MIDI commands
   */
  parseMidiPayload(payload) {
    const commands = [];

    if (payload.length === 0) return commands;

    // RFC 6295: First byte is the MIDI command section header
    // Bit 7 (B): 1 if long header (2 bytes), 0 if short header (1 byte)
    // For short header: bits 3-0 = length of MIDI list in bytes
    let midiOffset = 0;
    let midiLength = 0;

    const headerByte = payload[0];
    if (headerByte & 0x80) {
      // Long header (2 bytes)
      if (payload.length < 2) return commands;
      midiLength = ((headerByte & 0x0F) << 8) | payload[1];
      midiOffset = 2;
    } else {
      // Short header (1 byte)
      midiLength = headerByte & 0x0F;
      midiOffset = 1;
    }

    // If midiLength is 0 or offset exceeds payload, no MIDI data
    if (midiLength === 0 || midiOffset >= payload.length) return commands;

    // Parse MIDI commands from the MIDI list
    const midiEnd = Math.min(midiOffset + midiLength, payload.length);
    let i = midiOffset;
    let runningStatus = 0;

    while (i < midiEnd) {
      // Skip delta-time bytes (RTP-MIDI uses variable-length delta-times)
      // Delta-time bytes have bit 7 clear; if byte has bit 7 set, it's a status byte
      while (i < midiEnd && !(payload[i] & 0x80)) {
        i++; // Skip delta-time
      }

      if (i >= midiEnd) break;

      const status = payload[i];

      // SysEx start
      if (status === 0xF0) {
        const sysexStart = i;
        i++;
        while (i < midiEnd && payload[i] !== 0xF7) i++;
        if (i < midiEnd) i++; // Include F7
        commands.push(Array.from(payload.slice(sysexStart, i)));
        runningStatus = 0;
        continue;
      }

      // System real-time (single byte, doesn't affect running status)
      if (status >= 0xF8) {
        commands.push([status]);
        i++;
        continue;
      }

      // Channel message or system common
      if (status >= 0x80) {
        runningStatus = status;
        i++;
      }

      if (runningStatus === 0) {
        i++;
        continue;
      }

      const commandLength = this.getMidiCommandLength(runningStatus);
      const dataBytes = commandLength - 1; // Exclude status byte

      if (i + dataBytes <= midiEnd) {
        const command = [runningStatus, ...Array.from(payload.slice(i, i + dataBytes))];
        commands.push(command);
        i += dataBytes;
      } else {
        break;
      }
    }

    return commands;
  }

  /**
   * Determine the length of a MIDI command based on the status byte
   * @param {number} status - Status byte
   * @returns {number} Length in bytes
   */
  getMidiCommandLength(status) {
    const command = status & 0xF0;

    switch (command) {
      case 0x80: // Note Off
      case 0x90: // Note On
      case 0xA0: // Poly Aftertouch
      case 0xB0: // Control Change
      case 0xE0: // Pitch Bend
        return 3;
      case 0xC0: // Program Change
      case 0xD0: // Channel Aftertouch
        return 2;
      case 0xF0: // System messages
        if (status === 0xF1) return 2; // MTC Quarter Frame
        if (status === 0xF2) return 3; // Song Position Pointer
        if (status === 0xF3) return 2; // Song Select
        if (status === 0xF6) return 1; // Tune Request
        if (status >= 0xF8) return 1;  // Real-time messages
        return 1; // SysEx and others: handled separately
      default:
        return 1;
    }
  }

  /**
   * Send a MIDI message
   * @param {Array<number>} midiBytes - MIDI bytes to send
   */
  sendMessage(midiBytes) {
    if (!this.connected || !this.socket) {
      throw new Error('Session not connected');
    }

    // Create RTP packet
    const rtpPacket = this.createRtpPacket(midiBytes);

    // Send via UDP
    this.socket.send(rtpPacket, this.remotePort, this.remoteHost, (err) => {
      if (err) {
        this.emit('error', err);
      }
    });

    // Increment sequence number (timestamp is now calculated from real time in createRtpPacket)
    this.sequenceNumber = (this.sequenceNumber + 1) & 0xFFFF;
  }

  /**
   * Create an RTP packet containing MIDI commands
   * RFC 6295 compliant: RTP header + MIDI command section header + MIDI data
   * @param {Array<number>} midiBytes - MIDI commands
   * @returns {Buffer} RTP packet
   */
  createRtpPacket(midiBytes) {
    // Calculate real-time based RTP timestamp (10 kHz clock rate per RFC 6295)
    const elapsedMs = Date.now() - this.timestampEpoch;
    this.timestamp = Math.floor(elapsedMs * this.RTP_MIDI_CLOCK_RATE / 1000) & 0xFFFFFFFF;

    // Header RTP (12 bytes)
    const header = Buffer.alloc(12);

    // Byte 0: Version (2), Padding (0), Extension (0), CSRC count (0)
    header[0] = 0x80; // Version 2

    // Byte 1: Marker (0), Payload type (97 for MIDI)
    header[1] = 97;

    // Bytes 2-3: Sequence number
    header.writeUInt16BE(this.sequenceNumber, 2);

    // Bytes 4-7: Timestamp
    header.writeUInt32BE(this.timestamp, 4);

    // Bytes 8-11: SSRC
    header.writeUInt32BE(this.ssrc, 8);

    // RFC 6295 MIDI command section header
    // Short header (1 byte) when MIDI data length <= 15 bytes
    // Long header (2 bytes) when MIDI data length > 15 bytes
    // Bit 4 (P): 0 = no phantom status, Bit 5 (Z): 0 = MIDI list present
    // Bit 6 (J): 0 = no journal section
    const midiLength = midiBytes.length;
    let midiHeader;

    if (midiLength <= 0x0F) {
      // Short header: B=0, J=0, Z=0, P=0, length in bits 3-0
      midiHeader = Buffer.from([midiLength & 0x0F]);
    } else {
      // Long header: B=1, J=0, Z=0, P=0, length in 12 bits
      const highByte = 0x80 | ((midiLength >> 8) & 0x0F);
      const lowByte = midiLength & 0xFF;
      midiHeader = Buffer.from([highByte, lowByte]);
    }

    // Payload: MIDI command section header + MIDI data
    const payload = Buffer.from(midiBytes);

    // Combine header + MIDI command section header + payload
    return Buffer.concat([header, midiHeader, payload]);
  }

  /**
   * Disconnect the session
   */
  async disconnect() {
    return new Promise((resolve) => {
      if (this.socket) {
        this.socket.close(() => {
          this.connected = false;
          this.sessionInitialized = false;
          this.emit('disconnected');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Check if the session is connected
   * @returns {boolean}
   */
  isConnected() {
    return this.connected;
  }
}

export default RtpMidiSession;
