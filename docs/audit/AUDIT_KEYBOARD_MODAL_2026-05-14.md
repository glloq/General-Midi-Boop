# Audit ciblé — Modal Piano Virtuel & types d'affichages
**Date** : 2026-05-14
**Branche** : `claude/frontend-architecture-review-8zA9d`
**Périmètre exclusif** :
- `public/js/features/KeyboardModal.js` (1 164 l.)
- `public/js/features/keyboard/*.js` (11 fichiers, 6 340 l.)
- `public/styles/keyboard*.css` (4 fichiers, 4 375 l.)
- Référence à `public/index.html` uniquement pour le mini-piano
  d'instrument settings (`#pianoKeyboardMini`).
- **Hors périmètre** : `LoopCreatorModal`, `RoutingSummaryPage`,
  reste du frontend.

Cet audit complète et **affine** `AUDIT_FRONTEND_2026-05-14.md`
findings C4 / E4 / E7 / E9 / M1 ciblés sur ce module précis.
Objectif : préparer la refonte qui permettra d'ajouter facilement
d'autres types d'affichage instrument-spécifiques (accordéon, harpe,
xylophone-mailloches, harmonica, etc.) sans dupliquer le code des
5 vues existantes.

---

## Synthèse exécutive

**Le modal piano virtuel est aujourd'hui un monolithe à 7 mixins** —
toute la logique des 5 vues (piano, piano-slider, fretboard, drumpad,
keyboard-list) vit dans un même objet (`KeyboardModalNew.prototype`).
L'extraction en mixins (`KeyboardPianoMixin`, etc.) est **purement
mécanique** : 4 fichiers portent en en-tête `// Auto-extracted from
KeyboardModal.js`, et l'ordre d'attache via `Object.assign` est
critique (workaround `_windOrigPlayNote` au cas où `playNote` est
écrasé). Aucune abstraction n'existe pour « une vue d'instrument » ;
chaque ajout d'un nouveau mode nécessite de toucher au minimum 4
fichiers (`KeyboardModal.js`, `KeyboardPiano.js`, `KeyboardEvents.js`,
`KeyboardControls.js`) et le HTML hardcodé dans `createModal()`.

**Trois conséquences directes** :

1. **Adding a new instrument view** = patch transversal coûteux (≈ 1
   jour pour un cas simple, ≥ 3 jours si interactions complexes).
2. **Tests unitaires impossibles** pour le modal global ; seuls
   `NoteEngine` et `VoicingEngine` (modules purs, 367 l. cumulés) sont
   testables — et ne sont **pas testés** aujourd'hui.
3. **Détection d'instrument fragile** : `getInstrumentViewInfo()`
   (`KeyboardModal.js:698-752`) encode en dur les plages GM et 6
   alias pour « drum » (`drum`/`drums`/`drumkit`/`drum_kit`/
   `percussion`/`percussive`). Un nouvel instrument requiert
   d'augmenter ce switch.

**Top 5 priorités** :

| # | Finding | Effort | Gain |
|---|---|---|---|
| KM-C1 | Remplacer la cascade `setViewMode` par un registre `InstrumentView` | 1 j | Ajout vue = 1 fichier |
| KM-C2 | Découper `KeyboardPiano.js` (2 052 l.) par vue | 2 j | Lisibilité, tests |
| KM-C3 | Extraire un service `InstrumentDetector` | 0,5 j | Détection testable |
| KM-E1 | Renommer `KeyboardModalNew` → `KeyboardModal` (legacy smell) | 0,5 h | Clarté |
| KM-E2 | Externaliser le template HTML de `createModal` | 0,5 j | Maintenance |

**Plan d'extensibilité** détaillé en section dédiée plus bas.

---

## Carte du module

```
public/js/features/KeyboardModal.js              [1 164 l.]  class KeyboardModalNew (orchestrateur)
public/js/features/keyboard/
├── KeyboardPiano.js                             [2 052 l.]  Mixin : piano + drumpad + fretboard + slider + minimap + hand overlay
├── KeyboardChords.js                            [1 662 l.]  Mixin : chord buttons + strum + bow (fretboard only)
├── KeyboardControls.js                          [  541 l.]  Mixin : velocity / mod wheel / pitch bend sliders
├── KeyboardEvents.js                            [  456 l.]  Mixin : attach/detach DOM listeners
├── KeyboardSlider.js                            [  418 l.]  Mixin : "Root control" + string slide (fretboard pitch-bend)
├── KeyboardListView.js                          [  302 l.]  Mixin : vue liste compacte (velocity Y / pitch-bend X)
├── KeyboardWind.js                              [  206 l.]  Mixin : panneau articulation pour instruments à vent
├── NoteEngine.js                                [  166 l.]  Module pur (gammes, mapping note/pixel)
├── VoicingEngine.js                             [  201 l.]  Module pur (chord → strings)
└── NoteSlider.js                                [  336 l.]  UI widget réutilisable (slider note + velocity)

public/styles/
├── keyboard-modal.css                           [3 092 l.]  Modal lui-même (99 !important)
├── keyboard-polish.css                          [  734 l.]  Surcouche
├── keyboard.css                                 [  339 l.]  Base / mini-piano partagé ?
└── keyboard-hand-position-editor.css            [  210 l.]  Probablement hors modal (handposition editor)
```

**View modes** (chaîne d'identifiants utilisés dans `this.viewMode`) :
- `'piano'` (défaut)
- `'piano-slider'` (instruments à vent — touches égales + pitch-bend)
- `'fretboard'` (instruments à cordes : guitare, basse, violon, sitar…)
- `'drumpad'` (batterie GM channel 9 ou type drum)
- `'keyboard-list'` (vue liste compacte avec glow chromatique)

**Détection d'instrument** : `getInstrumentViewInfo()` retourne
`{ canFretboard, isBowed, isDrum, isWind, windPreset, instrumentType,
instrumentSubtype, gmProgram }`. Le toggle de vue passe ensuite par
des règles hardcodées dans `KeyboardEvents.js:197-204`.

---

# Findings — Architecture & dette

## KM-C1 — Cascade `setViewMode` non extensible (registre absent)

### Problème détecté
`KeyboardPiano.js:450-540` (`setViewMode`) gère 5 modes via une
cascade de :
- 1 `validModes` array hardcodé,
- 5 cleanups conditionnels (`if (this.viewMode === 'fretboard' …)`),
- 6 toggles de container DOM (`.classList.toggle('hidden', mode !==
  '…')`),
- 4 toggles de groupes toolbar,
- 1 switch pour l'emoji du bouton (`'🎸' / '🥁' / '🎹'`),
- 2 toggles d'état "active" sur boutons.

Tout ajout d'un nouveau mode oblige à toucher ces 5+ blocs + créer un
container `#xxx-container` + ajouter un cleanup + ajouter l'emoji.

### Gravité
**Critique** — Bloque le besoin explicite "prévoir ajout autres
instruments spécifiques".

### Fichier(s) concerné(s)
- `public/js/features/keyboard/KeyboardPiano.js:450-540`.
- `public/js/features/keyboard/KeyboardEvents.js:197-204` (toggle
  hardcodé `info.isDrum / info.canFretboard / sinon piano`).
- `public/js/features/KeyboardModal.js:1022-1043` (`_selectInstrumentOption`
  qui dispatch vers chaque mode).
- HTML : `KeyboardPiano.js:190-196` (containers fixes).

### Cause profonde
Pattern impératif (cascade conditions) au lieu de
**polymorphisme / registre**. Aucune interface commune entre les
vues.

### Impact réel
- Ajouter une vue accordéon = patch dans 4 fichiers + HTML.
- Aucun moyen de désactiver dynamiquement une vue (ex : drumpad
  unsupporté sur petit écran).
- Tests unitaires impossibles : on ne peut pas instancier "une vue"
  sans tout le modal.

### Impact CPU/RAM
- Indirect : tous les containers existent en DOM dès l'ouverture du
  modal, même si une vue n'est jamais utilisée pour la session
  (négligeable, mais waste).

### Impact UX
Aucun direct, mais bloque les évolutions.

### Solution recommandée
Voir **section "Plan d'extensibilité"** plus bas : introduire
`InstrumentView` interface + registre.

### Difficulté implémentation
**Élevée** — 1 jour pour le squelette de l'interface + 4 j pour
migrer chaque vue existante.

### Gain attendu
- Ajout d'une nouvelle vue = 1 fichier (`MyInstrumentView.js`) + 1
  appel `registry.register(…)`.
- Tests unitaires vue par vue.

---

## KM-C2 — `KeyboardPiano.js` (2 052 l.) mélange 4 vues + overlays

### Problème détecté
Le mixin "Piano" porte en réalité :
- `createModal()` (HTML complet du modal — 180 l.),
- `generatePianoKeys()` (rendu DIV piano),
- `renderMinimap()`, `renderOctaveBar()`,
- `setViewMode()` (cascade orchestration, cf. KM-C1),
- `renderFretboard()` (180 l. de rendu fretboard string instr.),
- `_buildFretCell()`, `_updateFretboardStringColors()`,
- `_positionSlideZones()`, `_updateSlideFingerPositions()`,
- `_getDrumSvgPath()`, `_getDrumName()`, `_getDrumCategory()`,
- `renderDrumPad()` (69 l. drumpad),
- `generatePianoSlider()` (77 l. piano-slider),
- Système complet d'overlay « hand fingers » (`_mountFingersOverlay`,
  `_cleanFingersCanvas`, `_pianoHandCoversNote`, drag, arrows…) qui
  occupe lignes 1 357-2 052 = **695 lignes**.

Soit 4 vues + 1 overlay + le HTML du modal entier sous un seul
fichier nommé "Piano".

### Gravité
**Critique** — Le nom est trompeur, la cohésion est nulle.

### Fichier(s) concerné(s)
- `public/js/features/keyboard/KeyboardPiano.js`.

### Cause profonde
Extraction mécanique depuis l'ancien `KeyboardModal.js` (header :
"Auto-extracted from KeyboardModal.js"). L'auteur a coupé le fichier
en morceaux mais conservé l'orchestration globale dans
`KeyboardPiano`.

### Impact réel
- Reviews PR difficiles.
- Bug `REPRISE_PIANO_HANDS_BUG.md` ("mains piano qui se baladent
  avec la vue") probablement coincé dans le sous-système overlay.
- Modifier le drumpad force à parser 1 030 lignes avant la fonction
  cible.

### Impact CPU/RAM
- Indirect : la classe charge des méthodes inutilisées pour chaque
  vue (ex : un utilisateur drumpad charge `_pianoHandCoversNote`).

### Impact UX
Aucun direct.

### Solution recommandée
Découpe **fonctionnelle** alignée sur le futur registre
`InstrumentView` :
1. `views/PianoView.js` (≤ 700 l.) — `createKeys`, `regenerate`,
   `renderMinimap`, `renderOctaveBar`.
2. `views/FretboardView.js` (≤ 700 l.) — `renderFretboard`,
   `_buildFretCell`, `_updateFretboardStringColors`,
   `_positionSlideZones`, `_updateSlideFingerPositions`.
3. `views/DrumPadView.js` (≤ 400 l.) — `renderDrumPad`,
   `_getDrumSvgPath`, `_getDrumName`, `_getDrumCategory`.
4. `views/PianoSliderView.js` (≤ 300 l.) — `generatePianoSlider`.
5. `overlays/HandsOverlay.js` (≤ 700 l.) — tout le code overlay
   fingers, indépendant de la vue.
6. `views/createModalTemplate.js` (≤ 300 l.) — extraction du HTML.

### Difficulté implémentation
**Élevée** — 2-3 jours/dev.

### Gain attendu
- 1 fichier par vue, < 700 l., lisible.
- Tests possibles par vue.
- `KeyboardPiano.js` disparaît au profit de vues nommées
  correctement.

---

## KM-C3 — `getInstrumentViewInfo` : détection hardcodée non testable

### Problème détecté
`KeyboardModal.js:698-752` (`getInstrumentViewInfo()`) encode en dur :
- 6 alias pour les types drum (`drum`, `drums`, `drumkit`, `drum_kit`,
  `percussion`, `percussive`) — symptôme d'une normalisation manquante
  côté backend.
- Plages GM string instruments (24-47, 104, 105, 106, 107, 110).
- Plage drum (program ≥ 128 ou channel 9).
- Set bowedGm (40, 41, 42, 43, 44, 45, 110).
- Dépendance globale `window.WindInstrumentDatabase`.

Toute la logique est inline dans une méthode de 54 lignes. Aucune
extraction, aucun test.

### Gravité
**Critique** — Toute évolution (nouvel instrument, nouveau type) doit
modifier ce switch.

### Fichier(s) concerné(s)
- `public/js/features/KeyboardModal.js:698-752`.
- Consommateurs : `KeyboardEvents.js:130-204`, `KeyboardSlider.js:25`,
  `KeyboardWind.js:166`, `KeyboardPiano.js:548-555`.

### Cause profonde
Accumulation de cas particuliers ; pas de notion de "policy"
explicite ; pas de test pour valider que `drum_kit` est bien traité
comme `drum`.

### Impact réel
- Ajouter un instrument-type "mallet" (xylophone, vibraphone) =
  modification de cette méthode (et donc régression possible sur
  drum/string/wind).
- Les 6 alias drum suggèrent que la même information vient de 6
  sources backend qui ne se sont jamais alignées.

### Impact CPU/RAM
- Appelée à chaque sélection d'instrument, plusieurs fois par
  ouverture (sliders, controls, view switch). Négligeable mais
  inutile (résultat pourrait être cachable).

### Impact UX
Détection incohérente peut afficher la mauvaise vue (rare mais
observé).

### Solution recommandée
1. **Côté backend** : normaliser `instrument_type` à un set fermé
   (`'piano' | 'string' | 'wind' | 'drum' | 'mallet' | 'free_reed' |
   'voice' | 'synth' | 'fx'`) — migration capability schema.
2. **Côté frontend** : extraire `instrument-views/InstrumentDetector.js`
   pur, testable :
   ```js
   class InstrumentDetector {
     constructor(rules) { this._rules = rules; }
     detect(caps) { /* … */ return { viewKind, options }; }
   }
   ```
   Rules définies en data plutôt qu'en code :
   ```js
   const RULES = [
     { match: caps => caps.channel === 9, viewKind: 'drumpad' },
     { match: caps => DRUM_TYPES.has(caps.instrument_type), viewKind: 'drumpad' },
     { match: caps => caps.gm_program >= 24 && caps.gm_program <= 47, viewKind: 'fretboard' },
     { match: caps => WIND_GM_RANGE.has(caps.gm_program), viewKind: 'piano-slider', options: { wind: true } },
     // catch-all
     { match: () => true, viewKind: 'piano' }
   ];
   ```
3. Tests unitaires Vitest sur 30+ cas (un par GM family).

### Difficulté implémentation
**Moyenne** — 0,5 j pour l'extraction + tests, 1 j si on touche au
backend.

### Gain attendu
- Détection lisible, testable.
- Ajout d'un nouveau viewKind = 1 ligne dans `RULES`.

---

## KM-C4 — Mixin pattern `Object.assign(prototype)` fragile

### Problème détecté
`KeyboardModal.js:1133-1166` attache 7 mixins sur le prototype de
`KeyboardModalNew`. Le système :
- Dépend de **l'ordre des `<script>`** dans `index.html` (lignes
  6097-6107).
- A nécessité un workaround spécial pour `KeyboardWindMixin.playNote`
  qui doit envelopper la `playNote` précédente (capture en closure
  avec `Object.defineProperty(_windOrigPlayNote, writable: false)`).
- Aucune protection contre une collision de noms entre deux mixins
  (Object.assign écrase silencieusement).
- Aucune introspection : un dev ne sait pas quel mixin fournit
  quelle méthode sans `grep`.

### Gravité
**Élevée** — Fragilité architecturale, traps cachés.

### Fichier(s) concerné(s)
- `public/js/features/KeyboardModal.js:1133-1166`.
- Tous les mixins.

### Cause profonde
Solution rapide pour découper un god-class sans toucher à
l'architecture. Pas de système de composition propre (delegation,
sub-modules, classes composées).

### Impact réel
- Bug surface : une méthode redéfinie écrase silencieusement.
- Onboarding lent : un dev ne trouve pas où `playNote` est définie
  (au moins 2 endroits possibles).

### Impact CPU/RAM
- Au boot : 7 `Object.assign()` copient les propriétés vers le
  prototype. Négligeable.

### Impact UX
Aucun direct ; risque indirect via bugs introduits.

### Solution recommandée
Remplacer par **composition explicite** plutôt qu'héritage par
copie :
```js
class KeyboardModal {
  constructor(deps) {
    this.deps = deps;
    this.state = new KeyboardState();
    this.view = null;  // assigned by ViewRouter
    this.controls = new ControlsPanel(this);
    this.events = new EventsBinder(this);
  }
  setView(viewInstance) { … }
  playNote(midi, velocity, opts) {
    // chain via this.view.willPlayNote(midi, velocity, opts)
    if (this.view?.willPlayNote) {
      const transformed = this.view.willPlayNote(midi, velocity, opts);
      if (transformed === false) return; // view cancelled
      ({ midi, velocity, opts } = transformed ?? { midi, velocity, opts });
    }
    this.deps.backend.playNote(midi, velocity, opts);
  }
}
```
La logique articulation Wind devient un `willPlayNote(midi, vel, opts)
=> { midi, vel: vel * articulation.factor, opts }` dans
`WindView.willPlayNote`. Plus de `_windOrigPlayNote` à protéger.

### Difficulté implémentation
**Élevée** — couplée à KM-C1 (rebuild architecture).

### Gain attendu
- Pattern clair, introspectable.
- Plus de workaround `defineProperty`.

---

## KM-E1 — `KeyboardModalNew` : nom suspect, suggère un legacy oublié

### Problème détecté
La classe s'appelle `KeyboardModalNew` (`KeyboardModal.js:6`). Cela
sous-entend qu'une version "ancienne" existait (peut-être canvas
based) et a été remplacée par une version DIV-based (cf. en-tête :
"DIV-based keyboard (no Canvas)"). `grep -rn KeyboardModalOld` ne
retourne rien — l'ancienne version est donc supprimée mais le suffixe
"New" persiste.

### Gravité
**Élevée** — Smell architectural, mauvaise pratique de nommage,
ralentit l'onboarding.

### Fichier(s) concerné(s)
- `public/js/features/KeyboardModal.js:6`.
- Toutes les références `KeyboardModalNew` dans le projet (le tag
  `prototype.KeyboardModalNew` apparaît dans les mixins).

### Cause profonde
Renommage incomplet après migration canvas → DIV.

### Impact réel
- Confusion : un dev nouveau cherche `KeyboardModal` et trouve une
  classe nommée différemment.

### Impact CPU/RAM
Aucun.

### Impact UX
Aucun.

### Solution recommandée
1. `git mv` impossible (c'est une classe), donc renommer via search &
   replace : `KeyboardModalNew` → `KeyboardModal` partout (modal,
   mixins, instanciation dans `index.html`).
2. Vérifier tests, lints.

### Difficulté implémentation
**Triviale** — 30 min.

### Gain attendu
- Nom cohérent.
- Sera de toute façon nécessaire si KM-C1/C2 sont appliqués.

---

## KM-E2 — HTML du modal hardcodé dans `createModal()` (180 lignes)

### Problème détecté
`KeyboardPiano.js:23-212` contient le HTML complet du modal en
template literal : 180 lignes de markup mêlées avec `${this.t(…)}`
inline pour i18n. Tous les containers fixes (`#piano-container`,
`#fretboard-container`, `#drumpad-container`,
`#keyboard-list-container`, `#piano-slider-container`,
`#km-hand-band`) sont pré-créés systématiquement, même pour une
session qui n'utilisera qu'une seule vue.

### Gravité
**Élevée** — Maintenance HTML difficile (pas de coloration syntaxique
correcte, pas de lint HTML).

### Fichier(s) concerné(s)
- `public/js/features/keyboard/KeyboardPiano.js:23-212`.

### Cause profonde
Pattern courant en vanilla JS sans framework. Acceptable au début,
devient pénible passé 100 lignes.

### Impact réel
- Tout changement de structure DOM nécessite de l'éditer en JS.
- i18n inlinée à 25+ endroits, difficile à scanner.
- Containers superflus en DOM (cf. KM-C1).

### Impact CPU/RAM
- Léger gaspillage DOM (6 containers même si 1 utilisé).
- Parse du template literal au boot (négligeable).

### Impact UX
Aucun direct.

### Solution recommandée
1. Extraire le HTML dans un fichier `keyboard-modal.template.html` ou
   un module pur `KeyboardModalTemplate.js` qui exporte une string
   (avec `${…}` placeholders remplacés par un mini-templater
   maison).
2. Lazy-mount des containers : ne créer `#fretboard-container` qu'à
   l'activation de `fretboard` (pattern à coupler avec KM-C1).
3. À très long terme : si on adopte `lit-html` (4 KB) ou `htm` pour
   les fragments, on gagne en lisibilité + DOM diffing.

### Difficulté implémentation
**Moyenne** — 4-6 h.

### Gain attendu
- HTML lisible, diff-friendly.
- Lazy-mount = ~30 % de noeuds DOM en moins selon la session.

---

## KM-E3 — Doublon mini-piano : `index.html#pianoKeyboardMini` vs modal

### Problème détecté
`public/index.html:11043` contient un **autre rendu de piano** :
```html
<div class="piano-keyboard-mini" id="pianoKeyboardMini"></div>
```
utilisé dans le modal "Réglages d'instrument" pour la sélection de
plage de notes (`pianoNavLeft`/`pianoNavRight`/`pianoRangeDisplay`).
Aucun partage de code avec le modal piano virtuel : tout est
reconstruit ailleurs (`grep -rn "piano-keyboard-mini" public/` →
`index.html` + CSS dans `keyboard.css`).

### Gravité
**Élevée** — Duplication de logique de rendu piano.

### Fichier(s) concerné(s)
- `public/index.html:11043` (HTML host).
- `public/styles/keyboard.css` (styles de `.piano-keyboard-mini`).
- Code de rendu probablement inline dans `<script>` de `index.html`
  (fonctions `navigatePiano`, `clearPianoRange`, etc.) — à confirmer
  par `grep -n "pianoKeyboardMini\|navigatePiano" public/index.html`.

### Cause profonde
Mini-piano créé avant que le modal soit modularisé, jamais consolidé.

### Impact réel
- Deux rendus piano à maintenir → divergence visuelle.
- Bug fix dans le modal piano ne profite pas au mini-piano.

### Impact CPU/RAM
Faible mais code dupliqué.

### Impact UX
Inconsistance visuelle entre les deux pianos.

### Solution recommandée
1. Identifier le code de rendu mini-piano (inline `index.html`).
2. Extraire un composant `PianoRenderer` partagé :
   ```js
   class PianoRenderer {
     constructor(container, { startNote, noteCount, onKeyDown, onKeyUp,
       showLabels, mode = 'play' | 'range-select' }) { … }
   }
   ```
3. Modal piano virtuel + mini-piano utilisent tous deux ce composant.

### Difficulté implémentation
**Moyenne** — 1 j.

### Gain attendu
- 1 seul rendu piano à maintenir.
- Modes "play" vs "range-select" via flag, pas via duplication.

---

## KM-E4 — Mixins "auto-extracted" : extraction mécanique non aboutie

### Problème détecté
4 fichiers portent en en-tête `// Auto-extracted from KeyboardModal.js` :
- `KeyboardEvents.js`
- `KeyboardControls.js`
- `KeyboardPiano.js`
- (et historiquement les autres)

L'extraction n'a pas redéfini les responsabilités. Les méthodes ont
été coupées par section, mais elles continuent de partager `this.*`
sans encapsulation (state, capabilities, DOM refs).

### Gravité
**Élevée** — Refactor inachevé.

### Fichier(s) concerné(s)
- Quatre mixins listés.

### Cause profonde
Découpage rapide pour fluidifier les diffs sans toucher au design.

### Impact réel
- Couplage implicite via `this.*` → impossible de tester un mixin
  isolé.
- Comprendre un mixin nécessite de connaître l'état global.

### Impact CPU/RAM
Négligeable.

### Impact UX
Aucun.

### Solution recommandée
Repartir d'une architecture **composant + état** (cf. KM-C1) :
- Le state passe explicitement (`new PianoView(state, deps)`).
- DOM refs locales à la vue.
- L'EventBus reste injecté.

### Difficulté implémentation
**Élevée** (recouvre KM-C1, KM-C2).

### Gain attendu
- Encapsulation réelle.
- Tests unitaires par vue.

---

## KM-E5 — Modules purs `NoteEngine` / `VoicingEngine` jamais testés

### Problème détecté
`NoteEngine.js` (166 l.) et `VoicingEngine.js` (201 l.) sont
explicitement marqués "Sans dépendance DOM. Instanciable et testable
unitairement." dans leurs en-têtes. Pourtant **aucun test n'existe**
(`grep -rln 'NoteEngine\|VoicingEngine' tests/` → vide).

Ce sont les seuls éléments du modal facilement testables, et ils
ne le sont pas.

### Gravité
**Élevée** — Régression possible sur algo musical (gammes, chord
voicing) sans alarme CI.

### Fichier(s) concerné(s)
- `public/js/features/keyboard/NoteEngine.js`
- `public/js/features/keyboard/VoicingEngine.js`

### Cause profonde
Pas de framework de test frontend mature (vitest est là mais pas
encore utilisé activement sur ces modules).

### Impact réel
- Bug sur scale `mixolydian` → personne ne le voit en CI.
- Refactor de `_mapChordToStrings` (cf. `KeyboardChords.js:587`)
  fragile.

### Impact CPU/RAM
Aucun.

### Impact UX
Indirect — bugs musicaux subtils possibles.

### Solution recommandée
1. Créer `tests/frontend/keyboard/NoteEngine.spec.js` (vitest), 15
   cas (gammes majeure / mineure / blues / chromatique sur 5 notes
   racines).
2. Créer `tests/frontend/keyboard/VoicingEngine.spec.js`, 20 cas
   (accord Maj/min/7/Maj7/m7 sur guitare 6 cordes, basse 4, violon
   bowed).
3. Couvrir spécifiquement `_chordMaxPolyphony` (3 familles GM
   différentes).

### Difficulté implémentation
**Facile** — 4-6 h.

### Gain attendu
- Filet de sécurité pour les futurs refactors.
- Force la documentation des invariants musicaux.

---

## KM-E6 — `KeyboardChords.js` (1 662 l.) : god-mixin secondaire

### Problème détecté
Le mixin "Chords" porte :
- Buttons UI (6 boutons d'accord, rendu, événements).
- Logique de strum / bow (`_triggerStrum`, `_triggerBowStart`).
- Mapping chord → cordes (devrait être dans `VoicingEngine`).
- Calcul polyphonie maximale par famille GM.
- Calcul de positions de doigts sur fretboard
  (`_mapChordToStringsVerticalBar`).
- État interne sur ~10 propriétés (`chordRoot`, `_strumTimeouts`,
  `_currentActiveFrets`, etc.).

Le commentaire à `VoicingEngine.js:1` indique d'ailleurs : « Extrait
et généralise la logique de KeyboardChords._mapChordToStrings() ».
**Or `KeyboardChords` n'utilise pas `VoicingEngine`** — la
généralisation existe en parallèle mais le code originel reste.

### Gravité
**Élevée** — Doublon vivant entre `KeyboardChords` et `VoicingEngine`.

### Fichier(s) concerné(s)
- `public/js/features/keyboard/KeyboardChords.js`
- `public/js/features/keyboard/VoicingEngine.js`

### Cause profonde
Refactor "extraire moteur pur" amorcé mais non substitué dans le
consommateur. La généralisation existe, mais l'ancien code n'a pas
été retiré.

### Impact réel
- Maintenance double sur la logique chord → strings.
- Risque de divergence (un fix dans l'un, pas dans l'autre).

### Impact CPU/RAM
- Légèrement gourmand : la logique chord est exécutée deux fois si on
  utilise les deux (preview + main).

### Impact UX
Si bug dans `_mapChordToStrings` mais pas dans `VoicingEngine`,
incohérence preview vs jouer.

### Solution recommandée
1. Faire que `KeyboardChords._playChordSustain` utilise
   `VoicingEngine.mapChordToStrings(…)` au lieu de sa propre
   implémentation.
2. Supprimer `_mapChordToStrings` + `_mapChordToStringsVerticalBar` du
   mixin.
3. Compléter `VoicingEngine` avec le pattern verticalBar si manquant.
4. Couvrir `VoicingEngine` de tests (cf. KM-E5).

### Difficulté implémentation
**Moyenne** — 1 j.

### Gain attendu
- 1 source de vérité pour le voicing.
- Réduction `KeyboardChords` de ~1 662 → ~900 lignes.

---

## KM-E7 — Couplage avec `WindInstrumentDatabase` global

### Problème détecté
`KeyboardModal.js:744-747` :
```js
const isWind = !isDrum && !canFretboard
    && gmProgram !== undefined && gmProgram !== null
    && typeof WindInstrumentDatabase !== 'undefined'
    && WindInstrumentDatabase.isWindInstrument(gmProgram);
const windPreset = isWind ? WindInstrumentDatabase.getPresetByProgram(gmProgram) : null;
```
La détection wind dépend d'une **lib globale** (`window.WindInstrumentDatabase`)
chargée séparément. Si le `<script>` n'est pas inclus, la détection
silently fallback à "pas wind".

### Gravité
**Moyenne** — Couplage global non-testable.

### Fichier(s) concerné(s)
- `public/js/features/KeyboardModal.js:744-747`.
- `public/js/features/WindInstrumentDatabase.js`.

### Cause profonde
Tous les modules vanilla JS utilisent `window.*` au lieu d'imports.

### Impact réel
- Si on retire/renomme `WindInstrumentDatabase`, le modal cesse
  silencieusement de détecter wind.
- Tests impossibles sans monkey-patcher `window`.

### Impact CPU/RAM
Aucun.

### Impact UX
- En cas de panne silencieuse, l'utilisateur a une vue piano au lieu
  de piano-slider pour un instrument à vent.

### Solution recommandée
1. Quand KM-C3 (`InstrumentDetector` extraction) sera appliqué,
   injecter `WindInstrumentDatabase` comme dépendance constructeur.
2. Ajouter un test smoke "isWindInstrument(GM 65 alto sax) === true".

### Difficulté implémentation
**Facile** — couplé à KM-C3.

### Gain attendu
- Détection robuste, testable.

---

## KM-M1 — CSS : 99 `!important` dans `keyboard-modal.css`

### Problème détecté
`public/styles/keyboard-modal.css` (3 092 l.) contient **99
`!important`**, le plus haut taux du projet
(`AUDIT_FRONTEND_2026-05-14.md` E9). Plus :
- `keyboard-polish.css` (734 l.) — fichier "polish" séparé du
  principal → cascade non maîtrisée.
- `keyboard.css` (339 l.) — base, partagée avec le mini-piano.
- `keyboard-hand-position-editor.css` (210 l.) — hors modal (utilisé
  pour un autre éditeur).

### Gravité
**Moyenne** — Maintenance difficile, refonte thématique impossible
sans audit complet.

### Fichier(s) concerné(s)
- Quatre listés ci-dessus.

### Cause profonde
Spécificités héritées des modales, palliatif `!important` à chaque
conflit. Un `polish.css` distinct = signal d'un correctif tardif
empilé.

### Impact réel
- Tout changement de thème casse 5+ sélecteurs `!important`.
- Performance de calcul de style légèrement dégradée.

### Impact CPU/RAM
- Boot : 4 CSS × ~600 KB cumulés parsed.

### Impact UX
Aucun direct.

### Solution recommandée
1. Fusionner `keyboard.css` + `keyboard-modal.css` + `keyboard-polish.css`
   → `keyboard.css` unique (sous-divisé par sections).
2. Sortir `keyboard-hand-position-editor.css` du périmètre keyboard
   (renommer en `hand-position-editor.css` car ce n'est pas le modal
   keyboard).
3. Auditer chaque `!important` : remplacer par spécificité accrue ou
   par BEM (`.km-piano__key--active` au lieu de
   `.piano-key.active !important`).
4. Cibler `< 30` !important après refonte.

### Difficulté implémentation
**Moyenne** — 1-2 j.

### Gain attendu
- Cascade lisible.
- Theming faisable.

---

## KM-M2 — État dispersé sur `this.*` (~40 propriétés)

### Problème détecté
Le constructeur `KeyboardModal.js:7-95` initialise **~40 propriétés
d'instance** : devices, selectedDevice, capabilities, activeNotes,
mouseActiveNotes, activeFretPositions, velocity, modulation,
listViewYCC, listViewPitchBendEnabled, keyboardLayout, isMouseDown,
octaves, minOctaves, maxOctaves, visibleNoteCount, startNote,
defaultStartNote, whiteNoteOffsets, blackNoteSemitones,
visibleWhiteNotes, visibleBlackNotes, noteLabelFormat, viewMode,
windPreset, currentArticulation, showNoteColors, stringInstrumentConfig,
_stringSlideActive, _minimapDragging, _panelMode, etc.

Aucune séparation entre :
- **Config persistante** (octaves, noteLabelFormat, keyboardLayout) →
  devrait être dans localStorage / settings.
- **État applicatif** (selectedDevice, capabilities, viewMode) →
  devrait être dans un store.
- **État éphémère interaction** (isMouseDown, _modWheelDragging,
  _minimapDragging) → devrait être local à un handler.

### Gravité
**Moyenne** — Couplage interne fort, debug compliqué.

### Fichier(s) concerné(s)
- `public/js/features/KeyboardModal.js:7-95`.

### Cause profonde
Pas de séparation Config/State/UI ; pattern monolithique.

### Impact réel
- Debug long : 40 propriétés à inspecter pour comprendre l'état.
- Risque d'oubli de reset dans `close()` (et le `close()` actuel
  reset seulement 5 propriétés : isMouseDown, mouseActiveNotes,
  activeFretPositions, selectedDevice, isOpen).

### Impact CPU/RAM
- À chaque ouverture, ~40 propriétés réinitialisées. Négligeable mais
  illisible.

### Impact UX
- Bug potentiel : oubli de reset d'une propriété laisse un état stale
  entre deux ouvertures.

### Solution recommandée
Diviser en 3 objets :
```js
this.config = { keyboardLayout: 'azerty', noteLabelFormat: 'english',
                octaves: 3, defaultStartNote: 48 };  // loadSettings()
this.state  = { selectedDevice: null, capabilities: null,
                viewMode: 'piano', activeNotes: new Set(),
                velocity: 80, modulation: 64 };
this.ui     = { isMouseDown: false, _modWheelDragging: false,
                _minimapDragging: false };  // reset à chaque close()
```
Refactor progressif, file par file.

### Difficulté implémentation
**Moyenne** — 1 j si fait avec rigueur.

### Gain attendu
- Debug accéléré.
- Reset cohérent dans `close()`.

---

## KM-M3 — `attachEvents` : pas de helper `_trackListener`

### Problème détecté
`KeyboardEvents.js` attache une douzaine de listeners DOM sur
`document.getElementById('…')` mais le pattern `_eventUnsubs`
(`KeyboardModal.js:194-197`) ne couvre que les EventBus
subscriptions, pas les DOM listeners. `detachEvents()` doit
explicitement retirer chaque listener avec la même référence de
fonction.

Comme tous les listeners utilisent des arrow functions inline
(`() => {…}`), **aucun n'est retirable** sauf via clonage de noeud.

### Gravité
**Moyenne** — Risque de fuite résiduelle.

### Fichier(s) concerné(s)
- `public/js/features/keyboard/KeyboardEvents.js`.

### Cause profonde
Pattern arrow function inline pratique mais bloque le `removeEventListener`.

### Impact réel
- À chaque cycle open/close du modal, les anciens listeners restent
  attachés aux éléments DOM. Mais comme `close()` retire le `container`
  (`KeyboardModal.js:235-238`), les listeners sont GC'd avec le DOM
  → en pratique, pas de fuite ici.
- **Toutefois** les listeners sur `document` (cf. `handleKeyDown`,
  `handleGlobalMouseUp`) **sont** retirés explicitement (`bind` au
  constructeur). Bon point.

### Impact CPU/RAM
- Quasi nul en pratique.

### Impact UX
Aucun direct.

### Solution recommandée
Convertir au pattern `_on(el, evt, handler)` proposé dans
`AUDIT_FRONTEND_2026-05-14.md` E7. Pour le modal keyboard, ce n'est
pas critique mais ce sera un bon premier cas pédagogique.

### Difficulté implémentation
**Facile** — 2 h dans le cadre de la migration globale E7.

### Gain attendu
- Cohérence avec le reste du frontend après refactor E7.

---

## KM-M4 — `_buildInstrumentDropdown` : 55 lignes de `innerHTML +=` répétés

### Problème détecté
`KeyboardModal.js:871-925` construit le dropdown d'instruments en
mélangeant `innerHTML = ''` + 3 `btn.innerHTML = \`<…>\`` par
instrument. Pour 128 instruments GM + ~10 kits de drum = ~138
itérations × 3 affectations innerHTML.

### Gravité
**Moyenne** — Performance et coût DOM.

### Fichier(s) concerné(s)
- `public/js/features/KeyboardModal.js:871-925`.

### Cause profonde
Pattern simple.

### Impact réel
- Dropdown construit une fois à l'ouverture du modal : ~50-100 ms
  cumulés sur Pi.
- Listeners attachés à chaque bouton (138 listeners au boot du
  modal).

### Impact CPU/RAM
- **CPU** : pic 50-100 ms à l'ouverture.
- **RAM** : 138 noeuds DOM + 138 listeners.

### Impact UX
Latence d'ouverture modal +50-100 ms.

### Solution recommandée
1. Construire un DocumentFragment hors DOM, puis l'attacher en un seul
   `appendChild` :
   ```js
   const frag = document.createDocumentFragment();
   for (const opt of options) frag.appendChild(buildButton(opt));
   dropdown.replaceChildren(frag);
   ```
2. Single event listener sur `dropdown` (event delegation) au lieu de
   138 listeners.

### Difficulté implémentation
**Facile** — 1-2 h.

### Gain attendu
- Construction dropdown −60 %.
- 138 listeners → 1 listener délégué.

---

## KM-F1 — Containers DOM créés systématiquement, même hors usage

### Problème détecté
`createModal()` crée toujours :
- `#piano-container`
- `#piano-slider-container`
- `#fretboard-container`
- `#drumpad-container`
- `#keyboard-list-container`
- `#km-hand-band`
- `#wind-instrument-panel`

Même pour une session qui n'utilisera qu'un mode.

### Gravité
**Faible** — Bytes/noeuds gaspillés mais perf imperceptible.

### Fichier(s) concerné(s)
- `public/js/features/keyboard/KeyboardPiano.js:190-196`.

### Cause profonde
Pattern statique HTML.

### Impact réel
- ~30-50 noeuds DOM en surplus selon la vue active.

### Impact CPU/RAM
- Négligeable.

### Impact UX
Aucun.

### Solution recommandée
À l'occasion de KM-C1 (registre `InstrumentView`) : créer le
container à la première activation de la vue, le supprimer à la
sortie de vue (ou simplement le cacher si on veut éviter de
recréer).

### Difficulté implémentation
**Faible** — couplé à KM-C1.

### Gain attendu
- DOM modal plus léger (~−15 %).

---

# Plan d'extensibilité — Ajouter de nouveaux types d'instruments

## Cible

Permettre d'ajouter, sans modifier le code existant des autres vues :
- Un **accordion** (touches piano + boutons basse au clavier
  + soufflet velocity).
- Un **harmonica** (rangée de trous + pousser/tirer = pitch bend).
- Un **vibraphone / xylophone / marimba** (mailloches mappées sur
  une grille, pas de pitch bend, articulation
  trémolo via CC).
- Une **harpe** (cordes verticales, glissando = drag horizontal).
- Une **cornemuse / bagpipe** (drone constant + chanter melody).
- Une **theremine** (deux axes continus X = pitch, Y = volume,
  pas de touche).
- Un **kalimba** (lamelles cliquables verticales).
- Une **steel drum** (sections circulaires + position).
- Un **gong / tambour à fente** (gros zones cliquables sensibles à
  la force).

Sans :
- toucher à `setViewMode`,
- toucher à `KeyboardEvents.js`,
- toucher à `getInstrumentViewInfo()`,
- toucher à `index.html`.

## Architecture cible

### Interface `InstrumentView`

```js
// public/js/features/keyboard/views/InstrumentView.js
/**
 * @typedef {Object} ViewContext
 * @property {KeyboardState} state          Shared mutable state
 * @property {BackendAPIClient} backend     For send / sendCommand
 * @property {EventBus} eventBus
 * @property {{ t: (k: string) => string }} i18n
 * @property {InstrumentCapabilities} capabilities  Resolved caps
 * @property {ViewOptions} options          Per-view options from detector
 */

class InstrumentView {
  /** Static identifier used by registry & toolbar emoji. */
  static viewKind = 'abstract';
  /** Default emoji shown in the view-toggle button. */
  static emoji = '❔';
  /** Default label (i18n key) for toggle hint. */
  static labelKey = 'keyboard.view';

  /**
   * Lazy-create DOM and attach to host. Called once when view becomes active.
   * @param {HTMLElement} host  An empty <div> reserved for this view.
   * @param {ViewContext} ctx
   */
  mount(host, ctx) { throw new Error('Not implemented'); }

  /** Detach DOM & remove listeners. Called when leaving this view. */
  unmount() { throw new Error('Not implemented'); }

  /** Apply new capabilities (e.g. instrument switched mid-view). */
  setCapabilities(caps) { /* default: no-op */ }

  /** Range update from minimap / octave control (piano family only). */
  setNoteRange(startNote, noteCount) { /* default: no-op */ }

  /** Visual update for activeNotes set change (driven by external events). */
  setActiveNotes(activeMidiSet) { /* default: no-op */ }

  /**
   * Hook called BEFORE backend.playNote — can transform velocity, cancel.
   * @returns {{midi, velocity, opts} | false}
   */
  willPlayNote(midi, velocity, opts) { return { midi, velocity, opts }; }

  /**
   * Returns the toolbar groups this view wants visible.
   * Used to declaratively show/hide control groups.
   * @returns {Set<string>}
   */
  toolbarGroups() { return new Set(['notation', 'velocity']); }
}
```

### Registre `InstrumentViewRegistry`

```js
// public/js/features/keyboard/views/InstrumentViewRegistry.js
class InstrumentViewRegistry {
  constructor() { this._byKind = new Map(); this._rules = []; }

  register(ViewClass) {
    if (!ViewClass.viewKind || ViewClass.viewKind === 'abstract') {
      throw new Error('viewKind required');
    }
    this._byKind.set(ViewClass.viewKind, ViewClass);
    return this;
  }

  /** Add a detection rule. First matching rule wins. */
  addRule(predicate, viewKind, options = {}) {
    this._rules.push({ predicate, viewKind, options });
    return this;
  }

  /** Resolve which view should handle these capabilities. */
  resolve(caps) {
    for (const r of this._rules) {
      if (r.predicate(caps)) return { ViewClass: this._byKind.get(r.viewKind), options: r.options };
    }
    return { ViewClass: this._byKind.get('piano'), options: {} };
  }

  /** All registered kinds (used by manual toggle UI). */
  kinds() { return [...this._byKind.keys()]; }
}
```

### Bootstrap (registration centralisée)

```js
// public/js/features/keyboard/views/registerBuiltins.js
import { instrumentViews } from './InstrumentViewRegistry.js';
import { PianoView }       from './PianoView.js';
import { PianoSliderView } from './PianoSliderView.js';
import { FretboardView }   from './FretboardView.js';
import { DrumPadView }     from './DrumPadView.js';
import { ListView }        from './ListView.js';

instrumentViews
  .register(PianoView)
  .register(PianoSliderView)
  .register(FretboardView)
  .register(DrumPadView)
  .register(ListView);

const isInRange = (lo, hi) => caps =>
  caps.gm_program !== undefined && caps.gm_program >= lo && caps.gm_program <= hi;
const DRUM_TYPES = new Set(['drum', 'drums', 'drumkit', 'drum_kit',
                             'percussion', 'percussive']);

instrumentViews
  .addRule(caps => caps.channel === 9, 'drumpad')
  .addRule(caps => DRUM_TYPES.has((caps.instrument_type || '').toLowerCase()), 'drumpad')
  .addRule(isInRange(24, 47), 'fretboard')
  .addRule(c => [104, 105, 106, 107, 110].includes(c.gm_program), 'fretboard')
  .addRule(isInRange(56, 79), 'piano-slider', { wind: true })
  // catch-all
  .addRule(() => true, 'piano');
```

### Orchestrateur `KeyboardModalController`

Remplace l'actuel `KeyboardModalNew` + 7 mixins. Squelette :

```js
class KeyboardModalController {
  constructor(deps) {
    this.deps = deps;                  // { backend, eventBus, logger, i18n }
    this.config = loadSettings();
    this.state = new KeyboardState(this.config);
    this.toolbar = new ToolbarPanel(this);
    this.controls = new ControlsPanel(this); // velocity / mod / pitch sliders
    this.eventsBinder = new EventsBinder(this);
    this.view = null;        // current InstrumentView instance
    this.viewHost = null;    // DOM element reserved for the active view
  }

  async open(panelHost) {
    this._mountChrome(panelHost);                     // chrome = header + sliders + minimap
    this._mountToolbar();
    await this._loadDevices();
    this.eventsBinder.attach();
    // No view yet — set when device is picked
  }

  selectDevice(deviceCaps) {
    this.state.capabilities = deviceCaps;
    const { ViewClass, options } = instrumentViews.resolve(deviceCaps);
    this.switchView(ViewClass, options);
  }

  switchView(ViewClass, options = {}) {
    if (this.view) this.view.unmount();
    this._cleanViewHost();
    this.view = new ViewClass();
    this.view.mount(this.viewHost, {
      state: this.state,
      backend: this.deps.backend,
      eventBus: this.deps.eventBus,
      i18n: this.deps.i18n,
      capabilities: this.state.capabilities,
      options,
    });
    this.toolbar.applyGroupVisibility(this.view.toolbarGroups());
    this.deps.eventBus.emit('keyboard:view_changed', {
      viewKind: ViewClass.viewKind,
      caps: this.state.capabilities,
    });
  }

  playNote(midi, velocity, opts = {}) {
    const transformed = this.view?.willPlayNote(midi, velocity, opts);
    if (transformed === false) return;
    const { midi: m, velocity: v, opts: o } = transformed ?? { midi, velocity, opts };
    this.deps.backend.midiSendNote({ ...this._routingFor(o), note: m, velocity: v });
  }

  close() { this.eventsBinder.detach(); this.view?.unmount(); /* … */ }
}
```

### Exemple : ajouter une vue "Accordion"

```js
// public/js/features/keyboard/views/AccordionView.js
import { InstrumentView } from './InstrumentView.js';

export class AccordionView extends InstrumentView {
  static viewKind = 'accordion';
  static emoji    = '🪗';
  static labelKey = 'keyboard.viewAccordion';

  mount(host, ctx) {
    this.ctx = ctx;
    this.host = host;
    host.innerHTML = `
      <div class="accordion-view">
        <div class="accordion-bellows" id="acc-bellows"></div>
        <div class="accordion-keyboard" id="acc-keyboard"></div>
        <div class="accordion-bass-buttons" id="acc-bass"></div>
      </div>
    `;
    // bind bellows pull/push to CC#11 (expression) → velocity factor
    this._bellowsHandler = (e) => this._onBellowsMove(e);
    host.querySelector('#acc-bellows').addEventListener('pointermove', this._bellowsHandler);
    this._mountKeys();
    this._mountBassButtons();
  }

  unmount() {
    this.host.querySelector('#acc-bellows')?.removeEventListener('pointermove', this._bellowsHandler);
    this.host.innerHTML = '';
  }

  willPlayNote(midi, velocity, opts) {
    // Bellows position scales velocity
    return { midi, velocity: Math.round(velocity * this._bellowsFactor), opts };
  }

  toolbarGroups() {
    // Accordion uses notation + bellows control, no pitch bend, no mod wheel
    return new Set(['notation', 'bellows']);
  }
}

// Registration (in registerBuiltins.js or a plugin file):
import { AccordionView } from './AccordionView.js';
instrumentViews.register(AccordionView);
instrumentViews.addRule(
  c => c.gm_program === 21 || c.gm_program === 22 || c.gm_program === 23, // accordion / tango / harmonica
  'accordion'
);
```

**Coût d'ajout** : 1 fichier `AccordionView.js` + 2 lignes
d'enregistrement. **Zéro fichier existant touché.**

### Vues spécifiques candidates

| Vue future | viewKind | GM programs typiques | Particularités |
|---|---|---|---|
| Accordion | `accordion` | 21-23 | Soufflet velocity, basses Stradella |
| Harmonica | `harmonica` | 22 | Lignes pousser/tirer, glissando latéral |
| Mallet | `mallet` | 12-15 (vibraphone, marimba, etc.) | Pas de pitch-bend, trémolo via CC |
| Harpe | `harp` | 46-47 | Cordes verticales, glissando = drag X |
| Bagpipe | `bagpipe` | 109 | Drone constant + chanter |
| Theremine | `theremine` | (custom) | 2 axes continus X/Y, sans touches |
| Kalimba | `kalimba` | 108 | Lamelles verticales |
| Steel drum | `steel-drum` | 114 | Sections circulaires |
| Gong | `gong` | (drum kit ext) | Gros zones force-sensitive |

Avec l'architecture proposée, chacune = ~ 300-700 lignes dans un
fichier dédié, sans toucher au reste.

---

# Plan d'action séquencé (modal piano virtuel)

## Phase A — Quick wins isolés (1 jour / 1 dev)

| Action | Finding | Effort |
|---|---|---|
| Renommer `KeyboardModalNew` → `KeyboardModal` | KM-E1 | 30 min |
| Tests Vitest `NoteEngine` + `VoicingEngine` | KM-E5 | 4-6 h |
| Event delegation pour dropdown instruments | KM-M4 | 1-2 h |
| Fusion `keyboard*.css` → 1 fichier (sans toucher `!important`) | KM-M1 phase 1 | 2 h |

## Phase B — Extraction service détection (1 jour)

| Action | Finding | Effort |
|---|---|---|
| Créer `InstrumentDetector` + `RULES` data | KM-C3 | 4 h |
| Tests Vitest 30+ cas GM | KM-C3 | 2 h |
| Migrer `getInstrumentViewInfo` vers le détecteur | KM-C3 | 2 h |
| Couper dépendance globale `WindInstrumentDatabase` | KM-E7 | 1 h |

## Phase C — Interface `InstrumentView` + registre (1-2 jours)

| Action | Finding | Effort |
|---|---|---|
| Définir `InstrumentView` abstract + `InstrumentViewRegistry` | KM-C1 | 4 h |
| Bootstrap `registerBuiltins.js` (rules + register stubs) | KM-C1 | 2 h |
| Wire registry dans `KeyboardModalController` (squelette) | KM-C1 | 4 h |

## Phase D — Migration des 5 vues existantes (4-5 jours)

| Vue | Source actuelle | Effort |
|---|---|---|
| `PianoView` | `KeyboardPiano.js` (extrait piano + minimap + octave bar) | 1 j |
| `FretboardView` | `KeyboardPiano.js` + `KeyboardChords.js` + `KeyboardSlider.js` | 1,5 j |
| `DrumPadView` | `KeyboardPiano.js` (drumpad section) | 0,5 j |
| `PianoSliderView` | `KeyboardPiano.js` + `KeyboardWind.js` | 0,5 j |
| `ListView` | `KeyboardListView.js` | 0,5 j |
| Sortir HandsOverlay comme service séparé | `KeyboardPiano.js:1357-2052` | 0,5 j |

## Phase E — Décommission et cleanup (1-2 jours)

| Action | Finding | Effort |
|---|---|---|
| Supprimer mixins `KeyboardPianoMixin` + retirer `Object.assign` | KM-C4 | 2 h |
| Découpler `KeyboardChords` / `VoicingEngine` (utiliser le moteur) | KM-E6 | 4-6 h |
| Externaliser `createModal` HTML | KM-E2 | 4 h |
| State séparé en `config` / `state` / `ui` | KM-M2 | 1 j |
| Helper `_on(el, evt, handler)` pour DOM listeners | KM-M3 | 4 h |
| Audit + suppression `!important` < 30 | KM-M1 phase 2 | 1 j |

## Phase F — Unification mini-piano (0,5-1 jour)

| Action | Finding | Effort |
|---|---|---|
| Identifier code mini-piano dans `index.html` | KM-E3 | 1 h |
| Extraire `PianoRenderer` partagé + mode "range-select" | KM-E3 | 4-6 h |
| Migrer le modal piano virtuel + le mini-piano vers le renderer | KM-E3 | 2 h |

## Phase G — Validation (0,5-1 jour)

| Action | Validation |
|---|---|
| Tests E2E : ouvrir modal sur chaque GM family principale (piano, guitar, drums, violin, alto sax, harmonica) → bonne vue résolue | Manuel + screenshots |
| Test d'ajout d'un nouveau view stub (ex : `MockView`) en < 30 min | Pair coding |
| Mesure heap idle après 100 cycles open/close | DevTools |
| Mesure CPU pendant accord strum 12 notes | DevTools Performance |

---

# Métriques de succès

| Métrique | Avant | Après Phase D | Après Phase E+F |
|---|---|---|---|
| Lignes `KeyboardModal.js` + mixins | 7 504 | ~5 500 (-27 %) | ~4 500 (-40 %) |
| Lignes `KeyboardPiano.js` | 2 052 | 0 (supprimé) | 0 |
| Mixins via `Object.assign` | 7 | 0 | 0 |
| Tests unitaires keyboard | 0 | ~80 | ~120 |
| `!important` cumulés keyboard*.css | 153 | 153 | < 30 |
| Temps d'ajout d'une nouvelle vue | 1-3 j | 0,5 j | 0,5 j |
| Fichiers à toucher pour ajout vue | 4-5 | 2 | 1-2 |
| Couplage `window.*` keyboard | 4 deps | 1 dep | 0 |

---

# Annexes

## Liste exhaustive des `setViewMode` cleanups à migrer

Pour ne rien oublier lors du portage `setViewMode` → `unmount()` de
chaque vue :

| Vue source | Cleanup actuel (KeyboardPiano.js:455-478) |
|---|---|
| fretboard | `destroyStringSliders()`, `_stopActiveBow()` |
| keyboard-list | `_destroyKeyboardListInteraction()` |
| piano / list (hands) | `_cleanFingersCanvas()`, hide `#km-hand-band` |

Tout cela bascule dans `XxxView.unmount()`.

## Validation manuelle ajout nouvelle vue (script)

```bash
# Smoke test : créer une vue stub
cat > public/js/features/keyboard/views/StubView.js <<'EOF'
import { InstrumentView } from './InstrumentView.js';
export class StubView extends InstrumentView {
  static viewKind = 'stub';
  static emoji = '🔬';
  mount(host) { host.innerHTML = '<p>Stub view OK</p>'; }
  unmount() {}
}
EOF

# Enregistrement (à faire dans registerBuiltins.js)
# instrumentViews.register(StubView)
#               .addRule(c => c.gm_program === 999, 'stub');

# Vérification : un device avec gm_program=999 doit afficher "Stub view OK"
```

Cible : ≤ 30 min depuis fichier vide jusqu'à vue affichée.

## Listing complet des dépendances inter-mixins (à supprimer)

```
KeyboardPiano  → state, this.t, this.activeNotes, this.viewMode
KeyboardChords → renderFretboard(), _isBowedInstrument(), _stopActiveBow(), this.api, this.outputChannel
KeyboardControls → updateSlidersVisibility(), getSelectedChannel(), sendCC()
KeyboardEvents → toutes les méthodes : regeneratePianoKeys, setViewMode, _selectInstrumentOption, etc.
KeyboardSlider → renderFretboard, _updateSlideFingerPositions, viewMode
KeyboardListView → getNoteLabel, _sendPitchBend, isNotePlayable
KeyboardWind → playNote (override), _windOrigPlayNote (workaround)
```

Après refactor, chaque View reçoit uniquement `ctx` (state + backend
+ eventBus + i18n + caps). Plus aucune référence directe à `this.*`
des autres composants.

---

**Fin du rapport.**
