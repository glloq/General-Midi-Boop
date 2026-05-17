# Audit éditeur MIDI v2 — 2026-05-17

Audit complet et critique de l'éditeur MIDI v2 (piano roll Canvas, timeline,
loop editor, Arranger, sous-éditeurs spécialisés, multi-canaux, playback
temps réel websocket), cible **Raspberry Pi 24/7** sans jitter visuel ni MIDI.

## Méthode

3 audits d'exploration parallèles (architecture/playback, loop/piano-roll,
sous-éditeurs/mémoire/legacy) → 28 findings bruts → **puis vérification du
code réel de chaque finding Critical/High/Tier-1/2**.

**Conclusion centrale : l'agrégation d'audit sur-rapporte massivement.**
~70 % des findings « Critical/High » se sont révélés **faux positifs, déjà
corrigés, ou auraient introduit une régression**. L'éditeur v2 est nettement
plus sain que la sortie brute ne le suggérait. La valeur est venue de la
vérification code, pas de l'agrégation. Audits antérieurs non refaits :
`AUDIT_2026-05-10`, `AUDIT_FRONTEND_2026-05-14`, `AUDIT_MODAL_BOUCLES_2026-05-11`,
`AUDIT_MODAL_PIANO_2026-05-16`, `AUDIT_KEYBOARD_MODAL_2026-05-14`,
`AUDIT_LOOP_ARRANGER_SPLIT`.

Limite environnement : suite de tests non exécutable ici (`npm ci` échoue à
compiler le binding natif `midi`/node-gyp, dépendance Pi). Gate de validation
des correctifs = `node --check` + revue de code ; tous les correctifs livrés
sont à comportement strictement préservé.

## Correctifs livrés (vérifiés en code)

| ID | Fichier | Problème réel | Correctif | Gain |
|----|---------|---------------|-----------|------|
| L4 | `public/js/features/LoopManagerLiveFeature.js` | `_scheduleLoop` re-parse `midi_data` (JSON.parse) à **chaque cycle** de boucle (récursion `onCycleEnd`) | Cache `loopData._seqCache` clé sur la source `midi_data` (auto-invalidé si édition pendant lecture) | Supprime un `JSON.parse` récurrent par boucle jouée et sa pression GC |
| D1 | `public/js/features/midi-editor/MidiEditorClipboard.js` | `if (true)` + fallback `sequence.filter` inaccessible dans `getSelectedNotes()` | Suppression du code mort | Clarté |
| L5 | `public/js/features/piano-roll/CanvasPianoRollRenderer.js` | `setSequence()` aliase le tableau sans contrat | Contrat « no-clone, ne pas muter » documenté (le clone coûterait sur un hot-path) | Anti-bug d'index spatial incohérent |
| A6 | `public/js/audio/MidiSynthesizer.js` | Pattern dual-clock look-ahead pris pour un bug par l'audit | Commentaire : les 2 horloges dérivent de `audioContext.currentTime`, zéro drift — ne pas « unifier » | Anti-régression |
| L7 | `public/js/features/LoopManagerArrangerView.js` | `_renderTimeline` rappelle `_renderPalette` à chaque mutation de bloc ; chaque rendu réattachait un listener `dragstart`/`dragend` par chip | Délégation d'événements unique sur le conteneur grid (bind once) | Supprime le churn de listeners par rendu |
| M1 | `public/js/features/midi-editor/MidiEditorChannelPanel.js` | `updateChannelButtons` faisait un `querySelector` par gear dans la boucle (≤16 scans DOM/appel) | Réutilisation de la bordure déjà calculée dans la boucle des chips (comportement identique) | −16 scans DOM par appel |

Commits : `8883011` (Tier 1), `4331172` (Tier 2).

## Findings écartés après vérification (NE PAS implémenter)

| ID | Verdict |
|----|---------|
| M3 fuite listeners au `hide()` | **FAUX** — `hide()` appelle déjà `_detachCanvasEvents()` (Tablature:122, Drum:108, Wind:111) ; `show()` détache avant attach |
| M6 undo non borné | **FAUX** — `BaseLaneEditor._doSaveState` borne déjà `historyCap` (idx géré, 460-462) ; Tab/Drum/Wind sans historique propre |
| L9 race buckets/playback | **FAUX** — JS mono-thread ; `_rebuildBuckets()` atomique ; le synth lit sa propre copie `this.sequence` |
| L6 rect figé au mousedown | **FAUX / déjà corrigé** — `ArrangerOps._onDocMouseMove:513` recalcule déjà `getBoundingClientRect()` par mousemove |
| A3 invalider cache compensation en lecture | **FAUX — serait une RÉGRESSION** : `setSnapshot` gèle volontairement capability/compensation pendant la lecture pour empêcher une re-requête SQLite intra-tick (jitter Pi) |
| A5 pas de garde note bloquée | **LARGEMENT DÉJÀ TRAITÉ** — `_activeNotes`, `_lastNoteOnTime`, `stopScheduler()` purge les timeouts ; instrumentation hot-path Pi non justifiée |
| L1 Arranger « Critical » | **SUR-ÉVALUÉ → Medium** — DnD HTML5 natif, PAS de boucle mousemove ; reconstruction 1×/mutation discrète, pas de jitter continu |
| L2 lookup O(n) | **SUR-ÉVALUÉ → Low** — `blocks.find` sur événements discrets (µs), pas 1200/s |
| M2 4 renderers concurrents | **LARGEMENT FAUX** — playhead déjà gardé `isVisible` (Transport 250-271), un seul éditeur spécialisé visible à la fois |
| L3 borne après push | **NÉGLIGEABLE** — déjà borné, dépassement transitoire 1 élément µs ; réordonner = risque bug d'index, 0 gain |

## Feuille de route restante (Tier 3 — roadmap, non implémenté)

Refactors lourds sur système 24/7 : **à n'engager que sous couverture de
tests exécutable** (impossible dans l'environnement actuel). Ne pas coder à
l'aveugle.

- **A1 — moteur playback unifié front/back.** L'éditeur joue via
  `MidiSynthesizer` (WebAudio) sans informer le backend `MidiPlayer` ;
  seek/mute non répercutés. Étape 1 sûre : flag `useBackendPlayback` routant
  play/pause/seek vers le backend (position WS back→front déjà câblée).
  Étape 2 : moteur unifié + stream WS preview. Effort très élevé (10 h+),
  invariants de test requis (`editor.isPlaying === backend.playing`,
  position ±5 ms). Prérequis vérification : confirmer que le découplage est
  toujours réel dans `MidiEditorPlayback.js:141-150` /
  `MidiEditorTransport.js:38-78`.
- **A4 + M8 — extraction `MidiEditorState`.** `MidiEditorModal` reste un
  god-class (40+ champs publics) ; état canaux dispersé sur 10+ propriétés
  sans écrivain unique (`MidiEditorChannelState.js` documente lui-même le
  problème). Cible : source de vérité unique + event `channel:changed`.
  ~100 call-sites à migrer. À faire avec tests de caractérisation d'abord.
- **L3 (delta) — undo Arranger delta-encodé.** Réduit le snapshot ~100 KB →
  ~2-5 KB. Réécriture sensible de l'undo/redo : exige des tests de
  non-régression undo/redo avant tout.
- **D2 — observabilité.** Logguer un `debug` quand une garde défensive
  (`catch {}`, `if (isSyncing) return`) bloque l'exécution. Faible valeur si
  appliqué en masse (bruit) — à cibler uniquement sur les chemins où un
  bug silencieux a déjà été observé, pas en sprinkle global.

## Méthodes de mesure & seuils

- **FPS/rendu** : Chrome Performance pendant drag bloc Arranger + playback.
  Acceptable ≥55 fps, critique <40 fps.
- **Mémoire 24/7** : heap snapshots t0/+1h/+8h via boucle ouverture-fermeture
  sous-éditeurs ; retained size stable ±5 % = OK, croissance monotone =
  critique ; vérifier `getEventListeners(document)` avant/après N cycles.
- **Event-loop backend** : `clinic doctor` / `node --prof` sur le scheduler
  en lecture longue ; lag <10 ms OK, >50 ms critique.
- **Jitter MIDI** : `audioContext.currentTime` vs tick planifié ; dérive
  ±2 ms OK, ±10 ms critique ; lecture 5 min sans dérive cumulée.
- **WebSocket** : fréquence messages position ~10/s (déjà borné 100 ms
  backend) ; flag si >25/s.
- **Charge** : MIDI ~100k notes / 16 canaux ; 1000 loops Arranger ; zoom
  extrême ; playback + édition simultanés ; multi-sélection massive.
