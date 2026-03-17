// ============================================================================
// src/managers/BluetoothManager.js
// ============================================================================
// Description:
//   Gère les périphériques Bluetooth BLE MIDI
//   - Scan des périphériques BLE disponibles
//   - Connexion/déconnexion aux périphériques BLE MIDI
//   - Gestion des périphériques appairés
//   - NOUVELLE VERSION: Utilise node-ble (Bluez/DBus) pour connexions RAPIDES
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
    this.pairedDevices = []; // Liste des périphériques appairés

    this.BLE_MIDI_SERVICE_UUID = '03b80e5a-ede8-4b33-a751-6ce34ec4c700'; // UUID du service MIDI BLE
    this.BLE_MIDI_CHARACTERISTIC_UUID = '7772e5db-3868-4112-a1a9-f2669d106bf3'; // UUID de la caractéristique MIDI I/O

    // Initialiser node-ble
    this.bluetooth = null;
    this.adapter = null;
    this.destroy = null;

    this._initPromise = this.initializeBluetooth();

    this.app.logger.info('BluetoothManager initialized (node-ble)');
  }

  async initializeBluetooth() {
    try {
      const { bluetooth, destroy } = createBluetooth();
      this.bluetooth = bluetooth;
      this.destroy = destroy;

      this.adapter = await bluetooth.defaultAdapter();

      const adapterName = await this.adapter.getName();
      this.app.logger.info(`Bluetooth adapter ready: ${adapterName}`);

      // Émettre événement powered on
      this.emit('bluetooth:powered_on');

    } catch (error) {
      this.app.logger.error(`Failed to initialize Bluetooth: ${error.message}`);
      this.emit('bluetooth:powered_off', { error: error.message });
    }
  }

  /**
   * Démarre le scan BLE
   * @param {number} duration - Durée du scan en secondes (0 = scan continu)
   * @param {string} filter - Filtre optionnel sur le nom
   * @returns {Promise<Array>} Liste des périphériques trouvés
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

      // Démarrer le scan
      const isDiscovering = await this.adapter.isDiscovering();
      if (!isDiscovering) {
        await this.adapter.startDiscovery();
      }

      // Attendre la durée du scan
      await new Promise(resolve => setTimeout(resolve, duration * 1000));

      // Récupérer les appareils découverts
      const deviceAddresses = await this.adapter.devices();
      this.app.logger.info(`[TIMING] Scan found ${deviceAddresses.length} devices in ${Date.now() - startTime}ms`);

      // Charger les infos de chaque appareil
      for (const address of deviceAddresses) {
        try {
          const device = await this.adapter.getDevice(address);
          await this.handleDeviceDiscovered(device, address);
        } catch (error) {
          this.app.logger.debug(`Could not get device ${address}: ${error.message}`);
        }
      }

      // Arrêter le scan
      await this.adapter.stopDiscovery();
      this.scanning = false;

      // Appliquer le filtre si nécessaire
      let devicesArray = Array.from(this.devices.values());
      if (filter) {
        devicesArray = devicesArray.filter(d =>
          d.name.toLowerCase().includes(filter.toLowerCase())
        );
      }

      this.app.logger.info(`Scan complete: ${devicesArray.length} devices available`);

      // Retirer deviceObject pour éviter circular structure JSON
      return devicesArray.map(({ deviceObject, ...device }) => device);

    } catch (error) {
      this.scanning = false;
      this.app.logger.error(`Scan error: ${error.message}`);
      throw error;
    }
  }

  async handleDeviceDiscovered(device, address) {
    try {
      // Obtenir les infos avec gestion d'erreurs individuelles
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

      // Vérifier si c'est un périphérique MIDI BLE
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

      // TOUJOURS ajouter le device même en cas d'erreur pour qu'il soit visible
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
    // Convertir RSSI en pourcentage de signal (approximatif)
    // RSSI typique: -100 dBm (très faible) à -30 dBm (très fort)
    const minRssi = -100;
    const maxRssi = -30;
    const clampedRssi = Math.max(minRssi, Math.min(maxRssi, rssi));
    const signal = Math.round(((clampedRssi - minRssi) / (maxRssi - minRssi)) * 100);
    return signal;
  }

  /**
   * Arrête le scan BLE
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
   * Connecte un périphérique BLE
   * @param {string} address - Adresse du périphérique
   * @returns {Promise<Object>} Info de connexion
   */
  async connect(address) {
    const startTime = Date.now();
    this.app.logger.info(`[TIMING] Starting connection to BLE device: ${address}`);

    // Ensure initialization is complete
    if (this._initPromise) await this._initPromise;

    if (!this.adapter) {
      throw new Error('Bluetooth adapter not ready');
    }

    try {
      // Récupérer le périphérique
      const deviceInfo = this.devices.get(address);
      let device = deviceInfo ? deviceInfo.deviceObject : null;

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

        // Obtenir le serveur GATT
        const gattStart = Date.now();
        const gattServer = await device.gatt();
        this.app.logger.info(`[TIMING] GATT server obtained in ${Date.now() - gattStart}ms`);

        // Obtenir le service MIDI
        const serviceStart = Date.now();
        const service = await gattServer.getPrimaryService(this.BLE_MIDI_SERVICE_UUID);
        this.app.logger.info(`[TIMING] MIDI service found in ${Date.now() - serviceStart}ms`);

        // Obtenir la caractéristique MIDI I/O
        const charStart = Date.now();
        const characteristic = await service.getCharacteristic(this.BLE_MIDI_CHARACTERISTIC_UUID);
        this.app.logger.info(`[TIMING] MIDI characteristic found in ${Date.now() - charStart}ms`);

        return { gattServer, characteristic };
      };

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`BLE connection timeout after ${BLE_CONNECT_TIMEOUT}ms`)), BLE_CONNECT_TIMEOUT)
      );

      const { gattServer, characteristic } = await Promise.race([connectWithTimeout(), timeoutPromise]);

      // S'abonner aux notifications - store handler reference for cleanup
      const midiHandler = buffer => {
        this.handleMidiData(address, buffer);
      };
      characteristic.on('valuechanged', midiHandler);
      await characteristic.startNotifications();

      const name = await device.getName();

      // Marquer comme connecté
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

      // Stocker la connexion (include handler reference for cleanup)
      this.connectedDevices.set(address, {
        device: device,
        gattServer: gattServer,
        characteristic: characteristic,
        midiHandler: midiHandler
      });

      const totalTime = Date.now() - startTime;
      this.app.logger.info(`[TIMING] 🚀 TOTAL CONNECTION TIME: ${totalTime}ms`);
      this.app.logger.info(`Connected to ${name} (${address}) via node-ble`);

      // Émettre événement de connexion
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
      } catch (_) { /* ignore cleanup errors */ }
      throw error;
    }
  }

  /**
   * Déconnecte un périphérique
   * @param {string} address - Adresse du périphérique
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

      // Déconnecter
      await device.disconnect();

      this.connectedDevices.delete(address);

      // Mettre à jour le statut
      const pairedDevice = this.pairedDevices.find(d => d.address === address);
      if (pairedDevice) {
        pairedDevice.connected = false;
      }

      this.app.logger.info(`Disconnected from ${address}`);

      // Émettre événement
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
   * Oublie un périphérique (dépairage)
   * @param {string} address - Adresse du périphérique
   */
  async unpair(address) {
    // Déconnecter d'abord si connecté
    if (this.connectedDevices.has(address)) {
      await this.disconnect(address);
    }

    // Retirer de la liste appairée
    this.pairedDevices = this.pairedDevices.filter(d => d.address !== address);

    this.app.logger.info(`Unpaired device ${address}`);

    // Émettre événement
    this.emit('bluetooth:unpaired', {
      address: address
    });
  }

  /**
   * Alias pour unpair() - pour compatibilité avec CommandHandler
   */
  async forget(address) {
    return await this.unpair(address);
  }

  /**
   * Gère les données MIDI reçues via BLE MIDI
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
   * Envoie des données MIDI à un périphérique
   */
  async sendMidiData(address, midiData) {
    const deviceConnection = this.connectedDevices.get(address);

    if (!deviceConnection || !deviceConnection.characteristic) {
      throw new Error(`Device ${address} not connected or MIDI not configured`);
    }

    try {
      // Format BLE MIDI: timestamp header + données MIDI
      const timestamp = 0x80; // Header simple avec bit 7 à 1
      const bleData = Buffer.from([timestamp, ...midiData]);

      await deviceConnection.characteristic.writeValue(bleData);

      this.app.logger.debug(`MIDI sent to ${address}:`, midiData);

    } catch (error) {
      this.app.logger.error(`Send MIDI error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Envoie un message MIDI (format easymidi) à un périphérique Bluetooth
   * @param {string} address - Adresse BLE du périphérique
   * @param {string} type - Type de message ('noteon', 'noteoff', 'cc', etc.)
   * @param {object} data - Données du message ({channel, note, velocity} ou {channel, controller, value})
   */
  async sendMidiMessage(address, type, data) {
    // Convertir format easymidi en bytes MIDI bruts
    const midiBytes = this.convertToMidiBytes(type, data);

    if (midiBytes) {
      await this.sendMidiData(address, midiBytes);
    } else {
      this.app.logger.warn(`Unsupported MIDI message type: ${type}`);
    }
  }

  /**
   * Convertit un message easymidi en bytes MIDI
   * @param {string} type - Type de message
   * @param {object} data - Données du message
   * @returns {Array<number>} Bytes MIDI
   */
  convertToMidiBytes(type, data) {
    return MidiUtils.convertToMidiBytes(type, data);
  }

  /**
   * Obtient la liste des périphériques appairés
   */
  getPairedDevices() {
    return this.pairedDevices.map(device => ({
      ...device,
      connected: this.connectedDevices.has(device.address)
    }));
  }

  /**
   * Vérifie si un périphérique est connecté
   */
  isConnected(address) {
    return this.connectedDevices.has(address);
  }

  /**
   * Obtient le statut du Bluetooth
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
   * Nettoie et libère les ressources
   */
  async cleanup() {
    try {
      // Déconnecter tous les périphériques
      for (const address of this.connectedDevices.keys()) {
        await this.disconnect(address).catch(() => {});
      }

      // Arrêter le scan si actif
      await this.stopScan();

      // Libérer node-ble
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
