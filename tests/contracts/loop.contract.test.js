// tests/contracts/loop.contract.test.js
// Contract tests pour les commandes loop_* et arrangement_*.
// Fixtures dans tests/contracts/fixtures/loop/*.contract.json.
// Voir tests/contracts/fixtures/README.md pour la méthodologie.

import { jest, describe, test, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import CommandRegistry from '../../src/api/CommandRegistry.js';
import { register as registerLoopCommands } from '../../src/api/commands/LoopCommands.js';
import { register as registerArrangementCommands } from '../../src/api/commands/LoopArrangementCommands.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONTRACTS_DIR = join(__dirname, 'fixtures/loop');

function loadContract(name) {
  return JSON.parse(readFileSync(join(CONTRACTS_DIR, `${name}.contract.json`), 'utf-8'));
}

function createMockApp({ loops = {}, tracks = {}, arrangements = {}, blockCountByLoop = {} } = {}) {
  let nextId = 100;
  const fakeLoopRepo = {
    save: jest.fn(() => ++nextId),
    findAll: jest.fn(() => Object.values(loops)),
    findById: jest.fn((id) => loops[id] ?? null),
    update: jest.fn(),
    delete: jest.fn()
  };
  const fakeArrRepo = {
    save: jest.fn(() => ++nextId),
    findAll: jest.fn(() => Object.values(arrangements)),
    findById: jest.fn((id) => arrangements[id] ?? null),
    update: jest.fn(),
    delete: jest.fn(),
    addTrack: jest.fn(() => ++nextId),
    findTracks: jest.fn(() => []),
    findTrackById: jest.fn((id) => tracks[id] ?? null),
    updateTrack: jest.fn(),
    deleteTrack: jest.fn(),
    addBlock: jest.fn(() => ++nextId),
    findBlocks: jest.fn(() => []),
    findAllBlocks: jest.fn(() => []),
    findFullArrangement: jest.fn(() => ({ tracks: [], blocks: [] })),
    updateBlock: jest.fn(),
    deleteBlock: jest.fn(),
    countBlocksByLoopId: jest.fn((loopId) => blockCountByLoop[loopId] ?? 0)
  };
  return {
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    loopRepository: fakeLoopRepo,
    loopArrangementRepository: fakeArrRepo,
    database: {
      db: {
        // Stub transaction qui exécute la fonction passée immédiatement.
        transaction: (fn) => () => fn()
      }
    }
  };
}

function createMockWs() {
  const messages = [];
  return {
    readyState: 1,
    send: jest.fn((data) => messages.push(JSON.parse(data))),
    _messages: messages
  };
}

function buildRegistry(app) {
  const registry = new CommandRegistry(app);
  registerLoopCommands(registry, app);
  registerArrangementCommands(registry, app);
  return registry;
}

// ── loop_create ───────────────────────────────────────────────────

describe('Contract: loop_create', () => {
  const contract = loadContract('loop_create');

  test('contract metadata is well-formed', () => {
    expect(contract.command).toBe('loop_create');
    expect(Array.isArray(contract.cases)).toBe(true);
    expect(contract.cases.length).toBeGreaterThanOrEqual(2);
  });

  test('nominal — création minimale', async () => {
    const app = createMockApp();
    const registry = buildRegistry(app);
    const ws = createMockWs();
    await registry.handle({ id: 'r', command: 'loop_create', data: { name: 'Mon loop' } }, ws);
    const resp = ws._messages[0];
    expect(resp.type).toBe('response');
    expect(resp.data.loopId).toBeDefined();
    expect(app.loopRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Mon loop' })
    );
  });

  test('error — name manquant', async () => {
    const app = createMockApp();
    const ws = createMockWs();
    await buildRegistry(app).handle({ id: 'r', command: 'loop_create', data: {} }, ws);
    const resp = ws._messages[0];
    expect(resp.type).toBe('error');
    expect(resp.code).toBe('ERR_VALIDATION');
    expect(resp.error).toContain('name is required');
    expect(app.loopRepository.save).not.toHaveBeenCalled();
  });

  test('error — tempo non numérique', async () => {
    const app = createMockApp();
    const ws = createMockWs();
    await buildRegistry(app).handle(
      { id: 'r', command: 'loop_create', data: { name: 'X', tempo: 'fast' } },
      ws
    );
    const resp = ws._messages[0];
    expect(resp.type).toBe('error');
    expect(resp.error).toContain('tempo must be a finite number');
    expect(app.loopRepository.save).not.toHaveBeenCalled();
  });

  test('error — tempo hors bornes', async () => {
    const app = createMockApp();
    const ws = createMockWs();
    await buildRegistry(app).handle(
      { id: 'r', command: 'loop_create', data: { name: 'X', tempo: 9999 } },
      ws
    );
    expect(ws._messages[0].error).toContain('tempo must be between 20 and 300');
  });

  test('error — time_sig_den invalide (0)', async () => {
    const app = createMockApp();
    const ws = createMockWs();
    await buildRegistry(app).handle(
      { id: 'r', command: 'loop_create', data: { name: 'X', time_sig_den: 0 } },
      ws
    );
    expect(ws._messages[0].error).toContain('time_sig_den must be one of');
  });

  test('error — midi_data JSON corrompu', async () => {
    const app = createMockApp();
    const ws = createMockWs();
    await buildRegistry(app).handle(
      { id: 'r', command: 'loop_create', data: { name: 'X', midi_data: '[{not json' } },
      ws
    );
    expect(ws._messages[0].error).toContain('midi_data must be valid JSON');
  });

  test('error — midi_data note malformée', async () => {
    const app = createMockApp();
    const ws = createMockWs();
    await buildRegistry(app).handle(
      {
        id: 'r',
        command: 'loop_create',
        data: {
          name: 'X',
          midi_data: [{ t: 0, n: 999, v: 100, l: 240 }]
        }
      },
      ws
    );
    expect(ws._messages[0].error).toContain('note) must be an integer between 0 and 127');
  });

  test('error — midi_data dépasse la limite de taille', async () => {
    const app = createMockApp();
    const ws = createMockWs();
    // 300 KB de string JSON
    const huge = 'x'.repeat(300 * 1024);
    await buildRegistry(app).handle(
      { id: 'r', command: 'loop_create', data: { name: 'X', midi_data: `"${huge}"` } },
      ws
    );
    expect(ws._messages[0].error).toContain('exceeds');
  });

  test('error — name trop long', async () => {
    const app = createMockApp();
    const ws = createMockWs();
    await buildRegistry(app).handle(
      { id: 'r', command: 'loop_create', data: { name: 'a'.repeat(200) } },
      ws
    );
    expect(ws._messages[0].error).toContain('name must be at most 120');
  });
});

// ── loop_delete ───────────────────────────────────────────────────

describe('Contract: loop_delete', () => {
  test('nominal — sans block référent, cascadedBlocks = 0', async () => {
    const app = createMockApp({ loops: { 1: { id: 1, name: 'L' } } });
    const ws = createMockWs();
    await buildRegistry(app).handle({ id: 'r', command: 'loop_delete', data: { loopId: 1 } }, ws);
    const resp = ws._messages[0];
    expect(resp.type).toBe('response');
    expect(resp.data).toEqual({ success: true, cascadedBlocks: 0 });
    expect(app.loopRepository.delete).toHaveBeenCalledWith(1);
  });

  test('nominal — cascade logged, count exposed', async () => {
    const app = createMockApp({
      loops: { 2: { id: 2 } },
      blockCountByLoop: { 2: 5 }
    });
    const ws = createMockWs();
    await buildRegistry(app).handle({ id: 'r', command: 'loop_delete', data: { loopId: 2 } }, ws);
    expect(ws._messages[0].data.cascadedBlocks).toBe(5);
    expect(app.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('cascaded 5 arrangement block(s)')
    );
  });

  test('error — loopId manquant (validator)', async () => {
    const app = createMockApp();
    const ws = createMockWs();
    await buildRegistry(app).handle({ id: 'r', command: 'loop_delete', data: {} }, ws);
    expect(ws._messages[0].type).toBe('error');
    expect(ws._messages[0].error).toContain('loopId is required');
  });
});

// ── loop_get ──────────────────────────────────────────────────────

describe('Contract: loop_get', () => {
  test('error — loop introuvable', async () => {
    const app = createMockApp();
    const ws = createMockWs();
    await buildRegistry(app).handle({ id: 'r', command: 'loop_get', data: { loopId: 999 } }, ws);
    expect(ws._messages[0].type).toBe('error');
    expect(ws._messages[0].code).toBe('ERR_NOT_FOUND');
  });

  test('nominal — retourne le loop trouvé', async () => {
    const app = createMockApp({ loops: { 1: { id: 1, name: 'X', tempo: 120 } } });
    const ws = createMockWs();
    await buildRegistry(app).handle({ id: 'r', command: 'loop_get', data: { loopId: 1 } }, ws);
    const resp = ws._messages[0];
    expect(resp.type).toBe('response');
    expect(resp.data.loop.id).toBe(1);
  });
});

// ── arrangement_add_block ─────────────────────────────────────────

describe('Contract: arrangement_add_block', () => {
  test('error — trackId manquant (validator)', async () => {
    const app = createMockApp();
    const ws = createMockWs();
    await buildRegistry(app).handle(
      { id: 'r', command: 'arrangement_add_block', data: { loopId: 1 } },
      ws
    );
    expect(ws._messages[0].type).toBe('error');
    expect(ws._messages[0].error).toContain('trackId is required');
  });

  test('error — repetitions hors borne (validator)', async () => {
    const app = createMockApp();
    const ws = createMockWs();
    await buildRegistry(app).handle(
      {
        id: 'r',
        command: 'arrangement_add_block',
        data: { trackId: 1, loopId: 1, repetitions: 999 }
      },
      ws
    );
    expect(ws._messages[0].error).toContain('repetitions must be an integer between 1 and 256');
  });

  test('error — trackId inexistant (handler)', async () => {
    const app = createMockApp(); // tracks vide
    const ws = createMockWs();
    await buildRegistry(app).handle(
      { id: 'r', command: 'arrangement_add_block', data: { trackId: 99999, loopId: 1 } },
      ws
    );
    expect(ws._messages[0].type).toBe('error');
    expect(ws._messages[0].code).toBe('ERR_NOT_FOUND');
  });

  test('error — loopId inexistant (handler)', async () => {
    const app = createMockApp({
      tracks: { 1: { id: 1, arrangement_id: 10 } },
      arrangements: { 10: { id: 10, total_bars: 16 } }
    });
    const ws = createMockWs();
    await buildRegistry(app).handle(
      { id: 'r', command: 'arrangement_add_block', data: { trackId: 1, loopId: 99999 } },
      ws
    );
    expect(ws._messages[0].type).toBe('error');
    expect(ws._messages[0].code).toBe('ERR_NOT_FOUND');
  });

  test('error — position_bar dépasse total_bars (handler)', async () => {
    const app = createMockApp({
      tracks: { 1: { id: 1, arrangement_id: 10 } },
      arrangements: { 10: { id: 10, total_bars: 16 } },
      loops: { 1: { id: 1 } }
    });
    const ws = createMockWs();
    await buildRegistry(app).handle(
      {
        id: 'r',
        command: 'arrangement_add_block',
        data: { trackId: 1, loopId: 1, position_bar: 50 }
      },
      ws
    );
    expect(ws._messages[0].type).toBe('error');
    expect(ws._messages[0].error).toContain('position_bar must be < arrangement total_bars (16)');
  });

  test('nominal — ajout réussi', async () => {
    const app = createMockApp({
      tracks: { 1: { id: 1, arrangement_id: 10 } },
      arrangements: { 10: { id: 10, total_bars: 16 } },
      loops: { 1: { id: 1 } }
    });
    const ws = createMockWs();
    await buildRegistry(app).handle(
      {
        id: 'r',
        command: 'arrangement_add_block',
        data: { trackId: 1, loopId: 1, position_bar: 4, repetitions: 2 }
      },
      ws
    );
    expect(ws._messages[0].type).toBe('response');
    expect(ws._messages[0].data.blockId).toBeDefined();
    expect(app.loopArrangementRepository.addBlock).toHaveBeenCalledWith({
      track_id: 1,
      loop_id: 1,
      position_bar: 4,
      repetitions: 2
    });
  });
});

// ── arrangement_create transaction ────────────────────────────────

describe('Contract: arrangement_create', () => {
  test('nominal — création + 3 tracks dans une transaction', async () => {
    const app = createMockApp();
    const txnSpy = jest.fn((fn) => () => fn());
    app.database.db.transaction = txnSpy;
    const ws = createMockWs();
    await buildRegistry(app).handle(
      { id: 'r', command: 'arrangement_create', data: { name: 'Test Arr' } },
      ws
    );
    const resp = ws._messages[0];
    expect(resp.type).toBe('response');
    expect(resp.data.arrangementId).toBeDefined();
    expect(txnSpy).toHaveBeenCalledTimes(1);
    expect(app.loopArrangementRepository.save).toHaveBeenCalledTimes(1);
    expect(app.loopArrangementRepository.addTrack).toHaveBeenCalledTimes(3);
    // Labels vides côté serveur — i18n côté client.
    expect(app.loopArrangementRepository.addTrack).toHaveBeenCalledWith(
      expect.objectContaining({ label: '' })
    );
  });

  test('error — name manquant', async () => {
    const app = createMockApp();
    const ws = createMockWs();
    await buildRegistry(app).handle({ id: 'r', command: 'arrangement_create', data: {} }, ws);
    expect(ws._messages[0].type).toBe('error');
    expect(ws._messages[0].error).toContain('name is required');
  });
});
