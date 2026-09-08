# WAVE2_R7 — Réparer le packaging Docker (F-118 P1, F-157 P1)

**Base :** vague 2 du `REMEDIATION_ROADMAP.md` · **Date :** 2026-09-08
**Autorité amont :** `11_SYSTEM_INSTALL.md` §3 (F-118), `14_DOCS_RELEASE.md` §7.3 (F-157)

---

## Résumé

`docker build` échouait **systématiquement** et personne ne le savait, parce
qu'aucun job de CI ne construit l'image. Trois blocages successifs et
indépendants, chacun masquant le suivant, ont été **reproduits rouge puis
corrigés vert** ici, sur un démon Docker réel :

| # | Blocage | Reproduit rouge | Corrigé |
|---|---|---|---|
| 1 | `COPY locales/` — répertoire inexistant | `"/locales": not found`, `EXIT=1` en **1,3 s** | ✅ ligne supprimée (les locales sont dans `public/locales/`) |
| 2 | `shared/` jamais copié | build OK, conteneur **`Exited (1)`** `ERR_MODULE_NOT_FOUND` `/app/shared/BinaryFrameCodec.js` | ✅ `COPY shared/` + `config.json` + `scripts/` |
| 3 | `npm ci --ignore-scripts` sans binding `better-sqlite3` | build OK, conteneur **`Exited (1)`** « Could not locate the bindings file » | ✅ `npm rebuild better-sqlite3` + **test de fumée dans le build** |

**Résultat mesuré :** build à froid **12,6 s** (image de base déjà locale) /
**0,73 s** à chaud, image **449 Mo** (dont 30 Mo de soundfont désormais
embarqué), conteneur **`Up (healthy)`**, `/api/health` **200** et honnête,
`GET /` **200**, base SQLite persistée à travers un `down` + `up`.

L'image est **plus légère que la recette minimale de L11 tout en embarquant
30 Mo de soundfont en plus** : 331,7 Mo de couches contre 354,6 Mo, soit
**−54 Mo de contenu applicatif** (−40 %).

> ⚠️ **Non validé pour le Raspberry Pi.** Cette machine est x86_64 ; la cible
> est ARM. Aucune image ARM n'a pu être construite ni exécutée ici. Détail et
> ce qu'il faudrait au §7.

---

## 1. Reproduction rouge — les trois blocages, un par un

Tous les journaux sont dans le bac à sable du lot. Docker 29.3.1, x86_64.

### 1.1 Blocage n°1 — le `Dockerfile` à HEAD ne construit pas

```
$ docker build -t gmboop-r7:baseline .
#16 [stage-1 10/11] COPY locales/ ./locales/
#16 ERROR: failed to calculate checksum of ref …: "/locales": not found

Dockerfile:23
  21 |     COPY public/ ./public/
  22 |     COPY migrations/ ./migrations/
  23 | >>> COPY locales/ ./locales/
ERROR: failed to build: failed to solve: … "/locales": not found
real 0m1.319s    EXIT=1
```

### 1.2 Blocage n°2 — sans `shared/`, le conteneur meurt au boot

Construit à partir du `Dockerfile` corrigé auquel on retire **la seule** ligne
`COPY shared/` :

```
$ docker build -f Dockerfile.noshared -t gmboop-r7:noshared .     -> EXIT=0
$ docker run -d --name … gmboop-r7:noshared ; sleep 5
$ docker ps -a --format '{{.Status}}'
Exited (1) 4 seconds ago
$ docker logs …
    at ModuleJob._link (node:internal/modules/esm/module_job:168:49) {
  code: 'ERR_MODULE_NOT_FOUND',
  url: 'file:///app/shared/BinaryFrameCodec.js'
}
```

### 1.3 Blocage n°3 — sans `npm rebuild`, le conteneur meurt aussi

Même image, `npm rebuild better-sqlite3` retiré :

```
$ docker build -f Dockerfile.norebuild -t gmboop-r7:norebuild .   -> EXIT=0
$ docker run -d … ; sleep 6 ; docker ps -a --format '{{.Status}}'
Exited (1) 5 seconds ago
$ docker logs …
 → /app/node_modules/better-sqlite3/lib/binding/node-v115-linux-x64/better_sqlite3.node
[2026-09-08T01:55:53.175Z] INFO  Stopping application...
[2026-09-08T01:55:53.176Z] INFO  === GeneralMidiBoop 0.8.1 Stopped ===
```

**Le point qui compte :** dans les blocages 2 et 3, `docker build` **réussit**.
Un job de CI qui se contenterait de construire l'image les laisserait passer
tous les deux. C'est pourquoi la vérification livrée va jusqu'à `/api/health`.

---

## 2. Ce qui est corrigé

### 2.1 `Dockerfile`

| Changement | Pourquoi |
|---|---|
| `COPY locales/` **supprimé** | Le répertoire n'a jamais existé — blocage n°1. |
| `+ COPY shared/` | Import **statique** de `src/api/WsOutputQueue.js` — blocage n°2. Porte aussi `instrument-families.json`, `gm-instrument-names.json`, `gm-instrument-capabilities.json`. |
| `+ COPY config.json` | Sans lui, `Config` retombe **silencieusement** sur `getDefaultConfig()` : la configuration livrée est ignorée. |
| `+ COPY scripts/`, `+ COPY README.md` | `scripts/migrate-db.js`, `hotspot.sh` ; et une redistribution sans sa notice n'en est pas une (F-158). |
| `+ npm rebuild better-sqlite3` | Blocage n°3. Passe par `prebuild-install` : binaire pré-compilé, **aucune compilation**, donc aucune toolchain nécessaire. |
| `+ test de fumée `require('better-sqlite3')`` dans l'étage builder | Transforme « le conteneur meurt au boot », que personne ne regardait, en **« le build échoue »**. |
| `− RUN apt-get install libasound2` | Inutile sans le module natif `midi`, que `--ignore-scripts` ne bâtit jamais. Supprime aussi la dépendance du build à un miroir Debian joignable. Le commentaire qui remplace la couche liste les **4 changements** nécessaires pour un vrai support USB MIDI en conteneur. |
| `chown -R appuser /app` → `COPY --chown=` sur chaque COPY | Le `chown -R` réécrivait **tout** `/app` dans une seconde couche copy-on-write : **113 Mo mesurés**, pour rien. |
| `+ ARG NODE_IMAGE=node:20-slim` | Épingler un digest (`§7.5` point 5 de L14), viser un miroir, ou construire derrière un proxy TLS inspectant. |
| `+ ARG WITH_RUNTIME_ASSETS=1` + fetch **non fatal** | Récupère le soundfont par défaut et `WebAudioFontPlayer.js`, que le `postinstall` sauté par `--ignore-scripts` aurait installés. `=0` pour une image ~30 Mo plus légère. Un build sans egress produit toujours une image fonctionnelle. |
| En-tête : avertissement **architecture** + recette `buildx`/QEMU | Voir §7. |

L'uid reste **1001** (`appuser`) : passer à l'utilisateur `node` (uid 1000) de
l'image de base casserait les permissions des volumes nommés existants.

### 2.2 `.dockerignore`

| Changement | Pourquoi |
|---|---|
| `node_modules`, `.git`, `data`, `logs`, `backups` — **déjà présents**, conservés | `node_modules` du contexte = bindings natifs de la machine de **build** : sur un poste x86_64 produisant une image ARM, ils sont faux et silencieux. |
| `+ dist`, `+ docs`, `+ wiki`, `+ images-a-faire`, `+ scripts/audit`, `+ **/node_modules`, `+ .env.*`, `+ *.log`, + les fichiers de config dev (`jest`, `vitest`, `vite`, `tsconfig`, `ecosystem`) | Contexte plus petit = transfert plus court à chaque build. Contexte final mesuré : **13,03 Mo**. |
| `+ public/lib`, `+ assets/sf2/*.sf2` | **Trouvé pendant R7 :** ces chemins sont gitignorés et récupérés au `postinstall`. Les laisser dans le contexte rend l'image fonction du disque du développeur — un **stub de 42 octets** (`window.WebAudioFontPlayer = function(){};`) laissé par un autre agent s'est effectivement retrouvé dans une image intermédiaire. L'étage builder est désormais la **seule** source de ces deux assets. |
| `+ !README.md` (négation de `*.md`) | Relevé par L14 §6.1 : l'image redistribuait le logiciel sans sa notice. |

### 2.3 `docker-compose.yml`

| Point relevé par L11 §3.5 | Traitement |
|---|---|
| **`memory: 512M` **vs** `NODE_HEAP_MB=512`** — l'OOM-killer arrive avant le GC final de V8 | **Corrigé.** `NODE_HEAP_MB=${NODE_HEAP_MB:-320}` face à `memory: ${MEMORY_LIMIT:-512M}`, avec l'arithmétique en commentaire (RSS = tas V8 + heap natif + buffers + code ; viser 60-65 %). Vérifié dans le conteneur : `node --max-old-space-size=320 …`. |
| Le token d'API change à **chaque recréation** (`.env` hors volume) | **Documenté et outillé.** Compose lit déjà `./.env` de l'hôte pour l'interpolation — une installation passée par `Install.sh` a donc un token stable gratuitement (vérifié : `INFO API token already configured`). Sans `.env` hôte, le commentaire pointe les deux remèdes, dont un bind-mount `./.env:/app/.env` prêt à décommenter. |
| Aucun `devices:`/`group_add` pour ALSA ou série | **Documenté comme tel**, en tête de fichier et dans `docs/INSTALLATION.md` : le MIDI matériel est structurellement hors de portée de ce compose. |
| Ports, volumes, `restart`, rotation des journaux | Déjà cohérents — conservés, commentés (`gmboop-data` est **la** chose à sauvegarder). |
| — | **Ajouté :** `image: gmboop:local`, les deux `build.args`, et `GMBOOP_SECURITY_MODE` (avec la réserve de la vague 1 : la SPA ne sait pas présenter de token, `secure` = accès API seulement). |

### 2.4 `scripts/verify-docker.sh` (nouveau)

Construit, démarre, **attend** `/api/health`, et refuse un payload malhonnête.
C'est la pièce qui manquait : un `docker build` vert ne prouve rien (§1.3).

```
[verify-docker] == 1/4 build            → EXIT 0
[verify-docker] == 2/4 image size       → gmboop-r7:verify  449MB
[verify-docker] == 3/4 start container
[verify-docker] == 4/4 probe
  GET /api/health -> {"status":"ok", … }
  health payload is honest (database ready; usb/ble/serial not claiming ready)
  GET / -> HTTP 200
[verify-docker] OK — image builds, container runs, /api/health is honest.
```

Le contrôle « honnête » est explicitement un **cliquet sur L12** : si `usb`,
`ble` ou `serial` reviennent un jour dire `ready` dans un conteneur, le script
échoue.

---

## 3. Preuve d'exécution — build, démarrage, `/api/health`

### 3.1 Build

```
$ docker build --no-cache -t gmboop-r7:final .
#5 [internal] load build context
#5 transferring context: 13.03MB 0.1s done
#8 [builder 4/6] RUN npm ci --omit=dev --ignore-scripts && npm rebuild better-sqlite3 && node -e "…"
#8 5.027 added 271 packages, and audited 272 packages in 5s
#8 5.211 better-sqlite3 binding OK
#11 [builder 6/6] RUN mkdir -p assets/sf2 public/lib && …
#11 0.963 [install-default-sf2] ✓ Installed default soundfont (29.8 MB).
#24 exporting to image … DONE 3.2s
real    0m12.621s        EXIT=0

$ docker build -t gmboop-r7:final .        # à chaud
real    0m0.730s
```

> Le « à froid » ci-dessus part d'un cache BuildKit vidé (`docker builder prune
> -af`) mais avec **l'image de base déjà présente localement**. Ajouter ~74 Mo
> de `docker pull node:20-slim` sur une machine vierge.

### 3.2 Conteneur

```
$ docker run -d --name gmboop-r7-final -p 18085:8080 gmboop-r7:final
$ docker ps
IMAGE             STATUS                        PORTS
gmboop-r7:final   Up About a minute (healthy)   0.0.0.0:18085->8080/tcp
```

`(healthy)` vient du `HEALTHCHECK` de l'image : il s'exécute réellement.

### 3.3 `/api/health` — **200, et honnête**

```
$ curl -s http://127.0.0.1:18085/api/health
{
  "status": "ok",
  "version": "0.8.1",
  "gitHash": "unknown",
  "uptime": 12.063352888,
  "capabilitiesOverall": "degraded",
  "capabilities": {
    "database": { "status": "ready" },
    "playback": { "status": "ready" },
    "usb":  { "status": "failed",
              "detail": "Native MIDI library unavailable (easymidi/ALSA bindings missing) — USB MIDI ports cannot be opened" },
    "ble":  { "status": "failed",   "detail": "D-Bus system bus not available" },
    "network": { "status": "degraded",
              "detail": "RTP-MIDI is a simplified AppleMIDI implementation (no IN/OK, CK sync or journal)" },
    "serial": { "status": "disabled", "detail": "Serial MIDI disabled in configuration" },
    "lighting": { "status": "ready" }
  }
}
```

**Aucune régression sur L12.** `usb` et `ble` disent `failed` avec leur cause,
`serial` dit `disabled`. Un `ready` sur l'un des trois serait le retour de
F-01/F-02/F-128 ; `scripts/verify-docker.sh` l'attrape désormais.

### 3.4 Le reste répond

```
$ curl -o /dev/null -w "%{http_code} %{content_type} %{size_download}\n" http://…/
200 text/html; charset=UTF-8 616704

$ curl -o /dev/null -w "%{http_code} %{content_type} %{size_download}\n" \
       http://…/api/sf2/default/preset/melodic/0
200 application/octet-stream 20759580
```

Le second est **nouveau** : avec `assets/` embarqué, le soundfont par défaut
est réellement servi. Avant R7 (et dans la recette minimale de L11), cette
route renvoyait 404.

### 3.5 Persistance de la base (`docker compose`)

```
$ PORT=18081 docker compose -p gmboopr7 up -d --build
$ docker compose -p gmboopr7 ps
gmboopr7-gmboop-1   Up 12 seconds (healthy)   0.0.0.0:18081->8080/tcp

$ docker exec … md5sum /app/data/gmboop.db ; echo probe > /app/data/r7-marker.txt
9732e4a0ce6fc561f0243041ffd78e3b  /app/data/gmboop.db

$ docker compose -p gmboopr7 down && docker compose -p gmboopr7 up -d
$ docker exec … cat /app/data/r7-marker.txt ; ls -l /app/data/
r7-persistence-probe
-rw-r--r-- 1 appuser appuser 520192 gmboop.db
…
$ curl -o /dev/null -w "%{http_code}\n" http://127.0.0.1:18081/api/health
200
```

Volume `gmboop-data` conservé, base rouverte, `/api/health` de nouveau 200.
Le plafond de tas appliqué est bien celui du compose :

```
$ docker exec … cat /proc/1/cmdline
node --max-old-space-size=320 --expose-gc --enable-source-maps=false server.js
```

---

## 4. Poids de l'image

Mesuré avec le snapshotter containerd. `docker images` y affiche un **disk
usage** qui compte le blob de contenu **et** l'instantané décompressé ; la
somme des couches de `docker history` est la taille décompressée. Les deux
sont donnés pour éviter toute ambiguïté.

| Image | Somme des couches | `docker images` | Contenu applicatif (couches − base) |
|---|---|---|---|
| `node:20-slim` (base) | 218,7 Mo | 293 Mo | — |
| **L11, recette minimale** (`gmboop-l11:sqlite`) | 354,6 Mo | 456 Mo | **135,9 Mo** |
| **R7, `WITH_RUNTIME_ASSETS=0`** | 300,4 Mo | **389 Mo** | **81,7 Mo** (−40 %) |
| **R7, défaut (soundfont inclus)** | 331,7 Mo | **449 Mo** | 113,0 Mo |

Décomposition du contenu applicatif R7 (défaut) :

```
67,1 Mo  node_modules (production)
31,3 Mo  assets/sf2/default.sf2
10,8 Mo  public/  (SPA + 28 locales + 107 SVG)
 2,8 Mo  src/
 0,7 Mo  scripts/ + migrations/ + shared/ + fichiers racine
```

**Est-ce raisonnable pour un Pi ?** Oui. 449 Mo sur une carte SD de 16-32 Go,
soit ~110 Mo à télécharger (contenu compressé). Les deux tiers du poids sont
l'image de base Debian + Node, pas le projet.

**Ce qui a été pris, parce que c'était simple et net :**

- `COPY --chown=` au lieu du `chown -R` final : **−113 Mo**, aucun risque.
- Suppression de la couche `apt-get install libasound2` : une couche et une
  dépendance réseau de moins, pour un paquet inutilisable en l'état.

**Ce qui n'a pas été pris, et pourquoi :**

- **Multi-étages plus agressif.** Le `Dockerfile` est *déjà* multi-étages, et
  c'est ce qui compte : le cache npm et les métadonnées d'installation
  meurent dans l'étage `builder`. Aller plus loin ne gagne rien.
- **`node:20-alpine`** (−~100 Mo). Alpine est musl ; les prebuilds
  `better-sqlite3` sont glibc. `npm rebuild` retomberait sur `node-gyp`, donc
  sur une toolchain à installer — exactement le mur documenté en §3.3 de
  `11_SYSTEM_INSTALL.md`. Mauvais échange.
- **`gcr.io/distroless/nodejs20`** (−~100 Mo). Casse `CMD ["sh","-c",…]`, le
  `HEALTHCHECK`, `adduser`, et tout `docker exec sh` de diagnostic sur un Pi
  distant. Le gain ne paie pas la perte d'exploitabilité.
- **Élaguer `node_modules`** (`better-sqlite3/deps` 9,6 Mo, `node-gyp` +
  `cacache` + `tar` + `@npmcli` ≈ 15 Mo). ~25 Mo pour une fragilité durable
  sur un chemin qu'aucun test ne couvre. Non.

---

## 5. Vérification automatisable livrée

| Fichier | Nature |
|---|---|
| `scripts/verify-docker.sh` | **La** vérification qui compte : build + run + `/api/health` + contrôle d'honnêteté. Exige un démon Docker → **hors suite unitaire**, à câbler en CI (§8). |
| `tests/audit/r7-packaging.test.js` | 23 tests **statiques** (aucun `docker`). Attrapent gratuitement les trois régressions : un `COPY` vers un chemin absent, la disparition de `npm rebuild`, une exclusion `.dockerignore` retirée, la dérive `NODE_HEAP_MB` ↔ `MEMORY_LIMIT`. |

### Note — `tests/audit/l11-packaging.test.js` a dû être inversé

Ce fichier était un test de **caractérisation** : il assertait le packaging
**cassé**. Une fois R7 appliqué, 3 de ses tests échouaient et 3 autres
passaient **à vide** (l'expression rationnelle `copySources` ne reconnaissait
plus les `COPY --chown=…`, donc les `not.toContain(...)` étaient vrais sans
rien vérifier — un faux vert, pire qu'un rouge).

Le fichier portait lui-même l'instruction : *« À INVERSER après correctif »*.
Les six tests du bloc **§B04** ont donc été inversés pour asserter l'état
**corrigé**, chacun conservant en commentaire ce qui était caractérisé avant.
`copySources` a été réécrit pour ignorer les drapeaux. **Le bloc §B03
(PM2/systemd, F-127), toujours ouvert, est inchangé.**

---

## 6. Ce que l'image ne fait toujours pas — dit explicitement

| Point | État |
|---|---|
| **MIDI matériel (USB, BLE, série)** | Structurellement impossible : ni `/dev/snd`, ni périphérique série, ni socket D-Bus. `/api/health` le dit. Documenté dans `docker-compose.yml`, dans l'en-tête du `Dockerfile` (avec les 4 changements pour l'activer) et dans `docs/INSTALLATION.md`. **Ce n'est pas un défaut, c'est le périmètre.** |
| **`/lib/WebAudioFontPlayer.js` → 200 + shell SPA** (F-119) | **Toujours vrai** — `HttpServer.js` est le périmètre de **R6**. Dans ce bac à sable les 4 miroirs du player renvoient 403, donc l'image n'a pas le fichier. Sur un réseau normal, l'étage builder le récupère et le problème ne se pose pas pour Docker. |
| **`dist/` n'est pas construit dans l'image** | L'image sert l'arbre `public/` non bundlé (`HttpServer.js` retombe sur `devPath` quand `dist/index.html` est absent) : fonctionnellement correct, `GET /` répond 200. Construire `dist/` exigerait `vite` (devDependency) dans l'image et croiserait le correctif R6 sur `vite.config.js`. **Non fait, délibérément.** |
| **`system_update` en conteneur** | `scripts/` est copié, donc `update.sh` est trouvé — mais `git pull` + systemd/PM2 n'ont aucun sens ici. La mise à jour d'un conteneur, c'est `docker compose up -d --build` ; documenté dans `docs/INSTALLATION.md`. |
| **Image de base non épinglée** | `ARG NODE_IMAGE` permet désormais de passer un digest, mais le **défaut** reste le tag mouvant `node:20-slim` (§7.5 point 5 de L14). Épingler relève de la procédure de release, pas de R7. |

---

## 7. Non validé : ARM / Raspberry Pi — **et c'est important**

**Cette machine est x86_64. La cible est ARM. Aucune image ARM n'a été
construite ni exécutée ici.** Tout ce qui précède vaut pour `linux/amd64`.

Deux tentatives réelles, deux blocages d'environnement :

```
$ docker run --privileged --rm tonistiigi/binfmt --install arm64
docker: failed to copy: … production.cloudfront.docker.com/… : Forbidden

$ docker buildx build --platform linux/arm64 -t gmboop-r7:arm64-attempt .
ERROR: failed to solve: node:20-slim: failed to resolve source metadata:
       … production.cloudfront.docker.com/… : Forbidden
```

La politique d'egress refuse `production.cloudfront.docker.com` : **ni
l'émulateur QEMU, ni les couches arm64 de l'image de base** ne peuvent être
récupérés. Le chemin ARM est bloqué dès la première étape.

**Ce qui a quand même pu être vérifié**, et qui est le risque ARM n°1 de ce
`Dockerfile` — `npm rebuild better-sqlite3` doit trouver un **binaire
pré-compilé**, faute de quoi il retomberait sur `node-gyp` et échouerait
(aucune toolchain dans l'étage builder) :

```
$ curl -sSLo /dev/null -w '%{http_code}\n' \
  https://github.com/WiseLibs/better-sqlite3/releases/download/v11.10.0/\
better-sqlite3-v11.10.0-node-v115-<arch>.tar.gz
node-v115-linux-x64:    200
node-v115-linux-arm64:  200      ← Pi 4 / Pi 5 64 bits
node-v115-linux-arm:    200      ← Pi 3 / Pi OS 32 bits
```

Les prebuilds ARM **existent** pour la version verrouillée (11.10.0, ABI
node-v115). La stratégie est donc saine par construction — mais *sain par
construction* n'est pas *vérifié*.

**Ce qu'il faut pour clore ce point** (hors de portée ici) :

1. `docker run --privileged --rm tonistiigi/binfmt --install arm64` sur un
   hôte à egress ouvert (ou un runner CI GitHub, où c'est standard) ;
2. `docker buildx build --platform linux/arm64,linux/amd64 …` ;
3. **exécuter** l'image arm64 sous QEMU et rejouer `scripts/verify-docker.sh`
   (`HOST_PORT`, `IMAGE_TAG`) — un build arm64 vert ne prouve rien de plus
   qu'un build amd64 vert, cf. §1.3 ;
4. idéalement, un passage sur un vrai Pi (checklist `15_HARDWARE_QA_CHECKLIST.md`).

Le job CI proposé au §8 fait 1→3. Le point 4 reste matériel.

---

## 8. Job CI de build Docker — **diff proposé, non appliqué**

`.github/workflows/ci.yml` est tenu par un autre agent : **ce diff n'est pas
appliqué**. Il ajoute deux jobs à la fin du fichier existant.

```diff
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ (à la fin du fichier)
+
+  # Le packaging Docker a été cassé pendant des mois sans que personne le
+  # sache, parce que rien ne construisait l'image (audit F-118 / F-157).
+  # ATTENTION : construire ne suffit pas. Deux des trois blocages laissaient
+  # `docker build` réussir et tuaient le conteneur au démarrage. Ce job va
+  # donc jusqu'à une réponse HTTP réelle, via scripts/verify-docker.sh.
+  docker:
+    name: Docker image (build + boot + health)
+    runs-on: ubuntu-latest
+    steps:
+      - uses: actions/checkout@v4
+      - uses: docker/setup-buildx-action@v3
+      - name: Build, run and probe the image
+        env:
+          # Les runners GitHub n'ont pas d'egress vers les miroirs du
+          # soundfont de façon garantie, et 30 Mo par PR ne servent à rien
+          # ici : on vérifie le packaging, pas les assets.
+          BUILD_ARGS: --build-arg WITH_RUNTIME_ASSETS=0
+          IMAGE_TAG: gmboop:ci
+          HOST_PORT: '18080'
+        run: scripts/verify-docker.sh
+
+  # Cliquet d'architecture : la cible de production est un Raspberry Pi.
+  # Le job ci-dessus ne prouve QUE linux/amd64 — `npm rebuild better-sqlite3`
+  # télécharge un binding pour la plateforme de BUILD. Sans ce job, une image
+  # « verte » peut être inutilisable sur le matériel cible.
+  docker-arm:
+    name: Docker image (linux/arm64, QEMU)
+    runs-on: ubuntu-latest
+    steps:
+      - uses: actions/checkout@v4
+      - uses: docker/setup-qemu-action@v3
+        with:
+          platforms: arm64
+      - uses: docker/setup-buildx-action@v3
+      - name: Cross-build for arm64
+        run: |
+          docker buildx build --platform linux/arm64 \
+            --build-arg WITH_RUNTIME_ASSETS=0 \
+            -t gmboop:arm64 --load .
+      # Émulé, donc lent : on laisse 180 s au démarrage au lieu de 60.
+      - name: Boot the arm64 image under QEMU and probe /api/health
+        env:
+          IMAGE_TAG: gmboop:arm64
+          CONTAINER_NAME: gmboop-arm64
+          HOST_PORT: '18081'
+          TIMEOUT_S: '180'
+          KEEP_IMAGE: '1'
+        run: |
+          # L'image est déjà construite : on ne rejoue que run + probe.
+          docker run -d --name "$CONTAINER_NAME" -p "$HOST_PORT:8080" "$IMAGE_TAG"
+          for i in $(seq 1 "$TIMEOUT_S"); do
+            curl -fsS "http://127.0.0.1:$HOST_PORT/api/health" && exit 0
+            docker ps -q -f "name=^/$CONTAINER_NAME$" | grep -q . || {
+              docker logs "$CONTAINER_NAME"; exit 1; }
+            sleep 1
+          done
+          docker logs "$CONTAINER_NAME"; exit 1
```

Notes pour l'agent qui tient la CI :

- `docker` est **rapide** (~1 min avec `WITH_RUNTIME_ASSETS=0`) : à mettre sur
  chaque PR. `docker-arm` est lent sous QEMU : envisager
  `if: github.ref == 'refs/heads/main'` ou un `schedule`.
- `scripts/verify-docker.sh` nettoie derrière lui (`trap`), sauf si
  `KEEP_IMAGE=1`.
- Ce job comble un des trous listés par **F-162** (« pas de build Docker »).

---

## 9. Accommodations d'environnement — déclarées

Pour que ces mesures soient relisibles, et qu'on ne les prenne pas pour plus
qu'elles ne sont :

1. **CA du proxy.** Le réseau du bac à sable ré-termine TLS ; sans CA ajouté,
   `npm ci` échoue dans le conteneur (`SELF_SIGNED_CERT_IN_CHAIN`). Les builds
   ci-dessus utilisent donc `--build-arg NODE_IMAGE=gmboop-r7-ca:node20`, une
   image locale = `node:20-slim` **officielle** (tirée ici, digest
   `2cf067cfed83…`) + le CA du proxy + `NODE_EXTRA_CA_CERTS`. **Coût mesuré :
   une couche de 254 ko**, comptée dans tous les chiffres du §4 — bruit.
   Le défaut du `Dockerfile` reste `node:20-slim` ; l'`ARG` existe aussi pour
   les proxys d'entreprise, ce n'est pas une béquille de test.
2. **`deb.debian.org` renvoie 403** ici. La couche `apt-get` aurait donc été
   intestable — mais elle a été **supprimée sur le fond** (inutile sans le
   module `midi`), pas parce qu'elle était intestable.
3. **Miroirs de `WebAudioFontPlayer.js` : 403** (les 4). Le soundfont, lui,
   se télécharge (`raw.githubusercontent.com` passe) : `✓ Installed default
   soundfont (29.8 MB)`. Le caractère **non fatal** du fetch est donc exercé
   pour de vrai dans les deux sens.
4. **`production.cloudfront.docker.com` : 403** → pas de QEMU, pas de couches
   arm64 (§7).

---

## 10. État de l'arbre

```
$ npm test        → 207 suites / 2821 tests — TOUS VERTS
                    (dont l11-packaging 10/10 et r7-packaging 23/23)
$ npx vitest run  → 86 fichiers / 1560 tests — TOUS VERTS
$ npx eslint tests/audit/{r7,l11}-packaging.test.js   → 0 erreur, 0 warning
$ npx prettier --check …                              → conforme
```

Le compte de la vague 1 était 199 suites / 2 677 tests ; les 8 suites et
144 tests supplémentaires viennent des autres chantiers de la vague 2 menés en
parallèle, plus les 23 tests ajoutés ici. À un moment de ce lot,
`tests/audit/r6-static-asset-404.test.js` était rouge (21 tests) — c'était le
rouge en cours de R6 sur F-119, hors périmètre R7 ; il est vert à la clôture.

## 11. Fichiers touchés

| Fichier | Nature |
|---|---|
| `Dockerfile` | Réécrit : 3 blocages corrigés, `libasound2` retiré, `--chown`, 2 `ARG`, en-tête architecture. |
| `.dockerignore` | Réécrit : contexte resserré, `public/lib` + `assets/sf2/*.sf2` exclus, `!README.md`. |
| `docker-compose.yml` | Réécrit : tas/limite mémoire cohérents, build args, token documenté, limites du conteneur explicitées. |
| `docs/INSTALLATION.md` | Section « Docker Deployment » réécrite (l'ancienne décrivait des bind mounts `./uploads` qui n'existent pas). Aucune autre section touchée. |
| `scripts/verify-docker.sh` | **Nouveau.** Build + run + `/api/health` + contrôle d'honnêteté. |
| `tests/audit/r7-packaging.test.js` | **Nouveau.** 23 tests statiques. |
| `tests/audit/l11-packaging.test.js` | Bloc §B04 inversé vers l'état corrigé (cf. §5) ; bloc §B03 inchangé. |
