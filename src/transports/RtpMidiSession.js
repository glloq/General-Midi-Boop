/**
 * @file src/transports/RtpMidiSession.js
 * @description One AppleMIDI (RTP-MIDI) session with a single remote peer.
 * Created and owned by {@link NetworkManager}. Performs the AppleMIDI
 * invitation handshake (control port then data port) so real network-MIDI
 * peers actually accept our MIDI, responds to incoming invitations, keeps the
 * session alive with clock-sync (CK), and converts RTP-MIDI frames both ways.
 *
 * Socket I/O is injected (`sendControl` / `sendData`) so the handshake state
 * machine can be unit-tested without real UDP sockets or hardware. The
 * RFC-6295 RTP-MIDI packet build/parse is unchanged.
 */

import EventEmitter from 'events';
import {
  CMD,
  isControlPacket,
  commandOf,
  encodeInvitation,
  decodeInvitation,
  encodeEnd,
  encodeClockSync,
  decodeClockSync
} from './AppleMidi.js';

const HANDSHAKE_TIMEOUT_MS = 8000;
const CLOCK_SYNC_INTERVAL_MS = 10000;
// Close the session if no packet arrives from the peer for this long. We send
// clock-sync every CLOCK_SYNC_INTERVAL_MS and the peer echoes it, so silence
// this long means the peer is gone (audit P2 — network drops undetected).
const RECEIVER_TIMEOUT_MS = 35000;

function randomU32() {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

class RtpMidiSession extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {string} [options.localName]
   * @param {number} [options.ssrc]
   * @param {(buf:Buffer)=>void} [options.sendControl] - send to remote control port
   * @param {(buf:Buffer)=>void} [options.sendData]    - send to remote data port
   * @param {number} [options.handshakeTimeoutMs]
   */
  constructor(options = {}) {
    super();
    this.localName = options.localName || 'GeneralMidiBoop';
    this.ssrc = options.ssrc != null ? options.ssrc >>> 0 : randomU32();
    this._sendControl = typeof options.sendControl === 'function' ? options.sendControl : null;
    this._sendData = typeof options.sendData === 'function' ? options.sendData : null;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs || HANDSHAKE_TIMEOUT_MS;

    this.remoteHost = null;
    this.remoteControlPort = null;
    this.remoteDataPort = null;
    this.remoteSsrc = null;
    this.initiatorToken = null;

    // 'idle' | 'inviting-control' | 'inviting-data' | 'established' | 'closed'
    this.state = 'idle';
    this.connected = false;

    // RTP state
    this.sequenceNumber = randomU32() & 0xffff;
    this.timestamp = 0;
    this.timestampEpoch = Date.now();
    this.RTP_MIDI_CLOCK_RATE = 10000; // 10 kHz per RFC 6295

    this._handshakeTimer = null;
    this._clockTimer = null;
    this._watchdogTimer = null;
    this._lastRxAt = Date.now();
    this._resolveConnect = null;
    this._rejectConnect = null;
  }

  /**
   * Initiate a session with a remote peer: send an AppleMIDI invitation on the
   * control port; on acceptance invite on the data port; the returned promise
   * resolves once the peer accepts BOTH (session established) and rejects on
   * timeout or an explicit rejection.
   *
   * @param {string} host
   * @param {number} [controlPort=5004]
   * @param {number} [dataPort=controlPort+1]
   * @returns {Promise<void>}
   */
  connect(host, controlPort = 5004, dataPort) {
    this.remoteHost = host;
    this.remoteControlPort = controlPort;
    this.remoteDataPort = dataPort != null ? dataPort : controlPort + 1;
    this.initiatorToken = randomU32();
    this.state = 'inviting-control';

    return new Promise((resolve, reject) => {
      this._resolveConnect = resolve;
      this._rejectConnect = reject;
      if (!this._sendControl) {
        reject(new Error('RtpMidiSession: no control sender wired'));
        return;
      }
      this._sendControl(
        encodeInvitation(CMD.INVITATION, {
          initiatorToken: this.initiatorToken,
          ssrc: this.ssrc,
          name: this.localName
        })
      );
      this._handshakeTimer = setTimeout(() => {
        if (this.state !== 'established') {
          this._failConnect(new Error(`AppleMIDI handshake timeout (${host})`));
        }
      }, this.handshakeTimeoutMs);
    });
  }

  /**
   * Handle a datagram received on the CONTROL port for this peer.
   * @param {Buffer} msg
   */
  handleControlPacket(msg) {
    this._lastRxAt = Date.now();
    const cmd = commandOf(msg);
    if (cmd === CMD.INVITATION) {
      // Incoming invitation (we are the responder): accept it.
      const inv = decodeInvitation(msg);
      if (!inv) return;
      this.remoteSsrc = inv.ssrc;
      this._sendControl?.(
        encodeInvitation(CMD.INVITATION_ACCEPTED, {
          initiatorToken: inv.initiatorToken,
          ssrc: this.ssrc,
          name: this.localName
        })
      );
      return;
    }
    if (cmd === CMD.INVITATION_ACCEPTED) {
      // Our control invitation was accepted → invite on the data port.
      const inv = decodeInvitation(msg);
      if (inv) this.remoteSsrc = inv.ssrc;
      if (this.state === 'inviting-control') {
        this.state = 'inviting-data';
        this._sendData?.(
          encodeInvitation(CMD.INVITATION, {
            initiatorToken: this.initiatorToken,
            ssrc: this.ssrc,
            name: this.localName
          })
        );
      }
      return;
    }
    if (cmd === CMD.INVITATION_REJECTED) {
      this._failConnect(new Error('AppleMIDI invitation rejected by peer'));
      return;
    }
    if (cmd === CMD.END) {
      this._onPeerEnd();
    }
  }

  /**
   * Handle a datagram received on the DATA port for this peer: AppleMIDI
   * control (data-port invitation OK / incoming IN / clock-sync) or an
   * RTP-MIDI data frame.
   * @param {Buffer} msg
   */
  handleDataPacket(msg) {
    this._lastRxAt = Date.now();
    if (isControlPacket(msg)) {
      const cmd = commandOf(msg);
      if (cmd === CMD.INVITATION_ACCEPTED) {
        if (this.state === 'inviting-data') this._establish();
        return;
      }
      if (cmd === CMD.INVITATION) {
        // Responder path: accept the data-port invitation and go live.
        const inv = decodeInvitation(msg);
        if (inv) {
          this.remoteSsrc = inv.ssrc;
          this._sendData?.(
            encodeInvitation(CMD.INVITATION_ACCEPTED, {
              initiatorToken: inv.initiatorToken,
              ssrc: this.ssrc,
              name: this.localName
            })
          );
        }
        this._establish();
        return;
      }
      if (cmd === CMD.CLOCK_SYNC) {
        this._handleClockSync(msg);
        return;
      }
      if (cmd === CMD.END) {
        this._onPeerEnd();
      }
      return;
    }

    // RTP-MIDI data frame → emit each parsed MIDI command.
    try {
      const rtpPacket = this.parseRtpPacket(msg);
      if (rtpPacket && rtpPacket.midiCommands.length > 0) {
        for (const midiCommand of rtpPacket.midiCommands) {
          this.emit('message', 0, midiCommand);
        }
      }
    } catch (error) {
      this.emit('error', new Error(`Failed to parse RTP packet: ${error.message}`));
    }
  }

  /** Transition to the established state exactly once. @private */
  _establish() {
    if (this.state === 'established') return;
    this.state = 'established';
    this.connected = true;
    if (this._handshakeTimer) {
      clearTimeout(this._handshakeTimer);
      this._handshakeTimer = null;
    }
    this.emit('connected', { host: this.remoteHost, port: this.remoteControlPort });
    if (this._resolveConnect) {
      this._resolveConnect();
      this._resolveConnect = null;
      this._rejectConnect = null;
    }
    this._lastRxAt = Date.now();
    this._startClockSync();
    this._startWatchdog();
  }

  /** Close the session if the peer goes silent past RECEIVER_TIMEOUT_MS. @private */
  _startWatchdog() {
    if (this._watchdogTimer) return;
    this._watchdogTimer = setInterval(() => {
      if (this.state !== 'established') return;
      if (Date.now() - this._lastRxAt > RECEIVER_TIMEOUT_MS) {
        this.emit('log', `RTP-MIDI peer ${this.remoteHost} timed out (no traffic)`);
        this.close();
      }
    }, RECEIVER_TIMEOUT_MS);
    if (this._watchdogTimer.unref) this._watchdogTimer.unref();
  }

  /** @private */
  _failConnect(err) {
    if (this._rejectConnect) {
      this._rejectConnect(err);
      this._resolveConnect = null;
      this._rejectConnect = null;
    } else {
      this.emit('error', err);
    }
    this.close();
  }

  /** @private */
  _onPeerEnd() {
    this.emit('log', `Peer ended AppleMIDI session (${this.remoteHost})`);
    this.close();
  }

  /** Current 10 kHz session timestamp. @private */
  _now10k() {
    return Math.floor(((Date.now() - this.timestampEpoch) * this.RTP_MIDI_CLOCK_RATE) / 1000);
  }

  /**
   * Clock-sync state machine (3-way). We answer a peer-initiated CK (count 0 →
   * reply 1; count 1 → reply 2) and complete our own initiated sync. Precise
   * offset estimation isn't required for correct delivery, but responding
   * keeps peers (which drop silent sessions) alive.
   * @private
   */
  _handleClockSync(msg) {
    const ck = decodeClockSync(msg);
    if (!ck) return;
    if (ck.count === 0) {
      this._sendData?.(
        encodeClockSync({ ssrc: this.ssrc, count: 1, ts1: ck.ts1, ts2: this._now10k(), ts3: 0 })
      );
    } else if (ck.count === 1) {
      this._sendData?.(
        encodeClockSync({
          ssrc: this.ssrc,
          count: 2,
          ts1: ck.ts1,
          ts2: ck.ts2,
          ts3: this._now10k()
        })
      );
    }
    // count === 2 → synchronization round complete; nothing to send.
  }

  /** Periodically initiate a clock-sync so the peer keeps the session. @private */
  _startClockSync() {
    if (this._clockTimer) return;
    const tick = () => {
      if (this.state !== 'established') return;
      this._sendData?.(
        encodeClockSync({ ssrc: this.ssrc, count: 0, ts1: this._now10k(), ts2: 0, ts3: 0 })
      );
    };
    tick();
    this._clockTimer = setInterval(tick, CLOCK_SYNC_INTERVAL_MS);
    if (this._clockTimer.unref) this._clockTimer.unref();
  }

  /**
   * Send a MIDI message to the peer as an RTP-MIDI data frame.
   * @param {Array<number>} midiBytes
   */
  sendMessage(midiBytes) {
    if (this.state !== 'established' || !this._sendData) {
      throw new Error('Session not established');
    }
    this._sendData(this.createRtpPacket(midiBytes));
    this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
  }

  /**
   * Parse an RTP-MIDI packet (RFC 6295).
   * @param {Buffer} buffer
   * @returns {Object|null}
   */
  parseRtpPacket(buffer) {
    if (buffer.length < 12) {
      return null;
    }
    const version = (buffer[0] >> 6) & 0x03;
    const padding = (buffer[0] >> 5) & 0x01;
    const extension = (buffer[0] >> 4) & 0x01;
    const csrcCount = buffer[0] & 0x0f;
    const payloadType = buffer[1] & 0x7f;
    const sequenceNumber = buffer.readUInt16BE(2);
    const timestamp = buffer.readUInt32BE(4);
    const ssrc = buffer.readUInt32BE(8);

    let offset = 12 + csrcCount * 4;
    if (extension) {
      // Bound the extension header read so a malformed/truncated packet returns
      // null instead of throwing a RangeError (audit RTP-L7).
      if (offset + 4 > buffer.length) return null;
      const extLength = buffer.readUInt16BE(offset + 2) * 4;
      offset += 4 + extLength;
    }
    if (padding) {
      const paddingLength = buffer[buffer.length - 1];
      buffer = buffer.slice(0, buffer.length - paddingLength);
    }

    const payload = buffer.slice(offset);
    const midiCommands = this.parseMidiPayload(payload);
    return { version, payloadType, sequenceNumber, timestamp, ssrc, midiCommands };
  }

  /**
   * Parse the RFC-6295 MIDI command section.
   * @param {Buffer} payload
   * @returns {Array<Array<number>>}
   */
  parseMidiPayload(payload) {
    const commands = [];
    if (payload.length === 0) return commands;

    let midiOffset = 0;
    let midiLength = 0;
    const headerByte = payload[0];
    if (headerByte & 0x80) {
      if (payload.length < 2) return commands;
      midiLength = ((headerByte & 0x0f) << 8) | payload[1];
      midiOffset = 2;
    } else {
      midiLength = headerByte & 0x0f;
      midiOffset = 1;
    }

    if (midiLength === 0 || midiOffset >= payload.length) return commands;

    // Header Z bit (0x20): when set, a delta-time precedes the FIRST command;
    // when clear the first command has an implicit delta-time of 0. (GMBoop's
    // own encoder sends Z=0 with a single full-status command.)
    const hasFirstDelta = (headerByte & 0x20) !== 0;
    // Header P bit (0x10): the first command has no status byte and inherits the
    // running status from the PREVIOUS packet (RFC 6295). Without honouring it,
    // the first command of a P=1 packet was silently dropped (audit RTP-M4).
    const hasRunningStatusCarry = (headerByte & 0x10) !== 0;
    const midiEnd = Math.min(midiOffset + midiLength, payload.length);
    let i = midiOffset;
    let runningStatus = hasRunningStatusCarry ? this._rtpRunningStatus || 0 : 0;
    let firstCommand = true;

    while (i < midiEnd) {
      // Each command (except the first when Z=0) is preceded by a variable-
      // length delta-time: 1–4 octets, bit 7 = continuation. The previous code
      // skipped EVERY high-bit-clear byte as "delta-time", which also swallowed
      // the DATA bytes of a running-status command (which has no status byte),
      // silently dropping notes sent by peers that use running status. Parse
      // the delta-time as a proper VLQ instead.
      if (!firstCommand || hasFirstDelta) {
        let dtBytes = 0;
        while (i < midiEnd && dtBytes < 4) {
          const b = payload[i++];
          dtBytes++;
          if (!(b & 0x80)) break;
        }
      }
      firstCommand = false;
      if (i >= midiEnd) break;
      const status = payload[i];

      if (status === 0xf0) {
        const sysexStart = i;
        i++;
        while (i < midiEnd && payload[i] !== 0xf7) i++;
        if (i < midiEnd) i++;
        commands.push(Array.from(payload.slice(sysexStart, i)));
        runningStatus = 0;
        continue;
      }
      if (status >= 0xf8) {
        commands.push([status]);
        i++;
        continue;
      }
      if (status >= 0x80) {
        runningStatus = status;
        i++;
      }
      if (runningStatus === 0) {
        i++;
        continue;
      }
      const commandLength = this.getMidiCommandLength(runningStatus);
      const dataBytes = commandLength - 1;
      if (i + dataBytes <= midiEnd) {
        commands.push([runningStatus, ...Array.from(payload.slice(i, i + dataBytes))]);
        i += dataBytes;
        // System Common (0xF1-0xF7) is a one-shot status and CANCELS running
        // status — without this a following data byte was mis-parsed as another
        // System Common command (audit RTP-L1).
        if (runningStatus >= 0xf1 && runningStatus <= 0xf7) runningStatus = 0;
      } else {
        break;
      }
    }
    // Persist running status for a subsequent P=1 packet (RFC 6295) — see the
    // header parse above (audit RTP-M4).
    this._rtpRunningStatus = runningStatus;
    return commands;
  }

  /**
   * MIDI message length from its status byte.
   * @param {number} status
   * @returns {number}
   */
  getMidiCommandLength(status) {
    const command = status & 0xf0;
    switch (command) {
      case 0x80:
      case 0x90:
      case 0xa0:
      case 0xb0:
      case 0xe0:
        return 3;
      case 0xc0:
      case 0xd0:
        return 2;
      case 0xf0:
        if (status === 0xf1) return 2;
        if (status === 0xf2) return 3;
        if (status === 0xf3) return 2;
        if (status === 0xf6) return 1;
        if (status >= 0xf8) return 1;
        return 1;
      default:
        return 1;
    }
  }

  /**
   * Build an RTP-MIDI packet (RFC 6295: RTP header + MIDI command section).
   * @param {Array<number>} midiBytes
   * @returns {Buffer}
   */
  createRtpPacket(midiBytes) {
    this.timestamp = this._now10k() & 0xffffffff;

    const header = Buffer.alloc(12);
    header[0] = 0x80; // version 2
    header[1] = 97; // payload type 97 (RTP-MIDI)
    header.writeUInt16BE(this.sequenceNumber, 2);
    header.writeUInt32BE(this.timestamp >>> 0, 4);
    header.writeUInt32BE(this.ssrc >>> 0, 8);

    const midiLength = midiBytes.length;
    let midiHeader;
    if (midiLength <= 0x0f) {
      midiHeader = Buffer.from([midiLength & 0x0f]);
    } else {
      const highByte = 0x80 | ((midiLength >> 8) & 0x0f);
      const lowByte = midiLength & 0xff;
      midiHeader = Buffer.from([highByte, lowByte]);
    }

    const payload = Buffer.from(midiBytes);
    return Buffer.concat([header, midiHeader, payload]);
  }

  /**
   * End the session: send an AppleMIDI BY on the control port (best effort),
   * stop timers, and emit `disconnected`.
   */
  disconnect() {
    if (this.state !== 'closed' && this._sendControl && this.initiatorToken != null) {
      try {
        this._sendControl(encodeEnd({ initiatorToken: this.initiatorToken, ssrc: this.ssrc }));
      } catch {
        /* best effort */
      }
    }
    this.close();
    return Promise.resolve();
  }

  /** Tear down local state and timers. */
  close() {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.connected = false;
    if (this._handshakeTimer) {
      clearTimeout(this._handshakeTimer);
      this._handshakeTimer = null;
    }
    if (this._clockTimer) {
      clearInterval(this._clockTimer);
      this._clockTimer = null;
    }
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
    this.emit('disconnected');
  }

  /** @returns {boolean} */
  isConnected() {
    return this.connected;
  }
}

export default RtpMidiSession;
