# Roadmap — Refonte de la taxonomie d'instruments par famille physique

Document de suivi pour la refonte progressive du modèle d'instruments dans
Ma-est-tro. La **Phase 0** (sélecteur d'identité du modal Réglages
d'instrument) est livrée. Les phases suivantes sont à traiter dans l'ordre :
chacune dépend de la précédente et touche un consommateur différent de la
taxonomie.

Le but : remplacer progressivement la taxonomie GM historique (16 catégories
non homogènes) par les **13 familles physiques** définies en Phase 0 dans
`public/js/features/instrument-settings/InstrumentFamilies.js`.

---

## État d'avancement

| Phase | Titre | Statut |
|---|---|---|
| 0 | Sélecteur d'identité (modal) | **✅ Livré** |
| 0b | Clavier de preview + simplification header + CC cordes | **✅ Livré** |
| 0c | Multi-voix GM (backend `instrument_voices` + UI Notes) | **✅ Livré** |
| 1 | Pipeline d'assets SVG (68/128 déployés) | **✅ Livré** |
| 2 | Taxonomie partagée backend ↔ frontend | **✅ Livré** |
| 3 | Consommateurs UI en aval (éditeur MIDI, lighting) | ⏳ À faire |
| 4 | Matcher & auto-assignation | **✅ Livré** |
| 5 | Dépréciations (code legacy) | ⏳ À faire |
| 6 | i18n complet (26 autres locales) | **✅ Livré** (EN fallback) |
| 7 | Tests E2E (Playwright) | **✅ Sans objet** (aucune spec ne cible les anciens sélecteurs) |
| 8 | Moteur de playback multi-voix (sélection par note) | ⏳ À faire |

---

## Phase 0 — Sélecteur d'identité du modal (livré)

**Livrables** :
- `public/js/features/instrument-settings/InstrumentFamilies.js` : taxonomie
  13 familles + resolver d'icône avec fallback emoji
- `public/js/features/instrument-settings/ISMSections.js` : picker 3 états
  (family / instruments / selected)
- `public/js/features/instrument-settings/ISMListeners.js` : handlers
  family/instrument/edit/delete + shim pour `onGmProgramChanged`
- `public/styles/instrument-settings-modal.css` : classes `.ism-family-row`,
  `.ism-instrument-grid`, `.ism-selected-instrument`, `.ism-icon-btn` …
- `public/locales/{fr,en}.json` : clés `instrumentFamilies.*` + nouvelles clés
  `instrumentSettings.{pickFamily,pickInstrument,backToFamily,editInstrument,
  deleteInstrument,deleteInstrumentConfirm,drumKit}`
- `tests/frontend/instrument-families.test.js` : 30 tests (taxonomie + resolver)

**Taxonomie** (slugs) :
`keyboards`, `chromatic_percussion`, `organs`, `plucked_strings`,
`bowed_strings`, `ensembles`, `brass`, `reeds`, `winds`, `synths`,
`percussive`, `sfx`, `drum_kits`.

**Décisions structurantes** :
- Accordéon/harmonica/tango accordéon (GM 21-23) déplacés de `organs` vers
  `reeds` (physiquement à anches libres).
- Timpani (GM 47) déplacé de la catégorie GM "strings" vers
  `chromatic_percussion`.
- Kalimba (GM 108) classé dans `chromatic_percussion` (lamellophone accordé).
- Instruments ethniques éclatés selon leur type physique : sitar/banjo/
  shamisen/koto (104-107) dans `plucked_strings`, bagpipe (109) et shanai
  (111) dans `reeds`, fiddle (110) dans `bowed_strings`.
- La famille `drum_kits` force automatiquement le canal MIDI 10 (index 9) à
  la sélection et est orthogonale aux 128 programmes mélodiques.

**Compatibilité préservée** :
- Backend inchangé : contrat `instrument_update_settings` identique, colonne
  `instruments_latency.gm_program` inchangée.
- `#gmProgramSelect` conservé comme `<input type="hidden">` (lu par
  `ISMSave.js`).
- Fonction globale `onGmProgramChanged` appelée via un objet shim pour
  préserver les comportements dépendants (sous-section cordes 24-45, notice
  drum kit, filtrage des presets d'accordage).

---

## Phase 0b — Clavier de preview, header, CC cordes (livré)

**Livrables** :
- Header du modal : texte de titre supprimé, il ne reste que `⚙️` + nom de
  l'instrument. `showCreate` réutilise `_updateHeader` au lieu d'un
  `innerHTML` ad hoc.
- Clavier de preview 1 octave dans le header :
  - mélodique → mini-piano C4-B4 (7 blanches + 5 noires en overlay)
  - kit batterie → 8 pads (kick, snare, HH, OHH, tom↑, tom↓, crash, ride)
  - rien de sélectionné → libellé discret
  - hover (`mouseenter`/`mouseleave`) → `midi_send noteon`/`noteoff` via
    le backend
  - `_selectProgram` envoie un `midi_send type: program` au device pour
    que le preview joue la bonne banque avant sauvegarde
  - `onClose` relâche toutes les notes actives
- CC cordes simplifié : on ne voit plus que les champs `CC#` pour
  String Select et Fret Select ; Min/Max/Offset deviennent des inputs
  cachés qui préservent les valeurs existantes (save inchangé).
- Bug i18n : clé `instrumentManagement.free` ajoutée aux locales fr/en
  (plus de clé-brute affichée dans la grille de canaux).

## Phase 0c — Multi-voix GM (livré)

**Contexte** : un instrument physique peut avoir plusieurs techniques de
jeu (ex : basse fingerstyle + slap + tapping + cello). Chaque technique
est un programme GM différent mais partage le même canal, les mêmes
cordes et la même plage de notes.

**Sémantique** : voix = **alternatives** (pas de layering). Le moteur
de playback choisira UNE voix par note selon le contexte — cf. Phase 8.

**Livrables** :
- Migration SQL : `migrations/003_instrument_voices.sql` crée la table
  `instrument_voices(id, device_id, channel, gm_program,
  min_note_interval, min_note_duration, supported_ccs JSON,
  display_order, created_at, updated_at)` avec index et trigger
  `updated_at`. Schema version bumped à 3.
- Backend :
  - `src/persistence/tables/InstrumentVoicesDB.js` — CRUD
    (list/create/update/delete/deleteByInstrument/replaceAll dans une
    transaction).
  - `src/persistence/tables/InstrumentDatabase.js` — façade
    (`listInstrumentVoices`, `createInstrumentVoice`, …).
  - `src/repositories/InstrumentRepository.js` — wrappers business
    (`listVoices`, `createVoice`, `updateVoice`, `deleteVoice`,
    `deleteVoicesByInstrument`, `replaceVoices`).
  - `src/api/commands/InstrumentVoiceCommands.js` — commandes WS
    `instrument_voice_list/create/update/delete/replace` avec
    validation MIDI (gm_program 0-255, timings 0-5000 ms, CCs 0-127).
  - `instrument_delete` cascade désormais sur `instrument_voices`.
- Frontend :
  - Sous-section « Voix GM additionnelles » dans l'onglet Notes &
    Capacités (pas dans Identité). Chaque voix : icône + n° GM + nom,
    inputs `min_note_interval`, `min_note_duration`, CC liste CSV,
    bouton 🗑️.
  - Bouton « ➕ Ajouter une voix » ouvre un overlay à 2 étapes
    (famille → instrument) qui réutilise le CSS du picker d'identité.
  - `_loadChannelData` charge `tab.voices` via `instrument_voice_list`.
  - `_save` persiste via `instrument_voice_replace` (atomique).
  - Les timings `min_note_interval` / `min_note_duration` ont été
    déplacés de l'onglet Avancé à l'onglet Notes (appliqués à la voix
    principale, celle de `instruments_latency.gm_program`).
- i18n : 7 nouvelles clés `instrumentSettings.*` ajoutées en FR/EN
  (`sectionTimings`, `sectionVoices`, `voicesHint`, `voicesEmpty`,
  `addVoice`, `deleteVoice`, `voiceCcs`).
- CSS : classes `.ism-voices-list`, `.ism-voice-row`, `.ism-voice-head`,
  `.ism-voice-params`, `.ism-voice-add-btn`, `.ism-voice-picker-overlay`
  avec dark mode.

**Compatibilité préservée** :
- Voix primaire reste sur `instruments_latency.gm_program` — tous les
  consommateurs existants (matcher, MIDI editor, lighting) continuent
  de fonctionner tant qu'ils lisent uniquement le GM primaire.

---

## Phase 1 — Pipeline d'assets SVG (livré — partiel)

**Livré** :
- Les 68 SVG existants ont été déplacés de `images-a-faire/instruments/`
  vers `public/assets/instruments/` (via `git mv`). Vite sert
  automatiquement `/assets/instruments/<slug>.svg` (root = `public/`),
  donc le resolver du picker affiche maintenant les vraies icônes pour
  les 68 programmes couverts.
- Correspondance exacte vérifiée : 68 slugs dans `PROGRAM_TO_SLUG` ↔
  68 fichiers SVG (0 manquant, 0 en trop).
- Fallback emoji toujours en place pour les 60 programmes GM + 13
  icônes de famille + 9 kits batterie qui n'ont pas encore de SVG.

**Reste à faire** :

**Tâches** :
1. Déplacer `images-a-faire/instruments/*.svg` → `public/assets/instruments/`
   (ou configurer un alias Vite si on veut garder la source ailleurs).
2. Vérifier que le serveur dev et le build Vite servent bien
   `/assets/instruments/<slug>.svg` avec le bon Content-Type.
3. Dessiner les icônes **par famille** attendues par le picker
   (`/assets/instruments/family_<slug>.svg`) — 13 fichiers :
   `family_keyboards.svg`, `family_chromatic_percussion.svg`,
   `family_organs.svg`, `family_plucked_strings.svg`,
   `family_bowed_strings.svg`, `family_ensembles.svg`, `family_brass.svg`,
   `family_reeds.svg`, `family_winds.svg`, `family_synths.svg`,
   `family_percussive.svg`, `family_sfx.svg`, `family_drum_kits.svg`.
4. Dessiner les icônes manquantes par programme GM — 60/128 restent en
   fallback emoji. Liste prioritaire : GM 1 Bright Acoustic Piano, GM 3
   Honky-tonk, GM 17-18 Percussive/Rock Organ, GM 34-39 Basses (pick,
   fretless, slap, synth), GM 41 Viola, GM 44-45 Tremolo/Pizzicato, GM 49-51
   String Ensemble 2 / Synth Strings, GM 53-55 Voice Oohs/Synth Voice/
   Orchestra Hit, GM 59 Muted Trumpet, GM 61-63 Brass Section / Synth Brass,
   GM 67 Baritone Sax, GM 69 English Horn, GM 72 Piccolo, GM 80-103
   Synthés, GM 110 Fiddle, GM 118 Synth Drum, GM 120-127 Sound Effects.
5. Dessiner les icônes des 9 kits GM : `drum_kit_0.svg`, `drum_kit_8.svg`,
   `drum_kit_16.svg`, `drum_kit_24.svg`, `drum_kit_25.svg`,
   `drum_kit_32.svg`, `drum_kit_40.svg`, `drum_kit_48.svg`, `drum_kit_56.svg`.
6. Harmoniser le style : même viewBox (suggérer 64×64), stroke cohérent,
   monochrome + accent pour théming dark mode.
7. Mettre à jour `PROGRAM_TO_SLUG` dans `InstrumentFamilies.js` si de
   nouveaux slugs apparaissent, ainsi que les tests associés.

**Critère de complétion** : chaque programme 0-127 et chaque kit ont un
SVG, aucun fallback emoji n'est visible en usage courant.

---

## Phase 2 — Taxonomie partagée backend ↔ frontend (livré)

**Livré** :
- `shared/instrument-families.json` : source canonique unique
  (13 familles, 68 entrées `programToSlug`, 9 kits, `drumKitOffset`).
- `src/midi/gm/InstrumentFamilies.js` : module Node ESM qui charge le
  JSON synchronement à l'import et expose `getFamilies`,
  `getFamilyBySlug`, `getFamilyForProgram`, `isDrumFamily`,
  `getProgramSlug`, `gmDrumKits`, `drumKitOffset`. Données gelées.
- `tests/frontend/instrument-families-sync.test.js` : 5 tests Vitest
  qui parsent les littéraux inline du frontend (`FAMILIES`,
  `PROGRAM_TO_SLUG`, `GM_DRUM_KITS_LIST`) et assertent l'égalité
  stricte avec le JSON, plus l'invariant de couverture GM 0-127 et la
  présence physique des SVG référencés dans `public/assets/instruments/`.
- Choix de design : le frontend garde ses données inline (chargement
  synchrone, pas de fetch au page-load) ; le test sync garantit qu'on
  ne dérive pas d'un côté ou de l'autre.

**Reste optionnel** :

**Tâches** :
1. Extraire les 13 familles vers `shared/instrument-families.json` (nouveau
   dossier à la racine, servi aux deux côtés).
2. `InstrumentFamilies.js` (frontend) charge le JSON via `fetch` ou est
   régénéré à partir de lui au build.
3. Créer `src/midi/gm/InstrumentFamilies.js` (backend, Node) qui importe le
   même JSON et expose `getFamilyForProgram`, `getAllFamilies`, etc.
4. Ajouter des tests backend (Jest) : chargement + invariants (même contrat
   que `tests/frontend/instrument-families.test.js`).
5. Décider du devenir de `INSTRUMENT_TYPE_HIERARCHY` dans
   `src/midi/adaptation/InstrumentTypeConfig.js` :
   - soit le garder comme couche d'adaptation au-dessus des familles (rôle
     sémantique différent : matcher par type d'adaptation VS UI par famille
     physique)
   - soit le reconcilier (exemple : `strings_family` éclaté en
     `bowed_strings` + `plucked_strings`).

---

## Phase 3 — Consommateurs UI en aval

Une fois la taxonomie partagée prête (Phase 2), remplacer les références à
la catégorie GM historique par la famille physique dans les composants UI.

**Consommateurs connus** (cibles grep) :
- `public/js/features/midi-editor/MidiEditorChannelPanel.js` — couleur/icône
  de l'en-tête de canal (utilise actuellement `getGmCategoryForProgram`).
- Toute la palette de couleurs des pistes MIDI dans l'éditeur et le lecteur.
- `public/js/lighting/**` — presets lighting GM (couleurs RGB par famille
  au lieu de par catégorie GM).
- `public/js/features/InstrumentManagementPage.js` — `VIRTUAL_PRESETS` et
  templates par emoji (lignes 220-240).
- `src/midi/adaptation/InstrumentMatcher*.js` (voir Phase 4).

**Tâches** :
1. `grep -rn "getGmCategoryForProgram\|GM_CATEGORY_EMOJIS\|GM_INSTRUMENT_GROUPS" public/js src/` — inventaire complet.
2. Remplacer par `InstrumentFamilies.getFamilyForProgram(...)` ou équivalent
   backend.
3. Migrer la palette de couleurs par catégorie (si elle existe) vers une
   palette par famille — à définir avec l'équipe design.
4. Régression visuelle : vérifier que les en-têtes de canal, les presets
   lighting, et les vues de gestion n'ont pas perdu leur couleur/icône.

---

## Phase 4 — Matcher & auto-assignation (livré)

**Livré** :
- `ScoringConfig.bonuses.samePhysicalFamilyMatch: 6` — nouveau bonus
  additif (distinct de `sameFamilyMatch` qui reste pour la hiérarchie
  `InstrumentTypeConfig`).
- `InstrumentMatcher.scorePhysicalFamilyMatch(chanProgram, chanCh,
  instProgram, instCh)` : fire seulement quand les deux programmes
  résolvent vers la MÊME famille physique MAIS viennent de catégories
  GM différentes (gate contre double-compte avec `sameCategoryMatch`).
  - Appel dans `calculateCompatibility` juste après le program score.
- 7 nouveaux tests Jest dans `tests/midi-adaptation.test.js` couvrant
  null guards, exact match, double-count guard, et 3 cas cross-catégorie
  (nylon↔sitar, violon↔fiddle, accordéon↔clarinette).
- Règle drum_kits : la config `percussion.drumChannelDrumBonus` / `.
  drumChannelNonDrumPenalty` existante gère déjà le cas canal 9 ; le
  nouveau helper récompense en plus les matchings drum_kit ↔ drum_kit
  cross-programs.

**Totaux** : 109 tests backend passent (était 102 ; +7 nouveaux).

---

## Phase 5 — Dépréciations

À faire **après** que les phases 3 et 4 n'aient plus de lecteur de l'API
legacy.

**Cibles** :
- `public/js/features/InstrumentSettingsModal.js` : retirer
  `_getGmCategoryKey` et `GM_CATEGORY_EMOJIS` (remplacer le titre de section
  par `family.emoji` du resolver).
- `public/index.html` : retirer `renderGMCategoryOptions`,
  `renderGMProgramOptionsForCategory`, `getGmCategoryForProgram`,
  `GM_INSTRUMENT_GROUPS` si plus personne ne les lit.
- Remplacer la fonction globale `onGmProgramChanged` (index.html:10520) par
  un événement `eventBus.emit('instrumentSettings:gmProgramChanged', {
  program, channel, isDrumKit })`. Les abonnés actuels : sous-section cordes
  (révélation 24-45), notice/desc drum kit, filtrage des presets d'accordage.
- Retirer le shim `_buildGmShim` dans `ISMListeners.js` une fois la
  migration eventBus faite.
- Retirer le `<input type="hidden" id="gmProgramSelect">` si le save passe à
  lire directement `this._identityUI` ou `tab.settings.gm_program`.

---

## Phase 6 — i18n complet (livré — fallback EN)

**Livré** :
- Les 28 nouvelles clés (13 `instrumentFamilies.*` + 14
  `instrumentSettings.*` + 1 `instrumentManagement.free`) ont été
  propagées dans les 26 locales manquantes (bn, cs, da, de, el, eo,
  es, fi, hi, hu, id, it, ja, ko, nl, no, pl, pt, ru, sv, th, tl, tr,
  uk, vi, zh-CN) avec les chaînes EN en fallback.
- 26 × 28 = 728 clés ajoutées ; l'UI ne montre plus la clé brute pour
  aucune locale.

**Reste à faire (optionnel)** :
1. Traduction proprement dite pour chaque locale (actuellement les 26
   locales non-fr/en reçoivent le texte EN).
2. Audit : vérifier que `instruments.programs.*` et
   `instruments.drumKits.*` (noms GM des 128 programmes + 9 kits) sont
   complets dans toutes les locales.

---

## Phase 8 — Moteur de playback multi-voix

**Contexte** : la Phase 0c persiste plusieurs GM voices par instrument
avec leurs timings et CCs spécifiques. Aucun consommateur ne les lit
encore — le moteur de playback continue d'utiliser uniquement
`instruments_latency.gm_program`. Il faut maintenant décider de la
politique de sélection **par note** à l'exécution.

**Tâches** :
1. Concevoir la stratégie de sélection : par octave, par vélocité, via
   un CC dédié (ex : articulation switch), via annotation dans le
   fichier MIDI, ou combinaison.
2. Étendre le pipeline :
   - `src/midi/playback/MidiPlayer.js` ou `MidiTransposer.js` — avant
     d'émettre la note, résoudre la voix active et émettre un
     `program_change` vers le GM correspondant **si** la voix a changé
     depuis la note précédente (éviter les program_change à chaque
     note).
   - `src/midi/adaptation/InstrumentMatcher*.js` — accepter plusieurs
     GM candidats par canal au lieu d'un seul lors du scoring.
3. Adapter l'UI : indicateur visuel de la voix active dans le MIDI
   editor / channel panel.
4. Respecter les timings par voix : `min_note_interval` et
   `min_note_duration` de la voix sélectionnée s'appliquent à la note
   courante (remplacent les valeurs de l'instrument primaire).
5. Tests de régression : sans multi-voix (voices=[]), le comportement
   doit être strictement identique à aujourd'hui.

**Lieux à modifier (pointeurs)** :
- `src/midi/playback/MidiPlayer.js`
- `src/midi/adaptation/MidiTransposer.js`
- `src/midi/adaptation/InstrumentMatcher*.js`
- `public/js/features/midi-editor/MidiEditorChannelPanel.js`

---

## Phase 7 — Tests E2E (Playwright) — sans objet

**Audit** : `grep -rn "gmCategorySelect\|gmProgramSelect" tests/` retourne
zéro résultat ; aucun test E2E ne cible les anciens sélecteurs. Phase
marquée comme close.

**À créer si/quand Playwright est introduit** :
1. Specs pour le flux picker (family row → grille → selected view).
2. Specs pour les flux edit (✏️) et delete (🗑️).
3. Specs pour le multi-voix (ajout / suppression / timings par voix).
4. Visual regression desktop + mobile.

---

## Catalogue des consommateurs (cibles grep)

À utiliser au début de chaque phase pour repérer ce qui doit évoluer :

```
getGmCategoryForProgram        # public/index.html + consumers
GM_INSTRUMENT_GROUPS           # public/index.html
GM_CATEGORY_EMOJIS             # InstrumentSettingsModal.js (section title)
_getGmCategoryKey              # InstrumentSettingsModal.js
renderGMCategoryOptions        # public/index.html
renderGMProgramOptionsForCategory  # public/index.html
onGmProgramChanged             # public/index.html:10520 (legacy global)
INSTRUMENT_TYPE_HIERARCHY      # src/midi/adaptation/InstrumentTypeConfig.js
InstrumentMatcher              # src/midi/adaptation/
#gmCategorySelect              # plus d'existence — chercher dans tests/
#gmProgramSelect               # reste comme input hidden
```
