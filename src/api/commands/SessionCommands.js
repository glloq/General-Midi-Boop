// src/api/commands/SessionCommands.js
import { NotFoundError } from '../../core/errors/index.js';

async function sessionSave(app, data) {
  const sessionData = {
    devices: app.deviceManager.getDeviceList(),
    routes: app.midiRouter.getRouteList(),
    player: app.midiPlayer.getStatus()
  };

  const sessionId = app.database.insertSession({
    name: data.name,
    description: data.description,
    data: JSON.stringify(sessionData)
  });

  return { sessionId: sessionId };
}

async function sessionLoad(app, data) {
  const session = app.database.getSession(data.sessionId);
  if (!session) {
    throw new NotFoundError('Session', data.sessionId);
  }

  JSON.parse(session.data); // parsed for validation; apply in future implementation

  return { success: true, session: session };
}

async function sessionList(app) {
  const sessions = app.database.getSessions();
  return { sessions: sessions };
}

async function sessionDelete(app, data) {
  app.database.deleteSession(data.sessionId);
  return { success: true };
}

async function sessionExport(app, data) {
  const session = app.database.getSession(data.sessionId);
  if (!session) {
    throw new NotFoundError('Session', data.sessionId);
  }
  return { session: session };
}

async function sessionImport(app, data) {
  const sessionId = app.database.insertSession({
    name: data.name,
    description: data.description,
    data: data.data
  });
  return { sessionId: sessionId };
}

export function register(registry, app) {
  registry.register('session_save', (data) => sessionSave(app, data));
  registry.register('session_load', (data) => sessionLoad(app, data));
  registry.register('session_list', () => sessionList(app));
  registry.register('session_delete', (data) => sessionDelete(app, data));
  registry.register('session_export', (data) => sessionExport(app, data));
  registry.register('session_import', (data) => sessionImport(app, data));
}
