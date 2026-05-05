/**
 * @file src/infrastructure/events/BluetoothEventBridge.js
 * @description Bridges BluetoothManager EventEmitter events to WebSocket
 * clients so the frontend receives real-time Bluetooth state updates
 * without polling.
 *
 * Extracted from Application.setupEventHandlers() to keep the composition
 * root free of transport-specific wiring.
 */

const BT_EVENTS = [
  'bluetooth:powered_on',
  'bluetooth:powered_off',
  'bluetooth:connected',
  'bluetooth:disconnected',
  'bluetooth:unpaired'
];

export class BluetoothEventBridge {
  /**
   * @param {Object} bluetoothManager - EventEmitter with BT lifecycle events.
   * @param {Object} wsServer - WebSocket server exposing `broadcast(event, data)`.
   */
  constructor(bluetoothManager, wsServer) {
    this._bt = bluetoothManager;
    this._ws = wsServer;
    this._handlers = [];
  }

  /**
   * Subscribe to all Bluetooth events and forward them to WS clients.
   * Safe to call multiple times — previous handlers are detached first.
   * @returns {void}
   */
  attach() {
    this.detach();
    for (const event of BT_EVENTS) {
      const handler = (data) => this._ws?.broadcast(event, data || {});
      this._bt.on(event, handler);
      this._handlers.push({ event, handler });
    }
  }

  /**
   * Remove all forwarding subscriptions.
   * @returns {void}
   */
  detach() {
    for (const { event, handler } of this._handlers) {
      this._bt.off(event, handler);
    }
    this._handlers = [];
  }
}
