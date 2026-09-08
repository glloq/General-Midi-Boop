// tests/audit/l12-health-capabilities.test.js
//
// Lot L12 — §BB. Les *vrais* prédicats de `/api/health`.
//
// `tests/capability-status.test.js` teste la fonction de mapping : « un
// service truthy devient-il `ready` ? ». Elle répond oui — et c'est
// précisément pourquoi elle laisse passer F-01 et F-02. Ce fichier pose
// l'autre question, la seule qui intéresse un opérateur devant sa console :
// « un sous-système cassé se déclare-t-il cassé ? ».
//
// Les doublures reproduisent le comportement réel observé sur un serveur
// vivant (port 8112, 2026-09-07) :
//   - DeviceManager se construit TOUJOURS, même sans binding natif ; sa
//     vérité d'exécution est `midiAvailable` (DeviceManager.js:127).
//   - BluetoothManager se construit TOUJOURS ; l'échec de
//     `_initializePort()` est asynchrone, avalé, et n'apparaît que dans
//     `getStatus().available` (BluetoothManager.js:701-712).
//   - SerialMidiManager se construit TOUJOURS, `enabled:false` compris.

import { describe, test, expect } from '@jest/globals';
import Application from '../../src/core/Application.js';

const getCapabilityStatus = Application.prototype.getCapabilityStatus;

/** DeviceManager tel que construit sans bibliothèque MIDI native. */
function deviceManagerWithoutNativeMidi() {
  return { midiAvailable: false, devices: new Map() };
}

/** DeviceManager sur une machine où easymidi a chargé. */
function deviceManagerWithNativeMidi() {
  return { midiAvailable: true, devices: new Map() };
}

/**
 * BluetoothManager dont le constructeur a réussi mais dont le port BLE
 * n'a jamais pu s'initialiser (pas de D-Bus / pas d'adaptateur BlueZ).
 */
function bluetoothManagerWithDeadRuntime() {
  return {
    getStatus: () => ({
      enabled: false,
      available: false,
      state: 'unknown',
      scanning: false,
      devicesFound: 0,
      connectedDevices: 0,
      pairedDevices: 0
    })
  };
}

function bluetoothManagerHealthy() {
  return {
    getStatus: () => ({
      enabled: true,
      available: true,
      state: 'poweredOn',
      scanning: false,
      devicesFound: 0,
      connectedDevices: 0,
      pairedDevices: 0
    })
  };
}

function serialManager({ enabled, available }) {
  return { getStatus: () => ({ enabled, available, scanning: false, openPorts: 0, ports: [] }) };
}

function statusFor(overrides = {}) {
  const self = {
    _capabilityErrors: {},
    database: {},
    midiPlayer: {},
    deviceManager: deviceManagerWithNativeMidi(),
    bluetoothManager: null,
    networkManager: null,
    serialMidiManager: null,
    lightingManager: null,
    ...overrides
  };
  return getCapabilityStatus.call(self);
}

describe('L12 §BB — /api/health dit la vérité sur les capacités', () => {
  // ── F-01 ────────────────────────────────────────────────────────────
  describe('F-01 — usb', () => {
    test("sans bibliothèque MIDI native, usb n'est PAS ready", () => {
      const { capabilities } = statusFor({ deviceManager: deviceManagerWithoutNativeMidi() });
      expect(capabilities.usb.status).not.toBe('ready');
      expect(capabilities.usb.status).toBe('failed');
    });

    test("l'état usb porte un motif exploitable par un opérateur", () => {
      const { capabilities } = statusFor({ deviceManager: deviceManagerWithoutNativeMidi() });
      expect(typeof capabilities.usb.detail).toBe('string');
      expect(capabilities.usb.detail.length).toBeGreaterThan(0);
      expect(capabilities.usb.detail).toMatch(/MIDI/i);
    });

    test('avec la bibliothèque native chargée, usb est ready', () => {
      const { capabilities } = statusFor({ deviceManager: deviceManagerWithNativeMidi() });
      expect(capabilities.usb.status).toBe('ready');
    });

    test('un DeviceManager absent reste failed', () => {
      const { capabilities } = statusFor({ deviceManager: null });
      expect(capabilities.usb.status).toBe('failed');
    });

    test("un DeviceManager sans champ midiAvailable n'est pas dégradé à tort", () => {
      // Robustesse : une doublure/un ancien manager sans le champ ne doit pas
      // basculer en failed (on ne dégrade que sur une preuve d'indisponibilité).
      const { capabilities } = statusFor({ deviceManager: { devices: new Map() } });
      expect(capabilities.usb.status).toBe('ready');
    });
  });

  // ── F-02 ────────────────────────────────────────────────────────────
  describe('F-02 — ble', () => {
    test("après un échec d'init du runtime BLE, ble n'est PAS ready", () => {
      const { capabilities } = statusFor({
        bluetoothManager: bluetoothManagerWithDeadRuntime(),
        _capabilityErrors: {}
      });
      expect(capabilities.ble.status).not.toBe('ready');
    });

    test("l'erreur d'init enregistrée devient un état failed documenté", () => {
      const { capabilities } = statusFor({
        bluetoothManager: bluetoothManagerWithDeadRuntime(),
        _capabilityErrors: { ble: 'D-Bus system bus not available' }
      });
      expect(capabilities.ble.status).toBe('failed');
      expect(capabilities.ble.detail).toMatch(/D-Bus/);
    });

    test('runtime indisponible sans erreur enregistrée ⇒ degraded, pas ready', () => {
      const { capabilities } = statusFor({
        bluetoothManager: bluetoothManagerWithDeadRuntime()
      });
      expect(capabilities.ble.status).toBe('degraded');
      expect(capabilities.ble.detail).toBeTruthy();
    });

    test('un runtime BLE réellement opérationnel reste ready', () => {
      const { capabilities } = statusFor({ bluetoothManager: bluetoothManagerHealthy() });
      expect(capabilities.ble.status).toBe('ready');
    });

    test("l'absence de BluetoothManager reste disabled (comportement conservé)", () => {
      const { capabilities } = statusFor({ bluetoothManager: null });
      expect(capabilities.ble.status).toBe('disabled');
    });

    test('un échec du constructeur reste failed (comportement conservé)', () => {
      const { capabilities } = statusFor({
        bluetoothManager: null,
        _capabilityErrors: { ble: 'noble missing' }
      });
      expect(capabilities.ble.status).toBe('failed');
      expect(capabilities.ble.detail).toBe('noble missing');
    });

    test('un manager sans getStatus() ne casse pas le calcul', () => {
      const { capabilities } = statusFor({ bluetoothManager: {} });
      expect(capabilities.ble.status).toBe('ready');
    });

    test('un getStatus() qui lève ne casse pas /api/health', () => {
      const boom = {
        getStatus() {
          throw new Error('port exploded');
        }
      };
      expect(() => statusFor({ bluetoothManager: boom })).not.toThrow();
      const { capabilities } = statusFor({ bluetoothManager: boom });
      expect(['ready', 'degraded', 'failed']).toContain(capabilities.ble.status);
    });
  });

  // ── F-128 ───────────────────────────────────────────────────────────
  describe('F-128 — serial', () => {
    test('serial désactivé en configuration est disabled, pas ready', () => {
      const { capabilities } = statusFor({
        serialMidiManager: serialManager({ enabled: false, available: true })
      });
      expect(capabilities.serial.status).toBe('disabled');
    });

    test('serial activé mais module serialport absent est failed', () => {
      const { capabilities } = statusFor({
        serialMidiManager: serialManager({ enabled: true, available: false })
      });
      expect(capabilities.serial.status).toBe('failed');
    });

    test('serial activé et disponible est ready', () => {
      const { capabilities } = statusFor({
        serialMidiManager: serialManager({ enabled: true, available: true })
      });
      expect(capabilities.serial.status).toBe('ready');
    });
  });

  // ── Non-régression du contrat existant ──────────────────────────────
  describe('contrat conservé', () => {
    test('network reste degraded par conception (AppleMIDI simplifié)', () => {
      const { capabilities } = statusFor({ networkManager: {} });
      expect(capabilities.network.status).toBe('degraded');
      expect(capabilities.network.detail).toMatch(/AppleMIDI/i);
    });

    test('overall failed dès qu’une capacité de cœur tombe', () => {
      expect(statusFor({ midiPlayer: null }).overall).toBe('failed');
      expect(statusFor({ database: null }).overall).toBe('failed');
    });

    test('overall degraded quand seul usb est tombé (le box joue encore)', () => {
      const { overall, capabilities } = statusFor({
        deviceManager: deviceManagerWithoutNativeMidi()
      });
      expect(capabilities.usb.status).toBe('failed');
      expect(overall).toBe('degraded');
    });

    test('overall ready quand tout est réellement opérationnel', () => {
      const { overall } = statusFor({
        deviceManager: deviceManagerWithNativeMidi(),
        bluetoothManager: bluetoothManagerHealthy(),
        serialMidiManager: serialManager({ enabled: true, available: true }),
        lightingManager: {},
        networkManager: null
      });
      expect(overall).toBe('ready');
    });

    test('chaque état appartient au vocabulaire normalisé du plan', () => {
      const vocab = ['ready', 'degraded', 'failed', 'disabled'];
      const { overall, capabilities } = statusFor({
        deviceManager: deviceManagerWithoutNativeMidi(),
        bluetoothManager: bluetoothManagerWithDeadRuntime(),
        networkManager: {},
        serialMidiManager: serialManager({ enabled: false, available: false }),
        lightingManager: {}
      });
      for (const [name, cap] of Object.entries(capabilities)) {
        expect(vocab).toContain(cap.status);
        expect(typeof name).toBe('string');
      }
      expect(vocab).toContain(overall);
    });
  });
});
