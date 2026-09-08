# 02 — Lighting (lot L02)

**Date :** 2026-09-07 · **Base :** `00_BASELINE.md` (commit `8dc170e`, v0.8.1)
**Périmètre :** §AB01–AB07, §AC (partiel), finding **F-13 (P1)**
**Environnement :** Linux x86_64, Node v22.22.2 — **aucun matériel** : pas de Pi,
pas de GPIO, pas de bus DMX, pas de contrôleur WLED, pas de broker MQTT.
Tous les tests tournent contre des **serveurs bouchons locaux** (`dgram`, `http`)
et des **doubles en mémoire**.

**Périmètre retenu :** audit **+ construction de la suite de tests manquante**
+ correctifs P1 locaux et prouvés (`src/lighting/**`).

---

## 0. Synthèse

| § | Sujet | État | Niveau | Finding |
|---|---|---|---|---|
| **Risque n°1** | Un driver lent bloque-t-il le chemin MIDI ? | **FAIL** | 5 | **F-28 (P1)** |
| — | Isolation d'une règle en échec | **FAIL** | 5 | **F-29 (P2)** |
| — | Retour à un état sûr (`Application.stop()`) | **FAIL → CORRIGÉ** | 5 | **F-30 (P1)** · L01 **F-27** |
| AB01 | Moteur de règles — sémantique note/vél./CC/plage | **PARTIAL** | 5 | **F-31 (P1)** |
| AB01 | Moteur de règles — double évaluation `*` | **FAIL** | 5 | **F-32 (P2)** |
| AB01 | Moteur de règles — priorités / conflits | **FAIL** | 5 | **F-33 (P2)** |
| AB01 | Coût d'évaluation borné (1 / 10 / 100 règles) | **PASS** | 4 | — |
| AB01 | MIDI-learn | **FAIL → CORRIGÉ par L01** | 5 | L01 **F-18** |
| AB02 | `GpioLedDriver` / `GpioStripDriver` (logique) | **PASS** | 4 | — |
| AB02 | `GpioLedDriver` / `GpioStripDriver` (matériel) | **HW REQUIRED** | 0 | → L15 |
| AB02 | `SerialLedDriver` | **PARTIAL** | 3 | → L15 (adaptateur réel) |
| AB03 | `ArtNetDriver` (UDP) | **PASS** | 5 | F-35, F-36 |
| AB04 | `SacnDriver` (E1.31) | **PASS** | 5 | F-35, F-36 |
| AB05 | `OscLightDriver` (UDP) | **PASS** | 5 | F-35, F-36 |
| AB06 | `HttpLightDriver` (WLED / Hue / générique) | **PASS** | 5 | F-36 |
| AB07 | `MqttLightDriver` | **FAIL — capacité morte** | 5 | **F-34a (P2)** |
| — | Profils de fixtures DMX (`mapColorToFixture`) | **FAIL — capacité morte** | 5 | **F-34b (P2)** |
| — | `LightingEffectsEngine` (8 effets animés) | **PASS** | 5 | — |
| — | Contrat `BaseLightingDriver` | **PASS** | 5 | — |
| — | Cap de débit réseau | **FAIL** | 5 | **F-36 (P2)** |
| — | Détection de présence du luminaire | **FAIL** | 5 | **F-35 (P2)** |
| — | Surface de commandes `lighting_*` (38) | **PARTIAL** | 5 | **F-37 (P2)** |
| — | `LightingDatabase.js` | **NOT TESTED** | 0 | voir §7 |
| AC | Synchronisation MIDI ↔ lumière (mesure d'offset) | **HW REQUIRED** | 0 | → L15 |

**Couverture `src/lighting/**` + `LightingCommands.js` : 2,35 % → 83,82 %.**

**Findings :** 1 P1 corrigé (F-30), 3 P1 ouverts (F-28, F-31, + F-30 partiellement
résiduel côté conception), 6 P2 ouverts. Aucun P0.

---

## 1. La question n°1 : un driver lent ou pendu peut-il bloquer le chemin MIDI ?

### Réponse : **OUI pour un driver synchrone lent. NON pour un driver asynchrone pendu.**

Le moteur de règles est branché sur `EventBus` — dont `emit()` est une **boucle
synchrone** (`src/core/EventBus.js:107`) — via deux abonnements
(`LightingManager.js:207-210`) :

* `midi_message` est émis par `DeviceManager.js:1409` **AVANT**
  `midiRouter.routeMessage(...)` : tout ce que fait le lighting sur cet
  événement **retarde la sortie MIDI elle-même** ;
* `midi_routed` est émis par `MidiRouter.js:405` **à l'intérieur de la boucle
  d'envoi par destination** : un fan-out vers N instruments paie le coût N fois.

Et `_executeAction()` appelle `driver.setRange()` / `driver.setColor()` **en
direct**, sans budget de temps, sans file, sans `setImmediate`.

### Mesure

```
$ NODE_OPTIONS=--experimental-vm-modules npx jest tests/lighting/midi-path-isolation.test.js
[L02 F-28] MIDI dispatch latency — slow driver: 120.1 ms · same driver idle: 0.2 ms
[L02 F-28] 4 matching rules × 25 ms driver = 100.0 ms
[L02 F-28] midi_routed dispatch with slow driver: 99.9 ms
[L02] hung (async) driver dispatch: 0.05 ms
Tests: 10 passed, 10 total
```

| Scénario | Latence ajoutée au dispatch MIDI | Verdict |
|---|---|---|
| Driver sain | **0,2 ms** | acceptable |
| Driver synchrone bloquant 120 ms | **120,1 ms** (× 600) | **le MIDI est bloqué** |
| 4 règles × driver bloquant 25 ms | **100,0 ms** (le coût est **multiplié par le nombre de règles**) | **le MIDI est bloqué** |
| Même chose sur `midi_routed` | **99,9 ms** | **le MIDI est bloqué** |
| Driver **asynchrone** pendu (promesse qui ne se résout jamais) | **0,05 ms** | isolé, OK |
| Driver qui `throw` | pas de crash (`EventBus.emit` attrape) | OK, **mais** voir F-29 |
| Driver marqué déconnecté | 0 appel, sortie immédiate | OK |
| Périphérique retiré en cours de rafale | pas d'erreur | OK |
| `lighting_set_enabled(false)` / 0 règle | court-circuit avant tout appel driver | OK |

### Ce que cela veut dire concrètement

Aucun driver livré n'est *aujourd'hui* bloquant de 120 ms — mais rien dans
l'architecture ne l'empêche, et deux d'entre eux en sont proches par
construction :

* `GpioStripDriver._renderNow()` appelle `ws281x.render()` **de façon synchrone**.
  Sur un WS2812, une trame de 300 LEDs dure ~9 ms de signal ; le binding natif
  bloque le thread pendant ce temps.
* `SerialLedDriver._write()` appelle `port.write()` : si le buffer noyau du
  port série est plein (adaptateur lent, 115 200 bauds, rafale d'accords),
  l'écriture peut bloquer.
* Tout driver tiers ajouté demain via `DRIVER_MAP` hérite du même contrat.

**→ F-28 (P1).** Le sous-système lumière n'a **aucune barrière** entre lui et le
chemin temps-réel. Recommandation §8.

---

## 2. Findings

### F-28 (P1) — Le moteur de règles est évalué sur la pile de dispatch MIDI, sans budget

**État : CONFIRMÉ OUVERT.** Preuve : §1 ci-dessus.
Coût = (nb de règles correspondantes) × (coût du driver), payé **avant** que la
note n'atteigne l'instrument. Aucun timeout, aucune file, aucun découplage.

`tests/lighting/midi-path-isolation.test.js`

---

### F-29 (P2) — Un driver en défaut annule silencieusement toutes les règles suivantes du même événement

`_evaluateRoutedEvent` / `_evaluateWildcardEvent` bouclent sur les règles **sans
try/catch par règle**. Le `throw` remonte jusqu'au `try/catch` par-listener de
`EventBus.emit` : le processus survit (bien), mais **la boucle est abandonnée**.

```
✓ F-29: one faulty device silently cancels every LATER rule of the same event
```

Deux appareils, deux règles, le premier driver jette :
`bad.setRange` appelé 1 fois, **`good.setRange` appelé 0 fois** — un projecteur
parfaitement sain reste figé parce qu'un *autre* est tombé.

**État : CONFIRMÉ OUVERT.** `tests/lighting/midi-path-isolation.test.js`

---

### F-30 (P1) — Aucun chemin de code n'éteignait réellement les projecteurs à l'arrêt — **CORRIGÉ**

Deux défauts indépendants sur la même chaîne, tous deux corrigés dans ce lot.

#### (a) `LightingManager.shutdown()` levait une exception sur sa première instruction

`EventBus` (`src/core/EventBus.js`) expose `off()` / `removeAllListeners()`,
**pas** `removeListener()` :

```
$ node -e "import('./src/core/EventBus.js').then(m=>{const b=new m.default();
  console.log(typeof b.removeListener, Object.getOwnPropertyNames(Object.getPrototypeOf(b)).join(','))})"
undefined constructor,on,off,once,emit,removeAllListeners,listenerCount,eventNames
```

`LightingManager._removeEventListeners()` appelait `this.eventBus.removeListener(...)`
(lignes 215 et 218). `shutdown()` levait donc `TypeError: … is not a function`
**avant** `allOff()`, avant `effectsEngine.shutdown()`, avant les
`disconnectDevice()`. Et `Application.stop()` isole chaque étape
(`Application.js:635-641`) : le tout se réduisait à **une ligne de log**,
`Stop step "lightingManager" failed (continuing)`, pendant que **la salle
restait allumée**.

Sortie du test **avant** correctif :

```
✓ shutdown() rejects with "removeListener is not a function"
✓ the fixtures are STILL LIT after shutdown(): allOff() is never reached
✓ the health-check interval and the MIDI listeners survive the failed shutdown
✓ Application.stop()'s isolating step() turns the failure into a single log line
```

Effets de bord additionnels mesurés : l'intervalle de health-check (10 s) restait
armé, et les deux écouteurs `midi_message` / `midi_routed` restaient attachés —
un manager « arrêté » continuait de piloter le matériel.

**Correctif appliqué** — `src/lighting/LightingManager.js` :

```diff
   _removeEventListeners() {
+    // EventBus expose `off()`, PAS `removeListener()` (audit L02 F-30).
     if (this._onMidiRouted) {
-      this.eventBus.removeListener('midi_routed', this._onMidiRouted);
+      this.eventBus.off('midi_routed', this._onMidiRouted);
+      this._onMidiRouted = null;
     }
     if (this._onMidiMessage) {
-      this.eventBus.removeListener('midi_message', this._onMidiMessage);
+      this.eventBus.off('midi_message', this._onMidiMessage);
+      this._onMidiMessage = null;
     }
   }
```

#### (b) La trame de blackout des drivers UDP n'était **jamais** émise

`ArtNetDriver`, `SacnDriver` et `OscLightDriver` faisaient, dans `_doDisconnect()` :
`socket.send(trame_noire)` puis **`socket.close()` dans le même tick**.
`dgram.send()` est asynchrone : la trame est jetée.

Reproduction isolée, hors du projet :

```
$ node scratchpad/L02/repro-close-race.mjs
send()+close() with no callback: 20/20 blackout packets never left the host
send(cb) then close():           0/20 dropped
```

**20 sur 20**, déterministe. Les trois tests `F-30b: disconnect() blacks …`
échouaient de la même manière (« only 1/2 UDP packets after 2000 ms »).
Le `HttpLightDriver` avait la variante HTTP : `_doDisconnect()` appelait
`allOff()` sans l'attendre — un `fetch` en vol au moment où le processus sort.

**Correctif appliqué** — `BaseLightingDriver` reçoit un `_drainSocket()`, utilisé
par les trois drivers UDP avant `close()` ; `HttpLightDriver.allOff()` renvoie
désormais sa promesse et `_doDisconnect()` l'attend :

```diff
+  _drainSocket() {
+    return new Promise((resolve) => setImmediate(resolve));
+  }
```
```diff
   async _doDisconnect() {
     if (this.dmxData) {
       this.dmxData.fill(0);
       this._sendDmxPacket();
+      await this._drainSocket();   // sinon la trame noire est jetée
     }
     if (this.socket) { this.socket.close(); this.socket = null; }
   }
```

**Après correctif :** les 9 suites passent, dont

```
✓ every fixture is switched off and disconnected
✓ the health-check timer and both MIDI listeners are released
✓ Application.stop()'s isolating step() logs nothing for lighting
✓ shutdown() is idempotent
✓ F-30b: disconnect() blacks the universe out, closes the socket and emits disconnected   (Art-Net)
✓ F-30b: disconnect() blacks out, closes and reports disconnected                          (sACN)
✓ F-30b: disconnect() turns everything off, closes the socket, and later writes are inert   (OSC)
✓ disconnect() only resolves after the off request reached the controller                  (HTTP/WLED)
✓ hue disconnect turns every light off before resolving
```

#### (c) 4e site de la même classe : une fuite d'écouteur **silencieuse**

L01 (F-27) a signalé qu'il restait des appels `eventBus.removeListener` hors de
son périmètre. Inventaire complet à l'issue de ce lot :

```
$ grep -rn "removeListener" src/
src/lighting/LightingManager.js:215                 → commentaire du correctif L02
src/lighting/instrument/InstrumentLightManager.js:259 → 4e site           ← traité ici
src/transports/NetworkManager.js:745,749            → sockets Node, correct
src/api/commands/LightingCommands.js:822            → commentaire du correctif L01
src/core/Application.js:832                         → `process`, correct
```

Le 4e site, `InstrumentLightManager.shutdown()`, s'écrivait
`this.eventBus?.removeListener?.(...)` — **appel optionnel**. Il ne levait donc
rien : il **ne faisait rien**, sans erreur ni journal. L'écouteur
`instrument_settings_changed` posé par `initialize()` n'était **jamais**
détaché. Sur `Application.restart()` (exposé par les commandes de maintenance),
chaque cycle en accumulait un de plus, jusqu'à l'avertissement de fuite
d'`EventBus` (seuil 50).

Sortie **avant** correctif :

```
✓ the listener is attached at construction
✕ shutdown() releases it
✕ a restart cycle does not accumulate listeners
```

**Correctif appliqué** — `src/lighting/instrument/InstrumentLightManager.js` :

```diff
-    this.eventBus?.removeListener?.('instrument_settings_changed', this._onReload);
+    this.eventBus?.off?.('instrument_settings_changed', this._onReload);
```

Après : 60 cycles construire/arrêter laissent **0 écouteur** et **aucun**
avertissement de fuite.

#### Arbitrage du test `test.failing` de L12

L12 avait écrit un test affirmant que `shutdown()` n'atteint jamais `allOff()`,
et ce test **passait** — d'où le doute. L'explication est dans la construction
du sujet : leur double était bâti par `Object.create(LightingManager.prototype)`
avec un `eventBus` fourni à la main. Le défaut ne se manifeste **que** si cet
`eventBus` est le **vrai** `EventBus` du projet (celui qui n'a pas
`removeListener`). Ma preuve utilise un `LightingManager` réel branché sur un
`EventBus` réel — et L12 a depuis constaté le même échec **sur serveur vivant**,
journalisé le 2026-09-07 à 11:07 :

```
ERROR Stop step "lightingManager" failed (continuing):
      this.eventBus.removeListener is not a function
```

**Verdict : le défaut était réel en production.** L12 a converti son
`test.failing` en test de non-régression qui verrouille le correctif L02 ;
`tests/audit/l12-resilience.test.js` passe au vert avec la présente correction.

**Résidu de conception (non corrigé, P2).** `Application.stop()` appelle
`lightingManager.shutdown()` **après** `wsServer.close()` et `deviceManager.close()`
mais **avant** `database.close()` — l'ordre est correct. En revanche rien ne
garantit l'extinction sur `process.exit()` brutal (SIGKILL, coupure secteur) :
c'est structurellement hors de portée logicielle et relève d'un **DMX hold-last-look
côté pupitre** — à documenter dans le manuel, pas à corriger ici.

`tests/lighting/shutdown-safe-state.test.js`, `tests/lighting/driver-udp.test.js`,
`tests/lighting/driver-http.test.js`

---

### F-31 (P1) — La configuration de règle proposée par défaut laisse la LED allumée pour toujours

`_matchesCondition()` filtre d'abord sur le type d'événement :

```js
if (condition.trigger && condition.trigger !== 'any') {
  if (condition.trigger !== midi.type) return false;
}
```

Une règle `trigger: 'noteon'` **ne voit donc jamais le relâchement**, et tout le
traitement note-off de `_executeAction()` (extinction, fade, `off_action`)
devient du **code mort** pour cette règle.

Ce n'est pas un cas tordu : c'est **le réglage par défaut de l'interface**.
`public/js/features/lighting/LightingForms.js:720-726` construit le `<select>`
avec `noteon` en **première** option ; pour une nouvelle règle `cond = {}`, aucune
option ne porte `selected`, donc le navigateur sélectionne la première.

Et le contournement « historique » ne s'applique pas : `DeviceManager.js:1353`
normalise un Note On de vélocité 0 en `noteoff` **avant** l'émission, donc le
moteur ne reçoit jamais de `noteon` vel=0 qui aurait pu déclencher la branche
d'extinction.

```
✓ trigger:noteon (the UI default for a new rule) lights the LED and never clears it
✓ trigger:'any' does clear it — the note-off path is only reachable that way
```

Deux variantes de la même classe, également prouvées :

* **F-31b** — une règle `trigger:'any'` avec un **plancher de vélocité**
  (`velocity_min: 64`, « ne réagir qu'aux notes fortes ») rejette le
  relâchement, qui porte une vélocité 0 : la LED reste allumée.
  Le filtre vélocité s'applique dès que `midi.velocity !== null`, sans
  distinguer attaque et relâchement.
* **F-31c** — un relâchement sans attaque correspondante (serveur redémarré
  touche enfoncée) ne fait **rien** : `activeNotes` n'a pas d'entrée pour
  l'appareil, `_handleNoteOff` sort sans écrire.

**État : CONFIRMÉ OUVERT.** Correctif non appliqué : il touche la sémantique
métier (faut-il faire passer les `noteoff` correspondants malgré le filtre
`trigger` ? changer le défaut de l'UI ? les deux ?) et l'UI est hors de mon
périmètre d'écriture. Recommandation §8.

`tests/lighting/rule-engine.test.js`

---

### F-32 (P2) — Les règles joker (`*`) se déclenchent **deux fois** par note jouée

Le code porte une « KNOWN LIMITATION » commentée (`LightingManager.js:231-238`).
Elle est ici **quantifiée** : la déduplication ne peut structurellement jamais
fonctionner, car l'ordre d'émission réel est
`midi_message` **puis** `midi_routed` — or seul le second remplit
`_recentRoutedEvents`. Quand `_evaluateWildcardEvent` s'exécute, l'ensemble est
vide ; quand `_evaluateRoutedEvent` s'exécute, il rejoue les règles `*`.

```
✓ F-32: a wildcard rule fires TWICE per logical input note
```

Conséquences : coût doublé sur le chemin chaud (cf. F-28), double écriture
réseau (cf. F-36), effets relancés deux fois. Avec un routage vers N
destinations, la règle joker s'exécute **1 + N** fois.

Effet secondaire mesuré : `_evaluateRoutedEvent` arme un `setTimeout(…, 50)` par
événement routé dès qu'au moins une règle existe — un timer par message MIDI.

**État : CONFIRMÉ OUVERT.** `tests/lighting/rule-engine.test.js`

---

### F-33 (P2) — `priority` n'a aucune sémantique inter-catégories, et aucune règle ne gagne

Deux constats :

1. **Toutes** les règles correspondantes s'exécutent (pas de *first-match-wins*).
   Sur un même appareil, la **dernière écriture gagne** : la règle de priorité
   la plus **basse** est celle qu'on voit.
2. `_evaluateRoutedEvent` traite le seau « instrument » **avant** le seau
   « joker ». Une règle joker de priorité 100 est donc écrasée par une règle
   instrument de priorité 0.

```
✓ every matching rule fires (no first-match-wins); the last write wins on the wire
✓ F-33: a high-priority wildcard rule is overwritten by a low-priority instrument rule
```

Le tri SQL `ORDER BY r.priority DESC, r.id` (`LightingDatabase.js`) n'a donc
d'effet **qu'à l'intérieur d'un seau**, et l'effet obtenu est l'inverse de
l'intention (priorité haute = écrite en premier = recouverte).

**État : CONFIRMÉ OUVERT.** `tests/lighting/rule-engine.test.js`

---

### F-34 (P2) — Deux capacités annoncées et mortes : le driver MQTT et les profils de fixtures DMX

> Les deux volets ont été signalés en parallèle par le lot **L14** (docs ↔ code)
> et sont ici **confirmés par l'exécution**, pas seulement par lecture statique.

#### F-34a — `MqttLightDriver` ne peut pas fonctionner : `mqtt` n'est pas une dépendance du projet

`MqttLightDriver.connect()` fait `await import('mqtt')`. Or :

```
$ node -e "import('mqtt').catch(e=>console.log(e.code, e.message.split('\n')[0]))"
ERR_MODULE_NOT_FOUND Cannot find package 'mqtt' imported from …
```

et `mqtt` n'apparaît ni dans `dependencies`, ni dans `optionalDependencies`, ni
dans `devDependencies` de `package.json`.

Un type d'appareil `mqtt` proposé par l'interface est donc **mort-né** : toute
tentative de connexion échoue avec une erreur de résolution de module. La
dégradation est propre (pas de crash, `connected === false`, pas de client
zombie — le `client?.end(true)` du bloc `catch` fait son travail), mais la
fonctionnalité annoncée n'existe pas.

```
✓ neither package.json nor node_modules provides `mqtt`
✓ connect() on a device of type 'mqtt' rejects with a module-resolution error
✓ every write on the failed driver is an inert no-op
```

Le reste du driver (formats WLED / Tasmota / ESPHome / générique) a néanmoins
été testé **client injecté** et se révèle correct — cf. §4.

**La dégradation ne touche pas le chemin MIDI** — vérifié de bout en bout à
travers `LightingManager._initDriver`, avec un appareil `mqtt` en base et une
règle qui le vise :

```
✓ a device of type "mqtt" configured in the DB degrades WITHOUT touching the MIDI path
```

`_initDriver` attrape l'échec du `import()`, journalise
`Failed to connect lighting device "Barre MQTT"`, diffuse
`lighting_device_status {connected:false}` sur le WebSocket, et **n'enregistre
aucun driver**. 50 messages MIDI émis ensuite : aucune exception, **aucune ligne
de log supplémentaire** (la règle vise un appareil sans driver, `_executeAction`
sort à la première ligne). Une seule ligne `error` au total, à l'initialisation.

**→ Ce n'est donc PAS un cas de F-28** : la panne est contenue à l'initialisation,
pas sur le chemin chaud. Le problème est fonctionnel (capacité annoncée absente),
pas temps-réel.

L'écart documentaire : `README.md:115` annonce « **MQTT** drivers »,
`docs/ARCHITECTURE.md:101` liste le fichier, l'UI propose le type d'appareil.

**État : CONFIRMÉ OUVERT.** Correctif hors périmètre (ajout de dépendance +
`package.json` interdit). Recommandation §8.

`tests/lighting/driver-degraded.test.js`

#### F-34b — Les profils de fixtures DMX ne sont branchés sur rien

`DmxFixtureProfiles.js` publie un catalogue d'une vingtaine de profils
(PAR, wash, moving head 16ch, laser, machine à fumée, stroboscope) et trois
fonctions. Recherche exhaustive des appelants :

```
$ grep -rn "mapColorToFixture\|listProfiles\|setFixture\|setDmxChannel" src/ public/js/ --include=*.js
src/api/commands/LightingCommands.js:912:    const { listProfiles } = await import('../../lighting/DmxFixtureProfiles.js');
src/api/commands/LightingCommands.js:913:    return { success: true, profiles: listProfiles() };
```

* `mapColorToFixture` : **0 appelant**.
* `getProfile` (celui de `DmxFixtureProfiles`) : **0 appelant**.
* `ArtNetDriver.setFixture()` et `ArtNetDriver.setDmxChannel()` : **0 appelant**
  — les seules portes d'entrée DMX brutes du projet ne sont câblées nulle part.
* `listProfiles` : un seul appelant, la commande `lighting_dmx_profiles`.

Et l'usage frontal de cette commande
(`public/js/features/LightingControlPage.js:1050-1084`) se limite à **remplir un
`<select>` dont la seule action est de pré-remplir le champ numérique
`channels_per_led`** (`_onDmxProfileChange`). La clé du profil choisi **n'est
jamais persistée** dans `connection_config`, et la carte de canaux
(`{dimmer, pan, tilt, gobo, strobe, …}`) **n'est jamais appliquée**.

`LightingManager._executeAction()` n'appelle jamais que `setColor` / `setRange`
/ `allOff` : le pipeline entier suppose une fixture RGB linéaire.

Conséquence concrète, mesurée sur tout le catalogue :

```
✓ F-34b: profiles addressing more than RGB are unusable — `speed`, `mode`,
  `pattern`, `output`, `fan`, `gobo`, `gobo_rotation`, `prism`, `focus`,
  `color_macro`, `pan_fine`, `tilt_fine` are never emitted
```

`mapColorToFixture` ne connaît que `r/g/b/dimmer/w/a/uv/strobe/pan/tilt` ; tous
les autres attributs déclarés sont **silencieusement ignorés**. Pour une machine
à fumée (`fog_basic_2ch`) et un laser (`laser_basic_3ch`), la fonction renvoie
**une liste de canaux vide** : ces fixtures ne sont adressables par aucun moyen.

**État : CONFIRMÉ OUVERT — capacité morte.** Soit on câble le profil
(persister `dmx_profile` dans `connection_config`, faire passer
`_executeAction` par `mapColorToFixture` + `driver.setFixture`), soit on retire
le sélecteur et le catalogue. Recommandation §8.

`tests/lighting/effects-and-profiles.test.js`

---

### F-35 (P2) — `connect()` des drivers UDP ne prouve jamais l'existence du luminaire

`ArtNetDriver.connect()` / `SacnDriver.connect()` / `OscLightDriver.connect()`
ne font que **binder une socket locale**. Un appareil pointant vers une adresse
où rien n'écoute est rapporté **connecté**.

```
✓ F-35: connect() succeeds against an address where nothing listens
```

(cible `192.0.2.1`, TEST-NET-1, non routable — `isConnected() === true`.)

C'est la même classe de faux positif que F-01 / F-02 (`/api/health` annonçant
`usb: ready` sans bibliothèque MIDI) : `lighting_device_list` renvoie
`connected: true` et l'UI affiche une pastille verte pour un projecteur qui n'a
jamais reçu un octet. Art-Net définit `ArtPoll`/`ArtPollReply` exactement pour
ça ; sACN a les paquets de découverte E1.31 ; aucun n'est implémenté.

Le `HttpLightDriver`, lui, **fait** un GET de test — mais avec
`firmware: 'generic'` un 404 est accepté comme un succès (choix documenté,
vérifié : `✓ firmware "generic" connects even on a 404`).

**État : CONFIRMÉ OUVERT.** `tests/lighting/driver-udp.test.js`

---

### F-36 (P2) — Aucun cap de débit : un datagramme par message MIDI, émis depuis le callback MIDI

Le lot d'écritures d'un **même tick** est coalescé par
`BaseLightingDriver._scheduleRender()` (`queueMicrotask`) — vérifié :

```
✓ several writes in one tick are coalesced into ONE packet (microtask batching)
```

Mais rien ne borne le débit **entre** ticks, et un message MIDI entrant = un
tick :

```
✓ F-36: there is NO send-rate cap across ticks — 1 packet per MIDI event
```

30 écritures dans 30 macrotâches ⇒ **30 datagrammes**. Un univers Art-Net se
rafraîchit normalement à ≤ 44 Hz ; un trille ou un passage dense de contrôleurs
(pitch-bend, CC de modulation) génère plusieurs centaines de messages par
seconde, chacun produisant sa trame DMX complète. Multiplié par F-32 (double
déclenchement) et par le nombre de règles.

`HttpLightDriver` est le seul à disposer d'un vrai lissage
(`batch_delay_ms`, 16 ms par défaut ⇒ ~60 req/s max), vérifié :
`✓ a burst of per-LED writes coalesces into ONE WLED request`.

**État : CONFIRMÉ OUVERT.** `tests/lighting/driver-udp.test.js`

---

### F-37 (P2) — 31 des 38 commandes `lighting_*` n'ont aucun schéma de payload

Compté à l'exécution, pas estimé :

```
✓ the module registers exactly the 38 documented lighting commands
✓ only 7 of the 38 have a payload schema — the other 31 are unvalidated
```

`src/api/commands/schemas/lighting.schemas.js` couvre : `lighting_device_add`,
`lighting_device_update`, `lighting_master_dimmer`, `lighting_effect_start`,
`lighting_group_create`, `lighting_group_color`, `lighting_bpm_set`.
**Les 31 autres passent le validateur *fail-open* de F-03 sans contrôle.**

Ce que les handlers acceptent réellement, mesuré :

| Payload | Effet observé |
|---|---|
| `lighting_master_dimmer {value:'bright'}` | `clamp()` ramène au plancher ⇒ **`masterDimmer = 0`, blackout général** — et la réponse est `success: true` |
| `lighting_bpm_set {bpm:'fast'}` | `getBpm()` et `getBeatMs()` deviennent **`NaN`** — le moteur de tempo est empoisonné |
| `lighting_group_color {r:999,g:-50,b:1e9,brightness:100000}` | valeurs transmises **non bornées** au driver (le `_applyBrightness` de chaque driver rattrape, mais un driver tiers non) |
| `lighting_group_color {color:'javascript:alert(1)'}` | `hexToRgb` échoue ⇒ **blanc plein feu** silencieux |
| `lighting_rule_add {condition_config:{velocity_min:'loud'}}` | **accepté et persisté** : `validateMidiRange` ne fait que deux comparaisons, qu'une chaîne passe |
| `condition_config: {cc_number: 0}` (scalaire au lieu d'un tableau) | le filtre CC est **silencieusement désactivé** — la règle réagit à tous les contrôleurs |
| `lighting_effect_start {effect_type:'chase; DROP TABLE'}` | ignoré avec un `warn`, pas d'erreur cliente |
| `lighting_scene_apply {scene:{…}}` | objet **entièrement non validé** parcouru : couleurs peintes, effets relancés |

Les garde-fous qui **existent** bien, également vérifiés :
`requireField` sur les 8 commandes concernées ; `NotFoundError` sur un
`device_id` inconnu ; bornes MIDI 0-127 numériques ;
`lighting_device_scan` refuse un `subnet` non-`/24` (garde SSRF) ;
`lighting_rules_import` refuse un JSON malformé, un tableau manquant et un lot
> 1000 règles ; `ConfigurationError` propre quand le manager est absent.

**État : CONFIRMÉ OUVERT.** À traiter avec F-03 (lot L01).
`tests/lighting/commands.test.js`

---

### L01 F-18 — `lighting_midi_learn`, interrupteur d'arrêt à distance (corrigé par L01, régression conservée ici)

Même classe que F-30(a) : `app.eventBus.removeListener(...)` dans
`lightingMidiLearnStart`. Deux chemins :

* **timeout 10 s** — le `TypeError` s'échappait **d'un callback `setTimeout`**,
  donc hors de tout `try/catch` du dispatcher ⇒ `uncaughtException` ⇒
  `Application.js:787` déclenchait `shutdown()`. **Une seule trame
  `lighting_midi_learn` suivie de 10 s de silence MIDI arrêtait le serveur.**
* **chemin nominal** — le `TypeError` était avalé par le `try/catch` par-listener
  de `EventBus.emit` : la promesse ne se résolvait jamais (client bloqué) et
  l'écouteur restait attaché sur le chemin MIDI chaud.

L01 a corrigé les deux (`off()`), avec le commentaire d'audit en place.
L02 conserve les tests de non-régression, la classe de défaut étant partagée
avec F-30 :

```
✓ the 10 s timeout resolves with a clean failure instead of throwing out of the timer
✓ the timeout path detaches its listener
✓ the success path resolves with the captured message and detaches
```

`tests/lighting/commands.test.js`

---

## 3. AB01 — Moteur de règles : ce qui a été établi

`tests/lighting/rule-engine.test.js` — 26 tests, tous verts.

**Sémantique confirmée correcte :**

| Aspect | Comportement établi |
|---|---|
| `trigger: 'any'` / absent | correspond à tous les types (`noteon`, `noteoff`, `cc`, `pitch`, `program`) |
| `trigger` explicite | rejette tout autre type (**cause de F-31**) |
| `channels` | liste d'inclusion sur le canal 0-based ; **liste vide = pas de filtre** |
| `note_min` / `note_max` | bornes **inclusives** (59 ✗, 60 ✓, 72 ✓, 73 ✗) |
| `velocity_min` / `velocity_max` | bornes **inclusives** (39 ✗, 40 ✓, 100 ✓, 101 ✗) |
| `cc_number` | liste d'inclusion ; un autre CC ne déclenche pas ; `[0]` fonctionne |
| `cc_value_min/max` | ne s'appliquent **qu'aux messages `cc`** (un pitch-bend n'est pas filtré) |
| couleur hex invalide | dégradée en **blanc**, jamais d'exception |
| `brightness_from_velocity` | 0..127 → 0..255 |
| master dimmer | multiplicatif sur la luminosité finale (`bri × dimmer / 255`) |
| `note_color` | teinte chromatique par classe de hauteur, **invariante par octave** (C60 = C72 = rouge) |
| `velocity_mapped` | interpolation linéaire entre paliers ; valeurs hors plage **clampées**, pas extrapolées ; map vide → blanc |
| `color_temp` | 0 = chaud, 127 = froid, monotone sur le canal bleu |
| `vu_meter` | nombre de LEDs allumées ∝ vélocité, le reste explicitement éteint |
| `note_led` | une note → **exactement une** LED, **clampée** au segment (note 0 et note 127 restent dans 0..7) |
| `off_action: 'hold'` | maintient la LED au relâchement |
| polyphonie | l'appareil ne s'éteint qu'au relâchement de la **dernière** note tenue |
| règle pointant un appareil inconnu | inerte |

**Coût d'évaluation borné (§AB01, mesure demandée).**
Mesuré dans `midi-path-isolation.test.js` : avec un driver sain, le dispatch
d'un message coûte **0,2 ms** ; le coût croît **linéairement** avec le nombre de
règles correspondantes (4 règles × 25 ms = 100 ms). Le moteur lui-même est en
O(nb de règles du seau) — `rulesByInstrument` indexe par instrument, donc le
seau interrogé est petit ; il n'y a **pas** de comportement superlinéaire.
Le coût dominant est **le driver**, pas l'appariement. **PASS niveau 4** —
niveau 5 exigerait un banc dédié 1/10/100 règles publiant une courbe, non
réalisé faute de budget de session (cf. §9).

---

## 4. AB02–AB07 — Les 8 drivers

### Ce qui a été monté

| Driver | Bouchon utilisé | Suite |
|---|---|---|
| `ArtNetDriver` | socket `dgram` locale, port éphémère | `driver-udp.test.js` |
| `SacnDriver` | socket `dgram` locale sur 5568 (port imposé par E1.31) | `driver-udp.test.js` |
| `OscLightDriver` | socket `dgram` locale + décodeur OSC de test | `driver-udp.test.js` |
| `HttpLightDriver` | serveur `node:http` local (WLED / Hue / générique / muet) | `driver-http.test.js` |
| `MqttLightDriver` | client MQTT injecté (le module n'existe pas — F-34) | `driver-degraded.test.js` |
| `SerialLedDriver` | port série injecté + `/dev/ttyGMBOOP-absent` | `driver-degraded.test.js` |
| `GpioLedDriver` | `pigpio` remplacé par `jest.unstable_mockModule` | `driver-gpio.test.js` |
| `GpioStripDriver` | `rpi-ws281x-native` remplacé de même | `driver-gpio.test.js` |
| `BaseLightingDriver` | via ses sous-classes | toutes |

### Conformité protocolaire vérifiée octet par octet

**Art-Net (AB03).** En-tête `"Art-Net\0"`, OpCode `0x5000` **petit-boutien**,
version de protocole 14, octet physique 0, `SubUni = (subnet << 4) | (universe & 0x0F)`,
`Net`, longueur **gros-boutien**, données DMX à l'offset 18. Séquence : incrément
modulo 256 **en sautant 0** (254 → 255 → 1 → 2, conforme à la spec). Univers
plafonné à 512 canaux ; une écriture au-delà est **abandonnée, pas repliée**.
`setDmxChannel` / `setFixture` / `getDmxValues` bornent les index.

**sACN / E1.31 (AB04).** Longueur totale = `125 + slots` ; préambule `0x0010`,
post-ambule `0x0000`, identifiant ACN `"ASC-E1.17\0\0\0"` ; les **trois** champs
de longueur de PDU (root / framing / DMP) sont cohérents avec la longueur réelle
(la correction historique « 126 → 125 » est confirmée en place) ;
`VECTOR_ROOT_E131_DATA = 4`, `VECTOR_E131_DATA_PACKET = 2`,
`VECTOR_DMP_SET_PROPERTY = 0x02`, type d'adresse `0xA1` ; nom de source, priorité,
univers, compteur de slots, code de départ DMX = 0. CID de 16 octets **stable**
pour la durée de la connexion. Séquence **enroulée par 0** (254 → 255 → 0 → 1,
conforme, contrairement à Art-Net). Adresse multicast `239.255.<hi>.<lo>` dérivée
de l'univers (univers 258 → `239.255.1.2`).

**OSC (AB05).** Chaînes **terminées par nul et alignées sur 4 octets** ;
type tag `,fff` en `rgb_float`, `,iiii` en `rgbw_int` avec un canal blanc à 0 ;
`allOff` émet `/light/master` **puis** une trame noire par LED ;
motif d'adresse paramétrable (`{led}`).

**HTTP / WLED / Hue (AB06).** Sonde de connexion `/json/info` (WLED),
`/api/<clé>/lights` (Hue), `/status` (générique) ; un 404 refuse la connexion en
WLED et l'accepte en générique ; `api_key` → en-tête `Authorization: Bearer` ;
lot WLED `{on:true, seg:[{id:0,i:[idx,[r,g,b],…]}]}` ; deux écritures sur la
même LED dans un lot ⇒ **seule la dernière** est transmise ; générique
`POST /set {leds:[{index,r,g,b,brightness}]}` ; Hue = un `PUT` par lampe avec
conversion HSV ; luminosité appliquée **avant** la sortie du processus.

**MQTT (AB07, client injecté).** WLED (`/api`, forme segment pour les plages —
**une** publication au lieu de trois), Tasmota (`cmnd/Color1` hex + `cmnd/Dimmer`
en pourcentage), ESPHome (`light/<idx>/command`), générique (`/set`) ;
`allOff` publie la commande d'extinction propre à chaque firmware et **remet le
cache de couleurs à zéro** ; rien n'est publié tant que le lien courtier est
coupé ; QoS et `retain` transmis.

**Série (AB02).** Trame `[0xAA, idx_lo, idx_hi, R, G, B, 0x55]`, extinction
globale `[0xAA, 0xFF, 0xFF, 0, 0, 0, 0x55]`.

**GPIO (AB02, modules natifs simulés).** `GpioLedDriver` : broches par défaut
17/27/22, configuration multi-LED, **une LED dont la broche échoue est écartée
sans faire tomber les autres**, refus propre si aucune LED n'a pu être
initialisée, PWM pondéré par la luminosité, index hors plage ignoré.
`GpioStripDriver` : validation complète du câblage — **aucun** ruban, **plus de
3** rubans, **canal matériel dupliqué**, canal inconnu, **GPIO non câblable sur
ce canal** (`CHANNEL_GPIO_MAP`) ; espace d'index virtuel concaténant plusieurs
rubans ; empaquetage `0x00RRGGBB` ; segments nommés ; `finalize()` appelé une
seule fois.

### Résilience vérifiée

| Scénario | Résultat |
|---|---|
| Contrôleur HTTP muet | `AbortSignal.timeout(5000)` — **abandon mesuré à 5 002 ms**, pas de blocage |
| TCP refusé | `connect()` rejette proprement |
| Contrôleur qui disparaît en session | `warn` « HTTP Light request failed », **pas de crash**, mais **pas de reconnexion ni de changement d'état** (voir F-35) |
| 500 du contrôleur | avalé, la session continue |
| Écriture après `disconnect()` | no-op silencieux sur **les 8** drivers |
| Faute synchrone dans le rendu (`dgram.send` port hors plage) | absorbée par `_scheduleRender` ⇒ `warn` « render failed » |
| Faute d'écriture série (`ERR_STREAM_DESTROYED`) | absorbée ⇒ `warn` |
| Faute de rendu WS281x (« DMA busy ») | absorbée ⇒ `warn` |
| `pwmWrite` en défaut | absorbée ⇒ `warn` |
| Type d'appareil inconnu dans `DRIVER_MAP` | `warn` « No driver for lighting device type: laser », 0 driver chargé |
| `disconnect()` d'un driver dont la fermeture jette | `disconnectDevice()` va au bout, driver retiré |
| Module natif absent (pigpio / ws281x / mqtt) | `connect()` rejette, `connected = false`, écritures inertes |

**Aucune de ces situations ne fait tomber le processus.** Le travail
d'isolation fait lors de l'audit B1 (microtâche de rendu, tick d'effet, écriture
série) est confirmé effectif — mais il ne protège **pas** contre la lenteur
(F-28), seulement contre l'exception.

---

## 5. Couverture — avant / après

**Mesure de référence (avant), reproduite :**

```
$ NODE_OPTIONS=--experimental-vm-modules npx jest \
    tests/capability-status.test.js tests/instrument-light-manager.test.js \
    tests/instrument-light-protocol.test.js tests/lighting-effects-guard.test.js \
    tests/schema-lighting.test.js \
    --coverage --collectCoverageFrom='src/lighting/**/*.js' \
    --collectCoverageFrom='src/api/commands/LightingCommands.js'
```

**Mesure après :**

```
$ NODE_OPTIONS=--experimental-vm-modules npx jest tests/lighting \
    --coverage --collectCoverageFrom='src/lighting/**/*.js'
Statements   : 72.58 % ( 1128/1554 )
Branches     : 58.72 % (  542/923  )
Functions    : 73.50 % (  197/268  )
Test Suites: 10 passed · Tests: 198 passed
  (src/lighting/instrument/** est à 0 % dans CE run : il est couvert par les
   suites préexistantes, pas par tests/lighting — d'où la mesure globale
   ci-dessous, seule comparable au chiffre de F-13.)

$ … tests/lighting + les 4 suites lighting préexistantes + tests/audit/l12-resilience,
    --collectCoverageFrom='src/lighting/**/*.js'
    --collectCoverageFrom='src/api/commands/LightingCommands.js'
→ 1565 / 1867 statements = 83,82 % · 68,55 % branch · 86,96 % func
  Test Suites: 15 passed · Tests: 260 passed
```

| Fichier | stmts | avant | après |
|---|---:|---:|---:|
| `api/commands/LightingCommands.js` | 313 | **0 %** | **85,9 %** |
| `lighting/LightingManager.js` | 521 | **0 %** | **69,7 %** |
| `lighting/SacnDriver.js` | 124 | **0 %** | **91,1 %** |
| `lighting/ArtNetDriver.js` | 99 | **0 %** | **90,9 %** |
| `lighting/HttpLightDriver.js` | 98 | **0 %** | **94,9 %** |
| `lighting/MqttLightDriver.js` | 93 | **0 %** | **63,4 %** |
| `lighting/GpioStripDriver.js` | 83 | **0 %** | **98,8 %** |
| `lighting/OscLightDriver.js` | 70 | **0 %** | **97,1 %** |
| `lighting/GpioLedDriver.js` | 39 | **0 %** | **100 %** |
| `lighting/SerialLedDriver.js` | 38 | **0 %** | **76,3 %** |
| `lighting/BaseLightingDriver.js` | 36 | **0 %** | **100 %** |
| `lighting/LightingEffectsEngine.js` | 131 | 30,5 % | **98,5 %** |
| `lighting/DmxFixtureProfiles.js` | 30 | **0 %** | **100 %** |
| `lighting/instrument/**` | 192 | 84,9 % | 86,5 % |
| **Total périmètre F-13** | **1 867** | **2,35 %** | **83,82 %** |

> Le total de statements est passé de 1 785 à 1 867 : `LightingCommands.js` a été
> modifié par le lot L01 (correctif F-18) pendant ce lot.

**F-13 : de FAIL niveau 0 à PARTIAL niveau 4.** Le sous-système n'est plus
« le plus gros trou non testé du dépôt » : c'est désormais l'un des mieux
couverts. Quatre fichiers sont à **100 %** (`BaseLightingDriver`,
`DmxFixtureProfiles`, `GpioLedDriver`) ou quasi (`GpioStripDriver` 98,8 %,
`LightingEffectsEngine` 98,5 %, `OscLightDriver` 97,1 %).

Ce qui reste non couvert :
* `LightingManager` (69,7 %) — les minuteries de fondu (`_fadeIn`/`_fadeOut`),
  la diffusion WebSocket par lots (`_broadcastLedState`) et le chemin
  `connectDevice`/`reloadDevices` complet, tous liés au temps ou à un
  `wsServer` vivant ; le lot L08 (E2E navigateur) les atteindra mieux.
* `MqttLightDriver` (63,4 %) — le corps de `connect()` est **inatteignable**
  tant que F-34a n'est pas résolu (le module n'existe pas).
* `SerialLedDriver` (76,3 %) — le corps de `connect()` exige un port série.
* `LightingCommands` (85,9 %) — `lighting_device_scan` (balayage /24 réel) et
  la découverte de ponts Hue (appel Internet sortant).

---

## 6. Suites créées

| Fichier | Tests | Objet |
|---|---:|---|
| `tests/lighting/l02-fakes.js` | — | doubles partagés : `FakeLightingDriver`, base en mémoire, serveurs bouchons `dgram` / `http` |
| `tests/lighting/midi-path-isolation.test.js` | 10 | **risque n°1** : blocage, exception, pendaison, déconnexion, coupe-circuit |
| `tests/lighting/rule-engine.test.js` | 26 | sémantique des conditions et des actions, priorités, recouvrements |
| `tests/lighting/shutdown-safe-state.test.js` | 15 | retour à l'état sûr, `Application.stop()`, blackout, groupes, fuite d'écouteur |
| `tests/lighting/commands.test.js` | 28 | les 38 commandes, validation réelle, payloads absurdes |
| `tests/lighting/driver-udp.test.js` | 25 | Art-Net / sACN / OSC contre socket locale |
| `tests/lighting/driver-http.test.js` | 16 | WLED / Hue / générique contre serveur local |
| `tests/lighting/driver-degraded.test.js` | 18 | MQTT / série / GPIO sans leur transport |
| `tests/lighting/driver-gpio.test.js` | 21 | GPIO avec modules natifs simulés |
| `tests/lighting/effects-and-profiles.test.js` | 39 | moteur d'effets animés, contrat `BaseLightingDriver`, profils DMX |
| **Total** | **198** | + les 4 suites lighting préexistantes + `l12-resilience` = **260 tests verts** |

`l02-fakes.js` n'est pas un `*.test.js` : il n'est pas collecté par Jest, il est
importé par les suites.

---

## 7. Ce qui n'a pas été fait

* **`LightingDatabase.js` (1,7 %)** — non traité. Le lot L07 (persistance)
  dispose du `better-sqlite3` recompilé et de l'outillage de base ; y ajouter
  des tests depuis L02 aurait dupliqué son harnais et risqué un conflit sur les
  mêmes fixtures. Les chemins de persistance lighting **sont** exercés
  indirectement via `LightingCommands` (85,9 %) avec un dépôt en mémoire.
  Ce qui reste à couvrir spécifiquement : sérialisation/désérialisation JSON des
  colonnes `connection_config` / `condition_config` / `action_config`,
  `buildDynamicUpdate` sur champs partiels, jointure
  `getAllEnabledRules` (règle activée **et** appareil activé), et le
  `_safeJsonParse` sur une colonne corrompue.
* **§AC — mesure de l'offset MIDI ↔ lumière** — impossible sans photodiode ou
  caméra rapide + capture MIDI sur base de temps commune. → L15.
* **Banc de coût 1/10/100 règles publiant une courbe** — le coût a été mesuré
  et sa linéarité établie (§3), mais pas instrumenté en banc dédié.

---

## 8. Recommandations

| Pri | Action | Où |
|---|---|---|
| **P1** | **F-28** — sortir le lighting du chemin MIDI synchrone : mettre les appels driver derrière une file à un seul créneau vidée en `setImmediate`, avec un budget de temps par événement et un compteur d'écrasements. Le lighting est *best-effort* ; il ne doit jamais coûter une milliseconde au MIDI. | `LightingManager._executeAction` |
| **P1** | **F-31** — décider et corriger la sémantique du relâchement. Le plus simple : dans `_matchesCondition`, laisser passer un `noteoff` dont le `noteon` correspondant a été apparié (suivi déjà présent dans `activeNotes`), quels que soient `trigger` et `velocity_min`. À défaut, changer le défaut de l'UI en `any` et l'expliciter. | `LightingManager` + `LightingForms.js` (L09) |
| **P2** | **F-29** — envelopper `this._executeAction(rule, midiData)` dans un `try/catch` par règle, avec compteur d'échecs par appareil et mise en quarantaine au-delà d'un seuil. | `LightingManager` |
| **P2** | **F-32** — plomber un identifiant d'événement unique depuis `DeviceManager` jusqu'au routeur et dédupliquer dessus ; ou, plus simple et sans plomberie, ne plus évaluer les règles `*` dans `_evaluateRoutedEvent` (elles sont déjà couvertes par `midi_message`). | `LightingManager` |
| **P2** | **F-33** — soit appliquer *first-match-wins* par appareil après tri global sur `priority`, soit renommer le champ en `order` et documenter que tout s'exécute. L'état actuel est le contraire de l'intention. | `LightingManager._evaluateRoutedEvent` |
| **P2** | **F-34a** — ajouter `mqtt` aux `optionalDependencies` (vague 2, `package.json` interdit ici) **ou** retirer le type `mqtt` de l'UI, de `DRIVER_MAP` et du README. Diff proposé : `"optionalDependencies": { "mqtt": "^5.10.1", "pigpio": "^3.3.1", "rpi-ws281x-native": "^1.0.0" }`. À coordonner avec L14 (écart docs ↔ code). | `package.json` (vague 2) |
| **P2** | **F-34b** — câbler les profils DMX ou les retirer. Câblage minimal : persister `dmx_profile` dans `connection_config` (le `<select>` existe déjà), puis, dans `_executeAction`, router vers `driver.setFixture(startChannel, mapColorToFixture(profil, r, g, b, brightness))` quand le driver expose `setFixture`. Sinon, supprimer `mapColorToFixture`, `getProfile`, le sélecteur et l'entrée du wiki. | `LightingManager` + `LightingForms.js` (L09) |
| **P2** | **F-35** — implémenter `ArtPoll`/`ArtPollReply` (Art-Net) et, à défaut de découverte, marquer les appareils UDP `connected: unknown` plutôt que `true`, comme le fait déjà `/api/health` pour les capacités dégradées. | drivers UDP + `getDeviceStatus` |
| **P2** | **F-36** — plafonner l'émission à 44 Hz par univers (fusion de trames dans un timer, dernière valeur gagnante), à l'image du `batch_delay_ms` de `HttpLightDriver`. | `BaseLightingDriver` |
| **P2** | **F-37** — écrire les 31 schémas manquants ; à traiter avec F-03 (L01). Les plus urgents : `lighting_bpm_set`, `lighting_scene_apply`, `lighting_rule_add`/`update`, `lighting_group_color`. Et remplacer `validateMidiRange` par un contrôle `Number.isInteger`. | `schemas/lighting.schemas.js` (L01) |
| P3 | `LightingEffectsEngine.tapTempo()` arme un `setTimeout(3500)` par frappe, jamais annulé ; `shutdown()` ne les nettoie pas. Sans gravité (ils expirent), mais visible en `--detectOpenHandles`. | `LightingEffectsEngine` |
| P3 | Couvrir `LightingDatabase.js` et `DmxFixtureProfiles.js`. | L07 / vague 2 |

---

## 9. Non testable sans matériel — pour le lot L15

À reporter dans `15_HARDWARE_QA_CHECKLIST.md`. Tout le reste du §AB a été
couvert **sans matériel**.

| Réf | Ce qui reste à valider sur banc | Pourquoi c'est hors de portée logicielle |
|---|---|---|
| **AB02-HW1** | WS2812 / NeoPixel réel : timing du signal, absence de scintillement, ordre des couleurs (`strip_type`), fréquence 800 kHz, canal DMA | Le binding natif est simulé ; seul un oscilloscope ou un ruban réel prouve la trame |
| **AB02-HW2** | Contention DMA entre 2-3 rubans sur canaux matériels différents | Impossible à simuler |
| **AB02-HW3** | PWM `pigpio` réel : linéarité des niveaux, appel de courant, échauffement | Idem |
| **AB02-HW4** | Adaptateur série réel : débranchement à chaud en pleine écriture, saturation du buffer noyau à 115 200 bauds, réémission | `/dev/ttyUSB*` absent ; le port injecté ne modélise pas la contre-pression |
| **AB03-HW** | Nœud Art-Net réel : acceptation de la trame par un contrôleur du commerce, `ArtPoll`, comportement à > 44 Hz | La trame est prouvée conforme au bit près, son **acceptation** ne l'est pas |
| **AB04-HW** | Récepteur E1.31 réel (QLC+, MagicQ, ETC) : multicast sur un vrai réseau, priorité, fusion de sources, perte de synchro | Le multicast local ne reproduit pas IGMP ni un commutateur |
| **AB05-HW** | QLC+ / QLab / TouchDesigner : mappage OSC réel | Le décodeur de test valide l'encodage, pas l'interprétation |
| **AB06-HW** | Boîtier WLED / pont Hue réels : réponse du firmware, appairage, limite de requêtes | Le bouchon répond ce qu'on lui dit de répondre |
| **AB07-HW** | Courtier MQTT réel + Tasmota/ESPHome : reconnexion, QoS 1/2, messages retenus. **Bloqué en amont par F-34a** — inutile de prévoir le banc tant que la dépendance n'existe pas. | Le module `mqtt` n'est pas installable ici |
| **AB03/04-HW2** | Fixture non-RGB réelle (moving head, machine à fumée, stroboscope) pilotée par profil. **Bloqué en amont par F-34b** — aucun chemin logiciel n'y mène aujourd'hui. | Capacité morte : rien à valider sur banc avant câblage |
| **AC-HW** | **Offset MIDI ↔ lumière** : mesurer le délai réel entre l'événement musical et l'événement lumineux | Photodiode / caméra rapide + capture MIDI sur base de temps commune. Sans objet tant que F-28 n'est pas corrigé : l'offset serait dominé par le blocage synchrone |
| **C02-HW** | Extinction sur coupure secteur / SIGKILL | Relève du *hold-last-look* du pupitre, pas du logiciel |

---

## 10. Correctifs appliqués dans ce lot

| # | Fichier | Nature | Test rouge → vert |
|---|---|---|---|
| 1 | `src/lighting/LightingManager.js` | `eventBus.removeListener` → `off` (+ remise à `null` des handlers) | `shutdown-safe-state.test.js` — 5 tests rouges avant, verts après |
| 2 | `src/lighting/BaseLightingDriver.js` | ajout de `_drainSocket()` | support des correctifs 3-5 |
| 3 | `src/lighting/ArtNetDriver.js` | `await this._drainSocket()` avant `socket.close()` | `driver-udp.test.js` « F-30b … » |
| 4 | `src/lighting/SacnDriver.js` | idem | `driver-udp.test.js` « F-30b … » |
| 5 | `src/lighting/OscLightDriver.js` | idem | `driver-udp.test.js` « F-30b … » |
| 6 | `src/lighting/HttpLightDriver.js` | `allOff()` renvoie sa promesse, `_doDisconnect()` l'attend, `_sendHueAllOff` attend ses requêtes | `driver-http.test.js` « F-30b … » |
| 7 | `src/lighting/instrument/InstrumentLightManager.js` | `eventBus?.removeListener?.` → `eventBus?.off?.` (fuite d'écouteur silencieuse, L01 F-27) | `shutdown-safe-state.test.js` « F-30c … » — 2 tests rouges avant, verts après |

Aucun fichier partagé modifié (`package.json`, `config.json`, `jest.config.cjs`,
CI, `CLAUDE.md`). Aucune commande git, aucun `npm install`.
`src/api/commands/LightingCommands.js` **n'a pas été modifié par L02** : le
correctif F-18 y a été appliqué par le lot L01 pendant l'exécution de celui-ci.

---

## 11. Reproduction

```bash
# suite lighting complète
NODE_OPTIONS=--experimental-vm-modules npx jest tests/lighting --forceExit --testTimeout=20000

# couverture du périmètre F-13
NODE_OPTIONS=--experimental-vm-modules npx jest tests/lighting \
  tests/instrument-light-manager.test.js tests/instrument-light-protocol.test.js \
  tests/schema-lighting.test.js tests/capability-status.test.js \
  --coverage --collectCoverageFrom='src/lighting/**/*.js' \
  --collectCoverageFrom='src/api/commands/LightingCommands.js' --forceExit

# la mesure de latence du chemin MIDI (F-28)
NODE_OPTIONS=--experimental-vm-modules npx jest tests/lighting/midi-path-isolation.test.js --forceExit
```

`--testTimeout=20000` est nécessaire pour le test de contrôleur HTTP muet
(`AbortSignal.timeout(5000)` côté driver). `--forceExit` est nécessaire tant que
`tapTempo()` laisse un timer non annulé (recommandation P3 §8).
