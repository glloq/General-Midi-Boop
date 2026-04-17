// tests/api/command-metrics.test.js
// Verifies that CommandRegistry emits `ws.command.completed` on the
// EventBus on both success and error paths (P2-OBS.2 + OBS.3).

import { jest, describe, test, expect } from '@jest/globals';
import CommandRegistry from '../../src/api/CommandRegistry.js';
import { ValidationError } from '../../src/core/errors/index.js';

function makeApp() {
  const events = [];
  return {
    _events: events,
    logger: {
      info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
    },
    eventBus: {
      emit: jest.fn((name, data) => events.push({ name, data }))
    }
  };
}

function makeWs() {
  return { readyState: 1, send: jest.fn() };
}

describe('P2-OBS.2/3 — ws.command.completed metric event', () => {
  test('success path emits { success:true, duration, cid, command }', async () => {
    const app = makeApp();
    const registry = new CommandRegistry(app);
    registry.register('metric_ok', async () => ({ ok: true }));

    await registry.handle({ id: 'r-1', command: 'metric_ok', data: {} }, makeWs());

    const emitted = app._events.filter((e) => e.name === 'ws.command.completed');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].data.command).toBe('metric_ok');
    expect(emitted[0].data.cid).toBe('r-1');
    expect(emitted[0].data.success).toBe(true);
    expect(typeof emitted[0].data.duration).toBe('number');
    expect(emitted[0].data.duration).toBeGreaterThanOrEqual(0);
  });

  test('error path emits { success:false, errorCode }', async () => {
    const app = makeApp();
    const registry = new CommandRegistry(app);
    registry.register('metric_fail', async () => {
      throw new ValidationError('boom');
    });

    await registry.handle({ id: 'r-2', command: 'metric_fail', data: {} }, makeWs());

    const emitted = app._events.filter((e) => e.name === 'ws.command.completed');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].data.success).toBe(false);
    expect(emitted[0].data.errorCode).toBe('ERR_VALIDATION');
    expect(emitted[0].data.cid).toBe('r-2');
  });

  test('unknown errors get errorCode ERR_INTERNAL', async () => {
    const app = makeApp();
    const registry = new CommandRegistry(app);
    registry.register('metric_blow', async () => {
      throw new Error('generic blow-up');
    });

    await registry.handle({ id: 'r-3', command: 'metric_blow', data: {} }, makeWs());

    const emitted = app._events.filter((e) => e.name === 'ws.command.completed');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].data.success).toBe(false);
    expect(emitted[0].data.errorCode).toBe('ERR_INTERNAL');
  });

  test('missing eventBus does not crash the handler', async () => {
    const app = { logger: { info: jest.fn(), error: jest.fn() } };
    const registry = new CommandRegistry(app);
    registry.register('metric_ok', async () => ({ ok: true }));
    await expect(
      registry.handle({ id: 'r-4', command: 'metric_ok' }, makeWs())
    ).resolves.toBeUndefined();
  });
});
