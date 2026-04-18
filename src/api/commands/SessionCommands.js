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
 * TODO: `session_load` currently parses the payload but does not apply
 * it; finish the restore path so loading a session actually rebuilds
 * routes and re-arms the player.
 */
import { NotFoundError } from '../../core/errors/index.js';

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
 * Load a previously saved session.
 * FIXME: parses the JSON for validation but does not actually apply it
 * — devices/routes/player stay as-is. Wire to the restore path before
 * exposing this in the UI as anything other than "preview".
 *
 * @param {Object} app
 * @param {{sessionId:(string|number)}} data
 * @returns {Promise<{success:true, session:Object}>}
 * @throws {NotFoundError}
 */
async function sessionLoad(app, data) {
  const session = app.sessionRepository.findById(data.sessionId);
  if (!session) {
    throw new NotFoundError('Session', data.sessionId);
  }

  JSON.parse(session.data); // parsed for validation; apply in future implementation

  return { success: true, session: session };
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
