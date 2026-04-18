// tests/api/playback-repository-wiring.test.js
// Verifies that playback read-only handlers go through FileRepository /
// RoutingRepository instead of app.database.* (P0-2.5a).
// Behavior-neutral check: the same data is returned via the repository path.

import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import CommandRegistry from '../../src/api/CommandRegistry.js';
import { register as registerPlaybackCommands } from '../../src/api/commands/PlaybackCommands.js';

function makeMidiBuffer() {
  // Minimal valid MIDI header chunk (MThd + length + format + tracks + division).
  const header = Buffer.from([
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x60
  ]);
  const track = Buffer.from([
    0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, 0x04,
    0x00, 0xff, 0x2f, 0x00
  ]);
  return Buffer.concat([header, track]);
}

function createApp({ file = { id: 'f1', data: makeMidiBuffer() }, routings = [] } = {}) {
  return {
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    midiPlayer: {
      loadFile: jest.fn().mockResolvedValue({ filename: 't.mid', duration: 1, tracks: 1, events: 1, tempo: 120, channels: [] }),
      start: jest.fn(),
      clearChannelRouting: jest.fn(),
      setChannelRouting: jest.fn(),
      setChannelSplitRouting: jest.fn(),
      getChannelRouting: jest.fn().mockReturnValue([])
    },
    deviceManager: {
      getDeviceList: jest.fn().mockReturnValue([{ id: 'out-1', output: true, enabled: true }])
    },
    adaptationService: {
      analyzeChannel: jest.fn().mockReturnValue({ notes: 0, range: null }),
      generateSuggestions: jest.fn().mockResolvedValue({ success: true, suggestions: {}, autoSelection: {} })
    },
    // Intentionally empty — any call to app.database.getFile / getRoutingsByFile
    // from the migrated handlers would throw "is not a function" and fail the test.
    database: {},
    fileRepository: {
      findById: jest.fn().mockReturnValue(file)
    },
    routingRepository: {
      findByFileId: jest.fn().mockReturnValue(routings)
    }
  };
}

function createWs() {
  const messages = [];
  return {
    readyState: 1,
    send: jest.fn((d) => messages.push(JSON.parse(d))),
    _messages: messages
  };
}

function buildRegistry(app) {
  const registry = new CommandRegistry(app);
  registerPlaybackCommands(registry, app);
  return registry;
}

describe('P0-2.5a — playback handlers delegate to repositories', () => {
  let app;
  let registry;
  let ws;

  beforeEach(() => {
    app = createApp();
    registry = buildRegistry(app);
    ws = createWs();
  });

  test('analyze_channel uses fileRepository.findById (not database.getFile)', async () => {
    await registry.handle(
      { id: 'r1', command: 'analyze_channel', data: { fileId: 'f1', channel: 0 } },
      ws
    );
    expect(app.fileRepository.findById).toHaveBeenCalledWith('f1');
  });

  test('playback_validate_routing uses fileRepository + routingRepository', async () => {
    app.routingRepository.findByFileId.mockReturnValueOnce([
      { channel: 0, device_id: 'out-1', instrument_name: 'Piano' }
    ]);
    await registry.handle(
      { id: 'r2', command: 'playback_validate_routing', data: { fileId: 'f1' } },
      ws
    );
    expect(app.fileRepository.findById).toHaveBeenCalledWith('f1');
    expect(app.routingRepository.findByFileId).toHaveBeenCalledWith('f1');
  });

  test('playback_start uses routingRepository.findByFileId', async () => {
    app.routingRepository.findByFileId.mockReturnValueOnce([
      { channel: 0, device_id: 'out-1', target_channel: 0 }
    ]);
    await registry.handle(
      { id: 'r3', command: 'playback_start', data: { fileId: 'f1', outputDevice: 'out-1' } },
      ws
    );
    expect(app.routingRepository.findByFileId).toHaveBeenCalledWith('f1');
    expect(app.midiPlayer.setChannelRouting).toHaveBeenCalledWith(0, 'out-1', 0);
  });
});
