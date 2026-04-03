// ============================================================================
// src/managers/SerialMidiManager.js
// ============================================================================
// Description:
//   Gère les ports série MIDI via GPIO UART sur Raspberry Pi
//   - Scan des ports série disponibles (/dev/ttyAMA*, /dev/serial*)
//   - Ouverture/fermeture des ports à 31250 baud (MIDI standard)
//   - Parseur MIDI complet avec Running Status et SysEx
//   - Hot-plug monitoring
//   - Support multi-UART (Pi 4: jusqu'à 6 UARTs via device tree overlays)
// ============================================================================

import EventEmitter from 'events';
import fs from 'fs';
import path from 'path';
import MidiUtils from '../utils/MidiUtils.js';

// MIDI Serial constants
const MIDI_BAUD_RATE = 31250;
const HOT_PLUG_CHECK_INTERVAL_MS = 3000;
const MAX_SYSEX_BUFFER_SIZE = 65536; // 64KB max SysEx message
const PORT_OPEN_TIMEOUT_MS = 10000;  // 10 seconds max to open a port

// MIDI message lengths by status byte high nibble
const MIDI_MESSAGE_LENGTHS = {
  0x80: 3, // Note Off
  0x90: 3, // Note On
  0xA0: 3, // Poly Aftertouch
  0xB0: 3, // Control Change
  0xC0: 2, // Program Change
  0xD0: 2, // Channel Aftertouch
  0xE0: 3  // Pitch Bend
};

// System message lengths
const SYSTEM_MESSAGE_LENGTHS = {
  0xF1: 2, // MTC Quarter Frame
  0xF2: 3, // Song Position Pointer
  0xF3: 2, // Song Select
  0xF6: 1, // Tune Request
  0xF8: 1, // Timing Clock
  0xFA: 1, // Start
  0xFB: 1, // Continue
  0xFC: 1, // Stop
  0xFE: 1, // Active Sensing
  0xFF: 1  // System Reset
};

// Status byte to easymidi type mapping
const STATUS_TO_TYPE = {
  0x80: 'noteoff',
  0x90: 'noteon',
  0xA0: 'poly aftertouch',
  0xB0: 'cc',
  0xC0: 'program',
  0xD0: 'channel aftertouch',
  0xE0: 'pitchbend'
};

class SerialMidiManager extends EventEmitter {
  constructor(app) {
    super();
    this.app = app;
    this.enabled = false;
    this.scanning = false;
    this.SerialPort = null; // Loaded dynamically
    this.openPorts = new Map(); // path -> { port, name, direction, parserState }
    this.configuredPorts = []; // From config.json
    this.hotPlugInterval = null;
    this.knownPorts = new Set();

    // Load config
    const serialConfig = this.app.config.serial || {};
    this.enabled = serialConfig.enabled || false;
    this.configuredPorts = serialConfig.ports || [];

    this._initPromise = this._initialize();
  }

  async _initialize() {
    if (!this.enabled) {
      this.app.logger.info('SerialMidiManager: disabled in config');
      return;
    }

    try {
      // Dynamic import of serialport (may not be installed)
      const serialportModule = await import('serialport');
      this.SerialPort = serialportModule.SerialPort;
      this.app.logger.info('SerialMidiManager: serialport library loaded');

      // Open configured ports
      await this._openConfiguredPorts();

      // Start hot-plug monitoring
      this.startHotPlugMonitoring();

      this.app.logger.info(`SerialMidiManager initialized (${this.openPorts.size} port(s) open)`);
    } catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND') {
        this.app.logger.warn('SerialMidiManager: serialport package not installed. Run: npm install serialport');
      } else {
        this.app.logger.error(`SerialMidiManager init error: ${error.message}`);
      }
      this.enabled = false;
    }
  }

  async _openConfiguredPorts() {
    for (const portConfig of this.configuredPorts) {
      if (!portConfig.enabled) continue;
      try {
        await this.openPort(portConfig.path, portConfig.name, portConfig.direction || 'both');
      } catch (error) {
        this.app.logger.warn(`Failed to open configured port ${portConfig.path}: ${error.message}`);
      }
    }
  }

  // ==================== PORT SCANNING ====================

  /**
   * Scan for available serial ports
   * @returns {Array} List of available serial ports
   */
  async scanPorts() {
    // Wait for initialization to complete before scanning
    if (this._initPromise) await this._initPromise;

    if (!this.SerialPort) {
      throw new Error('serialport library not available');
    }

    this.scanning = true;
    const availablePorts = [];

    try {
      // Method 1: Use serialport.list() for comprehensive detection
      const systemPorts = await this.SerialPort.list();

      for (const port of systemPorts) {
        // Filter to UART/serial ports likely to be GPIO MIDI
        if (this._isSerialMidiCandidate(port.path)) {
          availablePorts.push({
            path: port.path,
            manufacturer: port.manufacturer || 'Unknown',
            vendorId: port.vendorId || null,
            productId: port.productId || null,
            serialNumber: port.serialNumber || null,
            isOpen: this.openPorts.has(port.path),
            name: this._getPortFriendlyName(port.path)
          });
        }
      }

      // Method 2: Also scan /dev/ttyAMA* directly (may not appear in serialport.list)
      const ttyAMAPorts = this._scanDevFiles();
      for (const devPath of ttyAMAPorts) {
        if (!availablePorts.find(p => p.path === devPath)) {
          availablePorts.push({
            path: devPath,
            manufacturer: 'Raspberry Pi UART',
            vendorId: null,
            productId: null,
            serialNumber: null,
            isOpen: this.openPorts.has(devPath),
            name: this._getPortFriendlyName(devPath)
          });
        }
      }

      this.app.logger.info(`Serial scan: ${availablePorts.length} port(s) found`);
    } catch (error) {
      this.app.logger.error(`Serial scan error: ${error.message}`);
    } finally {
      this.scanning = false;
    }

    return availablePorts;
  }

  /**
   * Scan /dev for UART/serial files
   */
  _scanDevFiles() {
    const candidates = [];
    const patterns = [
      /^ttyAMA\d+$/,    // Pi hardware UARTs
      /^serial\d+$/,     // Pi serial aliases
      /^ttyS\d+$/,       // Standard serial ports
      /^ttyUSB\d+$/      // USB-to-serial adapters
    ];

    try {
      const devFiles = fs.readdirSync('/dev');
      for (const file of devFiles) {
        if (patterns.some(p => p.test(file))) {
          candidates.push(`/dev/${file}`);
        }
      }
    } catch (error) {
      this.app.logger.debug(`Cannot scan /dev: ${error.message}`);
    }

    return candidates;
  }

  /**
   * Check if a serial port path is a MIDI candidate
   */
  _isSerialMidiCandidate(portPath) {
    const baseName = path.basename(portPath);
    return /^ttyAMA\d+$/.test(baseName) ||
           /^serial\d+$/.test(baseName) ||
           /^ttyS\d+$/.test(baseName) ||
           /^ttyUSB\d+$/.test(baseName);
  }

  /**
   * Get a friendly name for a serial port
   */
  _getPortFriendlyName(portPath) {
    const baseName = path.basename(portPath);
    const uartMap = {
      'ttyAMA0': 'UART0 (GPIO14/15)',
      'ttyAMA1': 'UART2 (GPIO0/1)',
      'ttyAMA2': 'UART3 (GPIO4/5)',
      'ttyAMA3': 'UART4 (GPIO8/9)',
      'ttyAMA4': 'UART5 (GPIO12/13)',
      'serial0': 'Primary Serial',
      'serial1': 'Secondary Serial'
    };
    return uartMap[baseName] || `Serial (${baseName})`;
  }

  // ==================== PORT MANAGEMENT ====================

  /**
   * Open a serial port for MIDI communication
   * @param {string} portPath - Path to serial device (e.g., /dev/ttyAMA0)
   * @param {string} name - Friendly name for the port
   * @param {string} direction - 'in', 'out', or 'both'
   */
  async openPort(portPath, name = null, direction = 'both') {
    if (!this.SerialPort) {
      throw new Error('serialport library not available');
    }

    if (this.openPorts.has(portPath)) {
      throw new Error(`Port already open: ${portPath}`);
    }

    // Check if device exists
    if (!fs.existsSync(portPath)) {
      throw new Error(`Serial device not found: ${portPath}. Check that UART is enabled in /boot/config.txt`);
    }

    const openPromise = new Promise((resolve, reject) => {
      const port = new this.SerialPort({
        path: portPath,
        baudRate: MIDI_BAUD_RATE,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
        autoOpen: false
      });

      port.open((err) => {
        if (err) {
          if (err.message.includes('Permission denied') || err.message.includes('EACCES')) {
            reject(new Error(`Permission denied for ${portPath}. Run: sudo usermod -aG dialout $USER && reboot`));
          } else if (err.message.includes('EBUSY')) {
            reject(new Error(`Port ${portPath} is busy. Another process may be using it.`));
          } else {
            reject(new Error(`Failed to open ${portPath}: ${err.message}`));
          }
          return;
        }

        const portInfo = {
          port,
          path: portPath,
          name: name || this._getPortFriendlyName(portPath),
          direction,
          connected: true,
          openedAt: Date.now(),
          parserState: this._createParserState()
        };

        // Setup data handler for MIDI input
        if (direction === 'in' || direction === 'both') {
          port.on('data', (buffer) => {
            this._handleData(portPath, buffer);
          });
        }

        // Handle port errors
        port.on('error', (error) => {
          this.app.logger.error(`Serial port error ${portPath}: ${error.message}`);
          this.emit('serial:error', { path: portPath, error: error.message });
        });

        // Handle port close
        port.on('close', () => {
          this.app.logger.info(`Serial port closed: ${portPath}`);
          this.openPorts.delete(portPath);
          this.emit('serial:disconnected', { path: portPath, name: portInfo.name });
          this._broadcastDeviceList();
        });

        this.openPorts.set(portPath, portInfo);
        this.knownPorts.add(portPath);

        this.app.logger.info(`Serial MIDI port opened: ${portPath} (${portInfo.name}, ${direction}, ${MIDI_BAUD_RATE} baud)`);
        this.emit('serial:connected', { path: portPath, name: portInfo.name });
        this._broadcastDeviceList();

        resolve(portInfo);
      });
    });

    // Wrap with timeout to prevent indefinite hang on hardware issues
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Port ${portPath} open timeout after ${PORT_OPEN_TIMEOUT_MS}ms`)), PORT_OPEN_TIMEOUT_MS)
    );

    return Promise.race([openPromise, timeoutPromise]);
  }

  /**
   * Close a serial port
   * @param {string} portPath
   */
  async closePort(portPath) {
    const portInfo = this.openPorts.get(portPath);
    if (!portInfo) {
      throw new Error(`Port not open: ${portPath}`);
    }

    // Remove from map BEFORE closing to prevent the 'close' event handler
    // from emitting a spurious 'serial:disconnected' event
    this.openPorts.delete(portPath);

    return new Promise((resolve) => {
      portInfo.port.close((err) => {
        if (err) {
          this.app.logger.warn(`Error closing ${portPath}: ${err.message}`);
        }
        this._broadcastDeviceList();
        resolve();
      });
    });
  }

  // ==================== MIDI PARSER ====================

  /**
   * Create initial parser state for a port
   */
  _createParserState() {
    return {
      runningStatus: 0,
      buffer: [],
      expectedLength: 0,
      inSysEx: false,
      sysExBuffer: []
    };
  }

  /**
   * Handle incoming serial data
   */
  _handleData(portPath, buffer) {
    for (let i = 0; i < buffer.length; i++) {
      this._parseByte(portPath, buffer[i]);
    }
  }

  /**
   * Parse a single MIDI byte with running status support
   */
  _parseByte(portPath, byte) {
    const state = this.openPorts.get(portPath)?.parserState;
    if (!state) return;

    // Real-time messages (0xF8-0xFF) can appear anywhere, even inside SysEx
    if (byte >= 0xF8) {
      this._emitSystemRealtime(portPath, byte);
      return;
    }

    // SysEx handling
    if (state.inSysEx) {
      if (byte === 0xF7) {
        // SysEx end
        state.sysExBuffer.push(byte);
        this._emitSysEx(portPath, state.sysExBuffer);
        state.sysExBuffer = [];
        state.inSysEx = false;
      } else if (byte >= 0x80) {
        // Status byte inside SysEx = SysEx terminated (without F7), new message starts
        state.inSysEx = false;
        state.sysExBuffer = [];
        // Process this byte as new message start
        this._parseByte(portPath, byte);
      } else {
        // SysEx data byte - enforce size limit to prevent unbounded growth
        if (state.sysExBuffer.length >= MAX_SYSEX_BUFFER_SIZE) {
          this.app.logger.warn(`SysEx buffer overflow on ${portPath} (>${MAX_SYSEX_BUFFER_SIZE} bytes), discarding`);
          state.inSysEx = false;
          state.sysExBuffer = [];
          return;
        }
        state.sysExBuffer.push(byte);
      }
      return;
    }

    // SysEx start
    if (byte === 0xF0) {
      state.inSysEx = true;
      state.sysExBuffer = [byte];
      state.runningStatus = 0; // SysEx cancels running status
      return;
    }

    // System Common messages (F1-F6) cancel running status
    if (byte >= 0xF1 && byte <= 0xF6) {
      state.runningStatus = 0;
      const length = SYSTEM_MESSAGE_LENGTHS[byte] || 1;
      if (length === 1) {
        this._emitSystemCommon(portPath, byte, []);
      } else {
        state.buffer = [byte];
        state.expectedLength = length;
      }
      return;
    }

    // Status byte (channel message)
    if (byte >= 0x80 && byte <= 0xEF) {
      state.runningStatus = byte;
      const highNibble = byte & 0xF0;
      state.expectedLength = MIDI_MESSAGE_LENGTHS[highNibble] || 3;
      state.buffer = [byte];
      return;
    }

    // Data byte (0x00-0x7F)
    if (byte < 0x80) {
      if (state.buffer.length === 0 && state.runningStatus) {
        // Running status: use last status byte
        const highNibble = state.runningStatus & 0xF0;
        state.expectedLength = MIDI_MESSAGE_LENGTHS[highNibble] || 3;
        state.buffer = [state.runningStatus];
      }

      if (state.buffer.length > 0) {
        state.buffer.push(byte);

        if (state.buffer.length >= state.expectedLength) {
          const statusByte = state.buffer[0];
          if (statusByte >= 0xF1 && statusByte <= 0xF6) {
            // System Common message (F1 MTC, F2 Song Position, F3 Song Select)
            this._emitSystemCommon(portPath, statusByte, state.buffer.slice(1));
          } else {
            // Channel message
            this._emitChannelMessage(portPath, state.buffer);
          }
          state.buffer = [];
        }
      }
    }
  }

  /**
   * Emit a parsed channel message
   */
  _emitChannelMessage(portPath, bytes) {
    const statusByte = bytes[0];
    const highNibble = statusByte & 0xF0;
    const channel = statusByte & 0x0F;
    const type = STATUS_TO_TYPE[highNibble];

    if (!type) return;

    let data;
    switch (highNibble) {
      case 0x80: // Note Off
        data = { channel, note: bytes[1], velocity: bytes[2] };
        break;
      case 0x90: // Note On
        data = { channel, note: bytes[1], velocity: bytes[2] };
        break;
      case 0xA0: // Poly Aftertouch
        data = { channel, note: bytes[1], pressure: bytes[2] };
        break;
      case 0xB0: // CC
        data = { channel, controller: bytes[1], value: bytes[2] };
        break;
      case 0xC0: // Program Change
        data = { channel, number: bytes[1] };
        break;
      case 0xD0: // Channel Aftertouch
        data = { channel, pressure: bytes[1] };
        break;
      case 0xE0: // Pitch Bend
        data = { channel, value: (bytes[2] << 7) | bytes[1] };
        break;
    }

    if (data) {
      const portInfo = this.openPorts.get(portPath);
      const deviceName = portInfo?.name || portPath;

      // Forward to DeviceManager's message handler
      if (this.app.deviceManager) {
        this.app.deviceManager.handleMidiMessage(deviceName, type, data);
      }
    }
  }

  /**
   * Emit a SysEx message
   */
  _emitSysEx(portPath, bytes) {
    const portInfo = this.openPorts.get(portPath);
    const deviceName = portInfo?.name || portPath;

    if (this.app.deviceManager) {
      this.app.deviceManager.handleMidiMessage(deviceName, 'sysex', bytes);
    }
  }

  /**
   * Emit a system real-time message
   */
  _emitSystemRealtime(portPath, byte) {
    const typeMap = {
      0xF8: 'clock',
      0xFA: 'start',
      0xFB: 'continue',
      0xFC: 'stop',
      0xFE: 'sensing',
      0xFF: 'reset'
    };

    const type = typeMap[byte];
    if (type) {
      const portInfo = this.openPorts.get(portPath);
      const deviceName = portInfo?.name || portPath;

      if (this.app.deviceManager) {
        this.app.deviceManager.handleMidiMessage(deviceName, type, {});
      }
    }
  }

  /**
   * Emit a system common message
   */
  _emitSystemCommon(portPath, statusByte, dataBytes) {
    const typeMap = {
      0xF1: 'mtc',
      0xF2: 'position',
      0xF3: 'select',
      0xF6: 'tune'
    };

    const type = typeMap[statusByte];
    if (type) {
      const portInfo = this.openPorts.get(portPath);
      const deviceName = portInfo?.name || portPath;

      if (this.app.deviceManager) {
        this.app.deviceManager.handleMidiMessage(deviceName, type, { bytes: dataBytes });
      }
    }
  }

  // ==================== MIDI OUTPUT ====================

  /**
   * Send a MIDI message to a serial port
   * @param {string} portPath - Port path or device name
   * @param {string} type - Message type (noteon, noteoff, cc, etc.)
   * @param {Object} data - Message data
   */
  sendMidiMessage(portPath, type, data) {
    // Find port by path or name
    let portInfo = this.openPorts.get(portPath);
    if (!portInfo) {
      // Try to find by name
      for (const [, info] of this.openPorts) {
        if (info.name === portPath) {
          portInfo = info;
          break;
        }
      }
    }

    if (!portInfo) {
      throw new Error(`Serial port not found: ${portPath}`);
    }

    if (portInfo.direction === 'in') {
      throw new Error(`Port ${portPath} is input-only`);
    }

    const bytes = this._convertToMidiBytes(type, data);
    if (bytes && bytes.length > 0) {
      portInfo.port.write(Buffer.from(bytes));
    }
  }

  /**
   * Convert easymidi-format message to raw MIDI bytes
   */
  _convertToMidiBytes(type, data) {
    const bytes = MidiUtils.convertToMidiBytes(type, data);
    if (!bytes) {
      this.app.logger.warn(`Unknown MIDI type for serial: ${type}`);
    }
    return bytes;
  }

  // ==================== HOT-PLUG MONITORING ====================

  startHotPlugMonitoring() {
    if (this.hotPlugInterval) return;

    this.hotPlugInterval = setInterval(() => {
      this._checkPortChanges();
    }, HOT_PLUG_CHECK_INTERVAL_MS);

    this.app.logger.info(`Serial hot-plug monitoring started (${HOT_PLUG_CHECK_INTERVAL_MS}ms interval)`);
  }

  stopHotPlugMonitoring() {
    if (this.hotPlugInterval) {
      clearInterval(this.hotPlugInterval);
      this.hotPlugInterval = null;
    }
  }

  _checkPortChanges() {
    const currentPorts = new Set(this._scanDevFiles());

    // Check for removed ports - collect first to avoid modifying Set during iteration
    const removedPorts = [];
    for (const portPath of this.knownPorts) {
      if (!currentPorts.has(portPath) && this.openPorts.has(portPath)) {
        removedPorts.push(portPath);
      }
    }

    for (const portPath of removedPorts) {
      this.app.logger.info(`Serial port disconnected: ${portPath}`);
      const portInfo = this.openPorts.get(portPath);
      // Remove from maps first to prevent concurrent access
      this.openPorts.delete(portPath);
      this.knownPorts.delete(portPath);
      try {
        portInfo.port.close();
      } catch (e) {
        // Port may already be closed
      }
    }

    if (removedPorts.length > 0) {
      this._broadcastDeviceList();
    }
  }

  // ==================== STATUS & DEVICE LIST ====================

  /**
   * Get list of connected serial MIDI ports (for DeviceManager)
   */
  getConnectedPorts() {
    return Array.from(this.openPorts.values()).map(info => ({
      path: info.path,
      name: info.name,
      direction: info.direction,
      connected: info.connected,
      openedAt: info.openedAt
    }));
  }

  /**
   * Get status of the serial MIDI system
   */
  getStatus() {
    return {
      enabled: this.enabled,
      available: this.SerialPort !== null,
      scanning: this.scanning,
      openPorts: this.openPorts.size,
      ports: this.getConnectedPorts()
    };
  }

  /**
   * Enable or disable serial MIDI
   * @param {boolean} enabled
   */
  async setEnabled(enabled) {
    // Wait for any pending initialization
    if (this._initPromise) await this._initPromise;

    this.enabled = enabled;

    if (enabled && !this.SerialPort) {
      // Try to load serialport - update promise so scanPorts awaits correctly
      this._initPromise = this._initialize();
      await this._initPromise;
    } else if (!enabled) {
      // Close all ports
      await this.shutdown();
    }

    return { enabled: this.enabled, available: this.SerialPort !== null };
  }

  /**
   * Broadcast device list update
   */
  _broadcastDeviceList() {
    if (this.app.deviceManager) {
      this.app.deviceManager.broadcastDeviceList();
    }
  }

  // ==================== SHUTDOWN ====================

  async shutdown() {
    this.stopHotPlugMonitoring();

    // Close all ports
    const closePromises = [];
    for (const [portPath, portInfo] of this.openPorts) {
      closePromises.push(
        new Promise((resolve) => {
          portInfo.port.close((err) => {
            if (err) {
              this.app.logger.warn(`Error closing serial port ${portPath}: ${err.message}`);
            }
            resolve();
          });
        })
      );
    }

    await Promise.all(closePromises);
    this.openPorts.clear();
    this.app.logger.info('SerialMidiManager shut down');
  }
}

export default SerialMidiManager;
