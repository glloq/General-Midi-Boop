// src/api/commands/schemas/playback.schemas.js
// Declarative schemas for playback WS commands (P1-3.2a, ADR-004).
//
// Each schema preserves the exact error messages currently emitted by
// `JsonValidator.validatePlaybackCommand`, as captured in the WS contract
// snapshots (`docs/refactor/contracts/playback/*.contract.json`). The
// double-error shape (`"X is required, X must be Y"`) is intentional: it
// matches the historical behaviour where `JsonValidator` lets a missing
// field also fail the type check.

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

// Indexed by command name — consumed by JsonValidator.validatePlaybackCommand
// which now first looks up this map before falling back to the legacy switch.
const schemas = {
  playback_start,
  playback_seek,
  playback_set_loop
};

export default schemas;
