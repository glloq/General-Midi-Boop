// src/api/CommandHandler.js
import JsonValidator from '../utils/JsonValidator.js';
import MidiTransposer from '../midi/MidiTransposer.js';
import JsonMidiConverter from '../storage/JsonMidiConverter.js';
import InstrumentCapabilitiesValidator from '../midi/InstrumentCapabilitiesValidator.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
const APP_VERSION = pkg.version;

// MIDI CC constants
const MIDI_CC = {
  ALL_SOUND_OFF: 120,
  ALL_NOTES_OFF: 123
};

class CommandHandler {
  constructor(app) {
    this.app = app;
    this.midiConverter = new JsonMidiConverter(app.logger);
    this.handlers = this.registerHandlers();

    this.app.logger.info(`CommandHandler initialized with ${Object.keys(this.handlers).length} commands`);
  }

  registerHandlers() {
    return {
      // ==================== DEVICE MANAGEMENT (15 commands) ====================
      'device_list': () => this.deviceList(),
      'device_refresh': () => this.deviceRefresh(),
      'device_info': (data) => this.deviceInfo(data),
      'device_set_properties': (data) => this.deviceSetProperties(data),
      'device_enable': (data) => this.deviceEnable(data),
      'device_identity_request': (data) => this.deviceIdentityRequest(data),
      'device_save_sysex_identity': (data) => this.deviceSaveSysExIdentity(data),
      'instrument_update_settings': (data) => this.instrumentUpdateSettings(data),
      'instrument_get_settings': (data) => this.instrumentGetSettings(data),
      'instrument_update_capabilities': (data) => this.instrumentUpdateCapabilities(data),
      'instrument_get_capabilities': (data) => this.instrumentGetCapabilities(data),
      'instrument_list_capabilities': () => this.instrumentListCapabilities(),
      'instrument_list_registered': () => this.instrumentListRegistered(),
      'instrument_list_connected': () => this.instrumentListConnected(),
      'instrument_delete': (data) => this.instrumentDelete(data),
      'instrument_create_virtual': (data) => this.instrumentCreateVirtual(data),
      'ble_scan_start': (data) => this.bleScanStart(data),
      'ble_scan_stop': () => this.bleScanStop(),
      'ble_connect': (data) => this.bleConnect(data),
      'ble_disconnect': (data) => this.bleDisconnect(data),
      'ble_forget': (data) => this.bleForget(data),
      'ble_paired': () => this.blePaired(),
      'ble_status': () => this.bleStatus(),
      'ble_power_on': () => this.blePowerOn(),
      'ble_power_off': () => this.blePowerOff(),
      'network_scan': (data) => this.networkScan(data),
      'network_connected_list': () => this.networkConnectedList(),
      'network_connect': (data) => this.networkConnect(data),
      'network_disconnect': (data) => this.networkDisconnect(data),
      'serial_scan': () => this.serialScan(),
      'serial_list': () => this.serialList(),
      'serial_open': (data) => this.serialOpen(data),
      'serial_close': (data) => this.serialClose(data),
      'serial_status': () => this.serialStatus(),
      'serial_set_enabled': (data) => this.serialSetEnabled(data),
      'virtual_create': (data) => this.virtualCreate(data),
      'virtual_delete': (data) => this.virtualDelete(data),
      'virtual_list': () => this.virtualList(),

      // ==================== MIDI ROUTING (15 commands) ====================
      'route_create': (data) => this.routeCreate(data),
      'route_delete': (data) => this.routeDelete(data),
      'route_list': () => this.routeList(),
      'route_enable': (data) => this.routeEnable(data),
      'route_info': (data) => this.routeInfo(data),
      'filter_set': (data) => this.filterSet(data),
      'filter_clear': (data) => this.filterClear(data),
      'channel_map': (data) => this.channelMap(data),
      'monitor_start': (data) => this.monitorStart(data),
      'monitor_stop': (data) => this.monitorStop(data),
      'route_test': (data) => this.routeTest(data),
      'route_duplicate': (data) => this.routeDuplicate(data),
      'route_export': (data) => this.routeExport(data),
      'route_import': (data) => this.routeImport(data),
      'route_clear_all': () => this.routeClearAll(),

      // ==================== FILE MANAGEMENT (18 commands) ====================
      'file_upload': (data) => this.fileUpload(data),
      'file_list': (data) => this.fileList(data),
      'file_metadata': (data) => this.fileMetadata(data),
      'file_load': (data) => this.fileLoad(data),
      'file_read': (data) => this.fileRead(data),
      'file_write': (data) => this.fileWrite(data),
      'file_delete': (data) => this.fileDelete(data),
      'file_save': (data) => this.fileSave(data),
      'file_save_as': (data) => this.fileSaveAs(data),
      'file_rename': (data) => this.fileRename(data),
      'file_move': (data) => this.fileMove(data),
      'file_duplicate': (data) => this.fileDuplicate(data),
      'file_export': (data) => this.fileExport(data),
      'file_search': (data) => this.fileSearch(data),
      'file_filter': (data) => this.fileFilter(data),
      'file_channels': (data) => this.fileChannels(data),
      'file_reanalyze_all': () => this.fileReanalyzeAll(),
      'midi_instruments_list': () => this.midiInstrumentsList(),
      'midi_categories_list': () => this.midiCategoriesList(),

      // ==================== PLAYBACK (17 commands) ====================
      'playback_start': (data) => this.playbackStart(data),
      'playback_stop': () => this.playbackStop(),
      'playback_pause': () => this.playbackPause(),
      'playback_resume': () => this.playbackResume(),
      'playback_seek': (data) => this.playbackSeek(data),
      'playback_status': () => this.playbackStatus(),
      'playback_set_loop': (data) => this.playbackSetLoop(data),
      'playback_set_tempo': (data) => this.playbackSetTempo(data),
      'playback_transpose': (data) => this.playbackTranspose(data),
      'playback_set_volume': (data) => this.playbackSetVolume(data),
      'playback_get_channels': () => this.playbackGetChannels(),
      'playback_set_channel_routing': (data) => this.playbackSetChannelRouting(data),
      'playback_clear_channel_routing': () => this.playbackClearChannelRouting(),
      'playback_mute_channel': (data) => this.playbackMuteChannel(data),
      'analyze_channel': (data) => this.analyzeChannel(data),
      'generate_assignment_suggestions': (data) => this.generateAssignmentSuggestions(data),
      'apply_assignments': (data) => this.applyAssignments(data),
      'validate_instrument_capabilities': (data) => this.validateInstrumentCapabilities(data),
      'get_instrument_defaults': (data) => this.getInstrumentDefaults(data),
      'update_instrument_capabilities': (data) => this.updateInstrumentCapabilities(data),
      'get_file_routings': (data) => this.getFileRoutings(data),

      // ==================== LATENCY (10 commands) ====================
      'latency_measure': (data) => this.latencyMeasure(data),
      'latency_set': (data) => this.latencySet(data),
      'latency_get': (data) => this.latencyGet(data),
      'latency_list': () => this.latencyList(),
      'latency_delete': (data) => this.latencyDelete(data),
      'latency_auto_calibrate': (data) => this.latencyAutoCalibrate(data),
      'latency_recommendations': () => this.latencyRecommendations(),
      'latency_export': () => this.latencyExport(),
      'calibrate_delay': (data) => this.calibrateDelay(data),
      'calibrate_list_alsa_devices': () => this.calibrateListAlsaDevices(),

      // ==================== MIDI MESSAGES (8 commands) ====================
      'midi_send': (data) => this.midiSend(data),
      'midi_send_note': (data) => this.midiSendNote(data),
      'midi_send_cc': (data) => this.midiSendCc(data),
      'midi_send_program': (data) => this.midiSendProgram(data),
      'midi_send_pitchbend': (data) => this.midiSendPitchbend(data),
      'midi_panic': (data) => this.midiPanic(data),
      'midi_all_notes_off': (data) => this.midiAllNotesOff(data),
      'midi_reset': (data) => this.midiReset(data),

      // ==================== SYSTEM (8 commands) ====================
      'system_status': () => this.systemStatus(),
      'system_info': () => this.systemInfo(),
      'system_restart': () => this.systemRestart(),
      'system_shutdown': () => this.systemShutdown(),
      'system_update': () => this.systemUpdate(),
      'system_backup': (data) => this.systemBackup(data),
      'system_restore': (data) => this.systemRestore(data),
      'system_logs': (data) => this.systemLogs(data),
      'system_clear_logs': () => this.systemClearLogs(),

      // ==================== SESSIONS (6 commands) ====================
      'session_save': (data) => this.sessionSave(data),
      'session_load': (data) => this.sessionLoad(data),
      'session_list': () => this.sessionList(),
      'session_delete': (data) => this.sessionDelete(data),
      'session_export': (data) => this.sessionExport(data),
      'session_import': (data) => this.sessionImport(data),

      // ==================== PRESETS (6 commands) ====================
      'preset_save': (data) => this.presetSave(data),
      'preset_load': (data) => this.presetLoad(data),
      'preset_list': (data) => this.presetList(data),
      'preset_delete': (data) => this.presetDelete(data),
      'preset_rename': (data) => this.presetRename(data),
      'preset_export': (data) => this.presetExport(data),

      // ==================== PLAYLISTS (4 commands) ====================
      'playlist_create': (data) => this.playlistCreate(data),
      'playlist_delete': (data) => this.playlistDelete(data),
      'playlist_list': () => this.playlistList(),
      'playlist_add_file': (data) => this.playlistAddFile(data)
    };
  }

  async handle(message, ws) {
    const startTime = Date.now();

    try {
      this.app.logger.info(`Handling command: ${message.command} (id: ${message.id})`);

      // Validate message structure
      const validation = JsonValidator.validateCommand(message);
      if (!validation.valid) {
        throw new Error(`Invalid message: ${validation.errors.join(', ')}`);
      }

      // Get handler
      const handler = this.handlers[message.command];
      if (!handler) {
        throw new Error(`Unknown command: ${message.command}`);
      }

      this.app.logger.info(`Executing handler for: ${message.command}`);

      // Execute handler
      const result = await handler(message.data || {});

      this.app.logger.info(`Handler executed, sending response for: ${message.command}`);

      // Send response with request ID for client to match
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({
          id: message.id, // Include request ID
          type: 'response',
          command: message.command,
          data: result,
          timestamp: Date.now(),
          duration: Date.now() - startTime
        }));
      }

      this.app.logger.info(`Command ${message.command} completed in ${Date.now() - startTime}ms`);
    } catch (error) {
      this.app.logger.error(`Command ${message.command} failed: ${error.message}`);
      this.app.logger.error(error.stack);

      if (ws.readyState === 1) {
        ws.send(JSON.stringify({
          id: message.id, // Include request ID even in errors
          type: 'error',
          command: message.command,
          error: error.message,
          timestamp: Date.now()
        }));
      }
    }
  }

  // ==================== DEVICE HANDLERS ====================

  async deviceList() {
    const devices = this.app.deviceManager.getDeviceList();

    // Enrichir les appareils avec les données depuis la base de données
    if (this.app.database) {
      for (const device of devices) {
        try {
          const settings = this.app.database.getInstrumentSettings(device.id);
          if (settings) {
            if (settings.custom_name) {
              device.displayName = settings.custom_name;
            }
            // Inclure les champs de configuration instrument
            if (settings.gm_program !== null && settings.gm_program !== undefined) {
              device.gm_program = settings.gm_program;
            }
            if (settings.polyphony !== null && settings.polyphony !== undefined) {
              device.polyphony = settings.polyphony;
            }
            if (settings.note_range_min !== null && settings.note_range_min !== undefined) {
              device.note_range_min = settings.note_range_min;
            }
            if (settings.note_range_max !== null && settings.note_range_max !== undefined) {
              device.note_range_max = settings.note_range_max;
            }
            if (settings.note_selection_mode) {
              device.note_selection_mode = settings.note_selection_mode;
            }
          }
        } catch (error) {
          // Ignorer les erreurs - l'appareil n'a peut-être pas de settings
        }
      }
    }

    this.app.logger.debug(`[CommandHandler] deviceList returning ${devices.length} devices:`,
      devices.map(d => `"${d.displayName || d.name}" (${d.type})`).join(', '));
    return { devices: devices };
  }

  async deviceRefresh() {
    const devices = await this.app.deviceManager.scanDevices();
    return { devices: devices };
  }

  async deviceInfo(data) {
    const device = this.app.deviceManager.getDeviceInfo(data.deviceId);
    if (!device) {
      throw new Error(`Device not found: ${data.deviceId}`);
    }
    return { device: device };
  }

  async deviceSetProperties(data) {
    // Future implementation for device-specific settings
    return { success: true };
  }

  async deviceEnable(data) {
    this.app.deviceManager.enableDevice(data.deviceId, data.enabled);
    return { success: true };
  }

  async deviceIdentityRequest(data) {
    // sendIdentityRequest() will throw an exception if it fails
    this.app.deviceManager.sendIdentityRequest(
      data.deviceName,
      data.deviceId || 0x7F
    );

    return {
      success: true,
      message: 'Identity Request sent. Waiting for response...'
    };
  }

  async deviceSaveSysExIdentity(data) {
    if (!this.app.database) {
      throw new Error('Database not available');
    }

    // Channel defaults to 0 for backward compatibility
    const channel = data.channel !== undefined ? data.channel : 0;
    const id = this.app.database.saveSysExIdentity(data.deviceId, channel, data.identity);

    return {
      success: true,
      id: id
    };
  }

  async instrumentUpdateSettings(data) {
    if (!this.app.database) {
      throw new Error('Database not available');
    }

    // Get USB serial number from data or from DeviceManager
    let usbSerialNumber = data.usb_serial_number;
    if (!usbSerialNumber && this.app.deviceManager) {
      const device = this.app.deviceManager.getDeviceInfo(data.deviceId);
      if (device && device.usbSerialNumber) {
        usbSerialNumber = device.usbSerialNumber;
      }
    }

    // Channel defaults to 0 for backward compatibility
    const channel = data.channel !== undefined ? parseInt(data.channel) : 0;
    if (channel < 0 || channel > 15) {
      throw new Error('channel must be between 0 and 15');
    }

    // Validate sync_delay range (milliseconds, ±5 seconds max)
    if (data.sync_delay !== undefined) {
      const parsedDelay = parseInt(data.sync_delay);
      if (isNaN(parsedDelay) || parsedDelay < -5000 || parsedDelay > 5000) {
        throw new Error('sync_delay must be between -5000 and 5000 milliseconds');
      }
      data.sync_delay = parsedDelay;
    }

    const id = this.app.database.updateInstrumentSettings(data.deviceId, channel, {
      custom_name: data.custom_name,
      sync_delay: data.sync_delay,
      mac_address: data.mac_address,
      usb_serial_number: usbSerialNumber,
      name: data.name,
      gm_program: data.gm_program
    });

    // Notify routing/playback systems to invalidate cached compensation values
    this.app.eventBus?.emit('instrument_settings_changed', {
      deviceId: data.deviceId,
      channel
    });

    return {
      success: true,
      id: id
    };
  }

  async instrumentGetSettings(data) {
    if (!this.app.database) {
      throw new Error('Database not available');
    }

    // Pass channel if provided, otherwise backward compat (first match)
    const channel = data.channel !== undefined ? data.channel : undefined;
    const settings = this.app.database.getInstrumentSettings(data.deviceId, channel);

    return {
      settings: settings || null
    };
  }

  async instrumentUpdateCapabilities(data) {
    if (!this.app.database) {
      throw new Error('Database not available');
    }

    if (!data.deviceId) {
      throw new Error('deviceId is required');
    }

    // Channel defaults to 0 for backward compatibility
    const channel = data.channel !== undefined ? parseInt(data.channel) : 0;
    if (channel < 0 || channel > 15) {
      throw new Error('channel must be between 0 and 15');
    }

    const id = this.app.database.updateInstrumentCapabilities(data.deviceId, channel, {
      note_range_min: data.note_range_min,
      note_range_max: data.note_range_max,
      supported_ccs: data.supported_ccs,
      note_selection_mode: data.note_selection_mode,
      selected_notes: data.selected_notes,
      polyphony: data.polyphony,
      capabilities_source: data.capabilities_source || 'manual'
    });

    return {
      success: true,
      id: id
    };
  }

  async instrumentGetCapabilities(data) {
    if (!this.app.database) {
      throw new Error('Database not available');
    }

    if (!data.deviceId) {
      throw new Error('deviceId is required');
    }

    // Pass channel if provided, otherwise backward compat (first match)
    const channel = data.channel !== undefined ? data.channel : undefined;
    const capabilities = this.app.database.getInstrumentCapabilities(data.deviceId, channel);

    return {
      capabilities: capabilities || null
    };
  }

  async instrumentListCapabilities() {
    if (!this.app.database) {
      throw new Error('Database not available');
    }

    const instruments = this.app.database.getAllInstrumentCapabilities();

    return {
      instruments: instruments
    };
  }

  async instrumentListRegistered() {
    if (!this.app.database) {
      throw new Error('Database not available');
    }

    const instruments = this.app.database.getInstrumentsWithCapabilities();

    return {
      success: true,
      instruments: instruments,
      total: instruments.length
    };
  }

  async instrumentListConnected() {
    if (!this.app.database) {
      throw new Error('Database not available');
    }

    const allInstruments = this.app.database.getInstrumentsWithCapabilities();
    const connectedDevices = this.app.deviceManager.getDeviceList();
    const connectedDeviceIds = new Set(connectedDevices.map(d => d.id));

    const connectedInstruments = allInstruments.filter(
      inst => connectedDeviceIds.has(inst.device_id)
    );

    return {
      success: true,
      instruments: connectedInstruments,
      total: connectedInstruments.length,
      connectedDevices: connectedDevices.length
    };
  }

  async instrumentDelete(data) {
    if (!this.app.database) {
      throw new Error('Database not available');
    }

    if (!data.deviceId) {
      throw new Error('deviceId is required');
    }

    // Delete instrument settings/capabilities from instruments_latency by device_id
    try {
      this.app.database.db.prepare('DELETE FROM instruments_latency WHERE device_id = ?').run(data.deviceId);
    } catch (e) {
      // May not have latency settings
    }

    // Delete from instruments table if exists
    try {
      this.app.database.deleteInstrument(data.deviceId);
    } catch (e) {
      // May not have an instruments entry
    }

    // Also delete latency profile if exists
    try {
      this.app.database.deleteLatencyProfile(data.deviceId);
    } catch (e) {
      // May not have a latency profile
    }

    return {
      success: true
    };
  }

  /**
   * Cree un instrument virtuel en DB (sans device physique)
   * Utile pour les tests d'auto-assignation
   */
  // Presets d'instruments virtuels avec capabilities pre-configurees
  static VIRTUAL_INSTRUMENT_PRESETS = {
    piano: {
      name: 'Piano', gm_program: 0,
      note_range_min: 21, note_range_max: 108, polyphony: 64,
      note_selection_mode: 'range', supported_ccs: [1, 7, 10, 11, 64, 91, 93]
    },
    electric_piano: {
      name: 'Piano Électrique', gm_program: 4,
      note_range_min: 28, note_range_max: 103, polyphony: 32,
      note_selection_mode: 'range', supported_ccs: [1, 7, 10, 11, 64, 91, 93]
    },
    organ: {
      name: 'Orgue', gm_program: 19,
      note_range_min: 36, note_range_max: 96, polyphony: 16,
      note_selection_mode: 'range', supported_ccs: [1, 7, 10, 11, 91, 93]
    },
    guitar: {
      name: 'Guitare', gm_program: 25,
      note_range_min: 40, note_range_max: 88, polyphony: 6,
      note_selection_mode: 'range', supported_ccs: [1, 7, 10, 11, 64]
    },
    bass: {
      name: 'Basse', gm_program: 33,
      note_range_min: 28, note_range_max: 67, polyphony: 4,
      note_selection_mode: 'range', supported_ccs: [1, 7, 10, 11, 64]
    },
    violin: {
      name: 'Violon', gm_program: 40,
      note_range_min: 55, note_range_max: 103, polyphony: 4,
      note_selection_mode: 'range', supported_ccs: [1, 7, 10, 11, 64, 71]
    },
    cello: {
      name: 'Violoncelle', gm_program: 42,
      note_range_min: 36, note_range_max: 84, polyphony: 4,
      note_selection_mode: 'range', supported_ccs: [1, 7, 10, 11, 64, 71]
    },
    strings: {
      name: 'Ensemble Cordes', gm_program: 48,
      note_range_min: 36, note_range_max: 96, polyphony: 16,
      note_selection_mode: 'range', supported_ccs: [1, 7, 10, 11, 64, 71]
    },
    trumpet: {
      name: 'Trompette', gm_program: 56,
      note_range_min: 52, note_range_max: 84, polyphony: 1,
      note_selection_mode: 'range', supported_ccs: [1, 2, 5, 7, 10, 11, 74, 76, 77, 78, 91]
    },
    saxophone: {
      name: 'Saxophone', gm_program: 66,
      note_range_min: 49, note_range_max: 87, polyphony: 1,
      note_selection_mode: 'range', supported_ccs: [1, 2, 5, 7, 10, 11, 74, 76, 77, 78, 91]
    },
    flute: {
      name: 'Flûte', gm_program: 73,
      note_range_min: 60, note_range_max: 96, polyphony: 1,
      note_selection_mode: 'range', supported_ccs: [1, 2, 5, 7, 10, 11, 74, 76, 77, 78, 91]
    },
    synth_lead: {
      name: 'Synth Lead', gm_program: 80,
      note_range_min: 36, note_range_max: 96, polyphony: 8,
      note_selection_mode: 'range', supported_ccs: [1, 7, 10, 11, 64, 71, 74, 91]
    },
    synth_pad: {
      name: 'Synth Pad', gm_program: 88,
      note_range_min: 36, note_range_max: 96, polyphony: 16,
      note_selection_mode: 'range', supported_ccs: [1, 7, 10, 11, 64, 71, 74, 91]
    },
    drums: {
      name: 'Batterie', gm_program: 0, channel: 9,
      note_range_min: 35, note_range_max: 81, polyphony: 16,
      note_selection_mode: 'discrete',
      selected_notes: [35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 53, 55, 57, 59],
      supported_ccs: [7, 10]
    }
  };

  async instrumentCreateVirtual(data) {
    if (!this.app.database) {
      throw new Error('Database not available');
    }

    // Appliquer le preset si un type est fourni
    const preset = data.type ? CommandHandler.VIRTUAL_INSTRUMENT_PRESETS[data.type] : null;

    const name = data.name || (preset ? preset.name : 'Virtual Instrument');
    const deviceId = `virtual_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const channel = preset && preset.channel !== undefined ? preset.channel : (data.channel || 0);

    // Inserer dans instruments_latency avec les settings de base
    const settings = { name: name, custom_name: name };
    if (preset) settings.gm_program = preset.gm_program;
    if (data.gm_program !== undefined) settings.gm_program = data.gm_program;

    this.app.database.updateInstrumentSettings(deviceId, channel, settings);

    // Construire les capabilities depuis le preset et/ou les donnees fournies
    const capabilities = { capabilities_source: 'manual' };

    if (preset) {
      capabilities.note_range_min = preset.note_range_min;
      capabilities.note_range_max = preset.note_range_max;
      capabilities.polyphony = preset.polyphony;
      capabilities.note_selection_mode = preset.note_selection_mode;
      if (preset.selected_notes) capabilities.selected_notes = preset.selected_notes;
      if (preset.supported_ccs) capabilities.supported_ccs = preset.supported_ccs;
    }

    // Les donnees explicites ecrasent le preset
    if (data.note_range_min !== undefined) capabilities.note_range_min = data.note_range_min;
    if (data.note_range_max !== undefined) capabilities.note_range_max = data.note_range_max;
    if (data.polyphony !== undefined) capabilities.polyphony = data.polyphony;
    if (data.note_selection_mode) capabilities.note_selection_mode = data.note_selection_mode;
    if (data.selected_notes) capabilities.selected_notes = data.selected_notes;
    if (data.supported_ccs) capabilities.supported_ccs = data.supported_ccs;

    if (Object.keys(capabilities).length > 1) {
      this.app.database.updateInstrumentCapabilities(deviceId, channel, capabilities);
    }

    this.app.logger.info(`Virtual instrument created: ${name} (${deviceId}, type=${data.type || 'custom'}, ch=${channel})`);

    return { success: true, deviceId, id: `${deviceId}_${channel}`, channel };
  }

  async bleScanStart(data) {
    if (!this.app.bluetoothManager) {
      throw new Error('Bluetooth not available');
    }

    const duration = data.duration || 5;
    const filter = data.filter || '';

    const devices = await this.app.bluetoothManager.startScan(duration, filter);

    return {
      success: true,
      data: {
        devices: devices
      }
    };
  }

  async bleScanStop() {
    if (!this.app.bluetoothManager) {
      throw new Error('Bluetooth not available');
    }

    this.app.bluetoothManager.stopScan();
    return { success: true };
  }

  async bleConnect(data) {
    if (!this.app.bluetoothManager) {
      throw new Error('Bluetooth not available');
    }

    if (!data.address) {
      throw new Error('Device address is required');
    }

    const result = await this.app.bluetoothManager.connect(data.address);

    return {
      success: true,
      data: result
    };
  }

  async bleDisconnect(data) {
    if (!this.app.bluetoothManager) {
      throw new Error('Bluetooth not available');
    }

    if (!data.address) {
      throw new Error('Device address is required');
    }

    const result = await this.app.bluetoothManager.disconnect(data.address);

    return {
      success: true,
      data: result
    };
  }

  async bleForget(data) {
    if (!this.app.bluetoothManager) {
      throw new Error('Bluetooth not available');
    }

    if (!data.address) {
      throw new Error('Device address is required');
    }

    await this.app.bluetoothManager.forget(data.address);

    return {
      success: true
    };
  }

  async blePaired() {
    if (!this.app.bluetoothManager) {
      throw new Error('Bluetooth not available');
    }

    const devices = this.app.bluetoothManager.getPairedDevices();

    return {
      success: true,
      data: {
        devices: devices
      }
    };
  }

  async bleStatus() {
    if (!this.app.bluetoothManager) {
      return {
        enabled: false,
        available: false
      };
    }

    return this.app.bluetoothManager.getStatus();
  }

  async blePowerOn() {
    if (!this.app.bluetoothManager) {
      throw new Error('Bluetooth not available');
    }

    const result = await this.app.bluetoothManager.powerOn();

    return {
      success: true,
      data: result
    };
  }

  async blePowerOff() {
    if (!this.app.bluetoothManager) {
      throw new Error('Bluetooth not available');
    }

    const result = await this.app.bluetoothManager.powerOff();

    return {
      success: true,
      data: result
    };
  }

  async networkScan(data) {
    if (!this.app.networkManager) {
      throw new Error('Network manager not available');
    }

    const timeout = data.timeout || 5;
    const fullScan = data.fullScan !== undefined ? data.fullScan : true;

    const devices = await this.app.networkManager.startScan(timeout, fullScan);

    return {
      success: true,
      data: {
        devices: devices
      }
    };
  }

  async networkConnectedList() {
    if (!this.app.networkManager) {
      throw new Error('Network manager not available');
    }

    const devices = this.app.networkManager.getConnectedDevices();

    return {
      success: true,
      data: {
        devices: devices
      }
    };
  }

  async networkConnect(data) {
    if (!this.app.networkManager) {
      throw new Error('Network manager not available');
    }

    if (!data.ip && !data.address) {
      throw new Error('Device IP address is required');
    }

    const ip = data.ip || data.address;
    const port = data.port || '5004';

    const result = await this.app.networkManager.connect(ip, port);

    return {
      success: true,
      data: result
    };
  }

  async networkDisconnect(data) {
    if (!this.app.networkManager) {
      throw new Error('Network manager not available');
    }

    if (!data.ip && !data.address) {
      throw new Error('Device IP address is required');
    }

    const ip = data.ip || data.address;

    const result = await this.app.networkManager.disconnect(ip);

    return {
      success: true,
      data: result
    };
  }

  // ==================== SERIAL MIDI HANDLERS ====================

  async serialScan() {
    if (!this.app.serialMidiManager) {
      return { success: true, available: false, ports: [], message: 'Serial MIDI not available. Install: npm install serialport' };
    }

    const ports = await this.app.serialMidiManager.scanPorts();
    return { success: true, available: true, ports };
  }

  async serialList() {
    if (!this.app.serialMidiManager) {
      return { success: true, ports: [] };
    }

    return { success: true, ports: this.app.serialMidiManager.getConnectedPorts() };
  }

  async serialOpen(data) {
    if (!this.app.serialMidiManager) {
      throw new Error('Serial MIDI not available');
    }
    if (!data.path) {
      throw new Error('path is required');
    }

    const result = await this.app.serialMidiManager.openPort(
      data.path,
      data.name || null,
      data.direction || 'both'
    );

    return {
      success: true,
      port: {
        path: result.path,
        name: result.name,
        direction: result.direction
      }
    };
  }

  async serialClose(data) {
    if (!this.app.serialMidiManager) {
      throw new Error('Serial MIDI not available');
    }
    if (!data.path) {
      throw new Error('path is required');
    }

    await this.app.serialMidiManager.closePort(data.path);
    return { success: true };
  }

  async serialStatus() {
    if (!this.app.serialMidiManager) {
      return { enabled: false, available: false, scanning: false, openPorts: 0, ports: [] };
    }

    return this.app.serialMidiManager.getStatus();
  }

  async serialSetEnabled(data) {
    if (data.enabled === undefined) {
      throw new Error('enabled is required');
    }

    if (!this.app.serialMidiManager) {
      throw new Error('Serial MIDI manager not initialized');
    }

    const result = await this.app.serialMidiManager.setEnabled(data.enabled);

    // Persist to config.json so the setting survives restarts
    this.app.config.set('serial.enabled', data.enabled);
    this.app.config.save();

    return { success: true, ...result };
  }

  // ==================== VIRTUAL DEVICE HANDLERS ====================

  async virtualCreate(data) {
    const deviceId = this.app.deviceManager.createVirtualDevice(data.name);
    return { deviceId: deviceId };
  }

  async virtualDelete(data) {
    this.app.deviceManager.deleteVirtualDevice(data.deviceId);
    return { success: true };
  }

  async virtualList() {
    const devices = this.app.deviceManager.getDeviceList()
      .filter(d => d.type === 'virtual');
    return { devices: devices };
  }

  // ==================== ROUTING HANDLERS ====================

  async routeCreate(data) {
    const routeId = this.app.midiRouter.addRoute(data);
    return { routeId: routeId };
  }

  async routeDelete(data) {
    this.app.midiRouter.deleteRoute(data.routeId);
    return { success: true };
  }

  async routeList() {
    return { routes: this.app.midiRouter.getRouteList() };
  }

  async routeEnable(data) {
    this.app.midiRouter.enableRoute(data.routeId, data.enabled);
    return { success: true };
  }

  async routeInfo(data) {
    const route = this.app.midiRouter.getRoute(data.routeId);
    if (!route) {
      throw new Error(`Route not found: ${data.routeId}`);
    }
    return { route: route };
  }

  async filterSet(data) {
    this.app.midiRouter.setFilter(data.routeId, data.filter);
    return { success: true };
  }

  async filterClear(data) {
    this.app.midiRouter.setFilter(data.routeId, {});
    return { success: true };
  }

  async channelMap(data) {
    this.app.midiRouter.setChannelMap(data.routeId, data.mapping);
    return { success: true };
  }

  async monitorStart(data) {
    this.app.midiRouter.startMonitor(data.deviceId);
    return { success: true };
  }

  async monitorStop(data) {
    this.app.midiRouter.stopMonitor(data.deviceId);
    return { success: true };
  }

  async routeTest(data) {
    // Send test MIDI message through route
    return { success: true };
  }

  async routeDuplicate(data) {
    const route = this.app.midiRouter.getRoute(data.routeId);
    if (!route) {
      throw new Error(`Route not found: ${data.routeId}`);
    }
    const newRouteId = this.app.midiRouter.addRoute({
      source: route.source,
      destination: route.destination,
      channelMap: route.channelMap,
      filter: route.filter,
      enabled: false
    });
    return { routeId: newRouteId };
  }

  async routeExport(data) {
    const route = this.app.midiRouter.getRoute(data.routeId);
    if (!route) {
      throw new Error(`Route not found: ${data.routeId}`);
    }
    return { route: route };
  }

  async routeImport(data) {
    const routeId = this.app.midiRouter.addRoute(data.route);
    return { routeId: routeId };
  }

  async routeClearAll() {
    const routes = this.app.midiRouter.getRouteList();
    routes.forEach(route => this.app.midiRouter.deleteRoute(route.id));
    return { success: true, deleted: routes.length };
  }

  // ==================== FILE HANDLERS ====================

  async fileUpload(data) {
    const result = await this.app.fileManager.handleUpload(data.filename, data.data);
    return result;
  }

  async fileList(data) {
    const files = this.app.fileManager.listFiles(data.folder || '/');
    return { files: files };
  }

  async fileMetadata(data) {
    const metadata = await this.app.fileManager.getFileMetadata(data.fileId);
    return { success: true, metadata: metadata };
  }

  async fileLoad(data) {
    const result = await this.app.fileManager.loadFile(data.fileId);
    return result;
  }

  async fileRead(data) {
    // Read MIDI file content for editing
    const result = await this.app.fileManager.loadFile(data.fileId);
    return {
      success: true,
      fileId: data.fileId,
      midiData: result
    };
  }

  async fileWrite(data) {
    // Write MIDI file content from editor
    await this.app.fileManager.saveFile(data.fileId, data.midiData);
    // Invalidate auto-assignment cache for this file
    if (this.app.autoAssigner) {
      this.app.autoAssigner.invalidateCache(data.fileId);
    }
    return { success: true };
  }

  async fileDelete(data) {
    await this.app.fileManager.deleteFile(data.fileId);
    // Invalidate auto-assignment cache for this file
    if (this.app.autoAssigner) {
      this.app.autoAssigner.invalidateCache(data.fileId);
    }
    return { success: true };
  }

  async fileSave(data) {
    await this.app.fileManager.saveFile(data.fileId, data.midi);
    return { success: true };
  }

  async fileSaveAs(data) {
    const result = await this.app.fileManager.saveFileAs(data.fileId, data.newFilename, data.midiData);
    return result;
  }

  async fileRename(data) {
    await this.app.fileManager.renameFile(data.fileId, data.newFilename);
    return { success: true };
  }

  async fileMove(data) {
    await this.app.fileManager.moveFile(data.fileId, data.folder);
    return { success: true };
  }

  async fileDuplicate(data) {
    const result = await this.app.fileManager.duplicateFile(data.fileId);
    return result;
  }

  async fileExport(data) {
    const result = await this.app.fileManager.exportFile(data.fileId);
    return result;
  }

  async fileSearch(data) {
    const files = this.app.database.searchFiles(data.query);
    return { files: files };
  }

  async fileFilter(data) {
    // Advanced filtering with multiple criteria
    const filters = {
      // Simple filters
      filename: data.filename,
      folder: data.folder,
      includeSubfolders: data.includeSubfolders,
      durationMin: data.durationMin,
      durationMax: data.durationMax,
      tempoMin: data.tempoMin,
      tempoMax: data.tempoMax,
      tracksMin: data.tracksMin,
      tracksMax: data.tracksMax,
      uploadedAfter: data.uploadedAfter,
      uploadedBefore: data.uploadedBefore,

      // Advanced filters
      instrumentTypes: data.instrumentTypes,
      instrumentMode: data.instrumentMode || 'ANY',
      channelCountMin: data.channelCountMin,
      channelCountMax: data.channelCountMax,
      hasRouting: data.hasRouting,
      isOriginal: data.isOriginal,
      minCompatibilityScore: data.minCompatibilityScore,

      // GM instrument filters
      gmInstruments: data.gmInstruments,
      gmCategories: data.gmCategories,
      gmPrograms: data.gmPrograms,
      gmMode: data.gmMode || 'ANY',

      // Routing status filter
      routingStatus: data.routingStatus,
      validatedThreshold: data.validatedThreshold,

      // Playable on instruments filter
      playableOnInstruments: data.playableOnInstruments,
      playableMode: data.playableOnInstruments?.length > 0 ? (data.playableMode || 'routed') : undefined,

      // Quick filters
      hasDrums: data.hasDrums,
      hasMelody: data.hasMelody,
      hasBass: data.hasBass,

      // Sorting and pagination
      sortBy: data.sortBy || 'uploaded_at',
      sortOrder: data.sortOrder || 'DESC',
      limit: (Number.isInteger(data.limit) && data.limit > 0) ? data.limit : undefined,
      offset: (Number.isInteger(data.offset) && data.offset >= 0) ? data.offset : undefined
    };

    // Remove empty/null/undefined values (FilterManager sends null as default for inactive filters)
    Object.keys(filters).forEach(key => {
      const val = filters[key];
      if (val === undefined || val === null || val === '') {
        delete filters[key];
      } else if (Array.isArray(val) && val.length === 0) {
        delete filters[key];
      }
    });

    const files = this.app.database.filterFiles(filters);

    // Build filter summary for response
    const appliedFilters = [];
    if (data.filename) appliedFilters.push(`filename: "${data.filename}"`);
    if (data.folder) appliedFilters.push(`folder: "${data.folder}"`);
    if (data.durationMin !== undefined || data.durationMax !== undefined) {
      appliedFilters.push(`duration: ${data.durationMin || 0}-${data.durationMax || '∞'}s`);
    }
    if (data.tempoMin !== undefined || data.tempoMax !== undefined) {
      appliedFilters.push(`tempo: ${data.tempoMin || 0}-${data.tempoMax || '∞'} BPM`);
    }
    if (data.instrumentTypes && data.instrumentTypes.length > 0) {
      appliedFilters.push(`instruments: ${data.instrumentTypes.join(', ')} (${data.instrumentMode || 'ANY'})`);
    }
    if (data.gmInstruments && data.gmInstruments.length > 0) {
      appliedFilters.push(`GM instruments: ${data.gmInstruments.join(', ')} (${data.gmMode || 'ANY'})`);
    }
    if (data.gmCategories && data.gmCategories.length > 0) {
      appliedFilters.push(`GM categories: ${data.gmCategories.join(', ')} (${data.gmMode || 'ANY'})`);
    }
    if (data.routingStatus) {
      appliedFilters.push(`routing status: ${data.routingStatus}`);
    }
    if (data.playableOnInstruments && data.playableOnInstruments.length > 0) {
      appliedFilters.push(`playable on: ${data.playableOnInstruments.join(', ')} (${data.playableMode || 'routed'})`);
    }

    return {
      success: true,
      files: files,
      total: files.length,
      filters: appliedFilters.length > 0 ? appliedFilters.join('; ') : 'none'
    };
  }

  async fileChannels(data) {
    if (!data.fileId) {
      throw new Error('fileId is required');
    }

    const channels = this.app.database.getFileChannels(data.fileId);
    return {
      success: true,
      fileId: data.fileId,
      channels: channels,
      total: channels.length
    };
  }

  async fileReanalyzeAll() {
    const result = await this.app.fileManager.reanalyzeAllFiles();
    return {
      success: true,
      ...result
    };
  }

  async midiInstrumentsList() {
    const instruments = this.app.database.getDistinctInstruments();
    return {
      success: true,
      instruments: instruments,
      total: instruments.length
    };
  }

  async midiCategoriesList() {
    const categories = this.app.database.getDistinctCategories();
    return {
      success: true,
      categories: categories,
      total: categories.length
    };
  }

  // ==================== PLAYBACK HANDLERS ====================

  async playbackStart(data) {
    // Load file first
    if (!data.fileId) {
      throw new Error('fileId is required');
    }

    this.app.logger.info(`Loading file ${data.fileId} for playback...`);
    const fileInfo = await this.app.midiPlayer.loadFile(data.fileId);

    // Auto-load saved channel routings from database (if any exist for this file)
    let loadedRoutings = 0;
    try {
      const savedRoutings = this.app.database.getRoutingsByFile(data.fileId);
      if (savedRoutings.length > 0) {
        this.app.midiPlayer.clearChannelRouting();
        for (const routing of savedRoutings) {
          if (routing.channel !== null && routing.channel !== undefined && routing.device_id) {
            // Use persisted target_channel (instrument's actual MIDI channel) from routing record
            const targetChannel = routing.target_channel !== undefined ? routing.target_channel : routing.channel;
            this.app.midiPlayer.setChannelRouting(routing.channel, routing.device_id, targetChannel);
            loadedRoutings++;
          }
        }
        this.app.logger.info(`Auto-loaded ${loadedRoutings} channel routings from database for file ${data.fileId}`);
      }
    } catch (routingError) {
      this.app.logger.warn(`Failed to auto-load routings: ${routingError.message}`);
    }

    // Determine output device
    let outputDevice = data.outputDevice;

    // If no output specified, use first available output
    if (!outputDevice) {
      const devices = this.app.deviceManager.getDeviceList();
      const outputDevices = devices.filter(d => d.output && d.enabled);

      if (outputDevices.length === 0) {
        throw new Error('No output devices available');
      }

      outputDevice = outputDevices[0].id;
      this.app.logger.info(`No output specified, using: ${outputDevice}`);
    }

    // Start playback
    this.app.midiPlayer.start(outputDevice);

    return {
      success: true,
      fileInfo: fileInfo,
      outputDevice: outputDevice,
      loadedRoutings: loadedRoutings
    };
  }

  async playbackStop() {
    this.app.midiPlayer.stop();
    return { success: true };
  }

  async playbackPause() {
    this.app.midiPlayer.pause();
    return { success: true };
  }

  async playbackResume() {
    this.app.midiPlayer.resume();
    return { success: true };
  }

  async playbackSeek(data) {
    this.app.midiPlayer.seek(data.position);
    return { success: true };
  }

  async playbackStatus() {
    return this.app.midiPlayer.getStatus();
  }

  async playbackSetLoop(data) {
    this.app.midiPlayer.setLoop(data.enabled);
    return { success: true };
  }

  async playbackSetTempo(data) {
    // Future implementation
    return { success: true };
  }

  async playbackTranspose(data) {
    // Future implementation
    return { success: true };
  }

  async playbackSetVolume(data) {
    // Future implementation
    return { success: true };
  }

  async playbackGetChannels() {
    return {
      channels: this.app.midiPlayer.getChannelRouting()
    };
  }

  async playbackSetChannelRouting(data) {
    if (data.channel === undefined || data.channel === null) {
      throw new Error('channel is required');
    }
    if (!data.deviceId) {
      throw new Error('deviceId is required');
    }

    const channel = parseInt(data.channel);
    if (isNaN(channel) || channel < 0 || channel > 15) {
      throw new Error('channel must be between 0 and 15');
    }

    // targetChannel allows remapping source channel to instrument's actual MIDI channel
    const targetChannel = data.targetChannel !== undefined ? parseInt(data.targetChannel) : channel;
    if (isNaN(targetChannel) || targetChannel < 0 || targetChannel > 15) {
      throw new Error('targetChannel must be between 0 and 15');
    }

    this.app.midiPlayer.setChannelRouting(channel, data.deviceId, targetChannel);

    return {
      success: true,
      channel: data.channel,
      channelDisplay: data.channel + 1,
      deviceId: data.deviceId,
      targetChannel: targetChannel
    };
  }

  async playbackClearChannelRouting() {
    this.app.midiPlayer.clearChannelRouting();
    return { success: true };
  }

  async playbackMuteChannel(data) {
    if (data.channel === undefined) {
      throw new Error('Missing channel parameter');
    }

    const channel = parseInt(data.channel);
    if (isNaN(channel) || channel < 0 || channel > 15) {
      throw new Error('Invalid channel (must be 0-15)');
    }

    if (data.muted) {
      this.app.midiPlayer.muteChannel(channel);
    } else {
      this.app.midiPlayer.unmuteChannel(channel);
    }

    return {
      success: true,
      channel: channel,
      channelDisplay: channel + 1,
      muted: data.muted
    };
  }

  // ==================== LATENCY HANDLERS ====================

  async latencyMeasure(data) {
    const result = await this.app.latencyCompensator.measureLatency(
      data.deviceId,
      data.iterations || 5
    );
    return result;
  }

  async latencySet(data) {
    this.app.latencyCompensator.setLatency(data.deviceId, data.latency);
    return { success: true };
  }

  async latencyGet(data) {
    const profile = this.app.latencyCompensator.getProfile(data.deviceId);
    return { profile: profile };
  }

  async latencyList() {
    const profiles = this.app.latencyCompensator.getAllProfiles();
    return { profiles: profiles };
  }

  async latencyDelete(data) {
    this.app.latencyCompensator.deleteProfile(data.deviceId);
    return { success: true };
  }

  async latencyAutoCalibrate(data) {
    const results = await this.app.latencyCompensator.autoCalibrate(data.deviceIds);
    return { results: results };
  }

  async latencyRecommendations() {
    const recommendations = this.app.latencyCompensator.getRecommendedCalibrations();
    return { recommendations: recommendations };
  }

  async latencyExport() {
    const profiles = this.app.latencyCompensator.getAllProfiles();
    return { profiles: profiles };
  }

  async calibrateDelay(data) {
    const { deviceId, channel, threshold, alsaDevice, measurements } = data;

    // Configure calibrator if options provided
    if (threshold !== undefined) {
      this.app.delayCalibrator.setThreshold(threshold);
    }
    if (alsaDevice !== undefined) {
      this.app.delayCalibrator.setAlsaDevice(alsaDevice);
    }

    // Run calibration
    const result = await this.app.delayCalibrator.calibrateInstrument(
      deviceId,
      channel,
      { measurements }
    );

    return result;
  }

  async calibrateListAlsaDevices() {
    const devices = await this.app.delayCalibrator.listAlsaDevices();
    return { devices: devices };
  }

  // ==================== MIDI MESSAGE HANDLERS ====================

  async midiSend(data) {
    const validation = JsonValidator.validateMidiMessage(data);
    if (!validation.valid) {
      throw new Error(`Invalid MIDI message: ${validation.errors.join(', ')}`);
    }

    const success = this.app.deviceManager.sendMessage(
      data.deviceId,
      data.type,
      data
    );
    return { success: success };
  }

  async midiSendNote(data) {
    this.app.deviceManager.sendMessage(data.deviceId, 'noteon', {
      channel: data.channel,
      note: data.note,
      velocity: data.velocity
    });

    // Send noteOff after duration (default 500ms)
    const duration = data.duration || 500;
    setTimeout(() => {
      this.app.deviceManager.sendMessage(data.deviceId, 'noteoff', {
        channel: data.channel,
        note: data.note,
        velocity: 0
      });
    }, duration);

    return { success: true };
  }

  async midiSendCc(data) {
    this.app.deviceManager.sendMessage(data.deviceId, 'cc', {
      channel: data.channel,
      controller: data.controller,
      value: data.value
    });
    return { success: true };
  }

  async midiSendProgram(data) {
    this.app.deviceManager.sendMessage(data.deviceId, 'program', {
      channel: data.channel,
      number: data.program
    });
    return { success: true };
  }

  async midiSendPitchbend(data) {
    this.app.deviceManager.sendMessage(data.deviceId, 'pitchbend', {
      channel: data.channel,
      value: data.value
    });
    return { success: true };
  }

  async midiPanic(data) {
    // Send all notes off + reset controllers on all channels
    for (let channel = 0; channel < 16; channel++) {
      this.app.deviceManager.sendMessage(data.deviceId, 'cc', {
        channel: channel,
        controller: MIDI_CC.ALL_SOUND_OFF, // All Sound Off
        value: 0
      });
      this.app.deviceManager.sendMessage(data.deviceId, 'cc', {
        channel: channel,
        controller: MIDI_CC.ALL_NOTES_OFF, // All Notes Off
        value: 0
      });
    }
    return { success: true };
  }

  async midiAllNotesOff(data) {
    for (let channel = 0; channel < 16; channel++) {
      this.app.deviceManager.sendMessage(data.deviceId, 'cc', {
        channel: channel,
        controller: MIDI_CC.ALL_NOTES_OFF,
        value: 0
      });
    }
    return { success: true };
  }

  async midiReset(data) {
    // Send System Reset
    return { success: true };
  }

  // ==================== SYSTEM HANDLERS ====================

  async systemStatus() {
    return {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      version: APP_VERSION,
      devices: this.app.deviceManager.getDeviceList().length,
      routes: this.app.midiRouter.getRouteList().length,
      files: this.app.database.getFiles('/').length
    };
  }

  async systemInfo() {
    return {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      cpus: os.cpus().length,
      totalMemory: os.totalmem(),
      freeMemory: os.freemem()
    };
  }

  async systemRestart() {
    this.app.logger.info('System restart requested');
    setTimeout(() => process.exit(0), 1000);
    return { success: true };
  }

  async systemShutdown() {
    this.app.logger.info('System shutdown requested');
    setTimeout(() => process.exit(0), 1000);
    return { success: true };
  }

  async systemUpdate() {
    this.app.logger.info('System update requested');
    const { exec } = await import('child_process');
    const { resolve } = await import('path');
    const scriptPath = resolve('./scripts/update.sh');

    return new Promise((resolve_p, reject) => {
      exec(`bash "${scriptPath}" --non-interactive`, {
        cwd: resolve('.'),
        timeout: 300000,
        env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' }
      }, (error, stdout, stderr) => {
        if (error) {
          this.app.logger.error('System update failed:', error.message);
          reject(new Error(`Update failed: ${error.message}`));
          return;
        }
        this.app.logger.info('System update completed successfully');
        resolve_p({ success: true, output: stdout });
      });
    });
  }

  async systemBackup(data) {
    const { resolve, basename } = await import('path');
    const backupsDir = resolve('./backups');

    // Sanitize: only allow filename, force it into backups directory
    let filename;
    if (data.path) {
      filename = basename(data.path);
      // Reject suspicious filenames
      if (filename.includes('..') || filename.startsWith('.')) {
        throw new Error('Invalid backup filename');
      }
    } else {
      filename = `backup_${Date.now()}.db`;
    }

    const backupPath = resolve(backupsDir, filename);
    this.app.database.backup(backupPath);
    return { path: backupPath };
  }

  async systemRestore(data) {
    // Future implementation
    return { success: true };
  }

  async systemLogs(data) {
    // Future implementation - return recent logs
    return { logs: [] };
  }

  async systemClearLogs() {
    // Future implementation
    return { success: true };
  }

  // ==================== SESSION HANDLERS ====================

  async sessionSave(data) {
    const sessionData = {
      devices: this.app.deviceManager.getDeviceList(),
      routes: this.app.midiRouter.getRouteList(),
      player: this.app.midiPlayer.getStatus()
    };

    const sessionId = this.app.database.insertSession({
      name: data.name,
      description: data.description,
      data: JSON.stringify(sessionData)
    });

    return { sessionId: sessionId };
  }

  async sessionLoad(data) {
    const session = this.app.database.getSession(data.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${data.sessionId}`);
    }

    const sessionData = JSON.parse(session.data);
    // Apply session data
    // Future implementation

    return { success: true, session: session };
  }

  async sessionList() {
    const sessions = this.app.database.getSessions();
    return { sessions: sessions };
  }

  async sessionDelete(data) {
    this.app.database.deleteSession(data.sessionId);
    return { success: true };
  }

  async sessionExport(data) {
    const session = this.app.database.getSession(data.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${data.sessionId}`);
    }
    return { session: session };
  }

  async sessionImport(data) {
    const sessionId = this.app.database.insertSession({
      name: data.name,
      description: data.description,
      data: data.data
    });
    return { sessionId: sessionId };
  }

  // ==================== PRESET HANDLERS ====================

  async presetSave(data) {
    const presetId = this.app.database.insertPreset({
      name: data.name,
      description: data.description,
      type: data.type || 'routing',
      data: JSON.stringify(data.data)
    });
    return { presetId: presetId };
  }

  async presetLoad(data) {
    const preset = this.app.database.getPreset(data.presetId);
    if (!preset) {
      throw new Error(`Preset not found: ${data.presetId}`);
    }
    return { preset: preset };
  }

  async presetList(data) {
    const presets = this.app.database.getPresets(data.type);
    return { presets: presets };
  }

  async presetDelete(data) {
    this.app.database.deletePreset(data.presetId);
    return { success: true };
  }

  async presetRename(data) {
    this.app.database.updatePreset(data.presetId, {
      name: data.newName
    });
    return { success: true };
  }

  async presetExport(data) {
    const preset = this.app.database.getPreset(data.presetId);
    if (!preset) {
      throw new Error(`Preset not found: ${data.presetId}`);
    }
    return { preset: preset };
  }

  // ==================== PLAYLIST HANDLERS ====================

  async playlistCreate(data) {
    const playlistId = this.app.database.insertPlaylist({
      name: data.name,
      description: data.description
    });
    return { playlistId: playlistId };
  }

  async playlistDelete(data) {
    this.app.database.deletePlaylist(data.playlistId);
    return { success: true };
  }

  async playlistList() {
    const playlists = this.app.database.getPlaylists();
    return { playlists: playlists };
  }

  async playlistAddFile(data) {
    // Future implementation with playlist_items table
    return { success: true };
  }

  // ==================== AUTO-ASSIGNMENT HANDLERS ====================

  /**
   * Analyze a specific MIDI channel
   * @param {Object} data - { fileId, channel }
   * @returns {Object} - Channel analysis
   */
  async analyzeChannel(data) {
    if (!data.fileId) {
      throw new Error('fileId is required');
    }
    if (data.channel === undefined) {
      throw new Error('channel is required');
    }

    // Get MIDI file from database
    const file = this.app.database.getFile(data.fileId);
    if (!file) {
      throw new Error(`File not found: ${data.fileId}`);
    }

    // Parse MIDI data
    let midiData;
    try {
      const buffer = Buffer.from(file.data, 'base64');
      midiData = this.midiConverter.midiToJson(buffer);
    } catch (error) {
      throw new Error(`Failed to parse MIDI file: ${error.message}`);
    }

    // Use singleton auto-assigner (with cache support)
    const analysis = this.app.autoAssigner.analyzeChannel(midiData, data.channel, data.fileId);

    return {
      success: true,
      channel: data.channel,
      analysis
    };
  }

  /**
   * Generate auto-assignment suggestions for all channels
   * @param {Object} data - { fileId, topN, minScore }
   * @returns {Object} - Suggestions for all channels
   */
  async generateAssignmentSuggestions(data) {
    if (!data.fileId) {
      throw new Error('fileId is required');
    }

    const options = {
      topN: data.topN || 5,
      minScore: data.minScore || 30
    };

    // Get MIDI file from database
    const file = this.app.database.getFile(data.fileId);
    if (!file) {
      throw new Error(`File not found: ${data.fileId}`);
    }

    // Parse MIDI data
    let midiData;
    try {
      const buffer = Buffer.from(file.data, 'base64');
      midiData = this.midiConverter.midiToJson(buffer);
    } catch (error) {
      throw new Error(`Failed to parse MIDI file: ${error.message}`);
    }

    // Generate suggestions using singleton auto-assigner
    const result = await this.app.autoAssigner.generateSuggestions(midiData, options);

    if (!result.success) {
      return {
        success: false,
        error: result.error,
        suggestions: {},
        autoSelection: {}
      };
    }

    return {
      success: true,
      suggestions: result.suggestions,
      autoSelection: result.autoSelection,
      channelAnalyses: result.channelAnalyses,
      confidenceScore: result.confidenceScore,
      stats: result.stats
    };
  }

  /**
   * Apply auto-assignments (create adapted file and routings)
   * @param {Object} data - { originalFileId, assignments, createAdaptedFile }
   * @returns {Object} - Result with adapted file ID and routings
   */
  async applyAssignments(data) {
    if (!data.originalFileId) {
      throw new Error('originalFileId is required');
    }
    if (!data.assignments) {
      throw new Error('assignments is required');
    }

    const createAdaptedFile = data.createAdaptedFile !== false; // Default true

    // Get original MIDI file
    const originalFile = this.app.database.getFile(data.originalFileId);
    if (!originalFile) {
      throw new Error(`File not found: ${data.originalFileId}`);
    }

    // Parse original MIDI data
    let midiData;
    try {
      const buffer = Buffer.from(originalFile.data, 'base64');
      midiData = this.midiConverter.midiToJson(buffer);
    } catch (error) {
      throw new Error(`Failed to parse MIDI file: ${error.message}`);
    }

    let adaptedFileId = null;
    let stats = null;

    // Create adapted file if requested
    if (createAdaptedFile) {
      // Build transpositions object from assignments
      const transpositions = {};
      for (const [channel, assignment] of Object.entries(data.assignments)) {
        const channelNum = parseInt(channel);
        transpositions[channelNum] = {
          semitones: assignment.transposition?.semitones || 0,
          noteRemapping: assignment.noteRemapping || null
        };
      }

      // Apply transpositions
      const transposer = new MidiTransposer(this.app.logger);
      const result = transposer.transposeChannels(midiData, transpositions);
      const adaptedMidiData = result.midiData;
      stats = result.stats;

      // Convert back to MIDI binary
      let adaptedBuffer;
      try {
        adaptedBuffer = this.midiConverter.jsonToMidi(adaptedMidiData);
      } catch (error) {
        throw new Error(`Failed to convert adapted MIDI: ${error.message}`);
      }

      // Generate adaptation metadata
      const metadata = transposer.generateAdaptationMetadata(data.assignments, stats);

      // Save adapted file to database
      const adaptedFilename = originalFile.filename.replace(/\.mid$/i, '_adapted.mid');
      const adaptedFile = {
        filename: adaptedFilename,
        data: adaptedBuffer.toString('base64'),
        size: adaptedBuffer.length,
        tracks: originalFile.tracks,
        duration: originalFile.duration,
        tempo: originalFile.tempo,
        ppq: originalFile.ppq,
        uploaded_at: new Date().toISOString(),
        folder: originalFile.folder,
        is_original: false,
        parent_file_id: data.originalFileId,
        adaptation_metadata: JSON.stringify(metadata)
      };

      adaptedFileId = this.app.database.insertFile(adaptedFile);
      this.app.logger.info(`Created adapted file: ${adaptedFileId} (${adaptedFilename})`);
    }

    // Create routings in database
    const routings = [];
    const targetFileId = adaptedFileId || data.originalFileId;

    for (const [channel, assignment] of Object.entries(data.assignments)) {
      const channelNum = parseInt(channel);

      // Resolve targetChannel (instrument's actual MIDI channel on device)
      let instrumentTargetChannel = assignment.instrumentChannel !== undefined
        ? Math.max(0, Math.min(15, parseInt(assignment.instrumentChannel) || 0))
        : channelNum;

      const routing = {
        midi_file_id: targetFileId,
        channel: channelNum,
        target_channel: instrumentTargetChannel, // Persist instrument's MIDI channel for reload
        device_id: assignment.deviceId,
        instrument_name: assignment.instrumentName,
        compatibility_score: assignment.score,
        transposition_applied: assignment.transposition?.semitones || 0,
        auto_assigned: true,
        assignment_reason: assignment.info
          ? (Array.isArray(assignment.info) ? assignment.info.join('; ') : String(assignment.info))
          : 'Auto-assigned',
        note_remapping: assignment.noteRemapping ? JSON.stringify(assignment.noteRemapping) : null,
        enabled: true,
        created_at: Date.now()
      };

      // Persist routing to database
      try {
        this.app.database.insertRouting(routing);
      } catch (dbError) {
        this.app.logger.warn(`Failed to persist routing for channel ${channelNum}: ${dbError.message}`);
      }
      routings.push(routing);

      // Also apply to MidiPlayer if currently loaded
      if (this.app.midiPlayer && this.app.midiPlayer.loadedFileId === targetFileId) {
        this.app.midiPlayer.setChannelRouting(channelNum, assignment.deviceId, instrumentTargetChannel);
      }

      this.app.logger.info(
        `Assigned channel ${channelNum} to ${assignment.instrumentName} (score: ${assignment.score})`
      );
    }

    return {
      success: true,
      adaptedFileId,
      filename: adaptedFileId ? originalFile.filename.replace(/\.mid$/i, '_adapted.mid') : null,
      stats,
      routings
    };
  }

  /**
   * Valide les capacités des instruments
   * @returns {Object}
   */
  async validateInstrumentCapabilities() {
    const validator = new InstrumentCapabilitiesValidator();

    // Récupérer tous les instruments
    const instruments = this.app.database.getInstrumentsWithCapabilities();

    // Valider
    const validation = validator.validateInstruments(instruments);

    return {
      success: true,
      allValid: validation.allValid,
      validCount: validation.validCount,
      completeCount: validation.completeCount,
      totalCount: validation.totalCount,
      incompleteInstruments: validation.incomplete
    };
  }

  /**
   * Obtient les valeurs par défaut suggérées pour un instrument
   * @param {Object} data - { instrumentId, type }
   * @returns {Object}
   */
  async getInstrumentDefaults(data) {
    const validator = new InstrumentCapabilitiesValidator();

    // Récupérer l'instrument (table instruments)
    const instrument = this.app.database.getInstrument(data.instrumentId);

    if (!instrument) {
      throw new Error(`Instrument not found: ${data.instrumentId}`);
    }

    // Obtenir les suggestions basées sur le type
    const defaults = validator.getSuggestedDefaults(instrument);

    // Enrichir avec les capabilities actuelles depuis instruments_latency
    let currentCapabilities = null;
    if (instrument.device_id) {
      try {
        currentCapabilities = this.app.database.getInstrumentCapabilities(
          instrument.device_id, instrument.channel || 0
        );
      } catch (e) {
        // Capabilities may not exist yet
      }
    }

    return {
      success: true,
      defaults,
      currentCapabilities
    };
  }

  /**
   * Met à jour les capacités des instruments
   * @param {Object} data - { updates: { instrumentId: { field: value, ... }, ... } }
   * @returns {Object}
   */
  async updateInstrumentCapabilities(data) {
    if (!data.updates) {
      throw new Error('updates is required');
    }

    const updated = [];
    const failed = [];

    for (const [instrumentId, fields] of Object.entries(data.updates)) {
      try {
        // Convertir instrumentId en nombre
        const id = parseInt(instrumentId);

        // Récupérer l'instrument
        const instrument = this.app.database.getInstrument(id);

        if (!instrument) {
          failed.push({
            instrumentId: id,
            error: 'Instrument not found'
          });
          continue;
        }

        // Séparer les champs selon leur type
        const basicFields = {};
        const capabilityFields = {};

        const capabilityFieldNames = ['note_range_min', 'note_range_max', 'polyphony',
                                      'note_selection_mode', 'supported_ccs', 'selected_notes'];

        for (const [field, value] of Object.entries(fields)) {
          if (capabilityFieldNames.includes(field)) {
            capabilityFields[field] = value;
          } else {
            basicFields[field] = value;
          }
        }

        // Mettre à jour les champs basiques (type, gm_program, etc.)
        if (Object.keys(basicFields).length > 0) {
          this.app.database.updateInstrument(id, basicFields);
        }

        // Mettre à jour les capacités
        if (Object.keys(capabilityFields).length > 0) {
          // Use channel from fields, instrument, or default to 0
          const channel = fields.channel !== undefined ? fields.channel : (instrument.channel || 0);
          this.app.database.updateInstrumentCapabilities(instrument.device_id, channel, capabilityFields);
        }

        updated.push(id);

        this.app.logger.info(`Updated capabilities for instrument ${id}: ${Object.keys(fields).join(', ')}`);

      } catch (error) {
        failed.push({
          instrumentId: parseInt(instrumentId),
          error: error.message
        });
      }
    }

    return {
      success: true,
      updated: updated.length,
      failed: failed.length,
      failedDetails: failed
    };
  }

  /**
   * Get saved routings for a MIDI file
   * @param {Object} data - { fileId }
   * @returns {Object} - { success, routings }
   */
  async getFileRoutings(data) {
    if (!data.fileId) {
      throw new Error('fileId is required');
    }

    const routings = this.app.database.getRoutingsByFile(data.fileId);

    return {
      success: true,
      routings,
      count: routings.length
    };
  }
}

export default CommandHandler;