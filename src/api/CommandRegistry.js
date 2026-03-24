// src/api/CommandRegistry.js
import JsonValidator from '../utils/JsonValidator.js';
import { readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CURRENT_API_VERSION = 1;

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

    try {
      this.app.logger.info(`Handling command: ${message.command} (id: ${message.id})`);

      // Validate message structure
      const validation = JsonValidator.validateCommand(message);
      if (!validation.valid) {
        throw new Error(`Invalid message: ${validation.errors.join(', ')}`);
      }

      // Get handler (check versioned handlers first if version specified)
      let handler;
      if (message.version && message.version !== CURRENT_API_VERSION) {
        const versionedKey = `v${message.version}:${message.command}`;
        handler = this.versionedHandlers[versionedKey];
      }
      handler = handler || this.handlers[message.command];
      if (!handler) {
        throw new Error(`Unknown command: ${message.command}`);
      }

      this.app.logger.info(`Executing handler for: ${message.command}`);

      // Execute handler
      const result = await handler(message.data || {});

      this.app.logger.info(`Handler executed, sending response for: ${message.command}`);

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

      this.app.logger.info(`Command ${message.command} completed in ${Date.now() - startTime}ms`);
    } catch (error) {
      this.app.logger.error(`Command ${message.command} failed: ${error.message}`);
      this.app.logger.error(error.stack);

      if (ws.readyState === 1) {
        ws.send(
          JSON.stringify({
            id: message.id, // Include request ID even in errors
            type: 'error',
            command: message.command,
            error: error.message,
            timestamp: Date.now()
          })
        );
      }
    }
  }
}

export default CommandRegistry;
