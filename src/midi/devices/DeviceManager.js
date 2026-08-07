/**
 * @file src/midi/devices/DeviceManager.js
 * @description Authoritative registry of every MIDI device the
 * application can talk to. Owns the inputs/outputs maps, the virtual
 * device list, the per-device rate-limit state, and the high-level
 * dispatch (`sendMessage`) used by the router and the API.
 *
 * Hot-plug discovery, USB-serial detection, and the system-device
 * filter are delegated to {@link DeviceDiscovery}; this class
 * subscribes to the discovery's change callbacks to keep the in-memory
 * maps in sync.
 *
 * Optional dependency `easymidi` (native ALSA bindings) — when missing,
 * `midiAvailable` flips to `false` and stub classes prevent imports
 * elsewhere from crashing.
 */
import DeviceDiscovery from './DeviceDiscovery.js';
import {
  DEVICE_STATUS,
  PRIORITY_MSG_TYPES,
  SEND_STATUS,
  DEVICE_MSG_TYPES
} from '../../core/constants.js';
import MidiUtils from '../../utils/MidiUtils.js';
import { assembleChunks } from '../instrument/DescriptorProtocol.js';

let easymidi;
/**
 * True when the native MIDI library loaded successfully. When false
 * the manager keeps running but every send is a no-op so the rest of
 * the app can boot in development environments without ALSA.
 * @type {boolean}
 */
let midiAvailable = false;
try {
  easymidi = (await import('easymidi')).default;
  midiAvailable = true;
} catch (e) {
  // Native MIDI library not available (missing ALSA headers or build tools)
  // Server will still start but without hardware MIDI support
  // eslint-disable-next-line no-console
  console.warn(`[DeviceManager] MIDI library not available: ${e.message}`);
  easymidi = {
    getInputs: () => [],
    getOutputs: () => [],
    Input: class {
      constructor() {
        throw new Error('MIDI not available');
      }
    },
    Output: class {
      constructor() {
        throw new Error('MIDI not available');
      }
    }
  };
}

// Automatic recognition tuning. On connect GMBoop probes each device once
// (debounced to coalesce a device's input+output ports), then re-probes on no
// reply up to a small cap.
const AUTO_IDENTITY_DEBOUNCE_MS = 750;
const AUTO_IDENTITY_REPLY_TIMEOUT_MS = 5000;
const AUTO_IDENTITY_MAX_ATTEMPTS = 3;

// Level-1 descriptor transfer (block 0x10): per-chunk request timeout + retries.
const DESCRIPTOR_CHUNK_TIMEOUT_MS = 5000;
const DESCRIPTOR_MAX_ATTEMPTS = 3;

/**
 * Stateful MIDI device manager. Registered as `deviceManager` in the
 * DI container.
 */
class DeviceManager {
  /**
   * @param {Object} deps - Service-container facade. The manager
   *   reads `logger`, `eventBus`, `database`, `instrumentRepository`
   *   at construction time, and looks up `wsServer`, `midiRouter`,
   *   `networkManager`, `serialMidiManager`, `bluetoothManager`
   *   lazily through getters (those may register after the device
   *   manager or be entirely absent on non-Pi hosts).
   */
  constructor(deps) {
    this.logger = deps.logger;
    this.eventBus = deps.eventBus;
    this.database = deps.database;
    // `instrumentRepository` is registered AFTER DeviceManager in
    // Application.initialize (line 297 vs 217) — eager capture would
    // freeze `undefined` and `_restoreVirtualDevicesFromDB` would
    // permanently short-circuit. Lazy getter so the live repo is
    // picked up when it appears.
    for (const name of [
      'wsServer',
      'midiRouter',
      'networkManager',
      'serialMidiManager',
      'bluetoothManager',
      'instrumentRepository',
      'descriptorService'
    ]) {
      Object.defineProperty(this, name, {
        get: () => deps[name],
        configurable: true
      });
    }

    this.devices = new Map();
    this.inputs = new Map();
    this.outputs = new Map();
    this.virtualDevices = new Map();
    /** Soft virtual devices — no MIDI port, messages logged to debug monitor. */
    this.softVirtualDevices = new Map();

    // Automatic identity recognition on connect. `_identityProbes` holds the
    // per-device debounce/reply timers + whether a reply was seen;
    // `_announcedDevices` dedupes the `device_connected` emit across a device's
    // input and output ports.
    this._autoIdentity = true;
    this._identityProbes = new Map();
    this._announcedDevices = new Set();

    // In-flight block 0x10 descriptor transfers: deviceName -> fetch state.
    this._descriptorFetches = new Map();
    // Last successfully-applied descriptor revision per device (ETag, §7 step 4).
    this._descriptorRevisions = new Map();

    this.midiAvailable = midiAvailable;

    // Rate limiting state
    this._rateLimitCounters = new Map(); // deviceId -> { count, windowStart }
    this._rateLimitCache = new Map(); // deviceId -> limit (0 = unlimited)

    // Listen for device settings changes to refresh rate limit cache
    this.eventBus?.on('device_settings_changed', ({ deviceId }) => {
      this._rateLimitCache.delete(deviceId);
    });

    // Hot-path cache: friendly instrument name per `device|channel`,
    // attached to `monitor_event` broadcasts. Without it every outbound
    // MIDI message hit SQLite (getInstrumentSettings) synchronously while
    // a monitor was active — a blocking DB call on the realtime send path.
    // Mirrors MidiRouter._instrumentNameByDevCh; same invalidation event.
    /** @type {Map<string, ?string>} */
    this._instrumentNameByDevCh = new Map();
    this.eventBus?.on('instrument_settings_changed', () => {
      this._instrumentNameByDevCh.clear();
    });

    // Delegate discovery, hot-plug monitoring, and USB serial detection
    this.discovery = new DeviceDiscovery(deps, easymidi, midiAvailable);
    this.discovery.setChangeCallbacks(
      async (change) => {
        // Handle individual device changes from hot-plug monitoring
        if (change.type === 'addInput') {
          this.addInput(change.name);
        } else if (change.type === 'addOutput') {
          this.addOutput(change.name);
        } else if (change.type === 'update') {
          await this.updateDeviceMap();
          // A hot-plug `update` also fires on removal (ports already closed by
          // DeviceDiscovery); reconcile our per-device recognition state so a
          // disconnected device is forgotten and can re-announce on reconnect.
          this._pruneDisconnectedDeviceState();
          this.broadcastDeviceList();
          this.logger.info(`Device list updated: ${this.devices.size} device(s)`);
        }
      },
      async () => {
        // Full rescan callback
        await this.scanDevices();
      }
    );

    if (!midiAvailable) {
      this.logger.warn(
        'DeviceManager initialized WITHOUT hardware MIDI support (native library not available)'
      );
    } else {
      this.logger.info('DeviceManager initialized');
    }
  }

  /**
   * Full rescan of available MIDI hardware. Closes/reopens ports as
   * needed, rebuilds the device map, broadcasts the result over WS, and
   * restarts hot-plug monitoring. Safe to call repeatedly — used both
   * at boot and via the `device_refresh` API command.
   *
   * @returns {Promise<Object[]>} Snapshot of the device list after the scan.
   */
  async scanDevices() {
    await this.discovery.scanAndReopen(
      this.inputs,
      this.outputs,
      (name) => this.addInput(name),
      (name) => this.addOutput(name)
    );

    // Clear devices before rebuilding
    this.devices.clear();

    // Update devices map
    await this.updateDeviceMap();

    // Broadcast device list
    this.broadcastDeviceList();

    const deviceList = this.getDeviceList();
    this.logger.info(`Scan complete: ${deviceList.length} device(s) found`);

    // Re-register virtual instruments from DB so they survive restarts
    await this._restoreVirtualDevicesFromDB();

    // Restart hot-plug monitoring with fresh device lists
    this.discovery.stopHotPlugMonitoring();
    this.discovery.startHotPlugMonitoring(this.inputs, this.outputs);

    return this.getDeviceList();
  }

  /**
   * Re-hydrate softVirtualDevices from the instruments_latency table so
   * virtual instruments created in previous sessions are still reachable
   * after a server restart.
   *
   * @returns {Promise<void>}
   */
  async _restoreVirtualDevicesFromDB() {
    if (!this.instrumentRepository) return;
    try {
      const instruments = this.instrumentRepository.findAllWithCapabilities();
      const seen = new Set();
      for (const inst of instruments) {
        const deviceId = inst.device_id;
        if (!deviceId?.startsWith('virtual_') || seen.has(deviceId)) continue;
        seen.add(deviceId);
        if (!this.softVirtualDevices.has(deviceId)) {
          const name = inst.custom_name || inst.name || deviceId;
          this.softVirtualDevices.set(deviceId, {
            id: deviceId,
            name,
            type: 'virtual',
            enabled: true
          });
          this.devices.set(deviceId, {
            id: deviceId,
            name,
            type: 'virtual',
            input: false,
            output: true,
            enabled: true,
            connected: true,
            status: DEVICE_STATUS.CONNECTED,
            usbSerialNumber: null
          });
        }
      }
      if (seen.size > 0) {
        this.logger.info(`Restored ${seen.size} virtual device(s) from database`);
      }
    } catch (e) {
      this.logger.warn(`Failed to restore virtual devices from DB: ${e.message}`);
    }
  }

  /**
   * Open an input port by name and wire its message listener. No-op
   * when already opened or when the port is classified as a system
   * device (Midi Through, etc.).
   *
   * @param {string} name
   * @returns {void}
   */
  addInput(name) {
    if (this.inputs.has(name)) {
      return;
    }

    try {
      const input = new easymidi.Input(name);

      // Add error listener to detect device issues
      input.on('error', (error) => {
        this.logger.error(`Input device error ${name}: ${error.message}`);
      });

      // Handle MIDI messages
      input.on('noteon', (msg) => this.handleMidiMessage(name, 'noteon', msg));
      input.on('noteoff', (msg) => this.handleMidiMessage(name, 'noteoff', msg));
      input.on('cc', (msg) => this.handleMidiMessage(name, 'cc', msg));
      input.on('program', (msg) => this.handleMidiMessage(name, 'program', msg));
      // easymidi emits pitch bend as `'pitch'` with a raw 14-bit `value`
      // (0..16383, center 8192) — NOT `'pitchbend'`, so the old listener never
      // fired and USB pitch-bend INPUT was silently dropped (audit P0). Map it
      // to the canonical `'pitchbend'` type with an unambiguous `value14` so
      // every downstream encoder (BLE/net/serial + USB out) reproduces it.
      input.on('pitch', (msg) =>
        this.handleMidiMessage(name, 'pitchbend', { channel: msg.channel, value14: msg.value })
      );
      input.on('poly aftertouch', (msg) => this.handleMidiMessage(name, 'poly aftertouch', msg));
      input.on('channel aftertouch', (msg) =>
        this.handleMidiMessage(name, 'channel aftertouch', msg)
      );
      input.on('sysex', (msg) => this.handleMidiMessage(name, 'sysex', msg));

      this.inputs.set(name, input);
      this._onDevicePortAdded(name, 'input');
    } catch (error) {
      this.logger.error(`Cannot open input ${name}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Open an output port by name. No-op when already opened or when the
   * port is a system device.
   *
   * @param {string} name
   * @returns {void}
   */
  addOutput(name) {
    if (this.outputs.has(name)) {
      return;
    }

    try {
      const output = new easymidi.Output(name);
      this.outputs.set(name, output);
      this._onDevicePortAdded(name, 'output');
    } catch (error) {
      this.logger.error(`Cannot open output ${name}: ${error.message}`);
      throw error;
    }
  }

  /**
   * React to a newly opened device port: announce the device once on the
   * EventBus (`device_connected` — previously never emitted, so the UI and the
   * clock generator's device cache never learned of hot-plugged devices) and
   * kick off a debounced automatic identity probe. The probe is what makes
   * recognition automatic; until now it only ran when the Loop Editor opened.
   *
   * @param {string} name
   * @param {'input'|'output'} kind
   * @returns {void}
   */
  _onDevicePortAdded(name, kind) {
    if (!this._announcedDevices.has(name)) {
      this._announcedDevices.add(name);
      this.eventBus?.emit('device_connected', { device: name, kind });
    }
    this._scheduleAutoIdentityProbe(name);
  }

  /**
   * Debounce an automatic identity probe for `name`. Coalesces the input- and
   * output-port adds of the same device, and is a no-op once the device has
   * replied or while a probe is already in flight.
   *
   * @param {string} name
   * @returns {void}
   */
  _scheduleAutoIdentityProbe(name) {
    if (!this._autoIdentity) return;
    let probe = this._identityProbes.get(name);
    if (probe?.identified) return;
    if (probe?.debounceTimer || probe?.replyTimer) return;
    if (!probe) {
      probe = { attempts: 0, identified: false, debounceTimer: null, replyTimer: null };
      this._identityProbes.set(name, probe);
    }
    probe.debounceTimer = setTimeout(() => {
      probe.debounceTimer = null;
      this._sendAutoIdentity(name);
    }, AUTO_IDENTITY_DEBOUNCE_MS);
    if (typeof probe.debounceTimer?.unref === 'function') probe.debounceTimer.unref();
  }

  /**
   * Send one identity probe to `name` and arm a reply timeout that retries up
   * to {@link AUTO_IDENTITY_MAX_ATTEMPTS}. Skips devices with no output port
   * (nothing to send the request through — e.g. a DIN-IN-only keyboard),
   * leaving the probe armed for when an output for the same name appears.
   *
   * @param {string} name
   * @returns {void}
   */
  _sendAutoIdentity(name) {
    const probe = this._identityProbes.get(name);
    if (!probe || probe.identified) return;
    if (!this.outputs.has(name)) return; // no return path → cannot auto-recognise
    probe.attempts += 1;
    try {
      this.sendIdentityRequest(name);
    } catch (e) {
      this.logger?.debug?.(`Auto identity probe skipped for ${name}: ${e.message}`);
      return;
    }
    probe.replyTimer = setTimeout(() => {
      probe.replyTimer = null;
      if (probe.identified) return;
      if (probe.attempts < AUTO_IDENTITY_MAX_ATTEMPTS) {
        this._sendAutoIdentity(name);
      } else {
        this.logger?.debug?.(`No identity reply from ${name} after ${probe.attempts} attempt(s)`);
      }
    }, this._getCommTimeoutMs(name));
    if (typeof probe.replyTimer?.unref === 'function') probe.replyTimer.unref();
  }

  /**
   * Resolve the identity-reply timeout for a device from its persisted
   * `comm_timeout` (audit P1: the per-device value was stored but never read —
   * recognition always used the 5 s default). Uses the largest `comm_timeout`
   * across the device's channels so a slow instrument on any channel is given
   * enough time to answer, and falls back to the default when the device has no
   * row yet (first contact) or the value is unset/invalid.
   *
   * @param {string} name
   * @returns {number} Milliseconds to wait for an identity reply.
   */
  _getCommTimeoutMs(name) {
    try {
      const rows = this.database?.getInstrumentsByDevice?.(name);
      if (Array.isArray(rows) && rows.length > 0) {
        const timeouts = rows
          .map((r) => r.comm_timeout)
          .filter((t) => Number.isInteger(t) && t > 0);
        if (timeouts.length > 0) return Math.max(...timeouts);
      }
    } catch {
      /* fall through to the default */
    }
    return AUTO_IDENTITY_REPLY_TIMEOUT_MS;
  }

  /**
   * Mark a device as recognised, cancelling any pending probe/retry timers.
   * Called from the SysEx handler when an identity reply is parsed.
   *
   * @param {string} name
   * @returns {void}
   */
  _markIdentified(name) {
    let probe = this._identityProbes.get(name);
    if (!probe) {
      probe = { attempts: 0, identified: true, debounceTimer: null, replyTimer: null };
      this._identityProbes.set(name, probe);
      return;
    }
    probe.identified = true;
    if (probe.debounceTimer) {
      clearTimeout(probe.debounceTimer);
      probe.debounceTimer = null;
    }
    if (probe.replyTimer) {
      clearTimeout(probe.replyTimer);
      probe.replyTimer = null;
    }
  }

  /**
   * Decode a block 0x10 descriptor-transfer response (docs/SYSEX_IDENTITY.md §3):
   *   F0 7D 00 10 01 <total[2]> <index[2]> <payload...> F7
   * `total`/`index` are 14-bit little-endian (2×7-bit); `payload` is ASCII.
   * Returns null when the frame is not a 0x10 response.
   *
   * @param {number[]} bytes
   * @returns {?{total:number, index:number, payload:string}}
   */
  parseDescriptorChunk(bytes) {
    if (!Array.isArray(bytes) || bytes.length < 10) return null;
    if (bytes[0] !== 0xf0 || bytes[1] !== 0x7d || bytes[2] !== 0x00) return null;
    if (bytes[3] !== 0x10 || bytes[4] !== 0x01 || bytes[bytes.length - 1] !== 0xf7) return null;
    const total = (bytes[5] & 0x7f) | ((bytes[6] & 0x7f) << 7);
    const index = (bytes[7] & 0x7f) | ((bytes[8] & 0x7f) << 7);
    let payload = '';
    for (let i = 9; i < bytes.length - 1; i++) payload += String.fromCharCode(bytes[i] & 0x7f);
    return { total, index, payload };
  }

  /**
   * Begin fetching a level-1 capability descriptor over block 0x10 — sequential
   * per-chunk requests with a per-chunk timeout and bounded retries. No-op when
   * already fetching this device, when it has no output to request through, or
   * when no DescriptorService is wired. On completion the reassembled JSON is
   * validated and applied by DescriptorService (docs/SYSEX_IDENTITY.md §7).
   *
   * @param {string} deviceName
   * @returns {void}
   */
  _startDescriptorFetch(deviceName, revision = null) {
    const inFlight = this._descriptorFetches.get(deviceName);
    if (inFlight) {
      // §3/§4: a change notification mid-transfer carrying a NEWER revision must
      // abandon the now-stale in-flight transfer and restart; an equal or absent
      // revision lets the current transfer finish (re-entrant no-op).
      if (revision == null || inFlight.revision === revision) return;
      if (inFlight.timer) clearTimeout(inFlight.timer);
      this._descriptorFetches.delete(deviceName);
    }
    // §7 step 4: the revision is an ETag — skip the transfer when the descriptor
    // we last applied for this device is unchanged.
    if (revision != null && this._descriptorRevisions.get(deviceName) === revision) return;
    if (!this.outputs.has(deviceName)) return;
    if (!this.descriptorService) return;
    this._descriptorFetches.set(deviceName, {
      chunks: [],
      total: null,
      nextIndex: 0,
      attempts: 0,
      timer: null,
      revision
    });
    this._requestNextDescriptorChunk(deviceName);
  }

  /**
   * Request the next descriptor chunk (or finish once all are in), arming a
   * retry timeout.
   *
   * @param {string} deviceName
   * @returns {void}
   */
  _requestNextDescriptorChunk(deviceName) {
    const state = this._descriptorFetches.get(deviceName);
    if (!state) return;
    if (state.total != null && state.nextIndex >= state.total) {
      this._finishDescriptorFetch(deviceName);
      return;
    }
    const index = state.nextIndex;
    try {
      this.outputs
        .get(deviceName)
        ?.send('sysex', [0xf0, 0x7d, 0x00, 0x10, 0x00, index & 0x7f, (index >> 7) & 0x7f, 0xf7]);
    } catch (e) {
      this.logger?.debug?.(`Descriptor chunk request failed for ${deviceName}: ${e.message}`);
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      state.attempts += 1;
      if (state.attempts < DESCRIPTOR_MAX_ATTEMPTS) {
        this._requestNextDescriptorChunk(deviceName); // retry same index
      } else {
        this.logger?.warn?.(
          `Descriptor transfer from ${deviceName} timed out; falling back to level 0`
        );
        this._descriptorFetches.delete(deviceName);
      }
    }, DESCRIPTOR_CHUNK_TIMEOUT_MS);
    if (typeof state.timer?.unref === 'function') state.timer.unref();
  }

  /**
   * Accept a received descriptor chunk, then request the next one.
   *
   * @param {string} deviceName
   * @param {{total:number,index:number,payload:string}} chunk
   * @returns {void}
   */
  _onDescriptorChunk(deviceName, chunk) {
    const state = this._descriptorFetches.get(deviceName);
    if (!state) return;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.total = chunk.total;
    state.chunks.push({ index: chunk.index, total: chunk.total, payload: chunk.payload });
    state.attempts = 0;
    state.nextIndex = chunk.index + 1;
    this._requestNextDescriptorChunk(deviceName);
  }

  /**
   * Reassemble, parse and apply a completed descriptor transfer. Any failure
   * (incomplete, invalid JSON) falls back to level 0 (§7 step 6).
   *
   * @param {string} deviceName
   * @returns {void}
   */
  _finishDescriptorFetch(deviceName) {
    const state = this._descriptorFetches.get(deviceName);
    this._descriptorFetches.delete(deviceName);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    const { complete, json } = assembleChunks(state.chunks);
    if (!complete || !json) {
      this.logger?.warn?.(
        `Descriptor transfer from ${deviceName} incomplete; falling back to level 0`
      );
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      this.logger?.warn?.(
        `Descriptor JSON from ${deviceName} invalid (${e.message}); falling back to level 0`
      );
      return;
    }
    try {
      const result = this.descriptorService?.applyDescriptor(deviceName, parsed);
      // Record the applied revision so an unchanged one is not re-fetched (§7).
      if (result?.applied && state.revision != null) {
        this._descriptorRevisions.set(deviceName, state.revision);
      }
    } catch (e) {
      this.logger?.warn?.(`Failed to apply descriptor from ${deviceName}: ${e.message}`);
    }
  }

  /**
   * Decode a block 0x11 change notification (docs/SYSEX_IDENTITY.md §4):
   *   F0 7D 00 11 02 <revision[5]> <change_flags> F7
   * `revision` is a 32-bit value 7-bit-encoded over 5 bytes. Returns null when
   * the frame is not a 0x11 notification.
   *
   * @param {number[]} bytes
   * @returns {?{revision:number, changeFlags:Object}}
   */
  parseChangeNotification(bytes) {
    if (!Array.isArray(bytes) || bytes.length !== 12) return null;
    if (bytes[0] !== 0xf0 || bytes[1] !== 0x7d || bytes[2] !== 0x00) return null;
    if (bytes[3] !== 0x11 || bytes[4] !== 0x02 || bytes[11] !== 0xf7) return null;
    const revision =
      ((bytes[5] & 0x7f) |
        ((bytes[6] & 0x7f) << 7) |
        ((bytes[7] & 0x7f) << 14) |
        ((bytes[8] & 0x7f) << 21) |
        ((bytes[9] & 0x0f) << 28)) >>>
      0;
    const flags = bytes[10];
    return {
      revision,
      changeFlags: {
        identityChanged: (flags & 0x01) !== 0,
        instrumentsChanged: (flags & 0x02) !== 0,
        timingChanged: (flags & 0x04) !== 0,
        restartRequired: (flags & 0x08) !== 0
      }
    };
  }

  /**
   * React to a runtime change notification (§4): re-fetch and re-apply the
   * descriptor when the identity, instruments, or timing changed. A
   * restart-only flag is logged but triggers no re-fetch on its own.
   *
   * @param {string} deviceName
   * @param {{revision:number, changeFlags:Object}} notif
   * @returns {void}
   */
  _onChangeNotification(deviceName, notif) {
    this.logger?.info?.(
      `Descriptor change notification from ${deviceName} (revision ${notif.revision})`
    );
    const f = notif.changeFlags;
    if (f.identityChanged || f.instrumentsChanged || f.timingChanged) {
      this._startDescriptorFetch(deviceName, notif.revision);
    }
  }

  /**
   * Drop per-device recognition state (announce dedupe, in-flight identity
   * probes, descriptor transfers, cached descriptor revisions) for devices whose
   * ports are no longer open. Called on every hot-plug `update` — the removal
   * path closes ports but carries no per-device detail — so a disconnect both
   * frees the state and lets a later reconnect re-announce + re-probe instead of
   * being suppressed by the stale dedupe/ETag entries. Cancels any pending timers
   * for the pruned devices.
   *
   * @returns {void}
   * @private
   */
  _pruneDisconnectedDeviceState() {
    const isOpen = (name) => this.inputs.has(name) || this.outputs.has(name);
    for (const name of [...this._announcedDevices]) {
      if (!isOpen(name)) this._announcedDevices.delete(name);
    }
    for (const [name, probe] of this._identityProbes) {
      if (isOpen(name)) continue;
      if (probe.debounceTimer) clearTimeout(probe.debounceTimer);
      if (probe.replyTimer) clearTimeout(probe.replyTimer);
      this._identityProbes.delete(name);
    }
    for (const [name, state] of this._descriptorFetches) {
      if (isOpen(name)) continue;
      if (state.timer) clearTimeout(state.timer);
      this._descriptorFetches.delete(name);
    }
    for (const name of [...this._descriptorRevisions.keys()]) {
      if (!isOpen(name)) this._descriptorRevisions.delete(name);
    }
  }

  /**
   * Reconcile the in-memory `devices` map with the currently-open
   * inputs/outputs/virtual devices and any persisted device-settings
   * rows. Idempotent — produces the canonical snapshot consumed by
   * {@link DeviceManager#getDeviceList} and the `device_list` command.
   *
   * @returns {Promise<void>}
   */
  async updateDeviceMap() {
    // Preserve operator-set "disabled" flags across the rebuild. `enableDevice`
    // mutates only the in-memory `devices` entry (there is no persisted enabled
    // column), so a naive clear()+rebuild — triggered by any hot-plug,
    // `device_refresh`, or virtual-device add/remove — would silently
    // re-enable a device the operator muted, and it would immediately start
    // receiving routed live MIDI and file playback again.
    const disabledIds = new Set();
    for (const [id, dev] of this.devices) {
      if (dev && dev.enabled === false) disabledIds.add(id);
    }
    this.devices.clear();

    this.logger.debug(
      `Updating device map: ${this.inputs.size} inputs, ${this.outputs.size} outputs`
    );
    this.logger.debug(`Input names: ${Array.from(this.inputs.keys()).join(', ')}`);
    this.logger.debug(`Output names: ${Array.from(this.outputs.keys()).join(', ')}`);

    // Get USB serial numbers for all connected devices
    const serialNumbers = await this.discovery.getUsbSerialNumbers();

    // Add USB devices. Inputs are registered first; an input that also
    // has an output is flagged bidirectional. A name only present in
    // `outputs` is output-only (matches the previous two-loop logic).
    const addUsbDevice = (name, isInput) => {
      if (this.devices.has(name)) return;
      const serialNumber = this.discovery.findSerialNumberInMap(name, serialNumbers);
      this.devices.set(name, {
        id: name,
        name: name,
        type: 'usb',
        input: isInput,
        output: isInput ? this.outputs.has(name) : true,
        enabled: !disabledIds.has(name),
        connected: true,
        status: DEVICE_STATUS.CONNECTED,
        usbSerialNumber: serialNumber || null
      });
      if (serialNumber) {
        this.logger.info(`USB device ${name} has serial number: ${serialNumber}`);
      }
    };

    for (const [name] of this.inputs) addUsbDevice(name, true);
    for (const [name] of this.outputs) addUsbDevice(name, false);

    // Add virtual devices (easymidi ports)
    this.virtualDevices.forEach((vdev, name) => {
      this.devices.set(name, {
        id: name,
        name: name,
        type: 'virtual',
        input: vdev.input !== null,
        output: vdev.output !== null,
        enabled: !disabledIds.has(name),
        connected: true,
        status: DEVICE_STATUS.CONNECTED,
        usbSerialNumber: null
      });
    });

    // Add soft virtual devices (no MIDI port, debug-monitor sink)
    this.softVirtualDevices.forEach((vdev, id) => {
      this.devices.set(id, {
        id: id,
        name: vdev.name,
        type: 'virtual',
        input: false,
        output: true,
        enabled: vdev.enabled !== false && !disabledIds.has(id),
        connected: true,
        status: DEVICE_STATUS.CONNECTED,
        usbSerialNumber: null
      });
    });
  }

  /**
   * @returns {Object[]} Snapshot of every registered device (hardware,
   *   virtual, and inactive entries with persisted settings).
   */
  getDeviceList() {
    const usbDevices = Array.from(this.devices.values());
    const allDevices = [...usbDevices];

    // Add paired and connected Bluetooth devices
    if (this.bluetoothManager) {
      const pairedDevices = this.bluetoothManager.getPairedDevices() || [];

      const connectedBluetoothDevices = pairedDevices
        .filter((device) => device.connected)
        .map((device) => ({
          id: device.address,
          name: device.name,
          manufacturer: 'Bluetooth',
          type: 'bluetooth',
          input: true,
          output: true,
          enabled: true,
          connected: true,
          status: DEVICE_STATUS.CONNECTED,
          address: device.address
        }));

      allDevices.push(...connectedBluetoothDevices);
    }

    // Add connected network devices
    if (this.networkManager) {
      const networkDevices = (this.networkManager.getConnectedDevices() || []).map((device) => ({
        id: device.ip,
        name: device.name || `Network MIDI (${device.ip})`,
        manufacturer: 'Network',
        type: 'network',
        input: true,
        output: true,
        enabled: true,
        connected: true,
        status: DEVICE_STATUS.CONNECTED,
        address: device.ip,
        port: device.port
      }));

      allDevices.push(...networkDevices);
    }

    // Add serial MIDI devices (GPIO UART)
    if (this.serialMidiManager) {
      const serialPorts = (this.serialMidiManager.getConnectedPorts() || []).map((port) => ({
        id: port.path,
        name: port.name || `Serial MIDI (${port.path})`,
        manufacturer: 'Serial',
        type: 'serial',
        input: port.direction === 'both' || port.direction === 'in',
        output: port.direction === 'both' || port.direction === 'out',
        enabled: true,
        connected: true,
        status: DEVICE_STATUS.CONNECTED,
        address: port.path
      }));

      allDevices.push(...serialPorts);
    }

    // Deduplicate by name
    const typePriority = { network: 0, bluetooth: 1, serial: 2, usb: 3, virtual: 4 };
    allDevices.sort((a, b) => (typePriority[a.type] ?? 99) - (typePriority[b.type] ?? 99));
    const uniqueDevices = [];
    const seenNames = new Set();

    this.logger.debug(`[Deduplication] ${allDevices.length} devices before:`);
    allDevices.forEach((d) => {
      this.logger.debug(`  - "${d.name}" (${d.type})`);
    });

    // Dedup key includes the transport type so we only merge the two ALSA
    // ports (input + output) of a SINGLE physical device — which share both
    // name and transport — and never fold genuinely different devices from
    // different transports into one entry with artificially OR-combined
    // input/output capabilities (audit P1 — "dangerous deduplication").
    //
    // Normalize by stripping ONLY a trailing ALSA port index (":0"/":1"), not
    // everything after the first colon. The old `split(':')[0]` discarded the
    // ALSA client/card number too, so two IDENTICAL-model instruments
    // ("Boop:Boop MIDI 1 20:0" and "…24:0") collapsed to the same key and the
    // second became invisible/uncontrollable (audit P1). Keeping the client
    // number distinguishes them while still merging one device's in/out ports.
    const normalizeName = (name) => name.replace(/:\d+$/, '').trim();
    const dedupKey = (device) => `${device.type}:${normalizeName(device.name)}`;

    for (const device of allDevices) {
      const key = dedupKey(device);

      if (!seenNames.has(key)) {
        seenNames.add(key);
        uniqueDevices.push(device);
        this.logger.debug(
          `[Deduplication] ✓ KEPT: "${device.name}" (${device.type}) [key: "${key}"]`
        );
      } else {
        // Merge capabilities: if the duplicate (same transport + name) has
        // input/output the kept one lacks, merge them.
        const kept = uniqueDevices.find((d) => dedupKey(d) === key);
        if (kept) {
          if (device.input && !kept.input) kept.input = true;
          if (device.output && !kept.output) kept.output = true;
          this.logger.debug(
            `[Deduplication] ↗ MERGED: "${device.name}" (${device.type}) into "${kept.name}" → input=${kept.input}, output=${kept.output}`
          );
        } else {
          this.logger.debug(
            `[Deduplication] ✗ SKIP: "${device.name}" (${device.type}) [key: "${key}"] - duplicate`
          );
        }
      }
    }

    this.logger.info(
      `[Deduplication] Result: ${allDevices.length} → ${uniqueDevices.length} devices`
    );

    return uniqueDevices;
  }

  /**
   * Friendly instrument name for a `device|channel`, memoised so the
   * realtime send path never blocks on a synchronous SQLite query while
   * a monitor is active. Cache is cleared on `instrument_settings_changed`.
   *
   * @param {string} deviceName
   * @param {number|undefined} channel
   * @returns {?string} Custom/instrument name, or null when unknown.
   */
  _resolveInstrumentName(deviceName, channel) {
    if (!this.database || channel === undefined) return null;
    const key = `${deviceName}|${channel}`;
    if (this._instrumentNameByDevCh.has(key)) {
      return this._instrumentNameByDevCh.get(key);
    }
    let instrumentName = null;
    try {
      const settings = this.database.getInstrumentSettings(deviceName, channel);
      if (settings) instrumentName = settings.custom_name || settings.name;
    } catch {
      /* instrument name lookup is optional for monitor events */
    }
    this._instrumentNameByDevCh.set(key, instrumentName);
    return instrumentName;
  }

  /**
   * Public dispatch entry. Resolves the named device to an output port
   * (or virtual sink), enforces per-device rate limiting, then sends.
   * Returns false when the device is unknown, gated by the rate limiter,
   * or the underlying send threw.
   *
   * @param {string} deviceName
   * @param {string} type - Message type (`'noteon'`, `'cc'`, ...).
   * @param {Object} data - Message payload.
   * @returns {boolean} True on successful enqueue.
   */
  sendMessage(deviceName, type, data) {
    const result = this.sendMessageEx(deviceName, type, data);
    return result.status === SEND_STATUS.SENT || result.status === SEND_STATUS.QUEUED;
  }

  /**
   * Typed dispatch entry (audit P0-6). Resolves the named device to an
   * output port / transport, enforces per-device rate limiting (except for
   * priority silencing/reset traffic — audit P0-7), then sends. Unlike
   * {@link DeviceManager#sendMessage} it distinguishes *why* a send did not
   * land so the scheduler does not treat a rate-limit drop or an
   * unsupported message the same as a real device disconnect.
   *
   * Note: for the async transports (BLE, network) a `queued` status means
   * the write was handed to the transport; a later async failure is
   * reported out-of-band via the transport's own error events, not here.
   *
   * @param {string} deviceName
   * @param {string} type
   * @param {Object} data
   * @returns {{status:string, error?:Error}} One of {@link SEND_STATUS}.
   */
  sendMessageEx(deviceName, type, data) {
    // A device disabled via enableDevice() must receive NO MIDI — from live
    // routing and direct sends too, not just file playback (audit P1 —
    // device_enable(false) previously only muted playback). Return a
    // non-failure status so the scheduler never mistakes it for a disconnect.
    const known = this.devices.get(deviceName);
    if (known && known.enabled === false) {
      return { status: SEND_STATUS.DISABLED };
    }

    // Priority messages bypass the rate limiter so a silencing/panic burst is
    // never partially dropped and cannot leave stuck notes. Besides the typed
    // priorities (Note Off, reset, transport, clock), this MUST include the
    // Channel Mode CCs (controller >= 120: All Sound Off 120, Reset All
    // Controllers 121, All Notes Off 123, Omni/Mono/Poly …) — panic and
    // all-notes-off are emitted as `cc`, so keying only on the type string let
    // the limiter drop part of a panic burst (audit P2).
    const isChannelModeCc = type === DEVICE_MSG_TYPES.CC && data && (data.controller ?? 0) >= 120;
    if (!PRIORITY_MSG_TYPES.has(type) && !isChannelModeCc && this._isRateLimited(deviceName)) {
      return { status: SEND_STATUS.RATE_LIMITED };
    }

    // Broadcast to debug monitor if monitorAll is active
    if (this.midiRouter?.monitorAll && this.wsServer) {
      const instrumentName = data ? this._resolveInstrumentName(deviceName, data.channel) : null;
      this.wsServer.broadcast('monitor_event', {
        device: deviceName,
        instrumentName: instrumentName,
        type: type,
        data: data,
        timestamp: Date.now(),
        direction: 'out'
      });
    }

    // Check USB MIDI device
    const output = this.outputs.get(deviceName);
    if (output) {
      try {
        this._sendToOutput(output, type, data);
        return { status: SEND_STATUS.SENT };
      } catch (error) {
        this.logger.error(`Failed to send MIDI message to ${deviceName}: ${error.message}`);
        return { status: SEND_STATUS.ERROR, error };
      }
    }

    // Check Bluetooth device
    if (this.bluetoothManager) {
      const pairedDevices = this.bluetoothManager.getPairedDevices();
      const bleDevice = pairedDevices.find(
        (d) => d.address === deviceName || d.name === deviceName
      );

      if (bleDevice && bleDevice.connected) {
        try {
          this.bluetoothManager.sendMidiMessage(bleDevice.address, type, data).catch((error) => {
            this.logger.error(`BLE MIDI send failed to ${deviceName}: ${error.message}`);
          });
          return { status: SEND_STATUS.QUEUED };
        } catch (error) {
          this.logger.error(`Failed to send MIDI via Bluetooth to ${deviceName}: ${error.message}`);
          return { status: SEND_STATUS.ERROR, error };
        }
      }
      if (bleDevice && !bleDevice.connected) {
        return { status: SEND_STATUS.DISCONNECTED };
      }
    }

    // Check network device
    if (this.networkManager) {
      const networkDevices = this.networkManager.getConnectedDevices();
      const networkDevice = networkDevices.find(
        (d) => d.ip === deviceName || d.name === deviceName || d.address === deviceName
      );

      if (networkDevice) {
        try {
          this.networkManager.sendMidiMessage(networkDevice.ip, type, data).catch((error) => {
            this.logger.error(`Network MIDI send failed to ${deviceName}: ${error.message}`);
          });
          return { status: SEND_STATUS.QUEUED };
        } catch (error) {
          this.logger.error(`Failed to send MIDI via Network to ${deviceName}: ${error.message}`);
          return { status: SEND_STATUS.ERROR, error };
        }
      }
    }

    // Check serial MIDI device (GPIO)
    if (this.serialMidiManager) {
      const serialPorts = this.serialMidiManager.getConnectedPorts();
      const serialPort = serialPorts.find((p) => p.name === deviceName || p.path === deviceName);

      if (serialPort) {
        try {
          this.serialMidiManager.sendMidiMessage(serialPort.path, type, data);
          return { status: SEND_STATUS.SENT };
        } catch (error) {
          this.logger.error(
            `Failed to send MIDI message via Serial to ${deviceName}: ${error.message}`
          );
          return { status: SEND_STATUS.ERROR, error };
        }
      }
    }

    // Check soft virtual device — log message to debug monitor instead of hardware
    const softVirtual = this.softVirtualDevices.get(deviceName);
    if (softVirtual) {
      const instrumentName = data ? this._resolveInstrumentName(deviceName, data.channel) : null;
      this.logger.info(
        `[virtual:${instrumentName || softVirtual.name}] ${type} ${JSON.stringify(data)}`
      );
      if (this.wsServer) {
        this.wsServer.broadcast('monitor_event', {
          device: deviceName,
          instrumentName: instrumentName || softVirtual.name,
          type: type,
          data: data,
          timestamp: Date.now(),
          direction: 'out',
          virtual: true
        });
      }
      return { status: SEND_STATUS.SENT };
    }

    this.logger.warn(`Output device not found: ${deviceName}`);
    return { status: SEND_STATUS.DISCONNECTED };
  }

  /**
   * Low-level send to an easymidi Output, translating our SysEx payload
   * (`{ bytes:[0xF0,…,0xF7] }` or a raw byte array) into easymidi's
   * `send('sysex', bytes)` contract; all other types pass through
   * unchanged.
   * @param {Object} output - easymidi Output.
   * @param {string} type
   * @param {Object} data
   * @private
   */
  _sendToOutput(output, type, data) {
    if (type === 'sysex') {
      const bytes = Array.isArray(data) ? data : data?.bytes;
      if (!Array.isArray(bytes) || bytes.length === 0) return;
      output.send('sysex', bytes);
      return;
    }

    // Translate GMBoop's canonical (type, data) into easymidi's vocabulary.
    // easymidi names pitch bend `'pitch'` (not `'pitchbend'`) and reads the
    // program number from `number` (not `program`); sending our names/fields
    // verbatim made pitch bend THROW and program change send `undefined`
    // (audit P0/P1). Also 7-bit-clamp data bytes so an out-of-range value is
    // masked (like the other transports) instead of throwing in the addon.
    const ch = (data.channel ?? 0) & 0x0f;

    if (type === DEVICE_MSG_TYPES.PITCH_BEND) {
      output.send('pitch', { channel: ch, value: MidiUtils.pitchBendRaw14(data) });
      return;
    }
    if (type === DEVICE_MSG_TYPES.PROGRAM) {
      output.send('program', { channel: ch, number: (data.number ?? data.program ?? 0) & 0x7f });
      return;
    }
    if (type === DEVICE_MSG_TYPES.NOTE_ON || type === DEVICE_MSG_TYPES.NOTE_OFF) {
      output.send(type, {
        channel: ch,
        note: (data.note ?? 0) & 0x7f,
        velocity: (data.velocity ?? 0) & 0x7f
      });
      return;
    }
    if (type === DEVICE_MSG_TYPES.CC) {
      output.send('cc', {
        channel: ch,
        controller: (data.controller ?? 0) & 0x7f,
        value: (data.value ?? 0) & 0x7f
      });
      return;
    }
    if (type === DEVICE_MSG_TYPES.POLY_AFTERTOUCH) {
      output.send('poly aftertouch', {
        channel: ch,
        note: (data.note ?? 0) & 0x7f,
        pressure: (data.pressure ?? 0) & 0x7f
      });
      return;
    }
    if (type === DEVICE_MSG_TYPES.CHANNEL_AFTERTOUCH) {
      output.send('channel aftertouch', { channel: ch, pressure: (data.pressure ?? 0) & 0x7f });
      return;
    }
    output.send(type, data);
  }

  /**
   * Send a MIDI Universal Identity Request (SysEx F0 7E <id> 06 01 F7)
   * to a device. Reply, if any, arrives asynchronously via the normal
   * input path and is processed by {@link DeviceManager#parseIdentityReply}.
   *
   * @param {string} deviceName
   * @param {number} [_deviceId=0x7F] - SysEx target id (0x7F = broadcast).
   * @returns {boolean} True when the request was queued for send.
   */
  sendIdentityRequest(deviceName, _deviceId = 0x7f) {
    this.logger.debug(`Looking for output: ${deviceName}`);
    this.logger.debug(`Available outputs: ${Array.from(this.outputs.keys()).join(', ')}`);

    const output = this.outputs.get(deviceName);
    if (!output) {
      const hasInput = this.inputs.has(deviceName);
      if (hasInput) {
        this.logger.warn(`Device ${deviceName} is input-only, cannot send SysEx messages`);
        throw new Error(
          `Device ${deviceName} is input-only. Cannot send SysEx messages to input-only devices.`
        );
      } else {
        this.logger.warn(`Output device not found: ${deviceName}`);
        this.logger.warn(`Available outputs: ${Array.from(this.outputs.keys()).join(', ')}`);
        throw new Error(`Output device not found: ${deviceName}`);
      }
    }

    try {
      // 1) GMB Block 1 Identity Request (custom DIY format)
      const gmbSysex = [
        0xf0, // SysEx Start
        0x7d, // Custom SysEx (Educational/Development)
        0x00, // GMB Manufacturer ID
        0x01, // Block 1 (Identification)
        0x00, // Request flag (00=request, 01=response)
        0xf7 // SysEx End
      ];
      output.send('sysex', gmbSysex);
      this.logger.info(`GMB Block 1 Identity Request sent to ${deviceName}`);

      // 2) MIDI Universal Identity Request — recognised by every standard
      //    keyboard / synth so we can tell real keyboards apart from our
      //    own DIY devices. Format: F0 7E <id> 06 01 F7 (id 7F = broadcast).
      const universalSysex = [0xf0, 0x7e, _deviceId & 0x7f, 0x06, 0x01, 0xf7];
      output.send('sysex', universalSysex);
      this.logger.info(`Universal Identity Request sent to ${deviceName}`);

      return true;
    } catch (error) {
      this.logger.error(`Failed to send Identity Request: ${error.message}`);
      throw error;
    }
  }

  /**
   * Common entry point for every inbound MIDI message. Emits
   * `midi_message` on the EventBus, hands it to the {@link MidiRouter},
   * and intercepts SysEx Identity Replies for auto-detection.
   *
   * @param {string} deviceName
   * @param {string} type
   * @param {Object} msg
   * @returns {void}
   */
  /**
   * Parse a single complete raw-MIDI message (status byte + data bytes)
   * into an easymidi-style `(type, data)` pair and route it through
   * {@link DeviceManager#handleMidiMessage}. This is the common entry
   * point for transports that deliver raw bytes rather than pre-parsed
   * messages — BLE-MIDI in particular — so their input reaches the router
   * exactly like USB and serial input (audit P0-2).
   *
   * @param {string} deviceName
   * @param {number[]} bytes - One complete MIDI message.
   * @returns {void}
   */
  handleRawMidi(deviceName, bytes) {
    if (!Array.isArray(bytes) || bytes.length === 0) return;
    const status = bytes[0];

    // SysEx (0xF0 … 0xF7): forward the whole frame.
    if (status === 0xf0) {
      this.handleMidiMessage(deviceName, 'sysex', bytes);
      return;
    }

    const high = status & 0xf0;
    const channel = status & 0x0f;
    switch (high) {
      case 0x80:
        this.handleMidiMessage(deviceName, 'noteoff', {
          channel,
          note: bytes[1],
          velocity: bytes[2]
        });
        return;
      case 0x90:
        // Running-status / velocity-0 Note On is a Note Off.
        this.handleMidiMessage(deviceName, bytes[2] === 0 ? 'noteoff' : 'noteon', {
          channel,
          note: bytes[1],
          velocity: bytes[2]
        });
        return;
      case 0xa0:
        this.handleMidiMessage(deviceName, 'poly aftertouch', {
          channel,
          note: bytes[1],
          pressure: bytes[2]
        });
        return;
      case 0xb0:
        this.handleMidiMessage(deviceName, 'cc', {
          channel,
          controller: bytes[1],
          value: bytes[2]
        });
        return;
      case 0xc0:
        this.handleMidiMessage(deviceName, 'program', { channel, number: bytes[1] });
        return;
      case 0xd0:
        this.handleMidiMessage(deviceName, 'channel aftertouch', { channel, pressure: bytes[1] });
        return;
      case 0xe0:
        this.handleMidiMessage(deviceName, 'pitchbend', {
          channel,
          value: (bytes[2] << 7) | bytes[1]
        });
        return;
      default: {
        // System common / real-time.
        const sysType = {
          0xf8: 'clock',
          0xfa: 'start',
          0xfb: 'continue',
          0xfc: 'stop',
          0xfe: 'sensing',
          0xff: 'reset'
        }[status];
        if (sysType) this.handleMidiMessage(deviceName, sysType, {});
      }
    }
  }

  handleMidiMessage(deviceName, type, msg) {
    const timestamp = Date.now();

    // Parse SysEx Identity Reply if applicable
    if (type === 'sysex') {
      const bytes = Array.isArray(msg) ? msg : msg.bytes || [];
      this.logger.info(
        `SysEx message received from ${deviceName}: ${bytes.map((b) => '0x' + b.toString(16).toUpperCase()).join(' ')} (${bytes.length} bytes)`
      );

      // Block 0x10 descriptor-transfer response (level 1) — fed to the
      // sequential fetch state machine started on the v2 handshake below.
      const chunk = this.parseDescriptorChunk(bytes);
      const change = chunk ? null : this.parseChangeNotification(bytes);
      if (chunk) {
        this._onDescriptorChunk(deviceName, chunk);
      } else if (change) {
        this._onChangeNotification(deviceName, change);
      } else {
        const identityInfo = this.parseIdentityReply(msg);
        if (identityInfo) {
          this._markIdentified(deviceName);
          this.logger.info(`Identity Reply received from ${deviceName}:`, identityInfo);

          if (this.database) {
            try {
              // Stamp the identity on every channel the device occupies, not
              // just channel 0, so a multi-channel device is fully identified
              // (audit P1-3). Falls back to channel 0 when it has no rows yet.
              const n = this.database.saveSysExIdentityForDevice(deviceName, identityInfo);
              this.logger.info(`SysEx identity saved for ${deviceName} (${n} channel(s))`);
            } catch (e) {
              this.logger.warn(`Failed to save SysEx identity for ${deviceName}: ${e.message}`);
            }
          }

          if (this.wsServer) {
            this.wsServer.broadcast('device_identity', {
              device: deviceName,
              identity: identityInfo,
              timestamp: timestamp
            });
          }

          // A level-1 v2 handshake advertises a capability descriptor — fetch
          // and apply it over block 0x10 (docs/SYSEX_IDENTITY.md §7).
          if (identityInfo.protocol === 'GMB Handshake v2' && identityInfo.level === 1) {
            this._startDescriptorFetch(deviceName, identityInfo.revision);
          }
        } else {
          this.logger.debug(`SysEx message from ${deviceName} is not an Identity Reply`);
        }
      }
    }

    // Emit to event bus
    this.eventBus.emit('midi_message', {
      device: deviceName,
      type: type,
      data: msg,
      timestamp: timestamp
    });

    // Route message if router is available
    if (this.midiRouter) {
      this.midiRouter.routeMessage(deviceName, type, msg);
    }

    // Broadcast to WebSocket clients
    if (this.wsServer) {
      this.wsServer.broadcast('midi_event', {
        device: deviceName,
        type: type,
        data: msg,
        timestamp: timestamp
      });
    }
  }

  /**
   * Decode a 32-bit value from 5 bytes of 7-bit encoded data
   */
  decode7BitTo32Bit(data) {
    let value = 0;
    value |= data[0] & 0x7f;
    value |= (data[1] & 0x7f) << 7;
    value |= (data[2] & 0x7f) << 14;
    value |= (data[3] & 0x7f) << 21;
    value |= (data[4] & 0x07) << 28;
    return value >>> 0;
  }

  /**
   * Decode a SysEx Universal Identity Reply (F0 7E <ch> 06 02 ...) into
   * `{manufacturerId, manufacturerName, family, model, version}`.
   * Returns null when the SysEx payload is not an identity reply.
   *
   * @param {{bytes:number[]}|number[]} msg
   * @returns {?Object}
   */
  parseIdentityReply(msg) {
    const bytes = Array.isArray(msg) ? msg : msg.bytes || [];

    this.logger.debug(
      `Received SysEx message: ${bytes.map((b) => '0x' + b.toString(16).toUpperCase()).join(' ')}`
    );
    this.logger.debug(
      `Length: ${bytes.length}, First: 0x${bytes[0]?.toString(16).toUpperCase()}, Last: 0x${bytes[bytes.length - 1]?.toString(16).toUpperCase()}`
    );

    // 1) Try the MIDI Universal Identity Reply first
    //    Format: F0 7E <ch> 06 02 <mfr...> <family lsb> <family msb>
    //            <model lsb> <model msb> <ver1> <ver2> <ver3> <ver4> F7
    //    <mfr> is either 1 byte (0x01-0x7F, not 0x00) or a 3-byte extended
    //    block starting with 0x00 followed by two ID bytes.
    if (
      bytes.length >= 15 &&
      bytes[0] === 0xf0 &&
      bytes[1] === 0x7e &&
      bytes[3] === 0x06 &&
      bytes[4] === 0x02 &&
      bytes[bytes.length - 1] === 0xf7
    ) {
      const universal = this._parseUniversalIdentityReply(bytes);
      if (universal) return universal;
    }

    // 2) GMB Handshake v2 (24-byte, proto_ver 0x02) — the current instrument
    //    recognition protocol. See docs/SYSEX_IDENTITY.md §2.
    const handshake = this.parseGmbHandshake(bytes);
    if (handshake) return handshake;

    // 3) Legacy GMB Block 1 v1 (52-byte) — DEPRECATED, retained only for DIY
    //    devices not yet migrated to the v2 handshake above. No wild devices
    //    depend on it (v1 firmware was draft); safe to drop once migration
    //    completes.
    if (bytes.length !== 52) return null;
    if (bytes[0] !== 0xf0) return null;
    if (bytes[1] !== 0x7d) return null;
    if (bytes[2] !== 0x00) return null;
    if (bytes[3] !== 0x01) return null;
    if (bytes[4] !== 0x01) return null;
    if (bytes[51] !== 0xf7) return null;

    let pos = 5;

    const blockVersion = bytes[pos];
    pos += 1;

    const deviceIdBytes = bytes.slice(pos, pos + 5);
    const deviceId = this.decode7BitTo32Bit(deviceIdBytes);
    pos += 5;

    const nameBytes = bytes.slice(pos, pos + 32);
    let deviceName = '';
    for (let i = 0; i < nameBytes.length; i++) {
      if (nameBytes[i] === 0x00) break;
      deviceName += String.fromCharCode(nameBytes[i]);
    }
    pos += 32;

    const firmwareMajor = bytes[pos];
    const firmwareMinor = bytes[pos + 1];
    const firmwarePatch = bytes[pos + 2];
    const firmwareVersion = `${firmwareMajor}.${firmwareMinor}.${firmwarePatch}`;
    pos += 3;

    const featureBytes = bytes.slice(pos, pos + 5);
    const features = this.decode7BitTo32Bit(featureBytes);
    pos += 5;

    const featureFlags = {
      noteMap: (features & 0x01) !== 0,
      velocityCurves: (features & 0x02) !== 0,
      ccMapping: (features & 0x04) !== 0,
      instrumentDescriptor: (features & 0x08) !== 0,
      instrumentCapabilities: (features & 0x10) !== 0,
      stringConfig: (features & 0x20) !== 0
    };

    return {
      protocol: 'GMB Block 1',
      blockVersion: blockVersion,
      deviceId: `0x${deviceId.toString(16).padStart(8, '0').toUpperCase()}`,
      deviceIdDecimal: deviceId,
      deviceName: deviceName,
      manufacturerName: 'GeneralMidiBoop',
      firmwareVersion: firmwareVersion,
      firmware: {
        major: firmwareMajor,
        minor: firmwareMinor,
        patch: firmwarePatch
      },
      features: `0x${features.toString(16).padStart(8, '0').toUpperCase()}`,
      featuresDecimal: features,
      featureFlags: featureFlags,
      rawBytes: bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')
    };
  }

  /**
   * Decode a GMB v2 Handshake reply (24 bytes) — the current instrument
   * recognition protocol (docs/SYSEX_IDENTITY.md §2):
   *
   *   F0 7D 00 01 01 <proto_ver> <instance_id[5]> <firmware[3]>
   *      <descriptor_size[3]> <revision[5]> <flags> F7
   *
   * `instance_id` and `revision` are 32-bit values 7-bit-encoded over 5 bytes;
   * `descriptor_size` is a 21-bit value over 3 bytes (`0` ⇒ level 0, no
   * descriptor). `flags` bit 0 = HTTP available, bit 1 = push notifications.
   * Returns null when the payload is not a v2 handshake.
   *
   * @param {number[]} bytes
   * @returns {?Object}
   */
  parseGmbHandshake(bytes) {
    if (!Array.isArray(bytes) || bytes.length !== 24) return null;
    if (bytes[0] !== 0xf0 || bytes[1] !== 0x7d || bytes[2] !== 0x00) return null;
    if (bytes[3] !== 0x01 || bytes[4] !== 0x01 || bytes[23] !== 0xf7) return null;

    const protoVer = bytes[5];
    if (protoVer !== 0x02) return null; // not a v2 handshake frame

    // Full 32-bit little-endian 7-bit decode. NB: the shared
    // decode7BitTo32Bit() masks the 5th byte to 3 bits (0x07), capping it at
    // 31 bits — fine for the legacy v1 device id but it would silently drop
    // bit 31 of a per-exemplar instance_id (halving the id space). The v2
    // handshake carries the full nibble (0x0f ⇒ bits 28-31).
    const dec32 = (b) =>
      ((b[0] & 0x7f) |
        ((b[1] & 0x7f) << 7) |
        ((b[2] & 0x7f) << 14) |
        ((b[3] & 0x7f) << 21) |
        ((b[4] & 0x0f) << 28)) >>>
      0;

    const instanceId = dec32(bytes.slice(6, 11));
    const firmwareMajor = bytes[11];
    const firmwareMinor = bytes[12];
    const firmwarePatch = bytes[13];
    const descriptorSize =
      (bytes[14] & 0x7f) | ((bytes[15] & 0x7f) << 7) | ((bytes[16] & 0x7f) << 14);
    const revision = dec32(bytes.slice(17, 22));
    const flags = bytes[22];

    const instanceHex = `0x${instanceId.toString(16).padStart(8, '0').toUpperCase()}`;

    return {
      protocol: 'GMB Handshake v2',
      protocolVersion: protoVer,
      level: descriptorSize === 0 ? 0 : 1,
      instanceId: instanceHex,
      instanceIdDecimal: instanceId,
      // Alias `deviceId` so the existing saveSysExIdentity() path persists the
      // per-exemplar instance_id into the `sysex_device_id` column unchanged.
      deviceId: instanceHex,
      manufacturerName: 'GeneralMidiBoop',
      firmwareVersion: `${firmwareMajor}.${firmwareMinor}.${firmwarePatch}`,
      firmware: { major: firmwareMajor, minor: firmwareMinor, patch: firmwarePatch },
      descriptorSize,
      revision,
      revisionHex: `0x${revision.toString(16).padStart(8, '0').toUpperCase()}`,
      flags: {
        httpAvailable: (flags & 0x01) !== 0,
        pushNotifications: (flags & 0x02) !== 0
      },
      rawBytes: bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')
    };
  }

  /**
   * Decode a MIDI Universal Identity Reply
   *   F0 7E <ch> 06 02 <mfr...> <fLSB> <fMSB> <mLSB> <mMSB> <v1 v2 v3 v4> F7
   * <mfr> is one byte unless it starts with 0x00, in which case the next two
   * bytes complete a 3-byte extended ID (ignored by the lookup table).
   * Returns null when the payload is not a valid Universal Identity Reply.
   */
  _parseUniversalIdentityReply(bytes) {
    if (bytes.length < 15) return null;
    let pos = 5;
    let mfrBytes;
    if (bytes[pos] === 0x00) {
      if (bytes.length < 17) return null;
      mfrBytes = [bytes[pos], bytes[pos + 1], bytes[pos + 2]];
      pos += 3;
    } else {
      mfrBytes = [bytes[pos]];
      pos += 1;
    }

    if (bytes.length < pos + 9) return null;
    const familyLsb = bytes[pos];
    const familyMsb = bytes[pos + 1];
    const modelLsb = bytes[pos + 2];
    const modelMsb = bytes[pos + 3];
    const v1 = bytes[pos + 4];
    const v2 = bytes[pos + 5];
    const v3 = bytes[pos + 6];
    const v4 = bytes[pos + 7];

    const family = (familyMsb << 7) | familyLsb;
    const model = (modelMsb << 7) | modelLsb;

    const mfrId = mfrBytes.length === 1 ? mfrBytes[0] : (mfrBytes[1] << 7) | mfrBytes[2]; // extended IDs are typically rendered as the 14-bit value
    const mfrIdHex =
      '0x' + mfrBytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
    const manufacturerName =
      mfrBytes.length === 1 ? this.getManufacturerName(mfrBytes[0]) : `Unknown (${mfrIdHex})`;

    return {
      protocol: 'Universal Identity Reply',
      manufacturerName,
      manufacturerId: mfrIdHex,
      manufacturerIdDecimal: mfrId,
      family,
      model,
      firmwareVersion: `${v1}.${v2}.${v3}.${v4}`,
      firmware: { v1, v2, v3, v4 },
      rawBytes: bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')
    };
  }

  /**
   * Resolve a SysEx manufacturer ID (1 byte or 3 bytes for the
   * 0x00-prefixed extended range) to a human-readable name. Returns
   * `"Unknown (0x...)"` for IDs not in the lookup table.
   *
   * @param {number[]} id
   * @returns {string}
   */
  getManufacturerName(id) {
    const manufacturers = {
      0x01: 'Sequential Circuits',
      0x02: 'IDP',
      0x03: 'Voyetra/Octave-Plateau',
      0x04: 'Moog',
      0x05: 'Passport Designs',
      0x06: 'Lexicon',
      0x07: 'Kurzweil',
      0x08: 'Fender',
      0x09: 'Gulbransen',
      0x0a: 'AKG Acoustics',
      0x0b: 'Voyce Music',
      0x0c: 'Waveframe',
      0x0d: 'ADA',
      0x0e: 'Garfield Electronics',
      0x0f: 'Ensoniq',
      0x10: 'Oberheim',
      0x11: 'Apple',
      0x12: 'Grey Matter Response',
      0x13: 'Digidesign',
      0x14: 'Palmtree Instruments',
      0x15: 'JLCooper Electronics',
      0x16: 'Lowrey',
      0x17: 'Adams-Smith',
      0x18: 'E-mu',
      0x19: 'Harmony Systems',
      0x1a: 'ART',
      0x1b: 'Baldwin',
      0x1c: 'Eventide',
      0x1d: 'Inventronics',
      0x20: 'Clarity',
      0x21: 'Passac',
      0x22: 'SIEL',
      0x23: 'Synthaxe',
      0x25: 'Hohner',
      0x26: 'Twister',
      0x27: 'Solton',
      0x28: 'Jellinghaus MS',
      0x2f: 'Elka',
      0x36: 'Cheetah',
      0x3e: 'Waldorf',
      0x40: 'Kawai',
      0x41: 'Roland',
      0x42: 'Korg',
      0x43: 'Yamaha',
      0x44: 'Casio',
      0x47: 'Akai'
    };
    return manufacturers[id] || 'Unknown';
  }

  /**
   * Open a software MIDI port using easymidi's virtual ports
   * (Linux/macOS only). The same port is registered as both an input
   * and an output so other applications can talk to it bidirectionally.
   *
   * @param {string} name
   * @returns {Promise<{success:boolean, error?:string}>}
   */
  async createVirtualDevice(name) {
    if (this.virtualDevices.has(name)) {
      throw new Error(`Virtual device already exists: ${name}`);
    }

    const input = new easymidi.Input(name, true);
    const output = new easymidi.Output(name, true);

    // Subscribe to the FULL channel-voice + sysex set, matching addInput —
    // the old virtual port wired only noteon/noteoff/cc, silently dropping
    // program change, pitch bend, aftertouch and SysEx (incl. Identity Reply)
    // for anything routed through it (audit P2).
    input.on('noteon', (msg) => this.handleMidiMessage(name, 'noteon', msg));
    input.on('noteoff', (msg) => this.handleMidiMessage(name, 'noteoff', msg));
    input.on('cc', (msg) => this.handleMidiMessage(name, 'cc', msg));
    input.on('program', (msg) => this.handleMidiMessage(name, 'program', msg));
    input.on('pitch', (msg) =>
      this.handleMidiMessage(name, 'pitchbend', { channel: msg.channel, value14: msg.value })
    );
    input.on('poly aftertouch', (msg) => this.handleMidiMessage(name, 'poly aftertouch', msg));
    input.on('channel aftertouch', (msg) =>
      this.handleMidiMessage(name, 'channel aftertouch', msg)
    );
    input.on('sysex', (msg) => this.handleMidiMessage(name, 'sysex', msg));

    this.virtualDevices.set(name, { input, output });
    await this.updateDeviceMap();
    this.broadcastDeviceList();

    this.logger.info(`Virtual device created: ${name}`);
    return name;
  }

  /**
   * Close and unregister a virtual port previously created with
   * {@link DeviceManager#createVirtualDevice}.
   *
   * @param {string} name
   * @returns {Promise<{success:boolean, error?:string}>}
   */
  async deleteVirtualDevice(name) {
    const vdev = this.virtualDevices.get(name);
    if (!vdev) {
      throw new Error(`Virtual device not found: ${name}`);
    }

    vdev.input.removeAllListeners();
    vdev.input.close();
    vdev.output.close();
    this.virtualDevices.delete(name);
    await this.updateDeviceMap();
    this.broadcastDeviceList();

    this.logger.info(`Virtual device deleted: ${name}`);
  }

  /**
   * Register a soft virtual device (no MIDI port). MIDI messages sent to
   * this device are broadcast as monitor events and logged instead of being
   * forwarded to hardware.
   *
   * @param {string} deviceId
   * @param {{name?:string, type?:string, enabled?:boolean}} opts
   * @returns {void}
   */
  addVirtualDevice(deviceId, opts = {}) {
    this.softVirtualDevices.set(deviceId, {
      id: deviceId,
      name: opts.name || deviceId,
      type: 'virtual',
      enabled: opts.enabled !== false
    });
    this.devices.set(deviceId, {
      id: deviceId,
      name: opts.name || deviceId,
      type: 'virtual',
      input: false,
      output: true,
      enabled: opts.enabled !== false,
      connected: true,
      status: DEVICE_STATUS.CONNECTED,
      usbSerialNumber: null
    });
    this.logger.info(`Soft virtual device registered: ${deviceId}`);
    this.broadcastDeviceList();
  }

  /**
   * Unregister a soft virtual device previously added with
   * {@link DeviceManager#addVirtualDevice}.
   *
   * @param {string} deviceId
   * @returns {void}
   */
  removeVirtualDevice(deviceId) {
    this.softVirtualDevices.delete(deviceId);
    this.devices.delete(deviceId);
    this.logger.info(`Soft virtual device unregistered: ${deviceId}`);
    this.broadcastDeviceList();
  }

  /**
   * @param {string} deviceId
   * @param {boolean} enabled
   * @returns {void}
   */
  enableDevice(deviceId, enabled) {
    const device = this.devices.get(deviceId);
    if (!device) {
      throw new Error(`Device not found: ${deviceId}`);
    }

    device.enabled = enabled;
    this.logger.info(`Device ${deviceId} ${enabled ? 'enabled' : 'disabled'}`);
    this.broadcastDeviceList();
  }

  getDeviceInfo(deviceId) {
    return this.devices.get(deviceId);
  }

  // Delegate to discovery
  isSystemDevice(name) {
    return this.discovery.isSystemDevice(name);
  }

  async getUsbSerialNumbers() {
    return this.discovery.getUsbSerialNumbers();
  }

  /** @returns {Promise<?string>} */
  async findSerialNumberForDevice(deviceName) {
    return this.discovery.findSerialNumberForDevice(deviceName);
  }

  /** Start hot-plug monitoring (delegates to {@link DeviceDiscovery}). */
  startHotPlugMonitoring() {
    this.discovery.startHotPlugMonitoring(this.inputs, this.outputs);
  }

  /** Stop hot-plug monitoring. */
  stopHotPlugMonitoring() {
    this.discovery.stopHotPlugMonitoring();
  }

  /**
   * Broadcast a `device_list` WebSocket event with the current snapshot.
   * Called from `scanDevices` and on hot-plug events.
   *
   * @returns {void}
   */
  broadcastDeviceList() {
    if (this.wsServer) {
      this.wsServer.broadcast('device_list', {
        devices: this.getDeviceList()
      });
    }
  }

  /**
   * Close every open input/output/virtual port and stop hot-plug
   * monitoring. Listeners are removed before close to prevent callbacks
   * firing during teardown. Called from Application#stop.
   *
   * @returns {void}
   */
  close() {
    // Stop hot-plug monitoring
    this.discovery.stopHotPlugMonitoring();

    // Close all inputs (remove listeners first to prevent callbacks during close)
    this.inputs.forEach((input) => {
      try {
        input.removeAllListeners();
        input.close();
      } catch (error) {
        this.logger.error(`Error closing input: ${error.message}`);
      }
    });

    // Close all outputs
    this.outputs.forEach((output) => {
      try {
        output.close();
      } catch (error) {
        this.logger.error(`Error closing output: ${error.message}`);
      }
    });

    // Close virtual devices (remove listeners first)
    this.virtualDevices.forEach((vdev) => {
      try {
        vdev.input.removeAllListeners();
        vdev.input.close();
        vdev.output.close();
      } catch (error) {
        this.logger.error(`Error closing virtual device: ${error.message}`);
      }
    });

    // Cancel any pending auto-identity probe/retry timers
    this._identityProbes.forEach((probe) => {
      if (probe.debounceTimer) clearTimeout(probe.debounceTimer);
      if (probe.replyTimer) clearTimeout(probe.replyTimer);
    });
    this._identityProbes.clear();

    // Cancel any in-flight descriptor-transfer timers
    this._descriptorFetches.forEach((state) => {
      if (state.timer) clearTimeout(state.timer);
    });
    this._descriptorFetches.clear();
    this._descriptorRevisions.clear();

    this.logger.info('DeviceManager closed');
  }

  // ─── Rate Limiting ────────────────────────────────────────

  /**
   * Check if a device has exceeded its message rate limit.
   * Uses a sliding 1-second window.
   * @param {string} deviceId
   * @returns {boolean} true if message should be dropped
   */
  _isRateLimited(deviceId) {
    const limit = this._getDeviceRateLimit(deviceId);
    if (limit <= 0) return false; // 0 = unlimited

    const now = Date.now();
    let counter = this._rateLimitCounters.get(deviceId);

    if (!counter || now - counter.windowStart >= 1000) {
      // New window
      counter = { count: 1, windowStart: now };
      this._rateLimitCounters.set(deviceId, counter);
      return false;
    }

    counter.count++;
    if (counter.count > limit) {
      return true; // Drop message
    }
    return false;
  }

  /**
   * Get rate limit for a device (cached, refreshed on device_settings_changed).
   * @param {string} deviceId
   * @returns {number} 0 = unlimited
   */
  _getDeviceRateLimit(deviceId) {
    if (this._rateLimitCache.has(deviceId)) {
      return this._rateLimitCache.get(deviceId);
    }
    let limit = 0;
    if (this.database) {
      try {
        const settings = this.database.getDeviceSettings(deviceId);
        if (settings) limit = settings.message_rate_limit || 0;
      } catch (_e) {
        /* device settings may not exist yet */
      }
    }
    this._rateLimitCache.set(deviceId, limit);
    return limit;
  }
}

export default DeviceManager;
