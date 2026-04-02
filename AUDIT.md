# Audit de la Structure du Code — Ma-est-tro

## 1. Vue d'ensemble

**Projet** : Ma-est-tro (MidiMind) v5.0  
**Type** : Système d'orchestration MIDI pour Raspberry Pi  
**Stack** : Node.js (ES Modules), Express, WebSocket, SQLite (better-sqlite3), frontend vanilla JS  
**Taille** : ~28 500 lignes (backend `src/`), ~47 300 lignes (frontend `public/js/`)  

### Architecture actuelle
```
server.js                  # Point d'entrée
src/
  core/                    # Application, EventBus, Logger, ServiceContainer, Errors
  config/                  # Configuration (JSON + env overrides)
  api/                     # HttpServer, WebSocketServer, CommandHandler/Registry
    commands/              # 15 modules de commandes (auto-discovered)
  midi/                    # 16 modules MIDI (player, router, devices, analyse...)
  lighting/                # 10 drivers d'éclairage + moteur d'effets
  managers/                # Bluetooth, Serial, Network, Lighting, RTP
  storage/                 # Database facade, 4 sous-modules DB, FileManager, BackupScheduler
  audio/                   # DelayCalibrator
  utils/                   # MidiUtils, JsonValidator, CustomMidiParser
  types/                   # index.ts (types TypeScript)
public/
  js/                      # Frontend SPA vanilla JS
    core/                  # BaseCanvasEditor, EventBus (frontend)
    api/                   # Client WebSocket
    audio/                 # Synthétiseur MIDI
    i18n/                  # Internationalisation
    views/components/      # ~30 composants UI
  locales/                 # 24 fichiers de traduction
  styles/                  # CSS
tests/                     # ~10 tests unitaires + benchmarks
```

---

## 2. Points Positifs

1. **Architecture modulaire par domaine** : Bonne séparation en domaines métier (`midi/`, `lighting/`, `storage/`, `api/`).

2. **ServiceContainer (DI)** : Le conteneur de DI est en place avec détection de dépendances circulaires. C'est une bonne fondation.

3. **Command Pattern** : Le `CommandRegistry` avec auto-discovery des modules dans `commands/` est élégant et extensible.

4. **Hiérarchie d'erreurs** : `ApplicationError` et ses sous-classes (`ValidationError`, `NotFoundError`, `MidiError`...) avec codes et `toJSON()`.

5. **Configuration robuste** : Validation par type/plage, overrides par variables d'environnement, fichier `.env`.

6. **Drivers lighting pluggables** : Pattern de mapping `type → module` avec chargement dynamique.

7. **Outils de qualité** : ESLint, Prettier, Husky, lint-staged, TypeScript (typecheck), tests Jest + Vitest.

---

## 3. Problemes Identifies et Evolutions Proposees

### 3.1. CRITIQUE — God Object `Application` + couplage `this.app`

**Probleme** : Chaque service reçoit `this` (l'instance `Application`) en constructeur et accède à tous les autres services via `this.app.xxx`. Le `ServiceContainer` existe mais n'est pas réellement utilisé — les services ne déclarent pas leurs dépendances.

```js
// Actuel — CHAQUE service fait ça :
class MidiRouter {
  constructor(app) {
    this.app = app; // accès à TOUT
    // Utilise: app.database, app.logger, app.eventBus, app.deviceManager...
  }
}
```

**Impact** : Impossible de tester un service en isolation, couplage implicite total, le ServiceContainer est rendu inutile.

**Evolution proposee** :
```js
// Cible — injection explicite des dépendances :
class MidiRouter {
  constructor({ logger, eventBus, database, deviceManager }) {
    this.logger = logger;
    this.eventBus = eventBus;
    this.database = database;
    this.deviceManager = deviceManager;
  }
}

// Dans Application.initialize() :
container.factory('midiRouter', (c) => new MidiRouter(
  c.inject('logger', 'eventBus', 'database', 'deviceManager')
));
```

**Migration** : Procéder service par service, en commençant par les feuilles de l'arbre de dépendances (Logger, EventBus, Config) puis en remontant. Le `_createAppFacade()` proxy peut servir de pont pendant la transition.

---

### 3.2. CRITIQUE — Database God Class (961 lignes, ~100 méthodes)

**Probleme** : `Database.js` est une facade monolithique qui délègue à 4 sous-modules (`MidiDatabase`, `InstrumentDatabase`, `LightingDatabase`, `StringInstrumentDatabase`) via ~80 méthodes wrapper passthrough du type :

```js
insertFile(file) { return this.midiDB.insertFile(file); }
getFile(fileId) { return this.midiDB.getFile(fileId); }
// ... x80
```

**Impact** : Chaque nouvelle fonctionnalité DB nécessite d'ajouter un wrapper. Le fichier grossit indéfiniment. Les consommateurs n'ont aucune idée de quelle sous-DB ils utilisent.

**Evolution proposee** :
- Enregistrer chaque sous-module directement dans le `ServiceContainer` :
  ```js
  container.register('midiDB', new MidiDatabase(db, logger));
  container.register('instrumentDB', new InstrumentDatabase(db, logger));
  container.register('lightingDB', new LightingDatabase(db, logger));
  ```
- Les services consomment directement le sous-module dont ils ont besoin.
- Supprimer la facade `DatabaseManager` quand la migration est complète.
- Garder un module `DatabaseLifecycle` pour les migrations, backup, vacuum.

---

### 3.3. MAJEUR — Frontend sans framework ni bundling structuré

**Probleme** : ~47 000 lignes de JS vanilla dans `public/js/`, avec des composants de 900-1300 lignes, pas de système de modules (pas d'import/export natif dans le navigateur sans Vite en dev), pas de state management.

**Impact** : Difficile à maintenir, pas de tree-shaking, composants monolithiques, duplication probable de logique.

**Evolution proposee** :
- **Court terme** : Utiliser Vite (déjà configuré) pour builder le frontend avec ES modules natifs. Structurer en modules importables.
- **Moyen terme** : Migrer vers un framework léger (Preact, Lit, ou même Web Components natifs) pour les composants les plus complexes (>500 lignes).
- **Découper les gros composants** : `MidiEditorCCPicker.js` (1317 l.), `MidiEditorCCPanel.js` (1301 l.), `InstrumentManagementPage.js` (1021 l.) devraient être découpés en sous-composants de <300 lignes.

---

### 3.4. MAJEUR — Couverture de tests très faible

**Probleme** : Seulement ~10 fichiers de test pour ~75 fichiers source backend. Les tests couvrent uniquement le core (EventBus, Logger, Config, ServiceContainer, errors, dbHelpers) et quelques aspects MIDI. Aucun test pour :
- Les commandes API (15 fichiers)
- Les managers (Bluetooth, Serial, Network, Lighting)
- Le MidiPlayer, MidiRouter, DeviceManager
- Les drivers lighting
- Le frontend

**Evolution proposee** :
- **Priorité 1** : Tests d'intégration pour le `CommandRegistry` + commandes (mock du WebSocket).
- **Priorité 2** : Tests unitaires pour `MidiPlayer`, `MidiRouter`, `AutoAssigner`.
- **Priorité 3** : Tests frontend via Vitest (déjà configuré).
- Ajouter un seuil de couverture dans le CI (commencer à 30%, viser 60%).

---

### 3.5. MAJEUR — Fichiers source trop volumineux

**Fichiers >700 lignes (backend)** :
| Fichier | Lignes | Suggestion |
|---|---|---|
| `InstrumentDatabase.js` | 1406 | Séparer en `InstrumentCRUD`, `InstrumentCapabilities`, `InstrumentSettings` |
| `InstrumentMatcher.js` | 1039 | Extraire les stratégies de matching en modules séparés |
| `FileManager.js` | 1030 | Séparer upload/download, parsing, analyse en modules |
| `LightingManager.js` | 998 | Séparer rule engine, driver management, effects |
| `MidiPlayer.js` | 954 | Le scheduler est déjà extrait — extraire aussi queue/playlist management |
| `TablatureConverter.js` | 932 | Séparer par type d'instrument (guitare, basse, ukulélé...) |
| `MidiDatabase.js` | 876 | Séparer queries CRUD des queries analytiques |
| `DeviceCommands.js` | 859 | Séparer MIDI devices, virtual instruments, capabilities |
| `DrumNoteMapper.js` | 810 | Extraire les tables de mapping en données JSON |
| `PlaybackCommands.js` | 763 | Séparer playback, queue, playlist commands |

---

### 3.6. MOYEN — Pas d'interface/contrat pour les drivers

**Probleme** : Les drivers d'éclairage (`GpioLedDriver`, `ArtNetDriver`, `SacnDriver`...) et `BaseLightingDriver` n'ont pas de contrat explicite. On fait confiance à la convention.

**Evolution proposee** :
- `BaseLightingDriver` devrait lever des erreurs pour les méthodes non implémentées (pattern Template Method).
- Ajouter une validation au chargement du driver dans `LightingManager`.
- Documenter le contrat avec JSDoc ou une interface TypeScript dans `types/`.

---

### 3.7. MOYEN — Gestion des erreurs incohérente dans CommandRegistry

**Probleme** : Le `CommandRegistry.handle()` filtre les erreurs via des heuristiques sur le message (`.includes('not found')`, `.startsWith('Invalid ')`) au lieu d'utiliser la hiérarchie d'erreurs existante.

```js
// Actuel
const isKnownError = (
  error.message.startsWith('Invalid ') ||
  error.message.includes('not found') || ...
);
```

**Evolution proposee** :
```js
// Cible — utiliser la hiérarchie d'erreurs :
const isKnownError = error instanceof ApplicationError;
```
Les commandes doivent lever des `ValidationError`, `NotFoundError`, etc. au lieu de `new Error(...)`.

---

### 3.8. MOYEN — Le ServiceContainer est sous-utilisé

**Probleme** : Le container a des fonctionnalités `factory()`, `inject()`, `unregister()` qui ne sont jamais utilisées. Tout est enregistré via `register()` avec des instances pré-construites. Le pattern factory permettrait le lazy loading et la résolution de dépendances.

**Evolution proposee** : Migrer vers des factories au lieu de `register()` direct :
```js
container.factory('midiRouter', (c) => new MidiRouter(
  c.inject('logger', 'eventBus', 'database', 'deviceManager')
));
```
Cela va de pair avec la résolution du problème 3.1.

---

### 3.9. MOYEN — Pas de séparation HTTP routes / controllers

**Probleme** : `HttpServer.js` mélange configuration Express (middleware, CORS, auth, static files) et logique métier (health check, status, metrics). Si l'API REST grandit, ce fichier deviendra ingérable.

**Evolution proposee** :
- Extraire les routes API dans un fichier `src/api/routes.js` ou un dossier `src/api/routes/`.
- `HttpServer` ne garde que le setup Express et le montage des routes.
- Les endpoints REST (health, status, metrics) deviennent des handlers séparés.

---

### 3.10. MINEUR — Mélange TypeScript / JavaScript

**Probleme** : Le projet a un `tsconfig.json`, des types dans `src/types/index.ts`, et `tsc --noEmit` dans les scripts — mais tout le code est en `.js`. Les bénéfices du TypeScript ne sont pas exploités.

**Evolution proposee** :
- **Option A** : Migrer progressivement vers TypeScript (renommer `.js` → `.ts`, en commençant par `core/` et `types/`).
- **Option B** : Rester en JS mais utiliser JSDoc + `@ts-check` pour le typage graduel (moins intrusif).

---

### 3.11. MINEUR — `countFilesWithoutChannels` manquant dans Database facade

**Probleme** : `Application.start()` appelle `this.database.countFilesWithoutChannels()` mais cette méthode n'est pas visible dans la facade `Database.js`. Elle est probablement dans `MidiDatabase` mais n'a pas de wrapper — preuve que le pattern facade s'effrite.

---

### 3.12. MINEUR — lint-staged avec seuil de warnings élevé

**Probleme** : `"eslint --max-warnings 200"` dans lint-staged autorise 200 warnings. Cela indique une dette technique ESLint significative.

**Evolution proposee** : Réduire progressivement le seuil (200 → 100 → 50 → 0) en fixant les warnings par lot.

---

## 4. Plan d'Action Recommandé

### Phase 1 — Fondations (rapide, faible risque)
1. Utiliser la hiérarchie d'erreurs dans `CommandRegistry` et les commandes
2. Extraire les routes HTTP dans un module séparé
3. Réduire le seuil ESLint progressivement
4. Ajouter des tests pour les commandes API les plus critiques

### Phase 2 — Injection de dépendances (moyen terme)
5. Migrer les services "feuilles" (Logger, EventBus) pour ne plus dépendre de `app`
6. Migrer les services de stockage (utiliser les sous-DB directement)
7. Migrer le MidiPlayer et MidiRouter vers l'injection explicite
8. Supprimer progressivement la facade `Database`

### Phase 3 — Découpage (effort soutenu)
9. Découper les fichiers >700 lignes (voir tableau 3.5)
10. Définir les contrats/interfaces pour les drivers
11. Structurer le frontend avec Vite + ES modules

### Phase 4 — Qualité à long terme
12. Atteindre 50%+ de couverture de tests
13. Évaluer la migration TypeScript
14. Envisager un framework frontend léger pour les composants complexes

---

## 5. Métriques Clés

| Métrique | Actuel | Cible Phase 1 | Cible Phase 4 |
|---|---|---|---|
| Couverture tests backend | ~10% | 30% | 60% |
| ESLint warnings max | 200 | 100 | 0 |
| Fichiers >700 lignes | 10 | 10 | 3 |
| Services avec DI explicite | 0/~15 | 5/15 | 15/15 |
| Fichiers test / fichiers source | 10/75 | 25/75 | 50/75 |
