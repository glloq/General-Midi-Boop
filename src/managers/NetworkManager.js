// ============================================================================
// src/managers/NetworkManager.js
// ============================================================================
// Description:
//   Manages MIDI instruments over network/WiFi
//   - Scan the local network to discover instruments
//   - Connect/disconnect network instruments
//   - Manage instruments connected via network
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

    // Commonly used MIDI over network ports
    this.MIDI_NETWORK_PORTS = [
      5004, // RTP-MIDI (Apple Network MIDI)
      5353, // mDNS
      21928, // RTP-MIDI session
      7000, 7001, 7002 // Custom ports commonly used
    ];

    this.app.logger.info('NetworkManager initialized with RTP-MIDI support');
  }

  /**
   * Get the local subnet to scan
   * @returns {string} Local subnet (e.g. "192.168.1")
   */
  getLocalSubnet() {
    const interfaces = os.networkInterfaces();

    for (const name in interfaces) {
      for (const iface of interfaces[name]) {
        // Skip loopback and non-IPv4 interfaces
        if (iface.family === 'IPv4' && !iface.internal) {
          const parts = iface.address.split('.');
          // Return the class C subnet
          return `${parts[0]}.${parts[1]}.${parts[2]}`;
        }
      }
    }

    // Fallback to default subnet
    return '192.168.1';
  }

  /**
   * Scan the local network to discover instruments
   * @param {number} timeout - Timeout in seconds
   * @param {boolean} fullScan - If true, scan all subnet IPs (not just RTP-MIDI)
   * @returns {Promise<Array>} List of discovered instruments
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

      // Method 1: mDNS scan for MIDI services
      await this.scanMDNS(timeout);

      // Method 2: Full subnet scan (all IPs)
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
   * mDNS scan to discover MIDI services on the network
   * @param {number} timeout - Timeout in seconds
   */
  async scanMDNS(timeout) {
    try {
      // Use avahi-browse on Linux to discover services
      if (process.platform === 'linux') {
        this.app.logger.debug('Using avahi-browse for mDNS discovery...');

        // Scan specifically for RTP-MIDI and Apple MIDI services
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

        // Fallback: scan all services if no specific results found
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

      // Add test devices for development
      this.addTestDevices();

    } catch (error) {
      this.app.logger.warn(`mDNS scan error: ${error.message}`);
    }
  }

  /**
   * Parse the avahi-browse output
   * @param {string} output - avahi-browse output
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
          name: name || `Network instrument (${ip})`,
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
   * Full subnet scan to find all reachable IPs
   * @param {string} subnet - Subnet to scan (e.g. "192.168.1")
   * @param {number} timeout - Timeout in seconds
   */
  async scanSubnetIPs(subnet, _timeout) {
    this.app.logger.info(`[NetworkManager] Scanning full subnet ${subnet}.0/24...`);

    const pingPromises = [];
    const localIP = this.getLocalIP();
    let ipFoundCount = 0;

    // Scan IPs from .1 to .254 (exclude .0 and .255)
    for (let i = 1; i <= 254; i++) {
      // Check cancellation between batches
      if (!this.scanning) {
        this.app.logger.info(`[NetworkManager] Subnet scan cancelled at IP .${i}`);
        break;
      }

      const ip = `${subnet}.${i}`;

      // Skip our own IP
      if (ip === localIP) continue;

      // Test reachability via multi-port TCP
      const pingPromise = this.isHostReachable(ip, 1000)
        .then(isReachable => {
          if (isReachable) {
            // Don't add if already discovered via mDNS
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
          // Ignore ping errors
        });

      pingPromises.push(pingPromise);

      // Process in batches of 15 (limit concurrent connections on RPi)
      if (pingPromises.length >= 15) {
        await Promise.all(pingPromises);
        pingPromises.length = 0; // Clear the array
      }
    }

    // Wait for the remaining pings
    if (pingPromises.length > 0) {
      await Promise.all(pingPromises);
    }

    this.app.logger.info(`[NetworkManager] TCP scan done - ${ipFoundCount} IPs found, reading ARP table...`);

    // The TCP connects triggered ARP requests for each IP.
    // Read the ARP table to find hosts that responded to ARP
    // but not to TCP (firewall DROP). ARP is Layer 2, mandatory.
    const arpCount = await this.readARPTable(subnet, localIP);

    this.app.logger.info(`[NetworkManager] Subnet scan completed - ${ipFoundCount} TCP + ${arpCount} ARP, ${this.devices.size} total devices`);

    // If no IPs found, add test devices (dev environment only)
    if (this.devices.size === 0 && process.env.NODE_ENV !== 'production') {
      this.app.logger.warn('[NetworkManager] No IPs found - adding test devices for development');
      this.addTestDevicesIP(subnet);
    }
  }

  /**
   * Read the system ARP table to find active hosts.
   * After a TCP scan, the ARP table contains entries for all hosts
   * that responded to ARP requests (Layer 2), even those with firewall DROP.
   * @param {string} subnet - Subnet to filter
   * @param {string} localIP - Local IP to exclude
   * @returns {Promise<number>} Number of devices added via ARP
   */
  async readARPTable(subnet, localIP) {
    let count = 0;
    try {
      const { stdout } = await execFileAsync('ip', ['neigh', 'show'], {
        timeout: 5000
      });

      const lines = stdout.split('\n');
      for (const line of lines) {
        // Format: "192.168.1.10 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE"
        const match = line.match(/^([\d.]+)\s+.*lladdr\s+(\S+)\s+(\S+)/);
        if (!match) continue;

        const ip = match[1];
        const state = match[3]; // REACHABLE, STALE, DELAY, PROBE

        // Filter: correct subnet, not our IP, not FAILED, not already found
        if (!ip.startsWith(subnet + '.')) continue;
        if (ip === localIP) continue;
        if (state === 'FAILED') continue;
        if (this.devices.has(ip)) continue;

        this.devices.set(ip, {
          ip,
          address: ip,
          port: '5004',
          name: `Device (${ip})`,
          type: 'network-ip',
          manufacturer: 'Unknown',
          protocol: 'IP',
          discovered: 'arp'
        });
        count++;
        this.app.logger.info(`[NetworkManager] ✅ ARP found: ${ip} (${state})`);
      }
    } catch (error) {
      this.app.logger.debug(`[NetworkManager] ARP table read failed: ${error.message}`);
    }
    return count;
  }

  /**
   * Add test IPs for the development environment
   * @param {string} subnet - Subnet
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
   * Get the local IP address
   * @returns {string} Local IP address
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
   * Add test devices (for development)
   */
  addTestDevices() {
    if (process.env.NODE_ENV === 'production') return;
    // Add some test devices if none were found
    if (this.devices.size === 0) {
      this.app.logger.debug('Adding test network devices...');

      const subnet = this.getLocalSubnet();

      // Simulate some possible network instruments
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

      testDevices.forEach(device => this.devices.set(device.ip, device));
    }
  }

  /**
   * Stop the network scan
   */
  stopScan() {
    if (this.scanning) {
      this.scanning = false;
      this.app.logger.info('Network scan stopped');
    }
  }

  /**
   * Connect a network instrument via RTP-MIDI
   * @param {string} ip - Instrument IP address
   * @param {string} port - Port (optional)
   * @returns {Promise<Object>} Connection info
   */
  async connect(ip, port = '5004') {
    this.app.logger.info(`[NetworkManager] Connecting to network instrument: ${ip}:${port}`);

    // Check if the instrument is reachable
    const isReachable = await this.checkReachability(ip);

    if (!isReachable) {
      throw new Error(`Instrument not reachable at ${ip}`);
    }

    // Get device info from cache
    let deviceInfo = this.devices.get(ip);

    if (!deviceInfo) {
      // Create an entry if not yet discovered
      deviceInfo = {
        ip: ip,
        address: ip,
        port: port,
        name: `Network instrument (${ip})`,
        type: 'network',
        manufacturer: 'Unknown',
        protocol: 'RTP-MIDI'
      };
      this.devices.set(ip, deviceInfo);
    }

    try {
      // Create RTP-MIDI session
      const session = new RtpMidiSession({
        localName: 'MidiMind',
        localPort: 5004
      });

      // Listen for incoming MIDI messages
      session.on('message', (deltaTime, midiBytes) => {
        this.handleMidiData(ip, midiBytes);
      });

      // Listen for errors
      session.on('error', (error) => {
        this.app.logger.error(`[NetworkManager] RTP-MIDI error for ${ip}: ${error.message}`);
      });

      // Listen for disconnection
      session.on('disconnected', () => {
        this.app.logger.info(`[NetworkManager] RTP-MIDI session disconnected: ${ip}`);
        this.rtpSessions.delete(ip);
        this.connectedDevices.delete(ip);

        // Emit event
        this.emit('network:disconnected', { ip });
      });

      // Connect with timeout to prevent indefinite hang
      const RTP_CONNECT_TIMEOUT = 10000; // 10 seconds
      const connectTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`RTP-MIDI connection timeout after ${RTP_CONNECT_TIMEOUT}ms`)), RTP_CONNECT_TIMEOUT)
      );
      await Promise.race([session.connect(ip, parseInt(port)), connectTimeout]);

      // Store the session
      this.rtpSessions.set(ip, session);

      // Connection info
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

      // Emit event
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
   * Check if a host is reachable via TCP connect.
   * An open port (connect) OR closed port (ECONNREFUSED) proves the host is there.
   * Only a timeout indicates the host is absent or filtered.
   * @param {string} ip - IP address
   * @param {number} timeoutMs - Timeout in milliseconds (default: 1000)
   * @returns {Promise<boolean>} True if the host responds
   */
  isHostReachable(ip, timeoutMs = 1000) {
    if (!/^[\d.]+$/.test(ip)) return Promise.resolve(false);
    const safeTimeout = Math.max(500, Math.min(5000, parseInt(timeoutMs, 10) || 1000));

    return new Promise(resolve => {
      const socket = new net.Socket();
      socket.setTimeout(safeTimeout);
      socket.on('connect', () => { socket.destroy(); resolve(true); });
      socket.on('timeout', () => { socket.destroy(); resolve(false); });
      socket.on('error', (err) => {
        socket.destroy();
        // ECONNREFUSED = port closed but host reachable
        resolve(err.code === 'ECONNREFUSED');
      });
      socket.connect(80, ip);
    });
  }

  /**
   * Check if a host is reachable via TCP connect on the RTP-MIDI port.
   * Uses net.Socket instead of ping to avoid spawning processes
   * and to check the MIDI port directly.
   * @param {string} ip - IP address
   * @param {number} timeoutMs - Timeout in milliseconds (default: 2000)
   * @returns {Promise<boolean>} True if reachable
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
   * Disconnect a network instrument
   * @param {string} ip - Instrument IP address
   * @returns {Promise<Object>} Disconnection result
   */
  async disconnect(ip) {
    this.app.logger.info(`[NetworkManager] Disconnecting network instrument: ${ip}`);

    const connectionInfo = this.connectedDevices.get(ip);

    if (!connectionInfo) {
      throw new Error(`Instrument not connected: ${ip}`);
    }

    try {
      // Close the RTP-MIDI session
      const session = this.rtpSessions.get(ip);
      if (session) {
        await session.disconnect();
        this.rtpSessions.delete(ip);
      }

      this.connectedDevices.delete(ip);
      this.app.logger.info(`[NetworkManager] ✅ Disconnected from ${ip}`);

      // Emit event
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
   * Send a MIDI message to a network instrument
   * @param {string} ip - Instrument IP address
   * @param {string} type - Message type ('noteon', 'noteoff', 'cc', etc.)
   * @param {object} data - Message data
   */
  async sendMidiMessage(ip, type, data) {
    const session = this.rtpSessions.get(ip);

    if (!session || !session.isConnected()) {
      throw new Error(`Device ${ip} not connected via RTP-MIDI`);
    }

    try {
      // Convert easymidi format to raw MIDI bytes
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
   * Handle MIDI data received from a network instrument
   * @param {string} ip - Instrument IP address
   * @param {Array<number>} midiBytes - Received MIDI bytes
   */
  handleMidiData(ip, midiBytes) {
    try {
      // Parse the MIDI bytes
      const parsedMessage = this.parseMidiBytes(midiBytes);

      if (parsedMessage) {
        this.app.logger.debug(`[NetworkManager] MIDI from ${ip}:`, parsedMessage.type, parsedMessage.data);

        // Emit MIDI event
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
   * Convert an easymidi message to MIDI bytes
   * @param {string} type - Message type
   * @param {object} data - Message data
   * @returns {Array<number>} MIDI bytes
   */
  convertToMidiBytes(type, data) {
    return MidiUtils.convertToMidiBytes(type, data);
  }

  /**
   * Parse MIDI bytes into easymidi format
   * @param {Array<number>} bytes - MIDI bytes
   * @returns {Object|null} Parsed message {type, data}
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
   * Return the list of connected instruments
   * @returns {Array} List of connected instruments
   */
  getConnectedDevices() {
    return Array.from(this.connectedDevices.values()).map(({ session: _session, ...device }) => device);
  }

  /**
   * Check the NetworkManager status
   * @returns {Object} NetworkManager status
   */
  getStatus() {
    return {
      scanning: this.scanning,
      devicesFound: this.devices.size,
      connectedDevices: this.connectedDevices.size
    };
  }

  /**
   * Stop all scans and disconnect all instruments
   */
  async shutdown() {
    this.app.logger.info('Shutting down NetworkManager...');

    // Stop the scan
    this.stopScan();

    // Disconnect all instruments
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
