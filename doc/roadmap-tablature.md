# Roadmap - Tablature pour instruments a cordes

## Vue d'ensemble

Ajout d'un systeme complet de tablature dans l'editeur MIDI de Ma-est-tro,
permettant la visualisation, l'edition et la conversion bidirectionnelle
MIDI <-> tablature pour les instruments a cordes (guitare, basse, ukulele,
violon, etc.).

---

## Phase 1 - Modele de donnees et backend [TERMINEE]

**Commit**: `77f761a`

- [x] Migration SQL `024_string_instruments.sql` (tables `string_instruments` + `string_instrument_tablatures`)
- [x] `StringInstrumentDatabase.js` - CRUD + 12 presets de tuning
- [x] `StringInstrumentCommands.js` - 10 commandes WebSocket
- [x] Constantes CC20 (STRING_SELECT) et CC21 (FRET_SELECT) dans `constants.js`
- [x] Cles i18n (en.json) pour tablature et string instruments

## Phase 2 - Moteur de conversion MIDI <-> Tablature [TERMINEE]

**Commit**: `747e0e5`

- [x] `TablatureConverter.js` - conversion bidirectionnelle
- [x] Algorithme backtracking pour assignation des accords
- [x] Optimisation de position de main (minimiser les deplacements)
- [x] Validation de jouabilite (ecart max de frettes)
- [x] Support instruments sans frettes (fretless)
- [x] Fallback greedy quand le backtracking echoue
- [x] Generation CC20/CC21 lors de la conversion tab -> MIDI

## Phase 3 - Editeur frontend et diagramme de manche [TERMINEE]

**Commit**: `8419fd8`

- [x] `TablatureEditor.js` - orchestrateur principal
- [x] `TablatureRenderer.js` - rendu canvas de la tablature classique
- [x] `FretboardDiagram.js` - diagramme de manche vertical temps-reel
- [x] `tablature.css` - styles avec support theme clair/sombre
- [x] Synchronisation bidirectionnelle avec le piano roll
- [x] Saisie inline des numeros de frettes
- [x] Playhead synchronise pendant la lecture
- [x] Zoom (ticksPerPixel) et scroll
- [x] Selection (click + box select)
- [x] Integration dans MidiEditorModal et MidiEditorChannelPanel (bouton toggle)

---

## Phase 4 - UI de configuration des instruments a cordes [A FAIRE]

L'API backend existe deja (Phase 1), mais il n'y a pas d'interface utilisateur
pour gerer les instruments a cordes.

- [ ] Panel/modal de configuration accessible depuis l'editeur MIDI
- [ ] Formulaire creation/edition d'instrument (nom, nb cordes, nb frettes, tuning)
- [ ] Liste des instruments configures avec suppression
- [ ] Selecteur de presets (les 12 presets existants)
- [ ] Indication du capo (position + transposition)
- [ ] Association automatique instrument <-> device/channel

## Phase 5 - Drag & drop et manipulation avancee des events [A FAIRE]

Le renderer gere la selection mais pas le deplacement des notes.

- [ ] Drag horizontal pour deplacer un event dans le temps (tick)
- [ ] Drag vertical pour changer de corde
- [ ] Resize (drag bord droit) pour modifier la duree
- [ ] Deplacement par groupe (selection multiple)
- [ ] Snap to grid (quantification au beat/sub-beat)
- [ ] Feedback visuel pendant le drag (ghost/preview)

## Phase 6 - Undo / Redo [A FAIRE]

Aucun systeme d'historique n'existe dans l'editeur tablature.

- [ ] Pile d'actions undo/redo pour l'editeur tablature
- [ ] Actions: ajout, suppression, deplacement, edition de frette
- [ ] Raccourcis clavier Ctrl+Z / Ctrl+Shift+Z
- [ ] Synchronisation de l'historique avec le piano roll (si partage)

## Phase 7 - Copier / Coller [A FAIRE]

- [ ] Copier la selection (Ctrl+C)
- [ ] Coller a la position du curseur (Ctrl+V)
- [ ] Couper (Ctrl+X)
- [ ] Dupliquer la selection (Ctrl+D)
- [ ] Gestion intelligente du decalage temporel au collage

## Phase 8 - Techniques de jeu guitaristiques [A FAIRE]

Representer les articulations specifiques aux instruments a cordes,
au-dela des simples notes.

- [ ] Hammer-on / Pull-off (liaison ascendante/descendante)
- [ ] Slide (glisse entre frettes)
- [ ] Bend (tire de corde) avec indication du demi-ton
- [ ] Vibrato
- [ ] Palm mute / Harmoniques
- [ ] Representation visuelle de chaque technique sur la tablature
- [ ] Mapping vers les CC MIDI correspondants
- [ ] Raccourcis clavier pour appliquer une technique a la selection

## Phase 9 - Export et impression [A FAIRE]

- [ ] Export tablature en texte ASCII (format standard guitare)
- [ ] Export PDF de la tablature
- [ ] Option d'impression directe
- [ ] Choix du format : tablature seule, ou tablature + portee standard

## Phase 10 - Tests et robustesse [A FAIRE]

- [ ] Tests unitaires TablatureConverter (conversion MIDI -> tab, tab -> MIDI)
- [ ] Tests unitaires StringInstrumentDatabase (CRUD, presets, validation)
- [ ] Tests d'integration commandes WebSocket tablature
- [ ] Tests frontend (renderer, editor, interactions)
- [ ] Gestion des cas limites (fichier vide, instrument sans cordes, etc.)
- [ ] Performance : grands fichiers MIDI (milliers de notes)

---

## Notes techniques

### Fichiers existants

| Composant | Chemin |
|-----------|--------|
| Converter | `src/midi/TablatureConverter.js` |
| Database | `src/storage/StringInstrumentDatabase.js` |
| Commands | `src/api/commands/StringInstrumentCommands.js` |
| Editor | `public/js/views/components/TablatureEditor.js` |
| Renderer | `public/js/views/components/TablatureRenderer.js` |
| Fretboard | `public/js/views/components/FretboardDiagram.js` |
| Styles | `public/styles/tablature.css` |
| Migration | `migrations/024_string_instruments.sql` |
| Constants | `src/constants.js` (CC20, CC21) |
| i18n | `public/locales/en.json` |

### Architecture

- Backend: Node.js (Express) + SQLite
- Frontend: Vanilla JS + Canvas 2D
- Communication: WebSocket (commandes JSON)
- Rendu tablature: Canvas maison (pas de lib externe type VexTab)
- Sync tab <-> piano roll via events custom (`tab:addevent`, `tab:editevent`, `tab:selectionchange`)
