/**
 * BackendAPIClient - Complete WebSocket client for MidiMind backend
 * Handles connection, reconnection, and all API commands
 */

class BackendAPIClient {
    constructor(wsUrl) {
        this.wsUrl = wsUrl;
        this.ws = null;
        this.requestId = 0;
        this.pendingRequests = new Map();
        this.eventHandlers = new Map();
        this.connected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectBaseDelay = 1000;
        this._reconnecting = false;
        this._connectionPromise = null;
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
                // Fermer l'ancienne connexion proprement
                if (this.ws) {
                    try { this.ws.onclose = null; this.ws.close(); } catch (e) { /* ignore */ }
                }

                this.ws = new WebSocket(this.wsUrl);

                this.ws.onopen = () => {
                    this.connected = true;
                    this.reconnectAttempts = 0;
                    this._reconnecting = false;
                    this._connectionPromise = null;
                    this.emit('connected');
                    resolve();
                };

                this.ws.onclose = (event) => {
                    const wasConnected = this.connected;
                    this.connected = false;
                    this._connectionPromise = null;

                    // Rejeter toutes les requetes en attente immediatement
                    this._rejectPendingRequests('WebSocket connection closed');

                    if (wasConnected) {
                        this.emit('disconnected');
                    }
                    this.attemptReconnect();
                };

                this.ws.onerror = (error) => {
                    console.error('WebSocket error:', error);
                    const errorMessage = error.message || error.type || 'WebSocket connection failed';
                    this.emit('error', { message: errorMessage, error: error });
                    // Ne pas reject ici - onclose sera appele ensuite
                    // Seulement reject si c'est la connexion initiale (pas un reconnect)
                    if (!this._reconnecting) {
                        this._connectionPromise = null;
                        reject(new Error(errorMessage));
                    }
                };

                this.ws.onmessage = (event) => {
                    try {
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
            for (const [id, pending] of this.pendingRequests) {
                pending.reject(new Error(reason));
            }
            this.pendingRequests.clear();
        }
    }

    /**
     * Attempt to reconnect with exponential backoff
     */
    attemptReconnect() {
        if (this._reconnecting) return;
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this._reconnecting = false;
            console.error(`Max reconnection attempts (${this.maxReconnectAttempts}) reached. Call connect() manually to retry.`);
            this.emit('reconnect_failed');
            return;
        }

        this._reconnecting = true;
        this.reconnectAttempts++;

        // Backoff exponentiel : 1s, 2s, 4s, 8s... plafonne a 30s
        const delay = Math.min(
            this.reconnectBaseDelay * Math.pow(2, this.reconnectAttempts - 1),
            30000
        );

        console.log(`Reconnecting in ${delay}ms... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        setTimeout(() => {
            this.connect().catch(err => {
                console.error('Reconnect failed:', err.message);
                this._reconnecting = false;
                // Retenter apres echec
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
                pending.reject(new Error(message.error));
            } else {
                pending.resolve(message.data || message);
            }
            return;
        }

        // Handle event broadcasts
        if (message.event) {
            this.emit(message.event, message.data);
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
        handlers.forEach(handler => {
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
                this.ws.send(JSON.stringify({
                    id,
                    command,
                    data,
                    timestamp: Date.now()
                }));
            } catch (sendError) {
                this.pendingRequests.delete(id);
                clearTimeout(timeoutId);
                reject(new Error(`WebSocket send failed: ${sendError.message}`));
            }
        });
    }

    /**
     * Close connection
     */
    close() {
        this._reconnecting = false;
        this.reconnectAttempts = this.maxReconnectAttempts; // Empecher la reconnexion
        this._rejectPendingRequests('Connection closed');
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
     * Upload MIDI file to backend
     */
    async uploadMidiFile(file, folder = '/') {
        const arrayBuffer = await file.arrayBuffer();
        const base64 = this.arrayBufferToBase64(arrayBuffer);

        return this.sendCommand('file_upload', {
            filename: file.name,
            data: base64,
            folder: folder
        });
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

    // ========================================================================
    // UTILITIES
    // ========================================================================

    /**
     * Convert ArrayBuffer to Base64
     */
    arrayBufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    /**
     * Convert Base64 to ArrayBuffer
     */
    base64ToArrayBuffer(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
    module.exports = BackendAPIClient;
}
if (typeof window !== 'undefined') {
    window.BackendAPIClient = BackendAPIClient;
}
