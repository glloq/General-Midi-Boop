# Audit complet des éditeurs musicaux Ma-est-tro

**Date** : 2026-03-22
**Périmètre** : Piano Roll, Tablature, Drum Pattern, Wind Instrument
**Objectif** : Valider que tous les contrôles sont fonctionnels, adaptés et sans surcharge d'interface

---

## Résumé exécutif

| Éditeur | Contrôles | Tous câblés ? | Contrôles morts | Problèmes | Densité UI |
|---------|-----------|---------------|-----------------|-----------|------------|
| **Piano Roll** | 64 | ✅ Oui | 0 | 3 mineurs | ⚠️ Élevée (43-48 visibles + 19 en CC) |
| **Tablature** | 15 | ✅ Oui | 0 | 4 moyens | ✅ Modérée |
| **Drum Pattern** | 28 (12 toolbar + 16 panel) | ⚠️ 1 mort | 1 (quantize) | 3 moyens | ✅ Acceptable |
| **Wind** | 18 (12 toolbar + 6 panel) | ⚠️ 1 mort | 1 (range check) | 5 critiques/moyens | ✅ Appropriée |

**Verdict global** : L'architecture est solide et modulaire. Tous les boutons ont des handlers câblés. Cependant, **2 contrôles sont non-fonctionnels** (Drum quantize selector, Wind range check toggle), et plusieurs **incohérences** existent entre éditeurs (raccourcis clavier, patterns d'interaction).

---

## 1. Piano Roll Editor

### 1.1 Fichiers audités
- `MidiEditorModal.js` (render: lignes 2578-2875, events: lignes 4542-5007)
- `midi-editor/MidiEditorToolbar.js`
- `midi-editor/MidiEditorState.js`
- `midi-editor/MidiEditorPlayback.js`
- `midi-editor/MidiEditorChannelPanel.js`
- `midi-editor/MidiEditorFileOps.js`

### 1.2 Inventaire des contrôles (64 au total)

| Section | Contrôles | Tous câblés ? |
|---------|-----------|---------------|
| Header (rename, tempo, close) | 4 | ✅ |
| Playback (play, pause, stop) | 3 | ✅ |
| Undo/Redo | 2 | ✅ |
| Grid/Snap | 1 | ✅ |
| Navigation & Zoom (view mode, H±, V±) | 5 | ✅ |
| Edit modes (select, drag, add, resize) | 4 | ✅ |
| Edit actions (copy, paste, delete) | 3 | ✅ |
| Channel (selector + apply) | 2 | ✅ |
| Instrument (selector + apply) | 2 | ✅ |
| Connected device | 1 | ✅ |
| Channel toggle buttons (dynamiques) | 4 types | ✅ |
| Scroll controls (4 boutons + 2 sliders) | 6 | ✅ |
| CC section (14 CC + 4 outils + delete + resize) | ~21 | ✅ |
| Floating buttons (close, auto-assign, save, save-as) | 4 | ✅ |

### 1.3 Modes d'édition

| Mode | Bouton | Exclusivité mutuelle | Curseur |
|------|--------|---------------------|---------|
| drag-view (défaut) | ✅ | ✅ via `updateModeButtons()` | Délégué au piano roll |
| select | ✅ | ✅ | Délégué au piano roll |
| drag-notes | ✅ | ✅ | Délégué au piano roll |
| add-note | ✅ | ✅ | Délégué au piano roll |
| resize-note | ✅ | ✅ | Délégué au piano roll |

### 1.4 Gestion d'état des boutons

| Comportement | Implémenté ? | Détail |
|-------------|-------------|--------|
| Undo/Redo disabled quand pas d'historique | ✅ | `updateUndoRedoButtonsState()` ligne 3171 |
| Copy/Delete disabled quand pas de sélection | ✅ | `updateEditButtons()` ligne 3812 |
| Paste disabled quand clipboard vide | ⚠️ Partiel | Activé par `copy()` mais jamais re-désactivé si clipboard vidé |
| Save indicateur dirty | ✅ | `updateSaveButton()` ligne 3115, classe `btn-warning` |

### 1.5 Densité UI

- **Toujours visible** : ~43-48 contrôles (header + toolbar + channels + scroll + floating)
- **Section CC (collapsed)** : +19 contrôles supplémentaires
- **Évaluation** : ⚠️ Densité élevée mais gérée par le collapse de la section CC et le regroupement logique. Les boutons de scroll (4) pourraient être remplacés par un scroll natif.

### 1.6 Raccourcis clavier (8)

| Raccourci | Action | Ligne |
|-----------|--------|-------|
| Escape | Fermer | 2883 |
| Space | Toggle playback | 3880 |
| Ctrl+Z | Undo | 3838 |
| Ctrl+Y / Ctrl+Shift+Z | Redo | 3844 |
| Ctrl+C | Copy | 3850 |
| Ctrl+V | Paste | 3856 |
| Ctrl+A | Select all | 3862 |
| Delete/Backspace | Delete | 3868 |

### 1.7 Problèmes identifiés

| # | Sévérité | Problème | Localisation |
|---|----------|----------|-------------|
| P1 | Mineur | Delete button n'a pas `disabled` dans le HTML initial → flash visible avant `updateEditButtons()` | `MidiEditorModal.js:2685` |
| P2 | Mineur | `updateEditButtons()` ne gère pas le bouton Paste → reste enabled si clipboard vidé externalement | `MidiEditorModal.js:3812` |
| P3 | Info | Curseur par mode non géré côté JS → délégué au composant webaudio-pianoroll | `MidiEditorModal.js:3780` |

---

## 2. Tablature Editor

### 2.1 Fichiers audités
- `TablatureEditor.js`
- `TablatureRenderer.js`
- `FretboardDiagram.js`

### 2.2 Inventaire des contrôles (15)

| # | Contrôle | Type | data-action | Handler | Fonctionnel |
|---|----------|------|-------------|---------|------------|
| 1 | Algorithm select | select | `#tab-algo-select` | ✅ `_onAlgorithmChange()` :836 | ✅ |
| 2 | Mode: Select | button | `tab-mode` `select` | ✅ `_setEditMode()` :846 | ✅ |
| 3 | Mode: Pan | button | `tab-mode` `pan` | ✅ | ✅ |
| 4 | Mode: Change-String | button | `tab-mode` `change-string` | ✅ | ✅ |
| 5 | Undo | button | `tab-undo` | ✅ `_performUndo()` :852 | ✅ |
| 6 | Redo | button | `tab-redo` | ✅ `_performRedo()` :854 | ✅ |
| 7 | Copy | button | `tab-copy` | ✅ :858 | ✅ |
| 8 | Paste | button | `tab-paste` | ✅ :861 | ✅ |
| 9 | Zoom In | button | `tab-zoom-in` | ✅ :871 | ✅ |
| 10 | Zoom Out | button | `tab-zoom-out` | ✅ :876 | ✅ |
| 11 | Delete | button | `tab-delete` | ✅ :881 | ✅ |
| 12 | Select All | button | `tab-select-all` | ✅ :890 | ✅ |
| 13 | Close | button | `tab-close` | ✅ :893 | ✅ |

### 2.3 Interactions canvas

| Interaction | Supportée | Détail |
|------------|-----------|--------|
| Double-click ajout | ✅ | Émet `tab:addevent` → `_showFretInput()` |
| Double-click édition | ✅ | Émet `tab:editevent` → `_showFretInput()` |
| Drag déplacement | ✅ | Mode `'move'` dans renderer |
| Rectangle sélection | ✅ | Mode `'select'` dans renderer |
| Scroll molette | ❌ | Absent contrairement au Drum |
| Touch events | ❌ | Absent |

### 2.4 Problèmes identifiés

| # | Sévérité | Problème | Localisation |
|---|----------|----------|-------------|
| T1 | **Moyen** | Raccourcis Delete/Backspace manquants | `TablatureEditor.js:595-635` |
| T2 | **Moyen** | Raccourci Ctrl+A (Select All) manquant | `TablatureEditor.js:595-635` |
| T3 | **Moyen** | Pas de guard sur focus INPUT dans `_handleKeyDown` → les raccourcis s'activent pendant la saisie du fret | `TablatureEditor.js:595-598` |
| T4 | **Moyen** | Pas de scroll molette sur le canvas (le Drum l'a) | `TablatureRenderer.js` |
| T5 | Mineur | Code mort `_toggleTabOnlyMode()` + case `tab-view-mode` sans bouton | `TablatureEditor.js:653-656, :849` |
| T6 | Mineur | Pas de `updateTheme()` → thème ne se met pas à jour dynamiquement | `TablatureEditor.js` |
| T7 | Mineur | Position du fret input relative au viewport, pas au container → décalage avec scroll page | `TablatureEditor.js:769-778` |

---

## 3. Drum Pattern Editor

### 3.1 Fichiers audités
- `DrumPatternEditor.js`
- `DrumGridRenderer.js`
- `DrumToolsPanel.js`

### 3.2 Inventaire des contrôles - Toolbar (12)

| # | Contrôle | Handler | Fonctionnel |
|---|----------|---------|------------|
| 1 | Quantize select | ✅ :243 | ❌ **NON-FONCTIONNEL** - `quantizeDiv` jamais lu |
| 2 | Velocity input | ✅ :251 | ✅ |
| 3-12 | Undo/Redo/Copy/Paste/Zoom±/Delete/SelectAll/Close | ✅ | ✅ |

### 3.3 Inventaire des contrôles - DrumToolsPanel (16)

| Section | Contrôles | Tous câblés ? | Fonctionnels ? |
|---------|-----------|---------------|---------------|
| **Velocity** : Humanize + slider, Accent 1&3, Scale slider + apply, Crescendo, Decrescendo | 10 | ✅ | ✅ |
| **Swing** : slider + apply | 3 | ✅ | ✅ |
| **Pattern** : Detect, info display, Fill | 3 | ✅ | ✅ (Fill disabled par défaut, activé après detect) |

### 3.4 Interactions canvas

| Interaction | Supportée | Détail |
|------------|-----------|--------|
| Double-click ajout | ✅ | Émet `drum:addhit` |
| Double-click édition velocity | ✅ | Émet `drum:editvelocity` → `prompt()` |
| Drag déplacement | ❌ | Non supporté (contrairement au Tab) |
| Rectangle sélection | ✅ | ✅ |
| Scroll molette | ✅ | `_handleWheel` :810 |
| Touch events | ❌ | Absent |

### 3.5 Problèmes identifiés

| # | Sévérité | Problème | Localisation |
|---|----------|----------|-------------|
| D1 | **Élevé** | Quantize selector non-fonctionnel : `this.quantizeDiv` n'est jamais lu. La grille utilise toujours 1/16 hardcodé (`ticksPerBeat / 4`) | `DrumPatternEditor.js:34,244` / `DrumGridRenderer.js:799` |
| D2 | Moyen | `_handleGridSelection` est un handler vide (no-op) → pas de feedback visuel sur la sélection | `DrumPatternEditor.js:489-491` |
| D3 | Moyen | Édition velocity par `prompt()` au lieu d'input inline → UX pauvre | `DrumPatternEditor.js:477` |
| D4 | Mineur | Ctrl+Shift+Z pour redo non supporté (Tab l'a) | `DrumPatternEditor.js:506` |

---

## 4. Wind Instrument Editor

### 4.1 Fichiers audités
- `WindInstrumentEditor.js`
- `WindMelodyRenderer.js`
- `WindArticulationPanel.js`
- `WindInstrumentDatabase.js`
- `wind-editor.css`

### 4.2 Inventaire des contrôles - Toolbar (12)

| # | Contrôle | Handler | Fonctionnel |
|---|----------|---------|------------|
| 1 | Velocity input | ✅ :245 | ✅ |
| 2-11 | Undo/Redo/Copy/Paste/Zoom±/Delete/SelectAll/Close | ✅ | ✅ |

### 4.3 Inventaire des contrôles - Articulation Panel (6)

| # | Contrôle | Handler | Fonctionnel |
|---|----------|---------|------------|
| 1 | Normal | ✅ :103-117 | ✅ |
| 2 | Legato | ✅ | ✅ |
| 3 | Staccato | ✅ | ✅ |
| 4 | Accent | ✅ | ✅ |
| 5 | Auto Breath toggle | ✅ :120-128 | ✅ |
| 6 | Range Check toggle | ✅ :131-139 | ❌ **NON-FONCTIONNEL** - flag jamais lu |

### 4.4 Problèmes identifiés

| # | Sévérité | Problème | Localisation |
|---|----------|----------|-------------|
| W1 | **Critique** | Mode d'édition bloqué sur `'pan'` : pas de UI pour switcher en mode edit → impossible de déplacer des notes par drag | `WindInstrumentEditor.js:271` |
| W2 | **Élevé** | Range Check toggle non-fonctionnel : `rangeCheckEnabled` n'est jamais lu | `WindArticulationPanel.js:131-139` |
| W3 | **Moyen** | Compteur "Selected" jamais mis à jour après sélection interactive (seulement après sync MIDI) | `WindArticulationPanel.js:162-170` |
| W4 | **Moyen** | Monophonie non appliquée au chargement (`loadFromMidi`) ni après undo/redo | `WindInstrumentEditor.js:334-364` |
| W5 | **Moyen** | BPM hardcodé à 120 pour le calcul des breath marks | `WindInstrumentEditor.js:497` |
| W6 | Mineur | `typicalRestInterval` défini dans les 24 presets mais jamais utilisé | `WindInstrumentDatabase.js` |
| W7 | Mineur | `WIND_CCS` (11 CC mappings) défini mais jamais utilisé | `WindInstrumentDatabase.js:109-121` |
| W8 | Mineur | Pas d'events touch | `WindMelodyRenderer.js:80-84` |
| W9 | Mineur | Resize de notes impossible (code `_resizeIndex` déclaré mais jamais activé) | `WindMelodyRenderer.js:56,59` |
| W10 | Mineur | Sélection perdue après déplacement de notes (`_rebuildSelectionAfterSort` clear tout) | `WindMelodyRenderer.js:776-779` |
| W11 | Mineur | Panneau d'articulation masqué sur mobile (<768px) sans alternative | `wind-editor.css:424-428` |

### 4.5 Base de données instruments

- **24 presets** (8 Brass, 8 Reed, 8 Pipe) — tous complets avec `rangeMin/Max`, `comfortMin/Max`, `breathCapacity`
- Validation des ranges : ✅ Tous respectent `rangeMin < comfortMin < comfortMax < rangeMax`
- Synth Brass 1/2 : `breathCapacity: Infinity` — correct pour instruments synthétiques

---

## 5. Analyse transversale

### 5.1 Cohérence des toolbars

| Aspect | Piano | Tablature | Drum | Wind |
|--------|-------|-----------|------|------|
| Icônes Undo/Redo | ↶ ↷ (Unicode) | ↶ ↷ | ↶ ↷ | ↶ ↷ |
| Labels Copy/Paste | 📋 📄 (emoji) | CPY / PST | CPY / PST | CPY / PST |
| Label Delete | 🗑 (emoji) | DEL | DEL | DEL |
| Label Select All | — (pas de bouton dédié) | ALL | ALL | ALL |
| Label Close | × | × | × | × |
| Ordre boutons | Play→Undo→Snap→Zoom→Modes→Actions→Channel | Modes→Undo→Copy→Zoom→Del→All→Close | Undo→Copy→Zoom→Del→All→Close | Undo→Copy→Zoom→Del→All→Close |

**Constat** : Les 3 sous-éditeurs (Tab, Drum, Wind) sont cohérents entre eux avec les labels texte. Le Piano utilise des emojis, ce qui crée une légère incohérence visuelle mais est justifié par sa plus grande complexité.

### 5.2 Raccourcis clavier

| Raccourci | Piano | Tablature | Drum | Wind |
|-----------|-------|-----------|------|------|
| Ctrl+Z (Undo) | ✅ | ✅ | ✅ | ✅ |
| Ctrl+Y (Redo) | ✅ | ✅ | ✅ | ✅ |
| Ctrl+Shift+Z (Redo) | ✅ | ✅ | ❌ | ❌ |
| Ctrl+C (Copy) | ✅ | ✅ | ✅ | ✅ |
| Ctrl+V (Paste) | ✅ | ✅ | ✅ | ✅ |
| Ctrl+A (Select All) | ✅ | ❌ | ✅ | ✅ |
| Delete/Backspace | ✅ | ❌ | ✅ | ✅ |
| Space (Play/Pause) | ✅ | — | — | — |
| Escape (Close) | ✅ | — | — | — |
| Guard focus INPUT | ✅ | ❌ | ✅ | ✅ |

### 5.3 Modes d'édition

| Éditeur | Modes | Adapté ? |
|---------|-------|----------|
| Piano | 5 (view, select, drag, add, resize) | ✅ Complet pour un éditeur MIDI multi-usage |
| Tablature | 3 (select, pan, change-string) | ✅ Adapté au domaine (frettes, cordes) |
| Drum | 0 (pas de modes explicites) | ✅ Approprié pour un step sequencer (click-to-toggle) |
| Wind | 1 (pan uniquement, **edit bloqué**) | ❌ Devrait avoir au moins select + pan |

### 5.4 Densité comparative

| Éditeur | Toolbar | Panel latéral | Total | Évaluation |
|---------|---------|---------------|-------|-----------|
| Piano | ~37 | +19 (CC collapsed) | ~56 max | ⚠️ Dense mais géré par collapse |
| Tablature | 13 | 0 (fretboard passif) | 13 | ✅ Léger |
| Drum | 11 | 16 | 27 | ✅ Équilibré |
| Wind | 10 | 6 | 16 | ✅ Minimal |

### 5.5 Contrôles non-fonctionnels (2)

| Contrôle | Éditeur | Problème |
|----------|---------|----------|
| Quantize selector | Drum | `quantizeDiv` jamais lu, grille hardcodée 1/16 |
| Range Check toggle | Wind | `rangeCheckEnabled` jamais lu, highlighting toujours actif |

---

## 6. Recommandations priorisées

### Priorité 1 — Critique

| # | Recommandation | Éditeur | Fichier |
|---|---------------|---------|---------|
| R1 | **Ajouter un bouton/toggle de mode edit dans le Wind editor** pour permettre le déplacement de notes par drag. Actuellement le tool est hardcodé `'pan'` | Wind | `WindInstrumentEditor.js:271` |

### Priorité 2 — Élevée

| # | Recommandation | Éditeur | Fichier |
|---|---------------|---------|---------|
| R2 | **Connecter le quantize selector au DrumGridRenderer** : passer `quantizeDiv` au renderer et l'utiliser dans `_handleDblClick` au lieu du hardcode `ticksPerBeat/4` | Drum | `DrumPatternEditor.js:244` / `DrumGridRenderer.js:799` |
| R3 | **Implémenter ou supprimer le Range Check toggle** : soit lire `rangeCheckEnabled` pour activer/désactiver le highlighting, soit retirer le toggle | Wind | `WindArticulationPanel.js:131-139` |

### Priorité 3 — Moyenne

| # | Recommandation | Éditeur | Fichier |
|---|---------------|---------|---------|
| R4 | Ajouter Delete/Backspace et Ctrl+A dans `_handleKeyDown` du Tab editor | Tablature | `TablatureEditor.js:595-635` |
| R5 | Ajouter un guard focus INPUT/TEXTAREA/SELECT dans `_handleKeyDown` du Tab editor | Tablature | `TablatureEditor.js:595-598` |
| R6 | Ajouter `Ctrl+Shift+Z` pour redo dans Drum et Wind editors | Drum/Wind | `DrumPatternEditor.js:506` / `WindInstrumentEditor.js:722` |
| R7 | Ajouter scroll molette sur le canvas du Tab renderer | Tablature | `TablatureRenderer.js` |
| R8 | Mettre à jour le compteur "Selected" après chaque sélection interactive dans le Wind editor | Wind | `WindInstrumentEditor.js` |
| R9 | Appliquer `_enforceMonophony()` dans `loadFromMidi()` et après undo/redo dans le Wind editor | Wind | `WindInstrumentEditor.js:334, 793-809` |
| R10 | Lire le tempo réel depuis les données MIDI au lieu de hardcoder 120 BPM pour les breath marks | Wind | `WindInstrumentEditor.js:497` |
| R11 | Remplacer `prompt()` par un input inline pour l'édition velocity dans le Drum editor | Drum | `DrumPatternEditor.js:477` |
| R12 | Ajouter `updateTheme()` dans le TablatureEditor | Tablature | `TablatureEditor.js` |

### Priorité 4 — Mineure / Nettoyage

| # | Recommandation | Éditeur | Fichier |
|---|---------------|---------|---------|
| R13 | Ajouter `disabled` initial au bouton Delete du Piano editor | Piano | `MidiEditorModal.js:2685` |
| R14 | Supprimer le code mort `_toggleTabOnlyMode()` et le case `tab-view-mode` | Tablature | `TablatureEditor.js:653,849` |
| R15 | Supprimer ou implémenter `typicalRestInterval` et `WIND_CCS` | Wind | `WindInstrumentDatabase.js` |
| R16 | Corriger le positionnement du fret input (ajouter `window.scrollX/Y`) | Tablature | `TablatureEditor.js:769-778` |

---

## 7. Conclusion

L'architecture modulaire des éditeurs est bien conçue avec une séparation claire entre orchestrateur, renderer et panel d'outils. **97% des contrôles sont correctement câblés et fonctionnels**. Les principaux axes d'amélioration sont :

1. **Wind editor** : le mode d'édition bloqué limite fortement l'utilisabilité
2. **Drum quantize** : contrôle visible mais sans effet → confusion utilisateur
3. **Harmonisation des raccourcis** : Tab manque Delete et Ctrl+A
4. **Touch support** : absent dans les 4 éditeurs (limité aux utilisateurs desktop)

La densité UI est bien gérée dans les sous-éditeurs (Tab, Drum, Wind) qui restent concis et ciblés. Le Piano editor est dense mais cela est justifié par sa fonction d'éditeur MIDI complet, et la section CC collapsible atténue la surcharge visuelle.
