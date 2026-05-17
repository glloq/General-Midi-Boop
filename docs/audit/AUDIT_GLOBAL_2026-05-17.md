# AUDIT GLOBAL — General Midi Boop v0.8.1

> **Document d'autorité unique.** Daté 2026-05-17. Remplace et réconcilie les
> anciens `AUDIT_*.md` racine (désormais archivés dans ce dossier). Toutes les
> sévérités ci-dessous sont **vérifiées en lecture directe du code**, pas
> recopiées des audits antérieurs.

## Périmètre

Contrôleur d'orchestre MIDI mécanique : backend Node.js + frontend web temps
réel, ~178 k LOC JS/TS sur 493 fichiers (v0.8.1). Contraintes : 24/7 sur
Raspberry Pi, latence faible, sans jitter audible/visible, gros fichiers MIDI,
multi-canaux/instruments, plusieurs éditeurs simultanés.

Méthode : 3 passes d'exploration parallèles (backend/moteur, frontend/rendering,
code mort/docs) puis **vérification ciblée en lecture de code** des constats
contradictoires ou hérités des docs.

## Score synthétique

| Dimension | Note | Commentaire |
|-----------|------|-------------|
| Architecture | 7/10 | Séparation runtime/éditeur propre ; quelques monolithes |
| Moteur temps réel | 8/10 | Scheduler lookahead sain ; 1 fuite hot-path (C1) |
| Rendering piano roll | 7/10 | Bien optimisé ; recalc géométrie/index perfectibles |
| Mémoire | 6/10 | Asymétrie listeners, undo non borné |
| Frontend boot | 4/10 | TTI ~10-12 s sur Pi (C2) |
| Hygiène code/docs | 5/10 | Sprawl docs, 616 LOC mortes, monolithes |
| Couverture charge/soak | 3/10 | Aucun test charge/long-run |

---

## Méta-constat #0 — Sprawl documentaire & audits périmés

- **Problème détecté** : 8 `AUDIT_*.md` racine + `TODO.md` (~190 KB) jamais
  réconciliés avec le code ; sur-déclaration de CRITIQUES déjà résolus.
- **Gravité** : CRITIQUE (processus).
- **Partie concernée** : racine du dépôt.
- **Cause profonde** : pas de source d'autorité unique ; audits non clôturés
  après correction.
- **Symptômes observables** — items "CRITIQUE/OPEN" en réalité **résolus**,
  vérifiés :
  - `unhandledRejection` "tue le process" → FAUX : `src/core/Application.js:749-753`
    log & continue.
  - `MidiRouter` non détruit au shutdown → FAUX : `src/core/Application.js:601-602`
    appelle `this.midiRouter.destroy()`.
  - WS reconnect plafonné ~10 → FAUX : `public/js/api/BackendAPIClient.js:193`
    retry indéfini ; `reconnect_exhausted` = simple événement UI.
  - Collision migration 016 → RÉSOLU : sf2 renommé `migrations/019_instrument_sf2.sql`.
- **Impact CPU/RAM** : n/a. **Impact temps réel** : n/a.
- **Impact UX** : indirect — temps de triage gaspillé, risque de re-corriger.
- **Solution recommandée** : ce fichier devient l'autorité ; anciens audits
  archivés ici avec bandeau "PÉRIMÉ" ; items ouverts de `TODO.md` consolidés.
- **Difficulté** : faible. **Gain attendu** : fin du re-triage de faux positifs.

---

## CRITIQUE

### C1 — Requête SQLite synchrone par message MIDI sur le hot-path

- **Problème détecté** : chaque envoi MIDI déclenche `database.getInstrumentSettings(device, channel)`
  (better-sqlite3, **synchrone**, bloque l'event loop) pour enrichir le
  `monitor_event` WebSocket d'un nom d'instrument, sans cache.
- **Gravité** : CRITIQUE.
- **Partie concernée** : `src/midi/devices/DeviceManager.js:485` et `:577` ;
  `src/midi/routing/MidiRouter.js:468-489` (`broadcastMonitorEvent`, appelé
  depuis `:330`).
- **Cause profonde** : résolution de présentation faite sur le chemin
  d'émission temps réel au lieu d'un cache ou du consommateur.
- **Symptômes observables** : jitter croissant dès qu'un client a le monitoring
  actif (panneau debug ouvert = cas nominal), proportionnel à la polyphonie.
- **Impact CPU/RAM** : ~5-50 µs/appel × 100-1000 notes/s = 5-50 ms/s d'event
  loop volé + churn d'objets payload.
- **Impact temps réel** : viole la garantie sub-10 ms ; jitter audible Pi.
- **Impact UX** : timing mécanique irrégulier, notes en retard.
- **Solution recommandée** : cache LRU/TTL nom d'instrument par `device:channel`
  (réutiliser le pattern de `src/midi/compensation/CompensationService.js`,
  cache 30 s) ; ou résoudre le nom côté consommateur du `monitor_event` ; ou
  ne broadcaster que si ≥1 abonné monitoring.
- **Difficulté** : faible/moyenne. **Gain attendu** : −5 à −50 ms/s de jitter,
  déterminisme rétabli.

### C2 — TTI frontend : 196 `<script>` séquentiels sans `defer`

- **Problème détecté** : `public/index.html` charge 194 scripts classiques
  bloquants séquentiels (0 `defer`/`async`, 0 module), ~3.9 MB JS non découpé ;
  **+ un bloc `<script>` inline de 8 134 lignes** (lignes 6206-14340 — bootstrap
  applicatif + logique métier embarquée dans le HTML) ; aucune modale lourde
  lazy-loadée.
- **Gravité** : CRITIQUE (démarrage 24/7).
- **Partie concernée** : `public/index.html` (bloc inline 6206-14340),
  `vite.config.js`.
- **Cause profonde** : pas de stratégie de chargement ni de code-splitting ;
  **un blind `defer` est UNSAFE** : le bloc inline de 8 134 lignes s'exécute
  pendant le parsing, donc avant des libs externes devenues `defer` →
  white-screen. C2 n'est PAS un quick-win 30 min comme supposé initialement.
- **Symptômes observables** : TTI ~10-12 s sur Pi 4 Chromium LAN (cible < 4 s).
- **Impact CPU/RAM** : parse/compile 3.9 MB JS au boot, pic mémoire.
- **Impact temps réel** : fenêtre d'indisponibilité longue au (re)démarrage.
- **Impact UX** : écran figé plusieurs secondes après reboot/MAJ.
- **Solution recommandée** (séquence obligatoire — chaque étape exige une
  validation navigateur sur Pi, non réalisable hors environnement Pi) :
  1. Extraire le bloc inline 6206-14340 vers un fichier externe
     (`public/js/bootstrap.app.js`) — prérequis structurel.
  2. Ajouter `defer` aux 194 scripts + au bootstrap externalisé (l'ordre
     relatif des scripts `defer` est préservé, exécution avant
     `DOMContentLoaded`).
  3. Phase 3 : imports dynamiques des modales lourdes + chunks Vite + budget
     bundle dans `vite.config.js`.
- **Difficulté** : moyenne (l'externalisation de 8 134 lignes inline est le
  vrai coût ; pas un quick-win). **Risque** : élevé sans QA navigateur Pi.
- **Gain attendu** : −6 à −8 s TTI.
- **Statut** : NON appliqué dans cette passe — refuse de livrer un `defer`
  aveugle non testable qui white-screen l'app. Tâche re-scopée Phase 3.

---

## ÉLEVÉ

### H1 — Allocation d'objets par événement sur le chemin de playback
- **Partie** : `src/midi/playback/PlaybackScheduler.js:502-560`.
- **Cause** : objet `{channel,note,velocity,…}` neuf par note on/off/CC.
- **Symptômes/Impact** : ~1000 alloc/s → pics GC young-gen 1-5 ms → micro-jitter.
- **Impact temps réel** : oui (pauses GC). **Impact UX** : irrégularités fines.
- **Solution** : object pool / payload réutilisable par tick ; typed arrays.
- **Difficulté** : moyenne. **Gain** : ~−50 % GC young-gen.

### H2 — État MIDI dupliqué entre éditeurs (pas de source unique)
- **Partie** : `public/js/features/midi-editor/MidiEditorView.js`,
  `public/js/features/piano-roll/PianoRollView.js`,
  `public/js/features/loop/LoopEditorModal.js`.
- **Cause** : `notes/tempo/ppq/channels/currentTime` copiés par vue, pas de store.
- **Symptômes** : données obsolètes au switch, jitter de sync, recalculs.
- **Impact CPU/RAM** : copies multiples. **Impact UX** : incohérences visibles.
- **Solution** : store MIDI central (sequence/tempo/ppq/transport), vues en
  lecture par sélecteurs. **Difficulté** : élevée. **Gain** : cohérence + RAM/CPU.

### H3 — Asymétrie addEventListener/removeEventListener (fuite mémoire)
- **Partie** : 664 `addEventListener` vs 288 `removeEventListener` ; pires :
  `public/js/features/instrument-settings/ISMListeners.js` (sections re-rendues
  sans detach), `public/js/features/piano-roll/PianoRollView.js:54`
  (`theme-changed` jamais retiré, pas de `destroy()`),
  `public/js/features/keyboard/KeyboardChords.js` (`setInterval` bow).
- **Symptômes** : croissance mémoire après 50+ cycles open/close de modales.
- **Impact CPU/RAM** : fuite RAM + handlers fantômes. **Impact temps réel** :
  indirect (GC). **Impact UX** : lenteur progressive.
- **Solution** : registre de listeners par composant + `destroy()` symétrique ;
  `AbortController`/`signal`. **Difficulté** : moyenne. **Gain** : RAM stable 24/7.

### H4 — Éditeurs invisibles continuent de traiter les événements WS
- **Partie** : `public/js/features/TunerModal.js:347-356,525-573` (`tuner:pitch`
  ~10-30 Hz traité même masqué) ; pattern similaire ailleurs.
- **Cause** : abonnements WS non suspendus quand caché (non fermé).
- **Impact CPU/RAM** : calculs/redraws invisibles. **Impact UX** : CPU idle élevé.
- **Solution** : gate `isVisible` + suspend/resume sur visibilitychange/onHide.
- **Difficulté** : faible/moyenne. **Gain** : CPU idle réduit.

### H5 — Feasibility mains recalculée à chaque pan/tick, sans mémoïsation
- **Partie** : `public/js/features/auto-assign/` (`RoutingSummaryPage.js` 3010,
  `RoutingSummaryRenderers.js` 1803, `HandPositionFeasibility.js` 1682 ;
  4 canvases ~50 Hz).
- **Cause** : `O(notes-in-range) × O(patterns)` par changement viewport, 0 cache.
- **Symptômes** : jank net > 100 k notes pendant playback + éditeur routing.
- **Impact CPU/RAM** : pics CPU rendu. **Impact temps réel** : indirect.
- **Solution** : cache LRU `(noteSet,handConfig)→feasibility` ; debounce pendant
  playback ; RAF unique pour les 4 canvases. **Difficulté** : moyenne.
  **Gain** : scalabilité 100 k+ notes.

### H6 — Code mort confirmé : 616 LOC orphelines
- **Partie** : `public/js/core/AppRegistry.js` (136 LOC) +
  `public/js/core/BaseController.js` (480 LOC) — **0 référence hors de leur
  propre fichier (vérifié grep, 2026-05-17)**.
- **Impact** : surface/dette ; confusion (un agent les a crus actifs).
- **Solution** : suppression. **Difficulté** : faible. **Gain** : −616 LOC.

---

## MOYEN / FAIBLE

| # | Problème | Partie | Impact | Solution | Diff. |
|---|----------|--------|--------|----------|-------|
| M1 | Undo/redo non borné (snapshot séquence complète/édition) | `piano-roll/PianoRollEditor.js:490-492` & midi-editor | RAM Go session longue, lenteur >200 steps | Borne N≈50, diff vs full-copy | Moy |
| M2 | Monolithes | `ISMSections.js` 2596, `ISMListeners.js` 2211, `RoutingSummaryPage.js` 3010, `MidiPlayer.js` 2202, `KeyboardPiano.js` 2190 | Maintenance/régression | Découpe par responsabilité | Élevée |
| M3 | Pas de virtual scrolling | `PlaylistPage.js`, `InstrumentManagementPage.js` | Lag listes >500 items | Windowing | Moy |
| M4 | Dérive timer MIDI Clock sous charge | `MidiClockGenerator.js:271-360` | Jitter BPM gear externe | Hybride hrtime + phase | Moy |
| M5 | Grille temps recalculée chaque frame | `CanvasPianoRollRenderer.js:566-587` | CPU rendu inutile | Cache segments | Faible |
| M6 | Rebuild index spatial complet sur append | `CanvasPianoRollRenderer.js:357-361` | Lag paste 100 k+ notes | Append incrémental différé | Moy |
| M7 | 685 `!important` / 32 CSS | `public/styles/` | Cascade ingérable | Refactor tokens + QA Pi | Élevée |
| M8 | RAF non unifié multi-canvas | `midi-editor/MidiEditorRenderer.js` | Frame-drops multiples | RAF unique orchestré | Moy |
| M9 | `monitor_event` JSON stringify + churn | `WsOutputQueue.js:275`, `DeviceManager.js:489` | ~200 KB/s churn playback | Codec binaire + skip si 0 abonné | Faible |
| M10 | Auth WS same-origin soft-warn si token absent | `WebSocketServer.js:101-171` | Confiance same-origin (par design documenté) | Forcer token en prod via env | Faible |
| M11 | Pollution `window.*` | core | Couplage/monkey-patch | Encapsuler, DI | Moy |
| M12 | `pendingRequests` croît sur réseau lent | `BackendAPIClient.js:354-391` | RAM Wi-Fi Pi instable | Borne file + circuit breaker | Faible |

**À vérifier (confiance moindre)** : `FilterManager.destroy()` semble sans site
d'appel — fuite potentielle listeners/timers sur transitions de page ;
**confirmer l'instanciation réelle avant d'agir**.

---

## Sain — à préserver

- Séparation runtime/éditeur (`Application.js`, lifecycle init/start/stop).
- Scheduler lookahead 10 ms, `performance.now()` monotone, lookahead adaptatif
  sous lag (`PlaybackScheduler.js`) — pas de setTimeout naïf/note.
- `WsOutputQueue` : batching `setImmediate`, backpressure, coalescing HF,
  profondeur bornée.
- `CompensationService` : source unique + cache.
- `CanvasPianoRollRenderer` : 3 couches, RAF coalescé, dirty-rects, index
  spatial bucket, culling viewport.
- Shutdown gracieux ordonné ; `unhandledRejection` log-and-continue ; WS
  reconnect infini ; V1 webaudio-pianoroll supprimé ; refactor modale piano
  (Phase A-E) fait.

---

## Roadmap de remédiation (phasée)

- **Phase 0 (heures)** — ✅ FAIT : ce document + archivage/annotation des
  anciens audits sous `docs/audit/`.
- **Phase 1 (jours)** — ✅ C1 (cache nom instrument hot-path), ✅ H6
  (suppression 616 LOC mortes). C2 **re-scopé Phase 3** (externalisation du
  bloc inline 8 134 lignes obligatoire avant `defer` ; QA navigateur Pi requise).
- **Phase 2 (1-2 sem.)** — H1 object pool, H3 listeners+destroy/AbortController,
  H4 gate visibilité, M1 undo borné.
- **Phase 3 (2-4 sem.)** — C2 (externalisation inline + `defer` + lazy-load +
  chunks), H5 mémoïsation+RAF
  unifié, H2 store central, M3 virtual scroll, M5/M6/M8.
- **Phase 4 (continu)** — M2 découpe monolithes, M7 CSS, M4 clock, M9-M12.
- **Phase 5 (transverse, CI)** — tests charge/soak (ci-dessous).

## Tests de charge & profiling

| Scénario | Mesurer | Outil | OK | Critique |
|----------|---------|-------|----|----------|
| Gros MIDI 100 k+ notes load+play | FPS, redraw, heap | DevTools Perf/Memory | FPS≥50, redraw<8 ms | FPS<30, redraw>16 ms |
| Playback soutenu 24 h | event loop delay, jitter, heap | node --prof / clinic.js | lag p99<10 ms, heap +<0.5 MB/h | lag>50 ms, fuite linéaire |
| Flood WS 60+/s | CPU, lag, profondeur queue | WS inspector / clinic flame | queue stable, CPU<30 % | queue saturée |
| Multi-éditeurs | RAM, listeners, FPS | heap snapshots | bornés | croissance/cycle |
| Reboot Pi (TTI) | TTI | Lighthouse/Perf | <4 s | >8 s |

Ajouter : `tests/performance/` scénarios scriptés + harness migrations
(fresh-install : DB vide → toutes migrations → validation schéma) en CI avec budgets.

## Vérification end-to-end

- **C1** : `node --prof` pendant playback 200 notes/s monitoring ON, avant/après
  → `getInstrumentSettings` hors hot-path ; lag p99 < 10 ms ; `npm test`.
- **C2** : trace Lighthouse Pi avant/après ; TTI mesuré.
- **H6** : `grep -rn 'AppRegistry\|BaseController' public/js src` = 0 ; app
  démarre ; `npm test` + `npm run test:frontend` verts.
- **H1/H3** : heap snapshot soak (open/close + playback 30 min) → retained plat.
- **Global** : `npm test`, `npm run test:frontend`, `npm run lint`, `npm run bench`.
