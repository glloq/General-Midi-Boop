// tests/frontend/r2-bluetooth-scan-xss.test.js
//
// Vague 1 · R2 — F-110 (P1) : XSS DOM confirmée dans `BluetoothScanModal`.
//
// `renderAvailableDevice()` calculait bien un `deviceNameEscaped`, l'utilisait
// pour le texte visible… et posait la variable **brute** dans
// `data-device-name` trois lignes plus bas. Le markup part ensuite dans
// `innerHTML`.
//
// La donnée n'est pas anodine : `device.name` est le nom annoncé par le
// périphérique BLE (NobleBleAdapter → `device.getName()` → BlueZ), donc
// entièrement contrôlé par quiconque a un téléphone ou un ESP32 à portée
// radio. Aucun accès réseau n'est requis, et ouvrir la modale d'appairage est
// le geste normal de l'utilisateur.
//
// Ce fichier fige la propriété pour **tous** les champs d'appareil, pas
// seulement celui qui a été démontré : nom, id, adresse, signal, rssi — ils
// viennent tous du même chemin non fiable.
//
// Le module est un IIFE navigateur : on l'évalue dans le jsdom de Vitest avec
// le vrai `escapeHtml.js`, pour tester le code réellement livré.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const PAYLOAD = '"><img src=x onerror="window.__R2_BLE_XSS=1">';

let BluetoothScanModal;

/** Instance minimale : uniquement ce que les deux renderers consomment. */
function makeInstance() {
  return { _t: (k) => k };
}

/** Rend un markup dans un hôte détaché, exactement comme `innerHTML` le ferait. */
function render(fn, device) {
  const host = document.createElement('div');
  host.innerHTML = fn.call(makeInstance(), device);
  return host;
}

beforeAll(() => {
  const escSrc = readFileSync(resolve(__dirname, '../../public/js/utils/escapeHtml.js'), 'utf8');
  const modSrc = readFileSync(
    resolve(__dirname, '../../public/js/features/BluetoothScanModal.js'),
    'utf8'
  );
  // eslint-disable-next-line no-eval
  (0, eval)(escSrc);
  // eslint-disable-next-line no-eval
  (0, eval)(modSrc);
  BluetoothScanModal = window.BluetoothScanModal;
});

describe('R2 / F-110 — BluetoothScanModal échappe les données d’appareil', () => {
  it('expose la classe une fois le fichier évalué', () => {
    expect(typeof BluetoothScanModal).toBe('function');
  });

  it('renderAvailableDevice : un nom BLE hostile n’injecte aucun élément', () => {
    const host = render(BluetoothScanModal.prototype.renderAvailableDevice, {
      id: 'AA:BB:CC:DD:EE:FF',
      address: 'AA:BB:CC:DD:EE:FF',
      name: PAYLOAD,
      rssi: -50
    });

    expect(host.querySelectorAll('img').length).toBe(0);
    // La charge survit intacte une fois l'attribut décodé : échappée, pas mutilée.
    expect(host.querySelector('[data-action="pair"]').getAttribute('data-device-name')).toBe(
      PAYLOAD
    );
    expect(host.querySelector('.device-name').textContent).toContain('<img src=x');
  });

  it('renderAvailableDevice : id, adresse, signal et rssi hostiles sont échappés', () => {
    const host = render(BluetoothScanModal.prototype.renderAvailableDevice, {
      id: PAYLOAD,
      address: PAYLOAD,
      name: 'Clavier',
      signal: PAYLOAD,
      rssi: PAYLOAD
    });

    expect(host.querySelectorAll('img').length).toBe(0);
    expect(host.querySelector('.device-card').getAttribute('data-device-id')).toBe(PAYLOAD);
    expect(host.querySelector('.device-address').textContent).toContain('<img src=x');
  });

  it('renderPairedDevice : nom et adresse hostiles sont échappés', () => {
    const host = render(BluetoothScanModal.prototype.renderPairedDevice, {
      address: PAYLOAD,
      name: PAYLOAD,
      connected: false
    });

    expect(host.querySelectorAll('img').length).toBe(0);
    expect(host.querySelector('.device-card').getAttribute('data-device-address')).toBe(PAYLOAD);
    expect(host.querySelector('[data-action="unpair"]').getAttribute('data-device-address')).toBe(
      PAYLOAD
    );
  });

  it('renderPairedDevice : un appareil connecté échappe aussi ses boutons', () => {
    const host = render(BluetoothScanModal.prototype.renderPairedDevice, {
      address: PAYLOAD,
      name: 'Clavier',
      connected: true
    });

    expect(host.querySelectorAll('img').length).toBe(0);
    expect(
      host.querySelector('[data-action="disconnect"]').getAttribute('data-device-address')
    ).toBe(PAYLOAD);
  });

  it('aucun gestionnaire injecté ne s’est exécuté pendant ces rendus', () => {
    expect(window.__R2_BLE_XSS).toBeUndefined();
  });
});

describe('R2 — les sélecteurs ne sont plus construits par concaténation', () => {
  it('pairDevice retrouve la carte même avec un id contenant des métacaractères CSS', () => {
    const container = document.createElement('div');
    container.innerHTML = BluetoothScanModal.prototype.renderAvailableDevice.call(makeInstance(), {
      id: PAYLOAD,
      address: PAYLOAD,
      name: 'Clavier'
    });

    const emitted = [];
    const inst = {
      container,
      logger: { info() {}, warn() {} },
      eventBus: { emit: (e, d) => emitted.push([e, d]) }
    };

    // Avant : `querySelector(\`[data-device-id="${id}"]\`)` levait un SyntaxError
    // sur un id contenant un guillemet — l'appairage cassait au lieu d'échouer.
    expect(() =>
      BluetoothScanModal.prototype.pairDevice.call(inst, PAYLOAD, 'Clavier')
    ).not.toThrow();

    expect(container.querySelector('.btn-pair').disabled).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0][1].device_id).toBe(PAYLOAD);
  });

  it('connectDevice se comporte de même sur une adresse hostile', () => {
    const container = document.createElement('div');
    container.innerHTML = BluetoothScanModal.prototype.renderPairedDevice.call(makeInstance(), {
      address: PAYLOAD,
      name: 'Clavier',
      connected: false
    });

    const inst = { container, logger: { info() {}, warn() {} }, eventBus: null };

    expect(() => BluetoothScanModal.prototype.connectDevice.call(inst, PAYLOAD)).not.toThrow();
    expect(container.querySelector('.btn-connect').disabled).toBe(true);
  });
});
