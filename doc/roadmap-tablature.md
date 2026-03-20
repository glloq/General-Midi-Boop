# Roadmap — Systeme de Tablature pour Instruments a Cordes

> Derniere mise a jour : 2026-03-20
> Alignee sur la roadmap originale en 7 phases

## Vue d'ensemble

Ajout d'un systeme complet de tablature dans l'editeur MIDI de Ma-est-tro,
permettant la visualisation, l'edition et la conversion bidirectionnelle
MIDI <-> tablature pour les instruments a cordes (guitare, basse, ukulele,
violon, etc.).

---

## Phase 1 : Modele de donnees & Backend [TERMINEE]

**Commit** : `77f761a`

### 1.1 — Migration SQL `024_string_instruments.sql`
- [x] Table `string_instruments` (id, device_id, channel, instrument_name, num_strings, num_frets, tuning JSON, is_fretless, capo_fret)
- [x] Contrainte UNIQUE(device_id, channel), index, trigger updated_at
- [x] Table `string_instrument_tablatures` (id, midi_file_id, channel, string_instrument_id, tablature_data JSON)
- [x] FK vers string_instruments avec CASCADE delete

### 1.2 — StringInstrumentDatabase.js
- [x] CRUD complet (create, get, getById, getAll, getByDevice, update, delete, deleteByDeviceChannel)
- [x] 18 presets d'accordage (guitare x8, basse x4, ukulele x2, banjo, violon, alto, violoncelle, contrebasse)
- [x] Validation (nb cordes 1-6, tuning.length === num_strings, notes 0-127, capo 0-36)
- [x] CRUD tablatures (save, get, getByFile, delete, deleteByFile)

### 1.3 — Commandes WebSocket (StringInstrumentCommands.js)
- [x] string_instrument_create / _update / _delete / _get / _list
- [x] string_instrument_get_presets / _apply_preset
- [x] tablature_save / _get / _get_by_file / _delete
- [x] tablature_convert_from_midi / _convert_to_midi

### 1.4 — Constantes & i18n
- [x] CC20 (STRING_SELECT) et CC21 (FRET_SELECT) dans `constants.js`
- [x] Cles i18n en.json + fr.json (tablature.* + stringInstrument.*)
- [x] StringInstrumentDatabase initialise dans Database.js

---

## Phase 2 : Algorithme Note MIDI -> Tablature [TERMINEE]

**Commit** : `747e0e5`

### 2.1 — TablatureConverter.js — MIDI -> Tab
- [x] Calcul de toutes les positions possibles (corde, frette) par note
- [x] Contrainte 1 note/corde max pour les accords
- [x] Optimisation deplacement main (fenetre glissante, cost function)
- [x] Backtracking avec elagage (most constrained first)
- [x] Fallback greedy quand le backtracking echoue
- [x] Support fretless (positions continues)
- [x] Validation jouabilite (isChordPlayable, maxSpan=4)

### 2.2 — TablatureConverter.js — Tab -> MIDI
- [x] Conversion {string, fret} + tuning -> note MIDI
- [x] Generation CC20 (corde) + CC21 (frette) avant chaque note-on
- [x] Helpers statiques : midiNoteToName(), describeTuning()

---

## Phase 3 : Editeur de Tablature (Frontend) [TERMINEE]

**Commit** : `8419fd8`

### 3.1 — TablatureEditor.js (orchestrateur) [TERMINEE]
- [x] Creation DOM (panel header + toolbar + canvas)
- [x] Conversion MIDI -> tab via API backend (+ fallback client-side)
- [x] Saisie inline des numeros de frettes (double-clic -> input)
- [x] Suppression de notes selectionnees (bouton DEL)
- [x] Selection All
- [x] Zoom in/out
- [x] Bouton close
- [x] Deplacement de notes (drag-to-move sur events selectionnes)
- [x] Copier/coller (Ctrl+C/V + boutons CPY/PST, colle au playhead)
- [x] Undo/redo snapshot-based (Ctrl+Z/Y + boutons toolbar, sync auto vers MIDI)

### 3.2 — TablatureRenderer.js (moteur de rendu Canvas) [TERMINEE]
- [x] Rendu des 1-6 lignes de cordes avec labels (note + octave)
- [x] Numeros de frettes sur les lignes (+ duree en trait)
- [x] Barres de mesure / beat lines
- [x] Playhead
- [x] Theme dark/light
- [x] Selection (click, Ctrl+click, box select)
- [x] Hit testing (detection de clic sur un event)
- [x] Zoom (ticksPerPixel) et scroll horizontal
- [x] Hover highlighting (couleur hoverHighlight derriere l'event survole)
- [x] Drag-to-pan (Alt+drag ou clic molette sur espace vide)

### 3.3 — FretboardDiagram.js (preview temps reel)
- [x] Diagramme vertical : cordes verticales, frettes horizontales
- [x] Marqueurs de frettes (3,5,7,9,12,15,17,19,21,24) + doubles (12,24)
- [x] Doigts actifs avec opacite selon velocity
- [x] Corde a vide (O au-dessus du sillet)
- [x] Auto-scroll fenetre de frettes
- [x] Epaisseur de corde variable (graves plus epaisses)
- [x] Corde muted (X) — rendu en rouge (#dc3545) au-dessus du sillet quand `pos.muted === true`

### 3.4 — CSS (tablature.css)
- [x] Panel, header, toolbar, canvas wrappers
- [x] Theme dark/light via CSS variables
- [x] Responsive (fretboard cache <= 768px)
- [x] Style du fret input inline
- [x] Style du bouton toggle TAB

---

## Phase 4 : Edition bidirectionnelle & Synchronisation [TERMINEE]

### 4.1 — Sync Tab -> MIDI
- [x] `syncToMidi()` — convertit tab events -> MIDI + CC via API
- [x] `_updateModalSequence()` — remplace les notes du canal dans fullSequence
- [x] Stocke les CC events tablature dans `modal._tablatureCCEvents[channel]`
- [x] Refresh du piano roll apres mise a jour
- [x] Flag `isDirty` pour sauvegarder

### 4.2 — Sync MIDI -> Tab
- [x] `onMidiNotesChanged()` — recalcule la tablature depuis les notes MIDI
- [x] Conversion via API backend (+ fallback client-side)

### 4.3 — Protection contre les boucles
- [x] Guard `isSyncing` pour eviter les boucles infinies tab <-> piano roll

### 4.4 — Manques identifies
- [x] Warning visuel si note non jouable — fond rouge (unplayable color) sur les frettes > numFrets dans TablatureRenderer
- [ ] **EventBus dedie** — la sync passe par des appels directs, pas par un bus d'evenements (tablature:note-changed, etc.)

---

## Phase 5 : Integration dans l'UI existante [PARTIELLEMENT TERMINEE]

### 5.1 — MidiEditorChannelPanel.js
- [x] `updateTablatureButton()` — affiche le bouton TAB quand 1 canal actif + device + string instrument configure
- [x] Appele depuis `toggleChannel()` et `selectConnectedDevice()`

### 5.2 — MidiEditorModal.js
- [x] `tablatureEditor = new TablatureEditor(this)` instancie
- [x] Bouton TAB inline (initialement `display:none`)
- [x] `toggleTablature()` — show/hide le panel
- [x] `hasStringInstrument()` — verifie si un instrument a cordes existe pour le device/channel courant
- [x] Sync scroll piano roll -> tablature
- [x] `destroy()` nettoie le tablature editor
- [ ] **Toggle piano-roll / tablature / les deux** — actuellement le panel tablature s'affiche SOUS le piano roll, pas en remplacement. Pas de mode "tablature seule"

### 5.3 — Modal de configuration instrument a cordes [TERMINEE]
- [x] `StringInstrumentConfigModal.js` (extends BaseModal) — modal dedie
- [x] Formulaire : nom, nb cordes, nb frettes, fretless toggle, accordage (preset ou custom par note MIDI)
- [x] Selecteur de presets (18 presets avec i18n)
- [x] Capo position
- [x] Sauvegarde via commande `string_instrument_create` / `_update`
- [x] Suppression d'instrument existant
- [x] Bouton engrenage a cote du bouton TAB dans la toolbar
- [x] Bouton visible des qu'un device est selectionne + 1 canal actif
- [x] Callback onSave rafraichit le bouton TAB et l'editeur tablature
- [x] Cles i18n ajoutees pour les 5 presets manquants (en.json + fr.json)

### 5.4 — Auto-detection a la creation d'instrument [TERMINEE]
- [x] `GM_STRING_INSTRUMENTS` — mapping GM program -> preset (guitar, bass, violin, viola, cello, contrabass, banjo)
- [x] `getStringInstrumentCategory()` — detecte si un programme GM est un instrument a cordes
- [x] `_suggestStringInstrumentConfig()` — banniere de suggestion avec bouton "Auto-configurer"
- [x] `string_instrument_create_from_preset` — commande backend pour creer depuis un preset
- [x] Highlight vert pulsant sur le bouton config quand GM string detecte
- [x] CSS: banner `.tab-suggest-banner`, animation `gm-pulse`
- [x] i18n EN/FR: `tablature.gmDetected`, `tablature.autoConfig`, `tablature.configureStringInstrument`

---

## Phase 6 : Generation CC20/CC21 pour le hardware [PARTIELLEMENT TERMINEE]

### 6.1 — TablatureConverter (backend)
- [x] Genere CC20 + CC21 avant chaque note-on dans `convertTablatureToMidi()`
- [x] CC stockes dans `modal._tablatureCCEvents[channel]` cote frontend

### 6.2 — MidiPlayer.js [TERMINEE]
- [x] `_loadTablatureData(fileId)` — charge les tablatures depuis la DB apres buildEventList()
- [x] Construction d'une map channel -> (timeKey_note -> {string, fret}) avec conversion tick->seconds
- [x] `_injectTablatureCCEvents()` — injecte CC20/CC21 dans la liste d'events avant chaque note-on
- [x] CC20 a time-1ms, CC21 a time-0.5ms pour garantir l'ordre CC20 -> CC21 -> note-on
- [x] Matching fuzzy (+/- 5ms) pour tolerance de timing entre tablature et MIDI
- [x] Log du nombre de canaux avec tablature injectee

### 6.3 — MidiRouter.js
- [x] CC20/CC21 passent a travers le routing comme tout autre CC (pas de filtrage special)
- [x] Pas de modification necessaire

---

## Phase 7 : Internationalisation [TERMINEE]

### 7.1 — Cles de traduction
- [x] en.json : 11 cles `tablature.*` + 14 cles `stringInstrument.*` (dont presets)
- [x] fr.json : traductions completes
- [ ] **Autres langues** — non verifie (le projet supporte 28 langues)

---

## Resume de l'etat actuel

| Phase | Description | Statut | Bloquant |
|-------|-------------|--------|----------|
| 1 | Modele de donnees & Backend | TERMINEE | - |
| 2 | Algorithme MIDI <-> Tablature | TERMINEE | - |
| 3 | Editeur frontend | TERMINEE | - |
| 4 | Sync bidirectionnelle | ~90% | Manque warning note non jouable |
| 5 | Integration UI | ~95% | Reste mode tablature seule (Phase 5.2) |
| 6 | CC20/CC21 hardware | TERMINEE | - |
| 7 | i18n | ~95% | Verifier les 26 autres langues |

## Prochaines priorites

### Priorite MOYENNE (qualite d'edition)

### Priorite BASSE (polish)

3. **Phase 5.2** — Mode "tablature seule" (sans piano roll)
4. **Phase 4.4b** — EventBus dedie pour la sync tab/MIDI
5. **Phase 7** — Verifier i18n sur les 26 autres langues

---

## Fichiers concernes

| Composant | Chemin | Lignes |
|-----------|--------|--------|
| Converter | `src/midi/TablatureConverter.js` | 503 |
| Database | `src/storage/StringInstrumentDatabase.js` | 476 |
| Commands | `src/api/commands/StringInstrumentCommands.js` | 197 |
| Editor | `public/js/views/components/TablatureEditor.js` | 662 |
| Renderer | `public/js/views/components/TablatureRenderer.js` | 588 |
| Fretboard | `public/js/views/components/FretboardDiagram.js` | 357 |
| Config Modal | `public/js/views/components/StringInstrumentConfigModal.js` | ~300 |
| Styles | `public/styles/tablature.css` | ~350 |
| Migration | `migrations/024_string_instruments.sql` | 65 |
| Constants | `src/constants.js` | CC20, CC21 |
| i18n EN | `public/locales/en.json` | tablature.* + stringInstrument.* |
| i18n FR | `public/locales/fr.json` | idem |
| DB Init | `src/storage/Database.js` | ligne 36 |
| Modal | `public/js/views/components/MidiEditorModal.js` | ~5400 |
| Channel | `public/js/views/components/midi-editor/MidiEditorChannelPanel.js` | ~360 |
| Player | `src/midi/MidiPlayer.js` | a modifier (Phase 6) |
| HTML | `public/index.html` | lignes 4412-4414 (scripts) |

## Architecture

- Backend : Node.js (Express) + SQLite
- Frontend : Vanilla JS + Canvas 2D (pas de lib externe type VexTab)
- Communication : WebSocket (commandes JSON)
- Sync tab <-> piano roll : events custom (`tab:addevent`, `tab:editevent`, `tab:selectionchange`) + appels directs
