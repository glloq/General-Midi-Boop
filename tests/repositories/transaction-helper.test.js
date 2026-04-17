// tests/repositories/transaction-helper.test.js
// Verifies that FileRepository, RoutingRepository and InstrumentRepository
// expose a `transaction(fn)` helper that delegates to the underlying
// Database facade (P0-2.4, ADR-002 §Conventions 3).

import { jest, describe, test, expect } from '@jest/globals';
import FileRepository from '../../src/repositories/FileRepository.js';
import RoutingRepository from '../../src/repositories/RoutingRepository.js';
import InstrumentRepository from '../../src/repositories/InstrumentRepository.js';

describe('Repository transaction(fn) delegation', () => {
  const cases = [
    ['FileRepository', FileRepository],
    ['RoutingRepository', RoutingRepository],
    ['InstrumentRepository', InstrumentRepository]
  ];

  for (const [name, RepoClass] of cases) {
    test(`${name}.transaction(fn) delegates to database.transaction(fn)`, () => {
      const wrapped = jest.fn((...args) => ({ args }));
      const database = {
        transaction: jest.fn(() => wrapped)
      };
      const repo = new RepoClass(database);

      const input = () => 'inner';
      const result = repo.transaction(input);

      expect(database.transaction).toHaveBeenCalledWith(input);
      expect(result).toBe(wrapped);

      const ret = result('a', 'b');
      expect(wrapped).toHaveBeenCalledWith('a', 'b');
      expect(ret).toEqual({ args: ['a', 'b'] });
    });
  }
});
