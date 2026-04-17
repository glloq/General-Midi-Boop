// src/utils/SchemaCompiler.js
// Declarative command schema compiler (ADR-004).
//
// Usage:
//   const validate = compileSchema({
//     fields: { fileId: { type: 'id', required: true } },
//     custom: (data) => data.foo === data.bar ? 'foo and bar must differ' : null
//   });
//   const errors = validate(payload);  // => string[] (empty if valid)
//
// Behaviour is aligned with the historical JsonValidator output so that
// existing WS contract snapshots (docs/refactor/contracts/**) remain stable.

const SUPPORTED_TYPES = new Set([
  'id', 'string', 'number', 'integer', 'boolean', 'object', 'array'
]);

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkType(value, type) {
  switch (type) {
    case 'id':
      if (typeof value === 'number') return Number.isFinite(value) && value > 0;
      if (typeof value === 'string') return value.length > 0;
      return false;
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    default:
      return false;
  }
}

function typeLabel(type) {
  // Keep error messages close to the legacy JsonValidator phrasing.
  switch (type) {
    case 'id':      return 'a number or non-empty string';
    case 'string':  return 'a string';
    case 'number':  return 'a number';
    case 'integer': return 'an integer';
    case 'boolean': return 'a boolean';
    case 'object':  return 'an object';
    case 'array':   return 'an array';
    default:        return type;
  }
}

function validateField(name, spec, data) {
  const errors = [];
  const present = Object.prototype.hasOwnProperty.call(data, name)
    && data[name] !== undefined
    && data[name] !== null;

  if (!present) {
    if (spec.required) errors.push(`${name} is required`);
    return errors;
  }

  const value = data[name];

  if (!checkType(value, spec.type)) {
    errors.push(`${name} must be ${typeLabel(spec.type)}`);
    return errors;
  }

  if ((spec.type === 'number' || spec.type === 'integer')) {
    if (typeof spec.min === 'number' && value < spec.min) {
      errors.push(
        typeof spec.max === 'number'
          ? `${name} must be between ${spec.min} and ${spec.max}`
          : `${name} must be >= ${spec.min}`
      );
    } else if (typeof spec.max === 'number' && value > spec.max) {
      errors.push(
        typeof spec.min === 'number'
          ? `${name} must be between ${spec.min} and ${spec.max}`
          : `${name} must be <= ${spec.max}`
      );
    }
  }

  if (spec.type === 'string') {
    if (typeof spec.minLength === 'number' && value.length < spec.minLength) {
      errors.push(`${name} must be at least ${spec.minLength} characters`);
    }
    if (typeof spec.maxLength === 'number' && value.length > spec.maxLength) {
      errors.push(`${name} must be at most ${spec.maxLength} characters`);
    }
  }

  if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
    errors.push(`${name} must be one of: ${spec.enum.join(', ')}`);
  }

  return errors;
}

function assertSchemaShape(schema) {
  if (!isPlainObject(schema)) {
    throw new Error('Schema must be an object');
  }
  if (schema.fields && !isPlainObject(schema.fields)) {
    throw new Error('Schema.fields must be an object');
  }
  if (schema.fields) {
    for (const [name, spec] of Object.entries(schema.fields)) {
      if (!isPlainObject(spec)) {
        throw new Error(`Field "${name}": spec must be an object`);
      }
      if (!SUPPORTED_TYPES.has(spec.type)) {
        throw new Error(
          `Field "${name}": unknown type "${spec.type}" (allowed: ${[...SUPPORTED_TYPES].join(', ')})`
        );
      }
    }
  }
  if (schema.custom !== undefined && typeof schema.custom !== 'function') {
    throw new Error('Schema.custom must be a function');
  }
}

/**
 * Compile a declarative schema into a validator function.
 * @param {object} schema
 * @returns {(data: object) => string[]} validator returning the error list
 *   (empty when valid).
 */
export function compileSchema(schema) {
  assertSchemaShape(schema);

  return function validate(data) {
    const errors = [];
    const safeData = isPlainObject(data) ? data : {};

    if (schema.fields) {
      for (const [name, spec] of Object.entries(schema.fields)) {
        errors.push(...validateField(name, spec, safeData));
      }
    }

    if (schema.custom) {
      const result = schema.custom(safeData);
      if (Array.isArray(result)) {
        errors.push(...result.filter(Boolean));
      } else if (typeof result === 'string' && result.length > 0) {
        errors.push(result);
      }
    }

    return errors;
  };
}

/**
 * Convenience wrapper: run a schema once against data. Prefer `compileSchema`
 * + cached validator when validating the same schema repeatedly.
 * @param {object} schema
 * @param {object} data
 * @returns {string[]}
 */
export function validateAgainstSchema(schema, data) {
  return compileSchema(schema)(data);
}

export const __private = { SUPPORTED_TYPES, typeLabel, checkType };
