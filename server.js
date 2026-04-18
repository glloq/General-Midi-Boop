/**
 * @file server.js
 * @description Process entry point for MidiMind 5.0.
 *
 * Boots an {@link Application} instance, wires graceful shutdown handlers,
 * starts the HTTP/WebSocket servers and prints a one-shot status summary.
 * Any failure during initialization or start causes the process to exit
 * with code 1 so that PM2 / systemd can restart it.
 */
import Application from './src/core/Application.js';

/**
 * Bootstrap routine. Constructs the {@link Application}, initializes all
 * registered services, installs OS signal handlers, starts the network
 * servers, then logs a snapshot of runtime status. Errors thrown anywhere
 * in the boot chain are logged and the process exits with code 1.
 *
 * @returns {Promise<void>} Resolves once startup is complete (the process
 *   keeps running afterwards thanks to the open HTTP/WebSocket listeners).
 */
async function main() {
  const app = new Application();

  try {
    await app.initialize();

    // Install SIGINT/SIGTERM/uncaught handlers BEFORE start() so that a crash
    // during start() still triggers a clean shutdown via stop().
    app.setupShutdownHandlers();

    await app.start();

    // One-shot startup banner — values are point-in-time, not live counters.
    const status = app.getStatus();
    console.log('\n=== Application Status ===');
    console.log(`Devices: ${status.devices}`);
    console.log(`Routes: ${status.routes}`);
    console.log(`Files: ${status.files}`);
    console.log(`WebSocket Clients: ${status.wsClients}`);
    console.log('==========================\n');

  } catch (error) {
    console.error('Failed to start application:', error);
    process.exit(1);
  }
}

main();
