# 12 — Performance, soak, résilience, observabilité (lot L12)

**Sections du plan couvertes :** AW, AX, AY, AZ, BA, BB, C02, C03
**Findings émis :** F-128 → F-137 · **Findings délégués tranchés :** F-01, F-02

---

## Avertissement de mesure — à lire avant tout chiffre

Cet audit s'est déroulé sur une machine **partagée par 15 agents travaillant en
parallèle** dans le même arbre de travail. Pendant les mesures :

| Contexte machine | Valeur |
|---|---|
| CPU | 4 cœurs (`nproc`) |
| Charge moyenne observée pendant les runs | **0,78 → 3,31** (1 min), soit jusqu'à ~83 % d'occupation |
| RAM | 16 Go, jamais sous pression |
| Node | v22.22.2 |
| Autres serveurs GMBoop vivants en simultané | 2 à 4 |
| Cible réelle du produit | Raspberry Pi (ARM, 1–8 Go) |

**Conséquence, énoncée sans détour : aucun chiffre absolu de ce rapport n'est
une caractéristique du produit.** Ni les 7,5 M événements/s, ni les 10 ms de
latence de commande, ni les p99 de boucle d'événements. Ce sont des mesures
faites sur un x86 chargé, pas sur un Pi.

Ce qui **est** exploitable, et sur quoi ce rapport s'appuie :

1. les **comportements** — dégrade-t-il proprement, meurt-il, ment-il ?
2. les **rapports** avant/après sur la même machine à la même minute ;
3. les **complexités et bornes** — une file bornée le reste, une fuite est une
   pente positive quelle que soit la machine ;
4. la **variance** — un chiffre qui bouge de 2× entre deux runs identiques
   n'est pas une mesure, c'est du bruit, et je le dis quand c'est le cas.

Chaque chiffre absolu ci-dessous est accompagné de la charge machine du moment.

---

## 1. Synthèse

| § | Sujet | État | Niveau | Findings |
|---|---|---|---|---|
| **BB** | Santé / capacités (`/api/health`) | **PASS** (était FAIL) | 4 | **F-01 CORRIGÉ · F-02 CORRIGÉ · F-128 CORRIGÉ** |
| **AW** | Performance backend | **PARTIAL** | 3 | F-131, F-134 |
| **AX** | Soak / endurance | **PARTIAL** | 3 | — (aucune fuite trouvée, 120 s seulement) |
| **AY** | Stress WebSocket | **PASS** | 4 | (confirme F-06, F-07 pour L01) |
| **AZ** | Injection de fautes | **PARTIAL** | 4 | **F-130 (P1)**, F-133 |
| **BA** | Observabilité | **PARTIAL** | 4 | F-132, F-133, F-134, F-135 |
| **C02** | Arrêt | **PARTIAL** | 4 | **F-129 (P1, corrigé par L02)**, F-137 |
| **C03** | Reprise après crash | **NOT TESTED** | 0 | délégué à L11 (§C03 lui appartient) |
| — | Réglage mort `ble.enabled` | **FAIL** | 4 | F-136 |

### Findings par sévérité

| Sév. | # | Titre | État |
|---|---|---|---|
| **P1** | F-129 | `LightingManager.shutdown()` levait avant `allOff()` : lumières allumées après l'arrêt | **CORRIGÉ par L02** (leur F-30) |
| **P1** | F-130 | Base SQLite verrouillée ⇒ **gel complet de la boucle d'événements pendant 10 s** | **OUVERT** |
| P2 | F-131 | `npm run perf:load` est une porte **instable** (2 échecs sur 5 runs identiques) | OUVERT |
| P2 | F-134 | `/api/metrics` n'expose ni la latence de boucle ni les durées de commande, pourtant mesurées | OUVERT |
| P2 | F-137 | L'arrêt ne coupe les notes que si le *lecteur* jouait ; le route-through live n'est jamais silencé | OUVERT |
| P3 | F-128 | `serial: ready` alors que le port série est désactivé en configuration | **CORRIGÉ (ce lot)** |
| P3 | F-132 | Spam de log : `[Deduplication] Result` en INFO = **53 %** des lignes | OUVERT |
| P3 | F-133 | Disque plein ⇒ perte **silencieuse et définitive** du fichier de log, `/api/health` reste `ok` | OUVERT |
| P3 | F-135 | Erreurs client masquées en `Internal server error` sans contexte ni `id` | OUVERT |
| P3 | F-136 | `ble.enabled` de `config.json` n'est jamais lu — réglage mort | OUVERT |

### Findings d'autres lots confirmés par la preuve live

| # | Lot | Preuve produite ici |
|---|---|---|
| F-06 | L01 | La trame de rate-limit est `{"type":"error","error":"Rate limit exceeded","timestamp":…}` — **sans `id`**. 440 trames sans `id` sur une rafale de 500. |
| F-07 | L01 | Une fois la connexion throttlée, **`midi_panic` n'est pas répondu du tout**. L'orchestre bloqué ne peut plus être fait taire depuis cette connexion. |

---

## 2. §BB — `/api/health` : la cible principale — **CORRIGÉ**

### 2.1 Reproduction du mensonge (avant correctif)

Serveur réel, port 8112, base neuve, sur cet hôte sans en-têtes ALSA et sans
D-Bus. Journal de démarrage :

```
WARN  DeviceManager initialized WITHOUT hardware MIDI support (native library not available)
ERROR Failed to initialize Bluetooth: D-Bus system bus not available
INFO  SerialMidiManager: disabled in config
```

`curl http://127.0.0.1:8112/api/health` **au même instant** :

```json
{"capabilitiesOverall":"degraded","capabilities":{
  "database":{"status":"ready"},
  "playback":{"status":"ready"},
  "usb":{"status":"ready"},        ← MENSONGE (F-01)
  "ble":{"status":"ready"},        ← MENSONGE (F-02)
  "network":{"status":"degraded","detail":"RTP-MIDI is a simplified AppleMIDI implementation…"},
  "serial":{"status":"ready"},     ← MENSONGE (F-128)
  "lighting":{"status":"ready"}}}
```

Trois capacités sur sept se déclarent opérationnelles alors que le journal, à la
milliseconde près, dit le contraire. **Le même processus affirme deux choses
incompatibles.** Un opérateur qui diagnostique « pourquoi rien ne sort ? »
apprend que l'USB va bien, que le BLE va bien, et que le série va bien.

### 2.2 Cause racine — un `?` qui n'est jamais faux

```js
usb: this.deviceManager ? { status: 'ready' } : { status: 'failed' },
ble: optional(this.bluetoothManager, 'ble'),
serial: optional(this.serialMidiManager, 'serial'),
```

Le prédicat testé est *« l'objet existe-t-il ? »*. Or les trois transports se
construisent **toujours** :

- `DeviceManager` : quand `import('easymidi')` échoue, le module attrape,
  journalise, substitue un bouchon inerte et met `midiAvailable = false`
  (`src/midi/devices/DeviceManager.js:34-55`, exposé en `this.midiAvailable`
  ligne 127). Le constructeur ne lève jamais.
- `BluetoothManager` : le constructeur réussit toujours ; l'échec est
  **asynchrone**, dans `_initializePort()`, qui journalise et **avale**
  (`src/transports/BluetoothManager.js:221-240`). `_capabilityErrors.ble`
  n'était renseigné que si le *constructeur* levait — ce qu'il ne fait pas.
- `SerialMidiManager` : se construit même avec `serial.enabled = false`.

`tests/capability-status.test.js` était vert sur les trois cas, parce qu'il pose
la question *« un objet truthy devient-il `ready` ? »* (oui) et jamais
*« un sous-système cassé se déclare-t-il cassé ? »* (non). Un test vert qui rate
le défaut : c'est le cas d'école, et il valait la peine d'être nommé.

### 2.3 Le correctif

Un seul fichier touché, `src/core/Application.js`, deux endroits.

**(a) `getCapabilityStatus()` — croiser chaque transport avec un prédicat
d'exécution.** Le principe posé : *une capacité est `ready` uniquement si elle
est réellement opérationnelle.*

```js
// usb — F-01 : lire la vérité d'exécution, pas l'existence de l'objet.
let usb;
if (!this.deviceManager) {
  usb = { status: 'failed', detail: 'DeviceManager was not constructed' };
} else if (this.deviceManager.midiAvailable === false) {
  usb = { status: 'failed',
          detail: 'Native MIDI library unavailable (easymidi/ALSA bindings missing) — USB MIDI ports cannot be opened' };
} else {
  usb = { status: 'ready' };
}

// ble — F-02 : getStatus().available reflète l'état réel du port BLE.
let ble = optional(this.bluetoothManager, 'ble');
if (ble.status === 'ready') {
  const bleRuntime = runtimeStatus(this.bluetoothManager);
  if (bleRuntime && bleRuntime.available === false) {
    ble = errored('ble')
      ? { status: 'failed', detail: errored('ble') }
      : { status: 'degraded',
          detail: 'BLE adapter not ready (initialising, powered off, or no BlueZ/D-Bus)' };
  }
}

// serial — F-128 : `enabled` est un choix d'exploitation, pas une aptitude.
let serial = optional(this.serialMidiManager, 'serial');
if (serial.status === 'ready') {
  const serialRuntime = runtimeStatus(this.serialMidiManager);
  if (serialRuntime && serialRuntime.enabled === false) {
    serial = { status: 'disabled', detail: 'Serial MIDI disabled in configuration' };
  } else if (serialRuntime && serialRuntime.available === false) {
    serial = { status: 'failed',
               detail: 'serialport module unavailable — UART MIDI cannot be opened' };
  }
}
```

`runtimeStatus()` enveloppe chaque `getStatus?.()` dans un `try/catch` : un
transport qui déraille ne doit pas emporter `/api/health` avec lui (testé).

**(b) `initialize()` — capter l'échec BLE *asynchrone*.** `BluetoothManager`
ré-émet déjà `bluetooth:powered_off` avec son motif ; il suffisait de l'écouter,
sans toucher au transport (territoire L04) :

```js
this.bluetoothManager.on?.('bluetooth:powered_off', (payload) => {
  this._capabilityErrors.ble = payload?.error || payload?.reason || 'BLE adapter powered off';
});
this.bluetoothManager.on?.('bluetooth:powered_on', () => {
  delete this._capabilityErrors.ble;
});
```

C'est ce qui fait passer BLE de `degraded` (« pas prêt, motif inconnu ») à
`failed` **avec le motif exact**, et qui le fait **revenir** à `ready` si
l'adaptateur s'allume plus tard. La distinction `degraded` / `failed` couvre
aussi la fenêtre de démarrage où l'adaptateur BlueZ n'a pas fini de monter : on
ne crie pas « panne » sur une initialisation en cours.

### 2.4 Preuve rouge → vert

`tests/audit/l12-health-capabilities.test.js`, 21 tests, écrit **avant** le
correctif contre les prédicats réels :

```
AVANT :  Tests: 8 failed, 13 passed, 21 total
  ✕ sans bibliothèque MIDI native, usb n'est PAS ready
  ✕ l'état usb porte un motif exploitable par un opérateur
  ✕ après un échec d'init du runtime BLE, ble n'est PAS ready
  ✕ l'erreur d'init enregistrée devient un état failed documenté
  ✕ runtime indisponible sans erreur enregistrée ⇒ degraded, pas ready
  ✕ serial désactivé en configuration est disabled, pas ready
  ✕ serial activé mais module serialport absent est failed
  ✕ overall degraded quand seul usb est tombé (le box joue encore)

APRÈS :  Tests: 26 passed, 26 total   (l12-health-capabilities + capability-status)
```

L'ancienne suite `tests/capability-status.test.js` reste verte : **aucune
régression du contrat existant**.

### 2.5 Vérification sur serveur vivant, après correctif

Même hôte, même absence d'ALSA et de D-Bus :

```json
{"capabilitiesOverall":"degraded","capabilities":{
  "database":{"status":"ready"},
  "playback":{"status":"ready"},
  "usb":{"status":"failed",
         "detail":"Native MIDI library unavailable (easymidi/ALSA bindings missing) — USB MIDI ports cannot be opened"},
  "ble":{"status":"failed","detail":"D-Bus system bus not available"},
  "network":{"status":"degraded","detail":"RTP-MIDI is a simplified AppleMIDI implementation…"},
  "serial":{"status":"disabled","detail":"Serial MIDI disabled in configuration"},
  "lighting":{"status":"ready"}}}
```

`overall` reste `degraded` et non `failed` : c'est voulu. L'USB est mort, mais la
machine peut encore jouer par le réseau — dire « failed » serait le mensonge
symétrique.

> **Pour L15 (QA matériel).** La checklist matérielle peut désormais s'appuyer sur
> `/api/health` : *« si `usb` n'est pas `ready`, ne cherchez pas plus loin, la
> bibliothèque native n'est pas là »*. Avant ce correctif, une QA qui s'y fiait
> partait faussée dès le premier point.

**F-01 : CORRIGÉ · F-02 : CORRIGÉ · F-128 : CORRIGÉ.** §BB passe de FAIL à
**PASS, niveau 4** (le niveau 5 exige un Pi avec du matériel réellement branché,
pour vérifier le cas `ready` positif — voir L15).

---

## 3. §AW / §AX — Benchmarks et soak : première exécution en audit

`npm run bench` et `npm run perf:load` existent depuis longtemps ; l'audit du
2026-08-22 constatait qu'ils n'avaient **jamais été lancés**. C'est fait.

### 3.1 `npm run bench` — charge machine 0,93 (1 min), 4 cœurs

Exit 0, **7/7 assertions passées**. Extrait :

| Mesure | Valeur (x86 chargé) | Lecture utile |
|---|---|---|
| `EventBus.emit` 1 écouteur | 7,6 M op/s | le bus n'est pas un goulot |
| `EventBus.emit` 10 écouteurs | 4,4 M op/s | dégradation ~1,7× pour 10× d'écouteurs — **sous-linéaire, bon signe** |
| `Logger.format` (texte) | 0,98 M op/s | ~1 µs par ligne : **le sink de log est 100× plus cher que le bus** |
| `JsonValidator.validateCommand` | 9,4 M op/s | la validation d'enveloppe est gratuite |
| `new ApplicationError` | 0,48 M op/s | ~2 µs — la capture de pile domine ; à ne pas mettre sur un chemin chaud |
| gigue de lecture (`playback-jitter`) | p50 0,001 ms · p99 0,001 ms · **p999 0,032 ms** | l'émission elle-même n'introduit pas de gigue |
| `ws-flood` | 4 000 diffusions en 1,2 ms, **3 998 coalescées, 2 rejetées client lent** | la coalescence fait son travail |
| `snapshot lookup` p99 | 0,0005 ms, valeur figée malgré 100 mutations concurrentes | l'instantané de lecture tient son contrat |

**Ce qui compte ici n'est aucun de ces chiffres**, c'est que : (a) le harnais
tourne, (b) ses 7 assertions internes passent, (c) les rapports entre postes
sont sains — le coût est dans le log et la création d'erreur, pas dans le
routage.

### 3.2 `npm run perf:load` — recherche de fuite

| Run | Paramètres | Charge (1 min) | Résultat |
|---|---|---|---|
| 1 | défaut : 200 k événements, soak 5 s | 0,78 | **10/10 budgets tenus** |
| 2 | 1 M événements, soak **120 s** | 0,81 → 3,00 | 9/10 — `A.eventloop_p99` 54,6 ms (budget < 50) |

**Scénario C (soak), le point qui intéresse la fuite :**

```
Scénario C — soak 120 s (pente de croissance du tas)
  [PASS] C.heap_slope: 0.01 MB/s   (budget < 8)
  [PASS] C.samples: 15718
```

Régression des moindres carrés sur **15 718 échantillons de tas** répartis sur
120 s, avec `global.gc()` à chaque échantillon : **pente = 0,01 Mo/s**, soit
~1,2 Mo sur les 120 s, dans le bruit d'un tas qui oscille entre 18 et 20 Mo.
À 5 s, même pente. **La mémoire redescend bien après GC : aucune fuite détectée
sur le chemin chaud du séquenceur.**

Vérification structurelle en appui : les cartes d'état de `PlaybackScheduler`
(`_activeNotes`, `_noteOnTimes`, `_droppedNoteOns`, `_noteInstance`,
`_lastNoteOnTime`) sont toutes clefées `device:canal[:note]` — donc bornées par
`appareils × 16 × 128`, pas par la longueur du morceau. Rien ne s'accumule
« par événement ».

**Réserve honnête sur §AX :** 120 s n'est pas un soak. Le plan demande
1 h / 8 h / 24 h / 72 h. Sur une machine partagée par 15 agents, un run de 8 h
aurait été à la fois impoli et non interprétable. **§AX reste PARTIAL** ; la
pente mesurée est un signal encourageant, pas une preuve d'endurance. La mesure
longue appartient au Pi (L15).

### 3.3 F-131 — `npm run perf:load` est une porte instable (P2)

Le budget `A.eventloop_p99 < 50 ms` **échoue de façon non déterministe**. Cinq
runs strictement identiques (1 M événements), même machine, même minute :

| Run | Charge (1 min) | `A.eventloop_p99` | Verdict |
|---|---|---|---|
| 1 | 2,90 | 55,05 ms | **FAIL** |
| 2 | 2,90 | 27,41 ms | PASS |
| 3 | 3,31 | 47,94 ms | PASS |
| 4 | 3,31 | **56,26 ms** | **FAIL** |
| 5 | 3,31 | 45,74 ms | PASS |

**2 échecs sur 5 runs identiques**, avec un rapport de 2,05× entre le meilleur
et le pire. Un tel écart ne mesure pas le code.

Cause : le scénario A traite 1 M événements à ~7 M ev/s, soit **~130 ms de
durée totale**, observée par `monitorEventLoopDelay({ resolution: 10 })` — donc
**une douzaine d'échantillons**. Le « p99 » de 13 échantillons **est le
maximum**. La métrique publiée comme un percentile est en réalité « le pire
creux de 10 ms rencontré », et sur une machine partagée elle capte l'ordonnanceur
des voisins bien plus que le code testé.

Preuve complémentaire : agrandir la jeune génération (`--max-semi-space-size=64`)
n'améliore pas le p99 (60,88 ms, tas ×7,5) — ce n'est donc pas une pression GC
qu'on pourrait accuser, c'est du bruit d'ordonnancement.

**Recommandation.** Ne pas mettre ce budget en porte CI tant qu'il n'échantillonne
pas assez. Deux options, au choix : allonger le scénario A jusqu'à ≥ 5 s de
travail continu (≥ 500 échantillons) avant de parler de p99, ou remplacer
`A.eventloop_p99` par une borne sur le **maximum** assumée comme telle, avec un
seuil calibré sur le Pi. Le budget de débit (`≥ 150 000 ev/s`) et celui de pente
de tas (`< 8 Mo/s`), eux, sont robustes : **ils n'ont jamais bougé sur aucun run.**

---

## 4. §AZ — Injection de fautes : faute × comportement × verdict

Toutes les fautes ont été injectées **sur un serveur réel**, port 8112, base
dédiée.

| Faute injectée | Comportement observé | Verdict |
|---|---|---|
| **Port 8112 déjà occupé** | `ERROR HTTP server error: listen EADDRINUSE` → `Start failed` → séquence d'arrêt complète déroulée → `exit 1`. Le serveur **déjà en place n'est pas perturbé** (`/api/health` = 200 pendant et après). | **PASS** |
| **Base sur un système de fichiers plein** (tmpfs 256 Ko saturé) | `ERROR Migration 1 failed: database or disk is full` → `Initialization failed` → `exit 1`, propre et immédiat. Message exploitable. | **PASS** |
| **Fichier de log sur un disque plein**, base saine | Le serveur **démarre et sert** (`/api/health` = 200). Une ligne console : `Log stream error: ENOSPC: no space left on device, write`. Puis **plus rien** : le fichier reste à 0 octet, aucune tentative de reprise, `/api/health` continue de répondre `"status":"ok"`. | **PARTIAL — F-133** |
| **Base verrouillée par une autre connexion** (`BEGIN IMMEDIATE`) | **Gel complet du processus pendant 10,04 s** : la commande d'écriture met 10 040 ms puis échoue, et `/api/health` **émis en parallèle met 10 095 ms**. Récupération intégrale au relâchement (écriture suivante : 10 ms). | **FAIL — F-130 (P1)** |
| **Client WebSocket qui cesse de lire** (socket en pause, 50 msg/s pendant 20 s) | RSS 102,3 → 103,4 Mo (**+1,1 Mo sur 20 s**), tas stable 18,4 → 19,9 Mo. `/api/health` = 200, **un second client est servi normalement**. Aucune croissance non bornée. | **PASS** |
| **Client saturé, diffusion soutenue** (hermétique, `bufferedAmount` = 64 Mo) | La file reste `≤ maxQueueDepth`, **rien n'est poussé** dans le client saturé, `droppedByClient` et `criticalEvents` s'incrémentent, un client sain **continue d'être servi**, un client qui lève à l'envoi est **retiré de l'ensemble**. | **PASS** |
| **Trame WebSocket de 20 Mo** (plafond 16 Mo) | Fermeture **code 1009** (Message Too Big), `ERROR WebSocket client error: Max payload size exceeded`, serveur sain après (`/api/health` = 200). | **PASS** |
| **JSON invalide / trame binaire** | Socket **maintenue ouverte**, réponse `{"type":"error","error":"Internal server error"}` sans `id` ni contexte. Côté serveur : `ERROR Failed to process message: Expected property name…` sans IP ni taille. | **PARTIAL — F-135** |
| **Driver lighting pendu** | Non injecté ici — appartient à L02, qui a le harnais de drivers. Signalé, non attendu. | **NOT TESTED** (délégué L02) |

### 4.1 F-130 (P1) — une base verrouillée gèle tout le processus 10 secondes

C'est le finding le plus lourd de ce lot.

**Reproduction.** Serveur vivant. Une seconde connexion `better-sqlite3` prend
un `BEGIN IMMEDIATE` sur la même base et le conserve. On envoie alors
`instrument_create_virtual` par WebSocket et on interroge `/api/health` **en
parallèle** :

```
[écriture de référence, sans verrou]  ms=10     → succès
[verrou pris par la 2e connexion]
[écriture sous verrou]                ms=10040  → {"type":"error","error":"Internal server error"}
[sonde /api/health pendant le verrou] latences (ms) :
      [10095, 4, 4, 3, 2, 3, 3, 5, 4, 3, 2, 3, 2, 2, 2, 2]
[verrou relâché]
[écriture suivante]                   ms=10     → succès
[/api/health]                         200
```

La **première** sonde HTTP, émise juste après le début de l'écriture, met
**10 095 ms**. Les quinze suivantes mettent 2 à 5 ms. Ce n'est pas une commande
lente : c'est **la boucle d'événements entière qui ne tourne plus** pendant dix
secondes. `better-sqlite3` est synchrone, et `src/persistence/Database.js:98`
ouvre la connexion **sans pragma `busy_timeout`**, donc le défaut de la
bibliothèque (5 000 ms) s'applique — et ici deux écritures successives le
subissent l'une après l'autre : `DeviceSettingsDB.ensureDevice`, puis
`update instrument settings`. 5 s + 5 s = 10 s.

**Ce que le serveur journalise — et c'est à son crédit :**

```
ERROR DeviceSettingsDB.ensureDevice failed: database is locked
ERROR Failed to update instrument settings: database is locked
ERROR [cmd=instrument_create_virtual cid=w1] Command failed: database is locked
ERROR SqliteError: database is locked
WARN  Event loop lag: 10039.7ms (threshold: 50ms)
```

La ligne `[cmd=… cid=…]` corrèle commande et identifiant : c'est exactement ce
qu'il faut à 3 h du matin. Et `EventLoopMonitor` **a vu et nommé le gel**. Le
diagnostic est bon ; c'est le comportement qui ne l'est pas.

**Pourquoi c'est P1 sur scène.** Pendant ces 10 s, le séquenceur MIDI ne tourne
pas non plus. Ce n'est pas « une requête lente », c'est **le spectacle qui
s'arrête**. Et les déclencheurs plausibles ne manquent pas : la sauvegarde
quotidienne (`BackupScheduler`, 03:00), un `VACUUM`, un second processus lancé
par erreur sur la même base, un outil de maintenance ouvert par l'opérateur.

**Recommandation (hors périmètre de ce lot — appartient à L07).**
1. Poser explicitement `this.db.pragma('busy_timeout = 250')` à la connexion :
   250 ms de gel est un accroc, 10 s est une panne. Le code appelant voit alors
   `SQLITE_BUSY` assez tôt pour réessayer hors du chemin chaud.
2. Faire remonter `SQLITE_BUSY` au client comme une erreur nommée
   (`DatabaseBusyError`) et non comme `Internal server error`.
3. Interdire structurellement l'écriture synchrone pendant une lecture en cours,
   ou au minimum instrumenter : `EventLoopMonitor` sait déjà crier.

### 4.2 F-133 (P3) — le disque plein tue le journal en silence

Le comportement global est bon : **le serveur continue de servir**. Mais le sink
fichier meurt définitivement après **une seule** ligne console
(`Log stream error: ENOSPC…`), le fichier reste à 0 octet, aucune reprise n'est
tentée, et `/api/health` répond toujours `"status":"ok"`.

Traduit sur scène : la boîte tourne, l'opérateur croit avoir des journaux, il
n'en a aucun, et rien ne le lui dit. Le code sait pourtant se rouvrir — c'est
fait après une rotation ratée (`Logger._rotate`, commentaire « audit B3 M2 »),
mais pas après une erreur de flux.

**Recommandation.** Mémoriser l'échec dans le Logger (`this._fileSinkDown`),
tenter une réouverture périodique, et exposer l'état dans `/api/health` comme
une capacité `logging` — c'est précisément le genre de mensonge par omission que
le correctif §BB vient d'éliminer ailleurs.

---

## 5. §AY — Stress WebSocket : re-mesure du comportement

Plafonds d'août : 60 msg/s/connexion, 32 Mo/s, trame max 16 Mo, 10 clients.
**Le comportement est identique, et il est bon.**

| Rafale (1 connexion) | Réponses avec `id` | Trames d'erreur | Socket |
|---|---|---|---|
| 10 | 10 | 0 | ouverte |
| 100 | **60** | 40 | ouverte |
| 500 | **60** | 440 | ouverte |

Le plafond de 60/s/connexion est **exactement reproduit**, l'excédent est
refusé par une trame d'erreur, et **la socket reste ouverte** — dégradation
propre, pas de blocage de la boucle d'événements. Une trame de 20 Mo est fermée
en 1009 et le serveur reste sain.

### Ce que voit un client throttlé — pour L01

**F-06 confirmé.** La trame de rejet est :

```json
{"type":"error","error":"Rate limit exceeded","timestamp":1788779413161}
```

**Aucun `id`.** Les 440 commandes rejetées de la rafale de 500 ne sont donc
jamais corrélées côté client : chacune attend son délai d'expiration. Vu de
l'interface, une pression un peu vive sur le clavier virtuel se traduit par des
dizaines de commandes qui « pendent » — le symptôme décrit dans F-06, ici mesuré.

**F-07 confirmé, et il est pire que « non exempté ».** Après 200 messages de
saturation, un `midi_panic` envoyé sur la même connexion **n'obtient aucune
réponse** :

```
[panic-under-throttle] panic answered=false reply=null
```

Le limiteur *appareil* exempte bien les messages prioritaires
(`DeviceManager.js:997-1003`, « panic bypasses the rate limiter ») ; le limiteur
*WebSocket*, lui, ne connaît pas cette notion. Concrètement : la seule commande
dont on a besoin quand tout part de travers est **la première à être refusée**,
parce que la situation qui la rend nécessaire est aussi celle qui sature la
connexion. Le contournement existe (rouvrir une socket neuve) mais personne n'y
pense sous stress.

---

## 6. §C02 — Arrêt : signaux réels

Signaux envoyés à un vrai processus, pas simulés.

| Cas | Code de sortie | Durée | `Received` | `Stopping` | `Stopped` |
|---|---|---|---|---|---|
| `SIGTERM` ×1 | **0** | 14 ms | 1 | 1 | 1 |
| `SIGINT` ×1 | **0** | 13 ms | 1 | 1 | 1 |
| `SIGTERM` ×2 + `SIGINT` ×2 en rafale | **0** | 13 ms | **1** | **1** | **1** |

**Le garde `shuttingDown` tient** : quatre signaux, une seule séquence d'arrêt,
sortie 0. Vérifié par l'expérience, comme demandé — pas par la lecture.

Séquence observée (SIGTERM) :

```
Received SIGTERM, shutting down gracefully...
Stopping application... → Backup scheduler stopped → MidiRouter destroyed
→ WebSocket server closed → Hot-plug monitoring stopped → DeviceManager closed
→ BluetoothManager cleaned up → NetworkManager shutdown complete
→ SerialMidiManager shut down → [lightingManager] → Database closed
→ === GeneralMidiBoop 0.8.1 Stopped ===
```

L'ordre est correct et l'isolation par étape fonctionne (`step()` attrape et
continue). Deux invariants sont désormais verrouillés par test
(`tests/audit/l12-resilience.test.js`) : **les notes sont coupées avant la
fermeture des ports**, et **la base est fermée en dernier**.

### 6.1 F-129 (P1) — l'arrêt du lighting levait avant `allOff()`

**Reproduit sur serveur vivant, à chaque arrêt, sans exception** — démarrage
raté sur port occupé compris :

```
ERROR Stop step "lightingManager" failed (continuing): this.eventBus.removeListener is not a function
```

`EventBus` (`src/core/EventBus.js`) expose `off()`, pas le `removeListener()` de
`EventEmitter`. Or `_removeEventListeners()` était la **première instruction** de
`LightingManager.shutdown()`. La `TypeError` sautait donc **tout le reste de la
fonction** : intervalle de santé, timers de lot LED, fondus actifs,
`effectsEngine.shutdown()`, **`allOff()`**, et la déconnexion de chaque driver.

Conséquence physique : **les lumières restaient allumées après la fin du
spectacle**, les sockets Art-Net/sACN/MQTT et le GPIO restaient ouverts, et
l'écouteur `midi_message` restait attaché — donc s'accumulait à chaque
`restart()`.

C'est exactement le point de la checklist §C02 que l'audit d'août signalait
comme *« complètement non testé, et le seul avec une conséquence physique »*.

**La même cause racine a mordu ailleurs, plus fort.** Le lot L01 a trouvé le
même appel `eventBus.removeListener` dans `lighting_midi_learn`, mais à
l'intérieur d'un `setTimeout` : la `TypeError` y devenait un
`uncaughtException`, donc **le processus était tué** (leur P0). Le même défaut
d'API produit donc, selon le site d'appel, soit un arrêt incomplet (ici), soit
une mort du serveur (là). C'est le signe d'un problème de contrat, pas d'une
faute de frappe isolée : `EventBus` ressemble assez à un `EventEmitter` pour que
`removeListener` soit écrit par réflexe, et assez peu pour qu'il explose.

**État : CORRIGÉ pendant cet audit** (L02, leur finding F-30 : `off()` au lieu
de `removeListener()`, plus la mise à `null` des handlers ; L01 pour le site
`midi_learn`). Vérifié à HEAD : `grep -rn "\.removeListener(" src/` ne renvoie
plus que trois appels **légitimes** sur de vrais `EventEmitter` Node
(`NetworkManager.js:745,749` sur un socket, `Application.js:832` sur `process`).
Verrouillé ici par deux tests : `EventBus` n'expose bien que `off()`, et
`shutdown()` atteint désormais `allOff()` en détachant ses écouteurs. Le mérite
des correctifs revient à L02 et L01 ; ce lot apporte la preuve d'exploitation
(le journal de **chaque** arrêt réel) et le verrou de non-régression.

**Recommandation résiduelle** (vague 2, une ligne dans `src/core/EventBus.js`) :
ajouter `removeListener(event, cb) { return this.off(event, cb); }`. La classe
imite déjà `on` / `off` / `once` / `emit` / `removeAllListeners` ; l'alias
manquant est le seul écart, et il aura coûté un P0 et un P1 dans le même audit.

### 6.2 F-137 (P2) — le route-through live n'est jamais silencé à l'arrêt

`Application.stop()` ne contient **aucun panic**. Les notes ne sont coupées que
par un chemin unique : `midiPlayer.destroy()` → `stop()` → `sendAllNotesOff()`,
et `stop()` sort immédiatement si `!this.playing`.

Donc : un arrêt **pendant une lecture** coupe bien les notes (vérifié par test
d'ordonnancement). Un arrêt alors que l'utilisateur joue **au clavier MIDI en
route-through**, ou après un `panic` partiel, ne coupe rien : `DeviceManager.close()`
ferme les ports sans rien émettre — et fermer un port MIDI **ne silencie pas**
l'instrument qui a reçu les note-on ; il continue de tenir la note jusqu'à
extinction physique.

**Recommandation.** Ajouter une étape `panic` explicite dans `stop()`, avant
`deviceManager.close()`, inconditionnelle et idempotente : CC 120 (All Sound
Off) + CC 123 (All Notes Off) sur les 16 canaux de chaque sortie ouverte. Le
chemin prioritaire qui contourne le limiteur existe déjà
(`DeviceManager.js:997`). C'est quelques lignes, et c'est la différence entre
une salle silencieuse et un cluster tenu après l'extinction de la console.

*(Périmètre : `Application.stop()` n'est pas dans la liste des correctifs
autorisés à ce lot ; la modification est proposée, non appliquée.)*

### 6.3 §C03 — reprise après crash : NOT TESTED

`uncaughtException` est routé dans le même chemin d'arrêt (vérifié à la
lecture), donc le processus sort au lieu de continuer dans un état indéfini —
bon choix pour un appareil sous superviseur. Mais le scénario complet
(kill -9, relance, intégrité de la base, WAL orphelin, reprise PM2) appartient à
**L11** qui a le harnais d'installation ; non dupliqué ici.

---

## 7. §BA — Observabilité : ce qu'on voit quand ça casse à 3 h du matin

### Ce qui va bien — et ce n'est pas rien

| Point | État | Preuve |
|---|---|---|
| Niveaux debug/info/warn/error, filtre par niveau | **PASS** | `Logger._levelNum`, cache O(1) |
| Horodatage ISO 8601 | **PASS** | toutes les lignes citées dans ce rapport |
| Rotation par taille | **PASS** | `_rotate()` : décale `.1→.N`, supprime le plus ancien, rouvre le flux ; défaut 10 Mo × 5 |
| Reprise après rotation ratée | **PASS** | réouverture explicite dans le `catch` (« audit B3 M2 ») |
| Charge utile circulaire | **PASS** | dégradée en `[unserializable log payload: …]`, ne lève pas |
| Corrélation commande ↔ erreur | **PASS** | `[cmd=instrument_create_virtual cid=w1] Command failed: database is locked` |
| Détection du gel de boucle | **PASS** | `WARN Event loop lag: 10039.7ms (threshold: 50ms)`, throttlé à 1/5 s pour ne pas amplifier le mal qu'il mesure |
| **Aucune fuite du token d'API** | **PASS** | token de 64 caractères **passé en paramètre d'URL WebSocket** ; `grep` du token dans `gmboop.log` et la sortie console : **0 occurrence**, y compris sur `Client connected: 127.0.0.1` |

Ce dernier point méritait d'être vérifié plutôt que supposé : l'authentification
WebSocket se fait par `?token=…`, et beaucoup de serveurs journalisent l'URL de
la requête d'upgrade. Celui-ci ne le fait pas.

### F-132 (P3) — 53 % du journal est une seule ligne inutile

Sur un serveur qui n'a **rien fait** d'autre que répondre à quelques sondes :

```
376 lignes au total
199 lignes  INFO  [Deduplication] Result: 0 → N devices     ← 53 %
 34 lignes  INFO  Migration N completed
  5 lignes  INFO  Client connected / disconnected
```

`src/midi/devices/DeviceManager.js:921` journalise le **résultat** de la
déduplication en `info`, alors que ses deux voisines immédiates (le détail des
fusions et des rejets) sont en `debug`. La ligne est émise à chaque énumération
d'appareils — donc à chaque `system_status`, à chaque cycle de hot-plug (toutes
les 5 s), et une fois par commande qui touche la liste d'appareils. Pendant la
rafale de 500 messages, elle sort ~60 fois par seconde.

Effet concret : le fichier de 10 Mo qui doit contenir l'historique d'une soirée
tourne surtout sur du bruit, et la ligne qui explique la panne est rotée hors du
journal plus vite qu'elle ne devrait.

**Correctif proposé** (une ligne, dans le périmètre de L04) :

```diff
-    this.logger.info(
+    this.logger.debug(
       `[Deduplication] Result: ${allDevices.length} → ${uniqueDevices.length} devices`
     );
```

### F-135 (P3) — « Internal server error » sans contexte

Trois fautes différentes produisent, côté client, exactement la même chaîne
opaque, sans `id`, sans code, sans indice :

| Ce que le client envoie | Ce qu'il reçoit |
|---|---|
| JSON invalide (`{not json`) | `{"type":"error","error":"Internal server error"}` |
| Trame binaire (`0x01 0x02 0x03`) | `{"type":"error","error":"Internal server error"}` |
| Écriture sur base verrouillée | `{"type":"error","error":"Internal server error"}` |

Côté serveur, le journal est meilleur mais incomplet :
`ERROR Failed to process message: Expected property name or '}' in JSON at position 1`
— **sans l'IP du client, sans la taille de la trame, sans identifiant de
connexion**. Impossible, avec dix clients, de savoir lequel envoie n'importe
quoi. Et une erreur *client* journalisée en `ERROR` permet à un client fautif de
remplir le journal d'erreurs du serveur.

**Recommandations** (périmètre L01) : journaliser les fautes d'enveloppe en
`warn` avec `{ ip, bytes, connectionId }` ; distinguer au moins
`invalid_json` / `unsupported_frame` / `database_busy` dans la trame renvoyée ;
et y remettre l'`id` quand il est connu — ce qui recoupe F-06.

### F-134 (P2) — `/api/metrics` n'expose pas ce qui est déjà mesuré

Réponse complète de l'endpoint sur le serveur vivant :

```
gmboop_uptime_seconds 146.6
gmboop_websocket_clients 0
gmboop_memory_heap_used_bytes 18774880
gmboop_memory_rss_bytes 106987520
gmboop_info{version="0.8.1"} 1
```

Cinq gauges. Absents : **la latence de boucle d'événements** — pourtant mesurée
en continu par `EventLoopMonitor.currentLag` et lue par `PlaybackScheduler` —
et **la durée des commandes**, pourtant calculée et renvoyée dans chaque
réponse (`"duration":0`) et émise sur l'`EventBus` (`ws.command.completed`).

Le gel de 10 s de F-130 était **parfaitement visible** dans le processus. Il
n'était visible d'**aucun** outil externe. Une supervision branchée sur
`/api/metrics` aurait vu un serveur en pleine forme pendant que la salle
attendait dix secondes.

**Correctif proposé** — additif, deux fichiers, aucun changement de comportement.

`src/infrastructure/monitoring/EventLoopMonitor.js` :

```diff
   constructor({ logger, wsServer, threshold = 50 }) {
     …
     this.currentLag = 0;
+    this.maxLag = 0;
+    this.lagBreaches = 0;
   }
```
```diff
       this.currentLag = lag > 0 ? lag : 0;
+      if (this.currentLag > this.maxLag) this.maxLag = this.currentLag;
+      if (lag > this._threshold) this.lagBreaches++;
```
```diff
+  /** Snapshot for /api/metrics. */
+  getStats() {
+    return { currentLag: this.currentLag, maxLag: this.maxLag,
+             breaches: this.lagBreaches, thresholdMs: this._threshold };
+  }
```

et, dans le générateur Prometheus de `src/api/HttpServer.js` (fichier partagé —
**non modifié par ce lot**) :

```
# HELP gmboop_event_loop_lag_ms Current event loop lag in milliseconds
# TYPE gmboop_event_loop_lag_ms gauge
gmboop_event_loop_lag_ms <currentLag>
# HELP gmboop_event_loop_lag_max_ms Peak event loop lag since boot
# TYPE gmboop_event_loop_lag_max_ms gauge
gmboop_event_loop_lag_max_ms <maxLag>
# HELP gmboop_event_loop_lag_breaches_total Ticks above the lag threshold
# TYPE gmboop_event_loop_lag_breaches_total counter
gmboop_event_loop_lag_breaches_total <breaches>
```

Ce lot ne l'a **pas appliqué** : ajouter une API sans son consommateur produit du
code mort, et `HttpServer.js` est un fichier partagé. À appliquer d'un bloc en
vague 2.

---

## 8. F-136 (P3) — `ble.enabled` est un réglage mort

`config.json` déclare :

```json
"ble": { "enabled": false, "scanDuration": 10000 }
```

`grep -rn "ble.*enabled" src/core/Application.js src/transports/BluetoothManager.js` :
**aucune occurrence**. `BluetoothManager` est construit inconditionnellement et
lance son initialisation de port, quelle que soit la valeur du réglage. Mettre
`ble.enabled` à `false` **n'a aucun effet observable**.

Le contraste avec le série est net : `SerialMidiManager` lit bien son
`serial.enabled` et se met en veille (`SerialMidiManager: disabled in config`) —
c'est d'ailleurs ce qui rend `serial: disabled` calculable dans le correctif §BB.
Le BLE n'a pas cet interrupteur.

Au sens du critère de sortie n°1 du plan (« aucune capacité morte : tout réglage
exposé produit un effet réel »), c'est un **FAIL**. Sur un Pi sans BlueZ, cela
coûte aussi une tentative d'initialisation D-Bus et une ligne `ERROR` à chaque
démarrage, pour un sous-système que l'exploitant a explicitement désactivé.

**Recommandation** (périmètre L04) : honorer `ble.enabled` à la construction, et
rapporter alors `ble: disabled` — le correctif §BB le prendra en compte sans
modification, puisque `optional()` traite déjà l'absence de service comme
`disabled`.

---

## 9. Livrables de ce lot

### Fichiers créés

| Fichier | Contenu | État |
|---|---|---|
| `docs/audit/2026-09-07/12_PERF_RESILIENCE.md` | ce rapport | — |
| `tests/audit/l12-health-capabilities.test.js` | 21 tests — les **vrais** prédicats de `/api/health` (F-01, F-02, F-128) | **vert** (rouge avant correctif : 8/21) |
| `tests/audit/l12-resilience.test.js` | 13 tests — ordre d'arrêt, isolation des étapes, idempotence des handlers de signal, backpressure `WsOutputQueue`, `EventLoopMonitor` | **vert** |

### Fichier de production modifié

`src/core/Application.js` uniquement, deux emplacements, décrits en §2.3 :
`getCapabilityStatus()` (prédicats d'exécution pour `usb`, `ble`, `serial`) et
`initialize()` (capture de l'échec BLE asynchrone). Aucun fichier partagé
(`package.json`, `config.json`, `.github/`, `CLAUDE.md`, `.eslintrc.json`) n'a
été touché ; `config.json` a été vérifié intact après chaque exécution serveur.

### Recommandations, par priorité

| Pri | Lot | Action |
|---|---|---|
| **P1** | L07 | **F-130** : poser `busy_timeout` explicite (≈250 ms) et remonter `SQLITE_BUSY` comme erreur nommée. Dix secondes de gel du processus sont une panne de spectacle. |
| **P2** | L01 | **F-07** : exempter `midi_panic` (et le lot des commandes de silence) du limiteur WebSocket, comme le fait déjà le limiteur appareil. |
| **P2** | L01 | **F-06** : remettre l'`id` dans la trame de rate-limit ; 440 commandes non corrélées sur une rafale de 500. |
| **P2** | vague 2 | **F-134** : appliquer le diff `EventLoopMonitor` + `/api/metrics` du §7. |
| **P2** | vague 2 | **F-137** : étape `panic` inconditionnelle dans `Application.stop()`, avant `deviceManager.close()`. |
| **P2** | vague 2 | **F-131** : rendre `A.eventloop_p99` échantillonnable (≥ 5 s de scénario A) avant d'en faire une porte CI ; garder `A.throughput` et `C.heap_slope`, robustes. |
| P3 | L04 | **F-132** : passer `[Deduplication] Result` en `debug`. **F-136** : honorer `ble.enabled`. |
| P3 | vague 2 | **F-133** : marquer la mort du sink fichier et la réexposer dans `/api/health`. |
| P3 | L01 | **F-135** : contexte (`ip`, `bytes`, `connectionId`) et typage des erreurs d'enveloppe ; `warn` plutôt que `error` pour une faute client. |
| **HW** | L15 | §AX vrai soak (1 h / 8 h / 24 h / 72 h) et §AW sur Pi 3B+/4/5 : les chiffres de ce rapport ne transfèrent pas. Vérifier aussi le cas `usb: ready` **positif**, impossible ici. |

---

## 10. Ce qui reste non couvert, dit franchement

- **§AX n'est pas un vrai soak.** 120 s de séquenceur en continu, pas 24 h. La
  pente de tas mesurée (0,01 Mo/s sur 15 718 échantillons) est un signal
  encourageant, pas une preuve d'endurance.
- **§C03** (reprise après crash) n'a pas été instruit : il appartient à L11.
- **Le driver lighting pendu** n'a pas été injecté : L02 a le harnais de drivers,
  et je ne l'ai pas attendu.
- **Aucun chiffre absolu n'est transférable au Pi.** Répété ici parce que c'est
  la réserve la plus facile à oublier en relisant un tableau de mesures.
- Les plafonds de §AY (nombre max d'instruments, événements MIDI/s soutenables,
  clients simultanés sous charge réelle, taille max de fichier MIDI) restent
  **non déterminés**, comme en août.
