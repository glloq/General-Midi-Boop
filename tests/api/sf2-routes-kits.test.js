// tests/api/sf2-routes-kits.test.js
// Verifies the GET /api/sf2/:id/kits endpoint surfaces the SF2's real
// drum-kit inventory (used by the frontend to grey out kits the SF2
// can't actually play, avoiding silent Standard-Kit fallbacks).

import { jest, describe, test, expect } from '@jest/globals';
import express from 'express';
import http from 'http';
import { createSF2Router } from '../../src/api/sf2Routes.js';

function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function fetchJSON(server, path) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${path}`, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: body ? JSON.parse(body) : null });
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

function makeAppStub({ drumKits = [], drumBank = 128, melodicPrograms = [] } = {}) {
  return {
    logger: { info() {}, warn() {}, error() {} },
    sf2PresetService: {
      listAll: () => [],
      hasDefaultSF2: () => true,
      inspectDrumKits: jest.fn(() => ({ kits: drumKits, bankNum: drumBank })),
      inspectMelodicPrograms: jest.fn(() => melodicPrograms)
    },
    database: { customSF2DB: {} }
  };
}

describe('GET /api/sf2/:id/kits', () => {
  test('returns the drum kit inventory and melodic programs for the default SF2', async () => {
    const appStub = makeAppStub({
      drumKits: [0, 8, 16],
      drumBank: 128,
      melodicPrograms: [0, 1, 2, 8, 56]
    });
    const httpApp = express();
    httpApp.use('/api/sf2', createSF2Router(appStub));
    const server = await startServer(httpApp);

    try {
      const { status, json } = await fetchJSON(server, '/api/sf2/default/kits');
      expect(status).toBe(200);
      expect(json).toEqual({
        drumKits: [0, 8, 16],
        drumBank: 128,
        melodicPrograms: [0, 1, 2, 8, 56]
      });
      expect(appStub.sf2PresetService.inspectDrumKits).toHaveBeenCalledWith('default');
      expect(appStub.sf2PresetService.inspectMelodicPrograms).toHaveBeenCalledWith('default');
    } finally {
      server.close();
    }
  });

  test('returns empty arrays when the SF2 has no presets', async () => {
    const appStub = makeAppStub({ drumKits: [], melodicPrograms: [] });
    const httpApp = express();
    httpApp.use('/api/sf2', createSF2Router(appStub));
    const server = await startServer(httpApp);

    try {
      const { status, json } = await fetchJSON(server, '/api/sf2/default/kits');
      expect(status).toBe(200);
      expect(json.drumKits).toEqual([]);
      expect(json.melodicPrograms).toEqual([]);
    } finally {
      server.close();
    }
  });

  test('rejects invalid ids', async () => {
    const appStub = makeAppStub();
    const httpApp = express();
    httpApp.use('/api/sf2', createSF2Router(appStub));
    const server = await startServer(httpApp);

    try {
      const { status } = await fetchJSON(server, '/api/sf2/not-a-valid-id/kits');
      expect(status).toBe(400);
      expect(appStub.sf2PresetService.inspectDrumKits).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  test('routes numeric ids to the service', async () => {
    const appStub = makeAppStub({ drumKits: [0], drumBank: 128, melodicPrograms: [0] });
    const httpApp = express();
    httpApp.use('/api/sf2', createSF2Router(appStub));
    const server = await startServer(httpApp);

    try {
      await fetchJSON(server, '/api/sf2/42/kits');
      expect(appStub.sf2PresetService.inspectDrumKits).toHaveBeenCalledWith(42);
      expect(appStub.sf2PresetService.inspectMelodicPrograms).toHaveBeenCalledWith(42);
    } finally {
      server.close();
    }
  });

  test('accepts id=0 as the built-in default sentinel (migration 020)', async () => {
    // Some UI paths surface the bundled SF2 as `sf2:0` (the sentinel
    // DB row inserted by migration 020) instead of `sf2:default`.
    // Both must resolve to the same built-in soundfont — pre-fix the
    // 0 was rejected with 400 and every preset request failed.
    const appStub = makeAppStub({
      drumKits: [0, 8],
      drumBank: 128,
      melodicPrograms: [0]
    });
    const httpApp = express();
    httpApp.use('/api/sf2', createSF2Router(appStub));
    const server = await startServer(httpApp);

    try {
      const { status } = await fetchJSON(server, '/api/sf2/0/kits');
      expect(status).toBe(200);
      expect(appStub.sf2PresetService.inspectDrumKits).toHaveBeenCalledWith('default');
    } finally {
      server.close();
    }
  });
});
