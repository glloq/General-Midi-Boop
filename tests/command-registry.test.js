import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import CommandRegistry from '../src/api/CommandRegistry.js';
import { ValidationError, NotFoundError } from '../src/core/errors/index.js';

// Minimal mock for the `app` object used by CommandRegistry
function createMockApp() {
  return {
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    }
  };
}

// Minimal mock WebSocket that records sent messages
function createMockWs() {
  const messages = [];
  return {
    readyState: 1, // OPEN
    send: jest.fn((data) => messages.push(JSON.parse(data))),
    _messages: messages
  };
}

describe('CommandRegistry', () => {
  let registry;
  let app;

  beforeEach(() => {
    app = createMockApp();
    registry = new CommandRegistry(app);
  });

  // ─── Registration ────────────────────────────────────────
  describe('register', () => {
    test('registers a handler and can dispatch it', async () => {
      const handler = jest.fn(() => ({ ok: true }));
      registry.register('test_cmd', handler);

      const ws = createMockWs();
      await registry.handle({ id: '1', command: 'test_cmd', data: {} }, ws);

      expect(handler).toHaveBeenCalledWith({});
      expect(ws._messages).toHaveLength(1);
      expect(ws._messages[0].type).toBe('response');
      expect(ws._messages[0].data).toEqual({ ok: true });
    });

    test('warns when overwriting an existing handler', () => {
      registry.register('dup', () => {});
      registry.register('dup', () => {});
      expect(app.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("overwriting handler for 'dup'")
      );
    });

    test('registers versioned handlers separately', async () => {
      const v1Handler = jest.fn(() => 'v1');
      const v2Handler = jest.fn(() => 'v2');
      registry.register('cmd', v1Handler);
      registry.register('cmd', v2Handler, 2);

      const ws = createMockWs();

      // Default version → v1
      await registry.handle({ id: '1', command: 'cmd', data: {} }, ws);
      expect(v1Handler).toHaveBeenCalled();

      // Explicit v2
      await registry.handle({ id: '2', command: 'cmd', version: 2, data: {} }, ws);
      expect(v2Handler).toHaveBeenCalled();
    });
  });

  // ─── Dispatch / response ─────────────────────────────────
  describe('handle', () => {
    test('sends response with matching id and duration', async () => {
      registry.register('ping', () => ({ pong: true }));
      const ws = createMockWs();

      await registry.handle({ id: 'req-42', command: 'ping' }, ws);

      const resp = ws._messages[0];
      expect(resp.id).toBe('req-42');
      expect(resp.command).toBe('ping');
      expect(resp.type).toBe('response');
      expect(resp.version).toBe(1);
      expect(resp.data).toEqual({ pong: true });
      expect(typeof resp.duration).toBe('number');
      expect(typeof resp.timestamp).toBe('number');
    });

    test('does not send if WebSocket is closed', async () => {
      registry.register('noop', () => ({}));
      const ws = createMockWs();
      ws.readyState = 3; // CLOSED

      await registry.handle({ id: '1', command: 'noop' }, ws);
      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  // ─── Error handling ──────────────────────────────────────
  describe('error classification', () => {
    test('unknown command returns NotFoundError message', async () => {
      const ws = createMockWs();
      await registry.handle({ id: '1', command: 'does_not_exist' }, ws);

      const resp = ws._messages[0];
      expect(resp.type).toBe('error');
      expect(resp.error).toContain('not found');
      expect(resp.code).toBe('ERR_NOT_FOUND');
    });

    test('ApplicationError subclass exposes message to client', async () => {
      registry.register('fail_validation', () => {
        throw new ValidationError('name is required', 'name');
      });

      const ws = createMockWs();
      await registry.handle({ id: '1', command: 'fail_validation' }, ws);

      const resp = ws._messages[0];
      expect(resp.type).toBe('error');
      expect(resp.error).toBe('name is required');
      expect(resp.code).toBe('ERR_VALIDATION');
    });

    test('ApplicationError subclass (NotFoundError) exposes message', async () => {
      registry.register('fail_notfound', () => {
        throw new NotFoundError('Device', 'abc');
      });

      const ws = createMockWs();
      await registry.handle({ id: '1', command: 'fail_notfound' }, ws);

      const resp = ws._messages[0];
      expect(resp.type).toBe('error');
      expect(resp.error).toContain("Device with id 'abc' not found");
      expect(resp.code).toBe('ERR_NOT_FOUND');
    });

    test('generic Error is hidden behind "Internal server error"', async () => {
      registry.register('fail_internal', () => {
        throw new Error('some secret path /etc/passwd');
      });

      const ws = createMockWs();
      await registry.handle({ id: '1', command: 'fail_internal' }, ws);

      const resp = ws._messages[0];
      expect(resp.type).toBe('error');
      expect(resp.error).toBe('Internal server error');
      expect(resp.code).toBeUndefined();
    });

    test('does not send error if WebSocket is closed', async () => {
      registry.register('fail_closed', () => {
        throw new ValidationError('x');
      });

      const ws = createMockWs();
      ws.readyState = 3;

      await registry.handle({ id: '1', command: 'fail_closed' }, ws);
      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  // ─── Validation ──────────────────────────────────────────
  describe('message validation', () => {
    test('rejects message without command field', async () => {
      const ws = createMockWs();
      await registry.handle({ id: '1' }, ws);

      const resp = ws._messages[0];
      expect(resp.type).toBe('error');
      expect(resp.code).toBe('ERR_VALIDATION');
    });
  });
});
