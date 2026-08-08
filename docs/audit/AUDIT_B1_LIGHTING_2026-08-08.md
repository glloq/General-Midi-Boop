# Audit B1 — Sous-système Lighting (2026-08-08)

Audit adversarial (4 relecteurs parallèles) du sous-système lighting : cœur
(`LightingManager`, `LightingEffectsEngine`, `BaseLightingDriver`, `ColorUtils`),
drivers réseau (Art-Net/sACN/MQTT/OSC/HTTP + profils DMX), drivers GPIO/série +
lighting instrument (LED via MIDI CC), et les commandes WS. Chaque finding a été
**revérifié contre le code réel** avant correctif.

**Contexte :** le lighting est **optionnel** (chargé en try/catch, absent sans
deps natives). La règle de sévérité : un défaut lighting ne doit **jamais**
crasher tout le process MIDI. Fait clé vérifié — le chemin par message est isolé
(`EventBus.emit` enveloppe chaque listener en try/catch), mais les **callbacks de
timer/microtask** (effets, fades, render) ne le sont pas → un throw y devient un
`uncaughtException` que `Application` route vers `process.exit`. Autre fait : la
surface de commandes n'avait **aucun schéma** → entrées numériques/tableaux non
validées.

**Statut :** 8 items corrigés (3 avec tests locaux), tous les vecteurs
crash-tout-le-process / DoS / SSRF. Le reste (matériel GPIO, misbehavior
lighting-only, minors) est documenté ci-dessous. Suite : **130 suites / 1459 tests** vertes.

---

## ✅ Corrigés

- **Isolation crash — render microtask** `BaseLightingDriver._scheduleRender`.
  Un throw synchrone dans `_doRender` (ex. `dgram.send` sur un port hors borne)
  s'échappait de la microtask → `uncaughtException` → arrêt du process. Corrigé :
  try/catch autour de `_doRender`.
- **Isolation crash + timer fou — effets** `LightingEffectsEngine.startEffect`.
  (a) Le callback `setInterval` appelait les drivers sans try/catch → crash
  process ; corrigé par un `safeTick` qui stoppe l'effet sur throw. (b) Une plage
  LED inversée/garbage rendait `speed/ledCount` non-fini → intervalle `chase`
  ramené à 1 ms (timer fou) ; corrigé par une garde `ledCount < 1`. Tests :
  `tests/lighting-effects-guard.test.js`.
- **Isolation crash — série** `SerialLedDriver`. Aucun listener `'error'` +
  `port.write` non gardé → un débranchement USB émettait `'error'` sans listener
  → `uncaughtException` → arrêt du process. Corrigé : listeners `'error'`/`'close'`
  + écritures via `_write` gardé.
- **Fuite client MQTT** `MqttLightDriver.connect`. Un connect échoué (broker
  absent — condition normale) laissait un client `mqtt` avec `reconnectPeriod`
  actif à vie (le driver non enregistré n'est jamais `disconnect()`é) → clients
  zombies accumulés à chaque édition de config. Corrigé : `client.end(true)` dans
  le catch avant rethrow.
- **`clamp` NaN-safe** `MathUtils.clamp`. Une valeur non-finie passait les deux
  comparaisons et était renvoyée telle quelle → tout le calcul de luminosité
  empoisonné (un master-dimmer `{}`/`NaN` mettait toutes les LED à NaN). Corrigé :
  `if (!Number.isFinite(value)) return min`. Tests : `tests/mathutils-clamp.test.js`.
- **SSRF / scan interne — `lighting_device_scan`** `LightingCommands`. `subnet`
  était interpolé dans `fetch(http://${subnet}.${i}/...)` sans validation → un
  `subnet` forgé (`127.0.0`, `10.0.0.1:8080/x?#`) sondait localhost / hôtes
  arbitraires. Corrigé : validation stricte préfixe IPv4 /24 (octets 0-255).
  *(Aucune casse pour l'usage légitime — un vrai sous-réseau passe toujours.)*
- **DoS import — `lighting_rules_import`** `LightingCommands`. `JSON.parse` non
  gardé (SyntaxError masquée en 500) + aucune borne sur le tableau → inserts
  synchrones illimités. Corrigé : parse en try/catch → `ValidationError`, cap
  `MAX_IMPORT_RULES=1000`, garde `importData` objet.
- **Schéma lighting** (nouveau `schemas/lighting.schemas.js` + câblé dans
  `JsonValidator`). La surface schemaless validait désormais : `type` (enum des 8
  drivers), `led_count` + `strips[].led_count` (cap 4096 → garde l'alloc buffer
  GPIO), `connection_config.port` (1-65535), `master_dimmer.value` (0-255),
  `effect_start` plage LED entière, `group_create.device_ids` (cap 256),
  `group_color` r/g/b/brightness (0-255), `bpm`. Tests : `tests/schema-lighting.test.js`.

---

## 🟠 Ouverts — matériel / misbehavior lighting-only / documentés

### Matériel GPIO (QA sur Pi requise — correctifs spécifiés, non vérifiables ici)
- **GpioStripDriver sortie morte** : écrit dans des buffers privés que
  `rpi-ws281x-native` ne rend jamais (le retour de `init()` = les canaux est
  ignoré). Toute la sortie `gpio_strip` est noire. → capturer les canaux de
  `init()` et écrire dans `channel.array`.
- **strip_type** : clé `strip_type` (snake) vs `stripType` (camel) attendue par
  la lib + `WS2812_STRIP` inexistant → type de strip ignoré (mauvaises couleurs
  RGBW/WS2811). **3 strips/canal 2** annoncés alors que la lib est
  `MAX_CHANNELS=2` (SPI absent). **Singleton** natif partagé : deux devices strip
  se clobberent.

### Misbehavior lighting-only (non-crash) — à planifier
- **noteon-stuck** : une règle `trigger:'noteon'` ne matche jamais le `noteoff`
  correspondant → LED jamais éteinte + compteur de notes qui fuit. → suivre l'état
  allumé indépendamment du trigger.
- **Fades non nettoyés** : `disconnectDevice`/handler `'disconnected'` runtime ne
  stoppent pas les `activeFades` du driver (ni ne le retirent de `this.drivers`).
- **`connect()` échoué** ne nettoie pas un driver partiellement construit
  (sockets UDP non fermés sur échec de bind — N1) ; **`validate()`** ne détecte
  pas un override manquant (compare `typeof`, pas le prototype) ; **VU meter**
  re-parse le hex par LED sur le chemin MIDI (hoister `hexToRgb`).
- **Drivers réseau** : MQTT sans coalescing (1 publish/LED) ; Hue N fetches
  concurrents ; Art-Net broadcast sous-réseau non activé ; longueur DMX impaire ;
  profil `wash_rgbw_6ch` sans canal `w` ; listeners UDP `'error'` présents mais
  silencieux après connect.
- **Cœur** : `unref()` manquant sur les intervals ; `_broadcastLedState` code
  mort ; `reloadDevices` ne await pas les connects (course sur `_reloading`).
- **`connection_config.host`/`broker_url`/`base_url`** restent des cibles
  sortantes non validées (SSRF-over-UDP/HTTP) — **acceptable sous « LAN de
  confiance »** ; le schéma valide le port et les tailles, pas le format d'hôte.

---

## Vérifié CORRECT (pour éviter la re-revue)
- **Chemin par message isolé** : `EventBus.emit` try/catch chaque listener → un
  throw driver sur `midi_message`/`midi_routed` est loggé, pas propagé. (Le trou
  était les timers, corrigé ci-dessus.)
- **Lighting instrument (`instrument/`) solide** : `clamp7`/`clampInt` coercent
  NaN/strings, canal masqué `& 0x0f`, CC re-clampés dans `DeviceManager`, envoi en
  try/catch — rien ne touche le hot path router/player. Bien testé.
- **Maths couleur** : `hexToRgb`/`hsvToRgb`/`_kelvinToRgb` corrects (clamp,
  normalisation de teinte, domaines log/pow valides) ; `_applyBrightness` clampe
  (sauf NaN, corrigé via `clamp`).
- **Framing réseau** : sACN E1.31 (overhead 125, flags/longueurs, multicast
  239.255.x.x) et Art-Net (opcode LE, SubUni, séquence 1-255) vérifiés corrects.
  `HttpLightDriver` = driver modèle (timeouts, try/catch, batch 16 ms).
- **Pas d'injection SQL / mass-assignment / pollution proto** : `buildDynamicUpdate`
  itère une allow-list codée en dur ; aucun `Object.assign` de `data` brut.
- **Dégradation deps natives** : `pigpio`/`rpi-ws281x-native`/`serialport` en
  `await import()` dans le try/catch de `connect()` → un hôte sans la dep perd
  seulement ce driver.
- **Intervalle d'effet planché à 16 ms** → pas de timer fou via `speed` (le
  vecteur réel était la plage LED, corrigé).
