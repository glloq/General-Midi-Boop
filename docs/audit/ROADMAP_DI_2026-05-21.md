# Audit DI & dépendances — 2026-05-21

> **Périmètre** : vérification factuelle des 10 axes de l'audit critique
> reçu le 2026-05-21 et des 5 constats associés (B1–B5). Le présent rapport
> est **read-only** : aucun code applicatif n'a été modifié. Les correctifs
> sont laissés explicitement à un PR ultérieur.
>
> **Branche** : `claude/audit-di-dependencies-lVbQE`
>
> **Méthode** : lecture statique du dépôt à `HEAD`, croisement avec les
> ADR/audits précédents (`docs/audit/AUDIT_2026-05-10.md`,
> `docs/audit/AUDIT_GLOBAL_2026-05-17.md`).

---

## TL;DR

| Constat initial | Statut | Sévérité |
|---|---|---|
| B1 `vitest` absent | ✅ **Confirmé** — `node_modules/` vide | Bloquant CI |
| B2 ESLint config non résolue | ⚠️ **Partiellement confirmé** — `.eslintrc.json` est valide pour ESLint 8 ; le message d'erreur observé est dû à `node_modules/` absent, pas à un drift de format | Faux positif environnemental |
| B3 Risque ordre d'init DI | ✅ **Confirmé et documenté** — 2 tight-couplings de 3-4 lignes (LatencyCompensator, CompensationService) | Médian |
| B4 Concentration sur fichiers cœur | ✅ **Confirmé** — MidiPlayer 2306, Database 1036, Application 748 | Dette |
| B5 Doc « 15 modules » vs réalité | ✅ **Confirmé** — 24 modules de commandes, **267 commandes** registrées | Documentaire |
| Couverture schemas commandes | ❌ **Trouvaille additionnelle** — 44 schémas / 267 commandes = **~16 %** | Élevé |
| Token API en clair dans `.env` | ❌ **Trouvaille additionnelle** — pas de `chmod 0600` après écriture | Élevé |

Aucune anomalie **critique** au sens « bug d'exécution » dans l'état du
code lu. Les risques majeurs sont :
- une **régression silencieuse** possible sur l'ordre d'init DI si un
  futur refactor déplace LatencyCompensator/CompensationService ;
- une **couverture de validation** des payloads de commandes WS très
  partielle (~16 % seulement) — toute commande sans schéma reçoit un
  `{valid:true, errors:[]}` permissif ;
- un **token bearer** stocké en clair sur disque avec permissions par
  défaut, et écrit dans un fichier `.env` non garanti hors-VCS.

---

## 1. Gouvernance architecture / dépendances

### 1.1 Eager captures vs ordre d'enregistrement

L'analyse exhaustive (cf. annexe A) confirme le **contrat documenté à
`src/core/Application.js:185-198`** : chaque service qui capture
`deps.foo` dans son constructeur doit voir `foo` enregistré **avant**
lui dans `initialize()`.

**Captures eager listées par service** (file:line → propriétés captées
→ statut) :

| Service | Constructeur | Captures eager | Risque |
|---|---|---|---|
| `Database` | `Database.js:40-42` | `logger`, `config` | ✅ déjà en container |
| `DeviceManager` | `DeviceManager.js:66-86` | `logger`, `eventBus`, `database` ; lazy : `wsServer`, `midiRouter`, `networkManager`, `serialMidiManager`, `bluetoothManager`, `instrumentRepository` | ✅ pattern lazy correct |
| `MidiRouter` | `MidiRouter.js:40-45` | `logger`, `eventBus`, `deviceRouteRepository` | ✅ |
| `MidiClockGenerator` | `MidiClockGenerator.js:36-56` | `logger`, `eventBus`, `database` ; lazy : `deviceManager`, `networkManager`, `serialMidiManager`, `bluetoothManager`, `latencyCompensator` | ✅ commentaire explicite (l.39-44) |
| `LatencyCompensator` | `LatencyCompensator.js:32-35` | **eager `deviceManager`** + `logger`, `database`, `eventBus` ; lazy : `wsServer` | ⚠️ **tight 3 lignes** (234 → 237) |
| `CompensationService` | `CompensationService.js:34-38` | **eager `latencyCompensator`** + `database`, `eventBus`, `logger` | ⚠️ **tight 4 lignes** (237 → 241) |
| `CapabilityResolver` | `CapabilityResolver.js:28-39` | `database`, `eventBus` | ✅ |
| `MidiPlayer` → `PlaybackScheduler` | `PlaybackScheduler.js:49-77` | eager : `logger`, `database`, `eventBus`, `deviceManager`, `midiClockGenerator` ; **lazy** (getters) : `wsServer`, `compensationService`, `capabilityResolver`, `eventLoopMonitor` | ✅ « gold standard » documenté |
| `FileManager` | `FileManager.js:26-42` | eager : `logger`, `database`, `blobStore`, `eventBus` ; lazy : `wsServer`, `deviceManager`, `midiBaker`, `autoAssigner` | ✅ |
| `HttpServer` | `HttpServer.js:79-83` | `logger`, `config` ; `this._deps` complet | ✅ |
| `WebSocketServer` | `WebSocketServer.js:63-85` | `logger`, `config` ; lazy `eventLoopMonitor` via getter | ✅ excellent |
| `CommandHandler` | `CommandHandler.js:21-23` | `logger` ; passe `deps` à la registry | ✅ |

**Verdict 1.1** : aucune capture eager n'est aujourd'hui cassée. Deux
captures sont **structurellement fragiles** car séparées de leur source
par seulement 3-4 lignes dans `initialize()` et sans JSDoc de contrat :

- `LatencyCompensator.js:34` → `this.deviceManager = deps.deviceManager;`
- `CompensationService.js:36` → `this._lc = deps.latencyCompensator;`

Un réordonnancement futur (ex. déplacer `LatencyCompensator` avant
`DeviceManager` lors d'un refactor) ne ferait pas crasher : la Proxy
retournerait `undefined`, le champ se figerait à `null`, et toute
méthode l'utilisant lèverait un `TypeError` au premier message MIDI —
loin du site d'erreur réel.

### 1.2 Fallback silencieux dans le facade Proxy

`src/core/Application.js:141-156` :

```js
get(_, prop) {
  if (container.has(prop)) return container.resolve(prop);
  return self[prop];   // ← fallback sur l'instance Application
}
```

**Champs accessibles via fallback** : `_eventHandlers`, `_btBridge`,
`_shutdownHandlers`, `version`, `running` (lignes 100-117, 695).

**Un seul site utilisateur trouvé qui exploite involontairement le
fallback** : `src/midi/playback/commands/PlaybackAnalysisCommands.js:25-58`
écrit `app._suggestionCache` / `app._suggestionLock` **directement sur
le Proxy target** (l'objet `{}` qui est la cible du Proxy), pas sur
`Application`. Les lectures/écritures restent cohérentes tant que tout
le monde passe par la même façade `deps`, **mais** `Application._suggestionCache`
restera toujours `undefined`. C'est fonctionnellement correct mais
ambigu — recommander d'extraire dans un cache service nommé.

**Verdict 1.2** : pas de fuite réelle d'internals. Risque résiduel
d'écriture/lecture incohérente si un futur consommateur lit
`this.app._suggestionCache` au lieu de `deps._suggestionCache` (les
deux ne donneraient pas la même valeur).

### 1.3 Frontière orchestration / métier / API

- **`Application`** (748 l.) : composition root + lifecycle + EventBus
  bridging + shutdown handlers. La séparation est nette ; aucun handler
  métier n'a fui ici.
- **API layer** (`src/api/`) : `HttpServer`, `WebSocketServer`,
  `CommandHandler`, `CommandRegistry`. Auto-discovery des commandes
  centralisée → pas de carte de routage à maintenir.
- **Couches métier** (`src/midi/`, `src/files/`, `src/repositories/`,
  `src/persistence/`) : pas de référence cyclique détectée par grep.
  Les repositories sont des wrappers d'épaisseur ≈ 50 l. sur les
  table-managers (`src/persistence/tables/`).

**Verdict 1.3** : architecture saine, frontières respectées. Seul écart
notable : `PlaybackAnalysisCommands` utilise l'app facade comme magasin
d'état (cf. 1.2) — c'est un anti-pattern mineur.

---

## 2. Risques « god classes » & complexité

| Fichier | Lignes | Responsabilités | Observation |
|---|---|---|---|
| `src/midi/playback/MidiPlayer.js` | **2306** | Lifecycle player, scheduler, tempo map, seek, baker hooks, hand-CC injection, drum-remap fallback, EventBus emissions | Construit déjà un `PlaybackScheduler` séparé (l.156) et une `PlaybackStateMachine` (l.118). Découpage **partiellement fait**. Reste un noyau de ~1500 l. sur la même classe. |
| `src/persistence/Database.js` | **1036** | Migrations + CRUD routes + CRUD sessions + CRUD playlists + helpers | Délègue déjà à `src/persistence/tables/` selon CLAUDE.md, mais conserve des CRUD bruts (routes, sessions, …). Mélange de couches → cible naturelle de refactor par repository. |
| `src/core/Application.js` | **748** | Composition root + EventBus bridging + signal handlers + status snapshot | Acceptable pour une composition root ; pas de logique métier ici. |

Constat **B4 confirmé**. Cohérent avec
`docs/audit/AUDIT_GLOBAL_2026-05-17.md`, qui flagge déjà la taille de
MidiPlayer.

**Recommandation** : prioriser un split de `MidiPlayer.js` en
`MidiPlayerLifecycle` / `MidiPlayerEventBridge` / `MidiPlayerSeekEngine`
(le scheduler étant déjà extrait). Pas dans le scope DI de cette
branche.

---

## 3. Robustesse runtime & lifecycle

### 3.1 Transitions d'état playback

- `PlaybackStateMachine` (`MidiPlayer.js:118`) encapsule les transitions
  `STOPPED → PLAYING → PAUSED → SEEKING`.
- `tryTransition()` est appelé à chaque opération
  (`MidiPlayer.js:1052, 1159, 1186, 1217, 1309`).
- `seek()` (`MidiPlayer.js:1304`) clamp la position, passe en `SEEKING`,
  redémarre via `this.start()` (l.1331) si la lecture était active.

**Risque concurrentiel** : `seek()` n'est pas async-guarded ; deux
seeks rapides depuis le WS pourraient théoriquement entrer en
concurrence sur `currentEventIndex`. Aucun mutex visible. À vérifier
en charge ; tests `playback-scheduler-tickless.test.js` couvrent une
partie du problème.

### 3.2 Handlers SIGINT/SIGTERM/uncaught

`Application.setupShutdownHandlers()` (`Application.js:694-745`) :
- détache les handlers précédents avant d'en attacher de nouveaux (l.696-699) → idempotent ;
- garde un flag local `shuttingDown` (l.702) → pas de shutdown concurrent ;
- mappe SIGINT/SIGTERM/uncaughtException vers `stop()` ;
- `unhandledRejection` **n'arrête pas** le process (l.728-732) — choix
  documenté, raisonnable pour un serveur MIDI.

**Verdict 3.2** : conforme.

### 3.3 Services optionnels & états partiels

`Application.initialize()` utilise un `try/catch` autour de chaque
transport/lighting optionnel (l.266-309). En cas d'échec :
- aucun service n'est enregistré dans le container ;
- les consommateurs doivent utiliser `?.` (cf.
  `BluetoothEventBridge`, `wsServer?.broadcast`).

**Risque** : un service partiellement initialisé (ex. construit puis
`init()` qui throw) reste dans le container avec un état dégradé.
Aujourd'hui aucune méthode `init()` async post-constructeur n'est
exposée par les transports optionnels — donc OK.

---

## 4. Fiabilité temps réel MIDI / scheduling

Investigation hors scope DI mais **lecture rapide** :
- `PlaybackScheduler` (`src/midi/playback/PlaybackScheduler.js`)
  utilise un horizon "tickless" avec re-résolution lazy des
  dépendances temps-réel critiques (compensation, capability).
- `CompensationService` cache les compensations par couple route+device.
- Tempo map et conversion tick→temps : couverts par
  `tests/midi-transposer-*` et `tests/playback-scheduler-*`.

Pas de constat factuel ajouté à l'audit initial — investigation
poussée nécessite un benchmark réel (out of scope ici).

---

## 5. Persistance & migrations

### 5.1 Atomicité

`Database.runMigration()` (`Database.js:154-192`) :
- chaque migration s'exécute dans une transaction explicite
  (`BEGIN TRANSACTION` / `COMMIT` / `ROLLBACK` en cas d'erreur) ;
- insertion `INSERT OR IGNORE INTO schema_version` **dans** la
  transaction → atomicité réelle si le moteur SQLite respecte les
  transactions DDL (better-sqlite3 supporte les transactions sur DDL).

### 5.2 Branche « duplicate column name »

`Database.js:180-188` : si `ALTER TABLE ADD COLUMN` rejette parce que
la colonne existe déjà, la migration est **marquée appliquée** sans
ré-exécution. Le commentaire (l.173-179) justifie le cas via
`006_omni_mode.sql` (migration qui a été dupliquée historiquement avec
un numéro différent).

**Risque résiduel (drift schéma)** :
- Si une migration contient `ALTER TABLE … ADD COLUMN` ET `CREATE INDEX
  IF NOT EXISTS`, et que l'ALTER échoue en duplicate column, la suite
  du SQL **n'est pas rejouée** (ROLLBACK).
- Le commentaire affirme que `CREATE INDEX IF NOT EXISTS` reste sûr,
  **mais c'est faux** dans le cas où la migration ajoutait un *nouvel*
  index qui n'existait pas dans la version « pré-renommée » : on le
  marque appliqué sans avoir créé l'index.

**Recommandation** : isoler chaque opération DDL dans un `try { ALTER }
catch (dup) { /* skip */ }` plutôt que confier au global try/catch — ou
au minimum auditer les migrations 005/006/011 pour cette classe d'écart.

### 5.3 Alignement tables ↔ repositories

15 repositories sous `src/repositories/` ; 30 migrations dans
`migrations/` ; tables effectives dans `src/persistence/tables/` (non
listées ici). Pas d'écart visible au survol, mais une vérification
exhaustive sortirait du scope DI.

---

## 6. API WebSocket / contrat de commandes

### 6.1 Volume réel des commandes

| Métrique | Valeur |
|---|---|
| Modules `src/api/commands/*.js` | **24** (vs 15 dans doc) |
| Commandes registrées (grep `registry.register`) | **244** côté `src/api/commands/` + **23** côté `src/midi/playback/commands/` = **267** |
| Schémas définis (`*.schemas.js`) | **44** `export const` |
| **Couverture validation** | **44 / 267 ≈ 16 %** |

`JsonValidator.validateByCommand()` (`src/utils/JsonValidator.js:229-233`) :

```js
const compiled = COMPILED_SCHEMAS[command];
if (!compiled) return { valid: true, errors: [] };
```

**Toute commande sans schéma reçoit donc une validation permissive**
qui retourne `valid:true`. Les payloads non validés incluent par
exemple toutes les commandes `lighting_*` (38), `string_*` (15),
`instrument_settings_*` (11), `bluetooth_*` (9), `network_*` (4),
`virtual_*` / `session_*` / `bank_*` …

### 6.2 Standardisation erreurs

`CommandRegistry.handle()` (`src/api/CommandRegistry.js`) :
- `ApplicationError` subclasses (`ValidationError`, `NotFoundError`)
  → surface verbatim ;
- toute autre exception → masquée en `"Internal server error"`.

Conforme et propre.

### 6.3 Race startup commandes

`CommandHandler` (`src/api/CommandHandler.js:29`) :
```js
this._ready = this._init();   // construit dans le constructeur
…
async handle(message, ws) {
  await this._ready;          // gate toutes les requêtes
  return this.registry.handle(message, ws);
}
```

**Verdict 6.3** : race correctement traitée. Note : `this._init()` est
*lancée* dans le constructeur sans `await`, donc si l'import dynamique
d'un module de commande **throw synchrone**, la rejection est attachée
à `_ready` et propagée à la première `handle()`. Pas d'unhandled
rejection.

---

## 7. Sécurité

### 7.1 Token API

`src/infrastructure/auth/ApiTokenManager.js:33-60` génère un token
aléatoire `randomBytes(32).toString('hex')` à la première exécution
si `GMBOOP_API_TOKEN` est absent, et l'écrit dans `.env`.

**Problèmes** :
- **Pas de `chmod 0600`** après `writeFileSync` (l.47, 49, 52) → le
  fichier `.env` hérite de l'umask du process (souvent `0644`,
  lisible par tout utilisateur local).
- Le token est **loggé en `info`** indirectement via le chemin (l.59 :
  `API token auto-generated and saved to ${envPath}`) — pas le token
  lui-même, OK.
- Aucune rotation automatique.
- `.env` est dans `.gitignore` (vérifié ligne `*.env` côté git), donc
  pas de fuite VCS.

**Recommandation prioritaire** :
```js
writeFileSync(envPath, …, 'utf8');
chmodSync(envPath, 0o600);
```

### 7.2 Bypass d'authentification

**Côté HTTP** (`src/api/HttpServer.js:142-200`) :
1. `/api/health` et `/api/update-status` → toujours publics (l.146).
2. `Sec-Fetch-Site: same-origin` → bypass (l.160).
3. Origin loopback ou même host que `req.hostname` → bypass (l.163-173).
4. IP privée (RFC1918, link-local, loopback, IPv6 ULA) → bypass
   (`isPrivateClient(req)`, l.183).
5. Sinon : token bearer obligatoire.

**Côté WebSocket** (`src/api/WebSocketServer.js:129-188`) :
1. Origin matche Host (loopback + port) → bypass.
2. Sinon : token via query string OR `sec-websocket-protocol`.

**Risques** :
- **WS token via query string** → loggué dans les access logs HTTP de
  l'upgrade. À mitiger en préférant `sec-websocket-protocol`.
- **HTTP bypass `isPrivateClient`** : sur une box exposée via tunnel
  (Tailscale/ZeroTier/cloudflared) avec source IP réécrite, un
  attaquant peut potentiellement obtenir une IP RFC1918 côté serveur.
  À documenter.
- **`sec-fetch-site` bypass** : tous les navigateurs modernes le
  posent ; un attaquant ne le contrôle pas en XHR, mais un client
  non-navigateur peut le falsifier — la défense de l'auteur (« il aura
  juste à inclure le token aussi ») est valable seulement si le token
  est connu, ce qui contredit l'objet du bypass.

### 7.3 Routes publiques

`/api/health` est documenté public (CLAUDE.md). `/api/update-status`
l'est aussi mais non documenté — à mentionner explicitement.

---

## 8. Frontend temps réel & audio

### 8.1 Dual timer

L'audit signalait un « dual timer setInterval + requestAnimationFrame ».
Grep résultats :
- `setInterval` dans le frontend : **6 sites** seulement, tous
  domain-spécifiques (toast warning, tuner no-signal, bow retrigger,
  loop editor metronome, recording timer, ISM check).
- `requestAnimationFrame` : utilisé largement (≈ 25 sites) pour
  layout/animations.
- **Pas de combo setInterval + rAF redondant** trouvé sur la même vue.

**Verdict 8.1** : le constat initial est à reformuler. Le seul site
critique en CPU sur Pi3 est `KeyboardChords.js:541`
(`_bowRetriggerInterval`) — à profiler séparément.

### 8.2 Nettoyage timers

Non audité ligne à ligne ici. Les vues qui clearent leurs intervals
exposent `destroy()` ou `_cleanup()` ; la base `BaseView` impose une
convention. Hors scope DI.

### 8.3 Reconnect WS & requêtes pending

`BackendAPIClient` (`public/js/api/`) est testé
(`tests/frontend/backend-api-client-binary.test.js`). Comportement
détaillé non audité ici.

---

## 9. Qualité code / standards

- ESM cohérent (`"type": "module"`, imports relatifs avec `.js`).
- `JSDoc` présent sur la quasi-totalité des modules core (`Application`,
  `CommandRegistry`, `Database`, `MidiPlayer`).
- `ApplicationError` hiérarchie sous `src/core/errors/`.
- **8 TODO/FIXME** dans `src/` (acceptable, tous tracés vers `TODO.md`).
- **140 fichiers de tests** (95 backend + 45 frontend) — couverture
  significative sur scheduler, transposer, hand-position, migrations.

---

## 10. Tooling / CI

### 10.1 Lint (B2)

`.eslintrc.json` est un **format legacy ESLint 7-8 valide**. ESLint 9
exigerait un `eslint.config.js`. Le `package.json` épingle
`"eslint": "^8.55.0"`, donc le format est correct **si les
dépendances sont installées**.

Le message d'erreur observé `npm run lint` → « eslint.config.* not
found » est obtenu uniquement si :
- soit `node_modules/` est vide (cas actuel : `ls node_modules` →
  0 entrées) → bin `eslint` non résolu, npm tombe sur une autre
  installation système (probablement ESLint 9+) ;
- soit une version d'ESLint 9 a été installée via une autre voie.

**Conclusion B2** : pas de drift de config dans le repo. Faux positif
environnemental. À reproduire après `npm install --ignore-scripts`.

### 10.2 Vitest (B1)

Confirmé : `node_modules/.bin/vitest` n'existe pas dans l'environnement
audité car `node_modules` est vide. `vitest` est correctement déclaré
en `devDependencies` (^4.1.1). Run nécessite `npm install
--ignore-scripts`.

### 10.3 Jest (compatibilité native)

`jest.config.cjs` probe `better-sqlite3` au démarrage et **skip**
automatiquement les suites SQLite si bindings absents — pattern
documenté dans CLAUDE.md.

### 10.4 « CI lint+test »

Aucun workflow `.github/workflows/` audité ici. À vérifier
explicitement si la promesse documentaire est tenue.

---

## Annexe A — Détail des constats DI critiques

### A.1 LatencyCompensator — capture eager fragile

```js
// src/midi/adaptation/LatencyCompensator.js:32-35
this.logger = deps.logger;
this.database = deps.database;
this.deviceManager = deps.deviceManager;   // ← eager, deviceManager registered 3 lignes plus haut
this.eventBus = deps.eventBus;
```

Source dépendante : `Application.js:234` (`deviceManager`) →
`Application.js:237` (`latencyCompensator`). Marge : 3 lignes.

**Mitigation déjà en place** : un getter lazy pour `wsServer` (l.39-42),
mais pas pour `deviceManager`.

### A.2 CompensationService — capture eager fragile

```js
// src/midi/compensation/CompensationService.js:34-38
this.database = deps.database;
this._lc = deps.latencyCompensator;        // ← eager
this.eventBus = deps.eventBus;
this.logger = deps.logger;
```

Source dépendante : `Application.js:237` → `Application.js:241`.
Marge : 4 lignes.

### A.3 Patterns « gold standard » à conserver

- `PlaybackScheduler.js:49-77` — getters lazy `wsServer`,
  `compensationService`, `capabilityResolver`, `eventLoopMonitor` +
  JSDoc explicite (l.60-65).
- `FileManager.js:31-42` — 4 getters lazy + commentaire latence.
- `WebSocketServer.js:77-85` — proxy interne pour
  `eventLoopMonitor.currentLag`.
- `MidiClockGenerator.js:39-56` — getters lazy + commentaire de
  contrat.

### A.4 Site singulier — facade utilisée comme store

`src/midi/playback/commands/PlaybackAnalysisCommands.js:25-58` lit/écrit
`app._suggestionCache` et `app._suggestionLock` sur la facade Proxy.
Les mutations restent sur le target `{}` du Proxy et sont invisibles
depuis `Application.instance._suggestionCache`. Fonctionnel mais
ambigu — extraire dans un `SuggestionCacheService` enregistré dans le
container serait plus propre.

---

## Annexe B — Liste exhaustive des modules de commandes (B5)

24 modules sous `src/api/commands/` :

```
BankEffectsCommands.js (4)         LightingCommands.js (38)
BluetoothCommands.js (9)           LoopArrangementCommands.js (11)
DeviceCommands.js (8)              LoopCommands.js (5)
DeviceSettingsCommands.js (2)      MidiCommands.js (8)
FileCommands.js (21)               NetworkCommands.js (4)
HotspotCommands.js (10)            PlaybackCommands.js (agrégateur, 23 via sous-modules)
InstrumentLightCommands.js (6)     PlaylistCommands.js (15)
InstrumentSettingsCommands.js (11) PresetCommands.js (6)
InstrumentVoiceCommands.js (5)     RoutingCommands.js (21)
LatencyCommands.js (16)            SerialCommands.js (6)
                                   SessionCommands.js (6)
                                   StringInstrumentCommands.js (15)
                                   SystemCommands.js (10)
                                   VirtualInstrumentCommands.js (7)
```

Total = **267 commandes** registrées (244 directes + 23 via
`PlaybackCommands`).

Pour conformité doc : mettre à jour `docs/ARCHITECTURE.md:20` et
`docs/ARCHITECTURE.md:61` (« 15 modules » → « 24 modules / 267 commandes »).

---

## Annexe C — Couverture schemas par fichier

| Fichier schemas | Schémas exportés |
|---|---|
| `device.schemas.js` | 7 |
| `file.schemas.js` | 5 |
| `hotspot.schemas.js` | 3 |
| `latency.schemas.js` | 4 |
| `loop.schemas.js` | 15 |
| `playback.schemas.js` | 3 |
| `routing.schemas.js` | 8 |
| `system.schemas.js` | 1 |
| **Total** | **46** (les 2 helpers `requireRouteId`/`requireDeviceId` sont réutilisés) |

Modules de commandes **sans schemas du tout** :
- `BankEffectsCommands` (4 commandes)
- `BluetoothCommands` (9)
- `InstrumentLightCommands` (6)
- `InstrumentSettingsCommands` (11)
- `InstrumentVoiceCommands` (5)
- `LightingCommands` (38) ← le plus gros gap
- `MidiCommands` (8)
- `NetworkCommands` (4)
- `PresetCommands` (6)
- `SerialCommands` (6)
- `SessionCommands` (6)
- `StringInstrumentCommands` (15)
- `VirtualInstrumentCommands` (7)

**Priorité de couverture** : `LightingCommands`, `MidiCommands`,
`InstrumentSettingsCommands` (impact UI direct).

---

## Recommandations classées

### Urgentes (sécurité / fiabilité)

1. **`chmod 0600` sur `.env`** après écriture du token
   (`src/infrastructure/auth/ApiTokenManager.js:47, 49, 52`).
2. **Schémas pour `LightingCommands` et `MidiCommands`** au minimum —
   couvrir les commandes qui acceptent payloads structurés
   (channel/note/CC).

### Élevées (résilience refactor)

3. **JSDoc de contrat** sur `LatencyCompensator.js:34` et
   `CompensationService.js:36` — documenter explicitement que la
   capture eager nécessite l'ordre actuel d'`Application.initialize()`.
4. **Convertir** les deux captures eager ci-dessus en **getters lazy**
   (alignement sur le pattern PlaybackScheduler).
5. **Migration `Database.js:154-192`** : transformer le try/catch
   global en isolation par opération DDL pour éviter qu'un CREATE
   INDEX soit silencieusement skippé.

### Moyennes (dette documentaire / code)

6. Mettre à jour `docs/ARCHITECTURE.md:20, 61` (« 15 modules » → 24).
7. Extraire `PlaybackAnalysisCommands._suggestionCache` dans un
   service dédié enregistré dans le container.
8. Splitter `MidiPlayer.js` (2306 l.) — extraction
   `MidiPlayerSeekEngine` + `MidiPlayerEventBridge`.

### Basses (qualité / outillage)

9. Reproduire les constats B1/B2 en CI propre (`npm install
   --ignore-scripts && npm run lint && npm run test:frontend`) et les
   classer fermés s'ils ne reproduisent plus.
10. Documenter `/api/update-status` comme route publique dans
    `CLAUDE.md`.

---

## Annexe D — Méthode de reproduction

```bash
# Constat B1
ls node_modules/.bin/vitest 2>&1 || echo "vitest absent"

# Constat B2 (faux positif si node_modules vide)
npm install --ignore-scripts
npm run lint -- --max-warnings 0

# Constat B4
wc -l src/midi/playback/MidiPlayer.js \
       src/persistence/Database.js \
       src/core/Application.js

# Constat B5
ls src/api/commands/*.js | wc -l
grep -rh "registry\.register(" src/api/commands/ src/midi/playback/commands/ \
  | grep -oE "'[a-z_]+'" | sort -u | wc -l

# Couverture schemas
grep -h "^export const " src/api/commands/schemas/*.js \
  | grep -v "LOOP_CONSTRAINTS" | wc -l
```

---

*Rapport produit le 2026-05-21 sur la branche
`claude/audit-di-dependencies-lVbQE`. Aucun code applicatif modifié.*
