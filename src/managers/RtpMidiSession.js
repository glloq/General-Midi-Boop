// ============================================================================
// src/managers/RtpMidiSession.js
// ============================================================================
// Description:
//   Implémentation simplifiée du protocole RTP-MIDI (RFC 6295)
//   Gère une session RTP-MIDI pour envoyer/recevoir des messages MIDI via UDP
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

    // Session state
    this.sessionInitialized = false;
  }

  /**
   * Connecte à un peer distant
   * @param {string} host - Adresse IP du peer
   * @param {number} port - Port du peer
   */
  async connect(host, port = 5004) {
    return new Promise((resolve, reject) => {
      try {
        this.remoteHost = host;
        this.remotePort = port;

        // Créer socket UDP
        this.socket = dgram.createSocket('udp4');

        // Écouter les messages entrants
        this.socket.on('message', (msg, rinfo) => {
          this.handleIncomingMessage(msg, rinfo);
        });

        // Écouter les erreurs
        this.socket.on('error', (err) => {
          this.emit('error', err);
          reject(err);
        });

        // Écouter la fermeture
        this.socket.on('close', () => {
          this.connected = false;
          this.emit('disconnected');
        });

        // Bind sur le port local
        this.socket.bind(this.localPort, () => {
          console.log(`[RtpMidiSession] Listening on port ${this.localPort}`);

          // Envoyer invitation (simplified handshake)
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
   * Envoie une invitation au peer (simplified RTP-MIDI handshake)
   */
  sendInvitation() {
    // Simplified: Dans une vraie implémentation RTP-MIDI, on enverrait
    // un paquet de control avec la commande INVITATION
    // Pour cette version simplifiée, on marque juste la session comme initialisée
    this.sessionInitialized = true;
    this.emit('session:initialized');
  }

  /**
   * Gère les messages entrants
   * @param {Buffer} msg - Message reçu
   * @param {Object} rinfo - Informations sur l'émetteur
   */
  handleIncomingMessage(msg, rinfo) {
    try {
      // Parser le paquet RTP
      const rtpPacket = this.parseRtpPacket(msg);

      if (rtpPacket && rtpPacket.midiCommands.length > 0) {
        // Émettre chaque commande MIDI
        for (const midiCommand of rtpPacket.midiCommands) {
          this.emit('message', 0, midiCommand);
        }
      }
    } catch (error) {
      this.emit('error', new Error(`Failed to parse RTP packet: ${error.message}`));
    }
  }

  /**
   * Parse un paquet RTP-MIDI
   * Format simplifié (pour une vraie implémentation, voir RFC 6295)
   * @param {Buffer} buffer - Paquet RTP brut
   * @returns {Object} Paquet parsé
   */
  parseRtpPacket(buffer) {
    if (buffer.length < 12) {
      return null; // Paquet trop court
    }

    // Header RTP (12 bytes minimum)
    const version = (buffer[0] >> 6) & 0x03;
    const padding = (buffer[0] >> 5) & 0x01;
    const extension = (buffer[0] >> 4) & 0x01;
    const csrcCount = buffer[0] & 0x0F;
    const marker = (buffer[1] >> 7) & 0x01;
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

    // Parser les commandes MIDI du payload (simplified)
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
   * Parse le payload MIDI (RFC 6295 MIDI command section)
   * The first byte is a header byte indicating the length and structure
   * of the MIDI command section, followed by raw MIDI data.
   * @param {Buffer} payload - Payload MIDI
   * @returns {Array<Array<number>>} Liste de commandes MIDI
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
   * Détermine la longueur d'une commande MIDI basée sur le status byte
   * @param {number} status - Status byte
   * @returns {number} Longueur en bytes
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
   * Envoie un message MIDI
   * @param {Array<number>} midiBytes - Bytes MIDI à envoyer
   */
  sendMessage(midiBytes) {
    if (!this.connected || !this.socket) {
      throw new Error('Session not connected');
    }

    // Créer paquet RTP
    const rtpPacket = this.createRtpPacket(midiBytes);

    // Envoyer via UDP
    this.socket.send(rtpPacket, this.remotePort, this.remoteHost, (err) => {
      if (err) {
        this.emit('error', err);
      }
    });

    // Incrémenter numéro de séquence et timestamp
    this.sequenceNumber = (this.sequenceNumber + 1) & 0xFFFF;
    this.timestamp += 1; // Simplified: devrait être basé sur le temps réel
  }

  /**
   * Crée un paquet RTP contenant des commandes MIDI
   * @param {Array<number>} midiBytes - Commandes MIDI
   * @returns {Buffer} Paquet RTP
   */
  createRtpPacket(midiBytes) {
    // Header RTP (12 bytes)
    const header = Buffer.alloc(12);

    // Byte 0: Version (2), Padding (0), Extension (0), CSRC count (0)
    header[0] = 0x80; // Version 2

    // Byte 1: Marker (0), Payload type (97 pour MIDI)
    header[1] = 97;

    // Bytes 2-3: Sequence number
    header.writeUInt16BE(this.sequenceNumber, 2);

    // Bytes 4-7: Timestamp
    header.writeUInt32BE(this.timestamp, 4);

    // Bytes 8-11: SSRC
    header.writeUInt32BE(this.ssrc, 8);

    // Payload: MIDI commands
    const payload = Buffer.from(midiBytes);

    // Combiner header + payload
    return Buffer.concat([header, payload]);
  }

  /**
   * Déconnecte la session
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
   * Vérifie si la session est connectée
   * @returns {boolean}
   */
  isConnected() {
    return this.connected;
  }
}

export default RtpMidiSession;
