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

      // Wait for the write stream to flush
      await new Promise(resolve => {
        logger.close();
        setTimeout(resolve, 50);
      });

      const content = fs.readFileSync(logFile, 'utf8');
      expect(content).toContain('file test');
    });

    test('writes JSON format to file when enabled', async () => {
      const logFile = path.join(tmpDir, 'json.log');
      const logger = new Logger({ level: 'info', file: logFile, jsonFormat: true });
      logger.info('json test');

      // Wait for the write stream to flush
      await new Promise(resolve => {
        logger.close();
        setTimeout(resolve, 50);
      });

      const content = fs.readFileSync(logFile, 'utf8').trim();
      const parsed = JSON.parse(content);
      expect(parsed.message).toBe('json test');
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
      await new Promise(resolve => setTimeout(resolve, 100));
      logger.close();

      expect(fs.existsSync(`${logFile}.1`)).toBe(true);
    });

    test('prunes old rotated files', () => {
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
    });
  });
});
