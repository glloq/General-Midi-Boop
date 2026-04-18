// src/midi/adapters/InMemoryBleAdapter.js
// In-memory implementation of BluetoothPort for tests (P1-4.5).
// No native dependency, no DBus, no hardware required.

import EventEmitter from 'events';
import { BLE_EVENTS } from '../ports/BluetoothPort.js';

export default class InMemoryBleAdapter extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {Array<{address: string, name: string, rssi?: number}>} [options.fixtures]
   *   Devices to surface via 'device-discovered' when startDiscovery is called.
   */
  constructor(options = {}) {
    super();
    this._fixtures = options.fixtures || [];
    this._discovered = new Map();
    this._connected = new Set();
    this._scanning = false;
    this._disposed = false;
    this._sentMidi = []; // tests can introspect
  }

  async startDiscovery() {
    this._assertAlive();
    this._scanning = true;
    for (const dev of this._fixtures) {
      this._discovered.set(dev.address, { ...dev });
      this.emit(BLE_EVENTS.DEVICE_DISCOVERED, { ...dev });
    }
  }

  async stopDiscovery() {
    this._scanning = false;
  }

  /**
   * Convenience method (parity with NobleBleAdapter): start discovery, wait
   * `durationMs`, stop discovery. Used by BluetoothManager to perform a
   * timed scan without owning the timer itself.
   */
  async scanOnce(durationMs = 0) {
    await this.startDiscovery();
    if (durationMs > 0) await new Promise((r) => setTimeout(r, durationMs));
    await this.stopDiscovery();
    return this.listDiscovered();
  }

  listDiscovered() {
    return Array.from(this._discovered.values()).map((d) => ({ ...d }));
  }

  async connect(address) {
    this._assertAlive();
    if (!this._discovered.has(address)) {
      throw new Error(`Device ${address} not discovered`);
    }
    this._connected.add(address);
    this.emit(BLE_EVENTS.CONNECTED, { address });
  }

  async disconnect(address) {
    this._connected.delete(address);
    this.emit(BLE_EVENTS.DISCONNECTED, { address });
  }

  async sendMidi(address, data) {
    if (!this._connected.has(address)) {
      throw new Error(`Device ${address} is not connected`);
    }
    if (!(data instanceof Uint8Array)) {
      throw new TypeError('sendMidi data must be a Uint8Array');
    }
    this._sentMidi.push({ address, data: new Uint8Array(data) });
  }

  isConnected(address) {
    return this._connected.has(address);
  }

  async dispose() {
    this._disposed = true;
    this._scanning = false;
    this._connected.clear();
    this._discovered.clear();
    this.removeAllListeners();
  }

  // ---- test helpers (not part of the port contract) ----

  /** Simulate an incoming BLE-MIDI packet from a connected device. */
  _injectIncoming(address, data) {
    if (!this._connected.has(address)) return;
    this.emit(BLE_EVENTS.MIDI_MESSAGE, { address, data: new Uint8Array(data) });
  }

  /** Snapshot of bytes the test sent through this adapter. */
  _getSentMidi() {
    return this._sentMidi.slice();
  }

  _assertAlive() {
    if (this._disposed) throw new Error('Adapter disposed');
  }
}
