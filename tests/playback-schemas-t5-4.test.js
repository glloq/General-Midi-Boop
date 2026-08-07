// tests/playback-schemas-t5-4.test.js
// T5.4 (P2-1): payload schemas for commands that previously fell through to the
// permissive validator (channel keys / numeric ranges reached the handler
// unbounded). Verifies required-field messages are preserved and edge bounds
// are now enforced at the WS edge.

import { describe, test, expect } from '@jest/globals';
import JsonValidator from '../src/utils/JsonValidator.js';

const v = (cmd, data) => JsonValidator.validateByCommand(cmd, data);

describe('T5.4 — apply_assignments', () => {
  test('valid payload passes (channels 0-15)', () => {
    expect(v('apply_assignments', { originalFileId: 1, assignments: { 0: {}, 15: {} } }).valid).toBe(
      true
    );
  });
  test('missing originalFileId is rejected', () => {
    const r = v('apply_assignments', { assignments: {} });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/originalFileId is required/);
  });
  test('assignments must be an object, not an array', () => {
    expect(v('apply_assignments', { originalFileId: 1, assignments: [] }).valid).toBe(false);
  });
  test('a channel key outside 0-15 is rejected', () => {
    const r = v('apply_assignments', { originalFileId: 1, assignments: { 16: {} } });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/between 0 and 15/);
  });
});

describe('T5.4 — analyze_channel', () => {
  test('valid payload passes', () => {
    expect(v('analyze_channel', { fileId: 1, channel: 9 }).valid).toBe(true);
  });
  test('missing channel is rejected', () => {
    expect(v('analyze_channel', { fileId: 1 }).valid).toBe(false);
  });
  test('channel out of range is rejected', () => {
    const r = v('analyze_channel', { fileId: 1, channel: 99 });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/between 0 and 15/);
  });
});

describe('T5.4 — generate_assignment_suggestions', () => {
  test('valid payload with bounds passes', () => {
    expect(v('generate_assignment_suggestions', { fileId: 1, topN: 5, minScore: 30 }).valid).toBe(
      true
    );
  });
  test('fileId is required', () => {
    expect(v('generate_assignment_suggestions', {}).valid).toBe(false);
  });
  test('topN and minScore are bounded', () => {
    expect(v('generate_assignment_suggestions', { fileId: 1, topN: 0 }).valid).toBe(false);
    expect(v('generate_assignment_suggestions', { fileId: 1, minScore: 500 }).valid).toBe(false);
  });
});

describe('T5.4 — get_file_routings', () => {
  test('valid payload passes', () => {
    expect(v('get_file_routings', { fileId: 1 }).valid).toBe(true);
  });
  test('fileId is required', () => {
    const r = v('get_file_routings', {});
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/fileId is required/);
  });
});
