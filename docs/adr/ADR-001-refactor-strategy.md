# ADR-001 — Stratégie de refactorisation : hybride V2→V3 avec ports/adapters ciblés

- **Statut** : Accepté
- **Date** : 2026-04-17
- **Références** :
  [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md)

## Contexte

Ma-est-tro est en production et fonctionne, mais plusieurs modules sont
devenus des « god files » qui mélangent transport API, orchestration métier,
adaptation MIDI et persistance :

- `src/api/commands/PlaybackCommands.js` (~1124 LOC, 23 handlers)
- `src/midi/playback/MidiPlayer.js` (~1312 LOC, scheduling + routing + modes)
- cluster d'adaptation MIDI (`TablatureConverter` 1250 LOC,
  `InstrumentMatcher` 1178 LOC, `DrumNoteMapper` 947 LOC,
  `ChannelSplitter` 871 LOC)
- `src/storage/Database.js` (~1009 LOC, 40 migrations)

Côté frontend : `RoutingSummaryPage.js` (~4748 LOC), famille MIDI editor en
mixins.

Infrastructure déjà en place à **réutiliser** : ServiceContainer, EventBus,
Logger, hiérarchie d'erreurs typée, JsonValidator, sub-DBs par domaine.

Besoin : un chemin de refactorisation incrémental, livrable en lots courts,
qui :

1. réduit la dette sans bloquer la roadmap produit ;
2. ne casse aucun comportement observable (production en cours) ;
3. tire parti de l'infra existante plutôt que de la recréer ;
4. est réversible lot par lot.

## Options considérées

### Option A — Big-bang vers Clean Architecture (V4)

Réorganiser le repo en `src/domain/` + `src/infra/` + `src/application/`,
introduire ports/adapters partout, migrer tous les handlers, introduire
DTOs entre couches.

- **Avantages** : architecture cible claire, bénéfices à long terme maximaux.
- **Inconvénients** : PR géante, risque de régression très élevé,
  impossibilité de livrer en parallèle de la roadmap, coût de migration
  des tests, déplacement massif de fichiers qui tue l'historique Git.

### Option B — Stabilisation V2 uniquement (extractions ciblées)

Se contenter d'extraire les god files en sous-modules sans changer la
structure globale ni introduire de nouveaux patterns.

- **Avantages** : risque minimal, gain immédiat sur les fichiers critiques.
- **Inconvénients** : ne résout pas le couplage infra (`app.xxx` partout,
  accès direct DB depuis les handlers), laisse la logique métier fragmentée,
  ne prépare pas les évolutions produit (routing/adaptation).

### Option C — Découpage par capacités métier (V3)

Réorganiser par domaines métier (playback, routing, devices, files,
instruments) avec un découpage dédié `api → domain → infra`.

- **Avantages** : isole chaque domaine, testabilité forte, prépare
  l'évolution du produit.
- **Inconvénients** : réorganisation visible qui impose des déplacements
  de fichiers conséquents, nécessite d'avoir stabilisé les god files en
  amont pour savoir où couper.

### Option D — Hybride V2→V3 avec ports/adapters V4 ciblés (option retenue)

Appliquer la stabilisation V2 en premier (extractions, repositories au-dessus
des sub-DBs existantes, handlers fins), puis le découpage V3 par domaines
au fur et à mesure, et enfin les principes V4 (ports/adapters) uniquement
aux frontières les plus couplées à l'infra (drivers MIDI série/BLE,
LightingManager, NetworkManager, transport WS).

- **Avantages** : lots courts livrables indépendamment, coût étalé,
  dernière phase ciblée là où elle apporte vraiment de la valeur, compatible
  avec la production, réutilise ServiceContainer/EventBus/Logger existants.
- **Inconvénients** : demande une discipline forte sur le périmètre IN/OUT
  de chaque lot ; le refactor reste visible plusieurs mois dans le repo.

## Décision

**Option D retenue** : hybride V2→V3 avec ports/adapters V4 ciblés.

Applicable via les quatre phases du plan :

| Phase | Objet | Principe |
|---|---|---|
| Phase 0 | Baseline sécurité (contrats WS, checklist) | V2 |
| Phase 1 | Stabilisation Playback + cluster MIDI adaptation | V2 |
| Phase 2 | Repositories au-dessus des sub-DBs existantes | V2 (pas V3) |
| Phase 3 | Validation déclarative + erreurs normalisées | V2 |
| Phase 4 | Domaines étendus + ports/adapters ciblés | V3 + V4 ciblé |

Principes directeurs :

1. **Règle de dépendance** : `api → domain → infra`, jamais l'inverse.
2. **Pas d'accès direct DB** depuis `api/commands` après Phase 2.
3. **Handlers API fins** : validation → appel service → mapping réponse.
4. **Freeze du schéma SQL** pendant tout le chantier (§7 du plan).
5. **Réutilisation avant création** (§2 du plan).
6. **Un lot = une PR = 2–5 jours max**, comportement-neutre.
7. Tout écart fait l'objet d'un ADR supplémentaire (§13 du plan).

## Impacts et compromis

### Ce qu'on gagne

- Livraison incrémentale compatible avec la production.
- Réduction mesurable des god files (KPI : –40 % LOC sur les 4 modules P0).
- Testabilité accrue par l'isolement des services domaine.
- Filet de sécurité en place (snapshots de contrats WS) avant tout
  découpage risqué.
- Pattern Repository absorbe la persistance hétérogène (7 sub-DBs)
  sans nouvelle couche parallèle.

### Ce qu'on sacrifie

- Pas d'architecture cible « propre » immédiate : la transition reste
  visible plusieurs mois.
- Coexistence d'ancien et de nouveau pendant les phases 1–3 (double
  lecture : handlers direct vs. handlers via service).
- Chaque lot demande une vérification humaine du périmètre IN/OUT.

### Ce qui reste ouvert

- Décision précise sur le pattern Repository : à traiter dans ADR-002
  avant Phase 2.
- Règles de versionnement des contrats WS (compatibilité backward) :
  à traiter dans ADR-003 avant Phase 4.
- Choix des premiers drivers cibles pour ports/adapters : à décider en
  début de Phase 4.

## Plan de rollback

La stratégie elle-même étant appliquée lot par lot, le rollback est
naturellement granulaire :

- Tout lot peut être annulé par un `git revert <sha>` isolé — aucune
  migration SQL n'est introduite par le refactor (freeze §7).
- Les snapshots de contrats WS garantissent que chaque revert peut être
  validé par `npm test -- tests/contracts/`.
- Si la stratégie elle-même doit être remise en cause, il suffit de
  produire un nouvel ADR qui supersede celui-ci ; les lots déjà livrés
  restent valides car chacun laisse le code dans un état cohérent.

## Critères de réussite

- Les 4 god files backend P0 descendent sous ~600 LOC.
- Aucune commande WS critique ne régresse (snapshots verts).
- La couverture de tests sur les zones P0/P1 progresse de +15 points.
- Ajouter une feature playback/routing devient mesurablement plus
  rapide et moins risqué qu'avant le chantier.
