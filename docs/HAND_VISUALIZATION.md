# Représentation visuelle de la main — Doigts qui suivent les cordes

Document de référence sur le **rendu graphique** de la main de
fretting et de ses doigts dans l'aperçu temps réel
(`HandsPreviewPanel`) et dans l'éditeur dédié
(`HandPositionEditorModal`).

> Pour la logique serveur (planner, CC, conversion MIDI → tablature),
> voir [`STRING_HAND_POSITION.md`](STRING_HAND_POSITION.md).
> Pour le modèle longitudinal (un doigt par corde, ancrage),
> voir [`LONGITUDINAL_MODEL.md`](LONGITUDINAL_MODEL.md).

---

## 1. Contrat visuel

> **Invariant fondamental :** *un doigt actif (point bleu) est
> TOUJOURS dessiné à l'intérieur de la bande de la main.*
> Une note injouable s'affiche en **rouge**, garée au bord de la
> bande, jamais comme un doigt actif hors-main.

Trois niveaux de feedback visuel pour chaque note d'un accord :

| État | Marqueur | Position | Sens |
|------|----------|----------|------|
| Joué, dans la fenêtre | Disque bleu | sur l'intersection corde × frette | Le doigt presse réellement la corde |
| Joué, corde à vide (fret 0) | Disque bleu | au-dessus du sillet | Aucun doigt requis |
| Injouable (`outside_window` / `too_many_fingers`) | Disque rouge + chevron | parqué juste à gauche/droite de la bande | La main devrait s'étirer ; le simulateur l'a refusé |

---

## 2. Composants impliqués

### 2.1 Aperçu horizontal (page de routage)

`public/js/features/auto-assign/FretboardHandPreview.js`

- Manche horizontal, frette 0 à gauche.
- Bande de main = rectangle ambré chevauchant les cordes.
- Largeur de bande = `hand_span_mm` (mode physique) ou
  `hand_span_frets` (fallback).
- Inputs : `setActivePositions`, `setUnplayablePositions`,
  `setHandTrajectory`, `setLevel`, `setCurrentTime`.

### 2.2 Aperçu vertical (éditeur dédié)

`public/js/features/auto-assign/VerticalFretboardPreview.js`

- Manche vertical, frette 0 en haut, cordes en colonnes.
- Même API que `FretboardHandPreview` (drop-in).
- Calcul `_handWindowY(anchor)` symétrique de `_handWindowX`.

### 2.3 Éditeur dédié

`public/js/features/auto-assign/HandPositionEditorModal.js`

Modal plein écran composée de :

1. Aperçu collant en haut (`VerticalFretboardPreview`).
2. Timeline défilante au centre (`FretboardTimelineRenderer`).
3. Minimap latérale (`HandEditorMinimap`).
4. Toolbar (transport, undo/redo, navigation problèmes, save).

L'opérateur peut :
- Pinner l'ancrage de la main au tick courant (drag de la bande).
- Réassigner une note à une corde différente (popover sur clic note).
- Désactiver une note injouable.

### 2.4 Orchestrateur côté preview

`public/js/features/auto-assign/HandsPreviewPanel.js`

Reçoit les évènements `chord` / `shift` / `tick` du
`HandSimulationEngine` et redistribue aux widgets ci-dessus.

### 2.5 Simulateur côté client

`public/js/features/auto-assign/HandPositionFeasibility.js`

Mirror local du `HandPositionPlanner` côté serveur. Calcule la
trajectoire de l'ancrage et marque les notes injouables, sans
aller-retour réseau.

---

## 3. Géométrie : la bande de main et le retrait de l'index

### 3.1 Pourquoi 10 mm derrière la frette

Un doigt qui presse la frette `n` ne se pose pas SUR la frette
mais **juste derrière** (vers le sillet). Pour que la bande lue
visuellement ait l'air physiquement crédible :

```
INDEX_BACKOFF_MM     = 10  (côté simulateur, HandPositionFeasibility)
FINGER_BEFORE_FRET_MM = 10  (côté rendu, FretboardHandPreview)
```

Les deux constantes doivent rester égales : sinon la bande dérive
d'environ une frette par rapport à la fenêtre logique du simulateur,
et l'opérateur voit des notes « bleues hors bande » alors que le
simulateur les considère jouables.

### 3.2 Calcul de `[x0, x1]` de la bande (mode physique)

Source : `FretboardHandPreview._handWindowX`

```
anchorMm = L · (1 − 2^(−anchor / 12))
leftMm   = max(0, anchorMm − FINGER_BEFORE_FRET_MM)
rightMm  = leftMm + handSpanMm
```

`L` = `scale_length_mm` (longueur de diapason). La formule
`L · (1 − 2^(−n/12))` est la **distance physique** depuis le sillet
de la frette `n` (loi du tempérament égal). Convertie en pixels
via `_xFromMm()`.

### 3.3 Calcul de la portée maximale (`maxReach`)

Source : `HandPositionFeasibility._simulateFrets > maxReach(anchor)`

```
t = 2^(−anchor/12) − handSpanMm / L
maxReach(anchor) = −12 · log2(t)        si t > 0
                  = +Infinity            si t ≤ 0  (la main couvre tout le manche au-delà)
```

Inverse :

```
minAnchorForTop(top) = −12 · log2( 2^(−top/12) + handSpanMm / L )
```

Mode fallback (sans `scale_length_mm` ou sans `hand_span_mm`) :

```
maxReach(a)        = a + handSpanFrets
minAnchorForTop(t) = max(0, t − handSpanFrets)
```

### 3.4 Retrait de l'index (`anchorBehindFret`)

```
anchor = anchorBehindFret(targetFret)
       = solution de : L·(1−2^(−anchor/12)) = L·(1−2^(−targetFret/12)) − 10mm
```

Utilisé pour positionner la main de sorte que l'index puisse
presser `targetFret` du bout du doigt sans déborder sur la frette
suivante.

---

## 4. Logique de décision de la position de main

Pour chaque accord (groupe de notes au même tick), le simulateur
exécute la séquence suivante.

### 4.1 Étape 0 — Pin opérateur

Si l'opérateur a fixé un ancrage à ce tick
(`overrides.hand_anchors`), la main saute directement à cette
valeur. Aucune logique automatique ne peut écraser ce choix.

### 4.2 Étape 1 — Notes pinned (corde, frette)

Si l'opérateur a forcé l'assignation d'une note à une corde
spécifique (`overrides.note_assignments`), cette assignation est
appliquée AVANT le résolveur. Le résolveur les traite ensuite
comme « pré-taggées » et ne touche plus à leur corde.

### 4.3 Étape 2 — Résolution corde/frette (1ère passe)

`_resolveChordStringFret(notes, tuning, numFrets, oldAnchor, spanFrets)`

Pour chaque note non-pinned, le résolveur choisit une `(corde,
frette)` avec une **corde unique par accord** (une corde ne peut
sonner qu'une seule hauteur à la fois).

Ordre de score (le plus haut gagne) :

| Score | Cas |
|-------|-----|
| **1500** | Corde à vide (`fret = 0`) — pas de doigt consommé |
| **1000 − (fret − anchor)** | Frette dans la fenêtre courante `[anchor, anchor+span]` |
| **500** | Corde à vide (variante mono-note `_resolveStringFretWithContext`) |
| **100 − distance(fenêtre)** | Frette hors fenêtre (pénalité proportionnelle) |
| **100 − fret** | Pas de contexte (premier accord, `anchor = null`) |

Bonus / malus :
- **Bias de cluster** : pénalité `8 · spread` sur la frette si elle
  s'écarte des frettes déjà placées dans cet accord. Garde les
  doigts groupés.
- **Tie-break** : frette la plus basse l'emporte.

L'ordre de traitement est **du grave vers l'aigu** : la basse
choisit en premier ; les notes aiguës doivent ensuite trouver
une corde libre.

### 4.4 Étape 3 — Détection du shift de main

Calcul de `lo = min(frets)`, `hi = max(frets)` parmi les notes
fretted (frette > 0) de l'accord.

```
needShift = (anchor == null) || (lo < anchor) || (hi > maxReach(anchor))
```

### 4.5 Étape 4 — Choix du nouvel ancrage

Plage valide :

```
minA = minAnchorForTop(hi)
maxA = max(minA, anchorBehindFret(lo))
```

- `minA` = ancrage le plus bas qui couvre `hi`.
- `maxA` = ancrage idéal : 10 mm derrière `lo` (l'index pose
  pile sur la frette la plus basse).

Si `minA > maxA` (accord plus large que la main), fallback sur
`anchorBehindFret(lo)` : la main reste collée à la basse, les
notes au-delà de la portée seront marquées injouables.

Sinon, `pickAnchorWithLookahead(prev, [minA, maxA], futureRanges)` :

- Examine les `LOOKAHEAD_K = 4` accords suivants.
- Pour chaque candidat dans `{minA, maxA, prev clampé,
  bornes futures clampées}`, calcule le coût cumulé pondéré
  (poids initial 1.0, décay `× 0.7` par accord futur).
- Tie-break sur `maxA` (préfère l'ancrage naturel = juste
  derrière la basse).

L'objectif : trouver un point d'équilibre qui minimise le total
de mouvement sur la fenêtre courante + futur proche.

### 4.6 Étape 5 — Re-résolution après shift (correction 2026-04)

Quand l'ancrage a effectivement changé, on **re-résout** les
notes auto-taggées avec le NOUVEL ancrage. La 1ère passe avait
utilisé l'ancrage AVANT shift comme contexte, ce qui pouvait
laisser une note sur une corde dont la frette tombe hors de la
nouvelle fenêtre — alors qu'une autre corde l'aurait placée
dedans.

```js
// Conserve les pinned, redonne sa chance au résolveur sur le reste.
const stripped = notes.map((n, i) => operatorPinned[i]
    ? n
    : { ...n, string: undefined, fret: undefined });
resolutions = _resolveChordStringFret(stripped, tuning, numFrets, anchor, spanFrets);
```

Sans cette 2ᵉ passe, on observait des doigts dessinés hors de la
bande même quand le simulateur avait correctement déplacé la main.

### 4.7 Étape 6 — Détection des injouables

```js
const top = maxReach(anchor);
for (const n of fretted) {
    if (n.fret < anchor || n.fret > top) {
        unplayable.push({
            note: n.note, fret: n.fret, string: n.string,
            reason: 'outside_window',
            direction: n.fret < anchor ? 'left' : 'right',
            handId
        });
    }
}
if (maxFingers != null && fretted.length > maxFingers) {
    // tous les fretted partent en too_many_fingers
}
```

`direction` indique au renderer où parquer le marqueur rouge
(à gauche ou à droite de la bande).

### 4.8 Étape 7 — Émission de l'évènement

```js
out.push({
    type: 'chord',
    tick: g.tick,
    releaseTick: g.releaseTick,
    releaseByHand: { fretting: ... },
    notes: taggedNotes,    // tableau complet, y compris injouables
    unplayable: [...]      // sous-ensemble flaggé
});
```

Et un évènement `shift` séparé si la main a bougé :

```js
{ type: 'shift', tick, handId, fromAnchor, toAnchor, source, motion }
```

`source` ∈ `{'override', 'auto'}`. `motion` contient `requiredSec`,
`availableSec`, `feasible` — utilisé par la trajectoire animée
pour signaler les déplacements trop rapides (courbe jaune).

---

## 5. Logique du rendu — du chord event au pixel

### 5.1 Chemin standard (`HandsPreviewPanel`)

```
engine.on('chord', { notes, unplayable })
    │
    ├─ keyboard.setActiveNotes(...)        (clavier semitones)
    │
    ├─ fretboard.setActivePositions(
    │       notes
    │           filter (fret, string finis)
    │           filter !unplayableKeys.has(string:fret)   ← FIX 2026-04
    │           map { string, fret, velocity }
    │   )
    │
    ├─ fretboard.setUnplayablePositions(
    │       unplayable filter (fret, string finis)
    │   )
    │
    └─ fretboard.setLevel(
           unplayable contient outside_window ou too_many_fingers
               ? 'infeasible'
               : 'ok'
       )
```

Le filtre par `unplayableKeys` est **la garantie du contrat
visuel** : aucune note flaggée injouable ne peut être dessinée
comme doigt actif. Sans lui, le simulateur produit la note dans
les deux listes (`taggedNotes` ET `unplayable`) et le rendu
peignait un point bleu hors bande + un disque rouge au bord —
exactement le bug « doigt hors de la main ».

### 5.2 Chemin éditeur (`HandPositionEditorModal._chordHandler`)

Identique. Même filtre `unplayableKeys` côté `sticky.setActivePositions`.

En plus, la modal alimente `setSustainingFingers` (notes encore
en cours au tick courant) pour que les doigts restent ancrés
sur la corde tant que la note n'est pas relâchée — c'est ce qui
fait « glisser » la bande autour du doigt fixe en mode
longitudinal.

### 5.3 Bande animée

La bande NE saute PAS aux ancrages discrets. Elle suit la
**trajectoire** :

```
trajectory = [{tick, anchor, motion?}, …]
fretboard.setHandTrajectory(trajectory)
fretboard.setCurrentTime(currentSec)
```

Chaque tick, le widget interpole l'ancrage entre les deux points
de la trajectoire encadrant le playhead, et redessine la bande à
sa position interpolée. Cela donne le glissé fluide quand la main
change de zone.

---

## 6. Édition des positions — chemin de données

```
HandPositionEditorModal
    overrides = {
        hand_anchors:     [{handId, tick, anchor}],
        disabled_notes:   [{tick, note, reason}],
        note_assignments: [{tick, note, string, fret}],
        version: 1
    }
    │
    ├─ drag bande   → _onStickyBandDrag(handId, anchor)
    │                  → push hand_anchors
    │                  → engine.rebuild()
    │
    ├─ clic note    → _openNoteEditPopover()
    │                  → _pinNoteAssignment({tick, note, string, fret})
    │                  → push note_assignments
    │                  → engine.rebuild()
    │
    ├─ disable note → push disabled_notes
    │
    ├─ undo/redo    → restaure overrides depuis _history
    │
    └─ save         → POST /api/.../overrides → persistance
```

Le `_pushHistory()` clone profondément `overrides` à chaque
opération, capé à 50 entrées. `_savedIndex` suit la dernière
sauvegarde réussie pour distinguer « dirty » de « clean ».

---

## 7. Modes de jeu spécifiques

### 7.1 Mode `string_sliding_fingers` (longitudinal ancré)

Un doigt par corde, glissant librement dans la bande. Décision
des positions :

- **Ancrage** : un doigt qui presse une note tenue (durée ≥ 60 ms)
  reste à sa frette même si la main se déplace.
- **Vitesse effective** : `min(hand_move_mm_per_sec,
  finger_move_mm_per_sec)` quand un doigt est ancré.
- Voir [`LONGITUDINAL_MODEL.md`](LONGITUDINAL_MODEL.md) pour le
  détail (hystérésis, lookahead, anti-jitter).

### 7.2 Mode `fret_sliding_fingers`

Un doigt par décalage de frette dans la bande. Cap = `num_fingers`
(et non `max_fingers`). Sinon, géométrie identique au mode
classique.

---

## 8. Cas limites et garanties

| Cas | Comportement |
|-----|--------------|
| Aucune note fretted (que des cordes à vide) | Pas de shift ; main reste à l'ancrage précédent |
| Première note de la pièce | `anchor = anchorBehindFret(lo)`, pas de coût de shift |
| Accord plus large que la main | Fallback `anchor = anchorBehindFret(lo)` ; notes excédentaires marquées `outside_window` (ROUGE, jamais bleues) |
| Polyphonie > `max_fingers` | Toutes les fretted marquées `too_many_fingers` ; bande passe au rouge |
| Tablature pinned manuellement | Le pin précède toute auto-résolution ; jamais réassigné |
| Override de l'ancrage | La logique automatique est court-circuitée pour ce tick |
| Note hors `num_frets` | Filtrée par le résolveur, jamais émise |
| Capo configuré | (en cours) — actuellement le résolveur ne soustrait pas le capo. Test `respects the capo offset when resolving` en échec connu, antérieur à ce document. |

---

## 9. Glossaire

| Terme | Définition |
|-------|------------|
| **Anchor (ancrage)** | Frette de référence où l'index repose ; définit la position de la main |
| **Window (fenêtre)** | Intervalle de frettes accessibles : `[anchor, maxReach(anchor)]` |
| **Span** | Largeur de la fenêtre : `hand_span_mm` (physique) ou `hand_span_frets` (fallback) |
| **Reach** | Borne supérieure de la fenêtre depuis un ancrage donné |
| **Fretted note** | Note pressée (`fret > 0`), consomme un doigt |
| **Open string** | Corde à vide (`fret = 0`), aucun doigt requis |
| **Shift** | Déplacement de l'ancrage entre deux accords |
| **Trajectory** | Liste des `(tick, anchor)` décrivant la position de la main dans le temps |
| **Operator pin** | Override manuel d'un ancrage ou d'une (corde, frette) — sacré, non écrasé par le résolveur |
| **Unplayable** | Note flaggée `outside_window` ou `too_many_fingers` ; affichée en rouge, jamais en bleu |
| **Backoff (10 mm)** | Retrait physique de l'index derrière la frette cible — partagé par la simulation et le rendu |

---

## 10. Historique des décisions

- **2026-04** — Fix « doigts hors de la main » : filtre
  `unplayableKeys` ajouté dans `HandsPreviewPanel` et
  `HandPositionEditorModal` ; 2ᵉ passe du résolveur après shift
  dans `HandPositionFeasibility._simulateFrets`.
- **2026-04** — `capo_fret` désactivé côté planner ; transposition
  recommandée à la place. Le test `respects the capo offset` reste
  en échec en attendant suppression ou refactor.
- **2026-04** — Modèle multi-mains généralisé pour les claviers
  (ids `h1..h4`). Côté frets, un seul `id: "fretting"`.
- **2025** — Migration `008` : ajout `scale_length_mm` ; mode
  physique devient préférentiel quand la donnée est présente.
- **2025** — Backoff 10 mm de l'index introduit pour aligner la
  bande visuelle avec la position physique réelle de la main.
