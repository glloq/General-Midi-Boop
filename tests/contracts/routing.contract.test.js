// tests/contracts/routing.contract.test.js
// Contract tests for critical routing commands.
// Contracts live in docs/refactor/contracts/routing/*.contract.json.
// See docs/refactor/contracts/README.md for the methodology.

import { jest, describe, test, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import CommandRegistry from '../../src/api/CommandRegistry.js';
import { register as registerRoutingCommands } from '../../src/api/commands/RoutingCommands.js';
import FileRoutingSyncService from '../../src/midi/domain/routing/FileRoutingSyncService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONTRACTS_DIR = join(__dirname, '../../docs/refactor/contracts/routing');

function loadContract(name) {
  const path = join(CONTRACTS_DIR, `${name}.contract.json`);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function createMockApp({
  routes = [],
  devices = [{ id: 'dev-1' }, { id: 'dev-2' }, { id: 'dev-out-1' }],
  fileChannels = [],
  existingRoutings = [],
  sendMessageResult = true
} = {}) {
  const routeMap = new Map(routes.map(r => [r.id, r]));
  let nextRouteId = 1;

  // Shared spies so existing `app.database.*` assertions keep working after
  // handlers migrated to `app.fileRepository.*` / `app.routingRepository.*` (P0-2.5b).
  const getRoutingsByFile = jest.fn().mockReturnValue(existingRoutings);
  const deleteRoutingsByFile = jest.fn();
  const insertRouting = jest.fn();
  const getFileChannels = jest.fn().mockReturnValue(fileChannels);

  const app = {
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    },
    midiRouter: {
      addRoute: jest.fn((data) => {
        const id = `route-${nextRouteId++}`;
        routeMap.set(id, { id, ...data });
        return id;
      }),
      deleteRoute: jest.fn((id) => routeMap.delete(id)),
      getRoute: jest.fn((id) => routeMap.get(id) || null),
      getRouteList: jest.fn(() => Array.from(routeMap.values())),
      enableRoute: jest.fn(),
      setFilter: jest.fn(),
      setChannelMap: jest.fn(),
      startMonitor: jest.fn(),
      stopMonitor: jest.fn(),
      startMonitorAll: jest.fn(),
      stopMonitorAll: jest.fn()
    },
    deviceManager: {
      getDeviceList: jest.fn().mockReturnValue(devices),
      sendMessage: jest.fn().mockReturnValue(sendMessageResult)
    },
    database: {
      getRoutingsByFile,
      deleteRoutingsByFile,
      insertRouting,
      getFileChannels
    },
    fileRepository: {
      getChannels: getFileChannels
    },
    routingRepository: {
      findByFileId: getRoutingsByFile,
      deleteByFileId: deleteRoutingsByFile,
      save: insertRouting
    }
  };

  // Wire the real FileRoutingSyncService over the spy-backed repositories
  // so the contract still exercises the genuine domain logic (P1-4.1).
  app.fileRoutingSyncService = new FileRoutingSyncService({
    routingRepository: app.routingRepository,
    fileRepository: app.fileRepository,
    deviceManager: app.deviceManager,
    logger: app.logger
  });

  return app;
}

function createMockWs() {
  const messages = [];
  return {
    readyState: 1,
    send: jest.fn((data) => messages.push(JSON.parse(data))),
    _messages: messages
  };
}

function buildRegistry(app) {
  const registry = new CommandRegistry(app);
  registerRoutingCommands(registry, app);
  return registry;
}

describe('Contract: route_create', () => {
  const contract = loadContract('route_create');

  test('contract metadata is well-formed', () => {
    expect(contract.command).toBe('route_create');
    expect(contract.cases.length).toBeGreaterThanOrEqual(3);
  });

  test('nominal — creates route and returns routeId', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle(
      { id: 'req-1', command: 'route_create', data: { source: 'dev-in-1', destination: 'dev-out-1' } },
      ws
    );

    const resp = ws._messages[0];
    expect(resp.type).toBe('response');
    expect(resp.command).toBe('route_create');
    expect(typeof resp.data.routeId).toBe('string');
    expect(app.midiRouter.addRoute).toHaveBeenCalledWith({
      source: 'dev-in-1',
      destination: 'dev-out-1'
    });
  });

  test('error — missing source is blocked by validator', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle(
      { id: 'req-2', command: 'route_create', data: { destination: 'dev-out-1' } },
      ws
    );

    const resp = ws._messages[0];
    expect(resp.type).toBe('error');
    expect(resp.code).toBe('ERR_VALIDATION');
    expect(resp.error).toBe('Invalid route_create data: source is required');
    expect(app.midiRouter.addRoute).not.toHaveBeenCalled();
  });

  test('error — missing destination is blocked by validator', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle(
      { id: 'req-3', command: 'route_create', data: { source: 'dev-in-1' } },
      ws
    );

    const resp = ws._messages[0];
    expect(resp.type).toBe('error');
    expect(resp.code).toBe('ERR_VALIDATION');
    expect(resp.error).toBe('Invalid route_create data: destination is required');
  });
});

describe('Contract: route_delete', () => {
  const contract = loadContract('route_delete');

  test('contract metadata is well-formed', () => {
    expect(contract.command).toBe('route_delete');
    expect(contract.cases.length).toBeGreaterThanOrEqual(2);
  });

  test('nominal — deletes route and returns success', async () => {
    const app = createMockApp({ routes: [{ id: 'route-123', source: 's', destination: 'd' }] });
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle(
      { id: 'req-1', command: 'route_delete', data: { routeId: 'route-123' } },
      ws
    );

    const resp = ws._messages[0];
    expect(resp.type).toBe('response');
    expect(resp.data).toEqual({ success: true });
    expect(app.midiRouter.deleteRoute).toHaveBeenCalledWith('route-123');
  });

  test('error — missing routeId is blocked by validator', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle({ id: 'req-2', command: 'route_delete', data: {} }, ws);

    const resp = ws._messages[0];
    expect(resp.type).toBe('error');
    expect(resp.code).toBe('ERR_VALIDATION');
    expect(resp.error).toBe('Invalid route_delete data: routeId is required');
    expect(app.midiRouter.deleteRoute).not.toHaveBeenCalled();
  });
});

describe('Contract: route_list', () => {
  const contract = loadContract('route_list');

  test('contract metadata is well-formed', () => {
    expect(contract.command).toBe('route_list');
    expect(contract.cases.length).toBeGreaterThanOrEqual(2);
  });

  test('nominal — empty list', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle({ id: 'req-1', command: 'route_list' }, ws);

    const resp = ws._messages[0];
    expect(resp.type).toBe('response');
    expect(resp.data).toEqual({ routes: [] });
  });

  test('nominal — returns registered routes', async () => {
    const app = createMockApp({
      routes: [
        { id: 'route-1', source: 'dev-in-1', destination: 'dev-out-1', enabled: true }
      ]
    });
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle({ id: 'req-2', command: 'route_list' }, ws);

    const resp = ws._messages[0];
    expect(resp.type).toBe('response');
    expect(resp.data.routes).toHaveLength(1);
    expect(resp.data.routes[0].id).toBe('route-1');
  });
});

describe('Contract: route_info', () => {
  const contract = loadContract('route_info');

  test('contract metadata is well-formed', () => {
    expect(contract.command).toBe('route_info');
    expect(contract.cases.length).toBeGreaterThanOrEqual(2);
  });

  test('nominal — returns route info', async () => {
    const route = { id: 'route-1', source: 'dev-in-1', destination: 'dev-out-1', enabled: true };
    const app = createMockApp({ routes: [route] });
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle(
      { id: 'req-1', command: 'route_info', data: { routeId: 'route-1' } },
      ws
    );

    const resp = ws._messages[0];
    expect(resp.type).toBe('response');
    expect(resp.data.route).toEqual(route);
  });

  test('error — unknown routeId returns ERR_NOT_FOUND', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle(
      { id: 'req-2', command: 'route_info', data: { routeId: 'ghost' } },
      ws
    );

    const resp = ws._messages[0];
    expect(resp.type).toBe('error');
    expect(resp.code).toBe('ERR_NOT_FOUND');
    expect(resp.error).toContain("Route with id 'ghost' not found");
  });
});

describe('Contract: route_enable', () => {
  const contract = loadContract('route_enable');

  test('contract metadata is well-formed', () => {
    expect(contract.command).toBe('route_enable');
    expect(contract.cases.length).toBeGreaterThanOrEqual(3);
  });

  test('nominal — enable route', async () => {
    const app = createMockApp({ routes: [{ id: 'route-1' }] });
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle(
      { id: 'req-1', command: 'route_enable', data: { routeId: 'route-1', enabled: true } },
      ws
    );

    const resp = ws._messages[0];
    expect(resp.type).toBe('response');
    expect(resp.data).toEqual({ success: true });
    expect(app.midiRouter.enableRoute).toHaveBeenCalledWith('route-1', true);
  });

  test('nominal — disable route', async () => {
    const app = createMockApp({ routes: [{ id: 'route-1' }] });
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle(
      { id: 'req-2', command: 'route_enable', data: { routeId: 'route-1', enabled: false } },
      ws
    );

    const resp = ws._messages[0];
    expect(resp.type).toBe('response');
    expect(resp.data).toEqual({ success: true });
    expect(app.midiRouter.enableRoute).toHaveBeenCalledWith('route-1', false);
  });

  test('error — missing routeId is blocked by validator', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle(
      { id: 'req-3', command: 'route_enable', data: { enabled: true } },
      ws
    );

    const resp = ws._messages[0];
    expect(resp.type).toBe('error');
    expect(resp.code).toBe('ERR_VALIDATION');
    expect(resp.error).toBe('Invalid route_enable data: routeId is required');
    expect(app.midiRouter.enableRoute).not.toHaveBeenCalled();
  });
});

describe('Contract: route_test', () => {
  const contract = loadContract('route_test');

  test('contract metadata is well-formed', () => {
    expect(contract.command).toBe('route_test');
    expect(contract.cases.length).toBeGreaterThanOrEqual(3);
  });

  test('nominal — test note sent (defaults)', async () => {
    jest.useFakeTimers();
    const route = { id: 'route-1', source: 'dev-in-1', destination: 'dev-out-1' };
    const app = createMockApp({ routes: [route] });
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle(
      { id: 'req-1', command: 'route_test', data: { routeId: 'route-1' } },
      ws
    );

    const resp = ws._messages[0];
    expect(resp.type).toBe('response');
    expect(resp.data).toEqual({
      success: true,
      destination: 'dev-out-1',
      note: 60,
      channel: 0
    });
    expect(app.deviceManager.sendMessage).toHaveBeenCalledWith(
      'dev-out-1',
      'noteon',
      { channel: 0, note: 60, velocity: 80 }
    );
    jest.useRealTimers();
  });

  test('error — unknown route returns ERR_NOT_FOUND', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle(
      { id: 'req-2', command: 'route_test', data: { routeId: 'ghost' } },
      ws
    );

    const resp = ws._messages[0];
    expect(resp.type).toBe('error');
    expect(resp.code).toBe('ERR_NOT_FOUND');
    expect(app.deviceManager.sendMessage).not.toHaveBeenCalled();
  });

  test('edge — device send failed returns success=false', async () => {
    const route = { id: 'route-1', destination: 'dev-out-1' };
    const app = createMockApp({ routes: [route], sendMessageResult: false });
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle(
      { id: 'req-3', command: 'route_test', data: { routeId: 'route-1' } },
      ws
    );

    const resp = ws._messages[0];
    expect(resp.type).toBe('response');
    expect(resp.data.success).toBe(false);
    expect(resp.data.error).toBe('Failed to send test note to device');
  });
});

describe('Contract: file_routing_sync', () => {
  const contract = loadContract('file_routing_sync');

  test('contract metadata is well-formed', () => {
    expect(contract.command).toBe('file_routing_sync');
    expect(contract.cases.length).toBeGreaterThanOrEqual(4);
  });

  test('nominal — empty channels clears all routings for file', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle(
      { id: 'req-1', command: 'file_routing_sync', data: { fileId: 42, channels: {} } },
      ws
    );

    const resp = ws._messages[0];
    expect(resp.type).toBe('response');
    expect(resp.data).toEqual({ success: true, synced: 0, invalidDevices: [] });
    expect(app.database.deleteRoutingsByFile).toHaveBeenCalledWith(42);
    expect(app.database.insertRouting).not.toHaveBeenCalled();
  });

  test('nominal — sync channels with known devices', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle(
      {
        id: 'req-2',
        command: 'file_routing_sync',
        data: { fileId: 42, channels: { '0': 'dev-1', '1': 'dev-2::5' } }
      },
      ws
    );

    const resp = ws._messages[0];
    expect(resp.type).toBe('response');
    expect(resp.data.success).toBe(true);
    expect(resp.data.synced).toBe(2);
    expect(resp.data.invalidDevices).toEqual([]);
    expect(app.database.insertRouting).toHaveBeenCalledTimes(2);
    // Verify target_channel parsing from "dev-2::5"
    const secondCall = app.database.insertRouting.mock.calls[1][0];
    expect(secondCall.device_id).toBe('dev-2');
    expect(secondCall.target_channel).toBe(5);
  });

  test('nominal — invalid device IDs are filtered out', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle(
      {
        id: 'req-3',
        command: 'file_routing_sync',
        data: { fileId: 42, channels: { '0': 'unknown-dev', '1': 'dev-2' } }
      },
      ws
    );

    const resp = ws._messages[0];
    expect(resp.type).toBe('response');
    expect(resp.data.synced).toBe(1);
    expect(resp.data.invalidDevices).toEqual(['unknown-dev']);
  });

  test('nominal — virtual-instrument is always allowed', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle(
      {
        id: 'req-4',
        command: 'file_routing_sync',
        data: { fileId: 42, channels: { '0': 'virtual-instrument' } }
      },
      ws
    );

    const resp = ws._messages[0];
    expect(resp.type).toBe('response');
    expect(resp.data.synced).toBe(1);
    expect(resp.data.invalidDevices).toEqual([]);
  });

  test('error — missing fileId', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle(
      { id: 'req-5', command: 'file_routing_sync', data: { channels: {} } },
      ws
    );

    const resp = ws._messages[0];
    expect(resp.type).toBe('error');
    expect(resp.code).toBe('ERR_VALIDATION');
    expect(resp.error).toBe('fileId is required');
  });
});

describe('Contract: file_routing_bulk_sync', () => {
  const contract = loadContract('file_routing_bulk_sync');

  test('contract metadata is well-formed', () => {
    expect(contract.command).toBe('file_routing_bulk_sync');
    expect(contract.cases.length).toBeGreaterThanOrEqual(3);
  });

  test('nominal — empty input returns zero counts', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle({ id: 'req-1', command: 'file_routing_bulk_sync', data: {} }, ws);

    const resp = ws._messages[0];
    expect(resp.type).toBe('response');
    expect(resp.data).toEqual({
      success: true,
      synced: 0,
      files: 0,
      invalidDevices: []
    });
  });

  test('nominal — non-object routings field returns zero counts', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle(
      { id: 'req-2', command: 'file_routing_bulk_sync', data: { routings: 'invalid' } },
      ws
    );

    const resp = ws._messages[0];
    expect(resp.type).toBe('response');
    expect(resp.data.synced).toBe(0);
    expect(resp.data.files).toBe(0);
  });

  test('nominal — sync multiple files', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle(
      {
        id: 'req-3',
        command: 'file_routing_bulk_sync',
        data: {
          routings: {
            '1': { channels: { '0': 'dev-1', '1': 'dev-2' } },
            '2': { channels: { '0': 'dev-1' } }
          }
        }
      },
      ws
    );

    const resp = ws._messages[0];
    expect(resp.type).toBe('response');
    expect(resp.data.success).toBe(true);
    expect(resp.data.synced).toBe(3);
    expect(resp.data.files).toBe(2);
    expect(resp.data.invalidDevices).toEqual([]);
  });

  test('nominal — files with no channels are skipped', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle(
      {
        id: 'req-4',
        command: 'file_routing_bulk_sync',
        data: {
          routings: {
            '1': { channels: {} },
            '2': { channels: { '0': 'dev-1' } }
          }
        }
      },
      ws
    );

    const resp = ws._messages[0];
    expect(resp.type).toBe('response');
    expect(resp.data.synced).toBe(1);
    expect(resp.data.files).toBe(1);
  });
});
