# 06 — Routage / adaptation / familles d'instruments : matrice de complétude

**Lot L06** · Date : 2026-09-07 · Commit de départ : `8dc170e` (baseline L00)
**Périmètre plan** : §G01–G04 (routage), §H01–H06 (adaptation), §I01–I08
(familles), §J01–J05 (mains / faisabilité), §T1 (roadmap v0.9).
**Findings ouverts par ce lot : F-64 → F-75.**

---

## 1. Synthèse

> **Le moteur d'adaptation est solide ; c'est le contrat « capacité déclarée ⇒
> capacité consommée » qui ne l'est pas.**

La zone est bien la mieux couverte du backend — mesuré, pas estimé :
**78,6 % de statements** sur `src/midi/{routing,adaptation,instrument}`
(cf. §2.2). Mais la couverture masque deux choses :

1. **Elle est très inégale.** `MidiRouter.js` est à **52,1 %**, `MidiTransposer`
   à **59,9 %**, `DrumNoteMapper` à **62,2 %**, `LatencyCompensator` à
   **43,3 %** — alors que `NoteEnforcement` et `ScaleSnapper` sont à 97–100 %.
   Le « 74–79 % » de l'audit d'août est une moyenne qui cache le chemin **live**,
   le moins couvert et le seul qui parle à du matériel en temps réel.
2. **Elle ne mesure que ce qui est appelé, jamais ce qui n'est jamais lu.**
   C'est exactement l'objet de ce lot.

**Résultat central : 11 capacités mortes ou semi-mortes identifiées et closes**
(§4). Elles se répartissent en trois classes très différentes, qu'il ne faut pas
traiter pareil :

| Classe | Ce que ça veut dire | Combien | Action |
|---|---|---|---|
| **A — Morte franche** | Écrite, validée, persistée, **relue par personne**. L'utilisateur configure du vide. | **4** | À câbler ou à supprimer (blocker « 100 % fonctionnel ») |
| **B — Moteur aveugle, effet ailleurs** | A un effet réel, mais seulement sur la **vue clavier / le jeu live**, jamais sur l'adaptation d'un fichier. | **5** | À **documenter** comme tel ; pas un blocker (décision T1.3 déjà prise) |
| **C — Inerte assumée** | Retirée volontairement, la colonne survit. | **2** | Nettoyage de surface (T7) |

**Trois faits nouveaux, établis avec une base SQLite réelle** (ce que l'audit
d'août ne pouvait pas faire) :

- **T1.8 est débloqué.** L'écriture `capabilities_source='descriptor'` est bien
  refusée aujourd'hui (`CHECK constraint failed`, reproduit). **La migration de
  rebuild de table est faisable proprement** : écrite, exécutée contre une vraie
  base avec les sémantiques exactes du runner (`BEGIN`/`exec`/`COMMIT`,
  `foreign_keys=ON`), **4 ms**, 11 index + 2 triggers recréés, `foreign_key_check`
  vide, `integrity_check ok`, cascade `devices → instruments_latency` préservée.
  Le SQL complet est en §10.2 — **la migration n'a pas été créée** (règle du lot).
- **Le trou de validation est plus large qu'annoncé.** Huit colonnes de capacité
  n'ont **aucune** garde : `gm_program=9999`, `polyphony=-5`, `comm_timeout=-1`,
  `min_note_interval=-100`, `min_note_duration=-100`, `scale_root=-7`,
  `instrument_type='not-a-type'` sont **acceptés en base** (§3.4). Conséquence
  observable la plus grave : un `octave_mode` mal orthographié **désactive
  silencieusement le snap de gamme** — l'instrument redevient chromatique sans
  le moindre avertissement (test vert).
- **La valeur `'sysex'` de `capabilities_source` n'est produite par aucun
  writer.** L'énumération autorise trois valeurs, le code n'en écrit que deux
  (`'manual'`, `'auto'`).

**Un défaut de parité live ↔ fichier a été trouvé et corrigé** (F-64, §11) :
les CC 20/21 (protocole d'actionneur de tablature) étaient traités de deux
façons différentes selon le chemin — les doigts mécaniques ne bougeaient pas en
jeu live dès que l'instrument déclarait un `supported_ccs`, et inversement des
CC 20/21 partaient vers des destinations non-cordes que le playback filtre.
Corrigé dans `MidiRouter`, rouge → vert, 9 tests.

**Verdicts par section**

| § | Sujet | État | Niveau |
|---|---|---|---|
| G01 | Routage manuel | PARTIAL | 2 |
| G02 | Auto-routage | PARTIAL | 3 |
| G03 | Split de canaux | PARTIAL | 3 |
| G04 | Hot-plug en lecture | HW REQUIRED | 0 |
| H01 | Repli de plage | **PASS** | 4 |
| H02 | Transposition / gamme | PARTIAL | 3 |
| H03 | Réduction de polyphonie | **PASS** | 4 |
| H04 | Percussions | PARTIAL | 2 |
| H05 | Scoring du matcher | PARTIAL | 2 |
| H06 | AutoAssigner | PARTIAL | 3 |
| I01–I08 | Familles | PARTIAL (3 familles NOT TESTED) | 1 |
| J01–J04 | Mains / faisabilité | PARTIAL | 3 |
| J05 | `independent_fingers` | **EXPERIMENTAL — auto-déclaration honnête (vérifiée)** | 3 |
| T1.1(b) | Voix GM sur le route-through live | **FAIL (non implémenté)** | 0 |
| T1.1(c) | `voices_share_notes` exposé dans l'UI | **PASS — il l'est** | 3 |
| T1.8 | Pipeline descripteur v2 | **BLOCKED → débloqué (migration prouvée)** | 3 |

---

## 2. Méthode et environnement

### 2.1 Méthode

1. **Extraction du schéma** : les 34 migrations (`001_baseline.sql` +
   `002`→`034`) appliquées sur une base SQLite jetable, puis `PRAGMA table_info`
   sur les 5 tables porteuses de capacités. **Aucune migration créée.**
2. Pour chaque colonne : recherche des **quatre** points — écriture
   (`src/persistence`, `src/api`), validation (schéma JSON, `CHECK` SQL, garde
   impérative), **lecture par le moteur** (`src/midi/**` uniquement), test.
   *Un `grep` du nom de colonne qui ne trouve que l'écriture et la validation
   est le signal.*
3. Pour chaque signal : **vérification par un test exécutable** que la lecture
   a — ou n'a pas — un effet observable sur la sortie.
4. Base jetable sous
   `/tmp/claude-0/.../scratchpad/L06/` — `./data/gmboop.db` jamais touché.

**Convention des tests livrés.** Les tests de capacités portent une étiquette :
`[VIVANT]` (la capacité a un effet — régression si l'effet disparaît),
`[MORTE]` (test de **caractérisation** : il fige le constat et devient rouge le
jour où la capacité est câblée — c'est alors le test qu'il faut inverser, pas le
code), `[TROU]` (comportement non voulu figé pour ne pas empirer).

### 2.2 Couverture réelle du périmètre (mesurée)

```
node --experimental-vm-modules node_modules/jest/bin/jest.js --coverage \
  --collectCoverageFrom='src/midi/routing/**/*.js' \
  --collectCoverageFrom='src/midi/adaptation/**/*.js' \
  --collectCoverageFrom='src/midi/instrument/**/*.js'
```

| Module | % Stmts | % Branch | % Funcs |
|---|---|---|---|
| **Total périmètre L06** | **78,62** | **71,06** | **77,38** |
| `instrument/` | 87,82 | 88,07 | 84,21 |
| `adaptation/` | 79,01 | 70,28 | 77,07 |
| `routing/` | **74,32** | 66,25 | 76,19 |

Les cinq plus bas, tous dans le périmètre :

| Fichier | % Stmts | Pourquoi ça compte |
|---|---|---|
| `LatencyCompensator.js` | **43,28** | calcul de compensation, chemin temps réel |
| `MidiRouter.js` | **52,08** | **le chemin live** — 883 lignes, la moitié jamais exécutée en test |
| `MidiTransposer.js` | **59,91** | 1 017 lignes ; `reducePolyphonyGentle` (l. 508-699) intégralement non couvert |
| `DrumNoteMapper.js` | **62,19** | table GM de percussions, 1 050 lignes |
| `ChannelSplitter.js` | 78,04 | stratégies de split |

> **Lecture pour L13** : annoncer « 74–79 % sur le routage/adaptation » est
> exact et trompeur. Le chemin **live** (`MidiRouter`) est à 52 % ; c'est celui
> qui pilote du matériel sans filet de rejeu.

### 2.3 Environnement

| Ressource | État |
|---|---|
| `better-sqlite3` | ✅ **base réelle utilisée** (34 migrations appliquées, 0 échec) |
| `midi` / ALSA | ❌ chemin USB réel indisponible → §G04 reste HW |
| Matériel MIDI / Pi | ❌ → §I (rendu physique), §BM (qualité musicale) hors périmètre |

---

## 3. LA MATRICE DE COMPLÉTUDE DES CAPACITÉS

Colonnes : **Écrit** (un chemin d'écriture existe) · **Validé** (schéma JSON,
`CHECK` SQL ou garde impérative) · **Lu par le moteur** (`src/midi/**`) ·
**Testé** · **Verdict**.

Légende : ✅ oui · ⚠️ partiel · ❌ non · 🖥️ lu par le **frontend seulement**
(vue clavier / jeu live), jamais par l'adaptation de fichier.

### 3.1 `instruments_latency` — capacités primaires (54 colonnes, 33 de capacité)

| Colonne | Écrit | Validé | Lu par le moteur | Point de lecture | Testé | Verdict |
|---|---|---|---|---|---|---|
| `note_range_min` / `_max` | ✅ | ✅ `CHECK 0..127` + ordre min≤max | ✅ | `CapabilityResolver` → `clampNote` → `PlaybackScheduler` + `MidiRouter` | ✅ | **VIVANT** |
| `note_selection_mode` | ✅ | ✅ `CHECK IN(range,discrete)` + garde | ✅ | `CapabilityResolver` (gate du `selectedNotes`) | ✅ | **VIVANT** |
| `selected_notes` | ✅ | ✅ `json_valid` + `MidiListParser` | ✅ | `NoteEnforcement.snapToNearest` | ✅ | **VIVANT** |
| `polyphony` | ✅ | ⚠️ garde impérative ≥1 ; **aucun `CHECK`** (`-5` accepté) | ✅ | `_shouldGateNote` (fichier) + `NoteGate` (live) | ✅ | **VIVANT** |
| `min_note_interval` | ✅ | ❌ aucune (`-100` accepté) | ✅ | `_shouldGateNote` / `NoteGate` | ✅ | **VIVANT** |
| `min_note_duration` | ✅ | ❌ aucune | ⚠️ **fichier seulement** | `_noteOffDeferMs` ; le live ne le tient pas (documenté `NoteEnforcement`) | ✅ | **VIVANT partiel** |
| `sync_delay` | ✅ | ❌ aucune | ✅ | `_getSyncDelay`, `MidiRouter` compensation | ✅ | **VIVANT** |
| `supported_ccs` | ✅ | ✅ `json_valid` + `MidiListParser` | ✅ | `_isCCSupported` + `MidiRouter._enforceLiveLimits` | ✅ | **VIVANT** (T1.4) |
| `octave_mode` | ✅ | ❌ **aucune** (`'banana'` accepté) | ✅ | `ScaleSnapper` via `clampNote` | ✅ | **VIVANT mais non validé → F-68** |
| `scale_root` | ✅ | ❌ aucune (`999`, `-7` acceptés) | ✅ | `ScaleSnapper` (modulo 12 défensif) | ✅ | **VIVANT mais non validé → F-68** |
| `hands_config` | ✅ | ✅ `json_valid` + `InstrumentCapabilitiesValidator` | ✅ | `HandPositionPlanner`, `LongitudinalPlanner`, injection CC main, `handCcs` | ✅ | **VIVANT** |
| `gm_program` | ✅ | ❌ aucune (`9999` accepté) | ✅ | `InstrumentMatcher.scoreProgramMatch`, `VoiceSelector` | ✅ | **VIVANT mais non validé** |
| `instrument_type` / `_subtype` | ✅ | ❌ aucune | ✅ | `InstrumentMatcher`, `InstrumentTypeConfig` (transpositions) | ✅ | **VIVANT mais non validé** |
| `omni_mode` | ✅ | ✅ `CHECK IN(0,1)` | ✅ | `MidiPlayer._getOmniFallback` | ❌ **0 test** | **VIVANT non testé** |
| `comm_timeout` | ✅ | ❌ aucune | ✅ | `DeviceManager._getCommTimeoutMs` | ✅ | **VIVANT** (T1.6) |
| `midi_clock_enabled` | ✅ | ❌ | ✅ | `MidiClockGenerator` | ⚠️ | **VIVANT** |
| `voices_share_notes` | ✅ | ✅ `CHECK IN(0,1)` | ✅ | `MidiPlayer._injectVoiceProgramChangeEvents` (**fichier seulement**) | ✅ | **VIVANT partiel → F-71** |
| `capabilities_source` | ✅ | ✅ `CHECK IN(manual,sysex,auto)` | ⚠️ transporté par `AutoAssigner`, **jamais décisionnel** | — | ✅ | **INFORMATIF** — `'sysex'` n'est écrit par personne ; `'descriptor'` refusé → **T1.8 / F-67** |
| `capabilities_updated_at` | ✅ | — | ❌ | — | ⚠️ | **INFORMATIF** |
| `pitch_bend_enabled` | ✅ | ✅ `CHECK IN(0,1)` | ❌ 🖥️ | `KeyboardControls/Slider/Wind` (molette) | ✅ (ce lot) | **MORTE côté moteur → F-66** |
| `bagpipe_config` | ✅ | ✅ `json_valid` + validateur play-config | ❌ 🖥️ | `BagpipeView.drones` | ✅ | **Classe B — vue/live (T1.3, assumé)** |
| `accordion_config` | ✅ | ✅ idem | ❌ 🖥️ | `AccordionView.bass_system` | ✅ | **Classe B — vue/live (T1.3)** |
| `harmonica_config` | ✅ | ✅ idem | ❌ 🖥️ | `HarmonicaView.type/key` | ✅ | **Classe B — vue/live (T1.3)** |
| `lighting_enabled` | ✅ | ✅ `CHECK IN(0,1)` | ❌ (module `lighting/`, hors L06) | — | — | **hors périmètre → L02** |
| `custom_sf2_id` | ✅ | ✅ entier positif | ❌ (module `audio/`, hors L06) | — | — | **hors périmètre** |
| `descriptor_revision` | ❌ **aucun writer** | ❌ | ❌ | — | ✅ (ce lot) | **MORTE FRANCHE → F-67** |
| `descriptor_json` | ❌ **aucun writer** | ❌ (pas même `json_valid`) | ❌ | — | ✅ (ce lot) | **MORTE FRANCHE → F-67** |
| `sysex_*` (7 col.) | ✅ | ❌ | ⚠️ affichage + `capability-status` | — | ✅ | **INFORMATIF** |
| `avg/min/max_latency`, `jitter`, … | ✅ | ✅ `CHECK` | ❌ (mesure seule, par conception) | — | ✅ | **INFORMATIF assumé** |

### 3.2 `instrument_voices` — capacités par voix (migrations 003 / 005 / 032)

Seul consommateur moteur : `VoiceSelector` (+ `MidiPlayer._injectVoiceProgramChangeEvents`).

| Colonne | Écrit | Validé | Lu par le moteur | Testé | Verdict |
|---|---|---|---|---|---|
| `gm_program` | ✅ | ✅ | ✅ `selectVoiceProgram` | ✅ | **VIVANT** |
| `note_selection_mode` | ✅ | ⚠️ **aucun `CHECK`** sur cette table | ✅ | ✅ | **VIVANT** |
| `note_range_min` / `_max` | ✅ | ⚠️ idem | ✅ | ✅ | **VIVANT** |
| `selected_notes` | ✅ | ⚠️ `MidiListParser`, pas de `json_valid` | ✅ | ✅ | **VIVANT** |
| `display_order` | ✅ | — | ✅ (départage) | ✅ | **VIVANT** |
| `min_note_interval` | ✅ | ⚠️ | ❌ | ✅ (ce lot) | **MORTE → F-70** |
| `min_note_duration` | ✅ | ⚠️ | ❌ | ✅ (ce lot) | **MORTE → F-70** |
| `supported_ccs` | ✅ | ⚠️ | ❌ | ✅ (ce lot) | **MORTE → F-70** |
| `octave_mode` | ✅ | ❌ | ❌ | ✅ (ce lot) | **MORTE → F-70** |
| `scale_root` | ✅ | ❌ | ❌ | ✅ (ce lot) | **MORTE → F-70** |

> `INSTRUMENT_FAMILY_REFACTOR_ROADMAP.md` Phase 8 **tâche 4** demande
> explicitement : « `min_note_interval` et `min_note_duration` **de la voix
> sélectionnée** s'appliquent à la note courante ». Ce n'est pas livré.

### 3.3 `string_instruments` — capacités cordes

| Colonne | Écrit | Validé | Lu par le moteur | Point de lecture | Testé | Verdict |
|---|---|---|---|---|---|---|
| `tuning` | ✅ | ✅ élément par élément | ✅ | `TablatureConverter`, `CapabilityResolver` (plage dérivée) | ✅ | **VIVANT** |
| `num_strings` / `num_frets` | ✅ | ✅ | ✅ | idem | ✅ | **VIVANT** |
| `frets_per_string` | ✅ | ✅ positionnel | ✅ | `CapabilityResolver` (aligné index par index) | ✅ | **VIVANT** |
| `is_fretless` | ✅ | ✅ | ✅ | gate de la plage dérivée | ✅ | **VIVANT** |
| `scale_length_mm` | ✅ | ✅ | ✅ | `hand_span_mm → frettes` (T1.7) | ✅ | **VIVANT** |
| `cc_enabled` | ✅ | ✅ | ✅ | `CapabilityResolver.isStringCCAllowed` (+ **live depuis F-64**) | ✅ | **VIVANT** |
| `cc_string_*` / `cc_fret_*` (8 col.) | ✅ | ✅ bornes | ✅ | `TablatureConverter` | ⚠️ min/max/offset non testés | **VIVANT partiel** |
| `tab_algorithm` | ✅ | ⚠️ | ✅ | `TablatureConverter` | ⚠️ | **VIVANT** |
| `capo_fret` | ✅ (+ descripteur v2 `physical.capo`) | ✅ 0..36 | ❌ **backend** / ✅ **frontend** `HandPositionFeasibility` | — | ✅ (ce lot) | **INERTE ASSUMÉE + divergence → F-72** |
| `string_slider_enabled` | ✅ | ⚠️ | ❌ 🖥️ | `KeyboardSlider` | ❌ | **Classe B → F-74** |
| `string_sliding_system_enabled` | ✅ | ⚠️ | ❌ 🖥️ | `KeyboardPiano` (rangée coulissante) | ❌ | **Classe B → F-74** |
| `cc_bow_direction_number` | ✅ | ⚠️ | ❌ 🖥️ | `KeyboardChords` (barre d'archet) | ❌ | **Classe B → F-74** |
| `cc_bow_down_value` / `cc_bow_up_value` | ✅ | ⚠️ | ❌ 🖥️ | idem | ❌ | **Classe B → F-74** |

### 3.4 Preuve du trou de validation (base réelle)

Insertion directe, base fraîche, 34 migrations appliquées :

| Écriture | Résultat |
|---|---|
| `capabilities_source='descriptor'` | **refusée** — `CHECK constraint failed: capabilities_source` |
| `octave_mode='banana'` | **acceptée** |
| `scale_root=999` · `scale_root=-7` | **acceptées** |
| `descriptor_json='{not json'` | **acceptée** (pas de `json_valid`) |
| `gm_program=9999` | **acceptée** |
| `polyphony=-5` | **acceptée** |
| `comm_timeout=-1` | **acceptée** |
| `min_note_interval=-100` · `min_note_duration=-100` | **acceptées** |
| `sync_delay=999999` | **acceptée** |
| `instrument_type='not-a-type'` | **acceptée** |

Aucun `*.schemas.js` n'existe pour `instrument_*` / `voices` / `string`
(`ls src/api/commands/schemas/` → 14 fichiers, aucun instrument) : la validation
d'enveloppe reste **fail-open** (F-03, lot L01). Le durcissement impératif de
`InstrumentCapabilitiesDB` couvre `note_selection_mode`, `capabilities_source`,
`supported_ccs`, `selected_notes`, `polyphony` — **et rien d'autre**.

### 3.5 `midi_instrument_routings` — capacités de routage

| Colonne | Écrit | Validé | Lu par le moteur | Testé | Verdict |
|---|---|---|---|---|---|
| `device_id`, `target_channel`, `enabled` | ✅ | ⚠️ | ✅ `MidiPlayer.setChannelRouting` | ✅ | **VIVANT** |
| `transposition_applied` | ✅ | ⚠️ | ✅ | ✅ | **VIVANT** |
| `note_remapping` | ✅ | ⚠️ | ✅ `channelNoteRemapping` | ✅ | **VIVANT** |
| `split_mode` | ✅ | ⚠️ | ✅ `setChannelSplitRouting` | ✅ | **VIVANT** |
| `split_note_min` / `_max` | ✅ | ⚠️ | ✅ | ✅ | **VIVANT** |
| `split_polyphony_share` | ✅ | ⚠️ | ✅ `MidiPlayer:2469` (overflow) | ❌ **0 test** | **VIVANT non testé** |
| `overlap_strategy` | ✅ | ⚠️ | ✅ | ✅ | **VIVANT** |
| `hand_position_feasibility` | ✅ | ✅ | ✅ | ✅ | **VIVANT** |
| `hand_position_overrides` | ✅ | ✅ | ✅ | ✅ | **VIVANT** |
| `compatibility_score`, `auto_assigned`, `assignment_reason` | ✅ | ⚠️ | ⚠️ affichage | ✅ | **INFORMATIF** |
| `behavior_mode` | ✅ | ❌ | ❌ **relu par personne** (ni backend ni frontend) | ❌ | **MORTE FRANCHE → F-65** |

### 3.6 `hands_config` (JSON) — champ par champ

| Champ | Validé | Lu par le moteur | Verdict |
|---|---|---|---|
| `enabled`, `mode`, `mechanism` | ✅ | ✅ planners | **VIVANT** |
| `hands[].id`, `.cc_position_number` | ✅ | ✅ injection CC + `handCcs` (exemption `supported_ccs`) | **VIVANT** |
| `hands[].hand_span_semitones` | ✅ | ✅ `HandPositionPlanner` | **VIVANT** |
| `hands[].hand_span_frets` | ✅ | ✅ | **VIVANT** |
| `hands[].hand_span_mm` | ✅ | ✅ `LongitudinalPlanner` + conversion → frettes (T1.7) | **VIVANT** |
| `hands[].max_fingers` | ✅ | ✅ `LongitudinalPlanner` | **VIVANT** |
| `hand_move_*_per_sec`, `finger_move_mm_per_sec` | ✅ | ✅ | **VIVANT** |
| `assignment` (bandes) | ✅ | ✅ `HandAssigner` | **VIVANT** |
| `mechanism='independent_fingers(_5)'` | ✅ **rejeté** | ✅ planner lève | **EXPERIMENTAL honnête** (§9) |
| champs V1.5 (`fingers[]`, `anchor.*`, `cc_sample_rate_hz`) | — | ignorés + purgés par migration 011 | **retirés proprement** |

> `hands_config` est le **seul** bloc de capacités du projet où chaque champ
> écrit est effectivement consommé. C'est le modèle à répliquer.

---

## 4. Liste CLOSE des capacités mortes

**Classe A — mortes franches** (écrites/validées, relues par personne — blockers
« 100 % fonctionnel ») :

| # | Capacité | Où elle est écrite | Finding |
|---|---|---|---|
| A1 | `instruments_latency.descriptor_json` | **nulle part** — la colonne existe (mig. 033), aucun writer | F-67 |
| A2 | `instruments_latency.descriptor_revision` | **nulle part** (le `_descriptorRevisions` de `DeviceManager` est une `Map` mémoire) | F-67 |
| A3 | `midi_instrument_routings.behavior_mode` | `PlaybackAssignmentCommands:503` ; relu par 0 consommateur → **le réglage de split est perdu au rechargement** | F-65 |
| A4 | `instrument_voices.{min_note_interval, min_note_duration, supported_ccs, octave_mode, scale_root}` (5 colonnes) | `InstrumentVoiceCommands` / `ISMSave` ; `VoiceSelector` ne les nomme même pas | F-70 |

**Classe A′ — morte côté moteur, vivante côté UI** (l'utilisateur voit un effet,
mais la sortie MIDI d'un fichier n'est pas contrainte) :

| # | Capacité | Effet réel | Effet manquant | Finding |
|---|---|---|---|---|
| A′1 | `pitch_bend_enabled` | affiche/masque la molette de la vue clavier | **ne filtre pas** le pitch-bend d'un fichier vers un instrument qui le refuse | F-66 |

**Classe B — moteur aveugle par conception** (décision T1.3, à documenter, pas à
corriger) : `bagpipe_config`, `accordion_config`, `harmonica_config`,
`string_slider_enabled`, `string_sliding_system_enabled`, `cc_bow_direction_number`,
`cc_bow_down_value`, `cc_bow_up_value` → F-74 (leur seul défaut est de n'avoir
**aucun test**).

**Classe C — inertes assumées** : `capo_fret` (retiré du converter en 2026-04,
documenté `TablatureConverter.js:17-20`) → F-72 · valeur d'énumération
`capabilities_source='sysex'` (autorisée, jamais produite) → mentionnée en F-67.

**Donnée de référence morte** : `shared/gm-instrument-capabilities.json`
(128 entrées × `rangeMin/rangeMax/comfortMin/comfortMax/polyphony/monophonic`)
— seul `name` est consommé, par le frontend. `getGmDefaultPolyphony()` **n'a
aucun appelant**. → F-73.

---

## 5. Matrice par famille d'instruments (§I01–I08)

Le plan demande une suite par famille. Elle n'existe toujours pas ; voici, pour
la première fois, **famille × capacité × supportée × testée**.

Légende : ✅ supportée et testée · ⚠️ supportée, non testée · ❌ non supportée ·
— sans objet.

| # | Famille | Vue UI | Plage / notes discrètes | Polyphonie | Gamme (`octave_mode`) | Timing (`min_note_*`) | Mains | Config dédiée | Suite backend dédiée |
|---|---|---|---|---|---|---|---|---|---|
| I01 | Piano / clavier | `PianoView`, `PianoSliderView` | ✅ | ✅ | ✅ | ✅ | ✅ (semitones) | — | ❌ générique seulement |
| I02 | Guitare / basse / ukulélé | `FretboardView` | ✅ (+ plage **dérivée** du tuning, T1.2) | ✅ | ✅ | ✅ | ✅ (frets + mm) | ✅ `string_instruments` | ✅ `tablature-converter`, `string-instrument-scale-length`, `descriptor-strings` |
| I03 | Cordes frottées | `FretboardView` + barre d'archet | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ `cc_bow_*` **non lus par le moteur, 0 test** | ⚠️ partagée avec I02 |
| I04 | Harpe | `HarpView` | ⚠️ via `selected_notes` générique | ⚠️ | ⚠️ | ⚠️ | — | ❌ | ❌ **aucune** |
| I05 | Percussions / batterie | `DrumPadView`, `PercussionPadView` | ✅ discret + `DrumNoteMapper` | ✅ | — | ✅ | — | ✅ kits SF2 | ⚠️ `sf2-*` (62 % de couverture du mapper) |
| I06 | Accordéon | `AccordionView` | ⚠️ générique | ⚠️ | ⚠️ | ⚠️ | — | ⚠️ `accordion_config` **vue seule** | ⚠️ `instrument-settings-play-config-validation` (validation seule) |
| I07 | **Vents / cuivres** | `KeyboardWind`, `ListView` | ⚠️ générique | ❌ **monophonie non tenue** | ⚠️ | ⚠️ | — | ❌ | ⚠️ **ce lot** (constat figé) |
| I08a | Mailloches / vibra / marimba | `MalletView` | ⚠️ | ⚠️ | ⚠️ | ⚠️ | — | ❌ | ❌ **aucune** |
| I08b | Kalimba | `KalimbaView` | ✅ discret | ⚠️ | ✅ `scale_root` | ⚠️ | — | ❌ | ⚠️ `instrument-scale-root-db` |
| I08c | Steel drum | `SteelDrumView` | ⚠️ | ⚠️ | ✅ | ⚠️ | — | ❌ | ❌ **aucune** |
| I08d | Harmonica | `HarmonicaView` | ⚠️ | ⚠️ | ⚠️ | ⚠️ | — | ✅ `harmonica_config` (vue) | ✅ `harmonica-config-db` |
| I08e | Cornemuse | `BagpipeView` | ⚠️ | ⚠️ | ⚠️ | ⚠️ | — | ⚠️ `bagpipe_config` (vue) | ⚠️ validation seule |
| I08f | Boîte à musique | `MusicBoxView` | ⚠️ | ⚠️ | ⚠️ | ⚠️ | — | ❌ | ❌ **aucune** |
| I08g | Thérémine | `ThereminView` | ⚠️ | ⚠️ | ⚠️ | ⚠️ | — | ❌ | ❌ **aucune** |

**Familles sans aucune suite backend : harpe (I04), mailloches, steel drum,
boîte à musique, thérémine.** Recherche de mot-clé sur `tests/*.js` :
`harp` → 0, `mallet` → 0, `theremin` → 0, `music box` → 0.

### 5.1 I07 — le cas des vents, instruit

C'est le point que l'audit d'août désignait comme « à corriger en premier », et
il est **plus profond que prévu** : le projet **connaît** la monophonie des
vents et ne s'en sert pas.

- `shared/gm-instrument-capabilities.json` déclare `"monophonic": true` et
  `"polyphony": 1` pour 47 programmes GM (flûte 73, trompette 56, saxophones,
  basses…).
- `InstrumentTypeConfig.getGmDefaultPolyphony(73)` retourne bien `1`…
- …mais **cette fonction n'a aucun appelant** dans `src/`, et `.monophonic`
  n'est jamais lu (`/\.monophonic\b/` → 0 occurrence dans `src/`).
- Le moteur ne connaît donc que `instruments_latency.polyphony`, saisi à la
  main. **Un instrument à vent dont l'utilisateur n'a pas mis `polyphony=1`
  reçoit l'accord entier** — sur une mécanique, ce n'est pas une fausse note,
  c'est une électrovanne qui reçoit des ordres contradictoires.

Test livré (`l06-routing-adaptation-edges.test.js`) : le `NoteGate` laisse
passer les 4 notes d'un accord pour un « vent » sans polyphonie explicite, et ne
les bride qu'avec `polyphony=1` **saisi manuellement**. Le scoring, lui, pénalise
déjà correctement un canal polyphonique sur un instrument monophonique.

---

## 6. §G — Routage

### G01 — Routage manuel — PARTIAL · niveau 2

Inchangé depuis 2026-08-22 : 21 commandes `route_*` / `filter_*` / `channel_map`,
dont **13 sans schéma de payload** (F-03, L01). Pas de test combinatoire ni de
test de propriété. `MidiRouter.js` reste à **52,1 %** de couverture.

### G02 — Auto-routage — PARTIAL · niveau 3 *(branches ouvertes fermées)*

Les trois branches que le plan citait comme non testées le sont désormais
(`l06-routing-adaptation-edges.test.js`) :

| Cas | Comportement établi |
|---|---|
| **Aucun candidat** | le canal n'est pas assigné et apparaît dans `_autoSkipped` — **jamais** d'assignation fantôme |
| **Instrument absent** de `availableInstruments` | il ne peut structurellement pas être choisi (`_buildInstrumentList` ne le voit pas) |
| **Plusieurs candidats à égalité stricte** | départage **déterministe et reproductible** : le tri `b.score - a.score` est stable (ES2019), donc l'ordre d'entrée gagne — et cet ordre est le `ORDER BY name, custom_name` du SQL. **Déterministe mais implicite et non documenté → F-75** |

**Reste ouvert (H05)** : aucun corpus de référence « ce fichier ⇒ cet
instrument ». Les tests mesurent des propriétés du scoring, pas sa justesse.

### G03 — Split / conflits de canal — PARTIAL · niveau 3

| Cas | Comportement établi |
|---|---|
| Deux canaux, un seul instrument | passe 1 = exclusivité au canal le plus « rare » ; passe 2 = partage avec `sharedInstrumentPenalty` appliquée au score affiché et `sharedWith` renseigné dans **les deux** sens. Aucun canal auto-skippé. |
| Canal 9 (batterie) | **toujours servi en premier**, même avec un score inférieur (priorité codée en dur) |
| Propriété du note-off sous split | `MidiRouter` mémorise la hauteur réellement émise (`_activeRoutedNotes`) ; le gate live est vidé sur panic / déconnexion / suppression de route (tests existants) |

**Reste ouvert** : pas d'assertion globale « aucun doublon, aucune note perdue »
sur un fichier entier (le test de propriété recommandé en août).

### G04 — Hot-plug pendant la lecture — HW REQUIRED · niveau 0

Inchangé. `src/midi/devices` reste le module le moins couvert.

---

## 7. §H — Adaptation

### H01 — Repli de plage — **PASS** · niveau 4

Les trois cas limites que le plan réclamait sont fermés, **et la parité
live ↔ offline est démontrée sur les 128 notes** :

| Cas | Résultat |
|---|---|
| **Instrument à une seule note** (`min == max`) | les 128 notes convergent sur cette note, sans boucle infinie, **identique** entre `NoteEnforcement.foldIntoRange` (runtime) et `MidiTransposer.compressNoteToRange` (offline) |
| **Fichier entièrement hors plage** (notes 96-120 → plage 36-48) | aucune note ne sort de `[36,48]` ; runtime == offline sur les 25 notes |
| **Plage plus étroite qu'une octave** (60-66) | runtime == offline sur **les 128 notes** |
| **Plage mal configurée** (`min > max`) | la note est laissée intacte — pas de boucle, pas de valeur aberrante |

Ces quatre tests éteignent aussi une partie du risque §T3 (live ≠ baké) sur
l'axe « repli de plage ».

### H02 — Transposition / gamme — PARTIAL · niveau 3

- Les collisions de compression ont leur suite (`midi-transposer-compression-collisions`).
- **Nouveau garde-fou** : les tables d'intervalles backend (`ScaleSnapper.SCALE_INTERVALS`)
  et frontend (`InstrumentSettingsModal.OCTAVE_MODES`) sont **assertées
  identiques**, ainsi que l'absence de mode supplémentaire d'un côté ou de
  l'autre. La duplication était documentée (« keep in sync ») mais rien ne la
  gardait.
- **Gamme vide** : quand la plage ne contient aucun degré de la gamme
  (`scaleNotes(61,61,'pentatonic',0) === []`), `clampNote` **laisse la note
  intacte** — pas de repli sur une valeur arbitraire.
- **`selected_notes` entièrement hors plage** : le résultat reste dans
  `[min,max]` (correctif P3-d confirmé).
- **Trou** : `octave_mode` inconnu ⇒ snap silencieusement désactivé (F-68) ;
  scoring aveugle à `octave_mode` en mode `range` (F-69).

### H03 — Réduction de polyphonie — **PASS** · niveau 4

Politique **keep-outer** (garder grave + aigu, sacrifier la voix médiane)
vérifiée **identique** des deux côtés — c'est la fermeture de l'écart P3-b de
l'audit d'août :

- `NoteEnforcement.selectPolyphonyVictim([48,55,60,64,67]) === 60` ;
- côté offline, `MidiTransposer.transposeChannels` retire
  `sorted[floor(len/2)]` — même formule, assertée dans le test ;
- au plafond, une note **entrante médiane** est simplement bloquée ; une note
  **extrême** évince la médiane déjà tenue (avec émission du note-off).

### H04 — Percussions — PARTIAL · niveau 2

`DrumNoteMapper` : **62,2 % de statements**, la table GM de substitution n'est
toujours pas assertée explicitement. Inchangé depuis août.

### H05 — Scoring du matcher — PARTIAL · niveau 2

Toujours **aucun corpus de référence**. Ce lot ajoute deux mesures négatives
utiles : le scoring est **aveugle à `octave_mode`** en mode `range` (score
strictement identique avec et sans gamme — F-69), alors qu'en mode `discrete`
la restriction est bien vue et **fait chuter le score**.

### H06 — AutoAssigner — PARTIAL · niveau 3

Branches « aucun candidat / instruments identiques / conflit » fermées (§G02-G03).
Restent ouvertes : instruments insuffisants en nombre, plages qui se recouvrent,
mélange drum/non-drum, instruments hors ligne.

---

## 8. §I — Familles

Voir la matrice §5. **PARTIAL, niveau 1** — 5 familles sans aucune suite
backend, et la contrainte physique la plus dangereuse (monophonie des vents)
n'est tenue par personne (§5.1).

---

## 9. §J — Mains / faisabilité

| § | Composant | État | Preuve |
|---|---|---|---|
| J01 | `HandPositionPlanner` (601 l.) | **PASS** | 94,8 % stmts |
| J02 | `LongitudinalPlanner` (563 l.) | **PASS** | 89,8 % stmts |
| J03 | `InstrumentCapabilitiesValidator` (987 l.) | **PASS** | 87,2 % stmts, 100 % funcs |
| J03b | `HandAssigner` (N mains) | **PASS** | 95,7 % stmts |
| J04 | Injection / bake de CC de position | PARTIAL | suites existantes (dont double-injection) ; QA audio Pi restante |
| J05 | `independent_fingers` | **EXPERIMENTAL — honnêteté vérifiée** | ci-dessous |

### J05 — `independent_fingers` : l'auto-déclaration est honnête

Vérifié sur les **quatre** points où le mécanisme V2 pourrait fuiter :

| Barrière | Comportement | Testé ici |
|---|---|---|
| `HandPositionPlanner` (mode frets) | **lève** `mechanism "independent_fingers" is reserved for V2` | ✅ |
| `InstrumentCapabilitiesValidator` mode `frets` | rejette `independent_fingers` avec un motif contenant « V2 » | ✅ |
| `InstrumentCapabilitiesValidator` mode `semitones` | rejette `independent_fingers_5`, même motif | ✅ |
| UI | carte grisée, non cliquable (`ISMSections.js:1739, 2489`) | — |
| Non-régression | un mécanisme V1 (`string_sliding_fingers`) passe : le refus est bien ciblé | ✅ |

**Verdict : EXPERIMENTAL correctement auto-déclaré.** Une seule réserve
cosmétique : `KeyboardSlider.js:17` traite `independent_fingers` comme un
mécanisme autorisant le bend — le frontend accepte un mécanisme que le backend
refuse. Sans effet aujourd'hui (le mécanisme ne peut pas être persisté), mais à
aligner lors de la V2.

### J — `hand_span_mm` → frettes (T1.7)

Confirmé vivant : `scale_length_mm` est joint aux capacités par
`getInstrumentsWithCapabilities`, converti en frettes par
`_scoreHandPositionFeasibility` (repli 648 mm), et l'avertissement de shift
n'est plus sauté. Suite `instrument-matcher-hand-feasibility` verte.

---

## 10. Points chauds de la roadmap v0.9 — re-statut avec preuve

### 10.1 T1.1 — Voix GM multiples

| Sous-point | État | Preuve |
|---|---|---|
| (a) QA audio sur Pi | **HW REQUIRED** | hors sandbox |
| **(b) Injection de voix sur le route-through live** | **FAIL — non implémenté** | `grep -n "Voice\|planVoiceProgramChanges" src/midi/routing/MidiRouter.js` → aucune occurrence fonctionnelle. `MidiRouter` applique le clamp, le `NoteGate` et le filtre CC, **jamais** de `programChange` par voix. → **F-71** |
| **(c) `voices_share_notes` exposé dans l'UI réglages** | **PASS — il l'est** | case à cocher `#voicesShareNotesCheckbox`, `ISMSections.js:871` ; libellé + hint i18n (`instrumentSettings.voicesShareNotes*`) ; lecture `ISMListeners.js:1242-1254` ; sauvegarde `ISMSave.js:169-174, 418`. Affichée uniquement quand il existe des voix GM secondaires sur un primaire non-drum / non-cordes. |

**Conception proposée pour (b)** (non implémentée — hors du périmètre « petit,
local, prouvé ») : à l'entrée de `_sendAndEmit`, sur un note-on non-drum,
résoudre `voices_share_notes` + `listVoices(dest, channel)` via un cache
`CapabilityResolver` (invalidé sur `instrument_settings_changed` /
`instruments_configured`), appeler `selectVoiceProgram({note, primaryProgram,
voices, sharesNotes:false})`, et n'émettre un `programChange` que si le programme
diffère de celui déjà actif sur `dest:channel` (état à ajouter à côté de
`_activeRoutedNotes`, purgé par `resetNoteGate`). No-op strict si
`voices_share_notes = 1`. **Le coût réel est le cache** : `getTimingConstraints`
n'expose ni `voices_share_notes` ni la liste des voix ; il faut les y ajouter,
ce qui touche `CapabilityResolver` **et** `PlaybackSnapshot` (donc L05).

### 10.2 T1.8 — Pipeline descripteur v2 : **le bloqueur est levé**

**Constat 1 — le refus est réel.** Sur une base fraîche :

```
UPDATE instruments_latency SET capabilities_source='descriptor'
→ SqliteError: CHECK constraint failed: capabilities_source IN ('manual','sysex','auto')
```

`DescriptorProtocol.js:239-243` documente le contournement (`'auto'` écrit à la
place). Confirmé.

**Constat 2 — le rebuild est faisable proprement.** Conditions vérifiées sur la
base réelle :

- `instruments_latency` est **cible d'aucune clé étrangère** (`PRAGMA
  foreign_key_list` sur les 32 tables : 0 référence entrante) ; elle n'est que
  *fille* de `devices` et `custom_sf2`.
- Objets à recréer : **11 index + 2 triggers**, aucune vue.
- Le runner (`DatabaseLifecycle.runSingleMigration`) exécute le fichier entier
  dans un `BEGIN`/`COMMIT` ; un `PRAGMA foreign_keys=OFF` dans le fichier serait
  **sans effet** (pragma ignoré en transaction) — **ce n'est pas un problème
  ici** puisque la table n'a pas de fille.

**Résultat de l'exécution** (mêmes sémantiques que le runner, base avec données,
dont une ligne volontairement sale `octave_mode='banana'`, `scale_root=999`) :

```
MIGRATION OK in 4 ms
rows before/after: 2 2
fk_check: []          integrity_check: ok
indexes: 11           triggers: 2
normalisation: 'banana' → 'chromatic' ; 999 → 3
AFTER: capabilities_source='descriptor' ACCEPTÉ ; 'bogus' toujours REFUSÉ
trigger de confiance OK (0.5) ; cascade DELETE devices → 0 instrument
```

**SQL de la migration à créer (`migrations/035_capabilities_source_descriptor.sql`)**
— *non créée par ce lot, conformément à la règle ; elle referme du même geste
les trous de validation F-68 et F-67* :

```sql
-- 035_capabilities_source_descriptor.sql
-- Élargit instruments_latency.capabilities_source à 'descriptor'.
-- SQLite ne sait pas ALTER une contrainte CHECK : la table doit être rebâtie.
-- Aucune FK n'ENTRE dans instruments_latency → create/copy/drop/rename est sûr ;
-- les 11 index et 2 triggers sont recréés après (DROP TABLE les supprime).
-- Au passage : gardes manquantes sur octave_mode, scale_root, descriptor_json.

CREATE TABLE instruments_latency_new (
    id                       TEXT PRIMARY KEY NOT NULL,
    device_id                TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    channel                  INTEGER NOT NULL CHECK(channel BETWEEN 0 AND 15),
    name                     TEXT NOT NULL DEFAULT 'Unnamed Instrument',
    custom_name              TEXT,
    instrument_type          TEXT DEFAULT 'unknown',
    instrument_subtype       TEXT,
    mac_address              TEXT,
    usb_serial_number        TEXT,
    sync_delay               INTEGER DEFAULT 0,
    avg_latency              INTEGER DEFAULT 0 CHECK(avg_latency BETWEEN 0 AND 1000000),
    min_latency              INTEGER DEFAULT 0 CHECK(min_latency >= 0),
    max_latency              INTEGER DEFAULT 0 CHECK(max_latency >= 0),
    jitter                   REAL DEFAULT 0.0,
    std_deviation            REAL DEFAULT 0.0,
    measurement_count        INTEGER DEFAULT 0,
    measurement_history      TEXT CHECK(measurement_history IS NULL OR json_valid(measurement_history)),
    calibration_confidence   REAL DEFAULT 0.0 CHECK(calibration_confidence BETWEEN 0.0 AND 1.0),
    calibration_method       TEXT DEFAULT 'manual' CHECK(calibration_method IN ('manual', 'sysex')),
    last_calibration         TEXT,
    sysex_manufacturer_id    TEXT,
    sysex_family             TEXT,
    sysex_model              TEXT,
    sysex_version            TEXT,
    sysex_device_id          TEXT,
    sysex_raw_response       TEXT,
    sysex_last_request       TEXT,
    note_range_min           INTEGER CHECK(note_range_min IS NULL OR note_range_min BETWEEN 0 AND 127),
    note_range_max           INTEGER CHECK(note_range_max IS NULL OR note_range_max BETWEEN 0 AND 127),
    supported_ccs            TEXT CHECK(supported_ccs IS NULL OR json_valid(supported_ccs)),
    note_selection_mode      TEXT DEFAULT 'range' CHECK(note_selection_mode IN ('range', 'discrete')),
    selected_notes           TEXT CHECK(selected_notes IS NULL OR json_valid(selected_notes)),
    capabilities_source      TEXT DEFAULT 'manual'
        CHECK(capabilities_source IN ('manual', 'sysex', 'auto', 'descriptor')),
    capabilities_updated_at  TEXT,
    gm_program               INTEGER,
    polyphony                INTEGER DEFAULT 16,
    octave_mode              TEXT DEFAULT 'chromatic'
        CHECK(octave_mode IS NULL OR octave_mode IN ('chromatic', 'diatonic', 'pentatonic')),
    comm_timeout             INTEGER DEFAULT 5000,
    midi_clock_enabled       BOOLEAN DEFAULT 0,
    min_note_interval        INTEGER,
    min_note_duration        INTEGER,
    enabled                  BOOLEAN NOT NULL DEFAULT 1,
    created_at               TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
    hands_config             TEXT CHECK (hands_config IS NULL OR json_valid(hands_config)),
    voices_share_notes       INTEGER NOT NULL DEFAULT 1 CHECK (voices_share_notes IN (0, 1)),
    omni_mode                INTEGER NOT NULL DEFAULT 0 CHECK (omni_mode IN (0, 1)),
    custom_sf2_id            INTEGER REFERENCES custom_sf2(id) ON DELETE SET NULL,
    bagpipe_config           TEXT CHECK (bagpipe_config IS NULL OR json_valid(bagpipe_config)),
    accordion_config         TEXT CHECK (accordion_config IS NULL OR json_valid(accordion_config)),
    harmonica_config         TEXT CHECK (harmonica_config IS NULL OR json_valid(harmonica_config)),
    lighting_enabled         INTEGER NOT NULL DEFAULT 0 CHECK (lighting_enabled IN (0, 1)),
    scale_root               INTEGER DEFAULT 0 CHECK (scale_root IS NULL OR scale_root BETWEEN 0 AND 11),
    descriptor_revision      INTEGER,
    descriptor_json          TEXT CHECK (descriptor_json IS NULL OR json_valid(descriptor_json)),
    pitch_bend_enabled       INTEGER NOT NULL DEFAULT 0 CHECK (pitch_bend_enabled IN (0, 1))
);

INSERT INTO instruments_latency_new
SELECT
    id, device_id, channel, name, custom_name, instrument_type, instrument_subtype,
    mac_address, usb_serial_number, sync_delay, avg_latency, min_latency, max_latency,
    jitter, std_deviation, measurement_count, measurement_history, calibration_confidence,
    calibration_method, last_calibration, sysex_manufacturer_id, sysex_family, sysex_model,
    sysex_version, sysex_device_id, sysex_raw_response, sysex_last_request,
    note_range_min, note_range_max, supported_ccs, note_selection_mode, selected_notes,
    capabilities_source, capabilities_updated_at, gm_program, polyphony,
    CASE WHEN octave_mode IN ('chromatic','diatonic','pentatonic') THEN octave_mode
         WHEN octave_mode IS NULL THEN NULL
         ELSE 'chromatic' END,
    comm_timeout, midi_clock_enabled, min_note_interval, min_note_duration, enabled,
    created_at, updated_at, hands_config, voices_share_notes, omni_mode, custom_sf2_id,
    bagpipe_config, accordion_config, harmonica_config, lighting_enabled,
    CASE WHEN scale_root BETWEEN 0 AND 11 THEN scale_root
         WHEN scale_root IS NULL THEN NULL
         ELSE ((scale_root % 12) + 12) % 12 END,
    descriptor_revision,
    CASE WHEN descriptor_json IS NULL OR json_valid(descriptor_json) THEN descriptor_json
         ELSE NULL END,
    pitch_bend_enabled
FROM instruments_latency;

DROP TABLE instruments_latency;
ALTER TABLE instruments_latency_new RENAME TO instruments_latency;

CREATE INDEX IF NOT EXISTS idx_instruments_device             ON instruments_latency(device_id);
CREATE INDEX IF NOT EXISTS idx_instruments_device_channel     ON instruments_latency(device_id, channel);
CREATE INDEX IF NOT EXISTS idx_instruments_channel            ON instruments_latency(channel);
CREATE INDEX IF NOT EXISTS idx_instruments_enabled            ON instruments_latency(enabled) WHERE enabled = 1;
CREATE INDEX IF NOT EXISTS idx_instruments_confidence         ON instruments_latency(calibration_confidence DESC);
CREATE INDEX IF NOT EXISTS idx_instruments_last_calibration   ON instruments_latency(last_calibration DESC);
CREATE INDEX IF NOT EXISTS idx_instruments_latency_mac        ON instruments_latency(mac_address);
CREATE INDEX IF NOT EXISTS idx_instruments_latency_usb_serial ON instruments_latency(usb_serial_number);
CREATE INDEX IF NOT EXISTS idx_instruments_type               ON instruments_latency(instrument_type);
CREATE INDEX IF NOT EXISTS idx_instruments_type_subtype       ON instruments_latency(instrument_type, instrument_subtype);
CREATE INDEX IF NOT EXISTS idx_instruments_omni               ON instruments_latency(omni_mode) WHERE omni_mode = 1;

CREATE TRIGGER IF NOT EXISTS trg_instruments_latency_update
AFTER UPDATE ON instruments_latency
FOR EACH ROW
BEGIN
    UPDATE instruments_latency SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_instruments_latency_confidence
AFTER UPDATE OF measurement_count ON instruments_latency
FOR EACH ROW
WHEN NEW.measurement_count > OLD.measurement_count
BEGIN
    UPDATE instruments_latency
    SET calibration_confidence = CASE
        WHEN NEW.measurement_count * 0.05 > 1.0 THEN 1.0
        ELSE NEW.measurement_count * 0.05
    END
    WHERE id = NEW.id;
END;

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (35, 'capabilities_source accepts descriptor; octave_mode/scale_root/descriptor_json guarded');
```

**Après la migration**, trois lignes suffisent à consommer la valeur :
`InstrumentCapabilitiesDB.js:113` → `['manual','sysex','auto','descriptor']` ;
`DescriptorProtocol.descriptorToCapabilities(inst, 'descriptor')` ;
`DescriptorService` (commentaire l. 41 à retirer).

**Le reste de T1.8 n'est PAS débloqué par cette migration** et reste ouvert :
persistance DB du cache descripteur (**les colonnes existent, aucun writer** —
F-67), descripteur précédent pour le diff §6, persistance des surcharges
utilisateur, chemin HTTP, modélisation du lookahead `timing.prepare`.

### 10.3 `capo_fret` — choix assumé **confirmé**, avec une divergence à traiter

- **Backend : inerte, volontairement.** Documenté `TablatureConverter.js:17-20`
  (« Capo support was removed in 2026-04 … transposed at the source instead »).
  Vérifié par test : `effectiveTuning` et `stringRanges` sont **strictement
  identiques** avec `capo_fret=5` et `capo_fret=0`. **Ce n'est pas une
  régression.**
- **Mais le frontend, lui, l'applique.**
  `public/js/features/auto-assign/HandPositionFeasibility.js:1479-1480` lit
  `instrument.capo_fret` et calcule `fret = note - tuning[s] - capoFret`
  (l. 1572, 1886). La **simulation de faisabilité affichée à l'utilisateur**
  n'utilise donc pas la même géométrie que la conversion réelle.
- **Aujourd'hui sans effet visible** : tous les chemins UI écrivent
  `capo_fret: 0` en dur (`ISMSave.js:267`, `ISMListeners.js:96,152`,
  `InstrumentCapabilitiesModal.js:516`).
- **Mais le descripteur v2 peut le rendre non nul** :
  `DescriptorProtocol.js:360` mappe `physical.capo → capo_fret`. Dès que T1.8
  sera câblé, un instrument qui déclare un capo créera l'incohérence.
  → **F-72**, à traiter **avant** la fin de T1.8.

---

## 11. Findings F-64 → F-75

| # | Sév. | Titre | Preuve | État |
|---|---|---|---|---|
| **F-64** | **P2** | **Divergence live ↔ fichier sur les CC 20/21 (tablature)** | `MidiRouter._enforceLiveLimits` soumettait CC20/21 au filtre `supported_ccs` et **ignorait** la porte cordes, là où `PlaybackScheduler` fait l'inverse. Deux effets : (a) un instrument à cordes déclarant `supported_ccs=[1,7,11]` voyait ses CC d'actionneur **supprimés en jeu live** → doigts mécaniques figés ; (b) un instrument **non-cordes** recevait des CC20/21 que le playback filtre. | ✅ **CORRIGÉ** (§12) |
| **F-65** | **P2** | `midi_instrument_routings.behavior_mode` : capacité morte, réglage perdu | Écrit par `PlaybackAssignmentCommands.js:503`, relu par `RoutingPersistenceDB.js:251` et **par personne d'autre** (`grep behavior_mode public/js/ src/api/ src/repositories/` → 0). `MidiPlayer.setChannelSplitRouting` ne le lit pas. L'utilisateur choisit « overflow »/« alternate », ça s'applique à la requête, **puis c'est perdu au rechargement** (le frontend repart sur `defaultMode='combineNoOverlap'`, `RoutingSummaryPage.js:2732`). | Ouvert |
| **F-66** | **P2** | `pitch_bend_enabled` n'est jamais lu par le moteur | `grep pitch_bend src/midi/` → 0. `PlaybackScheduler:1133` et `MidiRouter` transmettent le pitch-bend inconditionnellement. La colonne ne pilote que la molette de la vue clavier. Un fichier avec pitch-bend l'envoie à un instrument mécanique qui déclare ne pas le gérer. | Ouvert |
| **F-67** | **P2** | Cache descripteur v2 : colonnes créées, **aucun writer, aucun lecteur** | `descriptor_json` / `descriptor_revision` (mig. 033) : `grep` sur tout `src/` → 0 occurrence. Le cache ne survit donc pas au redémarrage et le diff §6 n'a pas de descripteur précédent. S'y ajoutent : pas de `json_valid` sur `descriptor_json`, et la valeur d'énum `capabilities_source='sysex'` n'est **produite par aucun writer**. | Ouvert (partie de T1.8) |
| **F-68** | **P2** | `octave_mode` / `scale_root` : **aucune validation**, une faute de frappe désactive la gamme en silence | Base réelle : `octave_mode='banana'`, `scale_root=999`, `scale_root=-7` **acceptés**. `ScaleSnapper.restrictsScale()` renvoie `false` pour un mode inconnu → l'instrument redevient chromatique. Test : une note hors gamme ressort **inchangée** (61 → 61) au lieu d'être snappée. Six autres colonnes sans garde : `gm_program`, `polyphony`, `comm_timeout`, `min_note_interval`, `min_note_duration`, `instrument_type`. | Ouvert |
| **F-69** | **P2** | Le scoring d'auto-assignation est aveugle à `octave_mode` en mode `range` | `getInstrumentsWithCapabilities()` ne projette ni `octave_mode` ni `scale_root`. Test : `calculateCompatibility` renvoie **exactement le même score** pour un instrument pentatonique et pour le même instrument chromatique ; en mode `discrete` la restriction est vue et fait baisser le score. Tout writer non-UI (descripteur v2, API, éditeur auto-assign) qui pose une gamme sans la matérialiser en `selected_notes` obtient donc une **surnotation**. | Ouvert |
| **F-70** | **P2** | `instrument_voices` : 5 colonnes par voix écrites, validées, **jamais lues** | `min_note_interval`, `min_note_duration`, `supported_ccs`, `octave_mode`, `scale_root`. `VoiceSelector.js` ne contient **aucune** de ces chaînes (test statique). `INSTRUMENT_FAMILY_REFACTOR_ROADMAP.md` Phase 8 tâche 4 les exige explicitement. | Ouvert |
| **F-71** | **P2** | T1.1(b) — le route-through live n'injecte pas les program-changes par voix | `MidiRouter` n'importe ni `VoiceSelector` ni `planVoiceProgramChanges`. Un instrument multi-voix joué **en direct** reste sur son programme primaire, alors que le même instrument joué **depuis un fichier** commute correctement (`MidiPlayer._injectVoiceProgramChangeEvents`). Divergence live ↔ fichier. Conception en §10.1. | Ouvert |
| **F-72** | **P3** | `capo_fret` : inertie backend assumée, mais le frontend applique le capo | Backend : `effectiveTuning` identique avec/sans capo (test). Frontend : `HandPositionFeasibility.js:1479-1480, 1572, 1886` soustrait `capoFret`. Sans effet tant que l'UI écrit `0` en dur — **mais `DescriptorProtocol.js:360` mappe `physical.capo → capo_fret`**, donc T1.8 va rendre la divergence réelle. | Ouvert |
| **F-73** | **P2** | `shared/gm-instrument-capabilities.json` : donnée de référence morte ⇒ **aucune monophonie de famille (I07)** | 128 entrées × `rangeMin/rangeMax/comfortMin/comfortMax/polyphony/monophonic` ; seul `name` est consommé (frontend). `getGmDefaultPolyphony()` **n'a aucun appelant** dans `src/` ; `/\.monophonic\b/` → 0. Conséquence : un instrument à vent sans `polyphony=1` saisi à la main **reçoit l'accord entier** (test). Une suite Vitest garde la parité d'une donnée que personne ne lit. | Ouvert |
| **F-74** | **P3** | Cordes : 5 colonnes invisibles du moteur et **sans aucun test** | `string_slider_enabled`, `string_sliding_system_enabled`, `cc_bow_direction_number`, `cc_bow_down_value`, `cc_bow_up_value` : 0 occurrence dans `src/midi/`, 0 test. Ce sont des capacités de **jeu live** (barre d'archet, rangée coulissante) — légitimes, mais ni documentées comme telles ni testées, et l'archet est le seul geste **mécanique** de la famille I03. | Ouvert |
| **F-75** | **P3** | Départage des ex æquo d'auto-assignation : déterministe mais **implicite** | `scores.sort((a,b) => b.score - a.score)` : à score strictement égal, le gagnant est le premier de `availableInstruments`, c'est-à-dire l'ordre `ORDER BY name, custom_name` du SQL, via la stabilité du tri ES2019. Reproductible (test), mais aucune ligne de code ni de doc ne l'énonce : un `ORDER BY` modifié changerait silencieusement les assignations. | Ouvert (test ajouté) |

**Répartition : 0 P0 · 0 P1 · 8 P2 (dont 1 corrigé) · 4 P3.**

---

## 12. Correctif appliqué dans ce lot

### F-64 — parité des CC de tablature entre le chemin live et le chemin fichier

**Fichier :** `src/midi/routing/MidiRouter.js`, méthode `_enforceLiveLimits`
(zone autorisée `src/midi/routing/**`). **~12 lignes.**

```js
if (type === DEVICE_MSG_TYPES.CC && out.controller != null) {
+  // CC20/21 (string/fret select) are the tablature actuator protocol: they
+  // have their OWN gate (a string instrument with `cc_enabled`) and are
+  // exempt from `supported_ccs`, exactly as in PlaybackScheduler. […]
+  if (out.controller === MIDI_CC.STRING_SELECT || out.controller === MIDI_CC.FRET_SELECT) {
+    if (typeof resolver.isStringCCAllowed !== 'function') return true;
+    return resolver.isStringCCAllowed(dest, out.channel) === true;
+  }
   const constraints = resolver.getTimingConstraints(dest, out.channel);
   const list = constraints?.supportedCcs;
   …
```

**Preuve rouge → vert.** `tests/audit/l06-live-vs-playback-cc-parity.test.js`
injecte le **même** CC dans les deux runtimes avec le **même** resolver bouchon
et exige une décision identique.

- Avant : `Tests: 4 failed, 5 passed` — les 4 échecs sont **tous** du côté live
  (les assertions `playbackSendsCC` passaient déjà : le scheduler est la
  référence).
- Après : `Tests: 9 passed`.
- Non-régression : `tests/midi-router-*`, `note-enforcement`,
  `transport-input-routing`, `playback-scheduler-*`, `capability-resolver`,
  `voice-selector`, `tablature-converter`, `instrument-capabilities-validator*`,
  `hand-position-planner`, `longitudinal-planner`, `instrument-matcher*`
  → **27 suites / 378 tests verts**.
- `eslint` : 0 erreur · `prettier --check` : conforme (formatage appliqué **aux
  seuls fichiers touchés**) · `tsc --noEmit` : aucune erreur sur
  `src/midi/routing` ni sur `tests/audit/l06*`.

> ⚠️ **Changement de comportement live à faire valider en QA Pi (T9)**, au même
> titre que T1.5 : un CC20/21 envoyé en direct à une destination **non-cordes**
> (ou dont `cc_enabled=0`) est désormais **filtré**, comme il l'était déjà en
> lecture de fichier.

---

## 13. Recommandations

### 13.1 Blockers « 100 % fonctionnel » — à fermer pour la v0.9

| Pri | Action | Finding | Où |
|---|---|---|---|
| **P2** | Créer `migrations/035_*.sql` (SQL prêt en §10.2, **exécuté et vérifié**) puis passer `ALLOWED_CAP_SOURCES` à 4 valeurs et `descriptorToCapabilities(inst,'descriptor')` | F-67, F-68 | `migrations/`, `InstrumentCapabilitiesDB.js:113`, `DescriptorProtocol.js:248` |
| **P2** | Persister le cache descripteur (`descriptor_json`, `descriptor_revision`) ou **supprimer les deux colonnes** | F-67 | `DescriptorService`, mig. |
| **P2** | Relire `behavior_mode` dans `setChannelSplitRouting` et le renvoyer au frontend au chargement — ou retirer la colonne et le sélecteur UI | F-65 | `MidiPlayer.js:2214`, `RoutingSummaryPage` |
| **P2** | Consommer `pitch_bend_enabled` : l'exposer dans `getTimingConstraints`, filtrer `PITCH_BEND` dans `PlaybackScheduler` **et** `MidiRouter` (défaut permissif si non déclaré, comme `supported_ccs`) | F-66 | `CapabilityResolver` + L05 |
| **P2** | Livrer la Phase 8 tâche 4 : timings par voix, ou **documenter** que les colonnes par voix sont frontend-only et les retirer du schéma | F-70 | `VoiceSelector`, `MidiPlayer` |
| **P2** | Câbler `getGmDefaultPolyphony()` comme **défaut** quand `polyphony` est absent → la monophonie des vents devient effective (I07) | F-73 | `InstrumentCapabilitiesDB.getInstrumentCapabilities` / `CapabilityResolver` |
| **P2** | T1.1(b) : injection de voix sur le route-through live (conception §10.1) | F-71 | `MidiRouter` + `CapabilityResolver` |
| **P2** | Projeter `octave_mode` / `scale_root` dans `getInstrumentsWithCapabilities` et les prendre en compte dans `scoreNoteCompatibility` | F-69 | `InstrumentCapabilitiesDB.js:456`, `InstrumentMatcher` |

### 13.2 Diff exact proposé (fichier partagé — **non appliqué**)

`src/persistence/tables/InstrumentCapabilitiesDB.js` (hors zone d'édition du lot) :

```diff
-      const ALLOWED_CAP_SOURCES = ['manual', 'sysex', 'auto'];
+      const ALLOWED_CAP_SOURCES = ['manual', 'sysex', 'auto', 'descriptor'];
```

```diff
+      const ALLOWED_OCTAVE_MODES = ['chromatic', 'diatonic', 'pentatonic'];
+      if (
+        capabilities.octave_mode != null &&
+        !ALLOWED_OCTAVE_MODES.includes(capabilities.octave_mode)
+      ) {
+        throw new Error(`octave_mode must be one of: ${ALLOWED_OCTAVE_MODES.join(', ')}`);
+      }
```

*(à appliquer **après** la migration 035, sinon l'écriture `'descriptor'`
casserait sur la `CHECK`.)*

### 13.3 Tests manquants (par ordre de valeur)

| Pri | Test | Couvre |
|---|---|---|
| P1 | **Corpus de référence** `tests/fixtures/golden/` : 8-12 fichiers + jeu d'instruments figé + gagnant attendu + sortie adaptée attendue | H05, E05, BN, ancre BM — **la recommandation P1 d'août, toujours ouverte** |
| P2 | Suite « vents » : monophonie de bout en bout (fichier → sortie), après F-73 | I07 |
| P2 | Suites harpe / mailloches / steel drum / boîte à musique / thérémine : note injouable ⇒ rejetée ou snappée | I04, I08a/c/f/g |
| P2 | Test de propriété du routage : jeux de routes aléatoires ⇒ `count(NoteOn) == count(NoteOff)` par (device, canal, note), aucune note livrée deux fois | G01, G03 |
| P2 | `omni_mode` (0 test) et `split_polyphony_share` (0 test) : deux capacités **vivantes** sans filet | §3.1, §3.5 |
| P3 | Table GM de substitution des percussions assertée explicitement | H04 |
| P3 | `cc_string_min/max/offset`, `cc_fret_min/max/offset` : bornes et décalage | §3.3 |

### 13.4 Nettoyage de surface (T7)

- Retirer `capo_fret` du schéma **et** de `HandPositionFeasibility.js`, ou le
  réimplémenter des deux côtés — **avant** la fin de T1.8 (F-72).
- Retirer la valeur d'énum `'sysex'` de `capabilities_source` si aucun writer
  n'est prévu.
- Corriger le commentaire périmé `ISMSave.js:284` (« The playback/adaptation
  pipeline ignores `octave_mode` entirely ») : c'est faux depuis T1.4/P2-5.
- Aligner `KeyboardSlider.js:17` (accepte `independent_fingers`) sur le refus
  backend.

---

## 14. Reproduction

```bash
# Les trois suites de ce lot
node --experimental-vm-modules node_modules/jest/bin/jest.js tests/audit/l06

# Non-régression du voisinage
node --experimental-vm-modules node_modules/jest/bin/jest.js \
  tests/audit/l06 tests/midi-router tests/note-enforcement \
  tests/transport-input-routing tests/playback-scheduler \
  tests/capability-resolver tests/voice-selector tests/tablature-converter \
  tests/instrument-capabilities-validator tests/hand-position-planner \
  tests/longitudinal-planner tests/instrument-matcher
# → 27 suites / 378 tests verts

# Couverture du périmètre
node --experimental-vm-modules node_modules/jest/bin/jest.js --coverage \
  --collectCoverageFrom='src/midi/routing/**/*.js' \
  --collectCoverageFrom='src/midi/adaptation/**/*.js' \
  --collectCoverageFrom='src/midi/instrument/**/*.js'
```

### Fichiers créés / modifiés par ce lot

| Fichier | Nature |
|---|---|
| `docs/audit/2026-09-07/06_ROUTING_ADAPTATION.md` | ce rapport |
| `tests/audit/l06-capability-matrix.test.js` | 15 tests — preuves de la matrice (base SQLite réelle, capacités mortes, trous de validation) |
| `tests/audit/l06-live-vs-playback-cc-parity.test.js` | 9 tests — **rouge → vert** du correctif F-64 |
| `tests/audit/l06-routing-adaptation-edges.test.js` | 20 tests — cas limites §G/H/I/J |
| `src/midi/routing/MidiRouter.js` | **correctif F-64** (+ formatage Prettier du seul fichier touché) |

Aucun fichier partagé modifié (`package.json`, `config.json`, `jest.config.cjs`,
CI, `CLAUDE.md`, `migrations/*`). **Aucune migration créée** — le SQL vérifié est
en §10.2. Aucune commande `git`, aucun `npm install`.
