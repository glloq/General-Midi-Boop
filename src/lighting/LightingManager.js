/**
 * @file src/lighting/LightingManager.js
 * @description Top-level lighting manager. Loads the appropriate
 * driver per device (mapped by `type` via {@link DRIVER_MAP}), routes
 * incoming MIDI events through the persisted rules, and exposes the
 * runtime API consumed by `LightingCommands`:
 *   - Effects engine (chase, pulse, sparkle, ...) via
 *     {@link LightingEffectsEngine}.
 *   - Master dimmer + blackout.
 *   - Device groups for bulk control.
 *   - MIDI-learn helper.
 *   - Scene save/apply (delegated to LightingCommands).
 *
 * The file is large (~970 LOC); only the constructor, lifecycle hooks
 * and public entry points carry full JSDoc per the plan.
 */
import EventEmitter from 'events';
import { performance } from 'perf_hooks';
import LightingEffectsEngine from '../lighting/LightingEffectsEngine.js';
import BaseLightingDriver from '../lighting/BaseLightingDriver.js';
import { hexToRgb, hsvToRgb } from '../utils/ColorUtils.js';
import { clamp } from '../utils/MathUtils.js';

/**
 * Driver type → ESM module path. Used for dynamic `import()` so a
 * missing native dep (pigpio, rpi-ws281x-native) only breaks the
 * specific driver, not the whole manager.
 */
const DRIVER_MAP = {
  gpio: '../lighting/GpioLedDriver.js',
  gpio_strip: '../lighting/GpioStripDriver.js',
  serial: '../lighting/SerialLedDriver.js',
  artnet: '../lighting/ArtNetDriver.js',
  sacn: '../lighting/SacnDriver.js',
  mqtt: '../lighting/MqttLightDriver.js',
  http: '../lighting/HttpLightDriver.js',
  osc: '../lighting/OscLightDriver.js'
};

class LightingManager extends EventEmitter {
  /**
   * @param {Object} deps - Service-container facade.
   *   The manager only reads `logger`, `database`, `eventBus` and
   *   `wsServer` from it; everything else is destructured at
   *   construction so the rest of the class never reaches back to
   *   the full app surface.
   */
  constructor(deps) {
    super();
    // Explicit dependency capture (replaces the legacy
    // `this.app = app` service-locator pattern). `wsServer` may not be
    // registered yet when the lighting manager starts; resolve lazily
    // through a getter.
    this.logger = deps.logger;
    this.database = deps.database;
    this.eventBus = deps.eventBus;
    Object.defineProperty(this, 'wsServer', {
      get: () => deps.wsServer,
      configurable: true
    });
    this.drivers = new Map(); // deviceId -> driver instance
    this.rulesByInstrument = new Map(); // instrumentId -> Rule[], '*' for wildcards
    this.allRules = [];
    this.activeNotes = new Map(); // deviceId -> Map<note, count> for polyphonic note-off tracking
    this.activeFades = new Map(); // fadeKey -> { interval, driver }
    this.masterDimmer = 255; // Global master dimmer (0-255)
    this._systemEnabled = true; // Global lighting system on/off
    this.deviceGroups = new Map(); // groupName -> Set<deviceId>
    this._healthCheckInterval = null;
    this._reloading = false;

    // ---- R17 / audit F-28: the lights must never run on the MIDI stack ----
    // `DeviceManager` emits `midi_message` BEFORE the router sends the note and
    // `EventBus.emit()` is a synchronous loop, so every driver write issued
    // from the listener was charged to the MIDI dispatch itself (measured: a
    // driver blocking 120 ms delayed the dispatch by 120.1 ms, and the cost was
    // multiplied by the number of matching rules). The listeners below now do
    // nothing but snapshot the event into this bounded FIFO; `_drain()` does
    // the matching and the driver writes from a `setImmediate`, off the
    // real-time path. Lighting is best-effort: it may be late, and under a
    // flood it may be dropped -- it may never cost the MIDI path a millisecond.
    /** @type {Array<?Object>} Pending events; `_queueHead` is the read cursor. */
    this._queue = [];
    this._queueHead = 0;
    /** Hard bound (F-36: an unbounded queue under a dense MIDI flood is a leak). */
    this._queueLimit = 512;
    /** Wall-clock budget for one drain tick; the remainder waits for the next. */
    this._drainBudgetMs = 8;
    /** One event costing more than this earns a (throttled) warning. */
    this._slowEventMs = 20;
    this._drainTimer = null;
    this._boundDrain = () => this._drain();
    this._lastQueueWarnAt = 0;
    this._dispatchStats = {
      queued: 0,
      processed: 0,
      dropped: 0,
      droppedReleases: 0,
      discarded: 0,
      errors: 0,
      slowEvents: 0,
      maxDepth: 0,
      lastDrainMs: 0
    };

    // Effects engine
    this.effectsEngine = new LightingEffectsEngine(this.logger);

    this.initialize();
  }

  initialize() {
    try {
      this.loadRules();
      this.loadDevices();
      this._loadGroups();
      this._setupEventListeners();
      this._startHealthCheck();
      this.logger.info(
        `LightingManager initialized: ${this.drivers.size} device(s), ${this.allRules.length} rule(s), ${this.deviceGroups.size} group(s)`
      );
    } catch (error) {
      this.logger.warn(`LightingManager init partial: ${error.message}`);
    }
  }

  _startHealthCheck() {
    // Periodic cleanup of stale activeNotes and check driver health
    this._healthCheckInterval = setInterval(() => {
      // Cap activeNotes per device to prevent memory leak from lost note-offs
      // MIDI has 128 notes max; 16 simultaneous is already generous
      for (const [deviceId, notes] of this.activeNotes) {
        if (notes.size > 16) {
          notes.clear();
          // R22 safety net: the note-off path keys on `activeNotes`, so
          // forgetting the held notes used to leave the fixture lit with
          // nobody left to switch it off -- the very "LED on for ever" failure
          // F-31 is about. Darken the device as we drop its tracking.
          try {
            const driver = this.drivers.get(deviceId);
            if (driver && driver.isConnected()) {
              this._stopEffectsForDevice(deviceId);
              driver.allOff();
            }
          } catch (error) {
            // A timer callback must never throw: it would be an unhandled
            // exception, i.e. the process.
            this.logger.warn(`Stale-note blackout failed for device ${deviceId}: ${error.message}`);
          }
          this.logger.warn(`Cleared stale activeNotes for device ${deviceId}`);
        }
      }
    }, 10000);
  }

  // ==================== DATA LOADING ====================

  loadDevices() {
    try {
      const devices = this.database.getLightingDevices();
      for (const device of devices) {
        if (device.enabled) {
          this._initDriver(device);
        }
      }
    } catch (error) {
      this.logger.warn(`Failed to load lighting devices: ${error.message}`);
    }
  }

  loadRules() {
    try {
      this.allRules = this.database.getAllEnabledLightingRules();
      this._indexRules();
    } catch (error) {
      this.logger.warn(`Failed to load lighting rules: ${error.message}`);
      this.allRules = [];
    }
  }

  _indexRules() {
    this.rulesByInstrument.clear();
    for (const rule of this.allRules) {
      const key = rule.instrument_id || '*';
      if (!this.rulesByInstrument.has(key)) {
        this.rulesByInstrument.set(key, []);
      }
      this.rulesByInstrument.get(key).push(rule);
    }
  }

  // ==================== DRIVER MANAGEMENT ====================

  async _initDriver(device) {
    const modulePath = DRIVER_MAP[device.type];
    if (!modulePath) {
      this.logger.warn(`No driver for lighting device type: ${device.type}`);
      return;
    }

    try {
      const { default: DriverClass } = await import(modulePath);
      const driver = new DriverClass(device, this.logger);
      BaseLightingDriver.validate(driver);
      await driver.connect();
      this.drivers.set(device.id, driver);
      this._broadcastDeviceStatus(device.id, true);

      // Listen for disconnect events
      driver.on('disconnected', () => {
        this._broadcastDeviceStatus(device.id, false);
      });
    } catch (error) {
      this.logger.warn(`Failed to connect lighting device "${device.name}": ${error.message}`);
      this._broadcastDeviceStatus(device.id, false);
    }
  }

  async connectDevice(deviceId) {
    const device = this.database.getLightingDevice(deviceId);
    if (!device) throw new Error(`Device ${deviceId} not found`);

    // Disconnect if already connected
    if (this.drivers.has(deviceId)) {
      await this.disconnectDevice(deviceId);
    }

    await this._initDriver(device);
    return this.drivers.has(deviceId);
  }

  async disconnectDevice(deviceId) {
    const driver = this.drivers.get(deviceId);
    if (driver) {
      // Stop any running effects for this device
      this.effectsEngine.stopEffectsForDriver(driver);
      try {
        await driver.disconnect();
      } catch (err) {
        this.logger.warn(`Error disconnecting device ${deviceId}: ${err.message}`);
      }
      this.drivers.delete(deviceId);
    }
  }

  // ==================== EVENT LISTENERS ====================

  _setupEventListeners() {
    // Track recently routed events to avoid double wildcard evaluation
    this._recentRoutedEvents = new Set();

    // Store bound handlers so we can remove them on shutdown
    this._onMidiRouted = (event) => this._evaluateRoutedEvent(event);
    this._onMidiMessage = (event) => this._evaluateWildcardEvent(event);

    // Listen for routed MIDI messages (linked to specific instruments)
    this.eventBus.on('midi_routed', this._onMidiRouted);

    // Listen for raw MIDI messages (for wildcard rules)
    this.eventBus.on('midi_message', this._onMidiMessage);
  }

  _removeEventListeners() {
    // EventBus (src/core/EventBus.js) exposes `off()`, NOT the Node
    // EventEmitter `removeListener()`. Calling the latter threw a TypeError on
    // the FIRST statement of shutdown(), so `allOff()` and the per-driver
    // disconnect below it were never reached: Application.stop() logged one
    // "Stop step lightingManager failed (continuing)" line and left every
    // fixture at its last value — a projector still lit after the show
    // (audit L02 F-30).
    if (this._onMidiRouted) {
      this.eventBus.off('midi_routed', this._onMidiRouted);
      this._onMidiRouted = null;
    }
    if (this._onMidiMessage) {
      this.eventBus.off('midi_message', this._onMidiMessage);
      this._onMidiMessage = null;
    }
  }

  // ==================== RULE EVALUATION ENGINE ====================
  //
  // R17 / audit F-28 -- the two entry points below are called from
  // `EventBus.emit()`, i.e. from the MIDI dispatch stack itself. They must
  // therefore stay O(1) and touch no driver: all they do is snapshot the event
  // into the bounded queue and arm one `setImmediate`. The matching, the colour
  // maths and the driver writes happen in `_drain()`, one event-loop turn later
  // and after the note has already been sent to the instrument.

  /** MIDI event routed to an instrument -- queued, never executed inline. */
  _evaluateRoutedEvent(event) {
    this._enqueueMidiEvent('routed', event);
  }

  /** Raw MIDI input (wildcard rules) -- queued, never executed inline. */
  _evaluateWildcardEvent(event) {
    this._enqueueMidiEvent('wildcard', event);
  }

  /**
   * Hot path. Same short-circuits as before (system off / no rule / no
   * wildcard rule), then a snapshot + a push. No driver is touched here.
   * @param {'routed'|'wildcard'} kind
   * @param {Object} event
   */
  _enqueueMidiEvent(kind, event) {
    if (!this._systemEnabled) return;
    if (this.allRules.length === 0) return;
    if (kind === 'wildcard') {
      const wildcardRules = this.rulesByInstrument.get('*');
      if (!wildcardRules || wildcardRules.length === 0) return;
    }

    // Snapshot: the emitter is free to reuse or mutate its payload once emit()
    // returns, and this entry can sit in the queue for several ticks.
    this._pushLightingEvent({
      kind,
      midiData: this._normalizeMidiData(event),
      instrumentId: kind === 'routed' ? event.destination : null,
      ts: event.timestamp || Date.now()
    });
  }

  /**
   * Append to the bounded queue and make sure a drain is armed.
   * @param {Object} entry
   */
  _pushLightingEvent(entry) {
    const stats = this._dispatchStats;
    if (this._queue.length - this._queueHead >= this._queueLimit) {
      this._dropOldestEvent();
    }
    this._queue.push(entry);
    stats.queued++;
    const depth = this._queue.length - this._queueHead;
    if (depth > stats.maxDepth) stats.maxDepth = depth;
    this._scheduleDrain();
  }

  _scheduleDrain() {
    if (this._drainTimer) return;
    this._drainTimer = setImmediate(this._boundDrain);
  }

  /**
   * Overflow policy (F-36). The queue is bounded, so something has to go; we
   * drop the oldest event that is NOT a release, because dropping a release is
   * exactly how a fixture stays lit for ever (R22 / F-31). Only when the queue
   * holds nothing but releases does the oldest release go.
   */
  _dropOldestEvent() {
    const stats = this._dispatchStats;
    for (let i = this._queueHead; i < this._queue.length; i++) {
      if (!this._isReleaseEvent(this._queue[i].midiData)) {
        if (i === this._queueHead) {
          this._queue[this._queueHead++] = null;
        } else {
          this._queue.splice(i, 1);
        }
        stats.dropped++;
        this._compactQueue();
        this._warnThrottled(
          `Lighting queue full (${this._queueLimit} events) - dropping lighting events (${stats.dropped} so far). The MIDI path is unaffected.`
        );
        return;
      }
    }
    this._queue[this._queueHead++] = null;
    stats.dropped++;
    stats.droppedReleases++;
    this._compactQueue();
    this._warnThrottled(
      `Lighting queue full (${this._queueLimit} events) and holds only note-offs - dropping the oldest release (${stats.droppedReleases} so far).`
    );
  }

  /**
   * Keep the backing array from growing behind the read cursor. Called from the
   * drain and from the overflow path (a burst can overflow many times inside a
   * single tick, before any drain gets to run), never from the nominal hot
   * path: one `slice` every `_queueLimit` drops is amortised O(1).
   */
  _compactQueue() {
    if (this._queueHead >= this._queue.length) {
      this._queue.length = 0;
      this._queueHead = 0;
    } else if (this._queueHead >= this._queueLimit) {
      this._queue = this._queue.slice(this._queueHead);
      this._queueHead = 0;
    }
  }

  /**
   * Process queued events until the queue is empty or the time budget is
   * spent; re-arm a `setImmediate` if anything is left, so a slow driver
   * yields the event loop back instead of monopolising it.
   * @param {number} [budgetMs] `Infinity` drains everything in one go.
   */
  _drain(budgetMs = this._drainBudgetMs) {
    this._drainTimer = null;
    const stats = this._dispatchStats;
    const startedAt = performance.now();

    while (this._queueHead < this._queue.length) {
      const entry = this._queue[this._queueHead];
      this._queue[this._queueHead++] = null;
      const eventStart = performance.now();
      try {
        if (entry.kind === 'routed') {
          this._applyRoutedEvent(entry);
        } else {
          this._applyWildcardEvent(entry);
        }
      } catch (error) {
        // Nothing above us catches any more: `EventBus.emit()` used to swallow
        // driver faults, but we no longer run inside emit(). An escaping throw
        // here would be an unhandled exception in a `setImmediate` callback,
        // i.e. the process.
        stats.errors++;
        this._warnThrottled(`Lighting rule dispatch failed: ${error.message}`);
      }
      stats.processed++;

      const spent = performance.now() - eventStart;
      if (spent > this._slowEventMs) {
        stats.slowEvents++;
        this._warnThrottled(
          `A lighting driver spent ${spent.toFixed(1)} ms on a single MIDI event ` +
            `(budget ${this._drainBudgetMs} ms/tick). The lights are late; the MIDI path is not.`
        );
      }
      if (performance.now() - startedAt >= budgetMs) break;
    }

    this._compactQueue();

    stats.lastDrainMs = performance.now() - startedAt;
    if (this._queueHead < this._queue.length) this._scheduleDrain();
  }

  /**
   * Drain everything pending, synchronously and without a budget. Never called
   * from the MIDI path: it exists for deterministic tests and for callers that
   * need the queue settled before doing something else.
   * @returns {number} events processed
   */
  flushLightingQueue() {
    const before = this._dispatchStats.processed;
    if (this._drainTimer) {
      clearImmediate(this._drainTimer);
      this._drainTimer = null;
    }
    this._drain(Infinity);
    return this._dispatchStats.processed - before;
  }

  /**
   * Throw away everything still queued. Called before every blackout /
   * all-off / shutdown, so a note-on that was queued milliseconds before the
   * operator hit blackout can never re-light the rig behind it.
   * @returns {number} events discarded
   */
  _discardPendingEvents() {
    const pending = this._queue.length - this._queueHead;
    this._queue.length = 0;
    this._queueHead = 0;
    if (this._drainTimer) {
      clearImmediate(this._drainTimer);
      this._drainTimer = null;
    }
    if (pending > 0) this._dispatchStats.discarded += pending;
    return pending;
  }

  /** Queue health, for tests and for whoever wants to observe the bound. */
  getDispatchStats() {
    return {
      ...this._dispatchStats,
      depth: this._queue.length - this._queueHead,
      limit: this._queueLimit,
      budgetMs: this._drainBudgetMs
    };
  }

  /** At most one queue/driver warning every 5 s: a flood must not flood the log. */
  _warnThrottled(message) {
    const now = Date.now();
    if (now - this._lastQueueWarnAt < 5000) return;
    this._lastQueueWarnAt = now;
    this.logger.warn(message);
  }

  // ---- the deferred half: everything below runs off the MIDI path ----

  _applyRoutedEvent(entry) {
    const midiData = entry.midiData;

    // KNOWN LIMITATION (audit F-32, deferred): this dedup between
    // `midi_message` (raw device input, carries a device timestamp) and
    // `midi_routed` (no timestamp; `data` is the channel-mapped/transposed
    // value) does not reliably match, so `*` wildcard rules can fire more than
    // once per logical input event. A correct fix needs a shared per-event id
    // plumbed from DeviceManager through the router (and dedup across
    // multi-destination fan-out), which is out of scope here. Left as-is
    // intentionally -- but note it is now paid off the MIDI path.
    const evtKey = this._eventKey(entry);
    this._recentRoutedEvents.add(evtKey);
    // Clean up after a short delay to prevent memory buildup
    setTimeout(() => this._recentRoutedEvents.delete(evtKey), 50);

    // Check rules for this specific instrument
    const instrumentRules = this.rulesByInstrument.get(entry.instrumentId);
    if (instrumentRules) {
      for (const rule of instrumentRules) {
        if (this._ruleMatches(rule, midiData)) {
          this._executeAction(rule, midiData);
        }
      }
    }

    // Also check wildcard rules
    const wildcardRules = this.rulesByInstrument.get('*');
    if (wildcardRules) {
      for (const rule of wildcardRules) {
        if (this._ruleMatches(rule, midiData)) {
          this._executeAction(rule, midiData);
        }
      }
    }
  }

  _applyWildcardEvent(entry) {
    const wildcardRules = this.rulesByInstrument.get('*');
    if (!wildcardRules || wildcardRules.length === 0) return;

    // Skip if this event was already processed by _applyRoutedEvent (which includes wildcards)
    if (this._recentRoutedEvents.has(this._eventKey(entry))) return;

    for (const rule of wildcardRules) {
      if (this._ruleMatches(rule, entry.midiData)) {
        this._executeAction(rule, entry.midiData);
      }
    }
  }

  _eventKey(entry) {
    const m = entry.midiData;
    return `${m.type}_${m.channel}_${m.note ?? ''}_${m.controller ?? ''}_${entry.ts}`;
  }

  _normalizeMidiData(event) {
    const data = event.data || event;
    return {
      type: event.type || data.type,
      channel: data.channel !== undefined ? data.channel : null,
      note: data.note !== undefined ? data.note : null,
      velocity: data.velocity !== undefined ? data.velocity : null,
      controller: data.controller !== undefined ? data.controller : null,
      value: data.value !== undefined ? data.value : null
    };
  }

  _matchesCondition(condition, midi) {
    // Check trigger type
    if (condition.trigger && condition.trigger !== 'any') {
      if (condition.trigger !== midi.type) return false;
    }

    // Check channel
    if (condition.channels && condition.channels.length > 0) {
      if (midi.channel === null || !condition.channels.includes(midi.channel)) return false;
    }

    // Check velocity range (for note events)
    if (midi.velocity !== null) {
      if (condition.velocity_min !== undefined && midi.velocity < condition.velocity_min)
        return false;
      if (condition.velocity_max !== undefined && midi.velocity > condition.velocity_max)
        return false;
    }

    // Check note range
    if (midi.note !== null) {
      if (condition.note_min !== undefined && midi.note < condition.note_min) return false;
      if (condition.note_max !== undefined && midi.note > condition.note_max) return false;
    }

    // Check CC number
    if (condition.cc_number && condition.cc_number.length > 0) {
      if (midi.controller === null || !condition.cc_number.includes(midi.controller)) return false;
    }

    // Check CC value range
    if (midi.value !== null && midi.type === 'cc') {
      if (condition.cc_value_min !== undefined && midi.value < condition.cc_value_min) return false;
      if (condition.cc_value_max !== undefined && midi.value > condition.cc_value_max) return false;
    }

    return true;
  }

  /**
   * Is this MIDI event a note release? Note On with velocity 0 is the running-
   * status form of Note Off (DeviceManager already normalises the ones it
   * sees, but rules can be fed from anywhere).
   * @param {Object} midi normalised MIDI data
   * @returns {boolean}
   */
  _isReleaseEvent(midi) {
    return midi.type === 'noteoff' || (midi.type === 'noteon' && midi.velocity === 0);
  }

  /**
   * Does `rule` react to `midi`?
   *
   * R22 / audit F-31 -- `_matchesCondition()` filters on the trigger type
   * first, so a rule with `trigger: 'noteon'` never saw the release and the
   * whole note-off half of `_executeAction()` was dead code for it: the fixture
   * lit on the first note and stayed lit until the system stopped. That was the
   * configuration the UI offers first, i.e. the default of every new rule. The
   * same happened to an `any` rule with a velocity floor (F-31b): the release
   * carries velocity 0 and fails the floor.
   *
   * Semantics chosen: **a rule that lit a note owns its release.** A release is
   * matched against the filters that say *where* the rule applies (instrument,
   * channel, note range, CC) but not against the ones that describe *how the
   * note was struck* (trigger type, velocity window) -- and only while that
   * note is actually being held on the rule's device. Rules that cannot light
   * on an attack (`trigger: 'cc'`, `trigger: 'noteoff'`) are untouched, and an
   * unpaired release still changes nothing.
   *
   * @param {Object} rule persisted lighting rule
   * @param {Object} midi normalised MIDI data
   * @returns {boolean}
   */
  _ruleMatches(rule, midi) {
    const condition = rule.condition_config || {};
    if (this._matchesCondition(condition, midi)) return true;
    return this._matchesPairedRelease(rule, condition, midi);
  }

  /**
   * The release half of {@link LightingManager#_ruleMatches}.
   * @param {Object} rule
   * @param {Object} condition
   * @param {Object} midi
   * @returns {boolean}
   */
  _matchesPairedRelease(rule, condition, midi) {
    if (!this._isReleaseEvent(midi) || midi.note === null) return false;

    // Only a rule that can light on an attack owns a release.
    const trigger = condition.trigger;
    if (trigger && trigger !== 'any' && trigger !== 'noteon') return false;

    // ...and only for a note it is actually holding on that device.
    const held = this.activeNotes.get(rule.device_id);
    if (!held || !held.has(midi.note)) return false;

    // Everything that is not "how the note was struck" must still hold.
    return this._matchesCondition(
      { ...condition, trigger: 'any', velocity_min: undefined, velocity_max: undefined },
      midi
    );
  }

  // ==================== ACTION EXECUTION ====================

  _executeAction(rule, midiData) {
    const driver = this.drivers.get(rule.device_id);
    if (!driver || !driver.isConnected()) return;

    const action = rule.action_config;
    let r, g, b;
    try {
      ({ r, g, b } = this._resolveColor(action, midiData));
    } catch {
      r = 255;
      g = 255;
      b = 255;
    }
    const brightness = clamp(this._resolveBrightness(action, midiData));
    // Resolve segment if specified (for gpio_strip devices)
    let segStart = action.led_start;
    let segEnd = action.led_end;
    if (action.segment && driver.getSegment) {
      const seg = driver.getSegment(action.segment);
      if (seg) {
        segStart = seg.start;
        segEnd = seg.end;
      }
    }

    // Boundary check LED indices
    const ledCount = driver.device?.led_count || 1;
    const startLed = Math.max(0, Math.min(segStart || 0, ledCount - 1));
    const rawEnd = segEnd !== undefined ? segEnd : -1;
    const endLed = rawEnd === -1 ? -1 : Math.max(startLed, Math.min(rawEnd, ledCount - 1));

    // Handle note-off: turn off LEDs or fade out
    if (this._isReleaseEvent(midiData)) {
      if (action.off_action === 'hold') {
        return;
      }

      // For note_led mode: turn off just the specific LED
      if (action.type === 'note_led' && midiData.note !== null) {
        const noteRange = (action.note_led_max || 127) - (action.note_led_min || 0);
        const lc = driver.device?.led_count || 1;
        const lr = (endLed === -1 ? lc - 1 : endLed) - startLed;
        const no = midiData.note - (action.note_led_min || 0);
        const li = startLed + Math.round((no / Math.max(1, noteRange)) * lr);
        const cl = Math.max(startLed, Math.min(endLed === -1 ? lc - 1 : endLed, li));
        driver.setColor(cl, 0, 0, 0, 0);
        this._untrackNote(rule.device_id, midiData.note);
        return;
      }

      if (action.off_action === 'fade') {
        this._handleNoteOffWithFade(
          rule.device_id,
          midiData.note,
          driver,
          startLed,
          endLed,
          r,
          g,
          b,
          brightness,
          action.fade_time_ms || 500
        );
      } else {
        this._handleNoteOff(rule.device_id, midiData.note, driver, startLed, endLed);
      }
      return;
    }

    // Track active notes for note-off handling
    if (midiData.type === 'noteon' && midiData.velocity > 0) {
      this._trackNoteOn(rule.device_id, midiData.note);
    }

    // VU meter: velocity determines how many LEDs light up (like a level meter)
    if (action.type === 'vu_meter') {
      const lc = driver.device?.led_count || 1;
      const totalLeds = (endLed === -1 ? lc - 1 : endLed) - startLed + 1;
      const vel = midiData.velocity || midiData.value || 0;
      const activeLeds = Math.round((vel / 127) * totalLeds);

      // Color gradient: green→yellow→red or custom
      for (let i = 0; i < totalLeds; i++) {
        const led = startLed + i;
        if (i < activeLeds) {
          if (action.color) {
            const c = hexToRgb(action.color);
            driver.setColor(led, c.r, c.g, c.b, brightness);
          } else {
            // Default VU: green→yellow→red
            const ratio = i / Math.max(1, totalLeds - 1);
            let vr, vg, vb;
            if (ratio < 0.6) {
              vr = Math.round((ratio * 255) / 0.6);
              vg = 255;
              vb = 0;
            } else if (ratio < 0.8) {
              vr = 255;
              vg = Math.round(255 * (1 - (ratio - 0.6) / 0.2));
              vb = 0;
            } else {
              vr = 255;
              vg = 0;
              vb = 0;
            }
            driver.setColor(led, vr, vg, vb, brightness);
          }
        } else {
          driver.setColor(led, 0, 0, 0, 0);
        }
      }
      return;
    }

    // Note-to-LED mapping: each note lights a specific LED
    if (action.type === 'note_led' && midiData.note !== null) {
      const noteRange = (action.note_led_max || 127) - (action.note_led_min || 0);
      const ledCount = driver.device?.led_count || 1;
      const ledRange = (endLed === -1 ? ledCount - 1 : endLed) - startLed;
      const noteOffset = midiData.note - (action.note_led_min || 0);
      const ledIndex = startLed + Math.round((noteOffset / Math.max(1, noteRange)) * ledRange);
      const clampedLed = Math.max(
        startLed,
        Math.min(endLed === -1 ? ledCount - 1 : endLed, ledIndex)
      );

      // Use note_color if no explicit color
      const noteColor = action.color ? hexToRgb(action.color) : this._noteToColor(midiData.note);
      driver.setColor(clampedLed, noteColor.r, noteColor.g, noteColor.b, brightness);
      return;
    }

    // Execute based on action type
    switch (action.type) {
      case 'pulse':
        this._pulseColor(driver, startLed, endLed, r, g, b, brightness, action.fade_time_ms || 200);
        break;
      case 'fade':
        this._fadeIn(driver, startLed, endLed, r, g, b, brightness, action.fade_time_ms || 500);
        break;
      case 'strobe':
      case 'rainbow':
      case 'chase':
      case 'fire':
      case 'breathe':
      case 'sparkle':
      case 'color_cycle':
      case 'wave': {
        const effectKey = `rule_${rule.id}_device_${rule.device_id}`;
        this.effectsEngine.startEffect(effectKey, action.type, driver, {
          led_start: startLed,
          led_end: endLed,
          speed: action.effect_speed || action.fade_time_ms || 500,
          brightness,
          color: action.color,
          color2: action.color2,
          density: action.effect_density
        });
        break;
      }
      default:
        // static or velocity_mapped
        driver.setRange(startLed, endLed, r, g, b, brightness);
    }
  }

  _resolveColor(action, midiData) {
    if (action.type === 'velocity_mapped' && action.color_map) {
      return this._interpolateColorMap(action.color_map, midiData.velocity || midiData.value || 0);
    }

    // Note-to-color: map MIDI note to chromatic hue
    if (action.type === 'note_color' && midiData.note !== null) {
      return this._noteToColor(midiData.note);
    }

    // Random color: generate a random vibrant color each time
    if (action.type === 'random_color') {
      return this._randomVibrantColor();
    }

    // Color temperature mode: map value (CC or velocity) to warm-cool
    if (action.type === 'color_temp') {
      const val = midiData.value !== null ? midiData.value : midiData.velocity || 64;
      return this._colorTemperature(val, action.temp_warm || 2700, action.temp_cool || 6500);
    }

    // Static color from hex
    const color = action.color || '#FFFFFF';
    return hexToRgb(color);
  }

  _resolveBrightness(action, midiData) {
    let bri;
    if (action.brightness_from_velocity && midiData.velocity !== null) {
      bri = Math.round((midiData.velocity / 127) * 255);
    } else {
      bri = action.brightness !== undefined ? action.brightness : 255;
    }
    // Apply master dimmer
    return Math.round((bri * this.masterDimmer) / 255);
  }

  _interpolateColorMap(colorMap, value) {
    const stops = Object.keys(colorMap)
      .map(Number)
      .sort((a, b) => a - b);
    if (stops.length === 0) return { r: 255, g: 255, b: 255 };
    if (stops.length === 1) return hexToRgb(colorMap[stops[0]]);

    // Find surrounding stops
    if (value <= stops[0]) return hexToRgb(colorMap[stops[0]]);
    if (value >= stops[stops.length - 1]) return hexToRgb(colorMap[stops[stops.length - 1]]);

    let lower = stops[0],
      upper = stops[1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (value >= stops[i] && value <= stops[i + 1]) {
        lower = stops[i];
        upper = stops[i + 1];
        break;
      }
    }

    const range = upper - lower;
    const ratio = range > 0 ? (value - lower) / range : 0;
    const c1 = hexToRgb(colorMap[lower]);
    const c2 = hexToRgb(colorMap[upper]);

    return {
      r: Math.round(c1.r + (c2.r - c1.r) * ratio),
      g: Math.round(c1.g + (c2.g - c1.g) * ratio),
      b: Math.round(c1.b + (c2.b - c1.b) * ratio)
    };
  }

  /**
   * Map MIDI note to chromatic color (C=red, C#=orange, D=yellow, etc.)
   */
  _noteToColor(note) {
    const hue = (note % 12) * 30; // 12 semitones * 30° = 360°
    return hsvToRgb(hue, 1.0, 1.0);
  }

  /**
   * Map a value (0-127) to a color temperature (warm to cool white)
   * warm = amber/warm white, cool = blue-white/daylight
   */
  _colorTemperature(value, warmK, coolK) {
    const ratio = value / 127;
    const kelvin = warmK + (coolK - warmK) * ratio;
    return this._kelvinToRgb(kelvin);
  }

  /**
   * Convert color temperature in Kelvin to RGB (Tanner Helland algorithm)
   */
  _kelvinToRgb(kelvin) {
    const temp = kelvin / 100;
    let r, g, b;

    if (temp <= 66) {
      r = 255;
      g = Math.min(255, Math.max(0, 99.4708025861 * Math.log(temp) - 161.1195681661));
    } else {
      r = Math.min(255, Math.max(0, 329.698727446 * Math.pow(temp - 60, -0.1332047592)));
      g = Math.min(255, Math.max(0, 288.1221695283 * Math.pow(temp - 60, -0.0755148492)));
    }

    if (temp >= 66) {
      b = 255;
    } else if (temp <= 19) {
      b = 0;
    } else {
      b = Math.min(255, Math.max(0, 138.5177312231 * Math.log(temp - 10) - 305.0447927307));
    }

    return { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
  }

  _randomVibrantColor() {
    const hue = Math.random() * 360;
    return hsvToRgb(hue, 0.8 + Math.random() * 0.2, 0.8 + Math.random() * 0.2);
  }

  // ==================== NOTE TRACKING ====================

  _trackNoteOn(deviceId, note) {
    if (!this.activeNotes.has(deviceId)) {
      this.activeNotes.set(deviceId, new Map());
    }
    const notes = this.activeNotes.get(deviceId);
    notes.set(note, (notes.get(note) || 0) + 1);
  }

  /**
   * Decrement the active-note counter without the LED/effect teardown that
   * `_handleNoteOff` performs. Used by the `note_led` note-off path, which
   * clears its own single LED and would otherwise leave the counter to
   * accumulate until the stale-note safety sweep clears it.
   * @param {string} deviceId
   * @param {number} note
   */
  _untrackNote(deviceId, note) {
    const notes = this.activeNotes.get(deviceId);
    if (!notes) return;
    const count = (notes.get(note) || 1) - 1;
    if (count <= 0) notes.delete(note);
    else notes.set(note, count);
  }

  _handleNoteOff(deviceId, note, driver, startLed, endLed) {
    const notes = this.activeNotes.get(deviceId);
    if (notes) {
      const count = (notes.get(note) || 1) - 1;
      if (count <= 0) {
        notes.delete(note);
      } else {
        notes.set(note, count);
      }

      // Only turn off if no active notes remain for this device
      if (notes.size === 0) {
        // Stop any effects on this device
        this._stopEffectsForDevice(deviceId);
        driver.setRange(startLed, endLed, 0, 0, 0, 0);
      }
    }
  }

  _handleNoteOffWithFade(
    deviceId,
    note,
    driver,
    startLed,
    endLed,
    r,
    g,
    b,
    brightness,
    fadeTimeMs
  ) {
    const notes = this.activeNotes.get(deviceId);
    if (notes) {
      const count = (notes.get(note) || 1) - 1;
      if (count <= 0) {
        notes.delete(note);
      } else {
        notes.set(note, count);
      }

      if (notes.size === 0) {
        this._stopEffectsForDevice(deviceId);
        this._fadeOut(driver, startLed, endLed, r, g, b, brightness, fadeTimeMs);
      }
    }
  }

  _stopEffectsForDevice(deviceId) {
    // Collect keys first to avoid modifying map while iterating
    const keysToStop = [];
    for (const [key] of this.effectsEngine.activeEffects) {
      if (key.includes(`device_${deviceId}`)) {
        keysToStop.push(key);
      }
    }
    for (const key of keysToStop) {
      this.effectsEngine.stopEffect(key);
    }
  }

  // ==================== EFFECTS ====================

  _pulseColor(driver, startLed, endLed, r, g, b, brightness, durationMs) {
    driver.setRange(startLed, endLed, r, g, b, brightness);
    setTimeout(() => {
      driver.setRange(startLed, endLed, 0, 0, 0, 0);
    }, durationMs);
  }

  _fadeIn(driver, startLed, endLed, r, g, b, targetBrightness, fadeTimeMs) {
    const steps = Math.max(1, Math.floor(fadeTimeMs / 16)); // ~60fps
    const stepTime = fadeTimeMs / steps;
    let step = 0;

    // Append a monotonic counter: two fades started in the same millisecond
    // would otherwise share a key, the second overwriting the first in
    // `activeFades`, so blackout()/allOff() could not cancel the orphaned
    // interval and it kept running through a requested blackout.
    this._fadeSeq = (this._fadeSeq || 0) + 1;
    const fadeKey = `fadein_${Date.now()}_${this._fadeSeq}`;
    const interval = setInterval(() => {
      step++;
      const factor = step / steps;
      const bri = Math.round(targetBrightness * factor);
      driver.setRange(startLed, endLed, r, g, b, bri);

      if (step >= steps) {
        clearInterval(interval);
        this.activeFades.delete(fadeKey);
      }
    }, stepTime);

    this.activeFades.set(fadeKey, { interval, driver });
  }

  _fadeOut(driver, startLed, endLed, r, g, b, startBrightness, fadeTimeMs) {
    const steps = Math.max(1, Math.floor(fadeTimeMs / 16));
    const stepTime = fadeTimeMs / steps;
    let step = 0;

    this._fadeSeq = (this._fadeSeq || 0) + 1;
    const fadeKey = `fadeout_${Date.now()}_${this._fadeSeq}`;
    const interval = setInterval(() => {
      step++;
      const factor = 1 - step / steps;
      const bri = Math.round(startBrightness * factor);
      driver.setRange(startLed, endLed, r, g, b, bri);

      if (step >= steps) {
        clearInterval(interval);
        this.activeFades.delete(fadeKey);
        driver.setRange(startLed, endLed, 0, 0, 0, 0);
      }
    }, stepTime);

    this.activeFades.set(fadeKey, { interval, driver });
  }

  // ==================== PUBLIC API ====================

  getDeviceStatus() {
    const result = [];
    for (const [id, driver] of this.drivers) {
      result.push({
        id,
        name: driver.device.name,
        type: driver.device.type,
        connected: driver.isConnected()
      });
    }
    return result;
  }

  async testDevice(deviceId) {
    const driver = this.drivers.get(deviceId);
    if (!driver || !driver.isConnected()) {
      throw new Error('Device not connected');
    }

    // Flash white briefly
    driver.setRange(0, -1, 255, 255, 255, 255);
    setTimeout(() => {
      driver.setRange(0, -1, 0, 0, 0, 0);
    }, 500);

    return { success: true };
  }

  testRule(ruleId) {
    const rule = this.database.getLightingRule(ruleId);
    if (!rule) throw new Error(`Rule ${ruleId} not found`);

    // Simulate a matching MIDI event
    const condition = rule.condition_config;
    const fakeMidi = {
      type: condition.trigger || 'noteon',
      channel: condition.channels?.[0] || 0,
      note: condition.note_min || 60,
      velocity: condition.velocity_max || 100,
      controller: condition.cc_number?.[0] || null,
      value: condition.cc_value_max || null
    };

    this._executeAction(rule, fakeMidi);

    // Turn off after 2 seconds (longer for effects)
    const action = rule.action_config;
    const isEffect = [
      'strobe',
      'rainbow',
      'chase',
      'fire',
      'breathe',
      'sparkle',
      'color_cycle',
      'wave'
    ].includes(action.type);
    const timeout = isEffect ? 3000 : 1000;

    setTimeout(() => {
      if (isEffect) {
        const effectKey = `rule_${rule.id}_device_${rule.device_id}`;
        this.effectsEngine.stopEffect(effectKey);
      }
      const driver = this.drivers.get(rule.device_id);
      if (driver) driver.allOff();
    }, timeout);

    return { success: true };
  }

  // Start an effect on a device (public API for direct effect control)
  startEffect(deviceId, effectType, config = {}) {
    const driver = this.drivers.get(deviceId);
    if (!driver || !driver.isConnected()) {
      throw new Error('Device not connected');
    }

    const effectKey = `manual_${deviceId}_${effectType}`;
    this.effectsEngine.startEffect(effectKey, effectType, driver, config);
    return { success: true, effectKey };
  }

  stopEffect(effectKey) {
    this.effectsEngine.stopEffect(effectKey);
    return { success: true };
  }

  getActiveEffects() {
    return this.effectsEngine.getActiveEffects();
  }

  // ==================== WEBSOCKET BROADCAST ====================

  _broadcastDeviceStatus(deviceId, connected) {
    if (this.wsServer) {
      this.wsServer.broadcast('lighting_device_status', {
        deviceId,
        connected,
        timestamp: Date.now()
      });
    }
  }

  _broadcastLedState(deviceId, ledIndex, r, g, b) {
    if (this.wsServer && this._ledBroadcastEnabled) {
      // Batch LED updates: accumulate changes and flush at ~30fps per device
      if (!this._ledBatchBuffer) this._ledBatchBuffer = new Map();
      if (!this._ledBatchTimers) this._ledBatchTimers = new Map();

      const key = `led_${deviceId}`;
      if (!this._ledBatchBuffer.has(key)) {
        this._ledBatchBuffer.set(key, []);
      }
      this._ledBatchBuffer.get(key).push({ ledIndex, r, g, b });

      // Schedule flush if not already pending
      if (!this._ledBatchTimers.has(key)) {
        this._ledBatchTimers.set(
          key,
          setTimeout(() => {
            const updates = this._ledBatchBuffer.get(key);
            this._ledBatchBuffer.delete(key);
            this._ledBatchTimers.delete(key);
            if (updates && updates.length > 0) {
              this.wsServer.broadcast('lighting_led_state', {
                deviceId,
                leds: updates
              });
            }
          }, 33)
        ); // ~30fps
      }
    }
  }

  enableLedBroadcast(enabled) {
    this._ledBroadcastEnabled = !!enabled;
    return { success: true, enabled: this._ledBroadcastEnabled };
  }

  setSystemEnabled(enabled) {
    this._systemEnabled = !!enabled;
    if (!this._systemEnabled) this.allOff();
    return { success: true, enabled: this._systemEnabled };
  }

  getSystemEnabled() {
    return { success: true, enabled: this._systemEnabled };
  }

  _broadcastEffectChange(effectKey, action) {
    if (this.wsServer) {
      this.wsServer.broadcast('lighting_effect_change', {
        effectKey,
        action,
        timestamp: Date.now()
      });
    }
  }

  // ==================== MASTER DIMMER ====================

  setMasterDimmer(value) {
    this.masterDimmer = clamp(value);
    return { success: true, masterDimmer: this.masterDimmer };
  }

  getMasterDimmer() {
    return this.masterDimmer;
  }

  // ==================== DEVICE GROUPS ====================

  _loadGroups() {
    try {
      const groups = this.database.getLightingGroups();
      this.deviceGroups.clear();
      for (const group of groups) {
        this.deviceGroups.set(group.name, new Set(group.device_ids));
      }
    } catch (error) {
      this.logger.warn(`Failed to load lighting groups: ${error.message}`);
    }
  }

  createGroup(name, deviceIds) {
    try {
      this.database.insertLightingGroup(name, deviceIds);
      this.deviceGroups.set(name, new Set(deviceIds));
    } catch (error) {
      // Caller does not get the result (we re-throw) — log at error.
      this.logger.error(`Failed to persist group "${name}": ${error.message}`);
      throw error;
    }
    return { success: true };
  }

  deleteGroup(name) {
    const backup = this.deviceGroups.get(name);
    this.deviceGroups.delete(name);
    try {
      this.database.deleteLightingGroup(name);
    } catch (error) {
      // Restore memory state on DB failure
      if (backup) this.deviceGroups.set(name, backup);
      // Per Logger.js conventions: the caller does NOT get the result
      // they asked for (we re-throw), so this is an error, not a warn.
      this.logger.error(`Failed to delete group "${name}" from DB: ${error.message}`);
      throw error;
    }
    return { success: true };
  }

  reloadGroups() {
    this._loadGroups();
  }

  getGroups() {
    const result = {};
    for (const [name, ids] of this.deviceGroups) {
      result[name] = [...ids];
    }
    return result;
  }

  setGroupColor(groupName, r, g, b, brightness = 255) {
    const group = this.deviceGroups.get(groupName);
    if (!group) throw new Error(`Group "${groupName}" not found`);

    const bri = Math.round((brightness * this.masterDimmer) / 255);
    for (const deviceId of group) {
      const driver = this.drivers.get(deviceId);
      if (driver && driver.isConnected()) {
        driver.setRange(0, -1, r, g, b, bri);
      }
    }
    return { success: true };
  }

  groupAllOff(groupName) {
    const group = this.deviceGroups.get(groupName);
    if (!group) throw new Error(`Group "${groupName}" not found`);

    for (const deviceId of group) {
      const driver = this.drivers.get(deviceId);
      if (driver && driver.isConnected()) {
        driver.allOff();
      }
    }
    return { success: true };
  }

  // ==================== BLACKOUT ====================

  blackout() {
    // R17: drop what the queue still holds FIRST. A note-on queued a
    // millisecond before the operator hit blackout must not re-light the rig
    // one tick after it went dark.
    this._discardPendingEvents();
    this.effectsEngine.stopAllEffects();
    for (const [, fade] of this.activeFades) {
      clearInterval(fade.interval);
    }
    this.activeFades.clear();
    for (const [, driver] of this.drivers) {
      if (driver.isConnected()) driver.allOff();
    }
    return { success: true };
  }

  allOff() {
    // R17: same ordering guarantee as blackout() -- nothing queued may be
    // written after the fixtures have been told to go dark.
    this._discardPendingEvents();
    // Stop all effects
    this.effectsEngine.stopAllEffects();
    // Clear all active fades
    for (const [, fade] of this.activeFades) {
      clearInterval(fade.interval);
    }
    this.activeFades.clear();
    // Turn off all drivers
    for (const [, driver] of this.drivers) {
      if (driver.isConnected()) {
        driver.allOff();
      }
    }
    this.activeNotes.clear();
  }

  reloadRules() {
    if (this._reloading) return;
    this._reloading = true;
    try {
      this.loadRules();
    } finally {
      this._reloading = false;
    }
  }

  async reloadDevices() {
    if (this._reloading) return;
    this._reloading = true;
    try {
      // Disconnect all existing
      for (const [id] of this.drivers) {
        await this.disconnectDevice(id);
      }
      this.loadDevices();
    } finally {
      this._reloading = false;
    }
  }

  async shutdown() {
    // Remove event listeners to prevent memory leaks
    this._removeEventListeners();

    // R17: no listener left to feed the queue, so drop what is still in it
    // BEFORE allOff() below. The blackout frame stays the last thing written
    // to every driver, and disconnectDevice() still awaits each driver's own
    // flush (the UDP drivers drain their socket before close, F-30b).
    // Guarded: `Application.stop()` and one audit suite call shutdown() on a
    // hand-built instance that never ran the constructor.
    if (typeof this._discardPendingEvents === 'function' && this._queue) {
      this._discardPendingEvents();
    }

    if (this._healthCheckInterval) {
      clearInterval(this._healthCheckInterval);
      this._healthCheckInterval = null;
    }

    // Clear LED batch timers
    if (this._ledBatchTimers) {
      for (const timer of this._ledBatchTimers.values()) {
        clearTimeout(timer);
      }
      this._ledBatchTimers.clear();
    }
    if (this._ledBatchBuffer) this._ledBatchBuffer.clear();

    // Clear active fades
    for (const [, fade] of this.activeFades) {
      if (fade.interval) clearInterval(fade.interval);
    }
    this.activeFades.clear();

    this.effectsEngine.shutdown();
    this.allOff();
    for (const [id] of this.drivers) {
      await this.disconnectDevice(id);
    }
    this.activeNotes.clear();
  }
}

export default LightingManager;
