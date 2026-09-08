# PLAN D'AUDITS — 2026-09-07

> **Statut : PROPOSITION — à valider avant lancement.**
> Objectif : la liste exhaustive des audits à mener pour pouvoir déclarer
> Général Midi Boop « complet et fonctionnel comme prévu ». Une fois validée,
> chaque lot est confié à un agent parallèle.

---

## 0. Point de départ (mesuré aujourd'hui, pas estimé)

**Audit d'autorité en vigueur** : `docs/audit/2026-08-22/` — 22 rapports,
sections A→BX, commit `1e98176`, 17 findings (1 corrigé, **16 ouverts**, dont
2 P1, aucun P0).

**HEAD = `8605680`**, un seul commit depuis cet audit (l'audit lui-même) → les
16 findings sont a priori tous encore ouverts. Re-vérifié ce jour pour F-03 :

```
Registered commands       : 270
  with payload schema     : 86 (31.9%)     <- inchangé depuis le 2026-08-22
  called by frontend      : 147 (54.4%)
  mentioned in tests      : 63 (23.3%)
  documented in API.md    : 187 (69.3%)
```

**Environnement de cette session** (contraint ce qui est faisable) :

| Ressource | État | Conséquence |
|---|---|---|
| Node 22.22.2, deps JS installées (`--ignore-scripts`) | ✅ | lint/tsc/tests JS OK |
| `python3` + `make` + `g++` | ✅ | `better-sqlite3` recompilable → **les 10 suites SQLite silencieusement skippées (F-04) redeviennent exécutables** |
| En-têtes ALSA (`libasound2-dev`) | ❌ | `midi`/`easymidi` non compilables → chemin USB réel indisponible |
| Chromium + Playwright pré-installés dans l'image | ✅ | **E2E navigateur enfin possible** (§BI, le plus gros levier de l'audit précédent) |
| Docker | ✅ | build de l'image `Dockerfile` vérifiable (§B04) |
| Raspberry Pi, matériel MIDI, audio, BLE, GPIO, UART | ❌ | ~15 sections restent strictement HW |

**Le vrai constat de cadrage.** L'audit du 2026-08-22 a atteint le **niveau 3
au mieux** et laisse ~30 sections en `NOT TESTED`. Une grande partie de ces
sections n'est **pas** bloquée par le matériel — elle a été laissée de côté
faute de temps. C'est là que se trouve l'essentiel du travail listé ci-dessous.

---

## 1. Critères de sortie — ce que « complet et fonctionnel » veut dire

Un lot n'est « vert » que si ses cinq critères sont satisfaits :

1. **Aucune capacité morte.** Tout réglage exposé dans l'UI ou persisté en base
   produit un effet réel, mesurable, sur la sortie MIDI / lumière / audio.
2. **Aucune surface orpheline.** Toute commande backend est atteignable depuis
   l'UI, ou documentée comme volontairement interne.
3. **Aucun chemin non validé.** Chaque section porte un état explicite
   (`PASS` / `PARTIAL` / `FAIL` / `NOT TESTED` / `HW REQUIRED`) avec sa preuve
   reproductible — jamais un `PASS` par optimisme.
4. **Toute promesse tenue.** Chaque fonctionnalité annoncée dans `README.md`,
   `docs/`, le wiki ou l'UI existe, est atteignable, et fait ce qu'elle dit.
5. **Zéro finding P0/P1 ouvert.**

---

## 2. Les lots d'audit

**L00 est bloquant et séquentiel** (il fabrique la base de mesure commune).
**L01→L15 sont indépendants et parallélisables.**

| # | Lot | Sections A→BX couvertes | Faisable ici | Poids |
|---|---|---|---|---|
| **L00** | Baseline reproductible & re-statut des 16 findings | A02, A03, BE, BF, BP | ✅ | S — **bloquant** |
| **L01** | Contrat WebSocket & API HTTP | T, U, V, AK, BC, BD | ✅ | L |
| **L02** | Lighting (0 % de couverture) | AB01–AB07, AC(partiel) | ✅ | L |
| **L03** | Cœur MIDI & conformité protocole | D01–D05, BK | ✅ | M |
| **L04** | Transports (part testable sans matériel) | K, L, M, N01, N02, G04 | ✅ partiel | M |
| **L05** | Playback, timing & déterminisme | F01–F05, O, BN, T3 | ✅ partiel | L |
| **L06** | Routage / adaptation / familles — matrice de complétude | G, H, I, J, T1 | ✅ | L |
| **L07** | Persistance, migrations, fichiers, concurrence | W, X, Y, Z, AA, E04 | ✅ | M |
| **L08** | **E2E navigateur (nouveau harnais Playwright)** | BI, BH, BW, Q01, AL | ✅ | L — **fort levier** |
| **L09** | Frontend : UI/UX, a11y, i18n, CSS, responsive, mémoire | AM–AT, AU, AV, AS | ✅ | M |
| **L10** | Sécurité | AH, AI, AJ, AK | ✅ | M |
| **L11** | Système Pi, installation, mise à jour, offline-first | B01–B05, AD, AE, AF, AG | ✅ partiel | M |
| **L12** | Performance, soak, résilience, observabilité | AW, AX, AY, AZ, BA, BB, C02, C03 | ✅ | M |
| **L13** | **Complétude fonctionnelle vs spécification** | BW + V0.9_ROADMAP T1–T4 | ✅ | L — **cœur de la demande** |
| **L14** | Docs ↔ code, release, licences, reproductibilité | BC, BD, BQ, BR, BS, BT | ✅ | S |
| **L15** | Checklist QA matériel (rédaction, pas exécution) | K, L, M, O, P, S, AC, AD, BJ, BL, BM, BX | ✅ (doc) | S |

---

### L00 — Baseline reproductible & re-statut des findings *(bloquant)*

**Pourquoi.** Tous les autres lots mesurent leurs écarts contre cette base. Et
l'audit précédent laisse une mesure faussée : `collectCoverageFrom` n'est pas
défini, donc le rapport par défaut lit ~7 points trop haut, et 10 suites de
persistance se skippent **en silence** pendant que Jest affiche « Ran all test
suites » (F-04).

**Travaux.**
- `npm rebuild better-sqlite3 --build-from-source` → **dé-skipper les 10 suites
  SQLite** ; mesurer ce qu'elles révèlent une fois réellement exécutées.
- `lint` · `typecheck` · `format:check` (rouge sur `main`, F-17) · `test` ·
  `test:frontend` · couverture **vraie** (`--collectCoverageFrom='src/**/*.js'`).
- Rejouer les 4 outils `scripts/audit/*.mjs` et diffuser leurs chiffres aux
  autres lots.
- **Re-statuer les 16 findings ouverts** F-01…F-17 à HEAD : encore vrai ? plus
  vrai ? aggravé ?

**Livrable.** `00_BASELINE.md` + tableau de re-statut des findings.

---

### L01 — Contrat WebSocket & API HTTP

**Pourquoi.** C'est le plus gros trou réel identifié : **184 des 270 commandes
n'ont aucun schéma de payload et le validateur *fail-open*** (F-03, P1). Trois
autres findings vivent ici.

**Questions à trancher.**
- Quelles commandes acceptent aujourd'hui n'importe quoi, et laquelle est la
  plus dangereuse ? (candidats : `LightingCommands` ×31 non testé pilotant du
  réseau/GPIO, `SystemCommands` ×10 update/reboot/restore, `FileCommands` ×16)
- F-06 : la trame d'erreur du rate-limiter ne porte pas d'`id` → la commande
  throttlée pend 10 s côté client. Reproduire.
- F-07 : le limiteur WS n'exempte pas le **panic** (le limiteur device, si).
  Peut-on faire taire un orchestre bloqué ? Reproduire.
- F-10 : un `/api/*` inconnu renvoie 200 + le HTML de la SPA au lieu de 404.
- Versionnement des handlers (ADR-003) : que se passe-t-il avec une `version`
  inconnue, absente, régressive ?
- Enveloppe : `id` dupliqué, `id` absent, `command` non-string, payload géant,
  JSON invalide, trame binaire.
- Fuite d'information : quelles erreurs internes remontent verbatim au client ?
- 123 commandes sur 270 ne sont **appelées par aucun frontend** — mortes ou
  internes ? (croiser avec L13)

**Livrable.** `01_API_CONTRACT.md` + matrice commande × schéma × frontend ×
test × doc, et la liste priorisée des schémas à écrire.

---

### L02 — Lighting

**Pourquoi.** ≈1 380 statements à **0 % de couverture** (F-13, P1), pilotant du
réseau réel et du GPIO, **évalués synchrones à chaque message MIDI**.

**Questions à trancher.**
- Un driver lent ou pendu peut-il **bloquer le chemin MIDI** ? (le risque n°1)
- Le moteur de règles : sémantique note / vélocité / CC / plage / MIDI-learn,
  priorités, conflits, coût d'évaluation borné.
- Les 7 drivers (Art-Net, sACN, OSC, HTTP/WLED, MQTT, GPIO, …) contre des
  sockets locales / serveurs bouchons : connexion, reconnexion, timeout, cap de
  débit, perte réseau, arrêt propre. **Aucun matériel requis.**
- Retour à un état sûr (lumières éteintes) sur `Application.stop()`.
- `LightingDatabase` (1,7 % de couverture) et les 31 commandes lighting sans
  schéma.

**Livrable.** `02_LIGHTING.md` + plan de tests détaillé (et les tests eux-mêmes
si le périmètre retenu inclut les correctifs).

---

### L03 — Cœur MIDI & conformité protocole

**Pourquoi.** F-08 a montré la classe de bug qui compte ici : les **mêmes
octets se comportaient différemment selon le transport**. Un seul cas a été
corrigé ; la classe n'a pas été balayée.

**Questions à trancher.**
- **Parité transports** : injecter le même flux d'octets dans USB / BLE /
  série / RTP et exiger un événement identique. Systématiser, pas au cas par cas.
- Running status (D02) — le parser série est correct *à la lecture*, jamais
  testé sur flux d'octets réel.
- SysEx : GS / XG / identity reply, messages fragmentés, tronqués, imbriqués,
  taille extrême.
- RPN / NRPN, CC 14 bits, aftertouch canal vs polyphonique, program change +
  bank select.
- Panic (D05) : tous canaux, tous transports, sous charge.
- `MidiClockGenerator` (0,5 % de couverture) : dérive, start/stop/continue, SPP.

**Livrable.** `03_MIDI_CORE.md` + matrice de conformité MIDI 1.0 et matrice de
parité transports.

---

### L04 — Transports (part testable sans matériel)

**Pourquoi.** `NetworkManager` 0,25 %, `SerialMidiManager` 17,3 %,
`DeviceDiscovery` 3,9 % — or **ces trois-là sont du JS pur** derrière une façade
matérielle : un faux énumérateur et une socket locale suffisent.

**Questions à trancher.**
- `DeviceDiscovery` avec un énumérateur bouchon : apparition, disparition,
  doublons de nom, noms Unicode, ports fantômes.
- Hot-plug **pendant la lecture** (G04) simulé au niveau du gestionnaire.
- Reconnexion : back-off, épuisement (`reconnect_exhausted`), fuite de handles.
- RTP-MIDI / AppleMIDI (N01, N02) contre un pair local : handshake, horloge,
  running status, perte de paquets, réordonnancement.
- BLE : le codec est testé, la machine à états de connexion non.
- Ce qui reste **strictement** matériel, énuméré pour L15.

**Livrable.** `04_TRANSPORTS.md`.

---

### L05 — Playback, timing & déterminisme

**Questions à trancher.**
- **Déterminisme (BN)** : même fichier + même config ⇒ **exactement** la même
  sortie ? Harnais de rejeu avec horloge injectée, comparaison octet à octet.
- **Divergence live vs baké (T3)** : le même fichier joué en direct et baké
  doit produire le même résultat. Écarts connus non refermés.
- Charge polyphonique (F04) : 16 canaux saturés, éviction, `min_note_interval`.
- Seek / pause / stop / boucle A/B, y compris pendant un `advance`.
- Tempo map, changements de tempo, SMPTE, delta-times après édition.
- Compensation de latence : la **partie calcul** est vérifiable sans audio.

**Livrable.** `05_PLAYBACK.md` + harnais de rejeu déterministe réutilisable.

---

### L06 — Routage / adaptation / familles d'instruments

**Pourquoi.** C'est la zone la mieux couverte (74–79 %) mais **jamais vérifiée
en complétude** : il n'existe aucune matrice « capacité déclarée ⇒ capacité
consommée ».

**Question centrale.** Pour **chaque** colonne de capacité en base et **chaque**
réglage d'instrument exposé dans l'UI : est-il écrit ? validé ? **lu par le
moteur** ? testé ? Toute case « écrit + validé + jamais lu » est une capacité
morte — donc un blocker « 100 % fonctionnel ».

**Points chauds hérités.** T1.1 voix GM multiples (route-through live non
couvert), T1.8 pipeline descripteur v2 (bloqué sur une migration `CHECK` à
vérifier contre une vraie base — **or la base sera disponible après L00**),
`capo_fret` inerte assumé, `independent_fingers` EXPERIMENTAL.

**Livrable.** `06_ROUTING_ADAPTATION.md` + **matrice de complétude des
capacités** (le tableau que le projet n'a jamais eu).

---

### L07 — Persistance, migrations, fichiers, concurrence

**Pourquoi.** Section §W (concurrence) entièrement `NOT TESTED`, et les suites
de persistance ne tournaient même pas.

**Questions à trancher.**
- Concurrence SQLite réelle : écritures parallèles, `SQLITE_BUSY`,
  `busy_timeout`, WAL sous contention, transactions imbriquées.
- Concurrence applicative (W) : deux clients WS qui modifient le même
  instrument / la même playlist / le même fichier au même instant.
- Intégrité référentielle : suppression d'un instrument utilisé par un routage,
  d'un fichier référencé par une playlist, cascades.
- Migrations : rejeu, panne au milieu du fichier N, migration descendante,
  base pré-existante « legacy ».
- Sauvegarde / restauration sous charge, plancher de GC, quotas disque.
- `FileManager` / blobstore : import / export (E04, jamais testé), chemins
  hostiles, fichiers concurrents, quota, fichiers orphelins.

**Livrable.** `07_PERSISTENCE.md`.

---

### L08 — E2E navigateur *(nouveau harnais — le plus fort levier)*

**Pourquoi.** L'audit précédent l'écrivait noir sur blanc : ajouter un harnais
navigateur convertit **~7 sections aujourd'hui inauditables** en sections
testables. Aucun harnais n'existe (ni Playwright, ni Puppeteer, ni Cypress) —
**mais Chromium et Playwright sont déjà présents dans cette image**.

**Scénario canonique à faire passer de bout en bout :**
`démarrage → instrument virtuel configuré → import d'un MIDI → assignation →
adaptation → lecture → édition → sauvegarde → rechargement → vérification`.

**Puis, dans la foulée :** erreurs console pendant le parcours, fuite de
listeners entre ouvertures/fermetures de modales, comportement à la coupure du
WebSocket, rechargement en cours de lecture.

**Livrable.** Harnais `tests/e2e/` + `08_E2E.md` (rapport du premier passage).

---

### L09 — Frontend : UI/UX, a11y, i18n, CSS, responsive, mémoire

**Questions à trancher.**
- **Accessibilité (AR)** : axe-core sur chaque écran via le harnais L08 —
  contraste, focus, rôles ARIA, navigation clavier, ordre de tabulation.
- **i18n (AS, F-12)** : structure parfaite (2 737 clés × 28 locales, 0 dérive)
  mais **11 à 30 % des chaînes ne sont pas traduites** — annoncer « 28 langues »
  est structurellement vrai et fonctionnellement faux. Mesurer par locale,
  décider quoi annoncer.
- Discipline `t()` / `tHtml()` : re-scanner (le convention-check existe).
- CSS (AT) : règles mortes, doublons, conflits de spécificité, thème sombre.
- Responsive (AO) : les 3 modales géantes (RoutingSummary 3 550 l., ISMSections
  3 028 l., KeyboardPiano 2 337 l.) sur petit écran.
- Mémoire (AU, AV) : ouvrir/fermer 50 fois chaque modale, mesurer le tas.

**Livrable.** `09_FRONTEND_UX.md`.

---

### L10 — Sécurité

**Pourquoi.** Le socle est bon (XSS propre, auth fail-closed, pollution de
prototype bloquée) mais **quatre findings de sécurité restent ouverts**.

**Questions à trancher.**
- F-15 : **deux assets d'exécution téléchargés à l'installation depuis des
  miroirs tiers, sans somme de contrôle** — et l'un est exécuté comme du
  JavaScript dans le navigateur. Chaîne d'approvisionnement.
- F-16 : 8 advisories `high` dont `ws` (dépendance runtime directe, divulgation
  de mémoire non initialisée) ; **la porte CI ne bloque qu'au niveau
  `critical`**.
- F-11 : CSP désactivée — arbitrage assumé, à ré-instruire maintenant que
  `tHtml` existe.
- F-05 : `showConfirmModal` échappe le `title` mais traite le `message` comme du
  HTML brut.
- Rejouer le scanner de sinks XSS + les sondes live (traversée de chemin,
  injection de commande dans `execFile`, `isPrivateClient` derrière un tunnel).
- Autorisation : token, bypass même-origine, RFC1918 — quel est le modèle de
  menace réel d'un Pi sur un réseau de scène ?

**Livrable.** `10_SECURITY.md`.

---

### L11 — Système Pi, installation, mise à jour, offline-first

**Questions à trancher.**
- **F-14 — le « offline-first » ne tient pas au démarrage** : si le
  téléchargement d'installation n'a pas eu lieu, la SPA bloque sur un
  `document.write` vers un CDN qu'un Pi hors-ligne ne peut pas joindre.
  Reproduire, mesurer, proposer le repli.
- `scripts/update.sh` + `SystemCommands` (19 % de couverture) : mise à jour en
  place, rollback, coupure de courant au milieu, `/api/update-status` (public
  par conception).
- Build Docker (§B04, jamais tenté — **docker est disponible ici**).
- Hotspot / captive portal (AE) : surface de commande relue, jamais exécutée.
- Installation propre : `Install.sh` relu ligne à ligne, idempotence, PM2 /
  systemd / redémarrage.
- Reprise après crash (C03) : `NOT TESTED`, faisable par kill -9 + relance.

**Livrable.** `11_SYSTEM_INSTALL.md`.

---

### L12 — Performance, soak, résilience, observabilité

**Questions à trancher.**
- **F-01 / F-02 — `/api/health` ment** : `usb` annonce `ready` sans bibliothèque
  MIDI, `ble` annonce `ready` après échec d'init. Un opérateur ne peut pas s'y
  fier. Corriger la sémantique, pas juste le symptôme.
- Benchmarks (`npm run bench`) et soak (`npm run perf:load`) : jamais exécutés
  dans un audit. Les faire tourner, publier les chiffres, fixer des seuils.
- Injection de fautes (AZ) : base verrouillée, disque plein, port occupé,
  driver lighting pendu, client WS qui ne lit plus (backpressure).
- Arrêt (C02) : SIGINT/SIGTERM réels, double signal, arrêt pendant lecture.
- Observabilité (BA) : niveaux de log, rotation, ce qu'on voit quand ça casse à
  3 h du matin sur scène.

**Livrable.** `12_PERF_RESILIENCE.md`.

---

### L13 — Complétude fonctionnelle vs spécification *(cœur de la demande)*

**Pourquoi.** C'est le lot qui répond littéralement à « un système complet et
fonctionnel **comme prévu** ». Les autres lots vérifient que ce qui existe
marche ; celui-ci vérifie qu'**il ne manque rien**.

**Méthode.** Construire **une** matrice unique en croisant :
`README.md` + `docs/*.md` + `wiki/` + `docs/V0.9_ROADMAP.md` (T1→T4 résiduels)
+ `INSTRUMENT_FAMILY_REFACTOR_ROADMAP.md` + `TODO.md` + les 4 ADR + la surface
UI réelle + les 270 commandes.

Pour chaque fonctionnalité annoncée, cinq colonnes :
**promise (doc) · backend · UI atteignable · effet réel vérifié · test**.

**Points ouverts déjà connus à re-statuer.** T1.1(b)(c), T1.8, T2.4
(`validate_routing_feasibility` non câblée), T2.10 (loop A/B non exposé), T3
(live ≠ baké), T4 (reports V2 arbitrés).

**Livrable.** `13_FEATURE_COMPLETENESS.md` — la matrice + la liste, close, de
ce qui manque pour la v0.9.

---

### L14 — Docs ↔ code, release, licences, reproductibilité

**Questions à trancher.**
- `docs/API.md` documente 187 des 270 commandes (69,3 %) — et 83 ne le sont pas.
- `docs/ARCHITECTURE.md` est **périmé** (le renommage `managers/`→`transports/`
  et `views/components/`→`features/` n'y est pas) — `CLAUDE.md` le dit déjà.
- Versionnement incohérent : `package.json` dit 0.8.1, la roadmap parle de
  v0.8.2. `CHANGELOG.md` à jour ?
- F-17 : `npm run format:check` **échoue à HEAD sur 13 fichiers non touchés**
  → le job `lint` de la CI est rouge sur `main`.
- CI : quelles étapes manquent (couverture ratchet, inventaire de commandes,
  `npm audit` au bon niveau, E2E).
- Licences des dépendances, reproductibilité du build, procédure de release.

**Livrable.** `14_DOCS_RELEASE.md`.

---

### L15 — Checklist QA matériel *(rédaction, pas exécution)*

**Pourquoi.** ~15 sections ne seront **jamais** validables en sandbox. Les
laisser en `HW REQUIRED` sans procédure, c'est les laisser en jachère.

**Livrable.** `15_HARDWARE_QA_CHECKLIST.md` — une procédure pas-à-pas
exécutable par un humain devant le Pi et les instruments, avec pour chaque
point : matériel requis, gestes, **critère d'acceptation mesurable** (pas
« ça sonne bien » mais « latence < X ms mesurée ainsi »), et quoi noter en cas
d'échec. Couvre : USB (K), BLE (L), UART 31 250 baud (M), latence audio (O),
preview audio (P), claviers tactiles (S), synchro MIDI↔lumière (AC), plateforme
Pi (AD), matériel en boucle (BJ), matrice d'instruments réels (BL), qualité
musicale (BM), et la validation orchestre (BX) — le vrai test système.

---

## 3. Parallélisation proposée

```
Vague 0 (séquentielle, ~15 min)     L00  ── fabrique la base de mesure
                                     │
Vague 1 (15 agents en parallèle)     ├── L01  contrat API/WS
                                     ├── L02  lighting
                                     ├── L03  cœur MIDI
                                     ├── L04  transports
                                     ├── L05  playback/déterminisme
                                     ├── L06  routage/adaptation
                                     ├── L07  persistance
                                     ├── L08  E2E navigateur
                                     ├── L09  frontend/UX/i18n
                                     ├── L10  sécurité
                                     ├── L11  système/install
                                     ├── L12  perf/résilience
                                     ├── L13  complétude fonctionnelle
                                     ├── L14  docs/release
                                     └── L15  checklist QA matériel
                                     │
Vague 2 (séquentielle)              Synthèse: AUDIT_MASTER + REMEDIATION_ROADMAP
```

**Règles communes imposées à chaque agent** (sans quoi 15 agents dans un seul
arbre de travail se marchent dessus) :

1. **Un agent n'écrit que dans son propre fichier** `docs/audit/2026-09-07/NN_*.md`
   (+ ses propres fichiers de test sous un nom qui lui est propre). Aucune
   modification de fichier partagé (`package.json`, `config.json`, CI…) : ces
   changements sont **proposés dans le rapport**, appliqués en vague 2.
2. **Aucun agent ne lance `npm install` / `npm rebuild`** — L00 l'a déjà fait.
3. **Preuve obligatoire.** Toute affirmation porte sa commande de reproduction
   et sa sortie. Un `PASS` sans preuve est un `NOT TESTED`.
4. **États normalisés** : `PASS` / `PARTIAL` / `FAIL` / `NOT TESTED` /
   `HW REQUIRED` / `BLOCKED` / `EXPERIMENTAL` + niveau de validation 0→5, à
   l'identique de l'audit du 2026-08-22 (pour que les deux soient comparables).
5. **Numérotation continue des findings** : `F-18`, `F-19`, … (F-01→F-17 sont
   pris). Chaque agent réserve une plage à la synthèse pour éviter les
   collisions.

---

## 4. Décisions à valider avant lancement

| # | Décision | Options |
|---|---|---|
| D1 | **Périmètre des agents** | (a) audit seul — rapports, zéro modification de code · (b) audit + correctifs P1/P2 sûrs et locaux · (c) audit + correctifs complets |
| D2 | **Outillage manquant** | Le harnais E2E (L08) et les tests lighting (L02) sont du **développement**, pas de l'audit — les inclure ou les laisser en recommandation ? |
| D3 | **Étendue** | Les 16 lots, ou d'abord le sous-ensemble qui bloque « fonctionnel » (L00, L01, L02, L06, L08, L13) ? |

