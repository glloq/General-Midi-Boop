# Suivi refactorisation — Ma-est-tro

> Fichier vivant, mis à jour par chaque agent à la fin de son lot.
> Référence le plan de fond : [`docs/REFACTORING_PLAN.md`](../REFACTORING_PLAN.md).

## État courant

| Champ | Valeur |
|---|---|
| Phase active | **Phase 0 terminée** → **Phase 1 — Stabilisation Playback** |
| Branche de travail | `claude/dazzling-ptolemy-rXsBU` |
| Dernier lot terminé | P0-2.3 |
| Prochain lot suggéré | P0-2.4 (centraliser transactions/rollbacks) ou P0-2.5 (retirer accès SQL directs depuis handlers) |
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
- [ ] **P0-2.4** Centraliser transactions/rollbacks dans la couche Repository.
- [ ] **P0-2.5** Retirer tous les accès SQL directs depuis `src/api/commands/**`.
- [ ] **P0-2.6** Tests d'intégration DB : split / no-split / overwrite.

### Phase 3 — Validation et erreurs

- [ ] **P1-3.1** Concevoir le format de schéma déclaratif pour `JsonValidator` (ADR).
- [ ] **P1-3.2** Migrer les validateurs commande par commande (playback en premier).
- [ ] **P1-3.3** Normaliser les erreurs sur `src/core/errors/index.js` — supprimer les `throw new Error(...)` bruts dans les handlers.
- [ ] **P1-3.4** Vérifier uniformité des payloads d'erreur côté client.

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

---

## Blocages actifs

Aucun.

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
