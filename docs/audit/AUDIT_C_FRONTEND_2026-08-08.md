# Audit C — Frontend (SPA : index.html, core, features) (2026-08-08)

Audit adversarial (3 relecteurs parallèles) de la SPA vanilla-JS : **C1** modules
`public/js/features/**` (balayage XSS), **C2** plomberie cœur (`EventBus`,
`BaseView`, `BackendAPIClient`), **C3** le script inline de `public/index.html`
(~14 500 lignes). **Les données rendues proviennent d'appareils MIDI (descripteurs
USB/BLE/RTP, réponses SysEx), de fichiers uploadés (noms de fichiers) et de l'état
partagé serveur (noms de dossiers, custom_name) — tous non fiables et partagés
entre clients.** Chaque finding a été revérifié contre le code réel avant fix.

**Cause racine systémique :** `window.escapeHtml` existe et est correct, mais
n'était appliqué que dans ~2 des ~25 sinks `innerHTML` interpolants ; les
validateurs serveur correspondants (`validateFilename`, `validateFolder`,
`custom_name`) sont délibérément permissifs et autorisent `< > " ' &`.

**Statut :** 20 items corrigés (EventBus/BackendAPIClient couverts par tests
Vitest), dont **1 CRITIQUE** (XSS stocké/partagé via nom de fichier), **1 HIGH**
(XSS stocké via onclick inline) et **5 MAJEURS**. Suite frontend : **74 fichiers /
1304 tests** verts (build Vite OK). Aucun fichier backend modifié.

---

## ✅ Corrigés

### XSS stocké / partagé (le cœur du problème)

- **C1 (HIGH) — XSS stocké via `onclick` inline + id `escapeHtml`'d**
  `InstrumentManagementPage.renderInstrumentSubCard`. Les ids d'appareil/instrument
  (dérivés du nom de port MIDI, donc influençables ; et via `virtual_create` dont
  seul `name` est validé) étaient interpolés dans une **string JS entre apostrophes**
  d'un handler `onclick`. `escapeHtml` y est **inopérant** : le parseur HTML
  re-décode `&#39;` en `'` *avant* la compilation du JS inline, l'apostrophe se
  rematérialise et casse la string → exécution au clic. Corrigé : conversion vers
  le pattern **déjà utilisé dans le même fichier** (AUDIT 2026-05-10 §15) —
  attributs `data-*` (contexte attribut, `escapeHtml`-safe) + listeners délégués
  (`edit/complete/test/delete-instrument`). Comportement préservé à l'identique
  (`stopPropagation` conservé sur les boutons).
- **C3-C1 (CRITIQUE) — XSS stocké/partagé via nom de fichier MIDI**
  `createFileElement` (`index.html`). `file.filename` (uploadé/renommé, non
  sanitisé — `validateFilename` autorise `< > " '`, upload `apiRoutes` ne strippe
  rien) entrait brut dans `innerHTML`, persistait, et était **diffusé à tous les
  clients** (re-render sur `file_list_updated`). Un pair LAN (auth HTTP bypassée
  RFC1918) upload `<img src=x onerror=…>.mid` → exécution dans la session
  authentifiée de chaque opérateur. Corrigé : `escapeHtml(displayName)`.
- **C3-M1 (MAJEUR) — XSS via `custom_name` / `device.name` / `type` / `id` /
  `usbSerialNumber` / `mac_address`.** `custom_name` n'est validé serveur que sur
  la longueur ; les noms/SN viennent des descripteurs matériels. 6 sinks (liste
  d'appareils, appareil virtuel, formulaire de réglages) — tous escapés
  (attributs inclus).
- **C3-M2 (MAJEUR) — XSS via nom de dossier** (état synchronisé serveur, non
  sanitisé). En-tête dossier ouvert → `textContent` (miroir de la carte fermée) ;
  modal de renommage → `escapeHtml`.
- **C3-M3 (MAJEUR) — XSS via identité SysEx** `renderIdentityInfo`. Les champs
  `sysex_*` (fabricant/famille/modèle/version/raw) viennent d'un appareil MIDI
  (contrôlable par un instrument DIY malveillant) et sont persistés. Tous escapés.
- **C3-M5 (MAJEUR) — XSS via `showAlert`/`showConfirm`** (`message.replace(/\n/,'<br>')`
  → `innerHTML`). Des appelants interpolent noms de fichiers/dossiers/`error.message`.
  Aucun appelant ne passe de HTML intentionnel (contrat texte + `\n`). Corrigé :
  `escapeHtml(message).replace(/\n/g,'<br>')` aux deux sinks.
- **C3-D2 / C3-D3 (MOYEN) — `error.message` dans la liste de fichiers ; nom de
  fichier local à l'upload** → `escapeHtml`.
- **C1 (MEDIUM) — défaut d'échappement identité** `RoutingSummaryRenderers`
  (`opts.escape || ((s)=>s)`) : le défaut devient `window.escapeHtml` (un appelant
  oublieux n'obtient plus d'injection brute).
- **C1 (LOW) — `esc()` local sans apostrophe** `MidiEditorInfoModalRender` : ajout
  de `'`→`&#39;` (aligné sur `window.escapeHtml`), supprime un foot-gun futur en
  contexte attribut mono-quote. Plus **minor** : badge de filtre (`filter.label`).

### Robustesse cœur / cycle de vie

- **C3-M4 (MAJEUR) — accumulation de listeners à chaque reconnexion WS.** Le
  handler `connected` (`index.html`) rappelait `initKeyboardShortcuts()` &co (qui
  attachent des listeners `document` sans garde d'idempotence) à **chaque**
  (re)connexion → Ctrl+A / Échap dupliqués N fois sur un Pi offline-first qui
  reconnecte souvent. Corrigé : init one-time gardés par `if (connectedCount === 1)` ;
  les données (fichiers/appareils) rafraîchissent toujours à chaque reconnexion.
- **C2-M1 — événement `connected` émis en double par connexion.**
  `BackendAPIClient` l'émettait dans `onopen` **et** via le frame welcome serveur
  (`{event:'connected'}`) re-émis par `handleMessage` → tout consommateur tournait
  2×. Corrigé : le frame welcome est la source unique (porte la version) ; la
  promesse `connect()` résout toujours dans `onopen` (pas de course : tous les
  consommateurs s'abonnent avant `connect()`).
- **C2-M7 — handshake WS bloqué ne réglait jamais la promesse** (TCP up, upgrade
  jamais complété) → la chaîne de reconnexion (qui dépend de `onclose`) mourait en
  silence. Corrigé : `CONNECT_TIMEOUT_MS=15s` force la fermeture d'un socket encore
  CONNECTING (déclenche `onerror`→`onclose` : reject initial / reschedule reconnect) ;
  timer nettoyé dans `onopen`/`onclose`/`close()` et au remplacement du socket.
- **C2-N1 — fuite du token dans le log d'erreur WS.** `console.error('…', error)`
  loggait l'objet Event dont `.target.url` porte le `?token=` ; idem propagé aux
  consommateurs `'error'`. Corrigé : log/propagation d'une **string** sanitisée
  uniquement.
- **C2-N2 — frame d'erreur non corrélé avalé en silence.** `{type:'error',error}`
  sans `id` ni `event` (ex. « Rate limit exceeded ») était droppé. Corrigé : émis
  comme `'error'` (garde `id == null` pour ne pas re-signaler une commande déjà
  expirée).
- **C2-M3 — `EventBus.off(event)` (sans callback) ne purgeait pas les timers
  debounce** → un callback debouncé tirait après le teardown (vue détachée dans la
  fenêtre de debounce). Corrigé : annulation des timers des listeners retirés.
- **C2-M2 — `EventBus.processEvent` itérait le tableau vivant** et retirait les
  `once` par index post-hoc → listeners sautés / mauvais splice sous mutation
  ré-entrante. Corrigé : itération sur un **snapshot** + retrait des `once` par
  identité (`indexOf`).
- **C3-D1 — `JSON.parse` top-level non gardé** (`midi_folders`). Le `|| '{}'` ne
  couvre qu'une clé absente, pas une valeur corrompue → un throw à cette
  instruction top-level **abortait tout le script inline** (SPA morte au chargement).
  Corrigé : `try/catch` → arbre vide.

Tests : `tests/frontend/event-bus.test.js` (M2 snapshot/ré-entrance, M3 debounce),
`tests/frontend/backend-api-client-events.test.js` (M1 dedup, N2 corrélation).

---

## 🟠 Ouverts — documentés (posture LAN de confiance / non exploitable / architectural)

- **C1 (MEDIUM) — `i18n.t(key,{param})` n'échappe pas les params** (`I18n.js`,
  `replace(/\{(\w+)\}/, …)`). Sûr aujourd'hui **par convention** : `MidiEditorChannelPanel`
  pré-échappe ; `MidiEditorRenderer` (title `ch.instrument`/`preset.name`) est sûr
  car ces noms viennent de la table GM (statique), pas de méta free-form. → À
  terme : `t()` échappant par défaut (ou split `tHtml`/`tText`) plutôt que de
  dépendre de chaque appelant.
- **C1 (MEDIUM) — `LightingDeviceUI` onclick JS-string** (`_stopLiveEffect('${esc(e.key)}')`) :
  même anti-pattern que C1-HIGH mais **non exploitable** (`e.key` = `deviceId:effectType`,
  id numérique + enum serveur, pas d'apostrophe attaquant). → À convertir en
  listener délégué pour cohérence.
- **C1 (LOW) — `SettingsTemplates` `bank.label`/`bank.id` bruts** : non exploitable
  (`id` numérique, label **doublement sanitisé serveur** — `storeUpload` + `sanitizeLabel`
  strippent `[<>"'&]`). Recommandé : échapper pour cohérence défensive.
- **C1 (LOW) — `BluetoothScanModal` `address`/`id` non échappés** : MAC fournies
  par BlueZ (pas de string arbitraire). Faible risque ; échapper par principe.
- **C2 (minor) — `BaseView.off()` ne purge pas `eventSubscriptions`** → ✅ **Corrigé**
  (suivi 2026-08-08) : `on()` tague la closure unsub (`_gmEvent`/`_gmHandler`) et
  `off()` retire l'abonnement suivi correspondant, donc les cycles on()/off() ne
  laissent plus de closures mortes. Tests : `tests/frontend/base-view-off-leak.test.js`.
- **C3 (minor)** — handlers playback (`getElementById(...).style` sans garde ;
  éléments statiques aujourd'hui) → durcir en `?.` ; champs metadata numériques
  (`durationFormatted`/`tempo`/`channelCount`, serveur-calculés) → échapper en
  défense-en-profondeur.

---

## Vérifié CORRECT (pour éviter la re-revue)

- **`escapeHtml`** couvre l'ensemble OWASP (`& < > " '`, `&` en premier) — sûr en
  contexte texte ET attribut.
- **Console de debug non vecteur XSS** : `log()`/`logMidi()` rendent via
  `textContent` (messages MIDI, noms d'appareils, `instrumentName`).
- **Sinks de noms déjà escapés** : playlists, loops, lighting (device/rule/group/preset),
  onglets/`<h2>` d'instrument, dropdown playable-instruments (`textContent`).
  `device.type` lighting contraint à un enum serveur.
- **Gestion d'erreurs commandes solide** : boucle d'upload + handlers BLE/réseau
  wrappés en try/catch, `response.success` vérifié (pas de faux succès / rejection
  non gérée).
- **`BackendAPIClient`** : rejet des requêtes en attente à la fermeture ; garde
  anti-connexions parallèles ; résolution par **présence** de `data` (pas
  truthiness) ; reconnexion indéfinie (backoff plafonné) pilotée par `onclose`.
- **localStorage** : toutes les autres lectures `JSON.parse` sont gardées
  (seule D1 ne l'était pas) ; `EventBus` isolation par listener (try/catch),
  `once()` détaché en `finally`.
