# ADR-002 — Pattern Repository au-dessus des sub-DBs existantes

- **Statut** : Accepté
- **Date** : 2026-04-17
- **Supersedes** : —
- **Références** :
  [`ADR-001`](./ADR-001-refactor-strategy.md),
  [`REFACTORING_PLAN.md`](../REFACTORING_PLAN.md) §5 Phase 2,
  [`dependency-matrix.md`](../refactor/dependency-matrix.md) §4

## Contexte

Après la Phase 1 (P0-1.1→P0-1.4), les handlers PlaybackCommands sont
découpés en 4 sous-modules. Cependant, chaque sous-module accède encore
directement à `app.database.*` (façade centrale, 1009 LOC, 40 migrations,
5 sub-databases).

Les problèmes :
1. **Couplage** : les handlers connaissent les noms de méthodes SQL
   (`insertRouting`, `getRoutingsByFile`, `updateFile`, `insertSplitRoutings`,
   etc.).
2. **Testabilité** : impossible de tester un handler sans mocker
   l'intégralité de `app.database`.
3. **Duplication** : la logique de « préserver les métadonnées d'un routing
   existant » est dupliquée entre `applyAssignments` et `fileRoutingSync`.

Le plan prévoit de consolider les sub-DBs existantes en Repositories
(Phase 2, P0-2.1→P0-2.6). La question est : **comment introduire la
couche Repository sans réécrire la couche persistance ?**

## Options considérées

### Option A — Repositories « from scratch » à côté des sub-DBs

Créer de nouvelles classes dans `src/repositories/` qui encapsulent
des appels SQL directs, indépendamment des sub-DBs existantes.

- **Avantages** : liberté de design, API publique propre dès le départ.
- **Inconvénients** : duplication massive avec les sub-DBs existantes,
  risque de divergence, effort 2× supérieur, viole le principe
  « réutilisation avant création » (plan §2).

### Option B — Repositories « wrappers » au-dessus des sub-DBs (retenue)

Créer des Repositories qui **délèguent** aux sub-DBs existantes
(`MidiDatabase`, `InstrumentDatabase`, etc.) en y ajoutant :
- une API métier nommée (ex. `fileRepository.findById(id)` au lieu de
  `database.getFile(id)`) ;
- la gestion des transactions/rollbacks pour les opérations composites ;
- le masquage des détails SQL (les handlers ne voient plus les noms de
  colonnes).

- **Avantages** : zéro réécriture SQL, réutilise 100 % des sub-DBs
  existantes, migration incrémentale (un handler à la fois),
  rollback trivial (supprimer le wrapper).
- **Inconvénients** : double indirection temporaire (handler →
  repository → sub-DB → SQLite), les sub-DBs restent techniquement
  accessibles via `app.database`.

### Option C — Refactorer les sub-DBs en Repositories in-place

Renommer et refactorer chaque sub-DB pour qu'elle devienne directement
un Repository (ex. `MidiDatabase` → `FileRepository`).

- **Avantages** : pas de double indirection.
- **Inconvénients** : renommage massif, casse tous les appelants d'un
  coup, risque de régression élevé, PR géante.

## Décision

**Option B retenue** : Repositories wrappers au-dessus des sub-DBs.

## Architecture cible

```
Handler (PlaybackAssignmentCommands.js)
  └──→ FileRepository
         └──→ MidiDatabase (sub-DB existante, inchangée)
               └──→ better-sqlite3

Handler (PlaybackRoutingCommands.js)
  └──→ RoutingRepository
         └──→ RoutingPersistenceDB + MidiRouter (existants)
               └──→ better-sqlite3

Handler (PlaybackAnalysisCommands.js)
  └──→ InstrumentRepository
         └──→ InstrumentDatabase + InstrumentSettingsDB (existants)
               └──→ better-sqlite3
```

### Repositories à introduire (Phase 2)

| Repository | Sub-DB(s) wrappées | Priorité |
|---|---|---|
| `FileRepository` | `MidiDatabase` | P0-2.1 |
| `RoutingRepository` | `RoutingPersistenceDB` + `MidiRouter` | P0-2.2 |
| `InstrumentRepository` | `InstrumentDatabase` + `InstrumentSettingsDB` | P0-2.3 |

### Conventions

1. Chaque Repository est une classe qui reçoit la sub-DB en constructeur
   (injection).
2. L'API publique utilise des noms métier (`findById`, `save`,
   `findByFileId`) — pas de SQL visible.
3. Les transactions composites (ex. « créer fichier adapté + persister
   routings ») sont dans le Repository, pas dans le handler.
4. Les Repositories sont enregistrés dans le `ServiceContainer` existant.
5. Les handlers migreront un par un : d'abord `app.database.xxx` remplacé
   par `app.fileRepository.xxx`, puis retrait de l'accès direct.

### Règles

- **Aucune** migration SQL (freeze, plan §7).
- **Aucune** nouvelle table ou colonne.
- Les sub-DBs existantes **ne changent pas** (pas de rename, pas de
  refactor interne).
- Seule la surface d'appel côté handlers change.

## Impacts

### Ce qu'on gagne

- Les handlers n'ont plus besoin de connaître les détails SQL.
- Les tests peuvent mocker un Repository (1 objet) au lieu de 15
  méthodes de `app.database`.
- La logique dupliquée (préservation métadonnées routing) peut être
  centralisée dans `RoutingRepository`.
- La voie est ouverte pour remplacer un jour les sub-DBs par une
  autre implémentation sans toucher aux handlers.

### Ce qu'on sacrifie

- Double indirection temporaire (accepté).
- Les sub-DBs restent accessibles via `app.database` pendant la
  migration (discipline nécessaire).

## Plan de rollback

Chaque Repository étant un wrapper, son retrait consiste à :
1. Rétablir les appels directs `app.database.*` dans les handlers.
2. Supprimer la classe Repository.
3. `git revert <sha>`.

Aucune donnée n'est modifiée, aucune migration à défaire.

## Critères de réussite (fin Phase 2)

- Plus aucun appel `app.database.*` depuis `src/api/commands/**`.
- Les 3 Repositories ont des tests d'intégration SQLite (split / no-split
  / overwrite).
- Les tests de contrat WS restent verts.
