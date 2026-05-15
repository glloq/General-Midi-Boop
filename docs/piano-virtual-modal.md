# Piano Virtuel — Documentation complète

> **Scope** : Modal du clavier virtuel de General-Midi-Boop (`KeyboardModal` et ses mixins).  
> **Version auditée** : `1.1.0` — audit fonctionnel initial 2026-05-02, **mise à jour & audit d'intégration 2026-05-15**, **migration InstrumentView activée 2026-05-15** (voir §19, §20).
>
> ✅ **Architecture (migration Phase C/D terminée)** : le registre
> `InstrumentViewRegistry` est désormais **le propriétaire autoritaire du
> cycle de vie des vues**. `setViewMode()` résout une `InstrumentView`
> enregistrée et pilote `mount()`/`unmount()` ; la vue **délègue le rendu**
> aux méthodes mixin historiques (strangler fig). **Ajouter une vue
> instrument = 1 fichier + 1 règle**, sans toucher à `KeyboardModal` ni à
> `setViewMode`. Les mixins restent l'implémentation de rendu déléguée
> (décommission mécanique = résidu Phase E, voir §20.4). Voir §2.1, §19, §20.

---

## Table des matières

1. [Vue d'ensemble](#1-vue-densemble)
2. [Architecture des fichiers](#2-architecture-des-fichiers)
3. [Modes d'affichage](#3-modes-daffichage)
4. [Structure du modal — DOM généré](#4-structure-du-modal--dom-généré)
5. [Cycle de vie](#5-cycle-de-vie)
6. [État interne](#6-état-interne)
7. [Gestion des événements](#7-gestion-des-événements)
8. [Routage MIDI](#8-routage-midi)
9. [Rendu des touches](#9-rendu-des-touches)
10. [Navigation et zoom](#10-navigation-et-zoom)
11. [Sélection d'instrument](#11-sélection-dinstrument)
12. [Contrôles de jeu](#12-contrôles-de-jeu)
13. [Persistance (localStorage)](#13-persistance-localstorage)
14. [Internationalisation (i18n)](#14-internationalisation-i18n)
15. [Performances et mémoire](#15-performances-et-mémoire)
16. [Tests](#16-tests)
17. [Extension et évolutivité](#17-extension-et-évolutivité)
18. [Corrections apportées (audit 2026-05-02)](#18-corrections-apportées-audit-2026-05-02)
19. [Audit d'intégration (2026-05-15)](#19-audit-dintégration-2026-05-15)
20. [Évolutions — ajouter des vues d'instruments](#20-évolutions--ajouter-des-vues-pour-dautres-instruments)

---

## 1. Vue d'ensemble

Le **Piano Virtuel** est un modal plein-écran permettant de jouer des notes MIDI sur n'importe quel instrument physique ou virtuel connecté à l'application. Il propose cinq vues interchangeables :

| Vue | ID mode | Description |
|-----|---------|-------------|
| Piano standard | `piano` | Touches blanches/noires classiques |
| Piano slider | `piano-slider` | Touches égales + pitch bend par glissement |
| Fretboard | `fretboard` | Manche de guitare/basse/corde frettée ou non frettée |
| Drum pad | `drumpad` | Grille de pads percussifs classés par catégorie GM |
| Liste | `keyboard-list` | Vue liste : vélocité par hauteur de clic, pitch bend par glissement |

La sélection de la vue est automatique selon le programme GM de l'instrument sélectionné (voir §11), mais peut toujours être forcée manuellement.

---

## 2. Architecture des fichiers

```
public/js/features/
│
├── KeyboardModal.js              ← Classe principale KeyboardModal
│                                    État, cycle de vie, MIDI, sélection d'instrument
│                                    mountAsPanel/unmountPanel, _maybeSendStringFretCC
│                                    getNoteLabel, _getStringPresetForGmProgram
│                                    Helper KM-M3 : _on() / _offAll()
│
└── keyboard/
    ├── KeyboardPiano.js          ← Mixin KeyboardPianoMixin
    │                                createModal (HTML), generatePianoKeys, setViewMode
    │                                Minimap, octave bar, fretboard, drumpad, slider
    │
    ├── KeyboardEvents.js         ← Mixin KeyboardEventsMixin
    │                                attachEvents / detachEvents
    │                                playNote / stopNote, _resolveKeyToNote (clavier PC)
    │
    ├── KeyboardControls.js       ← Mixin KeyboardControlsMixin
    │                                loadSettings / loadDevices
    │                                Mod wheel, pitch bend wheel, updateSlidersVisibility
    │
    ├── KeyboardChords.js         ← Mixin KeyboardChordsMixin (accords/strum/bow)
    ├── KeyboardSlider.js         ← Mixin KeyboardSliderMixin (pitch bend, slide corde,
    │                                _sendPitchBend → midi_send_pitchbend)
    ├── KeyboardListView.js       ← Mixin KeyboardListViewMixin (vue liste)
    ├── KeyboardWind.js           ← Mixin KeyboardWindMixin (articulation/souffle vent,
    │                                override playNote ; _windOrigPlayNote workaround)
    │
    ├── InstrumentDetector.js     ← Module pur (ACTIF) — detect() : caps → viewKind
    │                                Consommé par KeyboardModal.getInstrumentViewInfo()
    │
    ├── InstrumentView.js         ← Classe abstraite (contrat des vues, voir §2.1)
    ├── InstrumentViewRegistry.js ← Registre viewKind→Classe + règles (ACTIF, §2.1)
    ├── SwipeTracker.js           ← Hit-testing drag touches piano (Phase F)
    │
    ├── NoteEngine.js             ← Module pur — gammes, mapping position→MIDI
    ├── NoteSlider.js             ← Widget UI slider note + gamme
    ├── VoicingEngine.js          ← Module pur — accord→cordes, scheduling strum
    │
    └── views/                    ← Couche vues ACTIVE (Phase C/D, voir §2.1)
        ├── PianoView.js / FretboardView.js / DrumPadView.js
        ├── PianoSliderView.js / ListView.js
        └── registerBuiltins.js   ← Enregistre les 5 vues + règles de détection

public/styles/
    ├── keyboard-modal.css        ← Modal overlay, header, dropdown instrument
    ├── keyboard.css              ← Touches piano, fretboard, drum pad, mini-piano
    ├── keyboard-polish.css       ← Animations, transitions, états hover/active
    └── piano-roll-view.css       ← Vue piano-roll (séparée du modal)
```

### Chargement dans index.html (ordre réel — `index.html:6151-6177`)

```html
<!-- Couche migration : détecteur + interface + registre -->
<script src="js/features/keyboard/InstrumentDetector.js"></script>
<script src="js/features/keyboard/InstrumentView.js"></script>
<script src="js/features/keyboard/InstrumentViewRegistry.js"></script>

<!-- Mixins du modal + helpers -->
<script src="js/features/keyboard/SwipeTracker.js"></script>
<script src="js/features/keyboard/KeyboardPiano.js"></script>
<script src="js/features/keyboard/KeyboardEvents.js"></script>
<script src="js/features/keyboard/KeyboardControls.js"></script>
<script src="js/features/keyboard/KeyboardChords.js"></script>
<script src="js/features/keyboard/NoteEngine.js"></script>
<script src="js/features/keyboard/VoicingEngine.js"></script>
<script src="js/features/keyboard/NoteSlider.js"></script>
<script src="js/features/keyboard/KeyboardSlider.js"></script>
<script src="js/features/keyboard/KeyboardListView.js"></script>
<script src="js/features/keyboard/KeyboardWind.js"></script>

<!-- Classe principale (applique les mixins) -->
<script src="js/features/KeyboardModal.js"></script>

<!-- Vues (après KeyboardModal) + bootstrap registre -->
<script src="js/features/keyboard/views/PianoView.js"></script>
<script src="js/features/keyboard/views/FretboardView.js"></script>
<script src="js/features/keyboard/views/DrumPadView.js"></script>
<script src="js/features/keyboard/views/PianoSliderView.js"></script>
<script src="js/features/keyboard/views/ListView.js"></script>
<script src="js/features/keyboard/views/registerBuiltins.js"></script>
```

> **Important** — `KeyboardModal.js` applique les mixins via `_applyMixin()`
> (`Object.assign` + avertissement sur collision) après la définition de la
> classe. Les 7 mixins doivent être chargés **avant** `KeyboardModal.js`.
> `KeyboardWindMixin` enveloppe `playNote` (capture `_windOrigPlayNote`).
> Les fichiers `views/*` sont chargés **après** `KeyboardModal.js` (ils
> n'étendent pas le prototype, ils s'auto-enregistrent dans le registre).

### 2.1 Couche migration `InstrumentView` (état réel, Phase C/D terminée)

| Élément | Statut | Détail |
|---------|--------|--------|
| `InstrumentDetector` | **ACTIF** | `getInstrumentViewInfo()` y délègue (`KeyboardModal.js`). Testé. |
| `InstrumentViewRegistry` + `views/*` | **ACTIF** | `setViewMode()` → `_activateView(kind)` : `instrumentViews.get(kind)` résout la classe, `unmount()` la précédente, `mount()` la nouvelle. La vue **délègue** le rendu aux mixins. Couvert par `tests/frontend/keyboard/view-lifecycle.test.js`. |
| Fallback legacy | **ACTIF** | `_legacyRenderForMode()` : si aucune vue n'est enregistrée pour le `kind` (ou `mount()` jette), le switch de rendu historique prend le relais → **garantie zéro régression**. |
| Règles de détection | **Dupliquées (gardées)** | `InstrumentDetector` et `registerBuiltins.js` encodent la même logique GM→viewKind ; cohérence **garantie par test** (`views.test.js` → « InstrumentDetector ↔ registry consistency »). |

**Cycle de vie** (`KeyboardModal._activateView`) :

```
setViewMode(mode)                       // chrome : containers + toolbar + boutons
   └── _activateView(mode, options)
         ├── ViewClass = window.instrumentViews.get(mode)
         ├── si absent / mount() jette → _legacyRenderForMode(mode)   (fallback sûr)
         ├── même kind déjà monté     → view.setCapabilities(caps)    (pas de churn)
         ├── view précédente          → view.unmount()                (teardown)
         └── new ViewClass().mount({ modal, state, backend,
                                      eventBus, i18n, capabilities, options })
                 └── la vue délègue : modal.renderFretboard() / … (Phase D)
```

Reste le **résidu mécanique Phase E** (déplacer physiquement le code de
rendu des mixins vers les classes de vue, supprimer `Object.assign`,
retirer le hack `_windOrigPlayNote`) — volontairement différé car non
vérifiable en navigateur dans ce conteneur et porteur de régressions
silencieuses (staccato vent, visibilité sliders caps-aware). Plan
détaillé en **§20.4**.

### Composition par mixins

```
KeyboardModal (classe)  — ordre d'application via _applyMixin() :
    ← KeyboardPianoMixin    (createModal, generatePianoKeys, setViewMode, renderFretboard…)
    ← KeyboardEventsMixin   (attachEvents, detachEvents, playNote, stopNote, _resolveKeyToNote)
    ← KeyboardControlsMixin (loadSettings, loadDevices, initModWheel, initPitchBendWheel…)
    ← KeyboardChordsMixin   (renderChordButtons, renderHandWidget, strum/bow…)
    ← KeyboardSliderMixin   (initPitchBendWheel deps, _sendPitchBend, slide corde…)
    ← KeyboardListViewMixin (renderKeyboardList, _destroyKeyboardListInteraction)
    ← KeyboardWindMixin     (override playNote + articulation ; _windOrigPlayNote)
```

`_applyMixin()` émet un **avertissement console** si un mixin écrase
silencieusement une méthode déjà présente sur le prototype (filet de
sécurité KM-C4). En cas de collision, **le dernier mixin appliqué
l'emporte**. `KeyboardWindMixin` est appliqué en dernier et enveloppe
volontairement `playNote` (l'original est capturé en lecture seule dans
`_windOrigPlayNote`). Aucune autre collision active.

---

## 3. Modes d'affichage

### 3.1 Piano standard (`piano`)

- Touches blanches en flex, touches noires en positionnement absolu.
- Largeur des touches noires : `0.6 × (100 / totalWhiteKeys)%` — proportionnel au nombre total de touches blanches visibles.
- Position de chaque touche noire : index de la touche blanche précédente + 0.7 (centrage visuel).
- Pastille de couleur chromatique (`note-color-dot`) toujours dans le DOM, visible si `showNoteColors === true`.
- Overlay canvas des doigts monté à la fin de chaque `generatePianoKeys()` si `hands_config.enabled === true`.

### 3.2 Piano slider (`piano-slider`)

- Toutes les touches ont la même largeur (chromatic strip).
- Le glissement horizontal après la frappe envoie du pitch bend via `initPianoSliderDrag`.
- Une ligne curseur (`piano-slider-cursor`) indique la position de drag.

### 3.3 Fretboard (`fretboard`)

- Grille CSS grid avec une colonne de corde à vide (fixe 48 px) + N colonnes de frettes.
- Largeurs de frettes calculées par tempérament égal : `position(f) = 1 - 2^(-f/12)` normalisé en `fr` CSS.
- Supports : instruments frettés ET non frettés (`is_fretless`), nombre de frettes par corde variable (`frets_per_string`).
- Marqueurs d'inlays aux frettes standard (3, 5, 7, 9, 12, 15, 17, 19, 21, 24).
- Vibration overlay (`.string-vibe`) animée par gradient + box-shadow à la note active.
- Mode glissement par corde : envoi de pitch bend continu sur l'axe horizontal d'une corde.

### 3.4 Drum pad (`drumpad`)

- Notes triées par catégorie GM (kick → snare → toms → hi-hat → cymbales → …).
- Icône SVG chargée depuis `assets/drums/drum_<midi>.svg` avec système d'alias pour les notes sans SVG dédié.
- Fallback visuel si le SVG ne se charge pas (`onerror: visibility hidden`).
- Par défaut : 25 pads GM standard (35–59) si aucune `selected_notes` n'est configurée.

### 3.5 Vue liste (`keyboard-list`)

- Une ligne par note visible (scroll vertical).
- Hauteur du clic dans la ligne = vélocité (haut = fort, bas = doux).
- Glissement horizontal = pitch bend.

---

## 4. Structure du modal — DOM généré

```
div.keyboard-modal                         ← overlay plein écran (z-index: 10000)
└── div.modal-dialog
    ├── div.modal-header
    │   ├── div.header-instrument-selector
    │   │   ├── button#instrument-trigger  ← déclencheur dropdown
    │   │   └── div#instrument-dropdown    ← liste d'instruments (custom, accessible)
    │   ├── div.keyboard-header-row
    │   │   └── div.keyboard-header-controls
    │   │       ├── .latency-group         ← affichage latence instrument
    │   │       ├── .view-mode-group       ← bouton toggle vue (piano/fretboard/drumpad)
    │   │       ├── .slide-mode-group      ← mode glissement (fretboard seulement)
    │   │       ├── .piano-slider-group    ← toggle piano-slider
    │   │       ├── .list-view-group       ← toggle vue liste
    │   │       ├── .note-color-group      ← toggle couleurs chromatiques
    │   │       └── .notation-group        ← US / FR / MIDI (radiogroup ARIA)
    │   └── button#keyboard-close-btn
    │
    ├── div.keyboard-minimap-row           ← navigation pleine plage MIDI
    │   ├── div.minimap-controls           ← ◄ [C3-C6] ► −  +
    │   └── div.minimap-wrapper
    │       └── div.minimap-track          ← 128 notes + viewport indicator
    │
    └── div.modal-body
        └── div.keyboard-layout
            ├── div#velocity-control-panel    ← slider vertical vélocité (1–127)
            ├── div#modulation-control-panel  ← roue mod CC#1 (masquée si non supporté)
            ├── div#pitch-bend-control-panel  ← roue pitch bend (masquée si non activé)
            └── div.keyboard-main
                ├── div#keyboard-canvas-container
                │   ├── div#piano-container          ← mode piano
                │   ├── div#piano-slider-container   ← mode piano-slider
                │   ├── div#fretboard-container      ← mode fretboard
                │   ├── div#drumpad-container        ← mode drumpad
                │   └── div#keyboard-list-container  ← mode liste
                └── div#keyboard-octave-bar          ← labels C-n sous le piano
```

---

## 5. Cycle de vie

```
new KeyboardModalNew(logger?, eventBus?)
    └── setupEventListeners()   ← abonnement EventBus bluetooth:*

open()
    ├── loadSettings()          ← lit localStorage
    ├── createModal()           ← injecte le DOM dans document.body
    ├── loadDevices()           ← API + enrichissement noms
    ├── populateDeviceSelect()  ← construit le dropdown instrument
    ├── attachEvents()          ← tous les listeners DOM
    ├── updateSlidersVisibility()
    └── i18n.onLocaleChange()   ← localeUnsubscribe sauvé

close()
    ├── detachEvents()          ← retire TOUS les listeners DOM (y.c. pitch bend)
    ├── localeUnsubscribe()
    ├── destroyStringSliders()
    ├── _destroyKeyboardListInteraction()
    ├── _cleanFingersCanvas()
    ├── activeNotes.forEach(stopNote)
    ├── container.remove()
    └── reset état (isMouseDown, mouseActiveNotes, activeFretPositions, selectedDevice)
```

> Le modal n'a pas de méthode `destroy()` — les listeners EventBus (`bluetooth:*`) sont ajoutés dans le constructeur et persistent pour toute la durée de vie de l'instance.

---

## 6. État interne

| Propriété | Type | Défaut | Description |
|-----------|------|--------|-------------|
| `isOpen` | `boolean` | `false` | Modal visible |
| `devices` | `Array` | `[]` | Instruments actifs chargés |
| `selectedDevice` | `Object\|null` | `null` | Instrument sélectionné |
| `selectedDeviceCapabilities` | `Object\|null` | `null` | Capacités chargées via API |
| `activeNotes` | `Set<number>` | `∅` | Notes MIDI actives (note-on envoyé) |
| `mouseActiveNotes` | `Set<number>` | `∅` | Notes déclenchées par la souris |
| `activeFretPositions` | `Set<string>` | `∅` | Positions `"string:fret"` actives (fretboard) |
| `velocity` | `number` | `80` | Vélocité courante (1–127) |
| `modulation` | `number` | `64` | Valeur CC#1 courante |
| `viewMode` | `string` | `'piano'` | Mode d'affichage actif |
| `noteLabelFormat` | `string` | `'english'` | `'english'` / `'solfege'` / `'midi'` |
| `startNote` | `number` | `48` | Premier MIDI visible (C3 par défaut) |
| `visibleNoteCount` | `number` | `36` | Nombre de notes visibles (3 oct) |
| `octaves` | `number` | `3` | Approximation en octaves (sync dropdown) |
| `showNoteColors` | `boolean` | `false` | Pastilles chromatiques |
| `keyboardLayout` | `string` | `'azerty'` | Layout clavier PC |
| `stringInstrumentConfig` | `Object\|null` | `null` | Config manche chargée depuis l'API |
| `_minimapDragging` | `boolean` | `false` | Drag minimap en cours |
| `_modWheelDragging` | `boolean` | `false` | Drag mod wheel en cours |

---

## 7. Gestion des événements

### 7.1 Listeners DOM (actifs uniquement quand le modal est ouvert)

| Cible | Événement | Gestionnaire |
|-------|-----------|-------------|
| `document` | `mouseup` | `handleGlobalMouseUp` — stoppe toutes les notes souris |
| `window` | `keydown` | `handleKeyDown` → `_resolveKeyToNote` |
| `window` | `keyup` | `handleKeyUp` → `_resolveKeyToNote` |
| `#keyboard-canvas-container` | `mousedown` | délégation → `handlePianoKeyDown` |
| `#keyboard-canvas-container` | `mouseup` | délégation → `handlePianoKeyUp` |
| `#keyboard-canvas-container` | `mouseleave` | (capture) → `handlePianoKeyUp` |
| `#keyboard-canvas-container` | `mouseenter` | (capture) → `handlePianoKeyEnter` (drag) |
| `#keyboard-canvas-container` | `touchstart` | délégation → `handlePianoKeyDown` (tous doigts) |
| `#keyboard-canvas-container` | `touchend` | délégation → `handlePianoKeyUp` (tous doigts) |
| `#keyboard-canvas-container` | `wheel` | zoom in/out |
| `#keyboard-minimap-track` | `mousedown/move/up` | navigation minimap |
| `#mod-wheel-track` | `mousedown/touchstart` | drag mod wheel |
| `#pitch-bend-track` | `mousedown/touchstart` | drag pitch bend |
| `document` | `click` | fermeture dropdown instrument hors-clic |

### 7.2 Délégation événements piano

Un seul jeu de 6 listeners est attaché au container parent `#keyboard-canvas-container` (pas un listener par touche). La résolution de la touche se fait par `e.target.closest('.piano-key')`.

- **Avantage** : scalable (aucun coût additionnel pour 96 touches vs 12).
- **Gestion multitouch** : `e.changedTouches` est itéré → chaque doigt déclenche/libère sa note indépendamment (correctif v1.1.0).

### 7.3 Mapping clavier PC

```
AZERTY (physique → MIDI index)          QWERTY (physique → MIDI index)
─────────────────────────────           ─────────────────────────────
Blanches : A S D F G H J K L ; ' \     Blanches : S D F G H J K L ;
           (→ index 0 à 11)                        (→ index 0 à 8)
Noires   : W E T Y U O P               Noires   : W E T Y U O P
```

L'indice mappe vers `visibleWhiteNotes[idx]` (touches blanches) ou `visibleBlackNotes` calculé à la volée. Le layout est rechargé depuis `localStorage` à chaque `open()`.

### 7.4 EventBus (persistant — durée de vie de l'instance)

| Événement | Action |
|-----------|--------|
| `bluetooth:connected` | Recharge la liste d'instruments |
| `bluetooth:disconnected` | Recharge la liste d'instruments |
| `bluetooth:unpaired` | Recharge la liste d'instruments |

---

## 8. Routage MIDI

### 8.1 Note On / Note Off

```
playNote(note)
    ├── Guard : note < 0 || note > 127 → return  ← plage MIDI complète (0–127)
    ├── activeNotes.add(note)
    ├── updatePianoDisplay()
    └── backend.sendNoteOn(deviceId, note, velocity, channel)

stopNote(note)
    ├── activeNotes.delete(note)
    ├── updatePianoDisplay()
    └── backend.sendNoteOff(deviceId, note, channel)
```

Pour un instrument virtuel (`isVirtual === true`) : log console uniquement, pas d'envoi réseau.

### 8.2 Canal MIDI

`getSelectedChannel()` retourne par ordre de priorité :
1. `selectedDeviceCapabilities.channel`
2. `selectedDevice.channel`
3. `0` (canal 1 par défaut)

### 8.3 Modulation (CC#1)

- Roue verticale custom avec retour au centre automatique au relâchement.
- Valeur 0–127 envoyée via `midi_send_cc { controller: 1 }`.
- Visible uniquement si `supported_ccs` contient `1`.

### 8.4 Pitch Bend

- Roue verticale custom, ressort au centre à la release (valeur 0 = neutre).
- Plage interne : -8191 … +8191 (résolution 14-bit).
- Visible uniquement si `pitch_bend_enabled === true` sur l'instrument.

### 8.5 CC String / Fret (fretboard)

Avant chaque note-on fretboard, deux CC sont envoyés pour pré-positionner les doigts mécaniques :

| CC | Valeur | Config |
|----|--------|--------|
| `cc_string_number` (défaut 20) | index corde (1-based) | `cc_string_min/max/offset` |
| `cc_fret_number` (défaut 21) | numéro de frette | `cc_fret_min/max/offset` |

Désactivable par `cc_enabled: false` dans la config de l'instrument.

---

## 9. Rendu des touches

### 9.1 Couleurs chromatiques

12 couleurs fixes (rouge → violet), une par classe de hauteur (C→B), invariantes par octave :

```js
const FRET_NOTE_COLORS = [
    { bg: '#EF4444', text: '#fff' }, // C  - Rouge
    { bg: '#F4622A', text: '#fff' }, // C# - Rouge-orangé
    { bg: '#F97316', text: '#fff' }, // D  - Orange
    { bg: '#FBBF24', text: '#1a1a1a' }, // D# - Jaune-orangé
    { bg: '#EAB308', text: '#1a1a1a' }, // E  - Jaune
    { bg: '#84CC16', text: '#1a1a1a' }, // F  - Jaune-vert
    { bg: '#22C55E', text: '#fff' }, // F# - Vert
    { bg: '#14B8A6', text: '#fff' }, // G  - Vert-cyan
    { bg: '#06B6D4', text: '#fff' }, // G# - Cyan
    { bg: '#3B82F6', text: '#fff' }, // A  - Bleu
    { bg: '#7C3AED', text: '#fff' }, // A# - Bleu-violet
    { bg: '#A855F7', text: '#fff' }, // B  - Violet
];
```

Activées/désactivées par le bouton 🎨. S'applique à la vue piano (pastille), au fretboard (fond du dot), et à la vue liste.

### 9.2 `isNotePlayable(noteNumber)`

Filtre les touches selon les capacités de l'instrument :

| Mode (`note_selection_mode`) | Règle |
|------------------------------|-------|
| `'discrete'` | Note dans `selected_notes` JSON |
| `'range'` (défaut) | `note_range_min ≤ note ≤ note_range_max` |
| Pas de capacités | Toutes les notes jouables |

Les touches hors range sont marquées `.disabled` (CSS gris) et ignorées dans `handlePianoKeyDown`.

### 9.3 Overlay doigts (piano view)

Un canvas `km-fingers-canvas` est monté sur `piano-container` quand `hands_config.enabled === true`. Il est géré par `KeyboardFingersRenderer` (fichier `auto-assign/`). Il est détruit et remonté à chaque `generatePianoKeys()`.

---

## 10. Navigation et zoom

### 10.1 Défilement octave

- Boutons ◄ / ► : déplacement de 12 semitones (1 octave) par clic.
- `startNote` clampé entre `0` et `127 - visibleNoteCount`.

### 10.2 Zoom

- Boutons −/+ et molette souris sur le canvas : ±`zoomStep` (4 semitones par défaut).
- Bornes : `minVisibleNotes = 12` (1 octave), `maxVisibleNotes = 96` (8 octaves).
- `octaves` est une approximation (`Math.round(visibleNoteCount / 12)`) synchronisée avec le dropdown du header.
- Le zoom est persisté dans `localStorage.gmboop_settings.keyboardOctaves`.

### 10.3 Minimap

- Construit une fois (`querySelector('.minimap-bg')`) pour les 128 notes MIDI (75 blanches + 53 noires).
- Le viewport (`#keyboard-minimap-viewport`) se positionne par pourcentage sémitone-based.
- Clic/drag sur la minimap centre la vue sur la position cliquée.
- Les touches hors range instrument sont marquées `.disabled` sur la minimap.

### 10.4 Auto-centrage

Au changement d'instrument, `autoCenterKeyboard()` centre la vue sur la plage jouable :

```
rangeCenter = (effectiveMin + effectiveMax) / 2
startNote   = clamp(round(rangeCenter - visibleNoteCount / 2), 0, 127 - visibleNoteCount)
```

En mode `'discrete'`, les bornes sont calculées depuis `selected_notes`.

---

## 11. Sélection d'instrument

### 11.1 Chargement des instruments

`loadDevices()` effectue :
1. `backend.listDevices()` **et** `instrument_list_capabilities` en **un seul couple d'appels parallèles** (`Promise.all`)
2. Déduplication par ID (fallback `name`) via un `Set`
3. Expansion des appareils multi-instruments (`device.instruments[]`) → un slot par canal
4. Chargement optionnel des instruments virtuels DB (si `virtualInstrument: true`) — réutilise les capacités déjà récupérées
5. Enrichissement des noms custom via une **map pré-construite** depuis `instrument_list_capabilities` (plus aucun appel `instrument_get_settings` par device — corrige l'ancien point de vigilance §15.3)

### 11.2 Détection automatique de la vue

`getInstrumentViewInfo()` analyse les capacités + programme GM :

| Condition | Vue auto |
|-----------|----------|
| `instrument_type === 'drum'` OU `channel === 9` OU `gm_program >= 128` | `drumpad` |
| `instrument_type === 'string'` OU `stringInstrumentConfig` OU GM 24–47, 104–107, 110 | `fretboard` |
| Autre | `piano` |

### 11.3 Presets GM pour le fretboard

`_getStringPresetForGmProgram(gmProgram)` retourne une config de manche prête à l'emploi pour les familles GM sans config DB :

- Guitares acoustiques/électriques (24–31) : 6 cordes, accordage standard EADGBE
- Basses (32–39) : 4 cordes, accordage standard EADG (basse fretless : 35)
- Cordes frottées (40–45) : 4 cordes, fretless (violon, alto, cello, contrebasse)
- Harpe (46) : 22 cordes, sans frettes
- Sitar (104), Banjo (105), Shamisen (106), Koto (107)

---

## 12. Contrôles de jeu

### 12.1 Vélocité

Slider vertical HTML `<input type="range" orient="vertical">` (1–127), défaut 80. Valeur lue dans `this.velocity` à chaque `playNote()`.

### 12.2 Roue de modulation (CC#1)

- Drag vertical custom (mouse + touch), valeur 0–127.
- Retour automatique au centre (64) au relâchement, avec animation CSS `.returning`.
- Masquée si l'instrument ne déclare pas CC#1 dans `supported_ccs`.

### 12.3 Roue de pitch bend

- Même mécanique que la modulation.
- Valeur interne -8191 … +8191 (affichée comme `-8191` / `+8191`), retour à 0 au relâchement.
- Masquée si `pitch_bend_enabled !== true`.

### 12.4 Notation des notes

Trois formats disponibles via radio-group ARIA :

| Bouton | Format | Exemple |
|--------|--------|---------|
| US | `english` | C4, F#3 |
| FR | `solfege` | Do4, Fa#3 |
| MIDI | `midi` | 60, 54 |

Persisté dans `localStorage.gmboop_settings.keyboardNotation`.

---

## 13. Persistance (localStorage)

Clé : `gmboop_settings` (JSON partagé avec les autres modules de l'app).

| Champ | Type | Description |
|-------|------|-------------|
| `keyboardOctaves` | `number` | Nombre d'octaves visibles (format actuel) |
| `keyboardKeys` | `number` | Nombre de touches (format legacy, rétro-compat) |
| `keyboardNotation` | `string` | `'english'` \| `'solfege'` \| `'midi'` |
| `keyboardLayout` | `string` | `'azerty'` \| `'qwerty'` |
| `virtualInstrument` | `boolean` | Afficher les instruments virtuels |

---

## 14. Internationalisation (i18n)

- Helper `t(key, params)` délègue à `window.i18n.t()` si disponible, retourne la clé sinon.
- Souscription à `i18n.onLocaleChange()` lors de `open()`, désouscription dans `close()`.
- `updateTranslations()` met à jour les labels de vélocité, modulation, les groupes du header, l'affichage de plage de notes, et le trigger d'instrument.

Clés i18n utilisées (préfixe `keyboard.*`) :

```
keyboard.velocity, keyboard.modulation, keyboard.pitchBend
keyboard.latency, keyboard.view, keyboard.notation
keyboard.scrollLeft, keyboard.scrollRight, keyboard.zoomOut, keyboard.zoomIn
keyboard.minimapHint, keyboard.toggleView
keyboard.slideMode, keyboard.slideToggle
keyboard.pianoSlider, keyboard.pianoSliderToggle
keyboard.listView, keyboard.listViewToggle
keyboard.noteColors, keyboard.toggleNoteColors
keyboard.virtualNoteOn, keyboard.virtualNoteOff
common.select
```

---

## 15. Performances et mémoire

### 15.1 DOM généré

| Vue | Nœuds DOM créés |
|-----|----------------|
| Piano 3 oct (36 notes) | ~21 blanches + 15 noires = 36 touches + 72 enfants (dot + label) ≈ **108 nœuds** |
| Piano 8 oct max (96 notes) | ~56 blanches + 40 noires ≈ **288 nœuds** |
| Minimap | 75 blanches + 53 noires = **128 nœuds** (créés une seule fois par open) |
| Fretboard 6c × 22f | 6 × 24 cells + 6 vibe + header = **~170 nœuds** |
| Drum pad (25 pads) | 25 × 4 enfants = **~100 nœuds** |

### 15.2 Optimisations en place

- **Délégation événements** : 6 listeners sur le container plutôt qu'un jeu par touche.
- **Minimap background unique** : `querySelector('.minimap-bg')` évite la reconstruction à chaque scroll.
- **`visibleWhiteNotes` / `visibleBlackNotes`** : tableaux pré-calculés à chaque `generatePianoKeys()`, évitent les calculs répétés dans les handlers.
- **`VoicingEngine._voicingCache`** : Map de voicings d'accords pour éviter recalcul.
- **`NoteEngine._scaleCache`** : tableau de notes de gamme mis en cache entre les appels.

### 15.3 Points de vigilance

- ~~`loadDevices()` émet N requêtes API~~ — **corrigé** : un seul couple `Promise.all` + map de noms pré-construite (voir §11.1).
- `regeneratePianoKeys()` détruit et recrée intégralement le DOM clavier à chaque zoom/scroll. Sur mobile bas de gamme, ce peut être perceptible sur des plages larges.
- Couche `views/` + registre chargée mais inerte (§2.1) : ~30-50 nœuds/objets inutilisés en mémoire jusqu'à l'achèvement de la migration. Négligeable.

---

## 16. Tests

Exécution : `npx vitest run tests/frontend/keyboard` → **10 fichiers, 208 tests, 100 % verts** (2026-05-15).

### 16.1 Tests existants (`tests/frontend/keyboard/`)

| Fichier | Ce qui est testé |
|---------|-----------------|
| `instrument-detector.test.js` | `InstrumentDetector.detect()` — piano/fretboard/drum/wind |
| `instrument-view-registry.test.js` | `InstrumentView` abstrait + `InstrumentViewRegistry` (register/resolve/rules) |
| `views.test.js` | Enregistrement des 5 vues, résolution, **cohérence détecteur↔registry**, toolbarGroups, willPlayNote |
| `note-engine.test.js` | `NoteEngine` (gammes, mapping) |
| `voicing-engine.test.js` | `VoicingEngine` (tuning, polyphonie, accord→cordes, strum) — **corrigé 2026-05-15** |
| `voicing-engine-integration.test.js` | Intégration voicing |
| `swipe-tracker.test.js` | `SwipeTracker` (drag hit-testing) |
| `keyboard-modal-pure.test.js` | **Ajouté 2026-05-15** — `getNoteLabel`, `getNoteNameFromNumber`, `_getStringPresetForGmProgram`, `_resolveKeyToNote` (AZERTY/QWERTY) |
| (+ `tests/frontend/keyboard-preview.test.js`, `keyboard-chords-finger-spacing.test.js`) | KeyboardPreview, espacement doigts accords |

### 16.2 Coverage encore manquante

- `isNotePlayable()` — modes range/discrete/no-caps (méthode DOM-couplée → nécessite harnais jsdom complet du modal)
- `autoCenterKeyboard()` — range/discrete, bornes MIDI 0/127 (idem)
- `setViewMode()` — bascule des 5 containers + cleanups (test d'intégration DOM)
- Intégration `mountAsPanel()` → callbacks `onNoteOn/off/onInstrumentSelected` (test d'intégration LoopEditor)

---

## 17. Extension et évolutivité

### Ajouter un nouveau mode de vue

1. Ajouter l'ID dans `validModes` dans `KeyboardPianoMixin.setViewMode`.
2. Ajouter un container `div#<mode>-container` dans `createModal()`.
3. Ajouter le `classList.toggle('hidden', ...)` dans `setViewMode`.
4. Implémenter `render<Mode>()` dans un nouveau mixin ou dans `KeyboardPianoMixin`.
5. Appliquer le mixin dans `KeyboardModal.js` en bas de fichier.
6. Charger le script avant `KeyboardModal.js` dans `index.html`.

### Ajouter un nouveau contrôle de jeu

1. Ajouter le panel HTML dans `createModal()`.
2. Implémenter `initXxxControl()` dans `KeyboardControlsMixin`.
3. Appeler `initXxxControl()` dans `KeyboardEventsMixin.attachEvents()`.
4. Ajouter le cleanup dans `KeyboardEventsMixin.detachEvents()`.
5. Mettre à jour `updateSlidersVisibility()` selon les capabilities de l'instrument.

### Ajouter un preset GM de manche

Ajouter un `if (gmProgram === N) return { ... }` dans `KeyboardModal._getStringPresetForGmProgram()`.

---

## 18. Corrections apportées (audit 2026-05-02)

### 18.1 Bug — `renderOctaveBar` : comparaison NaN impossible

**Fichier** : `public/js/features/keyboard/KeyboardPiano.js`

**Avant** :
```js
lbl.textContent = `C${octave}` === 'NaN' ? '' : ( ... );
```

**Après** :
```js
lbl.textContent = isNaN(octave) ? '' : ( ... );
```

**Impact** : Le template littéral `\`C${octave}\`` produit `'CNaN'` quand octave vaut `NaN`, jamais `'NaN'`. La condition ne pouvait donc jamais être vraie. Résultat : un label `'CNaN'` s'affichait sur l'octave bar au lieu d'une chaîne vide.

---

### 18.2 Fuite mémoire — `detachEvents` ne nettoyait pas le pitch bend

**Fichier** : `public/js/features/keyboard/KeyboardEvents.js`

**Problème** : `attachEvents()` appelle `initPitchBendWheel()` qui attache des listeners sur `#pitch-bend-track`, `document:mousemove`, `document:mouseup`, `document:touchmove`, `document:touchend`, `document:touchcancel`. `detachEvents()` n'appelait aucune contrepartie pour ces listeners.

**Correction** : Ajout dans `detachEvents()` d'un bloc symétrique pour la roue de pitch bend.

---

### 18.3 Bug logique — `playNote` bloquait les notes MIDI 0–20 et 109–127

**Fichier** : `public/js/features/keyboard/KeyboardEvents.js`

**Avant** :
```js
if (note < 21 || note > 108) return;  // range 88 touches piano
```

**Après** :
```js
if (note < 0 || note > 127) return;   // plage MIDI complète
```

**Impact** : Le clavier affiche et permet de naviguer sur toute la plage 0–127 (via minimap). Des instruments (synthétiseurs, claviers étendus) peuvent avoir des notes hors du range 88 touches. Les notes visibles et non-disabled dans l'UI ne déclenchaient silencieusement aucun note-on.

---

### 18.4 Bug tactile — `_pianoTouchEnd` ne gérait qu'un seul doigt

**Fichier** : `public/js/features/keyboard/KeyboardPiano.js`

**Avant** :
```js
this._pianoTouchStart = (e) => {
    const key = getKey(e);
    if (key) { e.preventDefault(); this.handlePianoKeyDown(...); }
};
this._pianoTouchEnd = (e) => {
    const key = getKey(e);
    if (key) { e.preventDefault(); this.handlePianoKeyUp(...); }
};
```

`getKey(e)` faisait `e.target.closest('.piano-key')` : un seul élément, le dernier touché.

**Après** : Itération sur `e.changedTouches` pour `touchstart` et `touchend`. Pour `touchend`, utilisation de `document.elementFromPoint(touch.clientX, touch.clientY)` car l'élément sous le doigt relâché est accessible via les coordonnées (pas via `e.target` qui pointe la dernière cible de touchstart).

**Impact** : Le jeu d'accords par touches multiples est maintenant correctement supporté — chaque doigt relâché libère la note correspondante.

---

### 18.5 Suppression des fichiers orphelins

**Fichiers supprimés** :
- `public/js/features/keyboard/KeyboardMidi.js`
- `public/js/features/keyboard/KeyboardDevices.js`

**Raison** : Ces fichiers n'étaient chargés dans **aucun** `<script>` de `index.html` et n'étaient jamais référencés. Ils définissaient des globals `window.KeyboardMidi` et `window.KeyboardDevices` jamais consommés, et contenaient des **duplicats exacts** de méthodes déjà présentes dans les mixins actifs :

| Méthode | Fichier orphelin | Doublon actif |
|---------|-----------------|---------------|
| `playNote`, `stopNote`, `getSelectedChannel` | `KeyboardMidi.js` | `KeyboardEventsMixin` + `KeyboardModal.js` |
| `initModWheel`, `_updateModWheelPosition`, `sendModulation` | `KeyboardMidi.js` | `KeyboardControlsMixin` |
| `updateSlidersVisibility` (version incomplète, sans pitch bend) | `KeyboardMidi.js` | `KeyboardControlsMixin` |
| `loadSettings`, `loadDevices`, `autoCenterKeyboard` | `KeyboardDevices.js` | `KeyboardControlsMixin` + `KeyboardModal.js` |
| `populateDeviceSelect` (ancienne version `<select>`) | `KeyboardDevices.js` | `KeyboardModal._buildInstrumentDropdown` |

`KeyboardDevices.populateDeviceSelect` référençait de plus un élément `#keyboard-device-select` (`<select>`) qui n'existe plus dans le DOM généré (remplacé par le custom dropdown).

---

## 19. Audit d'intégration (2026-05-15)

> **Objectif** : valider que **chaque partie de l'interface du modal est
> fonctionnelle et bien intégrée** au reste de l'application. Audit du
> code (lecture + vérification croisée) sur la branche
> `claude/audit-piano-modal-JKiur`.

### 19.1 Périmètre vérifié

19 contrôles + points d'intégration : sélecteur d'instrument (dropdown
custom + délégation), vélocité, roues modulation (CC#1) & pitch bend,
panneau vent (articulations + souffle CC#2), boutons octave/zoom/molette,
minimap, touches piano/fretboard/drumpad/slider/liste, clavier PC
(AZERTY/QWERTY), multitouch, notation US/FR/MIDI, couleurs chromatiques,
toggles de vue, cycle de vie `open`/`close`, `mountAsPanel`/`unmountPanel`,
callbacks `onNoteOn`/`onNoteOff`/`onInstrumentSelected`, routage backend,
EventBus `bluetooth:*`, localStorage, i18n.

### 19.2 État fonctionnel — synthèse

| Sous-système | Verdict |
|--------------|---------|
| `playNote`/`stopNote` + guard MIDI `0..127` | ✅ Conforme |
| Symétrie `attachEvents`/`detachEvents` (mod-wheel, pitch-bend, minimap, délégation piano, listeners `document`/`window`) | ✅ Symétrique — les listeners anonymes sont sur des éléments retirés avec le container ; tous les listeners `document`/`window` ont leur retrait explicite |
| Roues modulation & pitch bend (`_sendPitchBend` → `midi_send_pitchbend`) | ✅ Définies et nettoyées (mixin `KeyboardSlider`) |
| `updateSlidersVisibility` ↔ `_selectInstrumentOption` (visibilité conditionnelle) | ✅ Cohérent |
| `setViewMode` (toggle des 5 containers + cleanups fretboard/list/hands) | ✅ Correct et symétrique |
| Intégration panel : signatures producteur ↔ `LoopEditorModal` / `LoopManagerKeyboardFeature` | ✅ Identiques |
| Commandes backend (`midi_send_note`, `midi_send_cc`, `midi_send_pitchbend`, `string_instrument_get`, `instrument_get_capabilities`, `instrument_list_capabilities`) | ✅ Toutes enregistrées côté serveur (`src/api/commands/`) |
| `getNoteLabel` / `_resolveKeyToNote` / `_getStringPresetForGmProgram` | ✅ Conforme — désormais **couvert par tests** |

**Aucun défaut fonctionnel** trouvé sur le chemin d'exécution réel
(mixins). Le modal est fonctionnel et bien intégré.

> Note méthodo : deux « bugs critiques » signalés par des agents
> d'exploration (`_sendPitchBend` manquant ; `midi_send_note_on/off`
> « intégration cassée ») ont été **vérifiés et infirmés** —
> `_sendPitchBend` existe (`KeyboardSlider.js:233`) et
> `backend.sendNoteOn/Off` mappe correctement vers `midi_send_note`
> (`BackendAPIClient.js:499/515`, enregistré `MidiCommands.js:224`).

### 19.3 Corrections apportées

**19.3.1 Test cassé — `voicing-engine.test.js`**
Les blocs `describe('strumSchedule')` et `describe('snapToPlayable')`
instanciaient `new (VE())(...)` **dans le corps du `describe`**, exécuté à
la collecte *avant* que le `beforeAll` ne charge `VoicingEngine.js` →
`TypeError: VE(...) is not a constructor`. Corrigé en déplaçant
l'instanciation dans un `beforeEach` (aligné sur les blocs `it()` qui
passaient). Suite voicing : 0 → **30 tests verts**.

**19.3.2 Tests ajoutés — `keyboard-modal-pure.test.js`**
Nouveau fichier (16 tests) couvrant les helpers purs jusqu'ici non
testés : `getNoteLabel` (US/FR/MIDI, bornes 0/21/108/127),
`getNoteNameFromNumber`, `_getStringPresetForGmProgram` (guitares,
basses dont fretless 35, cordes frottées, harpe, sitar/banjo/shamisen/
koto, null), `_resolveKeyToNote` (AZERTY/QWERTY, blanches/noires,
indices hors plage).

Aucune modification du code applicatif (aucun bug fonctionnel à
corriger). Lint clavier : **0 erreur** (7 warnings préexistants mineurs :
`no-console`, 2 `no-unused-vars` — hors périmètre).

### 19.4 Constats d'intégration (non bloquants)

1. **Couche `views/` + registre inerte** (§2.1) — enregistrée au boot
   mais jamais résolue/montée. État Phase C/D attendu, non bloquant.
2. **Logique de détection dupliquée** entre `InstrumentDetector` (actif)
   et `registerBuiltins.js` (inerte) — risque de divergence, **déjà
   gardé** par le test de cohérence dans `views.test.js`.
3. **`mountAsPanel`** n'attend pas `loadDevices()` (`open()` si). Sans
   impact : la délégation du dropdown est posée dans
   `_buildInstrumentDropdown`, pas dans `attachEvents`.

### 19.5 Migration `InstrumentView` — activation (2026-05-15)

Suite à validation, **Phase C/D terminée** : le registre est rendu
autoritaire pour le cycle de vie des vues (KM-C1).

**Modifications code applicatif (minimales, gardées par tests) :**

| Fichier | Changement |
|---------|-----------|
| `KeyboardModal.js` | + champs `_activeView` / `_activeViewKind` / `_pendingViewOptions` ; + méthodes `_buildViewContext()`, `_activateView(kind, options)`, `_legacyRenderForMode(mode)` |
| `KeyboardPiano.js` | `setViewMode()` : le bloc de rendu final (`if mode==='fretboard' renderFretboard()` …) est remplacé par `this._activateView(mode, …)` ; fallback défensif conservé |

**Garanties anti-régression :**
- La vue résolue **délègue** au même code de rendu mixin qu'avant → DOM identique.
- Si le registre/vue est absent ou `mount()` jette → `_legacyRenderForMode()` reproduit le switch historique.
- Cleanups `setViewMode` (string sliders, bow, list, fingers) **conservés** (idempotents) en plus de `view.unmount()`.
- `_selectInstrumentOption`, `playNote`/override vent, visibilité sliders caps-aware : **non modifiés** (évite régressions silencieuses non vérifiables sans navigateur).

**Tests ajoutés** : `tests/frontend/keyboard/view-lifecycle.test.js`
(8 cas) — résolution registre, mount/unmount au changement de kind,
idempotence même-kind, couverture des 5 kinds, fallback legacy,
récupération sur `mount()` en échec. Suite clavier : **11 fichiers /
216 tests verts**.

Le résidu **Phase E** (déplacement physique du rendu hors des mixins,
suppression `Object.assign` + `_windOrigPlayNote`) est documenté et
planifié en **§20.4** — différé car non vérifiable en navigateur ici.

---

## 20. Évolutions — ajouter des vues pour d'autres instruments

> Maintenant que le registre est autoritaire (§2.1, §19.5), ajouter un
> type d'instrument ne touche **aucun fichier existant**.

### 20.1 Recette (≤ 30 min, 1 fichier + 1 règle)

1. Créer `public/js/features/keyboard/views/<Nom>View.js` :

```js
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.InstrumentView) return;
  class AccordionView extends window.InstrumentView {
    static viewKind = 'accordion';
    static emoji    = '🪗';
    static labelKey = 'keyboard.viewAccordion';

    mount(ctx) {
      super.mount(ctx);
      const modal = ctx.modal;
      // Réutiliser un rendu existant (delegation) …
      if (modal && typeof modal.regeneratePianoKeys === 'function') {
        modal.regeneratePianoKeys();
      }
      // … ou rendre dans son propre container #accordion-container
      //    (cf. §20.3 pour le lazy-mount du container).
    }
    unmount() { /* libérer listeners/état spécifiques */ super.unmount(); }
    willPlayNote(midi, velocity, opts) {
      // ex. soufflet → facteur de vélocité
      return { midi, velocity, opts };
    }
    toolbarGroups() { return new Set(['notation', 'velocity']); }
  }
  if (typeof window !== 'undefined') window.AccordionView = AccordionView;
  if (typeof module !== 'undefined') module.exports = AccordionView;
})();
```

2. `index.html` : ajouter le `<script>` **après** `KeyboardModal.js` et
   **avant** `registerBuiltins.js`.
3. `registerBuiltins.js` : `safeRegister(window.AccordionView);` + une
   règle `registry.addRule(c => c && c.gm_program >= 21 && c.gm_program <= 23, 'accordion');`.
4. (Optionnel) ajouter une règle équivalente dans `InstrumentDetector`
   **si** la vue doit être auto-sélectionnée à la détection — le test de
   cohérence `views.test.js` impose que les deux restent alignés.
5. Ajouter un test `tests/frontend/keyboard/` sur le `viewKind` + la règle.

### 20.2 Vues candidates (priorisées)

| Vue | viewKind | GM | Spécificité interaction | Rendu de base réutilisable |
|-----|----------|----|--------------------------|----------------------------|
| Accordéon | `accordion` | 21, 23 | Soufflet (range) = facteur vélocité, clavier + basses Stradella | ✅ **LIVRÉ** — `views/AccordionView.js` |
| Harmonica | `harmonica` | 22 | Rangées souffler/aspirer (Richter C, 10 trous) | ✅ **LIVRÉ** — `views/HarmonicaView.js` |
| Mailloches (marimba/xylo) | `mallet` | 12-15 | 2 rangées (naturelles/altérées), frappe + decay | ✅ **LIVRÉ** — `views/MalletView.js` |
| Harpe | `harp` | 46 | Cordes verticales, glissando = drag X | ✅ **LIVRÉ** — `views/HarpView.js` |
| Cornemuse | `bagpipe` | 109 | Drone constant (togglable) + chanter 9 notes | ✅ **LIVRÉ** — `views/BagpipeView.js` |
| Theremin | `theremin` | type `theremin` | Pad 2-D : X=hauteur (retrigger), Y=volume CC#7 | ✅ **LIVRÉ** — `views/ThereminView.js` |
| Kalimba | `kalimba` | 108 | 17 lamelles, ordre physique centre-sortant | ✅ **LIVRÉ** — `views/KalimbaView.js` |
| Steel drum | `steel-drum` | 114 | Sections disposées en cercle (trigonométrie) | ✅ **LIVRÉ** — `views/SteelDrumView.js` |

**Roadmap §20.2 complète : les 8 vues candidates sont livrées.**
Détection : `accordion` 21/23 · `mallet` 12-15 · `kalimba` 108 ·
`bagpipe` 109 · `steel-drum` 114 · `harmonica` 22 · `harp` 46 (exclu du
fretboard) · `theremin` via `instrument_type='theremin'`. Toutes les
familles établies (drum ch.9/≥128, fretboard 24-47, wind 56-79) gardent
la priorité ; règles registre ↔ `InstrumentDetector` cohérentes (test).

#### 20.2.1 Référence livrée — `HarmonicaView` (preuve de la recette)

`public/js/features/keyboard/views/HarmonicaView.js` est la **première
vue qui possède son propre DOM** (aucune délégation mixin) — modèle de
référence pour la recette §20.1.

- **Détection** : `InstrumentDetector` classe GM 22 → `viewKind:'harmonica'`
  (`isHarmonica`), GM 21/23 restent `piano` ; règle miroir dans
  `registerBuiltins.js` (cohérence garantie par le test `views.test.js`).
- **Sélection** : `_selectInstrumentOption` branche `info.viewKind ===
  'harmonica'` → `setViewMode('harmonica')`. `setViewMode` accepte
  désormais **tout kind enregistré** dans le registre (plus de liste
  `validModes` figée — KM-C1 réellement atteint).
- **Vue** : harmonica diatonique C Richter, 10 trous × (souffler/aspirer),
  lazy-mount de `#harmonica-container` dans `#keyboard-canvas-container`,
  jeu via `modal.playNote/stopNote`, libération globale au `pointerup`
  (modèle `handleGlobalMouseUp`), `unmount()` retire conteneur+listeners
  et coupe les notes tenues, `setActiveNotes()` câblé.
- **Tests** : `tests/frontend/keyboard/harmonica-view.test.js` (13 cas) +
  cas de cohérence GM 22 ajouté à `views.test.js`. Suite clavier :
  **12 fichiers / 230 tests verts**.
- **Fichiers existants touchés** : uniquement les points d'extension
  prévus (`InstrumentDetector`, `registerBuiltins`, `setViewMode`
  généralisé, 1 branche `_selectInstrumentOption`, 1 `<script>`) — aucune
  vue existante modifiée.

> ⚠️ **À tester en navigateur** : rendu visuel des trous, jeu
> souris/tactile, retour piano via le toggle de vue, sélection auto sur
> un instrument GM 22 réel. Les styles sont inline (aucun CSS dédié) —
> un passage `keyboard.css` est souhaitable pour l'intégration visuelle.

#### 20.2.2 Référence livrée — `HarpView` (2ᵉ vue, GM 46)

`public/js/features/keyboard/views/HarpView.js` — 22 cordes verticales
Do majeur (Do3→Do6), pincement au `pointerdown`, **glissando** au drag
horizontal (chaque corde traversée est pincée une fois), libération
globale au `pointerup`. Repères Do (rouge) / Fa (sombre).

- **Détection** : GM 46 **exclu** de la plage fretboard 24-47 dans
  `InstrumentDetector` → `viewKind:'harp'`, `canFretboard:false`,
  `isHarp:true`. **Échappatoire préservée** : `instrument_type='string'`
  ou un `stringInstrumentConfig` manuel reforcent le fretboard.
  Règle registre `gm===46 → harp` placée **avant** `inRange(24,47)`
  (premier match gagne). GM 45/47 restent fretboard.
- **Branche** : `_selectInstrumentOption` route `info.viewKind === 'harp'`.
- **Tests** : `tests/frontend/keyboard/harp-view.test.js` (13 cas, dont
  glissando + échappatoire string-type) + cas de cohérence GM 46 dans
  `views.test.js`. Suite clavier : **13 fichiers / 244 tests verts**.
- **Fichiers existants touchés** : mêmes points d'extension que
  l'harmonica + l'exclusion ciblée de GM 46. Aucune vue existante
  modifiée.

> ⚠️ **À tester en navigateur** : rendu/ergonomie des cordes, glissando
> tactile multi-doigts, sélection auto sur un GM 46 réel, CSS dédié
> (`keyboard.css`). Le glissando réutilise `pointermove` (souris bouton
> enfoncé) ; le multi-touch fin (par `pointerId`) est une amélioration
> possible (cf. §20.3.1).

#### 20.2.3 Roadmap complète — 6 vues additionnelles livrées

Les 6 vues restantes du roadmap, toutes auto-détectées, à DOM propre,
même contrat de cycle de vie que Harmonica/Harpe :

| Vue | Fichier | Particularité d'interaction |
|-----|---------|------------------------------|
| `AccordionView` | `views/AccordionView.js` | Clavier 2 oct + 12 basses Stradella + soufflet (`<input range>` → `willPlayNote` × facteur) |
| `MalletView` | `views/MalletView.js` | 2 rangées marimba (naturelles hautes / altérées décalées), C4-B5 |
| `KalimbaView` | `views/KalimbaView.js` | 17 lamelles, ordre physique **centre-sortant** alterné, hauteur dégressive |
| `BagpipeView` | `views/BagpipeView.js` | Drone A2 auto au mount (togglable) + chanter GHB 9 notes, drone coupé au unmount |
| `SteelDrumView` | `views/SteelDrumView.js` | 24 sections en cercle (positionnement trigonométrique) |
| `ThereminView` | `views/ThereminView.js` | Pad 2-D : X→note (retrigger au franchissement de demi-ton), Y→volume CC#7, curseur visuel |

- **Détection** : flags ajoutés à `InstrumentDetector` (`isAccordion`,
  `isMallet`, `isKalimba`, `isBagpipe`, `isSteelDrum`, `isTheremin`),
  tous gardés par `!isDrum && !canFretboard && !isWind`. Theremin via
  `instrument_type` (aucun GM volé). Règles miroir dans
  `registerBuiltins.js`.
- **Sélection** : une branche groupée dans `_selectInstrumentOption`.
- **Tests** : `tests/frontend/keyboard/extra-instrument-views.test.js`
  (33 cas : détection, cycle de vie data-driven pour les 4 « pluck »,
  blocs dédiés bellows/drone/pad) + 8 cas de cohérence ajoutés à
  `views.test.js`. **Suite clavier : 14 fichiers / 285 tests verts,
  ESLint 0 erreur.**
- **Régression assumée & corrigée** : GM 21/23 passaient « piano », ils
  sont désormais « accordion » (comportement voulu) — l'assertion
  obsolète de `harmonica-view.test.js` a été mise à jour.

> ⚠️ **À tester en navigateur** (tous) : rendu visuel, ergonomie
> tactile, sélection auto sur instruments GM réels, CSS dédié. Les
> styles sont inline ; un thème `keyboard.css` par vue est souhaitable.
> Theremin : le mapping X/Y exact dépend du layout réel (en test, jsdom
> n'a pas de layout → géométrie de repli `PAD_W=480`).

### 20.3 Extensions de contrat recommandées

Pour des vues riches sans réécrire l'orchestrateur :

1. **`willPlayNote` post-play / auto-off** — le contrat actuel transforme
   seulement (vélocité, annulation). Ajouter un retour optionnel
   `{ autoOffMs }` ou un hook `afterPlayNote(midi)` permettrait de porter
   le **staccato vent** (timers d'auto-stop) hors du mixin → prérequis
   pour retirer l'override `KeyboardWindMixin.playNote` (KM-C4).
2. **`toolbarGroups()` déclaratif caps-aware** — aujourd'hui la visibilité
   sliders est impérative + caps-aware (mod-wheel si CC#1…). Faire que le
   contrôleur applique `view.toolbarGroups()` **∩** capacités déclarées
   supprimerait la logique impérative de `setViewMode`/`updateSlidersVisibility`.
3. **Lazy-mount du container** — `createModal()` crée les 5 containers en
   dur (KM-F1). Un `view.createHost()` créant `#<kind>-container` à la
   première activation allègerait le DOM (~−15 %).
4. **`setActiveNotes(set)`** — déjà dans le contrat, non câblé : utile
   pour refléter des notes jouées par une source externe (playback,
   MIDI in) dans la vue active.

### 20.4 Décommission Phase E (résidu, nécessite QA navigateur)

Étapes mécaniques restantes, **à faire avec validation navigateur** car
non testables en jsdom et porteuses de régressions silencieuses :

1. Étendre le contrat `willPlayNote` (§20.3.1) puis **déplacer**
   l'articulation + staccato de `KeyboardWindMixin.playNote` vers
   `PianoSliderView` ; supprimer l'override + `_windOrigPlayNote` +
   le `Object.defineProperty` associé (KM-C4).
2. Basculer la visibilité toolbar sur `toolbarGroups()` ∩ caps (§20.3.2),
   retirer la logique impérative correspondante.
3. Déplacer le corps de `renderFretboard`/`renderDrumPad`/
   `generatePianoSlider`/`renderKeyboardList`/`generatePianoKeys` de
   `KeyboardPiano.js` (2 052 l.) vers les classes de vue respectives ;
   extraire l'overlay mains en service `HandsOverlay` (KM-C2).
4. Externaliser le HTML de `createModal()` + lazy-mount containers (KM-E2/F1).
5. Supprimer `_applyMixin` + les 7 mixins une fois (3)+(4) faits (KM-C4).
6. Renommer résidus `KeyboardModalNew` (aucun restant côté JS — vérifié).

Chaque étape : un commit isolé, suite vitest verte, **QA navigateur**
(ouvrir le modal sur piano / guitare / batterie / violon / sax alto /
xylophone → bonne vue, jeu souris+clavier PC, fermeture propre).
