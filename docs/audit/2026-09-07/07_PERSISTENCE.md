# 07 — Persistance, migrations, fichiers, concurrence (lot L07)

**Date :** 2026-09-07 · **Base de mesure :** `00_BASELINE.md` (commit `8dc170e`)
**Sections couvertes :** §W (concurrence applicative) · §X (concurrence SQLite) ·
§Y (migrations) · §Z (sauvegardes) · §AA (FileManager / blobstore) · §E04 (import / export)
**Findings ouverts :** F-76 → F-85 · **Finding ré-instruit :** F-04

> **Le fait nouveau de cette session :** `better-sqlite3` a été recompilé par L00.
> Pour la première fois, tout ce rapport est mesuré **contre une vraie base
> SQLite**, avec de vrais processus concurrents, de vraies migrations et de
> vrais octets sur disque. Aucune affirmation ci-dessous n'est déduite de la
> lecture du code seule.
>
> Toutes les bases de test vivent hors du dépôt (variable `GMBOOP_TEST_TMP`,
> défaut `os.tmpdir()`). `./data/gmboop.db` n'a jamais été ouverte.

---

## 1. Synthèse

| § | Sujet | État | Niveau | Findings |
|---|---|---|---|---|
| **X** | Concurrence SQLite (WAL, `busy_timeout`, multi-processus, transactions imbriquées) | **PARTIAL** | 4 | F-78 |
| **W** | Concurrence applicative (« deux onglets ouverts ») | **FAIL** | 4 | **F-76**, F-77, F-85 |
| — | Intégrité référentielle / cascades | **PARTIAL** | 4 | F-79, F-81 |
| **Y** | Migrations : rejeu, panne au milieu de N, reprise, legacy | **PASS** (1 réserve) | 4 | F-80 |
| **Z** | Sauvegardes, restauration, rétention, GC | **PASS** | 4 | — |
| **AA** | FileManager / blobstore | **PARTIAL** | 4 | F-82, F-83 *(corrigé)* |
| **E04** | Import / export | **PARTIAL** | 3 | F-84 |
| **F-04** | Skip silencieux des suites SQLite | **CONFIRMÉ OUVERT — AGGRAVÉ** | 5 | diff §8 |

**Verdict d'ensemble.** La couche *persistance* elle-même est solide : WAL,
clés étrangères actives, transactions par fichier de migration, sauvegardes
vérifiées par restauration, écriture de blobs atomique et fsyncée. **Ce qui
casse est au-dessus** : le niveau applicatif ne possède aucun contrôle de
concurrence. Deux onglets qui appliquent une adaptation au même instant
produisent un fichier MIDI **transposé deux fois**, et les deux clients
reçoivent `success: true`.

### Findings par sévérité

| # | Sev | Titre | Où |
|---|---|---|---|
| **F-76** | **P1** | Deux `apply_assignments` concurrents avec `overwriteOriginal` **cumulent** leurs transformations ; le fichier de l'opérateur est corrompu (une octave d'écart) et les deux clients reçoivent `success` | `src/midi/playback/commands/PlaybackAssignmentCommands.js` |
| **F-77** | P2 | Sans `overwriteOriginal` : mise à jour perdue silencieuse — le client A reçoit `adaptedFileId` + `success` alors que le fichier contient le résultat de B | idem |
| **F-78** | P2 | Une écriture contendue par un 2ᵉ processus **gèle la boucle d'événements ≈5 s** (donc l'ordonnanceur MIDI) puis échoue ; `busy_timeout` n'est jamais configuré — c'est le défaut du pilote | `src/persistence/DatabaseLifecycle.js`, `Database.js` |
| **F-79** | P2 | 4 colonnes de référence sans clé étrangère → lignes orphelines **et résurrection** des réglages quand le même `device_id` réapparaît ; `deleteInstrumentLightByDevice()` n'est appelée par aucun handler | schéma + `src/persistence/tables/InstrumentLightDB.js` |
| **F-80** | P2 | La détection « base legacy » ne regarde que la **description** de la ligne version 1 : une base mal étiquetée saute définitivement le baseline et le service ne démarre plus | `src/persistence/DatabaseLifecycle.js` |
| **F-81** | P2 | `instrument_delete` : 4 suppressions **non transactionnelles**, erreurs partielles seulement loguées, `success: true` renvoyé quand même ; le JSDoc promet des cascades qui n'existent pas | `src/api/commands/InstrumentSettingsCommands.js` |
| **F-82** | P2 | `POST /api/files?filename=` n'applique **aucun** filtre (NUL, saut de ligne, `..`, chaîne vide, 404 caractères, `<img onerror>`), alors que `file_rename` applique `validateFilename` | `src/api/apiRoutes.js`, `schemas/file.schemas.js` |
| **F-83** | P2 | `exportFile()` renvoyait une URL de téléchargement pour un fichier dont les octets ont disparu — **CORRIGÉ** (test rouge→vert) | `src/files/FileManager.js` |
| **F-84** | P3 | `file_export` n'est appelé par **aucun** code frontend et son JSDoc promet du base64 alors qu'il renvoie une URL : §E04 « export » est une surface morte | `src/api/commands/FileCommands.js` |
| **F-85** | P3 | Le GC des blobs orphelins ne tourne **que** dans une sauvegarde réussie ; un blob orphelin créé par une suppression concurrente reste sur disque indéfiniment si les sauvegardes échouent | `src/persistence/BackupScheduler.js` |

---

## 2. Reproduction

```bash
export GMBOOP_TEST_TMP=/tmp/gmboop-l07          # facultatif : bac à sable
node --experimental-vm-modules node_modules/jest/bin/jest.js tests/audit/l07-
```

```
PASS tests/audit/l07-filemanager-blobstore.test.js
PASS tests/audit/l07-app-concurrency.test.js
PASS tests/audit/l07-backup-restore.test.js
PASS tests/audit/l07-referential-integrity.test.js
PASS tests/audit/l07-migrations.test.js
PASS tests/audit/l07-sqlite-concurrency.test.js (11.869 s)

Test Suites: 6 passed, 6 total
Tests:       49 passed, 49 total
```

Six suites créées, **49 tests**, toutes vertes. Elles encodent le comportement
**constaté** — y compris les défauts : un test qui passe ici est un test qui
*décrit fidèlement ce que fait le produit aujourd'hui*, et qui deviendra rouge
le jour où le défaut sera corrigé (les tests de défaut sont nommés
`DÉFAUT F-xx`, pour être retournés en même temps que le correctif).

---

## 3. §X — Concurrence SQLite réelle · **PARTIAL** · niveau 4

`tests/audit/l07-sqlite-concurrency.test.js` — 7 tests.

### Ce qui tient

| Scénario | Mesure | Verdict |
|---|---|---|
| Pragmas de la connexion applicative | `journal_mode=wal`, `foreign_keys=1`, `busy_timeout=5000`, `synchronous=1`, `wal_autocheckpoint=1000` | PASS |
| **4 processus × 150 écritures en parallèle** sur le même fichier | 600/600 lignes écrites, **0 `SQLITE_BUSY`**, **0 perte**, `integrity_check = ok` | PASS |
| Montée à 16 processus × 500 (hors suite, sonde manuelle) | 8000/8000 lignes, 0 erreur, 1,3 s de mur | PASS |
| Verrou concurrent de 600 ms (< `busy_timeout`) | l'écriture **attend** puis réussit (1005 ms mesurés) | PASS |
| Verrou concurrent de 8 s (> `busy_timeout`) | échec **propre** : `SQLITE_BUSY / database is locked` après 5 014 ms, **aucune écriture partielle**, la ligne pré-existante intacte | PASS |
| Transactions imbriquées | savepoints corrects : échec interne rattrapé ⇒ seule l'interne annulée ; échec externe ⇒ **tout** annulé | PASS |
| WAL, lecture longue pendant écriture | le lecteur garde son instantané, l'écrivain n'attend pas (< 2 ms) | PASS |

**Réponse aux questions du mandat.** *Combien d'écritures concurrentes avant
échec ?* Aucune limite atteinte : 16 processus × 500 écritures passent sans une
seule erreur. *L'erreur est-elle propre ?* Oui — `SQLITE_BUSY` explicite, rien
n'est perdu silencieusement.

### F-78 — le vrai coût de la contention (P2)

`better-sqlite3` est **synchrone**. Le handler « busy » de SQLite ne rend pas la
main à la boucle d'événements : il **bloque tout le processus**.

```
{"verrouTenuMs":8000,"ecritureBloqueeMs":5010,"erreur":"SQLITE_BUSY",
 "plusGrandTrouBoucleEvenementsMs":5015,"ticks":67}
```

Un timer à 5 ms — l'ordre de grandeur d'un ordonnanceur MIDI — a subi un trou
de **5 015 ms**. Sur un Pi, cela signifie : *toutes les notes en attente sont
en retard de cinq secondes, puis l'écriture échoue*.

Qui peut tenir un verrou concurrent sur la box ? `npm run migrate`
(`scripts/migrate-db.js` ouvre sa propre connexion), un second `npm start`
lancé par erreur, un outil de sauvegarde externe, un `sqlite3` en ligne de
commande. Il y a **une seule** connexion écrivante dans le processus serveur
(vérifié : `new Database(` n'apparaît que dans `Database.js:98`,
`DatabaseLifecycle.js:33` et la vérification lecture seule de
`restoreFromBackup`) — le risque est donc strictement inter-processus, mais il
est réel et non documenté.

Aggravant : **`busy_timeout` n'est positionné nulle part dans le code**. La
valeur 5000 est le défaut de `better-sqlite3` (option `timeout`). Le contrat
est donc implicite et dépend du pilote.

**Recommandation** (hors périmètre de correctif : compromis de comportement à
arbitrer) :

```diff
--- a/src/persistence/DatabaseLifecycle.js
+++ b/src/persistence/DatabaseLifecycle.js
@@
-  const db = new Database(dbPath);
+  // Contrat explicite plutôt qu'implicite : sans cette ligne la valeur vient
+  // du défaut de better-sqlite3 (5 s). better-sqlite3 étant SYNCHRONE, cette
+  // attente bloque la boucle d'événements — donc l'ordonnanceur MIDI. 1 s est
+  // un compromis : assez pour absorber un `npm run migrate`, assez court pour
+  // ne pas transformer une contention en trou audible.
+  const db = new Database(dbPath, { timeout: 1000 });
   db.pragma('journal_mode = WAL');
   db.pragma('foreign_keys = ON');
```

(le même changement s'applique à `Database.js:98`).

---

## 4. §W — Concurrence applicative · **FAIL** · niveau 4

`tests/audit/l07-app-concurrency.test.js` — 6 tests, contre les **vrais**
handlers (`register()` de `PlaybackAssignmentCommands`), une vraie base, un vrai
`BlobStore` et un vrai `FileManager`.

**Le mécanisme.** Node est mono-thread et `better-sqlite3` est synchrone :
l'entrelacement n'est possible qu'aux points `await`. `applyAssignments` en a
un — `await app.fileManager.replaceFileBytes(...)` /
`await app.fileManager.createDerivedFile(...)`. C'est exactement là que ça
casse : le second client **lit la sortie du premier comme entrée**.

### Table « scénario × comportement observé × verdict »

| # | Scénario (deux clients WS simultanés) | Comportement observé | Verdict |
|---|---|---|---|
| W-1 | `apply_assignments` ×2, `overwriteOriginal: true`, +5 et +7 demi-tons | Fichier final **+12** (ni +5 ni +7). Les deux clients reçoivent `success: true`. Variante testée +5 / −5 : le fichier **revient à l'original** | **FAIL — F-76 (P1)** |
| W-2 | `apply_assignments` ×2, fichier adapté, +12 et −12 | Un seul fichier adapté, contenu de **B**, routage de **B**. A reçoit `success` + le même `adaptedFileId` en croyant avoir persisté +12 | **FAIL — F-77 (P2)** |
| W-3 | `apply_assignments` ×2 **identiques** | Dédoublonnage propre : 1 fichier adapté, 0 ligne en double, `integrity_check = ok` | PASS |
| W-4 | `apply_assignments` pendant la **suppression** du même fichier | Les deux « réussissent ». Base cohérente (cascade `parent_file_id`), mais **1 blob orphelin** reste sur disque | PARTIAL — F-85 (P3) |
| W-5 | Deux enregistrements du même instrument | Dernier arrivé gagne. Écriture **transactionnelle** (`instrument_save_all`), donc jamais partielle — mais aucun jeton de version / ETag : la mise à jour perdue est **indétectable** | PARTIAL |
| W-6 | Deux ajouts concurrents dans la même playlist | Positions correctes `[0,1,2,3,4]` : sûr uniquement parce que `addPlaylistItem` est synchrone. Aucune contrainte `UNIQUE(playlist_id, position)` n'existe pour le garantir structurellement | PARTIAL |

### F-76 en détail — la perte de données qui compte (P1)

```
fichier original : notes 70, 71, 72…
client A : apply_assignments { overwriteOriginal: true, transposition: +5 }
client B : apply_assignments { overwriteOriginal: true, transposition: +7 }
→ A : { success: true }
→ B : { success: true }
→ fichier stocké : notes 82, 83, 84   (70 + 5 + 7)
```

Ce n'est **pas** un « dernier arrivé gagne » : c'est un **cumul**. B a lu le
fichier déjà transposé par A (`app.blobStore.read(originalFile.blob_path)` en
tête de handler, `originalFile` relu **après** l'écriture de A) et lui a
ré-appliqué sa propre transposition. Avec deux transpositions opposées, le
fichier **revient à l'original** et les deux adaptations sont perdues.

Le code porte déjà l'aveu de la non-atomicité côté routages
(`PlaybackAssignmentCommands.js`, commentaire « *the writes below are not yet
wrapped in a single transaction […] full atomicity is a follow-up (P1-8)* ») —
mais le problème mesuré ici est en amont, sur les **octets du fichier**.

**Correctif recommandé** (hors de mes chemins autorisés — à appliquer en vague 2) :
sérialiser `apply_assignments` par `originalFileId` (un mutex par fichier, comme
`UploadQueue` le fait déjà pour les téléversements), **ou** refuser l'opération
quand le `content_hash` lu en début de handler ne correspond plus à celui en base
au moment d'écrire (compare-and-swap). La seconde option est la moins invasive
et transforme une corruption silencieuse en erreur explicite.

---

## 5. Intégrité référentielle · **PARTIAL** · niveau 4

`tests/audit/l07-referential-integrity.test.js` — 6 tests.

Les clés étrangères sont **réellement actives** (`PRAGMA foreign_keys = 1`,
re-vérifié). Inventaire mécanique des colonnes de référence :

| Colonne | Clé étrangère |
|---|---|
| `midi_file_channels.midi_file_id`, `midi_file_tempo_map.midi_file_id`, `midi_file_text_events.midi_file_id`, `string_instrument_tablatures.midi_file_id`, `midi_instrument_routings.midi_file_id` | → `midi_files.id` **CASCADE** |
| `playlist_items.playlist_id` | → `playlists.id` **CASCADE** |
| `instruments_latency.device_id`, `string_instruments.device_id`, `routes.source_device`, `routes.destination_device` | → `devices.id` **CASCADE** |
| `midi_instrument_routings.device_id` | → `devices.id` **SET NULL** (choix délibéré : préservation hors ligne) |
| `loop_arrangement_blocks.loop_id`, `lighting_rules.device_id` | **CASCADE** |
| **`instrument_voices.device_id`** | **AUCUNE** |
| **`instrument_light_state.device_id`** | **AUCUNE** |
| **`instrument_light_config.device_id`** | **AUCUNE** |
| **`lighting_rules.instrument_id`** | **AUCUNE** |

### F-79 — orphelins et **résurrection** (P2)

```
avant DELETE FROM devices : voices=1  light_state=1  light_config=1  instruments_latency=1
après                     : voices=1  light_state=1  light_config=1  instruments_latency=0
foreign_key_check         : []        ← SQLite n'a rien à signaler : il n'y a pas de FK
```

Conséquence mesurée (test RI-3) : on supprime l'instrument `usb-piano-1`, on
rebranche le même appareil (même `device_id`) — et
`listInstrumentVoices('usb-piano-1', 0)` **rend la voix GM 42 de l'ancien
instrument**, `getInstrumentLightState` rend l'ancienne luminosité 64.
L'instrument « neuf » hérite silencieusement des réglages du précédent.

Aggravant : `deleteInstrumentLightByDevice()` existe, est relayée sur trois
niveaux (`InstrumentLightDB` → `InstrumentDatabase` → `Database`), et son JSDoc
dit « *called when a device is removed* ». **Aucun handler ne l'appelle**
(0 référence hors de la chaîne de délégation). C'est du code de nettoyage mort.

Second constat (test RI-6) : **aucune ligne de `src/` n'exécute jamais
`DELETE FROM devices`**. Les cascades du schéma sur `devices` sont donc, en
production, **dormantes** — la suppression d'un instrument passe par
`instrument_delete`, qui fait le ménage à la main.

### F-81 — `instrument_delete` n'est pas atomique (P2)

`src/api/commands/InstrumentSettingsCommands.js:601-655` : quatre suppressions
(`instruments_latency`, `string_instruments`, `instrument_voices`,
`midi_instrument_routings`) dans **quatre `try/catch` séparés**, hors
transaction. Une panne au milieu laisse un instrument à moitié supprimé, et
le handler renvoie quand même `{ success: true }` — les erreurs partielles
partent seulement dans un `logger.warn`. De plus le JSDoc annonce des cascades
vers « *device settings, lighting rules* » qui **n'existent pas dans le code** :
ni `instrument_light_state`, ni `instrument_light_config`, ni `lighting_rules`
ne sont nettoyés.

---

## 6. §Y — Migrations · **PASS** (1 réserve) · niveau 4

`tests/audit/l07-migrations.test.js` — 8 tests. **Aucune migration n'a été
ajoutée au dépôt** : la panne est injectée en pré-créant, dans la base de test,
une table homonyme qui fait échouer le 3ᵉ statement de
`018_loop_arrangements.sql`.

| Question du mandat | Mesure | Verdict |
|---|---|---|
| Rejeu (idempotence) | 3 passages consécutifs : versions, tables (33), index (80), triggers (14) **strictement identiques** | PASS |
| **Panne au MILIEU du fichier N** | `Migration 18 failed: no such column: arrangement_id` levé et logué en `error` ; `schema_version` = exactement 1..17 | PASS |
| Atomicité **intra-fichier** | les statements 1 et 3 de la migration 018 (`loop_arrangements`, `loop_arrangement_blocks`) sont **absents** : le fichier entier a été annulé | PASS |
| Reprise | après retrait de l'obstacle, relance → 18..34 appliquées, 33 tables, `integrity_check = ok`, `foreign_key_check = []` | PASS |
| Base **non vide** | données métier insérées à la version 17 puis montée à 34 : lignes conservées, colonnes `scale_root` (032) et `pitch_bend_enabled` (034) présentes | PASS |
| Base « legacy » pré-baseline **réaliste** | réconciliée une seule fois (avertissement `pre-baseline schema_version`), version 1 ré-étiquetée `Baseline schema…`, schéma complet ; 2ᵉ passage silencieux | PASS |
| Ordre numérique / unicité des préfixes | 34 fichiers, préfixes 1..34 sans doublon ni trou | PASS |
| Migration **descendante** | aucun fichier `*_down.sql`, aucune fonction de rollback : **il n'y en a pas**. La reprise après mauvaise migration passe obligatoirement par une restauration de sauvegarde | PASS (constat) |

Le contrat annoncé dans `CLAUDE.md` — « *a failure at file N keeps 1..N-1
committed and retries from N* » — est donc **prouvé**, pas seulement affirmé.

### F-80 — la détection « legacy » ne regarde que la description (P2)

`reconcileLegacySchemaVersion()` décide qu'une base est « legacy » sur le seul
critère : *la ligne `schema_version` version 1 existe et sa description ne
commence pas par « Baseline schema »*. Elle conserve alors la version 1 — donc
**`001_baseline.sql` est définitivement sauté**.

Sur une vraie base legacy c'est correct (l'ancienne chaîne avait déjà créé les
tables). Sur une base **mal étiquetée** — restaurée partiellement, éditée à la
main, issue d'un fork — le baseline est sauté alors qu'aucune de ses tables
n'existe, et la première migration qui touche `instruments_latency` échoue :

```
SqliteError: no such table: instruments_latency
    at runSingleMigration (src/persistence/DatabaseLifecycle.js:148)
```

Comme `DatabaseManager` applique les migrations **dans son constructeur**, cette
erreur remonte jusqu'à `Application.initialize()` : **le service ne démarre
pas**, et le message ne dit pas à l'opérateur quoi faire. Test `Y-5b`.

**Correctif recommandé** : croiser la description avec l'existence réelle des
tables du baseline, par exemple

```diff
--- a/src/persistence/DatabaseLifecycle.js
+++ b/src/persistence/DatabaseLifecycle.js
@@ export function reconcileLegacySchemaVersion(db, logger) {
   if (!row) return; // no version-1 row — baseline will insert it
   if (String(row.description || '').startsWith('Baseline schema')) return;
+  // Une description non-baseline ne suffit pas : il faut que la base porte
+  // VRAIMENT le schéma legacy. Sinon on saute le baseline sur une base vide et
+  // le service ne démarre plus (audit 2026-09-07 L07, F-80).
+  const hasLegacyTables = Boolean(
+    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='instruments_latency'").get()
+  );
+  if (!hasLegacyTables) {
+    logger.warn(
+      'schema_version version 1 non-baseline mais schéma absent : la ligne est ignorée et ' +
+        '001_baseline.sql sera appliqué (base mal étiquetée / restauration partielle).'
+    );
+    db.prepare('DELETE FROM schema_version WHERE version >= 1').run();
+    return;
+  }
```

---

## 7. §Z — Sauvegardes et restauration · **PASS** · niveau 4

`tests/audit/l07-backup-restore.test.js` — 11 tests. `BackupScheduler` était à
**16,5 %** de couverture.

| Scénario | Mesure | Verdict |
|---|---|---|
| **Sauvegarde PENDANT des écritures continues** (base de 47 Mo, 150 000 lignes, 55 insertions concurrentes) | `integrity_check = ok`, **150 060 lignes dans la sauvegarde = 150 060 dans la base vivante**. `db.backup()` redémarre la copie à chaque écriture : instantané cohérent et à jour, jamais un mélange | PASS |
| Restauration d'une sauvegarde **tronquée** (moitié du fichier) | refusée : `Backup file is not a valid SQLite database: database disk image is malformed` ; base vivante intacte | PASS |
| Restauration d'une sauvegarde **corrompue** (en-tête valide, 4 Ko écrasés dans le corps) | refusée par `PRAGMA integrity_check` — une simple sniffe d'en-tête l'aurait laissée passer | PASS |
| Fichier non-SQLite / fichier absent | refusés avec messages distincts | PASS |
| Restauration **nominale** | le canari revient, `integrity_check = ok`, sous-modules reconstruits, aucun résidu `.prerestore` / `.restore-tmp` | PASS |
| **Disque plein** (écriture du fichier temporaire rendue impossible) | `SQLITE_CANTOPEN`, **aucun fichier partiel au nom canonique**, `Backup failed` logué. C'est le point critique : sans le `.tmp` + `rename`, la rétention garderait la sauvegarde inutilisable et purgerait les bonnes | PASS |
| **Arrêt pendant une sauvegarde** (`close()` en vol) | la promesse rejette `The database connection is not open`, aucun `.tmp` résiduel, aucun fichier canonique | PASS |
| Rétention (6 sauvegardes, `maxBackups = 3`) | garde les 3 plus récentes par mtime + purge les 3 manifests associés | PASS |
| **Plancher de GC** (0 blob référencé) | **aucune suppression**, `Blob GC skipped: 0 referenced blobs (guard against mass deletion)` | PASS |
| GC avec ≥ 1 blob référencé | le blob référencé survit, l'orphelin est réclamé | PASS |
| Manifeste | `blobCount: 1, missingCount: 1` avec le `blobPath` manquant nommé | PASS |

C'est la section la plus saine du lot. Une réserve : **l'arrêt du service pendant
la sauvegarde nocturne la perd silencieusement** (l'échec est logué par
`runBackup`, jamais remonté à l'UI) — voir F-85 pour le même sujet côté GC.

---

## 8. F-04 — le skip silencieux · **CONFIRMÉ OUVERT, AGGRAVÉ** · niveau 5

`jest.config.cjs` sonde les bindings natifs de `better-sqlite3` et, s'ils
manquent, **retire du run** toute suite dont la source matche
`/better-sqlite3|\bnew DatabaseManager\s*\(|new Database\s*\(\s*\{|runMigrations\s*\(/`.
Aucun message n'est émis, et Jest sort en **code 0** avec « Ran all test suites ».

### Quantification du trou

```
suites collectées (binding présent) : 187
suites collectées (binding absent)  : 170
                                      ---
                                      17 suites disparaissent
```

Les **10 suites historiques** valent à elles seules **335 tests** :

```
tests/bluetooth-persistence-reconnect.test.js   tests/migrations-fresh-install.test.js
tests/database-restore-reopen.test.js           tests/repositories/repository-delegations.test.js
tests/filemanager-adapted-persist.test.js       tests/repositories/routing-integration.test.js
tests/harmonica-config-db.test.js               tests/sysex-identity-mapping.test.js
tests/instrument-scale-root-db.test.js          tests/midi-filter.test.js
```

**Aggravation mesurée aujourd'hui :** 7 suites d'audit s'ajoutent à la liste —
`tests/audit/l06-capability-matrix.test.js` et **les 6 suites de ce lot**.
Autrement dit, sans le correctif, *tout le travail de vérification de la
persistance produit par cet audit disparaîtrait en silence sur une CI sans
en-têtes natifs*.

### Preuve du silence

Configuration normale vs configuration dégradée (copie de `jest.config.cjs` avec
la sonde forcée à « absente »), sur les deux mêmes fichiers :

```
### CONFIG NORMALE (binding présent)
Test Suites: 2 passed, 2 total
Tests:       19 passed, 19 total
Ran all test suites matching /tests\/migrations-fresh-install.test.js|tests\/event-bus.test.js/i.

### CONFIG DÉGRADÉE (binding absent, simulé)
Test Suites: 1 passed, 1 total
Tests:       14 passed, 14 total
Ran all test suites matching /tests\/migrations-fresh-install.test.js|tests\/event-bus.test.js/i.
exit=0
```

Cinq tests ont disparu, la phrase affichée est la même, le code de sortie est 0.

### Correctif proposé — diff exact (à appliquer en vague 2)

Principe : **ne rien changer au comportement quand le binding est présent** ;
quand il manque, écrire un avertissement bruyant sur `stderr` **et** exiger un
opt-in explicite (`GMBOOP_ALLOW_SQLITE_SKIP=1`) pour que le run puisse continuer.
Sans cet opt-in, la configuration échoue immédiatement — la CI devient rouge au
lieu d'être faussement verte.

```diff
--- a/jest.config.cjs
+++ b/jest.config.cjs
@@
 const ignorePatterns = ['/node_modules/', '/tests/frontend/', '/tests/audit-i18n.test.js'];
 
 if (!hasBetterSqlite) {
-  for (const suite of collectSqliteSuites(join(__dirname, 'tests'))) {
+  const skipped = collectSqliteSuites(join(__dirname, 'tests'));
+  for (const suite of skipped) {
     // Anchor on the repo-relative path so only this exact file is ignored.
     ignorePatterns.push(suite.slice(__dirname.length).replace(/\\/g, '/'));
   }
+
+  // Le skip ne doit JAMAIS être silencieux : Jest afficherait « Ran all test
+  // suites » et sortirait en 0 alors que N suites ont disparu du run
+  // (audit 2026-08-22 F-04, re-mesuré 2026-09-07 : 17 suites, dont les 335
+  // tests des 10 suites de persistance historiques).
+  const banner = [
+    '',
+    '='.repeat(78),
+    `  ATTENTION : bindings natifs better-sqlite3 ABSENTS.`,
+    `  ${skipped.length} suite(s) de test sont RETIRÉES du run :`,
+    ...skipped.map((s) => `    - ${s.slice(__dirname.length + 1)}`),
+    '',
+    '  La couverture des migrations, des dépôts et de la persistance est NULLE',
+    '  dans ce run. Corrigez l\'environnement :',
+    '      npm rebuild better-sqlite3 --build-from-source',
+    '',
+    '  Pour accepter délibérément ce run dégradé (poste de dev sans toolchain) :',
+    '      GMBOOP_ALLOW_SQLITE_SKIP=1 npm test',
+    '='.repeat(78),
+    ''
+  ].join('\n');
+  process.stderr.write(banner);
+
+  if (!process.env.GMBOOP_ALLOW_SQLITE_SKIP) {
+    throw new Error(
+      `jest.config.cjs : ${skipped.length} suite(s) SQLite seraient silencieusement ignorées. ` +
+        'Recompilez better-sqlite3, ou relancez avec GMBOOP_ALLOW_SQLITE_SKIP=1 pour ' +
+        'accepter explicitement un run dégradé.'
+    );
+  }
 }
```

> **Note pour la vague 2 :** si la CI doit pouvoir tourner sans toolchain natif,
> ajouter `GMBOOP_ALLOW_SQLITE_SKIP=1` **uniquement** au job concerné — jamais
> par défaut dans `package.json`, sinon le garde-fou est neutralisé et on
> retombe exactement sur F-04.

---

## 9. §AA / §E04 — FileManager, blobstore, import / export · **PARTIAL** · niveau 4 / 3

`tests/audit/l07-filemanager-blobstore.test.js` — 11 tests.

| Scénario | Mesure | Verdict |
|---|---|---|
| **Export → réimport** | l'aller-retour retombe sur la même ligne (`content_hash` UNIQUE), statut `duplicate`. **Le nouveau nom choisi par l'opérateur est silencieusement ignoré** : c'est le nom d'origine qui est renvoyé | PARTIAL |
| Fichier volumineux | plafond `LIMITS.MAX_MIDI_FILE_SIZE` = 10 Mo appliqué **avant** l'écriture du blob : `File too large: 10.0MB exceeds 10MB limit`, aucun blob écrit | PASS |
| MIDI invalide | refusé, **aucun blob orphelin** laissé derrière | PASS |
| Unicode (accents, emoji `\u{1F3B9}`, arabe) | nom restitué octet pour octet, listé correctement | PASS |
| Collision de **nom** (contenus différents) | deux lignes distinctes — aucune contrainte d'unicité sur `filename` (choix assumé) | PASS |
| Collision de **contenu** (noms différents) | une seule ligne, statut `duplicate` | PASS |
| Suppression | ligne + blob partent, cascades comprises, 0 orphelin | PASS |
| **Traversée de chemin** via `blob_path` forgé en base | bloquée : `BlobStore: path escapes base dir` sur `resolve`, `delete` et `loadFile` | PASS |
| Écritures concurrentes du **même contenu** (×3) | 1 blob, 1 ligne, 1 seul `fileId` | PASS |
| Divergence base ↔ disque | **aucun outil applicatif ne la détecte** (voir ci-dessous) | PARTIAL |
| **Noms hostiles** | **tous acceptés** (voir F-82) | **FAIL** |

### F-82 — aucun filtre sur le nom à l'import (P2)

Les 12 noms suivants sont acceptés et stockés **verbatim** dans
`midi_files.filename` :

```
"../../../etc/passwd.mid"   "..\\..\\windows\\system32.mid"   "/absolu/x.mid"
"saut\nligne.mid"           "nul\0octet.mid"              "<img src=x onerror=alert(1)>.mid"
"xxxx…(404 caractères)"     "."                               ".."
""  (chaîne vide)           "emoji-🎹-ünïcødé.mid"            "مرحبا.mid"
```

Ce qui **sauve la mise** : le chemin sur disque vient du hash de contenu, jamais
du nom (`^midi/[0-9a-f]{2}/[0-9a-f]{64}\.mid$` vérifié pour tous les blobs) ;
rien n'a été écrit hors des répertoires attendus ; `/etc/passwd.mid` n'existe
pas. Et `GET /api/files/:id/blob?dl=1` assainit le `Content-Disposition`
(`[^\w.-] → _`).

Ce qui reste : **une asymétrie de contrat**. `file_rename` et `file_save_as`
appliquent `validateFilename()` (rejet des séparateurs, octets de contrôle,
`.`/`..`, > 255 caractères) — mais `POST /api/files?filename=` n'applique
**rien** (`src/api/apiRoutes.js:138` : `String(req.query.filename || '').trim()
|| 'upload.mid'`). Une base peut donc contenir des noms qu'aucune commande de
renommage n'accepterait. Le risque résiduel est le rendu UI (à croiser avec L09
/ L10 pour la discipline `t()` / `tHtml()`), pas le système de fichiers.

**Correctif recommandé** : appliquer `validateFilename` dans la route d'import,
et renvoyer 400 — un ajout de 4 lignes dans `apiRoutes.js` (chemin non autorisé
pour ce lot).

### F-83 — `exportFile` ne vérifiait pas les octets (P2) — **CORRIGÉ**

Constat initial (test rouge) :

```
ligne sans blob → chargement : "BlobStore: blob missing on disk: midi/c3/…"
                  export     : succès, url = /api/files/1/blob?dl=1
```

`loadFile` détectait la divergence, `exportFile` non : le client recevait une URL
de téléchargement valide en apparence, qui échouait plus tard en 404/500 sans
explication. Correctif appliqué (`src/files/FileManager.js`) :

```diff
   async exportFile(fileId) {
     const file = this.database.getFile(fileId);
     if (!file) throw new Error(`File not found: ${fileId}`);
+    // Verify the bytes are actually there BEFORE handing the client a download
+    // URL. […] (audit 2026-09-07 L07, F-83)
+    this.blobStore.resolve(file.blob_path);
     return {
```

Test `E04-2` : rouge avant, vert après. Aucune régression sur
`filemanager-adapted-persist`, `upload-queue`, `blobstore-path-guard`,
`file-write-schema-validation`.

### Divergence base ↔ disque : toujours aucune commande de réconciliation

Les deux sens de divergence sont reproduits (test `AA-7`) :

* **blob sans ligne** (orphelin) — n'est réclamé que par `gcOrphans`, appelé
  **uniquement** depuis `BackupScheduler.runBackup()`, **après une sauvegarde
  réussie**. Si les sauvegardes échouent (disque plein, service arrêté la nuit),
  les orphelins s'accumulent indéfiniment. → **F-85 (P3)**.
* **ligne sans blob** — le fichier reste **listé dans l'UI** comme s'il était
  sain et ses octets comptent toujours dans `getStorageStats()`. Le seul
  mécanisme existant est le manifeste de sauvegarde, qui **signale**
  (`missingBlobs`) sans rien réconcilier.

La recommandation de l'audit du 2026-08-22 (« *DB↔blob consistency check […]
expose as a maintenance command* ») reste **entièrement ouverte**.

### F-84 — l'export est une surface morte (P3)

* `file_export` est enregistré (`FileCommands.js:552`) et possède un schéma —
  mais **aucun code de `public/js/` ne l'appelle** (0 occurrence de
  `file_export`, de `dl=1` ou d'un lien de téléchargement de fichier MIDI).
  Seul l'import est câblé (`BackendAPIClient.js:540` → `POST /api/files`).
* Son JSDoc annonce « *Includes `data` (base64) + filename for download* » alors
  que l'implémentation renvoie une **URL**. Contrat documenté ≠ contrat réel.

§E04 se conclut donc ainsi : **import PASS, export non atteignable depuis
l'interface**. À croiser avec L13 (complétude fonctionnelle) et F-03 (commandes
sans schéma / sans appelant).

---

## 10. Recommandations, par priorité

| Pri | Action | Fichier |
|---|---|---|
| **P1** | **F-76** — sérialiser `apply_assignments` par `originalFileId` (mutex, comme `UploadQueue`) **ou** compare-and-swap sur `content_hash` avant écriture | `PlaybackAssignmentCommands.js` |
| P2 | **F-04** — appliquer le diff §8 : bannière + `GMBOOP_ALLOW_SQLITE_SKIP` obligatoire | `jest.config.cjs` |
| P2 | **F-77** — renvoyer un conflit explicite (409) au client dont l'écriture a été écrasée, plutôt qu'un `success` mensonger | `PlaybackAssignmentCommands.js` |
| P2 | **F-79** — ajouter les FK manquantes (migration) **ou** appeler `deleteInstrumentLightByDevice()` + supprimer `instrument_light_config` dans `instrument_delete` | migration + `InstrumentSettingsCommands.js` |
| P2 | **F-80** — croiser la détection legacy avec l'existence réelle des tables (diff §6) | `DatabaseLifecycle.js` |
| P2 | **F-81** — envelopper les 4 suppressions de `instrument_delete` dans une transaction et renvoyer `success: false` si une seule échoue ; corriger le JSDoc | `InstrumentSettingsCommands.js` |
| P2 | **F-78** — positionner `timeout` explicitement à l'ouverture (diff §3) et documenter qu'aucun second processus ne doit écrire pendant la lecture | `DatabaseLifecycle.js`, `Database.js` |
| P2 | **F-82** — appliquer `validateFilename` dans `POST /api/files` | `apiRoutes.js` |
| P2 | Commande de maintenance `storage_consistency_check` : blobs orphelins, lignes sans blob, tailles divergentes (recommandation 2026-08 toujours ouverte) | `FileCommands.js` + `FileManager.js` |
| P3 | **F-84** — soit câbler un bouton « Exporter » dans l'UI, soit retirer `file_export` et son schéma | SPA / `FileCommands.js` |
| P3 | **F-85** — déclencher `gcOrphans` sur un calendrier propre, indépendant du succès de la sauvegarde ; adopter la politique « supprimer seulement si `mtime > now − graceMs` » déjà décrite dans `BlobStore.gcOrphans` | `BackupScheduler.js`, `BlobStore.js` |
| P3 | Ajouter `UNIQUE(playlist_id, position)` pour que l'ordre de playlist soit garanti par le schéma, pas par le fait que le pilote est synchrone | migration |
| P3 | Documenter explicitement l'absence de migration descendante et la procédure « restaurer une sauvegarde » | `docs/` |
| **HW** | Mesurer sur Pi la latence des requêtes pendant la lecture (§X05 côté matériel) : SQLite synchrone bloque la boucle MIDI — F-78 en donne la borne haute (5 s) | L15 |

---

## 11. Fichiers produits par ce lot

| Fichier | Contenu |
|---|---|
| `docs/audit/2026-09-07/07_PERSISTENCE.md` | ce rapport |
| `tests/audit/l07-sqlite-concurrency.test.js` | §X — 7 tests (pragmas, multi-processus, `SQLITE_BUSY`, gel de la boucle, transactions imbriquées, WAL) |
| `tests/audit/l07-app-concurrency.test.js` | §W — 6 tests (deux onglets : apply ×2, apply + suppression, instrument, playlist) |
| `tests/audit/l07-referential-integrity.test.js` | 6 tests (inventaire des FK, cascades, orphelins, résurrection) |
| `tests/audit/l07-migrations.test.js` | §Y — 8 tests (panne au milieu de N, reprise, rejeu, base non vide, legacy, ordre, pas de descendante) |
| `tests/audit/l07-backup-restore.test.js` | §Z — 11 tests (sauvegarde à chaud, tronquée, corrompue, disque plein, arrêt en vol, rétention, GC, manifeste) |
| `tests/audit/l07-filemanager-blobstore.test.js` | §AA / §E04 — 11 tests (export/réimport, noms hostiles, Unicode, collisions, cap, divergence, traversée) |

**Modification de code appliquée :** une seule, `src/files/FileManager.js`
(`exportFile` vérifie la présence du blob — F-83), prouvée par un test
rouge→vert. Aucun fichier partagé modifié, aucune migration créée, aucune
commande git.

**Contrôles :** `eslint` 0 erreur 0 avertissement sur les 6 suites et sur
`FileManager.js` ; `prettier --check` propre ; 49 tests verts.
