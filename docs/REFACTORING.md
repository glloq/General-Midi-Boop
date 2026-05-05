# Plan de refactorisation — General Midi Boop

> Document vivant. Toute nouvelle découverte faite pendant la refactorisation doit être ajoutée
> dans la section correspondante ou dans **Découvertes en cours de route** en bas de fichier.
>
> **Branche de travail :** `claude/refactor-and-document-UN4we`
> **Basé sur l'audit :** mai 2026
> **Statut global :** 🔴 Non démarré

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
**Statut :** 🔴 À faire
**Fichiers concernés :**
- `src/midi/routing/MidiRouter.js` — méthodes `_getRouteCompensation`, `_getRelativeCompensation`
- `src/midi/playback/PlaybackScheduler.js` — méthode `_getSyncDelay`
- `src/midi/compensation/CompensationService.js` — **à créer**

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
- Enregistrer dans `Application.initialize()` après `latencyCompensator`
- `MidiRouter` : remplacer `_getRouteCompensation` + son cache par `this.compensationService.getDelay`
- `PlaybackScheduler` : remplacer `_getSyncDelay` + son cache par `this.compensationService.getDelay`
- Supprimer les caches `_compensationCacheTimer` dans MidiRouter et `_syncDelayCache` dans Scheduler

**Tests à ajouter :** `tests/compensation-service.test.js`
- getDelay() avec sync_delay seul
- getDelay() avec hw latency seul
- getDelay() combiné
- invalidation sur instrument_settings_changed
- clamp à MAX_COMPENSATION_MS

---

### S1-2 — MidiRouter → RoutingRepository au lieu de Database direct
**Statut :** 🔴 À faire
**Fichiers concernés :**
- `src/midi/routing/MidiRouter.js`
- `src/repositories/RoutingRepository.js` (existe déjà)

**Problème :** `MidiRouter` appelle directement `this.database.insertRoute`,
`this.database.deleteRoute`, `this.database.updateRoute`, `this.database.getRoutes`.
`RoutingRepository` existe déjà et expose ces mêmes opérations. Le router bypasse la couche
repo, cassant la séparation en place.

**Implémentation :**
Injecter `routingRepository` dans `MidiRouter` (disponible dans `deps` via le container).
Remplacer dans `addRoute`, `deleteRoute`, `enableRoute`, `setFilter`, `setChannelMap`,
`loadRoutesFromDB` :
```javascript
// AVANT
this.database.insertRoute({ id: routeId, source_device: ..., ... });
// APRÈS
this.routingRepository.addRoute({ id: routeId, source: ..., ... });
```
Vérifier que `RoutingRepository` expose tous les appels nécessaires, en ajouter si manquants.

**Tests :** Les tests d'intégration routing existants couvrent déjà ce chemin.

---

### S1-3 — Extraire `ApiTokenManager`
**Statut :** 🔴 À faire
**Fichiers concernés :**
- `src/core/Application.js` — méthode `_ensureApiToken()` (lignes ~190-222)
- `src/infrastructure/auth/ApiTokenManager.js` — **à créer**

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
Dans `Application.initialize()` remplacer `this._ensureApiToken()` par
`new ApiTokenManager(this.logger).ensure()`.

---

### S1-4 — Extraire `BluetoothEventBridge`
**Statut :** 🔴 À faire
**Fichiers concernés :**
- `src/core/Application.js` — bloc `btBroadcasts` dans `setupEventHandlers()` (lignes ~468-483)
- `src/infrastructure/events/BluetoothEventBridge.js` — **à créer**

**Problème :** `setupEventHandlers()` mélange les handlers EventBus core (device/playback)
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
**Statut :** 🔴 À faire
**Fichiers concernés :**
- `src/api/CommandRegistry.js`

**Problème :** Un overwrite silencieux de handler lors du chargement dynamique des 21 modules
de commandes n'est détecté que par un warning. En production, la commande visible est celle
chargée en dernier (ordre filesystem non déterministe).

**Implémentation :** Trouver la ligne de registration dans `CommandRegistry.js` et remplacer
le `logger.warn` par un `throw new Error(...)`. Une ligne de changement.

---

### S1-6 — PlaybackScheduler : deps explicites au lieu de `app`
**Statut :** 🔴 À faire
**Fichiers concernés :**
- `src/midi/playback/PlaybackScheduler.js`

**Problème :** Le constructeur prend `app` (l'Application entière) et accède à
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
Mettre à jour l'instanciation dans `MidiPlayer.js` pour passer le bag de deps.
Remplacer tous les `this.app.xxx` dans le fichier (recherche globale).

**Tests à ajouter :** Tests unitaires `PlaybackScheduler` sans mock d'Application.

---

## Semaine 2-3 — Observabilité et consolidation

### S2-1 — EventLoopMonitor + broadcast `system_lag`
**Statut :** 🔴 À faire
**Fichiers concernés :**
- `src/infrastructure/monitoring/EventLoopMonitor.js` — **à créer**
- `src/core/Application.js` — démarrer le monitor dans `start()`

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
**Statut :** 🔴 À faire
**Fichiers concernés :**
- `src/midi/playback/PlaybackScheduler.js` — méthodes `_getTimingConstraints`, `_isStringCCAllowed`
- `src/midi/instrument/CapabilityResolver.js` — **à créer**

**Problème :** `PlaybackScheduler` fait deux lookups DB (`instrumentCapabilitiesDB`,
`stringInstrumentDB`) avec leurs propres caches. Ces lookups seront nécessaires à d'autres
endroits si le projet évolue. Centraliser évite la dispersion.

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
`PlaybackScheduler` reçoit `capabilityResolver` en dep et supprime ses propres caches/méthodes.

---

### S2-3 — `MIDI_EVENT_TYPES` constants + harmonisation des strings de type
**Statut :** 🔴 À faire
**Fichiers concernés :**
- `src/core/constants.js`
- `src/midi/playback/PlaybackScheduler.js`
- `src/midi/routing/MidiRouter.js`
- Tous les fichiers qui comparent des strings de type MIDI

**Problème :** Incohérence entre `'noteOn'`/`'noteOff'` (PlaybackScheduler) et
`'noteon'`/`'noteoff'` (DeviceManager/sendMessage). Deux conventions coexistent. Bug latent
si une comparaison se fait entre les deux couches.

**Implémentation :**
Ajouter dans `constants.js` :
```javascript
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

// Mapping vers les strings attendues par easymidi/DeviceManager
export const DEVICE_MSG_TYPES = Object.freeze({
  noteOn:  'noteon',
  noteOff: 'noteoff',
  // ...
});
```
Puis remplacer les string literals dans les fichiers concernés.

---

### S2-4 — Backpressure PlaybackScheduler sous lag event loop
**Statut :** 🔴 À faire
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
**Statut :** 🔴 À faire
**Fichiers concernés :**
- `src/midi/playback/state/PlaybackStateMachine.js` — **à créer**
- `src/midi/playback/MidiPlayer.js` (2046 lignes) — intégrer progressivement

**Problème :** L'état playback est géré par des flags booléens (`playing`, `paused`) dans
MidiPlayer. Des transitions invalides (ex: seek sur stopped, stop sur stopped) ne sont pas
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
Intégrer dans MidiPlayer un état à la fois, en commençant par `stop()` / `play()`.

---

### S4-2 — Supprimer `_migrateLegacyArtifacts` (déjà marqué 0.8.0)
**Statut :** 🔴 À faire (dès que la version 0.8.0 est prête)
**Fichiers concernés :**
- `src/core/Application.js` — méthode `_migrateLegacyArtifacts()` + son appel dans `initialize()`

**Note :** La migration `midimind.db → gmboop.db` est commentée "Remove in 0.8.0". Ne pas
oublier de supprimer aussi l'appel dans `initialize()`.

---

### S4-3 — Migration progressive this[name] → container uniquement
**Statut :** 🔴 À faire (en continu, pas de deadline fixe)
**Fichiers concernés :**
- `src/core/Application.js` — méthode `_registerService()`
- Tous les consommateurs qui accèdent via `app.xxx` au lieu de `deps.resolve()`

**Objectif final :** Supprimer la ligne `this[name] = instance` dans `_registerService()`.
Chaque PR qui touche un service doit convertir ses accès vers le container.

**Progression :**
- [ ] `PlaybackScheduler` (fait en S1-6)
- [ ] `MidiRouter` (en partie fait en S1-2)
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

<!-- Exemple de format :
### 2026-05-05 — Découvert pendant S1-1
**Fichier :** `src/midi/routing/MidiRouter.js:514`
**Observation :** Le cache compensation n'est pas invalidé lors de la suppression d'une route,
seulement sur `instrument_settings_changed`. Si une route est supprimée, l'ancienne valeur
de compensation pour le device reste en cache jusqu'au prochain refresh 30s.
**Impact :** Mineur — compensation stale pendant max 30s après suppression de route.
**Action :** Appeler `this.compensationService.invalidate()` dans `deleteRoute()`.
-->

---

## Métriques de suivi

Pour évaluer l'avancement objectivement :

| Métrique | Avant refacto | Cible |
|----------|---------------|-------|
| Lignes `Application.js` | 745 | < 600 |
| Caches compensation distincts | 2 (Router + Scheduler) | 1 (CompensationService) |
| Usages `this.app.xxx` dans PlaybackScheduler | 14 | 0 |
| Usages `this.database.*` dans MidiRouter (bypass repo) | 6 | 0 |
| Lookups DB directs depuis PlaybackScheduler | 2 méthodes | 0 (via CapabilityResolver) |
| Couverture tests PlaybackScheduler isolé | 0 (nécessite Application mock) | > 0 |
