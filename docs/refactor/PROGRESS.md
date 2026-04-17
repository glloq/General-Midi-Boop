# Suivi refactorisation — Ma-est-tro

> Fichier vivant, mis à jour par chaque agent à la fin de son lot.
> Référence le plan de fond : [`docs/REFACTORING_PLAN.md`](../REFACTORING_PLAN.md).

## État courant

| Champ | Valeur |
|---|---|
| Phase active | **Phase 2 — Persistance (migration handlers)** |
| Branche de travail | `claude/refactor-maestro-project-L6ptg` |
| Dernier lot terminé | P1-3.1b |
| Prochain lot suggéré | **P1-3.2a** : créer `src/api/commands/schemas/playback.schemas.js` et migrer les validateurs inline des 4 sous-modules playback vers `JsonValidator.validateBySchema`. |
| Date dernière mise à jour | 2026-04-17 |
| Agent ayant mis à jour | Claude (agent refactoring) |

## Règles de mise à jour

Chaque agent, **avant de committer son lot**, doit :

1. cocher les todos terminés dans la section Todos ;
2. ajouter une ligne dans §Journal (un lot = une ligne) ;
3. ajouter les nouveaux todos découverts pendant le lot ;
4. ajouter une note §Remarques si une décision, un blocage ou un écart survient ;
5. mettre à jour §État courant (dernier lot, prochain lot suggéré, date, agent).

Un lot = **2–5 jours max de travail**, **une PR cohérente**, **pas de changement fonctionnel**.

## Légende

- `[ ]` à faire
- `[/]` en cours
- `[x]` terminé
- `[!]` bloqué (voir §Remarques)
- Identifiants `P0-0.x` / `P1-3.x` = priorité + phase + numéro de lot

---

## Todos

### Phase 0 — Baseline sécurité

- [x] **P0-0.1** Créer `docs/refactor/contracts/README.md` — méthode de génération des snapshots WS (outil, format, revue).
- [x] **P0-0.2** Capturer les snapshots de contrats WS pour `playback.*` (start, stop, seek, loop, transpose, adapt).
- [x] **P0-0.2b** Capturer snapshots des commandes playback avancées : `analyze_channel`, `generate_assignment_suggestions`, `apply_assignments`, `validate_instrument_capabilities`, `get_instrument_defaults`, `update_instrument_capabilities`, `get_file_routings`, `playback_validate_routing`, `playback_set_disconnect_policy`, `playback_get_channels`, `playback_set_channel_routing`, `playback_clear_channel_routing`, `playback_mute_channel`.
- [x] **P0-0.3** Capturer les snapshots de contrats WS pour `routing.*` et assignations.
- [x] **P0-0.4** Produire `docs/adr/ADR-001-refactor-strategy.md` (décision hybride V2→V3).
- [x] **P0-0.5** Produire `docs/refactor/dependency-matrix.md` v1 pour les 5 modules backend + 4 frontend cités au plan §12.
- [x] **P0-0.6** Ajouter tests Jest de contrat sur les 5 commandes playback les plus utilisées.
- [x] **P0-0.7** Ajouter tests Jest de contrat sur les commandes routing critiques.
- [x] **P0-0.8** Documenter la checklist de refactor (no behavior change, payload stable, logs stables) dans `docs/refactor/CHECKLIST.md`.

### Phase 1 — Stabilisation Playback + MIDI adaptation

- [x] **P0-1.1** Découper `src/api/commands/PlaybackCommands.js` (≈1124 LOC) — extraire sous-module *playback control* (start/stop/seek/loop).
- [x] **P0-1.2** Découper `PlaybackCommands.js` — extraire sous-module *analysis/suggestions*.
- [x] **P0-1.3** Découper `PlaybackCommands.js` — extraire sous-module *assignment apply*.
- [x] **P0-1.4** Découper `PlaybackCommands.js` — extraire sous-module *routing validation*.
- [x] **P0-1.5** Produire `ADR-002-repository-layer.md` avant Phase 2.
- [x] **P0-1.6** Extraire `MidiAdaptationService` regroupant les interfaces de `TablatureConverter`, `DrumNoteMapper`, `ChannelSplitter`, `InstrumentMatcher`, `Transposer`.
- [ ] **P0-1.7** Déplacer la logique métier Playback vers `src/midi/domain/playback/`. *(reporté — le découpage est effectif via les 4 sous-modules playback/; le déplacement physique vers domain/ attendra Phase 4 pour éviter un rename massif prématuré)*
- [x] **P0-1.8** Vérifier réduction de taille `PlaybackCommands.js` > 40 %. → **-99 % (1124 → 13 LOC orchestrateur)**

### Phase 2 — Persistance (consolidation Repositories)

- [x] **P0-2.1** Introduire `FileRepository` au-dessus de `MidiDatabase`.
- [x] **P0-2.2** Introduire `RoutingRepository` au-dessus de `RoutingPersistenceDB` + `MidiRouter`.
- [x] **P0-2.3** Introduire `InstrumentRepository` au-dessus de `InstrumentDatabase` + `InstrumentSettingsDB`.
- [x] **P0-2.4** Centraliser transactions/rollbacks dans la couche Repository. *(helper `transaction(fn)` ajouté sur les 3 Repositories, délègue à `Database.transaction()` qui expose `db.transaction()` de better-sqlite3)*
- [x] **P0-2.5** Retirer tous les accès SQL directs depuis `src/api/commands/**`. *(terminé — seul `app.database.backup()` dans `SystemCommands.js` conservé avec commentaire justificatif : op admin du fichier DB, hors domaine métier)*
  - [x] **P0-2.5a** Migrer les 3 handlers playback read-only (`PlaybackAnalysisCommands`, `PlaybackRoutingCommands`, `PlaybackControlCommands`) vers `fileRepository`/`routingRepository` — 5 call sites.
  - [x] **P0-2.5b** Migrer `RoutingCommands.js` (8 appels, tous couverts par `FileRepository` + `RoutingRepository` existants).
  - [x] **P0-2.5c** Migrer `PlaybackAssignmentCommands.js` (15 appels migrés vers `fileRepository`/`routingRepository`/`instrumentRepository`).
  - [x] **P0-2.5d** Migrer `FileCommands.js` (8 appels ; `FileRepository` étendu de 5 méthodes : `search`, `filter`, `countNeedingReanalysis`, `getDistinctInstruments`, `getDistinctCategories`).
  - [x] **P0-2.5e** Encapsuler le SQL inline de `InstrumentSettingsCommands.js` L292-316 et `VirtualInstrumentCommands.js` L133 (réalisé avec P0-2.5m + P0-2.5n via `InstrumentSettingsDB.deleteByDevice`, `StringInstrumentDatabase.deleteByDevice`, `RoutingPersistenceDB.deleteRoutingsByDevice`).
  - [x] **P0-2.5f** `PresetCommands.js` + nouveau `PresetRepository` (6 appels).
  - [x] **P0-2.5g** `SessionCommands.js` + nouveau `SessionRepository` (6 appels).
  - [x] **P0-2.5h** `PlaylistCommands.js` + nouveau `PlaylistRepository` (14 appels).
  - [x] **P0-2.5i** `LightingCommands.js` + nouveau `LightingRepository` (25 appels).
  - [x] **P0-2.5j** `StringInstrumentCommands.js` + nouveau `StringInstrumentRepository` (18 call sites réels — un handler d'un call site peut faire plusieurs patterns sub-module).
  - [x] **P0-2.5k** `DeviceSettingsCommands.js` + nouveau `DeviceSettingsRepository` (3 appels).
  - [x] **P0-2.5l** `DeviceCommands.js` (14 appels migrés via `instrumentRepository` + `deviceSettingsRepository`).
  - [x] **P0-2.5m** `VirtualInstrumentCommands.js` (11 appels, y compris 1 SQL inline `DELETE FROM instruments_latency` encapsulé dans nouvelle méthode `InstrumentSettingsDB.deleteByDevice(deviceId, channel?)`).
  - [x] **P0-2.5n** `InstrumentSettingsCommands.js` (tous les appels migrés, y compris les 6 SQL inline — encapsulés dans `StringInstrumentDatabase.deleteByDevice` et `RoutingPersistenceDB.deleteRoutingsByDevice` + déjà fait pour `instruments_latency` en P0-2.5m).
  - [x] **P0-2.5o** `SystemCommands.js` (`getFiles('/')` → `fileRepository.findByFolder` ; `database.backup()` conservé car op admin du fichier DB, pas du domaine).
- [x] **P0-2.6** Tests d'intégration DB : split / no-split / overwrite (7 tests sur SQLite réel via `tests/repositories/routing-integration.test.js`).

### Phase 3 — Validation et erreurs

- [x] **P1-3.1** Concevoir le format de schéma déclaratif pour `JsonValidator` → [`ADR-004`](../adr/ADR-004-declarative-command-schemas.md).
- [x] **P1-3.1b** Implémenter `src/utils/SchemaCompiler.js` + intégration `JsonValidator.validateBySchema` + tests unitaires (30 tests couvrent types, ranges, enums, lengths, custom, schema-integrity, wrapper).
- [ ] **P1-3.2a** Migrer les schémas playback (premier domaine ; snapshots existants = filet de sécurité).
- [ ] **P1-3.2b** Migrer les schémas routing.
- [ ] **P1-3.2c** Migrer les autres domaines (file, instrument, session, playlist, lighting, stringInstrument, device, devices settings, preset, virtual instrument).
- [x] **P1-3.3** Normaliser les erreurs sur `src/core/errors/index.js` — **déjà respecté** : 0 occurrence de `throw new Error` dans `src/api/commands/**` après la Phase 2.
- [ ] **P1-3.4** Vérifier uniformité des payloads d'erreur côté client (re-jeu des snapshots + audit de `BackendAPIClient`).

### Phase 4 — Domaines étendus + ports/adapters

- [ ] **P1-4.1** Étendre le découpage domaine à `routing` (hors playback).
- [ ] **P1-4.2** Étendre le découpage domaine à `devices` et `files`.
- [ ] **P1-4.3** Identifier ports/adapters prioritaires (drivers MIDI série/BLE, LightingManager, NetworkManager).
- [ ] **P1-4.4** Produire `ADR-003-ws-contract-versioning.md`.
- [ ] **P1-4.5** Appliquer le pattern ports/adapters sur au moins un driver hardware pilote.

### Phase 2-frontend (P2)

- [ ] **P2-F.1** Protocole 5 étapes sur `RoutingSummaryPage.js` (≈4748 LOC) — étape 1 : extraire constantes.
- [ ] **P2-F.2** `RoutingSummaryPage.js` — étape 2 : extraire accès API.
- [ ] **P2-F.3** `RoutingSummaryPage.js` — étape 3 : extraire logique d'état.
- [ ] **P2-F.4** `RoutingSummaryPage.js` — étape 4 : extraire rendu UI en sous-composants.
- [ ] **P2-F.5** `RoutingSummaryPage.js` — étape 5 : orchestrateur léger.
- [ ] **P2-F.6** Appliquer le même protocole à `MidiEditorCCPanel.js` (≈1329 LOC).
- [ ] **P2-F.7** Appliquer le même protocole à `MidiEditorTablature.js` (≈1307 LOC).
- [ ] **P2-F.8** Appliquer le même protocole à `MidiSynthesizer.js` (≈1192 LOC).
- [ ] **P2-F.9** Migrer progressivement vers layout `public/js/features/`.
- [ ] **P2-F.10** Clarifier le pattern mixins de `MidiEditorModal` (recomposition en modules explicites).

### Observabilité (P2)

- [ ] **P2-OBS.1** Ajouter un correlation ID par commande WS (traversée log).
- [ ] **P2-OBS.2** Ajouter métriques temps de traitement sur flux playback (via `EventBus`).
- [ ] **P2-OBS.3** Ajouter métriques sur flux routing/adaptation.

---

## Journal des modifications

Format d'une ligne : date ISO — agent — identifiant lot — résumé — fichiers touchés — commit — notes.

| Date | Agent | Lot | Résumé | Fichiers touchés | Commit | Notes |
|---|---|---|---|---|---|---|
| 2026-04-17 | Claude (refactoring) | P1-3.1b | Nouveau `src/utils/SchemaCompiler.js` : compilateur de schémas déclaratifs (types `id/string/number/integer/boolean/object/array` + min/max/length/enum + custom cross-champ). `JsonValidator.validateBySchema(schema, data)` expose l'API. 30 tests unitaires. Aucune dépendance npm. | `src/utils/SchemaCompiler.js` (créé), `src/utils/JsonValidator.js` (+import + méthode statique), `tests/schema-compiler.test.js` (créé) | (ce commit) | 278/278 tests verts. Base prête pour migration P1-3.2a (playback). |
| 2026-04-17 | Claude (refactoring) | P1-3.1 | Rédaction ADR-004 : schémas déclaratifs maison (Option B) pour la validation des commandes WS. 3 options comparées (Ajv/Zod externe, compilateur maison, typage TS). Format retenu documenté (types id/string/number/integer/boolean/object/array + custom cross-champ). Plan de migration phasé P1-3.1b→P1-3.2c. P1-3.3 déjà clôturé implicitement par la Phase 2. | `docs/adr/ADR-004-declarative-command-schemas.md` (créé) | (ce commit) | Aucune nouvelle dépendance npm (respect plan §10.1). Snapshots WS gardiens. |
| 2026-04-17 | Claude (refactoring) | P0-2.6 | 7 tests d'intégration SQLite : no-split, overwrite, split (multi-segments), split replaces non-split, rollback transactionnel, deleteByFileId, deleteByDevice. Découverte d'un bug latent : `Database.insertSplitRoutings` n'était pas exposé sur la façade (ajouté). Découverte d'une contrainte legacy `UNIQUE(midi_file_id, track_id)` de migration 006 jamais droppée : les splits requièrent des `target_channel` distincts pour coexister (documenté dans le test). | `tests/repositories/routing-integration.test.js` (créé), `src/storage/Database.js` (+délégation `insertSplitRoutings`) | (ce commit) | 248/248 tests verts (241 existants + 7 nouveaux). Note : `tests/midi-filter.test.js` a 18 échecs pré-existants mais reste volontairement skip via `jest.config.cjs` quand better-sqlite3 est absent (cas CI). |
| 2026-04-17 | Claude (refactoring) | P0-2.5c | `PlaybackAssignmentCommands.js` (15 appels migrés vers `fileRepository`/`routingRepository`/`instrumentRepository`). Dernier handler à accès DB direct. | `src/api/commands/playback/PlaybackAssignmentCommands.js` | (ce commit) | 241/241 tests verts. **Fin de P0-2.5** : seul `app.database.backup()` conservé (exception admin documentée). |
| 2026-04-17 | Claude (refactoring) | P0-2.5n | `InstrumentSettingsCommands.js` (33 appels migrés, y compris 6 SQL inline encapsulés). `InstrumentRepository.getAllCapabilities` ajouté. Nouvelles méthodes sub-DB : `StringInstrumentDatabase.deleteByDevice(deviceId, channel?)`, `RoutingPersistenceDB.deleteRoutingsByDevice(deviceId, channel?)`. Exposées via `Database` façade et repositories (`stringInstrumentRepository.deleteByDevice`, `routingRepository.deleteByDevice`). Clôt P0-2.5e. | `src/api/commands/InstrumentSettingsCommands.js`, `src/storage/StringInstrumentDatabase.js`, `src/storage/RoutingPersistenceDB.js`, `src/storage/InstrumentDatabase.js`, `src/storage/Database.js`, `src/repositories/InstrumentRepository.js`, `src/repositories/StringInstrumentRepository.js`, `src/repositories/RoutingRepository.js` | (ce commit) | 241/241 tests verts. |
| 2026-04-17 | Claude (refactoring) | P0-2.5l | `DeviceCommands.js` (14 appels migrés). `InstrumentRepository` étendu : findByUsbSerial, findByMac, findByNormalizedName, reconcileDeviceId, deduplicateByUsbSerial, saveSysExIdentity. Usage de `deviceSettingsRepository` pour getDeviceSettings. | `src/repositories/InstrumentRepository.js`, `src/api/commands/DeviceCommands.js` | (ce commit) | 241/241 tests verts. |
| 2026-04-17 | Claude (refactoring) | P0-2.5m | `VirtualInstrumentCommands.js` (11 appels migrés). `InstrumentRepository` étendu : `updateSettings`, `getSettings`, `getAllSettings`, `findByDevice`, `deleteLatencyProfile`, `deleteSettingsByDevice`. Nouvelle méthode `InstrumentSettingsDB.deleteByDevice(deviceId, channel?)` encapsule le SQL inline `DELETE FROM instruments_latency`, exposée via `InstrumentDatabase.deleteInstrumentSettingsByDevice` et `Database.deleteInstrumentSettingsByDevice`. Préfigure P0-2.5e/P0-2.5n (même table côté InstrumentSettingsCommands). | `src/repositories/InstrumentRepository.js`, `src/storage/InstrumentSettingsDB.js`, `src/storage/InstrumentDatabase.js`, `src/storage/Database.js`, `src/api/commands/VirtualInstrumentCommands.js` | (ce commit) | 241/241 tests verts. Les guards `if (!app.database)` subsistent (boot-time guards). |
| 2026-04-17 | Claude (refactoring) | P0-2.5j | Nouveau `StringInstrumentRepository` (15 méthodes, wrap `database.stringInstrumentDB`). `StringInstrumentCommands.js` migré : 18 call sites `app.database.stringInstrumentDB.*` → `app.stringInstrumentRepository.*`. Le repo masque le chemin sous-module. | `src/repositories/StringInstrumentRepository.js` (créé), `src/core/Application.js`, `src/api/commands/StringInstrumentCommands.js` | (ce commit) | 241/241 tests verts. |
| 2026-04-17 | Claude (refactoring) | P0-2.5i | Nouveau `LightingRepository` (13 méthodes — devices/rules/presets). `LightingCommands.js` migré (25 appels). | `src/repositories/LightingRepository.js` (créé), `src/core/Application.js`, `src/api/commands/LightingCommands.js` | (ce commit) | 241/241 tests verts. |
| 2026-04-17 | Claude (refactoring) | P0-2.5o | `SystemCommands.js` : `app.database.getFiles('/')` → `app.fileRepository.findByFolder('/')`. `app.database.backup(path)` conservé avec commentaire justificatif (op admin sur le fichier DB, pas du domaine métier). | `src/api/commands/SystemCommands.js` | (ce commit) | 241/241 tests verts. |
| 2026-04-17 | Claude (refactoring) | P0-2.5k | Nouveau `DeviceSettingsRepository` (findByDeviceId, ensureDevice, update). `DeviceSettingsCommands.js` migré (3 appels). | `src/repositories/DeviceSettingsRepository.js` (créé), `src/core/Application.js`, `src/api/commands/DeviceSettingsCommands.js` | (ce commit) | 241/241 tests verts. |
| 2026-04-17 | Claude (refactoring) | P0-2.5h | Nouveau `PlaylistRepository` (51 LOC, 11 méthodes) : save, delete, findAll, findById, findItems, addItem, removeItem, reorderItem, updateLoop, clearItems, updateSettings. `PlaylistCommands.js` migré (14 appels). | `src/repositories/PlaylistRepository.js` (créé), `src/core/Application.js`, `src/api/commands/PlaylistCommands.js` | (ce commit) | 241/241 tests verts. |
| 2026-04-17 | Claude (refactoring) | P0-2.5g | Nouveau `SessionRepository` (21 LOC) : save, findById, findAll, delete. `SessionCommands.js` migré (6 appels). | `src/repositories/SessionRepository.js` (créé), `src/core/Application.js`, `src/api/commands/SessionCommands.js` | (ce commit) | 241/241 tests verts. |
| 2026-04-17 | Claude (refactoring) | P0-2.5f | Nouveau `PresetRepository` (25 LOC) : save, findById, findByType, delete, update. Enregistré dans Application.js. `PresetCommands.js` migré : 6 appels `app.database.*` → `app.presetRepository.*`. | `src/repositories/PresetRepository.js` (créé), `src/core/Application.js`, `src/api/commands/PresetCommands.js` | (ce commit) | 241/241 tests verts. Pas d'appels `app.database.*` restants dans PresetCommands.js. Extension de l'ADR-002 (les 3 repos cités ne sont pas exhaustifs — ce pattern s'applique à toutes les entités métier). |
| 2026-04-17 | Claude (refactoring) | P0-2.5d | Migration de `FileCommands.js` (8 appels). `FileRepository` étendu de 5 méthodes : `search`, `filter`, `countNeedingReanalysis`, `getDistinctInstruments`, `getDistinctCategories` (délégations triviales). 3 appels déjà couverts utilisent `findInfoById`, `getChannels`, et `routingRepository.findByFileId`. | `src/repositories/FileRepository.js`, `src/api/commands/FileCommands.js` | (ce commit) | 241/241 tests verts. Aucun `app.database.*` restant dans `FileCommands.js`. Handlers migrés à ce stade : `PlaybackAnalysisCommands`, `PlaybackRoutingCommands`, `PlaybackControlCommands`, `RoutingCommands`, `FileCommands` (5/13 handlers à accès DB). |
| 2026-04-17 | Claude (refactoring) | P0-2.4 | Ajout d'un helper `transaction(fn)` sur les 3 Repositories (`FileRepository`, `RoutingRepository`, `InstrumentRepository`). Chaque helper délègue à `Database.transaction()` (qui expose `db.transaction()` de better-sqlite3). Nouveau test `tests/repositories/transaction-helper.test.js` (3 tests, un par repo). | `src/repositories/FileRepository.js`, `src/repositories/RoutingRepository.js`, `src/repositories/InstrumentRepository.js`, `tests/repositories/transaction-helper.test.js` (créé) | (ce commit) | Débloque P0-2.5c (PlaybackAssignmentCommands utilise des transactions pour les splits). ADR-002 §Conventions 3 confirmé en implémentation. 241/241 tests verts. |
| 2026-04-17 | Claude (refactoring) | P0-2.5b | Migration de `RoutingCommands.js` (8 appels : `deleteRoutingsByFile` ×3 → `routingRepository.deleteByFileId` ; `getRoutingsByFile` ×2 → `findByFileId` ; `getFileChannels` → `fileRepository.getChannels` ; `insertRouting` ×2 → `routingRepository.save`). Mock du contract test routing étendu : spies partagés entre `database.*` et `fileRepository`/`routingRepository` pour préserver les assertions existantes. | `src/api/commands/RoutingCommands.js`, `tests/contracts/routing.contract.test.js` | (ce commit) | 238/238 tests verts. Aucun `app.database.*` restant dans `RoutingCommands.js`. |
| 2026-04-17 | Claude (refactoring) | P0-2.5a | Migration des 3 handlers playback read-only vers `fileRepository`/`routingRepository` (5 call sites). Mock du contract test playback étendu avec `fileRepository`/`routingRepository`. Nouveau test de wiring `tests/api/playback-repository-wiring.test.js` (3 tests) qui prouve la délégation. Première utilisation effective des Repositories créés en P0-2.1→P0-2.3. | `src/api/commands/playback/PlaybackAnalysisCommands.js`, `src/api/commands/playback/PlaybackRoutingCommands.js`, `src/api/commands/playback/PlaybackControlCommands.js`, `tests/contracts/playback.contract.test.js`, `tests/api/playback-repository-wiring.test.js` (créé) | (ce commit) | 238/238 tests verts. Aucun appel `app.database.*` restant dans les 3 handlers touchés. Lint propre. |
| 2026-04-17 | Claude (init) | — | Création plan de référence `REFACTORING_PLAN.md` | `docs/REFACTORING_PLAN.md` | `264ac1a` | Plan initial hybride V2→V3 |
| 2026-04-17 | Claude (init) | — | Enrichissement plan (garde-fous, KPI, ADR, rollback, ordonnancement) | `docs/REFACTORING_PLAN.md` | `5f08f3e` | +139 lignes |
| 2026-04-17 | Claude (init) | — | Création fichiers de suivi et routine agent | `docs/refactor/PROGRESS.md`, `docs/refactor/AGENT_ROUTINE.md` | (ce commit) | Seed initial des todos |
| 2026-04-17 | Claude (refactoring) | P0-0.1 | Création méthode de capture snapshots WS : protocole, format `.contract.json`, patron de test Jest, inventaire 146+ commandes avec criticité, processus de revue | `docs/refactor/contracts/README.md` | `d3d6d67` | Inventaire complet des commandes WS produit |
| 2026-04-17 | Claude (refactoring) | P0-0.2 | Capture snapshots contrats `playback.*` core : start (4 cas), stop, pause, resume, seek (2 cas), status (2 cas), set_loop (2 cas), set_tempo/transpose/set_volume (stubs, 2 cas chacun) | `docs/refactor/contracts/playback/*.contract.json` (10 fichiers) | `81359d0` | Snapshots couvrent le scope P0-1.1 (playback control). Couvre aussi les stubs set_tempo/transpose/set_volume pour figer leur no-op actuel. |
| 2026-04-17 | Claude (refactoring) | P0-0.3 | Capture snapshots contrats routing : CRUD (create/delete/list/enable/info), filtres (filter_set/clear/channel_map), monitors (start/stop/start_all/stop_all), avancées (route_test/duplicate/export/import/clear_all), sync (file_routing_sync avec 5 cas, file_routing_bulk_sync avec 4 cas) | `docs/refactor/contracts/routing/*.contract.json` (19 fichiers) | `be4d677` | Couvre la totalité des handlers de RoutingCommands.js. Les règles de validation CommandRegistry (source+destination pour route_create, routeId pour delete/enable/filter/map, deviceId pour monitor) sont documentées dans chaque snapshot. |
| 2026-04-17 | Claude (refactoring) | P0-0.4 | Rédaction ADR-001 : décision officielle hybride V2→V3 avec ports/adapters V4 ciblés (4 options comparées, impacts, compromis, plan de rollback, critères de réussite) | `docs/adr/ADR-001-refactor-strategy.md` | `a9bfaeb` | Premier ADR du chantier ; ADR-002 (Repository) prévu avant Phase 2, ADR-003 (versionnement WS) prévu en Phase 4 |
| 2026-04-17 | Claude (refactoring) | P0-0.5 | Rédaction matrice dépendances v1 : 5 modules backend (PlaybackCommands, MidiPlayer, InstrumentMatcher, Database, MidiRouter) + 4 frontend (RoutingSummaryPage, MidiEditorCCPanel, MidiEditorTablature, MidiSynthesizer) avec imports statiques, runtime deps, cibles par phase | `docs/refactor/dependency-matrix.md` | `633264b` | Chiffres : PlaybackCommands a 74 accès `app.*`, MidiPlayer 49 accès `this.*`, MidiRouter n'a que 1 import statique (le plus découplé). Frontend utilise IIFE+globals, pas de ES modules. |
| 2026-04-17 | Claude (refactoring) | P0-0.6 | Tests Jest de contrat pour 5 commandes playback (start, stop, seek, status, set_loop) + correction de 3 snapshots où l'erreur observable ne correspondait pas au réel (validator CommandRegistry vs. handler) | `tests/contracts/playback.contract.test.js`, `docs/refactor/contracts/playback/{playback_start,playback_seek,playback_set_loop}.contract.json` | `176a29a` | 5 commandes × 17 cas = 17 tests nominaux+erreurs. Correction des contrats : la validation CommandRegistry pré-handler préfixe les erreurs avec `Invalid <cmd> data: ` et peut concaténer plusieurs erreurs. |
| 2026-04-17 | Claude (refactoring) | P0-0.7 | Tests Jest de contrat pour 8 commandes routing critiques : route_create, route_delete, route_list, route_info, route_enable, route_test, file_routing_sync, file_routing_bulk_sync | `tests/contracts/routing.contract.test.js` | `3a41c6b` | 8 commandes × 22 tests couvrent CRUD, NotFoundError, validation (source/destination/routeId), parsing `deviceId::targetChannel`, virtual-instrument exception, bulk sync multi-fichiers. |
| 2026-04-17 | Claude (refactoring) | P0-0.8 | Rédaction checklist refactor en 8 sections (DoR, IN/OUT, tests, payload, doc, PROGRESS, commit, DoD) + tableau de navigation vers les autres documents | `docs/refactor/CHECKLIST.md` | `d8bc510` | Clôture la Phase 0 baseline sécurité. Tous les garde-fous du plan §10 sont maintenant opérationnels en documentation ET en tests. |
| 2026-04-17 | Claude (refactoring) | P0-2.3 | Création InstrumentRepository (43 LOC) : findById, findAll, findAllWithCapabilities, save, update, delete, getCapabilities, updateCapabilities. Enregistré dans Application.js. | `src/repositories/InstrumentRepository.js` (créé), `src/core/Application.js` | (ce commit) | 3/3 Repositories ADR-002 créés. Prochaine étape : migration des handlers pour utiliser les repositories au lieu de app.database. |
| 2026-04-17 | Claude (refactoring) | P0-2.2 | Création RoutingRepository (30 LOC) : save, saveSplit, findByFileId, countByFiles, deleteByFileId. Enregistré dans Application.js. | `src/repositories/RoutingRepository.js` (créé), `src/core/Application.js` | (ce commit) | |
| 2026-04-17 | Claude (refactoring) | P0-2.1 | Création FileRepository (wrapper ADR-002 option B, 38 LOC) : findById, findInfoById, findByFolder, save, update, delete, getChannels. Enregistré dans Application.js. | `src/repositories/FileRepository.js` (créé), `src/core/Application.js` | (ce commit) | Début Phase 2. La migration des handlers vers fileRepository se fera incrémentalement dans les lots suivants. |
| 2026-04-17 | Claude (refactoring) | P0-1.6 | Création MidiAdaptationService (facade sur MidiTransposer + AutoAssigner, 37 LOC). Intégré dans Application.js via _registerService. PlaybackAssignmentCommands utilise app.adaptationService au lieu de new MidiTransposer. PlaybackAnalysisCommands utilise app.adaptationService au lieu de app.autoAssigner. | `src/midi/MidiAdaptationService.js` (créé), `src/core/Application.js`, `src/api/commands/playback/PlaybackAssignmentCommands.js`, `src/api/commands/playback/PlaybackAnalysisCommands.js` | (ce commit) | Import direct MidiTransposer retiré des handlers. Les handlers dépendent d'une interface unifiée, pas d'implémentations concrètes. |
| 2026-04-17 | Claude (refactoring) | P0-1.5 | ADR-002 : Repositories wrappers au-dessus des sub-DBs existantes. 3 options comparées, option B retenue (consolidation), conventions et architecture cible documentées. | `docs/adr/ADR-002-repository-layer.md` | (ce commit) | Prérequis Phase 2 (P0-2.x). Définit FileRepository, RoutingRepository, InstrumentRepository. |
| 2026-04-17 | Claude (refactoring) | P0-1.4 | Extraction finale : 6 handlers routing/channel → PlaybackRoutingCommands.js. PlaybackCommands.js réduit à 13 LOC (orchestrateur pur 4 imports + 4 register()). | `src/api/commands/playback/PlaybackRoutingCommands.js` (créé, 168 LOC), `src/api/commands/PlaybackCommands.js` (189→13 LOC) | (ce commit) | Découpage complet en 4 sous-modules + cache partagé : Control(131), Analysis(200), Assignment(484), Routing(168), midiConverterCache(12). Total = 1008 LOC vs 1124 baseline (la « croissance » est la structure modulaire). |
| 2026-04-17 | Claude (refactoring) | P0-1.3 | Extraction massive : applyAssignments (~400 LOC), validateInstrumentCapabilities, getInstrumentDefaults, updateInstrumentCapabilities, getFileRoutings vers PlaybackAssignmentCommands.js. Imports parseMidi, MidiTransposer, InstrumentCapabilitiesValidator retirés du parent. | `src/api/commands/playback/PlaybackAssignmentCommands.js` (créé, ~340 LOC), `src/api/commands/PlaybackCommands.js` (752→189 LOC) | (ce commit) | **KPI atteint** : cible < 675, réel 189 (-83%). PlaybackCommands.js est maintenant un orchestrateur pur (6 handlers + 3 delegations). P0-1.4 (routing validation) optionnel à ce stade. |
| 2026-04-17 | Claude (refactoring) | P0-1.2 | Extraction de analyzeChannel + generateAssignmentSuggestions + applyScoringOverrides + restoreScoringConfig + midiConverterCache partagé | `src/api/commands/playback/PlaybackAnalysisCommands.js` (créé, 185 LOC), `src/api/commands/playback/midiConverterCache.js` (créé, 13 LOC), `src/api/commands/PlaybackCommands.js` (989→752 LOC) | (ce commit) | Imports ScoringConfig et JsonMidiConverter retirés du parent. getMidiConverter mutualisé via midiConverterCache.js (utilisé par analysis ET assignment restant). |
| 2026-04-17 | Claude (refactoring) | P0-1.1 | Extraction des 10 handlers de contrôle playback (start/stop/pause/resume/seek/status/set_loop/set_tempo/transpose/set_volume) vers `PlaybackControlCommands.js` | `src/api/commands/playback/PlaybackControlCommands.js` (créé, 120 LOC), `src/api/commands/PlaybackCommands.js` (modifié, 1124→989 LOC) | (ce commit) | 1ère extraction Phase 1. ConfigurationError déplacée dans le sous-module, retirée de l'import parent. Les registrations sont déléguées via `registerPlaybackControl(registry, app)`. |
| 2026-04-17 | Claude (refactoring) | P0-0.2b | 13 snapshots playback avancés : analyze_channel (4 cas), generate_assignment_suggestions (4 cas), apply_assignments (6 cas), validate_instrument_capabilities, get_instrument_defaults (2 cas), update_instrument_capabilities (2 cas), get_file_routings (2 cas), playback_validate_routing (3 cas), playback_set_disconnect_policy (2 cas), playback_get_channels, playback_set_channel_routing (5 cas), playback_clear_channel_routing, playback_mute_channel (4 cas) | `docs/refactor/contracts/playback/*.contract.json` (13 fichiers) | (ce commit) | Phase 0 terminée. 100% des handlers PlaybackCommands.js + RoutingCommands.js sous contrat. |

---

## Remarques / décisions

- **2026-04-17** — Décision : conserver le layout réel (`src/midi/`, `src/storage/`, etc.) plutôt que bouger vers `src/domain/`+`src/infra/`. Cf. `REFACTORING_PLAN.md` §5.
- **2026-04-17** — Décision : consolider les sub-DBs existantes en Repositories, **ne pas** introduire une couche neuve parallèle.
- **2026-04-17** — Freeze SQL actif : aucune nouvelle migration tant que Phase 4 n'est pas terminée (sauf exception ADR).
- **2026-04-17** — Interprétation du scope P0-0.2 (« start, stop, seek, loop, transpose, adapt ») : les commandes de contrôle playback core (playback_start/stop/pause/resume/seek/status/set_loop/set_tempo/transpose/set_volume). Les commandes playback « lourdes » (analyze_channel, generate_assignment_suggestions, apply_assignments, validate_routing, etc.) sont déplacées vers un nouveau lot P0-0.2b afin de garder les lots courts (2-5j). Justification : apply_assignments seul fait ~400 LOC avec multiples cas (split physique/playback, overwrite, cc7 injection, persistance), il nécessite son propre lot focalisé.
- **2026-04-17** — Correction de 3 snapshots lors de P0-0.6 : `playback_start`, `playback_seek`, `playback_set_loop`. La validation `JsonValidator.validatePlaybackCommand` s'exécute **avant** le handler et préfixe les erreurs par `Invalid <command> data: `. De plus, elle peut concaténer plusieurs erreurs (ex. position manquante → deux erreurs jointes). Les snapshots V1 présumaient le message brut du handler, ce qui est incorrect pour les cas où la validator bloque en amont. Les snapshots corrigés distinguent maintenant les cas bloqués par le validator vs. ceux bloqués par le handler.
- **2026-04-17** — Extension implicite d'ADR-002 : les 3 repos initialement cités (File/Routing/Instrument) ne sont pas exhaustifs. Le pattern Repository s'applique à toutes les entités métier. Nouveaux repos créés à la volée : PresetRepository (2.5f). À venir : Session, Playlist, Lighting, StringInstrument, DeviceSettings. Conventions ADR-002 inchangées (thin wrappers au-dessus des sub-DBs, injection via constructor, API métier).
- **2026-04-17** — Découpage de P0-2.5 en sous-lots (a/b/c/d/e) pour respecter la règle « 2-5 j par lot » (plan §14). Ordre recommandé : 2.5a (playback read-only, fait) → 2.5b (RoutingCommands, tout couvert) → 2.5c (PlaybackAssignmentCommands — attend 2.4 pour les transactions) → 2.5d (FileCommands — nécessite extension FileRepository) → 2.5e (SQL inline instrument-settings). Le lot 2.4 (helper `transaction(fn)` sur Repositories) reste à traiter quand 2.5c devient prioritaire.

---

## Blocages actifs

- **tests/midi-filter.test.js — 18 échecs pré-existants** (2026-04-17) : ce fichier de test est skippé par `jest.config.cjs` quand better-sqlite3 n'est pas compilé (cas CI actuel). Les échecs existaient avant les lots Phase 2 (dernière modification du fichier en `a668ae5`, avant Phase 2). Pas bloquant pour le refactor mais à corriger dans un lot dédié hors Phase 2 (scope FilterManager / défauts de tri).
- **Schéma legacy `UNIQUE(midi_file_id, track_id)` sur `midi_instrument_routings`** (2026-04-17) : migration 006 impose cette contrainte jamais droppée par 020/032. Les splits coexistent uniquement si les segments ont des `target_channel` distincts (multi-channel devices). Si des utilisateurs attendent des splits 100 % virtuels (même target), le comportement actuel les rejette. **Hors scope P0-2.6** — freeze SQL actif. À traiter via ADR Phase 4 (migration 041 + script de backfill).

---

## Métriques de suivi (à mettre à jour à chaque fin de phase)

| Métrique | Baseline | Cible | Actuel |
|---|---|---|---|
| `PlaybackCommands.js` LOC | 1124 | < 675 (-40 %) | **13 (-99 %, P0-1.4)** ✅ orchestrateur pur |
| `MidiPlayer.js` LOC | 1312 | < 790 (-40 %) | 1312 |
| `InstrumentMatcher.js` LOC | 1178 | < 710 (-40 %) | 1178 |
| `TablatureConverter.js` LOC | 1250 | < 750 (-40 %) | 1250 |
| `RoutingSummaryPage.js` LOC | 4748 | < 2850 (-40 %) | 4748 |
| Couverture tests P0/P1 | ~20 % | ≥ 35 % | ~20 % |
| Commandes WS critiques sous contrat | 0 % | ≥ 90 % | ~70 % (42 commandes : 23 playback + 19 routing — snapshots complets pour PlaybackCommands.js et RoutingCommands.js) |
| PR refactor sans incident (14 j) | — | ≥ 95 % | — |
