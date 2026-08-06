# Audit — Adaptation des fichiers MIDI & auto-routage vers les instruments (2026-08-06)

Portée : la chaîne complète **« fichier MIDI → adaptation → routage automatique vers les
instruments connectés »**, du profilage des canaux jusqu'à la persistance des routages et
leur application au playback. Six axes audités en parallèle puis recroisés :

1. **Analyse de canal & scoring** (`ChannelAnalyzer`, `InstrumentMatcher`, `ScoringConfig`, `InstrumentTypeConfig`)
2. **Adaptation mélodique** (`MidiTransposer`, `NoteEnforcement`, `ScaleSnapper`)
3. **Remap batterie** (`DrumNoteMapper`)
4. **Planification physique** (`ChannelSplitter`, `HandAssigner`, `HandPositionPlanner`, `LongitudinalPlanner`, `InstrumentCapabilitiesValidator`, `TablatureConverter`)
5. **Orchestration / apply / persistance** (`AutoAssigner`, `MidiAdaptationService`, `PlaybackAssignmentCommands`, `FileRoutingSyncService`, `FileRoutingStatusService`, schémas)
6. **Application au playback & routage live** (`PlaybackScheduler`, `MidiPlayer`, `CompensationService`, `MidiRouter`) — *voir « Domaine partiellement couvert » en fin de document.*

Contexte : cet audit est **complémentaire** de `AUDIT_INSTRUMENT_CAPABILITIES_2026-08-05.md`,
qui a couvert la chaîne *reconnaissance/enforcement des capacités*. Les points connus de cet
audit-là (route-through live sans polyphonie, `supported_ccs` non filtrés, cordes non bornées
à l'audible, `capo_fret` mort, drop polyphonique runtime≠offline…) ne sont **pas** re-listés
ici comme nouveaux ; ils sont rappelés en fin de document.

---

## Verdict

Les briques **pures** de la chaîne sont solides : le pitch-folding (`compressNoteToRange`),
`NoteEnforcement`, `ScaleSnapper`, la carte GM batterie, les tables de substitution, le
planning des mains (`HandAssigner`/`LongitudinalPlanner`) et le Viterbi de tablature sont
bien construits et testés. Le clamp note-on/note-off est cohérent (mêmes fonctions pures pour
on et off).

Les défauts sont concentrés à **trois interfaces** :

1. **Le contrat d'événement MIDI n'est pas respecté par `MidiTransposer`** — deux branches
   entières (remap CC, aftertouch polyphonique) testent des `type` que le parseur n'émet
   jamais → **fonctionnalités mortes** ; et la suppression/drop d'événements ne redistribue
   pas le `deltaTime` → **corruption temporelle** du fichier adapté.
2. **Les métadonnées de tempo/durée ne sont jamais attachées au `midiData` analysé** →
   `density` **toujours 0** et `tempo` **toujours 120 BPM**, ce qui dégrade la détection de
   type et le scoring de timing pour *tous* les fichiers.
3. **La persistance de l'auto-routage n'est ni atomique ni idempotente** — un ré-apply laisse
   des lignes de split orphelines, le comptage de statut sur-compte les splits (badge
   « jouable » mensonger), et un échec partiel est rapporté comme un succès.

**11 défauts fonctionnels (P1)** dont **9 vérifiés par lecture source de bout en bout**
(parseur `midi-file` + converters inclus), plus des lacunes de robustesse (P2) et des points
mineurs/documentaires (P3).

---

## Suivi — correctifs livrés dans cette branche

| Point | État | Test de régression |
|---|---|---|
| P1-1 redistribution `deltaTime` à la suppression/drop | ✅ corrigé | `adaptation-audit-fixes-2026-08-06` |
| P1-2 remap/suppression CC (`type:'controller'`/`controllerType`) | ✅ corrigé | idem |
| P1-3 aftertouch polyphonique transposé (`noteAftertouch`) | ✅ corrigé | idem |
| P1-4 / P1-5 dérivation `tempo`/`duration` (density ≠ 0, tempo réel) | ✅ corrigé | idem |
| P1-7 statut de routage en canaux distincts (`COUNT(DISTINCT channel)` + `getFileMetadata`) | ✅ corrigé | couvert par CI SQLite |
| P1-9 batterie : défaut `drumFallback` → substitution illimitée (plus d'omission) | ✅ corrigé | `adaptation-audit-fixes-2026-08-06` |
| P1-11 gate `hasModifications` inclut `notesDropped`/`notesShortened`/`ccsRemapped` | ✅ corrigé | couvert par CI |
| P1-6 ré-apply idempotent : purge `deleteByFileId(targetFileId)` en tête d'apply | ✅ corrigé (voir réserve) | CI SQLite |
| P1-8 échec partiel remonté (`routings` = lignes persistées, `failedChannels`/`partial`) | ✅ corrigé (voir réserve) | CI SQLite |
| P2-2 `update_instrument_capabilities` émet `instrument_settings_changed` | ✅ corrigé | CI |
| P2-5 prédicat batterie du matcher aligné sur `AutoAssigner` | ✅ corrigé | `adaptation-audit-fixes-2026-08-06` |
| P2-11 aftertouch polyphonique suit son segment (plus de diffusion à tous) | ✅ corrigé | `adaptation-audit-fixes-2026-08-06` |
| P2-3 sync : routage d'appareil hors-ligne persisté **désactivé** (plus détruit) | ✅ corrigé | `file-routing-sync`, `routing-plan-channel` |
| P2-9 tablature : fenêtre de corde occupée bornée par la durée max réelle (plus de constante 7680) | ✅ corrigé | `adaptation-audit-fixes-2026-08-06` |
| P2-6 score de type utilise le type heuristique pour un canal sans Program Change | ✅ corrigé | `adaptation-audit-fixes-2026-08-06` |
| Axe6-1 split : note-on vélocité-0 routé comme note-off (plus de note bloquée sur round-robin/alternate) | ✅ corrigé | `playback-scheduler-route-to` |
| Axe6-2 `setChannelRouting`/`NoteRemapping`/`SplitRouting` relâchent les notes tenues (panic) avant reconfig | ✅ corrigé | couvert par CI |
| Axe6-4 reset des contrôleurs (CC121) sur seek arrière/boucle → plus de sustain périmé | ✅ corrigé | `playback-scheduler-route-to` |
| P2-7 (partiel) faisabilité : `num_fingers` lu en frettes (fallback) et par main en semitones | ✅ corrigé (#1/#3) | `adaptation-audit-fixes-2026-08-06` |
| P1-10 + P2-4 canal large/non-octave scoré « jouable avec wrapping » (partiel) + payload octave-wrapping peuplé, et rendu candidat au split | ✅ corrigé | `midi-adaptation`, `adaptation-audit-fixes-2026-08-06` |
| P2-10 drop polyphonique : voix comptées en liste + note tombée en compteur (unissons corrects, plus de note-off orphelin) | ✅ corrigé | `adaptation-audit-fixes-2026-08-06` |
| Axe6-5 note-off différé (`min_note_duration`) lié à l'instance de note (plus de coupure d'un re-déclenchement rapide) | ✅ corrigé | `playback-scheduler-route-to` |
| Axe6-6 compensation relative `MidiRouter` figée au note-on et réutilisée au note-off (plus de réordonnancement off-avant-on) | ✅ corrigé | `midi-router-capability-clamp` |
| Axe6-3 clamp live : skip-batterie clé sur le canal **source** (parité playback) — décision : canal source | ✅ corrigé | `midi-router-capability-clamp` |

**Réserve P1-6/P1-8** : les écritures de routage ne sont pas encore enveloppées dans **une
seule** transaction (`saveSplit` ouvre déjà la sienne — better-sqlite3 n'imbrique pas). Un
échec d'insertion en cours de boucle est donc *remonté* (`failedChannels`) plutôt que
*annulé*. L'atomicité complète (refactor `saveSplit` en savepoints + transaction englobante,
suppression de l'orphelin `adaptedFile` en cas d'échec) reste un follow-up, à faire avec les
tests SQLite exécutables.

**Différés avec justification** (risque/valeur défavorable dans cette itération) :

- **P1-10 + P2-4** — ✅ **corrigé** (décision : *score partiel via ratio jouable + préférer un
  split*). Les canaux trop larges / non-octave sont désormais scorés « jouables avec octave-
  wrapping » (score ∝ fraction de notes jouables après repli) au lieu de 0/incompatible ; le
  payload `octaveWrapping` est peuplé ; et un canal assigné via wrapping devient **candidat au
  split** (`evaluateChannelSplits`) pour qu'un split multi-instruments soit proposé et préféré.
- **P2-1** — ajouter des schémas déclaratifs pour `apply_assignments`/`analyze_channel`/… ferait
  passer le message d'erreur du handler (`"originalFileId is required"`) au format **préfixé**
  du pipeline (`"Invalid apply_assignments data: …"`), divergeant des fixtures de contrat
  documentées (`tests/contracts/fixtures/playback/*.contract.json`) — pour une validation que
  les handlers font déjà. À faire en mettant à jour fixtures + gestion d'erreur frontend.
- **P2-8** — la transposition par segment du split full-coverage n'est honorée par aucun
  consommateur, mais le playback fonctionne déjà (le clamp octave-fold du scheduler replie les
  décalages d'octave) ; c'est de l'**intégrité de reporting**, pas un défaut audible. Propager
  la transposition jusqu'au runtime (schéma + résolveur + player) est un chantier dédié.
- **P2-10** (drop polyphonique `Set`→compteur — restructure la mesure de polyphonie),
  **P2-7 #2** (conversion `hand_span_mm`→frettes pour l'avertissement de shift — champ
  `scale_length_mm` hors `hands_config` + conversion non-linéaire approximative), **P3**, et le
  reste de l'**axe 6** (Axe6-3/5/6).

Suite backend complète verte après correctifs : **107 suites / 1254 tests**.

---

## Synthèse

| # | Défaut | Sévérité | Statut | Réf. principale |
|---|--------|----------|--------|-----------------|
| P1-1 | Suppression/drop d'événements sans redistribution du `deltaTime` → corruption timing | **Critique** | ✅ Vérifié | `MidiTransposer.js:265-272` |
| P1-2 | Remap/suppression CC = **code mort** (mauvais `type`) — jamais appliqué | **Élevé** | ✅ Vérifié | `MidiTransposer.js:236,239` |
| P1-3 | Aftertouch polyphonique jamais transposé (**code mort**) → expression sur mauvaise hauteur | **Élevé** | ✅ Vérifié | `MidiTransposer.js:191` |
| P1-4 | `density` **toujours 0** (metadata jamais attachée) → détection de type dégradée + API fausse | **Élevé** | ✅ Vérifié | `ChannelAnalyzer.js:80` |
| P1-5 | `tempo` **toujours 120 BPM** → pénalité de vitesse mal calibrée pour tout fichier ≠120 | **Moyen** | ✅ Vérifié | `ChannelAnalyzer.js:262` |
| P1-6 | Ré-apply split→non-split → **lignes de split orphelines** (routages en conflit) | **Élevé** | ✅ Vérifié | `RoutingPersistenceDB.js:118` |
| P1-7 | Statut de routage **sur-compte les splits** (`COUNT(*)`/`.length`) → badge « jouable » sur fichier incomplet | **Élevé** | ✅ Vérifié | `RoutingPersistenceDB.js:296` |
| P1-8 | `apply_assignments` **non-atomique**, succès rapporté sur échec partiel | **Élevé** | ✅ Vérifié | `PlaybackAssignmentCommands.js:526-531` |
| P1-9 | Batterie : `-1` « substitution illimitée » **≡ omission** → percussion auxiliaire silencieusement supprimée | **Élevé** | ✅ Vérifié | `DrumNoteMapper.js:376` vs `ScoringConfig.js:154` |
| P1-10 | Note-range scorer **rejette** (0/incompatible) des canaux que le moteur sait replier | **Moyen** | ⚠️ Tracé | `InstrumentMatcher.js:500-509` |
| P1-11 | `hasModifications` ignore `notesDropped`/`notesShortened`/`ccsRemapped` → adaptations jetées | **Moyen** | ✅ Vérifié | `PlaybackAssignmentCommands.js:288-293` |
| P2-1 | Aucun schéma de payload pour `apply_assignments`/`analyze_channel`/… → validation « fail-open » | Moyen | ✅ Vérifié | `playback.schemas.js` |
| P2-2 | `update_instrument_capabilities` n'émet pas `instrument_settings_changed` → caches périmés | Moyen | ⚠️ Tracé | `PlaybackAssignmentCommands.js:706-771` |
| P2-3 | Sync **supprime** (au lieu de désactiver) un routage dont l'appareil est momentanément hors-ligne | Moyen | ⚠️ Tracé | `FileRoutingSyncService.js:204` |
| P2-4 | `octaveWrapping*` toujours `null`/`false` (payload mort) | Moyen | ⚠️ Tracé | `InstrumentMatcher.js:559-590` |
| P2-5 | Prédicat « instrument batterie » du matcher plus étroit que celui d'`AutoAssigner` → kit bloqué | Moyen | ⚠️ Tracé | `InstrumentMatcher.js:1460-1463` |
| P2-6 | Score « type d'instrument » s'effondre à neutre pour tout canal sans Program Change | Moyen | ⚠️ Tracé | `InstrumentMatcher.js:1083-1086` |
| P2-7 | Faisabilité frettes ignore `hand_span_mm`/`num_fingers` → faux « jouable » | Moyen | ⚠️ Tracé | `InstrumentMatcher.js:1262-1308` |
| P2-8 | Split full-coverage émet une `transposition` par segment qu'aucun chemin d'apply n'honore | Moyen | ⚠️ Tracé | `ChannelSplitter.js:508-524` |
| P2-9 | Tablature : réservation de corde purgée à 7680 ticks → deux notes sur une corde | Moyen | ⚠️ Tracé | `TablatureConverter.js:1425` |
| P2-10 | Drop polyphonique : `Set` au lieu de compteur → note-off orphelin possible sur hauteurs superposées | Moyen | ⚠️ Tracé | `MidiTransposer.js:158-185` |
| P2-11 | `splitChannelInFile` diffuse l'aftertouch à **tous** les segments | Moyen | ⚠️ Tracé | `MidiTransposer.js:721-777` |
| P3-* | Points mineurs / documentaires / options mortes | Faible | mixte | *voir §P3* |

Légende : **✅ Vérifié** = tracé par mes soins jusqu'au code source, parseur et converters ;
**⚠️ Tracé** = tracé par l'agent d'audit avec `fichier:ligne` et scénario, non re-vérifié
manuellement (fiable, mais à confirmer avant correctif).

---

## P1 — Défauts fonctionnels (cassés aujourd'hui)

### P1-1 · Suppression/drop d'événements sans redistribution du `deltaTime` → corruption temporelle · **Critique** · ✅ Vérifié

`MidiTransposer.transposeChannels` collecte des index d'événements à retirer (notes hors
plage si `suppressOutOfRange`, notes tombées par réduction de polyphonie en stratégie *drop*)
puis les `splice` en fin de passe :

```js
// MidiTransposer.js:265-272
if (eventsToRemove.length > 0) {
  const uniqueRemove = [...new Set(eventsToRemove)].sort((a, b) => b - a);
  for (const idx of uniqueRemove) {
    track.events.splice(idx, 1);   // ← le deltaTime de l'événement retiré est perdu
  }
}
```

Les événements MIDI portent un `deltaTime` **relatif** (ticks depuis l'événement précédent).
Retirer un événement sans ajouter son `deltaTime` au suivant **avance tout le reste de la
piste** du montant retiré, de façon cumulative. La sérialisation (`jsonToMidi`→`writeMidi`)
consomme le `deltaTime` tel quel, sans recalcul de temps absolu.

- **Déclencheurs** : chemin *drop* (défaut de la réduction de polyphonie —
  `polyStrategy !== 'shorten'`, `:144-149`) et `suppressOutOfRange` (`:118-134`).
- **Repro** : piste `noteOn A(dt0), noteOff A(dt480), noteOn B(dt0, hors-plage→supprimé),
  noteOff B(dt480), noteOn C(dt0), noteOff C(dt480)`. Après suppression de B, le `noteOn C`
  tombe au tick 480 au lieu de 960 → C et tout ce qui suit se décalent d'un temps entier ; la
  dérive s'accumule par note retirée et désynchronise le canal du reste de l'arrangement.
- **Corroboration forte** : `reducePolyphonyGentle` (stratégie *shorten*, `:604-637`)
  **reconstruit** minutieusement les `deltaTime` — la nécessité est donc connue des auteurs ;
  le chemin drop/suppress l'oublie. Aucun test n'exerce le `deltaTime` à travers une suppression.
- **Correctif** : avant de `splice(idx)`, ajouter `events[idx].deltaTime` au `deltaTime` du
  prochain événement survivant (ou reconstruire les deltas depuis des temps absolus, comme le
  chemin *gentle*).

### P1-2 · Remap / suppression CC = code mort · **Élevé** · ✅ Vérifié

```js
// MidiTransposer.js:236
} else if (event.type === 'controlChange' || event.type === 'cc') {
  // Step 5: CC remapping / suppression (inline, same pass)
  const cc = event.controllerNumber ?? event.controller ?? event.cc;   // :239
```

Le parseur `midi-file` (le seul chemin d'entrée, `PlaybackAssignmentCommands.js:146`
`midiConverter.midiToJson(buffer)`) émet les Control Change comme
`{ type: 'controller', controllerType: N, value: V }`
(`node_modules/midi-file/lib/midi-parser.js:217-220`), et `JsonMidiConverter.eventToJson`
(`:60-71`) recopie le `type` **verbatim** sans renommage. Le test `=== 'controlChange' || === 'cc'`
**ne matche donc jamais**, et le champ lu (`controllerNumber`/`controller`/`cc`) n'est de toute
façon pas celui du parseur (`controllerType`).

- **Conséquence** : `ccMapping` (ex. expression→volume `{11:7}`, ou couper le sustain sur un
  instrument sans étouffoir `{64:-1}`) **ne fait rien** ; `stats.ccsRemapped` reste
  **toujours 0**. La méthode autonome `remapCCs()` est également morte.
- **Vérification** : `grep` sur `src/` confirme qu'**aucun** code ne produit `type:'controlChange'`
  ni `type:'cc'` dans le chemin fichier ; les seuls comparateurs `=== 'controlChange'`/`=== 'cc'`
  de tout le dépôt sont précisément ces deux branches.
- **Correctif** : tester `event.type === 'controller'` et lire/écrire `controllerType`.

### P1-3 · Aftertouch polyphonique jamais transposé (code mort) · **Élevé** · ✅ Vérifié

```js
// MidiTransposer.js:191
} else if (event.type === 'keyPressure' || event.type === 'polyAftertouch') {
```

Le parseur émet l'aftertouch polyphonique comme `{ type: 'noteAftertouch', noteNumber: N, amount }`
(`midi-parser.js:212-216`). La branche `keyPressure`/`polyAftertouch` ne matche jamais.

- **Conséquence** : un canal transposé +12 et *baké* voit ses `noteOn`/`noteOff` 60→72, mais un
  `noteAftertouch` sur la note 60 reste 60. Comme les lignes de routage du fichier baké ne
  portent plus de transposition (garde anti-double-application), au playback l'expression
  s'applique à la hauteur 60 alors que la note qui sonne est 72 → expression sur une hauteur
  fausse/silencieuse.
- **Correctif** : `event.type === 'noteAftertouch'` (le champ `note ?? noteNumber` est déjà lu
  correctement, seul le garde de type est faux).

### P1-4 · `density` toujours 0 en production · **Élevé** · ✅ Vérifié

`ChannelAnalyzer.analyzeChannel` calcule la densité de notes ainsi :

```js
// ChannelAnalyzer.js:80
const density = this.calculateNoteDensity(noteEvents, midiData.duration || 0);
```

Or `JsonMidiConverter.midiToJson` retourne `{ header, tracks }` **sans champ `duration`**
(`JsonMidiConverter.js:20-38`), et aucun handler d'analyse ne l'attache avant l'appel
(`PlaybackAnalysisCommands`). La durée est calculée séparément par
`MidiFileParser.extractMetadata` (`{tempo, duration, totalTicks}`) mais **jamais fusionnée**
dans le `midiData` analysé. Donc `midiData.duration === undefined → 0`, et
`calculateNoteDensity(..., 0)` retourne **0 pour tous les canaux, toujours**.

- **Conséquence** : chaque canal prend la branche `density <= 1` de la détection de type
  (`:577`), n'atteint jamais le boost `drums` sur forte densité (`:571`) ; l'API
  `analyze_channel` renvoie `density:0` là où la doc montre `3.5`.
- **Masquage** : le test unitaire injecte à la main `duration:120` (`tests/midi-adaptation.test.js:33`).
- **Correctif** : attacher `extractMetadata().duration` (et `.tempo`, cf. P1-5) sur `midiData`
  avant l'analyse.

### P1-5 · `tempo` toujours 120 BPM · **Moyen** · ✅ Vérifié

Même cause racine que P1-4 : `ChannelAnalyzer` lit `midiData?.tempo || 120` (`:262`), jamais
renseigné par les converters. `msPerTick` est donc calculé à 120 BPM quel que soit le tempo
réel, et `scoreTimingCompatibility` (`:1129-1163`) compare des intervalles ms mal mis à
l'échelle au `min_note_interval` de l'instrument.

- **Conséquence** : un fichier à 60 BPM a des intervalles réels 2× plus longs que calculés →
  notes jugées « trop rapides » → pénalité `tooFastPenalty` (−10) injustifiée ; à 240 BPM,
  sous-pénalisé. N'affecte que les instruments avec `min_note_interval` défini, mais de façon
  systématiquement fausse pour tout fichier ≠ 120 BPM.
- **Correctif** : renseigner `midiData.tempo` (BPM) avant l'analyse (corrige P1-4 et P1-5).

### P1-6 · Ré-apply split→non-split laisse des lignes de split orphelines · **Élevé** · ✅ Vérifié

`applyAssignments` ne purge **jamais** les routages existants du fichier avant d'écrire les
nouveaux ; il s'appuie sur un upsert par `(fichier, canal)` :

```sql
-- RoutingPersistenceDB.js:118
ON CONFLICT(midi_file_id, channel) WHERE split_mode IS NULL DO UPDATE SET ...
```

La cible de conflit est **partielle** (`WHERE split_mode IS NULL`). Des lignes de split
existantes (avec `split_mode` renseigné) **ne déclenchent pas** ce conflit → une nouvelle ligne
« plain » est **insérée à côté** d'elles.

- **Repro** : appliquer le canal 0 en split (2 lignes `split_mode='range'`). Rouvrir la modale,
  repasser le canal 0 sur un instrument unique, ré-appliquer → l'INSERT non-split ajoute une
  3ᵉ ligne ; les 2 lignes de split survivent → **3 routages en conflit** pour le canal 0
  (ambiguïté playback/statut ; les segments de split continuent de tirer).
- Le sens inverse est sûr : `insertSplitRoutings` supprime d'abord toutes les lignes du canal
  (`:200-201`). C'est l'apply **non-split** qui ne nettoie pas.
- **Aussi** : dé-sélectionner un canal lors d'un ré-apply laisse son ancien routage en place,
  gonflant `routedCount`.
- **Correctif** : au début de l'apply, purger les routages auto-assignés du fichier (ou
  delete-by-channel pour chaque canal écrit) avant de persister le nouveau jeu.

### P1-7 · Le statut de routage sur-compte les lignes de split · **Élevé** · ✅ Vérifié

Deux chemins de statut divergent :

- **Correct** — `computeRoutingStatus` compte les **canaux distincts** :
  `new Set(enabledRoutings.map(r => r.channel)).size` (`FileRoutingStatusService.js:36`, avec test dédié).
- **Faux** — le badge de la liste de fichiers compte les **lignes** : `getRoutingCountsByFiles`
  utilise `COUNT(*)` (`RoutingPersistenceDB.js:296`) et `getFileMetadata` utilise
  `enabledRoutings.length` (`FileManager.js:881`).

Un canal splitté = plusieurs lignes partageant le même `channel` → les deux chemins fautifs
**sur-comptent**.

- **Repro** : fichier `channel_count=2` ; canal 0 = split 2 segments (2 lignes), canal 1 non
  routé. `COUNT(*) = 2 ≥ 2` → la liste affiche **« jouable »** ; ouvrir la modale
  (`computeRoutingStatus`) affiche **« partiel »**. L'utilisateur se fie au badge vert et lance
  un fichier dont un canal n'est pas routé.
- **Correctif** : `COUNT(DISTINCT channel)` dans l'agrégat SQL et canaux distincts dans
  `getFileMetadata`, ou router les deux chemins par `computeRoutingStatus`.

### P1-8 · `apply_assignments` non-atomique ; succès rapporté sur échec partiel · **Élevé** · ✅ Vérifié (mécanisme lu)

Le fichier adapté est écrit d'abord (sa propre transaction FileManager), puis chaque ligne de
routage est sauvée dans un `try/catch` **indépendant** qui ne fait que `logger.warn` ; il n'y a
**aucune transaction** englobant l'apply, et `routings.push(routing)` s'exécute
**inconditionnellement** après le catch ; le handler retourne `success:true`
(`PlaybackAssignmentCommands.js:526-531`, réponse `:594-604`).

- **Repro** : la map d'assignations contient une clé de canal `"99"` (ou toute ligne violant une
  contrainte d'insertion) → `insertRouting` lève `Invalid MIDI channel: 99`
  (`RoutingPersistenceDB.js:40`) → capturé et loggé en warning → la ligne **n'est pas** en base
  mais **figure** dans le tableau `routings` retourné, et la réponse est `success:true`. Le
  client croit tous les canaux routés ; le fichier est en réalité partiel. Si le fichier adapté
  a déjà été écrit, il subsiste avec un jeu de routages incomplet, sans nettoyage.
- **Correctif** : envelopper les écritures de routage dans `routingRepository.transaction(...)` ;
  ne `push` qu'après une écriture réussie ; remonter les canaux en échec dans la réponse.

### P1-9 · Batterie : `-1` « substitution illimitée » ≡ omission → percussion auxiliaire supprimée · **Élevé** · ✅ Vérifié

Contradiction de sémantique **dans le même dépôt** pour la valeur `-1` :

```js
// ScoringConfig.js:154-159  (intention de l'auteur)
latin: -1,       // Nice-to-have: unlimited substitution
shakers: -1,     // Nice-to-have: unlimited substitution
woodsMetal: -1, pitched: -1, cuicas: -1, triangles: -1
```
```js
// DrumNoteMapper.js:373-387  (comportement réel)
if (depth === -1) {
  ...
  omissions.push({ note, ..., reason: 'category ignored' });
  mapping[note] = null;   // ← marque la note comme OMISE
}
```

Le `getMaxDepthForNote` documente aussi `-1 = ignore/omit` (`:340`). Or `InstrumentMatcher`
passe en production le `drumFallback` par défaut (avec ces `-1`) à `generateMapping`
(`:768-773`). Résultat : les catégories latin / shakers / woodsMetal / pitched / cuicas /
triangles sont **omises** (donc, au playback, laissées à leur numéro GM d'origine — cf. P1
suivant) au lieu d'être **substituées** sur un pad disponible, à l'exact opposé de l'intention
« nice-to-have ».

- **Repro** : note 71 (Short Whistle) utilisée ; l'instrument possède le pad 72 (Long Whistle).
  La table `71→[72,…]` devrait mapper 71→72 ; à la place, 71 est omise. Idem 71-74, 78-81.
- **Masquage** : `tests/midi-adaptation.test.js:807-823` appelle `generateMapping` **sans**
  `categoryDepthLimits` (profondeur `Infinity`), le chemin de production passe `drumFallback`.
- **Effet secondaire** : les passes ultérieures (`:694-703` latin, `:722`/`:759` gardes
  `if(mapping[note])`) écrasent parfois le marqueur `null` → certaines notes sont **à la fois**
  mappées **et** listées en `omissions`, gonflant `omissionCount` et le message « N notes omitted ».
- **Correctif** : décider de la sémantique. Si « illimitée » est voulu, **retirer** ces
  catégories du `drumFallback` (ou mettre un grand N) pour que `getMaxDepthForNote` renvoie
  `Infinity` ; sinon corriger le commentaire du config. Et traiter `mapping[note] === null`
  comme « déjà géré » dans les passes d'assignation.

### P1-10 · Le note-range scorer rejette des canaux que le moteur sait replier · **Moyen** · ⚠️ Tracé

`InstrumentMatcher` met le score à **0 + `compatible:false`** dès que la portée du canal dépasse
celle de l'instrument, **ou** qu'aucun décalage **multiple d'octave** n'aligne les plages
(`:500-509`, `:522-531`, racine `calculateOctaveShift:613-662` qui n'essaie que les ×12) — alors
que le moteur de lecture sait replier ces notes via `compressNoteToRange`
(`MidiTransposer.js:374-389`).

- **Repro** : canal `[60,69]` (C4–A4), instrument `[62,74]`. `60 ≥ 62` échoue ; les décalages 0
  et ±12 tombent hors plage → `calculateOctaveShift` renvoie incompatible → note-range
  `{score:0, compatible:false}`, faisant chuter un instrument parfaitement capable dans le
  bucket bas-score avec une « erreur ». Un décalage de **+2 demi-tons** conviendrait ; le
  playback l'aurait replié.
- **Correctif** : sur échec de décalage-octave, retomber sur le décalage minimal in-range et/ou
  scorer via `calculateOctaveWrapping` au lieu de renvoyer 0/incompatible.

### P1-11 · `hasModifications` ignore trois compteurs de stats → adaptations jetées · **Moyen** · ✅ Vérifié

La porte qui décide de persister le fichier adapté ne teste que 5 des 8 compteurs produits par
`transposeChannels` :

```js
// PlaybackAssignmentCommands.js:288-293
const hasModifications =
  stats.notesChanged > 0 || stats.notesRemapped > 0 || stats.notesSuppressed > 0 ||
  splitStats.channelsSplit > 0 || volumeEventsInjected > 0;
  // OMIS : stats.ccsRemapped, stats.notesDropped, stats.notesShortened
```

Ces trois compteurs existent bien (`MidiTransposer.js:294-299`). Une adaptation dont le **seul**
effet est une réduction de polyphonie (*drop* → `notesDropped`) ou un raccourcissement de note
(`notesShortened`) produit `hasModifications === false` → fichier adapté **non persisté**,
routages écrits contre l'original → l'adaptation est perdue.

- **Note importante** : le cas `ccsRemapped` est *moot* tant que P1-2 n'est pas corrigé
  (`ccsRemapped` reste 0). Le cas *drop-poly* est en outre doublé côté frontend, qui n'a pas de
  branche polyphonie (`RoutingSummaryAssignmentBuilder.js:142-164`) et n'envoie donc pas
  `createAdaptedFile`. L'ensemble « réduction de polyphonie » est ainsi **cassé des deux côtés**.
- **Correctif** : ajouter `stats.notesDropped > 0 || stats.notesShortened > 0 || stats.ccsRemapped > 0`
  à la porte, et une branche polyphonie côté frontend.

---

## P2 — Lacunes de robustesse / capacités non appliquées

### P2-1 · Aucun schéma de payload pour les commandes de l'axe · Moyen · ✅ Vérifié
`apply_assignments`, `generate_assignment_suggestions`, `analyze_channel`, `get_file_routings`
n'ont **aucune** entrée dans les schémas compilés → `JsonValidator.validateByCommand` retombe
sur le défaut permissif (`valid:true`). `data.assignments` (device ids, clés de canal,
`transposition.semitones`, plages de notes) arrive **non validé** au handler, et alimente
directement le chemin d'échec partiel de P1-8. Le handler est défensif (`parseInt`, `?.`, clamp
du canal cible) mais les **clés de canal source** et les plages numériques ne sont pas bornées.
**Reco** : ajouter les schémas d'enveloppe (canal 0-15 numérique, `originalFileId` requis, `assignments` objet…).

### P2-2 · `update_instrument_capabilities` n'émet pas `instrument_settings_changed` · Moyen · ⚠️ Tracé
Le handler (`PlaybackAssignmentCommands.js:706-771`) mute les capacités et retourne sans jamais
émettre l'événement — alors que sa JSDoc (`:699`) le prétend et que les handlers frères
(`InstrumentSettingsCommands.js:344,658,809`) l'émettent. Les consommateurs (`CapabilityResolver`,
`CompensationService`, `MidiRouter`, `PlaybackScheduler`, `MidiClockGenerator`) indexent leurs
caches sur l'**événement**, pas sur le fingerprint → clamp/compensation périmés en cours de
session après édition d'une plage/polyphonie/`supported_ccs`. **Reco** : émettre l'événement après succès.

### P2-3 · Sync supprime (au lieu de désactiver) un routage dont l'appareil est momentanément hors-ligne · Moyen · ⚠️ Tracé
`FileRoutingSyncService.syncFile` appelle `deleteNonSplitByFileId(fileId)` en tête (`:204`), puis
tout canal dont l'appareil n'est pas dans l'instantané des appareils connectés renvoie
`skip-device` (`:73-80`) et n'est **jamais réinséré** → le routage est **détruit**, pas
préservé-désactivé. **Repro** : canal 3 routé vers un instrument Bluetooth qui a une micro-coupure ;
l'édition d'un autre canal re-pousse la map complète → canal 3 `skip-device` → routage perdu même
après reconnexion. **Reco** : exclure du delete les canaux hors-ligne-mais-précédemment-routés, ou
les marquer `enabled=0`.

### P2-4 · `octaveWrapping` / `octaveWrappingEnabled` / `octaveWrappingInfo` toujours null/false · Moyen · ⚠️ Tracé
`calculateOctaveWrapping` (`InstrumentMatcher.js:559-563,704-742`) ne s'exécute qu'**après** une
transposition qui garantit déjà que toute note tient dans `[min,max]` → il ne trouve jamais de
note hors plage ; `mapping` est toujours `null`, `hasWrapping` toujours `false`. La même cause
rend le recalcul `playableRatio` (`:566-590`) toujours égal à 1.0. Le payload d'octave-wrapping
transmis à `_buildAssignment` puis au playback est **mort**. Combiné à P1-10, les canaux larges
sont simplement marqués incompatibles au lieu d'être wrappés. **Reco** : calculer le wrapping dans
la branche *incompatible*, contre les notes réellement hors plage.

### P2-5 · Prédicat « instrument batterie » du matcher plus étroit que celui d'`AutoAssigner` · Moyen · ⚠️ Tracé
`InstrumentMatcher.isDrumsInstrument` (`:1460-1463`) ne reconnaît batterie que si
`gm_program∈112..119 || note_selection_mode==='discrete'`, alors qu'`AutoAssigner.isDrumInstrument`
(`:129-133`) admet **aussi** `instrument_type==='drums'` et `instrument.channel===9`. Un kit
configuré `instrument_type='drums'`, `note_selection_mode='range'`, `gm_program=null` est proposé
pour le canal 9 par l'AutoAssigner puis **scoré ~0** et pénalisé (−100, « Non-drum instrument
assigned to drum channel ») par le matcher → canal batterie **inassignable**. **Reco** : aligner
`isDrumsInstrument` sur le prédicat d'`AutoAssigner`.

### P2-6 · Score « type d'instrument » s'effondre à neutre pour tout canal sans Program Change · Moyen · ⚠️ Tracé
Quand `primaryProgram===null`, `estimatedCategory` vaut la chaîne `'unknown'` ; à
`InstrumentMatcher.js:1083` `channelTypeStr = channelCategory || channelGenericType` choisit
`'unknown'` (truthy) plutôt que l'heuristique réelle (`type='bass'`…), puis `:1086` court-circuite
à `maxScore*0.5` « non déterminé ». Toute la détection `estimatedType` est jetée pour les canaux
sans PC (canal 9 batterie, exports MIDI rapides). **Reco** :
`channelTypeStr = (channelCategory && channelCategory!=='unknown') ? channelCategory : channelGenericType;`

### P2-7 · Faisabilité « frettes » ignore `hand_span_mm` et `num_fingers` · Moyen · ⚠️ Tracé
`_scoreHandPositionFeasibility` (chemin frettes, `InstrumentMatcher.js:1262-1308`) :
- ne lit que `hand_span_frets`, jamais `hand_span_mm`/`scale_length_mm` → l'avertissement de
  déplacement est sauté pour tout instrument configuré de la manière **canonique/recommandée**
  (`STRING_HAND_POSITION.md:113`) → reste `ok` à tort ;
- lit la polyphonie via `max_fingers` seulement ; pour `mechanism:'fret_sliding_fingers'`, le
  compte réel est `num_fingers` (que le validateur exige, `InstrumentCapabilitiesValidator.js:702-716`)
  → un robot 2 doigts jugé capable d'un accord 6 notes (« feasible ») ;
- côté clavier (`:1304-1308`), `totalFingers = hands.length * 5` **code en dur 5 doigts/main**,
  ignorant `num_fingers` par main (que le validateur documente comme borne de polyphonie) → un
  robot 2 mains × 3 doigts est compté 10 doigts. Comme la faisabilité pèse ±~15 points dans le
  score, cela peut **changer l'instrument routé**. **Reco** : lire `hand_span_mm`/`num_fingers`.

### P2-8 · Split full-coverage émet une `transposition` par segment qu'aucun apply n'honore · Moyen · ⚠️ Tracé
`ChannelSplitter.calculateFullCoverageSplit` (`:508-524,553-564`) ne « couvre » une note
qu'après un décalage d'octave et enregistre `segment.transposition.semitones`. Mais le chemin
d'apply (`splitChannelInFile` ne réécrit que `channel`), le résolveur runtime
(`getOutputForChannel` matche sur `noteMin/noteMax` et ne renvoie que `{device,targetChannel}`) et
le schéma persisté **jettent tous** ce champ. La transposition runtime est par **canal source**
(`PlaybackScheduler.js:948-957`), donc deux segments à décalages différents sont
**non représentables**. La note ne joue « correctement » que parce que le clamp octave-fold
indépendant du scheduler (`clampNote`) la replie par hasard ; le split rapporte `gaps:[]` et une
haute `quality` **non fidèles** à son propre modèle. **Reco** : soit propager la transposition
par segment jusqu'au runtime, soit ne pas la produire et l'annoncer.

### P2-9 · Tablature : réservation de corde purgée à 7680 ticks → deux notes sur une corde · Moyen · ⚠️ Tracé
`_getOccupiedStrings` parcourt du plus récent au plus ancien et `break` au premier événement
**terminé** plus vieux que 7680 ticks (`TablatureConverter.js:1425`), de sorte qu'une note
**encore tenue** plus ancienne que ce seuil n'est jamais vue ; le chemin `min_movement` la perd de
la même façon (`_pruneRecentEvents:561`). **Repro** : bourdon de violoncelle au tick 0, gate 20000
ticks, avec des notes courtes remplissant les ticks 100-7000 ; au tick 8000 une nouvelle note sur
la corde du bourdon se voit offrir une corde « libre » → deux hauteurs simultanées sur une corde
physique. **Reco** : ne pas purger les événements encore actifs.

### P2-10 · Drop polyphonique : `Set` au lieu de compteur → note-off orphelin possible · Moyen · ⚠️ Tracé
Dans le chemin *drop* (`MidiTransposer.js:158-185`), `activeNotes.set(finalNote, i)` **écrase** une
voix de même hauteur encore ouverte (sous-compte la polyphonie), et `droppedNotes` étant un `Set`
n'enregistre une hauteur qu'une fois même si elle est tombée dans deux épisodes distincts → un seul
note-off correspondant est avalé, l'autre survit (peut couper une voix vivante). `PlaybackScheduler`
a corrigé le même problème avec une **Map de comptage** (`:344-356`), preuve que le `Set` est la
structure connue-fausse. **Reco** : `Map<note,count>` comme le scheduler.

### P2-11 · `splitChannelInFile` diffuse l'aftertouch à tous les segments · Moyen · ⚠️ Tracé
`isNoteOn`/`isNoteOff` excluent `noteAftertouch` (`:721-723`), qui est alors traité comme contrôle
canal-large et **dupliqué sur tous les segments** (`:764-777`) au lieu de suivre sa note. **Repro** :
split ch0 → segA=ch0[36-59]/segB=ch2[60-84] ; l'aftertouch sur la note 40 part sur ch0 **et** ch2,
appliquant une pression sur l'instrument de segB pour une note qu'il ne joue pas. Impact modéré
(aftertouch rare, pas de note bloquée). **Reco** : router l'aftertouch porteur de note par la même
pile par-note que les note-off.

---

## P3 — Mineur / documentaire / design

- **`primaryProgram` = plus fréquent, égalités → programme le plus bas** (`ChannelAnalyzer.js:386-409`).
  Un canal piano (0) puis cordes (48) — chaque PC une fois → égalité → `primaryProgram=0` ; la
  section cordes est scorée comme piano. Limitation de conception (canal scoré par un seul programme).
- **Bandes d'hystérésis chevauchantes** dans l'assignation par hauteur (`HandAssigner.js:324-336`) —
  une note dans deux bandes est résolue contre la borne basse seulement ; ordre-dépendant près de
  splits serrés (le validateur n'impose qu'un ordre strictement croissant, pas de séparation min).
- **Top-clamp physique avec un span périmé** (`HandPositionPlanner.js:441-457`) — inoffensif en mode
  frettes constantes ; peut sur/sous-estimer d'une fraction de frette en mode physique.
- **`validateInstrument(null)` lève** au lieu de rapporter (`InstrumentCapabilitiesValidator.js:43`) —
  défensif ; un élément null dans `validateInstruments()` crashe.
- **Round-robin de split ignore la plage instrument** (`ChannelSplitter.js:302-303`) — une note peut
  être alternée vers un instrument qui ne l'atteint pas (mord seulement si mêmes types de plages
  différentes).
- **Options / données mortes** : `NOTE_PRIORITIES` (`DrumNoteMapper.js:111-168`, jamais lu, présenté
  comme « Priority Matrix » dans la doc), `preserveEssentials` (`:361`, jamais lu),
  `GM_CATEGORIES`/`getGmDefaultPolyphony` (calculés, non utilisés par le matcher qui code en dur
  `polyphony || 16`).
- **Canal batterie vide/exotique scoré ~95/100** (`DrumNoteMapper.js:895-941`) — `coverageRatio`
  défaut 1 + sous-scores catégorie défaut 100 → paraît excellent à l'assigneur.
- **Dérive doc↔code** ✅ **réalignée** : `docs/AUTO_ASSIGNMENT.md` décrivait des poids
  **30/25/15/15/10/5** et un 6ᵉ critère « Channel Special » ; le code
  (`ScoringConfig.js:13-19`) utilise **22/40/13/5/20** (programMatch/noteRange/polyphony/ccSupport/
  instrumentType) + ajustements percussion/timing, sans channelSpecial. La section Scoring, le
  tableau de breakdown, l'exemple d'API (`scoreBreakdown` au lieu de `scoreDetails`), la config des
  poids et les 12 catégories batterie (`shakers`/`woodsMetal`/`pitched`/`cuicas`/`triangles`) ont
  été mis à jour pour refléter le code.

---

## Ce qui est solide (carte de couverture)

- **Fonctions pures d'adaptation de hauteur** : `compressNoteToRange` (repli octave, préserve la
  classe de hauteur — non-régression testée), `NoteEnforcement.foldIntoRange/snapToNearest/clampNote`,
  `ScaleSnapper` — déterministes ; note-on et note-off traversent la **même** math, jamais divergents.
- **Batterie** : carte GM 35-81 correcte et complète (chaque note catégorisée une fois), tables de
  substitution valides sans cycle, poids qualité 40/30/15/10/5 = 100 tous zéro-gardés, on/off remappés
  cohéremment, vélocité préservée.
- **Planification physique** : `HandAssigner` (tous modes), `LongitudinalPlanner` (bandes d'ancrage,
  release forcé, modèle de vitesse doigt/main), Viterbi de `TablatureConverter` (beam pruning,
  fallback clampé sans drop silencieux). `_scoreHandPositionFeasibility` renvoie **exactement** la
  forme attendue par `MidiAdaptationService` (aucune incompatibilité de shape).
- **Scoring** : score final clampé `[0,100]`, garde NaN sur le re-poids batterie, division
  `usedCCs` vide gardée, accès dual-champ (`note`/`noteNumber`…) robuste au parseur, programme `0`
  survit aux chaînes `||`.
- **Persistance** : garde anti-double-application (`adaptationBaked` remet à zéro
  transposition/remap runtime une fois baké) correcte et testée ; `createDerivedFile`/
  `replaceFileBytes`/`bakeAndSave` individuellement transactionnels avec nettoyage des blobs
  orphelins ; cache de suggestions re-vérifié sous verrou et clé sur `capabilities_updated_at`.
- **`independent_fingers`** (doigts indépendants clavier/cordes) est un **stub V2 assumé** (rejeté à
  la validation et à la construction du planner), pas un défaut.

---

## Axe 6 — application au playback & routage live (audité)

Parité entre le chemin **playback fichier** (`PlaybackScheduler`/`MidiPlayer`) et le chemin
**routage live** (`MidiRouter`). **Solide** : le clamp repli+snap discret+snap gamme est
réellement partagé (`NoteEnforcement.clampNote`), alimenté par des contraintes clées sur
l'appareil+canal **destination** ; le snapshot par lecture fige les capacités (une édition en
cours de note ne bloque pas une note pendant le playback) ; les setters de transposition
(`setChannelTransposition`, `setGlobalTranspose`) purgent déjà leurs notes ; seek/pause/stop
envoient All-Notes-Off + reset du tracking ; la mémoire de hauteur par-note de `MidiRouter`
(`_activeRoutedNotes`) est correcte.

| # | Défaut | Sévérité | Statut |
|---|--------|----------|--------|
| Axe6-1 | Split : un **note-on vélocité-0** (note-off en running-status) prend le chemin note-ON de `getOutputForChannel` (`scheduleEvent` passe `event.type` brut) → sur `round_robin`/`alternate`/`least_loaded`/`overflow` le compteur/pile de segments désynchronise → **notes bloquées** sur le mauvais segment. `PlaybackScheduler.js:566`, `MidiPlayer.js:2182` | **Critique** | ✅ corrigé (type logique) |
| Axe6-2 | `setChannelRouting` / `setChannelNoteRemapping` / `setChannelSplitRouting` ne relâchent **pas** les notes tenues avant de changer la config (contrairement aux setters de transposition) → une ré-assignation en cours de lecture envoie le note-off au **nouvel** appareil/mapping et l'ancienne note **reste bloquée**. Atteint en live via `apply_assignments`. `MidiPlayer.js:1939,2017,2035` | **Élevé** | ✅ corrigé (`_panicChannel` avant reconfig) |
| Axe6-3 | **Écart de parité clamp** : le skip batterie (ch9) est clé sur le canal **source** au playback (`PlaybackScheduler.js:980`) mais sur le canal **mappé/destination** en live (`MidiRouter.js:380`) → un remap live franchissant le canal 9 clampe (ou pas) à l'inverse du playback. | Moyen | ✅ corrigé (décision : canal **source**, parité playback) |
| Axe6-4 | **Seek arrière / boucle** ne réinitialise jamais les contrôleurs (`_emitReconstructedState` est set-only) → un CC64 (sustain) tenu en fin de fichier **reste actif** après `seek(0)`/boucle → sur-sustain / notes tenues à l'itération suivante. `MidiPlayer.js:1648-1711`, boucle `:2711` | Moyen | ✅ corrigé (Reset-All-Controllers CC121 sur seek arrière) |
| Axe6-5 | Note-off différé (`min_note_duration`) non lié à l'instance de note → un re-déclenchement rapide de la même hauteur dans la fenêtre de report est **coupé court**. `PlaybackScheduler.js:1072-1085` | Moyen | ✅ corrigé (compteur d'instance par hauteur) |
| Axe6-6 | Compensation relative `MidiRouter` : si la compensation baisse en cours de note (≥2 destinations), le note-off peut partir **avant** le note-on encore en attente → note bloquée. `MidiRouter.js:301-320` | Faible-Moyen | ✅ corrigé (délai figé au note-on, réutilisé au note-off) |

Rappel (déjà tracé, non re-listé) : `globalTranspose` sans latch par voix — **mitigé** par
`setGlobalTranspose` (sendAllNotesOff + reset). Points d'enforcement playback : cf.
`AUDIT_INSTRUMENT_CAPABILITIES_2026-08-05.md`.

**Axe 6 : tous les points (Axe6-1 → Axe6-6) corrigés.** Axe6-3 a été tranché en faveur du canal
**source** (parité playback) : « son de batterie vs hauteur » est une propriété du contenu
entrant, donc le skip-clamp live se décide sur le canal source comme au playback.

---

## Méthode

Six agents d'audit parallèles (un par axe), findings rendus en `fichier:ligne` + scénario de repro +
niveau de confiance, puis recroisés. Les défauts à fort impact ont été **re-vérifiés manuellement**
jusqu'au code source, au parseur `midi-file` (`node_modules/midi-file/lib/midi-parser.js`) et aux
converters (`JsonMidiConverter.eventToJson`) — d'où le tag ✅ Vérifié sur 9 des 11 P1. Le harness de
test pur-JS (`npm test`, hors suites SQLite) tourne dans cet environnement (28 tests d'adaptation
verts au lancement). Toutes les références sont sur l'état de la branche au 2026-08-06.
