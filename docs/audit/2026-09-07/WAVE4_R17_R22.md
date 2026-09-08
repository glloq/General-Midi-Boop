# Vague 4 — R17 · R22 · compte rendu

**Findings visés :** **F-28 (P1)** — « un driver lighting synchrone lent bloque
le chemin MIDI » — et **F-31 (P1)** — « la règle `noteon` proposée par défaut
par l'UI laisse une LED allumée pour toujours » (`02_LIGHTING.md` §1, §2 et §8).

**Périmètre réellement touché**

| Fichier | Nature |
|---|---|
| `src/lighting/LightingManager.js` | R17 (file bornée + budget) et R22 (appariement du relâchement, filet de sécurité du balayage) |
| `public/js/features/lighting/LightingForms.js` | R22 — le défaut du `<select>` de déclencheur est **explicite** (1 ligne + commentaire) |
| `tests/lighting/r17-midi-path-budget.test.js` | **nouveau** — banc avant/après, borne, budget, extinction |
| `tests/lighting/r22-default-rule.test.js` | **nouveau** — la règle par défaut de l'UI, la portée de l'appariement, le filet |
| `tests/lighting/l02-fakes.js` | helper `drainOnEmit()` + `hardStop()` vide la file |
| `tests/lighting/midi-path-isolation.test.js` | **4 tests inversés** (§5) |
| `tests/lighting/rule-engine.test.js` | **2 tests inversés + 1 ajouté** (§5) |

**Non touchés :** `src/core/EventBus.js` (hors périmètre — et le correctif n'en
a **pas eu besoin**, cf. §2.1), `src/api/commands/LightingCommands.js`,
`src/persistence/tables/LightingDatabase.js`, `config.json`, `package.json`,
tout `src/midi/**`, `src/transports/**`, le reste de `public/js/**`.
Aucune commande git, aucun `npm install`, aucune clé i18n ajoutée.

---

## 1. R17 — le coût mesuré, avant et après

Même banc que L02 (driver factice qui *busy-wait* N ms **synchroniquement** dans
`setRange()`, coût mesuré sur la durée de `bus.emit(...)`, c'est-à-dire sur ce
que le chemin MIDI paie réellement avant que la note n'atteigne l'instrument).
Le « avant » n'est pas un souvenir : il est **rejoué dans le même processus** en
faisant le travail *à l'intérieur* de la fenêtre de dispatch
(`dispatchCostInline()`), exactement ce que faisait `EventBus.emit()`.

```
$ NODE_OPTIONS=--experimental-vm-modules npx jest tests/lighting/r17-midi-path-budget.test.js --forceExit

[R17 F-28] one 120 ms driver — MIDI dispatch: 122.2 ms inline (pre-R17) → 0.11 ms queued (post-R17)
[R17 F-28] rules × 25 ms driver — 1: 24 ms inline / 0.02 ms queued
                                · 4: 100 ms inline / 0.04 ms queued
                                · 16: 404 ms inline / 0.04 ms queued
[R17 F-28] midi_routed dispatch: 0.08 ms
[R17 F-28] 200 notes × 2 ms driver — total time on the MIDI path: 0.21 ms (would be ~400 ms inline)
[R17 F-28] 20 events × 5 ms driver drained in 12 turns of 17/8/15/10/15/16/12/12/10/21/20/5 ms (budget 8 ms)
[R17] shutdown with 40 queued events on a 50 ms driver: 0.0 ms
```

| Scénario | L02 (avant) | Après R17 |
|---|---|---|
| Driver bloquant 120 ms, 1 règle | **120,1 ms** | **0,11 ms** (× 1 100 moins) |
| 4 règles × driver 25 ms | **100,0 ms** | **0,04 ms** |
| 16 règles × driver 25 ms | 404 ms (mesuré ici) | **0,04 ms** — *plat*, le coût ne se multiplie plus |
| Même chose sur `midi_routed` | **99,9 ms** | **0,08 ms** |
| Rafale de 200 notes, driver 2 ms | ~400 ms | **0,21 ms au total** |
| Driver asynchrone pendu | 0,05 ms (déjà bon) | inchangé |

La propriété qui compte n'est pas seulement « c'est plus rapide » : c'est que
**le coût du driver a disparu de la mesure**. Le dispatch d'un driver bloquant
120 ms est désormais indiscernable de celui d'un driver au repos (0,11 ms contre
0,01 ms, l'écart est du bruit d'allocation), et il ne dépend plus du nombre de
règles.

---

## 2. Le mécanisme retenu, et sa borne

### 2.1 Pourquoi rien n'a été changé dans `EventBus`

La cause racine traverse `src/core/EventBus.js` (`emit()` est une boucle
synchrone, et `midi_message` part **avant** le routage), mais **le bus est le
bon endroit pour être synchrone** : c'est lui qui garantit l'ordre du chemin
temps-réel, et le rendre asynchrone déplacerait le problème sur tous ses autres
abonnés. C'est le côté lumière qui doit s'adapter, et il le peut entièrement :
ses deux écouteurs sont à lui.

**Aucun diff sur `EventBus.js` n'est donc proposé** — le correctif n'en a pas
eu besoin.

### 2.2 Ce que font maintenant les deux écouteurs

`_evaluateRoutedEvent()` / `_evaluateWildcardEvent()` ne font plus **aucun**
appel driver. Ils gardent leurs court-circuits d'origine (système désactivé,
zéro règle, zéro règle joker), prennent un instantané de l'événement
(`_normalizeMidiData` — l'émetteur est libre de réutiliser sa charge utile après
`emit()`) et l'empilent. Tout le reste — appariement des règles, résolution des
couleurs, écritures driver, effets, fades — s'exécute dans `_drain()`, un tour
de boucle plus tard.

```
midi_message ──► _enqueueMidiEvent()  [O(1), aucun driver]  ──► file bornée
                                                                   │
                       setImmediate ──► _drain()  ◄────────────────┘
                                          ├─ _applyRoutedEvent()  ─┐
                                          └─ _applyWildcardEvent() ┴─► _executeAction() ─► driver
```

### 2.3 La borne (F-36 : une file non bornée est une fuite)

| Paramètre | Valeur | Rôle |
|---|---|---|
| `_queueLimit` | **512 événements** | plafond dur de la file |
| `_drainBudgetMs` | **8 ms** | budget mural d'un tour de vidange ; au-delà, `setImmediate` rend la main |
| `_slowEventMs` | **20 ms** | seuil d'avertissement pour **un** événement |
| avertissements | **1 / 5 s max** | un flot ne doit pas noyer le journal |

Trois propriétés, toutes testées :

1. **La profondeur ne dépasse jamais le plafond.** 5 000 événements poussés sans
   qu'aucune vidange ne tourne : profondeur ≤ 512, `dropped = 4 488`.
2. **Le tableau de support ne grandit pas non plus derrière le curseur de
   lecture.** `_compactQueue()` est appelé depuis la vidange *et* depuis le
   chemin de débordement (une rafale peut déborder des milliers de fois dans un
   seul tick, avant qu'une vidange ait pu tourner) : un `slice` toutes les 512
   évictions, soit O(1) amorti. Ce point est une **découverte du test**, pas une
   précaution théorique : la première implémentation gardait 5 000 emplacements.
3. **La politique d'éviction préserve les relâchements.** On évince le plus
   ancien événement qui **n'est pas** un note-off ; jeter un relâchement est
   précisément la manière dont un projecteur reste allumé (c'est R22). Ce n'est
   que si la file ne contient *que* des relâchements que le plus ancien saute —
   et il est alors compté à part (`droppedReleases`) et journalisé autrement.

`getDispatchStats()` expose `{queued, processed, dropped, droppedReleases,
discarded, errors, slowEvents, maxDepth, lastDrainMs, depth, limit, budgetMs}`.

### 2.4 Le budget par tour

`_drain()` traite des événements jusqu'à épuisement de la file **ou** du budget,
puis réarme un `setImmediate`. Un driver qui bloque 5 ms n'empêche donc pas la
boucle d'événements de tourner : 20 événements × 5 ms se répartissent sur une
douzaine de tours au lieu de figer le processus 100 ms d'affilée. Le budget est
vérifié **entre** deux événements : un appel driver synchrone de 120 ms ne peut
pas être préempté (c'est hors de portée logicielle), mais il est désormais payé
**hors** du chemin MIDI, et il est signalé (`slowEvents`, avertissement
« *The lights are late; the MIDI path is not* »).

### 2.5 Le garde-fou : `catch` obligatoire

Avant, un driver qui lançait était rattrapé par `EventBus.emit()`. Hors de
`emit()`, une exception qui s'échappe d'un `setImmediate` est **une exception non
capturée, donc le processus**. `_drain()` attrape donc par événement, compte
(`errors`) et journalise. La sémantique de **F-29** (P2, hors périmètre) est
**volontairement inchangée** : un `throw` interrompt encore les règles restantes
*du même événement*, et le test L02 qui le documente reste vert.

---

## 3. L'extinction à l'arrêt — vérifiée, pas supposée

C'était la contrepartie explicite du passage à l'asynchrone : rendre les
écritures différées ne doit pas ressusciter F-30/F-129 (trois causes distinctes
mises au jour par L02, L01 et L12 pour que `allOff()` soit réellement atteint).

`blackout()`, `allOff()` et `shutdown()` commencent maintenant par
`_discardPendingEvents()` : la file est **vidée**, l'`Immediate` armé est
annulé. L'ordre est donc, à l'arrêt :

```
_removeEventListeners()   → plus rien ne peut entrer dans la file
_discardPendingEvents()   → ce qui restait est jeté (compté : `discarded`)
effectsEngine.shutdown()
allOff()                  → la trame de blackout part
disconnectDevice() × N    → chaque driver attend sa propre purge
                            (les drivers UDP purgent leur socket avant close, F-30b)
```

Quatre tests le verrouillent :

* `shutdown()` avec **100 note-on en attente** : `discarded = 100`, `allOff()`
  appelé une fois, et **la dernière écriture sur le driver est `allOff`** — rien
  ne se réveille aux deux tours de boucle suivants ;
* **un driver lent ne peut pas retenir le blackout en otage** : 40 événements en
  attente sur un driver à 50 ms (2 s de travail) et `shutdown()` rend la main en
  **0,0 ms** — la file est jetée, pas vidangée ;
* `blackout()` ne peut pas être défait un tick plus tard par un note-on déjà
  empilé (c'est le scénario exact que l'asynchronisme aurait pu introduire) ;
* après `shutdown()`, les écouteurs sont détachés : plus rien n'entre dans la
  file.

---

## 4. R22 — la sémantique retenue pour le relâchement

### 4.1 Le choix

Trois options étaient sur la table (« une durée ? un appariement
note-on/note-off ? un défaut différent ? »).

| Option | Retenue ? | Pourquoi |
|---|---|---|
| **Appariement note-on / note-off** | **oui** | C'est la sémantique que l'utilisateur croit déjà avoir : `off_action` (Instant / Fondu / Maintenir) existe **dans le formulaire**, il était simplement inatteignable. Corrige aussi **toutes les règles déjà en base**, sans migration. |
| Durée maximale d'allumage | non | Une durée arbitraire coupe une note tenue au milieu d'un accord tenu ; elle transforme un bug déterministe en comportement surprenant. Le vrai besoin — « ne jamais rester allumé si le suivi est perdu » — est traité par le filet du §4.3, qui est déclenché par une **cause** (suivi perdu), pas par un chronomètre. |
| Changer le défaut de l'UI en `any` | non (seul) | Ne corrige ni les règles existantes, ni F-31b (`any` + plancher de vélocité laisse encore la LED allumée). Le défaut est quand même rendu **explicite** (§4.4). |

**Règle retenue : une règle qui a allumé une note possède son relâchement.**

Concrètement, dans `_ruleMatches(rule, midi)` :

1. si `_matchesCondition()` accepte, rien ne change (aucune régression possible) ;
2. sinon, l'événement est apparié comme relâchement **si et seulement si** :
   * c'est un relâchement (`noteoff`, ou `noteon` vélocité 0),
   * le déclencheur de la règle peut allumer sur une attaque
     (`noteon`, `any`, ou absent — une règle `cc` ou `noteoff` n'est **jamais**
     concernée),
   * la note est **effectivement tenue sur l'appareil de cette règle**
     (`activeNotes`),
   * et le reste de la condition — *où* la règle s'applique : canal, plage de
     notes, CC — tient toujours. Seuls `trigger` et la fenêtre de vélocité,
     qui décrivent *comment la note a été frappée*, sont neutralisés.

### 4.2 Ce que ça corrige, mesuré

* **F-31** — `trigger:'noteon'` (le défaut de l'UI) : allume **et éteint**.
* **F-31b** — `any` + `velocity_min: 64` : le relâchement (vélocité 0) n'est plus
  rejeté par le plancher. Et une note *douce*, écartée à l'attaque par le
  plancher, n'allume rien **et** son relâchement reste inerte (aucune écriture).
* **F-31c** — un relâchement **sans** attaque correspondante (serveur redémarré
  touche enfoncée) continue de ne rien faire. C'est **délibéré** et testé :
  éteindre sur un relâchement que le moteur n'a jamais apparié écraserait une
  scène ou une commande de groupe. Le cas « suivi perdu » est couvert par §4.3.
* La règle `cc` d'un même appareil **n'est pas** entraînée dans le chemin
  note-off ; une règle `noteoff` garde son comportement mot pour mot.

### 4.3 Le filet : le balayage des notes fantômes éteint ce qu'il oublie

`_startHealthCheck()` vide `activeNotes` au-delà de 16 notes tenues par
appareil. Il **oubliait le suivi en laissant le projecteur allumé** — le chemin
note-off est indexé sur `activeNotes`, donc plus personne ne pouvait l'éteindre.
C'est la même famille de défaut que F-31, sur une autre cause. Le balayage
éteint désormais l'appareil (et arrête ses effets) au moment où il en perd le
suivi, dans un `try/catch` — un callback de timer qui lance, c'est le processus.

### 4.4 Le défaut de l'UI

`LightingForms.js` construisait le `<select>` de déclencheur sans qu'aucune
option ne porte `selected` pour une règle neuve : le navigateur prenait la
première. Le défaut est maintenant **énoncé** :

```diff
-<option value="noteon" ${cond.trigger === 'noteon' ? 'selected' : ''}>
+<option value="noteon" ${cond.trigger === 'noteon' || !cond.trigger ? 'selected' : ''}>
```

Il reste `noteon` — c'est l'intention la plus lisible pour qui découvre la
fonctionnalité — mais c'est désormais un défaut **sain** : le test
`r22-default-rule.test.js` construit le `condition_config` et l'`action_config`
**exactement** tels que `submitRule()` les poste pour une règle neuve, joue une
note, la relâche, et vérifie que le projecteur s'éteint. Un autre test relit
`LightingForms.js` et échoue si le défaut redevient implicite ou si deux options
se déclarent défaut. Aucune chaîne visible n'a été ajoutée (donc aucune clé i18n,
donc pas de parité de locales à rétablir).

---

## 5. Tests inversés (défauts documentés, maintenant corrigés)

Six tests **passaient parce qu'ils décrivaient le défaut**. Ils sont inversés,
au même endroit, avec la mention explicite du changement de signe :

| Suite | Test | Avant | Après |
|---|---|---|---|
| `midi-path-isolation` | « a driver that spends 120 ms … delays MIDI output by ~120 ms » | `blocked >= 100` | **`< 5 ms`**, et les écritures ont bien lieu au tour suivant |
| `midi-path-isolation` | « cost is multiplied by the number of matching rules » | `t >= 80` | **plat**, 4 écritures hors chemin |
| `midi-path-isolation` | « midi_routed … blocks too » | `ms >= 80` | **`< 5 ms`** |
| `midi-path-isolation` | « the throw is contained by EventBus.emit » | log `midi_message handler` | contenu par `_drain()` ; **plus rien** n'atteint `emit()` |
| `rule-engine` | « trigger:noteon … lights the LED and never clears it » | 1 écriture, LED figée | **2 écritures**, la seconde à `brightness: 0` |
| `rule-engine` | « F-31b: a velocity floor … re-creates the stuck light » | 1 écriture | **2 écritures** |

Les tests qui documentent des défauts **encore ouverts et hors périmètre**
restent verts et inchangés : **F-29** (un driver fautif annule les règles
suivantes du même événement), **F-32** (la règle joker se déclenche deux fois),
**F-33** (la priorité n'a pas de sémantique inter-seaux), **F-31c**.

Les suites qui vérifient la *sémantique* (et non la latence) appellent
`drainOnEmit(bus, manager)` une fois dans leur `build()` : `bus.emit(...)` y
garde son coût de production, et la file est vidangée juste après, si bien que
chaque `emit` continue de se lire « la lumière a réagi ».

---

## 6. État à l'issue

```
$ npm test
Test Suites: 2 failed, 213 passed, 215 total
Tests:       2 failed, 3005 passed, 3007 total

$ npx vitest run
Test Files  90 passed (90)      Tests  1634 passed (1634)
(les totaux montent au fil de la session : trois autres lots livrent en parallèle
dans le même arbre)

$ npx eslint src/ public/js/ tests/     → 0 erreur (204 warnings, tous préexistants)
$ npx tsc --noEmit                      → clean
```

**Aucune suite rouge n'est de ce lot.** `tests/audit/l11-offline-first.test.js`
et `tests/audit/r6-offline-first.test.js` comptent les balises `<script>` de
`public/index.html` (193 attendues, 194 présentes) : la 194ᵉ est
`public/js/features/transport/PlaybackResync.js`, créée pendant cette session par
le lot voisin (R20 / F-94). `tests/r23-timing-gates-logical.test.js` est le lot
R23, en cours d'écriture au moment de ce relevé. Ni `public/index.html`, ni
`src/midi/**`, ni ces suites ne sont dans mon périmètre, et aucun n'a été
touché ici. Les 12 suites correspondant à `tests/lighting` sont vertes : **233 tests**
(201 avant — dont 6 inversés et 1 ajouté sur place — plus 17 tests R17 et
14 tests R22).

---

## 7. Reproduction

```bash
# le banc avant/après, la borne, le budget, l'extinction
NODE_OPTIONS=--experimental-vm-modules npx jest tests/lighting/r17-midi-path-budget.test.js --forceExit

# la règle par défaut de l'UI et la portée de l'appariement
NODE_OPTIONS=--experimental-vm-modules npx jest tests/lighting/r22-default-rule.test.js --forceExit

# toute la surface lumière
NODE_OPTIONS=--experimental-vm-modules npx jest tests/lighting --forceExit --testTimeout=20000
```

`--forceExit` reste nécessaire tant que `LightingEffectsEngine.tapTempo()`
laisse un `setTimeout(3500)` non annulé (recommandation P3 de `02_LIGHTING.md`
§8, hors périmètre).

---

## 8. Ce qui reste ouvert autour de ces deux findings

* **F-36** est *borné*, pas *résolu* : il n'y a toujours pas de cap d'émission à
  44 Hz par univers dans `BaseLightingDriver`. La file empêche la fuite mémoire
  et sort le coût du chemin MIDI ; elle n'empêche pas un datagramme par message.
* **F-32** double toujours le travail des règles joker — désormais payé hors
  chemin MIDI, ce qui en fait un problème de charge et non plus de latence.
* **F-29** (quarantaine par appareil) reste P2 et hors périmètre : le `catch` du
  §2.5 est **par événement**, pas par règle, et la sémantique existante a été
  préservée à dessein.
* **AC-HW** (`15_HARDWARE_QA_CHECKLIST.md`) devient mesurable : l'offset
  MIDI ↔ lumière n'est plus dominé par un blocage synchrone. Il vaut maintenant
  au minimum un tour de boucle d'événements, et au plus un budget de vidange par
  tranche de 8 ms de travail lumière en attente.
