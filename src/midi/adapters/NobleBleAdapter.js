/**
 * @file src/midi/adapters/NobleBleAdapter.js
 * @description Production {@link BluetoothPort} adapter wrapping
 * `node-ble` (BlueZ over DBus on Linux). Mirrors the surface
 * established in P1-4.5 so {@link BluetoothManager} can migrate to
 * dependency injection in a follow-up lot.
 *
 * The existing `src/transports/BluetoothManager.js` keeps its direct
 * `node-ble` usage for now — this adapter is additive infrastructure.
 *
 * TODO: have BluetoothManager consume this adapter via DI so the
 * native dependency lives in one place only.
 */

import EventEmitter from 'events';
import { existsSync } from 'fs';
import { BLE_EVENTS } from '../ports/BluetoothPort.js';

/** Standard BLE-MIDI service UUID (assigned by Apple). */
const BLE_MIDI_SERVICE_UUID = '03b80e5a-ede8-4b33-a751-6ce34ec4c700';
/** Standard BLE-MIDI data characteristic UUID. */
const BLE_MIDI_CHARACTERISTIC_UUID = '7772e5db-3868-4112-a1a9-f2669d106bf3';
/** Probed at init to fail fast when DBus is not available. */
const DBUS_SYSTEM_SOCKET = '/var/run/dbus/system_bus_socket';

export default class NobleBleAdapter extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {object} [options.logger]
   * @param {Function} [options.createBluetooth] - Override for tests.
   *   Signature matches `createBluetooth` from `node-ble`.
   */
  constructor(options = {}) {
    super();
    this.logger = options.logger || { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    this._createBluetooth = options.createBluetooth || null;

    this._bluetooth = null;
    this._adapter = null;
    this._destroy = null;
    this._ready = false;
    this._disposed = false;

    this._discovered = new Map(); // address → descriptor
    this._connections = new Map(); // address → { device, gatt, characteristic, handler }
  }

  async _init() {
    if (this._ready || this._disposed) return;

    if (!existsSync(DBUS_SYSTEM_SOCKET)) {
      this.emit(BLE_EVENTS.POWERED_OFF, { reason: 'D-Bus system bus not available' });
      throw new Error('D-Bus system bus not available');
    }

    if (!this._createBluetooth) {
      // Lazy import so CI environments without node-ble can still load the module.
      const mod = await import('node-ble');
      this._createBluetooth = mod.createBluetooth;
    }

    const { bluetooth, destroy } = this._createBluetooth();
    this._bluetooth = bluetooth;
    this._destroy = destroy;
    this._adapter = await bluetooth.defaultAdapter();

    // Many Linux setups (Raspberry Pi defaults, headless installs) leave the
    // BlueZ adapter at Powered=off after boot. Discovery silently finds
    // nothing in that state, so power it up before we report ready.
    try {
      const powered = await this._adapter.isPowered();
      if (!powered) {
        await this._adapter.setPowered(true);
        this.logger.info('BLE adapter powered on automatically');
      }
    } catch (e) {
      this.logger.warn(`Could not power on BLE adapter: ${e.message}`);
    }

    this._ready = true;
  }

  async startDiscovery() {
    this._assertAlive();
    await this._init();

    // Limit to BLE transport so BR/EDR-only neighbours don't crowd out
    // BLE-MIDI advertisers on adapters that struggle with dual-mode auto.
    // Failure to set the filter is non-fatal — fall through to default scan.
    if (typeof this._adapter.setDiscoveryFilter === 'function') {
      try {
        await this._adapter.setDiscoveryFilter({ transport: 'le' });
      } catch (e) {
        this.logger.debug(`setDiscoveryFilter(le) failed: ${e.message}`);
      }
    }

    const isDiscovering = await this._adapter.isDiscovering();
    if (!isDiscovering) {
      await this._adapter.startDiscovery();
    }
  }

  async powerOn() {
    this._assertAlive();
    await this._init();
    await this._adapter.setPowered(true);
    return { powered: true };
  }

  async powerOff() {
    this._assertAlive();
    await this._init();
    await this._adapter.setPowered(false);
    return { powered: false };
  }

  async isPowered() {
    if (!this._ready) return false;
    try {
      return await this._adapter.isPowered();
    } catch {
      return false;
    }
  }

  async stopDiscovery() {
    if (!this._ready) return;
    try {
      const isDiscovering = await this._adapter.isDiscovering();
      if (isDiscovering) await this._adapter.stopDiscovery();
    } catch (e) {
      this.logger.debug(`stopDiscovery: ${e.message}`);
    }
  }

  listDiscovered() {
    return Array.from(this._discovered.values()).map((d) => ({ ...d }));
  }

  /**
   * Scan once and capture the current device list. Equivalent to
   * BluetoothManager.startScan(duration) behaviour : surface results via
   * 'device-discovered' events.
   *
   * Event payload includes the optional metadata fields `rssi`, `uuids`
   * and `isMidiDevice` (additive, callers may ignore them).
   */
  async scanOnce(durationMs = 5000) {
    await this.startDiscovery();

    // Reset the snapshot for this scan so stale entries from a previous
    // scan don't leak into the result (BluetoothManager already clears
    // its own map, but the port's snapshot is the source of truth).
    this._discovered.clear();

    // On Raspberry Pi and similar Linux systems, BlueZ needs a short moment
    // after StartDiscovery() before advertisement data starts populating the
    // managed-objects tree.  Without this pause the first harvest() call
    // always returns an empty list and devices discovered in the first ~500 ms
    // are silently dropped.
    await new Promise((r) => setTimeout(r, 500));

    // Poll BlueZ's device tree every ~750ms so we surface devices as soon
    // as they show up rather than only at the very end of the window.
    // BlueZ populates its tree as advertisements arrive — polling is the
    // simplest way to bridge that into our event stream without depending
    // on private DBus signal subscriptions.
    const pollInterval = 750;
    const seen = new Set();
    const harvest = async () => {
      let addresses = [];
      try {
        addresses = await this._adapter.devices();
      } catch (e) {
        this.logger.warn(`BLE harvest: adapter.devices() failed: ${e.message}`);
        return;
      }
      for (const address of addresses) {
        if (seen.has(address)) continue;
        seen.add(address);
        try {
          const device = await this._adapter.getDevice(address);
          const name = await device.getName().catch(() => address);
          const rssi = await device.getRSSI().catch(() => -100);
          const uuids = await device.getUUIDs().catch(() => []);
          const isMidiDevice = Array.isArray(uuids) && uuids.some((u) =>
            typeof u === 'string' &&
            (u.toLowerCase().includes('03b80e5a') ||
             u.toLowerCase() === BLE_MIDI_SERVICE_UUID.toLowerCase())
          );
          const descriptor = { address, name, rssi, uuids, isMidiDevice };
          this._discovered.set(address, descriptor);
          this.emit(BLE_EVENTS.DEVICE_DISCOVERED, { ...descriptor });
        } catch (e) {
          // Re-allow a retry next tick: the device might just not be
          // fully populated in BlueZ yet.
          seen.delete(address);
          this.logger.warn(`BLE harvest: could not read device ${address}: ${e.message}`);
        }
      }
    };

    const deadline = Date.now() + durationMs;
    // First harvest immediately so we surface devices BlueZ already had cached.
    await harvest();
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      await new Promise((r) => setTimeout(r, Math.min(pollInterval, remaining)));
      await harvest();
    }

    await this.stopDiscovery();
    return this.listDiscovered();
  }

  async connect(address) {
    this._assertAlive();
    await this._init();

    if (this._connections.has(address)) return;

    let device;
    try {
      device = await this._adapter.getDevice(address);
    } catch {
      throw new Error(`Device ${address} not discovered`);
    }

    await device.connect();
    const gatt = await device.gatt();
    const service = await gatt.getPrimaryService(BLE_MIDI_SERVICE_UUID);
    const characteristic = await service.getCharacteristic(BLE_MIDI_CHARACTERISTIC_UUID);

    const handler = (buffer) => {
      this.emit(BLE_EVENTS.MIDI_MESSAGE, { address, data: new Uint8Array(buffer) });
    };
    characteristic.on('valuechanged', handler);
    await characteristic.startNotifications();

    this._connections.set(address, { device, gatt, characteristic, handler });
    this.emit(BLE_EVENTS.CONNECTED, { address });
  }

  async disconnect(address) {
    const entry = this._connections.get(address);
    if (!entry) return;
    try {
      entry.characteristic.off?.('valuechanged', entry.handler);
      await entry.characteristic.stopNotifications().catch(() => {});
      await entry.device.disconnect().catch(() => {});
    } finally {
      this._connections.delete(address);
      this.emit(BLE_EVENTS.DISCONNECTED, { address });
    }
  }

  async sendMidi(address, data) {
    if (!(data instanceof Uint8Array)) {
      throw new TypeError('sendMidi data must be a Uint8Array');
    }
    const entry = this._connections.get(address);
    if (!entry) {
      throw new Error(`Device ${address} is not connected`);
    }
    // node-ble characteristic expects a Buffer.
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    await entry.characteristic.writeValueWithoutResponse(buf);
  }

  isConnected(address) {
    return this._connections.has(address);
  }

  async dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const address of Array.from(this._connections.keys())) {
      await this.disconnect(address).catch(() => {});
    }
    if (this._destroy) {
      try { this._destroy(); } catch { /* ignore */ }
    }
    this._bluetooth = null;
    this._adapter = null;
    this._destroy = null;
    this._ready = false;
    this.removeAllListeners();
  }

  _assertAlive() {
    if (this._disposed) throw new Error('Adapter disposed');
  }
}
