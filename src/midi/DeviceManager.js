// src/midi/DeviceManager.js
import easymidi from 'easymidi';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// Device connection status constants
const DEVICE_STATUS = {
  DISCONNECTED: 0,
  CONNECTING: 1,
  CONNECTED: 2
};

// Timing constants
const PORT_RELEASE_DELAY_MS = 250; // Delay to ensure MIDI ports are released

class DeviceManager {
  constructor(app) {
    this.app = app;
    this.devices = new Map();
    this.inputs = new Map();
    this.outputs = new Map();
    this.virtualDevices = new Map();

    // Hot-plug detection
    this.hotPlugInterval = null;
    this.hotPlugCheckIntervalMs = 2000; // Check every 2 seconds
    this.knownInputs = new Set();
    this.knownOutputs = new Set();

    this.app.logger.info('DeviceManager initialized');
  }

  async scanDevices() {
    // Close all existing connections first to ensure clean state
    this.app.logger.info('Closing existing MIDI connections...');

    // Close inputs with error handling
    const inputsToClose = Array.from(this.inputs.entries());
    for (const [name, input] of inputsToClose) {
      try {
        // Remove all listeners first to avoid issues
        input.removeAllListeners();
        input.close();
        this.app.logger.info(`✓ Closed input: ${name}`);
      } catch (error) {
        this.app.logger.warn(`Failed to close input ${name}: ${error.message}`);
      }
    }

    // Close outputs with error handling
    const outputsToClose = Array.from(this.outputs.entries());
    for (const [name, output] of outputsToClose) {
      try {
        output.close();
        this.app.logger.info(`✓ Closed output: ${name}`);
      } catch (error) {
        this.app.logger.warn(`Failed to close output ${name}: ${error.message}`);
      }
    }

    // Clear all maps
    this.inputs.clear();
    this.outputs.clear();
    this.devices.clear();

    // Longer delay to ensure ports are properly released and system recognizes changes
    this.app.logger.info('Waiting for ports to release...');
    await new Promise(resolve => setTimeout(resolve, PORT_RELEASE_DELAY_MS));

    // USB MIDI devices - get fresh list
    const inputs = easymidi.getInputs();
    const outputs = easymidi.getOutputs();

    this.app.logger.info(`Scanning devices: ${inputs.length} inputs, ${outputs.length} outputs`);
    this.app.logger.info(`Input devices found: ${JSON.stringify(inputs)}`);
    this.app.logger.info(`Output devices found: ${JSON.stringify(outputs)}`);

    // Add inputs (filter out system devices)
    for (const name of inputs) {
      // Skip MIDI Through ports (system virtual ports)
      if (this.isSystemDevice(name)) {
        this.app.logger.info(`Skipping system device (input): ${name}`);
        continue;
      }

      try {
        this.addInput(name);
        this.app.logger.info(`✓ Input device added: ${name}`);
      } catch (error) {
        this.app.logger.error(`✗ Failed to add input ${name}: ${error.message}`);
      }
    }

    // Add outputs (filter out system devices)
    for (const name of outputs) {
      // Skip MIDI Through ports (system virtual ports)
      if (this.isSystemDevice(name)) {
        this.app.logger.info(`Skipping system device (output): ${name}`);
        continue;
      }

      try {
        this.addOutput(name);
        this.app.logger.info(`✓ Output device added: ${name}`);
      } catch (error) {
        this.app.logger.error(`✗ Failed to add output ${name}: ${error.message}`);
      }
    }

    // BLE MIDI (sera implémenté en Phase 7)
    // await this.scanBLE();

    // Update devices map
    await this.updateDeviceMap();

    // Broadcast device list
    this.broadcastDeviceList();

    const deviceList = this.getDeviceList();
    this.app.logger.info(`Scan complete: ${deviceList.length} device(s) found`);

    // Restart hot-plug monitoring with fresh device lists
    this.stopHotPlugMonitoring();
    this.startHotPlugMonitoring();

    return deviceList;
  }

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

  addOutput(name) {
    if (this.outputs.has(name)) {
      return;
    }

    try {
      const output = new easymidi.Output(name);

      // Store with error tracking
      this.outputs.set(name, output);
    } catch (error) {
      this.app.logger.error(`Cannot open output ${name}: ${error.message}`);
      throw error;
    }
  }

  async updateDeviceMap() {
    this.devices.clear();

    this.app.logger.debug(`Updating device map: ${this.inputs.size} inputs, ${this.outputs.size} outputs`);
    this.app.logger.debug(`Input names: ${Array.from(this.inputs.keys()).join(', ')}`);
    this.app.logger.debug(`Output names: ${Array.from(this.outputs.keys()).join(', ')}`);

    // Get USB serial numbers for all connected devices
    const serialNumbers = await this.getUsbSerialNumbers();

    // Add USB devices (reuse serialNumbers fetched above to avoid N redundant calls)
    for (const [name, input] of this.inputs) {
      if (!this.devices.has(name)) {
        const serialNumber = this._findSerialNumberInMap(name, serialNumbers);

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

    for (const [name, output] of this.outputs) {
      if (!this.devices.has(name)) {
        const serialNumber = this._findSerialNumberInMap(name, serialNumbers);

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

  getDeviceList() {
    const usbDevices = Array.from(this.devices.values());
    const allDevices = [...usbDevices];

    // Ajouter les périphériques Bluetooth appairés et connectés
    if (this.app.bluetoothManager) {
      const pairedDevices = this.app.bluetoothManager.getPairedDevices();

      // Ajouter seulement les périphériques connectés à la liste des instruments disponibles
      const connectedBluetoothDevices = pairedDevices
        .filter(device => device.connected)
        .map(device => ({
          id: device.address,
          name: device.name,
          manufacturer: 'Bluetooth',
          type: 'bluetooth',
          input: true,  // BLE MIDI supporte généralement l'entrée
          output: true, // BLE MIDI supporte généralement la sortie
          enabled: true,
          connected: true,
          status: DEVICE_STATUS.CONNECTED,
          address: device.address
        }));

      allDevices.push(...connectedBluetoothDevices);
    }

    // Ajouter les périphériques réseau connectés
    if (this.app.networkManager) {
      const networkDevices = this.app.networkManager.getConnectedDevices()
        .map(device => ({
          id: device.ip,
          name: device.name || `Network MIDI (${device.ip})`,
          manufacturer: 'Network',
          type: 'network',
          input: true,  // Network MIDI supporte généralement l'entrée
          output: true, // Network MIDI supporte généralement la sortie
          enabled: true,
          connected: true,
          status: DEVICE_STATUS.CONNECTED,
          address: device.ip,
          port: device.port
        }));

      allDevices.push(...networkDevices);
    }

    // Ajouter les périphériques série MIDI (GPIO UART)
    if (this.app.serialMidiManager) {
      const serialPorts = this.app.serialMidiManager.getConnectedPorts()
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

    // Dédupliquer par nom (évite doublons USB input/output et USB/Bluetooth/Network)
    // Priorité: Network > Bluetooth > USB
    const uniqueDevices = [];
    const seenNames = new Set();

    this.app.logger.debug(`[Deduplication] ${allDevices.length} devices before:`);
    allDevices.forEach(d => {
      this.app.logger.debug(`  - "${d.name}" (${d.type})`);
    });

    // Fonction pour normaliser un nom (retire suffixes courants)
    const normalizeName = (name) => {
      // Retirer les suffixes de port MIDI (ex: ":Lyre-Test MIDI 128:0" -> "Lyre-Test")
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
        this.app.logger.debug(`[Deduplication] ✗ SKIP: "${device.name}" (${device.type}) [normalized: "${normalizedName}"] - duplicate`);
      }
    }

    this.app.logger.info(`[Deduplication] Result: ${allDevices.length} → ${uniqueDevices.length} devices`);

    return uniqueDevices;
  }

  sendMessage(deviceName, type, data) {
    // Vérifier si c'est un périphérique USB MIDI
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

    // Sinon, vérifier si c'est un périphérique Bluetooth
    // Note: getDeviceList() uses device.address as the ID for Bluetooth devices,
    // so we must match by address (primary) as well as name (fallback)
    if (this.app.bluetoothManager) {
      const pairedDevices = this.app.bluetoothManager.getPairedDevices();
      const bleDevice = pairedDevices.find(d =>
        d.address === deviceName || d.name === deviceName
      );

      if (bleDevice && bleDevice.connected) {
        try {
          // Envoyer via Bluetooth MIDI
          this.app.bluetoothManager.sendMidiMessage(bleDevice.address, type, data);
          return true;
        } catch (error) {
          this.app.logger.error(`Failed to send MIDI message via Bluetooth to ${deviceName}: ${error.message}`);
          return false;
        }
      }
    }

    // Sinon, vérifier si c'est un périphérique réseau
    // Note: getDeviceList() uses device.ip as the ID for network devices,
    // so we must match by ip (primary) as well as name/address (fallback)
    if (this.app.networkManager) {
      const networkDevices = this.app.networkManager.getConnectedDevices();
      const networkDevice = networkDevices.find(d =>
        d.ip === deviceName || d.name === deviceName || d.address === deviceName
      );

      if (networkDevice && networkDevice.connected) {
        try {
          // Envoyer via Network MIDI (RTP-MIDI)
          this.app.networkManager.sendMidiMessage(networkDevice.ip, type, data);
          return true;
        } catch (error) {
          this.app.logger.error(`Failed to send MIDI message via Network to ${deviceName}: ${error.message}`);
          return false;
        }
      }
    }

    // Sinon, vérifier si c'est un périphérique série MIDI (GPIO)
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
   * Format: F0 7D 00 01 00 F7
   * @param {string} deviceName - Name of the device
   * @param {number} deviceId - MIDI device ID (unused in MidiMind protocol, kept for compatibility)
   * @returns {boolean} Success status
   */
  sendIdentityRequest(deviceName, deviceId = 0x7F) {
    // Debug: log available outputs
    this.app.logger.debug(`Looking for output: ${deviceName}`);
    this.app.logger.debug(`Available outputs: ${Array.from(this.outputs.keys()).join(', ')}`);

    const output = this.outputs.get(deviceName);
    if (!output) {
      // Check if device exists as input only
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
      // MidiMind Block 1 Identity Request SysEx message
      // Format: F0 7D 00 01 00 F7
      // Protocol: Custom SysEx (Educational/Development use)
      // Manufacturer ID: 0x00 (MidiMind)
      // Block ID: 0x01 (Identification)
      // Request flag: 0x00 (request)
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

  handleMidiMessage(deviceName, type, msg) {
    const timestamp = Date.now();

    // Parse SysEx Identity Reply if applicable
    if (type === 'sysex') {
      // Log ALL SysEx messages for debugging
      const bytes = Array.isArray(msg) ? msg : (msg.bytes || []);
      this.app.logger.info(`SysEx message received from ${deviceName}: ${bytes.map(b => '0x' + b.toString(16).toUpperCase()).join(' ')} (${bytes.length} bytes)`);

      const identityInfo = this.parseIdentityReply(msg);
      if (identityInfo) {
        this.app.logger.info(`Identity Reply received from ${deviceName}:`, identityInfo);

        // Broadcast parsed identity info to WebSocket clients
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
   * @param {Array} data - Array of 5 bytes (7-bit encoded)
   * @returns {number} 32-bit value
   */
  decode7BitTo32Bit(data) {
    let value = 0;
    value |= (data[0] & 0x7F);
    value |= (data[1] & 0x7F) << 7;
    value |= (data[2] & 0x7F) << 14;
    value |= (data[3] & 0x7F) << 21;
    value |= (data[4] & 0x07) << 28;  // Only 3 bits useful (bits 28-31)
    return value >>> 0;  // Convert to unsigned 32-bit
  }

  /**
   * Parse SysEx Identity Reply message using MidiMind Block 1 protocol
   * Format: F0 7D 00 01 01 <version> <deviceId[5]> <name[32]> <firmware[3]> <features[5]> F7
   * Total size: 52 bytes
   * @param {Array|Object} msg - SysEx message data (includes F0 and F7)
   * @returns {Object|null} Parsed identity info or null if not an identity reply
   */
  parseIdentityReply(msg) {
    // Convert to array if necessary
    const bytes = Array.isArray(msg) ? msg : (msg.bytes || []);

    // Debug: log received SysEx message
    this.app.logger.debug(`Received SysEx message: ${bytes.map(b => '0x' + b.toString(16).toUpperCase()).join(' ')}`);
    this.app.logger.debug(`Length: ${bytes.length}, First: 0x${bytes[0]?.toString(16).toUpperCase()}, Last: 0x${bytes[bytes.length - 1]?.toString(16).toUpperCase()}`);

    // Check for MidiMind Block 1 Identity Reply
    // Format: F0 7D 00 01 01 <version> <deviceId[5]> <name[32]> <firmware[3]> <features[5]> F7
    // Total size: 52 bytes
    if (bytes.length !== 52) {
      this.app.logger.debug(`Not a MidiMind Block 1 message (expected 52 bytes, got ${bytes.length})`);
      return null;
    }
    if (bytes[0] !== 0xF0) {
      this.app.logger.debug(`Not a SysEx message (first byte: 0x${bytes[0]?.toString(16).toUpperCase()})`);
      return null;
    }
    if (bytes[1] !== 0x7D) {
      this.app.logger.debug(`Not a Custom SysEx message (byte[1]: 0x${bytes[1]?.toString(16).toUpperCase()})`);
      return null;
    }
    if (bytes[2] !== 0x00) {
      this.app.logger.debug(`Not a MidiMind message (byte[2]: 0x${bytes[2]?.toString(16).toUpperCase()})`);
      return null;
    }
    if (bytes[3] !== 0x01) {
      this.app.logger.debug(`Not a Block 1 message (byte[3]: 0x${bytes[3]?.toString(16).toUpperCase()})`);
      return null;
    }
    if (bytes[4] !== 0x01) {
      this.app.logger.debug(`Not an Identity Reply (byte[4]: 0x${bytes[4]?.toString(16).toUpperCase()})`);
      return null;
    }
    if (bytes[51] !== 0xF7) {
      this.app.logger.debug(`Invalid SysEx end marker (byte[51]: 0x${bytes[51]?.toString(16).toUpperCase()})`);
      return null;
    }

    let pos = 5;

    // Parse Block Version (1 byte)
    const blockVersion = bytes[pos];
    pos += 1;

    // Parse Device ID (5 bytes, 7-bit encoded to 32-bit)
    const deviceIdBytes = bytes.slice(pos, pos + 5);
    const deviceId = this.decode7BitTo32Bit(deviceIdBytes);
    pos += 5;

    // Parse Device Name (32 bytes, null-terminated ASCII string)
    const nameBytes = bytes.slice(pos, pos + 32);
    let deviceName = '';
    for (let i = 0; i < nameBytes.length; i++) {
      if (nameBytes[i] === 0x00) break;  // Null terminator
      deviceName += String.fromCharCode(nameBytes[i]);
    }
    pos += 32;

    // Parse Firmware version (3 bytes: major, minor, patch)
    const firmwareMajor = bytes[pos];
    const firmwareMinor = bytes[pos + 1];
    const firmwarePatch = bytes[pos + 2];
    const firmwareVersion = `${firmwareMajor}.${firmwareMinor}.${firmwarePatch}`;
    pos += 3;

    // Parse Feature Flags (5 bytes, 7-bit encoded to 32-bit)
    const featureBytes = bytes.slice(pos, pos + 5);
    const features = this.decode7BitTo32Bit(featureBytes);
    pos += 5;

    // Decode feature flags
    const featureFlags = {
      noteMap: (features & 0x01) !== 0,           // Bit 0: Note Map support
      velocityCurves: (features & 0x02) !== 0,    // Bit 1: Velocity Curves support
      ccMapping: (features & 0x04) !== 0          // Bit 2: CC Mapping support
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
   * @param {number} id - Manufacturer ID (1 byte)
   * @returns {string} Manufacturer name
   */
  getManufacturerName(id) {
    const manufacturers = {
      0x01: 'Sequential Circuits',
      0x02: 'IDP',
      0x03: 'Voyetra/Octave-Plateau',
      0x04: 'Moog',
      0x05: 'Passport Designs',
      0x06: 'Lexicon',
      0x07: 'Kurzweil',
      0x08: 'Fender',
      0x09: 'Gulbransen',
      0x0A: 'AKG Acoustics',
      0x0B: 'Voyce Music',
      0x0C: 'Waveframe',
      0x0D: 'ADA',
      0x0E: 'Garfield Electronics',
      0x0F: 'Ensoniq',
      0x10: 'Oberheim',
      0x11: 'Apple',
      0x12: 'Grey Matter Response',
      0x13: 'Digidesign',
      0x14: 'Palmtree Instruments',
      0x15: 'JLCooper Electronics',
      0x16: 'Lowrey',
      0x17: 'Adams-Smith',
      0x18: 'E-mu',
      0x19: 'Harmony Systems',
      0x1A: 'ART',
      0x1B: 'Baldwin',
      0x1C: 'Eventide',
      0x1D: 'Inventronics',
      0x20: 'Clarity',
      0x21: 'Passac',
      0x22: 'SIEL',
      0x23: 'Synthaxe',
      0x25: 'Hohner',
      0x26: 'Twister',
      0x27: 'Solton',
      0x28: 'Jellinghaus MS',
      0x2F: 'Elka',
      0x36: 'Cheetah',
      0x3E: 'Waldorf',
      0x40: 'Kawai',
      0x41: 'Roland',
      0x42: 'Korg',
      0x43: 'Yamaha',
      0x44: 'Casio',
      0x47: 'Akai'
    };

    return manufacturers[id] || 'Unknown';
  }

  async createVirtualDevice(name) {
    if (this.virtualDevices.has(name)) {
      throw new Error(`Virtual device already exists: ${name}`);
    }

    const input = new easymidi.Input(name, true);
    const output = new easymidi.Output(name, true);

    // Setup input handlers
    input.on('noteon', (msg) => this.handleMidiMessage(name, 'noteon', msg));
    input.on('noteoff', (msg) => this.handleMidiMessage(name, 'noteoff', msg));
    input.on('cc', (msg) => this.handleMidiMessage(name, 'cc', msg));

    this.virtualDevices.set(name, { input, output });
    await this.updateDeviceMap();
    this.broadcastDeviceList();

    this.app.logger.info(`Virtual device created: ${name}`);
    return name;
  }

  async deleteVirtualDevice(name) {
    const vdev = this.virtualDevices.get(name);
    if (!vdev) {
      throw new Error(`Virtual device not found: ${name}`);
    }

    vdev.input.close();
    vdev.output.close();
    this.virtualDevices.delete(name);
    await this.updateDeviceMap();
    this.broadcastDeviceList();

    this.app.logger.info(`Virtual device deleted: ${name}`);
  }

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

  isSystemDevice(name) {
    // Filter out system MIDI Through ports and other virtual system devices
    const systemPatterns = [
      /^Midi Through/i,                    // ALSA MIDI Through ports
      /^Through Port/i,                    // macOS MIDI Through
      /^Microsoft GS Wavetable/i,          // Windows system synth
      /^RtMidi Output/i,                   // RtMidi virtual outputs (easymidi library)
      /^RtMidi Input/i,                    // RtMidi virtual inputs (easymidi library)
      /^RtMidi.*Client/i,                  // RtMidi client ports
      /^IAC Driver/i,                      // macOS Inter-Application Communication
      /^Bus \d+/i,                         // Generic virtual bus ports
      /^Midi.*Virtual/i,                   // Generic virtual MIDI ports
      /^CoreMIDI/i,                        // macOS CoreMIDI system ports
      /^FLUID Synth/i,                     // FluidSynth virtual ports
      /^Gervill/i,                         // Java Gervill soft synth
      /^LoopBe/i,                          // LoopBe virtual MIDI cable
      /^loopMIDI/i                         // loopMIDI virtual ports
    ];

    return systemPatterns.some(pattern => pattern.test(name));
  }

  /**
   * Get USB serial numbers for connected devices
   * Returns a map of device paths to serial numbers
   */
  async getUsbSerialNumbers() {
    const serialNumbers = {};

    try {
      // Method 1: Check /dev/serial/by-id/ (most reliable on Linux)
      const serialByIdPath = '/dev/serial/by-id';
      if (fs.existsSync(serialByIdPath)) {
        const devices = fs.readdirSync(serialByIdPath);

        for (const device of devices) {
          try {
            const fullPath = path.join(serialByIdPath, device);
            const realPath = fs.realpathSync(fullPath);

            // Extract serial number from device name
            // Format: usb-<vendor>_<product>_<serial>-if00-port0
            const match = device.match(/usb-(.+?)_(.+?)_([^-]+)/);
            if (match) {
              const serialNumber = match[3];
              serialNumbers[realPath] = serialNumber;
              serialNumbers[path.basename(realPath)] = serialNumber;

              this.app.logger.debug(`Found USB device: ${device} -> ${serialNumber}`);
            }
          } catch (error) {
            this.app.logger.warn(`Failed to read serial device ${device}: ${error.message}`);
          }
        }
      }

      // Method 2: Use udevadm for additional info (if available)
      try {
        // List all tty devices
        const ttyDevices = fs.readdirSync('/sys/class/tty')
          .filter(d => d.startsWith('ttyUSB') || d.startsWith('ttyACM'));

        for (const tty of ttyDevices) {
          try {
            const cmd = `udevadm info --name=/dev/${tty} --query=property 2>/dev/null | grep -E "ID_SERIAL_SHORT|ID_SERIAL"`;
            const output = execSync(cmd, { encoding: 'utf8', timeout: 1000 });

            const lines = output.split('\n');
            let serialShort = null;
            let serial = null;

            for (const line of lines) {
              if (line.startsWith('ID_SERIAL_SHORT=')) {
                serialShort = line.split('=')[1];
              } else if (line.startsWith('ID_SERIAL=')) {
                serial = line.split('=')[1];
              }
            }

            const serialNum = serialShort || serial;
            if (serialNum) {
              serialNumbers[`/dev/${tty}`] = serialNum;
              serialNumbers[tty] = serialNum;
              this.app.logger.debug(`Found USB serial for ${tty}: ${serialNum}`);
            }
          } catch (error) {
            // Ignore errors for individual devices
          }
        }
      } catch (error) {
        this.app.logger.warn(`udevadm not available: ${error.message}`);
      }

    } catch (error) {
      this.app.logger.warn(`Failed to get USB serial numbers: ${error.message}`);
    }

    return serialNumbers;
  }

  /**
   * Synchronous lookup of serial number from a pre-fetched serial numbers map
   */
  _findSerialNumberInMap(deviceName, serialNumbers) {
    for (const [devicePath, serialNumber] of Object.entries(serialNumbers)) {
      if (deviceName.includes(path.basename(devicePath)) ||
          devicePath.includes(deviceName.toLowerCase())) {
        return serialNumber;
      }
    }

    const cardMatch = deviceName.match(/card\s*(\d+)/i) || deviceName.match(/MIDI\s*(\d+)/i);
    if (cardMatch) {
      const cardNum = cardMatch[1];
      const keys = Object.keys(serialNumbers);
      if (keys.length > 0 && parseInt(cardNum) < keys.length) {
        return serialNumbers[keys[parseInt(cardNum)]];
      }
    }

    return null;
  }

  /**
   * Try to find USB serial number for a MIDI device
   */
  async findSerialNumberForDevice(deviceName) {
    const serialNumbers = await this.getUsbSerialNumbers();

    // Try to match device name with serial port
    // ALSA MIDI devices often contain the card number
    // Example: "USB MIDI Device MIDI 1" -> card 1

    for (const [devicePath, serialNumber] of Object.entries(serialNumbers)) {
      // Check if the device path or name matches
      if (deviceName.includes(path.basename(devicePath)) ||
          devicePath.includes(deviceName.toLowerCase())) {
        return serialNumber;
      }
    }

    // If no match found, try to extract card number and match
    const cardMatch = deviceName.match(/card\s*(\d+)/i) || deviceName.match(/MIDI\s*(\d+)/i);
    if (cardMatch) {
      const cardNum = cardMatch[1];
      // Try to find matching serial number (this is a heuristic)
      const keys = Object.keys(serialNumbers);
      if (keys.length > 0 && parseInt(cardNum) < keys.length) {
        return serialNumbers[keys[parseInt(cardNum)]];
      }
    }

    return null;
  }

  broadcastDeviceList() {
    if (this.app.wsServer) {
      this.app.wsServer.broadcast('device_list', {
        devices: this.getDeviceList()
      });
    }
  }

  // ==================== HOT-PLUG MONITORING ====================

  /**
   * Start automatic hot-plug monitoring
   */
  startHotPlugMonitoring() {
    if (this.hotPlugInterval) {
      return; // Already running
    }

    this.app.logger.info(`Starting hot-plug monitoring (check every ${this.hotPlugCheckIntervalMs}ms)`);

    // Initialize known devices
    this.knownInputs = new Set(easymidi.getInputs().filter(name => !this.isSystemDevice(name)));
    this.knownOutputs = new Set(easymidi.getOutputs().filter(name => !this.isSystemDevice(name)));

    // Start periodic checking
    this.hotPlugInterval = setInterval(() => {
      this.checkDeviceChanges();
    }, this.hotPlugCheckIntervalMs);
  }

  /**
   * Stop automatic hot-plug monitoring
   */
  stopHotPlugMonitoring() {
    if (this.hotPlugInterval) {
      clearInterval(this.hotPlugInterval);
      this.hotPlugInterval = null;
      this.app.logger.info('Hot-plug monitoring stopped');
    }
  }

  /**
   * Check for device changes without closing existing connections
   */
  async checkDeviceChanges() {
    try {
      // Get current system ports
      const currentInputs = new Set(easymidi.getInputs().filter(name => !this.isSystemDevice(name)));
      const currentOutputs = new Set(easymidi.getOutputs().filter(name => !this.isSystemDevice(name)));

      let hasChanges = false;

      // Check for new inputs
      for (const name of currentInputs) {
        if (!this.knownInputs.has(name)) {
          this.app.logger.info(`🔌 New MIDI input detected: ${name}`);
          try {
            this.addInput(name);
            this.knownInputs.add(name);
            hasChanges = true;
          } catch (error) {
            this.app.logger.error(`Failed to add new input ${name}: ${error.message}`);
          }
        }
      }

      // Check for removed inputs
      for (const name of this.knownInputs) {
        if (!currentInputs.has(name)) {
          this.app.logger.info(`🔌 MIDI input disconnected: ${name}`);
          const input = this.inputs.get(name);
          if (input) {
            try {
              input.removeAllListeners();
              input.close();
            } catch (error) {
              this.app.logger.warn(`Error closing disconnected input ${name}: ${error.message}`);
            }
            this.inputs.delete(name);
          }
          this.knownInputs.delete(name);
          hasChanges = true;
        }
      }

      // Check for new outputs
      for (const name of currentOutputs) {
        if (!this.knownOutputs.has(name)) {
          this.app.logger.info(`🔌 New MIDI output detected: ${name}`);
          try {
            this.addOutput(name);
            this.knownOutputs.add(name);
            hasChanges = true;
          } catch (error) {
            this.app.logger.error(`Failed to add new output ${name}: ${error.message}`);
          }
        }
      }

      // Check for removed outputs
      for (const name of this.knownOutputs) {
        if (!currentOutputs.has(name)) {
          this.app.logger.info(`🔌 MIDI output disconnected: ${name}`);
          const output = this.outputs.get(name);
          if (output) {
            try {
              output.close();
            } catch (error) {
              this.app.logger.warn(`Error closing disconnected output ${name}: ${error.message}`);
            }
            this.outputs.delete(name);
          }
          this.knownOutputs.delete(name);
          hasChanges = true;
        }
      }

      // If there were changes, update the device map and broadcast
      if (hasChanges) {
        await this.updateDeviceMap();
        this.broadcastDeviceList();
        this.app.logger.info(`Device list updated: ${this.devices.size} device(s)`);
      }

    } catch (error) {
      this.app.logger.error(`Error checking device changes: ${error.message}`);
    }
  }

  close() {
    // Stop hot-plug monitoring
    this.stopHotPlugMonitoring();

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
}

export default DeviceManager;