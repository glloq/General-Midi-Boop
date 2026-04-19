/**
 * @file src/core/Application.js
 * @description Top-level orchestrator for the GeneralMidiBoop backend. Owns the
 * lifecycle of every long-lived service (database, MIDI router/player,
 * managers, HTTP/WS servers) and the {@link ServiceContainer} used by
 * everyone else for dependency lookup.
 *
 * Lifecycle:
 *   constructor → {@link Application#initialize} → {@link Application#start}
 *   → ... → {@link Application#stop} (typically via OS signals routed
 *   through {@link Application#setupShutdownHandlers}).
 *
 * Each service is registered both on `this` (legacy access pattern) and in
 * the container under the same key. New code should resolve via the
 * container; the duplicated `this.xxx` references will be removed once
 * every consumer has migrated.
 *
 * Optional services (BluetoothManager, NetworkManager, SerialMidiManager,
 * LightingManager) are loaded inside try/catch — missing native deps on a
 * given host are logged as warnings, not fatal errors.
 */
import { randomBytes } from 'crypto';
import { existsSync, readFileSync, appendFileSync, writeFileSync, renameSync } from 'fs';
import { resolve } from 'path';
import Config from './Config.js';
import Logger from './Logger.js';
import EventBus from './EventBus.js';
import ServiceContainer from './ServiceContainer.js';
import Database from '../persistence/Database.js';
import DeviceManager from '../midi/devices/DeviceManager.js';
import MidiRouter from '../midi/routing/MidiRouter.js';
import MidiPlayer from '../midi/playback/MidiPlayer.js';
import LatencyCompensator from '../midi/adaptation/LatencyCompensator.js';
import DelayCalibrator from '../audio/DelayCalibrator.js';
import FileManager from '../files/FileManager.js';
import BlobStore from '../files/BlobStore.js';
import UploadQueue from '../files/UploadQueue.js';
import path from 'path';
import BluetoothManager from '../transports/BluetoothManager.js';
import NetworkManager from '../transports/NetworkManager.js';
import WebSocketServer from '../api/WebSocketServer.js';
import HttpServer from '../api/HttpServer.js';
import CommandHandler from '../api/CommandHandler.js';
import AutoAssigner from '../midi/adaptation/AutoAssigner.js';
import MidiAdaptationService from '../midi/adaptation/MidiAdaptationService.js';
import FileRepository from '../repositories/FileRepository.js';
import RoutingRepository from '../repositories/RoutingRepository.js';
import InstrumentRepository from '../repositories/InstrumentRepository.js';
import PresetRepository from '../repositories/PresetRepository.js';
import SessionRepository from '../repositories/SessionRepository.js';
import PlaylistRepository from '../repositories/PlaylistRepository.js';
import DeviceSettingsRepository from '../repositories/DeviceSettingsRepository.js';
import LightingRepository from '../repositories/LightingRepository.js';
import StringInstrumentRepository from '../repositories/StringInstrumentRepository.js';
import FileRoutingSyncService from '../midi/routing/FileRoutingSyncService.js';
import DeviceReconciliationService from '../midi/devices/DeviceReconciliationService.js';
import FileRoutingStatusService from '../midi/files/FileRoutingStatusService.js';
import MidiClockGenerator from '../midi/playback/MidiClockGenerator.js';
import BackupScheduler from '../persistence/BackupScheduler.js';

/**
 * Application root. One instance per process — see `server.js`.
 */
class Application {
  /**
   * Wire the always-available services (config, logger, event bus, DI
   * container) and pre-declare the slots for the rest. No I/O happens
   * here; call {@link Application#initialize} next.
   *
   * @param {?string} [configPath=null] - Optional path to an alternate
   *   `config.json` (forwarded to the {@link Config} constructor).
   */
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

    this.version = (() => {
      try {
        const pkg = JSON.parse(
          readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
        );
        return pkg.version || 'unknown';
      } catch {
        return 'unknown';
      }
    })();
    this.logger.info(`=== GeneralMidiBoop ${this.version} Starting ===`);
  }

  /**
   * Register a service in both the container and on `this` for backward
   * compat. New services should use `container.resolve()` /
   * `container.inject()` instead.
   * TODO: drop the `this[name] = instance` line once every consumer has
   * migrated to container lookup.
   *
   * @param {string} name - Service name (becomes the container key).
   * @param {*} instance - Constructed service instance.
   * @returns {void}
   * @private
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
   * Ensure an API bearer token exists. If `GMBOOP_API_TOKEN` is not set,
   * a 32-byte random hex token is generated, written to `.env`, exported
   * via `process.env` so the HTTP / WebSocket servers pick it up, and
   * logged as a one-shot warning so the operator can copy it.
   *
   * @returns {void}
   * @private
   */
  _migrateLegacyArtifacts() {
    const pairs = [
      ['./data/midimind.db', './data/gmboop.db'],
      ['./logs/midimind.log', './logs/gmboop.log']
    ];
    for (const [oldPath, newPath] of pairs) {
      if (existsSync(oldPath) && !existsSync(newPath)) {
        try {
          renameSync(oldPath, newPath);
          this.logger.warn(`Migrated legacy artifact ${oldPath} -> ${newPath}`);
        } catch (error) {
          this.logger.warn(`Legacy migration failed for ${oldPath}: ${error.message}`);
        }
      }
    }
  }

  _ensureApiToken() {
    if (process.env.GMBOOP_API_TOKEN) {
      this.logger.info('API token already configured');
      return;
    }

    const token = randomBytes(32).toString('hex');
    const envPath = resolve('.env');

    try {
      if (existsSync(envPath)) {
        const content = readFileSync(envPath, 'utf8');
        if (content.includes('GMBOOP_API_TOKEN')) {
          // Variable already declared (likely empty after `.env.example`
          // copy) — overwrite the existing line in place.
          const updated = content.replace(/^GMBOOP_API_TOKEN=.*$/m, `GMBOOP_API_TOKEN=${token}`);
          writeFileSync(envPath, updated, 'utf8');
        } else {
          appendFileSync(envPath, `\nGMBOOP_API_TOKEN=${token}\n`, 'utf8');
        }
      } else {
        writeFileSync(envPath, `GMBOOP_API_TOKEN=${token}\n`, 'utf8');
      }
    } catch (err) {
      this.logger.warn(`Could not persist API token to .env: ${err.message}`);
    }

    process.env.GMBOOP_API_TOKEN = token;
    this.logger.warn(`=== AUTO-GENERATED API TOKEN ===`);
    this.logger.warn(`Token: ${token}`);
    this.logger.warn(`Save this token — it is required to access the API.`);
    this.logger.warn(`================================`);
  }

  /**
   * Build every backend service and wire EventBus subscriptions. Safe to
   * call only once per Application instance — call {@link Application#stop}
   * before re-initialising.
   *
   * Registration order mirrors the dependency graph: lower layers
   * (database, MIDI components) come before higher layers (managers, API).
   * Optional services that fail to load (missing native deps, missing
   * hardware) are logged as warnings and silently absent from the
   * container; callers must use `?.` when accessing them.
   *
   * @returns {Promise<void>}
   * @throws Re-throws the underlying error after logging when initialisation
   *   of a non-optional service fails.
   */
  async initialize() {
    try {
      this.logger.info('Initializing application...');

      // One-shot rebrand migration (v5.x -> 0.7.x). Remove in 0.8.0.
      this._migrateLegacyArtifacts();

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

      // Initialize storage: BlobStore lives next to the SQLite file.
      const dataDir = path.dirname(this.config.database.path || './data/gmboop.db');
      this._registerService('blobStore', new BlobStore({ baseDir: dataDir, logger: this.logger }));
      this._registerService(
        'uploadQueue',
        new UploadQueue({
          logger: this.logger,
          onProgress: ({ uploadId, stage }) => {
            this.wsServer?.broadcast('file_upload_progress', { uploadId, stage });
          }
        })
      );
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
        const { default: SerialMidiManager } = await import('../transports/SerialMidiManager.js');
        this._registerService('serialMidiManager', new SerialMidiManager(deps));
        this.logger.info('Serial MIDI manager initialized');
      } catch (error) {
        this.logger.warn(`Serial MIDI not available: ${error.message}`);
      }

      // Initialize Lighting Manager (optional - requires pigpio on Raspberry Pi)
      try {
        const { default: LightingManager } = await import('../lighting/LightingManager.js');
        this._registerService('lightingManager', new LightingManager(deps));
        this.logger.info('Lighting manager initialized');
      } catch (error) {
        this.logger.warn(`Lighting manager not available: ${error.message}`);
      }

      // Initialize auto-assigner (singleton with cache; EventBus invalidates
      // on file_write / file_delete / file_uploaded automatically).
      this._registerService(
        'autoAssigner',
        new AutoAssigner(this.database, this.logger, this.eventBus)
      );

      // Initialize MIDI adaptation service (facade over MidiTransposer + AutoAssigner)
      this._registerService(
        'adaptationService',
        new MidiAdaptationService(this.logger, this.autoAssigner)
      );

      // Initialize repositories (ADR-002: wrappers over existing sub-DBs)
      this._registerService('fileRepository', new FileRepository(this.database));
      this._registerService('routingRepository', new RoutingRepository(this.database));
      this._registerService('instrumentRepository', new InstrumentRepository(this.database));
      this._registerService('presetRepository', new PresetRepository(this.database));
      this._registerService('sessionRepository', new SessionRepository(this.database));
      this._registerService('playlistRepository', new PlaylistRepository(this.database));
      this._registerService(
        'deviceSettingsRepository',
        new DeviceSettingsRepository(this.database)
      );
      this._registerService('lightingRepository', new LightingRepository(this.database));
      this._registerService(
        'stringInstrumentRepository',
        new StringInstrumentRepository(this.database)
      );

      // Initialize domain services (Phase 4 — P1-4.1+)
      this._registerService(
        'fileRoutingSyncService',
        new FileRoutingSyncService({
          routingRepository: this.routingRepository,
          fileRepository: this.fileRepository,
          deviceManager: this.deviceManager,
          logger: this.logger
        })
      );
      this._registerService(
        'deviceReconciliationService',
        new DeviceReconciliationService({
          instrumentRepository: this.instrumentRepository,
          logger: this.logger
        })
      );
      this._registerService(
        'fileRoutingStatusService',
        new FileRoutingStatusService({
          fileRepository: this.fileRepository,
          routingRepository: this.routingRepository
        })
      );

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

  /**
   * Subscribe Application-level handlers to the canonical EventBus events
   * (logging + WS broadcast for device connect/disconnect). Idempotent:
   * existing handlers from a previous call are detached first to avoid
   * duplicate notifications after a restart.
   *
   * @returns {void}
   */
  setupEventHandlers() {
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

  /**
   * Detach every handler previously registered through
   * {@link Application#setupEventHandlers}. Called both before re-binding
   * and on shutdown to keep the EventBus clean across restarts.
   *
   * @returns {void}
   */
  removeEventHandlers() {
    if (this._eventHandlers) {
      for (const { event, handler } of this._eventHandlers) {
        this.eventBus.off(event, handler);
      }
      this._eventHandlers = [];
    }
  }

  /**
   * Bring the application online: scan MIDI devices, start HTTP, then
   * WebSocket (which needs the http.Server instance), kick off the backup
   * scheduler, and trigger a one-shot reanalysis of any files missing
   * channel metadata so GM instrument filters work for legacy uploads.
   *
   * @returns {Promise<void>}
   * @throws Re-throws after logging when a non-optional startup step fails.
   */
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

      // Start automated backups (DB snapshot + blob manifest sidecar).
      this._registerService(
        'backupScheduler',
        new BackupScheduler({
          logger: this.logger,
          database: this.database,
          blobStore: this.blobStore
        })
      );
      this.backupScheduler.start();

      this.running = true;
      this.logger.info(`=== GeneralMidiBoop ${this.version} Running ===`);
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

  /**
   * Tear down everything in roughly the reverse order of {@link
   * Application#start}/{@link Application#initialize}: backup scheduler,
   * MIDI player, network servers, MIDI ports, optional managers,
   * auto-assigner, EventBus subscriptions, and finally the database.
   *
   * Each step is wrapped in defensive `if (this.x)` checks because stop()
   * may run after a partially-failed `initialize()`.
   *
   * @returns {Promise<void>}
   * @throws Re-throws after logging if a teardown step throws.
   */
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

      this.logger.info(`=== GeneralMidiBoop ${this.version} Stopped ===`);
    } catch (error) {
      this.logger.error(`Stop failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Convenience helper: stop, re-initialise, and start the application
   * in a single call. Used by some maintenance commands.
   *
   * @returns {Promise<void>}
   */
  async restart() {
    await this.stop();
    await this.initialize();
    await this.start();
  }

  /**
   * Build a snapshot of runtime metrics (point-in-time, not subscribable).
   * Used by `server.js` for the boot banner and by `system_status` API.
   *
   * @returns {{
   *   running: boolean,
   *   uptime: number,
   *   memory: NodeJS.MemoryUsage,
   *   devices: number,
   *   routes: number,
   *   files: number,
   *   wsClients: number
   * }}
   */
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

  /**
   * Install OS-signal and last-resort exception handlers that route every
   * shutdown trigger through {@link Application#stop} exactly once. Safe
   * to call repeatedly: previously installed handlers are removed first
   * so they never accumulate across restarts.
   *
   * @returns {void}
   */
  setupShutdownHandlers() {
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
