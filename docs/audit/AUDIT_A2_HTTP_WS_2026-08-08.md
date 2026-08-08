# Audit A2 — HTTP / WebSocket / Auth / Système (2026-08-08)

Audit adversarial (3 relecteurs parallèles) de la couche HTTP/WS/auth/commandes
système : `HttpServer`, routes (`apiRoutes`, `sf2Routes`, `wafProxyRoutes`,
captive portal), `ApiTokenManager`, `WebSocketServer`, `WsOutputQueue`,
`CommandRegistry`/`CommandHandler`, `JsonValidator`, et les handlers
`System`/`Session`/`Hotspot`/`File`. Chaque finding a été **revérifié contre le
code réel** avant correctif.

**Modèle de menace :** même posture « LAN de confiance » que l'audit A1. On
corrige les bugs de correction, les DoS (qui frappent même sur un LAN de
confiance, via un client bogué ou une page web malveillante ouverte par un
poste du LAN) et la défense en profondeur sans casser le comportement légitime.
Les changements de **politique de sécurité** qui affecteraient des déploiements
légitimes (allowlist d'Origin, gating d'auth supplémentaire) sont **documentés,
laissés à décision**.

**Statut :** 14 items corrigés (9 avec tests dédiés). Le reste — dont un item
qui mérite une décision (rebinding DNS) — est listé plus bas.

---

## ✅ Corrigés

### WebSocket / dispatch / validation

- **WS-C1 (CRITIQUE) — token vide = fail-OPEN** `WebSocketServer.start` (verifyClient).
  Quand aucun token n'est configuré (`apiToken=''`) et qu'un client cross-origin
  n'en envoie pas, `timingSafeEqual(Buffer.from(''), Buffer.from(''))` renvoie
  `true` → `done(true)` **acceptait** la socket (le commentaire affirmait
  l'inverse). Une page web malveillante ouverte par un poste du LAN pouvait
  piloter la box (CSWSH). Corrigé : **fail closed** sur secret vide (les bypass
  loopback/same-origin servent toujours la SPA locale) + commentaire corrigé.
  Test : `tests/ws-validation-hardening.test.js` (comportement), relecture.
- **WS-D1 (MOYEN) — couche de validation poreuse** `JsonValidator.validateCommand`
  + parse. `typeof [] === 'object'` laissait passer un `data` de type tableau
  jusqu'au handler ; aucune défense contre la pollution de prototype. Corrigé :
  (a) `validateCommand` rejette un `data` tableau/primitif (null toléré → `{}`) ;
  (b) reviver `JSON.parse` qui supprime `__proto__`/`constructor`/`prototype` à
  l'entrée (défense en profondeur). Tests : `tests/ws-validation-hardening.test.js`.
- **WS-D2 (MOYEN) — rate-limit au message, pas à l'octet** `WebSocketServer`.
  60 msg/s × 16 Mo = ~960 Mo/s de `JSON.parse` sur le thread principal → stalle
  l'ordonnanceur MIDI. Corrigé : budget d'octets par fenêtre
  (`RATE_LIMIT_MAX_BYTES=32 Mo`) en plus du compteur de messages. Relecture.
- **WS-N2 (MINEUR) — promesse flottante + `ws.send` non gardé** `WebSocketServer`.
  `handleMessage` non-awaité + envoi dans le `catch` pouvant throw sur socket
  fermée → rejet non géré. Corrigé : `.catch(()=>{})` + `try/catch` sur l'envoi.
- **WS-N3 (MINEUR) — IPv6 casse le bypass same-origin** `WebSocketServer`.
  `host.split(':')[0]` transformait `[::1]` en `[`. Corrigé : parse via `URL`.

### HTTP / routes / auth

- **HTTP-M1 (MAJEUR) — upload SF2 : buffering ≤160 Mo en RAM, sans limite de
  concurrence** `sf2Routes`. `expressRaw` bufferise tout le corps avant le
  handler et ces uploads ne passent pas par une file bornée → quelques POST
  concurrents = OOM du process sur un Pi. Corrigé : gate de concurrence (1 à la
  fois) **avant** `expressRaw`, relâché sur `close`. Relecture.
- **HTTP-M4 (MOYEN) — proxy WAF sans timeout ni cap de taille** `wafProxyRoutes`.
  (Hôte épinglé → pas de SSRF.) Une connexion CDN stallée pinnait la requête ;
  corps illimité bufferisé. Corrigé : `setTimeout(8 s)` + cap 4 Mo.
- **HTTP-N3 (MINEUR) — fuite de `err.message` sur 500** `apiRoutes`
  (`POST /files`, `/text-events`, `/blob`). Corrigé : message générique sur 500
  (les 413/415/503 déterministes gardent leur message client).
- **HTTP-N4 (MINEUR) — `BlobStore.resolve`/`delete` sans garde de traversal**
  `BlobStore`. Chemins toujours générés côté serveur aujourd'hui — défense en
  profondeur : `_safeResolve` vérifie le confinement dans `baseDir`. Tests :
  `tests/blobstore-path-guard.test.js`.
- **HTTP-N5 (MINEUR) — `ApiTokenManager` : rotation silencieuse du token**
  `includes('GMBOOP_API_TOKEN')` matchait une var voisine (`..._BACKUP=`) →
  fichier inchangé → token régénéré à chaque redémarrage. Corrigé : décision via
  regex ancrée `^GMBOOP_API_TOKEN=`. Test : `tests/api-token-manager.test.js`.
- **HTTP-N6 (MINEUR) — fuite de fd sur `/blob` interrompu** `apiRoutes`.
  `.pipe(res)` ne détruit pas le `ReadStream` source sur déconnexion client.
  Corrigé : `res.on('close', () => stream.destroy())` + handler d'erreur de
  flux + mapping ENOENT→404.

### Commandes système / session / fichier

- **CMD-M1 (MOYEN) — `file_save_as` sans schéma** (jumeau de `file_write`).
  `FileManager.saveFileAs` sérialise `midiData` via `writeMidi` **avant** tout
  contrôle de taille (DoS) et persiste `newFilename` sans le sanitizer de
  `file_rename`. Corrigé : schéma `file_save_as` (mêmes caps pistes/événements +
  `validateFilename`). Tests : `tests/schema-file-save-as.test.js`.
- **CMD-M2 (MOYEN) — commandes `session_*` non validées.** Le couple
  `SESSION_SCHEMA`/`validateSession` de `JsonValidator` n'était jamais câblé au
  dispatch → `session_import` persistait un blob `data` illimité. Corrigé :
  `session.schemas.js` (name/description bornés, `data` string ≤1 Mo, sessionId
  requis) enregistré dans `COMPILED_SCHEMAS`. Tests : `tests/schema-session.test.js`.
- **CMD-M3 (MOYEN) — `system_logs` chargeait tout le fichier** `SystemCommands`.
  Le cap `lines` bornait la réponse, pas la lecture (`readFileSync` intégral) →
  OOM possible sur un gros log. Corrigé : lecture bornée des derniers 2 Mo (tail
  par octets). Tests : `tests/system-logs-tail.test.js`.

---

## 🔴 Différés — décision / plus large (posture « LAN de confiance »)

- **WS-M1 (MAJEUR) — CSWSH par rebinding DNS** `WebSocketServer` (bypass
  same-origin). L'Origin est comparé au header **Host** de la requête
  (contrôlable via rebinding DNS : l'attaquant sert une page depuis `evil.com`
  rebindé sur l'IP du Pi → `Origin===Host` → bypass, token jamais vérifié).
  **Frappe même sur un LAN de confiance** (victime = navigateur d'un poste du
  LAN). Correctif = allowlist d'Origin côté serveur (nom(s)/IP + port), ce qui
  **peut casser l'accès légitime** par nom d'hôte/mDNS variable → **DÉCISION
  requise** avant correctif. Cf. option ci-dessous.
- **HTTP-M2 (MOYEN) — parse SF2 synchrone sur le chemin requête** (`readFileSync`
  + `parseSoundFont` ~475 ms, cache 2 entrées). Boucler sur ≥3 SF2 gèle la
  boucle d'events. Correctif = worker/off-thread ou sérialisation — **plus
  large**, à planifier.
- **HTTP-M3 (MOYEN) — endpoints publics fuient de l'état** (`/update-status`
  renvoie les 30 dernières lignes de `update.log` ; `/capabilities`/`/health`
  = fingerprinting), y compris en mode `secure`. **Exposition uniquement.** Note :
  le dashboard poll `/update-status` pendant une mise à jour, donc le retirer
  casserait l'UX de mise à jour. Documenté.
- **HTTP-N1 (LATENT) — `isPrivateClient` sûr seulement car `trust proxy` est
  off.** Si un futur reverse-proxy active `trust proxy`, `req.ip` honore
  `X-Forwarded-For` → bypass trivial. À garder off (assertion/commentaire à
  ajouter si un proxy est introduit).
- **HTTP-N2 (LATENT) — mode `secure` sans token = no-op.** L'auth n'est montée
  que si `apiToken` existe. `ApiTokenManager` en génère un par défaut, donc quasi
  inatteignable ; recommandé : refuser le démarrage en `secure` sans token.
- **CMD-L1 (LAN-only) — commandes hotspot/wifi non gated** `HotspotCommands`.
  Contrairement à `system_*` (gated `requireTokenConfigured`), enable/disable/
  connect/forget/update-config ne le sont pas → un client same-origin/LAN peut
  sortir la box du réseau ou changer le SSID/PSK. Fix de cohérence cheap
  (`requireTokenConfigured`) — laissé à décision (changement de politique).
- **CMD-minors** — `system_backup` non gated + fuite de chemin absolu +
  backups illimités (disque) ; base dir backup incohérente (CWD vs
  PROJECT_ROOT) ; restart/shutdown/reboot **ne flushent pas le MIDI** (notes
  bloquées sur les instruments) ; `system_logs` renvoie le chemin absolu.
- **WS-N1 (doc)** — « versioned handler lookup » documenté mais non implémenté
  (`message.version` ignoré). **WS-N4 (fonctionnel)** — token via
  `sec-websocket-protocol` inutilisable depuis un navigateur (pas de
  `handleProtocols`).

**Décision (2026-08-08) : « LAN de confiance » — WS-M1 et CMD-L1 différés.**
Cohérent avec la décision A1 (RTP). On documente, on ne change pas le
comportement : ni allowlist d'Origin (durcissement anti-rebinding), ni gating
token supplémentaire sur hotspot/wifi. Le durcissement demanderait une config
par déploiement (noms d'hôte autorisés) pour ne pas casser l'accès légitime →
à ré-arbitrer si la box est un jour exposée à un réseau non fiable.

---

## Vérifié CORRECT (pour éviter la re-revue)

- **SSRF proxy WAF — SÛR** : hôte épinglé (`CDN_BASE` constant), `SAFE_FILENAME`
  = `^[A-Za-z0-9_]{1,200}\.js$`, `https.get` ne suit pas les redirections.
- **Comparaison de token — constant-time** (`timingSafeEqual` + pré-check de
  longueur) ; seul le cas secret-vide était fautif (WS-C1).
- **Traversal upload — SÛR** : blobs écrits par hash de contenu ; SF2 écrit sous
  un nom serveur ; `_resolveSF2Path`/`deleteSF2` gardent `startsWith(sf2Dir)`.
- **Injection shell hotspot/wifi — SÛRE** : `execFile('sudo', [...argv])` sans
  `shell:true` ; valeurs double-quotées positionnellement dans `hotspot.sh` ;
  `band` enum-validé. **Git update** : pas de `data.*` vers un shell.
- **Backup/restore traversal — bloqué** (`basename` + rejet `..`/`.`
  + `startsWith(backupsDir)`).
- **SQL — paramétré** ; **`express.static`** bloque `..`, `.env` hors racine servie.
- **Captive portal** — pas d'open-redirect (IP serveur, pas de header attaquant).
- **CORS/CSRF** — ACAO seulement pour localhost/hostname, pas de credentials ;
  routes mutantes non-simples (preflight échoue cross-origin).
- **`WsOutputQueue` borné** (FIFO depth 200, coalescing ≤5 clés, backpressure
  `bufferedAmount`, prune CLOSING/CLOSED) ; **cycle de vie timers/listeners**
  propre ; **crash over-limit** défendu (listener `error` avant `close`) ; pas
  de mélange d'`id` ; masquage d'erreur correct.
