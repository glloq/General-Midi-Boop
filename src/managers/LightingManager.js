// src/managers/LightingManager.js
import EventEmitter from 'events';

// Driver type to module path mapping
const DRIVER_MAP = {
  gpio: '../lighting/GpioLedDriver.js',
  gpio_strip: '../lighting/GpioStripDriver.js',
  serial: '../lighting/SerialLedDriver.js'
};

class LightingManager extends EventEmitter {
  constructor(app) {
    super();
    this.app = app;
    this.logger = app.logger;
    this.drivers = new Map();         // deviceId -> driver instance
    this.rulesByInstrument = new Map(); // instrumentId -> Rule[], '*' for wildcards
    this.allRules = [];
    this.activeNotes = new Map();     // deviceId -> Map<note, count> for polyphonic note-off tracking
    this._healthCheckInterval = null;
    this._reloading = false;

    this.initialize();
  }

  initialize() {
    try {
      this.loadRules();
      this.loadDevices();
      this._setupEventListeners();
      this._startHealthCheck();
      this.logger.info(`LightingManager initialized: ${this.drivers.size} device(s), ${this.allRules.length} rule(s)`);
    } catch (error) {
      this.logger.warn(`LightingManager init partial: ${error.message}`);
    }
  }

  _startHealthCheck() {
    // Periodic cleanup of stale activeNotes and check driver health
    this._healthCheckInterval = setInterval(() => {
      // Cap activeNotes per device to prevent memory leak from lost note-offs
      for (const [deviceId, notes] of this.activeNotes) {
        if (notes.size > 128) {
          notes.clear();
          this.logger.warn(`Cleared stale activeNotes for device ${deviceId}`);
        }
      }
    }, 30000);
  }

  // ==================== DATA LOADING ====================

  loadDevices() {
    try {
      const devices = this.app.database.getLightingDevices();
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
      this.allRules = this.app.database.getAllEnabledLightingRules();
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
      await driver.connect();
      this.drivers.set(device.id, driver);
    } catch (error) {
      this.logger.warn(`Failed to connect lighting device "${device.name}": ${error.message}`);
    }
  }

  async connectDevice(deviceId) {
    const device = this.app.database.getLightingDevice(deviceId);
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
    // Listen for routed MIDI messages (linked to specific instruments)
    this.app.eventBus.on('midi_routed', (event) => {
      this._evaluateRoutedEvent(event);
    });

    // Listen for raw MIDI messages (for wildcard rules)
    this.app.eventBus.on('midi_message', (event) => {
      this._evaluateWildcardEvent(event);
    });
  }

  // ==================== RULE EVALUATION ENGINE ====================

  _evaluateRoutedEvent(event) {
    if (this.allRules.length === 0) return;

    const instrumentId = event.destination;
    const midiData = this._normalizeMidiData(event);

    // Check rules for this specific instrument
    const instrumentRules = this.rulesByInstrument.get(instrumentId);
    if (instrumentRules) {
      for (const rule of instrumentRules) {
        if (this._matchesCondition(rule.condition_config, midiData)) {
          this._executeAction(rule, midiData);
        }
      }
    }

    // Also check wildcard rules
    const wildcardRules = this.rulesByInstrument.get('*');
    if (wildcardRules) {
      for (const rule of wildcardRules) {
        if (this._matchesCondition(rule.condition_config, midiData)) {
          this._executeAction(rule, midiData);
        }
      }
    }
  }

  _evaluateWildcardEvent(event) {
    if (this.allRules.length === 0) return;

    const wildcardRules = this.rulesByInstrument.get('*');
    if (!wildcardRules || wildcardRules.length === 0) return;

    const midiData = this._normalizeMidiData(event);
    for (const rule of wildcardRules) {
      if (this._matchesCondition(rule.condition_config, midiData)) {
        this._executeAction(rule, midiData);
      }
    }
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
      if (condition.velocity_min !== undefined && midi.velocity < condition.velocity_min) return false;
      if (condition.velocity_max !== undefined && midi.velocity > condition.velocity_max) return false;
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

  // ==================== ACTION EXECUTION ====================

  _executeAction(rule, midiData) {
    const driver = this.drivers.get(rule.device_id);
    if (!driver || !driver.isConnected()) return;

    const action = rule.action_config;
    let r, g, b;
    try {
      ({ r, g, b } = this._resolveColor(action, midiData));
    } catch {
      r = 255; g = 255; b = 255;
    }
    const brightness = Math.max(0, Math.min(255, this._resolveBrightness(action, midiData)));
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

    // Handle note-off: turn off LEDs
    if (midiData.type === 'noteoff' || (midiData.type === 'noteon' && midiData.velocity === 0)) {
      if (action.off_action === 'hold') {
        // "hold" = keep LED on, do nothing
        return;
      }
      this._handleNoteOff(rule.device_id, midiData.note, driver, startLed, endLed);
      return;
    }

    // Track active notes for note-off handling
    if (midiData.type === 'noteon' && midiData.velocity > 0) {
      this._trackNoteOn(rule.device_id, midiData.note);
    }

    // Set the color
    if (action.type === 'pulse') {
      this._pulseColor(driver, startLed, endLed, r, g, b, brightness, action.fade_time_ms || 200);
    } else {
      driver.setRange(startLed, endLed, r, g, b, brightness);
    }
  }

  _resolveColor(action, midiData) {
    if (action.type === 'velocity_mapped' && action.color_map) {
      return this._interpolateColorMap(action.color_map, midiData.velocity || midiData.value || 0);
    }

    // Static color from hex
    const color = action.color || '#FFFFFF';
    return this._hexToRgb(color);
  }

  _resolveBrightness(action, midiData) {
    if (action.brightness_from_velocity && midiData.velocity !== null) {
      // Map velocity 0-127 to 0-255
      return Math.round((midiData.velocity / 127) * 255);
    }
    return action.brightness !== undefined ? action.brightness : 255;
  }

  _interpolateColorMap(colorMap, value) {
    const stops = Object.keys(colorMap).map(Number).sort((a, b) => a - b);
    if (stops.length === 0) return { r: 255, g: 255, b: 255 };
    if (stops.length === 1) return this._hexToRgb(colorMap[stops[0]]);

    // Find surrounding stops
    if (value <= stops[0]) return this._hexToRgb(colorMap[stops[0]]);
    if (value >= stops[stops.length - 1]) return this._hexToRgb(colorMap[stops[stops.length - 1]]);

    let lower = stops[0], upper = stops[1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (value >= stops[i] && value <= stops[i + 1]) {
        lower = stops[i];
        upper = stops[i + 1];
        break;
      }
    }

    const ratio = (value - lower) / (upper - lower);
    const c1 = this._hexToRgb(colorMap[lower]);
    const c2 = this._hexToRgb(colorMap[upper]);

    return {
      r: Math.round(c1.r + (c2.r - c1.r) * ratio),
      g: Math.round(c1.g + (c2.g - c1.g) * ratio),
      b: Math.round(c1.b + (c2.b - c1.b) * ratio)
    };
  }

  _hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : { r: 255, g: 255, b: 255 };
  }

  // ==================== NOTE TRACKING ====================

  _trackNoteOn(deviceId, note) {
    if (!this.activeNotes.has(deviceId)) {
      this.activeNotes.set(deviceId, new Map());
    }
    const notes = this.activeNotes.get(deviceId);
    notes.set(note, (notes.get(note) || 0) + 1);
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
        driver.setRange(startLed, endLed, 0, 0, 0, 0);
      }
    }
  }

  // ==================== EFFECTS ====================

  _pulseColor(driver, startLed, endLed, r, g, b, brightness, durationMs) {
    driver.setRange(startLed, endLed, r, g, b, brightness);
    setTimeout(() => {
      driver.setRange(startLed, endLed, 0, 0, 0, 0);
    }, durationMs);
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
    const rule = this.app.database.getLightingRule(ruleId);
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

    // Turn off after 1 second
    setTimeout(() => {
      const driver = this.drivers.get(rule.device_id);
      if (driver) driver.allOff();
    }, 1000);

    return { success: true };
  }

  allOff() {
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
    if (this._healthCheckInterval) {
      clearInterval(this._healthCheckInterval);
      this._healthCheckInterval = null;
    }
    this.allOff();
    for (const [id] of this.drivers) {
      await this.disconnectDevice(id);
    }
    this.activeNotes.clear();
  }
}

export default LightingManager;
