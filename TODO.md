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
| A | Script de vérification automatique (`scripts/verify-drum-banks.js`) qui HEAD chaque URL CDN et met à jour `verified` dans les constantes | Basse |
| B | Exposer dans l'UI (modal réglages) un badge « banque utilisée pour les drums » sur chaque kit — utile quand la banque courante ne supporte pas le kit demandé | Basse |
| C | Ajouter les kits de batterie supplémentaires de GeneralUserGS (Room, Jazz…) si confirmés présents sur le CDN | Moyenne |
| D | Permettre une banque drums indépendante de la banque melodique (réglage avancé) | Basse |

---

## CC main absents de l'éditeur CC après routage

**Constat.** Les events `controller` pour les CC main
(`CC22` cordes, `CC23/CC24` claviers) sont calculés par
`HandPositionPlanner.js:404` mais ne sont injectés que par
`MidiPlayer._injectHandPositionCCEvents` (`src/midi/playback/MidiPlayer.js:440-608`)
**en mémoire au moment de la lecture** (flag `_handInjected`, effacés
après). `PlaybackAssignmentCommands.applyAssignments`
(`src/api/commands/PlaybackAssignmentCommands.js:120-342`) injecte CC7
(volume) mais **pas les CC main** dans `adaptedMidiData` avant le
`jsonToMidi` (ligne ~262). L'éditeur (`MidiEditorCC.js:151-250`) lit
toutes les CC du fichier, mais le fichier n'en contient aucune côté
mains → rien à afficher.

**Options.**

| # | Approche | Avantages | Inconvénients |
|---|---|---|---|
| A | Cuire les CC main dans `adaptedMidiData` à l'apply | Fichier autonome, éditeur les voit, modifiables | Retouches manuelles écrasées au prochain re-apply |
| B | Overlay calculé dans l'éditeur depuis la config de routage | Non destructif, toujours synchro avec le routing | Lecture seule (pas d'édition directe de la courbe) |
| C | Hybride : A à la première apply + marker `auto-generated` ; ne regénère pas si déjà présent | Visibles ET éditables | Plus complexe, demande la sémantique du marker |

**Recommandation actuelle** : A. L'éditeur devient point unique de
vérité ; un re-apply explicite régénère les CC.

**Points d'insertion**

- `src/api/commands/PlaybackAssignmentCommands.js` ~ligne 254 (juste
  après l'injection CC7) : appeler `HandPositionPlanner` par canal
  routé et pousser les events dans `adaptedMidiData.tracks[0].events`
  avant la conversion `jsonToMidi`.
- Refléter la logique existante de `MidiPlayer.js:440-491` mais cibler
  la structure du fichier au lieu de la timeline live.
- Une fois injectés, faire en sorte que `MidiPlayer` détecte les CC
  déjà présents et n'injecte pas en double pendant la lecture
  (sinon double envoi au robot).

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
- **23 `outline: none`** sans alternative de focus visible — violation
  WCAG. Toujours fournir un focus alternatif (border, box-shadow…).

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
