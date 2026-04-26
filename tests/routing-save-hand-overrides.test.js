// tests/routing-save-hand-overrides.test.js
// E.6.1: routing_save_hand_overrides WS command. Validates the input
// shape, delegates to RoutingRepository.saveHandOverrides, and
// returns the updated row count. We drive the exported helper
// directly with a stub `app` — no SQLite, no full DI.

import { describe, test, expect, jest } from '@jest/globals';
import { routingSaveHandOverrides } from '../src/api/commands/RoutingCommands.js';
import { ValidationError } from '../src/core/errors/index.js';

const silentLogger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

function makeApp({ repo = {}, savedRowCount = 1 } = {}) {
  return {
    logger: silentLogger,
    routingRepository: {
      saveHandOverrides: jest.fn(() => savedRowCount),
      ...repo
    }
  };
}

const validOverrides = {
  hand_anchors:   [{ tick: 1920, handId: 'left', anchor: 60 }],
  disabled_notes: [{ tick: 480, note: 100, reason: 'out_of_range' }],
  version: 1
};

describe('routing_save_hand_overrides — input validation', () => {
  test('throws when fileId is missing', async () => {
    await expect(routingSaveHandOverrides(makeApp(), { channel: 0, deviceId: 'p' }))
      .rejects.toThrow(ValidationError);
  });

  test('throws when deviceId is missing', async () => {
    await expect(routingSaveHandOverrides(makeApp(), { fileId: 1, channel: 0 }))
      .rejects.toThrow(ValidationError);
  });

  test('throws when channel is missing', async () => {
    await expect(routingSaveHandOverrides(makeApp(), { fileId: 1, deviceId: 'p' }))
      .rejects.toThrow(ValidationError);
  });

  test('throws when channel is out of range', async () => {
    await expect(routingSaveHandOverrides(makeApp(), {
      fileId: 1, deviceId: 'p', channel: 99
    })).rejects.toThrow(/0 and 15/);
  });

  test('throws when overrides is an array (not an object)', async () => {
    await expect(routingSaveHandOverrides(makeApp(), {
      fileId: 1, deviceId: 'p', channel: 0, overrides: [1, 2, 3]
    })).rejects.toThrow(/object or null/);
  });

  test('throws when overrides has neither hand_anchors, disabled_notes nor note_assignments', async () => {
    await expect(routingSaveHandOverrides(makeApp(), {
      fileId: 1, deviceId: 'p', channel: 0, overrides: { version: 1 }
    })).rejects.toThrow(/hand_anchors,\s*disabled_notes\s*and\/or\s*note_assignments/);
  });

  test('throws when a note_assignments entry is malformed', async () => {
    await expect(routingSaveHandOverrides(makeApp(), {
      fileId: 1, deviceId: 'p', channel: 0,
      overrides: {
        hand_anchors: [],
        note_assignments: [{ tick: 0, note: 60, string: 'low' /* fret missing */ }]
      }
    })).rejects.toThrow(/tick, note, string, fret/);
  });

  test('accepts a valid note_assignments entry', async () => {
    const app = makeApp({ savedRowCount: 1 });
    const res = await routingSaveHandOverrides(app, {
      fileId: 1, deviceId: 'p', channel: 0,
      overrides: {
        hand_anchors: [],
        note_assignments: [{ tick: 480, note: 64, string: 3, fret: 4 }]
      }
    });
    expect(res).toEqual({ success: true, updated: 1 });
    expect(app.routingRepository.saveHandOverrides).toHaveBeenCalledTimes(1);
  });

  test('throws when a hand_anchor entry is malformed', async () => {
    await expect(routingSaveHandOverrides(makeApp(), {
      fileId: 1, deviceId: 'p', channel: 0,
      overrides: { hand_anchors: [{ tick: 0, handId: 'left' /* anchor missing */ }], disabled_notes: [] }
    })).rejects.toThrow(/tick, handId, anchor/);
  });

  test('throws when a disabled_notes entry is malformed', async () => {
    await expect(routingSaveHandOverrides(makeApp(), {
      fileId: 1, deviceId: 'p', channel: 0,
      overrides: { hand_anchors: [], disabled_notes: [{ tick: 0 /* note missing */ }] }
    })).rejects.toThrow(/tick, note/);
  });
});

describe('routing_save_hand_overrides — happy paths', () => {
  test('forwards a valid payload to the repo and returns updated count', async () => {
    const app = makeApp({ savedRowCount: 1 });
    const r = await routingSaveHandOverrides(app, {
      fileId: 42, channel: 3, deviceId: 'piano-1', overrides: validOverrides
    });
    expect(r).toEqual({ success: true, updated: 1 });
    expect(app.routingRepository.saveHandOverrides).toHaveBeenCalledWith(42, 3, 'piano-1', validOverrides);
  });

  test('passes null straight through to clear the column', async () => {
    const app = makeApp();
    await routingSaveHandOverrides(app, {
      fileId: 1, channel: 0, deviceId: 'piano-1', overrides: null
    });
    expect(app.routingRepository.saveHandOverrides).toHaveBeenCalledWith(1, 0, 'piano-1', null);
  });

  test('treats undefined overrides like null (clear)', async () => {
    const app = makeApp();
    await routingSaveHandOverrides(app, {
      fileId: 1, channel: 0, deviceId: 'piano-1'
      // no overrides field
    });
    expect(app.routingRepository.saveHandOverrides).toHaveBeenCalledWith(1, 0, 'piano-1', null);
  });

  test('reports updated=0 when no row matched', async () => {
    const app = makeApp({ savedRowCount: 0 });
    const r = await routingSaveHandOverrides(app, {
      fileId: 1, channel: 0, deviceId: 'unknown-device', overrides: validOverrides
    });
    expect(r.updated).toBe(0);
  });

  test('accepts a payload with only hand_anchors', async () => {
    const app = makeApp();
    await expect(routingSaveHandOverrides(app, {
      fileId: 1, channel: 0, deviceId: 'p',
      overrides: { hand_anchors: [{ tick: 0, handId: 'left', anchor: 60 }] }
    })).resolves.toEqual(expect.objectContaining({ success: true }));
  });

  test('accepts a payload with only disabled_notes', async () => {
    const app = makeApp();
    await expect(routingSaveHandOverrides(app, {
      fileId: 1, channel: 0, deviceId: 'p',
      overrides: { disabled_notes: [{ tick: 0, note: 60 }] }
    })).resolves.toEqual(expect.objectContaining({ success: true }));
  });
});

describe('routing_save_hand_overrides — DI failures', () => {
  test('throws when the repository helper is not wired', async () => {
    const app = { logger: silentLogger, routingRepository: {} };
    await expect(routingSaveHandOverrides(app, {
      fileId: 1, channel: 0, deviceId: 'p', overrides: null
    })).rejects.toThrow(/routing repository is not wired/);
  });
});
