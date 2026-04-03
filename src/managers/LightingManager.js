// src/managers/LightingManager.js
import EventEmitter from 'events';
import LightingEffectsEngine from '../lighting/LightingEffectsEngine.js';
import BaseLightingDriver from '../lighting/BaseLightingDriver.js';

// Driver type to module path mapping
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
  constructor(app) {
    super();
    this.app = app;
    this.logger = app.logger;
    this.drivers = new Map();         // deviceId -> driver instance
    this.rulesByInstrument = new Map(); // instrumentId -> Rule[], '*' for wildcards
    this.allRules = [];
    this.activeNotes = new Map();     // deviceId -> Map<note, count> for polyphonic note-off tracking
    this.activeFades = new Map();     // fadeKey -> { interval, driver }
    this.masterDimmer = 255;          // Global master dimmer (0-255)
    this.deviceGroups = new Map();    // groupName -> Set<deviceId>
    this._healthCheckInterval = null;
    this._reloading = false;

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
      this.logger.info(`LightingManager initialized: ${this.drivers.size} device(s), ${this.allRules.length} rule(s), ${this.deviceGroups.size} group(s)`);
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
          this.logger.warn(`Cleared stale activeNotes for device ${deviceId}`);
        }
      }
    }, 10000);
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
    this.app.eventBus.on('midi_routed', this._onMidiRouted);

    // Listen for raw MIDI messages (for wildcard rules)
    this.app.eventBus.on('midi_message', this._onMidiMessage);
  }

  _removeEventListeners() {
    if (this._onMidiRouted) {
      this.app.eventBus.removeListener('midi_routed', this._onMidiRouted);
    }
    if (this._onMidiMessage) {
      this.app.eventBus.removeListener('midi_message', this._onMidiMessage);
    }
  }

  // ==================== RULE EVALUATION ENGINE ====================

  _evaluateRoutedEvent(event) {
    if (this.allRules.length === 0) return;

    const instrumentId = event.destination;
    const midiData = this._normalizeMidiData(event);

    // Mark this event as routed so _evaluateWildcardEvent skips wildcard rules for it
    const evtKey = `${midiData.type}_${midiData.channel}_${midiData.note ?? ''}_${midiData.controller ?? ''}_${event.timestamp || Date.now()}`;
    this._recentRoutedEvents.add(evtKey);
    // Clean up after a short delay to prevent memory buildup
    setTimeout(() => this._recentRoutedEvents.delete(evtKey), 50);

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

    // Skip if this event was already processed by _evaluateRoutedEvent (which includes wildcards)
    const evtKey = `${midiData.type}_${midiData.channel}_${midiData.note ?? ''}_${midiData.controller ?? ''}_${event.timestamp || Date.now()}`;
    if (this._recentRoutedEvents.has(evtKey)) return;

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

    // Handle note-off: turn off LEDs or fade out
    if (midiData.type === 'noteoff' || (midiData.type === 'noteon' && midiData.velocity === 0)) {
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
        return;
      }

      if (action.off_action === 'fade') {
        this._handleNoteOffWithFade(rule.device_id, midiData.note, driver, startLed, endLed, r, g, b, brightness, action.fade_time_ms || 500);
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
            const c = this._hexToRgb(action.color);
            driver.setColor(led, c.r, c.g, c.b, brightness);
          } else {
            // Default VU: green→yellow→red
            const ratio = i / Math.max(1, totalLeds - 1);
            let vr, vg, vb;
            if (ratio < 0.6) { vr = Math.round(ratio * 255 / 0.6); vg = 255; vb = 0; }
            else if (ratio < 0.8) { vr = 255; vg = Math.round(255 * (1 - (ratio - 0.6) / 0.2)); vb = 0; }
            else { vr = 255; vg = 0; vb = 0; }
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
      const clampedLed = Math.max(startLed, Math.min(endLed === -1 ? ledCount - 1 : endLed, ledIndex));

      // Use note_color if no explicit color
      const noteColor = action.color ? this._hexToRgb(action.color) : this._noteToColor(midiData.note);
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
      const val = midiData.value !== null ? midiData.value : (midiData.velocity || 64);
      return this._colorTemperature(val, action.temp_warm || 2700, action.temp_cool || 6500);
    }

    // Static color from hex
    const color = action.color || '#FFFFFF';
    return this._hexToRgb(color);
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

    const range = upper - lower;
    const ratio = range > 0 ? (value - lower) / range : 0;
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

  /**
   * Map MIDI note to chromatic color (C=red, C#=orange, D=yellow, etc.)
   */
  _noteToColor(note) {
    const hue = (note % 12) * 30; // 12 semitones * 30° = 360°
    return this._hsvToRgb(hue, 1.0, 1.0);
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
    return this._hsvToRgb(hue, 0.8 + Math.random() * 0.2, 0.8 + Math.random() * 0.2);
  }

  _hsvToRgb(h, s, v) {
    h = h % 360;
    const c = v * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = v - c;
    let r, g, b;

    if (h < 60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }

    return {
      r: Math.round((r + m) * 255),
      g: Math.round((g + m) * 255),
      b: Math.round((b + m) * 255)
    };
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
        // Stop any effects on this device
        this._stopEffectsForDevice(deviceId);
        driver.setRange(startLed, endLed, 0, 0, 0, 0);
      }
    }
  }

  _handleNoteOffWithFade(deviceId, note, driver, startLed, endLed, r, g, b, brightness, fadeTimeMs) {
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

    const fadeKey = `fadein_${Date.now()}`;
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

    const fadeKey = `fadeout_${Date.now()}`;
    const interval = setInterval(() => {
      step++;
      const factor = 1 - (step / steps);
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

    // Turn off after 2 seconds (longer for effects)
    const action = rule.action_config;
    const isEffect = ['strobe', 'rainbow', 'chase', 'fire', 'breathe', 'sparkle', 'color_cycle', 'wave'].includes(action.type);
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
    if (this.app.wsServer) {
      this.app.wsServer.broadcast('lighting_device_status', {
        deviceId,
        connected,
        timestamp: Date.now()
      });
    }
  }

  _broadcastLedState(deviceId, ledIndex, r, g, b) {
    if (this.app.wsServer && this._ledBroadcastEnabled) {
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
        this._ledBatchTimers.set(key, setTimeout(() => {
          const updates = this._ledBatchBuffer.get(key);
          this._ledBatchBuffer.delete(key);
          this._ledBatchTimers.delete(key);
          if (updates && updates.length > 0) {
            this.app.wsServer.broadcast('lighting_led_state', {
              deviceId, leds: updates
            });
          }
        }, 33)); // ~30fps
      }
    }
  }

  enableLedBroadcast(enabled) {
    this._ledBroadcastEnabled = !!enabled;
    return { success: true, enabled: this._ledBroadcastEnabled };
  }

  _broadcastEffectChange(effectKey, action) {
    if (this.app.wsServer) {
      this.app.wsServer.broadcast('lighting_effect_change', {
        effectKey,
        action,
        timestamp: Date.now()
      });
    }
  }

  // ==================== MASTER DIMMER ====================

  setMasterDimmer(value) {
    this.masterDimmer = Math.max(0, Math.min(255, value));
    return { success: true, masterDimmer: this.masterDimmer };
  }

  getMasterDimmer() {
    return this.masterDimmer;
  }

  // ==================== DEVICE GROUPS ====================

  _loadGroups() {
    try {
      const groups = this.app.database.getLightingGroups();
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
      this.app.database.insertLightingGroup(name, deviceIds);
      this.deviceGroups.set(name, new Set(deviceIds));
    } catch (error) {
      this.logger.warn(`Failed to persist group "${name}": ${error.message}`);
      throw error;
    }
    return { success: true };
  }

  deleteGroup(name) {
    const backup = this.deviceGroups.get(name);
    this.deviceGroups.delete(name);
    try {
      this.app.database.deleteLightingGroup(name);
    } catch (error) {
      // Restore memory state on DB failure
      if (backup) this.deviceGroups.set(name, backup);
      this.logger.warn(`Failed to delete group "${name}" from DB: ${error.message}`);
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
