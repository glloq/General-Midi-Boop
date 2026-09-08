# Vague 1 — R1 et R3 : compte rendu

**Base :** audit du 2026-09-07 · **Périmètre traité :** `src/api/**`,
`src/utils/JsonValidator.js`, `scripts/audit/command-inventory.mjs`,
`.github/workflows/ci.yml`.

---

## R1 — Le mode sécurisé couvre enfin le WebSocket (F-108, P1)

### Ce qui était faux

`securityMode` n'était lu que dans `HttpServer.js`. Le WebSocket — **270
commandes, dont `system_update`, `system_shutdown`, `hotspot_enable`,
`file_delete`** — l'ignorait complètement. Un opérateur qui activait
`GMBOOP_SECURITY_MODE=secure` voyait HTTP répondre 401 et croyait la boîte
fermée ; la socket qui porte toute la surface de commande restait ouverte à un
client sans token qui forgeait deux en-têtes. **Une parade documentée mais
fausse est pire qu'une absence de parade.**

### Ce qui est corrigé

| Fichier                                 | Changement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/api/securityPolicy.js` _(nouveau)_ | Résolution **unique** du mode (`GMBOOP_SECURITY_MODE` → `config.security.mode` → `trusted-lan`) et des prédicats d'adresse (`isLoopbackAddress`, `isPrivateAddress`). HTTP et WS lisent la même source : la dérive qui a créé F-108 ne peut plus se reproduire.                                                                                                                                                                                                                                                         |
| `src/api/WebSocketServer.js`            | En mode `secure`, **aucun contournement** : le token est exigé pour toute connexion, same-origin et loopback compris. Le mode est journalisé au démarrage (`WebSocket security mode: secure`) pour que l'opérateur puisse le vérifier. En `trusted-lan`, le raccourci loopback est désormais **ancré sur l'adresse source réelle** : `Origin` est forgeable par n'importe quel client non-navigateur, l'adresse d'une connexion TCP acceptée ne l'est pas. La vérification du token est extraite dans `_verifyToken()`. |
| `src/api/HttpServer.js`                 | F-114 : les deux portes forgeables (`Sec-Fetch-Site: same-origin` et `Origin ∈ {localhost, 127.0.0.1, req.hostname}`) sont **supprimées**. Elles étaient évaluées _avant_ `_checkBearer`, donc un **mauvais** token passait aussi. Reste la seule porte qu'un client ne peut pas fabriquer : `isPrivateClient(req)`.                                                                                                                                                                                                    |

### Ce que ça change pour l'utilisateur

- `trusted-lan` (défaut) : **rien ne change pour un client du LAN.** Il signifie,
  littéralement et désormais explicitement dans le code : _tout client dont
  l'adresse source est privée a tous les droits, token ou pas_.
- Deux conséquences à connaître avant de déployer, documentées dans le code :
  1. un client qui atteint la boîte sur une adresse **publique** (IPv6 GUA
     routée, port-forward) doit maintenant présenter le token, **même depuis un
     navigateur** ;
  2. tout reverse-proxy ou tunnel local (`cloudflared`, `ngrok`, nginx) fait
     arriver **toutes** les requêtes en 127.0.0.1 — `trust proxy` n'est
     volontairement pas configuré. Derrière l'un d'eux, `isPrivateClient` ne
     vaut rien et `security.mode=secure` est **obligatoire**.
- `secure` : le token est exigé partout. **La SPA ne sait pas envoyer de token**
  (`BackendAPIClient` construit son URL WS sans paramètre `token`, et les appels
  `/api/*` n'ajoutent pas d'en-tête `Authorization`). En mode `secure`
  l'interface web n'est donc pas utilisable telle quelle — c'était déjà vrai
  pour HTTP avant ce correctif, ça l'est maintenant aussi pour le WebSocket.
  **Reste ouvert** (hors périmètre : `public/**`) : donner à la SPA un moyen de
  présenter le token.

### Comment c'est prouvé

`tests/audit/r1-ws-security-mode.test.js` (14 tests) monte un **vrai**
`HttpServer` + `WebSocketServer` sur le port 8201 et s'y connecte avec un vrai
client `ws`, exactement comme la démonstration de l'audit :

```js
new WebSocket('ws://127.0.0.1:8201/', {
  headers: { Origin: 'http://127.0.0.1:8201', Host: '127.0.0.1:8201' }
});
```

- `trusted-lan` → **accepté** (personne n'est cassé) ;
- `secure` → **refusé, 401** ; token correct → accepté ; **mauvais** token →
  refusé ;
- HTTP et WS répondent désormais **la même chose** en mode `secure` (le test qui
  aurait échoué avant : HTTP 401, WS OPEN) ;
- le raccourci loopback est éprouvé via `verifyClient` avec une adresse source
  synthétique : un client LAN qui prétend `Origin: http://127.0.0.1` est refusé,
  un vrai client loopback (IPv4 et IPv6) passe.

`tests/audit/r1-http-auth-bypass.test.js` (8 tests) monte l'application Express
derrière un serveur HTTP qui **réécrit l'adresse du pair** — le seul moyen, en
tournant sur loopback, de présenter une adresse publique. Un client en
203.0.113.7 est refusé malgré `Sec-Fetch-Site: same-origin`, malgré un `Origin`
loopback forgé, et avec un mauvais token ; il est accepté avec le bon. Un client
LAN et un client loopback restent acceptés sans token en `trusted-lan`.

---

## R3 — La validation est _fail-closed_ (F-19 / F-03, P1)

### Le point de départ

184 commandes sur 270 sans schéma, et `validateByCommand` renvoyait
`{valid:true, errors:[]}` pour chacune. Mesuré sur 1 169 trames hostiles :
**49,5 % acceptées**, **11,8 % en erreur interne masquée** — ces dernières
levées par le **pilote SQLite**, c'est-à-dire après avoir traversé la couche API
et la couche repository.

### L'ordre imposé a été respecté

**1. Les schémas d'abord.** 112 commandes qui lisent réellement leur payload ont
reçu un schéma, par ordre de danger mesuré :

| Fichier                                            | Commandes ajoutées                                                               |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| `schemas/lighting.schemas.js`                      | 21 (+ `lighting_midi_learn`) — 122 acceptations hostiles, la plus grosse surface |
| `schemas/instrument.schemas.js` _(nouveau)_        | 21 (settings, capacités, voix, éclairage CC, instruments virtuels)               |
| `schemas/file.schemas.js`                          | 11 (lectures par id, `file_list`, `file_search`, `file_filter`)                  |
| `schemas/string_instrument.schemas.js` _(nouveau)_ | 13 (bornes alignées sur les `CHECK` de `001_baseline.sql` et `007`)              |
| `schemas/playlist.schemas.js` _(nouveau)_          | 10 (dont le nom de 200 000 caractères)                                           |
| `schemas/routing.schemas.js`                       | 9                                                                                |
| `schemas/playback.schemas.js`                      | 9 (dont F-20 : `set_tempo` / `set_volume`)                                       |
| `schemas/device.schemas.js`                        | 7                                                                                |
| `schemas/latency.schemas.js`                       | 5                                                                                |
| `schemas/system.schemas.js`                        | 3 (`system_update`, `system_restore`, `system_logs`)                             |
| `schemas/serial.schemas.js` _(nouveau)_            | 3                                                                                |

Règle de rédaction, dans `schemas/helpers.js` : **tolérant sur la
représentation, strict sur la forme et les bornes.** Le SPA envoie un canal en
`3` ou `"3"`, un booléen en `true`, `1` ou `"1"`, et les handlers normalisent
déjà au `parseInt`. Un schéma exigeant du JSON canonique aurait refusé des
payloads qui marchent — précisément la régression à ne pas provoquer. Ce que les
prédicats arrêtent, c'est ce que le fuzzing a vu arriver jusqu'à SQLite : objets
et tableaux là où un scalaire est attendu, chaînes de 200 000 caractères,
`1e308`, imbrication à 600 niveaux.

Deuxième règle : **ne pas redire ce que le handler valide déjà bien.**
`_validateSettingsFields`, `validateVoicePayload`, `validateHandsConfigPayload`,
la garde SSRF de `lighting_device_scan`, le plafond de
`lighting_rules_import`… restent la source de vérité, avec leurs messages
d'erreur testés. Deux commandes conservent volontairement leur message
non préfixé parce que les fixtures de contrat l'épinglent
(`file_routing_sync`, `validate_routing_feasibility`), et
`file_routing_bulk_sync` conserve sa tolérance documentée au `routings`
non-objet.

**2. Puis l'inversion du défaut**, avec une liste d'exemption explicite :
`src/api/commands/schemas/validation-policy.js`.

```
PAYLOAD_BLIND_COMMANDS  : 72  — handlers enregistrés `() => fn(app)`
PENDING_SCHEMA_COMMANDS :  0  — la dette
```

Les 72 exemptions ne sont pas une promesse mais un **fait vérifié** : leur
handler a une arité de 0, il ne lie jamais le paramètre `data`, donc aucun
payload ne peut atteindre quoi que ce soit. `tests/audit/r3-fail-closed.test.js`
charge le vrai registre et échoue si l'une d'elles prend un argument.

`CommandRegistry.handle` cherche désormais le handler **avant** de valider, pour
qu'une commande inconnue reste un `ERR_NOT_FOUND` et non une erreur de
validation, et transmet `payloadBlind: handler.length === 0`. Effet de bord
utile : une commande enregistrée à l'exécution (tests, futur plugin) continue de
fonctionner **si elle ignore son payload**, et est refusée si elle le lit.

**3. Le cliquet CI.** `node scripts/audit/command-inventory.mjs --check`
compare l'état réel à `scripts/audit/schema-coverage.baseline.json` et échoue :

- si la couverture **câblée** baisse (c'est `withWiredSchema` qui est vérifié :
  un fichier de schémas que `JsonValidator` n'importe pas ne valide rien) ;
- si `PENDING_SCHEMA_COMMANDS` ou `PAYLOAD_BLIND_COMMANDS` grandit ;
- si une commande enregistrée n'a **ni schéma ni exemption** (elle serait
  refusée à l'exécution) ;
- si une commande listée comme _payload-blind_ a en réalité un handler qui lit
  son payload ;
- si une exemption désigne une commande qui n'existe plus.

Nouveau job `schema-coverage` dans `.github/workflows/ci.yml` (aucune dépendance
native requise). Vérifié rouge en retirant un import de `JsonValidator` :

```
Schema coverage : 195/270 (baseline 198) · payload-blind 72/72 · pending schema 0/0
Schema coverage ratchet FAILED:
  - schema coverage dropped: 195 < 198 (baseline).
  - these schema files are not imported by src/utils/JsonValidator.js, so they
    validate nothing at runtime: serial.schemas.js.
```

### Couverture atteinte — chiffres honnêtes

```
$ node scripts/audit/command-inventory.mjs
Registered commands       : 270
  with payload schema     : 198 (73.3%)     (avant : 86 / 31,9 %)
  schema wired to validator: 198 (73.3%)
```

**198 / 270 avec schéma, 72 / 270 exemptées, 0 en dette.** Les 72 exemptées sont
exactement les commandes sans paramètre, listées nommément et par module dans
`validation-policy.js` : `system_status`, `system_info`, `system_reboot`,
`system_shutdown`, `device_list`, `hotspot_status`, `playback_stop`,
`playlist_next`, `route_list`, `serial_scan`, `wifi_scan`, `lighting_all_off`…
Aucune ne lit son payload — c'est testé, pas affirmé.

### Comment c'est prouvé

`tests/audit/r3-fail-closed.test.js` — 88 tests :

- le défaut est le refus, et **aucune** des 270 commandes n'échappe à la
  couverture (schéma ou exemption nommée) ;
- les exemptions sont vérifiées (arité 0), sans fantômes, dette vide ;
- **26 trames hostiles** reprises de la campagne de fuzzing sont refusées : nom
  de playlist de 200 000 caractères, `{name:{}}`, `{fileId:{}}`, canal 99,
  `bpm: 1e308`, `condition_config` non-objet, scène à 50 000 effets,
  `lighting_led_broadcast {enabled:'yes'}`, `serial_close` avec un chemin de
  traversée, `measurements: 1e9`, `system_update {type:'../../evil'}`… ;
- **49 payloads légitimes** relevés dans les vrais appelants
  (`public/js/**`, `public/index.html`) sont toujours acceptés, plus les
  représentations que le SPA envoie réellement (`'9'` pour un canal, `1` pour un
  booléen) ;
- l'ordre du dispatch : commande inconnue → `ERR_NOT_FOUND`, payload invalide →
  `ERR_VALIDATION`.

Deux tests d'audit existants ont été **inversés** au lieu d'être supprimés,
parce qu'ils étaient les témoins du défaut :
`tests/audit/l01-ws-contract.test.js` (« validateByCommand fails open ») et
`tests/lighting/commands.test.js` (« only 7 of the 38 have a payload schema »).

### Trouvé au passage : `ble_disconnect` était mort

`device.schemas.js` exigeait `deviceId` alors que le handler lit `address` et
que la SPA envoie `{address}` : **toute déconnexion BLE répondait « Invalid
ble_disconnect data: deviceId is required »**. Schéma aligné sur `ble_connect`.

---

## Ce qui reste ouvert

1. **La SPA ne sait pas présenter de token** — donc `secure`, désormais
   réellement appliqué de bout en bout, rend l'interface inutilisable. Le
   correctif est dans `public/js/api/BackendAPIClient.js` et
   `public/index.html` (hors périmètre de ce lot).
2. **`CLAUDE.md` doit être mis à jour** (fichier partagé, non touché ici) :
   décrire `trusted-lan` comme « tout client joignable depuis une adresse privée
   a tous les droits », et élargir l'avertissement sur les tunnels — il ne
   s'agit pas seulement de ceux qui réécrivent en plage privée, mais de **tout**
   reverse-proxy local.
3. **F-116** (sudoers NOPASSWD sur un script inscriptible) n'est pas traité :
   `scripts/Install.sh` et `HotspotManager.js` sont hors périmètre. R1 en était
   le préalable ; il est levé.
4. **Le contrôle de forme s'arrête au premier niveau** pour les blobs déjà
   validés par les handlers (`hands_config`, `bagpipe_config`,
   `accordion_config`, `harmonica_config`, `connection_config`). Les redécrire
   dans les schémas dupliquerait des messages d'erreur testés ; c'est un choix,
   pas un oubli.
5. **Aucun mode strict** (rejet des propriétés inconnues). Le SPA envoie
   régulièrement des champs supplémentaires (`get_instrument_defaults` envoie
   `type`, que le handler ignore) ; l'activer aurait cassé des flux qui
   marchent. C'est la prochaine marche du cliquet, quand la surface sera stable.
