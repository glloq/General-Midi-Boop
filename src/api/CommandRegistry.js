/**
 * @file src/api/CommandRegistry.js
 * @description Central command dispatcher for the WebSocket API.
 *
 * Pipeline applied to every incoming message:
 *   1. Envelope validation via {@link JsonValidator.validateCommand}.
 *   2. Per-command payload validation, looked up through the
 *      {@link COMMAND_VALIDATORS} map and resolved against
 *      {@link JsonValidator}.
 *   3. Handler lookup (versioned handlers take priority when the client
 *      sends `version`; falls back to the v1 handler otherwise).
 *   4. Async handler execution; result and `duration` are sent back to
 *      the client and a `ws.command.completed` metric is emitted on the
 *      EventBus.
 *   5. Errors are categorised: {@link ApplicationError} subclasses are
 *      surfaced to the client verbatim; everything else is masked behind
 *      a generic "Internal server error" to avoid leaking internals.
 *
 * Command modules are auto-discovered from `commands/` —
 * see {@link CommandRegistry#loadCommandModules}.
 */
import JsonValidator from '../utils/JsonValidator.js';
import { ApplicationError, ValidationError, NotFoundError } from '../core/errors/index.js';
import { readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Currently advertised API version. Versioned handlers registered with a
 * different version are kept in a separate map and only invoked when the
 * client requests them explicitly.
 */
const CURRENT_API_VERSION = 1;

/**
 * Correlation-ID generator used when a client message arrives without an
 * `id` (server-initiated or malformed frames). 8 base36 characters is
 * short enough for log readability and random enough for practical
 * per-session uniqueness — no cryptographic guarantees needed (P2-OBS.1).
 *
 * @returns {string} 8-char base36 token.
 */
function _generateCid() {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Maps command names to the static method on {@link JsonValidator} that
 * validates their payload. Commands not listed here skip per-payload
 * validation (they may still rely on imperative checks inside the handler).
 *
 * TODO: drive this map from the schema files themselves so adding a new
 * command does not require touching two places.
 *
 * @type {Object<string, string>}
 */
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

/**
 * Holds command-name -> handler bindings and dispatches incoming
 * WebSocket frames against them.
 */
class CommandRegistry {
  /**
   * @param {Object} app - Application facade; needs `logger` and
   *   (optionally) `eventBus` for the metric event.
   */
  constructor(app) {
    this.app = app;
    /**
     * @type {Object<string, Function>} Default (current-version) handlers.
     */
    this.handlers = {};
    /**
     * @type {Object<string, Function>} Versioned handlers keyed by
     *   `"v<version>:<command>"`.
     */
    this.versionedHandlers = {};
  }

  /**
   * Register a command handler. When `version` is omitted (or equal to
   * {@link CURRENT_API_VERSION}), the handler becomes the default. A
   * different version stashes it in {@link CommandRegistry#versionedHandlers}
   * so existing default handlers stay untouched.
   *
   * Re-registering an existing default handler logs a warning — useful to
   * catch accidental double-loads during hot-reload.
   *
   * @param {string} command - Command name (e.g. `"file_upload"`).
   * @param {Function} handler - Async function `(data) => result`.
   * @param {number} [version] - Optional API version.
   * @returns {void}
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
   * Auto-discover and load every `*.js` command module from the
   * sibling `commands/` directory. Each module must export a
   * `register(registry, app)` function; modules without one are
   * skipped with a warning instead of crashing the boot.
   *
   * @returns {Promise<void>}
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
   * Main dispatch method.
   *
   * Validates the message, looks up the handler (versioned > default),
   * executes it, and writes the response back to the originating
   * WebSocket. Always emits `ws.command.completed` on the EventBus,
   * regardless of success, so observability tooling sees both halves.
   *
   * Errors:
   * - {@link ValidationError} — surfaced verbatim (HTTP-equivalent 400).
   * - {@link NotFoundError} — surfaced verbatim when the command name
   *   is unknown.
   * - Any other thrown value — masked behind `"Internal server error"`
   *   in the wire response so internal stack traces never leak.
   *
   * @param {Object} message - Parsed WS frame `{id, command, version?, data?}`.
   * @param {import('ws').WebSocket} ws - Originating socket.
   * @returns {Promise<void>}
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

      // Envelope validation: message must be an object with a string `command`.
      const validation = JsonValidator.validateCommand(message);
      if (!validation.valid) {
        throw new ValidationError(`Invalid message: ${validation.errors.join(', ')}`);
      }

      // Per-command payload validation, opt-in via the COMMAND_VALIDATORS map.
      const validatorName = COMMAND_VALIDATORS[message.command];
      if (validatorName && typeof JsonValidator[validatorName] === 'function') {
        const cmdValidation = JsonValidator[validatorName](message.command, message.data || {});
        if (!cmdValidation.valid) {
          throw new ValidationError(`Invalid ${message.command} data: ${cmdValidation.errors.join(', ')}`);
        }
      }

      // Versioned handler takes priority when the client requests a
      // non-current version; fall back to the default handler otherwise.
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
