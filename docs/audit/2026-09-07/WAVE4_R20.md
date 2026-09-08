# Vague 4 · R20 — Rechargement en pleine lecture : rendre le transport à l'opérateur

**Findings visés :** **F-94** (P1, §AN/§BW) · **F-90** (P2, §AN/§AM) · **F-88**
(P2, volet client) · **F-86** (P1, la moitié triviale, prise au passage)
**Preuve :** navigateur réel — `tests/e2e/specs/04-resilience.spec.mjs`
**Périmètre touché :** `public/index.html`, `public/js/`, `tests/frontend/`,
`tests/e2e/`. Aucun fichier de `src/` modifié.

---

## 1. Ce qui était cassé

Le harnais L08 l'avait mesuré dans un vrai Chromium : fichier routé, lecture
lancée, `F5` au milieu du morceau.

| Source | Ce qu'elle disait |
|---|---|
| Backend `playback_status` | `playing: true`, `position: 6,15 s / 15,98 s`, `outputDevice: virtual_…` |
| En-tête de la SPA rechargée | `stopDisabled: true`, `file: "No file selected"`, bouton `▶️ Lecture` |

**L'orchestre jouait, l'interface l'ignorait.** Pas de nom de fichier, pas de
position, et surtout **pas de bouton Stop** — il était désactivé, puisque la SPA
croyait qu'il ne se passait rien. Plus aucun moyen d'arrêter le son depuis l'UI :
sur scène, un rafraîchissement accidentel, un onglet rouvert ou un plantage de
l'onglet faisait perdre le contrôle pendant toute la durée du morceau.

La cause n'était pas une donnée manquante mais **un raccordement manquant** :
`playback_status` est une commande enregistrée, schématisée, testée… et sans
aucun appelant dans la SPA. Un des 72 commandes sans surface UI relevées par
L01.

Le second défaut, F-90, est le même en miroir : `updatePlaybackControls()`
dérivait l'état des boutons de la **sélection de fichier**, pas du **transport**.

```js
playPauseBtn.disabled = !currentFileId;
stopBtn.disabled = !currentFileId;
```

`currentFileId` n'est volontairement jamais remis à `null` après un Stop (pour
pouvoir relancer), donc Stop restait cliquable indéfiniment — après un arrêt
comme après une fin de morceau. Et symétriquement, une page fraîche n'a pas de
`currentFileId`, donc Stop y était mort **même quand le backend jouait**. Les
deux findings sont les deux faces de la même ligne.

---

## 2. Le mécanisme de resynchronisation

### 2.1 À la (re)connexion, la SPA demande au serveur ce qu'il fait

`public/index.html`, gestionnaire `api.on('connected')` — donc **à chaque
connexion**, pas seulement à la première : une coupure Wi-Fi peut masquer une
transition que le client n'a jamais vue (une fin de morceau, un Stop lancé
depuis une autre tablette).

```js
resyncTransportFromBackend().catch((error) => { … });
```

`resyncTransportFromBackend()` (défini à côté de `setHeaderProgress`, dans la
portée qui possède l'état du transport) :

1. appelle **`api.getPlaybackStatus()`** — nouvelle méthode de
   `BackendAPIClient`, qui envoie la commande existante `playback_status` ;
2. passe la réponse à `PlaybackResync.plan()` ;
3. si rien ne joue : `isPlaying = isPaused = false` + `updatePlaybackControls()`
   — l'UI ne doit pas prétendre le contraire (c'est aussi F-90) ;
4. si quelque chose joue : restaure `isPlaying` / `isPaused`, `currentDuration`,
   `currentTempo`, `currentFileId`, le nom dans l'en-tête, la barre de
   progression et le temps, puis `updatePlaybackControls()`.

### 2.2 `PlaybackResync` — la logique de décision, isolée et testable

`public/js/features/transport/PlaybackResync.js` (nouveau, ~250 lignes avec la
doc, sans DOM ni accès aux globales de la SPA) :

| Fonction | Rôle |
|---|---|
| `remember() / read() / forget()` | le pense-bête `localStorage` (`gmboop_now_playing`) de ce que **ce** navigateur a lancé : `{fileId, filename, duration, at}` |
| `plan(status, cached)` | ce que l'en-tête doit montrer : `{active, playing, paused, fileId, filename, position, duration, tempo, identity}` |

Trois règles, et elles comptent :

- **Le serveur décide toujours de _ce qui joue_.** `active` vaut exactement
  `status.playing === true` — ni une chaîne `"false"`, ni un `1`. `playing`
  reste `true` pendant une pause côté `MidiPlayer` (seul `paused` monte), donc
  « transport vivant » couvre bien lecture *et* pause : une pause tient les
  notes, Stop doit rester offert.
- **Le pense-bête ne sert qu'au _nom_**, et seulement s'il **concorde avec la
  durée annoncée par le serveur** (± 1,5 s) et s'il a moins de 12 h. Une lecture
  lancée depuis une autre tablette ne peut donc pas être étiquetée avec le
  dernier fichier de ce navigateur-ci.
- **Faute d'identité fiable, le transport est quand même rétabli**
  (`identity: 'unknown'`, libellé `common.unknown`). *Pouvoir arrêter prime sur
  pouvoir nommer* — c'est tout l'objet de F-94.

Le pense-bête est écrit dans le gestionnaire `playback_status` (pour capturer la
**durée réelle** annoncée par le serveur, qui est ensuite la garantie de
concordance) et dès le clic dans `playFile()`. Il est idempotent : un même
contenu n'est pas réécrit à chaque diffusion d'état.

### 2.3 Pourquoi un pense-bête local, et comment le supprimer

`MidiPlayer.getStatus()` connaît `this.loadedFileId` **et ne le renvoie pas** :

```js
getStatus() {
  return { playing, paused, position, duration, percentage,
           outputDevice, loop, tempo, events };   // ← pas de fileId
}
```

Le client est déjà écrit pour préférer le serveur dès qu'il parlera
(`identity: 'backend'`, testé). Le correctif serveur, **hors périmètre R20**
(`src/` est tenu par deux autres agents cette vague), tient en trois lignes :

```diff
--- a/src/midi/playback/MidiPlayer.js
+++ b/src/midi/playback/MidiPlayer.js
@@ getStatus() {
     return {
       playing: this.playing,
       paused: this.paused,
+      fileId: this.loadedFileId,
       position: this.position,
@@ broadcastStatus() {
       const status = {
         playing: this.playing,
         paused: this.paused,
+        fileId: this.loadedFileId,
         position: this.position,
```

(Et, si l'on veut aussi le nom sans aller-retour :
`filename: this.database.getFile(this.loadedFileId)?.filename`, à ne faire que
si le coût d'une lecture DB par diffusion est acceptable — sinon le client
résout le nom par `file_list`, qu'il charge de toute façon.)

Avec ce diff, `identity` passe de `'cache'` à `'backend'` sans **aucune** autre
modification du client, et le cas « deuxième tablette » affiche le vrai nom au
lieu de `Unknown`. Les tests unitaires livrés couvrent déjà les deux branches.

### 2.4 L'état des boutons vient du transport, plus de la sélection

```js
const transportActive = isPlaying || isPaused;
playPauseBtn.disabled = !currentFileId && !transportActive;
stopBtn.disabled = !transportActive;              // F-90 + F-94
ctrlBtn.disabled  = !currentFileId && !transportActive;
```

Deux gardes qui refusaient l'action faute de `currentFileId` ont sauté pour la
même raison — après un rechargement, l'opérateur doit pouvoir **mettre en
pause** et **chercher une position** dans une lecture que son navigateur n'a pas
lancée :

- `togglePlayPause()` : pause / reprise ne demandent aucune identité de fichier
  au backend (`playback_pause` / `playback_resume` sont sans payload) ;
- clic sur la barre de progression : `playback_seek` n'a besoin que d'une durée
  connue.

Le cas « rien ne joue et rien n'est sélectionné » reste traité, inchangé, en
tête de `togglePlayPause()`.

**Effet de bord assumé (F-91) :** le libellé du bouton passe désormais par
`i18n.t('ui.play')` au lieu de la chaîne en dur `'▶️ Lecture'`, qui écrasait la
traduction dès la première lecture. Mesuré après ce correctif, en locale `en` :
`"label": "▶️ Play"`. `'⏸️ Pause'` reste en dur (identique en fr/en, et aucune
clé `ui.pause` n'existe : en ajouter une toucherait les 28 locales, ce qui
appartient au lot i18n de la vague 5).

---

## 3. La preuve : navigateur, pas jsdom

`tests/e2e/specs/04-resilience.spec.mjs`, exécuté sur port 8402 avec une base
jetable hors du dépôt.

### 3.1 Test étendu — « the page is reloaded mid-playback »

Il n'assertait que la *cohérence* en-tête/backend. Il assère maintenant, **sur
la page rechargée uniquement**, que le transport est **repris ET opérant** :

```
· reload while it is playing
· the reloaded UI agrees with the backend about what is playing
· the reloaded UI shows where the piece is, not 0:00
· Stop, clicked in the reloaded page, really stops the orchestra
· and the button goes back to inert once it has stopped
```

Relevé du run final :

| Moment | Backend | En-tête de la page rechargée |
|---|---|---|
| Après le rechargement | `playing:true, position:5,88 / 15,98 s` | `file:"🎵 e2e-two-channel.mid"`, `stopDisabled:false`, `playDisabled:false`, `time:"0:05 / 0:15"`, `progress:36,3 %` |
| Après **clic** sur Stop | `playing:false, position:0` | `stopDisabled:true`, `label:"▶️ Play"`, `progress:0 %` |

Le clic est un vrai clic Playwright (`app.clickStop()`), jamais un
`element.click()` dispatché : la règle maison du harnais, et ici elle porte —
c'est précisément « le bouton existe-t-il et atteint-il quelque chose » qui est
en cause.

### 3.2 Test ajouté — « a browser that never started the playback still gets a working Stop »

Le cas de scène que le premier ne peut pas couvrir : le rechargement garde le
`localStorage`, donc le nom est connu « pour de bonnes raisons ». Ici, un
**contexte navigateur neuf** (la tablette a lâché, quelqu'un rouvre la SPA
ailleurs) pendant que l'orchestre joue :

```
header transport on the fresh profile :
  {"playing":true,"label":"⏸️ Pause","file":"🎵 Unknown",
   "stopDisabled":false,"time":"0:06 / 0:15","progressWidth":"39,99%"}
backend playback_status after the fresh profile stopped it :
  {"playing":false,"position":0}
```

Le nom est honnêtement `Unknown` (il le restera jusqu'au diff §2.3) — **le
contrôle, lui, est là**. C'est la propriété qui compte pour F-94.

### 3.3 F-90, mesuré par le test dédié de `02-canonical`

```
transport on a fresh page, nothing playing : stopDisabled:true , playDisabled:true
header after stop                          : stopDisabled:true , label:"▶️ Play"
backend after stop                         : playing:false
```

Avant : `stopDisabled:false` après un Stop, indéfiniment.

---

## 4. État des 8 échecs E2E après ce passage

Suite complète, `E2E_MODAL_CYCLES=20` : **10 PASS / 5 FAIL** (avant R20 :
7 PASS / 8 FAIL — le harnais compte deux tests de plus, ajoutés ici).

| Suite | Test | Avant | Après | Finding |
|---|---|---|---|---|
| 01 · boot | 3 tests | PASS ×3 | **PASS ×3** | — |
| 02 · canonique | parcours complet (17 étapes) | FAIL (10d) | **FAIL (10d)** | **F-86, cause requalifiée — voir §5** |
| 02 · canonique | le contrôle de tempo applique ce qu'il affiche | FAIL | **PASS** | **F-86 (moitié close)** |
| 02 · canonique | le transport reflète l'état de lecture | FAIL | **PASS** | **F-90 fermé** |
| 03 · fuites | KeyboardModal | FAIL | FAIL (+18 listeners/cycle) | F-95 — hors périmètre |
| 03 · fuites | InstrumentManagementPage | FAIL | FAIL (+35) | F-95 — hors périmètre |
| 03 · fuites | SettingsModal | PASS | PASS | — |
| 03 · fuites | LoopCreatorModal | FAIL | FAIL (+4,95) | F-95 — hors périmètre |
| 03 · fuites | PlaylistPage | FAIL | FAIL (+8,95) | F-95 — hors périmètre |
| 04 · résilience | coupure WebSocket en lecture | PASS | PASS | — |
| 04 · résilience | **rechargement en pleine lecture** | **FAIL** | **PASS** | **F-94 fermé** |
| 04 · résilience | **profil neuf pendant la lecture** | *(nouveau)* | **PASS** | **F-94** |
| 05 · routage live | parcours complet | PASS | PASS | — |

**Restent rouges, et pourquoi :**

- **F-95 ×4 — fuites de modales** (`KeyboardModal`, `InstrumentManagementPage`,
  `LoopCreatorModal`, `PlaylistPage`). Aucun rapport avec le transport ; c'est
  un chantier de nettoyage `BaseModal` par modale (`div.keyboard-modal` n'est
  jamais retiré du `<body>`, etc.), non listé dans la vague 4. Les chiffres sont
  **inchangés au dixième** par rapport à la mesure L08 : rien de ce que R20
  touche ne les influence.
- **F-86 — parcours canonique, étape 10d.** Ne casse plus pour la raison
  d'origine (§5).

---

## 5. F-86 : ce que j'ai pris, ce qui reste

**Pris (trivial et local, dans mon périmètre) :** `MidiEditorEvents.js` appelait
`this.modal.setTempo(...)` sur les deux gestionnaires du champ tempo. Cette
méthode a migré vers le sous-composant `editActions` lors de la réécriture des
mixins et le délégué n'a jamais été ajouté : **chaque frappe levait une
`TypeError` non capturée** et n'appliquait rien. Deux lignes :

```diff
-            this.modal.setTempo(newTempo);
+            this.modal.editActions?.setTempo(newTempo);
…
-            this.modal.setTempo(newTempo, { silent: true });
+            this.modal.editActions?.setTempo(newTempo, { silent: true });
```

Résultat mesuré : `uncaught page errors after the tempo edit: []` (contre 4
`this.modal.setTempo is not a function` avant), `{"modalTempo":96,"isDirty":true}`,
et le test dédié « the MIDI editor's tempo control applies the tempo it
displays » **passe au vert**.

**Reste rouge — et ce n'est plus le même défaut.** L'étape 10d vérifie le tempo
du **fichier sauvegardé** : il vaut toujours 120 après avoir tapé 96. Cause
identifiée pendant ce passage :

```js
// public/js/features/midi-editor/MidiEditorMidiWriter.js:78
if (this.modal.tempoEvents && this.modal.tempoEvents.length > 0) {
  // reconstruit les événements depuis la CARTE de tempo…
} else {
  const tempo = this.modal.tempo || 120;   // ← la seule branche qui lit l'en-tête
}
```

Le champ tempo de l'en-tête n'écrit que `modal.tempo` ; dès que le fichier porte
une carte de tempo — c'est-à-dire dès qu'il contient un `setTempo`, donc
presque toujours — la carte gagne à l'écriture et l'édition d'en-tête est
purement cosmétique. Deux correctifs possibles, et **c'est un arbitrage produit,
pas une correction mécanique** :

1. `setTempo()` met à jour `tempoEvents[0].tempo` **quand la carte n'a qu'une
   seule entrée** (fichier à tempo constant, le cas courant) et laisse la carte
   intacte au-delà — l'éditeur de tempo dédié existe pour ce cas ;
2. ou le champ d'en-tête devient un facteur d'échelle appliqué à toute la carte.

Je ne l'ai pas tranché : c'est le chemin de **sauvegarde** de l'éditeur MIDI,
réécrire silencieusement la carte de tempo d'un utilisateur n'est pas une
décision à prendre en passant, et F-86 n'est pas dans la vague 4. La mécanique
exacte et les deux options sont consignées ici et dans l'en-tête du test de
non-régression livré.

---

## 6. F-88, volet client : rien à refaire

Le volet serveur a été fermé en vague 2 / R6 (`HttpServer.js` : un chemin dont
le dernier segment porte une extension est un asset, jamais une route SPA →
`404 text/plain`, 9 octets au lieu de 615 Ko d'`index.html` sous l'identité d'un
`.js`). Vérifié côté client sur ce passage :

- `01 · boot` → « a missing static asset is a 404, not the SPA shell » : **PASS** ;
- aucune requête CDN au démarrage, `DOMContentLoaded` découplé du réseau : **PASS** ;
- la garde `typeof WebAudioFontPlayer === 'undefined'` pose bien
  `window.__GMBOOP_AUDIO_PREVIEW_UNAVAILABLE__` et écrit quoi relancer.

Ce qui reste dans la console d'un dépôt installé avec `--ignore-scripts` :

```
[error] Failed to load resource: … 404 (Not Found)
[error] Refused to execute script from '…/lib/WebAudioFontPlayer.js'
        because its MIME type ('text/plain') is not executable
```

Ce **n'est plus le défaut** : c'est le signal correct d'un asset optionnel
absent, et il disparaît dès que `npm run install-default-sf2` a tourné. Le
rendre silencieux demanderait de savoir avant de demander — impossible côté
client. Le manque restant est ailleurs et porte déjà un numéro : **F-93**, le
bandeau utilisateur « banque de sons indisponible » (le drapeau est posé, aucune
vue ne l'affiche). Non traité ici.

---

## 7. Tests livrés

| Fichier | Ce qu'il verrouille |
|---|---|
| `tests/frontend/r20-playback-resync.test.js` (17 tests) | `PlaybackResync` : le serveur décide de ce qui joue (`playing === true` strict, `'false'`/`1` refusés) ; pause ≠ arrêt ; le pense-bête refusé s'il est périmé ou si la durée contredit le serveur ; identité `backend` prioritaire (compat. avec le diff §2.3) ; position bornée à la durée ; nombres hostiles normalisés ; stockage corrompu / hostile (mode privé) survécu ; pas de réécriture à chaque diffusion d'état |
| `tests/frontend/r20-transport-header.test.js` (13 tests) | **`updatePlaybackControls()` extrait de `index.html` et exécuté** — donc le code réellement livré : Stop inerte page fraîche, Stop inerte après un Stop (F-90), Stop offert en lecture **et** en pause, **Stop + Pause offerts sans `fileId` local** (F-94), libellé par i18n avec repli anglais, navigation playlist inchangée. Plus le raccordement : la balise de script, la resynchro **hors** du verrou `connectedCount === 1`, l'appel à `api.getPlaybackStatus()`, et la commande réellement envoyée par `BackendAPIClient` |
| `tests/frontend/r20-midi-editor-tempo-delegate.test.js` (3 tests) | F-86 : plus aucun `this.modal.setTempo(` dans `MidiEditorEvents.js`, les deux gestionnaires passent par `editActions`, et la cible existe sur le sous-composant. L'en-tête du fichier documente ce qui **n'est pas** fermé (§5) |
| `tests/e2e/specs/04-resilience.spec.mjs` | la preuve navigateur : §3.1 et §3.2 |

Un test jsdom montrerait que le composant existe ; il ne montrerait pas qu'il
**retrouve l'état**. C'est pourquoi la preuve de F-94 est E2E, et pourquoi elle
va jusqu'à **arrêter réellement la lecture depuis l'UI rechargée**.

---

## 8. Fichiers touchés

**Correctif**

- `public/js/features/transport/PlaybackResync.js` *(nouveau)* — la logique de
  décision, sans DOM.
- `public/index.html` — `resyncTransportFromBackend()` + appel à la connexion,
  `updatePlaybackControls()` piloté par le transport, `currentFileName`, le
  pense-bête dans `playFile()` / `playback_status` / `playlist_item_changed`,
  gardes `togglePlayPause` et seek, balise de script.
- `public/js/api/BackendAPIClient.js` — `getPlaybackStatus()`.
- `public/js/features/midi-editor/MidiEditorEvents.js` — délégué F-86 (2 lignes).

**Harnais** *(additif, pas de changement de comportement par défaut)*

- `tests/e2e/lib/app.mjs` — `transportState()` renvoie aussi `playDisabled`,
  `time`, `progressWidth` ; nouveau `clickStop()` (vrai clic).
- `tests/e2e/lib/server.mjs` + `README.md` — `E2E_WORKSPACE` : base, journaux et
  uploads d'un run peuvent vivre hors du dépôt. Défaut inchangé.

**Cliquets mis à jour** — les deux tests comptent exactement les balises
`<script src>` d'`index.html` et documentent que « ajouter un script doit être
une modification consciente de ce test » ; l'invariant protégé (aucune origine
distante) est inchangé :

- `tests/audit/r6-offline-first.test.js` · `tests/audit/l11-offline-first.test.js`
  — 193 → **194** (`features/transport/PlaybackResync.js`, chemin relatif).

**Aucun fichier de `src/` modifié.** `git diff config.json` vide après chaque
run ; aucun serveur laissé en vie.

---

## 9. Non-régression

| Contrôle | Résultat |
|---|---|
| `npm test` (Jest) | **217 suites / 3 034 tests · 0 échec** |
| `npx vitest run` | **91 fichiers / 1 637 tests · 0 échec** (dont les 33 ajoutés ici) |
| `npx eslint src/ public/js/ tests/` | **0 erreur** (203 avertissements, tous préexistants) |
| `npx tsc --noEmit` | **propre** |
| `tests/frontend/l09-a11y-modals.test.js` (cliquet a11y) | vert — R20 n'ajoute aucune modale ni aucun champ |
| E2E complet | 10 PASS / 5 FAIL (avant : 7 / 8) |

Le harnais E2E a tourné sur le **port 8402**, base et journaux sous
`…/scratchpad/R20/workspace` grâce à `E2E_WORKSPACE`, donc hors du dépôt.
