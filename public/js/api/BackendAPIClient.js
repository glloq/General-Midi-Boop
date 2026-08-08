/**
 * BackendAPIClient - Complete WebSocket client for GeneralMidiBoop backend
 * Handles connection, reconnection, and all API commands.
 *
 * Binary wire format support: high-frequency events (playback_position,
 * tuner:pitch, calibration:audio_level, system_lag) arrive as
 * ArrayBuffer frames produced by `shared/BinaryFrameCodec.js`. The
 * decoder below mirrors that wire format. Any non-binary frame falls
 * through to the JSON path so legacy events keep working without UI
 * changes.
 */

/**
 * After this many consecutive failed reconnect attempts, emit a one-shot
 * `reconnect_exhausted` event so the UI can surface a clear "connection
 * lost" state and stop spinners. Reconnection itself continues forever
 * (24/7 deployments must recover from arbitrarily long outages).
 */
const RECONNECT_UI_GIVEUP_ATTEMPTS = 12;

/**
 * Abort a connection attempt whose WebSocket handshake stalls (TCP up, upgrade
 * never completes). Without this the `connect()` promise never settles and the
 * reconnect chain — which relies on onclose / connect().catch — dies silently,
 * requiring a manual reload to recover.
 */
const CONNECT_TIMEOUT_MS = 15000;

/** Binary frame magic byte (matches `shared/BinaryFrameCodec.js`). */
const _BIN_FRAME_MAGIC = 0xb0;

/** Decode a binary frame from the wire into `{ type, payload }`. */
function _decodeBinaryFrame(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 4) throw new Error('binary frame too short');
  if (view.getUint8(0) !== _BIN_FRAME_MAGIC) {
    throw new Error('binary frame: bad magic');
  }
  const code = view.getUint8(1);
  const payloadLen = view.getUint16(2, true);
  if (view.byteLength < 4 + payloadLen) {
    throw new Error('binary frame: truncated');
  }
  switch (code) {
    case 0x01: // playback_position
      return {
        type: 'playback_position',
        payload: {
          position: view.getFloat64(4, true),
          percentage: view.getFloat32(12, true)
        }
      };
    case 0x03: // tuner:pitch
      return {
        type: 'tuner:pitch',
        payload: {
          freqHz: view.getFloat32(4, true),
          cents: view.getFloat32(8, true),
          noteMidi: view.getInt8(12)
        }
      };
    case 0x04: // calibration:audio_level
      return {
        type: 'calibration:audio_level',
        payload: {
          levelDb: view.getFloat32(4, true),
          peakDb: view.getFloat32(8, true)
        }
      };
    case 0x05: // system_lag
      return {
        type: 'system_lag',
        payload: {
          lagMs: view.getUint16(4, true),
          thresholdMs: view.getUint16(6, true)
        }
      };
    default:
      throw new Error(`binary frame: unknown event code 0x${code.toString(16)}`);
  }
}

class BackendAPIClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.eventHandlers = new Map();
    this.connected = false;
    this.reconnectAttempts = 0;
    this.reconnectBaseDelay = 1000;
    this.reconnectMaxDelay = 60000;
    this._reconnecting = false;
    this._reconnectTimer = null;
    this._reconnectExhaustedEmitted = false;
    this._closed = false;
    this._connectionPromise = null;
    this._connectTimer = null;
  }

  /**
   * Connect to WebSocket server
   */
  async connect() {
    // Eviter les connexions paralleles
    if (this._connectionPromise) {
      return this._connectionPromise;
    }

    this._connectionPromise = new Promise((resolve, reject) => {
      try {
        // Cancel a stale connect-timeout from a previous attempt whose socket
        // we are about to replace (its onclose was nulled below, so it will not
        // clear the timer itself).
        if (this._connectTimer) {
          clearTimeout(this._connectTimer);
          this._connectTimer = null;
        }

        // Fermer l'ancienne connexion proprement
        if (this.ws) {
          try {
            this.ws.onclose = null;
            this.ws.close();
          } catch (e) {
            /* ignore */
          }
        }

        this.ws = new WebSocket(this.wsUrl);
        // Receive high-frequency events as ArrayBuffer so the
        // binary decoder runs without an extra Blob → ArrayBuffer
        // promise round-trip.
        this.ws.binaryType = 'arraybuffer';

        // Fail a stalled handshake so the reconnect chain keeps moving. Force-
        // closing a still-CONNECTING socket fires onerror→onclose, which reject
        // the initial connect() and reschedule a reconnect respectively.
        this._connectTimer = setTimeout(() => {
          this._connectTimer = null;
          if (this.connected) return;
          console.warn('WebSocket connection attempt timed out; forcing close to retry');
          try {
            this.ws.close();
          } catch (e) {
            /* ignore */
          }
        }, CONNECT_TIMEOUT_MS);

        this.ws.onopen = () => {
          if (this._connectTimer) {
            clearTimeout(this._connectTimer);
            this._connectTimer = null;
          }
          this.connected = true;
          this.reconnectAttempts = 0;
          this._reconnecting = false;
          this._reconnectExhaustedEmitted = false;
          this._connectionPromise = null;
          // Do NOT emit 'connected' here. The server sends a welcome frame
          // ({type:'event', event:'connected', data:{version}}) immediately on
          // open, and handleMessage() re-emits that as 'connected'. Emitting
          // here too fired the event TWICE per connection, so every consumer
          // ran its handler twice — doubling data loads and, for non-idempotent
          // init, accumulating listeners (audit C M1). The welcome frame is now
          // the single 'connected' source; the connect() promise still resolves
          // here so `await connect()` is unaffected, and every consumer registers
          // before connect() runs, so none can miss the frame.
          resolve();
        };

        this.ws.onclose = (_event) => {
          if (this._connectTimer) {
            clearTimeout(this._connectTimer);
            this._connectTimer = null;
          }
          const wasConnected = this.connected;
          this.connected = false;
          this._connectionPromise = null;

          // Rejeter toutes les requetes en attente immediatement
          this._rejectPendingRequests('WebSocket connection closed');

          if (wasConnected) {
            this.emit('disconnected');
          }
          // Clear the in-flight reconnect guard before rescheduling. When a
          // reconnect attempt's socket fails asynchronously, `onerror` does not
          // reject (it is suppressed while `_reconnecting` is true) and this
          // `connect()` promise never settles, so the timer's `.catch` that
          // would reset `_reconnecting` never runs. Without resetting it here,
          // `attemptReconnect()` early-returns and the retry loop dies after a
          // single attempt — contradicting the "retries indefinitely" contract
          // and requiring a manual page reload to recover.
          this._reconnecting = false;
          this.attemptReconnect();
        };

        this.ws.onerror = (error) => {
          // Log/propagate only a sanitized string, never the raw event: its
          // `.target` is the WebSocket whose `.url` carries the auth-token query
          // param, so logging the event object (or forwarding it to 'error'
          // consumers) leaks the token into console output (audit C N1).
          const errorMessage = error?.message || error?.type || 'WebSocket connection failed';
          console.error('WebSocket error:', errorMessage);
          this.emit('error', { message: errorMessage });
          // Ne pas reject ici - onclose sera appele ensuite
          // Seulement reject si c'est la connexion initiale (pas un reconnect)
          if (!this._reconnecting) {
            this._connectionPromise = null;
            reject(new Error(errorMessage));
          }
        };

        this.ws.onmessage = (event) => {
          try {
            // Binary frame: dispatched directly to event
            // subscribers (skips the JSON envelope wrapping
            // because there is no command-response routing for
            // the high-frequency events).
            if (event.data instanceof ArrayBuffer) {
              const decoded = _decodeBinaryFrame(event.data);
              this.emit(decoded.type, decoded.payload);
              return;
            }
            const message = JSON.parse(event.data);
            this.handleMessage(message);
          } catch (error) {
            console.error('Failed to parse message:', error);
          }
        };
      } catch (error) {
        this._connectionPromise = null;
        reject(error);
      }
    });

    return this._connectionPromise;
  }

  /**
   * Rejete toutes les requetes en attente (lors d'une deconnexion)
   */
  _rejectPendingRequests(reason) {
    if (this.pendingRequests.size > 0) {
      console.warn(`Rejecting ${this.pendingRequests.size} pending requests: ${reason}`);
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error(reason));
      }
      this.pendingRequests.clear();
    }
  }

  /**
   * Attempt to reconnect with capped exponential backoff.
   * Retries indefinitely (no attempt limit) so 24/7 deployments
   * recover automatically from arbitrarily long outages. The UI
   * receives `disconnected` then `reconnecting` events; after
   * RECONNECT_UI_GIVEUP_ATTEMPTS consecutive failures it also gets a
   * one-shot `reconnect_exhausted` event so it can show a hard
   * "connection lost" state and stop spinners — retrying continues.
   */
  attemptReconnect() {
    if (this._closed) return;
    if (this._reconnecting) return;

    this._reconnecting = true;
    this.reconnectAttempts++;

    // Backoff exponentiel : 1s, 2s, 4s, 8s, 16s, 32s puis plafond 60s
    const delay = Math.min(
      this.reconnectBaseDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.reconnectMaxDelay
    );

    this.emit('reconnecting', { attempt: this.reconnectAttempts, delayMs: delay });

    if (
      this.reconnectAttempts >= RECONNECT_UI_GIVEUP_ATTEMPTS &&
      !this._reconnectExhaustedEmitted
    ) {
      this._reconnectExhaustedEmitted = true;
      this.emit('reconnect_exhausted', { attempts: this.reconnectAttempts });
    }

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
    }
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._closed) return;
      this.connect().catch((err) => {
        if (this._closed) return;
        console.warn(`Reconnect attempt ${this.reconnectAttempts} failed:`, err.message);
        this._reconnecting = false;
        this.attemptReconnect();
      });
    }, delay);
  }

  /**
   * Handle incoming message
   */
  handleMessage(message) {
    // Handle command response
    if (message.id && this.pendingRequests.has(message.id)) {
      const pending = this.pendingRequests.get(message.id);
      this.pendingRequests.delete(message.id);

      if (message.error) {
        // Propagate the structured error envelope (P1-3.4 audit recommendation):
        // expose `code` and `command` so callers can switch on the error category
        // (ERR_VALIDATION / ERR_NOT_FOUND / ERR_CONFIGURATION / ...).
        const err = new Error(message.error);
        if (message.code !== undefined) err.code = message.code;
        if (message.command !== undefined) err.command = message.command;
        pending.reject(err);
      } else {
        // Use presence, not truthiness: a handler that legitimately returns
        // falsy `data` (0, false, '', null) must not leak the raw protocol
        // envelope ({ id, data, timestamp, … }) to the caller.
        pending.resolve('data' in message ? message.data : message);
      }
      return;
    }

    // Handle event broadcasts
    if (message.event) {
      this.emit(message.event, message.data);
      return;
    }

    // Uncorrelated error frame (no id, no event) — e.g. the server's rate-limit
    // notice {type:'error', error:'…'}. Previously dropped silently, so the UI
    // had no signal that its commands were being throttled (audit C N2). Guard
    // on a missing id so a command response whose pending request already timed
    // out is not re-surfaced as a spurious global error.
    if (message.error && message.id == null) {
      this.emit('error', { message: message.error, code: message.code });
    }
  }

  /**
   * Register event handler
   */
  on(event, handler) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event).push(handler);
  }

  /**
   * Remove event handler
   */
  off(event, handler) {
    if (!this.eventHandlers.has(event)) return;

    const handlers = this.eventHandlers.get(event);
    const index = handlers.indexOf(handler);
    if (index > -1) {
      handlers.splice(index, 1);
    }
  }

  /**
   * Emit event
   */
  emit(event, data) {
    if (!this.eventHandlers.has(event)) return;

    const handlers = this.eventHandlers.get(event);
    handlers.forEach((handler) => {
      try {
        handler(data);
      } catch (error) {
        console.error(`Error in event handler for ${event}:`, error);
      }
    });
  }

  /**
   * Check if connected
   */
  isConnected() {
    return this.connected && this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Attend que la connexion soit etablie (utile pendant reconnexion)
   * @param {number} timeout - Timeout en ms (defaut 5000)
   * @returns {Promise<void>}
   */
  waitForConnection(timeout = 5000) {
    if (this.isConnected()) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('connected', onConnected);
        reject(new Error('WebSocket connection timeout'));
      }, timeout);

      const onConnected = () => {
        clearTimeout(timer);
        this.off('connected', onConnected);
        resolve();
      };

      this.on('connected', onConnected);
    });
  }

  /**
   * Send command to backend
   * Si deconnecte mais en cours de reconnexion, attend la reconnexion
   */
  async sendCommand(command, data = {}, timeout = 10000) {
    // Si pas connecte, attendre la reconnexion (max 5s)
    if (!this.isConnected()) {
      if (this._reconnecting || this._connectionPromise) {
        try {
          await this.waitForConnection(5000);
        } catch (e) {
          throw new Error('WebSocket not connected');
        }
      } else {
        throw new Error('WebSocket not connected');
      }
    }

    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Command timeout: ${command}`));
      }, timeout);

      this.pendingRequests.set(id, {
        resolve: (response) => {
          clearTimeout(timeoutId);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        }
      });

      // Verifier encore avant d'envoyer (la connexion a pu se fermer entre-temps)
      if (!this.isConnected()) {
        this.pendingRequests.delete(id);
        clearTimeout(timeoutId);
        reject(new Error('WebSocket disconnected before send'));
        return;
      }

      try {
        this.ws.send(
          JSON.stringify({
            id,
            command,
            data,
            timestamp: Date.now()
          })
        );
      } catch (sendError) {
        this.pendingRequests.delete(id);
        clearTimeout(timeoutId);
        reject(new Error(`WebSocket send failed: ${sendError.message}`));
      }
    });
  }

  /**
   * Close connection permanently. Stops any pending reconnect and
   * prevents future ones until a new client is constructed.
   */
  close() {
    this._closed = true;
    this._reconnecting = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._connectTimer) {
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
    }
    this._rejectPendingRequests('Connection closed');
    this.eventHandlers.clear();
    if (this.ws) {
      this.ws.onclose = null; // Eviter le cycle reconnexion
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  // ========================================================================
  // FILE MANAGEMENT
  // ========================================================================

  /**
   * POST a file's raw bytes to `url` (octet-stream, same-origin) and
   * return the parsed JSON body, throwing the server error on !ok.
   * Shared by uploadMidiFile / uploadSf2File.
   * @private
   */
  async _uploadBinary(url, file) {
    const buffer = await file.arrayBuffer();
    const resp = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buffer
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(body && body.error ? body.error : `Upload failed (HTTP ${resp.status})`);
    }
    return body;
  }

  /**
   * Upload a MIDI file to the backend over HTTP.
   *
   * Uploads no longer go through the WebSocket as base64; the backend
   * exposes `POST /api/files` (raw binary body, ?filename + ?folder query
   * params). Same-origin browser requests are accepted without a token —
   * see HttpServer auth middleware.
   *
   * @param {File|Blob} file - File from an `<input type="file">`.
   * @param {string} [folder='/'] - Target folder in the library.
   * @returns {Promise<Object>} The full response body from the server,
   *   shaped like FileManager.handleUpload's return value (fileId,
   *   contentHash, status, channels, etc.).
   */
  async uploadMidiFile(file, folder = '/') {
    const url = `/api/files?filename=${encodeURIComponent(file.name)}&folder=${encodeURIComponent(folder)}`;
    return this._uploadBinary(url, file);
  }

  /**
   * Upload a custom SoundFont (.sf2) over HTTP. Reuses the existing
   * `POST /api/sf2` endpoint (raw binary body, ?filename query param;
   * RIFF/sfbk + size/quota validated server-side).
   *
   * @param {File|Blob} file - File from an `<input type="file">`.
   * @returns {Promise<Object>} Response body, e.g.
   *   `{ sf2Id, label, size, status }` ('created' | 'duplicate').
   */
  async uploadSf2File(file) {
    const url = `/api/sf2?filename=${encodeURIComponent(file.name)}`;
    return this._uploadBinary(url, file);
  }

  /**
   * List MIDI files
   */
  async listMidiFiles(folder = '/') {
    const result = await this.sendCommand('file_list', { folder });
    return result.files || result || [];
  }

  /**
   * Delete MIDI file
   */
  async deleteMidiFile(fileId) {
    return this.sendCommand('file_delete', { fileId });
  }

  /**
   * Read MIDI file content
   * @param {string} fileId - File ID or filename
   * @returns {Promise<Object>} MIDI file data
   */
  async readMidiFile(fileId) {
    return this.sendCommand('file_read', { fileId });
  }

  /**
   * Write/Save MIDI file content
   * @param {string} fileId - File ID or filename
   * @param {Object} midiData - MIDI data to write
   * @returns {Promise<Object>} Response
   */
  async writeMidiFile(fileId, midiData) {
    return this.sendCommand('file_write', {
      fileId,
      midiData
    });
  }

  // ========================================================================
  // DEVICES
  // ========================================================================

  /**
   * List all MIDI devices
   */
  async listDevices() {
    const result = await this.sendCommand('device_list');
    return result.devices || result || [];
  }

  /**
   * Refresh device list
   */
  async refreshDevices() {
    return this.sendCommand('device_refresh');
  }

  // ========================================================================
  // MIDI MESSAGES
  // ========================================================================

  /**
   * Send MIDI Note On message
   * @param {string} deviceId - Target device ID
   * @param {number} note - MIDI note number (0-127)
   * @param {number} velocity - Note velocity (1-127)
   * @param {number} channel - MIDI channel (0-15, maps to 1-16)
   */
  async sendNoteOn(deviceId, note, velocity, channel = 0) {
    // Utiliser la commande backend 'midi_send_note'
    return this.sendCommand('midi_send_note', {
      deviceId: deviceId,
      channel: channel,
      note: note,
      velocity: velocity
    });
  }

  /**
   * Send MIDI Note Off message
   * @param {string} deviceId - Target device ID
   * @param {number} note - MIDI note number (0-127)
   * @param {number} channel - MIDI channel (0-15, maps to 1-16)
   */
  async sendNoteOff(deviceId, note, channel = 0) {
    // Note OFF = Note ON avec velocity 0
    return this.sendCommand('midi_send_note', {
      deviceId: deviceId,
      channel: channel,
      note: note,
      velocity: 0
    });
  }

  // ========================================================================
  // PLAYBACK
  // ========================================================================

  /**
   * Start playback
   */
  async startPlayback(fileId, options = {}) {
    return this.sendCommand('playback_start', {
      fileId,
      loop: options.loop || false,
      tempo: options.tempo || 120,
      transpose: options.transpose || 0
    });
  }

  /**
   * Stop playback
   */
  async stopPlayback() {
    return this.sendCommand('playback_stop');
  }

  /**
   * Pause playback
   */
  async pausePlayback() {
    return this.sendCommand('playback_pause');
  }

  /**
   * Resume playback
   */
  async resumePlayback() {
    return this.sendCommand('playback_resume');
  }

  /**
   * Seek playback to an absolute position.
   * @param {number} position - Position in seconds (>= 0).
   */
  async seekPlayback(position) {
    return this.sendCommand('playback_seek', { position });
  }

  /**
   * Change playback tempo. Applies a rate multiplier (clamped 0.25x-4x
   * server-side) and forwards the new tempo to the MIDI clock.
   * @param {number} bpm - Target tempo in BPM.
   */
  async setPlaybackTempo(bpm) {
    return this.sendCommand('playback_set_tempo', { bpm });
  }

  /**
   * Set master volume by broadcasting CC#7 on every connected output.
   * @param {number} volume - MIDI value 0..127 (clamped server-side).
   */
  async setPlaybackVolume(volume) {
    return this.sendCommand('playback_set_volume', { volume });
  }

  /**
   * Globally transpose playback.
   * @param {number} semitones - Integer semitones (-48..48 server-side).
   */
  async setPlaybackTranspose(semitones) {
    return this.sendCommand('playback_transpose', { semitones });
  }

  // ========================================================================
  // UTILITIES
  // ========================================================================
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BackendAPIClient;
}
if (typeof window !== 'undefined') {
  window.BackendAPIClient = BackendAPIClient;
}
