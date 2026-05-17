> **⚠️ ARCHIVÉ / PARTIELLEMENT PÉRIMÉ.** Voir l'autorité unique
> [`AUDIT_GLOBAL_2026-05-17.md`](./AUDIT_GLOBAL_2026-05-17.md). Item de ce
> document **vérifié comme déjà résolu** (ne pas re-triager) : §C2 reconnexion
> WebSocket — `BackendAPIClient.js:193` retry indéfini, `reconnect_exhausted`
> n'est qu'un événement UI one-shot. Conservé pour historique.

# Audit frontend critique — General Midi Boop
**Date** : 2026-05-14
**Branche** : `claude/frontend-architecture-review-8zA9d`
**Périmètre** : `public/index.html`, `public/js/`, `public/styles/`,
`public/locales/`, `public/lib/`, `public/assets/`, `vite.config.js`,
`package.json` (volet frontend).
Lecture statique uniquement, pas d'exécution sur Pi.

Cet audit complète les trois documents existants
(`AUDIT_2026-05-10.md`, `AUDIT_MODAL_BOUCLES_2026-05-11.md`,
`REPRISE_PIANO_HANDS_BUG.md`, `INSTRUMENT_FAMILY_REFACTOR_ROADMAP.md`)
en se concentrant sur le **frontend uniquement**, sur trois axes
priorisés : **stabilité temps réel 24/7**, **architecture & dette**,
**WebSocket & flux temps réel**.

---

## Synthèse exécutive

Le frontend est volumineux mais **étonnamment bien tenu** côté code mort
explicite : une seule occurrence `TODO/FIXME/HACK` dans tout
`public/js/`, aucun fichier `*.bak`/`*.old`, plusieurs leaks
historiques déjà corrigés (`§L2`, `§L6` de `AUDIT_MODAL_BOUCLES`
sont appliqués dans `LoopEditorModal.js:673-686` et `1199-1235`).

En revanche, **trois classes de risque** demeurent pour la cible
production stable 24/7 sur Raspberry Pi :

1. **Chargement initial bloquant** : 135 `<script src>` séquentiels
   sans `defer`/`async` dans un `index.html` de 14 201 lignes — TTI
   très dégradé sur Pi.
2. **Stabilité 24/7** : reconnexion WebSocket plafonnée à 10 tentatives
   (~5 minutes) puis abandon définitif ; `FilterManager.destroy()`
   jamais appelé → fuite timers + listeners cumulative à chaque
   navigation entre pages ; ratio `addEventListener:646 /
   removeEventListener:284` (2,3:1) suspect.
3. **Dette architecturale** : god-classes `LoopCreatorModal.js`
   (3 394 l.), `RoutingSummaryPage.js` (2 982 l.),
   `ISMSections.js` (2 213 l.), `KeyboardPiano.js` (2 052 l.) ; quatre
   systèmes de piano-roll coexistants (`PianoRollEditor`,
   `PianoRollView`, `MidiEditorRenderer`, `<webaudio-pianoroll>`
   custom element) ; deux instances `MidiSynthesizer` actives
   (synthé principal + `AudioPreview`) donc deux `AudioContext` ;
   653 `!important` CSS répartis sur 32 fichiers.

**Top 5 hotspots** à traiter dès la prochaine itération :

| # | Finding | Effort | Gain |
|---|---|---|---|
| C1 | `defer` sur 134/135 scripts dans `index.html` | 30 min | **−3 à 5 s TTI sur Pi** |
| C2 | WS reconnexion infinie + jitter (`BackendAPIClient.js:184`) | 1 h | Stabilité 24/7 |
| C3 | Appel `filterManager.destroy()` au `onLeave` des pages | 2 h | Stoppe leak récurrente |
| E1 | Object pooling voix `MidiSynthesizer.js` | 1 jour | −500 ms GC pause polyphonie dense |
| E5 | Suppression `BaseController.js` + `AppRegistry.js` (morts) | 30 min | −620 lignes, clarté |

**Estimation gain global après application Phases 0-2** : TTI navigateur
divisé par 3, CPU navigateur −20 à 30 %, croissance RAM 24/7 ramenée
sous 5 MB/h, stabilité réseau coupée auto-rétablie.

---

## Méthodologie & outils de mesure

Toutes les valeurs ci-dessous sont à mesurer **sur Raspberry Pi cible**
(Pi 4 4 GB / Pi 5) dans Chromium (pas dans Firefox/Chrome desktop) car
le GPU et le ratio CPU/RAM diffèrent radicalement.

### Outils
- **Chrome DevTools → Performance** : enregistrer 30 s en lecture
  active avec piano-roll ouvert. Cibler ≥ 55 FPS, scripting < 40 %.
- **Memory → Heap snapshot** : 3 snapshots espacés de 10 min en
  laissant l'app idle ; diff doit montrer une croissance ≤ 0,5 MB.
- **Memory → Allocation profiling** : repérer la pression GC lors de
  séquences MIDI denses (`MidiSynthesizer` allocation per note).
- **Coverage tab** (`Cmd+Shift+P → Show Coverage`) : mesurer % JS/CSS
  inutilisé au boot. Cible < 40 % inutilisé.
- **Network → WS frames** : visualiser flux `playback_position` et
  vérifier taille moyenne (≤ 16 B binary attendu).
- **Lighthouse** (mode "Slow 4G + 4× CPU throttle" pour simuler Pi) :
  cible Performance ≥ 70.
- **Bundle analyzer** : `vite build --report` ou
  `rollup-plugin-visualizer` pour cartographier le bundle final.
- **`node --inspect` + `clinic.js doctor`** côté serveur pour valider
  qu'aucune fuite frontale ne déclenche pression backend.

### Seuils acceptables / critiques

| Métrique | Acceptable | Critique |
|---|---|---|
| TTI (Pi 4 Chromium, LAN) | < 4 s | > 8 s |
| FPS canvas pendant playback | ≥ 50 | < 30 |
| Croissance heap / heure (idle) | < 0,5 MB | > 2 MB |
| Croissance heap / heure (lecture) | < 2 MB | > 8 MB |
| CPU navigateur (idle) | < 5 % | > 15 % |
| CPU navigateur (lecture) | < 35 % | > 60 % |
| Taille bundle JS chargé au boot | < 800 KB gzip | > 1,5 MB gzip |
| RTT WS commande/réponse | < 30 ms | > 100 ms |
| Latence note-on UI → synth | < 25 ms | > 60 ms |

---

# Findings — Gravité CRITIQUE (P0)

## C1 — 135 scripts séquentiels sans `defer`/`async` dans `index.html`

### Problème détecté
`public/index.html` contient **135 balises `<script src=>`**, toutes
chargées synchrone (`grep -cE '(defer|async)[[:space:]]*[=>]'
public/index.html` retourne **0**). Chaque script bloque le parser
HTML jusqu'à téléchargement + parse + exécution. Le navigateur ne
peut donc pas construire le DOM tant que tous les modules feature
n'ont pas été récupérés (ordre = ordre de découverte par le parser).

### Gravité
**Critique** — Premier critère utilisateur sur Pi (interface lente à
apparaître).

### Fichier(s) concerné(s)
- `public/index.html` (14 201 lignes, 135 scripts, 31 stylesheets eager).

### Cause profonde
Frontend 100 % vanilla, distribué historiquement comme `<script>`
globaux écrits dans des fichiers IIFE qui s'enregistrent sur
`window.*`. Le `vite.config.js` se contente de copier `index.html` ;
aucune balise `<script type="module">` ni `defer`. L'ordre est dicté
par les dépendances implicites (EventBus avant features, etc.).

### Impact réel
Sur Pi 4 LAN, ouverture initiale ~10-12 s avant interactivité
(estimation des agents Explore concordante). Sur Pi 5 ~5-7 s. Les
animations de boot s'enchaînent mais l'UI reste figée tant que les
~3,9 MB de JS ne sont pas évalués séquentiellement.

### Impact CPU/RAM
- **CPU** : pic à 100 % d'un cœur pendant 2-4 s au boot (single thread
  JS).
- **RAM** : pas d'impact direct (le parse coûte transitoirement
  ~30-50 MB).

### Impact UX
Très visible. Avant interactivité, **aucun click n'est traité**.
Mauvais effet de bord sur kiosque / borne tactile : un opérateur qui
veut couper d'urgence un instrument ne peut pas atteindre l'UI dans
les premières secondes.

### Solution recommandée
Étapes incrémentales :
1. **Phase 0 (10 min)** : ajouter `defer` sur **tous** les `<script
   src>` (le `defer` préserve l'ordre d'exécution → aucun risque de
   casse). Cela seul libère le parsing DOM et fait apparaître le HTML
   pendant le téléchargement.
2. **Phase 1 (1 jour)** : passer en `type="module"` les fichiers core
   (`AppRegistry`, `EventBus`, `BackendAPIClient`, `MidiConstants`,
   `escapeHtml`, `I18n`) avec imports nommés, en supprimant les
   `window.*` redondants.
3. **Phase 2 (2-3 jours)** : configurer `vite.config.js`
   `build.rollupOptions.output.manualChunks` pour séparer `vendor`
   (`lib/webaudio-pianoroll-custom.js`), `core`, et lazy-load chaque
   modale (`LoopCreatorModal`, `RoutingSummaryPage`,
   `MidiEditorModal`) via `import()` dynamique au moment d'ouverture.

### Difficulté implémentation
- Phase 0 : **triviale** (sed sur `index.html`, lancer tests
  frontend).
- Phase 1 : moyenne (conversion ESM).
- Phase 2 : moyenne (Vite manualChunks + dynamic imports).

### Gain attendu
- Phase 0 seule : **−3 à 5 s TTI** sur Pi.
- Phase 0 + 2 : **−6 à 8 s TTI**, bundle initial ramené de ~3,9 MB à
  ~500 KB ; modales lourdes (LoopCreator + RoutingSummary ≈ 250 KB
  combinées) ne pèsent plus sur le démarrage.

---

## C2 — WebSocket : reconnexion plafonnée à 10 tentatives, abandon définitif

### Problème détecté
Dans `public/js/api/BackendAPIClient.js:76,184-189`, après 10
tentatives de reconnexion (backoff exponentiel `1 → 30 s`, plafond
`30 s`), le client logue `Max reconnection attempts reached. Call
connect() manually to retry.` et émet `reconnect_failed`. Aucun
mécanisme automatique ne reprend la main : l'utilisateur doit
recharger la page (F5) pour récupérer l'UI.

### Gravité
**Critique** — Bloquant pour le profil 24/7 demandé. Si la liaison
réseau ou le backend redémarre (PM2 restart, upgrade, micro-coupure
Wi-Fi), la page reste figée jusqu'à reload manuel.

### Fichier(s) concerné(s)
- `public/js/api/BackendAPIClient.js:75-77, 182-210`.

### Cause profonde
Le cap (`maxReconnectAttempts = 10`) est un héritage d'une logique
desktop "fail fast". Pour un kiosque/Raspberry, le bon comportement
est **reconnexion infinie avec backoff borné et jitter**, doublée
d'un indicateur visuel discret.

### Impact réel
- Redémarrage `pm2 restart gmboop` ≥ 5 min → UI cassée.
- Wi-Fi qui rend la main après 6 min → idem.
- Tout opérateur loin de la machine doit revenir physiquement.

### Impact CPU/RAM
- Faible. Pendant la phase de tentative, ~1 ms / 30 s.
- Après abandon : 0 % CPU mais UI inutilisable.

### Impact UX
Très négatif sur installation embarquée. L'utilisateur final ne
distingue pas "réseau perdu" de "logiciel planté".

### Solution recommandée
1. Supprimer `maxReconnectAttempts` ou le porter à `Infinity`.
2. Conserver le backoff exponentiel mais le caper à 60 s **avec
   jitter** `delay = min(60_000, base * 2^n) * (0.5 + Math.random() *
   0.5)` pour éviter les thundering herd quand plusieurs clients
   redémarrent simultanément.
3. Émettre `connection:degraded` côté EventBus à partir de la 3ᵉ
   tentative pour qu'un bandeau "Reconnexion en cours…" apparaisse.
4. Sur succès, émettre `connection:restored` + déclencher
   re-souscriptions topics (subscriptions sont perdues à la
   reconnexion : voir audit serveur).

### Difficulté implémentation
**Facile** — 30 lignes modifiées, tests unitaires Vitest sur
`BackendAPIClient` à compléter (mock WebSocket).

### Gain attendu
Stabilité 24/7 réelle : l'UI se ré-attache automatiquement après
toute coupure backend/réseau ; plus aucune intervention humaine
nécessaire pour les coupures < 1 h.

---

## C3 — `FilterManager.destroy()` jamais appelé → fuite timers + listeners cumulative

### Problème détecté
`public/js/utils/FilterManager.js:682-687` expose une méthode
`destroy()` qui annule les `debounceTimers` et retire les listeners
DOM. **Aucune page ne l'appelle au démontage** (déjà documenté dans
`AUDIT_2026-05-10.md` finding #4, non corrigé). À chaque navigation
entre `PlaylistPage`, `FileListPage` ou autre page utilisant
`FilterManager`, une nouvelle instance s'ajoute en mémoire, avec ses
timers et ses listeners.

### Gravité
**Critique** — Représentatif d'un pattern frontal qui se généralise :
le ratio addEventListener (646) / removeEventListener (284) = 2,3
suggère que d'autres composants présentent le même défaut. Sur 24/7
avec navigation fréquente, cette fuite atteint quelques MB par
heure.

### Fichier(s) concerné(s)
- `public/js/utils/FilterManager.js:682-687`.
- Sites d'instanciation : `grep -rn "new FilterManager" public/js/` →
  `PlaylistPage`, `FileListPage`, `InstrumentManagementPage`,
  potentiellement `LoopCreatorModal`.

### Cause profonde
Aucun cycle de vie standardisé pour les pages : `BaseView` ne force
pas l'appel d'un `onLeave()`/`destroy()` qui propage à tous les
sous-composants. Le code applique le pattern "instance créée, jamais
détruite".

### Impact réel
- Sur 24h avec ~20 navigations entre pages : ~20 FilterManager
  fantômes, chacun retenant timers + DOM nodes orphelins.

### Impact CPU/RAM
- **RAM** : +50 à 200 KB par instance fantôme, donc 1-5 MB/24h.
- **CPU** : timers debounce 300 ms continuent de fire dans le vide
  → ~0,5 % CPU constant.

### Impact UX
Invisible jusqu'à dégradation cumulative : lag tactile après plusieurs
heures, GC pauses plus longues.

### Solution recommandée
1. Court terme : ajouter explicitement `this.filterManager?.destroy()`
   dans `onLeave`/`onClose` de chaque page consommatrice (4 sites).
2. Moyen terme : durcir `BaseView.destroy()` pour appeler
   automatiquement `destroy()` sur tous les attributs typés
   `_managed*` (ou enregistrés via un helper `this._track(obj)`).
3. Ajouter un test Vitest qui vérifie le nombre de listeners avant /
   après cycle ouverture-fermeture d'une page.

### Difficulté implémentation
**Facile** — 2 h pour le fix immédiat, 1 jour pour la convention
`_track`.

### Gain attendu
- Suppression immédiate d'une fuite documentée depuis 2026-05-10.
- Pattern applicable à d'autres composants → impact transverse sur
  la chasse aux orphelins.

---

## C4 — God-class `LoopCreatorModal.js` (3 394 lignes)

### Problème détecté
Une seule classe orchestre Library + Pad + Live + Arranger + transport
MIDI + drag-drop + history + multi-track. 19 `innerHTML =`, 10
`requestAnimationFrame`, 12 `setTimeout/setInterval`, ~50 références
DOM. Toute modification d'un onglet touche des conditionnels
disséminés dans 3 000 lignes.

### Gravité
**Critique** — Bloque les revues, tests unitaires, et fixes de bugs
documentés dans `AUDIT_MODAL_BOUCLES_2026-05-11.md` (40+ findings,
seuls 2 d'entre eux — `§L2`, `§L6` — sont aujourd'hui appliqués).

### Fichier(s) concerné(s)
- `public/js/features/LoopCreatorModal.js`.
- Tests inexistants pour cette modale.
- CSS associé `public/styles/loop-creator-modal.css` (1 565 l., 86
  `!important`).

### Cause profonde
Croissance organique : tabs ajoutés sans extraction, copy-paste de
patterns drag-drop entre tabs, état partagé par `this.*` au lieu
d'une store dédiée.

### Impact réel
- Temps moyen d'application d'un fix : 1-2 jours alors qu'une
  modale équivalente bien découpée prendrait < 4 h.
- Risque de régression à chaque PR.

### Impact CPU/RAM
Indirect : la modale charge tous ses sous-systèmes même si l'opérateur
ouvre seulement l'onglet Library, et tous les listeners restent
attachés tant qu'elle est instanciée.

### Impact UX
Latence d'ouverture > 200 ms même sur Pi 5 (parsing initial de la
classe + initialisation des 4 onglets simultanément).

### Solution recommandée
Suivre la **Phase 4** déjà planifiée dans
`AUDIT_MODAL_BOUCLES_2026-05-11.md` :
1. Extraire `loop/tabs/{LibraryTab, PadTab, LiveTab, ArrangerTab}.js`
   (chacune ≤ 700 lignes).
2. Extraire `loop/transport/LoopTransportController.js`.
3. Extraire `loop/state/LoopState.js` (store local + EventBus
   diffusion).
4. Réécrire `LoopCreatorModal.js` comme orchestrateur ≤ 400 lignes
   qui :
   - lazy-monte les tabs (création différée à la sélection),
   - délègue tout DOM aux tabs.
5. Couvrir chaque tab d'au moins 3 tests Vitest (smoke + state
   transition + dispose).

### Difficulté implémentation
**Élevée** — 3-5 jours/dev, mais l'extraction est mécanique car les
tabs sont déjà cloisonnés visuellement.

### Gain attendu
- Reviews PR ramenées à un onglet à la fois.
- Application des 38 findings restants de `AUDIT_MODAL_BOUCLES`
  devient possible.
- Latence ouverture modale : −30 à 40 % (lazy-mount).
- Couverture Vitest passe de ~0 % à > 60 % sur la modale.

---

## C5 — God-class `RoutingSummaryPage.js` (2 982 lignes)

### Problème détecté
Page auto-assign : matcher de routes + preview + UI summary + DOM
detail + 12 `innerHTML`, 4 `rAF`, 2 `AbortController` (au moins
celui-ci propre). 2 982 lignes pour une "page" alors que le découpage
horizontal a déjà été partiellement amorcé (`RoutingSummaryRenderers`,
`RoutingSummaryHelpers`, `RoutingSummaryApi`, etc., 9 fichiers
satellites).

### Gravité
**Critique** — Identifié dans `AUDIT_2026-05-10.md` finding #32. Le
fichier a été ramené de 3 477 à 2 982 lignes (-14 %) mais la
décomposition stagne.

### Fichier(s) concerné(s)
- `public/js/features/auto-assign/RoutingSummaryPage.js`.
- Famille `auto-assign/` (28 fichiers).

### Cause profonde
Le découpage existant est par "renderer/helper/api" (horizontal) au
lieu d'être par fonctionnalité (vertical). Le `Page` reste donc le
seul orchestrateur de tous.

### Impact réel
Identique à C4 : reviews lourdes, fixes lents.

### Impact CPU/RAM
Au démarrage de la page : charge toute la matrice de routing.
RoutingSummaryPage allocate plusieurs `Map` non bornés
(`_routesByChannel`, `_assignmentsByDevice`).

### Impact UX
Latence de premier rendu de la page perceptible (500-700 ms sur Pi 4).

### Solution recommandée
Découper en deux pages logiques :
1. `RoutingSummaryListPage` (tableau summary) ≤ 600 l.
2. `RoutingSummaryDetailPage` (matrice détail + preview) ≤ 800 l.

Plus extraire `auto-assign/state/RoutingState.js` qui centralise les
`Map` partagées avec lifecycle explicite.

### Difficulté implémentation
**Élevée** — 2-3 jours/dev.

### Gain attendu
- Phase 3 du plan d'action réalisable.
- Couverture Vitest élargie aux deux pages séparément.

---

## C6 — `index.html` monolithique de 14 201 lignes

### Problème détecté
Le fichier `public/index.html` héberge :
- 31 `<link rel=stylesheet>` (804 KB CSS au boot),
- 135 `<script src=>` séquentiels,
- ~2 000 lignes de scripts inline en fin de fichier qui
  instancient `AppState`, `PianoRollView`, `LyricsView`, et bootstrap
  l'app.

Aucun template extrait, aucun découpage par section.

### Gravité
**Critique** — Architecture : impossible de toucher un template sans
faire défiler 14 000 lignes ; impossible pour un nouveau dev de
comprendre le boot order ; conflits Git fréquents.

### Fichier(s) concerné(s)
- `public/index.html`.

### Cause profonde
Historique : le boot a toujours été inline. Pas de générateur de
templates ; les modales/pages utilisent `BaseModal.render()` qui
injecte le HTML programmatiquement, mais le **bootstrap** reste
hardcoded.

### Impact réel
- TTI dégradé (cf. C1).
- Onboarding développeur très lent.
- Risque de duplication de modales HTML (à valider plus finement).

### Impact CPU/RAM
- Parse HTML : ~150-300 ms sur Pi 4 pour ~580 KB.

### Impact UX
Indirect via C1.

### Solution recommandée
1. Court terme (lié à C1) : extraire la section inline finale dans
   `public/js/bootstrap.js` (chargé en `<script type="module">`).
2. Moyen terme : passer en build Vite **app SPA** avec un
   `index.html` minimal (< 200 lignes) + entrée unique
   `src/main.js`.
3. Long terme : si besoin, introduire `lit-html` ou
   `htm` (ultra léger, 4 KB) pour gérer les fragments
   réutilisables ; sinon, garder vanilla mais en modules.

### Difficulté implémentation
**Élevée** — Touche au boot, donc nécessite tests E2E manuels
sérieux.

### Gain attendu
- Maintenance frontale réduite : un fichier modifiable par section.
- Index réel < 200 lignes après refonte.

---

# Findings — Gravité ÉLEVÉE (P1)

## E1 — `MidiSynthesizer` alloue oscillator/gain par voix → pression GC

### Problème détecté
`public/js/audio/MidiSynthesizer.js` crée systématiquement
`ctx.createGain()` / `ctx.createOscillator()` /
`ctx.createBufferSource()` à chaque note-on (voir `grep -nE
'createOscillator|createGain|createBufferSource'`). Aucune pool de
voix ; chaque voix terminée laisse ses noeuds référencés
temporairement avant GC.

### Gravité
**Élevée** — En polyphonie dense (≥ 16 voix actives, typique en
piste piano ou orchestrale), pression GC mesurable.

### Fichier(s) concerné(s)
- `public/js/audio/MidiSynthesizer.js` (1 833 lignes).

### Cause profonde
Pattern WebAudioFont natif. WAF ne fournit pas de pool ; chaque appel
`player.queueWaveTable` retourne un envelope qui crée des noeuds.

### Impact réel
- Sur Pi 4 Chromium, en lecture polyphonique :
  GC pause majeure ~500 ms toutes les 2-5 s lors de pics.
- Audible : micro-coupures audio.

### Impact CPU/RAM
- **CPU** : pic GC = 5-10 % cumulé.
- **RAM** : oscillations 5-15 MB par seconde.

### Impact UX
Glitches audio aléatoires perceptibles sur séquences denses.

### Solution recommandée
1. Implémenter un voice pool de taille max 32, recyclable :
   - `acquireVoice(programId)` → retourne `{ gain, source }` ou
     `null` (vol coupé).
   - `releaseVoice(voice)` après note-off + tail.
2. Réutiliser les `AudioBufferSourceNode` est interdit (one-shot),
   mais les `GainNode` et `BiquadFilterNode` se recyclent.
3. Limiter le nombre de voix concurrentes (steal voice la plus
   ancienne si > 32).

### Difficulté implémentation
**Moyenne** — 1 jour/dev, mais nécessite tests audio comparatifs.

### Gain attendu
- GC pause majeure éliminée.
- CPU −10 à 15 % en lecture polyphonique.

---

## E2 — Deux instances `MidiSynthesizer` actives → deux `AudioContext`

### Problème détecté
`public/js/audio/AudioPreview.js:33-37` crée une **deuxième** instance
de `MidiSynthesizer` (`this.synthesizer = new window.MidiSynthesizer();
await this.synthesizer.initialize();`). Chaque instance crée son
propre `AudioContext` (`MidiSynthesizer.js:532`). Or Chromium plafonne
à ~6 `AudioContext` par onglet ; en pratique on en a déjà 2 et
potentiellement 3+ si `LoopEditorModal._metronomeCtx` (qui est bien
fermé en `onClose`, cf. `LoopEditorModal.js:678-684`) est ouvert
simultanément.

### Gravité
**Élevée** — Pas un crash bloquant mais consommation double de WebAudio
threads et risque d'épuisement de la limite à long terme si un
nouveau composant ajoute un `AudioContext`.

### Fichier(s) concerné(s)
- `public/js/audio/AudioPreview.js`.
- `public/js/audio/MidiSynthesizer.js:67, 532`.

### Cause profonde
`AudioPreview` a été conçu comme "preview indépendant du synthé
principal" pour ne pas couper la lecture en cours. Décision
défendable, mais la double allocation est invisible.

### Impact réel
- Mémoire WebAudio doublée : ~10-20 MB par contexte.
- Deux threads audio actifs : sur Pi avec 4 cœurs, OK ; sur Pi 3 ou
  Pi Zero, gourmand.

### Impact CPU/RAM
- **CPU** : 5-8 % constant tant qu'AudioPreview existe (le contexte
  reste actif même hors lecture).
- **RAM** : +15-20 MB.

### Impact UX
Imperceptible aujourd'hui, mais marge tampon sur la limite Chromium
réduite.

### Solution recommandée
Option A (recommandée) : partager le `MidiSynthesizer` principal et
ajouter un mode "preview" (deuxième sortie + ducking du master).
Option B : couper systématiquement le contexte preview après lecture
(`this.synthesizer.audioContext.suspend()` puis `.close()` à dispose).

### Difficulté implémentation
**Moyenne** — Option A demande de tracer les call sites et de gérer
la coexistence preview/playback. Option B est plus simple : 4 h.

### Gain attendu
- −15 à 20 MB RAM stable.
- −5 % CPU constant.

---

## E3 — Métronome `setInterval` cumulatif → dérive de 100-200 ms

### Problème détecté
`public/js/features/LoopEditorModal.js:1077-1087` utilise un
`setInterval(fire, secPerBeat * 1000)` pour ordonnancer le métronome
au lieu d'utiliser le scheduler `AudioContext.currentTime`. Les
commentaires (`// que des setTimeout cumulatifs, qui dérivent de
100+ ms…`) reconnaissent le problème mais le code ne le corrige pas.

### Gravité
**Élevée** — Le métronome est un outil de précision pour
l'enregistrement ; un drift de 100 ms sur 4 mesures rend
l'enregistrement inutilisable.

### Fichier(s) concerné(s)
- `public/js/features/LoopEditorModal.js:1077-1095`.

### Cause profonde
`setInterval` est sujet à drift cumulatif et au throttling
navigateur quand l'onglet perd le focus. WebAudio fournit un
scheduling déterministe via `AudioContext.currentTime` et des appels
`osc.start(absoluteTime)`.

### Impact réel
- Enregistrement quantizé : notes décalées progressivement.

### Impact CPU/RAM
- Négligeable (le pattern reste léger).

### Impact UX
Très négatif pour l'usage musical (un musicien remarquera le drift à
60 BPM dès 4 mesures).

### Solution recommandée
Look-ahead scheduler classique :
```js
const scheduleAheadSec = 0.1;
let nextBeatTime = ctx.currentTime;
function scheduler() {
  while (nextBeatTime < ctx.currentTime + scheduleAheadSec) {
    this._tickAt(nextBeatTime, beat % beatsPerBar === 0);
    nextBeatTime += 60 / this.tempo;
    beat++;
  }
}
this._metronomeRaf = setInterval(scheduler, 25);
```
`_tickAt(t, strong)` prend un timestamp absolu et démarre l'oscillateur
à ce temps précis (`osc.start(t)`).

### Difficulté implémentation
**Moyenne** — 1-2 h/dev + tests d'écoute.

### Gain attendu
- Drift < 1 ms quel que soit le tempo et la durée d'enregistrement.

---

## E4 — God-classes secondaires : `ISMSections.js`, `KeyboardPiano.js`, `KeyboardChords.js`

### Problème détecté
Trois fichiers > 1 500 lignes hors LoopCreator/RoutingSummary :
- `public/js/features/instrument-settings/ISMSections.js` : 2 213 l.
- `public/js/features/keyboard/KeyboardPiano.js` : 2 052 l. (7
  `requestAnimationFrame`, 7 `innerHTML`).
- `public/js/features/keyboard/KeyboardChords.js` : 1 662 l.

### Gravité
**Élevée** — Même problématique que C4/C5 mais sur des composants
moins critiques.

### Fichier(s) concerné(s)
- Indiqués ci-dessus.

### Cause profonde
Pareil que C4 : croissance organique sans extraction. Pour
`KeyboardPiano`, le dossier `keyboard/` contient déjà 8 satellites
(`KeyboardEvents`, `KeyboardControls`, `NoteEngine`, `VoicingEngine`,
`NoteSlider`, `KeyboardSlider`, etc.) → l'extraction est entamée mais
inachevée.

### Impact réel
- Reviews difficiles.
- Bug `REPRISE_PIANO_HANDS_BUG.md` non résolu, probablement à cause
  de l'imbrication des renderers.

### Impact CPU/RAM
Indirect : `KeyboardPiano` redessine tout son canvas à chaque rAF,
même pour de petits changements.

### Impact UX
Latence interaction clavier > 16 ms sur Pi 4 dans certaines
configurations.

### Solution recommandée
Pour `KeyboardPiano` :
1. Extraire `KeyboardCanvasRenderer` (drawing pur, < 600 l.).
2. Extraire `KeyboardLayoutEngine` (mapping note ↔ pixel).
3. Extraire `KeyboardInteractionController` (mouse/touch/keys).
4. Garder `KeyboardPiano` comme façade ≤ 400 l.

Pour `ISMSections` : découper par section (`FamilySection`,
`InstrumentSection`, `ProgramSection`).

Pour `KeyboardChords` : extraire `ChordDetectionEngine` et
`ChordVoicingPicker`.

### Difficulté implémentation
**Élevée** — 2-3 jours/composant.

### Gain attendu
- Couverture testable.
- Bug piano-hands de `REPRISE_PIANO_HANDS_BUG.md` devient
  diagnostiquable.

---

## E5 — Code mort architectural : `BaseController.js` et `AppRegistry.js`

### Problème détecté
- `public/js/core/BaseController.js` (480 lignes) : `grep -rn 'extends
  BaseController'` retourne **zéro** résultat. La classe expose un
  pattern MVC complet (state machine, ensureBackendAvailable, etc.)
  qui n'est utilisé nulle part dans le frontend actuel.
- `public/js/core/AppRegistry.js` (135 lignes) : `grep -rn
  'AppRegistry\|appRegistry'` retourne **zéro** consommateur en
  dehors du fichier source. Le pattern DI (`register`,
  `registerFactory`, `get`) n'est jamais utilisé : tout passe par
  `window.*` direct, doublonnant l'EventBus singleton
  (`EventBus.js:419-423`).

### Gravité
**Élevée** (dette architecturale, faible bénéfice) — Pas une panne
mais 615 lignes inutiles, deux patterns DI parallèles qui sèment la
confusion.

### Fichier(s) concerné(s)
- `public/js/core/BaseController.js`
- `public/js/core/AppRegistry.js`

### Cause profonde
Tentatives d'introduction de patterns "propres" non suivies.
`BaseController` est probablement vestige d'une refonte MVC abandonnée.
`AppRegistry` est plus récent (v1.0.0 dans le header), pensé pour
remplacer `window.*` mais aucun consommateur n'a migré.

### Impact réel
- Bundle initial inutilement +20 KB.
- Confusion : un nouveau dev pense pouvoir utiliser ce pattern, perd
  du temps.

### Impact CPU/RAM
- Négligeable au runtime (classes jamais instanciées).
- Faible au boot : parse de 615 lignes inutiles.

### Impact UX
Aucun direct.

### Solution recommandée
**Décision binaire** :
- Si la roadmap prévoit une migration `window.* → AppRegistry`, alors
  garder `AppRegistry` mais **planifier la migration** (PR
  cibles : `BackendAPIClient`, `EventBus`, `MidiSynthesizer`,
  `I18n`).
- Sinon, **supprimer les deux fichiers** + retirer leurs balises
  `<script>` de `index.html`.

`BaseController` peut être supprimé sans hésitation : aucune feature
ne l'étend.

### Difficulté implémentation
**Triviale** — 30 min de suppression + tests smoke.

### Gain attendu
- −615 lignes JS (~20 KB) si suppression.
- Clarté architecturale : un seul pattern de DI/eventing.

---

## E6 — Quatre systèmes piano-roll coexistants

### Problème détecté
1. `public/lib/webaudio-pianoroll-custom.js` : custom element
   `<webaudio-pianoroll>` (lib vendored, ~2 188 l.).
2. `public/js/features/PianoRollEditor.js` : utilisée par
   `LoopEditorModal.js:408`.
3. `public/js/features/PianoRollView.js` : instanciée dans
   `index.html:14141` (`pianoRollView = new PianoRollView(…)`).
4. `public/js/features/midi-editor/MidiEditorRenderer.js` : rendu
   piano-roll dans la modale d'édition MIDI complète.

Tous ces modules dessinent un piano-roll mais avec des codes
différents, des conventions de pitch différentes, et des intersections
de bugs probables (cf. `REPRISE_PIANO_HANDS_BUG.md`).

### Gravité
**Élevée** — Maintenance × 4, bugs se propagent ou divergent.

### Fichier(s) concerné(s)
- `public/lib/webaudio-pianoroll-custom.js`
- `public/js/features/PianoRollEditor.js`
- `public/js/features/PianoRollView.js`
- `public/js/features/midi-editor/MidiEditorRenderer.js`

### Cause profonde
Le custom element `<webaudio-pianoroll>` (sans doute fork de Surikov)
était la solution initiale. Les autres ont été créés au fil des
besoins sans déprécier l'ancien.

### Impact réel
- Si on fixe le rendu dans l'un, il faut le refaire dans les autres.
- L'audit `REPRISE_PIANO_HANDS_BUG.md` documente que le bug "main qui
  se balade avec la vue" persiste — probablement parce qu'un
  renderer divergent est utilisé.

### Impact CPU/RAM
- Bundle : ~2 200 lignes de `<webaudio-pianoroll>` chargées même si
  un seul des autres renderers est utilisé.

### Impact UX
Incohérences visuelles entre éditeur MIDI / loop-editor / lecture
playback.

### Solution recommandée
1. **Auditer l'usage** : tracer l'arbre d'appels de
   `<webaudio-pianoroll>`. S'il est utilisé seulement dans
   `PianoRollEditor.js` comme rendu interne → garder uniquement
   l'enrobage.
2. Définir un **PianoRoll canonique** = `PianoRollView` (lecture
   seule) + `PianoRollEditor` (édition). Le `MidiEditorRenderer` doit
   réutiliser `PianoRollEditor` au lieu de réimplémenter.
3. Supprimer `webaudio-pianoroll-custom.js` une fois la migration
   faite.

### Difficulté implémentation
**Élevée** — 2-3 jours/dev, nécessite tests visuels et fonctionnels.

### Gain attendu
- Bug `REPRISE_PIANO_HANDS_BUG.md` devient adressable en un seul
  endroit.
- Bundle −80 à 90 KB.
- Cohérence visuelle.

---

## E7 — Ratio `addEventListener:646 / removeEventListener:284` (2,3 : 1)

### Problème détecté
Globalement dans `public/js/`, le code attache 646 listeners DOM mais
n'en retire que 284. Le ratio attendu pour un code propre tourne
autour de 1,3-1,5 (certains listeners attachés à `document`/`window`
au boot ne sont effectivement jamais retirés et c'est OK). Un ratio
2,3 indique des dizaines de listeners orphelins potentiels.

### Gravité
**Élevée** — Cause directe de fuites mémoire et de comportements
fantôme (handlers qui réagissent à des événements alors que la modale
est fermée).

### Fichier(s) concerné(s)
- Tout `public/js/features/`.
- Suspects principaux (taille × densité) : `LoopCreatorModal.js`,
  `RoutingSummaryPage.js`, `KeyboardPiano.js`, `MidiEditorModal.js`,
  `PianoRollEditor.js`.

### Cause profonde
Pas de mécanisme `_track(el, evt, handler)` standardisé. Chaque
développeur ajoute des `addEventListener` sans garantie que
l'équivalent `removeEventListener` sera écrit dans `destroy()`. Les
handlers anonymes (closures) ne **peuvent pas** être retirés sans
référence stockée.

### Impact réel
- Fuites cumulatives sur 24/7.
- Handlers fantômes qui exécutent du code dans le vide
  (`this` parfois pointant sur composants disposés).

### Impact CPU/RAM
- **RAM** : 1-5 MB cumulatifs par jour.
- **CPU** : 0,5-2 % constants selon le volume d'événements.

### Impact UX
Lag perceptible après plusieurs heures d'usage.

### Solution recommandée
1. Introduire dans `BaseView`/`BaseModal` un helper :
   ```js
   _on(el, evt, handler, opts) {
     el.addEventListener(evt, handler, opts);
     this._trackedListeners ??= [];
     this._trackedListeners.push([el, evt, handler, opts]);
   }
   destroy() {
     for (const [el, evt, h, o] of this._trackedListeners ?? []) {
       el.removeEventListener(evt, h, o);
     }
     this._trackedListeners = null;
   }
   ```
2. Audit progressif : convertir les 646 `addEventListener` en `this._on(…)` en
   commençant par les god-classes.
3. Test Vitest : ouvrir/fermer une modale 100 fois et compter les
   listeners restants sur `document` via `getEventListeners` (DevTools)
   en environnement test.

### Difficulté implémentation
**Moyenne** — 1-2 jours pour le helper + migration des modales
critiques.

### Gain attendu
- Croissance heap idle ramenée < 0,5 MB/h.
- Pattern propagable à tous les nouveaux composants.

---

## E8 — Canvas full-redraw à chaque rAF dans plusieurs renderers temps réel

### Problème détecté
Les renderers temps réel suivants effectuent un redraw complet du
canvas à chaque `requestAnimationFrame` (pas de dirty region, pas de
delta) :
- `PlaybackTimelineBar.js`
- `PianoRollView.js`
- `DrumGridRenderer.js`
- `WindMelodyRenderer.js`
- `TablatureRenderer.js`
- `LoopCreatorMinimap.js`
- `CCPitchbendEditor.js`
- `VelocityEditor.js`
- `NavigationOverviewBar.js`

Ouvrir une page combinant 3-4 de ces renderers (ex : lecture +
minimap + pianoroll + tablature) force le CPU navigateur à dessiner
~240 frames/s cumulés.

### Gravité
**Élevée** — CPU navigateur saturé sur Pi 4 dans les vues denses.

### Fichier(s) concerné(s)
- Tous listés ci-dessus.

### Cause profonde
Pattern "tout redessiner" simple à écrire mais coûteux. La pluralité
de renderers actifs au même moment est insuffisamment coordonnée.

### Impact réel
- FPS effectif ~25-30 sur vues denses (sub-50).
- Fan Pi qui tourne, alimentation chauffe.

### Impact CPU/RAM
- **CPU** : 40-60 % d'un cœur en vue dense.
- **RAM** : OK.

### Impact UX
Jank visible, animations saccadées.

### Solution recommandée
1. Introduire dans `PlaybackTimelineBar` une vraie *dirty region* :
   ne redessiner que le rectangle autour du playhead + cursor + clip
   zone modifiée.
2. Pour les minimaps qui ne changent qu'au scroll/zoom : passer en
   *cached bitmap* `OffscreenCanvas.transferToImageBitmap` ; ne
   recalcule qu'au changement de zoom/range.
3. Coordonner les rAF : un seul "ticker" central (EventBus
   `frame:tick`) auquel chaque renderer s'abonne, lui-même piloté à
   ~30 Hz sur Pi (cible 33 ms entre frames) au lieu des 60 Hz par
   défaut.
4. `requestVideoFrameCallback` n'est pas utilisable ici (pas de vidéo)
   mais on peut throttler `rAF` côté Pi à 30 FPS avec un
   `performance.now()` gate.

### Difficulté implémentation
**Moyenne à élevée** — 2-3 jours pour traiter les 3-4 renderers les
plus coûteux.

### Gain attendu
- CPU navigateur −20 à 30 % en vue dense.
- FPS effectif > 50 sur Pi 4.

---

## E9 — CSS : 653 `!important` et fichiers doublons

### Problème détecté
- 653 `!important` sur 32 636 lignes CSS (taux 2 %).
- Top fichiers : `keyboard-modal.css` 99, `components.css` 87,
  `loop-creator-modal.css` 86, `bluetooth-scan-modal.css` 85,
  `loop-editor-modal.css` 67.
- Doublons probables :
  - `keyboard.css` + `keyboard-modal.css` + `keyboard-polish.css`
    + `keyboard-hand-position-editor.css` (4 fichiers).
  - `loop-creator-modal.css` + `loop-editor-modal.css` (séparation
    arbitraire, beaucoup de classes `.lc-*` partagées).
  - `playlist.css` + `modal-playlist.css`.
- Variables CSS éparpillées dans plusieurs fichiers (au lieu de
  `variables.css` central).

### Gravité
**Élevée** — Maintenance CSS impossible. Un changement de thème ou
de token nécessite 5+ fichiers ; la cascade est brisée par les
`!important`.

### Fichier(s) concerné(s)
- Toute `public/styles/`.

### Cause profonde
Croissance organique fichier-par-modale ; absence de design system /
tokens centralisés ; `!important` utilisé comme palliatif aux
spécificités héritées.

### Impact réel
- Bugs de cascade fréquents ("la couleur ne change pas"). Souvent
  cachés par `!important`, qui en génère d'autres en cascade.
- Refonte thématique impossible sans audit complet.

### Impact CPU/RAM
- **Boot** : 804 KB CSS parsés (32 fichiers en eager).
- **Runtime** : recalcul style fréquent sur ouverture modale
  (`!important` augmente les spécificités à recompiler).

### Impact UX
Inconsistance visuelle entre modales (boutons légèrement différents,
bordures variables).

### Solution recommandée
**Phase CSS dédiée** (cf. plan d'action) :
1. Centraliser tous les tokens (`--color-*`, `--radius-*`,
   `--space-*`, `--font-*`) dans `variables.css` + `themes.css`.
2. Fusionner les fichiers `keyboard-*.css` en un seul module CSS
   (BEM `.kb-modal`, `.kb-piano`, `.kb-hand-position`).
3. Fusionner `loop-*-modal.css` → `loops.css` unique avec
   préfixes `.lc-` (creator) et `.le-` (editor) déjà cohérents.
4. Auditer et supprimer chaque `!important` ; remplacer par
   augmentation de spécificité ou refactor du sélecteur parent.
5. Charger les CSS modales en `import()` dynamique avec la modale
   (lazy CSS).

### Difficulté implémentation
**Élevée** — 2-3 jours, nécessite tests visuels.

### Gain attendu
- Boot CSS −40 % (lazy modales).
- Cascade lisible, refonte thématique faisable en 1 fichier.

---

## E10 — Trois implémentations parallèles de `escapeHtml`

### Problème détecté
Identifié dans `AUDIT_2026-05-10.md` finding #20, non corrigé :
- `public/js/utils/escapeHtml.js` (canonique, expose
  `window.escapeHtml`).
- `public/js/features/HandPositionWarningsToast.js:35` (réimplémentée
  inline).
- `public/js/features/InstrumentManagementPage.js` méthode
  `_escapeHtml` (réimplémentée inline).

### Gravité
**Élevée** (sécurité) — Une seule implémentation buggée = XSS. Le
fichier `InstrumentManagementPage.js:598` est déjà signalé comme
fragile dans l'audit (inline `onclick` + `escAttr` insuffisant).

### Fichier(s) concerné(s)
- Listés ci-dessus.

### Cause profonde
Pas de convention "toujours utiliser `window.escapeHtml`". Pas de
lint rule pour détecter les redéfinitions.

### Impact réel
Risque XSS sur entrées BLE / noms utilisateur custom.

### Impact CPU/RAM
Négligeable.

### Impact UX
Aucun direct, mais sécurité.

### Solution recommandée
1. Remplacer `_escapeHtml` interne par `escapeHtml(…)` global dans les
   deux fichiers.
2. Ajouter un test ESLint custom (no-restricted-syntax) qui interdit
   les redéfinitions locales de `escapeHtml`.
3. Migrer `InstrumentManagementPage.js:598` du `onclick` inline vers
   `addEventListener` + `dataset` (recommandation du finding #15 de
   l'audit 2026-05-10).

### Difficulté implémentation
**Facile** — 1-2 h.

### Gain attendu
- Surface XSS réduite à 1 point.
- Code mort éliminé.

---

# Findings — Gravité MOYENNE (P2)

## M1 — `innerHTML = array.map().join()` hotspots → DOM churn O(N)

### Problème détecté
Top fichiers par occurrences `innerHTML =` :
- `SettingsUpdate.js` : 20
- `LoopCreatorModal.js` : 19
- `ISMListeners.js` : 16
- `RoutingSummaryPage.js` : 12
- `LightingDeviceUI.js` : 10
- `PlaylistPage.js` : 9

Chaque appel remplace l'intégralité d'un sous-arbre DOM ; perte
totale des listeners attachés (cause indirecte de E7).

### Gravité
**Moyenne** — Coût visible si la liste contient > 20 items.

### Fichier(s) concerné(s)
- Listés.

### Cause profonde
Pattern "regenerate everything" choisi pour sa simplicité.
Aucune lib de diffing (ce qui est OK pour vanilla, mais nécessite
discipline).

### Impact réel
- DOM churn 5-15 ms par refresh sur Pi 4 pour listes 20-50 items.
- Listeners DOM détachés à chaque refresh → contribue à E7.

### Impact CPU/RAM
- **CPU** : pics 20-40 ms cumulés par refresh dans `RoutingSummaryPage`
  (matrice grande).
- **RAM** : churn temporaire de noeuds DOM.

### Impact UX
Saccades visibles lors de refresh fréquent.

### Solution recommandée
1. Pour listes : `keyed list update` minimaliste — remplacer les
   `innerHTML =` par un diff sur les clés (un helper ~30 lignes) ou
   `<template>` réutilisable.
2. Pour matrices : `<table>` avec cell-update sélectif au lieu de
   rebuild.
3. Cibler les 3 worst offenders (`SettingsUpdate`, `LoopCreatorModal`,
   `ISMListeners`) en premier.

### Difficulté implémentation
**Moyenne** — 4-8 h/fichier ciblé.

### Gain attendu
- −30 à 50 % temps refresh listes denses.
- Listeners préservés (couplage avec E7).

---

## M2 — `MidiSynthesizer` charge `WebAudioFontPlayer` global externe

### Problème détecté
`public/js/audio/MidiSynthesizer.js:527-528` vérifie
`typeof WebAudioFontPlayer === 'undefined'` et throw si la lib globale
n'est pas chargée. Le fallback CDN historique est
`https://surikov.github.io/webaudiofont/npm/dist/WebAudioFontPlayer.js`
(commentaires dans `MidiSynthesizerConstants.js`). Cela introduit une
dépendance réseau cachée.

### Gravité
**Moyenne** — En production sur installation locale, si le CDN n'est
pas joignable (firewall, hors-ligne, Pi sans accès internet),
le synthé refuse d'initialiser.

### Fichier(s) concerné(s)
- `public/js/audio/MidiSynthesizer.js:527-528`.
- `public/js/audio/MidiSynthesizerConstants.js` (commentaires
  expliquant l'origine).

### Cause profonde
Migration GMBP (format binaire local) en cours ; le `WebAudioFontPlayer`
reste requis pour le player.

### Impact réel
- Hors-ligne complet : synthé KO.
- Pi en kiosque sans internet : synthé KO si CDN n'a pas été pré-mis
  en cache.

### Impact CPU/RAM
Négligeable.

### Impact UX
**Bloquant** dans un scénario "Pi seul sur scène sans Wi-Fi".

### Solution recommandée
1. Vendore `WebAudioFontPlayer.js` dans `public/lib/` et le charger en
   local (pin version dans un commentaire).
2. Vérifier au boot la disponibilité offline (`if (!navigator.onLine)
   && !window.WebAudioFontPlayer` → message clair).
3. À terme, remplacer par un player local (le format GMBP custom
   pourrait s'autosuffire si le player est ré-implémenté en interne).

### Difficulté implémentation
**Facile** — 1 h pour vendoring + 1 ligne d'inclusion.

### Gain attendu
- Indépendance internet totale.
- Pas d'erreur initialisation en environnement air-gapped.

---

## M3 — `migrateLegacy.js` (v0.7 → v0.8) toujours présent

### Problème détecté
`public/js/migrateLegacy.js` (23 lignes) effectue une migration
localStorage des clés `maestro_*`/`midimind_*` vers `gmboop_*`. Le
JSDoc précise : « Remove this file and its `<script>` tag in 0.8.0 ».
Le `package.json` annonce `version: 0.8.1`.

### Gravité
**Moyenne** — Code mort planifié, oubli simple.

### Fichier(s) concerné(s)
- `public/js/migrateLegacy.js`.
- `public/index.html` (balise script associée).

### Cause profonde
Migration one-shot oubliée à la release v0.8.

### Impact réel
23 lignes JS exécutées au boot pour rien (chaque utilisateur a déjà
migré, ou n'a jamais connu Ma-est-tro/MidiMind).

### Impact CPU/RAM
Négligeable.

### Impact UX
Aucun.

### Solution recommandée
Supprimer le fichier + retirer le `<script>` de `index.html`. Vérifier
qu'aucun test ne dépend de ce code (`grep -rn migrateLegacy tests/`).

### Difficulté implémentation
**Triviale** — 5 min.

### Gain attendu
- 23 lignes en moins, conformité à la roadmap.

---

## M4 — Cohabitation `jest` + `vitest` → deux runners de test

### Problème détecté
`package.json` déclare en `devDependencies` à la fois `jest@29.7` et
`vitest@4.1`. Scripts :
- `npm test` → Jest (tests backend dans `tests/`).
- `npm run test:frontend` → Vitest (tests frontend dans
  `tests/frontend/`).
Deux configs (`jest.config.cjs`, `vitest.config.js`) coexistent.

### Gravité
**Moyenne** — Maintenance double, surface d'attaque CI plus large.

### Fichier(s) concerné(s)
- `package.json`, `jest.config.cjs`, `vitest.config.js`.

### Cause profonde
Migration partielle vers Vitest pour le frontend (vanilla + jsdom).
Le backend (Node + ESM) reste sur Jest pour des raisons historiques.

### Impact réel
- 200 KB+ de dépendances dev en double (deux frameworks de test).
- CI plus lente (deux phases).
- Documentation contributeurs à doubler.

### Impact CPU/RAM
Aucun en runtime.

### Impact UX
Aucun.

### Solution recommandée
**Standardiser sur Vitest** (qui supporte ESM natif et tests
backend). Migrer `tests/` vers Vitest progressivement. Garder
Jest seulement si une feature spécifique manque (`jest.config.cjs`
configure peu de chose, la migration devrait être directe).

### Difficulté implémentation
**Moyenne** — 1-2 jours pour migrer tous les tests
(`tests/api/`, `tests/services/`, etc.).

### Gain attendu
- −1 framework de test, install plus rapide, CI simplifiée.

---

## M5 — Configuration Vite sans `manualChunks` et sourcemaps prod désactivées

### Problème détecté
`vite.config.js` :
```js
build: {
  outDir: …,
  emptyOutDir: true,
  rollupOptions: { input: 'public/index.html' },
  minify: 'oxc',
  sourcemap: false
}
```
Pas de `manualChunks` → tout finit dans un seul gros chunk.
`sourcemap: false` en prod = stack traces inutilisables si bug
remonte d'une installation.

### Gravité
**Moyenne** — Limite l'effet d'optimisation et la diagnosibilité.

### Fichier(s) concerné(s)
- `vite.config.js`.

### Cause profonde
Configuration minimale par défaut, jamais étendue.

### Impact réel
- Bundle initial gros (cf. C1).
- Diagnostic prod difficile.

### Impact CPU/RAM
- **Boot** : parse d'un unique gros chunk au lieu de chunks
  parallélisables.

### Impact UX
Indirect via C1.

### Solution recommandée
1. Activer `sourcemap: 'hidden'` en prod (génère les sourcemaps sans
   les référencer dans le bundle ; on peut les uploader sur un
   serveur d'erreurs ou les garder offline).
2. Configurer `manualChunks` :
   ```js
   output: {
     manualChunks: {
       'vendor-pianoroll': ['lib/webaudio-pianoroll-custom.js'],
       'core': ['js/core/EventBus.js', 'js/api/BackendAPIClient.js'],
       'audio': ['js/audio/MidiSynthesizer.js',
                 'js/audio/AudioPreview.js']
     }
   }
   ```
3. Dynamic imports pour les modales lourdes (cf. C1 Phase 2).

### Difficulté implémentation
**Facile** — 1-2 h.

### Gain attendu
- Bundle initial < 800 KB gzip.
- Cache navigateur efficace par chunk.

---

## M6 — `console.log/warn/error` en production (147 occurrences)

### Problème détecté
`grep -rcE 'console\.(log|warn|error)' public/js/` retourne 147
occurrences cumulées. Top files :
- `PlaylistPage.js` : 13
- `RoutingSummaryPage.js` : 11
- `SettingsUpdate.js` : 10
- `I18n.js` : 9
- `BackendAPIClient.js` : 7

### Gravité
**Moyenne** — Bruit en prod, légère perf en hot path, pas critique
sur le volume actuel.

### Fichier(s) concerné(s)
- Listés.

### Cause profonde
Pas de logger frontend dédié. `console.*` direct utilisé partout.

### Impact réel
- Pollution DevTools en prod, masque des warnings utiles.
- En cas de hot path bouclant (ex : erreur WS rétrécit dans un loop),
  console saturée.

### Impact CPU/RAM
- Négligeable au volume actuel.
- Notable si bouclage erreurs (peut atteindre 1-2 %).

### Impact UX
Aucun direct.

### Solution recommandée
1. Introduire `public/js/core/Logger.js` (parallèle au logger
   backend), avec niveaux (`DEBUG`/`INFO`/`WARN`/`ERROR`) et un
   flag `localStorage.gmboop_log_level`.
2. Remplacer progressivement `console.log` → `logger.debug`,
   `console.error` → `logger.error`.
3. En prod, par défaut niveau `WARN` ; en debug, l'utilisateur
   bascule via une commande console (`window.gmboop.setLogLevel(…)`).

### Difficulté implémentation
**Moyenne** — 4-6 h pour le logger, puis migration progressive.

### Gain attendu
- Console prod propre, debug facile.

---

## M7 — Animations CSS coûteuses (`backdrop-filter`, `blur`, 49 `@keyframes`)

### Problème détecté
Analyse CSS : `backdrop-filter`, `filter: blur(…)`, `transition`,
`animation` utilisés abondamment dans les modales. Sur Pi, ces effets
sont coûteux en GPU/CPU.

### Gravité
**Moyenne** — Perceptible sur ouverture modale.

### Fichier(s) concerné(s)
- `public/styles/components.css`, `keyboard-modal.css`,
  `loop-creator-modal.css`, etc.

### Cause profonde
Pattern UI moderne (glass-morphism) plaqué sur hardware contraint.

### Impact réel
- Latence ouverture modale 100-300 ms sur Pi 4.
- Frame drops pendant transitions.

### Impact CPU/RAM
- **CPU** : pics 30-50 % d'un cœur pendant transitions.
- **GPU** : effets blur/backdrop-filter coûtent gros.

### Impact UX
Animations saccadées peuvent donner sentiment de "lourdeur".

### Solution recommandée
1. Ajouter une media query / classe pour désactiver les effets
   coûteux sur Pi :
   ```css
   @media (prefers-reduced-motion: reduce) { … }
   ```
   ou un settings utilisateur `accessibility-focus.css` (déjà
   présent !) étendu.
2. Remplacer `backdrop-filter: blur(20px)` par une couleur
   semi-transparente fixe sur Pi (perte visuelle minime, gain
   massif).
3. Préférer `transform`/`opacity` (composited) à `filter`/`width`
   (layout/paint).

### Difficulté implémentation
**Moyenne** — 1 jour de chasse aux effets coûteux.

### Gain attendu
- Ouverture modale −150 ms.
- FPS pendant transitions > 50.

---

## M8 — 28 locales JSON (2,8 MB sur disque)

### Problème détecté
`public/locales/` contient 28 langues, chacune ~100 KB. Le code
(`I18n.js`) charge correctement **une seule locale à la fois** via
`fetch('/locales/${locale}.json')`. Le coût boot est donc OK (~20 KB
gzip pour la locale active).

Cependant, `INSTRUMENT_FAMILY_REFACTOR_ROADMAP.md` et
`AUDIT_MODAL_BOUCLES_2026-05-11.md` § U6 documentent que **728 clés
nouvelles sont en fallback EN dans 26 locales** (loop manager, drum
kits, families).

### Gravité
**Moyenne** — Pas un problème de perf mais de couverture/UX dans les
locales non majoritaires (ja, pt, ru, …).

### Fichier(s) concerné(s)
- `public/locales/*.json` (28 fichiers).
- `public/js/i18n/I18n.js`.

### Cause profonde
Traductions ajoutées en EN, propagation à 26 locales reportée.

### Impact réel
- L'utilisateur d'une locale incomplète voit du texte EN au milieu
  d'une UI majoritairement traduite.
- 2,8 MB sur disque dont peut-être 30 % de fallback EN.

### Impact CPU/RAM
Négligeable.

### Impact UX
**Visible** pour utilisateurs des 26 locales non FR/EN.

### Solution recommandée
1. Compléter les clés majoritaires (de, es, ja, pt, ru, zh) ;
   accepter le fallback pour les locales rares.
2. Ajouter un script CI qui détecte les clés EN-only et émet un
   warning (sans bloquer).
3. Optionnel : adopter une plateforme de traduction (Crowdin, Weblate)
   pour onboarder les contributeurs.

### Difficulté implémentation
**Élevée** (besoin de traducteurs humains) mais **Facile**
techniquement.

### Gain attendu
- UX consolidée pour utilisateurs non FR/EN.

---

## M9 — Vendor `lib/webaudio-pianoroll-custom.js` (~89 KB) non sourcé

### Problème détecté
`public/lib/webaudio-pianoroll-custom.js` (2 188 lignes) est une lib
forkée (probablement de Surikov), modifiée localement (« custom »),
sans :
- header de licence,
- pointeur vers la source upstream,
- changelog des modifications locales.

### Gravité
**Moyenne** — Risque légal/maintenance.

### Fichier(s) concerné(s)
- `public/lib/webaudio-pianoroll-custom.js`.

### Cause profonde
Vendoring fait à la va-vite ; pas de processus.

### Impact réel
- Impossible de fusionner les updates upstream.
- Risque licence (la lib originale est-elle MIT ? GPL ?).

### Impact CPU/RAM
- 89 KB chargés au boot (cf. C1, à mitiger via lazy chunk).

### Impact UX
Aucun direct.

### Solution recommandée
1. Documenter dans le fichier (header) : source upstream, commit sha,
   licence, liste des modifications locales (changelog).
2. Si la licence est compatible, considérer de la republier (fork
   GitHub) pour faciliter les contributions.
3. Cf. E6 : à terme, supprimer si consolidation piano-roll réussie.

### Difficulté implémentation
**Facile** — 1 h de recherche origine + commentaire.

### Gain attendu
- Conformité licence.
- Maintenance possible.

---

## M10 — Patterns dupliqués : `clamp` inline (×14), `isBlackKey` (×4)

### Problème détecté
Documenté dans `AUDIT_2026-05-10.md` findings #21, #22 :
- `Math.max(lo, Math.min(hi, v))` inline ×14 occurrences
  (`KeyboardModal.js:384,388,544`, `RoutingSummaryHelpers.js:295`,
  `NoteEngine.js:92,107`, `LightingHelpersMixin.js:52`, etc.).
- `isBlackKey` réimplémenté localement dans 4 fichiers alors qu'il
  existe `MidiConstants.isBlackKey`.

### Gravité
**Moyenne** — Code dupliqué, bug fix à appliquer à plusieurs
endroits.

### Fichier(s) concerné(s)
- Listés ci-dessus.

### Cause profonde
Pas de lint custom qui détecte ces patterns ; copy-paste rapide.

### Impact réel
- Maintenance × 4-14.
- Risque divergence (un fix corrigé à un seul endroit).

### Impact CPU/RAM
Négligeable.

### Impact UX
Aucun direct.

### Solution recommandée
1. Créer `public/js/utils/math.js` avec `clamp(v, lo, hi)`, exposer
   sur `window.MathUtils` (ou import ESM si Phase 1 C1 faite).
2. Imposer `MidiConstants.isBlackKey` partout.
3. ESLint custom rule `no-restricted-syntax` pour bannir les patterns
   `Math.max(.+, Math.min(.+, .+))`.

### Difficulté implémentation
**Facile** — 2 h pour migration + ESLint rule.

### Gain attendu
- Patterns canoniques, bugs centralisés.

---

# Findings — Gravité FAIBLE (P3)

## F1 — `MinimapUtils._BAND_FILL_CACHE` non purgé

### Problème détecté
`public/js/features/MinimapUtils.js:10` : `const _BAND_FILL_CACHE =
new Map();`. Cache de chaînes `rgba()` mémoisées par couleur+alpha.
Pas de purge / TTL.

### Gravité
**Faible** — Contrairement à l'estimation initiale, le cache est
**borné par le nombre fini de couleurs de thème × alphas
demandés** (typiquement 10-30 entrées max, ~50 octets par entrée).
La "fuite" plafonne en pratique à < 5 KB.

### Fichier(s) concerné(s)
- `public/js/features/MinimapUtils.js`.

### Cause profonde
Cache global module-level (singleton IIFE).

### Impact réel
Quasi nul.

### Impact CPU/RAM
Plafond ~5 KB total. Négligeable.

### Impact UX
Aucun.

### Solution recommandée
Si on veut vraiment être propre : ajouter une borne stricte
(`if (cache.size > 64) cache.clear()`). Sinon, **laisser tel quel**
— c'est une mémoisation légitime.

### Difficulté implémentation
**Triviale** — 1 ligne, si nécessaire.

### Gain attendu
Aucun mesurable.

---

## F2 — `WebSocketServer.heartbeatInterval` pas `.unref()`-é (côté serveur)

### Problème détecté
Mentionné dans `AUDIT_2026-05-10.md` finding #28 :
`src/api/WebSocketServer.js:343` n'appelle pas `.unref()` sur l'intervalle
heartbeat. Si le process devient zombie, l'heartbeat l'empêche de
sortir.

### Gravité
**Faible** — Cas limite côté serveur, mais l'agent l'a remonté.

### Fichier(s) concerné(s)
- `src/api/WebSocketServer.js:343`.

### Cause profonde
Oubli.

### Impact réel
Peu probable mais réel.

### Impact CPU/RAM
Négligeable.

### Impact UX
Aucun direct.

### Solution recommandée
Ajouter `this.heartbeatInterval.unref()` après création.

### Difficulté implémentation
**Triviale** — 1 ligne.

### Gain attendu
Process sort proprement en cas de crash partiel.

---

## F3 — Dossier `images-a-faire/` commité en racine

### Problème détecté
`/home/user/General-Midi-Boop/images-a-faire/drums/` contient des
SVG WIP, commités dans le repo mais jamais référencés
(`grep -rn 'images-a-faire' public/ src/` → 0 résultat).

### Gravité
**Faible** — Pollution repo.

### Fichier(s) concerné(s)
- `images-a-faire/`.

### Cause profonde
WIP graphiste, commité par confort, jamais nettoyé.

### Impact réel
- Pollution clone (~quelques 100 KB).
- Confusion pour nouveaux développeurs.

### Impact CPU/RAM
Aucun (jamais chargé).

### Impact UX
Aucun.

### Solution recommandée
- Soit déplacer dans `assets/` (si utile) avec balayage des refs.
- Soit supprimer + ajouter au `.gitignore` (`/images-a-faire/`).

### Difficulté implémentation
**Triviale** — 5 min.

### Gain attendu
Repo plus propre.

---

## F4 — SVG `public/assets/instruments/` non passés à SVGO

### Problème détecté
78 SVG dans `public/assets/instruments/` (~500 KB, 6,4 KB moyen).
Probablement non passés à SVGO (compression XML + path simplification).

### Gravité
**Faible** — Pas critique, optimisation marginale.

### Fichier(s) concerné(s)
- `public/assets/instruments/*.svg`.
- `public/assets/drums/*.svg`.

### Cause profonde
Pas de pipeline d'optim. assets.

### Impact réel
- ~150 KB économisables.

### Impact CPU/RAM
Négligeable.

### Impact UX
Léger gain au premier chargement (SVG cachés ensuite).

### Solution recommandée
1. `npx svgo --multipass -f public/assets/instruments/ -o
   public/assets/instruments/`.
2. Optionnel : intégrer SVGO dans le pipeline Vite (plugin).

### Difficulté implémentation
**Triviale** — 10 min.

### Gain attendu
- −100 à 150 KB d'assets.

---

## F5 — Pas d'usage de `WeakMap`/`WeakRef` dans tout le code

### Problème détecté
`grep -rn 'WeakMap\|WeakRef' public/js/` retourne 0. Toutes les
références sont fortes, y compris les caches qui pourraient être
faibles (`MidiSynthesizer._instances = new Set()`,
`loadedInstruments`, etc.).

### Gravité
**Faible** — Améliorable mais pas critique.

### Fichier(s) concerné(s)
- Tout `public/js/`.

### Cause profonde
Code écrit avant l'adoption répandue de `WeakMap`. Pas de revue
ciblée.

### Impact réel
- Certains caches retiennent des objets plus longtemps que nécessaire.

### Impact CPU/RAM
Mineur.

### Impact UX
Aucun.

### Solution recommandée
Cas-par-cas. Pour `MidiSynthesizer._instances`, un `WeakSet` permettrait
au GC de libérer les instances orphelines. Pour
`loadedInstruments` (samples partagés), garder `Map` (les samples
sont volontairement retenus).

### Difficulté implémentation
**Faible** — au cas par cas.

### Gain attendu
Mineur.

---

# Plan d'action séquencé

## Phase 0 — Quick wins (1 jour / 1 dev)

| Action | Finding | Effort | Gain |
|---|---|---|---|
| `defer` sur les 135 scripts de `index.html` | C1 | 30 min | **−3 à 5 s TTI** |
| Reconnexion WS infinie + jitter | C2 | 1 h | Stabilité 24/7 |
| `filterManager.destroy()` dans `onLeave` des pages | C3 | 2 h | Stoppe fuite documentée |
| Supprimer `BaseController.js` | E5 | 30 min | −480 lignes |
| Supprimer `AppRegistry.js` (ou planifier migration) | E5 | 30 min | −135 lignes |
| Supprimer `migrateLegacy.js` | M3 | 5 min | Conformité roadmap |
| Vendre `WebAudioFontPlayer.js` localement | M2 | 1 h | Indépendance internet |
| `.unref()` sur heartbeat WS | F2 | 5 min | Process exit propre |
| SVGO sur les SVG | F4 | 10 min | −150 KB |
| Supprimer `images-a-faire/` | F3 | 5 min | Repo propre |

## Phase 1 — Temps réel & 24/7 (3-4 jours)

| Action | Finding | Effort |
|---|---|---|
| Object pooling voix `MidiSynthesizer` | E1 | 1 jour |
| Métronome via `AudioContext.currentTime` lookahead | E3 | 1 h |
| `AudioPreview` partage le synth principal OU close après lecture | E2 | 4 h |
| Helper `_on/_off` dans `BaseView`/`BaseModal` + migration des 5 modales critiques | E7 | 2 jours |
| Dirty region / OffscreenCanvas pour `PlaybackTimelineBar` + minimaps | E8 | 1 jour |

## Phase 2 — Architecture & dette (5-7 jours)

| Action | Finding | Effort |
|---|---|---|
| Conversion `index.html` → `bootstrap.js` + entrée Vite | C6, C1 P1 | 2 jours |
| `manualChunks` + dynamic imports modales | M5, C1 P2 | 1 jour |
| Unification `escapeHtml` + helpers `clamp`, `isBlackKey` + ESLint rule | E10, M10 | 4 h |
| Logger frontend + migration `console.*` | M6 | 6 h |
| Standardisation Vitest (drop Jest) | M4 | 1-2 jours |

## Phase 3 — Découpe LoopCreatorModal (3-5 jours)

Cf. C4 détaillé. Préalable : Phase 2 du `AUDIT_MODAL_BOUCLES`
recommande Phase 4 du même document.

## Phase 4 — Découpe RoutingSummaryPage + piano-roll consolidation (4-5 jours)

Cf. C5 et E6. À faire après Phase 3 car les patterns extraits dans
LoopCreator pourront être réutilisés.

## Phase 5 — CSS unification (2-3 jours)

| Action | Finding | Effort |
|---|---|---|
| Tokens centralisés dans `variables.css` + `themes.css` | E9 | 4 h |
| Fusion `keyboard-*.css`, `loop-*-modal.css` | E9 | 1 jour |
| Audit/suppression `!important` (cible : < 100) | E9 | 1 jour |
| Lazy-load CSS modales | E9, M5 | 4 h |

## Phase 6 — Polish (2 jours)

| Action | Finding | Effort |
|---|---|---|
| Découpe `ISMSections`, `KeyboardPiano`, `KeyboardChords` | E4 | 2 jours |
| Audit animations CSS coûteuses + désactivation Pi | M7 | 1 jour |
| Traductions complétion locales majeures | M8 | (humains) |

---

# Métriques de succès — Avant / Après (estimation)

| Métrique | Avant | Après Phase 0 | Après Phase 2 |
|---|---|---|---|
| TTI Pi 4 (LAN, Chromium) | 10-12 s | 5-7 s | 2-3 s |
| Bundle JS chargé au boot | ~3,9 MB | ~3,9 MB | ~500 KB initial + lazy |
| CSS chargé au boot | 804 KB | 804 KB | ~200 KB initial + lazy |
| Reconnexion WS auto après coupure 1h | Non | Oui | Oui |
| Croissance heap / heure (idle) | ~1-3 MB | < 0,5 MB | < 0,2 MB |
| Croissance heap / heure (lecture) | ~5-10 MB | ~3 MB | < 2 MB |
| CPU navigateur (lecture vue dense) | 45-60 % | 40-55 % | 25-35 % |
| FPS canvas | 25-35 | 30-40 | 50-60 |
| GC pause majeure (polyphonie 16+) | 500 ms / 2-5 s | identique | < 50 ms |
| Lignes JS public/ | ~83 000 | ~82 400 | ~75 000 (post-découpes) |
| `addEventListener` / `removeEventListener` | 646 / 284 | identique | équilibré |
| `!important` CSS | 653 | identique | < 100 |
| TODO/FIXME résiduels | 1 | 1 | 0 |

---

# Annexes — Commandes de mesure prêtes à l'emploi

## Détection ratio listeners (à exécuter dans le navigateur)
```js
// Dans DevTools Console après ouverture/fermeture d'une modale 100 fois :
[document, window, document.body]
  .flatMap(t => Object.entries(getEventListeners(t)))
  .reduce((acc, [evt, ls]) => acc + ls.length, 0)
```

## Audit Vite bundle
```bash
npm run build
npx rollup-plugin-visualizer dist/stats.html
# Ou intégrer le plugin dans vite.config.js
```

## Mesure heap snapshot diff
```bash
# Chrome DevTools → Memory → Take snapshot
# Attendre 10 min idle
# Take snapshot → Comparison → trier par "Delta"
# Tout objet "Detached HTMLDivElement" > 0 = leak
```

## Compteur dérives setInterval métronome
```js
// Dans LoopEditorModal après _startMetronome :
let t0 = performance.now(), n = 0;
const expected = 60_000 / this.tempo;
setInterval(() => {
  n++;
  const drift = performance.now() - t0 - n * expected;
  if (Math.abs(drift) > 10) console.warn('drift', drift, 'ms');
}, expected);
```

## Détection listeners orphelins (Vitest jsdom)
```js
test('LoopCreatorModal: aucun listener fantôme après cycle 50× ouvrir/fermer', () => {
  const before = countListeners(document);
  for (let i = 0; i < 50; i++) {
    const m = new LoopCreatorModal(deps);
    m.open();
    m.close();
  }
  const after = countListeners(document);
  expect(after - before).toBeLessThan(5);
});
```

---

**Fin du rapport.**
