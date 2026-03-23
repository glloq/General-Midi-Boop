# Roadmap : InstrumentSettingsModal

## Fichiers à créer

### 1. `public/js/views/components/InstrumentSettingsModal.js`
### 2. `public/styles/instrument-settings-modal.css` (DÉJÀ CRÉÉ - non commité)

## Fichiers à modifier

### 3. `public/index.html`
- Ajouter `<script src="js/views/components/InstrumentSettingsModal.js">`
- Ajouter `<link rel="stylesheet" href="styles/instrument-settings-modal.css">`
- Garder `window.showInstrumentSettings` comme proxy vers le nouveau modal
- Supprimer les fonctions migrées : `showInstrumentSettings`, `_renderInstrumentFormContent`, `_renderInstrumentTabs`, `switchInstrumentTab`, `addInstrumentTab`, `deleteInstrumentTab`, `saveInstrumentSettings`, `closeInstrumentSettings`
- Les fonctions piano (initPianoKeyboard, renderPianoKeyboard, etc.) lignes 9544-10081 restent dans index.html (réutilisées telles quelles)
- Les fonctions GM helper (renderGMInstrumentOptions, isGmStringInstrument, getGmStringCategory, etc.) lignes 8727-8882 restent dans index.html (réutilisées telles quelles)
- Les fonctions string instrument (renderSiPresetOptions, renderSiTuningRows, onSiPresetChanged, onSiStringsChanged) restent dans index.html

### 4. `public/js/views/components/InstrumentManagementPage.js`
- `editInstrument()` (ligne 672) : utiliser `new InstrumentSettingsModal(api).show(instrument)` au lieu de `window.showInstrumentSettings`
- `addVirtualInstrument()` (ligne 822) : ouvrir le modal en mode création au lieu du dialog custom

---

## Architecture du composant

```
class InstrumentSettingsModal extends BaseModal {
  constructor(api) → super({ id: 'instrument-settings-modal', size: 'xl', customClass: 'ism-modal' })

  // Données
  this.api = api
  this.device = null
  this.instrumentTabs = []      // [{channel, settings, stringInstrumentConfig, isBleDevice}]
  this.activeChannel = 0
  this.tuningPresets = {}
  this.activeSection = 'identity'
  this.isCreationMode = false
  this.drumSelectedNotes = new Set()

  // Méthodes publiques
  async show(device)             // Mode édition
  async showCreate(deviceId)     // Mode création (virtuel)

  // BaseModal overrides
  renderBody()                   // Tabs + sidebar + content
  renderFooter()                 // Delete Ch | Cancel | Save
  onOpen()                       // Event listeners
  onClose()                      // Cleanup

  // Sections (chacune retourne du HTML)
  _renderSidebar()
  _renderIdentitySection()
  _renderNotesSection()
  _renderStringsSection()
  _renderDrumsSection()
  _renderAdvancedSection()

  // Navigation
  _switchSection(name)
  _switchTab(channel)
  _addTab()
  _deleteTab()

  // Drums
  _renderDrumCategories()
  _toggleDrumCategory(cat)
  _toggleDrumNote(note)
  _applyDrumPreset(presetId)
  _saveDrumPreset(name)
  _updateDrumSummary()

  // Sauvegarde (reprend la logique de saveInstrumentSettings de index.html lignes 10170-10368)
  async _save()
}
```

---

## Sections du modal

### Layout
```
┌──────────────────────────────────────────────────────────┐
│ Header: [icon] Nom instrument — Device name        [X]  │
├────────────┬─────────────────────────────────────────────┤
│ Sidebar    │  Contenu de la section active               │
│            │                                             │
│ ▸ Identité │  (change selon l'onglet sélectionné)       │
│ ▸ Notes    │                                             │
│ ▸ Cordes*  │  * = conditionnel selon type                │
│ ▸ Drums*   │                                             │
│ ▸ Avancé   │                                             │
├────────────┴─────────────────────────────────────────────┤
│ Footer: [Suppr Ch] ──────────── [Annuler] [Sauvegarder] │
└──────────────────────────────────────────────────────────┘
```

### 1. Identité (tous instruments)
- Type GM (dropdown via `renderGMInstrumentOptions()` existant)
- Nom personnalisé
- Canal MIDI (grille 16 boutons colorés, classe `ism-channel-grid`)
- Info device (lecture seule)

### 2. Notes & Capacités (non-drums, non-strings)
- Mode toggle : plage / discret (classes `ism-mode-toggle`, `ism-mode-btn`)
- Piano keyboard (réutilise `initPianoKeyboard()` existant)
- Polyphonie
- CCs supportés (grille checkboxes, classe `ism-cc-grid`)

### 3. Cordes (conditionnel : `isGmStringInstrument(program)`)
- Réutilise les fonctions existantes inline : `renderSiPresetOptions`, `renderSiTuningRows`, `onSiPresetChanged`, `onSiStringsChanged`
- Classe CSS : `ism-string-section`

### 4. Percussions (conditionnel : channel 9 ou drum kit sélectionné)
- Toolbar presets (classe `ism-drum-toolbar`)
- Résumé stats (classe `ism-drum-summary`)
- Catégories dépliables (classe `ism-drum-categories`)
- Chaque catégorie : header toggle + grille de notes checkboxes

### 5. Avancé
- Sync delay, MAC bluetooth, source capabilities, info SysEx

---

## Données Drum (à inclure dans le JS)

### Catégories (de DrumNoteMapper.js)
```javascript
DRUM_CATEGORIES = {
  kicks: { notes: [35, 36], icon: '🥁', name: 'Kicks' },
  snares: { notes: [37, 38, 40], icon: '🪘', name: 'Snares' },
  hiHats: { notes: [42, 44, 46], icon: '🎩', name: 'Hi-Hats' },
  toms: { notes: [41, 43, 45, 47, 48, 50], icon: '🥁', name: 'Toms' },
  crashes: { notes: [49, 55, 57], icon: '💥', name: 'Crashes' },
  rides: { notes: [51, 53, 59], icon: '🔔', name: 'Rides' },
  latin: { notes: [60,61,62,63,64,65,66,67,68], icon: '🪇', name: 'Latin' },
  misc: { notes: [39,52,54,56,58,69,70,71,72,73,74,75,76,77,78,79,80,81], icon: '🎵', name: 'Divers' }
}
```

### Note Names (de DrumNoteMapper.js lignes 124-137)
35-81 tous les noms GM standard.

### Priorities (de DrumNoteMapper.js lignes 84-121)
36,35,38,40=100 / 42=90 / 49=70 / 46=60 / toms=50 / 51=40 / etc.

### Presets
```javascript
DRUM_PRESETS = {
  gm_standard: { name: 'GM Standard', notes: range(35,81) },
  gm_reduced: { name: 'Kit Essentiel', notes: [35,36,38,40,42,44,46,41,43,45,47,48,49,50,51] },
  rock: { name: 'Rock', notes: [35,36,38,40,42,46,41,43,45,48,49,51,55,57] },
  jazz: { name: 'Jazz', notes: [35,38,42,44,46,41,43,45,49,51,53,59,55] },
  electronic: { name: 'Électronique', notes: [36,38,40,42,46,41,45,48,49,51,39,54,56] },
  latin: { name: 'Latin', notes: [35,38,42,46,60,61,62,63,64,65,66,67,68,75,76] }
}
```

Custom presets : localStorage clé `maestro_drum_presets_custom`, format `[{id, name, notes}]`

---

## CSS (DÉJÀ FAIT dans public/styles/instrument-settings-modal.css)

Le fichier CSS est complet (822 lignes) avec :
- Layout modal XL, sidebar, content
- Tabs bar multi-channel
- Form groups, channel grid, CC grid
- String section, drum section (toolbar, summary, categories, notes)
- Creation mode (grille de cartes presets)
- Footer, mode toggle, piano container, info cards
- Dark mode support
- Responsive (768px breakpoint)

---

## Références code existant

| Élément | Fichier | Lignes |
|---|---|---|
| BaseModal class | `public/js/core/BaseModal.js` | 1-382 |
| StringInstrumentConfigModal | `public/js/views/components/StringInstrumentConfigModal.js` | entier |
| showInstrumentSettings | `public/index.html` | 9443-9542 |
| _renderInstrumentFormContent | `public/index.html` | 9272-9441 |
| saveInstrumentSettings | `public/index.html` | 10170-10368 |
| _loadChannelData | `public/index.html` | 9039-9062 |
| switchInstrumentTab | `public/index.html` | 9097-9155 |
| addInstrumentTab | `public/index.html` | 9160-9236 |
| deleteInstrumentTab | `public/index.html` | 9241-9267 |
| Piano functions | `public/index.html` | 9544-10081 |
| GM helpers | `public/index.html` | 8727-8882 |
| SI helpers (renderSiTuningRows etc.) | `public/index.html` | ~8885-9035 |
| onGmProgramChanged | `public/index.html` | 9585-9662 |
| DrumNoteMapper | `src/midi/DrumNoteMapper.js` | 1-137 |
| InstrumentManagementPage | `public/js/views/components/InstrumentManagementPage.js` | editInstrument:672, addVirtualInstrument:822 |
| Channel colors | partout | `['#3b82f6','#ef4444','#10b981','#f59e0b','#8b5cf6','#ec4899','#06b6d4','#84cc16','#f97316','#6366f1','#14b8a6','#e11d48','#a855f7','#0ea5e9','#22c55e','#eab308']` |

---

## Ordre d'implémentation recommandé

1. **Squelette** : Classe + constructor + renderBody (sidebar + sections vides) + renderFooter + show()
2. **Identité** : Migrer GM dropdown, nom, canal grid, device info
3. **Notes** : Migrer piano keyboard + mode toggle + CCs
4. **Cordes** : Intégrer inline les fonctions SI existantes
5. **Drums** : Categories + presets + toggle all + résumé
6. **Avancé** : Sync delay, MAC, SysEx
7. **Intégration** : Connecter save(), proxy window.showInstrumentSettings, modifier InstrumentManagementPage
8. **Nettoyage** : Supprimer code migré de index.html, ajouter clés i18n
