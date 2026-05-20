import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import ServiceContainer from '../src/core/ServiceContainer.js';

describe('ServiceContainer', () => {
  let container;

  beforeEach(() => {
    container = new ServiceContainer();
  });

  describe('register / resolve', () => {
    test('registers and resolves a direct instance', () => {
      const logger = { info: jest.fn() };
      container.register('logger', logger);
      expect(container.resolve('logger')).toBe(logger);
    });

    test('returns undefined for unregistered service', () => {
      expect(container.resolve('unknown')).toBeUndefined();
    });

    test('supports chaining on register', () => {
      const result = container.register('a', 1).register('b', 2);
      expect(result).toBe(container);
      expect(container.resolve('a')).toBe(1);
      expect(container.resolve('b')).toBe(2);
    });
  });

  describe('factory', () => {
    test('lazily creates instance via factory', () => {
      const factoryFn = jest.fn(() => ({ value: 42 }));
      container.factory('service', factoryFn);

      expect(factoryFn).not.toHaveBeenCalled();
      const result = container.resolve('service');
      expect(factoryFn).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ value: 42 });
    });

    test('caches factory result after first resolve', () => {
      let callCount = 0;
      container.factory('service', () => ({ id: ++callCount }));

      const first = container.resolve('service');
      const second = container.resolve('service');
      expect(first).toBe(second);
      expect(callCount).toBe(1);
    });

    test('passes container to factory for dependency resolution', () => {
      container.register('config', { port: 3000 });
      container.factory('server', (c) => ({
        port: c.resolve('config').port
      }));

      expect(container.resolve('server').port).toBe(3000);
    });

    test('detects circular dependencies', () => {
      container.factory('a', (c) => c.resolve('b'));
      container.factory('b', (c) => c.resolve('a'));

      expect(() => container.resolve('a')).toThrow(/Circular dependency/);
    });

    test('supports chaining on factory', () => {
      const result = container.factory('a', () => 1).factory('b', () => 2);
      expect(result).toBe(container);
    });
  });

  describe('has', () => {
    test('returns true for registered instances', () => {
      container.register('a', 1);
      expect(container.has('a')).toBe(true);
    });

    test('returns true for registered factories', () => {
      container.factory('a', () => 1);
      expect(container.has('a')).toBe(true);
    });

    test('returns false for unregistered services', () => {
      expect(container.has('nope')).toBe(false);
    });
  });

  describe('unregister', () => {
    test('removes a registered instance', () => {
      container.register('a', 1);
      container.unregister('a');
      expect(container.has('a')).toBe(false);
    });

    test('removes a registered factory', () => {
      container.factory('a', () => 1);
      container.unregister('a');
      expect(container.has('a')).toBe(false);
    });
  });
});
