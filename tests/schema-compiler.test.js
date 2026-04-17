// tests/schema-compiler.test.js
// Unit tests for the declarative schema compiler (P1-3.1b, ADR-004).

import { describe, test, expect } from '@jest/globals';
import { compileSchema, validateAgainstSchema } from '../src/utils/SchemaCompiler.js';
import JsonValidator from '../src/utils/JsonValidator.js';

describe('SchemaCompiler — required fields', () => {
  const schema = { fields: { fileId: { type: 'id', required: true } } };

  test('valid when fileId is a positive number', () => {
    expect(validateAgainstSchema(schema, { fileId: 42 })).toEqual([]);
  });

  test('valid when fileId is a non-empty string', () => {
    expect(validateAgainstSchema(schema, { fileId: 'abc' })).toEqual([]);
  });

  test('error when fileId is missing', () => {
    expect(validateAgainstSchema(schema, {})).toEqual(['fileId is required']);
  });

  test('error when fileId is null', () => {
    expect(validateAgainstSchema(schema, { fileId: null })).toEqual(['fileId is required']);
  });

  test('error when fileId is wrong type (boolean)', () => {
    const errors = validateAgainstSchema(schema, { fileId: true });
    expect(errors).toEqual(['fileId must be a number or non-empty string']);
  });

  test('error when fileId is empty string', () => {
    const errors = validateAgainstSchema(schema, { fileId: '' });
    // Empty string is "present but wrong type" — aligns with legacy: returns "required"
    // Implementation: empty string fails `checkType('id')` so returns "must be ..."
    expect(errors).toEqual(['fileId must be a number or non-empty string']);
  });
});

describe('SchemaCompiler — optional fields', () => {
  const schema = { fields: { name: { type: 'string' } } };

  test('valid when absent', () => {
    expect(validateAgainstSchema(schema, {})).toEqual([]);
  });

  test('valid when string', () => {
    expect(validateAgainstSchema(schema, { name: 'x' })).toEqual([]);
  });

  test('error when wrong type', () => {
    expect(validateAgainstSchema(schema, { name: 7 })).toEqual(['name must be a string']);
  });
});

describe('SchemaCompiler — numeric ranges', () => {
  const schema = { fields: { channel: { type: 'integer', required: true, min: 0, max: 15 } } };

  test('valid at bounds', () => {
    expect(validateAgainstSchema(schema, { channel: 0 })).toEqual([]);
    expect(validateAgainstSchema(schema, { channel: 15 })).toEqual([]);
  });

  test('error below min', () => {
    expect(validateAgainstSchema(schema, { channel: -1 }))
      .toEqual(['channel must be between 0 and 15']);
  });

  test('error above max', () => {
    expect(validateAgainstSchema(schema, { channel: 16 }))
      .toEqual(['channel must be between 0 and 15']);
  });

  test('error when not integer', () => {
    expect(validateAgainstSchema(schema, { channel: 1.5 }))
      .toEqual(['channel must be an integer']);
  });
});

describe('SchemaCompiler — enum constraint', () => {
  const schema = { fields: { policy: { type: 'string', required: true, enum: ['skip', 'pause', 'mute'] } } };

  test('valid value', () => {
    expect(validateAgainstSchema(schema, { policy: 'pause' })).toEqual([]);
  });

  test('invalid value', () => {
    expect(validateAgainstSchema(schema, { policy: 'kill' }))
      .toEqual(['policy must be one of: skip, pause, mute']);
  });
});

describe('SchemaCompiler — string length', () => {
  const schema = { fields: { name: { type: 'string', required: true, minLength: 1, maxLength: 20 } } };

  test('valid', () => {
    expect(validateAgainstSchema(schema, { name: 'x' })).toEqual([]);
  });

  test('too long', () => {
    expect(validateAgainstSchema(schema, { name: 'x'.repeat(21) }))
      .toEqual(['name must be at most 20 characters']);
  });
});

describe('SchemaCompiler — array/object types', () => {
  test('array type accepts arrays only', () => {
    const schema = { fields: { items: { type: 'array', required: true } } };
    expect(validateAgainstSchema(schema, { items: [] })).toEqual([]);
    expect(validateAgainstSchema(schema, { items: {} })).toEqual(['items must be an array']);
  });

  test('object type rejects arrays and null', () => {
    const schema = { fields: { opts: { type: 'object', required: true } } };
    expect(validateAgainstSchema(schema, { opts: { a: 1 } })).toEqual([]);
    expect(validateAgainstSchema(schema, { opts: [] })).toEqual(['opts must be an object']);
  });
});

describe('SchemaCompiler — custom cross-field', () => {
  const schema = {
    fields: {
      fileId: { type: 'id' },
      outputDevice: { type: 'string' }
    },
    custom: (data) => {
      if (!data.fileId && !data.outputDevice) return 'fileId or outputDevice is required';
      return null;
    }
  };

  test('valid when fileId provided', () => {
    expect(validateAgainstSchema(schema, { fileId: 1 })).toEqual([]);
  });

  test('valid when outputDevice provided', () => {
    expect(validateAgainstSchema(schema, { outputDevice: 'x' })).toEqual([]);
  });

  test('error when neither provided', () => {
    expect(validateAgainstSchema(schema, {}))
      .toEqual(['fileId or outputDevice is required']);
  });

  test('custom can return an array of messages', () => {
    const multi = {
      custom: () => ['err-a', 'err-b']
    };
    expect(validateAgainstSchema(multi, {})).toEqual(['err-a', 'err-b']);
  });
});

describe('SchemaCompiler — schema integrity', () => {
  test('rejects unknown type', () => {
    expect(() => compileSchema({ fields: { x: { type: 'frobnicator' } } })).toThrow(/unknown type/);
  });

  test('rejects non-function custom', () => {
    expect(() => compileSchema({ custom: 42 })).toThrow(/custom must be a function/);
  });

  test('rejects non-object schema', () => {
    expect(() => compileSchema(null)).toThrow(/Schema must be an object/);
  });
});

describe('JsonValidator.validateBySchema wrapper', () => {
  test('returns { valid: true } on success', () => {
    const result = JsonValidator.validateBySchema(
      { fields: { id: { type: 'id', required: true } } },
      { id: 1 }
    );
    expect(result).toEqual({ valid: true, errors: [] });
  });

  test('returns { valid: false, errors } on failure', () => {
    const result = JsonValidator.validateBySchema(
      { fields: { id: { type: 'id', required: true } } },
      {}
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(['id is required']);
  });
});

describe('SchemaCompiler — non-object data', () => {
  const schema = { fields: { a: { type: 'string', required: true } } };
  test('null data → required error', () => {
    expect(validateAgainstSchema(schema, null)).toEqual(['a is required']);
  });
  test('undefined data → required error', () => {
    expect(validateAgainstSchema(schema, undefined)).toEqual(['a is required']);
  });
});
