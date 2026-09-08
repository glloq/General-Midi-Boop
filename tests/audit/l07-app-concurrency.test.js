// tests/audit/l07-app-concurrency.test.js
//
// Audit 2026-09-07 — lot L07, section §W (concurrence applicative).
// §W était intégralement « NOT TESTED ». Scénario réel : DEUX ONGLETS OUVERTS
// sur la même box, qui modifient le même fichier / le même instrument au même
// instant.
//
// Node est mono-thread et better-sqlite3 est synchrone : l'entrelacement n'est
// possible qu'aux points `await`. `apply_assignments` en possède un
// (`await fileManager.replaceFileBytes / createDerivedFile`) — et c'est
// exactement là que ça cassait.
//
// MISE À JOUR — vague 1, R4 (F-76 / F-77). Le défaut est corrigé : verrou par
// fichier + contrôle de version optimiste (compare-and-swap sur le couple
// « empreinte des octets + empreinte du jeu de routages »). W-1..W-4 verrouillent
// désormais le BON comportement : parmi deux applies concurrents, un seul
// écrit, l'autre reçoit un `ConflictError` explicite — plus jamais deux
// `success: true` pour un fichier corrompu.
//
// Les handlers sont obtenus via le vrai `register()` du module, contre une
// vraie base SQLite, un vrai BlobStore et un vrai FileManager.

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { ConflictError } from '../../src/core/errors/index.js';
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

const SANDBOX = process.env.GMBOOP_TEST_TMP || join(tmpdir(), 'gmboop-l07');
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

describe('L07 §W — concurrence applicative (« deux onglets ouverts »)', () => {
  let tempDir;
  let database;
  let blobStore;
  let fileManager;
  let app;
  let apply;

  beforeEach(() => {
    tempDir = mkdtempSync(join(SANDBOX, 'appconc-'));
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

    database.ensureDevice('dev-a', 'Device A', 'output');
    database.ensureDevice('dev-b', 'Device B', 'output');
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
    0: {
      deviceId,
      instrumentName: deviceId,
      score: 0.9,
      transposition: { semitones }
    }
  });

  /**
   * Résout deux applies concurrents et exige EXACTEMENT un gagnant : l'autre
   * doit avoir été refusé par un ConflictError (jamais un `success` mensonger).
   */
  async function raceTwoApplies(payloadA, payloadB) {
    const settled = await Promise.allSettled([apply(payloadA), apply(payloadB)]);
    const winners = settled.filter((r) => r.status === 'fulfilled');
    const losers = settled.filter((r) => r.status === 'rejected');
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    expect(losers[0].reason).toBeInstanceOf(ConflictError);
    expect(losers[0].reason.code).toBe('ERR_CONFLICT');
    expect(losers[0].reason.statusCode).toBe(409);
    return { winner: winners[0].value, conflict: losers[0].reason };
  }

  test('W-1 — F-76 CORRIGÉ : deux apply concurrents avec `overwriteOriginal` ne cumulent plus ; le perdant est refusé', async () => {
    const up = await fileManager.handleUpload('song.mid', midiBuffer(70));
    expect(notesOf(up.fileId)[0]).toBe(70);

    const { winner } = await raceTwoApplies(
      {
        originalFileId: up.fileId,
        createAdaptedFile: true,
        overwriteOriginal: true,
        assignments: assignment('dev-a', 5)
      },
      {
        originalFileId: up.fileId,
        createAdaptedFile: true,
        overwriteOriginal: true,
        assignments: assignment('dev-b', 7)
      }
    );
    expect(winner.success).toBe(true);

    // Le fichier porte EXACTEMENT une transposition — celle du gagnant.
    const notes = notesOf(up.fileId);
    expect(notes[0]).not.toBe(82); // le cumul 70+5+7 mesuré par l'audit
    expect([75, 77]).toContain(notes[0]);
  });

  test('W-1b — F-76 CORRIGÉ : la variante +5 / −5 ne peut plus ramener le fichier à l’original', async () => {
    const up = await fileManager.handleUpload('song.mid', midiBuffer(70));

    await raceTwoApplies(
      {
        originalFileId: up.fileId,
        createAdaptedFile: true,
        overwriteOriginal: true,
        assignments: assignment('dev-a', 5)
      },
      {
        originalFileId: up.fileId,
        createAdaptedFile: true,
        overwriteOriginal: true,
        assignments: assignment('dev-b', -5)
      }
    );

    // L'audit mesurait un retour à 70 : les DEUX adaptations perdues.
    const notes = notesOf(up.fileId);
    expect(notes[0]).not.toBe(70);
    expect([75, 65]).toContain(notes[0]);
  });

  test('W-2 — F-77 CORRIGÉ : sans overwrite, le perdant apprend le conflit au lieu de recevoir un adaptedFileId mensonger', async () => {
    const up = await fileManager.handleUpload('song.mid', midiBuffer(60));

    const { winner } = await raceTwoApplies(
      {
        originalFileId: up.fileId,
        createAdaptedFile: true,
        assignments: assignment('dev-a', 12)
      },
      {
        originalFileId: up.fileId,
        createAdaptedFile: true,
        assignments: assignment('dev-b', -12)
      }
    );

    // Un seul fichier adapté, et son contenu est bien celui du gagnant.
    expect(database.getAllFiles().filter((f) => f.parent_file_id === up.fileId).length).toBe(1);
    expect([72, 48]).toContain(notesOf(winner.adaptedFileId)[0]);

    // Le routage correspond au MÊME apply que le contenu : plus de divergence
    // « octets de B, routage de B, mais A croit avoir persisté ».
    const routings = app.routingRepository.findByFileId(winner.adaptedFileId);
    expect(routings.length).toBe(1);
    expect(routings[0].device_id).toBe(winner.routings[0].device_id);
  });

  test('W-3 — deux apply concurrents IDENTIQUES : un seul fichier adapté, aucune ligne en double, base intègre', async () => {
    const up = await fileManager.handleUpload('song.mid', midiBuffer(60));
    // Même destination ET même transposition : les deux plans convergent, mais
    // un seul écrit — l'autre est refusé plutôt que d'écraser en aveugle.
    const { winner } = await raceTwoApplies(
      {
        originalFileId: up.fileId,
        createAdaptedFile: true,
        assignments: assignment('dev-a', 12)
      },
      {
        originalFileId: up.fileId,
        createAdaptedFile: true,
        assignments: assignment('dev-a', 12)
      }
    );
    expect(winner.adaptedFileId).toBeTruthy();
    expect(database.getAllFiles().length).toBe(2); // original + 1 adapté
    expect(app.routingRepository.findByFileId(winner.adaptedFileId).length).toBe(1);
    expect(
      database.pragmaIntegrity?.() ?? database.db.pragma('integrity_check', { simple: true })
    ).toBe('ok');
  });

  test('W-3b — deux apply SÉQUENTIELS ne déclenchent aucun conflit (le verrou ne casse pas le ré-apply normal)', async () => {
    const up = await fileManager.handleUpload('song.mid', midiBuffer(60));
    const first = await apply({
      originalFileId: up.fileId,
      createAdaptedFile: true,
      assignments: assignment('dev-a', 12)
    });
    // Ré-apply après réponse complète : l'instantané est pris APRÈS l'écriture
    // précédente, donc aucune dérive — le flux normal reste inchangé.
    const second = await apply({
      originalFileId: up.fileId,
      createAdaptedFile: true,
      assignments: assignment('dev-b', 3)
    });
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.adaptedFileId).toBe(first.adaptedFileId);
    const routings = app.routingRepository.findByFileId(second.adaptedFileId);
    expect(routings.length).toBe(1);
    expect(routings[0].device_id).toBe('dev-b');
  });

  test('W-4 — F-85 : apply concurrent d’une suppression du même fichier → plus aucun blob orphelin', async () => {
    const up = await fileManager.handleUpload('song.mid', midiBuffer(80));

    const applying = apply({
      originalFileId: up.fileId,
      createAdaptedFile: true,
      assignments: assignment('dev-a', 3)
    });
    const deleting = fileManager.deleteFile(up.fileId);
    const results = await Promise.allSettled([applying, deleting]);

    // La suppression réussit ; l'apply, qui prend le verrou AVANT de lire, voit
    // le fichier disparu et le dit (NotFound) au lieu de « réussir » à vide.
    expect(results[1].status).toBe('fulfilled');
    expect(results[0].status).toBe('rejected');
    expect(database.getAllFiles().length).toBe(0);

    // Et surtout : l'octet adapté n'est plus écrit du tout, donc plus d'orphelin
    // en attente du prochain GC de sauvegarde (F-85).
    const referenced = new Set(database.midiDB.listBlobsForManifest().map((r) => r.blob_path));
    const onDisk = [];
    const { readdirSync, existsSync } = await import('fs');
    const midiDir = join(tempDir, 'midi');
    if (existsSync(midiDir)) {
      for (const shard of readdirSync(midiDir)) {
        for (const name of readdirSync(join(midiDir, shard))) onDisk.push(`midi/${shard}/${name}`);
      }
    }
    const orphans = onDisk.filter((b) => !referenced.has(b));
    expect(orphans.length).toBe(0);
  });

  test('W-5 — deux enregistrements concurrents du MÊME instrument : dernier arrivé gagne, sans jeton de version', () => {
    // Pas d'`await` dans le chemin d'écriture des réglages : la base ne peut pas
    // être laissée à moitié écrite. Le risque est la MISE À JOUR PERDUE :
    // rien (ni ETag, ni updated_at comparé) ne détecte l'écrasement.
    database.updateInstrumentSettings('dev-a', 0, { custom_name: 'Onglet A', sync_delay: 10 });
    const snapshotVuParB = database.getInstrumentSettings('dev-a', 0);

    // L'onglet A enregistre.
    database.updateInstrumentSettings('dev-a', 0, { custom_name: 'Piano du salon' });
    // L'onglet B enregistre sur la base de sa vue périmée.
    database.updateInstrumentSettings('dev-a', 0, { custom_name: snapshotVuParB.custom_name });

    expect(database.getInstrumentSettings('dev-a', 0).custom_name).toBe('Onglet A');
    // Aucune API ne permet à A de savoir qu'il a été écrasé.
    expect(Object.keys(snapshotVuParB)).not.toContain('version');
    expect(Object.keys(snapshotVuParB)).not.toContain('etag');
  });

  test('W-6 — playlist : deux ajouts concurrents ne peuvent pas produire de position en double (écriture synchrone)', () => {
    const fileA = (() => {
      database.db
        .prepare(
          "INSERT INTO midi_files (content_hash, filename, folder, blob_path, size, tracks, uploaded_at) VALUES ('ha','a.mid','/','midi/aa/ha.mid',10,1,datetime('now'))"
        )
        .run();
      return database.db.prepare("SELECT id FROM midi_files WHERE content_hash='ha'").get().id;
    })();
    const pid = database.insertPlaylist({ name: 'P' });

    // `addPlaylistItem` fait MAX(position)+1 PUIS INSERT, hors transaction —
    // sûr uniquement parce que le driver est synchrone et mono-connexion.
    for (let i = 0; i < 5; i++) database.addPlaylistItem(pid, fileA, undefined);
    const positions = database
      .getPlaylistItems(pid)
      .map((i) => i.position)
      .sort((a, b) => a - b);
    expect(positions).toEqual([0, 1, 2, 3, 4]);

    // En revanche rien n'INTERDIT structurellement la collision : aucune
    // contrainte UNIQUE(playlist_id, position) n'existe.
    const idx = database.db.pragma('index_list(playlist_items)').filter((i) => i.unique === 1);
    expect(idx).toEqual([]);
  });
});
