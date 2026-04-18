# MIDI CC - Controles Specifiques par Instrument

## Introduction

Ma-est-tro utilise des CC (Control Change) MIDI dedies pour le controle fin des instruments au-dela des CC standards (volume, pan, expression, etc.). Ce document recense les CC reserves et planifies pour chaque famille d'instruments.

### Etat actuel

| CC | Nom | Status |
|---|---|---|
| CC20 | String Select | Implemente |
| CC21 | Fret Select | Implemente |

### Plages CC disponibles (non definies dans GM/GS)

- **CC14-19** : Libres
- **CC22-31** : Libres (CC20-21 utilises)
- **CC85-90** : Libres
- **CC102-119** : Libres

---

## 1. Controles generiques - CC14-19

Applicables a tous les instruments.

| CC | Nom | Valeurs | Description |
|---|---|---|---|
| CC14 | Articulation Select | 0=legato, 1=staccato, 2=marcato, 3=tenuto, 4=accent, 5=sforzando | Articulation universelle |
| CC15 | Vibrato Rate | 0 (lent) - 127 (rapide) | Vitesse du vibrato (complete CC1 = profondeur) |
| CC16 | Vibrato Delay | 0 (immediat) - 127 (tres retarde) | Delai avant debut du vibrato apres note-on |
| CC17 | Body Resonance | 0 (sec) - 127 (resonant) | Resonance du corps de l'instrument |
| CC18 | Release Type | Paliers 0-127 | Type de relachement (selection sample note-off) |
| CC19 | Micro-tuning | 0 (-50 cents), 64 (0), 127 (+50 cents) | Accordage fin par note individuelle |

---

## 2. Instruments a cordes - CC20-28

Guitare, basse, ukulele, banjo, violon, alto, violoncelle, contrebasse, mandoline.

| CC | Nom | Valeurs | Description |
|---|---|---|---|
| CC20 | String Select | 1-12 | **Implemente** - Selection de la corde |
| CC21 | Fret Select | 0-36 | **Implemente** - Selection de la frette |
| CC22 | Playing Technique | 0=pick down, 1=pick up, 2=finger, 3=slap, 4=tap, 5=hammer-on, 6=pull-off, 7=harmonique naturelle, 8=harmonique artificielle | Technique de jeu / type d'attaque |
| CC23 | Pick/Bow Position | 0 (chevalet/ponte) - 127 (manche/tasto) | Position du mediator ou de l'archet (continu) |
| CC24 | Palm Mute | 0 (ouvert) - 127 (completement etouffe) | Intensite de l'etouffement |
| CC25 | Slide Type | 0=off, 1=slide up into, 2=slide down into, 3=slide up out, 4=slide down out, 5=legato slide | Type de glissando |
| CC26 | Bend Range | 0-24 (demi-tons) | Etendue du pitch bend pour la note courante |
| CC27 | Capo Position | 0=pas de capo, 1-24=position frette | Position du capo virtuel |
| CC28 | Bow Technique | 0=arco, 1=pizzicato, 2=col legno, 3=spiccato, 4=tremolo, 5=sul ponticello, 6=sul tasto, 7=martele | Techniques specifiques cordes frottees |

---

## 3. Vents et cuivres - CC85-90

Trompette, trombone, cor, tuba, saxophone, flute, clarinette, hautbois, basson.

| CC | Nom | Valeurs | Description |
|---|---|---|---|
| CC85 | Mute Type | 0=open, 1=straight, 2=cup, 3=harmon (stem in), 4=harmon (stem out), 5=bucket, 6=plunger open, 7=plunger closed | Type de sourdine (cuivres) |
| CC86 | Tonguing Type | 0=normal, 1=legato tongue, 2=staccato tongue, 3=double tongue, 4=triple tongue, 5=flutter tongue, 6=growl | Articulation a la langue |
| CC87 | Air/Breath Noise | 0 (clean) - 127 (tres bruite) | Quantite de bruit de souffle |
| CC88 | Embouchure | 0 (relache) - 127 (serre) | Tension des levres (affecte le timbre) |
| CC89 | Key Noise | 0 (off) - 127 (fort) | Bruits mecaniques des cles/pistons |
| CC90 | Overblowing | 0 (normal) - 127 (overblown) | Sursoufflage, multiphoniques |

---

## 4. Percussions et batterie - CC102-106

Batterie, timbales, xylophone, marimba, congas, djembe, etc.

| CC | Nom | Valeurs | Description |
|---|---|---|---|
| CC102 | Stick Type | 0=stick bois, 1=stick nylon, 2=brush, 3=mallet feutre, 4=mallet caoutchouc, 5=hand/doigt, 6=rod/bundle | Type d'outil de frappe |
| CC103 | Hit Position | 0 (centre) - 127 (bord/rim) | Zone d'impact sur la peau ou cymbale |
| CC104 | Damping/Choke | 0 (libre/ring) - 127 (completement etouffe) | Etouffement cymbale ou peau |
| CC105 | Rim Technique | 0=normal, 1=rimshot, 2=cross-stick (sidestick), 3=rim only | Technique caisse claire |
| CC106 | Hi-Hat Fine | 0 (ferme tight) - 127 (ouvert max) | Controle fin du hi-hat (complete CC4 foot controller) |

---

## 5. Clavier et piano - CC107-110

Piano acoustique, piano electrique, clavecin, orgue.

| CC | Nom | Valeurs | Description |
|---|---|---|---|
| CC107 | Hammer Hardness | 0 (doux/feutre neuf) - 127 (dur/feutre use) | Durete du marteau |
| CC108 | String Resonance | 0 (off) - 127 (max) | Resonance sympathique des cordes |
| CC109 | Lid Position | 0 (ferme), 64 (demi-ouvert), 127 (grand ouvert) | Position du couvercle |
| CC110 | Pedal Noise | 0 (off) - 127 (fort) | Bruits mecaniques de la pedale |

---

## 6. Reserve future - CC111-119

9 CCs reserves pour de futures extensions (instruments ethniques, effets speciaux, etc.).

---

## Resume des plages

| Plage | Famille | CCs | Status |
|---|---|---|---|
| CC14-19 | Generiques (tous instruments) | 6 | A implementer |
| CC20-28 | Cordes | 9 | CC20-21 implementes, CC22-28 a faire |
| CC85-90 | Vents / Cuivres | 6 | A implementer |
| CC102-106 | Percussions / Batterie | 5 | A implementer |
| CC107-110 | Clavier / Piano | 4 | A implementer |
| CC111-119 | Reserve | 9 | Non assigne |
| **Total** | | **39** | **2 implementes, 28 planifies, 9 reserves** |

## Priorite d'implementation suggeree

### Phase 1 - Impact maximum
1. **CC14** - Articulation Select (universel, tous instruments)
2. **CC22** - Playing Technique (cordes, complete string/fret)
3. **CC102** - Stick Type (percussions, change radicalement le son)
4. **CC85** - Mute Type (cuivres, essentiel pour le realisme)

### Phase 2 - Realisme avance
5. **CC24** - Palm Mute (cordes)
6. **CC103** - Hit Position (percussions)
7. **CC86** - Tonguing Type (vents)
8. **CC15/CC16** - Vibrato rate et delay (generique)
9. **CC23** - Pick/Bow Position (cordes)

### Phase 3 - Finition
10. **CC87/CC89** - Bruits mecaniques (air noise, key noise)
11. **CC17** - Body Resonance
12. **CC107-110** - Controles piano
13. **CC28** - Bow Technique (cordes frottees)
14. **CC25** - Slide Type (cordes)

## Notes d'implementation

L'architecture existante pour CC20/CC21 fournit le pattern a suivre :

- **Constantes** : ajouter dans `src/constants.js` (objet `MIDI_CC`)
- **Config par instrument** : cc_number, min, max, offset (configurable comme pour string/fret)
- **Base de donnees** : migration SQL pour stocker la config par instrument
- **Validation** : mettre a jour `InstrumentCapabilitiesValidator.js` avec les CCs supportes par type
- **Filtrage** : adapter `PlaybackScheduler.js` pour les nouveaux CCs
- **UI** : ajouter dans `MidiEditorCCPanel.js` / `MidiEditorCCPicker.js`
