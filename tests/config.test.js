import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import Config from '../src/core/Config.js';

describe('Config', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('default configuration', () => {
    test('loads default config values', () => {
      const config = new Config('/nonexistent/path.json');
      expect(config.server.port).toBe(8080);
      expect(config.database.path).toBe('./data/midimind.db');
      expect(config.logging.level).toBe('info');
    });
  });

  describe('get / set', () => {
    test('gets nested config value', () => {
      const config = new Config('/nonexistent/path.json');
      expect(config.get('server.port')).toBe(8080);
    });

    test('returns default for missing key', () => {
      const config = new Config('/nonexistent/path.json');
      expect(config.get('nonexistent.key', 'fallback')).toBe('fallback');
    });

    test('sets a config value', () => {
      const config = new Config('/nonexistent/path.json');
      config.set('server.port', 3000);
      expect(config.get('server.port')).toBe(3000);
    });

    test('rejects invalid values', () => {
      const config = new Config('/nonexistent/path.json');
      expect(() => config.set('server.port', -1)).toThrow(/Invalid value/);
      expect(() => config.set('server.port', 70000)).toThrow(/Invalid value/);
    });
  });

  describe('environment variable overrides', () => {
    test('PORT overrides server.port', () => {
      process.env.PORT = '3000';
      const config = new Config('/nonexistent/path.json');
      expect(config.get('server.port')).toBe(3000);
    });

    test('MAESTRO_LOG_LEVEL overrides logging.level', () => {
      process.env.MAESTRO_LOG_LEVEL = 'debug';
      const config = new Config('/nonexistent/path.json');
      expect(config.get('logging.level')).toBe('debug');
    });

    test('MAESTRO_BLE_ENABLED overrides ble.enabled', () => {
      process.env.MAESTRO_BLE_ENABLED = 'true';
      const config = new Config('/nonexistent/path.json');
      expect(config.get('ble.enabled')).toBe(true);
    });

    test('ignores invalid numeric env values', () => {
      process.env.PORT = 'not-a-number';
      const config = new Config('/nonexistent/path.json');
      expect(config.get('server.port')).toBe(8080); // unchanged
    });
  });

  describe('getAll', () => {
    test('returns config object with all sections', () => {
      const config = new Config('/nonexistent/path.json');
      const all = config.getAll();
      expect(all).toHaveProperty('server');
      expect(all).toHaveProperty('midi');
      expect(all).toHaveProperty('database');
      expect(all).toHaveProperty('logging');
    });
  });

  describe('convenience getters', () => {
    test('provides section accessors', () => {
      const config = new Config('/nonexistent/path.json');
      expect(config.midi.bufferSize).toBe(1024);
      expect(config.playback.defaultTempo).toBe(120);
      expect(config.ble.enabled).toBe(false);
    });
  });
});
