# Plan de refactorisation — General Midi Boop

> Document vivant. Toute nouvelle découverte faite pendant la refactorisation doit être ajoutée
> dans la section correspondante ou dans **Découvertes en cours de route** en bas de fichier.
>
> **Branche de travail :** `claude/refactor-and-document-UN4we`
> **Basé sur l'audit :** mai 2026
> **Statut global :** 🟢 Terminé (S4-3 migration container en continu)

---

## Vue d'ensemble

Le projet est fonctionnellement solide et mature. L'audit identifie une dette architecturale
concentrée sur trois axes :

1. **Duplication de logique** entre `MidiRouter` et `PlaybackScheduler` (cache compensation)
2. **Couplage fort** de `PlaybackScheduler` sur `Application` entier (via `this.app`)
3. **Responsabilités parasites** dans `Application.js` (token API, bridge Bluetooth)

Les recommandations hexagonale/TypeScript de l'audit sont écartées comme disproportionnées
pour ce projet. Le plan ci-dessous privilégie des changements locaux, incrémentaux, avec tests
existants comme filet de sécurité.

---

## Semaine 1 — Élimination des doublons et SRP immédiat

Faible risque, fort impact. Chaque tâche est indépendante et peut être mergée séparément.

### S1-1 — `CompensationService` partagé
**Statut :** 🟢 Fait
**Fichiers concernés :**
- `src/midi/routing/MidiRouter.js` — méthodes `_getRouteCompensation`, `_getRelativeCompensation`
- `src/midi/playback/PlaybackScheduler.js` — méthode `_getSyncDelay`
- `src/midi/compensation/CompensationService.js` — **créé**

**Problème :** `MidiRouter._getRouteCompensation()` et `PlaybackScheduler._getSyncDelay()` font
exactement la même chose (`database.getInstrumentSettings.sync_delay` +
`latencyCompensator.getLatency`), avec chacun leur `Map` de cache qui écoute
`instrument_settings_changed`. Divergence possible si un cache est invalide et pas l'autre.

**Implémentation :**
```javascript
// src/midi/compensation/CompensationService.js
export class CompensationService {
  constructor({ database, latencyCompensator, eventBus, logger }) {
    this._db = database;
    this._lc = latencyCompensator;
    this._log = logger;
    this._cache = new Map();
    this._cacheTimer = setInterval(() => this._cache.clear(), 30_000);
    this._onChanged = () => this._cache.clear();
    eventBus.on('instrument_settings_changed', this._onChanged);
  }

  /** Retourne le délai total (sync_delay user + latence HW), clampé à MAX_COMPENSATION_MS. */
  getDelay(deviceId, channel) {
    const key = `${deviceId}:${channel ?? ''}`;
    if (this._cache.has(key)) return this._cache.get(key);
    const result = this._compute(deviceId, channel);
    this._cache.set(key, result);
    return result;
  }

  invalidate() { this._cache.clear(); }

  destroy() {
    clearInterval(this._cacheTimer);
    // détacher eventBus listener
  }
}
```
- Enregistré dans `Application.initialize()` après `latencyCompensator`
- `MidiRouter` : remplacé `_getRouteCompensation` + son cache par `this.compensationService.getDelay`
- `PlaybackScheduler` : remplacé `_getSyncDelay` + son cache par `this.compensationService.getDelay`
- Supprimé les caches `_compensationCacheTimer` dans MidiRouter et `_syncDelayCache` dans Scheduler

**Tests à ajouter :** `tests/compensation-service.test.js`
- getDelay() avec sync_delay seul
- getDelay() avec hw latency seul
- getDelay() combiné
- invalidation sur instrument_settings_changed
- clamp à MAX_COMPENSATION_MS

---

### S1-2 — MidiRouter → DeviceRouteRepository au lieu de Database direct
**Statut :** 🟢 Fait
**Fichiers concernés :**
- `src/midi/routing/MidiRouter.js`
- `src/repositories/DeviceRouteRepository.js` — **créé**

**Problème :** `MidiRouter` appelait directement `this.database.insertRoute`,
`this.database.deleteRoute`, `this.database.updateRoute`, `this.database.getRoutes`.
Il fallait un repository dédié à la table `routes` (routing device-to-device temps réel),
distinct de `RoutingRepository` qui wraps la table `routings` (file playback).

**Découverte :** Deux tables distinctes existent : `routes` (routage temps réel device-to-device,
utilisé par MidiRouter) et `routings` (associations fichier→channel→device, utilisé pour la
lecture MIDI). `RoutingRepository` n'était donc pas applicable directement à MidiRouter.
Création de `DeviceRouteRepository` pour la table `routes`.

**Implémentation :**
```javascript
// src/repositories/DeviceRouteRepository.js
export default class DeviceRouteRepository {
  findAll()                  { return this.database.getRoutes(); }
  insert(route)              { return this.database.insertRoute(route); }
  update(routeId, updates)   { return this.database.updateRoute(routeId, updates); }
  delete(routeId)            { return this.database.deleteRoute(routeId); }
}
```
`DeviceRouteRepository` enregistré dans `Application.initialize()` AVANT `MidiRouter`
(car `loadRoutesFromDB()` s'exécute dans le constructeur de MidiRouter).

**Tests :** Les tests d'intégration routing existants couvrent déjà ce chemin.

---

### S1-3 — Extraire `ApiTokenManager`
**Statut :** 🟢 Fait
**Fichiers concernés :**
- `src/core/Application.js` — méthode `_ensureApiToken()` supprimée
- `src/infrastructure/auth/ApiTokenManager.js` — **créé**

**Problème :** Logique de lecture/écriture `.env` + génération token dans Application.js.
Pas testable en isolation, pas liée au cycle de vie des services.

**Implémentation :**
```javascript
// src/infrastructure/auth/ApiTokenManager.js
import { randomBytes } from 'crypto';
import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

export class ApiTokenManager {
  constructor(logger) { this.logger = logger; }

  ensure() {
    if (process.env.GMBOOP_API_TOKEN) {
      this.logger.info('API token already configured');
      return;
    }
    // ... logique actuelle de _ensureApiToken()
  }
}
```
Dans `Application.initialize()` remplacé `this._ensureApiToken()` par
`new ApiTokenManager(this.logger).ensure()`.

---

### S1-4 — Extraire `BluetoothEventBridge`
**Statut :** 🟢 Fait
**Fichiers concernés :**
- `src/core/Application.js` — bloc `btBroadcasts` dans `setupEventHandlers()` supprimé
- `src/infrastructure/events/BluetoothEventBridge.js` — **créé**

**Problème :** `setupEventHandlers()` mélangait les handlers EventBus core (device/playback)
avec le bridge spécifique Bluetooth→WS. Complexité cognitive inutile.

**Implémentation :**
```javascript
// src/infrastructure/events/BluetoothEventBridge.js
const BT_EVENTS = ['bluetooth:powered_on', 'bluetooth:powered_off',
                   'bluetooth:connected', 'bluetooth:disconnected', 'bluetooth:unpaired'];

export class BluetoothEventBridge {
  constructor(bluetoothManager, wsServer) {
    this._bt = bluetoothManager;
    this._ws = wsServer;
    this._handlers = [];
  }
  attach() {
    for (const event of BT_EVENTS) {
      const handler = (data) => this._ws?.broadcast(event, data || {});
      this._bt.on(event, handler);
      this._handlers.push({ event, handler });
    }
  }
  detach() {
    for (const { event, handler } of this._handlers) this._bt.off(event, handler);
    this._handlers = [];
  }
}
```

---

### S1-5 — CommandRegistry : throw sur doublon (pas warn)
**Statut :** 🟢 Fait
**Fichiers concernés :**
- `src/api/CommandRegistry.js`

**Problème :** Un overwrite silencieux de handler lors du chargement dynamique des 21 modules
de commandes n'est détecté que par un warning. En production, la commande visible est celle
chargée en dernier (ordre filesystem non déterministe).

**Implémentation :** Remplacé le `logger.warn` par un `throw new Error(...)`. Une ligne de changement.

---

### S1-6 — PlaybackScheduler : deps explicites au lieu de `app`
**Statut :** 🟢 Fait
**Fichiers concernés :**
- `src/midi/playback/PlaybackScheduler.js`

**Problème :** Le constructeur prenait `app` (l'Application entière) et accédait à
`this.app.database`, `this.app.logger`, `this.app.wsServer`, `this.app.deviceManager`,
`this.app.latencyCompensator`, `this.app.midiClockGenerator`, `this.app.eventBus`.
Impossible à instancier dans les tests sans mocker tout Application.

**Implémentation :**
```javascript
// AVANT
constructor(app) { this.app = app; }

// APRÈS
constructor({ logger, database, eventBus, wsServer, deviceManager,
              latencyCompensator, midiClockGenerator }) {
  this.logger = logger;
  this.database = database;
  // ...
}
```
Tous les `this.app.xxx` remplacés par accès direct aux deps.

**Tests à ajouter :** Tests unitaires `PlaybackScheduler` sans mock d'Application.

---

## Semaine 2-3 — Observabilité et consolidation

### S2-1 — EventLoopMonitor + broadcast `system_lag`
**Statut :** 🟢 Fait
**Fichiers concernés :**
- `src/infrastructure/monitoring/EventLoopMonitor.js` — **créé**
- `src/core/Application.js` — monitor démarré dans `start()`

**Problème :** Aucune visibilité sur la saturation de l'event loop sous charge (gros fichiers
MIDI, haute polyphonie). Les symptômes (notes tardives, jitter) n'ont pas de signal diagnostique.

**Implémentation :**
```javascript
// src/infrastructure/monitoring/EventLoopMonitor.js
import { performance } from 'perf_hooks';

export class EventLoopMonitor {
  constructor({ logger, wsServer, threshold = 50 }) {
    this._log = logger;
    this._ws = wsServer;
    this._threshold = threshold; // ms
  }

  start() {
    let last = performance.now();
    this._interval = setInterval(() => {
      const now = performance.now();
      const lag = now - last - 10;
      if (lag > this._threshold) {
        this._log.warn(`Event loop lag: ${lag.toFixed(1)}ms`);
        this._ws?.broadcast('system_lag', { lagMs: lag, threshold: this._threshold });
      }
      last = now;
    }, 10);
  }

  stop() { if (this._interval) clearInterval(this._interval); }
}
```

---

### S2-2 — `CapabilityResolver` centralisé
**Statut :** 🟢 Fait
**Fichiers concernés :**
- `src/midi/playback/PlaybackScheduler.js` — méthodes `_getTimingConstraints`, `_isStringCCAllowed` supprimées
- `src/midi/instrument/CapabilityResolver.js` — **créé**

**Problème :** `PlaybackScheduler` faisait deux lookups DB (`instrumentCapabilitiesDB`,
`stringInstrumentDB`) avec leurs propres caches. Centraliser évite la dispersion.

**Implémentation :**
```javascript
// src/midi/instrument/CapabilityResolver.js
export class CapabilityResolver {
  constructor({ database, eventBus }) {
    this._db = database;
    this._cache = new Map();
    eventBus.on('instrument_settings_changed', () => this._cache.clear());
  }

  getConstraints(deviceId, channel) {
    // logique actuelle de PlaybackScheduler._getTimingConstraints
  }

  isStringCC(deviceId, channel) {
    // logique actuelle de PlaybackScheduler._isStringCCAllowed
  }

  invalidate() { this._cache.clear(); }
}
```
`PlaybackScheduler` reçoit `capabilityResolver` en dep et a supprimé ses propres caches/méthodes.

---

### S2-3 — `MIDI_EVENT_TYPES` constants + harmonisation des strings de type
**Statut :** 🟢 Fait
**Fichiers concernés :**
- `src/core/constants.js` — deux nouvelles constantes exportées
- `src/midi/playback/PlaybackScheduler.js` — 22+ string literals remplacés

**Problème :** Incohérence entre `'noteOn'`/`'noteOff'` (PlaybackScheduler, parsed file events)
et `'noteon'`/`'noteoff'` (DeviceManager/sendMessage, easymidi). Deux conventions coexistaient.

**Implémentation :**
```javascript
// src/core/constants.js — ajouté
export const MIDI_EVENT_TYPES = Object.freeze({
  NOTE_ON:            'noteOn',
  NOTE_OFF:           'noteOff',
  CONTROLLER:         'controller',
  PROGRAM_CHANGE:     'programChange',
  PITCH_BEND:         'pitchBend',
  CHANNEL_AFTERTOUCH: 'channelAftertouch',
  NOTE_AFTERTOUCH:    'noteAftertouch',
  SET_TEMPO:          'setTempo',
});

export const DEVICE_MSG_TYPES = Object.freeze({
  NOTE_ON:            'noteon',
  NOTE_OFF:           'noteoff',
  CC:                 'cc',
  PROGRAM:            'program',
  PITCH_BEND:         'pitchbend',
  CHANNEL_AFTERTOUCH: 'channel aftertouch',
  POLY_AFTERTOUCH:    'poly aftertouch',
});
```

---

### S2-4 — Backpressure PlaybackScheduler sous lag event loop
**Statut :** 🟢 Fait
**Fichiers concernés :**
- `src/midi/playback/PlaybackScheduler.js` — méthode `tick()`

**Prérequis :** S2-1 (EventLoopMonitor doit exister pour exposer le lag courant)

**Implémentation :**
```javascript
// Dans tick(), après calcul du rate
const currentLag = this._eventLoopMonitor?.currentLag ?? 0;
const dynamicLookahead = currentLag > 20
  ? Math.max(0.05, LOOKAHEAD_SECONDS - currentLag / 1000)
  : LOOKAHEAD_SECONDS;
const targetTime = state.position + dynamicLookahead + maxCompSec;
```

---

## Semaine 4 — Améliorations structurelles

### S4-1 — `PlaybackStateMachine`
**Statut :** 🟢 Fait
**Fichiers concernés :**
- `src/midi/playback/state/PlaybackStateMachine.js` — **créé**
- `src/midi/playback/MidiPlayer.js` — intégré (tryTransition sur play/pause/resume/stop/seek)

**Problème :** L'état playback était géré par des flags booléens (`playing`, `paused`) dans
MidiPlayer. Des transitions invalides (ex: seek sur stopped, stop sur stopped) n'étaient pas
protégées.

**Implémentation :**
```javascript
// src/midi/playback/state/PlaybackStateMachine.js
const VALID_TRANSITIONS = {
  stopped:  ['loading', 'playing'],
  loading:  ['stopped', 'playing'],
  playing:  ['paused', 'stopped', 'seeking'],
  paused:   ['playing', 'stopped', 'seeking'],
  seeking:  ['playing', 'paused', 'stopped'],
};

export class PlaybackStateMachine {
  constructor(initial = 'stopped') { this.state = initial; }

  transition(next) {
    if (!VALID_TRANSITIONS[this.state]?.includes(next)) {
      throw new Error(`Invalid playback transition: ${this.state} → ${next}`);
    }
    const prev = this.state;
    this.state = next;
    return prev;
  }

  is(s)  { return this.state === s; }
  can(s) { return VALID_TRANSITIONS[this.state]?.includes(s) ?? false; }
}
```
`this.playing` et `this.paused` conservés dans MidiPlayer pour compatibilité ascendante.

---

### S4-2 — Supprimer `_migrateLegacyArtifacts` (déjà marqué 0.8.0)
**Statut :** 🟢 Fait
**Fichiers concernés :**
- `src/core/Application.js` — méthode et son appel dans `initialize()` supprimés

**Note :** La migration `midimind.db → gmboop.db` était commentée "Remove in 0.8.0". Version
confirmée 0.8.0 dans `package.json`. Supprimé la méthode, son appel, et les imports devenus
inutiles (`existsSync`, `renameSync`).

---

### S4-3 — Migration progressive this[name] → container uniquement
**Statut :** 🔵 En continu (pas de deadline fixe)
**Fichiers concernés :**
- `src/core/Application.js` — méthode `_registerService()`
- Tous les consommateurs qui accèdent via `app.xxx` au lieu de `deps.resolve()`

**Objectif final :** Supprimer la ligne `this[name] = instance` dans `_registerService()`.
Chaque PR qui touche un service doit convertir ses accès vers le container.

**Progression :**
- [x] `PlaybackScheduler` (fait en S1-6)
- [x] `MidiRouter` (en partie fait en S1-2)
- [ ] `FileManager`
- [ ] `MidiPlayer`
- [ ] `CommandHandler` et sous-commandes
- [ ] Autres services...

---

## Refactorisations écartées (et pourquoi)

Ces points de l'audit ont été étudiés et jugés disproportionnés pour ce projet :

| Recommandation audit | Raison du rejet |
|----------------------|-----------------|
| Architecture hexagonale complète | Le projet a déjà 80% des patterns (repos, EventBus, DI, command pattern). Restructurer les dossiers sans changer les classes = semaines de travail, valeur marginale |
| Migration TypeScript | JSDoc strict + 79 tests couvrent le besoin. Migration = plusieurs semaines de travail pour une valeur immédiate limitée |
| Bucket scheduler 2-5ms | Réécriture complète du scheduler, risque de régression timing élevé. À réévaluer si EventLoopMonitor (S2-1) montre un problème réel |
| Éclater MidiRouter en 4 classes (RouteStore, RoutingEngine, CompensationService, MonitorPublisher) | MidiRouter = 300 lignes de logique cohérente. RouteStore = 80 lignes. Découpage = over-engineering. Seul CompensationService est utile (fait en S1-1) |
| Éclater `initialize()` en sous-méthodes `_initMidi()` etc. | Déplace le texte sans réduire la complexité cognitive. La séquence linéaire reflète le graphe de dépendances |

---

## Découvertes en cours de route

> Cette section est le journal de bord de la refactorisation. Toute surprise, nouveau bug
> découvert, incohérence non listée ci-dessus doit être documentée ici avec la date et la tâche
> en cours au moment de la découverte.

### 2026-05-05 — Découvert pendant S1-2
**Fichier :** `src/repositories/RoutingRepository.js`, `src/midi/routing/MidiRouter.js`
**Observation :** Le projet possède deux tables distinctes avec des noms proches : `routes` (routage
temps réel device-to-device, géré par `MidiRouter`) et `routings` (associations fichier→channel→device
pour la lecture MIDI, géré par `RoutingRepository`). `RoutingRepository` n'était donc pas applicable
à `MidiRouter`. Création de `DeviceRouteRepository` nécessaire pour la table `routes`.
**Impact :** Renommage dans le plan initial (S1-2 mentionnait `RoutingRepository`, corrigé).
**Action :** `DeviceRouteRepository` créé et injecté dans `MidiRouter`.

### 2026-05-05 — Découvert pendant S1-6
**Fichier :** `src/midi/playback/PlaybackScheduler.js`
**Observation :** Le constructeur `PlaybackScheduler(app)` cachait 7 dépendances implicites.
La migration vers un deps bag explicite a révélé que `compensationService` et `capabilityResolver`
n'existaient pas encore lors du premier passage — les tâches S1-1 et S2-2 ont dû être réalisées
en parallèle.
**Impact :** Ordre d'exécution des tâches ajusté.

### 2026-05-05 — JSDoc orphelin dans Application.js
**Fichier :** `src/core/Application.js` avant S4-2
**Observation :** Le JSDoc de `_ensureApiToken()` était resté attaché à `_migrateLegacyArtifacts()`
après l'extraction de S1-3. Le commentaire décrivait la génération de token alors que la méthode
faisait la migration de fichiers DB.
**Impact :** Confusion lors de la lecture du code. Supprimé avec la méthode en S4-2.

---

## Métriques de suivi

Pour évaluer l'avancement objectivement :

| Métrique | Avant refacto | Après refacto |
|----------|---------------|---------------|
| Lignes `Application.js` | 745 | 709 |
| Caches compensation distincts | 2 (Router + Scheduler) | 1 (`CompensationService`) |
| Usages `this.app.xxx` dans PlaybackScheduler | 14 | 0 |
| Usages `this.database.*` dans MidiRouter (bypass repo) | 6 | 0 |
| Lookups DB directs depuis PlaybackScheduler | 2 méthodes | 0 (via `CapabilityResolver`) |
| Nouveaux fichiers créés | — | 7 |
| String literals MIDI type remplacés par constantes | 0 | 22+ |
| Transitions playback protégées par FSM | 0 | 5 (play/pause/resume/stop/seek) |
