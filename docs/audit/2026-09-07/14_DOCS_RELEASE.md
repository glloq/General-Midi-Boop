# 14 — Docs ↔ code, release, licences, reproductibilité (lot L14)

**Date :** 2026-09-07 · **Commit de départ :** `b86b34a` (L00) · **Version manifeste :** 0.8.1
**Sections d'audit couvertes :** BC, BD, BP, BQ, BR, BS, BT
**Périmètre :** audit seul. **Aucune doc, aucun fichier partagé n'a été modifié** —
tous les correctifs sont proposés sous forme de diffs, à appliquer en vague 2.
**Findings émis :** F-156 → F-163.

---

## 0. Synthèse

| § | Sujet | Section | État | Niveau | Finding |
|---|---|---|---|---|---|
| 1 | `docs/API.md` ↔ handlers (couverture + exactitude) | BD | **FAIL** | 4 | F-159 |
| 2 | `docs/ARCHITECTURE.md` / `CLAUDE.md` / ADR ↔ arbre réel | BC | **PARTIAL** | 4 | F-159 |
| 3 | Versionnement, `CHANGELOG.md`, tags, procédure de release | BQ | **FAIL** | 4 | F-161 |
| 4 | Code mort (F-09 + au-delà) | BC | **FAIL** | 4 | F-163 |
| 4b | Dépendances `package.json` ↔ imports réels | BR | **FAIL** | 5 | **F-156** |
| 5 | CI `.github/workflows/ci.yml` | BP | **PARTIAL** | 4 | F-162 |
| 5b | F-17 (`format:check` rouge sur `main`) | BP | ✅ **CORRIGÉ** *(confirmé)* | 5 | — |
| 6 | Licences : projet, dépendances runtime, **assets** | BS | **FAIL** | 4 | **F-158** |
| 7 | Reproductibilité du build (`npm run build`, lockfile) | BR | **PARTIAL** | 4 | F-157 |
| 7b | Packaging Docker | BR | **FAIL** | **5** | **F-157** |
| 8 | Cohérence `wiki/` ↔ `docs/` ↔ code | BC | **FAIL** | 4 | F-160 |
| — | BT (régression matérielle) | BT | **HW REQUIRED** | — | → L15 |

**Findings par sévérité : 3 P1 · 4 P2 · 1 P3.**

| # | Sév | Titre | Preuve la plus courte |
|---|---|---|---|
| **F-156** | **P1** | Le driver d'éclairage **MQTT** est promis par `README.md`, le wiki (×4) et l'UI, mais sa dépendance `mqtt` **n'est déclarée nulle part** → il ne peut fonctionner sur aucune installation | `src/lighting/MqttLightDriver.js:22` `await import('mqtt')` · `mqtt` absent de `package.json` et de `node_modules/` |
| **F-157** | **P1** | Le packaging est cassé : `docker build` **échoue** (`COPY locales/` inexistant), l'image n'embarque pas `shared/` (crash au boot), et `dist/` ne contient pas `lib/` → le vendoring offline de WebAudioFontPlayer est annulé en production | `docker build` → `"/locales": not found` (sortie §7.3) |
| **F-158** | **P1** | Licences : **aucun fichier `LICENSE`** pour un projet annoncé MIT · **61 SVG livrés viennent de SVG Repo** sans licence ni attribution tracée · `assets/sf2/README.md` affirme deux choses fausses (vérification SHA-256, dépôt du texte de licence) | `ls LICENSE*` → absent · `grep -rl svgrepo public/assets \| wc -l` → 61 · `grep -i sha scripts/install-default-sf2.js` → vide |
| **F-159** | P2 | `docs/API.md` ↔ code : **83/270 commandes non documentées** (7 familles entières à 0 %), 3 en-têtes de comptage faux, 4 commandes implémentées annoncées « *(planned)* », 2 commandes annoncées « non consommées par la SPA » alors qu'elles le sont, payloads incomplets sur des paramètres **destructifs** ; + `ARCHITECTURE.md` / `CLAUDE.md` / ADR-003 / `.env.example` périmés | §1, §2 |
| **F-160** | P2 | `wiki/API-Reference.md` **invente 17 commandes qui n'existent pas**, documente une trame d'erreur et une trame d'événement fausses, et un contrat d'enregistrement de commande faux (repris dans `wiki/Contributing.md`) ; **15 des 32 images référencées sont manquantes** | §8 |
| **F-161** | P2 | Versionnement incohérent et **aucun processus de release** : `package.json` jamais bumpé (0.8.1), `CHANGELOG.md` annonce `[0.8.2]` et n'a pas bougé depuis **226 commits** (33 `feat`, 51 `fix`), **zéro tag git**, aucune procédure écrite, `update.sh` tire la pointe de `main` | §3 |
| **F-162** | P2 | CI : aucun ratchet de couverture (ni `collectCoverageFrom` ni `coverageThreshold`), aucun ratchet de contrat WS, porte `npm audit` à `critical` qui laisse passer **3 advisories `high`** toutes corrigeables sans rupture, pas de build Docker, pas d'E2E, pas de contrôle de licences | §5 |
| **F-163** | P3 | Code mort au-delà de F-09 : `MidiMessage.js` (467 l.), **`mapColorToFixture` = capacité DMX morte**, 4 fonctions exportées jamais appelées, 12 `export` superflus, table `instrument_light_config` (25 colonnes) morte, 7 colonnes obsolètes | §4 |

---

## 1. `docs/API.md` ↔ code

### 1.1 Couverture : 187/270 (69,3 %) — le chiffre est bon, la méthode aussi

Le `69,3 %` de `command-inventory.mjs` repose sur un regex permissif
(`` `mot` `` n'importe où dans `API.md`). J'ai vérifié qu'il ne surestime pas :

```
$ node -e "…"   # cf. §Reproduction
table rows total: 200 of which registered commands: 186
loose backtick tokens matching registered commands: 187
counted documented by tool but NOT in a table row (1): playlist_status
```

**186 commandes sont documentées dans une vraie ligne de tableau** ; une
seule (`playlist_status`) n'est citée qu'en prose. Les 14 lignes de tableau
restantes décrivent des **événements**, pas des commandes — c'est légitime.
Le chiffre de la baseline est donc **fiable** et l'écart est bien de **83**.

### 1.2 La liste des 83 commandes non documentées

`°` = **également sans schéma de payload** (double trou : ni doc, ni validation).

| Module | Non doc. / total | Commandes non documentées |
|---|---|---|
| `LoopArrangementCommands.js` | **11** / 11 | `arrangement_add_block`, `arrangement_add_track`, `arrangement_create`, `arrangement_delete`, `arrangement_delete_block`, `arrangement_delete_track`, `arrangement_get`, `arrangement_list` °, `arrangement_update`, `arrangement_update_block`, `arrangement_update_track` |
| `HotspotCommands.js` | **10** / 10 | `hotspot_disable` °, `hotspot_enable` °, `hotspot_get_config` °, `hotspot_status` °, `hotspot_update_config`, `wifi_connect`, `wifi_disconnect` °, `wifi_forget`, `wifi_list_saved` °, `wifi_scan` ° |
| `PlaylistCommands.js` | **10** / 15 | `playlist_clear` °, `playlist_get` °, `playlist_next` °, `playlist_previous` °, `playlist_remove_file` °, `playlist_reorder` °, `playlist_set_loop` °, `playlist_start` °, `playlist_stop` °, `playlist_update_settings` ° |
| `LatencyCommands.js` | **6** / 16 | `calibrate_monitor_start` °, `calibrate_monitor_stop` °, `calibrate_preview_note` °, `tuner_list_instruments` °, `tuner_monitor_start` °, `tuner_monitor_stop` ° |
| `FileCommands.js` | **6** / 23 | `file_bake_cc` °, `file_folders_get` °, `file_folders_set`, `file_reanalyze_check` °, `file_tempo_map` °, `file_text_events` ° |
| `InstrumentLightCommands.js` | **6** / 6 | `instrument_light_all_off` °, `instrument_light_get` °, `instrument_light_list` °, `instrument_light_set` °, `instrument_light_set_supported` °, `instrument_light_test` ° |
| `InstrumentVoiceCommands.js` | **5** / 5 | `instrument_voice_create` °, `instrument_voice_delete` °, `instrument_voice_list` °, `instrument_voice_replace` °, `instrument_voice_update` ° |
| `LoopCommands.js` | **5** / 5 | `loop_create`, `loop_delete`, `loop_get`, `loop_list` °, `loop_update` |
| `BankEffectsCommands.js` | **4** / 4 | `bank_effects_get`, `bank_effects_list`, `bank_effects_reset`, `bank_effects_update` |
| `RoutingCommands.js` | **4** / 21 | `monitor_start_all` °, `monitor_stop_all` °, `routing_save_hand_overrides` °, `validate_routing_feasibility` ° |
| `InstrumentSettingsCommands.js` | **3** / 11 | `instrument_save_all` °, `instrument_type_detect` °, `instrument_types_list` ° |
| `DeviceSettingsCommands.js` | **2** / 2 | `device_get_settings` °, `device_update_settings` ° |
| `LightingCommands.js` | **2** / 38 | `lighting_get_enabled` °, `lighting_set_enabled` ° |
| `…/PlaybackRoutingCommands.js` | **2** / 6 | `playback_set_disconnect_policy` °, `playback_validate_routing` ° |
| `PresetCommands.js` | **2** / 6 | `preset_export`, `preset_rename` |
| `MidiCommands.js` | **1** / 8 | `midi_clock_toggle` |
| `StringInstrumentCommands.js` | **1** / 15 | `string_instrument_get_scale_length_presets` ° |
| `DeviceCommands.js` | **1** / 8 | `sysex_identity_request` ° |
| `SystemCommands.js` | **1** / 11 | `system_reboot` ° |
| `VirtualInstrumentCommands.js` | **1** / 7 | `virtual_instrument_toggle` ° |

**Total 83** · dont **58 sans schéma** · **69 jamais citées dans un test** ·
**55 cumulent les trois trous** (ni doc, ni schéma, ni test).

**Sept familles entières sont documentées à 0 %** — ce ne sont pas des
oublis à la marge, ce sont des pans fonctionnels invisibles :
`LoopArrangementCommands` (11), `HotspotCommands` (10),
`InstrumentLightCommands` (6), `InstrumentVoiceCommands` (5),
`LoopCommands` (5), `BankEffectsCommands` (4), `DeviceSettingsCommands` (2)
— **43 commandes**. Le Loop Manager et l'Arrangeur, mis en avant dans le
wiki (`Interface-Loop-Manager.md`, 11 589 octets), n'ont **aucune** de leurs
16 commandes dans `docs/API.md`.

**Deux cas à traiter en priorité, indépendamment du volume :**
- `system_reboot` — **redémarre la machine**, non documentée **et** sans schéma.
- `hotspot_*` / `wifi_*` — 10 commandes qui reconfigurent le réseau du Pi,
  8 sans schéma, 0 documentée, 0 testée.

### 1.3 Exactitude : échantillon de 24 commandes documentées vs handler réel

> Une doc fausse est pire qu'une doc absente. J'ai comparé le payload
> **documenté** au payload **réellement lu par le handler** sur 24 commandes
> tirées de 12 modules différents.

| Commande | Payload documenté (`API.md`) | Payload réel (handler) | Verdict |
|---|---|---|---|
| `playback_set_tempo` | *(planned)* | `{bpm?\|tempo?}` — **implémenté**, clamp [0,25×…4×], resync MIDI Clock (`PlaybackControlCommands.js:206`) | **FAIL** |
| `playback_transpose` | *(planned)* | `{semitones}` — **implémenté** (`:225`) | **FAIL** |
| `playback_set_volume` | *(planned)* | `{volume}` 0-127, broadcast CC #7 tous canaux (`:245`) | **FAIL** |
| `system_restore` | *(planned)* | `{path}` **obligatoire**, restaure la base puis `process.exit(0)` (`SystemCommands.js:647`) | **FAIL** |
| `system_logs` | `data?` | `{lines?}` entier, plafonné à `LOG_TAIL_MAX_LINES` (`:702`) | **FAIL** |
| `playlist_add_file` | `playlistId`, « file data » | `{playlistId, midiId, position?}` — **`midiId` est obligatoire** et invisible dans la doc (`PlaylistCommands.js:81`) | **FAIL** |
| `apply_assignments` | `originalFileId`, `assignments`, `createAdaptedFile?` | + **`overwriteOriginal`** (écrase le fichier source !) non documenté (`PlaybackAssignmentCommands.js:134`) | **FAIL** |
| `session_load` | `sessionId` | + **`dryRun?`** — bascule prévisualisation / mutation, non documenté (`SessionCommands.js:84`) | **PARTIAL** |
| `generate_assignment_suggestions` | `fileId`, `topN?`, `minScore?` | + `excludeVirtual?`, `includeMatrix?` (`PlaybackAnalysisCommands.js:256`) | **PARTIAL** |
| `calibrate_delay` | `deviceId`, `channel`, « options » | `threshold` (0,01-0,10), `alsaDevice`, `measurements` (1-20) — bornes nulle part (`LatencyCommands.js:176`) | **PARTIAL** |
| `route_create` | « Route config » | passé **tel quel** à `midiRouter.addRoute(data)`, aucun champ nommé (`RoutingCommands.js:39`) | **PARTIAL** |
| `file_filter` | « Multiple filter criteria » | 20 critères nommés (`FileCommands.js:190-215`) | **PARTIAL** |
| `file_list` | `folder?` (défaut `/`) | idem (`FileCommands.js:41`) | PASS |
| `midi_send_note` | `deviceId`,`channel`,`note`,`velocity`,`duration?` | idem, `velocity:0` ⇒ noteoff (`MidiCommands.js:61`) | PASS |
| `playback_seek` | `position` | idem (`:168`) | PASS |
| `playback_set_channel_routing` | `channel`,`deviceId`,`targetChannel?` | idem + bornes 0-15 (`PlaybackRoutingCommands.js:34`) | PASS |
| `network_connect` | `ip`/`address`, `port?` | idem, défaut `'5004'` (`NetworkCommands.js:72`) | PASS |
| `serial_open` | `path`,`name?`,`direction?` | idem, défaut `'both'` (`SerialCommands.js:64`) | PASS |
| `ble_scan_start` | `duration?` (5 s), `filter?` | idem (`BluetoothCommands.js:48`) | PASS |
| `latency_measure` | `deviceId`, `iterations?` | idem, borné 1-50 (`LatencyCommands.js:54`) | PASS |
| `device_set_properties` | `deviceId`, properties | idem (`DeviceCommands.js:168`) | PASS |
| `preset_save` | `name`,`description`,`type`,`data` | idem, `type` défaut `'routing'` (`PresetCommands.js:19`) | PASS |
| `session_save` | `name`, `description` | idem (`SessionCommands.js:28`) | PASS |
| `lighting_master_dimmer` | `value?` | idem (0-255 non dit) (`LightingCommands.js:403`) | PASS |

**Bilan de l'échantillon : 12 PASS · 5 PARTIAL · 7 FAIL — soit 50 % de doc
exacte.** Extrapolé aux 186 commandes documentées, cela veut dire que la
« couverture documentaire » réelle est bien inférieure à 69,3 %.

Les 7 FAIL se répartissent en deux classes, et la seconde est la dangereuse :

1. **Fonctionnalité niée** — 4 commandes pleinement implémentées sont
   annoncées « *(planned)* ». `playback_set_tempo`, `playback_transpose` et
   `playback_set_volume` sont trois contrôles de performance live, et
   `system_restore` est la **restauration de sauvegarde**. Un intégrateur
   lisant `API.md` conclut que la restauration n'existe pas.
2. **Paramètre destructif masqué** — `apply_assignments` accepte
   `overwriteOriginal: true` qui **écrase le fichier MIDI source** ;
   `playlist_add_file` cache un `midiId` obligatoire derrière « file data ».

### 1.4 En-têtes de comptage faux

| Ligne | Annonce | Réel |
|---|---|---|
| `docs/API.md:33` | `## Commands (146 total)` | **186** lignes de tableau, **270** commandes enregistrées |
| `docs/API.md:61` | `### MIDI Messages (8 commands)` | 7 lignes |
| `docs/API.md:245` | `### Lighting (35 commands)` | 36 lignes |

### 1.5 La section « API surface not consumed by the bundled SPA » est fausse

`docs/API.md:126-147` affirme que certaines commandes ne sont appelées par
aucun frontend. Deux sont démenties par le code :

```
public/js/features/LoopManagerOutputRouter.js:103   sendCommand('midi_panic', …)
public/js/features/LoopManagerOutputRouter.js:132   sendCommand('midi_panic', …)
public/js/features/midi-editor/MidiEditorInfoModal.js:151   sendCommand('file_channels', …)
```

- « `midi_panic` — no emergency-stop button wired in the SPA » → **faux**, le
  Loop Manager l'appelle deux fois.
- « `file_channels`, `playlist_status` — diagnostic queries, no UI surface »
  → **faux pour `file_channels`** (modale d'info de l'éditeur MIDI).

En revanche les 10 `route_*`, les 8 `latency_*` et les 6 `preset_*` sont bien
à 0 appel frontend : cette partie de la section tient. **À recroiser avec L01
et L13** (123 commandes sur 270 sans appelant frontend).

### 1.6 Correctifs proposés — `docs/API.md`

```diff
-## Commands (146 total)
+## Commands (270 registered · 186 documented below)
+
+> Le décompte est vérifié en CI par `node scripts/audit/ratchet.mjs`
+> (cf. `.github/workflows/ci.yml`, job `contract`).
```

```diff
-### MIDI Messages (8 commands)
+### MIDI Messages (8 commands)
 …
 | `midi_reset` | MIDI System Reset | `deviceId` |
+| `midi_clock_toggle` | Start/stop the MIDI Clock generator | `enabled` |
```

```diff
-### Lighting (35 commands)
+### Lighting (38 commands)
 …
+| `lighting_get_enabled` | Read the lighting master switch | — |
+| `lighting_set_enabled` | Toggle the lighting master switch | `enabled` |
```

```diff
-| `playback_set_tempo` | Set tempo | *(planned)* |
-| `playback_transpose` | Transpose | *(planned)* |
-| `playback_set_volume` | Set volume | *(planned)* |
+| `playback_set_tempo` | Live tempo change (rate multiplier, clamped to 0.25×–4×, resyncs the MIDI Clock) | `bpm` (or legacy `tempo`) |
+| `playback_transpose` | Live global transposition in semitones, non-destructive; 0 clears | `semitones` |
+| `playback_set_volume` | Broadcast CC #7 on all 16 channels of every connected output | `volume` (0–127, clamped) |
```

```diff
-| `system_restore` | Restore from backup | *(planned)* |
+| `system_restore` | Restore the DB from a file in `backups/`, then exit(0) so the supervisor restarts. Requires `GMBOOP_API_TOKEN` to be configured. | `path` (basename only; `..` and dot-files rejected) |
-| `system_logs` | Get recent logs | `data?` |
+| `system_logs` | Tail the active log file | `lines?` (default 200, capped at `LOG_TAIL_MAX_LINES`) |
+| `system_reboot` | **Reboot the host machine.** Requires `GMBOOP_API_TOKEN`. | — |
```

```diff
-| `playlist_add_file` | Add file to playlist | `playlistId`, file data |
+| `playlist_add_file` | Add a MIDI file to a playlist | `playlistId`, `midiId`, `position?` |
```

```diff
-| `apply_assignments` | Apply auto-assignments | `originalFileId`, `assignments`, `createAdaptedFile?` |
+| `apply_assignments` | Apply auto-assignments | `originalFileId`, `assignments`, `createAdaptedFile?` (default `true`), **`overwriteOriginal?`** (default `false` — **`true` rewrites the source file in place**) |
```

```diff
-| `session_load` | Load session | `sessionId` |
+| `session_load` | Load a session and restore its routing table | `sessionId`, `dryRun?` (`true` = preview only, no mutation) |
```

```diff
-| `generate_assignment_suggestions` | Auto-assignment suggestions | `fileId`, `topN?`, `minScore?` |
+| `generate_assignment_suggestions` | Auto-assignment suggestions | `fileId`, `topN?` (5), `minScore?` (30), `excludeVirtual?`, `includeMatrix?` |
-| `calibrate_delay` | Calibrate delay | `deviceId`, `channel`, options |
+| `calibrate_delay` | Microphone-based delay calibration | `deviceId`, `channel` (0–15), `threshold?` (0.01–0.10), `measurements?` (1–20), `alsaDevice?` |
```

```diff
 ### API surface not consumed by the bundled SPA
 …
-- `midi_panic` — no emergency-stop button wired in the SPA.
 …
-- `file_channels`, `playlist_status` — diagnostic queries, no UI surface.
+- `playlist_status` — diagnostic query, no UI surface.
+
+> Vérifié le 2026-09-07 : `midi_panic` (LoopManagerOutputRouter.js) et
+> `file_channels` (MidiEditorInfoModal.js) **sont** appelés par la SPA et ont
+> été retirés de cette liste.
```

Et **ajouter les 83 commandes manquantes** (§1.2). L'ordre d'attaque
recommandé, par risque décroissant : `SystemCommands` (`system_reboot`) →
`HotspotCommands` (10) → `InstrumentLightCommands` (6) →
`LoopArrangementCommands` (11) → `LoopCommands` (5) → `PlaylistCommands` (10)
→ le reste.

Enfin, **`docs/API.md` ne documente aucune trame d'erreur.** À ajouter
(la vraie forme, cf. §8.2) :

```diff
+### Error frame (server → client)
+
+```json
+{ "id": "abc-123", "type": "error", "command": "file_read",
+  "error": "File 42 not found", "code": "NOT_FOUND", "timestamp": 1234567890 }
+```
+
+`error` est une **chaîne**. `code` n'est présent que pour les
+`ApplicationError` (`src/core/errors/`) ; toute autre exception est masquée
+en `"Internal server error"` sans `code`. La trame du rate-limiter
+(`WebSocketServer.js:313`) ne porte **pas** d'`id` — cf. F-06 (lot L01).
```

---

## 2. `docs/ARCHITECTURE.md` — l'ampleur réelle de l'écart

### 2.1 Le procès instruit par `CLAUDE.md` est… périmé lui-même

`CLAUDE.md:129-132` affirme :

> `docs/ARCHITECTURE.md` predates the `managers/`→`transports/` and
> `views/components/`→`features/` renames — trust the actual tree and this
> file over it.

**C'est faux à HEAD.** Les deux renommages sont déjà intégrés :

```
docs/ARCHITECTURE.md:88   │   ├── transports/   # Optional service managers (renamed from managers/)
docs/ARCHITECTURE.md:106  │   │   ├── features/  # Feature modules (keyboard, midi-editor, loop, …)
```

Et `docs/V0.9_ROADMAP.md:407` (tâche **T8.6, cochée**) le confirme :

> `views/components/`→`features/` corrigé dans l'arbre ARCHITECTURE.md
> (le renommage `managers/`→`transports/` y était déjà annoté).

**Le document périmé est donc `CLAUDE.md`, pas `ARCHITECTURE.md`.** C'est le
cas d'école : la doc *sur* la doc dérive plus vite que la doc. Mais cela
n'exonère pas `ARCHITECTURE.md`, qui porte **9 écarts mesurés** :

### 2.2 Écarts mesurés dans `docs/ARCHITECTURE.md`

| # | Ligne | Affirmation | Réel | Grav. |
|---|---|---|---|---|
| 1 | `:112-115` | « Each module exports `{ commands: { commandName: handler } }` » | **Contrat faux.** Chaque module exporte `register(registry, app)` qui appelle `registry.register('nom', handler)` (cf. `src/api/commands/*.js`, `CommandRegistry.js:102`). Un contributeur suivant cette doc écrit un module qui ne s'enregistre pas. | **haute** |
| 2 | `:112` | Exemple `{ command: "getDevices" }` | Aucune commande `getDevices` — la convention est `snake_case` (`device_list`) | moyenne |
| 3 | `:20-21` | « 24 modules, 267 commands » | **270** commandes, **28** modules (24 dans `src/api/commands/` + 4 dans `src/midi/playback/commands/`) | moyenne |
| 4 | `:60`, `:64` | idem dans l'arbre (`24 command modules (267 commands)`) | idem | moyenne |
| 5 | `:193-196` | « ≈ 44 schemas vs 267 registered commands » | **86** schémas / **270** commandes, répartis sur **14** fichiers `*.schemas.js` | moyenne |
| 6 | `:180-182` | Migrations « applied at startup inside a **single** transaction » | **Contredit `CLAUDE.md`** : chaque fichier a **sa propre** transaction (un échec au fichier N garde 1..N-1 committés) | **haute** |
| 7 | `:106` | `midi-editor/ (20 files)` | **35** fichiers | basse |
| 8 | `:94-99`, `:107` | Arbre `src/midi/` : `devices, routing, playback, adaptation, messages, files` | Réel : + **`adapters/`, `compensation/`, `gm/`, `instrument/`, `ports/`** — 5 sous-modules absents | moyenne |
| 9 | `:70-...` | Arbre `src/` | **`src/infrastructure/` (auth, events, monitoring) et `src/system/` totalement absents** ; `src/api/` omet `WsOutputQueue.js`, `apiRoutes.js`, `sf2Routes.js`, `wafProxyRoutes.js`, `middleware/` ; `public/js/i18n/` absent ; **`shared/` (5 fichiers, dont `BinaryFrameCodec.js` importé par `src/api/WsOutputQueue.js:29`) totalement absent** | moyenne |

Deux points annexes : `src/lighting/` liste 7 drivers, il y en a **8**
(`GpioLedDriver.js` et `SerialLedDriver.js` manquants, `BaseLightingDriver.js`
et `DmxFixtureProfiles.js` aussi) ; et l'entrée `src/core/` apparaît **deux
fois** dans l'arbre (`:71` puis `:120`).

### 2.3 Chemins morts dans l'ensemble des docs actives

Balayage mécanique (`scripts` en §Reproduction) de tous les `.md` hors
`docs/audit/` : **25 chemins cités qui n'existent plus**, sur 14 fichiers.

| Fichier | Chemins morts |
|---|---|
| `docs/MIDI_EDITOR.md` | `public/js/views/components/midi-editor/` (L4, L118), `public/js/views/components` (L61) — **`public/js/views/` n'existe pas**, c'est `public/js/features/midi-editor/` (35 fichiers) |
| `docs/piano-virtual-modal.md` | `public/js/features/keyboard/KeyboardMidi.js`, `KeyboardDevices.js`, `HandsOverlay.js`, `KeyboardModalTemplate.js` (4 fichiers disparus ; le répertoire réel n'en contient que 16) |
| `docs/SLIDER_CORDES_ARCHITECTURE.md` | `public/js/features/keyboard/KeyboardModal.js`, `public/html/keyboard-modal.html`, `public/css/keyboard.css` (les deux derniers répertoires n'existent pas) |
| `docs/MIDI_CC_INSTRUMENT_CONTROLS.md` | `src/constants.js` (réel : `src/core/constants.js`) |
| `docs/REFACTORING.md` | `tests/compensation-service.test.js` |
| `docs/adr/ADR-004…` | `src/api/commands/playback/`, `docs/WS_CONTRACT.md` |
| `wiki/API-Reference.md` | `tests/unit/` (**n'a jamais existé**) |
| `INSTRUMENT_FAMILY_REFACTOR_ROADMAP.md` | `public/js/lighting/` |
| `TODO.md` | `public/lib/webaudio-pianoroll-custom.js` |
| `CLAUDE.md` | `tests/frontend/path/to.test.js` *(exemple générique — faux positif)* |
| `docs/adr/ADR-001…` | `src/storage/`, `src/domain/`, `src/infra/`, `src/application/` *(options **rejetées** dans l'ADR — faux positifs légitimes)* |

### 2.4 ADR-003 documente une décision qui n'a pas été appliquée

`docs/adr/ADR-003-ws-contract-versioning.md:51` retient **l'option B**
(suffixe `_vN` sur le nom de commande) et rejette explicitement l'option A
(champ `version` dans l'enveloppe). Le code fait **l'inverse** :

```
src/api/CommandRegistry.js:10   Handler lookup (versioned handlers take priority when the client sends `version`)
src/api/CommandRegistry.js:138  @param {Object} message - Parsed WS frame `{id, command, version?, data?}`
```

Et **zéro commande `_vN` n'est enregistrée** (0/270). L'ADR décrit donc une
architecture qui n'existe pas, tandis que le mécanisme réellement implémenté
n'est décrit dans aucun ADR. → **à recroiser avec L01** (comportement d'une
`version` inconnue / régressive).

### 2.5 `.env.example` n'est pas exhaustif, alors que deux docs le promettent

`docs/ARCHITECTURE.md:189` et `CLAUDE.md:107` affirment tous deux
« See `.env.example` for all supported variables ». **8 variables `GMBOOP_*`
lues par le code n'y figurent pas** :

| Variable | Lue par | Enjeu |
|---|---|---|
| `GMBOOP_SSL_CERT` | `src/core/Config.js:121` | **HTTPS** — comment activer TLS est indocumenté |
| `GMBOOP_SSL_KEY` | `src/core/Config.js:122` | idem |
| `GMBOOP_API_TOKEN_BACKUP` | rotation de token | **sécurité** |
| `GMBOOP_SF2_URL` | `scripts/install-default-sf2.js:40` | **chaîne d'approvisionnement** — c'est le levier qui permet de pointer un miroir de confiance (mitigation F-15) |
| `GMBOOP_WAF_PLAYER_URL` | `scripts/install-default-sf2.js:64` | idem |
| `GMBOOP_SF2_CACHE_MAX_BYTES` | `src/core/Config.js:123` | mémoire (Pi) |
| `GMBOOP_SF2_CACHE_MAX_ENTRIES` | `src/core/Config.js:124` | idem |
| `GMBOOP_UPDATE_DETACHED` | `scripts/update.sh` | mise à jour |

Aucune variable documentée n'est morte (0 dans l'autre sens).

### 2.6 Plan de remise à niveau proposé

**Ne pas réécrire `ARCHITECTURE.md` : le rendre vérifiable.** Trois vagues :

1. **Corrections factuelles** (30 min, sans risque) — les 9 écarts de §2.2 +
   les 25 chemins de §2.3 + les 8 variables de §2.5. Diffs prêts ci-dessous.
2. **Retirer de la doc tout chiffre qui n'est pas généré** — les décomptes
   (`267 commands`, `44 schemas`, `20 files`, `146 total`) dérivent
   mécaniquement. Soit on les supprime, soit on les fait vérifier par le
   ratchet CI de §5.
3. **Faire porter la vérification par la CI** — un job `docs` qui échoue si
   un chemin cité dans un `.md` actif n'existe pas (le script de §2.3 tient
   en 25 lignes) et si un compteur diverge.

Diffs pour les deux écarts de gravité **haute** :

```diff
--- a/docs/ARCHITECTURE.md
+++ b/docs/ARCHITECTURE.md
@@ ### Command Pattern
 All client-server communication flows through the Command pattern:
-1. Client sends JSON via WebSocket: `{ command: "getDevices", id: "abc123" }`
+1. Client sends JSON via WebSocket: `{ id: "abc123", command: "device_list", version?, data? }`
 2. `CommandRegistry` auto-discovers modules in `src/api/commands/`
-3. Each module exports `{ commands: { commandName: handler } }`
-4. Response sent back with matching `id` for correlation
+3. Each module exports `register(registry, app)` and binds its handlers with
+   `registry.register('command_name', handler)` — there is **no** central map
+   to edit and **no** `{ commands: {…} }` export.
+4. Payload validated by `JsonValidator.validateByCommand` (schemas precompiled
+   from `src/api/commands/schemas/*.schemas.js`), then the handler runs and the
+   response is correlated by `id`.
```

```diff
-  migrations land as additional numbered files and are applied at startup
-  inside a single transaction.
+  migrations land as additional numbered files and are applied at startup in
+  numeric order, **each inside its own transaction**: a failure at file N
+  leaves 1..N-1 committed and the next boot retries from N.
```

```diff
-│  │ + Auth        │  │ (24 modules,     │
-│  │              │  │  267 commands)   │
+│  │ + Auth        │  │ (28 modules,     │
+│  │              │  │  270 commands)   │
@@
-│   │   └── commands/          # 24 command modules (267 commands)
+│   │   ├── commands/          # 24 modules (+4 in src/midi/playback/commands/)
+│   │   ├── WsOutputQueue.js   # backpressure + binary frames
+│   │   ├── apiRoutes.js · sf2Routes.js · wafProxyRoutes.js
+│   │   └── middleware/        # captivePortal
@@
 │   │   ├── adaptation/        # Auto-assigner, matcher, transposer, drums
+│   │   ├── adapters/          # BLE adapters (Noble, in-memory)
+│   │   ├── compensation/      # CompensationService
+│   │   ├── gm/                # InstrumentFamilies
+│   │   ├── instrument/        # CapabilityResolver, Descriptor{Protocol,Service}
+│   │   ├── ports/             # BluetoothPort
 │   │   ├── messages/          # MIDI message constructors/parsers
+├── shared/                    # Shared with the SPA: BinaryFrameCodec.js +
+│                              # the canonical GM JSON tables
+├── src/infrastructure/        # auth/, events/, monitoring/
+├── src/system/                # HotspotManager.js
@@
-  `src/api/commands/schemas/*.schemas.js`. Coverage is **partial** (≈ 44
-  schemas vs 267 registered commands); commands without a schema receive a
+  `src/api/commands/schemas/*.schemas.js` (14 files). Coverage is **partial**
+  (**86 schemas for 270 registered commands, 31.9 %**); commands without a schema receive a
```

Et pour `CLAUDE.md` (le paragraphe qui accuse à tort `ARCHITECTURE.md`) :

```diff
-- `docs/` holds feature docs and ADRs (`docs/adr/`); `docs/ARCHITECTURE.md`
-  predates the `managers/`→`transports/` and `views/components/`→`features/`
-  renames — trust the actual tree and this file over it.
+- `docs/` holds feature docs and ADRs (`docs/adr/`). `docs/ARCHITECTURE.md`
+  carries both renames (`managers/`→`transports/`, `views/components/`→
+  `features/`) since V0.9_ROADMAP T8.6, but its per-directory counts drift —
+  trust the actual tree over any number in a doc.
+  `docs/MIDI_EDITOR.md` and `docs/piano-virtual-modal.md` still cite the old
+  `public/js/views/components/` layout (audit L14, F-159).
+- ADR-003 retained `_vN` command suffixes; the code implements the *rejected*
+  option (a `version` field in the envelope) and no `_vN` handler exists.
```

---

## 3. Versionnement, `CHANGELOG.md`, tags, release — qui a raison ?

### 3.1 Les faits

| Source | Version annoncée | Preuve |
|---|---|---|
| `package.json:3` | **0.8.1** | — |
| `package-lock.json:3,9` | **0.8.1** | cohérent avec le manifeste |
| `/api/health`, `/api/metrics` | **0.8.1** | `src/api/apiRoutes.js:33` → `pkg.version` |
| `CHANGELOG.md:5` | **`## [0.8.2] - 2026-05-17`** | entrée la plus récente |
| `wiki/Home.md:7` | « beta (**v0.8.2**) » | — |
| `docs/V0.9_ROADMAP.md:3` | « Base : **v0.8.2** (`package.json` : 0.8.1) » | constate l'écart sans le résoudre |
| **Tags git** | **aucun** | `git tag -l` → vide |

```
$ git log -S'"version": "0.8.2"' --oneline -- package.json
(vide)
```

**Verdict : personne n'a raison, mais `package.json` fait foi.** La v0.8.2 a
été *écrite* (CHANGELOG, wiki, roadmap) mais **jamais publiée** : le bump du
manifeste n'a pas eu lieu, aucun tag n'a été posé. Le runtime, lui, annonce
0.8.1 — un opérateur qui lit `/api/health` sur scène obtient un numéro qui
ne correspond à aucune entrée exacte du CHANGELOG.

### 3.2 Le `CHANGELOG.md` n'est pas « en retard », il est abandonné

```
$ git log --oneline -1 -- CHANGELOG.md
50f3e8c  (2026-05-20)
$ git rev-list --count 50f3e8c..HEAD
226
$ git log --format='%s' 50f3e8c..HEAD | sed -E 's/^([a-z]+).*/\1/' | sort | uniq -c
   51 fix        33 feat       25 docs        4 refactor
    4 perf        3 style       3 audit       1 test
```

**226 commits depuis la dernière ligne du CHANGELOG, dont 33 `feat` et
51 `fix`, sur presque 4 mois.** Aucun n'y figure. Or plusieurs sont des
fonctionnalités majeures livrées depuis : `tHtml()`, les arrangements de
boucles, la gestion multi-`program` de l'éditeur MIDI, 6 campagnes i18n,
le pipeline de descripteurs v2.

### 3.3 Il n'existe aucune procédure de release

Recherche exhaustive (`release process`, `npm version`, `git tag`) dans
`*.md`, `*.yml`, `*.sh` : **aucun résultat** hors documents d'audit.
Ni `RELEASE.md`, ni job de release dans la CI, ni GitHub Release.
`CONTRIBUTING.md` ne mentionne pas le sujet.

Le mécanisme de mise à jour réel est `scripts/update.sh`, qui fait :

```
scripts/update.sh:308   CURRENT_BRANCH=$(git branch --show-current)
scripts/update.sh:327   git checkout main
scripts/update.sh:~340  git pull
```

**Un utilisateur qui « met à jour » récupère donc la pointe de `main`**,
c'est-à-dire un état non tagué, non testé en tant que release, éventuellement
au milieu d'une fusion. C'est le point le plus lourd du §BQ.

### 3.4 Règle de versionnement proposée

> **`package.json` est la seule source de vérité de la version.** Tout le
> reste (CHANGELOG, wiki, `/api/health`) en dérive ou la cite.

1. **SemVer 0.x** — tant que la v1 n'est pas atteinte : `0.MINOR.PATCH`,
   `MINOR` pour toute fonctionnalité ou rupture de contrat WS, `PATCH` pour
   les corrections. Cohérent avec l'historique (0.7.0 → 0.8.0 → 0.8.1).
2. **Une release = un tag = une entrée CHANGELOG = un commit de bump.**
   Le commit de bump est le seul à toucher `package.json`/`package-lock.json`
   et `CHANGELOG.md`, et il est immédiatement tagué `vX.Y.Z`.
3. **`CHANGELOG.md` tenu en continu** avec une section `## [Unreleased]` en
   tête, alimentée à chaque PR `feat`/`fix`/`perf` (dérivable des messages de
   commit conventionnels, déjà respectés à 96 %).
4. **`scripts/update.sh` bascule sur le dernier tag** par défaut
   (`git fetch --tags && git checkout $(git describe --tags --abbrev=0 origin/main)`),
   `UPDATE_TYPE=beta` conservant le comportement actuel « pointe de `main` ».
5. **La CI vérifie la cohérence** : job `version` qui échoue si le tag poussé
   ≠ `v$(node -p 'require("./package.json").version')`, ou si `CHANGELOG.md`
   ne contient pas d'entrée pour cette version.

### 3.5 Correctif immédiat proposé (vague 2)

Le contenu de `[0.8.2]` **est** livré depuis mai ; ce qui manque est le bump
et 226 commits de journal. Le plus honnête :

```diff
--- a/package.json
+++ b/package.json
-  "version": "0.8.1",
+  "version": "0.8.2",
```
```diff
--- a/package-lock.json
-  "version": "0.8.1",          (×2 : racine et packages[""])
+  "version": "0.8.2",
```
```diff
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
 All notable changes to Général Midi Boop are documented in this file.
+
+## [Unreleased]
+
+> ⚠️ Les 226 commits mergés entre le 2026-05-20 et le 2026-09-07 (33 `feat`,
+> 51 `fix`) n'ont **pas** été journalisés au fil de l'eau. Cette section les
+> rattrape ; à partir de la v0.9 elle est alimentée à chaque PR.
+
+### Added
+- `tHtml()` — traduction échappant le HTML pour les puits `innerHTML` (a4c831d)
+- Éditeur MIDI : détection, préservation et découpe des canaux multi-`program` (ff71480)
+- Arrangements de boucles (`arrangement_*`, 11 commandes WS)
+- Pipeline de descripteurs v2 (SysEx bloc 0x10 + cache, migration 033)
+
+### Fixed
+- Éditeur MIDI : DoS/validation sur chemin de sauvegarde non fiable, aftertouch,
+  XSS, cycle de vie (ec691f4)
+- Cœur : validateur d'upload imposé, purge des logs à l'arrêt, fuite d'unsub
+  `BaseView` (e2e9aa7)
+- Adaptation : baker O(n²) (a4a7315)
+
+### i18n
+- it, de, es, vi, id, tl : ~800 chaînes traduites (4ab2570, bfc8c2f, a518011,
+  9a01739, f51bcbd)
+
+*(liste à compléter à partir de `git log 50f3e8c..HEAD`)*

 ## [0.8.2] - 2026-05-17
```

Puis, une fois la vague 2 close : `git tag -a v0.9.0 -m "…"` — **le premier
tag du dépôt.**

---

## 4. Code mort

### 4.1 F-09 — `src/midi/messages/MidiMessage.js` : **CONFIRMÉ, suppression sûre**

```
$ node scripts/audit/dead-modules.mjs
Unreferenced modules: 1 (468 lines)
    468 lines  src/midi/messages/MidiMessage.js
$ wc -l src/midi/messages/MidiMessage.js
467
```

Vérifié quatre fois plutôt que trois :

1. **Aucun import statique** — `grep -rn "messages/MidiMessage\|from '.*MidiMessage.js'\|require(.*MidiMessage"` sur tout le dépôt : 1 seul résultat, l'en-tête `@file` du fichier lui-même.
2. **Aucun import dynamique ne peut l'atteindre.** Les deux seuls `import()` à spécificateur variable sont
   `src/api/CommandRegistry.js:102` (balaie `src/api/commands/*.js`) et
   `src/lighting/LightingManager.js:152` (table `DRIVER_MAP` de `src/lighting/`).
   Ni l'un ni l'autre ne peut résoudre `src/midi/messages/`. **Concorde avec la conclusion de L03.**
3. **`src/midi/messages/` ne contient que ce fichier** → le répertoire disparaît avec lui.
4. **Aucune doc active n'y renvoie.** Le seul renvoi hors `docs/audit/` est
   `TODO.md:159-164`, une entrée **déjà barrée** (`~~…~~`, « déjà corrigé »).

**Diff proposé :**

```diff
 D  src/midi/messages/MidiMessage.js       (467 lignes, répertoire supprimé)
```
```diff
--- a/TODO.md
+++ b/TODO.md
 ### Sécurité

-- ~~**`MidiMessage.parseObject()` sans whitelist de propriétés**~~ — déjà
-  corrigé. `src/midi/messages/MidiMessage.js:134-142` énumère
-  explicitement les clés autorisées (`note`, `velocity`, `pressure`,
-  `controller`, `value`, `program`, `data`, `song`, `timestamp`, `raw`)
-  et ignore le reste.
+- ~~**`MidiMessage.parseObject()` sans whitelist de propriétés**~~ — **sans
+  objet** : `src/midi/messages/MidiMessage.js` était du code mort (0 importeur)
+  et a été supprimé (audit 2026-09-07, F-09). Le parsing réel vit dans
+  `DeviceManager.handleMidiMessage` / `_parseRawBytes`.
```
```diff
--- a/docs/ARCHITECTURE.md
+++ b/docs/ARCHITECTURE.md
-│   │   ├── messages/          # MIDI message constructors/parsers
```

Bénéfice mesuré : **-467 lignes, -201 statements non couverts** → la couverture
vraie remonte mécaniquement (cf. `docs/audit/2026-08-22/02_CODE_QUALITY.md:154`).

### 4.2 Au-delà de l'outil : fonctions exportées jamais appelées

Scan complet des `export function|const|class|{…}` de `src/`, `public/js/`,
`shared/`, croisés avec **tous** les fichiers du dépôt (y compris `tests/` et
`scripts/`). 17 exports ne sont référencés nulle part ailleurs ; en
distinguant l'usage **interne au fichier** on obtient deux catégories :

**A. Code réellement mort (définition seule, 0 appel où que ce soit) — 5 :**

| Symbole | Fichier:ligne | Commentaire |
|---|---|---|
| **`mapColorToFixture`** | `src/lighting/DmxFixtureProfiles.js:142` | **capacité morte, voir §4.3** |
| `requireFields` | `src/utils/ValidationUtils.js:35` | wrapper de `requireField` ; jamais utilisé |
| `listMelodicPrograms` | `src/files/SF2Converter.js:243` | jamais appelé |
| `listDrumKits` | `src/files/SF2Converter.js:257` | jamais appelé |
| `__private` | `src/utils/SchemaCompiler.js` | trappe de test jamais utilisée par un test |

**B. Surface d'export superflue (symbole vivant en interne, `export` inutile) — 12 :**
`DEFAULT_CRITICAL_WATERMARK`, `MIN_QUEUE_DEPTH_UNDER_LAG`, `INFORMATIONAL_EVENTS`
(`src/api/WsOutputQueue.js`) · `LOOP_CONSTRAINTS` (`schemas/loop.schemas.js`) ·
`MIDI_SYSTEM_MESSAGES` (`src/core/constants.js`) · `getFamilies`,
`getProgramSlug`, `drumKitOffset` (`src/midi/gm/InstrumentFamilies.js`) ·
`splitSqlStatements` (`src/persistence/DatabaseLifecycle.js`) ·
`APPLEMIDI_SIGNATURE`, `APPLEMIDI_PROTOCOL_VERSION` (`src/transports/AppleMidi.js`) ·
`EVENT_TYPES` (`shared/BinaryFrameCodec.js`).

> Recommandation : supprimer la catégorie A ; pour la catégorie B, **ne pas
> dé-exporter aveuglément** — plusieurs de ces symboles (`LOOP_CONSTRAINTS`,
> `EVENT_TYPES`, `splitSqlStatements`) sont exactement ce qu'un test devrait
> vérifier. Les cibler pour de **nouveaux tests** plutôt que pour la poubelle.

### 4.3 Capacité morte : les profils de fixtures DMX ne sont jamais appliqués

`src/lighting/DmxFixtureProfiles.js` expose 3 fonctions. Une seule est
importée, et depuis un seul endroit :

```
src/api/commands/LightingCommands.js:903
  const { listProfiles } = await import('../../lighting/DmxFixtureProfiles.js');
```

`mapColorToFixture(profileName, r, g, b, brightness, extra)` — la fonction qui
traduit une couleur RGB en **canaux DMX pour un profil de fixture donné**
(dimmer, blanc, ambre, UV, strobe, pan/tilt) — **n'est appelée nulle part**.
Ni `ArtNetDriver`, ni `SacnDriver`, ni `LightingManager` ne connaissent la
notion de profil. Côté UI :

```
public/js/features/LightingControlPage.js:1051-1085
  _loadDmxProfiles()      → remplit un <select> à partir de lighting_dmx_profiles
  _onDmxProfileChange()   → recopie profile.channels dans l'input "nombre de canaux"
```

Le profil choisi **n'est ni persisté ni transmis** : aucune colonne
`dmx_profile` en base (`grep -rn "dmx_profile" migrations/ src/ public/js/` →
0 hors le nom de la commande). Le sélecteur ne sert qu'à pré-remplir un
compteur de canaux.

**Conséquence :** `wiki/Home.md:61` et `wiki/Lighting.md` annoncent des
« DMX fixture profiles ». Ils existent comme catalogue consultable, **pas
comme comportement**. Au sens du critère §1.1 du plan d'audit
(« aucune capacité morte »), c'est un blocker. → **à instruire par L02** pour
décider : câbler `mapColorToFixture` dans les drivers DMX, ou retirer la
promesse de la doc.

### 4.4 Schéma de base : une table entière et 7 colonnes obsolètes

Scan des 229 colonnes déclarées dans `migrations/*.sql`, croisé avec tout le
JS/HTML/JSON du dépôt : **34 colonnes ne sont mentionnées nulle part.**

**A. `instrument_light_config` — 26 colonnes, table morte assumée.**
Migration 025 (+026) la crée ; migration 027 la remplace et le dit :

```
migrations/027_instrument_light_state.sql:16-18
  -- The legacy `instrument_light_config` table (migrations 025/026) is left
  -- in place for backward compatibility on already-deployed databases but is
  -- no longer read or written by GM Boop.
```

`grep -rn "instrument_light_config"` hors `migrations/` → **0**. Le choix est
**documenté et défendable** pour une base existante, mais **une installation
neuve crée quand même une table de 26 colonnes que rien ne lira jamais**.
→ Proposition : migration `035_drop_instrument_light_config.sql`
(`DROP TABLE IF EXISTS instrument_light_config;`), sans perte — la donnée n'a
jamais été lue par le code actuel.

**B. 8 colonnes orphelines sur des tables vivantes :**

| Table.colonne | Migration | Statut |
|---|---|---|
| `instruments_latency.descriptor_revision` | 033 | **écrites nulle part, lues nulle part** — le cache de descripteurs v2 (T1.8) n'est pas câblé → **L06** |
| `instruments_latency.descriptor_json` | 033 | idem |
| `instruments_latency.std_deviation` | 001 | jamais lue |
| `instruments_latency.measurement_history` | 001 | jamais lue |
| `instruments_latency.calibration_confidence` | 001 | jamais lue |
| `devices.port_id` | 001 | jamais lue |
| `presets.is_favorite` | 001 | jamais lue (aucune UI de favoris) |
| `sessions.last_opened` | 001 | jamais lue |

Les trois colonnes `instruments_latency.*` de la migration 001 correspondent à
une métrologie de calibration jamais exploitée : `latency_measure` calcule des
`min`/`max`/`avg` mais ne persiste ni écart-type, ni historique, ni indice de
confiance. **`latency_recommendations` — la commande qui aurait besoin de ces
colonnes — est justement à 0 appel frontend et 0 test.** → **L06/L12**.

### 4.5 Dépendances `package.json` ↔ imports réels

**Sens 1 — dépendances déclarées jamais requises : aucune.** Les 12
`dependencies` et les 2 `optionalDependencies` sont toutes importées :

```
better-sqlite3 15 fichiers · midi-file 12 · express 7 · ws 4 · soundfont2 3
serialport 2 · compression 1 · dotenv 1 · easymidi 1 · helmet 1 · node-ble 1
node-schedule 1 · pigpio 1 (opt) · rpi-ws281x-native 1 (opt)
```

**Sens 2 — modules importés jamais déclarés : un, et c'est un P1.**

```
src/lighting/MqttLightDriver.js:22      const mqtt = await import('mqtt');
$ node -e "…" → mqtt in package.json: ABSENT
$ ls -d node_modules/mqtt              → node_modules/mqtt ABSENT
```

Ce n'est pas une coquille de développement : le driver MQTT est **promis
publiquement** et **exposé dans l'UI** —

```
README.md:115                    …ArtNet DMX, sACN/E1.31, OSC, HTTP/WLED et MQTT drivers.
wiki/Home.md:49,61 · wiki/Lighting.md:19 · wiki/Interface-Lighting-Control.md:34 · wiki/Usage-Guide.md:57
docs/ARCHITECTURE.md:101         │   │   └── MqttLightDriver.js # MQTT
public/js/features/lighting/LightingForms.js:29
  <option value="mqtt">📶 MQTT (WLED, Tasmota, ESPHome)</option>
```

L'utilisateur peut donc créer un périphérique lumineux MQTT, saisir l'URL du
broker, le topic, le firmware… et le driver échouera systématiquement à
`connect()`. Pire, l'échec est **avalé** :

```
src/lighting/LightingManager.js:161-164
  } catch (error) {
    this.logger.warn(`Failed to connect lighting device "${device.name}": ${error.message}`);
    this._broadcastDeviceStatus(device.id, false);
```

L'UI affiche « non connecté », indiscernable d'un broker éteint. Le diagnostic
réel (`Cannot find package 'mqtt'`) n'apparaît qu'en `warn` dans les logs.

**Correctif :**

```diff
--- a/package.json
   "optionalDependencies": {
+    "mqtt": "^5.14.1",
     "pigpio": "^3.3.1",
     "rpi-ws281x-native": "^1.0.0"
   },
```

`optionalDependencies` plutôt que `dependencies` : cohérent avec les autres
drivers matériels (`pigpio`, `rpi-ws281x-native`), et l'installation reste
possible si le paquet n'est pas récupérable. **À compléter par un message
d'erreur explicite** :

```diff
--- a/src/lighting/MqttLightDriver.js
   async connect() {
     try {
-      const mqtt = await import('mqtt');
+      let mqtt;
+      try {
+        mqtt = await import('mqtt');
+      } catch {
+        throw new Error(
+          'MQTT driver unavailable: the optional `mqtt` package is not installed. ' +
+          'Run `npm install mqtt` (or reinstall without --omit=optional).'
+        );
+      }
```

**Note annexe :** `@jest/globals` est importé par des suites de tests sans être
déclaré (il n'arrive que comme dépendance transitive de `jest`). Sans gravité,
mais à déclarer en `devDependencies` pour la robustesse.

### 4.6 Ce qui n'est **pas** du code mort

- **Fichiers CSS orphelins : aucun.** Les 29 `.css` de `public/styles/` sont
  tous liés depuis `public/index.html` (lignes 5349-5380). *(Les règles CSS
  mortes à l'intérieur des fichiers relèvent de L09, §AT.)*
- **Dépendances non utilisées : aucune** (§4.5, sens 1).
- **Schémas orphelins : 0**, **appels frontend fantômes : 0**
  (`command-inventory.mjs`, inchangé depuis le 2026-08-22).

---

## 5. CI — état et workflow proposé

### 5.1 F-17 est bien corrigé

```
$ npx prettier --check <les 13 fichiers listés dans 00_BASELINE.md §4>
Checking formatting...
All matched files use Prettier code style!
```

**F-17 : CONFIRMÉ CORRIGÉ.** Le job `lint` repasse au vert sur `main`.

> ⚠️ **Alerte pour la vague 2.** Au moment de ce rapport, `format:check` sur
> l'arbre complet échoue de nouveau sur **9 fichiers de test** créés par les
> lots parallèles (`tests/audit/l03-…`, `l05-…`, `l12-…`, `tests/lighting/*`,
> `tests/transports/l04-*`). Le glob `format:check` couvre `tests/**/*.js`,
> donc **la CI `lint` redeviendra rouge dès la fusion des lots** si personne ne
> repasse `prettier --write`. À faire en vague 2, après consolidation.
> *(Je ne l'ai pas fait : ce sont les fichiers d'autres agents.)*

### 5.2 Les étapes qui manquent

Le workflow actuel (5 jobs) fait du **contrôle statique** et exécute les tests,
mais **ne verrouille aucune propriété du produit**. Rien n'empêche une PR de
faire baisser la couverture, d'ajouter 20 commandes sans schéma ni doc, de
casser le build Docker, ou de réintroduire du code mort.

| Manque | Impact | Outil déjà disponible |
|---|---|---|
| **Ratchet de couverture** | `jest.config.cjs` n'a **ni `collectCoverageFrom` ni `coverageThreshold`** → le rapport lit ~7 points trop haut (F-04) et rien ne bloque une régression | Jest natif |
| **Ratchet de contrat WS** | 86/270 schémas, 187/270 docs : les 4 chiffres peuvent empirer sans que rien ne le signale | `scripts/audit/command-inventory.mjs --json` (déjà écrit) |
| **Ratchet de code mort** | `dead-modules.mjs` **sort toujours 0** — c'est un rapport, pas une porte | `scripts/audit/dead-modules.mjs --json` |
| **Porte `npm audit` au bon niveau** | `--audit-level=critical` laisse passer **3 advisories `high`**, toutes `fixAvailable: true` (§5.3) | npm natif |
| **Contrôle de licences** | aucun `LICENSE`, aucune détection d'une dépendance copyleft entrante, aucun suivi d'attribution des assets | script maison |
| **Build Docker** | le `Dockerfile` **ne se construit pas** et personne ne s'en aperçoit (§7.3) | `docker/build-push-action` |
| **Build front (`vite`)** | `npm run build` n'est **jamais** exécuté en CI → une régression de build passe | déjà en `package.json` |
| **E2E navigateur** | harnais construit par L08, aucun job pour l'exécuter | Playwright |
| **Cohérence de version** | rien ne vérifie tag ↔ `package.json` ↔ CHANGELOG | script maison |

### 5.3 La porte `npm audit` — mesuré

```
$ npm audit --omit=dev --audit-level=critical ; echo $?     → 0   (passe)
$ npm audit --omit=dev --audit-level=high     ; echo $?     → 1   (bloque)
$ npm audit --omit=dev  →  8 vulnérabilités (1 low, 4 moderate, 3 high)
```

| Sévérité | Paquet | Direct ? | Correctif |
|---|---|---|---|
| **high** | `ws` 8.20.0 | **oui** (dép. runtime directe) | `fixAvailable: true`, **non rupturant** |
| **high** | `brace-expansion` 5.0.5 | non (`minimatch` ← `cacache`/`nodemon`) | `fixAvailable: true`, non rupturant |
| **high** | `ip-address` 10.1.0 | non (`socks`) | `fixAvailable: true`, non rupturant |
| moderate | `node-ble` / `dbus-next` / `xml2js` | `node-ble` direct | rupturant (`node-ble@0.0.0`) — à **accepter explicitement** |
| moderate | `qs` · low `body-parser` | non (`express`) | `fixAvailable: true` |

**Les 3 `high` sont toutes corrigeables sans rupture** → la porte peut passer
à `--audit-level=high` **dès que L10 a lancé `npm audit fix`**. Les 4
`moderate` restants (chaîne `node-ble`) passent alors sous la porte et doivent
faire l'objet d'une **acceptation de risque écrite** (elle existe déjà en
substance dans l'audit d'août ; il faut la matérialiser dans un fichier).

### 5.4 Diffs préalables (hors workflow)

**`jest.config.cjs`** — ratchet de couverture, au plancher mesuré par L00
(44,68 / 44,18 / 38,85), arrondi à l'entier inférieur pour absorber le bruit :

```diff
--- a/jest.config.cjs
+++ b/jest.config.cjs
 module.exports = {
   testMatch: ['**/tests/**/*.test.js', '!**/tests/frontend/**'],
   testPathIgnorePatterns: ignorePatterns,
   transform: {},
+  // Sans cette option, le rapporteur n'agrège que les fichiers effectivement
+  // chargés par une suite : il lit ~7 points trop haut (audit 2026-08-22, F-04).
+  collectCoverageFrom: ['src/**/*.js', '!src/types/**'],
+  // Cliquet : la couverture ne peut que monter. Plancher = mesure L00 du
+  // 2026-09-07 (44.68 / 44.18 / 38.85), arrondie à l'entier inférieur.
+  coverageThreshold: {
+    global: { statements: 44, branches: 44, functions: 38, lines: 44 }
+  },
+  coverageReporters: ['text-summary', 'json-summary', 'lcov'],
 };
```

> ⚠️ Le plancher est **conditionné à la suppression de `MidiMessage.js`**
> (§4.1) : celle-ci retire 201 statements non couverts et fait *monter* le
> ratio. Appliquer les deux ensemble, puis re-mesurer et remonter le plancher.

**`scripts/audit/ratchet.mjs`** — nouveau fichier, aucune dépendance :

```js
/**
 * @file scripts/audit/ratchet.mjs
 * @description Porte CI : agrège les sorties JSON de command-inventory.mjs et
 * dead-modules.mjs et échoue si une métrique passe sous son plancher.
 * Les planchers vivent dans scripts/audit/ratchet.json et ne se relèvent
 * QUE par une PR explicite — jamais à la baisse.
 *
 * Usage: node scripts/audit/ratchet.mjs [--update]
 */
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FLOORS_PATH = join(HERE, 'ratchet.json');
const run = (f) => JSON.parse(execFileSync(process.execPath, [join(HERE, f), '--json'], {
  encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
}));

const inv = run('command-inventory.mjs');
const dead = run('dead-modules.mjs');

const actual = {
  registeredCommands: inv.summary.registered,
  commandsWithSchema: inv.summary.withSchema,
  commandsDocumented: inv.summary.documented,
  commandsWithTests: inv.summary.withTests,
  orphanSchemas: inv.summary.orphanSchemas.length,
  phantomFrontendCalls: inv.summary.phantomFrontendCalls.length,
  deadModules: dead.length,
  deadModuleLines: dead.reduce((a, o) => a + o.lines, 0)
};

// direction: 'min' = ne doit jamais descendre ; 'max' = ne doit jamais monter.
const DIRECTION = {
  commandsWithSchema: 'min', commandsDocumented: 'min', commandsWithTests: 'min',
  orphanSchemas: 'max', phantomFrontendCalls: 'max',
  deadModules: 'max', deadModuleLines: 'max'
};

if (process.argv.includes('--update')) {
  writeFileSync(FLOORS_PATH, JSON.stringify(actual, null, 2) + '\n');
  console.log('ratchet.json mis à jour :\n' + JSON.stringify(actual, null, 2));
  process.exit(0);
}

const floors = JSON.parse(readFileSync(FLOORS_PATH, 'utf8'));
let failed = 0;
for (const [key, dir] of Object.entries(DIRECTION)) {
  const got = actual[key], want = floors[key];
  if (want === undefined) continue;
  const ok = dir === 'min' ? got >= want : got <= want;
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${key.padEnd(24)} ${got}  (${dir} ${want})`);
  if (!ok) failed++;
}
// Le nombre total de commandes n'est pas un cliquet, mais toute variation doit
// être vue : une commande ajoutée sans schéma ni doc élargit la surface non validée.
if (actual.registeredCommands !== floors.registeredCommands) {
  console.log(`NOTE  registeredCommands ${floors.registeredCommands} -> ${actual.registeredCommands} ` +
    `(pense à ajouter schéma + doc + test, puis 'node scripts/audit/ratchet.mjs --update')`);
}
if (failed) {
  console.error(`\n${failed} cliquet(s) rompu(s). Corrige, ou relève le plancher ` +
    `explicitement avec --update dans une PR dédiée.`);
  process.exit(1);
}
console.log('\nTous les cliquets tiennent.');
```

**`scripts/audit/ratchet.json`** — planchers initiaux, mesurés ce jour
(à régénérer avec `--update` **après** la suppression de `MidiMessage.js`) :

```json
{
  "registeredCommands": 270,
  "commandsWithSchema": 86,
  "commandsDocumented": 187,
  "commandsWithTests": 63,
  "orphanSchemas": 0,
  "phantomFrontendCalls": 0,
  "deadModules": 0,
  "deadModuleLines": 0
}
```

**`scripts/audit/licenses.mjs`** — nouveau fichier, aucune dépendance :

```js
/**
 * @file scripts/audit/licenses.mjs
 * @description Porte CI licences (§BS) :
 *   1. LICENSE présent à la racine et cohérent avec package.json.
 *   2. Aucune licence copyleft forte dans l'arbre runtime (prod + optional).
 *   3. Tout asset livré sous public/assets/ est couvert par ASSET-LICENSES.md.
 * Usage: node scripts/audit/licenses.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const DENY = /^(AGPL|GPL-[23]|SSPL|CC-BY-NC|BUSL|Commons-Clause)/i;
let failed = 0;
const fail = (m) => { console.error('FAIL  ' + m); failed++; };
const ok = (m) => console.log('OK    ' + m);

// 1 — licence du projet
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
if (!existsSync(join(ROOT, 'LICENSE'))) fail('LICENSE absent à la racine du dépôt');
else {
  const txt = readFileSync(join(ROOT, 'LICENSE'), 'utf8');
  if (pkg.license === 'MIT' && !/MIT License/i.test(txt)) fail('LICENSE ne correspond pas à package.json.license=MIT');
  else ok(`LICENSE présent et cohérent (${pkg.license})`);
}

// 2 — licences de l'arbre runtime
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
const P = lock.packages;
const resolveFrom = (from, name) => {
  let p = from;
  for (;;) {
    const c = (p ? p + '/' : '') + 'node_modules/' + name;
    if (P[c]) return c;
    if (!p) return null;
    const i = p.lastIndexOf('/node_modules/');
    p = i < 0 ? '' : p.slice(0, i);
  }
};
const root = P[''] || {};
const queue = Object.keys({ ...root.dependencies, ...root.optionalDependencies })
  .map((n) => resolveFrom('', n)).filter(Boolean);
const seen = new Set();
while (queue.length) {
  const k = queue.pop();
  if (seen.has(k)) continue;
  seen.add(k);
  const v = P[k] || {};
  for (const d of Object.keys({ ...v.dependencies, ...v.optionalDependencies })) {
    const r = resolveFrom(k, d);
    if (r && !seen.has(r)) queue.push(r);
  }
}
const unknown = [];
for (const k of seen) {
  let lic = P[k].license;
  if (!lic && existsSync(join(ROOT, k, 'package.json'))) {
    const j = JSON.parse(readFileSync(join(ROOT, k, 'package.json'), 'utf8'));
    lic = typeof j.license === 'string' ? j.license : j.license?.type;
  }
  const name = k.split('node_modules/').pop();
  if (!lic) unknown.push(name);
  else if (DENY.test(lic)) fail(`licence interdite dans l'arbre runtime : ${name} (${lic})`);
}
if (unknown.length) fail(`licence indéterminée (à renseigner dans THIRD-PARTY-NOTICES.md) : ${unknown.join(', ')}`);
else ok(`${seen.size} paquets runtime, aucune licence copyleft forte`);

// 3 — attribution des assets livrés
const NOTICE = join(ROOT, 'assets', 'ASSET-LICENSES.md');
if (!existsSync(NOTICE)) fail('assets/ASSET-LICENSES.md absent — les SVG livrés ne sont pas tracés');
else {
  const notice = readFileSync(NOTICE, 'utf8');
  const walk = (d, acc = []) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, acc); else acc.push(p);
    }
    return acc;
  };
  const missing = walk(join(ROOT, 'public', 'assets'))
    .map((p) => p.slice(ROOT.length + 1))
    .filter((p) => !notice.includes(p.split('/').pop()));
  if (missing.length) fail(`${missing.length} assets sans attribution : ${missing.slice(0, 5).join(', ')}…`);
  else ok('tous les assets livrés sont tracés dans assets/ASSET-LICENSES.md');
}

process.exit(failed ? 1 : 0);
```

### 5.5 Le workflow CI proposé, en entier

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
    tags: ['v*']
  pull_request:
    branches: [main]

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

env:
  NODE_VERSION: '20'

jobs:
  # ═══════════════════════════════════════════════════════ 1. Contrôle statique
  lint:
    name: Lint & Format
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: npm }
      - run: npm ci --ignore-scripts
      - run: npm run lint
      - run: npm run format:check

  typecheck:
    name: Typecheck
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: npm }
      - run: npm ci --ignore-scripts
      - run: npm run typecheck

  # ═════════════════════════════════════════════════ 2. Contrat & dette (NOUVEAU)
  # Verrouille les propriétés que l'audit 2026-09-07 a mesurées : elles ne
  # peuvent que s'améliorer. Sans ce job, rien n'empêche une PR d'ajouter
  # 20 commandes sans schéma, sans doc et sans test.
  contract:
    name: WS contract & dead-code ratchet
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: npm }
      - run: npm ci --ignore-scripts
      - name: Inventaire des commandes (informatif)
        run: node scripts/audit/command-inventory.mjs
      - name: Modules non référencés (informatif)
        run: node scripts/audit/dead-modules.mjs
      - name: Cliquets (bloquant)
        run: node scripts/audit/ratchet.mjs
      - name: Puits XSS (informatif)
        run: node scripts/audit/xss-sinks.mjs

  # ═══════════════════════════════════════════════ 3. Docs ↔ code (NOUVEAU)
  # Empêche la reprise de la dérive documentée par l'audit L14 : un chemin
  # cité dans une doc active doit exister.
  docs:
    name: Docs ↔ code
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: npm }
      - name: Chemins morts dans les docs actives
        run: node scripts/audit/doc-paths.mjs      # cf. §Reproduction
      - name: Variables d'environnement documentées
        run: |
          comm -23 \
            <(grep -rhoE 'GMBOOP_[A-Z0-9_]+' --include='*.js' --include='*.sh' src/ scripts/ server.js | sort -u) \
            <(grep -ohE 'GMBOOP_[A-Z0-9_]+' .env.example | sort -u) > /tmp/undocumented-env
          if [ -s /tmp/undocumented-env ]; then
            echo "::error::variables GMBOOP_* absentes de .env.example :"; cat /tmp/undocumented-env; exit 1
          fi

  # ═══════════════════════════════════════════════════════ 4. Sécurité
  audit:
    name: Security Audit
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: npm }
      - run: npm ci --ignore-scripts
      # Porte relevée de `critical` à `high` : au 2026-09-07 les 3 advisories
      # `high` (ws, brace-expansion, ip-address) sont toutes fixAvailable et
      # non rupturantes. Les `moderate` restantes (node-ble → dbus-next →
      # xml2js) exigent une rupture majeure ; le risque est accepté par écrit
      # dans docs/SECURITY-EXCEPTIONS.md et re-daté à chaque release.
      - name: Arbre runtime
        run: npm audit --omit=dev --audit-level=high
      - name: Arbre complet (informatif)
        run: npm audit --audit-level=high || true

  licenses:
    name: Licences & attribution
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: npm }
      - run: npm ci --ignore-scripts
      - run: node scripts/audit/licenses.mjs

  # ═══════════════════════════════════════════════════════ 5. Tests
  frontend-smoke:
    name: Frontend smoke (no native deps)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: npm }
      - run: npm ci --ignore-scripts
      - run: npm run lint
      - run: npm run test:frontend

  test:
    name: Test + coverage ratchet
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: npm }
      - name: Dépendances système pour les modules natifs
        run: sudo apt-get update && sudo apt-get install -y build-essential python3 libasound2-dev
      - run: npm ci
      # Garde-fou F-04 : sans binding better-sqlite3, jest.config.cjs retire
      # 10 suites SANS le dire. On refuse de mesurer une couverture amputée.
      - name: Vérifier que better-sqlite3 est réellement compilé
        run: node -e "const D=require('better-sqlite3');new D(':memory:').close();console.log('better-sqlite3 OK')"
      # Le seuil vit dans jest.config.cjs (coverageThreshold) : ce job échoue
      # de lui-même si la couverture passe sous le plancher.
      - run: npm run test:coverage
      - run: npm run test:frontend
      - name: Résumé de couverture dans le job
        if: always()
        run: |
          echo '### Couverture backend' >> $GITHUB_STEP_SUMMARY
          echo '```' >> $GITHUB_STEP_SUMMARY
          node -e "const t=require('./coverage/coverage-summary.json').total;
            for(const k of ['statements','branches','functions','lines'])
              console.log(k.padEnd(11), t[k].pct + '%')" >> $GITHUB_STEP_SUMMARY
          echo '```' >> $GITHUB_STEP_SUMMARY
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: coverage-report, path: coverage/, retention-days: 14 }

  # ═════════════════════════════════════════════════════ 6. E2E (NOUVEAU, L08)
  e2e:
    name: E2E navigateur (Playwright)
    runs-on: ubuntu-latest
    needs: [frontend-smoke]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: npm }
      - id: harness
        run: test -d tests/e2e && echo "present=true" >> $GITHUB_OUTPUT || echo "present=false" >> $GITHUB_OUTPUT
      - if: steps.harness.outputs.present == 'true'
        run: sudo apt-get update && sudo apt-get install -y build-essential python3 libasound2-dev
      - if: steps.harness.outputs.present == 'true'
        run: npm ci
      - if: steps.harness.outputs.present == 'true'
        run: npx playwright install --with-deps chromium
      - if: steps.harness.outputs.present == 'true'
        run: npm run test:e2e
        env: { CI: 'true' }
      - if: always() && steps.harness.outputs.present == 'true'
        uses: actions/upload-artifact@v4
        with: { name: playwright-report, path: playwright-report/, retention-days: 14 }

  # ═════════════════════════════════════════════════ 7. Artefacts (NOUVEAU)
  build:
    name: Build front (Vite) + intégrité de dist/
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: npm }
      - run: npm ci --ignore-scripts
      - run: npm run build
      # dist/ est ce que la production sert (HttpServer.js:271). Un répertoire
      # oublié dans le plugin copyStaticTree = un 404 en prod invisible en dev.
      - name: dist/ doit être auto-suffisant
        run: |
          for d in js locales styles assets lib; do
            [ -d "dist/$d" ] || { echo "::error::dist/$d manquant (plugin copyStaticTree)"; exit 1; }
          done
          [ -f dist/index.html ] || { echo "::error::dist/index.html manquant"; exit 1; }
          for f in $(grep -oE 'src="(js|lib)/[^"]+"' dist/index.html | sed 's/src="//;s/"//' | sort -u); do
            [ -f "dist/$f" ] || { echo "::error::dist/index.html référence $f, absent de dist/"; exit 1; }
          done
      # Le build doit être déterministe : deux passes, mêmes octets.
      - name: Reproductibilité (2 passes)
        run: |
          find dist -type f -print0 | sort -z | xargs -0 sha256sum > /tmp/build1.sha
          rm -rf dist && npm run build
          find dist -type f -print0 | sort -z | xargs -0 sha256sum > /tmp/build2.sha
          diff /tmp/build1.sha /tmp/build2.sha || { echo "::error::build non reproductible"; exit 1; }
      - uses: actions/upload-artifact@v4
        with: { name: dist, path: dist/, retention-days: 7 }

  docker:
    name: Image Docker (build + boot smoke)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: false
          load: true
          tags: gmboop:ci
          cache-from: type=gha
          cache-to: type=gha,mode=max
      # Un build vert ne prouve rien si le conteneur meurt au démarrage
      # (c'est exactement le cas au 2026-09-07 : `shared/` n'est pas copié).
      - name: Démarrage + /api/health
        run: |
          docker run -d --name gmboop-ci -p 8080:8080 gmboop:ci
          for i in $(seq 1 30); do
            if curl -fsS http://127.0.0.1:8080/api/health > /tmp/health.json; then
              cat /tmp/health.json; docker rm -f gmboop-ci; exit 0
            fi
            sleep 2
          done
          echo "::error::le conteneur n'a jamais répondu sur /api/health"
          docker logs gmboop-ci; docker rm -f gmboop-ci; exit 1

  # ══════════════════════════════════════════ 8. Cohérence de release (NOUVEAU)
  version:
    name: Cohérence tag ↔ package.json ↔ CHANGELOG
    if: startsWith(github.ref, 'refs/tags/v')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: |
          TAG="${GITHUB_REF_NAME#v}"
          PKG=$(node -p "require('./package.json').version")
          LCK=$(node -p "require('./package-lock.json').version")
          [ "$TAG" = "$PKG" ] || { echo "::error::tag v$TAG ≠ package.json $PKG"; exit 1; }
          [ "$TAG" = "$LCK" ] || { echo "::error::tag v$TAG ≠ package-lock.json $LCK"; exit 1; }
          grep -q "^## \[$TAG\]" CHANGELOG.md || { echo "::error::CHANGELOG.md n'a pas d'entrée [## $TAG]"; exit 1; }
          echo "v$TAG cohérent (package.json, package-lock.json, CHANGELOG.md)"
```

**Nouveaux scripts npm à ajouter** (référencés par le workflow) :

```diff
--- a/package.json
     "test:frontend:watch": "vitest",
+    "test:e2e": "playwright test",
+    "audit:ratchet": "node scripts/audit/ratchet.mjs",
+    "audit:licenses": "node scripts/audit/licenses.mjs",
```

---

## 6. Licences

### 6.1 Licence du projet — **FAIL, et c'est le plus simple à corriger**

| Élément | État |
|---|---|
| `package.json:39` | `"license": "MIT"` |
| `README.md:6` | badge `license-MIT-blue` pointant vers `#license` |
| `README.md:172-174` | « Released under the **MIT License**. » |
| **Fichier `LICENSE` / `COPYING`** | **INEXISTANT** (`ls LICENSE* COPYING*` → rien) |

Conséquences concrètes, pas théoriques :
- GitHub ne détecte aucune licence (pas d'encart « MIT » sur la page du dépôt) ;
- **le texte MIT exige que « the above copyright notice and this permission
  notice shall be included in all copies »** — un redistributeur (image
  Docker, fork, paquet Pi) n'a **rien à inclure**, la clause est inexécutable ;
- aucun détenteur de copyright n'est nommé (`"author": "GeneralMidiBoop Team"`
  n'est pas une entité).

**Correctif — ajouter `LICENSE` à la racine :**

```
MIT License

Copyright (c) 2026 glloq and the Général Midi Boop contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

```diff
--- a/README.md
-[![License](https://img.shields.io/badge/license-MIT-blue.svg)](#license)
+[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
@@
 ## License
-
-Released under the **MIT License**.
+
+Released under the **MIT License** — see [`LICENSE`](./LICENSE).
+
+Third-party runtime dependencies and their licences:
+[`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md).
+Icons, soundfonts and other shipped assets:
+[`assets/ASSET-LICENSES.md`](./assets/ASSET-LICENSES.md).
```

Enfin, le `Dockerfile` ne copie **ni** `LICENSE` **ni** `README.md`
(`.dockerignore` exclut `*.md`) : l'image redistribue le logiciel sans son
texte de licence. → à corriger avec F-157.

### 6.2 Licences des dépendances runtime — **PASS**

Arbre `dependencies` + `optionalDependencies` résolu depuis `package-lock.json`
(**231 paquets**) :

| Licence | Nb | Compatible MIT ? |
|---|---|---|
| MIT | 174 | ✅ |
| ISC | 30 | ✅ |
| BlueOak-1.0.0 | 13 | ✅ (permissive) |
| Apache-2.0 | 4 (`detect-libc`, `exponential-backoff`, `long`, `tunnel-agent`) | ✅ — **exige la conservation du NOTICE** |
| BSD-2-Clause | 2 (`dotenv`, `http-cache-semantics`) | ✅ |
| BSD-3-Clause | 2 (`ieee754`, `qs`) | ✅ |
| MIT/X11 | 1 (`@nornagon/put`) | ✅ |
| (MIT OR WTFPL) | 1 (`expand-template`) | ✅ |
| MIT,Apache2 | 1 (`pause-stream`) | ✅ (SPDX malformé en amont) |
| (BSD-2 OR MIT OR Apache-2.0) | 1 (`rc`) | ✅ |
| **champ absent** | 2 | résolu à la main ↓ |

Les deux « UNKNOWN » sont en fait licenciés, mais sans champ `license` dans
leur `package.json` :

| Paquet | Chaîne | Licence réelle (fichier) |
|---|---|---|
| `jsbi` | `node-ble → dbus-next → jsbi` | **Apache-2.0** (`node_modules/jsbi/LICENSE`) |
| `map-stream` | `node-ble → dbus-next → event-stream → map-stream` | **MIT** (`node_modules/map-stream/LICENCE`, © 2011 Dominic Tarr) |

**Aucune licence copyleft (GPL/AGPL/LGPL/SSPL) dans l'arbre runtime.**
Le résultat est donc bon — mais **rien ne l'empêche de changer** : c'est ce
que verrouille le job `licenses` de §5.5.

**Manque à créer : `THIRD-PARTY-NOTICES.md`**, indispensable pour les 4
paquets Apache-2.0 + `jsbi` (§4 de la licence Apache impose de transmettre les
notices). Générable par `scripts/audit/licenses.mjs` étendu d'un `--emit`.

**Note pour L10 :** `event-stream@3.3.4` et `map-stream@0.1.0` (dernières
publications : 2018) arrivent dans l'arbre **runtime** via
`node-ble → dbus-next`. Paquets non maintenus, historiquement au cœur d'un
incident de chaîne d'approvisionnement npm. Cela renforce l'argument de
F-16 pour remplacer ou isoler `node-ble`.

### 6.3 Assets — **FAIL, c'est le vrai risque**

| Asset | Origine | Licence | Tracée ? | Verdict |
|---|---|---|---|---|
| **`assets/sf2/default.sf2`** (~30 Mo, GeneralUser GS v1.471, S. Christian Collins) | téléchargé au `postinstall` depuis `raw.githubusercontent.com/ROCKNIX/...`, `.../JustEnoughLinuxOS/...`, ou `schristiancollins.com` | **GeneralUser GS License** (permissive : redistribution non modifiée + **crédits conservés**) | ⚠️ **partiellement** — cf. §6.4 | **PARTIAL** |
| **`public/lib/WebAudioFontPlayer.js`** (~120 Ko, surikov/webaudiofont) | téléchargé au `postinstall` depuis `surikov.github.io`, jsDelivr ou unpkg | **non enregistrée nulle part.** `install-default-sf2.js:54-55` dit lui-même « its license is **not redistributable freely without attribution** » — et n'ajoute aucune attribution | ❌ | **FAIL** |
| **`public/assets/**` — 107 SVG livrés** (77 instruments, 25 drums, connexion, mascotte) | **61 portent le marqueur `<!-- Uploaded to: SVG Repo, www.svgrepo.com … -->`** (45/77 instruments, 12/25 drums) | **inconnue par fichier.** SVG Repo mélange CC0, MIT, CC-BY 4.0 et une licence maison selon la collection ; le fichier ne conserve **aucune** métadonnée de collection ni d'auteur | ❌ | **FAIL** |
| `public/assets/` — 46 SVG restants | production interne présumée (`images-a-faire/README.md` décrit la charte) | implicitement MIT | ❌ (jamais dit) | **PARTIAL** |
| `docs/images/**` + `images-a-faire/**` | **58 fichiers marqués svgrepo** ; les noms le trahissent (`flute-svgrepo-com.svg`, `drum-svgrepo-com.svg`) | idem | ❌ | **FAIL** (non livré au runtime, mais redistribué avec le dépôt) |
| `public/locales/*.json` (28 langues) | production interne | MIT (projet) | implicite | OK |
| `shared/gm-instrument-names.json`, `gm-instrument-capabilities.json` | tables GM 1 — noms d'instruments issus de la spécification MMA | tables de faits, non protégeables | implicite | OK |
| Polices | **aucune** (`grep fonts.googleapis public/index.html` → 0) | — | — | OK |

Preuve pour les SVG :

```
$ head -3 public/assets/instruments/trumpet.svg
<?xml version="1.0" encoding="utf-8"?>
<!-- Uploaded to: SVG Repo, www.svgrepo.com, Generator: SVG Repo Mixer Tools -->
$ grep -rl svgrepo public/assets/ | wc -l          → 61
$ find public/assets -name '*.svg' | wc -l          → 107
$ grep -rho -i "licen[^\"<]*" public/assets/ | sort -u   → (vide)
```

**Le risque est réel et non théorique** : ces 61 fichiers sont copiés dans
`dist/` par `vite.config.js` (`copyStaticTree` → `assets`) et donc
redistribués dans toute image, tout paquet, tout fork. Si l'un provient d'une
collection **CC-BY**, sa redistribution sans attribution est une violation ;
si l'un provient d'une collection à licence restrictive, la redistribution est
illicite tout court. **Impossible à trancher aujourd'hui parce que la
provenance par fichier n'a pas été enregistrée.**

**Correctif proposé — créer `assets/ASSET-LICENSES.md`** et le rendre
obligatoire par le job `licenses` (§5.5) :

```markdown
# Licences et attributions des assets livrés

Ce fichier couvre TOUT fichier redistribué avec le logiciel qui n'est pas du
code source du projet. Ajouter un asset sans l'inscrire ici fait échouer la CI
(`scripts/audit/licenses.mjs`).

## Soundfont par défaut

| Fichier | `assets/sf2/default.sf2` (non versionné, téléchargé au postinstall) |
|---|---|
| Œuvre | GeneralUser GS v1.471 |
| Auteur | S. Christian Collins |
| Amont | https://schristiancollins.com/generaluser.php |
| Licence | GeneralUser GS License v2.0 — redistribution de l'original autorisée, modification interdite sans accord, **crédits à conserver** |
| Attribution livrée | `assets/sf2/GeneralUser GS License v2.0.txt` (téléchargé par `scripts/install-default-sf2.js`) |
| Intégrité | SHA-256 épinglé dans `scripts/install-default-sf2.js` |

## Bibliothèque de lecture audio

| Fichier | `public/lib/WebAudioFontPlayer.js` (non versionné, téléchargé au postinstall) |
|---|---|
| Œuvre | WebAudioFont — WebAudioFontPlayer |
| Auteur | Sergey Surikov (surikov/webaudiofont) |
| Amont | https://github.com/surikov/webaudiofont |
| Licence | <À CONFIRMER auprès de l'amont — le dépôt n'en déclare pas explicitement> |
| Intégrité | SHA-256 épinglé dans `scripts/install-default-sf2.js` |

## Icônes SVG

| Lot | Nb | Origine | Licence | Attribution |
|---|---|---|---|---|
| `public/assets/instruments/*.svg` (marqués SVG Repo) | 45 | svgrepo.com | **À DÉTERMINER par fichier** | — |
| `public/assets/drums/*.svg` (marqués SVG Repo) | 12 | svgrepo.com | **À DÉTERMINER par fichier** | — |
| autres `public/assets/**` | 50 | production Général Midi Boop | MIT (ce projet) | — |
| `docs/images/**`, `images-a-faire/**` (marqués SVG Repo) | 58 | svgrepo.com | **À DÉTERMINER par fichier** | — |
```

Et **la décision à prendre par le mainteneur**, par ordre de coût croissant :
1. Retrouver la collection SVG Repo de chacun des 61 fichiers livrés et
   consigner la licence + l'attribution (long, mais définitif) ;
2. Remplacer les 61 par des icônes d'une source à licence unique et connue
   (Lucide MIT, Bootstrap Icons MIT, Material Symbols Apache-2.0) ;
3. Les redessiner selon la charte déjà écrite dans `images-a-faire/README.md`.

**L'option 2 est la moins chère et la seule qui referme le risque tout de
suite** — la charte existe déjà, et 61 icônes d'un même jeu MIT amélioreraient
en prime la cohérence visuelle.

### 6.4 `assets/sf2/README.md` affirme deux choses fausses

```
assets/sf2/README.md:11-13
  « idempotent (no re-download if the file already exists and matches the
    expected SHA-256) »
assets/sf2/README.md:38-40
  « the install script downloads and stores it [GeneralUser GS License v2.0.txt]
    next to default.sf2 for proof-of-attribution »
```

Les deux sont **fausses** :

```
$ grep -in "sha\|hash\|integrity\|checksum" scripts/install-default-sf2.js
(vide)
$ grep -in "license\|\.txt\|attribution\|credits" scripts/install-default-sf2.js
17:  * See assets/sf2/README.md for the soundfont's license & provenance.
54:  // …the file is small (~120 KB) but its license is
55:  // not redistributable freely without attribution, so we fetch it instead of
```

La seule vérification effectuée est **une taille minimale** :

```
scripts/install-default-sf2.js:130-140   fetchVerified(url, dest, minSize)
  if (size < minSize) throw new Error('file too small … looks like an error page');
scripts/install-default-sf2.js:71   alreadyPresent() → statSync(TARGET_PATH).size >= MIN_SF2_SIZE
```

C'est la classe de faute la plus grave en documentation : **une affirmation
de sécurité mensongère**. Un relecteur qui cherche « est-ce que les assets
téléchargés sont vérifiés ? » lit ce README, trouve « SHA-256 », et clôt le
sujet. C'est exactement ce qui laisse F-15 ouvert depuis 2026-08.
De même, l'affirmation sur le texte de licence donne l'illusion que
l'attribution du soundfont est assurée : **elle ne l'est pas**.

**Correctif documentaire immédiat** (le correctif *technique* — épingler les
SHA-256 — appartient à L10 / F-15) :

```diff
--- a/assets/sf2/README.md
+++ b/assets/sf2/README.md
 The file `default.sf2` is **not committed** because it is too large to track
 comfortably in Git. It is fetched once by the postinstall script
 `scripts/install-default-sf2.js`, which runs automatically after
-`npm install` and is idempotent (no re-download if the file already exists
-and matches the expected SHA-256).
+`npm install` and is idempotent.
+
+> ⚠️ **Aucune vérification d'intégrité n'est effectuée aujourd'hui** (audit
+> 2026-09-07, F-15/F-158). Le script contrôle uniquement une **taille
+> minimale** (`MIN_SF2_SIZE`, 1 Mo) et la signature RIFF/sfbk — assez pour
+> écarter une page d'erreur HTML, **pas** pour détecter un miroir compromis.
+> Épingler un SHA-256 par miroir est suivi en F-15.
@@
-  In other words, the project may redistribute the unmodified file with
-  attribution. The full license text shipped by upstream is `GeneralUser GS
-  License v2.0.txt`; the install script downloads and stores it next to
-  `default.sf2` for proof-of-attribution.
+  In other words, the project may redistribute the unmodified file with
+  attribution.
+
+> ⚠️ **Le texte de licence n'est PAS téléchargé** (audit 2026-09-07) : le
+> script ne récupère que `default.sf2`. L'obligation de crédit de la licence
+> GeneralUser GS n'est donc pas matériellement satisfaite côté distribution.
+> Suivi dans `assets/ASSET-LICENSES.md`.
```

---

## 7. Reproductibilité du build et release (§BQ, BR)

### 7.1 `npm run build` (Vite) — **reproductible, mesuré**

```
$ npm run build      →  ✓ 32 modules transformed, built in 1.25s
                         dist/index.html                618.10 kB
                         dist/assets/index-DyKps_rd.css 525.68 kB
$ find dist -type f | sort | xargs sha256sum > build1.txt   (356 fichiers, 11 Mo)
$ npm run build && find dist -type f | sort | xargs sha256sum > build2.txt
$ diff build1.txt build2.txt
BUILD IS BIT-FOR-BIT IDENTICAL ACROSS TWO RUNS
```

**PASS, niveau 2** — déterminisme vérifié sur la **même machine, même
`node_modules`**. Ce qui n'est **pas** vérifié : reproductibilité entre
machines / versions de Node / dates. Les leviers manquants pour y arriver :

| Levier | État | Effort |
|---|---|---|
| Toolchain épinglée | `vite: ^8.0.2`, `oxc` (minifieur) en `^` | ajouter un `.nvmrc` + `engines.node` déjà présent ; épingler exactement `vite` |
| `SOURCE_DATE_EPOCH` | non utilisé (Vite n'écrit pas d'horodatage → sans objet ici) | néant |
| Vérification en CI | **aucune** | job `build` de §5.5 (2 passes + diff) |

### 7.2 `package-lock.json` — **cohérent**

```
lockfileVersion 3 | lock name/version: gmboop 0.8.1 | pkg version: 0.8.1
dependencies MATCH · devDependencies MATCH · optionalDependencies MATCH
total locked packages: 738
locked pkgs without integrity hash: 0 | without resolved URL: 0
$ npm ci --ignore-scripts --dry-run   → OK
```

**PASS.** Les 738 entrées portent toutes un `integrity` SHA-512 et une URL
`resolved` : l'installation est vérifiable. Deux réserves mineures :

- le bloc `overrides` de `package.json` (`node-gyp>=10`, `tar>=7.5.21`) n'est
  **pas** recopié dans `packages[""]` du lock — le lock a été généré avant
  l'ajout du bloc. Les versions résolues respectent bien les contraintes
  (`node-gyp 12.2.0`, `tar 7.5.22`), donc aucun effet pratique, mais la
  provenance de l'override n'est pas enregistrée. Un `npm install` de
  régénération le corrigera ;
- il faudra le régénérer de toute façon pour ajouter `mqtt` (F-156) — c'est
  l'occasion.

### 7.3 Packaging Docker — **FAIL, l'image ne se construit pas**

`docs/audit/2026-08-22` classait §B04 en `NOT TESTED` (« jamais tenté »).
Docker est disponible ici. Testé :

```
$ printf 'FROM scratch\nCOPY locales/ ./locales/\n' > /tmp/D && docker build -f /tmp/D .
Dockerfile.locales:2
   1 |     FROM scratch
   2 | >>> COPY locales/ ./locales/
ERROR: failed to build: failed to solve: failed to compute cache key:
       failed to calculate checksum of ref …: "/locales": not found
```

**`Dockerfile:30` — `COPY locales/ ./locales/`** référence un répertoire
racine `locales/` qui **n'existe pas** : les traductions vivent dans
`public/locales/` (déjà couvertes par `COPY public/`). **Le `docker build`
échoue donc systématiquement, et personne ne s'en est aperçu parce que la
CI ne construit jamais l'image.** `docker-compose.yml` (`build: .`) est
inutilisable pour la même raison.

Et **même une fois cette ligne retirée, l'image serait cassée au démarrage** :

```
$ printf 'FROM scratch\nCOPY shared/ ./shared/\n' | docker build -f - .   → OK (le répertoire existe)
$ grep -n "COPY" Dockerfile        →  package.json, server.js, src/, public/, migrations/, locales/
$ grep -rn "shared/" src/ | head
src/api/WsOutputQueue.js:29             import codec from '../../shared/BinaryFrameCodec.js';
src/midi/gm/InstrumentFamilies.js:28    path.resolve(__dirname, '../../../shared/instrument-families.json');
src/midi/adaptation/InstrumentTypeConfig.js:26   '../../../shared/gm-instrument-capabilities.json'
src/utils/MidiUtils.js:16               shared/gm-instrument-names.json
```

**`shared/` n'est jamais copié** alors que `WsOutputQueue.js` l'importe
statiquement au chargement du module → `ERR_MODULE_NOT_FOUND` au boot.

Troisième défaut : `npm ci --omit=dev --ignore-scripts` saute le `postinstall`,
donc **ni le soundfont ni `WebAudioFontPlayer.js`** ne sont dans l'image → le
synthé du navigateur retombe sur le `document.write` vers le CDN
(`public/index.html:6011`, **F-14**) — ce qui rend l'image inutilisable
hors-ligne, exactement le contraire de la promesse « offline-first ».

**Correctif proposé :**

```diff
--- a/Dockerfile
+++ b/Dockerfile
@@ Stage 1
 WORKDIR /app
 COPY package.json package-lock.json ./
 RUN npm ci --omit=dev --ignore-scripts
+
+# Les assets d'exécution (soundfont + WebAudioFontPlayer) sont récupérés par le
+# postinstall, sauté ci-dessus. Sans eux, la SPA retombe sur un CDN public :
+# c'est la négation du « offline-first » (audit F-14). On les récupère
+# explicitement, dans l'étape builder, en tolérant l'échec réseau.
+COPY scripts/install-default-sf2.js ./scripts/
+RUN node scripts/install-default-sf2.js || \
+    echo "WARN: assets non récupérés — image sans synthé hors-ligne"
@@ Stage 2
 COPY --from=builder /app/node_modules ./node_modules
+COPY --from=builder /app/assets ./assets
+COPY --from=builder /app/public/lib ./public/lib
 COPY package.json ./
+COPY LICENSE README.md ./
 COPY server.js ./
 COPY src/ ./src/
+COPY shared/ ./shared/
 COPY public/ ./public/
 COPY migrations/ ./migrations/
-COPY locales/ ./locales/
```

```diff
--- a/.dockerignore
-*.md
+*.md
+!README.md
+!assets/sf2/README.md
```

*(La redistribution du logiciel doit embarquer `LICENSE` — cf. §6.1.)*

**Note pour L11 :** avec ce correctif le build devrait passer ; je ne l'ai
**pas** appliqué (fichier partagé) et n'ai donc **pas** vérifié le boot réel.
Le job `docker` de §5.5 le vérifiera à chaque PR.

### 7.4 `dist/` n'est pas auto-suffisant — le vendoring offline est annulé en prod

```
$ ls dist/
assets  index.html  js  locales  styles          ← pas de lib/
$ grep -n "lib/" public/index.html
6008:    <script src="lib/WebAudioFontPlayer.js"></script>
6011:      document.write('<scr'+'ipt src="https://surikov.github.io/…">…')
$ grep -n "const dirs" vite.config.js
  const dirs = ['js', 'locales', 'assets', 'styles'];
```

`vite.config.js` copie 4 répertoires et **oublie `lib/`**. Or
`src/api/HttpServer.js:271-274` sert `dist/` dès que `NODE_ENV=production` et
que `dist/index.html` existe. **En production, `lib/WebAudioFontPlayer.js`
renvoie donc 404 et la page bascule sur le `document.write` vers le CDN** —
même quand le fichier a été correctement récupéré à l'installation.

C'est une **aggravation directe de F-14** : le mécanisme de repli offline
existe (le fichier est bien vendorisé dans `public/lib/`), mais le build de
production l'annule.

```diff
--- a/vite.config.js
+++ b/vite.config.js
 function copyStaticTree() {
-  const dirs = ['js', 'locales', 'assets', 'styles'];
+  // `lib` porte WebAudioFontPlayer.js, vendorisé à l'installation. L'oublier
+  // fait retomber la SPA de production sur le CDN public (audit F-14/F-157).
+  const dirs = ['js', 'locales', 'assets', 'styles', 'lib'];
   return {
```

*(Le job `build` de §5.5 impose désormais la présence de `dist/lib/`.)*

### 7.5 Ce qu'il faudrait pour qu'un tiers reconstruise exactement la même image

| # | Manque | Correctif |
|---|---|---|
| 1 | Aucune version publiée n'est identifiable | tags git + `[Unreleased]` tenu (§3.4) |
| 2 | `Dockerfile` ne construit pas | §7.3 |
| 3 | Image non auto-suffisante (`shared/`, assets) | §7.3 |
| 4 | `dist/` incomplet | §7.4 |
| 5 | Base non épinglée : `FROM node:20-slim` est un tag mouvant | `FROM node:20.19.0-slim@sha256:<digest>` |
| 6 | `apt-get install libasound2` non épinglé | `libasound2=<version>` ou accepter la dérive et le dire |
| 7 | Assets d'exécution sans somme de contrôle | **F-15** (L10) — deux SHA-256 dans `install-default-sf2.js` |
| 8 | Aucun artefact publié ni signé | GitHub Release avec `dist.tar.gz` + `SHA256SUMS`, idéalement une attestation SLSA (`actions/attest-build-provenance`) |
| 9 | Aucun SBOM | `npm sbom --sbom-format cyclonedx > sbom.json` dans le job `build` |
| 10 | Le build Vite n'est jamais exercé en CI | job `build` de §5.5 |

**Verdict §BR : PARTIAL.** Le socle est sain (lockfile intègre, build
déterministe localement) ; ce qui manque est la **chaîne** : rien n'est
tagué, rien n'est publié, rien n'est vérifié, et le seul format de
distribution documenté (Docker) est cassé.

### 7.6 Procédure de release proposée — `docs/RELEASE.md` (nouveau)

```markdown
# Procédure de release

## Avant

- [ ] `main` vert sur tous les jobs CI (dont `docker` et `build`).
- [ ] `CHANGELOG.md` : la section `## [Unreleased]` est complète
      (`git log $(git describe --tags --abbrev=0)..HEAD --oneline`).
- [ ] `node scripts/audit/ratchet.mjs` passe (schémas, docs, code mort).
- [ ] `node scripts/audit/licenses.mjs` passe.
- [ ] `npm audit --omit=dev --audit-level=high` passe, ou l'exception est
      re-datée dans `docs/SECURITY-EXCEPTIONS.md`.
- [ ] La checklist matérielle `docs/audit/2026-09-07/15_HARDWARE_QA_CHECKLIST.md`
      a été exécutée sur un Pi réel pour toute release `MINOR`.

## Release

1. `npm version <patch|minor> --no-git-tag-version` (met à jour
   `package.json` **et** `package-lock.json`).
2. Renommer `## [Unreleased]` en `## [X.Y.Z] - AAAA-MM-JJ` et rouvrir un
   `## [Unreleased]` vide.
3. `git commit -am "chore(release): vX.Y.Z"`.
4. `git tag -a vX.Y.Z -m "vX.Y.Z"` puis `git push --follow-tags`.
5. Le job `version` valide tag ↔ `package.json` ↔ `package-lock.json` ↔
   `CHANGELOG.md` ; le job `build` publie `dist.tar.gz` + `SHA256SUMS` + `sbom.json`.
6. Créer la GitHub Release à partir de la section CHANGELOG.

## Après

- [ ] `wiki/Home.md` : mettre à jour la ligne « Status: beta (vX.Y.Z) ».
- [ ] Vérifier qu'un `scripts/update.sh` depuis la version précédente
      atteint bien le nouveau tag.
```

---

## 8. Cohérence du wiki avec `docs/` et le code

`wiki/` (25 pages, 141 Ko) est publié sur le wiki GitHub par
`.github/workflows/wiki-sync.yml` à chaque poussée sur `main` touchant
`wiki/**`. C'est donc **la documentation publique du projet** — et c'est la
plus fausse.

### 8.1 `wiki/API-Reference.md` invente 17 commandes

Croisement de chaque commande citée avec les 270 réellement enregistrées :

| Ligne | Commandes citées | Existent ? |
|---|---|---|
| `:53` Routing | `routing_set`, `routing_delete`, `routing_list`, `routing_get` | **aucune** — les vraies sont `route_*` + `file_routing_sync` |
| `:54` Auto-Assignment | `auto_assign_suggest`, `auto_assign_apply`, `auto_assign_preview` | **aucune** — les vraies sont `generate_assignment_suggestions`, `apply_assignments`, `analyze_channel` |
| `:55` Lighting | `lighting_list_drivers`, `lighting_set_color` | **aucune** |
| `:56` Bluetooth | `bluetooth_scan`, `bluetooth_pair`, `bluetooth_connect` | **aucune** — le préfixe réel est `ble_*` |
| `:58` String Instruments | `string_get_presets`, `string_set_tuning` | **aucune** — les vraies sont `string_instrument_*` |
| `:60` Bank Effects | `bank_list`, `bank_select` | **aucune** — les vraies sont `bank_effects_*` |
| `:61` Instrument Voices | `instrument_voice_select` | **n'existe pas** (`instrument_voice_list` oui) |

**17 commandes sur les 31 citées n'existent pas** (55 %). Un intégrateur
externe qui code contre le wiki écrit un client qui ne fonctionne pas.

### 8.2 Le wiki documente deux trames de protocole fausses

**Trame d'erreur.** Le wiki (`:80-90`) :

```json
{ "type": "error", "id": "abc-123",
  "error": { "code": "DEVICE_NOT_FOUND", "message": "…", "details": { } } }
```

Le code (`src/api/CommandRegistry.js:236-246`) :

```js
{ id: message?.id, type: 'error', command: message?.command,
  error: isKnownError ? error.message : 'Internal server error',
  code:  isKnownError ? error.code    : undefined,
  timestamp: Date.now() }
```

`error` est une **chaîne**, pas un objet ; `code` est **frère** de `error`,
pas imbriqué ; il n'existe **aucun** champ `details` ; il existe un champ
`command` non documenté. **Tout client qui lit `err.error.message` reçoit
`undefined`.**

**Trame d'événement.** Le wiki (`:17`) : « les diffusions arrivent comme
`{ "type": "event", "name": "...", "data": ... }` ». Le code
(`src/api/WebSocketServer.js:286-293`, `WsOutputQueue.js:274`) émet
`{ type: 'event', event: '<nom>', data, … }`. **La clé est `event`, pas
`name`.** `docs/API.md:348` donne, lui, la bonne forme — **le wiki et
`docs/API.md` se contredisent**.

### 8.3 Le contrat d'ajout de commande est faux (à deux endroits)

```
wiki/API-Reference.md:73    2. Export `{ commands: { my_command: handler } }`.
wiki/Contributing.md:60     2. Export `{ commands: { my_command: handler } }` — le CommandRegistry auto-découvre.
docs/ARCHITECTURE.md:114    3. Each module exports `{ commands: { commandName: handler } }`
```

Le contrat réel (`CommandRegistry.js:102`, `src/api/commands/*.js`,
et **correctement décrit dans `CLAUDE.md`**) :

```js
export function register(registry, app) {
  registry.register('my_command', (data) => myHandler(app, data));
}
```

Trois documents sur quatre donnent la mauvaise recette ; c'est la première
chose que lit un nouveau contributeur. `wiki/API-Reference.md:77` ajoute
« Add tests under `tests/unit/` » — **répertoire qui n'a jamais existé**.

Et `CONTRIBUTING.md:20` renvoie vers ce même wiki en affirmant : « It's the
maintained reference and **stays in sync with the codebase** ». C'est
précisément l'inverse.

### 8.4 Décomptes et images

- `wiki/API-Reference.md:49` : « 146 commands across 15 modules » → **270 / 28**.
- `wiki/Home.md:47` : « Drive 146 WebSocket commands » → **270**.
- `wiki/Home.md:7` : « beta (v0.8.2) » alors que le runtime annonce 0.8.1 (§3.1).
- `wiki/Deployment.md:64` : « Backups are written **next to the live
  database** » → faux, ils vont dans `backups/`
  (`BackupScheduler.js:28` `DEFAULT_BACKUP_DIR = …/backups`).
- **Images : 15 des 32 référencées sont manquantes (47 %).** Toutes sont
  citées par URL absolue `.../blob/main/...?raw=true`, donc la page publiée
  affiche des images cassées :

| Fichier manquant | Référencé par |
|---|---|
| `docs/images/loop/loop-manager-{header,library,pad,keyboard,arranger,live}.png` (6) | `wiki/Interface-Loop-Manager.md` |
| `docs/images/loop/loop-editor-{overview,piano,pianoroll,output}.png` (4) | `wiki/Interface-Loop-Manager.md` |
| `docs/images/virtual keyboard/piano virtuel {list,wind,wind slider}.png` (3) | `wiki/Interface-Virtual-Piano.md` |
| `docs/images/auto assign.png`, `docs/images/edit tab.png` (2) | `docs/`, wiki |

Le répertoire `docs/images/loop/` **n'existe pas du tout**. Le wiki liste
d'ailleurs ces images dans une section « Screenshots to capture » (`:177`) —
elles sont donc **planifiées mais déjà référencées en dur** dans le corps de
la page.

### 8.5 Ce que le wiki fait bien

- **Aucun lien relatif** : toutes les références au dépôt sont des URL
  absolues `github.com/glloq/…`, ce qui est **la bonne pratique** pour un wiki
  publié dans un dépôt séparé (`grep -c "!\[" wiki/*.md | grep -v https` → 0).
- Les chemins de fichiers source cités existent tous sauf `tests/unit/`.
- La couverture fonctionnelle des pages « Interface-* » est riche et à jour
  sur le fond ; c'est la partie **API/contrat** qui a décroché.

### 8.6 Correctifs proposés

```diff
--- a/wiki/API-Reference.md
-## Command Modules (146 commands across 15 modules)
+## Command Modules (270 commands across 28 modules)

 | Module | Count | Examples |
 |---|---|---|
 | **Device Management** | 21 | `device_list`, `device_info`, … |
 | **MIDI Messages** | 8 | `midi_send_note`, `midi_send_cc`, … |
-| **File Management** | 14 | `file_list`, `file_read`, … |
-| **Playback** | 16 | `playback_start`, … |
-| **Routing** | 12 | `routing_set`, `routing_delete`, `routing_list`, `routing_get` |
-| **Auto-Assignment** | 8 | `auto_assign_suggest`, `auto_assign_apply`, `auto_assign_preview` |
-| **Lighting** | 15 | `lighting_list_drivers`, `lighting_set_color`, `lighting_effect_start` |
-| **Bluetooth** | 6 | `bluetooth_scan`, `bluetooth_pair`, `bluetooth_connect` |
-| **Serial / GPIO MIDI** | 7 | `serial_list`, `serial_open`, `serial_close` |
-| **Playlists** | 10 | `playlist_create`, `playlist_add_file`, `playlist_remove_file` |
-| **String Instruments** | 8 | `string_get_presets`, `string_set_tuning` |
-| **Sessions** | 5 | `session_load`, `session_save` |
-| **Bank Effects** | 5 | `bank_list`, `bank_select` |
-| **Virtual Instruments** | 6 | `virtual_create`, `virtual_delete`, `virtual_list` |
-| **Instrument Voices** | 4 | `instrument_voice_list`, `instrument_voice_select` |
+| **File Management** | 23 | `file_list`, `file_read`, `file_write`, `file_export` |
+| **Playback** | 23 | `playback_start`, `playback_seek`, `playback_set_tempo`, `apply_assignments` |
+| **Routing** | 21 | `route_create`, `route_list`, `file_routing_sync`, `monitor_start` |
+| **Lighting** | 38 | `lighting_device_list`, `lighting_effect_start`, `lighting_master_dimmer` |
+| **Bluetooth (BLE)** | 9 | `ble_scan_start`, `ble_connect`, `ble_paired` |
+| **Serial / GPIO MIDI** | 6 | `serial_scan`, `serial_open`, `serial_close` |
+| **Playlists** | 15 | `playlist_create`, `playlist_add_file`, `playlist_start` |
+| **String Instruments & Tablature** | 15 | `string_instrument_create`, `tablature_save` |
+| **Sessions / Presets** | 12 | `session_save`, `session_load`, `preset_save` |
+| **Bank Effects** | 4 | `bank_effects_list`, `bank_effects_update` |
+| **Virtual Instruments** | 7 | `virtual_create`, `virtual_delete`, `virtual_list` |
+| **Instrument Voices** | 5 | `instrument_voice_list`, `instrument_voice_create` |
+| **Instrument Lighting (CC)** | 6 | `instrument_light_get`, `instrument_light_set` |
+| **Loops & Arrangements** | 16 | `loop_create`, `arrangement_create`, `arrangement_add_block` |
+| **Hotspot / Wi-Fi** | 10 | `hotspot_enable`, `wifi_scan`, `wifi_connect` |
+| **Latency & Calibration** | 16 | `latency_measure`, `calibrate_delay`, `tuner_monitor_start` |
+| **System** | 11 | `system_status`, `system_backup`, `system_restore`, `system_reboot` |
+
+> Les décomptes sont vérifiés en CI (`node scripts/audit/ratchet.mjs`).
+> La liste complète, avec les paramètres, vit dans `docs/API.md` — cette page
+> n'est qu'un index.
```

```diff
--- a/wiki/API-Reference.md
-The `id` correlates request and response. Asynchronous broadcasts (events)
-arrive as `{ "type": "event", "name": "...", "data": ... }` without an `id`.
+The `id` correlates request and response. Asynchronous broadcasts (events)
+arrive as `{ "type": "event", "event": "...", "data": ... }` without an `id`
+(the key is `event`, not `name`).
@@
 ## Error Shape
-```json
-{ "type": "error", "id": "abc-123",
-  "error": { "code": "DEVICE_NOT_FOUND", "message": "…", "details": { } } }
-```
+```json
+{ "id": "abc-123", "type": "error", "command": "device_info",
+  "error": "No device with id 'piano-1'", "code": "NOT_FOUND",
+  "timestamp": 1234567890 }
+```
+
+`error` is a **string**, not an object. `code` sits next to it and is present
+only for `ApplicationError` subclasses (`src/core/errors/`); any other throw
+is masked as `"Internal server error"` with no `code`.
```

```diff
--- a/wiki/API-Reference.md      (identique dans wiki/Contributing.md:59-61)
 ## Adding a Command
 1. Create or edit a module in `src/api/commands/`.
-2. Export `{ commands: { my_command: handler } }`.
-3. The `CommandRegistry` auto-discovers it on startup.
-4. Add tests under `tests/unit/` and document the parameters in `docs/API.md`.
+2. Export `register(registry, app)` and bind each handler inside it:
+   ```js
+   export function register(registry, app) {
+     registry.register('my_command', (data) => myHandler(app, data));
+   }
+   ```
+3. The `CommandRegistry` auto-discovers every `*.js` of that directory at startup.
+4. Add the payload schema to the matching `src/api/commands/schemas/*.schemas.js`
+   — without it the validator lets **anything** through (audit F-03).
+5. Add tests under `tests/` and document the command in `docs/API.md`.
+   The CI ratchet (`scripts/audit/ratchet.mjs`) refuses a PR that lowers the
+   schema or documentation coverage.
```

```diff
--- a/wiki/Home.md
-> **Status:** beta (v0.8.2). …
+> **Status:** beta (v0.8.2 — see `package.json` for the authoritative version). …
@@
-| Drive 146 WebSocket commands | [[API-Reference]] |
+| Drive 270 WebSocket commands | [[API-Reference]] |
```

```diff
--- a/wiki/Deployment.md
-A scheduled backup runs daily via `src/persistence/BackupScheduler.js`.
-Backups are written next to the live database.
+A scheduled backup runs daily via `src/persistence/BackupScheduler.js`.
+Backups are written to `backups/` at the project root (`DEFAULT_BACKUP_DIR`),
+not next to the live database.
```

```diff
--- a/CONTRIBUTING.md
-see the **[Contributing page on the wiki](…)**. It's the maintained
-reference and stays in sync with the codebase.
+see the **[Contributing page on the wiki](…)**.
+
+> Le contrat qui fait autorité pour ajouter une commande WS ou un driver est
+> `CLAUDE.md` (§ Command pattern) — il est vérifié en CI. Le wiki en est un
+> reflet et peut décrocher (audit 2026-09-07, F-160).
```

Enfin, les 10 images `docs/images/loop/*` référencées mais absentes doivent
être **soit capturées, soit retirées** de `wiki/Interface-Loop-Manager.md`
(la section « Screenshots to capture » de la même page suffit à porter la
demande). Idem pour les 3 de `wiki/Interface-Virtual-Piano.md`.

---

## 9. Reproduction

Toutes les mesures de ce rapport, dans l'ordre :

```bash
# §1 — inventaire des commandes (le JSON alimente les tableaux)
node scripts/audit/command-inventory.mjs --json > /tmp/inv.json
node scripts/audit/command-inventory.mjs

# §1.1 — documentation stricte (ligne de tableau) vs permissive (backtick)
node -e "
const fs=require('fs'), src=fs.readFileSync('docs/API.md','utf8');
const reg=new Set(require('/tmp/inv.json').rows.map(r=>r.command));
const strict=new Set([...src.matchAll(/^\|\s*\`([a-z][a-z0-9_]+)\`\s*\|/gm)].map(m=>m[1]));
const loose =new Set([...src.matchAll(/\`([a-z][a-z0-9_]{2,})\`/g)].map(m=>m[1]));
console.log('lignes de tableau =',[...strict].filter(c=>reg.has(c)).length,
            '| tokens permissifs =',[...loose].filter(c=>reg.has(c)).length);"

# §1.2 — la liste des 83
node -e "
const rows=require('/tmp/inv.json').rows.filter(r=>!r.documented);
const by={}; for(const r of rows)(by[r.module]=by[r.module]||[]).push(r);
for(const m of Object.keys(by).sort()) console.log(by[m].length, m, by[m].map(r=>r.command).join(' '));
console.log('TOTAL', rows.length);"

# §2.3 — chemins morts dans les docs actives (script proposé pour la CI)
node scripts/audit/doc-paths.mjs        # cf. le corps du script ci-dessous

# §3 — versionnement
git tag -l ; git log -S'"version": "0.8.2"' --oneline -- package.json
git log --oneline -1 -- CHANGELOG.md ; git rev-list --count 50f3e8c..HEAD
git log --format='%s' 50f3e8c..HEAD | sed -E 's/^([a-z]+).*/\1/' | sort | uniq -c | sort -rn

# §4.1 — F-09
node scripts/audit/dead-modules.mjs
grep -rn "messages/MidiMessage\|from '.*MidiMessage.js'" --include=* . \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=docs

# §4.5 — dépendances déclarées vs importées (les deux sens)
grep -rhoE "await import\(\s*['\"]([a-z@][^'\"]*)['\"]" --include=*.js src/ \
 | sed -E "s/.*['\"]([^'\"]*)['\"]/\1/" | sort -u | while read m; do
   node -e "const p=require('./package.json');
     const a={...p.dependencies,...p.devDependencies,...p.optionalDependencies};
     process.exit(a['$m']?0:1)" || echo "UNDECLARED: $m"; done

# §5.1 — F-17
npx prettier --check src/api/commands/FileCommands.js src/midi/adaptation/NoteEnforcement.js \
  src/midi/adaptation/VoiceSelector.js src/midi/instrument/CapabilityResolver.js \
  src/midi/playback/PlaybackScheduler.js src/midi/routing/MidiRouter.js \
  public/js/features/auto-assign/HandPositionFeasibility.js public/js/features/SystemAdminModal.js \
  tests/ble-midi-decode.test.js tests/capability-resolver.test.js \
  tests/playback-schemas-t5-4.test.js tests/scoring-edge-cases-t6.test.js tests/voice-selector.test.js

# §5.3 — portes npm audit
npm audit --omit=dev --audit-level=critical ; echo "critical -> $?"
npm audit --omit=dev --audit-level=high     ; echo "high     -> $?"

# §6.3 — assets
grep -rl svgrepo public/assets/ | wc -l ; find public/assets -name '*.svg' | wc -l
head -3 public/assets/instruments/trumpet.svg
ls LICENSE* COPYING* 2>/dev/null || echo "aucun fichier de licence"
grep -in "sha\|hash\|checksum" scripts/install-default-sf2.js || echo "aucune vérification d'intégrité"

# §7.1 — déterminisme du build
npm run build && find dist -type f | sort | xargs sha256sum > /tmp/b1
npm run build && find dist -type f | sort | xargs sha256sum > /tmp/b2 && diff /tmp/b1 /tmp/b2

# §7.3 — le Dockerfile ne construit pas
printf 'FROM scratch\nCOPY locales/ ./locales/\n' > /tmp/Dockerfile.probe
docker build -f /tmp/Dockerfile.probe -t probe .     # ERROR: "/locales": not found
```

Script `scripts/audit/doc-paths.mjs` proposé (utilisé en §2.3, à ajouter à la CI) :

```js
/**
 * @file scripts/audit/doc-paths.mjs
 * @description Échoue si une doc active cite un chemin du dépôt qui n'existe
 * plus. Les rapports d'audit (docs/audit/) sont exclus : ils décrivent un
 * instant passé, pas l'état courant.
 */
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const walk = (d, acc = []) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', '.git', 'coverage', 'dist'].includes(e.name)) continue;
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (p.endsWith('.md')) acc.push(p);
  }
  return acc;
};
const docs = [
  ...walk(join(ROOT, 'docs')).filter((p) => !p.includes(`${'docs'}/audit/`)),
  ...walk(join(ROOT, 'wiki')),
  join(ROOT, 'README.md'), join(ROOT, 'CLAUDE.md'), join(ROOT, 'CONTRIBUTING.md')
];
// Les ADR citent volontairement des arborescences REJETÉES : on les ignore.
const SKIP_FILE = /docs\/adr\//;
const RE = /(?:`|\(|\[|\s)((?:src|public|tests|scripts|migrations|shared|assets)\/[A-Za-z0-9_\-./]*[A-Za-z0-9_\-/])/g;

let bad = 0;
for (const d of docs.filter((p) => !SKIP_FILE.test(p))) {
  const src = readFileSync(d, 'utf8');
  const seen = new Set();
  for (const m of src.matchAll(RE)) {
    const p = m[1].replace(/[.,)]+$/, '');
    if (p.includes('*') || seen.has(p)) continue;
    seen.add(p);
    if (!existsSync(join(ROOT, p))) {
      const line = src.slice(0, m.index).split('\n').length;
      console.error(`FAIL  ${d.slice(ROOT.length + 1)}:${line}  chemin inexistant: ${p}`);
      bad++;
    }
  }
}
console.log(bad ? `\n${bad} chemin(s) mort(s) dans les docs actives.` : 'Aucun chemin mort.');
process.exit(bad ? 1 : 0);
```

---

## 10. Findings — détail

### F-156 — P1 — Le driver d'éclairage MQTT ne peut fonctionner sur aucune installation

**Section :** BR · **État :** FAIL · **Niveau :** 5 (reproduit mécaniquement)

`src/lighting/MqttLightDriver.js:22` fait `await import('mqtt')`. Le paquet
`mqtt` n'est déclaré **ni** en `dependencies`, **ni** en `devDependencies`,
**ni** en `optionalDependencies`, et `node_modules/mqtt` est absent après un
`npm install` complet. Le driver est pourtant promis par `README.md:115`,
quatre pages du wiki, `docs/ARCHITECTURE.md:101`, et **offert dans le
sélecteur de type de périphérique lumineux**
(`public/js/features/lighting/LightingForms.js:29`). L'échec est avalé par le
`catch` de `LightingManager.js:161` et présenté à l'utilisateur comme un
simple « non connecté ».

**Correctif :** §4.5 (déclarer `mqtt` en `optionalDependencies` + message
d'erreur explicite). **Croisement :** L02 (couverture lighting 2,35 %),
L13 (promesse non tenue).

### F-157 — P1 — Le packaging est cassé : `docker build` échoue, l'image et `dist/` sont incomplets

**Section :** BR · **État :** FAIL · **Niveau :** 5

Trois défauts cumulés :
1. `Dockerfile:30` `COPY locales/ ./locales/` → répertoire inexistant,
   **le build échoue** (`"/locales": not found`, reproduit §7.3).
2. `shared/` n'est jamais copié alors que `src/api/WsOutputQueue.js:29`
   l'importe statiquement → crash au démarrage même après correction de (1).
3. `vite.config.js` `copyStaticTree` oublie `lib/` → `dist/` ne contient pas
   `WebAudioFontPlayer.js`, la SPA de production retombe sur le CDN
   (`public/index.html:6011`), **annulant le vendoring offline** (aggrave F-14).

**Correctifs :** §7.3 et §7.4. **Porte CI :** job `docker` (build + smoke
`/api/health`) et job `build` (intégrité de `dist/`) de §5.5.
**Croisement :** L11 (§B04, F-14).

### F-158 — P1 — Licences : pas de `LICENSE`, assets non tracés, README de soundfont mensonger

**Section :** BS · **État :** FAIL · **Niveau :** 4

1. **Aucun fichier `LICENSE`** alors que `package.json`, le badge README et la
   section « License » annoncent MIT. La clause d'inclusion de la notice est
   inexécutable ; le `Dockerfile` ne copie de toute façon aucun `.md`.
2. **61 des 107 SVG livrés** portent le marqueur `SVG Repo`, sans licence ni
   attribution enregistrée nulle part ; ils sont copiés dans `dist/` et
   redistribués. 58 fichiers de plus dans `docs/images/` et `images-a-faire/`.
3. **`assets/sf2/README.md` affirme deux faussetés** : que le téléchargement
   vérifie un SHA-256 (aucun hachage dans le script) et que le texte de la
   licence GeneralUser GS est déposé à côté du `.sf2` (jamais téléchargé) —
   l'obligation de crédit n'est donc pas satisfaite.
4. `public/lib/WebAudioFontPlayer.js` est exécuté comme JavaScript dans le
   navigateur avec, de l'aveu du script (`:54-55`), une licence exigeant
   l'attribution — attribution absente.

**Correctifs :** §6.1 (`LICENSE`), §6.3 (`assets/ASSET-LICENSES.md` + décision
sur les 61 icônes), §6.4 (rectifier `assets/sf2/README.md`), §6.2
(`THIRD-PARTY-NOTICES.md` pour les 5 paquets Apache-2.0).
**Porte CI :** job `licenses` (§5.5). **Croisement :** L10 (F-15).

### F-159 — P2 — `docs/API.md` et les docs de référence divergent du code

**Section :** BC/BD · **État :** FAIL · **Niveau :** 4

- **83 commandes sur 270 non documentées** (§1.2) ; **7 familles entières à
  0 %** (43 commandes), dont `HotspotCommands` (réseau du Pi) et
  `InstrumentLightCommands` ; `system_reboot` non documentée **et** sans schéma.
- **Sur 24 commandes documentées échantillonnées : 7 FAIL, 5 PARTIAL** (§1.3).
  4 commandes implémentées sont annoncées « *(planned)* » (dont
  `system_restore`) ; `apply_assignments` cache un paramètre **destructif**
  (`overwriteOriginal`) ; `playlist_add_file` cache un paramètre obligatoire.
- 3 en-têtes de comptage faux ; la section « API surface not consumed by the
  bundled SPA » est démentie pour `midi_panic` et `file_channels` ; aucune
  trame d'erreur documentée.
- `docs/ARCHITECTURE.md` : 9 écarts (§2.2), dont le **contrat d'enregistrement
  de commande** et la **sémantique transactionnelle des migrations**.
- `CLAUDE.md` accuse à tort `ARCHITECTURE.md` d'être périmé (§2.1).
- ADR-003 documente une option (`_vN`) que le code n'a pas retenue (§2.4).
- `.env.example` omet **8 variables `GMBOOP_*`** alors que deux docs le
  présentent comme exhaustif (§2.5).
- **25 chemins morts** dans 14 docs actives (§2.3).

**Correctifs :** §1.6, §2.6. **Porte CI :** jobs `contract` + `docs` (§5.5).

### F-160 — P2 — Le wiki publié documente une API qui n'existe pas

**Section :** BC · **État :** FAIL · **Niveau :** 4

`wiki/` est publié automatiquement sur le wiki GitHub — c'est la doc publique.
`wiki/API-Reference.md` **invente 17 commandes** sur 31 citées (`routing_*`,
`auto_assign_*`, `bluetooth_*`, `bank_*`, …), documente une **trame d'erreur
fausse** (`error` objet au lieu de chaîne) et une **trame d'événement fausse**
(`name` au lieu de `event`, en contradiction avec `docs/API.md`), donne un
**contrat d'ajout de commande faux** (repris dans `wiki/Contributing.md`), et
renvoie vers `tests/unit/` qui n'a jamais existé. Décomptes faux (146 vs 270,
15 modules vs 28), version incohérente, répertoire de sauvegarde erroné.
**15 des 32 images référencées sont manquantes (47 %)** — le répertoire
`docs/images/loop/` n'existe pas. Et `CONTRIBUTING.md:20` certifie que ce
wiki « stays in sync with the codebase ».

**Correctifs :** §8.6.

### F-161 — P2 — Versionnement incohérent et absence totale de processus de release

**Section :** BQ · **État :** FAIL · **Niveau :** 4

`package.json` = 0.8.1, **jamais bumpé** (`git log -S'"version": "0.8.2"'` →
vide), et c'est ce que `/api/health` et la métrique `gmboop_info` annoncent.
`CHANGELOG.md` proclame `[0.8.2] - 2026-05-17` et **n'a pas bougé depuis
226 commits** (33 `feat`, 51 `fix`, ~4 mois). `wiki/Home.md` et
`docs/V0.9_ROADMAP.md` disent 0.8.2. **Aucun tag git n'existe.** Aucune
procédure de release n'est écrite nulle part, et `scripts/update.sh` tire la
**pointe de `main`** — un utilisateur qui met à jour reçoit un état non tagué
et non validé.

**Correctifs :** règle de versionnement §3.4, correctif §3.5,
`docs/RELEASE.md` §7.6. **Porte CI :** job `version` (§5.5).

### F-162 — P2 — La CI ne verrouille aucune propriété du produit

**Section :** BP · **État :** PARTIAL · **Niveau :** 4

*(F-17 est confirmé corrigé — §5.1.)* Il manque : ratchet de couverture
(`jest.config.cjs` n'a **ni `collectCoverageFrom` ni `coverageThreshold`** →
mesure faussée de ~7 points et aucune porte), ratchet de contrat WS
(86/270 schémas, 187/270 docs peuvent empirer librement ;
`command-inventory.mjs` et `dead-modules.mjs` **sortent toujours 0**), porte
`npm audit` au bon niveau (`critical` laisse passer **3 advisories `high`,
toutes `fixAvailable` et non rupturantes**, dont `ws` en dépendance runtime
directe), contrôle de licences, build Docker (qui aurait attrapé F-157 dès
son introduction), build Vite, E2E, et cohérence de version.

**Correctifs :** diffs §5.4 (`jest.config.cjs`, `scripts/audit/ratchet.mjs`,
`ratchet.json`, `licenses.mjs`, `doc-paths.mjs`) et **workflow complet §5.5**.

> ⚠️ **Action requise en vague 2 :** `format:check` échoue déjà sur 9 fichiers
> de test créés par les lots parallèles. Repasser `prettier --write` sur
> `tests/` après consolidation, sinon `lint` redevient rouge sur `main`.

### F-163 — P3 — Code mort et surface morte au-delà de F-09

**Section :** BC · **État :** FAIL · **Niveau :** 4

- **F-09 confirmé** : `src/midi/messages/MidiMessage.js`, 467 lignes,
  201 statements, 0 importeur statique, inatteignable par les 2 imports
  dynamiques du dépôt, 0 renvoi depuis une doc active. **Suppression sûre**
  (diff §4.1, avec la retouche `TODO.md` + `ARCHITECTURE.md` associée).
- **`mapColorToFixture`** (`src/lighting/DmxFixtureProfiles.js:142`) n'est
  appelé nulle part : les profils de fixtures DMX sont un **catalogue
  consultable, pas un comportement**. Le profil choisi dans l'UI n'est ni
  persisté ni transmis. Promesse du wiki non tenue → **L02**.
- 4 autres fonctions exportées jamais appelées, 12 `export` superflus (§4.2).
- **Table `instrument_light_config` (26 colonnes) morte** — remplacée par
  `instrument_light_state` (migration 027), laissée volontairement en place
  mais **créée sur toute installation neuve** ; proposer une migration 035.
- **8 colonnes orphelines** sur des tables vivantes, dont
  `instruments_latency.descriptor_{revision,json}` (cache de descripteurs v2
  non câblé → **L06/T1.8**) et 3 colonnes de métrologie de calibration.
- **Aucun** CSS orphelin, **aucune** dépendance déclarée inutilisée.

**Correctifs :** §4.1 à §4.4.

---

## 11. Ce que ce lot n'a pas pu conclure

| Point | Raison | Renvoi |
|---|---|---|
| L'image Docker démarre-t-elle une fois les 3 défauts corrigés ? | correctif non appliqué (fichier partagé) | **L11** (§B04) |
| Les 123 commandes sans appelant frontend sont-elles mortes ou internes ? | croisement avec la surface UI réelle | **L01**, **L13** |
| Faut-il câbler `mapColorToFixture` ou retirer la promesse DMX ? | décision fonctionnelle lighting | **L02** |
| Les colonnes `descriptor_json` / `descriptor_revision` doivent-elles être câblées ou supprimées ? | dépend du sort de T1.8 | **L06** |
| La licence exacte de `WebAudioFontPlayer.js` | exige de contacter l'amont | mainteneur |
| La licence par fichier des 61 SVG « SVG Repo » | provenance non enregistrée à l'import | mainteneur (§6.3) |
| Régression matérielle (§BT) | pas de Pi ni d'instruments | **L15** |
