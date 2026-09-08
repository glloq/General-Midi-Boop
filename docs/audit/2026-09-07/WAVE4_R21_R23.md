# WAVE4_R21_R23 — Song Position Pointer au seek (F-43 P2, F-44 P3) · Gardes de timing en temps musical (F-55, F-61 P2)

**Base :** vague 4 du `REMEDIATION_ROADMAP.md` — « robustesse de scène » · **Date :** 2026-09-08
**Autorité amont :** `03_MIDI_CORE.md` §F-43, §F-44, §6.3, §6.4 ·
`05_PLAYBACK.md` §4.2 (F-55), §4.4 (F-61), §5 (table T3) ·
`WAVE3_R13_R16.md` §3.2 (classification des axes 8 et 9)
**Périmètre du lot :** `src/midi/playback/**` uniquement.

---

## Résumé

| # | Ce qui était cassé | Ce qui est livré |
|---|---|---|
| **R21 / F-43** | Un seek envoyait `Stop` puis **`Start`**. MIDI 1.0 définit `0xFA Start` comme « jouer **depuis le début** » : tout esclave synchronisé sur l'horloge repartait **mesure 1** pendant que l'opérateur venait de se placer au milieu du morceau. Aucune API de localisation n'existait — ni `sendSongPosition`, ni `locate`, ni `seek`. | La séquence conforme **`FC Stop → F2 Song Position Pointer → FB Continue`**, émise aussi bien pour un seek en lecture que pour un seek **en pause**. Un départ depuis le début, et un retour à la mesure 1 (boucle), restent un `Start` — c'est le message correct pour ce cas. |
| **R21 / F-44** | Après un gel de la boucle d'événements, chaque tick manqué était planifié à délai 0 : **240 messages `0xF8` sur le même instant** après 5 s de gel, vers **tous** les ports. | Au-delà de **2 intervalles** de retard, l'horloge se **ré-ancre** sur l'instant courant. La rafale passe de 240 à **≤ 1**, le ré-ancrage est **compté** (`getSyncMetrics()`) et journalisé. La correction de dérive nominale est intacte (2 880 ticks exacts en 60 s, à moins d'une µs de la grille). |
| **R23 / F-61** | `min_note_interval` et `min_note_duration` étaient évalués sur `performance.now()` — une décision sur le **contenu musical** prise sur l'**horloge murale**. Mesuré : **1 note sur 8 supprimée** sans raison musicale. | `min_note_interval` est évalué sur **`event.time`** (temps logique), divisé par `playbackRate`. `min_note_duration` : **décision musicale, étirement physique**. Taux de notes supprimées **12,5 % → 0 %**, et **identique sous 5 modèles de gigue**. |
| **R23 / F-55** | `start()` ancrait `startTime` puis laissait la première passe d'ordonnancement au `setInterval` : tout `[0, 10 ms[` — le downbeat — partait **un tick en retard**. | `start()` **et** `resume()` exécutent une première passe **synchrone**, après le message de transport d'horloge. Premier onset **1010 → 1000 ms**, premier intervalle inter-onset **490 → 500 ms**. |

**État à l'issue :** **216 suites / 3 027 tests backend** · **91 fichiers /
1 637 tests frontend** · **tout vert** · `eslint src/ public/js/ tests/`
**0 erreur** · `tsc --noEmit` **clean** · `npm run format:check` vert.

> Les totaux incluent le travail des autres lots de la vague, menés en parallèle
> dans le même arbre. La contribution de ce lot : **+2 suites** (`r21`, `r23`),
> **+32 tests neufs**, **+4 tests ajoutés** dans `l03-midi-clock`, et **8 tests
> inversés** répartis sur 4 suites (§5).

---

## 1. R21 — La séquence de seek retenue

### 1.1 La séquence

```
seek() en LECTURE ACTIVE            seek() EN PAUSE
─────────────────────────           ────────────────────────────
  FC   Stop                           (FC Stop déjà émis par pause())
  F2   Song Position Pointer          F2   Song Position Pointer
  FB   Continue                       …
  F8   Clock, F8, F8 …                FB   Continue  ← émis par resume()
                                      F8   Clock, F8, F8 …
```

Et **ce qui ne change pas**, délibérément :

| Situation | Message | Pourquoi |
|---|---|---|
| Lecture depuis le début | `FA Start` | C'est exactement ce que `Start` veut dire. |
| Boucle → `seek(0)` → `start()` | `FC` puis `FA Start` | Retour à la mesure 1 : `Start` est le message juste, pas `SPP(0) + Continue`. |
| `pause()` / `resume()` sans déplacement | `FC` / `FB` | L'esclave conserve sa position ; aucun SPP n'est nécessaire. |

### 1.2 Le point non trivial : la valeur du SPP

Le SPP porte un compte de **« MIDI beats »** — des **doubles croches**, 6 pulsations
d'horloge chacune — sur **14 bits** (deux octets de données 7 bits, LSB d'abord).

Le diff proposé par l'audit (§6.3) calculait
`round(positionSeconds × tempo / 60 × 4)` à partir de `MidiClockGenerator._tempo`.
**Ce calcul est faux sur deux plans**, et le lot ne l'a pas repris :

1. `_tempo` est le tempo **effectif** — `tempo du fichier × playbackRate`. Multiplié
   par une position exprimée en secondes de **fichier**, il compte le taux de
   lecture deux fois. À 2× sur un morceau à 120 BPM, un seek à 00:30 aurait
   annoncé la position 00:60.
2. Il suppose un **tempo constant**. Sur un fichier à carte de tempo (120 BPM
   pendant 2 s puis 240 BPM), la position 3 s vaut 8 noires ; la formule en
   annonce 12 avec le tempo courant.

La conversion passe donc par les **ticks**, c'est-à-dire par le temps musical du
fichier lui-même :

```
beats = (ticksAt(positionSeconds) / ppq) × 4
```

`MidiPlayer._secondsToTicksWithTempoMap()` (nouveau, inverse exact de
`_ticksToSecondsWithTempoMap`) traverse la carte de tempo ; le résultat est exact
quel que soit le nombre de changements de tempo et **indépendant de
`playbackRate`** — ce qui est correct : le SPP compte des doubles croches de la
*partition*, et l'esclave suit par ailleurs nos pulsations `0xF8`, dont la
cadence porte déjà le taux de lecture.

Preuve : `r21-song-position-pointer.test.js` → « le SPP est exact malgré un
changement de tempo en cours de morceau » (32 attendu, 48 avec la formule naïve).

### 1.3 Ce qui a été ajouté

`src/midi/playback/MidiClockGenerator.js`

- `sendSongPosition(midiBeats)` — émet `0xF2` vers tous les esclaves horloge, via
  les mêmes **buckets de compensation par appareil** que les autres messages de
  transport. Valeur bornée à `0x3FFF` et arrondie. Renvoie la valeur réellement
  émise, ou `null` si l'horloge est désactivée.
- `startPlayback(tempo, songPositionBeats = null)` — 2ᵉ paramètre : `null`/0 ⇒
  `Start` (inchangé, rétrocompatible) ; > 0 ⇒ **SPP puis Continue**.
- `getLastSongPosition()` / `getSyncMetrics()` — observabilité.

`src/midi/playback/MidiPlayer.js`

- `_secondsToTicksWithTempoMap()` et `_songPositionBeats()`.
- `start()` passe la position musicale à l'horloge dès que `position > 0`.
- `seek()` émet le SPP **aussi en pause** : l'horloge y a déjà envoyé son `Stop`
  et enverra son `Continue` à la reprise ; sans SPP entre les deux, ce `Continue`
  reprend les esclaves à la position **d'avant** le seek. Ce trou n'était pas
  décrit par l'audit — il a été trouvé en instruisant la branche `wasPaused`,
  déjà traitée à part pour F-43 côté horloge (`stopPlayback()` interdit ici).

### 1.4 La charge utile, et pourquoi elle est doublée

```js
this._sendTransportToDevice(deviceId, 'position', {
  value: beats,                                   // easymidi / USB
  bytes: [beats & 0x7f, (beats >> 7) & 0x7f]      // BLE / série / RTP
});
```

`easymidi` encode `position` depuis `args.value` (14 bits) — le chemin USB
fonctionne **aujourd'hui**, sans rien toucher hors périmètre. Les transports
octet à octet passent, eux, par `MidiUtils.convertToMidiBytes()`, qui **renvoie
`null` pour `'position'`** : le SPP y est donc silencieusement abandonné. Le
correctif est **hors périmètre** (`src/utils/`, `src/core/`) et est donné au §4.

---

## 2. R21 / F-44 — Se réancrer plutôt que rejouer la rafale

`_scheduleNextTick()` accumulait `_expectedTime += _tickIntervalMs` et planifiait
à `max(0, _expectedTime - now)`. Après un blocage, chaque tick en retard partait
à délai 0 jusqu'à rattrapage.

**Politique retenue : se resynchroniser.** L'audit la présentait comme un
arbitrage produit ouvert (« rattraper » préserve la position musicale de
l'esclave, « se resynchroniser » préserve le débit). Trois raisons de trancher
pour la resynchronisation :

1. La position musicale que le rattrapage prétend préserver est **déjà perdue** :
   240 pulsations sur le même instant n'avancent aucun séquenceur de 5 s de
   musique, elles arrivent comme un saut instantané.
2. La rafale part vers **tous** les ports simultanément, y compris BLE et série,
   dont les débits sont les plus contraints du système. C'est le pire moment
   possible pour les saturer : la machine sort d'un gel.
3. Le gel est désormais **borné** (vague 1 : 5 031 ms → 257 ms), donc la dérive
   consentie est bornée elle aussi.

Le seuil est de **2 intervalles de tick** — 41,7 ms à 120 BPM, 20,8 ms à 240 BPM.
C'est un ordre de grandeur au-dessus de la gigue libuv mesurée (0–3 ms) et très
en dessous de tout gel réel. Vérifié dans les deux sens :

| Scénario | Avant | Après |
|---|---|---|
| Gel 5 000 ms @120 BPM | 240 ticks, **tous sur le même instant** | **≤ 1** tick ; aucun instant ne porte plus d'une pulsation |
| Gel 257 ms @120 BPM (borne vague 1) | ~12 ticks empilés | **≤ 1** |
| Gigue 0–3 ms, 60 s @120 BPM | 2 880 ticks | 2 880 ticks, **0 ré-ancrage** |
| Nominal, 60 s @120 BPM | 2 880 ticks, écart max < 1 µs | inchangé |

Le ré-ancrage n'est pas silencieux : `getSyncMetrics()` renvoie
`{ lastSongPosition, resyncCount, skippedTicks, tickIntervalMs }` et chaque
ré-ancrage écrit un `warn` avec la durée du gel et le nombre de ticks
abandonnés.

---

## 3. R23 — Les gardes de timing en temps musical

### 3.1 Le taux de notes supprimées, avant et après

Protocole : harnais de rejeu déterministe L05
(`tests/audit/l05-replay-harness.test.js` — horloge virtuelle injectée sur les
**4** sources de temps, trace d'octets MIDI réels). **Réutilisé, pas réécrit.**

| Scénario | Avant | Après |
|---|---|---|
| **F-61 (a)** — 8 notes espacées de **100 ms exactement**, garde `min_note_interval` = **95 ms** | **7 / 8** émises ⇒ **12,5 % supprimées** | **8 / 8** ⇒ **0 %** |
| Le même, sous **5 modèles de gigue** (0, 1, 3, 7, 12 ms) | le compte dépendait de la gigue | **8, 8, 8, 8, 8** ⇒ **0 / 40 supprimées, 0 %** |
| **F-61 (b)** — 2 notes espacées de **3,1 ms** dans le fichier, garde = **2 ms** (inférieur à l'écart réel) | **1 / 2** ⇒ **50 % supprimées** | **2 / 2** ⇒ **0 %** |
| Contrôle — 12 frappes à **25 ms**, garde 95 ms (le fichier est *vraiment* trop rapide) | 3 gardées | **3 gardées** (inchangé : la suppression est musicalement justifiée) |
| Contrôle — les mêmes 100 ms notés joués à **2×** (50 ms réels), garde 95 ms | — | **4 / 8** : le garde reste **physique** |

Les chiffres « avant » sont ceux des assertions de `l05-determinism.test.js`
telles qu'elles étaient écrites à l'entrée du lot ; elles sont passées au rouge
sur le correctif et ont été **inversées** (§5).

### 3.2 `min_note_interval` — temps logique, corrigé du taux

```js
const elapsed = (logicalMs - this._lastNoteOnTime.get(intervalKey)) / speed;
if (elapsed >= 0 && elapsed < constraints.minNoteInterval) → gate
```

`logicalMs = event.time * 1000` : l'instant de l'événement **sur la partition**,
pas l'instant où le tick a fini par tourner. La division par `playbackRate` est
délibérée et n'est pas un détail : la contrainte modélise la **course d'un
actionneur**, donc deux notes notées à 100 ms d'écart jouées à 2× atteignent
réellement le solénoïde 50 ms après. Un garde « purement musical » aurait laissé
passer les 8 notes et cassé exactement l'organe qu'il protège.

Deux effets de bord corrigés au passage :

- **`has()` au lieu de `|| 0` + `lastTime > 0`.** Avec des instants logiques,
  `0` est une valeur légitime — c'est le tout premier événement du fichier —
  et l'ancien test la lisait comme « aucune note précédente ».
- **Delta négatif.** Un ré-ancrage de la timeline (seek, boucle) sans
  réinitialisation du suivi produisait un écart négatif, donc `< minInterval`,
  donc **tout** aurait été coupé après le saut. Un delta négatif est désormais
  traité comme « pas de contrainte ».

### 3.3 `min_note_duration` — la décision est musicale, l'étirement est physique

C'est la partie où **le temps logique seul aurait été un recul**, et le lot ne
l'a donc pas appliqué tel quel.

- L'**ancienne** règle (`performance.now() - noteOnWall`) plaçait toujours la
  relâche à `instantDeFrappeRéel + min_note_duration`. Sa *sortie* était donc
  déjà stable ; ce qui variait avec la gigue, c'est son *entrée* — la durée
  « tenue » lue comme 0 ms quand la note et sa relâche tombaient dans la même
  fenêtre `EMIT_AHEAD_MS` (5 ms), alors que le fichier dit 3 ms.
- Une règle **purement logique** (`différer de minDur − duréeNotée`) aurait rendu
  la décision reproductible mais **raccourci la tenue physique** de la fenêtre
  d'agrégation : 26,9 ms au lieu de 30 sur une note de 3 ms. Sur un solénoïde,
  10 % de course en moins, c'est précisément la frappe manquée que la contrainte
  existe pour empêcher.

D'où la forme retenue, en deux temps :

```js
// DÉCISION — durée notée, corrigée du taux : reproductible.
const notatedHeld = (logicalOffMs - logicalOnMs) / speed;
if (notatedHeld >= minDur) return 0;

// QUANTITÉ — temps réel déjà engagé : la relâche tombe bien minDur après la frappe.
const wallHeld = performance.now() - this._noteOnWallTimes.get(noteKey);
return Math.max(0, minDur - Math.max(0, wallHeld));
```

Deux ancres sont donc conservées par note (`_noteOnTimes` logique,
`_noteOnWallTimes` murale), vidées ensemble par `resetForPlayback()` et
`resetNoteTracking()`. Ce que ça change concrètement : *savoir si* une note est
étirée ne dépend plus de la charge machine ; *de combien* reste mesuré sur le
monde réel.

### 3.4 F-55 — le downbeat

`start()` ancrait `startTime = performance.now()` puis armait
`setInterval(10 ms)` : la première passe d'ordonnancement tombait à **+10 ms** et
tout `[0, 10 ms[` partait d'un bloc à cet instant.

La passe est désormais exécutée **synchroniquement**, dans `start()` **et** dans
`resume()` (même défaut à la reprise), et **après** le message de transport
d'horloge — sinon les premières notes précéderaient le `Start`/`Continue` sur le
fil, ce qui casserait la synchronisation qu'on vient de réparer avec R21.

| Mesure | Avant | Après |
|---|---|---|
| Premier onset (fichier demandant 0 ms) | 1010 | **1000** |
| Premier intervalle inter-onset (fichier : 500 ms) | 490 | **500** |
| Le même à `playbackRate = 2` (fichier : 250 ms) | 240 | **250** |
| Première note après `resume()` (fichier : 300 ms plus loin) | 310 | **300** |

La ré-entrance était le seul risque : `seek(0) → start()` est appelé **depuis
l'intérieur** d'un tick sur la boucle de fin de fichier, donc la passe synchrone
s'imbrique dans le `tick()` extérieur. Le garde `reAnchored` de `_schedulerTick`
— posé par L05 pour F-56 — couvre exactement ce cas : l'extérieur détecte que
`startTime` a changé et n'écrit pas son index. Les tests de boucle (F-56) sont
verts.

### 3.5 Déterminisme — la preuve

`r23-timing-gates-logical.test.js` reprend le protocole des **cinq rejeux** de
L05, gardes **actives** (`polyphony: 3`, `minNoteInterval: 40`,
`minNoteDuration: 30`) sur un fichier mêlant accords serrés, retriggers de même
hauteur et notes très courtes :

- 5 rejeux ⇒ `serializeTrace` identique — **mêmes octets aux mêmes instants** ;
- 5 modèles de gigue (0 / 1 / 3 / 7 / 12 ms) ⇒ **même nombre de note-ons, même
  nombre de note-offs, même multi-ensemble d'octets**. (Le multi-ensemble, et
  non la chaîne ordonnée : L05 a établi qu'une préemption *par timer* peut
  réordonner deux événements d'un même tick — c'est un fait de l'ordonnanceur,
  pas des gardes.)
- aucune note orpheline : chaque note-on admise reçoit son note-off.

Les gardes de timing ne sont donc plus une source d'indéterminisme audible.

---

## 4. Hors périmètre — diffs fournis, non appliqués

Le lot interdisait `src/midi/devices/**`, `src/transports/**`,
`src/midi/routing/MidiRouter.js`, `src/midi/messages/**`, `src/lighting/**`,
`public/js/**`, et bornait le périmètre exclusif à `src/midi/playback/**`. Deux
correctifs sortent de ce périmètre. **Sans eux, R21 est complet sur USB mais le
SPP n'atteint ni BLE, ni série, ni RTP** — c'est-à-dire précisément les
transports d'un orchestre à plusieurs machines.

### 4.1 `src/utils/MidiUtils.js` — encoder les System Common en sortie

`convertToMidiBytes()` renvoie `null` pour `'position'`, donc BLE / série / RTP
abandonnent le message. C'est le diff §6.3 de `03_MIDI_CORE.md`, inchangé :

```diff
       case 'reset':
         return [0xff];
+      // System Common. Sans ces cas, `position`/`select`/`mtc`/`tune` —
+      // désormais reçus depuis l'USB comme depuis le série (F-38), et émis
+      // depuis l'horloge maîtresse au seek (F-43) — sont abandonnés dès
+      // qu'ils sont routés vers BLE / série / RTP.
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

La charge utile émise par `MidiClockGenerator.sendSongPosition()` porte déjà
`bytes: [lsb, msb]` **en plus** de `value` : le jour où ce diff est appliqué,
rien d'autre n'est à changer.

### 4.2 `src/core/constants.js` — exempter le SPP du limiteur de débit

`PRIORITY_MSG_TYPES` ne contient pas `'position'`. Le SPP traverse donc
`_isRateLimited()` : sur un appareil au plafond pendant un passage dense, **le
seul message qui localise l'esclave peut être jeté**, et le `Continue` qui suit
le fait repartir au mauvais endroit — le bug que R21 corrige, réintroduit par le
limiteur.

```diff
 const PRIORITY_MSG_TYPES = Object.freeze(
-  new Set(['noteoff', 'reset', 'clock', 'start', 'stop', 'continue'])
+  // 'position' (Song Position Pointer) : un seek n'en émet qu'un seul, et le
+  // Continue qui suit est faux s'il manque (audit F-43 / vague 4 R21).
+  new Set(['noteoff', 'reset', 'clock', 'start', 'stop', 'continue', 'position'])
 );
```

### 4.3 Limite connue, non corrigée

`stop()` envoie All Notes Off et `stopScheduler()` annule les timers en vol :
une note dont la relâche a été **différée par `min_note_duration`** au-delà de la
fin du fichier est donc coupée par le All Notes Off au lieu de sa propre
relâche. Le son est correct (la note s'arrête), les octets ne le sont pas
(pas de `0x8n` apparié). C'est un comportement de `stop()`, antérieur à ce lot
et indépendant de la grandeur de référence des gardes ; il est documenté ici
parce qu'un test de ce lot a dû l'éviter explicitement.

---

## 5. Suites d'audit inversées

Quatre suites documentaient les défauts corrigés ici. Elles sont passées au rouge
sur le correctif et ont été **inversées**, en conservant dans le commentaire la
mesure « avant » telle que l'audit l'avait établie.

| Fichier | Test | Avant | Après |
|---|---|---|---|
| `l03-midi-clock.test.js` | `F-44 — after a 5 s stall every missed tick is replayed in one burst` | rafale de 239–242 ticks sur un seul instant | **≤ 2**, `resyncCount === 1`, `skippedTicks ≥ 239`, cadence reprise. Un test **ajouté** vérifie qu'une gigue ordinaire ne déclenche **jamais** de ré-ancrage. |
| `l03-midi-clock.test.js` | `the generator has no SPP API and never emits 0xF2` | 4 points d'entrée absents | `sendSongPosition` existe ; une lecture sans seek n'émet toujours que les 4 messages temps-réel. **3 tests ajoutés** : encodage LSB/MSB, bornage 14 bits, horloge désactivée. |
| `l03-midi-clock.test.js` | `a seek therefore re-sends Start …` | `['start','stop','start']` | `['start','stop','position','continue']` |
| `l05-determinism.test.js` | `le tout premier événement part UN TICK EN RETARD` | `1010` / intervalle `490` | `1000` / intervalle `500` |
| `l05-determinism.test.js` | `min_note_interval est évalué en TEMPS MUR …` | 7 notes sur 8 | **8 sur 8** |
| `l05-determinism.test.js` | `EMIT_AHEAD_MS agrège … un garde de 2 ms coupe la note` | 1 note sur 2 | **2 sur 2**. Le confondant a été retiré : le cas original portait `polyphony: 1`, donc l'éviction polyphonique coupait la note **indépendamment** du garde d'intervalle — le test passait déjà pour la mauvaise raison. |
| `l05-tempo-compensation.test.js` | 2 assertions `490` | `490` | `500`, et `240` → `250` à `playbackRate = 2` |
| `midi-player-seek-pause.test.js` | double d'horloge partiel | — | `sendSongPosition` ajouté au double **et assertion ajoutée** : un seek en pause doit relocaliser les esclaves. |

Nouvelles suites : `tests/audit/r21-song-position-pointer.test.js` (12 tests) et
`tests/audit/r23-timing-gates-logical.test.js` (20 tests).

---

## 6. Table T3 — état mis à jour des axes 8 et 9

`WAVE3_R13_R16.md` §3.2 classait `min_note_interval` (axe 8) et
`min_note_duration` (axe 9) en **« divergence assumée »**, au motif qu'il s'agit
de « gardes temporels, appliqués au moment de l'émission et **dépendants du temps
réel** (position de lecture, `playbackRate`, compensation de latence par
destination) », donc de « propriétés de l'**émission**, pas du **contenu** ».

**Cette justification est désormais partiellement fausse et a été mise à jour**
(`WAVE3_R13_R16.md` §3.2, encadré « Mise à jour vague 4 »). Ce qui a changé :

- les gardes **ne dépendent plus du temps réel**, ni de la gigue, ni de la
  compensation de latence par destination ;
- ce sont donc bien, désormais, des décisions sur le **contenu** — prises de
  manière reproductible à partir de la partition ;
- la convergence live ↔ baké prouvée par R16 (`serializeBytes` identiques) tient
  toujours, mais elle tient maintenant **par construction** et non plus parce que
  les deux rejeux voyaient la même horloge virtuelle.

| # | Axe | État R16 (vague 3) | **État vague 4** | Preuve |
|---|---|---|---|---|
| 8 | `min_note_interval` (T3.4) | ⚠️ **DIVERGENCE ASSUMÉE** — « dépendant du temps réel » | ⚠️ **RUNTIME-SEULEMENT, ASSUMÉ — pour une autre raison** : le garde est désormais **déterministe** et fonction de la seule partition ; il reste hors du fichier parce qu'il dépend de **`playbackRate`** et de **la destination** (`min_note_interval` est une capacité d'instrument). Le graver figerait le fichier sur un taux et un instrument. | `r23` §F-61a (5 gigues, 0 % de suppression) · `r16` §axes 8 et 9 (convergence octet à octet) |
| 8b | T3.4 mono vs poly | ✅ fermé | ✅ **inchangé** | `l05-live-vs-baked` §T3.4 |
| 9 | `min_note_duration` | ⚠️ **DIVERGENCE ASSUMÉE** — « dépendant du temps réel » | ⚠️ **RUNTIME-SEULEMENT, ASSUMÉ — décision déterministe, étirement physique** : *savoir si* une note doit être étirée est désormais fonction de la partition et du taux ; *de combien* reste mesuré sur l'instant réel de la frappe, et ne peut donc par nature pas être gravé. Même dépendance à `playbackRate` et à la destination que l'axe 8. | `r23` §min_note_duration (4 tests) · `r16` §axes 8 et 9 |

**Bilan T3 : 0 divergence ouverte, 3 axes runtime-seulement assumés** (5, 8, 9).
Le nombre ne change pas ; **la raison écrite pour les axes 8 et 9, si**. C'était
« ces gardes dépendent du temps réel » — ce n'est plus vrai. C'est maintenant
« ces gardes dépendent du taux de lecture et de la destination », ce qui est une
raison plus étroite et vérifiable.

> L'avertissement de `WAVE3_R13_R16.md` §3.2 — « tant que R23 n'a pas tranché la
> grandeur de référence, les graver fixerait une décision qu'on sait discutable »
> — est **levé** : la grandeur de référence est tranchée (temps musical pour la
> décision, temps réel pour l'étirement physique). Ce qui reste est un choix de
> produit sur la portabilité du fichier adapté, pas une incertitude technique.

---

## 7. Fichiers touchés

**Source** (périmètre exclusif du lot)

| Fichier | Ce qui change |
|---|---|
| `src/midi/playback/MidiClockGenerator.js` | `sendSongPosition()`, `startPlayback(tempo, beats)`, `getLastSongPosition()`, `getSyncMetrics()`, payload de transport, ré-ancrage post-gel dans `_scheduleNextTick()` |
| `src/midi/playback/MidiPlayer.js` | `_secondsToTicksWithTempoMap()`, `_songPositionBeats()`, SPP au `start()` et au seek en pause, première passe d'ordonnancement synchrone dans `start()` et `resume()` |
| `src/midi/playback/PlaybackScheduler.js` | `_shouldGateNote(…, logicalMs, rate)`, `_noteOffDeferMs(…, logicalMs, rate)`, `_sendNoteOff(…, logicalMs, rate)`, ancre murale `_noteOnWallTimes` |

**Tests**

| Fichier | |
|---|---|
| `tests/audit/r21-song-position-pointer.test.js` | **nouveau** — 12 tests |
| `tests/audit/r23-timing-gates-logical.test.js` | **nouveau** — 20 tests |
| `tests/audit/l03-midi-clock.test.js` | 3 tests inversés, 4 ajoutés |
| `tests/audit/l05-determinism.test.js` | 3 tests inversés |
| `tests/audit/l05-tempo-compensation.test.js` | 2 assertions inversées |
| `tests/midi-player-seek-pause.test.js` | double complété + 1 assertion |

**Documentation**

| Fichier | |
|---|---|
| `docs/audit/2026-09-07/WAVE4_R21_R23.md` | ce compte rendu |
| `docs/audit/2026-09-07/WAVE3_R13_R16.md` | §3.2 et table T3 : classification des axes 8 et 9 mise à jour |
