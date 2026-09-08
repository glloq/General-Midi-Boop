# Vague 2 — R6 & R11 · compte rendu

**Portée :** `public/index.html`, `vite.config.js`, `src/api/HttpServer.js`,
`src/api/wafProxyRoutes.js` (+ `src/api/wafChecksums.json`),
`scripts/install-default-sf2.js`, `assets/sf2/README.md`.
**Findings visés :** F-14 (P1), F-87 (P1), F-119 / F-88 (R6) · F-109 (P1), F-15 (R11).

---

## R6 — Réparer l'offline-first (F-14, F-87, F-119)

### Le problème, tel qu'il était

Une chaîne de trois défauts, dont **chacun suffisait à recréer la panne** :

1. `vite.config.js:19` — `const dirs = ['js', 'locales', 'assets', 'styles']`.
   `lib/` n'y était pas. Or `Install.sh` lance `npm run build` et l'unité
   systemd pose `NODE_ENV=production`, donc `HttpServer` sert `dist/` — qui ne
   pouvait pas contenir le player. **La vendorisation était annulée sur toute
   installation de production**, même quand le `postinstall` avait parfaitement
   réussi.
2. `HttpServer.js` — le repli SPA `get('*')` renvoyait `index.html` pour
   *n'importe quel* chemin non résolu, extensions comprises. Mesuré :
   `GET /lib/WebAudioFontPlayer.js` → **HTTP 200, `text/html`, 615 825 octets**.
   Le navigateur refusait d'exécuter, la garde
   `typeof WebAudioFontPlayer === 'undefined'` était donc **toujours vraie**, et
   aucun 404 n'apparaissait jamais dans les journaux : le défaut était invisible
   à l'exploitation.
3. `public/index.html:6011` — un `document.write` d'une balise `<script>` vers
   `surikov.github.io`. Un script inséré par `document.write` est
   *parser-blocking* : **174 des 191 `<script>` étaient derrière lui**, et le
   document restait `readyState === 'loading'` jusqu'à ce que le réseau réponde
   ou expire. Sur un Pi hors-ligne, l'attente ne servait à rien : au bout du
   compte `WebAudioFontPlayer` restait `undefined` de toute façon.

### Ce qui a été fait

1. **`vite.config.js` — `lib` entre dans la liste copiée.** Au passage,
   `copyStaticTree` lit maintenant `outDir` depuis la configuration résolue
   (`configResolved`) au lieu de le coder en dur sur `./dist` : un
   `vite build --outDir <chemin>` copiait les arbres statiques ailleurs que le
   reste du build. C'est aussi ce qui rend la vérification testable sans écrire
   dans le dépôt.
2. **`HttpServer.js` — un asset absent répond 404.** Un chemin dont le dernier
   segment porte une extension (`ASSET_PATH`, exporté pour les tests) est un
   *asset*, jamais une route SPA : la SPA n'a **aucun routage d'historique**
   (rien n'appelle `pushState`), donc toute URL navigable est sans extension. La
   réponse est `404 text/plain`, ~9 octets au lieu de 615 Ko. Même classe que
   F-10 (`/api/*`), fermée par L01 sur la surface API.
3. **`public/index.html` — le repli réseau est supprimé, pas remplacé.** La
   garde reste, mais elle pose `window.__GMBOOP_AUDIO_PREVIEW_UNAVAILABLE__` et
   écrit un `console.warn` disant quoi relancer. Zéro requête, zéro blocage. La
   dégradation gracieuse existait déjà en aval (`MidiSynthesizer.initialize()`
   lève `WebAudioFontPlayer not loaded`) : le repli CDN n'apportait aucune
   robustesse, il ajoutait seulement un point de blocage réseau devant elle.

> **Ce qui n'a PAS été fait, volontairement.** Verser le player dans le dépôt —
> l'autre remède proposé par l'audit — reste exclu : R10 a établi que
> `WebAudioFontPlayer.js` est **GPL-3.0-or-later** depuis la version 2.5.49.
> Committer ce fichier dans un dépôt annoncé MIT aggraverait le problème.
> Détail et arbitrage : `WAVE2_R10.md` §3.5.

### Mesure avant / après — harnais E2E L08 (`node tests/e2e/run.mjs 01`)

Même harnais, même machine, même latence réseau injectée (`E2E_CDN_STALL_MS=8000`,
le proxy du conteneur refusant sinon en ~30 ms, ce qui masquerait le problème).

| Mesure | Avant | Après |
|---|---|---|
| Requête CDN émise au démarrage | **1** | **0** |
| `DOMContentLoaded` | **8 388 ms** | **813 ms** |
| Blocage imputable au CDN | **≈ 8 000 ms** (1:1 avec la latence) | **0 ms** |
| `GET /lib/WebAudioFontPlayer.js` (absent) | 200 · `text/html` · 615 825 o | **404** · `text/plain` · 9 o |
| Suite `01 · boot` | 1 PASS / 2 FAIL | **3 PASS / 0 FAIL** |

Le blocage ne suit plus la latence : il n'existe plus. Les deux assertions de
caractérisation ont été **inversées** dans `tests/e2e/specs/01-boot.spec.mjs`
(`cdnRequested > 0` → `cdnRequested === 0`) plutôt que relâchées, et une
assertion a été ajoutée pour que « sous le délai » ne puisse pas passer à
7 999 ms : `DOMContentLoaded < stallMs / 2`.

Suite E2E complète : **3 PASS / 10 FAIL avant → 5 PASS / 8 FAIL après**. Les
deux nouveaux verts sont exactement F-87 et F-88. Les huit rouges restants sont
inchangés et appartiennent à d'autres findings (F-86 ×2, F-90, F-95 ×4, F-94).

### Tests livrés

- `tests/audit/r6-offline-first.test.js` — index.html sans `document.write` ni
  origine externe, 191 `<script>` tous locaux, garde qui dégrade au lieu de
  bloquer ; **et un vrai `vite build`** (≈ 1,7 s) vers un `outDir` temporaire qui
  prouve que `lib/` arrive dans la sortie. La sonde s'appelle
  `.r6-vite-copy-probe`, jamais `WebAudioFontPlayer.js` : le test ne doit pas
  pouvoir laisser un faux player derrière lui.
- `tests/audit/r6-static-asset-404.test.js` — serveur Express **réel**
  (`HttpServer`, port 8301 avec repli éphémère) : 404 `text/plain` sur asset
  absent, jamais `text/html` ; un asset existant est toujours servi ; les
  chemins sans extension reçoivent toujours la SPA ; `/api/inconnu` reste un 404
  JSON (F-10 non régressé).
- `tests/audit/l11-offline-first.test.js` — les assertions marquées
  « À INVERSER » par L11 l'ont été.

---

## R11 — Intégrité des assets d'installation (F-109, F-15)

### Le problème, tel qu'il était

Le grep de l'audit résume tout :

```
$ grep -n "sha256\|checksum\|createHash\|integrity" scripts/install-default-sf2.js
(aucune occurrence)
```

Ce qui existait : un plancher de 50 Ko sur le player, 1 Mo + les octets magiques
`RIFF`/`sfbk` sur le SF2. Cela attrape une page d'erreur, et rien d'autre — un
player de 120 Ko augmenté d'une ligne passe sans difficulté. Et l'un des cinq
miroirs suivait une **branche mouvante** (`…/gh/surikov/webaudiofont@master/…`) :
son contenu changeait sans qu'une ligne du dépôt ne bouge. Ce n'est pas un
scénario d'attaque, c'est son fonctionnement nominal.

Volet runtime, plus grave encore : `GET /api/waf/:filename` va chercher du JS
tiers, le met en cache 30 jours et le **rejoue depuis notre origine**. ORB
*était* la frontière ; la contourner transforme un script tiers en script
**same-origin**, donc **immunisé à toute CSP `script-src 'self'`** — sur un
boîtier dont le WebSocket expose `system_update`.

Enfin `assets/sf2/README.md:12` **affirmait une vérification SHA-256 qui
n'existait pas**. Une documentation qui affirme un contrôle inexistant est pire
que son absence : elle empêche l'opérateur de se poser la question.

### Ce qui a été fait

1. **`scripts/install-default-sf2.js` — le mécanisme existe et il est bruyant.**
   - `PINNED_SHA256` (avec surcharges `GMBOOP_SF2_SHA256` /
     `GMBOOP_WAF_PLAYER_SHA256`), `sha256File()`, `assertChecksum()`.
   - Divergence ⇒ **artefact supprimé + sortie non nulle**, donc `npm install`
     s'arrête. C'est la **seule** sortie non nulle du script : un miroir
     injoignable reste non fatal, parce que c'est un problème de réseau, pas de
     chaîne d'approvisionnement.
   - Le contrôle est appliqué **des deux côtés** : après téléchargement **et**
     sur le chemin d'idempotence. `alreadyPresent()` compare désormais
     l'empreinte, plus seulement la taille — sinon un fichier déjà altéré
     n'était jamais re-contrôlé.
   - Une divergence **n'essaie pas le miroir suivant** : chercher des octets qui
     passent est exactement le contraire du but.
   - **URL épinglées** : le miroir à branche mouvante est supprimé ;
     `GMBOOP_WAF_PLAYER_VERSION` rend les miroirs npm immuables ; et
     `GMBOOP_SF2_URL` / `GMBOOP_WAF_PLAYER_URL` sont désormais **exclusifs** —
     un opérateur qui désigne son miroir a épinglé sa chaîne, retomber
     silencieusement sur un CDN public est précisément la substitution qu'il
     voulait empêcher.
   - `GMBOOP_REQUIRE_PINNED_ASSETS=1` refuse tout artefact non épinglé.
2. **`src/api/wafProxyRoutes.js` — le proxy est *fail-closed*.**
   `GMBOOP_WAF_PROXY` vaut `pinned` (défaut), `open` ou `off`.
   - `pinned` : seul un nom présent dans `src/api/wafChecksums.json` est allé
     chercher, et son corps doit correspondre au digest. Un nom non épinglé est
     refusé **avant toute requête sortante** (403) — donc rien d'inconnu n'est
     jamais rejoué, et un boîtier hors-ligne répond instantanément au lieu
     d'attendre les 8 s de timeout CDN.
   - Divergence de digest ⇒ **502, journalisé en `error` avec les deux
     empreintes, et non mis en cache** : une réponse empoisonnée ne doit pas
     devenir la réponse de tout le monde pendant 30 jours.
   - Une table de pins illisible donne une table **vide**, pas un contournement.
   - `open` restaure le comportement d'avant l'audit et le **dit** en warning au
     démarrage ; `off` coupe la route sans toucher au réseau.
3. **`assets/sf2/README.md` — l'affirmation mensongère est corrigée**, et
   nommée comme telle plutôt que discrètement effacée. Le README dit maintenant
   ce qui est implémenté, ce qui ne l'est pas, et comment renseigner un digest.
   Deuxième affirmation fausse corrigée au passage : le script **ne télécharge
   pas** le fichier de licence amont, contrairement à ce qui était écrit.

### Ce que ce lot ne prétend PAS avoir fait

**Aucun digest de référence n'est épinglé.** `PINNED_SHA256.sf2` et
`PINNED_SHA256.player` valent `null`. Le bac à sable d'exécution n'a accès ni à
`surikov.github.io`, ni à jsDelivr, ni à unpkg (`CONNECT` refusé par la
passerelle), et de toute façon hacher ce qu'un miroir sert aujourd'hui n'est pas
une vérification : ce serait épingler l'attaque plutôt que l'artefact.

Conséquence assumée et **visible** : le script imprime
`integrity NOT verified` à chaque exécution, et le README le dit noir sur blanc.
La procédure d'épinglage est documentée aux deux endroits.

Conséquence de `pinned` + table vide : **les banques WAF « legacy » sont
indisponibles**. La banque par défaut `sf2:default` et toutes les banques SF2
importées ne passent pas par cette route et ne sont pas affectées ; un refus
remonte au synthétiseur exactement comme un CDN injoignable — c'est-à-dire ce
que voit déjà tout boîtier hors-ligne. `GMBOOP_WAF_PROXY=open` reste la porte de
sortie explicite.

### Point de licence — à trancher par le mainteneur (R10 §3.5)

`webaudiofont` est **MIT jusqu'à 2.5.48 et GPL-3.0-or-later à partir de
2.5.49**. **L'ordre compte : choisir la version AVANT d'épingler le SHA-256.**
Épingler le digest de ce que le CDN sert aujourd'hui figerait la version GPL-3
dans un produit annoncé MIT *et* donnerait l'illusion que la question est
réglée. Les deux leviers nécessaires sont livrés
(`GMBOOP_WAF_PLAYER_VERSION`, `PINNED_SHA256.player`) ; **aucune version par
défaut n'est fixée ici**, c'est une décision produit. Le rappel est écrit dans
le script et dans `assets/sf2/README.md`.

### Tests livrés

- `tests/audit/r11-asset-integrity.test.js` — helpers (digest correct : gardé ;
  divergent : **supprimé** + message complet ; aucun pin : « NOT verified »,
  jamais un succès silencieux) **et le script réel exécuté de bout en bout**
  dans un échafaudage jetable sous `/tmp` (il dérive tous ses chemins de sa
  propre position, donc il ne peut pas atteindre le dépôt) : pins corrects →
  exit 0 ; pin divergent → **exit 1** + fichier supprimé ; SF2 altéré déjà
  installé → re-contrôlé, pas cru sur sa taille ; miroir injoignable → exit 0 ;
  `GMBOOP_REQUIRE_PINNED_ASSETS=1` → refus. Plus les assertions sur la
  véracité du README.
- `tests/audit/r11-waf-proxy-pinning.test.js` — non épinglé → 403 **et zéro
  appel sortant** (l'appel amont est espionné : l'émettre est l'échec) ; digest
  conforme → 200 `application/javascript` ; digest divergent → 502, journalisé
  avec les deux empreintes, **et absent du cache** ; `off` → 404 sans réseau ;
  `open` → passe et le warning est émis ; table illisible → vide.

---

## État final

| Contrôle | Résultat |
|---|---|
| `npm test` | **207 suites · 2 821 tests · 0 échec** |
| `npx vitest run` | **86 fichiers · 1 560 tests · 0 échec** |
| `npx eslint src/ public/js/ tests/` | **0 erreur** (203 warnings, aucun dans les fichiers touchés) |
| `npx tsc --noEmit` | clean |
| `prettier --check` sur les fichiers touchés | clean |
| `node tests/e2e/run.mjs` | 5 PASS / 8 FAIL (avant : 3 / 10) — les 8 restants sont d'autres findings |

Aucune régression. `config.json` non modifié.

## Ce qui reste ouvert

1. **Renseigner `PINNED_SHA256`** — bloqué par l'absence de réseau ici, et
   **subordonné au choix de version du player** (licence, R10 §3.5).
2. **Remplir `src/api/wafChecksums.json`** — même dépendance. Tant qu'il est
   vide, les banques WAF legacy sont refusées.
3. **Le drapeau `__GMBOOP_AUDIO_PREVIEW_UNAVAILABLE__` n'a pas encore de
   consommateur UI.** Le message part en console et l'utilisateur voit l'échec
   au premier clic sur « écouter » (dégradation préexistante de
   `MidiSynthesizer`). Un bandeau dans Réglages / Diagnostic demanderait une
   clé i18n dans les 28 locales — hors périmètre de ce lot.
4. **`public/lib/WebAudioFontPlayer.js` reste non versionné** (`.gitignore:70`).
   L'absence est donc un état nominal ; c'est pourquoi les correctifs 1 et 2
   comptent autant que la suppression du repli.
