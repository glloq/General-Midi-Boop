# Routine d'agent : refactorisation pas-à-pas

> Prompt réutilisable pour faire avancer la refactorisation **un lot à la fois**.
> Copier-coller la section *Prompt* ci-dessous dans une nouvelle session
> Claude Code ouverte sur le repo `Ma-est-tro`.

## Principe

- **1 invocation = 1 lot** (2 à 5 jours de travail équivalents, souvent beaucoup moins).
- L'agent **lit** d'abord l'état du projet, **n'invente pas** le travail.
- Le lot est **comportement-neutre** (voir `docs/REFACTORING_PLAN.md` §10.1).
- L'agent **met à jour** `docs/refactor/PROGRESS.md` avant de committer.
- L'agent **s'arrête** après son lot — pas d'enchaînement automatique sauf demande explicite.

## Pré-requis côté humain

Avant de lancer la routine :

1. Être sur la branche de travail (`claude/review-refactoring-plan-AqlJO` ou une branche feature issue d'elle).
2. Arbre de travail propre (`git status` vide).
3. Lire `docs/refactor/PROGRESS.md` et, si besoin, **épingler manuellement** le prochain lot souhaité dans le champ « Prochain lot suggéré ».

## Prompt à copier-coller

```
Tu es un agent de refactorisation pour le projet Ma-est-tro.

AVANT TOUTE ACTION :

1. Lis `docs/REFACTORING_PLAN.md` (plan de fond, règles, KPI, ADR).
2. Lis `docs/refactor/PROGRESS.md` (état courant, todos, journal, blocages).
3. Identifie le lot à exécuter :
   - priorité 1 : champ « Prochain lot suggéré » de §État courant ;
   - priorité 2 : premier todo non coché, non bloqué, en suivant l'ordre
     Phase 0 → Phase 1 → Phase 2 → Phase 3 → Phase 4 → frontend P2 → observabilité P2 ;
   - si tout est bloqué ou vide : ARRÊTE-TOI et signale-le dans §Remarques.
4. Vérifie la Definition of Ready (REFACTORING_PLAN.md §10.2) :
   - contrats d'API du périmètre identifiés ;
   - cas nominaux + cas d'erreur listés ;
   - stratégie de test minimale connue.
   Si DoR pas rempli : produis d'abord le lot manquant (ex. snapshots de contrats) plutôt que le lot cible.

PENDANT L'EXÉCUTION :

5. Respecte IN/OUT (REFACTORING_PLAN.md §10.1) :
   - extraction / déplacement / renommage / factorisation / tests : OK ;
   - changement fonctionnel observable, migration SQL, dépendance npm nouvelle, pattern nouveau : INTERDIT sans ADR.
6. Respecte la hiérarchie de tests (§10.3) :
   - tests de contrat WS si tu touches une commande ;
   - tests de service domaine si tu extrais un service ;
   - tests d'intégration SQLite si tu touches la persistance.
7. Réutilise l'existant avant d'introduire du neuf :
   `src/core/errors/index.js`, `src/utils/JsonValidator.js`,
   `src/core/ServiceContainer.js`, `src/core/EventBus.js`,
   `src/core/Logger.js`, sub-DBs `src/storage/*`.
8. Si tu découvres un blocage (dépendance cachée, ambiguïté de contrat,
   test impossible sans changement fonctionnel) :
   - ne force pas ;
   - note-le dans §Blocages actifs de PROGRESS.md ;
   - propose une alternative plus petite ou un ADR à produire.

AVANT DE COMMITTER :

9. Lance les tests affectés (`npm test` ou scope ciblé) + lint si configuré.
10. Mets à jour `docs/refactor/PROGRESS.md` :
    - coche le/les todos terminés ([x]) ;
    - ajoute une ligne dans §Journal (date, agent, lot, résumé, fichiers, futur commit SHA → rempli après commit si besoin via amend **uniquement sur un commit non pushé**, sinon nouveau commit de suivi) ;
    - ajoute les nouveaux todos découverts ;
    - ajoute une note §Remarques si décision non triviale ;
    - mets à jour §État courant : dernier lot, prochain lot suggéré, date, agent ;
    - si la métrique (LOC, couverture) est mesurable, mets à jour §Métriques.
11. Produis un ADR si ta décision est structurante (§13 du plan).

COMMIT & PUSH :

12. Un seul commit pour le lot, message au format :
    `refactor(<zone>): <résumé bref du lot>  [P0-X.Y]`
    avec description détaillée incluant :
    - pourquoi (lien vers §Todos / §Remarques de PROGRESS.md) ;
    - liste IN (ce qui a changé) ;
    - mention explicite « comportement observable inchangé » ;
    - tests ajoutés / mis à jour.
13. Push sur la branche courante (`git push -u origin <branch>`).
14. **NE CRÉE PAS DE PULL REQUEST** sauf demande explicite de l'utilisateur.

ARRÊT :

15. Arrête-toi après ce seul lot. Résume à l'utilisateur (≤ 100 mots) :
    - lot fait ;
    - fichiers principaux touchés + commit SHA ;
    - prochain lot suggéré (tel que laissé dans PROGRESS.md) ;
    - blocages éventuels.

RÈGLES DURES :

- Ne modifie **jamais** le schéma SQL (`migrations/`) sans ADR validé.
- Ne touche **jamais** un fichier hors du périmètre du lot (même pour « nettoyer »).
- Ne saute **jamais** l'étape de mise à jour de PROGRESS.md.
- Si tu hésites entre deux découpages : choisis le plus petit et laisse l'autre en todo.
```

## Variantes utiles

### Cibler un lot précis

Ajouter en fin de prompt :

```
Lot à exécuter : P0-1.1 (extraire playback control de PlaybackCommands.js).
```

### Mode audit (sans modification de code)

Remplacer l'étape 5 par :

```
5. MODE AUDIT : ne modifie aucun fichier source. Produit uniquement :
   - un document `docs/refactor/audit-<zone>-<date>.md` analysant le périmètre ;
   - la mise à jour PROGRESS.md.
```

Utile pour préparer un lot complexe avant de l'exécuter.

### Mode suite (enchaîner 2-3 lots)

À utiliser avec précaution, uniquement si les lots enchaînés sont **indépendants** et **à faible risque** :

```
Exécute jusqu'à 3 lots successifs, chacun avec son propre commit, en respectant
toutes les règles ci-dessus. Arrête-toi à la première difficulté.
```

## Bonne pratique de revue

Après chaque lot :

- relire le commit (`git show HEAD`) ;
- vérifier que `docs/refactor/PROGRESS.md` reflète bien le travail fait ;
- vérifier qu'aucun fichier hors périmètre n'a été touché (`git diff --stat HEAD~1`) ;
- si tout est OK : ouvrir la PR manuellement (l'agent ne crée pas de PR).
