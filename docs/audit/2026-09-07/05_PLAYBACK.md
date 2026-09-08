# 05 — Playback, timing & déterminisme

**Lot L05** · sections `F01`–`F05`, `O`, `BN`, `T3` · **2026-09-07**
**Findings ouverts par ce lot : F-54 → F-63.**
**Base de mesure :** `docs/audit/2026-09-07/00_BASELINE.md` (commit `8dc170e`).
**Audit précédent :** `docs/audit/2026-08-22/05_PLAYBACK_TIMING.md` (PARTIAL, niveau 1).

---

## 1. Synthèse

Deux questions structurantes n'avaient jamais été posées au moteur de lecture.
Elles le sont ici, avec un **harnais de rejeu à horloge injectée** (§3) qui
capture la séquence exacte des octets MIDI émis et permet de comparer deux
exécutions **octet à octet**.

### 1.1 Le moteur est-il déterministe ? — **OUI en temps logique, NON en temps mur**

| Question | Réponse | Preuve |
|---|---|---|
| Même fichier + même config, deux fois de suite ⇒ mêmes octets, mêmes instants ? | ✅ **OUI**, à l'octet près | `l05-determinism.test.js` · 5 rejeux, empreinte unique |
| Idem sur la **même instance** de `MidiPlayer` (caches, compteurs) ? | ✅ **OUI** — aucune fuite d'état entre deux lectures | idem |
| Idem avec contraintes actives (polyphonie, plage, gamme, split round-robin) ? | ✅ **OUI** | idem |
| `Math.random` / `Date.now` influencent-ils la sortie ? | ✅ **NON** (vérifié en les pilotant) | idem |
| Itération de `Map`/`Set`, tri, ordre des promesses ? | ✅ **NON** — `_seq` monotone sur tous les événements, `ORDER BY channel ASC` sur les routages, tri par `(time, priorité, _seq)` | idem + relecture |
| Les décisions **dépendent-elles du temps réel** ? | ❌ **OUI** — `min_note_interval` / `min_note_duration` sont évalués sur `performance.now()`, pas sur la position musicale | F-61 |

**Verdict.** Le séquenceur est **déboguable** : à horloge fixée, il est
reproductible. Ce qui ne l'est pas, ce sont les **gardes de timing physiques**,
évalués en temps mur, donc sensibles à la gigue et — plus grave — à deux
artefacts systématiques du scheduler lui-même (retard d'un tick sur le premier
événement, agrégation `EMIT_AHEAD_MS`). Voir F-61.

### 1.2 Live ≠ baké : le blocker T3 n'est PAS refermé

La roadmap v0.9 coche T3.1→T3.4 et le déclare « 100 % fonctionnel ». **Les
quatre items cochés sont exacts et vérifiés ici** (§5). Mais T3 ne couvrait que
quatre axes ; la table complète (§5.1) en compte **neuf**, et **trois
divergences réelles restent ouvertes** (F-60) — dont deux qui changent
audiblement le résultat.

### 1.3 Défauts trouvés dans le transport et sous charge

Quatre défauts fonctionnels, dont **trois corrigés dans ce lot** :

| # | Défaut | État |
|---|---|---|
| F-54 | Le dernier accord d'un fichier perdait **tous ses Note Off** (course entre le tick de fin et les timers d'émission) | ✅ **CORRIGÉ** |
| F-56 | La **boucle mono-fichier ne rejouait rien** : après le premier passage, silence complet | ✅ **CORRIGÉ** |
| F-57 | `pause` / `resume` perdait jusqu'à **100 ms de timeline** et pouvait produire un Note Off orphelin | ✅ **CORRIGÉ** |
| F-58 | `mute` pendant des notes tenues **fuit** le compteur de voix ⇒ polyphonie saturée à vie + Note Off fantôme | Ouvert |

### 1.4 Chiffres

| Mesure | Avant ce lot | Après |
|---|---|---|
| Couverture `src/midi/playback` (stmt) | 31,33 % | **45,30 %** |
| `MidiPlayer.js` | 40,13 % | **60,28 %** |
| `PlaybackScheduler.js` | 61,66 % | **83,12 %** |
| Tests L05 ajoutés | — | **6 suites / 86 tests** |

```
node --experimental-vm-modules node_modules/jest/bin/jest.js --coverage \
  --collectCoverageFrom='src/midi/playback/**/*.js' \
  --testPathPattern='tests/(playback|midi-player|audit/l05)'
```

### 1.5 Répartition des findings

**0 P0 · 0 P1 · 6 P2 (dont 3 corrigés) · 4 P3.**
Aucun P1 : le moteur ne perd pas de note dans son régime nominal, et les trois
défauts de transport corrigés étaient tous **latents derrière un filet de
sécurité** (All Notes Off) qui masquait le symptôme sur un synthé conforme —
mais pas sur un actionneur mécanique DIY qui ignore le CC 123.

---

## 2. Méthode, périmètre, environnement

### 2.1 Ce qui est mesurable ici, ce qui ne l'est pas

L'audit du 2026-08-22 avait raison sur un point : **le timing réel n'est pas
mesurable dans un conteneur x86**. Ce rapport ne prétend donc rien sur la gigue,
p95/p99, la dérive d'horloge ou la latence d'émission physique — tout cela part
en §8 (liste matériel pour L15).

Ce qui EST mesurable, et qui n'avait jamais été mesuré :
**la logique d'ordonnancement**, à condition de lui retirer le temps réel. C'est
exactement ce que fait le harnais §3.

### 2.2 Environnement

Node v22.22.2, x86_64, pas de Pi, pas de MIDI, pas d'audio.
`better-sqlite3` recompilé par L00 (non utilisé par ce lot : toutes les suites
L05 tournent sur des doubles en mémoire, sans base).

### 2.3 Fichiers produits

| Fichier | Rôle |
|---|---|
| `tests/audit/l05-replay-harness.test.js` | **Le harnais** (bibliothèque + auto-tests) |
| `tests/audit/l05-determinism.test.js` | §BN — déterminisme, sensibilité à la gigue |
| `tests/audit/l05-live-vs-baked.test.js` | §T3 — table des divergences |
| `tests/audit/l05-transport.test.js` | §F02 — seek / pause / stop / boucle |
| `tests/audit/l05-polyphony-load.test.js` | §F04 — charge, éviction, notes orphelines |
| `tests/audit/l05-tempo-compensation.test.js` | §F01 tempo · §O compensation (calcul) |

### 2.4 Correctifs appliqués

| Fichier | Portée |
|---|---|
| `src/midi/playback/MidiPlayer.js` | `_schedulerTick` (F-56), `pause()` + `resume()` (F-57) |
| `src/midi/playback/PlaybackScheduler.js` | `tick()` — condition de fin de fichier (F-54) |

Aucun fichier partagé modifié. `npm run lint` : 0 erreur ·
`npm run typecheck` : clean · `prettier --check` : clean sur les fichiers touchés ·
**220 tests verts** sur `tests/playback* tests/midi-player* tests/audit/l05*`
(dont les 26 suites préexistantes, aucune régression).

---

## 3. LE HARNAIS DE REJEU DÉTERMINISTE *(livrable réutilisable)*

`tests/audit/l05-replay-harness.test.js` — importable depuis n'importe quel test
(`import { replay, serializeTrace } from './l05-replay-harness.test.js'`). Le
fichier porte le suffixe `.test.js` pour rester dans la convention de nommage du
lot ; ses auto-tests ne s'enregistrent que lorsque Jest exécute **ce** fichier
(garde `IS_SELF_RUN` sur `expect.getState().testPath`), donc un import ne les
duplique pas.

### 3.1 Pourquoi il fallait le construire

`MidiPlayer` et `PlaybackScheduler` sont pilotés par **quatre** sources de
temps : `performance.now()` (position, gardes de timing), `setInterval` (tick
10 ms), une cascade de `setTimeout` (un par événement), et `Date.now()`
(horodatage des événements de bus). Un test qui laisse tourner le vrai temps
mesure la machine hôte, pas le moteur. Les 22 suites `playback-*` existantes
contournent le problème en appelant `scheduler.tick()` ou `sendEvent()` à la
main — excellent pour l'unitaire, **aveugle** au comportement d'ensemble
(cascade de timers, courses stop/seek, fin de fichier). Les trois défauts de
transport corrigés ici sont tous dans cet angle mort.

### 3.2 Architecture

```
                  ┌──────────────── VirtualClock ────────────────┐
                  │  now (ms)   file de timers  (at, seq)        │
                  │  setTimeout / setInterval / clear*           │
                  │  advanceTo(t) / advanceToAsync(t)            │
                  └──────────────────────┬──────────────────────┘
   installVirtualClock() détourne :      │
     globalThis.setTimeout/​setInterval   │
     performance.now  (== perf_hooks)    │
     Date.now                            ▼
                       MidiPlayer ─► PlaybackScheduler ─► createTraceRecorder()
                                                              │
                                                              ▼
                                       trace : [{ t, device, status, data1, data2 }]
                                                              │
                                                  serializeTrace / serializeBytes
                                                  analyseNotePairing
```

**Ordre total.** Deux timers dus au même instant virtuel se déclenchent dans
l'ordre d'**insertion** (numéro de séquence monotone). Deux exécutions
identiques produisent donc exactement le même entrelacement — c'est ce qui rend
la comparaison octet à octet possible.

**`performance.now` est bien détournable** : dans Node ≥ 16,
`require('perf_hooks').performance === globalThis.performance` et la propriété
`now` est `writable: true, configurable: true` (vérifié). Les faux timers de
Jest ne suffisent PAS : ils remplacent `globalThis.performance` par un objet
factice, alors que les modules capturent l'export du module `perf_hooks`.

### 3.3 API

| Export | Rôle |
|---|---|
| `VirtualClock(start, lateness?)` | ordonnanceur logique ; `lateness(timer)→ms` modélise la gigue |
| `installVirtualClock(clock)` → `{clock, restore}` | détourne les 4 sources de temps ; **`restore()` obligatoire** |
| `clock.advanceTo/By(ms)` | avance synchrone (timers purs) |
| `clock.advanceToAsync/ByAsync(ms)` | avance **+ vidage des micro-tâches** entre deux timers — indispensable dès qu'un `async` participe au flot (`_handleFileEnd`, avance de file d'attente) |
| `createTraceRecorder(clock, {failDevices})` | double de `DeviceManager` ; enregistre les **octets MIDI bruts** horodatés |
| `buildMidi(spec)` / `buildNoteTrack(notes)` | fabrique de SMF compacts |
| `buildPlayer({buffer, clock, capabilities, delays})` | `MidiPlayer` câblé sur des doubles, fichier chargé |
| `replay(opts)` → `{trace, player, clock}` | rejeu complet d'un fichier de bout en bout |
| `serializeTrace(trace)` / `serializeBytes(trace)` | empreinte canonique **avec** / **sans** horodatage |
| `analyseNotePairing(trace)` | `{orphanOn, orphanOff, maxConcurrent}` — **la mesure « instrument bloqué en scène »** |
| `toRawBytes(type, data)` | encodage des 7 messages de canal en `status/data1/data2` |

### 3.4 Utilisation

```js
import { replay, serializeTrace, analyseNotePairing } from './l05-replay-harness.test.js';

const a = await replay({ buffer, routing: { 0: { device: 'devA', targetChannel: 0 } } });
const b = await replay({ buffer, routing: { 0: { device: 'devA', targetChannel: 0 } } });
expect(serializeTrace(b.trace)).toBe(serializeTrace(a.trace)); // octet à octet
expect(analyseNotePairing(a.trace).orphanOn).toEqual([]);      // aucune note bloquée
```

Pilotage manuel (seek / pause / stop au milieu) :

```js
const clock = new VirtualClock(1000);
const { player, deviceManager } = await buildPlayer({ buffer, clock }); // await AVANT l'install
const inst = installVirtualClock(clock);
try {
  player.start('devA');
  await clock.advanceByAsync(300);
  player.seek(1.5);
  await clock.advanceByAsync(500);
} finally { inst.restore(); }
```

### 3.5 Limites — assumées, pas masquées

1. **Aucun `await` sur un timer réel pendant que l'horloge est installée** :
   il ne se résoudrait jamais. `loadFile()` est donc appelée **avant**
   l'installation.
2. `advanceTo` synchrone ne vide pas les micro-tâches ; utiliser
   `advanceToAsync` dès qu'un `async` est dans la boucle. *(C'est en corrigeant
   ce point que le blocage `_fileEndPending` a été identifié.)*
3. Le modèle de gigue `lateness` applique un retard **par timer**. Node sert les
   timers de même échéance **en un seul lot**, dans l'ordre d'insertion : le
   réordonnancement observé en §4.3 modélise une préemption individuelle, pas le
   comportement libuv nominal. C'est signalé dans le test lui-même.
4. Le harnais mesure **l'intention d'émission**, pas l'émission physique. La
   latence transport/ALSA/USB reste hors de portée (§8).

---

## 4. §BN — Déterminisme

**État : PASS (temps logique) · PARTIAL (temps mur) · niveau 4**

### 4.1 Déterminisme strict — PASS

`tests/audit/l05-determinism.test.js` :

| Test | Résultat |
|---|---|
| 2 rejeux d'un fichier riche (2 pistes, collisions au même tick, bank/PC/CC, pitch-bend, SysEx, 3 tempos) ⇒ traces identiques **avec horodatage** | ✅ |
| 5 rejeux ⇒ empreinte unique (`new Set(prints).size === 1`) | ✅ |
| Timeline (`player.events`) identique entre deux chargements ; `_seq` entier et **unique** sur tous les événements | ✅ |
| Ordre au même tick : `bank MSB → bank LSB → programChange → CC → notes` | ✅ |
| 2 rejeux sur la **même instance** ⇒ identiques, et les injections (CC main, PC par voix) restent idempotentes | ✅ |
| Déterminisme sous contraintes (polyphonie 3, plage 48–84, `min_note_duration`) | ✅ |
| Déterminisme avec split **round-robin** (stratégie à état) | ✅ |
| `Math.random` et `Date.now` pilotés aux extrêmes ⇒ aucune influence | ✅ |
| Aucun timer résiduel après la fin de lecture (`clock.pending === 0`) | ✅ |

**Sources de non-déterminisme cherchées et écartées :**

| Source suspectée | Verdict |
|---|---|
| Itération de `Map` / `Set` | Ordre d'insertion garanti par ES ; `channelRouting` alimentée par `ORDER BY channel ASC` (`RoutingPersistenceDB.js:235`) |
| Tri instable | `compareEvents` = `(time, priorité, _seq)` ; `_seq` monotone posé dans `buildEventList` **et** dans `_appendEventsWithSeq` pour les CC injectés |
| `Date.now()` | Présent 2× (`MidiPlayer.js:1620`, `PlaybackScheduler.js:1006`) mais **uniquement** dans des charges utiles d'événements de bus / WS — jamais dans une décision d'émission |
| `Math.random()` | 1 occurrence (`MidiPlayer.js:2773`) : mélange de la file de lecture. Hors chemin d'un fichier donné. **Non semé** → une file mélangée n'est pas reproductible (assumé) |
| Ordre de résolution des promesses | Le chemin d'émission est entièrement synchrone ; seul `_handleFileEnd` est `async` |
| `setTimeout` concurrents | Ordre déterministe à échéances distinctes ; à échéance égale, ordre d'insertion (voir 4.3) |

### 4.2 Le retard du downbeat — **F-55**

```
1010.000 devA 90 60 100   ← premier événement (temps fichier = 0)
1500.000 devA 90 62 100   ← deuxième (temps fichier = 0,5 s)
```

`start()` ancre `startTime = performance.now()`, puis `startScheduler()` arme un
`setInterval(10 ms)`. **Le premier tick tombe donc à +10 ms**, et tout ce qui se
situe dans `[0, 10 ms[` est émis d'un bloc à cet instant. Le premier intervalle
inter-onset vaut 490 ms au lieu de 500.

Conséquences :
- décalage systématique du premier temps (audible en ensemble, avec un
  instrument non piloté par le moteur) ;
- `getTimingMetrics()` ne compte que **l'avance** (`earlyCount`,
  `maxEarlinessMs`) : ce retard-là est **invisible** de l'observabilité ;
- il suffit à faire franchir le seuil `min_note_interval` (§4.4).

**Correctif recommandé** (non appliqué : touche l'amorçage de la lecture, à
valider sur Pi) : émettre un premier tick synchrone juste après
`startScheduler()`, ou ancrer `startTime = performance.now() + SCHEDULER_TICK_MS`.

### 4.3 Sensibilité à la gigue — modèle

Avec un retard pseudo-aléatoire reproductible de 3 ms par timer, le
**multi-ensemble** d'octets est identique mais **l'ordre change** :

```
idéal   : d3 …  a3 …  80 60  80 64  80 67  83 48      (état avant notes)
gigue   : 80 60  80 64  a3 …  d3 …  83 48  80 67
```

Chaque événement au-delà de la fenêtre `EMIT_AHEAD_MS` part par **son propre**
`setTimeout` : l'ordre « état avant notes » (`EVENT_ORDER_PRIORITY`) est garanti
dans la *timeline*, pas au moment de l'*émission*. En Node nominal les timers de
même échéance sont servis en un lot, dans l'ordre d'insertion, donc le risque ne
se matérialise que sous préemption individuelle. **À re-mesurer sur Pi** (§8) :
c'est précisément là que `eventLoopMonitor` doit servir.

### 4.4 Les gardes de timing sont évalués en temps mur — **F-61**

`PlaybackScheduler._shouldGateNote` compare `performance.now() - lastNoteOnTime`
à `min_note_interval`. Deux artefacts du scheduler faussent cette comparaison :

**(a) le retard du downbeat.** Huit notes espacées de **100 ms exactement** dans
le fichier, garde à **95 ms** : rien ne devrait être coupé.
La 1re note part à +10 ms, la 2e à l'heure ⇒ écart mesuré **90 ms < 95** ⇒ **la
2e note est éliminée**. 7 notes sur 8 sortent, sans aucune raison musicale.

**(b) l'agrégation `EMIT_AHEAD_MS`.** Deux notes espacées de 3 ms dans le
fichier partent dans le même tick, donc au **même `performance.now()`** :
l'écart mesuré vaut 0. Un garde de 2 ms — pourtant *inférieur* à l'écart réel du
fichier — supprime la seconde note.

**Correctif recommandé** : évaluer le garde sur la **position musicale**
(`event.time`) plutôt que sur `performance.now()`, ou ajouter la marge
`EMIT_AHEAD_MS + SCHEDULER_TICK_MS` au seuil. Non appliqué : le garde protège un
actionneur *physique*, le choix de la grandeur de référence (temps musical vs
temps mur) est une décision de conception, pas un bug isolé.

---

## 5. §T3 — Divergences live vs baké

**État : PARTIAL · niveau 4** — *le blocker T3 n'est pas refermé.*

### 5.0 Cadrage indispensable

Un fichier **baké** (`MidiBaker`) ou **adapté** (`applyAssignments` →
`MidiTransposer`) est **rejoué par le même `PlaybackScheduler`**. L'enforcement
runtime (repli de plage, snap de gamme, polyphonie, gardes de timing, filtrage
CC) s'applique donc **dans les deux cas**. La question n'est pas « le baké
court-circuite-t-il le runtime ? » — il ne le fait pas — mais :
**l'étape hors-ligne ajoute-t-elle, retire-t-elle ou déplace-t-elle quelque
chose que le runtime ne ferait pas ?**

### 5.1 LA TABLE DES DIVERGENCES

Protocole : chemin LIVE = fichier **original** + paramètres runtime ; chemin
BAKÉ = fichier **adapté hors-ligne** rejoué **sans** paramètre runtime
(`adaptationBaked`). Comparaison `serializeBytes()`.

| # | Cas | Live (runtime) | Baké (hors-ligne) | Identique ? | Preuve |
|---|---|---|---|---|---|
| 1 | **Transposition de canal** | `_dispatchToDevice` : `note + semis`, écrêté 0–127 | `MidiTransposer.transposeChannels({semitones})`, `clampNote` 0–127 | ✅ **OUI** (octet à octet) | `l05-live-vs-baked` §cas 1 |
| 1b | Transposition **au bord** (>127) | écrête à 127 | écrête à 127 | ✅ **OUI** — mais les deux perdent l'information de la même façon (3 hauteurs → 127) | idem |
| 2 | **Remap de notes** (batterie) | `channelNoteRemapping` **après** transposition | `noteRemapping` **après** transposition | ✅ **OUI** | §cas 2 |
| 2b | Ordre transposition → remap | remap sur la note déjà transposée | idem | ✅ **OUI** | §cas 2 |
| 3 | **Repli de plage** (T3.2) | `clampNote` → `foldIntoRange` | `compressChannel` → `compressNoteToRange` | ✅ **OUI** — vérifié sur **128 notes × 5 fenêtres** | §T3.2 |
| 3b | *Code* du repli | `NoteEnforcement.foldIntoRange` | `MidiTransposer.compressNoteToRange` | ⚠️ **DEUX COPIES** du même algorithme, pas un helper partagé → **F-59** | §T3.2 |
| 4 | **`suppressOutOfRange`** | ❌ **n'existe pas au runtime** — la note est **repliée** | la note est **supprimée** du fichier | ❌ **NON** — `[40,60,96]` → live `[52,60,72]`, baké `[60]` → **F-60** | §cas 4 |
| 5 | **Snap `selected_notes` / gamme** (T3.3) | `clampNote` snappe sur le sous-ensemble **dans la plage** | ❌ **aucun paramètre hors-ligne** (`transposeChannels` ne connaît ni `selectedNotes` ni `octaveMode`) | ⚠️ **converge** (le baké est re-snappé au rejeu) mais l'**aperçu / export** du fichier adapté ne reflète pas ce que l'instrument jouera → **F-60** | §T3.3 |
| 5b | T3.3 : `selected_note` **hors** plage | filtré avant le snap : `clampNote(85, [48..72], sel=[90]) = 61` | — | ✅ **T3.3 CONFIRMÉ FERMÉ** | §T3.3 |
| 6 | **Filtrage CC** (`supported_ccs`) | `_isCCSupported` supprime les CC non déclarés (sauf 120–127, bank, CC de main) | ❌ **inexistant** — `ccMapping` **renumérote**, ne filtre pas | ❌ **NON** — CC 74 reste dans les octets bakés → **F-60** | §cas 6 |
| 7 | **Polyphonie** (T3.1) — choix de la victime | `selectPolyphonyVictim` = médiane | `sorted[floor(len/2)]` = médiane | ✅ **OUI** — même politique keep-outer, helper partagé | §T3.1 |
| 7b | Polyphonie — **effet audible** | la voix médiane **sonne** puis reçoit un Note Off | la voix médiane **n'est jamais émise** | ❌ **NON** — divergence résiduelle **assumée** par T3.1 (« comportement audible modifié »), mais **toujours une divergence** → **F-60** | §T3.1 |
| 8 | **`min_note_interval`** (T3.4) | garde **par canal** si monophonique, **par hauteur** sinon | ❌ **aucune contrepartie hors-ligne** | ⚠️ runtime-seulement, converge au rejeu | §T3.4 |
| 8b | T3.4 : mono vs poly | mono ⇒ 64 filtrée ; poly ⇒ accord préservé | — | ✅ **T3.4 CONFIRMÉ FERMÉ** | §T3.4 |
| 9 | **`min_note_duration`** | Note Off différé, lié à l'instance de note | ❌ inexistant (seul `polyStrategy:'shorten'` raccourcit, logique différente) | ⚠️ runtime-seulement | §F04 |

### 5.2 Re-statut des quatre items T3 de la roadmap

| Item | Affirmation de la roadmap | Verdict de ce lot |
|---|---|---|
| **T3.1** — drop polyphonique runtime = offline | ✅ fermé | ✅ **CONFIRMÉ** sur le choix de la victime · ⚠️ divergence audible résiduelle **assumée mais non refermée** (7b) |
| **T3.2** — repli de plage identique par conception | ✅ fermé | ✅ **CONFIRMÉ** (128 notes × 5 fenêtres) · ⚠️ **par duplication de code**, pas par conception (F-59) |
| **T3.3** — `selected_notes` ne sort plus de `note_range` | ✅ fermé | ✅ **CONFIRMÉ** |
| **T3.4** — `min_note_interval` par mécanisme | ✅ fermé | ✅ **CONFIRMÉ** |

**Conclusion.** Les quatre items sont exacts. Mais T3 a instruit **4 axes sur
9** : `suppressOutOfRange`, le filtrage `supported_ccs` et l'écart audible de
l'éviction polyphonique n'y figurent pas. **T3 ne peut pas être déclaré « 100 %
fonctionnel » en l'état** → F-60.

### 5.3 Croisement avec le lot L06

`docs/audit/2026-09-07/06_ROUTING_ADAPTATION.md` instruit l'**autre** axe de
parité — *entrée live (clavier physique) ↔ lecture de fichier*, c'est-à-dire
`MidiRouter` ↔ `PlaybackScheduler` — et y trouve deux divergences :

- **F-64 (corrigé par L06)** : `MidiRouter._enforceLiveLimits` soumettait les
  CC 20/21 au filtre `supported_ccs` et ignorait la porte cordes, à l'inverse de
  `PlaybackScheduler`. **Recoupe directement notre cas 6** : les deux chemins ne
  filtrent toujours pas les CC de la même façon que la chaîne hors-ligne, qui
  elle ne filtre pas du tout.
- **F-71 (ouvert)** : le route-through live n'injecte pas les program-changes
  par voix, là où `MidiPlayer._injectVoiceProgramChangeEvents` le fait.

L06 mesure aussi `MidiRouter` à **52,1 %** de couverture — le chemin live reste
le moins protégé du système. **Les trois axes de parité sont donc :**

```
   entrée live ──────► MidiRouter ──────┐
                                        ├──► instrument   (parité 1 : L06, F-64/F-71)
   fichier ──────────► PlaybackScheduler┘
        │
        └── adaptation hors-ligne (MidiTransposer / MidiBaker)
                                        └──► parité 2 : L05, F-59/F-60 (ce rapport)
```

**Recommandation commune L05+L06 :** faire converger les trois chemins sur un
**unique module d'enforcement** (`NoteEnforcement` étendu au filtrage CC et à la
suppression hors-plage), consommé par `MidiRouter`, `PlaybackScheduler` **et**
`MidiTransposer`. C'est le seul moyen structurel de fermer T3.

---

## 6. §F01–F05 — Chronologie, transport, charge

### F01 — Chronologie / tempo — **PASS · niveau 4**

`tests/audit/l05-tempo-compensation.test.js` :

| Cas | Résultat |
|---|---|
| Aucun `setTempo` ⇒ 120 BPM (ancre SMF) | ✅ |
| 3 changements de tempo (120 → 240 → 60) : chaque segment converti au bon tempo (0 / 0,5 / 0,75 / 1,75 s) | ✅ |
| `setTempo` à un tick **non nul** : pas de rétro-application (les ticks antérieurs restent à 120 BPM) | ✅ |
| `microsecondsPerBeat = 0` : timeline **finie et positive**, pas de `NaN`/`Infinity` | ✅ |
| Delta-times non ronds (913 / 71 ticks) : aller-retour parse → rejeu reproductible | ✅ |
| **SMPTE** (`framesPerSecond`+`ticksPerFrame`) ⇒ `ValidationError` explicite, **pas** de lecture silencieuse à 480 PPQ | ✅ **rejet propre confirmé** |
| **SMF format 2** ⇒ `ValidationError` explicite | ✅ |
| `playbackRate = 2` ⇒ délais divisés par 2 (490 ms → 240 ms) | ✅ |
| Ordre au même tick : bank → PC → CC → notes | ✅ (§4.1) |

Le trou signalé le 2026-08-22 (« aucun test d'ordre sous simultanéité dans le cas
général ») est **fermé** : le fichier de référence porte 3 notes + bank MSB/LSB +
PC + CC au tick 0, sur 2 pistes.

### F02 — Transport — **PARTIAL → PASS après correctifs · niveau 4**

`tests/audit/l05-transport.test.js` (20 tests) :

| Contrôle | Avant ce lot | Après |
|---|---|---|
| Play / Stop | ✅ | ✅ |
| Stop : annulation de **tous** les timers en vol, position remise à 0, idempotence | non testé | ✅ |
| Stop **pendant** un `advance` (déclenché depuis un callback de timer) | testé (`midi-player-stop-during-advance`) | ✅ étendu |
| Stop pendant un SysEx en vol ⇒ trame **annulée**, jamais tronquée | non testé | ✅ |
| Pause / Resume | ✅ partiel | ✅ **+ correctif F-57** |
| Pause : position **exacte** figée (pas celle du dernier tick) | ❌ | ✅ **corrigé** |
| Seek avant | ✅ | ✅ |
| Seek **arrière** ⇒ CC 123 **et** CC 121 (reset controllers) | ✅ | ✅ |
| Seek au-delà de la fin ⇒ borné à `duration`, fin propre, 0 timer résiduel | non testé | ✅ |
| Seek négatif ⇒ borné à 0 | non testé | ✅ |
| Seek **pendant une pause** ⇒ reste en pause, reprend à la bonne position | ✅ | ✅ |
| Seek : reconstruction d'état (bank MSB/LSB, PC, CC, pitch-bend) | ✅ | ✅ |
| **Boucle mono-fichier** | ❌ **cassée** | ✅ **corrigée (F-56)** |
| Boucle A/B | ❌ inexistante côté backend | ❌ **F-63** |
| Empreinte stable d'un transport complet start→seek→pause→resume→stop | non testé | ✅ |

### F03 — Timing réel — **HW REQUIRED · niveau 0**

Inchangé. Voir §8.

### F04 — Charge polyphonique — **PASS · niveau 4** *(était `NOT TESTED`)*

`tests/audit/l05-polyphony-load.test.js` — **la mesure est le nombre de notes
orphelines** (Note On sans Note Off) :

| Scénario | Notes orphelines | Note Off orphelins |
|---|---|---|
| **16 canaux × 60 notes = 960 notes**, 4 périphériques, > 1 800 messages | **0** | **0** |
| Recouvrement fort (jusqu'à 20 voix demandées), plafond **4** | `maxConcurrent ≤ 4` respecté | **0** |
| Instrument **monophonique** (`polyphony = 1`), 40 notes | `maxConcurrent ≤ 1` | **0** |
| `min_note_interval = 60 ms` sur un flux à 12 ticks d'écart | — | **0** (les Note Off des notes filtrées sont bien avalés) |
| `min_note_duration = 120 ms` sur des notes de 25 ms | toutes les notes tenues **≥ 120 ms** | — |
| Éviction : accord `60/64/67` + `72`, plafond 3 | `67` (médiane) évincée **avant** `on72`, son vrai Note Off avalé exactement une fois | **0** |

**Sous charge nominale, le moteur ne laisse aucune note bloquée.** Les deux
seules façons d'obtenir une note orpheline sont F-54 (corrigé) et F-58
(mute pendant des notes tenues).

### F05 — MIDI Clock — **HW REQUIRED · niveau 0**

`MidiClockGenerator.js` reste à **0 %** dans le périmètre de ce lot. La dérive,
la gigue et le comportement des esclaves exigent du matériel. Signalé à L15.

---

## 7. §O — Compensation de latence (partie calcul)

**État : PASS (calcul) · HW REQUIRED (mesure acoustique) · niveau 4**

### 7.1 `CompensationService` — PASS

| Cas | Résultat |
|---|---|
| Aucune calibration, aucun réglage ⇒ 0 | ✅ |
| `sync_delay` + latence matérielle **s'additionnent** (30 + 12 = 42) | ✅ |
| Latence matérielle **négative** ignorée (`if (hw > 0)`) ; seul `sync_delay` peut être négatif | ✅ |
| Valeurs aberrantes ⇒ écrêtage symétrique à ±`MAX_COMPENSATION_MS` (5 000 ms) | ✅ |
| Erreur de base ⇒ 0, chemin chaud non cassé | ✅ |
| Cache invalidé par `instrument_settings_changed` | ✅ |

### 7.2 Effet réel sur l'émission — PASS

| Cas | Résultat |
|---|---|
| `sync_delay = +40 ms` ⇒ émission **avancée** de 40,000 ms (mesuré) | ✅ |
| `sync_delay = −40 ms` ⇒ émission **retardée** de 40,000 ms | ✅ |
| Deux instruments (0 et 60 ms) sur la même note au même tick ⇒ écart d'émission exactement 60 ms | ✅ |
| Le nombre de messages est inchangé par la compensation | ✅ |

### 7.3 `DelayCalibrator` — PARTIAL (**F-62**)

| Cas | Résultat |
|---|---|
| Médiane (impaire) + confiance sur mesures serrées (20/22/21) ⇒ 21 ms, confiance > 95 % | ✅ |
| **Aberration** `[20,21,22,23,900]` ⇒ médiane **22** (robuste), moyenne **197**, confiance **0 %** | ⚠️ la valeur aberrante **reste** dans `measurements`, `mean` et `stdDev` — **aucun rejet d'aberrant** |
| Aucune détection ⇒ `{success:false, error:'No valid measurements detected'}`, aucune valeur inventée | ✅ |
| **Une seule** mesure valide sur 3 ⇒ `delay = 37`, **`confidence = 100 %`** alors qu'aucune répétabilité n'a été observée | ❌ trompeur |
| Onsets **antérieurs** au `sendTime` rejetés (bruit ambiant) ⇒ pas de latence négative possible | ✅ (relecture `waitForSound`) |
| Garde d'injection ALSA : `hw:1,0; rm -rf /` refusé | ✅ |
| Détection d'attaque : RMS et fenêtre glissante 64 échantillons / saut 16 sur S16_LE | ✅ |

---

## 8. Liste « matériel » pour le lot L15

Tout ce qui suit est **hors de portée d'un conteneur** et doit être exercé sur
un Raspberry Pi avec des instruments réels.

| # | À mesurer | Protocole | Pourquoi le logiciel ne suffit pas |
|---|---|---|---|
| HW-1 | **Gigue et latence d'émission** — moyenne / min / max / p95 / p99 entre l'instant planifié et l'émission physique | Capture externe (moniteur MIDI horodaté matériel, ou analyseur logique sur la ligne UART) pendant `npm run bench` et `tests/performance/load-soak.js` | L'auto-mesure logicielle mesure l'horloge du scheduler, pas la sortie ; elle sous-estime systématiquement |
| HW-2 | **Retard du downbeat (F-55)** en conditions réelles | Fichier au métronome, mesurer l'écart du 1er temps vs un instrument de référence | Le +10 ms mesuré ici est un plancher ; l'ordonnanceur du Pi peut l'aggraver |
| HW-3 | **Réordonnancement sous préemption (§4.3)** | Charger le Pi (lighting + WS + upload) et vérifier l'ordre bank→PC→notes en capture externe | Le modèle de gigue du harnais est volontairement pessimiste |
| HW-4 | **`min_note_interval` / `min_note_duration` réels** (F-61) | Mesurer le taux de notes coupées sur un actionneur mécanique, fichier à écarts exactement au seuil | Le seuil pertinent est physique (course du solénoïde) |
| HW-5 | **Comportement du CC 123** par firmware | Pour chaque instrument DIY : envoyer CC 123 sur une note tenue, vérifier le relâchement | F-54 était masqué par ce filet ; il faut savoir sur quels instruments il n'existe pas |
| HW-6 | **MIDI Clock (F05)** : dérive, gigue, start/stop/continue, SPP, esclaves | Horloge externe de référence + boîte à rythmes/arpégiateur | `MidiClockGenerator` à 0 % de couverture, comportement des esclaves inobservable |
| HW-7 | **Calibration acoustique** (`DelayCalibrator`) | Carte son + micro + instrument mécanique ; 20 mesures par instrument, comparer médiane et écart-type | Toute la chaîne `arecord` → RMS → onset est matérielle |
| HW-8 | **Effet audible de l'éviction polyphonique** (T3.1 / cas 7b) | Même fichier live et baké sur un instrument à polyphonie limitée, écoute comparée | La différence est audible, pas mesurable en octets |
| HW-9 | **Hot-plug pendant la lecture** + politiques `skip`/`pause`/`mute` | Débrancher un USB en cours de morceau | Nécessite un vrai transport (partagé avec L04) |
| HW-10 | **Boucle sous charge** (F-56 corrigé) | Boucler un morceau ≥ 30 min, vérifier l'absence de dérive et de fuite mémoire/timers | Le harnais valide la logique, pas la tenue dans la durée |

---

## 9. Findings F-54 → F-63

| # | Sév. | Titre | Preuve | État |
|---|---|---|---|---|
| **F-54** | **P2** | **Les événements situés exactement à `duration` étaient annulés : le dernier accord perdait tous ses Note Off** | `duration` **est** l'instant du dernier événement. Le `setTimeout` de cet événement expire au même instant virtuel que le tick qui observe `position === duration` ; l'intervalle ayant été armé en premier, il gagnait l'égalité et `stopScheduler()` annulait les envois en attente. Trace : un accord `60/64/67` finissant à 2,000 s produisait **0 Note Off** et 3 notes orphelines, relâchées seulement par le CC 123 de secours — inopérant sur un firmware qui n'implémente pas le CC 123. Touche tout fichier dont le dernier événement tombe sur un multiple de 10 ms, soit la plupart des fins alignées sur le temps à 120/100/60 BPM. | ✅ **CORRIGÉ** — `state.position > state.duration` au lieu de `>=` (`PlaybackScheduler.tick`) |
| **F-55** | **P3** | **Le premier événement du fichier part un tick en retard (+10 ms), et l'observabilité ne le voit pas** | `start()` ancre `startTime` puis arme `setInterval(10 ms)` : le 1er tick est à +10 ms et tout `[0, 10 ms[` sort d'un bloc à cet instant. Mesuré : onsets à 1010 / 1500 pour un fichier demandant 1000 / 1500 → 1er intervalle 490 ms au lieu de 500. `getTimingMetrics()` ne compte que l'avance (`earlyCount`, `maxEarlinessMs`), jamais ce retard. | Ouvert — correctif proposé §4.2 |
| **F-56** | **P2** | **La boucle mono-fichier ne rejouait aucune note** | `tick()` renvoie l'index d'entrée dans sa branche de fin de fichier ; `_schedulerTick` le ré-écrivait **par-dessus** la remise à zéro faite par `seek(0)` → `start()`. Trace : après le 1er passage, uniquement `CC 123 + CC 121` toutes les 710 ms, **silence complet**, indéfiniment. La même écriture écrasait aussi la remise à zéro de `stop()` en fin de morceau (`position` restait à `duration`). | ✅ **CORRIGÉ** — garde de ré-ancrage dans `_schedulerTick` (index / `startTime` / `playing`) |
| **F-57** | **P2** | **`pause` / `resume` perdait jusqu'à 100 ms de timeline (fenêtre de lookahead)** | `pause()` annule les `setTimeout` déjà armés, mais `currentEventIndex` pointe **au-delà** d'eux ; `resume()` ne le rembobinait pas. Trace (notes toutes les 25 ms, pause à 300 ms) : les notes de 325, 350, 375 ms **disparaissaient**, et le Note Off de la note de 400 ms arrivait **sans son Note On**. `pause()` figeait de surcroît la position du **dernier tick**, pas l'instant réel. | ✅ **CORRIGÉ** — position exacte figée dans `pause()`, curseur rembobiné dans `resume()` à `position + EMIT_AHEAD_MS` (rembobinage seul, jamais d'avance ⇒ aucun doublon) |
| **F-58** | **P2** | **`mute` pendant des notes tenues fait fuir le compteur de voix ⇒ polyphonie saturée à vie + Note Off fantôme** | Le test de mute est fait dans `sendEvent`/`_sendEventToRouting`, **avant** `_dispatchToDevice` : les Note Off du canal muté n'atteignent jamais `_shouldGateNote` et ne décrémentent donc pas `_activeNotes`. Après `unmuteChannel`, `_activeNotes.get('dev0:0')` contient encore `60` et `64` ; la note suivante déclenche une éviction et le moteur émet un **Note Off pour une hauteur qui ne sonne plus** (coupée par le CC 123 du mute). Sur un instrument à polyphonie 3, l'instrument reste saturé pour le reste du morceau. | Ouvert — correctif proposé : `PlaybackScheduler.resetNoteTrackingFor(deviceId, channel)` appelé par `MidiPlayer.muteChannel` (un reset global casserait le décompte des autres canaux) |
| **F-59** | **P3** | **Le repli de plage existe en deux copies indépendantes** | `NoteEnforcement.foldIntoRange` (live) et `MidiTransposer.compressNoteToRange` (hors-ligne) sont algorithmiquement identiques — vérifié sur **128 notes × 5 fenêtres** — mais ce sont deux implémentations distinctes, avec chacune leur commentaire expliquant la correction du bug de « réflexion ». T3.2 est vrai **par maintenance parallèle**, pas par construction : la prochaine correction d'un seul côté rouvre la divergence. | Ouvert — fusion recommandée (fichier `src/midi/adaptation/**` : périmètre L06) |
| **F-60** | **P2** | **T3 n'est pas refermé : trois divergences live ≠ baké hors périmètre de la roadmap** | (a) **`suppressOutOfRange`** : l'offline **supprime** la note, le live la **replie** — `[40,60,96]` sur `[48,72]` donne `[52,60,72]` en live et `[60]` en baké. (b) **Filtrage CC** : `supported_ccs` est appliqué **au runtime seulement** ; `ccMapping` hors-ligne renumérote sans filtrer, le CC 74 non supporté reste dans les octets bakés. (c) **Éviction polyphonique** : la voix médiane **sonne puis est coupée** en live, n'est **jamais émise** en baké (écart audible assumé par T3.1 mais non refermé). La roadmap instruit 4 axes sur 9 (table §5.1). | Ouvert |
| **F-61** | **P3** | **Les gardes de timing sont évalués en temps mur, pas en temps musical** | `_shouldGateNote` compare `performance.now() - lastNoteOnTime` à `min_note_interval`. Deux artefacts du scheduler faussent la mesure : (a) le retard d'un tick du downbeat (F-55) ramène un intervalle de 100 ms à 90 ms → avec un garde à 95 ms, **une note sur huit est éliminée sans raison musicale** ; (b) la fenêtre `EMIT_AHEAD_MS` fait partir deux notes espacées de 3 ms au **même** `performance.now()` → un garde de 2 ms, pourtant inférieur à l'écart du fichier, supprime la seconde. Conséquence : le nombre de notes jouées dépend de la gigue. | Ouvert — évaluer le garde sur `event.time`, ou ajouter `EMIT_AHEAD_MS + SCHEDULER_TICK_MS` de marge |
| **F-62** | **P3** | **`DelayCalibrator` : aucun rejet d'aberrant, et confiance à 100 % sur une mesure unique** | `calibrateInstrument` prend la médiane (robuste ✅) mais conserve les aberrations dans `measurements`, `mean` et `stdDev` : `[20,21,22,23,900]` → médiane 22, **moyenne 197**, confiance 0 %. Pire, avec **une seule** mesure valide sur 3 (les deux autres non détectées), `stdDev = 0` ⇒ **`confidence = 100 %`** alors qu'aucune répétabilité n'a été observée. L'opérateur voit « 100 % » sur la mesure la moins fiable possible. | Ouvert — rejet MAD/IQR avant la médiane, et plancher de confiance fonction du nombre de mesures valides |
| **F-63** | **P3** | **La boucle A/B n'existe pas côté backend (la roadmap T2.10 la dit seulement « non câblée en UI »)** | `playback_set_loop` n'accepte qu'un booléen `enabled` (`playback.schemas.js:37`) ; `MidiPlayer` n'a ni `loopStart` ni `loopEnd` ; `_handleFileEnd` ne sait que `seek(0)`. `grep -rn "loopStart\|loop_start" src/` ne renvoie que du SoundFont. T2.10 (« seek/tempo/volume/transpose faits ; le loop A/B reste non câblé ») laisse croire qu'il ne manque qu'un branchement UI : **c'est la fonctionnalité entière qui est absente**. Par ailleurs `loop` est bien remonté par `getStatus()` mais **n'est jamais persisté** : `playbackSetLoop` n'écrit qu'en mémoire, le réglage est perdu au redémarrage. | Ouvert |

**Répartition : 0 P0 · 0 P1 · 6 P2 (dont 3 corrigés) · 4 P3.**

---

## 10. Correctifs appliqués dans ce lot

Trois correctifs, tous **petits, locaux, prouvés par un test rouge → vert**,
strictement dans `src/midi/playback/**`.

### 10.1 F-54 — fin de fichier (`PlaybackScheduler.tick`)

```diff
-    // Check if reached end
-    if (state.position >= state.duration) {
+    // Check if reached end.
+    // STRICTLY greater, not `>=`: `duration` IS the timestamp of the last
+    // event, and that event's `setTimeout` expires at the exact same instant
+    // as the tick that observes `position === duration`. […]
+    if (state.position > state.duration) {
```

La lecture se termine un tick (10 ms) plus tard — sous la résolution du
scheduler — et les timers du dernier instant partent avant l'annulation.

### 10.2 F-56 — écrasement du ré-ancrage (`MidiPlayer._schedulerTick`)

```diff
+    const indexBefore = this.currentEventIndex;
+    const startTimeBefore = this.startTime;
+    const playingBefore = this.playing;
+
     const newIndex = this.scheduler.tick(state, this._getOutputForChannelBound,
                                          this._schedulerCallbacks);
+
+    const reAnchored =
+      this.currentEventIndex !== indexBefore ||
+      this.startTime !== startTimeBefore ||
+      this.playing !== playingBefore;
+    if (reAnchored) return;
 
     this.position = state.position;
     this.currentEventIndex = newIndex;
     this._lastBroadcastPosition = state._lastBroadcastPosition;
```

Un callback déclenché **depuis** `tick()` (`onFileEnd` → boucle `seek(0)` →
`start()`, `onFileEnd` → `stop()`, politique de déconnexion `pause`) ré-ancre la
timeline de façon synchrone ; la synchronisation de sortie ne doit alors pas
écraser ce nouvel état.

### 10.3 F-57 — pause/reprise (`MidiPlayer.pause` / `resume`)

```diff
   this.pauseTime = performance.now();
+  const pauseRate = this.playbackRate > 0 ? this.playbackRate : 1;
+  this.position = Math.min(this.duration,
+                           ((this.pauseTime - this.startTime) * pauseRate) / 1000);
   this.scheduler.stopScheduler();
```

```diff
   this.startTime += pauseDuration;
+  const emittedThrough = this.position + TIMING.EMIT_AHEAD_MS / 1000;
+  let rewound = this.findEventIndexAtTime(emittedThrough);
+  while (rewound < this.events.length && this.events[rewound].time <= emittedThrough) rewound++;
+  if (rewound < this.currentEventIndex) this.currentEventIndex = rewound;
   this.scheduler.startScheduler(…);
```

Tout ce qui a `time <= position + EMIT_AHEAD_MS` est **déjà parti** (fenêtre
tickless) : repartir strictement après cette borne rejoue les événements annulés
**sans en dupliquer aucun**. Preuve : la séquence de notes d'une lecture avec
pause est **exactement** celle d'une lecture continue.

### 10.4 Non-régression

```
npm test -- tests/audit/l05 tests/playback tests/midi-player
→ Test Suites: 26 passed, 26 total · Tests: 220 passed, 220 total
npx eslint src/midi/playback/ tests/audit/l05-*.test.js     → 0 erreur
npx prettier --check <fichiers touchés>                     → clean
npm run typecheck                                           → clean (exit 0)
```

---

## 11. Recommandations priorisées

| Pri | Action | Où |
|---|---|---|
| **P2** | Fermer F-58 : `resetNoteTrackingFor(deviceId, channel)` appelé depuis `muteChannel` | `src/midi/playback/**` (L05) |
| **P2** | Fermer F-60 : porter `suppressOutOfRange` et le filtrage `supported_ccs` dans un module d'enforcement **unique** partagé par `MidiRouter`, `PlaybackScheduler` et `MidiTransposer` | transverse **L05 + L06** |
| **P2** | Rouvrir T3 dans `docs/V0.9_ROADMAP.md` : ajouter T3.5 (`suppressOutOfRange`), T3.6 (filtrage CC), T3.7 (écart audible de l'éviction). **Ne pas tagger v0.9 sur un T3 « 100 % » qui ne couvre que 4 axes sur 9** | roadmap (vague 2) |
| **P3** | Fermer F-55 + F-61 ensemble : premier tick synchrone au démarrage **et** garde de timing évalué en temps musical | `src/midi/playback/**` |
| **P3** | Fusionner `compressNoteToRange` dans `NoteEnforcement.foldIntoRange` (F-59) | `src/midi/adaptation/**` (L06) |
| **P3** | `DelayCalibrator` : rejet d'aberrant + confiance plafonnée par le nombre de mesures valides (F-62) | `src/audio/DelayCalibrator.js` |
| **P3** | Trancher F-63 : implémenter la boucle A/B **ou** retirer la promesse de T2.10 | backend + UI |
| **P3** | Alimenter `/api/health` avec `getTimingMetrics()` **et** une mesure de retard (pas seulement d'avance) | `src/api/` (L12) |
| **P1 (sur Pi)** | Exécuter HW-1 → HW-10 (§8) | L15 |

---

## 12. États normalisés

| Section | État | Niveau |
|---|---|---|
| **BN** — Déterminisme (temps logique) | **PASS** | 4 |
| **BN** — Déterminisme (temps mur / gigue) | **PARTIAL** | 3 |
| **T3** — Divergences live vs baké | **PARTIAL** *(non refermé)* | 4 |
| **F01** — Chronologie, tempo, PPQ, SMPTE | **PASS** | 4 |
| **F02** — Transport (seek/pause/stop/boucle) | **PASS** *(après 3 correctifs)* | 4 |
| **F03** — Timing réel (gigue, p95/p99) | **HW REQUIRED** | 0 |
| **F04** — Charge polyphonique | **PASS** | 4 |
| **F05** — MIDI Clock | **HW REQUIRED** | 0 |
| **O** — Compensation (calcul) | **PASS** | 4 |
| **O** — Compensation (mesure acoustique) | **HW REQUIRED** | 0 |
| Boucle A/B (T2.10) | **FAIL** *(absente du backend)* | 4 |
