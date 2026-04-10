# Images a faire - Instruments General MIDI

Checklist de toutes les images d'instruments a creer pour Ma-est-tro.
Les images serviront a identifier visuellement chaque instrument dans l'interface web.

**Classification retenue** : tous les instruments ayant une forme physique reelle (acoustiques + electro-acoustiques). Seuls les sons purement synthetiques et effets sonores sont exclus.

---

## Contraintes techniques

| Critere | Specification |
|---------|--------------|
| **Format prefere** | SVG (vectoriel, leger, scalable) |
| **Format alternatif** | PNG-8 avec transparence alpha |
| **Taille max (PNG)** | 128 x 128 px |
| **Palette (PNG)** | 256 couleurs max (PNG-8) |
| **Poids cible** | < 10 KB (SVG) / < 15 KB (PNG) |
| **Style** | Flat / line-art — pas de degrades, pas d'ombres portees, pas de photorealisme |
| **Coherence** | Meme epaisseur de trait, meme palette de couleurs, meme niveau de detail |
| **Fond** | Transparent |
| **Plateforme cible** | Raspberry Pi (web UI) — les images doivent etre legeres |

### Convention de nommage

- **Instruments** : cle du sous-type dans `InstrumentTypeConfig.js`
  - Exemple : `acoustic_grand.svg`, `nylon.svg`, `trumpet.svg`
  - Destination : `instruments/`
- **Drums (notes)** : `drum_<numero_note>.svg`
  - Exemple : `drum_35.svg`, `drum_36.svg`, `drum_42.svg`
  - Destination : `drums/`
- **Drums (kits)** : `kit_<nom>.svg`
  - Exemple : `kit_standard.svg`, `kit_jazz.svg`
  - Destination : `drums/`

---

## Checklist instruments melodiques — dossier `instruments/`

**88 images a creer**

### Piano (GM 0-7) — 8 images

- [ ] `acoustic_grand.svg` — GM 0 — Piano a queue
- [ ] `bright_acoustic.svg` — GM 1 — Piano brillant
- [ ] `electric_grand.svg` — GM 2 — Piano electrique grand
- [ ] `honky_tonk.svg` — GM 3 — Honky-tonk
- [ ] `electric_piano_1.svg` — GM 4 — Piano electrique 1 (Rhodes)
- [ ] `electric_piano_2.svg` — GM 5 — Piano electrique 2 (Wurlitzer/DX7)
- [ ] `harpsichord.svg` — GM 6 — Clavecin
- [ ] `clavinet.svg` — GM 7 — Clavinet

### Percussion chromatique (GM 8-15) — 8 images

- [ ] `celesta.svg` — GM 8 — Celesta
- [ ] `glockenspiel.svg` — GM 9 — Glockenspiel
- [ ] `music_box.svg` — GM 10 — Boite a musique
- [ ] `vibraphone.svg` — GM 11 — Vibraphone
- [ ] `marimba.svg` — GM 12 — Marimba
- [ ] `xylophone.svg` — GM 13 — Xylophone
- [ ] `tubular_bells.svg` — GM 14 — Cloches tubulaires
- [ ] `dulcimer.svg` — GM 15 — Dulcimer

### Orgue (GM 16-23) — 8 images

- [ ] `drawbar.svg` — GM 16 — Orgue a tirettes (Hammond)
- [ ] `percussive_organ.svg` — GM 17 — Orgue percussif
- [ ] `rock_organ.svg` — GM 18 — Orgue rock
- [ ] `church_organ.svg` — GM 19 — Orgue d'eglise
- [ ] `reed_organ.svg` — GM 20 — Orgue a anches (harmonium)
- [ ] `accordion.svg` — GM 21 — Accordeon
- [ ] `harmonica.svg` — GM 22 — Harmonica
- [ ] `tango_accordion.svg` — GM 23 — Bandoneon

### Guitare (GM 24-31) — 8 images

- [ ] `nylon.svg` — GM 24 — Guitare classique (nylon)
- [ ] `steel.svg` — GM 25 — Guitare folk (acier)
- [ ] `jazz.svg` — GM 26 — Guitare jazz (archtop)
- [ ] `clean.svg` — GM 27 — Guitare clean (electrique)
- [ ] `muted.svg` — GM 28 — Guitare muted (electrique)
- [ ] `overdrive.svg` — GM 29 — Guitare overdrive (electrique)
- [ ] `distortion.svg` — GM 30 — Guitare distortion (electrique)
- [ ] `harmonics.svg` — GM 31 — Guitare harmoniques (electrique)

### Basse (GM 32-37) — 6 images

- [ ] `acoustic.svg` — GM 32 — Contrebasse
- [ ] `finger.svg` — GM 33 — Basse electrique finger
- [ ] `pick.svg` — GM 34 — Basse electrique pick
- [ ] `fretless.svg` — GM 35 — Basse electrique fretless
- [ ] `slap_1.svg` — GM 36 — Basse electrique slap 1
- [ ] `slap_2.svg` — GM 37 — Basse electrique slap 2

### Cordes (GM 40-47) — 8 images

- [ ] `violin.svg` — GM 40 — Violon
- [ ] `viola.svg` — GM 41 — Alto
- [ ] `cello.svg` — GM 42 — Violoncelle
- [ ] `contrabass.svg` — GM 43 — Contrebasse a cordes
- [ ] `tremolo.svg` — GM 44 — Cordes tremolo
- [ ] `pizzicato.svg` — GM 45 — Cordes pizzicato
- [ ] `harp.svg` — GM 46 — Harpe
- [ ] `timpani.svg` — GM 47 — Timbales d'orchestre

### Ensemble (GM 48-49, 52-53, 55) — 5 images

- [ ] `string_ensemble_1.svg` — GM 48 — Ensemble cordes 1
- [ ] `string_ensemble_2.svg` — GM 49 — Ensemble cordes 2
- [ ] `choir_aahs.svg` — GM 52 — Choeur Aahs
- [ ] `voice_oohs.svg` — GM 53 — Voix Oohs
- [ ] `orchestra_hit.svg` — GM 55 — Hit orchestral

### Cuivres (GM 56-61) — 6 images

- [ ] `trumpet.svg` — GM 56 — Trompette
- [ ] `trombone.svg` — GM 57 — Trombone
- [ ] `tuba.svg` — GM 58 — Tuba
- [ ] `muted_trumpet.svg` — GM 59 — Trompette en sourdine
- [ ] `french_horn.svg` — GM 60 — Cor d'harmonie
- [ ] `brass_section.svg` — GM 61 — Section cuivres

### Anches (GM 64-71) — 8 images

- [ ] `soprano_sax.svg` — GM 64 — Saxophone soprano
- [ ] `alto_sax.svg` — GM 65 — Saxophone alto
- [ ] `tenor_sax.svg` — GM 66 — Saxophone tenor
- [ ] `baritone_sax.svg` — GM 67 — Saxophone baryton
- [ ] `oboe.svg` — GM 68 — Hautbois
- [ ] `english_horn.svg` — GM 69 — Cor anglais
- [ ] `bassoon.svg` — GM 70 — Basson
- [ ] `clarinet.svg` — GM 71 — Clarinette

### Bois / Flutes (GM 72-79) — 8 images

- [ ] `piccolo.svg` — GM 72 — Piccolo
- [ ] `flute.svg` — GM 73 — Flute traversiere
- [ ] `recorder.svg` — GM 74 — Flute a bec
- [ ] `pan_flute.svg` — GM 75 — Flute de Pan
- [ ] `bottle.svg` — GM 76 — Bouteille soufflee
- [ ] `shakuhachi.svg` — GM 77 — Shakuhachi
- [ ] `whistle.svg` — GM 78 — Sifflet
- [ ] `ocarina.svg` — GM 79 — Ocarina

### Ethnique (GM 104-111) — 8 images

- [ ] `sitar.svg` — GM 104 — Sitar
- [ ] `banjo.svg` — GM 105 — Banjo
- [ ] `shamisen.svg` — GM 106 — Shamisen
- [ ] `koto.svg` — GM 107 — Koto
- [ ] `kalimba.svg` — GM 108 — Kalimba
- [ ] `bagpipe.svg` — GM 109 — Cornemuse
- [ ] `fiddle.svg` — GM 110 — Fiddle
- [ ] `shanai.svg` — GM 111 — Shanai

### Batterie / Percussion melodique (GM 112-117, 119) — 7 images

- [ ] `tinkle_bell.svg` — GM 112 — Clochette
- [ ] `agogo.svg` — GM 113 — Agogo
- [ ] `steel_drums.svg` — GM 114 — Steel drums
- [ ] `woodblock.svg` — GM 115 — Woodblock
- [ ] `taiko.svg` — GM 116 — Taiko
- [ ] `melodic_tom.svg` — GM 117 — Tom melodique
- [ ] `reverse_cymbal.svg` — GM 119 — Cymbale inversee

---

## Checklist drums — dossier `drums/`

### Notes GM drum (35-81) — 47 images

Chaque element de percussion du kit General MIDI standard (canal 10).

#### Grosse caisse

- [ ] `drum_35.svg` — Note 35 — Acoustic Bass Drum
- [ ] `drum_36.svg` — Note 36 — Bass Drum 1

#### Caisse claire

- [ ] `drum_37.svg` — Note 37 — Side Stick
- [ ] `drum_38.svg` — Note 38 — Acoustic Snare
- [ ] `drum_39.svg` — Note 39 — Hand Clap
- [ ] `drum_40.svg` — Note 40 — Electric Snare

#### Charleston (Hi-Hat)

- [ ] `drum_42.svg` — Note 42 — Closed Hi-Hat
- [ ] `drum_44.svg` — Note 44 — Pedal Hi-Hat
- [ ] `drum_46.svg` — Note 46 — Open Hi-Hat

#### Toms

- [ ] `drum_41.svg` — Note 41 — Low Floor Tom
- [ ] `drum_43.svg` — Note 43 — High Floor Tom
- [ ] `drum_45.svg` — Note 45 — Low Tom
- [ ] `drum_47.svg` — Note 47 — Low-Mid Tom
- [ ] `drum_48.svg` — Note 48 — Hi-Mid Tom
- [ ] `drum_50.svg` — Note 50 — High Tom

#### Cymbales

- [ ] `drum_49.svg` — Note 49 — Crash Cymbal 1
- [ ] `drum_51.svg` — Note 51 — Ride Cymbal 1
- [ ] `drum_52.svg` — Note 52 — Chinese Cymbal
- [ ] `drum_53.svg` — Note 53 — Ride Bell
- [ ] `drum_55.svg` — Note 55 — Splash Cymbal
- [ ] `drum_57.svg` — Note 57 — Crash Cymbal 2
- [ ] `drum_59.svg` — Note 59 — Ride Cymbal 2

#### Accessoires

- [ ] `drum_54.svg` — Note 54 — Tambourine
- [ ] `drum_56.svg` — Note 56 — Cowbell
- [ ] `drum_58.svg` — Note 58 — Vibraslap

#### Percussions latines

- [ ] `drum_60.svg` — Note 60 — Hi Bongo
- [ ] `drum_61.svg` — Note 61 — Low Bongo
- [ ] `drum_62.svg` — Note 62 — Mute Hi Conga
- [ ] `drum_63.svg` — Note 63 — Open Hi Conga
- [ ] `drum_64.svg` — Note 64 — Low Conga
- [ ] `drum_65.svg` — Note 65 — High Timbale
- [ ] `drum_66.svg` — Note 66 — Low Timbale
- [ ] `drum_67.svg` — Note 67 — High Agogo
- [ ] `drum_68.svg` — Note 68 — Low Agogo

#### Petites percussions

- [ ] `drum_69.svg` — Note 69 — Cabasa
- [ ] `drum_70.svg` — Note 70 — Maracas
- [ ] `drum_71.svg` — Note 71 — Short Whistle
- [ ] `drum_72.svg` — Note 72 — Long Whistle
- [ ] `drum_73.svg` — Note 73 — Short Guiro
- [ ] `drum_74.svg` — Note 74 — Long Guiro
- [ ] `drum_75.svg` — Note 75 — Claves
- [ ] `drum_76.svg` — Note 76 — Hi Wood Block
- [ ] `drum_77.svg` — Note 77 — Low Wood Block
- [ ] `drum_78.svg` — Note 78 — Mute Cuica
- [ ] `drum_79.svg` — Note 79 — Open Cuica
- [ ] `drum_80.svg` — Note 80 — Mute Triangle
- [ ] `drum_81.svg` — Note 81 — Open Triangle

### Kits de batterie — 4 images

- [ ] `kit_standard.svg` — Kit standard
- [ ] `kit_jazz.svg` — Kit jazz
- [ ] `kit_brush.svg` — Kit brosses
- [ ] `kit_orchestra.svg` — Kit orchestral

---

## Instruments ignores (electroniques / synthetiques)

Les programmes GM suivants n'ont **pas** d'image a creer car ils representent des sons purement synthetiques sans forme physique distincte.

### Synth Lead (GM 80-87) — 8 programmes ignores

| GM | Nom | Raison |
|----|-----|--------|
| 80 | Lead carre (Square) | Forme d'onde synthetique |
| 81 | Lead dents de scie (Sawtooth) | Forme d'onde synthetique |
| 82 | Lead calliope | Son synthetique |
| 83 | Lead chiff | Son synthetique |
| 84 | Lead charang | Son synthetique |
| 85 | Lead voix | Son synthetique |
| 86 | Lead quintes | Son synthetique |
| 87 | Lead + basse | Son synthetique |

### Synth Pad (GM 88-95) — 8 programmes ignores

| GM | Nom | Raison |
|----|-----|--------|
| 88 | Pad new age | Nappe synthetique |
| 89 | Pad warm | Nappe synthetique |
| 90 | Pad polysynth | Nappe synthetique |
| 91 | Pad choeur | Nappe synthetique |
| 92 | Pad bowed | Nappe synthetique |
| 93 | Pad metallique | Nappe synthetique |
| 94 | Pad halo | Nappe synthetique |
| 95 | Pad sweep | Nappe synthetique |

### Synth Effects (GM 96-103) — 8 programmes ignores

| GM | Nom | Raison |
|----|-----|--------|
| 96 | FX pluie | Effet synthetique |
| 97 | FX soundtrack | Effet synthetique |
| 98 | FX crystal | Effet synthetique |
| 99 | FX atmosphere | Effet synthetique |
| 100 | FX brightness | Effet synthetique |
| 101 | FX goblins | Effet synthetique |
| 102 | FX echoes | Effet synthetique |
| 103 | FX sci-fi | Effet synthetique |

### Sound Effects (GM 120-127) — 8 programmes ignores

| GM | Nom | Raison |
|----|-----|--------|
| 120 | Fret noise | Bruit, pas un instrument |
| 121 | Souffle (Breath) | Bruit, pas un instrument |
| 122 | Mer (Seashore) | Effet sonore ambiant |
| 123 | Oiseau (Bird) | Effet sonore ambiant |
| 124 | Telephone | Effet sonore |
| 125 | Helicoptere | Effet sonore |
| 126 | Applaudissements | Effet sonore |
| 127 | Coup de feu | Effet sonore |

### Instruments synthetiques isoles — 7 programmes ignores

| GM | Nom | Categorie d'origine | Raison |
|----|-----|---------------------|--------|
| 38 | Synth Bass 1 | Basse | Son de basse synthetique |
| 39 | Synth Bass 2 | Basse | Son de basse synthetique |
| 50 | Synth Strings 1 | Ensemble | Nappe de cordes synthetique |
| 51 | Synth Strings 2 | Ensemble | Nappe de cordes synthetique |
| 54 | Synth Voice | Ensemble | Voix synthetique |
| 62 | Synth Brass 1 | Cuivres | Cuivres synthetiques |
| 63 | Synth Brass 2 | Cuivres | Cuivres synthetiques |

### Percussion synthetique — 1 programme + 1 kit ignores

| GM | Nom | Raison |
|----|-----|--------|
| 118 | Synth Drum | Batterie synthetique |
| — | Kit electronique | Kit de batterie synthetique |

**Total ignore : 40 programmes GM + 1 kit de batterie**

---

## Suggestions de reutilisation d'images

Certains instruments sont le meme objet physique joue avec des techniques differentes. Une meme image peut etre reutilisee (ou legerement variee) :

| Image de base | Reutilisable pour | Instruments concernes |
|---------------|-------------------|----------------------|
| Piano a queue | Piano brillant, Honky-tonk | GM 0, 1, 3 |
| Guitare electrique | Clean, Muted, Overdrive, Distortion, Harmoniques | GM 27, 28, 29, 30, 31 |
| Basse electrique | Finger, Pick, Fretless, Slap 1, Slap 2 | GM 33, 34, 35, 36, 37 |
| Section de cordes | Ensemble cordes 1, Ensemble cordes 2 | GM 48, 49 |
| Trompette | Trompette en sourdine | GM 56, 59 |
| Cymbale crash | Crash 1, Crash 2 | Notes 49, 57 |
| Cymbale ride | Ride 1, Ride 2, Ride Bell | Notes 51, 53, 59 |
| Tom | Low Floor, High Floor, Low, Low-Mid, Hi-Mid, High | Notes 41, 43, 45, 47, 48, 50 |
| Bongo | Hi Bongo, Low Bongo | Notes 60, 61 |
| Conga | Mute Hi, Open Hi, Low Conga | Notes 62, 63, 64 |
| Timbale | High Timbale, Low Timbale | Notes 65, 66 |
| Agogo | High Agogo, Low Agogo | Notes 67, 68 |
| Wood Block | Hi Wood Block, Low Wood Block | Notes 76, 77 |
| Cuica | Mute Cuica, Open Cuica | Notes 78, 79 |
| Triangle | Mute Triangle, Open Triangle | Notes 80, 81 |
| Guiro | Short Guiro, Long Guiro | Notes 73, 74 |
| Whistle | Short Whistle, Long Whistle | Notes 71, 72 |

---

## Resume

| Categorie | Images a creer | Images ignorees |
|-----------|---------------|-----------------|
| Instruments melodiques | **88** | 40 |
| Notes drum (35-81) | **47** | — |
| Kits de batterie | **4** | 1 |
| **TOTAL** | **139** | **41** |

### Fichiers source de reference

- `src/midi/InstrumentTypeConfig.js` — Hierarchie des 128 programmes GM, labels francais, cles de sous-type
- `src/midi/DrumNoteMapper.js` — Notes drum GM 35-81 avec noms anglais
