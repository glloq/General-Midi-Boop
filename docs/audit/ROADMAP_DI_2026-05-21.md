# Roadmap — Résolution complète de l'audit DI 2026-05-21

> **Source** : `docs/audit/AUDIT_DI_DEPENDENCIES_2026-05-21.md`
>
> **Branche d'origine** : `claude/audit-di-dependencies-lVbQE`
>
> **Découpage** : 5 PRs thématiques, chacun sur une branche dédiée,
> mergeables indépendamment (sauf dépendance signalée). Format
> `Constat / Plan / Effort / Done` aligné sur `TODO.md`.
>
> **Cible globale mesurable** :
> - Couverture schémas WS : **44 / 267 → 267 / 267 (100 %)**
> - 0 capture eager DI fragile non documentée
> - `MidiPlayer.js` < 1500 lignes (vs 2306)
> - `chmod 0600` confirmé sur `.env`
> - Doc d'architecture alignée sur **24 modules / 267 commandes**

---

## Suivi global

| PR | Thème | Branche | Effort | Dépendances | Risque |
|---|---|---|---|---|---|
| 1 | Sécurité | `claude/audit-fix-security` | 0,5 j | — | Faible |
| 2 | DI hardening | `claude/audit-di-hardening` | 1 j | — | Faible |
| 3 | Schemas WS (267) | `claude/audit-schemas-coverage` | 3-5 j | PR 2 (cache service) | Moyen |
| 4 | Refactor god classes | `claude/audit-refactor-storage-midiplayer` | 2-3 j | — | Élevé |
| 5 | Doc & CI | `claude/audit-doc-ci` | 1 j | PR 1-4 mergés | Faible |

Total : **~8-11 jours-personne**. PR 1, 2 et le démarrage de PR 5
peuvent être parallélisés.

---

## PR 1 — Sécurité (urgence)

**Branche** : `claude/audit-fix-security`

### Constat

- `src/infrastructure/auth/ApiTokenManager.js:33-60` écrit le token API
  bearer en clair dans `.env` sans restreindre les permissions du
  fichier → un compte local non-privilégié peut lire le token (umask
  par défaut = `0644`).
- `/api/update-status` est exposé sans auth (cf.
  `src/api/HttpServer.js:146`) mais **n'est pas documenté** comme
  public dans `CLAUDE.md` / `docs/ARCHITECTURE.md`.
- Le token WS peut être passé en query string (`?token=…`), qui finit
  dans les access logs des serveurs intermédiaires
  (`src/api/WebSocketServer.js:164-165`).

### Plan

1. **Restreindre `.env`** (Bloquant).
   - Importer `chmodSync` depuis `fs` dans
     `src/infrastructure/auth/ApiTokenManager.js`.
   - Appeler `chmodSync(envPath, 0o600)` après chacun des trois
     `writeFileSync` / `appendFileSync` (`l.47, 49, 52`).
   - Logger un warning si `chmodSync` échoue (Windows-compat).
2. **Documenter `/api/update-status`** comme route publique :
   - dans `CLAUDE.md` (section *Configuration*) ;
   - dans `docs/ARCHITECTURE.md` (bloc auth).
3. **Préférer `sec-websocket-protocol` au `?token=…`** dans le SPA.
   - Côté client : `public/js/api/BackendAPIClient.js` (recherche
     d'usage `?token=`), passer le token en sous-protocole WS.
   - Côté serveur : ordre de fallback inchangé (déjà supporté à
     `WebSocketServer.js:164-165`).
   - Conserver le query-string pour rétro-compat, mais émettre un
     `logger.warn` quand utilisé.
4. **(Optionnel)** Détecter une IP RFC1918 incohérente avec
   `X-Forwarded-For` public (signal d'un tunnel) et logger un warning
   sans casser le bypass. Fichier : `src/api/HttpServer.js:175-185`.

### Tests

- Créer `tests/api-token-manager.test.js` :
  - mocker `fs` (`writeFileSync`, `appendFileSync`, `chmodSync`) ;
  - vérifier que `chmodSync` est appelé avec `(envPath, 0o600)` dans
    les 3 branches (`.env` absent / `.env` présent sans token / `.env`
    présent avec ancien token).
- Test E2E manuel : `stat -c '%a' .env` doit retourner `600` après
  démarrage à blanc.

### Done

- [ ] `tests/api-token-manager.test.js` vert.
- [ ] `npm start` sur installation fraîche produit `.env` avec mode
      `0600`.
- [ ] `CLAUDE.md` et `docs/ARCHITECTURE.md` mentionnent
      `/api/update-status` comme route publique.

**Effort** : 0,5 jour.

---

## PR 2 — DI hardening

**Branche** : `claude/audit-di-hardening`

### Constat

- Deux captures `this.X = deps.X` séparées de leur source dans
  `Application.initialize()` par 3-4 lignes seulement → ré-ordonnancement
  futur silencieusement cassant.
  - `LatencyCompensator.js:34` (capture `deviceManager`)
  - `CompensationService.js:36` (capture `latencyCompensator`)
- `PlaybackAnalysisCommands.js:25-58` écrit `app._suggestionCache` /
  `app._suggestionLock` sur la cible du Proxy `deps` (pas sur
  l'instance Application) → fonctionnel mais ambigu.

### Plan

1. **Convertir LatencyCompensator** au pattern lazy getter (cf.
   `src/midi/playback/PlaybackScheduler.js:69-77`) :
   ```js
   constructor(deps) {
     this._deps = deps;
     this.logger = deps.logger;
     this.database = deps.database;
     this.eventBus = deps.eventBus;
     Object.defineProperty(this, 'deviceManager', {
       get: () => this._deps.deviceManager || null
     });
   }
   ```
2. **Convertir CompensationService** identiquement pour `_lc`.
3. **JSDoc « DEPENDENCY-ORDER CONTRACT »** au-dessus de chaque
   constructeur converti — préciser que les déps lazy sont
   éventuellement late-bound, que la capture eager freezerait
   `undefined`.
4. **Extraire SuggestionCacheService** :
   - Créer `src/midi/playback/SuggestionCacheService.js` exposant
     `get(file)`, `set(file, suggestions)`, `withLock(file, fn)`.
   - Enregistrer dans `Application.initialize()` après
     `autoAssigner` (l.313+), avant `commandHandler` (l.374).
   - Remplacer `app._suggestionCache` / `app._suggestionLock` par
     `app.suggestionCacheService.X` dans
     `src/midi/playback/commands/PlaybackAnalysisCommands.js:25-58`.

### Tests

- Créer `tests/application-di-late-binding.test.js` (pattern repris de
  `tests/playback-scheduler-late-bound-deps.test.js`) :
  - construit `LatencyCompensator(deps)` avec un container vide ;
  - enregistre `deviceManager` *après* la construction ;
  - appelle une méthode qui lit `this.deviceManager` → doit voir
    l'instance.
- Idem pour `CompensationService.latencyCompensator`.
- `tests/suggestion-cache-service.test.js` : get/set/withLock unitaires.

### Done

- [ ] `grep -n "deps\.deviceManager" src/midi/adaptation/LatencyCompensator.js`
      ne retourne plus que la définition du getter.
- [ ] `tests/application-di-late-binding.test.js` vert.
- [ ] `PlaybackAnalysisCommands.js` ne référence plus `app._suggestion*`.
- [ ] Aucune régression sur `tests/playback-*` existants.

**Effort** : 1 jour.

---

## PR 3 — Couverture schémas WS (267 commandes)

**Branche** : `claude/audit-schemas-coverage`

**Dépendance** : PR 2 (extraction `SuggestionCacheService`) souhaitable
mais pas bloquante.

### Constat

- 267 commandes WebSocket registrées, seulement **44 ont un schéma**
  → 223 commandes acceptent n'importe quel payload.
- `JsonValidator.validateByCommand` (`src/utils/JsonValidator.js:229-233`)
  retourne `{valid:true, errors:[]}` par défaut quand le schéma manque.
- Modules sans aucun schéma : `LightingCommands` (38), `StringInstrument`
  (15), `InstrumentSettings` (11), `Bluetooth` (9), `Midi` (8),
  `VirtualInstrument` (7), `Preset` (6), `Serial` (6), `Session` (6),
  `InstrumentLight` (6), `InstrumentVoice` (5), `BankEffects` (4),
  `Network` (4).

### Plan

1. **Inventaire** → `docs/audit/COMMANDS_INVENTORY_2026-05-21.md` :
   ```bash
   grep -rh "registry\.register(" src/api/commands/ src/midi/playback/commands/ \
     | grep -oE "'[a-z_]+'" | sort -u
   ```
   Lister les 267 commandes avec leur module d'origine et leur
   schéma (✅ / ❌).
2. **Helpers réutilisables** — créer
   `src/api/commands/schemas/_helpers.schemas.js` :
   - extraire `requireRouteId`, `requireDeviceId`, `requireFileId` ;
   - ajouter `requireInstrumentId`, `requirePresetId`, `requireSessionId`,
     `requirePlaylistId`, `requireLightingProfileId`,
     `requireLoopId`, `requireArrangementId`.
3. **13 nouveaux fichiers** sous `src/api/commands/schemas/` :
   - `bank_effects.schemas.js` (4)
   - `bluetooth.schemas.js` (9)
   - `instrument_light.schemas.js` (6)
   - `instrument_settings.schemas.js` (11)
   - `instrument_voice.schemas.js` (5)
   - `lighting.schemas.js` (38) ← plus gros
   - `midi.schemas.js` (8)
   - `network.schemas.js` (4)
   - `preset.schemas.js` (6)
   - `serial.schemas.js` (6)
   - `session.schemas.js` (6)
   - `string_instrument.schemas.js` (15)
   - `virtual_instrument.schemas.js` (7)
4. **Étendre schémas existants** pour combler les trous dans
   `playback.schemas.js`, `routing.schemas.js`, `loop.schemas.js`,
   `file.schemas.js`, `latency.schemas.js`, `device.schemas.js`,
   `hotspot.schemas.js`, `system.schemas.js` (commandes ajoutées
   après le dernier audit).
5. **Wirer dans `JsonValidator`** :
   - `src/utils/JsonValidator.js:12-19` → ajouter 13 imports ;
   - étendre la boucle de compilation `COMPILED_SCHEMAS` (l.27-40).

### Tests

- Un fichier `tests/schema-<module>.test.js` par nouveau fichier
  schemas (13 nouveaux + 8 existants à enrichir).
- Pattern canonique : `tests/schema-compiler.test.js`.
- Chaque test couvre, par commande : 1 cas valide + ≥ 1 cas invalide
  (champ manquant, type incorrect, hors range).
- Mise à jour de `tests/command-registry.test.js` : vérifier que toute
  commande registrée a un schéma compilé.

### Done

- [ ] `grep -h "^export const " src/api/commands/schemas/*.js | grep -v LOOP_CONSTRAINTS | wc -l` ≥ 267.
- [ ] `node scripts/check-schema-coverage.js` (ajouté en PR 5) vert.
- [ ] `npm test -- tests/schema-*.test.js` vert.

**Effort** : 3-5 jours.

---

## PR 4 — Refactor god classes & persistance

**Branche** : `claude/audit-refactor-storage-midiplayer`

### Constat

- `src/midi/playback/MidiPlayer.js` : **2306 lignes**, contient
  lifecycle + seek + EventBus + drum-remap + hand-CC injection.
- `src/persistence/Database.js:154-192` : la branche
  « duplicate column name » marque la migration comme appliquée et
  *avorte la suite du SQL* — un `CREATE INDEX IF NOT EXISTS` placé
  après un `ALTER TABLE` rejeté ne sera jamais exécuté.
- `src/persistence/Database.js` : **1036 lignes**, mélange migrations +
  CRUD routes/sessions/playlists/files alors que les table-managers
  existent déjà dans `src/persistence/tables/`.

### Plan

1. **Migrations — isolation par statement DDL**.
   - `src/persistence/Database.js:154-192` : décomposer le SQL au `;`
     (en respectant les chaînes / triggers), exécuter chaque statement
     dans un `try { exec } catch (dup) { logger.warn; continue }`
     interne, et ne plus rollback la transaction sur duplicate-column.
   - Garder un rollback global pour toute autre erreur SQL.
   - Test : `tests/migrations-duplicate-column-isolation.test.js`
     crée un schéma avec une colonne déjà présente, vérifie que le
     `CREATE INDEX` qui suit est bel et bien exécuté.
2. **Split MidiPlayer**.
   - Extraire `MidiPlayerSeekEngine` (`seek()`, `findEventIndexAtTime`,
     reset de routing counters, `_resetSplitRoutingState` si présent)
     dans `src/midi/playback/MidiPlayerSeekEngine.js`.
   - Extraire `MidiPlayerEventBridge` (toutes les émissions
     `eventBus.emit('playback_*', …)` et appels
     `wsServer.broadcast(...)`) dans
     `src/midi/playback/MidiPlayerEventBridge.js`.
   - `MidiPlayer.js` doit rester l'API publique inchangée : les tests
     `tests/midi-player-*.test.js` ne sont **pas modifiés**.
   - Cible : `MidiPlayer.js` < 1500 lignes.
3. **(Optionnel, PR 4-bis si trop gros)** Split `Database.js` :
   déplacer routes / sessions / playlists vers
   `src/persistence/tables/RoutesTable.js`, `SessionsTable.js`,
   `PlaylistsTable.js` ; `Database` ne garde que la lifecycle, les
   migrations, et la composition des table-managers.

### Tests

- `tests/midi-player-*.test.js` (existants) restent verts sans
  modification.
- `tests/midi-player-seek-engine.test.js` (nouveau) : tests unitaires
  du module extrait.
- `tests/migrations-duplicate-column-isolation.test.js` (nouveau).

### Done

- [ ] `wc -l src/midi/playback/MidiPlayer.js` < 1500.
- [ ] Toutes les suites `tests/midi-player-*.test.js` vertes.
- [ ] `tests/migrations-*` vertes.

**Effort** : 2-3 jours (sans split Database) ; +1-2 j pour Database.

---

## PR 5 — Documentation & CI

**Branche** : `claude/audit-doc-ci`

**Dépendance** : à mener une fois PR 1-4 mergés (ou en parallèle pour
les volets purement doc).

### Constat

- `docs/ARCHITECTURE.md:20, 61` indique « 15 modules » alors qu'il y
  en a 24.
- Pas de garde-fou CI sur la couverture schemas WS.
- B1 (vitest absent) et B2 (ESLint config) restent ouverts dans le
  rapport d'audit en attente de vérification CI.

### Plan

1. **Doc** :
   - Mettre à jour `docs/ARCHITECTURE.md:20, 61` (24 modules / 267
     commandes).
   - Mettre à jour `CLAUDE.md` section *Architecture / Command pattern*.
   - Ajouter en bas de `docs/audit/AUDIT_DI_DEPENDENCIES_2026-05-21.md`
     une section **Statut final** marquant B1/B2 comme fermés après
     reprod en CI propre.
2. **CI**.
   - Ajouter `.github/workflows/ci.yml` (si absent) ou ajuster celui
     existant pour exécuter, sur push et PR :
     - `npm ci --ignore-scripts`
     - `npm run lint -- --max-warnings 0`
     - `npm test`
     - `npm run test:frontend`
     - `npm run typecheck`
     - `node scripts/check-schema-coverage.js`
3. **Coverage script** : `scripts/check-schema-coverage.js`.
   - Lit toutes les commandes registrées via une discovery similaire
     à `CommandRegistry.loadCommandModules()`.
   - Lit toutes les clés exportées par
     `src/api/commands/schemas/*.schemas.js`.
   - Échoue (`process.exit(1)`) si une commande registrée n'a pas de
     schéma. Output : liste des manquants.

### Tests

- `tests/check-schema-coverage.test.js` : exécute le script en mode
  programmatique sur un dataset minimal, vérifie qu'il détecte un
  manquant injecté.

### Done

- [ ] CI verte sur PR et `main` (4 jobs + coverage).
- [ ] `scripts/check-schema-coverage.js` retourne 0.
- [ ] `docs/ARCHITECTURE.md` aligné.
- [ ] Section *Statut final* ajoutée au rapport d'audit.

**Effort** : 1 jour.

---

## Critère global de done

```bash
# Sanity
npm ci --ignore-scripts

# Lint
npm run lint -- --max-warnings 0

# Tests
npm test
npm run test:frontend
npm run typecheck

# Audit-specific
node scripts/check-schema-coverage.js
stat -c '%a' .env                              # → 600

# Vérifications structurelles
wc -l src/midi/playback/MidiPlayer.js           # < 1500
grep -c "deps\.deviceManager" src/midi/adaptation/LatencyCompensator.js  # ≤ 1 (le getter)
grep -h "^export const " src/api/commands/schemas/*.js | \
  grep -v LOOP_CONSTRAINTS | wc -l              # ≥ 267
```

Tout vert ⇒ audit clos.

---

## Patterns réutilisés (référence)

- **Lazy getter DI** : `src/midi/playback/PlaybackScheduler.js:69-77`.
- **Lazy getter avec proxy interne** :
  `src/api/WebSocketServer.js:77-85`.
- **Test late-bound deps** :
  `tests/playback-scheduler-late-bound-deps.test.js`.
- **Schema declaration + compilation** : `tests/schema-compiler.test.js`
  + `src/utils/JsonValidator.js:27-40`.
- **Helpers schémas existants** : `requireRouteId` /
  `requireDeviceId` dans `device.schemas.js` et `routing.schemas.js`.
- **Format de roadmap** : sections `Constat / Plan / Done / Effort`
  cf. `TODO.md`.

---

## Annexe — Inventaire des modules de commandes (à produire en PR 3)

L'inventaire complet (267 commandes) sera produit dans
`docs/audit/COMMANDS_INVENTORY_2026-05-21.md` lors de PR 3. Tableau
récapitulatif actuel :

| Module | # commandes | # schemas | Gap |
|---|---|---|---|
| BankEffects | 4 | 0 | 4 |
| Bluetooth | 9 | 0 | 9 |
| Device | 8 | 7 | 1 |
| DeviceSettings | 2 | 0 | 2 |
| File | 21 | 5 | 16 |
| Hotspot | 10 | 3 | 7 |
| InstrumentLight | 6 | 0 | 6 |
| InstrumentSettings | 11 | 0 | 11 |
| InstrumentVoice | 5 | 0 | 5 |
| Latency | 16 | 4 | 12 |
| Lighting | 38 | 0 | 38 |
| LoopArrangement | 11 | 11 | 0 |
| Loop | 5 | 4 | 1 |
| Midi | 8 | 0 | 8 |
| Network | 4 | 0 | 4 |
| Playback (agrégateur) | 23 | 3 | 20 |
| Playlist | 15 | 0 | 15 |
| Preset | 6 | 0 | 6 |
| Routing | 21 | 8 | 13 |
| Serial | 6 | 0 | 6 |
| Session | 6 | 0 | 6 |
| StringInstrument | 15 | 0 | 15 |
| System | 10 | 1 | 9 |
| VirtualInstrument | 7 | 0 | 7 |
| **Total** | **267** | **46** | **221** |

*(Les schemas réutilisés ailleurs — `requireRouteId`, etc. — sont
comptés une seule fois côté `# schemas` ; la couverture réelle est
proche de 44 commandes uniques.)*

---

*Roadmap rédigée le 2026-05-21, branche
`claude/audit-di-dependencies-lVbQE`. Aucun code applicatif modifié
par ce livrable.*
