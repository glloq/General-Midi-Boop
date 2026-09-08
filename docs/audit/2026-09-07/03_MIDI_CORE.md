# 03 — Cœur MIDI & conformité protocole (lot L03)

**Périmètre :** plan §D01–D05, §BK · **Date :** 2026-09-07 · **Base :** `00_BASELINE.md`
**Findings :** F-38 → F-45 (8) · **Suites ajoutées :** 4 fichiers, **102 tests**, tous verts
**Correctifs appliqués :** 3 (F-38, F-40, F-42), tous rouge → vert, tous dans
`src/midi/devices/DeviceManager.js`

---

## 1. Synthèse

### 1.1 La classe de bug F-08 est balayée. Elle contenait pire que F-08.

L'audit du 2026-08-22 avait trouvé **à la main** que `DeviceManager.handleRawMidi()`
laissait tomber les System Common que `SerialMidiManager` traitait : *les mêmes
octets sur le fil se comportaient différemment selon le câble*. Un cas corrigé,
la classe jamais balayée.

Le balayage a été fait ici de façon **systématique** : un banc unique
(`tests/audit/l03-transport-parity.test.js`) injecte **le même flux d'octets**
dans les **quatre** chemins de décodage réels du produit et exige, au bout,
l'événement identique au **même entonnoir** (`DeviceManager.handleMidiMessage`,
d'où partent le routage, l'EventBus `midi_message` et le broadcast WS
`midi_event`).

| Chemin | Code réellement exercé |
|---|---|
| **USB** | événements `easymidi.Input` → `DeviceManager.addInput()` |
| **Série / UART** | `SerialMidiManager._handleData()` (parseur d'octets, running status) |
| **BLE** | `BluetoothManager._handleIncomingMidi()` → `DeviceManager.handleRawMidi()` |
| **RTP-MIDI** | `RtpMidiSession.parseMidiPayload()` → `NetworkManager.handleMidiData()` |

**Résultat : 5 divergences, dont une plus grave que F-08 elle-même.**

> **F-38 — l'USB, transport principal, ignorait *toutes* les System Real-Time et
> *toutes* les System Common.** `addInput()` s'abonnait à 8 événements easymidi
> (les voix de canal + SysEx). easymidi ne fait qu'**émettre** : un événement
> sans écouteur n'est pas « ignoré », il **n'atteint jamais l'application**. Les
> dix messages `clock` (0xF8), `start` (0xFA), `continue` (0xFB), `stop` (0xFC),
> `activesense` (0xFE), `reset` (0xFF), `mtc` (0xF1), `position` (0xF2),
> `select` (0xF3), `tune` (0xF6) mouraient donc à la frontière du pilote —
> pendant que le série, le BLE **et** le RTP les transmettaient tous les trois.
> Un séquenceur USB envoyant MIDI Clock / Start / Song Position était invisible ;
> **le même appareil en DIN, en BLE ou en RTP fonctionnait.** C'est exactement
> F-08, mais sur le transport que tout le monde utilise, et personne ne l'avait
> vu parce que F-08 avait été instruit « côté `handleRawMidi` » sans remonter au
> chemin USB. **Corrigé.**

### 1.2 Ce que le running status vaut réellement

D02 était `PARTIAL / niveau 0` : « correct à la lecture, jamais testé sur un flux
d'octets réel ». Il l'est maintenant, sur flux réel, et il est **correct sur les
neuf points du plan** — y compris le détail que beaucoup d'implémentations
ratent : un System Common **annule** le running status, un System Real-Time
intercalé **ne l'annule pas**. Aucun correctif nécessaire. D02 passe
`PASS / niveau 4`.

### 1.3 Ce qui reste ouvert

| # | Sév | Titre | Propriétaire |
|---|---|---|---|
| F-39 | P3 | Forme du payload SysEx différente selon le transport (`{bytes}` vs tableau nu) | Vague 2 (coordination L02/L09) |
| F-41 | **P2** | RTP-MIDI : **aucun réassemblage** d'un SysEx réparti sur plusieurs paquets → trame tronquée livrée comme complète | **L04** |
| F-43 | **P2** | **Aucun Song Position Pointer nulle part** : un seek renvoie `Start`, donc l'esclave repart à la mesure 1 | L03 + L05 |
| F-44 | P3 | Après un gel de la boucle d'événements, l'horloge rejoue **tous** les ticks manqués en une rafale instantanée | Décision de politique |
| F-45 | **P2** | Le panic n'envoie **jamais** CC 121 : une pédale de sustain verrouillée survit au panic | L01 (schéma) + vague 2 |

### 1.4 Niveaux de validation

| Section | État avant (2026-08-22) | État après | Niveau |
|---|---|---|---|
| D01 — messages MIDI | PASS (après F-08) · 1 | **PASS** (après F-38/F-40/F-42) | **4** |
| D02 — running status | PARTIAL · 0 | **PASS** | **4** |
| D03 — SysEx | PARTIAL | **PARTIAL** (F-41, RTP) | **4** |
| D04 — 16 canaux | PASS | **PASS** | **4** |
| D05 — panic | PARTIAL | **PARTIAL** (F-45) | **4** |
| BK — conformité MIDI 1.0 | PARTIAL | **PARTIAL** (F-41, F-43) | **4** |
| Horloge MIDI (`MidiClockGenerator`) | HW REQUIRED · 0 | **PASS** (dérive) / **PARTIAL** (SPP, rafale) | **4** |

Le niveau 4 signifie : exécuté, avec preuve reproductible et flux d'octets réels,
sans matériel. Le niveau 5 (matériel réel, instrument physique) reste hors de
portée de cet environnement et est renvoyé à L15.

---

## 2. Matrice de conformité MIDI 1.0

`décodé` = le message atteint `handleMidiMessage` avec les bonnes valeurs sur
**au moins un** transport. `testé` = assertion exécutée dans une suite de ce lot.
`≡ transports` = renvoi à la matrice §3.

| Octet de statut | Message | Décodé correctement | Testé | ≡ transports | Remarque |
|---|---|---|---|---|---|
| `0x80` ch 0-15 | Note Off (+ vélocité de relâchement) | ✅ | ✅ 16 canaux | ✅ | |
| `0x90` ch 0-15 | Note On | ✅ | ✅ 16 canaux + bornes 0/127 | ✅ | |
| `0x90` vél. 0 | Note On vél. 0 ≡ Note Off | ✅ | ✅ | ✅ | normalisé une seule fois, dans l'entonnoir |
| `0xA0` | Poly Key Pressure | ✅ | ✅ 16 canaux | ✅ | jamais confondu avec 0xD0 |
| `0xB0` | Control Change | ✅ | ✅ 16 canaux | ✅ | |
| `0xB0` 0/32 | Bank Select MSB/LSB + Program Change | ✅ | ✅ ordre préservé | ✅ | passe-plat, aucun état agrégé |
| `0xB0` 6/38/98/99/100/101 | RPN / NRPN (séquence complète) | ✅ | ✅ | ✅ | passe-plat : **aucun agrégateur RPN dans le produit** |
| `0xB0` n / n+32 | CC 14 bits (MSB/LSB) | ✅ | ✅ | ✅ | passe-plat, les deux moitiés arrivent dans l'ordre |
| `0xB0` ≥ 120 | Channel Mode (120/121/123) | ✅ | ✅ | ✅ | exempté du limiteur de débit ; voir F-45 |
| `0xC0` | Program Change | ✅ | ✅ 16 canaux | ✅ | |
| `0xD0` | Channel Pressure | ✅ | ✅ 16 canaux | ✅ | |
| `0xE0` | Pitch Bend 14 bits (`msb<<7\|lsb`) | ✅ | ✅ 0 / 8192 / 16383 / 1 / 16255 | ✅ | **clés uniformisées** — F-40 corrigé |
| `0xF0…0xF7` | SysEx, trame complète | ✅ | ✅ GM / GS / XG / Identity Request | ⚠️ | forme du payload : F-39 |
| — | SysEx fragmenté sur plusieurs buffers | ✅ série, ✅ BLE, ❌ **RTP** | ✅ | ❌ | **F-41** |
| — | SysEx tronqué (0xF0 sans 0xF7) | ✅ série (abandonné), ✅ BLE (mis en attente) | ✅ | ❌ | RTP l'émet comme complet — F-41 |
| — | Real-Time imbriqué dans un SysEx | ✅ | ✅ | ✅ | légal MIDI 1.0, ne casse pas la trame |
| — | SysEx > 64 Kio | ✅ abandonné, parseur récupère | ✅ | ✅ | `MAX_SYSEX_BUFFER_SIZE` = 65 536 |
| — | SysEx 4 Kio, 228 notifications BLE | ✅ | ✅ | ✅ | réassemblage inter-notifications correct |
| `0xF1` | MTC Quarter Frame | ✅ | ✅ | ✅ | **F-38 corrigé** (USB) |
| `0xF2` | Song Position Pointer (entrée) | ✅ | ✅ | ✅ | **F-38 corrigé** ; **sortie : absente, F-43** |
| `0xF3` | Song Select | ✅ | ✅ | ✅ | **F-38 corrigé** |
| `0xF4` / `0xF5` | System Common indéfinis | ✅ ignorés | ✅ | ✅ | annulent bien le running status |
| `0xF6` | Tune Request | ✅ | ✅ | ✅ | **F-38 corrigé** |
| `0xF7` isolé | EOX hors trame | ✅ ignoré | ✅ | ✅ | |
| `0xF8` | Timing Clock | ✅ | ✅ | ✅ | **F-38 corrigé** |
| `0xF9` / `0xFD` | Real-Time indéfinis | ✅ ignorés | ✅ | ✅ | |
| `0xFA` / `0xFB` / `0xFC` | Start / Continue / Stop | ✅ | ✅ | ✅ | **F-38 corrigé** |
| `0xFE` | Active Sensing | ✅ | ✅ | ✅ | **F-38 corrigé** (`activesense` → `sensing`) |
| `0xFF` | System Reset | ✅ | ✅ | ✅ | **F-38 corrigé** |
| — | Running status (statut implicite) | ✅ | ✅ | ✅ | série + BLE (intra-paquet) + RTP (bit P) |
| — | Running status + Real-Time intercalé | ✅ **conservé** | ✅ | ✅ | y compris entre deux octets de données |
| — | Running status + System Common | ✅ **annulé** | ✅ | ✅ | conforme MIDI 1.0 |
| — | Octet de données orphelin en tête | ✅ ignoré | ✅ | ✅ | |
| — | Message tronqué par la fin du buffer | ✅ mis en attente | ✅ | ✅ | **F-42 corrigé** côté `handleRawMidi` |
| — | Octets de données > 127 | ✅ masqués 7 bits | ✅ | ✅ | **F-42 corrigé** |

### Conformité en **sortie** (encodage) — trous connus

`MidiUtils.convertToMidiBytes()` (utilisé par BLE, série et RTP) ne connaît que
`noteon/noteoff/cc/program/channel aftertouch/poly aftertouch/pitchbend/sysex/
clock/start/continue/stop/reset`. Manquent : **`sensing` (0xFE), `mtc` (0xF1),
`position` (0xF2), `select` (0xF3), `tune` (0xF6)** → `null` → le message est
journalisé « Unsupported » et abandonné.

Conséquence directe **du correctif F-38** : ces messages **entrent** désormais
par l'USB, mais s'ils sont **routés** vers une destination BLE / série / RTP ils
sont abandonnés à l'encodage. Ce n'est pas une régression (avant, ils
n'entraient nulle part depuis l'USB, et depuis le série/BLE/RTP ils étaient déjà
abandonnés à l'encodage), mais c'est le trou de conformité suivant. Diff proposé
en §6.3.

---

## 3. Matrice de parité transports

**Méthode.** Un flux d'octets, quatre chemins, comparaison de l'événement
`(type, payload)` **au même entonnoir**. `≡` = les quatre produisent exactement
le même objet.

Colonne « avant » = comportement à HEAD `8dc170e`, avant les correctifs de ce lot.

| Octets injectés | USB (avant) | USB (après) | Série | BLE | RTP | ≡ ? |
|---|---|---|---|---|---|---|
| `9n nn vv` Note On × 16 ch | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `9n nn 00` Note On vél. 0 | ✅ → `noteoff` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `8n nn vv` Note Off × 16 ch | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `An nn pp` Poly AT × 16 ch | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `Bn cc vv` CC × 16 ch | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `Cn pp` Program × 16 ch | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `Dn pp` Channel AT × 16 ch | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `En ll mm` Pitch Bend | ⚠️ `{value14}` | ✅ `{value, value14}` | ⚠️ `{value}` → ✅ | ⚠️ → ✅ | ⚠️ → ✅ | ✅ **F-40** |
| `F0 … F7` SysEx | ⚠️ `{bytes}` | ⚠️ `{bytes}` | ⚠️ tableau nu | ⚠️ tableau nu | ⚠️ tableau nu | ❌ **F-39** |
| `F1 dd` MTC | ❌ **perdu** | ✅ `{bytes:[dd]}` | ✅ | ✅ | ✅ | ✅ **F-38** |
| `F2 ll mm` Song Position | ❌ **perdu** | ✅ `{bytes:[ll,mm]}` | ✅ | ✅ | ✅ | ✅ **F-38** |
| `F3 ss` Song Select | ❌ **perdu** | ✅ `{bytes:[ss]}` | ✅ | ✅ | ✅ | ✅ **F-38** |
| `F4` / `F5` indéfinis | ✅ ignoré | ✅ | ✅ | ✅ | ✅ | ✅ |
| `F6` Tune Request | ❌ **perdu** | ✅ `{bytes:[]}` | ✅ | ✅ | ✅ | ✅ **F-38** |
| `F7` isolé | ✅ ignoré | ✅ | ✅ | ✅ | ✅ | ✅ |
| `F8` Clock | ❌ **perdu** | ✅ `clock {}` | ✅ | ✅ | ✅ | ✅ **F-38** |
| `F9` / `FD` indéfinis | ✅ ignoré | ✅ | ✅ | ✅ | ✅ | ✅ |
| `FA` Start | ❌ **perdu** | ✅ `start {}` | ✅ | ✅ | ✅ | ✅ **F-38** |
| `FB` Continue | ❌ **perdu** | ✅ `continue {}` | ✅ | ✅ | ✅ | ✅ **F-38** |
| `FC` Stop | ❌ **perdu** | ✅ `stop {}` | ✅ | ✅ | ✅ | ✅ **F-38** |
| `FE` Active Sensing | ❌ **perdu** | ✅ `sensing {}` | ✅ | ✅ | ✅ | ✅ **F-38** |
| `FF` System Reset | ❌ **perdu** | ✅ `reset {}` | ✅ | ✅ | ✅ | ✅ **F-38** |
| Running status (3 messages) | n/a¹ | n/a¹ | ✅ | ✅ | ✅ | ✅ |
| Running status + `F8` intercalé | n/a¹ | n/a¹ | ✅ conservé | ✅ | ✅ | ✅ |
| Running status + `F6` intercalé | n/a¹ | n/a¹ | ✅ annulé | ✅ annulé | ✅ annulé | ✅ |
| SysEx sur 2 fragments | n/a² | n/a² | ✅ réassemblé | ✅ réassemblé | ❌ **tronqué** | ❌ **F-41** |
| Real-Time dans un SysEx | n/a² | n/a² | ✅ | ✅ | ✅³ | ✅ |
| SysEx tronqué par un statut | n/a² | n/a² | ✅ abandonné | ✅ abandonné | — | ✅ |
| RPN complet (6 CC) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| NRPN (4 CC) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| CC 14 bits (MSB+LSB) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Bank Select + Program | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Trame tronquée (`90 3C`) | n/a¹ | n/a¹ | ✅ en attente | ✅ ignorée | ✅ ignorée | ✅ **F-42**⁴ |
| Octet de données > 127 | n/a¹ | n/a¹ | impossible | impossible | ✅ masqué | ✅ **F-42**⁴ |

¹ RtMidi résout le running status et la fragmentation **sous** easymidi ; la
question ne se pose pas à ce niveau. Testé sur les trois transports où le
produit possède le parseur.
² easymidi réassemble les SysEx chunkés par RtMidi lui-même
(`_pendingSysex`) ; hors périmètre du code du projet.
³ Le Real-Time est extrait comme commande séparée par `parseMidiPayload`.
⁴ Mesuré sur `handleRawMidi`, entrée partagée BLE + réseau.

**Bilan : 5 divergences trouvées, 3 corrigées (F-38, F-40, F-42), 2 ouvertes
(F-39 forme du payload, F-41 SysEx RTP).**

---

## 4. Findings

### F-38 — P1 — L'USB ignorait toutes les System Real-Time et System Common — **CORRIGÉ**

**Preuve (rouge avant correctif).** 11 assertions rouges :
`tests/audit/l03-transport-parity.test.js` → `L03/F-38`, dix cas
`« 0xNN … is NOT dropped on USB »` renvoyaient `[]` là où le série, le BLE et le
RTP renvoyaient l'événement, plus
`« addInput subscribes to every easymidi event the other transports honour »`.

**Cause.** `DeviceManager.addInput()` s'abonnait à `noteon, noteoff, cc, program,
pitch, poly aftertouch, channel aftertouch, sysex` — huit noms. Le tableau
`INPUT_EXTENDED_TYPES` d'easymidi
(`node_modules/easymidi/index.js`) en émet **douze** de plus. Un événement sans
écouteur ne déclenche rien : le message n'est pas « ignoré plus loin », il
n'existe jamais. `createVirtualDevice()` dupliquait la même liste incomplète.

**Impact.** Un séquenceur, une boîte à rythmes ou un DAW branché en USB :
MIDI Clock, Start / Stop / Continue, Song Position Pointer, MTC, Active Sensing
et System Reset **tous perdus**. `LightingManager` (règles wildcard sur
`midi_message`) et le moniteur de l'UI ne les voyaient pas non plus. Le même
appareil en DIN, BLE ou RTP fonctionnait — signature exacte de la classe F-08.

**Correctif.** Extraction d'un `DeviceManager._wireInputListeners(input, name)`
partagé par `addInput()` et `createVirtualDevice()`, abonné aux **dix-huit**
événements, avec ré-encodage des payloads System Common d'easymidi vers la
forme `{bytes}` déjà émise par `SerialMidiManager._emitSystemCommon()` et
`handleRawMidi()` :

| easymidi | payload easymidi | type canonique | payload canonique |
|---|---|---|---|
| `clock`/`start`/`continue`/`stop`/`reset` | `{}` | idem | `{}` |
| `activesense` | `{}` | **`sensing`** | `{}` |
| `mtc` | `{type, value}` | `mtc` | `{bytes:[(type<<4)\|value]}` |
| `position` | `{value}` 14 bits | `position` | `{bytes:[lsb, msb]}` |
| `select` | `{song}` | `select` | `{bytes:[song]}` |
| `tune` | `{}` | `tune` | `{bytes:[]}` |

**Vert après.** 61/61 sur la suite de parité. Suite complète : 170 suites /
2 239 tests, aucune régression imputable.

---

### F-39 — P3 — Forme du payload SysEx dépendante du transport — **OUVERT**

L'USB livre `{bytes:[…]}`, le série / BLE / RTP livrent un **tableau nu**.
`handleMidiMessage` s'en accommode en interne
(`Array.isArray(msg) ? msg : msg.bytes`), mais il **retransmet `msg` tel quel**
à `eventBus.emit('midi_message')`, à `midiRouter.routeMessage()` et à
`wsServer.broadcast('midi_event')`. Tout consommateur en aval doit donc gérer
les deux formes ; un seul qui l'oublie perd les SysEx de la moitié des
transports.

**Preuve :** `l03-transport-parity.test.js` →
« F-39 — SysEx payload shape still differs between USB and the rest ».

**Non corrigé volontairement** : la normalisation change la charge utile reçue
par le moteur lighting (lot L02) et par le moniteur du frontend (lot L09), tous
deux en cours d'audit dans la même vague. Diff en §6.1, à appliquer en vague 2.

---

### F-40 — P3 — Pitch bend : clé `value` vs `value14` selon le transport — **CORRIGÉ**

L'USB émettait `{channel, value14}`, le série / BLE / RTP `{channel, value}`.
Les deux nomment le même entier 14 bits, et `MidiUtils.pitchBendRaw14()`
rattrape la différence **au ré-encodage** — mais pas dans l'événement diffusé :
un consommateur qui lit `.value` voyait `undefined` sur l'USB, un consommateur
qui lit `.value14` voyait `undefined` sur les trois autres.

**Correctif** (dans l'entonnoir, purement **additif** — aucune clé retirée) :

```js
if (type === 'pitchbend' && msg && typeof msg === 'object' && !Array.isArray(msg)) {
  const raw = MidiUtils.pitchBendRaw14(msg);
  if (msg.value !== raw || msg.value14 !== raw) {
    msg = { ...msg, value: raw, value14: raw };
  }
}
```

**Preuve :** 5 valeurs (0, 1, 8192, 16255, 16383) × 4 transports, les deux clés
présentes et égales.

---

### F-41 — P2 — RTP-MIDI : aucun réassemblage de SysEx inter-paquets — **OUVERT · lot L04**

`RtpMidiSession.parseMidiPayload()` :

```js
if (status === 0xf0) {
  const sysexStart = i;
  i++;
  while (i < midiEnd && payload[i] !== 0xf7) i++;
  if (i < midiEnd) i++;
  commands.push(Array.from(payload.slice(sysexStart, i)));   // ← émis même sans 0xF7
```

Quand le paquet se termine avant le `0xF7`, la **tête tronquée est émise comme
une trame complète** et la queue, arrivée au paquet suivant, est perdue (ses
octets de données sont vus comme des données sans statut et abandonnés).
Le série (`state.sysExBuffer`) et le BLE (`state.sysex`, état persistant par
adresse) réassemblent tous les deux correctement.

**Impact concret.** La RFC 6295 autorise explicitement le découpage. Un
instrument réseau qui répond à l'Identity Request avec un SysEx dépassant la
section MIDI d'un paquet **n'est jamais identifié** : `parseIdentityReply()`
reçoit une trame amputée. Idem pour tout transfert de descripteur GMB bloc 0x10
via RTP.

**Preuve :** `l03-transport-parity.test.js` → « F-41 — RTP does NOT reassemble a
SysEx split across two packets » : `[F0 43 10]` est livré, la continuation
`[4C F7]` ne produit rien.

`src/transports/**` est le domaine de **L04** : non corrigé ici. Diff proposé en
§6.2.

---

### F-42 — P3 — `handleRawMidi` fabriquait des données que le fil ne portait pas — **CORRIGÉ**

Deux défauts de l'entrée brute partagée par le BLE et le réseau :

1. **Trame tronquée acceptée.** `handleRawMidi('d', [0x90, 60])` émettait
   `noteon {note:60, velocity: undefined}`. `MidiUtils.convertToMidiBytes()`
   ré-encode ensuite `(undefined ?? 127) & 0x7f` = **127** : une trame amputée
   devenait une note à pleine vélocité sur tout transport de ré-encodage. Le
   série la met en attente, le BLE et le RTP sortent de la boucle — les trois
   autres chemins la retiennent.
2. **Octets de données non masqués.** `[0x90, 200, 300]` passait tel quel
   jusqu'à l'EventBus et au clamp de capacités du routeur.

**Correctif** : table `RAW_MESSAGE_LENGTH` (miroir de `SYSTEM_MESSAGE_LENGTH` et
`MIDI_MESSAGE_LENGTHS` du parseur série), rejet des trames trop courtes, masque
7 bits sur les octets de données.

**Preuve :** 2 assertions rouges → vertes (`L03/F-42`). Une troisième assertion
documente la précondition **« exactement un message par appel »**, respectée par
tous les appelants actuels (BLE, RTP, `NetworkManager`) mais nulle part écrite
jusqu'ici.

---

### F-43 — P2 — Aucun Song Position Pointer : un seek renvoie l'esclave à la mesure 1 — **OUVERT**

`MidiClockGenerator` n'émet que quatre choses : `start` (0xFA), `clock` (0xF8),
`stop` (0xFC), `continue` (0xFB). **Il n'existe aucune API de localisation** —
ni `sendSongPosition`, ni `locate`, ni `seek`.

Or `MidiPlayer.seek()` sur une lecture active fait
`stopPlayback()` puis, via `start()`, `startPlayback()` — donc **`FC` puis
`FA`**. MIDI 1.0 définit `0xFA Start` comme « jouer **depuis le début** » :
l'esclave synchronisé sur l'horloge de GMBoop **revient à la mesure 1** chaque
fois que l'opérateur déplace le curseur, au lieu de suivre à la position visée.
La séquence conforme est `FC Stop` → `F2 Song Position Pointer` → `FB Continue`.

**Preuve :** `l03-midi-clock.test.js` → `L03/F-43`, deux tests. Le premier
énumère le vocabulaire complet que l'horloge peut mettre sur le fil
(`{start, clock, stop, continue}`) et vérifie l'absence des quatre points
d'entrée plausibles ; le second reproduit la séquence exacte d'un seek et
constate `['start', 'stop', 'start']`, sans `position`.

Diff proposé en §6.3 (touche aussi `MidiUtils.convertToMidiBytes`, à coordonner
avec L05 pour l'appel côté `MidiPlayer.seek()`).

---

### F-44 — P3 — Après un gel de la boucle d'événements, tous les ticks manqués partent en une rafale — **OUVERT (décision de politique)**

`_scheduleNextTick()` accumule `_expectedTime += _tickIntervalMs` et planifie à
`max(0, _expectedTime - now)`. Si la boucle d'événements a été bloquée, chaque
tick en retard est planifié à **délai 0** jusqu'à rattrapage : les ticks manqués
partent **tous au même instant**, vers **tous** les ports de sortie.

**Preuve mesurée** avec l'horloge injectée : un gel de **5 s** à 120 BPM produit
**240 messages `0xF8` sur le même instant virtuel** (`new Set(timestamps).size
=== 1`). À 240 BPM, 480.

**Ce n'est pas théorique.** Le lot **L07** a mesuré qu'une écriture SQLite
contendue **gèle la boucle d'événements 5 015 ms** — exactement le scénario
ci-dessus. Et `MidiClockGenerator._getDeviceCompensation()` interroge lui-même
la base **16 fois par appareil** (`getInstrumentSettings(dev, 0..15)`) depuis
`_ensureDeviceCache()`, appelé sur le chemin de tick à chaque invalidation de
cache (connexion/déconnexion d'appareil, changement de réglages). L'horloge peut
donc **participer** au gel qui provoque sa propre rafale.

Non corrigé : « rattraper » et « se resynchroniser » sont deux politiques
également défendables (le rattrapage préserve la position musicale de l'esclave,
la resynchronisation préserve le débit). C'est un arbitrage produit, pas un bug
à corriger unilatéralement. Diff en §6.4.

**Ce qui, en revanche, est prouvé correct :** la correction de dérive elle-même.
60 s à 120 BPM = **exactement 2 880 ticks**, chaque tick à moins de **1 µs** de
la grille idéale ; avec une gigue déterministe de 0–3 ms sur *chaque* timer,
toujours 2 880 ticks et **aucun** tick à plus de 3 ms de la grille (un
ordonnanceur naïf type `setInterval` aurait perdu ≈ 4,3 s, soit ≈ 200 ticks).
300 s à 240 BPM = exactement 28 800 ticks.

---

### F-45 — P2 — Le panic ne réinitialise jamais les contrôleurs : un sustain verrouillé y survit — **OUVERT**

`midi_panic` envoie, sur les 16 canaux d'**un** appareil :
**CC 120 (All Sound Off)** puis **CC 123 (All Notes Off)**. Trente-deux messages.
**Jamais CC 121 (Reset All Controllers).**

**Pourquoi c'est un vrai trou.** MIDI 1.0 définit *All Notes Off* comme
**ignoré tant que la pédale de sustain (CC 64) est enfoncée**. Un instrument qui
implémente 123 mais **pas** 120 — cas fréquent des instruments DIY que ce projet
cible, et des firmwares Arduino/microcontrôleur minimalistes — continue donc de
sonner après un panic si un CC 64 ≥ 64 a été reçu. Le panic est alors un
**no-op** exactement dans la situation pour laquelle il existe. La pratique
recommandée est 120 + 123 + **121**.

**Second volet — il n'existe aucun panic global.** `midi_reset` diffuse à toutes
les sorties quand `deviceId` est omis (`targets: 2` mesuré) ; `midi_panic` et
`midi_all_notes_off` exigent un `deviceId` (schéma `requireDeviceId`) et, s'il
manque, adressent littéralement `undefined`. Faire taire **un orchestre** de
plusieurs instruments demande donc N commandes — et le limiteur WS (F-07, lot
L01) plafonne à 60 trames/s.

**Preuve :** `l03-panic-conformance.test.js` → trois tests `F-45`, dont
« the sustain that hangs the notes is never cleared by the panic » : après un
`CC 64 = 127`, la rafale de panic ne contient **ni** un CC 64 à 0, **ni** un
CC 121.

**Ce qui, en revanche, est prouvé correct** (D05, couche appareil) :
- 120 puis 123, dans cet ordre, sur les **16** canaux, valeur 0 — vérifié canal par canal ;
- le panic vide aussi le note-gate du routeur (garde anti-voix fantôme) ;
- **sous charge** : après 500 note-on saturant un limiteur réglé à 10 msg/s
  (> 150 messages effectivement `rate_limited`), **les 32 messages du panic
  passent tous** (`status: 'sent'`) — l'exemption `controller >= 120` du
  limiteur appareil fonctionne, ainsi que celle de `noteoff`, `reset`, `stop`,
  `clock`, `start`, `continue` ; un CC 7 ordinaire est bien, lui, throttlé ;
- un appareil désactivé ne reçoit rien, panic compris (`status: 'disabled'`) ;
- les trois CC s'encodent en octets identiques pour BLE / série / RTP
  (`B0|ch, cc, 00`) et à l'identique via easymidi côté USB ;
- la file d'écriture série traite 120 / 121 / 123 comme prioritaires.

**Écart mineur relevé au passage** (documenté dans la suite, pas un finding) :
`SerialMidiManager._isPrioritySerial()` ne priorise que 120 / 121 / 123, alors
que le limiteur de `DeviceManager` exempte **tout** `controller >= 120`. Les
Channel Mode 122 et 124–127 relèvent donc de deux politiques différentes.
Inoffensif aujourd'hui (rien ne les émet) ; à réconcilier.

---

## 5. Points instruits pour d'autres lots

### 5.1 F-09 — `src/midi/messages/MidiMessage.js` est bien mort → **confirmé à L14**

Ce lot devait vérifier que le module est inatteignable **autrement** que par un
import statique — c'est le seul angle que `dead-modules.mjs` ne couvre pas.
`tests/audit/l03-deadcode-midimessage.test.js` (4 tests, verts) verrouille :

1. **aucun** `import` / `require` — statique **ou dynamique** — ne le nomme, sur
   `src/`, `public/js/`, `tests/`, `scripts/`, `server.js`, `vite.config.js` ;
2. **aucune** occurrence du jeton `MidiMessage` utilisable comme clé de
   recherche par chaîne (les identifiants `handleMidiMessage`,
   `sendMidiMessage`, `validateMidiMessage`, `_onMidiMessage` sont exclus par
   analyse du contexte, pas par liste blanche) ;
3. il est **inatteignable via le `ServiceContainer`** : `Application.js` ne
   contient aucun jeton `MidiMessage` isolé ;
4. le fichier fait bien **467 lignes** (468 avec le saut final) — et il contient
   un **second parseur MIDI complet**, System Common inclus (`status === 0xf1`,
   `0xf2`, `0xf8`).

**Ce dernier point est la leçon.** Ce module donnait au dépôt l'apparence d'un
parseur MIDI complet alors que le parseur réellement exécuté était incomplet :
c'est très exactement ce qui a permis à F-08 — puis à F-38, plus grave — de
passer inaperçus. **Suppression sûre, et souhaitable.** L03 confirme
l'établissement de L14 (0 importeur, inatteignable par les 2 `import()`
dynamiques, unique mention documentaire = une entrée `TODO.md` déjà barrée).

### 5.2 Renvois croisés

- **L01 / F-07** — exemption du panic au niveau WebSocket : le contenu du panic
  est traité ici (F-45) ; le fait qu'une trame `midi_panic` puisse être
  **abandonnée avant analyse** par le limiteur WS reste à L01. Les deux se
  cumulent : un panic incomplet **et** potentiellement jamais reçu.
- **L01 / P0 `eventBus.removeListener`** — vérifié sur le périmètre L03
  (`src/midi/**`, `src/api/commands/MidiCommands.js`) : **aucune occurrence**,
  seul `off()` est utilisé (`MidiClockGenerator.destroy()` compris).
  L'occurrence signalée était dans `src/lighting/LightingManager.js`, déjà
  corrigée par L02 (F-30).
- **L04** — F-41 (SysEx RTP) lui appartient. La suite de parité fournit le test
  rouge prêt à l'emploi ; il suffira d'inverser l'assertion une fois corrigé.
- **L05** — F-43 exige un appel côté `MidiPlayer.seek()`. À coordonner.
- **L07** — le gel de 5 015 ms mesuré est la cause réelle de F-44 ; et
  `MidiClockGenerator._getDeviceCompensation()` fait 16 requêtes SQLite par
  appareil sur le chemin de tick à chaque invalidation de cache.
- **L13** — les resets GM / GM2 / GS / XG et le Master Volume sont **du
  passe-plat** : GMBoop ne les **génère** jamais, il rejoue seulement le dernier
  SysEx global rencontré dans le fichier (`MidiPlayer._emitReconstructedState`).
  Leur transmission intacte est désormais testée sur les quatre transports ;
  la promesse « supporte GS/XG » doit se lire « transmet », pas « émet ».
- **L06** — RPN / NRPN et CC 14 bits sont eux aussi du passe-plat : **aucun
  agrégateur** n'existe dans le produit. Une destination dont
  `supported_ccs` exclut 6 / 38 / 98–101 recevra donc une séquence RPN
  **partielle** (le gate `_enforceLiveLimits` filtre CC par CC). À instruire côté
  routage.

---

## 6. Diffs proposés pour ce qui n'a pas été corrigé

### 6.1 F-39 — normaliser la forme du payload SysEx (vague 2)

`src/midi/devices/DeviceManager.js`, dans `handleMidiMessage` :

```diff
     if (type === 'sysex') {
       const bytes = Array.isArray(msg) ? msg : msg.bytes || [];
+      // Une seule forme en aval, quel que soit le transport qui l'a livrée
+      // (USB → {bytes}, série/BLE/RTP → tableau nu) — audit L03 F-39.
+      msg = { bytes };
```

**À valider avec L02 (règles lighting wildcard sur `midi_message`) et L09
(moniteur du frontend sur `midi_event`) avant application.**

### 6.2 F-41 — réassembler les SysEx RTP inter-paquets (lot L04)

`src/transports/RtpMidiSession.js`, `parseMidiPayload()` :

```diff
       if (status === 0xf0) {
         const sysexStart = i;
         i++;
         while (i < midiEnd && payload[i] !== 0xf7) i++;
-        if (i < midiEnd) i++;
-        commands.push(Array.from(payload.slice(sysexStart, i)));
+        if (i < midiEnd) {
+          i++; // consomme le 0xF7
+          const head = this._rtpSysex || [];
+          this._rtpSysex = null;
+          commands.push([...head, ...Array.from(payload.slice(sysexStart, i))]);
+        } else {
+          // Pas de 0xF7 dans ce paquet : la RFC 6295 autorise la suite au
+          // paquet suivant. Mettre en attente au lieu d'émettre une trame
+          // tronquée comme si elle était complète (audit L03 F-41).
+          this._rtpSysex = [
+            ...(this._rtpSysex || []),
+            ...Array.from(payload.slice(sysexStart, i))
+          ];
+        }
         runningStatus = 0;
         continue;
       }
```

et, en tête de la boucle `while`, juste après la lecture du delta-time :

```diff
       firstCommand = false;
       if (i >= midiEnd) break;
+      // Suite d'un SysEx laissé ouvert par un paquet précédent.
+      if (this._rtpSysex) {
+        const start = i;
+        while (i < midiEnd && payload[i] !== 0xf7) i++;
+        this._rtpSysex.push(...Array.from(payload.slice(start, i)));
+        if (i < midiEnd) {
+          i++;
+          this._rtpSysex.push(0xf7);
+          commands.push(this._rtpSysex);
+          this._rtpSysex = null;
+        }
+        continue;
+      }
       const status = payload[i];
```

> ⚠️ La RFC 6295 §3.2 utilise en réalité `0xF7` comme **marqueur de segment**
> pour les continuations (et `0xF0` en fin de segment pour « la suite arrive »).
> Le diff ci-dessus est la **forme minimale** qui supprime la trame tronquée ;
> L04 doit vérifier l'encodage exact contre la RFC et contre un pair réel
> (rtpMIDI / Apple), et borner `_rtpSysex` comme le font le série (64 Kio) et le
> BLE (`MAX_BLE_SYSEX`). Réinitialiser `this._rtpSysex = null` dans `close()`.

### 6.3 F-43 — Song Position Pointer

`src/midi/playback/MidiClockGenerator.js` :

```diff
+  /**
+   * Song Position Pointer (0xF2) — position en « MIDI beats » (doubles
+   * croches, 6 ticks d'horloge). MIDI 1.0 : un esclave se localise avec
+   * Stop → SPP → Continue ; un Start le renvoie à la mesure 1.
+   * @param {number} positionSeconds
+   */
+  sendSongPosition(positionSeconds) {
+    if (!this._enabled) return;
+    const beats = Math.max(
+      0,
+      Math.min(0x3fff, Math.round(((positionSeconds * this._tempo) / 60) * 4))
+    );
+    this._dispatchToBuckets((deviceId) =>
+      this._sendTransportToDevice(deviceId, 'position', {
+        bytes: [beats & 0x7f, (beats >> 7) & 0x7f]
+      })
+    );
+  }
+
-  _sendTransportToDevice(deviceId, type) {
+  _sendTransportToDevice(deviceId, type, data = {}) {
     try {
-      this.deviceManager.sendMessage(deviceId, type, {});
+      this.deviceManager.sendMessage(deviceId, type, data);
```

`src/utils/MidiUtils.js`, `convertToMidiBytes()` — sans quoi le SPP est
abandonné à l'encodage sur BLE / série / RTP (voir §2, « conformité en sortie ») :

```diff
       case 'reset':
         return [0xff];
+      // System Common. Sans ces cas, `position`/`select`/`mtc`/`tune` —
+      // désormais reçus depuis l'USB comme depuis le série (F-38) — sont
+      // abandonnés dès qu'ils sont routés vers BLE / série / RTP.
+      case 'position':
+        return [0xf2, (data.bytes?.[0] ?? 0) & 0x7f, (data.bytes?.[1] ?? 0) & 0x7f];
+      case 'select':
+        return [0xf3, (data.bytes?.[0] ?? 0) & 0x7f];
+      case 'mtc':
+        return [0xf1, (data.bytes?.[0] ?? 0) & 0x7f];
+      case 'tune':
+        return [0xf6];
+      case 'sensing':
+        return [0xfe];
       default:
         return null;
```

Côté `MidiPlayer.seek()` (**lot L05**), remplacer `stopPlayback()` seul par
`stopPlayback()` + `sendSongPosition(seekPosition)`, et reprendre par
`resumePlayback()` (Continue) plutôt que par `startPlayback()` (Start) quand la
lecture reprend à une position non nulle.

### 6.4 F-44 — se réancrer après un gel plutôt que rejouer la rafale

`src/midi/playback/MidiClockGenerator.js`, `_scheduleNextTick()` :

```diff
   _scheduleNextTick() {
     const now = performance.now();
     this._expectedTime += this._tickIntervalMs;
+    // Au-delà de ~2 ticks de retard, la boucle d'événements a été bloquée
+    // (L07 a mesuré 5 015 ms sur une écriture SQLite contendue). Se réancrer
+    // au lieu de rejouer les ticks manqués à délai 0 : le rattrapage est
+    // inaudible et la rafale sature tous les ports de sortie (audit L03 F-44).
+    if (now - this._expectedTime > this._tickIntervalMs * 2) {
+      this._expectedTime = now + this._tickIntervalMs;
+    }
     const delay = Math.max(0, this._expectedTime - now);
```

Puis inverser l'assertion du test `F-44` (rafale ≤ 2 ticks au lieu de 240).

### 6.5 F-45 — un panic qui fait vraiment taire

`src/api/commands/MidiCommands.js` :

```diff
 const MIDI_CC = {
   ALL_SOUND_OFF: 120,
+  RESET_ALL_CONTROLLERS: 121,
   ALL_NOTES_OFF: 123
 };
@@
 async function midiPanic(app, data) {
-  _ccAllChannels(app, data.deviceId, [MIDI_CC.ALL_SOUND_OFF, MIDI_CC.ALL_NOTES_OFF]);
+  // L'ordre compte : 120 coupe les oscillateurs, 123 relâche les notes tenues,
+  // 121 déverrouille les contrôleurs latchés — la pédale de sustain avant tout.
+  // Sans 121, un instrument qui implémente 123 mais pas 120 continue de sonner :
+  // MIDI 1.0 définit All Notes Off comme IGNORÉ tant que le sustain est
+  // enfoncé, donc le panic est un no-op exactement quand il sert (L03 F-45).
+  const targets = data.deviceId
+    ? [data.deviceId]
+    : app.deviceManager
+        .getDeviceList()
+        .filter((d) => d.output && d.enabled !== false)
+        .map((d) => d.id);
+  for (const deviceId of targets) {
+    _ccAllChannels(app, deviceId, [
+      MIDI_CC.ALL_SOUND_OFF,
+      MIDI_CC.ALL_NOTES_OFF,
+      MIDI_CC.RESET_ALL_CONTROLLERS
+    ]);
+  }
   app.midiRouter?.resetNoteGate?.();
   return { success: true };
 }
```

et, **lot L01**, `src/api/commands/schemas/midi.schemas.js` :

```diff
-export const midi_panic = requireDeviceId;
-export const midi_all_notes_off = requireDeviceId;
+// deviceId optionnel : diffusion à toutes les sorties quand il est absent,
+// comme midi_reset. Faire taire un orchestre ne doit pas coûter N commandes
+// à travers un limiteur WS plafonné à 60 trames/s (L03 F-45 × L01 F-07).
+export const midi_panic = { type: 'object', properties: { deviceId: { type: 'string' } } };
+export const midi_all_notes_off = midi_panic;
```

Réconcilier au passage `SerialMidiManager._isPrioritySerial()` avec le limiteur
de `DeviceManager` : `controller >= 120` des deux côtés.

---

## 7. Preuves — comment tout reproduire

```bash
# Les quatre suites du lot (0,7 s, aucun matériel, aucune base)
node --experimental-vm-modules node_modules/jest/bin/jest.js tests/audit/l03
#   → Test Suites: 4 passed · Tests: 102 passed

# Couverture attribuable à ce lot seul
node --experimental-vm-modules node_modules/jest/bin/jest.js tests/audit/l03 \
  --coverage --coverageReporters=text \
  --collectCoverageFrom='src/midi/playback/MidiClockGenerator.js'
#   → MidiClockGenerator.js : 90,40 % stmt · 71,08 % branch · 92,85 % lines

# Non-régression sur la totalité du backend (mesuré en fin de lot, les autres
# agents ayant continué d'ajouter des suites en parallèle)
node --experimental-vm-modules node_modules/jest/bin/jest.js
#   → Test Suites: 189 passed, 189 total · Tests: 2 501 passed, 2 501 total
#     (aucun échec ; baseline L00 : 150 suites / 1 875 tests)

npx eslint src/midi/devices/DeviceManager.js tests/audit/l03-*.test.js   # 0 erreur, 0 warning
npx prettier --check src/midi/devices/DeviceManager.js tests/audit/l03-*.test.js  # clean
npx tsc --noEmit                                                         # clean
```

### Fichiers créés

| Fichier | Tests | Ce qu'il verrouille |
|---|---|---|
| `tests/audit/l03-transport-parity.test.js` | **61** | La matrice de parité §3 dans son entier : 4 chemins de décodage réels, tout le statut MIDI, running status sur flux d'octets, SysEx, RPN/NRPN/CC 14 bits, robustesse de `handleRawMidi` |
| `tests/audit/l03-midi-clock.test.js` | **23** | `MidiClockGenerator` sous horloge injectée : transport, tempo, dérive 60 s et 300 s, rafale post-gel, compensation par appareil, F-43 |
| `tests/audit/l03-panic-conformance.test.js` | **14** | Contenu exact du panic, panic sous charge contre le limiteur, encodage sur les quatre transports, F-45 |
| `tests/audit/l03-deadcode-midimessage.test.js` | **4** | Preuve d'inatteignabilité de `MidiMessage.js` pour L14 (F-09) |

### Fichier modifié

`src/midi/devices/DeviceManager.js` — trois correctifs, chacun avec son test
rouge → vert :

| Emplacement | Correctif |
|---|---|
| nouveau `_wireInputListeners()`, utilisé par `addInput()` et `createVirtualDevice()` | **F-38** — abonnement aux 18 événements easymidi + ré-encodage des System Common vers `{bytes}` |
| nouvelle table `RAW_MESSAGE_LENGTH` + `handleRawMidi()` | **F-42** — rejet des trames tronquées, masque 7 bits |
| `handleMidiMessage()` | **F-40** — pitch bend publié avec `value` **et** `value14`, toujours égaux |

### Détail du banc de parité

Le chemin USB ne peut pas utiliser le vrai `easymidi` ici (pas d'en-têtes ALSA,
cf. `CLAUDE.md`) : il est piloté par un module mocké dont le parseur est une
**réplique verbatim** de `node_modules/easymidi/index.js`. Un test de garde
(`L03 — harness integrity`) **relit le fichier installé** et échoue si la
réplique dérive de ses tables `INPUT_TYPES` / `INPUT_EXTENDED_TYPES`. La liste
des événements réellement abonnés est extraite du **vrai** `addInput()`, exécuté
sur un vrai `DeviceManager` — ce n'est pas une liste recopiée dans le test.

Les quatre chemins terminent sur un `DeviceManager` réel dont la sortie est
capturée **à la frontière du routeur** (`midiRouter.routeMessage`) — c'est-à-dire
sur l'objet exact que reçoivent aussi l'EventBus `midi_message` et le broadcast
WS `midi_event`. La parité est donc jugée sur ce que le produit consomme
réellement, pas sur un intermédiaire.
