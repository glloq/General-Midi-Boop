// src/api/CommandHandler.js
// Thin wrapper that creates a CommandRegistry, loads all command modules, and delegates to it.
import CommandRegistry from './CommandRegistry.js';

class CommandHandler {
  constructor(app) {
    this.app = app;
    this.registry = new CommandRegistry(app);
    this._ready = this._init();
  }

  async _init() {
    await this.registry.loadCommandModules();
    this.app.logger.info(`CommandHandler initialized with ${Object.keys(this.registry.handlers).length} commands`);
  }

  async handle(message, ws) {
    await this._ready;
    return this.registry.handle(message, ws);
  }
}

export default CommandHandler;
