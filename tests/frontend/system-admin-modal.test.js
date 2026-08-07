// tests/frontend/system-admin-modal.test.js
// Verifies the SystemAdminModal wires the previously-orphaned system_* (T2.6)
// and session_* (T2.7) commands, and gates destructive actions behind confirm.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const baseModalSrc = readFileSync(resolve(__dirname, '../../public/js/core/BaseModal.js'), 'utf8');
const adminSrc = readFileSync(
  resolve(__dirname, '../../public/js/features/SystemAdminModal.js'),
  'utf8'
);

function loadModules() {
  new Function(baseModalSrc)(); // sets window.BaseModal
  new Function(adminSrc)(); // sets window.SystemAdminModal
}

function makeApi(resp) {
  return { sendCommand: vi.fn(() => Promise.resolve(resp === undefined ? { ok: true } : resp)) };
}

beforeEach(() => {
  document.body.innerHTML = '';
  delete window.BaseModal;
  delete window.SystemAdminModal;
  delete window.i18n;
  global.requestAnimationFrame = (cb) => cb();
  window.requestAnimationFrame = global.requestAnimationFrame;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SystemAdminModal — rendering & reachability', () => {
  it('renders system and session controls when opened', () => {
    loadModules();
    const modal = new window.SystemAdminModal(makeApi());
    modal.open();
    expect(document.getElementById('sam-status')).not.toBeNull();
    expect(document.getElementById('sam-reboot')).not.toBeNull();
    expect(document.getElementById('sam-session-save')).not.toBeNull();
    expect(document.getElementById('sam-result')).not.toBeNull();
  });
});

describe('SystemAdminModal — system commands (T2.6)', () => {
  it('dispatches a non-destructive command directly on click', () => {
    const api = makeApi({ uptime: 42 });
    loadModules();
    const modal = new window.SystemAdminModal(api);
    modal.open();
    document.getElementById('sam-status').click();
    expect(api.sendCommand).toHaveBeenCalledWith('system_status', {});
  });

  it('requests logs with a line count', () => {
    const api = makeApi();
    loadModules();
    const modal = new window.SystemAdminModal(api);
    modal.open();
    document.getElementById('sam-logs').click();
    expect(api.sendCommand).toHaveBeenCalledWith('system_logs', { lines: 200 });
  });

  it('does NOT fire a destructive command when the confirm is declined', () => {
    const api = makeApi();
    window.confirm = vi.fn(() => false);
    loadModules();
    const modal = new window.SystemAdminModal(api);
    modal.open();
    document.getElementById('sam-reboot').click();
    expect(window.confirm).toHaveBeenCalled();
    expect(api.sendCommand).not.toHaveBeenCalled();
  });

  it('fires a destructive command once the confirm is accepted', () => {
    const api = makeApi();
    window.confirm = vi.fn(() => true);
    loadModules();
    const modal = new window.SystemAdminModal(api);
    modal.open();
    document.getElementById('sam-shutdown').click();
    expect(api.sendCommand).toHaveBeenCalledWith('system_shutdown', {});
  });

  it('restore requires a path before firing', () => {
    const api = makeApi();
    window.confirm = vi.fn(() => true);
    loadModules();
    const modal = new window.SystemAdminModal(api);
    modal.open();
    // No path entered → no command, a hint is shown instead.
    document.getElementById('sam-restore').click();
    expect(api.sendCommand).not.toHaveBeenCalled();
    // With a path → restore fires (after confirm).
    document.getElementById('sam-restore-path').value = '/backups/x.db';
    document.getElementById('sam-restore').click();
    expect(api.sendCommand).toHaveBeenCalledWith('system_restore', { path: '/backups/x.db' });
  });
});

describe('SystemAdminModal — session commands (T2.7)', () => {
  it('saves a session with the entered name', () => {
    const api = makeApi();
    loadModules();
    const modal = new window.SystemAdminModal(api);
    modal.open();
    document.getElementById('sam-session-name').value = 'my-set';
    document.getElementById('sam-session-save').click();
    expect(api.sendCommand).toHaveBeenCalledWith('session_save', { name: 'my-set' });
  });

  it('lists sessions and wires per-row load', async () => {
    const api = makeApi({ sessions: [{ id: 7, name: 'Gig' }] });
    loadModules();
    const modal = new window.SystemAdminModal(api);
    modal.open();
    await modal._refreshSessions();
    expect(api.sendCommand).toHaveBeenCalledWith('session_list', {});
    const loadBtn = document.querySelector('[data-sam-load="7"]');
    expect(loadBtn).not.toBeNull();
    loadBtn.click();
    expect(api.sendCommand).toHaveBeenCalledWith('session_load', { sessionId: 7 });
  });

  it('deletes a session only after confirmation', async () => {
    const api = makeApi({ sessions: [{ id: 3, name: 'Old' }] });
    window.confirm = vi.fn(() => false);
    loadModules();
    const modal = new window.SystemAdminModal(api);
    modal.open();
    await modal._refreshSessions();
    api.sendCommand.mockClear();
    document.querySelector('[data-sam-delete="3"]').click();
    expect(api.sendCommand).not.toHaveBeenCalled(); // declined
  });
});
