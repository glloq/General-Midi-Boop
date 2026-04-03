# Audit de la Structure du Code — Ma-est-tro

> Derniere mise a jour : 3 avril 2026

## 1. Vue d'ensemble

**Projet** : Ma-est-tro (MidiMind) v5.0
**Type** : Systeme d'orchestration MIDI pour Raspberry Pi
**Stack** : Node.js 20+ (ES Modules), Express 4, WebSocket, SQLite (better-sqlite3), frontend vanilla JS
**Taille** : ~24 400 lignes (backend `src/`), ~47 300 lignes (frontend `public/js/`), ~3 700 lignes de tests

### Architecture actuelle
```
server.js                  # Point d'entree
src/
  core/                    # Application, EventBus, Logger, ServiceContainer, Errors
  config/                  # Configuration (JSON + env overrides)
  api/                     # HttpServer, WebSocketServer, CommandHandler/Registry
    commands/              # 17 modules de commandes (auto-discovered)
  midi/                    # 18 modules MIDI (player, router, devices, analyse, transposition...)
  lighting/                # 11 drivers d'eclairage + moteur d'effets
  managers/                # Bluetooth, Serial, Network, Lighting, RTP
  storage/                 # Database facade, 6 sous-modules DB, FileManager, BackupScheduler
  audio/                   # DelayCalibrator
  utils/                   # MidiUtils, JsonValidator
  types/                   # index.ts (types TypeScript, documentation seulement)
  constants.js             # Constantes centralisees
public/
  js/                      # Frontend SPA vanilla JS (~85 fichiers)
    core/                  # BaseCanvasEditor, BaseController, BaseView, BaseModal, EventBus
    api/                   # BackendAPIClient (WebSocket)
    audio/                 # Synthetiseur MIDI
    i18n/                  # Internationalisation (28 langues)
    utils/                 # FilterManager, MidiConstants, escapeHtml, a11y
    views/components/      # ~30 composants UI (editeurs MIDI, modales, pages)
  locales/                 # 28 fichiers de traduction JSON
  styles/                  # CSS
tests/                     # 13 fichiers de tests (Jest backend + Vitest frontend) + benchmarks
migrations/                # 34 fichiers SQL de migration
docs/                      # 10 fichiers de documentation
scripts/                   # Scripts d'installation et utilitaires
```

---

## 2. Points Positifs

1. **Architecture modulaire par domaine** : Bonne separation en domaines metier (`midi/`, `lighting/`, `storage/`, `api/`, `managers/`).

2. **ServiceContainer (DI)** : Le conteneur de DI est en place avec detection de dependances circulaires. Certains services (`MidiRouter`, `WebSocketServer`, `Database`) utilisent deja l'injection par `deps`.

3. **Command Pattern** : Le `CommandRegistry` avec auto-discovery des modules dans `commands/` est elegant et extensible. 17 modules de commandes, 146+ commandes API.

4. **Hierarchie d'erreurs** : `ApplicationError` et ses sous-classes (`ValidationError`, `NotFoundError`, `MidiError`, `DatabaseError`, `ConfigurationError`, `AuthenticationError`) avec codes HTTP et `toJSON()`.

5. **Error handling dans CommandRegistry** : Utilise correctement `instanceof ApplicationError` pour distinguer les erreurs metier des erreurs internes — les messages internes ne sont pas exposes au client.

6. **Configuration robuste** : Validation par type/plage, overrides par variables d'environnement (`MAESTRO_*`), fichier `.env`.

7. **Drivers lighting pluggables** : `BaseLightingDriver` avec pattern Template Method et validation au chargement.

8. **Securite** :
   - Helmet.js active (headers HTTP)
   - Auth par token avec comparaison timing-safe
   - `escapeHtml()` utilise systematiquement dans `InstrumentManagementPage.js`
   - Docker en non-root (`appuser`)
   - Rate limiting WebSocket (60 msg/sec)
   - Input validation avec whitelist dans `dbHelpers.js`

9. **Outils de qualite** : ESLint, Prettier, Husky + lint-staged, TypeScript (typecheck), tests Jest + Vitest, CI/CD GitHub Actions.

10. **Constantes centralisees** : `src/constants.js` fournit une source unique pour les constantes MIDI, timing, calibration, limites, et evenements.

11. **Drum note analysis** : `classifyDrumNotes()` filtre correctement les `noteOn` uniquement (evite le double-comptage).

12. **Note range extraction** : `ChannelAnalyzer.extractNoteRange()` utilise `??` (nullish coalescing) pour gerer correctement la note MIDI 0.

---

## 3. Problemes Identifies et Corrections

### 3.1. CRITIQUE — God Object `Application` + couplage `this.app`

**Probleme** : La majorite des services recoivent `this` (l'instance `Application`) en constructeur et accedent a tous les autres services via `this.app.xxx`. Le `ServiceContainer` existe mais n'est pas pleinement exploite.

**Etat** : Migration en cours — certains services (`MidiRouter`, `WebSocketServer`, `DatabaseManager`) utilisent deja l'injection par `deps`. D'autres (`MidiPlayer`, `FileManager`, `LightingManager`) utilisent encore `this.app`.

```js
// Ancien pattern (encore present dans ~10 services) :
class MidiPlayer {
  constructor(app) {
    this.app = app; // acces a TOUT
  }
}

// Nouveau pattern (deja en place dans ~5 services) :
class MidiRouter {
  constructor(deps) {
    this.logger = deps.logger;
    this.database = deps.database;
    this.eventBus = deps.eventBus;
  }
}
```

**Impact** : Couplage implicite, difficulte a tester en isolation, ServiceContainer sous-utilise.

**Migration** : Proceder service par service en commencant par les feuilles de l'arbre de dependances. Le `_createAppFacade()` proxy peut servir de pont pendant la transition.

---

### 3.2. CRITIQUE — Database God Class (~960 lignes, ~100 methodes wrapper)

**Probleme** : `Database.js` est une facade monolithique qui delegue a 6 sous-modules via ~90 methodes passthrough :

```js
insertFile(file) { return this.midiDB.insertFile(file); }
getFile(fileId) { return this.midiDB.getFile(fileId); }
// ... x90
```

**Impact** : Chaque nouvelle fonctionnalite DB necessite un wrapper. Le fichier grossit indefiniment.

**Etat** : Il manque actuellement `countFilesWithoutChannels()` dans la facade — methode appelee par `Application.start()` mais non exposee.

**Evolution** : Enregistrer chaque sous-module directement dans le `ServiceContainer` et supprimer progressivement la facade.

---

### 3.3. CORRIGE — Bug Note 0 dans MidiTransposer.js

**Probleme** : `MidiTransposer.js` utilise `||` au lieu de `??` pour extraire le numero de note :
```js
// AVANT (bug) :
const originalNote = event.note || event.noteNumber; // note 0 traitee comme falsy

// APRES (corrige) :
const originalNote = event.note ?? event.noteNumber;
```

**Fichiers corriges** :
- `src/midi/MidiTransposer.js` (lignes 57, 107)
- `public/js/audio/AudioPreview.js` (ligne 215)

---

### 3.4. CORRIGE — Constantes MIDI dupliquees dans MidiUtils.js

**Probleme** : `MidiUtils.MessageTypes` et `MidiUtils.CC` redefinissaient les memes valeurs que `MIDI_STATUS` et `MIDI_CC` dans `src/constants.js`.

**Correction** : `MidiUtils.js` importe maintenant depuis `constants.js` et re-exporte en alias pour compatibilite.

---

### 3.5. CORRIGE — Magic numbers dans WebSocketServer et MidiRouter

**Probleme** : `WebSocketServer.js` et `MidiRouter.js` definissaient des constantes locales dupliquant celles de `TIMING` dans `constants.js`.

**Correction** : Import de `TIMING` depuis `constants.js` dans les deux fichiers.

---

### 3.6. CORRIGE — Methode manquante dans Database facade

**Probleme** : `Application.start()` appelle `this.database.countFilesWithoutChannels()` mais cette methode n'avait pas de wrapper dans `Database.js`.

**Correction** : Ajout du wrapper delegant a `this.midiDB.countFilesWithoutChannels()`.

---

### 3.7. MAJEUR — Couverture de tests faible (~8%)

**Probleme** : 13 fichiers de test pour ~165 fichiers source. Les tests couvrent :
- **Couvert** : EventBus, Logger, Config, ServiceContainer, errors, dbHelpers, CommandRegistry, midi-filter, midi-adaptation, i18n audit
- **Non couvert** : Commandes API (17 fichiers), managers (Bluetooth, Serial, Network, Lighting), MidiPlayer, MidiRouter, DeviceManager, drivers lighting, FileManager, frontend (1 seul test)

**Manquant** :
- 0 tests e2e (pas de Playwright/Cypress)
- 0 tests d'integration API HTTP
- Pas de seuil de couverture dans le CI

**Recommandation** :
1. Ajouter un seuil de couverture dans le CI (commencer a 30%, viser 60%)
2. Priorite 1 : Tests pour MidiPlayer, MidiRouter, FileManager
3. Priorite 2 : Tests d'integration pour les commandes API
4. Priorite 3 : Tests frontend via Vitest

---

### 3.8. MAJEUR — Fichiers source trop volumineux

**Fichiers >700 lignes (backend)** :
| Fichier | Lignes | Suggestion |
|---|---|---|
| `InstrumentDatabase.js` | ~1400 | Separer CRUD / Capabilities / Settings |
| `InstrumentMatcher.js` | ~1040 | Extraire les strategies de matching |
| `FileManager.js` | ~1030 | Separer upload/download, parsing, analyse |
| `LightingManager.js` | ~1000 | Separer rule engine / driver management |
| `Database.js` | ~960 | Supprimer facade (voir 3.2) |
| `MidiPlayer.js` | ~950 | Extraire queue/playlist management |
| `TablatureConverter.js` | ~930 | Separer par type d'instrument |
| `MidiDatabase.js` | ~880 | Separer CRUD / requetes analytiques |
| `DeviceCommands.js` | ~860 | Separer MIDI / virtual / capabilities |
| `DrumNoteMapper.js` | ~810 | Extraire tables de mapping en JSON |
| `PlaybackCommands.js` | ~760 | Separer playback / queue / playlist |

**Fichiers >700 lignes (frontend)** :
| Fichier | Lignes | Suggestion |
|---|---|---|
| `MidiEditorCCPicker.js` | ~1320 | Decouper en sous-composants |
| `MidiEditorCCPanel.js` | ~1300 | Decouper en sous-composants |
| `InstrumentManagementPage.js` | ~1020 | Separer rendering / logic |

---

### 3.9. MAJEUR — Frontend sans framework (~47K lignes vanilla JS)

**Probleme** : Frontend en JS vanilla avec composants monolithiques (>1000 lignes), pas de state management centralise, inline styles repandus.

**Etat** : Vite est configure pour le build/dev mais le frontend n'est pas structure en modules ES.

**Evolution** :
1. Court terme : Structurer en modules ES avec Vite
2. Moyen terme : Migrer les composants complexes vers Web Components natifs ou un framework leger (Preact, Lit)

---

### 3.10. MOYEN — Seuil ESLint a 150 warnings

**Probleme** : `lint-staged` autorise 150 warnings ESLint. Cela indique une dette technique.

**Evolution** : Reduire progressivement (150 -> 100 -> 50 -> 0) en corrigeant les warnings par lot.

---

### 3.11. MOYEN — TypeScript present mais non compile

**Probleme** : Le projet a un `tsconfig.json`, des types dans `src/types/index.ts`, et `tsc --noEmit` dans les scripts, mais tout le code est en `.js`. Les benefices du TypeScript ne sont pas exploites au runtime.

**Evolution** :
- **Option A** : Migrer progressivement vers `.ts` (en commencant par `core/`)
- **Option B** : Rester en JS avec JSDoc + `@ts-check` pour le typage graduel

---

### 3.12. MOYEN — Vulnerabilites npm audit

**Etat** : 6 vulnerabilites detectees par `npm audit` :
- **HIGH** : `path-to-regexp` (ReDoS), `picomatch` (ReDoS)
- **MODERATE** : `brace-expansion` (process hang), `xml2js` (prototype pollution)
- **Indirect** : `dbus-next` et `node-ble` dependent de `xml2js` vulnerable

**Action** : Mettre a jour les dependances quand des correctifs sont disponibles.

---

### 3.13. MOYEN — Dependencies outdated

| Package | Version actuelle | Derniere version | Commentaire |
|---|---|---|---|
| `express` | ^4.18.2 | 5.x | Changement majeur |
| `better-sqlite3` | ^9.6.0 | 12.x | Changement majeur |
| `easymidi` | ^2.0.1 | 3.x | Changement majeur |
| `serialport` | ^12.0.0 | 13.x | Changement majeur |
| `dotenv` | ^16.3.1 | 17.x | Mineur |

---

### 3.14. MINEUR — ALSA parsing avec mot-cle francais

**Probleme** : `DelayCalibrator.js` utilise le regex `carte` pour parser la sortie ALSA — echoue sur les systemes en anglais ou `card` est utilise.

**Correction** : Ajouter un regex multilangue ou parser sur les numeros de carte.

---

### 3.15. MINEUR — Double tracking des migrations

**Probleme** : La base de donnees utilise a la fois une table `migrations` et un `schema_version`. Cela cree de la confusion.

**Evolution** : Unifier sur un seul mecanisme.

---

### 3.16. MINEUR — CSS : 362 `!important` et 23 `outline: none`

**Probleme** :
- 362 declarations `!important` causant des problemes de specificite
- Variables CSS (`:root`) definies dans 4+ fichiers avec ordre d'override imprevisible
- 23 `outline: none` sans alternatives focus (violation WCAG)

**Evolution** :
- Reduire les `!important` en restructurant la cascade CSS
- Centraliser les variables CSS dans un seul fichier
- Ajouter des styles `:focus-visible` pour l'accessibilite

---

### 3.17. MINEUR — Performance

- `MidiRouter` itere toutes les routes pour chaque message MIDI — besoin d'indexation par source
- `getAllFiles()` charge les BLOBs meme pour les requetes metadata-only
- `FilterManager` : timers de debounce jamais nettoyes au unmount

---

## 4. Plan d'Action Recommande

### Phase 1 — Corrections immediates (fait)
1. ~~Corriger bug Note 0 dans MidiTransposer.js et AudioPreview.js~~
2. ~~Dedupliquer constantes MIDI (MidiUtils.js importe depuis constants.js)~~
3. ~~Centraliser magic numbers (WebSocketServer, MidiRouter)~~
4. ~~Ajouter methode manquante dans Database facade~~

### Phase 2 — Qualite (court terme)
5. Reduire le seuil ESLint progressivement (150 -> 100 -> 50 -> 0)
6. Ajouter des tests pour MidiPlayer, MidiRouter, FileManager
7. Ajouter un seuil de couverture dans le CI
8. Corriger les vulnerabilites npm quand les fixes sont disponibles

### Phase 3 — Architecture (moyen terme)
9. Migrer les services restants vers l'injection explicite par `deps`
10. Enregistrer les sous-modules DB directement dans le ServiceContainer
11. Decouper les fichiers >700 lignes (voir tableau 3.8)
12. Structurer le frontend avec Vite + ES modules

### Phase 4 — Long terme
13. Atteindre 50%+ de couverture de tests
14. Evaluer la migration TypeScript
15. Reduire les `!important` CSS et corriger l'accessibilite WCAG
16. Envisager un framework frontend leger pour les composants complexes

---

## 5. Metriques Cles

| Metrique | Actuel | Cible Phase 2 | Cible Phase 4 |
|---|---|---|---|
| Couverture tests backend | ~8% | 30% | 60% |
| ESLint warnings max | 150 | 50 | 0 |
| Fichiers >700 lignes (backend) | 11 | 8 | 3 |
| Services avec DI explicite (`deps`) | ~5/15 | 10/15 | 15/15 |
| Fichiers test / fichiers source | 13/165 | 30/165 | 60/165 |
| Vulnerabilites npm (HIGH) | 2 | 0 | 0 |
| CSS `!important` | 362 | 200 | 50 |
