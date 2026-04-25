// tests/routing-persistence-feasibility.test.js
// D.1: midi_instrument_routings.hand_position_feasibility (JSON column).
// We verify the persistence-layer's serialize/parse handles all the
// shapes the apply path produces:
//   - undefined / null payloads stay null;
//   - object payloads are JSON-stringified at write;
//   - already-stringified payloads pass through;
//   - reads parse the JSON back to a plain object;
//   - corrupt JSON in the row is ignored (logged, not thrown).
//
// Tests target a stubbed `db` so the SQLite native binding (which fails
// in this sandbox) is not required.

import { describe, test, expect, jest } from '@jest/globals';
import RoutingPersistenceDB from '../src/persistence/tables/RoutingPersistenceDB.js';

function makeStubDb() {
  let runs = [];
  let lastInsertId = 1;
  const prepare = jest.fn((sql) => ({
    run: (...args) => { runs.push({ sql, args }); return { lastInsertRowid: lastInsertId++ }; },
    all: () => [],
    get: () => null
  }));
  return { db: { prepare }, runs: () => runs };
}

const silentLogger = { info: () => {}, warn: jest.fn(), debug: () => {}, error: () => {} };

function makeRoutingFixture(extra = {}) {
  return {
    midi_file_id: 1,
    channel: 0,
    device_id: 'piano-1',
    instrument_name: 'Grand Piano',
    enabled: true,
    auto_assigned: true,
    compatibility_score: 85,
    transposition_applied: 0,
    assignment_reason: 'Auto',
    note_remapping: null,
    created_at: 1700000000000,
    ...extra
  };
}

describe('RoutingPersistenceDB.insertRouting — hand_position_feasibility serialization', () => {
  // After E.6.1 (overrides column added) the column order is:
  //   ..., hand_position_feasibility, hand_position_overrides
  // → feasibility lives at args[length - 2], overrides at args[length - 1].
  const FEASIBILITY_AT = -2;

  test('null when routing.hand_position_feasibility is missing', () => {
    const stub = makeStubDb();
    const repo = new RoutingPersistenceDB(stub.db, silentLogger);
    repo.insertRouting(makeRoutingFixture());
    const args = stub.runs()[0].args;
    expect(args[args.length + FEASIBILITY_AT]).toBeNull();
  });

  test('serialises an object payload to JSON', () => {
    const stub = makeStubDb();
    const repo = new RoutingPersistenceDB(stub.db, silentLogger);
    const payload = { level: 'warning', qualityScore: 70, summary: { mode: 'frets' }, message: 'wide chord' };
    repo.insertRouting(makeRoutingFixture({ hand_position_feasibility: payload }));
    const args = stub.runs()[0].args;
    const stored = args[args.length + FEASIBILITY_AT];
    expect(typeof stored).toBe('string');
    expect(JSON.parse(stored)).toEqual(payload);
  });

  test('passes through an already-stringified payload', () => {
    const stub = makeStubDb();
    const repo = new RoutingPersistenceDB(stub.db, silentLogger);
    const json = JSON.stringify({ level: 'ok' });
    repo.insertRouting(makeRoutingFixture({ hand_position_feasibility: json }));
    const args = stub.runs()[0].args;
    expect(args[args.length + FEASIBILITY_AT]).toBe(json);
  });

  test('persists feasibility on a split routing too', () => {
    const stub = makeStubDb();
    const repo = new RoutingPersistenceDB(stub.db, silentLogger);
    repo.insertRouting(makeRoutingFixture({
      split_mode: 'range',
      split_note_min: 0, split_note_max: 59,
      hand_position_feasibility: { level: 'infeasible' }
    }));
    const args = stub.runs()[0].args;
    expect(args[args.length + FEASIBILITY_AT]).toBe('{"level":"infeasible"}');
  });
});

describe('RoutingPersistenceDB.getRoutingsByFile — hand_position_feasibility parsing', () => {
  function makeStubDbWithRows(rows) {
    return {
      db: {
        prepare: () => ({
          all: () => rows,
          get: () => null,
          run: () => ({ changes: 0 })
        })
      }
    };
  }

  test('null in DB → null in output', () => {
    const repo = new RoutingPersistenceDB(makeStubDbWithRows([
      { id: 1, midi_file_id: 1, channel: 0, hand_position_feasibility: null }
    ]).db, silentLogger);
    const out = repo.getRoutingsByFile(1);
    expect(out[0].hand_position_feasibility).toBeNull();
  });

  test('valid JSON in DB → parsed object in output', () => {
    const repo = new RoutingPersistenceDB(makeStubDbWithRows([
      { id: 2, midi_file_id: 1, channel: 0, hand_position_feasibility: '{"level":"warning","qualityScore":70}' }
    ]).db, silentLogger);
    const out = repo.getRoutingsByFile(1);
    expect(out[0].hand_position_feasibility).toEqual({ level: 'warning', qualityScore: 70 });
  });

  test('invalid JSON in DB → null + logger warning, no throw', () => {
    const warn = jest.fn();
    const repo = new RoutingPersistenceDB(makeStubDbWithRows([
      { id: 7, midi_file_id: 1, channel: 0, hand_position_feasibility: '{ not json' }
    ]).db, { ...silentLogger, warn });
    const out = repo.getRoutingsByFile(1);
    expect(out[0].hand_position_feasibility).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

describe('RoutingPersistenceDB — hand_position_overrides serialize/parse (E.6.1)', () => {
  function makeStubDb() {
    let runs = [];
    let lastInsertId = 1;
    const prepare = jest.fn((sql) => ({
      run: (...args) => { runs.push({ sql, args }); return { lastInsertRowid: lastInsertId++, changes: 1 }; },
      all: () => [],
      get: () => null
    }));
    return { db: { prepare }, runs: () => runs };
  }
  function makeRoutingFixture(extra = {}) {
    return {
      midi_file_id: 1, channel: 0, device_id: 'piano-1',
      instrument_name: 'Grand Piano', enabled: true, auto_assigned: true,
      compatibility_score: 85, transposition_applied: 0,
      assignment_reason: 'Auto', note_remapping: null,
      created_at: 1700000000000,
      ...extra
    };
  }

  test('null when routing.hand_position_overrides is missing (standard INSERT)', () => {
    const stub = makeStubDb();
    const repo = new RoutingPersistenceDB(stub.db, silentLogger);
    repo.insertRouting(makeRoutingFixture());
    const args = stub.runs()[0].args;
    // Last arg of the standard INSERT is the overrides JSON column.
    expect(args[args.length - 1]).toBeNull();
  });

  test('serialises an object overrides payload to JSON', () => {
    const stub = makeStubDb();
    const repo = new RoutingPersistenceDB(stub.db, silentLogger);
    const overrides = {
      hand_anchors: [{ tick: 1920, handId: 'left', anchor: 60 }],
      disabled_notes: [{ tick: 480, note: 100, reason: 'out_of_range' }],
      version: 1
    };
    repo.insertRouting(makeRoutingFixture({ hand_position_overrides: overrides }));
    const args = stub.runs()[0].args;
    const stored = args[args.length - 1];
    expect(typeof stored).toBe('string');
    expect(JSON.parse(stored)).toEqual(overrides);
  });

  test('passes through an already-stringified overrides payload', () => {
    const stub = makeStubDb();
    const repo = new RoutingPersistenceDB(stub.db, silentLogger);
    const json = JSON.stringify({ hand_anchors: [], disabled_notes: [], version: 1 });
    repo.insertRouting(makeRoutingFixture({ hand_position_overrides: json }));
    const args = stub.runs()[0].args;
    expect(args[args.length - 1]).toBe(json);
  });

  test('persists overrides on a split routing too (last column)', () => {
    const stub = makeStubDb();
    const repo = new RoutingPersistenceDB(stub.db, silentLogger);
    const overrides = { hand_anchors: [], disabled_notes: [{ tick: 0, note: 60 }], version: 1 };
    repo.insertRouting(makeRoutingFixture({
      split_mode: 'range',
      split_note_min: 0, split_note_max: 59,
      hand_position_overrides: overrides
    }));
    const args = stub.runs()[0].args;
    expect(args[args.length - 1]).toBe(JSON.stringify(overrides));
  });

  test('updateHandOverrides issues an UPDATE keyed on (file, channel, device)', () => {
    const stub = makeStubDb();
    const repo = new RoutingPersistenceDB(stub.db, silentLogger);
    const ov = { hand_anchors: [{ tick: 0, handId: 'left', anchor: 60 }], disabled_notes: [], version: 1 };
    const updated = repo.updateHandOverrides(42, 1, 'piano-1', ov);
    expect(updated).toBe(1);
    const r = stub.runs()[0];
    expect(r.sql).toMatch(/UPDATE midi_instrument_routings/);
    expect(r.sql).toMatch(/hand_position_overrides/);
    expect(r.args).toEqual([JSON.stringify(ov), 42, 1, 'piano-1']);
  });

  test('updateHandOverrides accepts null to clear', () => {
    const stub = makeStubDb();
    const repo = new RoutingPersistenceDB(stub.db, silentLogger);
    repo.updateHandOverrides(1, 0, 'piano-1', null);
    expect(stub.runs()[0].args[0]).toBeNull();
  });

  test('getRoutingsByFile parses hand_position_overrides JSON', () => {
    const repo = new RoutingPersistenceDB({
      prepare: () => ({
        all: () => [{
          id: 9, midi_file_id: 1, channel: 0,
          hand_position_overrides: '{"hand_anchors":[{"tick":480,"handId":"right","anchor":72}],"disabled_notes":[],"version":1}'
        }],
        get: () => null,
        run: () => ({ changes: 0 })
      })
    }, silentLogger);
    const out = repo.getRoutingsByFile(1);
    expect(out[0].hand_position_overrides).toEqual({
      hand_anchors: [{ tick: 480, handId: 'right', anchor: 72 }],
      disabled_notes: [],
      version: 1
    });
  });

  test('getRoutingsByFile returns null on invalid overrides JSON without throwing', () => {
    const warn = jest.fn();
    const repo = new RoutingPersistenceDB({
      prepare: () => ({
        all: () => [{ id: 11, midi_file_id: 1, channel: 0, hand_position_overrides: '{ broken' }],
        get: () => null,
        run: () => ({ changes: 0 })
      })
    }, { ...silentLogger, warn });
    const out = repo.getRoutingsByFile(1);
    expect(out[0].hand_position_overrides).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});
