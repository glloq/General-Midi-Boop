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
