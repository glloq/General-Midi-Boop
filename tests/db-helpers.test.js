import { describe, test, expect } from '@jest/globals';
import { buildDynamicUpdate } from '../src/persistence/dbHelpers.js';

describe('buildDynamicUpdate', () => {
  test('builds SQL from allowed fields', () => {
    const result = buildDynamicUpdate('users', { name: 'Alice', age: 30 }, ['name', 'age']);

    expect(result.sql).toBe('UPDATE users SET name = ?, age = ? WHERE id = ?');
    expect(result.values).toEqual(['Alice', 30]);
  });

  test('ignores fields not in allowedFields', () => {
    const result = buildDynamicUpdate('users', { name: 'Alice', hack: 'drop table' }, ['name']);

    expect(result.sql).toBe('UPDATE users SET name = ? WHERE id = ?');
    expect(result.values).toEqual(['Alice']);
  });

  test('returns null when no fields to update', () => {
    const result = buildDynamicUpdate('users', { unknown: 'value' }, ['name']);
    expect(result).toBeNull();
  });

  test('returns null for empty updates', () => {
    const result = buildDynamicUpdate('users', {}, ['name']);
    expect(result).toBeNull();
  });

  test('applies transforms to values', () => {
    const result = buildDynamicUpdate('routes', { enabled: true }, ['enabled'], {
      transforms: { enabled: (v) => (v ? 1 : 0) }
    });

    expect(result.values).toEqual([1]);
  });

  test('supports custom WHERE clause', () => {
    const result = buildDynamicUpdate('profiles', { bio: 'hello' }, ['bio'], {
      whereClause: 'user_id = ? AND active = 1'
    });

    expect(result.sql).toBe('UPDATE profiles SET bio = ? WHERE user_id = ? AND active = 1');
  });

  test('skips undefined values', () => {
    const result = buildDynamicUpdate('users', { name: 'Bob', age: undefined }, ['name', 'age']);

    expect(result.sql).toBe('UPDATE users SET name = ? WHERE id = ?');
    expect(result.values).toEqual(['Bob']);
  });
});
