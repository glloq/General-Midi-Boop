// tests/audit/r4-apply-assignments-concurrency.test.js
//
// Vague 1 — R4 · F-76 (P1) / F-77 (P2) : sérialiser les écritures concurrentes
// d'`apply_assignments`.
//
// Le défaut mesuré par l'audit : deux onglets ouverts, deux `apply_assignments`
// simultanés sur le même fichier. Le second lisait la SORTIE du premier comme
// entrée et empilait sa propre transformation dessus — un original en note 70
// finissait en 82 après un +5 et un +7 — et les DEUX clients recevaient
// `success: true`. Avec +5 / −5 le fichier revenait à l'original et les deux
// adaptations étaient perdues.
//
// Mécanisme retenu (voir docs/audit/2026-09-07/WAVE1_R4_R5.md) :
//   1. verrou par fichier (FileWriteLock) — la séquence lecture → transformation
//      → écriture → routages devient UNE section critique ;
//   2. contrôle de version optimiste — le jeton de version de tout ce que
//      l'appel peut écraser (octets de l'original, identité + octets du fichier
//      adapté, empreinte du jeu de routages auto) est capturé AVANT le verrou,
//      donc avant que quiconque ait pu écrire, puis revérifié une fois le verrou
//      tenu. S'il a bougé, l'appel est refusé (ConflictError, 409) et n'écrit
//      RIEN.
//
// Le critère : aucune écriture silencieusement perdue — soit elle réussit, soit
// le client apprend qu'elle a échoué.

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { writeMidi, parseMidi } from 'midi-file';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import DatabaseManager from '../../src/persistence/Database.js';
import BlobStore from '../../src/files/BlobStore.js';
import FileManager from '../../src/files/FileManager.js';
import AutoAssigner from '../../src/midi/adaptation/AutoAssigner.js';
import MidiAdaptationService from '../../src/midi/adaptation/MidiAdaptationService.js';
import FileRepository from '../../src/repositories/FileRepository.js';
import RoutingRepository from '../../src/repositories/RoutingRepository.js';
import InstrumentRepository from '../../src/repositories/InstrumentRepository.js';
import PlaylistRepository from '../../src/repositories/PlaylistRepository.js';
import { register as registerAssignmentCommands } from '../../src/midi/playback/commands/PlaybackAssignmentCommands.js';
import { ConflictError } from '../../src/core/errors/index.js';

const SANDBOX = process.env.GMBOOP_TEST_TMP || join(tmpdir(), 'gmboop-r4r5');
mkdirSync(SANDBOX, { recursive: true });
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function midiBuffer(baseNote, n = 6) {
  const ev = [];
  for (let i = 0; i < n; i++) {
    ev.push({
      deltaTime: i ? 120 : 0,
      type: 'noteOn',
      channel: 0,
      noteNumber: baseNote + i,
      velocity: 100
    });
    ev.push({ deltaTime: 60, type: 'noteOff', channel: 0, noteNumber: baseNote + i, velocity: 0 });
  }
  ev.push({ deltaTime: 0, meta: true, type: 'endOfTrack' });
  return Buffer.from(
    writeMidi({ header: { format: 1, numTracks: 1, ticksPerBeat: 480 }, tracks: [ev] })
  );
}

describe('R4 — apply_assignments concurrent (F-76 / F-77)', () => {
  let tempDir;
  let database;
  let blobStore;
  let fileManager;
  let app;
  let apply;

  beforeEach(() => {
    tempDir = mkdtempSync(join(SANDBOX, 'r4-apply-'));
    database = new DatabaseManager({
      logger: silentLogger,
      config: { database: { path: join(tempDir, 'gmboop.db') } }
    });
    blobStore = new BlobStore({ baseDir: tempDir, logger: silentLogger });
    fileManager = new FileManager({
      logger: silentLogger,
      database,
      blobStore,
      eventBus: { emit: () => {} }
    });
    const autoAssigner = new AutoAssigner(database, silentLogger, { emit: () => {}, on: () => {} });
    app = {
      logger: silentLogger,
      database,
      blobStore,
      fileManager,
      eventBus: { emit: () => {} },
      adaptationService: new MidiAdaptationService(silentLogger, autoAssigner),
      fileRepository: new FileRepository(database),
      routingRepository: new RoutingRepository(database),
      instrumentRepository: new InstrumentRepository(database),
      playlistRepository: new PlaylistRepository(database)
    };
    const handlers = {};
    registerAssignmentCommands({ register: (n, fn) => (handlers[n] = fn) }, app);
    apply = (data) => handlers['apply_assignments'](data);

    for (const id of ['dev-a', 'dev-b', 'dev-c']) database.ensureDevice(id, id, 'output');
  });

  afterEach(() => {
    try {
      database.close();
    } catch {
      /* ignore */
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  const notesOf = (fileId) =>
    parseMidi(blobStore.read(database.getFile(fileId).blob_path))
      .tracks[0].filter((e) => e.type === 'noteOn')
      .map((e) => e.noteNumber);

  const assignment = (deviceId, semitones) => ({
    0: { deviceId, instrumentName: deviceId, score: 0.9, transposition: { semitones } }
  });

  const overwrite = (fileId, deviceId, semitones) => ({
    originalFileId: fileId,
    createAdaptedFile: true,
    overwriteOriginal: true,
    assignments: assignment(deviceId, semitones)
  });

  test('R4-1 — F-76 : le cumul (70 → 82) est impossible ; un seul écrit, l’autre reçoit 409', async () => {
    const up = await fileManager.handleUpload('song.mid', midiBuffer(70));
    const hashBefore = database.getFile(up.fileId).content_hash;

    const settled = await Promise.allSettled([
      apply(overwrite(up.fileId, 'dev-a', 5)),
      apply(overwrite(up.fileId, 'dev-b', 7))
    ]);

    const ok = settled.filter((r) => r.status === 'fulfilled');
    const ko = settled.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(ko).toHaveLength(1);
    expect(ko[0].reason).toBeInstanceOf(ConflictError);

    // Le fichier porte une seule transposition, jamais leur somme.
    expect(notesOf(up.fileId)[0]).toBe(75);
    expect(database.getFile(up.fileId).content_hash).not.toBe(hashBefore);
  });

  test('R4-2 — F-76 : +5 / −5 ne peut plus effacer les DEUX adaptations', async () => {
    const up = await fileManager.handleUpload('song.mid', midiBuffer(70));

    const settled = await Promise.allSettled([
      apply(overwrite(up.fileId, 'dev-a', 5)),
      apply(overwrite(up.fileId, 'dev-b', -5))
    ]);

    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    // L'audit mesurait un retour à 70 (identité) : les deux adaptations perdues.
    expect(notesOf(up.fileId)[0]).toBe(75);
  });

  test('R4-3 — l’erreur est exploitable : code, statut, ressource et jetons de version', async () => {
    const up = await fileManager.handleUpload('song.mid', midiBuffer(60));

    const settled = await Promise.allSettled([
      apply(overwrite(up.fileId, 'dev-a', 2)),
      apply(overwrite(up.fileId, 'dev-b', 4))
    ]);
    const err = settled.find((r) => r.status === 'rejected').reason;

    expect(err.code).toBe('ERR_CONFLICT');
    expect(err.statusCode).toBe(409);
    expect(err.resource).toBe(`midi_file:${up.fileId}`);
    // Le client sait ce qu'il croyait écraser et ce qu'il y a réellement.
    expect(err.expected.originalHash).not.toBe(err.actual.originalHash);
    // La sérialisation vers le client conserve tout cela (ApplicationError).
    const json = err.toJSON();
    expect(json.code).toBe('ERR_CONFLICT');
    expect(json.error).toBe('ConflictError');
    expect(json.message).toMatch(/concurrent/i);
  });

  test('R4-4 — le perdant n’écrit RIEN : ni octets, ni fichier adapté, ni routage', async () => {
    const up = await fileManager.handleUpload('song.mid', midiBuffer(64));

    const settled = await Promise.allSettled([
      apply({
        originalFileId: up.fileId,
        createAdaptedFile: true,
        assignments: assignment('dev-a', 12)
      }),
      apply({
        originalFileId: up.fileId,
        createAdaptedFile: true,
        assignments: assignment('dev-b', -12)
      })
    ]);
    const winner = settled.find((r) => r.status === 'fulfilled').value;

    // Un seul fichier adapté (pas deux), et un seul jeu de routages.
    const derived = database.getAllFiles().filter((f) => f.parent_file_id === up.fileId);
    expect(derived).toHaveLength(1);
    expect(derived[0].id).toBe(winner.adaptedFileId);

    const routings = app.routingRepository.findByFileId(winner.adaptedFileId);
    expect(routings).toHaveLength(1);
    expect(routings[0].device_id).toBe(winner.routings[0].device_id);
    // L'original n'a pas bougé (pas d'overwrite demandé).
    expect(notesOf(up.fileId)[0]).toBe(64);
  });

  test('R4-5 — F-77 : un apply sans overwrite ne peut plus écraser en silence le fichier adapté d’un autre', async () => {
    const up = await fileManager.handleUpload('song.mid', midiBuffer(60));
    // Premier apply, terminé : crée le fichier adapté.
    const first = await apply({
      originalFileId: up.fileId,
      createAdaptedFile: true,
      assignments: assignment('dev-a', 12)
    });
    expect(notesOf(first.adaptedFileId)[0]).toBe(72);

    // Deux ré-applies concurrents sur ce fichier adapté déjà existant.
    const settled = await Promise.allSettled([
      apply({
        originalFileId: up.fileId,
        createAdaptedFile: true,
        assignments: assignment('dev-b', 3)
      }),
      apply({
        originalFileId: up.fileId,
        createAdaptedFile: true,
        assignments: assignment('dev-c', -3)
      })
    ]);
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(settled.find((r) => r.status === 'rejected').reason).toBeInstanceOf(ConflictError);

    // Le fichier adapté porte le résultat d'UN SEUL des deux, calculé depuis
    // l'original (63) — pas un empilement sur le +12 précédent.
    expect(notesOf(first.adaptedFileId)[0]).toBe(63);
    expect(database.getAllFiles().filter((f) => f.parent_file_id === up.fileId)).toHaveLength(1);
  });

  test('R4-6 — routages seuls (createAdaptedFile:false) : la mise à jour perdue est refusée, pas subie', async () => {
    const up = await fileManager.handleUpload('song.mid', midiBuffer(60));

    const settled = await Promise.allSettled([
      apply({
        originalFileId: up.fileId,
        createAdaptedFile: false,
        assignments: assignment('dev-a', 0)
      }),
      apply({
        originalFileId: up.fileId,
        createAdaptedFile: false,
        assignments: assignment('dev-b', 0)
      })
    ]);
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(settled.find((r) => r.status === 'rejected').reason).toBeInstanceOf(ConflictError);

    const routings = app.routingRepository.findByFileId(up.fileId);
    expect(routings).toHaveLength(1);
    expect(routings[0].device_id).toBe('dev-a');
  });

  test('R4-7 — huit applies simultanés : exactement un gagnant, sept 409, base intègre', async () => {
    const up = await fileManager.handleUpload('song.mid', midiBuffer(50));

    const settled = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => apply(overwrite(up.fileId, 'dev-a', i + 1)))
    );
    const ok = settled.filter((r) => r.status === 'fulfilled');
    const ko = settled.filter((r) => r.status === 'rejected');

    expect(ok).toHaveLength(1);
    expect(ko).toHaveLength(7);
    expect(ko.every((r) => r.reason instanceof ConflictError)).toBe(true);
    // Une seule transposition appliquée, pas huit empilées (50 + 1..8 = 86).
    expect(notesOf(up.fileId)[0]).toBe(51);
    expect(database.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(database.db.pragma('foreign_key_check')).toEqual([]);
  });

  test('R4-8 — non-régression : les applies SÉQUENTIELS restent acceptés (le remède ne casse pas le ré-apply)', async () => {
    const up = await fileManager.handleUpload('song.mid', midiBuffer(60));

    // Trois ré-applies l'un après l'autre — le cas normal d'un seul opérateur.
    const a = await apply(overwrite(up.fileId, 'dev-a', 2));
    const b = await apply(overwrite(up.fileId, 'dev-b', 3));
    const c = await apply({
      originalFileId: up.fileId,
      createAdaptedFile: false,
      assignments: assignment('dev-c', 0)
    });

    expect([a.success, b.success, c.success]).toEqual([true, true, true]);
    // Chaîne séquentielle explicitement demandée par l'opérateur : 60 +2 +3.
    expect(notesOf(up.fileId)[0]).toBe(65);
    const routings = app.routingRepository.findByFileId(up.fileId);
    expect(routings).toHaveLength(1);
    expect(routings[0].device_id).toBe('dev-c');
  });

  test('R4-9 — le verrou sérialise réellement : deux applies sur des fichiers DIFFÉRENTS ne se gênent pas', async () => {
    const one = await fileManager.handleUpload('one.mid', midiBuffer(60));
    const two = await fileManager.handleUpload('two.mid', midiBuffer(80));

    const [a, b] = await Promise.all([
      apply(overwrite(one.fileId, 'dev-a', 1)),
      apply(overwrite(two.fileId, 'dev-b', 2))
    ]);

    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(notesOf(one.fileId)[0]).toBe(61);
    expect(notesOf(two.fileId)[0]).toBe(82);
  });
});
