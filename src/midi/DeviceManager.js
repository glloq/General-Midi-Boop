/**
 * @file src/midi/DeviceManager.js
 * @description Authoritative registry of every MIDI device the
 * application can talk to. Owns the inputs/outputs maps, the virtual
 * device list, the per-device rate-limit state, and the high-level
 * dispatch (`sendMessage`) used by the router and the API.
 *
 * Hot-plug discovery, USB-serial detection, and the system-device
 * filter are delegated to {@link DeviceDiscovery}; this class
 * subscribes to the discovery's change callbacks to keep the in-memory
 * maps in sync.
 *
 * Optional dependency `easymidi` (native ALSA bindings) — when missing,
 * `midiAvailable` flips to `false` and stub classes prevent imports
 * elsewhere from crashing.
 */
import DeviceDiscovery from './DeviceDiscovery.js';
import { DEVICE_STATUS } from '../constants.js';

let easymidi;
/**
 * True when the native MIDI library loaded successfully. When false
 * the manager keeps running but every send is a no-op so the rest of
 * the app can boot in development environments without ALSA.
 * @type {boolean}
 */
let midiAvailable = false;
try {
  easymidi = (await import('easymidi')).default;
  midiAvailable = true;
} catch (e) {
  // Native MIDI library not available (missing ALSA headers or build tools)
  // Server will still start but without hardware MIDI support
  // eslint-disable-next-line no-console
  console.warn(`[DeviceManager] MIDI library not available: ${e.message}`);
  easymidi = {
    getInputs: () => [],
    getOutputs: () => [],
    Input: class { constructor() { throw new Error('MIDI not available'); } },
    Output: class { constructor() { throw new Error('MIDI not available'); } }
  };
}

/**
 * Stateful MIDI device manager. Registered as `deviceManager` in the
 * DI container.
 */
class DeviceManager {
  /**
   * @param {Object} app - Application facade. Needs `logger`,
   *   `eventBus`, `database`, `wsServer`.
   */
  constructor(app) {
    this.app = app;
    this.devices = new Map();
    this.inputs = new Map();
    this.outputs = new Map();
    this.virtualDevices = new Map();

    this.midiAvailable = midiAvailable;

    // Rate limiting state
    this._rateLimitCounters = new Map(); // deviceId -> { count, windowStart }
    this._rateLimitCache = new Map();    // deviceId -> limit (0 = unlimited)

    // Listen for device settings changes to refresh rate limit cache
    this.app.eventBus?.on('device_settings_changed', ({ deviceId }) => {
      this._rateLimitCache.delete(deviceId);
    });

    // Delegate discovery, hot-plug monitoring, and USB serial detection
    this.discovery = new DeviceDiscovery(app, easymidi, midiAvailable);
    this.discovery.setChangeCallbacks(
      async (change) => {
        // Handle individual device changes from hot-plug monitoring
        if (change.type === 'addInput') {
          this.addInput(change.name);
        } else if (change.type === 'addOutput') {
          this.addOutput(change.name);
        } else if (change.type === 'update') {
          await this.updateDeviceMap();
          this.broadcastDeviceList();
          this.app.logger.info(`Device list updated: ${this.devices.size} device(s)`);
        }
      },
      async () => {
        // Full rescan callback
        await this.scanDevices();
      }
    );

    if (!midiAvailable) {
      this.app.logger.warn('DeviceManager initialized WITHOUT hardware MIDI support (native library not available)');
    } else {
      this.app.logger.info('DeviceManager initialized');
    }
  }

  /**
   * Full rescan of available MIDI hardware. Closes/reopens ports as
   * needed, rebuilds the device map, broadcasts the result over WS, and
   * restarts hot-plug monitoring. Safe to call repeatedly — used both
   * at boot and via the `device_refresh` API command.
   *
   * @returns {Promise<Object[]>} Snapshot of the device list after the scan.
   */
  async scanDevices() {
    await this.discovery.scanAndReopen(
      this.inputs,
      this.outputs,
      (name) => this.addInput(name),
      (name) => this.addOutput(name)
    );

    // Clear devices before rebuilding
    this.devices.clear();

    // Update devices map
    await this.updateDeviceMap();

    // Broadcast device list
    this.broadcastDeviceList();

    const deviceList = this.getDeviceList();
    this.app.logger.info(`Scan complete: ${deviceList.length} device(s) found`);

    // Restart hot-plug monitoring with fresh device lists
    this.discovery.stopHotPlugMonitoring();
    this.discovery.startHotPlugMonitoring(this.inputs, this.outputs);

    return deviceList;
  }

  /**
   * Open an input port by name and wire its message listener. No-op
   * when already opened or when the port is classified as a system
   * device (Midi Through, etc.).
   *
   * @param {string} name
   * @returns {void}
   */
  addInput(name) {
    if (this.inputs.has(name)) {
      return;
    }

    try {
      const input = new easymidi.Input(name);

      // Add error listener to detect device issues
      input.on('error', (error) => {
        this.app.logger.error(`Input device error ${name}: ${error.message}`);
      });

      // Handle MIDI messages
      input.on('noteon', (msg) => this.handleMidiMessage(name, 'noteon', msg));
      input.on('noteoff', (msg) => this.handleMidiMessage(name, 'noteoff', msg));
      input.on('cc', (msg) => this.handleMidiMessage(name, 'cc', msg));
      input.on('program', (msg) => this.handleMidiMessage(name, 'program', msg));
      input.on('pitchbend', (msg) => this.handleMidiMessage(name, 'pitchbend', msg));
      input.on('poly aftertouch', (msg) => this.handleMidiMessage(name, 'poly aftertouch', msg));
      input.on('channel aftertouch', (msg) => this.handleMidiMessage(name, 'channel aftertouch', msg));
      input.on('sysex', (msg) => this.handleMidiMessage(name, 'sysex', msg));

      this.inputs.set(name, input);
    } catch (error) {
      this.app.logger.error(`Cannot open input ${name}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Open an output port by name. No-op when already opened or when the
   * port is a system device.
   *
   * @param {string} name
   * @returns {void}
   */
  addOutput(name) {
    if (this.outputs.has(name)) {
      return;
    }

    try {
      const output = new easymidi.Output(name);
      this.outputs.set(name, output);
    } catch (error) {
      this.app.logger.error(`Cannot open output ${name}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Reconcile the in-memory `devices` map with the currently-open
   * inputs/outputs/virtual devices and any persisted device-settings
   * rows. Idempotent — produces the canonical snapshot consumed by
   * {@link DeviceManager#getDeviceList} and the `device_list` command.
   *
   * @returns {Promise<void>}
   */
  async updateDeviceMap() {
    this.devices.clear();

    this.app.logger.debug(`Updating device map: ${this.inputs.size} inputs, ${this.outputs.size} outputs`);
    this.app.logger.debug(`Input names: ${Array.from(this.inputs.keys()).join(', ')}`);
    this.app.logger.debug(`Output names: ${Array.from(this.outputs.keys()).join(', ')}`);

    // Get USB serial numbers for all connected devices
    const serialNumbers = await this.discovery.getUsbSerialNumbers();

    // Add USB devices
    for (const [name] of this.inputs) {
      if (!this.devices.has(name)) {
        const serialNumber = this.discovery.findSerialNumberInMap(name, serialNumbers);

        this.devices.set(name, {
          id: name,
          name: name,
          type: 'usb',
          input: true,
          output: this.outputs.has(name),
          enabled: true,
          connected: true,
          status: DEVICE_STATUS.CONNECTED,
          usbSerialNumber: serialNumber || null
        });

        if (serialNumber) {
          this.app.logger.info(`USB device ${name} has serial number: ${serialNumber}`);
        }
      }
    }

    for (const [name] of this.outputs) {
      if (!this.devices.has(name)) {
        const serialNumber = this.discovery.findSerialNumberInMap(name, serialNumbers);

        this.devices.set(name, {
          id: name,
          name: name,
          type: 'usb',
          input: false,
          output: true,
          enabled: true,
          connected: true,
          status: DEVICE_STATUS.CONNECTED,
          usbSerialNumber: serialNumber || null
        });

        if (serialNumber) {
          this.app.logger.info(`USB device ${name} has serial number: ${serialNumber}`);
        }
      }
    }

    // Add virtual devices
    this.virtualDevices.forEach((vdev, name) => {
      this.devices.set(name, {
        id: name,
        name: name,
        type: 'virtual',
        input: vdev.input !== null,
        output: vdev.output !== null,
        enabled: true,
        connected: true,
        status: DEVICE_STATUS.CONNECTED,
        usbSerialNumber: null
      });
    });
  }

  /**
   * @returns {Object[]} Snapshot of every registered device (hardware,
   *   virtual, and inactive entries with persisted settings).
   */
  getDeviceList() {
    const usbDevices = Array.from(this.devices.values());
    const allDevices = [...usbDevices];

    // Add paired and connected Bluetooth devices
    if (this.app.bluetoothManager) {
      const pairedDevices = this.app.bluetoothManager.getPairedDevices() || [];

      const connectedBluetoothDevices = pairedDevices
        .filter(device => device.connected)
        .map(device => ({
          id: device.address,
          name: device.name,
          manufacturer: 'Bluetooth',
          type: 'bluetooth',
          input: true,
          output: true,
          enabled: true,
          connected: true,
          status: DEVICE_STATUS.CONNECTED,
          address: device.address
        }));

      allDevices.push(...connectedBluetoothDevices);
    }

    // Add connected network devices
    if (this.app.networkManager) {
      const networkDevices = (this.app.networkManager.getConnectedDevices() || [])
        .map(device => ({
          id: device.ip,
          name: device.name || `Network MIDI (${device.ip})`,
          manufacturer: 'Network',
          type: 'network',
          input: true,
          output: true,
          enabled: true,
          connected: true,
          status: DEVICE_STATUS.CONNECTED,
          address: device.ip,
          port: device.port
        }));

      allDevices.push(...networkDevices);
    }

    // Add serial MIDI devices (GPIO UART)
    if (this.app.serialMidiManager) {
      const serialPorts = (this.app.serialMidiManager.getConnectedPorts() || [])
        .map(port => ({
          id: port.path,
          name: port.name || `Serial MIDI (${port.path})`,
          manufacturer: 'Serial',
          type: 'serial',
          input: port.direction === 'both' || port.direction === 'in',
          output: port.direction === 'both' || port.direction === 'out',
          enabled: true,
          connected: true,
          status: DEVICE_STATUS.CONNECTED,
          address: port.path
        }));

      allDevices.push(...serialPorts);
    }

    // Deduplicate by name
    const typePriority = { network: 0, bluetooth: 1, serial: 2, usb: 3, virtual: 4 };
    allDevices.sort((a, b) => (typePriority[a.type] ?? 99) - (typePriority[b.type] ?? 99));
    const uniqueDevices = [];
    const seenNames = new Set();

    this.app.logger.debug(`[Deduplication] ${allDevices.length} devices before:`);
    allDevices.forEach(d => {
      this.app.logger.debug(`  - "${d.name}" (${d.type})`);
    });

    const normalizeName = (name) => {
      let normalized = name.split(':')[0].trim();
      return normalized;
    };

    for (const device of allDevices) {
      const normalizedName = normalizeName(device.name);

      if (!seenNames.has(normalizedName)) {
        seenNames.add(normalizedName);
        uniqueDevices.push(device);
        this.app.logger.debug(`[Deduplication] ✓ KEPT: "${device.name}" (${device.type}) [normalized: "${normalizedName}"]`);
      } else {
        // Merge capabilities: if the duplicate has input/output the kept one lacks, merge them
        const kept = uniqueDevices.find(d => normalizeName(d.name) === normalizedName);
        if (kept) {
          if (device.input && !kept.input) kept.input = true;
          if (device.output && !kept.output) kept.output = true;
          this.app.logger.debug(`[Deduplication] ↗ MERGED: "${device.name}" (${device.type}) into "${kept.name}" → input=${kept.input}, output=${kept.output}`);
        } else {
          this.app.logger.debug(`[Deduplication] ✗ SKIP: "${device.name}" (${device.type}) [normalized: "${normalizedName}"] - duplicate`);
        }
      }
    }

    this.app.logger.info(`[Deduplication] Result: ${allDevices.length} → ${uniqueDevices.length} devices`);

    return uniqueDevices;
  }

  /**
   * Public dispatch entry. Resolves the named device to an output port
   * (or virtual sink), enforces per-device rate limiting, then sends.
   * Returns false when the device is unknown, gated by the rate limiter,
   * or the underlying send threw.
   *
   * @param {string} deviceName
   * @param {string} type - Message type (`'noteon'`, `'cc'`, ...).
   * @param {Object} data - Message payload.
   * @returns {boolean} True on successful enqueue.
   */
  sendMessage(deviceName, type, data) {
    // Skip rate limiting for real-time messages (clock, transport)
    const isRealTime = type === 'clock' || type === 'start' || type === 'stop' || type === 'continue';
    if (!isRealTime && this._isRateLimited(deviceName)) {
      return false;
    }

    // Broadcast to debug monitor if monitorAll is active
    if (this.app.midiRouter?.monitorAll && this.app.wsServer) {
      let instrumentName = null;
      if (this.app.database && data && data.channel !== undefined) {
        try {
          const settings = this.app.database.getInstrumentSettings(deviceName, data.channel);
          if (settings) instrumentName = settings.custom_name || settings.name;
        } catch (e) { /* instrument name lookup is optional for monitor events */ }
      }
      this.app.wsServer.broadcast('monitor_event', {
        device: deviceName,
        instrumentName: instrumentName,
        type: type,
        data: data,
        timestamp: Date.now(),
        direction: 'out'
      });
    }

    // Check USB MIDI device
    const output = this.outputs.get(deviceName);
    if (output) {
      try {
        output.send(type, data);
        return true;
      } catch (error) {
        this.app.logger.error(`Failed to send MIDI message to ${deviceName}: ${error.message}`);
        return false;
      }
    }

    // Check Bluetooth device
    if (this.app.bluetoothManager) {
      const pairedDevices = this.app.bluetoothManager.getPairedDevices();
      const bleDevice = pairedDevices.find(d =>
        d.address === deviceName || d.name === deviceName
      );

      if (bleDevice && bleDevice.connected) {
        try {
          this.app.bluetoothManager.sendMidiMessage(bleDevice.address, type, data)
            .catch(error => {
              this.app.logger.error(`BLE MIDI send failed to ${deviceName}: ${error.message}`);
            });
          return true;
        } catch (error) {
          this.app.logger.error(`Failed to send MIDI via Bluetooth to ${deviceName}: ${error.message}`);
          return false;
        }
      }
    }

    // Check network device
    if (this.app.networkManager) {
      const networkDevices = this.app.networkManager.getConnectedDevices();
      const networkDevice = networkDevices.find(d =>
        d.ip === deviceName || d.name === deviceName || d.address === deviceName
      );

      if (networkDevice) {
        try {
          this.app.networkManager.sendMidiMessage(networkDevice.ip, type, data)
            .catch(error => {
              this.app.logger.error(`Network MIDI send failed to ${deviceName}: ${error.message}`);
            });
          return true;
        } catch (error) {
          this.app.logger.error(`Failed to send MIDI via Network to ${deviceName}: ${error.message}`);
          return false;
        }
      }
    }

    // Check serial MIDI device (GPIO)
    if (this.app.serialMidiManager) {
      const serialPorts = this.app.serialMidiManager.getConnectedPorts();
      const serialPort = serialPorts.find(p =>
        p.name === deviceName || p.path === deviceName
      );

      if (serialPort) {
        try {
          this.app.serialMidiManager.sendMidiMessage(serialPort.path, type, data);
          return true;
        } catch (error) {
          this.app.logger.error(`Failed to send MIDI message via Serial to ${deviceName}: ${error.message}`);
          return false;
        }
      }
    }

    this.app.logger.warn(`Output device not found: ${deviceName}`);
    return false;
  }

  /**
   * Send SysEx Identity Request to a device using MidiMind Block 1 protocol
   */
  /**
   * Send a MIDI Universal Identity Request (SysEx F0 7E <id> 06 01 F7)
   * to a device. Reply, if any, arrives asynchronously via the normal
   * input path and is processed by {@link DeviceManager#parseIdentityReply}.
   *
   * @param {string} deviceName
   * @param {number} [_deviceId=0x7F] - SysEx target id (0x7F = broadcast).
   * @returns {boolean} True when the request was queued for send.
   */
  sendIdentityRequest(deviceName, _deviceId = 0x7F) {
    this.app.logger.debug(`Looking for output: ${deviceName}`);
    this.app.logger.debug(`Available outputs: ${Array.from(this.outputs.keys()).join(', ')}`);

    const output = this.outputs.get(deviceName);
    if (!output) {
      const hasInput = this.inputs.has(deviceName);
      if (hasInput) {
        this.app.logger.warn(`Device ${deviceName} is input-only, cannot send SysEx messages`);
        throw new Error(`Device ${deviceName} is input-only. Cannot send SysEx messages to input-only devices.`);
      } else {
        this.app.logger.warn(`Output device not found: ${deviceName}`);
        this.app.logger.warn(`Available outputs: ${Array.from(this.outputs.keys()).join(', ')}`);
        throw new Error(`Output device not found: ${deviceName}`);
      }
    }

    try {
      const sysexData = [
        0xF0,        // SysEx Start
        0x7D,        // Custom SysEx (Educational/Development)
        0x00,        // MidiMind Manufacturer ID
        0x01,        // Block 1 (Identification)
        0x00,        // Request flag (00=request, 01=response)
        0xF7         // SysEx End
      ];

      output.send('sysex', sysexData);
      this.app.logger.info(`MidiMind Block 1 Identity Request sent to ${deviceName}`);
      return true;
    } catch (error) {
      this.app.logger.error(`Failed to send Identity Request: ${error.message}`);
      throw error;
    }
  }

  /**
   * Common entry point for every inbound MIDI message. Emits
   * `midi_message` on the EventBus, hands it to the {@link MidiRouter},
   * and intercepts SysEx Identity Replies for auto-detection.
   *
   * @param {string} deviceName
   * @param {string} type
   * @param {Object} msg
   * @returns {void}
   */
  handleMidiMessage(deviceName, type, msg) {
    const timestamp = Date.now();

    // Parse SysEx Identity Reply if applicable
    if (type === 'sysex') {
      const bytes = Array.isArray(msg) ? msg : (msg.bytes || []);
      this.app.logger.info(`SysEx message received from ${deviceName}: ${bytes.map(b => '0x' + b.toString(16).toUpperCase()).join(' ')} (${bytes.length} bytes)`);

      const identityInfo = this.parseIdentityReply(msg);
      if (identityInfo) {
        this.app.logger.info(`Identity Reply received from ${deviceName}:`, identityInfo);

        if (this.app.database) {
          try {
            this.app.database.saveSysExIdentity(deviceName, 0, identityInfo);
            this.app.logger.info(`SysEx identity saved for ${deviceName}`);
          } catch (e) {
            this.app.logger.warn(`Failed to save SysEx identity for ${deviceName}: ${e.message}`);
          }
        }

        if (this.app.wsServer) {
          this.app.wsServer.broadcast('device_identity', {
            device: deviceName,
            identity: identityInfo,
            timestamp: timestamp
          });
        }
      } else {
        this.app.logger.debug(`SysEx message from ${deviceName} is not an Identity Reply`);
      }
    }

    // Emit to event bus
    this.app.eventBus.emit('midi_message', {
      device: deviceName,
      type: type,
      data: msg,
      timestamp: timestamp
    });

    // Route message if router is available
    if (this.app.midiRouter) {
      this.app.midiRouter.routeMessage(deviceName, type, msg);
    }

    // Broadcast to WebSocket clients
    if (this.app.wsServer) {
      this.app.wsServer.broadcast('midi_event', {
        device: deviceName,
        type: type,
        data: msg,
        timestamp: timestamp
      });
    }
  }

  /**
   * Decode a 32-bit value from 5 bytes of 7-bit encoded data
   */
  decode7BitTo32Bit(data) {
    let value = 0;
    value |= (data[0] & 0x7F);
    value |= (data[1] & 0x7F) << 7;
    value |= (data[2] & 0x7F) << 14;
    value |= (data[3] & 0x7F) << 21;
    value |= (data[4] & 0x07) << 28;
    return value >>> 0;
  }

  /**
   * Parse SysEx Identity Reply message using MidiMind Block 1 protocol
   */
  /**
   * Decode a SysEx Universal Identity Reply (F0 7E <ch> 06 02 ...) into
   * `{manufacturerId, manufacturerName, family, model, version}`.
   * Returns null when the SysEx payload is not an identity reply.
   *
   * @param {{bytes:number[]}|number[]} msg
   * @returns {?Object}
   */
  parseIdentityReply(msg) {
    const bytes = Array.isArray(msg) ? msg : (msg.bytes || []);

    this.app.logger.debug(`Received SysEx message: ${bytes.map(b => '0x' + b.toString(16).toUpperCase()).join(' ')}`);
    this.app.logger.debug(`Length: ${bytes.length}, First: 0x${bytes[0]?.toString(16).toUpperCase()}, Last: 0x${bytes[bytes.length - 1]?.toString(16).toUpperCase()}`);

    if (bytes.length !== 52) return null;
    if (bytes[0] !== 0xF0) return null;
    if (bytes[1] !== 0x7D) return null;
    if (bytes[2] !== 0x00) return null;
    if (bytes[3] !== 0x01) return null;
    if (bytes[4] !== 0x01) return null;
    if (bytes[51] !== 0xF7) return null;

    let pos = 5;

    const blockVersion = bytes[pos];
    pos += 1;

    const deviceIdBytes = bytes.slice(pos, pos + 5);
    const deviceId = this.decode7BitTo32Bit(deviceIdBytes);
    pos += 5;

    const nameBytes = bytes.slice(pos, pos + 32);
    let deviceName = '';
    for (let i = 0; i < nameBytes.length; i++) {
      if (nameBytes[i] === 0x00) break;
      deviceName += String.fromCharCode(nameBytes[i]);
    }
    pos += 32;

    const firmwareMajor = bytes[pos];
    const firmwareMinor = bytes[pos + 1];
    const firmwarePatch = bytes[pos + 2];
    const firmwareVersion = `${firmwareMajor}.${firmwareMinor}.${firmwarePatch}`;
    pos += 3;

    const featureBytes = bytes.slice(pos, pos + 5);
    const features = this.decode7BitTo32Bit(featureBytes);
    pos += 5;

    const featureFlags = {
      noteMap: (features & 0x01) !== 0,
      velocityCurves: (features & 0x02) !== 0,
      ccMapping: (features & 0x04) !== 0
    };

    return {
      protocol: 'MidiMind Block 1',
      blockVersion: blockVersion,
      deviceId: `0x${deviceId.toString(16).padStart(8, '0').toUpperCase()}`,
      deviceIdDecimal: deviceId,
      deviceName: deviceName,
      manufacturerName: 'MidiMind',
      firmwareVersion: firmwareVersion,
      firmware: {
        major: firmwareMajor,
        minor: firmwareMinor,
        patch: firmwarePatch
      },
      features: `0x${features.toString(16).padStart(8, '0').toUpperCase()}`,
      featuresDecimal: features,
      featureFlags: featureFlags,
      rawBytes: bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')
    };
  }

  /**
   * Get manufacturer name from manufacturer ID
   */
  /**
   * Resolve a SysEx manufacturer ID (1 byte or 3 bytes for the
   * 0x00-prefixed extended range) to a human-readable name. Returns
   * `"Unknown (0x...)"` for IDs not in the lookup table.
   *
   * @param {number[]} id
   * @returns {string}
   */
  getManufacturerName(id) {
    const manufacturers = {
      0x01: 'Sequential Circuits', 0x02: 'IDP', 0x03: 'Voyetra/Octave-Plateau',
      0x04: 'Moog', 0x05: 'Passport Designs', 0x06: 'Lexicon',
      0x07: 'Kurzweil', 0x08: 'Fender', 0x09: 'Gulbransen',
      0x0A: 'AKG Acoustics', 0x0B: 'Voyce Music', 0x0C: 'Waveframe',
      0x0D: 'ADA', 0x0E: 'Garfield Electronics', 0x0F: 'Ensoniq',
      0x10: 'Oberheim', 0x11: 'Apple', 0x12: 'Grey Matter Response',
      0x13: 'Digidesign', 0x14: 'Palmtree Instruments', 0x15: 'JLCooper Electronics',
      0x16: 'Lowrey', 0x17: 'Adams-Smith', 0x18: 'E-mu',
      0x19: 'Harmony Systems', 0x1A: 'ART', 0x1B: 'Baldwin',
      0x1C: 'Eventide', 0x1D: 'Inventronics', 0x20: 'Clarity',
      0x21: 'Passac', 0x22: 'SIEL', 0x23: 'Synthaxe',
      0x25: 'Hohner', 0x26: 'Twister', 0x27: 'Solton',
      0x28: 'Jellinghaus MS', 0x2F: 'Elka', 0x36: 'Cheetah',
      0x3E: 'Waldorf', 0x40: 'Kawai', 0x41: 'Roland',
      0x42: 'Korg', 0x43: 'Yamaha', 0x44: 'Casio', 0x47: 'Akai'
    };
    return manufacturers[id] || 'Unknown';
  }

  /**
   * Open a software MIDI port using easymidi's virtual ports
   * (Linux/macOS only). The same port is registered as both an input
   * and an output so other applications can talk to it bidirectionally.
   *
   * @param {string} name
   * @returns {Promise<{success:boolean, error?:string}>}
   */
  async createVirtualDevice(name) {
    if (this.virtualDevices.has(name)) {
      throw new Error(`Virtual device already exists: ${name}`);
    }

    const input = new easymidi.Input(name, true);
    const output = new easymidi.Output(name, true);

    input.on('noteon', (msg) => this.handleMidiMessage(name, 'noteon', msg));
    input.on('noteoff', (msg) => this.handleMidiMessage(name, 'noteoff', msg));
    input.on('cc', (msg) => this.handleMidiMessage(name, 'cc', msg));

    this.virtualDevices.set(name, { input, output });
    await this.updateDeviceMap();
    this.broadcastDeviceList();

    this.app.logger.info(`Virtual device created: ${name}`);
    return name;
  }

  /**
   * Close and unregister a virtual port previously created with
   * {@link DeviceManager#createVirtualDevice}.
   *
   * @param {string} name
   * @returns {Promise<{success:boolean, error?:string}>}
   */
  async deleteVirtualDevice(name) {
    const vdev = this.virtualDevices.get(name);
    if (!vdev) {
      throw new Error(`Virtual device not found: ${name}`);
    }

    vdev.input.removeAllListeners();
    vdev.input.close();
    vdev.output.close();
    this.virtualDevices.delete(name);
    await this.updateDeviceMap();
    this.broadcastDeviceList();

    this.app.logger.info(`Virtual device deleted: ${name}`);
  }

  /**
   * @param {string} deviceId
   * @param {boolean} enabled
   * @returns {void}
   */
  enableDevice(deviceId, enabled) {
    const device = this.devices.get(deviceId);
    if (!device) {
      throw new Error(`Device not found: ${deviceId}`);
    }

    device.enabled = enabled;
    this.app.logger.info(`Device ${deviceId} ${enabled ? 'enabled' : 'disabled'}`);
    this.broadcastDeviceList();
  }

  getDeviceInfo(deviceId) {
    return this.devices.get(deviceId);
  }

  // Delegate to discovery
  isSystemDevice(name) {
    return this.discovery.isSystemDevice(name);
  }

  async getUsbSerialNumbers() {
    return this.discovery.getUsbSerialNumbers();
  }

  /** @returns {?string} */
  _findSerialNumberInMap(deviceName, serialNumbers) {
    return this.discovery.findSerialNumberInMap(deviceName, serialNumbers);
  }

  /** @returns {Promise<?string>} */
  async findSerialNumberForDevice(deviceName) {
    return this.discovery.findSerialNumberForDevice(deviceName);
  }

  /** Start hot-plug monitoring (delegates to {@link DeviceDiscovery}). */
  startHotPlugMonitoring() {
    this.discovery.startHotPlugMonitoring(this.inputs, this.outputs);
  }

  /** Stop hot-plug monitoring. */
  stopHotPlugMonitoring() {
    this.discovery.stopHotPlugMonitoring();
  }

  /**
   * Broadcast a `device_list` WebSocket event with the current snapshot.
   * Called from `scanDevices` and on hot-plug events.
   *
   * @returns {void}
   */
  broadcastDeviceList() {
    if (this.app.wsServer) {
      this.app.wsServer.broadcast('device_list', {
        devices: this.getDeviceList()
      });
    }
  }

  /**
   * Close every open input/output/virtual port and stop hot-plug
   * monitoring. Listeners are removed before close to prevent callbacks
   * firing during teardown. Called from Application#stop.
   *
   * @returns {void}
   */
  close() {
    // Stop hot-plug monitoring
    this.discovery.stopHotPlugMonitoring();

    // Close all inputs (remove listeners first to prevent callbacks during close)
    this.inputs.forEach(input => {
      try {
        input.removeAllListeners();
        input.close();
      } catch (error) {
        this.app.logger.error(`Error closing input: ${error.message}`);
      }
    });

    // Close all outputs
    this.outputs.forEach(output => {
      try {
        output.close();
      } catch (error) {
        this.app.logger.error(`Error closing output: ${error.message}`);
      }
    });

    // Close virtual devices (remove listeners first)
    this.virtualDevices.forEach(vdev => {
      try {
        vdev.input.removeAllListeners();
        vdev.input.close();
        vdev.output.close();
      } catch (error) {
        this.app.logger.error(`Error closing virtual device: ${error.message}`);
      }
    });

    this.app.logger.info('DeviceManager closed');
  }

  // ─── Rate Limiting ────────────────────────────────────────

  /**
   * Check if a device has exceeded its message rate limit.
   * Uses a sliding 1-second window.
   * @param {string} deviceId
   * @returns {boolean} true if message should be dropped
   */
  _isRateLimited(deviceId) {
    const limit = this._getDeviceRateLimit(deviceId);
    if (limit <= 0) return false; // 0 = unlimited

    const now = Date.now();
    let counter = this._rateLimitCounters.get(deviceId);

    if (!counter || (now - counter.windowStart) >= 1000) {
      // New window
      counter = { count: 1, windowStart: now };
      this._rateLimitCounters.set(deviceId, counter);
      return false;
    }

    counter.count++;
    if (counter.count > limit) {
      return true; // Drop message
    }
    return false;
  }

  /**
   * Get rate limit for a device (cached, refreshed on device_settings_changed).
   * @param {string} deviceId
   * @returns {number} 0 = unlimited
   */
  _getDeviceRateLimit(deviceId) {
    if (this._rateLimitCache.has(deviceId)) {
      return this._rateLimitCache.get(deviceId);
    }
    let limit = 0;
    if (this.app.database) {
      try {
        const settings = this.app.database.getDeviceSettings(deviceId);
        if (settings) limit = settings.message_rate_limit || 0;
      } catch (_e) { /* device settings may not exist yet */ }
    }
    this._rateLimitCache.set(deviceId, limit);
    return limit;
  }
}

export default DeviceManager;
