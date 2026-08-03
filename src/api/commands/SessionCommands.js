/**
 * @file src/api/commands/SessionCommands.js
 * @description WebSocket commands for "session" snapshots — a frozen
 * combination of device list, routing table and player state. Saved
 * sessions can later be exported / imported as JSON.
 *
 * Registered commands:
 *   - `session_save` / `_load` / `_list` / `_delete`
 *   - `session_export` / `_import`
 *
 * `session_load` replaces the current routing table with the one
 * captured in the snapshot. Routes whose source or destination device
 * is no longer connected are skipped and reported in `warnings` rather
 * than failing the whole restore — the user can plug the device back
 * in and re-run. Player state is intentionally not restored (resuming
 * mid-playback from a stale position is riskier than asking the user
 * to hit play again); the saved player snapshot is still echoed back.
 */
import { NotFoundError, ValidationError } from '../../core/errors/index.js';

/**
 * Capture a snapshot of the live system state and persist it.
 *
 * @param {Object} app
 * @param {{name:string, description?:string}} data
 * @returns {Promise<{sessionId:(string|number)}>}
 */
async function sessionSave(app, data) {
  const sessionData = {
    devices: app.deviceManager.getDeviceList(),
    routes: app.midiRouter.getRouteList(),
    player: app.midiPlayer.getStatus()
  };

  const sessionId = app.sessionRepository.save({
    name: data.name,
    description: data.description,
    data: JSON.stringify(sessionData)
  });

  return { sessionId: sessionId };
}

/**
 * Load a previously saved session and restore its routing table.
 *
 * When `dryRun: true`, no mutation happens — the handler returns the
 * summary so the UI can preview "what would be restored" before
 * committing. Without `dryRun`, the player is stopped (to avoid stuck
 * notes while the route table is rebuilt), every existing route is
 * deleted, then the saved routes are re-added. Routes whose source or
 * destination device is absent from the live DeviceManager are skipped
 * and listed in `warnings`.
 *
 * @param {Object} app
 * @param {{sessionId:(string|number), dryRun?:boolean}} data
 * @returns {Promise<{
 *   success: true,
 *   session: Object,
 *   routesRestored: number,
 *   routesSkipped: number,
 *   warnings: string[],
 *   dryRun: boolean
 * }>}
 * @throws {NotFoundError|ValidationError}
 */
async function sessionLoad(app, data) {
  const session = app.sessionRepository.findById(data.sessionId);
  if (!session) {
    throw new NotFoundError('Session', data.sessionId);
  }

  let parsed;
  try {
    parsed = JSON.parse(session.data);
  } catch (err) {
    throw new ValidationError(
      `Session ${data.sessionId} contains invalid JSON: ${err.message}`,
      'data'
    );
  }

  const savedRoutes = Array.isArray(parsed?.routes) ? parsed.routes : [];
  const dryRun = data.dryRun === true;
  const warnings = [];

  // Build a set of connected-device ids so routes pointing at
  // disappeared hardware can be skipped gracefully.
  const connected = new Set();
  try {
    const list = app.deviceManager?.getDeviceList?.() || [];
    for (const d of list) if (d.id) connected.add(d.id);
  } catch (err) {
    app.logger.warn(`[sessionLoad] device list unavailable: ${err.message}`);
  }

  // Pre-scan: count what would be restored vs skipped without mutating.
  let wouldRestore = 0;
  let wouldSkip = 0;
  for (const r of savedRoutes) {
    const srcOk = connected.size === 0 || connected.has(r.source);
    const dstOk = connected.size === 0 || connected.has(r.destination);
    if (srcOk && dstOk) {
      wouldRestore++;
    } else {
      wouldSkip++;
      const missing = [];
      if (!srcOk) missing.push(`source "${r.source}"`);
      if (!dstOk) missing.push(`destination "${r.destination}"`);
      warnings.push(`Route ${r.id || '(unnamed)'} skipped: ${missing.join(' and ')} not connected`);
    }
  }

  if (dryRun) {
    return {
      success: true,
      session,
      routesRestored: wouldRestore,
      routesSkipped: wouldSkip,
      warnings,
      dryRun: true
    };
  }

  // Stop playback first so tearing down routes cannot leave stuck notes
  // on whichever device was receiving the in-flight stream.
  try {
    if (app.midiPlayer?.playing) app.midiPlayer.stop();
  } catch (err) {
    app.logger.warn(`[sessionLoad] player stop failed: ${err.message}`);
  }

  // Clear current routes.
  const existing = app.midiRouter.getRouteList();
  for (const r of existing) {
    try {
      app.midiRouter.deleteRoute(r.id);
    } catch (err) {
      app.logger.warn(`[sessionLoad] failed to delete route ${r.id}: ${err.message}`);
    }
  }

  // Re-add saved routes that are still viable.
  let restored = 0;
  for (const r of savedRoutes) {
    const srcOk = connected.size === 0 || connected.has(r.source);
    const dstOk = connected.size === 0 || connected.has(r.destination);
    if (!srcOk || !dstOk) continue;

    try {
      app.midiRouter.addRoute({
        source: r.source,
        destination: r.destination,
        channelMap: r.channelMap || {},
        filter: r.filter || {},
        enabled: r.enabled !== false
      });
      restored++;
    } catch (err) {
      warnings.push(`Route ${r.id || '(unnamed)'} insert failed: ${err.message}`);
    }
  }

  app.logger.info(
    `[sessionLoad] restored ${restored}/${savedRoutes.length} routes (skipped ${wouldSkip})`
  );

  return {
    success: true,
    session,
    routesRestored: restored,
    routesSkipped: wouldSkip,
    warnings,
    dryRun: false
  };
}

/**
 * @param {Object} app
 * @returns {Promise<{sessions:Object[]}>}
 */
async function sessionList(app) {
  const sessions = app.sessionRepository.findAll();
  return { sessions: sessions };
}

/**
 * @param {Object} app
 * @param {{sessionId:(string|number)}} data
 * @returns {Promise<{success:true}>}
 */
async function sessionDelete(app, data) {
  app.sessionRepository.delete(data.sessionId);
  return { success: true };
}

/**
 * @param {Object} app
 * @param {{sessionId:(string|number)}} data
 * @returns {Promise<{session:Object}>}
 * @throws {NotFoundError}
 */
async function sessionExport(app, data) {
  const session = app.sessionRepository.findById(data.sessionId);
  if (!session) {
    throw new NotFoundError('Session', data.sessionId);
  }
  return { session: session };
}

/**
 * Persist a session record received from the client (no validation of
 * the embedded `data` payload).
 *
 * @param {Object} app
 * @param {{name:string, description?:string, data:string}} data
 * @returns {Promise<{sessionId:(string|number)}>}
 */
async function sessionImport(app, data) {
  const sessionId = app.sessionRepository.save({
    name: data.name,
    description: data.description,
    data: data.data
  });
  return { sessionId: sessionId };
}

/**
 * @param {import('../CommandRegistry.js').default} registry
 * @param {Object} app
 * @returns {void}
 */
export function register(registry, app) {
  registry.register('session_save', (data) => sessionSave(app, data));
  registry.register('session_load', (data) => sessionLoad(app, data));
  registry.register('session_list', () => sessionList(app));
  registry.register('session_delete', (data) => sessionDelete(app, data));
  registry.register('session_export', (data) => sessionExport(app, data));
  registry.register('session_import', (data) => sessionImport(app, data));
}
