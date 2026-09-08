/**
 * @file src/api/CommandRegistry.js
 * @description Central command dispatcher for the WebSocket API.
 *
 * Pipeline applied to every incoming message:
 *   1. Envelope validation via {@link JsonValidator.validateCommand}.
 *   2. Handler lookup — an unknown command is an ERR_NOT_FOUND, never a
 *      validation error.
 *   3. Per-command payload validation via
 *      {@link JsonValidator.validateByCommand}, which reads the
 *      precompiled schema registry built from `schemas/*.schemas.js` and is
 *      **fail-closed**: no schema and no exemption means the frame is
 *      refused (`schemas/validation-policy.js`).
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

/** Currently advertised API version, returned alongside every response. */
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

// Per-command payload validation is now driven entirely by the schema
// registry inside JsonValidator (`validateByCommand`). Adding a new
// command only requires creating an entry in a `schemas/*.schemas.js`
// file — no manual map maintenance here.

/**
 * Holds command-name -> handler bindings and dispatches incoming
 * WebSocket frames against them.
 */
class CommandRegistry {
  /**
   * @param {Object} deps - DI bag (or Application facade). Needs
   *   `logger`; `eventBus` is consumed when present (metrics event).
   *   The whole bag is forwarded to each command module's `register()`
   *   under the historical `app` parameter name — handlers read
   *   `app.foo` to resolve their own dependencies.
   */
  constructor(deps) {
    this._deps = deps;
    this.logger = deps.logger;
    this.eventBus = deps.eventBus ?? null;
    /**
     * @type {Object<string, Function>} Registered command handlers.
     */
    this.handlers = {};
  }

  /**
   * Register a command handler. Re-registering an existing handler logs a
   * warning — useful to catch accidental double-loads during hot-reload.
   *
   * @param {string} command - Command name (e.g. `"file_upload"`).
   * @param {Function} handler - Async function `(data) => result`.
   * @returns {void}
   */
  register(command, handler) {
    if (this.handlers[command]) {
      this.logger.warn(`CommandRegistry: overwriting handler for '${command}'.`);
    }
    this.handlers[command] = handler;
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
        // The second arg keeps the historical `app` name — every command
        // module signature is `register(registry, app)`. The value we
        // pass is the DI facade itself, so handlers can do
        // `app.fileManager` etc.
        mod.register(this, this._deps);
        this.logger.debug(`CommandRegistry: loaded module ${file}`);
      } else {
        this.logger.warn(
          `CommandRegistry: ${file} does not export a register() function, skipping`
        );
      }
    }

    this.logger.info(
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
    // Priority: message.id sent by the client (already unique per request)
    // → 8-char base36 token (see _generateCid) so server-initiated or
    // malformed messages are still traceable.
    const cid = (message && message.id) || _generateCid();
    const cmd = message && message.command;
    const tag = `[cmd=${cmd} cid=${cid}]`;

    try {
      // Per-message tracing belongs to `debug` (Logger.js convention:
      // info = operator milestone, not per-iteration). 60 cmd/s × 4 lines
      // would saturate INFO and bury the actual lifecycle events.
      // Gated so the template string is never built when debug is off.
      if (this.logger.isDebugEnabled?.()) {
        this.logger.debug(`${tag} Handling command`);
      }

      // Envelope validation: message must be an object with a string `command`.
      const validation = JsonValidator.validateCommand(message);
      if (!validation.valid) {
        throw new ValidationError(`Invalid message: ${validation.errors.join(', ')}`);
      }

      // Handler lookup comes FIRST so an unknown command name still answers
      // ERR_NOT_FOUND rather than the fail-closed validation error below —
      // the two failures mean different things to a client.
      const handler = this.handlers[message.command];
      if (!handler) {
        throw new NotFoundError('command', message.command);
      }

      // Per-command payload validation via the schema registry. Fail-closed
      // since the F-19 remediation: a command with no schema is refused unless
      // `schemas/validation-policy.js` exempts it, or its handler takes no
      // payload argument at all (`() => fn(app)`) — in which case no payload
      // can reach anything and there is nothing to validate.
      const cmdValidation = JsonValidator.validateByCommand(message.command, message.data || {}, {
        payloadBlind: handler.length === 0
      });
      if (!cmdValidation.valid) {
        throw new ValidationError(
          `Invalid ${message.command} data: ${cmdValidation.errors.join(', ')}`
        );
      }

      // Execute handler
      const result = await handler(message.data || {});

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
      if (this.logger.isDebugEnabled?.()) {
        this.logger.debug(`${tag} Command completed in ${duration}ms`);
      }
      // P2-OBS.2/3 : emit a metric event for any interested subscriber
      // (dashboards, Prometheus exporter, etc.). Payload kept minimal to
      // avoid log-level bloat.
      this.eventBus?.emit?.('ws.command.completed', {
        command: cmd,
        cid,
        duration,
        success: true
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(`${tag} Command failed: ${error.message}`);
      this.logger.error(error.stack);
      this.eventBus?.emit?.('ws.command.completed', {
        command: cmd,
        cid,
        duration,
        success: false,
        errorCode: error instanceof ApplicationError ? error.code : 'ERR_INTERNAL'
      });

      // Only expose ApplicationError messages to the client;
      // internal errors get a generic message to avoid leaking details.
      const isKnownError = error instanceof ApplicationError;

      if (ws.readyState === 1) {
        ws.send(
          JSON.stringify({
            // Optional chaining: a client can send the literal frame `null`
            // (JSON.parse('null') === null); dereferencing message.id here would
            // throw a TypeError inside the catch, losing the intended
            // ValidationError response and returning an uncorrelated generic error.
            id: message?.id,
            type: 'error',
            command: message?.command,
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
