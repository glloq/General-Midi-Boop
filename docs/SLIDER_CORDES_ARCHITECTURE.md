# Architecture : Slider de Notes & Vue Cordes

> Analyse, verdict et plan d'intégration modulaire  
> Branche : `claude/analyze-slider-chord-separation-zODHX`

---

## 1. Verdict

**La séparation Slider / Cordes est VALIDE et recommandée.**

Les deux composants répondent à des problèmes orthogonaux :

| Dimension | Slider de notes | Vue Cordes |
|---|---|---|
| **Paradigme d'entrée** | Glissement continu ou discret (1D) | Boutons d'accord + strum (2D) |
| **Métaphore musicale** | Piano / theremin | Guitare / basse |
| **Sortie primaire** | Une note (+ velocity) | N notes séquencées (strum) |
| **Contraintes physiques** | Gamme, plage MIDI | Cordier, positions jouables, polytonie |
| **État interne** | Position courante, gamme active | Root accord, position main, tuning |

Les deux convergent vers la même API de bas niveau : `playNote(note, velocity)` /
`stopNote(note)`. Le couplage actuel dans `KeyboardModal` est purement circonstanciel
(historique de développement), pas architectural.

---

## 2. État actuel du code (dépendances relevées)

```
KeyboardModal (orchestrateur monolithique)
│
├── KeyboardPiano    — rendu piano roll, clic touche → playNote()
├── KeyboardMidi     — playNote() / stopNote() → backend.sendNoteOn()
├── KeyboardControls — modWheel (Y→CC1), velocity slider, device picker
├── KeyboardChords   — accord root, mapChordToStrings(), strum, handWidget
│     ├── CHORD_INTERVALS / CHORD_INTERVALS_ALT  ← données musicales pures
│     └── _mapChordToStrings()                  ← logique pure embarquée dans UI
└── KeyboardEvents   — clavier physique QWERTY/AZERTY → playNote()
```

### Couplages problématiques identifiés

1. **`chordRoot` stocké sur l'instance modale** → état musical pollué par UI state.
2. **`_mapChordToStrings()` dans le mixin UI** → impossible à tester unitairement
   sans instancier le modal complet.
3. **Gamme = absente** → le slider piano est chromatique pur, aucun filtrage
   diatonique/pentatonique.
4. **Strum cancelable mais non isolé** → `_strumTimeouts[]` mélangé avec l'état DOM.
5. **`selectedDeviceCapabilities`** partagé entre tous les mixins → couplage fort
   sur l'objet instrument sans interface définie.

---

## 3. Architecture cible

```
┌──────────────────────────────────────────────────────────────────────┐
│                   MOTEUR COMMUN  (pur, zéro DOM)                     │
│                                                                      │
│  ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────┐    │
│  │   NoteEngine    │  │   ChordEngine    │  │  VoicingEngine   │    │
│  │                 │  │                  │  │                  │    │
│  │ setScale()      │  │ CHORD_INTERVALS  │  │ mapToStrings()   │    │
│  │ noteFromPos()   │  │ build(root,type) │  │ strumSchedule()  │    │
│  │ filterScale()   │  │ altVoicing()     │  │ snapToPlayable() │    │
│  │ noteName()      │  │                  │  │ maxPoly()        │    │
│  └────────┬────────┘  └────────┬─────────┘  └────────┬─────────┘    │
│           │                   │                      │              │
│           └───────────────────┴──────────────────────┘              │
│                               │                                      │
│                    ┌──────────▼──────────┐                          │
│                    │     PlayEngine      │                           │
│                    │                     │                           │
│                    │ scheduleStrum()     │                           │
│                    │ sendNoteOn/Off()    │                           │
│                    │ cancelPending()     │                           │
│                    └─────────────────────┘                           │
└──────────────────────────────────────────────────────────────────────┘
          ▲                                        ▲
          │                                        │
┌─────────┴──────────┐                  ┌──────────┴────────────┐
│    NoteSlider      │                  │     StringView        │
│    (module UI)     │                  │     (module UI)       │
│                    │                  │                       │
│  X → note (gamme)  │──onNoteChange()→│  chord root buttons   │
│  Y → velocity      │                  │  fretboard display    │
│  continuous / snap │                  │  hand widget          │
│  highlight gamme   │                  │  strum animation      │
└─────────────────────┘                  └───────────────────────┘
          │                                        │
          └───────────────┬────────────────────────┘
                          ▼
                   KeyboardModal
                   (orchestrateur léger)
                   - selectedDevice
                   - backend adapter
                   - mode toggle (slider / cordes)
```

---

## 4. Responsabilités de chaque module

### 4.1 NoteEngine `(NoteEngine.js)`

Moteur pur, sans DOM. Calcule la note MIDI depuis une position normalisée et gère
les gammes.

```
setScale(root: 0–11, type: 'chromatic'|'major'|'minor'|'pentatonic'|'blues')
setRange(minNote: int, maxNote: int)
noteFromPosition(x: 0..1, width: px) → int          // snap sur gamme
noteFromPositionContinuous(x: 0..1, width: px) → float  // pitch bend
getScaleNotes() → int[]                              // notes de la gamme dans la plage
noteName(note: int, format: 'english'|'solfege'|'midi') → string
```

**Gammes prédéfinies** (intervalles en demi-tons depuis la fondamentale) :

| Type | Intervalles |
|---|---|
| chromatic | 0 1 2 3 4 5 6 7 8 9 10 11 |
| major | 0 2 4 5 7 9 11 |
| minor | 0 2 3 5 7 8 10 |
| pentatonic | 0 2 4 7 9 |
| blues | 0 3 5 6 7 10 |

### 4.2 VoicingEngine `(VoicingEngine.js)`

Extraction et enrichissement de `_mapChordToStrings()`. Pur, testable unitairement.

```
constructor(tuning: int[], numStrings: int)
maxPoly(gmProgram: int) → int
mapChordToStrings(rootClass: 0–11, intervals: int[]) → VoicingNote[]
strumSchedule(voicing: VoicingNote[], direction: 'down'|'up', delayMs: int)
  → Array<{note: int, delay: int}>
snapToPlayable(targetNote: int, handAnchor: int, handSpan: int) → VoicingNote
```

`VoicingNote = { string: int, note: int, fret: int, time: int }`

### 4.3 NoteSlider `(NoteSlider.js)`

Module UI autonome. Canvas horizontal. Émet des événements, ne connaît pas le backend.

```
constructor(container: HTMLElement, noteEngine: NoteEngine, options)
setScale(root, type)      // délégue à noteEngine, re-render
setRange(minNote, maxNote)
setMode('discrete' | 'continuous')
on('notechange', (note: int|float, velocity: int, continuous: bool) => void)
on('noteoff',   (note: int) => void)
render()
destroy()
```

### 4.4 StringView (existant = `KeyboardChords` + `KeyboardPiano.renderFretboard`)

Refactoriser pour que :
- l'état musical (`chordRoot`, `stringInstrumentConfig`) soit passé en paramètre,
  non pioché sur `this`.
- `_mapChordToStrings` délègue à `VoicingEngine`.
- Le strum délègue à `PlayEngine`.

---

## 5. Formats de données communs

```javascript
// Note MIDI canonique
// int pour discret, float pour continu (pitch bend)
type MidiNote = number; // 0–127 (int) ou float pour pitch bend

// Événement de voicing
type VoicingNote = {
  string: number,   // 1-based
  note:   number,   // MIDI int
  fret:   number,   // 0+ (0 = corde à vide)
  time:   number,   // offset ms depuis début du strum
};

// Gamme
type ScaleConfig = {
  root: number,    // classe de hauteur 0–11
  type: 'chromatic' | 'major' | 'minor' | 'pentatonic' | 'blues',
};

// Options instrument (sous-ensemble pertinent)
type InstrumentContext = {
  tuning:      number[],  // MIDI par corde (index 0 = grave)
  num_strings: number,
  num_frets:   number,
  is_fretless: boolean,
  gm_program:  number,    // pour maxPoly()
  note_range_min: number,
  note_range_max: number,
  note_selection_mode: 'discrete' | 'continuous',
};
```

---

## 6. Modes d'intégration Slider → Cordes

### Mode A — Root Control ★ recommandé

```
Slider position → rootClass → ChordEngine.build() → VoicingEngine.mapToStrings()
→ StringView.highlight() + PlayEngine.scheduleStrum()
```

Le slider change la fondamentale de l'accord actif en temps réel.
Le type d'accord (Maj/Min/…) reste sélectionné sur les boutons cordes.

**Faisabilité** : immédiate — `chordRoot` est déjà l'état pivot.  
**Qualité musicale** : excellente (toujours un accord cohérent).  
**Complexité** : faible.

### Mode B — Overlay Cordes

```
Slider position → targetNote → VoicingEngine.snapToPlayable(note, anchor, span)
→ highlight string + note jouée
```

Le slider contrôle directement quelle corde est frappée, en snappant sur la position
jouable la plus proche.

**Faisabilité** : moyenne (nécessite `snapToPlayable` + mapping par corde).  
**Qualité musicale** : bonne si la main est bien positionnée.  
**Complexité** : modérée.

### Mode C — Hybrid

```
Slider → note principale jouée seule  +  accord actif reste affiché (fantôme)
```

Permet de "choisir" une mélodie sur fond d'accord visible.

**Faisabilité** : facile.  
**Qualité musicale** : excellente pour improvisation.  
**Complexité** : faible.

---

## 7. Pseudo-code d'intégration

```javascript
// --- Initialisation (KeyboardModal.initSlider) ---
const noteEngine  = new NoteEngine();
const noteSlider  = new NoteSlider(sliderContainer, noteEngine, {
  minNote: 36, maxNote: 84, mode: 'discrete'
});

noteEngine.setScale(0, 'major');   // C major par défaut

// --- Mode A : Root Control ---
noteSlider.on('notechange', (note, velocity, continuous) => {
  const rootClass = note % 12;
  this.chordRoot = rootClass;                   // state pivot partagé
  this._updateChordRootUI(rootClass);
  if (!continuous) {
    this._maybePlayPreview(note, velocity);     // aperçu sonore optionnel
  }
});

// --- Mode B : Overlay Cordes ---
noteSlider.on('notechange', (note, velocity, continuous) => {
  const voicingNote = voicingEngine.snapToPlayable(
    note, this.handAnchorFret, this._handSpanFrets
  );
  this._showSingleStringHighlight(voicingNote);
  this.playNote(voicingNote.note);
});
noteSlider.on('noteoff', (note) => {
  this.stopNote(note);
  this._clearSingleStringHighlight();
});

// --- Mode C : Hybrid ---
noteSlider.on('notechange', (note, velocity) => {
  this.playNote(note, velocity);
  // La vue cordes garde l'accord précédent affiché (pas de re-trigger)
});

// --- Strum depuis boutons cordes (inchangé mais découplé) ---
chordBtn.addEventListener('mousedown', (e) => {
  const intervals  = CHORD_INTERVALS[chordType];
  const voicing    = voicingEngine.mapChordToStrings(this.chordRoot, intervals);
  const schedule   = voicingEngine.strumSchedule(voicing, direction, delayMs);
  playEngine.scheduleStrum(schedule, this.velocity,
    (note) => this.playNote(note),
    (note) => this.stopNote(note)
  );
  this._showChordVoicing(voicing);
});
```

---

## 8. Stratégie performance

### Throttling du drag
```javascript
// Dans NoteSlider — throttle à 16 ms (~60 fps) sur mousemove
let _lastEmitTime = 0;
const onMove = (x) => {
  const now = performance.now();
  if (now - _lastEmitTime < 16) return;
  _lastEmitTime = now;
  const note = noteEngine.noteFromPosition(x, sliderWidth);
  emit('notechange', note, velocity, false);
};
```

### Cache des gammes
```javascript
// NoteEngine — cache invalidé sur setScale()
_scaleCache = null;
getScaleNotes() {
  if (!this._scaleCache) {
    this._scaleCache = this._buildScaleNotes();
  }
  return this._scaleCache;
}
```

### Pré-calcul du voicing
```javascript
// VoicingEngine — recalcul uniquement si root ou type changent
_voicingCache = new Map(); // key: `${rootClass}:${chordType}`
mapChordToStrings(rootClass, intervals) {
  const key = `${rootClass}:${intervals.join(',')}`;
  if (!this._voicingCache.has(key)) {
    this._voicingCache.set(key, this._compute(rootClass, intervals));
  }
  return this._voicingCache.get(key);
}
```

### Latence perçue
- Strum : setTimeout existant (5–25 ms/corde) → inchangé, correct.
- Slider discret : `playNote` sur chaque snap → acceptable (note-on seul).
- Slider continu : `sendPitchBend` throttlé à 16 ms → aucune note supplémentaire.

---

## 9. Recommandations UX

### Visibilité du slider
- **Option recommandée** : toggle dans l'en-tête du modal (icône 🎹 / 🎸 existante),
  le slider remplace la vue piano roll quand activé.
- Ne pas superposer slider et fretboard — deux surfaces de toucher concurrentes.

### Feedback visuel
| Action | Feedback |
|---|---|
| Glissement slider | Note courante surlignée sur fretboard (si mode B/C) |
| Snap gamme | Tick visuel sur la graduation de la gamme |
| Strum depuis slider (Mode A) | Animation sweep existante sur le bouton accord |
| Root changé | Boutons root mis à jour en temps réel |

### Ergonomie mobile
- Slider horizontal = largeur maximale → pouce naturel.
- Graduation visible : marques plus épaisses sur les degrés importants (1, 3, 5).
- Zone de velocity : conserver le slider vertical existant (Y-axis indépendant).

### Slider contraint par instrument (bonus)
Si `instrument.constrain_slider` est activé dans les réglages :
- Plage réduite à `[note_range_min, note_range_max]` de l'instrument.
- Gamme forcée sur la gamme de l'accord actif (`chord_scale` mode).
- Positions impossibles (hors portée) grisées visuellement.

---

## 10. Risques techniques

| Risque | Probabilité | Impact | Mitigation |
|---|---|---|---|
| Double émission note (slider + key physique simultané) | Faible | Moyen | `activeNotes` Set existant = protection naturelle |
| Pitch bend continu + note-on → artefact synthé | Moyen | Faible | Désactiver pitch bend si `note_selection_mode = 'discrete'` |
| Cache voicing périmé après changement de tuning | Moyen | Moyen | Invalider `_voicingCache` sur `stringInstrumentConfig` changed |
| Strum + slider simultanés → saturation polytonie | Faible | Moyen | Appeler `cancelPending()` avant tout nouveau strum |
| Performance canvas slider sur mobile bas de gamme | Faible | Faible | Throttle 16 ms + canvas léger (pas de shadows) |

---

## 11. Résumé des fichiers à créer / modifier

| Fichier | Action | Priorité |
|---|---|---|
| `public/js/features/keyboard/NoteEngine.js` | **Créer** | P0 |
| `public/js/features/keyboard/VoicingEngine.js` | **Créer** | P0 |
| `public/js/features/keyboard/NoteSlider.js` | **Créer** | P0 |
| `public/js/features/keyboard/KeyboardChords.js` | **Refactorer** `_mapChordToStrings` → déléguer à VoicingEngine | P1 |
| `public/js/features/keyboard/KeyboardModal.js` | **Adapter** init slider, wire modes A/B/C | P1 |
| `public/html/keyboard-modal.html` | **Ajouter** conteneur slider + toggle | P2 |
| `public/css/keyboard.css` | **Ajouter** styles slider (graduation, thumb) | P2 |
