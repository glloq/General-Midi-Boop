# Suivi refactorisation — Ma-est-tro

> Fichier vivant, mis à jour par chaque agent à la fin de son lot.
> Référence le plan de fond : [`docs/REFACTORING_PLAN.md`](../REFACTORING_PLAN.md).

## État courant

| Champ | Valeur |
|---|---|
| Phase active | **Phase 0 — Baseline sécurité** (non démarrée) |
| Branche de travail | `claude/review-refactoring-plan-AqlJO` |
| Dernier lot terminé | — |
| Prochain lot suggéré | Lot P0-0.1 (voir §Todos ci-dessous) |
| Date dernière mise à jour | 2026-04-17 |
| Agent ayant mis à jour | Claude (session initiale) |

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

- [ ] **P0-0.1** Créer `docs/refactor/contracts/README.md` — méthode de génération des snapshots WS (outil, format, revue).
- [ ] **P0-0.2** Capturer les snapshots de contrats WS pour `playback.*` (start, stop, seek, loop, transpose, adapt).
- [ ] **P0-0.3** Capturer les snapshots de contrats WS pour `routing.*` et assignations.
- [ ] **P0-0.4** Produire `docs/adr/ADR-001-refactor-strategy.md` (décision hybride V2→V3).
- [ ] **P0-0.5** Produire `docs/refactor/dependency-matrix.md` v1 pour les 5 modules backend + 4 frontend cités au plan §12.
- [ ] **P0-0.6** Ajouter tests Jest de contrat sur les 5 commandes playback les plus utilisées.
- [ ] **P0-0.7** Ajouter tests Jest de contrat sur les commandes routing critiques.
- [ ] **P0-0.8** Documenter la checklist de refactor (no behavior change, payload stable, logs stables) dans `docs/refactor/CHECKLIST.md`.

### Phase 1 — Stabilisation Playback + MIDI adaptation

- [ ] **P0-1.1** Découper `src/api/commands/PlaybackCommands.js` (≈1124 LOC) — extraire sous-module *playback control* (start/stop/seek/loop).
- [ ] **P0-1.2** Découper `PlaybackCommands.js` — extraire sous-module *analysis/suggestions*.
- [ ] **P0-1.3** Découper `PlaybackCommands.js` — extraire sous-module *assignment apply*.
- [ ] **P0-1.4** Découper `PlaybackCommands.js` — extraire sous-module *routing validation*.
- [ ] **P0-1.5** Produire `ADR-002-repository-layer.md` avant Phase 2.
- [ ] **P0-1.6** Extraire `MidiAdaptationService` regroupant les interfaces de `TablatureConverter`, `DrumNoteMapper`, `ChannelSplitter`, `InstrumentMatcher`, `Transposer`.
- [ ] **P0-1.7** Déplacer la logique métier Playback vers `src/midi/domain/playback/`.
- [ ] **P0-1.8** Vérifier réduction de taille `PlaybackCommands.js` > 40 %.

### Phase 2 — Persistance (consolidation Repositories)

- [ ] **P0-2.1** Introduire `FileRepository` au-dessus de `MidiDatabase`.
- [ ] **P0-2.2** Introduire `RoutingRepository` au-dessus de `RoutingPersistenceDB` + `MidiRouter`.
- [ ] **P0-2.3** Introduire `InstrumentRepository` au-dessus de `InstrumentDatabase` + `InstrumentSettingsDB`.
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

---

## Remarques / décisions

- **2026-04-17** — Décision : conserver le layout réel (`src/midi/`, `src/storage/`, etc.) plutôt que bouger vers `src/domain/`+`src/infra/`. Cf. `REFACTORING_PLAN.md` §5.
- **2026-04-17** — Décision : consolider les sub-DBs existantes en Repositories, **ne pas** introduire une couche neuve parallèle.
- **2026-04-17** — Freeze SQL actif : aucune nouvelle migration tant que Phase 4 n'est pas terminée (sauf exception ADR).

---

## Blocages actifs

Aucun.

---

## Métriques de suivi (à mettre à jour à chaque fin de phase)

| Métrique | Baseline | Cible | Actuel |
|---|---|---|---|
| `PlaybackCommands.js` LOC | 1124 | < 675 (-40 %) | 1124 |
| `MidiPlayer.js` LOC | 1312 | < 790 (-40 %) | 1312 |
| `InstrumentMatcher.js` LOC | 1178 | < 710 (-40 %) | 1178 |
| `TablatureConverter.js` LOC | 1250 | < 750 (-40 %) | 1250 |
| `RoutingSummaryPage.js` LOC | 4748 | < 2850 (-40 %) | 4748 |
| Couverture tests P0/P1 | ~20 % | ≥ 35 % | ~20 % |
| Commandes WS critiques sous contrat | 0 % | ≥ 90 % | 0 % |
| PR refactor sans incident (14 j) | — | ≥ 95 % | — |
