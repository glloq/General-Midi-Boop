/**
 * @file src/api/CommandHandler.js
 * @description Thin façade in front of {@link CommandRegistry}. Owns the
 * single-shot async initialisation that auto-discovers every command
 * module under `commands/`, and gates incoming messages on that init
 * promise so requests received during boot are queued instead of dropped.
 *
 * Registered in the DI container as `commandHandler`; consumed by
 * {@link WebSocketServer} for every WS frame.
 */
import CommandRegistry from './CommandRegistry.js';

/**
 * Façade around {@link CommandRegistry}.
 */
class CommandHandler {
  /**
   * @param {Object} deps - Resolved dependency bag (typically the
   *   Application facade — needs at least `logger`).
   */
  constructor(deps) {
    this.logger = deps.logger;
    this.registry = new CommandRegistry(deps);
    /**
     * Promise resolved once every command module has been loaded.
     * `handle()` awaits this so requests cannot reach an unbuilt registry.
     * @type {Promise<void>}
     */
    this._ready = this._init();
  }

  /**
   * Internal one-shot bootstrap. Loads every command module from the
   * `commands/` directory and logs the resulting handler count.
   *
   * @returns {Promise<void>}
   * @private
   */
  async _init() {
    await this.registry.loadCommandModules();
    this.logger.info(`CommandHandler initialized with ${Object.keys(this.registry.handlers).length} commands`);
  }

  /**
   * Dispatch an inbound WebSocket message to its registered handler.
   * Awaits {@link CommandHandler#_ready} so calls that arrive during boot
   * still resolve once initialisation completes.
   *
   * @param {Object} message - Parsed WebSocket frame
   *   (`{id, command, version?, data?}`).
   * @param {import('ws').WebSocket} ws - Originating socket; used by the
   *   registry to send the response back.
   * @returns {Promise<void>}
   */
  async handle(message, ws) {
    await this._ready;
    return this.registry.handle(message, ws);
  }
}

export default CommandHandler;
