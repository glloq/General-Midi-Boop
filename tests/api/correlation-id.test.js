// tests/api/correlation-id.test.js
// Verifies that CommandRegistry tags every log line with a correlation ID
// built from message.id (P2-OBS.1).

import { jest, describe, test, expect } from '@jest/globals';
import CommandRegistry from '../../src/api/CommandRegistry.js';

function makeApp() {
  return {
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    }
  };
}

function makeWs() {
  const messages = [];
  return {
    readyState: 1,
    send: jest.fn((d) => messages.push(JSON.parse(d))),
    _messages: messages
  };
}

describe('P2-OBS.1 — correlation ID in command logs', () => {
  test('tags every info log with [cmd=X cid=Y] using message.id', async () => {
    const app = makeApp();
    const registry = new CommandRegistry(app);
    registry.register('test_cmd', async () => ({ ok: true }));

    const ws = makeWs();
    await registry.handle({ id: 'req-42', command: 'test_cmd', data: {} }, ws);

    const infoCalls = app.logger.info.mock.calls.map((c) => c[0]);
    expect(infoCalls.length).toBeGreaterThan(0);
    for (const line of infoCalls) {
      expect(line).toMatch(/\[cmd=test_cmd cid=req-42\]/);
    }
  });

  test('falls back to a generated cid when message.id is missing', async () => {
    const app = makeApp();
    const registry = new CommandRegistry(app);
    registry.register('test_cmd', async () => ({ ok: true }));

    const ws = makeWs();
    await registry.handle({ command: 'test_cmd', data: {} }, ws);

    const infoCalls = app.logger.info.mock.calls.map((c) => c[0]);
    expect(infoCalls.length).toBeGreaterThan(0);
    for (const line of infoCalls) {
      // cid is non-empty and not the literal "undefined"
      expect(line).toMatch(/\[cmd=test_cmd cid=[a-z0-9]+\]/);
      expect(line).not.toMatch(/cid=undefined/);
    }
  });

  test('error logs also carry the correlation ID', async () => {
    const app = makeApp();
    const registry = new CommandRegistry(app);
    registry.register('boom', async () => { throw new Error('kaboom'); });

    const ws = makeWs();
    await registry.handle({ id: 'req-99', command: 'boom', data: {} }, ws);

    const errorCalls = app.logger.error.mock.calls.map((c) => c[0]);
    // The first error log is the failure message (stack is the second).
    expect(errorCalls[0]).toMatch(/\[cmd=boom cid=req-99\]/);
  });
});
