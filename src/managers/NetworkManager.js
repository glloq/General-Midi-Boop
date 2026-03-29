// ============================================================================
// src/managers/NetworkManager.js
// ============================================================================
// Description:
//   Gère les instruments MIDI via réseau/WiFi
//   - Scan du réseau local pour trouver des instruments
//   - Connexion/déconnexion aux instruments réseau
//   - Gestion des instruments connectés via réseau
// ============================================================================

import EventEmitter from 'events';
import { execFile } from 'child_process';
import { promisify } from 'util';
import net from 'net';
import os from 'os';
import RtpMidiSession from './RtpMidiSession.js';
import MidiUtils from '../utils/MidiUtils.js';

const execFileAsync = promisify(execFile);

class NetworkManager extends EventEmitter {
  constructor(app) {
    super();
    this.app = app;
    this.scanning = false;
    this.devices = new Map(); // Map of IP -> device info
    this.connectedDevices = new Map(); // Map of IP -> connection info
    this.rtpSessions = new Map(); // Map of IP -> RtpMidiSession

    // Ports MIDI over network couramment utilisés
    this.MIDI_NETWORK_PORTS = [
      5004, // RTP-MIDI (Apple Network MIDI)
      5353, // mDNS
      21928, // RTP-MIDI session
      7000, 7001, 7002 // Ports personnalisés souvent utilisés
    ];

    this.app.logger.info('NetworkManager initialized with RTP-MIDI support');
  }

  /**
   * Obtient le sous-réseau local à scanner
   * @returns {string} Sous-réseau local (ex: "192.168.1")
   */
  getLocalSubnet() {
    const interfaces = os.networkInterfaces();

    for (const name in interfaces) {
      for (const iface of interfaces[name]) {
        // Ignorer les interfaces loopback et non IPv4
        if (iface.family === 'IPv4' && !iface.internal) {
          const parts = iface.address.split('.');
          // Retourner le sous-réseau de classe C
          return `${parts[0]}.${parts[1]}.${parts[2]}`;
        }
      }
    }

    // Fallback au sous-réseau par défaut
    return '192.168.1';
  }

  /**
   * Scan du réseau local pour trouver des instruments
   * @param {number} timeout - Timeout en secondes
   * @param {boolean} fullScan - Si true, scan toutes les IPs du subnet (pas seulement RTP-MIDI)
   * @returns {Promise<Array>} Liste des instruments trouvés
   */
  async startScan(timeout = 5, fullScan = true) {
    if (this.scanning) {
      throw new Error('Scan already in progress');
    }

    // Sanitize timeout to prevent injection and bound resource usage
    timeout = Math.max(1, Math.min(30, parseInt(timeout, 10) || 5));

    this.app.logger.info(`Starting network scan for ${timeout}s... (fullScan: ${fullScan})`);
    this.scanning = true;
    this.devices.clear();

    try {
      const subnet = this.getLocalSubnet();
      this.app.logger.info(`Scanning subnet: ${subnet}.0/24`);

      // Méthode 1: Scan mDNS pour services MIDI
      await this.scanMDNS(timeout);

      // Méthode 2: Scan complet du subnet (toutes les IPs)
      if (fullScan) {
        await this.scanSubnetIPs(subnet, timeout);
      }

      const devices = Array.from(this.devices.values());

      this.app.logger.info(`Network scan completed: ${devices.length} devices found`);
      this.scanning = false;

      return devices;
    } catch (error) {
      this.scanning = false;
      this.app.logger.error(`Network scan error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Scan mDNS pour découvrir les services MIDI sur le réseau
   * @param {number} timeout - Timeout en secondes
   */
  async scanMDNS(timeout) {
    try {
      // Utiliser avahi-browse sur Linux pour découvrir les services
      if (process.platform === 'linux') {
        this.app.logger.debug('Using avahi-browse for mDNS discovery...');

        // Scanner les services RTP-MIDI et Apple MIDI spécifiquement
        const serviceTypes = [
          '_apple-midi._udp',
          '_rtpmidi._udp',
          '_midi._udp'
        ];

        for (const serviceType of serviceTypes) {
          try {
            const { stdout } = await execFileAsync(
              'timeout', [String(timeout) + 's', 'avahi-browse', serviceType, '-t', '-r', '-p'],
              { timeout: (timeout + 1) * 1000 }
            ).catch(() => ({ stdout: '' }));

            if (stdout && stdout.trim()) {
              this.parseMDNSOutput(stdout);
              this.app.logger.info(`mDNS: found services for ${serviceType}`);
            }
          } catch (error) {
            this.app.logger.debug(`avahi-browse failed for ${serviceType}: ${error.message}`);
          }
        }

        // Fallback: scanner tous les services si aucun résultat spécifique
        if (this.devices.size === 0) {
          try {
            const { stdout } = await execFileAsync(
              'timeout', [String(timeout) + 's', 'avahi-browse', '-a', '-t', '-r', '-p'],
              { timeout: (timeout + 1) * 1000 }
            ).catch(() => ({ stdout: '' }));

            if (stdout && stdout.trim()) {
              this.parseMDNSOutput(stdout);
            }
          } catch (error) {
            this.app.logger.debug('avahi-browse -a not available or no services found');
          }
        }
      }

      // Ajouter des périphériques de test pour le développement
      this.addTestDevices();

    } catch (error) {
      this.app.logger.warn(`mDNS scan error: ${error.message}`);
    }
  }

  /**
   * Parse la sortie de avahi-browse
   * @param {string} output - Sortie de avahi-browse
   */
  parseMDNSOutput(output) {
    const lines = output.split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;

      const parts = line.split(';');
      if (parts.length < 8) continue;

      const name = parts[3];
      const ip = parts[7];
      const port = parts[8] || '5004';

      if (ip && ip !== '(null)') {
        const deviceInfo = {
          ip: ip,
          address: ip,
          port: port,
          name: name || `Instrument réseau (${ip})`,
          type: 'network',
          manufacturer: 'Unknown',
          protocol: 'RTP-MIDI'
        };

        this.devices.set(ip, deviceInfo);
        this.app.logger.debug(`mDNS device found: ${name} at ${ip}:${port}`);
      }
    }
  }

  /**
   * Scan complet du subnet pour trouver toutes les IPs accessibles
   * @param {string} subnet - Sous-réseau à scanner (ex: "192.168.1")
   * @param {number} timeout - Timeout en secondes
   */
  async scanSubnetIPs(subnet, timeout) {
    this.app.logger.info(`[NetworkManager] Scanning full subnet ${subnet}.0/24...`);

    const pingPromises = [];
    const localIP = this.getLocalIP();
    let ipFoundCount = 0;

    // Scanner les IPs de .1 à .254 (exclure .0 et .255)
    for (let i = 1; i <= 254; i++) {
      // Check cancellation between batches
      if (!this.scanning) {
        this.app.logger.info(`[NetworkManager] Subnet scan cancelled at IP .${i}`);
        break;
      }

      const ip = `${subnet}.${i}`;

      // Éviter de scanner notre propre IP
      if (ip === localIP) continue;

      // Lancer le ping de manière asynchrone avec timeout réduit
      const pingPromise = this.checkReachability(ip, 1000) // 1 second timeout
        .then(isReachable => {
          if (isReachable) {
            // Ne pas ajouter si déjà découvert via mDNS
            if (!this.devices.has(ip)) {
              const deviceInfo = {
                ip: ip,
                address: ip,
                port: '5004',
                name: `Device IP (${ip})`,
                type: 'network-ip',
                manufacturer: 'Unknown',
                protocol: 'IP',
                discovered: 'ping'
              };
              this.devices.set(ip, deviceInfo);
              ipFoundCount++;
              this.app.logger.info(`[NetworkManager] ✅ IP found: ${ip}`);
            }
          }
        })
        .catch(() => {
          // Ignorer les erreurs de ping
        });

      pingPromises.push(pingPromise);

      // Traiter par batch de 15 (limit concurrent connections on RPi)
      if (pingPromises.length >= 15) {
        await Promise.all(pingPromises);
        pingPromises.length = 0; // Vider le tableau
      }
    }

    // Attendre les derniers pings
    if (pingPromises.length > 0) {
      await Promise.all(pingPromises);
    }

    this.app.logger.info(`[NetworkManager] Subnet scan completed - ${ipFoundCount} IPs found by ping, ${this.devices.size} total devices`);

    // Si aucune IP trouvée, ajouter des devices de test (environnement dev uniquement)
    if (ipFoundCount === 0 && process.env.NODE_ENV !== 'production') {
      this.app.logger.warn('[NetworkManager] No IPs found - adding test devices for development');
      this.addTestDevicesIP(subnet);
    }
  }

  /**
   * Ajoute des IPs de test pour l'environnement de développement
   * @param {string} subnet - Sous-réseau
   */
  addTestDevicesIP(subnet) {
    if (process.env.NODE_ENV === 'production') return;
    const testIPs = [
      { ip: `${subnet}.1`, name: 'Routeur (Test)' },
      { ip: `${subnet}.10`, name: 'Ordinateur Bureau (Test)' },
      { ip: `${subnet}.20`, name: 'Smartphone (Test)' },
      { ip: `${subnet}.50`, name: 'Raspberry Pi (Test)' },
      { ip: `${subnet}.100`, name: 'Imprimante (Test)' }
    ];

    testIPs.forEach(({ ip, name }) => {
      if (!this.devices.has(ip)) {
        this.devices.set(ip, {
          ip,
          address: ip,
          port: '5004',
          name,
          type: 'network-ip',
          manufacturer: 'Test',
          protocol: 'IP',
          discovered: 'test'
        });
        this.app.logger.debug(`[NetworkManager] Added test IP: ${ip}`);
      }
    });

    this.app.logger.info(`[NetworkManager] ${testIPs.length} test IPs added`);
  }

  /**
   * Obtient l'adresse IP locale
   * @returns {string} Adresse IP locale
   */
  getLocalIP() {
    const interfaces = os.networkInterfaces();

    for (const name in interfaces) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }

    return '';
  }

  /**
   * Ajoute des périphériques de test (pour le développement)
   */
  addTestDevices() {
    if (process.env.NODE_ENV === 'production') return;
    // Ajouter quelques périphériques de test si aucun trouvé
    if (this.devices.size === 0) {
      this.app.logger.debug('Adding test network devices...');

      const subnet = this.getLocalSubnet();

      // Simuler quelques instruments réseau possibles
      const testDevices = [
        {
          ip: `${subnet}.100`,
          address: `${subnet}.100`,
          port: '5004',
          name: 'Roland FA-06 Network',
          type: 'network',
          manufacturer: 'Roland',
          protocol: 'RTP-MIDI'
        },
        {
          ip: `${subnet}.101`,
          address: `${subnet}.101`,
          port: '5004',
          name: 'Yamaha MODX Network',
          type: 'network',
          manufacturer: 'Yamaha',
          protocol: 'RTP-MIDI'
        }
      ];

      // Ne pas ajouter les périphériques de test en production
      // Décommenter la ligne suivante pour les tests
      // testDevices.forEach(device => this.devices.set(device.ip, device));
    }
  }

  /**
   * Arrête le scan réseau
   */
  stopScan() {
    if (this.scanning) {
      this.scanning = false;
      this.app.logger.info('Network scan stopped');
    }
  }

  /**
   * Connecte un instrument réseau via RTP-MIDI
   * @param {string} ip - Adresse IP de l'instrument
   * @param {string} port - Port (optionnel)
   * @returns {Promise<Object>} Info de connexion
   */
  async connect(ip, port = '5004') {
    this.app.logger.info(`[NetworkManager] Connecting to network instrument: ${ip}:${port}`);

    // Vérifier si l'instrument est accessible
    const isReachable = await this.checkReachability(ip);

    if (!isReachable) {
      throw new Error(`Instrument not reachable at ${ip}`);
    }

    // Récupérer les infos du périphérique depuis le cache
    let deviceInfo = this.devices.get(ip);

    if (!deviceInfo) {
      // Créer une entrée si pas encore découvert
      deviceInfo = {
        ip: ip,
        address: ip,
        port: port,
        name: `Instrument réseau (${ip})`,
        type: 'network',
        manufacturer: 'Unknown',
        protocol: 'RTP-MIDI'
      };
      this.devices.set(ip, deviceInfo);
    }

    try {
      // Créer session RTP-MIDI
      const session = new RtpMidiSession({
        localName: 'MidiMind',
        localPort: 5004
      });

      // Écouter les messages MIDI entrants
      session.on('message', (deltaTime, midiBytes) => {
        this.handleMidiData(ip, midiBytes);
      });

      // Écouter les erreurs
      session.on('error', (error) => {
        this.app.logger.error(`[NetworkManager] RTP-MIDI error for ${ip}: ${error.message}`);
      });

      // Écouter la déconnexion
      session.on('disconnected', () => {
        this.app.logger.info(`[NetworkManager] RTP-MIDI session disconnected: ${ip}`);
        this.rtpSessions.delete(ip);
        this.connectedDevices.delete(ip);

        // Émettre événement
        this.emit('network:disconnected', { ip });
      });

      // Connecter with timeout to prevent indefinite hang
      const RTP_CONNECT_TIMEOUT = 10000; // 10 seconds
      const connectTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`RTP-MIDI connection timeout after ${RTP_CONNECT_TIMEOUT}ms`)), RTP_CONNECT_TIMEOUT)
      );
      await Promise.race([session.connect(ip, parseInt(port)), connectTimeout]);

      // Stocker la session
      this.rtpSessions.set(ip, session);

      // Info de connexion
      const connectionInfo = {
        ip: ip,
        address: ip,
        port: port,
        name: deviceInfo.name,
        connected: true,
        connectedAt: new Date().toISOString(),
        session: session
      };

      this.connectedDevices.set(ip, connectionInfo);
      this.app.logger.info(`[NetworkManager] ✅ Connected to ${deviceInfo.name} (${ip}:${port}) via RTP-MIDI`);

      // Émettre événement
      this.emit('network:connected', {
        ip: ip,
        device_id: ip,
        name: deviceInfo.name
      });

      return connectionInfo;

    } catch (error) {
      this.app.logger.error(`[NetworkManager] Failed to connect RTP-MIDI to ${ip}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Vérifie si un hôte est accessible via TCP connect sur le port RTP-MIDI.
   * Utilise net.Socket au lieu de ping pour éviter le spawn de processus
   * et vérifier directement le port MIDI.
   * @param {string} ip - Adresse IP
   * @param {number} timeoutMs - Timeout en millisecondes (défaut: 2000)
   * @returns {Promise<boolean>} True si accessible
   */
  async checkReachability(ip, timeoutMs = 2000) {
    // Validate IP format
    if (!/^[\d.]+$/.test(ip) && !/^[a-fA-F\d:]+$/.test(ip)) {
      return false;
    }
    const safeTimeout = Math.max(500, Math.min(10000, parseInt(timeoutMs, 10) || 2000));

    return new Promise(resolve => {
      const socket = new net.Socket();
      socket.setTimeout(safeTimeout);
      socket.on('connect', () => { socket.destroy(); resolve(true); });
      socket.on('timeout', () => { socket.destroy(); resolve(false); });
      socket.on('error', () => { socket.destroy(); resolve(false); });
      socket.connect(5004, ip);
    });
  }

  /**
   * Déconnecte un instrument réseau
   * @param {string} ip - Adresse IP de l'instrument
   * @returns {Promise<Object>} Résultat de la déconnexion
   */
  async disconnect(ip) {
    this.app.logger.info(`[NetworkManager] Disconnecting network instrument: ${ip}`);

    const connectionInfo = this.connectedDevices.get(ip);

    if (!connectionInfo) {
      throw new Error(`Instrument not connected: ${ip}`);
    }

    try {
      // Fermer la session RTP-MIDI
      const session = this.rtpSessions.get(ip);
      if (session) {
        await session.disconnect();
        this.rtpSessions.delete(ip);
      }

      this.connectedDevices.delete(ip);
      this.app.logger.info(`[NetworkManager] ✅ Disconnected from ${ip}`);

      // Émettre événement
      this.emit('network:disconnected', {
        ip: ip,
        device_id: ip
      });

      return {
        ip: ip,
        address: ip,
        connected: false
      };

    } catch (error) {
      this.app.logger.error(`[NetworkManager] Error disconnecting ${ip}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Envoie un message MIDI à un instrument réseau
   * @param {string} ip - Adresse IP de l'instrument
   * @param {string} type - Type de message ('noteon', 'noteoff', 'cc', etc.)
   * @param {object} data - Données du message
   */
  async sendMidiMessage(ip, type, data) {
    const session = this.rtpSessions.get(ip);

    if (!session || !session.isConnected()) {
      throw new Error(`Device ${ip} not connected via RTP-MIDI`);
    }

    try {
      // Convertir format easymidi en bytes MIDI bruts
      const midiBytes = this.convertToMidiBytes(type, data);

      if (midiBytes) {
        session.sendMessage(midiBytes);
        this.app.logger.debug(`[NetworkManager] MIDI sent to ${ip}:`, type, data);
      } else {
        this.app.logger.warn(`[NetworkManager] Unsupported MIDI message type: ${type}`);
      }

    } catch (error) {
      this.app.logger.error(`[NetworkManager] Send MIDI error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Gère les données MIDI reçues d'un instrument réseau
   * @param {string} ip - Adresse IP de l'instrument
   * @param {Array<number>} midiBytes - Bytes MIDI reçus
   */
  handleMidiData(ip, midiBytes) {
    try {
      // Parser les bytes MIDI
      const parsedMessage = this.parseMidiBytes(midiBytes);

      if (parsedMessage) {
        this.app.logger.debug(`[NetworkManager] MIDI from ${ip}:`, parsedMessage.type, parsedMessage.data);

        // Émettre événement MIDI
        this.emit('midi:data', {
          ip: ip,
          address: ip,
          type: parsedMessage.type,
          data: parsedMessage.data
        });
      }

    } catch (error) {
      this.app.logger.error(`[NetworkManager] Error processing MIDI data: ${error.message}`);
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
   * Parse des bytes MIDI en format easymidi
   * @param {Array<number>} bytes - Bytes MIDI
   * @returns {Object|null} Message parsé {type, data}
   */
  parseMidiBytes(bytes) {
    if (!bytes || bytes.length === 0) {
      return null;
    }

    const status = bytes[0];
    const command = status & 0xF0;
    const channel = status & 0x0F;

    switch (command) {
      case 0x90: // Note On
        if (bytes.length >= 3) {
          return {
            type: 'noteon',
            data: { channel, note: bytes[1], velocity: bytes[2] }
          };
        }
        break;

      case 0x80: // Note Off
        if (bytes.length >= 3) {
          return {
            type: 'noteoff',
            data: { channel, note: bytes[1], velocity: bytes[2] }
          };
        }
        break;

      case 0xB0: // Control Change
        if (bytes.length >= 3) {
          return {
            type: 'cc',
            data: { channel, controller: bytes[1], value: bytes[2] }
          };
        }
        break;

      case 0xC0: // Program Change
        if (bytes.length >= 2) {
          return {
            type: 'program',
            data: { channel, number: bytes[1] }
          };
        }
        break;

      case 0xE0: // Pitch Bend
        if (bytes.length >= 3) {
          const value = (bytes[2] << 7) | bytes[1];
          return {
            type: 'pitchbend',
            data: { channel, value }
          };
        }
        break;

      case 0xA0: // Poly Aftertouch
        if (bytes.length >= 3) {
          return {
            type: 'poly aftertouch',
            data: { channel, note: bytes[1], pressure: bytes[2] }
          };
        }
        break;

      case 0xD0: // Channel Aftertouch
        if (bytes.length >= 2) {
          return {
            type: 'channel aftertouch',
            data: { channel, pressure: bytes[1] }
          };
        }
        break;
    }

    return null;
  }

  /**
   * Retourne la liste des instruments connectés
   * @returns {Array} Liste des instruments connectés
   */
  getConnectedDevices() {
    return Array.from(this.connectedDevices.values()).map(({ session, ...device }) => device);
  }

  /**
   * Vérifie l'état du NetworkManager
   * @returns {Object} État du NetworkManager
   */
  getStatus() {
    return {
      scanning: this.scanning,
      devicesFound: this.devices.size,
      connectedDevices: this.connectedDevices.size
    };
  }

  /**
   * Arrête tous les scans et déconnecte tous les instruments
   */
  async shutdown() {
    this.app.logger.info('Shutting down NetworkManager...');

    // Arrêter le scan
    this.stopScan();

    // Déconnecter tous les instruments
    const disconnectPromises = [];
    for (const ip of this.connectedDevices.keys()) {
      disconnectPromises.push(
        this.disconnect(ip).catch(err =>
          this.app.logger.error(`Error disconnecting ${ip}: ${err.message}`)
        )
      );
    }

    await Promise.all(disconnectPromises);
    this.app.logger.info('NetworkManager shutdown complete');
  }
}

export default NetworkManager;
