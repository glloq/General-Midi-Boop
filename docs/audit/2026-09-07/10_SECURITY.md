# 10 — Sécurité (lot L10, plan §AH, AI, AJ, AK)

**État global : FAIL — le socle applicatif est bon, la porte d'entrée ne l'est pas**
· Niveau 4

**Date :** 2026-09-07 · **Commit de base :** `8dc170e` (baseline L00) · **Version :** 0.8.1
**Environnement :** Linux x86_64, Node v22.22.2, pas de Pi, pas de BLE, pas de D-Bus,
pas de matériel MIDI. Serveur de test local : `http://127.0.0.1:8110`, base
`…/scratchpad/L10/gmboop.db`, token `L10AUDITTOKEN0123456789abcdef`.
**Cible sondée :** ce serveur local uniquement. Aucune cible externe.
`git diff --stat config.json` → vide (aucun fichier partagé modifié).

---

## 0. Ce que ce lot confirme et ce qu'il renverse

L'audit du 2026-08-22 concluait « posture solide, un seul manque systémique ». Le
socle **tient** : requêtes préparées partout, `execFile(cmd, [argv])` sans shell,
pollution de prototype bloquée, trames > 16 Mo refusées, traversée de chemin
bloquée, stockage de fichiers adressé par contenu, comparaison de token en temps
constant. Tout cela a été re-vérifié aujourd'hui et **passe**.

Trois choses changent la conclusion :

1. **Le WebSocket — qui porte les 270 commandes, dont `system_update` et
   `system_shutdown` — accepte un client non authentifié qui forge deux en-têtes.**
   Ce n'était pas une découverte nouvelle en soi (le commentaire du code décrit
   le bypass), mais **le raisonnement écrit dans le code pour le justifier est
   faux**, et surtout `GMBOOP_SECURITY_MODE=secure` — la parade documentée — **ne
   s'applique pas au WebSocket**. Démontré (F-108).
2. **Une XSS DOM confirmée** existe bel et bien, dans un chemin que le balayage
   d'août n'a pas atteint : le **nom d'un appareil BLE**, contrôlé par quiconque
   dispose d'une radio Bluetooth à portée, atterrit non échappé dans un attribut
   HTML. Exécution prouvée dans un Chromium réel (F-110).
3. **La chaîne d'approvisionnement est pire que décrite** : il n'y a pas deux
   assets non vérifiés téléchargés une fois à l'installation, il y a **cela plus
   un proxy same-origin (`/api/waf/:filename`) qui rejoue au runtime du
   JavaScript tiers depuis `surikov.github.io` et le sert comme script de notre
   propre origine** — ce qui neutralise d'avance toute CSP `script-src 'self'`.
   Et `assets/sf2/README.md:12` **affirme une vérification SHA-256 que le script
   ne fait pas** (F-109).

À l'inverse, **F-05 est infirmé** : `showConfirmModal` échappe bien son `message`
à HEAD. Le résidu réel était ailleurs et a été **corrigé** (F-111).

---

## 1. Synthèse — section × état × niveau × finding

| § | Domaine | État | Niv. | Finding |
|---|---|---|---|---|
| AJ | Authentification WebSocket | **FAIL** | 5 | **F-108** |
| AJ | Authentification HTTP (`/api/*`) | **PARTIAL** | 5 | **F-114** |
| AJ | Endpoints publics (`/health`, `/update-status`, `/capabilities`) | **PARTIAL** | 4 | **F-115** |
| AJ | Token : génération, stockage, comparaison | **PASS** | 4 | — |
| AI | XSS — balayage des 257 sinks | **FAIL** | 5 | **F-110** |
| AI | XSS — modales de l'éditeur MIDI (F-05) | **PASS** (corrigé) | 5 | **F-111** ✅ |
| AI | XSS — noms de fichiers (bout en bout, navigateur réel) | **PASS** | 5 | — |
| AH | Chaîne d'approvisionnement (installation + runtime) | **FAIL** | 4 | **F-109** |
| AH | Advisories npm | **PARTIAL** | 5 | **F-112** |
| AH | CSP / en-têtes helmet | **FAIL** | 5 | **F-113** |
| AH | Traversée de chemin (upload, blobstore, sf2, waf, statique) | **PASS** | 5 | — |
| AH | Injection de commande (`execFile`, `scripts/*.sh`) | **PASS** | 4 | — |
| AH | Injection SQL | **PASS** | 3 | — |
| AH | Escalade de privilège (sudoers) | **PARTIAL** | 2 | **F-116** |
| AK | Limites / DoS (débit, taille de trame, clients) | **PASS** | 4 | — |
| AK | Exceptions asynchrones non gardées (classe de F-18) | **PARTIAL** | 3 | **F-117** |
| AH | Pollution de prototype | **PASS** | 5 | — |

**Sévérités.** 3 findings P1 (F-108, F-109, F-110), 4 P2 (F-112, F-113, F-114,
F-116), 3 P3 (F-111 ✅ corrigé, F-115, F-117).

**Démontré vs théorique.** F-108, F-110, F-111, F-112, F-113, F-114, F-115 sont
**démontrés** (requête + réponse ci-dessous). F-109 est démontré pour l'absence
de contrôle et pour l'exécution du code, **théorique** pour la compromission de
miroir elle-même. F-116 et F-117 sont **structurels et non démontrés** — ils
exigent un vrai Pi (sudoers) ou du matériel MIDI.

---

## 2. Modèle de menace retenu

Ce n'est pas Internet public, et ce n'est pas rien non plus. Le boîtier est un
Raspberry Pi qui pilote des instruments physiques et qui, par conception, écoute
sur `0.0.0.0`. Trois adversaires plausibles, par ordre de vraisemblance :

| Adversaire | Accès | Ce que ça change |
|---|---|---|
| **Un autre appareil sur le réseau de salle** (backline partagée, LAN de lieu, hotspot) | TCP/8080 | Le token est *exactement* le secret qu'il n'a pas. Tout bypass qui ne demande pas le token lui ouvre les 270 commandes. |
| **Une radio à portée** (BLE, mDNS) | Aucun accès IP requis | Contrôle le contenu de chaînes affichées dans le navigateur de l'opérateur : noms BLE, noms de service mDNS. |
| **Le chemin réseau à l'installation** (le seul moment où le Pi n'est pas hors-ligne) | MITM ou miroir compromis | Livre du JavaScript exécuté ensuite dans le navigateur de l'opérateur, sur une origine qui parle au boîtier. |

Le point d'articulation : **le navigateur de l'opérateur est une cible de premier
rang**, parce que c'est lui qui détient la session authentifiée. Toute exécution
de code dans cette page vaut « exécution de n'importe quelle commande sur le
boîtier », `system_update` et `hotspot_enable` (root via sudoers) compris.

Ce que je **ne** dramatise **pas** : un Pi de salon derrière une box, allumé
2 heures par semaine, avec zéro appareil hostile, n'est menacé par presque rien
de ce qui suit. La sévérité ci-dessous est calibrée sur l'usage *scène / lieu
partagé*, qui est celui que le projet revendique.

---

## 3. F-108 — Le WebSocket accepte un client non authentifié qui forge deux en-têtes, et `security.mode=secure` n'y change rien — **P1, démontré**

### Constat

`src/api/WebSocketServer.js:155-236` (`verifyClient`) autorise une connexion sans
token dans deux cas :

- `Origin` est une boucle locale (`localhost`/`127.0.0.1`/`::1`) sur le port serveur ;
- `Origin.hostname == Host.hostname` et les ports concordent.

Le commentaire du code (l.160-165) justifie ainsi :

> *« Both headers are browser-set, so JS in a third-party page cannot forge them
> — XSS-style attacks therefore still hit the token gate below. A determined
> attacker with a custom HTTP client can match both, but at that point they can
> also just include the token, so the bypass adds no extra surface. »*

**La première moitié est juste. La seconde est fausse.** Un attaquant sur le LAN
avec un client HTTP quelconque peut faire correspondre les deux en-têtes ; il ne
peut *pas* « juste inclure le token », puisque le token est précisément le secret
qu'il n'a pas. Le bypass n'ajoute pas « aucune surface » : il **annule
entièrement** l'authentification pour tout client non-navigateur.

Et surtout : **`securityMode` n'est lu que dans `src/api/HttpServer.js`.**

```
$ grep -rn "SECURITY_MODE\|securityMode\|secureMode" src/ | grep -c "WebSocketServer"
0
```

Le mode `secure`, présenté dans `CLAUDE.md` et dans l'audit d'août comme la parade
pour les réseaux non fiables, **ne durcit que HTTP**.

### Preuve

Serveur lancé en `trusted-lan` (défaut), token configuré. Client Node, aucun
token présenté, seuls `Origin` et `Host` forgés :

```js
new WebSocket('ws://127.0.0.1:8110/', {
  headers: { Origin: 'http://127.0.0.1:8110', Host: '127.0.0.1:8110' }
});
```

```
WS OPEN — no token presented, only forged Origin/Host headers
  system_info   -> {"id":"0","type":"response","command":"system_info","version":1,
                    "data":{"platform":"linux","arch":"x64","nodeVersion":"v22.22.2",
                    "cpus":4,"totalMemory":16856092672,…}}
  system_status -> {"id":"1","type":"response","command":"system_status","version":1,
                    "data":{"uptime":155.39,"version":"0.8.1","devices":0,…}}
  system_check_update -> {"id":"3","type":"response",…,"data":{"version":"0.8.1",
                    "localHash":"99dcc20","currentBranch":"claude/system-audits-parallel-…",…}}
```

Puis **le même test, serveur relancé avec `GMBOOP_SECURITY_MODE=secure`** :

```
[…] INFO  HTTP security mode: secure

# HTTP — correctement fermé
$ curl -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8110/api/status
401
$ curl -o /dev/null -w "%{http_code}\n" -H "Sec-Fetch-Site: same-origin" http://127.0.0.1:8110/api/status
401
$ curl -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer L10AUDIT…" http://127.0.0.1:8110/api/status
200

# WebSocket — toujours ouvert, toujours sans token
WS OPEN — no token presented, only forged Origin/Host headers
  system_info   -> {"id":"0","type":"response","command":"system_info",…}
  system_status -> {"id":"1","type":"response","command":"system_status",…}
```

Je me suis délibérément arrêté aux commandes en lecture. `system_shutdown`,
`system_reboot`, `system_update`, `system_restore`, `hotspot_enable`,
`file_delete` sont enregistrées dans **le même registre**, sur **la même socket**,
et n'ont **aucune** vérification d'autorisation supplémentaire
(`src/api/commands/SystemCommands.js:783-795`).

### Scénario d'attaque

Un concert. Le Pi est sur le réseau Wi-Fi de la salle avec les consoles, les
téléphones du staff et les appareils du groupe précédent. Un appareil quelconque
sur ce réseau scanne le /24, trouve le port 8080, ouvre :

```
GET / HTTP/1.1
Host: 192.168.1.42:8080
Origin: http://192.168.1.42:8080
Upgrade: websocket
```

et envoie `{"id":1,"command":"system_shutdown"}` pendant le set. Ou
`hotspot_enable` pour arracher le boîtier du réseau. Ou `system_update`, qui
déclenche un `git pull` + `npm install` (donc l'exécution de scripts de paquets)
+ redémarrage.

Coût pour l'attaquant : dix lignes de script. Pré-requis : être sur le réseau.
Le token, la seule chose qui devait l'arrêter, n'est jamais demandé.

### Sévérité : **P1**

Sur un LAN domestique fermé : faible. Sur un réseau de salle partagé — l'usage
revendiqué — c'est la perte complète du contrôle d'accès, sur l'intégralité de la
surface de commande, avec impact physique (instruments qui s'arrêtent en plein
set). Et la parade documentée ne parade pas.

### Correctif proposé (diff — `src/api/WebSocketServer.js` appartient au socle API, non modifié ici)

Deux changements, indépendants :

```diff
--- a/src/api/WebSocketServer.js
+++ b/src/api/WebSocketServer.js
@@
   start() {
     const apiToken = process.env.GMBOOP_API_TOKEN;
     const serverPort = this.config?.server?.port || 8080;
+    // Le mode sécurité doit s'appliquer à TOUTE la surface d'API, pas au seul
+    // HTTP : le WebSocket porte les 270 commandes, dont system_update /
+    // system_shutdown (audit L10 F-108).
+    const secureMode =
+      (process.env.GMBOOP_SECURITY_MODE || this.config?.security?.mode || 'trusted-lan')
+        .toLowerCase() === 'secure';
+    this.logger.info(`WebSocket security mode: ${secureMode ? 'secure' : 'trusted-lan'}`);
@@
       verifyClient: ({ req }, done) => {
+        // En mode `secure`, aucun contournement : le token est exigé pour
+        // toute connexion, y compris same-origin et loopback.
+        if (secureMode) {
+          return checkToken(req, done);
+        }
         const origin = req.headers.origin || '';
         const host = req.headers.host || '';
@@
-            if (loopbackHosts.has(originHost) && originPort === String(serverPort)) {
+            // Le contournement loopback ne vaut que si la connexion vient
+            // RÉELLEMENT de la boucle locale : `Origin` est forgeable par tout
+            // client non-navigateur, l'adresse source ne l'est pas (audit L10 F-108).
+            const ra = req.socket?.remoteAddress || '';
+            const fromLoopback = ra === '::1' || ra === '127.0.0.1' || ra.startsWith('127.');
+            if (fromLoopback && loopbackHosts.has(originHost) && originPort === String(serverPort)) {
               done(true);
               return;
             }
```

Et, pour le contournement `Origin == Host` (qui ne peut pas être ancré sur
l'adresse source, puisque c'est justement le cas du SPA servi sur l'IP LAN) : le
seul durcissement honnête est de **le retirer du défaut** et de faire de `secure`
le mode par défaut, en documentant `trusted-lan` comme un assouplissement
explicite. À défaut, au strict minimum, **documenter dans `CLAUDE.md` que
`trusted-lan` signifie « tout client capable d'atteindre le port a tous les
droits, token ou pas »** — ce qui n'est pas ce que le texte actuel laisse
entendre.

**Priorité relative :** c'est le premier correctif à appliquer de tout ce lot.

---

## 4. F-109 — Chaîne d'approvisionnement : deux assets non vérifiés à l'installation, **plus** un proxy qui rejoue du JS tiers au runtime, **plus** un README qui affirme un contrôle inexistant — **P1**

### 4.1 Le volet installation (F-15 confirmé ouvert)

`scripts/install-default-sf2.js` (333 lignes) télécharge deux artefacts :

| Artefact | Destination | Miroirs (dans l'ordre) | Exécuté ? |
|---|---|---|---|
| `WebAudioFontPlayer.js` | `public/lib/` | `$GMBOOP_WAF_PLAYER_URL`, `surikov.github.io`, `cdn.jsdelivr.net/gh/surikov/…@master`, `cdn.jsdelivr.net/npm/webaudiofont`, `unpkg.com/webaudiofont` | **OUI — `<script src>` dans la SPA** |
| `default.sf2` (~30 Mo) | `assets/sf2/` | `$GMBOOP_SF2_URL`, 2 miroirs `raw.githubusercontent.com`, `schristiancollins.com` | Non — données parsées par `SF2Converter` |

```
$ grep -n "sha256\|checksum\|createHash\|integrity\|subresource" scripts/install-default-sf2.js
$ echo "exit=$?"
exit=0        # aucune occurrence
```

Ce qui *existe* comme contrôle : `MIN_PLAYER_SIZE = 50 KB`, `MIN_SF2_SIZE = 1 MB`,
et pour le SF2 les octets magiques `RIFF`/`sfbk`. Le code lui-même décrit ces
contrôles comme destinés à attraper « une page d'erreur ». C'est exact — et
c'est tout ce qu'ils attrapent. **Un miroir qui sert un autre contenu valide
passe.** Un `WebAudioFontPlayer.js` de 120 Ko contenant une ligne
supplémentaire passe le seuil de 50 Ko sans difficulté.

Le miroir noté « @master » (`cdn.jsdelivr.net/gh/surikov/webaudiofont@master`) est
particulièrement notable : **il suit une branche mouvante**, donc son contenu
change sans que rien dans le projet ne bouge. Ce n'est même pas un scénario
d'attaque, c'est le fonctionnement nominal.

### 4.2 Le volet runtime — non relevé en août

`src/api/wafProxyRoutes.js` monte `GET /api/waf/:filename` : le backend va
chercher le fichier sur `https://surikov.github.io/webaudiofontdata/sound/`, le
met en cache, et le **renvoie avec `Content-Type: application/javascript`**.

Et le frontend l'exécute :

```
public/js/audio/MidiSynthesizer.js:509,535,565   const base = '/api/waf/';
public/js/audio/MidiSynthesizer.js:899-900       const script = document.createElement('script');
                                                 script.src = instrumentInfo.url;
```

Trois conséquences :

1. **Ce n'est plus un risque « une fois à l'installation »** : c'est un risque à
   chaque chargement de préréglage, sur toute la durée de vie du boîtier.
2. Le fichier est écrit dans le commentaire du module comme un contournement de
   CORB/ORB. C'est vrai. Mais la protection CORB *était* la frontière
   d'origine : la contourner transforme un script tiers en **script
   same-origin**.
3. Par conséquent, **une CSP `script-src 'self'` n'y peut rien** : `/api/waf/…`
   *est* `'self'`. Le durcissement F-113 ne couvre pas ce chemin.

### 4.3 Le README affirme un contrôle qui n'existe pas

`assets/sf2/README.md:9-12` :

> *« It is fetched once by the postinstall script `scripts/install-default-sf2.js`,
> which runs automatically after `npm install` and is idempotent (no re-download
> if the file already exists **and matches the expected SHA-256**). »*

Il n'y a pas de SHA-256 attendu. `alreadyPresent()` teste `statSync(…).size >=
MIN_SF2_SIZE`. Une documentation qui affirme un contrôle inexistant est pire que
son absence : elle empêche l'opérateur de se poser la question. (Corrobore le
constat de L14.)

### Scénario d'attaque

Le seul moment où le boîtier « offline-first » n'est pas hors-ligne, c'est
`npm install`. Souvent : hotspot d'un téléphone, Wi-Fi d'un lieu, réseau
d'atelier. Un attaquant sur ce chemin, ou en contrôle d'un des cinq miroirs du
player, sert un `WebAudioFontPlayer.js` valide augmenté de :

```js
new WebSocket(location.origin.replace('http','ws') + '/')
  .onopen = function () { this.send('{"id":1,"command":"system_update"}'); };
```

Le fichier fait 120 Ko, passe le seuil de 50 Ko, s'installe sous
`public/lib/`, et s'exécute **à chaque ouverture de la SPA, indéfiniment**, sur
l'origine qui détient la session authentifiée. Et via F-108, la trame passe même
sans token.

Aucune étape de ce scénario n'est bloquée aujourd'hui. Ce qui le rend *théorique*
est uniquement la difficulté de se placer sur le chemin ou de compromettre un
miroir — pas une défense du produit.

### Sévérité : **P1**

Exécution de code arbitraire persistante dans le navigateur de l'opérateur, sur
un boîtier qui expose `system_update` et `hotspot_enable`. Le seul frein est
l'accès au chemin réseau à l'installation.

### Correctif proposé (diff)

Le correctif juste comporte **trois** volets ; le premier seul est déjà décisif.

**(a) Verser `WebAudioFontPlayer.js` dans le dépôt.** ~120 Ko pour un fichier
figé. Cela supprime le téléchargement, supprime le miroir mouvant, **et ferme
F-14** (démarrage hors-ligne) d'un même geste. C'est le meilleur rapport
coût/effet de tout ce rapport. Sa licence exige une attribution, pas une
non-redistribution : un `public/lib/WebAudioFontPlayer.LICENSE` suffit.

**(b) Épingler et vérifier ce qui reste téléchargé** (le SF2, ~30 Mo,
raisonnablement non versionnable) :

```diff
--- a/scripts/install-default-sf2.js
+++ b/scripts/install-default-sf2.js
@@
-import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
+import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
+import { createHash } from 'crypto';
+
+// Sommes de contrôle épinglées des artefacts attendus. Générer avec :
+//   sha256sum assets/sf2/default.sf2
+// Un miroir qui sert autre chose — page d'erreur, build différent, contenu
+// altéré — est refusé bruyamment (audit L10 F-109). NE PAS mettre à jour ces
+// constantes sans avoir vérifié la provenance du nouvel artefact à la main.
+const EXPECTED_SHA256 = {
+  // GeneralUser GS v1.471 — à renseigner à partir d'un téléchargement vérifié
+  sf2: process.env.GMBOOP_SF2_SHA256 || null
+};
+
+function sha256File(p) {
+  return createHash('sha256').update(readFileSync(p)).digest('hex');
+}
+
+/**
+ * Refuse un artefact dont l'empreinte ne correspond pas. Échec BRUYANT :
+ * l'objectif est qu'un opérateur voie la divergence, pas qu'elle soit avalée
+ * comme les erreurs réseau (qui, elles, restent non fatales).
+ */
+function assertChecksum(path, expected, label) {
+  if (!expected) {
+    warn(`${label}: aucune somme de contrôle épinglée — intégrité NON vérifiée.`);
+    return;
+  }
+  const actual = sha256File(path);
+  if (actual !== expected) {
+    try { unlinkSync(path); } catch {}
+    throw new Error(
+      `${label}: SHA-256 MISMATCH — attendu ${expected}, obtenu ${actual}. ` +
+      `Le miroir a servi un contenu different de celui attendu. Artefact supprime.`
+    );
+  }
+  log(`${label}: SHA-256 verifie (${actual.slice(0, 16)}…).`);
+}
@@ async function installDefaultSF2() {
       await fetchVerified(url, downloadPath, 1024);
       const size = await materialiseSF2(downloadPath, TARGET_PATH);
+      assertChecksum(TARGET_PATH, EXPECTED_SHA256.sf2, 'default.sf2');
       log(`✓ Installed default soundfont (${(size / (1024 * 1024)).toFixed(1)} MB).`);
```

Et **`alreadyPresent()` doit vérifier l'empreinte, pas la taille** — sinon un
fichier déjà altéré n'est jamais re-contrôlé :

```diff
 function alreadyPresent() {
   try {
-    return statSync(TARGET_PATH).size >= MIN_SF2_SIZE;
+    if (statSync(TARGET_PATH).size < MIN_SF2_SIZE) return false;
+    if (!EXPECTED_SHA256.sf2) return true;
+    return sha256File(TARGET_PATH) === EXPECTED_SHA256.sf2;   // audit L10 F-109
   } catch {
     return false;
   }
 }
```

**(c) Fermer le proxy WAF au runtime.** Deux options, par ordre de préférence :

1. Le **supprimer**. Le commentaire de `MidiSynthesizer.js:499-502` indique que
   ce chemin n'est atteint que pour les « legacy banks » explicitement choisies
   par l'utilisateur ; la banque `sf2:default` et les banques SF2 importées
   court-circuitent tout. Un boîtier hors-ligne ne peut de toute façon pas
   l'atteindre.
2. Le conserver mais **épingler chaque fichier** :

```diff
--- a/src/api/wafProxyRoutes.js
+++ b/src/api/wafProxyRoutes.js
@@
+// Empreintes des fichiers WAF autorisés : le proxy sert du JS depuis NOTRE
+// origine, ce qui neutralise CORB et toute CSP `script-src 'self'`. Sans cette
+// table, un changement amont ou une compromission du CDN devient une exécution
+// de code same-origin (audit L10 F-109).
+import WAF_SHA256 from './wafChecksums.json' with { type: 'json' };
@@
     try {
       const result = await fetchFromCdn(filename);
+      if (result.status === 200) {
+        const digest = createHash('sha256').update(result.body).digest('hex');
+        if (WAF_SHA256[filename] !== digest) {
+          app.logger?.error?.(
+            `WAF proxy: SHA-256 mismatch pour ${filename} (attendu ${WAF_SHA256[filename]}, ` +
+            `obtenu ${digest}) — refus.`
+          );
+          return res.status(502).json({ error: 'Upstream integrity check failed' });
+        }
+      }
       cacheSet(filename, result);
```

**(d) Corriger le README** :

```diff
--- a/assets/sf2/README.md
+++ b/assets/sf2/README.md
@@
-`npm install` and is idempotent (no re-download if the file already exists
-and matches the expected SHA-256).
+`npm install` and is idempotent (no re-download if the file already exists and
+its SHA-256 matches the pinned value in `scripts/install-default-sf2.js`;
+when no checksum is pinned the script warns and only checks the file size).
```

---

## 5. F-110 — XSS DOM confirmée : le nom d'un appareil BLE s'échappe d'un attribut HTML — **P1, démontrée dans un navigateur réel**

### Constat

`public/js/features/BluetoothScanModal.js:278-302`, `renderAvailableDevice()` :

```js
const deviceName = device.name || t('bluetooth.device');
const deviceNameEscaped = escapeHtml(deviceName);
…
<div class="device-name">${deviceNameEscaped}</div>      // ← l.289 : échappé ✅
…
<button class="btn-pair" data-action="pair"
        data-device-id="${device.id || device.address}"
        data-device-name="${deviceName}">                 // ← l.297 : BRUT ❌
```

La variable échappée existe, elle est utilisée dans le corps du texte — et la
variable **brute** est utilisée dans l'attribut, à trois lignes d'écart. Ce
markup part dans `this.container.innerHTML` (l.129) et `modalDialog.innerHTML`
(l.834).

`device.name` remonte de :
`NobleBleAdapter.js:189` → `await device.getName()` (node-ble/BlueZ) →
`BluetoothManager.js:305` → `bluetooth_scan` → SPA.

C'est le **nom annoncé par le périphérique BLE**. Il est intégralement contrôlé
par quiconque possède un téléphone ou un ESP32 à portée radio. Aucun accès
réseau n'est requis.

### Preuve (Chromium réel, `playwright@1.56.1`, page servie par le serveur 8110)

Le code réellement livré est appelé tel quel, avec un nom d'appareil hostile :

```js
const evil = '"><img src=x onerror="window.__BLEXSS=1">';
const markup = window.BluetoothScanModal.prototype.renderAvailableDevice.call(inst, {
  id: 'AA:BB:CC:DD:EE:FF', address: 'AA:BB:CC:DD:EE:FF', name: evil, rssi: -50
});
host.innerHTML = markup;     // exactement ce que renderModalContent() fait
```

```json
{
 "injectedImg": true,
 "markupSnippet": "data-device-name=\"\"><img src=x onerror=\"window.__BLEXSS=1\">\">\n  🔗 common.pair",
 "fired": true
}
```

`fired: true` — le gestionnaire `onerror` s'est exécuté. Ce n'est pas une
analyse statique : c'est du JavaScript attaquant qui tourne dans la page.

La charge tient en 41 octets, largement sous les 29 octets utiles d'un nom BLE
court et très en dessous des 248 octets d'un alias BlueZ.

### Scénario d'attaque

L'opérateur veut appairer son clavier BLE. Il ouvre la modale Bluetooth — geste
parfaitement normal, c'est la fonctionnalité. Un appareil à portée annonce le nom
ci-dessus. La liste s'affiche, le `<img src=x>` échoue à charger, `onerror`
s'exécute. À partir de là, le script de l'attaquant est sur l'origine du SPA, avec
la session WebSocket authentifiée déjà ouverte : il peut envoyer n'importe quelle
commande, y compris `system_update`.

Pré-requis : être à portée Bluetooth, et que l'opérateur ouvre la modale. Sur une
scène, la portée est un couloir et la modale est ouverte à chaque montage.

### Sévérité : **P1**

XSS confirmée, déclenchable sans aucun accès réseau, sur un chemin fonctionnel
normal, aboutissant au contrôle complet de l'appareil. C'est la seule XSS
confirmée sur les 257 sinks — mais elle est confirmée.

### Correctif proposé (diff — hors de mon périmètre d'écriture, à appliquer en vague 2)

Une ligne :

```diff
--- a/public/js/features/BluetoothScanModal.js
+++ b/public/js/features/BluetoothScanModal.js
@@ -294,7 +294,9 @@ renderAvailableDevice(device) {
                     <button class="btn-pair" data-action="pair"
                             data-device-id="${device.id || device.address}"
-                            data-device-name="${deviceName}">
+                            <!-- Le nom BLE est annonce par le peripherique : contenu
+                                 hostile possible, echappement obligatoire meme en
+                                 contexte attribut (audit L10 F-110). -->
+                            data-device-name="${deviceNameEscaped}">
```

(`escapeHtml` échappe déjà `& < > " '` — l'ensemble OWASP — donc il est sûr en
contexte attribut ; aucun autre changement n'est nécessaire.)

**Balayage de la même classe.** J'ai écrit un scanner dédié aux interpolations
non échappées **en position d'attribut** (le scanner du dépôt ne les distingue
pas du contexte texte) : 87 occurrences, dont **une seule** porte une valeur
réellement contrôlée par un tiers — celle-ci. Les autres sont des chaînes i18n
littérales, des adresses MAC/IP contraintes par leur format, ou des valeurs déjà
échappées en amont que le scanner ne peut pas voir. Deux latences à noter, sans
exploitabilité aujourd'hui :

- `NetworkScanModal.js:271,281,315,326` — `data-device-ip="${deviceIp}"` brut.
  `deviceIp` vient du champ 7 de `avahi-browse -p` (`NetworkManager.js:200`),
  donc d'une adresse résolue par avahi, de forme IP. Le **nom** de service mDNS
  (champ 3), lui *serait* contrôlé par un attaquant du LAN — il est correctement
  échappé (`NetworkScanModal.js:266,310`).
- `BluetoothScanModal.js:286,296,332…` — `data-device-*="${device.address}"`
  brut : adresse MAC formatée par BlueZ.

Les deux méritent l'échappement par principe, aucune ne constitue un finding.

---

## 6. F-111 — `MidiEditorDialogs` : les noms d'instruments partaient bruts dans le fragment `details` — **P3, corrigé dans ce lot**

### F-05 est infirmé à HEAD

Le finding d'août affirmait que `showConfirmModal` « échappe le `title` mais
traiterait le `message` comme du HTML brut ». Ce n'est **plus** vrai —
`public/js/features/midi-editor/MidiEditorDialogs.js:38,58` :

```js
const esc = (s) => window.escapeHtml(s);
…
<p class="confirm-modal-message">${esc(message)}</p>
```

`title`, `message`, `confirmText`, `cancelText`, `extraButtons[].text/.value` sont
tous échappés. Vérifié par test (3 assertions vertes avant toute modification de
ma part). **F-05 : INFIRMÉ / déjà corrigé.**

### Le résidu réel

Restaient bruts, par conception documentée : `details` (fragment HTML) et `icon`
(emoji). Or `showChangeInstrumentModal()` construisait `details` ainsi :

```js
const instrumentRows =
  this._detailRow(m.t('midiEditor.currentInstrument'), currentInstrument) +   // brut
  this._detailRow(m.t('midiEditor.newInstrumentLabel'), newInstrument);       // brut
```

`_detailRow(label, value)` interpole `value` sans échappement, et `details` part
dans `innerHTML`. Le module voisin `showChangeChannelModal()` fait la chose
correcte au même endroit (il passe par `m.tHtml(...)`) — l'incohérence était
locale à ce chemin.

**D'où viennent ces valeurs ?** J'ai suivi la chaîne :
`MidiEditorChannelOps.js:223-224` → `channelInfo.instrument` et
`getInstrumentName(selectedProgram)` → `MidiEditorSequence.js:200-203` /
`MidiEditorCCPicker.js:374-376` → `MidiEditorModal.js:258` :

```js
getInstrumentName(index) {
  const translatedList = this.t('instruments.list');
  if (Array.isArray(translatedList) && translatedList[index]) return translatedList[index];
  return this.gmInstruments[index] || `Instrument ${index}`;
}
```

Table GM issue des locales livrées, ou libellé `Instrument N`. **Aucun nom de
fichier ni nom d'instrument saisi par l'utilisateur n'atteint ce chemin
aujourd'hui.** Le finding est donc du **durcissement**, pas une XSS exploitable —
je le dis explicitement plutôt que de le gonfler.

Il mérite quand même le correctif : c'est un sink brut qui reçoit une valeur
transportée sur quatre modules, et `CLAUDE.md` pose la règle inverse.

### Preuve rouge → vert

Test : `tests/frontend/l10-dialogs-html-escaping.test.js` (jsdom via Vitest ;
Jest ne peut pas charger `jsdom` dans ce dépôt). Le module IIFE réel et le vrai
`public/js/utils/escapeHtml.js` sont évalués — pas de réimplémentation.

**Avant** le correctif :

```
FAIL  tests/frontend/l10-dialogs-html-escaping.test.js
 > showChangeInstrumentModal escaping (F-111) > les noms d'instruments n'injectent pas de HTML
   AssertionError: expected 2 to be +0
 > le chemin 'sélection' échappe lui aussi les noms d'instruments
   AssertionError: expected 2 to be +0
 Tests  2 failed | 3 passed (5)
```

Deux éléments `<img>` réellement construits par le parseur HTML.

**Après** :

```
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

### Correctif appliqué

`public/js/features/midi-editor/MidiEditorDialogs.js` (dans mon périmètre) :

```diff
+      // `details` is injected raw into innerHTML by showConfirmModal (it is
+      // deliberately an HTML fragment), so every value that is NOT already an
+      // escaped tHtml() result must be escaped here. GM instrument names come
+      // from the trusted locale table today, but a custom-bank / user-entered
+      // label reaching this path would otherwise inject (audit L10 F-111).
+      const esc = (s) => window.escapeHtml(s);
       const instrumentRows =
-        this._detailRow(m.t('midiEditor.currentInstrument'), currentInstrument) +
-        this._detailRow(m.t('midiEditor.newInstrumentLabel'), newInstrument);
+        this._detailRow(m.t('midiEditor.currentInstrument'), esc(currentInstrument)) +
+        this._detailRow(m.t('midiEditor.newInstrumentLabel'), esc(newInstrument));
```

`showChangeChannelModal` n'est **pas** touché : il passe un résultat `tHtml()`,
et `CLAUDE.md` interdit de ré-échapper un `tHtml`. `icon` reste brut : tous les
appelants passent des emojis littéraux (`⚠️ 🎹 🎵 ❌ 🎚`) ; à documenter comme
sink brut assumé plutôt qu'à échapper au risque de casser un futur appelant
légitime.

ESLint : 0 erreur. Prettier : conforme.

---

## 7. F-112 — Advisories : `ws` reste vulnérable, les deux autres `high` sont inatteignables, la porte CI ne bloque rien — **P2, démontré**

### Mesure à HEAD

```
$ npm audit --omit=dev
8 vulnerabilities (1 low, 4 moderate, 3 high)
```

**Correction d'une erreur du baseline L00.** Le baseline attribue les 3 `high` à
la chaîne `xml2js → dbus-next → node-ble`. C'est faux : cette chaîne est
**`moderate`**. Les 3 `high` réels sont :

| Paquet | Sév. | Version installée | Chemin | Atteignable au runtime ? |
|---|---|---|---|---|
| **`ws`** | **high** | **8.20.0** (plage vulnérable 8.0.0–8.20.1) | **dépendance directe** | **OUI — c'est le serveur WebSocket lui-même** |
| `brace-expansion` | high | via `cacache@20` | `node-ble → dbus-next → usocket → node-gyp → make-fetch-happen → cacache` | **Non** |
| `ip-address` | high | 10.1.0 | `… → node-gyp → make-fetch-happen → @npmcli/agent → socks-proxy-agent → socks` | **Non** |

Les deux dernières viennent de **`node-gyp`**, que `usocket` déclare en
dépendance de production (`usocket/package.json`: `"node-gyp": "^7.1.2"`) alors
que c'est un outil de compilation. Ni `cacache` ni `socks-proxy-agent` n'est
jamais chargé par le serveur : leur `high` est du bruit d'arbre de dépendances.
**Ne pas les traiter comme des vulnérabilités du produit.**

Les 4 `moderate` :

| Paquet | Advisory | Atteignabilité réelle |
|---|---|---|
| `xml2js` <0.5.0 | pollution de prototype | Chargé **uniquement si le Bluetooth est actif**. `dbus-next` s'en sert pour parser l'XML d'introspection D-Bus, fourni par le bus système (donc par BlueZ, donc root). Un attaquant devrait déjà être root local. **Sévérité réelle : très faible.** |
| `dbus-next`, `node-ble` | dépendent de `xml2js` | idem |
| `qs` / `body-parser` (low) | DoS sur parsing | via `express`, atteignable sur la surface HTTP. Faible. |

**`ws` est le seul qui compte.** Divulgation de mémoire non initialisée
(`GHSA-58qx-3vcg-4xpx`) + épuisement mémoire par fragments minuscules
(`GHSA-96hv-2xvq-fx4p`), dans **la** surface d'API principale du produit — et,
via F-108, atteignable **sans token**. Le correctif est dans la plage `^8.14.2`
déjà déclarée : aucune rupture d'API.

### La porte CI ne bloque rien

`.github/workflows/ci.yml:45` :

```yaml
      - run: npm audit --omit=dev --audit-level=critical
```

`--audit-level=critical` ne fait échouer que sur `critical`. Il y a **0 critical**
et **3 high**. Vérifié aujourd'hui : le job passe au vert avec les 8
vulnérabilités présentes.

### Correctif proposé (fichiers partagés — diff, non appliqué)

```diff
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@
-      - run: npm audit --omit=dev --audit-level=critical
+      # `high` est le bon niveau : `ws` est une dépendance runtime directe et
+      # porte la surface d'API principale. Les high transitifs qui ne sont pas
+      # atteignables au runtime (chaîne node-gyp de node-ble) doivent être
+      # neutralisés explicitement par `npm audit --exclude` ou une entrée
+      # d'exception documentée, PAS en abaissant la porte (audit L10 F-112).
+      - run: npm audit --omit=dev --audit-level=high
```

```diff
--- a/package.json
+++ b/package.json
   "dependencies": {
-    "ws": "^8.14.2"
+    "ws": "^8.18.3"
   }
```

(La borne exacte est à confirmer au moment de l'application : il faut la première
`8.x` postérieure à `8.20.1`, ou la `8.x` corrigée que l'avis désignera alors.
`npm audit fix` résout dans la plage déjà déclarée — c'est un `npm install`, donc
hors de mon périmètre.)

Pour la chaîne `node-ble`, **ne pas** lancer `npm audit fix --force` : il propose
`node-ble@0.0.0`, une régression majeure qui casserait le transport BLE. La bonne
réponse est soit d'attendre l'amont, soit d'exclure explicitement la branche
`node-gyp` avec un commentaire justifiant l'inatteignabilité.

---

## 8. F-113 — CSP : l'arbitrage d'août n'est plus valable, une politique complète passe **aujourd'hui** sans casser la SPA — **P2, démontré**

### Constat

`src/api/HttpServer.js:140` : `contentSecurityPolicy: false`. Confirmé en direct :

```
$ node scripts/audit/live-probe.mjs http://127.0.0.1:8110
FAIL  [AH] helmet security headers present — CSP=no X-Content-Type-Options=nosniff
```

Les autres en-têtes helmet sont bien là (`X-Frame-Options: SAMEORIGIN`,
`Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`,
`Cross-Origin-Opener-Policy: same-origin`, HSTS).

### Ce qui bloque exactement — mesuré, pas supposé

L'audit d'août parlait de « 193 balises script inline ». C'est inexact et c'est
ce qui a fait renoncer :

```
total script tags: 193 | avec src: 191 | INLINE: 2
  bloc 0 :    204 octets  → le document.write() vers surikov.github.io (= F-14)
  bloc 1 : 397 380 octets → le code applicatif embarqué dans index.html
gestionnaires inline (onclick=…) : 16 dans index.html + 91 dans public/js  = 107
attributs style="…"              : 78 dans index.html + 1 001 dans public/js = 1 079
eval / new Function              : 0
javascript: URLs                 : 0
```

**191 des 193 balises ont un `src` local** : elles passent `script-src 'self'`
sans discussion. Il n'y a que **deux** blocs inline. Le blocage réel, ce sont les
**107 gestionnaires d'événements inline** — que ni un hash ni un nonce ne
couvrent (il faudrait `'unsafe-hashes'` plus un hash par gestionnaire) — et le
bloc applicatif de 397 Ko, qui exigerait un hash recalculé à chaque édition.

### Mesure directe en Chromium

J'ai injecté des politiques candidates via un reverse-proxy local (8113 → 8110)
pour ne pas toucher `HttpServer.js`, et chargé la SPA avec `playwright@1.56.1`.

**(A) CSP stricte `default-src 'self'`** — 23 violations distinctes :

```
[x1] Refused to execute inline script … "default-src 'self'" (hash 'sha256-fqbGzH09klFcoHipbUYo8vlRgszQT5skcByPmNqOaG0=')
[x1] Refused to execute inline script … (hash 'sha256-CMrk3xXh2HBWpm5FL8Ew2lhdncVok/WlXe7yJKznkbI=')
[x6] Refused to apply inline style … (+ 20 autres hashs de style)
```

et, en injectant un bouton `onclick` identique à ceux du markup généré :

```
inline onclick handler fired under CSP: false
"Refused to execute inline event handler because it violates … "default-src 'self'""
```

→ **une CSP stricte casse les 107 gestionnaires inline.** C'est ce qui doit être
refactorisé, et rien d'autre.

**(B) Politique candidate déployable aujourd'hui** :

```
default-src 'self';
script-src 'self' 'unsafe-inline';
style-src  'self' 'unsafe-inline';
img-src    'self' data: blob:;
media-src  'self' blob: data:;
font-src   'self' data:;
connect-src 'self';
worker-src 'self' blob:;
object-src 'none';
base-uri   'self';
form-action 'self';
frame-ancestors 'none'
```

Résultat mesuré :

```
--- distinct violations: 2 (total 2) ---
[x1] Refused to execute script from 'ORIGIN/lib/WebAudioFontPlayer.js'
     because its MIME type ('text/html') is not executable
[x1] Refused to load the script 'https://surikov.github.io/webaudiofont/npm/dist/
     WebAudioFontPlayer.js' because it violates "script-src 'self' 'unsafe-inline'"
title= 🎵 General Midi Boop   bodyLen= 508429   i18n/app present= true

inline onclick handler fired under CSP: true
violations during handler test: []

api state: {"hasApi":true,"wsState":1}          ← WebSocket OUVERT
direct WebSocket from page: OPEN                ← `connect-src 'self'` autorise ws:// same-origin
```

**Zéro violation imputable à la SPA.** Les deux restantes sont exactement le
chemin F-14 : `/lib/WebAudioFontPlayer.js` renvoie `index.html` (le
téléchargement d'installation n'a pas eu lieu ici) puis le repli
`document.write` vers le CDN est bloqué. Ce repli est déjà cassé sur un Pi
hors-ligne ; il disparaît si le player est versé dans le dépôt (§4, correctif a).

### Ce que cette politique apporte, et ce qu'elle n'apporte pas

Elle **n'empêche pas** l'exécution d'un script injecté (c'est le prix de
`'unsafe-inline'`) : elle n'aurait pas bloqué F-110. Elle apporte quand même :

- `object-src 'none'` et `base-uri 'self'` — deux vecteurs classiques fermés ;
- `frame-ancestors 'none'` — pas de clickjacking, plus fort que `X-Frame-Options` ;
- **le blocage de toute origine de script externe** — la SPA ne peut plus être
  amenée à charger du JS d'un CDN, ce qui est exactement la moitié de F-109
  (mais **pas** `/api/waf/…`, qui est same-origin — cf. §4.2) ;
- `connect-src 'self'` — une XSS ne peut plus exfiltrer vers un hôte arbitraire.

**Verdict honnête :** l'arbitrage d'août (« ça coûterait un vrai refactoring »)
n'était juste que pour la version *stricte*. La version ci-dessus coûte **une
option helmet** et ne casse rien. Il n'y a pas de raison de continuer à servir
zéro CSP.

### Correctif proposé (diff)

**Étape 1 — maintenant, sans refactoring :**

```diff
--- a/src/api/HttpServer.js
+++ b/src/api/HttpServer.js
@@
-    // Security headers (CSP disabled — embedded SPA with inline scripts,
-    // CORP/COEP disabled — app accessed via IP on local network)
+    // CSP : `'unsafe-inline'` reste nécessaire pour les 107 gestionnaires
+    // d'événements inline et le bloc applicatif embarqué dans index.html.
+    // Ce n'est donc pas une protection anti-XSS, mais object-src/base-uri/
+    // frame-ancestors/connect-src ferment de vrais vecteurs et interdisent
+    // tout chargement de script hors de notre origine (audit L10 F-113).
+    // Mesuré : 0 violation imputable à la SPA, WebSocket inclus.
+    // CORP/COEP restent relâchés (accès par IP sur le réseau local).
     this.expressApp.use(
       helmet({
-        contentSecurityPolicy: false,
+        contentSecurityPolicy: {
+          useDefaults: false,
+          directives: {
+            defaultSrc: ["'self'"],
+            scriptSrc: ["'self'", "'unsafe-inline'"],
+            styleSrc: ["'self'", "'unsafe-inline'"],
+            imgSrc: ["'self'", 'data:', 'blob:'],
+            mediaSrc: ["'self'", 'blob:', 'data:'],
+            fontSrc: ["'self'", 'data:'],
+            connectSrc: ["'self'"],
+            workerSrc: ["'self'", 'blob:'],
+            objectSrc: ["'none'"],
+            baseUri: ["'self'"],
+            formAction: ["'self'"],
+            frameAncestors: ["'none'"]
+          }
+        },
         crossOriginEmbedderPolicy: false,
         crossOriginResourcePolicy: false
       })
     );
```

**Étape 2 — quand les gestionnaires inline seront nettoyés** (chantier de
`09_FRONTEND_UX.md` / L09) : extraire le bloc de 397 Ko dans
`public/js/bootstrap-inline.js`, convertir les 107 `onclick=` en délégation
d'événements, puis retirer `'unsafe-inline'` de `scriptSrc`. **Alors seulement**
la CSP devient une défense anti-XSS. Garder `'unsafe-inline'` sur `styleSrc`
(1 079 attributs `style=`, risque négligeable).

---

## 9. F-114 — Authentification HTTP : trois contournements, dont deux forgeables et un qui saute derrière un tunnel — **P2, démontré** (délégation de L01)

L01 a délégué le départage des trois bypass, impossible depuis loopback seul.
Voici le tri.

`src/api/HttpServer.js:200-259`, mode `trusted-lan` (défaut). Trois portes
successives avant le contrôle du token :

| # | Porte | Ligne | Forgeable par un client non-navigateur ? | Démonstration |
|---|---|---|---|---|
| 1 | `Sec-Fetch-Site: same-origin` | 231 | **OUI, trivialement** | `curl -H "Sec-Fetch-Site: same-origin" … → 200` |
| 2 | `Origin.hostname ∈ {localhost, 127.0.0.1, req.hostname}` | 233-247 | **OUI** — `req.hostname` vient de l'en-tête `Host`, l'attaquant contrôle les deux | `curl -H "Origin: http://127.0.0.1:8110" … → 200` |
| 3 | `isPrivateClient(req)` — RFC1918/loopback/ULA/link-local | 249-258 | Non forgeable par en-tête, **mais** dépend entièrement de l'adresse source vue par le socket | voir ci-dessous |

```
$ curl -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8110/api/status                       # 200 (bypass 3)
$ curl -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer WRONG" …/api/status          # 200 (!)
$ curl -o /dev/null -w "%{http_code}\n" -H "Sec-Fetch-Site: same-origin" …/api/status          # 200 (bypass 1)
$ curl -o /dev/null -w "%{http_code}\n" -H "Origin: http://127.0.0.1:8110" …/api/status        # 200 (bypass 2)
$ curl …/api/metrics    # métriques Prometheus servies sans token
$ curl …/api/sf2        # {"defaultPresent":false,"banks":[]}
```

Noter la deuxième ligne : **un token faux passe quand même**, parce que les
contournements sont évalués *avant* `_checkBearer`. Ce n'est pas un fail-open du
comparateur (il est en temps constant et correct) — c'est que le comparateur
n'est jamais atteint.

### Le cas 3 derrière un tunnel : la démonstration

`isPrivateClient` lit `req.ip`, et **`trust proxy` n'est configuré nulle part** :

```
$ grep -rn "trust proxy\|trustProxy" src/ public/js/
(aucun résultat)
```

Sans `trust proxy`, `req.ip` est l'adresse du socket, jamais `X-Forwarded-For`.
C'est le bon choix en soi — mais cela signifie que **tout intermédiaire qui
termine la connexion sur la machine fait apparaître 127.0.0.1**. C'est exactement
ce que fait un tunnel (`cloudflared`, `ngrok`, `frp`) ou un nginx local : le
démon tourne *sur le Pi* et se reconnecte à `127.0.0.1:8080`. L'IP réelle du
client ne se trouve plus que dans `X-Forwarded-For`, que l'application ne lit
jamais.

J'ai vérifié le mécanisme avec un forwarder local (proxy 8113 → 8110, sans
`X-Forwarded-For` honoré côté serveur) : toute requête traversant le proxy est
vue par le serveur comme provenant de 127.0.0.1, donc admise par
`isPrivateClient` sans token, quelle que soit l'origine réelle.

`CLAUDE.md` avertit déjà (« avoid exposing the box behind a tunnel that rewrites
the source IP into a private range »). L'avertissement est **plus large que ce
qu'il dit** : il ne s'agit pas seulement d'un tunnel qui réécrirait en plage
privée, mais de **tout** reverse-proxy ou tunnel local, qui produit
mécaniquement du 127.0.0.1.

### Sévérité et lecture

**P2, pas P1**, pour une raison précise : ce contournement est **documenté,
volontaire, et annulable** — `GMBOOP_SECURITY_MODE=secure` le ferme correctement,
vérifié plus haut (`401` sur les trois portes). Le raisonnement du code sur le
compromis usabilité/sécurité en LAN de confiance est défendable pour un appareil
mono-utilisateur.

Ce qui n'est **pas** défendable, c'est que la même parade **ne s'applique pas au
WebSocket** (F-108). Tant que F-108 est ouvert, `secure` donne une fausse
assurance : l'opérateur qui suit la documentation croit avoir fermé la porte, et
il n'a fermé que la petite.

### Correctifs proposés

1. **Prioritaire : F-108** (§3). Sans lui, ce finding n'a pas de remède.
2. Ancrer les portes 1 et 2 sur `isPrivateClient(req)` — le code le suggère déjà
   lui-même en commentaire (l.216-217) :

```diff
--- a/src/api/HttpServer.js
+++ b/src/api/HttpServer.js
@@
-        if (req.headers['sec-fetch-site'] === 'same-origin') {
+        // Sec-Fetch-* et Origin sont librement forgeables par un client
+        // non-navigateur : les ancrer sur l'adresse source évite qu'ils
+        // servent de contournement à un client WAN direct (audit L10 F-114).
+        if (isPrivateClient(req) && req.headers['sec-fetch-site'] === 'same-origin') {
           return next();
         }
```

3. Documenter dans `CLAUDE.md` que **tout** reverse-proxy/tunnel local — pas
   seulement ceux qui réécrivent en plage privée — annule `isPrivateClient`, et
   que `secure` est obligatoire dans ce cas.

---

## 10. F-115 — `/api/update-status` : endpoint public qui lit un fichier de log entier en mémoire — **P3, démontré**

`src/api/apiRoutes.js:254-281`. Sans authentification (exemption explicite dans
`HttpServer.js:194-199`, aux côtés de `/health` et `/capabilities`) :

```
$ curl http://127.0.0.1:8110/api/update-status
{"status":null,"logTail":null}
```

Deux remarques :

1. **Divulgation.** Pendant et après une mise à jour, `logTail` renvoie les
   30 dernières lignes de `logs/update.log`, c'est-à-dire la sortie de
   `scripts/update.sh` : chemins absolus, branche et commit git, sortie de
   `npm install`. Rien de secret par construction — sauf si le remote git porte
   un identifiant dans son URL, auquel cas `git pull` l'imprime. Faible.

2. **Lecture non bornée.** Le code fait `readFileSync(logFile, 'utf8')` **puis**
   `split('\n').slice(-30)`. Le fichier entier est chargé en mémoire pour n'en
   garder que 30 lignes. `logs/update.log` est ouvert en `'w'` à chaque mise à
   jour (`SystemCommands.js:509`), donc il ne croît pas indéfiniment — mais une
   mise à jour bavarde ou en échec peut le faire monter à plusieurs dizaines de
   Mo, et **un client non authentifié peut déclencher cette lecture en boucle**.
   Sur un Pi, c'est un levier d'épuisement mémoire/CPU bon marché.

Le contraste est net avec `system_logs`, qui fait *exactement* ce qu'il faut
(`openSync` + lecture de la queue bornée à `LOG_TAIL_MAX_BYTES`,
`SystemCommands.js:712-742`, avec le commentaire « audit A2 M3 »). La leçon
avait été apprise à un endroit et pas à l'autre.

Les deux autres endpoints publics sont sains : `/health` et `/capabilities`
exposent version, `gitHash`, et l'état des capacités — divulgation mineure,
acceptable pour une sonde de vivacité.

### Correctif proposé

```diff
--- a/src/api/apiRoutes.js
+++ b/src/api/apiRoutes.js
@@
     if (existsSync(logFile)) {
       try {
-        const full = readFileSync(logFile, 'utf8');
-        const lines = full.split('\n');
-        logTail = lines.slice(-30).join('\n');
+        // Endpoint PUBLIC : ne jamais charger le fichier entier en mémoire.
+        // Même borne que system_logs (audit A2 M3 / L10 F-115).
+        const MAX_TAIL_BYTES = 64 * 1024;
+        const fd = openSync(logFile, 'r');
+        try {
+          const size = fstatSync(fd).size;
+          const readBytes = Math.min(size, MAX_TAIL_BYTES);
+          const buf = Buffer.allocUnsafe(readBytes);
+          readSync(fd, buf, 0, readBytes, size - readBytes);
+          logTail = buf.toString('utf8').split('\n').slice(-30).join('\n');
+        } finally {
+          closeSync(fd);
+        }
       } catch {
```

---

## 11. F-116 — Escalade de privilège structurelle : sudoers NOPASSWD sur un script inscriptible par l'utilisateur applicatif — **P2, structurel, non démontré**

`scripts/Install.sh:371` installe :

```
$USER ALL=(root) NOPASSWD: $HOTSPOT_SCRIPT
```

où `$HOTSPOT_SCRIPT` est `scripts/hotspot.sh` **dans l'arborescence du dépôt**,
que le même `$USER` possède et peut réécrire (`Install.sh:282` :
`chmod +x scripts/*.sh`).

C'est le motif classique : quiconque obtient une exécution de code en tant
qu'utilisateur applicatif réécrit `hotspot.sh` et l'invoque via `sudo -n` → root.

Ce qui rend le point non théorique dans ce produit, c'est la chaîne complète :

```
attaquant sur le LAN
  → F-108 : WebSocket sans token
  → system_update
  → scripts/update.sh : git pull + npm install (scripts de paquets) + npm run build
  → tout ce qui est dans le dépôt, hotspot.sh compris, est remplacé
  → sudo -n hotspot.sh  →  root
```

Ou, plus directement, sans même passer par l'update : les commandes `hotspot_*`
sont accessibles sur la même socket non authentifiée et pilotent `nmcli` en root
(reconfiguration Wi-Fi, coupure du réseau, création d'un AP).

**Ce que j'ai vérifié / ce que je n'ai pas pu vérifier.** Le contenu de
`Install.sh` et de `hotspot.sh` est vérifié. `hotspot.sh` lui-même est **propre**
côté injection : `set -u`, aucune `eval`, toutes les variables entre guillemets,
arguments passés en argv à `nmcli`, validation du `band`, longueur minimale du
mot de passe. `HotspotManager._runScript()` utilise
`execFile('sudo', ['-n', SCRIPT_PATH, ...args])` — pas de shell. **Il n'y a pas
d'injection de commande.** Le problème est uniquement l'inscriptibilité du script
privilégié, que je ne peux pas constater sans un vrai Pi installé.

### Correctifs proposés

```diff
--- a/scripts/Install.sh
+++ b/scripts/Install.sh
@@
-        echo "$USER ALL=(root) NOPASSWD: $HOTSPOT_SCRIPT" | sudo tee -a "$SUDOERS_FILE" > /dev/null
+        # Le script autorisé en NOPASSWD ne doit PAS être inscriptible par
+        # l'utilisateur qui l'invoque, sinon la règle sudoers est une escalade
+        # directe vers root (audit L10 F-116). On le copie hors du dépôt, en
+        # propriété root, et c'est CETTE copie qui est autorisée.
+        PRIV_SCRIPT=/usr/local/lib/gmboop/hotspot.sh
+        sudo install -D -o root -g root -m 0755 "$HOTSPOT_SCRIPT" "$PRIV_SCRIPT"
+        echo "$USER ALL=(root) NOPASSWD: $PRIV_SCRIPT" | sudo tee -a "$SUDOERS_FILE" > /dev/null
```

(avec `SCRIPT_PATH` dans `HotspotManager.js` pointant sur `PRIV_SCRIPT` lorsqu'il
existe, et un repli sur le chemin du dépôt en développement — et `update.sh` doit
réinstaller la copie privilégiée quand le script change.)

Reste par ailleurs la recommandation P3 non traitée d'août : ajouter `--` avant
les arguments utilisateur, pour qu'un SSID commençant par `-` ne soit pas
interprété comme une option par `nmcli` :

```diff
-      const result = await execFileAsync('sudo', ['-n', SCRIPT_PATH, ...args], {
+      const result = await execFileAsync('sudo', ['-n', SCRIPT_PATH, '--', ...args], {
```

(nécessite un `shift`/`--` correspondant dans `main()` de `hotspot.sh`.)

---

## 12. F-117 — Classe « exception asynchrone non gardée » (la classe de F-18) — **P3, non démontré exploitable ici**

L01 a trouvé le premier P0 de l'audit : `lighting_midi_learn` appelait
`eventBus.removeListener()` (inexistant sur `EventBus`) depuis un `setTimeout`.
La `TypeError` échappait au `try/catch` du dispatcheur, remontait en
`uncaughtException`, et `Application.setupShutdownHandlers()`
(`src/core/Application.js:867,881`) **arrêtait le serveur**. Une trame = un
interrupteur d'arrêt distant. Corrigé par L01.

**Balayage de la classe.** 13 planifications asynchrones dans
`src/api/commands/*.js`. Après tri (`SystemCommands` : `process.exit` volontaire
ou callbacks déjà gardés ; `LightingCommands:820` : corrigé par L01), il reste
**deux callbacks non protégés** :

- `src/api/commands/MidiCommands.js:80-88` — `setTimeout(() => app.deviceManager.sendMessage(deviceId, 'noteoff', …), data.duration)`
- `src/api/commands/RoutingCommands.js:189-195` — même motif sur `route.destination`

Aucun `try/catch`. Si `sendMessage` lançait — par exemple parce que le
périphérique a disparu entre le `noteon` et le `noteoff` planifié, ce qui est le
cas nominal du débranchement à chaud d'un instrument — la levée irait en
`uncaughtException` et arrêterait le serveur.

**Tentative de reproduction (échouée, honnêtement) :**

```
midi_send_note {deviceId:"no-such-device", duration:300} -> {"success":true}
   [server] WARN  Output device not found: no-such-device
midi_send_note {deviceId:null}            -> ERR_VALIDATION (schéma présent ✅)
--- server alive after? --- 200
```

`DeviceManager.sendMessage()` journalise un avertissement et retourne ; il ne
lève pas sur un périphérique absent. **Le chemin n'est donc pas exploitable par
les entrées que je peux atteindre sans matériel MIDI.** Je ne peux pas exclure
qu'un port ALSA ouvert puis retiré lève depuis la couche native — c'est
précisément ce que L15 (validation matérielle) peut trancher.

Je le classe donc en **durcissement**, pas en vulnérabilité : le motif est
identique à celui qui a produit un P0, et il ne coûte rien à fermer.

### Correctifs proposés

```diff
--- a/src/api/commands/MidiCommands.js
+++ b/src/api/commands/MidiCommands.js
   if (data.duration) {
     setTimeout(() => {
-      app.deviceManager.sendMessage(data.deviceId, 'noteoff', {
-        channel: data.channel, note: data.note, velocity: 0
-      });
+      // Une levée depuis un callback de timer échappe au try/catch du
+      // dispatcheur et remonte en uncaughtException, ce qui ARRÊTE le
+      // serveur (cf. audit L01 F-18). Tout callback asynchrone d'un
+      // gestionnaire de commande doit être gardé (audit L10 F-117).
+      try {
+        app.deviceManager.sendMessage(data.deviceId, 'noteoff', {
+          channel: data.channel, note: data.note, velocity: 0
+        });
+      } catch (err) {
+        app.logger.warn(`scheduled noteOff failed: ${err.message}`);
+      }
     }, data.duration);
   }
```

(idem `RoutingCommands.js:189`.)

**Et, en défense de dernier recours, la vraie correction de classe :**
`Application.setupShutdownHandlers()` traite tout `uncaughtException` comme
fatal. Pour un appareil temps réel qui pilote des instruments, arrêter le
processus sur une `TypeError` isolée est un choix discutable : cela transforme
n'importe quel bug asynchrone en déni de service distant. Un garde-fou —
journaliser et continuer sauf pour une liste restreinte d'erreurs réellement
fatales (`ERR_*` mémoire, corruption de base) — supprimerait la classe entière
plutôt que ses instances. À arbitrer avec L12 (résilience).

---

## 13. Ce qui a été re-vérifié et **passe**

Sauf mention contraire, sondes exécutées en direct contre `http://127.0.0.1:8110`.

| Contrôle | Résultat | Preuve |
|---|---|---|
| **Traversée de chemin — statique** | **PASS** | `GET /../../../etc/passwd` → 200 mais le corps est **octet pour octet `public/index.html`** (`cmp -s` → identique, 615 825 o). Les 2 occurrences de `root:` sont des classes CSS (`.drop-zone-root:hover`). Aucune fuite. Le 200 lui-même est F-10 (repli SPA), qui appartient à L01. |
| **Traversée de chemin — API** | **PASS** | `/api/files/..%2f..%2f..%2fetc%2fpasswd/blob` → 400 ; `/api/waf/..%2f..%2f..%2fetc%2fpasswd` → 400 (allowlist `^[A-Za-z0-9_]{1,200}\.js$`) ; `/api/sf2/:id` → `parseSF2Id` n'accepte que `default` ou un entier > 0. |
| **Traversée via `?filename=` (F-82 de L07)** | **PASS pour la traversée** | `..%2f..%2f..%2fetc%2fpwn.mid`, `%2e%2e%2f…`, `a%00.mid`, chaîne vide : **aucun fichier écrit hors du blobstore** (`/etc/pwn.mid`, `./pwn.mid` absents). Cause : `BlobStore` est **adressé par contenu** — le chemin est `midi/<hash[0:2]>/<hash>.mid` (`BlobStore.js:40-45`) plus un garde de confinement (l.124-139). Le nom de fichier n'est que des métadonnées. **Le manque de validation constaté par L07 est réel** (NUL, `..`, 404 caractères acceptés et stockés verbatim) mais **ce n'est pas une traversée** : c'est un problème de validation d'entrée (L01/L07) et d'hygiène d'affichage. |
| **XSS par nom de fichier (bout en bout)** | **PASS** | MIDI téléversé sous le nom `<img src=x onerror="window.__L10XSS=1">.mid`, SPA chargée dans Chromium : `__L10XSS=false`, aucun `<img>` injecté. Le markup montre `data-file-name="&lt;img src=x onerror=&quot;…&quot;&gt;.mid"` — correctement échappé. Idem `PlaylistPage.js:573`, `PlaylistEditorModal.js:277,332` (tous via un échappeur). |
| **Injection SQL** | **PASS** | Requêtes préparées `better-sqlite3` partout ; aucun SQL construit par concaténation. Le constat de L01 (F-19 : les charges hostiles atteignent la requête préparée) est exact et **ne produit pas d'injection** — c'est le paramétrage qui tient, pas la validation en amont. |
| **Injection de commande** | **PASS** | `execFile(cmd, [argv])` partout où des données utilisateur circulent : `HotspotManager` (sudo + argv), `NetworkManager` (`timeout`/`avahi-browse`/`ip`, argv), `DelayCalibrator` (`arecord`, argv). Aucun `exec()`/shell avec des données utilisateur. `hotspot.sh` : `set -u`, tout entre guillemets, aucune `eval`. **Deux `execSync` avec interpolation de chaîne** existent — `DeviceDiscovery.js:193` (`${tty}` issu de `readdirSync('/sys/class/tty')`, donc du noyau) et `SystemCommands.js:343,353,354,360` (`${currentBranch}` issu de `git branch --show-current`). Le second mérite d'être noté : git autorise `;`, `$`, `` ` `` dans un nom de branche, donc une branche locale malveillante donnerait une injection — mais il faut déjà pouvoir créer cette branche sur le boîtier. **Théorique, non démontré** (aucune commande git autorisée dans ce lot). Correctif trivial : `execFileSync('git', ['ls-remote', 'origin', 'refs/heads/' + currentBranch])`. Appartient à L01 (`src/api/commands/**`). |
| **Pollution de prototype** | **PASS** | `{"__proto__":{"polluted":"yes"}}` en charge de commande → `({}).polluted === undefined`. |
| **Limites / DoS** | **PASS** | Trame > 16 Mo : socket fermée, serveur sain (`/api/health` → 200 ensuite). Limiteur 60 msg/s + 32 Mo/s par connexion : une rafale de 200 commandes n'obtient pas 200 réponses — le limiteur mord (**fail-closed**). Le fait qu'il *jette silencieusement* sans trame d'erreur au-delà de 10 messages prioritaires est F-06/F-07, périmètre L01. Plafond de 10 clients respecté. |
| **Token** | **PASS** | Généré en `randomBytes(32)`, écrit dans `.env` en `0o600` avec `chmodSync` de rattrapage, jamais journalisé, comparé par `timingSafeEqual` avec test de longueur préalable (`ApiTokenManager.js`, `HttpServer.js:102-113`). Le WebSocket **fail-closed** correctement quand aucun token n'est configuré (`WebSocketServer.js:207-214`) — la régression « secret vide » de l'audit A2 est bien fermée. |
| **`.env` non servi** | **PASS** | `GET /js/../../.env` → repli SPA, `grep -c GMBOOP_API_TOKEN` → 0. |
| **CORS** | **PASS** | Allowlist same-origin/localhost, `new URL()` (pas de `split(':')` sur les littéraux IPv6). |
| **Balayage des sinks XSS** | 257 sinks — **1 XSS confirmée** | `node scripts/audit/xss-sinks.mjs` → 114 CLEAN / 116 DYNAMIC / 27 RISKY, chiffres identiques à ceux d'août. Les 27 RISKY ont été relus un par un ; la seule valeur réellement contrôlée par un tiers non échappée est F-110, que **le scanner du dépôt ne voyait pas** parce qu'il ne distingue pas le contexte attribut du contexte texte (voir §5). |

### Écart sur `live-probe.mjs`

```
12/19 checks passed
  [T]  unknown /api route returns 4xx        → 200 (F-10, L01)
  [AH] helmet security headers present       → CSP=no  (F-113, ce lot)
  [AH] path traversal /../../../etc/passwd   → 200 mais leaked=false (repli SPA, pas une fuite)
  [V]  forme des trames d'erreur (×3)        → F-06/F-10, L01
  [AK] rafale de 200 commandes               → limiteur de débit, comportement attendu
```

Un seul de ces échecs relève de la sécurité : la CSP.

---

## 14. Recommandations, par ordre d'application

| Pri | Action | Fichier | Coût |
|---|---|---|---|
| **P1** | **F-108** — appliquer `security.mode` au WebSocket ; ancrer le contournement loopback sur l'adresse source | `src/api/WebSocketServer.js` | ~15 lignes |
| **P1** | **F-110** — `deviceName` → `deviceNameEscaped` dans `data-device-name` | `public/js/features/BluetoothScanModal.js:297` | 1 ligne |
| **P1** | **F-109 (a)** — verser `WebAudioFontPlayer.js` dans le dépôt (**ferme aussi F-14**) | `public/lib/` + `install-default-sf2.js` | ~120 Ko + suppression de code |
| **P2** | **F-112** — `ws` au-delà de 8.20.1 ; porte CI à `--audit-level=high` | `package.json`, `.github/workflows/ci.yml` | 2 lignes |
| **P2** | **F-113** — activer la CSP « étape 1 » (mesurée : 0 casse) | `src/api/HttpServer.js:138-145` | ~18 lignes |
| **P2** | **F-109 (b,c,d)** — SHA-256 épinglé sur le SF2 ; supprimer ou épingler `/api/waf/` ; corriger le README | `install-default-sf2.js`, `wafProxyRoutes.js`, `assets/sf2/README.md` | ~40 lignes |
| **P2** | **F-114** — ancrer les portes `Sec-Fetch-Site`/`Origin` sur `isPrivateClient` ; élargir l'avertissement `CLAUDE.md` sur les tunnels | `src/api/HttpServer.js`, `CLAUDE.md` | ~4 lignes |
| **P2** | **F-116** — copier `hotspot.sh` hors du dépôt, en propriété root, avant la règle sudoers | `scripts/Install.sh`, `HotspotManager.js` | ~6 lignes |
| **P3** | **F-115** — lecture bornée de `update.log` sur l'endpoint public | `src/api/apiRoutes.js:270-277` | ~12 lignes |
| **P3** | **F-117** — garder les callbacks `setTimeout` des gestionnaires de commandes ; arbitrer la politique `uncaughtException` | `MidiCommands.js`, `RoutingCommands.js`, `Application.js` | ~10 lignes |
| **P3** | `execFileSync` au lieu de `execSync` pour les commandes git interpolant `currentBranch` | `SystemCommands.js:343,353,354,360` | ~8 lignes |
| **P3** | `--` avant les arguments utilisateur de `hotspot.sh` | `HotspotManager.js:78` + `hotspot.sh` | 2 lignes |
| **P3** | Échapper `data-device-ip` / `data-device-address` (défense en profondeur) | `NetworkScanModal.js`, `BluetoothScanModal.js` | ~6 lignes |
| **P3** | Documenter que `icon` et `details` de `showConfirmModal` sont des sinks HTML bruts assumés | `MidiEditorDialogs.js` (JSDoc) | 2 lignes |

**Note de dépendance :** F-114 et F-116 n'ont pas de remède tant que F-108 est
ouvert, puisque leur parade documentée (`mode: secure`) ne couvre pas le
WebSocket. F-108 est donc le premier correctif, sans discussion.

---

## 15. Livrables de ce lot

| Fichier | Nature |
|---|---|
| `docs/audit/2026-09-07/10_SECURITY.md` | ce rapport |
| `tests/frontend/l10-dialogs-html-escaping.test.js` | 5 tests Vitest/jsdom — non-régression F-05 + preuve rouge→vert de F-111 |
| `public/js/features/midi-editor/MidiEditorDialogs.js` | **correctif appliqué** (F-111), 6 lignes |

Aucun fichier partagé modifié (`git diff --stat config.json` → vide ; ni
`package.json`, ni `.github/`, ni `CLAUDE.md`, ni `.eslintrc.json`). Tous les
autres correctifs sont fournis en diff, à appliquer en vague 2.

**Reproduction.** Serveur de test :

```bash
GMBOOP_SERVER_PORT=8110 GMBOOP_SERVER_WS_PORT=8110 \
GMBOOP_DATABASE_PATH=<scratch>/L10/gmboop.db \
GMBOOP_API_TOKEN=L10AUDITTOKEN0123456789abcdef \
node server.js
```

Tests : `npx vitest run tests/frontend/l10-dialogs-html-escaping.test.js` → 5/5.
Scanners : `node scripts/audit/xss-sinks.mjs`,
`node scripts/audit/live-probe.mjs http://127.0.0.1:8110`.
Sondes navigateur : `playwright@1.56.1` global, Chromium `/opt/pw-browsers`.
