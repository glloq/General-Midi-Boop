// src/storage/dbHelpers.js

/**
 * Build a dynamic UPDATE statement from an updates object.
 * Only includes fields present in allowedFields.
 *
 * @param {string} table - Table name
 * @param {Object} updates - Key-value pairs to update
 * @param {string[]} allowedFields - Whitelist of allowed column names
 * @param {Object} [options] - Options
 * @param {Object.<string, Function>} [options.transforms] - Per-field value transform functions
 * @param {string} [options.whereClause] - WHERE clause (default: 'id = ?')
 * @returns {{ sql: string, values: any[] } | null} SQL and values, or null if no fields to update
 */
export function buildDynamicUpdate(table, updates, allowedFields, options = {}) {
  const { transforms = {}, whereClause = 'id = ?' } = options;
  const fields = [];
  const values = [];

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      fields.push(`${field} = ?`);
      const transform = transforms[field];
      values.push(transform ? transform(updates[field]) : updates[field]);
    }
  }

  if (fields.length === 0) return null;

  const sql = `UPDATE ${table} SET ${fields.join(', ')} WHERE ${whereClause}`;
  return { sql, values };
}
