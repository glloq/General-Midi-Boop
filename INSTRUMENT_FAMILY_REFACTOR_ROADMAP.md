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
| 1 | Pipeline d'assets SVG | ⏳ À faire |
| 2 | Taxonomie partagée backend ↔ frontend | ⏳ À faire |
| 3 | Consommateurs UI en aval (éditeur MIDI, lighting) | ⏳ À faire |
| 4 | Matcher & auto-assignation | ⏳ À faire |
| 5 | Dépréciations (code legacy) | ⏳ À faire |
| 6 | i18n complet (26 autres locales) | ⏳ À faire |
| 7 | Tests E2E (Playwright) | ⏳ À faire |

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

## Phase 1 — Pipeline d'assets SVG

**Contexte** : 68 SVG existent dans `images-a-faire/instruments/` mais ne
sont pas servis par l'app. Le resolver fait déjà un fallback emoji gracieux
via `<img onerror>`. Il reste à déployer les icônes et à produire les
manquantes.

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

## Phase 2 — Taxonomie partagée backend ↔ frontend

**Contexte** : la taxonomie vit actuellement dans un seul fichier frontend.
Les pipelines backend d'adaptation (`src/midi/adaptation/InstrumentTypeConfig.js`)
utilisent une hiérarchie différente. Dupliquer serait source de dérive.

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

## Phase 4 — Matcher & auto-assignation

**Contexte** : le pipeline de matching
(`src/midi/adaptation/InstrumentMatcher*.js`) attribue un instrument détecté
à un canal. Il utilise `INSTRUMENT_TYPE_HIERARCHY` pour scorer.

**Tâches** :
1. Ajouter une dimension de scoring "même famille physique" (boost fort),
   complémentaire au score par type d'adaptation.
2. Mettre à jour `tests/midi-adaptation.test.js` et
   `tests/contracts/fixtures/playback/*.contract.json` si la nouvelle
   pondération change les outputs attendus.
3. Gérer le cas `drum_kits` : le matcher doit forcer canal 9 si la famille
   détectée est `drum_kits`, cohérent avec la règle UI.

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

## Phase 6 — i18n complet

**Contexte** : Phase 0 n'a mis à jour que `fr.json` et `en.json`. Les 26
autres locales (bn, cs, da, de, el, eo, es, fi, hi, hu, id, it, ja, ko, nl,
no, pl, pt, ru, sv, th, tl, tr, uk, vi, zh-CN) n'ont pas les nouvelles clés
et afficheront donc un fallback clé-brute ou le français.

**Tâches** :
1. Propager les 13 clés `instrumentFamilies.*` dans les 26 autres locales.
2. Propager les 7 nouvelles clés `instrumentSettings.*` (pickFamily,
   pickInstrument, backToFamily, editInstrument, deleteInstrument,
   deleteInstrumentConfirm, drumKit).
3. Audit : vérifier que `instruments.programs.*` et `instruments.drumKits.*`
   sont complets dans toutes les locales (les noms GM des 128 programmes +
   9 kits).

---

## Phase 7 — Tests E2E (Playwright)

**Contexte** : si des specs Playwright existent et cliquent sur
`#gmCategorySelect` ou sur les `<option>` d'un `<select>`, elles casseront
silencieusement (le sélecteur `#gmCategorySelect` n'existe plus ;
`#gmProgramSelect` reste en input hidden, les anciennes assertions de texte
sur le select ne fonctionnent plus).

**Tâches** :
1. `grep -rn "gmCategorySelect\|gmProgramSelect" tests/` — inventaire.
2. Remplacer les clics par `page.click('.ism-family-btn[data-family="..."]')`
   puis `page.click('.ism-instrument-btn[data-program="..."]')`.
3. Ajouter des specs pour le flux edit (✏️) et delete (🗑️).
4. Visual regression sur le picker (family row, instrument grid, selected
   view) — desktop + mobile.

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
