// tests/logger-safe-stringify.test.js
// Audit B3 M1: logging must never throw. A circular / BigInt payload used to
// blow up JSON.stringify inside format()/formatJson() and crash the caller.

import { describe, test, expect } from '@jest/globals';
import Logger from '../src/core/Logger.js';

describe('Logger — payloads must not crash the caller (audit B3 M1)', () => {
  const logger = new Logger({}); // console-only (no file sink)

  test('a circular object does not throw and formatJson stays valid JSON', () => {
    const circ = {};
    circ.self = circ;
    expect(() => logger.format('info', 'msg', circ)).not.toThrow();
    expect(() => logger.info('msg', circ)).not.toThrow();
    const json = logger.formatJson('info', 'msg', circ);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(JSON.parse(json).message).toBe('msg');
  });

  test('a BigInt payload does not throw', () => {
    expect(() => logger.format('warn', 'm', { big: 10n })).not.toThrow();
    expect(() => logger.formatJson('warn', 'm', { big: 10n })).not.toThrow();
  });

  test('ordinary payloads still serialize normally', () => {
    const json = logger.formatJson('info', 'hello', { a: 1 });
    expect(JSON.parse(json)).toMatchObject({ level: 'info', message: 'hello', data: { a: 1 } });
  });
});
