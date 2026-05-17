# Arranger Split — handoff plan

Branche `claude/dazzling-dijkstra-Es6lw`, audit §6.6 (LoopCreatorModal
god-class split).

## État actuel (commit def7a2b)

4 features extraits sur 6, LoopCreatorModal passé de 3 394 → 2 423 lignes
(−29 %).

| Feature | Lignes | Status |
|---|---|---|
| Keyboard  | 197 | ✅ Extrait (a8c8ad5) |
| Library   | 232 | ✅ Extrait (09c7d01) |
| Live      | 245 | ✅ Extrait (3456385) |
| Pad       | 662 | ✅ Extrait (def7a2b) |
| Arranger  | ~1 470 | ⏳ Différé (voir ci-dessous) |
| SharedUtils | ~150 | ⏳ Optionnel |

## Pourquoi l'Arranger est différé

Lignes 948-2416 (~1 470 l.) avec ~60 méthodes interconnectées :

- Render : `_renderTimeline` appelle `_renderRuler`, `_renderTracks`,
  `_renderMinimap`, `_renderPalette`, `_refreshBlockSelectionUI`
- Undo/redo : `_pushArrHistory` ↔ `_snapshotArr` ↔ `_restoreArrSnapshot`
  ↔ `_refreshUndoButtons` ↔ `_markArrDirty`
- CRUD : `_loadArrangementById` appelle `_resetArrHistory`,
  `_renderTimeline`, `_loadArrangements`
- Playback : `_playArrangement` (190 lignes) appelle `_scheduleCountIn`,
  `_renderArrangerPlayhead`, `_renderPlaybar`, `_stopArrangerPlay`
- Block ops : `_deleteSelectedBlocks` appelle `_pushArrHistory`,
  `_scheduleAutoSave`, `_renderTimeline`
- Mouse handlers : `_onDocMouseMove`/`_onDocMouseUp` (drag block) appellent
  `_moveBlock`, `_changeReps`, `_renderTimeline`, `_pushArrHistory`

Toute extraction partielle laisse des appels cross-feature non résolus.
Le slice cohérent minimal = TOUT l'Arranger.

## Plan d'attaque pour la session dédiée Arranger

### Phase 1 : préparation (~2 h)

1. Identifier la **surface publique consommée** par d'autres features :
   - `currentArrangementId` (lu par `_deleteLoopById`)
   - `blocks` (lu par `_deleteLoopById`)
   - `tracks` (potentiellement lu ailleurs)
   - `_renderPlaybar` (appelé par PadFeature + LiveFeature)
   - `_stopArrangerPlay` (stop-all-playback)
   - `_initArrangerSynth` (lifecycle)

2. Mapper toutes les **dépendances modal**  qu'Arranger lit/appelle :
   - State : `library`, `_globalOutput`, `_loopEditor`, `eventBus`
   - Méthodes : `_loadLibrary`, `_getOutputTarget`, `_fetchLoopData`,
     `_setGlobalOutput`, `_makeDeviceShim`, `_gmProgramName`,
     `_instrIconHtml`, `t()`, `$()`, `$$()`, `escape()`

3. Identifier les **constantes Arranger** à exporter
   (`ARRANGER_HISTORY_LIMIT`).

### Phase 2 : extraction (~6-8 h)

**Pattern de migration** : state stays on modal pour limiter le blast
radius. La feature contient les méthodes seulement, accédant à l'état
via `this.modal.X`.

1. Créer `public/js/features/LoopManagerArrangerFeature.js` :
   ```js
   class LoopManagerArrangerFeature {
       constructor(modal) {
           this.modal = modal;
       }
       // 60 méthodes ici, avec this.modal.X partout
   }
   ```

2. Pour chaque méthode :
   - `this.currentArrangementId` → `this.modal.currentArrangementId`
   - `this.tracks` / `this.blocks` → `this.modal.tracks` / `this.modal.blocks`
   - `this._arrHistory` etc. → `this.modal._arrHistory`
   - `this._renderTimeline()` → `this._renderTimeline()` (méthode interne au feature, INCHANGÉE)
   - `this._loadLibrary()` → `this.modal._loadLibrary()` (modal externe)

3. La translation à appliquer (recommandation: script Python ou awk plutôt
   que sed) :
   - Liste blanche des méthodes Arranger ci-dessous → préfixe inchangé
   - Tout le reste de `this.X` → `this.modal.X`

   **Liste des méthodes Arranger** (60) :
   ```
   _initArrangerSynth, _initArrangerTab, _renderArrangerEmptyState,
   _purgeEmptyArrangements, _loadArrangements, _renderArrList,
   _newArrangementConfirm, _requestLoadArrangement, _newArrangement,
   _loadArrangementById, _snapshotArr, _resetArrHistory, _pushArrHistory,
   _arrUndo, _arrRedo, _restoreArrSnapshot, _markArrDirty,
   _refreshUndoButtons, _renderPalette, _renderTimeline, _renderMinimap,
   _renderRuler, _renderArrangerStartMarker, _renderTracks,
   _buildTrackEl, _isTrackAudible, _toggleTrackMute, _toggleTrackSolo,
   _buildCells, _toggleBlockSelection, _clearBlockSelection,
   _refreshBlockSelectionUI, _deleteSelectedBlocks, _copySelectedBlocks,
   _pasteBlocks, _duplicateSelectedBlocks, _nextFreeBar, _barWidth,
   _arrZoom, _arrZoomReset, _arrZoomV, _trackHeight,
   _toggleLoopPlayback, _toggleCountIn, _barFromX, _showDropPreview,
   _hideDropPreview, _addTrack, _deleteTrack, _addBlock, _moveBlock,
   _changeReps, _deleteBlock, _saveArrangement, _deleteArrangement,
   _duplicateArrangement, _adjustArrTempo, _adjustArrBars,
   _playArrangement, _scheduleCountIn, _stopArrangerPlay,
   _startPlaybarRAF, _stopPlaybarRAF, _renderArrangerPlayhead,
   _scheduleAutoSave, _onDocMouseMove, _onDocMouseUp
   ```

4. `_renderPlaybar` est **cross-cutting** (lit Pad + Live + Arranger) —
   **rester sur le modal**. La feature appelle `this.modal._renderPlaybar()`.

5. Remplacer dans `LoopCreatorModal.js` chaque méthode Arranger par un
   delegate 1-liner :
   ```js
   _playArrangement(b)    { return this.arrangerFeature?._playArrangement(b); }
   _stopArrangerPlay()    { this.arrangerFeature?._stopArrangerPlay(); }
   // …
   ```

6. Pas de getters back-compat nécessaires (state stays on modal).

### Phase 3 : validation (~1 h)

- `node --check` sur LoopCreatorModal.js + LoopManagerArrangerFeature.js
- Test manuel : ouvrir LoopManager → tab Arranger → créer arrangement,
  ajouter tracks, drop loops, jouer, undo/redo, sauver, charger
- Vérifier que `currentArrangementId` se met à jour quand un block est
  changé (via les delegates)

### Phase 4 : commit

```bash
git add -A
git commit -m "refactor(audit-§6.6): extract Arranger feature (final §6.6 slice)"
git push
```

Métriques attendues :
- LoopCreatorModal.js : 2 423 → ~960 (−60 %)
- LoopManagerArrangerFeature.js : ~1 500 (nouveau)
- §6.6 complète : LoopCreatorModal 3 394 → ~960 (−72 %)

## Pourquoi pas en 1 session

- 60 méthodes × ~25 lignes moyennes = ~1500 lignes à toucher
- Translation `this.X` ambiguë : nécessite liste blanche des 60 méthodes Arranger
- Risque de régression élevé sur l'arrangement (la feature la plus
  utilisée en production)
- Une seule erreur de prefix `this.modal.X` casse silencieusement le tab
  Arranger entier

Session dédiée recommandée avec :
- Script Python pour la translation (pas sed)
- Test e2e manuel après extraction
- Possibilité de revert propre

## Surface publique critique à préserver

Ce qui CASSE si on s'y reprend mal :

- `modal.currentArrangementId` lu par `_deleteLoopById` ligne 854
- `modal.blocks` lu par `_deleteLoopById` ligne 859
- `modal._renderPlaybar()` appelé par PadFeature.stop/trigger,
  LiveFeature.stop/trigger
- `modal._stopArrangerPlay()` appelé par `_setGlobalOutput` (panic),
  `doClose`, `_onClick stop-all-playback`
- `modal._initArrangerSynth()` appelé dans constructor (init lifecycle)
- `modal._initArrangerTab()` appelé par `_switchTab('arranger')`
- `modal._scheduleAutoSave()` appelé par `_onChange` / `_onInput` pour
  les champs `la-bars`, `la-name-input`, `la-tempo`

Tous ces accès doivent rester fonctionnels via delegates (forwarders sur
le modal) après extraction.
