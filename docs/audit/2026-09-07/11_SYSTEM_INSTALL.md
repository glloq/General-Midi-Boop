# 11 — Système Pi, installation, mise à jour, offline-first (lot L11)

**Date :** 2026-09-07 · **Base :** `00_BASELINE.md` (commit `8dc170e`, v0.8.1)
**Environnement :** Linux x86_64, Node v22.22.2, Docker 29.3.1 disponible,
**pas de Raspberry Pi**, pas d'ALSA, pas de D-Bus, pas de `nmcli`, pas de
matériel MIDI.
**Sections couvertes :** B01–B05, AD, AE, AF, AG.

---

## Verdict — « ce produit démarre-t-il vraiment sur un Pi neuf et hors-ligne ? »

> ### **Non. Pas aujourd'hui.**
>
> Sur un Raspberry Pi neuf, installé avec `scripts/Install.sh` puis **débranché
> d'Internet**, la SPA **ne finit pas de se charger**. Le serveur backend, lui,
> démarre parfaitement : la promesse est cassée **côté navigateur**, à la
> ligne 6011 de `public/index.html`.
>
> Le mécanisme n'est pas un cas limite, c'est le **chemin nominal** :
>
> 1. `Install.sh` lance `npm run build` ; le service systemd pose
>    `NODE_ENV=production` ; `HttpServer.js:274` sert donc **`dist/`**.
> 2. `vite.config.js` ne recopie que `js`, `locales`, `assets`, `styles` dans
>    `dist/` — **jamais `lib/`**. Le player WebAudioFont vendorisé au
>    `postinstall` **n'atteint jamais la production**, même quand son
>    téléchargement a parfaitement réussi.
> 3. `dist/lib/WebAudioFontPlayer.js` étant absent, le repli SPA d'Express
>    (`app.get('*')`) répond **HTTP 200 + `text/html` + 615 825 octets**
>    (mesuré) : le navigateur reçoit `index.html` en guise de script, échoue à
>    le parser, et `WebAudioFontPlayer` reste `undefined`.
> 4. La garde `if (typeof WebAudioFontPlayer === 'undefined')` est donc
>    **toujours vraie**, et `document.write('<script src="https://surikov.github.io/…">')`
>    s'exécute — un chargement **synchrone, bloquant pour l'analyseur HTML**,
>    vers un CDN qu'un Pi hors-ligne ne peut pas joindre.
> 5. **174 des 191** balises `<script src>` de la page sont situées **après**
>    ce point (mesuré) : l'application entière attend derrière une requête qui
>    n'aboutira jamais.
>
> Autrement dit : la seule chose qui rendait la promesse « offline-first »
> vérifiable — la vendorisation locale de l'asset — est **annulée deux fois**
> (une fois par `--ignore-scripts`/`CI=true`, une fois par `vite.config.js`),
> et le filet de sécurité prévu pour ce cas est précisément ce qui bloque le
> démarrage.
>
> **Et le déploiement Docker documenté dans `docs/INSTALLATION.md` §Docker
> Deployment ne démarre pas non plus** — pour trois raisons indépendantes,
> toutes prouvées ci-dessous (§3).
>
> **Ce qui marche, en revanche :** le backend est sobre et robuste. Zéro appel
> réseau sortant au runtime, reprise après `kill -9` **impeccable** (§6),
> surcharges d'environnement correctement validées, surface de commande du
> hotspot sans injection possible. Le défaut n'est pas dans le cœur : il est
> **entièrement dans la chaîne d'empaquetage et de livraison**, qui n'a jamais
> été exécutée par personne — ni en CI, ni dans les audits précédents.

---

## 1. Synthèse

| § | Sujet | État | Niv. | Finding |
|---|---|---|---|---|
| **AG** | **Offline-first au démarrage de la SPA** | **FAIL** | **4** | **F-14 (aggravé), F-119** |
| AG | Offline-first au runtime (backend, assets) | PASS | 4 | — |
| **B04** | **Build Docker** | **FAIL** | **5** | **F-118** (+ L14 F-157) |
| B04 | Cohérence `docker-compose.yml` ↔ `Dockerfile` | PARTIAL | 3 | F-118 |
| **AF** | **Mise à jour en place (`update.sh`)** | **FAIL** | **3** | **F-120, F-121, F-122** |
| AF | `/api/update-status` (public par conception) | **FAIL** | 4 | **F-122** |
| B01 | Installation propre sur Pi OS | HW REQUIRED | 2 (relecture) | F-127 |
| B02 | Dépendances natives / `--ignore-scripts` | PARTIAL | 4 | F-118 |
| B03 | PM2 / systemd / démarrage au boot | PARTIAL | 2 | F-127 |
| **B05** | **Superposition de configuration** | **PARTIAL** | **4** | **F-126** |
| **AE** | **Hotspot / portail captif** | **PARTIAL** | **3** | **F-123 (corrigé), F-124, F-125** |
| **C03** | **Reprise après crash (`kill -9`)** | **PASS** | **4** | — |
| AD | Plateforme Pi (CPU, thermique, GPIO, ALSA…) | HW REQUIRED | 0 | — |

**Findings ouverts par ce lot : 9** (dont **2 P1**), **1 corrigé** (F-123).

| # | Sev | Titre |
|---|---|---|
| **F-118** | **P1** | Docker : `npm ci --ignore-scripts` prive l'image de tout binding `better-sqlite3` — le conteneur ne démarre pas, même après le correctif des `COPY` |
| **F-119** | P2 | Un asset statique manquant renvoie **200 + le shell SPA** au lieu de 404 : la garde `typeof … === 'undefined'` est inévitablement vraie, le repli CDN est inconditionnel |
| **F-120** | **P1** | `update.sh` : **aucun rollback**. Une fois `git pull` réussi, tout échec ultérieur n'est qu'un avertissement ; une coupure au mauvais moment laisse une installation non démarrable |
| **F-121** | P2 | `update.sh` remise silencieusement (`git stash`) les fichiers **suivis** modifiés — dont `config.json` : toute personnalisation opérateur est perdue à chaque mise à jour |
| **F-122** | P2 | `/api/update-status` : public **et permanent**, relit **tout** `update.log` à chaque requête, et divulgue chemins, branche, journal git, IP LAN, état PM2/systemd et jusqu'à 20 lignes de journal applicatif |
| **F-123** | P2 | `HotspotManager` prenait l'enveloppe `{"success":false}` de `hotspot.sh` pour un succès → hotspot déclaré actif après échec `nmcli`, portail captif allumé à tort — **CORRIGÉ ici (rouge→vert)** |
| **F-124** | P3 | `hotspot.sh wifi-scan` tronque silencieusement tout SSID contenant `:` et ramène son signal à 0 — entrée contrôlée par un AP voisin |
| **F-125** | P2 | `wifi_forget` accepte n'importe quel nom de profil NetworkManager : un client autorisé peut supprimer `Wired connection 1` et couper le Pi du réseau |
| **F-126** | P2 | `config.json` n'est **jamais validé** (les validateurs ne vivent que dans `set()`) ; un fichier malformé retombe **silencieusement** sur les valeurs par défaut, dont le chemin de base de données |
| **F-127** | P3 | `Install.sh` : `read -p` sous `set -e` avorte l'installation non interactive ; `npm prune` annulé à la première mise à jour ; aucune vérification des assets téléchargés ; l'unité systemd ignore tous les réglages d'`ecosystem.config.cjs` et ne lit pas `.env` |

**Re-statut du finding délégué :**

| # | Statut | Preuve |
|---|---|---|
| **F-14** | **CONFIRMÉ OUVERT — et AGGRAVÉ** | Le repli n'est pas un chemin de secours rare : c'est le comportement par défaut de toute installation de production (§2). Sévérité relevée de **P2 à P1** : c'est la promesse centrale du produit. |

**Nouveaux tests livrés (46 tests, tous verts) :**

```
tests/audit/l11-offline-first.test.js     8 tests  (caractérisation F-14 / F-119)
tests/audit/l11-packaging.test.js        10 tests  (caractérisation B03/B04)
tests/audit/l11-config-fuzz.test.js      13 tests  (B05 — 6 PASS réels, 7 caractérisation)
tests/audit/l11-hotspot-manager.test.js  10 tests  (AE — rouge→vert sur F-123)
```

**Correctif appliqué :** `src/system/HotspotManager.js` (+30 / −3), F-123.

---

## 2. §AG — Offline-first : le verdict détaillé (F-14, F-119)

### 2.1 Le runtime est propre — c'est acquis

L'audit du 2026-08-22 avait déjà établi qu'aucune URL externe ne subsiste dans
`public/**` hors les deux placeholders et le repli CDN. Vérifié à nouveau : le
backend n'émet **aucune** requête sortante au démarrage ni en fonctionnement
(serveur vivant port 8111, journaux complets — aucun `http`/`https` sortant).
La discipline est réelle. Le problème est **exclusivement** au chargement de la
page.

### 2.2 Les quatre déclencheurs du chemin de repli

`public/index.html:6008-6013` :

```html
<script src="lib/WebAudioFontPlayer.js"></script>
<script>
  if (typeof WebAudioFontPlayer === 'undefined') {
    document.write('<scr' + 'ipt src="https://surikov.github.io/webaudiofont/npm/dist/WebAudioFontPlayer.js"><' + '/scr' + 'ipt>');
  }
</script>
```

`public/lib/WebAudioFontPlayer.js` n'est **pas versionné** (`.gitignore:70`) ;
il est téléchargé par `scripts/install-default-sf2.js` (`postinstall`).
Il est absent — donc le repli s'exécute — dans **quatre** situations, dont
trois sont des chemins *documentés* ou *nominaux* :

| # | Condition | Statut |
|---|---|---|
| 1 | `npm install --ignore-scripts` | **Chemin documenté par `CLAUDE.md`** pour les conteneurs/CI. C'est exactement l'état de l'arbre d'audit aujourd'hui : `public/lib/` **n'existe pas**. |
| 2 | `CI=true` / `CI=1` | `install-default-sf2.js:81` court-circuite **tout** téléchargement. Aucun artefact CI ne contient donc l'asset. |
| 3 | Téléchargement échoué (4 miroirs) | Non fatal, `exit 0`, simple `WARN` sur stderr. `Install.sh` passe `--silent` à `npm ci` et **ne vérifie jamais** que le fichier est arrivé. |
| 4 | **Build de production Vite** | **Le cas décisif — nouveau.** Même quand 1→3 se sont bien passés, `dist/` ne contient pas `lib/`. |

### 2.3 Le cas décisif : `dist/` annule la vendorisation (F-14 aggravé)

`vite.config.js:19` :

```js
const dirs = ['js', 'locales', 'assets', 'styles'];   // ← 'lib' absent
```

`src/api/HttpServer.js:271-274` :

```js
const distPath = path.join(__dirname, '../../dist');
const publicPath = isProduction && existsSync(path.join(distPath, 'index.html')) ? distPath : devPath;
```

`scripts/Install.sh:194` lance `NODE_ENV=production npm run build`, et l'unité
systemd écrite par `Install.sh:439` pose `Environment=NODE_ENV=production`.
**Toute installation faite selon la procédure officielle sert donc `dist/`, qui
ne peut pas contenir `lib/`.** Le repli CDN est le comportement **par défaut de
la production**, pas un filet de secours.

> Corroboré indépendamment par le lot **L14 (F-157)**, qui a mesuré la même
> lacune côté `dist/` sans passer par le chemin `index.html`.

### 2.4 F-119 — le fichier manquant renvoie 200, pas 404

Mesuré sur serveur vivant (port 8111) **et** dans le conteneur Docker réparé :

```
$ curl -o /dev/null -w "HTTP %{http_code} type=%{content_type} size=%{size_download}\n" \
       http://127.0.0.1:8111/lib/WebAudioFontPlayer.js
HTTP 200 type=text/html; charset=UTF-8 size=615825
```

Le repli SPA `this.expressApp.get('*', …)` (`HttpServer.js:288`) renvoie
`index.html` pour **tout** chemin non résolu, y compris les `.js`, `.css` et
`.map`. Trois conséquences :

1. Le navigateur reçoit 615 Ko de HTML là où il attend du JavaScript → erreur
   de syntaxe → le global reste `undefined` → **le repli CDN est inconditionnel**.
2. Aucun `404` n'apparaît jamais dans les journaux : le défaut est **invisible
   à l'exploitation**.
3. C'est la variante « assets statiques » de **F-10** (`/api/*` inconnu → 200 +
   SPA), instruit par L01 sur la surface API.

### 2.5 Ce qui se passe ensuite : blocage puis application inutilisable

- **Blocage.** `document.write` d'une balise `<script>` pendant l'analyse
  **suspend l'analyseur HTML** jusqu'à résolution de la ressource. Aucun des
  174 scripts suivants n'est même *demandé* tant que la requête n'a pas
  abouti ou échoué.
- **Durée.** *Non mesurée ici* — la pile réseau du bac à sable rejette
  immédiatement (mesure : `elapsed=0,010 s` sur une adresse TEST-NET, DNS
  `elapsed=0,009 s`), ce qui n'est **pas** représentatif d'un Pi hors-ligne.
  Bornes attendues, dérivées des paramètres du système cible :
  `tcp_syn_retries=6` → ~127 s pour un SYN dans le vide (gateway qui *drop*,
  cas typique d'un hotspot sans uplink) ; `options timeout:2 attempts:3` sur
  deux serveurs → ~12 s si le DNS ne répond pas ; ~0 s si le DNS répond
  NXDOMAIN. **Le pire cas réaliste — Pi en mode hotspot, clients associés,
  aucun uplink — est le cas *drop*, soit environ deux minutes d'écran blanc.**
  La mesure navigateur incombe à **L08**.
- **Après le déblocage.** La page finit par se charger, mais dans un état
  incohérent : la balise injectée par `document.write` a échoué, donc
  `WebAudioFontPlayer` reste `undefined`. `MidiSynthesizer.js:731` lève
  `Error('WebAudioFontPlayer not loaded')` — **la dégradation gracieuse existe
  déjà**. Le repli CDN n'apporte donc **aucune robustesse** : il ne fait
  qu'ajouter un point de blocage réseau devant une application qui savait déjà
  se passer de l'asset.

### 2.6 Correctif proposé pour F-14 (diff — **non appliqué**, `public/index.html` est partagé)

Trois modifications, dans trois fichiers, toutes petites. La n°1 est le
correctif de fond ; les n°2 et 3 sont indispensables pour qu'il serve à
quelque chose.

**1. `public/index.html` — supprimer le repli bloquant, dégrader explicitement**

```diff
--- a/public/index.html
+++ b/public/index.html
@@
-    <!-- WebAudioFont Library (SoundFont player). Loaded from the local
-         vendored copy first (created by scripts/install-default-sf2.js),
-         with a synchronous CDN fallback so installs that never ran the
-         postinstall still get audio. The fallback uses document.write to
-         keep the load synchronous — every script that follows depends on
-         `WebAudioFontPlayer` being defined globally. -->
-    <script src="lib/WebAudioFontPlayer.js"></script>
-    <script>
-      if (typeof WebAudioFontPlayer === 'undefined') {
-        document.write('<scr' + 'ipt src="https://surikov.github.io/webaudiofont/npm/dist/WebAudioFontPlayer.js"><' + '/scr' + 'ipt>');
-      }
-    </script>
+    <!-- WebAudioFont Library (SoundFont player), vendorisée localement par
+         scripts/install-default-sf2.js. AUCUN repli réseau : l'appareil est
+         offline-first, un Pi hors-ligne ne peut joindre aucun CDN et un
+         chargement bloquant y gèle le rendu de toute la page (audit L11
+         F-14). Le seul consommateur, MidiSynthesizer, sait déjà se passer
+         du global : on se contente donc de tracer l'absence pour que
+         l'opérateur sache quoi faire.
+         `onerror` couvre aussi le cas où le serveur renvoie le shell SPA
+         (HTTP 200 text/html) au lieu du script — voir F-119. -->
+    <script src="lib/WebAudioFontPlayer.js"></script>
+    <script>
+      if (typeof WebAudioFontPlayer === 'undefined') {
+        window.__GMBOOP_AUDIO_PREVIEW_UNAVAILABLE__ =
+          'lib/WebAudioFontPlayer.js absent ou invalide — relancez ' +
+          '`npm run install-default-sf2` puis `npm run build`. ' +
+          "L'aperçu audio est désactivé ; le reste de l'application fonctionne.";
+        console.warn('[GMBoop] ' + window.__GMBOOP_AUDIO_PREVIEW_UNAVAILABLE__);
+      }
+    </script>
```

*(Le drapeau global permet à la vue Réglages/Diagnostic d'afficher un bandeau
explicite plutôt que de laisser l'utilisateur découvrir le problème au premier
clic sur « écouter ». Le message reste en clair côté console même sans UI.)*

**2. `vite.config.js` — faire suivre `lib/` dans `dist/` (sinon le correctif n°1 casse la production)**

```diff
-  const dirs = ['js', 'locales', 'assets', 'styles'];
+  // 'lib' contient le player WebAudioFont vendorisé au postinstall. Sans lui,
+  // dist/ (servi en production par HttpServer.js:274) n'a jamais l'asset et
+  // l'aperçu audio est mort sur TOUTE installation de production (L11 F-14).
+  const dirs = ['js', 'locales', 'assets', 'styles', 'lib'];
```

**3. `src/api/HttpServer.js` — ne plus servir le shell SPA pour un asset (F-119)**

```diff
     // Fallback to index.html for SPA
     this.expressApp.get('*', (req, res) => {
+      // Un chemin qui porte une extension de fichier est un ASSET, pas une
+      // route SPA : renvoyer index.html à sa place produit un HTTP 200
+      // text/html là où le navigateur attend du JS/CSS, ce qui transforme un
+      // fichier manquant en échec silencieux (audit L11 F-119).
+      if (/\.[a-z0-9]{2,5}$/i.test(req.path)) {
+        return res.status(404).type('text/plain').send('Not found');
+      }
       res.sendFile(path.join(publicPath, 'index.html'));
     });
```

**Alternative envisagée et écartée :** committer les ~120 Ko du player.
`scripts/install-default-sf2.js:54-55` indique lui-même que sa licence
« n'est pas librement redistribuable sans attribution », et **L14** relève que
cette attribution n'existe nulle part dans le dépôt. Committer l'asset règle
F-14 mais ouvre un problème de licence : à arbitrer hors audit. Le correctif
ci-dessus tient **dans les deux cas**.

**Vérification attendue après correctif** — inverser les assertions marquées
`À INVERSER` dans `tests/audit/l11-offline-first.test.js`, puis :

```bash
npm run build && for f in $(grep -oE 'src="(js|lib)/[^"]+"' dist/index.html | sed 's/src="//;s/"//'); do
  [ -f "dist/$f" ] || echo "MANQUANT: dist/$f"; done
```

---

## 3. §B04 — Build Docker : **FAIL**, trois blocages successifs (F-118)

Section **jamais tentée** par aucun audit. Docker 29.3.1 était disponible ici.
Journaux complets dans le bac à sable du lot (`logs/docker-build-*.log`).

> **Accommodation d'environnement, déclarée.** La politique d'egress de ce bac
> à sable refuse `production.cloudfront.docker.com` (403) et `deb.debian.org`
> (403). L'image de base a donc été récupérée via `mirror.gcr.io` puis
> ré-étiquetée `node:20-slim` localement, et augmentée du CA du proxy
> (`NODE_EXTRA_CA_CERTS`) pour que `npm ci` puisse valider TLS. **Le
> `Dockerfile` du dépôt n'a pas été modifié** ; les variantes testées vivent
> dans le bac à sable. La couche `apt-get install libasound2` reste
> intestable ici (403) — elle est neutre pour les conclusions ci-dessous.

### 3.1 Blocage n°1 — le build échoue (déjà établi par L14 F-157)

```
$ docker build -t gmboop-l11:test .
#16 [stage-1 10/11] COPY locales/ ./locales/
#16 ERROR: failed to calculate checksum of ref …: "/locales": not found
ERROR: failed to build: failed to solve: … "/locales": not found
real 0m0.722s   EXIT=1
```

`Dockerfile:23` copie `locales/`, qui **n'existe pas** : les locales vivent
sous `public/locales/` (déjà embarquées par `COPY public/`). **Confirmé.**

### 3.2 Blocage n°2 — `shared/` absent : crash au boot (déjà établi par L14 F-157)

Avec la ligne `COPY locales/` retirée, l'image se construit et le conteneur
meurt immédiatement :

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/shared/BinaryFrameCodec.js'
    imported from /app/src/api/WsOutputQueue.js
```

**Confirmé.** Manquent aussi, avec des conséquences moins spectaculaires mais
réelles :

| Non copié | Conséquence dans l'image |
|---|---|
| `shared/` | crash au boot (ci-dessus) + `instrument-families.json`, `gm-instrument-names.json` introuvables |
| `assets/` | aucun soundfont par défaut → `/api/sf2/default/preset/*` en 404 |
| `scripts/` | `system_update` renvoie « Update script not found or not executable » ; `hotspot.sh` absent |
| `config.json` | remplacé silencieusement par `getDefaultConfig()` — la configuration livrée est ignorée |
| `LICENSE`, `README.md` | exclus par `.dockerignore` (`*.md`) — relevé par L14 |

### 3.3 Blocage n°3 — **NOUVEAU (F-118)** : aucun binding `better-sqlite3` dans l'image

Avec les cinq `COPY` corrigés, l'image se construit **et le conteneur meurt
quand même** :

```
[2026-09-07T11:13:43.123Z] ERROR Failed to start application: Could not locate the bindings file. Tried:
 → /app/node_modules/better-sqlite3/build/Release/better_sqlite3.node
 → … (14 chemins)
[…] Stopping application… === GeneralMidiBoop 0.8.1 Stopped ===
```

Cause : `Dockerfile:6` fait `npm ci --omit=dev --ignore-scripts`. Le drapeau
supprime le script `install` de `better-sqlite3`, donc **ni `prebuild-install`
ni `node-gyp`** ne s'exécutent — l'image n'a aucun binaire natif :

```
$ docker run --rm --entrypoint sh gmboop-l11:probe -c "ls node_modules/better-sqlite3/build/Release/"
ls: cannot access '…/build/Release/': No such file or directory
```

`better-sqlite3` est une **dépendance de production obligatoire** : le défaut
est structurel, pas conditionnel. Retirer simplement `--ignore-scripts` ne
suffit pas non plus — l'étage `builder` n'a ni Python ni toolchain :

```
npm error command sh -c node-gyp rebuild        (paquet: node_modules/midi)
npm error gyp ERR! find Python  You need to install the latest version of Python.
```

### 3.4 Recette minimale prouvée : l'image construit ET démarre

Le correctif minimal (testé, exécuté) est un `npm rebuild better-sqlite3`
après le `npm ci --ignore-scripts` : `prebuild-install` télécharge un binaire
pré-compilé, **sans aucune toolchain**.

```diff
--- a/Dockerfile
+++ b/Dockerfile
@@
 WORKDIR /app
 COPY package.json package-lock.json ./
-RUN npm ci --omit=dev --ignore-scripts
+# --ignore-scripts évite node-gyp (pas de toolchain dans cet étage) mais
+# prive AUSSI better-sqlite3 de son binding : sans le rebuild ciblé
+# ci-dessous, le conteneur meurt au boot sur « Could not locate the
+# bindings file » (audit L11 F-118). `npm rebuild` passe par
+# prebuild-install : un binaire pré-compilé, aucune compilation.
+RUN npm ci --omit=dev --ignore-scripts \
+ && npm rebuild better-sqlite3
@@
-RUN apt-get update && apt-get install -y --no-install-recommends \
-    libasound2 \
-    && rm -rf /var/lib/apt/lists/*
+# libasound2 n'a d'utilité que si le module natif `midi` est compilé — ce
+# que --ignore-scripts empêche. Tant que l'image ne bâtit pas easymidi,
+# cette couche est inutile (~30 Mo). Pour un vrai support USB MIDI en
+# conteneur : ajouter build-essential + python3 + libasound2-dev dans
+# l'étage builder, retirer --ignore-scripts, et garder libasound2 ici.
@@
 COPY migrations/ ./migrations/
-COPY locales/ ./locales/
+# `shared/` est importé par src/api/WsOutputQueue.js : sans lui le
+# conteneur ne démarre pas. `locales/` n'existe pas à la racine (les
+# locales sont sous public/locales/, déjà copiées ci-dessus).
+COPY shared/ ./shared/
+COPY assets/ ./assets/
+COPY scripts/ ./scripts/
+COPY config.json ./
```

**Résultat mesuré avec ce Dockerfile :**

```
$ docker build …                 -> EXIT=0, real 0m11.4s (à chaud) / ~1 min 15 s (à froid)
$ docker images                  -> 456 MB
$ docker run -d …                -> Up
$ curl http://<ip>:8080/api/health
{"status":"ok","version":"0.8.1","capabilitiesOverall":"degraded",
 "capabilities":{"database":{"status":"ready"},"playback":{"status":"ready"},
  "usb":{"status":"failed","detail":"Native MIDI library unavailable …"},
  "ble":{"status":"failed","detail":"D-Bus system bus not available"}, …}}
$ curl -o /dev/null -w "%{http_code} %{content_type}" http://<ip>:8080/
200 text/html
```

Le `/api/health` corrigé par **L12** se comporte exactement comme il faut ici :
`usb` et `ble` s'annoncent `failed` avec leur cause. Un opérateur voit
immédiatement ce que le conteneur ne peut pas faire — c'est la bonne
sémantique.

Reste vrai dans l'image ainsi réparée : `/lib/WebAudioFontPlayer.js` répond
**HTTP 200 `text/html` 615 825 octets** (F-119) — le déploiement Docker est
donc soumis au même blocage offline que l'installation Pi.

### 3.5 Cohérence `docker-compose.yml`

| Point | Verdict |
|---|---|
| Ports, volumes (`data`/`logs`/`backups`), `restart: unless-stopped`, rotation des journaux | **cohérents** avec le `Dockerfile` |
| `GMBOOP_API_TOKEN` optionnel avec avertissement en commentaire | correct, mais l'image ne peut **pas** générer de token : `ApiTokenManager` écrit `.env` à la racine, or `/app` appartient à `appuser` — ça passe, mais le token change à **chaque recréation de conteneur** (`.env` n'est pas dans un volume) → tous les clients sont invalidés à chaque `docker compose up --force-recreate` |
| `deploy.resources.limits.memory: 512M` **vs** `ENV NODE_HEAP_MB=512` | **incohérent** : le plafond de tas V8 égale la limite mémoire du conteneur. RSS = tas V8 + tas natif (better-sqlite3, ws, zlib) + code + piles → l'OOM-killer arrive **avant** que V8 ne déclenche son GC final. Recommandation : `NODE_HEAP_MB=320` pour une limite de 512 M, ou remonter la limite à 768 M. |
| Aucun volume pour `dist/` ni `public/lib/` | conforme au design (immuables), mais scelle F-14 dans l'image |
| Aucun `devices:`/`group_add` pour ALSA ou série | le MIDI matériel est structurellement hors de portée de ce `compose` — à documenter comme tel |

---

## 4. §AF — Mise à jour en place : **FAIL** (F-120, F-121, F-122)

`scripts/update.sh` (519 lignes) relu ligne à ligne, croisé avec
`SystemCommands.systemUpdate()` (`src/api/commands/SystemCommands.js:404-597`).
`src/api/commands/SystemCommands.js` reste à **19 % de couverture**.

### 4.1 Ordre réel des opérations

```
1. status "started"
2. git diff-index --quiet HEAD   → si sale : git stash push        (F-121)
3. sleep 3                        (laisse la réponse WS partir)
4. status "pulling"  → git checkout main (si besoin) → git fetch → git pull
                                   ↑ SEUL point où un échec avorte proprement
5. status "installing" → npm install            (échec = simple WARN)
6. npm run build (vite)                          (échec = simple WARN)
7. npm run migrate                               (échec = simple WARN)
8. status "restarting" → _restart_server         (4 stratégies en cascade)
9. status "verifying" → port ? HTTP 200 ? → status "done"
```

**Le code est remplacé à l'étape 4, les migrations tournent à l'étape 7, le
redémarrage à l'étape 8.** Entre 4 et 8 — soit plusieurs minutes sur un Pi —
**l'ancien processus continue de tourner avec l'ancien code** sur un disque
qui porte déjà le nouveau, puis sur une base **déjà migrée**. La fenêtre
« ancien code / nouveau schéma » est réelle et non gardée. Elle est atténuée
par le fait que les migrations sont additives, mais rien ne l'impose.

### 4.2 F-120 (P1) — aucun rollback, nulle part

`abort_and_restart()` (ligne 83) n'existe **que** pour les échecs **antérieurs**
au `git pull`. Après un pull réussi :

| Échec | Traitement | Conséquence |
|---|---|---|
| `npm install` | `print_warning "…continuing with existing dependencies"` (l. 371) | **Nouveau code, anciennes dépendances.** Un `import` d'un paquet ajouté par la mise à jour → crash au boot → `Restart=always` + `RestartSec=10` → **boucle de redémarrage infinie**. |
| `npm run build` | WARN (l. 382) | `dist/` reste l'**ancien** front, servi à côté du nouveau backend → incohérences de contrat WS silencieuses |
| `npm run migrate` | `2>/dev/null \|\| print_warning` (l. 393) — **la sortie d'erreur est jetée** | Schéma partiel, cause invisible |
| redémarrage | 4 stratégies, puis « Manual intervention required » | — |

Il n'existe **aucun** `git reset --hard <ancien HEAD>`, aucune sauvegarde du
`HEAD` d'origine, aucune sauvegarde de `node_modules`, **et aucune sauvegarde
de la base avant migration**. L'exigence du plan — *« une mise à jour ne doit
jamais rendre l'installation irrécupérable »* — **n'est pas tenue**.

**Coupure de courant au milieu — analyse par étape :**

| Instant | État après redémarrage |
|---|---|
| pendant `git pull` | Arbre de travail **partiellement mis à jour** (le checkout n'est pas atomique) et, très probablement, `.git/index.lock` résiduel → **toute** commande git échoue ensuite : `system_check_update` KO, `update.sh` KO, réparation manuelle en SSH obligatoire. **C'est le pire cas, et c'est aussi la fenêtre la plus longue sur un Pi.** |
| pendant `npm install` | `node_modules` à moitié écrit (npm n'est atomique ni par paquet ni globalement) → serveur non démarrable → boucle systemd |
| pendant `npm run build` | `dist/` incomplet mais `dist/index.html` peut exister → **la production sert un front tronqué** (`existsSync(dist/index.html)` est le seul test) |
| pendant les migrations | **Le seul point sain** : chaque fichier a sa transaction, `1..N-1` restent commités et la reprise repart de N (`CLAUDE.md` §Migrations) |
| pendant le redémarrage | systemd/PM2 relancent — sans dommage |

**Correctif recommandé** (ordre de priorité) :

1. Mémoriser `PREV_HEAD=$(git rev-parse HEAD)` **avant** le pull, et
   `git reset --hard "$PREV_HEAD"` + `npm ci` dans un `trap`/chemin d'échec
   dès que `npm install`, `npm run build` **ou** `npm run migrate` échoue.
2. `system_backup` (ou `sqlite3 .backup`) **avant** `npm run migrate`.
3. Rendre l'échec de `npm install` **fatal** (avec rollback) au lieu d'un WARN.
4. Ne plus jeter la sortie de `npm run migrate` (`2>/dev/null` → journal).
5. Nettoyer `.git/index.lock` au démarrage du script s'il est orphelin.

### 4.3 F-121 (P2) — l'auto-stash mange la configuration de l'opérateur

`update.sh:264-269` :

```bash
if ! git diff-index --quiet HEAD -- 2>/dev/null; then
    git stash push -m "Auto-stash before update at $(date)" || true
```

`config.json` est un **fichier suivi**. Toute personnalisation faite sur place
— port, `database.path` vers un SSD externe, `security.mode: secure`,
`serial.enabled`, `ble.enabled` — est donc **remisée silencieusement** à chaque
mise à jour, et **jamais restaurée** (le script se contente d'afficher
« vous avez des modifications remisées » à la toute fin, dans un journal que
personne ne lit puisque la mise à jour est déclenchée depuis l'UI).

Effet concret : un Pi configuré pour écouter sur 8081 avec sa base sur
`/mnt/ssd` **revient aux valeurs d'usine après un clic sur « Mettre à jour »**,
et l'opérateur ne trouve plus son serveur. Aggravé par F-126 : rien ne signale
le changement.

**Correctif recommandé :** ajouter `config.json` (et tout fichier de
configuration livré) à `.gitattributes` en `merge=ours`, ou mieux — cesser de
suivre `config.json` et livrer `config.example.json`, la logique de repli de
`Config.loadConfig()` couvrant déjà l'absence du fichier.

### 4.4 F-122 (P2) — `/api/update-status` : ce qui fuit, et pour combien de temps

`src/api/apiRoutes.js:254-281`, exempté d'authentification par
`HttpServer.js:191-196`.

```js
const full = readFileSync(logFile, 'utf8');       // ← TOUT le fichier
const lines = full.split('\n');
logTail = lines.slice(-30).join('\n');            // ← puis on jette 99 %
res.json({ status, logTail });
```

**Trois défauts distincts :**

1. **Fuite d'information.** Les 30 dernières lignes d'`update.log` contiennent,
   selon le moment : le **chemin absolu du projet**, la branche courante, les
   **5 derniers messages de commit**, la sortie de `git status --short` (donc
   les noms des fichiers modifiés localement), la sortie de `npm install`,
   `PM2_HOME`/`NVM_DIR`, le chemin du binaire node, l'**IP LAN**
   (`hostname -I`), et — en cas d'échec de redémarrage (`update.sh:117`,
   `147`) — **20 lignes de journal applicatif via `pm2 logs`**. Aucune de ces
   informations n'est nécessaire au tableau de bord, qui n'a besoin que de
   `status`.
2. **Permanence.** Ni `update.sh` ni `SystemCommands` ne suppriment
   `logs/update-status` ni `logs/update.log` à la fin. L'endpoint continue donc
   de servir le journal de la **dernière** mise à jour **indéfiniment**, bien
   après que la fenêtre de sondage soit close. « Public *pendant* la mise à
   jour » est le design ; « public *pour toujours* » est le comportement.
3. **Amplification non authentifiée.** Le fichier entier est relu **à chaque
   requête** — alors que `SystemCommands.systemLogs()` a été explicitement
   durci contre exactement ce risque (`LOG_TAIL_MAX_BYTES = 2 Mo`,
   lecture par `readSync` de la queue, commentaire *« audit A2 M3 »*). La sortie
   de `npm install` sur un Pi se compte en méga-octets. Un client anonyme peut
   donc faire relire ce fichier en boucle : sur un Pi 3, c'est une dégradation
   de service triviale à monter, et le chemin MIDI est temps-réel.

**Correctif recommandé** (diff prêt, hors périmètre d'écriture de L11) :

```diff
--- a/src/api/apiRoutes.js
+++ b/src/api/apiRoutes.js
@@
-  // Update status (public — no auth, used by frontend during update)
+  // Update status (public — no auth, used by frontend during update).
+  // Public veut dire MINIMAL : le tableau de bord n'a besoin que de l'état.
+  // Le journal contient chemins absolus, historique git, IP LAN et jusqu'à
+  // 20 lignes de journal applicatif (audit L11 F-122) : il exige le token.
   router.get('/update-status', (_req, res) => {
     const projectRoot = join(__dirname, '../..');
     const statusFile = join(projectRoot, 'logs', 'update-status');
-    const logFile = join(projectRoot, 'logs', 'update.log');
-
     let status = null;
-    let logTail = null;
-
     if (existsSync(statusFile)) {
       try {
-        status = readFileSync(statusFile, 'utf8').trim();
+        // Premier jeton seulement : "started" | "pulling" | "installing" |
+        // "restarting" | "verifying" | "done" | "failed".
+        status = readFileSync(statusFile, 'utf8').trim().split(/\s+/)[0].replace(':', '');
       } catch {
         /* ignore */
       }
     }
-
-    if (existsSync(logFile)) {
-      try {
-        const full = readFileSync(logFile, 'utf8');
-        const lines = full.split('\n');
-        logTail = lines.slice(-30).join('\n');
-      } catch {
-        /* ignore */
-      }
-    }
-
-    res.json({ status, logTail });
+    res.json({ status });
   });
```

…et déplacer le `logTail` derrière `system_logs` (déjà authentifié et déjà
borné en mémoire). Le front (`public/js/features/settings/SettingsUpdate.js:225`)
doit alors lire le journal via la commande WS authentifiée.

### 4.5 Autres constats sur le chemin de mise à jour

| Constat | Sévérité | Détail |
|---|---|---|
| `sudo -n systemctl restart gmboop` (`update.sh:123`) | inclus dans **F-127** | `Install.sh` n'installe **aucune** règle sudoers pour `systemctl` (seulement `hciconfig`, `rfkill`, `hotspot.sh`) : la stratégie systemd **échoue toujours** sur une installation standard, et le script retombe sur « tuer par port + `node` nu ». Le service redémarre alors **hors** de systemd — plus de `Restart=always`, plus de journal, et le prochain reboot repart sur l'unité. |
| Repli « tuer par port » (`update.sh:165-171`) | P3 | `lsof -ti:$SERVER_PORT \| xargs -r kill -9` tue **n'importe quel** processus détenant ce port, y compris une autre application. |
| Détection PM2 par `grep -q "online.*gmboop"` | P3 | dépend de l'ordre des colonnes de `pm2 list`. |
| Vérification finale | P3 | teste qu'*un* serveur écoute et répond 200 — **pas** que la nouvelle version tourne. Un rollback silencieux passerait pour un succès. |
| Course d'arrêt | P3 | le poller de `systemUpdate` (`SystemCommands.js:580-591`) fait `process.exit(0)` 2 s après avoir vu `restarting`, pendant que `_restart_server` redémarre déjà. Bénin sous PM2, bruyant partout. |
| `system_update` / `system_restore` / `system_reboot` | rappel **F-03** | gardés par `requireTokenConfigured()` — bon — mais **sans schéma de payload** : `system.schemas.js` ne déclare que `system_backup`. |
| `systemBackup`/`systemRestore` utilisent `resolve('./backups')` | P3 | résolution **relative au cwd**, alors que `BackupScheduler` utilise `path.join(__dirname, '../../backups')`. Les deux coïncident tant que le cwd est la racine du projet ; ils divergent dès qu'il ne l'est pas. À aligner sur `PROJECT_ROOT`, déjà défini dans le fichier. |

---

## 5. §AE — Hotspot et portail captif (F-123 corrigé, F-124, F-125)

`src/system/HotspotManager.js` était à **5,6 %** de couverture et **n'avait
aucun test** : la surface avait été *relue* en août, **jamais exécutée**.
10 tests livrés (`tests/audit/l11-hotspot-manager.test.js`), `child_process`
remplacé par une doublure en mémoire — **aucun `sudo`, aucun `nmcli`, aucun
état hôte touché**.

### 5.1 Ce qui est bon, et maintenant prouvé

- `execFile('sudo', ['-n', SCRIPT_PATH, ...args])` : **tableau argv, pas de
  shell**. Un SSID `"; rm -rf / #` reste **un seul argument** (test).
- `-n` évite le blocage sur une invite de mot de passe ; l'indice
  « sudoers rule missing » est bien émis (test).
- `timeout: 20000` et `maxBuffer: 64 Ko` sont appliqués (test).
- Le verrou `_busy` refuse bien une seconde activation concurrente (test).
- Une sortie non-JSON lève au lieu de produire un état faux (test).
- **Nuance sur la remarque d'août** (« ajouter `--` avant les arguments
  utilisateur ») : `sudo` cesse d'interpréter les options au premier argument
  non-option (le chemin du script), et `hotspot.sh` lit ses arguments en
  positionnels `${1:-}` sans `getopts`. Un SSID commençant par `-` n'est donc
  **pas** interprété comme une option. La recommandation reste bonne pour la
  défense en profondeur, mais **ce n'est pas une vulnérabilité**.

### 5.2 F-123 (P2) — **CORRIGÉ ici** : `{"success":false}` passait pour un succès

`_runScript()` rattrapait le code de sortie non nul de `hotspot.sh`, parsait
l'enveloppe d'erreur JSON… et la **renvoyait comme une valeur de succès** :

```js
const parsed = this._tryParse(stdout);
if (parsed) return parsed;          // ← même quand parsed.success === false
```

Aucun appelant ne testait `res.success`. Conséquences mesurées (tests rouges
avant correctif) :

- `enable()` échouant sur `nmcli connection up` posait quand même
  `this._active = true` et journalisait « Hotspot enabled » ;
- or `isActive()` **pilote le middleware de portail captif**
  (`src/api/middleware/captivePortal.js:73`) : l'appareil se met alors à
  **détourner les sondes de portail captif** (`/generate_204`,
  `/hotspot-detect.html`, `/ncsi.txt`…) de **tous** les clients du LAN, alors
  qu'il est resté un simple client WiFi. Sur un réseau de scène partagé, c'est
  un comportement hostile visible par tous ;
- `wifiConnect()` journalisait « Connected to WiFi "X" » après un échec ;
- `status()` renvoyait `hotspotActive:false` quand la vraie réponse était
  « nmcli n'est pas installé » — indiscernables.

**Correctif appliqué** (`src/system/HotspotManager.js`, +30 / −3) : un garde
`_assertOk()` sur les **deux** chemins de retour de `_runScript()`. Les
charges utiles sans champ `success` passent inchangées (compatibilité).

```
AVANT : Tests: 4 failed, 6 passed, 10 total
APRÈS : Tests: 10 passed, 10 total
```

### 5.3 F-124 (P3) — `wifi-scan` corrompt les SSID contenant `:`

`scripts/hotspot.sh` copié dans le bac à sable et exécuté avec un `nmcli`
**bouchon** (jamais le vrai) :

```
$ PATH=<sandbox>/hsbin:$PATH bash hotspot-copy.sh wifi-scan
{"success":true,"networks":[
  {"ssid":"Chez Moi","security":"WPA2","signal":71,"active":true},
  {"ssid":"Reseau","security":" Salle","signal":0,"active":false},      ← « Reseau: Salle »
  {"ssid":"Cafe \"Chez Jo\"","security":"WPA2","signal":40,"active":false},
  {"ssid":"Voisin\\","security":"Wifi","signal":0,"active":false}]}     ← « Voisin:Wifi »
+ hotspot.sh: line 151: printf: B:WPA2:55: invalid number  (sur stderr)
```

`while IFS=: read -r in_use ssid security signal` découpe sur `:` — y compris
sur le `\:` que `nmcli -t` produit pour échapper un `:` littéral dans un SSID.
Le JSON **reste syntaxiquement valide**, donc rien n'échoue : le SSID est
**silencieusement tronqué**, le champ `security` reçoit la fin du nom, et
`signal` tombe à **0** (le `printf '%d'` échoue et écrit sur stderr).
L'entrée est **contrôlée par un point d'accès voisin**. Même famille de
problème : `json_escape()` (l. 34-38) n'échappe pas les caractères de contrôle
(`\b`, `\f`, ``…), ce qui produirait cette fois un JSON **invalide** et
donc un `hotspot.sh produced unparseable output`.

**Correctif recommandé :** `nmcli -t --escape no …` (nmcli ≥ 1.12) ou un
découpage qui respecte l'échappement (`read` sur `IFS=` puis `sed`
`s/\\\\:/\x01/g` avant le split) ; et une `json_escape` qui traite `\u00XX`.

### 5.4 F-125 (P2) — `wifi_forget` peut supprimer n'importe quel profil réseau

`hotspot.sh:206-216` refuse uniquement le nom du profil hotspot ; le schéma
`wifi_forget` (`schemas/hotspot.schemas.js:71-79`) n'exige qu'une chaîne non
vide. La commande exécute donc `nmcli connection delete "<n'importe quoi>"` en
root, ce qui couvre les profils **filaires** (`Wired connection 1`), le profil
`preconfigured` de Raspberry Pi OS, et tout profil VPN/pont.

Chemin d'exploitation : en mode `trusted-lan` (le défaut), un client du LAN
contourne le token (bypass même-origine / RFC1918 — arbitrage documenté,
instruit par **L10**) ; deux commandes suffisent alors pour supprimer le profil
Ethernet **et** le profil WiFi client, laissant le Pi **injoignable jusqu'à une
intervention clavier-écran**. Sur un appareil sans écran, c'est irrécupérable
à distance.

**Correctif recommandé :** restreindre `wifiForget` aux profils réellement
listés par `wifi-saved` (donc `802-11-wireless`, hotspot exclu) — le filtre
existe déjà dans `cmd_wifi_saved`, il suffit de l'appliquer aussi dans
`cmd_wifi_forget` :

```diff
--- a/scripts/hotspot.sh
+++ b/scripts/hotspot.sh
@@ cmd_wifi_forget()
   if [ "$ssid" = "$HOTSPOT_NAME" ]; then
     emit_error "refusing to forget the hotspot profile"
   fi
+  # Ne jamais supprimer autre chose qu'un profil WiFi client : sans ce
+  # filtre, `wifi_forget` supprime « Wired connection 1 » et coupe le Pi
+  # du réseau sans recours (audit L11 F-125).
+  nmcli -t -f NAME,TYPE connection show 2>/dev/null \
+    | awk -F: -v n="$ssid" '$1==n && $2=="802-11-wireless" {found=1} END{exit !found}' \
+    || emit_error "'$ssid' is not a saved WiFi profile"
   nmcli connection delete "$ssid" >/dev/null 2>&1 \
```

### 5.5 Non testé (reste HW)

Activation/désactivation réelles, portail captif de bout en bout, persistance
au reboot, conflit avec une connexion WiFi cliente existante, comportement de
`_bootstrapState()` (appel « au mieux » non attendu dans le constructeur : si
`status()` échoue, `_active` reste `false` jusqu'au prochain appel explicite).
→ **L15**.

---

## 6. §C03 — Reprise après crash : **PASS** (enfin exécuté)

Personne ne l'avait fait. Protocole réel, serveur sur **port 8111**, base
isolée dans le bac à sable :

```bash
# 1. démarrage
PORT=8111 GMBOOP_DATABASE_PATH=<sandbox>/data/gmboop.db node server.js
#    → HTTP server listening on http://0.0.0.0:8111

# 2. écriture d'une donnée traçante via WebSocket authentifié
hotspot_update_config {"ssid":"L11-CRASH-PROBE","password":"audit12345"}
#    → {"success":true,"config":{"ssid":"L11-CRASH-PROBE",…}}

# 3. kill -9
#    état disque : gmboop.db 4 096 o · -wal 1 017 672 o · -shm 32 768 o

# 4. relance
```

| Contrôle | Résultat |
|---|---|
| Le port se libère | **oui** (aucun `TIME_WAIT` bloquant, redémarrage immédiat) |
| Verrou résiduel | **aucun** (`-wal`/`-shm` présents : c'est le fonctionnement **normal** du WAL, pas un verrou) |
| Fichiers temporaires orphelins | **aucun** — `data/tmp/`, `data/midi/`, `data/sf2/` vides |
| Redémarrage | propre, aucune erreur nouvelle (seuls les `WARN` MIDI/D-Bus attendus en sandbox) |
| Donnée écrite avant le crash | **survit** — `hotspot_get_config` renvoie `L11-CRASH-PROBE` |
| `PRAGMA integrity_check` | **`ok`** |
| `PRAGMA journal_mode` | `wal` |

**Verdict : PASS, niveau 4.** Le WAL fait exactement son travail.

**Deux réserves, en revanche :**

1. **Le fichier `.db` principal reste à 4 096 octets, tout vit dans le `-wal`
   (≈ 1 Mo).** Un opérateur qui sauvegarde « la base » en copiant
   `data/gmboop.db` seul récupère un fichier **vide**. Les chemins internes
   (`Database.backup()`, `BackupScheduler`) sont corrects, mais la
   documentation ne le dit nulle part et `docs/INSTALLATION.md` ne met pas en
   garde. → à documenter.
2. **Notes bloquées après crash : NON TESTÉ.** Un `kill -9` pendant une lecture
   ne peut, par construction, envoyer aucun `all-notes-off` — les notes restent
   tenues sur l'instrument jusqu'à ce qu'un client renvoie un panic. Le cas
   nécessite du matériel MIDI réel (aucune bibliothèque native ici) → **L15**.
   La logique inverse (arrêt **propre**) est, elle, couverte par L12 §C02.
3. **Croisement L07 :** `busy_timeout` n'est configuré nulle part, et une base
   verrouillée gèle la boucle d'événements 5 à 10 s. Le scénario combiné
   « crash pendant une écriture + relance immédiate + `BackupScheduler` » n'a
   pas été exercé ici et mérite de l'être dans la vague de remédiation.

---

## 7. §B01–B03 — Installation propre et démarrage (F-127)

`scripts/Install.sh` (631 lignes) **relu ligne à ligne**. **Jamais exécuté**
(il modifie l'hôte : apt, sudoers, udev, setcap, systemd). Vérifications
statiques : `bash -n` OK ; `shellcheck` indisponible dans cet environnement.

### 7.1 Idempotence — globalement bonne

| Étape | Rejouable ? |
|---|---|
| apt / Node / PM2 | oui (tests `command -v`, apt idempotent) |
| `mkdir -p`, `chmod` | oui |
| `npm ci` + `npm run build` + `npm prune` | oui (mais coûteux, cf. 7.3) |
| Base de données | oui — sautée si `data/gmboop.db` existe |
| `config.json` | oui — créé **uniquement** s'il manque |
| sudoers bluetooth / hotspot | oui — créés **uniquement** s'ils manquent, validés par `visudo -c`, supprimés si la validation échoue. **Bien fait.** |
| règle udev, conf dnsmasq, unité systemd | réécrites à chaque fois — idempotent par écrasement |
| `setcap cap_net_raw+eip` sur node | idempotent, **mais à portée système** : la capacité est posée sur le binaire `node` **partagé**, donc sur toutes les applications Node de la machine. À signaler dans la doc. |

### 7.2 Gestion des erreurs

`set -e` est présent (l. 7) — bon — mais l'essentiel du travail privilégié se
termine par `|| true` (l. 296, 301, 316, 339…), ce qui est **volontaire et
raisonnable** pour des étapes optionnelles. Deux vrais problèmes :

- **`sudo apt-get install … > /dev/null 2>&1`** (l. 90-100) : `set -e` fait
  bien avorter en cas d'échec, mais **la raison est invisible**. Sur un Pi dont
  les dépôts sont désynchronisés, l'installation s'arrête sans un mot
  exploitable.
- **`read -p` à l'étape 8** (l. 463) et à l'étape macOS (l. 495) : sous
  `set -e` et **sans terminal** (`curl … | bash`, Ansible, image
  pré-provisionnée, CI), `read` retourne un code non nul sur EOF et **avorte le
  script** — juste après avoir activé le service mais **avant** de l'avoir
  démarré et avant les étapes 9 et 10. L'installateur croit à un échec ; le
  service démarrera pourtant au prochain boot. **Le script n'est pas
  scriptable.** Correctif : `read … || REPLY=n`, ou un mode
  `GMBOOP_INSTALL_NONINTERACTIVE=1`.

### 7.3 Incohérences de cycle de vie

| Constat | Effet |
|---|---|
| `npm prune --omit=dev` (l. 202) puis `update.sh` fait `npm install` (l. 363) | Les devDependencies (Vite compris) sont **réinstallées à la première mise à jour** : l'« empreinte runtime réduite » ne survit pas à la première mise à jour. Incohérence à trancher (soit on garde Vite, soit `update.sh` re-prune). |
| PM2 installé globalement (l. 158) mais **jamais utilisé sous Linux** — seul macOS lance `pm2 start ecosystem.config.cjs` (l. 484) | `ecosystem.config.cjs` est **inutilisé sur la cible réelle**, et tous ses réglages soignés (`--max-old-space-size`, `--expose-gc`, `max_memory_restart`, `min_uptime`, `kill_timeout`) **ne s'appliquent pas** sur un Pi. |
| L'unité systemd (l. 423-443) est un `ExecStart=$NODE_PATH $WORKING_DIR/server.js` nu | Ni `--max-old-space-size` (⇒ V8 dimensionne d'après la RAM totale : **inadapté sur un Pi 3 à 1 Go**), ni `--expose-gc`, ni `EnvironmentFile=` — donc **`.env` n'est pas chargé par systemd**. Le token API survit uniquement parce que `Config.js:19` fait un `dotenv.config()` explicite ; toute variable `GMBOOP_*` lue hors de `Config` serait absente. |
| L'unité n'a que `After=network.target` | Pas de `Wants=network-online.target`, pas de `After=time-sync.target` : au boot d'un Pi **sans RTC**, l'horloge est fausse au démarrage du service — ce qui affecte l'horodatage des journaux, `node-schedule` (sauvegardes à 3 h) et la rétention des sauvegardes. |
| Aucune vérification post-installation des assets d'exécution | Ni `assets/sf2/default.sf2` ni `public/lib/WebAudioFontPlayer.js` ne sont vérifiés (la liste `CRITICAL_FILES` l. 510-515 ne contient que `package.json`, `config.json`, `server.js`, `public/index.html`). **C'est précisément le contrôle qui aurait fait remonter F-14 à l'installation.** |
| Aucun contrôle d'espace disque, ni de mémoire, ni de version d'OS | Un Pi Zero / une carte SD pleine échouent tard et mal. |

**Correctif minimal recommandé pour `Install.sh`** — ajouter à `CRITICAL_FILES`
un contrôle **non bloquant mais visible** :

```diff
+# Assets d'exécution téléchargés par le postinstall. Leur absence ne casse
+# pas l'installation, mais elle casse la promesse offline-first : sans le
+# player, la SPA part chercher un CDN au chargement (audit L11 F-14).
+for asset in "public/lib/WebAudioFontPlayer.js" "assets/sf2/default.sf2"; do
+    if [ -s "$asset" ]; then
+        print_success "$asset présent"
+    else
+        print_warning "$asset MANQUANT — l'aperçu audio sera indisponible."
+        print_info "  Relancez : npm run install-default-sf2 && npm run build"
+    fi
+done
```

### 7.4 §B02 — dépendances natives : inchangé et sain

`npm install --ignore-scripts` fonctionne exactement comme `CLAUDE.md` le
décrit ; `better-sqlite3` se recompile ; `midi`/`easymidi` exige
`libasound2-dev` (absent ici) et `DeviceManager` substitue proprement un stub.
Avec le correctif `/api/health` de **L12**, l'opérateur voit désormais
`usb: failed` avec sa cause au lieu d'un `ready` mensonger — vérifié dans le
conteneur Docker réparé (§3.4). **C'est exactement ce qu'il faut.**

### 7.5 §B01, §AD — reste matériel

Installation réelle sur Pi OS Bookworm (Lite et Desktop), Pi 3B+/4/5,
démarrage au boot, redémarrage après crash **au niveau système**, CPU,
température, RAM, disque, ALSA, Bluetooth, GPIO, permissions, NTP :
**HW REQUIRED**, niveau 0. `scripts/pi-rt-tune.sh` et
`scripts/check-rt-setup.sh` existent (lus, non exécutés) et documentent une
réflexion temps-réel sérieuse ; `docs/realtime-pi.md` est cohérent avec eux.
→ procédure à verser dans **L15**.

---

## 8. §B05 — Configuration (F-126)

13 tests livrés (`tests/audit/l11-config-fuzz.test.js`), chacun avec son propre
fichier de configuration temporaire — **aucun fichier partagé touché**.

### 8.1 Ce qui marche : les surcharges d'environnement (PASS)

`Config._applyEnvOverrides()` coerce vers le type courant puis valide via
`set()`. Toutes les valeurs absurdes sont **refusées proprement**, avec un
avertissement, sans faire tomber le démarrage :

| Entrée | Résultat |
|---|---|
| `PORT=0` | refusé, la valeur du fichier est conservée |
| `PORT=99999` | refusé |
| `PORT=abc` | refusé (NaN détecté) |
| `GMBOOP_LOG_LEVEL=verbose` | refusé (niveau inconnu) |
| `GMBOOP_DATABASE_PATH=../../../etc/x.db` | refusé (traversée) |
| `GMBOOP_DATABASE_PATH=/mnt/ssd/gmboop.db` | **accepté** — choix documenté et justifié (stockage externe) |

### 8.2 F-126 (P2) — `config.json` n'est validé nulle part

Les validateurs vivent **exclusivement** dans `set()` ; `loadConfig()` renvoie
le JSON brut (`src/core/Config.js:38-51`). Tout ce que refuse une variable
d'environnement **passe** par le fichier :

| `config.json` | Comportement mesuré | Conséquence |
|---|---|---|
| `"port": 0` | accepté tel quel | `listen(0)` → Node écoute sur un **port éphémère aléatoire** ; le serveur « démarre » et personne ne le trouve |
| `"port": 99999` | accepté tel quel | `listen()` lève un `RangeError` → sortie 1 → **boucle de redémarrage** |
| `"port": "huit-mille"` | accepté tel quel | idem, message obscur |
| `"enabled": "yes"` (au lieu de `true`) | accepté, **truthy** | **un sous-système s'active par erreur** (observé en conditions réelles pendant cet audit : un `serial.enabled: "yes"` a fait passer `/api/health` de `serial: disabled` à `serial: ready`) |
| `"level": "trace"` | accepté tel quel | niveau de log inconnu, comportement du logger non spécifié |
| JSON malformé | **`console.error` puis repli silencieux sur `getDefaultConfig()`** | **le plus dangereux** : `database.path` redevient `./data/gmboop.db`. L'opérateur qui a mis sa base sur un SSD externe voit « toutes ses données disparues » — alors qu'elles sont intactes, sur un chemin que le serveur n'utilise plus. Le message ne passe **ni par `Logger`, ni par `/api/health`**. |
| Section absente | `get()` renvoie `null` — **pas** la valeur de `getDefaultConfig()` | Deux notions de « défaut » incohérentes selon que le fichier est *illisible* (défauts complets) ou *incomplet* (`null` par clé). |

**Correctif recommandé :** faire passer `loadConfig()` par les mêmes
validateurs — parcourir les clés connues et, pour chaque valeur invalide,
journaliser puis retomber sur la valeur par défaut **de cette clé** ; et
remonter un `config.parseError` dans `/api/health` quand le fichier était
illisible, pour que la situation soit **visible** plutôt que silencieuse.

---

## 9. Ce qui reste non testé

| Sujet | Raison |
|---|---|
| Durée réelle du blocage `document.write` dans un navigateur | Bac à sable non représentatif (réseau qui refuse au lieu de *dropper*) → **L08** |
| Installation réelle sur Pi (B01), boot, reboot, redémarrage après crash système (B03) | **HW REQUIRED** → **L15** |
| Mise à jour exécutée de bout en bout (`update.sh`) | Le script fait `git pull`, `npm install` et redémarre le service : **interdit** dans l'arbre partagé. Analyse statique ligne à ligne uniquement. |
| Hotspot réel, portail captif de bout en bout | Aucune interface sans fil, pas de `nmcli` → **L15** |
| Notes MIDI bloquées après `kill -9` en cours de lecture | Aucune bibliothèque MIDI native → **L15** |
| Couche `apt-get` du `Dockerfile` | `deb.debian.org` refusé (403) par la politique d'egress du bac à sable |
| §AD (plateforme Pi : thermique, GPIO, ALSA, NTP…) | **HW REQUIRED**, niveau 0 |

---

## 10. Recommandations, par priorité

| Pri | Action | Fichier |
|---|---|---|
| **P1** | **Supprimer le repli `document.write` vers le CDN** et ajouter `'lib'` à `copyStaticTree` — le diff est en §2.6 | `public/index.html`, `vite.config.js` |
| **P1** | **Réparer le `Dockerfile`** : `COPY shared/ assets/ scripts/ config.json`, supprimer `COPY locales/`, ajouter `npm rebuild better-sqlite3` — diff prouvé en §3.4 | `Dockerfile` |
| **P1** | **Donner un rollback à `update.sh`** : mémoriser `HEAD`, sauvegarder la base avant migration, revenir en arrière si `npm install`/`build`/`migrate` échoue | `scripts/update.sh` |
| **P2** | **Réduire `/api/update-status` au strict état** et déplacer le journal derrière `system_logs` (déjà authentifié et borné) — diff en §4.4 | `src/api/apiRoutes.js` |
| **P2** | **Cesser de suivre `config.json`** (livrer `config.example.json`) pour que l'auto-stash ne mange plus la configuration de l'opérateur | dépôt, `scripts/update.sh` |
| **P2** | **Valider `config.json`** avec les validateurs existants et rendre l'échec de lecture **visible** dans `/api/health` | `src/core/Config.js` |
| **P2** | **Restreindre `wifi_forget`** aux profils WiFi clients réellement enregistrés — diff en §5.4 | `scripts/hotspot.sh`, schéma |
| **P2** | Renvoyer **404** pour un chemin portant une extension de fichier, au lieu du shell SPA — diff en §2.6 | `src/api/HttpServer.js` |
| **P2** | Ajouter les schémas de payload des `system_*` et `hotspot_*` manquants (F-03) | `schemas/system.schemas.js` |
| **P2** | Aligner `NODE_HEAP_MB` et la limite mémoire du conteneur (320 M / 512 M, ou 512 M / 768 M) | `Dockerfile`, `docker-compose.yml` |
| **P3** | Unité systemd : `--max-old-space-size`, `EnvironmentFile=.env`, `Wants=network-online.target`, `After=time-sync.target` — ou basculer Linux sur PM2 et utiliser enfin `ecosystem.config.cjs` | `scripts/Install.sh` |
| **P3** | `Install.sh` : `read … \|\| REPLY=n`, vérification visible des assets téléchargés, ne plus masquer la sortie d'`apt-get` | `scripts/Install.sh` |
| **P3** | `hotspot.sh` : `--escape no` (ou découpage respectant l'échappement) et `json_escape` traitant les caractères de contrôle | `scripts/hotspot.sh` |
| **P3** | `systemBackup`/`systemRestore` : résoudre `backups/` depuis `PROJECT_ROOT`, pas depuis le cwd | `SystemCommands.js` |
| **P3** | Documenter que sauvegarder `data/gmboop.db` **seul** ne sauvegarde rien (le WAL porte les données) | `docs/INSTALLATION.md` |
| **CI** | Ajouter au pipeline : `docker build` + smoke `/api/health`, `npm run build` + contrôle d'auto-suffisance de `dist/` (le job proposé par **L14** couvre exactement ces deux points) | `.github/workflows/` |
| **HW** | B01, B03, AD, AE (hotspot réel), l'exercice §AG « couper Internet et tout tester », et le test « notes bloquées après crash » | → **L15** |

---

## 11. Reproduire cet audit

```bash
# Tests livrés par le lot (tous verts)
npm test -- tests/audit/l11-

# Le build Docker échoue (le message doit citer "/locales": not found)
docker build -t gmboop:check .

# Le repli SPA masque tout asset manquant (serveur démarré au préalable)
curl -o /dev/null -w '%{http_code} %{content_type} %{size_download}\n' \
     http://127.0.0.1:8111/lib/WebAudioFontPlayer.js
# attendu aujourd'hui : 200 text/html; charset=UTF-8 615825
# attendu après correctif : 404 text/plain

# Reprise après crash
PORT=8111 GMBOOP_DATABASE_PATH=/tmp/l11/gmboop.db node server.js &
# … écrire une donnée, puis :
kill -9 %1 && PORT=8111 GMBOOP_DATABASE_PATH=/tmp/l11/gmboop.db node server.js
node -e "const D=require('better-sqlite3');const d=new D('/tmp/l11/gmboop.db',{readonly:true});
         console.log(d.pragma('integrity_check'))"
```

**Fichiers produits par ce lot :**

```
docs/audit/2026-09-07/11_SYSTEM_INSTALL.md   (ce rapport)
tests/audit/l11-offline-first.test.js
tests/audit/l11-packaging.test.js
tests/audit/l11-config-fuzz.test.js
tests/audit/l11-hotspot-manager.test.js
src/system/HotspotManager.js                 (correctif F-123 : +30 / −3)
```

Aucun fichier partagé n'a été modifié. Aucune commande git, aucun
`npm install`/`rebuild`/`ci` dans l'arbre du projet. Aucun des scripts `.sh`
modifiant l'hôte n'a été exécuté : ils ont été **lus**, vérifiés par `bash -n`,
et leurs parties isolables testées dans un bac à sable avec des doublures.
