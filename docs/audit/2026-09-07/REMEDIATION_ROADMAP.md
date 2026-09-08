# REMEDIATION_ROADMAP — audit du 2026-09-07

**Base :** commit `8dc170e` · **Autorité :** `AUDIT_MASTER.md`

Ordonné par (sévérité × confiance × effort), et par **dépendance** : certains findings
n'ont pas de remède tant qu'un autre est ouvert. Les efforts sont des estimations
d'ingénierie, pas des engagements.

---

## Déjà corrigé pendant l'audit

Tout ce qui suit est **livré, testé rouge→vert, et vert à HEAD** :

| # | Correctif | Lot |
|---|---|---|
| **F-18 (P0)** | `lighting_midi_learn` tuait le processus | L01 |
| **F-38 (P1)** | L'USB ignorait les 10 System Real-Time / Common | L03 |
| **F-48 (P1)** | Décodeur BLE : ~6,25 % des paquets corrompus | L04 |
| **F-30/F-129 (P1)** | Lumières allumées après chaque arrêt — 3 causes | L02, L12 |
| **F-01/F-02/F-128** | `/api/health` mentait sur `usb`, `ble`, `serial` | L12 |
| **F-06, F-07, F-10, F-26** | Rate-limit sans `id` · panic non exempté · 404 API · outil d'inventaire | L01 |
| **F-40, F-42** | Parité pitch bend · trame tronquée à vélocité 127 | L03 |
| **F-49, F-50, F-52, F-53a** | Sessions AppleMIDI entrantes · série morte après bascule · reconnexion | L04 |
| **F-54, F-56, F-57** | Dernier accord sans Note Off · **boucle qui ne rejouait rien** · `pause`/`resume` | L05 |
| **F-64** | Divergence live ↔ fichier sur les CC 20/21 de tablature | L06 |
| **F-83** | `exportFile` sans vérification du blob | L07 |
| **F-98, F-100, F-101, F-102** | Double échappement · piège de focus · `var()` sans repli · contraste 1,06:1 | L09 |
| **F-111** | Échappement HTML des dialogues de l'éditeur | L10 |
| **F-123** | Hotspot : échec `nmcli` rapporté comme succès | L11 |
| **F-13** | Lighting : 2,35 % → **83,82 %** de couverture | L02 |
| **F-17** | `format:check` rouge sur `main` | L00 |

---

## ✅ Vague 1 — LIVRÉE (2026-09-07)

Les cinq items de la vague 1 sont corrigés, chacun avec un test rouge→vert.
État à l'issue : **199 suites / 2 677 tests backend · 86 / 1 560 frontend ·
0 erreur lint · `tsc` clean · `format:check` vert.**

| # | Finding | Résultat mesuré |
|---|---|---|
| **R1** | F-108, F-114 | `security.mode` résolu en **un seul endroit**, lu par HTTP **et** WS. En `secure`, le WS exige le token pour toute connexion. Les deux portes HTTP forgeables (`Sec-Fetch-Site`, `Origin==Host`) sont **supprimées**. |
| **R2** | F-110 | Toutes les données d'appareil BLE échappées dans les deux renderers ; sélecteurs CSS ne concaténant plus de valeur non fiable. |
| **R3** | F-19 / F-03 | Couverture de schémas **86/270 → 198/270 (73,3 %)**. Liste d'exemption = **72 commandes sans payload, dette nulle** — fait vérifié, pas affirmé. Cliquet CI en place, vérifié rouge. |
| **R4** | F-76, F-77, F-81, F-85 | Verrou par fichier **+** CAS optimiste. Le perdant reçoit un **409** ; plus jamais deux `success`. |
| **R5** | F-130, F-78 | Gel de la boucle d'événements **5 031 ms → 257 ms**. Borné, pas supprimé (`better-sqlite3` est synchrone) — dit explicitement. |

> ⚠️ **Conséquence à traiter avant d'annoncer le mode `secure`.** Maintenant que
> R1 l'applique réellement de bout en bout, **la SPA ne sait pas présenter de
> token** : `GMBOOP_SECURITY_MODE=secure` rend donc l'interface inutilisable.
> Avant R1 le mode était inopérant côté WS, ce qui masquait le trou. Il faut
> soit donner un porteur de token à la SPA, soit documenter `secure` comme
> « accès API uniquement ». Détail dans `WAVE1_R1_R3.md`.

Comptes rendus : `WAVE1_R1_R3.md`, `WAVE1_R4_R5.md`.

---

## Vague 1 — sécurité et intégrité (à faire avant toute release)

### R1 · Fermer le contournement d'authentification WebSocket — F-108
**Effort : S · Bloquant pour F-114 et F-116, qui n'ont aucun remède sans lui.**

`securityMode` n'est lu que dans `HttpServer.js` : le WebSocket — **270 commandes, dont
`system_update` et `system_shutdown`** — l'ignore, et accepte un client sans token qui
forge `Origin` et `Host`. La parade documentée est fausse, ce qui est pire qu'une absence
de parade : un opérateur qui a activé `GMBOOP_SECURITY_MODE=secure` se croit protégé.

*Fait quand :* le mode sécurisé couvre le WS, un client forgé est refusé par un test.

### R2 · Corriger la XSS DOM du scan Bluetooth — F-110
**Effort : XS · Confiance : certaine (exécutée en Chromium)**

`BluetoothScanModal.js:297` injecte le nom d'appareil BLE brut dans `data-device-name`.
L'attaquant n'a besoin que d'être **à portée radio**. Correctif : `tHtml()` ou
échappement d'attribut, plus un balayage des autres puits alimentés par des données
d'appareil.

### R3 · Rendre la validation *fail-closed* — F-19 / F-03
**Effort : M**

184 commandes sur 270 sans schéma, et `validateByCommand` renvoie `{valid:true}` pour
elles. Mesuré : **49,5 % des trames hostiles acceptées, 11,8 % en erreur interne masquée**
venant du driver SQLite — le payload va jusqu'à la requête préparée. Aucune injection SQL
(les requêtes préparées tiennent), mais **la dernière défense est la base**.

1. Inverser le défaut ; liste blanche explicite pour les commandes sans paramètre.
2. Backfill par ordre de danger — `01_API_CONTRACT.md` fournit les 10 schémas les plus
   urgents **prêts à coller**, et `02_LIGHTING.md` les 31 commandes lighting.
3. Cliquet CI sur `command-inventory.mjs` : la couverture de schémas ne peut plus baisser.

### R4 · Sérialiser les écritures concurrentes — F-76, F-77, F-81
**Effort : M**

Deux `apply_assignments` concurrents avec `overwriteOriginal` **cumulent** leurs
transformations (70 → 82) et les deux clients reçoivent `success`. Avec +5 / −5, les deux
adaptations disparaissent. Scénario « deux onglets ouverts », parfaitement banal.

### R5 · Configurer `busy_timeout` — F-130, F-78
**Effort : XS · Impact scène : maximal**

Une base verrouillée **gèle la boucle d'événements 5 à 10 s** — donc l'ordonnanceur MIDI.
Trouvé indépendamment par deux lots, par deux chemins. `busy_timeout` n'est configuré
nulle part. C'est le correctif au meilleur rapport effort/impact de tout l'audit.

---

## Vague 2 — le produit doit démarrer et se livrer

### R6 · Réparer l'offline-first — F-14, F-87, F-119
**Effort : S · Sévérité : P1 · C'est la promesse centrale du produit**

Chaîne complète, prouvée : `vite.config.js` ne copie jamais `lib/` dans `dist/` →
`/lib/WebAudioFontPlayer.js` répond **200 + le shell SPA** au lieu de 404 → la garde
`typeof … === 'undefined'` est **toujours vraie** → le `document.write` vers
`surikov.github.io` se déclenche systématiquement, **bloquant le parsing 1:1 avec le
délai réseau** (mesuré : 8 000 ms de latence ⇒ 8 421 ms de blocage) → **174 des 191
`<script>` sont derrière ce blocage**.

Diffs fournis pour `vite.config.js` (ajouter `lib` à `copyStaticTree`), `index.html`
(supprimer le repli) et `HttpServer.js` (404 sur asset absent).

### R7 · Réparer le packaging — F-118, F-157
**Effort : S · Recette déjà prouvée**

Trois blocages indépendants : `COPY locales/` (répertoire inexistant), `shared/` jamais
copié, et `npm ci --ignore-scripts` qui prive l'image du binding `better-sqlite3`.
Recette minimale vérifiée : **+4 `COPY`, +`npm rebuild better-sqlite3`** → build 11 s à
chaud, 456 Mo, conteneur `Up`, `/api/health` 200.

### R8 · Déclarer `mqtt` — F-156
**Effort : XS**

`MqttLightDriver.js` importe `mqtt`, déclaré nulle part, pendant que le README, le wiki
(×4) et l'UI promettent MQTT. Soit on déclare la dépendance (en `optionalDependencies`,
comme les autres transports optionnels), soit on retire la promesse.

### R9 · Rollback de mise à jour — F-120, F-121
**Effort : M**

`update.sh` n'a **aucun rollback** : une fois le `git pull` réussi, tout échec ultérieur
n'est qu'un avertissement, et l'auto-stash **mange `config.json`**. Une coupure de courant
au mauvais moment laisse une installation non démarrable.

### R10 · Licences — F-158
**Effort : S · Risque juridique**

Aucun fichier `LICENSE` pour un projet annoncé MIT. 61 des 107 SVG livrés viennent de SVG
Repo sans licence ni attribution tracée. Et `assets/sf2/README.md` **affirme une
vérification SHA-256 que le script ne fait pas** — à corriger dans les deux sens :
ajouter la vérification (R11) ou retirer l'affirmation.

### R11 · Intégrité des assets d'installation — F-109, F-15
**Effort : S**

Deux assets d'exécution téléchargés sans somme de contrôle, et `/api/waf/:filename`
rejoue du JS tiers **au runtime en same-origin** — donc immunisé à toute CSP
`script-src 'self'`. Épingler + vérifier un SHA-256, échouer bruyamment sinon.

---

## Vague 3 — tenir la promesse « 100 % fonctionnel »

Ces trois-là ne sont pas des manques, ce sont des **régressions actives**.

### R12 · Rendre le routage MIDI live atteignable — F-138
**Effort : M** · 15 commandes testées et documentées, **aucun moyen de créer une route
depuis la SPA**. Casse la promesse README « inbound BLE notes are routed like any other
input ».

### R13 · Lire `hand_anchors` et `disabled_notes` — F-139
**Effort : M** · Épinglés par l'utilisateur, persistés, **dessinés à l'écran**, jamais lus
par le moteur. L'utilisateur voit sa configuration ; elle ne joue pas.

### R14 · Cesser de détruire `is_fretless` et `capo_fret` — F-140
**Effort : XS** · `ISMSave.js:267` les remet à 0 **à chaque enregistrement**, alors que
trois modules du moteur les consomment.

### R15 · Les 12 autres capacités mortes — §L06, §L13
**Effort : L** · Liste close dans `06_ROUTING_ADAPTATION.md` et `13_FEATURE_COMPLETENESS.md`.
Pour chacune, deux issues honnêtes : **la câbler**, ou **retirer le réglage de l'UI et la
colonne de la base**. Une capacité morte laissée en place est un mensonge à l'utilisateur.

### R16 · Fermer T3 (live ≠ baké) — F-60
**Effort : M** · Les 4 items cochés de la roadmap tiennent, mais la table réelle compte
**9 axes** et **3 divergences restent ouvertes**, dont l'éviction polyphonique : la voix
médiane **sonne puis est coupée en live**, et n'est **jamais émise en baké**.

---

## Vague 4 — robustesse de scène

| # | Finding | Pourquoi ça compte en concert |
|---|---|---|
| R17 | **F-28** — un driver lighting synchrone lent bloque le MIDI (+120 ms × règles) | Le son s'arrête parce qu'une LED est lente |
| R18 | **F-45** — le panic n'envoie **jamais** CC 121, et il n'existe **aucun panic global** | Un sustain verrouillé survit au panic |
| R19 | **F-47** — aucun note-off ni panic à la déconnexion **ni au rebranchement** | Notes bloquées à chaque câble arraché |
| R20 | **F-94** — rechargement en lecture : l'orchestre continue, l'UI perd tout contrôle | Plus aucun moyen d'arrêter le son |
| R21 | **F-43** — aucun Song Position Pointer : un seek envoie `Start` | L'esclave repart mesure 1 |
| R22 | **F-31** — règle `noteon` par défaut de l'UI : LED allumée pour toujours | Projecteur resté allumé |
| R23 | **F-55, F-61** — gardes temps-mur : **1 note sur 8 supprimée** sans raison musicale | Notes manquantes inexplicables |

---

## Vague 5 — accessibilité, i18n, documentation, CI

- **F-103** — **13 modales sur ~23 impossibles à fermer au clavier** (ni `role="dialog"`,
  ni `aria-modal`, ni Échap, ni piège de focus). **F-104** — 202 champs sur 319 sans nom
  accessible. C'est de l'inutilisabilité, pas du confort.
- **F-96** — traduire **le seul bloc `lighting.*`** (358 clés, 13,1 % de l'interface, non
  traduit dans 17 locales sur 27) ferait passer toutes les locales au-dessus de 75 %.
  **F-97** — ≥ 313 chaînes françaises codées en dur hors i18n.
- **F-159/F-160** — `docs/API.md` : 83 commandes non documentées et, pire, **7 fausses
  sur 24 échantillonnées** ; le wiki cite **17 commandes qui n'existent pas**.
- **F-04** — le skip silencieux fait **disparaître 17 suites** sans binding natif, avec
  « Ran all test suites » et exit 0. Diff fourni (`07_PERSISTENCE.md` §8).
- **CI** — aucun cliquet (couverture, contrat WS, licences), aucun build Docker ni Vite,
  porte `npm audit` à `critical` alors que les 3 `high` sont `fixAvailable`. Workflow
  complet à 11 jobs proposé dans `14_DOCS_RELEASE.md`.
- **F-11** — la CSP est **déployable aujourd'hui** : 0 violation imputable à la SPA,
  mesuré en Chromium. Seuls 2 blocs inline et 107 `onclick` restent à traiter.
- **F-09** — supprimer `MidiMessage.js` (467 lignes mortes). Ce faux parseur complet a
  masqué **deux fois** le même bug de parité transport (F-08 puis F-38).

---

## Vague 6 — ce que seul un humain devant le matériel peut faire

`15_HARDWARE_QA_CHECKLIST.md` : **106 vérifications, 12 sessions**, ordonnées par coût
matériel — palier 0 (Pi seul), palier 1 (un câble : boucle USB, fil GPIO14→15, smartphone
BLE), palier 2 (orchestre). Chaque point porte un critère mesurable, son moyen de mesure
avec les outils du dépôt, et quoi capturer en cas d'échec.

**Trois pièges neutralisés en amont**, sans quoi des sessions entières auraient été
invalidées silencieusement : `/api/health` qui mentait (corrigé), le réglage temps réel
qui n'atteint pas le processus sous systemd, et `ble.scanDuration` ignoré.

> ⚠️ Ne lancer la session lumière qu'après R17 (F-28), et les sessions de latence
> qu'après R5 (F-130) : sinon les mesures portent sur un système qu'on sait fautif.
