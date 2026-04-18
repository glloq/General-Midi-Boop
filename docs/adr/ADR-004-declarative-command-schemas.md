# ADR-004 — Schémas déclaratifs pour la validation de commandes WS

- **Statut** : Accepté
- **Date** : 2026-04-17
- **Supersedes** : —
- **Références** :
  [`ADR-001`](./ADR-001-refactor-strategy.md),
  [`src/utils/JsonValidator.js`](../../src/utils/JsonValidator.js)

## Contexte

À l'entrée de la Phase 3, les 146+ commandes WebSocket sont validées à deux
endroits :

1. **`JsonValidator`** (`src/utils/JsonValidator.js`, 447 LOC, 33 `case` dans
   un `switch` géant) qui, via les méthodes `validateDeviceCommand`,
   `validateRoutingCommand`, `validatePlaybackCommand`, etc., produit un
   préambule d'erreurs avant que la commande n'atteigne son handler.
2. **Chaque handler** qui re-fait sa propre validation (duplications visibles :
   `if (!data.fileId) throw new ValidationError('fileId is required', ...)`,
   plus d'une centaine de `throw new ValidationError` dans
   `src/api/commands/**`).

Les problèmes :

1. **Duplication** : la même règle (« fileId requis ») est écrite dans
   `JsonValidator` **et** dans le handler.
2. **Dérive** : quand un handler change ses contraintes (ex. nouveau champ
   requis), l'une des deux versions est souvent oubliée.
3. **Incohérence de messages** : `JsonValidator` préfixe ses erreurs avec
   `Invalid <cmd> data: …` (documenté dans la §Remarques de PROGRESS du
   lot P0-0.6), le handler les émet brutes. Le client reçoit donc deux
   formats selon qui bloque.
4. **Testabilité** : il n'existe aucune source de vérité indexable — on
   ne peut pas facilement générer la documentation, le type côté front,
   ni un fuzzer.

Le plan §5 Phase 3 demande : « Étendre `JsonValidator` vers des **schémas
déclaratifs** par commande ; suppression des validations ad hoc dans les
handlers. »

## Options considérées

### Option A — Réécrire autour d'une dépendance externe (Ajv / Zod)

Introduire `ajv` ou `zod` comme dépendance, décrire chaque commande comme
un schéma JSON/TypeScript, laisser la lib faire la validation.

- **Avantages** : standard de l'industrie, riches (oneOf, patterns,
  conditional), generation de types côté front possible.
- **Inconvénients** :
  - **Nouvelle dépendance npm** → INTERDIT par le plan §10.1 sans ADR
    (précisément celui-ci). Ajv ajoute ~150 KB au bundle et impose un
    compilateur de schémas à l'exécution.
  - Rupture partielle des contrats : les messages d'erreur produits par
    Ajv ne correspondent pas aux snapshots actuels
    (`tests/contracts/fixtures/**`).
  - Migration big-bang des 146 commandes.

### Option B — Schémas déclaratifs maison, compilateur minimaliste (retenue)

Ajouter à `JsonValidator` un **compilateur de schémas interne** capable
de prendre en entrée un objet descriptif par commande et produire le
tableau d'erreurs de format identique à aujourd'hui.

Exemple cible :

```js
// src/api/commands/schemas/playback.schemas.js
export const playback_start = {
  fields: {
    fileId:        { type: 'id',     required: true },
    outputDevice:  { type: 'string', required: false }
  },
  custom: (data) => {
    // Règle cross-champ : au moins fileId OU outputDevice
    if (!data.fileId && !data.outputDevice) {
      return 'fileId or outputDevice is required';
    }
    return null;
  }
};
```

À l'enregistrement (`CommandRegistry.register`), le schéma est compilé
une fois en fonction `(data) => errors[]`. Les handlers deviennent
**strictement** : "validation → service → réponse" sans appels
`throw new ValidationError` redondants.

- **Avantages** :
  - **Aucune dépendance npm** (respect §10.1).
  - Format identique des messages d'erreur côté client
    (snapshots `tests/contracts/fixtures/**` inchangés).
  - Migration **incrémentale** : commande par commande, les handlers
    non migrés continuent à utiliser leur validation inline.
  - Indexable : `JsonValidator.describe()` peut retourner tous les
    schémas pour la génération de docs / types.
  - Testable en isolation (un test par schéma, validateur mockable).
- **Inconvénients** :
  - ~200 LOC de compilateur à écrire et maintenir.
  - Features volontairement limitées (pas de `oneOf` arbitraire, pas
    de `$ref` récursif) — c'est un trade-off accepté.

### Option C — Typage statique progressif (TypeScript / JSDoc `@typedef`)

Définir des types TS/JSDoc par commande, laisser l'IDE attraper les
erreurs à l'écriture.

- **Avantages** : zéro coût runtime.
- **Inconvénients** : ne protège pas des messages WS mal formés en
  production (les valeurs viennent du navigateur). Non suffisant seul.

## Décision

**Option B retenue** : compilateur de schémas déclaratifs maison au sein
de `JsonValidator`.

## Format de schéma retenu

Chaque commande est décrite par un objet :

```js
{
  // Validation par champ (optionnelle, mais la plupart l'auront)
  fields: {
    <name>: {
      type: 'id' | 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array',
      required: boolean,          // default false
      min?: number,               // pour number / integer
      max?: number,
      minLength?: number,         // pour string
      maxLength?: number,
      enum?: Array<unknown>       // si défini, la valeur doit en faire partie
    }
  },

  // Validation cross-champ (optionnelle).
  // Retourne le message d'erreur (string) ou null si OK.
  custom?: (data) => string | null | string[]
}
```

### Types supportés

- `id` : accepte number entier positif **ou** string non vide
  (compatibilité avec la réalité : certains fileIds sont strings).
- `string` : `typeof === 'string'`.
- `number` : `typeof === 'number' && !isNaN`.
- `integer` : number entier.
- `boolean` : `typeof === 'boolean'`.
- `object` : objet non null, non array.
- `array` : `Array.isArray`.

### Comportement d'erreur

Pour rester compatible avec les snapshots de contrats existants :

- Champ requis manquant : `"${field} is required"`.
- Mauvais type : `"${field} must be <type>"`.
- Hors intervalle : `"${field} must be between ${min} and ${max}"`.
- Violation enum : `"${field} must be one of: <liste>"`.
- Résultat `custom()` : message tel quel.

`JsonValidator` continue de préfixer globalement par
`"Invalid <command> data: "` et de joindre les messages par `; ` quand
un schéma produit plusieurs erreurs (comportement prouvé par les
snapshots corrigés en P0-0.6).

## Architecture cible

```
src/
  api/
    commands/
      schemas/                      # NEW — 1 fichier par domaine
        playback.schemas.js
        routing.schemas.js
        file.schemas.js
        instrument.schemas.js
        session.schemas.js
        playlist.schemas.js
        lighting.schemas.js
        stringInstrument.schemas.js
        ...
      PlaybackCommands.js           # allégé : plus de validation inline
      ...
    CommandRegistry.js              # lit le schéma avant dispatch
  utils/
    JsonValidator.js                # compilateur + helpers
    SchemaCompiler.js               # NEW — sépare la logique de compilation (~100 LOC)
```

## Plan de migration (lots Phase 3)

1. **P1-3.1** (ce présent ADR) — Décision et format. Pas de code
   produit.
2. **P1-3.1b** — Implémentation du compilateur dans
   `src/utils/SchemaCompiler.js` et intégration dans `JsonValidator`
   via une méthode `JsonValidator.validateBySchema(schema, data)`.
   Tests unitaires isolés (~15 tests pour les cas nominaux + edges).
3. **P1-3.2a** — Migration des schémas playback (domaine le mieux
   couvert par des snapshots → risque de régression minimal).
   Suppression des validations inline redondantes dans les 4
   sous-modules `src/api/commands/playback/**`.
4. **P1-3.2b** — Migration des schémas routing.
5. **P1-3.2c** — Migration des autres domaines (file, instrument,
   session, playlist, lighting, stringInstrument, device, devices
   settings, preset, virtual instrument).
6. **P1-3.3** — (**déjà fait implicitement** : aucun
   `throw new Error` brut dans `src/api/commands/**` à l'issue de
   Phase 2. Clôture du todo.)
7. **P1-3.4** — Audit de cohérence des payloads d'erreur côté client
   (re-jeu manuel des snapshots + vérification de la lib frontend
   `BackendAPIClient`).

## Règles dures

- **Aucune** nouvelle dépendance npm (respect §10.1).
- **Aucun** changement de schéma SQL.
- **Aucun** changement de format de message WS côté client :
  les snapshots `tests/contracts/fixtures/**` doivent rester verts à
  chaque PR Phase 3.
- La migration est **incrémentale** : `JsonValidator` supporte
  simultanément l'ancien `switch` et le nouveau format schéma
  pendant toute la durée de la Phase 3.

## Impacts

### Ce qu'on gagne

- Une source de vérité par commande (le schéma, au même endroit que
  son handler).
- Messages d'erreur stables (les snapshots restent le gardien).
- Tests de validation isolés du reste de la chaîne (mock-free).
- Préparation naturelle de la génération de docs `docs/WS_CONTRACT.md`
  et de types JSDoc côté front.

### Ce qu'on sacrifie

- ~200 LOC de compilateur à maintenir (au lieu d'une dépendance).
- Features volontairement limitées : pas de `oneOf`, pas de `$ref`,
  pas de références circulaires (hors scope).
- Les handlers restent responsables des **vérifications métier**
  qui dépendent de l'état DB (ex. `file.id existe`) — le schéma ne
  couvre que la forme du payload.

## Plan de rollback

1. Si un schéma introduit une régression détectée par les snapshots :
   supprimer le fichier `xxx.schemas.js`, `git revert` le lot
   correspondant, les handlers retrouvent leur validation inline.
2. Si le compilateur lui-même est défectueux : `git revert` le lot
   P1-3.1b. Aucune donnée n'est touchée ; aucun contrat WS ne change.

## Critères de réussite (fin Phase 3)

- 100 % des commandes playback et routing ont un schéma déclaratif.
- 0 validation inline redondante dans les handlers migrés.
- 0 échec des snapshots de contrat WS.
- Les 33 `case` du `switch` historique de `JsonValidator` sont
  remplacés par des appels `validateBySchema`.
- Gain LOC mesurable sur `src/api/commands/**` (estimé -5 % minimum
  sur le cumulé des handlers).
