/**
 * @file src/transports/SerialMidiManager.js
 * @description MIDI over UART (Raspberry Pi GPIO serial) manager.
 *
 * Responsibilities:
 *   - Enumerate available serial ports (`/dev/ttyAMA*`, `/dev/serial*`).
 *   - Open / close ports at the MIDI-standard 31250 baud.
 *   - Implement a full MIDI parser including Running Status and SysEx.
 *   - Hot-plug monitoring at {@link HOT_PLUG_CHECK_INTERVAL_MS}.
 *   - Multi-UART support — Pi 4 exposes up to 6 UARTs via device-tree
 *     overlays.
 *
 * Optional dependency `serialport`; absence is handled by the loader
 * in `Application.initialize` (manager simply does not register).
 */

import EventEmitter from 'events';
import fs from 'fs';
import path from 'path';
import MidiUtils from '../utils/MidiUtils.js';
import { SYSTEM_MESSAGE_LENGTH } from '../core/constants.js';

// MIDI Serial constants
const MIDI_BAUD_RATE = 31250;
const HOT_PLUG_CHECK_INTERVAL_MS = 3000;
const MAX_SYSEX_BUFFER_SIZE = 65536; // 64KB max SysEx message
const PORT_OPEN_TIMEOUT_MS = 10000; // 10 seconds max to open a port
// Bounded per-port write queue. At 31 250 baud a MIDI byte takes ~320 µs;
// this bounds worst-case buffered latency to a fraction of a second while
// preventing unbounded memory growth under a saturating burst.
const MAX_SERIAL_WRITE_QUEUE = 1024;

// MIDI message lengths by status byte high nibble
const MIDI_MESSAGE_LENGTHS = {
  0x80: 3, // Note Off
  0x90: 3, // Note On
  0xa0: 3, // Poly Aftertouch
  0xb0: 3, // Control Change
  0xc0: 2, // Program Change
  0xd0: 2, // Channel Aftertouch
  0xe0: 3 // Pitch Bend
};

// Status byte to easymidi type mapping
const STATUS_TO_TYPE = {
  0x80: 'noteoff',
  0x90: 'noteon',
  0xa0: 'poly aftertouch',
  0xb0: 'cc',
  0xc0: 'program',
  0xd0: 'channel aftertouch',
  0xe0: 'pitchbend'
};

// /dev entries treated as serial-MIDI candidates: Pi hardware UARTs,
// Pi serial aliases, standard serial ports, USB-to-serial adapters.
const SERIAL_MIDI_PATTERN = /^(ttyAMA\d+|serial\d+|ttyS\d+|ttyUSB\d+)$/;

class SerialMidiManager extends EventEmitter {
  /**
   * @param {Object} deps - Service-container facade. The manager reads
   *   `logger` and `config` at construction, then accesses
   *   `deviceManager` lazily through a getter because it registers
   *   later in the boot order.
   */
  constructor(deps) {
    super();
    this.logger = deps.logger;
    this.config = deps.config;
    Object.defineProperty(this, 'deviceManager', {
      get: () => deps.deviceManager,
      configurable: true
    });
    this.enabled = false;
    this.scanning = false;
    this.SerialPort = null; // Loaded dynamically
    this.openPorts = new Map(); // path -> { port, name, direction, parserState }
    this.configuredPorts = []; // From config.json
    this.hotPlugInterval = null;
    this.knownPorts = new Set();
    this._reopenInFlight = new Set(); // paths with an in-progress hot-plug re-open

    // Load config
    const serialConfig = this.config.serial || {};
    this.enabled = serialConfig.enabled || false;
    this.configuredPorts = serialConfig.ports || [];

    this._initPromise = this._initialize();
  }

  async _initialize() {
    if (!this.enabled) {
      this.logger.info('SerialMidiManager: disabled in config');
      return;
    }

    try {
      // Dynamic import of serialport (may not be installed)
      const serialportModule = await import('serialport');
      this.SerialPort = serialportModule.SerialPort;
      this.logger.info('SerialMidiManager: serialport library loaded');

      // Open configured ports
      await this._openConfiguredPorts();

      // Start hot-plug monitoring
      this.startHotPlugMonitoring();

      this.logger.info(`SerialMidiManager initialized (${this.openPorts.size} port(s) open)`);
    } catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND') {
        this.logger.warn(
          'SerialMidiManager: serialport package not installed. Run: npm install serialport'
        );
      } else {
        this.logger.error(`SerialMidiManager init error: ${error.message}`);
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
        this.logger.warn(`Failed to open configured port ${portConfig.path}: ${error.message}`);
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
        if (!availablePorts.find((p) => p.path === devPath)) {
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

      this.logger.info(`Serial scan: ${availablePorts.length} port(s) found`);
    } catch (error) {
      this.logger.error(`Serial scan error: ${error.message}`);
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
    try {
      for (const file of fs.readdirSync('/dev')) {
        if (SERIAL_MIDI_PATTERN.test(file)) {
          candidates.push(`/dev/${file}`);
        }
      }
    } catch (error) {
      this.logger.debug(`Cannot scan /dev: ${error.message}`);
    }
    return candidates;
  }

  /**
   * Check if a serial port path is a MIDI candidate
   */
  _isSerialMidiCandidate(portPath) {
    return SERIAL_MIDI_PATTERN.test(path.basename(portPath));
  }

  /**
   * Get a friendly name for a serial port
   */
  _getPortFriendlyName(portPath) {
    const baseName = path.basename(portPath);
    const uartMap = {
      ttyAMA0: 'UART0 (GPIO14/15)',
      ttyAMA1: 'UART2 (GPIO0/1)',
      ttyAMA2: 'UART3 (GPIO4/5)',
      ttyAMA3: 'UART4 (GPIO8/9)',
      ttyAMA4: 'UART5 (GPIO12/13)',
      serial0: 'Primary Serial',
      serial1: 'Secondary Serial'
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
      throw new Error(
        `Serial device not found: ${portPath}. Check that UART is enabled in /boot/config.txt`
      );
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
            reject(
              new Error(
                `Permission denied for ${portPath}. Run: sudo usermod -aG dialout $USER && reboot`
              )
            );
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
          this.logger.error(`Serial port error ${portPath}: ${error.message}`);
          this.emit('serial:error', { path: portPath, error: error.message });
        });

        // Handle port close
        port.on('close', () => {
          this.logger.info(`Serial port closed: ${portPath}`);
          this.openPorts.delete(portPath);
          this.emit('serial:disconnected', { path: portPath, name: portInfo.name });
          this._broadcastDeviceList();
        });

        this.openPorts.set(portPath, portInfo);
        this.knownPorts.add(portPath);

        this.logger.info(
          `Serial MIDI port opened: ${portPath} (${portInfo.name}, ${direction}, ${MIDI_BAUD_RATE} baud)`
        );
        this.emit('serial:connected', { path: portPath, name: portInfo.name });
        this._broadcastDeviceList();

        resolve(portInfo);
      });
    });

    // Wrap with timeout to prevent indefinite hang on hardware issues. The
    // timer MUST be cleared once the race is settled: left armed it keeps the
    // event loop alive for the full 10 s after every successful open, so an
    // `openPort` followed by `shutdown()` (or a hot-plug re-open at the end of
    // a run) delays process exit by 10 s per port (audit L04 F-52).
    let timeoutHandle = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`Port ${portPath} open timeout after ${PORT_OPEN_TIMEOUT_MS}ms`)),
        PORT_OPEN_TIMEOUT_MS
      );
    });

    try {
      return await Promise.race([openPromise, timeoutPromise]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
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
          this.logger.warn(`Error closing ${portPath}: ${err.message}`);
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
    if (byte >= 0xf8) {
      this._emitSystemRealtime(portPath, byte);
      return;
    }

    // SysEx handling
    if (state.inSysEx) {
      if (byte === 0xf7) {
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
          this.logger.warn(
            `SysEx buffer overflow on ${portPath} (>${MAX_SYSEX_BUFFER_SIZE} bytes), discarding`
          );
          state.inSysEx = false;
          state.sysExBuffer = [];
          return;
        }
        state.sysExBuffer.push(byte);
      }
      return;
    }

    // SysEx start
    if (byte === 0xf0) {
      state.inSysEx = true;
      state.sysExBuffer = [byte];
      state.runningStatus = 0; // SysEx cancels running status
      // Drop any partially-assembled channel-voice message: on a malformed
      // stream (e.g. `90 3C` then `F0 … F7`) the stale `[90, 3C]` would
      // otherwise be completed by the first data byte after the SysEx and emit
      // a phantom note across the boundary (audit A1 Serial#3).
      state.buffer = [];
      state.expectedLength = 0;
      return;
    }

    // System Common messages (F1-F6) cancel running status
    if (byte >= 0xf1 && byte <= 0xf6) {
      state.runningStatus = 0;
      const length = SYSTEM_MESSAGE_LENGTH[byte] || 1;
      if (length === 1) {
        this._emitSystemCommon(portPath, byte, []);
      } else {
        state.buffer = [byte];
        state.expectedLength = length;
      }
      return;
    }

    // Status byte (channel message)
    if (byte >= 0x80 && byte <= 0xef) {
      state.runningStatus = byte;
      const highNibble = byte & 0xf0;
      state.expectedLength = MIDI_MESSAGE_LENGTHS[highNibble] || 3;
      state.buffer = [byte];
      return;
    }

    // Data byte (0x00-0x7F)
    if (byte < 0x80) {
      if (state.buffer.length === 0 && state.runningStatus) {
        // Running status: use last status byte
        const highNibble = state.runningStatus & 0xf0;
        state.expectedLength = MIDI_MESSAGE_LENGTHS[highNibble] || 3;
        state.buffer = [state.runningStatus];
      }

      if (state.buffer.length > 0) {
        state.buffer.push(byte);

        if (state.buffer.length >= state.expectedLength) {
          const statusByte = state.buffer[0];
          if (statusByte >= 0xf1 && statusByte <= 0xf6) {
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
   * Forward a parsed message to DeviceManager (no-op if it is not yet
   * registered).
   *
   * The source identifier MUST be the port PATH, not the friendly name:
   * `DeviceManager.getDeviceList()` exposes serial ports with
   * `id: port.path`, so routes are stored keyed by the path. Emitting the
   * friendly name here (the previous behaviour) meant serial input never
   * matched any route and was silently dropped (audit P1 — inbound source
   * id mismatch). Every transport must route by its `getDeviceList().id`.
   */
  _forwardToDevice(portPath, type, data) {
    if (!this.deviceManager) return;
    this.deviceManager.handleMidiMessage(portPath, type, data);
  }

  /**
   * Emit a parsed channel message
   */
  _emitChannelMessage(portPath, bytes) {
    const statusByte = bytes[0];
    const highNibble = statusByte & 0xf0;
    const channel = statusByte & 0x0f;
    const type = STATUS_TO_TYPE[highNibble];

    if (!type) return;

    let data;
    switch (highNibble) {
      case 0x80: // Note Off
      case 0x90: // Note On
        data = { channel, note: bytes[1], velocity: bytes[2] };
        break;
      case 0xa0: // Poly Aftertouch
        data = { channel, note: bytes[1], pressure: bytes[2] };
        break;
      case 0xb0: // CC
        data = { channel, controller: bytes[1], value: bytes[2] };
        break;
      case 0xc0: // Program Change
        data = { channel, number: bytes[1] };
        break;
      case 0xd0: // Channel Aftertouch
        data = { channel, pressure: bytes[1] };
        break;
      case 0xe0: // Pitch Bend
        data = { channel, value: (bytes[2] << 7) | bytes[1] };
        break;
    }

    if (data) this._forwardToDevice(portPath, type, data);
  }

  /**
   * Emit a SysEx message
   */
  _emitSysEx(portPath, bytes) {
    this._forwardToDevice(portPath, 'sysex', bytes);
  }

  /**
   * Emit a system real-time message
   */
  _emitSystemRealtime(portPath, byte) {
    const type = {
      0xf8: 'clock',
      0xfa: 'start',
      0xfb: 'continue',
      0xfc: 'stop',
      0xfe: 'sensing',
      0xff: 'reset'
    }[byte];
    if (type) this._forwardToDevice(portPath, type, {});
  }

  /**
   * Emit a system common message
   */
  _emitSystemCommon(portPath, statusByte, dataBytes) {
    const type = {
      0xf1: 'mtc',
      0xf2: 'position',
      0xf3: 'select',
      0xf6: 'tune'
    }[statusByte];
    if (type) this._forwardToDevice(portPath, type, { bytes: dataBytes });
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
      this._enqueueWrite(portInfo, bytes, this._isPrioritySerial(type, data));
    }
  }

  /**
   * Whether a message must never be dropped from the serial write queue:
   * Note Off and the Channel-Mode silencing/reset CCs, plus System Reset.
   * @param {string} type
   * @param {Object} data
   * @returns {boolean}
   * @private
   */
  _isPrioritySerial(type, data) {
    if (type === 'noteoff' || type === 'reset' || type === 'stop') return true;
    if (type === 'cc' && data) {
      const cc = data.controller;
      // 120 All Sound Off, 121 Reset All Controllers, 123 All Notes Off.
      return cc === 120 || cc === 121 || cc === 123;
    }
    return false;
  }

  /**
   * Enqueue a raw-byte MIDI write on a bounded per-port FIFO. At 31 250
   * baud the UART can saturate; a bounded queue with backpressure prevents
   * unbounded memory growth and lets us surface write errors instead of
   * firing `port.write()` blind (audit P1 — "serial emission without queue
   * or backpressure"). Priority messages (Note Off / silencing / reset) are
   * kept ahead of ordinary traffic and are never the ones dropped when the
   * queue is full.
   *
   * @param {Object} portInfo
   * @param {number[]} bytes
   * @param {boolean} priority
   * @private
   */
  _enqueueWrite(portInfo, bytes, priority) {
    if (!portInfo.writeQueue) {
      portInfo.writeQueue = [];
      portInfo.writing = false;
      portInfo.droppedWrites = 0;
      portInfo.writeErrors = 0;
    }
    const q = portInfo.writeQueue;

    if (q.length >= MAX_SERIAL_WRITE_QUEUE) {
      // Make room by dropping the newest non-priority item; if the queue is
      // entirely priority traffic, drop this one (unless it too is priority).
      let removedIdx = -1;
      for (let i = q.length - 1; i >= 0; i--) {
        if (!q[i].priority) {
          removedIdx = i;
          break;
        }
      }
      if (removedIdx >= 0) {
        q.splice(removedIdx, 1);
        portInfo.droppedWrites++;
      } else if (!priority) {
        portInfo.droppedWrites++;
        return;
      }
      if (portInfo.droppedWrites % 32 === 1) {
        this.logger.warn(
          `Serial write queue saturated on ${portInfo.name || portInfo.path}: ` +
            `${portInfo.droppedWrites} message(s) dropped`
        );
      }
    }

    const item = { bytes, priority };
    if (priority) {
      // Insert after any already-queued priority items, before normal traffic.
      let idx = 0;
      while (idx < q.length && q[idx].priority) idx++;
      q.splice(idx, 0, item);
    } else {
      q.push(item);
    }
    this._drainSerialQueue(portInfo);
  }

  /**
   * Drain the per-port write queue one message at a time, honouring
   * `port.write()` backpressure via the `drain` event so we never outrun
   * the UART.
   * @param {Object} portInfo
   * @private
   */
  _drainSerialQueue(portInfo) {
    if (portInfo.writing) return;
    const item = portInfo.writeQueue.shift();
    if (!item) return;

    portInfo.writing = true;
    let flushed;
    try {
      flushed = portInfo.port.write(Buffer.from(item.bytes), (err) => {
        if (err) {
          portInfo.writeErrors++;
          this.logger.error(
            `Serial write error on ${portInfo.name || portInfo.path}: ${err.message}`
          );
          this.emit('write:error', { port: portInfo.path, error: err });
        }
      });
    } catch (err) {
      portInfo.writing = false;
      portInfo.writeErrors++;
      this.logger.error(`Serial write threw on ${portInfo.name || portInfo.path}: ${err.message}`);
      this.emit('write:error', { port: portInfo.path, error: err });
      return;
    }

    if (flushed) {
      portInfo.writing = false;
      // Continue on the next tick to avoid deep recursion on large bursts.
      setImmediate(() => this._drainSerialQueue(portInfo));
    } else {
      // Kernel buffer full — resume when it drains.
      portInfo.port.once('drain', () => {
        portInfo.writing = false;
        this._drainSerialQueue(portInfo);
      });
    }
  }

  /**
   * Convert easymidi-format message to raw MIDI bytes
   */
  _convertToMidiBytes(type, data) {
    const bytes = MidiUtils.convertToMidiBytes(type, data);
    if (!bytes) {
      this.logger.warn(`Unknown MIDI type for serial: ${type}`);
    }
    return bytes;
  }

  // ==================== HOT-PLUG MONITORING ====================

  startHotPlugMonitoring() {
    if (this.hotPlugInterval) return;

    this.hotPlugInterval = setInterval(() => {
      this._checkPortChanges();
    }, HOT_PLUG_CHECK_INTERVAL_MS);

    this.logger.info(
      `Serial hot-plug monitoring started (${HOT_PLUG_CHECK_INTERVAL_MS}ms interval)`
    );
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
      this.logger.info(`Serial port disconnected: ${portPath}`);
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

    // Insertion: re-open a CONFIGURED (enabled) port that has (re)appeared
    // but is not currently open — e.g. a UART hat re-plugged after a drop.
    // Only configured ports are auto-opened so hot-plug never grabs a port
    // the operator did not opt into (audit P2 — hot-plug handled removal
    // only, leaving re-plugged ports dark until a restart). `_reopenInFlight`
    // stops overlapping async opens from stacking up across ticks.
    for (const portPath of currentPorts) {
      if (this.openPorts.has(portPath) || this._reopenInFlight.has(portPath)) continue;
      const cfg = this.configuredPorts.find((p) => p.path === portPath && p.enabled !== false);
      if (!cfg) continue;

      this._reopenInFlight.add(portPath);
      this.openPort(cfg.path, cfg.name, cfg.direction || 'both')
        .then(() => {
          this.logger.info(`Serial port reconnected: ${portPath}`);
          this._broadcastDeviceList();
        })
        .catch((e) => {
          this.logger.warn(`Failed to reopen serial port ${portPath}: ${e.message}`);
        })
        .finally(() => {
          this._reopenInFlight.delete(portPath);
        });
    }
  }

  // ==================== STATUS & DEVICE LIST ====================

  /**
   * Get list of connected serial MIDI ports (for DeviceManager)
   */
  getConnectedPorts() {
    return Array.from(this.openPorts.values()).map((info) => ({
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
    } else if (enabled) {
      // Re-enabling after a `setEnabled(false)`. `shutdown()` closed every port
      // and stopped hot-plug monitoring, but the serialport library stays
      // loaded — so the branch above was skipped and re-enabling did nothing at
      // all: serial MIDI stayed dark until the server was restarted, while the
      // UI reported it as enabled (audit L04 F-52).
      await this._openConfiguredPorts();
      this.startHotPlugMonitoring();
    } else {
      // Close all ports
      await this.shutdown();
    }

    return { enabled: this.enabled, available: this.SerialPort !== null };
  }

  /**
   * Broadcast device list update
   */
  _broadcastDeviceList() {
    if (this.deviceManager) {
      this.deviceManager.broadcastDeviceList();
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
              this.logger.warn(`Error closing serial port ${portPath}: ${err.message}`);
            }
            resolve();
          });
        })
      );
    }

    await Promise.all(closePromises);
    this.openPorts.clear();
    this.logger.info('SerialMidiManager shut down');
  }
}

export default SerialMidiManager;
