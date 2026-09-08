# Vague 3 — R12 · compte rendu

**Finding visé :** **F-138 (P1)** — « le routage MIDI live est entièrement
inatteignable depuis l'UI » (`13_FEATURE_COMPLETENESS.md` §5, matrice
`01_API_CONTRACT.md` §8 classe B).
**Portée réelle :** `public/js/features/routing/**` (nouveau),
`public/index.html` (2 balises `<script>`), `public/styles/components.css`,
`public/locales/*.json` (28 fichiers, ajout de clés uniquement),
`tests/frontend/r12-live-routing-modal.test.js` (nouveau),
`tests/e2e/specs/05-live-routing.spec.mjs` (nouveau),
`tests/e2e/lib/app.mjs` (page object, additif).
**Aucune ligne de backend n'a été touchée.** Les 15 commandes existaient, étaient
validées, testées et documentées ; le travail consistait à les rendre
*atteignables*, pas à les réécrire.

---

## 1. Ce que F-138 disait exactement, et ce qui était vrai

> 15 commandes […] sont enregistrées, 8 ont un schéma, 6 sont testées, 14 sont
> documentées dans `docs/API.md` — et **aucune n'est appelée par le frontend**.

Vérifié avant de coder, sur l'arbre :

```
$ grep -rn "route_create\|route_list\|validate_routing_feasibility" public/
(aucun résultat)
```

`MidiRouter.addRoute()` (`src/midi/routing/MidiRouter.js:168`) n'était donc
atteint que par `session_load` — qui ne peut restituer que des routes déjà
créées — et par `loadRoutesFromDB()` au démarrage. **Aucun chemin ne permettait
de créer la première route.** La promesse du README (« *inbound BLE notes are
routed like any other input* ») était structurellement intenable : sans route,
`MidiRouter.routeMessage` (`:333-378`) ne fait qu'alimenter le moniteur.

C'était un manque d'**affordance**, pas de code. Le correctif ne devait donc
rien inventer côté serveur — et n'a rien inventé : un test vérifie que toute
commande envoyée par la nouvelle surface existe bien dans
`RoutingCommands.js` (§4.1, dernier cas).

---

## 2. Ce qui est câblé

### 2.1 Le point d'entrée

`public/js/features/routing/LiveRoutingLauncher.js` injecte un bouton
`#liveRoutingBtn` (🔀) dans `.header-tools-right`, à côté de ⚙️ et 🛠️, et ouvre
la modale au clic. Il est **idempotent**, il porte un `aria-label` et un
`title` liés à `liveRouting.title`, et il resynchronise son nom accessible sur
un changement de langue (`i18n.updatePageTranslations()` gère `data-i18n-title`
mais pas `aria-label`).

Le bouton est créé en JS et non dans `index.html` **délibérément** : la
consigne de lot imposait un diff minimal sur `index.html`, et le résultat est
que le bouton, son libellé, sa liaison i18n et son handler vivent dans le même
fichier que la fonctionnalité qu'ils ouvrent. Le diff sur `index.html` se
réduit à deux `<script>` :

```diff
+    <!-- Live MIDI routing (R12 / F-138): UI for the route_*/filter_*/channel_map commands -->
+    <script src="js/features/routing/LiveRoutingModal.js"></script>
+    <script src="js/features/routing/LiveRoutingLauncher.js"></script>
```

Les styles sont ajoutés à `public/styles/components.css`, déjà lié — aucune
balise `<link>` supplémentaire.

### 2.2 La surface

`public/js/features/routing/LiveRoutingModal.js` étend `BaseModal`
(`public/js/core/`) et parle au backend par `window.api` (`BackendAPIClient`).
Elle couvre le cycle de vie complet d'une route live :

| Geste dans l'UI | Commande |
|---|---|
| ouvrir la modale | `device_list`, **`route_list`** |
| « Créer la route » (2 sélecteurs) | **`route_create`** |
| case « Activée » d'une ligne | **`route_enable`** |
| bouton « Supprimer » (derrière `confirm`) | **`route_delete`** |
| bouton « Dupliquer » | **`route_duplicate`** |
| bouton « Note de test » | **`route_test`** |
| bouton « Détails » | **`route_info`** |
| bouton « Exporter » (remplit le champ JSON) | **`route_export`** |
| bouton « Importer la route » | **`route_import`** |
| « Supprimer toutes les routes » (derrière `confirm`) | **`route_clear_all`** |
| grille des 16 canaux → « Appliquer la correspondance » | **`channel_map`** |
| types de message + plages note/vélocité → « Appliquer le filtre » | **`filter_set`** |
| « Effacer le filtre » | **`filter_clear`** |

**13 des 15 commandes de F-138 ont désormais un appelant.** Les deux restantes
sont traitées en §5 — elles ne relèvent pas du routage live.

### 2.3 Deux décisions de conception, et pourquoi

**(a) Les deux sélecteurs listent *tous* les appareils, pas seulement ceux de la
bonne direction.** Un premier jet filtrait la source sur `input !== false`.
C'était faux en pratique : un instrument virtuel logiciel est déclaré
`input:false, output:true` (`DeviceManager.js:281-282, 791-792, 1916-1917`), un
appareil BLE annonce les deux, un port USB dépend des ports ALSA réellement
présents — et `route_create` accepte n'importe quelle paire. Le filtre strict
rendait la fonctionnalité **inutilisable sur une machine sans clavier physique**,
c'est-à-dire exactement le banc E2E, et aurait masqué des appareils dont le
drapeau est peu fiable. La modale groupe donc les appareils de la bonne
direction en premier (`<optgroup>` « Entrées MIDI » / « Sorties MIDI »), les
autres ensuite (« Autres appareils »), et n'introduit les groupes que lorsqu'il
y a réellement deux catégories à séparer. L'opérateur est **guidé, jamais
bloqué**.

**(b) `route_import` retire l'`id` du JSON collé.** `MidiRouter.addRoute()`
réutilise `route.id` quand il est présent *et saute alors l'insertion en base*
(`:189`). Importer tel quel un JSON produit par `route_export` créerait donc une
route en mémoire seulement, qui disparaîtrait au redémarrage — un bug de
persistance silencieux. La modale supprime l'`id` pour que le backend en
attribue un neuf ; c'est pinné par un test.

### 2.4 Accessibilité (L09 — F-103, F-104)

La consigne était explicite : **ne pas grossir le compteur des 13 modales
inutilisables au clavier ni celui des 202 champs sans nom accessible.**

- `role="dialog"`, `aria-modal="true"`, `aria-labelledby` : fournis par
  `BaseModal` et vérifiés dans le navigateur (étape 5 du scénario E2E).
- **Échap** ferme la modale sans laisser d'overlay (étape 8 du scénario E2E,
  assertion `count() === 0` — c'est précisément le piège décrit dans
  `app.mjs:127-135` pour la page instruments).
- **Piège de focus** : hérité de `BaseModal` (corrigé en L09/F-100), re-testé ici.
- **Nom accessible** : les 30 contrôles de formulaire de la modale
  (2 sélecteurs d'appareil, 16 sélecteurs de canal, 7 cases de type de message,
  4 champs numériques, 1 zone de texte) plus la case « Activée » de chaque route
  portent tous un `<label for>`. Un test parcourt le DOM ouvert, panneau de
  réglages déplié compris, et échoue en nommant le contrôle fautif.
- **Aucun bouton icône seule** : tous les boutons portent du texte traduit, donc
  rien n'est ajouté au cliquet `≤ 33` de `l09-a11y-modals.test.js` — qui reste
  vert (vérifié, cf. §6).
- La zone de résultat est un `role="status" aria-live="polite"`.

### 2.5 i18n

Namespace `liveRouting` : **70 clés** (`title`, `intro`, les libellés, les 7
types de message, les 3 libellés d'`optgroup`, les messages de statut),
ajoutées **dans les 28 locales**, réellement traduites, aucune chaîne vide.
`tests/audit-i18n.test.js` (dérive structurelle, 0 clé manquante exigée) est
vert : **138 tests**.

La règle stricte de `CLAUDE.md` est respectée et **testée** :

- `tHtml()` pour tout ce qui part dans `innerHTML` — notamment
  `liveRouting.routePath` (`{source} → {destination}`), qui interpole des **noms
  d'appareils non fiables** (un nom BLE est choisi par l'attaquant à portée
  radio : c'est F-110) ;
- `t()` pour `textContent`, `.value`, `.label` d'`optgroup`, `.title`,
  `setAttribute` — jamais `tHtml`, qui double-échapperait ;
- `escape()` pour l'`id` de route réinjecté en attribut `data-lrt-id`.

Deux tests le vérifient : un nom d'appareil `Piano <script>` ressort en texte et
non en balise, et un `id` de route hostile `x" onclick="alert(1)` ne produit
aucun attribut `onclick`.

---

## 3. La preuve que F-138 est fermé

> « Prouve que c'est atteignable, pas seulement que le code existe. »

Un test unitaire ne prouverait que l'existence d'un composant. Le scénario
`tests/e2e/specs/05-live-routing.spec.mjs` pilote **un vrai Chromium** contre un
**vrai serveur** avec une **base neuve**, et **clique** (jamais
`element.click()` depuis `evaluate` — règle du harnais) :

```
▶ 05 · live MIDI routing (F-138)
  ✔ PASS  a route created from the UI reaches the router and survives a reload
      · 1 · boot the SPA
      · 2 · create two virtual instruments through the UI
      · 3 · the router starts with no route at all
      · 4 · the header carries a live-routing button
      · 5 · a real click opens the routing modal
      · 6 · create a route from the two selects
      · 7 · the backend router really holds it
      · 8 · Escape closes the modal without leaving an overlay
      · 9 · after a full reload the route is still there
      · 10 · disabling it from the UI reaches route_enable
      · 11 · the settings panel edits the channel map
      · 12 · deleting it from the UI empties the router
      · 13 · no uncaught page error during the journey
```

Extraits du `report.json` produit par le run (preuves, pas affirmations) :

| Étape | Preuve enregistrée |
|---|---|
| 3 · état initial | `route_list before: []` |
| 4 · affordance | `button accessible name: "Live MIDI routing"` |
| 6 · création | `Virtual Piano → Virtual Organ`, `enabled: true` |
| 7 · côté serveur | `{id: route_1788…, source: virtual_1788…caoisc, destination: virtual_1788…oro45q, enabled: true}` |
| **9 · après rechargement complet** | **la même route, même `id`, relue par `loadRoutesFromDB()`** |
| 10 · désactivation | `enabled: false` côté serveur |
| 11 · correspondance | `channelMap: {"0": 9}` côté serveur |
| 12 · suppression | `route_list after delete: []` |
| 13 · propreté | `page errors: []` |

L'étape 9 est celle qui compte : elle exerce le **même aller-retour que le
démarrage réel** — DB → `MidiRouter.loadRoutesFromDB()` → `route_list` → DOM.

Trois captures d'écran sont écrites dans `tests/e2e/artifacts/`
(`05-01-modal.png`, `05-02-created.png`, `05-03-after-reload.png`).

Lancement :

```bash
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tests/e2e/run.mjs 05
```

---

## 4. Tests unitaires

`tests/frontend/r12-live-routing-modal.test.js` — **30 tests, Vitest/jsdom**
(jsdom ne tourne pas sous Jest ici) :

### 4.1 Le contrat de commandes (14 tests)

Chargement à l'ouverture, création, refus quand un sélecteur est vide,
désactivation du bouton quand aucun appareil n'existe, groupement des
`<optgroup>`, `route_enable`, `route_delete` **des deux côtés du `confirm`**,
duplication / détails / export / test, import avec retrait de l'`id`, rejet
d'un JSON invalide **avant** l'aller-retour réseau, `route_clear_all`,
`channel_map` (lecture de la carte existante `{0:3}` **et** ajout de `{5:9}`),
`filter_set` (types + `noteRange` + `velocityRange` avec bornes par défaut),
`filter_clear`, et remontée d'une erreur backend dans la zone de statut au lieu
d'une exception dans le handler de clic.

Un test lit `src/api/commands/RoutingCommands.js` et vérifie que **toute**
commande envoyée par la modale y est enregistrée : la surface ne peut pas
diverger du backend sans devenir rouge.

### 4.2 Échappement (2 tests) · Accessibilité (5 tests) · i18n (2 tests)

Voir §2.4 et §2.5. Le test i18n vérifie aussi les 28 fichiers de locale un par
un (mêmes clés, aucune vide).

### 4.3 Mémoire (1 test)

50 cycles ouverture/fermeture : **delta nul** sur chaque type d'écouteur
`document`/`window`, `document.body` vide, `overflow` restauré — même protocole
que `l09-a11y-modals.test.js` §AU/§AV.

### 4.4 Le point d'entrée (4 tests)

Le bouton est injecté, nommé, idempotent, placé après `#systemAdminBtn`, et son
clic ouvre bien une modale `role="dialog"` qui parle au backend.

---

## 5. Les commandes restées sans surface — et pourquoi

Deux des quinze n'ont **délibérément** pas reçu de surface ici. Ce ne sont pas
des oublis, et aucune des deux ne concerne le routage live.

### `file_routing_bulk_sync`

Elle **avait** un appelant, et il a été **retiré volontairement**. Le
commentaire est encore dans `public/index.html` (~ligne 7549) :

> « `file_routing_bulk_sync` removed — it caused a cycle where localStorage
> stale data was re-inserted into DB on every page load. The DB is now the
> single source of truth for routing status. »

Lui recâbler un appelant depuis la SPA **réintroduirait la boucle décrite**.
Elle reste utile en API d'intégration (import massif headless). La décision
honnête n'est pas « ajouter un bouton », c'est **documenter cette commande comme
API externe** — c'est un item de L01/L14 (statut des commandes), pas de R12.

### `validate_routing_feasibility`

Elle ne concerne pas le routage live : c'est le **pré-vol de faisabilité d'une
main** avant de router un canal *de fichier* vers un instrument, et elle renvoie
la même forme `{level, summary, message}` que `handPositionWarnings`. Son
appelant naturel est `public/js/features/auto-assign/RoutingSummaryApi.js`, dans
le répertoire tenu par un autre agent de cette vague (R13/F-139). L'y câbler
depuis la modale de routage live aurait été un contresens fonctionnel : elle n'a
ni `fileId`, ni canal de fichier, ni analyse à lui fournir.

### Pour mémoire — hors périmètre F-138

`monitor_start` / `monitor_stop` (`LoopEditorModal.js:1414,1418`),
`monitor_start_all` / `monitor_stop_all` (console de debug,
`index.html:7491,7499`), `file_routing_sync`
(`MidiEditorTablature.js:200`) et `routing_save_hand_overrides`
(3 éditeurs de main) avaient déjà des appelants : F-138 ne les comptait pas.

---

## 6. État à l'issue

| Vérification | Référence de début de lot | Mesure finale |
|---|---|---|
| `npm test` (Jest) | 207 suites · 2 821 tests, verts | **210 · 2 904, tous verts** |
| `npx vitest run` | 86 fichiers · 1 560 tests, verts | **88 · 1 604, tous verts** |
| `npx eslint src/ public/js/ tests/` | 0 erreur · 203 warnings | **0 erreur**, 0 warning ajouté |
| `npx tsc --noEmit` | clean | **clean** |
| `prettier --check` sur les fichiers du lot | — | **vert** |
| `tests/audit-i18n.test.js` | 138 tests | **138**, verts |
| `l09-a11y-modals.test.js` (cliquet ≤ 33 boutons anonymes) | vert | **vert** |
| E2E `node tests/e2e/run.mjs` (`E2E_MODAL_CYCLES=20`) | 5 PASS · 8 FAIL / 13 | **6 PASS · 8 FAIL / 14** |
| `git diff config.json` | vide | **vide** |

> Les totaux Jest/Vitest dépassent l'apport de ce lot (+1 fichier · +30 tests en
> Vitest) parce que deux autres lots de la vague 3 travaillent dans le même
> arbre. Ce qui est vérifié ici, c'est qu'**il ne reste aucun rouge**.
>
> La référence E2E de `08_E2E.md` était *3 PASS · 10 FAIL / 13* ; les deux rouges
> de la suite 01 (F-87, F-88) ont été fermés par R6 en vague 2, d'où *5 PASS ·
> 8 FAIL* avant ce lot. Les 8 rouges restants sont exactement ceux que
> `08_E2E.md` §« Known-failing tests » documente — F-86 (×2), F-90, F-95 (×4),
> F-94 — **aucun n'est nouveau**, et le scénario 05 est vert du premier au
> dernier pas.

### Deux cliquets mis à jour, et pourquoi

`tests/audit/r6-offline-first.test.js` et `tests/audit/l11-offline-first.test.js`
fixaient **exactement** le nombre de balises `<script src>` de `index.html`
(191). Les deux balises ajoutées par ce lot les faisaient passer au rouge. Le
compte a été porté à **193**, avec un commentaire nommant R12 : la propriété que
ces tests protègent est « aucune balise ne vise une origine distante » — la
boucle qui la vérifie est **inchangée**, et le compte reste exact pour qu'ajouter
un script demeure une modification consciente.

---

## 7. Ce que ce lot ne prétend pas avoir fait

- **Il ne rend pas les routes utiles à lui seul sur un banc sans matériel.** Une
  route dont la source est un instrument virtuel logiciel n'émettra jamais rien,
  puisque ces appareils sont des sorties. Le scénario E2E prouve la *chaîne de
  bout en bout* (UI → commande → routeur → base → rechargement), pas le passage
  de notes réelles : cela demande un clavier physique et relève de la QA
  matérielle (`15_HARDWARE_QA_CHECKLIST.md`).
- **Il ne touche pas au routage de fichiers** (`playback_*`, `file_routing_*`,
  page de résumé de routage). Ce sont deux systèmes distincts ; F-138 ne visait
  que le live.
- **Il ne tranche pas** le statut des 15 commandes vis-à-vis de `docs/API.md` ni
  d'ADR-003 : 13 sont maintenant de l'API *interne appelée par la SPA*, 2
  restent de l'API *externe*. Écrire cette distinction dans `docs/API.md` est un
  item L01/L14.
