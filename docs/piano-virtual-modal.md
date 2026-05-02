# Piano Virtuel — Documentation complète

> **Scope** : Modal du clavier virtuel de General-Midi-Boop (`KeyboardModalNew` et ses mixins).  
> **Version auditée** : `1.1.0` — audit réalisé le 2026-05-02.

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
├── KeyboardModal.js              ← Classe principale KeyboardModalNew
│                                    État, cycle de vie, MIDI, sélection d'instrument
│
└── keyboard/
    ├── KeyboardPiano.js          ← Mixin KeyboardPianoMixin
    │                                Génération DOM piano/fretboard/drumpad/slider
    │                                Minimap, octave bar, fingers overlay
    │
    ├── KeyboardEvents.js         ← Mixin KeyboardEventsMixin
    │                                attachEvents / detachEvents
    │                                playNote / stopNote
    │                                _resolveKeyToNote (clavier PC)
    │
    ├── KeyboardControls.js       ← Mixin KeyboardControlsMixin
    │                                loadSettings / loadDevices
    │                                Mod wheel, pitch bend wheel
    │                                updateSlidersVisibility
    │
    ├── KeyboardChords.js         ← Mixin KeyboardChordsMixin
    │                                Accordages, mode accords, main widget
    │                                Rendu des boutons d'accords (fretboard)
    │
    ├── KeyboardSlider.js         ← Mixin KeyboardSliderMixin
    │                                Drag pitch bend sur le piano-slider
    │                                Mode glissement par corde (fretboard)
    │
    ├── KeyboardListView.js       ← Mixin KeyboardListViewMixin
    │                                Rendu et interaction de la vue liste
    │
    ├── NoteEngine.js             ← Classe NoteEngine (pure, sans DOM)
    │                                Gammes, mapping position→note MIDI
    │
    ├── NoteSlider.js             ← Classe NoteSlider (UI)
    │                                Slider horizontal de sélection de note avec gamme
    │
    └── VoicingEngine.js          ← Classe VoicingEngine (pure, sans DOM)
                                     Mapping accord→cordes, scheduling strum

public/styles/
    ├── keyboard-modal.css        ← Modal overlay, header, dropdown instrument
    ├── keyboard.css              ← Touches piano (blanc/noir), fretboard, drum pad
    ├── keyboard-polish.css       ← Animations, transitions, états hover/active
    └── piano-roll-view.css       ← Vue piano-roll (séparée du modal)
```

### Chargement dans index.html (ordre obligatoire)

```html
<!-- Moteurs purs (pas de dépendance DOM) -->
<script src="js/features/keyboard/NoteEngine.js"></script>
<script src="js/features/keyboard/VoicingEngine.js"></script>
<script src="js/features/keyboard/NoteSlider.js"></script>

<!-- Mixins du modal (chargés avant KeyboardModal.js) -->
<script src="js/features/keyboard/KeyboardPiano.js"></script>
<script src="js/features/keyboard/KeyboardEvents.js"></script>
<script src="js/features/keyboard/KeyboardControls.js"></script>
<script src="js/features/keyboard/KeyboardChords.js"></script>
<script src="js/features/keyboard/KeyboardSlider.js"></script>
<script src="js/features/keyboard/KeyboardListView.js"></script>

<!-- Classe principale -->
<script src="js/features/KeyboardModal.js"></script>
```

> **Important** — L'ordre est critique. `KeyboardModal.js` applique les mixins via `Object.assign(KeyboardModalNew.prototype, MixinXxx)` après la définition de la classe. Un mixin chargé après `KeyboardModal.js` ne sera pas appliqué.

### Composition par mixins

```
KeyboardModalNew (classe)
    ← KeyboardPianoMixin    (createModal, generatePianoKeys, renderFretboard, renderDrumPad, …)
    ← KeyboardEventsMixin   (attachEvents, detachEvents, playNote, stopNote, _resolveKeyToNote)
    ← KeyboardControlsMixin (loadSettings, loadDevices, initModWheel, initPitchBendWheel, …)
    ← KeyboardChordsMixin   (renderChordButtons, renderHandWidget, _mapChordToStrings, …)
    ← KeyboardSliderMixin   (initPianoSliderDrag, initStringSliderMode, …)
    ← KeyboardListViewMixin (renderKeyboardList, _destroyKeyboardListInteraction)
```

En cas de méthode définie dans plusieurs mixins, **le dernier mixin appliqué l'emporte**. Aucun conflit actuel n'existe entre les mixins actifs.

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
1. `backend.listDevices()` → filtre `status === 2` (actifs)
2. Déduplication par `name` (Set)
3. Expansion des appareils multi-instruments (`device.instruments[]`) → un slot par canal
4. Chargement optionnel des instruments virtuels DB (si `virtualInstrument: true` dans les settings)
5. Enrichissement parallèle des noms custom via `instrument_get_settings` (N appels parallèles)

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

- `loadDevices()` émet N requêtes API parallèles (une par instrument non-virtuel) pour les noms custom. Avec de nombreux instruments, la latence d'ouverture peut augmenter.
- `regeneratePianoKeys()` détruit et recrée intégralement le DOM clavier à chaque zoom/scroll. Sur mobile bas de gamme, ce peut être perceptible sur des plages larges.

---

## 16. Tests

### 16.1 Tests existants

| Fichier | Ce qui est testé |
|---------|-----------------|
| `tests/frontend/keyboard-preview.test.js` | `KeyboardPreview` (auto-assign) |
| `tests/frontend/hand-position-editor-modal.test.js` | `KeyboardHandPositionEditorModal` |

### 16.2 Coverage manquante (à ajouter)

- `isNotePlayable()` — modes range, discrete, no-caps
- `autoCenterKeyboard()` — range, discrete, no-caps, edge cases MIDI 0/127
- `getNoteLabel()` — les 3 formats, octaves extrêmes
- `_resolveKeyToNote()` — AZERTY/QWERTY, touches blanches et noires
- `renderOctaveBar()` — vérifier labels corrects, absence de NaN
- `getInstrumentViewInfo()` — détection drum/string/piano automatique
- `_getStringPresetForGmProgram()` — couverture de tous les programmes GM

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
