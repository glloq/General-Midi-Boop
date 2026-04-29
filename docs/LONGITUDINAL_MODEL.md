# Mode longitudinal — Modèle à doigts ancrés

Document de référence pour le mode de déplacement **longitudinal pur**
(le long d'une corde uniquement, sans changement de corde) appliqué aux
instruments à cordes mécanisés. Sert de spécification pour
`LongitudinalPlanner` et son intégration dans le pipeline d'adaptation
MIDI.

> Ce document complète [`STRING_HAND_POSITION.md`](STRING_HAND_POSITION.md),
> qui décrit le pipeline V1 (fenêtre glissante sans modèle de doigts).

---

## 1. Périmètre

Mode applicable aux instruments dont chaque doigt est physiquement
attaché à **une seule corde**, et se déplace exclusivement le long de
cette corde (axe longitudinal du manche). Cas d'usage type :
mécanisme `string_sliding_fingers` du schéma `hands_config`.

Hors-sujet ici :

- changement de corde par un doigt (`fret_sliding_fingers`)
- glissement latéral
- doigts indépendants V2 (`independent_fingers`)

---

## 2. Constat sur l'existant (V1)

| Aspect | État | Limite |
| --- | --- | --- |
| Position main P(t) | Recalculée par groupe d'accords, sauts discrets ([`HandPositionPlanner.js:370`](../src/midi/adaptation/HandPositionPlanner.js)) | Discontinue, aucun lissage |
| Modèle des doigts | **Inexistant** ; seuls `max_fingers`/`num_fingers` servent au comptage | Aucun offset par doigt |
| Ancrage | **Aucun.** Une note longue chevauchant un shift saute | Pas de continuité d'appui |
| Vitesse main | Warning non bloquant | Téléportation côté modèle |
| Optimisation | Greedy par groupe | Pas de lookahead |
| Anti-jitter | Aucun | Oscillations possibles en bord de fenêtre |

Conclusion : la fenêtre `[low, low+span]` est trop grossière. Sans
objet « doigt », l'ancrage est mécaniquement impossible.

---

## 3. Modèle cible

### 3.1 Invariants

- Une corde fixe `s_i` par doigt `i` ; jamais de changement de corde.
- Mouvement de main `P(t)` continu (pas de saut).
- Mouvement de doigt sur la main `offset_i(t)` continu par morceaux.

### 3.2 Variables d'état

| Symbole | Sens | Domaine |
| --- | --- | --- |
| `P(t)` | position de la main (mm depuis le sillet) | `[P_min, P_max]` |
| `offset_i(t)` | position relative du doigt `i` dans la main (mm) | `[off_min_i, off_max_i]` |
| `pos_i(t)` | position absolue du doigt sur la corde | `P(t) + offset_i(t)` |
| `state_i(t)` | état du doigt | `{free, active, anchored}` |

### 3.3 Règle d'ancrage (centrale)

À l'instant `t_on(n)` d'une note `n` jouée par le doigt `i` :

- si `duration(n) ≥ τ_anchor` (typique 60 ms) → `state_i ← anchored`
- tant qu'ancré : `pos_i(t) = pos_note` (constante)

Implication directe sur la main :

```
offset_i(t) = pos_note − P(t)
⟹ P(t) ∈ [pos_note − off_max_i, pos_note − off_min_i] = I_i
```

Plusieurs doigts ancrés ⇒ `P(t) ∈ ⋂_i I_i`.

Libération : naturelle à `t_off(n)`, ou anticipée de `Δ_release`
(typique 20 ms) **uniquement** si nécessaire pour résoudre un conflit.

---

## 4. Configuration

Le modèle est **toujours actif** dès qu'un instrument à cordes est en
mécanisme `string_sliding_fingers` avec une `scale_length_mm` connue.
Aucun toggle, aucune table de doigts à remplir : la planificateur
auto-dérive les doigts depuis `max_fingers` + `hand_span_mm`.

Schéma cible :

```json
{
  "mode": "frets",
  "mechanism": "string_sliding_fingers",
  "hand_move_mm_per_sec": 250,
  "finger_move_mm_per_sec": 800,
  "hands": [{
    "id": "fretting",
    "cc_position_number": 22,
    "hand_span_mm": 80,
    "max_fingers": 4
  }]
}
```

Règles :

- `max_fingers` détermine le nombre de doigts auto-dérivés (1..N).
  Chaque doigt est attaché à la corde de même indice (`string_i = i`)
  et peut se déplacer dans la bande `offset ∈ [0, hand_span_mm]`.
- `finger_move_mm_per_sec` ∈ [50, 5000] : vitesse maximale d'un doigt
  par rapport à la main. Quand au moins un doigt est ancré, la vitesse
  effective de la main devient `min(hand_move_mm_per_sec, finger_move_mm_per_sec)`.
- Constantes internes (non exposées) : `MIN_ANCHOR_MS = 60`,
  `HYSTERESIS_MM = 3`, `LOOKAHEAD = 2`.

> **Historique** : la première itération (V1.5) exposait une table
> `fingers[]`, un bloc `anchor.*` et un champ `cc_sample_rate_hz` derrière
> un toggle UI opt-in. Ces champs ont été retirés du schéma exposé (le
> validator les ignore désormais en lecture, et la migration 011 les
> purge des rows persistés). Voir l'annexe « Champs supprimés » plus bas.

---

## 5. Algorithme

### 5.1 Découpage

1. **Pré-traitement** : lire la tablature persistée, en extraire les
   instants clés (note-on et note-off significatifs).
2. **Solveur de trajectoire** (DP fenêtré) : choisit `P_k` à chaque
   instant clé.
3. **Lissage** : interpole `P(t)` en rampe trapézoïdale entre les
   `P_k`, échantillonne en CC22 dense (≈ 50 Hz).

### 5.2 État du solveur

```
state_k = {
  P_mm: number,
  anchors: Map<fingerId, { note, t_on, t_off }>,
  cost: number,
  prev: state_{k-1}
}
```

Transitions à `t_{k+1}` :

1. Libérer les ancres dont la note s'est terminée (`t_off ≤ t_{k+1}`).
2. Si `t_{k+1}` correspond à une note-on sur corde `s` :
   - identifier `f = finger_of(s)` (un seul candidat en mode
     longitudinal pur) ;
   - intervalle requis pour la nouvelle note :
     `I_new = [pos − f.off_max, pos − f.off_min]` ;
   - intersecter avec l'intersection courante des ancres ;
   - en cas d'intersection vide : tenter de libérer une ancre (cf. §6) ;
   - si `duration(n) ≥ τ_anchor` après acceptation, ajouter l'ancre.
3. Borne de vitesse main : `P_{k+1} ∈ [P_k − V·Δt, P_k + V·Δt]`.
4. Choix de `P_{k+1}` dans l'intersection finale en minimisant le coût
   (cf. §7), avec lookahead sur `lookahead_events` notes futures.

Beam search de largeur `W` (8–16 suffit puisqu'à chaque étape le seul
vrai degré de liberté est la position dans un intervalle).
Complexité `O(N · W)`.

### 5.3 Lissage

Entre deux instants clés, rampe trapézoïdale :

```
P(t) = P_k + (P_{k+1} − P_k) · ramp((t − t_k) / Δt)
```

`ramp` respecte `V_main` (saturation si nécessaire ⇒ warning
`speed_saturation`). Émission CC dense à `f_cc` (50–100 Hz). En option,
émission de CC dédiés par doigt si l'instrument expose des
`cc_finger_offset_*`.

---

## 6. Gestion des conflits

L'intersection des `I_i` peut être vide. Stratégie ordonnée :

1. **Anticipation** : libérer le doigt ancré dont la note résiduelle
   est la plus courte, à `t_off − Δ_release`. Pénalité `δ`.
2. **Compromis temporel** : démarrer le déplacement tout en saturant
   `offset_i` à sa borne, jusqu'au seuil `λ`.
3. **Sacrifice** : si rien ne suffit, dropper la note future ou
   l'ancre selon priorité (durée résiduelle, vélocité, présence dans
   un accord). Warning `anchor_conflict`.

Détection :

```python
if intersect(I_anchored) ∩ feasible(P_next) == ∅:
    candidates = anchored sorted by (remaining_duration ASC, vélocité ASC)
    for c in candidates:
        if intersect(without(anchors, c), I_new) non vide:
            release(c); break
    else:
        warn('anchor_conflict')
```

---

## 7. Fonction de coût

```
J = Σ_k [
      α · |P_{k+1} − P_k|                       // déplacement main
    + β · Σ_i (offset_i − rest_offset_i)²        // déformation hors repos
    + γ · 1{rupture ancrage non forcée}          // perte d'ancrage évitable
    + δ · 1{libération anticipée d'une note}     // release prématuré
    + ε · |P_k − P_{k−1}| · short_dt_penalty     // micro-shifts (jitter)
    + ζ · 1{vitesse_doigt > V_finger}            // pénalité (∞ si infaisable)
]
```

Ordres de grandeur : `γ ≫ δ ≫ α ≈ β ≫ ε`. La perte d'ancrage évitable
est la pénalité dominante, conformément au cahier des charges.

---

## 8. Anti-jitter

Trois mécanismes complémentaires :

1. **Hystérésis** : pas de shift tant que `|P_target − P_current| < h`
   (`hysteresis_mm`, typique 3 mm).
2. **Bias vers la position courante** dans la fonction de coût
   (`+ η · (P_k − P_{k−1})²`).
3. **Lookahead** d'au moins `lookahead_events` (typique 2). On ne
   décide jamais un shift sans regarder la note suivante.

---

## 9. Format des sorties

```js
// Sortie du planner
{
  ccEvents: [
    { time, type: 'controller', channel, controller: 22, value, hand: 'fretting' }
  ],
  fingerEvents: [                                       // optionnel V2
    { time, fingerId, offset_mm }
  ],
  warnings: [
    { code: 'anchor_conflict' | 'release_forced'
            | 'speed_saturation' | 'out_of_range'
            | 'unreachable_after_release', time, … }
  ],
  stats: { shifts, anchors_kept, anchors_released_forced, … }
}
```

---

## 10. Stratégie de calcul

- **Pré-calcul (recommandé)** : la tablature étant déjà persistée
  (`string_instrument_tablatures`), le solveur tourne offline et la
  trajectoire `P(t)` échantillonnée est sérialisée avec les CC.
- **Temps réel** : DP en flot avec horizon glissant `H`. Complexité
  `O(N·W)` ⇒ ≪ 100 µs / événement sur CPU moderne.

---

## 11. Cas tests représentatifs

| # | Scénario | Comportement attendu |
| --- | --- | --- |
| T1 | Note longue (1 s) corde 1, puis note courte corde 4 | doigt 1 reste ancré, main glisse, offset_1 absorbe ; doigt 4 attaque sans bouger la main si possible |
| T2 | Gamme ascendante rapide, une seule corde | shifts anticipés, lookahead, zéro jitter |
| T3 | Note tenue grave + mélodie aiguë | ancre permanente sur la grave |
| T4 | Note tenue impossible à conserver | release forcé à `t_off − Δ_release`, warning `release_forced` |
| T5 | Accord tenu (cordes 1 + 4) | deux ancres, P contraint à l'intersection |
| T6 | Conflit dur entre deux ancres | propagation amont du choix d'ancrage |
| T7 | Oscillation entre frettes 7 et 8 | hystérésis ⇒ main stable |
| T8 | Glissade très rapide | warning `speed_saturation`, rampe saturée |

---

## 12. Améliorations vs V1

| Critère | Avant | Après |
| --- | --- | --- |
| Note tenue pendant un déplacement | « saute » | maintenue par offset |
| Continuité de P(t) | sauts | rampe trapézoïdale échantillonnée |
| Stabilité | jitter possible | hystérésis + bias |
| Vitesses mécaniques | warning | contrainte du solveur |
| Lookahead | 0 | `lookahead_events` configurable |
| Modèle des doigts | absent | offsets dynamiques, 1 doigt = 1 corde |
| Conflits | non détectés | priorisation explicite |

---

## 13. Annexe — Champs supprimés (V1.5 historique)

La première itération du planner ancré exposait à l'utilisateur trois
blocs de configuration qui ont été retirés au profit du modèle simplifié
décrit dans ce document. Ces champs sont **silencieusement ignorés en
lecture** par le validator et le planner, et la migration 011
(`011_strip_legacy_longitudinal_fields.sql`) les retire des rows
persistés.

| Champ | Remplacement |
| --- | --- |
| `hands[0].fingers[]` (table par doigt) | Auto-dérivés : 1 doigt par corde, `offset ∈ [0, hand_span_mm]` |
| `anchor.min_duration_ms`, `anchor.early_release_ms`, `anchor.hysteresis_mm`, `anchor.lookahead_events` | Constantes internes : 60 / réservé / 3 / 2 |
| `cc_sample_rate_hz` (densification CC) | Supprimé ; le hardware interpole entre les CC sparses |
| `fingers[].v_finger_mm_per_sec` (vitesse par doigt) | Remplacé par `hands_config.finger_move_mm_per_sec` global |
