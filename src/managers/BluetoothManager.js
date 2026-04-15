// ============================================================================
// src/managers/BluetoothManager.js
// ============================================================================
// Description:
//   Manages Bluetooth BLE MIDI devices
//   - Scan for available BLE devices
//   - Connect/disconnect BLE MIDI devices
//   - Manage paired devices
//   - NEW VERSION: Uses node-ble (Bluez/DBus) for FAST connections
// ============================================================================

import { createBluetooth } from 'node-ble';
import EventEmitter from 'events';
import MidiUtils from '../utils/MidiUtils.js';

class BluetoothManager extends EventEmitter {
  constructor(app) {
    super();
    this.app = app;
    this.scanning = false;
    this.devices = new Map(); // Map of device address -> device info
    this.connectedDevices = new Map(); // Map of address -> {device, gattServer, characteristic}
    this.pairedDevices = []; // List of paired devices

    this.BLE_MIDI_SERVICE_UUID = '03b80e5a-ede8-4b33-a751-6ce34ec4c700'; // BLE MIDI service UUID
    this.BLE_MIDI_CHARACTERISTIC_UUID = '7772e5db-3868-4112-a1a9-f2669d106bf3'; // MIDI I/O characteristic UUID

    // Initialize node-ble
    this.bluetooth = null;
    this.adapter = null;
    this.destroy = null;

    this._initPromise = this.initializeBluetooth();

    this.app.logger.info('BluetoothManager initialized (node-ble)');
  }

  async initializeBluetooth() {
    try {
      // Check if D-Bus system bus socket exists before trying to connect
      const fs = await import('fs');
      const dbusSocket = '/var/run/dbus/system_bus_socket';
      if (!fs.existsSync(dbusSocket)) {
        this.app.logger.warn(`Bluetooth unavailable: D-Bus system bus not found (${dbusSocket})`);
        this.emit('bluetooth:powered_off', { error: 'D-Bus not available' });
        return;
      }

      const { bluetooth, destroy } = createBluetooth();
      this.bluetooth = bluetooth;
      this.destroy = destroy;

      this.adapter = await bluetooth.defaultAdapter();

      const adapterName = await this.adapter.getName();
      this.app.logger.info(`Bluetooth adapter ready: ${adapterName}`);

      // Emit powered on event
      this.emit('bluetooth:powered_on');

    } catch (error) {
      this.app.logger.error(`Failed to initialize Bluetooth: ${error.message}`);
      this.emit('bluetooth:powered_off', { error: error.message });
    }
  }

  /**
   * Start BLE scan
   * @param {number} duration - Scan duration in seconds (0 = continuous scan)
   * @param {string} filter - Optional name filter
   * @returns {Promise<Array>} List of discovered devices
   */
  async startScan(duration = 5, filter = '') {
    if (this.scanning) {
      throw new Error('Scan already in progress');
    }

    // Ensure initialization is complete before scanning
    if (this._initPromise) await this._initPromise;

    if (!this.adapter) {
      throw new Error('Bluetooth adapter not ready');
    }

    try {
      this.scanning = true;
      this.devices.clear();

      const startTime = Date.now();
      this.app.logger.info(`[TIMING] Starting BLE scan for ${duration}s...`);

      // Start the scan
      const isDiscovering = await this.adapter.isDiscovering();
      if (!isDiscovering) {
        await this.adapter.startDiscovery();
      }

      // Wait for the scan duration
      await new Promise(resolve => setTimeout(resolve, duration * 1000));

      // Get discovered devices
      const deviceAddresses = await this.adapter.devices();
      this.app.logger.info(`[TIMING] Scan found ${deviceAddresses.length} devices in ${Date.now() - startTime}ms`);

      // Load info for each device
      for (const address of deviceAddresses) {
        try {
          const device = await this.adapter.getDevice(address);
          await this.handleDeviceDiscovered(device, address);
        } catch (error) {
          this.app.logger.debug(`Could not get device ${address}: ${error.message}`);
        }
      }

      // Stop the scan
      await this.adapter.stopDiscovery();
      this.scanning = false;

      // Apply the filter if needed
      let devicesArray = Array.from(this.devices.values());
      if (filter) {
        devicesArray = devicesArray.filter(d =>
          d.name.toLowerCase().includes(filter.toLowerCase())
        );
      }

      this.app.logger.info(`Scan complete: ${devicesArray.length} devices available`);

      // Remove deviceObject to avoid circular structure in JSON
      return devicesArray.map(({ deviceObject: _deviceObject, ...device }) => device);

    } catch (error) {
      this.scanning = false;
      this.app.logger.error(`Scan error: ${error.message}`);
      throw error;
    }
  }

  async handleDeviceDiscovered(device, address) {
    try {
      // Get device info with individual error handling
      let name = 'Unknown Device';
      let rssi = -100;
      let uuids = [];

      try {
        name = await device.getName();
        if (!name || name.trim() === '') {
          name = `BLE-${address.slice(-8)}`;
        }
      } catch (e) {
        this.app.logger.debug(`Cannot get name for ${address}: ${e.message}`);
        name = `BLE-${address.slice(-8)}`;
      }

      try {
        rssi = await device.getRSSI();
      } catch (e) {
        this.app.logger.debug(`Cannot get RSSI for ${address}: ${e.message}`);
      }

      try {
        uuids = await device.getUUIDs();
      } catch (e) {
        this.app.logger.debug(`Cannot get UUIDs for ${address}: ${e.message}`);
      }

      // Check if this is a BLE MIDI device
      const isMidiDevice = uuids && uuids.length > 0 && uuids.some(uuid =>
        uuid.toLowerCase().includes('03b80e5a') ||
        uuid.toLowerCase() === this.BLE_MIDI_SERVICE_UUID.toLowerCase()
      );

      const deviceInfo = {
        id: address,
        address: address,
        name: name,
        rssi: rssi,
        signal: this.rssiToSignalStrength(rssi),
        type: 'ble',
        isMidiDevice: isMidiDevice,
        serviceUuids: uuids || [],
        deviceObject: device
      };

      this.devices.set(address, deviceInfo);

      this.app.logger.info(`✓ BLE device discovered: ${name} (${address}) RSSI: ${rssi} dBm ${isMidiDevice ? '[MIDI]' : ''}`);

    } catch (error) {
      this.app.logger.error(`Error processing device ${address}: ${error.message}`);

      // ALWAYS add the device even on error so it remains visible
      this.devices.set(address, {
        id: address,
        address: address,
        name: `Device-${address.slice(-8)}`,
        rssi: -100,
        signal: 0,
        type: 'ble',
        isMidiDevice: false,
        serviceUuids: [],
        deviceObject: device
      });
    }
  }

  rssiToSignalStrength(rssi) {
    // Convert RSSI to approximate signal percentage
    // Typical RSSI: -100 dBm (very weak) to -30 dBm (very strong)
    const minRssi = -100;
    const maxRssi = -30;
    const clampedRssi = Math.max(minRssi, Math.min(maxRssi, rssi));
    const signal = Math.round(((clampedRssi - minRssi) / (maxRssi - minRssi)) * 100);
    return signal;
  }

  /**
   * Stop BLE scan
   */
  async stopScan() {
    if (!this.scanning) {
      return;
    }

    try {
      if (this.adapter) {
        const isDiscovering = await this.adapter.isDiscovering();
        if (isDiscovering) {
          await this.adapter.stopDiscovery();
        }
      }
      this.scanning = false;
      this.app.logger.info('BLE scan stopped');
    } catch (error) {
      this.app.logger.error(`Error stopping scan: ${error.message}`);
      this.scanning = false;
    }
  }

  /**
   * Connect a BLE device
   * @param {string} address - Device address
   * @returns {Promise<Object>} Connection info
   */
  async connect(address) {
    const startTime = Date.now();
    this.app.logger.info(`[TIMING] Starting connection to BLE device: ${address}`);

    // Ensure initialization is complete
    if (this._initPromise) await this._initPromise;

    if (!this.adapter) {
      throw new Error('Bluetooth adapter not ready');
    }

    let device = null;
    try {
      // Get the device
      const deviceInfo = this.devices.get(address);
      device = deviceInfo ? deviceInfo.deviceObject : null;

      if (!device) {
        this.app.logger.info(`[TIMING] Device not in cache, fetching from adapter...`);
        device = await this.adapter.getDevice(address);
      }

      // Connecter with timeout to prevent indefinite hang on BLE operations
      const BLE_CONNECT_TIMEOUT = 20000; // 20 seconds max for entire connection sequence

      const connectWithTimeout = async () => {
        const connectStart = Date.now();
        this.app.logger.info(`[TIMING] Calling device.connect()...`);

        await device.connect();

        this.app.logger.info(`[TIMING] ✅ device.connect() completed in ${Date.now() - connectStart}ms`);

        // Get the GATT server
        const gattStart = Date.now();
        const gattServer = await device.gatt();
        this.app.logger.info(`[TIMING] GATT server obtained in ${Date.now() - gattStart}ms`);

        // Get the MIDI service
        const serviceStart = Date.now();
        const service = await gattServer.getPrimaryService(this.BLE_MIDI_SERVICE_UUID);
        this.app.logger.info(`[TIMING] MIDI service found in ${Date.now() - serviceStart}ms`);

        // Get the MIDI I/O characteristic
        const charStart = Date.now();
        const characteristic = await service.getCharacteristic(this.BLE_MIDI_CHARACTERISTIC_UUID);
        this.app.logger.info(`[TIMING] MIDI characteristic found in ${Date.now() - charStart}ms`);

        return { gattServer, characteristic };
      };

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`BLE connection timeout after ${BLE_CONNECT_TIMEOUT}ms`)), BLE_CONNECT_TIMEOUT)
      );

      const { gattServer, characteristic } = await Promise.race([connectWithTimeout(), timeoutPromise]);

      // Subscribe to notifications - store handler reference for cleanup
      const midiHandler = buffer => {
        this.handleMidiData(address, buffer);
      };
      characteristic.on('valuechanged', midiHandler);
      await characteristic.startNotifications();

      const name = await device.getName();

      // Mark as connected
      const existingDevice = this.pairedDevices.find(d => d.address === address);
      if (existingDevice) {
        existingDevice.connected = true;
      } else {
        this.pairedDevices.push({
          address: address,
          name: name,
          type: 'ble',
          paired: true,
          connected: true
        });
      }

      // Store the connection (include handler reference for cleanup)
      this.connectedDevices.set(address, {
        device: device,
        gattServer: gattServer,
        characteristic: characteristic,
        midiHandler: midiHandler
      });

      const totalTime = Date.now() - startTime;
      this.app.logger.info(`[TIMING] 🚀 TOTAL CONNECTION TIME: ${totalTime}ms`);
      this.app.logger.info(`Connected to ${name} (${address}) via node-ble`);

      // Emit connection event
      this.emit('bluetooth:connected', {
        address: address,
        device_id: address,
        name: name
      });

      return {
        address: address,
        name: name,
        connected: true
      };

    } catch (error) {
      this.app.logger.error(`Failed to connect to ${address}: ${error.message}`);
      // Clean up partial connection on failure
      try {
        if (device) await device.disconnect().catch(() => {});
      } catch (_) { /* cleanup errors are non-critical during disconnect fallback */ }
      throw error;
    }
  }

  /**
   * Disconnect a device
   * @param {string} address - Device address
   */
  async disconnect(address) {
    const deviceConnection = this.connectedDevices.get(address);

    if (!deviceConnection) {
      throw new Error(`Device ${address} not connected`);
    }

    try {
      const { device, characteristic, midiHandler } = deviceConnection;

      // Remove valuechanged listener before stopping notifications
      if (characteristic) {
        if (midiHandler) {
          characteristic.removeListener('valuechanged', midiHandler);
        }
        await characteristic.stopNotifications();
      }

      // Disconnect
      await device.disconnect();

      this.connectedDevices.delete(address);

      // Update the status
      const pairedDevice = this.pairedDevices.find(d => d.address === address);
      if (pairedDevice) {
        pairedDevice.connected = false;
      }

      this.app.logger.info(`Disconnected from ${address}`);

      // Emit event
      this.emit('bluetooth:disconnected', {
        address: address,
        device_id: address
      });

    } catch (error) {
      this.app.logger.error(`Disconnect error for ${address}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Forget a device (unpair)
   * @param {string} address - Device address
   */
  async unpair(address) {
    // Disconnect first if connected
    if (this.connectedDevices.has(address)) {
      await this.disconnect(address);
    }

    // Remove from the paired list
    this.pairedDevices = this.pairedDevices.filter(d => d.address !== address);

    this.app.logger.info(`Unpaired device ${address}`);

    // Emit event
    this.emit('bluetooth:unpaired', {
      address: address
    });
  }

  /**
   * Alias for unpair() - for compatibility with CommandHandler
   */
  async forget(address) {
    return await this.unpair(address);
  }

  /**
   * Handle MIDI data received via BLE MIDI
   * BLE MIDI packet format (Apple BLE MIDI spec):
   *   Byte 0: Header byte (bit 7 = 1, bits 5-0 = timestamp high)
   *   Then one or more MIDI messages, each preceded by:
   *     Timestamp byte (bit 7 = 1, bits 6-0 = timestamp low)
   *     MIDI status byte + data bytes
   *   Running status is supported within a single packet.
   */
  handleMidiData(address, buffer) {
    try {
      const data = Array.from(buffer);

      if (data.length < 3) {
        return; // Minimum: header + timestamp + 1 status byte
      }

      // Byte 0: Header (bit 7 must be set)
      if (!(data[0] & 0x80)) {
        this.app.logger.debug(`Invalid BLE MIDI header from ${address}: 0x${data[0].toString(16)}`);
        return;
      }

      // Parse MIDI messages from the packet
      let i = 1;
      let runningStatus = 0;

      while (i < data.length) {
        // Check for timestamp byte (bit 7 set)
        if (data[i] & 0x80) {
          // Could be timestamp byte or a MIDI status byte following a timestamp
          // Timestamp bytes have bit 7 set AND are followed by MIDI data
          // If the next byte is a MIDI status byte (>= 0x80), this is a timestamp
          if (i + 1 < data.length && data[i + 1] >= 0x80 && data[i + 1] < 0xF8) {
            // Timestamp byte followed by status byte
            i++; // Skip timestamp
            runningStatus = data[i]; // New status
            i++; // Move past status
          } else if (i + 1 < data.length && data[i + 1] < 0x80) {
            // Timestamp byte followed by data byte (running status)
            i++; // Skip timestamp
          } else {
            i++; // Skip unrecognized byte
            continue;
          }
        }

        // Now read MIDI data using current status
        if (runningStatus === 0) {
          // No running status yet, check if current byte is a status
          if (i < data.length && data[i] >= 0x80 && data[i] <= 0xEF) {
            runningStatus = data[i];
            i++;
          } else {
            i++;
            continue;
          }
        }

        // Determine message length from status
        const command = runningStatus & 0xF0;
        let msgLength;
        if (command === 0xC0 || command === 0xD0) {
          msgLength = 1; // 1 data byte
        } else if (command >= 0x80 && command <= 0xE0) {
          msgLength = 2; // 2 data bytes
        } else {
          i++;
          continue; // Skip system messages in BLE MIDI for now
        }

        if (i + msgLength > data.length) break;

        const midiBytes = [runningStatus, ...data.slice(i, i + msgLength)];
        i += msgLength;

        // Forward parsed bytes to the MIDI system
        this.emit('midi:data', {
          address: address,
          data: midiBytes
        });
      }

    } catch (error) {
      this.app.logger.error(`Error processing BLE MIDI data: ${error.message}`);
    }
  }

  /**
   * Send MIDI data to a device
   * Apple BLE MIDI packet format:
   *   Byte 0: Header byte (bit 7 = 1, bits 5-0 = timestamp high 6 bits)
   *   For each MIDI message:
   *     Timestamp byte (bit 7 = 1, bits 6-0 = timestamp low 7 bits)
   *     MIDI status byte + data bytes
   */
  async sendMidiData(address, midiData) {
    const deviceConnection = this.connectedDevices.get(address);

    if (!deviceConnection || !deviceConnection.characteristic) {
      throw new Error(`Device ${address} not connected or MIDI not configured`);
    }

    try {
      // Build Apple BLE MIDI compliant packet
      // Use millisecond timestamp (13-bit, wraps at 8192ms)
      const now = Date.now() % 8192;
      const timestampHigh = (now >> 7) & 0x3F;
      const timestampLow = now & 0x7F;

      // Header byte: bit 7 set + timestamp high bits
      const headerByte = 0x80 | timestampHigh;
      // Timestamp byte: bit 7 set + timestamp low bits
      const tsByte = 0x80 | timestampLow;

      const bleData = Buffer.from([headerByte, tsByte, ...midiData]);

      await deviceConnection.characteristic.writeValue(bleData);

      this.app.logger.debug(`MIDI sent to ${address}:`, midiData);

    } catch (error) {
      this.app.logger.error(`Send MIDI error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Send a MIDI message (easymidi format) to a Bluetooth device
   * @param {string} address - BLE address of the device
   * @param {string} type - Message type ('noteon', 'noteoff', 'cc', etc.)
   * @param {object} data - Message data ({channel, note, velocity} or {channel, controller, value})
   */
  async sendMidiMessage(address, type, data) {
    // Convert easymidi format to raw MIDI bytes
    const midiBytes = this.convertToMidiBytes(type, data);

    if (midiBytes) {
      await this.sendMidiData(address, midiBytes);
    } else {
      this.app.logger.warn(`Unsupported MIDI message type: ${type}`);
    }
  }

  /**
   * Convert an easymidi message to MIDI bytes
   * @param {string} type - Message type
   * @param {object} data - Message data
   * @returns {Array<number>} MIDI bytes
   */
  convertToMidiBytes(type, data) {
    return MidiUtils.convertToMidiBytes(type, data);
  }

  /**
   * Get the list of paired devices
   */
  getPairedDevices() {
    return this.pairedDevices.map(device => ({
      ...device,
      connected: this.connectedDevices.has(device.address)
    }));
  }

  /**
   * Check if a device is connected
   */
  isConnected(address) {
    return this.connectedDevices.has(address);
  }

  /**
   * Get the Bluetooth status
   */
  getStatus() {
    return {
      enabled: this.adapter !== null,
      state: this.adapter ? 'poweredOn' : 'unknown',
      scanning: this.scanning,
      devicesFound: this.devices.size,
      connectedDevices: this.connectedDevices.size,
      pairedDevices: this.pairedDevices.length
    };
  }

  /**
   * Clean up and release resources
   */
  async cleanup() {
    try {
      // Disconnect all devices
      for (const address of this.connectedDevices.keys()) {
        await this.disconnect(address).catch(() => {});
      }

      // Stop scan if active
      await this.stopScan();

      // Release node-ble
      if (this.destroy) {
        this.destroy();
      }

      this.app.logger.info('BluetoothManager cleaned up');

    } catch (error) {
      this.app.logger.error(`Cleanup error: ${error.message}`);
    }
  }
}

export default BluetoothManager;
