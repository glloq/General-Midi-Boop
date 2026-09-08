# 01 — Contrat WebSocket & API HTTP (lot L01)

**Date :** 2026-09-07 · **Base :** `00_BASELINE.md` (commit `8dc170e`) ·
**Sections du plan couvertes :** T, U, V, AK + BC/BD (partie API)
**Environnement de preuve :** serveur vivant sur le port **8101**, base dédiée
`…/scratchpad/L01/gmboop.db`, token `GMBOOP_API_TOKEN` forcé (aucun `.env`
écrit à la racine). Serveur arrêté et `config.json` vérifié propre en fin de lot.

> **Règle de ce rapport.** Chaque ligne d'état porte sa commande de reproduction
> et sa sortie. Ce qui n'a pas été exécuté est marqué `NOT TESTED`, jamais `PASS`.

---

## 0. Synthèse

| § | Sujet | État | Niveau | Findings |
|---|---|---|---|---|
| **T** | Inventaire HTTP (15 routes) | **PASS** | 3 | F-24 (P3) |
| **T2** | `/api/*` inconnu → 404 JSON | **PASS (corrigé)** | 3 | **F-10 CORRIGÉ** |
| **T3** | Méthodes non autorisées | **PASS (corrigé)** | 3 | via F-10 |
| **T4** | CORS / en-têtes / compression | **PASS** | 3 | — |
| **T5** | Auth HTTP (token, bypass même-origine, `isPrivateClient`) | **PARTIAL** | 2 | non rejouable depuis loopback (voir §7.3) |
| **U1** | Schémas de payload (F-03) | **FAIL** | 3 | **F-03 CONFIRMÉ**, **F-19** (P1) |
| **U2** | Exploitabilité des 184 commandes non validées | **FAIL** | 3 | **F-18 (P0, corrigé)**, F-19, F-20 |
| **U3** | Commandes sans appelant frontend | **PARTIAL** | 1 | **F-26** (P3, outil corrigé) |
| **V1** | Enveloppe & dispatch | **PARTIAL** | 3 | **F-21**, **F-22** |
| **V2** | Fuite d'information / masquage | **PASS** | 3 | F-25 (P3) |
| **V3** | Versionnement des handlers (ADR-003) | **FAIL** | 3 | **F-23** (P3) |
| **AK1** | Limiteur — corrélation des rejets | **PASS (corrigé)** | 3 | **F-06 CORRIGÉ** |
| **AK2** | Limiteur — exemption panic | **PASS (corrigé)** | 3 | **F-07 CORRIGÉ** |
| **AK3** | Limiteur — budgets, trame géante, clients multiples | **PARTIAL** | 3 | soak non fait |

**Bilan.** 3 findings hérités **fermés par correctif prouvé** (F-06, F-07, F-10),
1 hérité **confirmé ouvert et instruit à fond** (F-03), **10 nouveaux findings
F-18 → F-27** dont **un P0 corrigé** (une seule trame WebSocket tuait le
processus) et **un P1 ouvert** (F-19).

### Findings du lot

| # | Sev | Titre | État |
|---|---|---|---|
| **F-18** | **P0** | `lighting_midi_learn` : une trame WS tue tout le processus | ✅ **CORRIGÉ + test** |
| **F-19** | **P1** | La dernière ligne de défense de la validation est le schéma SQLite | 🔴 OUVERT |
| F-20 | P2 | `playback_set_tempo` accepte et mémorise n'importe quelle valeur | 🔴 OUVERT |
| F-21 | P2 | Trame malformée rapportée comme « Internal server error » | 🔴 OUVERT |
| F-22 | P2 | Enveloppe : `id` non-string / dupliqué / absent non contrôlés | 🔴 OUVERT |
| F-23 | P3 | ADR-003 : le champ `version` est accepté et totalement ignoré | 🔴 OUVERT |
| F-24 | P3 | `/api/capabilities` est public mais documenté authentifié | 🔴 OUVERT |
| F-25 | P3 | Les messages d'erreur reflètent l'entrée utilisateur verbatim | 🔴 OUVERT |
| F-26 | P3 | `command-inventory.mjs` ignorait `public/index.html` → chiffre d'orphelines faux | ✅ **OUTIL CORRIGÉ** |
| F-27 | P3 | `eventBus.removeListener` inexistant à 3 autres endroits (hors périmètre) | 🔴 OUVERT (→ L02) |

### Re-statut des findings hérités confiés à L01

| # | Statut initial | Statut final | Preuve |
|---|---|---|---|
| **F-03** | CONFIRMÉ OUVERT | **CONFIRMÉ, instruit** → devient **F-19** | §3 |
| **F-06** | À INSTRUIRE | ✅ **CORRIGÉ** (40/100 commandes pendaient 10 s → 0) | §4.1 |
| **F-07** | À INSTRUIRE | ✅ **CORRIGÉ** (13/19 panics perdus → 0/19) | §4.2 |
| **F-10** | À INSTRUIRE | ✅ **CORRIGÉ** (200 + 615 KB de HTML → 404 JSON) | §7.2 |

---

## 1. Ce que L01 a changé dans le code

| Fichier | Changement | Finding | Test |
|---|---|---|---|
| `src/api/commands/LightingCommands.js` | `eventBus.removeListener` → `eventBus.off` (2 sites) | **F-18** | `tests/audit/l01-ws-contract.test.js` |
| `src/api/WebSocketServer.js` | `peekFrameHead()` + `id`/`code` dans la trame de rejet ; exemption `PRIORITY_COMMANDS` à budget séparé | **F-06, F-07** | `tests/audit/l01-ws-limiter.test.js` |
| `src/api/HttpServer.js` | 404 JSON pour `/api/*` non résolu, avant le repli SPA | **F-10** | `tests/audit/l01-http-contract.test.js` |
| `scripts/audit/command-inventory.mjs` | scanne aussi `public/**.html` ; sépare orpheline « mention seule » / « aucune trace » | **F-26** | — (outil d'audit) |

Aucun fichier partagé (`package.json`, `config.json`, `jest.config.cjs`, CI,
`CLAUDE.md`) n'a été modifié. Trois suites créées, **13 tests, tous verts**,
chacune écrite **rouge d'abord** contre le défaut puis re-passée après correctif.

```
$ node --experimental-vm-modules node_modules/jest/bin/jest.js tests/audit/l01-
PASS tests/audit/l01-ws-contract.test.js    (5 tests)
PASS tests/audit/l01-ws-limiter.test.js     (4 tests)
PASS tests/audit/l01-http-contract.test.js  (4 tests)
```

---

## 2. F-18 (P0) — une seule trame WebSocket tue tout le processus

**C'est le finding le plus grave de ce lot, et il a été trouvé par le fuzzing
des commandes non validées** — pas par lecture.

### Découverte

Pendant le passage automatisé des 167 commandes sans schéma (§3), le serveur
s'est arrêté seul. Le journal :

```
[11:04:03.046] ERROR Uncaught exception: app.eventBus.removeListener is not a function
[11:04:03.046] ERROR TypeError: app.eventBus.removeListener is not a function
    at Timeout._onTimeout (src/api/commands/LightingCommands.js:821:20)
[11:04:03.046] INFO  Received uncaughtException, shutting down gracefully...
[11:04:03.056] INFO  === GeneralMidiBoop 0.8.1 Stopped ===
```

### Cause

`src/core/EventBus.js` expose `on / off / once / emit / listenerCount`. Il
**n'implémente pas** `removeListener` (l'API Node `EventEmitter`).
`lightingMidiLearnStart` l'appelait deux fois :

```js
const timeout = setTimeout(() => {
  app.eventBus.removeListener('midi_message', handler);   // ← TypeError DANS UN TIMER
  resolve({ success: false, error: 'timeout', … });
}, 10000);
const handler = (event) => {
  clearTimeout(timeout);
  app.eventBus.removeListener('midi_message', handler);   // ← TypeError dans emit()
  …
};
```

- **Chemin timeout** : le throw part d'un callback de `setTimeout`. Le
  `try/catch` de `CommandRegistry.handle` est déjà sorti de pile — l'exception
  remonte en `uncaughtException`, et le handler de `Application` **arrête
  proprement toute l'application**.
- **Chemin nominal** : le throw est avalé par le `try/catch` par-listener de
  `EventBus.emit`. Résultat : le listener **n'est jamais détaché** (fuite
  permanente sur le chemin chaud MIDI) et la promesse **ne se résout jamais**
  (la commande pend jusqu'au timeout client).

### Reproduction (une trame, aucun payload)

```bash
# serveur démarré sur 8101, PID connu
$ node t_crash.mjs
server pid 16061 | alive before: true
sending ONE frame: {"id":"KILL","command":"lighting_midi_learn","data":{}}
  t=+4s  alive
  t=+8s  alive
  t=+12s  *** SERVER PROCESS DEAD ***
alive after:  false
```

### Impact

Déni de service distant, **non authentifié depuis le LAN** (le bypass
`trusted-lan` par défaut n'exige pas de token pour un client RFC1918). Un
`lighting_midi_learn` accidentel ou malveillant **coupe l'orchestre en pleine
représentation** ; le service ne redémarre que si un superviseur (PM2/systemd)
est en place. La commande est **documentée dans `docs/API.md`** et
**appelée par le SPA** — ce n'est pas une surface cachée.

### Correctif appliqué

`src/api/commands/LightingCommands.js` : les deux `removeListener` deviennent
`off`, avec le commentaire expliquant le piège.

Vérification en direct après correctif :

```
server up pid=19745 health=200
sending ONE frame: {"id":"KILL","command":"lighting_midi_learn","data":{}}
  reply: {"id":"KILL","type":"response","command":"lighting_midi_learn",
          "data":{"success":false,"error":"timeout","message":"No MIDI event received within 10 seconds"}}
  t=+12s  alive
alive after:  true
```

Test de non-régression : `tests/audit/l01-ws-contract.test.js`
(3 cas : l'absence de `removeListener` sur `EventBus`, le chemin timeout,
le chemin nominal + absence de fuite de listener).

### F-27 (P3) — la même erreur vit ailleurs, hors de mon périmètre

```
$ grep -rn "eventBus.removeListener\|this.eventBus.removeListener" src/
src/lighting/LightingManager.js:215        this.eventBus.removeListener('midi_routed', this._onMidiRouted);
src/lighting/LightingManager.js:218        this.eventBus.removeListener('midi_message', this._onMidiMessage);
src/lighting/instrument/InstrumentLightManager.js:259  this.eventBus?.removeListener?.('instrument_settings_changed', …);
```

Conséquence observée **à chaque arrêt du serveur** :

```
[11:09:11.891] ERROR Stop step "lightingManager" failed (continuing):
               this.eventBus.removeListener is not a function
```

Le lighting **ne se désabonne jamais** du bus MIDI à l'arrêt.
`InstrumentLightManager` utilise `?.` : pas de crash, mais un no-op silencieux
(fuite). Ces trois sites sont hors de `src/api/**` — **délégué à L02**, correctif
d'une ligne chacun (`removeListener` → `off`).

---

## 3. F-03 instruit à fond → F-19 (P1)

### 3.1 Le chiffre, confirmé

```
$ node scripts/audit/command-inventory.mjs
Registered commands       : 270
  with payload schema     : 86 (31.9%)
  schema wired to validator: 86 (31.9%)
```

Inchangé depuis le 2026-08-22. **184 commandes sur 270** passent par le défaut
permissif de `JsonValidator.validateByCommand` (`src/utils/JsonValidator.js:250`).

Répartition par module (fichier de déclaration, pas module logique) :

| Module | sans schéma / total |
|---|---|
| `LightingCommands.js` | **31 / 38** |
| `FileCommands.js` | 16 / 23 |
| `PlaylistCommands.js` | **15 / 15** |
| `StringInstrumentCommands.js` | **15 / 15** |
| `RoutingCommands.js` | 13 / 21 |
| `LatencyCommands.js` | 12 / 16 |
| `InstrumentSettingsCommands.js` | **11 / 11** |
| `SystemCommands.js` | 10 / 11 |
| `BluetoothCommands.js` | 7 / 9 · `HotspotCommands.js` 7 / 10 |
| `InstrumentLightCommands.js`, `SerialCommands.js`, `PlaybackRoutingCommands.js` | **6 / 6** chacun |
| `PlaybackControlCommands.js` | 6 / 10 |
| `DeviceCommands.js` 5/8 · `VirtualInstrumentCommands.js` 5/7 · `InstrumentVoiceCommands.js` **5/5** | |
| `PlaybackAssignmentCommands.js` 3/5 · `DeviceSettingsCommands.js` **2/2** | |
| `LoopArrangementCommands.js` 1/11 · `LoopCommands.js` 1/5 · `SessionCommands.js` 1/6 | |

### 3.2 Le classement du danger, mesuré et non deviné

**Méthode.** Un harnais (`fuzz.mjs`) envoie à **chacune** des commandes non
validées **7 payloads hostiles** :

| Variante | Contenu |
|---|---|
| `empty` | `{}` — champs requis absents |
| `wrongTypes` | 22 champs usuels (`id`, `device_id`, `fileId`, `name`, `enabled`, `bpm`, …) remplis d'objets `{}` ou de chaînes là où un scalaire est attendu |
| `outOfRange` | `-1`, `99999`, `1e308`, `-1e308`, `Number.MAX_SAFE_INTEGER`, `led_count: 1e9` |
| `nullFields` | tous les champs usuels à `null` |
| `deepNest` | objet imbriqué **600 niveaux** |
| `bigArray` | 4 tableaux de **50 000 éléments** |
| `bigString` | chaînes de **200 000 caractères** + `../` × 20 000 |

**17 commandes exclues** de la campagne (effets hôte irréversibles) :
`system_reboot`, `system_shutdown`, `system_restart`, `system_update`,
`system_restore`, `system_clear_logs`, `system_check_update`,
`file_reanalyze_all`, `hotspot_enable`, `hotspot_disable`, `wifi_disconnect`,
`ble_power_on/off`, `lighting_device_scan`, `calibrate_delay`,
`latency_auto_calibrate`, `lighting_midi_learn` (couverte par F-18).

**Résultat : 167 commandes × 7 = 1 169 trames hostiles.**

```
commands fuzzed: 167 | frames: 1169 | denied: 17
uncorrelated frames: 0 | socket deaths: []
{ ACCEPTED: 579, VALIDATION: 399, MASKED_INTERNAL: 138,
  'APPERR:ERR_NOT_FOUND': 46, 'APPERR:ERR_CONFIGURATION': 7 }
```

| Issue | n | % | Lecture |
|---|---:|---:|---|
| `ACCEPTED` | **579** | **49,5 %** | le payload absurde a été **traité comme un succès** |
| `VALIDATION` | 399 | 34,1 % | le handler s'est auto-validé (`ValidationError`) — comportement correct |
| `MASKED_INTERNAL` | **138** | **11,8 %** | throw non-`ApplicationError` → masqué en « Internal server error » : **bug latent** |
| `ERR_NOT_FOUND` / `ERR_CONFIGURATION` | 53 | 4,5 % | refus propre |

**Aucune trame n'a fait tomber le socket** ; la seule mort de processus vient de
F-18 (chemin asynchrone, pas du payload).

### 3.3 Classement par module — mesuré

| Module | cmds | trames | ACCEPTÉ | ERREUR INTERNE | VALIDÉ |
|---|---:|---:|---:|---:|---:|
| `LightingCommands.js` | 29 | 203 | **122** | 23 | 49 |
| `FileCommands.js` | 15 | 105 | 48 | **34** | 22 |
| `LatencyCommands.js` | 10 | 70 | **56** | 7 | 7 |
| `InstrumentSettingsCommands.js` | 11 | 77 | 41 | 11 | 25 |
| `StringInstrumentCommands.js` | 15 | 105 | 38 | 7 | 60 |
| `RoutingCommands.js` | 13 | 91 | 37 | 7 | 19 |
| `PlaybackControlCommands.js` | 6 | 42 | **42 (100 %)** | 0 | 0 |
| `PlaylistCommands.js` | 15 | 105 | 30 | 10 | 65 |
| `DeviceCommands.js` | 5 | 35 | 14 | **21** | 0 |
| `HotspotCommands.js` | 4 | 28 | **28 (100 %)** | 0 | 0 |
| `SerialCommands.js` | 6 | 42 | 15 | 11 | 16 |
| `BluetoothCommands.js` | 5 | 35 | 21 | 0 | 7 |
| `SystemCommands.js` | 3 | 21 | **21 (100 %)** | 0 | 0 |
| `VirtualInstrumentCommands.js` | 5 | 35 | 12 | 4 | 19 |
| `PlaybackRoutingCommands.js` | 6 | 42 | 14 | 1 | 26 |
| `InstrumentLightCommands.js` | 6 | 42 | 9 | 1 | 32 |
| `InstrumentVoiceCommands.js` | 5 | 35 | 2 | 0 | **33** |
| `DeviceSettingsCommands.js` | 2 | 14 | 1 | 1 | **12** |
| autres (`Loop*`, `Session`, `PlaybackAssignment`) | 6 | 42 | 28 | 0 | 7 |

**Correction d'une intuition de l'audit précédent.** Le 2026-08-22 classait
`LightingCommands` en tête « parce que 31 commandes pilotent du réseau et du
GPIO ». La mesure le confirme sur le volume (122 acceptations) **mais montre
que les modules les plus fragiles ne sont pas ceux qu'on croyait** :

- `InstrumentVoiceCommands` et `DeviceSettingsCommands` — 0 schéma déclaré —
  sont en réalité **les mieux protégés** (94 % et 86 % de rejets propres) : leurs
  handlers valident impérativement.
- `PlaybackControlCommands`, `HotspotCommands` et `SystemCommands` acceptent
  **100 %** des payloads hostiles testés. Pour System/Hotspot c'est bénin (les
  commandes testées sont sans paramètre : `system_status`, `system_info`,
  `system_logs`, `hotspot_status`…). Pour **Playback c'est un vrai défaut** →
  F-20.
- `DeviceCommands` transforme **60 % des payloads hostiles en erreur interne** —
  le pire ratio du projet.

### 3.4 F-19 (P1) — ce que le fuzzing révèle vraiment : la validation, c'est SQLite

Les 138 erreurs internes ne sont pas des messages génériques : le journal serveur
montre **de quoi elles sont faites**.

```bash
$ grep -a "Command failed" server.out | sed 's/.*\[cmd=\([a-z_]*\).*Command failed: /\1 :: /' | sort -u
```

| Message serveur | Origine | Commandes concernées |
|---|---|---|
| `Too few parameter values were provided` | **driver better-sqlite3** | 30+ : `file_read`, `file_list`, `file_metadata`, `lighting_rule_add`, `lighting_rule_update`, `playlist_get`, `playlist_start`, `string_instrument_get`, `instrument_save_all`, `route_import`, … |
| `You cannot specify named parameters in two different objects` | **driver better-sqlite3** | `instrument_create_virtual`, `instrument_get_settings`, `string_instrument_create`, `lighting_rule_update`, … |
| `NOT NULL constraint failed: playlists.name` | **contrainte SQL** | `playlist_create` |
| `NOT NULL constraint failed: instruments_latency.device_id` | **contrainte SQL** | `instrument_update_settings`, `device_save_sysex_identity` |
| `CHECK constraint failed: channel BETWEEN 0 AND 15` | **contrainte SQL** | `string_instrument_create` |
| `data.deviceId.startsWith is not a function` | TypeError JS | `instrument_delete` |
| `Cannot read properties of undefined (reading 'id')` | TypeError JS | `route_import` |
| `Port not open: ../../../../../…/etc/passwd` | chaîne hostile propagée | `serial_close` |

**Le constat, et c'est le finding :** un payload WebSocket arbitraire **traverse
la couche API, la couche repository et arrive tel quel dans une requête préparée
SQLite**. Ce qui l'arrête, dans la grande majorité des cas, n'est ni un schéma ni
un `if` de handler : c'est **le pilote SQLite ou une contrainte du schéma de
base**.

Deux conséquences opposées :

1. **Rassurante** — les requêtes préparées tiennent. Aucune injection SQL n'est
   possible : le driver refuse le *binding*, il n'interpole rien. Confirmé sur
   1 169 trames.
2. **Le problème** — *toute colonne sans `NOT NULL` ni `CHECK` avale la
   saleté*. Preuve directe :

```
### C. playlist_create — aucun schéma
  create {name:{}}          MASKED — Internal server error   ← arrêté par NOT NULL
  create {name:200k chars}  ACCEPTÉ  {"playlistId":4}         ← AUCUNE contrainte de longueur
  -> playlists: 4  nom persisté = 200000 car.
```

Une seule trame WebSocket persiste un nom de playlist de **200 000 caractères**
en base, sur un Raspberry Pi, et le SPA devra le rendre. Le même schéma
(`CHECK`/`NOT NULL`) est absent partout où l'audit L07 devra regarder.

Sévérité **P1** (et non P0) : pas d'exécution de code, pas d'injection, pas de
contournement d'authentification. Mais c'est une **absence de contrat**, et le
défaut est *systémique* : la prochaine commande ajoutée à un module sans schéma
hérite de zéro validation par construction.

**Correctif recommandé (inchangé depuis 2026-08-22, toujours le bon) :**
inverser le défaut de `validateByCommand` — `fail closed` sauf liste blanche
explicite de commandes sans paramètre — puis combler module par module. La liste
priorisée est en §9.

---

## 4. AK — le limiteur WebSocket

### 4.1 F-06 — la trame de rejet ne portait pas d'`id` — **CORRIGÉ**

**Reproduction et chronométrage.** Un mini-client reproduisant exactement la
sémantique de `BackendAPIClient` (map `pendingRequests` clé = `id`, timeout
10 000 ms) envoie 100 commandes d'un coup :

```
AVANT
sent 100 | answered 60 | hung until client timeout 40
uncorrelated error frames received: 40 (rate-limit: 40)
hang duration (ms) min/max: 9999 / 10000
total wall time (ms): 10004
```

**40 commandes sur 100 pendent 10 secondes pleines.** Le serveur *a* répondu
40 fois — mais avec `{type:'error', error:'Rate limit exceeded', timestamp}`,
**sans `id`** : `handleMessage` (`BackendAPIClient.js:307`) ne peut pas résoudre
la promesse et tombe dans la branche « uncorrelated » qui n'émet qu'un événement
global.

**Correctif.** `src/api/WebSocketServer.js` : une fonction `peekFrameHead(data)`
lit **au plus 192 octets** de tête de trame avec une regex **ancrée sur
l'accolade ouvrante** et n'accepte que les deux premières paires clé/valeur.
Elle ne peut donc jamais confondre un `"id"` imbriqué avec l'`id` d'enveloppe :
si la forme ne correspond pas, elle ne renvoie rien et le comportement est
exactement celui d'avant. Coût : un `toString()` borné + une regex ancrée — assez
peu cher pour rester sur le chemin de rejet d'un flood, contrairement à un
`JSON.parse` complet d'une trame de 16 Mo. La trame de rejet gagne aussi un
`code: 'ERR_RATE_LIMITED'`, comme toutes les autres erreurs.

```
APRÈS
sent 100 | answered 100 | hung until client timeout 0
uncorrelated error frames received: 0
total wall time (ms): 329
```

**10 004 ms → 329 ms.** Les 40 commandes throttlées sont maintenant rejetées
immédiatement, chacune sur sa propre promesse, avec un code exploitable pour un
retry.

### 4.2 F-07 — le panic n'était pas exempté — **CORRIGÉ**

**Le scénario réel** : le clavier virtuel émet **une trame WebSocket par
événement de note**. Un passage dense sature le budget de 60 msg/s, et le
limiteur s'applique **à la trame brute, avant tout parsing** — il ne peut donc
pas savoir qu'il jette un panic.

**Reproduction 1 — la démonstration nette.** 60 notes puis PANIC / ALL-NOTES-OFF
/ STOP dans la même fenêtre, plus un **canari persistant** (`session_save`) pour
prouver que le handler n'a pas tourné :

```
AVANT
PANIC    *** NO RESPONSE — frame dropped by the WS rate limiter ***
ALLOFF   *** NO RESPONSE — frame dropped by the WS rate limiter ***
STOP     *** NO RESPONSE — frame dropped by the WS rate limiter ***
CANARY   *** NO RESPONSE ***
rate-limit notices: 4 | note responses: 60
sessions after the flood: []
canary persisted? NO  (handler never ran)
```

Le canari absent en base est la preuve formelle : le dispatcher n'a **jamais** été
atteint. Sur un vrai orchestre, les notes sont parties, le panic non — **notes
bloquées, aucun moyen de faire taire l'instrument depuis ce socket**.

**Reproduction 2 — sous charge soutenue.** Flood 200 msg/s pendant 5 s, panic
tenté toutes les 250 ms :

```
AVANT   flood 200 msg/s for 5 s — panic attempts: 19, panic answered: 6, panic dropped: 13
```

**68 % des panics perdus.**

**Circonstance atténuante mesurée** — le limiteur est **par connexion** : un
second onglet/socket n'est pas throttlé.

```
second connection — panic attempts: 11, answered: 11
```

Mais le bouton panic du SPA vit sur **le même socket** que le clavier : dans
l'usage réel, la circonstance atténuante ne s'applique pas.

**Correctif.** `src/api/WebSocketServer.js` : une liste `PRIORITY_COMMANDS`
(`midi_panic`, `midi_all_notes_off`, `midi_reset`, `playback_stop`,
`playback_pause`, `lighting_all_off`, `lighting_blackout`) est exemptée du
limiteur — reprenant exactement le principe déjà appliqué au niveau transport par
`DeviceManager.sendMessageEx` (Note Off, reset, CC de mode canal ≥ 120 échappent
au limiteur par device).

L'exemption est **bornée par construction** pour ne pas devenir un contournement :

- budget **séparé** de 10 trames prioritaires par fenêtre (`RATE_LIMIT_MAX_PRIORITY`) ;
- taille de trame plafonnée à **4 Ko** (`PRIORITY_FRAME_MAX_BYTES`) — le chemin
  16 Mo reste intégralement limité ;
- la commande est lue par le même `peekFrameHead` ancré, pas par un parse complet.

```
APRÈS
PANIC    {"id":"PANIC","type":"response","data":{"success":true}}
ALLOFF   {"id":"ALLOFF","type":"response","data":{"success":true}}
STOP     {"id":"STOP","type":"response","data":{"success":true}}
CANARY   {"id":"CANARY","type":"error","error":"Rate limit exceeded","code":"ERR_RATE_LIMITED"}

flood 200 msg/s for 5 s — panic attempts: 19, panic answered: 19, panic dropped: 0
```

**19/19.** Et le canari non prioritaire est toujours correctement throttlé —
l'exemption ne fuit pas. Un test dédié vérifie qu'un flood de 500 `midi_panic`
ne pousse pas plus de `60 + 10` trames à travers.

### 4.3 Budgets — vérifiés

| Limite | Valeur | Vérifié |
|---|---|---|
| Messages | 60 / 1 000 ms / connexion | ✅ exact (60 réponses sur 100 envois) |
| Octets entrants | 32 Mo / 1 000 ms / connexion | comptés avant parse (lecture de code) |
| Trame max | 16 Mo | `maxPayload` ws |
| Clients max | 10 | journal de boot |
| Trames prioritaires | 10 / fenêtre, ≤ 4 Ko | ✅ test |

**NOT TESTED** : soak sur plusieurs minutes, 10 clients simultanés, flood
d'entrée MIDI, flood lighting, backpressure sortante.

---

## 5. V — Enveloppe et dispatch

### 5.1 Matrice observée

Toutes les lignes ci-dessous sont des captures réelles (`t_env.mjs`, `t_env2.mjs`).

| Cas envoyé | Réponse du serveur | Verdict |
|---|---|---|
| nominal `{"id":"e1","command":"device_list"}` | `{"id":"e1","type":"response",…,"version":1,"duration":1}` | PASS |
| **sans `id`** | `{"type":"response","command":"device_list",…}` — **succès non corrélé** | **F-22** |
| **`id` dupliqué** | deux réponses portant le même `id` ; le client résout la 1re, la 2e retombe dans « uncorrelated » | **F-22** |
| **`id` objet `{"a":1}`** | `{"id":{"a":1},"type":"response",…}` — renvoyé **tel quel** | **F-22** |
| **`id` numérique `42`** | `{"id":42,…}` — accepté (c'est ce que fait le SPA) | OK |
| `command` non-string `123` | `{"id":"e6","type":"error","command":123,"error":"Invalid message: Command field is required and must be a string","code":"ERR_VALIDATION"}` | PASS (mais `command` reflété non-string) |
| `command` absent | `ERR_VALIDATION` | PASS |
| **JSON invalide** | `{"type":"error","error":"Internal server error"}` — **ni `id` ni `code`** | **F-21** |
| **trame vide** | idem | **F-21** |
| **trame binaire aléatoire** | idem | **F-21** |
| trame binaire contenant du JSON valide | traitée normalement (réponse `type:'response'`) | PASS |
| trame `null` littérale | `ERR_VALIDATION` « Message must be an object » | PASS |
| trame `"chaîne"` | `ERR_VALIDATION` « Message must be an object » | PASS |
| trame `[1,2,3]` | `ERR_VALIDATION` « Command field is required… » | PASS |
| `data` tableau / chaîne | `ERR_VALIDATION` « Data field must be an object » | PASS |
| commande inconnue | `ERR_NOT_FOUND`, socket vivant | PASS |
| **sans `data`** | traité comme `{}` | PASS |
| pollution de prototype `{"__proto__":{…}}` | sans effet (reviver `stripDangerousKeys`) | PASS |

Le socket **survit à tous les cas** — vérifié par un `alive-check` après chaque
trame.

### 5.2 F-21 (P2) — une erreur du client rapportée comme une erreur du serveur

`WebSocketServer.handleMessage` enveloppe `JSON.parse` et le dispatch dans le
**même** `try/catch`. Un `SyntaxError` de parse n'est pas une `ApplicationError`,
donc il sort en `{type:'error', error:'Internal server error'}` — **sans `code`,
sans `id`**.

Trois conséquences :

1. Un développeur d'intégration qui envoie du JSON mal formé lit « erreur interne
   du serveur » et cherche le bug au mauvais endroit.
2. Le client ne peut pas distinguer « ma trame était invalide » (400) de « le
   serveur a un problème » (500) — pas de `code` machine.
3. Côté SPA la trame tombe dans la branche « uncorrelated » et déclenche
   l'événement `error` **global** — une alerte visible pour une faute du client.

C'est aussi un **faux positif de supervision** : `Failed to process message:` est
loggé en `ERROR`.

**Correctif proposé** (non appliqué — hors du minimum nécessaire ce lot) :

```js
// src/api/WebSocketServer.js — handleMessage
let parsedMessage = null;
try {
  parsedMessage = JSON.parse(data.toString(), stripDangerousKeys);
} catch (parseErr) {
  this.logger.warn(`Malformed WS frame from client: ${parseErr.message}`);
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({
      ...(peekFrameHead(data).id !== undefined ? { id: peekFrameHead(data).id } : {}),
      type: 'error',
      error: 'Malformed JSON frame',
      code: 'ERR_VALIDATION',
      timestamp: Date.now()
    }));
  }
  return;
}
try { await this._deps.commandHandler.handle(parsedMessage, ws); }
catch (error) { /* … bloc existant … */ }
```

### 5.3 F-22 (P2) — l'`id` d'enveloppe n'est pas un contrat

`JsonValidator.validateCommand` contrôle `command` (string non vide) et `data`
(objet), **jamais `id`**. Observé : `id` absent → réponse non corrélée ; `id`
objet → renvoyé tel quel (aucun client ne pourra le retrouver, `Map.get` compare
par référence) ; `id` dupliqué → deux réponses identiques, la seconde ingérable.

Impact réel limité côté SPA (il génère lui-même des entiers croissants), mais
**le contrat WS est aussi une API pour des intégrations tierces** (c'est le sujet
même de l'ADR-003), et rien ne le documente ni ne le force.

**Correctif proposé** — dans `validateCommand` :

```js
if (message.id !== undefined &&
    typeof message.id !== 'string' && typeof message.id !== 'number') {
  errors.push('Id field must be a string or a number');
}
if (typeof message.id === 'string' && message.id.length > 128) {
  errors.push('Id field must be at most 128 characters');
}
```

(La détection de doublon exige un état par connexion : à arbitrer, probablement
non souhaitable — mais alors il faut **le documenter** dans `docs/API.md`.)

### 5.4 Fuite d'information — PASS, avec une réserve (F-25, P3)

Le masquage fonctionne : sur 1 169 trames hostiles, **aucune stack, aucun chemin
de fichier, aucun fragment de SQL n'a atteint le client**. Les messages
`better-sqlite3` (`Too few parameter values…`, `NOT NULL constraint failed: …`)
restent **exclusivement dans le journal serveur** ; le client reçoit
`"Internal server error"`.

La réserve : les `ApplicationError` remontent **verbatim**, et certaines
**reflètent l'entrée utilisateur** :

```
{"type":"error","command":"<img src=x onerror=alert(1)>",
 "error":"command with id '<img src=x onerror=alert(1)>' not found","code":"ERR_NOT_FOUND"}
{"error":"LightingDevice with id '<img src=x onerror=alert(1)>' not found"}
```

Ce n'est **pas** une XSS en soi (réponse JSON). Ça le devient si le SPA rend
`error.message` via `innerHTML` — à vérifier par **L09/L10**. Deuxième vecteur
mesuré : ces chaînes sont écrites dans le journal, et `system_logs` **renvoie le
journal au client** :

```
system_logs → {"logs":["… Command failed: Group \"<img src=x onerror=alert(1)>\" not found"]}
```

Log-injection → relecture. À traiter avec le rendu de la console d'administration.

**Traversée de chemin — contenue.** `system_backup {path:'/etc/shadow'}` →
`{"path":"/home/user/General-Midi-Boop/backups/shadow"}` : le chemin est confiné
au répertoire de sauvegarde. `file_list {folder:'../../..'}` → `{"files":[]}`.
`file_read {fileId:'../../../../etc/passwd'}` → erreur, aucune fuite.

> ⚠️ *Effet de bord de cette sonde* : un fichier `backups/shadow` (3,9 Mo, une
> vraie sauvegarde SQLite de ma base de scratchpad, au nom trompeur) a été créé.
> `backups/` est dans `.gitignore` — aucun risque de commit — mais **la
> suppression m'a été refusée par la politique d'outil** : à supprimer par
> l'orchestrateur.

---

## 6. F-23 (P3) — Versionnement des handlers : le champ `version` est décoratif

**Ce que dit l'ADR-003** (`docs/adr/ADR-003-ws-contract-versioning.md`) :
l'option A (dispatch sur `command + version`) est **explicitement rejetée** ;
c'est l'**option B** qui est retenue — suffixe `_vN` sur le **nom de commande**.

**Ce que dit la JSDoc de `CommandRegistry`** (lignes 10-11, et 126) :

> *3. Handler lookup (versioned handlers take priority when the client sends
> `version`; falls back to the v1 handler otherwise).*
> *Validates the message, looks up the handler (versioned > default), …*

**Ce que dit `CLAUDE.md`** : « versioned-handler lookup » dans le pipeline de
dispatch.

**Ce que fait le code** (`src/api/CommandRegistry.js:180`) :

```js
const handler = this.handlers[message.command];
```

Il n'y a **aucune** résolution versionnée. Le champ `version` de l'enveloppe
entrante n'est **jamais lu**.

Vérifié en direct :

| Envoyé | Réponse |
|---|---|
| pas de `version` | `response`, `version: 1` |
| `version: 1` / `2` / `99` / `0` / `-1` | `response`, `version: 1` — **toutes acceptées, toutes ignorées** |
| `version: "v2"` (non numérique) | `response`, `version: 1` |
| `version: null` / `{a:1}` | `response`, `version: 1` |
| `command: "device_list_v2"` | `ERR_NOT_FOUND` — cohérent avec l'ADR |

```
$ grep -rn "registry.register(\s*'[a-z_0-9]*_v[0-9]" src/     # → aucun résultat
$ grep -n "version" public/js/api/BackendAPIClient.js          # → le client n'envoie jamais `version`
```

**Verdict.** La *décision* de l'ADR-003 est respectée (aucune `_v2` n'existe,
aucune n'est nécessaire) — mais **la documentation du code décrit un mécanisme
qui n'existe pas**, et l'enveloppe expose un champ inerte qu'un intégrateur
croira signifiant. C'est le pire des deux mondes : un contrat annoncé, non tenu,
et silencieux (une `version` incohérente ne produit **aucun** avertissement).

**Correctif proposé** — deux lignes de doc + un choix explicite :

```js
/**
 *   3. Handler lookup by command name. There is NO dispatch on the envelope's
 *      `version` field: ADR-003 deliberately rejected that option in favour of
 *      additive `_vN` command names. `version` is accepted for wire
 *      compatibility and ignored; the response always advertises
 *      CURRENT_API_VERSION.
 */
```

… et la même correction dans `CLAUDE.md` (fichier partagé → **non modifié par
moi**, diff proposé en §10).

---

## 7. T — La surface HTTP

### 7.1 Inventaire des 15 routes — vérifié en direct

```bash
$ curl -s -o /dev/null -w '%{http_code} %{content_type} %{size_download}B' http://127.0.0.1:8101<path>
```

| Méthode | Chemin | Auth | Observé |
|---|---|---|---|
| GET | `/api/health` | **public** | 200 · json · 444 B |
| GET | `/api/capabilities` | **public** ⚠ | 200 · json · 380 B — **F-24** |
| GET | `/api/update-status` | **public** | 200 · json · 30 B |
| GET | `/api/status` | token/bypass | 200 · json · 165 B |
| GET | `/api/metrics` | token/bypass | 200 · `text/plain; version=0.0.4` · 624 B |
| POST | `/api/files` | token/bypass | 400 sur corps vide (message explicite) |
| GET | `/api/files/:id/blob` | token/bypass | 404 (absent) · **400** sur id non numérique |
| GET | `/api/files/:id/text-events` | token/bypass | 404 (absent) |
| GET | `/api/sf2/` | token/bypass | 200 |
| POST | `/api/sf2/` | token/bypass | (non sondé — upload) |
| DELETE | `/api/sf2/:id` | token/bypass | 404 |
| PATCH | `/api/sf2/:id` | token/bypass | 404 |
| GET | `/api/sf2/:id/kits` | token/bypass | 200 |
| GET | `/api/sf2/:id/preset/melodic/:program` | token/bypass | 404 |
| GET | `/api/sf2/:id/preset/drum/:kit/:note` | token/bypass | 404 |
| GET | `/api/waf/:filename` | token/bypass | 502 (pas de réseau sortant) |

Les identifiants non numériques donnent bien **400** et non 500 — la robustesse
de path-param constatée en août tient toujours.

### 7.2 F-10 — `/api/*` inconnu → **CORRIGÉ**

```
AVANT
GET /api/definitely-not-a-route    200 text/html; charset=UTF-8   615825B
<!DOCTYPE html><html lang="fr" …
```

**200 et 615 825 octets de SPA** pour un chemin d'API inexistant. Deux problèmes,
et le second n'avait pas été relevé en août :

1. Un client d'API ne peut pas distinguer « endpoint inexistant » de « voici ta
   page » — il tentera `res.json()` sur du HTML.
2. **Amplification** : 615 825 octets (110 158 gzippés) au lieu de ~40. Un
   scanner qui énumère 1 000 chemins `/api/*` fait servir **600 Mo** par un
   Raspberry Pi. `GET /api/files` (sans id) tombait dans le même piège.

Symptôme connexe mesuré : une **méthode non autorisée** sur une vraie route
(`POST /api/health`) renvoyait la page 404 HTML par défaut d'Express.

**Correctif.** `src/api/HttpServer.js`, entre le montage du routeur d'API et le
repli SPA :

```js
this.expressApp.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found', code: 'ERR_NOT_FOUND' });
});
```

Vérifié : les 4 tests de `tests/audit/l01-http-contract.test.js` passent —
404 JSON sur chemin inconnu, 404 JSON sur méthode non supportée, **SPA intacte**
sur les chemins hors `/api`, et `/api/health` + `/api/capabilities` inchangés.
Contrôle croisé : aucune route `/api/*` référencée par le frontend n'est
concernée (`/api/files`, `/api/sf2*`, `/api/waf/`, `/api/update-status` — toutes
réelles).

### 7.3 Auth HTTP — PARTIAL

| Contrôle | Résultat |
|---|---|
| Endpoints publics dans le code | `/health`, `/update-status`, **`/capabilities`** |
| Endpoints publics documentés (`CLAUDE.md`, `apiRoutes.js`, audit 2026-08-22) | `/health`, `/update-status` **seulement** |
| Comparaison de token | `timingSafeEqual` + contrôle de longueur préalable |
| Bypass `Sec-Fetch-Site: same-origin` | présent, **forgeable par un client non-navigateur** (commenté comme risque accepté) |
| Bypass `Origin == Host` | présent, même réserve |
| Bypass `isPrivateClient` (RFC1918 / loopback / ULA / link-local) | présent |
| Mode `secure` (retire tous les bypass) | présent |

**Pourquoi PARTIAL et pas PASS.** Toutes mes requêtes partent de `127.0.0.1`,
donc `isPrivateClient()` renvoie toujours `true` et **le chemin token n'est
jamais atteint** ; le conteneur n'expose aucune interface non-privée pour
contourner. Les trois bypass n'ont donc pas pu être **départagés** en direct :
je ne peux pas prouver l'ordre de priorité ni le comportement d'un client
public. `GMBOOP_SECURITY_MODE=secure` n'a pas été rejoué faute de temps de
session. **À reprendre par L10** (qui a le modèle de menace) avec, par exemple,
un serveur bindé sur une interface `dummy` publique, ou un test unitaire sur
`isPrivateClient` (aujourd'hui non exportée — **c'est en soi une recommandation :
l'exporter pour la rendre testable**).

### 7.4 F-24 (P3) — `/api/capabilities` est public, la doc dit le contraire

`src/api/HttpServer.js` :

```js
if (req.path === '/health' || req.path === '/update-status' || req.path === '/capabilities') {
  return next();
}
```

Mais `CLAUDE.md` écrit : « `/api/health` et `/api/update-status` **sont toujours
publics** » — et le rapport `10_API_WEBSOCKET.md` du 2026-08-22 classait
`/api/capabilities` en « token, verified 200 » (le bypass loopback l'avait
masqué). Le commentaire du code (`apiRoutes.js`) le justifie : « sonde de
supervision ». L'intention est défendable ; **la divergence, non**.

Contenu réellement exposé sans authentification :

```json
{"overall":"degraded","capabilities":{"usb":{"status":"ready",…},"ble":{…},"lighting":{…}}}
```

Ce sont des métadonnées de configuration (transports présents/absents, raisons
d'échec) — pas de secret, mais de la reconnaissance gratuite. **Décider et
aligner** : soit rendre la route publique explicitement dans `CLAUDE.md` +
`apiRoutes.js`, soit la remettre derrière le token.

### 7.5 CORS, en-têtes, compression — PASS

```
Origin: http://evil.example       → 200, AUCUN en-tête Access-Control-* (navigateur bloque)
Origin: http://localhost:8101     → Access-Control-Allow-Origin: http://localhost:8101
                                     Allow-Methods: GET, POST, OPTIONS
                                     Allow-Headers: Authorization, Content-Type
OPTIONS + Origin evil             → 204 sans ACAO (préflight refusé)
```

En-têtes helmet servis : `X-Content-Type-Options: nosniff`,
`X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`,
`Cross-Origin-Opener-Policy: same-origin`, `X-XSS-Protection: 0`,
`Strict-Transport-Security` (inerte en HTTP clair — sans effet, ni danger).
**Pas de CSP** — F-11, risque accepté, ré-instruit par L10.

Compression : `index.html` 615 825 → **110 158 octets** gzip.
`/api/metrics` (624 B) non compressé — sous le seuil de `compression()`, normal.

---

## 8. U3 / F-26 — les commandes sans appelant frontend : le chiffre de l'audit précédent était faux

### 8.1 Le défaut de l'outil

`scripts/audit/command-inventory.mjs` ne scannait que `public/js/**.js`. Or :

```
$ wc -l public/index.html   →  14584
$ grep -c "sendCommand" public/index.html   →  75
```

**14 584 lignes de script SPA inline, 75 sites d'appel `sendCommand`**, tous
invisibles pour l'outil. Le « 123 commandes jamais appelées par le frontend » du
2026-08-22 était donc **faux** : 31 commandes n'ont retrouvé un site d'appel que
par ce seul fichier, et 20 de plus y sont atteintes par dispatch dynamique.
**123 annoncées → 72 réellement orphelines : l'erreur portait sur 51 commandes,
soit 41 % du chiffre publié.** Le lot L13 a établi le même 72 indépendamment.

**Outil corrigé** (`collectFrontendCalls` scanne `public/**` `.js` **et**
`.html`, accepte les backticks ; `collectFrontendMentions` ajoute un signal
faible). Nouveau relevé :

```
Registered commands       : 270
  with payload schema     : 86 (31.9%)
  called by frontend      : 178 (65.9%)      ← était 147 (54.4%)
  mentioned in tests      : 76 (28.1%)
  documented in API.md    : 187 (69.3%)
  orphan: mentioned only  : 20 / no trace in public/: 72
```

> ⚠️ « mentioned in tests » est une cible mouvante : 15 agents créent des suites
> `tests/audit/*` en parallèle (63 → 67 → 76 pendant ce lot). À figer en vague 2.

### 8.2 La liste, classée — exploitable telle quelle par L13

**92 commandes** n'ont aucun site d'appel reconnu, en **deux classes de force de
preuve** :

| Classe | n | Signification | Verdict |
|---|---:|---|---|
| **A — mention seule** | **20** | le nom apparaît dans `public/**` sans site d'appel reconnu par l'outil (dispatch dynamique, table de correspondance) | **atteignable** — faux orphelins |
| **B — aucune trace** | **72** | le nom n'apparaît **nulle part** dans `public/**` | **orphelines réelles** |

**Le chiffre à retenir, et à republier partout dans l'audit :
198 / 270 commandes (73,3 %) sont atteignables depuis le frontend,
72 (26,7 %) ne le sont pas.** (Base L00 : « 147 (54,4 %) » → **à corriger**.)

Ce 72 **coïncide exactement** avec le chiffre établi indépendamment par le lot
L13. La classification fine des 72 surfaces (interne assumé / orpheline suspecte
/ UI manquante) et les 6 diffusions WS sans écouteur sont traitées dans
**`13_FEATURE_COMPLETENESS.md`** — je ne la duplique pas ici.

#### Classe A — les 20 faux orphelins (à ne pas traiter comme morts)

| Commande | Module | Fichier frontend |
|---|---|---|
| `instrument_list_connected` | InstrumentSettings | `public/index.html` |
| `playback_status` | PlaybackControl | `public/index.html` |
| `lighting_all_off`, `lighting_blackout`, `lighting_device_test`, `lighting_rule_test` | Lighting | `public/js/features/lighting/LightingHelpersMixin.js` |
| `session_delete`, `session_export`, `session_list`, `session_load`, `session_save` | Session | `public/js/features/SystemAdminModal.js` |
| `system_backup`, `system_clear_logs`, `system_info`, `system_logs`, `system_reboot`, `system_restart`, `system_restore`, `system_shutdown`, `system_status` | System | `public/js/features/SystemAdminModal.js` |

Ces deux fichiers construisent le nom de commande dynamiquement (table d'actions
d'administration, mixin d'aides lighting). Ce sont des **appels réels**.

#### Classe B — les 72 orphelines réelles, par module

Le marqueur ⚠ signale une commande **sans schéma** : orpheline **et** non validée
— la combinaison la plus coûteuse à laisser vivre.

| Module | Commandes |
|---|---|
| `BankEffects` (1) | `bank_effects_list` |
| `Bluetooth` (1) | `ble_scan_stop`⚠ |
| `Device` (3) | `device_enable`, `device_info`, `device_set_properties` |
| `File` (8) | `file_bake_cc`⚠, `file_duplicate`⚠, `file_export`, `file_move`, `file_routing_status`⚠, `file_search`⚠, `midi_categories_list`⚠, `midi_instruments_list`⚠ |
| `InstrumentLight` (2) | `instrument_light_all_off`⚠, `instrument_light_test`⚠ |
| `InstrumentSettings` (2) | `instrument_type_detect`⚠, `instrument_types_list`⚠ |
| `InstrumentVoice` (4) | `instrument_voice_create`⚠, `instrument_voice_delete`⚠, `instrument_voice_replace`⚠, `instrument_voice_update`⚠ |
| `Latency` (8) | `latency_auto_calibrate`⚠, `latency_delete`, `latency_export`⚠, `latency_get`, `latency_list`⚠, `latency_measure`, `latency_recommendations`⚠, `latency_set` |
| `Lighting` (2) | `lighting_led_broadcast`⚠, `lighting_scene_apply`⚠ |
| `Midi` (3) | `midi_all_notes_off`, `midi_reset`, `midi_send` |
| `PlaybackAnalysis` (1) | `analyze_channel` |
| `PlaybackControl` (1) | `playback_set_loop` |
| `PlaybackRouting` (5) | `playback_clear_channel_routing`⚠, `playback_get_channels`⚠, `playback_set_channel_routing`⚠, `playback_set_disconnect_policy`⚠, `playback_validate_routing`⚠ |
| `Playlist` (2) | `playlist_clear`⚠, `playlist_status`⚠ |
| `Preset` (6) | `preset_delete`, `preset_export`, `preset_list`, `preset_load`, `preset_rename`, `preset_save` |
| `Routing` (15) | `channel_map`, `file_routing_bulk_sync`⚠, `filter_clear`, `filter_set`, `route_clear_all`⚠, `route_create`, `route_delete`, `route_duplicate`⚠, `route_enable`, `route_export`⚠, `route_import`⚠, `route_info`⚠, `route_list`⚠, `route_test`⚠, `validate_routing_feasibility`⚠ |
| `Serial` (2) | `serial_list`⚠, `serial_status`⚠ |
| `Session` (1) | `session_import` |
| `StringInstrument` (2) | `tablature_delete`⚠, `tablature_get_by_file`⚠ |
| `VirtualInstrument` (3) | `virtual_create`, `virtual_delete`, `virtual_list`⚠ |

**Deux observations du point de vue « contrat » (le reste est à L13) :**

1. **`RoutingCommands` — 15 des 21 commandes orphelines.** C'est le module de
   routage MIDI, cœur fonctionnel du produit, et **aucune** de ses commandes
   n'est appelée par l'UI. Le SPA route donc *autrement* (`playback_*`,
   `file_routing_*`). `route_create` / `route_delete` / `route_list` /
   `filter_set` / `channel_map` forment une **API parallèle complète et
   inatteignable**. Soit c'est une API d'intégration assumée — et elle doit être
   documentée comme telle et versionnée — soit c'est du code mort à supprimer.
   Aucune position intermédiaire n'est tenable pour « complet et fonctionnel ».
2. **`midi_panic` est appelé, `midi_all_notes_off` et `midi_reset` ne le sont
   pas.** Les deux commandes de secours « douces » (extinction respectant les
   enveloppes, reset système) n'ont **aucun bouton**. C'est un manque d'UI, pas
   du code mort — et il est directement lié à F-07.

---

## 9. Matrice complète et plan de remédiation des schémas

### 9.1 Les 10 schémas prioritaires — prêts à coller

Priorisation **par la mesure**, pas par intuition. Le critère est le croisement
`(payloads hostiles acceptés) × (effet réel : persistance, réseau, GPIO, MIDI)`.

#### 1-2. `playback.schemas.js` — `playback_set_tempo`, `playback_set_volume` (F-20)

`PlaybackControlCommands` accepte **100 %** (42/42) des payloads hostiles.
`playbackSetTempo` se réduit à `Number(data?.bpm ?? data?.tempo)` sans borne.
Mesuré :

```
set_tempo {bpm:1e308}   → ACCEPTÉ   et mémorisé
set_tempo {}            → {"success":false,"bpm":1e+308}     ← état empoisonné conservé
set_tempo {bpm:"fast"}  → {"success":false,"bpm":1e+308}
playback_status         → {"tempo":1e+308, …}                ← remonté à l'UI
```

Récupérable (`{bpm:120}` restaure), donc **P2 et non P1** — mais le tempo affiché
par l'UI est faux jusque-là, sans qu'aucune erreur ne soit émise.
`playbackSetVolume` se protège déjà (`Number.isFinite` + clamp 0-127) : le schéma
sert à **rejeter** au lieu de **corriger en silence**.

```js
export const playback_set_tempo = {
  custom: (data) => {
    const raw = data.bpm ?? data.tempo;
    if (raw === undefined) return 'bpm is required';
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return 'bpm must be a number';
    if (raw < 20 || raw > 400) return 'bpm must be between 20 and 400';
    return null;
  }
};

export const playback_set_volume = {
  fields: { volume: { type: 'integer', required: true, min: 0, max: 127 } }
};
```

#### 3. `lighting.schemas.js` — `lighting_rule_add`

Persiste une règle **évaluée synchrone à chaque message MIDI** (F-13). Le handler
valide les bornes MIDI mais laisse passer `condition_config` / `action_config`
non-objets, `priority` non entier, `device_id` objet (→ erreur interne SQLite).

```js
export const lighting_rule_add = {
  fields: {
    device_id: { type: 'id', required: true },
    instrument_id: { type: 'id' },
    name: { type: 'string', maxLength: 128 },
    priority: { type: 'integer', min: -1000, max: 1000 },
    enabled: { type: 'boolean' },
    condition_config: { type: 'object' },
    action_config: { type: 'object' }
  }
};
```

#### 4. `lighting.schemas.js` — `lighting_rule_update`

Même surface, en écriture sur une règle existante ; `updateRule(data.id, data)`
passe **l'enveloppe entière** au repository.

```js
export const lighting_rule_update = {
  fields: {
    id: { type: 'id', required: true },
    device_id: { type: 'id' },
    instrument_id: { type: 'id' },
    name: { type: 'string', maxLength: 128 },
    priority: { type: 'integer', min: -1000, max: 1000 },
    enabled: { type: 'boolean' },
    condition_config: { type: 'object' },
    action_config: { type: 'object' }
  }
};
```

#### 5. `lighting.schemas.js` — `lighting_scene_save` / `lighting_scene_apply`

`deepNest` (600 niveaux), `bigArray` (50 000) et `bigString` (200 000 car.) sont
tous **acceptés** par `lighting_scene_save`. La scène est ensuite rejouée par
`_applySceneObject`, qui itère `scene.effects` et démarre un effet par entrée.

```js
const MAX_SCENE_ENTRIES = 512;

export const lighting_scene_save = {
  fields: { name: { type: 'string', required: true, minLength: 1, maxLength: 128 } },
  custom: (data) => {
    if (data.scene !== undefined) {
      if (typeof data.scene !== 'object' || data.scene === null || Array.isArray(data.scene)) {
        return 'scene must be an object';
      }
      if (Array.isArray(data.scene.effects) && data.scene.effects.length > MAX_SCENE_ENTRIES) {
        return `scene.effects must hold at most ${MAX_SCENE_ENTRIES} entries`;
      }
    }
    return null;
  }
};

export const lighting_scene_apply = {
  custom: (data) => {
    const s = data.scene;
    if (typeof s !== 'object' || s === null || Array.isArray(s)) return 'scene data is required';
    if (Array.isArray(s.effects) && s.effects.length > MAX_SCENE_ENTRIES) {
      return `scene.effects must hold at most ${MAX_SCENE_ENTRIES} entries`;
    }
    return null;
  }
};
```

#### 6. `lighting.schemas.js` — `lighting_led_broadcast`

Ouvre une diffusion LED continue vers le réseau ; orpheline (aucun appelant
frontend) et non validée — `enabled` non booléen est interprété par
`data?.enabled !== false`, donc **toute valeur non-`false` active la diffusion**.

```js
export const lighting_led_broadcast = {
  fields: { enabled: { type: 'boolean', required: true } }
};
```

#### 7. Nouveau `playlist.schemas.js` — `playlist_create` / `playlist_update_settings`

**Preuve directe de F-19** : un nom de 200 000 caractères a été persisté.

```js
export const playlist_create = {
  fields: {
    name: { type: 'string', required: true, minLength: 1, maxLength: 128 },
    description: { type: 'string', maxLength: 1024 }
  }
};

export const playlist_update_settings = {
  fields: {
    playlistId: { type: 'id', required: true },
    loop: { type: 'boolean' },
    shuffle: { type: 'boolean' },
    autoAdvance: { type: 'boolean' },
    gapMs: { type: 'integer', min: 0, max: 600000 }
  }
};
```

#### 8. Nouveau `playlist.schemas.js` — `playlist_add_file` / `playlist_remove_file` / `playlist_reorder`

```js
export const playlist_add_file = {
  fields: {
    playlistId: { type: 'id', required: true },
    fileId: { type: 'id', required: true },
    position: { type: 'integer', min: 0, max: 100000 }
  }
};

export const playlist_remove_file = {
  fields: { playlistId: { type: 'id', required: true }, itemId: { type: 'id', required: true } }
};

export const playlist_reorder = {
  fields: {
    playlistId: { type: 'id', required: true },
    itemId: { type: 'id', required: true },
    newPosition: { type: 'integer', required: true, min: 0, max: 100000 }
  }
};
```

#### 9. `file.schemas.js` — les lectures par identifiant

7 commandes `file_*` transforment `{fileId:{}}` en erreur interne SQLite
(`Too few parameter values were provided`). Un seul type `id` suffit à toutes.

```js
const byFileId = { fields: { fileId: { type: 'id', required: true } } };

export const file_read = byFileId;
export const file_metadata = byFileId;
export const file_channels = byFileId;
export const file_tempo_map = byFileId;
export const file_text_events = byFileId;
export const file_routing_status = byFileId;
export const file_duplicate = byFileId;

export const file_list = {
  fields: { folder: { type: 'string', maxLength: 512 } }
};
export const file_search = {
  fields: { query: { type: 'string', required: true, minLength: 1, maxLength: 256 } }
};
```

#### 10. Nouveau `instrument.schemas.js` — `instrument_update_settings` / `instrument_update_capabilities`

Écrit dans les colonnes de capacité que **tout le moteur d'adaptation lit**
(périmètre L06). Mesuré : `NOT NULL constraint failed: instruments_latency.device_id`
— autrement dit, le payload arrive brut jusqu'à `INSERT`.

```js
export const instrument_update_settings = {
  fields: {
    deviceId: { type: 'string', required: true, minLength: 1, maxLength: 256 },
    instrumentId: { type: 'id' },
    settings: { type: 'object' }
  }
};

export const instrument_update_capabilities = {
  fields: {
    instrumentId: { type: 'id', required: true },
    capabilities: { type: 'object', required: true }
  }
};

export const instrument_delete = {
  fields: { deviceId: { type: 'string', required: true, minLength: 1, maxLength: 256 } }
};
```

> `instrument_delete` fait partie du lot parce qu'il produit un TypeError franc :
> `data.deviceId.startsWith is not a function`.

### 9.2 Ordre de bataille complet (les 184)

| Rang | Cible | n | Justification mesurée |
|---|---|---:|---|
| 1 | **Inverser le défaut de `validateByCommand`** | — | fait une fois, protège les 184 et **toute commande future** |
| 2 | `PlaybackControlCommands` (`set_tempo`, `set_volume`, `pause`, `resume`, `stop`, `status`) | 6 | 100 % des payloads hostiles acceptés · F-20 |
| 3 | `LightingCommands` (règles, scènes, groupes, presets, broadcast) | 31 | 122 acceptations · pilote réseau + GPIO · 0 % de couverture (F-13) |
| 4 | `PlaylistCommands` | 15 | persistance non bornée prouvée (200 000 car.) |
| 5 | `FileCommands` (lectures par id + `file_list`/`file_search`) | 16 | 34 erreurs internes — pire ratio après `DeviceCommands` |
| 6 | `InstrumentSettingsCommands` | 11 | écrit les capacités lues par tout le moteur (L06) |
| 7 | `RoutingCommands` | 13 | 15 des 21 orphelines : **schéma + décision d'existence** ensemble |
| 8 | `StringInstrumentCommands` | 15 | `CHECK constraint failed` atteint depuis le réseau |
| 9 | `LatencyCommands` | 12 | 56 acceptations / 70 |
| 10 | `PlaybackRoutingCommands`, `InstrumentVoiceCommands`, `InstrumentLightCommands`, `SerialCommands`, `DeviceSettingsCommands` | 25 | déjà bien auto-validés — schéma = formalisation |
| 11 | `SystemCommands`, `HotspotCommands`, `BluetoothCommands` | 24 | majoritairement sans paramètre → **liste blanche**, pas schéma |
| 12 | reste (`Device`, `VirtualInstrument`, `Loop*`, `Session`, `PlaybackAssignment`) | 16 | |

**Garde-fou CI recommandé** (à appliquer en vague 2, `package.json` + workflow
sont des fichiers partagés) : brancher `command-inventory.mjs` avec un cliquet —
la couverture de schémas ne peut pas baisser sous sa valeur courante.

### 9.3 Matrice complète — 270 commandes

**Légende.**
`Schéma` : ✅ schéma déclaré et câblé · ❌ défaut permissif.
`Front` : ✅ site d'appel reconnu · 〰️ mention seule (classe A) · ❌ aucune trace (classe B).
`Tests` : nombre de fichiers de test citant la commande.
`Doc` : présent dans `docs/API.md`.
`Fuzz` : issue des 7 payloads hostiles — `A`=accepté, `I`=erreur interne masquée,
`V`=rejet de validation propre, `E`=autre `ApplicationError`, `—`=non fuzzée
(schéma présent, ou exclue pour effet hôte irréversible).

| Commande | Module | Schéma | Front | Tests | Doc | Fuzz |
|---|---|:--:|:--:|--:|:--:|---|
| `analyze_channel` | PlaybackAnalysis | ✅ | ❌ | 2 | ✅ | — |
| `apply_assignments` | PlaybackAssignment | ✅ | ✅ | 3 | ✅ | — |
| `arrangement_add_block` | LoopArrangement | ✅ | ✅ | 1 | ❌ | — |
| `arrangement_add_track` | LoopArrangement | ✅ | ✅ | — | ❌ | — |
| `arrangement_create` | LoopArrangement | ✅ | ✅ | 1 | ❌ | — |
| `arrangement_delete` | LoopArrangement | ✅ | ✅ | — | ❌ | — |
| `arrangement_delete_block` | LoopArrangement | ✅ | ✅ | — | ❌ | — |
| `arrangement_delete_track` | LoopArrangement | ✅ | ✅ | — | ❌ | — |
| `arrangement_get` | LoopArrangement | ✅ | ✅ | — | ❌ | — |
| `arrangement_list` | LoopArrangement | ❌ | ✅ | — | ❌ | 7A |
| `arrangement_update` | LoopArrangement | ✅ | ✅ | — | ❌ | — |
| `arrangement_update_block` | LoopArrangement | ✅ | ✅ | — | ❌ | — |
| `arrangement_update_track` | LoopArrangement | ✅ | ✅ | — | ❌ | — |
| `bank_effects_get` | BankEffects | ✅ | ✅ | 1 | ❌ | — |
| `bank_effects_list` | BankEffects | ✅ | ❌ | 1 | ❌ | — |
| `bank_effects_reset` | BankEffects | ✅ | ✅ | 1 | ❌ | — |
| `bank_effects_update` | BankEffects | ✅ | ✅ | 1 | ❌ | — |
| `ble_connect` | Bluetooth | ✅ | ✅ | — | ✅ | — |
| `ble_disconnect` | Bluetooth | ✅ | ✅ | — | ✅ | — |
| `ble_forget` | Bluetooth | ❌ | ✅ | — | ✅ | 7V |
| `ble_paired` | Bluetooth | ❌ | ✅ | — | ✅ | 7A |
| `ble_power_off` | Bluetooth | ❌ | ✅ | — | ✅ | — |
| `ble_power_on` | Bluetooth | ❌ | ✅ | — | ✅ | — |
| `ble_scan_start` | Bluetooth | ❌ | ✅ | — | ✅ | 7E |
| `ble_scan_stop` | Bluetooth | ❌ | ❌ | — | ✅ | 7A |
| `ble_status` | Bluetooth | ❌ | ✅ | — | ✅ | 7A |
| `calibrate_delay` | Latency | ❌ | ✅ | — | ✅ | — |
| `calibrate_list_alsa_devices` | Latency | ❌ | ✅ | — | ✅ | 7I |
| `calibrate_monitor_start` | Latency | ❌ | ✅ | — | ❌ | 7A |
| `calibrate_monitor_stop` | Latency | ❌ | ✅ | — | ❌ | 7A |
| `calibrate_preview_note` | Latency | ❌ | ✅ | — | ❌ | 7V |
| `channel_map` | Routing | ✅ | ❌ | — | ✅ | — |
| `device_enable` | Device | ✅ | ❌ | — | ✅ | — |
| `device_get_settings` | DeviceSettings | ❌ | ✅ | — | ❌ | 1I/6V |
| `device_identity_request` | Device | ❌ | ✅ | — | ✅ | 7I |
| `device_info` | Device | ✅ | ❌ | — | ✅ | — |
| `device_list` | Device | ❌ | ✅ | 2 | ✅ | 7A |
| `device_refresh` | Device | ❌ | ✅ | — | ✅ | 7A |
| `device_save_sysex_identity` | Device | ❌ | ✅ | — | ✅ | 7I |
| `device_set_properties` | Device | ✅ | ❌ | — | ✅ | — |
| `device_update_settings` | DeviceSettings | ❌ | ✅ | — | ❌ | 1A/6V |
| `file_bake_cc` | File | ❌ | ❌ | — | ❌ | 7I |
| `file_channels` | File | ❌ | ✅ | — | ✅ | 1A/1I/5V |
| `file_delete` | File | ✅ | ✅ | — | ✅ | — |
| `file_duplicate` | File | ❌ | ❌ | — | ✅ | 7I |
| `file_export` | File | ✅ | ❌ | — | ✅ | — |
| `file_filter` | File | ❌ | ✅ | 1 | ✅ | 6A/1I |
| `file_folders_get` | File | ❌ | ✅ | — | ❌ | 7A |
| `file_folders_set` | File | ✅ | ✅ | — | ❌ | — |
| `file_list` | File | ❌ | ✅ | — | ✅ | 6A/1I |
| `file_metadata` | File | ❌ | ✅ | — | ✅ | 7I |
| `file_move` | File | ✅ | ❌ | — | ✅ | — |
| `file_read` | File | ❌ | ✅ | — | ✅ | 7I |
| `file_reanalyze_all` | File | ❌ | ✅ | — | ✅ | — |
| `file_reanalyze_check` | File | ❌ | ✅ | — | ❌ | 7A |
| `file_rename` | File | ✅ | ✅ | 1 | ✅ | — |
| `file_routing_bulk_sync` | Routing | ❌ | ❌ | 1 | ✅ | 7A |
| `file_routing_status` | File | ❌ | ❌ | — | ✅ | 1I/5V/1E |
| `file_routing_sync` | Routing | ❌ | ✅ | 1 | ✅ | 2A/5V |
| `file_save_as` | File | ✅ | ✅ | 1 | ✅ | — |
| `file_search` | File | ❌ | ❌ | — | ✅ | 7A |
| `file_tempo_map` | File | ❌ | ✅ | — | ❌ | 1I/6V |
| `file_text_events` | File | ❌ | ✅ | — | ❌ | 1I/6V |
| `file_write` | File | ✅ | ✅ | 2 | ✅ | — |
| `filter_clear` | Routing | ✅ | ❌ | — | ✅ | — |
| `filter_set` | Routing | ✅ | ❌ | — | ✅ | — |
| `generate_assignment_suggestions` | PlaybackAnalysis | ✅ | ✅ | 2 | ✅ | — |
| `get_file_routings` | PlaybackAssignment | ✅ | ✅ | 1 | ✅ | — |
| `get_instrument_defaults` | PlaybackAssignment | ❌ | ✅ | — | ✅ | 7E |
| `hotspot_disable` | Hotspot | ❌ | ✅ | — | ❌ | — |
| `hotspot_enable` | Hotspot | ❌ | ✅ | — | ❌ | — |
| `hotspot_get_config` | Hotspot | ❌ | ✅ | — | ❌ | 7A |
| `hotspot_status` | Hotspot | ❌ | ✅ | — | ❌ | 7A |
| `hotspot_update_config` | Hotspot | ✅ | ✅ | — | ❌ | — |
| `instrument_add_to_device` | VirtualInstrument | ❌ | ✅ | — | ✅ | 1I/6V |
| `instrument_create_virtual` | VirtualInstrument | ❌ | ✅ | — | ✅ | 5A/1I/1V |
| `instrument_delete` | InstrumentSettings | ❌ | ✅ | 1 | ✅ | 1I/6V |
| `instrument_get_capabilities` | InstrumentSettings | ❌ | ✅ | — | ✅ | 1I/6V |
| `instrument_get_settings` | InstrumentSettings | ❌ | ✅ | — | ✅ | 6A/1I |
| `instrument_light_all_off` | InstrumentLight | ❌ | ❌ | — | ❌ | 1I/6V |
| `instrument_light_get` | InstrumentLight | ❌ | ✅ | — | ❌ | 1A/6V |
| `instrument_light_list` | InstrumentLight | ❌ | ✅ | — | ❌ | 7A |
| `instrument_light_set` | InstrumentLight | ❌ | ✅ | — | ❌ | 7V |
| `instrument_light_set_supported` | InstrumentLight | ❌ | ✅ | — | ❌ | 7V |
| `instrument_light_test` | InstrumentLight | ❌ | ❌ | — | ❌ | 1A/6V |
| `instrument_list_by_device` | VirtualInstrument | ❌ | ✅ | — | ✅ | 1I/6V |
| `instrument_list_capabilities` | InstrumentSettings | ❌ | ✅ | 1 | ✅ | 7A |
| `instrument_list_connected` | InstrumentSettings | ❌ | 〰️ | — | ✅ | 7A |
| `instrument_list_registered` | InstrumentSettings | ❌ | ✅ | — | ✅ | 7A |
| `instrument_save_all` | InstrumentSettings | ❌ | ✅ | 1 | ❌ | 1I/6V |
| `instrument_type_detect` | InstrumentSettings | ❌ | ❌ | — | ❌ | 7A |
| `instrument_types_list` | InstrumentSettings | ❌ | ❌ | — | ❌ | 7A |
| `instrument_update_capabilities` | InstrumentSettings | ❌ | ✅ | 1 | ✅ | 1I/6V |
| `instrument_update_settings` | InstrumentSettings | ❌ | ✅ | — | ✅ | 6I/1V |
| `instrument_voice_create` | InstrumentVoice | ❌ | ❌ | — | ❌ | 7V |
| `instrument_voice_delete` | InstrumentVoice | ❌ | ❌ | — | ❌ | 1A/6V |
| `instrument_voice_list` | InstrumentVoice | ❌ | ✅ | — | ❌ | 7V |
| `instrument_voice_replace` | InstrumentVoice | ❌ | ❌ | — | ❌ | 7V |
| `instrument_voice_update` | InstrumentVoice | ❌ | ❌ | — | ❌ | 1A/6V |
| `latency_auto_calibrate` | Latency | ❌ | ❌ | — | ✅ | — |
| `latency_delete` | Latency | ✅ | ❌ | — | ✅ | — |
| `latency_export` | Latency | ❌ | ❌ | — | ✅ | 7A |
| `latency_get` | Latency | ✅ | ❌ | — | ✅ | — |
| `latency_list` | Latency | ❌ | ❌ | — | ✅ | 7A |
| `latency_measure` | Latency | ✅ | ❌ | — | ✅ | — |
| `latency_recommendations` | Latency | ❌ | ❌ | — | ✅ | 7A |
| `latency_set` | Latency | ✅ | ❌ | — | ✅ | — |
| `lighting_all_off` | Lighting | ❌ | 〰️ | — | ✅ | 7A |
| `lighting_blackout` | Lighting | ❌ | 〰️ | 1 | ✅ | 7A |
| `lighting_bpm_get` | Lighting | ❌ | ✅ | — | ✅ | 7A |
| `lighting_bpm_set` | Lighting | ✅ | ✅ | — | ✅ | — |
| `lighting_bpm_tap` | Lighting | ❌ | ✅ | 1 | ✅ | 7A |
| `lighting_device_add` | Lighting | ✅ | ✅ | 1 | ✅ | — |
| `lighting_device_delete` | Lighting | ❌ | ✅ | — | ✅ | 4A/1I/2V |
| `lighting_device_list` | Lighting | ❌ | ✅ | — | ✅ | 7A |
| `lighting_device_scan` | Lighting | ❌ | ✅ | — | ✅ | — |
| `lighting_device_test` | Lighting | ❌ | 〰️ | — | ✅ | 5I/2V |
| `lighting_device_update` | Lighting | ✅ | ✅ | — | ✅ | — |
| `lighting_dmx_profiles` | Lighting | ❌ | ✅ | — | ✅ | 7A |
| `lighting_effect_list` | Lighting | ❌ | ✅ | — | ✅ | 7A |
| `lighting_effect_start` | Lighting | ✅ | ✅ | 1 | ✅ | — |
| `lighting_effect_stop` | Lighting | ❌ | ✅ | — | ✅ | 7V |
| `lighting_get_enabled` | Lighting | ❌ | ✅ | — | ❌ | 7A |
| `lighting_group_color` | Lighting | ✅ | ✅ | 1 | ✅ | — |
| `lighting_group_create` | Lighting | ✅ | ✅ | 1 | ✅ | — |
| `lighting_group_delete` | Lighting | ❌ | ✅ | — | ✅ | 3A/1I/3V |
| `lighting_group_list` | Lighting | ❌ | ✅ | — | ✅ | 7A |
| `lighting_group_off` | Lighting | ❌ | ✅ | — | ✅ | 4I/3V |
| `lighting_led_broadcast` | Lighting | ❌ | ❌ | 1 | ✅ | 7A |
| `lighting_master_dimmer` | Lighting | ✅ | ✅ | 2 | ✅ | — |
| `lighting_midi_learn` | Lighting | ❌ | ✅ | 2 | ✅ | — |
| `lighting_preset_delete` | Lighting | ❌ | ✅ | — | ✅ | 4A/1I/2V |
| `lighting_preset_list` | Lighting | ❌ | ✅ | — | ✅ | 7A |
| `lighting_preset_load` | Lighting | ❌ | ✅ | — | ✅ | 2V/5E |
| `lighting_preset_save` | Lighting | ❌ | ✅ | — | ✅ | 3A/1I/3V |
| `lighting_rule_add` | Lighting | ❌ | ✅ | 1 | ✅ | 1I/2V/4E |
| `lighting_rule_delete` | Lighting | ❌ | ✅ | — | ✅ | 4A/1I/2V |
| `lighting_rule_list` | Lighting | ❌ | ✅ | — | ✅ | 6A/1I |
| `lighting_rule_test` | Lighting | ❌ | 〰️ | — | ✅ | 5I/2V |
| `lighting_rule_update` | Lighting | ❌ | ✅ | — | ✅ | 4A/1I/2V |
| `lighting_rules_export` | Lighting | ❌ | ✅ | — | ✅ | 6A/1I |
| `lighting_rules_import` | Lighting | ❌ | ✅ | — | ✅ | 7V |
| `lighting_scene_apply` | Lighting | ❌ | ❌ | — | ✅ | 7V |
| `lighting_scene_save` | Lighting | ❌ | ✅ | — | ✅ | 4A/3V |
| `lighting_set_enabled` | Lighting | ❌ | ✅ | — | ❌ | 7A |
| `loop_create` | Loop | ✅ | ✅ | 1 | ❌ | — |
| `loop_delete` | Loop | ✅ | ✅ | 1 | ❌ | — |
| `loop_get` | Loop | ✅ | ✅ | 1 | ❌ | — |
| `loop_list` | Loop | ❌ | ✅ | — | ❌ | 7A |
| `loop_update` | Loop | ✅ | ✅ | — | ❌ | — |
| `midi_all_notes_off` | Midi | ✅ | ❌ | 2 | ✅ | — |
| `midi_categories_list` | File | ❌ | ❌ | — | ✅ | 7A |
| `midi_clock_toggle` | Midi | ✅ | ✅ | — | ❌ | — |
| `midi_instruments_list` | File | ❌ | ❌ | — | ✅ | 7A |
| `midi_panic` | Midi | ✅ | ✅ | 2 | ✅ | — |
| `midi_reset` | Midi | ✅ | ❌ | 2 | ✅ | — |
| `midi_send` | Midi | ✅ | ❌ | — | ✅ | — |
| `midi_send_cc` | Midi | ✅ | ✅ | 1 | ✅ | — |
| `midi_send_note` | Midi | ✅ | ✅ | 1 | ✅ | — |
| `midi_send_pitchbend` | Midi | ✅ | ✅ | — | ✅ | — |
| `monitor_start` | Routing | ✅ | ✅ | — | ✅ | — |
| `monitor_start_all` | Routing | ❌ | ✅ | — | ❌ | 7A |
| `monitor_stop` | Routing | ✅ | ✅ | — | ✅ | — |
| `monitor_stop_all` | Routing | ❌ | ✅ | — | ❌ | 7A |
| `network_connect` | Network | ✅ | ✅ | 1 | ✅ | — |
| `network_connected_list` | Network | ✅ | ✅ | 1 | ✅ | — |
| `network_disconnect` | Network | ✅ | ✅ | 1 | ✅ | — |
| `network_scan` | Network | ✅ | ✅ | 1 | ✅ | — |
| `playback_clear_channel_routing` | PlaybackRouting | ❌ | ❌ | — | ✅ | 7A |
| `playback_get_channels` | PlaybackRouting | ❌ | ❌ | — | ✅ | 7A |
| `playback_mute_channel` | PlaybackRouting | ❌ | ✅ | — | ✅ | 7V |
| `playback_pause` | PlaybackControl | ❌ | ✅ | — | ✅ | 7A |
| `playback_resume` | PlaybackControl | ❌ | ✅ | — | ✅ | 7A |
| `playback_seek` | PlaybackControl | ✅ | ✅ | 1 | ✅ | — |
| `playback_set_channel_routing` | PlaybackRouting | ❌ | ❌ | — | ✅ | 7V |
| `playback_set_disconnect_policy` | PlaybackRouting | ❌ | ❌ | — | ❌ | 7V |
| `playback_set_loop` | PlaybackControl | ✅ | ❌ | 2 | ✅ | — |
| `playback_set_tempo` | PlaybackControl | ❌ | ✅ | 1 | ✅ | 7A |
| `playback_set_volume` | PlaybackControl | ❌ | ✅ | — | ✅ | 7A |
| `playback_start` | PlaybackControl | ✅ | ✅ | 2 | ✅ | — |
| `playback_status` | PlaybackControl | ❌ | 〰️ | 1 | ✅ | 7A |
| `playback_stop` | PlaybackControl | ❌ | ✅ | 2 | ✅ | 7A |
| `playback_transpose` | PlaybackControl | ✅ | ✅ | 1 | ✅ | — |
| `playback_validate_routing` | PlaybackRouting | ❌ | ❌ | 1 | ❌ | 1I/5V/1E |
| `playlist_add_file` | Playlist | ❌ | ✅ | — | ✅ | 7V |
| `playlist_clear` | Playlist | ❌ | ❌ | — | ❌ | 1I/6V |
| `playlist_create` | Playlist | ❌ | ✅ | 1 | ✅ | 3A/4I |
| `playlist_delete` | Playlist | ❌ | ✅ | — | ✅ | 6A/1I |
| `playlist_get` | Playlist | ❌ | ✅ | — | ❌ | 1I/6V |
| `playlist_list` | Playlist | ❌ | ✅ | — | ✅ | 7A |
| `playlist_next` | Playlist | ❌ | ✅ | — | ❌ | 7V |
| `playlist_previous` | Playlist | ❌ | ✅ | — | ❌ | 7V |
| `playlist_remove_file` | Playlist | ❌ | ✅ | — | ❌ | 7V |
| `playlist_reorder` | Playlist | ❌ | ✅ | — | ❌ | 7V |
| `playlist_set_loop` | Playlist | ❌ | ✅ | — | ❌ | 1I/6V |
| `playlist_start` | Playlist | ❌ | ✅ | — | ❌ | 1I/6V |
| `playlist_status` | Playlist | ❌ | ❌ | — | ✅ | 7A |
| `playlist_stop` | Playlist | ❌ | ✅ | — | ❌ | 7A |
| `playlist_update_settings` | Playlist | ❌ | ✅ | — | ❌ | 1I/6V |
| `preset_delete` | Preset | ✅ | ❌ | 1 | ✅ | — |
| `preset_export` | Preset | ✅ | ❌ | 1 | ❌ | — |
| `preset_list` | Preset | ✅ | ❌ | 1 | ✅ | — |
| `preset_load` | Preset | ✅ | ❌ | 1 | ✅ | — |
| `preset_rename` | Preset | ✅ | ❌ | 1 | ❌ | — |
| `preset_save` | Preset | ✅ | ❌ | 1 | ✅ | — |
| `route_clear_all` | Routing | ❌ | ❌ | — | ✅ | 7A |
| `route_create` | Routing | ✅ | ❌ | 1 | ✅ | — |
| `route_delete` | Routing | ✅ | ❌ | 1 | ✅ | — |
| `route_duplicate` | Routing | ❌ | ❌ | — | ✅ | 7E |
| `route_enable` | Routing | ✅ | ❌ | 1 | ✅ | — |
| `route_export` | Routing | ❌ | ❌ | — | ✅ | 7E |
| `route_import` | Routing | ❌ | ❌ | — | ✅ | 7I |
| `route_info` | Routing | ❌ | ❌ | 1 | ✅ | 7E |
| `route_list` | Routing | ❌ | ❌ | 1 | ✅ | 7A |
| `route_test` | Routing | ❌ | ❌ | 1 | ✅ | 7E |
| `routing_save_hand_overrides` | Routing | ❌ | ✅ | 2 | ❌ | 7V |
| `serial_close` | Serial | ❌ | ✅ | — | ✅ | 2I/5V |
| `serial_list` | Serial | ❌ | ❌ | — | ✅ | 7A |
| `serial_open` | Serial | ❌ | ✅ | — | ✅ | 2I/5V |
| `serial_scan` | Serial | ❌ | ✅ | — | ✅ | 7I |
| `serial_set_enabled` | Serial | ❌ | ✅ | — | ✅ | 1A/6V |
| `serial_status` | Serial | ❌ | ❌ | — | ✅ | 7A |
| `session_delete` | Session | ✅ | 〰️ | 1 | ✅ | — |
| `session_export` | Session | ✅ | 〰️ | 1 | ✅ | — |
| `session_import` | Session | ✅ | ❌ | 1 | ✅ | — |
| `session_list` | Session | ❌ | 〰️ | 1 | ✅ | 7A |
| `session_load` | Session | ✅ | 〰️ | 2 | ✅ | — |
| `session_save` | Session | ✅ | 〰️ | 2 | ✅ | — |
| `string_instrument_apply_preset` | StringInstrument | ❌ | ✅ | — | ✅ | 7V |
| `string_instrument_create` | StringInstrument | ❌ | ✅ | 1 | ✅ | 3A/4I |
| `string_instrument_create_from_preset` | StringInstrument | ❌ | ✅ | — | ✅ | 7V |
| `string_instrument_delete` | StringInstrument | ❌ | ✅ | — | ✅ | 5A/1I/1V |
| `string_instrument_get` | StringInstrument | ❌ | ✅ | — | ✅ | 5A/1I/1V |
| `string_instrument_get_presets` | StringInstrument | ❌ | ✅ | — | ✅ | 7A |
| `string_instrument_get_scale_length_presets` | StringInstrument | ❌ | ✅ | — | ❌ | 7A |
| `string_instrument_list` | StringInstrument | ❌ | ✅ | — | ✅ | 6A/1I |
| `string_instrument_update` | StringInstrument | ❌ | ✅ | — | ✅ | 5A/2V |
| `sysex_identity_request` | Device | ❌ | ✅ | — | ❌ | 7I |
| `system_backup` | System | ✅ | 〰️ | — | ✅ | — |
| `system_check_update` | System | ❌ | ✅ | — | ✅ | — |
| `system_clear_logs` | System | ❌ | 〰️ | — | ✅ | — |
| `system_info` | System | ❌ | 〰️ | — | ✅ | 7A |
| `system_logs` | System | ❌ | 〰️ | 3 | ✅ | 7A |
| `system_reboot` | System | ❌ | 〰️ | — | ❌ | — |
| `system_restart` | System | ❌ | 〰️ | — | ✅ | — |
| `system_restore` | System | ❌ | 〰️ | 1 | ✅ | — |
| `system_shutdown` | System | ❌ | 〰️ | 1 | ✅ | — |
| `system_status` | System | ❌ | 〰️ | 1 | ✅ | 7A |
| `system_update` | System | ❌ | ✅ | — | ✅ | — |
| `tablature_convert_from_midi` | StringInstrument | ❌ | ✅ | — | ✅ | 7V |
| `tablature_convert_to_midi` | StringInstrument | ❌ | ✅ | — | ✅ | 7V |
| `tablature_delete` | StringInstrument | ❌ | ❌ | — | ✅ | 7V |
| `tablature_get` | StringInstrument | ❌ | ✅ | — | ✅ | 7V |
| `tablature_get_by_file` | StringInstrument | ❌ | ❌ | — | ✅ | 7V |
| `tablature_save` | StringInstrument | ❌ | ✅ | — | ✅ | 7V |
| `tuner_list_instruments` | Latency | ❌ | ✅ | — | ❌ | 7A |
| `tuner_monitor_start` | Latency | ❌ | ✅ | — | ❌ | 7A |
| `tuner_monitor_stop` | Latency | ❌ | ✅ | — | ❌ | 7A |
| `update_instrument_capabilities` | PlaybackAssignment | ❌ | ✅ | — | ✅ | 7V |
| `validate_instrument_capabilities` | PlaybackAssignment | ❌ | ✅ | — | ✅ | 7A |
| `validate_routing_feasibility` | Routing | ❌ | ❌ | — | ❌ | 7V |
| `virtual_create` | VirtualInstrument | ✅ | ❌ | — | ✅ | — |
| `virtual_delete` | VirtualInstrument | ✅ | ❌ | — | ✅ | — |
| `virtual_instrument_toggle` | VirtualInstrument | ❌ | ✅ | — | ❌ | 1I/6V |
| `virtual_list` | VirtualInstrument | ❌ | ❌ | — | ✅ | 7A |
| `wifi_connect` | Hotspot | ✅ | ✅ | — | ❌ | — |
| `wifi_disconnect` | Hotspot | ❌ | ✅ | — | ❌ | — |
| `wifi_forget` | Hotspot | ✅ | ✅ | — | ❌ | — |
| `wifi_list_saved` | Hotspot | ❌ | ✅ | — | ❌ | 7A |
| `wifi_scan` | Hotspot | ❌ | ✅ | — | ❌ | 7A |

---

## 10. Recommandations

### 10.1 À appliquer en vague 2 — fichiers partagés (diffs exacts)

**a. `CLAUDE.md` — le pipeline de dispatch décrit une résolution versionnée qui
n'existe pas (F-23) et la liste des endpoints publics est incomplète (F-24).**

```diff
 `CommandRegistry` (`src/api/`) auto-discovers every `*.js` in
 `src/api/commands/`; each module exports `register(registry, app)` and binds
 named handlers. Dispatch pipeline: envelope validation → per-command payload
 validation via `JsonValidator.validateByCommand` (precompiled from
-`src/api/commands/schemas/*.schemas.js`) → versioned-handler lookup → async
-handler → response correlated by `id`.
+`src/api/commands/schemas/*.schemas.js`) → handler lookup **by command name**
+→ async handler → response correlated by `id`. There is **no dispatch on the
+envelope's `version` field**: ADR-003 deliberately chose additive `_vN` command
+names instead, so `version` is accepted for wire compatibility and ignored.
+**`validateByCommand` fails OPEN**: a command with no registered schema accepts
+any payload (86/270 have one — see `docs/audit/2026-09-07/01_API_CONTRACT.md`).
```

```diff
 Layered: `config.json` (committed defaults) → `.env` (dotenv) →
 `GMBOOP_*` environment variables. See `.env.example`. Optional token auth via
-`GMBOOP_API_TOKEN` (HTTP Bearer + WS query param); `/api/health` and
-`/api/update-status` are always public (the latter so the dashboard can poll
-during an in-place update).
+`GMBOOP_API_TOKEN` (HTTP Bearer + WS query param); `/api/health`,
+`/api/update-status` and `/api/capabilities` are always public (the second so
+the dashboard can poll during an in-place update, the third as a monitoring
+probe).
```

**b. `.github/workflows/*` — cliquet de couverture de schémas.** À ajouter à
l'étape `lint` (le script doit être ajouté à `package.json` par la vague 2) :

```yaml
      - name: WS command contract ratchet
        run: |
          COUNT=$(node scripts/audit/command-inventory.mjs | sed -n 's/.*with payload schema *: *\([0-9]*\).*/\1/p')
          echo "commands with a payload schema: $COUNT"
          test "$COUNT" -ge 86 || { echo "::error::schema coverage regressed below 86"; exit 1; }
```

**c. `docs/API.md`** — 83 commandes absentes (69,3 %). Liste exacte :
`node scripts/audit/command-inventory.mjs --json | jq -r '.summary.undocumented[]'`.
Périmètre §BD / lot L14.

### 10.2 Correctifs de code recommandés, non appliqués

| Pri | Cible | Action | Finding |
|---|---|---|---|
| **P1** | `src/utils/JsonValidator.js` | Inverser le défaut : `validateByCommand` échoue si aucun schéma **et** `data` non vide, sauf liste blanche explicite de commandes sans paramètre | F-19 |
| **P1** | `src/api/commands/schemas/` | Écrire les schémas dans l'ordre du §9.2, en commençant par les 10 du §9.1 | F-19 / F-20 |
| P2 | `src/lighting/LightingManager.js:215,218`, `src/lighting/instrument/InstrumentLightManager.js:259` | `eventBus.removeListener` → `eventBus.off` — **hors de mon périmètre**, échoue à chaque `Application.stop()` | **F-27** → L02 |
| P2 | `src/api/WebSocketServer.js` | Séparer le `try/catch` du parse de celui du dispatch (diff en §5.2) | F-21 |
| P2 | `src/utils/JsonValidator.js` | Valider `id` dans `validateCommand` (diff en §5.3) | F-22 |
| P3 | `src/api/CommandRegistry.js` | Corriger la JSDoc du versionnement (texte en §6) | F-23 |
| P3 | `src/api/HttpServer.js` | Exporter `isPrivateClient` pour la rendre testable ; trancher le statut public de `/api/capabilities` | F-24 |
| P3 | `public/js/` | Vérifier que `error.message` n'est jamais rendu en `innerHTML` (les messages reflètent l'entrée utilisateur) | F-25 → L09/L10 |
| P3 | UI | Exposer `midi_all_notes_off` et `midi_reset` (aucun bouton aujourd'hui) | §8.2 |

### 10.3 Ce que L01 n'a pas pu établir

| Sujet | Pourquoi | À qui |
|---|---|---|
| Départage des 3 bypass d'auth HTTP et comportement d'un client public | toutes les requêtes partent de `127.0.0.1` → `isPrivateClient()` toujours vrai, aucune interface non-privée dans le conteneur | **L10** |
| `GMBOOP_SECURITY_MODE=secure` en direct | non rejoué (session coupée) | **L10** |
| Soak du limiteur, 10 clients simultanés, backpressure sortante, flood MIDI/lighting | hors du temps de ce lot | **L12** |
| Reconnexion / heartbeat / coupure brutale du WebSocket | non testé | **L08** |
| Classification interne/mort des 72 orphelines | fait par le lot voisin | **L13** (`13_FEATURE_COMPLETENESS.md`) |
| `POST /api/sf2/` (upload), `POST /api/files` avec un vrai MIDI, corps HTTP géants | non sondés | **L07** |

---

## 11. Reproduire ce rapport

```bash
S=/tmp/.../scratchpad/L01
GMBOOP_API_TOKEN=<token> GMBOOP_SERVER_PORT=8101 \
GMBOOP_DATABASE_PATH=$S/gmboop.db GMBOOP_LOG_FILE=$S/app.log node server.js

node scripts/audit/command-inventory.mjs            # 270 / 86 schémas / 178+20 front
node $S/fuzz.mjs                                    # 167 cmds × 7 payloads hostiles
node $S/t_crash.mjs                                 # F-18 : une trame tue le processus
node $S/t_f06.mjs                                   # F-06 : 40/100 pendent 10 s
node $S/t_f07.mjs $S/t_f07b.mjs                     # F-07 : 13/19 panics perdus
node $S/t_env.mjs $S/t_env2.mjs $S/t_ver.mjs        # enveloppe, trames binaires, version
node $S/t_exploit.mjs $S/t_leak.mjs $S/t_tempo.mjs  # F-19/F-20/F-25
curl -s -o /dev/null -w '%{http_code} %{size_download}' http://127.0.0.1:8101/api/nope

node --experimental-vm-modules node_modules/jest/bin/jest.js tests/audit/l01-
```

> ⚠️ **Le serveur réécrit `config.json`** avec les surcharges d'environnement
> (port 8101, chemin de base) au démarrage. Après tout run :
> `git diff --stat config.json` puis `git checkout -- config.json`.
> Vérifié propre à la clôture de ce lot.
