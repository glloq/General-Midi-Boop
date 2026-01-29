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
    this.wsServer = null;
    this.httpServer = null;
    this.commandHandler = null;
    this.running = false;

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
    // MIDI message events
    this.eventBus.on('midi_message', (data) => {
      this.logger.debug(`MIDI message: ${data.device} ${data.type}`);
    });

    // Device events
    this.eventBus.on('device_connected', (data) => {
      this.logger.info(`Device connected: ${data.deviceId}`);
      this.wsServer.broadcast('device_connected', data);
    });

    this.eventBus.on('device_disconnected', (data) => {
      this.logger.info(`Device disconnected: ${data.deviceId}`);
      this.wsServer.broadcast('device_disconnected', data);
    });

    // Routing events
    this.eventBus.on('midi_routed', (data) => {
      this.logger.debug(`MIDI routed: ${data.route}`);
    });

    // File events
    this.eventBus.on('file_uploaded', (data) => {
      this.logger.info(`File uploaded: ${data.filename}`);
    });

    // Playback events
    this.eventBus.on('playback_started', (data) => {
      this.logger.info('Playback started');
    });

    this.eventBus.on('playback_stopped', (data) => {
      this.logger.info('Playback stopped');
    });

    // Error events
    this.eventBus.on('error', (error) => {
      this.logger.error(`Application error: ${error.message}`);
    });
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
    } catch (error) {
      this.logger.error(`Start failed: ${error.message}`);
      throw error;
    }
  }

  async stop() {
    try {
      this.logger.info('Stopping application...');
      this.running = false;

      // Stop playback
      if (this.midiPlayer && this.midiPlayer.playing) {
        this.midiPlayer.stop();
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
    const shutdown = async (signal) => {
      this.logger.info(`Received ${signal}, shutting down gracefully...`);
      
      try {
        await this.stop();
        process.exit(0);
      } catch (error) {
        this.logger.error(`Shutdown error: ${error.message}`);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('uncaughtException', (error) => {
      this.logger.error(`Uncaught exception: ${error.message}`);
      this.logger.error(error.stack);
      shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error(`Unhandled rejection: ${reason}`);
      shutdown('unhandledRejection');
    });
  }
}

export default Application;