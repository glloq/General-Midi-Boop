# Gestion de la position de main — Instruments à cordes

Ce document décrit le pipeline complet qui transforme un flux MIDI
en commandes destinées à un instrument à cordes mécanisé (guitare,
basse, ukulélé, violon…), depuis le choix corde/frette jusqu'à
l'émission des CC qui déplacent physiquement la main de fretting.

> Couvre uniquement la famille « cordes ». Pour les claviers (mode
> `semitones`), voir le commentaire d'en-tête de
> [`HandPositionPlanner.js`](../src/midi/adaptation/HandPositionPlanner.js).

---

## 1. Vue d'ensemble du pipeline

```
MIDI file
   │
   ▼
[ TablatureConverter ]  ─►  tab events (tick, string, fret, midiNote)
   │   choisit (corde, frette) pour chaque note MIDI
   │   un seul son par corde et par tick, span limité
   │
   ▼
[ persistance ]  ─►  table `string_instrument_tablatures.tablature_data`
   │
   ▼
[ MidiPlayer._injectHandPositionCCEvents ]
   │   recharge la tab pour le canal joué
   │   filtre les cordes à vide (fret = 0) → ne forcent pas de shift
   │
   ▼
[ HandAssigner (single hand) ]  ─►  toutes les notes → hand 'fretting'
   │
   ▼
[ HandPositionPlanner (mode 'frets') ]
   │   maintient une fenêtre [low, low+span] sur le manche
   │   émet CC22 (configurable) à chaque shift, le plus tôt possible
   │   produit des warnings non-bloquants (chord_span_exceeded,
   │   move_too_fast, out_of_range, too_many_fingers)
   │
   ▼
flux MIDI augmenté : note-on/off + CC20 (corde) + CC21 (frette) + CC22 (position main)
```

Modules concernés :

| Module | Rôle |
| --- | --- |
| [`TablatureConverter`](../src/midi/adaptation/TablatureConverter.js) | MIDI → (corde, frette), 5 algorithmes |
| [`HandAssigner`](../src/midi/adaptation/HandAssigner.js) | tag `hand: 'fretting'` (mode `single_hand` côté cordes) |
| [`HandPositionPlanner`](../src/midi/adaptation/HandPositionPlanner.js) | shifts de main + warnings, en frets ou en mm |
| [`InstrumentCapabilitiesValidator`](../src/midi/adaptation/InstrumentCapabilitiesValidator.js) | valide `hands_config` à la sauvegarde |
| [`MidiPlayer`](../src/midi/playback/MidiPlayer.js) | `_planFretsForDestination()` orchestre l'injection des CC |

---

## 2. Modèle de données

### 2.1 Table `string_instruments`

Définie dans [`migrations/001_baseline.sql`](../migrations/001_baseline.sql)
+ [`007_string_instruments_scale_length.sql`](../migrations/007_string_instruments_scale_length.sql).

| Colonne | Type | Sens |
| --- | --- | --- |
| `tuning` | JSON `[int]` | Notes MIDI à vide, corde 1 = grave |
| `num_strings` | int 1..12 | Nombre de cordes (= longueur de `tuning`) |
| `num_frets` | int 0..36 | 0 = fretless |
| `is_fretless` | bool | Active la résolution flottante des frettes |
| `capo_fret` | int 0..36 | **Désactivé (2026-04)** — la colonne survit pour la compatibilité ascendante mais n'est plus appliquée par le convertisseur ni les vues. Pour décaler la tonalité, transposer le canal source à la place. |
| `frets_per_string` | JSON `[int]?` | Cap individuel par corde, sinon `num_frets` partout |
| `scale_length_mm` | int 100..2000 | Longueur de diapason, pour le modèle physique |
| `tab_algorithm` | text | `min_movement` \| `lowest_fret` \| `highest_fret` \| `zone` \| `hand_aware` |
| `cc_string_*`, `cc_fret_*` | int | Mapping CC20/21 vers la corde / la frette à jouer |

### 2.2 `hands_config` (mode `frets`)

Stocké en JSON dans `instruments_latency.hands_config`. Schéma cible
côté cordes — validé par `_validateFretsHandsConfig()`.

```json
{
  "enabled": true,
  "mode": "frets",
  "hands": [{
    "id": "fretting",
    "cc_position_number": 22,
    "hand_span_frets": 4,
    "hand_span_mm": 80,
    "max_fingers": 4
  }],
  "hand_move_frets_per_sec": 12,
  "hand_move_mm_per_sec": 250
}
```

Règles :

- Une seule entrée `hands` (`id: "fretting"`) en mode `frets`.
- Un des deux couples (span/vitesse) est requis :
  - **physique** : `hand_span_mm` + `hand_move_mm_per_sec` + `scale_length_mm` sur l'instrument.
  - **fallback** : `hand_span_frets` + `hand_move_frets_per_sec` (span constant en nombre de frettes).
- Champs croisés (`hand_span_semitones`, `hand_move_semitones_per_sec`) → erreur de validation.
- `max_fingers` est optionnel, plafonné à 12 par cohérence avec `num_strings`.

---

## 3. Conversion MIDI → tablature

Entrée :

```js
notes = [{ t: tick, n: midiNote, v: velocity, g: gateInTicks, c: channel }, …]
```

Sortie :

```js
tabEvents = [{
  tick, string,        // 1-based, 1 = corde la plus grave
  fret,                // 0 = corde à vide ; flottant possible si fretless
  midiNote, velocity, duration, channel,
  unplayable?: true    // note hors de portée, clampée pour rendu seul
}, …]
```

### 3.1 Garanties

- **Aucune note avalée silencieusement.** Les notes hors plage sont
  clampées (corde la plus proche, fret limite) et marquées
  `unplayable: true`. Les notes refusées pour conflit de cordes sont
  comptées dans `lastConversionStats.dropped` — l'UI peut les afficher.
- **Une seule note par corde et par tick.** Une déduplication
  préalable fusionne les pitches identiques sur le même
  `(tick, note, channel)` — utile contre les MIDI multi-pistes qui
  doublent les voix.
- **Plage par corde respectée.** `fret < 0` ou `fret > frets_per_string[i]`
  exclu de l'énumération ; `_getClampedPosition` choisit la corde la
  plus proche pour les inclassables.
- **Cap de doigts.** `max_fingers` (transmis via `instrumentConfig.max_fingers`)
  élague les voicings qui demandent trop de cordes frettées
  simultanément. Les cordes à vide ne consomment pas de doigt.
- **Span d'accord borné.** `MAX_FRET_SPAN = 5` en mode classique ;
  en mode `hand_aware` la borne devient `1.5 × hand_span_mm` au lieu
  d'un nombre fixe de frettes — un span de 5 frettes est physiquement
  beaucoup plus large près du sillet qu'à la 12ème case.

### 3.2 Algorithmes

| Clé | Approche | Quand l'utiliser |
| --- | --- | --- |
| `min_movement` *(défaut)* | Viterbi avec beam (32) — minimise mouvement + span ; bonus pour cordes à vide en première position | Cas général |
| `hand_aware` | Même Viterbi, coûts en mm (géométrie tempérée) ; demande `scale_length_mm` + `hand_span_mm` ; dégrade en `min_movement` si manquant | Instrument robotique avec un gabarit de main défini |
| `lowest_fret` | Greedy : pour chaque note, position la plus basse | Forcer un voicing « cordes graves » |
| `highest_fret` | Greedy : position la plus haute | Forcer un voicing « cordes aiguës » |
| `zone` | Pré-calcule un centre de zone par corde (5 frettes), puis greedy pondéré | Maintenir une position quasi-statique sur tout le morceau |

### 3.3 Préférence des cordes à vide *(audit 2026-04)*

Une corde à vide est :

- gratuite (pas de doigt) ;
- sonore et stable (pas de buzz dû à un appui mal calibré) ;
- bénéfique pour réduire les déplacements de main.

Le coût d'émission a été corrigé pour que tout choix « corde à vide »
batte n'importe quelle alternative frettée du même pitch, tant que la
main n'est pas montée haut sur le manche :

- En première position (`minFret ≤ 4`) : bonus `−0.2` par corde à vide.
- En position haute (`minFret > 4`) : pénalité `+1.5` (atteindre la
  case 0 nécessite un déplacement, ou alors une note d'un autre
  voicing). Cette règle s'applique aussi à `hand_aware`, exprimée
  en mm.

Même logique appliquée aux algorithmes `zone` (ouverte ≤ 0 quand la
zone est près du sillet, sinon coût modéré) et `min_movement` —
résultat : sur une mélodie qui aboutit à un E4, le convertisseur
choisit désormais la corde aiguë à vide plutôt que fret 5 de la corde
de B.

### 3.4 Optimisation du choix de corde

Le moteur Viterbi traite la séquence comme un HMM :

1. **Émission** — coût intrinsèque de l'assignation
   - Span d'accord (quadratique au-delà de `COMFORTABLE_SPAN = 3`).
   - Position haute (logarithme à partir de la case 7).
   - Cordes à vide (cf. § 3.3) : bonus en bas du manche, pénalité en haut.
2. **Transition** — coût du déplacement entre positions de main
   successives.
   - Stretch (≤ 2 frettes) presque gratuit ;
   - Shift (3..5) coût proportionnel ;
   - Saut grand format (> 5) progressif.
   - Bonus retour vers le sillet quand la main était basse.
3. **Beam pruning** — `BEAM_WIDTH = 32` états conservés par tick ;
   `MAX_CHORD_STATES = 200` voicings énumérés par accord.

L'algorithme `zone` ajoute un pré-traitement : il choisit, par corde,
le centre de fenêtre qui couvre le plus de notes du morceau, puis
biaise toutes les sélections vers ce centre — utile pour rester dans
une seule position pour des morceaux entiers.

---

## 4. Vérification de l'intervalle de main

Une fois la tablature calculée, le `HandPositionPlanner` simule la
main physique :

1. Lit la tab du canal courant
   ([`MidiPlayer._planFretsForDestination`](../src/midi/playback/MidiPlayer.js)).
2. **Filtre les cordes à vide** (`fret <= 0`) — elles ne demandent
   aucun positionnement, et les inclure forcerait des shifts inutiles
   vers la case 0.
3. Groupe les notes simultanées par main (chord groups, tolérance 2 ms).
4. Pour chaque groupe :
   - **Out-of-range** : compare chaque fret à `[noteRangeMin, noteRangeMax]`
     calculés à partir de `frets_per_string` / `num_frets`.
   - **Chord span** : compare l'écart `(chordHigh − chordLow)` à
     `hand_span_frets` (ou `hand_span_mm` en mode physique).
   - **`max_fingers`** : compte les frets > 0 du groupe.
5. **Décision de shift** : la fenêtre courante est
   `[windowLow, windowLow + spanAt(windowLow)]`. Si la note tombe
   dehors (au-dessus ou au-dessous), on doit déplacer la main.
6. **Ancrage** :
   - shift vers le haut → `newLow = minAnchorForTopMm(chordHigh, span)`
     (modèle physique) ou `newLow = chordHigh − span` (fallback).
   - shift vers le bas → `newLow = chordLow`.
   - L'ancrage est ensuite clampé à `[max(noteRangeMin, plancher
     physique), noteRangeMax]`.

#### Plancher d'ancrage physique (2026-04)

En mode physique (mm), le doigt index ne peut pas se placer plus de
**10 mm derrière la frette 1**. Au lieu d'ancrer la main au sillet
(fret 0) — ce qui mettrait l'index "dans le vide" sur le bois nu — le
planificateur calcule un plancher en frettes équivalent à
`fret1Mm − 10 mm`, ce qui donne ≈ 0,72 frette pour un diapason de
650 mm. Conséquences :

- la frette 1 reste atteignable (le doigt est juste avant elle) ;
- la frette terminale de la main est décalée d'autant vers l'aigu, ce
  qui rapproche les positions hautes sans changer la largeur physique
  de la main ;
- en mode `frets` constant (sans `scale_length_mm`), aucun plancher
  n'est appliqué — l'ancrage peut toujours descendre à 0.

Implémenté dans `HandPositionPlanner._maybeBuildPhysical()`
(`minAnchorFret = -12 · log2(1 − floorMm / L)`).
7. **Émission CC** :
   - 1er CC d'une main : `time − ε` avant la 1ère note.
   - shifts suivants : `lastNoteOnTime + ε` (dès que la note précédente
     est attaquée → temps de trajet maximal).
   - valeur du CC = `newLow` (frette absolue, raw 0..127).

### 4.1 Modèle physique vs constant

Le span n'est pas le même selon la position : géométrie tempérée
oblige, plus on monte sur le manche plus les frettes sont serrées.

```
distance(a, b) = scale_length_mm × (2^(−a/12) − 2^(−b/12))
```

Exemples (scale 650 mm, hand_span_mm = 80) :

| Position | Reach en frettes |
| --- | --- |
| Sillet (0) | ≈ 2.2 |
| Case 5 | ≈ 3.0 |
| Case 12 | ≈ 4.4 |
| Case 17 | ≈ 5.5 |

Le planificateur utilise ce modèle dès que `scale_length_mm` ET
`hand_span_mm` sont définis. Sinon il revient à une fenêtre constante
de `hand_span_frets`. Le `TablatureConverter` partage exactement la
même formule (`_fretDistanceMm`) pour rester cohérent.

### 4.2 Codes de warning (non-bloquants)

Tous diffusés via WebSocket (`playback_hand_position_warnings`)
+ event-bus pour affichage UI. Le pipeline ne refuse jamais une note
— il continue, en signalant.

| Code | Sens | Métadonnées |
| --- | --- | --- |
| `out_of_range` | Note hors plage de l'instrument | `note`, `axisLabel`, `instrumentMin/Max` |
| `chord_span_exceeded` | Accord plus large que la main | mode physique : `spanMm`, `handMm`, `approxFrets`, `atFret` |
| `move_too_fast` | Le shift demande plus de temps que disponible | `travelMm`, `requiredMs`, `availableMs` |
| `finger_interval_violated` | Deux notes consécutives séparées par moins de `min_note_interval` | `deltaMs`, `minIntervalMs` |
| `too_many_fingers` | Accord avec plus de frets > 0 que `max_fingers` | `count`, `limit` |

### 4.3 Représentation graphique de la main *(2026-04)*

La bande qui matérialise la main sur le manche dans le panneau
« Hands preview » ([`FretboardHandPreview`](../public/js/features/auto-assign/FretboardHandPreview.js))
reflète **strictement** la largeur configurée dans `hands_config` :

- mode physique : largeur de la bande = `hands[0].hand_span_mm`,
  positionnée selon la géométrie tempérée (la bande rétrécit visuellement
  à mesure qu'on monte sur le manche, alors que sa largeur en mm reste
  constante) ;
- mode constant : largeur = `hands[0].hand_span_frets` (par défaut 4).

Aucune entrée externe ne peut écraser cette largeur — le contrat est
documenté dans l'en-tête de `FretboardHandPreview.js`. Pour modifier
la largeur affichée, ajuster `hand_span_mm` (ou `hand_span_frets`)
dans les réglages de l'instrument et relancer la prévisualisation.

Le même contrat s'applique à la
[`FretboardLookaheadStrip`](../public/js/features/auto-assign/FretboardLookaheadStrip.js)
qui affiche la trajectoire prévue sur 4 secondes.

---

## 5. Catalogue des instruments supportés

Préréglages listés dans
[`StringInstrumentDatabase.js`](../src/persistence/tables/StringInstrumentDatabase.js).

### Guitares (6 cordes / 7 cordes)

| Preset | Tuning (MIDI) | Notes |
| --- | --- | --- |
| `guitar_standard` | E2 A2 D3 G3 B3 E4 (40 45 50 55 59 64) | Standard EADGBE |
| `guitar_drop_d` | D2 A2 D3 G3 B3 E4 | Drop D |
| `guitar_open_g` | D2 G2 D3 G3 B3 D4 | Open G |
| `guitar_dadgad` | D2 A2 D3 G3 A3 D4 | DADGAD |
| `guitar_half_down` / `guitar_full_down` | tunings -1 / -2 demi-tons | |
| `guitar_7_standard` | B1 E2 A2 D3 G3 B3 E4 | 7-cordes |

Scale-length : 628 (Gibson) → 686 mm (baritone).

### Basses (4 / 5 / 6 cordes)

| Preset | Tuning | Scale |
| --- | --- | --- |
| `bass_4_standard` | E1 A1 D2 G2 | 864 mm long-scale, 762 mm short-scale |
| `bass_4_drop_d` | C#1 A1 D2 G2 | |
| `bass_5_standard` | B0 E1 A1 D2 G2 | 889 mm 5-string scale |
| `bass_6_standard` | B0 E1 A1 D2 G2 C3 | |

### Ukulélés

| Preset | Tuning | Scale |
| --- | --- | --- |
| `ukulele_standard` | G4 C4 E4 A4 (high-G) | soprano 350, concert 380, ténor 430 mm |
| `ukulele_low_g` | G3 C4 E4 A4 | |
| `ukulele_baritone` | D3 G3 B3 E4 | 510 mm |

### Cordes frottées (fretless)

`is_fretless = 1`, `num_frets = 0`. Le convertisseur autorise des
positions flottantes jusqu'à 48 demi-tons (`isFretless` branch dans
`_getPossiblePositions`).

| Preset | Tuning | Scale |
| --- | --- | --- |
| `violin` | G3 D4 A4 E5 | 328 mm |
| `viola` | C3 G3 D4 A4 | 380 mm |
| `cello` | C2 G2 D3 A3 | 690 mm |
| `contrabass` | E1 A1 D2 G2 | 1050 mm |

### Autres

`banjo_standard` (G4 D3 G3 B3 D4, 5 cordes), `mandolin` (G3 D4 A4 E5,
4 cordes accordées comme un violon).

---

## 6. CC sortants

| CC | Sens | Plage | Source |
| --- | --- | --- | --- |
| **CC20** | corde à jouer | `[cc_string_min, cc_string_max]` (défaut 1..12) | `TablatureConverter.convertTablatureToMidi` |
| **CC21** | frette à jouer | `[cc_fret_min, cc_fret_max]` (défaut 0..36) | idem |
| **CC22** | position de main fretting | 0..127 (frette absolue) | `HandPositionPlanner` |

Les CC20/21 précèdent chaque note-on de `−ε` ; le CC22 est posé
*après* la dernière note-on de la fenêtre précédente, pour laisser à
la main mécanique le temps de trajet maximum. Tous les CC peuvent
être désactivés par instrument (`cc_enabled`, `hands_config.enabled`).

---

## 7. Procédure d'audit

1. **Vérifier la conversion**
   - `npm test -- --testPathPattern='tablature-converter'` (doit
     produire 27 cas, dont les nouveaux scénarios « open-string
     preference » et « hand_aware physical span »).
2. **Vérifier les warnings de planification**
   - `npm test -- --testPathPattern='hand-position-planner'`.
3. **Vérifier la validation des configs**
   - `npm test -- --testPathPattern='instrument-capabilities-validator-hands'`.
4. **Vérifier le bout-à-bout playback**
   - `npm test -- --testPathPattern='playback-assignment|playback-scheduler|midi-player-hand-injection'`.
5. **Validation manuelle (UI)**
   - Configurer un instrument à cordes (preset `guitar_standard`,
     scale 650 mm).
   - Activer `hands_config` mode `frets`, `hand_span_mm = 80`,
     `hand_move_mm_per_sec = 250`.
   - Charger un MIDI mélodique. Vérifier dans le panneau de warnings
     qu'aucun `out_of_range`, `chord_span_exceeded` ou
     `move_too_fast` n'apparaît pour les passages confortables et
     qu'ils apparaissent pour les passages volontairement difficiles.

---

## 8. Limites connues

- **Pas d'édition des CC main dans le MIDI editor** : les CC22
  injectés ne sont pas écrits dans `adaptedMidiData`, ils sont uniquement
  ajoutés en RAM par `MidiPlayer._injectHandPositionCCEvents`. Pour les
  voir/éditer côté UI, il faudra les pousser via
  `PlaybackAssignmentCommands` (suivi : `TODO.md`).
- **Beam pruning Viterbi** : `BEAM_WIDTH = 32` est suffisant en
  pratique mais ne garantit pas l'optimalité globale sur des accords
  à très haute polyphonie.
- **Fretless borné à 48 demi-tons** : les positions au-delà sont
  ignorées (cas exotique).
- **`max_fingers` plafonné à 12** : conséquence de la borne
  `num_strings BETWEEN 1 AND 12` du schéma SQL. À dépasser nécessite
  une migration.
