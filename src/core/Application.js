// src/core/Application.js
import Config from '../config/Config.js';
import Logger from './Logger.js';
import EventBus from './EventBus.js';
import Database from '../storage/Database.js';
import DeviceManager from '../midi/DeviceManager.js';
import MidiRouter from '../midi/MidiRouter.js';
import MidiPlayer from '../midi/MidiPlayer.js';
import LatencyCompensator from '../midi/LatencyCompensator.js';
import DelayCalibrator from '../audio/DelayCalibrator.js';
import FileManager from '../storage/FileManager.js';
import BluetoothManager from '../managers/BluetoothManager.js';
import NetworkManager from '../managers/NetworkManager.js';
import WebSocketServer from '../api/WebSocketServer.js';
import HttpServer from '../api/HttpServer.js';
import CommandHandler from '../api/CommandHandler.js';
import AutoAssigner from '../midi/AutoAssigner.js';

class Application {
  constructor(configPath = null) {
    this.config = new Config(configPath);
    this.logger = new Logger(this.config.logging);
    this.eventBus = new EventBus();
    this.database = null;
    this.deviceManager = null;
    this.midiRouter = null;
    this.midiPlayer = null;
    this.latencyCompensator = null;
    this.delayCalibrator = null;
    this.fileManager = null;
    this.bluetoothManager = null;
    this.networkManager = null;
    this.serialMidiManager = null;
    this.autoAssigner = null;
    this.wsServer = null;
    this.httpServer = null;
    this.commandHandler = null;
    this.running = false;

    // Track bound event handlers for cleanup
    this._eventHandlers = [];

    this.logger.info('=== MidiMind 5.0 Starting ===');
  }

  async initialize() {
    try {
      this.logger.info('Initializing application...');

      // Initialize database
      this.database = new Database(this);
      
      // Initialize MIDI components
      this.deviceManager = new DeviceManager(this);
      this.midiRouter = new MidiRouter(this);
      this.midiPlayer = new MidiPlayer(this);
      this.latencyCompensator = new LatencyCompensator(this);
      this.delayCalibrator = new DelayCalibrator(this.deviceManager, this.logger);

      // Initialize storage
      this.fileManager = new FileManager(this);

      // Initialize Bluetooth (optional - may not be available on all systems)
      try {
        this.bluetoothManager = new BluetoothManager(this);
        this.logger.info('Bluetooth initialized');
      } catch (error) {
        this.logger.warn(`Bluetooth not available: ${error.message}`);
      }

      // Initialize Network Manager
      try {
        this.networkManager = new NetworkManager(this);
        this.logger.info('Network manager initialized');
      } catch (error) {
        this.logger.warn(`Network manager not available: ${error.message}`);
      }

      // Initialize Serial MIDI (optional - requires serialport package)
      try {
        const { default: SerialMidiManager } = await import('../managers/SerialMidiManager.js');
        this.serialMidiManager = new SerialMidiManager(this);
        this.logger.info('Serial MIDI manager initialized');
      } catch (error) {
        this.logger.warn(`Serial MIDI not available: ${error.message}`);
      }

      // Initialize auto-assigner (singleton with cache)
      this.autoAssigner = new AutoAssigner(this.database, this.logger);

      // Initialize API
      this.commandHandler = new CommandHandler(this);
      this.httpServer = new HttpServer(this);
      this.wsServer = new WebSocketServer(this, null); // Will be initialized after HTTP server starts

      // Setup event handlers
      this.setupEventHandlers();

      this.logger.info('Application initialized');
    } catch (error) {
      this.logger.error(`Initialization failed: ${error.message}`);
      throw error;
    }
  }

  setupEventHandlers() {
    // Clear any previously registered handlers (prevents leak on restart)
    this.removeEventHandlers();

    // Define handlers with references for cleanup
    const handlers = [
      ['midi_message', (data) => {
        this.logger.debug(`MIDI message: ${data.device} ${data.type}`);
      }],
      ['device_connected', (data) => {
        this.logger.info(`Device connected: ${data.deviceId}`);
        this.wsServer?.broadcast('device_connected', data);
      }],
      ['device_disconnected', (data) => {
        this.logger.info(`Device disconnected: ${data.deviceId}`);
        this.wsServer?.broadcast('device_disconnected', data);
      }],
      ['midi_routed', (data) => {
        this.logger.debug(`MIDI routed: ${data.route}`);
      }],
      ['file_uploaded', (data) => {
        this.logger.info(`File uploaded: ${data.filename}`);
      }],
      ['playback_started', () => {
        this.logger.info('Playback started');
      }],
      ['playback_stopped', () => {
        this.logger.info('Playback stopped');
      }],
      ['error', (error) => {
        this.logger.error(`Application error: ${error.message}`);
      }]
    ];

    for (const [event, handler] of handlers) {
      this.eventBus.on(event, handler);
      this._eventHandlers.push({ event, handler });
    }
  }

  removeEventHandlers() {
    if (this._eventHandlers) {
      for (const { event, handler } of this._eventHandlers) {
        this.eventBus.off(event, handler);
      }
      this._eventHandlers = [];
    }
  }

  async start() {
    try {
      this.logger.info('Starting application...');

      // Scan MIDI devices
      await this.deviceManager.scanDevices();

      // Start HTTP server first
      await this.httpServer.start();

      // Now initialize WebSocket server with HTTP server instance
      this.wsServer.httpServer = this.httpServer.server;
      this.wsServer.start();
      this.wsServer.startHeartbeat();

      this.running = true;
      this.logger.info('=== MidiMind 5.0 Running ===');
      this.logger.info(`HTTP/WebSocket server: http://localhost:${this.config.server.port}`);

      // Auto-reanalyze files missing channel data (needed for GM instrument filters)
      try {
        const missingCount = this.database.countFilesWithoutChannels();
        if (missingCount > 0) {
          this.logger.info(`Found ${missingCount} files without channel analysis data, starting auto-reanalysis...`);
          const result = await this.fileManager.reanalyzeAllFiles();
          this.logger.info(`Auto-reanalysis complete: ${result.analyzed} analyzed, ${result.failed} failed`);
        }
      } catch (error) {
        this.logger.warn(`Auto-reanalysis failed (non-critical): ${error.message}`);
      }
    } catch (error) {
      this.logger.error(`Start failed: ${error.message}`);
      throw error;
    }
  }

  async stop() {
    try {
      this.logger.info('Stopping application...');
      this.running = false;

      // Stop and destroy player
      if (this.midiPlayer) {
        this.midiPlayer.destroy();
      }

      // Close servers
      if (this.wsServer) {
        this.wsServer.close();
      }

      if (this.httpServer) {
        this.httpServer.close();
      }

      // Close MIDI devices
      if (this.deviceManager) {
        this.deviceManager.close();
      }

      // Close Bluetooth
      if (this.bluetoothManager) {
        await this.bluetoothManager.shutdown();
      }

      // Close Network
      if (this.networkManager && this.networkManager.shutdown) {
        await this.networkManager.shutdown();
      }

      // Close Serial MIDI
      if (this.serialMidiManager) {
        await this.serialMidiManager.shutdown();
      }

      // Destroy auto-assigner (cleanup intervals and cache)
      if (this.autoAssigner) {
        this.autoAssigner.destroy();
      }

      // Remove event handlers to prevent leaks on restart
      this.removeEventHandlers();

      // Close database
      if (this.database) {
        this.database.close();
      }

      this.logger.info('=== MidiMind 5.0 Stopped ===');
    } catch (error) {
      this.logger.error(`Stop failed: ${error.message}`);
      throw error;
    }
  }

  async restart() {
    await this.stop();
    await this.initialize();
    await this.start();
  }

  getStatus() {
    return {
      running: this.running,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      devices: this.deviceManager ? this.deviceManager.getDeviceList().length : 0,
      routes: this.midiRouter ? this.midiRouter.getRouteList().length : 0,
      files: this.database ? this.database.getFiles('/').length : 0,
      wsClients: this.wsServer ? this.wsServer.getStats().clients : 0
    };
  }

  // Graceful shutdown
  setupShutdownHandlers() {
    // Remove any previously registered handlers to prevent accumulation on restart
    if (this._shutdownHandlers) {
      for (const { event, handler } of this._shutdownHandlers) {
        process.removeListener(event, handler);
      }
    }
    this._shutdownHandlers = [];

    let shuttingDown = false;
    const shutdown = async (signal) => {
      if (shuttingDown) return; // Prevent concurrent shutdown
      shuttingDown = true;
      this.logger.info(`Received ${signal}, shutting down gracefully...`);

      try {
        await this.stop();
        process.exit(0);
      } catch (error) {
        this.logger.error(`Shutdown error: ${error.message}`);
        process.exit(1);
      }
    };

    const onSigterm = () => shutdown('SIGTERM');
    const onSigint = () => shutdown('SIGINT');
    const onUncaught = (error) => {
      this.logger.error(`Uncaught exception: ${error.message}`);
      this.logger.error(error.stack);
      shutdown('uncaughtException').catch(() => process.exit(1));
    };
    const onUnhandled = (reason) => {
      this.logger.error(`Unhandled rejection: ${reason}`);
      shutdown('unhandledRejection').catch(() => process.exit(1));
    };

    process.on('SIGTERM', onSigterm);
    process.on('SIGINT', onSigint);
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUnhandled);

    this._shutdownHandlers = [
      { event: 'SIGTERM', handler: onSigterm },
      { event: 'SIGINT', handler: onSigint },
      { event: 'uncaughtException', handler: onUncaught },
      { event: 'unhandledRejection', handler: onUnhandled }
    ];
  }
}

export default Application;