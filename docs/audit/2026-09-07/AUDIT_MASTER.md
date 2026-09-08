# AUDIT_MASTER — Général Midi Boop

**Date :** 2026-09-07 · **Base :** commit `8dc170e` · **Version :** 0.8.1
**Environnement :** Linux x86_64, Node v22.22.2 — pas de Raspberry Pi, pas de matériel
MIDI, pas d'audio, pas de radio BLE, pas de GPIO. Chromium et Playwright disponibles.

Ce document est **l'autorité** de l'audit du 2026-09-07. Les 15 rapports spécialisés
(`00_*` … `15_*`) l'alimentent ; en cas de divergence, c'est le rapport spécialisé qui
porte la preuve et fait foi sur le détail.

---

## 0. Comment lire ce rapport

| État | Signification |
|---|---|
| **PASS** | Vérifié, preuve reproductible enregistrée. |
| **PARTIAL** | Fonctionne, mais couverture incomplète ou réserve explicite. |
| **FAIL** | Défaut reproductible. |
| **NOT TESTED** | Non exercé. |
| **HW REQUIRED** | Non validable sans matériel physique. |

Niveaux de validation : **0** lu · **1** unitaire · **2** intégration · **3** E2E
application · **4** matériel en boucle · **5** orchestre réel, durée prolongée.

> **Honnêteté de périmètre.** Cet audit atteint le **niveau 3**, et pour la première
> fois **avec un vrai navigateur** (§BI, harnais livré) et **une vraie base SQLite**
> (§X/§Y/§Z, binding recompilé). Tout ce qui touche le matériel réel reste
> `HW REQUIRED` — et dispose désormais d'une procédure exécutable (`15_HARDWARE_QA_CHECKLIST.md`).

---

## 1. Résumé exécutif

L'audit du 2026-08-22 concluait que le moteur était « en bien meilleure forme qu'un
projet de cette taille ne l'est d'habitude », sans aucun P0. **Cette conclusion était
juste sur la structure et fausse sur le fond** : elle reposait sur un audit resté au
niveau 3 théorique, avec ~30 sections jamais exercées. Dès qu'on exécute — un vrai
navigateur, une vraie base, de vrais octets sur le fil — le tableau change.

**Ce que l'exécution a révélé, et que la lecture ne pouvait pas voir :**

1. **Un P0.** Une seule trame WebSocket (`lighting_midi_learn`) **tuait le processus** :
   `eventBus.removeListener` n'existe pas, le `TypeError` remontait d'un `setTimeout`
   en `uncaughtException`. Dix secondes, serveur mort. *(F-18, corrigé)*
2. **Le transport principal perdait des messages.** L'**USB** ignorait les **dix**
   System Real-Time et System Common : `addInput()` n'abonnait que huit événements
   easymidi. Le même appareil en DIN, BLE ou RTP fonctionnait. *(F-38, corrigé)*
3. **Le décodeur BLE corrompait ~6,25 % des paquets** — un octet d'horodatage dont les
   7 bits bas tombent dans `0x78–0x7F` était lu comme du System Real-Time : faux
   message injecté, message suivant perdu. Invisible des tests existants, qui
   n'utilisaient qu'un horodatage nul. *(F-48, corrigé)*
4. **L'offline-first ne tient pas** — et ce n'est pas un cas dégradé rare, c'est le
   **chemin nominal de production**. *(F-14, aggravé en P1)*
5. **L'authentification WebSocket est contournable**, et `GMBOOP_SECURITY_MODE=secure`
   **ne s'applique pas au WS** : la parade documentée est fausse. *(F-108)*
6. **Une XSS DOM réelle**, exploitable à portée radio, sans aucun accès réseau. *(F-110)*
7. **La v0.9 « 100 % fonctionnelle » n'est pas tenue**, avec 12 capacités mortes,
   72 surfaces backend orphelines et 7 promesses non tenues. *(§L13)*

**Le fil conducteur de l'audit** n'est pas la faute de codage isolée, c'est **l'écart
entre ce qui est déclaré et ce qui s'exécute** : des capacités persistées jamais lues,
des commandes testées et inatteignables, un mode de sécurité qui ne couvre pas la moitié
de la surface, une image Docker qui n'a jamais démarré, un `test.failing` qui passe, et
un parseur MIDI mort qui a masqué deux fois le même bug de transport.

---

## 2. Chiffres — avant / après

| Métrique | 2026-08-22 | Base 2026-09-07 | **Après audit** |
|---|---|---|---|
| Suites backend | 150 | 150 | **192** |
| Tests backend | 1 875 | 1 875 | **2 534** |
| Fichiers frontend | 81 | 81 | **85** |
| Tests frontend | 1 488 | 1 488 | **1 552** |
| Couverture backend (stmt) | 44,57 % | 44,68 % | **60,13 %** |
| Couverture (branch / func) | 44,11 / 38,82 | 44,18 / 38,85 | **54,80 / 55,41** |
| Fichiers à couverture nulle | 34 / 176 | 34 / 176 | **20 / 176** |
| ESLint | 0 erreur | 0 erreur | **0 erreur** |
| `tsc --noEmit` | clean | clean | **clean** |
| `format:check` | **rouge** (13 fichiers) | corrigé en L00 | **vert** |
| Commandes WS avec schéma | 86 / 270 | 86 / 270 | 86 / 270 *(inchangé)* |
| Commandes atteignables depuis l'UI | « 147 » | « 147 » | **198 / 270** *(mesure corrigée)* |

**Progrès de couverture les plus nets :** lighting **2,35 % → 83,82 %** ·
`MidiClockGenerator` **0,5 % → 90,4 %** · `SerialMidiManager` 17,3 → **82,7 %** ·
`NetworkManager` 0,25 → **65,8 %** · `PlaybackScheduler` 61,7 → **83,1 %**.

**Trois chiffres de la base 2026-08-22 étaient faux** et sont corrigés ici :
- les « 123 commandes orphelines » → **72** (`command-inventory.mjs` ne scannait pas les
  ~8 100 lignes de JS inline de `public/index.html`) — établi indépendamment par L13 et L01 ;
- les 3 advisories `high` **ne sont pas** la chaîne `xml2js` (celle-ci est `moderate`) :
  c'est `ws` 8.20.0, atteignable, plus deux paquets inatteignables sous `node-gyp` ;
- la CSP était réputée bloquée par « 193 scripts inline » : **2 blocs et 107 `onclick`**,
  et zéro violation imputable à la SPA — mesuré en Chromium.

---

## 3. Findings

**152 nouveaux findings** (F-18 → F-169), plus le re-statut des 17 de 2026-08-22.

### 3.1 P0 — corrigé

| # | Section | Finding | État |
|---|---|---|---|
| **F-18** | U, AH | `lighting_midi_learn` tuait le processus (`eventBus.removeListener` inexistant, `TypeError` asynchrone → `uncaughtException`) | **CORRIGÉ** |

### 3.2 P1 — corrigés pendant l'audit

| # | Finding | Lot |
|---|---|---|
| **F-38** | L'USB ignorait les 10 System Real-Time / System Common | L03 |
| **F-48** | Décodeur BLE : ~6,25 % des paquets corrompus (horodatage `0x78–0x7F`) | L04 |
| **F-30 / F-129** | Les lumières restaient allumées après **chaque** arrêt — 3 causes distinctes | L02, L12 |
| **F-01 / F-02 / F-128** | `/api/health` annonçait `ready` pour `usb`, `ble` et `serial` non fonctionnels | L12 |

### 3.3 P1 — ouverts

| # | Finding | Lot |
|---|---|---|
| **F-14** | Offline-first cassé : `dist/` sans `lib/`, `/lib/*` répond 200 + shell SPA, la garde est **toujours vraie** → 174 des 191 `<script>` bloqués derrière un CDN | L11, L08 |
| **F-19** | Validation *fail-open* : 1 169 trames hostiles → **49,5 % acceptées**, la dernière défense est SQLite | L01 |
| **F-28** | Un driver lighting **synchrone** lent bloque le dispatch MIDI (+120 ms, × nombre de règles) | L02 |
| **F-31** | Règle `trigger:'noteon'` par défaut de l'UI → LED allumée pour toujours | L02 |
| **F-76** | Deux `apply_assignments` concurrents **cumulent** leurs transformations ; les deux clients reçoivent `success` | L07 |
| **F-130 / F-78** | Base verrouillée ⇒ **gel de la boucle d'événements 5 à 10 s** (donc de l'ordonnanceur MIDI) ; `busy_timeout` jamais configuré | L12, L07 |
| **F-86** | Le contrôle de tempo de l'éditeur MIDI est mort (`TypeError`, délégué oublié) | L08 |
| **F-87** | `document.write` CDN : blocage du parsing **1:1 avec le délai réseau** (3 000→3 424 ms, 8 000→8 421 ms) | L08 |
| **F-94** | Rechargement en pleine lecture : l'orchestre continue, l'UI perd tout contrôle | L08 |
| **F-108** | WS : client sans token accepté avec `Origin`/`Host` forgés ; **`GMBOOP_SECURITY_MODE` n'est pas lu côté WS** | L10 |
| **F-109** | `/api/waf/:filename` rejoue du JS tiers **au runtime, en same-origin** → immunisé à toute CSP `script-src 'self'` | L10 |
| **F-110** | **XSS DOM confirmée** : nom d'appareil BLE brut injecté (`BluetoothScanModal.js:297`), `onerror` exécuté en Chromium réel | L10 |
| **F-118** | Docker : `npm ci --ignore-scripts` prive l'image du binding `better-sqlite3` — conteneur mort | L11 |
| **F-120** | `update.sh` : **aucun rollback** ; l'auto-stash mange `config.json` | L11 |
| **F-138** | Le **routage MIDI live est entièrement inatteignable** depuis l'UI (15 commandes testées et documentées) | L13 |
| **F-139** | `hand_anchors` / `disabled_notes` : épinglés, persistés, dessinés — **jamais lus par le moteur** | L13 |
| **F-140** | `ISMSave.js:267` **remet `is_fretless` et `capo_fret` à 0** à chaque enregistrement | L13 |
| **F-156** | Le driver MQTT est promis partout ; sa dépendance **`mqtt` n'est déclarée nulle part** | L14 |
| **F-157** | Packaging cassé : `docker build` échoue, `shared/` absent de l'image, `dist/` sans `lib/` | L14 |
| **F-158** | **Aucun fichier `LICENSE`** pour un projet annoncé MIT ; 61 SVG sans licence tracée | L14 |

Les **P2 et P3** (≈ 125 findings) sont détaillés dans les rapports spécialisés et
priorisés dans `REMEDIATION_ROADMAP.md`.

### 3.4 Re-statut des 17 findings de 2026-08-22

| # | Statut |
|---|---|
| F-01, F-02 | **CORRIGÉS** (L12) — plus F-128, un troisième mensonge (`serial`) |
| F-03 | **OUVERT** — instruit à fond par L01 (devient F-19 sur l'exploitabilité) |
| F-04 | **OUVERT et AGGRAVÉ** — 17 suites disparaissent sans binding natif, dont les 6 écrites par L07 |
| F-05 | **INFIRMÉ** — déjà corrigé à HEAD (L10) |
| F-06, F-07, F-10 | **CORRIGÉS** (L01) |
| F-08 | Corrigé en août ; **la classe a été balayée** (L03) → F-38 trouvé, pire |
| F-09 | **OUVERT** — suppression confirmée sûre par L03 et L14 |
| F-11 | **OUVERT, mais déblocable** — CSP mesurée déployable aujourd'hui (L10) |
| F-12 | **CONCLU** — taux réels par locale mesurés avec marge d'erreur (L09) |
| F-13 | **CORRIGÉ** — lighting 2,35 % → 83,82 % (L02) |
| F-14 | **OUVERT, AGGRAVÉ en P1** (L11, L08) |
| F-15 | **OUVERT et élargi** → F-109 (L10) |
| F-16 | **OUVERT, requalifié** — les 3 `high` ne sont pas ceux annoncés (L10) |
| F-17 | **CORRIGÉ** (L00) |

---

## 4. Verdict — « complet et fonctionnel comme prévu » ?

**Non.** Le projet a une définition écrite de la v0.9 (`docs/V0.9_ROADMAP.md` §1) :
*« un réglage exposé dans l'UI ou une donnée persistée doit produire un effet réel et
correct ; plus aucune capacité morte ; plus aucune fonctionnalité backend sans surface UI »*.

Mesuré contre ce critère : **12 capacités mortes**, **72 surfaces orphelines**,
**6 diffusions WS sans aucun écouteur**, **7 promesses non tenues**. Et trois blockers
qui ne sont pas des manques mais des **régressions actives** : le routage live
inatteignable, les ancres de main jamais lues, et un enregistrement d'instrument qui
**détruit** une capacité que trois modules consomment.

**Ce qui est solide, et vérifié :** le déterminisme du moteur en temps logique (rejeu
identique à l'octet), la dérive d'horloge nulle (2 880 ticks sur 60 s, < 1 µs), les
migrations (panne au milieu de N prouvée conforme), les sauvegardes de bout en bout, la
reprise après `kill -9`, l'absence de fuite mémoire (pente 0,01 Mo/s sur 120 s),
l'absence d'injection SQL, et 16 processus × 500 écritures concurrentes sans perte.

**Le socle est bon. C'est le câblage entre les couches qui ne l'est pas.**

---

## 5. Reproduire cet audit

```bash
npm install --ignore-scripts
npm rebuild better-sqlite3 --build-from-source   # sinon 17 suites disparaissent en silence

npm run lint && npm run typecheck && npm run format:check
npm test && npm run test:frontend
node --experimental-vm-modules node_modules/jest/bin/jest.js \
  --coverage --collectCoverageFrom='src/**/*.js'

node scripts/audit/command-inventory.mjs      # corrigé par L01 (scanne index.html)
node scripts/audit/xss-sinks.mjs
node scripts/audit/dead-modules.mjs

node tests/e2e/run.mjs                        # harnais navigateur livré par L08
```

---

## 6. Rapports spécialisés

| Fichier | Couvre | Findings |
|---|---|---|
| `00_BASELINE.md` | Base de mesure, re-statut des 17 findings | F-17 |
| `01_API_CONTRACT.md` | T, U, V, AK, BC, BD | F-18 → F-27 |
| `02_LIGHTING.md` | AB01–AB07, AC | F-28 → F-37 |
| `03_MIDI_CORE.md` | D01–D05, BK | F-38 → F-45 |
| `04_TRANSPORTS.md` | K, L, M, N01, N02, G04 | F-46 → F-53 |
| `05_PLAYBACK.md` | F01–F05, O, BN, T3 | F-54 → F-63 |
| `06_ROUTING_ADAPTATION.md` | G, H, I, J, T1 | F-64 → F-75 |
| `07_PERSISTENCE.md` | W, X, Y, Z, AA, E04 | F-76 → F-85 |
| `08_E2E.md` | BI, BH, BW, Q01, AL | F-86 → F-95 |
| `09_FRONTEND_UX.md` | AM–AT, AU, AV, AS | F-96 → F-107 |
| `10_SECURITY.md` | AH, AI, AJ, AK | F-108 → F-117 |
| `11_SYSTEM_INSTALL.md` | B01–B05, AD, AE, AF, AG | F-118 → F-127 |
| `12_PERF_RESILIENCE.md` | AW, AX, AY, AZ, BA, BB, C02, C03 | F-128 → F-137 |
| `13_FEATURE_COMPLETENESS.md` | BW + V0.9 T1–T4 | F-138 → F-155 |
| `14_DOCS_RELEASE.md` | BC, BD, BQ–BT | F-156 → F-163 |
| `15_HARDWARE_QA_CHECKLIST.md` | K, L, M, O, P, S, AC, AD, BJ–BM, BX | F-164 → F-169 |

Livrables réutilisables : **harnais E2E navigateur** (`tests/e2e/`), **harnais de rejeu
déterministe** (`tests/audit/l05-replay-harness.test.js`), **fakes lighting**
(`tests/lighting/l02-fakes.js`), **checklist QA matériel** (106 vérifications, 12 sessions).
