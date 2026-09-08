# Vague 3 — R14 & R15 · Capacités mortes : câbler, retirer, ou assumer

**Lot :** R14 (`is_fretless` détruit à chaque enregistrement — F-140, P1) et
R15 (la liste CLOSE des capacités mortes de
[`06_ROUTING_ADAPTATION.md`](06_ROUTING_ADAPTATION.md) §4).
**Date :** 2026-09-08. **Base :** 207 suites / 2 821 tests (Jest) ·
86 fichiers / 1 560 tests (Vitest).

> **Principe directeur.** Une capacité morte laissée en place est un mensonge à
> l'utilisateur. Pour chacune, deux réponses honnêtes : **la câbler**, ou
> **retirer le réglage de l'UI et documenter la colonne comme abandonnée**.
> Laisser en l'état n'en est pas une. Quand aucune des deux n'était possible
> dans le périmètre de ce lot, c'est dit explicitement — pas maquillé.

---

## 1. Décision produit du mainteneur : le capo est abandonné

**Le capo ne sera pas implémenté dans ce projet.** `capo_fret` n'a donc pas été
câblé ; c'est au contraire toute la surface qui laissait croire qu'il existait
qui a été retirée. Le backend le traitait déjà comme volontairement inerte
depuis 2026-04 (`TablatureConverter.js` §en-tête, « transposé à la source ») —
seul le **frontend** l'appliquait encore, et c'est exactement la divergence
client/serveur que L06 signalait en F-72.

Ce qui a été retiré, exhaustivement :

| Surface | Fichier | État |
|---|---|---|
| Application réelle du capo (le seul endroit du dépôt qui le faisait) | `public/js/features/auto-assign/HandPositionFeasibility.js:1479-1660, 1849-1886` | ✅ retirée — `fret = note − tuning[string]`, comme le moteur |
| Envoi `capo_fret: 0` en dur | `public/js/features/instrument-settings/ISMSave.js` | ✅ retiré du payload |
| Défauts de config du modal | `ISMListeners.js:96,152` | ✅ retirés |
| Envoi `capo_fret: 0` du modal Capacités | `public/js/features/InstrumentCapabilitiesModal.js:516` | ✅ retiré |
| Texte d'aide « (capo inclus) » | `ISMSections.js` + clé `instrumentSettings.handsFretsCcPositionHint` **dans les 28 locales** | ✅ parenthèse retirée, clé conservée (elle est vivante) |
| Clés i18n orphelines `stringInstrument.capoFret`, `stringInstrument.noCapo`, `tablature.capo` | **28 locales** | ✅ supprimées partout (0 manquante / 0 en trop) |
| Validation WS `capo_fret` | `src/api/commands/schemas/string_instrument.schemas.js` | ✅ règle retirée (un client ancien qui l'envoie reste accepté, le champ est ignoré) |
| Forwarding `data.capo_fret` | `src/api/commands/StringInstrumentCommands.js` (create, update, create_from_preset) | ✅ retiré |
| Forwarding `si.capo_fret` | `src/api/commands/InstrumentSettingsCommands.js:778` | ✅ retiré |
| INSERT / ON CONFLICT / UPDATE partiel / validateur / projection de lecture | `src/persistence/tables/StringInstrumentDatabase.js` | ✅ retirés — la colonne prend son `DEFAULT 0` |
| Mapping `physical.capo → capo_fret` | `src/midi/instrument/DescriptorProtocol.js:360` | ✅ retiré — F-72 refermé **avant** la livraison du descripteur v2, comme F-140 le demandait |
| Documentation | `docs/STRING_HAND_POSITION.md`, `docs/HAND_VISUALIZATION.md`, `docs/SYSEX_IDENTITY.md`, `docs/MIDI_CC_INSTRUMENT_CONTROLS.md` (CC27) | ✅ mises à jour |

**Ce qui n'a PAS été fait, volontairement : aucune migration.** La colonne
`string_instruments.capo_fret` reste en place. Un rebuild de table SQLite pour
une colonne inerte n'en vaut pas le risque sur un Pi en production ; elle est
documentée comme abandonnée dans le code (en-tête de
`StringInstrumentDatabase.js`, section `ABANDONED COLUMN`) et le SQL est fourni
ci-dessous, **non appliqué** (§5).

### Reste, hors périmètre : `public/index.html`

`public/index.html:12401-12402` contient encore
`is_fretless: 0, capo_fret: 0` en dur, dans `saveInstrumentSettings()`.
**Ce code est mort** : `window.showInstrumentSettings` est réassigné en
`index.html:10975` vers `new InstrumentSettingsModal(api)` — la déclaration
héritée `function showInstrumentSettings` (l. 11394) et son
`saveInstrumentSettings()` (l. 12247, seul appelant : le bouton de la modale
héritée) sont donc inatteignables (même bloc `<script>`, l'affectation gagne
sur la déclaration hoistée). Non touché : `index.html` est tenu par un autre
agent sur ce même arbre. **À supprimer avec le reste de la modale héritée.**

Deux commentaires devenus faux subsistent dans `src/midi/adaptation/**`, zone
interdite à ce lot : `HandPositionPlanner.js:10` (« la frette que le
convertisseur de tablature a choisie, **capo inclus** ») et `:113` (« barre de
glissière/capo mécanique », métaphore acceptable). Le premier est à corriger
par le lot qui tient `src/midi/adaptation/**` : il n'y a plus de capo à
inclure. Rien d'exécutable n'en dépend.

---

## 2. R14 — `is_fretless` (F-140, P1) : CÂBLÉE

`ISMSave.js:266` construisait `stringInstrumentPayload` avec
`is_fretless: 0` **en dur**. Un violon / violoncelle / basse fretless créé par
`string_instrument_create_from_preset` perdait donc son caractère fretless
**dès la première ouverture-sauvegarde du modal Réglages** — alors que trois
modules du moteur consomment la colonne (`TablatureConverter:78,146,751`,
`MidiPlayer:1101`, `CapabilityResolver:177`). Régression active, pas un manque.

**Correctif** — l'option (a) de F-140, la plus honnête : **exposer** le
réglage plutôt que seulement le préserver.

1. `ISMSections._renderStringsContent` rend une case `#ismIsFretless`,
   libellée par la clé i18n **déjà présente dans les 28 locales**
   (`stringInstrument.isFretless`) — aucune nouvelle clé, aucune dérive i18n.
2. `ISMListeners._attachStringsSectionListeners` la câble sur
   `tab.stringInstrumentConfig.is_fretless` et re-rend la sous-section (le
   canevas de manche est reconstruit avec le bon `isFretless`).
3. `ISMSave` lit la case ; **si la sous-section Cordes n'a jamais été rendue**
   (enregistrement depuis un autre onglet), il retombe sur
   `tab.stringInstrumentConfig.is_fretless` — la valeur chargée depuis la base
   ou posée par un preset. La destruction silencieuse est donc fermée dans les
   deux chemins.

**Preuve rouge → vert.** `tests/frontend/r14-ism-fretless-capo.test.js` (14
tests). Avec l'ancien `is_fretless: 0, capo_fret: 0` réintroduit :
`4 failed | 10 passed` — les 4 échecs sont « case cochée », « sous-section
jamais rendue », « preset appliqué en session » et « aucun `capo_fret` dans le
payload ». Après : `14 passed`.
Côté base : `tests/audit/r15-dead-capabilities.test.js` rejoue l'UPSERT du
modal sur une base SQLite réelle et vérifie que le violon reste fretless.

---

## 3. Le tableau des 12 capacités — décision et preuve

Légende : **CÂBLÉE** (elle a désormais un consommateur) · **RETIRÉE** (la
surface utilisateur a disparu) · **ASSUMÉE** (invisible du moteur par
décision, documentée et désormais testée) · **HORS PÉRIMÈTRE** (constat figé
par un test de caractérisation, correctif décrit au §4).

| # | Capacité | Classe | Décision | Preuve |
|---|---|---|---|---|
| 1 | `string_instruments.is_fretless` | F-140 (P1) | **CÂBLÉE** — case dans l'onglet Cordes + repli sur la config en mémoire | `tests/frontend/r14-ism-fretless-capo.test.js` (rouge→vert, 4 tests) · `r15-dead-capabilities.test.js › [CÂBLÉE] is_fretless` (4 tests, dont aller-retour SQLite) |
| 2 | `string_instruments.capo_fret` | C / F-72 | **RETIRÉE** — décision produit : le capo est abandonné. 12 surfaces supprimées (§1). Colonne conservée, documentée, SQL de drop fourni non appliqué | `r15 › [RETIRÉE] capo_fret` (7 tests : aucun writer, schéma, base, descripteur, simulateur, i18n × 28, colonne toujours là + doc) |
| 3 | i18n `capoFret` / `noCapo` / `tablature.capo` | C | **RETIRÉE** des 28 locales | `tests/audit-i18n.test.js` (0 manquante / 0 en trop) · `l09-i18n-completeness` recalé 2 737 → **2 734** clés |
| 4 | `shared/gm-instrument-capabilities.json` (`polyphony`, `monophonic`) | F-73 | **CÂBLÉE** — la référence GM alimente désormais le défaut de polyphonie du modal (1 pour tout programme monophonique) | `r14-ism-fretless-capo.test.js › GM reference feeds the polyphony default` (5 tests) · `r15 › [CÂBLÉE] gm-instrument-capabilities` (4 tests) |
| 5 | `bagpipe_config` | B / F-74 | **ASSUMÉE** — sémantique de vue (T1.3) ; couverture ajoutée | `r15 › [ASSUMÉE] Classe B` |
| 6 | `accordion_config` | B / F-74 | **ASSUMÉE** — idem | idem |
| 7 | `harmonica_config` | B / F-74 | **ASSUMÉE** — idem | idem |
| 8 | `string_slider_enabled` | B / F-74 | **ASSUMÉE** — geste de jeu live | idem + aller-retour base |
| 9 | `string_sliding_system_enabled` | B / F-74 | **ASSUMÉE** — idem | idem |
| 10 | `cc_bow_direction_number` / `cc_bow_down_value` / `cc_bow_up_value` | B / F-74 | **ASSUMÉE** — barre d'archet, jeu live | idem |
| 11 | `midi_instrument_routings.behavior_mode` | A3 / F-65 | **HORS PÉRIMÈTRE** — constat figé, correctif conçu §4.1 | `r15 › [MORTE] behavior_mode` |
| 12 | `instruments_latency.descriptor_json` / `descriptor_revision` | A1-A2 / F-67 | **HORS PÉRIMÈTRE** — constat figé, §4.2 | `r15 › [MORTE] descriptor_json / descriptor_revision` |
| 13 | `instrument_voices.{min_note_interval, min_note_duration, supported_ccs, octave_mode, scale_root}` | A4 / F-70 | **HORS PÉRIMÈTRE** — constat figé, §4.3 | `r15 › [MORTE] instrument_voices` |
| 14 | `pitch_bend_enabled` | A′1 / F-66 | **HORS PÉRIMÈTRE** — constat figé, §4.4 | `r15 › [MORTE] pitch_bend_enabled` |
| 15 | `capabilities_source = 'sysex'` | C / F-67 | **HORS PÉRIMÈTRE** — constat figé, §4.5 | `r15 › [MORTE] capabilities_source='sysex'` |

**Bilan sur les 15 lignes ci-dessus : 10 traitées, 5 laissées ouvertes.**
Traitées : 2 CÂBLÉES (`is_fretless`, référence GM), 2 RETIRÉES (`capo_fret`
et ses 3 clés i18n), 6 ASSUMÉES avec la couverture qui leur manquait
(Classe B). Ouvertes : les 5 du §4, chacune avec un test de caractérisation
qui fige le constat et un correctif écrit. Aucune n'est laissée sans réponse
documentée ; aucune n'est maquillée en « traitée ».

### 3.1 Détail de la Classe B — ce que « assumé » veut dire

L06 (F-74) : *« leur seul défaut est de n'avoir aucun test »*. La vérification
a été refaite et l'arbitrage tient :

- ces 8 colonnes sont des réglages de **vue** (`BagpipeView.drones`,
  `AccordionView.bass_system`, `HarmonicaView.type/key`) et de **jeu live**
  (rangée coulissante de `KeyboardPiano`, barre d'archet de `KeyboardChords`) ;
- elles ne décrivent **aucune transformation de fichier** — il est donc
  correct, et non défaillant, que `src/midi/**` ne les nomme jamais ;
- le test le fige dans les deux sens : **0 occurrence dans `src/midi/`** *et*
  **un consommateur réel côté clavier virtuel** pour chacune. Si quelqu'un les
  câble un jour dans le moteur, c'est le test qu'il faudra inverser, en
  connaissance de cause.

Les 5 colonnes cordes gagnent en plus une couverture de persistance
(aller-retour base réelle), qui n'existait pas.

### 3.2 Détail de F-73 — la monophonie des vents

`shared/gm-instrument-capabilities.json` porte 128 × 6 champs ; seul `name`
était consommé. Conséquence réelle relevée par L06 : **un instrument à vent
sans `polyphony = 1` saisi à la main reçoit l'accord entier.**

Câblage retenu, entièrement dans le périmètre de ce lot :

- `ISMSections._gmDefaultPolyphony(gmProgram, isDrum)` lit le miroir navigateur
  de la référence (`GmInstrumentCapabilities`) et répond **1 pour tout
  programme `monophonic`**, la polyphonie typique sinon, `null` pour un kit de
  batterie ou un programme hors 0-127 ;
- le champ Polyphonie du modal est **pré-rempli** avec cette valeur quand
  l'utilisateur n'en a pas saisi : le défaut est **visible**, pas imposé en
  douce, et reste éditable ;
- `ISMSave` applique le même repli au moment d'enregistrer, pour le cas où la
  section Notes n'a jamais été ouverte.

Effet : une flûte, une trompette, un lead de synthé enregistrés depuis le
modal partent en base avec `polyphony = 1` — contrainte que le moteur, lui,
fait déjà respecter. Un test garde en plus la synchronisation du miroir
navigateur avec le JSON partagé (si le miroir dérive, le défaut devient faux
sans que rien ne le signale).

> Le *backend* `InstrumentTypeConfig.getGmDefaultPolyphony()` reste sans
> appelant dans `src/` : le brancher relève de `CapabilityResolver` /
> `PlaybackScheduler` (`src/midi/**`), hors périmètre. Le câblage ci-dessus
> traite la conséquence utilisateur ; le repli côté moteur reste ouvert (§4.6).

---

## 4. Ce que ce lot n'a PAS traité, et pourquoi

Trois agents travaillent en parallèle sur le même arbre. Le périmètre de ce lot
était : `public/js/features/instrument-settings/**`,
`public/js/features/auto-assign/HandPositionFeasibility.js`,
`src/persistence/tables/StringInstrumentDatabase.js`,
`src/api/commands/StringInstrumentCommands.js`,
`src/api/commands/InstrumentSettingsCommands.js`,
`src/midi/instrument/DescriptorProtocol.js`, `shared/`, `public/locales/`.
Les cinq capacités ci-dessous ont **toute leur chaîne de correction hors de ce
périmètre** ; les toucher à moitié aurait produit un demi-correctif pire que
le constat. Chacune a un test de caractérisation et un correctif écrit.

### 4.1 `behavior_mode` (F-65) — le vrai bug utilisateur restant

L'utilisateur choisit « overflow » / « alternate » pour un split, la valeur
s'applique à la requête, est persistée… puis **est perdue au rechargement**.

Chaîne complète, entièrement hors périmètre :

| Maillon | Fichier | Zone |
|---|---|---|
| Writer | `src/midi/playback/commands/PlaybackAssignmentCommands.js:664` | `src/midi/playback/**` — **interdit** |
| Projection lecture | `src/persistence/tables/RoutingPersistenceDB.js:251` (elle renvoie déjà `behavior_mode`) | hors périmètre |
| Restauration UI | `public/js/features/auto-assign/RoutingSummaryPage.js` (`defaultMode='combineNoOverlap'`) | hors périmètre |
| Application moteur | `MidiPlayer.setChannelSplitRouting` | `src/midi/playback/**` — **interdit** |

**Correctif conçu (3 pas, ~30 lignes) :** (a) la commande qui liste les
routings d'un fichier expose `behavior_mode` tel que
`RoutingPersistenceDB.getRoutingsForFile` le renvoie déjà ; (b)
`RoutingSummaryPage` initialise son `mode` depuis la valeur reçue au lieu de
repartir du défaut ; (c) `MidiPlayer.setChannelSplitRouting` lit
`behavior_mode` au lieu de l'ignorer. Le point (c) seul suffit à rendre la
colonne vivante ; (a)+(b) sont ce qui rend le réglage **persistant à l'écran**,
c'est-à-dire ce que l'utilisateur constate.

### 4.2 `descriptor_json` / `descriptor_revision` (F-67)

Colonnes créées par la migration 033, **aucun writer, aucun lecteur** dans tout
`src/`. Le writer naturel est `src/midi/instrument/DescriptorService.js` —
`src/midi/instrument/**` est tenu par un autre agent (seul
`DescriptorProtocol.js` m'était attribué). Fait partie de T1.8 ; à traiter dans
le même lot que l'élargissement de `capabilities_source` à `'descriptor'`
(SQL prêt en `06_ROUTING_ADAPTATION.md` §10.2).

### 4.3 `instrument_voices` — 5 colonnes par voix (F-70)

Écrites par `ISMSave` (dans mon périmètre) et `InstrumentVoiceCommands`,
validées, **jamais lues** : `src/midi/adaptation/VoiceSelector.js` ne contient
aucune de ces 5 chaînes (test statique). `src/midi/adaptation/**` est interdit.
Ici « retirer l'UI » n'est **pas** la bonne réponse : la Phase 8 §4 de la
roadmap familles exige explicitement ces paramètres. C'est donc *à câbler*,
dans le lot qui tient `VoiceSelector`.

### 4.4 `pitch_bend_enabled` (F-66, classe A′)

Le réglage a un effet visible (il affiche/masque la molette de la vue clavier)
mais **ne filtre pas** le pitch-bend d'un fichier vers un instrument mécanique
qui déclare ne pas le gérer. La porte manquante est dans `PlaybackScheduler` et
`MidiRouter` (`src/midi/playback/**` et `src/midi/routing/**`) : interdits.
Une ligne de garde symétrique de celle des CC suffit, des deux côtés — et il
faut les deux, sous peine de recréer une divergence live ↔ fichier du type
F-64.

### 4.5 `capabilities_source = 'sysex'` (F-67)

Valeur autorisée par le `CHECK` de `migrations/001_baseline.sql:402`, produite
par **aucun writer**. Les deux issues honnêtes passent par des zones exclues :
soit la produire dans le chemin d'application de l'identité SysEx
(`src/midi/instrument/**`), soit la retirer du `CHECK` — ce qui exige une
migration, explicitement interdite dans ce lot. À trancher dans la migration
035 qui ajoutera `'descriptor'` : c'est la même reconstruction de contrainte,
donc le même coût.

### 4.6 Repli de polyphonie côté moteur

Le câblage §3.2 traite l'instrument **configuré depuis le modal**. Un
instrument créé par une autre voie (descripteur v2, API, import) peut encore
arriver avec `polyphony = NULL`. Le repli « pas de polyphonie déclarée ⇒
polyphonie GM de la famille » appartient à `CapabilityResolver` /
`PlaybackScheduler`, hors périmètre.

---

## 5. SQL proposé — **non appliqué**

Aucune migration n'a été créée par ce lot. Le SQL ci-dessous est fourni pour le
jour où le mainteneur décidera de nettoyer le schéma. Il n'a **pas** été déposé
dans `migrations/`, et n'a **pas** été exécuté sur une base réelle — il a
seulement été **vérifié à blanc** sur une base SQLite **en mémoire**
reconstruite depuis `migrations/` et peuplée d'une ligne (`capo_fret = 3`,
`is_fretless = 1`) : après exécution, `capo_fret` a disparu de
`PRAGMA table_info` et la ligne est intacte, valeurs par défaut des colonnes
tardives comprises.

```sql
-- migrations/0NN_drop_capo_fret.sql — PROPOSÉ, NON APPLIQUÉ, NON DÉPOSÉ.
--
-- `string_instruments.capo_fret` est une colonne abandonnée : plus aucun
-- writer, plus aucun lecteur (R15, 2026-09). Elle porte
-- `NOT NULL DEFAULT 0 CHECK(capo_fret BETWEEN 0 AND 36)`.
--
-- ⚠️ SQLite ne sait pas retirer une colonne portant un CHECK par un simple
-- ALTER TABLE DROP COLUMN : il faut reconstruire la table. C'est précisément
-- le risque que ce lot a refusé de prendre pour une colonne inerte — le gain
-- est nul, et la table porte une contrainte UNIQUE, une FK en CASCADE, deux
-- CHECK `json_valid` et un index.
--
-- La définition ci-dessous reproduit l'état RÉEL de la table après
-- l'empilement des migrations (001 baseline + 007 scale_length_mm + 021
-- cc_bow_* + slider/sliding), capo_fret en moins. Elle doit être revérifiée
-- contre `PRAGMA table_info(string_instruments)` avant toute exécution, et
-- exécutée dans une transaction, après sauvegarde.

PRAGMA foreign_keys = OFF;

CREATE TABLE string_instruments_new (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id          TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    channel            INTEGER NOT NULL DEFAULT 0 CHECK(channel BETWEEN 0 AND 15),
    instrument_name    TEXT NOT NULL DEFAULT 'Guitar',
    num_strings        INTEGER NOT NULL DEFAULT 6 CHECK(num_strings BETWEEN 1 AND 12),
    num_frets          INTEGER NOT NULL DEFAULT 24 CHECK(num_frets BETWEEN 0 AND 36),
    tuning             TEXT NOT NULL DEFAULT '[40,45,50,55,59,64]' CHECK(json_valid(tuning)),
    is_fretless        INTEGER NOT NULL DEFAULT 0,
    -- capo_fret        SUPPRIMÉE (colonne abandonnée)
    cc_enabled         INTEGER NOT NULL DEFAULT 1,
    tab_algorithm      TEXT NOT NULL DEFAULT 'min_movement',
    cc_string_number   INTEGER NOT NULL DEFAULT 20,
    cc_string_min      INTEGER NOT NULL DEFAULT 1,
    cc_string_max      INTEGER NOT NULL DEFAULT 12,
    cc_string_offset   INTEGER NOT NULL DEFAULT 0,
    cc_fret_number     INTEGER NOT NULL DEFAULT 21,
    cc_fret_min        INTEGER NOT NULL DEFAULT 0,
    cc_fret_max        INTEGER NOT NULL DEFAULT 36,
    cc_fret_offset     INTEGER NOT NULL DEFAULT 0,
    frets_per_string   TEXT CHECK(frets_per_string IS NULL OR json_valid(frets_per_string)),
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    scale_length_mm    INTEGER CHECK (scale_length_mm IS NULL OR scale_length_mm BETWEEN 100 AND 2000),
    string_slider_enabled         INTEGER NOT NULL DEFAULT 0,
    string_sliding_system_enabled INTEGER NOT NULL DEFAULT 0,
    cc_bow_direction_number       INTEGER NOT NULL DEFAULT 22,
    cc_bow_down_value             INTEGER NOT NULL DEFAULT 0,
    cc_bow_up_value               INTEGER NOT NULL DEFAULT 127,
    UNIQUE(device_id, channel)
);

INSERT INTO string_instruments_new (
    id, device_id, channel, instrument_name, num_strings, num_frets, tuning,
    is_fretless, cc_enabled, tab_algorithm,
    cc_string_number, cc_string_min, cc_string_max, cc_string_offset,
    cc_fret_number, cc_fret_min, cc_fret_max, cc_fret_offset,
    frets_per_string, created_at, updated_at, scale_length_mm,
    string_slider_enabled, string_sliding_system_enabled,
    cc_bow_direction_number, cc_bow_down_value, cc_bow_up_value
)
SELECT
    id, device_id, channel, instrument_name, num_strings, num_frets, tuning,
    is_fretless, cc_enabled, tab_algorithm,
    cc_string_number, cc_string_min, cc_string_max, cc_string_offset,
    cc_fret_number, cc_fret_min, cc_fret_max, cc_fret_offset,
    frets_per_string, created_at, updated_at, scale_length_mm,
    string_slider_enabled, string_sliding_system_enabled,
    cc_bow_direction_number, cc_bow_down_value, cc_bow_up_value
FROM string_instruments;

DROP TABLE string_instruments;
ALTER TABLE string_instruments_new RENAME TO string_instruments;

CREATE INDEX IF NOT EXISTS idx_string_instruments_device_channel
    ON string_instruments(device_id, channel);

PRAGMA foreign_keys = ON;
```

**Recommandation :** ne pas l'exécuter. La colonne coûte 1 entier par
instrument à cordes et ne peut plus rien casser maintenant qu'aucun code ne la
lit ; la reconstruction, elle, peut casser quelque chose.

---

## 6. Tests

### Ajoutés

| Fichier | Contenu |
|---|---|
| `tests/frontend/r14-ism-fretless-capo.test.js` (Vitest/jsdom, 14 tests) | R14 : rendu de la case, câblage du listener, 4 chemins de sauvegarde (rouge avant correctif). R15 : absence de `capo_fret` dans le payload et dans le rendu ; défaut de polyphonie GM. |
| `tests/audit/r15-dead-capabilities.test.js` (Jest, 32 tests) | Étiquetés `[CÂBLÉE]` / `[RETIRÉE]` / `[ASSUMÉE]` / `[MORTE]`. Base SQLite jetable construite depuis `migrations/`. |

### Inversés (le défaut a été fermé, le test qui l'encodait devient faux)

| Test | Avant | Après |
|---|---|---|
| `tests/frontend/hand-position-simulate-windows.test.js` › `respects the capo offset when resolving` | vérifiait que le simulateur **soustrayait** le capo (D3 → corde 2, frette 0) | → `ignores capo_fret entirely — the frontend resolves frets exactly like the engine` : avec et sans `capo_fret`, D3 → **corde 3, frette 0**, résultats identiques. **C'est la fermeture de F-72.** |
| `tests/descriptor-strings.test.js` › `maps declared fields…` | attendait `capo_fret: 2` en sortie du mapper | → `…; drops capo` : `capo: 2` reste dans l'entrée, le mapper ne produit plus `capo_fret`. |

### Recalés (constante de comptage)

| Test | Avant | Après | Raison |
|---|---|---|---|
| `tests/frontend/l09-i18n-completeness.test.js` › corpus de référence | 2 737 clés | **2 804** | −3 par ce lot (clés capo orphelines retirées des 28 locales), +70 par les lots livrés en parallèle sur le même arbre. |

> ⚠️ **Constante partagée.** Ce compteur bouge dès qu'un lot ajoute ou retire
> des clés i18n. Il a été recalé sur la valeur réelle au moment de clore ce
> lot ; un lot livré après celui-ci devra le recaler à son tour. Le
> commentaire du test porte désormais l'historique
> (2 737 → 2 734 → 2 804) pour que la mise à jour reste un acte conscient et
> non un simple « faire passer le test ».

`tests/audit/l06-capability-matrix.test.js` reste **vert sans modification** :
son test `[MORTE] capo_fret` porte sur `TablatureConverter`, qui ignorait déjà
le capo — le retrait de surface ne le contredit pas, il le confirme.

### État en fin de lot

- **Vitest** — `npx vitest run` : **88 fichiers / 1 604 tests, TOUS VERTS**
  (86 / 1 560 au départ ; +14 de ce lot, le reste des lots parallèles).
- **Jest** — `npm test` : **209 suites / 2 882 tests**, dont
  **3 échecs, tous étrangers à ce lot** (§7). `r15-dead-capabilities` : 32/32.
- `npx eslint src/ public/js/ tests/` : **0 erreur** (203 warnings `no-console`
  préexistants, **0 introduit par ce lot** — vérifié fichier par fichier sur
  les 13 fichiers touchés : 11 warnings, tous antérieurs).
- `npx tsc --noEmit` : **aucune erreur**.
- `npx prettier --check` sur les fichiers `.js` touchés : conforme (formatage
  appliqué **aux seuls fichiers de ce lot**, jamais globalement). Les `.md` de
  `docs/audit/` ne sont pas formatés par Prettier — ce compte rendu suit la
  convention de ses voisins.

---

## 7. Régressions et zones de vigilance

**Aucune régression imputable à ce lot.** Les 3 échecs Jest observés en fin de
lot proviennent d'autres agents travaillant en parallèle sur le même arbre :

1. `tests/audit/l11-offline-first.test.js` et `tests/audit/r6-offline-first.test.js`
   — « les 191 balises `<script src>` », reçu **193**. Deux scripts ont été
   ajoutés à `public/index.html` (fichier modifié à 03:01 par un autre lot),
   que ce lot n'a **jamais** ouvert en écriture. Le correctif appartient au lot
   qui a ajouté les scripts : recaler 191 → 193.
2. `tests/ble-midi-encode.test.js` — encodage SysEx BLE. **Passe seul**
   (14/14) ; il n'échoue que dans l'exécution complète, pendant qu'un autre
   lot réécrit ses fichiers. Aucun rapport avec les capacités d'instrument.
   Même symptôme observé une fois sur `tests/audit/r13-hand-overrides-engine.test.js`,
   qui passe lui aussi seul (27/27).

Vérification : `shared/` et `public/index.html` portent des horodatages
antérieurs / étrangers à ce lot — aucun des deux n'a été écrit ici.

**À valider en QA Pi (T9) :**

- Un instrument à vent ou à cuivre déjà enregistré et **ré-ouvert** dans le
  modal repart désormais avec la polyphonie GM de sa famille pré-remplie
  (souvent **1**) au lieu d'un champ vide. C'est le comportement voulu par
  F-73, mais c'est un **changement de comportement** : un utilisateur qui
  laissait volontairement le champ vide pour obtenir une polyphonie non
  contrainte doit maintenant saisir la valeur qu'il veut. Le champ reste
  éditable et la valeur est visible avant l'enregistrement.
- Le `capo_fret` d'une base existante n'est plus jamais réécrit. Une base qui
  contiendrait une valeur non nulle (impossible via l'UI, possible via l'API)
  la conserve — sans plus aucun effet nulle part.
