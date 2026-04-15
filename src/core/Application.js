// src/core/Application.js
import { randomBytes } from 'crypto';
import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import Config from '../config/Config.js';
import Logger from './Logger.js';
import EventBus from './EventBus.js';
import ServiceContainer from './ServiceContainer.js';
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
import MidiClockGenerator from '../midi/MidiClockGenerator.js';
import BackupScheduler from '../storage/BackupScheduler.js';

class Application {
  constructor(configPath = null) {
    // Core services (always available)
    this.config = new Config(configPath);
    this.logger = new Logger(this.config.logging);
    this.eventBus = new EventBus(this.logger);

    // DI Container — new code should use container.resolve() instead of this.xxx
    this.container = new ServiceContainer();
    this.container.register('config', this.config);
    this.container.register('logger', this.logger);
    this.container.register('eventBus', this.eventBus);

    // Service references (kept for backward compatibility with existing modules)
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
    this.lightingManager = null;
    this.midiClockGenerator = null;
    this.autoAssigner = null;
    this.wsServer = null;
    this.httpServer = null;
    this.commandHandler = null;
    this.running = false;

    // Track bound event handlers for cleanup
    this._eventHandlers = [];

    this.logger.info('=== MidiMind 5.0 Starting ===');
  }

  /**
   * Register a service in both the container and on `this` for backward compat.
   * New services should use container.resolve() or container.inject() instead.
   * @param {string} name - Service name
   * @param {*} instance - Service instance
   */
  _registerService(name, instance) {
    this[name] = instance;
    this.container.register(name, instance);
  }

  /**
   * Create a legacy app-like facade from the container.
   * Use this when constructing services that still expect `app` as first arg.
   * This allows gradual migration: services can access deps via this facade
   * while being resolved through the container.
   * @returns {Object} A proxy that resolves properties from the container
   */
  _createAppFacade() {
    const container = this.container;
    const self = this;
    return new Proxy(
      {},
      {
        get(_, prop) {
          // Try container first, then fall back to Application instance
          if (container.has(prop)) {
            return container.resolve(prop);
          }
          return self[prop];
        }
      }
    );
  }

  /**
   * Ensure an API token exists. If MAESTRO_API_TOKEN is not set, generate one,
   * persist it to .env, and set it in process.env so the HTTP/WS servers pick it up.
   */
  _ensureApiToken() {
    if (process.env.MAESTRO_API_TOKEN) {
      this.logger.info('API token already configured');
      return;
    }

    const token = randomBytes(32).toString('hex');
    const envPath = resolve('.env');

    try {
      if (existsSync(envPath)) {
        const content = readFileSync(envPath, 'utf8');
        if (content.includes('MAESTRO_API_TOKEN')) {
          // Variable exists but is empty — replace the line
          const updated = content.replace(/^MAESTRO_API_TOKEN=.*$/m, `MAESTRO_API_TOKEN=${token}`);
          writeFileSync(envPath, updated, 'utf8');
        } else {
          appendFileSync(envPath, `\nMAESTRO_API_TOKEN=${token}\n`, 'utf8');
        }
      } else {
        writeFileSync(envPath, `MAESTRO_API_TOKEN=${token}\n`, 'utf8');
      }
    } catch (err) {
      this.logger.warn(`Could not persist API token to .env: ${err.message}`);
    }

    process.env.MAESTRO_API_TOKEN = token;
    this.logger.warn(`=== AUTO-GENERATED API TOKEN ===`);
    this.logger.warn(`Token: ${token}`);
    this.logger.warn(`Save this token — it is required to access the API.`);
    this.logger.warn(`================================`);
  }

  async initialize() {
    try {
      this.logger.info('Initializing application...');

      // Ensure API authentication is configured
      this._ensureApiToken();

      // Create the app facade — a Proxy that resolves properties from the
      // container first, falling back to the Application instance.  Services
      // receive this facade as their `deps` argument, so they can access any
      // registered service by name (e.g. deps.logger, deps.database).
      const deps = this._createAppFacade();
      this.container.register('app', deps);

      // Initialize database (uses deps.config, deps.logger)
      this._registerService('database', new Database(deps));

      // Initialize MIDI components
      this._registerService('deviceManager', new DeviceManager(deps));
      this._registerService('midiRouter', new MidiRouter(deps));
      this._registerService('midiClockGenerator', new MidiClockGenerator(deps));
      this._registerService('midiPlayer', new MidiPlayer(deps));
      this._registerService('latencyCompensator', new LatencyCompensator(deps));
      this._registerService(
        'delayCalibrator',
        new DelayCalibrator(this.deviceManager, this.logger)
      );

      // Initialize storage
      this._registerService('fileManager', new FileManager(deps));

      // Initialize Bluetooth (optional - may not be available on all systems)
      try {
        this._registerService('bluetoothManager', new BluetoothManager(deps));
        this.logger.info('Bluetooth initialized');
      } catch (error) {
        this.logger.warn(`Bluetooth not available: ${error.message}`);
      }

      // Initialize Network Manager
      try {
        this._registerService('networkManager', new NetworkManager(deps));
        this.logger.info('Network manager initialized');
      } catch (error) {
        this.logger.warn(`Network manager not available: ${error.message}`);
      }

      // Initialize Serial MIDI (optional - requires serialport package)
      try {
        const { default: SerialMidiManager } = await import('../managers/SerialMidiManager.js');
        this._registerService('serialMidiManager', new SerialMidiManager(deps));
        this.logger.info('Serial MIDI manager initialized');
      } catch (error) {
        this.logger.warn(`Serial MIDI not available: ${error.message}`);
      }

      // Initialize Lighting Manager (optional - requires pigpio on Raspberry Pi)
      try {
        const { default: LightingManager } = await import('../managers/LightingManager.js');
        this._registerService('lightingManager', new LightingManager(deps));
        this.logger.info('Lighting manager initialized');
      } catch (error) {
        this.logger.warn(`Lighting manager not available: ${error.message}`);
      }

      // Initialize auto-assigner (singleton with cache)
      this._registerService('autoAssigner', new AutoAssigner(this.database, this.logger));

      // Initialize API
      this._registerService('commandHandler', new CommandHandler(deps));
      this._registerService('httpServer', new HttpServer(deps));
      this._registerService('wsServer', new WebSocketServer(deps, null));

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
      [
        'midi_message',
        (data) => {
          this.logger.debug(`MIDI message: ${data.device} ${data.type}`);
        }
      ],
      [
        'device_connected',
        (data) => {
          this.logger.info(`Device connected: ${data.deviceId}`);
          this.wsServer?.broadcast('device_connected', data);
        }
      ],
      [
        'device_disconnected',
        (data) => {
          this.logger.info(`Device disconnected: ${data.deviceId}`);
          this.wsServer?.broadcast('device_disconnected', data);
        }
      ],
      [
        'midi_routed',
        (data) => {
          this.logger.debug(`MIDI routed: ${data.route}`);
        }
      ],
      [
        'file_uploaded',
        (data) => {
          this.logger.info(`File uploaded: ${data.filename}`);
        }
      ],
      [
        'playback_started',
        () => {
          this.logger.info('Playback started');
        }
      ],
      [
        'playback_stopped',
        () => {
          this.logger.info('Playback stopped');
        }
      ],
      [
        'error',
        (error) => {
          this.logger.error(`Application error: ${error.message}`);
        }
      ]
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
      this.wsServer.start(); // start() already calls startHeartbeat()

      // Start automated backups
      this._registerService('backupScheduler', new BackupScheduler(
        { logger: this.logger, database: this.database }
      ));
      this.backupScheduler.start();

      this.running = true;
      this.logger.info('=== MidiMind 5.0 Running ===');
      this.logger.info(`HTTP/WebSocket server: http://localhost:${this.config.server.port}`);

      // Auto-reanalyze files missing channel data (needed for GM instrument filters)
      try {
        const missingCount = this.database.countFilesWithoutChannels();
        if (missingCount > 0) {
          this.logger.info(
            `Found ${missingCount} files without channel analysis data, starting auto-reanalysis...`
          );
          const result = await this.fileManager.reanalyzeAllFiles();
          this.logger.info(
            `Auto-reanalysis complete: ${result.analyzed} analyzed, ${result.failed} failed`
          );
        }
      } catch (error) {
        this.logger.warn(`Auto-reanalysis failed (non-critical): ${error.message}`);
      }

      // Note: stale routing records (pointing to disconnected devices) are NOT deleted,
      // as they preserve the user's routing configuration for when devices reconnect.
      // Instead, routing status computation filters by connected devices at query time.
    } catch (error) {
      this.logger.error(`Start failed: ${error.message}`);
      throw error;
    }
  }


  async stop() {
    try {
      this.logger.info('Stopping application...');
      this.running = false;

      // Stop backup scheduler
      if (this.backupScheduler) {
        this.backupScheduler.stop();
      }

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
      if (this.bluetoothManager && typeof this.bluetoothManager.cleanup === 'function') {
        await this.bluetoothManager.cleanup();
      }

      // Close Network
      if (this.networkManager && this.networkManager.shutdown) {
        await this.networkManager.shutdown();
      }

      // Close Serial MIDI
      if (this.serialMidiManager) {
        await this.serialMidiManager.shutdown();
      }

      // Close Lighting
      if (this.lightingManager) {
        await this.lightingManager.shutdown();
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
      devices: this.deviceManager?.getDeviceList()?.length ?? 0,
      routes: this.midiRouter?.getRouteList()?.length ?? 0,
      files: this.database?.getFiles('/')?.length ?? 0,
      wsClients: this.wsServer?.getStats()?.clients ?? 0
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
