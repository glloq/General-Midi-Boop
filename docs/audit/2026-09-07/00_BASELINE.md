# 00_BASELINE — base de mesure commune (lot L00)

**Date :** 2026-09-07 · **Commit :** `8dc170e` · **Version :** 0.8.1
**Environnement :** Linux x86_64, Node v22.22.2, pas de Pi, pas de matériel MIDI,
pas d'audio, pas de D-Bus/Bluetooth, pas de GPIO.
**Périmètre validé :** 1b (audit + correctifs sûrs) · 2a (outillage manquant
construit) · 3a (les 16 lots).

Ce document est la **base de mesure** contre laquelle les lots L01→L15 mesurent
leurs écarts. Tous les chiffres ci-dessous sont **reproduits**, pas estimés.

---

## 1. Préparation de l'environnement (faite une fois, pour tous les lots)

```bash
npm install --ignore-scripts          # 499 paquets
npm rebuild better-sqlite3 --build-from-source
```

| Élément | État | Conséquence pour les lots |
|---|---|---|
| `better-sqlite3` (recompilé) | ✅ **fonctionne** | Les **10 suites SQLite** ne sont plus skippées → L06, L07 peuvent travailler contre une vraie base |
| `midi` / `easymidi` | ❌ pas d'en-têtes ALSA (`libasound2-dev`) | Chemin USB réel indisponible → L04 se limite au JS pur, L15 reprend le reste |
| Chromium + Playwright (`/opt/pw-browsers`) | ✅ pré-installés | **L08 peut construire le harnais E2E** |
| Docker | ✅ disponible | L11 peut tenter le build de l'image (§B04, jamais fait) |
| `python3`, `make`, `g++` | ✅ | Compilation native possible |

> ⚠️ **Aucun lot ne relance `npm install` ni `npm rebuild`.** C'est fait.

---

## 2. Santé du code à HEAD

| Contrôle | Commande | Résultat |
|---|---|---|
| ESLint | `npm run lint` | ✅ **0 erreur**, 203 warnings (183 `no-console`, essentiellement dans `scripts/`) |
| Types | `npm run typecheck` | ✅ **clean** (`tsc --noEmit`, exit 0) |
| Format | `npm run format:check` | ❌ **13 fichiers non formatés** → le job `lint` de la CI est **rouge sur `main`** (F-17) |
| Tests backend | `jest` | ✅ **150 suites / 1875 tests**, 17,5 s |
| Tests frontend | `vitest run` | ✅ **81 fichiers / 1488 tests**, 29,1 s |
| Advisories | `npm audit --omit=dev` | ❌ **8 vulnérabilités** (1 low, 4 moderate, **3 high**) |

### Couverture backend **vraie**

Mesurée avec `--collectCoverageFrom='src/**/*.js'` — le rapporteur par défaut
lit ~7 points trop haut parce que l'option n'est pas configurée dans
`jest.config.cjs`.

```
44.68 % stmt · 44.18 % branch · 38.85 % func
Fichiers à couverture nulle : 34 / 176
```

**Écart vs 2026-08-22** (44,57 / 44,11 / 38,82 · 34 fichiers) : **nul**. Le code
n'a pas bougé (un seul commit depuis, l'audit lui-même).

### Inventaire des commandes

```
Registered commands       : 270
  with payload schema     : 86 (31.9%)
  schema wired to validator: 86 (31.9%)
  called by frontend      : 147 (54.4%)
  mentioned in tests      : 63 (23.3%)
  documented in API.md    : 187 (69.3%)
Orphan schemas            : 0
Phantom frontend calls    : 0
```

### Modules morts

```
Unreferenced modules: 1 (468 lines)
    src/midi/messages/MidiMessage.js
```

---

## 3. Re-statut des 17 findings du 2026-08-22

**Méthode.** Chaque finding est ré-instruit à HEAD. `CONFIRMÉ OUVERT` = reproduit
aujourd'hui avec la preuve citée. `À INSTRUIRE` = non re-vérifiable sans serveur
vivant ou sans le travail du lot — délégué au lot nommé, qui doit conclure.

| # | Sev | Statut à HEAD | Preuve / délégation | Lot |
|---|---|---|---|---|
| F-01 | P2 | À INSTRUIRE | `/api/health` `usb: ready` sans lib MIDI — exige un serveur vivant | **L12** |
| F-02 | P2 | À INSTRUIRE | `/api/health` `ble: ready` après échec d'init — idem | **L12** |
| F-03 | **P1** | **CONFIRMÉ OUVERT** | `command-inventory.mjs` : **86/270 (31,9 %)** — chiffre identique au 2026-08-22 | **L01** |
| F-04 | P3 | **CONFIRMÉ OUVERT** | 10 suites portent le marqueur `NEEDS_SQLITE` et sont retirées du run sans binding, pendant que Jest affiche « Ran all test suites ». Le mécanisme de skip silencieux est intact — seul l'environnement a changé. | **L07** |
| F-05 | P3 | À INSTRUIRE | `showConfirmModal` vit dans `MidiEditorDialogs.js:31` (pas dans `core/`) — traitement du `message` à ré-instruire | **L10** |
| F-06 | P2 | À INSTRUIRE | Trame d'erreur rate-limit sans `id` — exige un serveur vivant | **L01** |
| F-07 | P2 | À INSTRUIRE | Pas d'exemption panic au niveau WS — exige un serveur vivant | **L01** |
| F-08 | P2 | ✅ **CORRIGÉ** | `tests/audit/midi-core-conformance.test.js` vert. **L03 doit balayer la classe**, pas le cas. | L03 |
| F-09 | P3 | **CONFIRMÉ OUVERT** | `dead-modules.mjs` : `src/midi/messages/MidiMessage.js`, 468 lignes, 0 importeur | **L14** |
| F-10 | P3 | À INSTRUIRE | `/api/*` inconnu → 200 + HTML de la SPA — exige un serveur vivant | **L01** |
| F-11 | P2* | **CONFIRMÉ OUVERT** | `src/api/HttpServer.js:140` → `contentSecurityPolicy: false`. *Risque accepté en 2026-08 — à ré-instruire maintenant que `tHtml()` existe.* | **L10** |
| F-12 | P2 | À INSTRUIRE | 2 737 clés × 28 locales, 70–89 % réellement traduites — mesure par locale à refaire | **L09** |
| F-13 | **P1** | **CONFIRMÉ OUVERT** | **1 785 statements lighting, 42 couverts = 2,35 %**. `LightingManager` 519 stmts à **0 %**, `LightingCommands` 313 à **0 %**, et **les 8 drivers à 0 %** (sACN 123, ArtNet 98, HTTP 98, MQTT 93, GpioStrip 83, OSC 69, GpioLed 39, SerialLed 38) | **L02** |
| F-14 | P2 | **CONFIRMÉ OUVERT** | `public/index.html:6011` → `document.write('<scr'+'ipt src="https://surikov.github.io/webaudiofont/npm/dist/WebAudioFontPlayer.js">…')` — **rendu bloquant vers un CDN qu'un Pi hors-ligne ne peut pas joindre** | **L11** |
| F-15 | P2 | **CONFIRMÉ OUVERT** | `scripts/install-default-sf2.js` : **aucun `sha256` / `checksum` / `createHash`** — assets d'exécution téléchargés sans vérification d'intégrité | **L10** |
| F-16 | P2 | **CONFIRMÉ OUVERT** | `npm audit --omit=dev` : 8 vulnérabilités dont **3 high** (chaîne `xml2js` → `dbus-next` → `node-ble`). **La porte CI `--audit-level=critical` passe quand même** — vérifié. | **L10** |
| F-17 | P3 | ✅ **CORRIGÉ dans L00** | 13 fichiers non formatés → `prettier --write`. La CI `lint` redevient verte. Voir §4. |  |

**Bilan : 8 findings confirmés ouverts par la preuve, 8 délégués aux lots qui
ont les moyens de conclure, 2 corrigés (F-08 en août, F-17 ici).**

---

## 4. Correctif appliqué dans ce lot

**F-17 — `npm run format:check` échouait sur 13 fichiers non touchés**, ce qui
laissait le job `lint` de la CI **rouge sur `main`**. Corrigé par
`prettier --write` sur exactement ces 13 fichiers :

```
src/api/commands/FileCommands.js
src/midi/adaptation/NoteEnforcement.js
src/midi/adaptation/VoiceSelector.js
src/midi/instrument/CapabilityResolver.js
src/midi/playback/PlaybackScheduler.js
src/midi/routing/MidiRouter.js
public/js/features/auto-assign/HandPositionFeasibility.js
public/js/features/SystemAdminModal.js
tests/ble-midi-decode.test.js
tests/capability-resolver.test.js
tests/playback-schemas-t5-4.test.js
tests/scoring-edge-cases-t6.test.js
tests/voice-selector.test.js
```

Correctif **cosmétique uniquement** (aucun changement de comportement) ; appliqué
**avant** le lancement des lots parallèles pour qu'ils partent tous d'un arbre
propre. Vérifié après coup : lint 0 erreur, `tsc` clean, 1875 + 1488 tests verts.

---

## 5. Ce que les lots doivent tenir pour acquis

1. Les dépendances sont installées, `better-sqlite3` fonctionne. **Ne pas
   réinstaller.**
2. La base de comparaison est : **150/1875 backend · 81/1488 frontend ·
   44,68 % stmt · 0 erreur lint · tsc clean · format clean**. Toute régression
   sur ces chiffres est imputable au lot qui l'introduit.
3. Les findings `À INSTRUIRE` sont **une obligation de conclure**, pas une
   suggestion : le lot nommé doit rendre un état final (`CONFIRMÉ` / `INFIRMÉ` /
   `CORRIGÉ`) avec sa preuve.
4. Numérotation des nouveaux findings : **F-18 et au-delà**, par plages réservées
   (voir `PLAN_AUDITS.md` §3).
