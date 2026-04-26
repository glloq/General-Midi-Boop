# TODO — améliorations non prioritaires

Collection des trous identifiés pendant les audits / sessions de dev,
qui ne bloquent personne mais qui méritent un passage. À piocher quand
on a un créneau.

Convention : chaque entrée a un titre court, un constat (ce qui marche
mal aujourd'hui), et 1-3 options de fix avec leurs trade-offs. Pas de
plan d'implémentation détaillé — la décision et le plan se font au
moment où on attaque l'item.

---

## CC main absents de l'éditeur CC après routage

**Constat.** Les events `controller` pour les CC main
(`CC22` cordes, `CC23/CC24` claviers) sont calculés par
`HandPositionPlanner.js:404` mais ne sont injectés que par
`MidiPlayer._injectHandPositionCCEvents` (`src/midi/playback/MidiPlayer.js:440-608`)
**en mémoire au moment de la lecture** (flag `_handInjected`, effacés
après). `PlaybackAssignmentCommands.applyAssignments`
(`src/api/commands/PlaybackAssignmentCommands.js:120-342`) injecte CC7
(volume) mais **pas les CC main** dans `adaptedMidiData` avant le
`jsonToMidi` (ligne ~262). L'éditeur (`MidiEditorCC.js:151-250`) lit
toutes les CC du fichier, mais le fichier n'en contient aucune côté
mains → rien à afficher.

**Options.**

| # | Approche | Avantages | Inconvénients |
|---|---|---|---|
| A | Cuire les CC main dans `adaptedMidiData` à l'apply | Fichier autonome, éditeur les voit, modifiables | Retouches manuelles écrasées au prochain re-apply |
| B | Overlay calculé dans l'éditeur depuis la config de routage | Non destructif, toujours synchro avec le routing | Lecture seule (pas d'édition directe de la courbe) |
| C | Hybride : A à la première apply + marker `auto-generated` ; ne regénère pas si déjà présent | Visibles ET éditables | Plus complexe, demande la sémantique du marker |

**Recommandation actuelle** : A. L'éditeur devient point unique de
vérité ; un re-apply explicite régénère les CC.

**Points d'insertion**

- `src/api/commands/PlaybackAssignmentCommands.js` ~ligne 254 (juste
  après l'injection CC7) : appeler `HandPositionPlanner` par canal
  routé et pousser les events dans `adaptedMidiData.tracks[0].events`
  avant la conversion `jsonToMidi`.
- Refléter la logique existante de `MidiPlayer.js:440-491` mais cibler
  la structure du fichier au lieu de la timeline live.
- Une fois injectés, faire en sorte que `MidiPlayer` détecte les CC
  déjà présents et n'injecte pas en double pendant la lecture
  (sinon double envoi au robot).

---

## Mécanisme `independent_fingers` (V2 — doigts humanoïdes)

**Constat.** L'onglet "Main" expose 3 mécanismes pour les instruments à
cordes : `string_sliding_fingers` (V1), `fret_sliding_fingers` (V1) et
`independent_fingers` (V2, grisé). Le V2 vise un système à 4 doigts
indépendants à 2 axes (corde × frette), capable de reproduire des
techniques humaines (barrés, accords arbitraires, hammer-on/pull-off).
Aujourd'hui : la carte est affichée non cliquable dans
`ISMSections._renderMechanismCards`, le validateur rejette
`mechanism === 'independent_fingers'`, et `HandPositionPlanner`
throw `not implemented in V2` si on tente de l'instancier.

**Options.**

| # | Approche | Avantages | Inconvénients |
|---|---|---|---|
| A | Planner monolithique : un seul `IndependentFingersPlanner` qui assigne globalement chaque note à un doigt par optimisation (coût de déplacement + contraintes barrés) | Optimal, gère les barrés en sortie | Coûteux à implémenter, runtime O(n²) sur les passages denses |
| B | Planner glouton : assignation greedy doigt-par-doigt avec heuristique "doigt le plus proche libre" + fallback shift | Simple, rapide, suffit pour 80 % des cas | Loupe les optimisations globales (barrés sub-optimaux) |
| C | Hybride : greedy par défaut + passe d'optimisation locale sur les chords détectés en barrage | Bon compromis | Encore deux passes de logique distinctes à maintenir |

**Recommandation actuelle** : B (greedy) en première itération pour
débloquer le mécanisme côté UI ; itération vers C si les cas-limites
se multiplient en pratique.

**Points d'insertion**

- `src/midi/adaptation/HandPositionPlanner.js` : ajouter un dispatch
  sur `hands_config.mechanism` ; pour `independent_fingers`, déléguer
  à un nouveau module `IndependentFingersPlanner.js` (à créer).
- Modèle de données : étendre `hands_config.hands[0]` avec un tableau
  `fingers: [{ id, max_fret_offset, max_string_offset, ... }]` (à
  spécifier au moment de l'attaque).
- UI : `ISMSections._renderHandsSectionFrets` débloque la carte +
  rend les paramètres des 4 doigts (probable sous-modal ou accordéon).
- CC : un CC par doigt (8 CC : 4 corde + 4 frette) ou un CC composite
  encodé. À trancher au moment de l'attaque selon ce que le firmware
  embarqué accepte.

---

## Points relevés par les audits passés

Issus de l'ancienne section "Known Issues & Improvement Areas" de
`CONTRIBUTING.md`. Items courts, sans analyse approfondie — à traiter à
l'occasion ou à promouvoir en entrée détaillée ci-dessus quand
quelqu'un attaque le sujet.

### Sécurité

- **`MidiMessage.parseObject()` sans whitelist de propriétés**
  (`src/midi/messages/`). Risque d'injection de propriétés arbitraires
  via un payload JSON malveillant.

### MIDI core

- **Somme des poids `ScoringConfig`** : la détection de type d'instrument
  somme à 130 au lieu de 100. Soit normaliser, soit assumer et
  documenter.
- **Wrapping d'octave doublonnant** : plusieurs notes source peuvent
  wrapper sur la même note cible, créant des collisions silencieuses.
  Voir `src/midi/adaptation/MidiTransposer.js`.

### Architecture

- **God Object `Application`** : ~10 services utilisent encore `this.app`
  au lieu d'une DI explicite via `deps`. Migrer vers le pattern
  `ServiceContainer` déjà utilisé ailleurs. Voir AUDIT.md §3.1.
- **Façade `Database`** : ~960 lignes de wrappers passthrough.
  Enregistrer les sous-modules directement dans `ServiceContainer` plutôt
  que de les ré-exporter. Voir AUDIT.md §3.2.
- **Fichiers volumineux** : 11 fichiers backend et 3 frontend dépassent
  700 lignes. Candidats à la découpe par responsabilité. Voir
  AUDIT.md §3.8.

### Éditeurs / UI

- **Drum editor** : le sélecteur Quantize n'est pas branché à
  `DrumGridRenderer`. Le réglage est lu mais ignoré.
- **Wind editor** : le mode d'édition est figé sur `'pan'`, ce qui
  empêche le drag des notes.
- **Tablature editor** : raccourcis `Delete` / `Backspace` et `Ctrl+A`
  manquants. Le Piano Roll a la liste complète et sert de référence.
- **Cohérence raccourcis clavier** : Piano Roll a tout, les autres
  éditeurs n'ont pas `Ctrl+Shift+Z` (redo). Mutualiser le registre de
  raccourcis.

### CSS / accessibilité

- **362 `!important`** : factoriser via la cascade et les variables
  plutôt que de surcharger.
- **Variables CSS dispersées** : `:root` redéfini dans 4+ fichiers, ordre
  d'application imprévisible. Centraliser dans un seul fichier de
  tokens.
- **23 `outline: none`** sans alternative de focus visible — violation
  WCAG. Toujours fournir un focus alternatif (border, box-shadow…).

### Performance

- **`MidiRouter`** : itère toutes les routes pour chaque message MIDI.
  Ajouter une indexation par source pour ramener le coût à O(1) par
  message.
- **`getAllFiles()`** : charge la colonne BLOB entière même quand seules
  les métadonnées sont demandées. Ajouter une variante `getAllMetadata()`
  ou colonnes sélectionnées.
- **`FilterManager`** : les timers de debounce ne sont pas annulés au
  démontage du composant — fuite mémoire possible sur navigation
  intensive.

### Infrastructure

- **`DelayCalibrator`** : la regex de parsing ALSA utilise le mot-clé
  français `carte` qui échoue sur un système anglais. Multilinguer
  ou parser la sortie machine plutôt que humaine.
- **Double tracking de migrations** : table `migrations` ET
  `schema_version` cohabitent. Unifier sur une seule source de vérité.
- **Dépendances datées** : Express 4.x (5.x dispo), `better-sqlite3` 9.x
  (12.x dispo). Vérifier les breaking changes avant l'upgrade. Voir
  AUDIT.md §3.13.

---
