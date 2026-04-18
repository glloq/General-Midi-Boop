/**
 * @file src/midi/ports/BluetoothPort.js
 * @description Bluetooth (BLE-MIDI) port interface — the contract every
 * Bluetooth adapter must satisfy (P1-4.5, ADR-001 §V4 ports/adapters).
 * The production {@link NobleBleAdapter} (wrapping `node-ble`) and the
 * test {@link InMemoryBleAdapter} are interchangeable behind this
 * surface.
 *
 * Implementations are duck-typed (no abstract class) to keep the layer
 * thin. The contract test (`tests/ports/bluetooth-port.contract.test.js`)
 * runs against any object claiming to implement this port.
 *
 * Events (EventEmitter):
 *   - `device-discovered` — `{ address, name, rssi? }`
 *   - `connected`         — `{ address }`
 *   - `disconnected`      — `{ address }`
 *   - `midi-message`      — `{ address, data: Uint8Array }`
 *   - `powered-off`       — `{ reason? }`
 */

/**
 * @typedef {object} BluetoothDeviceDescriptor
 * @property {string} address  - device MAC or unique identifier
 * @property {string} name     - human-readable name
 * @property {number} [rssi]   - signal strength
 */

/**
 * Capabilities every Bluetooth adapter must expose.
 *
 * @typedef {object} BluetoothPort
 * @property {() => Promise<void>} startDiscovery
 *   Begin scanning for BLE-MIDI devices. Triggers 'device-discovered'
 *   events as devices appear.
 * @property {() => Promise<void>} stopDiscovery
 * @property {() => BluetoothDeviceDescriptor[]} listDiscovered
 *   Return the current snapshot of discovered devices.
 * @property {(address: string) => Promise<void>} connect
 *   Establish GATT connection + subscribe to BLE-MIDI characteristic.
 *   Emits 'connected' on success, throws on failure.
 * @property {(address: string) => Promise<void>} disconnect
 * @property {(address: string, data: Uint8Array) => Promise<void>} sendMidi
 *   Write a BLE-MIDI packet to the connected device's characteristic.
 * @property {(address: string) => boolean} isConnected
 * @property {(event: string, handler: Function) => void} on
 * @property {(event: string, handler: Function) => void} off
 * @property {() => Promise<void>} dispose
 *   Cleanly shut down the adapter (close DBus, free resources).
 */

/**
 * Canonical event names emitted by every {@link BluetoothPort} adapter.
 * Exported so tests / adapters can reference them by symbol instead of
 * duplicating literal strings.
 */
export const BLE_EVENTS = Object.freeze({
  DEVICE_DISCOVERED: 'device-discovered',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  MIDI_MESSAGE: 'midi-message',
  POWERED_OFF: 'powered-off'
});

/**
 * Required method names — used by the contract test to assert that an
 * implementation exposes the full {@link BluetoothPort} surface.
 */
export const BLE_PORT_METHODS = Object.freeze([
  'startDiscovery',
  'stopDiscovery',
  'listDiscovered',
  'connect',
  'disconnect',
  'sendMidi',
  'isConnected',
  'on',
  'off',
  'dispose'
]);
