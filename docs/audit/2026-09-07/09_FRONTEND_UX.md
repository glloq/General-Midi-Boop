# 09 — Frontend : UI/UX, accessibilité, i18n, CSS, responsive, mémoire (lot L09)

**Date :** 2026-09-07 · **Base :** `00_BASELINE.md` (commit `8dc170e`, v0.8.1)
**Périmètre plan :** §AM, AN, AO, AP, AQ, AR, AS, AT, AU, AV
**Findings :** F-96 → F-107 · **F-12 réinstruit et conclu**

Frontend mesuré : **190 modules, 104 761 lignes de JS** sous `public/js/`,
**plus 8 316 lignes de JS inline dans `public/index.html`** (fait établi par le
lot L13 ; tous les scans de ce rapport ont été relancés en l'incluant),
**29 feuilles CSS / 34 232 lignes** plus 5 340 lignes de CSS inline,
**28 locales × 2 737 clés**, aucun framework.

---

## 1. Synthèse

| § | Sujet | État | Niv. | Finding |
|---|---|---|---|---|
| **AS** | Internationalisation | **PARTIAL** | 3 | **F-96**, **F-97** (= F-12 conclu) |
| **AR** | Accessibilité (WCAG 2.2) | **PARTIAL** | 3 | **F-99**, **F-100**, **F-103**, **F-104**, **F-106** |
| **AT** | CSS | **PARTIAL** | 3 | **F-101**, **F-102**, **F-107** |
| **AV** | Mémoire / fuites | **PARTIAL** | 3 | **F-105** |
| **AO** | Responsive | **PARTIAL** | 2 | — (statique seulement) |
| **AM** | Inventaire fonctionnel UI | **PARTIAL** | 1 | — (recensement statique) |
| **—** | Discipline `t()` / `tHtml()` | **PASS** (moitié « double échappement ») | 3 | **F-98** (corrigé) |
| **AN** | Parcours UX débutant | **NOT TESTED** | 0 | — |
| **AP** | Tactile / multitouch | **HW REQUIRED** | 0 | — |
| **AQ** | Cross-browser | **HW REQUIRED** | 0 | — |
| **AU** | Perf frontend (TTI, tas) | **NOT TESTED** | 0 | — (profileur navigateur) |

**Sections passées de `NOT TESTED` à mesuré : AR, AT, AV, AO, AM.**
Restent hors de portée sans navigateur ni humains : AN, AP, AQ, AU.

**Correctifs appliqués dans ce lot : 5** (F-98, F-100, F-101, F-102, et les noms
accessibles des boutons de fermeture des deux plus grosses modales).
**Suites ajoutées : 3 · 59 tests · toutes vertes.**

```
npx vitest run tests/frontend/l09-a11y-modals.test.js \
                tests/frontend/l09-css-contracts.test.js \
                tests/frontend/l09-i18n-completeness.test.js
Test Files  3 passed (3)      Tests  59 passed (59)      2,13 s
```

---

## 2. §AS — Internationalisation : F-12 réinstruit et conclu

### 2.1 Ce qui était établi, ce qui manquait

L'audit du 2026-08-22 a prouvé la **parité structurelle** : 2 737 clés × 28
locales, **0 clé manquante, 0 clé en trop**, garanti par
`tests/audit-i18n.test.js` (138 assertions, vertes). Ce résultat tient toujours.

Il a aussi produit un taux de traduction par locale, mais avec un estimateur
naïf (« valeur identique à l'anglais, longueur > 3 caractères »), assorti d'une
mise en garde honnête : *« lower bound, accurate to a few points »*. Le plan
demande de refaire la mesure sérieusement. C'est ce qui suit.

### 2.2 L'estimateur, et ce qu'il vaut

Une chaîne identique à l'anglais est de deux natures : **jamais traduite**, ou
**légitimement identique** (« MIDI », « 1/16T », « BPM », « Crash1 »). Confondre
les deux, c'est ce qui a produit la fourchette floue de l'audit précédent.

**Méthode retenue** — deux bornes, pas un chiffre unique :

```
plancher = (total − identiques) / total
           toute valeur identique compte comme non traduite
           (c'est exactement la mesure du 2026-08-22)

plafond  = plancher + légitimement_identiques / total
           TECH : la valeur ne contient que des jetons techniques, chiffres,
                  symboles, emoji ou abréviations GM de batterie — elle reste
                  en alphabet latin dans TOUTES les langues
           LOAN : locales à alphabet latin uniquement — emprunt musical ou
                  technique partagé (« Piano », « Tempo », « Vibrato »)

taux retenu = milieu de la bande     marge = demi-largeur de la bande
```

L'implémentation vit dans `tests/frontend/l09-i18n-completeness.test.js`
(fonction `classify(value, locale)` exportée et testée sur ses propres cas
limites) ; elle est donc rejouable et ratchetée.

**Marge d'erreur, dite franchement.**

| Source d'erreur | Effet | Amplitude |
|---|---|---|
| Liste TECH/LOAN construite à la main | déplace le plafond | **±4,0 à ±4,8 pts** sur les 18 locales à alphabet latin |
| Idem, locales non latines (`ru uk el ja ko zh-CN th hi bn`) | LOAN désactivé : un mot en alphabet latin dans une locale cyrillique / CJK / devanagari est presque toujours un reliquat | **±1,9 à ±2,4 pts** seulement |
| **Ce que l'estimateur ne voit pas** | une valeur *différente* de l'anglais mais fausse, machine-traduite ou marqueur de travail est comptée comme traduite | **non borné vers le bas** |

Donc : les chiffres ci-dessous sont un **taux de couverture**, pas un taux de
qualité. Ils bornent correctement « combien de l'interface reste en anglais » ;
ils ne disent rien de la justesse de ce qui a été traduit. C'est une limite
structurelle d'une mesure statique, pas un défaut de réglage.

**Deux contrôles de cohérence indépendants**, qui donnent confiance au reste :

- **1 564 clés sur 2 737 (57,1 %) sont traduites dans les 27 locales** — le
  socle est réel, l'estimateur ne s'invente pas un problème.
- **128 clés sont identiques dans les 27 locales à la fois** ; inspectées à la
  main, elles se répartissent en jetons légitimes (`RSSI`, `AZERTY`, `1/8T`, les
  46 abréviations GM de batterie) **et** en anglais résiduel évident
  (`Add a rule`, `No files found`, `Turn off`, `Solid colour`) — c'est
  exactement la frontière que la bande plancher/plafond encadre.
- `ja`, `ko` et `zh-CN` ont **rigoureusement le même ensemble de clés non
  traduites** (vérifié par égalité d'ensembles). Ce n'est pas un hasard
  linguistique : les trous sont **structurels**, par blocs de fonctionnalité,
  et non répartis clé par clé.

### 2.3 Le tableau des 28 locales

`°` = alphabet non latin (bande resserrée). « Hors lumière » exclut les
358 clés `lighting.*` + `instrumentSettings.lumiere*`. « UI critique » = les
929 clés des 17 sections qu'un utilisateur traverse obligatoirement
(`common`, `app`, `ui`, `errors`, `settings`, `fileOperations`, `playlist`,
`autoAssign`, `instrumentManagement`, `channelRouter`, `filters`, `network`,
`bluetooth`, `instrumentCapabilities`, `startupUpdate`, `logs`,
`deviceSettings`).

| Locale | Identiques | dont légitimes | Plancher | Plafond | **Taux retenu** | Marge | Hors lumière | UI critique |
|---|---|---|---|---|---|---|---|---|
| `fr` | 332 | 221 | 87,9 % | 95,9 % | **91,9 %** | ±4,0 | 91,8 % | 95,0 % |
| `eo` | 397 | 157 | 85,5 % | 91,2 % | **88,4 %** | ±2,9 | 95,5 % | 98,1 % |
| `bn` ° | 378 | 105 | 86,2 % | 90,0 % | **88,1 %** | ±1,9 | 95,7 % | 98,1 % |
| `th` ° | 392 | 106 | 85,7 % | 89,6 % | **87,6 %** | ±1,9 | 95,5 % | 98,1 % |
| `es` | 518 | 242 | 81,1 % | 89,9 % | **85,5 %** | ±4,4 | 89,4 % | 93,2 % |
| `de` | 535 | 246 | 80,5 % | 89,4 % | **84,9 %** | ±4,5 | 88,8 % | 92,4 % |
| `it` | 590 | 253 | 78,4 % | 87,7 % | **83,1 %** | ±4,6 | 89,3 % | 93,7 % |
| `vi` | 667 | 261 | 75,6 % | 85,2 % | **80,4 %** | ±4,8 | 86,6 % | 91,7 % |
| `id` | 692 | 262 | 74,7 % | 84,3 % | **79,5 %** | ±4,8 | 85,6 % | 90,6 % |
| `pl` | 718 | 253 | 73,8 % | 83,0 % | **78,4 %** | ±4,6 | 89,0 % | 92,6 % |
| `cs` | 724 | 254 | 73,5 % | 82,8 % | **78,2 %** | ±4,6 | 88,7 % | 92,5 % |
| `sv` | 728 | 256 | 73,4 % | 82,8 % | **78,1 %** | ±4,7 | 88,6 % | 92,6 % |
| `pt` | 727 | 252 | 73,4 % | 82,6 % | **78,0 %** | ±4,6 | 88,6 % | 92,5 % |
| `fi` | 733 | 256 | 73,2 % | 82,6 % | **77,9 %** | ±4,7 | 88,4 % | 92,0 % |
| `no` | 736 | 258 | 73,1 % | 82,5 % | **77,8 %** | ±4,7 | 88,3 % | 92,0 % |
| `hu` | 737 | 256 | 73,1 % | 82,4 % | **77,7 %** | ±4,7 | 88,2 % | 91,9 % |
| `nl` | 741 | 254 | 72,9 % | 82,2 % | **77,6 %** | ±4,6 | 88,0 % | 92,1 % |
| `tr` | 748 | 256 | 72,7 % | 82,0 % | **77,3 %** | ±4,7 | 87,8 % | 92,6 % |
| `da` | 753 | 262 | 72,5 % | 82,1 % | **77,3 %** | ±4,8 | 87,7 % | 91,6 % |
| `uk` ° | 705 | 129 | 74,2 % | 79,0 % | **76,6 %** | ±2,4 | 87,7 % | 92,2 % |
| `ja` ° | 712 | 129 | 74,0 % | 78,7 % | **76,3 %** | ±2,4 | 87,4 % | 91,7 % |
| `ko` ° | 712 | 129 | 74,0 % | 78,7 % | **76,3 %** | ±2,4 | 87,4 % | 91,7 % |
| `zh-CN` ° | 712 | 129 | 74,0 % | 78,7 % | **76,3 %** | ±2,4 | 87,4 % | 91,7 % |
| `ru` ° | 715 | 129 | 73,9 % | 78,6 % | **76,2 %** | ±2,4 | 87,3 % | 91,3 % |
| `el` ° | 738 | 130 | 73,0 % | 77,8 % | **75,4 %** | ±2,4 | 86,3 % | 90,7 % |
| `tl` | 881 | 244 | 67,8 % | 76,7 % | **72,3 %** | ±4,5 | 75,9 % | 83,9 % |
| `hi` ° | 839 | 130 | 69,3 % | 74,1 % | **71,7 %** | ±2,4 | 82,1 % | 87,2 % |

*(`en` = référence, non mesurée. Les taux confirment l'ordre de grandeur de
l'audit précédent — l'écart tient au traitement des jetons légitimes.)*

### 2.4 F-96 — La cause principale : le module Lumière n'est traduit nulle part

L'écart n'est pas diffus. Il est **localisé**.

| Section | Clés | Médiane du taux **non traduit** sur les 27 locales |
|---|---|---|
| **`lighting`** | **303** | **100,0 %** |
| `windEditor` | 27 | 37,5 % |
| `playlist` | 40 | 32,5 % |
| `ccNames` | 39 | 22,7 % |
| `instrumentSettings` | 310 | 22,7 % |
| `drumPattern` | 40 | 19,4 % |
| `scoringSettings` | 98 | 18,4 % |
| … 15 sections | — | **0,0 %** (intégralement traduites partout) |

**`lighting.*` (303 clés) + `instrumentSettings.lumiere*` (55 clés) = 358 clés,
soit 13,1 % de l'interface, et 17 des 27 locales n'en traduisent pas une seule** :
`cs da el fi hi hu ja ko nl no pl pt ru sv tr uk zh-CN`.
Les 10 autres (`fr` 262/303, `es` 164, `de` 162, `bn` 126, `eo` 126, `tl` 124,
`th` 118, `it` 98, `vi` 89, `id` 87) sont partielles.

**Conséquence directe** : retirer le module Lumière du calcul fait passer
**toutes** les locales au-dessus de 75 %, et 21 sur 27 au-dessus de 86 %
(colonne « Hors lumière »). Le « problème i18n » du projet est en réalité
**un module non traduit**, plus une longue traîne mineure.

C'est cohérent avec **F-13** (lot L02) : la fonctionnalité lumière est aussi
celle à 2,35 % de couverture de tests. Elle a été livrée sans son i18n comme
elle a été livrée sans ses tests.

### 2.5 F-97 — Des textes en dur qui ne passeront jamais par les locales

Traduire les 358 clés lumière ne suffirait pas. Une part de l'interface
**n'utilise pas i18n du tout** :

```
public/js/**          : 244 littéraux français hors i18n, 37 fichiers
                        (dont ≥ 91 sur une ligne portant du balisage,
                         textContent, title=, alert() ou confirm())
public/index.html     :  69 lignes supplémentaires, dans les 8 316 lignes
                        de JS inline signalées par L13
```

Ces chaînes s'affichent **en français quelle que soit la langue choisie**, et
elles sont invisibles pour `tests/audit-i18n.test.js`, qui ne regarde que les
fichiers de locale — d'où un audit i18n « vert » alors que l'interface ne l'est
pas.

Concentration (top 6) : `InstrumentSettingsModal.js` 83,
`instrument-settings/InstrumentPresets.js` 35, `ISMSections.js` 30,
`SystemAdminModal.js` 11, `midi-editor/MidiEditorInfoModalRender.js` 11,
`settings/SettingsHotspot.js` 6.

Deux exemples vérifiés bout en bout :

- `InstrumentSettingsModal.CC_GROUPS` — les descriptions des 30+ contrôleurs
  MIDI (`'Vibrato, trémolo ou effet modulant'`, `"Pédale d'expression au pied"`,
  `'Balance stéréo gauche/droite'`…) sont en dur, **sans clé i18n associée**, et
  rendues en infobulle par `ISMSections.js:2637`
  (`title="${this.escape(info.desc + ' | ' + info.range)}"`). Un utilisateur
  japonais lit ces infobulles en français.
- `DeviceSettingsModal.js` — `"Demander l'identité via SysEx"` (constante de
  module), `'⏳ En attente...'`, `'✅ Identité reçue'`, `Firmware:`/`Protocole:`
  injectés en `innerHTML` ligne 263 : le panneau d'identité SysEx est
  monolingue.

> **Verdict F-12 : CONFIRMÉ OUVERT et aggravé.** Le finding portait sur le taux
> de traduction des locales ; la mesure montre que ce taux (a) est dominé par un
> module unique non traduit, et (b) surestime la réalité parce que ≥ 313
> chaînes ne transitent pas par le système d'i18n.

### 2.6 Réponse à « quelles langues peut-on honnêtement annoncer ? »

`README.md:38` et `:126` annoncent **« 28 languages »** sans réserve. C'est
structurellement vrai (tout se charge, aucune clé brute à l'écran) et
**fonctionnellement trompeur**.

Trois niveaux défendables :

| Niveau | Critère | Locales | Formulation honnête |
|---|---|---|---|
| **Complet** | ≥ 90 % global | `fr` (91,9 %) | « traduction complète » |
| **Interface traduite** | ≥ 90 % de l'UI critique | 24 locales : `eo bn th es de it vi id pl cs sv pt fi no hu nl tr da uk ja ko zh-CN ru el` | « interface traduite ; module Lumière en anglais » |
| **Partiel** | < 90 % de l'UI critique | `hi` (87,2 %), `tl` (83,9 %) | « traduction partielle » |

**Formulation recommandée pour le README** (aucun chiffre à retirer, une
précision à ajouter) :

```diff
-- **28 languages**, including translated MIDI instrument names: English, French, …
+- **28 languages** for the whole interface — one fully translated (French), 24
+  with the complete core interface translated, 2 partial (Hindi, Tagalog).
+  The Lighting module is currently translated in 10 languages only.
```

C'est le seul changement qui rende la promesse exacte sans rien retirer. Le
fichier n'est pas modifié ici (fichier partagé) : diff proposé, à appliquer en
vague 2.

### 2.7 L'outillage existant

- `tests/audit-i18n.test.js` — 210 lignes, garde la parité **structurelle**.
  Excellent et actif, mais aveugle à la traduction réelle. La suite
  `l09-i18n-completeness.test.js` ajoutée ici comble exactement ce trou avec un
  **ratchet par locale** (27 seuils) : une locale peut monter, jamais
  redescendre. C'est la recommandation P2 du 2026-08-22, désormais implémentée.
- `scripts/fix-missing-translations.js` — 617 lignes, tables de traduction
  écrites à la main pour un lot de clés historique (`instrumentManagement`,
  `autoAssign`, `instrumentCapabilities`) et 4 locales seulement (`de es …`).
  Ce n'est pas un outil de complétion générique : il ne couvre ni `lighting`
  ni les 17 locales à zéro. Il ne peut pas résoudre F-96.

---

## 3. §AR — Accessibilité : classée par gravité d'usage

Priorité donnée à ce qui rend l'application **inutilisable**, pas aux
avertissements cosmétiques. Tout ce qui suit est mesuré en jsdom ou par analyse
statique de l'arbre DOM produit ; le contraste est calculé sur les tokens
réellement livrés. Aucun navigateur, donc pas d'axe-core : le harnais L08 n'était
pas disponible et le plan interdit de l'attendre.

### Gravité 1 — bloquant : la moitié des modales n'a aucun contrat de dialogue

**F-103.** Sur ~23 classes de modales, **10 seulement héritent de `BaseModal`**
(`ScoringSettingsModal`, `CalibrationModal`, `LoopCreatorModal`,
`StringInstrumentConfigModal`, `LoopEditorModal`, `InstrumentCapabilitiesModal`,
`PlaylistEditorModal`, `TunerModal`, `InstrumentSettingsModal`,
`SystemAdminModal`). Les autres réimplémentent leur DOM à la main et n'héritent
d'aucune garantie :

| Modale | Lignes | `role="dialog"` | `aria-modal` | Échap | Piège de focus |
|---|---|---|---|---|---|
| `KeyboardPiano.js` | 2 337 | ✗ | ✗ | **✗** | ✗ |
| `MidiEditorModal.js` (+ 20 modules) | 773 | ✗ | ✗ | **✗** ¹ | ✗ |
| `ISMSections.js` | 3 028 | ✗ | ✗ | ✗ | ✗ |
| `BluetoothScanModal.js` | 958 | ✗ | ✗ | ✗ | ✗ |
| `NetworkScanModal.js` | 696 | ✗ | ✗ | ✗ | ✗ |
| `RoutingSummaryPage.js` | 3 550 | ✗ | ✓ | ✓ | ✗ |
| `DeviceSettingsModal.js` | 299 | ✗ | ✗ | ✓ | ✗ |

¹ `MidiEditorLifecycle.js:142` a bien un gestionnaire `Escape`, mais il ferme la
**sous-boîte « modifications non enregistrées »**, pas l'éditeur. L'éditeur MIDI
— la plus grosse surface de l'application — **ne se ferme pas au clavier**.

**Conséquence d'usage.** Un utilisateur au clavier qui ouvre l'éditeur MIDI ou
le clavier virtuel : la tabulation sort de la modale et parcourt la page
derrière (elle n'est ni `inert` ni `aria-hidden` — prouvé), Échap ne fait rien,
et un lecteur d'écran n'annonce pas qu'un dialogue s'est ouvert. Il faut la
souris pour en sortir.

Même sur `BaseModal`, l'arrière-plan reste atteignable :

```
tests/frontend/l09-a11y-modals.test.js
  ✓ KNOWN DEFECT: background content is neither inert nor aria-hidden
    page.hasAttribute('inert')        → false
    page.getAttribute('aria-hidden')  → null
    document.getElementById('bg').focus() → activeElement.id === 'bg'
```

### Gravité 2 — sévère : 63 % des champs de formulaire n'ont pas de nom

**F-104.** Recensement sur `public/**` (JS **et** `index.html`), champs
`input`/`select`/`textarea` hors `hidden`/boutons :

```
champs de formulaire                        319
  nom accessible par aria-label(ledby)       21
  nom accessible par <label for="…">         33
  nom accessible par <label> englobant       63
  AUCUN nom accessible                      202   (63,3 %)
      dont title=                            17
      dont placeholder seul                  45   (non conforme : le
                                                   placeholder disparaît
                                                   à la saisie)
      dont RIEN DU TOUT                     140
par type : text 99 · number 77 · range 14 · color 7 · file 3 · password 1
```

Concentration : `lighting/LightingForms.js` 62, `ISMSections.js` 34,
`index.html` 22, `StringInstrumentConfigModal.js` 12.

Le motif est systématique et **trivialement corrigeable** : chaque `<label>`
précède un `<input id="…">` mais **sans `for=`**. Exemple
`LightingForms.js:16-17` :

```html
<label style="…">${i18n.t('lighting.deviceName') || 'Nom'} *</label>
<input id="ldFormName" type="text" placeholder="LED RGB Salon" style="…">
```

Tous les champs portent déjà un `id` : ajouter `for="…"` sur ~200 sites est
mécanique. Non appliqué ici — 20 fichiers touchés simultanément à 14 agents,
c'est exactement le genre de correctif que la règle 5 demande d'éviter.
Échec WCAG 1.3.1 (Info et relations), 3.3.2 (Étiquettes), 4.1.2 (Nom, rôle,
valeur).

**Boutons icône** — le projet en est riche (⚙️ 🔊 🛠️ 🗑 ✏️ ⬆ ⬇) :

```
boutons <button> à contenu littéral analysés     582
  à contenu icône seule                          208
    sans aria-label / aria-labelledby            164
      reposant sur title= (dégradé mais lu)      131
      AUCUN nom accessible                        33   (35 avant ce lot)
```

Les 33 restants incluent `LightingDeviceUI.js:106/108/160` (éditer/supprimer une
règle), `LightingPresetsUI.js:20` (supprimer un préréglage),
`MidiEditorCCPicker.js:78` (✕), `RoutingSummaryRenderers.js:158/159`
(pause ⏸ / stop ⏹ de la prévisualisation), `LoopEditorModal.js:245-254`
(‹ ›), `ISMSections.js:953/957` (◀ ▶). Un lecteur d'écran annonce « bouton ».

### Gravité 3 — sérieux : le piège de focus et l'empilement de modales

**F-100 — corrigé.** Le piège de focus de `BaseModal` sélectionnait
`'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'`
**sans exclure `[disabled]`**. Si le dernier nœud de la liste est un bouton
désactivé — cas courant : un « Enregistrer » désactivé tant que le formulaire
est invalide — `document.activeElement === last` n'est jamais vrai, la
tabulation ne boucle pas et **sort de la modale**. Reproduit :

```
focusable list  [ 'modal-close', 'a', 'b', 'c' ]
last is disabled?  true  (id="c")
```

Correctif : filtrage `:not([disabled])` + exclusion de `[hidden]` /
`aria-hidden="true"`, aligné sur `_focusFirst()` qui, lui, filtrait déjà
correctement. Régression couverte par deux tests (« never treats a disabled
control as the trap boundary », « wraps Tab from the last control back to the
first »).

**F-99 — ouvert.** Deux défauts liés, dans `BaseModal` :

1. `_escHandler` est posé sur `document` par **chaque** modale ouverte et ne
   teste que `this.isOpen`. Avec deux modales empilées, **une seule pression
   sur Échap les ferme toutes les deux**. L'utilisateur qui ferme une
   sous-boîte de confirmation perd aussi l'écran en dessous, et son travail en
   cours avec.
2. `close()` remet `document.body.style.overflow = ''` sans compter les modales
   restantes : fermer la modale interne **déverrouille le défilement du corps
   sous la modale externe encore ouverte**.

Reproduits tous les deux (tests marqués `KNOWN DEFECT`, à inverser le jour où
`BaseModal` tiendra une pile). Correctif recommandé : un compteur statique
`BaseModal._stack` ; seul le sommet traite Échap, et `overflow` n'est restauré
qu'à `_stack.length === 0`. Non appliqué : ce n'est plus un correctif local.

### Gravité 4 — dégradé mais utilisable : contraste

**F-106.** Ratios WCAG calculés sur les tokens de `variables.css` :

| Paire | Ratio | Verdict |
|---|---|---|
| clair · `--text-primary #1a1040` / fond `#eae4f7` | **14,21** | AA ✓ |
| clair · `--text-secondary #4a3f6b` / `#eae4f7` | **7,65** | AA ✓ |
| clair · `--text-muted #8078a0` / `#eae4f7` | **3,31** | ✗ AA texte |
| clair · `--text-muted #8078a0` / carte blanche | **4,11** | ✗ AA texte |
| clair · `--status-ok #27ae60` / blanc | **2,87** | ✗ |
| clair · `--status-warning #f39c12` / blanc | **2,19** | ✗ |
| clair · `--text-disabled #b8b2cc` / `#eae4f7` | **1,65** | ✗ (toléré : désactivé) |
| sombre · `--text-primary #e0e0e0` / `#1a1a1a` | **13,18** | AA ✓ |
| sombre · `--text-muted #718096` / `--bg-secondary #2d3748` | **2,99** | ✗ AA texte |
| sombre · `--danger-color #e8365d` / `#2d3748` | **2,92** | ✗ |
| sombre · `--accent-primary #667eea` / `#2d3748` | **3,28** | ✗ AA texte |

Le corps de texte passe partout : le squelette est sain. Ce qui échoue est
`--text-muted` (les libellés secondaires, très employés) et la **palette d'état
du routage** utilisée comme couleur de texte — or c'est le signal qui dit à
l'utilisateur si son fichier MIDI est jouable. Assombrir `--status-ok` vers
`#1e8449` (4,54:1) et `--status-warning` vers `#a35d00` (4,58:1) suffit ;
`--text-muted` doit descendre à ≈ `#6b6488` en clair et monter à ≈ `#93a3b8` en
sombre.

### Ce qui va déjà bien — à ne pas casser

- **`accessibility-focus.css` est correct et efficace.** 92 lignes, chargées
  **en dernier** (vérifié : c'est bien le dernier `<link rel="stylesheet">` de
  `index.html`), qui réaffirment un anneau de focus `:focus-visible` en
  `!important` par-dessus les **45 `outline: none`** répartis dans 16 feuilles.
  Variante `prefers-contrast: more` incluse. C'est la bonne réponse
  architecturale au problème, et elle est en place.
- **Lien d'évitement** présent (`<a href="#app" class="sr-only sr-only-focusable">`)
  et sa cible `id="app"` existe. Son libellé « Skip to main content » est
  toutefois **en dur en anglais**, non i18n (relève de F-97).
- **`document.documentElement.lang` est mis à jour au changement de langue**
  (`I18n.js:157`) — beaucoup d'applications oublient ce point.
- `BaseModal` pose `role="dialog"`, `aria-modal="true"`, `aria-labelledby`
  pointant sur un `<h2>` réellement présent, restaure le focus à l'ouvrant à la
  fermeture, et nomme son propre bouton de fermeture. Les 10 modales qui en
  héritent sont dans un état correct.
- `Toast.js` utilise `role="alert"` / `role="status"` avec les `aria-live`
  correspondants. 11 usages d'`aria-live` au total dans le frontend — peu, mais
  posés au bon endroit.
- **Correctif de ce lot** : les boutons de fermeture de `KeyboardPiano.js:114`
  et `MidiEditorView.js:66` — les deux plus grosses modales — reçoivent
  `aria-label="${t('common.close')}"` (la clé existe dans les 28 locales).

---

## 4. Discipline `t()` / `tHtml()` — l'erreur inverse

`CLAUDE.md` impose `tHtml()` pour tout ce qui part en `innerHTML` /
`insertAdjacentHTML`, et `t()` pour `textContent` et les *propriétés* DOM
`.title` / `.value` / `.placeholder`. Le scanner de sécurité cherche le sens
« pas assez échappé ». Ce lot a cherché **le sens inverse** : de l'échappement
sur un puits textuel, qui ne crée aucune faille mais affiche `&amp;` ou `&#39;`
à l'écran — un bug d'affichage réel qu'aucun test ne voit.

```
node scripts/audit/xss-sinks.mjs
HTML sinks in public/js : 257     DYNAMIC 116 · CLEAN 114 · RISKY 27
```

**Résultat : une seule occurrence sur tout le frontend.**

**F-98 — corrigé.** `public/js/features/PlaylistPage.js:388` :

```js
if (title) title.textContent = this._escapeHtml(this.selectedPlaylist.name);
```

`textContent` n'interprète jamais de balisage : pré-échapper y est
systématiquement faux. Une liste de lecture nommée `Rock & Roll` s'affichait
`Rock &amp; Roll`, et `L'été` s'affichait `L&#39;été`. Corrigé en assignant le
nom brut (aucune régression de sécurité possible : `textContent` est inerte).

Contrôles complémentaires, tous négatifs (= sains) :

- Aucun `setAttribute('title'|'placeholder'|'aria-label', escape(...))`.
- Les 6 vrais sites d'appel de `tHtml()` (`MidiEditorChannelPanel:280`,
  `MidiEditorDialogs:142`, `MidiEditorRenderer:79/88`, `MidiEditorInfoModal:138`,
  `BluetoothScanModal:532`) alimentent tous un puits HTML — aucun double
  échappement. Les `title="…"` de `MidiEditorRenderer` sont des attributs
  **à l'intérieur d'un littéral HTML**, où `tHtml()` est le bon choix (la règle
  « `t()` pour `.title` » vise la propriété DOM, pas l'attribut sérialisé).
- `public/index.html` : **0 double échappement** dans ses 8 316 lignes de JS
  inline.

**À déléguer à L10 (sécurité), constaté ici sans conclure :**

- 79 appels `t(clé, {params})` dans `public/js/**`, dont **10 sur une ligne
  portant du balisage HTML**. Inspectés un par un : tous les paramètres sont des
  **nombres** (`{channel: i + 1}`, `{count: noteCount}`) ou des littéraux
  `defaultValue`. Aucune donnée utilisateur, donc aucun besoin de `tHtml()` —
  mais le verdict XSS appartient à L10.
- **`public/index.html` contient 44 puits `innerHTML`/`insertAdjacentHTML`,
  122 appels `t(…)`, et zéro `tHtml(…)`.** La discipline documentée dans
  `CLAUDE.md` n'y est **pas appliquée du tout** — et c'est le fichier que les
  scanners ignoraient jusqu'à L13. À instruire par L10 en priorité.

---

## 5. §AT — CSS

```
29 feuilles           34 232 lignes      685 !important
index.html <style>     5 340 lignes       86 !important
                     ─────────────       ───
                      39 572 lignes      771  → 1 pour 51 lignes
attributs style="" : 1 001 dans les gabarits JS + 78 dans index.html
```

### F-101 — corrigé · des `var()` sans repli sur des tokens inexistants

Recensement sur `public/**` (CSS + JS + HTML, car des `var()` sont écrits depuis
les gabarits JS) :

```
propriétés personnalisées déclarées   153
                          utilisées   142
utilisées mais jamais déclarées        28
  dont AVEC valeur de repli            25   → sans effet visible, acceptable
  dont SANS valeur de repli             3   → --bg-medium --bg-light --bg-dark
```

Un `var(--x)` sans repli dont `--x` n'est déclaré nulle part rend la
**déclaration entière invalide au moment du calcul** : la propriété retombe sur
sa valeur héritée/initiale — pour un `background`, transparent. Les 3 tokens
appartiennent à un ancien schéma de nommage que `variables.css` a remplacé par
`--bg-primary|secondary|tertiary`, et ils survivent dans `keyboard.css` (issu de
la fusion de 3 anciennes feuilles en 2026-05) sur **9 déclarations** :
`.keyboard-controls`, `.keyboard-canvas-wrapper`, `.note-range-display`,
`.btn-preset`, `.btn-preset:hover` (`color`)… c'est-à-dire les panneaux du
clavier virtuel.

Corrigé par ajout de replis (`var(--bg-medium, var(--bg-secondary))`, etc.), ce
qui restaure le rendu sans figer le nommage. Ratchet posé :
`l09-css-contracts.test.js` échoue si un nouveau `var()` sans repli vise un
token inexistant.

### F-102 — corrigé · un token clair conservé en thème sombre

`--bg-primary-flat` n'était déclaré **que** dans `:root` (`#eae4f7`, lavande
clair) et jamais redéfini dans `body.dark-mode` ni dans le bloc
`@media (prefers-color-scheme: dark)`. Il sert de fond à
`.piano-roll-view` (`piano-roll-view.css:7`, **sans repli**) et à
`.lyrics-ribbon` (`lyrics-view.css:15`). En thème sombre le fond restait donc
clair pendant que `--text-primary` basculait à `#e0e0e0` :

```
contraste #e0e0e0 sur #eae4f7 = 1,06:1     (seuil AA : 4,5)
```

Texte littéralement invisible dans la vue piano-roll et le bandeau de paroles en
thème sombre. Corrigé : `--bg-primary-flat: #1a1a1a` ajouté aux deux blocs
sombres. Le test vérifie désormais la **parité de thème** sur les 9 tokens de
surface et de texte, pas seulement ce cas.

### F-107 — CSS mort et guerre de spécificité

```
classes CSS distinctes déclarées                     2 735
jamais référencées dans public/**/*.{js,html}          779   (28,5 %)
variables CSS déclarées jamais utilisées                39
```

| Feuille | Classes mortes |
|---|---|
| `auto-assign-modal.css` (6 856 l.) | **390** |
| `keyboard.css` | 70 |
| `lighting-modal.css` | 66 |
| `themes.css` | 55 |
| `playlist.css` | 52 |
| `components.css` | 41 |

Les 390 de `auto-assign-modal.css` sont le squelette de l'ancien
`AutoAssignModal` (le fichier JS n'existe plus ; seules `RoutingSummaryPage.js`
et `RoutingSummaryRenderers.js` utilisent encore des classes `.rs-*` de cette
feuille). Toute la famille `.aa-confirm-*`, `.aa-container`, `.aa-header-*`,
`.aa-range-*` est orpheline.

> **Recoupement avec L14.** L14 conclut qu'il n'y a pas de CSS orphelin ; c'est
> exact **au niveau fichier** — les 29 feuilles sont toutes chargées par
> `index.html`. La mesure ci-dessus est **au niveau sélecteur** : ce sont des
> règles mortes à l'intérieur de feuilles vivantes. Les deux constats sont
> compatibles.

Dommages collatéraux repérés dans `accessibility-focus.css` : 4 de ses
22 sélecteurs personnalisés (`.rs-tab-btn`, `.ism-tab-btn`, `.drum-cell`,
`.calibration-tab`) ne correspondent à **aucune** classe existante — le filet de
sécurité du focus couvre moins que ce que son commentaire annonce. Sans gravité
(les sélecteurs génériques `button`/`[role="button"]` reprennent le relais),
mais à nettoyer en même temps.

**771 `!important` et 1 079 attributs `style="…"`** restent le vrai frein : ils
rendent tout travail de thème et de responsive plus coûteux à chaque itération.
La recommandation P3 du 2026-08-22 (« budgétiser les `!important` à la baisse,
en commençant par retirer les `style=` des HTML générés ») reste valide et
non entamée.

---

## 6. §AO — Responsive (mesure statique uniquement)

jsdom n'a pas de moteur de mise en page : il est impossible de mesurer un
débordement sans navigateur. Ce qui suit est de l'analyse statique, et §AO reste
`PARTIAL` niveau 2. La vérification à 320/375/768/1024 px appartient au harnais
L08.

**Le point rassurant** : les modales géantes **sont** adaptatives.

| Modale | Règle | Bascule mobile |
|---|---|---|
| `RoutingSummaryPage` (3 550 l.) | `.rs-container { width: 95vw; max-width: 1200px; height: 85vh }` | — |
| `InstrumentSettingsModal` (ISM) | `.ism-modal .modal-dialog { width: 95%; max-width: 1100px }` | `@media (max-width: 768px)` → plein écran, `border-radius: 0` |
| `LightingControlPage` | `.lighting-modal-container { width: 95%; max-width: 1400px }` | `@media (max-width: 768px)` → plein écran |

Aucune largeur fixe supérieure à 420 px sur un conteneur de modale, hormis
3 dialogues de formulaire de `lighting-modal.css` (`--md 420px`, `--lg 460px`,
`--xl 520px`) qui **déborderont sur un écran de 375 px**.

**Points de rupture** : `max-width: 768px` ×20, `640px` ×7, `480px` ×5,
`900px` ×4, plus des variantes grand écran (`min-width: 1200/1800/2400px`).
La cible tablette est donc traitée ; le téléphone l'est inégalement.

**Risques identifiés, non confirmés en rendu :**

- **8 feuilles n'ont aucune media query**, dont 5 stylent une modale complète :
  `calibration-modal.css` (721 l.), `loop-editor-modal.css` (806 l.),
  `tuner-modal.css` (401 l.), `instrument-capabilities-modal.css` (328 l.),
  `keyboard-hand-position-editor.css` (210 l.). Ces modales **ne s'adaptent
  jamais**.
- **53 `grid-template-columns` figées contre 18 adaptatives** (`auto-fit` /
  `minmax`). La plus exposée : `playlist.css` avec `280px 1fr 300px` — 580 px de
  colonnes fixes, il ne reste que 188 px à la colonne centrale sur une tablette
  768 px (des surcharges existent à 1200/992/768 px, à vérifier en rendu).
- **190 `white-space: nowrap` pour seulement 21 conteneurs `overflow-x`.**
  C'est le principal candidat au débordement horizontal.
- 4 `min-width ≥ 320px` sur du contenu interne (`.rename-dialog` 400 px,
  `.instrument-dropdown` 360/320 px, `.filters-panel` 320 px) : débordement
  garanti à 320 px de large.
- 13 `<table>` générés ; aucune corrélation automatique avec un conteneur
  défilant n'a pu être établie statiquement.

---

## 7. §AU / §AV — Mémoire

**F-105.** Mesure dynamique en jsdom : instrumentation de
`document/window.addEventListener|removeEventListener`, **50 cycles
ouverture/fermeture**, puis bilan net des écouteurs, du DOM résiduel et du
verrou de défilement.

| Sujet | Écouteurs nets après 50 cycles | DOM résiduel | Verdict |
|---|---|---|---|
| `BaseModal` (sous-classe minimale) | `keydown: 0` | 0 | **PASS** |
| `SystemAdminModal` (sous-classe réelle) | `keydown: 0` | 0 | **PASS** |
| `DeviceSettingsModal` (écrit à la main, hors `BaseModal`) | `keydown: 0` | 0 | **PASS** |

Le résultat est meilleur qu'attendu : `BaseModal._detachCoreHandlers()` retire
bien ses trois gestionnaires, et `DeviceSettingsModal` — qui n'hérite de rien —
retire son `escHandler` et se désabonne de `api.off('device_identity')` dans
`close()`.

**Bilan statique complémentaire** (`public/js/**`, 190 fichiers) :

```
document|window.addEventListener      115
document|window.removeEventListener   133      → excédent de retraits
setInterval 9 / clearInterval 14 · setTimeout 114 / clearTimeout 66
requestAnimationFrame 91 / cancelAnimationFrame 26
4 fichiers seulement ont plus d'ajouts que de retraits :
  MidiEditorResize.js (4/0)  → faux positif : AbortController + { signal }
  InstrumentSettingsModal.js, LoopManagerArrangerView.js, SettingsSF2.js (1/0)
```

**Ce que la mesure ne couvre pas, et qu'il faut dire :**

- **`public/index.html` : 22 `addEventListener` globaux pour 4 retraits.** Ces
  écouteurs appartiennent au cycle de vie de la page (le shell de la SPA), donc
  un test ouverture/fermeture ne s'y applique pas ; mais ce fichier concentre
  8 316 lignes de logique et n'a **jamais** été analysé jusqu'à L13. À couvrir
  par le harnais L08.
- Les vraies fuites plausibles dans ce projet sont des **nœuds DOM détachés
  référencés par un canvas** et des **AudioNode / AudioContext orphelins**
  (piano-roll, `MidiSynthesizer`). jsdom n'a ni canvas ni WebAudio : cela reste
  `NOT TESTED` et exige `performance.measureUserAgentSpecificMemory()` ou un
  instantané de tas dans Chromium. Le scénario du plan (ouvrir/fermer ×100,
  changer de fichier ×100, lire/arrêter ×100, puis diff du tas) appartient à L08.
- `MidiEditorLifecycle.js:141` : le gestionnaire `Escape` de la boîte
  « modifications non enregistrées » est retiré sur **les quatre** sorties
  (Échap, Annuler, Enregistrer, Abandonner) — vérifié ligne à ligne, pas de
  fuite. Bonne discipline, à citer en exemple.

---

## 8. §AM / §AN — Inventaire et parcours

**§AM — PARTIAL, niveau 1.** Le recensement statique donne la matière première
que le plan réclame : **582 `<button>` littéraux** (dont 208 icône seule),
**319 champs de formulaire**, **~23 classes de modales**, **147 des 270
commandes backend appelées depuis le frontend** (`command-inventory.mjs`).
La chaîne complète `action → événement → backend → résultat → retour visuel`
exige de piloter l'UI : elle appartient à L08 et L13.

**§AN — NOT TESTED, niveau 0.** Les dix parcours débutants (installer → ouvrir
→ connecter un instrument → configurer → importer → auto-assigner → adapter →
prévisualiser → jouer → corriger → boucler) demandent d'observer de vraies
personnes. Compter les clics depuis le code produirait une fausse assurance.
Une observation structurelle demeure : **202 champs sans nom, 33 boutons
anonymes et 358 clés d'interface en anglais** sont autant d'obstacles ajoutés à
un public annoncé comme *débutant*.

**§AP / §AQ — HW REQUIRED.** Multitouch sur claviers virtuels, Safari iOS
(déverrouillage `AudioContext`), Chromium sur Pi : aucun substitut statique.

---

## 9. Findings

| # | Sev | Titre | État | Preuve |
|---|---|---|---|---|
| **F-96** | **P2** | Le module Lumière (358 clés, 13,1 % de l'interface) n'est traduit dans **aucune** des 17 locales `cs da el fi hi hu ja ko nl no pl pt ru sv tr uk zh-CN` | **OUVERT** | §2.4 · `l09-i18n-completeness.test.js` |
| **F-97** | **P2** | ≥ 313 chaînes d'interface codées en dur en français hors i18n (244 dans `public/js/**`, 69 dans le JS inline d'`index.html`) — invisibles pour `audit-i18n.test.js` | **OUVERT** | §2.5 |
| **F-98** | P3 | Double échappement : `PlaylistPage.js:388` échappait un nom de liste avant `textContent` (`Rock &amp; Roll` à l'écran) | **CORRIGÉ** | §4 |
| **F-99** | **P2** | `BaseModal` : une pression sur Échap ferme **toutes** les modales empilées ; fermer la modale interne déverrouille le défilement sous l'externe | **OUVERT** | §3 g3 · tests `KNOWN DEFECT` |
| **F-100** | **P2** | Piège de focus de `BaseModal` désarmé par un contrôle désactivé en dernière position — la tabulation sortait de la modale | **CORRIGÉ** | §3 g3 |
| **F-101** | P3 | 9 déclarations `var(--bg-medium\|--bg-light\|--bg-dark)` sans repli sur des tokens jamais déclarés → déclaration invalide, fonds transparents dans le clavier virtuel | **CORRIGÉ** | §5 |
| **F-102** | **P2** | `--bg-primary-flat` non redéfini en thème sombre → texte à **1,06:1** dans la vue piano-roll et le bandeau de paroles | **CORRIGÉ** | §5 |
| **F-103** | **P2** | 13 des ~23 modales — dont `MidiEditorModal`, `KeyboardPiano`, `ISMSections` — n'ont ni `role="dialog"`, ni `aria-modal`, ni Échap, ni piège de focus ; l'arrière-plan n'est jamais `inert`/`aria-hidden` | **OUVERT** | §3 g1 |
| **F-104** | **P2** | 202/319 champs de formulaire sans nom accessible (140 sans rien) ; 33 boutons icône anonymes ; 131 ne reposent que sur `title=` | **OUVERT** | §3 g2 |
| **F-105** | P3 | Mémoire : aucune fuite d'écouteur ni de DOM sur 50 cycles (3 modales testées). Le JS inline d'`index.html` pose 22 écouteurs globaux pour 4 retraits ; canvas/WebAudio non couverts | **PARTIAL** | §7 |
| **F-106** | P3 | Contraste : `--text-muted` échoue AA dans les deux thèmes (3,31 / 2,99) ; la palette `--status-*` échoue AA comme texte (2,87 / 2,19) | **OUVERT** | §3 g4 |
| **F-107** | P3 | 779/2 735 classes CSS (28,5 %) et 39 variables jamais référencées, dont 390 classes orphelines dans `auto-assign-modal.css` ; 771 `!important` ; 1 079 attributs `style=` | **OUVERT** | §5 |

**Re-statut demandé par L00 :** **F-12 → CONFIRMÉ OUVERT et aggravé**, remplacé
par F-96 (cause dominante) et F-97 (part de l'interface hors i18n). Voir §2.5.

---

## 10. Correctifs appliqués dans ce lot

Tous petits, locaux, prouvés par un test, confinés à `public/js/**` et
`public/styles/**`. Aucun fichier de locale, aucun fichier partagé, aucune
commande git, aucune installation.

| Fichier | Changement | Finding |
|---|---|---|
| `public/js/features/PlaylistPage.js` | `textContent = name` au lieu de `textContent = escapeHtml(name)` | F-98 |
| `public/js/core/BaseModal.js` | Piège de focus : exclusion de `[disabled]`, `[hidden]`, `aria-hidden="true"` | F-100 |
| `public/styles/keyboard.css` | 9 `var()` dotés d'un repli vers les tokens actuels | F-101 |
| `public/styles/variables.css` | `--bg-primary-flat` déclaré dans `body.dark-mode` et dans `@media (prefers-color-scheme: dark)` | F-102 |
| `public/js/features/keyboard/KeyboardPiano.js` | `aria-label` sur le bouton de fermeture | F-104 |
| `public/js/features/midi-editor/MidiEditorView.js` | `aria-label` sur le bouton de fermeture | F-104 |

**Suites ajoutées** (59 tests, vertes) :

| Fichier | Tests | Rôle |
|---|---|---|
| `tests/frontend/l09-i18n-completeness.test.js` | 34 | Estimateur exporté et testé, **ratchet par locale** (27 seuils), garde anti-régression sur le module Lumière |
| `tests/frontend/l09-a11y-modals.test.js` | 14 | Piège de focus, restauration du focus, contrat `dialog`, empilement (`KNOWN DEFECT`), inertie de l'arrière-plan, ratchet des boutons anonymes (33), 3 scénarios mémoire ×50 |
| `tests/frontend/l09-css-contracts.test.js` | 11 | `var()` sans repli, parité des tokens de thème, contrastes WCAG, ordre de chargement du filet de focus, lien d'évitement |

Les tests marqués `KNOWN DEFECT` **passent en constatant le défaut** : ils
documentent F-99 et F-103 et deviendront rouges — volontairement — le jour où
le correctif sera fait, ce qui forcera à les inverser plutôt qu'à les oublier.

---

## 11. Recommandations

| Pri | Action | Lot |
|---|---|---|
| **P1** | **Traduire les 358 clés du module Lumière**, ou masquer le module dans les 17 locales qui ne l'ont pas. C'est à lui seul l'essentiel de l'écart i18n. | produit |
| **P1** | Donner un contrat de dialogue aux 13 modales hors `BaseModal` : `role="dialog"`, `aria-modal`, Échap, piège de focus. En priorité `MidiEditorModal` et `KeyboardPiano`, aujourd'hui **impossibles à fermer au clavier**. | vague 2 |
| **P2** | Ajouter `for="…"` aux ~200 `<label>` orphelins (tous les champs ont déjà un `id`) — correctif mécanique, gain WCAG immédiat. | vague 2 |
| **P2** | `BaseModal._stack` : seul le sommet traite Échap ; `body.overflow` restauré au dernier `close()`. | vague 2 |
| **P2** | Sortir de `public/js/**` et d'`index.html` les ≥ 313 chaînes en dur, vers de vraies clés i18n ; en tête `InstrumentSettingsModal.CC_GROUPS` (descriptions des CC) et `DeviceSettingsModal`. | vague 2 |
| **P2** | Corriger le README (diff exact fourni en §2.6) : la promesse « 28 languages » doit citer le niveau réel par langue. | L14 |
| **P2** | **L10** : `public/index.html` a 44 puits `innerHTML`, 122 `t(…)` et **0 `tHtml(…)`** — la discipline de `CLAUDE.md` n'y est pas appliquée. À instruire en priorité. | L10 |
| **P3** | Assombrir `--status-ok` → `#1e8449`, `--status-warning` → `#a35d00`, ajuster `--text-muted` (`#6b6488` clair / `#93a3b8` sombre). | vague 2 |
| **P3** | Nommer les 33 boutons icône restants (liste dans la sortie du test `l09-a11y-modals`). | vague 2 |
| **P3** | Supprimer les ~390 classes orphelines de `auto-assign-modal.css` et les 4 sélecteurs inexistants d'`accessibility-focus.css`. | vague 2 |
| **P3** | Ajouter une media query aux 5 modales qui n'en ont aucune ; envelopper les 190 `white-space: nowrap` dans un conteneur `overflow-x`. | vague 2 |
| **—** | §AN (parcours), §AP (tactile), §AQ (cross-browser), §AU (TTI/tas) exigent un navigateur, du matériel et des utilisateurs réels : **L08**, **L15**, et une campagne d'observation. Aucun substitut statique. | L08 / L15 |
