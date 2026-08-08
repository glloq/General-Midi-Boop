import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Logger from '../src/core/Logger.js';

describe('Logger', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('level filtering', () => {
    test('respects log level', () => {
      const logger = new Logger({ level: 'warn' });
      logger.debug('debug msg');
      logger.info('info msg');
      logger.warn('warn msg');
      logger.error('error msg');

      // Only warn and error should have been logged
      expect(console.log).toHaveBeenCalledTimes(2);
    });
  });

  describe('hot-path branch helpers', () => {
    test('isDebugEnabled returns true only when level=debug', () => {
      expect(new Logger({ level: 'debug' }).isDebugEnabled()).toBe(true);
      expect(new Logger({ level: 'info' }).isDebugEnabled()).toBe(false);
      expect(new Logger({ level: 'warn' }).isDebugEnabled()).toBe(false);
      expect(new Logger({ level: 'error' }).isDebugEnabled()).toBe(false);
    });

    test('isWarnEnabled is true for debug+info+warn, false for error-only', () => {
      expect(new Logger({ level: 'debug' }).isWarnEnabled()).toBe(true);
      expect(new Logger({ level: 'info' }).isWarnEnabled()).toBe(true);
      expect(new Logger({ level: 'warn' }).isWarnEnabled()).toBe(true);
      expect(new Logger({ level: 'error' }).isWarnEnabled()).toBe(false);
    });

    test('helpers consistent with shouldLog()', () => {
      const logger = new Logger({ level: 'info' });
      expect(logger.isDebugEnabled()).toBe(logger.shouldLog('debug'));
      expect(logger.isWarnEnabled()).toBe(logger.shouldLog('warn'));
    });

    test('format() is never called when the gate filters the level', () => {
      const logger = new Logger({ level: 'warn' });
      const fmtSpy = jest.spyOn(logger, 'format');
      // Caller-side gate pattern used in hot paths:
      if (logger.isDebugEnabled()) {
        logger.debug('expensive-' + JSON.stringify({ heavy: true }));
      }
      expect(fmtSpy).not.toHaveBeenCalled();
    });

    test('unknown level defaults to info threshold', () => {
      const logger = new Logger({ level: 'bogus' });
      expect(logger.isDebugEnabled()).toBe(false);
      expect(logger.isWarnEnabled()).toBe(true);
    });

    test('runtime level change keeps the cached numeric threshold in sync', () => {
      const logger = new Logger({ level: 'info' });
      expect(logger.isDebugEnabled()).toBe(false);
      logger.level = 'debug';
      expect(logger.isDebugEnabled()).toBe(true);
      expect(logger.level).toBe('debug');
      logger.level = 'error';
      expect(logger.isWarnEnabled()).toBe(false);
      // Unknown payload falls back to the info threshold.
      logger.level = 'nonsense';
      expect(logger.isDebugEnabled()).toBe(false);
      expect(logger.isWarnEnabled()).toBe(true);
    });
  });

  describe('format', () => {
    test('includes timestamp and level', () => {
      const logger = new Logger({ level: 'debug' });
      const output = logger.format('info', 'test message');
      expect(output).toMatch(/\[\d{4}-\d{2}-\d{2}T/);
      expect(output).toContain('INFO');
      expect(output).toContain('test message');
    });

    test('includes error stack', () => {
      const logger = new Logger({ level: 'debug' });
      const err = new Error('test error');
      const output = logger.format('error', 'failed', err);
      expect(output).toContain('test error');
      expect(output).toContain('Stack:');
    });

    test('includes JSON data', () => {
      const logger = new Logger({ level: 'debug' });
      const output = logger.format('info', 'data', { key: 'value' });
      expect(output).toContain('"key"');
      expect(output).toContain('"value"');
    });
  });

  describe('JSON format', () => {
    test('formatJson produces valid JSON', () => {
      const logger = new Logger({ level: 'debug', jsonFormat: true });
      const json = logger.formatJson('info', 'hello', { key: 1 });
      const parsed = JSON.parse(json);

      expect(parsed.level).toBe('info');
      expect(parsed.message).toBe('hello');
      expect(parsed.data).toEqual({ key: 1 });
      expect(parsed.timestamp).toBeDefined();
    });

    test('formatJson handles errors', () => {
      const logger = new Logger({ level: 'debug', jsonFormat: true });
      const err = new Error('boom');
      const json = logger.formatJson('error', 'failed', err);
      const parsed = JSON.parse(json);

      expect(parsed.error.message).toBe('boom');
      expect(parsed.error.stack).toBeDefined();
    });
  });

  describe('file writing', () => {
    test('writes to log file', async () => {
      const logFile = path.join(tmpDir, 'test.log');
      const logger = new Logger({ level: 'info', file: logFile });
      logger.info('file test');

      // close() now resolves once the stream has flushed — await it directly.
      await logger.close();

      const content = fs.readFileSync(logFile, 'utf8');
      expect(content).toContain('file test');
    });

    test('writes JSON format to file when enabled', async () => {
      const logFile = path.join(tmpDir, 'json.log');
      const logger = new Logger({ level: 'info', file: logFile, jsonFormat: true });
      logger.info('json test');

      // close() now resolves once the stream has flushed — await it directly.
      await logger.close();

      const content = fs.readFileSync(logFile, 'utf8').trim();
      const parsed = JSON.parse(content);
      expect(parsed.message).toBe('json test');
    });

    // Audit B3-M3: close() now resolves only AFTER the stream has flushed, so a
    // graceful shutdown can `await` it and the last lines reach disk.
    test('close() resolves after flushing buffered lines to disk', async () => {
      const logFile = path.join(tmpDir, 'flush.log');
      const logger = new Logger({ level: 'info', file: logFile });
      logger.info('flush test line');

      await logger.close(); // must resolve AFTER the flush, no external timer

      const content = fs.readFileSync(logFile, 'utf8');
      expect(content).toContain('flush test line');
    });

    test('close() is idempotent and resolves when there is no file stream', async () => {
      const logger = new Logger({ level: 'info' }); // console-only
      await expect(logger.close()).resolves.toBeUndefined();
      await expect(logger.close()).resolves.toBeUndefined();
    });
  });

  describe('rotation', () => {
    test('rotates when file exceeds max size', async () => {
      const logFile = path.join(tmpDir, 'rotate.log');
      const logger = new Logger({
        level: 'debug',
        file: logFile,
        maxLogSize: 100, // Very small for testing
        maxLogFiles: 3
      });

      // Write enough to trigger rotation (synchronously simulate)
      fs.writeFileSync(logFile, 'x'.repeat(200));
      logger._checkRotation();

      // Wait for async stat + rotation to complete
      await new Promise((resolve) => setTimeout(resolve, 100));
      await logger.close();

      expect(fs.existsSync(`${logFile}.1`)).toBe(true);
    });

    test('prunes old rotated files', async () => {
      const logFile = path.join(tmpDir, 'prune.log');
      const logger = new Logger({
        level: 'debug',
        file: logFile,
        maxLogSize: 100,
        maxLogFiles: 2
      });

      // Create fake rotated files
      fs.writeFileSync(`${logFile}.1`, 'old1');
      fs.writeFileSync(`${logFile}.2`, 'old2');
      fs.writeFileSync(logFile, 'x'.repeat(200));

      logger._rotate();

      // old .2 should have been shifted to .3 but max is 2, so .3 should exist
      // and current should be moved to .1
      expect(fs.existsSync(`${logFile}.1`)).toBe(true);

      // Close the reopened stream before afterEach removes tmpDir, otherwise the
      // open fd errors (ENOENT) asynchronously → "Cannot log after tests" noise.
      await logger.close();
    });
  });
});
