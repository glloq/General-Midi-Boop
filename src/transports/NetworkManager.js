/**
 * @file src/transports/NetworkManager.js
 * @description High-level manager for MIDI instruments reachable over
 * the local network (RTP-MIDI / AppleMIDI). Responsibilities:
 *   - LAN discovery via mDNS-style probes and ARP scans.
 *   - Connect / disconnect lifecycle (one {@link RtpMidiSession} per
 *     device).
 *   - Routing inbound MIDI frames to the EventBus and DeviceManager.
 *
 * The file is large (~810 LOC); only the constructor, lifecycle hooks
 * and public entry points carry full JSDoc per the plan.
 */

import EventEmitter from 'events';
import { execFile } from 'child_process';
import { promisify } from 'util';
import dgram from 'dgram';
import net from 'net';
import os from 'os';
import RtpMidiSession from './RtpMidiSession.js';
import { isControlPacket, commandOf, CMD } from './AppleMidi.js';
import MidiUtils from '../utils/MidiUtils.js';

const execFileAsync = promisify(execFile);

class NetworkManager extends EventEmitter {
  /**
   * @param {Object} deps - Service-container facade. Only `logger` is
   *   read from it; replaces the legacy `this.app` service-locator
   *   pattern.
   */
  constructor(deps) {
    super();
    this.logger = deps.logger;
    this.scanning = false;
    this.devices = new Map(); // Map of IP -> device info
    this.connectedDevices = new Map(); // Map of IP -> connection info
    this.rtpSessions = new Map(); // Map of IP -> RtpMidiSession

    // Shared AppleMIDI sockets for ALL sessions: control on rtpMidiPort and
    // data on rtpMidiPort+1 (the AppleMIDI two-port convention). Bound once so
    // remote peers can reach us on known addresses; inbound frames are demuxed
    // to the right session by sender IP. Created lazily (see `_ensureSockets`).
    this.rtpMidiPort = Number(deps.config?.network?.rtpMidiPort) || 5004;
    this._controlSocket = null;
    this._dataSocket = null;

    // Commonly used MIDI over network ports
    this.MIDI_NETWORK_PORTS = [
      5004, // RTP-MIDI (Apple Network MIDI)
      5353, // mDNS
      21928, // RTP-MIDI session
      7000,
      7001,
      7002 // Custom ports commonly used
    ];

    this.logger.info('NetworkManager initialized with RTP-MIDI support');
  }

  /**
   * First non-internal IPv4 address of this host, or '' if none.
   * @returns {string}
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
   * Get the local subnet to scan
   * @returns {string} Local subnet (e.g. "192.168.1")
   */
  getLocalSubnet() {
    const ip = this.getLocalIP();
    if (!ip) return '192.168.1';
    const [a, b, c] = ip.split('.');
    return `${a}.${b}.${c}`;
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

    this.logger.info(`Starting network scan for ${timeout}s... (fullScan: ${fullScan})`);
    this.scanning = true;
    this.devices.clear();

    try {
      const subnet = this.getLocalSubnet();
      this.logger.info(`Scanning subnet: ${subnet}.0/24`);

      // Method 1: mDNS scan for MIDI services
      await this.scanMDNS(timeout);

      // Method 2: Full subnet scan (all IPs)
      if (fullScan) {
        await this.scanSubnetIPs(subnet, timeout);
      }

      const devices = Array.from(this.devices.values());

      this.logger.info(`Network scan completed: ${devices.length} devices found`);
      this.scanning = false;

      return devices;
    } catch (error) {
      this.scanning = false;
      this.logger.error(`Network scan error: ${error.message}`);
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
        this.logger.debug('Using avahi-browse for mDNS discovery...');

        // Scan specifically for RTP-MIDI and Apple MIDI services
        const serviceTypes = ['_apple-midi._udp', '_rtpmidi._udp', '_midi._udp'];

        for (const serviceType of serviceTypes) {
          try {
            const { stdout } = await execFileAsync(
              'timeout',
              [String(timeout) + 's', 'avahi-browse', serviceType, '-t', '-r', '-p'],
              { timeout: (timeout + 1) * 1000 }
            ).catch(() => ({ stdout: '' }));

            if (stdout && stdout.trim()) {
              this.parseMDNSOutput(stdout);
              this.logger.info(`mDNS: found services for ${serviceType}`);
            }
          } catch (error) {
            this.logger.debug(`avahi-browse failed for ${serviceType}: ${error.message}`);
          }
        }

        // Fallback: scan all services if no specific results found
        if (this.devices.size === 0) {
          try {
            const { stdout } = await execFileAsync(
              'timeout',
              [String(timeout) + 's', 'avahi-browse', '-a', '-t', '-r', '-p'],
              { timeout: (timeout + 1) * 1000 }
            ).catch(() => ({ stdout: '' }));

            if (stdout && stdout.trim()) {
              this.parseMDNSOutput(stdout);
            }
          } catch (error) {
            this.logger.debug('avahi-browse -a not available or no services found');
          }
        }
      }

      // Add test devices for development
      this.addTestDevices();
    } catch (error) {
      this.logger.warn(`mDNS scan error: ${error.message}`);
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
        this.logger.debug(`mDNS device found: ${name} at ${ip}:${port}`);
      }
    }
  }

  /**
   * Full subnet scan to find all reachable IPs
   * @param {string} subnet - Subnet to scan (e.g. "192.168.1")
   * @param {number} timeout - Timeout in seconds
   */
  async scanSubnetIPs(subnet, _timeout) {
    this.logger.info(`[NetworkManager] Scanning full subnet ${subnet}.0/24...`);

    const pingPromises = [];
    const localIP = this.getLocalIP();
    let ipFoundCount = 0;

    // Scan IPs from .1 to .254 (exclude .0 and .255)
    for (let i = 1; i <= 254; i++) {
      // Check cancellation between batches
      if (!this.scanning) {
        this.logger.info(`[NetworkManager] Subnet scan cancelled at IP .${i}`);
        break;
      }

      const ip = `${subnet}.${i}`;

      // Skip our own IP
      if (ip === localIP) continue;

      // Test reachability via multi-port TCP
      const pingPromise = this.isHostReachable(ip, 1000)
        .then((isReachable) => {
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
              this.logger.info(`[NetworkManager] ✅ IP found: ${ip}`);
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

    this.logger.info(
      `[NetworkManager] TCP scan done - ${ipFoundCount} IPs found, reading ARP table...`
    );

    // The TCP connects triggered ARP requests for each IP.
    // Read the ARP table to find hosts that responded to ARP
    // but not to TCP (firewall DROP). ARP is Layer 2, mandatory.
    const arpCount = await this.readARPTable(subnet, localIP);

    this.logger.info(
      `[NetworkManager] Subnet scan completed - ${ipFoundCount} TCP + ${arpCount} ARP, ${this.devices.size} total devices`
    );

    // If no IPs found, add test devices (opt-in dev aid only)
    if (this.devices.size === 0 && this._testDevicesEnabled()) {
      this.logger.warn('[NetworkManager] No IPs found - adding test devices for development');
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
        this.logger.info(`[NetworkManager] ✅ ARP found: ${ip} (${state})`);
      }
    } catch (error) {
      this.logger.debug(`[NetworkManager] ARP table read failed: ${error.message}`);
    }
    return count;
  }

  /**
   * Whether synthetic "test" devices may be injected into scan results.
   * These are a development aid only and MUST be opt-in: gating them on
   * `NODE_ENV !== 'production'` used to leak fake instruments into real
   * deployments because `npm start` does not set NODE_ENV=production
   * (audit P2). Require an explicit `GMBOOP_NETWORK_TEST_DEVICES` flag.
   * @returns {boolean}
   * @private
   */
  _testDevicesEnabled() {
    const v = process.env.GMBOOP_NETWORK_TEST_DEVICES;
    return v === '1' || v === 'true';
  }

  /**
   * Add test IPs for the development environment
   * @param {string} subnet - Subnet
   */
  addTestDevicesIP(subnet) {
    if (!this._testDevicesEnabled()) return;
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
        this.logger.debug(`[NetworkManager] Added test IP: ${ip}`);
      }
    });

    this.logger.info(`[NetworkManager] ${testIPs.length} test IPs added`);
  }

  /**
   * Add test devices (for development)
   */
  addTestDevices() {
    if (!this._testDevicesEnabled()) return;
    // Add some test devices if none were found
    if (this.devices.size === 0) {
      this.logger.debug('Adding test network devices...');

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

      testDevices.forEach((device) => this.devices.set(device.ip, device));
    }
  }

  /**
   * Stop the network scan
   */
  stopScan() {
    if (this.scanning) {
      this.scanning = false;
      this.logger.info('Network scan stopped');
    }
  }

  /**
   * Connect a network instrument via RTP-MIDI
   * @param {string} ip - Instrument IP address
   * @param {string} port - Port (optional)
   * @returns {Promise<Object>} Connection info
   */
  async connect(ip, port = '5004') {
    this.logger.info(`[NetworkManager] Connecting to network instrument: ${ip}:${port}`);

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
      // Reconnecting to an IP that already has a session: close the old one
      // first. Without this the previous session object was simply dropped
      // from `rtpSessions` — its clock-sync interval and receiver watchdog
      // kept running, `shutdown()` could no longer reach it, and the peer was
      // never told (no BY) so it kept a half-open session (audit L04 F-49).
      const previous = this.rtpSessions.get(ip);
      if (previous) {
        this.logger.info(`[NetworkManager] Closing previous RTP-MIDI session for ${ip}`);
        this.rtpSessions.delete(ip);
        try {
          previous.close();
        } catch (err) {
          this.logger.warn(`[NetworkManager] Error closing previous session: ${err.message}`);
        }
      }

      // AppleMIDI uses a control port (default 5004) and a data port (P+1).
      // We bind ONE control socket and ONE data socket, shared by every
      // session, and demux inbound by sender IP. A second remote no longer
      // trips EADDRINUSE, we listen on the fixed known ports so peers can
      // reach us, and the session performs the real invitation handshake so
      // real AppleMIDI devices actually accept our MIDI (audit P1).
      await this._ensureSockets();
      const controlPort = parseInt(port) || this.rtpMidiPort;
      const dataPort = controlPort + 1;
      const session = new RtpMidiSession({
        localName: 'GeneralMidiBoop',
        sendControl: (buf) => this._controlSocket?.send(buf, controlPort, ip),
        sendData: (buf) => this._dataSocket?.send(buf, dataPort, ip)
      });

      // Forward parsed inbound MIDI to the EventBus/DeviceManager pipeline.
      session.on('message', (_deltaTime, midiBytes) => this.handleMidiData(ip, midiBytes));

      // Listen for errors
      session.on('error', (error) => {
        this.logger.error(`[NetworkManager] RTP-MIDI error for ${ip}: ${error.message}`);
      });

      // Listen for disconnection. This handler is the single owner of
      // teardown+notify: it runs whether the peer drops us or we call the
      // public `disconnect(ip)` (which closes the session), so the public path
      // must NOT emit again (audit A1 RTP-L5).
      session.on('disconnected', () => {
        this.logger.info(`[NetworkManager] RTP-MIDI session disconnected: ${ip}`);
        this.rtpSessions.delete(ip);
        this.connectedDevices.delete(ip);

        // Emit event
        this.emit('network:disconnected', { ip, device_id: ip });
      });

      // Register the session BEFORE the handshake so inbound OK/CK packets
      // demux to it while connecting.
      this.rtpSessions.set(ip, session);

      // The session enforces its own handshake timeout; race a manager-level
      // timeout too as a backstop. Capture the timer so it can be cleared on
      // success — otherwise it keeps the event loop alive for the full window
      // and later rejects `connectTimeout` after the race already settled,
      // producing an unhandled rejection (audit A1 RTP-L3). `unref()` keeps it
      // from holding the process open in the meantime.
      const RTP_CONNECT_TIMEOUT = 10000;
      let connectTimer = null;
      const connectTimeout = new Promise((_, reject) => {
        connectTimer = setTimeout(
          () => reject(new Error(`RTP-MIDI connection timeout after ${RTP_CONNECT_TIMEOUT}ms`)),
          RTP_CONNECT_TIMEOUT
        );
        if (connectTimer.unref) connectTimer.unref();
      });
      try {
        await Promise.race([session.connect(ip, controlPort, dataPort), connectTimeout]);
      } catch (err) {
        this.rtpSessions.delete(ip);
        session.close();
        throw err;
      } finally {
        if (connectTimer) clearTimeout(connectTimer);
      }

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
      this.logger.info(
        `[NetworkManager] ✅ Connected to ${deviceInfo.name} (${ip}:${port}) via RTP-MIDI`
      );

      // Emit event
      this.emit('network:connected', {
        ip: ip,
        device_id: ip,
        name: deviceInfo.name
      });

      return connectionInfo;
    } catch (error) {
      this.logger.error(`[NetworkManager] Failed to connect RTP-MIDI to ${ip}: ${error.message}`);
      throw error;
    }
  }

  /**
   * One-shot TCP connect probe. Resolves true on connect, false on
   * timeout; `errResolves` decides the outcome for socket errors
   * (`isHostReachable` treats ECONNREFUSED as "host present").
   * @param {string} ip
   * @param {number} port
   * @param {number} timeoutMs
   * @param {(err:Error)=>boolean} errResolves
   * @returns {Promise<boolean>}
   * @private
   */
  _tcpProbe(ip, port, timeoutMs, errResolves) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(timeoutMs);
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.on('error', (err) => {
        socket.destroy();
        resolve(errResolves(err));
      });
      socket.connect(port, ip);
    });
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
    return this._tcpProbe(ip, 80, safeTimeout, (err) => err.code === 'ECONNREFUSED');
  }

  /**
   * Check whether a host is present on the network.
   *
   * NOTE: RTP-MIDI is a UDP protocol (RFC 6295), so a TCP connect to 5004
   * does not prove RTP-MIDI reachability — nothing listens on TCP 5004 even
   * on a live AppleMIDI host, so the old probe returned false for reachable
   * hosts (audit P0-1d). A UDP probe is equally unreliable (no guaranteed
   * response), and a truthful RTP-MIDI reachability check requires the
   * AppleMIDI invitation (IN/OK) handshake, which this simplified session
   * does not yet implement. As a pragmatic host-liveness signal we treat an
   * ECONNREFUSED (a TCP RST from a reachable host) the same as a successful
   * connect; only a timeout means the host is absent or filtered.
   * @param {string} ip - IP address
   * @param {number} timeoutMs - Timeout in milliseconds (default: 2000)
   * @returns {Promise<boolean>} True if the host appears to be present
   */
  async checkReachability(ip, timeoutMs = 2000) {
    if (!/^[\d.]+$/.test(ip) && !/^[a-fA-F\d:]+$/.test(ip)) {
      return false;
    }
    const safeTimeout = Math.max(500, Math.min(10000, parseInt(timeoutMs, 10) || 2000));
    return this._tcpProbe(ip, 5004, safeTimeout, (err) => err.code === 'ECONNREFUSED');
  }

  /**
   * Disconnect a network instrument
   * @param {string} ip - Instrument IP address
   * @returns {Promise<Object>} Disconnection result
   */
  async disconnect(ip) {
    this.logger.info(`[NetworkManager] Disconnecting network instrument: ${ip}`);

    const connectionInfo = this.connectedDevices.get(ip);

    if (!connectionInfo) {
      throw new Error(`Instrument not connected: ${ip}`);
    }

    try {
      // Close the RTP-MIDI session. Its `disconnected` handler deletes the maps
      // and emits `network:disconnected` exactly once, so we must NOT emit again
      // here (audit A1 RTP-L5). Only emit ourselves when there is no live
      // session to fire that handler.
      const session = this.rtpSessions.get(ip);
      if (session) {
        await session.disconnect();
        this.rtpSessions.delete(ip); // idempotent safety net
        this.connectedDevices.delete(ip);
      } else {
        this.connectedDevices.delete(ip);
        this.emit('network:disconnected', { ip, device_id: ip });
      }

      this.logger.info(`[NetworkManager] ✅ Disconnected from ${ip}`);

      return {
        ip: ip,
        address: ip,
        connected: false
      };
    } catch (error) {
      this.logger.error(`[NetworkManager] Error disconnecting ${ip}: ${error.message}`);
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
        this.logger.debug(`[NetworkManager] MIDI sent to ${ip}:`, type, data);
      } else {
        this.logger.warn(`[NetworkManager] Unsupported MIDI message type: ${type}`);
      }
    } catch (error) {
      this.logger.error(`[NetworkManager] Send MIDI error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Bind a fresh UDP/IPv4 socket to `port` and resolve with it once it is
   * listening; reject on bind error. `reuseAddr` lets us re-bind quickly
   * across restarts.
   * @param {number} port
   * @returns {Promise<import('dgram').Socket>}
   * @private
   */
  _bindSocket(port) {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const onError = (err) => {
        socket.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        socket.removeListener('error', onError);
        resolve(socket);
      };
      socket.once('error', onError);
      socket.once('listening', onListening);
      socket.bind(port);
    });
  }

  /**
   * Lazily bind the shared AppleMIDI control (rtpMidiPort) and data
   * (rtpMidiPort+1) UDP sockets used by every session. If a port is busy we
   * fall back to an ephemeral send-only socket (outbound still works, inbound
   * on that channel disabled) rather than failing the connection.
   * @returns {Promise<void>}
   * @private
   */
  async _ensureSockets() {
    if (this._controlSocket && this._dataSocket) return;

    // Concurrent callers (two simultaneous connect()s) would both pass the
    // check above and race the bind — double-binding the same UDP port leaks a
    // socket and can leave 5004 mis-bound. Share one in-flight init promise so
    // late callers await the same bind (audit A1 RTP-M2).
    if (this._ensureSocketsPromise) return this._ensureSocketsPromise;

    const bindOrEphemeral = async (port, label) => {
      try {
        const s = await this._bindSocket(port);
        this.logger.info(`[NetworkManager] RTP-MIDI ${label} listening on udp/${port}`);
        return s;
      } catch (err) {
        this.logger.warn(
          `[NetworkManager] Cannot bind RTP-MIDI ${label} port ${port} (${err.message}); ` +
            'using an ephemeral send-only socket'
        );
        return this._bindSocket(0);
      }
    };

    this._ensureSocketsPromise = (async () => {
      if (!this._controlSocket) {
        this._controlSocket = await bindOrEphemeral(this.rtpMidiPort, 'control');
        this._controlSocket.on('message', (msg, rinfo) => this._handleControlInbound(msg, rinfo));
        this._controlSocket.on('error', (err) =>
          this.logger.error(`[NetworkManager] RTP-MIDI control socket error: ${err.message}`)
        );
      }
      if (!this._dataSocket) {
        this._dataSocket = await bindOrEphemeral(this.rtpMidiPort + 1, 'data');
        this._dataSocket.on('message', (msg, rinfo) => this._handleDataInbound(msg, rinfo));
        this._dataSocket.on('error', (err) =>
          this.logger.error(`[NetworkManager] RTP-MIDI data socket error: ${err.message}`)
        );
      }
    })();

    try {
      await this._ensureSocketsPromise;
    } finally {
      // Clear so a later re-init (after shutdown() nulls the sockets) rebinds.
      this._ensureSocketsPromise = null;
    }
  }

  /**
   * Demultiplex a CONTROL-port datagram to the session for the sender IP. An
   * invitation from an unknown peer spins up a responder session so other
   * devices can initiate a session with us.
   * @param {Buffer} msg
   * @param {{address:string}} rinfo
   * @private
   */
  _handleControlInbound(msg, rinfo) {
    let session = this.rtpSessions.get(rinfo.address);
    if (!session && isControlPacket(msg) && commandOf(msg) === CMD.INVITATION) {
      // Answer on the port the invitation actually came FROM. An AppleMIDI
      // initiator picks its own control port (macOS/iOS advertise a dynamic
      // one over Bonjour); replying to our own `rtpMidiPort` only ever worked
      // when the peer happened to use the same number, so inbound sessions
      // from a real device silently never completed (audit L04 F-50).
      session = this._createResponderSession(rinfo.address, rinfo.port);
    }
    if (!session) return;
    try {
      session.handleControlPacket(msg);
    } catch (err) {
      this.logger.debug(
        `[NetworkManager] control parse error from ${rinfo.address}: ${err.message}`
      );
    }
  }

  /**
   * Demultiplex a DATA-port datagram (AppleMIDI control or RTP-MIDI) to the
   * session for the sender IP.
   * @param {Buffer} msg
   * @param {{address:string}} rinfo
   * @private
   */
  _handleDataInbound(msg, rinfo) {
    const session = this.rtpSessions.get(rinfo.address);
    if (!session) return;
    try {
      session.handleDataPacket(msg);
    } catch (err) {
      this.logger.debug(`[NetworkManager] data parse error from ${rinfo.address}: ${err.message}`);
    }
  }

  /**
   * Create a session that ACCEPTS an inbound invitation from `ip` (we are the
   * responder). Wired identically to an initiated session.
   * @param {string} ip
   * @param {number} [remoteControlPort] - Source port of the invitation; the
   *   peer's data port is assumed to be `remoteControlPort + 1` (the AppleMIDI
   *   two-port convention). Defaults to our own `rtpMidiPort`.
   * @returns {RtpMidiSession}
   * @private
   */
  _createResponderSession(ip, remoteControlPort = this.rtpMidiPort) {
    const controlPort = Number(remoteControlPort) || this.rtpMidiPort;
    const dataPort = controlPort + 1;
    const session = new RtpMidiSession({
      localName: 'GeneralMidiBoop',
      sendControl: (buf) => this._controlSocket?.send(buf, controlPort, ip),
      sendData: (buf) => this._dataSocket?.send(buf, dataPort, ip)
    });
    session.remoteHost = ip;
    session.remoteControlPort = controlPort;
    session.remoteDataPort = dataPort;
    session.on('message', (_dt, midiBytes) => this.handleMidiData(ip, midiBytes));
    session.on('connected', () => {
      this.connectedDevices.set(ip, {
        ip,
        address: ip,
        port: String(controlPort),
        name: this.devices.get(ip)?.name || `Network MIDI (${ip})`,
        connected: true,
        connectedAt: new Date().toISOString(),
        session
      });
      this.logger.info(`[NetworkManager] ✅ Accepted inbound RTP-MIDI session from ${ip}`);
      this.emit('network:connected', { ip, device_id: ip, name: `Network MIDI (${ip})` });
    });
    session.on('disconnected', () => {
      this.rtpSessions.delete(ip);
      this.connectedDevices.delete(ip);
      this.emit('network:disconnected', { ip, device_id: ip });
    });
    session.on('error', (error) =>
      this.logger.error(`[NetworkManager] RTP-MIDI error for ${ip}: ${error.message}`)
    );

    // Establishment watchdog (audit P3). A responder session is registered on
    // the first inbound control-port packet, but if the peer never sends the
    // data-port invitation the session would linger in rtpSessions forever
    // (idle, connected=false, never emitting 'disconnected'). Close it if the
    // handshake hasn't completed within the window; close() emits 'disconnected'
    // which removes it via the handler above. Cleared once connected.
    const establishTimer = setTimeout(() => {
      if (!session.isConnected()) {
        this.logger.warn(
          `[NetworkManager] inbound RTP-MIDI session from ${ip} did not establish; closing`
        );
        session.close();
      }
    }, 10000);
    if (typeof establishTimer.unref === 'function') establishTimer.unref();
    session.on('connected', () => clearTimeout(establishTimer));
    session.on('disconnected', () => clearTimeout(establishTimer));

    this.rtpSessions.set(ip, session);
    return session;
  }

  /**
   * Handle MIDI data received from a network instrument
   * @param {string} ip - Instrument IP address
   * @param {Array<number>} midiBytes - Received MIDI bytes
   */
  handleMidiData(ip, midiBytes) {
    try {
      // System messages — SysEx (0xF0), System Common (0xF1–0xF7) and System
      // Real-Time (0xF8–0xFF) — are not channel-voice, so parseMidiBytes (which
      // only switches on 0x80–0xE0) returns null and drops them: a network
      // keyboard's SysEx Identity Reply never reached parseIdentityReply and
      // inbound MIDI clock/transport was ignored (BLE and serial both handle
      // these). Forward the raw bytes so DeviceManager.handleRawMidi parses them
      // (Application routes an Array-shaped `data` through handleRawMidi).
      const status = Array.isArray(midiBytes) ? midiBytes[0] : undefined;
      if (status != null && (status & 0xf0) === 0xf0) {
        this.emit('midi:data', { ip, address: ip, data: Array.from(midiBytes) });
        return;
      }

      // Parse the MIDI bytes
      const parsedMessage = this.parseMidiBytes(midiBytes);

      if (parsedMessage) {
        this.logger.debug(
          `[NetworkManager] MIDI from ${ip}:`,
          parsedMessage.type,
          parsedMessage.data
        );

        // Emit MIDI event
        this.emit('midi:data', {
          ip: ip,
          address: ip,
          type: parsedMessage.type,
          data: parsedMessage.data
        });
      }
    } catch (error) {
      this.logger.error(`[NetworkManager] Error processing MIDI data: ${error.message}`);
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
    const command = status & 0xf0;
    const channel = status & 0x0f;

    switch (command) {
      case 0x90: // Note On
        if (bytes.length >= 3) {
          return { type: 'noteon', data: { channel, note: bytes[1], velocity: bytes[2] } };
        }
        break;
      case 0x80: // Note Off
        if (bytes.length >= 3) {
          return { type: 'noteoff', data: { channel, note: bytes[1], velocity: bytes[2] } };
        }
        break;
      case 0xb0: // Control Change
        if (bytes.length >= 3) {
          return { type: 'cc', data: { channel, controller: bytes[1], value: bytes[2] } };
        }
        break;
      case 0xc0: // Program Change
        if (bytes.length >= 2) {
          return { type: 'program', data: { channel, number: bytes[1] } };
        }
        break;
      case 0xe0: // Pitch Bend
        if (bytes.length >= 3) {
          return { type: 'pitchbend', data: { channel, value: (bytes[2] << 7) | bytes[1] } };
        }
        break;
      case 0xa0: // Poly Aftertouch
        if (bytes.length >= 3) {
          return { type: 'poly aftertouch', data: { channel, note: bytes[1], pressure: bytes[2] } };
        }
        break;
      case 0xd0: // Channel Aftertouch
        if (bytes.length >= 2) {
          return { type: 'channel aftertouch', data: { channel, pressure: bytes[1] } };
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
    return Array.from(this.connectedDevices.values()).map(
      ({ session: _session, ...device }) => device
    );
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
    this.logger.info('Shutting down NetworkManager...');

    // Stop the scan
    this.stopScan();

    // Disconnect all instruments
    const disconnectPromises = [];
    for (const ip of this.connectedDevices.keys()) {
      disconnectPromises.push(
        this.disconnect(ip).catch((err) =>
          this.logger.error(`Error disconnecting ${ip}: ${err.message}`)
        )
      );
    }

    await Promise.all(disconnectPromises);

    // Close any sessions still pending: responder sessions mid-handshake are
    // registered in `rtpSessions` but never entered `connectedDevices`, so the
    // loop above misses them — leaving their establishment watchdog timers
    // holding the process open (audit A1 RTP-L6). close() emits 'disconnected',
    // whose handler removes them from the map as we iterate (safe for Map).
    for (const session of this.rtpSessions.values()) {
      try {
        session.close();
      } catch (err) {
        this.logger.error(`Error closing pending RTP-MIDI session: ${err.message}`);
      }
    }
    this.rtpSessions.clear();

    // Close the shared control + data sockets last, after all sessions are gone.
    const closeSocket = (sock) =>
      sock ? new Promise((resolve) => sock.close(resolve)) : Promise.resolve();
    await Promise.all([closeSocket(this._controlSocket), closeSocket(this._dataSocket)]);
    this._controlSocket = null;
    this._dataSocket = null;

    this.logger.info('NetworkManager shutdown complete');
  }
}

export default NetworkManager;
