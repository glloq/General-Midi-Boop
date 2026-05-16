# Audit ciblé — Modal piano virtuel : complétude des vues spéciales, propreté, réactivité

**Date** : 2026-05-16
**Branche** : `claude/audit-piano-modal-SuNG7`
**Périmètre** : `public/js/features/KeyboardModal.js`,
`public/js/features/keyboard/InstrumentView.js`,
`InstrumentViewRegistry.js`, `InstrumentDetector.js`,
`views/*.js` (15 classes), `views/registerBuiltins.js`,
`public/index.html` (balises script).
**Type de livrable** : audit + application des corrections **sûres**
(validables par tests unitaires + lint ; pas de navigateur dans
l'environnement → smoke visuel listé en suivi manuel Pi).

Complète/affine `AUDIT_KEYBOARD_MODAL_2026-05-14.md` (qui portait sur
l'architecture pré-refactor). Les phases A→E de ce refactor sont
livrées : registre `InstrumentView`, `InstrumentDetector` pur, 15
classes `*View` enregistrées.

---

## Synthèse exécutive

**La couverture des instruments spéciaux est complète et le code des
vues est propre et homogène.** Les 128 programmes GM 0-127 + le canal
9 + `instrument_type` (drum/string/theremin) + `gm_program ≥ 128`
résolvent tous vers une vue dédiée ou le piano de repli. Les 10 vues
autonomes (Harmonica, Harpe, Accordéon, Mallet, Boîte à musique,
Kalimba, Cornemuse, Steel-drum, Theremin, Percussion-pads) suivent
toutes le même contrat propre : `super.mount/unmount`, nettoyage
complet des listeners (y compris ceux posés sur `document`), DOM
auto-possédé retiré au démontage, respect de `getInstrumentNoteRange()`
(plage/notes configurées, jamais codées en dur), i18n via
`getNoteLabel`, `showNoteColors` honoré, glissando partagé via
`_initGlide`. Les 5 vues strangler-fig (Piano/Fretboard/DrumPad/
PianoSlider/List) délèguent proprement aux mixins legacy.

**Un seul défaut fonctionnel réel a été trouvé et corrigé (F4)** : le
contrat `InstrumentView.setActiveNotes()` n'était **jamais câblé** par
le modal. Trois corrections sûres appliquées (F1, F2, F4) ; les
optimisations de réactivité plus profondes restent documentées en
différé (risque non vérifiable sans navigateur).

| # | Finding | Gravité | Statut |
|---|---|---|---|
| F4 | `setActiveNotes()` jamais appelé par `updatePianoDisplay()` | **Élevée** | ✅ Corrigé |
| F1 | Détection encodée 3× (risque de divergence silencieuse) | Moyenne | ✅ Verrouillé (test de parité) |
| F2 | En-têtes/commentaires périmés (viewKind, « 5 views », Phase D) | Faible | ✅ Corrigé |
| F3 | `querySelectorAll` par évènement de note (réactivité) | Faible | 📋 Différé (documenté) |
| N1 | `PianoView.unmount()` : bloc `if` mort (corps = commentaire) | Cosmétique | 📋 Noté |
| N2 | `ThereminView` sans `setCapabilities` | Cosmétique | 📋 Noté (sans impact : plage thérémin fixe) |

Tests : **544/544 verts** sur `tests/frontend/keyboard/` + nouveau
`detector-registry-parity.test.js` vert. Aucune régression introduite
(les 15 échecs du suite global sont **préexistants** et hors périmètre
— `midi-editor-clamp`, `ism-*`, `tablature-renderer-warnings` —
identiques sur l'arbre propre).

---

## 1. Vérification détaillée des 16 vues

Critères : **(1)** enregistrée (`registerBuiltins`) + balise `<script>`
(`index.html`) ; **(2)** `mount()` appelle `super.mount` ; **(3)**
`unmount()` appelle `super.unmount` + retire **tous** les listeners +
son DOM ; **(4)** `setActiveNotes` câblé/justifié ; **(5)**
`setCapabilities` si pertinent ; **(6)** respecte
`getInstrumentNoteRange()` + i18n `getNoteLabel` + `showNoteColors` ;
**(7)** règle de détection cohérente (croisée via le test de parité).

| Vue (viewKind) | Type | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| PianoView (`piano`) | strangler-fig | ✅ | ✅ | ✅¹ | n/a² | `setNoteRange` ✅ | ✅ | ✅ |
| FretboardView (`fretboard`) | strangler-fig | ✅ | ✅ | ✅ (`destroyStringSliders`,`_stopActiveBow`) | n/a² | ✅ `renderFretboard` | ✅ | ✅ |
| DrumPadView (`drumpad`) | strangler-fig | ✅ | ✅ | ✅ | n/a² | ✅ `renderDrumPad` | ✅ | ✅ |
| PianoSliderView (`piano-slider`) | strangler-fig | ✅ | ✅ | ✅ (timers staccato + wind controls) | n/a² | ✅ + `willPlayNote`/`afterPlayNote` | ✅ | ✅ |
| ListView (`keyboard-list`) | strangler-fig | ✅ | ✅ | ✅ (`_destroyKeyboardListInteraction`) | n/a² | `setNoteRange` ✅ | ✅ | ✅³ |
| HarmonicaView (`harmonica`) | autonome | ✅ | ✅ | ✅ (slide+glide listeners) | ✅ slide-aware | rerender préserve slide | ✅ | ✅ |
| HarpView (`harp`) | autonome | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| AccordionView (`accordion`) | autonome | ✅ | ✅ | ✅ | ✅ multi-notes | — | ✅ | ✅ |
| MalletView (`mallet`) | autonome | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| MusicBoxView (`music-box`) | autonome | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| KalimbaView (`kalimba`) | autonome | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| BagpipeView (`bagpipe`) | autonome | ✅ | ✅ | ✅ (drones ref-counted) | ✅ | rerender préserve drones | ✅ | ✅ |
| SteelDrumView (`steel-drum`) | autonome | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| ThereminView (`theremin`) | autonome | ✅ | ✅ | ✅ | n/a (continu) | ⚠️ absent (N2) | ✅ (plage fixe C3..C6) | ✅ |
| PercussionPadView (`perc-pad`) | autonome | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| InstrumentView (base) | abstraite | n/a | garde double-mount | idempotent + `_teardownGlide` | hook no-op | hooks no-op | `_t` fallback | n/a |

¹ Démontage de l'overlay « doigts » délégué au contrôleur (partagé
piano/list) — voir N1.
² Surlignage piloté par le chemin DOM legacy `.piano-key`/`.fret-dot`
de `updatePianoDisplay()` ; `setActiveNotes` base = no-op (correct
après F4).
³ `keyboard-list` n'est PAS produit par `InstrumentDetector` : il est
sélectionné séparément par `KeyboardModal` pour les instruments
`keyboard_type:'chromatic'` (comportement intentionnel, désormais
documenté en en-tête — F2).

**Conclusion complétude** : aucune vue manquante, aucune branche de
détection incomplète, aucun fallback indu. Décisions de conception
intentionnelles confirmées correctes : Timpani (GM 47) et Celesta
(GM 8) restent sur le piano chromatique ; Harpe (GM 46) exclue de la
plage fretboard 24-47 ; Steel-drum (GM 114) garde sa vue dédiée plutôt
que perc-pad ; Mallet (9,11-15) prioritaire sur le fretboard.

---

## 2. Findings & corrections

### F4 — `setActiveNotes()` jamais câblé (Élevée) — ✅ Corrigé

**Constat.** `playNote()`/`stopNote()`
(`KeyboardEvents.js:435/489`) muent `this.activeNotes` puis appellent
`this.updatePianoDisplay()`. Or `updatePianoDisplay()`
(`KeyboardModal.js:274`) ne (dé)active que `.piano-key` /
`.fretboard-container .fret-dot.piano-key` via
`document.querySelectorAll`, et **n'appelle jamais**
`this._activeView.setActiveNotes()`. Vérifié : aucun appelant de
`setActiveNotes` dans tout le module clavier (seul
`KeyboardFingersRenderer` — objet différent — l'expose ;
`view.setActiveNotes` n'est exercé que par les tests
`harp-view`/`harmonica-view`).

Les 10 vues autonomes rendent un DOM aux classes spécifiques
(`.harp-string`, `.kalimba-tine`, …) — jamais `.piano-key`. Leur
`setActiveNotes()` soigneusement écrit + testé était donc **du code
mort côté modal**. Les vues ne restaient visuellement correctes que
par effet de bord : `_pressCell()` pose `.active` lui-même au press
local. Tout surlignage piloté par une autre source que le press local
(lecture de fichier, futur retour MIDI entrant) ne serait pas reflété —
contrat `InstrumentView` non respecté + smell de code mort.

**Correction.** `KeyboardModal.updatePianoDisplay()` délègue
maintenant, en fin de méthode, à la vue active :

```js
if (this._activeView && typeof this._activeView.setActiveNotes === 'function') {
    this._activeView.setActiveNotes(this.activeNotes);
}
```

**Sûreté.** No-op prouvé pour les 5 vues strangler-fig
(`InstrumentView.setActiveNotes` base = no-op ; le chemin DOM legacy
les gère déjà). Effet correct pour les 10 vues autonomes. Couvert par
les 544 tests clavier verts (dont `view-lifecycle`, `harp-view`,
`harmonica-view`).

### F1 — Détection encodée 3× (Moyenne) — ✅ Verrouillé

**Constat.** La logique « capacités → vue » existe à 3 endroits :
1. `InstrumentDetector.detect()` — **source réellement exécutée** en
   prod via `getInstrumentViewInfo()`.
2. La chaîne `registry.addRule(...)` de `registerBuiltins.js:59-110` —
   **`registry.resolve()` n'est jamais appelé en prod** (vérifié :
   uniquement un commentaire + les tests). Logique jumelle parallèle.
3. La cascade `if (info.isDrum)…else if (info.canFretboard)…` de
   `KeyboardModal.js:1453-1509` — re-dérive le mode depuis les
   booléens ; justifiée par ses effets de bord (config string, panneau
   wind, visibilité du toggle), donc conservée.

Risque : un nouvel instrument ajouté à une source et pas à l'autre
passe inaperçu (les tests valident la source 2, la prod utilise la 1).

**Correction.** Nouveau test `detector-registry-parity.test.js` : il
compare `InstrumentDetector.detect().viewKind` ⇄
`registry.resolve().viewKind` sur **tout GM 0-127** + les formes
spéciales (canal 9, types drum/string/theremin, gm≥128, 46/108/109/
111/114). **Résultat : parité parfaite, aucune divergence existante.**
Les deux sources sont désormais verrouillées : toute future divergence
casse la CI. Pas de changement de comportement.

### F2 — En-têtes/commentaires périmés (Faible) — ✅ Corrigé

- `InstrumentDetector.js` : le commentaire `viewKind ∈ { piano |
  fretboard | drumpad | piano-slider | keyboard-list }` était faux
  (13 kinds, et `keyboard-list` n'est jamais produit ici) → corrigé +
  note explicite sur `keyboard-list`.
- `registerBuiltins.js` : « Register the 5 built-in views » → 15 ;
  commentaire « Phase D will populate these classes » obsolète (Phase D
  livrée) → réécrit ; ajout d'un renvoi vers le test de parité.

Zéro impact runtime.

### F3 — `querySelectorAll` par évènement de note (Faible) — 📋 Différé

`updatePianoDisplay()` fait `document.querySelectorAll('.piano-key')
.forEach(toggle)` (jusqu'à ~96 nœuds) à chaque note-on/off ; le
`setActiveNotes()` des vues autonomes fait de même sur leurs cellules
(N borné, ~9-72). Le **dropdown instruments est déjà optimisé**
(DocumentFragment + `replaceChildren` + délégation — KM-M4 résolu).

Une optimisation par index `Map<midi,élément>` + mise à jour du delta
donnerait un gain mais introduit une invalidation de cache à chaque
`regeneratePianoKeys` (octave/zoom/changement d'instrument) — surface
de bug non négligeable, non vérifiable « sûre » par tests unitaires
seuls (nécessite un profil navigateur). Hors du périmètre « corrections
sûres ». **Recommandation** : à traiter avec une session QA navigateur
(cf. checklist Pi), avec mesure DevTools Performance avant/après.

### N1 — `PianoView.unmount()` : bloc mort (Cosmétique) — 📋 Noté

```js
unmount() {
    const modal = this.ctx && this.ctx.modal;
    if (modal && typeof modal._cleanFingersCanvas === 'function') {
        // commentaire seulement — aucun corps
    }
    super.unmount();
}
```

Le `if` ne fait rien (le teardown de l'overlay doigts est piloté par
le contrôleur car partagé piano/list). Suppression triviale et 100 %
sûre, mais laissée hors de ce lot pour garder la PR centrée sur F4 ;
candidate quick-win à part.

### N2 — `ThereminView` sans `setCapabilities` (Cosmétique) — 📋 Noté

Un changement d'instrument sans changer de viewKind ne re-render pas
le thérémin. Sans impact pratique : la plage thérémin est fixe
(C3..C6, pas de plage configurable). À ajouter seulement si une plage
thérémin configurable est introduite.

---

## 3. Recommandations différées (non appliquées — risque visuel non testable ici)

Tout ceci nécessite une validation visuelle Raspberry Pi impossible
dans cet environnement (cf. `TODO.md` § « Modal piano virtuel — finir
la décommission ») :

- **Unifier les 3 sources de détection** en une seule (faire que la
  cascade `KeyboardModal:1453` consomme `info.viewKind` au lieu de
  re-dériver, et/ou que `getInstrumentViewInfo` délègue à
  `registry.resolve`). Le test de parité F1 sécurise déjà ce
  refactor.
- **Décommission des mixins legacy** `KeyboardPiano.js` (~2 168 l.) :
  porter le rendu des 5 vues strangler-fig dans leurs `*View`.
- **Externaliser le template HTML** `createModal` (~180 l.).
- **Split de l'état** `config`/`state`/`ui` sur `KeyboardModal`.
- **F3** : index/delta du surlignage des notes actives.
- Réduction des `!important` CSS keyboard.

## 4. Vérification & suivi manuel Pi

Automatisé (fait) : `npx vitest run tests/frontend/keyboard/` →
**544 verts** + `detector-registry-parity.test.js` vert ; `eslint`
sur les fichiers modifiés → 0 erreur (1 warning `no-console`
préexistant, inchangé).

Smoke visuel à faire sur Pi (non automatisable ici) :
1. Ouvrir le modal sur : piano (GM 0), guitare (24), batterie ch.9,
   sax (65), harpe (46), accordéon (21), harmonica (22), kalimba
   (108), steel-drum (114), thérémin (`instrument_type='theremin'`).
2. Vérifier que chaque vue spécifique s'affiche, joue, et **surligne
   les notes** (F4) — y compris lors d'une lecture de fichier routée
   sur le canal, pas seulement au clic.
3. Octave ↑/↓ + zoom + drag minimap (vues piano/list).
4. Mod wheel + pitch bend ; articulations wind ; slide harmonica ;
   bourdons cornemuse (master + individuels).
5. Ouvrir/fermer ×10 + changer d'instrument ×10 → heap stable
   (DevTools Memory : pas de fuite de listeners/DOM).

---

**Fin du rapport.**
