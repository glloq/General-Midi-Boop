import { describe, test, expect } from '@jest/globals';
import {
  ApplicationError,
  ValidationError,
  NotFoundError,
  AuthenticationError,
  ConfigurationError,
  MidiError,
  DatabaseError
} from '../src/core/errors/index.js';

describe('Error hierarchy', () => {
  test('ApplicationError has code and statusCode', () => {
    const err = new ApplicationError('test error');
    expect(err.message).toBe('test error');
    expect(err.code).toBe('ERR_APPLICATION');
    expect(err.statusCode).toBe(500);
    expect(err).toBeInstanceOf(Error);
  });

  test('ApplicationError.toJSON() returns structured object', () => {
    const err = new ApplicationError('fail', 'ERR_CUSTOM', 503);
    expect(err.toJSON()).toEqual({
      error: 'ApplicationError',
      code: 'ERR_CUSTOM',
      message: 'fail'
    });
  });

  test('ValidationError has field and 400 status', () => {
    const err = new ValidationError('bad input', 'email');
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('ERR_VALIDATION');
    expect(err.field).toBe('email');
    expect(err).toBeInstanceOf(ApplicationError);
    expect(err.toJSON().field).toBe('email');
  });

  test('NotFoundError formats message with resource and id', () => {
    const err = new NotFoundError('User', 42);
    expect(err.message).toBe("User with id '42' not found");
    expect(err.statusCode).toBe(404);
    expect(err.resource).toBe('User');
  });

  test('NotFoundError works without id', () => {
    const err = new NotFoundError('Config');
    expect(err.message).toBe('Config not found');
  });

  test('AuthenticationError defaults', () => {
    const err = new AuthenticationError();
    expect(err.message).toBe('Authentication required');
    expect(err.statusCode).toBe(401);
  });

  test('ConfigurationError', () => {
    const err = new ConfigurationError('missing key');
    expect(err.code).toBe('ERR_CONFIGURATION');
    expect(err.statusCode).toBe(500);
  });

  test('MidiError includes device', () => {
    const err = new MidiError('device offline', 'USB-MIDI-1');
    expect(err.device).toBe('USB-MIDI-1');
    expect(err.code).toBe('ERR_MIDI');
  });

  test('DatabaseError includes operation', () => {
    const err = new DatabaseError('query failed', 'INSERT');
    expect(err.operation).toBe('INSERT');
    expect(err.code).toBe('ERR_DATABASE');
  });

  test('all errors are instanceof Error', () => {
    const errors = [
      new ApplicationError('a'),
      new ValidationError('b'),
      new NotFoundError('c'),
      new AuthenticationError(),
      new ConfigurationError('d'),
      new MidiError('e'),
      new DatabaseError('f')
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(ApplicationError);
    }
  });
});
