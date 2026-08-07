/**
 * @file src/api/commands/schemas/playback.schemas.js
 * @description Declarative validation schemas for `playback_*` WebSocket
 * commands (P1-3.2a, ADR-004). Consumed by
 * `JsonValidator.validatePlaybackCommand` via the `COMPILED_SCHEMAS`
 * lookup table.
 *
 * Each schema reproduces the exact error messages emitted by the legacy
 * imperative validators, captured in
 * `tests/contracts/fixtures/playback/*.contract.json`. The intentional
 * double-error pattern (`"X is required, X must be Y"`) preserves
 * historical behaviour where missing fields also fail the type check.
 */

export const playback_start = {
  custom: (data) => {
    if (!data.fileId && !data.outputDevice) {
      return 'fileId or outputDevice is required';
    }
    return null;
  }
};

export const playback_seek = {
  custom: (data) => {
    const errors = [];
    if (data.position === undefined) {
      errors.push('position is required');
    }
    if (typeof data.position !== 'number' || data.position < 0) {
      errors.push('position must be a positive number');
    }
    return errors;
  }
};

export const playback_set_loop = {
  custom: (data) => {
    const errors = [];
    if (data.enabled === undefined) {
      errors.push('enabled is required');
    }
    if (typeof data.enabled !== 'boolean') {
      errors.push('enabled must be a boolean');
    }
    return errors;
  }
};

export const playback_transpose = {
  custom: (data) => {
    if (data.semitones === undefined) return 'semitones is required';
    if (!Number.isInteger(data.semitones) || data.semitones < -48 || data.semitones > 48) {
      return 'semitones must be an integer between -48 and 48';
    }
    return null;
  }
};

// T5.4 (P2-1) — these command handlers previously fell through to the permissive
// default validator, so channel keys and numeric ranges reached the handler
// unbounded. The schemas below keep the handlers' own required-field messages and
// add the missing edge bounds (channel 0-15, sane numeric ranges).

export const apply_assignments = {
  custom: (data) => {
    const errors = [];
    if (!data.originalFileId) errors.push('originalFileId is required');
    if (!data.assignments) {
      errors.push('assignments is required');
    } else if (typeof data.assignments !== 'object' || Array.isArray(data.assignments)) {
      errors.push('assignments must be an object keyed by channel');
    } else {
      for (const key of Object.keys(data.assignments)) {
        const ch = Number(key);
        if (!Number.isInteger(ch) || ch < 0 || ch > 15) {
          errors.push('assignments channel keys must be integers between 0 and 15');
          break;
        }
      }
    }
    return errors;
  }
};

export const analyze_channel = {
  custom: (data) => {
    const errors = [];
    if (!data.fileId) errors.push('fileId is required');
    if (data.channel === undefined) {
      errors.push('channel is required');
    } else if (!Number.isInteger(data.channel) || data.channel < 0 || data.channel > 15) {
      errors.push('channel must be an integer between 0 and 15');
    }
    return errors;
  }
};

export const generate_assignment_suggestions = {
  custom: (data) => {
    const errors = [];
    if (!data.fileId) errors.push('fileId is required');
    if (
      data.topN !== undefined &&
      (!Number.isInteger(data.topN) || data.topN < 1 || data.topN > 50)
    ) {
      errors.push('topN must be an integer between 1 and 50');
    }
    if (
      data.minScore !== undefined &&
      (typeof data.minScore !== 'number' || data.minScore < 0 || data.minScore > 100)
    ) {
      errors.push('minScore must be a number between 0 and 100');
    }
    return errors;
  }
};

export const get_file_routings = {
  custom: (data) => {
    if (!data.fileId) return 'fileId is required';
    return null;
  }
};

// Indexed by command name — consumed by JsonValidator.validatePlaybackCommand
// which now first looks up this map before falling back to the legacy switch.
const schemas = {
  playback_start,
  playback_seek,
  playback_set_loop,
  playback_transpose,
  apply_assignments,
  analyze_channel,
  generate_assignment_suggestions,
  get_file_routings
};

export default schemas;
