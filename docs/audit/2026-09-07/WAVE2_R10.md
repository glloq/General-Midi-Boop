# Vague 2 — R10 · Licences et attribution — compte rendu

**Finding visé :** F-158 (P1, §BS de `14_DOCS_RELEASE.md`).
**Portée :** `LICENSE`, section licence de `README.md`, `assets/ASSET-LICENSES.md`,
`THIRD-PARTY-NOTICES.md`, `scripts/audit/licenses.mjs`.
**Date :** 2026-09-08.

---

## 0. Résumé

| Volet | Avant | Après |
|---|---|---|
| Licence du projet | annoncée MIT, **aucun texte** → par défaut tous droits réservés | `LICENSE` MIT complet, titulaire nommé, badge et README pointant dessus |
| Dépendances runtime | inventaire de L14 (231 paquets), non régénérable | **271 paquets** re-vérifiés, `THIRD-PARTY-NOTICES.md` généré, porte CI disponible |
| Assets | 61 SVG « SVG Repo » sans licence, 46 supposés maison | **7 fichiers tracés à leur source amont** (dont 5 CC BY 4.0), 57 déclarés non traçables, 43 présumés maison |
| Bibliothèque vendorisée | « licence non enregistrée » | **`WebAudioFontPlayer.js` est GPL-3.0-or-later** — conflit ouvert avec la distribution MIT |

**Deux choses ont changé de nature pendant ce lot.** Le risque principal n'est
plus les icônes SVG Repo (réel, mais borné et refermable) : c'est le fichier
JavaScript téléchargé au `postinstall` et servi à chaque navigateur, dont
l'amont est passé sous GPL-3 sans que le projet s'en aperçoive. Et l'hypothèse
« les 46 SVG non marqués sont de production interne » s'est révélée fausse pour
trois d'entre eux.

---

## 1. `LICENSE` — créé

### 1.1 Le titulaire, et pourquoi celui-là

Le fichier porte :

```
Copyright (c) 2026 glloq and the Général Midi Boop contributors
```

Éléments retenus, du plus au moins probant :

| Preuve | Valeur |
|---|---|
| `git remote -v` → `https://github.com/glloq/General-Midi-Boop` | le dépôt appartient au compte **glloq** |
| `git log --format='%an <%ae>'` → 62 commits `glloq <glloq.nz@gmail.com>`, 192 `Claude <noreply@anthropic.com>` | **un seul auteur humain**, sur des branches `glloq/claude/...` |
| `README.md:18,142,161` | toutes les URL de clonage et le wiki pointent sur `glloq/` |
| `package.json:39` `"author": "GeneralMidiBoop Team"` | **écarté** : une « Team » sans entité juridique ni membre nommé ne peut pas être titulaire |

**Ambiguïtés que l'utilisateur doit trancher :**

1. **`glloq` est un pseudonyme.** Un pseudonyme suffit à identifier un titulaire
   dans la pratique open source, mais si le projet doit un jour être cédé,
   relicencié ou défendu, un nom civil (ou une entité) vaut mieux. À remplacer
   si tel est le souhait — c'est la seule ligne à changer.
2. **L'année.** `2026` est la plus ancienne date **vérifiable dans l'arbre de
   travail** : `CHANGELOG.md` remonte à `[5.0.0] - 2026-03-24`, sous le nom
   précédent (*Ma-est-tro / MidiMind*). Le clone est **superficiel**
   (`.git/shallow`, 254 commits, le plus ancien au 2026-05-19) : l'historique
   réel est inaccessible ici, et une numérotation en 5.x implique un projet
   commencé bien avant. Si le premier commit date de 2024 ou 2025, écrire
   `Copyright (c) 2024-2026 …` — **à confirmer sur le dépôt complet**
   (`git log --reverse --format='%ad' | head -1`).
3. **Les 192 commits `Claude <noreply@anthropic.com>`.** Ils ont été produits
   sur les branches du dépôt et fusionnés par le mainteneur ; la formule
   « and the Général Midi Boop contributors » les couvre sans trancher une
   question qui n'a pas à l'être dans un fichier de licence.

### 1.2 Ce que le fichier dit en plus du texte MIT

Le `LICENSE` se termine par un renvoi explicite vers `THIRD-PARTY-NOTICES.md` et
`assets/ASSET-LICENSES.md`, et prévient qu'une partie du matériel livré est
CC BY 4.0 ou Apache-2.0. Sans cet avertissement, un `LICENSE` MIT nu ferait
croire que tout le contenu du dépôt est MIT — ce qui est faux, et ce qui est
précisément le risque que F-158 cherchait à fermer.

`README.md` : le badge pointait sur l'ancre morte `#license`, il pointe
maintenant sur `./LICENSE` ; la section « License » renvoie aux deux inventaires
et signale les deux points bloquants.

---

## 2. Dépendances runtime — re-vérifiées

### 2.1 Méthode

`scripts/audit/licenses.mjs` (nouveau). La **clôture runtime** est lue dans
`package-lock.json` : toute entrée de `packages` **non marquée `"dev": true`**,
c'est-à-dire exactement ce qu'installe `npm ci --omit=dev`. Le lockfile fait foi
pour l'appartenance ; `node_modules/` n'est lu que pour le **texte** des
licences. La licence est résolue dans l'ordre : champ `license` → formes
dépréciées (`{type}`, tableau) → détection sur le texte du fichier `LICENSE`
(étiquetée « from file ») → `UNKNOWN`, qui fait échouer `--check`.

### 2.2 Résultat

```
$ node scripts/audit/licenses.mjs
Runtime packages (package-lock.json, non-dev): 271

   212  MIT              1  MIT/X11
    32  ISC              1  (MIT OR WTFPL)
    13  BlueOak-1.0.0    1  MIT OR Apache2
     5  Apache-2.0       1  (BSD-2-Clause OR MIT OR Apache-2.0)
     2  BSD-2-Clause     1  0BSD
     2  BSD-3-Clause

Copyleft: 0
Needs a human look: 0
```

**Zéro copyleft, zéro licence non établie.** Le constat de L14 tient.

**Le `mqtt` ajouté en vague 2 est propre.** La clôture passe de **231 à 271**
paquets, et les 40 nouveaux sont exactement le sous-arbre de `mqtt` :
37 MIT, 2 ISC, 1 0BSD. Le 231 de L14 est confirmé au paquet près par le calcul
inverse (clôture recalculée sans `mqtt` → 231).

Les deux « UNKNOWN » relevés à la main par L14 sont retrouvés automatiquement et
avec la même conclusion : `jsbi@2.0.5` → Apache-2.0, `map-stream@0.1.0` → MIT
(© 2011 Dominic Tarr). Le script les étiquette `source = file` pour qu'on ne
confonde jamais une licence déclarée et une licence déduite.

### 2.3 `THIRD-PARTY-NOTICES.md` — créé, généré

288 Ko, produit par `node scripts/audit/licenses.mjs --emit` : tableau de
synthèse, table des 271 paquets (nom, version, SPDX, provenance de
l'information, ligne de copyright extraite), et **les 166 textes de licence
distincts reproduits verbatim** — c'est ce que la clause MIT « the above
copyright notice … shall be included in all copies » exige réellement, et ce
qu'aucun fichier ne fournissait.

Vérifié au passage : **aucun des 5 paquets Apache-2.0 ne livre de fichier
`NOTICE`**, donc l'obligation §4(d) est vide de contenu — le tableau le dit
explicitement plutôt que de laisser le lecteur le supposer.

### 2.4 Une anomalie de lockfile, hors périmètre

`package-lock.json` déclare `mqtt` **deux fois** dans son entrée racine :

```json
"dependencies":         { …, "mqtt": "*", … },
"optionalDependencies": { …, "mqtt": "^5.15.2", … }
```

alors que `package.json` ne l'a qu'en `optionalDependencies`. Conséquence : pour
`npm ci`, `mqtt` est une dépendance **obligatoire** et **non bornée** (`*`), ce
qui contredit l'intention de F-156 (« optionnelle, comme les autres pilotes
matériels ») et laisserait passer n'importe quelle version majeure future.
`package.json` et `package-lock.json` appartiennent à un autre lot ; **à
régénérer proprement** (`npm install` après avoir retiré l'entrée fautive).

---

## 3. Assets — ce qui est établi, ce qui ne l'est pas

Tout est consigné dans **`assets/ASSET-LICENSES.md`**. Ce qui suit en résume les
conclusions et la méthode.

### 3.1 Méthode de traçage (reproductible)

Les icônes ne portent aucune métadonnée exploitable :

```
$ grep -rhoi "licen[^\"<]*" public/assets/      # (vide)
$ grep -rli svgrepo public/assets | wc -l       # 61
$ find public/assets -name '*.svg' | wc -l      # 107
```

Le marqueur `<!-- Uploaded to: SVG Repo … -->` est **strictement identique** sur
les 61 fichiers ; 59 d'entre eux n'ont ni `<title>`, ni `<desc>`, ni RDF, ni
identifiant de calque exploitable. Le nom de la collection d'origine n'a donc
pas survécu au passage par SVG Repo.

J'ai contourné l'absence de métadonnées par **la géométrie** : pour chaque SVG,
extraction de tous les attributs `d="…"`, normalisation (suppression des espaces
et virgules), puis recherche de ces signatures dans **l'intégralité du corpus
publié [Iconify](https://github.com/iconify/icon-sets) — 238 jeux d'icônes,
chacun avec une licence SPDX déclarée**. La géométrie survit au reformatage, à
la minification et au recoloriage ; une correspondance verbatim sur une
signature de 40 à 55 caractères de coordonnées n'est pas un hasard.

### 3.2 Ce que ça a donné — 7 fichiers livrés tracés

| Fichier livré | Icône amont | Jeu / auteur | Licence | Marqué SVG Repo ? |
|---|---|---|---|---|
| `instruments/violin.svg` | `emojione:violin` | Emojione / Emojitwo | **CC BY 4.0** | non |
| `instruments/trumpet.svg` | `emojione:trumpet` | Emojione / Emojitwo | **CC BY 4.0** | **oui** |
| `drums/Hand-Clap.svg` | `twemoji:clapping-hands` | Twemoji (Twitter) | **CC BY 4.0** | **oui** |
| `connection/bluetooth.svg` | `solar:bluetooth-square-*` | Solar (480 Design) | **CC BY 4.0** | **oui** |
| `instruments/accordion.svg` | `noto:accordion` | Noto Emoji (Google) | Apache-2.0 | non |
| `instruments/nylon.svg` | `fxemoji:guitar` | Firefox OS Emoji (Mozilla) | Apache-2.0 | non |
| `instruments/bottle.svg` | `icon-park:bottle-one` | IconPark (ByteDance) | Apache-2.0 | **oui** |

(+ `docs/images/bluetooth.svg`, copie du même fichier ; + 5 fichiers de
`images-a-faire/`.)

`accordion.svg` a été recoupé une seconde fois, directement contre
`googlefonts/noto-emoji/svg/emoji_u1fa97.svg` : mêmes données de tracé, même
palette de neuf couleurs. Les autres reposent sur la correspondance Iconify.

**Deux enseignements, et ils comptent plus que les sept fichiers :**

1. **SVG Repo redistribue bien du CC BY 4.0.** Trois des quatre fichiers SVG
   Repo qu'on a pu tracer sont CC BY 4.0 — une licence qui **impose**
   l'attribution. L'hypothèse optimiste (« probablement du CC0 ») est démentie
   par les données. Les 57 restants ne sont donc pas « probablement sans
   risque » : ils sont **inconnus**, avec un précédent défavorable.
2. **Le lot « non marqué » n'est pas propre.** L14 classait les 46 SVG sans
   marqueur en « production interne présumée, implicitement MIT ». Trois en
   viennent de Noto Emoji, Firefox OS Emoji et Emojione — dont un **CC BY 4.0
   sans la moindre attribution**. La présomption était fausse pour 3 fichiers
   sur 46.

### 3.3 Ce qui reste non traçable — 57 fichiers livrés

57 SVG livrés portent le marqueur SVG Repo et n'ont donné **aucune**
correspondance dans les 238 jeux Iconify. Ce n'est pas une preuve qu'ils ne sont
pas tiers : le corpus Iconify couvre des jeux d'icônes, pas les collections
d'illustrations que SVG Repo héberge aussi. Leur licence est **inconnue**, et
`assets/ASSET-LICENSES.md` le dit dans ces termes, avec la liste nominative.

Deux indices résiduels y sont consignés comme indices, pas comme conclusions :
`connection/wifi.svg` porte `<title>wifi_cover [#1033]</title>`,
`<desc>Created with Sketch.</desc>` et un groupe `id="Dribbble-Light-Preview"` ;
`connection/virtual.svg` porte `<title>Virtual Reality icons</title>`.

**Décision à prendre par le mainteneur** (ordre de coût croissant, inchangé par
rapport à L14 mais désormais documenté fichier par fichier) : tracer les 57 sur
svgrepo.com et consigner ; les remplacer par un jeu unique à licence connue
(Lucide MIT, Bootstrap Icons MIT, Tabler MIT, Material Symbols Apache-2.0) ; ou
les redessiner selon la charte de `images-a-faire/README.md`. **L'option 2 reste
la seule qui referme le risque immédiatement.**

### 3.4 Les 43 restants — présumés maison, à confirmer

Les 43 SVG livrés sans marqueur et sans correspondance Iconify contiennent des
commentaires structurels manuscrits **en français**, calés sur la nomenclature
du projet (`<!-- Grosse caisse (Bass Drum) - Notes 35/36 -->`,
`<!-- Clavecin (harpsichord) - GM 6 -->`) et sur la charte de
`images-a-faire/README.md`. C'est une bonne preuve d'authorship interne, pas une
preuve absolue — d'où le libellé « présumés MIT, à confirmer » et la question
posée au mainteneur : **ces 43 fichiers ont-ils été dessinés pour le projet ?**

### 3.5 Le vrai P1 : `public/lib/WebAudioFontPlayer.js` est GPL-3.0-or-later

C'est la découverte la plus lourde du lot, et elle n'était pas dans F-158.

`scripts/install-default-sf2.js` télécharge au `postinstall`, **sans épingler de
version**, le fichier `WebAudioFontPlayer.js` depuis `surikov.github.io`,
jsDelivr ou unpkg. Il est ensuite copié dans `dist/` (`vite.config.js`,
`copyStaticTree` inclut `lib`), embarqué dans l'image Docker
(`COPY /app/public/lib`) et **chargé par `public/index.html` dans chaque
navigateur**.

Preuves, au 2026-09-08 :

```
$ curl -s https://raw.githubusercontent.com/surikov/webaudiofont/master/package.json
  "license": "GPL-3.0-or-later"

$ curl -s .../master/npm/dist/WebAudioFontPlayer.js | grep -i gpl
  console.log('WebAudioFont Engine v3.0.04 GPL3');

$ # registre npm, 42 versions publiées :
$ #   MIT              -> 2.0.1 … 2.5.48   (27 versions)
$ #   GPL-3.0-or-later -> 2.5.49 … 3.0.4   (15 versions)
```

**Le paquet était MIT et a été relicencié en GPL-3.0-or-later à partir de
2.5.49.** Comme le script n'épingle rien, une installation faite avant ce
basculement a vendorisé du MIT et une installation faite aujourd'hui vendorise
du GPL-3 : *la licence a changé sous le projet, sans le moindre changement de ce
côté-ci*. Le commentaire de `install-default-sf2.js:54-55` — « its license is not
redistributable freely without attribution » — sous-estime très largement la
situation.

Conséquence : **un build produit aujourd'hui distribue du GPL-3.0-or-later à
l'intérieur d'un produit annoncé MIT.** Aucune ligne d'attribution ne résout ça.
Trois issues, à trancher par le mainteneur :

1. **Épingler `webaudiofont@2.5.48`**, dernière version MIT. R11 vient de
   livrer exactement les deux leviers nécessaires : `GMBOOP_WAF_PLAYER_VERSION`
   (qui transforme les miroirs npm en URL immuables ; défaut `''` → `latest` au
   moment où j'écris) et `PINNED_SHA256.player` (encore `null`). Il suffit de
   fixer `2.5.48` comme défaut et d'y coller le digest correspondant.
2. **Assumer le GPL-3** pour le bundle distribué — ce qui contraint la
   distribution de tout le frontend.
3. **Remplacer** la bibliothèque par un lecteur SF2/WebAudio permissif.

**L'ordre compte : la version doit être choisie AVANT d'épingler le SHA-256.**
Épingler le digest de ce que le CDN sert aujourd'hui fige la version GPL-3 et
donne l'illusion que la question est réglée.

C'est aussi la démonstration de l'intérêt d'une porte CI de licences : le
problème n'est né d'aucune décision interne, seulement du passage du temps sur
une dépendance non épinglée.

*(Note connexe : `src/api/wafProxyRoutes.js` relaie au runtime les wavetables de
`surikov.github.io/webaudiofontdata/sound/`. Elles sont **traversées, jamais
stockées ni redistribuées** ; l'amont ne déclare pas de licence propre et
renvoie aux licences de GeneralUserGS.sf2 et FluidR3.sf2. Consigné en §3 de
`assets/ASSET-LICENSES.md` à titre informatif — si ces fichiers sont un jour mis
en cache sur disque, l'entrée cesse d'être informative.)*

### 3.6 Soundfont par défaut

`assets/sf2/default.sf2` (GeneralUser GS v1.471, S. Christian Collins) est
consigné : licence permissive, redistribution du fichier **non modifié** avec
**crédits conservés**. Deux réserves :

- le texte de licence n'est **ni livré ni téléchargé** — vérifié :
  `grep -n "License v2.0\|\.txt" scripts/install-default-sf2.js` → aucun
  résultat. Tant qu'il ne se trouve pas à côté du `.sf2`, la clause « credits
  remain intact » ne repose que sur `assets/ASSET-LICENSES.md` ;
- aucune vérification SHA-256 n'existe : `fetchVerified()` contrôle une taille
  minimale et l'en-tête `RIFF…sfbk`, rien d'autre.

Ces deux points sont **le périmètre de R11** ; `assets/sf2/README.md` n'a pas été
touché.

---

## 4. Outillage livré

`scripts/audit/licenses.mjs` — script ESM autonome, sans dépendance :

```bash
node scripts/audit/licenses.mjs            # synthèse lisible
node scripts/audit/licenses.mjs --json     # matrice par paquet
node scripts/audit/licenses.mjs --emit     # (re)génère THIRD-PARTY-NOTICES.md
node scripts/audit/licenses.mjs --assets   # inventaire des assets livrés
node scripts/audit/licenses.mjs --check    # porte CI, sortie 1 en cas de problème
```

`--check` échoue si : une dépendance runtime est copyleft ; une dépendance n'a
pas de licence établissable ; `THIRD-PARTY-NOTICES.md` est absent ou périmé
(c'est-à-dire si `--emit` le modifierait) ; **ou** si un asset livré n'est pas
enregistré dans `assets/ASSET-LICENSES.md`.

Ce dernier point est ce qui rend l'inventaire durable : ajouter une icône sans
écrire d'où elle vient fait échouer la porte. Vérifié dans les deux sens —
107/107 assets enregistrés aujourd'hui, et l'ajout d'un fichier non déclaré fait
bien sortir 1.

C'est le job `licenses` réclamé par `14_DOCS_RELEASE.md` §5.2 ; le câbler dans
`.github/workflows/ci.yml` appartient au lot CI.

---

## 5. Ce qui reste ouvert

### Décisions que l'utilisateur doit prendre

1. **Titulaire du copyright** — garder `glloq`, ou un nom civil / une entité ?
2. **Année de départ** — `2026` est le plus ancien élément vérifiable ici ; le
   clone est superficiel. Élargir en `2024-2026` / `2025-2026` si le dépôt
   complet le montre.
3. **`WebAudioFontPlayer.js`** — épingler 2.5.48 (MIT), assumer le GPL-3, ou
   remplacer. **Bloquant pour toute redistribution présentée comme MIT.**
4. **Les 57 icônes SVG Repo** — tracer, remplacer, ou redessiner.
5. **Les 43 icônes présumées maison** — confirmer qu'elles ont bien été dessinées
   pour le projet.

### Travaux appartenant à d'autres lots

| Lot | À faire | Pourquoi |
|---|---|---|
| **R09 / F-157** (packaging) | `Dockerfile` : copier `LICENSE` et `THIRD-PARTY-NOTICES.md` ; faire arriver `assets/ASSET-LICENSES.md` dans l'image (aujourd'hui `assets/` est copié depuis l'étage *builder*, qui ne le reçoit jamais). `.dockerignore` : ajouter `!THIRD-PARTY-NOTICES.md` — la règle `*.md` de la racine l'exclut. | Une attribution qui ne voyage pas avec la copie ne remplit pas son office |
| **R11** | `assets/sf2/README.md` : retirer l'affirmation SHA-256 et celle du téléchargement du texte de licence, **ou** implémenter les deux | Les deux affirmations sont fausses (vérifié) |
| **R11** | Choisir la version de `WebAudioFontPlayer.js` (§3.5) **avant** de remplir `PINNED_SHA256.player` | Le mécanisme est en place (`GMBOOP_WAF_PLAYER_VERSION`, `PINNED_SHA256`), mais épingler le digest du `latest` actuel figerait la version GPL-3 |
| **Lot CI** | Ajouter le job `licenses` : `node scripts/audit/licenses.mjs --check` | Rien n'empêche aujourd'hui l'entrée d'une dépendance copyleft ou d'une icône non déclarée |
| **Lot `package.json`** | Régénérer `package-lock.json` : `mqtt` y est déclaré en `dependencies: "*"` en plus de `optionalDependencies` (§2.4) | `npm ci` le rend obligatoire et non borné |

### Non fait, volontairement

- **Aucune licence n'a été inventée.** Les 57 icônes non traçables sont écrites
  « inconnue », pas « probablement CC0 ». Un fichier d'attribution qui invente
  des sources crée exactement le risque qu'on essaie de refermer.
- **Aucun asset n'a été supprimé ni remplacé** : c'est une décision produit
  (cohérence visuelle, 57 fichiers), pas une correction de licence.
- `CONTRIBUTING.md` n'a pas été modifié ; il gagnerait une ligne « tout asset
  ajouté doit être enregistré dans `assets/ASSET-LICENSES.md` », mais il est hors
  périmètre de ce lot.

---

## 6. Fichiers touchés

| Fichier | Nature |
|---|---|
| `LICENSE` | **créé** — MIT + renvoi vers les deux inventaires |
| `THIRD-PARTY-NOTICES.md` | **créé** — généré (288 Ko), 271 paquets, 166 textes verbatim |
| `assets/ASSET-LICENSES.md` | **créé** — inventaire des assets, attributions, points ouverts |
| `scripts/audit/licenses.mjs` | **créé** — inventaire + génération + porte CI |
| `README.md` | badge → `./LICENSE` ; section « License » réécrite (section licence uniquement) |
| `scripts/audit/README.md` | section documentant le nouveau script |
| `docs/audit/2026-09-07/WAVE2_R10.md` | ce compte rendu |

Aucun fichier de test, aucun fichier `src/`, aucun fichier tenu par un autre lot
n'a été modifié.
