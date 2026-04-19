// tests/repositories/repository-delegations.test.js
// Unit tests verifying that each Repository correctly delegates its public
// API to the underlying Database facade. Ensures the thin-wrapper pattern
// (ADR-002 option B) stays in sync with the sub-DB surface.

import { jest, describe, test, expect } from '@jest/globals';
import FileRepository from '../../src/repositories/FileRepository.js';
import RoutingRepository from '../../src/repositories/RoutingRepository.js';
import InstrumentRepository from '../../src/repositories/InstrumentRepository.js';
import PresetRepository from '../../src/repositories/PresetRepository.js';
import SessionRepository from '../../src/repositories/SessionRepository.js';
import PlaylistRepository from '../../src/repositories/PlaylistRepository.js';
import LightingRepository from '../../src/repositories/LightingRepository.js';
import DeviceSettingsRepository from '../../src/repositories/DeviceSettingsRepository.js';
import StringInstrumentRepository from '../../src/repositories/StringInstrumentRepository.js';

function makeDb(methods = []) {
  const db = {};
  for (const m of methods) db[m] = jest.fn().mockReturnValue(`ret:${m}`);
  return db;
}

describe('FileRepository — delegations', () => {
  const cases = [
    ['findById', 'getFile', ['f1']],
    ['findInfoById', 'getFileInfo', ['f1']],
    ['findByFolder', 'getFiles', ['/']],
    ['save', 'insertFile', [{ filename: 'a.mid' }]],
    ['update', 'updateFile', ['f1', { name: 'x' }]],
    ['delete', 'deleteFile', ['f1']],
    ['getChannels', 'getFileChannels', ['f1']],
    ['search', 'searchFiles', ['q']],
    ['filter', 'filterFiles', [{ folder: '/' }]],
    ['countNeedingReanalysis', 'countFilesNeedingReanalysis', []],
    ['getDistinctInstruments', 'getDistinctInstruments', []],
    ['getDistinctCategories', 'getDistinctCategories', []],
    ['transaction', 'transaction', [() => {}]]
  ];

  test.each(cases)('%s delegates to db.%s', (repoMethod, dbMethod, args) => {
    const db = makeDb([dbMethod]);
    const repo = new FileRepository(db);
    const r = repo[repoMethod](...args);
    expect(db[dbMethod]).toHaveBeenCalledWith(...args);
    expect(r).toBe(`ret:${dbMethod}`);
  });
});

describe('RoutingRepository — delegations', () => {
  const cases = [
    ['save', 'insertRouting', [{ channel: 0 }]],
    ['saveSplit', 'insertSplitRoutings', [1, 0, []]],
    ['findByFileId', 'getRoutingsByFile', [1, true]],
    ['countByFiles', 'getRoutingCountsByFiles', [[1, 2], new Set()]],
    ['deleteByFileId', 'deleteRoutingsByFile', [1]],
    ['deleteByDevice', 'deleteRoutingsByDevice', ['dev-1', undefined]],
    ['transaction', 'transaction', [() => {}]]
  ];

  test.each(cases)('%s delegates to db.%s', (repoMethod, dbMethod, args) => {
    const db = makeDb([dbMethod]);
    const repo = new RoutingRepository(db);
    const r = repo[repoMethod](...args);
    expect(db[dbMethod]).toHaveBeenCalledWith(...args);
    expect(r).toBe(`ret:${dbMethod}`);
  });
});

describe('InstrumentRepository — delegations', () => {
  // v6 note: the generic `instruments` table was dropped. Per-channel rows
  // live on `instruments_latency`; generic helpers (`findAll`, `save`,
  // `delete`, `deleteLatencyProfile`) no longer exist on the repository.
  // `findById` / `update` delegate to the row-PK variants.
  const cases = [
    ['findById', 'findInstrumentById', ['i1']],
    ['findAllWithCapabilities', 'getInstrumentsWithCapabilities', []],
    ['update', 'updateInstrumentById', ['i1', { x: 1 }]],
    ['getCapabilities', 'getInstrumentCapabilities', ['dev-1', 0]],
    ['updateCapabilities', 'updateInstrumentCapabilities', ['dev-1', 0, {}]],
    ['updateSettings', 'updateInstrumentSettings', ['dev-1', 0, {}]],
    ['getSettings', 'getInstrumentSettings', ['dev-1', 0]],
    ['findByDevice', 'getInstrumentsByDevice', ['dev-1']],
    ['deleteSettingsByDevice', 'deleteInstrumentSettingsByDevice', ['dev-1', 0]],
    ['findByUsbSerial', 'findInstrumentByUsbSerial', ['123']],
    ['findByMac', 'findInstrumentByMac', ['AA:BB']],
    ['findByNormalizedName', 'findInstrumentByNormalizedName', ['dev-1']],
    ['reconcileDeviceId', 'reconcileDeviceId', ['old', 'new']],
    ['deduplicateByUsbSerial', 'deduplicateByUsbSerial', []],
    ['saveSysExIdentity', 'saveSysExIdentity', ['dev-1', 0, {}]],
    ['getAllCapabilities', 'getAllInstrumentCapabilities', []],
    ['transaction', 'transaction', [() => {}]]
  ];

  test.each(cases)('%s delegates to db.%s', (repoMethod, dbMethod, args) => {
    const db = makeDb([dbMethod]);
    const repo = new InstrumentRepository(db);
    const r = repo[repoMethod](...args);
    expect(db[dbMethod]).toHaveBeenCalledWith(...args);
    expect(r).toBe(`ret:${dbMethod}`);
  });

  test('getAllSettings calls db.getInstrumentSettings with a single arg', () => {
    const db = makeDb(['getInstrumentSettings']);
    const repo = new InstrumentRepository(db);
    repo.getAllSettings('dev-1');
    expect(db.getInstrumentSettings).toHaveBeenCalledWith('dev-1');
  });
});

describe('PresetRepository — delegations', () => {
  const cases = [
    ['save', 'insertPreset', [{ name: 'p' }]],
    ['findById', 'getPreset', [1]],
    ['findByType', 'getPresets', ['routing']],
    ['delete', 'deletePreset', [1]],
    ['update', 'updatePreset', [1, {}]]
  ];
  test.each(cases)('%s delegates to db.%s', (repoMethod, dbMethod, args) => {
    const db = makeDb([dbMethod]);
    const repo = new PresetRepository(db);
    const r = repo[repoMethod](...args);
    expect(db[dbMethod]).toHaveBeenCalledWith(...args);
    expect(r).toBe(`ret:${dbMethod}`);
  });
});

describe('SessionRepository — delegations', () => {
  const cases = [
    ['save', 'insertSession', [{}]],
    ['findById', 'getSession', [1]],
    ['findAll', 'getSessions', []],
    ['delete', 'deleteSession', [1]]
  ];
  test.each(cases)('%s delegates to db.%s', (repoMethod, dbMethod, args) => {
    const db = makeDb([dbMethod]);
    const repo = new SessionRepository(db);
    const r = repo[repoMethod](...args);
    expect(db[dbMethod]).toHaveBeenCalledWith(...args);
    expect(r).toBe(`ret:${dbMethod}`);
  });
});

describe('PlaylistRepository — delegations', () => {
  const cases = [
    ['save', 'insertPlaylist', [{}]],
    ['delete', 'deletePlaylist', [1]],
    ['findAll', 'getPlaylists', []],
    ['findById', 'getPlaylist', [1]],
    ['findItems', 'getPlaylistItems', [1]],
    ['addItem', 'addPlaylistItem', [1, 2, 0]],
    ['removeItem', 'removePlaylistItem', [3]],
    ['reorderItem', 'reorderPlaylistItem', [1, 3, 1]],
    ['updateLoop', 'updatePlaylistLoop', [1, true]],
    ['clearItems', 'clearPlaylistItems', [1]],
    ['updateSettings', 'updatePlaylistSettings', [1, {}]]
  ];
  test.each(cases)('%s delegates to db.%s', (repoMethod, dbMethod, args) => {
    const db = makeDb([dbMethod]);
    const repo = new PlaylistRepository(db);
    const r = repo[repoMethod](...args);
    expect(db[dbMethod]).toHaveBeenCalledWith(...args);
    expect(r).toBe(`ret:${dbMethod}`);
  });
});

describe('LightingRepository — delegations', () => {
  const cases = [
    ['findAllDevices', 'getLightingDevices', []],
    ['findDeviceById', 'getLightingDevice', ['d1']],
    ['saveDevice', 'insertLightingDevice', [{}]],
    ['updateDevice', 'updateLightingDevice', ['d1', {}]],
    ['deleteDevice', 'deleteLightingDevice', ['d1']],
    ['findAllRules', 'getAllLightingRules', []],
    ['findRulesByDevice', 'getLightingRulesForDevice', ['d1']],
    ['saveRule', 'insertLightingRule', [{}]],
    ['updateRule', 'updateLightingRule', [1, {}]],
    ['deleteRule', 'deleteLightingRule', [1]],
    ['findAllPresets', 'getLightingPresets', []],
    ['savePreset', 'insertLightingPreset', [{}]],
    ['deletePreset', 'deleteLightingPreset', [1]]
  ];
  test.each(cases)('%s delegates to db.%s', (repoMethod, dbMethod, args) => {
    const db = makeDb([dbMethod]);
    const repo = new LightingRepository(db);
    const r = repo[repoMethod](...args);
    expect(db[dbMethod]).toHaveBeenCalledWith(...args);
    expect(r).toBe(`ret:${dbMethod}`);
  });
});

describe('DeviceSettingsRepository — delegations', () => {
  const cases = [
    ['findByDeviceId', 'getDeviceSettings', ['d1']],
    ['ensureDevice', 'ensureDevice', ['d1', 'name', 'output']],
    ['update', 'updateDeviceSettings', ['d1', {}]]
  ];
  test.each(cases)('%s delegates to db.%s', (repoMethod, dbMethod, args) => {
    const db = makeDb([dbMethod]);
    const repo = new DeviceSettingsRepository(db);
    const r = repo[repoMethod](...args);
    expect(db[dbMethod]).toHaveBeenCalledWith(...args);
    expect(r).toBe(`ret:${dbMethod}`);
  });
});

describe('StringInstrumentRepository — delegations via sub-module', () => {
  function mockDb(subMethods) {
    const sub = {};
    for (const m of subMethods) sub[m] = jest.fn().mockReturnValue(`ret:${m}`);
    return { stringInstrumentDB: sub };
  }

  const cases = [
    ['save', 'createStringInstrument', [{}]],
    ['update', 'updateStringInstrument', ['id', {}]],
    ['delete', 'deleteStringInstrument', ['id']],
    ['deleteByDeviceChannel', 'deleteStringInstrumentByDeviceChannel', ['d1', 0]],
    ['deleteByDevice', 'deleteByDevice', ['d1', 0]],
    ['findById', 'getStringInstrumentById', ['id']],
    ['findByDeviceChannel', 'getStringInstrument', ['d1', 0]],
    ['findByDevice', 'getStringInstrumentsByDevice', ['d1']],
    ['findAll', 'getAllStringInstruments', []],
    ['findAllTuningPresets', 'getTuningPresets', []],
    ['findTuningPreset', 'getTuningPreset', ['key']],
    ['saveTablature', 'saveTablature', [1, 0, 'id', []]],
    ['findTablature', 'getTablature', [1, 0]],
    ['findTablaturesByFile', 'getTablaturesByFile', [1]],
    ['deleteTablature', 'deleteTablature', [1, 0]],
    ['deleteTablaturesByFile', 'deleteTablaturesByFile', [1]]
  ];
  test.each(cases)('%s delegates to stringInstrumentDB.%s', (repoMethod, subMethod, args) => {
    const db = mockDb([subMethod]);
    const repo = new StringInstrumentRepository(db);
    const r = repo[repoMethod](...args);
    expect(db.stringInstrumentDB[subMethod]).toHaveBeenCalledWith(...args);
    expect(r).toBe(`ret:${subMethod}`);
  });
});
