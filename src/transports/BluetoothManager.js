/**
 * @file src/transports/BluetoothManager.js
 * @description High-level Bluetooth BLE MIDI device manager built on
 * top of a {@link BluetoothPort} adapter (P1-4.5c — ports/adapters).
 *
 * Adapter selection:
 *   - Default in production: {@link NobleBleAdapter} (wraps `node-ble`).
 *   - In tests: {@link InMemoryBleAdapter} can be injected via
 *     `options.port` for hermetic unit tests.
 *
 * The public API (`startScan` / `stopScan` / `connect` / `disconnect` /
 * `sendMessage` / `getStatus` / ...) is preserved for existing callers
 * (BluetoothCommands, DeviceManager, MidiClockGenerator).
 */

import EventEmitter from 'events';
import MidiUtils from '../utils/MidiUtils.js';
import NobleBleAdapter from '../midi/adapters/NobleBleAdapter.js';
import { BLE_EVENTS } from '../midi/ports/BluetoothPort.js';

/** Data-byte counts for MIDI System Common messages (status → data bytes). */
const BLE_SYSTEM_COMMON_DATA = { 0xf1: 1, 0xf2: 2, 0xf3: 1, 0xf6: 0 };
/** Max reassembled BLE SysEx size before the frame is abandoned. */
const MAX_BLE_SYSEX = 65536;

class BluetoothManager extends EventEmitter {
  /**
   * @param {object} deps - Service-container facade. Only `logger`
   *   is read from it.
   * @param {object} [options]
   * @param {object} [options.port] - BluetoothPort adapter. Defaults to a
   *   new NobleBleAdapter. Tests inject InMemoryBleAdapter here.
   */
  constructor(deps, options = {}) {
    super();
    // BluetoothManager only ever read `logger` off the legacy
    // `this.app` facade — destructure it explicitly.
    this.logger = deps.logger;
    this.scanning = false;
    this.devices = new Map(); // address → enriched device info
    this.connectedDevices = new Map(); // address → { name }
    this.pairedDevices = []; // persistent list

    this._port = options.port || new NobleBleAdapter({ logger: this.logger });

    this._wirePortEvents();

    // Kick off port initialisation best-effort (the port's methods are
    // also safe to call before _init completes — they await it lazily).
    this._initPromise = this._initializePort();

    this.logger.info('BluetoothManager initialized (port-based)');
  }

  // --------------------------------------------------------------------------
  // Port wiring
  // --------------------------------------------------------------------------

  _wirePortEvents() {
    this._port.on(BLE_EVENTS.DEVICE_DISCOVERED, (desc) => {
      const { address, name, rssi, uuids, isMidiDevice } = desc || {};
      if (!address) return;
      this.devices.set(address, {
        id: address,
        address,
        name: name || `BLE-${address.slice(-8)}`,
        rssi: rssi ?? -100,
        signal: this.rssiToSignalStrength(rssi ?? -100),
        type: 'ble',
        isMidiDevice: isMidiDevice ?? false,
        serviceUuids: uuids || []
      });
    });

    this._port.on(BLE_EVENTS.CONNECTED, ({ address }) => {
      const device = this.devices.get(address);
      const name = device?.name || this._pairedName(address) || address;
      this.connectedDevices.set(address, { name });
      const existing = this.pairedDevices.find((d) => d.address === address);
      if (existing) {
        existing.connected = true;
      } else {
        this.pairedDevices.push({
          address,
          name,
          type: 'ble',
          paired: true,
          connected: true
        });
      }
      this.emit('bluetooth:connected', { address, device_id: address, name });
    });

    this._port.on(BLE_EVENTS.DISCONNECTED, ({ address }) => {
      this.connectedDevices.delete(address);
      const existing = this.pairedDevices.find((d) => d.address === address);
      if (existing) existing.connected = false;
      this.emit('bluetooth:disconnected', { address, device_id: address });
    });

    this._port.on(BLE_EVENTS.MIDI_MESSAGE, ({ address, data }) => {
      this._handleIncomingMidi(address, data);
    });

    this._port.on(BLE_EVENTS.POWERED_OFF, (payload) => {
      const reason = payload?.reason || payload?.error || 'unknown';
      this.emit('bluetooth:powered_off', { error: reason });
    });
  }

  _pairedName(address) {
    return this.pairedDevices.find((d) => d.address === address)?.name;
  }

  async _initializePort() {
    // Yield one microtask so callers subscribing to 'bluetooth:powered_on'
    // right after construction still catch the event.
    await Promise.resolve();
    // The port handles its own init (lazy). Calling _init up-front lets
    // the manager surface the historical 'bluetooth:powered_on' event at
    // startup without waiting for the first user-triggered operation.
    if (typeof this._port._init !== 'function') {
      this.emit('bluetooth:powered_on');
      return;
    }
    try {
      await this._port._init();
      this.emit('bluetooth:powered_on');
    } catch (err) {
      this.logger.error(`Failed to initialize Bluetooth: ${err.message}`);
      // POWERED_OFF event may already have been emitted by the port;
      // no need to double-emit here.
    }
  }

  // --------------------------------------------------------------------------
  // Scanning
  // --------------------------------------------------------------------------

  /**
   * Start BLE scan.
   * @param {number} duration - Scan duration in seconds
   * @param {string} filter - Optional name filter
   * @returns {Promise<Array>} List of discovered devices
   */
  async startScan(duration = 5, filter = '') {
    if (this.scanning) {
      throw new Error('Scan already in progress');
    }
    if (this._initPromise) await this._initPromise;

    try {
      this.scanning = true;
      this.devices.clear();

      const startTime = Date.now();
      this.logger.info(`[TIMING] Starting BLE scan for ${duration}s...`);

      await this._runPortScan(duration * 1000);

      this.logger.info(`[TIMING] Scan found ${this.devices.size} devices in ${Date.now() - startTime}ms`);

      let devicesArray = Array.from(this.devices.values());
      if (filter) {
        devicesArray = devicesArray.filter((d) =>
          d.name.toLowerCase().includes(filter.toLowerCase())
        );
      }
      this.logger.info(`Scan complete: ${devicesArray.length} devices available`);
      return devicesArray;
    } catch (error) {
      this.logger.error(`Scan error: ${error.message}`);
      throw error;
    } finally {
      this.scanning = false;
    }
  }

  async _runPortScan(durationMs) {
    // Prefer the convenience helper exposed by both bundled adapters
    // (NobleBleAdapter.scanOnce, InMemoryBleAdapter.scanOnce).
    if (typeof this._port.scanOnce === 'function') {
      await this._port.scanOnce(durationMs);
      return;
    }
    // Fallback for minimal port implementations:
    await this._port.startDiscovery();
    await new Promise((r) => setTimeout(r, durationMs));
    for (const desc of this._port.listDiscovered()) {
      if (!this.devices.has(desc.address)) {
        this.devices.set(desc.address, {
          id: desc.address,
          address: desc.address,
          name: desc.name || `BLE-${desc.address.slice(-8)}`,
          rssi: desc.rssi ?? -100,
          signal: this.rssiToSignalStrength(desc.rssi ?? -100),
          type: 'ble',
          isMidiDevice: desc.isMidiDevice ?? false,
          serviceUuids: desc.uuids || []
        });
      }
    }
    await this._port.stopDiscovery();
  }

  rssiToSignalStrength(rssi) {
    const minRssi = -100;
    const maxRssi = -30;
    const clampedRssi = Math.max(minRssi, Math.min(maxRssi, rssi));
    return Math.round(((clampedRssi - minRssi) / (maxRssi - minRssi)) * 100);
  }

  /**
   * Stop BLE scan.
   */
  async stopScan() {
    if (!this.scanning) return;
    try {
      await this._port.stopDiscovery();
      this.logger.info('BLE scan stopped');
    } catch (error) {
      this.logger.error(`Error stopping scan: ${error.message}`);
    } finally {
      this.scanning = false;
    }
  }

  // --------------------------------------------------------------------------
  // Connection
  // --------------------------------------------------------------------------

  /**
   * Connect to a BLE device.
   * @returns {Promise<{address, name, connected}>}
   */
  async connect(address) {
    const startTime = Date.now();
    this.logger.info(`[TIMING] Starting connection to BLE device: ${address}`);

    if (this._initPromise) await this._initPromise;

    try {
      await this._port.connect(address);

      const name =
        this.devices.get(address)?.name ||
        this._pairedName(address) ||
        address;

      const totalTime = Date.now() - startTime;
      this.logger.info(`[TIMING] 🚀 TOTAL CONNECTION TIME: ${totalTime}ms`);
      this.logger.info(`Connected to ${name} (${address}) via port`);

      return { address, name, connected: true };
    } catch (error) {
      this.logger.error(`Failed to connect to ${address}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Disconnect a device.
   */
  async disconnect(address) {
    if (!this._port.isConnected(address)) {
      throw new Error(`Device ${address} not connected`);
    }
    try {
      await this._port.disconnect(address);
      this.logger.info(`Disconnected from ${address}`);
    } catch (error) {
      this.logger.error(`Disconnect error for ${address}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Unpair a device (disconnect first, then remove from paired list).
   */
  async unpair(address) {
    if (this._port.isConnected(address)) {
      await this.disconnect(address);
    }
    this.pairedDevices = this.pairedDevices.filter((d) => d.address !== address);
    this.logger.info(`Unpaired device ${address}`);
    this.emit('bluetooth:unpaired', { address });
  }

  /**
   * Alias for unpair() — expected by CommandHandler.
   */
  async forget(address) {
    return this.unpair(address);
  }

  // --------------------------------------------------------------------------
  // MIDI I/O
  // --------------------------------------------------------------------------

  /**
   * Handle an incoming BLE-MIDI packet from the port.
   * Parses the Apple BLE-MIDI framing and emits 'midi:data' per message.
   * BLE MIDI packet format (Apple BLE MIDI spec):
   *   Byte 0: Header byte (bit 7 = 1, bits 5-0 = timestamp high)
   *   Then one or more MIDI messages, each preceded by:
   *     Timestamp byte (bit 7 = 1, bits 6-0 = timestamp low)
   *     MIDI status byte + data bytes
   *   Running status is supported within a single packet.
   */
  _handleIncomingMidi(address, buffer) {
    try {
      const data = Array.from(buffer);
      if (data.length < 2) return;
      if (!(data[0] & 0x80)) {
        this.logger.debug(`Invalid BLE MIDI header from ${address}: 0x${data[0].toString(16)}`);
        return;
      }

      // Persistent per-device state so a SysEx spanning multiple BLE
      // notifications is reassembled correctly (audit P1 — "BLE parser
      // incomplete"). Running status is intentionally NOT carried across
      // packets (the Apple BLE-MIDI spec restarts it per packet).
      const state = this._getBleParseState(address);
      let i = 1; // byte 0 is the packet header (timestamp high)
      let running = 0;

      const emit = (bytes) => this.emit('midi:data', { address, data: bytes });

      // Consume SysEx payload bytes until F7 / interruption / end-of-packet.
      const consumeSysExPayload = () => {
        while (i < data.length) {
          const b = data[i];
          if (b === 0xf7) {
            state.sysex.push(0xf7);
            i++;
            emit(state.sysex);
            state.sysex = null;
            return;
          }
          if (b & 0x80) return; // timestamp / status interrupts payload
          if (state.sysex.length >= MAX_BLE_SYSEX) {
            // Overflow guard: abandon the frame.
            state.sysex = null;
            i++;
            return;
          }
          state.sysex.push(b);
          i++;
        }
      };

      while (i < data.length) {
        // A high-bit byte here is a BLE timestamp, a status byte, or a
        // System Real-Time message.
        if (data[i] & 0x80) {
          const b = data[i];
          if (b >= 0xf8) {
            // System Real-Time — valid anywhere, including inside a SysEx.
            emit([b]);
            i++;
            continue;
          }
          // Otherwise treat this high-bit byte as a timestamp and advance;
          // the following byte carries the status / data.
          i++;
          if (i >= data.length) break;
        }

        // Resume an in-progress SysEx from a previous notification.
        if (state.sysex) {
          consumeSysExPayload();
          continue;
        }

        let status;
        if (data[i] & 0x80) {
          status = data[i];
          i++;
        } else if (running) {
          status = running; // running status: data byte without a new status
        } else {
          i++; // stray data byte with no status context
          continue;
        }

        if (status === 0xf0) {
          state.sysex = [0xf0];
          running = 0;
          consumeSysExPayload();
          continue;
        }
        if (status >= 0xf8) {
          emit([status]);
          continue;
        }
        if (status >= 0xf1 && status <= 0xf6) {
          const len = BLE_SYSTEM_COMMON_DATA[status] ?? 0;
          if (i + len > data.length) break;
          emit([status, ...data.slice(i, i + len)]);
          i += len;
          running = 0; // System Common cancels running status
          continue;
        }

        // Channel voice message.
        const command = status & 0xf0;
        const msgLength = command === 0xc0 || command === 0xd0 ? 1 : 2;
        if (i + msgLength > data.length) break;
        emit([status, ...data.slice(i, i + msgLength)]);
        i += msgLength;
        running = status;
      }
    } catch (error) {
      this.logger.error(`Error processing BLE MIDI data: ${error.message}`);
    }
  }

  /**
   * Lazily create/return the per-device BLE parse state (SysEx reassembly
   * buffer) keyed by address.
   * @param {string} address
   * @returns {{ sysex: ?number[] }}
   * @private
   */
  _getBleParseState(address) {
    if (!this._bleParseState) this._bleParseState = new Map();
    let state = this._bleParseState.get(address);
    if (!state) {
      state = { sysex: null };
      this._bleParseState.set(address, state);
    }
    return state;
  }

  /**
   * Send raw MIDI bytes to a connected device.
   * Wraps the payload in the Apple BLE MIDI framing.
   */
  async sendMidiData(address, midiData) {
    if (!this._port.isConnected(address)) {
      throw new Error(`Device ${address} not connected or MIDI not configured`);
    }
    try {
      const now = Date.now() % 8192;
      const timestampHigh = (now >> 7) & 0x3F;
      const timestampLow = now & 0x7F;
      const headerByte = 0x80 | timestampHigh;
      const tsByte = 0x80 | timestampLow;

      const bleFrame = new Uint8Array(midiData.length + 2);
      bleFrame[0] = headerByte;
      bleFrame[1] = tsByte;
      bleFrame.set(midiData, 2);

      await this._port.sendMidi(address, bleFrame);
      this.logger.debug(`MIDI sent to ${address}:`, midiData);
    } catch (error) {
      this.logger.error(`Send MIDI error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Send an easymidi-style message to a device.
   */
  async sendMidiMessage(address, type, data) {
    const midiBytes = this.convertToMidiBytes(type, data);
    if (midiBytes) {
      await this.sendMidiData(address, midiBytes);
    } else {
      this.logger.warn(`Unsupported MIDI message type: ${type}`);
    }
  }

  convertToMidiBytes(type, data) {
    return MidiUtils.convertToMidiBytes(type, data);
  }

  // --------------------------------------------------------------------------
  // Status / lifecycle
  // --------------------------------------------------------------------------

  getPairedDevices() {
    return this.pairedDevices.map((device) => ({
      ...device,
      connected: this._port.isConnected(device.address)
    }));
  }

  isConnected(address) {
    return this._port.isConnected(address);
  }

  getStatus() {
    const ready = this._port._ready !== false;
    return {
      enabled: ready,
      available: ready,
      state: ready ? 'poweredOn' : 'unknown',
      scanning: this.scanning,
      devicesFound: this.devices.size,
      connectedDevices: this.connectedDevices.size,
      pairedDevices: this.pairedDevices.length
    };
  }

  /**
   * Power on the underlying BLE adapter (BlueZ Powered=true). Required by
   * the `ble_power_on` API command. Falls back to a no-op when the port
   * does not implement the capability (e.g. older test adapters).
   */
  async powerOn() {
    if (this._initPromise) await this._initPromise.catch(() => {});
    let result = { powered: true };
    if (typeof this._port.powerOn === 'function') {
      result = await this._port.powerOn();
    }
    this.emit('bluetooth:powered_on', result);
    return result;
  }

  /**
   * Power off the underlying BLE adapter. Counterpart of {@link powerOn}.
   */
  async powerOff() {
    if (this._initPromise) await this._initPromise.catch(() => {});
    let result = { powered: false };
    if (typeof this._port.powerOff === 'function') {
      result = await this._port.powerOff();
    }
    this.emit('bluetooth:powered_off', result);
    return result;
  }

  async cleanup() {
    try {
      for (const address of Array.from(this.connectedDevices.keys())) {
        await this.disconnect(address).catch(() => {});
      }
      await this.stopScan().catch(() => {});
      if (typeof this._port.dispose === 'function') {
        await this._port.dispose();
      }
      this.logger.info('BluetoothManager cleaned up');
    } catch (error) {
      this.logger.error(`Cleanup error: ${error.message}`);
    }
  }
}

export default BluetoothManager;
