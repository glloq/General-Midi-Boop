# Gestion des mains humanoïdes — Objectifs et limites du système

Document de définition des besoins pour l'extension du moteur de gestion de
main vers un modèle **humanoïde à doigts** pour les instruments à cordes et
les instruments à clavier.

> Document de niveau **spécification** : pas de code, pas d'implémentation.
> L'objectif est de délimiter le périmètre, définir les contraintes et
> poser les bases du modèle avant toute décision d'architecture.

---

## 1. Contexte et motivations

Le système actuel gère la position de la main sur le manche (instruments à
cordes) ou sur le clavier (piano/orgue) comme un objet **monolithique** —
une position d'ancrage et un span de portée. Ce modèle suffit pour un bras
robotique à main plate, mais devient insuffisant dès qu'on vise un mécanisme
**humanoïde**, c'est-à-dire un effecteur mécanique doté de doigts
indépendants.

Les lacunes identifiées (cf. `TODO.md` § *Mécanisme independent_fingers*) :

| Aspect | Modèle actuel | Besoin humanoïde |
|--------|--------------|-----------------|
| Doigts | Comptage seul (`max_fingers`) | Identité de chaque doigt (index, majeur, annulaire, auriculaire) |
| Assignation doigt → note | Inexistante | Nécessaire pour piloter le bon actionneur |
| Contrôle CC doigt | Aucun | 1 CC au minimum pour communiquer le doigt utilisé |
| Mains piano | Position de zone (`h1..h4`) | Doigts gauche + droite complets (5 doigts chacun) |

---

## 2. Périmètre de ce document

Ce document couvre **deux familles** d'instruments :

1. **Instruments à cordes** (guitare, basse, ukulélé, violon…)
   — main de fretting uniquement ; la main de plucking/picking n'est pas
   concernée par ce jalon.

2. **Instruments à clavier** (piano acoustique, piano électrique, orgue,
   clavecin…) — mains gauche et droite complètes.

Hors périmètre :
- La main de picking/plucking des cordes (attaque des cordes).
- Les instruments à vent, à percussion.
- La technique de barré (accord barré complet) : cas limite à traiter en
  annexe V2.
- Les instruments fretless (modèle de position flottante inchangé).

---

## 3. Modèle de doigts humanoïdes

### 3.1 Instruments à cordes — main de fretting

La main humanoïde de fretting dispose de **4 doigts** utilisables pour
presser les frettes :

| Id | Nom | Description |
|----|-----|-------------|
| `1` | Index | Doigt le plus bas sur le manche (vers le sillet) |
| `2` | Majeur | |
| `3` | Annulaire | |
| `4` | Auriculaire | Doigt le plus haut (vers le corps de l'instrument) |

Le pouce n'est pas modélisé dans ce périmètre (technique thumb-over
considérée hors-sujet ici).

**Contraintes physiques :**

- Chaque doigt occupe **une seule case** (une corde + une frette) à la
  fois dans le mode standard.
- Deux doigts ne peuvent pas être sur la même case simultanément.
- La distance entre le doigt `1` (index) et le doigt `4` (auriculaire)
  est bornée par `hand_span_mm` (ou `hand_span_frets` en mode fallback).
- L'index (`1`) est toujours positionné au niveau de la frette la plus
  basse de l'accord ; l'auriculaire (`4`) atteint les frettes les plus
  hautes. L'ordre naturel est respecté : `fret(d1) ≤ fret(d2) ≤ fret(d3) ≤ fret(d4)`.

**Nombre de doigts actifs simultanés :**

- Minimum observable : 1 doigt (mélodie).
- Maximum standard : **4 doigts** (accord complexe, toutes cordes frettées).
- `max_fingers` dans `hands_config` continue de plafonner ce nombre.

### 3.2 Instruments à clavier — mains gauche et droite

Chaque main dispose de **5 doigts** :

| Id gauche | Id droite | Nom | Rôle typique |
|-----------|-----------|-----|--------------|
| `L1` | `R1` | Pouce | Notes extrêmes (bas pour main G, haut pour main D) |
| `L2` | `R2` | Index | |
| `L3` | `R3` | Majeur | |
| `L4` | `R4` | Annulaire | |
| `L5` | `R5` | Auriculaire | Notes extrêmes opposées |

**Contraintes physiques clavier :**

- Un doigt ne peut presser qu'**une touche à la fois**.
- Un accord dans une même main nécessite autant de doigts que de notes
  simultanées, dans la limite de 5.
- L'espace entre le pouce et l'auriculaire est borné par `hand_span_mm`
  (octave de concert ≈ 160 mm sur un piano standard à touches 23 mm).
- Les doigts d'une même main ne peuvent pas se croiser (contrainte
  anatomique : l'ordre des doigts sur le clavier suit l'ordre des touches).

---

## 4. Mapping CC — Contrôle par MIDI CC

### 4.1 Principe général

Les CC (Control Change MIDI) sont le vecteur de communication vers le
firmware embarqué. Chaque CC transporte une valeur de 0 à 127. Pour le
modèle humanoïde, le besoin minimal est :

> **Un CC de sélection de doigt** par événement note-on, en complément
> des CC existants de sélection corde/frette.

L'architecture CC suit le même principe que CC20 (string) et CC21 (fret) :
le CC est émis **juste avant** le note-on correspondant.

### 4.2 Instruments à cordes — minimum 3 CC

Pour chaque note jouée, **3 CC sont requis au minimum** :

| CC | Rôle | Plage | Statut |
|----|------|-------|--------|
| CC20 | Sélection de la corde (string select) | 1–12 | ✅ Implémenté |
| CC21 | Sélection de la frette (fret select) | 0–36 | ✅ Implémenté |
| CC_FINGER | Sélection du doigt à utiliser | 1–4 | 🔲 À définir |

Le **CC22** (hand position / ancrage de la fenêtre) reste pertinent et
constitue un **4ème CC optionnel** pour les systèmes qui ont besoin de
connaître la position globale de la main en plus du doigt actif.

```
Minimum viable (3 CC) :
  CC20 → quelle corde
  CC21 → quelle frette
  CC_FINGER → quel doigt (1..4)

Complet avec position (4 CC) :
  CC20 → corde
  CC21 → frette
  CC_FINGER → doigt
  CC22 → ancrage main (position globale)
```

### 4.3 Instruments à clavier — jusqu'à 6 CC pour 4 mains

Le système clavier supporte jusqu'à **4 objets mains** (`h1..h4`) comme le
modèle multi-mains existant. Chaque main a besoin au minimum de :

- **1 CC de position** : zone du clavier où la main est centrée (index de
  touche, 0–127 = note MIDI C−1 à G9).
- **1 CC de doigt** : identifiant du doigt actif (1–5).

Configuration minimale **2 mains** (cas courant, main gauche + main droite) :

| CC | Rôle | Plage |
|----|------|-------|
| CC_H1_POS | Position main gauche (centre de main) | 0–127 (note MIDI) |
| CC_H1_FINGER | Doigt actif main gauche | 1–5 (L1..L5) |
| CC_H2_POS | Position main droite | 0–127 |
| CC_H2_FINGER | Doigt actif main droite | 1–5 (R1..R5) |

→ **4 CC** pour 2 mains.

Configuration étendue **4 mains** (systèmes multi-robots ou couvrant des
registres supplémentaires) :

| CC | Rôle |
|----|------|
| CC_H1_POS | Position main h1 |
| CC_H2_POS | Position main h2 |
| CC_H3_POS | Position main h3 |
| CC_H4_POS | Position main h4 |
| CC_H_LEFT_FINGER | Doigt actif mains gauches (h1 + h2 partagé) |
| CC_H_RIGHT_FINGER | Doigt actif mains droites (h3 + h4 partagé) |

→ **6 CC** pour 4 mains (partagé par paire L/R).

> **Note** : l'encodage exact des numéros CC sera défini lors de la phase
> d'implémentation, en tenant compte de la table d'allocation CC existante
> dans `docs/MIDI_CC_INSTRUMENT_CONTROLS.md`. La plage CC22–31 (cordes) et
> CC107–119 (claviers/réserve) sont candidates.

---

## 5. Objectifs par famille d'instrument

### 5.1 Instruments à cordes

| Objectif | Description | Priorité |
|----------|-------------|----------|
| O-C1 | Assigner un identifiant de doigt (1–4) à chaque note frettée dans la tablature | Haute |
| O-C2 | Émettre un CC de sélection de doigt avant chaque note-on frettée | Haute |
| O-C3 | Respecter les contraintes anatomiques (ordre des doigts, span) lors de l'assignation | Haute |
| O-C4 | Détecter et signaler les accords injouables pour cause de conflit de doigts | Haute |
| O-C5 | Visualiser les doigts sur le manche (couleur/label par doigt dans `FretboardHandPreview`) | Moyenne |
| O-C6 | Permettre à l'opérateur de forcer l'assignation doigt–note dans l'éditeur | Moyenne |
| O-C7 | Gérer le barré partiel (même doigt sur plusieurs cordes adjacentes) | Basse (V2) |

### 5.2 Instruments à clavier

| Objectif | Description | Priorité |
|----------|-------------|----------|
| O-K1 | Assigner un identifiant de doigt (L1–L5, R1–R5) à chaque note du fichier MIDI | Haute |
| O-K2 | Émettre les CC de position de main et de doigt avant chaque note-on | Haute |
| O-K3 | Respecter les contraintes anatomiques clavier (ordre des touches, span de main) | Haute |
| O-K4 | Gérer la séparation main gauche / main droite par registre (split point configurable) | Haute |
| O-K5 | Supporter les accords main gauche ou main droite jusqu'à 5 notes simultanées | Haute |
| O-K6 | Détecter et signaler les accords injouables (span dépassé, doigts insuffisants) | Haute |
| O-K7 | Visualiser les doigts sur un clavier virtuel (par couleur par main/doigt) | Moyenne |
| O-K8 | Supporter la configuration 4 mains (h1–h4) avec 6 CC | Basse |

---

## 6. Limites et contraintes

### 6.1 Contraintes physiques

**Cordes :**

- La portée maximale entre l'index et l'auriculaire est définie par
  `hand_span_mm` dans `hands_config`. Au-delà, l'accord est injouable.
- En mode physique (mm), la portée augmente vers les frettes hautes
  (frettes plus serrées) — même calcul que l'existant.
- Deux notes sur la même frette (corde différente) peuvent partager un
  doigt uniquement dans le cas du barré (hors périmètre V1).

**Clavier :**

- Le span d'une main est typiquement limité à une octave (≈ 160 mm sur
  piano standard). Configurable via `hand_span_mm` par main.
- Les notes assignées à une même main doivent tenir dans son span.
- En cas de dépassement, le système devra soit réassigner à l'autre main,
  soit signaler la note injouable.

### 6.2 Contraintes de timing

- Les CC de sélection doigt suivent la même règle temporelle que CC20/CC21 :
  émis **juste avant** (`t_note_on − ε`) le note-on correspondant.
- Un changement de doigt sur la même corde (même note, doigt différent)
  entre deux notes nécessite un délai mécanique (`finger_switch_ms` — à
  définir selon le hardware, valeur indicative 30–80 ms).
- Le système doit vérifier que ce délai est disponible entre deux notes
  consécutives sur la même corde avec un doigt différent.

### 6.3 Limites du modèle V1

Pour la première itération du mécanisme `independent_fingers`, les limites
suivantes sont acceptées :

| Limite | Description | Évolution prévue |
|--------|-------------|-----------------|
| L1 | Pas de barré complet (même doigt sur 6 cordes) | V2 |
| L2 | Pas de gestion du legato doigt-à-doigt (hammer-on/pull-off sans archet) | V2 |
| L3 | Assignation doigt greedy (non globalement optimale) | V2 si nécessaire |
| L4 | Un seul doigt actif par note (pas de pression simultanée avec plusieurs doigts sur une même corde) | Hors périmètre |
| L5 | Pas d'optimisation du croisement de doigts au clavier (thumb-under) | V2 |
| L6 | Le CC doigt encode uniquement l'identifiant — pas la force de pression | Extension matérielle |

### 6.4 Compatibilité ascendante

- Les instruments **sans** configuration humanoïde (`mechanism ≠ independent_fingers`)
  continuent de fonctionner exactement comme aujourd'hui — aucun CC
  supplémentaire émis.
- La colonne `hands_config` dans `instruments_latency` évolue par ajout
  de champs optionnels ; les configs existantes restent valides.
- Le validateur (`InstrumentCapabilitiesValidator`) devra rejeter proprement
  les configs incohérentes (ex : `independent_fingers` sans `max_fingers`).

---

## 7. Configuration cible (schéma)

Les schémas ci-dessous sont **indicatifs** — ils serviront de base au
travail d'implémentation.

### 7.1 Cordes — mode `independent_fingers`

```json
{
  "enabled": true,
  "mode": "frets",
  "mechanism": "independent_fingers",
  "hand_move_mm_per_sec": 250,
  "finger_switch_ms": 50,
  "hands": [{
    "id": "fretting",
    "hand_span_mm": 80,
    "max_fingers": 4,
    "cc_position_number": 22,
    "cc_finger_number": 23
  }]
}
```

Nouveaux champs :
- `cc_finger_number` : numéro du CC MIDI à émettre pour le doigt actif (valeur 1–4).
- `finger_switch_ms` : délai minimum (ms) entre deux notes sur la même corde
  si le doigt change.

### 7.2 Clavier — 2 mains humanoïdes

```json
{
  "enabled": true,
  "mode": "semitones",
  "mechanism": "independent_fingers",
  "hands": [
    {
      "id": "left",
      "register": "low",
      "hand_span_mm": 160,
      "max_fingers": 5,
      "cc_position_number": 107,
      "cc_finger_number": 108
    },
    {
      "id": "right",
      "register": "high",
      "hand_span_mm": 160,
      "max_fingers": 5,
      "cc_position_number": 109,
      "cc_finger_number": 110
    }
  ],
  "split_note": 60
}
```

Nouveaux champs :
- `register` : `"low"` | `"high"` | `"full"` — zone du clavier assignée
  à cette main.
- `split_note` : note MIDI de séparation L/R (défaut 60 = C4).
- `cc_finger_number` : CC transmettant l'identifiant du doigt actif (1–5).
- `cc_position_number` : CC transmettant la position centrale de la main
  (note MIDI de la touche du pouce/centre).

### 7.3 Clavier — 4 mains (configuration étendue)

```json
{
  "enabled": true,
  "mode": "semitones",
  "mechanism": "independent_fingers",
  "hands": [
    { "id": "h1", "register": "low",  "cc_position_number": 107 },
    { "id": "h2", "register": "mid_low",  "cc_position_number": 108 },
    { "id": "h3", "register": "mid_high", "cc_position_number": 109 },
    { "id": "h4", "register": "high", "cc_position_number": 110 }
  ],
  "cc_left_finger_number": 111,
  "cc_right_finger_number": 112
}
```

6 CC utilisés (107–112) : 4 CC de position + 2 CC de doigt partagés par
paire gauche/droite.

---

## 8. Interactions avec les modules existants

| Module | Impact |
|--------|--------|
| `HandPositionPlanner.js` | Dispatch sur `mechanism === 'independent_fingers'` → nouveau `IndependentFingersPlanner` |
| `TablatureConverter.js` | Enrichir chaque tab event d'un champ `finger_id` (null si non humanoïde) |
| `MidiPlayer._injectHandPositionCCEvents` | Émettre le CC doigt avant chaque note-on (en plus du CC corde/frette) |
| `InstrumentCapabilitiesValidator.js` | Valider les nouveaux champs ; rejeter `independent_fingers` si `cc_finger_number` absent |
| `FretboardHandPreview.js` | Afficher une couleur distincte par doigt (4 couleurs pour cordes, 10 pour clavier) |
| `HandsPreviewPanel.js` | Redistribuer l'information `finger_id` aux widgets d'aperçu |
| `HandPositionEditorModal.js` | Permettre la réassignation doigt–note (popover étendu) |
| `MIDI_CC_INSTRUMENT_CONTROLS.md` | Réserver les numéros CC définitifs dans la table d'allocation |

---

## 9. Questions ouvertes

Les points suivants nécessitent une décision avant l'implémentation :

| # | Question | Options | Priorité |
|---|----------|---------|----------|
| Q1 | Numéros CC définitifs pour le doigt (cordes et clavier) | Voir `MIDI_CC_INSTRUMENT_CONTROLS.md`, plage CC22–31 pour cordes, CC107–119 pour clavier | Haute |
| Q2 | Algorithme d'assignation doigt (greedy vs DP) | Greedy V1 recommandé (cf. `TODO.md`) ; DP en V2 | Haute |
| Q3 | Gestion des accords de piano > 5 notes dans une même main | Réassignation auto à l'autre main, ou warning + note injouable | Haute |
| Q4 | Encodage du doigt dans le CC | Valeur brute 1–5 (ou 1–4), ou valeur décalée selon un offset configurable | Moyenne |
| Q5 | Barré partiel cordes (même doigt, 2 cordes adjacentes même frette) | Modèle spécial barré ou encodage dédié dans le CC | Basse |
| Q6 | Thumb-under (passage du pouce sous les doigts) au clavier | Modélisation anatomique vs simplification géométrique | Basse |
| Q7 | `finger_switch_ms` configurable ou constante interne | Selon retour des tests hardware | Moyenne |

---

## 10. Glossaire

| Terme | Définition |
|-------|------------|
| **Doigt humanoïde** | Actionneur mécanique indépendant simulant un doigt humain, piloté par un identifiant CC |
| **Identifiant de doigt** | Valeur 1–4 (cordes) ou 1–5 (clavier) transmise via CC avant chaque note-on |
| **Main de fretting** | Main qui presse les frettes sur un instrument à cordes (oppose à la main d'attaque) |
| **Main gauche / droite** | Mains humanoïdes d'un clavier, séparées par `split_note` |
| **Span de main** | Distance physique maximale entre le doigt le plus bas et le plus haut de la main (`hand_span_mm`) |
| **Finger switch** | Changement de doigt sur la même corde entre deux notes consécutives (coût temporel `finger_switch_ms`) |
| **Barré** | Technique où un seul doigt presse simultanément plusieurs cordes sur la même frette (hors périmètre V1) |
| **Split note** | Note MIDI séparant les registres gauche et droite sur un clavier (défaut C4 = 60) |
| **Register** | Zone de l'instrument assignée à une main : `low`, `mid_low`, `mid_high`, `high`, `full` |
| **`independent_fingers`** | Mécanisme V2 de `hands_config` ciblant les effecteurs à doigts humanoïdes indépendants |

---

## 11. Relation aux documents existants

| Document | Relation |
|----------|----------|
| [`STRING_HAND_POSITION.md`](STRING_HAND_POSITION.md) | Spécifie le pipeline V1 (fenêtre glissante) que ce modèle étend |
| [`LONGITUDINAL_MODEL.md`](LONGITUDINAL_MODEL.md) | Modèle longitudinal `string_sliding_fingers` — alternative au présent modèle |
| [`HAND_VISUALIZATION.md`](HAND_VISUALIZATION.md) | Rendu graphique de la main — à étendre pour la visualisation par doigt |
| [`MIDI_CC_INSTRUMENT_CONTROLS.md`](MIDI_CC_INSTRUMENT_CONTROLS.md) | Table d'allocation CC — à mettre à jour avec les nouveaux CC doigt |
| [`TODO.md`](../TODO.md) § *Mécanisme independent_fingers* | Analyse initiale et options d'implémentation |
