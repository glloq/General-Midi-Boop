// tests/contracts/playback.contract.test.js
// Contract tests for the 5 most-used playback commands.
// Contracts live in docs/refactor/contracts/playback/*.contract.json.
// See docs/refactor/contracts/README.md for the methodology.

import { jest, describe, test, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import CommandRegistry from '../../src/api/CommandRegistry.js';
import { register as registerPlaybackCommands } from '../../src/api/commands/PlaybackCommands.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONTRACTS_DIR = join(__dirname, '../../docs/refactor/contracts/playback');

function loadContract(name) {
  const path = join(CONTRACTS_DIR, `${name}.contract.json`);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function createMockApp({ deviceList = [{ id: 'out-1', output: true, enabled: true }], routings = [], fileLoadResult } = {}) {
  const defaultFileLoadResult = {
    filename: 'test.mid',
    duration: 120,
    tracks: 3,
    events: 42,
    tempo: 120,
    channels: []
  };
  return {
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    },
    midiPlayer: {
      loadFile: jest.fn().mockResolvedValue(fileLoadResult ?? defaultFileLoadResult),
      clearChannelRouting: jest.fn(),
      setChannelRouting: jest.fn(),
      setChannelSplitRouting: jest.fn(),
      start: jest.fn(),
      stop: jest.fn(),
      pause: jest.fn(),
      resume: jest.fn(),
      seek: jest.fn(),
      setLoop: jest.fn(),
      getStatus: jest.fn().mockReturnValue({
        playing: false,
        paused: false,
        position: 0,
        duration: 0,
        percentage: 0,
        outputDevice: null,
        loop: false,
        tempo: 120,
        events: 0
      }),
      getChannelRouting: jest.fn().mockReturnValue([])
    },
    database: {
      getRoutingsByFile: jest.fn().mockReturnValue(routings)
    },
    fileRepository: {
      findById: jest.fn().mockReturnValue(null)
    },
    routingRepository: {
      findByFileId: jest.fn().mockReturnValue(routings)
    },
    deviceManager: {
      getDeviceList: jest.fn().mockReturnValue(deviceList)
    }
  };
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
  registerPlaybackCommands(registry, app);
  return registry;
}

function assertShape(actual, shape) {
  if (shape === undefined) return;
  for (const [key, expectedType] of Object.entries(shape)) {
    expect(actual).toHaveProperty(key);
    if (expectedType === 'any') continue;
    if (typeof expectedType === 'object' && expectedType !== null) {
      assertShape(actual[key], expectedType);
      continue;
    }
    const types = String(expectedType).split('|');
    const value = actual[key];
    const actualType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    expect(types).toContain(actualType);
  }
}

describe('Contract: playback_start', () => {
  const contract = loadContract('playback_start');

  test('contract metadata is well-formed', () => {
    expect(contract.command).toBe('playback_start');
    expect(Array.isArray(contract.cases)).toBe(true);
    expect(contract.cases.length).toBeGreaterThanOrEqual(2);
  });

  test('nominal — start with fileId and explicit outputDevice', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle(
      { id: 'req-1', command: 'playback_start', data: { fileId: 'file-001', outputDevice: 'out-1' } },
      ws
    );

    expect(ws._messages).toHaveLength(1);
    const resp = ws._messages[0];
    expect(resp.type).toBe('response');
    expect(resp.command).toBe('playback_start');
    expect(resp.data.success).toBe(true);
    expect(resp.data.outputDevice).toBe('out-1');
    expect(resp.data.loadedRoutings).toBe(0);
    expect(resp.data.fileInfo).toBeDefined();
    assertShape(resp.data, contract.cases[0].output_shape.data);

    expect(app.midiPlayer.loadFile).toHaveBeenCalledWith('file-001');
    expect(app.midiPlayer.start).toHaveBeenCalledWith('out-1');
  });

  test('nominal — start without outputDevice uses first enabled output', async () => {
    const app = createMockApp({
      deviceList: [{ id: 'out-default', output: true, enabled: true }]
    });
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle(
      { id: 'req-2', command: 'playback_start', data: { fileId: 'file-001' } },
      ws
    );

    const resp = ws._messages[0];
    expect(resp.type).toBe('response');
    expect(resp.data.outputDevice).toBe('out-default');
    expect(app.midiPlayer.start).toHaveBeenCalledWith('out-default');
  });

  test('error — missing both fileId and outputDevice is blocked by validator', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle({ id: 'req-3', command: 'playback_start', data: {} }, ws);

    const resp = ws._messages[0];
    expect(resp.type).toBe('error');
    expect(resp.code).toBe('ERR_VALIDATION');
    expect(resp.error).toBe('Invalid playback_start data: fileId or outputDevice is required');
    expect(app.midiPlayer.loadFile).not.toHaveBeenCalled();
  });

  test('error — missing fileId with outputDevice provided is blocked by handler', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle(
      { id: 'req-3b', command: 'playback_start', data: { outputDevice: 'out-1' } },
      ws
    );

    const resp = ws._messages[0];
    expect(resp.type).toBe('error');
    expect(resp.code).toBe('ERR_VALIDATION');
    expect(resp.error).toBe('fileId is required');
  });

  test('error — no output devices available returns ERR_CONFIGURATION', async () => {
    const app = createMockApp({ deviceList: [] });
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle(
      { id: 'req-4', command: 'playback_start', data: { fileId: 'file-001' } },
      ws
    );

    const resp = ws._messages[0];
    expect(resp.type).toBe('error');
    expect(resp.code).toBe('ERR_CONFIGURATION');
    expect(resp.error).toBe('No output devices available');
    expect(app.midiPlayer.start).not.toHaveBeenCalled();
  });
});

describe('Contract: playback_stop', () => {
  const contract = loadContract('playback_stop');

  test('contract metadata is well-formed', () => {
    expect(contract.command).toBe('playback_stop');
    expect(contract.cases.length).toBeGreaterThanOrEqual(1);
  });

  test('nominal — stop playback returns { success: true }', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle({ id: 'req-1', command: 'playback_stop' }, ws);

    const resp = ws._messages[0];
    expect(resp.type).toBe('response');
    expect(resp.command).toBe('playback_stop');
    expect(resp.data).toEqual({ success: true });
    expect(app.midiPlayer.stop).toHaveBeenCalledTimes(1);
  });
});

describe('Contract: playback_seek', () => {
  const contract = loadContract('playback_seek');

  test('contract metadata is well-formed', () => {
    expect(contract.command).toBe('playback_seek');
    expect(contract.cases.length).toBeGreaterThanOrEqual(2);
  });

  test('nominal — seek to position forwards to midiPlayer.seek', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle(
      { id: 'req-1', command: 'playback_seek', data: { position: 42.5 } },
      ws
    );

    const resp = ws._messages[0];
    expect(resp.type).toBe('response');
    expect(resp.data).toEqual({ success: true });
    expect(app.midiPlayer.seek).toHaveBeenCalledWith(42.5);
  });

  test('nominal — seek to position 0 is allowed', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle(
      { id: 'req-2', command: 'playback_seek', data: { position: 0 } },
      ws
    );

    const resp = ws._messages[0];
    expect(resp.type).toBe('response');
    expect(resp.data).toEqual({ success: true });
    expect(app.midiPlayer.seek).toHaveBeenCalledWith(0);
  });

  test('error — missing position is blocked by validator (two joined errors)', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle({ id: 'req-3', command: 'playback_seek', data: {} }, ws);

    const resp = ws._messages[0];
    expect(resp.type).toBe('error');
    expect(resp.code).toBe('ERR_VALIDATION');
    expect(resp.error).toBe(
      'Invalid playback_seek data: position is required, position must be a positive number'
    );
    expect(app.midiPlayer.seek).not.toHaveBeenCalled();
  });

  test('error — negative position is blocked by validator', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle(
      { id: 'req-4', command: 'playback_seek', data: { position: -5 } },
      ws
    );

    const resp = ws._messages[0];
    expect(resp.type).toBe('error');
    expect(resp.code).toBe('ERR_VALIDATION');
    expect(resp.error).toBe(
      'Invalid playback_seek data: position must be a positive number'
    );
    expect(app.midiPlayer.seek).not.toHaveBeenCalled();
  });
});

describe('Contract: playback_status', () => {
  const contract = loadContract('playback_status');

  test('contract metadata is well-formed', () => {
    expect(contract.command).toBe('playback_status');
    expect(contract.cases.length).toBeGreaterThanOrEqual(2);
  });

  test('nominal — status idle returns the object from midiPlayer.getStatus() as-is', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle({ id: 'req-1', command: 'playback_status' }, ws);

    const resp = ws._messages[0];
    expect(resp.type).toBe('response');
    assertShape(resp.data, contract.cases[0].output_shape.data);
    expect(resp.data.playing).toBe(false);
    expect(resp.data.paused).toBe(false);
    expect(resp.data.tempo).toBe(120);
  });

  test('nominal — status while playing reflects getStatus() live values', async () => {
    const app = createMockApp();
    app.midiPlayer.getStatus.mockReturnValue({
      playing: true,
      paused: false,
      position: 30,
      duration: 120,
      percentage: 25,
      outputDevice: 'out-1',
      loop: false,
      tempo: 120,
      events: 42
    });
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle({ id: 'req-2', command: 'playback_status' }, ws);

    const resp = ws._messages[0];
    expect(resp.type).toBe('response');
    expect(resp.data.playing).toBe(true);
    expect(resp.data.position).toBe(30);
    expect(resp.data.percentage).toBe(25);
    expect(resp.data.outputDevice).toBe('out-1');
    assertShape(resp.data, contract.cases[1].output_shape.data);
  });
});

describe('Contract: playback_set_loop', () => {
  const contract = loadContract('playback_set_loop');

  test('contract metadata is well-formed', () => {
    expect(contract.command).toBe('playback_set_loop');
    expect(contract.cases.length).toBeGreaterThanOrEqual(2);
  });

  test('nominal — enable loop forwards to midiPlayer.setLoop(true)', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle(
      { id: 'req-1', command: 'playback_set_loop', data: { enabled: true } },
      ws
    );

    const resp = ws._messages[0];
    expect(resp.type).toBe('response');
    expect(resp.data).toEqual({ success: true });
    expect(app.midiPlayer.setLoop).toHaveBeenCalledWith(true);
  });

  test('nominal — disable loop forwards to midiPlayer.setLoop(false)', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle(
      { id: 'req-2', command: 'playback_set_loop', data: { enabled: false } },
      ws
    );

    const resp = ws._messages[0];
    expect(resp.type).toBe('response');
    expect(resp.data).toEqual({ success: true });
    expect(app.midiPlayer.setLoop).toHaveBeenCalledWith(false);
  });

  test('error — missing enabled is blocked by validator (two joined errors)', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle({ id: 'req-3', command: 'playback_set_loop', data: {} }, ws);

    const resp = ws._messages[0];
    expect(resp.type).toBe('error');
    expect(resp.code).toBe('ERR_VALIDATION');
    expect(resp.error).toBe(
      'Invalid playback_set_loop data: enabled is required, enabled must be a boolean'
    );
    expect(app.midiPlayer.setLoop).not.toHaveBeenCalled();
  });

  test('error — non-boolean enabled is blocked by validator', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();

    await registry.handle(
      { id: 'req-4', command: 'playback_set_loop', data: { enabled: 'true' } },
      ws
    );

    const resp = ws._messages[0];
    expect(resp.type).toBe('error');
    expect(resp.code).toBe('ERR_VALIDATION');
    expect(resp.error).toBe(
      'Invalid playback_set_loop data: enabled must be a boolean'
    );
    expect(app.midiPlayer.setLoop).not.toHaveBeenCalled();
  });
});
