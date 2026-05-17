# Audit Modale Boucles — 2026-05-11

Branche : `claude/audit-modal-loops-ngQuE`
Périmètre : `public/js/features/LoopCreatorModal.js`,
`public/js/features/LoopEditorModal.js`,
`public/js/features/LoopCreatorMinimap.js`,
`public/js/features/loop/LoopUtils.js`,
`public/styles/loop-creator-modal.css`,
`public/styles/loop-editor-modal.css`,
`src/api/commands/LoopCommands.js`,
`src/api/commands/LoopArrangementCommands.js`,
`src/persistence/tables/LoopsDB.js`,
`src/persistence/tables/LoopArrangementsDB.js`,
`src/repositories/Loop*.js`,
`migrations/017_loops.sql`, `migrations/018_loop_arrangements.sql`,
`public/locales/*.json`. Lecture statique uniquement, pas d'exécution
dynamique. ~6 000 lignes de JS + ~2 000 lignes de CSS + ~220 lignes
de backend analysées.

## Résumé exécutif

**~40 findings** retenus après tri (10 🔴 logique/MIDI, 8 🔴 backend,
10 🔴 a11y, 8 🟠 i18n/mobile/UX, plus archi/dette). Quatre points
méritent action immédiate :

1. **`midi_data` non validé côté backend** — `LoopCommands.js:19-28`
   et `LoopsDB.js:34` acceptent n'importe quel JSON (corrompu,
   `Infinity`, `NaN`, taille illimitée). N'importe quel client WS peut
   stocker 16 MB de garbage (DoS), `tempo:"fast"`, `time_sig_den:0`.
   Aucun fichier `loop.schemas.js` n'existe ; `JsonValidator.js`
   ignore complètement les commandes `loop_*` et `arrangement_*`.
2. **6 `confirm()` natifs sur actions destructives** —
   `LoopCreatorModal.js:491,1440,1633,1647,1654`, `LoopEditorModal.js:368`.
   Non stylables, brisent le focus trap de `BaseModal`, non
   traduites en runtime. `window.showConfirm` existe déjà (cf.
   `PlaylistPage.js:756`) et est utilisé par 5 autres features.
3. **Collision de canaux MIDI sur arrangement > 16 programmes** —
   `LoopCreatorModal.js:2417-2422`, `chIdx++ % 16` réutilise
   silencieusement les canaux au-delà de 16, écrasant le
   `setChannelInstrument`. Symptôme utilisateur : instruments
   « impairs » sortent avec le mauvais son.
4. **God-class 2 744 lignes** — `LoopCreatorModal.js` fait Library +
   Pad + Live + Arranger + header MIDI-out. Bloque tout test ciblé et
   toute revue de PR.

Voir §Ordre d'attaque suggéré pour la roadmap.

---

## 🔴 Bugs MIDI / logique critiques

### L1. Tail-time tronqué : notes coupées en fin de preview
**Catégorie** : correctness / audio
**Localisation** : `public/js/features/LoopEditorModal.js:1044-1070`.

`_previewViaDevice()` calcule la fin de preview comme
`setTimeout(cleanup, totalTicks * spt * 1000)`. `totalTicks` est la
longueur du loop en ticks, mais la **dernière note** peut tenir
plusieurs ticks au-delà (note-off > note-on + duration). Quand le
cleanup tire, les notes encore actives sont coupées brutalement sur
le device MIDI : le synthé garde une enveloppe en cours mais on
envoie `note_off`, ou pire on ne l'envoie pas du tout et la note
reste tenue.

**Fix** : calculer `tailMs = max(noteOnMs + durationMs) for note in seq` +
50 ms de marge, et utiliser `tailMs` comme délai de cleanup.

**Effort** : S

---

### L2. Race condition `_stopMidiInMonitor` → events après close
**Catégorie** : correctness / lifecycle
**Localisation** : `public/js/features/LoopEditorModal.js:859-893`.

`_startMidiInMonitor` fait `await this.api.sendCommand('monitor_start', …)`
mais ne pose pas de garde de session : si l'utilisateur ferme la
modale pendant cet await, le handler `_midiInHandler` est attaché
**après** `onClose`. `_stopMidiInMonitor` (ligne 882-893) appelle
`this.api.off?.('monitor_event', this._midiInHandler)` mais le
handler n'a jamais été enregistré dans cet ordre, donc il reste
attaché.

Conséquence : leak mémoire + crashes potentiels sur la prochaine
ouverture (handler appelle `this.dialog.querySelector` sur un DOM
détaché).

**Fix** : poser un `this._monitorSessionId = Symbol()` au start,
vérifier qu'il n'a pas changé après l'`await`, et invariant
`_stopMidiInMonitor` détache **toujours** le handler même si la
commande WS échoue.

**Effort** : S

---

### L3. Drag-resize Arranger : `boundingClientRect` capté au mousedown
**Catégorie** : correctness / UX
**Localisation** : `public/js/features/LoopCreatorModal.js:2697-2714, 2918-2927`.

`_onDocMouseMove` calcule la nouvelle valeur de `repetitions` à
partir de `r.leftPx` et `r.barW` capturés au mousedown
(`rect = blockEl.getBoundingClientRect()`). Si la fenêtre est
redimensionnée pendant le drag, ou si le scroll horizontal du
container change, ces valeurs deviennent obsolètes : l'utilisateur
glisse à la position N visuellement mais le code calcule une autre
valeur.

**Fix** : recalculer `barW` et `leftPx` à chaque `mousemove` via
`this._arrCellsEl.getBoundingClientRect()`. Cache d'invalidation à
chaque `resize` / `scroll`.

**Effort** : S

---

### L4. Allocation canaux MIDI : collision silencieuse au 17ᵉ programme
**Catégorie** : correctness / audio
**Localisation** : `public/js/features/LoopCreatorModal.js:2410-2425`.

```js
let chIdx = 0;
for (const prog of programsToLoad) {
    const ch = chIdx++ % 16;
    programChannelMap.set(prog, ch);
    await this._synth.setChannelInstrument(ch, prog);
}
```

Le `% 16` masque le wrap : programmes #17, #18… écrasent les
canaux 0, 1, … en réassignant le `setChannelInstrument`. Le program
#1 finit alors par jouer avec le timbre du #17. Aucun avertissement
utilisateur. Cas pathologique mais atteignable avec un orchestral
template.

**Fix** : (a) limiter à 16 programmes distinct dans la validation
schema `arrangement_add_block` (Phase backend), et (b) côté UI,
toast clair « Max 16 programmes distincts par arrangement » au
moment du `_play`. Conserver le `% 16` est faux ; mieux vaut refuser
la lecture que la fausser.

**Effort** : M

---

### L5. Count-in : dérive `setTimeout` cumulative
**Catégorie** : correctness / audio
**Localisation** : `public/js/features/LoopEditorModal.js:799-820`.

```js
const secPerBeat = 60 / this.tempo;
const tick = () => {
    this._playMetronomeClick(/*…*/);
    if (++beat < total) setTimeout(tick, secPerBeat * 1000);
    else then();
};
setTimeout(tick, secPerBeat * 1000);
```

`setTimeout` n'a aucune garantie de précision (4 ms min, +jitter
JS). Sur 4 mesures à 60 BPM (16 ticks), la dérive cumulée atteint
souvent 100-200 ms. L'utilisateur démarre l'enregistrement en
décalage perceptible.

**Fix** : planifier sur `AudioContext.currentTime + N * secPerBeat`
(le métronome utilise déjà un `AudioContext`). Chaque click est
prévu absolument, pas relativement au précédent.

**Effort** : M

---

### L6. `AudioContext` du métronome jamais `.close()`
**Catégorie** : perf / resource leak
**Localisation** : `public/js/features/LoopEditorModal.js:730-752`.

`_ensureMetronomeCtx()` crée un `new AudioContext()` la première
fois mais aucun appel à `close()` dans `onClose()`. Le navigateur
limite ≈6 AudioContexts par tab. Après 6 cycles d'ouverture/fermeture
de l'éditeur (avec métronome activé), `new AudioContext()` throw
et le métronome est silencieux jusqu'à reload.

**Fix** : `this._metronomeCtx?.close()?.catch(()=>{})` et
`this._metronomeCtx = null` dans `onClose()`.

**Effort** : S

---

### L7. Stop live loop : notes en cours ne reçoivent pas note-off
**Catégorie** : correctness / audio
**Localisation** : `public/js/features/LoopCreatorModal.js:1536-1577`.

Quand un loop Live est arrêté, `state.timers.forEach(clearTimeout)`
annule les futurs `playNote`, mais les notes **déjà jouées** dont
le note-off est planifié continuent à sonner jusqu'à leur fin.
L'utilisateur perçoit un « release » involontaire au lieu d'un
silence net.

**Fix** : envoyer `allNotesOff(channel)` (CC 123 + CC 120) sur le
canal du loop au moment du stop. `MidiSynthesizer` expose déjà
`allNotesOff` (vérifier signature dans `public/js/audio/MidiSynthesizer.js`).

**Effort** : S

---

### L8. `loopDurationMs` ignore le dénominateur de la time signature
**Catégorie** : correctness
**Localisation** : `public/js/features/loop/LoopUtils.js:121-123`.

```js
function loopDurationMs({ tempo, time_sig_num, bars }) {
    return time_sig_num * bars * 60000 / tempo;
}
```

Manque le facteur `4 / time_sig_den`. Pour 6/8 (2 bars à 120 BPM),
la durée correcte est `6 × 2 × 60000 / 120 × (4/8) = 3000 ms`, le
code retourne `6 × 2 × 60000 / 120 = 6000 ms`. Toutes les non-4/4
sont fausses d'un facteur `4/den`.

**Fix** :
```js
function loopDurationMs({ tempo, time_sig_num, time_sig_den = 4, bars }) {
    return time_sig_num * bars * 60000 / tempo * (4 / time_sig_den);
}
```

**Effort** : S

---

### L9. Pad long-press timer non nettoyé à la fermeture
**Catégorie** : resource leak
**Localisation** : `public/js/features/LoopCreatorModal.js:1002-1046`.

`lpTimer = setTimeout(_, LONG_PRESS_MS)` est posé sur `mousedown`
d'un pad. Si l'utilisateur ferme la modale avant 500 ms (release
sans drop), le timer tire sur un élément DOM détaché — il tentera
de `querySelector` sur `this.dialog` (déjà removed) et soit crash,
soit ouvre un picker fantôme.

**Fix** : maintenir `this._padLongPressTimers = new Set()` ;
`set.add(lpTimer)` au start, `clearTimeout` + `set.delete()` au
release ; `set.forEach(clearTimeout)` dans `onClose()`.

**Effort** : S

---

### L10. `_dropPreview` div persiste après close mid-drag
**Catégorie** : resource leak
**Localisation** : `public/js/features/LoopCreatorModal.js:2187-2200`.

`_showDropPreview()` crée un `<div>` overlay ajouté au DOM. Il n'est
retiré que par `_hideDropPreview()`, appelé sur `dragend`. Si la
modale est fermée pendant un drag (par exemple Esc), le div reste
attaché au `document.body`.

**Fix** : `_hideDropPreview()` dans `onClose()` ; ajouter aussi un
listener `document.addEventListener('dragend', _hideDropPreview)`
global qui s'auto-nettoie.

**Effort** : S

---

## 🔴 Bugs backend / intégrité de données

### B1. Aucune validation numérique sur `loop_create`/`_update`
**Catégorie** : security / correctness
**Localisation** : `src/api/commands/LoopCommands.js:19-28, 48-69`.

```js
const loopId = app.loopRepository.save({
    name: data.name.trim(),
    tempo: data.tempo,           // string, Infinity, NaN, -1 acceptés
    time_sig_num: data.time_sig_num,
    time_sig_den: data.time_sig_den,  // 0 → division par zéro côté front
    bars: data.bars,
    ppq: data.ppq,
    // …
});
```

N'importe quel client WS peut envoyer `tempo: "pwned"` ou
`time_sig_den: 0` (cf. `_loopDurationMs` ÷ den), corrompant la
base. Le front est défensif (`parseFloat`) mais d'autres
consommateurs (CLI ? scripts ?) ne le sont pas.

**Fix** : schema déclaratif (cf. B5) :
- `name` : string non vide, ≤ 120 chars.
- `tempo` : `Number.isFinite`, ∈ [20, 300].
- `time_sig_num` : entier ∈ [1, 32], `_den` ∈ {1, 2, 4, 8, 16, 32}.
- `bars` : entier ∈ [1, 256].
- `ppq` : entier ∈ [24, 960].
- `instrument_program` : entier ∈ [0, 127] ou null.

**Effort** : S (dans le cadre de B5)

---

### B2. `midi_data` accepté sans validation JSON ni limite de taille
**Catégorie** : security / DoS
**Localisation** : `src/api/commands/LoopCommands.js:27`,
`src/persistence/tables/LoopsDB.js:34`.

```js
midi_data: typeof loop.midi_data === 'string'
    ? loop.midi_data                            // ← stocké tel quel
    : JSON.stringify(loop.midi_data ?? []),
```

Aucun parse, aucun check de schéma `{t, n, v, l}`, aucune limite de
taille. Le buffer WebSocket maximum (16 MB par défaut) devient la
seule borne. Un client peut envoyer un seul loop de 10 MB, faire 50
inserts → 500 MB de DB en quelques secondes.

**Fix** : dans le schema `loop_create` :
- Si `midi_data` est une string : `JSON.parse` strict, doit être un
  array.
- Si array : `JSON.stringify(data).length ≤ 256 * 1024` (256 KB par
  loop, généreux pour 8 bars dense).
- Chaque note doit avoir `t` (int ≥ 0), `n` (int 0-127), `v`
  (int 1-127), `l` (int > 0) — sinon erreur explicite.

**Effort** : S

---

### B3. `loop_delete` n'avertit pas si le loop est référencé
**Catégorie** : correctness / UX
**Localisation** : `src/api/commands/LoopCommands.js:72-77`,
`src/persistence/tables/LoopArrangementsDB.js` (FK CASCADE).

Le schéma SQL applique `ON DELETE CASCADE` (cf.
`migrations/018_loop_arrangements.sql:24` —
`loop_id INTEGER NOT NULL REFERENCES loops(id) ON DELETE CASCADE`).
Bonne pratique au niveau base, mais zéro feedback côté handler : un
loop référencé par 8 blocks dans 3 arrangements disparaît
silencieusement avec ses blocks.

**Fix** : avant `delete`, compter les blocks référents et le state
côté réponse :

```js
const refCount = app.loopArrangementRepository
    .countBlocksByLoopId(data.loopId);
if (refCount > 0) {
    app.logger.info(`Loop ${data.loopId} removal cascades ${refCount} blocks`);
}
// Optionnel : exposer la confirmation à l'UI (return { cascadedBlocks: refCount })
```

L'UI peut afficher la confirmation accessible (cf. A1) avec le
count exact.

**Effort** : S

---

### B4. `arrangement_add_block` : aucun check FK ni bornes
**Catégorie** : correctness / security
**Localisation** : `src/api/commands/LoopArrangementCommands.js:89-98, 104`.

```js
const id = app.loopArrangementRepository.addBlock({
    track_id: data.trackId,        // pas de check d'existence
    loop_id: data.loopId,          // idem
    position_bar: data.position_bar ?? 0,   // négatif accepté
    repetitions: data.repetitions ?? 1      // 0 ou 999999 acceptés
});
```

Si `trackId` n'existe pas, SQLite throw (FK violation) — bien, mais
l'erreur n'est pas typée pour le front. Si `loopId` n'existe pas et
que les FKs ne sont pas armées (`PRAGMA foreign_keys = ON` à
vérifier), le block est orphelin. `position_bar` négatif ou
supérieur à la longueur de l'arrangement crée des blocks fantômes.

**Fix** : dans le schema + repository :
- Vérifier `trackId` existe.
- Vérifier `loopId` existe.
- `position_bar` ∈ [0, arrangement.total_bars - loop.bars].
- `repetitions` ∈ [1, 256].

**Effort** : M

---

### B5. Aucun fichier de schéma pour `loop_*`/`arrangement_*`
**Catégorie** : archi / maintenabilité
**Localisation** : `src/utils/JsonValidator.js:35-46`.

```js
const COMPILED_SCHEMAS = {};
for (const schemas of [
    playbackSchemas, routingSchemas, deviceSchemas,
    fileSchemas, latencySchemas, systemSchemas, hotspotSchemas
    // ← absent : loopSchemas, arrangementSchemas
]) { … }
```

Toutes les 14 commandes `loop_*`/`arrangement_*` passent en
validation permissive (`validateByCommand` retourne `{valid:true}`
pour les commandes inconnues). La validation est dispersée et
impérative dans les handlers (B1-B4 le démontrent).

**Fix** : créer `src/api/commands/schemas/loop.schemas.js` exposant
les 14 schemas. Calquer le pattern de
`src/api/commands/schemas/file.schemas.js` (helpers réutilisables).
Ajouter l'import dans `JsonValidator.js`.

**Effort** : M

---

### B6. Nom du loop / de l'arrangement non borné en longueur
**Catégorie** : security / DoS
**Localisation** : `src/api/commands/LoopCommands.js:16`,
`src/api/commands/LoopArrangementCommands.js:16`.

```js
if (!data.name || typeof data.name !== 'string' || !data.name.trim()) {
    throw new ValidationError('name is required', 'name');
}
// pas de check max length
```

Un client peut envoyer un nom de 1 MB. Le `loop_list` retourne tous
les noms en clair, gonflant le payload WS.

**Fix** : `data.name.trim().length ≤ 120` (cf. B1).

**Effort** : S

---

### B7. Pas de transactions sur opérations multi-step
**Catégorie** : correctness
**Localisation** : `src/persistence/tables/LoopArrangementsDB.js`,
tous les handlers d'arrangement.

`arrangementCreate` insère l'arrangement, puis 3 tracks par défaut
en séparé. Si le process crash entre les deux, on a un arrangement
sans tracks (zombie). Idem pour `arrangementDelete` qui devrait
être atomique avec ses tracks/blocks (le CASCADE fait le job, mais
si on ajoute du logging post-delete c'est non-atomique).

**Fix** : `db.transaction(() => { … })()` pour ces opérations.
`better-sqlite3` supporte nativement.

**Effort** : S

---

### B8. N+1 dans `arrangement_get`
**Catégorie** : perf
**Localisation** : `src/api/commands/LoopArrangementCommands.js:33-40`.

```js
const arr = app.loopArrangementRepository.findById(data.arrangementId);
const tracks = app.loopArrangementRepository.findTracks(data.arrangementId);
const blocks = app.loopArrangementRepository.findAllBlocks(data.arrangementId);
return { arrangement: arr, tracks, blocks };
```

3 round-trips DB pour 1 fetch. Le client switch souvent
d'arrangement → latence cumulée.

**Fix** : une seule query `LEFT JOIN tracks LEFT JOIN blocks LEFT JOIN loops`,
regrouper côté JS. Réduit de 3 statements à 1.

**Effort** : S

---

## 🔴 Accessibilité (WCAG 2.1)

### A1. 6 `confirm()` natifs sur actions destructives
**Catégorie** : a11y / UX / i18n
**Localisation** : `public/js/features/LoopCreatorModal.js:491, 1440, 1633, 1647, 1654`,
`public/js/features/LoopEditorModal.js:368`.

Actions concernées : discard unsaved arrangement, clear all pads,
delete arrangement, switch arrangements (variants), delete loop,
discard unsaved loop edit. Toutes utilisent `confirm()` natif :
- Non stylable → ruptures visuelles avec la modale.
- Brise le focus trap de `BaseModal` (focus part hors du dialog,
  ne revient pas).
- Texte non traduit en runtime sur certains navigateurs.
- Pas de support des touches de raccourci personnalisées.

`window.showConfirm` existe déjà (`public/index.html:6126`+,
wrapper accessible) et est utilisé par 5 autres features
(`PlaylistPage.js:756`, `InstrumentManagementPage.js:971`, etc.).

**Fix** : remplacer chaque `confirm(msg)` par
`await window.showConfirm(msg, { icon, confirmLabel, cancelLabel })`.
Fallback `confirm()` si `typeof window.showConfirm !== 'function'`
(pour les tests headless).

**Effort** : S (mécanique) — M avec traductions

---

### A2. Tab panels sans `aria-labelledby` / `aria-controls`
**Catégorie** : a11y (WCAG 4.1.2)
**Localisation** : `public/js/features/LoopCreatorModal.js:160-166`,
`public/js/features/LoopEditorModal.js:271-289`.

Les boutons tab sont des `<button class="lc-tab" role="tab">` mais
sans `aria-controls` pointant vers le pane, ni `aria-selected`. Les
panes sont des `<div class="le-pane">` avec `role="tabpanel"` mais
sans `aria-labelledby` pointant vers le bouton. APG tabs pattern non
respecté → screen readers n'annoncent pas la relation
tab↔panel.

**Fix** :
```html
<div role="tablist" class="lc-tabs">
  <button role="tab" id="lc-tab-library"
          aria-controls="lc-tabpanel-library"
          aria-selected="true">🗂 Library</button>
  …
</div>
<div role="tabpanel" id="lc-tabpanel-library"
     aria-labelledby="lc-tab-library">…</div>
```

Ajouter navigation Arrow ←/→ entre tabs (pattern APG : Home/End
sautent au premier/dernier).

**Effort** : M

---

### A3. Boutons icon-only sans nom accessible
**Catégorie** : a11y (WCAG 4.1.2)
**Localisation** : multiples, ≥ 10 instances.

Exemples :
- `LoopCreatorModal.js:1623` — `<button>🗑</button>` (delete arrangement)
- `LoopCreatorModal.js:2008` — `<button>✕</button>` (delete block)
- `LoopCreatorModal.js:261-271` — spinbox `<button>‹</button>` / `›`
- `LoopCreatorModal.js:157` — `<span>∞</span>` titre header sans texte
- `LoopCreatorModal.js:340-344` — undo/redo header (titres OK, mais
  pas d'`aria-label`)

Screen reader annonce « bouton », « bouton », « bouton »… sans
contexte.

**Fix** : `aria-label` traduit sur chaque, ex :
```html
<button aria-label="Supprimer l'arrangement « {{name}} »">🗑</button>
<button aria-label="Décrémenter le nombre de mesures">‹</button>
```

**Effort** : M (passage exhaustif via grep)

---

### A4. `<input>` / `<select>` sans label associé
**Catégorie** : a11y (WCAG 3.3.2)
**Localisation** : `public/js/features/LoopCreatorModal.js:221-226`
(Library : search, filter, sort),
`public/js/features/LoopEditorModal.js:280` (MIDI-In device select).

```html
<input type="text" id="lm-lib-search" placeholder="Search loops">
<!-- pas de <label for="lm-lib-search"> ni aria-label -->
```

`placeholder` n'est pas un nom accessible (disparaît au focus).

**Fix** : soit `<label class="visually-hidden">…</label>`, soit
`aria-label="Rechercher dans la bibliothèque"`. Préférer un
`<label>` visible quand le design le permet.

**Effort** : S

---

### A5. `:focus-visible` partiel — header buttons / spinbox invisibles
**Catégorie** : a11y (WCAG 2.4.7)
**Localisation** : `public/styles/loop-creator-modal.css:1085-1089`.

Le style focus-visible n'est défini que pour `.lm-pad-cell`,
`.la-block`, `.lc-minimap` :

```css
.lm-pad-cell:focus-visible { outline: 2px solid #f5a623; outline-offset: 2px; }
```

Les boutons header (undo/redo/play/stop/zoom), les spinbox `‹›`,
les tabs ne reçoivent **aucun** indicateur de focus visible. Tab
clavier devient invisible.

**Fix** : règle globale dans la portée modale :
```css
.lc-modal :focus-visible {
    outline: 2px solid var(--accent, #5B8DEF);
    outline-offset: 2px;
    border-radius: 4px;
}
```

**Effort** : S

---

### A6. Contraste du subtitle sur gradient violet — AA limite
**Catégorie** : a11y (WCAG 1.4.3)
**Localisation** : `public/styles/loop-creator-modal.css:36, 69, 73`.

```css
.lc-header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
.lc-header-subtitle { color: rgba(255,255,255,0.82); }
```

Sur `#667eea` (côté clair) : ratio ~5.3:1 → AA OK.
Sur `#764ba2` (côté sombre) : ratio ~4.2:1 → **échec AA** sur le
texte de taille normale.

**Fix** : monter à `opacity: 0.95` ou remplacer par couleur fixe
`#f0f0f0` testée sur les 2 extrêmes du gradient (WebAIM Contrast
Checker).

**Effort** : S

---

### A7. Recording indicator sans `aria-live`
**Catégorie** : a11y (WCAG 4.1.3)
**Localisation** : `public/js/features/LoopEditorModal.js:256-259`.

```html
<span class="lc-rec-indicator hidden" id="lc-rec-indicator">
    <span class="lc-rec-dot lc-rec-dot--pulse"></span>
    <span class="lc-rec-time" id="lc-rec-time">0:00</span>
</span>
```

L'utilisateur SR ne sait pas quand l'enregistrement démarre, ni
combien de temps il dure. `LoopUtils.toast()` a déjà `aria-live`
(bien), mais pas ce composant.

**Fix** :
```html
<span role="status" aria-live="assertive" id="lc-rec-indicator">
    <span class="lc-rec-dot lc-rec-dot--pulse" aria-hidden="true"></span>
    <span class="lc-rec-time">0:00</span>
    <span class="visually-hidden">Enregistrement en cours</span>
</span>
```

**Effort** : S

---

### A8. Arranger : drag-drop sans alternative clavier
**Catégorie** : a11y (WCAG 2.1.1)
**Localisation** : `public/js/features/LoopCreatorModal.js:1620-2010`.

Les blocks ont `draggable="true"` et `tabindex="0"`, mais :
- Pas de mode déplacement clavier.
- Pas de feedback `aria-grabbed` ni `aria-dropeffect`.
- Espace ou Enter sur un block ne fait rien d'utile.

Utilisateur clavier-seul ne peut pas réarranger.

**Fix** : mode « move » accessible :
- Focus + `Space` → entre en mode move (`aria-pressed=true`).
- `←` / `→` change `position_bar` d'un cran.
- `Shift+←/→` change `repetitions`.
- `Enter` confirme, `Esc` annule.
- Statut annoncé via `aria-live`.

Documenter dans help overlay (cf. U5).

**Effort** : M

---

### A9. Live tab : tempo encodé en couleur seulement
**Catégorie** : a11y (WCAG 1.4.1)
**Localisation** : `public/styles/loop-creator-modal.css:918-920`.

```css
.lm-live-loop-btn[data-tempo-range="slow"]   { border-left: 3px solid #27ae60; }
.lm-live-loop-btn[data-tempo-range="medium"] { border-left: 3px solid #667eea; }
.lm-live-loop-btn[data-tempo-range="fast"]   { border-left: 3px solid #e74c3c; }
```

L'info « lent / moyen / rapide » passe uniquement par la couleur de
bordure. Daltoniens et SR ne la perçoivent pas. De plus, `#27ae60`
sur blanc = ratio 3.8:1 → échec WCAG AA sur le bord (la bordure
n'est pas du texte mais c'est l'unique indication).

**Fix** : badge texte `<span>120 BPM</span>` à côté du bord, et
`aria-label` sur la carte incluant le tempo et la classification.

**Effort** : S

---

### A10. Garde « unsaved changes » seulement sur Arranger
**Catégorie** : UX / data loss
**Localisation** : `public/js/features/LoopCreatorModal.js:490-493`.

`onBeforeClose` vérifie `this._arrDirty` mais pas :
- modifs Library (ex : add/edit loop puis tab switch sans save).
- changements Pad (mapping non persisté en cours).
- édition piano roll en cours (LoopEditorModal le gère pour son
  modal interne, mais pas si l'utilisateur ferme la modale parent).

Risque : perte silencieuse du travail.

**Fix** : `_isAnyTabDirty()` qui agrège l'état dirty de chaque tab
(post-refactor Phase 4, cette méthode appelle `tabs[name].isDirty()`).
En attendant, ajouter manuellement les checks dans Library/Pad.

**Effort** : M

---

## 🟠 Risques et points d'attention

### U1. Strings hardcodés (non i18n)
**Catégorie** : i18n
**Localisation** : `public/js/features/LoopCreatorModal.js:2208` (`'Track ' + index`),
`src/api/commands/LoopArrangementCommands.js:24, 67` (label `'Track 1'/'2'/'3'` côté serveur).

Le label par défaut « Track X » apparaît en dur dans le code,
identique dans toutes les locales. Pour les serveurs : le label
i18n ne devrait jamais venir du backend (impose une langue).

**Fix** : générer le label par défaut côté client à la réception
(`label || t('loopArranger.defaultTrackName', { index })`). Backend
retourne `label: null` quand non défini.

**Effort** : S

---

### U2. Raccourcis Mac (`⌘⇧`) affichés sur tous les OS
**Catégorie** : UX
**Localisation** : `public/js/features/LoopCreatorModal.js:340-342` (titres tooltip).

```js
title="${this.t('loopCreator.undo')} (⌘Z)"
title="${this.t('loopCreator.redo')} (⌘⇧Z)"
```

Sur Windows/Linux, le raccourci réel est `Ctrl+Z` / `Ctrl+Shift+Z`,
mais la tooltip ment.

**Fix** : helper `LoopUtils.modKeyLabel()` qui lit
`navigator.platform` (ou `navigator.userAgentData?.platform`) et
retourne `'⌘'` (Mac) ou `'Ctrl'` (autres).

**Effort** : S

---

### U3. Aucune media query mobile
**Catégorie** : UX / responsive
**Localisation** : `public/styles/loop-creator-modal.css` (tout le
fichier — aucune `@media` détectée).

Sur iPhone SE (375 px) :
- Les 4-5 tabs débordent et coupent.
- Cards à 3 boutons emoji débordent latéralement.
- Touch targets <44 px (violations WCAG 2.5.5).

**Fix** :
```css
@media (max-width: 768px) {
    .lc-modal { width: 100vw; height: 100dvh; }
    .lc-tabs { overflow-x: auto; flex-wrap: nowrap; }
    .lc-tab { flex: 0 0 auto; min-width: 88px; }
}
@media (max-width: 480px) {
    .lc-card-actions button {
        padding: 6px; min-width: 44px; min-height: 44px;
    }
}
```

**Effort** : M

---

### U4. Empty states sans CTA
**Catégorie** : UX
**Localisation** : `public/js/features/LoopCreatorModal.js:236, 1462, 1617`.

Quand Library/Pad/Arranger sont vides, message texte plat. Nouvel
utilisateur reste devant un écran blanc sans savoir quoi faire.

**Fix** :
```html
<div class="lc-empty">
    <p>{{t('loopManager.libraryEmpty')}}</p>
    <button class="lc-btn--primary" data-action="create-loop">
        + {{t('loopManager.createFirst')}}
    </button>
</div>
```

**Effort** : S

---

### U5. Pas d'overlay help pour les raccourcis clavier
**Catégorie** : discoverability
**Localisation** : modale globale.

Les raccourcis (Space=play, R=record, Esc=stop, raccourcis Arranger
clavier de A8) ne sont documentés nulle part dans l'UI. Mobile et
nouveaux utilisateurs n'y ont pas accès.

**Fix** : bouton `?` dans le header → modale enfant
`LoopShortcutsModal extends BaseModal` listant les raccourcis par
section. Pattern existant pour `MidiEditorShortcutsModal` (à
vérifier).

**Effort** : M

---

### U6. Pas de pluralisation i18n
**Catégorie** : i18n
**Localisation** : `public/js/features/LoopCreatorModal.js:2078`
(`{ count: sel.length }` → `"5 blocks copied"`).

Pluriel non géré : « 1 block copied » s'affiche aussi « 1 blocks
copied ». Idem pour bars, beats, loops.

**Fix** : utiliser le pattern i18n existant (clés `_one`/`_other` ?
vérifier `public/js/utils/I18n.js`). Si non supporté, helper
`LoopUtils.plural(count, key)`.

**Effort** : M

---

### U7. Control bar Library scroll avec le contenu
**Catégorie** : UX
**Localisation** : `public/js/features/LoopCreatorModal.js:221-226` +
CSS associé.

Search/filter/sort scrollent hors écran quand la liste est longue.
Utilisateur doit scroller au top pour filtrer.

**Fix** :
```css
.lc-controls {
    position: sticky;
    top: 0;
    z-index: 5;
    background: var(--lc-bg);
}
```

**Effort** : S

---

### U8. Cards 3 boutons débordent sur écrans étroits
**Catégorie** : responsive
**Localisation** : `public/js/features/LoopCreatorModal.js:893-895`.

```html
<button class="lc-card-btn lc-card-btn--play">▶</button>
<button class="lc-card-btn">✏️</button>
<button class="lc-card-btn--danger">🗑</button>
```

Sous 360 px, les 3 boutons emoji passent à la ligne ou tronquent.

**Fix** : menu kebab `⋮` regroupant edit/delete sous 360 px, garde
play visible :
```html
<button class="lc-card-btn lc-card-btn--play" aria-label="…">▶</button>
<button class="lc-card-btn--menu" aria-label="Plus d'actions"
        aria-haspopup="menu">⋮</button>
```

**Effort** : M

---

## 🟡 Nits, cohérence, dette technique

### N1. God-class `LoopCreatorModal` (2 744 lignes)
**Catégorie** : archi / maintenabilité
**Localisation** : `public/js/features/LoopCreatorModal.js` (fichier entier).

Une seule classe `LoopManagerModal` gère :
- Library tab (search, filter, sort, list, cards).
- Pad tab (4×4 grid, PadStorage, MIDI input mapping).
- Live tab (organisation par famille GM, scheduling).
- Arranger tab (timeline, drag-drop, history, multi-track playback).
- Header MIDI-out, transport, métronome partagés.

Conséquences :
- Aucun test unitaire ciblé possible (toutes les méthodes dépendent
  de l'état partagé).
- Revue de PR ardue : touche 50 lignes → diff dans 2 000 lignes de
  contexte.
- Couplage : ajouter un tab impose de toucher l'orchestrateur, le
  routing keyboard, l'output controller.

**Fix** : découpage `loop/tabs/{Library,Pad,Live,Arranger}Tab.js`
selon plan §2. Migration progressive A-F. Cible : orchestrateur
≤ 400 lignes, chaque tab ≤ 700.

**Effort** : L (16-24 h)

---

### N2. Repository = passthrough sans logique
**Catégorie** : archi
**Localisation** : `src/repositories/LoopRepository.js:13-31`,
`src/repositories/LoopArrangementRepository.js:11-27`.

```js
save(loop) { return this.database.insertLoop(loop); }
findAll() { return this.database.getLoops(); }
findById(id) { return this.database.getLoop(id); }
```

Rien d'autre. Ni cache, ni validation, ni transformation. Le
pattern repository (ADR-002 du repo) impose la couche, mais elle
ne livre aucune valeur ajoutée actuelle.

**Fix** : profiter de Phase 1 pour y placer la logique d'intégrité
référentielle (FK check, bornes), justifiant son existence. Cf. B4.

**Effort** : S (dans le cadre de B4)

---

### N3. Confusion naming : `playback_set_loop` ≠ Loop Modal
**Catégorie** : naming
**Localisation** : `src/midi/playback/commands/PlaybackControlCommands.js:173-176`.

```js
async function playbackSetLoop(app, data) {
    app.midiPlayer.setLoop(data.enabled);
    return { success: true };
}
```

Toggle « loop on end » d'une chanson (rejouer en boucle quand la
fin est atteinte). **Aucun rapport** avec la modale boucles. Le
naming partage le mot « loop » et crée une confusion lecteur.

**Fix** : renommer en `playback_set_repeat` ou `playback_set_song_loop`
(breaking côté client). Si breaking trop coûteux, ajouter un
JSDoc explicite :
```js
/**
 * Toggle song-level looping (replay on end-of-track).
 * UNRELATED to the Loop Creator modal / Loop CRUD operations.
 * @see LoopCommands for Loop Creator features.
 */
```

**Effort** : S (JSDoc) — M (rename)

---

### N4. Magic numbers non extraits
**Catégorie** : maintenabilité
**Localisation** : multiples.

- `LONG_PRESS_MS = 500` (hardcoded LoopCreatorModal.js:1002).
- `ARRANGER_HISTORY_LIMIT = 50` (top of file, OK).
- `MAX_BARS_PER_LOOP` implicite via valeurs (256 ?).
- `MAX_PROGRAMS_PER_ARRANGEMENT = 16` (manquant, lié à L4).
- `MIDI_DATA_MAX_BYTES` (manquant, lié à B2).

**Fix** : `const LOOP_CONSTRAINTS = { … }` en tête de
`LoopUtils.js` et `loop.schemas.js`.

**Effort** : S

---

### N5. Defensive checks incohérents
**Catégorie** : cohérence
**Localisation** : multiples.

Mélange `this._synth?.playNote?.(…)` (LoopEditorModal.js:655) et
`this._synth.playNote(…)` (LoopEditorModal.js:1081) dans le même
fichier. Soit le synth peut être null/cassé, soit non.

**Fix** : choisir une convention (idéalement : init() garantit
`_synth !== null` après succès, sinon throw ; pas d'optionnel
ailleurs).

**Effort** : S

---

### N6. GM program name lookup linéaire à chaque appel
**Catégorie** : perf (mineur)
**Localisation** : `public/js/features/LoopCreatorModal.js:930`.

`_gmProgramName(prog)` fait `GM_PROGRAM_NAMES.find(...)` sur 128
entrées à chaque rendu de carte/badge. Appelé 50+ fois par tab
switch.

**Fix** : index `GM_PROGRAM_NAMES_BY_NUMBER = new Map(...)` une
fois au module load.

**Effort** : S

---

### N7. Bound de l'historique Arranger après dépassement, pas avant
**Catégorie** : mémoire
**Localisation** : `public/js/features/LoopCreatorModal.js:1722-1733`.

```js
if (this._arrHistory.length > ARRANGER_HISTORY_LIMIT) {
    this._arrHistory.shift();
} else {
    this._arrHistoryIdx++;
}
```

L'array atteint N+1 avant d'être réduit. Chaque snapshot étant un
clone d'arrangement complet (100 KB facile), pic mémoire transitoire
± 5 MB.

**Fix** : checker `>= LIMIT` **avant** push. Ou (mieux) stocker des
diffs au lieu de snapshots complets.

**Effort** : S (clamp) — L (diffs)

---

### N8. `_metronomeCtx` global non typé non versionné dans le store
**Catégorie** : cohérence
**Localisation** : `public/js/features/LoopEditorModal.js:730-752`.

Le contexte audio est instancié paresseusement mais réutilisable
entre les ouvertures (idéal). Sauf qu'on en crée un nouveau à
chaque modale → fuite (L6). Et il n'est pas visible côté global
pour debug.

**Fix** : combiner avec L6. Optionnel : exposer sur
`window.__loopDiag` pour devtools.

**Effort** : (couvert par L6)

---

## 🔵 UX / mobile / polish

### P1. Pas de disabled state visible sur undo/redo
**Catégorie** : UX
**Localisation** : `public/styles/loop-creator-modal.css`.

`<button disabled>` n'a aucune règle CSS spécifique : visuellement
identique à actif, sauf que le clic ne fait rien.

**Fix** :
```css
.lc-btn:disabled, .lc-icon-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    pointer-events: none;
}
```

**Effort** : S

---

### P2. Pas d'indicateur unsaved dans le label du tab
**Catégorie** : UX
**Localisation** : `public/js/features/LoopCreatorModal.js:160-166`.

Quand l'utilisateur édite l'Arranger puis switch Library, aucun
indicateur visuel ne signale qu'Arranger a des modifs non sauvées.

**Fix** : à côté du label tab, span `<span class="lc-tab-dirty"
aria-label="modifications non sauvées">•</span>` quand dirty.

**Effort** : S (couplé Phase 4 — tab a `isDirty()`)

---

### P3. Aucun loading state visible pour preload instruments
**Catégorie** : UX
**Localisation** : `public/js/features/LoopCreatorModal.js:2406-2411`.

Avant `_play()` d'un arrangement, on appelle
`setChannelInstrument` pour chaque programme. Sur un arrangement
8 programmes, ça prend 1-2 secondes. Aucun feedback : l'utilisateur
clique play, rien ne se passe pendant 2 s.

**Fix** : toast `loadingInstruments` (info, 3 s) + boutons play
en `aria-busy=true` pendant le preload.

**Effort** : S

---

### P4. Statut entre tabs non remis à zéro
**Catégorie** : UX
**Localisation** : `public/js/features/LoopCreatorModal.js` — playbar
fill / status visible cross-tab.

Si Arranger joue (playbar fill animée), switch sur Pad → la
playbar reste animée alors qu'elle n'a plus de sens dans le
nouveau contexte.

**Fix** : reset playbar au tab switch ; rendre le contrôleur
transport tab-aware.

**Effort** : S (mais dépend de la structure post Phase 4)

---

### P5. Toast i18n incomplet pour 28 locales
**Catégorie** : i18n
**Localisation** : `public/locales/*.json`.

Sondé `fr.json` et `en.json` : les clés `loopManager.*` sont
présentes. À vérifier sur les 26 autres locales — risque de
fallback en clé brute (clef montrée).

**Fix** : compléter via processus normal de traduction. Ajouter un
test `tests/audit-i18n.test.js` qui valide la présence des clés
critiques sur toutes les locales.

**Effort** : M (selon le processus de traduction)

---

## État de la dette

| Sévérité | Catégorie | Count | Effort cumulé |
|---|---|---:|---|
| 🔴 | MIDI/logique | 10 | M (4-6 h) |
| 🔴 | Backend/data | 8 | M (3-4 h) |
| 🔴 | A11y | 10 | M (5-7 h) |
| 🟠 | i18n/mobile/UX | 8 | M (4-6 h) |
| 🟡 | Archi/dette | 8 | L (16-24 h, dominé par N1) |
| 🔵 | Polish | 5 | S (2-3 h) |
| **Total** | | **~49** | **~5-7 jours dev** |

---

## Ordre d'attaque suggéré

Recommandation : **0 → 1 → 3 → 2 → 4 → 5**.

1. **Phase 0 — Baseline** (ce document + squelette tests, S, risque nul).
2. **Phase 1 — Backend hardening** (B1-B8 + schemas, M, risque faible).
   Stoppe les payloads invalides, base sécurisée pour le reste.
3. **Phase 3 — A11y critique** (A1-A10, M, risque faible). Indépendant ;
   valeur user immédiate ; bloque l'a11y audit externe.
4. **Phase 2 — Bugs MIDI** (L1-L10, M, risque moyen). Vient après
   Phase 1 pour profiter du schema cap programmes (L4).
5. **Phase 4 — Refactor archi** (N1, L, risque moyen-élevé). Après
   fixes pour ne pas refactorer du code buggé.
6. **Phase 5 — i18n/mobile/UX** (U1-U8, M, risque faible). En dernier
   car dépend du découpage par tab.

---

## Notes de méthode

- **Lecture statique uniquement** : aucun run du serveur, du player,
  ni des tests. Les bugs L1, L2, L5, L7 sont théoriquement
  reproductibles mais non vérifiés dynamiquement à ce stade.
- **Couverture** : `LoopUtils.js` est petit et bien testable ; pas
  de couverture mesurée encore (à faire en Phase 0).
- **Hors périmètre** : `PianoRollEditor.js` (composant partagé avec
  `MidiEditorModal`, mérite son propre audit), `BaseModal.js`
  (composant partagé, focus trap déjà ok), settings UI de
  `loopCreatorButtonToggle`.
- **Locales auditées en détail** : fr, en. Les 26 autres locales
  sont supposées suivre, à vérifier programmatiquement.
- **Navigateurs** : pas d'audit cross-browser dynamique ; les CSS et
  ARIA sont supposés conformes Chrome 120+ / Firefox 121+ / Safari 17+.
- **Outils utilisés** : `grep`, `read`, agents `Explore`, lecture
  manuelle. Pas d'`axe-core`, pas de Lighthouse, pas de NVDA — à
  ajouter en vérification post-fix.
- **À vérifier en exécution** : `PRAGMA foreign_keys = ON` dans
  `Database.js` ; sinon B4 a un impact plus large que prévu.
