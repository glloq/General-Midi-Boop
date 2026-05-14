# TODO — améliorations non prioritaires

Collection des trous identifiés pendant les audits / sessions de dev,
qui ne bloquent personne mais qui méritent un passage. À piocher quand
on a un créneau.

Convention : chaque entrée a un titre court, un constat (ce qui marche
mal aujourd'hui), et 1-3 options de fix avec leurs trade-offs. Pas de
plan d'implémentation détaillé — la décision et le plan se font au
moment où on attaque l'item.

---

## Banques son des drum kits — vérification CDN et évolutions

**Constat.**  Avant ce fix, `_buildDrumPresetEntry` codait en dur
`FluidR3_GM` pour tous les kits de batterie, quelle que soit la banque
sélectionnée par l'utilisateur.  Le cache drums n'était pas vidé lors
d'un changement de banque.

**Ce qui a été corrigé (branche `claude/fix-drum-kits-soundbank-apqYK`).**

- `MidiSynthesizerConstants.js` : chaque banque porte maintenant un
  tableau `drumKits` `[{midiProgram, bankIndex, verified}]` indiquant
  quels kits GM sont disponibles et à quel index WAF.
- `MidiSynthesizer._buildDrumPresetEntry(suffix, bankIndex, note)` :
  signature étendue pour accepter n'importe quelle banque.
- `MidiSynthesizer._getDrumKitEntry(midiProgram)` : nouveau helper qui
  cherche l'entrée drum de la banque courante.
- `MidiSynthesizer._loadDrumPreset` : chaîne de candidats priorisée —
  banque courante d'abord, FluidR3_GM en repli, kit Standard en second
  repli, JCLive en dernier recours.
- `MidiSynthesizer._applyBankSwitch` : vide `drumPresets` et
  `_drumLoading` à chaque changement de banque.

**Valeurs `bankIndex` à vérifier sur le CDN.**

Seuls FluidR3_GM (tous les kits) et JCLive (bankIndex 12) ont
`verified: true`.  Les banques suivantes sont marquées
`verified: false` avec bankIndex 0 supposé — à confirmer en chargeant
`https://surikov.github.io/webaudiofontdata/sound/12836_0_{suffix}.js`
et en vérifiant que la variable `_drum_36_0_{suffix}` existe :

| Banque          | suffix                    | bankIndex supposé |
|-----------------|---------------------------|-------------------|
| GeneralUserGS   | `GeneralUserGS_sf2_file`  | 0                 |
| Aspirin         | `Aspirin_sf2_file`        | 0                 |
| SBLive          | `SBLive_sf2`              | 0                 |
| Chaos           | `Chaos_sf2_file`          | 0                 |
| SoundBlasterOld | `SoundBlasterOld_sf2`     | 0                 |

Si un bankIndex est incorrect, la tentative échouera silencieusement et
la chaîne de repli passera à FluidR3_GM — comportement safe.  Une fois
confirmé, mettre `verified: true` dans `MidiSynthesizerConstants.js`.

**Évolutions envisagées.**

| # | Idée | Priorité |
|---|------|----------|
| A | ~~Script de vérification automatique~~ | **Livré** — `scripts/verify-drum-banks.js`. `node scripts/verify-drum-banks.js` lit `SOUND_BANKS[*].drumKits`, HEAD chaque URL CDN avec concurrence configurable, imprime un tableau et exit `1` si un kit jadis verified est devenu inaccessible. `--write` met à jour les flags `verified` en place (ne touche QUE les lignes `verified: true|false`, jamais le reste). |
| B | Exposer dans l'UI (modal réglages) un badge « banque utilisée pour les drums » sur chaque kit — utile quand la banque courante ne supporte pas le kit demandé | Basse |
| C | Ajouter les kits de batterie supplémentaires de GeneralUserGS (Room, Jazz…) si confirmés présents sur le CDN — relancer le script avec `--note=38` ou `--note=42` aide à confirmer | Moyenne |
| D | Permettre une banque drums indépendante de la banque melodique (réglage avancé) | Basse |

---

## ~~CC main absents de l'éditeur CC après routage~~ — Résolu

**Option A appliquée.** `PlaybackAssignmentCommands.applyAssignments`
appelle désormais `app.fileManager.bakeAndSave(targetFileId)` en fin de
parcours quand au moins un routing pointe vers un instrument avec
`hands_config`. Le baker (déjà existant : `src/files/MidiBaker.js`)
génère les CCs via `HandPositionPlanner` / `LongitudinalPlanner` et les
écrit dans le blob du fichier — l'éditeur CC les lit donc directement.

Side effects gérés :
- `MidiPlayer._injectHandPositionCCEvents` skip l'injection pour
  chaque destination dont les CCs main sont déjà présents dans la
  timeline (helper `_timelineHasHandCCs`, ignore les events marqués
  `_handInjected` pour ne pas se compter lui-même).
- `MidiBaker._mergeEventsIntoTrack` strip les anciens CCs (mêmes
  `(channel, controllerType)`) avant ré-insertion, donc un re-apply
  remplace plutôt que d'accumuler.

Trade-off documenté de l'option A : les retouches manuelles de la
courbe hand-position dans l'éditeur sont écrasées au prochain
`apply_assignments`.

---

## Mécanisme `independent_fingers` (V2 — doigts humanoïdes)

**Constat.** L'onglet "Main" expose 3 mécanismes pour les instruments à
cordes : `string_sliding_fingers` (V1), `fret_sliding_fingers` (V1) et
`independent_fingers` (V2, grisé). Le V2 vise un système à 4 doigts
indépendants à 2 axes (corde × frette), capable de reproduire des
techniques humaines (barrés, accords arbitraires, hammer-on/pull-off).
Aujourd'hui : la carte est affichée non cliquable dans
`ISMSections._renderMechanismCards`, le validateur rejette
`mechanism === 'independent_fingers'`, et `HandPositionPlanner`
throw `not implemented in V2` si on tente de l'instancier.

**Options.**

| # | Approche | Avantages | Inconvénients |
|---|---|---|---|
| A | Planner monolithique : un seul `IndependentFingersPlanner` qui assigne globalement chaque note à un doigt par optimisation (coût de déplacement + contraintes barrés) | Optimal, gère les barrés en sortie | Coûteux à implémenter, runtime O(n²) sur les passages denses |
| B | Planner glouton : assignation greedy doigt-par-doigt avec heuristique "doigt le plus proche libre" + fallback shift | Simple, rapide, suffit pour 80 % des cas | Loupe les optimisations globales (barrés sub-optimaux) |
| C | Hybride : greedy par défaut + passe d'optimisation locale sur les chords détectés en barrage | Bon compromis | Encore deux passes de logique distinctes à maintenir |

**Recommandation actuelle** : B (greedy) en première itération pour
débloquer le mécanisme côté UI ; itération vers C si les cas-limites
se multiplient en pratique.

**Points d'insertion**

- `src/midi/adaptation/HandPositionPlanner.js` : ajouter un dispatch
  sur `hands_config.mechanism` ; pour `independent_fingers`, déléguer
  à un nouveau module `IndependentFingersPlanner.js` (à créer).
- Modèle de données : étendre `hands_config.hands[0]` avec un tableau
  `fingers: [{ id, max_fret_offset, max_string_offset, ... }]` (à
  spécifier au moment de l'attaque).
- UI : `ISMSections._renderHandsSectionFrets` débloque la carte +
  rend les paramètres des 4 doigts (probable sous-modal ou accordéon).
- CC : un CC par doigt (8 CC : 4 corde + 4 frette) ou un CC composite
  encodé. À trancher au moment de l'attaque selon ce que le firmware
  embarqué accepte.

---

## Points relevés par les audits passés

Issus de l'ancienne section "Known Issues & Improvement Areas" de
`CONTRIBUTING.md`. Items courts, sans analyse approfondie — à traiter à
l'occasion ou à promouvoir en entrée détaillée ci-dessus quand
quelqu'un attaque le sujet.

### Sécurité

- ~~**`MidiMessage.parseObject()` sans whitelist de propriétés**~~ — déjà
  corrigé. `src/midi/messages/MidiMessage.js:134-142` énumère
  explicitement les clés autorisées (`note`, `velocity`, `pressure`,
  `controller`, `value`, `program`, `data`, `song`, `timestamp`, `raw`)
  et ignore le reste.

### MIDI core

- **Somme des poids `ScoringConfig`** : la détection de type d'instrument
  somme à 130 au lieu de 100. Soit normaliser, soit assumer et
  documenter.
- **Wrapping d'octave doublonnant** : plusieurs notes source peuvent
  wrapper sur la même note cible, créant des collisions silencieuses.
  Voir `src/midi/adaptation/MidiTransposer.js`. Telemetry ajoutée :
  `compressChannel().stats.compressionCollisions` compte maintenant le
  nombre de notes cibles avec plusieurs sources — l'UI peut afficher
  un avertissement quand `> 0`. Reste à faire : décider si on remap
  intelligemment vers une note cible libre la plus proche (= éviter la
  collision) ou si l'on garde le comportement actuel et on affiche
  juste le warning.

### Architecture

- ~~**God Object `Application`** : ~10 services utilisent encore
  `this.app`~~ — entièrement résolu. `src/api/CommandRegistry.js` lit
  désormais `this.logger` / `this.eventBus` directement (AUDIT
  2026-05-10 §31) ; `grep -rn "this\.app\." src/` ne renvoie plus rien.
- **Façade `Database`** : ~960 lignes de wrappers passthrough.
  Enregistrer les sous-modules directement dans `ServiceContainer` plutôt
  que de les ré-exporter. Voir AUDIT.md §3.2.
- **Fichiers volumineux** : 11 fichiers backend et 3 frontend dépassent
  700 lignes. Candidats à la découpe par responsabilité. Voir
  AUDIT.md §3.8. Progression : `RoutingSummaryPage.js` est passé de
  3477 → ~2980 lignes (AUDIT 2026-05-10 §32, extraction du mixin
  preview/minimap dans `RoutingSummaryPreviewControls.js`). Reste à
  faire : ISMSections (2213), ISMListeners (1830), MidiPlayer (2061),
  TablatureConverter (1617), HandPositionFeasibility (1682),
  LoopCreatorModal (1944).

### Éditeurs / UI

- ~~**Drum editor** : le sélecteur Quantize n'est pas branché à
  `DrumGridRenderer`~~ — déjà branché.
  `DrumPatternEditor.js:262-271` propage `quantizeDiv` au renderer et
  déclenche `redraw()` ; `DrumGridRenderer.js:434` et `:937` consomment
  effectivement la valeur (subdivisions + snap au clic).
- ~~**Wind editor** : le mode d'édition est figé sur `'pan'`~~ — déjà
  corrigé. `WindInstrumentEditor.js:171-172` expose deux boutons toolbar
  (`pan` / `select`) ; `_setEditMode` propage la valeur au renderer
  (`renderer.tool`) et `WindMelodyRenderer.js:639-693` branche
  effectivement le mousedown : `pan` → scroll, `select` → drag /
  sélection rectangulaire.
- ~~**Tablature editor** : raccourcis `Delete` / `Backspace` et `Ctrl+A`
  manquants~~ — déjà présents.
  `TablatureEditor.js:765-806` couvre Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z,
  Ctrl+C, Ctrl+V, Ctrl+A, Delete/Backspace, ArrowUp/Down.
- ~~**Cohérence raccourcis clavier** : Ctrl+Shift+Z absent ailleurs~~ —
  déjà présent dans Drum (`DrumPatternEditor.js:685-690`), Wind
  (`WindInstrumentEditor.js:694-702`) et Tablature. Un registre commun
  reste un nice-to-have mais n'est plus une régression utilisateur.

### CSS / accessibilité

- **362 `!important`** : factoriser via la cascade et les variables
  plutôt que de surcharger.
- **Variables CSS dispersées** : `:root` redéfini dans 4+ fichiers, ordre
  d'application imprévisible. Centraliser dans un seul fichier de
  tokens.
- ~~**23 `outline: none`** sans alternative de focus visible —
  violation WCAG~~ — résolu par une feuille de style globale
  `public/styles/accessibility-focus.css` chargée en dernier dans
  `public/index.html`. Elle re-établit un focus ring `:focus-visible`
  (outline 2px + box-shadow + variante `prefers-contrast: more`) sur
  tous les éléments interactifs courants, en battant les `outline:none`
  legacy via spécificité + `!important` (un cas où c'est légitime
  parce que l'a11y est non-négociable). Le skip-link existant
  `.sr-only-focusable` redevient visible au focus.

### Performance

- ~~**`MidiRouter`** : itère toutes les routes pour chaque message MIDI~~
  — résolu : `routesBySource` (`Map<source, Set<routeId>>`) ramène le
  dispatch à O(routes-pour-cette-source). Le coût annexe (max-comp
  recompute + DB lookup pour monitor name) a été cachéifié dans
  l'AUDIT 2026-05-10 §10/§11.
<!-- Résolu : la colonne BLOB n'existe plus (les bytes vivent sur disque
     via BlobStore depuis la migration vers les blob_path). `getAllFiles()`
     ne projette désormais que `LIST_COLUMNS`, et le flag `includeData`
     mort a été retiré. -->

- ~~**`FilterManager`** : les timers de debounce ne sont pas annulés au
  démontage du composant~~ — `destroy()` est désormais appelé sur
  `beforeunload` (AUDIT 2026-05-10 §4).

### Infrastructure

- **`DelayCalibrator`** : la regex de parsing ALSA utilise le mot-clé
  français `carte` qui échoue sur un système anglais. Multilinguer
  ou parser la sortie machine plutôt que humaine.
- ~~**Double tracking de migrations**~~ — confirmé résolu. `grep -rn
  "migrations" src/ migrations/*.sql` ne renvoie que `schema_version`
  comme table de tracking ; aucune table `migrations` n'est créée ni
  lue. Le baseline v6.0 (`001_baseline.sql`) a fini la consolidation.
- **Dépendances datées** : Express 4.x (5.x dispo), `better-sqlite3` 9.x
  (12.x dispo). Vérifier les breaking changes avant l'upgrade. Voir
  AUDIT.md §3.13.

---

## Modal piano virtuel — finir la décommission des mixins legacy

**Contexte.** Les phases A → E du refactor du modal piano virtuel sont
livrées (voir `AUDIT_KEYBOARD_MODAL_2026-05-14.md` + commits
`06a1992` → `e5029b8` sur `claude/frontend-architecture-review-8zA9d`) :
- `InstrumentDetector` extrait, testé (22 cas).
- `InstrumentView` interface + `InstrumentViewRegistry` singleton +
  bootstrap `registerBuiltins.js`.
- 5 classes `PianoView`/`FretboardView`/`DrumPadView`/`PianoSliderView`/
  `ListView` enregistrées (strangler-fig : elles délèguent encore aux
  mixins legacy pour le rendu).
- `KeyboardChords._mapChordToStrings` délègue à `VoicingEngine`.
- Helpers `_on/_offAll` ajoutés (opt-in), `_applyMixin` warn collisions.
- 129/129 tests passent.

Quatre items reportés volontairement parce qu'ils nécessitent une
session avec **validation visuelle réelle sur Raspberry Pi**
(impossible sans browser sandbox).

**Items reportés.**

### 1. Suppression complète des 7 mixins (Object.assign)

**Constat.** Tant que les `*View` délèguent à `modal.renderFretboard()` /
`modal.regeneratePianoKeys()` / etc., on ne peut pas retirer les
mixins. Les méthodes vivent toujours sur `KeyboardModal.prototype` via
`_applyMixin`.

**Options.**
- **A** (sûre, lente) — Porter une vue à la fois : la View prend en
  charge son rendu DOM (lit le HTML container, applique les classes),
  puis on retire les méthodes correspondantes du mixin. Suivre l'ordre
  DrumPad (le plus simple, 69 l. à porter) → PianoSlider → List →
  Piano → Fretboard.
- **B** (rapide, risquée) — Réécrire `KeyboardModalController` from
  scratch en se basant uniquement sur les Views, garder l'ancien
  `KeyboardModal` comme fallback derrière un flag `?legacy=1`.

Critère de succès : `grep -nE 'Mixin\.' public/js/features/keyboard/*.js`
ne retourne plus rien, `KeyboardPiano.js` est supprimé, le bouton
"view toggle" passe par `instrumentViews.resolve()` au lieu de
`setViewMode`. Audit findings : KM-C1, KM-C2, KM-C4, KM-E4.

### 2. Externaliser le HTML du `createModal` (180 lignes)

**Constat.** `KeyboardPiano.js:23-212` contient le HTML complet du
modal en template literal avec ~25 `${this.t(…)}` inline. Pas de
coloration syntaxique HTML, pas de lint, edit pénible.

**Options.**
- **A** — Extraire dans `keyboard-modal.template.js` qui exporte une
  fonction `buildKeyboardModalHTML(i18n)` retournant la chaîne.
- **B** — Adopter `htm` (4 KB, tagged template literals) pour les
  fragments réutilisables.
- **C** — Garder en JS mais découper par section (header / minimap /
  wind-panel / canvas-container / sliders).

Critère de succès : `createModal()` < 40 lignes, le HTML lit
directement dans un fichier dédié. Audit finding : KM-E2.

### 3. Split state `config` / `state` / `ui` sur `KeyboardModal`

**Constat.** Le constructeur initialise **~40 propriétés** sur `this.*`
qui mélangent config persistante (octaves, noteLabelFormat,
keyboardLayout), état applicatif (selectedDevice, capabilities,
viewMode, activeNotes) et état éphémère d'interaction (isMouseDown,
_modWheelDragging, _minimapDragging). Le `close()` actuel ne reset
explicitement que 5 d'entre elles → risque d'état stale entre 2
ouvertures.

**Option recommandée.**

```js
this.config = { keyboardLayout, noteLabelFormat, octaves,
                defaultStartNote };      // ← loadSettings()
this.state  = { selectedDevice, capabilities, viewMode,
                activeNotes, velocity, modulation };
this.ui     = { isMouseDown, _modWheelDragging,
                _minimapDragging };      // ← reset à chaque close()
```

Migration progressive : commencer par déplacer 5 propriétés à la fois,
faire passer les tests, recommencer. Audit finding : KM-M2.

### 4. CSS `!important` < 30 dans `keyboard.css`

**Constat.** Après la fusion Phase A, `public/styles/keyboard.css`
contient encore 252 `!important` (héritage de
`keyboard-modal.css` 99 + `keyboard-polish.css` 67 + `keyboard.css`
de base). Cascade brisée, refonte thématique impossible.

**Approche.**

Pour chaque `!important` :
1. Vérifier si on peut augmenter la spécificité du sélecteur parent
   (ex : `.km-modal .km-piano__key--active` au lieu de `.piano-key.active !important`).
2. Sinon, vérifier si on peut introduire une variable CSS qui rend la
   surcharge inutile.
3. En dernier recours, garder `!important` et le documenter en
   commentaire.

Critère de succès : < 30 `!important` totaux, refonte thématique
testable en changeant un seul fichier `variables.css`. Nécessite tests
visuels sur Pi (chaque vue × chaque thème × chaque mode notation).
Audit finding : KM-M1 phase 2.

### Pré-requis pour attaquer ces items

- **Smoke checklist visuelle Pi** documentée :
  1. Ouvrir le modal sur un piano GM 0.
  2. Sélectionner une guitare (GM 24) → vue fretboard, accord majeur.
  3. Sélectionner un kit drum (channel 9) → drumpad.
  4. Sélectionner un sax (GM 65) → piano-slider + wind panel.
  5. Toggle list-view → liste compacte.
  6. Octave up/down + minimap drag + zoom.
  7. Mod wheel + pitch bend.
  8. Fermer + rouvrir 10 fois, observer la heap dans DevTools Memory.

- Tests Vitest existants (`tests/frontend/keyboard/*.test.js`) doivent
  rester verts (129 cas). Si un item nécessite de modifier la signature
  d'un module pur, les tests guident la migration.

---

## MIDI editor — findings d'audit non traités

**Contexte.** L'audit `tu-es-un-expert-wiggly-cocke.md` listait 14 catégories
de findings (§1.1 → §9.x). Sur la branche `claude/dazzling-dijkstra-Es6lw`,
10 catégories sont closes (§1.1 PianoRollRenderer abstraction, §1.3 god-class
split complet, §2.4 cursor RAF coalescing, §2.5 hack isolé,
§3.1+§3.2 CanvasPianoRollRenderer + grid-bucket spatial index opt-in,
§3.3 bit-packing, §5.4 WS reconnect infini, §6.1 BaseLaneEditor,
§6.2 CanvasRenderer, §6.3 RAF coalescing lane editors, §6.4 PlaybackSync hub,
§6.5 MidiEditorTablature split, §7.1 AbortController, §7.2 resize throttling).

Les findings ci-dessous **restent ouverts** parce qu'ils nécessitent soit un
effort >2 semaines (changement de modèle de données), soit du test runtime
browser que les sessions Claude Code n'ont pas pu effectuer.

### §1.2 — `MidiProjectStore` + `MidiSequenceIndex`

**Constat.** Le `MidiEditorModal` (623 l.) reste un point d'agrégation pour
14 sous-modules qui accèdent tous directement à ~150 propriétés partagées.
Chaque listener `change` du piano roll déclenche `syncFullSequenceFromPianoRoll`
qui re-trie la séquence complète en O(n log n) sur chaque édition (debounce
100 ms seulement). Sur 10 000 notes, latence cumulée non négligeable.

**Options de fix.**

1. **Store immuable + événements typés** : `MidiProjectStore` qui possède la
   séquence canonique (immutable), expose des actions typées
   (`addNote`, `moveNotes`, `deleteNotes`, `changeChannel`…), émet des
   événements typés que les sous-modules consomment. Les sous-modules
   deviennent purement réactifs.
   - **+** Testabilité unitaire complète du store (pas de DOM).
   - **+** Suppression du couplage rétro entre modules (toolbar / playback /
     tablature ne se "voient" plus).
   - **−** Toutes les mutations actuelles `this.modal.X = Y` doivent passer
     par `store.dispatch(...)`. Migration mécanique mais touche ~50 fichiers.

2. **Segment tree / interval tree sur les ticks** : `MidiSequenceIndex` qui
   indexe les notes par range `[tick, tick+gate]`. Requêtes O(log n + k)
   pour "notes intersectant `[t0, t1]`" — utile pour viewport culling,
   collision detection à l'édition, scheduling lookahead playback.
   - **+** Hit-tests, drag-select, paste-conflict en O(log n) au lieu de O(n).
   - **+** Édition d'orchestre 10k+ notes devient fluide.
   - **−** Maintenance de l'index à chaque mutation (insert / delete / move).
     Coût amorti faible mais ~150 LOC d'invariants à tester.

3. **Hybride** : store immuable mais indexe seulement à la demande. Cache
   d'index reconstruit paresseusement quand un consumer fait une requête
   range.
   - **+** Évite la complexité d'invariants tant qu'aucun consumer ne
     demande de range query.
   - **−** Premier hit cher (rebuild complet).

**Recommandation.** Option 1 d'abord (store), option 2 en deuxième temps
quand on aura besoin des range queries (typiquement après §3.1 Phase C
quand le V2 Canvas renderer sera default et fera viewport culling).

**Effort estimé.** 3-4 semaines pour option 1 seule, +1 semaine pour ajouter
l'index. À planifier comme un sprint dédié, pas en bord d'autre tâche.

---

### §4.1 — Filtre canaux invisibles dans le rendu

**Constat.** `modal.sequence` est filtré par `activeChannels` (les canaux
visibles dans le piano roll) — déjà OK. Mais le `channelDisabled` (mute
synth) n'a aucun effet sur le rendu : un canal muet reste visible et
plein-couleur dans le piano roll.

**Question UX préalable.** Le canal mute doit être :

1. **Invisible** (caché complètement) — cohérent avec mute = "pas de son ET
   pas dans la vue", mais l'utilisateur perd le repère visuel.
2. **Ghost** (rendu translucide / gris) — repère visuel conservé, comportement
   habituel des DAW pro (Ableton, Logic, Reaper).
3. **Inchangé** (comportement actuel) — mute n'affecte que l'audio.

**Effort estimé.** Trivial (1 j) une fois la décision prise. Le filtre ou la
modulation de l'opacité passent par `PianoRollRenderer.setChannelColors` /
`setChannelOpacity` (à ajouter à l'API). Ne pas implémenter sans avoir validé
le choix UX en browser.

---

### §4.2 — `ChannelState` centralisé (Phase 1 partielle ✅, write-phase pending)

**État.** Phase 1 (read facade) en cours — `MidiEditorChannelState`
exposé via `modal.channelState`. Pour l'instant 2 consumers migrés en
démo (`MidiEditorPlayback.syncMutedChannels` + `.loadSequenceForPlayback`).
Les ~80 autres reads dispersés (activeChannels.has, channelDisabled.has,
channelColors, channelRouting, etc.) peuvent migrer lazilly, méthode par
méthode, vers `channelState.X(...)`. Les writes restent sur `modal.X`
direct (pas de regression possible). Phase 2 routera les writes via le
facade et émettra `channel:changed`.

**Constat initial.** Couleurs, mute, solo, instrument routing, transposition,
playable-notes highlights — répliqués sur 5 modules (`MidiEditorModal`,
`MidiEditorChannelPanel`, `MidiEditorRouting` via `routingOps`,
`MidiEditorTablature` via `tablatureOps`, `MidiEditorPlayback`). Synchronisation
manuelle via `routingOps.updateChannelButtons()`,
`tablatureOps._updateChipRouting(channel)`, etc. Les bugs de désync sont
courants (audit `AUDIT_FRONTEND_2026-05-14.md` §3.2).

**Options de fix.**

1. **Store dédié `ChannelState`** : module avec API `getChannel(idx)`,
   `setRouting(idx, value)`, `setDisabled(idx, bool)`, `setHighlight(idx, set)`,
   etc. Émet `channel:changed` quand un canal mute. Tous les sous-modules
   s'y abonnent et purgent leurs copies locales.
   - **+** Élimine ~10 bugs latents de désync.
   - **−** Refactor cascading sur les 5 modules cités. Sans browser test,
     risque élevé de régression UX.

2. **Getters / setters sur le modal** : laisser l'état sur `modal` mais
   exposer des getters réactifs qui notifient via le `eventBus` existant.
   Moins disruptif que l'option 1.
   - **+** Migration progressive (un module à la fois).
   - **−** Le modal reste le god-state object.

**Recommandation.** Combiner avec §1.2 (le store général est l'endroit
naturel pour `ChannelState`). Ne pas faire les deux séparément.

**Effort estimé.** 1-2 semaines comme partie de §1.2, ou 1 semaine
standalone (option 2). À ne PAS attaquer sans browser test possible —
les sync-bugs apparaissent surtout sur des combinaisons d'actions
(switch tab, change routing, mute then route, etc.) impossibles à
couvrir en lecture statique de code.

---

### Phase C piano roll — bascule V2 par défaut + dépréciation lib tierce

**Constat.** `CanvasPianoRollRenderer` (1059 l., audit §3.1+§3.2) est
opérationnel mais opt-in via `?pianoRollV2=1` ou
`localStorage.gmboop_piano_roll_v2 = '1'`. La lib tierce
`webaudio-pianoroll-custom.js` (2207 LOC, non maintenue) reste le défaut.

**Plan de bascule (extrait du plan d'audit, recopié pour traçabilité).**

1. **Setting `usePianoRollV2`** dans `SettingsModal` (localStorage,
   default `false` — déjà géré par le flag actuel).
2. **Période bêta opt-in** : annonce dans CHANGELOG / Discord, demander
   aux power users de tester. Critère go/no-go : 0 régression bloquante
   signalée sur 2 semaines.
3. **Bascule du default → V2** : passer `default=true` dans le settings.
   La V1 reste accessible via setting "Use legacy piano roll" pour
   recovery.
4. **Cycle de release + hotfix** : 1 release patch dédiée à la V2-default,
   monitoring serré des erreurs côté Pi.
5. **Suppression** :
   - `public/lib/webaudio-pianoroll-custom.js` (−2 207 LOC)
   - `WebaudioPianorollAdapter` dans `public/js/features/piano-roll/PianoRollRenderer.js`
   - L'invariant `this.modal.pianoRoll === renderer.getElement()` (plus
     besoin une fois la lib retirée).
   - `MidiEditorViewport.scheduleRedraw` (le hack §2.5 disparaît).
   - Le hack double-call `setTimeout(32)` dans `MidiEditorResize.attachHandler`.

**Pré-requis.** Browser test obligatoire — pas faisable en session
Claude Code sans accès Chromium. La V2 a déjà été testée syntactiquement
mais aucune session humaine ne l'a exercée en édition réelle. Risques
identifiés : édition multi-channel, copy/paste avec offset, drag-move
batch, undo/redo profond, sélection rect sur dense sequence.

**Effort.** 1 j cumulé de travail Claude (cleanup post-bascule) + 2
semaines de bêta + 1 release. À planifier après une session de QA
browser dédiée.

---

### ~~Bug préexistant — `fileChannels` undefined dans `MidiEditorLaneEditors`~~ ✅ corrigé

**État.** Fixé — `let fileChannels = [];` hissé au-dessus du `if` dans
`MidiEditorLaneEditors.js:initCCEditor` (commit suivant cette section).
Le log final ne ReferenceError plus quand exactement un canal est actif.

---

### Pré-requis pour attaquer ces items MIDI editor

- **Accès navigateur Chromium** pour QA runtime — sinon §1.2, §4.x et
  Phase C ne peuvent pas être validés sans risque de régression.
- **Suite de tests e2e** (Playwright ou équivalent) couvrant les scénarios :
  ouvrir un MIDI 10k+ notes, drag-select 500 notes, change channel,
  paste, undo/redo, scrub timeline pendant playback, ouvrir/fermer
  modal 50× (memory leak).
- **Profile baseline** (Chrome DevTools Performance) sur un projet réel
  avant chaque optimisation pour mesurer le gain.
- **Build pipeline** capable de basculer la default V2 via setting
  exposé en UI (vs. flag dev actuel).

---
