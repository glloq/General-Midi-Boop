// src/api/CommandRegistry.js
import JsonValidator from '../utils/JsonValidator.js';
import { ApplicationError, ValidationError, NotFoundError } from '../core/errors/index.js';
import { readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CURRENT_API_VERSION = 1;

// Correlation ID generator (P2-OBS.1). Short enough to be log-friendly,
// random enough for practical uniqueness within a session.
function _generateCid() {
  return Math.random().toString(36).slice(2, 10);
}

// Map commands to their specific validator methods in JsonValidator
const COMMAND_VALIDATORS = {
  file_upload: 'validateFileCommand',
  file_delete: 'validateFileCommand',
  file_rename: 'validateFileCommand',
  file_move: 'validateFileCommand',
  file_export: 'validateFileCommand',
  device_info: 'validateDeviceCommand',
  device_enable: 'validateDeviceCommand',
  device_set_properties: 'validateDeviceCommand',
  virtual_create: 'validateDeviceCommand',
  virtual_delete: 'validateDeviceCommand',
  ble_connect: 'validateDeviceCommand',
  ble_disconnect: 'validateDeviceCommand',
  route_create: 'validateRoutingCommand',
  route_delete: 'validateRoutingCommand',
  route_enable: 'validateRoutingCommand',
  filter_set: 'validateRoutingCommand',
  filter_clear: 'validateRoutingCommand',
  channel_map: 'validateRoutingCommand',
  monitor_start: 'validateRoutingCommand',
  monitor_stop: 'validateRoutingCommand',
  playback_start: 'validatePlaybackCommand',
  playback_seek: 'validatePlaybackCommand',
  playback_set_loop: 'validatePlaybackCommand',
  latency_measure: 'validateLatencyCommand',
  latency_set: 'validateLatencyCommand',
  latency_get: 'validateLatencyCommand',
  latency_delete: 'validateLatencyCommand',
  system_backup: 'validateSystemCommand'
};

class CommandRegistry {
  constructor(app) {
    this.app = app;
    this.handlers = {};
    this.versionedHandlers = {}; // { "v2:commandName": handler }
  }

  /**
   * Register a command handler
   * @param {string} command - Command name
   * @param {Function} handler - Async handler function (data) => result
   * @param {number} [version] - API version (optional, registers as versioned handler)
   */
  register(command, handler, version) {
    if (version && version !== CURRENT_API_VERSION) {
      const key = `v${version}:${command}`;
      this.versionedHandlers[key] = handler;
    } else {
      if (this.handlers[command]) {
        this.app.logger.warn(`CommandRegistry: overwriting handler for '${command}'`);
      }
      this.handlers[command] = handler;
    }
  }

  /**
   * Auto-discover and load all command modules from the commands/ directory.
   * Each module must export a `register(registry, app)` function.
   */
  async loadCommandModules() {
    const commandsDir = join(__dirname, 'commands');
    const files = readdirSync(commandsDir).filter((f) => f.endsWith('.js'));

    for (const file of files) {
      const modulePath = join(commandsDir, file);
      const mod = await import(modulePath);

      if (typeof mod.register === 'function') {
        mod.register(this, this.app);
        this.app.logger.debug(`CommandRegistry: loaded module ${file}`);
      } else {
        this.app.logger.warn(
          `CommandRegistry: ${file} does not export a register() function, skipping`
        );
      }
    }

    this.app.logger.info(
      `CommandRegistry initialized with ${Object.keys(this.handlers).length} commands`
    );
  }

  /**
   * Main dispatch method – validates incoming message, finds handler, executes,
   * and sends JSON response/error back over the WebSocket.
   */
  async handle(message, ws) {
    const startTime = Date.now();
    // Correlation ID per command dispatch (P2-OBS.1).
    // Priority : message.id sent by the client (already unique per request) →
    // random UUID fallback so server-initiated or malformed messages are still
    // traceable.
    const cid = (message && message.id) || _generateCid();
    const cmd = message && message.command;
    const tag = `[cmd=${cmd} cid=${cid}]`;

    try {
      this.app.logger.info(`${tag} Handling command`);

      // Validate message structure
      const validation = JsonValidator.validateCommand(message);
      if (!validation.valid) {
        throw new ValidationError(`Invalid message: ${validation.errors.join(', ')}`);
      }

      // Command-specific input validation
      const validatorName = COMMAND_VALIDATORS[message.command];
      if (validatorName && typeof JsonValidator[validatorName] === 'function') {
        const cmdValidation = JsonValidator[validatorName](message.command, message.data || {});
        if (!cmdValidation.valid) {
          throw new ValidationError(`Invalid ${message.command} data: ${cmdValidation.errors.join(', ')}`);
        }
      }

      // Get handler (check versioned handlers first if version specified)
      let handler;
      if (message.version && message.version !== CURRENT_API_VERSION) {
        const versionedKey = `v${message.version}:${message.command}`;
        handler = this.versionedHandlers[versionedKey];
      }
      handler = handler || this.handlers[message.command];
      if (!handler) {
        throw new NotFoundError('command', message.command);
      }

      this.app.logger.info(`${tag} Executing handler`);

      // Execute handler
      const result = await handler(message.data || {});

      this.app.logger.info(`${tag} Handler executed, sending response`);

      // Send response with request ID for client to match
      if (ws.readyState === 1) {
        ws.send(
          JSON.stringify({
            id: message.id,
            type: 'response',
            command: message.command,
            version: CURRENT_API_VERSION,
            data: result,
            timestamp: Date.now(),
            duration: Date.now() - startTime
          })
        );
      }

      const duration = Date.now() - startTime;
      this.app.logger.info(`${tag} Command completed in ${duration}ms`);
      // P2-OBS.2/3 : emit a metric event for any interested subscriber
      // (dashboards, Prometheus exporter, etc.). Payload kept minimal to
      // avoid log-level bloat.
      this.app.eventBus?.emit?.('ws.command.completed', {
        command: cmd,
        cid,
        duration,
        success: true
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      this.app.logger.error(`${tag} Command failed: ${error.message}`);
      this.app.logger.error(error.stack);
      this.app.eventBus?.emit?.('ws.command.completed', {
        command: cmd,
        cid,
        duration,
        success: false,
        errorCode: (error instanceof ApplicationError) ? error.code : 'ERR_INTERNAL'
      });

      // Only expose ApplicationError messages to the client;
      // internal errors get a generic message to avoid leaking details.
      const isKnownError = error instanceof ApplicationError;

      if (ws.readyState === 1) {
        ws.send(
          JSON.stringify({
            id: message.id,
            type: 'error',
            command: message.command,
            error: isKnownError ? error.message : 'Internal server error',
            code: isKnownError ? error.code : undefined,
            timestamp: Date.now()
          })
        );
      }
    }
  }
}

export default CommandRegistry;
